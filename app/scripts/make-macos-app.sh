#!/usr/bin/env bash
# make-macos-app.sh — assemble "Bucket List.app" as a native window (NSWindow +
# WKWebView), the same shape as HQ.app. No Electron, no npm deps, no build
# step for the server: the bundle carries server.js, the UI, and a copy of the
# shared engine (../lib), and runs them with the system's node.
#
# Re-run after editing anything under app/ or lib/ to refresh the app.
# Ad-hoc signed, not notarized: downloaded copies need "Open Anyway" once.
set -euo pipefail

APPDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$APPDIR/.." && pwd)"
SWIFT="$APPDIR/shell/bucket-list-shell.swift"
APP_NAME="Bucket List"
VERSION="$(node -p "require('$APPDIR/package.json').version" 2>/dev/null || echo 0.0.0)"
INSTALL_DIR="${BUCKET_LIST_APP_INSTALL:-$HOME/Applications}"
APP="$INSTALL_DIR/$APP_NAME.app"

command -v swiftc >/dev/null 2>&1 || { echo "swiftc not found (install Xcode Command Line Tools: xcode-select --install)"; exit 1; }

echo "Building $APP ..."
mkdir -p "$INSTALL_DIR"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/engine"

# the server + UI + the shared engine, self-contained inside the bundle
ENGINE="$APP/Contents/Resources/engine"
cp "$APPDIR/server.js" "$APPDIR/package.json" "$ENGINE/"
cp -R "$APPDIR/ui" "$ENGINE/ui"
cp -R "$REPO/lib" "$ENGINE/lib"

# icon: generated with python3 + Pillow when available, else the generic icon
if python3 -c "import PIL" >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/BucketList.iconset"; mkdir -p "$ICONSET"
  python3 - "$ICONSET" <<'PY'
import sys, os
from PIL import Image, ImageDraw
iconset = sys.argv[1]; S = 1024
canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
margin = 100; body = S - 2 * margin; radius = int(body * 0.2237)
grad = Image.new("RGB", (body, body)); gd = ImageDraw.Draw(grad)
top, bot = (58, 140, 232), (24, 82, 168)
for y in range(body):
    t = y / (body - 1)
    gd.line([(0, y), (body, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)))
mask = Image.new("L", (body, body), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, body - 1, body - 1), radius=radius, fill=255)
canvas.paste(grad, (margin, margin), mask)
d = ImageDraw.Draw(canvas)
# a bucket: tapered body + rim, white
cx = S / 2; topY, botY = 360, 720; tw, bw = 400, 300
d.polygon([(cx - tw / 2, topY), (cx + tw / 2, topY), (cx + bw / 2, botY), (cx - bw / 2, botY)], fill=(255, 255, 255, 255))
d.rounded_rectangle((cx - tw / 2 - 26, topY - 40, cx + tw / 2 + 26, topY + 8), radius=22, fill=(255, 255, 255, 255))
# three list lines across the bucket
for i, y in enumerate((450, 530, 610)):
    inset = 70 + i * 16
    d.rounded_rectangle((cx - tw / 2 + inset, y, cx + tw / 2 - inset, y + 26), radius=13, fill=(36, 100, 196, 255))
for s in (16, 32, 128, 256, 512):
    for sc in (1, 2):
        px = s * sc; nm = f"icon_{s}x{s}{'@2x' if sc == 2 else ''}.png"
        canvas.resize((px, px), Image.LANCZOS).save(os.path.join(iconset, nm))
PY
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/bucket-list.icns"
else
  echo "note: python3/Pillow not found — building without the custom icon"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Bucket List</string>
  <key>CFBundleDisplayName</key><string>Bucket List</string>
  <key>CFBundleIdentifier</key><string>com.nysgpt.bucket-list</string>
  <key>CFBundleExecutable</key><string>bucket-list</string>
  <key>CFBundleIconFile</key><string>bucket-list</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>__VERSION__</string>
  <key>CFBundleShortVersionString</key><string>__VERSION__</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST
sed -i '' "s/__VERSION__/$VERSION/g" "$APP/Contents/Info.plist"

# universal binary (Apple silicon + Intel) so the release zip runs on either
BIN="$(mktemp -d)"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12.0" "$SWIFT" -o "$BIN/$arch" -framework AppKit -framework WebKit 2>&1 | grep -v -E "warning:|Selector|^ *[0-9]* \||^ *\||^\s*$" || true
done
lipo -create "$BIN/arm64" "$BIN/x86_64" -output "$APP/Contents/MacOS/bucket-list"
chmod +x "$APP/Contents/MacOS/bucket-list"

# Ad-hoc signature over the whole bundle. Not a Developer ID: a downloaded copy
# still needs "Open Anyway" in System Settings once, but it opens instead of
# reporting itself as damaged.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 && echo "ad-hoc signed" || echo "WARN: codesign failed"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" || true
touch "$APP"

echo "Done -> $APP"
echo "Launch from Spotlight (⌘Space, 'Bucket List') or: open \"$APP\""
