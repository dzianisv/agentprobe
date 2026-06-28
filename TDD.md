# agentprobe — Technical Design Document

## Architecture Overview

agentprobe is a polyglot package: a Python library/CLI wraps two backends.

```
┌─────────────────────────────────────────────────────────┐
│  Developer interface                                     │
│  YAML / JSON / Python TestCase  →  agentprobe CLI / API │
└──────────────────────┬──────────────────────────────────┘
                       │
           ┌───────────┴────────────┐
           │                        │
    --target android         --target browser
           │                        │
  ┌────────▼────────┐      ┌────────▼────────┐
  │  Python backend  │      │   Bun/TS backend │
  │  agentprobe/     │      │   browser/       │
  │  loop.py         │      │   runner.ts      │
  └────────┬────────┘      └────────┬────────┘
           │                        │
    ADB (screencap            xdotool + scrot
    + input events)           on Chrome via CDP
           │                        │
    Android device /         Chrome (headless or
    emulator                 display) at --url
           │                        │
    Vision model  ◄──────────────── ┘
    (OpenAI-compatible, computer-use capable)
```

---

## Test Case Schema

Defined in `agentprobe/case.py`. Consumed by both backends.

```python
@dataclass
class TestCase:
    name: str                           # slug used in filenames
    instruction: str                    # plain-English goal for the CUA actor
    successCriteria: List[str] = field(default_factory=list)
    failureCriteria: List[str] = field(default_factory=list)
    maxSteps: int = 30                  # hard cap on CUA loop iterations
    verification: Optional[Verification] = None  # explicit judge prompt
    url: str = ""                       # browser only — starting URL
    systemPromptExtra: str = ""         # app-specific instructions appended to SYSTEM_PROMPT

@dataclass
class Verification:
    prompt: str          # YES/NO question asked to the vision judge
```

`successCriteria` and `failureCriteria` are both `List[str]`. YAML multi-value lists map directly; a single string in YAML is normalised to a one-element list by `_load_case()`.

Loaded from YAML/JSON/Python via `cli._load_case()`. YAML is canonical for human-authored cases. `goal` is accepted as an alias for `instruction`.

---

## CLI Flags

`agentprobe run` (`agentprobe/__main__.py` makes `python -m agentprobe` equivalent):

| Flag | Default | Description |
|---|---|---|
| `--target` | required | `android` or `browser` |
| `--case` | required | Path to `.py`, `.json`, `.yaml`, or `.yml` test case |
| `--model` | `gpt-4o` | LLM model (Android only; overridden by xAI/Gemini env keys) |
| `--output-dir` | `/tmp/agentprobe-output` | Directory for screenshots, GIF, logs |
| `--url` | `None` | Starting URL (browser only) |
| `--max-steps` | `None` | Override `maxSteps` from the test case |
| `--include-xml` | `False` | Append UI hierarchy XML to each Android CUA step (Android only) |
| `--speed-multiplier` | `1.0` | Timing multiplier: <1.0 = faster, >1.0 = slower (Android only) |

---

## CUA Loop (Android backend)

`agentprobe/loop.py → run_cua_step()`

```
while step < maxSteps:
    1. screencap via adb → base64 PNG
    2. build user message: goal + criteria + screenshot (vision)
    3. call vision model via chat.completions → JSON action
    4. parse action: {type, x, y, text, key, ms, ...}
    5. execute action via adb input
    6. if action.type == "done" → return success
       if action.type == "fail" → return failure
    7. append to history (last 14 messages kept)
    8. sleep action_delay * speed_multiplier
→ return timeout if maxSteps reached
```

**Action types (Android):** `tap`, `type`, `key`, `swipe`, `clear_field`, `wait`, `screenshot`, `done`, `fail`.

Note: `click`, `double_click`, `scroll`, and `drag` are not implemented in `actions.py`. The system prompt asks the model for `tap` (not `click`) and `swipe` (not `drag`).

**System prompt** (`agentprobe/prompts.py`): instructs the model to emit one JSON action per turn and use `tap` for all taps, `swipe` for scrolling/dragging, `key` for hardware keys, and `done`/`fail` for terminal states. The system prompt is generic — instructs the model to emit one JSON action per turn, use `tap`/`swipe`/`key`/`done`/`fail`, and avoid app-specific assumptions.

---

## CUA Loop (Browser backend)

`browser/runner.ts → main()`

Same logical loop as Android, different transport:

- **Screenshot:** `scrot` captures the Xvfb display → PNG → optimised via `sharp` → base64.
- **Actions:** `xdotool` for mouse click/move/type/key/scroll; `Bun.spawnSync` for system-level calls.
- **Chrome launch:** `google-chrome --no-sandbox --display=:99 --window-size=1920,1080 <startUrl>`
  - `startUrl` = `--url` CLI arg, then `testCase.url`, then `about:blank`.
  - No `--load-extension` or extension-related flags. Extensions must be installed through the Chrome Web Store UI by the CUA agent.
- **LLM API:** uses OpenAI **Responses API** (`client.responses.create()`), not `chat.completions`. This is required for the `computer` / `computer_use_preview` tool type.
- **Model:** `CUA_MODEL` env var (default: `gpt-5.4-2026-03-05`). `CUA_TOOL_TYPE` defaults to `computer` for gpt-5.x models, `computer_use_preview` otherwise.
- **Completion signals:** the agent emits `TEST_PASSED` or `TEST_FAILED` as plain text in its response (not JSON). `determineCompletion()` scans `output_text` for these strings.
- **Recording:** ffmpeg x11grab captures `:99` display to `recording.mp4` for the duration of the run.
- **System prompt:** generic — instructs the agent to interact with whatever is visible on screen at 1920×1080.

**Action types (browser):** `click`, `double_click`, `type`, `key`, `scroll`, `drag`, `move`, `wait`. The agent signals completion via `TEST_PASSED` / `TEST_FAILED` text, not action objects.

---

## Verification / Judge

The two backends use different judge implementations.

### Android — `agentprobe/judge.py → judge_result()`

Runs after the CUA loop regardless of its outcome (success, failure, or timeout). Uses `chat.completions`.

```
priority:
  1. case.verification.prompt   (explicit YES/NO question)
  2. "Is this satisfied: {successCriteria}? YES or NO."  (derived)

call: vision model via chat.completions(final_screenshot + question)
  → parse first word of response for YES/NO
  → verdict = "pass" if YES else "fail"

fallback (no question AND no screenshot available):
  → verdict = "pass" if loop_status == "success" else "fail"

verification API failure → always verdict = "fail"
```

### Browser — `browser/runner.ts → verifyResult()`

Runs only when the loop reports `TEST_PASSED` AND `testCase.verification` is defined. Uses the OpenAI Responses API.

```
trigger: completion.success == true AND testCase.verification defined

question source: verification.prompt ONLY
  (successCriteria alone does NOT trigger a browser vision check)

screenshot: fresh capture at verification time (not the last loop screenshot)

call: client.responses.create(verification.prompt + fresh screenshot)
  → parse response.output_text for YES/NO
  → if NO: flip to fail ("loop reported success but verifier rejected")

writes: verification.json to outputDir
```

**Key difference:** on Android, `successCriteria` provides a fallback judge question. On browser, if `verification` is not defined, the loop's `TEST_PASSED` / `TEST_FAILED` self-report is the final verdict — no independent vision check runs.

---

## Model Configuration

### Android backend (`agentprobe/client.py → make_client()`)

Checked in priority order. First matching key wins.

| Env var(s) | Provider | Model |
|---|---|---|
| `AZURE_CUA_API_KEY` | Azure AI Foundry (OpenAI-compat) | `AZURE_CUA_MODEL` or `--model` / `CUA_MODEL`; default endpoint: `vibe-dev-ai.cognitiveservices.azure.com` |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI | `AZURE_OPENAI_MODEL` (default: `gpt-5.4`); also reads `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_API_VERSION` |
| `AZURE_DEV_AI_API_KEY` | Azure Dev AI | `AZURE_DEV_AI_MODEL` (default: `gpt-4o-2024-11-20`); `AZURE_DEV_AI_BASE_URL` |
| `OPENAI_API_KEY` | OpenAI | `--model` / `CUA_MODEL` (default: `gpt-4o`); optional `OPENAI_BASE_URL` |
| `XAI_API_KEY` | xAI / Grok | **Fixed:** `grok-2-vision-1212` — ignores `--model` and `CUA_MODEL` |
| `GEMINI_API_KEY` | Google Gemini | **Fixed:** `gemini-2.0-flash` — ignores `--model` and `CUA_MODEL` |

If none of these are set, the process exits with an error listing all accepted keys.

### Browser backend (`browser/runner.ts`)

Uses its own client setup (not Python's `make_client()`).

| Env var | Purpose |
|---|---|
| `AZURE_CUA_API_KEY` | Azure AI Foundry key — takes precedence over `OPENAI_API_KEY` when set. Default endpoint: `https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1`. |
| `OPENAI_API_KEY` | OpenAI key — used when `AZURE_CUA_API_KEY` is not set. |
| `AZURE_CUA_BASE_URL` | Override base URL when using `AZURE_CUA_API_KEY` (default: `https://vibe-dev-ai.cognitiveservices.azure.com/openai/v1`). |
| `CUA_MODEL` | Model name (default: `gpt-5.4-2026-03-05`). |
| `CUA_TOOL_TYPE` | Tool type: `computer` (gpt-5.x), `computer_use_preview`, or `computer_use`. Auto-detected from model name if unset. |

---

## Output Artifacts

Written to `--output-dir` (default: `/tmp/agentprobe-output/`).

### Android backend

| File | Produced by | Contents |
|---|---|---|
| `step-{NNN}_{label}.png` | `android.screenshot_b64()` | One screenshot per CUA step, e.g. `step-001_test-name_01.png` |
| `demo.gif` | `recording.assemble_gif()` via ffmpeg | Animated playback of all steps |
| `result.json` | `loop.run_case()` | `{verdict, steps, reason, verification}` (base64 blob excluded) |

### Browser backend

| File | Produced by | Contents |
|---|---|---|
| `step-00.png` | `saveOptimizedScreenshot()` | Initial screenshot before loop |
| `step-{NN}-a{M}.png` | `saveOptimizedScreenshot()` | Screenshot after each computer-call action |
| `chrome-started.png` | `capturePhaseScreenshot()` | Screenshot after Chrome launch |
| `runner-log.jsonl` | runner main loop | Per-step Responses API output, action results |
| `recording.mp4` | ffmpeg x11grab | Full-session screen capture |
| `verification-screenshot.png` | `verifyResult()` | Fresh screenshot taken by the verifier |
| `verification.json` | `verifyResult()` | `{passed, raw, evidence, error}` |
| `demo.gif` | `assembleGif()` via ffmpeg | Assembled from `stage-NN-*.png` and `step-NN*.png` files |

---

## Installation

### pip (Python — Android + browser)

```bash
pip install agentprobe
```

`pyyaml` is included in core dependencies — no extra is needed for YAML test cases. The `[yaml]` extra exists for historical reasons and is a no-op.

Requires Python ≥ 3.10. Android target additionally requires `adb` in PATH. Browser target requires `bun`, `xdotool`, `scrot`, and `google-chrome` in PATH.

`python -m agentprobe` is supported via `agentprobe/__main__.py`.

### Bun (browser-only, zero Python)

The browser runner is a Bun/TypeScript script in `browser/`. It is **not published to npm** (`package.json` is `"private": true`). Run it from a repo checkout:

```bash
git clone https://github.com/dzianisv/agentprobe
cd agentprobe
bun install          # installs js-yaml, openai, sharp
bun browser/runner.ts --test-case examples/open-weather.yaml --output-dir /tmp/out
```

Set `AGENTPROBE_BROWSER_DIR` to override the runner location when calling the Python CLI from outside the repo.

---

## pytest Plugin

Registered automatically at install via `pyproject.toml`:

```toml
[project.entry-points."pytest11"]
agentprobe = "agentprobe.pytest_plugin"
```

The plugin exposes a `cua_case` fixture. The fixture takes a `TestCase` object (not a YAML file path) and calls `run_case()`. Use it as:

```python
from agentprobe import TestCase

def test_android_settings(cua_case):
    case = TestCase(
        name="settings-about",
        instruction="Open Settings and navigate to About Phone",
        successCriteria=["About phone section is visible"],
    )
    result = cua_case(case)
    assert result["verdict"] == "pass", result["reason"]
```

Verdict failures raise `pytest.fail()` with the reason string (via the assertion — the fixture itself returns the dict).

---

## Directory Layout

```
agentprobe/           Python package
  __main__.py         Enables python -m agentprobe
  cli.py              Entry point, arg parsing, target dispatch
  loop.py             Android CUA loop (run_cua_step, run_case)
  actions.py          adb action executor
  android.py          screencap, ui_dump, get_screen_size
  case.py             TestCase / Verification dataclasses
  client.py           OpenAI-compatible client factory (Android)
  judge.py            Vision judge (post-loop verdict, Android)
  prompts.py          CUA actor system prompt (Android; messaging-app specific, known gap)
  recording.py        assemble_gif()
  pytest_plugin.py    pytest fixture

browser/              Bun/TypeScript browser backend
  runner.ts           CUA loop + Chrome launch + action executor + verifier
  package.json        Bun dependencies (private: true — not published to npm)

examples/
  android-settings.yaml
  open-weather.yaml
  install-extension.yaml
  android/
    basic_smoke.py         Example Python test case
    opencode_checks.py     Deterministic REST-API checks (pair with opencode-smoke.yaml)
    opencode-smoke.yaml    opencode Android app CUA smoke test
  vibebrowser/
    vibe-install-smoke.yaml     Vibe extension CWS install test
    vibe-sidepanel-smoke.yaml   Vibe side panel open/verify test (requires pre-loaded ext)
    vibe-settings-provider.yaml Vibe settings provider test
    vibebrowser-webapp.yaml     vibebrowser.app landing page smoke test
  screenshots/
    android/          Emulator run screenshots + demo.gif
    browser/          Browser run screenshots + demo.gif

PRD.md                Product requirements
TDD.md                This document
README.md             Quickstart
```

---

## v0.1 Scope Boundaries

**In scope:**
- Android (adb, any device/emulator)
- Browser web apps (`--url`)
- Browser extension — via CWS install flow (`--url`), agent installs through browser UI
- YAML / JSON / Python test case formats
- Vision judge (two-stage evaluation)
- GIF output
- GitHub Actions / Docker usage

**Out of scope for v0.1:**
- iOS / macOS desktop apps
- Parallel test execution
- Test result dashboard / reporting UI
- Cloud device farms (BrowserStack, Firebase Test Lab)
- Deterministic action replay (record + playback)

---

## Pilot Test Cases

Three real-world products are tested via agentprobe in CI. Each maps to a workflow in `.github/workflows/`.

| Workflow | Test case | Target | Install method |
|---|---|---|---|
| `cua-android-app.yml` | `examples/android/opencode-smoke.yaml` | Android | APK downloaded from F-Droid repo, `adb install` before test |
| `cua-chrome-extension.yml` | `examples/vibebrowser/vibe-install-smoke.yaml` | Browser | CUA agent installs from CWS through Chrome UI; scrot+xdotool bypass CWS scripting restriction |
| `cua-chrome-webapp.yml` | `examples/vibebrowser/vibebrowser-webapp.yaml` | Browser | No install; direct navigation to `https://vibebrowser.app`; also runs daily via cron |

### Required CI secrets

| Secret | Used by |
|---|---|
| `AZURE_CUA_API_KEY` | All three pilot workflows (Android + Browser) |
| `AZURE_CUA_BASE_URL` | Optional — overrides Azure endpoint (default: `vibe-dev-ai.cognitiveservices.azure.com`) |

`OPENAI_API_KEY` is a fallback for both backends; `AZURE_CUA_API_KEY` takes precedence when set.
