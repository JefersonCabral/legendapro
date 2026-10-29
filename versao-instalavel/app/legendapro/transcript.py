"""Entrada de transcrição: Whisper, JSON de palavras, SRT/VTT ou texto livre com marcações.

Marcações aceitas no texto (opcionais, o automático decide o resto):
  *palavra*     força ênfase (serifada itálica)
  !palavra!     força destaque vermelho
  ((palavra))   elipse desenhada em volta
  _palavra_     sublinhado em traço
  [palavra]     caixa vermelha atrás
  ~palavra      palavra solo com pop
  {#FFD60A}palavra  cor escolhida para a palavra
  {-}palavra    nunca vira destaque (tira o destaque automático)
  |             força quebra de cena
  "..."         trecho vira card de citação (presets com cards)
  {card} ... {/card}  idem, explícito
  {atras} ... {/atras}  texto atrás da pessoa (recorte do vídeo nesse trecho), posição automática
  {atras:dx,dy,escala}  idem, com posição própria (fração da largura/altura) e tamanho do trecho
"""
import json
import re
import unicodedata
from dataclasses import dataclass, field, asdict
from difflib import SequenceMatcher


@dataclass
class Word:
    text: str
    start: float
    end: float
    flags: set = field(default_factory=set)

    @property
    def norm(self):
        return normalize(self.text)

    def to_dict(self):
        d = asdict(self)
        d["flags"] = sorted(self.flags)
        return d


def normalize(s):
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "", s)


# ---------------------------------------------------------------- markup

_MARKS = [
    (re.compile(r"^\(\((.+)\)\)$"), "circle"),
    (re.compile(r"^\*(.+)\*$"), "emph"),
    (re.compile(r"^!(.+)!$"), "red"),
    (re.compile(r"^_(.+)_$"), "underline"),
    (re.compile(r"^\[(.+)\]$"), "box"),
    (re.compile(r"^~(.+)$"), "solo"),
]


_COLOR = re.compile(r"^\{(#[0-9a-fA-F]{6})\}(.+)$")
_NOEMPH = re.compile(r"^\{-\}(.+)$")
_TAG = r"\{/?card\}|\{atras(?::[^}\s]*)?\}|\{/atras\}"
_TOKEN = re.compile(_TAG + r"|[\"“”]|(?:(?!" + _TAG + r")[^\s\"“”])+")
_BEHIND = re.compile(r"\{atras(?::([^}\s]*))?\}")


def behind_params(arg):
    """'{atras:dx,dy,escala}' -> (dx, dy, escala); valores que faltam ficam no padrão (0, 0, 1)."""
    vals = [0.0, 0.0, 1.0]
    for k, v in enumerate((arg or "").split(",")[:3]):
        try:
            vals[k] = float(v)
        except ValueError:
            pass
    vals[2] = min(4.0, max(0.3, vals[2]))
    return tuple(vals)


def behind_groups(text):
    """Trechos {atras}…{/atras} do texto: [{g, dx, dy, s, open: (início, fim), close: (início, fim) | None}]."""
    out = []
    for mt in re.finditer(r"\{atras(?::[^}\s]*)?\}|\{/atras\}", text):
        if mt.group(0) == "{/atras}":
            if out and out[-1]["close"] is None:
                out[-1]["close"] = mt.span()
            continue
        if out and out[-1]["close"] is None:   # abriu outro sem fechar: o anterior termina aqui
            out[-1]["close"] = (mt.start(), mt.start())
        arg = _BEHIND.match(mt.group(0)).group(1)
        dx, dy, sc = behind_params(arg)
        out.append({"g": len(out), "dx": dx, "dy": dy, "s": sc, "auto": arg is None, "open": mt.span(), "close": None})
    return out


def parse_markup(text, spans=False):
    """Texto livre -> lista de (palavra, flags). Mantém pontuação colada na palavra.

    spans=True devolve também (início, fim) de cada palavra no texto original, para a
    interface localizar e editar a palavra clicada no preview."""
    out, pos, in_card, quote_open = [], [], False, False
    behind, ngroups = None, 0   # trecho {atras} aberto: flags que as palavras dele recebem
    for mt in _TOKEN.finditer(text):
        raw = mt.group(0)
        if raw == "{card}":
            in_card = True; continue
        if raw == "{/card}":
            in_card = False; continue
        mb = _BEHIND.fullmatch(raw)
        if mb or raw == "{/atras}":
            # as bordas do trecho viram quebra de legenda: uma cena nunca fica meio atrás, meio na frente
            if out:
                out[-1][1].add("break")
            behind = None
            if mb:
                if mb.group(1) is None:   # {atras} sem números: posição automática (pela silhueta da pessoa)
                    behind = {"behind", f"behind:{ngroups}:auto"}
                else:
                    dx, dy, sc = behind_params(mb.group(1))
                    behind = {"behind", f"behind:{ngroups}:{dx:g}:{dy:g}:{sc:g}"}
                ngroups += 1
            continue
        if raw in "\"“”":
            quote_open = not quote_open; continue
        if raw == "|":
            if out:
                out[-1][1].add("break")
            continue
        flags = set()
        # pontuação externa às marcas (ex.: *tempo*.)
        if raw.startswith("!") and raw.count("!") >= 2:
            # !palavra! não pode ter o "!" final confundido com pontuação
            m = re.match(r"^!(.+?)!([.,?;:…]*)$", raw)
            if m:
                raw = m.group(1) + m.group(2)
                flags.add("red")
        m = re.match(r"^(.*?)([.,!?;:…]*)$", raw)
        core, tail = m.group(1), m.group(2)
        changed = True
        while changed and core:
            changed = False
            for rx, flag in _MARKS:
                mm = rx.match(core)
                if mm:
                    core = mm.group(1); flags.add(flag); changed = True
            mm = _COLOR.match(core)
            if mm:
                flags = {f for f in flags if not f.startswith("color:")}
                flags.add("color:" + mm.group(1).upper())
                core = mm.group(2); changed = True
            mm = _NOEMPH.match(core)
            if mm:
                flags.add("noemph"); flags.discard("emph")
                core = mm.group(1); changed = True
        # marca com pontuação dentro (ex.: *tempo.*)
        if not core:
            continue
        if in_card or quote_open:
            flags.add("card")
        if behind:
            flags |= behind
        out.append([core + tail, flags])
        pos.append(mt.span())
    if spans:
        return [(w, f) for w, f in out], pos
    return [(w, f) for w, f in out]


def word_color(w):
    """Cor escolhida pelo usuário ({#RRGGBB}palavra), ou None."""
    return next((f[6:] for f in w.flags if f.startswith("color:")), None)


# ---------------------------------------------------------------- loaders

def from_json(path):
    data = json.load(open(path, encoding="utf-8"))
    items = data["words"] if isinstance(data, dict) else data
    words = []
    for it in items:
        txt = it.get("text") or it.get("word") or ""
        txt = txt.strip()
        if not txt:
            continue
        pw = parse_markup(txt)
        flags = set(it.get("flags", []))
        for t, f in pw:
            words.append(Word(t, float(it["start"]), float(it["end"]), flags | f))
    return words


def _ts(s):
    s = s.strip().replace(",", ".")
    parts = s.split(":")
    v = 0.0
    for p in parts:
        v = v * 60 + float(p)
    return v


def from_srt(path):
    raw = open(path, encoding="utf-8-sig").read()
    blocks = re.split(r"\n\s*\n", raw.strip())
    words = []
    for b in blocks:
        lines = [l for l in b.strip().splitlines() if l.strip()]
        tl = next((i for i, l in enumerate(lines) if "-->" in l), None)
        if tl is None:
            continue
        a, b2 = lines[tl].split("-->")
        t0, t1 = _ts(a), _ts(b2.split()[0])
        text = " ".join(lines[tl + 1:])
        text = re.sub(r"<[^>]+>", "", text)
        pw = parse_markup(text)
        if not pw:
            continue
        # distribui o tempo pelo tamanho das palavras
        weights = [max(len(normalize(w)), 1) + 1.5 for w, _ in pw]
        tot = sum(weights)
        t = t0
        for (w, f), wt in zip(pw, weights):
            d = (t1 - t0) * wt / tot
            words.append(Word(w, t, t + d, f))
            t += d
    return words


_MODELS = {}
DEFAULT_MODEL = "large-v3-turbo"


def ensure_downloaded(name):
    """Baixa o modelo (uma vez) para a pasta de dados da pessoa e devolve a pasta dele. Fica separado da
    carga na placa: falta de internet não pode ser confundida com falha da CUDA, e o servidor baixa fora
    da trava da GPU (o download do large-v3-turbo tem ~1,6 GB)."""
    import os
    from faster_whisper.utils import download_model
    from .paths import MODEL_DIR
    try:
        return download_model(name, cache_dir=os.path.join(MODEL_DIR, "whisper"))
    except Exception as e:
        raise RuntimeError(f"não consegui baixar o modelo de transcrição (sem internet?): {e}") from e


def _whisper(name, device):
    import os
    from faster_whisper import WhisperModel
    path = ensure_downloaded(name)
    if device == "cuda":
        m = WhisperModel(path, device="cuda", compute_type="int8_float16")
        m.device_name = "GPU"
    else:
        # todos os núcleos (Intel ou AMD); int8 é o mais rápido no processador
        m = WhisperModel(path, device="cpu", compute_type="int8", cpu_threads=max(1, (os.cpu_count() or 4)))
        m.device_name = "CPU"
    return m


def model_downloaded(name):
    import glob
    import os
    from .paths import MODEL_DIR
    return bool(glob.glob(os.path.join(MODEL_DIR, "whisper", f"models--*faster-whisper-{name}", "snapshots", "*", "model.bin")))


def get_model(name=DEFAULT_MODEL):
    """Carrega (uma vez) o Whisper; usa a GPU NVIDIA quando houver, senão o processador.
    A chave inclui o dispositivo: se a aceleração NVIDIA terminar de baixar, o próximo uso já vai para a GPU."""
    from .gpu import cuda_available, disable_cuda
    dev = "cuda" if cuda_available() else "cpu"
    if (name, dev) in _MODELS:
        return _MODELS[(name, dev)]
    m = None
    if dev == "cuda":
        ensure_downloaded(name)          # erro de download sobe como está (não é culpa da placa)
        try:
            m = _whisper(name, "cuda")
        except Exception:
            disable_cuda()               # placa sem memória / DLL faltando: não tenta de novo nesta sessão
            dev, m = "cpu", _MODELS.get((name, "cpu"))
    if m is None:
        m = _whisper(name, "cpu")
    _MODELS[(name, dev)] = m
    return m


def transcribe(media, model=DEFAULT_MODEL, language="pt", progress=None):
    """progress(fração 0..1) é chamado conforme os trechos são reconhecidos."""
    m = get_model(model)
    try:
        segs, info = m.transcribe(media, language=language, word_timestamps=True, vad_filter=True)
        words = []
        for s in segs:
            for w in s.words:
                t = w.word.strip()
                if t:
                    words.append(Word(t, float(w.start), float(w.end)))
            if progress and info.duration:
                progress(min(1.0, s.end / info.duration))
    except RuntimeError:
        if getattr(m, "device_name", "") != "GPU":
            raise
        # falha de CUDA em tempo de execução: refaz na CPU
        from .gpu import disable_cuda
        disable_cuda()                      # não tenta a GPU de novo nesta sessão
        _MODELS.pop((model, "cuda"), None)
        return transcribe(media, model, language, progress)
    return words


def align_text(text, timed):
    """Usa o texto do usuário (grafia + marcações) e os tempos do Whisper."""
    user = parse_markup(text)
    a = [normalize(w) for w, _ in user]
    b = [w.norm for w in timed]
    sm = SequenceMatcher(None, a, b, autojunk=False)
    times = [None] * len(user)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                times[i1 + k] = (timed[j1 + k].start, timed[j1 + k].end)
        elif tag == "replace" and j2 > j1:
            t0, t1 = timed[j1].start, timed[j2 - 1].end
            n = i2 - i1
            for k in range(n):
                times[i1 + k] = (t0 + (t1 - t0) * k / n, t0 + (t1 - t0) * (k + 1) / n)
    # interpola o que sobrou
    for i in range(len(times)):
        if times[i] is None:
            prev = next((times[j][1] for j in range(i - 1, -1, -1) if times[j]), 0.0)
            nxt_i = next((j for j in range(i + 1, len(times)) if times[j]), None)
            nxt = times[nxt_i][0] if nxt_i is not None else prev + 0.4 * (len(times) - i)
            span = [j for j in range(i, nxt_i if nxt_i is not None else len(times))]
            n = len(span)
            for k, j in enumerate(span):
                times[j] = (prev + (nxt - prev) * k / n, prev + (nxt - prev) * (k + 1) / n)
    return [Word(w, t[0], t[1], f) for (w, f), t in zip(user, times)]


def load(source=None, media=None, model=DEFAULT_MODEL):
    """source: .json/.srt/.vtt/.txt ou None (transcreve media)."""
    if source is None:
        return transcribe(media, model)
    low = source.lower()
    if low.endswith(".json"):
        return from_json(source)
    if low.endswith(".srt") or low.endswith(".vtt"):
        return from_srt(source)
    text = open(source, encoding="utf-8").read()
    if media is None:
        raise SystemExit("Texto puro precisa do vídeo para sincronizar (--video).")
    return align_text(text, transcribe(media, model))


def save_json(words, path):
    json.dump({"words": [w.to_dict() for w in words]}, open(path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
