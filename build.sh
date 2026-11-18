#!/bin/zsh
set -eu
cd "${0:A:h}"
APP="$PWD/build/NanoBridge.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
mkdir -p build/AppIcon.iconset
xcrun swift Sources/MakeIcon.swift build/AppIcon.iconset
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macos15.0" -O -parse-as-library \
  -import-objc-header Sources/CryptoBridge.h \
  Sources/Core.swift Sources/App.swift \
  -o "$APP/Contents/MacOS/NanoBridge"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
echo "$APP"
