---
name: agentprobe-ci
description: Wire agentprobe into GitHub Actions CI. Use when asked to add CUA tests to a CI pipeline for an Android app or browser extension.
---

# agentprobe in GitHub Actions CI

## Android: android-emulator-runner

```yaml
# .github/workflows/android-cua.yml
name: Android CUA
on: [push, pull_request]

jobs:
  cua:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install agentprobe
      - uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 28
          arch: x86_64
          emulator-options: -no-window -gpu swiftshader_indirect -noaudio -no-boot-anim
          disable-animations: true
          script: agentprobe run --target android --case examples/android/basic_smoke.py --output-dir /tmp/cua-output
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: cua-output
          path: /tmp/cua-output/
```

## Browser: containerized Chrome

```yaml
# .github/workflows/browser-cua.yml
name: Browser CUA
on: [push, pull_request]

jobs:
  cua:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/dzianisv/agentprobe:latest
    steps:
      - uses: actions/checkout@v4
      - name: Build extension
        run: npm ci && npm run build
      - name: Run CUA test
        run: |
          agentprobe run --target browser \
            --case browser/cases/google-oauth.ts \
            --extension dist/prod-unpacked \
            --output-dir /tmp/cua-output
        env:
          AZURE_CUA_API_KEY: ${{ secrets.AZURE_CUA_API_KEY }}
          AZURE_CUA_BASE_URL: ${{ secrets.AZURE_CUA_BASE_URL }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: cua-output
          path: /tmp/cua-output/
```

## pytest integration (Android)

```python
# tests/test_my_feature.py
import pytest
from agentprobe import TestCase

def test_onboarding(cua_case):
    case = TestCase(
        name="onboarding",
        instruction="Complete the onboarding flow and reach the home screen.",
        successCriteria="Home screen with dashboard is visible",
        maxSteps=30,
    )
    result = cua_case(case)
    assert result["status"] == "success"
```

```bash
pytest tests/ --co  # list tests
pytest tests/test_my_feature.py -v
```

## Env vars reference

| Var | Used by |
|-----|---------|
| `OPENAI_API_KEY` | Python Android runner |
| `AZURE_DEV_AI_API_KEY` + `AZURE_DEV_AI_BASE_URL` | Python Android runner (Azure Dev AI) |
| `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_ENDPOINT` | Python Android runner (Azure OpenAI) |
| `GEMINI_API_KEY` | Python Android runner (Gemini) |
| `XAI_API_KEY` | Python Android runner (xAI/Grok) |
| `AZURE_CUA_API_KEY` + `AZURE_CUA_BASE_URL` | Browser TS runner |
| `CUA_EXTENSION_ID` | Browser runner (override extension ID) |
