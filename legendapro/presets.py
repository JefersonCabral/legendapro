"""Presets: arquivos JSON em presets/, numerados (preset-1, preset-2, ...).

Os nomes antigos (galho, desculpa, ...) continuam aceitos como apelido, para projetos e
comandos feitos antes da renumeração."""
import json
import os
import re

from .render import ROOT

PRESET_DIR = os.path.join(ROOT, "presets")

LEGACY = {"galho": "preset-1", "desculpa": "preset-2", "brilho": "preset-3",
          "serifa-amarela": "preset-4", "corte-limpo": "preset-5", "holofote": "preset-6"}
BUILTIN = set(LEGACY.values())   # presets das referências: não podem ser apagados
DEFAULT = "preset-2"


def safe_name(s):
    s = re.sub(r"[^a-z0-9_-]+", "-", s.lower().strip()).strip("-")
    return s or "preset"


def resolve(name):
    n = safe_name(name or DEFAULT)
    return LEGACY.get(n, n)


def natural_key(name):
    return [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", name)]


def names():
    return sorted((f[:-5] for f in os.listdir(PRESET_DIR) if f.endswith(".json")), key=natural_key)


def load(name):
    if name.endswith(".json") and os.path.isfile(name):
        return json.load(open(name, encoding="utf-8"))
    return json.load(open(os.path.join(PRESET_DIR, resolve(name) + ".json"), encoding="utf-8"))


def load_all():
    out = []
    for n in names():
        try:
            out.append(load(n))
        except Exception:
            pass
    return out


def next_title():
    nums = [int(m.group(1)) for n in names() for m in [re.fullmatch(r"preset-(\d+)", n)] if m]
    return f"Preset {max(nums, default=0) + 1}"
