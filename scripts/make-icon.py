#!/usr/bin/env python3
"""Render apps/desktop/build/icon.png (1024x1024): a glowing lamp over a Manchester-coded DALI waveform.
Pure standard library, so it runs anywhere:  python3 scripts/make-icon.py"""
import math, struct, zlib, pathlib

N = 1024
out = pathlib.Path(__file__).resolve().parent.parent / 'apps/desktop/build/icon.png'

def sd_round_rect(x, y, cx, cy, hw, hh, r):
    dx, dy = abs(x - cx) - (hw - r), abs(y - cy) - (hh - r)
    return math.hypot(max(dx, 0), max(dy, 0)) + min(max(dx, dy), 0) - r

def sd_segment(x, y, ax, ay, bx, by):
    px, py, dx, dy = x - ax, y - ay, bx - ax, by - ay
    t = max(0, min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - t * dx, py - t * dy)

# Manchester-like waveform: (x, y) polyline
lo, hi, y0 = 850, 740, 0
pts = []
x = 170
level = [1, 0, 1, 1, 0, 1, 0, 0]
step = 84
cur = lo
for b in level:
    first, second = (hi, lo) if b else (lo, hi)
    if cur != first: pts.append((x, cur)); pts.append((x, first))
    else: pts.append((x, first))
    pts.append((x + step // 2, first)); pts.append((x + step // 2, second))
    pts.append((x + step, second)); cur = second; x += step
segs = [(p, q) for p, q in zip(pts, pts[1:]) if p != q]

def over(dst, src, a):
    return tuple(d * (1 - a) + s * a for d, s in zip(dst, src))

rows = []
for j in range(N):
    row = bytearray([0])
    for i in range(N):
        px, py = i + 0.5, j + 0.5
        d = sd_round_rect(px, py, N / 2, N / 2, 480, 480, 190)
        a_bg = max(0, min(1, 0.5 - d))
        if a_bg <= 0:
            row += bytes((0, 0, 0, 0)); continue
        # background gradient
        t = j / N
        col = (24 + 18 * t, 32 + 20 * t, 52 + 30 * t)
        # lamp glow
        r = math.hypot(px - 512, py - 410)
        glow = max(0, 1 - r / 330) ** 2
        col = over(col, (255, 190, 80), min(1, glow * 0.85))
        a = max(0, min(1, 0.5 - (r - 190)))      # lamp disc edge
        core = (255, 244, 205) if r < 190 else (0, 0, 0)
        col = over(col, (255, 232, 160), a * 0.95)
        a2 = max(0, min(1, 0.5 - (r - 110)))
        col = over(col, core if r < 110 else (255, 250, 235), a2 * 0.8)
        # waveform
        if j > 700:
            dm = min(sd_segment(px, py, *p, *q) for p, q in segs)
            col = over(col, (230, 238, 250), max(0, min(1, 0.5 - (dm - 13))))
        row += bytes((int(max(0, min(255, c))) for c in col)) + bytes((int(a_bg * 255),))
    rows.append(bytes(row))

def chunk(t, d):
    c = struct.pack('>I', len(d)) + t + d
    return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', N, N, 8, 6, 0, 0, 0)) \
    + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
out.write_bytes(png)
print('wrote', out, len(png), 'bytes')
