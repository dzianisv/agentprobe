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
```bash
npm install agentprobe
# or
bun add agentprobe
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

# Browser — extension install from CWS (real user flow)
agentprobe run --target browser \
  --case examples/install-extension.yaml \
  --url https://chromewebstore.google.com/detail/vibe/ajfjlohdpfgngdjfafhhcnpmijbbdgln

# Browser — local dev shortcut (skip CWS, load unpacked build directly)
agentprobe run --target browser \
  --case examples/install-extension.yaml \
  --extension dist/extension/dev
```

### Output

Every run writes to `--output-dir` (default: `/tmp/agentprobe-output/`):

| File | Contents |
|---|---|
| `result.json` | `verdict`, `steps`, `reason`, verifier answer |
| `step-001.png … step-NNN.png` | One screenshot per CUA step |
| `demo.gif` | Animated GIF of the full run |

Exit code: `0` = pass, `1` = fail.

### Python API

```python
from agentprobe import TestCase, Verification, run_case

case = TestCase(
    name="open-weather",
    instruction="Navigate to weather.com and find today's NYC temperature",
    successCriteria="Temperature in °F and city name 'New York' visible",
    failureCriteria="Page fails to load or error visible",
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
import pytest
from agentprobe.pytest_plugin import cua_case  # auto-registered on install

def test_open_weather(cua_case):
    result = cua_case("examples/open-weather.yaml")
    assert result["verdict"] == "pass"
```

---

## How the LLM evaluates results

The evaluation runs in two stages:

**Stage 1 — CUA agent (actor):** Drives the device/browser step-by-step. Each step: takes a screenshot, sends it to a vision model with the goal + criteria, receives a JSON action (`click`, `type`, `key`, `scroll`, `wait`, `done`, `fail`). Repeats until `done`/`fail`/`maxSteps`.

**Stage 2 — Vision judge (evaluator):** After the loop ends, a *separate* LLM call sends the **final screenshot** + a YES/NO question to the vision model. The question is either the explicit `verification.prompt` or is derived from `successCriteria`. The judge's YES/NO is the authoritative verdict — it overrides the agent's self-reported status to prevent the agent from hallucinating success.

This two-stage design means the agent can never "claim done" and pass — an independent visual check always confirms.

---

## Success Metrics (v1)

- `pip install agentprobe && agentprobe run --target android --case examples/android-settings.yaml` produces a pass verdict + GIF on a connected emulator.
- `agentprobe run --target browser --case examples/open-weather.yaml` produces a pass verdict + GIF in a headless Chrome environment.
- A CI GitHub Actions workflow using agentprobe runs in under 5 minutes per test case.
- A developer with no prior knowledge can write a working YAML test case by reading the README alone.
