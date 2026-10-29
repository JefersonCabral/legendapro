"""Gera o ícone do LegendaPRO (.ico com vários tamanhos) usando o Pillow do Python embutido.
Uso: python make_icon.py <fonte.ttf> <saida.ico>"""
import sys

from PIL import Image, ImageDraw, ImageFont

font_path, out = sys.argv[1], sys.argv[2]
S = 256
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((8, 8, S - 8, S - 8), radius=56, fill=(24, 20, 18, 255))
# "faixa" de legenda em âmbar (cor de destaque da interface)
d.rounded_rectangle((44, 168, S - 44, 196), radius=14, fill=(255, 181, 71, 255))
f = ImageFont.truetype(font_path, 118)
txt = "LP"
x0, y0, x1, y1 = d.textbbox((0, 0), txt, font=f)
d.text(((S - (x1 - x0)) / 2 - x0, 40 - y0), txt, font=f, fill=(255, 255, 255, 255))
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icone:", out)
