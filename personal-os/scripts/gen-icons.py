"""生成 Tauri 需要的图标（纯标准库，不装 Pillow）。
输出：src-tauri/icons/32x32.png、128x128.png、128x128@2x.png、icon.ico、icon.png
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BG = (0x0F, 0x11, 0x15, 255)
ACCENT = (0x5B, 0x8C, 0xFF, 255)
WHITE = (0xE6, 0xE9, 0xF0, 255)


def blank(size):
    return [[BG for _ in range(size)] for _ in range(size)]


def rect(px, size, x0, y0, x1, y1, color, fill=False):
    for y in range(max(0, y0), min(size, y1)):
        for x in range(max(0, x0), min(size, x1)):
            if fill or y in (y0, y1 - 1) or x in (x0, x1 - 1):
                px[y][x] = color


def rounded(px, size, m, r, color):
    """圆角外框"""
    for y in range(size):
        for x in range(size):
            inside = m <= x < size - m and m <= y < size - m
            if not inside:
                continue
            # 圆角：四角半径内的点排除
            corners = [
                (m + r, m + r), (size - m - r, m + r),
                (m + r, size - m - r), (size - m - r, size - m - r),
            ]
            skip = False
            for cx, cy in corners:
                if ((x < m + r and y < m + r) or (x > size - m - r and y < m + r) or
                        (x < m + r and y > size - m - r) or (x > size - m - r and y > size - m - r)):
                    if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
                        skip = True
            if skip:
                continue
            on_edge = (
                x in (m, size - m - 1) or y in (m, size - m - 1)
            )
            if on_edge:
                px[y][x] = color


def draw(size):
    px = blank(size)
    u = max(1, size // 16)
    rounded(px, size, u, u * 3, ACCENT)
    # 日历顶部横条
    rect(px, size, u * 4, u * 5, size - u * 4, u * 6, WHITE, fill=True)
    # 两个挂耳
    rect(px, size, u * 6, u * 2, u * 6 + u, u * 5, WHITE, fill=True)
    rect(px, size, size - u * 7, u * 2, size - u * 6, u * 5, WHITE, fill=True)
    # 内容格
    rect(px, size, u * 5, u * 8, u * 8, u * 10, WHITE, fill=True)
    rect(px, size, u * 9, u * 8, u * 12, u * 10, WHITE, fill=True)
    rect(px, size, u * 5, u * 11, u * 8, u * 13, WHITE, fill=True)
    rect(px, size, u * 9, u * 11, u * 12, u * 13, WHITE, fill=True)
    return px


def png_bytes(px, size):
    raw = bytearray()
    for row in px:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def ico_bytes(sizes):
    images = [png_bytes(draw(s), s) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b""
    for s, data in zip(sizes, images):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32,
                               len(data), offset)
        offset += len(data)
    return header + entries + b"".join(images)


for s in (32, 128, 256):
    (OUT / f"{s}x{s}.png").write_bytes(png_bytes(draw(s), s))
(OUT / "icon.png").write_bytes(png_bytes(draw(256), 256))
(OUT / "icon.ico").write_bytes(ico_bytes([32, 128, 256]))
print("桌面图标已生成：", OUT)

# PWA 图标：手机上"添加到主屏幕"需要 PNG（SVG 在 iOS/Android 上不认）
PUB = Path(__file__).resolve().parent.parent / "public"
for s in (192, 512):
    (PUB / f"icon-{s}.png").write_bytes(png_bytes(draw(s), s))
    print(f"✓ PWA 图标 icon-{s}.png")
(PUB / "apple-touch-icon.png").write_bytes(png_bytes(draw(180), 180))
print("✓ apple-touch-icon.png")
