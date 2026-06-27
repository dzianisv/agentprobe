// Credentials are auto-filled by the runner via CDP.
// The prompt is also CDP-typed into the sidepanel by the runner.
// The CUA model's only job is to OBSERVE the sidepanel for the Co-Pilot's response.
const testEmail = process.env["VIBE_TEST_EMAIL"];
const testPassword = process.env["VIBE_TEST_PASSWORD"];
if (!testEmail || !testPassword) {
  throw new Error("VIBE_TEST_EMAIL and VIBE_TEST_PASSWORD are required for install-auth-prompt test");
}

const instruction = `You are testing the Vibe Browser Chrome extension.

The test runner has ALREADY:
- Opened the Vibe Co-Pilot sidepanel on the right side of the Chrome window
- Signed in to Vibe with a test account
- Typed and submitted this exact prompt into the sidepanel chat input:
  "Find when the first GPT was released using duckduckgo.com"

Your ONLY job is to WAIT and OBSERVE the sidepanel for the Co-Pilot's response.

Strict don'ts:
- Do NOT click anywhere in the sidepanel or the main page area
- Do NOT type anything anywhere — the prompt has already been submitted
- Do NOT navigate to any URL
- Do NOT touch tabs the Co-Pilot opens
- Do NOT interact with the address bar

Steps:
1. Take a screenshot to see the current state of the sidepanel
2. Wait up to 360 seconds (6 minutes) for the Co-Pilot to finish processing. The Co-Pilot is doing real browser work: opening a new tab, navigating to DuckDuckGo, performing a search, scraping result pages, and composing an answer. This typically takes 90-300 seconds. The sidepanel will show "Thinking..." or step-by-step progress while the Co-Pilot works. Do not touch the tabs the Co-Pilot opens.
3. Periodically (every 20-30 seconds) take a screenshot to check whether the Co-Pilot has posted a response message in the sidepanel
4. When the sidepanel shows the Co-Pilot's response describing when the first GPT (GPT-1) was released — including "2018" or "GPT-1" or "June 2018" — report TEST_PASSED
5. If after 360 seconds (6 minutes) no such response appears in the sidepanel, report TEST_FAILED with a one-sentence reason describing what you actually see (e.g. "still Thinking after 6 minutes", "error message X", "stuck on result page Y")`;

export const installAuthPromptTest = {
  name: "install-auth-prompt",
  instruction,
  // The runner CDP-types this into the sidepanel chat input after auth completes.
  prompt: "Find when the first GPT was released using duckduckgo.com",
  successCriteria: [
    "The Vibe Co-Pilot sidepanel shows an AI agent response (NOT just the user-prompt echo, NOT a loading state, NOT an error) mentioning '2018' or 'GPT-1' or 'June 2018'",
    "No error messages or timeouts in the sidepanel",
  ],
  failureCriteria: [
    "Sidepanel is not visible on the right side of the Chrome window",
    "Sidepanel shows only the greeting 'How can I help you today?' with no agent response after 120 seconds",
    "Sidepanel shows a sign-in screen instead of a chat thread",
    "Co-Pilot response is unrelated to GPT release date",
    "Error message displayed in sidepanel",
  ],
  maxSteps: 60,
  verification: {
    prompt:
      "Look at this Chrome screenshot. Did the Vibe sidepanel (the vertical column on the right side of the window) show an AI-agent response containing '2018' or 'GPT-1' as actual content text the Co-Pilot wrote? Loading spinners, the greeting 'Hello / How can I help you today?', the user's echoed prompt, sign-in buttons, and error messages do NOT count. Answer YES or NO followed by one sentence of evidence.",
  },
};

export default installAuthPromptTest;
