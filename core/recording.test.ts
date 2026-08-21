// Regression coverage for AGE-745 / AGE-814: `startPageFrameCapture` must
// paint-gate each capture (when the page is evaluate-capable) and retry a
// blank/unpainted capture before giving up, instead of accepting whatever
// `page.screenshot()` returns on the first try. These are the two failure
// modes that let a Xvfb native-window-occlusion blip through as a silent
// blank frame in `webapp.stripe-checkout-visual-proof.test.ts` (see
// `core/paint.ts`'s `waitForPageOwnPaintSettle` and `core/blank-frame.ts`'s
// `captureBufferUntilPainted`).

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startPageFrameCapture, type ScreenshotCapable } from "./recording";
import { captureBufferUntilPainted } from "./blank-frame";
import { waitForPageOwnPaintSettle } from "./paint";

async function whitePngBuffer(): Promise<Buffer> {
  // 1x1 white PNG, upscaled at read-time isn't needed — bufferNearWhiteFraction
  // works on any PNG size. Use sharp to synthesize a deterministic 40x40
  // solid-color PNG instead of relying on a fragile literal, so the near-white
  // threshold math (>=240 greyscale) is unambiguous either way.
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .png()
    .toBuffer();
}

async function redPngBuffer(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 20, b: 20 } } })
    .png()
    .toBuffer();
}

describe("startPageFrameCapture — paint-gate + blank-frame retry wiring (AGE-745/AGE-814)", () => {
  test("retries a blank capture until the page reports painted content, then writes the real frame", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "agentprobe-recording-test-"));
    try {
      let screenshotCalls = 0;
      let evaluateCalls = 0;
      // Simulate: occluded for the first capture attempt (blank), then a
      // real frame from the 2nd attempt on — exactly the "one bad tick,
      // next tick recovers" shape observed under Xvfb occlusion.
      const page: ScreenshotCapable = {
        async screenshot() {
          screenshotCalls += 1;
          return screenshotCalls === 1 ? whitePngBuffer() : redPngBuffer();
        },
        async evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
          evaluateCalls += 1;
          // Real Playwright would run `fn` in-page; here we just prove the
          // paint gate is actually invoked (present in the wiring) without
          // depending on its exact return-value contract.
          return "painted" as unknown as T;
        }
      };

      const handle = startPageFrameCapture({ page, outputDir, intervalMs: 3_600_000 });
      const framePath = await handle.captureNamed("proof");

      expect(screenshotCalls).toBeGreaterThanOrEqual(2); // at least one retry happened
      expect(evaluateCalls).toBeGreaterThan(0); // paint gate was actually invoked

      const written = await readFile(framePath);
      const sharp = (await import("sharp")).default;
      const { data } = await sharp(written).greyscale().raw().toBuffer({ resolveWithObject: true });
      let white = 0;
      for (let i = 0; i < data.length; i++) if (data[i] >= 240) white++;
      const whiteFraction = white / data.length;
      expect(whiteFraction).toBeLessThan(0.5); // the *written* frame is the real (red), not the blank (white), capture
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("throws if every blank-frame retry attempt is still blank (does not silently accept a blank capture)", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "agentprobe-recording-test-"));
    try {
      const page: ScreenshotCapable = {
        async screenshot() {
          return whitePngBuffer(); // always blank — occlusion never clears
        }
      };

      const handle = startPageFrameCapture({ page, outputDir, intervalMs: 3_600_000, blankFrameAttempts: 2, blankFrameGuard: true, paintGate: false });
      await expect(handle.captureNamed("proof")).rejects.toThrow(/blank|near-white/i);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("skips the paint gate (no throw, no evaluate call) when the page has no evaluate()", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "agentprobe-recording-test-"));
    try {
      const page: ScreenshotCapable = {
        async screenshot() {
          return redPngBuffer();
        }
        // no `evaluate` — a bare test double / non-Playwright ScreenshotCapable
      };

      const handle = startPageFrameCapture({ page, outputDir, intervalMs: 3_600_000 });
      const framePath = await handle.captureNamed("proof");

      const written = await readFile(framePath);
      expect(written.length).toBeGreaterThan(0);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  // Regression for the live incident this bump surfaced (CI run 32493750171,
  // AGE-814): `captureNamed` failed with "Bun is not defined" and that throw
  // was swallowed, silently skipping the paint-gate/blank-frame retry and
  // shipping a genuinely blank stripe-checkout GIF as passing evidence.
  // `startPageFrameCapture` is imported directly (in-process, not via a
  // `bun <path>` CLI entrypoint) by plain-Node consumers (AgentPod's
  // vitest-driven `FrameRecorder`), so every function reachable from
  // `captureNamed` must not depend on the `Bun` global. `bun test` itself
  // can't catch this — `Bun` is always defined under the Bun runtime — so
  // this test deletes `globalThis.Bun` for the duration of the call to prove
  // the reachable path (`waitForPageOwnPaintSettle`, `captureBufferUntilPainted`)
  // is Node-safe.
  // Regression for the live incident this bump surfaced (CI run 32493750173,
  // AGE-814): `captureNamed` failed with "Bun is not defined" and that throw
  // was swallowed by `startPageFrameCapture`'s best-effort catch, silently
  // skipping the paint-gate/blank-frame retry and shipping a genuinely blank
  // stripe-checkout GIF as passing evidence. Both `waitForPageOwnPaintSettle`
  // and `captureBufferUntilPainted` are reachable in-process (not via a
  // `bun <path>` CLI entrypoint) from plain-Node consumers such as
  // AgentPod's vitest-driven `FrameRecorder`, so neither may depend on the
  // `Bun` global. `bun test` itself can't catch this directly (`Bun` is
  // always defined under the Bun runtime), so these tests patch `Bun.sleep`
  // to throw exactly the `ReferenceError: Bun is not defined` a bare
  // `Bun.sleep` reference throws under Node, and prove the retry path still
  // completes — i.e. it no longer calls `Bun.sleep` at all.
  test("captureBufferUntilPainted retries past a blank capture without calling Bun.sleep", async () => {
    const realSleep = Bun.sleep;
    try {
      // @ts-expect-error -- intentional monkey-patch for this assertion only
      Bun.sleep = () => {
        throw new ReferenceError("Bun is not defined");
      };

      let calls = 0;
      const { buf, whiteFraction } = await captureBufferUntilPainted(
        async () => {
          calls++;
          return calls === 1 ? whitePngBuffer() : redPngBuffer();
        },
        { attempts: 2, retryDelayMs: 5 }
      );

      expect(calls).toBe(2);
      expect(whiteFraction).toBeLessThan(0.995);
      expect(buf.length).toBeGreaterThan(0);
    } finally {
      Bun.sleep = realSleep;
    }
  });

  test("waitForPageOwnPaintSettle polls without calling Bun.sleep", async () => {
    const realSleep = Bun.sleep;
    try {
      // @ts-expect-error -- intentional monkey-patch for this assertion only
      Bun.sleep = () => {
        throw new ReferenceError("Bun is not defined");
      };

      let calls = 0;
      const page = {
        async evaluate() {
          calls++;
          // Force at least one poll iteration (and therefore one retry-delay
          // call) before reporting painted.
          return calls === 1 ? "readyState=loading" : "painted";
        }
      };

      await waitForPageOwnPaintSettle(page, "smoke", 2_000);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      Bun.sleep = realSleep;
    }
  });
});
