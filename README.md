# agentprobe

Test Android apps and browser extensions with a computer-use agent.

An agent looks at screenshots, decides what to tap or type, and runs until the goal is met or the step budget is exhausted. The run produces a GIF you can inspect to see exactly where it succeeded or got confused.

## What it is / what it isn't

- **Is**: a test harness that drives a real Android device (via adb) or real Chrome (via CDP) using an LLM agent
- **Is not**: a record-and-replay tool, a UI automator, or a headless browser test runner

## Install

```bash
pip install agentprobe          # Python Android runner
# Browser runner needs bun: https://bun.sh
```

Or from source:
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
from agentprobe import TestCase, run_cua_step

case = TestCase(
    name="basic_smoke",
    instruction="Open the app, verify the main screen loads, tap the primary action button.",
    successCriteria="Main screen is visible with a primary action button",
    failureCriteria="App crashes or shows error dialog",
    maxSteps=20,
)

result = run_cua_step(
    goal=case.instruction,
    max_steps=case.maxSteps,
    step_label=case.name,
    output_dir="/tmp/agentprobe-output",
)
print(result)
# {'status': 'success', 'steps': 7, 'last_screenshot': '...'}
```

## Output shape

```
/tmp/agentprobe-output/
  step-01-screenshot.png
  step-02-tap.png
  ...
  step-07-done.png
  demo.gif
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
