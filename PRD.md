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
  --case examples/install-extension.yaml \
  --url https://chromewebstore.google.com/detail/vibe/ajfjlohdpfgngdjfafhhcnpmijbbdgln
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

## Success Metrics (v1)

- `pip install agentprobe && agentprobe run --target android --case examples/android-settings.yaml` produces a pass verdict + GIF on a connected emulator.
- `agentprobe run --target browser --case examples/open-weather.yaml` produces a pass verdict + GIF in a headless Chrome environment.
- A CI GitHub Actions workflow using agentprobe runs in under 5 minutes per test case.
- A developer with no prior knowledge can write a working YAML test case by reading the README alone.
