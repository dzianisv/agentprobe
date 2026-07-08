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
    if (attempt < attempts) await Bun.sleep(retryDelayMs);
  }
  throw new Error(
    `captureUntilPainted${prefix}: screen content region still ${(whiteFraction * 100).toFixed(2)}% near-white (blank/unpainted) after ${attempts} capture attempts`
  );
}
