// Open and verify a Chrome extension's side panel: configure
// open-on-action-click behavior (config, not a gesture — CDP is fine),
// click the pinned toolbar icon via a real xdotool gesture, then assert the
// SIDE_PANEL context via `chrome.runtime.getContexts`.
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts
// (`configureSidepanelBehavior`, `assertSidepanelContext`,
// `openAndAssertSidepanel`) — logic already extension-agnostic in the
// source; the hardcoded CDP port becomes a parameter.

import { listCdpTargets, openCdpWs, cdpSend, type CdpTarget } from "../../core/cdp";
import { xdotoolClick, xdotoolMouseMove } from "../../core/xdotool";

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

export type OpenAndAssertSidepanelOptions = {
  cdpPort: number;
  extensionId: string;
  toolbarIconX: number;
  toolbarIconY: number;
  timeoutMs: number;
};

/**
 * Full open-and-verify sequence for the side panel: configure the
 * open-on-action-click behavior, click the pinned toolbar icon via a real
 * xdotool gesture, then assert the SIDE_PANEL context. Reusable for both the
 * initial open and a close/reopen persistence check.
 */
export async function openAndAssertSidepanel(opts: OpenAndAssertSidepanelOptions): Promise<{ ok: boolean; detail: string }> {
  await configureSidepanelBehavior(opts.cdpPort, opts.extensionId, 10_000);
  console.log(`[sidepanel] xdotool click on pinned toolbar icon at (${opts.toolbarIconX}, ${opts.toolbarIconY})`);
  xdotoolMouseMove(opts.toolbarIconX, opts.toolbarIconY);
  await Bun.sleep(200);
  xdotoolClick();
  await Bun.sleep(1500);
  return assertSidepanelContext(opts.cdpPort, opts.extensionId, opts.timeoutMs);
}
