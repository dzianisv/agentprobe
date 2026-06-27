// Viral CWS demo test case — multi-site autonomous research with structured comparison output.
// Credentials fall back to VIBE_TEST_EMAIL / VIBE_TEST_PASSWORD so this still
// runs in CI without requiring new secrets.  For the actual promo video, set
// CWS_DEMO_EMAIL / CWS_DEMO_PASSWORD to a polished, upgraded account so the
// account name shown in the sidepanel looks presentable.
const testEmail =
  process.env["CWS_DEMO_EMAIL"] ?? process.env["VIBE_TEST_EMAIL"];
const testPassword =
  process.env["CWS_DEMO_PASSWORD"] ?? process.env["VIBE_TEST_PASSWORD"];
if (!testEmail || !testPassword) {
  throw new Error(
    "CWS_DEMO_EMAIL (or VIBE_TEST_EMAIL) and CWS_DEMO_PASSWORD (or VIBE_TEST_PASSWORD) are required for viral-demo test"
  );
}

const instruction = `You are testing the Vibe Browser Chrome extension for a viral Chrome Web Store promotional video.

The test runner has ALREADY:
- Opened the Vibe Co-Pilot sidepanel on the right side of the Chrome window
- Signed in to Vibe with a demo account
- Typed this exact prompt into the sidepanel chat input (but NOT yet submitted it):
  "Go to producthunt.com and find the #1 trending product right now. Then visit that product's official website to understand what it does. Finally, find one direct competitor by searching. For all 3 (the top PH product, its website info, and one competitor): give me the name, what problem it solves, pricing if visible, and your recommendation on which to use. Format as a clean comparison."

Your job:
1. Take a screenshot to see the current state of the sidepanel.
2. Check which mode is currently selected — look for a mode toggle or label near the chat input (typically "Agent" or "Ask"). If "Ask" mode is active (it may show text like "Ask" or lack the "Can control browser" indicator), click the mode selector to switch to "Agent" mode so the Co-Pilot can control the browser. If "Agent" mode is already active, skip this step.
3. Submit the prompt by pressing Enter in the chat input or clicking the send button.
4. Then ONLY observe — do NOT touch any tabs the Co-Pilot opens, do NOT click in the main page area, do NOT navigate to any URL, do NOT type anything further.
5. Wait up to 480 seconds (8 minutes) for the Co-Pilot to finish the full multi-site research. The Co-Pilot will: open producthunt.com, identify the #1 trending product, visit that product's official website, perform a competitor search, and compose a structured comparison. The sidepanel will show "Thinking..." or step-by-step progress while the Co-Pilot works across multiple tabs.
6. Periodically (every 25-30 seconds) take a screenshot to check whether the Co-Pilot has posted a final response in the sidepanel.
7. When the sidepanel shows a structured comparison with at least 3 distinct sections or items covering the Product Hunt product, its website details, and a competitor — including at least one pricing mention or free/paid indicator, and a recommendation or winner pick — report TEST_PASSED.
8. If after 480 seconds (8 minutes) no such response appears in the sidepanel, report TEST_FAILED with a one-sentence reason describing what you actually see (e.g. "still Thinking after 8 minutes", "error message X", "only 1 product listed instead of 3", "stuck on producthunt.com tab").

Strict don'ts after submitting the prompt:
- Do NOT click anywhere in the sidepanel chat area
- Do NOT type anything
- Do NOT navigate to any URL yourself
- Do NOT touch tabs the Co-Pilot opens
- Do NOT interact with the address bar`;

export const viralDemoTest = {
  name: "viral-demo",
  instruction,
  // The runner CDP-types this into the sidepanel chat input after auth completes.
  prompt:
    "Go to producthunt.com and find the #1 trending product right now. Then visit that product's official website to understand what it does. Finally, find one direct competitor by searching. For all 3 (the top PH product, its website info, and one competitor): give me the name, what problem it solves, pricing if visible, and your recommendation on which to use. Format as a clean comparison.",
  successCriteria: [
    "The Vibe Co-Pilot sidepanel shows an AI agent response (NOT just the user-prompt echo, NOT a loading state, NOT an error) containing a structured comparison with at least 3 distinct products or sections",
    "The response references 'Product Hunt', 'producthunt.com', or 'PH' indicating it actually visited the site",
    "The response includes at least one pricing mention, or uses words like 'free', 'paid', 'pricing', '$', or 'per month'",
    "The response contains a recommendation, winner, or conclusion picking one option over another",
    "No error messages or timeouts in the sidepanel",
  ],
  failureCriteria: [
    "Sidepanel is not visible on the right side of the Chrome window",
    "Sidepanel shows only the greeting 'How can I help you today?' with no agent response after 120 seconds",
    "Sidepanel shows a sign-in screen instead of a chat thread",
    "Co-Pilot response covers fewer than 3 distinct products or sections",
    "Co-Pilot response does not mention Product Hunt or producthunt.com",
    "Co-Pilot response contains no pricing information and no recommendation",
    "Error message displayed in sidepanel",
  ],
  maxSteps: 80,
  pollOptions: {
    initialWaitMs: 120_000,
    intervalMs: 60_000,
    timeoutMs: 1_080_000,
  },
  verification: {
    prompt:
      "Look at this Chrome screenshot. Did the Vibe sidepanel (the vertical column on the right side of the window) show an AI-agent response that: (1) contains a structured comparison with at least 3 distinct products or sections, (2) references 'Product Hunt' or 'producthunt.com', (3) includes at least one pricing mention or 'free'/'paid' indicator, and (4) includes a recommendation or winner? Loading spinners, the greeting 'Hello / How can I help you today?', the user's echoed prompt, sign-in buttons, and error messages do NOT count. Answer YES or NO followed by one sentence of evidence.",
  },
};

export default viralDemoTest;
