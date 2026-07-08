// Real, human-equivalent Chrome Web Store install: load the listing page,
// vision-locate and xdotool-click "Add to Chrome", accept the native
// confirmation dialog via keyboard (Tab off the default-focused Cancel,
// then Return — never a bare Return), and confirm the install by polling
// the profile's Preferences file.
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts `main()`
// install block (#1501/#1504). Preserves the click-through proof intent:
// every actual click/keypress goes through xdotool, never CDP
// `Input.dispatchMouseEvent` — Chrome's own extension-install UI actively
// resists synthetic input that doesn't look like a real user gesture. CDP is
// read-only here (DOM measurement, Preferences-file polling).
//
// The button text and listing URL are parameters — this file is otherwise
// unchanged from the source's logic. Assumes the caller has already
// launched Chrome (`core/chrome-process.ts`'s `startChrome`) pointed at
// `opts.listingUrl` and that `opts.cdpPort` is reachable.

import { readFile, writeFile } from "node:fs/promises";
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
import { waitForPaintSettle } from "../../core/paint";
import { saveFullScreenshot } from "../../core/screenshot";
import { type VisionClient, visionLocateAndClick } from "../../core/vision";
import { xdotoolKeyRaw } from "../../core/xdotool";

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
  const rect = await waitForAddToChromeButton(browserWs, sessionId, buttonText, 45_000);
  console.log(`[cws-install] button rect (viewport coords, readiness gate only): ${JSON.stringify(rect)}`);

  // The actual click: vision-located, delivered via a real xdotool gesture —
  // the load-bearing line of this whole flow: it proves a human-equivalent
  // gesture, not a synthetic one, triggered the install UI.
  await waitForPaintSettle(browserWs, sessionId, `${buttonText} button`);
  const clickPoint = await visionLocateAndClick(
    opts.vision,
    `the blue '${buttonText}' button on the Chrome Web Store extension listing page`,
    `${buttonText} button`,
    {
      outputDir: opts.outputDir,
      displayWidth,
      displayHeight,
      blankGuard: { ...BLANK_FRAME_DEFAULTS, width: displayWidth, height: displayHeight }
    }
  );
  await writeFile(
    path.join(opts.outputDir, "click-coordinates.json"),
    JSON.stringify({ rect, visionClick: clickPoint }, null, 2),
    "utf8"
  );

  await Bun.sleep(2000);

  const dialogShotPath = path.join(opts.outputDir, "add-extension-dialog.png");
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
    throw new Error(
      `Extension ${opts.itemId} never appeared in Preferences after clicking "${buttonText}" and attempting to accept the dialog via Tab+Return (twice). See ${path.basename(finalShotPath)} and ${path.basename(dialogShotPath)} for the actual dialog state.`
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
