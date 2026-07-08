// Pure-webapp surface: navigating a real Chrome window via a real xdotool
// gesture sequence (focus window, Ctrl+L, type URL, Enter), and DOM-text
// polling/assertion. Never touches extension-specific surfaces (CDP
// service-worker targets, toolbar icons) — usable standalone against any
// webapp scenario.
//
// Extracted from vibebrowser's tests/cua/runner.ts (`navigateChromeTo`) and
// tests/cua/cws-visual-install.ts (`assertTextVisible`, whose boolean-poll
// body is extracted here as `pollForDomText`). `assertTextVisibleOrThrow` is
// a NEW throwing wrapper — named distinctly from the source's boolean-
// returning `assertTextVisible` so a migrating caller can't silently swap
// a boolean check for an exception path (or vice versa).

import { cdpSend } from "../../core/cdp";

export type NavigateChromeToOptions = {
  /** xdotool `--class` match for the browser window to focus. Default "Chrome". */
  windowClass?: string;
};

/**
 * Focus the real Chrome window, open the omnibox (Ctrl+L), type `url`, and
 * press Enter — all real X11 gestures via xdotool, no CDP `Page.navigate`
 * (which would not exercise the same input path a human uses).
 */
export async function navigateChromeTo(url: string, opts: NavigateChromeToOptions = {}): Promise<void> {
  const windowClass = opts.windowClass ?? "Chrome";
  const focus = Bun.spawn(
    ["xdotool", "search", "--sync", "--onlyvisible", "--class", windowClass, "windowfocus"],
    { stdout: "ignore", stderr: "ignore" }
  );
  await focus.exited;
  await Bun.sleep(300);
  const openBar = Bun.spawn(["xdotool", "key", "--clearmodifiers", "ctrl+l"], { stdout: "ignore", stderr: "ignore" });
  await openBar.exited;
  await Bun.sleep(200);
  const typeUrl = Bun.spawn(["xdotool", "type", "--clearmodifiers", url], { stdout: "ignore", stderr: "ignore" });
  await typeUrl.exited;
  await Bun.sleep(100);
  const enter = Bun.spawn(["xdotool", "key", "Return"], { stdout: "ignore", stderr: "ignore" });
  await enter.exited;
}

/** Read-only poll for whether `text` appears in the target's rendered DOM (`document.body.innerText`). */
export async function pollForDomText(browserWs: WebSocket, sessionId: string, text: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await cdpSend(
        browserWs,
        "Runtime.evaluate",
        { expression: `document.body.innerText.includes(${JSON.stringify(text)})`, returnByValue: true },
        sessionId
      );
      if (result?.result?.value === true) return true;
    } catch {
      // transient — retry
    }
    await Bun.sleep(500);
  }
  return false;
}

/**
 * Same as `pollForDomText`, but throws (with `label` in the message) instead
 * of returning false. Deliberately NOT named `assertTextVisible`: the source
 * script's function of that name returns a boolean (it is `pollForDomText`
 * here), and reusing the name for throwing semantics would be an identity
 * trap during migration.
 */
export async function assertTextVisibleOrThrow(
  browserWs: WebSocket,
  sessionId: string,
  text: string,
  timeoutMs: number,
  label: string = text
): Promise<void> {
  const ok = await pollForDomText(browserWs, sessionId, text, timeoutMs);
  if (!ok) throw new Error(`assertTextVisibleOrThrow: "${label}" never appeared in DOM within ${timeoutMs}ms`);
}
