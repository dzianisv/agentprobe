// Real, human-equivalent Chrome Web Store install: load the listing page,
// vision-locate and xdotool-click "Add to Chrome", accept the native
// confirmation dialog via keyboard (Tab off the default-focused Cancel,
// then Return — never a bare Return), and confirm the install by polling
// the profile's Preferences file.
//
// The click is not one-shot. The model's point is cross-checked against the
// button's rect once that rect has been measured in screen pixels (a DOM
// rect is viewport space and is not used as a click fallback). The click is
// then retried if the page itself shows the click missed — an in-page modal,
// a navigation, or the button covered. The native "Add extension?" dialog is
// OS-level and not in the DOM, so the absence of those misclick signals is
// not proof the dialog opened; the Preferences assertions below remain that
// proof. Escape dismisses a stray overlay (the Share modal this flow has
// actually opened) before each re-aim.
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts `main()`
// install block (#1501/#1504). Preserves the click-through proof intent:
// every actual click/keypress goes through xdotool, never CDP
// `Input.dispatchMouseEvent` — Chrome's own extension-install UI actively
// resists synthetic input that doesn't look like a real user gesture. CDP is
// read-only for that gesture (DOM measurement, Preferences-file polling).
// The one write is `Page.navigate` back to the listing after a misclick
// left it — that is recovery, not the install click.
//
// Assumes the caller has already launched Chrome (`core/chrome-process.ts`'s
// `startChrome`) pointed at `opts.listingUrl` and that `opts.cdpPort` is
// reachable.

import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  attachAndEnable,
  cdpSend,
  findTargetByUrl,
  getBrowserWsUrl,
  openCdpWs,
  waitForCdpReady,
  type Rect
} from "../../core/cdp";
import { BLANK_FRAME_DEFAULTS } from "../../core/blank-frame";
import { type ClickSurfaceRead, isClickSurfaceSnapshot, isExpectedListingUrl, verifyClickEffect } from "../../core/click-effect";
import { retryClickUntilVerified } from "../../core/interact";
import { waitForPaintSettle } from "../../core/paint";
import { saveCursorScreenshot, saveFullScreenshot } from "../../core/screenshot";
import { type ExpectedClickRegion, type VisionClient, type VisionLocateAndClickResult, visionLocateAndClick } from "../../core/vision";
import { measureViewportOriginOnScreen, viewportRectToScreenRect } from "../../core/viewport-origin";
import { xdotoolKey, xdotoolKeyRaw } from "../../core/xdotool";

/** Existing post-click settle before the dialog screenshot / key acceptance. Not raised. */
const POST_CLICK_OBSERVE_MS = 2_000;

/**
 * Poll the live DOM (via Runtime.evaluate, read-only — no synthetic click)
 * for the "Add to Chrome"-style button, waiting for it to be present,
 * visible, and enabled. Matched by visible text, not by CSS class — Chrome
 * Web Store's own classes are build-hashed and not a stable contract to
 * depend on. A single slow/unresponsive `Runtime.evaluate` (renderer still
 * busy hydrating) does not abort the wait — it retries on the next poll tick
 * as long as the overall `timeoutMs` budget remains.
 */
async function waitForAddToChromeButton(ws: WebSocket, sessionId: string, buttonText: string, timeoutMs: number): Promise<Rect> {
  const expression = `(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === ${JSON.stringify(buttonText)}
    );
    if (!btn) return JSON.stringify({ found: false });
    btn.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = btn.getBoundingClientRect();
    const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
    return JSON.stringify({
      found: true,
      disabled,
      visible: rect.width > 0 && rect.height > 0,
      x: rect.x, y: rect.y, width: rect.width, height: rect.height
    });
  })()`;
  const start = Date.now();
  let lastState = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await cdpSend(ws, "Runtime.evaluate", { expression, returnByValue: true }, sessionId);
      const raw = result?.result?.value as string | undefined;
      if (raw) {
        lastState = raw;
        const parsed = JSON.parse(raw) as { found: boolean; disabled?: boolean; visible?: boolean } & Partial<Rect>;
        if (parsed.found && !parsed.disabled && parsed.visible) {
          return { x: parsed.x!, y: parsed.y!, width: parsed.width!, height: parsed.height! };
        }
      }
    } catch (err) {
      lastState = `(poll error, retrying: ${(err as Error).message})`;
    }
    await Bun.sleep(500);
  }
  throw new Error(`"${buttonText}" button never became clickable within ${timeoutMs}ms (last DOM state: ${lastState || "none"})`);
}

function clickSurfaceExpression(buttonText: string, itemId: string): string {
  return `(() => {
    const buttonText = ${JSON.stringify(buttonText)};
    const itemId = ${JSON.stringify(itemId)};
    const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === buttonText);
    let hitTarget = false;
    if (btn) {
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      hitTarget = !!(top && (top === btn || btn.contains(top)));
    }
    const modals = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')).filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    });
    return JSON.stringify({
      onExpectedUrl: location.href.includes(itemId),
      url: location.href,
      hitTarget,
      visibleModalCount: modals.length,
      target: btn ? {
        text: (btn.textContent || '').trim(),
        disabled: !!(btn.disabled || btn.getAttribute('aria-disabled') === 'true'),
        ariaBusy: btn.getAttribute('aria-busy')
      } : null
    });
  })()`;
}

async function readClickSurface(
  ws: WebSocket,
  sessionId: string,
  buttonText: string,
  itemId: string,
  listingUrl: string,
  timeoutMs: number
): Promise<ClickSurfaceRead> {
  try {
    const result = await cdpSend(
      ws,
      "Runtime.evaluate",
      { expression: clickSurfaceExpression(buttonText, itemId), returnByValue: true },
      sessionId,
      timeoutMs
    );
    const raw = result?.result?.value;
    if (typeof raw !== "string") return { error: "Runtime.evaluate returned no string" };
    const parsed: unknown = JSON.parse(raw);
    if (!isClickSurfaceSnapshot(parsed)) return { error: `unrecognized click-surface snapshot: ${raw.slice(0, 300)}` };
    // Recompute in this process so a redirect that embeds the item id in a
    // query string is not mistaken for the listing. The in-page flag is ignored.
    return { ...parsed, onExpectedUrl: isExpectedListingUrl(parsed.url, itemId, listingUrl) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** If a previous misclick navigated off the listing, put that tab back before re-aiming. */
async function ensureOnListing(ws: WebSocket, sessionId: string, listingUrl: string, itemId: string): Promise<void> {
  try {
    const result = await cdpSend(ws, "Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId, POST_CLICK_OBSERVE_MS);
    const href = result?.result?.value;
    if (typeof href === "string" && isExpectedListingUrl(href, itemId, listingUrl)) return;
    console.log(`[cws-install] not on the listing (${typeof href === "string" ? href : "unreadable url"}); restoring ${listingUrl} before re-aiming`);
  } catch (err) {
    console.log(`[cws-install] could not read location.href (${(err as Error).message}); restoring ${listingUrl} before re-aiming`);
  }
  await cdpSend(ws, "Page.navigate", { url: listingUrl }, sessionId);
}

type ExtensionPrefsEntry = { location?: number; from_webstore?: boolean; path?: string };

/**
 * Poll the profile's Preferences file for the installed extension. Chrome
 * writes a partial placeholder entry while the CRX is still downloading, so
 * this waits for a COMPLETE entry (`location` and `from_webstore` both set),
 * not just any entry keyed by `itemId`.
 */
async function pollForInstalledExtension(userDataDir: string, itemId: string, timeoutMs: number): Promise<ExtensionPrefsEntry | undefined> {
  const prefsPath = path.join(userDataDir, "Default", "Preferences");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await readFile(prefsPath, "utf8");
      const prefs = JSON.parse(raw) as Record<string, unknown>;
      const settings = (prefs?.extensions as Record<string, unknown> | undefined)?.settings as
        | Record<string, ExtensionPrefsEntry>
        | undefined;
      const entry = settings?.[itemId];
      if (entry) {
        const isComplete = entry.location !== undefined && entry.from_webstore !== undefined;
        console.log(
          `[cws-install] Preferences entry for ${itemId}${isComplete ? "" : " (not yet complete, still installing)"}: ${JSON.stringify(entry)}`
        );
        if (isComplete) return entry;
      }
    } catch {
      // Preferences not written yet, or mid-write — keep polling.
    }
    await Bun.sleep(1000);
  }
  return undefined;
}

export type InstallFromCwsOptions = {
  cdpPort: number;
  listingUrl: string;
  itemId: string;
  userDataDir: string;
  /** Visible text of the install button. Default "Add to Chrome". */
  addToChromeButtonText?: string;
  vision: VisionClient;
  outputDir: string;
  timeoutMs: number;
  /** Real screen dimensions Chrome was launched at — needed for vision click-coordinate scaling. Defaults 1920x1080 (the proven values). */
  displayWidth?: number;
  displayHeight?: number;
};

export type InstalledExtensionEntry = { location: number; from_webstore: boolean; path?: string };

/**
 * Drive the actual human install flow against an already-running,
 * already-navigated Chrome (see module doc). Throws if the dialog can't be
 * accepted, or if the resulting Preferences entry doesn't look like a real
 * store install (`location === 3` is a sideload; `from_webstore !== true`
 * means the install didn't go through the store pipeline).
 */
export async function installFromCws(opts: InstallFromCwsOptions): Promise<InstalledExtensionEntry> {
  const buttonText = opts.addToChromeButtonText ?? "Add to Chrome";
  const displayWidth = opts.displayWidth ?? 1920;
  const displayHeight = opts.displayHeight ?? 1080;

  await waitForCdpReady(opts.cdpPort, 20_000);

  const pageTarget = await findTargetByUrl(opts.cdpPort, (url) => url.includes(opts.itemId), 20_000, `CWS listing page for ${opts.itemId}`);
  console.log(`[cws-install] listing page target found: ${pageTarget.url}`);

  const browserWsUrl = await getBrowserWsUrl(opts.cdpPort);
  const browserWs = await openCdpWs(browserWsUrl);
  const sessionId = await attachAndEnable(browserWs, pageTarget.id);

  // Diagnostic: prove the real listing rendered before going any further.
  const listingShotPath = path.join(opts.outputDir, "cws-listing-loaded.png");
  await saveFullScreenshot(listingShotPath);

  console.log(`[cws-install] waiting for "${buttonText}" button to become clickable...`);
  await waitForAddToChromeButton(browserWs, sessionId, buttonText, 45_000);

  let lastViewportRect: Rect | undefined;
  let lastScreenRect: Rect | undefined;
  let lastClick: VisionLocateAndClickResult | undefined;
  let beforeClick: ClickSurfaceRead | null = null;

  // Retry until the page shows the click did not miss. Escape first so a
  // previous misclick's overlay (Share modal) is not what the next aim hits.
  // A click that leaves no in-page evidence is not retried: the native
  // dialog is invisible to CDP, and Escape would cancel it.
  const verified = await retryClickUntilVerified(
    opts.timeoutMs,
    `${buttonText} button`,
    {
      dismissOverlay: () => xdotoolKey("Escape"),
      click: async () => {
        await ensureOnListing(browserWs, sessionId, opts.listingUrl, opts.itemId);
        const viewportRect = await waitForAddToChromeButton(browserWs, sessionId, buttonText, 45_000);
        lastViewportRect = viewportRect;
        console.log(`[cws-install] button rect (viewport coords): ${JSON.stringify(viewportRect)}`);

        const probePath = path.join(opts.outputDir, "viewport-origin-probe.png");
        const origin = await measureViewportOriginOnScreen(
          {
            evaluate: async (expression) => {
              const result = await cdpSend(browserWs, "Runtime.evaluate", { expression, returnByValue: true }, sessionId);
              const raw = result?.result?.value;
              return typeof raw === "string" ? raw : undefined;
            },
            capturePng: async () => {
              await waitForPaintSettle(browserWs, sessionId, "viewport-origin marker");
              await unlink(probePath).catch(() => undefined);
              await saveFullScreenshot(probePath);
              try {
                return await readFile(probePath);
              } catch {
                return null;
              }
            }
          },
          { expectedScreenWidth: displayWidth, expectedScreenHeight: displayHeight }
        );
        // Marker is removed inside the measurement. Settle so the vision
        // shot — and the click — are not aimed at a screen that still shows it.
        await waitForPaintSettle(browserWs, sessionId, `${buttonText} button`);

        let expectedRegion: ExpectedClickRegion;
        if (origin) {
          const screenRect = viewportRectToScreenRect(viewportRect, origin, origin.devicePixelRatio);
          lastScreenRect = screenRect;
          expectedRegion = { space: "screen", rect: screenRect };
          console.log(
            `[cws-install] measured viewport origin on screen at (${origin.x}, ${origin.y}) dpr=${origin.devicePixelRatio}; button screen rect ${JSON.stringify(screenRect)}`
          );
        } else {
          lastScreenRect = undefined;
          // Declaring viewport space skips the cross-check. Passing this rect
          // as screen space would click a viewport centre on the wrong control.
          expectedRegion = { space: "viewport", rect: viewportRect };
          console.log(
            `[cws-install] viewport→screen offset not measured; vision cross-check skipped (viewport rect is not screen space)`
          );
        }

        beforeClick = await readClickSurface(browserWs, sessionId, buttonText, opts.itemId, opts.listingUrl, POST_CLICK_OBSERVE_MS);
        const click = await visionLocateAndClick(
          opts.vision,
          `the blue '${buttonText}' button on the Chrome Web Store extension listing page`,
          `${buttonText} button`,
          {
            outputDir: opts.outputDir,
            displayWidth,
            displayHeight,
            blankGuard: { ...BLANK_FRAME_DEFAULTS, width: displayWidth, height: displayHeight },
            expectedRegion
          }
        );
        lastClick = click;
        console.log(
          `[cws-install] click source=${click.source} regionCheck=${click.regionCheck} at (${click.x}, ${click.y}) modelPoint=(${click.modelPoint.x}, ${click.modelPoint.y})`
        );
        return { x: click.x, y: click.y };
      },
      verify: async (perAttemptTimeoutMs) => {
        const observeMs = Math.min(POST_CLICK_OBSERVE_MS, perAttemptTimeoutMs);
        await Bun.sleep(observeMs);
        const after = await readClickSurface(
          browserWs,
          sessionId,
          buttonText,
          opts.itemId,
          opts.listingUrl,
          Math.min(POST_CLICK_OBSERVE_MS, perAttemptTimeoutMs)
        );
        return verifyClickEffect(beforeClick, after);
      },
      saveFailureScreenshot: async (label) => {
        const shotPath = path.join(opts.outputDir, `${label.replace(/[^a-z0-9-]+/gi, "-")}-verify-failed.png`);
        await saveCursorScreenshot(shotPath);
        return shotPath;
      }
    },
    { outputDir: opts.outputDir }
  );

  await writeFile(
    path.join(opts.outputDir, "click-coordinates.json"),
    JSON.stringify(
      {
        viewportRect: lastViewportRect,
        screenRect: lastScreenRect ?? null,
        visionClick: lastClick ?? null,
        verified: { ok: verified.ok, detail: verified.detail }
      },
      null,
      2
    ),
    "utf8"
  );

  const dialogShotPath = path.join(opts.outputDir, "add-extension-dialog.png");
  if (!verified.ok) {
    await saveFullScreenshot(dialogShotPath);
    throw new Error(
      `"${buttonText}" click was not verified (${verified.detail}). Not sending Tab+Return — that accepts a native dialog only if this click opened it. See ${path.basename(dialogShotPath)}.`
    );
  }

  await saveFullScreenshot(dialogShotPath);
  console.log(`[cws-install] captured full-screen shot after click: ${dialogShotPath} (native dialog, if present, is OS-level chrome — not visible via CDP)`);

  // Accept the dialog. Chrome's native "Add extension?" prompt defaults
  // keyboard focus to "Cancel" (confirmed via a real captured screenshot in
  // the source incident), not the primary "Add extension" button — a bare
  // Return therefore activates Cancel and silently dismisses the dialog. Fix:
  // Tab once to move focus from Cancel to Add extension, THEN Return.
  xdotoolKeyRaw("Tab");
  await Bun.sleep(200);
  xdotoolKeyRaw("Return");
  console.log(`[cws-install] sent xdotool key Tab+Return to move focus off the default-focused Cancel button and accept the dialog`);

  let entry = await pollForInstalledExtension(opts.userDataDir, opts.itemId, 10_000);

  if (!entry) {
    // Tab+Return didn't produce even a partial Preferences entry yet. Try
    // one fallback: a second Tab+Return, in case the dialog's tab order has
    // more than two stops. Never fall back to a bare Return — that is
    // precisely the action already proven to dismiss the dialog via Cancel.
    const noResultShotPath = path.join(opts.outputDir, "after-return-no-result.png");
    await saveFullScreenshot(noResultShotPath);
    console.log(`[cws-install] no Preferences entry after Tab+Return; diagnostic shot: ${noResultShotPath}. Trying a second Tab+Return in case focus needed to advance further.`);

    xdotoolKeyRaw("Tab");
    await Bun.sleep(200);
    xdotoolKeyRaw("Return");

    entry = await pollForInstalledExtension(opts.userDataDir, opts.itemId, Math.max(10_000, opts.timeoutMs - 20_000));
  }

  if (!entry) {
    const finalShotPath = path.join(opts.outputDir, "install-failed-diagnostic.png");
    await saveFullScreenshot(finalShotPath);
    const clickNote = lastClick
      ? ` Last click source=${lastClick.source} regionCheck=${lastClick.regionCheck} at (${lastClick.x}, ${lastClick.y}) modelPoint=(${lastClick.modelPoint.x}, ${lastClick.modelPoint.y}).`
      : "";
    throw new Error(
      `Extension ${opts.itemId} never appeared in Preferences after clicking "${buttonText}" and attempting to accept the dialog via Tab+Return (twice).${clickNote} See ${path.basename(finalShotPath)} and ${path.basename(dialogShotPath)} for the actual dialog state.`
    );
  }

  await writeFile(path.join(opts.outputDir, "extension-prefs-entry.json"), JSON.stringify(entry, null, 2), "utf8");

  if (entry.location === 3) {
    throw new Error(`Extension installed with location=3 (UNPACKED) — this indicates a sideload, not a real click-through store install`);
  }
  if (entry.from_webstore !== true) {
    throw new Error(`Extension installed (location=${entry.location}) but from_webstore=${entry.from_webstore}, not true — a genuine store install must set this`);
  }

  console.log(`[cws-install] install confirmed: location=${entry.location} from_webstore=${entry.from_webstore} path=${entry.path}`);

  await Bun.sleep(1000);
  const installedShotPath = path.join(opts.outputDir, "extension-installed.png");
  await saveFullScreenshot(installedShotPath);

  return entry as InstalledExtensionEntry;
}
