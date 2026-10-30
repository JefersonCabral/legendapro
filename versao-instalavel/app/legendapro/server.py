"""Servidor local do LegendaPRO (só biblioteca padrão).

    python -m legendapro.server            -> http://127.0.0.1:7860
"""
import copy
import hashlib
import json
import math
import mimetypes
import os
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import traceback
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np

from . import matte, presets, transcript, updater
from . import gpu
from .gpu import cuda_available
from .planner import Planner
from .render import ROOT, FONT_DIR, Renderer, probe, render_video, Cancelled

from .paths import UI_DIR, PROJ_DIR
PRESET_DIR = presets.PRESET_DIR

MODELS = ["large-v3-turbo", "large-v3", "medium", "small", "tiny"]

# ---------------------------------------------------------------- presets

def list_presets():
    return presets.load_all()


def load_preset(name):
    return presets.load(name)


safe_name = presets.safe_name


def deep_merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def list_fonts():
    from .paths import USER_FONT_DIR
    return sorted({f for d in (FONT_DIR, USER_FONT_DIR) if os.path.isdir(d)
                   for f in os.listdir(d) if f.lower().endswith((".ttf", ".otf"))})


# ---------------------------------------------------------------- projetos

def pdir(pid):
    if not re.fullmatch(r"[a-f0-9]{12}", pid or ""):
        raise KeyError(pid)
    d = os.path.join(PROJ_DIR, pid)
    if not os.path.isdir(d):
        raise KeyError(pid)
    return d


# No Windows, trocar o meta.json falha ("Acesso negado") se outra requisição o estiver lendo no mesmo
# instante — e a prévia ao vivo lê o tempo todo. Leitura e gravação passam pela mesma trava.
_meta_lock = threading.RLock()


def read_meta(pid):
    with _meta_lock, open(os.path.join(pdir(pid), "meta.json"), encoding="utf-8") as f:
        return json.load(f)


def write_meta(pid, meta):
    p = os.path.join(pdir(pid), "meta.json")
    with _meta_lock:
        tmp = f"{p}.{threading.get_ident()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=1)
        for k in range(20):   # antivírus/indexador do Windows às vezes segura o arquivo por um instante
            try:
                os.replace(tmp, p)
                return
            except PermissionError:
                if k == 19:
                    raise
                time.sleep(0.025)


def project_summary(pid):
    m = read_meta(pid)
    m["preset"] = presets.resolve_existing(m.get("preset"))
    d = pdir(pid)
    m["has_words"] = os.path.exists(os.path.join(d, "words.json"))
    m["exports"] = sorted(f for f in os.listdir(d) if (f.startswith("legendado") or f.startswith("legenda-alpha"))
                          and ".part" not in f)
    m["exports_info"] = {f: i for f, i in (m.get("exports_info") or {}).items() if f in m["exports"]}
    return m


def words_to_text(words):
    """Texto legível: uma frase por linha."""
    lines, cur = [], []
    for w in words:
        cur.append(w.text)
        if re.search(r"[.!?…]$", w.text):
            lines.append(" ".join(cur)); cur = []
    if cur:
        lines.append(" ".join(cur))
    return "\n".join(lines)


def project_style(pid):
    meta = read_meta(pid)
    base = load_preset(presets.resolve_existing(meta.get("preset")))
    return deep_merge(base, meta.get("overrides", {}))


_plan_cache = {}


def place_behind(plan, style, meta, d):
    """Trechos {atras} automáticos: posição e tamanho pela silhueta da pessoa (matte.place). Sem recorte
    ainda, usa um palpite (1/3 da altura, 1,4×) e refaz quando o recorte fica pronto (matte_v na chave)."""
    autos = {sc["behind"]["g"] for sc in plan["scenes"] if (sc.get("behind") or {}).get("auto")}
    if not autos:
        return
    res = matte.place(plan, style, meta["width"], meta["height"],
                      lambda t, w, h: matte.load(d, t, meta["fps"], w, h))
    lay = style["layout"]
    guess = {"dx": 0.0, "dy": round(0.32 - lay.get("anchor_y", 0.6) - lay.get("offset_y", 0.0), 3), "s": 1.4}
    first = {}
    for i, sc in enumerate(plan["scenes"]):
        b = sc.get("behind")
        if b and b.get("auto"):
            r = res.get(i, guess)
            b.update(r, placed=i in res)
            first.setdefault(b["g"], b)
            for l in sc["lines"]:
                for t in l["tokens"]:
                    t["size"] = round(t["size"] * r["s"], 5)
    # para a interface: o trecho mostra a posição da 1ª legenda dele (arrastar parte dela)
    for g in plan.get("groups", []):
        if g.get("auto") and g["g"] in first:
            b = first[g["g"]]
            g.update(dx=b["dx"], dy=b["dy"], s=b["s"], placed=b["placed"])


def norm_cuts(cuts, duration):
    """Trechos cortados do vídeo ([início, fim] em segundos do vídeo original): em ordem, sem sobreposição,
    dentro do vídeo, sem pedaços minúsculos. O vídeo original nunca é alterado; o corte vale na prévia e na
    exportação."""
    out = []
    for c in sorted((float(a), float(b)) for a, b in (cuts or []) if b is not None):
        a, b = max(0.0, min(c)), min(float(duration), max(c))
        if b - a < 0.02:
            continue
        if out and a <= out[-1][1] + 1e-3:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([round(a, 4), round(b, 4)])
    return out


def project_plan(pid):
    d = pdir(pid)
    raw = transcript.load(os.path.join(d, "words.json"))
    with _meta_lock, open(os.path.join(d, "text.txt"), encoding="utf-8") as f:   # nunca no meio de uma gravação
        text = f.read()
    style = project_style(pid)
    meta = read_meta(pid)
    # o recorte entra na chave: a posição automática do texto atrás depende dele
    cuts = norm_cuts(meta.get("cuts"), meta.get("duration", 0))
    key = hashlib.sha1((text + json.dumps(style, sort_keys=True) + str(os.path.getmtime(os.path.join(d, "words.json")))
                        + f"|m{meta.get('matte_v', 0)}|c{json.dumps(cuts)}").encode()).hexdigest()
    if key in _plan_cache:
        return key, style, _plan_cache[key]
    words = transcript.align_text(text, raw) if text.strip() else raw
    # palavras dentro de trechos cortados saem da legenda; os tokens continuam apontando (wi) para a posição
    # da palavra no texto inteiro, para o clique no vídeo achar a palavra certa
    keep = [i for i, w in enumerate(words) if not any(a <= (w.start + w.end) / 2 < b for a, b in cuts)]
    kept = [words[i] for i in keep]
    plan = Planner(style).plan(kept) if kept else {"preset": style["name"], "scenes": [], "flashes": []}
    if len(keep) != len(words):
        for sc in plan["scenes"]:
            for l in sc["lines"]:
                for t in l["tokens"]:
                    if 0 <= t.get("wi", -1) < len(keep):
                        t["wi"] = keep[t["wi"]]
    keepset = set(keep)
    # onde cada palavra está no text.txt (a interface edita o texto a partir do clique no preview)
    spans = transcript.parse_markup(text, spans=True)[1] if text.strip() else [None] * len(words)
    # palavras que viraram o destaque do estilo (herói / serifada de ênfase), para o botão "Destaque"
    hero = {t["wi"] for sc in plan["scenes"] for l in sc["lines"] for t in l["tokens"]
            if t.get("anim") == "hero" or (t["role"] == "serif" and sc["mode"] == "stack")}
    plan["words"] = [{"start": round(w.start, 3), "end": round(w.end, 3), "span": sp, "emph": i in hero,
                      # trecho {atras} da palavra (índice em plan["groups"]) ou None
                      "bg": next((int(f.split(":")[1]) for f in w.flags if f.startswith("behind:")), None),
                      "cut": i not in keepset}
                     for i, (w, sp) in enumerate(zip(words, spans))]
    plan["cuts"] = cuts
    plan["groups"] = transcript.behind_groups(text)
    place_behind(plan, style, meta, d)
    _plan_cache.clear()
    _plan_cache[key] = plan
    return key, style, plan


# ---------------------------------------------------------------- prévia ao vivo
# O navegador toca o vídeo original e desenha por cima a legenda, que o motor manda em camadas
# transparentes (só o recorte com texto, em PNG). Cada quadro tem uma assinatura que só muda quando
# muda o que aparece nele: depois de uma edição, a interface pede de novo apenas esses quadros.

LIVE_FPS = 30
_live = {}        # (pid, key) -> Renderer no tamanho da prévia, com transparência
_live_info = {}   # key -> assinaturas dos quadros
_vframes = {}     # (pid, t, w) -> quadro do vídeo (para a guarda de contraste)
_live_lock = threading.Lock()
_cache_lock = threading.Lock()   # _live_info e _vframes (várias threads da prévia ao mesmo tempo)
_live_pool = ThreadPoolExecutor(max(2, min(6, (os.cpu_count() or 4) - 1)))


def live_size(meta):
    w = min(540, meta["width"]) // 2 * 2
    return w, int(round(meta["height"] * w / meta["width"])) // 2 * 2


def live_info(key, style, plan, duration, mv=0):
    """Assinatura de cada quadro: estilo + cenas e clarões ativos nele. "0" = quadro vazio.
    mv = versão do recorte da pessoa: quando ele fica pronto, os quadros com texto atrás mudam."""
    with _cache_lock:
        if (key, mv) in _live_info:
            return _live_info[(key, mv)]
    n = int(math.ceil(duration * LIVE_FPS))
    act = [[] for _ in range(n)]
    for sc in plan["scenes"]:
        h = hashlib.sha1(json.dumps(sc, sort_keys=True, default=str).encode()).hexdigest()[:12]
        if sc.get("behind"):
            h += f"m{mv}"
        for i in range(max(0, math.ceil((sc["t_in"] - 1e-6) * LIVE_FPS)), min(n, math.floor((sc["t_out"] + 1.0) * LIVE_FPS) + 1)):
            act[i].append(h)
    D = style["effects"].get("flash", {}).get("duration", 0.4)
    for tf in plan.get("flashes", []):
        t0 = tf - D * 0.35
        for i in range(max(0, math.ceil(t0 * LIVE_FPS)), min(n, math.floor((t0 + D) * LIVE_FPS) + 1)):
            act[i].append(f"flash{tf:.3f}")
    sty = json.dumps(style, sort_keys=True, default=str)
    sig, segs = [], []
    for i in range(n):
        s = hashlib.sha1((sty + "|".join(act[i])).encode()).hexdigest()[:12] if act[i] else "0"
        sig.append(s)
        if segs and segs[-1][2] == s:
            segs[-1][1] = i
        else:
            segs.append([i, i, s])
    info = {"sig": sig, "segs": segs}
    with _cache_lock:
        while len(_live_info) > 8:
            _live_info.pop(next(iter(_live_info)))
        _live_info[(key, mv)] = info
    return info


def video_frame(pid, src, t, w, h):
    import cv2
    k = (pid, round(t, 3), w)
    with _cache_lock:
        f = _vframes.get(k)
    if f is None:
        meta = read_meta(pid)
        f = cv2.resize(grab_frame(src, t, meta["width"], meta["height"]), (w, h), interpolation=cv2.INTER_AREA)
        with _cache_lock:
            while len(_vframes) >= 48:
                _vframes.pop(next(iter(_vframes)))
            _vframes[k] = f
    return f


def live_renderer(pid, key, style, plan):
    with _live_lock:
        R = _live.get((pid, key))
        if R is None:
            meta = read_meta(pid)
            w, h = live_size(meta)
            R = Renderer(style, plan, w, h, alpha=True)
            src = os.path.join(pdir(pid), meta["file"])
            R.guard_bg = lambda t: video_frame(pid, src, t, w, h)
            R.matte = lambda t, d=pdir(pid), fps=meta["fps"]: matte.load(d, t, fps, w, h)
            if len(_live) > 3:
                _live.pop(next(iter(_live)))
            _live[(pid, key)] = R
        return R


def live_frame(R, i):
    """Camadas de um quadro: [(nome, x, y, w, h, png)] só com o recorte que tem desenho."""
    import cv2
    out = []
    for name, img in R.frame_layers(i / LIVE_FPS).items():
        x, y, w, h = cv2.boundingRect((img[..., 3] > 0).astype(np.uint8))
        if w == 0:
            continue
        crop = cv2.cvtColor(np.ascontiguousarray(img[y:y + h, x:x + w]), cv2.COLOR_RGBA2BGRA)
        if name == "person":   # recorte em meia resolução (o navegador amplia suave); ~4× mais leve
            crop = cv2.resize(crop, (max(1, w // 2), max(1, h // 2)), interpolation=cv2.INTER_AREA)
        out.append((name, x, y, w, h, cv2.imencode(".png", crop, [cv2.IMWRITE_PNG_COMPRESSION, 1])[1].tobytes()))
    return out


# vídeo que o navegador toca na prévia: o próprio arquivo ou, se ele não tocar no navegador, uma cópia leve
PLAYABLE = {"video": {"h264", "vp8", "vp9", "av1"}, "audio": {"aac", "mp3", "opus", "vorbis", "flac"}}


def video_source(pid, meta):
    if "playable" not in meta:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json",
                            os.path.join(pdir(pid), meta["file"])], capture_output=True, text=True)
        streams = json.loads(r.stdout or "{}").get("streams", [])
        playable = os.path.splitext(meta["file"])[1].lower() in (".mp4", ".m4v", ".mov", ".webm") and all(
            s.get("codec_name") in PLAYABLE[s["codec_type"]] for s in streams if s.get("codec_type") in PLAYABLE)
        with _meta_lock:
            m = read_meta(pid)
            m["playable"] = meta["playable"] = playable
            write_meta(pid, m)
    if meta["playable"]:
        return meta["file"]
    return "proxy.mp4" if os.path.exists(os.path.join(pdir(pid), "proxy.mp4")) else None


def grab_frame(path, t, W, H):
    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{max(0.0, t):.3f}", "-i", path, "-frames:v", "1",
                        "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
    if len(r.stdout) < W * H * 3:
        return np.zeros((H, W, 3), np.uint8)
    return np.frombuffer(r.stdout[:W * H * 3], np.uint8).reshape(H, W, 3)


def jpeg(arr, q=88, max_h=None):
    import cv2
    img = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    if max_h and img.shape[0] > max_h:
        k = max_h / img.shape[0]
        img = cv2.resize(img, (int(img.shape[1] * k), max_h), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()


# ---------------------------------------------------------------- miniaturas de preset

SAMPLE = [("Essa", .0), ("é", .25), ("a", .5), ("sua", .62), ("desculpa", .8), ("favorita.", 1.3)]


def preset_thumb(name):
    cache_dir = os.path.join(PRESET_DIR, "_thumbs")
    os.makedirs(cache_dir, exist_ok=True)
    name = presets.resolve(name)
    p = os.path.join(PRESET_DIR, name + ".json")
    out = os.path.join(cache_dir, name + ".jpg")
    if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(p):
        return open(out, "rb").read()
    style = load_preset(name)
    style = deep_merge(style, {"layout": {"anchor_y": 0.5}, "effects": {"flash": {"enabled": False}}})
    words = [transcript.Word(t, s, s + 0.22) for t, s in SAMPLE]
    words[4].flags.add("emph")
    plan = Planner(style).plan(words)
    W, H = 540, 960
    yy = np.linspace(0, 1, H)[:, None, None]
    ink = style["colors"]["text"].lstrip("#")
    if sum(int(ink[i:i + 2], 16) for i in (0, 2, 4)) < 3 * 110:   # texto escuro: miniatura em fundo claro
        bg = (np.array([246, 246, 246]) * (1 - yy) + np.array([228, 228, 228]) * yy).astype(np.uint8)
    else:
        bg = (np.array([34, 30, 28]) * (1 - yy) + np.array([12, 11, 10]) * yy).astype(np.uint8)
    bg = np.repeat(bg, W, axis=1)
    R = Renderer(style, plan, W, H)
    # no fim da frase de exemplo, mas antes de a última cena sair (presets que somem logo após a fala)
    t = min(1.9, max(sc["t_out"] for sc in plan["scenes"]) - 0.02) if plan["scenes"] else 1.9
    if any(a.get("duration") == "scene" for a in style["effects"].get("anim", {}).values()) and plan["scenes"]:
        t = max(sc["t_out"] for sc in plan["scenes"]) - 0.03   # destaque que desliza o bloco todo: já assentado
    img = R.frame(t, bg)
    # recorta perto do texto para a miniatura ficar legível
    import cv2
    ink = np.where((img.astype(int) - bg.astype(int)).max(axis=2) > 40)
    cy = int(np.median(ink[0])) if len(ink[0]) else H // 2
    cx = W // 2
    hh, hw = 190, 170
    if len(ink[1]):
        # destaques largos: abre o recorte até caber o texto inteiro (mantendo a proporção)
        need = max(cx - ink[1].min(), ink[1].max() - cx) + 14
        if need > hw:
            hh, hw = int(hh * need / hw), min(need, W // 2)
    img = img[max(0, cy - hh):cy + hh, max(0, cx - hw):cx + hw]
    img = cv2.resize(img, (340, 380), interpolation=cv2.INTER_AREA)
    data = jpeg(img, 90)
    open(out, "wb").write(data)
    return data


_anim_lock = threading.Lock()


def preset_anim(name):
    """Prévia animada do preset (a frase de exemplo entrando e saindo), mostrada ao passar o mouse
    na miniatura. MP4 pequeno em cache até o preset mudar; devolve o caminho do arquivo."""
    import cv2
    name = presets.resolve(name)
    cache_dir = os.path.join(PRESET_DIR, "_thumbs")
    os.makedirs(cache_dir, exist_ok=True)
    p = os.path.join(PRESET_DIR, name + ".json")
    out = os.path.join(cache_dir, name + ".mp4")
    with _anim_lock:
        if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(p):
            return out
        style = deep_merge(load_preset(name), {"layout": {"anchor_y": 0.5, "offset_x": 0, "offset_y": 0},
                                               "effects": {"flash": {"enabled": False}}})
        words = [transcript.Word(t, s, s + 0.22) for t, s in SAMPLE]
        words[4].flags.add("emph")
        plan = Planner(style).plan(words)
        W, H, fps = 540, 960, 24
        yy = np.linspace(0, 1, H)[:, None, None]
        ink = style["colors"]["text"].lstrip("#")
        if sum(int(ink[i:i + 2], 16) for i in (0, 2, 4)) < 3 * 110:
            bg = (np.array([246, 246, 246]) * (1 - yy) + np.array([228, 228, 228]) * yy).astype(np.uint8)
        else:
            bg = (np.array([34, 30, 28]) * (1 - yy) + np.array([12, 11, 10]) * yy).astype(np.uint8)
        bg = np.repeat(bg, W, axis=1)
        R = Renderer(style, plan, W, H)
        end = max((sc["t_out"] for sc in plan["scenes"]), default=2.0)
        frames = [R.frame(i / fps, bg) for i in range(int(min(end + 0.45, 4.5) * fps))]
        # recorte fixo que cabe o texto de todos os quadros, na proporção da miniatura (340 × 380)
        mask = np.zeros((H, W), bool)
        for f in frames:
            mask |= (f.astype(np.int16) - bg).max(axis=2) > 40
        ys, xs = np.where(mask)
        cy = (ys.min() + ys.max()) // 2 if len(ys) else H // 2
        cx = W // 2
        k = 1.0
        if len(xs):
            k = max(1.0, (max(cx - xs.min(), xs.max() - cx) + 14) / 170, ((ys.max() - ys.min()) / 2 + 24) / 190)
        hw, hh = min(int(170 * k), W // 2), min(int(190 * k), H // 2)
        y0 = max(0, min(H - 2 * hh, cy - hh))
        tmp = out + ".part.mp4"
        enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "340x380",
                                "-r", str(fps), "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24",
                                "-movflags", "+faststart", tmp], stdin=subprocess.PIPE)
        for f in frames:
            crop = np.ascontiguousarray(f[y0:y0 + 2 * hh, cx - hw:cx + hw])
            enc.stdin.write(cv2.resize(crop, (340, 380), interpolation=cv2.INTER_AREA).tobytes())
        enc.stdin.close()
        if enc.wait() != 0:
            raise RuntimeError("falha ao gerar a prévia animada do preset")
        os.replace(tmp, out)
        return out


# ---------------------------------------------------------------- prévia dos efeitos por preset

FX_MARKS = {"destaque": {"emph"}, "red": {"red"}, "circle": {"circle"}, "underline": {"underline"},
            "box": {"box"}, "solo": {"solo"}}


def preset_fx_icon(name, mark):
    """Ícone do botão de efeito desenhado pelo próprio motor do preset (a palavra "Aa" com o efeito,
    do jeito que vai sair no vídeo). Fica em cache até o preset mudar."""
    import cv2
    name = presets.resolve(name)
    cache_dir = os.path.join(PRESET_DIR, "_thumbs")
    os.makedirs(cache_dir, exist_ok=True)
    p = os.path.join(PRESET_DIR, name + ".json")
    out = os.path.join(cache_dir, f"fx_{name}_{mark}.png")
    if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(p):
        return open(out, "rb").read()
    style = deep_merge(load_preset(name), {"effects": {"flash": {"enabled": False}, "gradient": {"enabled": False}},
                                           "layout": {"anchor_y": 0.5, "plain_anchor_y": 0.5, "offset_x": 0, "offset_y": 0}})
    W, H = 540, 960
    ink = style["colors"]["text"].lstrip("#")
    light = sum(int(ink[i:i + 2], 16) for i in (0, 2, 4)) < 3 * 110
    g = 238 if light else 24
    bg = np.full((H, W, 3), g, np.uint8)
    # "a Aa": o motor clássico só monta a pilha (serifada de ênfase) com duas palavras ou mais;
    # o "a" de apoio vai na cor do fundo para não aparecer no ícone
    ws = [transcript.Word("a", 0.2, 0.35, {"color:#%02X%02X%02X" % (g, g, g)}),
          transcript.Word("Aa", 0.4, 1.1, set(FX_MARKS[mark]))]
    style["effects"]["shadow"] = dict(style["effects"].get("shadow", {}), opacity=0.0)
    plan = Planner(style).plan(ws)
    sc = next(sc for sc in plan["scenes"] if any(t["wi"] == 1 for ln in sc["lines"] for t in ln["tokens"]))
    t = min(sc["t_out"] - 0.03, 1.8)          # efeito já desenhado (elipse, traço, caixa) e palavra assentada
    R = Renderer(style, plan, W, H)
    img = R.frame(t, bg)
    hit = next((h for h in R.hits(t) if h["wi"] == 1), None)
    diff = np.abs(img.astype(int) - bg.astype(int)).max(axis=2) > 28
    if hit is not None:   # só a palavra do efeito, com folga para elipse, brilho e caixa
        hx0, hx1, hy0, hy1 = hit["x0"] * W, hit["x1"] * W, hit["y0"] * H, hit["y1"] * H
        mx, my = (hx1 - hx0) * 0.22 + 6, (hy1 - hy0) * 0.45 + 6
        box = np.zeros_like(diff)
        box[int(max(0, hy0 - my)):int(hy1 + my), int(max(0, hx0 - mx)):int(hx1 + mx)] = True
        diff &= box
    ys, xs = np.where(diff)
    if len(xs):
        pad = 6
        img = img[max(0, ys.min() - pad):ys.max() + pad, max(0, xs.min() - pad):xs.max() + pad]
    h = 34
    img = cv2.resize(img, (max(1, min(96, int(img.shape[1] * h / img.shape[0]))), h), interpolation=cv2.INTER_AREA)
    data = cv2.imencode(".png", cv2.cvtColor(img, cv2.COLOR_RGB2BGR))[1].tobytes()
    open(out, "wb").write(data)
    return data


# ---------------------------------------------------------------- jobs

JOBS = {}
GPU_LOCK = threading.Lock()


def new_job(kind, pid, fn):
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "kind": kind, "project": pid, "status": "running", "progress": 0.0,
           "message": "", "result": None, "error": None, "cancel": False, "started": time.time()}
    JOBS[jid] = job

    def run():
        try:
            job["result"] = fn(job)
            job["status"] = "done"
            job["progress"] = 1.0
        except Cancelled:
            job["status"] = "cancelled"
        except Exception as e:
            traceback.print_exc()
            job["status"] = "error"
            job["error"] = str(e)
    threading.Thread(target=run, daemon=True).start()
    return job


def job_public(j):
    return {k: v for k, v in j.items() if k != "cancel"}


def job_transcribe(pid, model):
    def fn(job):
        d = pdir(pid)
        meta = read_meta(pid)
        job["message"] = "Carregando o modelo de transcrição…"
        if not transcript.model_downloaded(model):
            job["message"] = "Baixando o modelo de transcrição (só na primeira vez)…"
            transcript.ensure_downloaded(model)      # fora da trava: o recorte pode usar a placa enquanto baixa
            job["message"] = "Carregando o modelo de transcrição…"
        with GPU_LOCK:
            m = transcript.get_model(model)
            job["message"] = ("Transcrevendo na placa de vídeo…" if getattr(m, "device_name", "") == "GPU"
                              else "Transcrevendo no chip Apple…" if getattr(m, "device_name", "") == "Apple"
                              else "Transcrevendo no processador…")

            def prog(f):
                job["progress"] = round(f, 3)
            words = transcript.transcribe(os.path.join(d, meta["file"]), model, meta.get("language", "pt"), prog)
        transcript.save_json(words, os.path.join(d, "words.json"))
        open(os.path.join(d, "text.txt"), "w", encoding="utf-8").write(words_to_text(words))
        with _meta_lock:   # relê: a transcrição demora e o meta pode ter mudado (exportações, recorte)
            meta = read_meta(pid)
            meta["status"] = "transcrito"
            meta["model"] = model
            write_meta(pid, meta)
        return {"words": len(words)}
    return new_job("transcribe", pid, fn)


def job_render(pid, kind, opts):
    def fn(job):
        d = pdir(pid)
        meta = read_meta(pid)
        key, style, plan = project_plan(pid)
        src = os.path.join(d, meta["file"])
        alpha = kind == "alpha"
        size = None
        if alpha:
            out = os.path.join(d, "legenda-alpha.mov")
        else:
            res = opts.get("resolution")
            if res and res != "original":
                h = int(res)
                size = (int(meta["width"] * h / meta["height"]) // 2 * 2, h)
            out = os.path.join(d, "legendado.mp4")
        if alpha:
            size = (meta["width"], meta["height"])
        tmp = out + f".{job['id']}.part" + os.path.splitext(out)[1]
        # texto atrás da pessoa: recorta antes o que faltar (só os trechos marcados)
        ensure_matte(pid, meta, plan, job)
        job["message"] = "Renderizando…"

        def prog(k, n):
            job["progress"] = round(k / max(n, 1), 3)
            job["message"] = f"{k}/{n} frames"
        has_back = any(sc.get("behind") for sc in plan["scenes"])
        try:
            render_video(style, plan, tmp, video=None if alpha else src, size=size,
                         fps=meta["fps"], duration=meta["duration"], alpha=alpha, cuts=plan.get("cuts"),
                         progress=prog, cancel=lambda: job["cancel"],
                         crf=int(opts.get("quality", 18)),
                         matte=(lambda t, W, H: matte.load(d, t, meta["fps"], W, H, cache=False)) if has_back else None)
            os.replace(tmp, out)
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        name = os.path.basename(out)
        # com que versão do texto/estilo foi exportado (a interface avisa quando ficou desatualizado)
        with _meta_lock:
            meta = read_meta(pid)
            w, h = size or (meta["width"], meta["height"])
            meta.setdefault("exports_info", {})[name] = {
                "key": key, "preset": presets.resolve_existing(meta.get("preset")), "time": time.time(), "width": w, "height": h,
                "quality": None if alpha else int(opts.get("quality", 18))}
            write_meta(pid, meta)
        return {"file": name, "key": key, "url": f"/files/{pid}/{name}?v={int(time.time())}"}
    return new_job(kind, pid, fn)


def matte_need(pid, meta, plan):
    """Faixas de quadros com texto atrás da pessoa que ainda não têm recorte."""
    nframes = int(round(meta["duration"] * meta["fps"]))
    return matte.missing(pdir(pid), matte.frame_ranges(plan, meta["fps"], nframes))


def ensure_matte(pid, meta, plan, job):
    """Recorta a pessoa nas faixas que faltam (GPU), mostrando o progresso no job."""
    need = matte_need(pid, meta, plan)
    if not need:
        return False
    if not matte.available():
        def dl(f):
            job["progress"] = round(f, 3)
            job["message"] = f"Recortando a pessoa… baixando o modelo (só na primeira vez) {int(f * 100)}%"
        job["message"] = "Recortando a pessoa… baixando o modelo (só na primeira vez)"
        try:
            matte.download(dl, cancel=lambda: job["cancel"])
        except InterruptedError:
            raise Cancelled()
    job["message"] = "Recortando a pessoa…"

    def prog(f):
        job["progress"] = round(f, 3)
        job["message"] = f"Recortando a pessoa… {int(f * 100)}%"
    try:
        with GPU_LOCK:
            # outro trabalho pode ter recortado enquanto este esperava a GPU: recalcula o que falta
            need = matte_need(pid, meta, plan)
            if not need:
                return False
            matte.run_worker(pdir(pid), os.path.join(pdir(pid), meta["file"]), meta["width"], meta["height"], meta["fps"],
                             need, prog, cancel=lambda: job["cancel"])
    except InterruptedError:
        raise Cancelled()
    with _meta_lock:
        m = read_meta(pid)
        m["matte_v"] = m.get("matte_v", 0) + 1
        write_meta(pid, m)
    return True


def job_matte(pid):
    def fn(job):
        meta = read_meta(pid)
        key, style, plan = project_plan(pid)
        ensure_matte(pid, meta, plan, job)
        return {"ok": True}
    return new_job("matte", pid, fn)


def job_proxy(pid):
    """Cópia leve (H.264 até 720p) para a prévia, quando o navegador não toca o vídeo original."""
    from .gpu import FAST, encoder_failed, fast_encoder_args

    def fn(job):
        d = pdir(pid)
        meta = read_meta(pid)
        job["message"] = "Preparando o vídeo para a prévia…"
        out, tmp = os.path.join(d, "proxy.mp4"), os.path.join(d, f"proxy.{job['id']}.part.mp4")

        def encode(venc):
            p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(d, meta["file"]), "-map", "0:v:0",
                                  "-map", "0:a:0?", "-vf", "scale=-2:'min(720,ih)'", *venc, "-c:a", "aac", "-b:a", "160k",
                                  "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", tmp],
                                 stdout=subprocess.PIPE, text=True)
            for line in p.stdout:
                v = line.strip().split("=")[-1]
                if line.startswith("out_time_us=") and v.isdigit():
                    job["progress"] = round(min(0.99, int(v) / 1e6 / max(meta["duration"], 0.1)), 3)
            return p.wait() == 0
        venc = fast_encoder_args()
        if not encode(venc):
            if venc[1] == "libx264":
                raise RuntimeError("não consegui preparar o vídeo para a prévia")
            encoder_failed()          # a placa falhou: refaz no processador
            if not encode(["-c:v", "libx264", *FAST["x264"]]):
                raise RuntimeError("não consegui preparar o vídeo para a prévia")
        os.replace(tmp, out)
        return {"file": "proxy.mp4"}
    return new_job("proxy", pid, fn)


def ensure_source(pid, meta):
    """Arquivo da prévia; se precisar da cópia leve, começa (ou acompanha) o trabalho que a gera."""
    src = video_source(pid, meta)
    job = None
    if src is None:
        job = next((j for j in JOBS.values() if j["project"] == pid and j["kind"] == "proxy" and j["status"] == "running"), None)
        job = job or job_proxy(pid)
    return src, job


# ---------------------------------------------------------------- HTTP

def allowed_origins():
    """Sites que podem usar o motor pelo navegador (além da própria interface local)."""
    from . import SITE_ORIGINS
    from .paths import DATA
    out = set(SITE_ORIGINS)
    out |= {o.strip().rstrip("/") for o in os.environ.get("LEGENDAPRO_ORIGINS", "").split(",") if o.strip()}
    try:
        out |= {l.strip().rstrip("/") for l in open(os.path.join(DATA, "origens.txt"), encoding="utf-8")
                if l.strip() and not l.startswith("#")}
    except OSError:
        pass
    return out


LOOPBACK = re.compile(r"(127\.0\.0\.1|localhost)(:\d+)?")


def origin_ok(origin):
    """Interface local (127.0.0.1/localhost, qualquer porta) ou um dos sites configurados."""
    from . import SITE_ORIGIN_SUFFIXES
    if not origin:
        return True
    u = urlparse(origin)
    if u.scheme == "http" and LOOPBACK.fullmatch(u.netloc):
        return True
    if origin in allowed_origins():
        return True
    # prévias de deploy (https://<hash>.legendapro.pages.dev): só o dono do projeto no Pages cria esses
    return u.scheme == "https" and any(u.netloc.endswith(s) for s in SITE_ORIGIN_SUFFIXES)


class Handler(BaseHTTPRequestHandler):
    server_version = "LegendaPRO/1.0"

    def log_message(self, fmt, *args):
        if "/api/jobs/" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    # segurança e CORS -------------------------------------------------
    # O motor só escuta em 127.0.0.1, mas qualquer página aberta no navegador consegue mandar pedidos
    # para lá. Por isso: (1) o Host precisa ser 127.0.0.1/localhost (barra "DNS rebinding", em que um
    # domínio de fora passa a apontar para 127.0.0.1); (2) pedido com Origin de outro site é recusado
    # (só a interface local e os sites configurados). As respostas para o site levam CORS.
    def end_headers(self):
        origin = self.headers.get("Origin")
        if origin and origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Disposition")
        super().end_headers()

    def guard(self):
        host = (self.headers.get("Host") or "").strip()
        if not LOOPBACK.fullmatch(host):
            self.send_json({"error": "endereço não permitido"}, 403)
            return False
        if not origin_ok(self.headers.get("Origin")):
            self.send_json({"error": "este site não pode usar o LegendaPRO"}, 403)
            return False
        return True

    def do_OPTIONS(self):
        """Preflight do navegador (PUT/DELETE, JSON, X-Filename) e da permissão de rede local do Chrome."""
        if not self.guard():
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", self.headers.get("Access-Control-Request-Headers")
                         or "Content-Type, X-Filename")
        if self.headers.get("Access-Control-Request-Private-Network"):
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # utilidades -------------------------------------------------------
    def send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, data, ctype, cache=False):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
        self.end_headers()
        self.wfile.write(data)

    def body_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def send_file(self, path, download_name=None):
        if not os.path.isfile(path):
            return self.send_json({"error": "arquivo não encontrado"}, 404)
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = size - int(m.group(2))
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        if download_name:
            self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                pass

    # roteamento -------------------------------------------------------
    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        if not self.guard():
            return
        u = urlparse(self.path)
        path, q = u.path, {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            for m, rx, fn in ROUTES:
                if m == method:
                    mm = re.fullmatch(rx, path)
                    if mm:
                        return fn(self, q, *mm.groups())
            if method == "GET":
                return self.static(path)
            self.send_json({"error": "rota não encontrada"}, 404)
        except KeyError:
            self.send_json({"error": "projeto não encontrado"}, 404)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass
        except Exception as e:
            traceback.print_exc()
            self.send_json({"error": str(e)}, 500)

    def static(self, path):
        if path == "/":
            path = "/index.html"
        if path.startswith("/fonts/"):
            full = os.path.normpath(os.path.join(FONT_DIR, unquote(path[7:])))
            base = FONT_DIR
            if not os.path.isfile(full):   # fonte extra da pessoa (pasta de dados)
                from .paths import USER_FONT_DIR
                full, base = os.path.normpath(os.path.join(USER_FONT_DIR, unquote(path[7:]))), USER_FONT_DIR
        else:
            full = os.path.normpath(os.path.join(UI_DIR, unquote(path.lstrip("/"))))
            base = UI_DIR
        if not full.startswith(os.path.normpath(base)) or not os.path.isfile(full):
            return self.send_json({"error": "não encontrado"}, 404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        self.send_bytes(open(full, "rb").read(), ctype, cache=path.startswith("/fonts/"))

    # API --------------------------------------------------------------
    def api_status(self, q):
        hw = gpu.summary()
        from . import API, VERSION
        self.send_json({"engine": "legendapro", "version": VERSION, "api": API,
                        "gpu": cuda_available(), "nvenc": hw["encoder_hw"], "hw": hw, "models": MODELS,
                        "default_model": transcript.DEFAULT_MODEL})

    def api_presets(self, q):
        self.send_json({"presets": list_presets(), "fonts": list_fonts(), "next_title": presets.next_title(),
                        "builtin": sorted(presets.BUILTIN)})

    def api_preset_save(self, q):
        b = self.body_json()
        data = b["data"]
        title = (b.get("name") or "").strip() or presets.next_title()
        name = safe_name(title)
        data["name"] = name
        data["title"] = title
        data["description"] = b.get("description") or ""
        data["tagline"] = (b.get("description") or "Estilo personalizado")[:40]
        p = os.path.join(PRESET_DIR, name + ".json")
        if os.path.exists(p) and not b.get("overwrite"):
            return self.send_json({"error": f"já existe um preset chamado '{name}'"}, 409)
        json.dump(data, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        self.send_json({"ok": True, "name": name})

    def api_preset_delete(self, q, name):
        name = presets.resolve(name)
        if name in presets.BUILTIN:
            return self.send_json({"error": "os presets de referência não podem ser apagados"}, 400)
        p = os.path.join(PRESET_DIR, name + ".json")
        if os.path.exists(p):
            os.remove(p)
        self.send_json({"ok": True})

    def api_preset_fx(self, q, name, mark):
        if mark not in FX_MARKS:
            return self.send_json({"error": "efeito desconhecido"}, 404)
        self.send_bytes(preset_fx_icon(unquote(name), mark), "image/png")

    def api_preset_thumb(self, q, name):
        self.send_bytes(preset_thumb(unquote(name)), "image/jpeg")

    def api_preset_anim(self, q, name):
        self.send_file(preset_anim(unquote(name)))

    def api_projects(self, q):
        items = []
        for pid in os.listdir(PROJ_DIR):
            try:
                items.append(project_summary(pid))
            except Exception:
                pass
        items.sort(key=lambda m: m.get("created", 0), reverse=True)
        self.send_json({"projects": items})

    def api_upload(self, q):
        name = unquote(self.headers.get("X-Filename", "video.mp4"))
        ext = os.path.splitext(name)[1].lower() or ".mp4"
        if ext not in (".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"):
            return self.send_json({"error": "formato não suportado"}, 400)
        pid = uuid.uuid4().hex[:12]
        d = os.path.join(PROJ_DIR, pid)
        os.makedirs(d)
        dst = os.path.join(d, "input" + ext)
        left = int(self.headers.get("Content-Length") or 0)
        with open(dst, "wb") as f:
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        try:
            W, H, fps, dur = probe(dst)
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            return self.send_json({"error": "não consegui ler esse vídeo"}, 400)
        thumb = jpeg(grab_frame(dst, min(1.0, dur / 2), W, H), 80, 480)
        open(os.path.join(d, "thumb.jpg"), "wb").write(thumb)
        meta = {"id": pid, "name": os.path.splitext(name)[0], "file": "input" + ext, "width": W, "height": H,
                "fps": fps, "duration": dur, "created": time.time(), "status": "novo",
                "preset": presets.resolve_existing(q.get("preset")), "overrides": {}, "language": "pt"}
        open(os.path.join(d, "meta.json"), "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False))
        ensure_source(pid, read_meta(pid))   # cópia leve para a prévia, se o navegador não tocar o original
        job = job_transcribe(pid, q.get("model") or transcript.DEFAULT_MODEL)
        self.send_json({"project": project_summary(pid), "job": job_public(job)})

    def api_project(self, q, pid):
        m = project_summary(pid)
        d = pdir(pid)
        tp = os.path.join(d, "text.txt")
        m["text"] = open(tp, encoding="utf-8").read() if os.path.exists(tp) else ""
        m["style"] = project_style(pid)
        running = [j for j in JOBS.values() if j["project"] == pid and j["status"] == "running"
                   and j["kind"] == "transcribe"]
        m["job"] = job_public(running[-1]) if running else None
        src, pj = ensure_source(pid, read_meta(pid))
        m["source"] = f"/files/{pid}/{src}" if src else None
        m["source_job"] = job_public(pj) if pj else None
        for f in os.listdir(d):   # sobras da antiga prévia em MP4
            if f.startswith("preview") and f.endswith(".mp4"):
                try:
                    os.remove(os.path.join(d, f))
                except OSError:
                    pass
        self.send_json(m)

    def api_project_delete(self, q, pid):
        d = pdir(pid)
        shutil.rmtree(d, ignore_errors=True)
        self.send_json({"ok": True})

    def api_project_update(self, q, pid):
        b = self.body_json()
        with _meta_lock:   # ler-alterar-gravar sem outra requisição no meio
            meta = read_meta(pid)
            if "text" in b:
                with open(os.path.join(pdir(pid), "text.txt"), "w", encoding="utf-8") as f:
                    f.write(b["text"])
            if "preset" in b:
                meta["preset"] = presets.resolve(b["preset"])
                if b.get("reset_overrides", True):
                    meta["overrides"] = {}
            if "overrides" in b:
                meta["overrides"] = b["overrides"]
            if "name" in b:
                meta["name"] = b["name"][:80]
            if "cuts" in b:
                meta["cuts"] = norm_cuts(b["cuts"], meta.get("duration", 0))
            if "splits" in b:      # divisões da lâmina (só marcam onde um clipe termina; não cortam nada)
                dur = meta.get("duration", 0)
                meta["splits"] = sorted({round(float(t), 4) for t in b["splits"] if 0 < float(t) < dur})
            write_meta(pid, meta)
        self.send_json({"ok": True, "style": project_style(pid)})

    def api_plan(self, q, pid):
        key, style, plan = project_plan(pid)
        meta = read_meta(pid)
        scenes = [{"t_in": s["t_in"], "t_out": s["t_out"], "mode": s["mode"],
                   "text": " / ".join(" ".join(t["text"] for t in l["tokens"]) for l in s["lines"]),
                   "red": any(t["color"].lower() == style["colors"]["red"].lower() for l in s["lines"] for t in l["tokens"]),
                   "decos": [d["kind"] for d in s.get("decos", [])],
                   "wi": sorted({t["wi"] for l in s["lines"] for t in l["tokens"] if t.get("wi") is not None}),
                   "behind": bool(s.get("behind"))}
                  for s in plan["scenes"]]
        w, h = live_size(meta)
        mv = meta.get("matte_v", 0)
        mjob = next((j for j in JOBS.values() if j["project"] == pid and j["kind"] in ("matte", "mp4", "alpha")
                     and j["status"] == "running" and j["message"].startswith("Recortando")), None)
        bl = style["effects"].get("blend", {})
        g = style["effects"].get("gradient", {})
        live = {"fps": LIVE_FPS, "w": w, "h": h, "segs": live_info(key, style, plan, meta["duration"], mv)["segs"],
                "blend": bl.get("mode", "difference") if bl.get("enabled") else None,
                # gradiente atrás da legenda: imagem única, pedida de novo só quando ele muda
                "bg": hashlib.sha1(json.dumps([g, w, h], sort_keys=True).encode()).hexdigest()[:12] if g.get("enabled") else None}
        # texto atrás da pessoa: quantos quadros ainda sem recorte, e o trabalho que está recortando
        live["matte"] = {"need": matte.count(matte_need(pid, meta, plan)), "v": mv, "model": bool(matte.providers()),
                         "job": job_public(mjob) if mjob else None}
        self.send_json({"key": key, "duration": meta["duration"], "scenes": scenes, "flashes": plan["flashes"],
                        "words": plan.get("words", []), "groups": plan.get("groups", []), "live": live,
                        "cuts": plan.get("cuts", []), "splits": meta.get("splits", [])})

    def api_matte(self, q, pid):
        """Começa (ou devolve) o recorte da pessoa dos trechos {atras} que ainda não têm."""
        j = next((j for j in JOBS.values() if j["project"] == pid and j["kind"] == "matte" and j["status"] == "running"), None)
        if j is None:
            if not matte.providers():
                return self.send_json({"error": "o recorte da pessoa não está disponível neste PC (ONNX Runtime)"}, 400)
            j = job_matte(pid)
        self.send_json(job_public(j))

    def api_hits(self, q, pid):
        key, style, plan = project_plan(pid)
        self.send_json({"key": key, "hits": live_renderer(pid, key, style, plan).hits(float(q.get("t", 0)))})

    def api_live_bg(self, q, pid):
        import cv2
        key, style, plan = project_plan(pid)
        img = live_renderer(pid, key, style, plan).gradient_layer()
        if img is None:
            return self.send_json({"error": "sem gradiente"}, 404)
        self.send_bytes(cv2.imencode(".png", cv2.cvtColor(img, cv2.COLOR_RGBA2BGRA))[1].tobytes(), "image/png")

    def api_live(self, q, pid):
        """Quadros da legenda para a prévia ao vivo. f = "a-b,c-d" (índices a 30 fps, até 120 por pedido).
        Resposta: [uint32 tamanho][JSON {key, frames:[{i, sig, l:[[camada,x,y,w,h,início,tamanho]]}]}][PNGs]"""
        meta = read_meta(pid)
        key, style, plan = project_plan(pid)
        info = live_info(key, style, plan, meta["duration"], meta.get("matte_v", 0))
        n = len(info["sig"])
        idx = []
        for part in (q.get("f") or "").split(","):
            a, _, b = part.partition("-")
            if a.isdigit():
                idx += range(int(a), min(n, int(b if b.isdigit() else a) + 1))
        idx = [i for i in dict.fromkeys(idx) if 0 <= i < n][:120]
        R = live_renderer(pid, key, style, plan)
        results = list(_live_pool.map(lambda i: (i, [] if info["sig"][i] == "0" else live_frame(R, i)), idx))
        frames, blobs, off = [], [], 0
        for i, layers in results:
            ls = []
            for name, x, y, w, h, png in layers:
                ls.append([name, x, y, w, h, off, len(png)])
                blobs.append(png)
                off += len(png)
            frames.append({"i": i, "sig": info["sig"][i], "l": ls})
        head = json.dumps({"key": key, "frames": frames}).encode()
        self.send_bytes(struct.pack("<I", len(head)) + head + b"".join(blobs), "application/octet-stream")

    def api_thumb(self, q, pid):
        self.send_file(os.path.join(pdir(pid), "thumb.jpg"))

    def api_transcribe(self, q, pid):
        b = self.body_json()
        self.send_json(job_public(job_transcribe(pid, b.get("model") or transcript.DEFAULT_MODEL)))

    def api_render(self, q, pid):
        b = self.body_json()
        kind = b.get("kind", "mp4")
        for j in JOBS.values():
            if j["project"] == pid and j["status"] == "running" and j["kind"] == kind:
                j["cancel"] = True
        self.send_json(job_public(job_render(pid, kind, b)))

    def api_reveal(self, q, pid):
        """Abre a pasta do projeto no Explorer, com o arquivo exportado selecionado."""
        d = pdir(pid)
        f = os.path.join(d, os.path.basename(self.body_json().get("file") or ""))
        if os.name == "nt":
            subprocess.Popen(["explorer", "/select," + f] if os.path.isfile(f) else ["explorer", d])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", f] if os.path.isfile(f) else ["open", d])   # Finder com o arquivo
        else:
            subprocess.Popen(["xdg-open", d])
        self.send_json({"ok": True})

    # atualização automática -----------------------------------------
    def api_update(self, q):
        self.send_json(updater.status())

    def api_update_check(self, q):
        threading.Thread(target=updater.check, daemon=True).start()
        time.sleep(0.2)
        self.send_json(updater.status())

    def api_update_settings(self, q):
        b = self.body_json()
        if "auto" in b:
            updater.save_settings(auto=bool(b["auto"]))
            if b["auto"]:
                updater.download()
        self.send_json(updater.status())

    def api_update_download(self, q):
        updater.download()
        self.send_json(updater.status())

    def api_update_install(self, q):
        busy = [j for j in JOBS.values() if j["status"] == "running"]
        if busy:
            return self.send_json({"error": "espere terminar o que está rodando (transcrição, recorte ou exportação)"}, 409)
        try:
            updater.install(self.server.server_address[1])
        except RuntimeError as e:
            return self.send_json({"error": str(e)}, 400)
        self.send_json({"ok": True, "version": updater.STATE["latest"]})
        updater.exit_soon()

    def api_job(self, q, jid):
        j = JOBS.get(jid)
        if not j:
            return self.send_json({"error": "job não encontrado"}, 404)
        self.send_json(job_public(j))

    def api_job_cancel(self, q, jid):
        j = JOBS.get(jid)
        if j:
            j["cancel"] = True
        self.send_json({"ok": True})

    def api_files(self, q, pid, name):
        name = os.path.basename(unquote(name))
        meta = read_meta(pid)
        dl = None
        if q.get("download"):
            dl = f"{meta['name']}-{name}"
        self.send_file(os.path.join(pdir(pid), name), dl)


ROUTES = [
    ("GET", r"/api/status", Handler.api_status),
    ("GET", r"/api/presets", Handler.api_presets),
    ("POST", r"/api/presets", Handler.api_preset_save),
    ("DELETE", r"/api/presets/([\w-]+)", Handler.api_preset_delete),
    ("GET", r"/api/presets/([\w%-]+)/thumb\.jpg", Handler.api_preset_thumb),
    ("GET", r"/api/presets/([\w%-]+)/fx/(\w+)\.png", Handler.api_preset_fx),
    ("GET", r"/api/presets/([\w%-]+)/anim\.mp4", Handler.api_preset_anim),
    ("POST", r"/api/projects/(\w+)/reveal", Handler.api_reveal),
    ("POST", r"/api/projects/(\w+)/matte", Handler.api_matte),
    ("GET", r"/api/projects", Handler.api_projects),
    ("POST", r"/api/upload", Handler.api_upload),
    ("GET", r"/api/projects/(\w+)", Handler.api_project),
    ("PUT", r"/api/projects/(\w+)", Handler.api_project_update),
    ("DELETE", r"/api/projects/(\w+)", Handler.api_project_delete),
    ("GET", r"/api/projects/(\w+)/plan", Handler.api_plan),
    ("GET", r"/api/projects/(\w+)/live", Handler.api_live),
    ("GET", r"/api/projects/(\w+)/live_bg\.png", Handler.api_live_bg),
    ("GET", r"/api/projects/(\w+)/hits", Handler.api_hits),
    ("GET", r"/api/projects/(\w+)/thumb\.jpg", Handler.api_thumb),
    ("POST", r"/api/projects/(\w+)/transcribe", Handler.api_transcribe),
    ("POST", r"/api/projects/(\w+)/render", Handler.api_render),
    ("GET", r"/api/update", Handler.api_update),
    ("POST", r"/api/update/check", Handler.api_update_check),
    ("PUT", r"/api/update", Handler.api_update_settings),
    ("POST", r"/api/update/download", Handler.api_update_download),
    ("POST", r"/api/update/install", Handler.api_update_install),
    ("GET", r"/api/jobs/(\w+)", Handler.api_job),
    ("POST", r"/api/jobs/(\w+)/cancel", Handler.api_job_cancel),
    ("GET", r"/files/(\w+)/([^/]+)", Handler.api_files),
]


class Server(ThreadingHTTPServer):
    # a prévia pede muitos quadros ao mesmo tempo; com a fila padrão (5), o Windows recusa conexões na hora
    # e a página no site acha que o motor foi fechado
    request_queue_size = 128
    daemon_threads = True


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7860)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    from .paths import DATA, sync_presets
    # versão nova já baixada e conferida: instala antes de abrir (nada rodando) e o ajudante reabre o programa
    if updater.install_at_startup():
        os._exit(0)
    updater.cleanup()
    sync_presets()
    # detecta placas/encoder antes de abrir a porta: assim o /api/status já responde na hora (o lançador
    # usa ele para saber se o LegendaPRO já está aberto)
    hw = gpu.summary()
    srv = Server(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}"
    print(f"\n  LegendaPRO rodando em {url}\n"
          f"  Placas: {', '.join(hw['gpus']) or 'nenhuma encontrada'} | Processador: {hw['cpu']}\n"
          f"  Transcrição: {hw['whisper']} | Exportação: {hw['encoder']} | Recorte: {hw['matte']}\n"
          f"  Seus projetos ficam em {DATA}\n"
          f"  (feche esta janela para sair)\n")
    if hw["cuda_pack"]["needed"]:
        print("  Placa NVIDIA encontrada: baixando a aceleração da transcrição em segundo plano (uma vez).\n")
        gpu.install_cuda_pack()
    updater.start_background_checks()
    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
