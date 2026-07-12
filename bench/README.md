# bench

A multi-backend CUA benchmark harness built on top of `agentprobe`. It runs
the same `TestCase`(s) against several OpenAI-compatible model backends and
produces a ranked leaderboard (pass rate, steps, latency, cost) with visual
evidence (per-run GIFs) for judges/reviewers to click through.

## Backend registry

Backends live in `bench/backends.yaml` as a list of `{name, model, base_url,
api_key_env, cost_per_1m_input, cost_per_1m_output}` entries. Each is routed
through `agentprobe.client.make_client(backend="generic", api_key_env=...,
base_url=...)`, so adding a new OpenAI-compatible endpoint (e.g. a
locally-served open-weight model) needs zero code changes — just a new YAML
entry.

**`base_url` resolution:** a value written literally as `${SOME_ENV_VAR}` is
substituted at run time with `os.environ.get("SOME_ENV_VAR")`; any other
string is used as-is as a literal URL. If the resolved value ends up empty
(env var unset), that backend's runs fail gracefully with `verdict="error"`
rather than crashing the whole harness.

## Running

```bash
python -m bench.run \
  --cases examples/android/calculator_math.py,examples/android/basic_smoke.py \
  --backends azure-gpt4o,gemini-flash \
  --repeat 1 --output-dir /tmp/bench
```

- `--cases`: comma-separated `.py`/`.json`/`.yaml` case files, loaded via
  `agentprobe.cli._load_case`.
- `--backends`: comma-separated names from `backends.yaml` (default: all).
- `--repeat`: repeat each (backend, case) pair N times (default 1).
- `--output-dir`: where results land (default `/tmp/bench`).
- `--dry-run`: skip the real CUA loop/model/device entirely and fabricate a
  plausible result (deterministic per backend+case+repeat) — use this for a
  fast leaderboard demo with no API keys or Android device required.

## Outputs

- `results.json` — `{"generated_at": ..., "runs": [...]}`, rewritten
  atomically after **every** run so a crash never leaves it truncated.
- `leaderboard.md` — ranked markdown table (also printed to stdout).
- `leaderboard.html` — same table plus a per-backend gallery of each run's
  `demo.gif` (or a placeholder box when there's no recording, e.g. `--dry-run`
  or an errored run). Fully self-contained, dark theme, no external assets.

Regenerate the leaderboard from an existing `results.json` without re-running
anything:

```bash
python -m bench.report --input /tmp/bench/results.json --output-dir /tmp/bench
```

## Why `cost_usd` / `tokens_in` / `tokens_out` are `None` on real runs today

`agentprobe.loop.run_case` doesn't track token usage yet, so real (non
`--dry-run`) invocations legitimately have no token counts and therefore no
computed cost. `--dry-run` fabricates plausible token counts so the cost math
has real numbers to demo. This is expected, not a bug.
