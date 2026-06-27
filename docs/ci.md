# CI Integration

See [`skills/agentprobe-ci/SKILL.md`](../skills/agentprobe-ci/SKILL.md) for full YAML templates.

## Android emulator CI

Uses `reactivecircus/android-emulator-runner@v2`. Works on `ubuntu-latest`.

Required secrets: `OPENAI_API_KEY` (or Azure variant).

## Browser CI

Uses the agentprobe Docker image (`ghcr.io/dzianisv/agentprobe:latest`) which bundles
Chrome For Testing, bun, xvfb, xdotool, scrot, and ffmpeg.

Required secrets: `AZURE_CUA_API_KEY`, `AZURE_CUA_BASE_URL`.

## pytest integration

The `agentprobe` package registers a `pytest11` entry point so pytest picks up
the `cua_case` fixture automatically:

```bash
pip install agentprobe
pytest tests/
```

No `conftest.py` needed — the fixture is auto-loaded.
