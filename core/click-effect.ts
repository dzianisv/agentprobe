// Classify whether a click's effect is observable in the page DOM.
//
// An OS-level dialog (Chrome's "Add extension?" prompt) is not in the DOM, so
// this cannot prove that dialog opened. It CAN prove the click did something
// else: left the page, opened an in-page modal, or covered the target. Those
// are retry conditions. Absence of those is not positive proof — callers must
// not describe `proof: "none"` as confirmation the click landed.

export type ClickTargetSnapshot = {
  text: string;
  disabled: boolean;
  ariaBusy: string | null;
};

export type ClickSurfaceSnapshot = {
  onExpectedUrl: boolean;
  url: string;
  /** True when document.elementFromPoint at the target's centre hits the target (or a descendant). */
  hitTarget: boolean;
  visibleModalCount: number;
  target: ClickTargetSnapshot | null;
};

export type ClickEffect =
  | { action: "retry"; detail: string }
  | { action: "proceed"; proof: "target-state-changed" | "none"; detail: string };

export type ClickSurfaceRead = ClickSurfaceSnapshot | { error: string };

/**
 * True only when `href` is still the listing: same origin as `listingUrl` and
 * the item id is in the path. A share-redirect (for example a LinkedIn login
 * URL whose query embeds the listing) contains the id but is not the listing.
 */
export function isExpectedListingUrl(href: string, itemId: string, listingUrl: string): boolean {
  try {
    const page = new URL(href);
    const listing = new URL(listingUrl);
    return page.origin === listing.origin && page.pathname.includes(itemId);
  } catch {
    return false;
  }
}

export function isClickSurfaceSnapshot(value: unknown): value is ClickSurfaceSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.onExpectedUrl !== "boolean" || typeof v.url !== "string" || typeof v.hitTarget !== "boolean") return false;
  if (typeof v.visibleModalCount !== "number" || !Number.isFinite(v.visibleModalCount)) return false;
  if (v.target === null) return true;
  if (!v.target || typeof v.target !== "object") return false;
  const target = v.target as Record<string, unknown>;
  return typeof target.text === "string" && typeof target.disabled === "boolean" && (target.ariaBusy === null || typeof target.ariaBusy === "string");
}

function targetStateChanged(before: ClickTargetSnapshot, after: ClickTargetSnapshot): boolean {
  return before.text !== after.text || before.disabled !== after.disabled || before.ariaBusy !== after.ariaBusy;
}

/**
 * Negatives first: a new in-page modal, a covered target, or a navigation is
 * evidence the click did not land on the intended control (or that the page
 * is no longer the one we aimed at). A change in the target's own
 * text/disabled/aria-busy is a real page-level effect and is the only
 * positive signal this function will claim. No change at all is `proceed`
 * with `proof: "none"` — not a confirmation.
 */
export function classifyClickEffect(before: ClickSurfaceSnapshot, after: ClickSurfaceSnapshot): ClickEffect {
  if (!after.onExpectedUrl) {
    return { action: "retry", detail: `left the expected page (${after.url})` };
  }
  if (after.visibleModalCount > before.visibleModalCount) {
    return {
      action: "retry",
      detail: `in-page modal count rose ${before.visibleModalCount} -> ${after.visibleModalCount} (a page overlay opened; an OS-level dialog is not in the DOM)`
    };
  }
  if (before.hitTarget && !after.hitTarget) {
    return { action: "retry", detail: "target is no longer the topmost element at its centre (an overlay is covering it)" };
  }
  if (before.target && !after.target) {
    return { action: "retry", detail: "target element disappeared" };
  }
  if (before.target && after.target && targetStateChanged(before.target, after.target) && after.hitTarget) {
    return {
      action: "proceed",
      proof: "target-state-changed",
      detail: `target state changed ${JSON.stringify(before.target)} -> ${JSON.stringify(after.target)}`
    };
  }
  return {
    action: "proceed",
    proof: "none",
    detail:
      "no in-page misclick evidence (still on the expected page, no new modal, target still topmost). " +
      "No honest positive signal that an OS-level dialog opened — it is not in the DOM — so this is not proof the click landed on the install control."
  };
}

function isSnapshot(read: ClickSurfaceRead | null): read is ClickSurfaceSnapshot {
  return !!read && !("error" in read);
}

/**
 * Map a before/after DOM read onto the retry loop's ok flag.
 *
 * A failed post-click read is NOT a retry. Chrome's native install dialog is
 * OS-level and can block the renderer; Escape-on-retry would dismiss that
 * dialog. An unreadable page is therefore "do not send Escape", not "the
 * click missed". A readable page that shows a misclick (modal, navigation,
 * covered target) is a retry.
 */
export function verifyClickEffect(before: ClickSurfaceRead | null, after: ClickSurfaceRead | null): { ok: boolean; detail: string } {
  if (!isSnapshot(after)) {
    return {
      ok: true,
      detail:
        `post-click DOM read failed (${after?.error ?? "no snapshot"}). Not retrying: Escape would dismiss a native install dialog CDP cannot see, ` +
        `and a blocked renderer is consistent with that dialog. This is not positive proof the click landed.`
    };
  }
  if (!isSnapshot(before)) {
    if (!after.onExpectedUrl || after.visibleModalCount > 0 || !after.hitTarget || !after.target) {
      return { ok: false, detail: `post-click surface looks like a misclick without a baseline (${JSON.stringify(after)})` };
    }
    return {
      ok: true,
      detail: "pre-click DOM snapshot failed and the post-click page shows no misclick evidence. Not proof the native dialog opened."
    };
  }
  const effect = classifyClickEffect(before, after);
  return { ok: effect.action === "proceed", detail: effect.detail };
}
