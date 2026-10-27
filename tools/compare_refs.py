"""Comparativo lado a lado: nosso preset (esquerda) × legenda da referência (direita),
mesma frase e mesmos tempos. Saída em analysis/compare/<preset>_<n>.jpg"""
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from legendapro import server as S                      # noqa: E402
from legendapro.planner import Planner                  # noqa: E402
from legendapro.render import Renderer                  # noqa: E402
from legendapro.transcript import Word                  # noqa: E402

OUT = os.path.join(ROOT, "analysis", "compare")
os.makedirs(OUT, exist_ok=True)
AFTER = {"v3": (285, 249, 364, 660), "v4": (284, 249, 366, 660), "v6": (274, 298, 372, 658), "v5": (0, 0, 720, 1280)}
BEFORE = {"v3": (66, 541, 195, 349), "v4": (66, 541, 195, 349)}


def frame(v, f):
    cap = cv2.VideoCapture(os.path.join(ROOT, "ref", v + ".mp4"))
    cap.set(cv2.CAP_PROP_POS_FRAMES, f)
    ok, img = cap.read()
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def crop(img, box):
    x, y, w, h = box
    return img[y:y + h, x:x + w]


def bg_for(v, f):
    if v in BEFORE:
        return cv2.resize(crop(frame(v, f), BEFORE[v]), (720, 1280), interpolation=cv2.INTER_CUBIC)
    m = S.read_meta("7dd453153311")
    return S.grab_frame(os.path.join(ROOT, "projects", "7dd453153311", m["file"]), 1.0, 720, 1280)


def words(spec):
    out = []
    for item in spec:
        t, s, e = item[:3]
        w = Word(t, s, e)
        if len(item) > 3:
            w.flags |= set(item[3])
        out.append(w)
    return out


CASES = [
    ("preset-3", "v3", 165, [("uske", 5.20, 5.30), ("paas", 5.30, 5.42), ("itne", 5.42, 5.60), ("paise", 5.64, 6.0, ["emph"]),
                           ("nahi", 6.16, 6.30), ("hai", 6.30, 6.60)]),
    ("preset-3", "v3", 290, [("crypto", 11.12, 11.5, ["emph"]), ("ki", 11.52, 11.6), ("value", 11.6, 11.9)]),
    ("preset-3", "v3", 240, [("ki", 9.36, 9.5), ("idhar", 9.5, 9.7), ("pichhle", 9.7, 10.0)]),
    ("preset-4", "v4", 34, [("make", 0.04, 0.3), ("trading", 0.40, 0.8, ["emph"]), ("more", 0.84, 1.0),
                                  ("accessible", 1.04, 1.40)]),
    ("preset-4", "v4", 340, [("automatically", 13.16, 13.88)]),
    ("preset-6", "v6", 60, [("I'm", 1.37, 1.5), ("the", 1.5, 1.62), ("Director", 1.63, 2.2, ["emph"])]),
    ("preset-6", "v6", 33, [("my", 0.37, 0.55), ("name's", 0.57, 0.72), ("Paul", 0.73, 1.2, ["emph"])]),
    ("preset-6", "v6", 275, [("was", 8.27, 8.4), ("I", 8.4, 8.6), ("started", 8.6, 9.3, ["emph"])]),
    ("preset-5", "v5", 60, [("negative", 1.95, 2.3)]),
    ("preset-5", "v5", 150, [("the", 4.8, 4.98), ("best", 5.0, 5.3)]),
]


def main():
    n = {}
    for preset, v, f, spec in CASES:
        fps = 30 if v in ("v5", "v6") else 25
        t = f / fps
        style = S.load_preset(preset)
        ws = words(spec)
        plan = Planner(style).plan(ws)
        R = Renderer(style, plan, 720, 1280)
        ours = R.frame(t, bg_for(v, f))
        ref = crop(frame(v, f), AFTER[v])
        ours_s = cv2.resize(ours, (ref.shape[1], ref.shape[0]), interpolation=cv2.INTER_AREA)
        k = 2 if ref.shape[1] < 500 else 1
        pair = np.hstack([ours_s, np.full((ref.shape[0], 8, 3), 255, np.uint8), ref])
        pair = cv2.resize(pair, (pair.shape[1] * k, pair.shape[0] * k), interpolation=cv2.INTER_CUBIC)
        n[preset] = n.get(preset, 0) + 1
        p = os.path.join(OUT, f"{preset}_{n[preset]}.jpg")
        cv2.imwrite(p, cv2.cvtColor(pair, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 88])
        print(p, [(s["mode"], [[x["text"] for x in l["tokens"]] for l in s["lines"]]) for s in plan["scenes"]])


def strip(name, case_idx, frames, y0, y1):
    """Entrada quadro a quadro: nossa linha em cima, referência embaixo."""
    preset, v, _, spec = CASES[case_idx]
    st = S.load_preset(preset)
    R = Renderer(st, Planner(st).plan(words(spec)), 720, 1280)
    fps = 30 if v in ("v5", "v6") else 25
    top, bot = [], []
    for f in frames:
        ref = crop(frame(v, f), AFTER[v])
        h, w = ref.shape[:2]
        ours = cv2.resize(R.frame(f / fps, bg_for(v, f)), (w, h), interpolation=cv2.INTER_AREA)
        a, b = int(y0 * h), int(y1 * h)
        top.append(ours[a:b].copy())
        bot.append(ref[a:b])
        cv2.putText(top[-1], str(f), (4, 14), 0, 0.45, (255, 255, 0), 1)
    img = np.vstack([np.hstack(top), np.hstack(bot)])
    img = cv2.resize(img, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)
    cv2.imwrite(os.path.join(OUT, f"anim_{name}.jpg"), cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 88])


def strips():
    strip("serifa", 3, [10, 12, 14, 16, 18, 20, 22], 0.58, 0.86)
    strip("preset-6", 5, [49, 51, 53, 55, 57, 60, 65], 0.45, 0.66)
    strip("preset-3", 1, [278, 280, 282, 284, 286, 288, 291], 0.55, 0.85)


if __name__ == "__main__":
    main()
    strips()


def compare_v7(preset="preset-8", times=(3.6, 13.5, 31.5, 33.0, 38.5, 41.4, 47.5, 51.5, 62.0)):
    """Preset 7/8 sobre a própria fala da referência v7 (analysis/v7/words.json), fundo #F5F5F5,
    lado a lado com o quadro original no mesmo instante."""
    import json
    raw = json.load(open(os.path.join(ROOT, "analysis", "v7", "words.json"), encoding="utf-8"))
    ws = [Word(t.strip(), s, e) for s, e, t in raw if t.strip()]
    st = S.load_preset(preset)
    plan = Planner(st).plan(ws)
    R = Renderer(st, plan, 720, 1280)
    bg = np.full((1280, 720, 3), 245, np.uint8)
    cols = []
    for t in times:
        ours = R.frame(t, bg)
        ref = frame("v7", int(round(t * 30)))
        pair = np.hstack([ours, np.full((1280, 6, 3), 200, np.uint8), ref])
        cols.append(cv2.resize(pair, (pair.shape[1] // 3, pair.shape[0] // 3), interpolation=cv2.INTER_AREA))
    grid = [np.hstack(cols[i:i + 3]) for i in range(0, len(cols), 3)]
    w = max(g.shape[1] for g in grid)
    grid = [np.hstack([g, np.full((g.shape[0], w - g.shape[1], 3), 255, np.uint8)]) for g in grid]
    out = os.path.join(OUT, f"v7_{preset}.jpg")
    cv2.imwrite(out, cv2.cvtColor(np.vstack(grid), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 88])
    return out, plan
