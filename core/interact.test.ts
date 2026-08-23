// Regression coverage for `retryClickUntilVerified` (AGE-1311 / vibebrowser
// GH#1820 follow-on): a single vision-located click can be silently
// swallowed by a transient overlay stealing the pointer grab, the same class
// of bug already fixed for the sidepanel toolbar click in
// dzianisv/agentprobe#11 (`openAndAssertSidepanel`). This generalizes that
// fix — click, then poll a caller-supplied verify callback, retrying the
// click (not just the poll) if verification never lands.
//
// Tests call `retryClickUntilVerified` directly with injected
// dismiss/click/verify/screenshot fakes (no `mock.module`, which replaces a
// module process-wide for the whole `bun test` run and would leak into
// unrelated test files — mirrors the injected-`captureFn` pattern already
// used by `./blank-frame.test.ts`).

import { describe, expect, test } from "bun:test";

import { retryClickUntilVerified, type RetryClickFns } from "./interact";

function makeFns(overrides: Partial<RetryClickFns> & { verifiedAfterNthClick: number }) {
  let clickCalls = 0;
  let dismissCalls = 0;
  const shots: string[] = [];
  const fns: RetryClickFns = {
    dismissOverlay: () => {
      dismissCalls++;
    },
    click: async () => {
      clickCalls++;
      return { x: 100, y: 200 };
    },
    verify: async () => ({ ok: clickCalls >= overrides.verifiedAfterNthClick, detail: clickCalls >= overrides.verifiedAfterNthClick ? "true" : "false" }),
    saveFailureScreenshot: async (label: string) => {
      const path = `/tmp/out/${label}-verify-failed.png`;
      shots.push(path);
      return path;
    },
    ...overrides
  };
  return { fns, calls: () => ({ clickCalls, dismissCalls, shots }) };
}

// Tiny per-attempt poll budget so timing math stays fast and deterministic;
// `verify` above is instantaneous regardless (no real polling loop here).
const fastOpts = { minAttemptTimeoutMs: 1, pollIntervalMs: 1 };

describe("retryClickUntilVerified", () => {
  test("returns ok on the first attempt when verify is immediately truthy", async () => {
    const { fns, calls } = makeFns({ verifiedAfterNthClick: 1 });
    const result = await retryClickUntilVerified(2, "send-button", fns, fastOpts);
    expect(result.ok).toBe(true);
    expect(result.x).toBe(100);
    expect(result.y).toBe(200);
    expect(calls().clickCalls).toBe(1);
    expect(calls().dismissCalls).toBe(1);
  });

  test("retries the click (not just the poll) when the first click never verifies", async () => {
    const { fns, calls } = makeFns({ verifiedAfterNthClick: 2 });
    const result = await retryClickUntilVerified(2, "send-button", fns, { ...fastOpts, clickAttempts: 3 });
    expect(result.ok).toBe(true);
    expect(calls().clickCalls).toBe(2);
    expect(calls().dismissCalls).toBe(2);
  });

  test("fails closed with a diagnostic screenshot after exhausting all attempts", async () => {
    const { fns, calls } = makeFns({ verifiedAfterNthClick: Number.POSITIVE_INFINITY });
    const result = await retryClickUntilVerified(2, "send-button", fns, { ...fastOpts, clickAttempts: 3, outputDir: "/tmp/out" });
    expect(result.ok).toBe(false);
    expect(calls().clickCalls).toBe(3);
    expect(calls().shots.length).toBe(1);
    expect(calls().shots[0]).toContain("send-button-verify-failed.png");
    expect(result.detail).toContain("click not verified after 3 attempts");
  });

  test("omits the diagnostic screenshot when saveFailureScreenshot is not provided", async () => {
    const { fns, calls } = makeFns({ verifiedAfterNthClick: Number.POSITIVE_INFINITY, saveFailureScreenshot: undefined });
    const result = await retryClickUntilVerified(2, "send-button", fns, { ...fastOpts, clickAttempts: 2 });
    expect(result.ok).toBe(false);
    expect(calls().shots.length).toBe(0);
    expect(result.detail).not.toContain("Diagnostic shot");
  });
});
