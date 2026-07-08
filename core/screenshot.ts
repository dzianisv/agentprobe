// Screen capture via `scrot` (X11 framebuffer), never CDP
// `Page.captureScreenshot`.
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts and
// tests/cua/runner.ts. Two reasons scrot is used instead of CDP:
//   1. Native browser-chrome UI (e.g. the "Add extension?" confirmation
//      dialog) is invisible to CDP's Page domain — scrot is the only way to
//      see it at all.
//   2. CDP `Page.captureScreenshot` has to ask the renderer to composite a
//      frame; a JS-heavy page can keep the renderer busy past the call's own
//      timeout even though the page is visibly fine on screen (vibebrowser
//      CI run 28904690242). `scrot` reads the X11 framebuffer directly and
//      cannot block on page JS/renderer responsiveness.

import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { runCommand } from "./xdotool";

/** Full-screen (X11 root window) capture. Best-effort — does not throw on scrot failure. */
export async function saveFullScreenshot(targetFile: string): Promise<void> {
  runCommand("scrot", [targetFile], true);
}

/**
 * Same as `saveFullScreenshot`, but with `-p` so `scrot` composites the real
 * X11 pointer glyph into the capture. Useful as a directly-inspectable
 * ground-truth check of where a computed screen (x,y) actually landed.
 */
export async function saveCursorScreenshot(targetFile: string): Promise<void> {
  runCommand("scrot", ["-p", targetFile], true);
}

export type SaveOptimizedScreenshotOptions = {
  displayWidth?: number; // default 1920
  displayHeight?: number; // default 1080
};

/**
 * Capture via scrot, then downscale/recompress with sharp (kept within
 * `displayWidth`x`displayHeight`, never enlarged) — used for screenshots fed
 * to a vision/CUA model where raw scrot output would be unnecessarily large.
 * Returns the resulting file's base64 content.
 */
export async function saveOptimizedScreenshot(targetFile: string, opts: SaveOptimizedScreenshotOptions = {}): Promise<string> {
  const { displayWidth = 1920, displayHeight = 1080 } = opts;
  const rawFile = targetFile.replace(/\.png$/, "-raw.png");
  runCommand("scrot", [rawFile]);

  await sharp(rawFile)
    .resize(displayWidth, displayHeight, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(targetFile);

  const data = await readFile(targetFile);
  return data.toString("base64");
}
