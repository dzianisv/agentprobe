// End-to-end demo for OpenClawBot's chrome-sync CLI email/password login,
// built on the terminal-and-browser dual-surface primitives (issue #4). This
// is the project-specific consumer this surface was extracted for: a real
// xterm running the PUBLISHED `chrome-sync login` CLI on one side, a real
// Chrome window completing the resulting /auth/cli email/password form on
// the other, recorded together.
//
// Why NOT Google sign-in: Google's GSI `accounts.google.com/gsi/button`
// endpoint 403s requests from datacenter/CI IPs (see OpenClawBot incident
// #2701/#2704) — email/password is the only auth provider on this page that
// is reliably completable from a CI runner.
//
// Why NOT vision-click for the form: `/auth/cli` (OpenClawBot
// src/dashboard/server.ts ~4890-5075) is a plain server-rendered HTML page —
// `<input id="email">`, `<input id="password">`, `<button id="email-btn"
// onclick="doEmailLogin()">` — no client framework, no gesture-gated native
// UI. Setting `.value` + calling `.click()` via CDP `Runtime.evaluate` is
// exactly what the page's own `doEmailLogin()` expects (it reads
// `document.getElementById('email').value` fresh at click time), so a
// deterministic CDP fill is both possible and strictly more reliable than a
// vision-model coordinate guess for this specific form. Vision is reserved
// for the one thing this repo's `core/vision.ts` says CDP fundamentally
// cannot see: an independent judge call on the final screenshot.
//
// The CLI's own local callback server (packages/browser-sync/src/api.ts
// `loginViaBrowser`) is the deterministic success oracle: it prints
// `✓ Authenticated as <name>` to stdout (packages/browser-sync/src/cli.ts's
// `login` action, right after `loginViaBrowser()` resolves) and the
// SAME string is also rendered in the browser tab itself (api.ts's
// `/callback` handler response body `<h2>✓ Authenticated as ...</h2>`) —
// two independent confirmations of one real login.
//
// `xterm -e <cmd>` gives the child process a real pty (so its stdout is
// unbuffered exactly as if attached to a human's terminal), but xterm does
// not forward that pty's content to any file we can poll — its own
// `xterm-stdout.log` (core/terminal-process.ts) is xterm's OWN stdout, not
// the child's. `script -qefc '<cmd>' <logfile>` solves this: it allocates a
// SECOND real pty for the child (keeping stdout synchronous, avoiding a
// classic Node `process.exit()`-truncates-pipe-buffer race) while also
// teeing every byte to a plain file with `-f` (flush after every write) so
// this script's poll loop sees output within its 500ms poll interval.
//
// Usage: bun examples/dual-surface/chrome-sync-login.ts [output-dir]
// Requires: Xvfb on :99, xterm, xdotool, scrot, ffmpeg, util-linux `script`,
// a Chrome binary, network egress to the live chrome-sync auth API, and
// AZURE_CUA_API_KEY (+ AZURE_CUA_BASE_URL) or OPENAI_API_KEY for the final
// vision-judge call.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { attachAndEnable, cdpSend, findTargetByUrl, getBrowserWsUrl, openCdpWs, pollForElementReady } from "../../core/cdp";
import { startChrome, waitForChromeReady } from "../../core/chrome-process";
import { startTerminal, waitForTerminalReady } from "../../core/terminal-process";
import { assembleGif, finalizeRecording, startRecording } from "../../core/recording";
import { saveOptimizedScreenshot } from "../../core/screenshot";
import { createVisionClient, visionJudge } from "../../core/vision";
import { focusTerminal } from "../../surfaces/terminal/focus";

const DISPLAY_WIDTH = 1920;
const DISPLAY_HEIGHT = 1080;
const CDP_PORT = 9334;

// The live, production-registered auth origin for chrome-sync CLI login
// (OpenClawBot issue #2706 cutover: auth.agentlabs.cc is now the canonical
// host GSI/the login page is served on — console.openclaw.vibebrowser.app
// 302s to it). Passed explicitly to the CLI via --api-url so this test does
// not depend on the CLI package's own default staying in sync with this
// value, and re-used for the register-password seed call so both hit the
// same backend.
const API_BASE = process.env.CHROME_SYNC_API_BASE ?? "https://auth.agentlabs.cc";

const AUTH_URL_RE = /If it doesn't open, visit: (\S+)/;
const SUCCESS_RE = /✓ Authenticated as (.+)/;

/** Poll a plain text file's content for `regex`, or throw after `timeoutMs`. */
async function pollFileForMatch(filePath: string, regex: RegExp, timeoutMs: number, label: string): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  while (Date.now() < deadline) {
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const content = await file.text();
      lastSize = content.length;
      const match = content.match(regex);
      if (match) return match;
    }
    await Bun.sleep(500);
  }
  throw new Error(`[chrome-sync-login] "${label}" never appeared in ${filePath} within ${timeoutMs}ms (last observed ${lastSize} bytes)`);
}

/** CDP `Runtime.evaluate` expression matching `checkElementRect`'s expected `{found, visible, x, y, width, height}` JSON-string shape. */
function elementReadyExpr(selector: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify({found:false}); const r = el.getBoundingClientRect(); return JSON.stringify({found:true, visible: r.width>0 && r.height>0, x:r.x, y:r.y, width:r.width, height:r.height}); })()`;
}

/** Deterministic CDP fill: set `<selector>`'s `.value` directly (this page has no framework layer to fight) and dispatch `input` for realism. */
async function cdpSetValue(browserWs: WebSocket, sessionId: string, selector: string, value: string): Promise<void> {
  const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', {bubbles:true})); return 'ok'; })()`;
  const result = await cdpSend(browserWs, "Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
  if (result?.result?.value !== "ok") throw new Error(`cdpSetValue(${selector}): element not found`);
}

/** Deterministic CDP click via the DOM's own `.click()` — reliable here because this is a plain `onclick`-attribute handler on ordinary web content, not a gesture-gated native surface (contrast core/vision.ts's rationale for why THAT case needs a real xdotool click). */
async function cdpClick(browserWs: WebSocket, sessionId: string, selector: string): Promise<void> {
  const expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.click(); return 'ok'; })()`;
  const result = await cdpSend(browserWs, "Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
  if (result?.result?.value !== "ok") throw new Error(`cdpClick(${selector}): element not found`);
}

async function main(): Promise<void> {
  const outputDir = process.argv[2] ?? "/tmp/agentprobe-chrome-sync-login-output";
  await mkdir(outputDir, { recursive: true });

  const azureKey = process.env.AZURE_CUA_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!azureKey && !openaiKey) {
    throw new Error("Either AZURE_CUA_API_KEY or OPENAI_API_KEY is required");
  }
  const vision = createVisionClient({
    apiKey: azureKey ?? openaiKey ?? "",
    baseURL: azureKey ? process.env.AZURE_CUA_BASE_URL : process.env.OPENAI_BASE_URL,
    model: process.env.CUA_MODEL ?? (azureKey ? "gpt-5.4" : "gpt-4o")
  });

  // Throwaway, unambiguously-test-data credential — self-seeded, never sent
  // a real verification email (register-password is ungated). The email's
  // LOCAL-PART must start with `e2e-oc-` — that is the load-bearing part:
  // OpenClawBot's isTestEmail()/isTestUsername() (src/db/tenants.ts
  // TEST_USERNAME_PREFIXES) classifies a signup as test data by matching a
  // startsWith() prefix against the local-part only; the `.internal` domain
  // is irrelevant to that check and does nothing on its own. A prior version
  // of this string used `e2e-cli-login-`, which matches NO prefix in that
  // list — every run of this example registered an unpurgeable real user row
  // in the prod DB. `e2e-oc-` is a listed prefix, so `e2e-oc-cli-login-` is
  // classifiable.
  const runId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const email = `e2e-oc-cli-login-${runId}@e2e.openclaw.internal`;
  const password = `e2e-cli-login-fixture-${crypto.randomBytes(6).toString("hex")}`; // not a real secret: gates only a throwaway synthetic identity

  console.log(`[chrome-sync-login] seeding throwaway account ${email} on ${API_BASE}`);
  const registerRes = await fetch(`${API_BASE}/api/v1/auth/register-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!registerRes.ok) {
    throw new Error(`register-password failed: HTTP ${registerRes.status} — ${await registerRes.text()}`);
  }
  console.log(`[chrome-sync-login] register-password: HTTP ${registerRes.status}`);

  const cliLogPath = path.join(outputDir, "chrome-sync-cli.log");

  // Declared before the try (and assigned inside it) so that if either
  // startRecording or startTerminal itself throws before the try block is
  // entered, the finally block below still runs and cleans up whichever of
  // the two DID start — otherwise a throw here would orphan a running
  // ffmpeg recorder (or xterm process) with nothing left to kill it.
  let recorder: Bun.Subprocess | undefined;
  let terminal: ReturnType<typeof startTerminal> | undefined;
  let chrome: Bun.Subprocess | undefined;
  let browserWs: WebSocket | undefined;
  try {
    recorder = startRecording({ outputDir, displayWidth: DISPLAY_WIDTH, displayHeight: DISPLAY_HEIGHT });
    terminal = startTerminal({
      cmd: "bash",
      args: [
        "-c",
        // `script` gives the CLI child a real pty (sync stdout, matching a
        // human's terminal — avoids Node's process.exit()-vs-buffered-pipe
        // truncation race) while `-f` flushes every write to cliLogPath so
        // this script's poll loop observes output promptly. `env BROWSER=true`
        // neutralizes the CLI's own `xdg-open <authUrl>` auto-launch (it
        // honors `$BROWSER` first) so only our single CDP-controlled Chrome
        // window exists on the display — without it, a second, unmanaged,
        // default-profile Chrome opens with no CDP port, can occlude the
        // terminal window this script is watching, and is never killed.
        `script -qefc "env BROWSER=true npx -y @vibetechnologies/chrome-sync@latest login --api-url ${API_BASE}" ${cliLogPath}`
      ],
      outputDir,
      windowGeometry: "100x40+0+0" // left half of a 1920x1080 display
    });

    const terminalWindowId = await waitForTerminalReady(terminal, { timeoutMs: 20_000 });
    console.log(`[chrome-sync-login] terminal window ready: ${terminalWindowId}`);
    await focusTerminal(terminalWindowId);

    // npx has to resolve/fetch the package on first run — generous timeout.
    const authUrlMatch = await pollFileForMatch(cliLogPath, AUTH_URL_RE, 90_000, "auth URL printed by CLI");
    const authUrl = authUrlMatch[1];
    console.log(`[chrome-sync-login] CLI printed auth URL: ${authUrl}`);

    chrome = startChrome({
      chromeBin: process.env.CHROME_PATH ?? "google-chrome",
      userDataDir: "/tmp/agentprobe-chrome-sync-login-chrome-profile",
      initialUrl: authUrl,
      outputDir,
      cdpPort: CDP_PORT,
      windowPositionX: DISPLAY_WIDTH / 2,
      displayWidth: DISPLAY_WIDTH / 2,
      displayHeight: DISPLAY_HEIGHT
    });
    await waitForChromeReady({ cdpPort: CDP_PORT });
    console.log("[chrome-sync-login] chrome window ready");

    const wsUrl = await getBrowserWsUrl(CDP_PORT);
    browserWs = await openCdpWs(wsUrl);
    const target = await findTargetByUrl(CDP_PORT, (url) => url.includes("/auth/cli"), 20_000, "auth/cli page target");
    const sessionId = await attachAndEnable(browserWs, target.id);

    await pollForElementReady(browserWs, sessionId, elementReadyExpr("#email"), 20_000, "email input");
    await pollForElementReady(browserWs, sessionId, elementReadyExpr("#password"), 5_000, "password input");
    await pollForElementReady(browserWs, sessionId, elementReadyExpr("#email-btn"), 5_000, "sign-in button");

    const step01Path = path.join(outputDir, "step-01-login-form-loaded.png");
    await saveOptimizedScreenshot(step01Path, { displayWidth: DISPLAY_WIDTH, displayHeight: DISPLAY_HEIGHT });

    console.log("[chrome-sync-login] filling email/password via deterministic CDP Runtime.evaluate (no vision-click for this plain HTML form)");
    await cdpSetValue(browserWs, sessionId, "#email", email);
    await cdpSetValue(browserWs, sessionId, "#password", password);
    await cdpClick(browserWs, sessionId, "#email-btn");

    // Deterministic gate: the CLI's OWN localhost callback server prints
    // this on receiving the token — the only ground truth that the whole
    // browser -> API -> redirect -> localhost-callback chain completed.
    const successMatch = await pollFileForMatch(cliLogPath, SUCCESS_RE, 30_000, "CLI success line");
    console.log(`[chrome-sync-login] CLI printed success: "${successMatch[0]}"`);

    // Short settle so the browser's own callback confirmation page (which
    // prints the same "✓ Authenticated as" string server-side) has painted
    // before the shared screenshot.
    await Bun.sleep(1500);

    const step02Path = path.join(outputDir, "step-02-cli-logged-in.png");
    await saveOptimizedScreenshot(step02Path, { displayWidth: DISPLAY_WIDTH, displayHeight: DISPLAY_HEIGHT });

    const judgement = await visionJudge(
      vision,
      step02Path,
      // Single, unambiguous success fact keyed to the EXACT text the CLI
      // renders — a compound "does it look successful" prompt made the judge
      // flake NO on a genuinely-successful screenshot (it quoted "Authenticated
      // as ..." then pedantically ruled it wasn't the word "authenticated").
      // xterm renders the CLI's leading ✓ as garbled bytes (e.g. "âœ"); tell
      // the judge to ignore that and key only on the words "Authenticated as".
      "The LEFT window is a terminal and the RIGHT window is a Chrome browser. " +
        "Answer YES if the terminal contains the text \"Authenticated as\" followed by a name " +
        "(this is the chrome-sync CLI confirming a successful login) AND a Chrome browser window is visible on the right. " +
        "Answer NO only if the words \"Authenticated as\" are not present anywhere in the terminal. " +
        "Note: a checkmark before \"Authenticated as\" may render as garbled characters such as \"âœ\" — ignore that; only the words \"Authenticated as\" matter.",
      { outputDir, label: "chrome-sync-login" }
    );
    console.log(`[chrome-sync-login] vision judge verdict=${judgement.verdict} evidence=${judgement.evidence}`);
    if (judgement.verdict !== "YES") {
      throw new Error(`vision judge rejected the login-success screenshot: ${judgement.evidence}`);
    }

    console.log("[chrome-sync-login] PASSED");
  } finally {
    try {
      browserWs?.close();
    } catch {
      // best-effort
    }
    terminal?.process.kill();
    chrome?.kill();
    recorder?.kill();
    await recorder?.exited;
    // Re-assert +faststart via remux — killing the recorder can still leave
    // moov after mdat, which is why the video shows 0:00 in a viewer (issue #6).
    await finalizeRecording({ outputDir }).catch(() => {});
    await assembleGif({ outputDir }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[chrome-sync-login] FAILED: ${(error as Error).message}`);
  process.exit(1);
});
