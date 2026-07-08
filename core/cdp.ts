// Chrome DevTools Protocol primitives: opening a CDP websocket, sending
// commands over it, attaching to/enabling a target, and polling the target
// list / live DOM for readiness.
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts (#1501/#1504)
// and tests/cua/runner.ts. All previously-hardcoded values (CDP port,
// timeouts) are now parameters — logic is otherwise unchanged from the
// battle-tested source.

export type CdpTarget = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export type Rect = { x: number; y: number; width: number; height: number };

let cdpMsgId = 1;

/**
 * Send a single CDP command over an already-open websocket and await its
 * response. `sessionId` targets a specific attached session (flattened
 * protocol); omit for browser-level commands. `timeoutMs` bounds a single
 * call — a late reply for a timed-out call is tolerated (listener removed
 * either way), which matters for callers that catch-and-retry a per-call
 * timeout inside a poll loop (see `pollForElementReady`).
 */
export async function cdpSend(
  ws: WebSocket,
  method: string,
  params: unknown,
  sessionId?: string,
  timeoutMs = 30_000
): Promise<any> {
  const id = cdpMsgId++;
  return await new Promise<any>((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== id) return;
      ws.removeEventListener("message", handler);
      clearTimeout(t);
      if (msg.error) reject(new Error(`CDP ${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    const t = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error(`CDP ${method} timeout`));
    }, timeoutMs);
    ws.addEventListener("message", handler);
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
}

/** Open a CDP websocket connection, resolving once the socket is open. */
export async function openCdpWs(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("CDP ws timeout"));
    }, 5000);
    ws.addEventListener("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(t);
      reject(new Error(`CDP ws error: ${String((e as ErrorEvent).message ?? e)}`));
    });
  });
}

/** Fetch the browser-level `webSocketDebuggerUrl` from `/json/version`. */
export async function getBrowserWsUrl(cdpPort: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
  const data = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!data.webSocketDebuggerUrl) throw new Error("/json/version did not return a webSocketDebuggerUrl");
  return data.webSocketDebuggerUrl;
}

/** List all CDP targets (tabs, service workers, etc.) via the HTTP endpoint. */
export async function listCdpTargets(cdpPort: number): Promise<CdpTarget[]> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json`);
  return (await res.json()) as CdpTarget[];
}

/** Poll the CDP HTTP endpoint until it accepts connections, or throw. */
export async function waitForCdpReady(cdpPort: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await getBrowserWsUrl(cdpPort);
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`CDP endpoint on port ${cdpPort} never became reachable within ${timeoutMs}ms`);
}

/**
 * Attach to a target (flatten session), activate it, then enable
 * Runtime + Page on it.
 *
 * Activation matters: a tab Chrome still considers background/inactive gets
 * its layout/rAF throttled, so its renderer can keep reporting a stale
 * viewport even while the compositor already paints it full-size once
 * Chrome switches focus moments later (root-caused via vibebrowser PR #1504
 * run 28916045434). Explicitly activating the target here forces Chrome to
 * foreground the tab before any caller measures its DOM.
 */
export async function attachAndEnable(browserWs: WebSocket, targetId: string): Promise<string> {
  const attach = await cdpSend(browserWs, "Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attach.sessionId as string;
  if (!sessionId) throw new Error(`Target.attachToTarget did not return a sessionId for ${targetId}`);
  await cdpSend(browserWs, "Target.activateTarget", { targetId });
  await cdpSend(browserWs, "Runtime.enable", {}, sessionId);
  await cdpSend(browserWs, "Page.enable", {}, sessionId);
  return sessionId;
}

/** Poll the CDP target list for a page target whose URL matches `predicate`. */
export async function findTargetByUrl(
  cdpPort: number,
  predicate: (url: string) => boolean,
  timeoutMs: number,
  label: string
): Promise<CdpTarget> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const targets = await listCdpTargets(cdpPort);
      const match = targets.find((t) => t.type === "page" && predicate(t.url));
      if (match) return match;
    } catch {
      // CDP transient — retry
    }
    await Bun.sleep(400);
  }
  throw new Error(`${label} never appeared within ${timeoutMs}ms`);
}

/**
 * Single-shot, non-looping DOM measurement: run `findExpression` (must
 * resolve to a JSON string shaped like `{found, visible?, x, y, width,
 * height}`) via Runtime.evaluate once and return the viewport-space rect, or
 * null if not found/visible yet. No gesture, no sleep — callers own the
 * polling loop.
 */
export async function checkElementRect(
  browserWs: WebSocket,
  sessionId: string,
  findExpression: string
): Promise<{ rect: Rect | null; state: string }> {
  try {
    const result = await cdpSend(browserWs, "Runtime.evaluate", { expression: findExpression, returnByValue: true }, sessionId);
    const raw = result?.result?.value as string | undefined;
    if (raw) {
      const parsed = JSON.parse(raw) as { found: boolean; visible?: boolean } & Partial<Rect>;
      if (parsed.found && parsed.visible !== false && parsed.x !== undefined) {
        return { rect: { x: parsed.x!, y: parsed.y!, width: parsed.width!, height: parsed.height! }, state: raw };
      }
      return { rect: null, state: raw };
    }
    return { rect: null, state: "(no value returned)" };
  } catch (err) {
    return { rect: null, state: `(poll error, retrying: ${(err as Error).message})` };
  }
}

/** Poll `findExpression` (via `checkElementRect`) until it reports a found+visible rect, or throw. */
export async function pollForElementReady(
  browserWs: WebSocket,
  sessionId: string,
  findExpression: string,
  timeoutMs: number,
  label: string
): Promise<Rect> {
  const start = Date.now();
  let lastState = "";
  while (Date.now() - start < timeoutMs) {
    const { rect, state } = await checkElementRect(browserWs, sessionId, findExpression);
    lastState = state;
    if (rect) return rect;
    await Bun.sleep(400);
  }
  throw new Error(`${label} never became ready within ${timeoutMs}ms (last DOM state: ${lastState || "none"})`);
}
