"""Example: basic Android app smoke test using agentprobe."""
from agentprobe import TestCase, run_cua_step

case = TestCase(
    name="basic_smoke",
    instruction="Open the app, verify the main screen loads, tap the primary action button.",
    successCriteria="Main screen is visible with a primary action button",
    failureCriteria="App crashes or shows error dialog",
    maxSteps=20,
)

if __name__ == "__main__":
    result = run_cua_step(
        goal=case.instruction,
        max_steps=case.maxSteps,
        step_label=case.name,
        output_dir="/tmp/agentprobe-output",
    )
    print(f"Result: {result['status']}")
    assert result["status"] == "success", f"Test failed: {result}"
