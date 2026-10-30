"""Atualização automática do motor.

A cada versão (tag v*), o GitHub Actions publica na Release um latest.json assinado (Ed25519):
    {"payload": {"version", "api", "notes_url", "files": {"win"|"mac-arm64"|"mac-x86_64": {name, url, size, sha256}}},
     "sig": "<base64 da assinatura sobre o payload em JSON canônico>"}
O motor consulta ao abrir e a cada 6 h. Com assinatura válida e instalação reconhecida (instalador do Windows
ou LegendaPRO.app no Mac), baixa em segundo plano, confere tamanho e SHA-256 e deixa pronto. Instala quando a
pessoa clica em "Atualizar agora" (nunca no meio de um trabalho) ou sozinho na próxima vez que o motor abrir.

A instalação é feita por um ajudante fora do programa (PowerShell no Windows, bash no Mac): espera o motor
fechar, guarda a versão atual ao lado (<pasta>.anterior), instala a nova, abre e confere se ela responde com
a versão nova; se não responder em 2 min, volta a anterior. Sem assinatura válida (ou em cópia portátil/de
desenvolvimento) só avisa e oferece o download manual.

Testes: LEGENDAPRO_UPDATE_URL e LEGENDAPRO_UPDATE_PUBKEY trocam o endereço do latest.json e a chave pública.
"""
import base64
import hashlib
import json
import os
import platform
import subprocess
import sys
import threading
import time
import urllib.request

from . import VERSION
from .paths import APP, DATA

MANIFEST_URL = os.environ.get("LEGENDAPRO_UPDATE_URL") or \
    "https://github.com/JefersonCabral/legendapro/releases/latest/download/latest.json"
# chave pública da assinatura (a privada fica nos segredos do GitHub: LEGENDAPRO_UPDATE_KEY)
PUBKEY = os.environ.get("LEGENDAPRO_UPDATE_PUBKEY") or "tJn/Tsfx/ZP/xdlP1WbnWe4aYQJHBf7CBwwQZqQT+zw="
CHECK_EVERY = 6 * 3600
UPD_DIR = os.path.join(DATA, "updates")
SETTINGS = os.path.join(DATA, "atualizacao.json")
HOME = os.path.dirname(APP)            # Windows: pasta do programa; Mac: .../LegendaPRO.app/Contents/Resources

_lock = threading.Lock()
STATE = {"state": "idle", "latest": None, "progress": 0.0, "message": "", "signed": False,
         "notes_url": None, "download_url": None, "checked": None}


# ---------------------------------------------------------------- utilidades

def vtuple(v):
    try:
        return tuple(int(x) for x in str(v).lstrip("v").split("."))
    except ValueError:
        return (0,)


def platform_key():
    if sys.platform == "win32":
        return "win"
    if sys.platform == "darwin":
        return "mac-arm64" if platform.machine() == "arm64" else "mac-x86_64"
    return None


def layout():
    """'win' (instalado pelo LegendaPRO-Setup.exe), 'mac' (dentro do LegendaPRO.app) ou None (portátil, código
    de desenvolvimento): só nos dois primeiros dá para instalar sozinho."""
    if sys.platform == "win32" and os.path.exists(os.path.join(HOME, "unins000.exe")) \
            and os.path.exists(os.path.join(HOME, "python", "python.exe")):
        return "win"
    if sys.platform == "darwin" and HOME.endswith(os.path.join("Contents", "Resources")):
        return "mac"
    return None


def app_bundle():
    return os.path.dirname(os.path.dirname(HOME))     # .../LegendaPRO.app


def settings():
    try:
        return {"auto": True, **json.load(open(SETTINGS, encoding="utf-8"))}
    except (OSError, ValueError):
        return {"auto": True}


def save_settings(**kw):
    s = settings()
    s.update(kw)
    os.makedirs(DATA, exist_ok=True)
    tmp = SETTINGS + ".part"
    json.dump(s, open(tmp, "w", encoding="utf-8"), indent=1)
    os.replace(tmp, SETTINGS)
    return s


def verify(doc):
    """Confere a assinatura Ed25519 do payload. Devolve True/False (sem a biblioteca, False)."""
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        pub = Ed25519PublicKey.from_public_bytes(base64.b64decode(PUBKEY))
        msg = json.dumps(doc["payload"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        pub.verify(base64.b64decode(doc["sig"]), msg)
        return True
    except Exception:
        return False


def status():
    s = settings()
    out = dict(STATE, current=VERSION, auto=s.get("auto", True), installable=layout() is not None)
    out.pop("_file", None)
    out.pop("_path", None)
    return out


# ---------------------------------------------------------------- procurar e baixar

def check(download=True):
    """Lê o latest.json; havendo versão nova, marca 'available' e (assinada, instalável e com o automático
    ligado) baixa em segundo plano."""
    with _lock:
        if STATE["state"] in ("checking", "downloading", "installing"):
            return
        STATE.update(state="checking", message="")
    try:
        with urllib.request.urlopen(urllib.request.Request(MANIFEST_URL, headers={"User-Agent": "LegendaPRO"}),
                                    timeout=20) as r:
            doc = json.loads(r.read())
        pay = doc.get("payload", {})
        signed = verify(doc)
        f = (pay.get("files") or {}).get(platform_key())
        latest = pay.get("version")
        STATE.update(checked=time.time(), latest=latest, signed=signed, notes_url=pay.get("notes_url"),
                     download_url=(f or {}).get("url"))
        if not latest or vtuple(latest) <= vtuple(VERSION) or not f:
            STATE.update(state="uptodate", message="O LegendaPRO está na versão mais nova")
            cleanup()
            return
        if failed_before(latest):
            # já tentou e a versão não abriu aqui (o ajudante voltou a anterior): não oferece de novo
            STATE.update(state="failed", message=f"A versão {latest} não abriu neste computador; você continua "
                                                 f"na {VERSION}. Ela vai ser oferecida de novo quando sair outra.")
            return
        ready = ready_file(latest)
        if ready:
            STATE.update(state="ready", message=f"Versão {latest} pronta para instalar", _path=ready)
            return
        STATE.update(state="available", message=f"Versão {latest} disponível", _file=f)
        if download and signed and layout() and settings().get("auto", True):
            threading.Thread(target=_download, args=(latest, f), daemon=True).start()
    except Exception as e:
        STATE.update(state="error", message=f"Não consegui procurar atualizações: {e}")


def ready_file(version):
    d = os.path.join(UPD_DIR, version)
    ok = os.path.join(d, "ok.json")
    try:
        info = json.load(open(ok, encoding="utf-8"))
        p = os.path.join(d, info["name"])
        if os.path.getsize(p) == info["size"]:
            return p
    except (OSError, ValueError, KeyError):
        pass
    return None


def download():
    """Baixar agora (botão), mesmo com o automático desligado."""
    if failed_before(STATE.get("latest") or ""):
        return
    f = STATE.get("_file")
    if STATE["state"] == "available" and f and STATE["signed"] and layout():
        threading.Thread(target=_download, args=(STATE["latest"], f), daemon=True).start()


def _download(version, f):
    with _lock:
        if STATE["state"] == "downloading":
            return
        STATE.update(state="downloading", progress=0.0, message=f"Baixando a versão {version}…")
    d = os.path.join(UPD_DIR, version)
    os.makedirs(d, exist_ok=True)
    dst = os.path.join(d, f["name"])
    tmp = dst + ".part"
    try:
        h = hashlib.sha256()
        got = 0
        with urllib.request.urlopen(urllib.request.Request(f["url"], headers={"User-Agent": "LegendaPRO"}),
                                    timeout=60) as r, open(tmp, "wb") as out:
            while True:
                buf = r.read(1 << 20)
                if not buf:
                    break
                out.write(buf)
                h.update(buf)
                got += len(buf)
                STATE["progress"] = round(got / max(f["size"], 1), 3)
        if got != f["size"] or h.hexdigest() != f["sha256"]:
            raise RuntimeError("o arquivo baixado não confere com o da versão publicada")
        os.replace(tmp, dst)
        json.dump({"name": f["name"], "size": f["size"], "sha256": f["sha256"]},
                  open(os.path.join(d, "ok.json"), "w", encoding="utf-8"))
        STATE.update(state="ready", progress=1.0, message=f"Versão {version} pronta para instalar", _path=dst)
    except Exception as e:
        STATE.update(state="error", message=f"Não consegui baixar a atualização: {e}")
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def cleanup():
    """Apaga downloads de versões que já não interessam (a atual ou mais velhas)."""
    if not os.path.isdir(UPD_DIR):
        return
    import shutil
    for v in os.listdir(UPD_DIR):
        if os.path.isdir(os.path.join(UPD_DIR, v)) and vtuple(v) <= vtuple(VERSION):
            shutil.rmtree(os.path.join(UPD_DIR, v), ignore_errors=True)


def failed_before(version):
    return os.path.exists(os.path.join(UPD_DIR, f"falhou-{version}"))


def start_background_checks():
    def loop():
        time.sleep(15)                  # deixa o motor terminar de abrir
        while True:
            check()
            time.sleep(CHECK_EVERY)
    threading.Thread(target=loop, daemon=True).start()


# ---------------------------------------------------------------- instalar

def marker_path():
    """Enquanto existe (e é recente), o motor fechou para se atualizar: o ícone da barra de menu do Mac não
    trata a saída como erro. O ajudante apaga no fim."""
    return os.path.join(UPD_DIR, "instalando")


def install(port):
    """Chama o ajudante (fora do programa) e devolve; quem chama encerra o motor logo em seguida."""
    path = STATE.get("_path") or ready_file(STATE.get("latest") or "")
    kind = layout()
    if not path or not kind or STATE.get("state") == "failed":
        raise RuntimeError("não há atualização pronta para instalar")
    version = STATE["latest"]
    # registro fora da pasta da versão: o motor novo apaga essa pasta ao abrir (cleanup)
    log = os.path.join(UPD_DIR, f"instalacao-{version}.log")
    here = os.path.dirname(os.path.abspath(__file__))
    STATE.update(state="installing", message=f"Instalando a versão {version}…")
    open(marker_path(), "w").write(version)
    if kind == "win":
        script = os.path.join(UPD_DIR, "atualizar.ps1")
        import shutil
        shutil.copyfile(os.path.join(here, "atualizar.ps1"), script)
        # CREATE_NO_WINDOW (console próprio, invisível: não morre quando a janela do LegendaPRO fecha) |
        # CREATE_NEW_PROCESS_GROUP. Sem DETACHED_PROCESS: com ele o PowerShell não chega a iniciar.
        flags = 0x08000000 | 0x00000200
        subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
                          "-File", script, "-EnginePid", str(os.getpid()), "-Installer", path, "-AppDir", HOME,
                          "-Version", version, "-Log", log, "-Marker", os.path.join(UPD_DIR, f"falhou-{version}"),
                          "-Port", str(port or 0)],
                         creationflags=flags, close_fds=True, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        script = os.path.join(UPD_DIR, "atualizar.sh")
        import shutil
        shutil.copyfile(os.path.join(here, "atualizar.sh"), script)
        os.chmod(script, 0o755)
        parent = os.getppid() if os.environ.get("LEGENDAPRO_LAUNCHER") else 0
        subprocess.Popen(["/bin/bash", script, str(os.getpid()), str(parent), path, app_bundle(), version, log,
                          os.path.join(UPD_DIR, f"falhou-{version}")],
                         start_new_session=True, close_fds=True, stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def exit_soon(delay=1.0):
    """Encerra o motor depois de responder ao pedido (no Mac, fecha também o ícone da barra de menu)."""
    def go():
        time.sleep(delay)
        if sys.platform == "darwin" and os.environ.get("LEGENDAPRO_LAUNCHER"):
            import signal
            try:
                os.kill(os.getppid(), signal.SIGTERM)
            except OSError:
                pass
        os._exit(0)
    threading.Thread(target=go, daemon=True).start()


def install_at_startup():
    """Ao abrir: com uma versão já baixada e conferida, o automático ligado e sem falha anterior dela,
    instala antes de abrir a porta (não há trabalho rodando). Devolve True se o motor deve sair."""
    try:
        s = settings()
        if not s.get("auto", True) or not layout() or not os.path.isdir(UPD_DIR):
            return False
        versions = sorted((v for v in os.listdir(UPD_DIR) if vtuple(v) > vtuple(VERSION)), key=vtuple)
        for v in reversed(versions):
            p = ready_file(v)
            if p and not failed_before(v):
                STATE.update(latest=v, _path=p)
                install(port=0)
                print(f"\n  Instalando a versão {v} do LegendaPRO… o programa abre de novo sozinho.\n")
                return True
    except Exception as e:
        print(f"  atualização automática não pôde ser instalada: {e}")
    return False
