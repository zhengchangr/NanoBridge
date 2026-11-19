#!/bin/zsh
set -eu
cd "${0:A:h:h}"
source "$PWD/scripts/sparkle.sh"
SIGNING_ACCOUNT=local.caoyun.nanobridge.sparkle
RELEASE_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' Info.plist)
RELEASE_DIR="$PWD/build/releases/macos-$RELEASE_VERSION"
RELEASE_ARCHIVE="$RELEASE_DIR/NanoBridge-$RELEASE_VERSION-macOS-$(uname -m).zip"
"$SPARKLE_DIR/bin/sign_update" --account "$SIGNING_ACCOUNT" --verify "$RELEASE_DIR/appcast.xml"
ARCHIVE_SIGNATURE=$(python3 - "$RELEASE_DIR/appcast.xml" <<'PY'
import sys, xml.etree.ElementTree as ET
enclosure = ET.parse(sys.argv[1]).find('.//enclosure')
assert enclosure is not None
print(enclosure.attrib['{http://www.andymatuschak.org/xml-namespaces/sparkle}edSignature'])
PY
)
"$SPARKLE_DIR/bin/sign_update" --account "$SIGNING_ACCOUNT" --verify "$RELEASE_ARCHIVE" "$ARCHIVE_SIGNATURE"
CHECK_DIR=$(mktemp -d)
trap 'rm -rf "$CHECK_DIR"' EXIT
python3 - "$RELEASE_ARCHIVE" "$RELEASE_DIR/appcast.xml" "$CHECK_DIR" <<'PY'
import pathlib, sys
for original, target in [(sys.argv[1], 'tampered.zip'), (sys.argv[2], 'tampered.xml')]:
    data = bytearray(pathlib.Path(original).read_bytes())
    if target.endswith('.xml'):
        data = data.replace(b'<title>', b'<title>TAMPERED ', 1)
    else:
        data[len(data)//2] ^= 1
    pathlib.Path(sys.argv[3], target).write_bytes(data)
PY
if "$SPARKLE_DIR/bin/sign_update" --account "$SIGNING_ACCOUNT" --verify "$CHECK_DIR/tampered.zip" "$ARCHIVE_SIGNATURE"; then
    print -u2 'FAIL: accepted tampered update archive'; exit 1
fi
if "$SPARKLE_DIR/bin/sign_update" --account "$SIGNING_ACCOUNT" --verify "$CHECK_DIR/tampered.xml"; then
    print -u2 'FAIL: accepted tampered update feed'; exit 1
fi
print 'PASS: update archive and feed signatures verified; both tampered files rejected'
