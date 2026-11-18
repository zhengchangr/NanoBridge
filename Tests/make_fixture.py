"""Generate a tiny synthetic NCM with an independent Python/OpenSSL encoder."""
import base64
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import wave

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
with wave.open(str(root / "tone.wav"), "wb") as audio:
    audio.setparams((2, 2, 44100, 0, "NONE", "not compressed"))
    audio.writeframes(b"".join(struct.pack("<hh", int(math.sin(i * 440 * 2 * math.pi / 44100) * 4000), 0) for i in range(44100)))
subprocess.run(["/usr/bin/afconvert", str(root / "tone.wav"), str(root / "tone.flac"), "-f", "flac", "-d", "flac"], check=True)

def encrypt(data, key):
    return subprocess.run(["/usr/bin/openssl", "enc", "-aes-128-ecb", "-K", key.hex()], input=data, stdout=subprocess.PIPE, check=True).stdout

key = b"independent-fixture-key"
key_blob = bytes(x ^ 0x64 for x in encrypt(b"neteasecloudmusic" + key, b"hzHRAmso5kInbaxW"))
metadata = json.dumps({"musicName": "测试音乐 / Test", "album": "Synthetic", "artist": [["Nano Artist", 1]], "format": "flac"}, ensure_ascii=False).encode()
meta_blob = bytes(x ^ 0x63 for x in b"163 key(Don't modify):" + base64.b64encode(encrypt(b"music:" + metadata, b"#14ljk_!\\]&0U<'(")))
box = list(range(256))
j = 0
for i in range(256):
    j = (box[i] + j + key[i % len(key)]) % 256
    box[i], box[j] = box[j], box[i]
plain = (root / "tone.flac").read_bytes()
cipher = bytearray(plain)
for i in range(len(cipher)):
    j = (i + 1) % 256
    cipher[i] ^= box[(box[j] + box[(box[j] + j) % 256]) % 256]
# Valid 1x1 PNG cover; allocation is larger than image data to test padding.
cover = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1cAAAAASUVORK5CYII=")
def uint(n):
    return struct.pack("<I", n)
blob = (b"CTENFDAM\x00\x00" + uint(len(key_blob)) + key_blob + uint(len(meta_blob)) + meta_blob +
        b"\x00" * 5 + uint(len(cover) + 24) + uint(len(cover)) + cover + b"\x00" * 24 + cipher)
(root / "fixture.ncm").write_bytes(blob)
(root / "cover.png").write_bytes(cover)
print("Created synthetic WAV, FLAC and NCM fixtures")
