# Monta uma grade de frames consecutivos recortados (para análise de animação quadro a quadro)
import sys
from PIL import Image, ImageDraw
d, a, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
y0, y1 = int(sys.argv[4]), int(sys.argv[5])
out = sys.argv[6]
step = int(sys.argv[7]) if len(sys.argv) > 7 else 1
cols = int(sys.argv[8]) if len(sys.argv) > 8 else 6
x0, x1 = 60, 660
idx = list(range(a, b + 1, step))
w, h = x1 - x0, y1 - y0
rows = (len(idx) + cols - 1) // cols
sheet = Image.new("RGB", (w * cols, h * rows), "black")
for i, n in enumerate(idx):
    im = Image.open(f"{d}/f{n:04d}.jpg").crop((x0, y0, x1, y1))
    ImageDraw.Draw(im).text((4, 2), str(n), fill=(255, 255, 0))
    sheet.paste(im, ((i % cols) * w, (i // cols) * h))
sheet.save(out, quality=88)
