"""Bench case: navigate Chrome to example.com and verify the page loaded.

Written to run against the actual bench emulator image (android-30 AVD
"ocx"), which does NOT have a calculator app (see settings_search.py for the
same note) but DOES have com.android.chrome. example.com is used as the
target page because it renders a single unambiguous heading ("Example
Domain") with no dynamic content, cookie banners, or JS-heavy UI -- a clean,
vision-judgeable success signal.
"""
from agentprobe import TestCase, run_case

case = TestCase(
    name="chrome_navigate",
    package="com.android.chrome",
    instruction=(
        "The Chrome app has been launched. "
        "Your task: tap the address bar (omnibox) at the top, "
        "clear any existing text, type 'example.com', and press enter/go "
        "to navigate. Wait for the page to finish loading. "
        "Report TEST_PASSED once the page showing the heading 'Example Domain' is visible. "
        "Report TEST_FAILED if Chrome crashes, shows a 'no internet' or DNS error page, "
        "or a different page loads."
    ),
    successCriteria=[
        "The heading 'Example Domain' is visible on the loaded web page",
        "The Chrome address bar shows example.com (or a URL containing it)",
    ],
    failureCriteria=[
        "Chrome crashes or shows an error dialog",
        "An error page (e.g. 'no internet', DNS failure, 'Page not available') is shown instead",
    ],
    maxSteps=12,
)

if __name__ == "__main__":
    result = run_case(case, output_dir="/tmp/agentprobe-output")
    print(f"Verdict: {result['verdict']} -- {result.get('reason', '')}")
    assert result["verdict"] == "pass", f"Test failed: {result.get('reason')}"
