// Dual-surface example for issue #4: a real xterm window and a real Chrome
// window driven side by side on the same Xvfb display, recorded together.
// Proves core/terminal-process.ts + surfaces/terminal/focus.ts coexist with
// the existing core/chrome-process.ts + surfaces/webapp/navigate.ts without
// needing a new capture primitive — core/screenshot.ts and core/recording.ts
// are used completely unmodified, because both already grab the whole X11
// root window rather than a single application's surface.
//
// This is the shape a consumer like OpenClawBot's chrome-sync test would
// follow: a terminal running the real CLI command on one side, Chrome
// completing the resulting OAuth flow on the other. The actual chrome-sync
// command is out of scope here (per issue #4) — this uses a generic shell
// command in its place.
//
// Usage: bun examples/dual-surface/terminal-and-browser.ts [output-dir]
// Requires: Xvfb running on :99, xterm, xdotool, scrot, ffmpeg, a Chrome
// binary, and AZURE_CUA_API_KEY (+ AZURE_CUA_BASE_URL) or OPENAI_API_KEY set.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { startChrome, waitForChromeReady } from "../../core/chrome-process";
import { startTerminal, waitForTerminalReady } from "../../core/terminal-process";
import { assembleGif, finalizeRecording, startRecording } from "../../core/recording";
import { saveOptimizedScreenshot } from "../../core/screenshot";
import { createVisionClient, visionJudge } from "../../core/vision";
import { focusTerminal } from "../../surfaces/terminal/focus";
import { navigateChromeTo } from "../../surfaces/webapp/navigate";

const DISPLAY_WIDTH = 1920;
const DISPLAY_HEIGHT = 1080;
const CDP_PORT = 9333;

async function main(): Promise<void> {
  const outputDir = process.argv[2] ?? "/tmp/agentprobe-dual-surface-output";
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

  // Declared before the try (and assigned inside it) so that if either
  // startRecording or startTerminal itself throws before the try block is
  // entered, the finally block below still runs and cleans up whichever of
  // the two DID start — otherwise a throw here would orphan a running
  // ffmpeg recorder (or xterm process) with nothing left to kill it.
  let recorder: Bun.Subprocess | undefined;
  let terminal: ReturnType<typeof startTerminal> | undefined;
  let chrome: Bun.Subprocess | undefined;
  try {
    recorder = startRecording({ outputDir, displayWidth: DISPLAY_WIDTH, displayHeight: DISPLAY_HEIGHT });
    terminal = startTerminal({
      cmd: "bash",
      args: ["-c", "for i in 1 2 3 4 5; do echo agentprobe dual-surface demo line $i; sleep 1; done"],
      outputDir,
      // Left half of a 1920x1080 display, in xterm's character-cell geometry.
      windowGeometry: "100x40+0+0"
    });

    const terminalWindowId = await waitForTerminalReady(terminal, { timeoutMs: 15_000 });
    console.log(`[dual-surface] terminal window ready: ${terminalWindowId}`);

    chrome = startChrome({
      chromeBin: process.env.CHROME_PATH ?? "google-chrome",
      userDataDir: "/tmp/agentprobe-dual-surface-chrome-profile",
      initialUrl: "about:blank",
      outputDir,
      cdpPort: CDP_PORT,
      // Right half of the same display, next to the terminal.
      windowPositionX: DISPLAY_WIDTH / 2,
      displayWidth: DISPLAY_WIDTH / 2,
      displayHeight: DISPLAY_HEIGHT
    });
    await waitForChromeReady({ cdpPort: CDP_PORT });
    console.log("[dual-surface] chrome window ready");

    await focusTerminal(terminalWindowId);
    await navigateChromeTo("https://example.com", { windowClass: "Chrome" });
    await Bun.sleep(1000);

    const shotPath = path.join(outputDir, "step-01-both-windows.png");
    await saveOptimizedScreenshot(shotPath, { displayWidth: DISPLAY_WIDTH, displayHeight: DISPLAY_HEIGHT });

    const judgement = await visionJudge(
      vision,
      shotPath,
      "Does this screenshot show a terminal window with readable text on one side AND a separate Chrome browser window on the other side, both visible at the same time?",
      { outputDir, label: "dual-surface" }
    );
    console.log(`[dual-surface] vision judge verdict=${judgement.verdict} evidence=${judgement.evidence}`);
    if (judgement.verdict !== "YES") {
      throw new Error(`vision judge rejected the dual-surface screenshot: ${judgement.evidence}`);
    }
  } finally {
    terminal?.process.kill();
    chrome?.kill();
    recorder?.kill();
    await recorder?.exited;
    // Re-assert +faststart via remux — killing the recorder can still leave
    // moov after mdat, which is why the video shows 0:00 in a viewer (issue #6).
    await finalizeRecording({ outputDir }).catch(() => {});
    await assembleGif({ outputDir }).catch(() => {});
  }

  console.log("[dual-surface] PASSED");
}

main().catch((error) => {
  console.error(`[dual-surface] FAILED: ${(error as Error).message}`);
  process.exit(1);
});
