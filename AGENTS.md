# agentprobe — Agent Instructions

## Project Overview

`agentprobe` is a test harness for computer-use agents testing Android apps and web apps. See [PRD.md](PRD.md) and [TDD.md](TDD.md) for scope.

## Release Gate: Project Readiness

Before shipping, verify all items in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md). Key requirement: **demo artifacts must show meaningful agent interaction** (agent solving problems, not just recognizing static UI).

### What "meaningful" means:
- ✅ Android: Agent computes a math problem (enters 2 numbers, taps operator, verifies result)
- ✅ Browser: Agent navigates a site, waits for content, confirms data is visible
- ❌ Android: Agent just verifies a keypad exists without using it
- ❌ Browser: Agent loads a blank page without checking for content

### Example demo tests:
- `examples/android/calculator_math.py` — compute 27+18, verify result is 45
- `examples/open-weather.yaml` — fetch weather data, confirm temperature visible
- `examples/vibebrowser/vibebrowser-webapp.yaml` — load landing page, confirm content
- `examples/vibebrowser/vibe-install-smoke.yaml` — verify Vibe extension is on CWS

## CI / Quality

All 4 workflows must pass before merge:
1. **Lint** — code style
2. **Browser CUA** — open-weather.yaml (real-world web test)
3. **Android CUA** — calculator_math.py (real-world mobile test)
4. **CUA Chrome Extension** — vibe-install-smoke.yaml (CWS accessibility)

Each CUA job produces:
- Screenshots (step-00.png, step-01-a1.png, ...)
- GIF demo (demo.gif)
- Video recording (recording.mp4 or basic_smoke.mp4)
- Result JSON (result.json)

## Documentation Requirements

- README.md quickstarts (install, use, CI integration) ✅
- docs/ci.md (composite actions, manual setup) ✅
- Example test cases (YAML + Python) ✅
- docs/architecture.md (system design) ✅
- docs/writing-cases.md (how to author tests) ✅

## Adding New Tests

1. Write a test case in YAML or Python
2. Add it to `examples/` or `examples/vibebrowser/`
3. Update `.github/workflows/` if it's a new CI job
4. Ensure the demo GIF shows **real work**, not static verification
5. Verify demo artifacts are uploaded to CI (retention-days: 30)

## CI Integration Helper Actions

Use `.github/actions/agentprobe-android@main` or `.github/actions/agentprobe-browser@main` in other repos:

```yaml
- uses: dzianisv/agentprobe/.github/actions/agentprobe-android@main
  with:
    case: examples/android/my-test.yaml
    output-dir: /tmp/out
  env:
    AZURE_CUA_API_KEY: ${{ secrets.AZURE_CUA_API_KEY }}
    AZURE_CUA_BASE_URL: ${{ secrets.AZURE_CUA_BASE_URL }}
```

See [docs/ci.md](docs/ci.md) for full details.
