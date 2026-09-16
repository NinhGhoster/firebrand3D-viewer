#!/usr/bin/env python3
"""Flip the HEVC sample-entry tag from hev1 to hvc1, in place, four bytes per file.

WebKit — Safari on macOS and iOS, and Chrome on iOS, which is WebKit too — only decodes
HEVC when the sample entry is tagged hvc1. The release is tagged hev1, so no video plays on
any Apple browser.

The two tags describe the same bitstream; they differ only in whether the parameter sets are
allowed in-band. These files carry them out-of-band in hvcC (2,438 bytes of extradata), so
the tag can simply be corrected. Re-muxing every file would move 16 GB to change four bytes
in each, so instead the moov atom is located, the fourcc found inside it, and those four
bytes overwritten. mdat is never read or touched and the file size does not change.
"""
import os, struct, sys

def top_level_boxes(f, size):
    off = 0
    while off + 8 <= size:
        f.seek(off)
        hdr = f.read(8)
        if len(hdr) < 8:
            return
        box = struct.unpack(">I", hdr[:4])[0]
        typ = hdr[4:8]
        if box == 1:                       # 64-bit extended size
            box = struct.unpack(">Q", f.read(8))[0]
        if box <= 0:
            return
        yield typ, off, box
        off += box

def retag(path):
    size = os.path.getsize(path)
    with open(path, "r+b") as f:
        moov = next(((o, s) for t, o, s in top_level_boxes(f, size) if t == b"moov"), None)
        if not moov:
            return "no-moov"
        off, length = moov
        f.seek(off)
        blob = f.read(length)
        if b"hvc1" in blob and b"hev1" not in blob:
            return "already"
        n = blob.count(b"hev1")
        if n == 0:
            return "no-tag"
        if n != 1:
            return f"ambiguous({n})"       # refuse rather than guess
        f.seek(off + blob.index(b"hev1"))
        f.write(b"hvc1")
    return "patched"

if __name__ == "__main__":
    counts = {}
    for p in sys.argv[1:]:
        r = retag(p)
        counts[r] = counts.get(r, 0) + 1
    print("  " + "  ".join(f"{k}={v}" for k, v in sorted(counts.items())))
