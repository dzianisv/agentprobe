#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <extension-zip-path>" >&2
  exit 1
fi

ZIP_PATH="$1"
if [[ ! -f "$ZIP_PATH" ]]; then
  echo "Extension zip not found: $ZIP_PATH" >&2
  exit 1
fi

BASE_DIR="$(pwd)/tests/cua/workdir"
ZIP_NAME="$(basename "$ZIP_PATH")"
PROFILE_NAME="${ZIP_NAME%.zip}"
OUT_DIR="$BASE_DIR/$PROFILE_NAME"
EXT_DIR="$OUT_DIR/extension"
CHROME_USER_DATA_DIR="$OUT_DIR/chrome-user-data"

rm -rf "$OUT_DIR"
mkdir -p "$EXT_DIR" "$CHROME_USER_DATA_DIR"
unzip -q "$ZIP_PATH" -d "$EXT_DIR"

echo "extension_zip=$ZIP_PATH"
echo "extension_dir=$EXT_DIR"
echo "chrome_user_data_dir=$CHROME_USER_DATA_DIR"
