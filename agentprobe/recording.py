"""Screen recording and GIF assembly for agentprobe Android harness."""
import subprocess
import threading
import time
from pathlib import Path


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


def assemble_gif(output_dir: str):
    """Assemble step-*.png screenshots into demo.gif using ffmpeg."""
    pngs = sorted(
        p for p in Path(output_dir).glob("step-*.png")
        if not p.name.endswith("-raw.png")
    )
    if not pngs:
        return None

    lines = []
    for p in pngs[:-1]:  # All frames except the last
        lines.append(f"file '{p}'")
        lines.append("duration 0.8")  # Faster transitions
    # Final frame: hold 3.0s so viewer sees the result clearly
    lines.append(f"file '{pngs[-1]}'")
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
