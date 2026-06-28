# agentprobe — Product Requirements Document

## Problem

Testing Android apps and web apps today requires either:
- **Manual QA** — slow, not repeatable, doesn't scale.
- **Scripted automation** (Espresso, Playwright, Selenium) — brittle selectors break on every UI change; can't test flows that require human-like reasoning.

Computer-use AI agents can drive any UI without selectors. But wiring a vision model into a test harness (screencap → LLM → action → repeat → judge) requires non-trivial infrastructure that every team rebuilds from scratch.

**agentprobe** is that infrastructure, packaged and reusable.

---

## Goal

Ship a single installable package that lets any developer write a CUA test case in 10 lines, run it against a real Android device or web app, and get a structured pass/fail verdict — with screenshots and a GIF as evidence.

---

## Target Users

| User | Goal |
|---|---|
| Mobile developer | Verify an Android app flow works end-to-end without a UI framework |
| Web developer | Smoke-test a web app or browser extension install flow |
| QA / CI engineer | Gate PRs on a CUA test that runs in Docker with no manual setup |

---

## Developer Interface

### Installation

**Python (Android + browser):**
```bash
pip install agentprobe
```

**Node / Bun (browser-only, zero-Python option):**

The browser runner is a Bun/TypeScript script — it is not published to npm (`package.json` is `private: true`). Clone the repo and invoke it directly:

```bash
git clone https://github.com/dzianisv/agentprobe
cd agentprobe
bun install
bun browser/runner.ts --test-case examples/open-weather.yaml --output-dir /tmp/out
```

### Defining a test case

Test cases are plain YAML (or JSON / Python dataclass). One file = one test.

```yaml
# examples/open-weather.yaml  — web app example
name: open-weather
url: https://weather.com
goal: Navigate to weather.com and find today's temperature for New York
successCriteria:
  - A temperature in degrees Fahrenheit is visible on screen
  - The city name "New York" appears on screen
failureCriteria:
  - Page fails to load after 30 seconds
  - Error message visible
verification:
  prompt: "Does this screenshot show a weather forecast for New York with a temperature in °F? Answer YES or NO."
maxSteps: 15
```

```yaml
# examples/android-settings.yaml  — Android example
name: android-settings-about
goal: Open the Settings app and navigate to About Phone
successCriteria:
  - Settings app is open
  - "About phone" section is visible
failureCriteria:
  - App crashes or shows an error
verification:
  prompt: "Does this screenshot show the About Phone section inside Android Settings? Answer YES or NO."
maxSteps: 10
```

### Running a test

```bash
# Android (device or emulator connected via adb)
agentprobe run --target android --case examples/android-settings.yaml

# Browser web app
agentprobe run --target browser --case examples/open-weather.yaml

# Browser — extension install from CWS (agent installs through browser UI)
agentprobe run --target browser \
  --case examples/vibebrowser/vibe-install-smoke.yaml
```

Extensions are installed through the Chrome Web Store UI by the CUA agent — there is no `--extension` / `--load-extension` flag. For dev builds, navigate the agent to `chrome://extensions` and have it load the unpacked directory through the UI.

`python -m agentprobe` is equivalent to `agentprobe`.

### Output

Every run writes to `--output-dir` (default: `/tmp/agentprobe-output/`):

| File | Target | Contents |
|---|---|---|
| `result.json` | Android | `verdict`, `steps`, `reason`, verifier answer |
| `step-{NNN}_{label}.png` | Android | One screenshot per CUA step |
| `step-{NN}-a{M}.png` | Browser | Screenshot after each computer-call action |
| `runner-log.jsonl` | Browser | Per-step response JSON from the Responses API |
| `recording.mp4` | Browser | Full-session screen capture via ffmpeg/x11grab |
| `verification.json` | Browser | Post-loop verifier result (when `verification` defined) |
| `demo.gif` | Both | Animated GIF of the full run |

Exit code: `0` = pass, `1` = fail.

### Python API

```python
from agentprobe import TestCase, Verification, run_case

case = TestCase(
    name="open-weather",
    instruction="Navigate to weather.com and find today's NYC temperature",
    successCriteria=["Temperature in °F and city name 'New York' visible"],
    failureCriteria=["Page fails to load or error visible"],
    verification=Verification(
        prompt="Does the screenshot show a NYC weather forecast with a temperature? YES or NO."
    ),
    maxSteps=15,
)

result = run_case(case, output_dir="./test-output")
assert result["verdict"] == "pass", result["reason"]
```

### pytest integration

```python
# conftest.py or test_flows.py
from agentprobe import TestCase, Verification

def test_open_weather(cua_case):  # fixture auto-registered on pip install
    case = TestCase(
        name="open-weather",
        instruction="Navigate to weather.com and find today's NYC temperature",
        successCriteria=["Temperature in °F and city name 'New York' visible"],
    )
    result = cua_case(case)
    assert result["verdict"] == "pass"
```

The `cua_case` fixture takes a `TestCase` object (not a YAML file path). It calls `run_case()` and returns the verdict dict.

---

## How the LLM evaluates results

The evaluation runs in two stages:

**Stage 1 — CUA agent (actor):** Drives the device/browser step-by-step. Each step: takes a screenshot, sends it to a vision model with the goal + criteria, receives a JSON action. Repeats until completion or `maxSteps`.

**Stage 2 — Vision judge (evaluator):** After the loop ends, an independent LLM call sends the **final screenshot** + a YES/NO question to the vision model. The judge's YES/NO is the authoritative verdict — it overrides the agent's self-reported status to prevent hallucinated success.

Per-backend nuance:
- **Android** (`judge.py`): always runs the judge if a screenshot is available. Question priority: (1) `verification.prompt`, (2) question derived from `successCriteria`. Uses `chat.completions`.
- **Browser** (`runner.ts → verifyResult()`): only runs the verifier when the loop reports `TEST_PASSED` AND the case defines `verification`. Uses only `verification.prompt` — `successCriteria` alone does not trigger a vision check. Uses the OpenAI Responses API.

This two-stage design means the agent can never "claim done" and pass — an independent visual check always confirms (when configured).

---

## Pilot Projects

Three real-world products use agentprobe as their primary CUA test harness. Each runs in GitHub Actions CI.

### 1. opencode Android App

| | |
|---|---|
| **App** | opencode — mobile AI coding assistant |
| **Install** | APK downloaded from F-Droid repo at `https://dzianisv.github.io/opencode-mobile/fdroid/repo/` and side-loaded via `adb install` before the test |
| **Workflow** | `.github/workflows/cua-android-app.yml` |
| **Test case** | `examples/android/opencode-smoke.yaml` |

**Test scenario (derived from `examples/android/opencode_checks.py`):**
1. Launch the opencode app from the Android launcher
2. Start a new coding session
3. Send prompt: *"Write a hello world Python script and save it as hello.py"*
4. Wait for the AI to respond (30–90 seconds)
5. Verify the response contains Python code or a file-creation confirmation

**Acceptance criteria:**
- App launches and shows chat interface
- AI responds with code — no crash, error dialog, or blank screen
- Vision judge confirms Python code is visible in the response

**Fail criteria:**
- App crashes on startup
- No AI response within 120 seconds
- Network error or "connection refused" dialog

---

### 2. Vibe AI Chrome Extension

| | |
|---|---|
| **Extension** | Vibe AI — CWS ID `djodpgokbmobeclicaicnnidccoinado` |
| **Install** | Chrome starts clean; CUA agent navigates to the CWS listing and clicks "Add to Chrome" through the browser UI. `scrot` + `xdotool` are used (system-level X11 tools that bypass Chrome's scripting restriction on the Web Store). |
| **Workflow** | `.github/workflows/cua-chrome-extension.yml` |
| **Test case** | `examples/vibebrowser/vibe-install-smoke.yaml` |

**Test scenario:**
1. Open Chrome at the Vibe CWS listing
2. Click "Add to Chrome"
3. Confirm the install dialog ("Add extension")
4. Verify the Vibe toolbar icon appears or a "Vibe was added to Chrome" notification shows

**Acceptance criteria:**
- Vibe extension installs without error
- Toolbar icon or install confirmation is visible
- Vision judge confirms install evidence in final screenshot

**Fail criteria:**
- "Add to Chrome" button not found on the page
- Install dialog dismissed without confirming
- Error during install or "Item not available" (wrong extension ID)

---

### 3. vibebrowser.app Web App

| | |
|---|---|
| **URL** | `https://vibebrowser.app` |
| **Install** | None — public web app, browser navigates directly |
| **Workflow** | `.github/workflows/cua-chrome-webapp.yml` — runs on push **and** daily at 08:00 UTC |
| **Test case** | `examples/vibebrowser/vibebrowser-webapp.yaml` |

**Test scenario:**
1. Navigate to `https://vibebrowser.app`
2. Verify product branding (VibeBrowser name/logo) is visible
3. Scroll to confirm real product content exists (features, pricing, or screenshots)
4. Verify at least one CTA button is present ("Download", "Add to Chrome", "Get started")

**Acceptance criteria:**
- Page loads without HTTP errors
- VibeBrowser branding visible
- At least one CTA button found
- No maintenance / placeholder page

**Fail criteria:**
- 404, 500, or Cloudflare error page
- Maintenance or "coming soon" placeholder
- No product content after 30 seconds

---

## Success Metrics (v1)

- `pip install agentprobe && agentprobe run --target android --case examples/android-settings.yaml` produces a pass verdict + GIF on a connected emulator.
- `agentprobe run --target browser --case examples/open-weather.yaml` produces a pass verdict + GIF in a headless Chrome environment.
- A CI GitHub Actions workflow using agentprobe runs in under 5 minutes per test case.
- A developer with no prior knowledge can write a working YAML test case by reading the README alone.
- `agentprobe run --target android --case examples/android/opencode-smoke.yaml` installs the opencode app from F-Droid and produces a pass verdict against a real Android emulator in CI.
- `agentprobe run --target browser --case examples/vibebrowser/vibe-install-smoke.yaml` and `examples/vibebrowser/vibebrowser-webapp.yaml` produce pass verdicts verifying the Vibe extension CWS install and the vibebrowser.app landing page.
