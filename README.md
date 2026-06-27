# agentprobe

Test Android apps and browser extensions with a computer-use agent.

An agent looks at screenshots, decides what to tap or type, and runs until the goal is met or the step budget is exhausted. When the run ends, a second vision call judges the final screenshot against the case's success criteria — so a `pass` means the result was actually confirmed on screen, not just claimed by the agent. The run produces a GIF you can inspect to see exactly where it succeeded or got confused.

## What it is / what it isn't

- **Is**: a test harness that drives a real Android device (via adb) or real Chrome (via CDP) using an LLM agent
- **Is not**: a record-and-replay tool, a UI automator, or a headless browser test runner

## Install

```bash
pip install agentprobe          # Python Android runner
```

The browser backend is a Bun/TypeScript runner that lives in `browser/` and runs from
a repo checkout — it is not shipped inside the pip package. For `--target browser`,
clone the repo and install [bun](https://bun.sh):

```bash
git clone https://github.com/dzianisv/agentprobe
cd agentprobe
pip install -e .
```

## Quickstart: Android

Requires: `adb` in PATH, a connected device or emulator, an LLM API key.

```bash
export OPENAI_API_KEY=sk-...

agentprobe run \
  --target android \
  --case examples/android/basic_smoke.py \
  --output-dir /tmp/agentprobe-output

open /tmp/agentprobe-output/demo.gif
```

## Quickstart: Browser extension

Requires: `bun` in PATH, a built extension directory, Azure CUA credentials.

```bash
export AZURE_CUA_API_KEY=...
export AZURE_CUA_BASE_URL=https://...

agentprobe run \
  --target browser \
  --case browser/cases/google-oauth.ts \
  --extension /path/to/ext/dist/prod-unpacked \
  --output-dir /tmp/agentprobe-output

open /tmp/agentprobe-output/demo.gif
```

## Example test case

```python
from agentprobe import TestCase, run_case

case = TestCase(
    name="basic_smoke",
    instruction="Open the app, verify the main screen loads, tap the primary action button.",
    successCriteria="Main screen is visible with a primary action button",
    failureCriteria="App crashes or shows error dialog",
    maxSteps=20,
)

result = run_case(case, output_dir="/tmp/agentprobe-output")
print(result["verdict"], "--", result["reason"])
# pass -- YES. The main screen shows a dashboard with a blue "Start" action button.
```

`run_case` drives the device, judges the final screenshot against `successCriteria`
(or `verification.prompt` if set), assembles `demo.gif`, and writes `result.json`.

## Output shape

```
/tmp/agentprobe-output/
  step-001_basic_smoke_01.png   # one screenshot per CUA step
  step-002_basic_smoke_02.png
  ...
  demo.gif                      # assembled from all step screenshots
  result.json                   # {"verdict": "pass", "reason": "...", "steps": 7}
```

## Architecture

- **Android**: Python → adb → screenshot → LLM → action → repeat
- **Browser**: TypeScript/Bun → CDP + xdotool → screenshot → LLM → action → repeat
- Shared test-case schema (`TestCase`) works for both targets
- See [docs/architecture.md](docs/architecture.md)

## Writing test cases

See [docs/writing-cases.md](docs/writing-cases.md) and [skills/write-cua-test/SKILL.md](skills/write-cua-test/SKILL.md).

## CI integration

See [docs/ci.md](docs/ci.md) and [skills/agentprobe-ci/SKILL.md](skills/agentprobe-ci/SKILL.md).
