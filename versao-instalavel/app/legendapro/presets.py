"""Presets: arquivos JSON em presets/, numerados (preset-1, preset-2, ...).

Os nomes antigos (galho, desculpa, ...) continuam aceitos como apelido, para projetos e
comandos feitos antes da renumeração."""
import json
import os
import re

from .paths import PRESET_DIR

LEGACY = {"galho": "preset-1", "desculpa": "preset-2", "brilho": "preset-3",
          "serifa-amarela": "preset-4", "corte-limpo": "preset-5", "holofote": "preset-6"}
BUILTIN = set(LEGACY.values())   # presets das referências: não podem ser apagados
DEFAULT = "preset-2"

# nome curto que diz como o estilo é (aparece embaixo do "Preset N" na interface)
TAGLINES = {
    "preset-1": "Serifada vermelha com brilho", "preset-2": "Vermelho piscando e elipse",
    "preset-3": "Destaque branco gigante", "preset-4": "Amarelo que sobe com borrão",
    "preset-5": "Corte seco, 1–2 palavras", "preset-6": "Holofote amarelo com raios",
    "preset-7": "Frase empilhada", "preset-8": "Frase empilhada, fundo claro",
    "preset-9": "Rosa em modo diferença", "preset-10": "Caixa que se preenche",
    "preset-11": "Destaque que desliza",
    "preset-pop": "Palavra por palavra com pop",
}


def safe_name(s):
    s = re.sub(r"[^a-z0-9_-]+", "-", s.lower().strip()).strip("-")
    return s or "preset"


def resolve(name):
    n = safe_name(name or DEFAULT)
    return LEGACY.get(n, n)


def resolve_existing(name):
    """Como resolve(), mas um preset que foi apagado volta para o padrão."""
    n = resolve(name)
    return n if os.path.isfile(os.path.join(PRESET_DIR, n + ".json")) else DEFAULT


def natural_key(name):
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name)]


def names():
    # arquivos com ponto na frente são do programa (.fabrica.json = manifesto dos presets de fábrica)
    return sorted((f[:-5] for f in os.listdir(PRESET_DIR) if f.endswith(".json") and not f.startswith(".")),
                  key=natural_key)


def load(name):
    if name.endswith(".json") and os.path.isfile(name):
        return json.load(open(name, encoding="utf-8"))
    return json.load(open(os.path.join(PRESET_DIR, resolve(name) + ".json"), encoding="utf-8"))


def load_all():
    out = []
    for n in names():
        try:
            p = load(n)
        except Exception:
            continue
        p.setdefault("tagline", TAGLINES.get(p.get("name", n), ""))
        out.append(p)
    return out


def next_title():
    from .paths import factory_names
    nums = [int(m.group(1)) for n in set(names()) | factory_names() for m in [re.fullmatch(r"preset-(\d+)", n)] if m]
    return f"Preset {max(nums, default=0) + 1}"
