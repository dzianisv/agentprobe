// Real X11 input gestures via xdotool, and the shared subprocess runner used
// across core/surfaces (xdotool, scrot, ffmpeg all go through it).
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts and
// tests/cua/runner.ts. Chrome's own extension-install UI (and other
// gesture-gated surfaces like `chrome.sidePanel.open()`) actively resists
// synthetic input that doesn't look like a real user gesture — CDP
// `Input.dispatchMouseEvent` / a JS-synthesized `.click()` do not work for
// those surfaces. xdotool dispatches a real X11 event indistinguishable from
// a human's. Linux + X11 (Xvfb in CI) only.

/** Run a subprocess synchronously, returning trimmed stdout. Throws on non-zero exit unless `allowFailure`. */
export function runCommand(command: string, cmdArgs: string[], allowFailure = false): string {
  const proc = Bun.spawnSync([command, ...cmdArgs], { stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout ? Buffer.from(proc.stdout).toString("utf8") : "";
  const stderr = proc.stderr ? Buffer.from(proc.stderr).toString("utf8") : "";
  if (proc.exitCode !== 0 && !allowFailure) {
    throw new Error(`${command} failed (${proc.exitCode})\n${stderr || stdout}`.trim());
  }
  return stdout.trim();
}

export function xdotoolMouseMove(x: number, y: number): void {
  runCommand("xdotool", ["mousemove", String(x), String(y)]);
}

export function xdotoolClick(button: string = "1"): void {
  runCommand("xdotool", ["click", button]);
}

export function xdotoolDoubleClick(button: string = "1", delayMs: number = 120): void {
  runCommand("xdotool", ["click", "--repeat", "2", "--delay", String(delayMs), button]);
}

export function xdotoolKey(key: string): void {
  runCommand("xdotool", ["key", "--clearmodifiers", key]);
}

/** Send a raw key sequence without `--clearmodifiers` (some sequences, e.g. plain `Tab`/`Return`, are sent this way in the source scripts). */
export function xdotoolKeyRaw(key: string): void {
  runCommand("xdotool", ["key", key]);
}

export function xdotoolType(text: string, opts: { delayMs?: number; clearModifiers?: boolean } = {}): void {
  const { delayMs = 30, clearModifiers = true } = opts;
  const args = ["type"];
  if (clearModifiers) args.push("--clearmodifiers");
  args.push("--delay", String(delayMs), "--", text);
  runCommand("xdotool", args);
}
