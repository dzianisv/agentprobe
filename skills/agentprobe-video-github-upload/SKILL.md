---
name: agentprobe-video-github-upload
description: Produce, upload, and VALIDATE visual proof (video / GIF / screenshot) on a GitHub PR or issue for agentprobe test runs. Use whenever a task's deliverable is a recording/demo/screenshot that must be visible on GitHub, or before claiming any uploaded media is "done". Covers the only working upload path for private repos (browser clipboard-paste to user-attachments), the release-asset path for public repos, and a hard playability gate (core/validate-video.ts) so you never ship a 0:00 / blank / broken video. Triggers: "upload the video/gif to the PR/issue", "record a demo", "attach the recording", "show it works with a video", "the video is 0 seconds / won't play", "validate the recording", CUA/E2E visual evidence.
---

# agentprobe-video-github-upload

Two jobs: (1) get renderable media onto a GitHub PR/issue, (2) prove it actually plays/renders before
saying done. Skipping (2) is how "byte-exact, 200, `<video>` tag present" ships a video that shows 0:00.

## Rule of done (non-negotiable)

A media deliverable is done only when **you validated the real artifact yourself** — you played/opened it
and saw it do what you claim. NOT done at: asset URL returns 200 · byte-size matches · a `<video>`/`<img>`
tag exists in rendered HTML · CI green · a subagent said so. Validate the bytes viewers actually receive.

## Validate a video — run `core/validate-video.ts`

```
bun core/validate-video.ts <file-or-url> [min_seconds]
# local file:  bun core/validate-video.ts ./demo.mp4 5
# served asset: bun core/validate-video.ts https://github.com/user-attachments/assets/<uuid> 5
```

It downloads the served bytes (for a URL) and hard-fails unless ALL hold:
1. `duration >= min_seconds` — catches the 0:00 / empty file.
2. **`+faststart`: `moov` atom BEFORE `mdat`** — the #1 cause of "video shows 0:00" in browsers/GitHub. Applied to **mp4/mov only**; the validator detects the container (`ffprobe format_name`) and skips this check for webm/matroska.
3. clean full decode (`ffmpeg -f null`) — catches truncated/corrupt streams.
4. ≥2/3 sampled frames non-blank — catches all-black recordings.

Always run it on the URL after uploading, not just the local file — that proves what the viewer gets.

### Prefer WebM to dodge the faststart pitfall
WebM/Matroska is a streaming container natively — there is no `moov` atom, so the "shows 0:00" faststart
bug **cannot** occur. For shareable demos, transcode the mp4 offline (no realtime constraint):
`ffmpeg -i in.mp4 -c:v libvpx-vp9 -crf 34 -b:v 0 -row-mt 1 -pix_fmt yuv420p out.webm`, then validate it
(faststart is auto-skipped) and upload. GitHub renders `.webm` in PR/issue/release surfaces. (The realtime
`core/recording.ts` recorder stays mp4 — libx264 keeps up at 1080p/30fps where VP9 realtime may drop frames.)

### Building a video so it passes
- Encode with `-movflags +faststart` (moves `moov` to the front). `core/recording.ts`'s `startRecording`
  already passes this flag, but killing the recorder process (the normal shutdown path) can still leave
  `moov` after `mdat` — call `finalizeRecording({ outputDir })` (also in `core/recording.ts`) right after
  the recorder is killed/awaited to remux (`-c copy`, no re-encode) and guarantee faststart regardless of
  how the process exited. This is exactly the bug that motivated adding this check to agentprobe (issue #6):
  a CI-produced `recording.mp4` on `main` failed the faststart check and showed 0:00 in a browser.
- Remux any other existing file the same way: `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`.
- Never ship `concat -c copy` of image-loop segments — re-encode (`-c:v libx264 -pix_fmt yuv420p -r 25 -movflags +faststart`), then re-validate.
- If the local ffmpeg lacks `drawtext` (no libfreetype), render caption bars onto frames some other way, then loop the captioned PNGs.

### GIF / screenshot
Open it and confirm the CONTENT matches the claim (a rendering, non-broken image is still wrong if its
frames don't show the stated flow — the classic static-login-page passed off as a completed-login demo).
For a GIF, sample frames across it; for a stepwise flow, confirm every step appears.

## All-steps demo requirement

A "flow" recording must visibly contain every step. Instant CDP fills/clicks flash by in a sub-second and
never appear in the recording. In the test, add brief dwells (~1200ms) after each input and a per-step
screenshot (e.g. `step-01b-form-filled.png`, matching `core/screenshot.ts`'s `saveOptimizedScreenshot`) so
the continuous recording captures each step. Verify each step is present in the frames before publishing.

## Public repos (agentprobe itself): attach to a GitHub Release

For a **public** repo, an mp4 attached to a GitHub Release renders as a playable `<video>` on the release
page — `gh release create`/`gh release upload` works fine here, no browser needed:

```
gh release create demo-v1 --title "Demo" --notes "..." ./demo.mp4
# or, on an existing release:
gh release upload demo-v1 ./demo.mp4
```

Then validate the served asset URL with `bun core/validate-video.ts <release-asset-url>` before linking it
from a PR/issue/README. The browser clipboard-paste path below is only strictly required for **private**
repos, where release assets and `user-attachments` uploads both need a browser session.

## Upload to GitHub (private repos)

`gh`/PAT **cannot** create renderable `user-attachments/assets` URLs (upload endpoint needs a browser
`user_session` cookie; PAT → 422). `raw.githubusercontent` 404s on private repos and never renders. So:

1. **Upload via a browser** — Claude-for-Chrome (extension) MCP, connect to the EXISTING session (no
   "allow debugging" prompt). Drive drag/drop or clipboard-paste into the comment composer.
2. **Clipboard-paste is the reliable method** (GitHub's new composer has no usable file input). Put the file
   on the clipboard as a REAL file, not a text path — `osascript 'set the clipboard to POSIX file'` pastes
   as text and fails. Use AppleScriptObjC writing both `public.file-url` and legacy `NSFilenamesPboardType`:
   ```
   osascript -l JavaScript -e 'ObjC.import("AppKit");
     var p=$.NSPasteboard.generalPasteboard; p.clearContents;
     p.writeObjects($([$.NSURL.fileURLWithPath("<ABS_PATH>")]));'
   ```
   Focus the comment textarea, send Cmd+V, wait for the `Uploading…` placeholder to resolve to a real
   `user-attachments/assets/<uuid>` URL before pasting the next file, then submit.
3. **gh CAN embed an already-uploaded asset** — once the browser minted the `user-attachments/assets/<uuid>`
   URL (persists even if that comment is never submitted), `gh issue/pr comment` (or `gh api ... PATCH` to
   edit) with `![](url)` (image) or a bare URL (video → `<video>` player) renders for repo members. Use this
   to post/edit from the terminal, and to put the same asset on both the PR and the issue without re-uploading.
4. **Then validate the posted asset** — run `bun core/validate-video.ts <asset-url>`; for images, confirm the
   comment's `body_html` has the `<img>`/`<video>` and the asset returns `200` + right `content-type`. A
   visual test with no validated, rendered proof on the PR/issue is not done.

## Notes
- Automated browser tabs often report `readyState:0 / duration:null` for `<video>` (they don't decode) — that's
  an environment limit, NOT proof of a bad file. Validate via `bun core/validate-video.ts` on the served URL instead.
- Never commit screenshots/recordings into the repo — they live only as PR/issue attachments or Release assets.
