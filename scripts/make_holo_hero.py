#!/usr/bin/env python3
"""make_holo_hero.py — render the "Holo grounding" hero clip for the demo video.

Does a REAL H Company Holo grounding call (screenshot + element description ->
pixel coords), then animates a crosshair reticle snapping onto the returned
point, with a side panel explaining the input/output. This is the unique,
on-theme money shot: it visualizes the H Company model's actual decision.

Output: a PNG frame sequence written to <workdir>/hero_*.png. Encode to mp4
separately (see scripts/build_demo_video.sh). Requires HAI_API_KEY.

Usage:
  python3 scripts/make_holo_hero.py <image.png> "<target description>" <workdir> \
      [--width 1280] [--height 720] [--fps 30] [--frames 60] [--x N --y N]

If --x/--y are supplied the Holo call is skipped (useful for offline rebuilds);
otherwise the call is made live and the resolved coords are printed.
"""
from __future__ import annotations

import argparse
import base64
import math
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from PIL import Image, ImageDraw, ImageFont

BG = (11, 15, 20)
ACCENT = (138, 208, 255)
WHITE = (255, 255, 255)
GREY = (160, 168, 176)
RETICLE = (0, 255, 170)

FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
FONT_MONO = "/System/Library/Fonts/Menlo.ttc"


def _font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def resolve_coords(image_path: str, target: str) -> tuple[int, int, int, int]:
    """Live Holo grounding. Returns (x, y, img_w, img_h) in the image's pixels."""
    from openai import OpenAI
    from agentprobe.grounding import ground

    im = Image.open(image_path).convert("RGB")
    w, h = im.size
    b64 = base64.b64encode(open(image_path, "rb").read()).decode()
    key = os.environ.get("HAI_API_KEY")
    if not key:
        sys.exit("HAI_API_KEY not set (source .env) — required for the live Holo hero shot")
    client = OpenAI(api_key=key, base_url="https://api.hcompany.ai/v1/")
    x, y = ground(client, "holo3-1-35b-a3b", b64, target, w, h)
    return x, y, w, h


def draw_reticle(d: ImageDraw.ImageDraw, cx: int, cy: int, radius: int, alpha: float):
    """Crosshair: outer ring + ticks + center dot. alpha in [0,1] fades the ring."""
    col = RETICLE
    ring = tuple(int(BG[i] + (col[i] - BG[i]) * alpha) for i in range(3))
    r = radius
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ring, width=4)
    tick = int(r * 0.5)
    for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
        d.line([cx + dx * r, cy + dy * r, cx + dx * (r - tick), cy + dy * (r - tick)], fill=ring, width=4)
    dot = max(3, int(r * 0.12))
    d.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=col)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("target")
    ap.add_argument("workdir")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--frames", type=int, default=60)
    ap.add_argument("--x", type=int, default=None)
    ap.add_argument("--y", type=int, default=None)
    args = ap.parse_args()

    os.makedirs(args.workdir, exist_ok=True)

    if args.x is not None and args.y is not None:
        src = Image.open(args.image).convert("RGB")
        iw, ih = src.size
        gx, gy = args.x, args.y
    else:
        gx, gy, iw, ih = resolve_coords(args.image, args.target)
        src = Image.open(args.image).convert("RGB")
    print(f"HOLO_COORDS {gx} {gy} {iw} {ih}")

    W, H = args.width, args.height
    # Left half: phone screenshot (portrait) letterboxed into left column.
    left_w = int(W * 0.42)
    # scale screenshot to fit within (left_w, H) preserving aspect
    scale = min((left_w - 40) / iw, (H - 40) / ih)
    sw, sh = int(iw * scale), int(ih * scale)
    ox, oy = (left_w - sw) // 2, (H - sh) // 2
    shot = src.resize((sw, sh))
    # mapped coord in canvas space
    mx, my = ox + int(gx * scale), oy + int(gy * scale)

    f_title = _font(FONT_BOLD, 40)
    f_lbl = _font(FONT_BOLD, 26)
    f_body = _font(FONT_REG, 25)
    f_mono = _font(FONT_MONO, 30)

    px_w, px_h = W - left_w, H
    panel_x = left_w + 50

    for i in range(args.frames):
        t = i / (args.frames - 1)
        canvas = Image.new("RGB", (W, H), BG)
        canvas.paste(shot, (ox, oy))
        d = ImageDraw.Draw(canvas)
        # thin border around the phone shot
        d.rectangle([ox - 2, oy - 2, ox + sw + 1, oy + sh + 1], outline=(40, 48, 58), width=2)

        # Reticle animation: flies in from top-right of the shot, converges & pulses.
        conv = min(1.0, t / 0.55)  # converge during first 55%
        ease = 1 - (1 - conv) ** 3
        start_x, start_y = ox + sw, oy
        cx = int(start_x + (mx - start_x) * ease)
        cy = int(start_y + (my - start_y) * ease)
        base_r = 46
        if conv < 1.0:
            radius = int(base_r + (1 - ease) * 120)
            draw_reticle(d, cx, cy, radius, 0.55 + 0.45 * ease)
        else:
            pulse = 1 + 0.14 * math.sin((t - 0.55) / 0.45 * math.pi * 3)
            draw_reticle(d, mx, my, int(base_r * pulse), 1.0)
            # lock-on label above the point (kept clear of the reticle)
            d.text((mx - 30, my - base_r - 30), "LOCKED", font=_font(FONT_BOLD, 22), fill=RETICLE)

        # Right panel: explain the grounding call. Reveal progressively.
        d.text((panel_x, 90), "H Company Holo", font=f_title, fill=WHITE)
        d.text((panel_x, 138), "computer-use grounding", font=f_body, fill=ACCENT)

        def reveal(after):
            return t >= after

        y = 230
        if reveal(0.10):
            d.text((panel_x, y), "INPUT", font=f_lbl, fill=GREY)
            d.text((panel_x, y + 34), "screenshot +", font=f_body, fill=WHITE)
            d.text((panel_x, y + 66), f'\u201c{args.target}\u201d', font=f_body, fill=WHITE)
        y = 360
        if reveal(0.45):
            d.text((panel_x, y), "OUTPUT", font=f_lbl, fill=GREY)
            d.text((panel_x, y + 34), f"click ({gx}, {gy})", font=f_mono, fill=RETICLE)
        y = 470
        if reveal(0.70):
            d.text((panel_x, y), "one API call \u00b7 pixel-perfect", font=f_body, fill=ACCENT)
            d.text((panel_x, y + 34), "holo3-1-35b-a3b", font=_font(FONT_MONO, 22), fill=GREY)

        canvas.save(os.path.join(args.workdir, f"hero_{i:03d}.png"))

    print(f"WROTE {args.frames} frames to {args.workdir}")


if __name__ == "__main__":
    main()
