#!/bin/zsh
set -eu
cd "${0:A:h}"
mkdir -p build
xcrun swiftc -swift-version 5 -parse-as-library -import-objc-header Sources/CryptoBridge.h Sources/Core.swift Tests/Checks.swift -o build/checks
if [[ "${1:-}" == "--live" ]]; then
    build/checks --live
else
    CHECK_DIR=$(mktemp -d)
    trap 'rm -rf "$CHECK_DIR"' EXIT
    python3 Tests/make_fixture.py "$CHECK_DIR"
    build/checks "$CHECK_DIR"
fi
