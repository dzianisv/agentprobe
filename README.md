# agentprobe

Test Android apps and browser extensions with a computer-use agent.

An agent looks at screenshots, decides what to tap or type, and runs until the goal is met or the step budget is exhausted. When the run ends, a second vision call judges the final screenshot against the case's success criteria — so a `pass` means the result was actually confirmed on screen, not just claimed by the agent. The run produces a GIF you can inspect to see exactly where it succeeded or got confused.

## Demo: Agents in Action

**Android**: Agent solves arithmetic (computes 27 + 18 = 45)
![Android Calculator Math](assets/android-calculator-math.gif)

**Browser**: Agent navigates Chrome Web Store, verifies Vibe extension is published
![Chrome Extension Verification](assets/extension-vibe-cws.gif)

## Showcase

**Vibe AI Browser Co-Pilot, end to end with CUA (10x speed)**: the agent installs the extension from the real Chrome Web Store on CI (Xvfb + xdotool real clicks + vision-based click targeting), opens the side panel, signs in to Vibe Portal with real keystrokes, then executes an agentic task — "go to duckduckgo and ask when a first gpt model were released" — navigating the browser to duckduckgo.com and answering GPT-1, June 2018, with the reply visible in the side panel. Every step is asserted (CDP page targets, `chrome.storage`, DOM transcript) and screen-recorded.

![Vibe CUA End-to-End Showcase](docs/showcase/vibe-cua-e2e.gif)

Reference implementation: `tests/cua/cws-visual-install.ts` in [VibeTechnologies/VibeWebAgent PR #1504](https://github.com/VibeTechnologies/VibeWebAgent/pull/1504); extraction of these primitives into agentprobe core is tracked in [issue #1](https://github.com/dzianisv/agentprobe/issues/1).

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
cd browser && bun install
```

## Quickstart: Android

Requires: `adb` in PATH, a connected device or emulator, an Azure OpenAI key.

```bash
export AZURE_CUA_API_KEY=...
export AZURE_CUA_BASE_URL=https://<your-resource>.openai.azure.com/
export AZURE_CUA_MODEL=gpt-5.4

agentprobe run \
  --target android \
  --case examples/android/basic_smoke.py \
  --output-dir /tmp/agentprobe-output

open /tmp/agentprobe-output/demo.gif
```

## Quickstart: Browser

Requires: `bun` in PATH, `xdotool`, `scrot`, `ffmpeg`, and an Azure OpenAI key.

```bash
export AZURE_CUA_API_KEY=...
export AZURE_CUA_BASE_URL=https://<your-resource>.openai.azure.com/
export AZURE_CUA_MODEL=gpt-5.4

agentprobe run \
  --target browser \
  --case examples/open-weather.yaml \
  --output-dir /tmp/agentprobe-output

open /tmp/agentprobe-output/demo.gif
```

To test a Chrome extension: write a YAML case whose goal navigates Chrome to the
Chrome Web Store and installs the extension. There is no `--extension` flag — the
agent installs it through the browser UI, just like a user would.

## Example test case

```python
from agentprobe import TestCase, run_case

case = TestCase(
    name="basic_smoke",
    package="com.android.calculator2",   # launches the app before CUA runs
    instruction="Verify the Calculator keypad is visible, then compute 5 + 3 = and confirm the result is 8.",
    successCriteria=["Calculator is open with a numeric keypad", "Result 8 is displayed"],
    failureCriteria=["App crashes or shows error dialog"],
    maxSteps=15,
)

result = run_case(case, output_dir="/tmp/agentprobe-output")
print(result["verdict"], "--", result["reason"])
# pass -- YES. The calculator shows 8 after tapping 5 + 3 =.
```

`run_case` brings the app to foreground, drives the device via the CUA loop, judges
the final screenshot, assembles `demo.gif`, and writes `result.json`.

**Optional: Reasoning captions in GIFs**

Install Pillow to add text overlays showing the agent's reasoning at each step:

```bash
pip install agentprobe[gif-captions]
```

With Pillow installed, `demo.gif` will include text annotations:
- Frame 1: "TAP: Entering digit 2"
- Frame 2: "TAP: Entering digit 7"
- Frame 3: "TAP: Clicking plus operator"
- ...
- Final: "VERIFY: Checking if result 45 is visible"

This makes demos much more educational — viewers see the agent's reasoning in action, not just screenshots.

## Output shape

```
/tmp/agentprobe-output/
  basic_smoke_01.png        # one screenshot per CUA step
  basic_smoke_02.png
  ...
  basic_smoke.mp4           # screen recording (Android)
  demo.gif                  # assembled from all step screenshots
  result.json               # {"verdict": "pass", "reason": "...", "steps": 7}
```

## CI Integration (GitHub Actions)

### Android — one-liner via reusable action

```yaml
jobs:
  cua-android:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: dzianisv/agentprobe/.github/actions/agentprobe-android@main
        with:
          case: examples/android/basic_smoke.py
          api-level: '33'
          apk-path: path/to/app.apk   # optional: install APK before test
          output-dir: /tmp/cua-output
        env:
          AZURE_CUA_API_KEY: ${{ secrets.AZURE_CUA_API_KEY }}
          AZURE_CUA_BASE_URL: ${{ secrets.AZURE_CUA_BASE_URL }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: cua-output
          path: /tmp/cua-output/
```

### Browser — one-liner via reusable action

```yaml
jobs:
  cua-browser:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: dzianisv/agentprobe/.github/actions/agentprobe-browser@main
        with:
          case: examples/open-weather.yaml
          output-dir: /tmp/cua-output
        env:
          AZURE_CUA_API_KEY: ${{ secrets.AZURE_CUA_API_KEY }}
          AZURE_CUA_BASE_URL: ${{ secrets.AZURE_CUA_BASE_URL }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: cua-output
          path: /tmp/cua-output/
```

### Manual setup (without the reusable action)

<details>
<summary>Android full workflow</summary>

```yaml
jobs:
  cua-android:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install agentprobe
      - run: sudo apt-get install -y ffmpeg
      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 33
          arch: x86_64
          emulator-options: -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim -no-snapshot
          disable-animations: true
          script: agentprobe run --target android --case examples/android/basic_smoke.py --output-dir /tmp/cua-output
        env:
          AZURE_CUA_API_KEY: ${{ secrets.AZURE_CUA_API_KEY }}
          AZURE_CUA_BASE_URL: ${{ secrets.AZURE_CUA_BASE_URL }}
          AZURE_CUA_MODEL: gpt-5.4
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: cua-output
          path: /tmp/cua-output/
```

</details>

<details>
<summary>Browser full workflow</summary>

```yaml
jobs:
  cua-browser:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install -e .
      - uses: oven-sh/setup-bun@v2
      - run: cd browser && bun install
      - name: Install system deps
        run: sudo apt-get update && sudo apt-get install -y xvfb xdotool scrot ffmpeg
      - name: Start Xvfb
        run: |
          Xvfb :99 -screen 0 1920x1080x24 &
          echo "DISPLAY=:99" >> $GITHUB_ENV
      - name: Run CUA test
        env:
          AZURE_CUA_API_KEY: ${{ secrets.AZURE_CUA_API_KEY }}
          AZURE_CUA_BASE_URL: ${{ secrets.AZURE_CUA_BASE_URL }}
          CUA_MODEL: gpt-5.4
          DISPLAY: ':99'
        run: agentprobe run --target browser --case examples/open-weather.yaml --output-dir /tmp/cua-output
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: cua-output
          path: /tmp/cua-output/
```

</details>

## Architecture

- **Android**: Python → adb → screenshot → LLM → action → repeat
- **Browser**: TypeScript/Bun → CDP + xdotool → screenshot → LLM → action → repeat
- Shared test-case schema (`TestCase`) works for both targets
- See [docs/architecture.md](docs/architecture.md)

## Writing test cases

See [docs/writing-cases.md](docs/writing-cases.md) and [skills/write-cua-test/SKILL.md](skills/write-cua-test/SKILL.md).

## CI integration docs

See [docs/ci.md](docs/ci.md) and [skills/agentprobe-ci/SKILL.md](skills/agentprobe-ci/SKILL.md).
