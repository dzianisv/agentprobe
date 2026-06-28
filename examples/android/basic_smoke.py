"""Basic Android smoke test: verifies the Calculator app launches on a bare emulator."""
from agentprobe import TestCase, run_case

case = TestCase(
    name="basic_smoke",
    # com.android.calculator2 is the AOSP calculator, present on all emulator API levels.
    package="com.android.calculator2",
    instruction=(
        "The Calculator app is open. Verify the numeric keypad is visible with digit "
        "buttons (0–9) and at least one operator button (+, −, ×, or ÷). "
        "Tap the digit '5', then the '+' button, then '3', then '=' and confirm the "
        "result '8' appears. Report TEST_PASSED once you see the result."
    ),
    successCriteria=[
        "Calculator app is open with a numeric keypad visible",
        "Digit buttons 0-9 are visible on screen",
        "The result '8' is displayed after entering 5 + 3 =",
    ],
    failureCriteria=[
        "App crashes or shows an error dialog",
        "The display does not update after tapping digits",
    ],
    maxSteps=15,
)

if __name__ == "__main__":
    result = run_case(case, output_dir="/tmp/agentprobe-output")
    print(f"Verdict: {result['verdict']} -- {result.get('reason', '')}")
    assert result["verdict"] == "pass", f"Test failed: {result.get('reason')}"
