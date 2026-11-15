"""Draw the README banner's ASCII art: a few notes on a curved five-line staff, like the site's header strand."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np, math

COLS, ROWS = 58, 34              # characters; a character is about twice as tall as it is wide
W, H = COLS * 20, ROWS * 40
RAMP = " '~,;=+clvxCoeaqUQO0@"
img = Image.new("L", (W, H), 0)
d = ImageDraw.Draw(img)
note = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 620)
small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 420)

def y_at(x, k):  # a gently waving staff
    return H * 0.40 + k * 82 + 90 * math.sin(x / W * math.pi * 1.6 + 0.4)

for k in range(5):
    pts = [(x, y_at(x, k)) for x in range(0, W + 1, 8)]
    d.line(pts, fill=200, width=14)
d.text((W * 0.05, H * 0.02), "♫", font=note, fill=255)    # beamed pair
d.text((W * 0.60, H * 0.20), "♪", font=small, fill=255)    # single eighth
img = img.filter(ImageFilter.GaussianBlur(2))
a = np.asarray(img.resize((COLS, ROWS), Image.LANCZOS), dtype=float) / 255
lines = ["".join(RAMP[min(len(RAMP) - 1, int(v * (len(RAMP) - 1)))] for v in r).rstrip() for r in a]
open("docs/banner/notes.txt", "w").write("\n".join(lines) + "\n")
print("\n".join(lines))
