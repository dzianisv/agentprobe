"""CLI entry point for agentprobe."""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def _run_browser(args):
    """Shell out to bun browser/runner.ts with mapped args."""
    # Find runner.ts relative to this package
    package_root = Path(__file__).parent.parent
    runner = package_root / "browser" / "runner.ts"
    if not runner.exists():
        # Try installed location
        runner = Path(__file__).parent.parent / "browser" / "runner.ts"

    if not runner.exists():
        print(f"ERROR: browser/runner.ts not found at {runner}", file=sys.stderr)
        sys.exit(1)

    # Check bun is available
    bun = subprocess.run(["which", "bun"], capture_output=True)
    if bun.returncode != 0:
        print("ERROR: bun not found in PATH. Install from https://bun.sh", file=sys.stderr)
        sys.exit(1)

    cmd = ["bun", str(runner)]
    if args.case:
        cmd += ["--test-case", args.case]
    if args.extension:
        cmd += ["--extension-path", args.extension]
    if args.output_dir:
        cmd += ["--output-dir", args.output_dir]
    if args.max_steps:
        cmd += ["--max-steps", str(args.max_steps)]

    result = subprocess.run(cmd)
    sys.exit(result.returncode)


def _run_android(args):
    """Load case and run CUA loop for Android."""
    from .loop import run_cua_step

    case_path = args.case
    goal = None
    max_steps = args.max_steps or 30
    step_label = "test"

    if case_path.endswith(".py"):
        import importlib.util
        spec = importlib.util.spec_from_file_location("_cua_case", case_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        case = getattr(mod, "case", None)
        if case is None:
            # Try to find any TestCase attribute
            from .case import TestCase
            for attr in dir(mod):
                obj = getattr(mod, attr)
                if isinstance(obj, TestCase):
                    case = obj
                    break
        if case:
            goal = case.instruction
            max_steps = args.max_steps or case.maxSteps
            step_label = case.name
        else:
            print(f"ERROR: No 'case' attribute found in {case_path}", file=sys.stderr)
            sys.exit(1)

    elif case_path.endswith(".json"):
        with open(case_path) as f:
            data = json.load(f)
        goal = data.get("instruction", data.get("goal", ""))
        max_steps = args.max_steps or data.get("maxSteps", 30)
        step_label = data.get("name", "test")

    elif case_path.endswith((".yaml", ".yml")):
        try:
            import yaml
        except ImportError:
            print("ERROR: pyyaml required for YAML cases: pip install pyyaml", file=sys.stderr)
            sys.exit(1)
        with open(case_path) as f:
            data = yaml.safe_load(f)
        goal = data.get("instruction", data.get("goal", ""))
        max_steps = args.max_steps or data.get("maxSteps", 30)
        step_label = data.get("name", "test")

    else:
        print(f"ERROR: Unsupported case format: {case_path}", file=sys.stderr)
        sys.exit(1)

    if not goal:
        print("ERROR: No instruction/goal found in case", file=sys.stderr)
        sys.exit(1)

    model = args.model or os.environ.get("CUA_MODEL", "gpt-4o")
    output_dir = args.output_dir or "/tmp/agentprobe-output"
    os.makedirs(output_dir, exist_ok=True)

    result = run_cua_step(
        goal=goal,
        max_steps=max_steps,
        model=model,
        include_ui_xml=args.include_xml,
        step_label=step_label,
        output_dir=output_dir,
        speed_multiplier=args.speed_multiplier or 1.0,
    )
    print(f"Result: {result['status']} in {result['steps']} steps")
    if result["status"] != "success":
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
                            help="Directory for screenshots and artifacts (default: /tmp/agentprobe-output)")
    run_parser.add_argument("--extension", default=None,
                            help="Path to unpacked browser extension (browser target only)")
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
