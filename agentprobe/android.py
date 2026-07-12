"""ADB primitives for agentprobe Android harness. No agentprobe imports."""
import base64
import os
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path


_step_counter = 0
_speed_multiplier = 1.0


def _sleep(seconds: float) -> None:
    time.sleep(max(0.1, seconds * _speed_multiplier))


def adb(*args: str) -> str:
    """Run an adb command and return stdout."""
    result = subprocess.run(
        ["adb", *args],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0 and "Error" in result.stderr:
        raise RuntimeError(f"adb {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def _bounds_center(bounds: str):
    match = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds or "")
    if not match:
        return None
    x1, y1, x2, y2 = map(int, match.groups())
    return ((x1 + x2) // 2, (y1 + y2) // 2)


def current_foreground_package() -> str:
    """Return resumed foreground package name."""
    out = adb("shell", "dumpsys", "activity", "activities")
    for line in out.splitlines():
        if "mResumedActivity" not in line:
            continue
        match = re.search(r"\s([a-zA-Z0-9_\.]+)/", line)
        if match:
            return match.group(1)
    return ""


def ensure_app_foreground(package: str, retries: int = 3, verbose: bool = False) -> bool:
    """Bring app to foreground before scenario start."""
    for attempt in range(retries):
        current = current_foreground_package()
        if current == package:
            return True
        adb("shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1")
        _sleep(2.0)
        if verbose:
            seen = current or "unknown"
            print(f"  [prep] foreground was '{seen}', launched '{package}' (attempt {attempt + 1}/{retries})")
    return current_foreground_package() == package


def maybe_dismiss_telemetry_consent(package: str, verbose: bool = False) -> bool:
    """Dismiss first-launch telemetry consent modal when present."""
    xml = ui_dump()
    if not xml:
        return False
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return False

    consent_markers = ("help improve", "share anonymous crash reports")
    dismiss_markers = (
        "not now", "no thanks", "decline", "skip", "later",
        "don't allow", "dont allow", "deny", "continue without",
        "opt out", "cancel",
    )

    page_text = " ".join(
        " ".join(filter(None, [
            node.attrib.get("text", ""),
            node.attrib.get("content-desc", ""),
        ])).lower()
        for node in root.iter()
    )

    if not any(marker in page_text for marker in consent_markers):
        return False

    candidates = []
    for node in root.iter():
        if node.attrib.get("clickable") != "true":
            continue
        label = " ".join(filter(None, [
            node.attrib.get("text", ""),
            node.attrib.get("content-desc", ""),
            node.attrib.get("resource-id", ""),
        ])).strip().lower()
        center = _bounds_center(node.attrib.get("bounds", ""))
        if not center:
            continue
        candidates.append((label, center))

    for label, (x, y) in candidates:
        if any(marker in label for marker in dismiss_markers):
            adb("shell", "input", "tap", str(x), str(y))
            _sleep(1.0)
            if verbose:
                print(f"  [prep] dismissed telemetry consent via '{label or 'button'}' at ({x}, {y})")
            return True

    if verbose:
        print("  [prep] telemetry consent detected but dismiss button not found")
    return False


def screenshot_b64(label: str = "", output_dir: str = "/tmp") -> str:
    """Capture screenshot and return base64 PNG. Saves to output_dir."""
    global _step_counter
    _step_counter += 1
    suffix = f"_{label}" if label else ""
    debug_path = Path(output_dir) / f"step-{_step_counter:03d}{suffix}.png"
    debug_path.parent.mkdir(parents=True, exist_ok=True)

    for attempt in range(3):
        try:
            result = subprocess.run(
                ["adb", "exec-out", "screencap", "-p"],
                capture_output=True, timeout=30,
            )
            if result.returncode == 0 and len(result.stdout) > 100:
                debug_path.write_bytes(result.stdout)
                return base64.b64encode(result.stdout).decode()
        except subprocess.TimeoutExpired:
            if attempt < 2:
                _sleep(3)
                continue
            raise

    # Fallback: screencap on device then pull.
    # /data/local/tmp (not /sdcard) -- /sdcard is backed by the emulated SD
    # card / FUSE-mounted external storage, which is not always mounted right
    # after boot and fails writes with no useful error. /data/local/tmp is a
    # plain shell-writable directory that's available as soon as the device
    # answers `adb shell`, and (unlike /sdcard) doesn't need MediaStore/FUSE.
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        path = f.name
    try:
        subprocess.run(["adb", "shell", "screencap", "-p", "/data/local/tmp/_cua_screen.png"],
                       capture_output=True, timeout=30)
        subprocess.run(["adb", "pull", "/data/local/tmp/_cua_screen.png", path],
                       capture_output=True, timeout=10)
        data = Path(path).read_bytes()
        debug_path.write_bytes(data)
        return base64.b64encode(data).decode()
    finally:
        Path(path).unlink(missing_ok=True)


def ui_dump(tmp_dir: str = "/tmp") -> str:
    """Dump UI hierarchy XML and return as string."""
    try:
        adb("shell", "uiautomator", "dump", "/data/local/tmp/_cua_ui.xml")
        result = subprocess.run(
            ["adb", "pull", "/data/local/tmp/_cua_ui.xml", f"{tmp_dir}/_cua_ui.xml"],
            capture_output=True, timeout=10,
        )
        if result.returncode == 0:
            return Path(f"{tmp_dir}/_cua_ui.xml").read_text(errors="replace")
    except Exception:
        pass
    return ""


def check_ui_text(text: str, case_sensitive: bool = False) -> bool:
    """Return True if text appears anywhere in the current UI hierarchy XML."""
    xml = ui_dump()
    haystack = xml if case_sensitive else xml.lower()
    needle = text if case_sensitive else text.lower()
    return needle in haystack


def check_notification_drawer(expected_text: str, timeout: int = 10) -> bool:
    """Return True if expected_text appears in OS notification drawer within timeout seconds."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            out = subprocess.check_output(
                ["adb", "shell", "dumpsys", "notification", "--noredact"],
                text=True, stderr=subprocess.DEVNULL, timeout=10,
            )
            if expected_text.lower() in out.lower():
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def simulate_network_drop() -> None:
    """Cut all network connectivity on the emulator/device."""
    adb("shell", "svc", "wifi", "disable")
    adb("shell", "svc", "data", "disable")


def restore_network() -> None:
    """Restore network connectivity after simulate_network_drop()."""
    adb("shell", "svc", "wifi", "enable")
    adb("shell", "svc", "data", "enable")


def background_app() -> None:
    """Press Home to background the app."""
    adb("shell", "input", "keyevent", "KEYCODE_HOME")
    _sleep(1.0)


def foreground_app(package: str) -> None:
    """Bring the app back to foreground."""
    adb("shell", "monkey", "-p", package, "-c", "android.intent.category.LAUNCHER", "1")
    _sleep(1.5)


@lru_cache(maxsize=1)
def get_screen_size():
    """Return (width, height) of the connected device screen. Cached."""
    try:
        out = adb("shell", "wm", "size")
        for line in out.splitlines():
            if "size:" in line.lower():
                dims = line.split(":")[-1].strip()
                w, h = dims.split("x")
                return int(w), int(h)
    except Exception:
        pass
    return 1080, 1920


def upload_to_archivebox(video_path: str, scenario_name: str) -> bool:
    """Upload video to ArchiveBox if ARCHIVEBOX_URL is configured. No-op if not set."""
    url = os.environ.get("ARCHIVEBOX_URL", "").rstrip("/")
    api_key = os.environ.get("ARCHIVEBOX_API_KEY", "")
    if not url:
        return False

    import urllib.request

    try:
        video_data = Path(video_path).read_bytes()
        boundary = "----CUAUploadBoundary"
        body_parts = []
        body_parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"url\"\r\n\r\nfile://{scenario_name}.mp4".encode()
        )
        body_parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{scenario_name}.mp4\"\r\nContent-Type: video/mp4\r\n\r\n".encode()
            + video_data
        )
        body_parts.append(f"--{boundary}--\r\n".encode())
        body = b"\r\n".join(body_parts)
        headers = {
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        }
        if api_key:
            headers["X-API-Key"] = api_key
        req = urllib.request.Request(f"{url}/api/v1/add", data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=60) as resp:
            print(f"  [archivebox] uploaded {scenario_name}.mp4 -> {url} ({resp.status})")
            return True
    except Exception as exc:
        print(f"  [archivebox] upload failed: {exc}")
        return False
