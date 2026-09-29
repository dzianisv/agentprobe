// The model's scaled screen point is not authoritative when the caller already
// holds the target's rect in that same space. A point outside the rect must
// not be clicked — the proven failure is a vision answer that landed on the
// Chrome Web Store Share control while the DOM rect of "Add to Chrome" was
// already known. These tests call `selectVisionClickPoint` directly (no
// module mocking, no live xdotool): that function is what
// `visionLocateAndClick` clicks.

import { describe, expect, test } from "bun:test";

import { selectVisionClickPoint } from "./vision";

const failureRect = { x: 1341, y: 134, width: 147, height: 40 };
const failureModelPoint = { x: 1257, y: 357 };

describe("selectVisionClickPoint", () => {
  test("a vision point inside the expected screen rect is the click target", () => {
    const centre = { x: 1415, y: 154 };
    const selection = selectVisionClickPoint(centre, { space: "screen", rect: failureRect }, "Add to Chrome button");
    expect(selection.point).toEqual(centre);
    expect(selection.source).toBe("model");
    expect(selection.regionCheck).toBe("inside");
    expect(selection.logs.join("\n")).toContain("clicking the model point");
    expect(selection.logs.join("\n")).not.toContain("REJECTED");
  });

  test("a vision point outside the expected screen rect falls back to the rect centre and logs both", () => {
    const selection = selectVisionClickPoint(
      failureModelPoint,
      { space: "screen", rect: failureRect },
      "Add to Chrome button"
    );
    expect(selection.point).toEqual({ x: 1415, y: 154 });
    expect(selection.source).toBe("rect-centre-fallback");
    expect(selection.regionCheck).toBe("outside-fallback");
    expect(selection.modelPoint).toEqual(failureModelPoint);
    const log = selection.logs.join("\n");
    expect(log).toContain("REJECTED model point (1257, 357)");
    expect(log).toContain(JSON.stringify(failureRect));
    expect(log).toContain("rect centre (1415, 154)");
    expect(log).toContain("Not clicking it");
  });

  test("no rect supplied keeps the model point and adds no cross-check log", () => {
    const selection = selectVisionClickPoint(failureModelPoint, undefined, "Add to Chrome button");
    expect(selection.point).toEqual(failureModelPoint);
    expect(selection.source).toBe("model");
    expect(selection.regionCheck).toBe("not-supplied");
    expect(selection.logs).toEqual([]);
  });

  test("a viewport-tagged rect is not applied, even when the model point is outside it", () => {
    const selection = selectVisionClickPoint(
      failureModelPoint,
      { space: "viewport", rect: failureRect },
      "Add to Chrome button"
    );
    expect(selection.point).toEqual(failureModelPoint);
    expect(selection.source).toBe("model");
    expect(selection.regionCheck).toBe("skipped-not-screen-space");
    const log = selection.logs.join("\n");
    expect(log).toContain('space "viewport"');
    expect(log).toContain("not falling back");
    expect(log).not.toContain("REJECTED");
  });
});
