// Native JS dialog (`window.confirm`/`alert`/`prompt`) handling via CDP.
//
// `window.confirm()` (and `alert`/`prompt`) suspends page JS execution and
// shows a native browser-chrome dialog. Unlike the extension-install "Add
// extension?" dialog (see `xdotool.ts`'s header — that surface actively
// resists synthetic input and needs a real xdotool gesture), a JS dialog
// has no on-screen coordinates a click could target in the first place: it
// is modeled directly by CDP's Page domain
// (`Page.javascriptDialogOpening` / `Page.handleJavaScriptDialog`), which is
// the standard, deterministic way every CDP-based client (Puppeteer,
// Playwright, Chrome DevTools itself) automates alert/confirm/prompt. No
// xdotool/vision involved — this is plain CDP, same class of primitive as
// `core/cdp.ts`.
//
// Added for the vibebrowser relay-attach-token Settings-UI CUA test
// (VibeWebAgent#1534 / PR #1542) — its "Rotate attach token" action is
// gated behind `window.confirm()`, and no existing agentprobe primitive
// covered a JS dialog. Kept fully generic (no vibe-specific naming/values)
// so any future CUA test that needs to accept/dismiss/read a confirm or
// prompt dialog can reuse it directly.

import { cdpSend } from "./cdp";

export type JsDialogEvent = {
  /** "alert" | "confirm" | "prompt" | "beforeunload" (CDP's own `Page.DialogType` values). */
  type: string;
  message: string;
  url: string;
  /** Present only for `type === "prompt"` — the dialog's default input value. */
  defaultPrompt?: string;
};

export type WaitForJsDialogOptions = {
  timeoutMs?: number; // default 10_000
};

/**
 * Wait for the next `Page.javascriptDialogOpening` event on `sessionId` and
 * resolve with its details, without handling it. Split from `handleJsDialog`
 * so a caller can inspect the dialog's message/type before deciding to
 * accept/dismiss/fill it. Requires `Page.enable` to already be active on
 * this session (e.g. via `attachAndEnable` in `cdp.ts`).
 */
export function waitForJsDialogOpening(
  browserWs: WebSocket,
  sessionId: string,
  opts: WaitForJsDialogOptions = {}
): Promise<JsDialogEvent> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const handler = (ev: MessageEvent) => {
      let msg: any;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.method !== "Page.javascriptDialogOpening") return;
      // Browser-level connections receive events for every attached session;
      // only resolve for the session this caller asked about.
      if (msg.sessionId && msg.sessionId !== sessionId) return;
      browserWs.removeEventListener("message", handler);
      clearTimeout(timer);
      const p = msg.params ?? {};
      resolve({
        type: String(p.type ?? ""),
        message: String(p.message ?? ""),
        url: String(p.url ?? ""),
        ...(p.defaultPrompt !== undefined ? { defaultPrompt: String(p.defaultPrompt) } : {})
      });
    };
    const timer = setTimeout(() => {
      browserWs.removeEventListener("message", handler);
      reject(new Error(`Page.javascriptDialogOpening did not fire within ${timeoutMs}ms`));
    }, timeoutMs);
    browserWs.addEventListener("message", handler);
  });
}

/** Accept or dismiss the currently-open dialog via `Page.handleJavaScriptDialog`. */
export async function handleJsDialog(
  browserWs: WebSocket,
  sessionId: string,
  opts: { accept: boolean; promptText?: string } = { accept: true }
): Promise<void> {
  const params: Record<string, unknown> = { accept: opts.accept };
  if (opts.promptText !== undefined) params.promptText = opts.promptText;
  await cdpSend(browserWs, "Page.handleJavaScriptDialog", params, sessionId);
}

export type TriggerAndHandleJsDialogOptions = {
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
};

/**
 * Compose "subscribe, then trigger, then handle" as one call so there is no
 * race between opening the dialog and listening for it: the subscription is
 * armed BEFORE `trigger()` runs (e.g. a click that calls `window.confirm()`
 * synchronously), so the dialog can never open before anything is
 * listening. Returns the dialog's details for assertion (e.g. checking the
 * confirm message text) after accepting/dismissing it.
 */
export async function triggerAndHandleJsDialog(
  browserWs: WebSocket,
  sessionId: string,
  trigger: () => Promise<void> | void,
  opts: TriggerAndHandleJsDialogOptions = { accept: true }
): Promise<JsDialogEvent> {
  const dialogPromise = waitForJsDialogOpening(browserWs, sessionId, { timeoutMs: opts.timeoutMs });
  await trigger();
  const dialog = await dialogPromise;
  await handleJsDialog(browserWs, sessionId, { accept: opts.accept, promptText: opts.promptText });
  return dialog;
}
