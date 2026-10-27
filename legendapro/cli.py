"""LegendaPRO — gerador de legendas dinâmicas.

Exemplos:
  python -m legendapro render  --video in.mp4 --preset desculpa -o out.mp4
  python -m legendapro render  --video in.mp4 --text roteiro.txt --preset galho -o out.mp4
  python -m legendapro plan    --words palavras.json --preset galho -o plano.json
  python -m legendapro render  --plan plano.json --video in.mp4 -o out.mp4
  python -m legendapro render  --words palavras.json --preset galho --alpha -o legenda.mov
  python -m legendapro preview --video in.mp4 --preset desculpa --at 1.2 3.4 5 -o prev.jpg
"""
import argparse
import json
import os
import sys

import numpy as np

from . import transcript
from .planner import Planner
from .render import Renderer, render_video, probe, ROOT

PRESET_DIR = os.path.join(ROOT, "presets")


def load_preset(name):
    path = name if name.endswith(".json") else os.path.join(PRESET_DIR, name + ".json")
    return json.load(open(path, encoding="utf-8"))


def list_presets():
    return sorted(f[:-5] for f in os.listdir(PRESET_DIR) if f.endswith(".json"))


def get_words(a):
    if a.text and a.words:
        return transcript.align_text(open(a.text, encoding="utf-8").read(), transcript.load(a.words))
    if a.words:
        return transcript.load(a.words)
    if a.srt:
        return transcript.load(a.srt)
    if a.text:
        return transcript.load(a.text, media=a.video, model=a.model)
    if a.video:
        print("  transcrevendo com Whisper…")
        w = transcript.transcribe(a.video, a.model)
        cache = os.path.splitext(a.out or a.video)[0] + ".words.json"
        transcript.save_json(w, cache)
        print(f"  palavras salvas em {cache} (edite e use --words para corrigir)")
        return w
    raise SystemExit("Informe --video, --words, --srt ou --text.")


def get_plan(a, preset):
    if getattr(a, "plan", None):
        return json.load(open(a.plan, encoding="utf-8"))
    return Planner(preset).plan(get_words(a))


def cmd_transcribe(a):
    w = transcript.transcribe(a.video, a.model)
    transcript.save_json(w, a.out)
    print(f"{len(w)} palavras -> {a.out}")


def cmd_plan(a):
    preset = load_preset(a.preset)
    plan = get_plan(a, preset)
    json.dump(plan, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    modes = {}
    for s in plan["scenes"]:
        modes[s["mode"]] = modes.get(s["mode"], 0) + 1
    print(f"{len(plan['scenes'])} cenas {modes}, {len(plan['flashes'])} flashes -> {a.out}")


def cmd_render(a):
    preset = load_preset(a.preset)
    plan = get_plan(a, preset)
    if a.plan:
        preset = load_preset(plan.get("preset", a.preset)) if not a.preset_forced else preset
    if a.save_plan:
        json.dump(plan, open(a.save_plan, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    size = tuple(int(v) for v in a.size.lower().split("x")) if a.size else None
    out = a.out
    if a.alpha and not out.lower().endswith(".mov"):
        out = os.path.splitext(out)[0] + ".mov"
    render_video(preset, plan, out, video=None if a.alpha else a.video, size=size,
                 duration=a.duration, alpha=a.alpha)


def cmd_preview(a):
    import subprocess
    from PIL import Image, ImageDraw
    preset = load_preset(a.preset)
    plan = get_plan(a, preset)
    if a.video:
        W, H, fps, dur = probe(a.video)
    else:
        W, H = 1080, 1920
    R = Renderer(preset, plan, W, H)
    tiles = []
    for t in a.at:
        base = None
        if a.video:
            r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{t}", "-i", a.video, "-frames:v", "1",
                                "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True)
            base = np.frombuffer(r.stdout, np.uint8).reshape(H, W, 3)
        im = Image.fromarray(R.frame(t, base))
        ImageDraw.Draw(im).text((10, 10), f"{t:.2f}s", fill=(255, 255, 0))
        tiles.append(im)
    tw = W // 2
    th = H // 2
    cols = min(len(tiles), a.cols)
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (tw * cols, th * rows))
    for i, im in enumerate(tiles):
        sheet.paste(im.resize((tw, th)), ((i % cols) * tw, (i // cols) * th))
    sheet.save(a.out, quality=90)
    print("->", a.out)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="legendapro", description="Gerador de legendas dinâmicas")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def src(p):
        p.add_argument("--video", help="vídeo de entrada (transcreve automaticamente se nada mais for dado)")
        p.add_argument("--words", help="JSON de palavras com start/end")
        p.add_argument("--srt", help="legenda SRT/VTT")
        p.add_argument("--text", help="texto/roteiro (com marcações opcionais) sincronizado com o vídeo")
        p.add_argument("--model", default="large-v3-turbo", help="modelo Whisper (tiny/small/medium/large-v3/large-v3-turbo)")
        p.add_argument("--preset", default="desculpa", help=f"preset: {', '.join(list_presets())}")

    p = sub.add_parser("transcribe"); p.add_argument("--video", required=True)
    p.add_argument("--model", default="large-v3-turbo"); p.add_argument("-o", "--out", required=True)
    p.set_defaults(fn=cmd_transcribe)

    p = sub.add_parser("plan"); src(p); p.add_argument("-o", "--out", required=True); p.set_defaults(fn=cmd_plan)

    p = sub.add_parser("render"); src(p)
    p.add_argument("--plan", help="plano JSON (editado à mão) em vez de gerar")
    p.add_argument("--save-plan", help="salva o plano gerado")
    p.add_argument("--alpha", action="store_true", help="exporta só a legenda com transparência (.mov ProRes 4444)")
    p.add_argument("--size", help="ex.: 1080x1920")
    p.add_argument("--duration", type=float)
    p.add_argument("-o", "--out", required=True)
    p.set_defaults(fn=cmd_render, preset_forced=False)

    p = sub.add_parser("preview"); src(p)
    p.add_argument("--plan"); p.add_argument("--at", type=float, nargs="+", required=True)
    p.add_argument("--cols", type=int, default=4); p.add_argument("-o", "--out", required=True)
    p.set_defaults(fn=cmd_preview)

    a = ap.parse_args(argv)
    if a.cmd == "render":
        a.preset_forced = "--preset" in (argv or sys.argv)
    a.fn(a)


if __name__ == "__main__":
    main()
