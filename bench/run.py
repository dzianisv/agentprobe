"""bench.run -- multi-backend CUA benchmark runner built on top of agentprobe.

Runs the same TestCase(s) across multiple OpenAI-compatible backends (defined
in bench/backends.yaml), records pass/fail/error verdicts, timing, token/cost
data (when available), and produces a markdown + HTML leaderboard via
bench/report.py.

Example:
    python -m bench.run \\
        --cases examples/android/calculator_math.py,examples/android/basic_smoke.py \\
        --backends azure-gpt4o,gemini-flash \\
        --repeat 1 --output-dir /tmp/bench --dry-run
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yaml

from agentprobe.cli import _load_case

BENCH_DIR = Path(__file__).resolve().parent
DEFAULT_BACKENDS_YAML = BENCH_DIR / "backends.yaml"

_ENV_PLACEHOLDER_RE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _seed_for(*parts: str) -> int:
    """Deterministic seed derived from the given strings (stable across processes,
    unlike builtin hash() which is randomized per-run for str)."""
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


# ---------------------------------------------------------------------------
# Backend registry
# ---------------------------------------------------------------------------

def load_backends_registry(path: str | Path = None) -> dict:
    """Load bench/backends.yaml into an ordered {name: config_dict} mapping."""
    path = Path(path) if path else DEFAULT_BACKENDS_YAML
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    registry = {}
    for entry in data.get("backends", []) or []:
        registry[entry["name"]] = entry
    return registry


def resolve_base_url(backend_cfg: dict) -> str | None:
    """Resolve a backend's base_url, substituting ${ENV_VAR} placeholders.

    A base_url value of the literal form "${SOME_VAR}" is replaced with
    os.environ.get("SOME_VAR"). Any other string is used as-is. Returns None
    if unresolved/empty so callers can fail that backend run gracefully.
    """
    raw = backend_cfg.get("base_url")
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    m = _ENV_PLACEHOLDER_RE.match(raw)
    if m:
        return os.environ.get(m.group(1)) or None
    return raw or None


# ---------------------------------------------------------------------------
# Cost math (pure, testable)
# ---------------------------------------------------------------------------

def compute_cost_usd(tokens_in, tokens_out, cost_per_1m_input, cost_per_1m_output):
    """Return USD cost for a run, or None if token counts are unknown."""
    if tokens_in is None or tokens_out is None:
        return None
    cost_per_1m_input = cost_per_1m_input or 0.0
    cost_per_1m_output = cost_per_1m_output or 0.0
    return (tokens_in / 1_000_000.0) * cost_per_1m_input + (tokens_out / 1_000_000.0) * cost_per_1m_output


# ---------------------------------------------------------------------------
# Atomic results.json writer (crash-safe)
# ---------------------------------------------------------------------------

def write_results_atomic(path, data) -> None:
    """Write JSON to a temp file then os.replace() it over `path`.

    Guarantees results.json is never left truncated/corrupt if the process
    is killed mid-write.
    """
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(str(tmp), str(path))


# ---------------------------------------------------------------------------
# Real backend integration: monkeypatch agentprobe.loop.make_client for the
# duration of a single run_case call, per the contract with agentprobe/client.py.
# ---------------------------------------------------------------------------

def is_two_tier_backend(backend_cfg: dict) -> bool:
    """True for grounding backends (e.g. holo) that need a separate planner.

    Signalled by the presence of `planner_model` in backends.yaml -- see the
    header comment there and agentprobe/grounding.py.
    """
    return bool(backend_cfg.get("planner_model"))


def _resolve_url_field(backend_cfg: dict, field: str) -> str | None:
    """Like resolve_base_url, but for an arbitrary key (e.g. 'planner_base_url')."""
    return resolve_base_url({"base_url": backend_cfg.get(field)})


def _run_two_tier_case_for_backend(case, backend_cfg, output_dir, **kwargs):
    """Run a case through a two-tier (planner + grounding) backend, e.g. holo.

    `backend_cfg`'s model/base_url/api_key_env describe the GROUNDER (Holo);
    planner_model/planner_base_url/planner_api_key_env describe the PLANNER
    (a normal chat model). The planner client stands in for
    agentprobe.loop.make_client (used for both the CUA loop and the final
    vision judge, same as the single-tier path); the grounder is wired in as
    run_case's grounding_fn, used only to resolve "tap" coordinates.
    """
    import agentprobe.loop as loop_module
    from agentprobe.client import make_client as real_make_client
    from agentprobe.grounding import make_grounding_fn

    planner_base_url = _resolve_url_field(backend_cfg, "planner_base_url")
    if not planner_base_url:
        raise ValueError(
            f"Missing/unresolved planner_base_url for two-tier backend '{backend_cfg.get('name')}' "
            f"(check backends.yaml and the referenced env var)"
        )
    planner_model = backend_cfg["planner_model"]
    planner_client, planner_model = real_make_client(
        planner_model,
        backend="generic",
        api_key_env=backend_cfg["planner_api_key_env"],
        base_url=planner_base_url,
    )

    grounder_base_url = resolve_base_url(backend_cfg)
    if not grounder_base_url:
        raise ValueError(
            f"Missing/unresolved base_url for grounder of backend '{backend_cfg.get('name')}' "
            f"(check backends.yaml and the referenced env var)"
        )
    grounding_fn = make_grounding_fn(
        model=backend_cfg["model"],
        base_url=grounder_base_url,
        api_key_env=backend_cfg["api_key_env"],
    )

    def _patched_make_client(model, *a, **kw):
        return planner_client, planner_model

    original = loop_module.make_client
    loop_module.make_client = _patched_make_client
    try:
        return loop_module.run_case(
            case, model=planner_model, output_dir=output_dir, grounding_fn=grounding_fn, **kwargs
        )
    finally:
        loop_module.make_client = original


def _run_case_for_backend(case, backend_cfg, output_dir, **kwargs):
    if is_two_tier_backend(backend_cfg):
        return _run_two_tier_case_for_backend(case, backend_cfg, output_dir, **kwargs)

    import agentprobe.loop as loop_module
    from agentprobe.client import make_client as real_make_client

    resolved_base_url = resolve_base_url(backend_cfg)
    if not resolved_base_url:
        raise ValueError(
            f"Missing/unresolved base_url for backend '{backend_cfg.get('name')}' "
            f"(check backends.yaml and the referenced env var)"
        )

    def _patched_make_client(model, *a, **kw):
        return real_make_client(
            backend_cfg["model"],
            backend="generic",
            api_key_env=backend_cfg["api_key_env"],
            base_url=resolved_base_url,
        )

    original = loop_module.make_client
    loop_module.make_client = _patched_make_client
    try:
        return loop_module.run_case(case, model=backend_cfg["model"], output_dir=output_dir, **kwargs)
    finally:
        loop_module.make_client = original


def _dry_run_stub(case, backend_cfg, repeat_index) -> dict:
    """Fabricate a plausible run result without touching a real model/device.

    Deterministic given (backend name, case name, repeat index) so repeated
    --dry-run invocations produce reproducible-looking demo data.
    """
    seed = _seed_for(backend_cfg["name"], case.name, str(repeat_index))
    rng = random.Random(seed)

    time.sleep(rng.uniform(0.05, 0.2))

    steps = rng.randint(5, 15)
    tokens_in = rng.randint(800, 3000)
    tokens_out = rng.randint(50, 300)
    passed = rng.random() < 0.7

    if passed:
        verdict, status = "pass", "success"
        reason = f"[dry-run] {case.name} satisfied success criteria on {backend_cfg['name']} in {steps} steps"
    else:
        verdict, status = "fail", "failure"
        reason = f"[dry-run] {case.name} did not satisfy success criteria on {backend_cfg['name']}"

    return {
        "verdict": verdict,
        "status": status,
        "steps": steps,
        "reason": reason,
        "gif": None,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
    }


def run_one(case, backend_cfg: dict, repeat_index: int, output_dir: str, dry_run: bool) -> dict:
    """Run a single (backend, case, repeat) combo and return a result record.

    Never raises -- any exception (including ValueError from a missing/bad
    API key) is caught and turned into a verdict="error" record so the bench
    run loop can continue to the next combo.
    """
    run_output_dir = Path(output_dir) / backend_cfg["name"] / case.name / str(repeat_index)
    run_output_dir.mkdir(parents=True, exist_ok=True)

    start = time.perf_counter()
    error = None
    try:
        if dry_run:
            result = _dry_run_stub(case, backend_cfg, repeat_index)
        else:
            result = _run_case_for_backend(case, backend_cfg, str(run_output_dir), verbose=False)
    except Exception as e:  # noqa: BLE001 -- intentionally catch everything, see contract
        result = {"verdict": "error", "reason": f"{type(e).__name__}: {e}"}
        error = f"{type(e).__name__}: {e}"
    elapsed = time.perf_counter() - start

    tokens_in = result.get("tokens_in")
    tokens_out = result.get("tokens_out")
    cost_usd = compute_cost_usd(
        tokens_in, tokens_out,
        backend_cfg.get("cost_per_1m_input"), backend_cfg.get("cost_per_1m_output"),
    )

    return {
        "backend": backend_cfg["name"],
        "case": case.name,
        "repeat_index": repeat_index,
        "verdict": result.get("verdict", "error"),
        "steps": result.get("steps"),
        "wall_clock_s": elapsed,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": cost_usd,
        "gif": result.get("gif"),
        "reason": result.get("reason", ""),
        "error": error,
        "timestamp": _now_iso(),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m bench.run",
        description="Run agentprobe TestCases across multiple LLM backends and produce a leaderboard.",
    )
    parser.add_argument("--cases", required=True,
                         help="Comma-separated paths to case files (.py/.json/.yaml)")
    parser.add_argument("--backends", default=None,
                         help="Comma-separated backend names from backends.yaml (default: all)")
    parser.add_argument("--repeat", type=int, default=1, help="Repeat each (backend, case) pair N times")
    parser.add_argument("--output-dir", default="/tmp/bench", help="Directory for results.json + leaderboard files")
    parser.add_argument("--dry-run", action="store_true",
                         help="Fabricate results instead of running the real CUA loop/device")
    return parser.parse_args(argv)


def main(argv=None):
    args = _parse_args(argv)

    registry = load_backends_registry()
    if args.backends:
        requested = [n.strip() for n in args.backends.split(",") if n.strip()]
        missing = [n for n in requested if n not in registry]
        if missing:
            print(
                f"ERROR: unknown backend(s): {', '.join(missing)}. "
                f"Available: {', '.join(registry.keys())}",
                file=sys.stderr,
            )
            return 1
        selected_backends = [registry[n] for n in requested]
    else:
        selected_backends = list(registry.values())

    case_paths = [c.strip() for c in args.cases.split(",") if c.strip()]
    cases = [_load_case(cp, None) for cp in case_paths]

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    results_path = output_dir / "results.json"

    runs = []
    for backend_cfg in selected_backends:
        for case in cases:
            for repeat_index in range(args.repeat):
                record = run_one(case, backend_cfg, repeat_index, str(output_dir), args.dry_run)
                runs.append(record)
                write_results_atomic(results_path, {"generated_at": _now_iso(), "runs": runs})
                print(
                    f"[{backend_cfg['name']}] case={case.name} repeat={repeat_index} "
                    f"verdict={record['verdict']} elapsed={record['wall_clock_s']:.2f}s"
                )

    from bench import report as report_mod
    results_data = {"generated_at": _now_iso(), "runs": runs}
    md, _html = report_mod.write_reports(results_data, str(output_dir))
    print()
    print(md)
    print()
    print(f"Wrote {results_path}, {output_dir / 'leaderboard.md'}, {output_dir / 'leaderboard.html'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
