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

// Node-safe sleep for `waitForPageOwnPaintSettle`, which `core/recording.ts`'s
// `startPageFrameCapture` calls in-process from plain-Node consumers (see
// same rationale in `core/blank-frame.ts`) — `Bun.sleep` there threw
// `ReferenceError: Bun is not defined` under Node, silently defeating the
// paint gate this function exists to provide.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Structural (not import-time) dependency on Playwright's `Page.evaluate` —
 * deliberately not `import type { Page } from "playwright"` so this module
 * never needs `playwright` as a dependency (matches `core/recording.ts`'s
 * `ScreenshotCapable` pattern). Any object with a matching `evaluate()`
 * method (a real Playwright `Page`, or a test double) satisfies this.
 */
export type EvaluateCapable = {
  evaluate<T>(pageFunction: () => T | Promise<T>): Promise<T>;
};

const PAINT_SETTLE_EXPRESSION = () =>
  new Promise<string>((resolve) => {
    if (document.readyState !== "complete") {
      resolve(`readyState=${document.readyState}`);
      return;
    }
    setTimeout(() => resolve("raf-timeout"), 2000);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve("painted")));
  });

/**
 * `waitForPaintSettle`'s Playwright-`Page`-only counterpart: same
 * readyState + double-rAF gate, driven through `page.evaluate()` instead of
 * a raw CDP `Runtime.evaluate` call, for callers (like
 * `core/recording.ts`'s `startPageFrameCapture`) that only have a
 * Playwright `Page` and no CDP `browserWs`/`sessionId` pair.
 *
 * This is what closes the gap `startPageFrameCapture` was missing under
 * Xvfb: Chrome's native-window-occlusion / renderer-backgrounding behavior
 * can intermittently stop compositing an occluded target between paint and
 * the next `page.screenshot()` tick; a bare interval capture with no gate
 * accepts whatever `Page.captureScreenshot` returns (including a blank or
 * stale frame) instead of first confirming the renderer actually produced
 * a fresh frame. Same non-throwing timeout behavior as `waitForPaintSettle`
 * — the blank-frame retry (`captureUntilPainted` / `captureBufferUntilPainted`
 * in `core/blank-frame.ts`) is always the second line of defense.
 */
export async function waitForPageOwnPaintSettle(
  page: EvaluateCapable,
  label: string,
  timeoutMs = 10_000
): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      last = await page.evaluate(PAINT_SETTLE_EXPRESSION);
      if (last === "painted") {
        console.log(`[paint] paint settle for "${label}": renderer produced a frame (double rAF) in ${Date.now() - start}ms`);
        return;
      }
    } catch (err) {
      last = `(evaluate error: ${(err as Error).message})`;
    }
    await sleep(100);
  }
  console.log(`[paint] paint settle for "${label}": no double-rAF confirmation within ${timeoutMs}ms (last: ${last}) — proceeding, blank-capture guard will recheck`);
}

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
