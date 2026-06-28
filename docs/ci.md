# CI Integration

## Quick start: reusable actions

The easiest way to add agentprobe to any GitHub Actions workflow is via the
reusable composite actions in this repo.

### Android

```yaml
- uses: dzianisv/agentprobe/.github/actions/agentprobe-android@main
  with:
    case: path/to/my-test.yaml
    api-level: '33'
    apk-path: path/to/app.apk   # optional
    output-dir: /tmp/cua-output
  env:
    AZURE_CUA_API_KEY: ${{ secrets.AZURE_CUA_API_KEY }}
    AZURE_CUA_BASE_URL: ${{ secrets.AZURE_CUA_BASE_URL }}
```

The action handles: `pip install agentprobe`, `ffmpeg`, KVM device, and the emulator runner.

### Browser

```yaml
- uses: dzianisv/agentprobe/.github/actions/agentprobe-browser@main
  with:
    case: path/to/my-test.yaml
    output-dir: /tmp/cua-output
  env:
    AZURE_CUA_API_KEY: ${{ secrets.AZURE_CUA_API_KEY }}
    AZURE_CUA_BASE_URL: ${{ secrets.AZURE_CUA_BASE_URL }}
```

The action handles: `pip install agentprobe`, bun, browser runner deps, `xvfb`, `xdotool`, `scrot`, `ffmpeg`, and Xvfb startup.

## Android emulator (manual)

Uses `reactivecircus/android-emulator-runner@v2` on `ubuntu-latest`.

Key setup steps:
1. `pip install agentprobe` + `sudo apt-get install -y ffmpeg`
2. Enable KVM (required for hardware acceleration):
   ```yaml
   - name: Enable KVM
     run: |
       echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
       sudo udevadm control --reload-rules
       sudo udevadm trigger --name-match=kvm
   ```
3. Pass each command as a separate line in `script:` — backslash line continuations
   **do not work** because each line is run via `/usr/bin/sh -c` independently.

Required secrets: `AZURE_CUA_API_KEY`, `AZURE_CUA_BASE_URL`.

## Browser (manual)

Runs on `ubuntu-latest` with `Xvfb` for a virtual display.

Key setup steps:
1. `pip install agentprobe`, install bun via `oven-sh/setup-bun@v2`
2. `cd browser && bun install`
3. `sudo apt-get install -y xvfb xdotool scrot ffmpeg`
4. Start Xvfb and export `DISPLAY=:99`

## Uploading artifacts

Always upload output with `if: always()` so screenshots and the result.json are
available after both pass and fail:

```yaml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: cua-output-${{ github.run_number }}
    path: /tmp/cua-output/
    retention-days: 14
    if-no-files-found: warn

- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: cua-output-demo-${{ github.run_number }}
    path: |
      /tmp/cua-output/demo.gif
      /tmp/cua-output/*.mp4
    retention-days: 30
    if-no-files-found: warn
```

## pytest integration

The `agentprobe` package registers a `pytest11` entry point so pytest picks up
the `cua_case` fixture automatically:

```bash
pip install agentprobe
pytest tests/
```

No `conftest.py` needed — the fixture is auto-loaded.

## Full workflow templates

See [skills/agentprobe-ci/SKILL.md](../skills/agentprobe-ci/SKILL.md) for full
copy-paste workflow YAML.
