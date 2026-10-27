"""Servidor local do LegendaPRO (só biblioteca padrão).

    python -m legendapro.server            -> http://127.0.0.1:7860
"""
import copy
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np

from . import presets, transcript
from .gpu import cuda_available, nvenc_available
from .planner import Planner
from .render import ROOT, FONT_DIR, Renderer, probe, render_video, Cancelled

UI_DIR = os.path.join(ROOT, "ui")
PRESET_DIR = presets.PRESET_DIR
PROJ_DIR = os.path.join(ROOT, "projects")
os.makedirs(PROJ_DIR, exist_ok=True)

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
    return sorted(f for f in os.listdir(FONT_DIR) if f.lower().endswith((".ttf", ".otf")))


# ---------------------------------------------------------------- projetos

def pdir(pid):
    if not re.fullmatch(r"[a-f0-9]{12}", pid or ""):
        raise KeyError(pid)
    d = os.path.join(PROJ_DIR, pid)
    if not os.path.isdir(d):
        raise KeyError(pid)
    return d


def read_meta(pid):
    return json.load(open(os.path.join(pdir(pid), "meta.json"), encoding="utf-8"))


def write_meta(pid, meta):
    p = os.path.join(pdir(pid), "meta.json")
    tmp = p + ".tmp"
    json.dump(meta, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def project_summary(pid):
    m = read_meta(pid)
    m["preset"] = presets.resolve(m.get("preset"))
    d = pdir(pid)
    m["has_words"] = os.path.exists(os.path.join(d, "words.json"))
    m["exports"] = sorted(f for f in os.listdir(d) if f.startswith("legendado") or f.startswith("legenda-alpha"))
    pv = m.get("preview") or {}
    m["has_preview"] = bool(pv.get("file")) and os.path.exists(os.path.join(d, pv["file"]))
    if not m["has_preview"]:
        m.pop("preview", None)
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
    base = load_preset(meta.get("preset", presets.DEFAULT))
    return deep_merge(base, meta.get("overrides", {}))


_plan_cache = {}


def project_plan(pid):
    d = pdir(pid)
    raw = transcript.load(os.path.join(d, "words.json"))
    text = open(os.path.join(d, "text.txt"), encoding="utf-8").read()
    style = project_style(pid)
    key = hashlib.sha1((text + json.dumps(style, sort_keys=True) +
                        str(os.path.getmtime(os.path.join(d, "words.json")))).encode()).hexdigest()
    if key in _plan_cache:
        return key, style, _plan_cache[key]
    words = transcript.align_text(text, raw) if text.strip() else raw
    plan = Planner(style).plan(words) if words else {"preset": style["name"], "scenes": [], "flashes": []}
    # onde cada palavra está no text.txt (a interface edita o texto a partir do clique no preview)
    spans = transcript.parse_markup(text, spans=True)[1] if text.strip() else [None] * len(words)
    # palavras que viraram o destaque do estilo (herói / serifada de ênfase), para o botão "Destaque"
    hero = {t["wi"] for sc in plan["scenes"] for l in sc["lines"] for t in l["tokens"]
            if t.get("anim") == "hero" or (t["role"] == "serif" and sc["mode"] == "stack")}
    plan["words"] = [{"start": round(w.start, 3), "end": round(w.end, 3), "span": sp, "emph": i in hero}
                     for i, (w, sp) in enumerate(zip(words, spans))]
    _plan_cache.clear()
    _plan_cache[key] = plan
    return key, style, plan


_renderers = {}


def renderer_for(pid, key, style, plan):
    meta = read_meta(pid)
    rk = (pid, key)
    if rk not in _renderers:
        _renderers.clear()
        _renderers[rk] = Renderer(style, plan, meta["width"], meta["height"])
    return _renderers[rk]


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
    img = R.frame(1.9, bg)
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
        with GPU_LOCK:
            m = transcript.get_model(model)
            job["message"] = f"Transcrevendo ({'GPU' if getattr(m, 'device_name', '') == 'GPU' else 'CPU'})…"

            def prog(f):
                job["progress"] = round(f, 3)
            words = transcript.transcribe(os.path.join(d, meta["file"]), model, meta.get("language", "pt"), prog)
        transcript.save_json(words, os.path.join(d, "words.json"))
        open(os.path.join(d, "text.txt"), "w", encoding="utf-8").write(words_to_text(words))
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
        if kind == "preview":
            # leve, para refazer sozinha a cada alteração; nome novo a cada vez para não
            # sobrescrever o arquivo que o navegador ainda pode estar tocando
            h = min(720, meta["height"])
            size = (int(meta["width"] * h / meta["height"]) // 2 * 2, h)
            out = os.path.join(d, f"preview-{job['id']}.mp4")
        elif alpha:
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
        job["message"] = "Renderizando prévia…" if kind == "preview" else "Renderizando…"

        def prog(k, n):
            job["progress"] = round(k / max(n, 1), 3)
            job["message"] = f"{k}/{n} frames"
        try:
            render_video(style, plan, tmp, video=None if alpha else src, size=size,
                         fps=meta["fps"], duration=meta["duration"], alpha=alpha,
                         progress=prog, cancel=lambda: job["cancel"],
                         crf=23 if kind == "preview" else int(opts.get("quality", 18)))
            os.replace(tmp, out)
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
        name = os.path.basename(out)
        if kind == "preview":
            meta = read_meta(pid)
            meta["preview"] = {"file": name, "key": key}
            write_meta(pid, meta)
            for f in os.listdir(d):   # prévias antigas (pode falhar se o navegador ainda segura o arquivo)
                if f.startswith("preview") and f.endswith(".mp4") and ".part" not in f and f != name:
                    try:
                        os.remove(os.path.join(d, f))
                    except OSError:
                        pass
        return {"file": name, "key": key, "url": f"/files/{pid}/{name}?v={int(time.time())}"}
    return new_job(kind, pid, fn)


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "LegendaPRO/1.0"

    def log_message(self, fmt, *args):
        if "/api/jobs/" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

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
        self.send_json({"gpu": cuda_available(), "nvenc": nvenc_available(), "models": MODELS,
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
        if b.get("description"):
            data["description"] = b["description"]
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

    def api_preset_thumb(self, q, name):
        self.send_bytes(preset_thumb(unquote(name)), "image/jpeg")

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
                "preset": presets.resolve(q.get("preset")), "overrides": {}, "language": "pt"}
        open(os.path.join(d, "meta.json"), "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False))
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
        self.send_json(m)

    def api_project_delete(self, q, pid):
        d = pdir(pid)
        shutil.rmtree(d, ignore_errors=True)
        self.send_json({"ok": True})

    def api_project_update(self, q, pid):
        b = self.body_json()
        meta = read_meta(pid)
        if "text" in b:
            open(os.path.join(pdir(pid), "text.txt"), "w", encoding="utf-8").write(b["text"])
        if "preset" in b:
            meta["preset"] = presets.resolve(b["preset"])
            if b.get("reset_overrides", True):
                meta["overrides"] = {}
        if "overrides" in b:
            meta["overrides"] = b["overrides"]
        if "name" in b:
            meta["name"] = b["name"][:80]
        write_meta(pid, meta)
        self.send_json({"ok": True, "style": project_style(pid)})

    def api_plan(self, q, pid):
        key, style, plan = project_plan(pid)
        meta = read_meta(pid)
        scenes = [{"t_in": s["t_in"], "t_out": s["t_out"], "mode": s["mode"],
                   "text": " / ".join(" ".join(t["text"] for t in l["tokens"]) for l in s["lines"]),
                   "red": any(t["color"].lower() == style["colors"]["red"].lower() for l in s["lines"] for t in l["tokens"]),
                   "decos": [d["kind"] for d in s.get("decos", [])]}
                  for s in plan["scenes"]]
        self.send_json({"key": key, "duration": meta["duration"], "scenes": scenes, "flashes": plan["flashes"],
                        "words": plan.get("words", [])})

    def api_hits(self, q, pid):
        key, style, plan = project_plan(pid)
        self.send_json({"key": key, "hits": renderer_for(pid, key, style, plan).hits(float(q.get("t", 0)))})

    def api_frame(self, q, pid):
        meta = read_meta(pid)
        t = float(q.get("t", 0))
        base = grab_frame(os.path.join(pdir(pid), meta["file"]), t, meta["width"], meta["height"])
        if os.path.exists(os.path.join(pdir(pid), "words.json")):
            key, style, plan = project_plan(pid)
            img = renderer_for(pid, key, style, plan).frame(t, base)
        else:
            img = base
        self.send_bytes(jpeg(img, 86, int(q.get("h", 1280))), "image/jpeg")

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
    ("GET", r"/api/projects", Handler.api_projects),
    ("POST", r"/api/upload", Handler.api_upload),
    ("GET", r"/api/projects/(\w+)", Handler.api_project),
    ("PUT", r"/api/projects/(\w+)", Handler.api_project_update),
    ("DELETE", r"/api/projects/(\w+)", Handler.api_project_delete),
    ("GET", r"/api/projects/(\w+)/plan", Handler.api_plan),
    ("GET", r"/api/projects/(\w+)/frame\.jpg", Handler.api_frame),
    ("GET", r"/api/projects/(\w+)/hits", Handler.api_hits),
    ("GET", r"/api/projects/(\w+)/thumb\.jpg", Handler.api_thumb),
    ("POST", r"/api/projects/(\w+)/transcribe", Handler.api_transcribe),
    ("POST", r"/api/projects/(\w+)/render", Handler.api_render),
    ("GET", r"/api/jobs/(\w+)", Handler.api_job),
    ("POST", r"/api/jobs/(\w+)/cancel", Handler.api_job_cancel),
    ("GET", r"/files/(\w+)/([^/]+)", Handler.api_files),
]


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7860)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}"
    print(f"\n  LegendaPRO rodando em {url}\n  GPU: {'sim' if cuda_available() else 'não'} | NVENC: {'sim' if nvenc_available() else 'não'}\n  (Ctrl+C para sair)\n")
    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
