#!/bin/zsh
# Shared by the build and release scripts; cache verified upstream binaries.
SPARKLE_VERSION=2.10.1
SPARKLE_SHA256=1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27
SPARKLE_DIR="$PWD/build/Sparkle-$SPARKLE_VERSION"
SPARKLE_ARCHIVE="$PWD/build/Sparkle-$SPARKLE_VERSION.tar.xz"

if [[ ! -f "$SPARKLE_ARCHIVE" ]]; then
    mkdir -p "$PWD/build"
    curl --fail --location --retry 2 --connect-timeout 20 --max-time 600 \
        "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz" \
        -o "$SPARKLE_ARCHIVE.download"
    print -r -- "$SPARKLE_SHA256  $SPARKLE_ARCHIVE.download" | shasum -a 256 -c -
    mv "$SPARKLE_ARCHIVE.download" "$SPARKLE_ARCHIVE"
fi
print -r -- "$SPARKLE_SHA256  $SPARKLE_ARCHIVE" | shasum -a 256 -c -
if [[ ! -d "$SPARKLE_DIR/Sparkle.framework" ]]; then
    mkdir -p "$SPARKLE_DIR"
    tar -xJf "$SPARKLE_ARCHIVE" -C "$SPARKLE_DIR"
fi
