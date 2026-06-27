"""Action dispatch for agentprobe Android harness."""
import subprocess
import time

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
        # shell=True so the host shell handles the quoting; _adb_escape
        # sanitises characters that confuse `adb shell input text`.
        escaped = _adb_escape(text)
        subprocess.run(
            f"adb shell input text '{escaped}'",
            capture_output=True, timeout=30, shell=True,
        )
        _sleep(0.3, speed_multiplier)
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
