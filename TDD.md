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
    name: str            # slug used in filenames
    instruction: str     # plain-English goal for the CUA actor
    successCriteria: str # what a passing end-state looks like
    failureCriteria: str # conditions that mean fail immediately
    maxSteps: int = 30   # hard cap on CUA loop iterations
    verification: Optional[Verification] = None  # explicit judge prompt
    url: str = ""        # browser only — starting URL

@dataclass
class Verification:
    prompt: str          # YES/NO question asked to the vision judge
```

Loaded from YAML/JSON/Python via `cli._load_case()`. YAML is canonical for human-authored cases.

---

## CUA Loop (Android backend)

`agentprobe/loop.py → run_cua_step()`

```
while step < maxSteps:
    1. screencap via adb → base64 PNG
    2. build user message: goal + criteria + screenshot (vision)
    3. call vision model → JSON action
    4. parse action: {type, x, y, text, key, ms, ...}
    5. execute action via adb input
    6. if action.type == "done" → return success
       if action.type == "fail" → return failure
    7. append to history (last 14 messages kept)
    8. sleep action_delay
→ return timeout if maxSteps reached
```

**Action types (Android):** `click`, `double_click`, `type`, `key`, `scroll`, `drag`, `wait`, `done`, `fail`.

**System prompt** (`agentprobe/prompts.py`): instructs the model to emit one JSON action per turn, to use `done` only when the goal is visually confirmed, and to use `fail` on unrecoverable states.

---

## CUA Loop (Browser backend)

`browser/runner.ts → runTestCase()`

Same logical loop as Android, different transport:

- **Screenshot:** `scrot` captures the Xvfb display → PNG → base64.
- **Actions:** `xdotool` for mouse click/move/type/key/scroll; native JS via CDP for `wait`.
- **Chrome launch:** `chrome --remote-debugging-port=9222 --display=:99`
  - With `--extension`: adds `--load-extension=<path>` (dev shortcut — loads unpacked build).
  - With `--url`: navigates to the given URL as the starting point.
  - Without either: starts at `about:blank`.
- **System prompt:** "Interact with everything visible on screen" (full-page mode, not sidepanel-only).

**Action types (browser):** `click`, `double_click`, `type`, `key`, `scroll`, `drag`, `move`, `wait`, `screenshot`, `done`, `fail`.

---

## Verification / Judge

`agentprobe/judge.py → judge_result()`

Runs after the CUA loop regardless of its outcome.

```
priority:
  1. case.verification.prompt   (explicit YES/NO question)
  2. "Is this satisfied: {successCriteria}? YES or NO."

call: vision model(final_screenshot + question)
  → parse first word of response for YES/NO
  → verdict = "pass" if YES else "fail"

fallback (no question available):
  → verdict = "pass" if loop_status == "success" else "fail"

failure API call → always verdict = "fail" (never silently pass)
```

The judge is always a **separate LLM call** from the CUA actor — different prompt, different message history. This prevents the actor from contaminating the evaluation.

---

## Model Configuration

Configured via environment variables (no hardcoded credentials).

| Var | Purpose |
|---|---|
| `OPENAI_API_KEY` | Use OpenAI directly (gpt-4o by default) |
| `AZURE_CUA_API_KEY` | Azure OpenAI API key |
| `AZURE_CUA_BASE_URL` | Azure endpoint (e.g. `https://xxx.cognitiveservices.azure.com`) |
| `AZURE_CUA_DEPLOYMENT` | Deployment name (e.g. `gpt-4o`, `gpt-5.4`) |
| `CUA_MODEL` | Override model name (default: `gpt-4o`) |

`agentprobe/client.py → make_client()` reads these and returns an `openai.OpenAI`-compatible client.

---

## Output Artifacts

Written to `--output-dir` (default: `/tmp/agentprobe-output/`).

| File | Produced by | Contents |
|---|---|---|
| `step-{name}_{N:02d}.png` | `android.screenshot_b64()` / `scrot` | Raw screenshot per step |
| `demo.gif` | `recording.assemble_gif()` / ffmpeg | Animated playback of all steps |
| `result.json` | `loop.run_case()` | `{verdict, steps, reason, verification}` |

---

## Installation

### pip (Python — Android + browser)

```bash
pip install agentprobe          # core
pip install "agentprobe[yaml]"  # adds pyyaml for YAML test cases
```

Requires Python ≥ 3.10. Android target additionally requires `adb` in PATH. Browser target requires `bun`, `xdotool`, `scrot`, and Chrome in PATH.

### npm / bun (browser-only, zero Python)

The browser runner is a self-contained Bun script. Install as an npm package:

```bash
npm install agentprobe
# or
bun add agentprobe
```

Run directly:

```bash
bunx agentprobe --case examples/open-weather.yaml --url https://weather.com
```

> Note: npm package is planned for v0.2. v0.1 ships the TS runner inside the pip wheel — invoke via `bun browser/runner.ts` from the repo root or set `AGENTPROBE_BROWSER_DIR`.

---

## pytest Plugin

Registered automatically at install via `pyproject.toml`:

```toml
[project.entry-points."pytest11"]
agentprobe = "agentprobe.pytest_plugin"
```

The plugin exposes a `cua_case` fixture that loads a YAML file and calls `run_case()`. Verdict failures raise `pytest.fail()` with the reason string.

---

## Directory Layout

```
agentprobe/           Python package
  cli.py              Entry point, arg parsing, target dispatch
  loop.py             Android CUA loop (run_cua_step, run_case)
  actions.py          adb action executor
  android.py          screencap, ui_dump, get_screen_size
  case.py             TestCase / Verification dataclasses
  client.py           OpenAI-compatible client factory
  judge.py            Vision judge (post-loop verdict)
  prompts.py          CUA actor system prompt
  recording.py        assemble_gif()
  pytest_plugin.py    pytest fixture

browser/              Bun/TypeScript browser backend
  runner.ts           CUA loop + Chrome launch + action executor
  cases/              Example test cases (TypeScript modules)
  package.json        Bun dependencies

examples/
  android-settings.yaml
  open-weather.yaml
  install-extension.yaml
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
- Browser extension — via CWS install flow (`--url`) or local dev shortcut (`--extension`)
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
