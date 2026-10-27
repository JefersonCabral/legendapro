# Compara fontes candidatas renderizando a mesma palavra ao lado do recorte de referência
import sys
from PIL import Image, ImageDraw, ImageFont
word, ref, out = sys.argv[1], sys.argv[2], sys.argv[3]
cands = sys.argv[4:]
refim = Image.open(ref).convert("RGB")
H = refim.height
rows = [refim]
for c in cands:
    path, _, wght = c.partition("@")
    f = ImageFont.truetype("fonts/cand/" + path, int(H * 0.62))
    if wght:
        try:
            axes = f.get_variation_axes()
            vals = [float(wght) if a.get("name", b"") in (b"Weight", "Weight") else a["default"] for a in axes]
            f.set_variation_by_axes(vals)
        except Exception as e:
            print("var fail", path, e)
    im = Image.new("RGB", (refim.width, H), (20, 20, 20))
    d = ImageDraw.Draw(im)
    d.text((refim.width // 2, H // 2), word, font=f, fill="white", anchor="mm")
    d.text((4, 4), c, fill=(255, 255, 0))
    rows.append(im)
sheet = Image.new("RGB", (refim.width, H * len(rows)))
for i, r in enumerate(rows):
    sheet.paste(r, (0, i * H))
sheet.save(out)
