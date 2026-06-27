export const googleOAuthTest = {
  name: "google-oauth-flow",
  instruction: `You are testing a Chrome browser extension called "Vibe Browser".
The extension's side panel should already be open.

Your task:
1. Look for a "Connect Google" or "Google Workspace" button/link in the extension UI
2. Click it to initiate the Google OAuth flow
3. Verify that a Google sign-in page appears (should show accounts.google.com or Google branding)
4. Report SUCCESS if you see the Google OAuth consent/sign-in screen
5. Report FAILURE if you get an error like "bad client id", "invalid_client", or the OAuth flow doesn't start

Do NOT actually sign in - just verify the OAuth screen appears.`,
  successCriteria: "Google OAuth consent screen is visible",
  failureCriteria: "Error message about client ID or OAuth flow fails to initiate",
  maxSteps: 20,
};

export default googleOAuthTest;
