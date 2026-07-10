// Pure-terminal surface: focusing a real xterm window via a real xdotool
// gesture. Mirrors surfaces/webapp/navigate.ts's focus step exactly (same
// `xdotool search ... windowfocus` invocation, same settle sleep) — window
// discovery + focus is the entire gap core/terminal-process.ts and this
// surface fill; no PTY output parsing or ANSI stripping is added here.
//
// NEW for issue #4 — no prior source file to extract this from.

export type FocusTerminalOptions = {
  /** xdotool `--class` match for the terminal window to focus. Default "xterm". Ignored if `windowId` is given. */
  windowClass?: string;
};

/**
 * Focus a real xterm window via a real X11 gesture (never a synthetic
 * WM-level focus call) — same rationale as `navigateChromeTo`: input gated on
 * "is this window focused" should be exercised the same way a human's window
 * manager would deliver it. If `windowId` is known (e.g. from
 * `waitForTerminalReady`'s return value), focus that exact window instead of
 * a bare `--class xterm` search, which is ambiguous once more than one xterm
 * is open on the display (as this repo's dual-surface examples do).
 */
export async function focusTerminal(windowId?: string, opts: FocusTerminalOptions = {}): Promise<void> {
  const windowClass = opts.windowClass ?? "xterm";
  const focus = Bun.spawn(
    windowId
      ? ["xdotool", "windowfocus", windowId]
      : ["xdotool", "search", "--sync", "--onlyvisible", "--class", windowClass, "windowfocus"],
    { stdout: "ignore", stderr: "ignore" }
  );
  await focus.exited;
  await Bun.sleep(300);
}
