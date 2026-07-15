// Real-browser smoke test for core/dialog.ts's triggerAndHandleJsDialog —
// specifically the fix for the trigger/dialog deadlock (see
// fix/dialog-trigger-deadlock branch history): awaiting `trigger()` before
// waiting for the dialog would hang forever, because Chrome does not
// resolve the CDP command that opened a native dialog (e.g.
// `Runtime.evaluate` on a `.click()` whose handler calls
// `window.confirm()`) until the dialog itself is dismissed.
//
// No mocking: launches a real Chrome for Testing process, opens a real
// `data:` page whose button calls a real `window.confirm()`, and drives it
// entirely through this repo's own core/cdp.ts + core/dialog.ts primitives
// (dogfooding — if these primitives are broken, this script hangs/throws
// exactly like a real consumer would hit).
//
// Run: bun examples/browser/dialog-confirm-smoke.ts [chromeBinPath]
// (defaults to a Puppeteer-cached Chrome for Testing if none given, since
// this script needs no X11/xdotool/scrot — pure CDP — and runs fine on
// macOS/Linux/CI alike.)

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { attachAndEnable, cdpSend, findTargetByUrl, getBrowserWsUrl, openCdpWs, waitForCdpReady } from "../../core/cdp";
import { startChrome, waitForChromeReady } from "../../core/chrome-process";
import { triggerAndHandleJsDialog } from "../../core/dialog";

const CDP_PORT = 9599;

const PAGE_HTML = `<!doctype html><html><body>
<button id="del">Delete</button>
<script>
document.getElementById('del').addEventListener('click', () => {
  const ok = window.confirm('Delete this?');
  document.title = ok ? 'confirmed' : 'cancelled';
});
</script>
</body></html>`;
const PAGE_URL = `data:text/html,${encodeURIComponent(PAGE_HTML)}`;

async function main(): Promise<void> {
  const chromeBin =
    process.argv[2] ??
    process.env.CHROME_BIN ??
    "/Users/engineer/.cache/puppeteer/chrome/mac_arm-150.0.7871.24/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

  const outputDir = await mkdtemp(path.join(tmpdir(), "dialog-smoke-"));
  const userDataDir = await mkdtemp(path.join(tmpdir(), "dialog-smoke-profile-"));

  console.log(`[dialog-smoke] launching ${chromeBin}`);
  const chrome = startChrome({
    chromeBin,
    userDataDir,
    initialUrl: PAGE_URL,
    outputDir,
    cdpPort: CDP_PORT
  });

  let exitCode = 0;
  let browserWs: WebSocket | undefined;
  try {
    await waitForCdpReady(CDP_PORT, 15_000);
    await waitForChromeReady({ cdpPort: CDP_PORT, timeoutMs: 15_000, postReadySettleMs: 1000 });

    const browserWsUrl = await getBrowserWsUrl(CDP_PORT);
    browserWs = await openCdpWs(browserWsUrl);

    const target = await findTargetByUrl(CDP_PORT, (url) => url.startsWith("data:text/html"), 10_000, "smoke page");
    const sessionId = await attachAndEnable(browserWs, target.id);

    console.log("[dialog-smoke] clicking #del (opens window.confirm) via triggerAndHandleJsDialog...");
    const start = Date.now();
    const dialog = await triggerAndHandleJsDialog(
      browserWs,
      sessionId,
      () => cdpSend(browserWs as WebSocket, "Runtime.evaluate", { expression: "document.getElementById('del').click()" }, sessionId),
      { accept: true, timeoutMs: 5000 }
    );
    const elapsedMs = Date.now() - start;
    console.log(`[dialog-smoke] triggerAndHandleJsDialog resolved in ${elapsedMs}ms: ${JSON.stringify(dialog)}`);

    // If the deadlock bug were present, the line above would never return
    // (the click's Runtime.evaluate never resolves until the dialog it
    // opened is handled, and the buggy code awaited it before handling the
    // dialog) — the process would hang until an external timeout killed it,
    // not throw a catchable error. Finishing at all is half the proof;
    // the assertions below are the other half (correct values, and the
    // click's own Runtime.evaluate really did complete afterward).
    if (dialog.type !== "confirm") throw new Error(`expected dialog.type "confirm", got ${JSON.stringify(dialog.type)}`);
    if (dialog.message !== "Delete this?") throw new Error(`expected dialog.message "Delete this?", got ${JSON.stringify(dialog.message)}`);

    const titleResult = await cdpSend(browserWs, "Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
    const title = titleResult?.result?.value;
    // Proves trigger()'s own Runtime.evaluate (the click) genuinely
    // completed after the dialog was handled — the synchronous handler ran
    // to completion (past the confirm() call) and set document.title.
    if (title !== "confirmed") throw new Error(`expected document.title "confirmed" (proves the click handler resumed after confirm()), got ${JSON.stringify(title)}`);

    console.log(`PASS: triggerAndHandleJsDialog resolved in ${elapsedMs}ms with no deadlock, dialog={type:"confirm",message:"Delete this?"}, post-dialog document.title="confirmed"`);
  } catch (err) {
    console.error(`FAIL: ${(err as Error).message}`);
    exitCode = 1;
  } finally {
    try {
      browserWs?.close();
    } catch {
      // ignore
    }
    chrome.kill();
    // Chrome (esp. with helper/renderer processes) can take a while to
    // honor SIGTERM; don't let this script hang indefinitely waiting for
    // graceful shutdown — SIGKILL after a bounded grace period.
    const exited = await Promise.race([
      chrome.exited.then(() => true).catch(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000))
    ]);
    if (!exited) {
      console.log("[dialog-smoke] chrome did not exit within 5s of SIGTERM, sending SIGKILL");
      try {
        chrome.kill("SIGKILL");
      } catch {
        // ignore
      }
      await chrome.exited.catch(() => {});
    }
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`dialog-confirm-smoke error: ${(error as Error).message}`);
  process.exit(1);
});
