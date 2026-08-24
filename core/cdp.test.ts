// Regression coverage for findTargetByUrl's target-type filter (AGE-1311 /
// vibebrowser GH#1820): chrome.identity.launchWebAuthFlow() OAuth popups
// (e.g. the Vibe Portal sign-in tab) are classified by CDP's
// Target.getTargets as type "other", not "page". A strict `type === "page"`
// filter silently drops a real, present, URL-matching target, producing a
// misleading "tab never appeared" timeout instead of finding it. This test
// stubs `globalThis.fetch` (restored in `finally`, never leaks into other
// test files) so `listCdpTargets`'s real HTTP call resolves to a fixed
// target list without needing a live CDP endpoint.

import { afterEach, describe, expect, test } from "bun:test";

import { findTargetByUrl, type CdpTarget } from "./cdp";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubTargets(targets: CdpTarget[]) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(targets), { status: 200 })) as unknown as typeof fetch;
}

describe("findTargetByUrl", () => {
  test("matches a type=other OAuth popup target (chrome.identity.launchWebAuthFlow)", async () => {
    stubTargets([
      { id: "1", type: "browser_ui", url: "chrome://newtab-footer/" },
      {
        id: "2",
        type: "other",
        url: "https://portal.vibebrowser.app/auth.html?callback_url=https%3A%2F%2Fabc.chromiumapp.org%2F"
      }
    ]);

    const target = await findTargetByUrl(9444, (url) => /portal\.vibebrowser\.app\/auth\.html/i.test(url), 2_000, "Vibe Portal sign-in tab");
    expect(target.id).toBe("2");
    expect(target.type).toBe("other");
  });

  test("still matches an ordinary type=page target", async () => {
    stubTargets([{ id: "3", type: "page", url: "https://duckduckgo.com/?q=test" }]);

    const target = await findTargetByUrl(9444, (url) => url.includes("duckduckgo.com"), 2_000, "DuckDuckGo tab");
    expect(target.id).toBe("3");
  });

  test("does not match a browser_ui target even if the URL happens to match", async () => {
    stubTargets([{ id: "4", type: "browser_ui", url: "chrome://portal.vibebrowser.app/auth.html-lookalike" }]);

    await expect(
      findTargetByUrl(9444, (url) => url.includes("portal.vibebrowser.app"), 300, "should not match")
    ).rejects.toThrow(/never appeared within/);
  });
});
