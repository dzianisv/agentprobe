// CWS viral promotional recording — extension installed, configured, and in action.
//
// Three-act structure:
//   Act 1 — Reveal: confirm extension in Chrome toolbar, sidepanel open and signed in.
//   Act 2 — Configuration tour: walk through AI & Models (30+ providers), AI Agent
//            Control (MCP relay remote-control feature), Google Workspace, Skills, and
//            MCP Servers — showcasing the full breadth of what can be configured.
//   Act 3 — Agent in action: submit a structured research task and watch the Co-Pilot
//            autonomously browse Hacker News, extract story data, and compose a
//            formatted report — all hands-free.
//
// No `prompt` field — the CUA types the prompt in Act 3 so the settings tour (Act 2)
// happens visibly BEFORE the task is submitted.
//
// Credentials fall back to VIBE_TEST_EMAIL / VIBE_TEST_PASSWORD for CI.
// For the actual promo video use CWS_DEMO_EMAIL / CWS_DEMO_PASSWORD (a polished
// paid account so the name in the sidepanel looks presentable).
const testEmail =
  process.env["CWS_DEMO_EMAIL"] || process.env["VIBE_TEST_EMAIL"];
const testPassword =
  process.env["CWS_DEMO_PASSWORD"] || process.env["VIBE_TEST_PASSWORD"];
if (!testEmail || !testPassword) {
  throw new Error(
    "CWS_DEMO_EMAIL (or VIBE_TEST_EMAIL) and CWS_DEMO_PASSWORD (or VIBE_TEST_PASSWORD) are required for cws-viral-showcase test"
  );
}

const instruction = `You are recording a Chrome Web Store promotional video for the Vibe Co-Pilot browser extension. Everything you do is captured on screen. Move with deliberate, camera-friendly pacing — pause briefly after each step so the viewer can absorb what they see.

The test runner has ALREADY:
- Opened Chrome (1920 × 1080) with the Vibe Co-Pilot extension installed and pinned to the toolbar
- Opened the Vibe Co-Pilot sidepanel on the right side of the window
- Signed in to Vibe with a demo account

════════════════════════════════════════════════════
PIXEL COORDINATE MAP — memorise before acting
════════════════════════════════════════════════════
Chrome window: 1920 × 1080 pixels.

DANGER ZONE — y < 90 is the Chrome browser toolbar (URL bar, back/forward buttons).
  NEVER click at y < 90. Clicking there focuses the URL bar and breaks typing.

Key pixel positions:
  Extension icon in toolbar (Vibe logo) →  (1768, 73)   ← y=73, CHROME TOOLBAR — do NOT click during steps, only observe
  Sidepanel ⚙ settings gear icon        →  (1893, 159)  ← click HERE for settings
  Sidepanel chat input field             →  (1552, 749)  ← click HERE to type a message
  Sidepanel mode toggle ("Auto"/"Ask")   →  (1552, 791)  ← click to switch Agent/Ask mode

IMPORTANT — Settings opens as a FULL Chrome tab (not a sidepanel overlay):
  Clicking the gear icon at (1893, 159) replaces the main browser area with the
  Settings page. The sidepanel stays visible on the right.
  After the settings tour, press Ctrl+T to open a NEW Chrome tab — this is the ONLY
  reliable way to leave the Settings page:
    • Ctrl+W — Chrome refuses to close its last open tab; Settings stays open.
    • Ctrl+L — chrome-extension:// pages intercept this shortcut before Chrome can
      focus the address bar; the URL bar never activates.
    • Ctrl+T — always works from any page; opens a new tab with the omnibox already
      focused and ready for typing. Use this and ONLY this.

  CRITICAL — Ctrl+T timing rule: After pressing Ctrl+T, you MUST wait (issue a wait
  action) BEFORE typing anything. The new tab needs time to open and capture keyboard
  focus. If you type immediately after Ctrl+T, the keystrokes go to the wrong place
  (the sidepanel or the Settings page) and the navigation silently fails.
  Always: Ctrl+T → wait → screenshot to verify tab opened → THEN type URL.

════════════════════════════════════════════════════
ACT 1 — REVEAL (≈ 30 seconds)
Show the extension installed and ready.
════════════════════════════════════════════════════

Step 1. Take a screenshot. Confirm the Chrome window shows:
  (a) The Vibe Co-Pilot sidepanel occupying the right portion of the window.
  (b) The sidepanel shows a chat interface — a text input at the bottom, mode toggle,
      and either a greeting or the signed-in user's name/avatar at the top.
  (c) The Vibe extension icon is visible in the Chrome toolbar at the top right.
  This screenshot is the "extension installed and ready" moment in the promo video.
  Do NOT proceed until you have confirmed the sidepanel is visible and signed in.

════════════════════════════════════════════════════
ACT 2 — CONFIGURATION TOUR (≈ 2–3 minutes)
Show what Vibe can be configured to do. One section at a time.
Take a screenshot AFTER every click. Verify the section is active before moving on.
════════════════════════════════════════════════════

Step 2. Click the ⚙ gear icon at pixel (1893, 159). Do NOT click y < 90.
  STOP — take a screenshot immediately.
  Verify the Settings page is now open: the main area shows a Settings title and a
  left-hand sidebar listing sections such as "AI & Models", "Appearance",
  "AI Agent Control", "Google Workspace", "Skills", "MCP Servers", "Credentials".
  Do NOT proceed to Step 3 until the Settings page is confirmed visible.

Step 3. In the Settings sidebar, click "AI & Models".
  STOP — take a screenshot immediately.
  Verify: the main area shows a provider/model picker with a large grid of AI
  providers. You should see logos or names including at least: OpenAI, Anthropic,
  Google Gemini, Groq, OpenRouter, Mistral, DeepSeek, GitHub Copilot, Ollama, and
  several others. This is the HEADLINE FEATURE — Vibe supports more AI providers
  than any other browser extension.
  Do NOT move to the next section until this screenshot is captured.

Step 4. In the Settings sidebar, click "AI Agent Control".
  STOP — take a screenshot immediately.
  Verify: the section shows the MCP Remote Relay feature — fields for a relay URL and
  an enable/disable toggle or connection status indicator. This feature lets you
  control the Vibe Co-Pilot remotely via MCP from any device or agent.
  This is the UNIQUE DIFFERENTIATOR — AI remote control of your browser.
  Do NOT move to the next section until this screenshot is captured.

Step 5. In the Settings sidebar, click "Google Workspace".
  STOP — take a screenshot immediately.
  Verify: the section shows OAuth connect buttons for Gmail, Google Calendar, and
  Google Drive — letting the AI read and act on your real workspace data.
  Do NOT move to the next section until this screenshot is captured.

Step 6. In the Settings sidebar, click "Skills".
  STOP — take a screenshot immediately.
  Verify: the section shows a list or editor for custom agent behaviors — reusable
  markdown instructions that shape how the Co-Pilot acts.
  Do NOT move to the next section until this screenshot is captured.

Step 7. In the Settings sidebar, click "MCP Servers".
  STOP — take a screenshot immediately.
  Verify: the section shows a list of external MCP (Model Context Protocol) server
  integrations — tools and services the Co-Pilot can call during its tasks.
  Do NOT move to the next section until this screenshot is captured.

════════════════════════════════════════════════════
ACT 3 — AGENT IN ACTION (≈ 4–6 minutes)
Submit a research task and watch the Co-Pilot work.
════════════════════════════════════════════════════

Step 8. Navigate away from Settings to Hacker News. Follow this EXACT sub-sequence —
  do NOT skip or reorder the sub-steps:

  8a. Press Ctrl+T (do NOT click anywhere first, do NOT type anything yet).
      Chrome opens a new empty tab. The new tab's address bar (omnibox) gets focus
      automatically. The Settings tab moves to the background.

  8b. Issue ONE "wait" action (30 seconds) to let the new tab fully open and the
      omnibox receive keyboard focus. Do NOT type during this wait.

  8c. Take a screenshot immediately after the wait.
      CRITICAL CHECK — look at the main browser area (left of the sidepanel):
        • If you see a NEW TAB PAGE (dark or light background, NOT the
          chrome-extension:// Settings page) → the tab opened correctly. Proceed to 8d.
        • If you STILL see the chrome-extension:// Settings page → Ctrl+T failed.
          Press Ctrl+T again, wait again (issue another wait action), take another
          screenshot, and repeat until the Settings page is gone.
      Do NOT proceed to 8d while the Settings page is still visible.

  8d. Type "news.ycombinator.com" — the characters go into the omnibox of the new tab.
      Do NOT press Escape, do NOT click anything before typing.

  8e. Press Enter to navigate.

  8f. Issue ONE "wait" action (30 seconds) for Hacker News to load.

  8g. Take a screenshot immediately after the wait.
      FINAL CHECK for this step:
        • (a) The main browser area shows news.ycombinator.com — orange header bar,
          list of story titles with point counts and comment links.
        • (b) The Vibe Co-Pilot sidepanel is still visible on the right side.
      If BOTH (a) and (b) are true → proceed to Step 9.
      If Hacker News is NOT visible (still Settings, blank page, or wrong URL) →
        press Ctrl+T, wait, screenshot, repeat 8d–8g until HN is confirmed loaded.
  Do NOT proceed to Step 9 until news.ycombinator.com is confirmed loaded.

Step 9. Check the mode selector near the chat input (approximately at y=791 in the
  sidepanel). The Co-Pilot must be in "Agent" mode (it may show "Agent", "Auto", or
  display "Can control browser").
  If "Ask" mode is active instead: click the mode toggle at (1552, 791) to switch to
  Agent mode. Take a screenshot to confirm the mode switch.
  If Agent mode is already active: take a screenshot confirming the mode and skip the
  toggle click.

Step 10. Press the Escape key once to release any URL bar focus. Then click the
  chat input field at pixel (1552, 749).
  Take a screenshot to confirm: the cursor is inside the sidepanel chat input (NOT in
  the Chrome address bar at the top). If the address bar is highlighted instead,
  press Escape and click (1552, 749) again.

Step 11. Type this exact prompt character by character — do NOT paste, type it:
  "Go to news.ycombinator.com. Look at the front page and give me the top 5 stories in this format for each:
[Number]. [Title]
Points: [current upvote count]
Why it matters: [one sentence on why a tech person should care]

End your response by naming the single most important story today and a one-sentence reason why."

Step 12. Press Enter to submit the prompt.

Step 13. Take a screenshot immediately. You should see the prompt echoed in the chat
  thread and the sidepanel beginning to show "Thinking..." or the first tool step as
  the Co-Pilot starts working.

Step 14. Wait for the Co-Pilot to finish.

  TIMING: In this test environment each "wait" action pauses exactly 30 seconds.
  To wait 30 seconds before the next check, issue ONE "wait" action, then take a
  screenshot. Do NOT issue multiple "wait" actions in a row.

  You MUST complete at least 15 wait-then-screenshot cycles (minimum 7.5-minute wait)
  before considering a timeout. Required cadence per cycle:
    1. Issue one "wait" action  (= 30 seconds)
    2. Issue one "screenshot" action
    3. Examine the sidepanel in that screenshot.

  After each screenshot, examine the sidepanel carefully:
  — Does the sidepanel show a numbered list (1. 2. 3. 4. 5.) with story titles,
    point counts, and "Why it matters" lines? → Go to Step 15.
  — Does the sidepanel still show "Thinking...", live tool steps
    (navigate_page, take_snapshot, read_content, etc.), or only the echoed prompt?
    → Continue the wait-then-screenshot cycle.
  Do NOT give up before your 15th check screenshot (= 15 cycles x 30 s = 7.5 min).
  Do NOT click in the main browser area (x < 1185) or in the sidepanel chat.
  Do NOT navigate to any URL.
  Do NOT touch any tab the Co-Pilot opens.
  The Co-Pilot typically takes 5–8 minutes to browse HN and compose the response.

Step 15. When the sidepanel shows the Co-Pilot's finished response, take a FINAL
  screenshot. Before reporting TEST_PASSED, verify ALL of these in the screenshot:
  (a) The response contains a numbered list of at least 3 Hacker News story entries.
  (b) Each entry has a title AND either a point count or a "Why it matters" sentence.
  (c) The response is NOT just the echoed prompt, NOT "Thinking...", NOT an error,
      and NOT the greeting "Hello / How can I help you today?".
  If ALL of (a)–(c) are true → report TEST_PASSED.

Step 16. If after 600 seconds (10 minutes) from Step 12 no qualifying response
  appears, take a screenshot first, then report TEST_FAILED with a one-sentence
  reason (e.g. "sidepanel shows only greeting after 10 minutes",
  "still Thinking after 10 minutes", "only 2 stories listed", "error: X").`;

export const cwsViralShowcaseTest = {
  name: "cws-viral-showcase",
  instruction,
  // No `prompt` field — CUA types it in Act 3 so the settings tour happens first.
  // Each CUA `wait` action pauses 30 seconds so 15 wait→screenshot cycles = 7.5 min.
  defaultWaitMs: 30_000,
  successCriteria: [
    "The Vibe Co-Pilot sidepanel shows an AI agent response containing a numbered list of at least 5 Hacker News stories",
    "Each story entry includes a title and either a point count or a 'Why it matters' sentence",
    "The response ends with a named 'most important story' pick and a reason",
    "Settings tour screenshots captured: AI & Models provider grid, AI Agent Control MCP relay, Google Workspace OAuth buttons",
    "No error messages, sign-in screens, or broken states appear during the recording",
  ],
  failureCriteria: [
    "Sidepanel is not visible on the right side of the Chrome window",
    "Settings gear icon cannot be found or clicked",
    "Settings AI & Models section does not show multiple AI provider options",
    "Co-Pilot response contains fewer than 3 distinct Hacker News story entries",
    "Co-Pilot response is not about Hacker News stories",
    "Error message displayed in sidepanel during demo",
    "Sidepanel shows sign-in screen instead of chat thread",
  ],
  maxSteps: 120,
  verification: {
    prompt:
      "Look at this Chrome screenshot. Did the Vibe Co-Pilot sidepanel (the vertical column on the right side of the window) show an AI-agent response that contains a numbered or bulleted list of at least 3 Hacker News (news.ycombinator.com) stories — each with a title and at least a point count or one-sentence description? Loading spinners, the greeting 'Hello / How can I help you today?', the user's echoed prompt, settings screens, sign-in buttons, and error messages do NOT count as a successful response. Answer YES or NO followed by one sentence of evidence.",
  },
};

export default cwsViralShowcaseTest;
