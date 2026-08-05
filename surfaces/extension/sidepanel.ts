// Open and verify a Chrome extension's side panel: configure
// open-on-action-click behavior (config, not a gesture — CDP is fine),
// click the pinned toolbar icon via a real xdotool gesture (retried, because
// Chrome's own post-relaunch promo bubbles can swallow a single click), then
// assert the SIDE_PANEL context via `chrome.runtime.getContexts`.
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts
// (`configureSidepanelBehavior`, `assertSidepanelContext`,
// `openAndAssertSidepanel`) — logic already extension-agnostic in the
// source; the hardcoded CDP port becomes a parameter.

import path from "node:path";

import { listCdpTargets, openCdpWs, cdpSend, type CdpTarget } from "../../core/cdp";
import { saveCursorScreenshot } from "../../core/screenshot";
import { xdotoolClick, xdotoolKey, xdotoolMouseMove } from "../../core/xdotool";

/**
 * `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})` is
 * configuration, not a gesture — CDP is fine here (the actual panel-opening
 * click is still always a real xdotool gesture; this just ensures that click
 * has an effect).
 */
export async function configureSidepanelBehavior(cdpPort: number, extensionId: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await listCdpTargets(cdpPort);
      const swTarget = targets.find((t) => t.type === "service_worker" && t.url.includes(extensionId));
      if (!swTarget) {
        await Bun.sleep(400);
        continue;
      }
      const ws = await openCdpWs((swTarget as CdpTarget & { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
      try {
        const result = await cdpSend(ws, "Runtime.evaluate", {
          expression: `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).then(() => 'ok').catch(e => 'err: ' + (e && e.message || String(e)))`,
          awaitPromise: true,
          returnByValue: true
        });
        const value = result?.result?.value as string | undefined;
        console.log(`[sidepanel] configureSidepanelBehavior -> ${value}`);
        return value === "ok";
      } finally {
        ws.close();
      }
    } catch (err) {
      console.log(`[sidepanel] configureSidepanelBehavior attempt failed: ${(err as Error).message}`);
      await Bun.sleep(400);
    }
  }
  return false;
}

/**
 * Assert the side panel context via `chrome.runtime.getContexts` —
 * `contextType === 'SIDE_PANEL'`, not just "a tab with sidepanel.html in the
 * URL exists." Read-only query against the extension's service worker — no
 * gesture involved.
 */
export async function assertSidepanelContext(cdpPort: number, extensionId: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await listCdpTargets(cdpPort);
      const swTarget = targets.find((t) => t.type === "service_worker" && t.url.includes(extensionId));
      if (!swTarget) {
        await Bun.sleep(400);
        continue;
      }
      const ws = await openCdpWs((swTarget as CdpTarget & { webSocketDebuggerUrl: string }).webSocketDebuggerUrl);
      try {
        const result = await cdpSend(ws, "Runtime.evaluate", {
          expression: `chrome.runtime.getContexts({contextTypes: ['SIDE_PANEL']}).then(ctxs => JSON.stringify({count: ctxs.length, urls: ctxs.map(c => c.documentUrl)})).catch(e => JSON.stringify({error: String(e)}))`,
          awaitPromise: true,
          returnByValue: true
        });
        const raw = result?.result?.value as string | undefined;
        if (raw) {
          last = raw;
          const parsed = JSON.parse(raw) as { count?: number; urls?: string[]; error?: string };
          if (parsed.count && parsed.count > 0) {
            return { ok: true, detail: raw };
          }
        }
      } finally {
        ws.close();
      }
    } catch (err) {
      last = `(poll error: ${(err as Error).message})`;
    }
    await Bun.sleep(500);
  }
  return { ok: false, detail: last || "chrome.runtime.getContexts never reported a SIDE_PANEL context" };
}

/** Default number of click attempts made by `openAndAssertSidepanel`. */
const DEFAULT_CLICK_ATTEMPTS = 5;

export type OpenAndAssertSidepanelOptions = {
  cdpPort: number;
  extensionId: string;
  toolbarIconX: number;
  toolbarIconY: number;
  /** Total budget for the click+assert loop, split evenly across `clickAttempts` (floor 5s per attempt). */
  timeoutMs: number;
  /** Max toolbar-icon click attempts before giving up. Default 5. */
  clickAttempts?: number;
  /** If set, a pointer-composited diagnostic screenshot is written here on final failure. */
  outputDir?: string;
};

/**
 * Full open-and-verify sequence for the side panel: configure the
 * open-on-action-click behavior, click the pinned toolbar icon via a real
 * xdotool gesture, then assert the SIDE_PANEL context. Reusable for both the
 * initial open and a close/reopen persistence check.
 *
 * The click is retried rather than fired once: Chrome's profile sign-in promo
 * bubble auto-opens ~2-3s after a browser relaunch as its own X11 window
 * holding a pointer grab, and silently swallows a single click at the toolbar
 * icon. `assertSidepanelContext` already tolerates MV3 service-worker sleep
 * (it re-resolves the SW target every poll), but polling alone can never
 * recover a click that was never delivered — only re-clicking can.
 */
export async function openAndAssertSidepanel(opts: OpenAndAssertSidepanelOptions): Promise<{ ok: boolean; detail: string }> {
  await configureSidepanelBehavior(opts.cdpPort, opts.extensionId, 10_000);

  const attempts = opts.clickAttempts ?? DEFAULT_CLICK_ATTEMPTS;
  const perAttemptTimeoutMs = Math.max(5_000, Math.floor(opts.timeoutMs / attempts));
  let last = "";

  // TODO(pinned-icon-coords): `toolbarIconX/Y` are hardcoded by callers (e.g.
  // 1768,73) and are only valid for one window size / toolbar layout, and
  // `pinExtensionViaPreferences` reports success on a successful Preferences
  // write without ever verifying an icon actually rendered. Follow-up: locate
  // the pinned extension action button dynamically (vision or a CDP query
  // against the browser UI) and fall back to it when the hardcoded point does
  // not open the panel. Deliberately not done here — it needs plumbing a
  // VisionClient into this surface, which this fix does not require.
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Dismiss the profile sign-in promo bubble (or any other stray popup)
    // before aiming: while it is up it holds the pointer grab and the click
    // below never reaches the browser toolbar.
    xdotoolKey("Escape");
    await Bun.sleep(200);
    console.log(`[sidepanel] xdotool click on pinned toolbar icon at (${opts.toolbarIconX}, ${opts.toolbarIconY}) — attempt ${attempt}/${attempts}`);
    xdotoolMouseMove(opts.toolbarIconX, opts.toolbarIconY);
    await Bun.sleep(200);
    xdotoolClick();

    const result = await assertSidepanelContext(opts.cdpPort, opts.extensionId, perAttemptTimeoutMs);
    if (result.ok) {
      console.log(`[sidepanel] SIDE_PANEL context confirmed on attempt ${attempt}/${attempts}`);
      return result;
    }
    last = result.detail;
    console.log(`[sidepanel] attempt ${attempt}/${attempts} did not open the side panel: ${last}`);
  }

  let shotNote = "";
  if (opts.outputDir) {
    const shotPath = path.join(opts.outputDir, "sidepanel-open-failed.png");
    await saveCursorScreenshot(shotPath);
    shotNote = ` Diagnostic shot (pointer glyph composited, so it shows where the click actually landed): ${shotPath}.`;
  }
  const detail = `no SIDE_PANEL context after ${attempts} xdotool click attempts at (${opts.toolbarIconX}, ${opts.toolbarIconY}), ${perAttemptTimeoutMs}ms poll each.${shotNote} Last poll: ${last || "chrome.runtime.getContexts never reported a SIDE_PANEL context"}`;
  console.log(`[sidepanel] ${detail}`);
  return { ok: false, detail };
}
