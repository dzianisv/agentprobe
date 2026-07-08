// Vision-based click targeting and vision-judge verdicts, backed by a real
// `xdotool` gesture (never CDP `Input.dispatchMouseEvent`).
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts. This module
// is the result of three falsified CDP-geometry-math approaches to computing
// a click's screen coordinate (documented in the source file's history):
// computing where a button "should" be from window/viewport geometry is
// fragile against Chrome's own variable chrome layout (tab strip, omnibox,
// infobars, promo bars). The fix: show a vision model a real full-screen
// `scrot` capture (screenshot pixels ARE screen pixels) and ask it to locate
// the described element directly; only the coordinate lookup changed, the
// click itself is still a real `xdotool mousemove` + `xdotool click`.
//
// Canvas-size rationale (kept verbatim): per OpenAI's documented tile-based
// image tokenization, `detail: "high"` images are scaled so the shortest
// side becomes 768px before the model reasons over them. Pinning
// `sendHeight` to exactly 768 makes that step an identity operation, so the
// canvas the model reasons over is provably the exact canvas that was sent —
// not an invisible second resize of it. `sendWidth` is kept close to a
// 1920x1080 aspect ratio for readability; the resize itself uses `fit:
// "fill"` (independent x/y scale factors), so the two axes' scale-back
// ratios are computed and logged separately and any aspect mismatch is
// harmless to correctness.

import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import sharp from "sharp";
import { type BlankFrameOptions, captureUntilPainted } from "./blank-frame";
import { saveCursorScreenshot, saveFullScreenshot } from "./screenshot";
import { xdotoolClick, xdotoolMouseMove } from "./xdotool";

export type VisionClient = { client: OpenAI; model: string };

const DEFAULT_SEND_WIDTH = 1366;
const DEFAULT_SEND_HEIGHT = 768;

export function createVisionClient(opts: { apiKey: string; baseURL?: string; model: string }): VisionClient {
  const clientOptions: ConstructorParameters<typeof OpenAI>[0] = { apiKey: opts.apiKey };
  if (opts.baseURL) clientOptions.baseURL = opts.baseURL;
  const client = new OpenAI(clientOptions);
  return { client, model: opts.model };
}

/**
 * Pull the plain-text answer out of a Responses API payload. Prefers the
 * SDK's `output_text` convenience field; falls back to manually walking
 * `output` for `message` items in case a given deployment/response shape
 * doesn't populate the convenience getter.
 */
export function extractOutputText(response: { output_text?: string; output?: unknown[] }): string {
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "message") continue;
    const content = Array.isArray(record.content) ? record.content : [];
    for (const c of content) {
      if (c && typeof c === "object" && (c as Record<string, unknown>).type === "output_text") {
        const t = (c as Record<string, unknown>).text;
        if (typeof t === "string") parts.push(t);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Extract a {x,y} point from the model's plain-text reply. Tolerates
 * markdown code fences and leading/trailing prose by grabbing the first
 * `{...}` substring rather than requiring the whole response to be JSON.
 */
export function parseClickPoint(text: string): { x: number; y: number } | undefined {
  const match = text.match(/\{[^{}]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const x = Number(parsed.x);
    const y = Number(parsed.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x: Math.round(x), y: Math.round(y) };
    }
  } catch {
    // fall through to undefined below
  }
  return undefined;
}

export type VisionLocateAndClickOptions = {
  outputDir: string;
  displayWidth: number;
  displayHeight: number;
  sendWidth?: number; // default 1366
  sendHeight?: number; // default 768
  blankGuard: BlankFrameOptions;
};

/**
 * Single-shot vision locate + real xdotool click. The screenshot sent to the
 * model is resized to a fixed, exactly-known `sendWidth`x`sendHeight` canvas;
 * the model's answer is scaled back up to real `displayWidth`x`displayHeight`
 * screen pixels before the xdotool gesture, using that exactly-known ratio.
 * Rejects blank/unpainted captures via `captureUntilPainted` before ever
 * asking the model (vision calls are expensive and a blank frame can only
 * produce a garbage answer).
 */
export async function visionLocateAndClick(
  vision: VisionClient,
  description: string,
  label: string,
  opts: VisionLocateAndClickOptions
): Promise<{ x: number; y: number }> {
  const sendWidth = opts.sendWidth ?? DEFAULT_SEND_WIDTH;
  const sendHeight = opts.sendHeight ?? DEFAULT_SEND_HEIGHT;
  const slug = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const rawShotPath = path.join(opts.outputDir, `vision-locate-${slug}-raw.png`);

  const paintedShotPath = await captureUntilPainted(async () => {
    await saveFullScreenshot(rawShotPath);
    return rawShotPath;
  }, { ...opts.blankGuard, label: opts.blankGuard.label ?? label });

  // The sent file IS the resized canvas — what's on disk in the artifact is
  // exactly what the model saw, no guessing. `fit: "fill"` stretches to the
  // exact target dimensions rather than cropping, so nothing outside the
  // frame is silently clipped even if the raw capture isn't precisely
  // displayWidth x displayHeight.
  const sentShotPath = path.join(opts.outputDir, `vision-locate-${slug}.png`);
  await sharp(paintedShotPath).resize(sendWidth, sendHeight, { fit: "fill" }).png().toFile(sentShotPath);
  const shotBase64 = (await readFile(sentShotPath)).toString("base64");

  const response = (await vision.client.responses.create({
    model: vision.model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `This is a ${sendWidth}x${sendHeight} screenshot of a real Chrome browser window. Find the exact center pixel of: ${description}. Respond with ONLY a JSON object of the form {"x": <integer>, "y": <integer>} in THIS image's own pixel coordinates (0-${sendWidth} horizontally, 0-${sendHeight} vertically) — no markdown, no code fences, no explanation, no other text.`
          },
          { type: "input_image", image_url: `data:image/png;base64,${shotBase64}`, detail: "high" }
        ]
      }
    ]
  })) as unknown as { output_text?: string; output?: unknown[] };

  const text = extractOutputText(response);
  const sentPoint = text ? parseClickPoint(text) : undefined;
  if (!sentPoint) {
    throw new Error(
      `visionLocateAndClick("${label}"): model response contained no parseable {x,y} point ` +
        `(description: ${description}, raw response text: ${JSON.stringify(text).slice(0, 300)})`
    );
  }

  const scaleX = opts.displayWidth / sendWidth;
  const scaleY = opts.displayHeight / sendHeight;
  const point = { x: Math.round(sentPoint.x * scaleX), y: Math.round(sentPoint.y * scaleY) };

  console.log(
    `[vision] vision-located "${label}": model answered (${sentPoint.x}, ${sentPoint.y}) ` +
      `on the ${sendWidth}x${sendHeight} sent canvas -> scaled by (${scaleX}, ${scaleY}) ` +
      `-> (${point.x}, ${point.y}) on the real ${opts.displayWidth}x${opts.displayHeight} screen (description: ${description})`
  );

  xdotoolMouseMove(point.x, point.y);
  await Bun.sleep(150);
  // Cheap sanity check, no longer load-bearing for correctness (the model's
  // click coordinate IS already in screen-pixel space) — kept because a real
  // X11 cursor glyph in the artifact is still useful ground truth if a run
  // fails for some other reason.
  const precheckShotPath = path.join(opts.outputDir, `${slug}-cursor-precheck.png`);
  await saveCursorScreenshot(precheckShotPath);
  xdotoolClick();
  console.log(`[vision] xdotool clicked "${label}" at (${point.x}, ${point.y}) (vision-located)`);
  return point;
}

export type VisionJudgeOptions = {
  outputDir: string;
  sendWidth?: number;
  sendHeight?: number;
  /** Distinguishes the sent-canvas artifact filename across multiple judge calls in one outputDir. Default "default". */
  label?: string;
};

/**
 * Independent CUA-style vision judge: given a screenshot, ask the vision
 * model — as a judge, not the actor — a yes/no `question` about what's
 * visible. Same send-canvas pipeline as `visionLocateAndClick` so the image
 * is legible to the model; the sent canvas is saved to the artifacts so what
 * the judge saw is inspectable. Any API/parse failure THROWS — a judge that
 * cannot run is a step failure, never a silent pass. Default-NO prompting:
 * the question is always suffixed with an explicit "default to NO" clause.
 */
export async function visionJudge(
  vision: VisionClient,
  screenshotPath: string,
  question: string,
  opts: VisionJudgeOptions
): Promise<{ verdict: "YES" | "NO"; evidence: string }> {
  const sendWidth = opts.sendWidth ?? DEFAULT_SEND_WIDTH;
  const sendHeight = opts.sendHeight ?? DEFAULT_SEND_HEIGHT;
  const label = opts.label ?? "default";
  const sentPath = path.join(opts.outputDir, `vision-judge-${label}.png`);
  await sharp(screenshotPath).resize(sendWidth, sendHeight, { fit: "fill" }).png().toFile(sentPath);
  const shotBase64 = (await readFile(sentPath)).toString("base64");

  const response = (await vision.client.responses.create({
    model: vision.model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${question} Answer ONLY {"verdict":"YES"|"NO","evidence":"<quote the visible text you base it on>"}. Default to NO if the answer is not clearly readable.`
          },
          { type: "input_image", image_url: `data:image/png;base64,${shotBase64}`, detail: "high" }
        ]
      }
    ]
  })) as unknown as { output_text?: string; output?: unknown[] };

  const text = extractOutputText(response);
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`visionJudge returned no parseable JSON verdict (raw: ${JSON.stringify(text).slice(0, 300)})`);
  }
  const parsed = JSON.parse(match[0]) as { verdict?: unknown; evidence?: unknown };
  const verdict = String(parsed.verdict ?? "").toUpperCase();
  if (verdict !== "YES" && verdict !== "NO") {
    throw new Error(`visionJudge verdict is neither YES nor NO (raw: ${JSON.stringify(text).slice(0, 300)})`);
  }
  return { verdict: verdict as "YES" | "NO", evidence: String(parsed.evidence ?? "") };
}
