#!/usr/bin/env bash
#
# build_demo_video.sh — assemble the ~2-minute hackathon submission video for
# agentprobe from EXISTING demo GIFs, with title/section cards that highlight
# the H Company Holo computer-use integration.
#
# No new footage is recorded; this only stitches assets already in the repo.
# Output is written to dist/agentprobe-demo.mp4 (dist/ + *.mp4 are gitignored —
# the video is a build artifact, not committed).
#
# Every segment is normalized to a common format (RES/FPS/pixfmt) so the
# concat demuxer can join them and the mp4 plays everywhere; +faststart is
# applied so players don't show 0:00.
#
# Title cards are rendered as PNGs via Python/Pillow (this ffmpeg build has no
# drawtext/libfreetype), then encoded to video — see render_card_png().
#
# Overridable via env:
#   OUT   (default dist/agentprobe-demo.mp4)
#   FONT  (default /System/Library/Fonts/Supplemental/Arial Bold.ttf)
#   RES   (default 1280x720)   FPS (default 30)
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${OUT:-dist/agentprobe-demo.mp4}"
FONT="${FONT:-/System/Library/Fonts/Supplemental/Arial Bold.ttf}"
FONT_SUB="${FONT_SUB:-/System/Library/Fonts/Supplemental/Arial.ttf}"
RES="${RES:-1280x720}"
FPS="${FPS:-30}"
W="${RES%x*}"; H="${RES#*x}"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found on PATH" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 not found on PATH" >&2; exit 1; }
python3 -c "import PIL" 2>/dev/null || { echo "Pillow (PIL) required: pip install pillow" >&2; exit 1; }
[ -f "$FONT" ] || { echo "font not found: $FONT (set FONT=...)" >&2; exit 1; }

# Source clips (relative to repo root). Each: gif path.
GIF_ANDROID="assets/android-calculator-math.gif"
GIF_BROWSER="assets/extension-vibe-cws.gif"
GIF_E2E="docs/showcase/vibe-cua-e2e.gif"
GIF_DUAL="docs/showcase/chrome-sync-login-dual-surface.gif"
for f in "$GIF_ANDROID" "$GIF_BROWSER" "$GIF_E2E" "$GIF_DUAL"; do
  [ -f "$f" ] || { echo "missing asset: $f" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$(dirname "$OUT")"

# Common encode params for every intermediate segment — MUST be identical so
# the concat demuxer can join them without re-muxing surprises.
COMMON=(-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r "$FPS" -an)

# Normalize filter: scale to fit inside RES preserving aspect, pad to RES.
SCALE_PAD="scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${FPS}"

# render_card_png <out.png> <line1> <line2> <line3> — draw a centered card.
render_card_png() {
  OUT_PNG="$1" L1="${2:-}" L2="${3:-}" L3="${4:-}" \
  CARD_W="$W" CARD_H="$H" CARD_FONT="$FONT" CARD_FONT_SUB="$FONT_SUB" \
  python3 - <<'PY'
import os
from PIL import Image, ImageDraw, ImageFont
W=int(os.environ["CARD_W"]); H=int(os.environ["CARD_H"])
out=os.environ["OUT_PNG"]
l1=os.environ.get("L1",""); l2=os.environ.get("L2",""); l3=os.environ.get("L3","")
fbold=os.environ["CARD_FONT"]; freg=os.environ["CARD_FONT_SUB"]
img=Image.new("RGB",(W,H),(11,15,20))
d=ImageDraw.Draw(img)
def font(path,size):
    try: return ImageFont.truetype(path,size)
    except Exception: return ImageFont.load_default()
def centered(text,fnt,y,fill):
    if not text: return
    bb=d.textbbox((0,0),text,font=fnt)
    w=bb[2]-bb[0]
    d.text(((W-w)//2, y), text, font=fnt, fill=fill)
centered(l1, font(fbold, 60), H//2-130, (255,255,255))
centered(l2, font(freg, 36),  H//2-30,  (138,208,255))
centered(l3, font(freg, 26),  H//2+45,  (160,168,176))
img.save(out)
PY
}

# make_card <index> <seconds> <line1> <line2> <line3>
make_card() {
  local idx="$1" secs="$2" l1="${3:-}" l2="${4:-}" l3="${5:-}"
  local png="$WORK/card_${idx}.png" out="$WORK/seg_${idx}.mp4"
  render_card_png "$png" "$l1" "$l2" "$l3"
  ffmpeg -y -loglevel error -loop 1 -t "$secs" -i "$png" \
    -vf "format=yuv420p,fps=${FPS}" "${COMMON[@]}" "$out"
  echo "$out"
}

# make_clip <index> <gif> [speed_factor]
make_clip() {
  local idx="$1" gif="$2" speed="${3:-1}"
  local out="$WORK/seg_${idx}.mp4"
  local vf="$SCALE_PAD"
  if [ "$speed" != "1" ]; then
    vf="setpts=PTS/${speed},${vf}"
  fi
  ffmpeg -y -loglevel error -i "$gif" -vf "$vf" "${COMMON[@]}" "$out"
  echo "$out"
}

echo "Building segments..."
SEGS=()
SEGS+=("$(make_card 00 4 "agentprobe" "Computer-use testing on H Company Holo" "Real Android + Chrome, driven by Holo grounding")")
SEGS+=("$(make_card 01 2 "Android" "agent solves a real task" "computes 27 + 18 = 45 on a live emulator")")
SEGS+=("$(make_clip 02 "$GIF_ANDROID")")
SEGS+=("$(make_card 03 2 "Browser" "agent verifies a live web app" "confirms extension published on Chrome Web Store")")
SEGS+=("$(make_clip 04 "$GIF_BROWSER")")
SEGS+=("$(make_card 05 2 "End-to-end" "install, sign in, then an agentic task" "every step asserted + screen-recorded")")
SEGS+=("$(make_clip 06 "$GIF_E2E")")
SEGS+=("$(make_card 07 2 "Dual-surface" "terminal + browser, one recording" "CLI on the left drives Chrome auth on the right")")
SEGS+=("$(make_clip 08 "$GIF_DUAL")")
SEGS+=("$(make_card 09 4 "Powered by H Company Holo" "grounder holo3-1-35b-a3b via api.hcompany.ai" "github.com/dzianisv/agentprobe")")

# concat demuxer list
LIST="$WORK/list.txt"
: > "$LIST"
for s in "${SEGS[@]}"; do printf "file '%s'\n" "$s" >> "$LIST"; done

echo "Concatenating -> $OUT"
ffmpeg -y -loglevel error -f concat -safe 0 -i "$LIST" -c copy -movflags +faststart "$OUT"

# Verify
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT")"
WHV="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,avg_frame_rate -of csv=p=0 "$OUT")"
ffmpeg -v error -i "$OUT" -f null - >/dev/null 2>&1 || { echo "ERROR: output failed decode" >&2; exit 1; }
echo "---------------------------------------------"
echo "OK: $OUT"
echo "duration=${DUR}s  (video ${WHV})"
awk -v d="$DUR" 'BEGIN{ if (d+0 > 120) { print "WARNING: duration exceeds 120s"; } }'
echo "segments (in order):"
printf '  %s\n' "title(4s)" "card:Android(2s)" "android(4.84s)" "card:Browser(2s)" "browser(10.56s)" \
  "card:E2E(2s)" "e2e(7.25s)" "card:Dual(2s)" "dual-surface(22.33s)" "closing(4s)"
