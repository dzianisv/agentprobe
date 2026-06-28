import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import OpenAI from "openai";
import sharp from "sharp";

type RunnerArgs = {
  testCase: string;
  outputDir: string;
  maxSteps: number;
  startUrl?: string;
};

type Verification = {
  // Yes/No question the verifier model is asked against the FINAL screenshot.
  // Anti-hallucination guard: if the loop reports TEST_PASSED but the verifier
  // answers NO, the final result is flipped to FAIL. This catches the failure
  // mode where the agent sat on a wrong page and emitted a fabricated success.
  prompt: string;
};

type RawTestCase = {
  name?: string;
  instruction?: string;
  goal?: string;
  criteria?: string[];
  successCriteria?: string | string[];
  failureCriteria?: string | string[];
  maxSteps?: number;
  verification?: Verification;
  // Default duration for CUA `wait` actions when the model omits the ms field.
  // Use 30_000 (30 seconds) for long-running agent tests; default is 1_000 (1 second).
  defaultWaitMs?: number;
  // Starting URL for the browser run. Also settable via --url CLI arg.
  url?: string;
};

type TestCase = {
  name: string;
  instruction: string;
  successCriteria: string[];
  failureCriteria: string[];
  maxSteps?: number;
  verification?: Verification;
  defaultWaitMs?: number;
  url?: string;
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
const DEFAULT_MAX_STEPS = 30;
const CHROME_USER_DATA_DIR = "/tmp/chrome-cua-profile";

// Per-test default for CUA `wait` actions where the model omits the ms field.
// Set from testCase.defaultWaitMs after loadTestCase().
let gWaitDefaultMs = 1_000;

function printHelp(): void {
  console.log(`CUA runner\n\nUsage:\n  bun runner.ts --test-case <name|path> --output-dir <dir> [--url <url>] [--max-steps <n>]\n\nRequired:\n  --test-case        Test case basename or file path (.ts, .yaml, .yml, .json)\n  --output-dir       Directory for screenshots and log outputs\n\nOptional:\n  --url              Starting URL for the browser (overrides test case url field)\n  --max-steps        Override maximum automation steps\n  --help             Print this help\n`);
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
      case "test-case":
        args.testCase = value;
        break;
      case "output-dir":
        args.outputDir = value;
        break;
      case "url":
        args.startUrl = value;
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

  // Remove the raw intermediate file to avoid polluting the output directory
  try { Bun.spawnSync(["rm", "-f", rawFile]); } catch {}

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

  for (const ext of [".ts", ".yaml", ".yml", ".json"]) {
    if (!spec.endsWith(ext)) {
      const withExt = path.isAbsolute(spec) ? `${spec}${ext}` : path.resolve(cwd, `${spec}${ext}`);
      if (await fileExists(withExt)) {
        return withExt;
      }
      const byBasename = path.join(casesDir, `${path.basename(spec)}${ext}`);
      if (await fileExists(byBasename)) {
        return byBasename;
      }
    }
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
  const instruction = String(raw.instruction ?? raw.goal ?? "").trim();
  if (!instruction) {
    throw new Error(`Test case ${resolvedPath} must define instruction`);
  }

  return {
    name: String(raw.name ?? inferredName),
    instruction,
    successCriteria: toStringArray(raw.successCriteria ?? raw.criteria),
    failureCriteria: toStringArray(raw.failureCriteria),
    maxSteps: toNumber(raw.maxSteps),
    verification: raw.verification,
    defaultWaitMs: toNumber(raw.defaultWaitMs),
    url: raw.url
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


function hasStringInstruction(value: unknown): value is RawTestCase & { instruction: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return typeof (value as RawTestCase).instruction === "string";
}

async function loadTestCase(spec: string): Promise<TestCase> {
  const resolvedPath = await resolveTestCasePath(spec);

  if (resolvedPath.endsWith(".yaml") || resolvedPath.endsWith(".yml")) {
    const { load: yamlLoad } = await import("js-yaml");
    const raw = yamlLoad(await readFile(resolvedPath, "utf8")) as RawTestCase;
    return normalizeTestCase(raw, resolvedPath);
  }

  if (resolvedPath.endsWith(".json")) {
    const raw = JSON.parse(await readFile(resolvedPath, "utf8")) as RawTestCase;
    return normalizeTestCase(raw, resolvedPath);
  }

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

function startChrome(initialUrl = "about:blank"): Bun.Subprocess {
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
    // Remote debugging port for CDP access if needed
    "--remote-debugging-port=9222",
    "--remote-allow-origins=*",
    initialUrl
  ];

  const chromeBin = process.env.CHROME_PATH ?? "google-chrome";
  return Bun.spawn([chromeBin, ...chromeArgs], {
    stdout: "pipe",
    stderr: "pipe"
  });
}

// Poll Chrome's CDP endpoint until it responds (max 20s), then sleep 2s for the page to render.
async function waitForChromeReady(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://localhost:9222/json/version", { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        // CDP is up — give the initial page an extra 2s to paint
        await Bun.sleep(2000);
        return;
      }
    } catch {
      // Chrome not ready yet
    }
    await Bun.sleep(500);
  }
  // Fallback: just wait the full timeout if CDP never responded
  console.warn("[runner] Chrome CDP did not respond within timeout; proceeding anyway");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Support both Azure CUA and standard OpenAI. Azure takes precedence.
  const azureKey = process.env.AZURE_CUA_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!azureKey && !openaiKey) {
    throw new Error("Either AZURE_CUA_API_KEY or OPENAI_API_KEY is required");
  }

  const testCase = await loadTestCase(args.testCase);
  const maxSteps = testCase.maxSteps ?? args.maxSteps ?? DEFAULT_MAX_STEPS;
  gWaitDefaultMs = testCase.defaultWaitMs ?? 1_000;

  await mkdir(args.outputDir, { recursive: true });

  const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey: azureKey ?? openaiKey ?? ""
  };
  if (azureKey) {
    clientOptions.baseURL = process.env.AZURE_CUA_BASE_URL ?? "https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1";
  } else if (process.env.OPENAI_BASE_URL) {
    clientOptions.baseURL = process.env.OPENAI_BASE_URL;
  }
  const client = new OpenAI(clientOptions);

  // Default model: gpt-5.4 for Azure, gpt-4o for plain OpenAI
  const CUA_MODEL = process.env.CUA_MODEL ?? (azureKey ? "gpt-5.4-2026-03-05" : "gpt-4o");
  const CUA_TOOL_TYPE = process.env.CUA_TOOL_TYPE ?? (CUA_MODEL.startsWith("gpt-5") ? "computer" : "computer_use_preview");

  let lastResponseId: string | undefined;
  const logs: string[] = [];
  let completion = { done: false, success: false, reason: "" };
  let chrome: Bun.Subprocess | undefined;
  let recorder: Bun.Subprocess | undefined;

  try {
    const startUrl = args.startUrl ?? testCase.url ?? "about:blank";
    chrome = startChrome(startUrl);
    recorder = startRecording(args.outputDir);

    // Wait for Chrome to be ready: poll the CDP endpoint until Chrome responds,
    // then add extra time for the initial page to render.
    await waitForChromeReady();
    await capturePhaseScreenshot(args.outputDir, "chrome-started");

    const successText = testCase.successCriteria.map((line, i) => `${i + 1}. ${line}`).join("\n");
    const failureText = testCase.failureCriteria.map((line, i) => `${i + 1}. ${line}`).join("\n");

    const initialScreenshot = await saveOptimizedScreenshot(path.join(args.outputDir, "step-00.png"));

    const instruction = [
      `Test case: ${testCase.name}`,
      `You are a computer-use agent testing a web application. Chrome is open${startUrl !== "about:blank" ? ` at ${startUrl}` : ""} at 1920x1080.`,
      `Interact with whatever is visible on screen to complete the goal.`,
      `Use click, type, key, scroll, drag, wait to navigate.`,
      `Emit TEST_PASSED when the goal is visually confirmed. Emit TEST_FAILED on unrecoverable errors.`,
      `Instruction: ${testCase.instruction}`,
      successText ? `Success criteria:\n${successText}` : "",
      failureText ? `Failure criteria:\n${failureText}` : "",
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
    if (completion.success) {
      // Build verifier prompt: explicit verification.prompt takes priority;
      // fall back to successCriteria so both targets behave consistently.
      let verifierPrompt: string | undefined;
      if (testCase.verification?.prompt) {
        verifierPrompt = testCase.verification.prompt;
      } else if (testCase.successCriteria.length > 0) {
        const criteria = testCase.successCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
        verifierPrompt = `The test success criteria are:\n${criteria}\n\nLooking at this screenshot, are ALL success criteria satisfied? Answer YES or NO on the first line, then one sentence of evidence.`;
      }

      if (verifierPrompt) {
        console.log("[verify] running post-loop verification...");
        const verification = await verifyResult(
          client,
          CUA_MODEL,
          { prompt: verifierPrompt },
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
