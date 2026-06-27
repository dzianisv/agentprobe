# Agent Guidance for CUA Tests in `tests/cua/`

This file is loaded by AI coding assistants (Claude Code, Cursor, etc.) when
they work in this directory. It defines the QA contract for the CUA tests.
Read this BEFORE modifying anything under `tests/cua/`.

## Role boundaries — must not be conflated

The cws-copilot test has **three** distinct actors. Confusing their roles is
the most common failure mode when iterating on this test:

| Actor | Responsibility |
|-------|---------------|
| **The runner** (`tests/cua/runner.ts`) | Starts Chrome, sets up CDP, runs the CUA loop, auto-fills the Vibe portal sign-in form via CDP, takes screenshots, evaluates verification |
| **The CUA agent** (Azure GPT-5.4 with computer_use_preview tool) | Operates the sidepanel UI as a real user would: click extension icon, click sign-in, type the prompt in the chat input, wait for the response |
| **The Vibe Co-Pilot** (the extension's own AI agent, running inside the sidepanel) | Receives the user's prompt and does the real work — opens tabs, navigates to URLs (e.g. duckduckgo.com), searches, scrapes, summarizes, writes the answer back into the sidepanel chat |

**The feature under test is the Co-Pilot.** The CUA is just simulating a
human operator of the sidepanel. The runner is just plumbing.

Do NOT:
- Make the CUA navigate to web pages itself (that's the Co-Pilot's job).
- Pre-load DuckDuckGo or any other site as Chrome's initial URL (preempts
  the Co-Pilot — it has nothing to do).
- Type credentials yourself from the CUA (the runner auto-fills via CDP).
- Treat the Vibe extension Home page (chrome-extension://...home.html) or
  Settings page as the chat surface — the chat surface is ONLY the sidepanel.

## The pass bar for `cws-copilot` is strict

A run only counts as TEST_PASSED when **both** of these hold in the final
screenshot:

1. **The Vibe sidepanel is OPEN and visible on the right side of the Chrome
   window.** A response shown on a tab — including the Vibe Home page tab,
   Settings tab, DuckDuckGo tab — does NOT satisfy this. The sidepanel is a
   separate Chrome UI surface that occupies a fixed-width column on the
   right edge of the window. Width is typically 350-450 px.

2. **The sidepanel contains an AI-Co-Pilot response describing opencode
   features, changes, or recent release information** (NOT the user's own
   prompt echoed back, NOT a "thinking" / loading state, NOT an error
   message — actual content text the Co-Pilot wrote).

These two conditions are encoded in `cases/cws-copilot.ts`:
- `successCriteria` lists them in human-readable form
- `verification.prompt` asks the verifier model both questions explicitly
- `verifyResult()` in `runner.ts` flips the test to FAIL if the verifier
  answers NO

If you change `cws-copilot.ts`, you MUST keep these conditions intact. A
narrower or looser bar is a regression of the test's anti-hallucination
guard.

## Anti-hallucination guard — do not weaken

`runner.ts:verifyResult()` runs after the CUA loop reports TEST_PASSED. It:
1. Takes a fresh screenshot (NOT the last loop frame — that may show what
   the CUA hallucinated).
2. Calls the vision model with `verification.prompt` from the test case.
3. Parses the YES/NO answer. NO flips the result to FAIL with the
   verifier's evidence as the reason. Verification API errors also force
   FAIL.

The verification call is the second pair of eyes. Without it, the CUA
loop's TEST_PASSED claim is taken at face value — and historically the
model hallucinates success on Gmail tabs, blank pages, and the wrong
sidepanel state. Do not bypass this guard.

## Things the QA test must NOT permit

- TEST_PASSED reported while the sidepanel is closed → must FAIL.
- TEST_PASSED reported while the Co-Pilot is still thinking / spinning →
  must FAIL.
- TEST_PASSED reported with no visible response text in the sidepanel →
  must FAIL.
- TEST_PASSED reported because the Co-Pilot opened DuckDuckGo (visible
  DuckDuckGo tab is not the test outcome — the test outcome is the
  Co-Pilot's reply IN THE SIDEPANEL).
- Sign-in failures or auth loops counted as success.
- Test relying on a pre-authenticated account state (the test must
  exercise the real sign-in flow, even if the runner auto-fills the portal).

## When the test fails

Read the artifacts in this order:
1. `runner-log.jsonl` — per-step actions and outputs.
2. `verification.json` — the verifier's YES/NO and evidence.
3. `verification-screenshot.png` — what the verifier actually saw.
4. `step-*.png` — frames at each CUA action, in order.

Diagnose by reasoning about the role boundaries above. If the model
navigated to a website on its own → the instruction was unclear about
CUA vs Co-Pilot. If the model typed into the wrong field → improve the
coordinate hint or restructure the UI flow. If the sidepanel opened
then closed → check Vibe extension's panel-close events.

## Storage / env you can and can't touch

- `vibe.apiKey.openai`, `vibe.model` in chrome.storage.local — the runner
  seeds placeholder values to make `isExtensionConfigured()` return true
  and skip the auto-open settings tab. Don't seed REAL keys here — the
  test relies on the real sign-in flow to exercise the Vibe Portal auth
  redirect, not on pre-existing AI configuration.
- `VIBE_TEST_EMAIL`, `VIBE_TEST_PASSWORD` env vars — the runner CDP-fills
  the portal form with these. Never log them. Never echo them. They live
  in repo secrets `TEST_FREE_EMAIL` / `TEST_FREE_PASSWORD`.
- `ANTHROPIC_API_KEY` — not used by this test; ignore.

## Where to add new test cases

`tests/cua/cases/<name>.ts`. Each must export `{ name, instruction,
successCriteria, failureCriteria, maxSteps?, verification? }`. If your
test reaches a state the CUA might mis-evaluate (which is essentially any
non-trivial e2e), define `verification.prompt` so the post-loop guard
runs.
