// Terminal process lifecycle: launching a real xterm window running a given
// shell command, and waiting for it to become ready.
//
// Parallel to core/chrome-process.ts, but a terminal has no CDP-equivalent
// readiness signal — there is no debugging port to poll. `waitForTerminalReady`
// therefore polls the X11 window manager itself (`xdotool search --class
// xterm`) until the window is mapped, which is the only external signal that
// an xterm process has gotten far enough to open a real window.
//
// NEW code for this repo (issue #4) — there is no prior source file to
// extract this from, unlike most of core/. Written to match
// core/chrome-process.ts's shape (spawn + typed handle + async ready-wait)
// and core/xdotool.ts's subprocess/error conventions exactly.

import path from "node:path";
import { runCommand } from "./xdotool";

export type StartTerminalOptions = {
  cmd: string;
  args?: string[];
  cwd?: string;
  outputDir: string;
  windowGeometry?: string; // xterm -geometry, e.g. "120x40+0+0"
  /** Appended to the xterm-stdout/xterm-stderr log filenames, e.g. "-relaunch". */
  logSuffix?: string;
};

export type TerminalHandle = {
  process: Bun.Subprocess;
  pid: number;
  /** Populated by waitForTerminalReady() once the window is mapped; undefined until then. */
  windowId?: string;
};

/**
 * Launch a real xterm window running `cmd` (with `args`) via `xterm -e`.
 * `-hold` keeps the window open after the command exits so a failed/finished
 * command is still visible in a screenshot/recording, matching the intent of
 * `startChrome` leaving the browser window up for the caller to observe.
 */
export function startTerminal(opts: StartTerminalOptions): TerminalHandle {
  const { cmd, args = [], cwd, outputDir, windowGeometry, logSuffix = "" } = opts;

  const xtermArgs = [
    "-hold",
    ...(windowGeometry ? ["-geometry", windowGeometry] : []),
    "-e",
    cmd,
    ...args
  ];

  const process = Bun.spawn(["xterm", ...xtermArgs], {
    cwd,
    stdout: Bun.file(path.join(outputDir, `xterm-stdout${logSuffix}.log`)),
    stderr: Bun.file(path.join(outputDir, `xterm-stderr${logSuffix}.log`))
  });

  return { process, pid: process.pid };
}

/**
 * Poll `xdotool search --onlyvisible --pid <handle.pid>` (bounded by
 * `timeoutMs`) until a window is mapped, then sleep `postReadySettleMs` for
 * the initial prompt to render. Throws on timeout — an xterm process that
 * never produces a mapped window is a real startup failure. Searching by pid
 * (xterm sets `_NET_WM_PID` to its own process id, i.e. `handle.pid`) and
 * `--onlyvisible` targets this specific terminal's mapped window, instead of
 * a bare `--class xterm` search, which would return whichever xterm the
 * window manager lists first — the wrong window whenever more than one xterm
 * is open on the display, and possibly an unmapped one.
 */
export async function waitForTerminalReady(
  handle: TerminalHandle,
  opts: { timeoutMs?: number; postReadySettleMs?: number } = {}
): Promise<string> {
  const { timeoutMs = 20_000, postReadySettleMs = 500 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windowIds = runCommand("xdotool", ["search", "--onlyvisible", "--pid", String(handle.pid)], true);
    const firstId = windowIds.split("\n").find((line) => line.trim().length > 0);
    if (firstId) {
      handle.windowId = firstId.trim();
      if (postReadySettleMs > 0) await Bun.sleep(postReadySettleMs);
      return handle.windowId;
    }
    await Bun.sleep(500);
  }
  throw new Error(`[terminal-process] xterm window (pid ${handle.pid}) did not map within ${timeoutMs}ms`);
}
