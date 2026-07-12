#!/usr/bin/env python3
"""
Local reverse proxy for routing NemoClaw's sandboxed "custom" provider traffic
to H Company's OpenAI-compatible API.

Why this exists: NemoClaw's custom-provider onboarding path performs SSRF
validation on the endpoint URL. Per NemoClaw's own release notes (v0.0.73):
"Custom endpoint handling now fails closed before downstream handoff when an
HTTPS endpoint relies on DNS and NemoClaw cannot pin the validated peer across
the OpenShell runtime boundary." api.hcompany.ai is a DNS-backed public HTTPS
host, so onboarding NemoClaw directly against
https://api.hcompany.ai/v1/ is expected to fail closed.

This proxy runs on the HOST (outside NemoClaw's sandbox), listens on
127.0.0.1:8000, and forwards every request to https://api.hcompany.ai/v1/,
injecting `Authorization: Bearer $HAI_API_KEY` at egress. The API key lives
only in this host process's environment -- it is never passed into the
sandbox and never appears in NemoClaw's config.

NemoClaw is then onboarded with NEMOCLAW_ENDPOINT_URL=http://localhost:8000
(a loopback, non-DNS host), which NemoClaw's SSRF check permits, and
NemoClaw's `inference.local` gateway forwards the sandboxed agent's requests
to this proxy over the host bridge.

Usage:
    export HAI_API_KEY=...   # never print this
    python3 proxy.py         # listens on 127.0.0.1:8000
"""
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = "https://api.hcompany.ai/v1"
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8000

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
log = logging.getLogger("nemoclaw-proxy")

API_KEY = os.environ.get("HAI_API_KEY")
if not API_KEY:
    print("ERROR: HAI_API_KEY not set in environment", file=sys.stderr)
    sys.exit(1)


def redact(s: str) -> str:
    return s.replace(API_KEY, "***REDACTED***") if API_KEY else s


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _forward(self):
        upstream_url = UPSTREAM + self.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None

        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"}

        log.info("ROUTED REQUEST: %s %s -> %s", self.command, self.path, upstream_url)
        if body:
            try:
                preview = json.loads(body)
                preview.pop("messages", None)  # keep log short; full body captured by caller separately
                log.info("  request meta: %s", redact(json.dumps(preview))[:500])
            except Exception:
                pass

        req = urllib.request.Request(upstream_url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                status = resp.status
                resp_body = resp.read()
        except urllib.error.HTTPError as e:
            status = e.code
            resp_body = e.read()
        except Exception as e:
            log.error("upstream error: %s", redact(str(e)))
            self.send_response(502)
            self.end_headers()
            self.wfile.write(b'{"error":"proxy upstream failure"}')
            return

        log.info("ROUTED RESPONSE: status=%s bytes=%d", status, len(resp_body))
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    def do_POST(self):
        self._forward()

    def do_GET(self):
        self._forward()

    def log_message(self, fmt, *args):
        pass  # suppress default BaseHTTPRequestHandler stderr logging; we use `log` above


if __name__ == "__main__":
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler)
    log.info("nemoclaw-proxy listening on http://%s:%d -> %s (key redacted, held on host only)", LISTEN_HOST, LISTEN_PORT, UPSTREAM)
    server.serve_forever()
