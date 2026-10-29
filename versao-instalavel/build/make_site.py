"""Copia a interface do motor (app/ui) para o site (site/app), para ela rodar hospedada no Cloudflare Pages.

    python build/make_site.py

A interface é a mesma nos dois lugares; no site ela procura o motor do PC em 127.0.0.1 (ver app.js,
"motor"). Rode de novo sempre que mudar algo em app/ui. Também copia as fontes da interface
(Poppins + DM Mono, OFL) para site/fonts, que o styles.css pede em /fonts/.
"""
import os
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
UI = os.path.join(ROOT, "app", "ui")
FONTS = os.path.join(ROOT, "app", "fonts")
SITE = os.path.join(ROOT, "site")

UI_FONTS = ["Poppins-Regular.ttf", "Poppins-Medium.ttf", "Poppins-SemiBold.ttf", "Poppins-Bold.ttf",
            "Poppins-BoldItalic.ttf", "OFL-Poppins.txt", "ui/DMMono-Regular.ttf", "ui/DMMono-Medium.ttf",
            "ui/OFL-DMMono.txt"]


def main():
    out = os.path.join(SITE, "app")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    for f in ("app.js", "styles.css"):
        shutil.copyfile(os.path.join(UI, f), os.path.join(out, f))
    html = open(os.path.join(UI, "index.html"), encoding="utf-8").read()
    # o site tem o config.js com o link do instalador (botão "Baixar" da tela de abrir o motor)
    tag = '<script src="app.js"></script>'
    assert tag in html, "index.html mudou: ajuste make_site.py"
    html = html.replace(tag, '<script src="/config.js"></script>\n' + tag)
    open(os.path.join(out, "index.html"), "w", encoding="utf-8", newline="\n").write(html)
    for f in UI_FONTS:
        dst = os.path.join(SITE, "fonts", f)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(FONTS, f), dst)
    print("site/app e site/fonts atualizados")


if __name__ == "__main__":
    main()
