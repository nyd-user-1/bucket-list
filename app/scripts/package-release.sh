#!/usr/bin/env bash
# package-release.sh — build "Bucket List.app" into a temp dir and zip it as
# dist/Bucket-List-macOS.zip for a GitHub release (the landing page's download
# button points at releases/latest/download/Bucket-List-macOS.zip).
set -euo pipefail
APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$APPDIR/dist"
STAGE="$(mktemp -d)"
BUCKET_LIST_APP_INSTALL="$STAGE" bash "$APPDIR/scripts/make-macos-app.sh"
mkdir -p "$OUT"
rm -f "$OUT/Bucket-List-macOS.zip"
ditto -c -k --sequesterRsrc --keepParent "$STAGE/Bucket List.app" "$OUT/Bucket-List-macOS.zip"
echo "-> $OUT/Bucket-List-macOS.zip"
