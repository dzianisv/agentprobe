// Locate the browser viewport's origin in screen pixels without assuming a
// chrome-UI height or a window position.
//
// DOM `getBoundingClientRect` is viewport space. `xdotool` clicks (and scrot
// pixels) are screen space. They differ by the browser chrome-UI offset,
// which is not a stable constant — tab strip, omnibox, bookmark bar, and
// download shelf all move it. Computing that offset from `outerHeight -
// innerHeight` guesses which edge the chrome occupies. This module instead
// paints a uniquely colored marker at a known viewport position, finds that
// color in a full-screen capture, and derives the origin from the match.
// If the marker cannot be found uniquely, the measurement returns null and
// the caller must skip the screen-space cross-check rather than guess.

import sharp from "sharp";

import type { Rect } from "./cdp";

export const VIEWPORT_ORIGIN_MARKER = {
  id: "__agentprobe_viewport_origin",
  sizeCssPx: 16,
  // Not a UI color the page is likely to paint as a solid block. Exact match
  // only — a near miss is "not found", never a guessed offset.
  color: { r: 255, g: 0, b: 254 }
} as const;

export type ViewportOrigin = { x: number; y: number; devicePixelRatio: number };

export type ViewportOriginDeps = {
  /** Run `expression` in the page. Must return the JSON string the expression builds, or undefined. */
  evaluate: (expression: string) => Promise<string | undefined>;
  /** Capture the full screen AFTER the marker is in the DOM. Return null if the capture failed. */
  capturePng: () => Promise<Buffer | null>;
};

export function viewportOriginInstallExpression(): string {
  const { id, sizeCssPx, color } = VIEWPORT_ORIGIN_MARKER;
  const css = `rgb(${color.r}, ${color.g}, ${color.b})`;
  return `(() => {
    const id = ${JSON.stringify(id)};
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.setAttribute("data-agentprobe", "viewport-origin");
      el.style.cssText = "position:fixed;left:0;top:0;width:${sizeCssPx}px;height:${sizeCssPx}px;z-index:2147483647;pointer-events:none;margin:0;border:0;padding:0;outline:none;background:${css};";
      (document.documentElement || document.body).appendChild(el);
    }
    const r = el.getBoundingClientRect();
    return JSON.stringify({ dpr: window.devicePixelRatio || 1, x: r.x, y: r.y, width: r.width, height: r.height });
  })()`;
}

export function viewportOriginRemoveExpression(): string {
  const id = JSON.stringify(VIEWPORT_ORIGIN_MARKER.id);
  return `(() => { const el = document.getElementById(${id}); if (el) el.remove(); return "removed"; })()`;
}

type Box = { x: number; y: number; width: number; height: number; count: number };

/**
 * Find the single solid block of `color` whose size matches `expectedSize`
 * (device pixels). Zero matches or more than one match returns null — an
 * ambiguous color must not be turned into a click offset.
 */
export function findUniqueSolidBox(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  color: { r: number; g: number; b: number },
  expectedSize: number
): { x: number; y: number; width: number; height: number } | null {
  if (width <= 0 || height <= 0 || channels < 3 || expectedSize <= 0) return null;
  const pixels = width * height;
  const match = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) {
    const i = p * channels;
    if (data[i] === color.r && data[i + 1] === color.g && data[i + 2] === color.b) match[p] = 1;
  }

  const seen = new Uint8Array(pixels);
  const components: Box[] = [];
  for (let start = 0; start < pixels; start++) {
    if (!match[start] || seen[start]) continue;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let count = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const idx = stack.pop() as number;
      const cx = idx % width;
      const cy = (idx - cx) / width;
      count++;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      if (cx > 0) {
        const left = idx - 1;
        if (match[left] && !seen[left]) {
          seen[left] = 1;
          stack.push(left);
        }
      }
      if (cx + 1 < width) {
        const right = idx + 1;
        if (match[right] && !seen[right]) {
          seen[right] = 1;
          stack.push(right);
        }
      }
      if (cy > 0) {
        const up = idx - width;
        if (match[up] && !seen[up]) {
          seen[up] = 1;
          stack.push(up);
        }
      }
      if (cy + 1 < height) {
        const down = idx + width;
        if (match[down] && !seen[down]) {
          seen[down] = 1;
          stack.push(down);
        }
      }
    }
    components.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, count });
  }

  // Antialiasing can eat the border of a solid marker. Accept one component
  // whose box and pixel count are still recognizably that marker, and reject
  // everything else (including two same-sized blobs).
  const minRatio = 0.45;
  const maxRatio = 1.25;
  const expectedArea = expectedSize * expectedSize;
  const fitting = components.filter((c) => {
    const sizeOk =
      c.width >= expectedSize * minRatio &&
      c.width <= expectedSize * maxRatio &&
      c.height >= expectedSize * minRatio &&
      c.height <= expectedSize * maxRatio;
    const countOk = c.count >= expectedArea * minRatio && c.count <= expectedArea * maxRatio;
    return sizeOk && countOk;
  });
  if (fitting.length !== 1) return null;
  const box = fitting[0]!;
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

/**
 * Screen position of viewport (0, 0) from a marker box found in a screen
 * capture. Symmetric border loss (antialiasing) is added back; a box that
 * does not match `expectedDeviceSize` closely enough returns null.
 */
export function viewportOriginFromMarkerBox(
  box: { x: number; y: number; width: number; height: number },
  markerCss: { x: number; y: number },
  dpr: number,
  expectedDeviceSize: number
): { x: number; y: number } | null {
  if (!Number.isFinite(dpr) || dpr <= 0 || expectedDeviceSize <= 0) return null;
  const insetX = (expectedDeviceSize - box.width) / 2;
  const insetY = (expectedDeviceSize - box.height) / 2;
  const x = box.x - insetX - markerCss.x * dpr;
  const y = box.y - insetY - markerCss.y * dpr;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Convert a viewport-space DOM rect into screen pixels using a measured origin. */
export function viewportRectToScreenRect(rect: Rect, origin: { x: number; y: number }, dpr: number): Rect {
  return {
    x: origin.x + rect.x * dpr,
    y: origin.y + rect.y * dpr,
    width: rect.width * dpr,
    height: rect.height * dpr
  };
}

/**
 * Inject the marker, find it in a full-screen capture, remove it. Returns
 * null when the offset cannot be measured (capture failed, marker not
 * unique, or the capture's pixel size is not the screen size the click will
 * be delivered in). Never throws — a failed measurement must skip the
 * cross-check, not abort the click.
 */
export async function measureViewportOriginOnScreen(
  deps: ViewportOriginDeps,
  opts: { expectedScreenWidth?: number; expectedScreenHeight?: number } = {}
): Promise<ViewportOrigin | null> {
  let installed = false;
  try {
    // Set before the call so a thrown evaluate still attempts removal. The
    // remove expression is a no-op if the marker was never inserted.
    installed = true;
    const raw = await deps.evaluate(viewportOriginInstallExpression());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { dpr?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    const dpr = Number(parsed.dpr);
    const markerX = Number(parsed.x);
    const markerY = Number(parsed.y);
    const markerW = Number(parsed.width);
    const markerH = Number(parsed.height);
    if (![dpr, markerX, markerY, markerW, markerH].every((n) => Number.isFinite(n)) || dpr <= 0 || markerW <= 0 || markerH <= 0) {
      return null;
    }

    const expectedDeviceSize = Math.round(markerW * dpr);
    // The marker is inserted just before this. A capture can still miss it if
    // the compositor has not flushed to the X framebuffer yet, so retry the
    // capture a few times before concluding the offset is unmeasurable.
    let box: { x: number; y: number; width: number; height: number } | null = null;
    let sawCapture = false;
    for (let attempt = 1; attempt <= 3 && !box; attempt++) {
      const png = await deps.capturePng();
      if (!png) continue;
      sawCapture = true;
      const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      if (
        opts.expectedScreenWidth !== undefined &&
        opts.expectedScreenHeight !== undefined &&
        (info.width !== opts.expectedScreenWidth || info.height !== opts.expectedScreenHeight)
      ) {
        console.log(
          `[viewport-origin] screen capture is ${info.width}x${info.height}, not the ${opts.expectedScreenWidth}x${opts.expectedScreenHeight} space the click is delivered in; skipping offset measurement`
        );
        return null;
      }
      box = findUniqueSolidBox(data, info.width, info.height, info.channels, VIEWPORT_ORIGIN_MARKER.color, expectedDeviceSize);
      if (!box && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!sawCapture) return null;
    if (!box) {
      console.log(
        `[viewport-origin] marker rgb(${VIEWPORT_ORIGIN_MARKER.color.r}, ${VIEWPORT_ORIGIN_MARKER.color.g}, ${VIEWPORT_ORIGIN_MARKER.color.b}) not found uniquely at ~${expectedDeviceSize}px; skipping offset measurement`
      );
      return null;
    }
    const origin = viewportOriginFromMarkerBox(box, { x: markerX, y: markerY }, dpr, expectedDeviceSize);
    if (!origin) return null;
    return { x: origin.x, y: origin.y, devicePixelRatio: dpr };
  } catch (err) {
    console.log(`[viewport-origin] measurement failed, skipping screen-rect cross-check: ${(err as Error).message}`);
    return null;
  } finally {
    if (installed) {
      try {
        await deps.evaluate(viewportOriginRemoveExpression());
      } catch {
        // Best effort. The caller still paint-settles before the vision shot.
      }
    }
  }
}
