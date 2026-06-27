"""Example: basic Android app smoke test using agentprobe."""
from agentprobe import TestCase, run_case

case = TestCase(
    name="basic_smoke",
    instruction="Open the app, verify the main screen loads, tap the primary action button.",
    successCriteria="Main screen is visible with a primary action button",
    failureCriteria="App crashes or shows error dialog",
    maxSteps=20,
)

if __name__ == "__main__":
    # run_case drives the device, judges the final screenshot against
    # successCriteria, assembles demo.gif, and writes result.json.
    result = run_case(case, output_dir="/tmp/agentprobe-output")
    print(f"Verdict: {result['verdict']} -- {result.get('reason', '')}")
    assert result["verdict"] == "pass", f"Test failed: {result.get('reason')}"
