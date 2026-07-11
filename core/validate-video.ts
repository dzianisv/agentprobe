// TypeScript port of ~/.agents/skills/publish-media-proof/scripts/validate-video.sh
// (agentprobe issue #6) — proves a video actually PLAYS before a task is called
// done, without shelling out to python/PIL: frame-blankness is checked via
// sharp, matching core/screenshot.ts's existing sharp usage in this repo.
//
// Works on a local file OR an https:// URL (downloads the served bytes first,
// so the URL path validates what a viewer actually receives, not just the
// local encode). Exits non-zero on any failure with a `FAIL: <reason>` line.
//
// Usage:
//   bun core/validate-video.ts <file-or-url> [min_seconds]
//   bun core/validate-video.ts https://github.com/user-attachments/assets/<uuid> 1
//
// Checks (all must pass):
//   1. duration >= min_seconds (default 1)     — catches the 0:00 / empty file
//   2. +faststart: moov atom BEFORE mdat        — else browsers/GitHub show 0:00
//   3. clean full decode (ffmpeg -f null)       — catches truncated/corrupt streams
//   4. >=2/3 sampled frames are non-blank        — catches all-black recordings
//
// Requires ffmpeg/ffprobe on PATH, and (optionally, for URLs) `gh` for an
// auth token — public assets don't need one, so a missing/unauthenticated
// `gh` is not fatal.

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

export type ValidateVideoResult =
  | { ok: true; durationSec: number }
  | { ok: false; reason: string; durationSec?: number };

/** Best-effort `gh auth token` — public assets don't need it, so any failure is swallowed. */
function ghAuthToken(): string | undefined {
  try {
    const proc = Bun.spawnSync(["gh", "auth", "token"]);
    if (proc.exitCode !== 0) return undefined;
    const token = new TextDecoder().decode(proc.stdout).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Download `url`'s served bytes to `destPath` — validates what a viewer actually receives, not just a local encode. */
async function downloadServedBytes(url: string, destPath: string): Promise<void> {
  const token = ghAuthToken();
  const headers: Record<string, string> = token ? { Authorization: `token ${token}` } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  await Bun.write(destPath, await res.arrayBuffer());
}

/** `ffprobe -show_entries format=duration` — 0 (which then fails the >= min check) if unparsable, mirroring the bash `|| echo 0` fallback. */
function readDurationSeconds(filePath: string): number {
  const proc = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath]);
  const dur = parseFloat(new TextDecoder().decode(proc.stdout).trim());
  return Number.isFinite(dur) ? dur : 0;
}

/** ffprobe container `format_name` (e.g. "mov,mp4,m4a,..." or "matroska,webm"), lowercased. */
function readFormatName(filePath: string): string {
  const proc = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", filePath]);
  // ffprobe CSV quotes values containing commas (e.g. `"matroska,webm"`) — strip the wrapping quotes.
  return new TextDecoder().decode(proc.stdout).trim().toLowerCase().replace(/^"|"$/g, "");
}

/** The `moov`-before-`mdat` (`+faststart`) check only makes sense for ISO-BMFF containers (mp4/mov). WebM/Matroska is a streaming container natively — there is no moov atom and no faststart concept, so the check is skipped for it. */
function needsFaststartCheck(filePath: string, formatName: string): boolean {
  if (/mp4|mov|m4a|3gp|3g2|mj2/.test(formatName)) return true;
  if (/matroska|webm/.test(formatName)) return false;
  // Fall back to the extension when ffprobe's format string is unhelpful.
  return /\.(mp4|mov|m4v)$/i.test(filePath);
}

/** `+faststart` check: the `moov` atom must appear before `mdat` in the first ~4MB — the #1 cause of "video shows 0:00" in browsers/GitHub (moov-after-mdat forces a full download before any metadata, incl. duration, is known). */
async function isFaststart(filePath: string): Promise<boolean> {
  const head = await Bun.file(filePath).slice(0, 4_000_000).bytes();
  const buf = Buffer.from(head);
  const moovIdx = buf.indexOf("moov");
  const mdatIdx = buf.indexOf("mdat");
  return moovIdx >= 0 && (mdatIdx === -1 || moovIdx < mdatIdx);
}

/** Clean full decode: `ffmpeg -v error -f null -` must exit 0 with empty stderr — anything on stderr at `-v error` is a real decode problem (truncated/corrupt stream). */
function decodeCleanly(filePath: string): { clean: boolean; stderr: string } {
  const proc = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", filePath, "-f", "null", "-"]);
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  return { clean: proc.exitCode === 0 && stderr.length === 0, stderr };
}

/** Extract the frame at second `t` and report whether it's non-blank: grayscale stdev > 3 (a flat/black frame has near-zero stdev). This replaces the bash script's python/PIL `ImageStat.stddev` check with sharp's `stats()`. */
async function isFrameNonBlank(filePath: string, t: number, framePath: string): Promise<boolean> {
  const proc = Bun.spawnSync(["ffmpeg", "-v", "error", "-ss", String(t), "-i", filePath, "-frames:v", "1", "-y", framePath]);
  if (proc.exitCode !== 0) return false;
  const stats = await sharp(framePath).grayscale().stats();
  const stdev = stats.channels[0]?.stdev ?? 0;
  return stdev > 3;
}

/**
 * Run all four playability checks against `src` (local path or `https://` URL),
 * printing `[validate] ...` progress lines mirroring the original bash script.
 * Returns a result rather than exiting — `main()` below is what turns this
 * into a process exit code for CLI use; callers that want to compose this
 * check into other TS code can import `validateVideo` directly.
 */
export async function validateVideo(src: string, minSeconds = 1): Promise<ValidateVideoResult> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), "validate-video-"));
  try {
    const filePath = path.join(tmpDir, "v.mp4");
    if (/^https?:\/\//.test(src)) {
      console.log(`[validate] downloading served bytes: ${src}`);
      try {
        await downloadServedBytes(src, filePath);
      } catch (error) {
        return { ok: false, reason: `could not download ${src}: ${(error as Error).message}` };
      }
    } else {
      await Bun.write(filePath, Bun.file(src));
    }

    const { size: bytes } = await stat(filePath);
    console.log(`[validate] file: ${filePath}  (${bytes} bytes)`);

    // 1. duration
    const dur = readDurationSeconds(filePath);
    if (!(dur >= minSeconds)) {
      return { ok: false, reason: `duration ${dur}s < ${minSeconds}s (0:00 / empty video)`, durationSec: dur };
    }
    console.log(`[validate] duration: ${dur}s (>= ${minSeconds}s) OK`);

    // 2. faststart (moov before mdat) — mp4/mov only; webm has no such concept
    const formatName = readFormatName(filePath);
    if (needsFaststartCheck(filePath, formatName)) {
      if (!(await isFaststart(filePath))) {
        return { ok: false, reason: "not +faststart (moov after mdat) — players show 0:00", durationSec: dur };
      }
      console.log("[validate] faststart (moov before mdat) OK");
    } else {
      console.log(`[validate] faststart check N/A for container "${formatName}" (webm/matroska streams natively) — skipped`);
    }

    // 3. clean full decode
    const decode = decodeCleanly(filePath);
    if (!decode.clean) {
      return { ok: false, reason: `decode errors:\n${decode.stderr}`, durationSec: dur };
    }
    console.log("[validate] full decode CLEAN");

    // 4. non-blank frames sampled across the timeline
    let nonBlank = 0;
    for (const frac of [0.15, 0.5, 0.85]) {
      const t = Math.round(dur * frac * 100) / 100;
      const framePath = path.join(tmpDir, `sample-${frac}.png`);
      if (await isFrameNonBlank(filePath, t, framePath)) nonBlank++;
    }
    if (nonBlank < 2) {
      return { ok: false, reason: `${nonBlank}/3 sampled frames non-blank (video looks blank/black)`, durationSec: dur };
    }
    console.log(`[validate] ${nonBlank}/3 sampled frames non-blank OK`);

    console.log(`[validate] PASS — ${dur}s, faststart, decodes clean, non-blank. Plays for real.`);
    return { ok: true, durationSec: dur };
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const src = process.argv[2];
  if (!src) {
    console.error("usage: bun core/validate-video.ts <file-or-url> [min_seconds]");
    process.exit(1);
  }
  const minSeconds = process.argv[3] ? parseFloat(process.argv[3]) : 1;
  const result = await validateVideo(src, minSeconds);
  if (!result.ok) {
    console.error(`FAIL: ${result.reason}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
