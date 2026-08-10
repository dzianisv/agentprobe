// ffmpeg-based screen recording (X11 grab) and demo-GIF assembly from
// captured step/stage screenshots.
//
// Extracted from vibebrowser's tests/cua/runner.ts (`startRecording`,
// `assembleGif`).

import { readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Structural (not import-time) dependency on Playwright's `Page.screenshot`
 * shape — deliberately not `import type { Page } from "playwright"` so this
 * package never needs `playwright` as a dependency. Any object with a
 * matching `screenshot()` method (a real Playwright `Page`, or a test
 * double) satisfies this.
 */
export type ScreenshotCapable = {
  screenshot(options?: { type?: "png" | "jpeg"; fullPage?: boolean }): Promise<Buffer | Uint8Array>;
};

export type StartRecordingOptions = {
  outputDir: string;
  displayWidth?: number; // default 1920
  displayHeight?: number; // default 1080
  display?: string; // default ":99"
  framerate?: number; // default 30
  fileName?: string; // default "recording.mp4"
};

/** Start an X11-grab ffmpeg recording; caller is responsible for killing the returned subprocess. */
export function startRecording(opts: StartRecordingOptions): Bun.Subprocess {
  const { outputDir, displayWidth = 1920, displayHeight = 1080, display = ":99", framerate = 30, fileName = "recording.mp4" } = opts;
  return Bun.spawn(
    [
      "ffmpeg", "-y",
      "-f", "x11grab",
      "-video_size", `${displayWidth}x${displayHeight}`,
      "-framerate", String(framerate),
      "-i", display,
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      // Put the `moov` atom in front so the file is playable as soon as it's
      // written. This is a *hint* ffmpeg applies as it finalizes the stream
      // normally (SIGTERM/`kill()` on the recorder) — it does not help if the
      // process is killed hard enough to skip finalization entirely, which is
      // why `finalizeRecording` below re-asserts it with a remux after the
      // fact (agentprobe issue #6: a CI recording.mp4 shipped moov-after-mdat
      // and showed 0:00 in the browser despite this flag already being a
      // reasonable expectation to have).
      "-movflags", "+faststart",
      path.join(outputDir, fileName)
    ],
    {
      stdout: "ignore",
      stderr: Bun.file(path.join(outputDir, "ffmpeg-recorder.log"))
    }
  );
}

export type FinalizeRecordingOptions = {
  outputDir: string;
  fileName?: string; // default "recording.mp4", must match startRecording's fileName
};

/**
 * Guarantee `+faststart` (moov before mdat) on a just-finished recording,
 * regardless of how cleanly `startRecording`'s ffmpeg process exited. Killing
 * the recorder (the normal shutdown path — see `startRecording`'s call sites)
 * can still leave `moov` after `mdat` in practice, and moov-after-mdat is the
 * #1 cause of a video showing 0:00 in a browser/GitHub player — see
 * `core/validate-video.ts`'s faststart check, which is what caught this on a
 * real CI artifact (agentprobe issue #6).
 *
 * Remuxes with `-c copy` (no re-encode: fast, lossless) into a temp file,
 * then swaps it in. No-op if the recording file doesn't exist (e.g. the
 * caller never actually got a frame written) rather than throwing, since
 * this always runs from a `finally` block alongside other best-effort
 * cleanup.
 */
export async function finalizeRecording(opts: FinalizeRecordingOptions): Promise<void> {
  const { outputDir, fileName = "recording.mp4" } = opts;
  const filePath = path.join(outputDir, fileName);
  if (!(await Bun.file(filePath).exists())) return;

  // Keep the original extension (`.mp4`) on the temp name — ffmpeg's output
  // muxer is selected from the destination filename's extension, so a
  // dotfile-style temp name like `.recording.mp4.faststart-tmp` (no
  // recognized extension) fails with "Unable to choose an output format".
  const ext = path.extname(fileName);
  const remuxedPath = path.join(outputDir, `${path.basename(fileName, ext)}.faststart-tmp${ext}`);
  const proc = Bun.spawn(
    ["ffmpeg", "-y", "-i", filePath, "-c", "copy", "-movflags", "+faststart", remuxedPath],
    { stdout: "ignore", stderr: Bun.file(path.join(outputDir, "ffmpeg-faststart-remux.log")) }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0 || !(await Bun.file(remuxedPath).exists())) return; // best-effort: leave original in place

  await rename(remuxedPath, filePath);
}

export type StartPageFrameCaptureOptions = {
  /** Any Playwright-`Page`-shaped object (see `ScreenshotCapable`) — no CDP/X11/xdotool involved. */
  page: ScreenshotCapable;
  outputDir: string;
  /** Background capture cadence. default 1000 */
  intervalMs?: number;
  /** Filename prefix — keep it one of `assembleGif`'s default `framePattern` alternatives ("stage" | "step") unless you also pass a custom `framePattern` to `assembleGif`. default "step" */
  framePrefix?: string;
  fullPage?: boolean; // default true
};

export type PageFrameCaptureHandle = {
  /** Stop the background interval loop and await its in-flight capture, if any. Idempotent. */
  stop(): Promise<void>;
  /**
   * Take one additional frame right now, outside the interval cadence —
   * for event-driven proof shots (e.g. immediately after a click, right
   * before an assertion) so a fast-moving step is never left to chance
   * between two interval ticks. `label` is slugified into the filename so
   * the frame is identifiable on disk without opening it.
   */
  captureNamed(label: string): Promise<string>;
  /** Total frames captured so far (interval + named). */
  frameCount(): number;
};

/**
 * Playwright-`Page`-screenshot-interval capture: the browser-visible-tab
 * counterpart to `startRecording`'s X11-grab video. Where `startRecording`
 * needs a real X server (Xvfb + `ffmpeg -f x11grab`) and is the right choice
 * for capturing native browser chrome / OS-level dialogs, this primitive
 * needs neither — it drives `page.screenshot()` directly, so it works
 * headless, inside a plain CI runner, with no display at all. Frames are
 * named to satisfy `assembleGif`'s default `framePattern`
 * (`/^(stage|step)-\d+.*\.png$/`), so the two primitives compose: capture
 * frames with this, then hand `outputDir` straight to `assembleGif`.
 *
 * Generalizes the interval-screenshot-loop capability that several
 * downstream projects were independently hand-rolling (e.g. OpenClawBot's
 * `tests/e2e/lib/gif-recorder.ts`) into one shared, tested primitive.
 */
export function startPageFrameCapture(opts: StartPageFrameCaptureOptions): PageFrameCaptureHandle {
  const { page, outputDir, intervalMs = 1000, framePrefix = "step", fullPage = true } = opts;
  let n = 0;
  let stopped = false;

  async function captureOne(label?: string): Promise<string> {
    n += 1;
    const index = String(n).padStart(3, "0");
    const slug = label ? `-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}` : "";
    const filePath = path.join(outputDir, `${framePrefix}-${index}${slug}.png`);
    const buf = await page.screenshot({ type: "png", fullPage });
    await writeFile(filePath, buf);
    return filePath;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await captureOne();
      } catch (error) {
        // Best-effort, matching startRecording's philosophy: one failed
        // interval capture (e.g. page mid-navigation) must not kill the
        // whole recording — the next tick tries again.
        console.warn(`[recording] startPageFrameCapture: interval capture failed: ${(error as Error).message}`);
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const loopPromise = loop();

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await loopPromise;
    },
    captureNamed: (label: string) => captureOne(label),
    frameCount: () => n
  };
}

export type AssembleGifOptions = {
  outputDir: string;
  /** Filename pattern for frames to include, tested with `RegExp.test`. Default matches `stage-NN-*.png` / `step-NN-*.png` (lexicographic order plays stage frames first). */
  framePattern?: RegExp;
  frameDurationSec?: number; // default 1.5
  scaleWidth?: number; // default 960
  fileName?: string; // default "demo.gif"
};

/**
 * Assemble a palette-optimized GIF from `outputDir`'s frame screenshots.
 * Frames are sorted lexicographically by filename, so a naming convention
 * with a sortable prefix (e.g. `stage-00-...`, `step-01-...`) controls
 * playback order. No-ops if no frames match.
 */
export async function assembleGif(opts: AssembleGifOptions): Promise<void> {
  const {
    outputDir,
    framePattern = /^(stage|step)-\d+.*\.png$/,
    frameDurationSec = 1.5,
    scaleWidth = 960,
    fileName = "demo.gif"
  } = opts;

  const files = await readdir(outputDir);
  const pngs = files
    .filter((f) => framePattern.test(f))
    .sort()
    .map((f) => path.join(outputDir, f));

  if (pngs.length === 0) return;

  // concat demuxer file: each frame shown for `frameDurationSec`; last file repeated without duration
  const lines: string[] = [];
  for (const p of pngs) {
    lines.push(`file '${p}'`);
    lines.push(`duration ${frameDurationSec}`);
  }
  lines.push(`file '${pngs[pngs.length - 1]}'`);
  const listPath = path.join(outputDir, "frames.txt");
  await writeFile(listPath, lines.join("\n"));

  const palettePath = path.join(outputDir, "palette.png");
  const gifPath = path.join(outputDir, fileName);

  // Pass 1: generate optimised palette
  const pass1 = Bun.spawn(
    [
      "ffmpeg", "-y", "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-vf", `scale=${scaleWidth}:-2:flags=lanczos,palettegen=max_colors=256:stats_mode=diff`,
      palettePath
    ],
    { stdout: "ignore", stderr: "ignore" }
  );
  await pass1.exited;

  // Pass 2: encode GIF with palette
  const pass2 = Bun.spawn(
    [
      "ffmpeg", "-y", "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-i", palettePath,
      "-lavfi", `scale=${scaleWidth}:-2:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer`,
      gifPath
    ],
    { stdout: "ignore", stderr: "ignore" }
  );
  await pass2.exited;
}

export type AssembleVideoOptions = {
  outputDir: string;
  /** Filename pattern for frames to include, tested with `RegExp.test`. Default matches `stage-NN-*.png` / `step-NN-*.png` (lexicographic order plays frames in order). */
  framePattern?: RegExp;
  frameDurationSec?: number; // default 1.5
  scaleWidth?: number; // default 1280 (must be even for yuv420p)
  fileName?: string; // default "video.mp4"
};

/**
 * Assemble an MP4 from `outputDir`'s frame screenshots — the video-file
 * counterpart to `assembleGif`. Same concat-demuxer input (each frame held
 * for `frameDurationSec`, frames sorted lexicographically so a naming
 * convention with a sortable prefix controls playback order), but encoded as
 * H.264 instead of a palette-quantized GIF: smaller output for long/high-fps
 * sequences, and playable in-place by GitHub / any `<video>` element.
 *
 * `+faststart` is applied at encode time (matching `startRecording`'s live
 * X11-grab path) so the moov atom lands before mdat and the file is
 * immediately seekable — see `validate-video.ts`'s faststart check, which
 * exists because that ordering is the #1 cause of a video showing 0:00 in a
 * browser/GitHub player.
 *
 * No-ops if no frames match `framePattern`, same as `assembleGif`.
 */
export async function assembleVideo(opts: AssembleVideoOptions): Promise<void> {
  const {
    outputDir,
    framePattern = /^(stage|step)-\d+.*\.png$/,
    frameDurationSec = 1.5,
    scaleWidth = 1280,
    fileName = "video.mp4"
  } = opts;

  const files = await readdir(outputDir);
  const pngs = files
    .filter((f) => framePattern.test(f))
    .sort()
    .map((f) => path.join(outputDir, f));

  if (pngs.length === 0) return;

  // Separate concat list from assembleGif's frames.txt so both can be run
  // against the same outputDir without clobbering each other.
  const lines: string[] = [];
  for (const p of pngs) {
    lines.push(`file '${p}'`);
    lines.push(`duration ${frameDurationSec}`);
  }
  lines.push(`file '${pngs[pngs.length - 1]}'`);
  const listPath = path.join(outputDir, "video-frames.txt");
  await writeFile(listPath, lines.join("\n"));

  const videoPath = path.join(outputDir, fileName);
  const proc = Bun.spawn(
    [
      "ffmpeg", "-y", "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-vf", `scale=${scaleWidth}:-2:flags=lanczos,format=yuv420p`,
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "20",
      "-movflags", "+faststart",
      videoPath
    ],
    { stdout: "ignore", stderr: Bun.file(path.join(outputDir, "ffmpeg-assemble-video.log")) }
  );
  await proc.exited;
}
