"""Screen recording and GIF assembly for agentprobe Android harness."""
import subprocess
import threading
import time
import json
from pathlib import Path
try:
    from PIL import Image, ImageDraw, ImageFont
    PILLOW_AVAILABLE = True
except ImportError:
    PILLOW_AVAILABLE = False


def start_screen_recording(scenario_name: str):
    """Start ADB screen recording. Returns (thread, remote_path).

    Stop it with stop_screen_recording(thread, remote_path, local_path), which
    signals the on-device recorder via `pkill -2 screenrecord` and pulls the MP4.
    """
    remote_path = f"/sdcard/cua_{scenario_name}.mp4"

    def _record():
        try:
            subprocess.run(
                ["adb", "shell", f"screenrecord --time-limit 180 {remote_path}"],
                capture_output=True, timeout=200,
            )
        except Exception:
            pass

    thread = threading.Thread(target=_record, daemon=True)
    thread.start()
    time.sleep(1.0)
    return thread, remote_path


def stop_screen_recording(thread, remote_path: str, local_path: str) -> bool:
    """Stop recorder, pull video to local_path. Returns True on success."""
    subprocess.run(
        ["adb", "shell", "pkill", "-2", "screenrecord"],
        capture_output=True, timeout=10,
    )
    time.sleep(2.0)
    thread.join(timeout=5)
    result = subprocess.run(
        ["adb", "pull", remote_path, local_path],
        capture_output=True, timeout=30,
    )
    if result.returncode == 0 and Path(local_path).exists():
        print(f"  [recording] saved to {local_path}")
        return True
    print(f"  [recording] pull failed: {result.stderr.decode(errors='replace').strip()}")
    return False


def overlay_text_on_frame(image_path: str, caption: str) -> str:
    """Add text overlay to a frame. Returns path to overlaid image.

    If Pillow unavailable or caption empty, returns original image path.
    Creates a captioned version at <original>-captioned.png
    """
    if not PILLOW_AVAILABLE or not caption or not caption.strip():
        return image_path

    output_path = image_path.replace(".png", "-captioned.png")
    if Path(output_path).exists():
        return output_path

    try:
        img = Image.open(image_path)
        draw = ImageDraw.Draw(img)

        # Try to use a system font; fall back to default if not available
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 24)
        except (OSError, IOError):
            font = ImageFont.load_default()

        # Add semi-transparent background for text
        text_color = (255, 255, 255)  # white text
        bg_color = (0, 0, 0, 180)  # semi-transparent black

        # Wrap text to fit width
        max_width = img.width - 40
        lines = []
        words = caption.split()
        current_line = []

        for word in words:
            test_line = " ".join(current_line + [word])
            bbox = draw.textbbox((0, 0), test_line, font=font)
            line_width = bbox[2] - bbox[0]

            if line_width > max_width and current_line:
                lines.append(" ".join(current_line))
                current_line = [word]
            else:
                current_line.append(word)

        if current_line:
            lines.append(" ".join(current_line))

        # Draw background and text
        y = 10
        for line in lines:
            bbox = draw.textbbox((20, y), line, font=font)
            # Draw semi-transparent background
            draw.rectangle(
                [(bbox[0]-5, bbox[1]-5), (bbox[2]+5, bbox[3]+5)],
                fill=bg_color
            )
            draw.text((20, y), line, fill=text_color, font=font)
            y += 40

        img.save(output_path)
        return output_path
    except Exception as e:
        print(f"  [caption overlay] failed: {e}")
        return image_path


def assemble_gif(output_dir: str):
    """Assemble step-*.png screenshots into demo.gif using ffmpeg.

    If captions.json exists, overlay reasoning text on frames.
    """
    pngs = sorted(
        p for p in Path(output_dir).glob("step-*.png")
        if not p.name.endswith("-raw.png") and not p.name.endswith("-captioned.png")
    )
    if not pngs:
        return None

    # Load captions if available
    captions_path = Path(output_dir) / "captions.json"
    captions = {}
    if captions_path.exists():
        try:
            captions = json.loads(captions_path.read_text())
        except (json.JSONDecodeError, IOError):
            pass

    # Apply text overlays if captions available
    frame_paths = []
    for p in pngs:
        caption = captions.get(p.name, "")
        if caption:
            captioned = overlay_text_on_frame(str(p), caption)
            frame_paths.append(Path(captioned))
        else:
            frame_paths.append(p)

    lines = []
    for p in frame_paths[:-1]:  # All frames except the last
        lines.append(f"file '{p}'")
        lines.append("duration 0.8")  # Faster transitions
    # Final frame: hold 3.0s so viewer sees the result clearly
    lines.append(f"file '{frame_paths[-1]}'")
    lines.append("duration 3.0")
    list_path = Path(output_dir) / "frames.txt"
    list_path.write_text("\n".join(lines))

    palette_path = Path(output_dir) / "palette.png"
    gif_path = Path(output_dir) / "demo.gif"

    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
             "-i", str(list_path),
             "-vf", "scale=960:-2:flags=lanczos,palettegen=max_colors=256:stats_mode=diff",
             str(palette_path)],
            capture_output=True, timeout=60,
        )
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
             "-i", str(list_path),
             "-i", str(palette_path),
             "-lavfi", "scale=960:-2:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer",
             str(gif_path)],
            capture_output=True, timeout=60,
        )
        if gif_path.exists():
            return str(gif_path)
    except Exception as exc:
        print(f"  [gif] assembly failed: {exc}")
    return None
