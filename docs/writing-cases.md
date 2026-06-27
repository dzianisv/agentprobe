# Writing Test Cases

## Schema

```python
from agentprobe import TestCase, Verification

case = TestCase(
    name="feature_smoke",           # snake_case, unique per suite
    instruction="...",              # NL goal for the agent
    successCriteria="...",          # what PASS looks like on screen
    failureCriteria="...",          # early-abort trigger
    maxSteps=25,                    # hard cap on LLM turns
    verification=Verification(      # optional anti-hallucination check
        prompt="YES/NO: does the screen show X?"
    ),
)
```

## Instruction-writing rules

1. Name UI elements explicitly. "Tap the blue Submit button" beats "submit the form."
2. Include wait hints. "Wait up to 10 seconds for the results screen to load."
3. State the done condition. "Report done when the success dialog is visible."
4. State the fail condition. "Report fail if an error banner appears."
5. Never rely on the Enter key to submit. Always tap the send/submit button.
6. Break long flows into phases with explicit sub-goals.

## successCriteria and failureCriteria

- `successCriteria`: plain English description of what the verifier looks for on screen.
- `failureCriteria`: early-abort trigger — error text, crash dialog, wrong screen.

## Examples

### Minimal case

```python
from agentprobe import TestCase

case = TestCase(
    name="settings_open",
    instruction="Tap the gear icon to open Settings. Report done when the Settings screen is visible.",
    successCriteria="Settings screen with options list is visible",
    maxSteps=10,
)
```

### With verification guard

```python
from agentprobe import TestCase, Verification

case = TestCase(
    name="login_flow",
    instruction="Enter username 'test@example.com', enter password 'demo123', tap Login. Report done when the home screen appears.",
    successCriteria="Home screen with user avatar is visible",
    failureCriteria="Error dialog showing 'Invalid credentials'",
    maxSteps=15,
    verification=Verification(
        prompt="YES or NO: does the screen show a home screen with a user avatar? A login form or error message does NOT count."
    ),
)
```

## Common pitfalls

- `maxSteps` too low: multi-step flows need 30–40 steps.
- Instruction too vague: add button names, expected text.
- Missing `successCriteria`: always add it.
- Android: set one provider's credentials — `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY` (+ `AZURE_OPENAI_ENDPOINT`), `AZURE_DEV_AI_API_KEY` (+ `AZURE_DEV_AI_BASE_URL`), `GEMINI_API_KEY`, or `XAI_API_KEY`.
- Browser: ensure `AZURE_CUA_API_KEY` + `AZURE_CUA_BASE_URL` are set.
