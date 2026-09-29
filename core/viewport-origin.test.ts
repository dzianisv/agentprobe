import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import {
  VIEWPORT_ORIGIN_MARKER,
  findUniqueSolidBox,
  measureViewportOriginOnScreen,
  viewportRectToScreenRect
} from "./viewport-origin";

async function pngWithBox(
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
  color: { r: number; g: number; b: number }
): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3, 255);
  for (let y = box.y; y < box.y + box.height; y++) {
    for (let x = box.x; x < box.x + box.width; x++) {
      const i = (y * width + x) * 3;
      pixels[i] = color.r;
      pixels[i + 1] = color.g;
      pixels[i + 2] = color.b;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("measureViewportOriginOnScreen", () => {
  test("derives the viewport origin from the marker's screen position", async () => {
    const png = await pngWithBox(120, 80, { x: 20, y: 30, width: 16, height: 16 }, VIEWPORT_ORIGIN_MARKER.color);
    const calls: string[] = [];
    const origin = await measureViewportOriginOnScreen(
      {
        evaluate: async (expression) => {
          calls.push(expression);
          if (expression.includes("getBoundingClientRect")) {
            return JSON.stringify({ dpr: 1, x: 0, y: 0, width: 16, height: 16 });
          }
          return "removed";
        },
        capturePng: async () => png
      },
      { expectedScreenWidth: 120, expectedScreenHeight: 80 }
    );
    expect(origin).toEqual({ x: 20, y: 30, devicePixelRatio: 1 });
    expect(calls.some((c) => c.includes("el.remove()"))).toBe(true);
  });

  test("returns null when the capture size is not the click's screen space", async () => {
    const png = await pngWithBox(120, 80, { x: 20, y: 30, width: 16, height: 16 }, VIEWPORT_ORIGIN_MARKER.color);
    const origin = await measureViewportOriginOnScreen(
      {
        evaluate: async (expression) => {
          if (expression.includes("getBoundingClientRect")) {
            return JSON.stringify({ dpr: 1, x: 0, y: 0, width: 16, height: 16 });
          }
          return "removed";
        },
        capturePng: async () => png
      },
      { expectedScreenWidth: 1920, expectedScreenHeight: 1080 }
    );
    expect(origin).toBeNull();
  });

  test("returns null when two marker-sized blobs match", () => {
    const width = 80;
    const height = 40;
    const data = new Uint8Array(width * height * 3);
    data.fill(255);
    const paint = (x0: number, y0: number) => {
      for (let y = y0; y < y0 + 16; y++) {
        for (let x = x0; x < x0 + 16; x++) {
          const i = (y * width + x) * 3;
          data[i] = VIEWPORT_ORIGIN_MARKER.color.r;
          data[i + 1] = VIEWPORT_ORIGIN_MARKER.color.g;
          data[i + 2] = VIEWPORT_ORIGIN_MARKER.color.b;
        }
      }
    };
    paint(2, 2);
    paint(40, 10);
    expect(findUniqueSolidBox(data, width, height, 3, VIEWPORT_ORIGIN_MARKER.color, 16)).toBeNull();
  });
});

describe("viewportRectToScreenRect", () => {
  test("adds the measured origin and scales by devicePixelRatio", () => {
    expect(viewportRectToScreenRect({ x: 1341, y: 134, width: 147, height: 40 }, { x: 8, y: 87 }, 1)).toEqual({
      x: 1349,
      y: 221,
      width: 147,
      height: 40
    });
    expect(viewportRectToScreenRect({ x: 10, y: 20, width: 30, height: 40 }, { x: 4, y: 6 }, 2)).toEqual({
      x: 24,
      y: 46,
      width: 60,
      height: 80
    });
  });
});
