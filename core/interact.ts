// Composed interaction primitives: DOM readiness gate + paint settle +
// vision-located click (and, for text fields, click-to-focus then real
// xdotool keystrokes).
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts
// (`findReadyThenVisionClick` / `findReadyThenVisionType`).

import { pollForElementReady } from "./cdp";
import { BLANK_FRAME_DEFAULTS } from "./blank-frame";
import { waitForPaintSettle } from "./paint";
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
