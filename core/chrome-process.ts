// Chrome process lifecycle: launching a real (non-automation-flagged)
// branded Chrome with a CDP debugging port, and waiting for it to become
// ready.
//
// `startChrome` is extracted from vibebrowser's tests/cua/cws-visual-install.ts.
// No `--enable-automation`, no `--load-extension`/forcelist policy by default —
// this launches the literal browser a human would use; callers add whatever
// extra flags their scenario needs via `extraArgs`.
//
// `waitForChromeReady` is NEW convenience code written for this extraction
// (the source runner.ts used a bare `Bun.sleep(5000)` after launch) — it is
// not battle-tested the way the rest of this repo's extracted code is.

import path from "node:path";
import { getBrowserWsUrl } from "./cdp";

export type StartChromeOptions = {
  chromeBin: string;
  userDataDir: string;
  initialUrl: string;
  outputDir: string;
  cdpPort: number;
  displayWidth?: number; // default 1920
  displayHeight?: number; // default 1080
  windowPositionX?: number; // default 0
  windowPositionY?: number; // default 0
  /** Extra Chrome CLI flags appended before `initialUrl` (e.g. --load-extension=...). */
  extraArgs?: string[];
  /** Appended to the chrome-stdout/chrome-stderr log filenames, e.g. "-relaunch". */
  logSuffix?: string;
};

/**
 * Launch Chrome directly on `initialUrl` with a remote-debugging port. No
 * `--disable-background-networking` — scenarios that need a real network
 * fetch (e.g. an actual CRX download) depend on it working.
 * `--window-position` pins the OS window's origin so screen-space math from
 * later coordinate lookups is deterministic.
 */
export function startChrome(opts: StartChromeOptions): Bun.Subprocess {
  const {
    chromeBin,
    userDataDir,
    initialUrl,
    outputDir,
    cdpPort,
    displayWidth = 1920,
    displayHeight = 1080,
    windowPositionX = 0,
    windowPositionY = 0,
    extraArgs = [],
    logSuffix = ""
  } = opts;

  const chromeArgs = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-position=${windowPositionX},${windowPositionY}`,
    `--window-size=${displayWidth},${displayHeight}`,
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${cdpPort}`,
    "--remote-allow-origins=*",
    ...extraArgs,
    initialUrl
  ];

  return Bun.spawn([chromeBin, ...chromeArgs], {
    stdout: Bun.file(path.join(outputDir, `chrome-stdout${logSuffix}.log`)),
    stderr: Bun.file(path.join(outputDir, `chrome-stderr${logSuffix}.log`))
  });
}

/**
 * NEW convenience code (not extracted — neither source file contained this;
 * source runner.ts used a bare `Bun.sleep(5000)` after launch): poll Chrome's
 * CDP endpoint until it responds (bounded by `timeoutMs`), then sleep
 * `postReadySettleMs` for the initial page to render. Throws on timeout —
 * an unreachable CDP endpoint after launch is a real startup failure, and
 * proceeding silently would only defer the error to a more confusing place.
 * Matches `core/cdp.ts`'s `waitForCdpReady` semantics; this variant exists
 * for the post-ready settle sleep.
 */
export async function waitForChromeReady(opts: { cdpPort: number; timeoutMs?: number; postReadySettleMs?: number }): Promise<void> {
  const { cdpPort, timeoutMs = 20_000, postReadySettleMs = 2_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await getBrowserWsUrl(cdpPort);
      if (postReadySettleMs > 0) await Bun.sleep(postReadySettleMs);
      return;
    } catch {
      // Chrome not ready yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`[chrome-process] Chrome CDP on port ${cdpPort} did not respond within ${timeoutMs}ms`);
}
