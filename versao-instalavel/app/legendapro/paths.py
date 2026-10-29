"""Onde ficam as coisas na versão instalável.

APP:  pasta do programa (ui, fontes, presets de fábrica, bin/ffmpeg). Pode ser só leitura.
DATA: dados da pessoa, sempre no PC dela: %LOCALAPPDATA%/LegendaPRO (ou LEGENDAPRO_DATA, ou
      APP/dados quando existe o arquivo APP/portatil.txt). Projetos, presets salvos, modelos baixados.
"""
import hashlib
import json
import os
import sys

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _data_dir():
    if os.environ.get("LEGENDAPRO_DATA"):
        return os.environ["LEGENDAPRO_DATA"]
    if os.path.exists(os.path.join(APP, "portatil.txt")):
        return os.path.join(APP, "dados")
    if sys.platform == "darwin":
        # Mac: o app fica em /Applications (só leitura); os dados, na pasta padrão de cada usuário
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "LegendaPRO")
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "LegendaPRO")


DATA = _data_dir()
UI_DIR = os.path.join(APP, "ui")
FONT_DIR = os.path.join(APP, "fonts")          # fontes de todos os presets vêm com o programa
USER_FONT_DIR = os.path.join(DATA, "fonts")    # fontes extras da pessoa (presets salvos com outra fonte)
FALLBACK_FONT = "Poppins-SemiBold.ttf"
FACTORY_PRESETS = os.path.join(APP, "presets")
PRESET_DIR = os.path.join(DATA, "presets")
PROJ_DIR = os.path.join(DATA, "projects")
MODEL_DIR = os.path.join(DATA, "models")
BIN_DIR = os.path.join(APP, "bin")

for _d in (DATA, PRESET_DIR, PROJ_DIR, MODEL_DIR, USER_FONT_DIR):
    os.makedirs(_d, exist_ok=True)

# ffmpeg/ffprobe que vêm com o programa têm prioridade sobre os do sistema
if os.path.isdir(BIN_DIR):
    os.environ["PATH"] = BIN_DIR + os.pathsep + os.environ.get("PATH", "")


def font_path(name):
    """Arquivo da fonte: a do programa, a da pasta de fontes da pessoa ou, se não existir em nenhuma
    (preset salvo em outro PC, por exemplo), a Poppins — a legenda sai com outra fonte, mas não quebra."""
    name = os.path.basename(name or "")
    for d in (FONT_DIR, USER_FONT_DIR):
        p = os.path.join(d, name)
        if name and os.path.isfile(p):
            return p
    return os.path.join(FONT_DIR, FALLBACK_FONT)


def _sha(p):
    return hashlib.sha1(open(p, "rb").read()).hexdigest()


def sync_presets():
    """Instala/atualiza os presets de fábrica na pasta de dados (chamado só no início do servidor e do cli,
    nunca na importação: o subprocesso do recorte também importa este módulo).

    O manifesto DATA/presets/.fabrica.json guarda o hash de cada preset de fábrica instalado:
    - preset novo de fábrica que ainda não existe na pasta: copia;
    - preset que estava no manifesto e sumiu da pasta: a pessoa apagou — não volta;
    - preset de fábrica que mudou nesta versão: só substitui se o arquivo da pessoa ainda é o que foi
      instalado (não pisa num preset editado à mão nem num preset salvo que tem o mesmo nome).
    As miniaturas se refazem sozinhas (comparam a data do JSON)."""
    if not os.path.isdir(FACTORY_PRESETS):
        return
    man_p = os.path.join(PRESET_DIR, ".fabrica.json")
    try:
        man = json.load(open(man_p, encoding="utf-8"))
    except (OSError, ValueError):
        man = {}
    for f in sorted(os.listdir(FACTORY_PRESETS)):
        if not f.endswith(".json"):
            continue
        src, dst = os.path.join(FACTORY_PRESETS, f), os.path.join(PRESET_DIR, f)
        new = _sha(src)
        if os.path.exists(dst):
            cur = _sha(dst)
            if cur == new:
                man[f] = new
                continue
            if man.get(f) != cur:
                continue        # editado ou salvo pela pessoa com o mesmo nome: fica o dela
        elif f in man:
            continue            # apagado pela pessoa
        tmp = dst + ".part"
        with open(src, "rb") as a, open(tmp, "wb") as b:
            b.write(a.read())
        os.replace(tmp, dst)
        man[f] = new
    tmp = man_p + ".part"
    json.dump(man, open(tmp, "w", encoding="utf-8"), indent=1)
    os.replace(tmp, man_p)


def factory_names():
    return {f[:-5] for f in os.listdir(FACTORY_PRESETS) if f.endswith(".json")} if os.path.isdir(FACTORY_PRESETS) else set()
