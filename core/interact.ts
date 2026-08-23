// Composed interaction primitives: DOM readiness gate + paint settle +
// vision-located click (and, for text fields, click-to-focus then real
// xdotool keystrokes).
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts
// (`findReadyThenVisionClick` / `findReadyThenVisionType`).

import { cdpSend, pollForElementReady } from "./cdp";
import { BLANK_FRAME_DEFAULTS } from "./blank-frame";
import { waitForPaintSettle } from "./paint";
import { saveCursorScreenshot } from "./screenshot";
import { type VisionClient, visionLocateAndClick } from "./vision";
import { xdotoolKey, xdotoolType } from "./xdotool";

export type InteractContext = { outputDir: string; displayWidth: number; displayHeight: number };

function blankGuardFor(ctx: InteractContext) {
  return { ...BLANK_FRAME_DEFAULTS, width: ctx.displayWidth, height: ctx.displayHeight };
}

/** DOM readiness gate (read-only) + paint settle + vision-located click. */
export async function findReadyThenVisionClick(
  browserWs: WebSocket,
  sessionId: string,
  findExpression: string,
  timeoutMs: number,
  label: string,
  vision: VisionClient,
  visionDescription: string,
  ctx: InteractContext
): Promise<{ x: number; y: number }> {
  await pollForElementReady(browserWs, sessionId, findExpression, timeoutMs, label);
  // DOM-ready is not paint-ready — an element can exist in the DOM while the
  // page is still a blank white frame on screen.
  await waitForPaintSettle(browserWs, sessionId, label);
  return visionLocateAndClick(vision, visionDescription, label, {
    outputDir: ctx.outputDir,
    displayWidth: ctx.displayWidth,
    displayHeight: ctx.displayHeight,
    blankGuard: blankGuardFor(ctx)
  });
}

/** Default number of click attempts made by `findReadyThenVisionClickAndVerify`. */
const DEFAULT_VERIFY_CLICK_ATTEMPTS = 5;

export type VerifyClickOptions = {
  /** Max click attempts before giving up. Default 5. */
  clickAttempts?: number;
  /** If set, a pointer-composited diagnostic screenshot is written here on final failure. */
  outputDir?: string;
  /**
   * Floor applied to the per-attempt verify-poll budget (`timeoutMs` split
   * evenly across `clickAttempts`, never below this). Default 5000ms —
   * override only for tests; production callers should rely on the default.
   */
  minAttemptTimeoutMs?: number;
  /** Interval between verify-expression polls within an attempt. Default 300ms — override only for tests. */
  pollIntervalMs?: number;
};

/**
 * DOM readiness gate + paint settle + vision-located click, retried until a
 * caller-supplied `verifyExpression` (a `Runtime.evaluate`-able JS expression
 * returning a JSON-stringified boolean, e.g. `String(!!document.querySelector(...))`)
 * confirms the click actually took effect.
 *
 * A single vision-located click can be silently swallowed by a transient
 * overlay stealing the pointer grab (see `openAndAssertSidepanel`'s toolbar
 * click, dzianisv/agentprobe#11) — and unlike the toolbar-icon case there is
 * no bounded read-only poll (like `chrome.runtime.getContexts`) that can
 * recover on its own; only re-clicking can. This generalizes that fix to any
 * vision-located click with an app-supplied confirmation signal.
 */
export async function findReadyThenVisionClickAndVerify(
  browserWs: WebSocket,
  sessionId: string,
  findExpression: string,
  timeoutMs: number,
  label: string,
  vision: VisionClient,
  visionDescription: string,
  ctx: InteractContext,
  verifyExpression: string,
  opts: VerifyClickOptions = {}
): Promise<{ ok: boolean; x?: number; y?: number; detail: string }> {
  await pollForElementReady(browserWs, sessionId, findExpression, timeoutMs, label);
  // DOM-ready is not paint-ready — an element can exist in the DOM while the
  // page is still a blank white frame on screen.
  await waitForPaintSettle(browserWs, sessionId, label);

  const attempts = opts.clickAttempts ?? DEFAULT_VERIFY_CLICK_ATTEMPTS;
  const perAttemptTimeoutMs = Math.max(opts.minAttemptTimeoutMs ?? 5_000, Math.floor(timeoutMs / attempts));
  let last = "";
  let lastPoint: { x: number; y: number } | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Dismiss any stray popup/overlay holding the pointer grab before aiming
    // — same rationale as `openAndAssertSidepanel`'s toolbar click retry.
    xdotoolKey("Escape");
    await Bun.sleep(200);
    lastPoint = await visionLocateAndClick(vision, visionDescription, label, {
      outputDir: ctx.outputDir,
      displayWidth: ctx.displayWidth,
      displayHeight: ctx.displayHeight,
      blankGuard: blankGuardFor(ctx)
    });
    console.log(`[interact] ${label}: vision-click attempt ${attempt}/${attempts} at (${lastPoint.x}, ${lastPoint.y}), verifying...`);

    const verified = await pollExpressionTruthy(browserWs, sessionId, verifyExpression, perAttemptTimeoutMs, opts.pollIntervalMs);
    if (verified.ok) {
      console.log(`[interact] ${label}: click verified on attempt ${attempt}/${attempts}`);
      return { ok: true, x: lastPoint.x, y: lastPoint.y, detail: verified.detail };
    }
    last = verified.detail;
    console.log(`[interact] ${label}: attempt ${attempt}/${attempts} click did not verify: ${last}`);
  }

  let shotNote = "";
  if (opts.outputDir) {
    const shotPath = `${opts.outputDir}/${label.replace(/[^a-z0-9-]+/gi, "-")}-verify-failed.png`;
    await saveCursorScreenshot(shotPath);
    shotNote = ` Diagnostic shot (pointer glyph composited, so it shows where the click actually landed): ${shotPath}.`;
  }
  const detail = `${label}: click not verified after ${attempts} attempts at ${lastPoint ? `(${lastPoint.x}, ${lastPoint.y})` : "(unknown point)"}.${shotNote} Last check: ${last}`;
  console.log(`[interact] ${detail}`);
  return { ok: false, x: lastPoint?.x, y: lastPoint?.y, detail };
}

/** Poll a `Runtime.evaluate`-able boolean expression until truthy or timeout. Read-only, no gesture. */
async function pollExpressionTruthy(
  browserWs: WebSocket,
  sessionId: string,
  expression: string,
  timeoutMs: number,
  pollIntervalMs = 300
): Promise<{ ok: boolean; detail: string }> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await cdpSend(browserWs, "Runtime.evaluate", { expression, returnByValue: true }, sessionId);
      const raw = result?.result?.value;
      last = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (raw === true || raw === "true") {
        return { ok: true, detail: last };
      }
    } catch (err) {
      last = `(poll error: ${(err as Error).message})`;
    }
    await Bun.sleep(pollIntervalMs);
  }
  return { ok: false, detail: last || "verify expression never became truthy" };
}

/**
 * DOM readiness gate + vision-located click-to-focus, then real xdotool
 * keystrokes. `redact` suppresses the typed value from the log (e.g.
 * passwords).
 */
export async function findReadyThenVisionType(
  browserWs: WebSocket,
  sessionId: string,
  findExpression: string,
  text: string,
  timeoutMs: number,
  label: string,
  vision: VisionClient,
  visionDescription: string,
  ctx: InteractContext,
  redact = false
): Promise<void> {
  await pollForElementReady(browserWs, sessionId, findExpression, timeoutMs, label);
  await waitForPaintSettle(browserWs, sessionId, label);
  await visionLocateAndClick(vision, visionDescription, label, {
    outputDir: ctx.outputDir,
    displayWidth: ctx.displayWidth,
    displayHeight: ctx.displayHeight,
    blankGuard: blankGuardFor(ctx)
  });
  await Bun.sleep(150);
  xdotoolKey("ctrl+a");
  xdotoolKey("Delete");
  xdotoolType(text, { delayMs: 30 });
  console.log(`[interact] xdotool typed into ${label}${redact ? " (value redacted)" : `: ${JSON.stringify(text)}`}`);
}
