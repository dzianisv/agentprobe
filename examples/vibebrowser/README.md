# VibeBrowser CUA Test Cases

agentprobe test cases for the [Vibe Chrome extension](https://github.com/dzianisv/vibebrowser/vibe).

| Case | Speed | Trigger | What it tests |
|---|---|---|---|
| `vibe-install-smoke.yaml` | ~1 min | per-PR | CWS listing page loads with install button |
| `vibe-settings-provider.yaml` | ~1 min | per-PR | Settings page loads with provider selector |
| `vibe-sidepanel-smoke.yaml` | ~2 min | per-PR | Side panel opens without errors |

## Running locally

```bash
export OPENAI_API_KEY=sk-...
# or AZURE_CUA_API_KEY + AZURE_CUA_BASE_URL

agentprobe run --target browser \
  --case examples/vibebrowser/vibe-install-smoke.yaml \
  --output-dir /tmp/vibe-test-output

open /tmp/vibe-test-output/demo.gif
```

## Notes

- `vibe-sidepanel-smoke.yaml` requires the extension to be installed in the Chrome profile used by the runner. In CI, build the extension first and install it via the CWS or pre-loaded profile.
- Side panel tests require a Chrome profile with the extension already installed. See the main agentprobe README for setup instructions.
