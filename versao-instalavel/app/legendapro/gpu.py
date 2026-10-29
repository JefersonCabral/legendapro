"""Hardware do PC da pessoa: placas de vídeo, aceleração do Whisper e encoder de vídeo.

Windows:
- Transcrição: faster-whisper na GPU NVIDIA (CUDA 12) quando houver; senão no processador (int8),
  que funciona em qualquer Intel ou AMD. As DLLs CUDA (~1 GB) não vêm no instalador: são baixadas uma
  vez para DATA/cuda quando o PC tem placa NVIDIA (install_cuda_pack).
- Recorte da pessoa: ONNX Runtime com DirectML (qualquer placa) — ver matte.py.
- Exportação: o primeiro encoder de hardware que funcionar de verdade neste PC (NVIDIA → AMD → Intel),
  senão libx264 no processador.
Mac:
- Transcrição: mlx-whisper no chip Apple (M1…M4); Mac Intel usa o faster-whisper no processador.
- Recorte: ONNX Runtime com CoreML. Exportação: VideoToolbox (hardware de todo Mac), senão libx264.

LEGENDAPRO_FORCE_CPU=1 desliga toda aceleração (teste de PC sem placa de vídeo, ou placa com problema).
"""
import glob
import os
import subprocess
import sys
import threading

from .paths import DATA

CUDA_DIR = os.path.join(DATA, "cuda")
# versões testadas juntas com o ctranslate2 4.8.1 (o cublas precisa do nvrtc; sem fixar, um cuDNN novo pode
# dar CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH com o cudnn64_9.dll que vem no ctranslate2)
CUDA_PKGS = ["nvidia-cublas-cu12==12.9.2.10", "nvidia-cuda-nvrtc-cu12==12.9.86", "nvidia-cudnn-cu12==9.24.0.43"]
NOWIN = 0x08000000 if sys.platform == "win32" else 0    # CREATE_NO_WINDOW: sem janela piscando
MAC = sys.platform == "darwin"
FORCE_CPU = os.environ.get("LEGENDAPRO_FORCE_CPU") == "1"

_lock = threading.RLock()     # reentrante: uma detecção usa outra (encoder -> placas)
_cache = {}


def _once(key, fn):
    with _lock:
        if key not in _cache:
            try:
                _cache[key] = fn()
            except Exception:
                _cache[key] = None
        return _cache[key]


def _reset(key):
    with _lock:
        _cache.pop(key, None)


# ---------------------------------------------------------------- placas

def gpu_names():
    """Nomes das placas de vídeo, ex.: ['NVIDIA GeForce GTX 1650', 'AMD Radeon(TM) Graphics'] ou ['Apple M2']."""
    def get():
        if MAC:
            import json
            r = subprocess.run(["system_profiler", "-json", "SPDisplaysDataType"], capture_output=True, text=True,
                               errors="replace", timeout=30, stdin=subprocess.DEVNULL)
            return [d.get("sppci_model") or d.get("_name", "") for d in json.loads(r.stdout).get("SPDisplaysDataType", [])]
        if sys.platform != "win32":
            return []
        r = subprocess.run(["powershell", "-NoProfile", "-Command",
                            "(Get-CimInstance Win32_VideoController).Name"],
                           capture_output=True, text=True, errors="replace", timeout=20, stdin=subprocess.DEVNULL,
                           creationflags=NOWIN)
        return [l.strip() for l in r.stdout.splitlines() if l.strip()]
    return _once("names", get) or []


def vendors():
    """Marcas das placas. Vazio = não deu para saber (PowerShell bloqueado, lento…): quem usa testa tudo."""
    v = set()
    for n in gpu_names():
        low = n.lower()
        if "nvidia" in low:
            v.add("nvidia")
        if "amd" in low or "radeon" in low:
            v.add("amd")
        if "intel" in low:
            v.add("intel")
    return v


def has_nvidia():
    """Placa NVIDIA com driver: pelo nome da placa ou, se a lista falhou, pelo nvcuda.dll do driver."""
    if "nvidia" in vendors():
        return True
    if gpu_names() or sys.platform != "win32":
        return False
    def get():
        import ctypes
        ctypes.WinDLL("nvcuda.dll")
        return True
    return bool(_once("nvcuda", get))


def cpu_name():
    def get():
        if sys.platform == "win32":
            r = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"],
                               capture_output=True, text=True, errors="replace", timeout=20, stdin=subprocess.DEVNULL,
                               creationflags=NOWIN)
            return r.stdout.strip().splitlines()[0].strip()
        if MAC:
            r = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True,
                               timeout=10, stdin=subprocess.DEVNULL)
            return r.stdout.strip()
        import platform
        return platform.processor()
    return _once("cpu", get) or "processador"


def apple_silicon():
    import platform
    return MAC and platform.machine() == "arm64"


def mlx_available():
    """Transcrição no chip Apple (mlx-whisper; só Mac M1…M4 com macOS 14+)."""
    def get():
        if FORCE_CPU or not apple_silicon():
            return False
        import mlx.core as mx
        import mlx_whisper  # noqa: F401
        # Mac virtual (ex.: as máquinas do GitHub) não tem o Metal liberado: aí o processador é melhor
        if not mx.metal.is_available():
            return False
        mx.eval(mx.array([1.0]) + 1)
        return True
    return bool(_once("mlx", get))


def disable_mlx():
    """O MLX falhou de verdade: transcreve com o faster-whisper no processador nesta sessão."""
    with _lock:
        _cache["mlx"] = False


# ---------------------------------------------------------------- CUDA (Whisper)

def setup_cuda_dlls():
    """Registra as pastas bin das wheels nvidia-* (no Python e no pacote baixado em DATA/cuda)."""
    bases = []
    try:
        import nvidia
        bases += list(nvidia.__path__)
    except ImportError:
        pass
    bases.append(os.path.join(CUDA_DIR, "nvidia"))
    for base in bases:
        for b in glob.glob(os.path.join(base, "*", "bin")):
            try:
                os.add_dll_directory(b)
            except (OSError, AttributeError):
                pass
            if b not in os.environ.get("PATH", ""):
                os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")


def cuda_pack_ready():
    have = lambda pat: glob.glob(os.path.join(CUDA_DIR, "nvidia", "*", "bin", pat))
    try:
        import nvidia  # noqa: F401  (ambiente de desenvolvimento, com as wheels já instaladas)
        return True
    except ImportError:
        return bool(have("cublas64_12.dll") and have("cudnn*64_9.dll"))


def cuda_available():
    def get():
        if FORCE_CPU or MAC:
            return False
        if sys.platform == "win32" and not has_nvidia():
            return False
        if not cuda_pack_ready():
            return False
        setup_cuda_dlls()
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    return bool(_once("cuda", get))


def disable_cuda():
    """A CUDA falhou de verdade (memória da placa, DLL): não tenta de novo nesta sessão."""
    with _lock:
        _cache["cuda"] = False


PACK = {"state": "idle", "message": "", "progress": 0.0}   # idle | running | done | error
_pack_lock = threading.Lock()


def install_cuda_pack():
    """Baixa as DLLs CUDA 12 + cuDNN 9 (uma vez) com o pip do próprio Python do programa.
    Roda em segundo plano; enquanto isso a transcrição usa o processador."""
    with _pack_lock:
        if PACK["state"] == "running" or cuda_pack_ready():
            return
        PACK.update(state="running", message="Baixando a aceleração para placa NVIDIA (uma vez, ~1,2 GB)…",
                    progress=0.0)

    def run():
        tmp = CUDA_DIR + ".part"
        try:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
            # --no-cache-dir: sem isso o pip guarda mais uma cópia (~1 GB) no cache dele
            p = subprocess.run([sys.executable, "-m", "pip", "install", "--no-input", "--disable-pip-version-check",
                                "--no-cache-dir", "--no-deps", "--target", tmp, *CUDA_PKGS],
                               capture_output=True, text=True, errors="replace", stdin=subprocess.DEVNULL,
                               creationflags=NOWIN)
            if p.returncode != 0:
                lines = (p.stderr or p.stdout or "").strip().splitlines()
                raise RuntimeError(lines[-1] if lines else f"pip saiu com código {p.returncode}")
            shutil.rmtree(CUDA_DIR, ignore_errors=True)
            os.replace(tmp, CUDA_DIR)
            _reset("cuda")
            PACK.update(state="done", message="Aceleração NVIDIA instalada", progress=1.0)
        except Exception as e:
            PACK.update(state="error", message=f"Não consegui baixar a aceleração NVIDIA: {e}")
    threading.Thread(target=run, daemon=True).start()


# ---------------------------------------------------------------- encoder de vídeo

# ordem de preferência e argumentos de qualidade (q = mesmo número do crf: menor = melhor)
ENCODERS = {
    "nvenc": ("h264_nvenc", "NVIDIA NVENC",
              lambda q: ["-preset", "p5", "-rc", "vbr", "-cq", str(q), "-b:v", "0", "-pix_fmt", "yuv420p"]),
    "amf": ("h264_amf", "AMD AMF",
            lambda q: ["-quality", "quality", "-rc", "cqp", "-qp_i", str(q), "-qp_p", str(q + 2), "-qp_b", str(q + 4),
                       "-pix_fmt", "yuv420p"]),
    "qsv": ("h264_qsv", "Intel Quick Sync",
            lambda q: ["-preset", "slow", "-global_quality", str(q), "-pix_fmt", "nv12"]),
    # Mac: qualidade constante (-q:v, 1–100, maior = melhor) no chip Apple; Mac Intel antigo só aceita bitrate
    "vt": ("h264_videotoolbox", "Apple VideoToolbox",
           lambda q: ["-q:v", str(max(40, min(90, 140 - 4 * q))), "-pix_fmt", "yuv420p"]),
    "vt_br": ("h264_videotoolbox", "Apple VideoToolbox",
              lambda q: ["-b:v", f"{max(6, 30 - q)}M", "-pix_fmt", "yuv420p"]),
    "x264": ("libx264", "processador (x264)",
             lambda q: ["-preset", "medium", "-crf", str(q), "-pix_fmt", "yuv420p"]),
}
FAST = {   # cópia leve para a prévia
    "nvenc": ["-cq", "23", "-pix_fmt", "yuv420p"],
    "amf": ["-rc", "cqp", "-qp_i", "23", "-qp_p", "25", "-pix_fmt", "yuv420p"],
    "qsv": ["-global_quality", "23", "-pix_fmt", "nv12"],
    "vt": ["-q:v", "50", "-pix_fmt", "yuv420p"],
    "vt_br": ["-b:v", "4M", "-pix_fmt", "yuv420p"],
    "x264": ["-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"],
}


def _works(key):
    """Testa o encoder de verdade, com os mesmos argumentos da exportação e da prévia, em 0,2 s de vídeo:
    o ffmpeg lista encoders que a placa não tem, e placa antiga pode não aceitar algum modo (ex.: ICQ da Intel)."""
    codec, _, args = ENCODERS[key]
    for a in (args(18), FAST[key]):
        try:
            r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30",
                                "-t", "0.2", "-c:v", codec, *a, "-f", "null", "-"],
                               capture_output=True, timeout=30, stdin=subprocess.DEVNULL, creationflags=NOWIN)
        except (OSError, subprocess.SubprocessError):
            return False
        if r.returncode != 0:
            return False
    return True


def best_encoder():
    """'nvenc' | 'amf' | 'qsv' | 'x264'. Só testa os da marca que o PC tem (mais rápido e sem falso positivo);
    se não deu para saber as marcas, testa todos."""
    def get():
        if FORCE_CPU:
            return "x264"
        if MAC:
            return next((k for k in ("vt", "vt_br") if _works(k)), "x264")
        v = vendors()
        for key, vendor in (("nvenc", "nvidia"), ("amf", "amd"), ("qsv", "intel")):
            if (vendor in v or not v) and _works(key):
                return key
        return "x264"
    return _once("enc", get) or "x264"


def encoder_failed():
    """A exportação falhou no encoder de hardware: daqui em diante, nesta sessão, usa o processador."""
    with _lock:
        _cache["enc"] = "x264"


def encoder_args(q=18, gpu=True):
    key = best_encoder() if gpu else "x264"
    codec, _, args = ENCODERS[key]
    return ["-c:v", codec, *args(q)]


def fast_encoder_args():
    key = best_encoder()
    return ["-c:v", ENCODERS[key][0], *FAST[key]]


def nvenc_available():
    return best_encoder() == "nvenc"


def hw_encoder():
    return best_encoder() != "x264"


def summary():
    """Para a interface: o que está sendo usado em cada etapa."""
    from . import matte
    enc = best_encoder()
    return {
        "gpus": gpu_names(),
        "cpu": cpu_name(),
        "whisper": "GPU NVIDIA (CUDA)" if cuda_available() else ("chip Apple (MLX)" if mlx_available() else "processador"),
        "encoder": ENCODERS[enc][1],
        "encoder_hw": enc != "x264",
        "matte": matte.provider_label(),
        "cuda_pack": dict(PACK, needed=not FORCE_CPU and has_nvidia() and not cuda_pack_ready()),
    }
