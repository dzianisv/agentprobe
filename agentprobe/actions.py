"""Action dispatch for agentprobe Android harness."""
import subprocess
import tempfile
import time
import os

from .android import adb


def _sleep(secs: float, multiplier: float = 1.0) -> None:
    time.sleep(max(0.1, secs * multiplier))


def _adb_escape(text: str) -> str:
    """Escape text for adb shell input text command."""
    return (text
            .replace("\\", "\\\\")
            .replace("$", "\\$")
            .replace("`", "\\`")
            .replace("|", "\\|")
            .replace(" ", "%s")
            .replace("&", "\\&")
            .replace(";", "\\;")
            .replace("'", "\\'")
            .replace("\"", "\\\"")
            .replace("(", "\\(")
            .replace(")", "\\)")
            .replace("<", "\\<")
            .replace(">", "\\>"))


def _fill_field(x: int, y: int, text: str) -> None:
    """Tap field at (x,y), clear it, then type text."""
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(0.4)
    adb("shell", "input", "keyevent", "123")  # KEYCODE_MOVE_END
    time.sleep(0.1)
    for _ in range(6):  # 6 x 50 = 300 backspace presses
        adb("shell", "input", "keyevent", *["67"] * 50)
    time.sleep(0.1)
    adb("shell", "input", "text", _adb_escape(text))
    time.sleep(0.3)


def execute_action(action: dict, speed_multiplier: float = 1.0):
    """Execute an action dict returned by the LLM. Returns status string."""
    act = action.get("type", "")

    if act == "tap":
        x, y = int(action["x"]), int(action["y"])
        adb("shell", "input", "tap", str(x), str(y))
        return f"tapped ({x}, {y})"

    elif act == "type":
        text = action.get("text", "")
        # Write text to device file, then use shell command-substitution to
        # avoid % and quote issues. Ensures special chars are passed correctly.
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write(text)
        tmp_path = tmp.name
        tmp.close()
        try:
            subprocess.run(["adb", "push", tmp_path, "/sdcard/_cua_type.txt"],
                           capture_output=True, timeout=10)
            subprocess.run(
                ["adb", "shell", "input text \"$(cat /sdcard/_cua_type.txt)\""],
                capture_output=True, timeout=30, shell=False,
            )
            # Use shell=True for command substitution
            subprocess.run(
                'adb shell \'input text "$(cat /sdcard/_cua_type.txt)"\'',
                capture_output=True, timeout=30, shell=True,
            )
            _sleep(0.3, speed_multiplier)
        finally:
            os.unlink(tmp_path)
        return f"typed '{text}'"

    elif act == "key":
        key = action.get("key", action.get("keycode", ""))
        key_map = {
            "enter": "66", "back": "4", "home": "3",
            "delete": "67", "tab": "61",
            "KEYCODE_BACK": "4", "KEYCODE_ENTER": "66",
        }
        code = key_map.get(key.lower() if isinstance(key, str) else key, key)
        adb("shell", "input", "keyevent", str(code))
        return f"pressed key {key}"

    elif act == "swipe":
        x1, y1 = int(action["x1"]), int(action["y1"])
        x2, y2 = int(action["x2"]), int(action["y2"])
        duration = int(action.get("duration", action.get("duration_ms", 300)))
        adb("shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(duration))
        return f"swiped ({x1},{y1})->({x2},{y2})"

    elif act == "clear_field":
        adb("shell", "input", "keyevent", "123")  # KEYCODE_MOVE_END
        time.sleep(0.1)
        adb("shell", "input", "keyevent", *["67"] * 200)  # 200x BACKSPACE
        return "cleared field"

    elif act == "wait":
        secs = float(action.get("seconds", 2))
        _sleep(secs, speed_multiplier)
        return f"waited {secs}s"

    elif act == "screenshot":
        label = action.get("label", "observe")
        return f"screenshot requested ({label})"

    elif act == "done":
        return "DONE"

    elif act == "fail":
        return "FAIL: " + action.get("reason", "unknown")

    else:
        return f"unknown action: {act}"
