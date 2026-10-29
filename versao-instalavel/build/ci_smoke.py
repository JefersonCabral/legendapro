"""Teste de ponta a ponta do motor empacotado (Windows ou Mac): sobe o motor com uma pasta de dados vazia,
envia um vídeo, transcreve, recorta a pessoa (texto atrás), exporta MP4 e MOV transparente e confere
os arquivos. Sai com código 1 se algo falhar.

    python ci_smoke.py --python <python do pacote> --app <pasta app do pacote> [--video v.mp4] [--model tiny]

Sem --video, gera um de 6 s com fala (no Mac, com o comando `say`; no Windows, com a voz do sistema).
Usa só a biblioteca padrão (roda com qualquer Python).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

FALA = "Trabalhar oito horas por dia para levar dois mil reais no fim do mês é uma escolha."


def make_video(tmp, ffmpeg):
    # fala em português gravada junto do script (voz pt-BR do Windows): o mesmo áudio em qualquer máquina,
    # sem depender das vozes instaladas; as vozes do sistema ficam de reserva
    audio = os.path.join(os.path.dirname(os.path.abspath(__file__)), "teste-fala.opus")
    if not os.path.exists(audio):
        audio = os.path.join(tmp, "fala.aiff" if sys.platform == "darwin" else "fala.wav")
        if sys.platform == "darwin":
            voices = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
            v = ["-v", "Luciana"] if "Luciana" in voices else []
            subprocess.run(["say", *v, "-o", audio, FALA], check=True)
        elif sys.platform == "win32":
            ps = ("Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                  f"$s.SetOutputToWaveFile('{audio}'); $s.Speak('{FALA}'); $s.Dispose()")
            subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
        else:
            subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i", "sine=f=440:d=6", audio], check=True)
    out = os.path.join(tmp, "teste fala.mp4")
    subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30", "-i", audio,
                    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out], check=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--python", required=True)
    ap.add_argument("--app", required=True)
    ap.add_argument("--video")
    ap.add_argument("--model", default="tiny")
    ap.add_argument("--port", type=int, default=7880)
    a = ap.parse_args()
    a.python, a.app = os.path.abspath(a.python), os.path.abspath(a.app)
    tmp = tempfile.mkdtemp(prefix="lp-smoke-")
    data = os.path.join(tmp, "dados")
    ffmpeg = os.path.join(a.app, "bin", "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg")
    ffmpeg = ffmpeg if os.path.exists(ffmpeg) else "ffmpeg"
    ffprobe = ffmpeg.replace("ffmpeg", "ffprobe") if ffmpeg != "ffmpeg" else "ffprobe"
    video = a.video or make_video(tmp, ffmpeg)
    B = f"http://127.0.0.1:{a.port}"
    env = dict(os.environ, LEGENDAPRO_DATA=data, PYTHONNOUSERSITE="1", PYTHONUTF8="1")
    log_path = os.path.join(tmp, "motor.log")
    srv_log = open(log_path, "w", encoding="utf-8")
    srv = subprocess.Popen([a.python, "-u", "-m", "legendapro.server", "--port", str(a.port), "--no-browser"],
                           cwd=a.app, env=env, stdin=subprocess.DEVNULL, stdout=srv_log, stderr=subprocess.STDOUT)
    fails = []

    def req(method, path, body=None, headers=None):
        data_ = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
        h = {"Content-Type": "application/json", **(headers or {})}
        with urllib.request.urlopen(urllib.request.Request(B + path, data=data_, method=method, headers=h),
                                    timeout=900) as r:
            return json.loads(r.read())

    def wait(j, label, limit=1800):
        t0 = time.time()
        while j["status"] == "running":
            time.sleep(1)
            j = req("GET", f"/api/jobs/{j['id']}")
            if time.time() - t0 > limit:
                raise RuntimeError(f"{label}: passou de {limit}s")
        print(f"  {label}: {j['status']} em {time.time() - t0:.1f}s {j.get('error') or ''}", flush=True)
        note("notice" if j["status"] == "done" else "error", f"{label}: {j['status']} em {time.time() - t0:.1f}s {j.get('error') or ''}")
        if j["status"] != "done":
            raise RuntimeError(f"{label}: {j.get('error')}")
        return j

    gha = bool(os.environ.get("GITHUB_ACTIONS"))

    def note(kind, msg):
        # no GitHub Actions, vira anotação (aparece na página do build e na API pública do job)
        if gha:
            print(f"::{kind}::" + msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A"), flush=True)

    def check(cond, msg):
        print(("  ok   " if cond else "  FALHA ") + msg, flush=True)
        if not cond:
            fails.append(msg)
            note("error", msg)

    def probe(path):
        r = subprocess.run([ffprobe, "-v", "error", "-show_entries", "stream=codec_name,nb_frames", "-of", "json", path],
                           capture_output=True, text=True)
        return json.loads(r.stdout or "{}").get("streams", [])

    try:
        for _ in range(240):
            try:
                st = req("GET", "/api/status")
                break
            except Exception:
                if srv.poll() is not None:
                    raise RuntimeError("o motor fechou ao abrir")
                time.sleep(0.5)
        else:
            raise RuntimeError("o motor não respondeu")
        print("hardware:", json.dumps(st["hw"], ensure_ascii=False), flush=True)
        note("notice", "hardware: " + json.dumps(st["hw"], ensure_ascii=False))
        check(st.get("engine") == "legendapro", "status responde como motor do LegendaPRO")
        # segurança: outro site não pode usar o motor
        try:
            urllib.request.urlopen(urllib.request.Request(B + "/api/projects", headers={"Origin": "https://malicioso.example"}))
            check(False, "pedido de outro site recusado")
        except urllib.error.HTTPError as e:
            check(e.code == 403, "pedido de outro site recusado (403)")

        up = req("POST", f"/api/upload?preset=preset-6&model={a.model}", open(video, "rb").read(),
                 {"Content-Type": "application/octet-stream", "X-Filename": urllib.parse.quote(os.path.basename(video))})
        pid = up["project"]["id"]
        wait(up["job"], f"transcrição ({a.model})")
        p = req("GET", f"/api/projects/{pid}")
        print("  texto:", p["text"].replace("\n", " / "))
        check(len(p["text"].split()) >= 3, "transcrição tem palavras")

        lines = p["text"].split("\n")
        lines[0] = "{atras} " + lines[0] + " {/atras}"
        req("PUT", f"/api/projects/{pid}", {"text": "\n".join(lines)})
        wait(req("POST", f"/api/projects/{pid}/matte", {}), "recorte da pessoa")
        check(req("GET", f"/api/projects/{pid}/plan")["live"]["matte"]["need"] == 0, "recorte completo")

        for preset in ("preset-6", "preset-10"):
            req("PUT", f"/api/projects/{pid}", {"preset": preset})
            wait(req("POST", f"/api/projects/{pid}/render", {"kind": "mp4", "quality": 18}), f"exportar MP4 {preset}")
            s = probe(os.path.join(data, "projects", pid, "legendado.mp4"))
            check(any(x.get("codec_name") == "h264" for x in s) and any(x.get("codec_name") == "aac" for x in s),
                  f"MP4 {preset} tem vídeo h264 e áudio")
        wait(req("POST", f"/api/projects/{pid}/render", {"kind": "alpha"}), "exportar MOV transparente")
        s = probe(os.path.join(data, "projects", pid, "legenda-alpha.mov"))
        check(any(x.get("codec_name") == "prores" for x in s), "MOV transparente em ProRes")
        live = req("GET", f"/api/projects/{pid}/plan")["live"]
        check(bool(live.get("segs")), "prévia ao vivo tem quadros")
    except Exception as e:
        fails.append(str(e))
        print("  FALHA", e, flush=True)
        note("error", f"{type(e).__name__}: {e}")
        try:                                   # o motor costuma explicar o erro no próprio log
            note("error", "últimas linhas do motor:\n" + "".join(open(log_path, encoding="utf-8", errors="replace").readlines()[-25:]))
        except OSError:
            pass
    finally:
        srv.terminate()
        try:
            srv.wait(10)
        except subprocess.TimeoutExpired:
            srv.kill()
        srv_log.close()
        shutil.rmtree(tmp, ignore_errors=True)
    print("\nRESULTADO:", "tudo certo" if not fails else f"{len(fails)} falha(s): {fails}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
