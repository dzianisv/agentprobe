"""H Company Holo grounding backend.

Holo is a *grounding/localization* model, not a full agentic planner: given a
screenshot and a short natural-language description of a UI element ("the
Submit button"), it returns that element's location. It does not decide
*what* to do next -- a separate planner LLM (any OpenAI-compatible chat
model, configured independently) makes that decision. This module is the
"turn a description into real pixel coordinates" half of that two-tier
design; agentprobe.loop wires it in as an optional `grounding_fn` used only
for `tap` actions (see run_cua_step / SYSTEM_PROMPT_HOLO_APPENDIX).

Coordinate contract -- read this twice:
Holo's structured-output response is {"x": <int>, "y": <int>} NORMALIZED TO
[0, 1000] on each axis. It is NOT raw pixels and NOT a [0, 1] float. Callers
MUST scale by image_width/1000 and image_height/1000 to land on the real
target -- see scale_holo_coords(), unit tested in tests/test_grounding.py.
Getting this wrong means every click misses.
"""
from __future__ import annotations

import json
import os
import time

HOLO_BASE_URL_DEFAULT = "https://api.hcompany.ai/v1/"
HOLO_MODEL_DEFAULT = "holo3-1-35b-a3b"
HOLO_API_KEY_ENV = "HAI_API_KEY"

# Free tier ("holo3-1-35b-a3b") is capped at 5 req/min. A multi-step CUA run
# issues one grounding call per tap, easily enough to blow through that cap
# mid-demo. Space calls out client-side rather than relying purely on
# reactive 429 backoff. 60s / 5 = 12s; pad slightly for clock skew.
HOLO_MIN_INTERVAL_S = float(os.environ.get("HOLO_MIN_INTERVAL_S", "12.5"))

_HOLO_STRUCTURED_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "x": {"type": "integer"},
        "y": {"type": "integer"},
    },
    "required": ["x", "y"],
}


def scale_holo_coords(x_norm: float, y_norm: float, image_width: int, image_height: int) -> tuple[int, int]:
    """Scale Holo's [0,1000]-normalized (x, y) to real pixel coordinates.

    This is the single most important conversion in the Holo integration --
    Holo always returns coordinates normalized to [0, 1000] on each axis
    regardless of the input image's actual resolution, so callers must scale
    by (image_width / 1000, image_height / 1000) to get a usable pixel tap
    target. Clamped to the image bounds so a boundary value (e.g. x=1000)
    can't produce an off-screen tap.
    """
    if image_width <= 0 or image_height <= 0:
        raise ValueError(f"image_width/image_height must be positive, got ({image_width}, {image_height})")
    px = round((x_norm / 1000.0) * image_width)
    py = round((y_norm / 1000.0) * image_height)
    px = max(0, min(image_width - 1, px))
    py = max(0, min(image_height - 1, py))
    return px, py


class HoloRateLimiter:
    """Client-side throttle so a run doesn't blow through Holo's free-tier 5 req/min cap."""

    def __init__(self, min_interval_s: float = HOLO_MIN_INTERVAL_S):
        self.min_interval_s = min_interval_s
        self._last_call = 0.0

    def wait(self) -> None:
        elapsed = time.monotonic() - self._last_call
        remaining = self.min_interval_s - elapsed
        if remaining > 0:
            time.sleep(remaining)
        self._last_call = time.monotonic()


def ground(
    client,
    model: str,
    image_b64: str,
    description: str,
    image_width: int,
    image_height: int,
    max_retries: int = 4,
    rate_limiter: "HoloRateLimiter | None" = None,
) -> tuple[int, int]:
    """Ask Holo where `description` is in the screenshot; return real pixel (x, y).

    Retries with exponential backoff on 429 (rate limit) -- Holo's free tier
    is 5 req/min, easy to exceed mid-run without this.
    """
    extra_body = {
        "structured_outputs": {"json": _HOLO_STRUCTURED_OUTPUT_SCHEMA},
        "chat_template_kwargs": {"enable_thinking": False},
    }

    last_exc: Exception | None = None
    for attempt in range(max_retries):
        if rate_limiter:
            rate_limiter.wait()
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                            },
                            {"type": "text", "text": description},
                        ],
                    }
                ],
                temperature=0.0,
                extra_body=extra_body,
            )
            raw = response.choices[0].message.content
            data = json.loads(raw)
            x_norm, y_norm = float(data["x"]), float(data["y"])
            return scale_holo_coords(x_norm, y_norm, image_width, image_height)
        except Exception as e:  # noqa: BLE001 -- retry on 429, otherwise surface to caller
            last_exc = e
            if "429" in str(e) and attempt < max_retries - 1:
                wait = min(60, 15 * (2 ** attempt))
                time.sleep(wait)
                continue
            raise
    raise last_exc  # pragma: no cover -- loop always returns or raises above


def make_grounding_fn(model: str = None, base_url: str = None, api_key: str = None, api_key_env: str = None):
    """Build a grounding_fn(image_b64, description, w, h) -> (x, y) closure.

    Wired into agentprobe.loop.run_cua_step's `grounding_fn` parameter.
    Fails loudly (ValueError) with a clear message if the Holo API key isn't
    configured -- callers should let this propagate rather than silently
    skipping grounding, per the "fail clear, don't fail silent" contract for
    this backend.
    """
    from openai import OpenAI

    model = model or HOLO_MODEL_DEFAULT
    base_url = base_url or HOLO_BASE_URL_DEFAULT
    key_env = api_key_env or HOLO_API_KEY_ENV
    resolved_key = api_key or os.environ.get(key_env)
    if not resolved_key:
        raise ValueError(
            f"Holo grounding backend requires {key_env} to be set (H Company API key -- "
            f"see https://hub.hcompany.ai). Not found in the environment."
        )

    client = OpenAI(api_key=resolved_key, base_url=base_url)
    limiter = HoloRateLimiter()

    def _grounding_fn(image_b64: str, description: str, image_width: int, image_height: int) -> tuple[int, int]:
        return ground(client, model, image_b64, description, image_width, image_height, rate_limiter=limiter)

    return _grounding_fn
