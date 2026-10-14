"""Draws the goodink app icon (a notebook with a pen nib stroke) and writes build/icon.ico + icon.png.
Pure standard library: rasterises with 4x4 supersampling and stores PNG frames inside the ICO."""
import struct, zlib, math, os

def inside_rrect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + t * dx - px, ay + t * dy - py)

# a curved ink stroke as a polyline (unit coords 0..1)
STROKE = [(0.30 + 0.42 * t, 0.70 - 0.38 * t + 0.10 * math.sin(t * math.pi)) for t in [i / 24 for i in range(25)]]

def sample(u, v):
    """Return RGBA for a point in unit space."""
    # shadow
    col = (0, 0, 0, 0)
    if inside_rrect(u, v, 0.14, 0.09, 0.86, 0.95, 0.12):
        col = (0, 0, 0, 40)
    if inside_rrect(u, v, 0.12, 0.06, 0.84, 0.92, 0.12):
        # cover gradient blue
        k = v
        col = (int(43 + 20 * k), int(89 - 10 * k), int(217 - 30 * k), 255)
        if u < 0.21:  # spine
            col = (int(col[0] * 0.78), int(col[1] * 0.78), int(col[2] * 0.82), 255)
        # paper sheet
        if inside_rrect(u, v, 0.27, 0.16, 0.77, 0.82, 0.05):
            col = (252, 252, 255, 255)
            for ly in (0.30, 0.40, 0.50, 0.60, 0.70):
                if abs(v - ly) < 0.007 and 0.31 < u < 0.73:
                    col = (200, 212, 236, 255)
            d = min(seg_dist(u, v, *STROKE[i], *STROKE[i + 1]) for i in range(len(STROKE) - 1))
            w = 0.022 + 0.018 * (u - 0.3)
            if d < w:
                col = (24, 24, 30, 255)
    return col

def render(size):
    ss = 4
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    r, g, b, a = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size)
                    acc[0] += r * a; acc[1] += g * a; acc[2] += b * a; acc[3] += a
            n = ss * ss
            a = acc[3] / n
            if a > 0:
                row += bytes([int(acc[0] / acc[3]), int(acc[1] / acc[3]), int(acc[2] / acc[3]), int(a)])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b''.join(rows)
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

sizes = [16, 24, 32, 48, 64, 128, 256]
pngs = [render(s) for s in sizes]
os.makedirs('build', exist_ok=True)
with open('build/icon.png', 'wb') as f:
    f.write(render(512))
header = struct.pack('<HHH', 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
entries = b''
for s, p in zip(sizes, pngs):
    entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(p), offset)
    offset += len(p)
with open('build/icon.ico', 'wb') as f:
    f.write(header + entries + b''.join(pngs))
print('icon written')
