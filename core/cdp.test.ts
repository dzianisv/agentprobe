// Regression coverage for a reproducible AGE-1311 (vibebrowser GH#1820)
// failure: `chrome.identity.launchWebAuthFlow()`'s interactive OAuth popup
// is durably reported as `type: "other"` by `Target.getTargets` (confirmed
// via two independent CI runs of vibebrowser/VibeWebAgent's
// cws-visual-install.ts — the exact same portal.vibebrowser.app/auth.html
// URL sat at `type: "other"` for the entire 30s poll window in both runs,
// not a brief transient state during window creation). `findTargetByUrl`
// used to hardcode `type === "page"`, so that tab could never be found no
// matter how long the caller waited.
//
// These tests spin up a tiny real local HTTP server that mimics Chrome's
// `/json` CDP target-list endpoint, so `findTargetByUrl`'s real `fetch`
// path is exercised end-to-end — no `mock.module()` (see core/interact.ts's
// header comment for why that pattern is avoided here) and no fetch mocking.

import { afterEach, describe, expect, test } from "bun:test";

import { findTargetByUrl, type CdpTarget } from "./cdp";

let server: ReturnType<typeof Bun.serve> | undefined;

function serveTargets(targets: CdpTarget[]): number {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/json") {
        return new Response(JSON.stringify(targets), { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }
  });
  const port = server.port;
  if (port === undefined) throw new Error("Bun.serve() did not assign a port");
  return port;
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe("findTargetByUrl — target type filter (AGE-1311)", () => {
  test("matches a type:page target by default (existing behavior preserved)", async () => {
    const port = serveTargets([{ id: "1", type: "page", url: "https://example.com/auth.html" }]);
    const target = await findTargetByUrl(port, (url) => url.includes("/auth.html"), 2_000, "test target");
    expect(target.id).toBe("1");
  });

  test("does NOT match a type:other target by default (default stays strict)", async () => {
    const port = serveTargets([{ id: "1", type: "other", url: "https://example.com/auth.html" }]);
    await expect(findTargetByUrl(port, (url) => url.includes("/auth.html"), 500, "test target")).rejects.toThrow(
      /never appeared within 500ms/
    );
  });

  test("matches a type:other target when opts.types explicitly widens the match", async () => {
    const port = serveTargets([{ id: "1", type: "other", url: "https://portal.vibebrowser.app/auth.html" }]);
    const target = await findTargetByUrl(
      port,
      (url) => url.includes("/auth.html"),
      2_000,
      "Vibe Portal sign-in tab",
      { types: ["page", "other"] }
    );
    expect(target.id).toBe("1");
    expect(target.type).toBe("other");
  });

  test("still respects the predicate when types is widened (URL mismatch still fails)", async () => {
    const port = serveTargets([{ id: "1", type: "other", url: "https://unrelated.example/anything" }]);
    await expect(
      findTargetByUrl(port, (url) => url.includes("/auth.html"), 500, "test target", { types: ["page", "other"] })
    ).rejects.toThrow(/never appeared within 500ms/);
  });

  test("throws with the label in the message when nothing ever matches", async () => {
    const port = serveTargets([]);
    await expect(findTargetByUrl(port, () => true, 300, "totally missing target")).rejects.toThrow(
      /totally missing target never appeared within 300ms/
    );
  });
});
