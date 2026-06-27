# Architecture

## Overview

agentprobe is a polyglot test harness: Android tests run a Python CUA loop over ADB;
browser tests run a TypeScript/Bun CUA loop over CDP and xdotool. Both share the same
`TestCase` schema.

## Android: Python + ADB

```
agentprobe run --target android
  -> agentprobe/loop.py:run_case()
      -> run_cua_step(success_criteria, failure_criteria)  # drive the device
          -> screenshot via adb exec-out screencap
          -> LLM call (openai-compatible API)
              system prompt: SYSTEM_PROMPT (actions + rules)
              per-step user msg includes:
                  "SUCCESS when: <successCriteria>"   (if set)
                  "FAIL immediately if: <failureCriteria>"  (if set)
          -> parse JSON action
          -> agentprobe/actions.py:execute_action()
              -> adb shell input tap/type/swipe/...
          -> repeat until done/fail/max_steps
      -> agentprobe/judge.py:judge_result()     # verdict from final screenshot
          -> ask vision model the verification.prompt or successCriteria (YES/NO)
          -> verifier failure → verdict=fail (never silent pass)
      -> agentprobe/recording.py:assemble_gif() # demo.gif from step-*.png
      -> write result.json                      # verdict + reason + steps + gif path
```

`run_cua_step()` drives the UI and returns the loop status (success / failure /
timeout). Each step includes the `successCriteria` and `failureCriteria` in the user
message so the agent knows when to emit `done` or `fail`. The verdict is decided by
`judge_result()`, which sends the FINAL screenshot to the vision model and asks the
case's `verification.prompt` (or its `successCriteria` as a YES/NO question). This is
the anti-hallucination guard: the agent can emit `done` on the wrong screen, but the
verdict comes from an independent look at the result. A verifier API failure is a
fail, never a silent pass.

`result.json` is always written by the Android runner (via `run_case`) and contains
`{"verdict", "reason", "steps", "gif"}`. Browser tests write `verification.json`
instead.

## Browser: TypeScript + Bun + CDP

```
agentprobe run --target browser
  -> bun browser/runner.ts
      -> startChrome() via google-chrome --remote-debugging-port=9222
      -> seedExtensionStorage() via CDP
      -> openSidepanelViaXdotool()
      -> autoFillPortalSignIn() via CDP
      -> CUA loop:
          -> scrot screenshot
          -> LLM call (Azure CUA API, computer_use_preview tool)
          -> executeAction() via xdotool
          -> repeat
      -> verifyResult() anti-hallucination check
      -> assembleGif() via ffmpeg
```

## Why not rewrite everything in Python?

The browser runner uses Bun's native subprocess and WebSocket APIs, and the CDP
interactions are tightly coupled to the Chrome extension's internal structure (data-testid
selectors, service worker targeting, etc.). Rewriting it in Python would produce a
functionally identical but less maintainable copy. The shared `TestCase` schema is the
integration point — both targets consume the same test case definition format.

## Output artifacts

Both targets produce:
- `step-NNN_*.png` — one screenshot per CUA action
- `demo.gif` — assembled from all screenshots
- Android: `result.json` (verdict, reason, steps) + stdout log of actions
- Browser: `runner-log.jsonl`, `verification.json`, `verification-screenshot.png`
