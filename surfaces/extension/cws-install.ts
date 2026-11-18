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
//
// A fresh profile may land on Google's cookie-consent interstitial
// (consent.google.com, title "Before you continue") instead of the listing —
// the listing URL's item id is embedded in the interstitial's `continue=`
// query parameter, so the target lookup above still matches that tab
// (VWA#2558, CWS Release Verify run 44293381674: the probe waited the full
// 45s for "Add to Chrome" on the consent page). The Add-to-Chrome wait
// therefore checks for the interstitial on every poll where the install
// button is absent and dismisses it — real xdotool click on the visible
// "Reject all" button (fallback "Accept all"), wait for navigation back to
// the listing, log URL before/after — before resuming the normal wait. The
// install pass criteria below are unchanged.

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
import { xdotoolClick, xdotoolKey, xdotoolKeyRaw, xdotoolMouseMove } from "../../core/xdotool";

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
/**
 * Shared in-page finder JS (string, injected into both Runtime.evaluate
 * expressions below). Widens the old `<button>`-only exact-text match:
 * candidates are button / [role="button"] / a, name is aria-label or
 * textContent, whitespace-normalized and lowercased; exact name match is
 * preferred, otherwise the first name that contains the label.
 * Expects a `__labelSource` string expression in scope; defines `btn`.
 */
function findInstallButtonJs(labelSource: string): string {
  return `
    const __norm = (v) => (v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const __label = __norm(${labelSource});
    const __named = Array.from(document.querySelectorAll('button, [role="button"], a')).map((el) => ({
      el,
      name: __norm(el.getAttribute('aria-label') || el.textContent || '')
    }));
    const btn = (__named.find((x) => x.name === __label) || __named.find((x) => __label !== '' && x.name.includes(__label)))?.el || null;
  `;
}

/** Context the consent dismissal needs beyond the CDP session: a real click channel. */
type ConsentDismissContext = {
  vision: VisionClient;
  outputDir: string;
  displayWidth: number;
  displayHeight: number;
  listingUrl: string;
  itemId: string;
};

type GoogleConsentState = {
  url: string;
  title: string;
  /** Normalized label of the chosen button ("reject all" preferred, "accept all" fallback); null when neither is present. */
  label: string | null;
  /** Viewport rect of the chosen button; null when it is missing, hidden, or disabled. */
  rect: Rect | null;
};

/**
 * Read-only probe for the Google cookie-consent interstitial (VWA#2558).
 * Detected by host `consent.google.com` OR title "Before you continue".
 * Returns null on any other page. Never clicks anything.
 */
async function readGoogleConsentState(ws: WebSocket, sessionId: string): Promise<GoogleConsentState | null> {
  const expression = `(() => {
    const __norm = (v) => (v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const isConsent = location.hostname === 'consent.google.com' || __norm(document.title).includes('before you continue');
    if (!isConsent) return JSON.stringify(null);
    const __named = Array.from(document.querySelectorAll('button, [role="button"], a')).map((el) => ({
      el,
      name: __norm(el.getAttribute('aria-label') || el.textContent || '')
    }));
    let chosen = null;
    let chosenLabel = null;
    for (const label of ['reject all', 'accept all']) {
      chosen = __named.find((x) => x.name === label) || __named.find((x) => x.name.includes(label)) || null;
      if (chosen) { chosenLabel = label; break; }
    }
    if (!chosen) return JSON.stringify({ url: location.href, title: document.title, label: null, rect: null });
    chosen.el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = chosen.el.getBoundingClientRect();
    const style = getComputedStyle(chosen.el);
    const usable = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
      && !(chosen.el.disabled || chosen.el.getAttribute('aria-disabled') === 'true');
    return JSON.stringify({
      url: location.href,
      title: document.title,
      label: chosenLabel,
      rect: usable ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    });
  })()`;
  const result = await cdpSend(ws, "Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  const raw = result?.result?.value as string | undefined;
  if (!raw) return null;
  const parsed = JSON.parse(raw) as GoogleConsentState | null;
  return parsed ?? null;
}

/**
 * Dismiss the consent interstitial with a REAL xdotool click on its visible
 * "Reject all" (fallback "Accept all") button — same gesture discipline as
 * the install click (CDP is read-only here; the click coordinates come from
 * the measured viewport origin, with the vision pipeline as fallback when
 * the origin cannot be measured). Then wait for navigation back to the CWS
 * listing and log the dismissal with the URL before/after. Throws when the
 * click does not return to the listing — a clear consent failure, never a
 * silent 45s stall on the wrong page. Returns false when the interstitial
 * shows no usable button (the caller's normal timeout diagnostics then
 * report the page state).
 */
async function dismissGoogleConsent(
  ws: WebSocket,
  sessionId: string,
  ctx: ConsentDismissContext,
  state: GoogleConsentState
): Promise<boolean> {
  if (!state.label || !state.rect) {
    console.log(
      `[cws-install] google consent interstitial detected at ${state.url} (title=${JSON.stringify(state.title)}) but no usable "Reject all"/"Accept all" button was found; not clicking`
    );
    return false;
  }
  const label = state.label === "reject all" ? "Reject all" : "Accept all";
  console.log(
    `[cws-install] google consent interstitial detected: title=${JSON.stringify(state.title)} url=${state.url} — dismissing via the visible "${label}" button`
  );

  const probePath = path.join(ctx.outputDir, "consent-viewport-origin-probe.png");
  const origin = await measureViewportOriginOnScreen(
    {
      evaluate: async (expression) => {
        const result = await cdpSend(ws, "Runtime.evaluate", { expression, returnByValue: true }, sessionId);
        const raw = result?.result?.value;
        return typeof raw === "string" ? raw : undefined;
      },
      capturePng: async () => {
        await waitForPaintSettle(ws, sessionId, "consent viewport-origin marker");
        await unlink(probePath).catch(() => undefined);
        await saveFullScreenshot(probePath);
        try {
          return await readFile(probePath);
        } catch {
          return null;
        }
      }
    },
    { expectedScreenWidth: ctx.displayWidth, expectedScreenHeight: ctx.displayHeight }
  );
  await waitForPaintSettle(ws, sessionId, `${label} button`);

  if (origin) {
    const screenRect = viewportRectToScreenRect(state.rect, origin, origin.devicePixelRatio);
    const cx = Math.round(screenRect.x + screenRect.width / 2);
    const cy = Math.round(screenRect.y + screenRect.height / 2);
    xdotoolMouseMove(cx, cy);
    xdotoolClick("1");
    console.log(`[cws-install] clicked "${label}" at screen (${cx}, ${cy}) via xdotool (consent button screen rect ${JSON.stringify(screenRect)})`);
  } else {
    const click = await visionLocateAndClick(
      ctx.vision,
      `the '${label}' button on the Google cookie-consent page`,
      `${label} button`,
      {
        outputDir: ctx.outputDir,
        displayWidth: ctx.displayWidth,
        displayHeight: ctx.displayHeight,
        blankGuard: { ...BLANK_FRAME_DEFAULTS, width: ctx.displayWidth, height: ctx.displayHeight },
        expectedRegion: { space: "viewport", rect: state.rect }
      }
    );
    console.log(`[cws-install] clicked "${label}" via vision at (${click.x}, ${click.y}) source=${click.source} (viewport origin not measured)`);
  }

  const navTimeoutMs = 20_000;
  const navStart = Date.now();
  let lastHref = state.url;
  while (Date.now() - navStart < navTimeoutMs) {
    await Bun.sleep(500);
    try {
      const result = await cdpSend(ws, "Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
      const href = result?.result?.value;
      if (typeof href === "string") {
        lastHref = href;
        if (isExpectedListingUrl(href, ctx.itemId, ctx.listingUrl)) {
          console.log(`[cws-install] consent dismissed: navigated from ${state.url} to ${href}`);
          await waitForPaintSettle(ws, sessionId, "CWS listing after consent dismissal");
          return true;
        }
      }
    } catch {
      // Navigation in flight — the evaluate may fail mid-redirect; keep polling.
    }
  }
  throw new Error(
    `Google consent interstitial dismissal via "${label}" did not navigate back to the CWS listing within ${navTimeoutMs}ms (before: ${state.url}; still at: ${lastHref})`
  );
}

async function waitForAddToChromeButton(ws: WebSocket, sessionId: string, buttonText: string, timeoutMs: number, consent?: ConsentDismissContext): Promise<Rect> {
  const expression = `(() => {
    ${findInstallButtonJs(JSON.stringify(buttonText))}
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
  let start = Date.now();
  let lastState = "";
  let consentAttempts = 0;
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
    // VWA#2558: the button is absent — the tab may be sitting on Google's
    // cookie-consent interstitial instead of the listing. Dismiss it (capped
    // at 2 attempts per wait so a click that never navigates cannot loop
    // forever) and restart the wait budget so the listing gets the full
    // timeout once it actually renders.
    if (consent && consentAttempts < 2) {
      let consentState: GoogleConsentState | null = null;
      try {
        consentState = await readGoogleConsentState(ws, sessionId);
      } catch {
        consentState = null;
      }
      if (consentState) {
        consentAttempts += 1;
        const dismissed = await dismissGoogleConsent(ws, sessionId, consent, consentState);
        if (dismissed) start = Date.now();
      }
    }
    await Bun.sleep(500);
  }
  // Timeout: dump full page state to the job log (quota-proof diagnostics)
  // before throwing a compact summary. A diagnostics failure must never
  // mask the original timeout.
  let diagSummary = "";
  try {
    const diagExpression = `(() => {
      const __norm = (v) => (v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a')).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          text: __norm(el.getAttribute('aria-label') || el.textContent || '').slice(0, 80),
          disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
          visible: r.width > 0 && r.height > 0
        };
      });
      return JSON.stringify({
        title: document.title,
        url: location.href,
        candidates,
        bodyText: (document.body?.innerText || '').slice(0, 2000)
      });
    })()`;
    const diagResult = await cdpSend(ws, "Runtime.evaluate", { expression: diagExpression, returnByValue: true }, sessionId);
    const diagRaw = diagResult?.result?.value as string | undefined;
    if (diagRaw) {
      console.log(`[cws-install] install-button timeout diagnostics: ${diagRaw}`);
      const diag = JSON.parse(diagRaw) as { title?: string; url?: string; candidates?: Array<{ tag: string; text: string; disabled: boolean }> };
      const first5 = (diag.candidates ?? []).slice(0, 5).map((c) => `${c.tag}:"${c.text}" disabled=${c.disabled}`).join("; ");
      diagSummary = ` title=${JSON.stringify(diag.title ?? "")} url=${diag.url ?? ""} candidates=${diag.candidates?.length ?? 0} first=[${first5}]`;
    } else {
      console.log("[cws-install] install-button timeout diagnostics: Runtime.evaluate returned no value");
    }
  } catch (diagErr) {
    console.log(`[cws-install] install-button timeout diagnostics failed: ${(diagErr as Error).message}`);
  }
  throw new Error(`"${buttonText}" button never became clickable within ${timeoutMs}ms (last DOM state: ${lastState || "none"})${diagSummary}`);
}

function clickSurfaceExpression(buttonText: string, itemId: string): string {
  return `(() => {
    const buttonText = ${JSON.stringify(buttonText)};
    const itemId = ${JSON.stringify(itemId)};
    ${findInstallButtonJs("buttonText")}
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

  const consentCtx: ConsentDismissContext = {
    vision: opts.vision,
    outputDir: opts.outputDir,
    displayWidth,
    displayHeight,
    listingUrl: opts.listingUrl,
    itemId: opts.itemId
  };

  console.log(`[cws-install] waiting for "${buttonText}" button to become clickable...`);
  await waitForAddToChromeButton(browserWs, sessionId, buttonText, 45_000, consentCtx);

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
        const viewportRect = await waitForAddToChromeButton(browserWs, sessionId, buttonText, 45_000, consentCtx);
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
