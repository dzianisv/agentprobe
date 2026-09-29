import { describe, expect, test } from "bun:test";

import { classifyClickEffect, isExpectedListingUrl, verifyClickEffect, type ClickSurfaceSnapshot } from "./click-effect";

function surface(overrides: Partial<ClickSurfaceSnapshot> = {}): ClickSurfaceSnapshot {
  return {
    onExpectedUrl: true,
    url: "https://chromewebstore.google.com/detail/x/abc",
    hitTarget: true,
    visibleModalCount: 0,
    target: { text: "Add to Chrome", disabled: false, ariaBusy: null },
    ...overrides
  };
}

describe("classifyClickEffect", () => {
  test("retries when an in-page modal appears", () => {
    const effect = classifyClickEffect(surface(), surface({ visibleModalCount: 1 }));
    expect(effect.action).toBe("retry");
    expect(effect.detail).toContain("modal count rose");
  });

  test("retries when the page navigates away", () => {
    const effect = classifyClickEffect(surface(), surface({ onExpectedUrl: false, url: "https://www.linkedin.com/login/" }));
    expect(effect.action).toBe("retry");
    expect(effect.detail).toContain("linkedin.com");
  });

  test("retries when an overlay covers the target", () => {
    const effect = classifyClickEffect(surface(), surface({ hitTarget: false }));
    expect(effect.action).toBe("retry");
  });

  test("proceeds with proof when the target's own state changes and it is still hit", () => {
    const effect = classifyClickEffect(
      surface(),
      surface({ target: { text: "Add to Chrome", disabled: true, ariaBusy: "true" } })
    );
    expect(effect.action).toBe("proceed");
    if (effect.action === "proceed") expect(effect.proof).toBe("target-state-changed");
  });

  test("does not treat an unchanged page as proof the OS dialog opened", () => {
    const effect = classifyClickEffect(surface(), surface());
    expect(effect.action).toBe("proceed");
    if (effect.action === "proceed") {
      expect(effect.proof).toBe("none");
      expect(effect.detail).toContain("not proof");
    }
  });
});

describe("isExpectedListingUrl", () => {
  const listing = "https://chromewebstore.google.com/detail/agentpod/debnoedbgfbghngljlglhmdopdpbokno";
  const itemId = "debnoedbgfbghngljlglhmdopdpbokno";

  test("accepts the listing path and rejects a share redirect that merely embeds the id", () => {
    expect(isExpectedListingUrl(listing, itemId, listing)).toBe(true);
    expect(
      isExpectedListingUrl(
        "https://www.linkedin.com/login/?session_redirect=https%3A%2F%2Fchromewebstore.google.com%2Fdetail%2Fdebnoedbgfbghngljlglhmdopdpbokno",
        itemId,
        listing
      )
    ).toBe(false);
  });
});

describe("verifyClickEffect", () => {
  test("does not retry when the post-click DOM read fails", () => {
    const result = verifyClickEffect(surface(), { error: "CDP Runtime.evaluate timeout" });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("Not retrying");
  });

  test("retries a readable in-page modal", () => {
    const result = verifyClickEffect(surface(), surface({ visibleModalCount: 1 }));
    expect(result.ok).toBe(false);
  });
});
