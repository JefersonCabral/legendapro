"""Monta o latest.json da Release (lido pela atualização automática do motor) e assina com Ed25519.

    python make_manifest.py --version 1.0.4 --dir <pasta com os instaladores> --out latest.json

A chave privada vem da variável LEGENDAPRO_UPDATE_KEY (base64 dos 32 bytes; no GitHub é o segredo de mesmo
nome). Sem ela, o latest.json sai sem assinatura: o motor só avisa da versão nova e oferece o download, não
instala sozinho. Os links apontam para a Release da tag (releases/download/v<versão>/<arquivo>).
"""
import argparse
import base64
import hashlib
import json
import os
import re

FILES = {"win": "LegendaPRO-Setup.exe", "mac-arm64": "LegendaPRO-mac-arm64.dmg",
         "mac-x86_64": "LegendaPRO-mac-x86_64.dmg"}
REPO = "JefersonCabral/legendapro"


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", default="latest.json")
    a = ap.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    init = open(os.path.join(here, "..", "app", "legendapro", "__init__.py"), encoding="utf-8").read()
    api = int(re.search(r"^API = (\d+)", init, re.M).group(1))
    base = f"https://github.com/{REPO}/releases/download/v{a.version}"
    files = {}
    for key, name in FILES.items():
        hits = [os.path.join(r, name) for r, _, fs in os.walk(a.dir) if name in fs]
        if hits:
            p = hits[0]
            files[key] = {"name": name, "url": f"{base}/{name}", "size": os.path.getsize(p), "sha256": sha256(p)}
            print(f"  {key}: {name} {files[key]['size'] / 1e6:.0f} MB")
        else:
            print(f"  {key}: {name} não encontrado (fica fora do manifesto)")
    payload = {"version": a.version, "api": api, "notes_url": f"https://github.com/{REPO}/releases/tag/v{a.version}",
               "files": files}
    doc = {"payload": payload, "sig": None}
    key = os.environ.get("LEGENDAPRO_UPDATE_KEY", "").strip()
    if key:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        k = Ed25519PrivateKey.from_private_bytes(base64.b64decode(key))
        msg = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        doc["sig"] = base64.b64encode(k.sign(msg)).decode()
        print("  assinado")
    else:
        print("  SEM assinatura (falta o segredo LEGENDAPRO_UPDATE_KEY): o motor só vai avisar, sem instalar sozinho")
    json.dump(doc, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("  ->", a.out)


if __name__ == "__main__":
    main()
