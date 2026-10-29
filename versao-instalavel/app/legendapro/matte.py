"""Recorte da pessoa para o texto atrás dela, com Robust Video Matting (RVM).

Versão instalável: o modelo é o ONNX oficial do RVM (rvm_resnet50_fp32.onnx, licença GPL-3.0), baixado uma
vez para a pasta de dados, e roda no ONNX Runtime com DirectML — qualquer placa no Windows (NVIDIA, AMD,
Intel) — ou no processador.
O recorte é feito só nos trechos {atras}, uma vez, e guardado em projects/<id>/matte/<quadro>.png
(tons de cinza, resolução do vídeo, quadro = índice no fps do vídeo). O RVM é recorrente: cada
trecho começa um pouco antes (WARMUP) para o recorte já entrar estável.
"""
import math
import os
import queue
import subprocess
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import cv2
import numpy as np

from .paths import APP as ROOT, MODEL_DIR

MODEL = os.path.join(MODEL_DIR, "rvm_resnet50_fp32.onnx")
MODEL_URL = "https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_resnet50_fp32.onnx"
MODEL_SIZE = 107479165
WARMUP = 0.4        # segundos processados antes de cada trecho (descartados)
TAIL = 1.05         # a cena ainda é desenhada até 1 s depois do fim (saídas animadas)

_model, _dev = None, None
_model_lock = threading.Lock()
_cache = OrderedDict()          # (pasta, quadro, w, h) -> recorte float32
_cache_lock = threading.Lock()


def available():
    return os.path.exists(MODEL) and os.path.getsize(MODEL) == MODEL_SIZE


_dl_lock = threading.Lock()


def download(progress=None, cancel=None):
    """Baixa o modelo (~107 MB) na primeira vez que a pessoa usa o texto atrás. Com trava: o recorte e a
    exportação podem pedir ao mesmo tempo; o segundo espera e encontra o modelo pronto."""
    with _dl_lock:
        if not available():
            _download(progress, cancel)


def _download(progress, cancel):
    import urllib.request
    tmp = f"{MODEL}.{os.getpid()}.part"
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=60) as r, open(tmp, "wb") as out:
            got = 0
            while True:
                if cancel and cancel():
                    raise InterruptedError()
                buf = r.read(1 << 20)
                if not buf:
                    break
                out.write(buf)
                got += len(buf)
                if progress:
                    progress(got / MODEL_SIZE)
        if os.path.getsize(tmp) != MODEL_SIZE:
            raise RuntimeError("o download do modelo de recorte veio incompleto")
        os.replace(tmp, MODEL)
    except InterruptedError:      # cancelado (é subclasse de OSError: precisa vir antes)
        raise
    except (OSError, ValueError) as e:
        raise RuntimeError(f"não consegui baixar o modelo de recorte (sem internet?): {e}") from e
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def providers():
    """DirectML (qualquer placa no Windows) > CoreML (Mac) > CUDA > processador, conforme o ONNX Runtime
    instalado. LEGENDAPRO_FORCE_CPU=1: só o processador."""
    try:
        import onnxruntime as ort
        have = ort.get_available_providers()
    except Exception:
        return []
    if os.environ.get("LEGENDAPRO_FORCE_CPU") == "1":
        return ["CPUExecutionProvider"] if "CPUExecutionProvider" in have else []
    return [p for p in ("DmlExecutionProvider", "CoreMLExecutionProvider", "CUDAExecutionProvider",
                        "CPUExecutionProvider") if p in have]


def provider_label():
    p = (providers() or ["?"])[0]
    if p == "CoreMLExecutionProvider":
        import platform
        return "chip Apple (CoreML)" if platform.machine() == "arm64" else "CoreML"
    return {"DmlExecutionProvider": "placa de vídeo (DirectML)", "CoreMLExecutionProvider": "chip Apple (CoreML)",
            "CUDAExecutionProvider": "GPU NVIDIA (CUDA)", "CPUExecutionProvider": "processador"}.get(p, "indisponível")


def get_model(cpu=False):
    """Sessão do RVM. O DirectML sem device_id já escolhe a placa de alto desempenho (em notebook com
    Intel + NVIDIA, a NVIDIA: medido ~9 q/s contra ~1,6 q/s no adaptador 0, a Intel).
    cpu=True: troca para o processador (a placa falhou no meio do recorte)."""
    global _model, _dev
    with _model_lock:
        if _model is None or (cpu and _dev != "CPUExecutionProvider"):
            import onnxruntime as ort
            so = ort.SessionOptions()
            # o DirectML pede execução sequencial e sem "memory pattern" (formas de entrada variam)
            so.enable_mem_pattern = False
            so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
            prov = ["CPUExecutionProvider"] if cpu else providers()
            try:
                # fp32: em fp16 o modelo dá NaN na GTX 1650
                _model = ort.InferenceSession(MODEL, so, providers=prov)
            except Exception:
                _model = ort.InferenceSession(MODEL, so, providers=["CPUExecutionProvider"])
            _dev = _model.get_providers()[0]
        return _model, _dev


def frame_ranges(plan, fps, nframes):
    """Quadros (no fps do vídeo) em que alguma cena atrás da pessoa é desenhada, em faixas [a, b]."""
    rs = []
    for sc in plan["scenes"]:
        if sc.get("behind"):
            a = max(0, math.floor((sc["t_in"] - 0.05) * fps))
            b = min(nframes - 1, math.ceil((sc["t_out"] + TAIL) * fps))
            if a <= b:
                rs.append([a, b])
    rs.sort()
    out = []
    for a, b in rs:
        if out and a <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def mdir(d):
    return os.path.join(d, "matte")


def fpath(d, k):
    return os.path.join(mdir(d), f"{k:06d}.png")


def missing(d, ranges):
    """Faixas que ainda têm algum quadro sem recorte."""
    have = set(os.listdir(mdir(d))) if os.path.isdir(mdir(d)) else set()
    return [r for r in ranges if any(f"{k:06d}.png" not in have for k in range(r[0], r[1] + 1))]


def count(ranges):
    return sum(b - a + 1 for a, b in ranges)


def _write(d, k, alpha):
    # imencode + tofile: o cv2.imwrite do Windows não grava em caminho com acento (C:\Users\João\...)
    tmp = fpath(d, k) + ".part.png"
    ok, buf = cv2.imencode(".png", alpha)
    if not ok:
        raise RuntimeError("não consegui gravar o recorte")
    buf.tofile(tmp)
    os.replace(tmp, fpath(d, k))


def _read_gray(p):
    try:
        return cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_GRAYSCALE)
    except (OSError, ValueError):
        return None


def compute(d, src, W, H, fps, ranges, progress=None, cancel=None):
    """Recorta as faixas de quadros (RVM no vídeo original) e grava os PNGs.
    A decodificação (ffmpeg) e a gravação dos PNGs correm em paralelo, para a GPU não esperar."""
    sess, dev = get_model()
    os.makedirs(mdir(d), exist_ok=True)
    ds = min(1.0, 512 / max(W, H))            # resolução interna recomendada pelo RVM (HD ≈ 0,25)
    total, done = count(ranges), 0
    fsz = W * H * 3
    with ThreadPoolExecutor(2) as writer:
        for a, b in ranges:
            start = max(0, a - int(round(WARMUP * fps)))
            n = b - start + 1
            # mesma grade de quadros da exportação (render_video): fps explícito e o quadro escolhido pelo
            # número nela. Pular por tempo (-ss) desalinha 1–2 quadros em vídeo de taxa variável.
            dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-vf", f"fps={fps:.6f},select=gte(n\\,{start})",
                                    "-fps_mode", "passthrough", "-frames:v", str(n),
                                    "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
            frames = queue.Queue(maxsize=24)

            def read():
                for _ in range(n):
                    buf = dec.stdout.read(fsz)
                    if len(buf) < fsz:
                        break
                    frames.put(np.frombuffer(buf, np.uint8).reshape(H, W, 3))
                frames.put(None)
            threading.Thread(target=read, daemon=True).start()
            # estados recorrentes do RVM começam vazios (1×1×1×1, como no exemplo oficial do ONNX)
            rec = [np.zeros((1, 1, 1, 1), np.float32) for _ in range(4)]
            dsr = np.array([ds], np.float32)
            pending, last = [], None
            try:
                for k in range(start, b + 1):
                    if cancel and cancel():
                        raise InterruptedError()
                    f = frames.get()
                    if f is None:
                        # o vídeo acabou antes da conta pela duração: repete o último recorte (ou vazio,
                        # se a faixa toda passa do fim) — assim esses quadros não ficam "faltando" para sempre
                        fill = last if last is not None else np.zeros((H, W), np.uint8)
                        for j in range(max(k, a), b + 1):
                            pending.append(writer.submit(_write, d, j, fill))
                        done += b + 1 - max(k, a)
                        break
                    x = np.ascontiguousarray(f.transpose(2, 0, 1)[None], np.float32) / 255
                    feed = {"src": x, "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": dsr}
                    try:
                        _, pha, *rec = sess.run(None, feed)
                    except Exception:
                        if dev == "CPUExecutionProvider":
                            raise
                        sess, dev = get_model(cpu=True)     # placa falhou (driver, memória): segue no processador
                        _, pha, *rec = sess.run(None, feed)
                    if k >= a:
                        last = (np.clip(pha[0, 0], 0, 1) * 255 + 0.5).astype(np.uint8)
                        pending.append(writer.submit(_write, d, k, last))
                        done += 1
                        if progress:
                            progress(done / max(total, 1))
            finally:
                for p in pending:
                    p.result()
                dec.stdout.close()
                dec.kill()
                dec.wait()
    with _cache_lock:
        _cache.clear()


def load(d, t, fps, w, h, cache=True):
    """Recorte do quadro mais próximo de t, em w×h (float32 0..1), ou None se ainda não foi feito.
    cache: guarda (em uint8) para a prévia, que pede os mesmos quadros várias vezes; a exportação lê
    cada quadro uma vez só, em resolução cheia, e não deve encher a memória (cache=False)."""
    k = int(round(t * fps))
    key = (d, k, w, h)
    img = None
    if cache:
        with _cache_lock:
            if key in _cache:
                _cache.move_to_end(key)
                img = _cache[key]
    if img is None:
        p = fpath(d, k)
        if not os.path.exists(p) and k > 0 and os.path.exists(fpath(d, k - 1)):
            p = fpath(d, k - 1)   # último meio quadro do vídeo: o arredondamento passa do último recorte
        img = _read_gray(p) if os.path.exists(p) else None
        if img is None:
            return None
        if img.shape != (h, w):
            img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA if img.shape[1] > w else cv2.INTER_LINEAR)
        if cache:
            with _cache_lock:
                _cache[key] = img
                while len(_cache) > 240:
                    _cache.popitem(last=False)
    return img.astype(np.float32) / 255


def run_worker(d, src, W, H, fps, ranges, progress=None, cancel=None):
    """Roda compute() num processo separado: devolve a memória da placa ao terminar e não divide o
    processo com o Whisper (CUDA)."""
    import json
    import sys
    args = json.dumps({"d": d, "src": src, "W": W, "H": H, "fps": fps, "ranges": ranges})
    env = dict(os.environ)
    p = subprocess.Popen([sys.executable, "-m", "legendapro.matte", args], cwd=ROOT, env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    err = []
    threading.Thread(target=lambda: err.extend(p.stderr), daemon=True).start()
    try:
        for line in p.stdout:
            if line.startswith("P ") and progress:
                progress(float(line[2:]))
            if cancel and cancel():
                p.kill()
                raise InterruptedError()
    finally:
        p.wait()
    if p.returncode != 0:
        msg = next((l.strip() for l in reversed(err) if l.strip()), "erro desconhecido")
        raise RuntimeError(f"recorte da pessoa falhou: {msg}")
    with _cache_lock:
        _cache.clear()


if __name__ == "__main__":
    import json
    import sys
    a = json.loads(sys.argv[1])
    compute(a["d"], a["src"], a["W"], a["H"], a["fps"], a["ranges"],
            progress=lambda f: print(f"P {f:.4f}", flush=True))
    print("OK", flush=True)


# ---------------------------------------------------------------- posição automática do texto atrás
SCALES = (0.7, 0.85, 1.0, 1.2, 1.45, 1.75, 2.1)


def place(plan, style, W, H, load):
    """Trechos {atras} sem posição escrita: escolhe altura, centro e tamanho olhando a silhueta da pessoa
    durante cada legenda — o texto fica parcialmente atrás dela (~1/3 coberto), aparecendo dos dois lados,
    dentro da tela e o maior possível. Cada legenda do trecho tem a sua posição (a pessoa e o tamanho do
    texto mudam de uma para outra). load(t, w, h) -> recorte ou None. Devolve {índice da cena: {dx, dy, s}}
    (sem as cenas que ainda não têm recorte); quem chama aplica nas cenas."""
    from .render import Renderer
    groups = {i: [i] for i, sc in enumerate(plan["scenes"]) if (sc.get("behind") or {}).get("auto")}
    if not groups:
        return {}
    w = 180
    h = max(2, int(round(H * w / W)))
    R = Renderer(style, {**plan, "scenes": plan["scenes"]}, w, h)   # só para medir o bloco de texto
    out = {}
    for g, idxs in groups.items():
        items = []
        for i in idxs:
            sc, rs = plan["scenes"][i], R.scenes[i]
            ts = np.linspace(sc["t_in"] + 0.05, max(sc["t_in"] + 0.05, sc["t_out"] - 0.05), 5)
            # a última legenda pode passar do fim do vídeo: só conta os instantes que têm recorte
            ms = [m for m in (load(float(t), w, h) for t in ts) if m is not None]
            if not ms:
                continue
            mask = (np.mean(ms, axis=0) > 0.5).astype(np.float32)
            oy = 0.0 if sc["mode"] in ("plain", "hero", "block", "fill") else R.offset(rs, (sc["t_in"] + sc["t_out"]) / 2)
            x0 = min(l["x0"] for l in rs["L"]); x1 = max(l["x1"] for l in rs["L"])
            y0 = min(l["base"] + l["top"] for l in rs["L"]) + oy; y1 = max(l["base"] + l["bottom"] for l in rs["L"]) + oy
            ii = np.pad(mask.cumsum(0).cumsum(1), ((1, 0), (1, 0)))          # soma rápida em retângulos
            lines = [(l["x0"], l["x1"], l["base"] + l["top"] + oy, l["base"] + l["bottom"] + oy) for l in rs["L"]]
            items.append(((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, mask, ii, lines))
        if not items:
            continue
        best = None
        for s in SCALES:
            for dyf in np.arange(-0.62, 0.62, 0.01):
                score, dxs, ok = 0.0, [], True
                for cx, cy, bw, bh, mask, ii, lines in items:
                    BW, BH = bw * s, bh * s
                    ncy = cy + dyf * h
                    ya, yb = int(round(ncy - BH / 2)), int(round(ncy + BH / 2))
                    if BW > 0.94 * w or ya < 0.03 * h or yb > 0.97 * h or yb <= ya:
                        ok = False; break
                    # centro horizontal: no meio da pessoa nessa altura (pessoa fora do centro), sem sair da tela
                    band = mask[ya:yb].mean(0)
                    cols = np.where(band > 0.3)[0]
                    px = (cols.min() + cols.max()) / 2 if len(cols) else cx
                    ncx = min(max(px, BW / 2 + 0.03 * w), w - BW / 2 - 0.03 * w)
                    xa, xb = int(round(ncx - BW / 2)), int(round(ncx + BW / 2))
                    def cover(a, b, c, e):
                        return (ii[e, b] - ii[c, b] - ii[e, a] + ii[c, a]) / max(1, (e - c) * (b - a))
                    occ = cover(xa, xb, ya, yb)
                    # cada linha também precisa aparecer: uma linha curta bem atrás da cabeça some inteira
                    hid, tall = 0.0, max(ly1 - ly0 for _, _, ly0, ly1 in lines)
                    for lx0, lx1, ly0, ly1 in lines:
                        a2 = int(np.clip(round(ncx + (lx0 - cx) * s), 0, w - 1))
                        b2 = int(np.clip(round(ncx + (lx1 - cx) * s), a2 + 1, w))
                        c2 = int(np.clip(round(ncy + (ly0 - cy) * s), 0, h - 1))
                        e2 = int(np.clip(round(ncy + (ly1 - cy) * s), c2 + 1, h))
                        # linha maior (o destaque) pesa mais: esconder a palavra principal é o pior caso
                        hid += max(0.0, cover(a2, b2, c2, e2) - 0.55) / 0.45 * (ly1 - ly0) / tall
                    # 1/3 coberto é o visual clássico; nada coberto não é "atrás"; muito coberto não se lê
                    score += -3.0 * abs(occ - 0.33) - (1.0 if occ < 0.12 else 0) - (1.0 if occ > 0.6 else 0) \
                        - 3.0 * hid + 0.6 * BW / w - 0.25 * abs(dyf)
                    dxs.append((ncx - cx) / w)
                if ok and (best is None or score > best[0]):
                    best = (score / len(items), float(np.mean(dxs)), float(dyf), s)
        if best is not None:
            out[g] = {"dx": round(best[1], 3), "dy": round(best[2], 3), "s": best[3]}
    return out
