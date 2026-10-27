"""Transforma palavras com tempo em um plano de cenas (JSON editável).

Modos de cena:
  chunk  1-2 palavras numa linha, troca seca (o "miolo" da fala)
  stack  frase empilhada linha a linha, entrada com blur, mistura sans + serifada
  solo   palavra única grande com pop (falas pausadas e enfáticas)
  card   fundo chapado com palavra em serifada fina (citações / listas)
"""
import random
import re
import zlib

from . import nlp_pt as L
from .transcript import normalize, word_color


def _rng(words, salt=""):
    key = (" ".join(w.text for w in words) + salt).encode("utf-8")
    return random.Random(zlib.crc32(key))


# ---------------------------------------------------------------- segmentação

def split_sentences(words, gap=0.7):
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(i)
        nxt = words[i + 1] if i + 1 < len(words) else None
        brk = L.ends_sentence(w.text) or "break" in w.flags
        if nxt is not None:
            brk = brk or (nxt.start - w.end) > gap
            brk = brk or (("card" in w.flags) != ("card" in nxt.flags))
        if brk or nxt is None:
            out.append(cur); cur = []
    return out


def split_clauses(words, sent, gap=0.32, max_len=9):
    out, cur = [], []
    for k, i in enumerate(sent):
        cur.append(i)
        w = words[i]
        last = k == len(sent) - 1
        brk = L.ends_clause(w.text)
        if not last:
            brk = brk or (words[sent[k + 1]].start - w.end) > gap
        if brk or last:
            out.append(cur); cur = []
    # quebra clausulas longas: prefere cortar antes de conjunção ou na maior pausa, perto do meio
    res = []
    for c in out:
        while len(c) > max_len:
            best, best_s = len(c) // 2, -9.0
            for k in range(2, len(c) - 1):
                s = -abs(k - len(c) / 2) * 0.35
                if words[c[k]].norm in CONJ:
                    s += 1.6
                s += min(words[c[k]].start - words[c[k - 1]].end, 0.5) * 4
                if L.is_stop(words[c[k - 1]].text) and words[c[k - 1]].norm not in CONJ:
                    s -= 1.0
                if s > best_s:
                    best, best_s = k, s
            res.append(c[:best]); c = c[best:]
        res.append(c)
    return res


CONJ = set("e mas que porque se quando pra para onde aonde como entao ou".split())


def split_forced(words, cl):
    """Mais de uma palavra marcada como destaque na mesma oração: corta depois de cada uma,
    para que todas virem destaque (o motor faz um destaque por trecho)."""
    f = [k for k, i in enumerate(cl) if "emph" in words[i].flags]
    if len(f) <= 1:
        return [cl]
    parts, start = [], 0
    for k in f[:-1]:
        parts.append(cl[start:k + 1])
        start = k + 1
    parts.append(cl[start:])
    return [p for p in parts if p]


def repeated_trigram(words, idx):
    seen = set()
    norms = [words[i].norm for i in idx]
    for k in range(len(norms) - 2):
        g = tuple(norms[k:k + 3])
        if g in seen:
            return True
        seen.add(g)
    return False


# ---------------------------------------------------------------- construção de cenas

class Planner:
    def __init__(self, preset):
        self.p = preset
        self.lay = preset["layout"]
        self.rules = preset["rules"]
        self.fx = preset["effects"]
        self.col = preset["colors"]
        self._wid = {}

    # tokens ---------------------------------------------------------
    def tok(self, w, role="sans", scale=1.0, color=None, appear="blur", fx=None):
        uc = word_color(w)
        t = {
            "text": w.text, "role": role,
            "size": round(self.lay["base_size"] * scale, 5),
            "color": uc or color or self.col["text"],
            "t_in": round(w.start, 3), "appear": appear, "fx": list(fx or []),
            "wi": self._wid.get(id(w), -1),
        }
        if uc:
            t["user_color"] = True
        return t

    def emphasis_index(self, words, idx):
        forced = [i for i in idx if "emph" in words[i].flags or "red" in words[i].flags]
        if forced:
            return forced[-1]
        scores = [(L.score(words, i), i) for i in idx]
        s, i = max(scores)
        return i if s >= self.rules["emphasis_threshold"] else None

    # chunk ----------------------------------------------------------
    def chunks(self, words, idx):
        out, k = [], 0
        mx = self.rules["chunk_max_chars"]
        while k < len(idx):
            a = words[idx[k]]
            grp = [idx[k]]
            if k + 1 < len(idx):
                b = words[idx[k + 1]]
                short = len(a.norm) <= 3 or L.is_stop(a.text)
                fits = len(a.text) + 1 + len(b.text) <= mx
                tight = b.start - a.end < 0.25
                if short and fits and tight and not L.ends_clause(a.text):
                    grp.append(idx[k + 1])
            out.append(grp)
            k += len(grp)
        return out

    def scene_chunk(self, words, grp, mark_circle=False):
        toks = [self.tok(words[i], appear="cut") for i in grp]
        t0 = words[grp[0]].start - 0.02
        for t in toks:
            t["t_in"] = round(t0, 3)
        sc = {"mode": "chunk", "t_in": round(t0, 3), "exit": "cut",
              "lines": [{"tokens": toks, "dx": 0.0}], "decos": [], "words": grp}
        for j, i in enumerate(grp):
            if "red" in words[i].flags and not toks[j].get("user_color"):
                toks[j]["color"] = self.col["red"]
            if "box" in words[i].flags:
                toks[j]["fx"].append("box"); toks[j]["role"] = "sans_i"
            if "circle" in words[i].flags or (mark_circle and j == len(grp) - 1):
                sc["decos"].append({"kind": "ellipse", "line": 0, "token": j,
                                    "t": round(words[i].start + 0.08, 3), "color": self.col["accent"]})
            if "underline" in words[i].flags:
                sc["decos"].append({"kind": "underline", "line": 0, "token": None,
                                    "t": round(words[i].start + 0.1, 3), "color": self.col["text"]})
        return sc

    # solo -----------------------------------------------------------
    def scene_solo(self, words, i):
        w = words[i]
        color = self.col["red"] if ("red" in w.flags) else None
        t = self.tok(w, scale=self.lay["solo_scale"], appear="pop", color=color)
        t["t_in"] = round(w.start - 0.02, 3)
        return {"mode": "solo", "t_in": round(w.start - 0.02, 3), "exit": "cut",
                "lines": [{"tokens": [t], "dx": 0.0}], "decos": [], "words": [i]}

    # stack ----------------------------------------------------------
    def scene_stack(self, words, idx, e, rng, allow_box=True):
        rules, lay = self.rules, self.lay
        roll = 0
        lines = []          # cada linha: lista de (indice, role, scale, color, fx)
        k = 0
        n = len(idx)
        epos = idx.index(e) if e is not None else None
        red_e = e is not None and (L.is_red(words[e].text) or "red" in words[e].flags)
        plain = e is None
        while k < n:
            i = idx[k]
            w = words[i]
            if epos is not None and k == epos:
                lines.append([(i, "serif", lay["serif_scale"], "red" if red_e else None)])
                k += 1
                continue
            # linha pequena "a sua" antes da ênfase
            if epos is not None and k < epos and epos - k <= 2:
                lead = idx[k:epos]
                if all(words[j].norm in L.LEADERS for j in lead) \
                        and sum(len(words[j].text) for j in lead) <= 9:
                    lines.append([(j, "sans", lay["small_scale"], None) for j in lead])
                    k = epos
                    continue
            # caixa vermelha na negação de abertura
            if k == 0 and allow_box and rules.get("box_negation") and w.norm in ("nao", "nunca") and n >= 2:
                lines.append([(i, "sans_i", 1.3, None, "box")])
                k += 1
                continue
            grp = [i]
            lead_next = epos is not None and k + 1 < epos and epos - (k + 1) <= 2 and all(
                words[j].norm in L.LEADERS for j in idx[k + 1:epos])
            if k + 1 < n and (epos is None or k + 1 != epos) and not lead_next:
                b = words[idx[k + 1]]
                pairable = (len(w.norm) <= 3 or L.is_stop(w.text) or L.is_stop(b.text))
                if plain and self.fx.get("rolling_window"):
                    pairable = pairable and (len(w.norm) <= 2 or len(b.norm) <= 2)
                if pairable and len(w.text) + len(b.text) + 1 <= rules["chunk_max_chars"] \
                        and not L.ends_clause(w.text):
                    grp.append(idx[k + 1])
            scale = 1.0
            if all(L.is_stop(words[j].text) for j in grp) and epos is not None and k < epos:
                scale = lay["small_scale"]
            lines.append([(j, "sans", scale, None) for j in grp])
            k += len(grp)

        # negação vermelha antes da ênfase vermelha ("não faz *nada*")
        if red_e and rules.get("red_mode") == "serif":
            el = next(li for li, ln in enumerate(lines) if ln[0][0] == e)
            for back in (1, 2):
                if el - back >= 0 and words[lines[el - back][0][0]].norm == "nao":
                    for b in range(el - back, el):
                        lines[b] = [(j, "serif", lay["serif_scale"] * 0.8, "red") for j, *_ in lines[b]]
                    break

        # itálico na abertura ("Essa é", "você")
        if rules.get("sans_italic_lead") and lines and lines[0][0][1] == "sans" \
                and words[lines[0][0][0]].norm in L.LEAD_ITALIC:
            lines[0] = [(j, "sans_i", s, c, *rest) for (j, r, s, c, *rest) in lines[0]]

        if plain and self.fx.get("rolling_window"):
            roll = self.fx["rolling_window"]

        # serializa
        out_lines = []
        for li, ln in enumerate(lines):
            toks = []
            for item in ln:
                j, role, scale, color = item[:4]
                extra = item[4:] if len(item) > 4 else ()
                w = words[j]
                c = self.col["red"] if (color == "red" or "red" in w.flags) else None
                fx = list(extra)
                if c:
                    if self.fx.get("flicker"):
                        fx.append("flicker")
                    if self.fx.get("red_glow"):
                        fx.append("glow")
                if "box" in w.flags and "box" not in fx:
                    fx.append("box"); role = "sans_i"
                toks.append(self.tok(w, role=role, scale=scale, color=c, appear="blur", fx=fx))
            out_lines.append({"tokens": toks, "dx": 0.0})

        # zigue-zague
        z = lay["zigzag"]
        sign = rng.choice([-1, 1])
        for li, ln in enumerate(out_lines):
            if li == 0 and len(out_lines) > 1:
                ln["dx"] = round(-sign * z * rng.uniform(0.15, 0.5) * lay["base_size"], 5)
            elif li > 0:
                ln["dx"] = round(sign * z * rng.uniform(0.35, 1.0) * lay["base_size"], 5)
                sign = -sign

        if self.rules.get("capitalize_stacks", True) and out_lines and (idx[0] == 0 or L.ends_sentence(words[idx[0] - 1].text)
                                                                       or words[idx[0]].norm == "nao"):
            t0 = out_lines[0]["tokens"][0]
            t0["text"] = t0["text"][:1].upper() + t0["text"][1:]
        sc = {"mode": "stack", "t_in": round(words[idx[0]].start - 0.03, 3), "exit": "blur",
              "lines": out_lines, "decos": [], "words": list(idx), "roll": roll}
        for li, ln in enumerate(out_lines):
            for tj, t in enumerate(ln["tokens"]):
                wi = [j for j in idx if words[j].norm == normalize(t["text"]) and abs(words[j].start - t["t_in"]) < 1e-3]
                if wi and "circle" in words[wi[0]].flags:
                    sc["decos"].append({"kind": "ellipse", "line": li, "token": tj,
                                        "t": round(t["t_in"] + 0.1, 3), "color": self.col["accent"]})
                if wi and "underline" in words[wi[0]].flags:
                    sc["decos"].append({"kind": "underline", "line": li, "token": None,
                                        "t": round(t["t_in"] + 0.12, 3), "color": self.col["text"]})
        return sc

    # card -----------------------------------------------------------
    def scenes_card(self, words, clauses, bg_start):
        out = []
        for ci, cl in enumerate(clauses):
            k = (bg_start + ci) % len(self.col["card_bg"])
            bg, fg = self.col["card_bg"][k], self.col["card_text"][k]
            grps, j = [], 0
            while j < len(cl):
                g = [cl[j]]
                if j + 1 < len(cl) and len(words[cl[j]].norm) <= 2 and len(words[cl[j + 1]].text) <= 8:
                    g.append(cl[j + 1])
                grps.append(g); j += len(g)
            for g in grps:
                toks = [self.tok(words[i], role="card", scale=self.lay.get("card_scale", 0.66), color=fg, appear="cut") for i in g]
                t0 = words[g[0]].start - 0.02
                for t in toks:
                    t["t_in"] = round(t0, 3)
                out.append({"mode": "card", "t_in": round(t0, 3), "exit": "cut", "bg": bg,
                            "anchor_y": 0.5, "lines": [{"tokens": toks, "dx": 0.0}], "decos": [],
                            "words": g})
        return out

    # ----------------------------------------------------------------
    def pick_emphasis(self, words, units):
        """Escolhe as ênfases do vídeo inteiro com orçamento e espaçamento mínimo."""
        rules = self.rules
        dur = max(words[-1].end - words[0].start, 1.0)
        budget = max(1, int(dur / max(rules.get("emphasis_every", 4.5), 0.1) + 0.5))
        gap = rules.get("emphasis_gap", 2.5)
        cands = []
        for u, (si, ci, cl, card) in enumerate(units):
            if card:
                continue
            forced = [i for i in cl if "emph" in words[i].flags or "red" in words[i].flags]
            if forced:
                cands.append((99.0, u, forced[-1]))
                continue
            if rules.get("emphasis_every", 4.5) <= 0:
                continue
            off = any("noemph" in words[i].flags for i in cl)
            # destaque desligado à mão: o trecho continua ocupando a vaga dele (nada aparece
            # em outro lugar no lugar dele), mas fica sem destaque
            s, i = max((L.score(words, i, ignore_off=off), i) for i in cl)
            if off:
                i = None
            if u == 0 and s >= 1.5:
                s = 98.0  # o gancho (primeira frase) sempre ganha ênfase
            if s >= rules["emphasis_threshold"]:
                cands.append((s, u, i))
        cands.sort(reverse=True)
        chosen, times, used = {}, [], 0
        for s, u, i in cands:
            t = words[i if i is not None else units[u][2][0]].start
            if s < 99 and (used >= budget or any(abs(t - x) < gap for x in times)):
                continue
            used += 1
            times.append(t)
            if i is not None:
                chosen[u] = i
        return chosen

    # motor "frase" -------------------------------------------------
    # Presets com rules.engine = "phrase": cada trecho vira um bloco curto (plain) ou uma
    # palavra-herói grande com linhas de apoio pequenas acima/abaixo (hero).
    def ptext(self, w):
        t = w.text
        r = self.rules
        if r.get("strip_punct"):
            t = re.sub(r"[%s]+$" % re.escape(r["strip_punct"]), "", t) or t
        t = t.replace("’", "'")
        case = r.get("case", "keep")
        if case == "lower":
            t = t.lower()
        elif case == "upper":
            t = t.upper()
        return t

    def ptok(self, w, kind):
        """kind: plain | support | hero | serif (papel de fonte e de animação)."""
        lay, col = self.lay, self.col
        role = {"plain": "sans", "support": "sans", "italic": "italic", "hero": "hero", "serif": "serif"}[kind]
        scale = {"plain": 1.0, "support": lay.get("support_scale", 1.0), "italic": lay.get("support_scale", 1.0),
                 "hero": lay.get("hero_scale", 2.5), "serif": lay.get("serif_scale", 1.6)}[kind]
        color = None
        fx = []
        if kind == "hero":
            color = col["red"] if "red" in w.flags else col.get("hero", col["text"])
            fx.append("glow")
        elif "red" in w.flags:
            color = col["red"]
        # herói curto ("Paul", "Não") fica ainda maior, como nas referências
        if kind == "hero" and lay.get("hero_short_scale") and len(w.norm) <= lay.get("hero_short_chars", 4):
            scale *= lay["hero_short_scale"]
        t = self.tok(w, role=role, scale=scale, color=color, fx=fx)
        t["text"] = self.ptext(w)
        t["anim"] = "support" if kind == "italic" else kind
        return t

    def plain_groups(self, words, idx):
        """Blocos curtos na ordem da fala: junta até N palavras / M letras, sem atravessar
        fim de oração e sem deixar um artigo colado antes da palavra forte."""
        r = self.rules
        mw, mc = r.get("chunk_max_words", 2), r.get("chunk_max_chars", 14)
        out, cur = [], []
        for k, i in enumerate(idx):
            w = words[i]
            if cur:
                prev = words[cur[-1]]
                chars = sum(len(words[j].text) + 1 for j in cur) + len(w.text)
                lone_article = r.get("article_alone") and len(cur) == 1 and prev.norm in L.LEADERS \
                    and L.score(words, i) >= r.get("emphasis_threshold", 2.4)
                if len(cur) >= mw or chars > mc or L.ends_clause(prev.text) or lone_article \
                        or w.start - prev.end > r.get("chunk_pause", 0.35) or "break" in prev.flags:
                    out.append(cur); cur = []
            cur.append(i)
        if cur:
            out.append(cur)
        return out

    def phrase_scene(self, words, mode, lines):
        """lines: [(kind_da_linha, [(i, kind_do_token)])]"""
        fx = self.fx
        anim = fx.get("anim", {})
        t0 = min(words[i].start for _, toks in lines for i, _ in toks) - fx.get("lead", 0.02)
        out_lines, idx = [], []
        for lk, toks in lines:
            tl = []
            for i, kind in toks:
                t = self.ptok(words[i], kind)
                # revelação palavra a palavra (no tempo da fala) ou o bloco inteiro de uma vez
                # o papel de animação (t["anim"]) e não o tipo da linha: itálico anima como apoio
                if anim.get(t["anim"], {}).get("reveal", "scene") == "word":
                    t["t_in"] = round(max(t0, words[i].start - fx.get("lead", 0.02)), 3)
                else:
                    t["t_in"] = round(t0, 3)
                tl.append(t)
                idx.append(i)
            if lk == "hero" and len(tl) > 1 and self.lay.get("hero_short_scale"):
                total = sum(len(normalize(t["text"])) for t in tl)
                size = self.lay["base_size"] * self.lay.get("hero_scale", 2.5)
                if total <= self.lay.get("hero_short_chars", 4):
                    size *= self.lay["hero_short_scale"]
                for t in tl:
                    t["size"] = round(size, 5)
            out_lines.append({"tokens": tl, "kind": lk, "dx": 0.0})
        sc = {"mode": mode, "t_in": round(t0, 3), "exit": fx.get("exit", {}).get("type", "cut"),
              "lines": out_lines, "decos": [], "words": idx}
        # elipse / sublinhado marcados à mão continuam valendo
        for li, ln in enumerate(out_lines):
            for tj, t in enumerate(ln["tokens"]):
                w = words[t["wi"]]
                if "circle" in w.flags:
                    sc["decos"].append({"kind": "ellipse", "line": li, "token": tj,
                                        "t": round(t["t_in"] + 0.1, 3), "color": self.col.get("accent", "#FFFFFF")})
                if "underline" in w.flags:
                    sc["decos"].append({"kind": "underline", "line": li, "token": None,
                                        "t": round(t["t_in"] + 0.12, 3), "color": t["color"]})
        return sc

    def plan_phrase(self, words):
        rules = self.rules
        units = []
        for si, sent in enumerate(split_sentences(words, gap=rules.get("sentence_gap", 0.7))):
            parts = [p for cl in split_clauses(words, sent, max_len=rules.get("phrase_max_words", 7))
                     for p in split_forced(words, cl)]
            for ci, cl in enumerate(parts):
                units.append((si, ci, cl, False))
        emph = self.pick_emphasis(words, units)
        ms, mc = rules.get("support_max_words", 3), rules.get("support_max_chars", 18)
        scenes = []

        def plain(idx):
            for g in self.plain_groups(words, idx):
                scenes.append(self.phrase_scene(words, "plain", [("plain", [(i, "plain") for i in g])]))

        for u, (si, ci, cl, _) in enumerate(units):
            e = emph.get(u)
            if e is None:
                plain(cl)
                continue
            k = cl.index(e)
            hero = [e]
            # número + unidade viram um herói só ("$40 trillion", "10 mil")
            if rules.get("hero_number_unit", True) and k + 1 < len(cl) and re.search(r"\d", words[e].text) \
                    and not L.ends_clause(words[e].text) and len(words[cl[k + 1]].text) <= 9:
                hero.append(cl[k + 1])
            before, after = cl[:k], cl[k + len(hero):]
            above = before[-ms:]
            while above and sum(len(words[j].text) + 1 for j in above) > mc:
                above = above[1:]
            head = before[:len(before) - len(above)]
            below = after[:ms]
            while below and sum(len(words[j].text) + 1 for j in below) > mc:
                below = below[:-1]
            tail = after[len(below):]
            serif = []
            # cauda serifada: nome próprio logo depois do herói ("Peak *Architects*")
            if rules.get("serif_tail") and below and words[below[0]].text[:1].isupper():
                serif, below = [below[0]], below[1:]
            plain(head)
            lines = []
            if above:
                lines.append(("above", [(i, "support") for i in above]))
            lines.append(("hero", [(i, "hero") for i in hero]))
            if serif:
                lines.append(("serif", [(i, "serif") for i in serif]))
            if below:
                lines.append(("below", [(i, "support") for i in below]))
            scenes.append(self.phrase_scene(words, "hero", lines))
            plain(tail)

        self.timing(scenes, words)
        for sc in scenes:
            sc.pop("words", None)
        return {"preset": self.p["name"], "scenes": scenes, "flashes": []}

    # blocos que acumulam (rules.layout_engine = "stack") ------------------------
    # Cada frase vira um bloco de várias linhas que vai crescendo palavra a palavra:
    # apoio (regular) → herói (bold) → continuação (itálico) → fecho (bold itálico).
    def text_lines(self, words, idx, max_words, max_chars):
        out, cur = [], []
        for i in idx:
            chars = sum(len(words[j].text) + 1 for j in cur) + len(words[i].text)
            if cur and (len(cur) >= max_words or chars > max_chars):
                out.append(cur); cur = []
            cur.append(i)
        if cur:
            out.append(cur)
        return out

    def plan_blocks(self, words):
        rules = self.rules
        sw, sc_ = rules.get("support_max_words", 6), rules.get("support_max_chars", 32)
        hw, hc = rules.get("hero_max_words", 3), rules.get("hero_max_chars", 14)
        bw, bd = rules.get("block_max_words", 14), rules.get("block_max_dur", 5.0)
        # unidades = orações; blocos = frases (cortadas por tamanho/duração)
        units, blocks = [], []
        for si, sent in enumerate(split_sentences(words, gap=rules.get("block_pause", 0.6))):
            cur = []
            for cl in split_clauses(words, sent, max_len=rules.get("phrase_max_words", 9)):
                for part in split_forced(words, cl):
                    n = sum(len(u) for u in cur)
                    if cur and (n + len(part) > bw or words[part[-1]].end - words[cur[0][0]].start > bd):
                        blocks.append(cur); cur = []
                    cur.append(part)
                    units.append((si, len(units), part, False))
            if cur:
                blocks.append(cur)
        emph = self.pick_emphasis(words, units)
        heroes = set(emph.values())
        # quase todo bloco tem uma palavra forte (como na referência): se o orçamento não deu
        # nenhuma, usa a de maior pontuação do bloco (a menos que o destaque tenha sido desligado)
        for block in blocks:
            idx = [i for part in block for i in part]
            if not heroes.intersection(idx) and not any("noemph" in words[i].flags for i in idx):
                best, i = max((L.score(words, i), i) for i in idx)
                if best >= rules.get("block_hero_min", 1.5):
                    heroes.add(i)

        scenes = []
        for bi, block in enumerate(blocks):
            idx = [i for part in block for i in part]
            # papel de cada palavra: antes do 1º herói = apoio; herói (+ número/unidade, nome
            # composto); depois = continuação em itálico. Palavras seguidas do mesmo papel formam
            # linhas contínuas (as pausas da fala não quebram linha).
            role, k = [], 0
            seen_hero = False
            while k < len(idx):
                i = idx[k]
                if i in heroes:
                    grp = [i]
                    # número antes do herói entra junto ("30 seconds", "6 Person Team")
                    if role and role[-1][0] != "hero" and re.search(r"\d", words[role[-1][1]].text) \
                            and not L.ends_clause(words[role[-1][1]].text):
                        grp.insert(0, role.pop()[1])
                    for j in idx[k + 1:]:
                        w, prev = words[j], words[grp[-1]]
                        joined = sum(len(words[x].text) + 1 for x in grp) + len(w.text)
                        if len(grp) >= hw or joined > hc or L.ends_clause(prev.text):
                            break
                        if re.search(r"\d", words[grp[0]].text) or (w.text[:1].isupper() and words[i].text[:1].isupper()):
                            grp.append(j)
                        else:
                            break
                    role += [("hero", j) for j in grp]
                    k = idx.index(grp[-1]) + 1
                    seen_hero = True
                    role.append(("cut", None))   # cada herói é uma linha própria
                    continue
                role.append(("italic" if seen_hero else "support", i))
                k += 1
            lines, run, kind = [], [], None
            for kd, i in role + [("cut", None)]:
                if kd != kind or kd == "cut":
                    if run:
                        lines += [(kind, [run[0]] + run[1:])] if kind == "hero" else \
                            [(kind, ln) for ln in self.text_lines(words, run, sw, sc_)]
                    run, kind = [], kd
                if i is not None:
                    run.append(i)
            # fecho da frase com palavra forte: bold itálico
            if lines and lines[-1][0] == "italic" and L.ends_sentence(words[lines[-1][1][-1]].text) \
                    and max(L.score(words, i) for i in lines[-1][1]) >= rules.get("emphasis_threshold", 2.4):
                lines[-1] = ("hero_italic", lines[-1][1])
            # blocos com linhas demais viram dois
            ml = rules.get("max_lines", 4)
            for g in range(0, len(lines), ml):
                scenes.append(self.block_scene(words, lines[g:g + ml], bi == 0))
        self.timing(scenes, words)
        for sc in scenes:
            sc.pop("words", None)
        return {"preset": self.p["name"], "scenes": scenes, "flashes": []}

    def block_scene(self, words, lines, hook):
        kinds = {"support": "support", "italic": "italic", "hero": "hero", "hero_italic": "serif"}
        spec = [(lk, [(i, kinds[lk]) for i in idx]) for lk, idx in lines]
        sc = self.phrase_scene(words, "block", spec)
        for ln in sc["lines"]:
            n = len(ln["tokens"])
            for t in ln["tokens"]:
                t["line_n"] = n            # direção automática da entrada (linha longa vem da direita)
            # caixa: marcada à mão ([texto]) ou fecho do gancho com número ("in 30 seconds")
            if any("box" in words[t["wi"]].flags for t in ln["tokens"]):
                ln["box"] = True
        last = sc["lines"][-1]
        if hook and self.rules.get("box_hook") and len(sc["lines"]) >= 3 \
                and any(re.search(r"\d", t["text"]) for t in last["tokens"]):
            last["box"] = True
        return sc

    def plan(self, words):
        rules = self.rules
        self._wid = {id(w): i for i, w in enumerate(words)}
        if rules.get("engine") == "phrase" and rules.get("layout_engine") == "stack":
            return self.plan_blocks(words)
        if rules.get("engine") == "phrase":
            return self.plan_phrase(words)
        scenes = []
        sents = split_sentences(words)
        last_mode = None
        last_circle = last_under = last_box = -99.0
        last_stack_end = -99.0
        card_bg = 0

        units = []
        for si, sent in enumerate(sents):
            sw = [words[i] for i in sent]
            is_card = all("card" in w.flags for w in sw)
            if not is_card and rules["cards"]["enabled"] and rules["cards"].get("auto_repetition") \
                    and 8 <= len(sent) <= 28 and repeated_trigram(words, sent):
                is_card = True
            if is_card and rules["cards"]["enabled"]:
                units.append((si, 0, sent, True))
                continue
            parts = [p for cl in split_clauses(words, sent, max_len=rules["stack_max_words"] + 1)
                     for p in split_forced(words, cl)]
            for ci, cl in enumerate(parts):
                units.append((si, ci, cl, False))
        emph = self.pick_emphasis(words, units)

        for u, (si, ci, cl, card) in enumerate(units):
            if card:
                cls = split_clauses(words, cl, max_len=6)
                scenes += self.scenes_card(words, cls, card_bg)
                card_bg += len(cls)
                last_mode = "card"
                continue
            if True:
                rng2 = _rng([words[i] for i in cl], f"{si}.{ci}")
                n = len(cl)
                e = emph.get(u)
                pace = (words[cl[-1]].end - words[cl[0]].start) / max(n, 1)
                solo_cfg = rules["solo"]
                forced_solo = [i for i in cl if "solo" in words[i].flags]
                first_clause = si == 0 and ci == 0

                if forced_solo:
                    mode = "solo"
                elif solo_cfg["enabled"] and 2 <= n <= solo_cfg["max_words"] and pace >= solo_cfg["min_pace"] \
                        and last_mode != "solo" and not first_clause and rng2.random() < solo_cfg["probability"] \
                        and all(len(words[i].text) <= 11 for i in cl):
                    mode = "solo"
                elif e is not None and rules["stack_min_words"] <= n <= rules["stack_max_words"]:
                    mode = "stack"
                elif e is not None and n > rules["stack_max_words"]:
                    mode = "split"
                elif first_clause and 2 <= n <= rules["stack_max_words"]:
                    mode = "stack"
                elif 3 <= n <= 6 and last_mode != "stack" and words[cl[0]].start - last_stack_end > 2.5 and rng2.random() < rules["stack_plain_probability"]:
                    mode = "stack"; e = None
                else:
                    mode = "chunk"

                if mode == "solo":
                    for i in cl:
                        scenes.append(self.scene_solo(words, i))
                elif mode in ("stack", "split"):
                    allow_box = words[cl[0]].start - last_box > rules.get("box_cooldown", 8.0) and n <= 5 and L.ends_sentence(words[cl[-1]].text)
                    sc = self.scene_stack(words, cl, e, rng2, allow_box) if mode == "stack" else None
                    head, tail = [], []
                    if sc is None or len(sc["lines"]) > self.lay["max_stack_lines"]:
                        if e is None:
                            sc = None
                        else:
                            # janela em volta da ênfase; o resto vira chunk
                            epos = cl.index(e)
                            a = max(0, epos - 2)
                            b = min(n, epos + 3)
                            head, win, tail = cl[:a], cl[a:b], cl[b:]
                            sc = self.scene_stack(words, win, e, rng2, allow_box and a == 0)
                    for g in self.chunks(words, head):
                        scenes.append(self.scene_chunk(words, g))
                    if sc is None:
                        for g in self.chunks(words, cl):
                            scenes.append(self.scene_chunk(words, g))
                        mode = "chunk"
                    else:
                        if any("box" in t["fx"] for ln in sc["lines"] for t in ln["tokens"]):
                            last_box = words[cl[0]].start
                        last_line = sc["lines"][-1]["tokens"]
                        t_last = last_line[-1]["t_in"]
                        ends = L.ends_sentence(words[sc["words"][-1]].text)
                        has_red = any(t["color"] == self.col["red"] for ln in sc["lines"] for t in ln["tokens"])
                        if ends and rules["underline"]["probability"] > 0 and not sc["decos"]                                 and last_line[0]["role"].startswith("sans") and len(sc["lines"]) >= 3                                 and t_last - last_under > rules["underline"]["cooldown"]                                 and rng2.random() < rules["underline"]["probability"]:
                            sc["decos"].append({"kind": "underline", "line": len(sc["lines"]) - 1, "token": None,
                                                "t": round(t_last + 0.12, 3),
                                                "color": self.col["text"] if has_red else self.col["red"]})
                            last_under = t_last
                        scenes.append(sc)
                        mode = "stack"
                    for g in self.chunks(words, tail):
                        scenes.append(self.scene_chunk(words, g))
                else:
                    groups = self.chunks(words, cl)
                    for gi, g in enumerate(groups):
                        circle = False
                        lastw = words[g[-1]]
                        if any("circle" in words[i].flags for i in g):
                            last_circle = lastw.start
                        if gi == len(groups) - 1 and L.ends_sentence(lastw.text) \
                                and rules["ellipse"]["probability"] > 0 and len(g) == 1 \
                                and L.score(words, g[-1]) >= rules["emphasis_threshold"] - 0.6 \
                                and lastw.start - last_circle > rules["ellipse"]["cooldown"] \
                                and rng2.random() < rules["ellipse"]["probability"]:
                            circle = True
                            last_circle = lastw.start
                        scenes.append(self.scene_chunk(words, g, mark_circle=circle))
                if mode == "stack":
                    last_stack_end = words[cl[-1]].end
                last_mode = mode

        self.timing(scenes, words)
        flashes = self.flashes(scenes, words, sents)
        for sc in scenes:
            sc.pop("words", None)
        return {"preset": self.p["name"], "scenes": scenes, "flashes": flashes}

    # tempos de saída ------------------------------------------------
    def timing(self, scenes, words):
        hold = self.rules["max_hold"]
        for k, sc in enumerate(scenes):
            last_end = max(words[i].end for i in sc["words"])
            nxt = scenes[k + 1]["t_in"] if k + 1 < len(scenes) else None
            if sc["exit"] == "blur":
                bo = self.fx["blur_out"]
                natural = last_end + hold
                if nxt is None:
                    t_out = natural
                elif bo.get("overlap", True):
                    t_out = min(nxt - 0.06, natural)
                elif nxt - last_end >= bo["duration"] + 0.05:
                    t_out = min(natural, nxt - bo["duration"])
                else:
                    t_out = nxt
                    sc["exit"] = "cut"
            elif sc["exit"] == "fade":
                # fade que termina exatamente quando o próximo bloco começa; sem tempo, corte seco
                d = self.fx.get("exit", {}).get("duration", 0.25)
                if nxt is None:
                    t_out = last_end + hold
                elif nxt - last_end >= d + 0.05:
                    t_out = min(nxt - d, last_end + hold)
                else:
                    t_out = nxt
                    sc["exit"] = "cut"
            else:
                t_out = min(nxt, last_end + hold) if nxt is not None else last_end + hold
            sc["t_out"] = round(max(t_out, sc["t_in"] + 0.15), 3)
            # rolagem: linhas antigas saem quando a linha k+janela entra
            if sc.get("roll"):
                r = sc["roll"]
                for li, ln in enumerate(sc["lines"]):
                    if li + r < len(sc["lines"]):
                        ln["t_out"] = sc["lines"][li + r]["tokens"][0]["t_in"]

    def flashes(self, scenes, words, sents):
        cfg = self.fx.get("flash", {})
        if not cfg.get("enabled"):
            return []
        out, last = [], -99.0
        for si in range(len(sents) - 1):
            a, b = words[sents[si][-1]], words[sents[si + 1][0]]
            card_edge = ("card" in a.flags) != ("card" in b.flags)
            t = b.start - 0.04
            if si == 0 and t < 6.0:
                out.append(round(t, 3)); last = t; continue
            if (b.start - a.end > 0.45 and t - last >= cfg["min_interval"]) or (card_edge and t - last > 2):
                out.append(round(t, 3)); last = t
        # flashes também nas bordas dos cards automáticos
        for k in range(1, len(scenes)):
            if (scenes[k]["mode"] == "card") != (scenes[k - 1]["mode"] == "card"):
                t = scenes[k]["t_in"]
                if all(abs(t - f) > 1.0 for f in out):
                    out.append(round(t, 3))
        return sorted(out)
