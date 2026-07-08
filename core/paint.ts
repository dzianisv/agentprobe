// Deterministic paint gate: readyState complete plus a double
// requestAnimationFrame on the target's own session — the second rAF
// callback only runs after the renderer has produced a real frame for the
// first.
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts. Root cause
// this defends against (CI run 28921885756): a DOM-readiness gate can pass
// (an element exists in the DOM) while the page is still an unpainted blank
// frame on screen — `waitForPaintSettle` closes that gap before a screenshot
// is taken. The target must be foreground (see `attachAndEnable` in
// `cdp.ts`) or rAF may be throttled.

import { cdpSend } from "./cdp";

/**
 * Wait for the target session to report a real painted frame. On overall
 * timeout, logs and returns (does not throw) — callers that screenshot
 * afterwards (e.g. `visionLocateAndClick`'s blank-frame guard) are the
 * second line of defense.
 */
export async function waitForPaintSettle(
  browserWs: WebSocket,
  sessionId: string,
  label: string,
  timeoutMs = 10_000
): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await cdpSend(
        browserWs,
        "Runtime.evaluate",
        {
          expression: `new Promise((resolve) => {
          if (document.readyState !== 'complete') { resolve('readyState=' + document.readyState); return; }
          setTimeout(() => resolve('raf-timeout'), 2000);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve('painted')));
        })`,
          awaitPromise: true,
          returnByValue: true
        },
        sessionId
      );
      last = String(result?.result?.value ?? "");
      if (last === "painted") {
        // Frame produced by the renderer; give the compositor/X server a
        // short settle so scrot sees it too.
        await Bun.sleep(400);
        console.log(`[paint] paint settle for "${label}": renderer produced a frame (double rAF) in ${Date.now() - start}ms`);
        return;
      }
    } catch (err) {
      last = `(evaluate error: ${(err as Error).message})`;
    }
    await Bun.sleep(250);
  }
  console.log(`[paint] paint settle for "${label}": no double-rAF confirmation within ${timeoutMs}ms (last: ${last}) — proceeding, blank-capture guard will recheck`);
}
