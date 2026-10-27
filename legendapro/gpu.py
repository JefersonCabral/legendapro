"""Detecção de GPU: registra as DLLs CUDA (pip nvidia-*) e escolhe dispositivo/encoder."""
import glob
import os
import subprocess

_ready = None


def setup_cuda_dlls():
    """No Windows, as DLLs de nvidia-cublas-cu12 / nvidia-cudnn-cu12 ficam em site-packages/nvidia/*/bin."""
    try:
        import nvidia
    except ImportError:
        return
    for base in list(nvidia.__path__):
        for b in glob.glob(os.path.join(base, "*", "bin")):
            try:
                os.add_dll_directory(b)
            except (OSError, AttributeError):
                pass
            os.environ["PATH"] = b + os.pathsep + os.environ.get("PATH", "")


def cuda_available():
    global _ready
    if _ready is None:
        setup_cuda_dlls()
        try:
            import ctranslate2
            _ready = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            _ready = False
    return _ready


_nvenc = None


def nvenc_available():
    global _nvenc
    if _nvenc is None:
        try:
            r = subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=256x256:r=30",
                                "-t", "0.2", "-c:v", "h264_nvenc", "-f", "null", "-"],
                               capture_output=True, timeout=30)
            _nvenc = r.returncode == 0
        except Exception:
            _nvenc = False
    return _nvenc
