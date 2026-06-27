// Full-feature showcase test case for the Chrome Web Store promotional video.
//
// Two-act structure:
//   Act 1 — Settings tour (CUA clicks through providers, AI Agent Control,
//            Google Workspace, Skills) to show the breadth of configuration options.
//   Act 2 — Agent in action (CUA types a short research task, switches to Agent
//            mode, submits, and watches the Co-Pilot autonomously work).
//
// No `prompt` field — the CUA handles typing so that the settings tour can happen
// BEFORE the task is submitted.  This lets the recording show configuration first,
// then autonomous execution.
//
// Credentials fall back to VIBE_TEST_EMAIL / VIBE_TEST_PASSWORD for CI.
// For the actual promo video use CWS_DEMO_EMAIL / CWS_DEMO_PASSWORD (polished
// upgraded account so the name shown in the sidepanel looks presentable).
const testEmail =
  process.env["CWS_DEMO_EMAIL"] ?? process.env["VIBE_TEST_EMAIL"];
const testPassword =
  process.env["CWS_DEMO_PASSWORD"] ?? process.env["VIBE_TEST_PASSWORD"];
if (!testEmail || !testPassword) {
  throw new Error(
    "CWS_DEMO_EMAIL (or VIBE_TEST_EMAIL) and CWS_DEMO_PASSWORD (or VIBE_TEST_PASSWORD) are required for full-showcase test"
  );
}

const instruction = `You are creating a Chrome Web Store promotional video for the Vibe Co-Pilot browser extension. The recording captures everything you do on screen.

The test runner has ALREADY:
- Opened Chrome with the Vibe Co-Pilot extension installed
- Opened the Vibe Co-Pilot sidepanel on the right side of the Chrome window
- Signed in to Vibe with a demo account

You will run in TWO ACTS. Take your time — this is a demo video, not a speed test.

════════════════════════════════════════════════════
PIXEL COORDINATE MAP — memorise these before acting
════════════════════════════════════════════════════
The Chrome window is 1920 × 1080 pixels.

DANGER ZONE — y < 90 is the Chrome browser toolbar (URL bar, back/forward buttons).
  NEVER click at y < 90. Clicking there focuses the URL bar and breaks typing.

Sidepanel starts at x ≈ 1185 (right side). Key pixel locations:
  Sidepanel ⚙ settings gear icon  →  (1893, 159)   ← click HERE for settings
  Sidepanel ☰ sidebar toggle      →  (1220, 159)
  Sidepanel chat input field       →  (1552, 749)   ← click HERE to type a message
  Sidepanel mode toggle ("Auto")   →  (1552, 791)   ← click to switch Agent/Ask mode

IMPORTANT: Clicking the gear icon (1893, 159) opens Settings as a FULL Chrome tab —
not a sidepanel overlay. The entire browser view changes to the Settings page. To
navigate away after the settings tour, press Ctrl+T to open a NEW Chrome tab. A new
tab opens with the address bar already focused (ready for input). Type
"news.ycombinator.com" and press Enter to navigate to Hacker News. Do NOT use
Ctrl+W — the Settings tab may be the only open tab, and Chrome will not close its
last tab. Do NOT use Ctrl+L — Chrome extension pages intercept this shortcut and
prevent it from focusing the Chrome address bar.

════════════════════════════════════════════════════
ACT 1 — SETTINGS TOUR (~2–3 minutes)
Show what can be configured before running any task.
ONE STEP AT A TIME — take a screenshot after EVERY click before proceeding.
════════════════════════════════════════════════════

Step 1. Take a screenshot to confirm the sidepanel is open and you are signed in.

Step 2. Click the ⚙ settings gear icon at pixel (1893, 159). Do NOT click anywhere with y < 90 (that is the Chrome toolbar). STOP. Take a screenshot immediately. Verify the Settings page is now open — it occupies the full browser tab and has a left-hand sidebar with section names such as "AI & Models", "Appearance", "Debugging", "MCP Servers", "Google Workspace", "AI Agent Control", "Skills", "Credentials". Do NOT proceed to the next step until you have confirmed the Settings page is visible.

Step 3. In the Settings left-hand sidebar, click "AI & Models". STOP. Take a screenshot immediately. Verify this section is now active — it shows the model/provider picker with many provider options including OpenAI, Anthropic, Google Gemini, Groq, OpenRouter, Mistral, DeepSeek, GitHub Copilot, Ollama, and more. Do NOT click the next section until you have taken this screenshot.

Step 4. In the Settings left-hand sidebar, click "AI Agent Control". STOP. Take a screenshot immediately. Verify this section is now active — it shows the MCP remote relay feature with a relay URL or enable/disable toggle and configuration fields. Do NOT proceed until you have taken this screenshot.

Step 5. In the Settings left-hand sidebar, click "Google Workspace". STOP. Take a screenshot immediately. Verify this section is now active — it shows OAuth buttons for connecting Gmail, Google Calendar, and Google Drive. Do NOT proceed until you have taken this screenshot.

Step 6. In the Settings left-hand sidebar, click "Skills". STOP. Take a screenshot immediately. Verify this section is now active — it shows custom agent behaviors with reusable markdown-based instructions. Do NOT proceed until you have taken this screenshot.

Step 7. In the Settings left-hand sidebar, click "MCP Servers". STOP. Take a screenshot immediately. Verify this section is now active — it shows the list of external MCP (Model Context Protocol) servers. Do NOT proceed until you have taken this screenshot.

Step 8. Open a new browser tab by pressing Ctrl+T (do NOT click anywhere). A new empty Chrome tab opens with the address bar already focused and ready for input — no click needed. Immediately type "news.ycombinator.com" and press Enter. Chrome navigates the new tab to Hacker News. STOP. Take a screenshot immediately to confirm: (a) the main browser area shows the Hacker News website (news.ycombinator.com), (b) the Vibe sidepanel is still visible on the right side of the window. If the screenshot does NOT show Hacker News, press Ctrl+T again, retype "news.ycombinator.com", and press Enter. Do NOT proceed to Act 2 until Hacker News is loaded in the main area.

════════════════════════════════════════════════════
ACT 2 — AGENT IN ACTION (~4–6 minutes)
Submit a task and watch the Co-Pilot work autonomously.
════════════════════════════════════════════════════

Step 9. Check the mode selector near the chat input. The mode toggle is at approximately (1552, 791). If "Ask" mode is active (no "Can control browser" indicator), click the mode toggle to switch to "Agent" mode. If "Agent" mode is already active, skip this step. Take a screenshot to confirm the current mode.

Step 10. IMPORTANT — before clicking the chat input, press the Escape key once to ensure the URL bar does not have focus. Then click the chat input field at pixel (1552, 749). Take a screenshot to confirm the cursor is inside the sidepanel chat input (NOT in the Chrome URL bar at the top of the window).

Step 11. Type this exact prompt character by character (do not paste, type it):
"Open news.ycombinator.com and list the top 5 stories - give me the title, current points, and a one-sentence summary for each."

Step 12. Press Enter to submit the prompt.

Step 13. Take a screenshot. You should see the prompt echoed in the chat thread and the sidepanel showing "Thinking..." or the first tool step as the Co-Pilot begins working. The Co-Pilot will open a new tab, navigate to Hacker News, read the story list, and compose the response.

Step 14. Wait for the Co-Pilot to finish. You MUST take at least 10 screenshots spaced 30 seconds apart (minimum 5-minute wait) before considering a timeout. After each screenshot, look at the sidepanel: does it show a numbered or bulleted list of actual Hacker News story titles? If YES → go to Step 15. If the sidepanel still shows "Thinking...", live tool steps (navigate_page, take_snapshot, etc.), or is blank → wait 30 seconds and take the next screenshot. Do NOT give up before your 10th check screenshot. The Co-Pilot typically takes 3–5 minutes to browse HN and compose the full response. Do NOT click in the main browser area or the sidepanel chat.

Step 15. When the sidepanel shows the Co-Pilot's finished response, take a final screenshot. BEFORE reporting TEST_PASSED, verify in the screenshot that the sidepanel contains a numbered or bulleted list of at least 3 Hacker News stories, each with a story title and at least a point count or summary. The greeting "Hello / How can I help you today?" is NOT a finished response. "Thinking..." spinner is NOT a finished response. Only a list of actual story entries counts. If you see that list, report TEST_PASSED.

Step 16. If after 480 seconds (8 minutes) from Step 12 no finished response appears, take a screenshot first, then report TEST_FAILED with a one-sentence reason (e.g. "sidepanel still shows greeting after 8 minutes", "still Thinking after 8 minutes", "only 2 stories listed", "error: X").

STRICT RULES after Step 12 (prompt submitted):
- Do NOT click in the main Chrome window content area (x < 1185)
- Do NOT type anything further into the chat
- Do NOT navigate to any URL yourself
- Do NOT touch tabs the Co-Pilot opens
- Do NOT interact with the Chrome address bar (y < 90)`;

export const fullShowcaseTest = {
  name: "full-showcase",
  instruction,
  // No `prompt` field — the CUA types it in Act 2 (after the settings tour in Act 1).
  // The runner will jump straight to the CUA loop from step 1.
  successCriteria: [
    "The Vibe Co-Pilot sidepanel shows an AI agent response containing a numbered list of at least 5 Hacker News stories with titles and summaries",
    "The response mentions 'Hacker News', 'HN', 'news.ycombinator.com', or clearly references identifiable tech story topics",
    "The settings tour screenshots capture the AI & Models provider list, AI Agent Control MCP relay section, and Google Workspace section",
    "No error messages or sign-in screens appear during the demo",
  ],
  failureCriteria: [
    "Sidepanel is not visible on the right side of the Chrome window",
    "Settings gear icon cannot be found or clicked",
    "Settings page does not show multiple provider options in the AI & Models section",
    "Co-Pilot response contains fewer than 3 distinct Hacker News stories",
    "Co-Pilot response is not related to Hacker News or tech stories",
    "Error message displayed in the sidepanel",
    "Sidepanel shows a sign-in screen instead of the chat thread",
  ],
  maxSteps: 120,
  verification: {
    prompt:
      "Look at this Chrome screenshot. Did the Vibe sidepanel (the vertical column on the right side of the window) show an AI-agent response that contains a numbered or bulleted list of at least 3 Hacker News (news.ycombinator.com) stories, each with a title and a brief summary? Loading spinners, the greeting 'Hello / How can I help you today?', the user's echoed prompt, settings screens, sign-in buttons, and error messages do NOT count as a successful response. Answer YES or NO followed by one sentence of evidence.",
  },
};

export default fullShowcaseTest;
