"""App do LegendaPRO no Mac: ícone na barra de menu (sem janela, sem ícone no Dock) que mantém o motor
rodando. É o executável do LegendaPRO.app (Contents/MacOS/LegendaPRO chama este arquivo).

- Sobe o motor (python -m legendapro.server) numa porta livre de 7860 a 7869, sem abrir aba.
- Aberto pelo site (link legendapro://abrir, registrado no Info.plist): a página já está aberta e encontra
  o motor sozinha. Aberto pelo Launchpad/Finder: abre a interface no navegador.
- Menu: Abrir o LegendaPRO, Abrir a pasta dos projetos, Sair (encerra o motor).
Se o rumps/PyObjC não carregar, roda o motor sem o ícone (fechar = encerrar o processo).
"""
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

RES = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(RES, "app")
PY = sys.executable
state = {"url": False, "port": None, "proc": None}


def ocupada(porta):
    s = socket.socket()
    s.settimeout(1)
    try:
        return s.connect_ex(("127.0.0.1", porta)) == 0
    finally:
        s.close()


def e_legendapro(porta):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{porta}/api/status", timeout=10) as r:
            return b'"engine": "legendapro"' in r.read()
    except Exception:
        return False


def start_engine():
    """Devolve a porta: a de um motor já aberto ou a de um novo."""
    for p in range(7860, 7870):
        if not ocupada(p):
            # LEGENDAPRO_LAUNCHER: o motor sabe que tem este ícone por cima (fecha ele junto ao se atualizar)
            env = dict(os.environ, PYTHONNOUSERSITE="1", PYTHONUTF8="1", LEGENDAPRO_LAUNCHER="1")
            log = open(os.path.join(os.path.expanduser("~"), "Library", "Logs", "LegendaPRO.log"), "a")
            state["proc"] = subprocess.Popen([PY, "-m", "legendapro.server", "--port", str(p), "--no-browser"],
                                             cwd=APP, env=env, stdout=log, stderr=subprocess.STDOUT,
                                             stdin=subprocess.DEVNULL)
            for _ in range(120):            # espera responder (a 1ª vez detecta o hardware)
                if e_legendapro(p):
                    break
                if state["proc"].poll() is not None:
                    if updating():           # saiu para instalar uma versão nova: o ajudante reabre o app
                        os._exit(0)
                    raise SystemExit("o motor do LegendaPRO não abriu: veja ~/Library/Logs/LegendaPRO.log")
                time.sleep(0.5)
            return p
        if e_legendapro(p):
            return p
    raise SystemExit("nenhuma porta livre entre 7860 e 7869")


def updating():
    m = os.path.join(data_dir(), "updates", "instalando")
    return os.path.exists(m) and time.time() - os.path.getmtime(m) < 300


def ui_url():
    return f"http://127.0.0.1:{state['port']}"


def data_dir():
    return os.environ.get("LEGENDAPRO_DATA") or os.path.join(os.path.expanduser("~"), "Library",
                                                             "Application Support", "LegendaPRO")


def stop_engine():
    p = state.get("proc")
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()


def listen_url_events():
    """legendapro://… chega como Apple Event (não como argumento): marca para não abrir outra aba."""
    from Foundation import NSAppleEventManager, NSObject
    import objc

    k = struct.unpack(">i", b"GURL")[0]          # kInternetEventClass = kAEGetURL = 'GURL'

    class Handler(NSObject):
        @objc.signature(b"v@:@@")
        def handleURL_withReply_(self, event, reply):
            state["url"] = True

    h = Handler.alloc().init()
    NSAppleEventManager.sharedAppleEventManager().setEventHandler_andSelector_forEventClass_andEventID_(
        h, "handleURL:withReply:", k, k)
    state["handler"] = h                          # mantém vivo


def main():
    try:
        import rumps
    except Exception:
        rumps = None
    if rumps is None:                             # sem a barra de menu: só o motor
        state["port"] = start_engine()
        if "legendapro:" not in " ".join(sys.argv):
            webbrowser.open(ui_url())
        if state["proc"]:
            state["proc"].wait()
        return

    class App(rumps.App):
        def __init__(self):
            super().__init__("LegendaPRO", title="LP", quit_button=None)
            self.menu = [rumps.MenuItem("Abrir o LegendaPRO", callback=lambda _: webbrowser.open(ui_url())),
                         rumps.MenuItem("Abrir a pasta dos projetos",
                                        callback=lambda _: subprocess.Popen(["open", data_dir()])),
                         None,
                         rumps.MenuItem("Sair do LegendaPRO", callback=self.sair)]

        def sair(self, _):
            stop_engine()
            rumps.quit_application()

    try:
        listen_url_events()
    except Exception:
        pass

    def boot():
        try:
            state["port"] = start_engine()
        except SystemExit as e:
            # janelas do AppKit só na thread principal: o aviso vai pelo osascript
            msg = str(e).replace('"', "'")
            subprocess.run(["osascript", "-e", f'display alert "LegendaPRO" message "{msg}"'])
            os._exit(1)
        time.sleep(1.0)                           # dá tempo do Apple Event do link chegar
        if not state["url"]:
            webbrowser.open(ui_url())
    threading.Thread(target=boot, daemon=True).start()
    try:
        App().run()
    finally:
        stop_engine()


if __name__ == "__main__":
    main()
