"""bench.report -- aggregate bench/run.py results.json into a leaderboard.

Standalone usage:
    python -m bench.report --input /tmp/bench/results.json --output-dir /tmp/bench
"""
from __future__ import annotations

import argparse
import html as html_lib
import json
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------

def load_results(path) -> dict:
    with open(path) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Aggregation (pure logic, unit-testable without touching disk)
# ---------------------------------------------------------------------------

def aggregate_backend(runs_for_backend: list, backend_cfg: dict) -> dict:
    """Roll up one backend's runs into pass_rate / avg_steps / avg_latency / avg_cost.

    - pass_rate: passes / total (fail and error both count as non-pass in both
      numerator and denominator). 0.0 for an all-error backend, not a ZeroDivisionError.
    - avg_steps / avg_latency / avg_cost: mean over runs where that field is not None;
      None if no run has that data.
    """
    total = len(runs_for_backend)
    passes = sum(1 for r in runs_for_backend if r.get("verdict") == "pass")
    pass_rate = (passes / total) if total else 0.0

    steps_vals = [r["steps"] for r in runs_for_backend if r.get("steps") is not None]
    avg_steps = (sum(steps_vals) / len(steps_vals)) if steps_vals else None

    latency_vals = [r["wall_clock_s"] for r in runs_for_backend if r.get("wall_clock_s") is not None]
    avg_latency = (sum(latency_vals) / len(latency_vals)) if latency_vals else None

    cost_vals = [r["cost_usd"] for r in runs_for_backend if r.get("cost_usd") is not None]
    avg_cost = (sum(cost_vals) / len(cost_vals)) if cost_vals else None

    return {
        "backend": backend_cfg["name"],
        "total_runs": total,
        "pass_rate": pass_rate,
        "avg_steps": avg_steps,
        "avg_latency": avg_latency,
        "avg_cost": avg_cost,
    }


def build_aggregates(runs: list) -> list:
    """Group runs by backend (in first-seen order) and aggregate each group."""
    order = []
    by_backend = {}
    for r in runs:
        name = r["backend"]
        if name not in by_backend:
            by_backend[name] = []
            order.append(name)
        by_backend[name].append(r)
    return [aggregate_backend(by_backend[name], {"name": name}) for name in order]


def rank_backends(aggregates: list) -> list:
    """Sort aggregates: pass_rate DESC, then avg_cost ASC (None sorts last), then name ASC."""

    def sort_key(agg):
        pass_rate = agg.get("pass_rate") or 0.0
        cost = agg.get("avg_cost")
        cost_key = (1, 0.0) if cost is None else (0, cost)
        return (-pass_rate, cost_key, agg.get("backend", ""))

    return sorted(aggregates, key=sort_key)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _fmt_pct(x) -> str:
    return f"{x * 100:.1f}%" if x is not None else "n/a"


def _fmt_steps(x) -> str:
    return f"{x:.1f}" if x is not None else "n/a"


def _fmt_latency(x) -> str:
    return f"{x:.1f}" if x is not None else "n/a"


def _fmt_cost(x) -> str:
    return f"${x:.4f}" if x is not None else "n/a"


def render_markdown(ranked_aggregates: list) -> str:
    lines = [
        "| Backend | Pass Rate | Avg Steps | Avg Latency (s) | $/Run |",
        "|---|---|---|---|---|",
    ]
    for a in ranked_aggregates:
        lines.append(
            f"| {a['backend']} | {_fmt_pct(a['pass_rate'])} | {_fmt_steps(a['avg_steps'])} | "
            f"{_fmt_latency(a['avg_latency'])} | {_fmt_cost(a['avg_cost'])} |"
        )
    return "\n".join(lines)


_HTML_STYLE = """
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 3rem 4rem;
  background: #0b0e14; color: #e6e6e6;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
h1 { font-size: 1.6rem; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
.subtitle { color: #8b93a7; margin: 0 0 2rem; font-size: 0.95rem; }
table { border-collapse: collapse; width: 100%; margin-bottom: 3rem; }
th, td {
  text-align: left; padding: 0.6rem 1rem; border-bottom: 1px solid #232838;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9rem;
}
th {
  color: #8b93a7; font-weight: 600; text-transform: uppercase; font-size: 0.72rem;
  letter-spacing: 0.06em; border-bottom: 1px solid #333a4d;
}
tr:hover td { background: #131826; }
td:first-child, th:first-child { font-family: inherit; font-weight: 600; color: #f2f4f8; }
.rank-1 td:first-child { color: #7ee787; }
.section { margin-bottom: 2.5rem; }
.section h2 {
  font-size: 1.05rem; margin: 0 0 0.9rem; color: #f2f4f8;
  border-left: 3px solid #3b82f6; padding-left: 0.6rem;
}
.grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1rem;
}
.card {
  background: #11151f; border: 1px solid #232838; border-radius: 10px;
  padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem;
}
.card img { width: 100%; border-radius: 6px; display: block; background: #0b0e14; }
.placeholder {
  width: 100%; aspect-ratio: 4 / 3; border-radius: 6px; background: #191f2e;
  display: flex; align-items: center; justify-content: center;
  color: #565f77; font-size: 0.78rem; text-align: center; padding: 0.5rem;
  border: 1px dashed #2c3448;
}
.card .meta { font-size: 0.78rem; color: #a3abbf; line-height: 1.5; }
.card .meta .case { color: #f2f4f8; font-weight: 600; }
.badge {
  display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px;
  font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
}
.badge.pass { background: #113a24; color: #7ee787; }
.badge.fail { background: #3a1414; color: #ff7b72; }
.badge.error { background: #3a2a11; color: #f0b84c; }
.reason { color: #6b7280; font-size: 0.75rem; }
footer { color: #565f77; font-size: 0.78rem; margin-top: 3rem; }
"""


def _verdict_badge(verdict: str) -> str:
    cls = verdict if verdict in ("pass", "fail", "error") else "error"
    return f'<span class="badge {cls}">{html_lib.escape(verdict)}</span>'


def render_html(ranked_aggregates: list, runs: list) -> str:
    rows = []
    for i, a in enumerate(ranked_aggregates):
        row_cls = ' class="rank-1"' if i == 0 else ""
        rows.append(
            f"<tr{row_cls}><td>{html_lib.escape(a['backend'])}</td>"
            f"<td>{_fmt_pct(a['pass_rate'])}</td>"
            f"<td>{_fmt_steps(a['avg_steps'])}</td>"
            f"<td>{_fmt_latency(a['avg_latency'])}</td>"
            f"<td>{_fmt_cost(a['avg_cost'])}</td></tr>"
        )
    table_html = "\n".join(rows)

    by_backend = {}
    order = []
    for r in runs:
        name = r.get("backend", "unknown")
        if name not in by_backend:
            by_backend[name] = []
            order.append(name)
        by_backend[name].append(r)
    # keep leaderboard order for the gallery when possible
    ranked_names = [a["backend"] for a in ranked_aggregates]
    for name in order:
        if name not in ranked_names:
            ranked_names.append(name)

    sections = []
    for name in ranked_names:
        run_list = by_backend.get(name, [])
        cards = []
        for r in run_list:
            gif = r.get("gif")
            if gif:
                media = f'<img src="{html_lib.escape(str(gif))}" alt="run recording" loading="lazy" onerror="this.outerHTML=\'<div class=&quot;placeholder&quot;>recording unavailable</div>\'">'
            else:
                media = '<div class="placeholder">no recording (dry-run)</div>'
            reason = html_lib.escape(str(r.get("reason") or ""))[:160]
            cards.append(
                "<div class=\"card\">"
                f"{media}"
                "<div class=\"meta\">"
                f"<div class=\"case\">{html_lib.escape(str(r.get('case', '')))}</div>"
                f"{_verdict_badge(r.get('verdict', 'error'))} "
                f"repeat #{r.get('repeat_index', 0)} &middot; {r.get('steps') if r.get('steps') is not None else 'n/a'} steps"
                f"<div class=\"reason\">{reason}</div>"
                "</div></div>"
            )
        sections.append(
            f'<div class="section"><h2>{html_lib.escape(name)}</h2><div class="grid">{"".join(cards)}</div></div>'
        )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentprobe bench leaderboard</title>
<style>{_HTML_STYLE}</style>
</head>
<body>
<h1>agentprobe bench leaderboard</h1>
<p class="subtitle">Multi-backend CUA benchmark results, ranked by pass rate then cost.</p>
<table>
<tr><th>Backend</th><th>Pass Rate</th><th>Avg Steps</th><th>Avg Latency (s)</th><th>$/Run</th></tr>
{table_html}
</table>
{"".join(sections)}
<footer>Generated by bench/report.py</footer>
</body>
</html>
"""


def write_reports(results_data: dict, output_dir: str):
    """Aggregate + rank + render, write leaderboard.md/leaderboard.html, return (md, html)."""
    runs = results_data.get("runs", [])
    aggregates = build_aggregates(runs)
    ranked = rank_backends(aggregates)
    md = render_markdown(ranked)
    out_html = render_html(ranked, runs)

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "leaderboard.md").write_text(md + "\n")
    (out_dir / "leaderboard.html").write_text(out_html)
    return md, out_html


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m bench.report",
        description="Generate leaderboard.md/leaderboard.html from a bench results.json",
    )
    parser.add_argument("--input", required=True, help="Path to results.json")
    parser.add_argument("--output-dir", required=True, help="Directory to write leaderboard.md/.html into")
    args = parser.parse_args(argv)

    data = load_results(args.input)
    md, _html = write_reports(data, args.output_dir)
    print(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
