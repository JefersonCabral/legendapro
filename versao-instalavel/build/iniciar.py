"""Lançador do LegendaPRO (copiado para a raiz do dist e chamado pelo LegendaPRO.bat).

- Se o LegendaPRO já está aberto na porta 7860, só abre o navegador e sai.
- Se a porta está ocupada por OUTRO programa, usa a próxima livre (7861…7869).
- Senão, sobe o servidor nesta mesma janela de console (fechar a janela = sair).
"""
import os
import socket
import sys
import urllib.request
import webbrowser

HOME = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HOME, "app")
PORTA = 7860


def ocupada(porta):
    s = socket.socket()
    s.settimeout(1)
    try:
        return s.connect_ex(("127.0.0.1", porta)) == 0
    finally:
        s.close()


def e_legendapro(porta):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{porta}/api/status", timeout=15) as r:
            return r.status == 200 and b"default_model" in r.read()
    except Exception:
        return False


def main():
    extra = sys.argv[1:]
    # aberto pelo site (link legendapro://abrir, registrado pelo instalador): a interface já está aberta
    # no navegador, então o motor sobe sem abrir outra aba
    if any(a.lower().startswith("legendapro:") for a in extra):
        extra = [a for a in extra if not a.lower().startswith("legendapro:")] + ["--no-browser"]
    porta = PORTA
    if "--port" in extra:
        i = extra.index("--port")
        porta = int(extra[i + 1])
        del extra[i:i + 2]
    for p in range(porta, porta + 10):
        if not ocupada(p):
            porta = p
            break
        if e_legendapro(p):
            print(f"\n  O LegendaPRO já está aberto. Abrindo http://127.0.0.1:{p} no navegador…\n")
            if "--no-browser" not in extra:
                webbrowser.open(f"http://127.0.0.1:{p}")
            return 0
        print(f"  A porta {p} está ocupada por outro programa; tentando a próxima.")
    else:
        print("  Não achei nenhuma porta livre entre 7860 e 7869.")
        return 1

    os.chdir(APP)
    if APP not in sys.path:
        sys.path.insert(0, APP)
    sys.argv = ["legendapro.server", "--port", str(porta), *extra]
    import runpy
    runpy.run_module("legendapro.server", run_name="__main__", alter_sys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
