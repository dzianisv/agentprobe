// Blank/unpainted-capture guard: measure the near-white fraction of a
// screenshot's content region and retry the capture until it looks painted,
// or give up after a bounded number of attempts.
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts. Whole-image
// whiteness cannot separate a blank capture from a healthy one (measured on
// real CI artifacts: blank capture 93.7% near-white vs. a healthy
// mostly-empty capture at 92.4% — no separating threshold exists because
// browser chrome adds dark pixels to both). Restricting the measurement to
// the content region (below the tab/URL/flag-banner chrome, above the
// footer) separates cleanly: blank capture 0.9969 vs. worst healthy capture
// 0.9814/0.9229 in that same dataset — 0.995 sits between them. The
// `BLANK_CONTENT_*` constants that produced those numbers are now options;
// `BLANK_FRAME_DEFAULTS` carries the proven values forward as the default.

import sharp from "sharp";

// Node-safe sleep (no `Bun.sleep`): `captureUntilPainted` /
// `captureBufferUntilPainted` are reachable from `core/recording.ts`'s
// `startPageFrameCapture`, which is imported directly (in-process, not via a
// `bun <path>` CLI entrypoint) by plain-Node consumers such as AgentPod's
// vitest-driven `FrameRecorder` — `Bun.sleep` there throws
// `ReferenceError: Bun is not defined` and, worse, that throw is swallowed by
// the caller's try/catch, silently skipping the retry this file exists to
// provide (observed live: CI run 32493750173, blank stripe-checkout GIF
// shipped as "evidence" while `captureNamed` logged exactly this error).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type BlankFrameOptions = {
  contentTop: number;
  contentBottomMargin: number;
  whiteFraction: number;
  width: number;
  height: number;
  attempts?: number; // default 3
  retryDelayMs?: number; // default 1000
  label?: string;
};

/** Proven margins/threshold from vibebrowser's cws-visual-install.ts; spread with `{ width, height }` to build a full `BlankFrameOptions`. */
export const BLANK_FRAME_DEFAULTS: Omit<BlankFrameOptions, "width" | "height"> = {
  contentTop: 150,
  contentBottomMargin: 60,
  whiteFraction: 0.995
};

/** Fraction of near-white pixels in the capture's content region. */
export async function contentNearWhiteFraction(
  shotPath: string,
  opts: Pick<BlankFrameOptions, "contentTop" | "contentBottomMargin" | "width" | "height">
): Promise<number> {
  const { data } = await sharp(shotPath)
    .extract({
      left: 0,
      top: opts.contentTop,
      width: opts.width,
      height: opts.height - opts.contentTop - opts.contentBottomMargin
    })
    .resize(320, 145, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let white = 0;
  for (let i = 0; i < data.length; i++) if (data[i] >= 240) white++;
  return white / data.length;
}

/**
 * Call `screenshotFn` (expected to write a fresh screenshot and return its
 * path) up to `opts.attempts` times, accepting the first capture whose
 * content-region near-white fraction is below `opts.whiteFraction`. Throws
 * if every attempt is still blank.
 */
export async function captureUntilPainted(screenshotFn: () => Promise<string>, opts: BlankFrameOptions): Promise<string> {
  const attempts = opts.attempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const prefix = opts.label ? ` "${opts.label}":` : "";
  let lastPath = "";
  let whiteFraction = 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastPath = await screenshotFn();
    whiteFraction = await contentNearWhiteFraction(lastPath, opts);
    console.log(
      `[blank-frame]${prefix} capture attempt ${attempt}/${attempts} content-region near-white fraction=${whiteFraction.toFixed(4)} (blank threshold ${opts.whiteFraction})`
    );
    if (whiteFraction < opts.whiteFraction) return lastPath;
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  throw new Error(
    `captureUntilPainted${prefix}: screen content region still ${(whiteFraction * 100).toFixed(2)}% near-white (blank/unpainted) after ${attempts} capture attempts`
  );
}

export type BufferBlankFrameOptions = {
  /** default 0.995 — same proven threshold as BLANK_FRAME_DEFAULTS, but measured over the whole buffer (no window-chrome region to exclude on a Playwright viewport/element screenshot, unlike a full-desktop scrot). */
  whiteFraction?: number;
  attempts?: number; // default 3
  retryDelayMs?: number; // default 500
  label?: string;
};

/** Fraction of near-white pixels across an entire screenshot buffer (no content-region cropping — for callers with no browser chrome in frame, e.g. a Playwright `page.screenshot()`). */
export async function bufferNearWhiteFraction(buf: Buffer | Uint8Array): Promise<number> {
  const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  let white = 0;
  for (let i = 0; i < data.length; i++) if (data[i] >= 240) white++;
  return white / data.length;
}

/**
 * `captureUntilPainted`'s in-memory counterpart: call `captureFn` (expected
 * to return a fresh screenshot buffer, e.g. Playwright's
 * `page.screenshot()`) up to `opts.attempts` times, accepting the first
 * capture whose whole-buffer near-white fraction is below
 * `opts.whiteFraction`. Throws if every attempt is still blank. Used by
 * `core/recording.ts`'s `startPageFrameCapture` so a Playwright-`Page`
 * caller gets the same retry-until-not-blank guard as the CDP/scrot path
 * without needing a captured file on disk or known display dimensions.
 */
export async function captureBufferUntilPainted(
  captureFn: () => Promise<Buffer | Uint8Array>,
  opts: BufferBlankFrameOptions = {}
): Promise<{ buf: Buffer | Uint8Array; whiteFraction: number }> {
  const attempts = opts.attempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 500;
  const whiteFractionThreshold = opts.whiteFraction ?? BLANK_FRAME_DEFAULTS.whiteFraction;
  const prefix = opts.label ? ` "${opts.label}":` : "";
  let lastBuf: Buffer | Uint8Array | undefined;
  let whiteFraction = 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastBuf = await captureFn();
    whiteFraction = await bufferNearWhiteFraction(lastBuf);
    if (whiteFraction < whiteFractionThreshold) return { buf: lastBuf, whiteFraction };
    console.warn(
      `[blank-frame]${prefix} capture attempt ${attempt}/${attempts} near-white fraction=${whiteFraction.toFixed(4)} (blank threshold ${whiteFractionThreshold}) — retrying`
    );
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  throw new Error(
    `captureBufferUntilPainted${prefix}: capture still ${(whiteFraction * 100).toFixed(2)}% near-white (blank/unpainted) after ${attempts} attempts`
  );
}
