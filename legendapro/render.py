"""Compositor quadro a quadro (numpy + OpenCV + Pillow), sem frameworks de vídeo."""
import math
import os
import subprocess
import json

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(ROOT, "fonts")


def hex2rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)


def clamp01(x):
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def ease_out_cubic(p):
    return 1 - (1 - p) ** 3


def ease_in_out(p):
    return 3 * p * p - 2 * p * p * p


def ease_out_back(p, s=1.9):
    p -= 1
    return 1 + p * p * ((s + 1) * p + s)


# ---------------------------------------------------------------- fontes e sprites

class Fonts:
    def __init__(self, preset):
        self.spec = preset["fonts"]
        self.cache = {}

    def get(self, role, px):
        key = (role, px)
        if key not in self.cache:
            sp = self.spec[role]
            f = ImageFont.truetype(os.path.join(FONT_DIR, sp["file"]), px)
            if "weight" in sp:
                axes = f.get_variation_axes()
                f.set_variation_by_axes([float(sp["weight"]) if "eight" in str(a.get("name")) else a["default"]
                                         for a in axes])
            self.cache[key] = f
        return self.cache[key]

    def tracking(self, role):
        return self.spec[role].get("tracking", 0.0)


class Sprites:
    """Rasteriza tokens como máscaras (float32 0..1) com tracking manual."""

    def __init__(self, fonts):
        self.fonts = fonts
        self.cache = {}

    def measure(self, text, role, px):
        f = self.fonts.get(role, px)
        tr = self.fonts.tracking(role) * px
        adv = [f.getlength(text[:i]) + i * tr for i in range(len(text) + 1)]
        width = adv[-1] - tr if len(text) > 1 else adv[-1]
        x0, top, x1, bot = f.getbbox(text, anchor="ls")
        return {"adv": adv, "width": width, "top": top, "bottom": bot, "ink_l": x0,
                "ink_r": x1 + tr * (len(text) - 1), "space": f.getlength(" ") * 0.78}

    def get(self, text, role, px):
        key = (text, role, px)
        if key in self.cache:
            return self.cache[key]
        f = self.fonts.get(role, px)
        m = self.measure(text, role, px)
        pad = int(px * 0.35) + 4
        w = int(m["width"] + abs(m["ink_l"]) + 2 * pad + px * 0.3)
        asc, desc = f.getmetrics()
        h = int(asc + desc + 2 * pad)
        im = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(im)
        base_y = pad + asc
        ox = pad + max(0, -m["ink_l"])
        for i, ch in enumerate(text):
            d.text((ox + m["adv"][i], base_y), ch, font=f, fill=255, anchor="ls")
        mask = np.asarray(im, np.float32) / 255.0
        # origem = ponto (x inicial do texto, baseline) dentro do sprite
        spr = {"mask": mask, "ox": ox, "oy": base_y, "m": m}
        self.cache[key] = spr
        return spr


# ---------------------------------------------------------------- layout

def layout_scene(sc, preset, sprites, W, H):
    lay = preset["layout"]
    safe = lay["safe_width"] * W
    lines = []
    for ln in sc["lines"]:
        toks = []
        for t in ln["tokens"]:
            px = max(8, int(round(t["size"] * W)))
            toks.append({"t": t, "px": px})
        # encolhe a linha se passar da área segura
        for _ in range(6):
            for tk in toks:
                tk["m"] = sprites.measure(tk["t"]["text"], tk["t"]["role"], tk["px"])
            sp = max(tk["m"]["space"] for tk in toks)
            width = sum(tk["m"]["width"] for tk in toks) + sp * (len(toks) - 1)
            if width <= safe:
                break
            k = safe / width
            for tk in toks:
                tk["px"] = max(8, int(tk["px"] * k))
        top = min(tk["m"]["top"] for tk in toks)
        bot = max(tk["m"]["bottom"] for tk in toks)
        lines.append({"toks": toks, "width": width, "space": sp, "top": top, "bottom": bot,
                      "size": max(tk["px"] for tk in toks),
                      "serif": any(tk["t"]["role"] == "serif" for tk in toks), "src": ln})

    # vertical: baseline de cada linha
    y = 0.0
    for i, l in enumerate(lines):
        if i == 0:
            l["base"] = -l["top"]
        else:
            p = lines[i - 1]
            g = lay["serif_line_gap"] if (p["serif"] or l["serif"]) else lay["line_gap"]
            l["base"] = p["base"] + max(p["size"], l["size"]) * g - l["top"] + p["size"] * 0.0
        y = l["base"]
    # horizontal
    for l in lines:
        dx = l["src"].get("dx", 0.0) * W
        half = l["width"] / 2
        dx = max(-(safe / 2 - half), min(safe / 2 - half, dx)) if half < safe / 2 else 0
        x = W / 2 + dx - half
        for tk in l["toks"]:
            tk["x"] = x
            tk["base"] = l["base"]
            x += tk["m"]["width"] + l["space"]
        l["x0"] = W / 2 + dx - half
        l["x1"] = l["x0"] + l["width"]
    return lines


# ---------------------------------------------------------------- traços (decorações)

def ellipse_path(cx, cy, rx, ry, n=90):
    pts = []
    th0 = math.radians(200)
    span = math.radians(390)
    tilt = math.radians(-4)
    for k in range(n + 1):
        u = k / n
        th = th0 - span * u
        r = 1 + 0.07 * u
        x, y = rx * r * math.cos(th), ry * r * math.sin(th) * (1 - 0.06 * u)
        pts.append((cx + x * math.cos(tilt) - y * math.sin(tilt),
                    cy + x * math.sin(tilt) + y * math.cos(tilt)))
    return pts


def underline_path(x0, x1, y, size, n=70):
    w = x1 - x0
    pts = []
    # ida: da esquerda para a direita, levemente curvada
    for k in range(n // 2 + 1):
        u = k / (n // 2)
        pts.append((x0 - 0.04 * w + u * 1.12 * w, y + size * (0.02 - 0.09 * u + 0.08 * u * u)))
    # volta: gancho fino retornando por baixo
    ex, ey = pts[-1]
    for k in range(1, n // 2 + 1):
        u = k / (n // 2)
        pts.append((ex - u * 0.75 * w + 0.05 * w * math.sin(u * math.pi), ey + size * (0.10 * math.sin(u * math.pi * 0.9) + 0.03 * u)))
    return pts


# ---------------------------------------------------------------- compositor

class Canvas:
    """RGB uint8 (cor reta) + alfa uint8 opcional. A conta em float é feita só na região tocada,
    o que mantém o custo por frame proporcional ao texto e não à resolução."""

    def __init__(self, rgb, alpha=None):
        self.rgb = rgb
        self.a = alpha
        self.H, self.W = rgb.shape[:2]

    def fill(self, color):
        self.rgb[:] = np.round(color * 255).astype(np.uint8)
        if self.a is not None:
            self.a[:] = 255

    def blend(self, x0, y0, a, color):
        """a: máscara já com opacidade; color: (3,) 0..1 ou None=preto."""
        h, w = a.shape
        X0, Y0 = max(0, x0), max(0, y0)
        X1, Y1 = min(self.W, x0 + w), min(self.H, y0 + h)
        if X1 <= X0 or Y1 <= Y0:
            return
        sa = a[Y0 - y0:Y1 - y0, X0 - x0:X1 - x0]
        # recorta para a área realmente pintada (sprites têm muita margem vazia)
        bx, by, bw, bh = cv2.boundingRect((sa > 0.002).astype(np.uint8))
        if bw == 0 or bh == 0:
            return
        sa = sa[by:by + bh, bx:bx + bw]
        X0, Y0 = X0 + bx, Y0 + by
        X1, Y1 = X0 + bw, Y0 + bh
        sa3 = sa[..., None]
        roi = self.rgb[Y0:Y1, X0:X1].astype(np.float32)
        c = np.zeros(3, np.float32) if color is None else np.asarray(color, np.float32) * 255
        if self.a is None:
            out = roi * (1 - sa3) + sa3 * c
        else:
            # "over" com alfa reto
            A = self.a[Y0:Y1, X0:X1].astype(np.float32)[..., None] / 255
            oa = sa3 + A * (1 - sa3)
            out = (c * sa3 + roi * A * (1 - sa3)) / np.maximum(oa, 1e-4)
            self.a[Y0:Y1, X0:X1] = (oa[..., 0] * 255 + 0.5).astype(np.uint8)
        self.rgb[Y0:Y1, X0:X1] = np.clip(out + 0.5, 0, 255).astype(np.uint8)


def warp_mask(spr, ax, ay, scale, blur, extra=0):
    """Posiciona o sprite: ponto de origem (ox,oy) vai para (ax,ay) com escala. Retorna (x0,y0,mask)."""
    mask = spr["mask"]
    mh, mw = mask.shape
    margin = int(blur * 3 + extra + 3)
    # caixa do sprite transformado
    tx0 = ax - spr["ox"] * scale
    ty0 = ay - spr["oy"] * scale
    x0 = int(math.floor(tx0)) - margin
    y0 = int(math.floor(ty0)) - margin
    w = int(math.ceil(mw * scale)) + 2 * margin + 2
    h = int(math.ceil(mh * scale)) + 2 * margin + 2
    M = np.float32([[scale, 0, tx0 - x0], [0, scale, ty0 - y0]])
    out = cv2.warpAffine(mask, M, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
    if blur > 0.35:
        out = cv2.GaussianBlur(out, (0, 0), blur)
    return x0, y0, out


class Renderer:
    def __init__(self, preset, plan, W, H, alpha=False):
        self.p = preset
        self.plan = plan
        self.W, self.H = W, H
        self.alpha = alpha
        self.fonts = Fonts(preset)
        self.sprites = Sprites(self.fonts)
        self.fx = preset["effects"]
        self.red = preset["colors"]["red"]
        self.scenes = []
        for sc in plan["scenes"]:
            self.scenes.append(self.prepare(sc))
        self.flash_img = self.make_flash()

    # --------------------------------------------------------------
    def prepare(self, sc):
        W, H = self.W, self.H
        lay = self.p["layout"]
        lines = layout_scene(sc, self.p, self.sprites, W, H)
        top = lines[0]["base"] + lines[0]["top"]
        bot = lines[-1]["base"] + lines[-1]["bottom"]
        anchor = sc.get("anchor_y", lay["anchor_y"]) * H
        grow = "center" if sc["mode"] != "stack" else lay["grow"]
        # tempo em que cada linha aparece / sai
        for l in lines:
            l["t_in"] = min(tk["t"]["t_in"] for tk in l["toks"])
            l["t_out"] = l["src"].get("t_out", sc["t_out"])
        events = []
        if grow == "center":
            # centraliza sempre o conjunto de linhas visíveis (sobe conforme cresce)
            times = sorted(set([l["t_in"] for l in lines] + [l["t_out"] for l in lines if l["t_out"] < sc["t_out"]]))
            for t in times:
                vis = [l for l in lines if l["t_in"] <= t + 1e-6 and l["t_out"] > t + 1e-6]
                if not vis:
                    continue
                a = vis[0]["base"] + vis[0]["top"]
                b = vis[-1]["base"] + vis[-1]["bottom"]
                events.append((t, anchor - (a + b) / 2))
        else:
            # cresce para baixo; se a pilha final não couber, sobe tudo de uma vez
            first_h = lines[0]["bottom"] - lines[0]["top"]
            off = anchor - first_h / 2 - top
            limit = H * 0.9
            if off + bot > limit:
                off = limit - bot
            events.append((sc["t_in"], off))
        sc2 = dict(sc)
        sc2["L"] = lines
        sc2["events"] = events
        sc2["bg_rgb"] = hex2rgb(sc["bg"]) if sc.get("bg") else None
        for l in lines:
            for tk in l["toks"]:
                tk["rgb"] = hex2rgb(tk["t"]["color"])
        return sc2

    def offset(self, sc, t):
        ev = sc["events"]
        y = ev[0][1]
        for k in range(1, len(ev)):
            p = clamp01((t - ev[k][0]) / 0.2)
            y += (ev[k][1] - ev[k - 1][1]) * ease_in_out(p)
        if self.fx.get("drift"):
            dur = max(sc["t_out"] - sc["t_in"], 0.6)
            y += self.fx["drift"] * self.H * clamp01((t - sc["t_in"]) / dur)
        return y

    # estado de um token no tempo t
    def token_state(self, sc, l, li, tk, t):
        tt = tk["t"]
        W = self.W
        fx = self.fx
        tin = max(tt["t_in"], sc["t_in"])
        if t < tin - 1e-6:
            return None
        op, blur, scale, dy = 1.0, 0.0, 1.0, 0.0
        mode = tt["appear"]
        if mode == "blur":
            c = fx["blur_in"]
            p = clamp01((t - tin) / c["duration"])
            e = ease_out_cubic(p)
            op = clamp01(p * 1.7)
            blur = c["max_blur"] * W * (1 - e)
            scale = c["scale_from"] + (1 - c["scale_from"]) * e
        elif mode == "pop":
            c = fx["pop"]
            p = clamp01((t - tin) / c["duration"])
            op = 1.0
            scale = 1 + (c["scale_from"] - 1) * (1 - ease_out_back(p)) if p < 1 else 1.0
            dy = c["rise"] * self.H * (1 - ease_out_cubic(p))
        else:
            c = fx["cut"]
            p = clamp01((t - tin) / c["duration"])
            scale = c["scale_from"] + (1 - c["scale_from"]) * ease_out_cubic(p)
        if "flicker" in tt["fx"]:
            k = int((t - tin) * 30)
            pat = [1, 1, .3, .3, 1, 1, .45, .45, 1, 1, .6, 1, 1]
            if 0 <= k < len(pat):
                op *= pat[k]
        # saída
        t_out = l["t_out"]
        if sc["exit"] == "blur" or t_out < sc["t_out"]:
            c = fx["blur_out"]
            st = t_out + (c["stagger"] * li if t_out >= sc["t_out"] else 0)
            if t >= st:
                q = clamp01((t - st) / c["duration"])
                op *= (1 - q) ** 1.4
                blur += c["max_blur"] * W * q
                scale *= 1 + 0.03 * q
                if q >= 1:
                    return None
        elif t >= t_out:
            return None
        return op, blur, scale, dy

    def contrast_guard(self, cv, sc, oy):
        """Se a cor de destaque some no fundo (ex.: texto vermelho sobre camisa vermelha),
        troca todos os destaques da cena pela cor de reserva do preset."""
        sc["_guard"] = False
        if cv.a is not None or sc.get("bg"):
            return
        cols = self.p["colors"]
        text_rgb = hex2rgb(cols["text"])
        accents = [tk for l in sc["L"] for tk in l["toks"] if np.abs(tk["rgb"] - text_rgb).sum() > 0.1]
        if not accents:
            return
        fallback = hex2rgb(cols.get("red_fallback", cols["text"]))
        img = cv.rgb.astype(np.float32) / 255
        for tk in accents:
            m = tk["m"]
            x0, x1 = int(max(0, tk["x"])), int(min(self.W, tk["x"] + m["width"]))
            y0 = int(max(0, tk["base"] + oy + m["top"]))
            y1 = int(min(self.H, tk["base"] + oy + m["bottom"]))
            if x1 - x0 < 4 or y1 - y0 < 4:
                continue
            roi = np.ascontiguousarray(img[y0:y1, x0:x1])
            hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV).reshape(-1, 3)   # H 0..360, S/V 0..1
            th = cv2.cvtColor(tk["rgb"].reshape(1, 1, 3), cv2.COLOR_RGB2HSV)[0, 0]
            dh = np.abs(hsv[:, 0] - th[0])
            dh = np.minimum(dh, 360 - dh)
            # mesma família de tom, saturado e claro o bastante para "engolir" a palavra
            same = (dh < 28) & (hsv[:, 1] > 0.35) & (hsv[:, 2] > 0.3)
            close = (np.linalg.norm(roi.reshape(-1, 3) - tk["rgb"], axis=1) < 0.3)
            if (same | close).mean() > 0.22:
                sc["_guard"] = True
                break
        if sc["_guard"]:
            for tk in accents:
                tk["rgb_eff"] = fallback

    def draw_scene(self, cv, sc, t):
        if t < sc["t_in"] - 1e-6:
            return
        stagger = self.fx["blur_out"]["stagger"] * len(sc["L"])
        tail = self.fx["blur_out"]["duration"] + stagger if sc["exit"] == "blur" else 0
        if t >= sc["t_out"] + tail:
            return
        if sc["bg_rgb"] is not None and t < sc["t_out"]:
            cv.fill(sc["bg_rgb"])
        oy = self.offset(sc, t)
        W = self.W
        sh = self.fx["shadow"]
        if "_guard" not in sc:
            self.contrast_guard(cv, sc, oy)
        states = []
        for li, l in enumerate(sc["L"]):
            for tk in l["toks"]:
                s = self.token_state(sc, l, li, tk, t)
                if s is not None and s[0] > 0.003:
                    states.append((l, li, tk, s))
        # caixas vermelhas (atrás do texto)
        for l, li, tk, (op, blur, scale, dy) in states:
            if "box" in tk["t"]["fx"]:
                m = tk["m"]
                p = ease_out_cubic(clamp01((t - tk["t"]["t_in"]) / 0.14))
                padx, pady = tk["px"] * 0.16, tk["px"] * 0.07
                bx0 = tk["x"] - padx
                bx1 = tk["x"] + m["width"] + padx
                by0 = tk["base"] + oy + m["top"] - pady
                by1 = tk["base"] + oy + pady * 0.6
                bx1 = bx0 + (bx1 - bx0) * p
                x0, y0 = int(bx0), int(by0)
                a = np.zeros((max(1, int(by1) - y0), max(1, int(bx1) - x0)), np.float32)
                a[:] = op
                cv.blend(x0, y0, a, hex2rgb(self.red))
        # texto
        for l, li, tk, (op, blur, scale, dy) in states:
            spr = self.sprites.get(tk["t"]["text"], tk["t"]["role"], tk["px"])
            m = tk["m"]
            # escala em torno do centro do token
            cx = tk["x"] + m["width"] / 2
            cyb = tk["base"] + oy + dy
            mid = (m["top"] + m["bottom"]) / 2
            ax = cx - (m["width"] / 2) * scale
            ay = cyb + mid - mid * scale
            shadow_sig = sh["blur"] * W
            x0, y0, mask = warp_mask(spr, ax, ay, scale, blur, extra=shadow_sig * 3 + 4)
            if sh["opacity"] > 0 and sc.get("bg") is None:
                s = cv2.GaussianBlur(mask, (0, 0), shadow_sig)
                cv.blend(x0, y0 + int(sh["offset_y"] * W + 0.5), s * (op * sh["opacity"]), None)
            if "glow" in tk["t"]["fx"]:
                g = self.fx["glow_red"]
                gm = cv2.GaussianBlur(mask, (0, 0), g["blur"] * W)
                cv.blend(x0, y0, np.clip(gm * (op * g["opacity"]), 0, 1), tk.get("rgb_eff", tk["rgb"]))
            cv.blend(x0, y0, mask * op, tk.get("rgb_eff", tk["rgb"]))
        # decorações
        for d in sc.get("decos", []):
            self.draw_deco(cv, sc, d, t, oy)

    def draw_deco(self, cv, sc, d, t, oy):
        if t < d["t"]:
            return
        l = sc["L"][d["line"]]
        if t >= l["t_out"] + self.fx["blur_out"]["duration"]:
            return
        p = ease_in_out(clamp01((t - d["t"]) / (0.34 if d["kind"] == "ellipse" else 0.28)))
        op = 1.0
        if t >= l["t_out"]:
            op = 1 - clamp01((t - l["t_out"]) / self.fx["blur_out"]["duration"])
        W = self.W
        if d["kind"] == "ellipse":
            tk = l["toks"][d["token"] or 0]
            m = tk["m"]
            cx = tk["x"] + m["width"] / 2
            cy = tk["base"] + oy + (m["top"] + m["bottom"]) / 2
            pts = ellipse_path(cx, cy, m["width"] / 2 + tk["px"] * 0.32, (m["bottom"] - m["top"]) / 2 + tk["px"] * 0.25)
            th = max(2, int(W * 0.0042))
        else:
            y = l["base"] + oy + max(tk["m"]["bottom"] for tk in l["toks"]) * 0.35 + l["size"] * 0.16
            pts = underline_path(l["x0"], l["x1"], y, l["size"])
            th = max(2, int(W * 0.0036))
        n = max(2, int(len(pts) * p))
        pts = np.array(pts[:n], np.float32)
        x0, y0 = int(pts[:, 0].min()) - th * 4, int(pts[:, 1].min()) - th * 4
        x1, y1 = int(pts[:, 0].max()) + th * 4, int(pts[:, 1].max()) + th * 4
        S = 4  # subpixel
        mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
        ip = ((pts - [x0, y0]) * (1 << S)).astype(np.int32).reshape(-1, 1, 2)
        cv2.polylines(mask, [ip], False, 255, th, cv2.LINE_AA, shift=S)
        a = mask.astype(np.float32) / 255.0
        sh = self.fx["shadow"]
        cv.blend(x0, y0 + 1, cv2.GaussianBlur(a, (0, 0), 2.5) * (op * sh["opacity"] * 0.8), None)
        cv.blend(x0, y0, a * op, hex2rgb(d["color"]))

    # flash de luz ----------------------------------------------------
    def make_flash(self):
        H, W = self.H, self.W
        yy = np.linspace(-1, 1, H)[:, None]
        xx = np.linspace(-1, 1, W)[None, :]
        r = np.sqrt((xx * 0.8) ** 2 + (yy * 1.0) ** 2)
        cream = np.array([1.0, 0.975, 0.88], np.float32)
        orange = np.array([1.0, 0.55, 0.12], np.float32)
        k = np.clip((r - 0.55) / 0.7, 0, 1)[..., None].astype(np.float32)
        return cream * (1 - k) + orange * k

    def draw_flash(self, cv, t):
        D = self.fx.get("flash", {}).get("duration", 0.4)
        for tf in self.plan.get("flashes", []):
            u = (t - (tf - D * 0.35)) / D
            if 0 <= u <= 1:
                a = math.sin(math.pi * u) ** 0.6
                a = min(1.0, a * 1.15)
                # screen + leve lavagem para o creme
                f = cv.rgb.astype(np.float32) / 255
                f = 1 - (1 - f) * (1 - self.flash_img * a)
                f = f * (1 - 0.55 * a) + self.flash_img * (0.55 * a)
                cv.rgb[:] = np.clip(f * 255 + 0.5, 0, 255).astype(np.uint8)

    # --------------------------------------------------------------
    def frame(self, t, base=None):
        if base is None:
            rgb = np.zeros((self.H, self.W, 3), np.uint8)
            alpha = np.zeros((self.H, self.W), np.uint8) if self.alpha else None
        else:
            rgb = base.copy()
            alpha = None
        cv = Canvas(rgb, alpha)
        for sc in self.scenes:
            if sc["t_in"] - 0.01 <= t <= sc["t_out"] + 1.0:
                self.draw_scene(cv, sc, t)
        if not self.alpha:
            self.draw_flash(cv, t)
        if self.alpha:
            return np.dstack([cv.rgb, cv.a])
        return cv.rgb


# ---------------------------------------------------------------- vídeo (ffmpeg)

def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height,r_frame_rate,nb_frames:format=duration", "-of", "json", path],
                       capture_output=True, text=True, check=True)
    j = json.loads(r.stdout)
    s = j["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return int(s["width"]), int(s["height"]), float(num) / float(den), float(j["format"]["duration"])


class Cancelled(Exception):
    pass


def render_video(preset, plan, out, video=None, size=None, fps=30.0, duration=None, alpha=False,
                 progress=True, cancel=None, workers=None, gpu=True, crf=18):
    """Renderiza o vídeo final.

    progress: True (imprime), None/False ou função(frame, total).
    cancel:   função que retorna True para interromper.
    gpu:      usa NVENC (h264_nvenc) quando disponível.
    """
    from collections import deque
    from concurrent.futures import ThreadPoolExecutor
    from .gpu import nvenc_available

    if video:
        W, H, fps, dur = probe(video)
        if size:
            W, H = size
    else:
        W, H = size or (1080, 1920)
        dur = duration or (max(s["t_out"] for s in plan["scenes"]) + 0.6)
    if duration:
        dur = min(dur, duration)
    R = Renderer(preset, plan, W, H, alpha=alpha and not video)
    nframes = int(round(dur * fps))
    dec = None
    if video:
        vf = ["-vf", f"scale={W}:{H}"] if size else []
        dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", video, *vf, "-f", "rawvideo",
                                "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    if R.alpha:
        enc_args = ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le"]
        pix = "rgba"
    elif gpu and nvenc_available():
        enc_args = ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", str(crf), "-b:v", "0",
                    "-pix_fmt", "yuv420p"]
        pix = "rgb24"
    else:
        enc_args = ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p"]
        pix = "rgb24"
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", pix, "-s", f"{W}x{H}",
           "-r", f"{fps}", "-i", "-"]
    if video:
        cmd += ["-i", video, "-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += enc_args + (["-movflags", "+faststart"] if out.lower().endswith(".mp4") else []) + [out]
    enc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    fsz = W * H * 3
    workers = workers or max(2, min(6, (os.cpu_count() or 4) - 1))
    pending = deque()
    done = 0

    def report(k):
        if callable(progress):
            progress(k, nframes)
        elif progress and k % 30 == 0:
            print(f"\r  renderizando {k}/{nframes} frames", end="", flush=True)

    try:
        with ThreadPoolExecutor(workers) as ex:
            for k in range(nframes):
                if cancel and cancel():
                    raise Cancelled()
                base = None
                if dec:
                    buf = dec.stdout.read(fsz)
                    if len(buf) < fsz:
                        break
                    base = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
                pending.append(ex.submit(R.frame, k / fps, base))
                while len(pending) >= workers * 2:
                    enc.stdin.write(pending.popleft().result().tobytes())
                    done += 1
                    report(done)
            while pending:
                enc.stdin.write(pending.popleft().result().tobytes())
                done += 1
                report(done)
    finally:
        try:
            enc.stdin.close()
        except OSError:
            pass
        enc.wait()
        if dec:
            dec.stdout.close()
            dec.kill()
            dec.wait()
    if progress is True:
        print(f"\r  ok: {out}                         ")
    return out
