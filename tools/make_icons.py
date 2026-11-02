"""Генерирует PNG-иконки CalenPulse без сторонних зависимостей."""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "icons")
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def dist(x, y, cx, cy):
    return ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5


def render(size):
    n = size * SS
    canvas = [[(0, 0, 0, 0)] * n for _ in range(n)]
    blue = (91, 141, 239)
    violet = (124, 92, 255)
    sheet = (247, 249, 253)
    navy = (35, 48, 77)
    accent = (94, 112, 255)
    line2 = (196, 204, 224)
    red = (255, 92, 92)

    for py in range(n):
        y = (py + 0.5) / n
        for px in range(n):
            x = (px + 0.5) / n
            px_color = (0, 0, 0, 0)

            if in_round_rect(x, y, 0.02, 0.02, 0.98, 0.98, 0.21):
                t = max(0.0, min(1.0, (x * 0.35 + y * 0.65)))
                px_color = lerp(blue, violet, t) + (255,)

            if in_round_rect(x, y, 0.15, 0.22, 0.85, 0.82, 0.08):
                px_color = sheet + (255,)

            for bx in (0.26, 0.62):
                if in_round_rect(x, y, bx, 0.145, bx + 0.10, 0.31, 0.045):
                    px_color = navy + (255,)

            if in_round_rect(x, y, 0.30, 0.475, 0.64, 0.535, 0.03):
                px_color = accent + (255,)
            if in_round_rect(x, y, 0.30, 0.585, 0.53, 0.645, 0.03):
                px_color = line2 + (255,)

            d = dist(x, y, 0.825, 0.175)
            if d <= 0.115:
                px_color = red + (255,)
            elif d <= 0.155:
                px_color = sheet + (255,)

            canvas[py][px] = px_color

    out = [[(0, 0, 0, 0)] * size for _ in range(size)]
    for oy in range(size):
        for ox in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                for dx in range(SS):
                    pr, pg, pb, pa = canvas[oy * SS + dy][ox * SS + dx]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            if a == 0:
                out[oy][ox] = (0, 0, 0, 0)
            else:
                out[oy][ox] = (r // a, g // a, b // a, a // (SS * SS))
    return out


def write_png(path, pixels):
    height = len(pixels)
    width = len(pixels[0])
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in pixels)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, render(size))
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
