"""Unit tests for bench/. Pure logic only -- no network, no run_case, no device."""
import json

from bench.run import compute_cost_usd, is_two_tier_backend, load_backends_registry, write_results_atomic
from bench.report import aggregate_backend, build_aggregates, rank_backends


# ---------------------------------------------------------------------------
# compute_cost_usd
# ---------------------------------------------------------------------------

def test_compute_cost_usd_known_values():
    # 1,000,000 in-tokens @ $2.50/1M + 500,000 out-tokens @ $10/1M => 2.50 + 5.00
    cost = compute_cost_usd(1_000_000, 500_000, 2.50, 10.00)
    assert cost == 7.5


def test_compute_cost_usd_none_tokens_returns_none():
    assert compute_cost_usd(None, 100, 2.50, 10.00) is None
    assert compute_cost_usd(100, None, 2.50, 10.00) is None
    assert compute_cost_usd(None, None, 2.50, 10.00) is None


def test_compute_cost_usd_zero_tokens_is_zero_not_none():
    assert compute_cost_usd(0, 0, 2.50, 10.00) == 0.0


# ---------------------------------------------------------------------------
# rank_backends
# ---------------------------------------------------------------------------

def test_rank_backends_pass_rate_desc():
    aggs = [
        {"backend": "b", "pass_rate": 0.5, "avg_cost": 0.01},
        {"backend": "a", "pass_rate": 0.9, "avg_cost": 0.02},
    ]
    ranked = rank_backends(aggs)
    assert [a["backend"] for a in ranked] == ["a", "b"]


def test_rank_backends_cost_asc_tiebreak_on_equal_pass_rate():
    aggs = [
        {"backend": "expensive", "pass_rate": 0.8, "avg_cost": 0.05},
        {"backend": "cheap", "pass_rate": 0.8, "avg_cost": 0.01},
    ]
    ranked = rank_backends(aggs)
    assert [a["backend"] for a in ranked] == ["cheap", "expensive"]


def test_rank_backends_none_cost_sorts_last():
    aggs = [
        {"backend": "unknown-cost", "pass_rate": 0.8, "avg_cost": None},
        {"backend": "known-cost", "pass_rate": 0.8, "avg_cost": 0.10},
    ]
    ranked = rank_backends(aggs)
    assert [a["backend"] for a in ranked] == ["known-cost", "unknown-cost"]


def test_rank_backends_name_asc_final_tiebreak():
    aggs = [
        {"backend": "zeta", "pass_rate": 0.5, "avg_cost": 0.02},
        {"backend": "alpha", "pass_rate": 0.5, "avg_cost": 0.02},
        {"backend": "mid", "pass_rate": 0.5, "avg_cost": 0.02},
    ]
    ranked = rank_backends(aggs)
    assert [a["backend"] for a in ranked] == ["alpha", "mid", "zeta"]


# ---------------------------------------------------------------------------
# results.json round-trip via write_results_atomic
# ---------------------------------------------------------------------------

def test_write_results_atomic_round_trip(tmp_path):
    path = tmp_path / "results.json"
    data = {
        "generated_at": "2026-07-12T00:00:00+00:00",
        "runs": [
            {"backend": "gemini-flash", "case": "basic_smoke", "repeat_index": 0,
             "verdict": "pass", "steps": 5, "wall_clock_s": 0.12,
             "tokens_in": 900, "tokens_out": 80, "cost_usd": 0.000122,
             "gif": None, "reason": "ok", "error": None,
             "timestamp": "2026-07-12T00:00:01+00:00"},
        ],
    }
    write_results_atomic(path, data)

    assert path.exists()
    # no leftover temp file
    assert not (tmp_path / "results.json.tmp").exists()

    loaded = json.loads(path.read_text())
    assert loaded == data


def test_write_results_atomic_overwrites_existing_file(tmp_path):
    path = tmp_path / "results.json"
    write_results_atomic(path, {"runs": [1]})
    write_results_atomic(path, {"runs": [1, 2]})
    assert json.loads(path.read_text()) == {"runs": [1, 2]}


# ---------------------------------------------------------------------------
# aggregate_backend / build_aggregates
# ---------------------------------------------------------------------------

def test_aggregate_backend_mixed_pass_fail_error():
    runs = [
        {"backend": "x", "verdict": "pass", "steps": 10, "wall_clock_s": 1.0, "cost_usd": 0.01},
        {"backend": "x", "verdict": "fail", "steps": 20, "wall_clock_s": 3.0, "cost_usd": 0.02},
        {"backend": "x", "verdict": "error", "steps": None, "wall_clock_s": 0.5, "cost_usd": None},
        {"backend": "x", "verdict": "pass", "steps": 6, "wall_clock_s": 1.5, "cost_usd": 0.03},
    ]
    agg = aggregate_backend(runs, {"name": "x"})

    assert agg["backend"] == "x"
    assert agg["total_runs"] == 4
    assert agg["pass_rate"] == 2 / 4
    # avg_steps only over runs with steps not None: (10+20+6)/3
    assert agg["avg_steps"] == (10 + 20 + 6) / 3
    # avg_latency over all 4 runs
    assert agg["avg_latency"] == (1.0 + 3.0 + 0.5 + 1.5) / 4
    # avg_cost only over runs with cost_usd not None: (0.01+0.02+0.03)/3
    assert abs(agg["avg_cost"] - (0.01 + 0.02 + 0.03) / 3) < 1e-9


def test_aggregate_backend_all_errors_pass_rate_zero_no_crash():
    runs = [
        {"backend": "y", "verdict": "error", "steps": None, "wall_clock_s": 0.1, "cost_usd": None},
        {"backend": "y", "verdict": "error", "steps": None, "wall_clock_s": 0.2, "cost_usd": None},
    ]
    agg = aggregate_backend(runs, {"name": "y"})
    assert agg["pass_rate"] == 0.0
    assert agg["avg_steps"] is None
    assert agg["avg_cost"] is None


def test_aggregate_backend_empty_runs_no_zero_division():
    agg = aggregate_backend([], {"name": "empty"})
    assert agg["total_runs"] == 0
    assert agg["pass_rate"] == 0.0
    assert agg["avg_steps"] is None
    assert agg["avg_latency"] is None
    assert agg["avg_cost"] is None


# ---------------------------------------------------------------------------
# holo two-tier backend config
# ---------------------------------------------------------------------------

def test_is_two_tier_backend_true_for_holo_style_config():
    cfg = {"name": "holo", "model": "holo3-1-35b-a3b", "planner_model": "gemini-2.0-flash"}
    assert is_two_tier_backend(cfg) is True


def test_is_two_tier_backend_false_for_plain_generic_backend():
    cfg = {"name": "gemini-flash", "model": "gemini-2.0-flash"}
    assert is_two_tier_backend(cfg) is False


def test_holo_registered_in_backends_yaml_as_two_tier():
    registry = load_backends_registry()
    assert "holo" in registry
    holo_cfg = registry["holo"]
    assert is_two_tier_backend(holo_cfg)
    assert holo_cfg["api_key_env"] == "HAI_API_KEY"
    assert holo_cfg["planner_api_key_env"]


def test_build_aggregates_groups_by_backend():
    runs = [
        {"backend": "a", "verdict": "pass", "steps": 5, "wall_clock_s": 1.0, "cost_usd": 0.01},
        {"backend": "b", "verdict": "fail", "steps": 8, "wall_clock_s": 2.0, "cost_usd": 0.02},
        {"backend": "a", "verdict": "fail", "steps": 7, "wall_clock_s": 1.0, "cost_usd": 0.01},
    ]
    aggs = build_aggregates(runs)
    by_name = {a["backend"]: a for a in aggs}
    assert set(by_name.keys()) == {"a", "b"}
    assert by_name["a"]["total_runs"] == 2
    assert by_name["b"]["total_runs"] == 1
