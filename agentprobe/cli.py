"""CLI entry point for agentprobe."""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def _find_browser_runner():
    """Locate browser/runner.ts.

    The browser backend is a Bun/TypeScript directory, not a Python module, so
    it is not shipped inside the installed Python package. It runs from a repo
    checkout. We look, in order:
      1. AGENTPROBE_BROWSER_DIR env var (explicit override)
      2. <package>/../browser/runner.ts   (editable install / repo checkout)
      3. ./browser/runner.ts              (cwd is the repo root)
    Returns a Path or None.
    """
    env_dir = os.environ.get("AGENTPROBE_BROWSER_DIR")
    candidates = []
    if env_dir:
        candidates.append(Path(env_dir) / "runner.ts")
    candidates.append(Path(__file__).resolve().parent.parent / "browser" / "runner.ts")
    candidates.append(Path.cwd() / "browser" / "runner.ts")
    for c in candidates:
        if c.exists():
            return c
    return None


def _run_browser(args):
    """Shell out to bun browser/runner.ts with mapped args."""
    runner = _find_browser_runner()
    if runner is None:
        print(
            "ERROR: browser backend not found.\n"
            "The browser target runs from a repo checkout (it is a Bun/TypeScript\n"
            "runner, not part of the installed Python package). Either:\n"
            "  - run agentprobe from a clone of https://github.com/dzianisv/agentprobe, or\n"
            "  - set AGENTPROBE_BROWSER_DIR to the directory containing runner.ts.\n"
            "See docs/quickstart.md for details.",
            file=sys.stderr,
        )
        sys.exit(2)

    if shutil.which("bun") is None:
        print("ERROR: bun not found in PATH. Install from https://bun.sh", file=sys.stderr)
        sys.exit(2)

    cmd = ["bun", str(runner), "--test-case", args.case]
    if args.output_dir:
        cmd += ["--output-dir", args.output_dir]
    if args.max_steps:
        cmd += ["--max-steps", str(args.max_steps)]
    if args.url:
        cmd += ["--url", args.url]

    result = subprocess.run(cmd)
    sys.exit(result.returncode)


def _load_case(case_path, max_steps_override):
    """Load a TestCase from a .py, .json, or .yaml file. Returns a TestCase."""
    from .case import TestCase, Verification

    def _from_dict(data):
        verification = None
        v = data.get("verification")
        if isinstance(v, dict) and v.get("prompt"):
            verification = Verification(prompt=v["prompt"])
        raw_success = data.get("successCriteria", data.get("criteria", []))
        raw_failure = data.get("failureCriteria", [])
        if isinstance(raw_success, str):
            raw_success = [raw_success] if raw_success.strip() else []
        if isinstance(raw_failure, str):
            raw_failure = [raw_failure] if raw_failure.strip() else []
        return TestCase(
            name=data.get("name", "test"),
            instruction=data.get("instruction", data.get("goal", "")),
            successCriteria=raw_success,
            failureCriteria=raw_failure,
            maxSteps=max_steps_override or data.get("maxSteps", 30),
            verification=verification,
            url=data.get("url", ""),
            systemPromptExtra=data.get("systemPromptExtra", ""),
            package=data.get("package", ""),
        )

    if case_path.endswith(".py"):
        import importlib.util
        spec = importlib.util.spec_from_file_location("_cua_case", case_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        case = getattr(mod, "case", None)
        if case is None:
            for attr in dir(mod):
                obj = getattr(mod, attr)
                if isinstance(obj, TestCase):
                    case = obj
                    break
        if case is None:
            print(f"ERROR: No TestCase 'case' found in {case_path}", file=sys.stderr)
            sys.exit(2)
        if max_steps_override:
            case.maxSteps = max_steps_override
        return case

    if case_path.endswith(".json"):
        with open(case_path) as f:
            return _from_dict(json.load(f))

    if case_path.endswith((".yaml", ".yml")):
        try:
            import yaml
        except ImportError:
            print("ERROR: pyyaml required for YAML cases: pip install agentprobe[yaml]",
                  file=sys.stderr)
            sys.exit(2)
        with open(case_path) as f:
            return _from_dict(yaml.safe_load(f))

    print(f"ERROR: Unsupported case format: {case_path}", file=sys.stderr)
    sys.exit(2)


def _run_android(args):
    """Load case and run it for Android, printing a verdict."""
    from .loop import run_case

    case = _load_case(args.case, args.max_steps)
    if not case.instruction:
        print("ERROR: case has no instruction/goal", file=sys.stderr)
        sys.exit(2)

    model = args.model or os.environ.get("CUA_MODEL", "gpt-4o")
    output_dir = args.output_dir or "/tmp/agentprobe-output"

    result = run_case(
        case,
        model=model,
        include_ui_xml=args.include_xml,
        output_dir=output_dir,
        speed_multiplier=args.speed_multiplier or 1.0,
    )

    if result.get("verdict") == "pass":
        print(f"RESULT: pass ({result['steps']} steps)")
        sys.exit(0)
    else:
        print(f"RESULT: fail ({result.get('reason', 'unknown')})")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        prog="agentprobe",
        description="Test Android apps and browser extensions with a computer-use agent",
    )
    subparsers = parser.add_subparsers(dest="command")

    run_parser = subparsers.add_parser("run", help="Run a CUA test case")
    run_parser.add_argument("--target", choices=["android", "browser"], required=True,
                            help="Test target: android (adb) or browser (bun/CDP)")
    run_parser.add_argument("--case", required=True,
                            help="Path to test case file (.py, .json, .yaml, or .ts for browser)")
    run_parser.add_argument("--model", default=None,
                            help="LLM model name (default: gpt-4o)")
    run_parser.add_argument("--output-dir", default=None,
                            help="Directory for screenshots, demo.gif, result.json (default: /tmp/agentprobe-output)")
    run_parser.add_argument("--url", default=None,
                            help="Starting URL for browser (browser target only)")
    run_parser.add_argument("--max-steps", type=int, default=None,
                            help="Override maximum CUA steps")
    run_parser.add_argument("--include-xml", action="store_true",
                            help="Include UI hierarchy XML in LLM context (Android only)")
    run_parser.add_argument("--speed-multiplier", type=float, default=1.0,
                            help="Action timing multiplier: <1.0 = faster, >1.0 = slower")

    if len(sys.argv) == 1:
        parser.print_help()
        sys.exit(0)

    args = parser.parse_args()

    if args.command == "run":
        if args.target == "browser":
            _run_browser(args)
        else:
            _run_android(args)
    else:
        parser.print_help()
        sys.exit(0)


if __name__ == "__main__":
    main()
