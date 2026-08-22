// Regression coverage for AGE-1198 (recurrence of AGE-745, GH
// dzianisv/agentprobe#4272): captureUntilPainted / captureBufferUntilPainted
// previously called their capture function with no try/catch inside the
// retry loop. A thrown capture error (e.g. Playwright's
// `Protocol error (Page.captureScreenshot): Unable to capture screenshot`)
// escaped the loop on attempt 1 with zero retries instead of being retried
// like a near-white result. These tests assert a captureFn/screenshotFn that
// throws N-1 times then succeeds still returns successfully, and that
// exhausting all attempts on errors alone still throws.

import { describe, expect, test } from "bun:test";

import { captureBufferUntilPainted, captureUntilPainted, contentNearWhiteFraction } from "./blank-frame";

async function whitePngBuffer(): Promise<Buffer> {
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

describe("captureBufferUntilPainted — capture-error retry (AGE-1198)", () => {
  test("retries through N-1 thrown capture errors then returns the successful (non-blank) capture", async () => {
    let calls = 0;
    const captureFn = async () => {
      calls++;
      if (calls < 3) {
        throw new Error("Protocol error (Page.captureScreenshot): Unable to capture screenshot");
      }
      return redPngBuffer();
    };

    const result = await captureBufferUntilPainted(captureFn, { attempts: 3, retryDelayMs: 1 });
    expect(calls).toBe(3);
    expect(result.whiteFraction).toBeLessThan(0.995);
  });

  test("throws after exhausting all attempts on capture errors alone (no silent zero-retry escape)", async () => {
    let calls = 0;
    const captureFn = async () => {
      calls++;
      throw new Error("Protocol error (Page.captureScreenshot): Unable to capture screenshot");
    };

    await expect(captureBufferUntilPainted(captureFn, { attempts: 3, retryDelayMs: 1 })).rejects.toThrow(
      /capture still throwing/
    );
    expect(calls).toBe(3);
  });

  test("a single capture error still leaves room for a later near-white retry to also be honored", async () => {
    let calls = 0;
    const captureFn = async () => {
      calls++;
      if (calls === 1) throw new Error("Unable to capture screenshot");
      if (calls === 2) return whitePngBuffer(); // near-white, should retry
      return redPngBuffer();
    };

    const result = await captureBufferUntilPainted(captureFn, { attempts: 3, retryDelayMs: 1 });
    expect(calls).toBe(3);
    expect(result.whiteFraction).toBeLessThan(0.995);
  });
});

describe("captureUntilPainted — capture-error retry (AGE-1198)", () => {
  test("retries through a thrown screenshotFn error then returns the successful path", async () => {
    const sharp = (await import("sharp")).default;
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");

    const dir = await mkdtemp(path.join(tmpdir(), "agentprobe-blank-frame-test-"));
    const outPath = path.join(dir, "shot.png");

    let calls = 0;
    const screenshotFn = async () => {
      calls++;
      if (calls === 1) {
        throw new Error("Protocol error (Page.captureScreenshot): Unable to capture screenshot");
      }
      const buf = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 200, g: 20, b: 20 } } })
        .png()
        .toBuffer();
      await writeFile(outPath, buf);
      return outPath;
    };

    const result = await captureUntilPainted(screenshotFn, {
      contentTop: 0,
      contentBottomMargin: 0,
      whiteFraction: 0.995,
      width: 400,
      height: 400,
      attempts: 3,
      retryDelayMs: 1
    });
    expect(calls).toBe(2);
    expect(result).toBe(outPath);
    const frac = await contentNearWhiteFraction(outPath, {
      contentTop: 0,
      contentBottomMargin: 0,
      width: 400,
      height: 400
    });
    expect(frac).toBeLessThan(0.995);
  });

  test("throws after exhausting all attempts on screenshotFn errors alone", async () => {
    let calls = 0;
    const screenshotFn = async () => {
      calls++;
      throw new Error("Unable to capture screenshot");
    };

    await expect(
      captureUntilPainted(screenshotFn, {
        contentTop: 0,
        contentBottomMargin: 0,
        whiteFraction: 0.995,
        width: 400,
        height: 400,
        attempts: 3,
        retryDelayMs: 1
      })
    ).rejects.toThrow(/capture still throwing/);
    expect(calls).toBe(3);
  });
});
