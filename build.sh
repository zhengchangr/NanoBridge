#!/bin/zsh
set -eu
cd "${0:A:h}"
source "$PWD/scripts/sparkle.sh"
APP="$PWD/build/NanoBridge.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
ditto "$SPARKLE_DIR/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
cp "$SPARKLE_DIR/LICENSE" "$APP/Contents/Resources/Sparkle-LICENSE.txt"
mkdir -p build/AppIcon.iconset
xcrun swift Sources/MakeIcon.swift build/AppIcon.iconset
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macos15.0" -O -parse-as-library \
  -import-objc-header Sources/CryptoBridge.h \
  -F "$SPARKLE_DIR" -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  Sources/Core.swift Sources/Updates.swift Sources/App.swift \
  -o "$APP/Contents/MacOS/NanoBridge"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "$APP"
