"""Gera os presets do motor "frase" a partir das medidas das referências v3–v6
(analysis/v*/REPORT.md). Rode de novo depois de ajustar algum número aqui."""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NO_SHADOW = {"opacity": 0.0, "blur": 0.005, "offset_y": 0.0}
GRAD_OFF = {"enabled": False, "top": 0.45, "full": 0.95, "opacity": 0.75, "curve": 1.0, "color": "#000000"}


def base_rules(**kw):
    r = {"engine": "phrase", "emphasis_threshold": 2.4, "emphasis_every": 3.0, "emphasis_gap": 2.0,
         "phrase_max_words": 7, "support_max_words": 3, "support_max_chars": 18,
         "chunk_max_words": 3, "chunk_max_chars": 16, "chunk_pause": 0.35, "max_hold": 0.8,
         "case": "keep", "strip_punct": ",;:", "hero_number_unit": True, "serif_tail": False,
         "article_alone": False}
    r.update(kw)
    return r


PRESETS = [
    {
        "name": "preset-3",
        "title": "Preset 3",
        "description": "Referência v3: minúsculas brancas com brilho suave, palavra-chave enorme em Geist com halo branco, "
                       "palavras surgindo uma a uma com subida, gradiente escuro embaixo.",
        "fonts": {
            "sans": {"file": "DMSans-VF.ttf", "axes": {"wght": 500, "opsz": 14}, "tracking": -0.02},
            "hero": {"file": "Geist-VF.ttf", "weight": 700, "tracking": -0.10},
            "serif": {"file": "Playfair2-Italic-VF.ttf", "axes": {"opsz": 1200, "wdth": 87, "wght": 300}, "tracking": -0.03},
        },
        "layout": {"anchor_mode": "top", "anchor_y": 0.608, "safe_width": 0.86, "base_size": 0.090,
                   "support_scale": 1.0, "hero_scale": 3.07, "hero_max_width": 0.75, "serif_scale": 1.6,
                   "above_align": "left", "above_indent": 0.075, "below_align": "right", "below_indent": 0.03,
                   "indent_fit": 1.0, "gap_above": 0.03, "gap_below": 0.022},
        "colors": {"text": "#FFFFFF", "hero": "#FFFFFF", "red": "#FF3B30", "accent": "#FFFFFF"},
        "effects": {
            "shadow": NO_SHADOW,
            "gradient": {"enabled": True, "top": 0.48, "full": 1.0, "opacity": 0.88, "curve": 1.0, "color": "#000000"},
            "glow": {
                "hero": {"layers": [[0.012, 0.10], [0.033, 0.30], [0.10, 0.45]], "color": "#FFFFFF", "blend": "screen"},
                "plain": {"layers": [[0.006, 0.15]], "color": "#FFFFFF", "blend": "screen"},
                "support": {"layers": [[0.006, 0.15]], "color": "#FFFFFF", "blend": "screen"},
            },
            "anim": {
                "plain": {"type": "rise", "reveal": "word", "duration": 0.32, "fade": 0.30, "from": "below", "dist": 0.046},
                "support": {"type": "rise", "reveal": "word", "duration": 0.32, "fade": 0.30, "from": "below", "dist": 0.046},
                "hero": {"type": "rise", "reveal": "word", "duration": 0.50, "fade": 0.45, "from": "below", "dist": 0.075, "blur": 0.008},
                "serif": {"type": "rise", "reveal": "word", "duration": 0.32, "fade": 0.30, "from": "below", "dist": 0.03},
            },
            "exit": {"type": "cut"},
            "lead": 0.02,
        },
        "rules": base_rules(case="lower", strip_punct=".,!?;:…", chunk_max_words=4, chunk_max_chars=18,
                            emphasis_every=3.0, emphasis_gap=2.0, max_hold=0.8),
    },
    {
        "name": "preset-4",
        "title": "Preset 4",
        "description": "Referência v4: texto em serifada fina branca com brilho, palavra-chave enorme amarelo-limão em sans "
                       "pesada que sobe com borrão de movimento, linhas de apoio encaixadas com recuo, gradiente escuro.",
        "fonts": {
            "sans": {"file": "Tinos-Regular.ttf", "tracking": -0.08},
            "hero": {"file": "Arimo-VF.ttf", "weight": 700, "tracking": -0.08},
            "serif": {"file": "Tinos-Regular.ttf", "tracking": -0.06},
        },
        "layout": {"anchor_mode": "baseline", "anchor_y": 0.75, "safe_width": 0.86, "base_size": 0.103,
                   "support_scale": 1.0, "hero_scale": 2.65, "hero_max_width": 0.80, "serif_scale": 1.2,
                   "above_align": "left", "above_indent": 0.093, "below_align": "left", "below_indent": 0.074,
                   "indent_fit": 1.0, "gap_above": 0.018, "gap_below": 0.008},
        "colors": {"text": "#FFFFFF", "hero": "#F4FC14", "red": "#FF3B30", "accent": "#F4FC14"},
        "effects": {
            "shadow": NO_SHADOW,
            "gradient": {"enabled": True, "top": 0.30, "full": 1.0, "opacity": 0.89, "curve": 2.1, "color": "#000000"},
            "glow": {
                "plain": {"layers": [[0.027, 0.8], [0.082, 1.0]], "color": None, "blend": "normal", "opacity": 0.7},
                "support": {"layers": [[0.027, 0.8], [0.082, 1.0]], "color": None, "blend": "normal", "opacity": 0.7},
                "hero": {"layers": [[0.022, 0.4], [0.10, 0.6]], "color": None, "blend": "normal", "opacity": 0.85},
            },
            "anim": {
                "plain": {"type": "cut", "reveal": "scene"},
                "support": {"type": "fade", "reveal": "word", "duration": 0.32, "fade": 0.32, "dist": 0.0},
                "hero": {"type": "rise", "reveal": "word", "duration": 0.50, "fade": 0.40, "from": "below", "dist": 0.12,
                         "motion_blur": 1.0},
                "serif": {"type": "fade", "reveal": "word", "duration": 0.32, "fade": 0.32},
            },
            "exit": {"type": "cut"},
            "lead": 0.02,
        },
        "rules": base_rules(case="lower", strip_punct=".,!?;:…", chunk_max_words=4, chunk_max_chars=18,
                            emphasis_every=14.0, emphasis_gap=8.0, max_hold=0.85),
    },
    {
        "name": "preset-5",
        "title": "Preset 5",
        "description": "Referência v5: uma ou duas palavras por vez em Inter Display SemiBold branca, centralizada, "
                       "troca seca sem animação, linha de base fixa. Simples e limpa.",
        "fonts": {
            "sans": {"file": "InterDisplay-SemiBold.ttf", "tracking": -0.062},
            "hero": {"file": "InterDisplay-SemiBold.ttf", "tracking": -0.062},
            "serif": {"file": "InterDisplay-SemiBold.ttf", "tracking": -0.062},
        },
        # sem destaque automático; o destaque marcado à mão fica maior (o "zoom" que o editor dava)
        "layout": {"anchor_mode": "baseline", "anchor_y": 0.5795, "safe_width": 0.86, "base_size": 0.066,
                   "support_scale": 1.0, "hero_scale": 1.6, "hero_max_width": 0.86, "serif_scale": 1.0,
                   "gap_above": 0.02, "gap_below": 0.02},
        "colors": {"text": "#FFFFFF", "hero": "#FFFFFF", "red": "#FF3B30", "accent": "#FFFFFF"},
        "effects": {
            "shadow": NO_SHADOW, "gradient": dict(GRAD_OFF),
            "glow": {},
            "anim": {"plain": {"type": "cut", "reveal": "scene"}, "support": {"type": "cut", "reveal": "scene"},
                     "hero": {"type": "cut", "reveal": "scene"}, "serif": {"type": "cut", "reveal": "scene"}},
            "exit": {"type": "cut"},
            "lead": 0.02,
        },
        "rules": base_rules(case="keep", strip_punct=",;:", chunk_max_words=2, chunk_max_chars=12,
                            article_alone=True, emphasis_every=0, max_hold=1.0),
    },
    {
        "name": "preset-6",
        "title": "Preset 6",
        "description": "Referência v6: palavras pequenas brancas em Inter Tight sobre um destaque amarelo com degradê, "
                       "halo e raios de luz que atravessam a palavra (só em algumas palavras); serifada fina para o nome que "
                       "completa o destaque; a narração normal entra seca, como no preset 4.",
        "fonts": {
            "sans": {"file": "InterTight-VF.ttf", "weight": 400, "tracking": -0.03},
            "hero": {"file": "InterTight-VF.ttf", "weight": 750, "tracking": -0.05},
            "serif": {"file": "Playfair2-Italic-VF.ttf", "axes": {"opsz": 1200, "wdth": 87, "wght": 300}, "tracking": -0.03},
        },
        "layout": {"anchor_mode": "baseline", "anchor_y": 0.595, "plain_anchor_y": 0.54, "safe_width": 0.86,
                   "base_size": 0.088, "support_scale": 1.0, "hero_scale": 1.84, "hero_max_width": 0.56,
                   "serif_scale": 1.7, "hero_short_scale": 1.4, "hero_short_chars": 4, "above_align": "center", "above_indent": 0.0, "below_align": "center",
                   "below_indent": 0.0, "indent_fit": 1.0, "gap_above": 0.045, "gap_below": 0.04,
                   "serif_drop": 0.085, "serif_indent": 0.04},
        "colors": {"text": "#FFFFFF", "hero": "#F5E314", "hero_fill": {"inner": "#F9FF55", "radius": 0.5},
                   "red": "#FF3B30", "accent": "#F5E314"},
        "effects": {
            "shadow": NO_SHADOW, "gradient": dict(GRAD_OFF, opacity=0.55, curve=1.3),
            "glow": {"hero": {"layers": [[0.007, 0.2], [0.045, 0.8]], "color": "#FFE600", "blend": "screen", "opacity": 0.6}},
            # a luz atravessa a palavra devagar, durante todo o tempo do destaque (turn_span 1 = varredura
            # contínua do começo ao fim), com raios mais suaves
            "rays": {"enabled": True, "length": 0.11, "decay": 0.05, "gain": 0.42, "color": "#FFE600",
                     "turn_at": 0.5, "turn_span": 1.0, "sweep_ease": "linear", "samples": 18},
            "anim": {
                # narração normal igual ao preset 4: bloco entra seco, apoio acende palavra a palavra
                "plain": {"type": "cut", "reveal": "scene"},
                "support": {"type": "fade", "reveal": "word", "duration": 0.32, "fade": 0.32, "dist": 0.0},
                "hero": {"type": "rise", "reveal": "word", "duration": 0.24, "fade": 0.16, "from": ["below", "right", "above"],
                         "dist": 0.09, "motion_blur": 2.2, "ease": "out_cubic"},
                "serif": {"type": "fade", "reveal": "word", "duration": 0.28, "fade": 0.25, "blur": 0.012},
            },
            "exit": {"type": "cut"},
            "lead": 0.02,
        },
        # destaque com luz só em algumas palavras
        "rules": base_rules(case="keep", strip_punct=".,!?;:…", chunk_max_words=4, chunk_max_chars=18,
                            serif_tail=True, emphasis_every=6.0, emphasis_gap=4.0, support_max_words=2,
                            support_max_chars=14, max_hold=0.85),
    },
]


def stack_preset(name, title, description, dark):
    """Referência v7 (tipografia cinética "acumula e assenta"). dark=True: texto escuro, fiel à
    referência (fundos claros); dark=False: texto branco para vídeo com pessoa."""
    ink = "#242424" if dark else "#FFFFFF"
    settle = {"type": "rise", "reveal": "word", "duration": 0.95, "ease": "out_quart", "fade_with_motion": True,
              "opacity_from": 0.28 if dark else 0.32, "dist": 0.113}
    return {
        "name": name, "title": title, "description": description,
        "fonts": {
            "sans": {"file": "Inter-VF.ttf", "axes": {"opsz": 32, "wght": 400}, "tracking": -0.024},
            "italic": {"file": "Inter-Italic-VF.ttf", "axes": {"opsz": 32, "wght": 550}, "tracking": -0.02},
            "hero": {"file": "Inter-VF.ttf", "axes": {"opsz": 32, "wght": 740}, "tracking": -0.02},
            "serif": {"file": "Inter-Italic-VF.ttf", "axes": {"opsz": 32, "wght": 700}, "tracking": -0.012},
        },
        "layout": {"anchor_mode": "top", "anchor_y": 0.44 if dark else 0.56, "max_bottom": 0.88 if dark else 0.86,
                   "safe_width": 0.80, "base_size": 0.065, "support_scale": 1.0, "hero_scale": 1.82,
                   "hero_short_scale": 1.4, "hero_short_chars": 6, "hero_max_width": 0.78, "serif_scale": 1.65,
                   "gap_above": 0.028, "gap_below": 0.025, "gap_lines": 0.02, "hero_line_gap": 0.96, "box_gap": 0.03},
        "colors": {"text": ink, "hero": ink, "red": "#E3241D", "accent": ink,
                   "box": {"fill": "#242424" if dark else "#F5F5F5", "text": "#F5F5F5" if dark else "#161616",
                           "radius": 0.014, "pad_x": 0.022, "pad_y": 0.024, "shadow": 0.35}},
        "effects": {
            "shadow": {"opacity": 0.0, "blur": 0.005, "offset_y": 0.0} if dark
            else {"opacity": 0.45, "blur": 0.018, "offset_y": 0.004},
            "gradient": dict(GRAD_OFF) if dark
            else {"enabled": True, "top": 0.42, "full": 0.95, "opacity": 0.5, "curve": 1.6, "color": "#000000"},
            "glow": {},
            "anim": {
                # linha longa (4+ palavras) vem da direita, o resto de baixo; tudo "assenta" em ~1 s
                "plain": dict(settle, **{"from": "auto_line", "right_if_words": 4}),
                "support": dict(settle, **{"from": "auto_line", "right_if_words": 4}),
                "hero": dict(settle, **{"from": "below"}),
                "serif": dict(settle, **{"from": "below"}),
            },
            "box_wipe": {"duration": 0.83},
            "exit": {"type": "fade", "duration": 0.25},
            "lead": 0.10,
        },
        "rules": base_rules(layout_engine="stack", case="keep", strip_punct=",;:", phrase_max_words=9,
                            support_max_words=6, support_max_chars=32, hero_max_words=3, hero_max_chars=14,
                            block_max_words=16, block_max_dur=7.0, block_pause=0.9, max_lines=4,
                            emphasis_every=2.0, emphasis_gap=1.2, max_hold=3.0, box_hook=True),
    }


PRESETS += [
    stack_preset("preset-7", "Preset 7",
                 "Referência v7 para vídeo com pessoa: a frase vai se empilhando em linhas (apoio, palavra forte em "
                 "Inter bold, continuação em itálico); cada palavra entra deslizando e 'assenta' em ~1 s, já nascendo "
                 "translúcida; texto branco com sombra suave e gradiente embaixo; caixa revelada por cortina.", False),
    stack_preset("preset-8", "Preset 8",
                 "Referência v7 fiel: igual ao Preset 7, com texto escuro (#242424) para fundos claros e "
                 "caixa escura com texto branco.", True),
]

for p in PRESETS:
    path = os.path.join(ROOT, "presets", p["name"] + ".json")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(p, ensure_ascii=False, indent=2) + "\n")
    print("ok", path)
