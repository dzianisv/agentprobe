"""Bench case: search for "Wi-Fi" inside Android Settings.

Written to run against the actual bench emulator image (android-30 AVD
"ocx"), which does NOT have a calculator app (neither com.android.calculator2
nor com.google.android.calculator) -- examples/android/calculator_math.py and
basic_smoke.py cannot run on it. com.android.settings IS present and stable
across API levels, so this exercises real multi-step CUA (find the search
affordance, type into it, read live results) without depending on an app
that may not exist on a given image.
"""
from agentprobe import TestCase, run_case

case = TestCase(
    name="settings_search",
    package="com.android.settings",
    instruction=(
        "The Settings app has been launched. "
        "Your task: find and tap the search icon (usually a magnifying glass "
        "near the top of the screen), type 'Wi-Fi' into the search field, "
        "and wait for search results to appear. "
        "Report TEST_PASSED once a list of search results related to Wi-Fi is visible. "
        "Report TEST_FAILED if the app crashes, no search field can be found, "
        "or typing 'Wi-Fi' produces no results after a few seconds."
    ),
    successCriteria=[
        "The Settings search screen is shown with the query 'Wi-Fi' entered",
        "At least one search result related to Wi-Fi is visible in a list below the search field",
    ],
    failureCriteria=[
        "App crashes or shows an error dialog",
        "The screen is blank or still shows the Settings home screen with no search results",
    ],
    maxSteps=12,
)

if __name__ == "__main__":
    result = run_case(case, output_dir="/tmp/agentprobe-output")
    print(f"Verdict: {result['verdict']} -- {result.get('reason', '')}")
    assert result["verdict"] == "pass", f"Test failed: {result.get('reason')}"
