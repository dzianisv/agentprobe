// Pin an extension to the toolbar by editing the profile's Preferences file
// directly — Chrome 142+ (CFT 149) routes the puzzle-piece icon click to
// chrome://extensions instead of a dropdown, so a pinned single-click icon
// target is required for reliable toolbar-icon coordinates.
//
// Extracted from vibebrowser's tests/cua/cws-visual-install.ts
// (`pinExtensionViaPreferences`) — already extension-ID-agnostic in the
// source. Must be called while Chrome is NOT running: Chrome holds its own
// in-memory copy of Preferences and can overwrite a live edit on exit, so
// callers always pin between a Chrome `kill()` and the next `startChrome`.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function pinExtensionViaPreferences(userDataDir: string, extensionId: string): Promise<boolean> {
  const prefsPath = path.join(userDataDir, "Default", "Preferences");
  try {
    const raw = await readFile(prefsPath, "utf8");
    const prefs = JSON.parse(raw) as Record<string, unknown>;
    const extensions = (prefs.extensions as Record<string, unknown>) ?? {};
    const pinned = new Set<string>(Array.isArray(extensions.pinned_extensions) ? (extensions.pinned_extensions as string[]) : []);
    pinned.add(extensionId);
    extensions.pinned_extensions = Array.from(pinned);
    prefs.extensions = extensions;
    await writeFile(prefsPath, JSON.stringify(prefs), "utf8");
    console.log(`[pin] pinned ${extensionId} via Preferences (${pinned.size} pinned total)`);
    return true;
  } catch (err) {
    console.log(`[pin] pinExtensionViaPreferences failed: ${(err as Error).message}`);
    return false;
  }
}
