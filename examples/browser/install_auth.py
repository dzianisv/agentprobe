"""
Example: run a browser CUA test via the agentprobe CLI.

Usage:
    agentprobe run \\
        --target browser \\
        --case browser/cases/google-oauth.ts \\
        --extension /path/to/ext/dist/prod-unpacked \\
        --output-dir /tmp/agentprobe-output

Or invoke programmatically (shells out to bun):
    python examples/browser/install_auth.py /path/to/ext
"""
import subprocess
import sys


def run_browser_case(extension_path: str, output_dir: str = "/tmp/agentprobe-output"):
    cmd = [
        "agentprobe", "run",
        "--target", "browser",
        "--case", "browser/cases/google-oauth.ts",
        "--extension", extension_path,
        "--output-dir", output_dir,
    ]
    result = subprocess.run(cmd)
    return result.returncode == 0


if __name__ == "__main__":
    ext = sys.argv[1] if len(sys.argv) > 1 else "/path/to/ext/dist/prod-unpacked"
    ok = run_browser_case(ext)
    sys.exit(0 if ok else 1)
