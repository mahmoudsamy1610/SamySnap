"""Generate the extension icons (a red record dot on a dark rounded square).
Run: python3 scripts/make-icons.py   (needs Pillow)"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

for size in (16, 32, 48, 128):
    s = size * 4  # draw large, then downscale for smooth edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=s // 5, fill=(32, 33, 36, 255))
    r = s * 0.30
    c = s / 2
    d.ellipse((c - r, c - r, c + r, c + r), fill=(217, 48, 37, 255))
    # small "link" highlight
    hr = s * 0.09
    d.ellipse((c - r * 0.45 - hr, c - r * 0.45 - hr, c - r * 0.45 + hr, c - r * 0.45 + hr), fill=(255, 255, 255, 90))
    img.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
print("icons written to", OUT)
