// CWS-optimized demo test case.
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
    "CWS_DEMO_EMAIL (or VIBE_TEST_EMAIL) and CWS_DEMO_PASSWORD (or VIBE_TEST_PASSWORD) are required for cws-demo test"
  );
}

const instruction = `You are testing the Vibe Browser Chrome extension for a Chrome Web Store promotional video.

The test runner has ALREADY:
- Opened the Vibe Co-Pilot sidepanel on the right side of the Chrome window
- Signed in to Vibe with a demo account
- Typed and submitted this exact prompt into the sidepanel chat input:
  "Go to news.ycombinator.com, find the top 3 stories, and give me a brief summary of each"

Your ONLY job is to WAIT and OBSERVE the sidepanel for the Co-Pilot's response.

Strict don'ts:
- Do NOT click anywhere in the sidepanel or the main page area
- Do NOT type anything anywhere — the prompt has already been submitted
- Do NOT navigate to any URL
- Do NOT touch tabs the Co-Pilot opens
- Do NOT interact with the address bar

Steps:
1. Take a screenshot to see the current state of the sidepanel
2. Wait up to 360 seconds (6 minutes) for the Co-Pilot to finish processing. The Co-Pilot is doing real browser work: opening a new tab, navigating to Hacker News, reading story titles and links, optionally visiting individual story pages, and composing a multi-item summary. This typically takes 90-300 seconds. The sidepanel will show "Thinking..." or step-by-step progress while the Co-Pilot works. Do not touch the tabs the Co-Pilot opens.
3. Periodically (every 20-30 seconds) take a screenshot to check whether the Co-Pilot has posted a response message in the sidepanel
4. When the sidepanel shows the Co-Pilot's response with summaries of at least 3 Hacker News stories (look for numbered/bulleted items, story titles, or phrases like "Hacker News", "HN", "top stories", "story 1/2/3", or specific tech story names) — report TEST_PASSED
5. If after 360 seconds (6 minutes) no such response appears in the sidepanel, report TEST_FAILED with a one-sentence reason describing what you actually see (e.g. "still Thinking after 6 minutes", "error message X", "only 1 story listed instead of 3")`;

export const cwsDemoTest = {
  name: "cws-demo",
  instruction,
  // The runner CDP-types this into the sidepanel chat input after auth completes.
  prompt:
    "Go to news.ycombinator.com, find the top 3 stories, and give me a brief summary of each",
  successCriteria: [
    "The Vibe Co-Pilot sidepanel shows an AI agent response (NOT just the user-prompt echo, NOT a loading state, NOT an error) containing summaries of at least 3 distinct Hacker News stories",
    "The response mentions 'Hacker News', 'HN', or references recognizable tech story titles or topics",
    "The response is structured with at least 3 numbered or bulleted items, or clearly delineated story sections",
    "No error messages or timeouts in the sidepanel",
  ],
  failureCriteria: [
    "Sidepanel is not visible on the right side of the Chrome window",
    "Sidepanel shows only the greeting 'How can I help you today?' with no agent response after 120 seconds",
    "Sidepanel shows a sign-in screen instead of a chat thread",
    "Co-Pilot response mentions fewer than 3 stories",
    "Co-Pilot response is unrelated to Hacker News or news stories",
    "Error message displayed in sidepanel",
  ],
  maxSteps: 60,
  verification: {
    prompt:
      "Look at this Chrome screenshot. Did the Vibe sidepanel (the vertical column on the right side of the window) show an AI-agent response that contains summaries of at least 3 distinct stories from Hacker News (news.ycombinator.com)? The response must include multiple numbered or bulleted items, or clearly separate story sections — and must reference 'Hacker News', 'HN', or identifiable tech story topics. Loading spinners, the greeting 'Hello / How can I help you today?', the user's echoed prompt, sign-in buttons, and error messages do NOT count. Answer YES or NO followed by one sentence of evidence.",
  },
};

export default cwsDemoTest;
