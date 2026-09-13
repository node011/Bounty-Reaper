#!/usr/bin/env python3
"""Regenerate all web favicon/social assets with the BountyReper BR mark."""
from PIL import Image, ImageDraw
from pathlib import Path

B = ["████", "█  █", "███ ", "█  █", "████"]
R = ["████", "█  █", "████", "█  █", "█  █"]
GRID = [list(rb) + ["  "] + list(rr) for rb, rr in zip(B, R)]

BG = (19, 16, 16, 255)
TOP = (255, 158, 40)
BOTTOM = (214, 92, 14)
PUBLIC = Path(__file__).resolve().parent.parent / "app" / "public"


def render(size: int, tile: bool = True) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if tile:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.19), fill=BG)
    cols, rows = len(GRID[0]), len(GRID)
    cell = int(size * 0.82) // cols
    gw, gh = cols * cell, rows * cell
    ox, oy = (size - gw) // 2, (size - gh) // 2
    for r, row in enumerate(GRID):
        # vertical gradient color for this row
        t = r / max(1, rows - 1)
        col = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
        for c, ch in enumerate(row):
            if ch == "█":
                d.rectangle([ox + c * cell, oy + r * cell, ox + (c + 1) * cell - 1, oy + (r + 1) * cell - 1], fill=col)
    return img


def render_share(width: int = 1200, height: int = 630) -> Image.Image:
    img = Image.new("RGBA", (width, height), BG)
    d = ImageDraw.Draw(img)
    mark = render(360)
    img.paste(mark, ((width - 360) // 2, (height - 360) // 2 - 40), mark)
    d.text((width // 2, height // 2 + 160), "BountyReper", anchor="mm", fill=(232, 228, 224), font_size=72)
    return img


def svg_mark() -> str:
    size, cell = 512, 46
    cols, rows = len(GRID[0]), len(GRID)
    ox, oy = (size - cols * cell) // 2, (size - rows * cell) // 2
    rects = "".join(
        f'<rect x="{ox+c*cell}" y="{oy+r*cell}" width="{cell}" height="{cell}"/>'
        for r, row in enumerate(GRID)
        for c, ch in enumerate(row)
        if ch == "█"
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">'
        f'<rect width="{size}" height="{size}" rx="96" fill="#131010"/>'
        f'<g fill="url(#g)"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        f'<stop offset="0" stop-color="rgb({TOP[0]},{TOP[1]},{TOP[2]})"/>'
        f'<stop offset="1" stop-color="rgb({BOTTOM[0]},{BOTTOM[1]},{BOTTOM[2]})"/>'
        f"</linearGradient></defs>{rects}</g></svg>"
    )


def main():
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "favicon-v3.svg").write_text(svg_mark())
    (PUBLIC / "favicon.svg").write_text(svg_mark())
    for name, size in [
        ("apple-touch-icon-v3.png", 180),
        ("apple-touch-icon.png", 180),
        ("favicon-96x96-v3.png", 96),
        ("favicon-96x96.png", 96),
        ("web-app-manifest-192x192.png", 192),
        ("web-app-manifest-512x512.png", 512),
    ]:
        render(size).save(PUBLIC / name)
    render(48).save(PUBLIC / "favicon-v3.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    render(48).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    render_share().convert("RGB").save(PUBLIC / "social-share.png")
    render_share().convert("RGB").save(PUBLIC / "social-share-zen.png")
    print("favicon assets written to", PUBLIC)


if __name__ == "__main__":
    main()
