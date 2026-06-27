# Architecture

## Overview

agentprobe is a polyglot test harness: Android tests run a Python CUA loop over ADB;
browser tests run a TypeScript/Bun CUA loop over CDP and xdotool. Both share the same
`TestCase` schema.

## Android: Python + ADB

```
agentprobe run --target android
  -> agentprobe/loop.py:run_cua_step()
      -> screenshot via adb exec-out screencap
      -> LLM call (openai-compatible API)
      -> parse JSON action
      -> agentprobe/actions.py:execute_action()
          -> adb shell input tap/type/swipe/...
      -> repeat until done/fail/max_steps
      -> agentprobe/recording.py:assemble_gif()
```

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
- `step-NN-*.png` — one screenshot per CUA action
- `demo.gif` — assembled from all screenshots
- Android: stdout log of actions
- Browser: `runner-log.jsonl`, `verification.json`, `verification-screenshot.png`
