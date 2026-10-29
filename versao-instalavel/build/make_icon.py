"""Gera o ícone do LegendaPRO usando o Pillow do Python embutido.
Uso: python make_icon.py <fonte.ttf> <saida.ico|saida.icns>
.ico (Windows) com vários tamanhos até 256; .icns (Mac) desenhado em 1024 (o Pillow monta os tamanhos)."""
import sys

from PIL import Image, ImageDraw, ImageFont

font_path, out = sys.argv[1], sys.argv[2]
S = 1024 if out.lower().endswith(".icns") else 256
k = S / 256                       # o desenho foi pensado em 256 px
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((8 * k, 8 * k, S - 8 * k, S - 8 * k), radius=56 * k, fill=(24, 20, 18, 255))
# "faixa" de legenda em âmbar (cor de destaque da interface)
d.rounded_rectangle((44 * k, 168 * k, S - 44 * k, 196 * k), radius=14 * k, fill=(255, 181, 71, 255))
f = ImageFont.truetype(font_path, int(118 * k))
txt = "LP"
x0, y0, x1, y1 = d.textbbox((0, 0), txt, font=f)
d.text(((S - (x1 - x0)) / 2 - x0, 40 * k - y0), txt, font=f, fill=(255, 255, 255, 255))
if out.lower().endswith(".icns"):
    img.save(out)
else:
    img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icone:", out)
