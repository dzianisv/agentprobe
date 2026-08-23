// Regression coverage for `findReadyThenVisionClickAndVerify` (AGE-1311 /
// vibebrowser GH#1820 follow-on): a single vision-located click can be
// silently swallowed by a transient overlay stealing the pointer grab, the
// same class of bug already fixed for the sidepanel toolbar click in
// dzianisv/agentprobe#11 (`openAndAssertSidepanel`). This generalizes that
// fix — click, then poll a caller-supplied verify expression, retrying the
// click (not just the poll) if verification never lands.
//
// All CDP/vision/xdotool/screenshot side effects are mocked; these tests
// assert the retry/verify orchestration logic only. The verify mock is
// driven by `visionClickCalls` (not a fixed queue of poll results) so it is
// insensitive to exactly how many times a per-attempt poll loop ticks.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let visionClickCalls = 0;
let escapeKeyCalls = 0;
let cursorScreenshotPaths: string[] = [];
/** Verify-poll truthiness as a function of how many clicks have landed so far. */
let verifiedAfterNthClick = 1;

mock.module("./cdp", () => ({
  pollForElementReady: mock(async () => ({ x: 10, y: 10, width: 20, height: 20 })),
  cdpSend: mock(async () => ({ result: { value: visionClickCalls >= verifiedAfterNthClick } }))
}));

mock.module("./paint", () => ({
  waitForPaintSettle: mock(async () => undefined)
}));

mock.module("./vision", () => ({
  visionLocateAndClick: mock(async () => {
    visionClickCalls++;
    return { x: 100, y: 200 };
  })
}));

mock.module("./xdotool", () => ({
  xdotoolKey: mock((key: string) => {
    if (key === "Escape") escapeKeyCalls++;
  }),
  xdotoolType: mock(() => undefined)
}));

mock.module("./screenshot", () => ({
  saveCursorScreenshot: mock(async (path: string) => {
    cursorScreenshotPaths.push(path);
  })
}));

const { findReadyThenVisionClickAndVerify } = await import("./interact");

beforeEach(() => {
  visionClickCalls = 0;
  escapeKeyCalls = 0;
  cursorScreenshotPaths = [];
  verifiedAfterNthClick = 1;
});

afterEach(() => {
  mock.restore();
});

const ctx = { outputDir: "/tmp/out", displayWidth: 1366, displayHeight: 768 };
const noopVision = {} as never;
// Tiny per-attempt poll budget so a failing attempt's poll loop exits almost
// immediately instead of really waiting out a multi-second window.
const fastOpts = { minAttemptTimeoutMs: 1, pollIntervalMs: 1 };

describe("findReadyThenVisionClickAndVerify", () => {
  test("returns ok on the first attempt when verify is immediately truthy", async () => {
    verifiedAfterNthClick = 1; // truthy as soon as the first click lands
    const result = await findReadyThenVisionClickAndVerify(
      {} as never,
      "session-1",
      "() => ({found:true})",
      2,
      "send-button",
      noopVision,
      "the chat send button",
      ctx,
      "String(!!document.querySelector('[data-testid=stop-button]'))",
      fastOpts
    );
    expect(result.ok).toBe(true);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
    expect(visionClickCalls).toBe(1);
    expect(escapeKeyCalls).toBe(1);
  });

  test("retries the click (not just the poll) when the first click never verifies", async () => {
    verifiedAfterNthClick = 2; // only the second click's effect is observable
    const result = await findReadyThenVisionClickAndVerify(
      {} as never,
      "session-1",
      "() => ({found:true})",
      2,
      "send-button",
      noopVision,
      "the chat send button",
      ctx,
      "String(!!document.querySelector('[data-testid=stop-button]'))",
      { ...fastOpts, clickAttempts: 3 }
    );
    expect(result.ok).toBe(true);
    expect(visionClickCalls).toBe(2);
    expect(escapeKeyCalls).toBe(2);
  });

  test("fails closed with a diagnostic screenshot after exhausting all attempts", async () => {
    verifiedAfterNthClick = Number.POSITIVE_INFINITY; // never verifies
    const result = await findReadyThenVisionClickAndVerify(
      {} as never,
      "session-1",
      "() => ({found:true})",
      2,
      "send-button",
      noopVision,
      "the chat send button",
      ctx,
      "String(!!document.querySelector('[data-testid=stop-button]'))",
      { ...fastOpts, clickAttempts: 3, outputDir: "/tmp/out" }
    );
    expect(result.ok).toBe(false);
    expect(visionClickCalls).toBe(3);
    expect(cursorScreenshotPaths.length).toBe(1);
    expect(cursorScreenshotPaths[0]).toContain("send-button-verify-failed.png");
    expect(result.detail).toContain("click not verified after 3 attempts");
  });
});
