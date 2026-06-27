import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import OpenAI from "openai";
import sharp from "sharp";

type RunnerArgs = {
  extensionPath: string;
  testCase: string;
  outputDir: string;
  channel?: string;
  maxSteps: number;
};

type Verification = {
  // Yes/No question the verifier model is asked against the FINAL screenshot.
  // Anti-hallucination guard: if the loop reports TEST_PASSED but the verifier
  // answers NO, the final result is flipped to FAIL. This catches the failure
  // mode where the agent sat on a wrong page and emitted a fabricated success.
  prompt: string;
};

type PollOptions = {
  initialWaitMs?: number;
  intervalMs?: number;
  timeoutMs?: number;
};

type RawTestCase = {
  name?: string;
  instruction?: string;
  criteria?: string[];
  successCriteria?: string[];
  failureCriteria?: string[];
  extensionId?: string;
  maxSteps?: number;
  verification?: Verification;
  // If set, the runner CDP-types this prompt into the sidepanel chat input
  // and presses Send after auth completes. Bypasses CUA-vision typing which
  // is unreliable for small input fields. The CUA loop then only observes
  // the Co-Pilot's response.
  prompt?: string;
  pollOptions?: PollOptions;
  // Default duration for CUA `wait` actions when the model omits the ms field.
  // Use 30_000 (30 seconds) for long-running agent tests; default is 1_000 (1 second).
  defaultWaitMs?: number;
};

type TestCase = {
  name: string;
  instruction: string;
  successCriteria: string[];
  failureCriteria: string[];
  extensionId?: string;
  maxSteps?: number;
  verification?: Verification;
  prompt?: string;
  pollOptions?: PollOptions;
  defaultWaitMs?: number;
};

type ActionType =
  | "click"
  | "double_click"
  | "type"
  | "key"
  | "scroll"
  | "screenshot"
  | "drag"
  | "move"
  | "wait";

type ParsedAction = {
  type: ActionType;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  text?: string;
  key?: string;
  direction?: "up" | "down";
  amount?: number;
  ms?: number;
};

type ComputerCall = {
  callId: string;
  actions: ParsedAction[];
  pendingSafetyChecks?: Array<{ id: string; code?: string | null; message?: string | null }>;
};

type ResponseLike = {
  id?: string;
  output?: unknown[];
  output_text?: string;
};

const DISPLAY_WIDTH = 1920;
const DISPLAY_HEIGHT = 1080;
const CDN_EXTENSION_ID = "ajfjlohdpfgngdjfafhhcnpmijbbdgln";
const CWS_EXTENSION_ID = "djodpgokbmobeclicaicnnidccoinado";
const DEFAULT_EXTENSION_ID = CDN_EXTENSION_ID;
const DEFAULT_MAX_STEPS = 30;
const CHROME_USER_DATA_DIR = "/tmp/chrome-cua-profile";

// Per-test default for CUA `wait` actions where the model omits the ms field.
// Set from testCase.defaultWaitMs after loadTestCase().
let gWaitDefaultMs = 1_000;

function printHelp(): void {
  console.log(`CUA runner\n\nUsage:\n  bun tests/cua/runner.ts --extension-path <path> --test-case <name|path> --output-dir <dir> [--channel <cdn|cws>] [--max-steps <n>]\n\nRequired:\n  --extension-path   Absolute or relative path to unpacked extension directory\n  --test-case        Test case basename (e.g. google-oauth) or file path (.ts)\n  --output-dir       Directory for screenshots and log outputs\n\nOptional:\n  --channel          cdn or cws (also maps default extension ID when testcase has no extensionId)\n  --max-steps        Override maximum automation steps\n  --help             Print this help\n`);
}

function parseArgs(argv: string[]): RunnerArgs {
  const args: Partial<RunnerArgs> = {
    maxSteps: DEFAULT_MAX_STEPS
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    switch (key) {
      case "extension-path":
        args.extensionPath = value;
        break;
      case "test-case":
        args.testCase = value;
        break;
      case "output-dir":
        args.outputDir = value;
        break;
      case "channel":
        args.channel = value;
        break;
      case "max-steps": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid --max-steps value: ${value}`);
        }
        args.maxSteps = parsed;
        break;
      }
      default:
        throw new Error(`Unknown argument: --${key}`);
    }

    i += 1;
  }

  if (!args.extensionPath) {
    throw new Error("--extension-path is required");
  }
  if (!args.testCase) {
    throw new Error("--test-case is required");
  }
  if (!args.outputDir) {
    throw new Error("--output-dir is required");
  }

  return args as RunnerArgs;
}

function runCommand(command: string, cmdArgs: string[], allowFailure = false): string {
  const proc = Bun.spawnSync([command, ...cmdArgs], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const stdout = proc.stdout ? Buffer.from(proc.stdout).toString("utf8") : "";
  const stderr = proc.stderr ? Buffer.from(proc.stderr).toString("utf8") : "";

  if (proc.exitCode !== 0 && !allowFailure) {
    throw new Error(`${command} failed (${proc.exitCode})\n${stderr || stdout}`.trim());
  }

  return stdout.trim();
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return undefined;
}

function normalizeKeyToken(key: string): string {
  const map: Record<string, string> = {
    ctrl: "ctrl",
    control: "ctrl",
    cmd: "super",
    command: "super",
    option: "alt",
    alt: "alt",
    shift: "shift",
    enter: "Return",
    return: "Return",
    esc: "Escape",
    escape: "Escape",
    tab: "Tab",
    backspace: "BackSpace",
    delete: "Delete",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    space: "space"
  };
  return map[key.toLowerCase()] ?? key;
}

function normalizeKeyCombo(key: string): string {
  return key
    .split(/[+,]/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map(normalizeKeyToken)
    .join("+");
}

function coerceAction(raw: Record<string, unknown>): ParsedAction | undefined {
  const kind = String(raw.type ?? raw.action ?? raw.name ?? "").toLowerCase();
  if (!kind) {
    return undefined;
  }

  const coordArr = Array.isArray(raw.coordinate) ? (raw.coordinate as unknown[]) : undefined;
  const x = toNumber(raw.x ?? raw.clientX ?? raw.screenX ?? coordArr?.[0]);
  const y = toNumber(raw.y ?? raw.clientY ?? raw.screenY ?? coordArr?.[1]);

  if (kind === "click") {
    return { type: "click", x, y };
  }
  if (kind === "double_click" || kind === "doubleclick") {
    return { type: "double_click", x, y };
  }
  if (kind === "move" || kind === "mousemove") {
    return { type: "move", x, y };
  }
  if (kind === "drag") {
    const toX = toNumber(raw.toX ?? raw.endX ?? raw.targetX);
    const toY = toNumber(raw.toY ?? raw.endY ?? raw.targetY);
    return { type: "drag", x, y, toX, toY };
  }
  if (kind === "type" || kind === "input" || kind === "text") {
    const text = String(raw.text ?? raw.value ?? "");
    return { type: "type", text };
  }
  if (kind === "key" || kind === "keypress" || kind === "hotkey") {
    const keyValue = String(raw.key ?? raw.keys ?? "");
    return { type: "key", key: normalizeKeyCombo(keyValue) };
  }
  if (kind === "scroll") {
    const amount = toNumber(raw.amount ?? raw.deltaY ?? raw.pixels ?? 500) ?? 500;
    const direction =
      String(raw.direction ?? "").toLowerCase() === "up" || amount < 0 ? "up" : "down";
    return { type: "scroll", x, y, amount: Math.abs(amount), direction };
  }
  if (kind === "wait" || kind === "sleep") {
    const explicit = toNumber(raw.ms ?? raw.milliseconds ?? raw.seconds);
    return { type: "wait", ms: explicit !== undefined ? (explicit < 100 ? explicit * 1000 : explicit) : undefined };
  }
  if (kind === "screenshot") {
    return { type: "screenshot" };
  }

  return undefined;
}

function collectActions(payload: unknown): ParsedAction[] {
  const out: ParsedAction[] = [];

  const walk = (node: unknown): void => {
    if (!node) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }

    if (typeof node !== "object") {
      return;
    }

    const record = node as Record<string, unknown>;
    const maybe = coerceAction(record);
    if (maybe) {
      out.push(maybe);
    }

    if (record.action) {
      walk(record.action);
    }
    if (record.actions) {
      walk(record.actions);
    }
    if (record.arguments) {
      walk(record.arguments);
    }
    if (record.params) {
      walk(record.params);
    }
  };

  walk(payload);
  return out;
}

function extractComputerCalls(response: ResponseLike, step: number): ComputerCall[] {
  const calls: ComputerCall[] = [];
  let fallbackIndex = 1;

  for (const item of response.output ?? []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const type = String(record.type ?? "");
    if (type !== "computer_call" && !type.includes("computer")) {
      continue;
    }

    const callIdBase =
      String(record.call_id ?? record.callId ?? record.id ?? "").trim() ||
      `step-${step}-call-${fallbackIndex++}`;

    const pendingSafetyChecks = Array.isArray(record.pending_safety_checks)
      ? (record.pending_safety_checks as Array<{ id: string; code?: string | null; message?: string | null }>)
      : [];

    console.log(
      `[runner] computer_call id=${callIdBase} action=${JSON.stringify(record.action ?? "(none)")} pending_safety_checks=${pendingSafetyChecks.length}`
    );
    const debugRecord: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      debugRecord[k] = typeof v === "string" && v.length > 200 ? `[${v.length}chars]` : v;
    }
    console.log(`[runner] computer_call raw: ${JSON.stringify(debugRecord)}`);

    const actions = collectActions(record.action ?? record.actions ?? record);
    if (actions.length === 0) {
      // Must still provide tool output — screenshot keeps the turn alive without executing anything
      console.log(`[runner] WARNING: no parseable actions in call ${callIdBase}; using screenshot fallback`);
      calls.push({ callId: callIdBase, actions: [{ type: "screenshot" }], pendingSafetyChecks });
      continue;
    }

    // Keep one ComputerCall per Azure call_id — splitting with synthetic suffixes breaks the API
    calls.push({ callId: callIdBase, actions, pendingSafetyChecks });
  }

  return calls;
}

async function saveOptimizedScreenshot(targetFile: string): Promise<string> {
  const rawFile = targetFile.replace(/\.png$/, "-raw.png");
  runCommand("scrot", [rawFile]);

  await sharp(rawFile)
    .resize(DISPLAY_WIDTH, DISPLAY_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(targetFile);

  const data = await readFile(targetFile);
  return data.toString("base64");
}

// Runner-side phase screenshot counter. CUA-loop screenshots use the
// step-NN-aN pattern; runner phases (warmup, pin, sidepanel-open, sign-in,
// prompt-send, post-auth, etc.) are captured into stage-NN-{phase}.png so
// they sort BEFORE step-NN in lexicographic order and end up at the start
// of the assembled demo GIF / video timeline.
let phaseScreenshotCounter = 0;
async function capturePhaseScreenshot(outputDir: string, phase: string): Promise<void> {
  try {
    const safe = phase.replace(/[^a-z0-9-]+/gi, "-").toLowerCase().slice(0, 40);
    const idx = String(phaseScreenshotCounter++).padStart(2, "0");
    await saveOptimizedScreenshot(path.join(outputDir, `stage-${idx}-${safe}.png`));
  } catch (err) {
    console.warn(`[runner] capturePhaseScreenshot(${phase}) failed: ${(err as Error).message}`);
  }
}

async function executeAction(action: ParsedAction, actionLabel: string, outputDir: string): Promise<string> {
  switch (action.type) {
    case "move": {
      if (action.x === undefined || action.y === undefined) {
        throw new Error("move requires x and y");
      }
      runCommand("xdotool", ["mousemove", String(action.x), String(action.y)]);
      return `moved mouse to (${action.x}, ${action.y})`;
    }
    case "click": {
      if (action.x !== undefined && action.y !== undefined) {
        runCommand("xdotool", ["mousemove", String(action.x), String(action.y)]);
      }
      runCommand("xdotool", ["click", "1"]);
      return `clicked at (${action.x ?? "current"}, ${action.y ?? "current"})`;
    }
    case "double_click": {
      if (action.x !== undefined && action.y !== undefined) {
        runCommand("xdotool", ["mousemove", String(action.x), String(action.y)]);
      }
      runCommand("xdotool", ["click", "--repeat", "2", "--delay", "120", "1"]);
      return `double clicked at (${action.x ?? "current"}, ${action.y ?? "current"})`;
    }
    case "type": {
      if (!action.text) {
        throw new Error("type action requires text");
      }
      runCommand("xdotool", ["type", "--delay", "25", "--", action.text]);
      return `typed ${action.text.length} chars`;
    }
    case "key": {
      if (!action.key) {
        throw new Error("key action requires key");
      }
      runCommand("xdotool", ["key", "--clearmodifiers", normalizeKeyCombo(action.key)]);
      return `pressed key ${action.key}`;
    }
    case "scroll": {
      if (action.x !== undefined && action.y !== undefined) {
        runCommand("xdotool", ["mousemove", String(action.x), String(action.y)]);
      }
      const steps = Math.max(1, Math.min(20, Math.round((action.amount ?? 500) / 120)));
      const button = action.direction === "up" ? "4" : "5";
      runCommand("xdotool", ["click", "--repeat", String(steps), button]);
      return `scrolled ${action.direction ?? "down"} (${steps} steps)`;
    }
    case "drag": {
      if (
        action.x === undefined ||
        action.y === undefined ||
        action.toX === undefined ||
        action.toY === undefined
      ) {
        throw new Error("drag requires x, y, toX, toY");
      }
      runCommand("xdotool", [
        "mousemove",
        String(action.x),
        String(action.y),
        "mousedown",
        "1",
        "mousemove",
        "--sync",
        String(action.toX),
        String(action.toY),
        "mouseup",
        "1"
      ]);
      return `dragged (${action.x}, ${action.y}) -> (${action.toX}, ${action.toY})`;
    }
    case "wait": {
      const waitMs = Math.max(100, Math.min(30_000, action.ms ?? gWaitDefaultMs));
      await Bun.sleep(waitMs);
      return `waited ${waitMs}ms`;
    }
    case "screenshot": {
      const file = path.join(outputDir, `${actionLabel}-action-screenshot.png`);
      await saveOptimizedScreenshot(file);
      return `captured screenshot ${path.basename(file)}`;
    }
    default:
      throw new Error(`Unsupported action ${(action as { type: string }).type}`);
  }
}

function getResponseText(response: ResponseLike): string {
  const text = String(response.output_text ?? "").trim();
  if (text) {
    return text;
  }
  return JSON.stringify(response.output ?? []);
}

function determineCompletion(response: ResponseLike, executedActions: number): { done: boolean; success: boolean; reason: string } {
  const outputText = getResponseText(response).trim();
  const normalized = outputText.toLowerCase();

  // Explicit signals checked against full output text
  if (normalized.includes("test_passed")) {
    return { done: true, success: true, reason: outputText || "Model reported TEST_PASSED" };
  }
  if (normalized.includes("test_failed")) {
    return { done: true, success: false, reason: outputText || "Model reported TEST_FAILED" };
  }

  // Fuzzy checks ONLY against real prose (output_text), NOT JSON-serialised computer_call arrays.
  // When the model makes a tool call, output_text is empty and getResponseText falls back to
  // JSON.stringify(output) which contains "status":"completed" — triggering a false positive.
  const proseText = String(response.output_text ?? "").trim();
  if (proseText) {
    if (/(success|completed|done)/i.test(proseText) && !/(not\s+done|incomplete)/i.test(proseText)) {
      return { done: true, success: true, reason: proseText };
    }
    if (/(failure|unable|blocked|error)/i.test(proseText)) {
      return { done: true, success: false, reason: proseText };
    }
  }

  // Model returned no tool calls and has prose — treat as final answer
  if (executedActions === 0 && proseText.length > 0) {
    return {
      done: true,
      success: !/(fail|error|unable|blocked)/i.test(proseText),
      reason: proseText
    };
  }

  return { done: false, success: false, reason: "continuing" };
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveTestCasePath(spec: string): Promise<string> {
  const casesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases");
  const cwd = process.cwd();
  const direct = path.isAbsolute(spec) ? spec : path.resolve(cwd, spec);

  if (await fileExists(direct)) {
    return direct;
  }

  const withExt = spec.endsWith(".ts") ? spec : `${spec}.ts`;
  const byBasename = path.join(casesDir, path.basename(withExt));
  if (await fileExists(byBasename)) {
    return byBasename;
  }

  throw new Error(`Test case not found: ${spec}`);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).filter((entry) => entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function normalizeTestCase(raw: RawTestCase, resolvedPath: string): TestCase {
  const inferredName = path.basename(resolvedPath, path.extname(resolvedPath));
  const instruction = String(raw.instruction ?? "").trim();
  if (!instruction) {
    throw new Error(`Test case ${resolvedPath} must define instruction`);
  }

  return {
    name: String(raw.name ?? inferredName),
    instruction,
    successCriteria: toStringArray(raw.successCriteria ?? raw.criteria),
    failureCriteria: toStringArray(raw.failureCriteria),
    extensionId: raw.extensionId,
    maxSteps: toNumber(raw.maxSteps),
    verification: raw.verification,
    prompt: raw.prompt,
    pollOptions: raw.pollOptions,
    defaultWaitMs: toNumber(raw.defaultWaitMs)
  };
}

type VerificationResult = {
  passed: boolean;
  raw: string;
  evidence: string;
  error?: string;
};

async function verifyResult(
  client: OpenAI,
  model: string,
  verification: Verification,
  outputDir: string
): Promise<VerificationResult> {
  // Fresh screenshot — NOT the last loop screenshot. The agent may have
  // emitted TEST_PASSED while looking at a wrong page (e.g. Gmail) and the
  // last loop screenshot would also show that wrong page. A fresh capture
  // here is what the verifier actually sees.
  const screenshotPath = path.join(outputDir, "verification-screenshot.png");
  const b64 = await saveOptimizedScreenshot(screenshotPath);

  const result: VerificationResult = {
    passed: false,
    raw: "",
    evidence: ""
  };

  try {
    const response = (await client.responses.create({
      model,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: verification.prompt },
            { type: "input_image", image_url: `data:image/png;base64,${b64}` }
          ]
        }
      ]
    })) as unknown as ResponseLike;

    result.raw = String(response.output_text ?? "").trim();
    result.passed = result.raw.toUpperCase().startsWith("YES");
    result.evidence = result.raw.length > 4 ? result.raw.slice(3).trim().replace(/^[.\-:\s]+/, "") : result.raw;
  } catch (err) {
    // Verification API failure must FAIL the test, not silently pass.
    result.passed = false;
    result.error = (err as Error).message;
  }

  await writeFile(
    path.join(outputDir, "verification.json"),
    JSON.stringify(result, null, 2),
    "utf8"
  );
  console.log(`[verify] result=${result.passed ? "PASS" : "FAIL"} -- ${result.evidence || result.error || result.raw}`);
  return result;
}

/**
 * Runner-driven response polling. Used when the test case ships a `prompt`
 * (so the runner is in charge of the chat input) and a `verification.prompt`
 * (so we have a way to score the screenshot). The CUA model has its own
 * impatience — iter 29 gave up after ~85s instead of waiting the instructed
 * 360s. Running the verifier loop on the runner side is deterministic and
 * cheap (~$0.01/poll × ~8 polls = ~$0.08 worst case).
 *
 * Returns the FIRST passing verification result, or the LAST failing result
 * if the timeout is exhausted. Each poll overwrites verification.json /
 * verification-screenshot.png so the final artifact reflects the final state.
 */
async function pollVerifierUntilResponse(
  client: OpenAI,
  model: string,
  verification: Verification,
  outputDir: string,
  options: { initialWaitMs: number; intervalMs: number; timeoutMs: number }
): Promise<VerificationResult | null> {
  const { initialWaitMs, intervalMs, timeoutMs } = options;
  console.log(`[poll] initial wait ${Math.round(initialWaitMs / 1000)}s before first verify...`);
  await Bun.sleep(initialWaitMs);

  const start = Date.now();
  let lastResult: VerificationResult | null = null;
  let pollIndex = 0;
  while (Date.now() - start < timeoutMs) {
    pollIndex += 1;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[poll] verify attempt #${pollIndex} (elapsed ${elapsed}s)...`);
    lastResult = await verifyResult(client, model, verification, outputDir);
    if (lastResult.passed) {
      console.log(`[poll] verifier YES at attempt #${pollIndex} after ${elapsed}s`);
      return lastResult;
    }
    if (Date.now() - start + intervalMs >= timeoutMs) break;
    await Bun.sleep(intervalMs);
  }
  const totalElapsed = Math.round((Date.now() - start) / 1000);
  console.log(`[poll] verifier never passed after ${pollIndex} attempts / ${totalElapsed}s`);
  return lastResult;
}

function hasStringInstruction(value: unknown): value is RawTestCase & { instruction: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return typeof (value as RawTestCase).instruction === "string";
}

async function loadTestCase(spec: string): Promise<TestCase> {
  const resolvedPath = await resolveTestCasePath(spec);
  const module = (await import(pathToFileURL(resolvedPath).href)) as {
    default?: RawTestCase;
    googleOAuthTest?: RawTestCase;
  } & Record<string, unknown>;
  const namedCandidate = Object.values(module).find(hasStringInstruction);
  const candidate = module.default ?? module.googleOAuthTest ?? namedCandidate;

  if (!candidate) {
    throw new Error(`Test case ${resolvedPath} must export a test object`);
  }

  return normalizeTestCase(candidate, resolvedPath);
}

function resolveExtensionId(testCase: TestCase, channel?: string): string {
  if (process.env.CUA_EXTENSION_ID) {
    return process.env.CUA_EXTENSION_ID;
  }
  if (testCase.extensionId) {
    return testCase.extensionId;
  }

  const normalizedChannel = String(channel ?? "").toLowerCase();
  if (normalizedChannel === "cws") {
    return CWS_EXTENSION_ID;
  }
  if (normalizedChannel === "cdn") {
    return CDN_EXTENSION_ID;
  }

  return DEFAULT_EXTENSION_ID;
}

function startRecording(outputDir: string): Bun.Subprocess {
  return Bun.spawn(
    [
      "ffmpeg", "-y",
      "-f", "x11grab",
      "-video_size", `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`,
      "-framerate", "30",
      "-i", ":99",
      "-c:v", "libx264",
      "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      path.join(outputDir, "recording.mp4")
    ],
    {
      stdout: "ignore",
      stderr: Bun.file(path.join(outputDir, "ffmpeg-recorder.log"))
    }
  );
}

async function assembleGif(outputDir: string): Promise<void> {
  const files = await readdir(outputDir);
  // Include BOTH stage-NN-{phase}.png (runner-driven phases: warmup, pin,
  // sidepanel-open, sign-in, prompt-send, post-auth, verify) AND step-NN
  // (CUA-loop steps). Sort lexicographically — "stage-" < "step-" so the
  // runner phases play first in the demo, then the CUA loop.
  const pngs = files
    .filter(f => /^(stage|step)-\d+.*\.png$/.test(f))
    .sort()
    .map(f => path.join(outputDir, f));

  if (pngs.length === 0) return;

  // concat demuxer file: each frame shown for 1.5 s; last file repeated without duration
  const lines: string[] = [];
  for (const p of pngs) {
    lines.push(`file '${p}'`);
    lines.push("duration 1.5");
  }
  lines.push(`file '${pngs[pngs.length - 1]}'`);
  const listPath = path.join(outputDir, "frames.txt");
  await writeFile(listPath, lines.join("\n"));

  const palettePath = path.join(outputDir, "palette.png");
  const gifPath = path.join(outputDir, "demo.gif");

  // Pass 1: generate optimised palette
  const pass1 = Bun.spawn(
    [
      "ffmpeg", "-y", "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-vf", "scale=960:-2:flags=lanczos,palettegen=max_colors=256:stats_mode=diff",
      palettePath
    ],
    { stdout: "ignore", stderr: "ignore" }
  );
  await pass1.exited;

  // Pass 2: encode GIF with palette
  const pass2 = Bun.spawn(
    [
      "ffmpeg", "-y", "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-i", palettePath,
      "-lavfi", "scale=960:-2:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer",
      gifPath
    ],
    { stdout: "ignore", stderr: "ignore" }
  );
  await pass2.exited;
}

async function computeExtensionIdFromManifest(extensionPath: string): Promise<string | undefined> {
  try {
    const manifestPath = path.join(extensionPath, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const key = manifest.key;
    if (typeof key !== "string" || !key.trim()) return undefined;
    const keyBytes = Buffer.from(key.replace(/\s+/g, ""), "base64");
    const hash = createHash("sha256").update(keyBytes).digest();
    let id = "";
    for (let i = 0; i < 16; i++) {
      id += String.fromCharCode(97 + (hash[i] >> 4));
      id += String.fromCharCode(97 + (hash[i] & 0x0f));
    }
    console.log(`[runner] Extension ID from manifest key: ${id}`);
    return id;
  } catch {
    return undefined;
  }
}

/**
 * Pin the extension to the toolbar by merging into the Chrome Default
 * Preferences file before main Chrome launch. Chrome 142+ (CFT 149) routes
 * the puzzle-piece icon click to chrome://extensions instead of a dropdown,
 * so the "click puzzle → click Vibe entry" path no longer works. Pinning
 * the extension makes its icon appear as a direct, single-click target in
 * the toolbar.
 *
 * Must be called AFTER the warmup Chrome run (which creates Preferences)
 * and BEFORE the main Chrome launch (which reads Preferences).
 * Handles file-not-exists and JSON parse errors gracefully.
 */
async function pinExtensionViaPreferences(extensionId: string): Promise<boolean> {
  const prefsPath = path.join(CHROME_USER_DATA_DIR, "Default", "Preferences");
  try {
    const raw = await readFile(prefsPath, "utf8");
    const prefs = JSON.parse(raw) as Record<string, unknown>;
    const extensions = (prefs.extensions as Record<string, unknown>) ?? {};
    const pinned = new Set<string>(Array.isArray(extensions.pinned_extensions) ? (extensions.pinned_extensions as string[]) : []);
    pinned.add(extensionId);
    extensions.pinned_extensions = Array.from(pinned);
    prefs.extensions = extensions;
    await writeFile(prefsPath, JSON.stringify(prefs), "utf8");
    console.log(`[runner] Pinned ${extensionId} via Preferences (${pinned.size} pinned total)`);
    return true;
  } catch (err) {
    console.log(`[runner] pinExtensionViaPreferences failed: ${(err as Error).message}`);
    return false;
  }
}

async function detectExtensionId(userDataDir: string, extensionPath: string, maxWaitMs = 20000): Promise<string | undefined> {
  const prefsPath = path.join(userDataDir, "Default", "Preferences");
  const normTarget = extensionPath.replace(/\/+$/, "");
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const raw = await readFile(prefsPath, "utf8");
      const prefs = JSON.parse(raw);
      const settings = prefs?.extensions?.settings ?? {};
      const candidates = Object.entries(settings).filter(([id]) => /^[a-p]{32}$/.test(id));

      if (candidates.length > 0) {
        for (const [id, ext] of candidates) {
          console.log(
            `[runner] ext candidate: id=${id} path=${(ext as any)?.path ?? "?"} location=${(ext as any)?.location ?? "?"}`
          );
        }

        // Phase 1: exact normalized path match
        for (const [id, ext] of candidates) {
          const extPath = String((ext as any)?.path ?? "").replace(/\/+$/, "");
          if (extPath === normTarget) {
            console.log(`[runner] Extension ID by path match: ${id}`);
            return id;
          }
        }

        // Phase 2: UNPACKED (location=3) set by Chrome for --load-extension in developer mode
        for (const [id, ext] of candidates) {
          if ((ext as any)?.location === 3) {
            console.log(`[runner] Extension ID by UNPACKED location (3): ${id} path=${(ext as any)?.path ?? "?"}`);
            return id;
          }
        }

        // Phase 3: path starts with our target (handles version sub-dirs Chrome may append)
        for (const [id, ext] of candidates) {
          const extPath = String((ext as any)?.path ?? "").replace(/\/+$/, "");
          if (extPath.startsWith(normTarget)) {
            console.log(`[runner] Extension ID by path prefix match: ${id}`);
            return id;
          }
        }
      }
    } catch {
      // Preferences not created yet or not parseable — keep polling
    }
    await Bun.sleep(500);
  }
  console.log(`[runner] detectExtensionId: no match after ${maxWaitMs}ms for path=${normTarget}`);
  return undefined;
}

async function navigateChromeTo(url: string): Promise<void> {
  const focus = Bun.spawn(
    ["xdotool", "search", "--sync", "--onlyvisible", "--class", "Chrome", "windowfocus"],
    { stdout: "ignore", stderr: "ignore" }
  );
  await focus.exited;
  await Bun.sleep(300);
  const openBar = Bun.spawn(["xdotool", "key", "--clearmodifiers", "ctrl+l"], { stdout: "ignore", stderr: "ignore" });
  await openBar.exited;
  await Bun.sleep(200);
  const typeUrl = Bun.spawn(["xdotool", "type", "--clearmodifiers", url], { stdout: "ignore", stderr: "ignore" });
  await typeUrl.exited;
  await Bun.sleep(100);
  const enter = Bun.spawn(["xdotool", "key", "Return"], { stdout: "ignore", stderr: "ignore" });
  await enter.exited;
}

function startChrome(extensionPath: string, initialUrl = "about:blank"): Bun.Subprocess {
  const chromeArgs = [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-features=Translate,OptimizationGuideModelDownloading",
    "--window-size=1920,1080",
    `--user-data-dir=${CHROME_USER_DATA_DIR}`,
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
    // Remote debugging port so we can programmatically interact with the
    // extension via CDP (seed storage, set panel behavior, open sidepanel).
    "--remote-debugging-port=9222",
    "--remote-allow-origins=*",
    initialUrl
  ];

  return Bun.spawn(["google-chrome", ...chromeArgs], {
    stdout: "pipe",
    stderr: "pipe"
  });
}

const CDP_PORT = 9222;

type CdpTarget = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
};

async function openCdpWs(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("CDP ws timeout"));
    }, 5000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(t);
      reject(new Error(`CDP ws error: ${String((e as ErrorEvent).message ?? e)}`));
    });
  });
}

async function cdpSend(ws: WebSocket, id: number, method: string, params: unknown): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`CDP ${method} timeout`)), 10000);
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== id) return;
      ws.removeEventListener("message", handler);
      clearTimeout(t);
      if (msg.error) {
        reject(new Error(`CDP ${method}: ${msg.error.message}`));
      } else {
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Configure chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})
 * via CDP so that a single real X11 click on the action icon (delivered by
 * xdotool) opens the sidepanel without extra steps. Must be called AFTER
 * Chrome starts (SW is registered) and BEFORE openSidepanelViaXdotool.
 */
async function openSidepanelViaCdp(extensionId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = (await targetsRes.json()) as CdpTarget[];

      const swTarget = targets.find(
        (t) =>
          (t.type === "service_worker" || t.type === "background_page") &&
          t.url.includes(extensionId)
      );

      if (!swTarget) {
        await Bun.sleep(500);
        continue;
      }

      const ws = await openCdpWs(swTarget.webSocketDebuggerUrl);
      try {
        // chrome.sidePanel.open() needs a user gesture which CDP cannot
        // synthesize for the SW context. Instead, set the extension's
        // panel behavior so any subsequent click on the action icon
        // (xdotool counts as a real gesture from Chrome's POV) opens the
        // sidepanel. setPanelBehavior does NOT require a gesture.
        const setRaw = await cdpSend(ws, 1, "Runtime.evaluate", {
          expression: `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).then(() => 'ok').catch(e => 'err: ' + (e && e.message || String(e)))`,
          awaitPromise: true,
          returnByValue: true
        });
        const setResult = (setRaw as { result?: { result?: { value?: string } } })?.result?.result?.value;
        console.log(`[runner] CDP chrome.sidePanel.setPanelBehavior → ${setResult}`);
        return setResult === "ok";
      } finally {
        ws.close();
      }
    } catch (err) {
      console.log(`[runner] CDP attempt ${attempt + 1} failed: ${(err as Error).message}`);
      await Bun.sleep(500);
    }
  }
  console.log(`[runner] CDP openSidepanel: gave up after 20 attempts`);
  return false;
}

/**
 * Open the Vibe sidepanel by clicking the PINNED Vibe toolbar icon via
 * xdotool. After pinExtensionViaPreferences runs, Vibe is at the rightmost
 * pinned position. xdotool dispatches a real X11 user gesture, satisfying
 * chrome.sidePanel.open()'s gesture requirement (combined with
 * setPanelBehavior({openPanelOnActionClick: true})).
 *
 * Layout: pinned extension icons sit at y=73 in 1920x1080. With one
 * pinned extension, its icon is at approximately x=1768.
 */
async function openSidepanelViaXdotool(extensionId: string): Promise<boolean> {
  const PINNED_X = 1768;
  const PINNED_Y = 73;
  console.log(`[runner] xdotool: clicking pinned Vibe icon at (${PINNED_X}, ${PINNED_Y})`);
  try {
    runCommand("xdotool", ["mousemove", String(PINNED_X), String(PINNED_Y)]);
    await Bun.sleep(200);
    runCommand("xdotool", ["click", "1"]);
    await Bun.sleep(2000);

    // Confirm sidepanel opened by checking CDP target list for the sidepanel page URL.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      try {
        const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
        const targets = (await targetsRes.json()) as CdpTarget[];
        const sidepanel = targets.find(
          (t) =>
            t.url.includes(extensionId) &&
            t.url.includes("sidepanel")
        );
        if (sidepanel) {
          console.log(`[runner] sidepanel open: ${sidepanel.url}`);
          return true;
        }
      } catch {
        // CDP transient; retry
      }
      await Bun.sleep(500);
    }
    console.log("[runner] xdotool click delivered but sidepanel target not detected via CDP");
    return false;
  } catch (err) {
    console.log(`[runner] xdotool sidepanel-open failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Pre-seed extension storage so isExtensionConfigured() returns true.
 * Without this, every CI run is a fresh install + unconfigured state, which
 * triggers chrome.runtime.onInstalled → openSettingsPage(). The auto-opened
 * settings tab distracts the CUA model.
 *
 * Setting vibe.apiKey.openai + vibe.model makes getAIConfiguration() return
 * non-null, which makes isExtensionConfigured() return true, which makes
 * onInstalled skip the settings page open. Sidepanel still shows sign-in UI
 * for user auth — that's the real test target.
 *
 * kv parameter allows callers to override the seeded key/value pairs.
 */
async function seedExtensionStorage(extId: string, kv?: Record<string, string>): Promise<boolean> {
  const storageEntries = kv ?? {
    "vibe.apiKey.openai": "test-placeholder-key",
    "vibe.model": "openai:gpt-5-mini"
  };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = (await targetsRes.json()) as CdpTarget[];
      const swTarget = targets.find(
        (t) =>
          (t.type === "service_worker" || t.type === "background_page") &&
          t.url.includes(extId)
      );
      if (!swTarget) {
        await Bun.sleep(500);
        continue;
      }
      const ws = await openCdpWs(swTarget.webSocketDebuggerUrl);
      try {
        const setRaw = await cdpSend(ws, 1, "Runtime.evaluate", {
          expression: `chrome.storage.local.set(${JSON.stringify(storageEntries)}).then(() => 'ok').catch(e => 'err: ' + (e && e.message || String(e)))`,
          awaitPromise: true,
          returnByValue: true
        });
        const result = (setRaw as { result?: { result?: { value?: string } } })?.result?.result?.value;
        console.log(`[runner] CDP seed extension storage → ${result}`);
        return result === "ok";
      } finally {
        ws.close();
      }
    } catch (err) {
      console.log(`[runner] seed storage attempt ${attempt + 1} failed: ${(err as Error).message}`);
      await Bun.sleep(500);
    }
  }
  console.log(`[runner] seed storage gave up after 20 attempts`);
  return false;
}

/**
 * Watch CDP target list for the Vibe Portal sign-in tab and fill the form
 * programmatically via Runtime.evaluate. The portal page is a React form;
 * direct .value assignment will NOT register with React, so the JS uses
 * the native input setter + dispatches a real 'input' event so React picks
 * up the new value before form submission.
 *
 * Without this, the CUA model has to vision-find tiny portal inputs at
 * arbitrary coordinates and routinely misclicks. CDP fill is deterministic
 * and avoids vision entirely for the sign-in path. The actual copilot
 * interaction afterwards remains CUA.
 *
 * Returns true once submit was clicked successfully (does not wait for
 * the OAuth redirect — caller polls for that via the extension state).
 * Does not log the password.
 */
async function autoFillPortalSignIn(email: string, password: string, timeoutMs = 300_000): Promise<boolean> {
  // Match both prod (portal.vibebrowser.app) and dev (portal-dev.api.vibebrowser.app)
  // portal auth pages. The extension's portal URL depends on its build env
  // (build:extension:dev vs prod) — see lib/shared/vibe-endpoints.json.
  const portalHostPattern = /(portal\.vibebrowser\.app|portal-dev\.api\.vibebrowser\.app)\/auth\.html/i;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = (await targetsRes.json()) as CdpTarget[];
      const portalTab = targets.find((t) => t.type === "page" && portalHostPattern.test(t.url));
      if (!portalTab) {
        await Bun.sleep(500);
        continue;
      }

      const ws = await openCdpWs(portalTab.webSocketDebuggerUrl);
      try {
        // Wait for the form to be ready (inputs present + not disabled),
        // then set values via the React-aware native setter and click submit.
        // JSON-encode credentials to safely embed into the script string —
        // a password with quotes/backslashes would otherwise break the JS.
        const script = `
          (async () => {
            const EMAIL = ${JSON.stringify(email)};
            const PWD = ${JSON.stringify(password)};
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            const setNative = (el, v) => {
              const proto = el.constructor.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
              setter.call(el, v);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            for (let i = 0; i < 40; i++) {
              const emailEl = document.querySelector('input[type="email"], input[name="email"], input[autocomplete="email"]');
              const pwdEl = document.querySelector('input[type="password"], input[name="password"]');
              const btn = Array.from(document.querySelectorAll('button')).find(b => /sign\\s*in|submit|log\\s*in/i.test(b.textContent || ''));
              if (emailEl && pwdEl && btn && !btn.disabled) {
                setNative(emailEl, EMAIL);
                await sleep(50);
                setNative(pwdEl, PWD);
                await sleep(50);
                btn.click();
                return 'submitted';
              }
              await sleep(250);
            }
            return 'timeout-waiting-for-form';
          })()
        `;
        const evalRaw = await cdpSend(ws, 1, "Runtime.evaluate", {
          expression: script,
          awaitPromise: true,
          returnByValue: true
        });
        const result = (evalRaw as { result?: { result?: { value?: string } } })?.result?.result?.value;
        console.log(`[runner] CDP portal auto-fill → ${result}`);
        if (result === "submitted") {
          return true;
        }
        // Form not found — portal may still be loading, retry by reconnecting.
      } finally {
        ws.close();
      }
    } catch (err) {
      console.log(`[runner] portal auto-fill attempt failed: ${(err as Error).message}`);
    }
    await Bun.sleep(1000);
  }
  console.log(`[runner] portal auto-fill gave up after ${timeoutMs}ms`);
  return false;
}

/**
 * Click the "Connect" button/link on the Vibe Settings tab to trigger the
 * Vibe Portal sign-in flow. Uses CDP to locate the button by visible text
 * ("Connect" / "Sign in") inside the Settings page DOM and dispatches a real
 * click event — resilient to UI layout changes (rows moving, dark mode, etc).
 */
async function clickConnectOnSettings(): Promise<boolean> {
  console.log("[runner] CDP: locating Settings tab + clicking Connect button");
  try {
    const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const targets = (await targetsRes.json()) as CdpTarget[];
    const settingsTab = targets.find(
      (t) => t.type === "page" && t.url.includes("/settings.html")
    );
    if (!settingsTab) {
      console.log("[runner] clickConnectOnSettings: no settings.html tab found");
      return false;
    }
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${settingsTab.id}`);
    await Bun.sleep(500);
    const ws = await openCdpWs(settingsTab.webSocketDebuggerUrl);
    try {
      const script = `
        (() => {
          const isClickable = (el) => {
            if (!el) return false;
            const tag = el.tagName.toLowerCase();
            if (tag === 'button' || tag === 'a') return true;
            const role = el.getAttribute('role');
            return role === 'button' || role === 'link';
          };
          const txt = (el) => (el.textContent || '').trim();
          // 1) Prefer an explicit "Connect" or "Sign in" actionable element
          const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'));
          let target = candidates.find(el => /^connect$/i.test(txt(el)));
          if (!target) target = candidates.find(el => /^(sign\\s*in|log\\s*in)$/i.test(txt(el)));
          // 2) Otherwise climb from any text "Connect" / "Sign in"
          if (!target) {
            const all = Array.from(document.querySelectorAll('*'));
            const textHit = all.find(el => /\\b(connect|sign\\s*in|log\\s*in)\\b/i.test(txt(el)) && el.children.length < 4);
            if (textHit) {
              let cursor = textHit;
              for (let depth = 0; depth < 6 && cursor; depth++) {
                if (isClickable(cursor)) { target = cursor; break; }
                cursor = cursor.parentElement;
              }
            }
          }
          if (!target) return 'no-target';
          target.scrollIntoView({block: 'center'});
          target.click();
          return 'clicked:' + (target.tagName + ':' + txt(target)).slice(0, 60);
        })()
      `;
      const evalRaw = await cdpSend(ws, 1, "Runtime.evaluate", {
        expression: script,
        returnByValue: true
      });
      const result = (evalRaw as { result?: { result?: { value?: string } } })?.result?.result?.value;
      console.log(`[runner] CDP Settings Connect → ${result}`);
      await Bun.sleep(2000);
      return typeof result === "string" && result.startsWith("clicked:");
    } finally {
      ws.close();
    }
  } catch (err) {
    console.log(`[runner] clickConnectOnSettings failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Close any chrome-extension:// tabs the extension may have auto-opened on
 * first install. Vibe opens its settings.html as a new tab on first launch
 * and the CUA vision model gets stuck there. Closing these tabs forces the
 * model down the sidepanel path (the actual UI surface under test).
 */
async function closeExtensionTabs(): Promise<number> {
  let closed = 0;
  try {
    const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const targets = (await targetsRes.json()) as CdpTarget[];
    const extTabs = targets.filter(
      // Close any chrome-extension:// tab EXCEPT the sidepanel — sidepanel
      // is the test target and closing it leaves the model on about:blank.
      (t) => t.type === "page" && t.url.startsWith("chrome-extension://") && !t.url.includes("/sidepanel.html")
    );
    for (const tab of extTabs) {
      try {
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${tab.id}`);
        closed += 1;
        console.log(`[runner] closed extension tab: ${tab.url}`);
      } catch (err) {
        console.log(`[runner] failed to close ${tab.id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.log(`[runner] closeExtensionTabs error: ${(err as Error).message}`);
  }
  return closed;
}

/**
 * CDP-type a prompt into the Vibe sidepanel chat input and click Send.
 * Bypasses CUA-vision typing which is unreliable for small input fields.
 *
 * The sidepanel input is a contenteditable element OR a plain textarea —
 * we try both. Pressing Enter alone is not always sufficient (some flows
 * insert newline instead of submitting), so we also look for the visible
 * Send button (it has an aria-label or send icon) and call .click() on it.
 */
async function sendPromptToSidepanel(promptText: string, timeoutMs = 30_000): Promise<boolean> {
  console.log("[runner] CDP: typing prompt into sidepanel + clicking Send");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = (await targetsRes.json()) as CdpTarget[];
      const sidepanelTab = targets.find(
        (t) => t.type === "page" && t.url.includes("/sidepanel.html")
      );
      if (!sidepanelTab) {
        await Bun.sleep(500);
        continue;
      }
      const ws = await openCdpWs(sidepanelTab.webSocketDebuggerUrl);
      try {
        // Hard target the ChatInput textarea + send button by data-testid.
        // Iter 40 evidence: the previous form-ancestry walk found
        // suggested-prompt buttons ("Translate this page to English") as
        // the "last enabled button" and clicked one of those, replacing
        // the typed prompt with the suggestion text. ChatInput.tsx renders
        // textarea[data-testid="chat-input-textarea"] and the send
        // button[data-testid="send-button"] — use those directly.
        const script = `
          (async () => {
            const PROMPT = ${JSON.stringify(promptText)};
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            for (let i = 0; i < 30; i++) {
              const textarea = document.querySelector('textarea[data-testid="chat-input-textarea"]')
                || document.querySelector('textarea');
              if (!textarea) { await sleep(250); continue; }

              textarea.focus();
              const proto = window.HTMLTextAreaElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
              setter.call(textarea, PROMPT);
              textarea.dispatchEvent(new Event('input', { bubbles: true }));
              textarea.dispatchEvent(new Event('change', { bubbles: true }));
              await sleep(150);

              // Wait for the Send button to become enabled (React state
              // update for message + isLLMConfigured may take a frame).
              let sendBtn = null;
              for (let j = 0; j < 40; j++) {
                sendBtn = document.querySelector('button[data-testid="send-button"]');
                if (sendBtn && !sendBtn.disabled) break;
                await sleep(150);
              }
              if (sendBtn && !sendBtn.disabled) {
                sendBtn.click();
                return 'submitted:send-button';
              }
              // Send button is disabled — surface why so we can diagnose.
              if (sendBtn) {
                const reason = sendBtn.getAttribute('title') || 'disabled';
                return 'send-button-disabled:' + reason.slice(0, 80);
              }
              return 'send-button-not-found';
            }
            return 'no-textarea-found';
          })()
        `;
        const evalRaw = await cdpSend(ws, 1, "Runtime.evaluate", {
          expression: script,
          awaitPromise: true,
          returnByValue: true
        });
        const result = (evalRaw as { result?: { result?: { value?: string } } })?.result?.result?.value;
        console.log(`[runner] CDP sendPromptToSidepanel → ${result}`);
        if (typeof result === "string" && result.startsWith("submitted:")) {
          return true;
        }
      } finally {
        ws.close();
      }
    } catch (err) {
      console.log(`[runner] sendPromptToSidepanel attempt failed: ${(err as Error).message}`);
    }
    await Bun.sleep(1000);
  }
  console.log(`[runner] sendPromptToSidepanel gave up after ${timeoutMs}ms`);
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.AZURE_CUA_API_KEY;
  if (!apiKey) {
    throw new Error("AZURE_CUA_API_KEY is required");
  }

  const testCase = await loadTestCase(args.testCase);
  const maxSteps = testCase.maxSteps ?? args.maxSteps ?? DEFAULT_MAX_STEPS;
  gWaitDefaultMs = testCase.defaultWaitMs ?? 1_000;
  const fallbackExtensionId = resolveExtensionId(testCase, args.channel);

  await mkdir(args.outputDir, { recursive: true });
  await mkdir(path.join(args.outputDir, "chrome-profile"), { recursive: true });

  const clientOptions: ConstructorParameters<typeof OpenAI>[0] = { apiKey };
  if (process.env.AZURE_CUA_BASE_URL) {
    clientOptions.baseURL = process.env.AZURE_CUA_BASE_URL;
  } else if (process.env.AZURE_CUA_API_KEY) {
    // Default to the known Azure AI Foundry endpoint when using an Azure key without explicit base URL
    clientOptions.baseURL = "https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1";
  }
  const client = new OpenAI(clientOptions);

  const CUA_MODEL = process.env.CUA_MODEL ?? "gpt-5.4-2026-03-05";
  const CUA_TOOL_TYPE = process.env.CUA_TOOL_TYPE ?? (CUA_MODEL.startsWith("gpt-5") ? "computer" : "computer_use_preview");

  let lastResponseId: string | undefined;
  const logs: string[] = [];
  let completion = { done: false, success: false, reason: "" };
  let chrome: Bun.Subprocess | undefined;
  let recorder: Bun.Subprocess | undefined;

  // NOTE: recording captures the full screen including credential entry —
  // artifacts are restricted to repo collaborators and retained for 7 days only.
  try {
    // Compute extension ID from manifest key for instruction context.
    // Chrome blocks direct URL navigation to chrome-extension://id/sidepanel.html
    // (ERR_BLOCKED_BY_CLIENT) — sidepanels must be opened via the toolbar icon.
    const manifestId = await computeExtensionIdFromManifest(args.extensionPath);

    // WARMUP CHROME: launch briefly to seed extension storage so the next
    // Chrome launch sees a "configured" extension (no settings tab auto-open).
    // Without this, chrome.runtime.onInstalled fires on every fresh
    // user-data-dir and opens settings.html, which distracts the CUA model.
    if (manifestId) {
      console.log(`[runner] WARMUP: starting Chrome to seed extension storage...`);
      const warmupChrome = startChrome(args.extensionPath);
      await Bun.sleep(5000);
      const seeded = await seedExtensionStorage(manifestId);
      console.log(`[runner] WARMUP: seed result = ${seeded}; shutting down warmup Chrome`);
      warmupChrome.kill();
      await warmupChrome.exited.catch(() => {});
      await Bun.sleep(2000);

      // Clear session-restore files so the main Chrome launch does NOT
      // restore the warmup window's tabs (including the auto-opened
      // settings tab from before the seed took effect). Storage in
      // Local Extension Settings persists; only the tab session state
      // is purged.
      const cleanupPaths = [
        // Session-restore files — prevent the warmup window's tabs (including
        // the auto-opened settings tab) from coming back via session restore.
        path.join(CHROME_USER_DATA_DIR, "Default", "Sessions"),
        path.join(CHROME_USER_DATA_DIR, "Default", "Tabs"),
        path.join(CHROME_USER_DATA_DIR, "Default", "Current Session"),
        path.join(CHROME_USER_DATA_DIR, "Default", "Current Tabs"),
        path.join(CHROME_USER_DATA_DIR, "Default", "Last Session"),
        path.join(CHROME_USER_DATA_DIR, "Default", "Last Tabs"),
        // Extension storage — wipe the seeded placeholder AI config so the
        // sidepanel shows the Sign In flow on main launch. The seed served
        // its purpose during warmup (suppressing onInstalled→openSettings);
        // Chrome treats the extension as already-installed on main launch
        // so onInstalled does NOT re-fire even with empty storage. Net
        // result: no settings auto-open AND sidepanel requires sign-in.
        path.join(CHROME_USER_DATA_DIR, "Default", "Local Extension Settings", manifestId)
      ];
      for (const f of cleanupPaths) {
        await rm(f, { recursive: true, force: true }).catch(() => {});
      }
      console.log(`[runner] WARMUP: cleared session-restore + ext storage`);

      // Pin extension via Preferences AFTER warmup wrote initial Preferences
      // and BEFORE main Chrome reads them. Chrome 142+ routes puzzle-piece
      // clicks to chrome://extensions instead of showing a dropdown, so the
      // only reliable click target is a pinned toolbar icon.
      await pinExtensionViaPreferences(manifestId);
    }

    chrome = startChrome(args.extensionPath);
    recorder = startRecording(args.outputDir);

    // Wait for Chrome to start and extension to load
    await Bun.sleep(5000);
    await capturePhaseScreenshot(args.outputDir, "chrome-started");

    // Navigate to the Chrome Web Store listing so it appears in the recording.
    // Open a new CDP tab, load the listing page, screenshot it, then blank it.
    try {
      const CWS_LISTING_URL = "https://chromewebstore.google.com/detail/ajfjlohdpfgngdjfafhhcnpmijbbdgln";
      const newTabRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(CWS_LISTING_URL)}`);
      const newTab = (await newTabRes.json()) as CdpTarget;
      console.log(`[runner] CWS tab opened: ${newTab.id}`);
      // Wait for the listing page to load
      await new Promise<void>((r) => setTimeout(r, 3000));
      await capturePhaseScreenshot(args.outputDir, "cws-store");
      // Navigate away to about:blank so the CWS tab doesn't distract the model
      const cwsWs = await openCdpWs(newTab.webSocketDebuggerUrl);
      try {
        await cdpSend(cwsWs, 1, "Page.navigate", { url: "about:blank" });
      } finally {
        cwsWs.close();
      }
    } catch (err) {
      console.warn(`[runner] CWS listing stage failed (non-fatal): ${(err as Error).message}`);
    }

    const prefsId = manifestId ? undefined : await detectExtensionId(CHROME_USER_DATA_DIR, args.extensionPath);
    const extensionId = manifestId ?? prefsId ?? fallbackExtensionId;
    const idSource = manifestId ? "manifest key" : prefsId ? "Chrome Preferences" : "hardcoded fallback";
    console.log(`[runner] Extension ID: ${extensionId} (${idSource})`);

    // Force chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true})
    // via CDP so a single click on the action icon (delivered by xdotool —
    // a real X11 user gesture) opens the sidepanel without extra steps.
    let actionClickConfigured = false;
    if (extensionId) {
      actionClickConfigured = await openSidepanelViaCdp(extensionId);
    }

    // Open the sidepanel from the runner via xdotool. CUA vision model
    // cannot reliably hit the small (~24px) puzzle-piece icon; doing it
    // from the runner with hard-coded coordinates is deterministic. After
    // this the CUA only handles sign-in + chat (its actual job per the
    // QA contract in tests/cua/AGENTS.md).
    const testEmail = process.env.VIBE_TEST_EMAIL;
    const testPassword = process.env.VIBE_TEST_PASSWORD;

    let sidepanelOpenedByRunner = false;
    if (extensionId && actionClickConfigured) {
      sidepanelOpenedByRunner = await openSidepanelViaXdotool(extensionId);
      await capturePhaseScreenshot(args.outputDir, "sidepanel-opened");
    }

    // Auth flow: start portal auto-fill watcher → click Connect on Settings
    // → wait for auto-fill to submit → re-open sidepanel (OAuth callback
    // causes extension to reload itself, closing sidepanel).
    if (testEmail && testPassword) {
      const autoFillPromise = autoFillPortalSignIn(testEmail, testPassword);
      await clickConnectOnSettings();
      await capturePhaseScreenshot(args.outputDir, "connect-clicked");

      const submitted = await Promise.race([
        autoFillPromise,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 120_000))
      ]);
      console.log(`[runner] portal auto-fill done: ${submitted}`);
      await capturePhaseScreenshot(args.outputDir, submitted ? "portal-submitted" : "portal-timeout");

      // OAuth callback reloads the extension service worker, which closes
      // the sidepanel and may unpin the toolbar icon transiently. Wait for
      // SW to re-register, then re-open the sidepanel via xdotool. Also
      // re-pin via Preferences in case the icon position drifted.
      if (submitted) {
        await Bun.sleep(5000);
        await pinExtensionViaPreferences(extensionId);
        await Bun.sleep(1500);
        const reopened = await openSidepanelViaXdotool(extensionId);
        console.log(`[runner] post-auth sidepanel re-open: ${reopened}`);
        sidepanelOpenedByRunner = reopened;
        await capturePhaseScreenshot(args.outputDir, "post-auth-sidepanel-reopened");

        // Close any open extensions popup / dropdown left over from
        // earlier puzzle-piece clicks. ESC clears them safely.
        try {
          runCommand("xdotool", ["key", "Escape"]);
          await Bun.sleep(300);
          runCommand("xdotool", ["key", "Escape"]);
          await Bun.sleep(300);
        } catch {}

        // Wait for the Vibe AI provider to finish its "Connecting" handshake.
        // Without this wait the chat input is non-functional even though
        // the sidepanel is open.
        console.log("[runner] waiting 20s for Vibe AI provider to connect...");
        await Bun.sleep(20_000);
        await capturePhaseScreenshot(args.outputDir, "provider-connected");

        // Show settings overview for viral demo: navigate to options page, screenshot, return.
        try {
          const optionsUrl = `chrome-extension://${extensionId}/options.html`;
          const settingsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(optionsUrl)}`);
          const settingsTab = (await settingsRes.json()) as CdpTarget;
          await new Promise<void>((r) => setTimeout(r, 3500));
          await capturePhaseScreenshot(args.outputDir, "settings-overview");
          const settingsWs = await openCdpWs(settingsTab.webSocketDebuggerUrl);
          try {
            await cdpSend(settingsWs, 1, "Page.navigate", { url: "about:blank" });
          } finally {
            settingsWs.close();
          }
        } catch (err) {
          console.warn(`[runner] Settings overview stage failed (non-fatal): ${(err as Error).message}`);
        }
      }
    }

    // Belt-and-suspenders: close any extension tabs that may have opened.
    await closeExtensionTabs();

    // Activate the non-extension tab so the CUA's initial screenshot shows
    // about:blank + sidepanel, not the settings.html tab that the auth flow
    // opens (runner clicks "Connect" there).  closeExtensionTabs() closes the
    // tab but Chrome's rendering is async — without an explicit activation +
    // redraw wait the very next screenshot still captures the settings tab,
    // causing the CUA to mistake the Settings left sidebar for sidepanel nav.
    try {
      const allTargets = (
        await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()
      ) as CdpTarget[];
      const mainTab = allTargets.find(
        (t) => t.type === "page" && !t.url.startsWith("chrome-extension://")
      );
      if (mainTab) {
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/activate/${mainTab.id}`);
        console.log(`[runner] activated main tab: ${mainTab.url}`);
        await new Promise<void>((r) => setTimeout(r, 600));
      }
    } catch (err) {
      console.warn(
        `[runner] tab activation failed (non-fatal): ${(err as Error).message}`
      );
    }

    // If the test case defines a `prompt`, the runner CDP-types it into the
    // sidepanel chat input. This bypasses vision-based clicking which is
    // unreliable for small input fields (iter 26 clicked y=702 instead of
    // y=988 and typing went to the URL bar → about:blank navigation).
    let promptSentByRunner = false;
    if (testCase.prompt) {
      promptSentByRunner = await sendPromptToSidepanel(testCase.prompt);
      console.log(`[runner] prompt sent: ${promptSentByRunner}`);
      await capturePhaseScreenshot(args.outputDir, promptSentByRunner ? "prompt-sent" : "prompt-send-failed");
    }

    // Runner-driven response polling. When the runner submitted the prompt
    // AND the test case defines a verification prompt, we don't need the CUA
    // model to "observe" — the CUA model gives up too early (iter 29: gave
    // up at 85s instead of the instructed 360s). Run the verifier in a poll
    // loop instead. First pass → success. Timeout → fall through to CUA
    // loop as a backup (or fail if loop also doesn't reach success).
    let verifiedByPoll = false;
    if (promptSentByRunner && testCase.verification) {
      const pollResult = await pollVerifierUntilResponse(
        client,
        CUA_MODEL,
        testCase.verification,
        args.outputDir,
        {
          initialWaitMs: testCase.pollOptions?.initialWaitMs ?? 30_000,
          intervalMs: testCase.pollOptions?.intervalMs ?? 45_000,
          timeoutMs: testCase.pollOptions?.timeoutMs ?? 720_000
        }
      );
      if (pollResult?.passed) {
        completion = {
          done: true,
          success: true,
          reason: `runner-poll verified: ${pollResult.evidence || pollResult.raw}`
        };
        verifiedByPoll = true;
        await writeFile(path.join(args.outputDir, "runner-log.jsonl"), `${logs.join("\n")}\n`, "utf8");
      } else if (pollResult) {
        // Don't lock in failure here — let the CUA loop have one more pass
        // in case the response appears between polls. (Cheap insurance.)
        console.log(`[poll] last verifier rejection: ${pollResult.evidence || pollResult.raw}`);
      }
    }

    const successText = testCase.successCriteria.map((line, i) => `${i + 1}. ${line}`).join("\n");
    const failureText = testCase.failureCriteria.map((line, i) => `${i + 1}. ${line}`).join("\n");

    const initialScreenshot = await saveOptimizedScreenshot(path.join(args.outputDir, "step-00.png"));

    const sidepanelHint = sidepanelOpenedByRunner
      ? `The Vibe Co-Pilot sidepanel HAS ALREADY BEEN OPENED for you by the test runner. It is visible as a vertical column on the right side of the Chrome window. You do NOT need to click any toolbar icon. Skip directly to interacting with the sidepanel UI.`
      : actionClickConfigured
        ? `The Vibe sidepanel could not be opened automatically. You will need to open it manually: click the puzzle-piece (Extensions) icon at approximately pixel coordinate (1815, 73) — the toolbar row is at y=73, NOT y=51 which is the empty space between tabs and toolbar — then click the "Vibe AI Browser Co-Pilot" entry in the popup.`
        : `The Vibe extension is loaded. Open the sidepanel by clicking the puzzle-piece (Extensions) icon at approximately (1815, 73), then click the "Vibe AI Browser Co-Pilot" entry in the popup.`;

    const portalAutoFillHint = (testEmail && testPassword)
      ? `IMPORTANT — sign-in is handled automatically: when you click any "Sign In" / "Connect" / "Log in" button, Vibe opens a sign-in tab at portal.vibebrowser.app. The test runner DETECTS THIS TAB AND AUTO-FILLS the credentials + clicks Submit for you in the background. You do NOT need to type any email or password — just trigger the sign-in flow and WAIT for the authenticated state to appear (the sidepanel chat input should become visible within 10-20 seconds). Do not type credentials yourself — that will conflict with the auto-fill.`
      : "";

    const instruction = [
      `Test case: ${testCase.name}`,
      args.channel ? `Channel: ${args.channel}` : "",
      extensionId
        ? `Context: Extension ID = ${extensionId}. Chrome is at about:blank (a deliberately empty page) at 1920x1080. ${sidepanelHint} Do NOT type any chrome-extension:// URL into the address bar. Do NOT navigate to any website yourself — the Vibe co-pilot inside the sidepanel will do that as part of executing the task. Do NOT interact with anything outside the sidepanel — no search bars, no suggestion lists, nothing on the page itself. Your only job is the sidepanel.`
        : "",
      portalAutoFillHint,
      `Instruction: ${testCase.instruction}`,
      successText ? `Success criteria:\n${successText}` : "",
      failureText ? `Failure criteria:\n${failureText}` : "",
      "You are controlling real Chrome. Use computer actions to complete this test.",
      "When complete, respond with TEST_PASSED or TEST_FAILED and a short reason."
    ]
      .filter(Boolean)
      .join("\n\n");

    let nextInput: unknown[] = [
      {
        role: "user",
        content: [
          { type: "input_text", text: instruction },
          { type: "input_image", image_url: `data:image/png;base64,${initialScreenshot}` }
        ]
      }
    ];

    // Runner polling already produced a verdict — skip the CUA loop.
    for (let step = 1; !completion.done && step <= maxSteps; step += 1) {
      const response = (await client.responses.create({
        model: CUA_MODEL,
        previous_response_id: lastResponseId,
        truncation: "auto",
        input: nextInput,
        tools: [
          {
            type: CUA_TOOL_TYPE as "computer_use_preview" | "computer_use" | "computer",
            ...(CUA_TOOL_TYPE !== "computer" ? { display_width: DISPLAY_WIDTH, display_height: DISPLAY_HEIGHT } : {})
          }
        ]
      })) as unknown as ResponseLike;

      lastResponseId = response.id;
      const computerCalls = extractComputerCalls(response, step);
      const actionResults: string[] = [];
      const toolOutputs: unknown[] = [];

      for (const [index, call] of computerCalls.entries()) {
        const callLabel = `step-${String(step).padStart(2, "0")}-a${index + 1}`;
        const subResults: string[] = [];
        for (const [ai, action] of call.actions.entries()) {
          const actionLabel = call.actions.length === 1 ? callLabel : `${callLabel}-${ai + 1}`;
          const result = await executeAction(action, actionLabel, args.outputDir);
          subResults.push(result);
        }
        const combinedResult = subResults.join("; ");
        await saveOptimizedScreenshot(
          path.join(args.outputDir, `${callLabel}.png`)
        );

        actionResults.push(combinedResult);
        toolOutputs.push({
          type: "computer_call_output",
          call_id: call.callId,
          ...(call.pendingSafetyChecks && call.pendingSafetyChecks.length > 0
            ? { acknowledged_safety_checks: call.pendingSafetyChecks }
            : {}),
          output: [
            { type: "input_text", text: combinedResult }
          ]
        });
      }

      logs.push(
        JSON.stringify(
          {
            step,
            responseId: response.id,
            outputText: getResponseText(response),
            actions: computerCalls.map((c) => ({ callId: c.callId, actions: c.actions })),
            actionResults
          },
          null,
          2
        )
      );

      completion = determineCompletion(response, computerCalls.length);
      if (completion.done) {
        await writeFile(path.join(args.outputDir, "runner-log.jsonl"), `${logs.join("\n")}\n`, "utf8");
        break;
      }

      if (toolOutputs.length > 0) {
        nextInput = toolOutputs;
      } else {
        const followupScreenshot = await saveOptimizedScreenshot(
          path.join(args.outputDir, `step-${String(step).padStart(2, "0")}.png`)
        );
        nextInput = [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Continue test execution. Step ${step} did not include executable actions.`
              },
              { type: "input_image", image_url: `data:image/png;base64,${followupScreenshot}` }
            ]
          }
        ];
      }
    }

    await writeFile(path.join(args.outputDir, "runner-log.jsonl"), `${logs.join("\n")}\n`, "utf8");
    if (!completion.done) {
      throw new Error(`Max steps reached without completion (${maxSteps})`);
    }

    // Anti-hallucination guard: when the loop reports success and the case
    // defines a verification prompt, ask the model a focused yes/no question
    // against a fresh screenshot. NO → flip to FAIL. Catches the failure mode
    // where the agent sat on a wrong page and emitted a fabricated TEST_PASSED.
    if (completion.success && testCase.verification && !verifiedByPoll) {
      console.log("[verify] running post-loop verification...");
      const verification = await verifyResult(
        client,
        CUA_MODEL,
        testCase.verification,
        args.outputDir
      );
      if (!verification.passed) {
        completion = {
          done: true,
          success: false,
          reason: `loop reported success but verifier rejected: ${verification.evidence || verification.error || verification.raw}`
        };
      }
    }
  } finally {
    chrome?.kill();
    recorder?.kill();
    if (recorder) await recorder.exited;
    await assembleGif(args.outputDir).catch(() => {});
  }

  if (completion.success) {
    console.log(`TEST PASSED: ${completion.reason}`);
    process.exit(0);
  }
  console.error(`TEST FAILED: ${completion.reason}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`CUA runner error: ${(error as Error).message}`);
  process.exit(1);
});
