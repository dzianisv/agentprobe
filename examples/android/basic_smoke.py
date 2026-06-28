"""Basic Android smoke test: verifies the Calculator app launches on a bare emulator."""
from agentprobe import TestCase, run_case

case = TestCase(
    name="basic_smoke",
    # com.android.calculator2 is the AOSP calculator, present on all emulator API levels.
    package="com.android.calculator2",
    instruction=(
        "The Calculator app has been launched. "
        "Verify: (1) the numeric keypad with digit buttons 0–9 is visible, "
        "(2) at least one arithmetic operator button (+, −, ×, or ÷) is visible, "
        "(3) there is a display area at the top where results appear. "
        "Report TEST_PASSED if all three are visible. "
        "Report TEST_FAILED if the screen is blank, shows an error, or shows a different app."
    ),
    successCriteria=[
        "Calculator app is open with a numeric keypad visible",
        "Multiple digit buttons are visible on screen",
        "At least one arithmetic operator button (+, −, ×, or ÷) is visible",
    ],
    failureCriteria=[
        "App crashes or shows an error dialog",
        "Screen is blank or shows a different app",
    ],
    maxSteps=8,
)

if __name__ == "__main__":
    result = run_case(case, output_dir="/tmp/agentprobe-output")
    print(f"Verdict: {result['verdict']} -- {result.get('reason', '')}")
    assert result["verdict"] == "pass", f"Test failed: {result.get('reason')}"
