#!/usr/bin/env python3
"""Generate BountyReaper 'BR' identity assets (PNG + SVG)."""
import math
import struct
import zlib
from pathlib import Path

B = [
    "████",
    "█  █",
    "███ ",
    "█  █",
    "████",
]
R = [
    "████",
    "█  █",
    "████",
    "█  █",
    "█  █",
]
GRID = [list(rb) + [" ", " "] + list(rr) for rb, rr in zip(B, R)]

BG = (19, 16, 16)
TOP = (255, 158, 40)
BOTTOM = (214, 92, 14)

COLS, ROWS = len(GRID[0]), len(GRID)


def color_at(t: float) -> tuple[int, int, int]:
    return tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))


def cells() -> list[tuple[int, int]]:
    return [(r, c) for r, row in enumerate(GRID) for c, ch in enumerate(row) if ch == "█"]


def write_png(path: Path, size: int = 512, radius_ratio: float = 0.19) -> None:
    cell = int((size * 0.86) / COLS)
    grid_w, grid_h = COLS * cell, ROWS * cell
    ox = (size - grid_w) // 2
    oy = (size - grid_h) // 2
    radius = int(size * radius_ratio)
    cells_set = set(CELLS)

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            dx = max(0, abs(x - size / 2) - (size / 2 - radius))
            dy = max(0, abs(y - size / 2) - (size / 2 - radius))
            if math.hypot(dx, dy) > radius:
                row += bytes((0, 0, 0, 0))
                continue
            px = BG + (255,)
            c = (x - ox) // cell
            r = (y - oy) // cell
            if 0 <= r < ROWS and 0 <= c < COLS and (r, c) in cells_set:
                t = (y - oy) / max(1, grid_h)
                px = color_at(t) + (255,)
            row += bytes(px)
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(png)


def write_svg(path: Path, dark: bool = True) -> None:
    size, cell = 512, 46
    grid_w, grid_h = COLS * cell, ROWS * cell
    ox, oy = (size - grid_w) // 2, (size - grid_h) // 2
    bg = "#131010" if dark else "#f5f2f0"
    rect = [f'<rect x="{ox + c * cell}" y="{oy + r * cell}" width="{cell}" height="{cell}"/>' for r, c in CELLS]
    gradient = (
        '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="rgb({TOP[0]},{TOP[1]},{TOP[2]})"/>'
        f'<stop offset="1" stop-color="rgb({BOTTOM[0]},{BOTTOM[1]},{BOTTOM[2]})"/>'
        "</linearGradient></defs>"
    )
    path.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
        f'{gradient}<rect width="{size}" height="{size}" rx="96" fill="{bg}"/>'
        f'<g fill="url(#g)">{"".join(rect)}</g></svg>'
    )


CELLS = cells()
OUT = Path(__file__).resolve().parent
write_png(OUT / "mark-512x512.png")
write_svg(OUT / "mark.svg", dark=True)
write_svg(OUT / "mark-light.svg", dark=False)
print("written:", OUT)
