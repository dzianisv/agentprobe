// ffmpeg-based screen recording (X11 grab) and demo-GIF assembly from
// captured step/stage screenshots.
//
// Extracted from vibebrowser's tests/cua/runner.ts (`startRecording`,
// `assembleGif`).

import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
      path.join(outputDir, fileName)
    ],
    {
      stdout: "ignore",
      stderr: Bun.file(path.join(outputDir, "ffmpeg-recorder.log"))
    }
  );
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
