#!/bin/zsh
set -eu
cd "${0:A:h:h}"
source "$PWD/scripts/sparkle.sh"
SIGNING_ACCOUNT=local.caoyun.nanobridge.sparkle
PUBLIC_KEY=$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' Info.plist)
if [[ "$PUBLIC_KEY" != "$("$SPARKLE_DIR/bin/generate_keys" --account "$SIGNING_ACCOUNT" -p)" ]]; then
    print -u2 '发布签名钥匙串与 Info.plist 公钥不匹配；请恢复原签名密钥。'
    exit 1
fi
zsh build.sh
RELEASE_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Info.plist)
RELEASE_DIR="$PWD/build/releases/macos-$RELEASE_VERSION"
RELEASE_ARCHIVE="NanoBridge-$RELEASE_VERSION-macOS-$(uname -m).zip"
mkdir -p "$RELEASE_DIR"
ditto -c -k --sequesterRsrc --keepParent build/NanoBridge.app "$RELEASE_DIR/$RELEASE_ARCHIVE"
"$SPARKLE_DIR/bin/generate_appcast" --account "$SIGNING_ACCOUNT" --maximum-deltas 0 \
    --download-url-prefix "https://github.com/zhengchangr/NanoBridge/releases/download/v$RELEASE_VERSION/" \
    "$RELEASE_DIR"
"$SPARKLE_DIR/bin/sign_update" --account "$SIGNING_ACCOUNT" --verify "$RELEASE_DIR/appcast.xml"
(cd "$RELEASE_DIR" && shasum -a 256 "$RELEASE_ARCHIVE" appcast.xml > SHA256SUMS.txt)
print -r -- "发布时请一并上传此目录中的 ZIP、appcast.xml 和 SHA256SUMS.txt：$RELEASE_DIR"
