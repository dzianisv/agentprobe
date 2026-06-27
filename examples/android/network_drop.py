"""Example: Android network drop resilience test using agentprobe."""
from agentprobe import TestCase, run_case
from agentprobe.android import simulate_network_drop, restore_network

case = TestCase(
    name="network_drop",
    instruction=(
        "Start a file operation in the app. Once it is in progress, "
        "the test will drop the network. Verify the app shows an appropriate "
        "offline/error state and recovers gracefully when connectivity is restored."
    ),
    successCriteria="App shows offline indicator or error, then recovers after network restored",
    failureCriteria="App crashes or hangs without any feedback",
    maxSteps=25,
)

if __name__ == "__main__":
    import threading
    import time

    def drop_and_restore():
        time.sleep(5)
        simulate_network_drop()
        time.sleep(8)
        restore_network()

    t = threading.Thread(target=drop_and_restore, daemon=True)
    t.start()

    result = run_case(case, output_dir="/tmp/agentprobe-output")
    t.join()
    print(f"Verdict: {result['verdict']} -- {result.get('reason', '')}")
