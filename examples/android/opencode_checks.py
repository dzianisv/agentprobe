"""App-specific deterministic API checks for the OpenCode Mobile example.

These are NOT generic agentprobe primitives — they hardcode the OpenCode server
REST shape (/session, port 4096). They live here in examples/ as a pattern for
pairing a CUA run with a deterministic server-side assertion. Copy and adapt the
endpoint/paths for your own app's API. Uses urllib.request only — no deps."""
import json
import time
import urllib.request


def wait_for_session_idle(opencode_url: str, timeout: int = 120, poll_interval: float = 2.0):
    """Poll GET /session until status == 'idle'. Returns session dict or None on timeout."""
    api = opencode_url.rstrip("/")
    candidates = [api]
    if "127.0.0.1" not in api and "localhost" not in api:
        candidates.append("http://127.0.0.1:4096")

    deadline = time.time() + timeout
    while time.time() < deadline:
        for base in candidates:
            try:
                resp = urllib.request.urlopen(f"{base}/session?limit=10&roots=true", timeout=5)
                sessions = json.loads(resp.read())
                if sessions:
                    latest = max(sessions, key=lambda s: s.get("created", 0))
                    if latest.get("status") == "idle":
                        return latest
            except Exception:
                pass
        time.sleep(poll_interval)
    return None


def check_session_file_created(opencode_url: str, filename: str) -> dict:
    """Check the most recent session's messages for a file-creation tool call naming filename."""
    api = opencode_url.rstrip("/")
    candidates = [api]
    if "127.0.0.1" not in api and "localhost" not in api:
        candidates.append("http://127.0.0.1:4096")

    for base in candidates:
        try:
            resp = urllib.request.urlopen(f"{base}/session?limit=10&roots=true", timeout=5)
            sessions = json.loads(resp.read())
            if not sessions:
                continue
            latest = max(sessions, key=lambda s: s.get("created", 0))
            sid = latest["id"]
            resp2 = urllib.request.urlopen(f"{base}/session/{sid}/message?limit=100", timeout=10)
            messages = json.loads(resp2.read())
            needle = filename.lower()
            for msg in messages:
                for part in msg.get("parts", []):
                    if needle in json.dumps(part).lower():
                        return {
                            "found": True,
                            "session_id": sid,
                            "evidence": f"filename '{filename}' found in message part: {part.get('type', '?')}",
                        }
            return {"found": False, "session_id": sid, "evidence": "filename not found in any message part"}
        except Exception:
            continue
    return {"found": False, "session_id": None, "evidence": f"API unreachable: {opencode_url}"}
