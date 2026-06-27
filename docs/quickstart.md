# Quickstart

## Install

```bash
pip install agentprobe
```

Or from source:

```bash
git clone https://github.com/dzianisv/agentprobe
cd agentprobe
pip install -e .
```

## Android quickstart

Requirements: `adb` in PATH, connected device or emulator, LLM API key.

```bash
export OPENAI_API_KEY=sk-...

agentprobe run \
  --target android \
  --case examples/android/basic_smoke.py \
  --output-dir /tmp/agentprobe-output

open /tmp/agentprobe-output/demo.gif
```

## Browser quickstart

Requirements: `bun` in PATH (https://bun.sh), built extension directory, Azure CUA credentials.

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

## View GIF output

```
/tmp/agentprobe-output/
  step-01-screenshot.png
  step-02-tap.png
  ...
  demo.gif
```

`demo.gif` shows each step the agent took. Scan it to see where it succeeded or got confused.
