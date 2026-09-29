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

  test("a covered target on the unchanged listing is the install-pending state, not a misclick", () => {
    // Chrome's native "Add extension?" prompt is OS-level: CDP cannot see it,
    // but it dims the page, so elementFromPoint stops hitting the button.
    // Calling that a misclick made a working click retry five times.
    const effect = classifyClickEffect(surface(), surface({ hitTarget: false }));
    expect(effect.action).toBe("proceed");
    if (effect.action === "proceed") {
      expect(effect.proof).toBe("target-yielded-to-install");
      expect(effect.detail).toContain("Not proof");
    }
  });

  test("a covered target still retries when a new in-page modal explains it", () => {
    const effect = classifyClickEffect(surface(), surface({ hitTarget: false, visibleModalCount: 1 }));
    expect(effect.action).toBe("retry");
    expect(effect.detail).toContain("modal count rose");
  });

  test("a vanished target on the unchanged listing proceeds (button swapped for a spinner)", () => {
    const effect = classifyClickEffect(surface(), surface({ target: null, hitTarget: false }));
    expect(effect.action).toBe("proceed");
    if (effect.action === "proceed") expect(effect.proof).toBe("target-yielded-to-install");
  });

  test("a vanished target still retries when the page navigated away", () => {
    const effect = classifyClickEffect(surface(), surface({ target: null, onExpectedUrl: false, url: "https://www.linkedin.com/login/" }));
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

  test("without a baseline, a covered target alone is not called a misclick", () => {
    const result = verifyClickEffect({ error: "pre-click read failed" }, surface({ hitTarget: false, target: null }));
    expect(result.ok).toBe(true);
  });

  test("without a baseline, a navigation away is still a misclick", () => {
    const result = verifyClickEffect({ error: "pre-click read failed" }, surface({ onExpectedUrl: false, url: "https://www.linkedin.com/login/" }));
    expect(result.ok).toBe(false);
  });
});
