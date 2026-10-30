"use strict";
/* LegendaPRO — interface local */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const S = {
  status: null, presets: [], fonts: [], projects: [], builtin: [],
  cur: null,          // projeto aberto (dados do servidor)
  base: null,         // preset base (json) do bloco de estilo editado
  overrides: {},      // ajustes do bloco editado
  secs: {},           // blocos de estilo ({estilo:id} no texto): id -> {preset, overrides}
  sec: "",            // bloco editado na aba Estilo ("" = o 1º, estilo do projeto)
  plan: null,
  t: 0,
  jobs: {},           // id -> job
  sel: [],            // palavras selecionadas (índices de plan.words)
  anchor: null,       // início da seleção com shift
  hits: [],           // caixas das palavras visíveis no quadro atual
  dirty: false,       // texto editado e ainda não salvo
  showAdv: false,     // ajustes avançados visíveis na aba Estilo
  uploadPreset: null, // estilo escolhido na tela inicial
  projSearch: "",
  cuts: [],           // trechos cortados do vídeo [[início, fim]] (segundos do vídeo ORIGINAL)
  splits: [],         // divisões da lâmina (segundos do vídeo original; só marcam clipes)
  fmt: null,          // formatação copiada de uma palavra {flags, color, word}
};

/* ------------------------------------------------------------ motor
   A interface roda de dois jeitos: servida pelo próprio motor (http://127.0.0.1:7860) ou pelo site
   (Cloudflare Pages). No site, ela procura o motor instalado no PC (portas 7860–7869) e manda tudo para
   ele: os vídeos vão do navegador direto para o PC da pessoa, nunca para o site. */
const LOCAL_UI = ["127.0.0.1", "localhost"].includes(location.hostname);
let ENGINE = "";                         // "" = mesmo endereço; no site, "http://127.0.0.1:<porta>"
const E = p => (typeof p === "string" && p[0] === "/" ? ENGINE + p : p);

/* ------------------------------------------------------------ utilidades */
let engineLostShown = false;
async function engineAlive() {
  // uma conexão recusada solta não quer dizer que o motor fechou: confere algumas vezes antes
  for (let k = 0; k < 3; k++) {
    try { if ((await fetch(`${ENGINE}/api/status`, { cache: "no-store" })).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
async function engineLost() {
  // site: o motor foi fechado no meio do uso. Mostra a tela de abrir e recarrega quando ele voltar.
  if (LOCAL_UI || engineLostShown) return;
  engineLostShown = true;
  if (await engineAlive()) { engineLostShown = false; return; }
  $("#gateTitle").textContent = "O motor do LegendaPRO foi fechado";
  $("#gate").hidden = false;
  const again = async () => { (await probeEngine()) ? location.reload() : setTimeout(again, 2000); };
  setTimeout(again, 1500);
}
const api = async (path, opts = {}) => {
  let r;
  const send = () => fetch(E(path), {
    ...opts,
    headers: opts.body && !(opts.body instanceof Blob) ? { "Content-Type": "application/json" } : undefined,
    body: opts.body && !(opts.body instanceof Blob) ? JSON.stringify(opts.body) : opts.body,
  });
  try { r = await send(); } catch (e) {
    // leitura que falhou na conexão: tenta de novo uma vez antes de dar o motor como fechado
    if ((opts.method || "GET") !== "GET") { engineLost(); throw e; }
    try { r = await send(); } catch (e2) { engineLost(); throw e2; }
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `erro ${r.status}`);
  return data;
};
const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
const fmtTime = s => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r.toFixed(2).padStart(5, "0")}`;
};
const fmtDate = s => {
  const d = new Date(s * 1000), now = new Date();
  const hm = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? `hoje, ${hm}` : `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}, ${hm}`;
};
const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
const setPath = (o, p, v) => {
  const ks = p.split("."); let a = o;
  ks.slice(0, -1).forEach(k => { if (typeof a[k] !== "object" || a[k] === null) a[k] = {}; a = a[k]; });
  a[ks.at(-1)] = v;
};
const delPath = (o, p) => {
  const ks = p.split("."); const stack = [o]; let a = o;
  for (const k of ks.slice(0, -1)) { if (!a[k]) return; a = a[k]; stack.push(a); }
  delete a[ks.at(-1)];
  for (let i = ks.length - 2; i >= 0; i--) { if (Object.keys(stack[i + 1]).length === 0) delete stack[i][ks[i]]; }
};
const merge = (b, o) => {
  const out = structuredClone(b);
  for (const [k, v] of Object.entries(o || {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" ? merge(out[k], v) : v;
  }
  return out;
};
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const presetTitle = name => S.presets.find(p => p.name === name)?.title || name || "";

let toastT;
// aviso rápido; act = {label, fn} mostra um botão (ex.: Desfazer)
const toast = (msg, err = false, act = null) => {
  const el = $("#toast"), b = $("#toastAct");
  $("#toastMsg").textContent = msg; el.classList.toggle("err", err); el.classList.add("show");
  b.hidden = !act;
  if (act) { b.textContent = act.label; b.onclick = () => { el.classList.remove("show"); act.fn(); }; }
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), act ? 5500 : 3200);
};

// janela de confirmação no estilo do app (substitui o confirm() do navegador)
function ask({ title, text = "", html = "", ok = "OK", cancel = "Cancelar", danger = false, wide = false }) {
  return new Promise(res => {
    const m = $("#modal"), okb = $("#modalOk"), cb = $("#modalCancel");
    $("#modalTitle").textContent = title;
    if (html) $("#modalBody").innerHTML = html; else $("#modalBody").textContent = text;
    okb.textContent = ok; okb.classList.toggle("btn-danger", danger);
    cb.hidden = cancel === null; if (cancel) cb.textContent = cancel;
    m.classList.toggle("wide", wide);
    m.hidden = false; setTimeout(() => okb.focus(), 0);
    const key = e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); } };
    const done = v => {
      m.hidden = true; document.removeEventListener("keydown", key, true);
      okb.onclick = cb.onclick = m.onclick = null; res(v);
    };
    okb.onclick = () => done(true); cb.onclick = () => done(false);
    m.onclick = e => { if (e.target === m) done(false); };
    document.addEventListener("keydown", key, true);
  });
}

/* ------------------------------------------------------------ desfazer / refazer
   Cada passo guarda texto + estilo + ajustes. Vale para correções, efeitos, cores,
   troca de estilo, sliders e arrastar a legenda. */
const H = { past: [], future: [], group: null, t: 0 };
const snap = text => (storeEd(), { text: text ?? $("#text").value, preset: S.cur?.preset, overrides: structuredClone(S.cur?.overrides || {}),
  secs: structuredClone(S.secs || {}), cuts: structuredClone(S.cuts), splits: [...S.splits] });
const sameSnap = (a, b) => a.text === b.text && a.preset === b.preset && JSON.stringify(a.overrides) === JSON.stringify(b.overrides)
  && JSON.stringify(a.secs || {}) === JSON.stringify(b.secs || {})
  && JSON.stringify(a.cuts || []) === JSON.stringify(b.cuts || []) && JSON.stringify(a.splits || []) === JSON.stringify(b.splits || []);
// group: mudanças seguidas do mesmo controle (arrastar um slider) viram um passo só
function checkpoint(group = null, text) {
  if (!S.cur) return;
  const now = Date.now();
  if (group && H.group === group && now - H.t < 1500) { H.t = now; return; }
  const s = snap(text);
  if (!H.past.length || !sameSnap(H.past.at(-1), s)) { H.past.push(s); if (H.past.length > 80) H.past.shift(); }
  H.future = []; H.group = group; H.t = now; syncHistory();
}
function syncHistory() {
  $("#history").hidden = !S.cur?.has_words;
  $("#btnUndo").disabled = !H.past.length; $("#btnRedo").disabled = !H.future.length;
}
async function restore(s) {
  const presetChanged = s.preset !== S.cur.preset;
  S.cur.preset = s.preset; S.cur.overrides = structuredClone(s.overrides); S.secs = structuredClone(s.secs || {});
  if (S.sec && !S.secs[S.sec]) S.sec = "";
  loadEd();
  S.cuts = structuredClone(s.cuts || []); S.splits = [...(s.splits || [])]; TL.clip = null;
  clearTimeout(saveTimer);
  $("#text").value = s.text; S.textBefore = s.text; S.dirty = false;
  try { await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { text: s.text, preset: s.preset, reset_overrides: false,
                                                                    overrides: S.cur.overrides, sections: S.secs, cuts: S.cuts, splits: S.splits } }); }
  catch (e) { return toast(e.message, true); }
  setSave("salvo", "ok");
  renderPresets(); syncControls(); syncEffects();
  if (presetChanged || JSON.stringify(s.cuts || []) !== JSON.stringify(S.plan?.cuts || [])) loadProjects();
  drawTimeline(); seek(S.t);   // os cortes podem ter mudado: a agulha sai de trecho cortado
  await refreshPlan();
}
let historyBusy = false;
async function stepHistory(back) {
  if (!S.cur || historyBusy) return;
  if (S.dirty) await saveNow();
  const from = back ? H.past : H.future, to = back ? H.future : H.past;
  const cur = snap();
  let s; do { s = from.pop(); } while (s && sameSnap(s, cur));
  if (!s) { syncHistory(); return toast(back ? "Nada para desfazer" : "Nada para refazer"); }
  to.push(cur); H.group = null;
  historyBusy = true;
  try { await restore(s); } finally { historyBusy = false; }
  syncHistory(); toast(back ? "Desfeito" : "Refeito");
}
const undo = () => stepHistory(true), redo = () => stepHistory(false);
$("#btnUndo").addEventListener("click", undo);
$("#btnRedo").addEventListener("click", redo);

/* ------------------------------------------------------------ controles de estilo
   adv: só aparece em "ajustes avançados" · eng: só no motor clássico ou no motor "frase"
   always: aparece mesmo se o preset não define o valor */
const pct = v => `${Math.round(v * 100)}%`;
const freq = v => v < .01 ? "nunca" : v > .99 ? "sempre" : `${Math.round(v * 100)}% das vezes`;
const CONTROLS = [
  { g: "Posição e tamanho", open: true, items: [
    { p: "layout.offset_x", l: "Mover para os lados", t: "range", min: -.45, max: .45, step: .005, def: 0, always: true,
      f: v => Math.abs(v) < .001 ? "centro" : v < 0 ? `← ${Math.round(-v * 100)}% esquerda` : `direita ${Math.round(v * 100)}% →` },
    { p: "layout.offset_y", l: "Mover para cima / baixo", t: "range", min: -.8, max: .8, step: .005, def: 0, always: true,
      f: v => Math.abs(v) < .001 ? "posição do estilo" : v < 0 ? `↑ ${Math.round(-v * 100)}% acima` : `↓ ${Math.round(v * 100)}% abaixo` },
    { p: "_offset_reset", t: "button", l: "Voltar para a posição do estilo", always: true,
      hint: "Dica: arraste qualquer palavra no vídeo para mover a legenda inteira. Duplo clique num controle volta ao padrão.",
      act: () => { checkpoint(); setOverride("layout.offset_x", 0, false); setOverride("layout.offset_y", 0, false); syncControls(); } },
    { p: "layout.base_size", l: "Tamanho do texto", t: "range", min: .045, max: .11, step: .001, f: v => `${(v * 100).toFixed(1)}% da largura` },
    { p: "layout.serif_scale", eng: "classic", l: "Tamanho da palavra em destaque", t: "range", min: 1, max: 2.6, step: .05, f: v => `${v.toFixed(2)}×` },
    { p: "layout.hero_scale", eng: "phrase", l: "Tamanho da palavra em destaque", t: "range", min: 1, max: 4, step: .05, f: v => `${v.toFixed(2)}×` },
    { p: "layout.serif_scale", eng: "phrase", adv: true, l: "Tamanho da continuação em serifada", t: "range", min: 1, max: 2.6, step: .05, f: v => `${v.toFixed(2)}×` },
    { p: "layout.solo_scale", adv: true, l: "Tamanho da palavra solo", t: "range", min: 1, max: 2.2, step: .05, f: v => `${v.toFixed(2)}×` },
    { p: "layout.small_scale", adv: true, l: "Palavras de apoio (a sua, o seu)", t: "range", min: .55, max: 1, step: .01, f: v => `${v.toFixed(2)}×` },
    { p: "layout.line_gap", adv: true, l: "Espaço entre linhas", t: "range", min: -.1, max: .4, step: .01, f: v => v.toFixed(2) },
    { p: "layout.zigzag", adv: true, l: "Zigue-zague das linhas", t: "range", min: 0, max: 1.2, step: .05, f: v => v.toFixed(2) },
    { p: "layout.grow", adv: true, l: "Quando a frase ganha linhas", t: "select", o: [["center", "o bloco sobe"], ["down", "cresce para baixo"]] },
  ]},
  { g: "Cores", items: [
    { p: "colors.text", l: "Texto", t: "color" },
    { p: "colors.hero", l: "Palavra em destaque", t: "color" },
    { p: "colors.red", l: "Vermelho de destaque", t: "color" },
    { p: "colors.accent", l: "Elipse", t: "color" },
  ]},
  { g: "Fontes", items: [
    { p: "fonts.sans.file", l: "Fonte do texto", t: "font" },
    { p: "fonts.hero.file", eng: "phrase", l: "Fonte da palavra em destaque", t: "font" },
    { p: "fonts.serif.file", eng: "classic", l: "Fonte da palavra em destaque", t: "font" },
    { p: "fonts.serif.file", eng: "phrase", adv: true, l: "Fonte da continuação (serifada)", t: "font" },
    { p: "fonts.serif.weight", adv: true, l: "Peso da fonte serifada", t: "range", min: 400, max: 900, step: 50, f: v => String(v) },
    { p: "fonts.sans_i.file", adv: true, l: "Fonte itálica (abertura / caixa)", t: "font" },
    { p: "layout.tracking_add", adv: true, l: "Espaço entre letras", t: "range", min: -.08, max: .15, step: .005, def: 0, always: true,
      f: v => Math.abs(v) < .001 ? "como no estilo" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}% mais ${v > 0 ? "solto" : "justo"}` },
    { p: "layout.word_space", adv: true, l: "Espaço entre palavras", t: "range", min: .3, max: 2.5, step: .05, def: 1, always: true,
      f: v => Math.abs(v - 1) < .001 ? "como no estilo" : `${v.toFixed(2)}×` },
  ]},
  { g: "Fundo escuro atrás da legenda", items: [
    { p: "effects.gradient.enabled", l: "Escurecer a parte de baixo do vídeo", t: "switch", always: true },
    { p: "effects.gradient.opacity", l: "Intensidade", t: "range", min: .1, max: 1, step: .01, f: pct },
    { p: "effects.gradient.top", adv: true, l: "Começa em (altura)", t: "range", min: .2, max: .9, step: .01, f: pct },
    { p: "effects.gradient.full", adv: true, l: "Escuro total em (altura)", t: "range", min: .4, max: 1, step: .01, f: pct },
    { p: "effects.gradient.color", adv: true, l: "Cor", t: "color" },
  ]},
  { g: "Mistura com o vídeo", adv: true, items: [
    { p: "effects.blend.enabled", l: "Texto se mistura com as cores do vídeo", t: "switch", always: true },
    { p: "effects.blend.mode", l: "Tipo de mistura", t: "select", always: true, def: "difference", o: [
      ["difference", "Diferença (inverte as cores)"], ["normal", "Normal"], ["screen", "Clarear (screen)"], ["overlay", "Sobrepor (overlay)"], ["soft_light", "Luz suave"],
      ["hard_light", "Luz direta"], ["color_dodge", "Subexposição de cor"], ["add", "Adição"],
      ["lighten", "Clarear cor"], ["multiply", "Multiplicar"], ["darken", "Escurecer"],
      ["exclusion", "Exclusão"], ["divide", "Dividir"]] },
    { p: "effects.blend.opacity", l: "Intensidade da mistura", t: "range", min: .1, max: 1, step: .01, def: 1, always: true, f: pct },
  ]},
  { g: "Animação", adv: true, items: [
    { p: "effects.blur_in.duration", l: "Duração da entrada com desfoque", t: "range", min: .08, max: .6, step: .01, f: v => `${v.toFixed(2)}s` },
    { p: "effects.blur_in.max_blur", l: "Intensidade do desfoque", t: "range", min: 0, max: .04, step: .001, f: v => (v * 1000).toFixed(0) },
    { p: "effects.pop.scale_from", l: "Força do pop", t: "range", min: 1, max: 1.4, step: .01, f: v => `${v.toFixed(2)}×` },
    { p: "effects.drift", l: "Movimento lento da legenda", t: "range", min: 0, max: .02, step: .001, f: v => (v * 1000).toFixed(0) },
    { p: "effects.rays.enabled", l: "Raios de luz no destaque", t: "switch" },
    { p: "effects.flicker", l: "Vermelho piscando", t: "switch" },
    { p: "effects.red_glow", l: "Brilho no vermelho", t: "switch" },
    { p: "effects.flash.enabled", l: "Clarão entre frases", t: "switch" },
    { p: "effects.blur_out.overlap", l: "Saída se mistura com a próxima legenda", t: "switch" },
    { p: "effects.rolling_window", l: "Mostrar só as últimas linhas", t: "select", o: [[0, "não (mostra a frase toda)"], [2, "2 linhas"], [3, "3 linhas"]] },
  ]},
  { g: "Quantidade de destaques e efeitos", adv: true, items: [
    { p: "rules.emphasis_every", l: "Um destaque a cada", t: "range", min: 1.5, max: 10, step: .1, f: v => `${v.toFixed(1)} s de fala` },
    { p: "rules.emphasis_gap", l: "Intervalo mínimo entre destaques", t: "range", min: .3, max: 5, step: .1, f: v => `${v.toFixed(1)} s` },
    { p: "rules.stack_plain_probability", l: "Frases sem destaque", t: "range", min: 0, max: 1, step: .05, f: freq },
    { p: "rules.solo.enabled", l: "Palavra solo em falas pausadas", t: "switch" },
    { p: "rules.solo.probability", l: "Palavra solo", t: "range", min: 0, max: 1, step: .05, f: freq },
    { p: "rules.ellipse.probability", l: "Elipse no fim de frase", t: "range", min: 0, max: 1, step: .05, f: freq },
    { p: "rules.underline.probability", l: "Sublinhado no fim de frase", t: "range", min: 0, max: 1, step: .05, f: freq },
    { p: "rules.box_negation", l: "Caixa vermelha no “Não”", t: "switch" },
    { p: "rules.sans_italic_lead", l: "Itálico na abertura (Essa é, você)", t: "switch" },
    { p: "rules.cards.enabled", l: "Cards de citação", t: "switch" },
    { p: "rules.cards.auto_repetition", l: "Card automático em repetições", t: "switch" },
    { p: "rules.chunk_max_words", eng: "phrase", l: "Palavras por legenda", t: "range", min: 1, max: 6, step: 1,
      f: v => v == 1 ? "1 palavra" : `até ${v} palavras` },
    { p: "rules.chunk_max_chars", l: "Máximo de letras por legenda curta", t: "range", min: 6, max: 40, step: 1, f: v => `${v} letras` },
  ]},
];

const engineOf = st => (st?.rules || {}).engine === "phrase" ? "phrase" : "classic";
function buildControls() {
  const root = $("#controls"); root.innerHTML = "";
  for (const grp of CONTROLS) {
    const d = document.createElement("details"); d.className = "group"; d.open = !!grp.open;
    d.innerHTML = `<summary>${grp.g}</summary><div class="group-body"></div>`;
    const body = $(".group-body", d);
    for (const c of grp.items) {
      const w = document.createElement("div"); w.className = "ctl"; w.dataset.p = c.p;
      if (c.t === "range") {
        w.innerHTML = `<div class="ctl-top"><span>${c.l}</span><output></output></div>
          <input type="range" min="${c.min}" max="${c.max}" step="${c.step}" aria-label="${c.l}">`;
        const inp = $("input", w);
        inp.addEventListener("input", () => { paintRange(inp); $("output", w).textContent = c.f(+inp.value); setOverride(c.p, +inp.value); });
        // duplo clique volta ao valor do estilo
        inp.addEventListener("dblclick", () => {
          const v = c.def !== undefined ? c.def : getPath(S.base, c.p);
          if (v !== undefined) { setOverride(c.p, v); syncControls(); }
        });
      } else if (c.t === "button") {
        w.innerHTML = `<button class="btn btn-sm btn-block">${c.l}</button>${c.hint ? `<p class="hint">${c.hint}</p>` : ""}`;
        $("button", w).addEventListener("click", c.act);
      } else if (c.t === "switch") {
        w.innerHTML = `<label class="switch"><span>${c.l}</span><input type="checkbox"></label>`;
        $("input", w).addEventListener("change", e => setOverride(c.p, e.target.checked));
      } else if (c.t === "color") {
        w.innerHTML = `<div class="ctl-top"><span>${c.l}</span></div><div class="ctl-color"><input type="color" aria-label="${c.l}"><code></code></div>`;
        $("input", w).addEventListener("input", e => { $("code", w).textContent = e.target.value.toUpperCase(); setOverride(c.p, e.target.value.toUpperCase()); });
      } else {
        const opts = c.t === "font" ? S.fonts.map(f => [f, f.replace(/\.(ttf|otf)$/i, "")]) : c.o;
        w.innerHTML = `<div class="ctl-top"><span>${c.l}</span></div><select aria-label="${c.l}">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>`;
        $("select", w).addEventListener("change", e => {
          const v = e.target.value; setOverride(c.p, c.o && typeof c.o[0][0] === "number" ? +v : v);
        });
      }
      w._c = c; w._adv = !!(c.adv || grp.adv);
      body.appendChild(w);
    }
    root.appendChild(d);
  }
}
const paintRange = inp => inp.style.setProperty("--p", `${((inp.value - inp.min) / (inp.max - inp.min)) * 100}%`);

function syncControls() {
  if (!S.base) return;
  const st = merge(S.base, S.overrides), eng = engineOf(st);
  let advN = 0, advChanged = 0;
  for (const w of $$("#controls .ctl")) {
    const c = w._c; const v = getPath(st, c.p);
    const changed = getPath(S.overrides, c.p) !== undefined;
    w.classList.toggle("changed", changed && c.t !== "button");
    const fits = (v !== undefined || c.always) && (!c.eng || c.eng === eng);
    if (fits && w._adv) { advN++; if (changed) advChanged++; }
    w.style.display = fits && (S.showAdv || !w._adv) ? "" : "none";
    if (c.t === "button") continue;
    if (c.t === "range") { const i = $("input", w); i.value = v ?? c.def ?? c.min; paintRange(i); $("output", w).textContent = c.f(+i.value); }
    else if (c.t === "switch") $("input", w).checked = !!v;
    else if (c.t === "color") { $("input", w).value = (v || "#ffffff").toLowerCase(); $("code", w).textContent = (v || "").toUpperCase(); }
    else $("select", w).value = String(v ?? c.def);
  }
  for (const d of $$("#controls details.group")) d.hidden = !$$(".ctl", d).some(w => w.style.display !== "none");
  const b = $("#btnAdv");
  b.hidden = !advN;
  b.textContent = S.showAdv ? "Esconder ajustes avançados"
    : `Mostrar ajustes avançados (${advN})${advChanged ? ` · ${advChanged} alterado${advChanged > 1 ? "s" : ""}` : ""}`;
}
$("#btnAdv").addEventListener("click", () => { S.showAdv = !S.showAdv; lsSet("lp.adv", S.showAdv ? "1" : "0"); syncControls(); });

// ajustes a enviar, por bloco: guardados na hora da edição (trocar de bloco antes do envio não troca o destino)
const ovPending = new Map();
const pushOverrides = debounce(async () => {
  if (!S.cur) return;
  const items = [...ovPending]; ovPending.clear();
  try {
    for (const [sec, ov] of items)
      await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: sec ? { section: sec, overrides: ov } : { overrides: ov } });
    await refreshPlan();
  } catch (e) { toast(e.message, true); }
}, 120);

const ctlDefault = p => CONTROLS.flatMap(g => g.items).find(c => c.p === p)?.def;
function setOverride(p, v, cp = true) {
  if (cp) checkpoint(`ctl:${p}`);
  if ((getPath(S.base, p) ?? ctlDefault(p)) === v) delPath(S.overrides, p); else setPath(S.overrides, p, v);
  // mais palavras por legenda precisa de espaço para as letras delas (senão o limite de letras corta antes)
  if (p === "rules.chunk_max_words") {
    const st = merge(S.base, S.overrides), need = Math.min(40, Math.max(getPath(S.base, "rules.chunk_max_chars") ?? 14, v * 7 + 1));
    if ((getPath(st, "rules.chunk_max_chars") ?? 14) < need) { setPath(S.overrides, "rules.chunk_max_chars", need); syncControls(); }
  }
  ovPending.set(S.sec, S.overrides);
  for (const w of $$(`#controls .ctl[data-p="${p}"]`)) w.classList.toggle("changed", getPath(S.overrides, p) !== undefined);
  pushOverrides();
}

/* ------------------------------------------------------------ blocos de estilo
   O texto pode ser dividido em blocos ({estilo:id}): cada bloco tem preset e ajustes próprios
   (meta.sections[id]); o 1º bloco usa o estilo do projeto. A aba Estilo edita o bloco escolhido (S.sec),
   que acompanha a palavra clicada. S.base / S.overrides são sempre os do bloco editado. */
// motor antigo (API < 2) leria {estilo:id} como palavra: a divisão só aparece com motor novo
const canSections = () => (S.status?.api || 0) >= 2;
const secList = () => S.plan?.sections || [{ id: "", n: 1, mark: null, preset: S.cur?.preset }];
const multiSec = () => secList().length > 1;
const secNum = id => (secList().findIndex(x => x.id === id) + 1) || 1;
const secOfWord = i => secList()[S.plan?.words[i]?.sec ?? 0]?.id ?? "";
const edPreset = () => (S.sec && S.secs[S.sec]?.preset) || S.cur?.preset;
const edBody = b => (S.sec ? { section: S.sec, ...b } : b);
// guarda o preset/ajustes do bloco editado no lugar dele (projeto ou meta.sections)
function storeEd() {
  if (!S.cur) return;
  if (S.sec) S.secs[S.sec] = { preset: edPreset(), overrides: S.overrides };
  else S.cur.overrides = S.overrides;
}
function setEdPreset(name) {
  if (S.sec) S.secs[S.sec] = { preset: name, overrides: S.overrides };
  else { S.cur.preset = name; S.cur.overrides = S.overrides; }
}
function loadEd() {
  S.base = S.presets.find(p => p.name === edPreset()) || S.presets[0];
  S.overrides = S.sec ? (S.secs[S.sec]?.overrides || {}) : (S.cur.overrides || {});
  if (S.sec && S.secs[S.sec]) S.secs[S.sec].overrides = S.overrides;
}
function selectSec(id) {
  if (!secList().some(x => x.id === id)) id = "";
  if (id === S.sec) return;
  storeEd(); S.sec = id; loadEd();
  renderPresets(); syncControls(); syncEffects(); renderSecBar();
}
// a palavra i começa um bloco (logo depois de uma divisão)? devolve o bloco
function startsSec(i) {
  const w = S.plan?.words[i], b = secList()[w?.sec];
  if (!w?.span || !b?.mark) return null;
  const between = $("#text").value.slice(b.mark[1], w.span[0]).replace(/\{[^}]*\}/g, "");
  return /^[\s|"“”]*$/.test(between) ? b : null;
}
const secRange = k => {
  const ws = (S.plan?.words || []).filter(w => w.sec === k && !w.cut);
  return ws.length ? `${fmtTime(o2e(ws[0].start))}–${fmtTime(o2e(ws.at(-1).end))}` : "sem fala";
};
const secChip = (b, k) => b ? `<span class="rt-sec${b.id === S.sec ? " on" : ""}" data-sec="${escapeHtml(b.id)}" data-k="${k}" title="Clique para editar o estilo deste bloco">` +
  `<b>Bloco ${k + 1}</b> · ${escapeHtml(presetTitle(b.preset))}` +
  (b.mark ? `<i class="rt-sec-x" title="Tirar esta divisão (o texto volta para o bloco de cima)">×</i>` : "") + `</span>` : "";
function renderSecBar() {
  const bar = $("#secBar"); if (!bar) return;
  const secs = secList();
  $("#styleHint").textContent = secs.length > 1
    ? `Vale só para o bloco ${secNum(S.sec)}. Clique numa palavra (ou num bloco abaixo) para editar outro.`
    : "Vale para o vídeo inteiro. Para mudar só algumas palavras, clique nelas.";
  if (secs.length < 2) {
    if (!canSections()) { bar.innerHTML = ""; return; }
    bar.innerHTML = `<p class="sec-tip">Quer outro estilo em parte do vídeo? Clique na palavra onde ele começa e use <b>Novo estilo daqui em diante</b>.</p>`;
    return;
  }
  bar.innerHTML = `<div class="sec-label">Este vídeo tem ${secs.length} estilos · editando o bloco ${secNum(S.sec)}</div><div class="sec-chips">` +
    secs.map((b, k) => `<button class="sec-chip${b.id === S.sec ? " on" : ""}" data-sec="${escapeHtml(b.id)}">` +
      `<b>Bloco ${k + 1}</b><span>${escapeHtml(presetTitle(b.id === S.sec ? edPreset() : b.preset))}</span><small>${secRange(k)}</small></button>`).join("") + "</div>";
  for (const el of $$("#rich .rt-sec")) el.classList.toggle("on", el.dataset.sec === S.sec);
}
$("#secBar").addEventListener("click", e => {
  const b = e.target.closest(".sec-chip"); if (!b) return;
  clearSel(); selectSec(b.dataset.sec);
  // leva o vídeo até o começo do bloco
  const k = secList().findIndex(x => x.id === b.dataset.sec), i = S.plan?.words.findIndex(w => w.sec === k && !w.cut);
  if (i >= 0) seek(wordViewTime(i));
});
$("#rich").addEventListener("click", e => {
  const c = e.target.closest(".rt-sec"); if (!c) return;
  e.stopPropagation();
  if (e.target.closest(".rt-sec-x")) return removeSec(+c.dataset.k);
  clearSel(); selectSec(c.dataset.sec); openTab("estilo");
}, true);
const newSecId = v => { let id; do { id = "e" + Math.random().toString(36).slice(2, 6); } while (S.secs[id] || v.includes(`{estilo:${id}}`)); return id; };
async function removeSec(k) {
  const b = secList()[k]; if (!b?.mark || editing) return;
  if (S.dirty) await saveNow();
  const v = $("#text").value;
  if (v.slice(b.mark[0], b.mark[1]) !== `{estilo:${b.id}}`) return;
  const n = k + 1;
  await setText(spliceText(v, [cutTag(v, b.mark)]));
  toast(`Divisão do bloco ${n} removida`, false, { label: "Desfazer", fn: undo });
}
// "Novo estilo daqui em diante": divide o texto antes da palavra escolhida. O bloco novo nasce com o
// mesmo estilo do bloco de onde saiu (nada muda na tela) e a aba Estilo abre nele para escolher outro.
async function splitHere() {
  if (editing || !S.sel.length) return;
  const st = startsSec(S.sel[0]);
  if (st) return removeSec(secList().indexOf(st));
  editing = true;
  try {
    if (S.dirty) await saveNow();
    const w = S.plan.words[S.sel[0]]; if (!w?.span) return;
    const v = $("#text").value;
    storeEd();
    const from = secList()[w.sec]?.id ?? "";
    const src = (from && S.secs[from]) || { preset: S.cur.preset, overrides: S.cur.overrides };
    const id = newSecId(v);
    checkpoint();
    S.secs[id] = { preset: src?.preset || S.cur.preset, overrides: structuredClone(src?.overrides || {}) };
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { section: id, preset: S.secs[id].preset, reset_overrides: false, overrides: S.secs[id].overrides } });
    await setText(spliceText(v, [[w.span[0], w.span[0], `{estilo:${id}} `]]), false);
    selectSec(id); openTab("estilo");
    toast(`Bloco ${secNum(id)} criado: escolha o estilo dele`, false, { label: "Desfazer", fn: undo });
  } catch (e) { toast(e.message, true); }
  finally { editing = false; }
}

/* ------------------------------------------------------------ presets */
// cartão de estilo: miniatura + nome + o que ele faz; ao passar o mouse toca a prévia animada
function presetCard(p, { active, small, onPick, deletable }) {
  const b = document.createElement("button");
  b.className = "preset" + (active ? " active" : "") + (small ? " small" : "");
  b.title = p.description || p.title || p.name;
  b.innerHTML = `<span class="preset-media"><img loading="lazy" alt="" src="${ENGINE}/api/presets/${encodeURIComponent(p.name)}/thumb.jpg?v=${p._v || 0}"></span>
    <span class="preset-name">${escapeHtml(p.title || p.name)}</span>
    ${p.tagline ? `<span class="preset-tag">${escapeHtml(p.tagline)}</span>` : ""}
    ${deletable ? `<span class="preset-del" title="Apagar este estilo">×</span>` : ""}`;
  b.addEventListener("mouseenter", () => {
    const media = $(".preset-media", b); if ($("video", media)) return;
    const v = document.createElement("video"); v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
    v.src = `${ENGINE}/api/presets/${encodeURIComponent(p.name)}/anim.mp4?v=${p._v || 0}`;
    v.addEventListener("playing", () => v.classList.add("on"), { once: true });
    media.appendChild(v); v.play().catch(() => {});
  });
  b.addEventListener("mouseleave", () => $(".preset-media video", b)?.remove());
  b.addEventListener("click", e => {
    if (e.target.classList.contains("preset-del")) { e.stopPropagation(); deletePreset(p); return; }
    onPick(p);
  });
  return b;
}

async function deletePreset(p) {
  if (!await ask({ title: `Apagar o estilo “${p.title || p.name}”?`, text: "Os projetos que usam este estilo voltam para o estilo padrão. Isso não pode ser desfeito.", ok: "Apagar", danger: true })) return;
  try { await api(`/api/presets/${p.name}`, { method: "DELETE" }); } catch (e) { return toast(e.message, true); }
  await loadPresets(); toast("Estilo apagado");
  // o projeto (ou o bloco) volta para o estilo padrão
  if (S.cur?.preset === p.name || Object.values(S.secs).some(x => x.preset === p.name)) openProject(S.cur.id);
}

async function applyPreset(p) {
  if (!S.cur || p.name === edPreset()) return;
  checkpoint();
  await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: edBody({ preset: p.name }) });
  S.base = p; S.overrides = {}; setEdPreset(p.name);
  if (!S.sec) { S.uploadPreset = p.name; lsSet("lp.uploadPreset", p.name); }
  renderPresets(); syncControls(); syncEffects(); renderSecBar(); loadProjects(); await refreshPlan();
  const blk = multiSec() ? ` no bloco ${secNum(S.sec)}` : "";
  toast(`Estilo “${p.title || p.name}” aplicado${blk}`, false, { label: "Desfazer", fn: undo });
}

function renderPresets() {
  const grid = $("#presetGrid"); grid.innerHTML = "";
  const curName = edPreset();
  for (const p of S.presets) {
    grid.appendChild(presetCard(p, { active: p.name === curName, deletable: !S.builtin.includes(p.name), onPick: applyPreset }));
  }
  const cur = S.presets.find(p => p.name === curName);
  let d = $("#presetDesc");
  if (!d) { d = document.createElement("p"); d.id = "presetDesc"; d.className = "preset-desc"; grid.after(d); }
  d.innerHTML = cur ? `<b>${escapeHtml(cur.title || cur.name)}${cur.tagline ? ` · ${escapeHtml(cur.tagline)}` : ""}</b>${escapeHtml(cur.description || "")}` : "";
  renderUploadPresets();
}

function renderUploadPresets() {
  const box = $("#uploadPresets"); box.innerHTML = "";
  if (!S.presets.some(p => p.name === S.uploadPreset)) S.uploadPreset = S.presets[0]?.name;
  for (const p of S.presets) {
    box.appendChild(presetCard(p, { active: p.name === S.uploadPreset, small: true, onPick: q => {
      S.uploadPreset = q.name; lsSet("lp.uploadPreset", q.name); renderUploadPresets();
    } }));
  }
}

async function loadPresets() {
  const r = await api("/api/presets");
  S.presets = r.presets.map(p => ({ ...p, _v: Date.now() })); S.fonts = r.fonts; S.builtin = r.builtin || [];
  $("#newPresetName").placeholder = r.next_title || "Preset novo";
  if (S.cur) S.base = S.presets.find(p => p.name === edPreset()) || S.base;
  buildControls(); syncControls(); renderPresets();
}

/* ------------------------------------------------------------ projetos */
function renderProjects() {
  const list = $("#projectList"); list.innerHTML = "";
  $("#railSearch").hidden = S.projects.length < 5 && !S.projSearch;
  const q = S.projSearch.trim().toLowerCase();
  const items = S.projects.filter(p => !q || p.name.toLowerCase().includes(q));
  for (const p of items) {
    const el = document.createElement("div"); el.className = "proj" + (S.cur?.id === p.id ? " active" : ""); el.tabIndex = 0;
    el.title = `${p.name} · ${p.width}×${p.height}`;
    const st = { novo: "transcrevendo…", transcrito: "pronto" }[p.status] || p.status;
    el.innerHTML = `<img src="${ENGINE}/api/projects/${p.id}/thumb.jpg" alt="">
      <div><div class="proj-name"></div>
      <div class="proj-meta">${fmtTime(p.duration - (p.cuts || []).reduce((a, c) => a + c[1] - c[0], 0)).slice(0, 5)} · ${st}</div>
      <div class="proj-meta">${p.created ? fmtDate(p.created) + " · " : ""}${escapeHtml(presetTitle(p.preset))}</div></div>
      <button class="proj-del" title="Apagar projeto" aria-label="Apagar projeto">×</button>`;
    $(".proj-name", el).textContent = p.name;
    el.addEventListener("click", e => {
      if (e.target.classList.contains("proj-del")) return deleteProject(p);
      if (S.cur?.id !== p.id) openProject(p.id).catch(() => {});   // motor fora: a tela do motor já avisa
    });
    el.addEventListener("keydown", e => { if (e.key === "Enter") openProject(p.id).catch(() => {}); });
    list.appendChild(el);
  }
  if (q && !items.length) list.innerHTML = `<p class="hint pad">Nenhum projeto com “${escapeHtml(S.projSearch)}”.</p>`;
}
async function loadProjects() {
  const r = await api("/api/projects"); S.projects = r.projects;
  renderProjects();
}
$("#projectSearch").addEventListener("input", e => { S.projSearch = e.target.value; renderProjects(); });
// painel de projetos recolhível (fica lembrado)
function setRail(collapsed, save = true) {
  $(".studio").classList.toggle("rail-collapsed", collapsed);
  const b = $("#btnRail"), lbl = collapsed ? "Mostrar o painel de projetos" : "Recolher o painel de projetos";
  b.title = lbl; b.setAttribute("aria-label", lbl); b.setAttribute("aria-expanded", String(!collapsed));
  if (save) lsSet("lp.railCollapsed", collapsed ? "1" : "0");
}
$("#btnRail").addEventListener("click", () => setRail(!$(".studio").classList.contains("rail-collapsed")));
setRail(lsGet("lp.railCollapsed") === "1", false);

async function deleteProject(p) {
  if (!await ask({ title: `Apagar o projeto “${p.name}”?`, text: "O vídeo original, a transcrição e os vídeos exportados deste projeto serão apagados. Isso não pode ser desfeito.", ok: "Apagar projeto", danger: true })) return;
  try { await api(`/api/projects/${p.id}`, { method: "DELETE" }); } catch (e) { return toast(e.message, true); }
  if (S.cur?.id === p.id) closeProject();
  loadProjects(); toast("Projeto apagado");
}

function closeProject() {
  if (S.dirty) saveNow();   // salva no projeto que está fechando (S.cur ainda é ele neste instante)
  clearTimeout(saveTimer); S.dirty = false;
  S.cur = null; S.plan = null; liveReset(); matteWatch = null; $("#matteState").hidden = true;
  clearSel(); S.hits = []; drawHits();
  H.past = []; H.future = []; syncHistory();
  $("#viewer").hidden = true; $("#drop").hidden = false; $("#projectTitleWrap").hidden = true;
  $("#inspector").classList.add("disabled");
  $("#player").pause(); $("#player").removeAttribute("src");
  $("#rich").innerHTML = ""; $("#exports").innerHTML = ""; $("#exportDot").hidden = true;
  $("#tlTrack").innerHTML = ""; $("#tlFlashes").innerHTML = ""; $("#tlClips").innerHTML = ""; $("#tlRuler").innerHTML = "";
  S.cuts = []; S.splits = []; TL.clip = null; thumbsReset(); syncClipTools();
  try { localStorage.removeItem("lp.last"); } catch {}
  renderProjects();
}

// primeiro momento em que a legenda já está inteira na tela (para não abrir num quadro sem texto)
function firstCaptionTime() {
  const sc = S.plan?.scenes?.find(s => s.wi?.length);
  if (!sc) return 0;
  const w = S.plan.words[sc.wi.at(-1)];
  return Math.max(0, Math.min(sc.t_out - 0.04, (w?.end ?? sc.t_in) + 0.15));
}
// momento bom para ver a palavra i assentada (depois que ela entrou, antes de a cena sair)
function wordViewTime(i) {
  const w = S.plan.words[i]; if (!w) return S.t;
  const sc = S.plan.scenes.find(s => s.wi?.includes(i));
  const t = w.end + 0.4;
  return sc ? Math.max(sc.t_in + 0.02, Math.min(sc.t_out - 0.04, t)) : w.start + 0.03;
}

async function openProject(id) {
  if (S.dirty) await saveNow();   // digitação pendente vai para o projeto certo antes de trocar
  clearTimeout(saveTimer);
  const p = await api(`/api/projects/${id}`);
  S.cur = p; S.t = 0; S.plan = null; liveReset(); matteWatch = null; $("#matteState").hidden = true;
  S.dirty = false; S.hits = []; clearSel();
  H.past = []; H.future = []; H.group = null;
  p.overrides = p.overrides || {};
  S.secs = p.sections || {}; S.sec = "";
  S.base = S.presets.find(x => x.name === p.preset) || S.presets[0];
  S.overrides = p.overrides;
  S.cuts = normCuts(p.cuts || [], p.duration); S.splits = [...(p.splits || [])]; TL.clip = null; TL.pending = 0;
  // "Altura na tela" (layout.anchor_y) saiu da interface: o ajuste antigo vira deslocamento (mesmo efeito)
  const ay = getPath(S.overrides, "layout.anchor_y");
  if (ay !== undefined) {
    const oy = Math.max(-.8, Math.min(.8, (getPath(S.overrides, "layout.offset_y") ?? 0) + ay - (getPath(S.base, "layout.anchor_y") ?? ay)));
    delPath(S.overrides, "layout.anchor_y");
    if (Math.abs(oy) > 1e-4) setPath(S.overrides, "layout.offset_y", +oy.toFixed(4));
    await api(`/api/projects/${id}`, { method: "PUT", body: { overrides: S.overrides } }).catch(() => {});
  }
  lsSet("lp.last", id);
  $("#drop").hidden = true; $("#viewer").hidden = false;
  $("#projectTitleWrap").hidden = false; $("#projectTitle").value = p.name;
  $("#phone").style.aspectRatio = `${p.width} / ${p.height}`;
  $("#tcDur").textContent = fmtTime(editDur());
  $("#text").value = p.text || ""; S.textBefore = $("#text").value; setSave("");
  const pl = $("#player"); pl.pause(); $("#hits").hidden = false; $("#btnPlay").classList.remove("playing");
  if (p.source) { if (pl.getAttribute("src") !== E(p.source)) pl.src = E(p.source); }
  else pl.removeAttribute("src");
  setZoom(1); drawTimeline(); thumbsStart();
  if (p.source_job && !p.job) watchJob(p.source_job);   // vídeo que o navegador não toca: prepara uma cópia leve
  $("#inspector").classList.toggle("disabled", !p.has_words);
  $("#phoneTip").hidden = !p.has_words || lsGet("lp.tipSeen") === "1";
  syncHistory();
  renderPresets(); syncControls(); syncEffects(); renderSecBar(); renderExports(); loadProjects();
  if (p.job && p.job.status === "running") watchJob(p.job);
  if (p.has_words) {
    await refreshPlan();
    const t0 = firstCaptionTime(); if (t0 > 0 && S.cur?.id === id) seek(t0);
  } else { $("#tlTrack").innerHTML = ""; $("#rich").innerHTML = ""; }
}

$("#projectTitle").addEventListener("change", async e => {
  if (!S.cur) return;
  const name = e.target.value.trim() || S.cur.name;
  e.target.value = name;
  await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { name } });
  S.cur.name = name; loadProjects(); toast("Projeto renomeado");
});
$("#projectTitle").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === "Escape") e.target.blur(); });

/* ------------------------------------------------------------ upload */
function upload(file) {
  if (!file) return;
  const model = $("#uploadModel").value, preset = S.uploadPreset || "";
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${ENGINE}/api/upload?model=${encodeURIComponent(model)}&preset=${encodeURIComponent(preset)}`);
  xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
  $("#drop").hidden = true; $("#viewer").hidden = false; $("#player").removeAttribute("src");
  showBusy("Enviando o vídeo…", file.name, 0);
  xhr.upload.onprogress = e => e.lengthComputable && showBusy("Enviando o vídeo…", file.name, e.loaded / e.total);
  xhr.onload = async () => {
    let r = {}; try { r = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status !== 200) { hideBusy(); toast(r.error || "Falha no envio", true); closeProject(); return; }
    await openProject(r.project.id);
    watchJob(r.job);
  };
  xhr.onerror = () => { hideBusy(); toast("Falha no envio", true); closeProject(); };
  xhr.send(file);
}

$("#btnPick").addEventListener("click", () => $("#fileInput").click());
$("#btnNew").addEventListener("click", () => { closeProject(); loadProjects(); $("#fileInput").click(); });
$("#fileInput").addEventListener("change", e => { upload(e.target.files[0]); e.target.value = ""; });
["dragenter", "dragover"].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); $("#drop").classList.add("over"); }));
["dragleave", "drop"].forEach(ev => window.addEventListener(ev, e => { e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) $("#drop").classList.remove("over"); }));
window.addEventListener("drop", e => { const f = e.dataTransfer?.files?.[0]; if (f) upload(f); });

/* ------------------------------------------------------------ jobs */
function showBusy(title, sub, frac) {
  $("#busy").hidden = false; $("#busyTitle").textContent = title; $("#busySub").textContent = sub || "";
  const f = Math.max(0, Math.min(1, frac || 0));
  $("#busyPct").textContent = `${Math.round(f * 100)}%`;
  $("#ringFg").style.strokeDashoffset = String(327 * (1 - f));
}
const hideBusy = () => { $("#busy").hidden = true; };

function watchJob(job) {
  S.jobs[job.id] = job;
  const tick = async () => {
    let j; try { j = await api(`/api/jobs/${job.id}`); } catch { return; }
    S.jobs[job.id] = j;
    onJob(j);
    if (j.status === "running") setTimeout(tick, 450);
  };
  onJob(job); setTimeout(tick, 300);
}

async function onJob(j) {
  const mine = S.cur && j.project === S.cur.id;
  if (j.kind === "transcribe") {
    if (!mine) return;
    if (j.status === "running") showBusy("Transcrevendo…", j.message || "", j.progress);
    else if (j.status === "done") {
      hideBusy(); toast(`Transcrição pronta: ${j.result.words} palavras`);
      await openProject(S.cur.id);
    } else if (j.status === "error") { hideBusy(); toast(`Erro na transcrição: ${j.error}`, true); }
  } else if (j.kind === "matte") {
    if (!mine) return;
    const el = $("#matteState");
    if (j.status === "running") {
      el.hidden = false;
      const pct = Math.round((j.progress || 0) * 100);
      // na primeira vez o modelo de recorte é baixado antes (o servidor avisa na mensagem)
      el.textContent = /baixando/i.test(j.message || "") ? `baixando o modelo de recorte ${pct}%` : `recortando a pessoa ${pct}%`;
      return;
    }
    matteWatch = null; el.hidden = true;
    if (j.status === "done") { toast("Recorte pronto: o texto já aparece atrás da pessoa"); await refreshPlan(); }
    else if (j.status === "error") toast(`Erro no recorte da pessoa: ${j.error}`, true);
  } else if (j.kind === "proxy") {
    if (!mine) return;
    if (j.status === "running") showBusy("Preparando o vídeo…", "o navegador não toca este formato: criando uma cópia leve só para a prévia", j.progress);
    else if (j.status === "done") { hideBusy(); await openProject(S.cur.id); }
    else if (j.status === "error") { hideBusy(); toast(`Erro ao preparar o vídeo: ${j.error}`, true); }
  } else {
    if (!mine) return;
    $("#expProg").hidden = j.status !== "running";
    $("#btnExport").disabled = j.status === "running";
    $("#expBar").style.width = `${Math.round(j.progress * 100)}%`;
    $("#expMsg").textContent = (j.message || "").replace(/^(\d+)\/(\d+) frames$/, "$1 de $2 quadros");
    $("#btnCancel").onclick = () => api(`/api/jobs/${j.id}/cancel`, { method: "POST" });
    if (j.status === "done") {
      toast("Exportação concluída");
      refreshPlan();   // a exportação pode ter recortado a pessoa (versão nova do recorte)
      const p = await api(`/api/projects/${S.cur.id}`);
      S.cur.exports = p.exports; S.cur.exports_info = p.exports_info; renderExports(j.result.file);
    } else if (j.status === "error") toast(`Erro ao exportar: ${j.error}`, true);
    else if (j.status === "cancelled") toast("Exportação cancelada");
  }
}

/* ------------------------------------------------------------ plano + timeline */
/* recorte da pessoa (texto atrás): começa sozinho quando há trecho sem recorte e mostra o progresso.
   Enquanto não fica pronto, a prévia mostra o texto na frente. */
let matteWatch = null;
async function updateMatte() {
  const mt = S.plan?.live?.matte, el = $("#matteState");
  if (!mt?.need || !mt.model) { el.hidden = true; return; }
  el.hidden = false;
  if (mt.job && mt.job.kind !== "matte") { el.textContent = "recortando a pessoa (exportação)…"; return; }
  if (matteWatch) return;
  el.textContent = "recortando a pessoa…";
  const pid = S.cur.id;
  try {
    const j = mt.job || await api(`/api/projects/${pid}/matte`, { method: "POST" });
    if (S.cur?.id !== pid) return;
    matteWatch = j.id; watchJob(j);
  } catch (e) { el.hidden = true; toast(e.message, true); }
}

let planSeq = 0;
async function refreshPlan() {
  if (!S.cur) return;
  // dois pedidos em voo: só vale o mais novo do projeto aberto (as posições das palavras no texto
  // precisam bater com o texto atual, senão uma edição corta no lugar errado)
  const pid = S.cur.id, seq = ++planSeq;
  let plan;
  try { plan = await api(`/api/projects/${pid}/plan`); }
  catch (e) { if (seq === planSeq) toast(e.message, true); return; }
  if (seq !== planSeq || S.cur?.id !== pid) return;
  S.plan = plan; LV.stale = false;
  // cortes normalizados pelo servidor (salvo se ainda há um corte local a caminho dele)
  if (!TL.pending && plan.cuts) { S.cuts = normCuts(plan.cuts, S.cur.duration); S.splits = [...(plan.splits || [])]; }
  S.sel = S.sel.filter(i => i < S.plan.words.length);
  if (!secList().some(x => x.id === S.sec)) selectSec(""); else renderSecBar();   // a divisão do bloco editado saiu
  liveSetup(); drawTimeline(); showAt(); livePump(); renderRich(); renderPop(); updateExportBadges(); updateMatte();
  if (pendingGroup && !S.dirty) {   // tamanho/posição de trecho que chegou enquanto o texto mudava
    const pg = pendingGroup; pendingGroup = null;
    const g = S.plan.groups?.[pg.g];
    if (g) setGroup(g, pg.changes, pg.undoGroup);
  }
}

const MODE_NAMES = { chunk: "legenda curta", plain: "legenda curta", stack: "pilha", hero: "destaque", block: "frase empilhada", fill: "preenchimento", solo: "solo", card: "card" };
const LEGEND = [
  [["chunk", "plain"], "m-chunk", "Legenda curta", "poucas palavras por vez"],
  [["stack"], "m-stack", "Pilha", "frase em linhas com palavra em evidência"],
  [["hero"], "m-stack", "Destaque", "palavra grande em evidência com a frase em volta"],
  [["block"], "m-stack", "Frase empilhada", "a frase vai se acumulando em linhas"],
  [["fill"], "m-stack", "Preenchimento", "linhas que preenchem a largura da caixa"],
  [["solo"], "m-solo", "Solo", "palavra grande com pop"],
  [["card"], "m-card", "Card", "fundo chapado"],
  [["flash"], "m-flash", "Clarão", "clarão entre frases"],
  [["emph"], "m-emph", "Palavra em destaque", "palavras que o estilo deixou em evidência"],
  [["behind"], "m-behind", "Atrás da pessoa", "legendas com o texto atrás da pessoa"],
];
/* ------------------------------------------------------------ cortes (linha do tempo editada)
   O <video> toca sempre o arquivo ORIGINAL; a interface mostra a linha do tempo editada (sem os trechos
   cortados, emendada). S.cuts/S.splits ficam em segundos do original; o resto converte com o2e / e2o. */
function normCuts(cuts, D) {   // mesmo critério do servidor (norm_cuts)
  const out = [];
  for (const c of [...(cuts || [])].map(([a, b]) => [+a, +b]).sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const a = Math.max(0, Math.min(...c)), b = Math.min(D, Math.max(...c));
    if (b - a < 0.02) continue;
    if (out.length && a <= out.at(-1)[1] + 1e-3) out.at(-1)[1] = Math.max(out.at(-1)[1], b);
    else out.push([+a.toFixed(4), +b.toFixed(4)]);
  }
  return out;
}
const cutLen = cuts => cuts.reduce((s, [a, b]) => s + b - a, 0);
const editDur = () => Math.max(0.02, (S.cur?.duration || 0) - cutLen(S.cuts));
// original -> editado (dentro de um corte: o ponto da emenda)
function o2e(t, cuts = S.cuts) {
  let off = 0;
  for (const [a, b] of cuts) { if (t >= b) off += b - a; else if (t > a) return a - off; else break; }
  return t - off;
}
// editado -> original (na emenda, o lado de depois do corte)
function e2o(te, cuts = S.cuts) {
  let t = te;
  for (const [a, b] of cuts) { if (a <= t + 1e-9) t += b - a; else break; }
  return t;
}
const cutAt = t => S.cuts.find(([a, b]) => t >= a - 1e-6 && t < b) || null;
// último instante que ainda aparece (o fim do último trecho que sobrou)
const keptEnd = () => { const D = S.cur.duration, c = S.cuts.at(-1); return c && c[1] >= D - 1e-3 ? c[0] : D; };
// clipes da faixa de vídeo: trechos que sobraram, divididos pela lâmina
function clips() {
  if (!S.cur) return [];
  const D = S.cur.duration, out = [];
  let a = 0;
  const kept = [];
  for (const [ca, cb] of S.cuts) { if (ca > a) kept.push([a, ca]); a = Math.max(a, cb); }
  if (a < D) kept.push([a, D]);
  for (const [ka, kb] of kept) {
    const pts = [ka, ...S.splits.filter(t => t > ka + 0.02 && t < kb - 0.02).sort((x, y) => x - y), kb];
    for (let i = 0; i + 1 < pts.length; i++) if (pts[i + 1] - pts[i] >= 0.02) out.push({ a: pts[i], b: pts[i + 1] });
  }
  return out;
}

/* ------------------------------------------------------------ linha do tempo: zoom */
const TL = { zoom: 1, clip: null, pending: 0, drag: null };
const tlView = () => $("#timeline");
const maxZoom = () => Math.max(1, editDur() * 600 / Math.max(1, tlView().clientWidth));   // até ~600 px por segundo
function setZoom(z, clientX = null) {
  const vp = tlView(), w = vp.clientWidth || 1;
  z = Math.max(1, Math.min(maxZoom(), z));
  // ponto que fica parado: o ponteiro (roda do mouse) ou a agulha (botões e teclas), se ela estiver à vista
  let px;
  if (clientX != null) px = clientX - vp.getBoundingClientRect().left;
  else {
    const hx = S.cur ? o2e(S.t) / editDur() * w * TL.zoom - vp.scrollLeft : -1;
    px = hx >= 0 && hx <= w ? hx : w / 2;
  }
  const frac = (vp.scrollLeft + px) / (w * TL.zoom);
  TL.zoom = z;
  $("#tlInner").style.width = `${z * 100}%`;
  vp.classList.toggle("zoomed", z > 1.001);
  vp.scrollLeft = frac * w * z - px;
  $("#tlZoomVal").textContent = z < 9.95 ? `${(Math.round(z * 10) / 10).toString().replace(".", ",")}×` : `${Math.round(z)}×`;
  $("#btnZoomOut").disabled = z <= 1.001; $("#btnZoomIn").disabled = z >= maxZoom() - 1e-3;
  drawRuler(); drawThumbsSoon();
}
const zoomBy = (f, clientX) => setZoom(TL.zoom * f, clientX);
$("#btnZoomIn").addEventListener("click", () => zoomBy(1.6));
$("#btnZoomOut").addEventListener("click", () => zoomBy(1 / 1.6));
$("#btnZoomFit").addEventListener("click", () => setZoom(1));
tlView().addEventListener("wheel", e => {
  if (!S.cur) return;
  if (e.ctrlKey || e.altKey || e.metaKey) {   // zoom centrado no ponteiro (como no Premiere / CapCut)
    e.preventDefault();
    const d = e.deltaY || e.deltaX;
    zoomBy(Math.exp(-Math.max(-300, Math.min(300, d)) * 0.0022), e.clientX);
    return;
  }
  if (TL.zoom > 1.001 || e.shiftKey) {        // roda sozinha (ou shift) rola na horizontal
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    tlView().scrollLeft += d;
  }
}, { passive: false });
new ResizeObserver(() => { if (S.cur) setZoom(TL.zoom); }).observe(tlView());

// régua com o tempo editado; o passo das marcas acompanha o zoom
function drawRuler() {
  const el = $("#tlRuler"); if (!S.cur) { el.innerHTML = ""; return; }
  const ED = editDur(), pps = tlView().clientWidth * TL.zoom / ED;
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => s * pps >= 64) || 600;
  let h = "";
  for (let k = 0, t = 0; t <= ED + 1e-6 && k < 2000; k++, t = k * step) {
    const m = Math.floor(t / 60), r = t - m * 60;
    const lab = step < 1 ? `${m}:${r.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.round(r)).padStart(2, "0")}`;
    h += `<i style="left:${t / ED * 100}%">${k ? lab : ""}</i>`;
  }
  el.innerHTML = h;
}

function drawTimeline() {
  const tr = $("#tlTrack"), fl = $("#tlFlashes"); tr.innerHTML = ""; fl.innerHTML = "";
  if (!S.cur) return;
  $("#tcDur").textContent = fmtTime(editDur());
  drawClips(); drawRuler(); syncCutNote();
  if (!S.plan) return updateHead();
  const ED = editDur(), X = t => o2e(t) / ED * 100;
  for (const sc of S.plan.scenes) {
    const el = document.createElement("div");
    el.className = `tl-scene ${sc.mode}${sc.behind ? " behind" : ""}${sc.behind && S.plan.live?.matte?.need ? " pending" : ""}`;
    const l = X(sc.t_in), w = Math.max(0.05 / ED * 100, X(sc.t_out) - l);
    el.style.left = `${l}%`;
    el.style.width = `calc(${w}% - 1px)`;
    el.innerHTML = `<span>${escapeHtml(sc.text.replace(/ \/ /g, " "))}</span>`;
    sc._el = el; tr.appendChild(el);
  }
  for (const f of S.plan.flashes) {
    if (cutAt(f)) continue;
    const el = document.createElement("div"); el.className = "tl-flash"; el.style.left = `${X(f)}%`; fl.appendChild(el);
  }
  const emph = S.plan.words.filter(w => w.emph && !w.cut);
  for (const w of emph) {
    const el = document.createElement("div"); el.className = "tl-emph"; el.style.left = `${X(w.start)}%`; fl.appendChild(el);
  }
  // vários estilos: onde começa cada bloco
  secList().forEach((b, k) => {
    if (!k) return;
    const w = S.plan.words.find(x => x.sec === k && !x.cut); if (!w) return;
    const el = document.createElement("div"); el.className = "tl-sec"; el.style.left = `${X(w.start)}%`;
    el.title = `Bloco ${k + 1}: ${presetTitle(b.preset)}`; el.innerHTML = `<i>${k + 1}</i>`; fl.appendChild(el);
  });
  // emendas (onde saiu um trecho cortado)
  for (const [a] of S.cuts) {
    const el = document.createElement("div"); el.className = "tl-join"; el.style.left = `${X(a)}%`; fl.appendChild(el);
  }
  const modes = new Set(S.plan.scenes.map(sc => sc.mode));
  if (S.plan.flashes.length) modes.add("flash");
  if (emph.length) modes.add("emph");
  if (S.plan.scenes.some(sc => sc.behind)) modes.add("behind");
  const leg = LEGEND.filter(([ms]) => ms.some(m => modes.has(m)));
  $("#tlLegend").innerHTML = leg.map(([, cls, l, d]) => `<span title="${d}"><b class="${cls}"></b>${l}</span>`).join("");
  markRich();
  updateHead();
}

// faixa de vídeo: um bloco por clipe, com miniaturas do vídeo
function drawClips() {
  const box = $("#tlClips"); box.innerHTML = "";
  if (!S.cur) return;
  const ED = editDur(), all = clips();
  if (TL.clip != null && !all.some(c => Math.abs(c.a - TL.clip) < 1e-4)) TL.clip = null;
  for (const c of all) {
    const el = document.createElement("div");
    el.className = "tl-clip" + (TL.clip != null && Math.abs(c.a - TL.clip) < 1e-4 ? " sel" : "");
    el.dataset.a = c.a; el.dataset.b = c.b;
    el.style.left = `${o2e(c.a) / ED * 100}%`;
    el.style.width = `calc(${(c.b - c.a) / ED * 100}% - 2px)`;
    el.title = `Clipe ${fmtTime(o2e(c.a))} – ${fmtTime(o2e(c.b))} · clique para selecionar, Delete apaga`;
    el.innerHTML = `<canvas></canvas><span>${(c.b - c.a).toFixed(1).replace(".", ",")} s</span>`;
    box.appendChild(el);
  }
  syncClipTools(); drawThumbsSoon();
}
function syncClipTools() {
  $("#btnCutClip").disabled = TL.clip == null;
  $("#btnBlade").disabled = !S.cur;
}
function syncCutNote() {
  const el = $("#expCuts"), n = S.cuts.length;
  el.hidden = !S.cur || !n;
  if (n) el.textContent = `O vídeo sai com ${fmtTime(editDur())}: ${n === 1 ? "1 trecho cortado" : `${n} trechos cortados`} na linha do tempo (vídeo e áudio).`;
}

/* miniaturas: um <video> escondido busca alguns quadros, uma vez por projeto */
const TH = { gen: 0, frames: [], vid: null };
function thumbsReset() {
  TH.gen++; TH.frames = [];
  if (TH.vid) { TH.vid.removeAttribute("src"); TH.vid.load(); TH.vid = null; }
}
async function thumbsStart() {
  thumbsReset();
  const p = S.cur; if (!p?.source || !p.duration) return;
  const gen = TH.gen, v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.playsInline = true; v.src = E(p.source); TH.vid = v;
  const wait = (ev, ms = 4000) => new Promise(res => {
    const done = ok => { clearTimeout(tm); v.removeEventListener(ev, h); v.removeEventListener("error", er); res(ok); };
    const h = () => done(true), er = () => done(false);
    const tm = setTimeout(() => done(false), ms);
    v.addEventListener(ev, h); v.addEventListener("error", er);
  });
  if (v.readyState < 1 && !await wait("loadedmetadata", 15000)) return;
  if (gen !== TH.gen) return;
  const n = Math.max(6, Math.min(72, Math.ceil(p.duration / 0.4)));
  const FH = 64, FW = Math.max(16, Math.round(FH * (v.videoWidth || 9) / (v.videoHeight || 16)));
  // ordem grossa → fina: a faixa já fica legível com as primeiras miniaturas
  const order = [];
  for (let st = 8; st >= 1; st >>= 1) for (let i = 0; i < n; i += st) if (!order.includes(i)) order.push(i);
  for (const [k, i] of order.entries()) {
    const t = Math.min(p.duration - 0.05, (i + 0.5) / n * p.duration);
    v.currentTime = t;
    if (!await wait("seeked")) { if (gen !== TH.gen) return; continue; }
    if (gen !== TH.gen) return;
    const c = document.createElement("canvas"); c.width = FW; c.height = FH;
    try { c.getContext("2d").drawImage(v, 0, 0, FW, FH); } catch { continue; }
    TH.frames.push({ t, c }); TH.frames.sort((x, y) => x.t - y.t);
    if (k < 8 || k % 6 === 5) drawThumbsSoon();
  }
  drawThumbsSoon();
  if (gen === TH.gen) { v.removeAttribute("src"); v.load(); TH.vid = null; }
}
function drawThumbs() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  for (const el of $$("#tlClips .tl-clip")) {
    const cv = $("canvas", el), w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) continue;
    const cw = Math.min(16000, Math.round(w * dpr)), ch = Math.round(h * dpr);
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    const ctx = cv.getContext("2d"); ctx.clearRect(0, 0, cw, ch);
    if (!TH.frames.length) continue;
    const a = +el.dataset.a, b = +el.dataset.b, f0 = TH.frames[0].c, tw = Math.max(8, ch * f0.width / f0.height);
    for (let x = 0; x < cw; x += tw) {
      const t = a + Math.min(1, (x + tw / 2) / cw) * (b - a);
      let best = TH.frames[0];
      for (const f of TH.frames) if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
      ctx.drawImage(best.c, x, 0, tw, ch);
    }
  }
}
let thumbsRaf = 0;
const drawThumbsSoon = () => { cancelAnimationFrame(thumbsRaf); thumbsRaf = requestAnimationFrame(drawThumbs); };

/* lâmina e apagar trecho (entram no desfazer como qualquer outra mudança) */
async function saveCuts(body, msg) {
  if (!S.cur) return;
  const pid = S.cur.id;
  TL.pending++;
  try { await api(`/api/projects/${pid}`, { method: "PUT", body }); }
  catch (e) { toast(e.message, true); }
  finally { TL.pending--; }
  if (S.cur?.id !== pid) return;
  if (msg) toast(msg, false, { label: "Desfazer", fn: undo });
  await refreshPlan();
  loadProjects();   // a duração na lista de projetos já sai editada
}
function blade() {
  if (!S.cur) return;
  const t = S.t, c = clips().find(c => t > c.a && t < c.b);
  if (!c || cutAt(t)) return toast("Ponha a agulha dentro de um clipe para dividir", true);
  if (t - c.a < 0.05 || c.b - t < 0.05) return toast("Muito perto da ponta do clipe: mova a agulha um pouco", true);
  checkpoint();
  S.splits = [...S.splits, +t.toFixed(4)].sort((x, y) => x - y);
  TL.clip = null; H.group = null;
  drawClips(); syncHistory();
  saveCuts({ splits: S.splits }, `Clipe dividido em ${fmtTime(o2e(t))}`);
}
function deleteClip() {
  if (!S.cur || TL.clip == null) return;
  const all = clips(), c = all.find(c => Math.abs(c.a - TL.clip) < 1e-4);
  if (!c) { TL.clip = null; return syncClipTools(); }
  if (all.length < 2) return toast("Não dá para apagar o vídeo inteiro: divida o clipe antes (Ctrl+B)", true);
  checkpoint();
  const te = o2e(c.a);
  S.cuts = normCuts([...S.cuts, [c.a, c.b]], S.cur.duration);
  TL.clip = null; H.group = null;
  clearSel();
  drawTimeline(); syncHistory();
  seek(e2o(Math.min(te, editDur() - 0.01)));   // a agulha vai para a emenda
  saveCuts({ cuts: S.cuts }, `Trecho de ${(c.b - c.a).toFixed(1).replace(".", ",")} s apagado`);
}
$("#btnBlade").addEventListener("click", blade);
$("#btnCutClip").addEventListener("click", deleteClip);
function selectClip(a) {
  TL.clip = a;
  for (const el of $$("#tlClips .tl-clip")) el.classList.toggle("sel", a != null && Math.abs(+el.dataset.a - a) < 1e-4);
  syncClipTools();
}

function updateHead() {
  if (!S.cur) return;
  const ED = editDur(), te = o2e(S.t), f = Math.min(1, te / ED);
  $("#tlHead").style.left = `calc(${f * 100}% - 1px)`;
  $("#tcNow").textContent = fmtTime(te);
  let now = null;
  for (const sc of S.plan?.scenes || []) {
    const on = S.t >= sc.t_in && S.t < sc.t_out;
    sc._el?.classList.toggle("now", on);
    if (on) now = sc;
  }
  $("#sceneNow").innerHTML = now ? `<b>${MODE_NAMES[now.mode] || now.mode}</b>${escapeHtml(now.text)}` : "";
  // com zoom: a linha do tempo acompanha a agulha quando ela sai da área visível
  const vp = tlView();
  if (TL.zoom > 1.001 && !TL.drag) {
    const w = vp.clientWidth, x = f * w * TL.zoom;
    if (x < vp.scrollLeft || x > vp.scrollLeft + w - 8) vp.scrollLeft = !$("#player").paused ? x - w * 0.08 : x - w / 2;
  }
  markRichNow();
}

/* ------------------------------------------------------------ prévia ao vivo
   O <video> toca o arquivo original (com som) e, por cima, canvases recebem a legenda em camadas
   que o motor desenha sob demanda (/live): normal, luz (screen), mistura do estilo e clarão.
   Cada quadro tem uma assinatura (plan.live.segs) que só muda quando muda o que aparece nele:
   depois de uma edição só esses quadros são pedidos de novo, começando pelos de perto do cursor. */
const LV = {
  blobs: new Map(),     // "sig:i" -> [{name, x, y, blob}]  (PNG, leve; guarda o vídeo inteiro)
  bmps: new Map(),      // "sig:i" -> Promise<[{name, x, y, bmp}]>  (decodificados, só os de perto)
  ready: new Map(),     // "sig:i" -> [{name, x, y, bmp}] já decodificados (desenho sem esperar)
  inflight: new Set(),  // "sig:i" já pedidos
  reqs: 0,              // pedidos em andamento
  want: null,           // quadro que deveria estar na tela
  shown: null,          // quadro que está na tela
  gen: 0,               // muda a cada projeto aberto (descarta respostas antigas)
  hold: null,           // depois de arrastar: a camada fica deslocada até chegar o quadro na posição nova
  bg: null,             // gradiente desenhado na camada de baixo (muda só quando o gradiente muda)
  bgImg: null,          // a imagem do gradiente (também vai no recorte da pessoa)
  person: null,         // recorte da pessoa do quadro atual {bmp, x, y} (texto atrás dela)
  bgCache: new Map(),   // assinatura do gradiente -> imagem (um por bloco de estilo)
  blend: null,          // modo de mistura aplicado às camadas "blend"
};
// arrastar desloca só as camadas que se movem (o gradiente e o recorte da pessoa ficam parados)
const BACK_LAYERS = ["back_normal", "back_screen", "back_blend"], FRONT_LAYERS = ["normal", "screen", "blend", "flash"];
const moveLayers = (names, tf) => names.forEach(n => { $(`#live canvas[data-l="${n}"]`).style.transform = tf; });
const releaseHold = () => { LV.hold = null; moveLayers([...BACK_LAYERS, ...FRONT_LAYERS], ""); };
const BLEND_CSS = { difference: "difference", screen: "screen", overlay: "overlay", soft_light: "soft-light", hard_light: "hard-light",
  color_dodge: "color-dodge", add: "plus-lighter", lighten: "lighten", darken: "darken", multiply: "multiply",
  exclusion: "exclusion", divide: "normal", normal: "normal" };
const liveFps = () => S.plan?.live?.fps || 30;
const frameAt = t => Math.max(0, Math.floor(t * liveFps() + 1e-4));
function sigAt(i) {
  const segs = S.plan?.live?.segs || [];
  let lo = 0, hi = segs.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, s = segs[m];
    if (i < s[0]) hi = m - 1; else if (i > s[1]) lo = m + 1; else return s[2];
  }
  return "0";
}
const liveKey = i => { const s = sigAt(i); return s === "0" ? "0" : `${s}:${i}`; };
const liveTotal = () => { const segs = S.plan?.live?.segs; return segs?.length ? segs.at(-1)[1] + 1 : 0; };

function liveReset() {
  LV.gen++; LV.inflight.clear(); LV.reqs = 0; LV.want = LV.shown = LV.bg = LV.vt = LV.pendingSeek = null; LV.vfc = false;
  LV.bgCache.clear();
  for (const p of LV.bmps.values()) p.then(ls => ls.forEach(l => l.bmp.close?.())).catch(() => {});
  LV.blobs.clear(); LV.bmps.clear(); LV.ready.clear();
  paintLive(null); paintBg(null);
}
// gradiente atrás da legenda: uma imagem só, na camada de baixo
function paintBg(img) {
  const c = $('#live canvas[data-l="bg"]'), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  LV.bgImg = img || null;
  if (img) ctx.drawImage(img, 0, 0, c.width, c.height);
}
// texto atrás da pessoa: a camada "person" é o próprio vídeo (com o gradiente), mascarado pelo recorte
// do quadro. Redesenhada a cada quadro do vídeo para acompanhar o movimento.
function paintPerson() {
  const c = $('#live canvas[data-l="person"]'), ctx = c.getContext("2d"), p = LV.person, pl = $("#player");
  ctx.clearRect(0, 0, c.width, c.height);
  // não usa readyState: arrastando, a próxima busca já começou e ele cai, mas o quadro está na tela
  if (!p || !pl.videoWidth) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(p.x, p.y, p.w, p.h); ctx.clip();
  ctx.drawImage(pl, 0, 0, c.width, c.height);
  if (LV.bgImg) ctx.drawImage(LV.bgImg, 0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(p.bmp, p.x, p.y, p.w, p.h);   // o recorte vem em meia resolução
  ctx.restore();
}
// vários estilos no vídeo: cada bloco tem o próprio gradiente e modo de mistura (a partir do 1º quadro dele)
function partAt(i) {
  const ps = S.plan?.live?.parts || [];
  let k = 0;
  ps.forEach((p, j) => { if (i >= p.f0) k = j; });
  return k;
}
function liveLook(i) {
  const lv = S.plan?.live; if (!lv) return;
  const k = partAt(i), p = lv.parts?.[k] || lv;
  const mode = BLEND_CSS[p.blend] || "normal";
  if (LV.blend !== mode) {
    LV.blend = mode;
    for (const n of ["blend", "back_blend"]) $(`#live canvas[data-l="${n}"]`).style.mixBlendMode = mode;
  }
  liveBg(p.bg, k);
}
async function liveBg(want, k = 0) {
  const pid = S.cur?.id;
  if (want === LV.bg) return;
  LV.bg = want;
  if (!want) return paintBg(null);
  if (LV.bgCache.has(want)) return paintBg(LV.bgCache.get(want));
  try {
    const img = await createImageBitmap(await (await fetch(`${ENGINE}/api/projects/${pid}/live_bg.png?k=${want}&p=${k}`)).blob());
    if (S.cur?.id !== pid) return;
    LV.bgCache.set(want, img);
    if (LV.bg === want) paintBg(img);
  } catch { if (LV.bg === want) LV.bg = null; }
}
// plano novo: ajusta as camadas ao tamanho/modo de mistura e solta quadros que não servem mais
function liveSetup() {
  const lv = S.plan?.live; if (!lv) return;
  for (const c of $$("#live canvas")) {
    if (c.width !== lv.w || c.height !== lv.h) { c.width = lv.w; c.height = lv.h; LV.shown = LV.bg = null; }
  }
  LV.blend = null; liveLook(frameAt(shownTime()));
  if (LV.blobs.size > 4000) {   // mantém o plano atual (e o anterior fica para o desfazer até encher)
    const keep = new Set(); for (let i = 0, n = liveTotal(); i < n; i++) keep.add(liveKey(i));
    for (const k of LV.blobs.keys()) if (!keep.has(k)) LV.blobs.delete(k);
  }
}

function paintLive(layers) {
  for (const c of $$('#live canvas:not([data-l="bg"]):not([data-l="person"])')) {
    const ctx = c.getContext("2d"); ctx.clearRect(0, 0, c.width, c.height);
    for (const l of layers || []) if (l.name === c.dataset.l) ctx.drawImage(l.bmp, l.x, l.y, l.w, l.h);
  }
  LV.person = (layers || []).find(l => l.name === "person") || null;
  paintPerson();
}
function bitmaps(k) {
  let p = LV.bmps.get(k);
  if (!p) {
    p = Promise.all(LV.blobs.get(k).map(async l => ({ ...l, bmp: await createImageBitmap(l.blob) })));
    p.then(ls => { if (LV.bmps.get(k) === p) LV.ready.set(k, ls); }).catch(() => LV.bmps.delete(k));
    LV.bmps.set(k, p);
    if (LV.bmps.size > 150) {   // poucos decodificados de cada vez (ocupam memória de vídeo)
      const old = LV.bmps.keys().next().value;
      if (old !== LV.shown && old !== LV.want) {
        LV.bmps.get(old).then(ls => ls.forEach(l => l.bmp.close?.())).catch(() => {});
        LV.bmps.delete(old); LV.ready.delete(old);
      }
    }
  }
  return p;
}
const liveWaiting = on => { $("#frameLoading").classList.toggle("on", on); $("#previewState").textContent = on ? "desenhando a legenda…" : ""; };
// desenha a legenda do quadro i (se ainda não chegou, mantém a anterior e pede)
async function liveDraw(i) {
  if (!S.plan?.live) return;
  const k = liveKey(i);
  LV.want = k;
  liveLook(i);
  if (k === "0") { LV.shown = k; liveWaiting(false); return paintLive(null); }
  if (!LV.blobs.has(k)) { liveWaiting(true); livePump(); return; }
  liveWaiting(false);
  if (LV.shown === k) return;
  const layers = LV.ready.get(k) || await bitmaps(k);   // já decodificado: desenha neste mesmo quadro
  if (LV.want !== k) return;
  LV.shown = k; paintLive(layers);
  if (LV.hold && k !== LV.hold) releaseHold();
}
// decodifica adiantado os próximos quadros (para o play não engasgar)
function liveDecodeAhead(i, n = 12) {
  for (let j = i + 1; j <= i + n; j++) { const k = liveKey(j); if (k !== "0" && LV.blobs.has(k)) bitmaps(k); }
}

// pede os quadros que faltam: primeiro perto do cursor (mais à frente quando está tocando), depois o resto do vídeo
function livePump() {
  if (!S.cur || !S.plan?.live || LV.stale) return;
  const n = liveTotal(), playing = !$("#player").paused;
  const cur = frameAt(S.t), fps = liveFps();
  const missing = (a, b, max) => {
    const out = [];
    for (let i = Math.max(0, a); i < Math.min(n, b) && out.length < max; i++) {
      const k = liveKey(i);
      if (k !== "0" && !LV.blobs.has(k) && !LV.inflight.has(k)) out.push(i);
    }
    return out;
  };
  // o quadro da tela vem sozinho, primeiro (resposta mais rápida depois de uma edição)
  if (missing(cur, cur + 1, 1).length) liveFetch([cur]);
  while (LV.reqs < 3) {
    let want = missing(cur, cur + fps * (playing ? 4 : 1), 30);
    if (!want.length && !playing) want = missing(cur - fps, cur, 30);
    if (!want.length && LV.reqs === 0) want = missing(cur, n, 20).concat(missing(0, cur, 20)).slice(0, 20);   // resto, com calma
    if (!want.length) break;
    liveFetch(want);
  }
}
async function liveFetch(idx) {
  const pid = S.cur.id, gen = LV.gen, keys = idx.map(liveKey);
  keys.forEach(k => LV.inflight.add(k)); LV.reqs++;
  const ranges = [];
  for (const i of idx) { const r = ranges.at(-1); if (r && r[1] === i - 1) r[1] = i; else ranges.push([i, i]); }
  try {
    const buf = await (await fetch(`${ENGINE}/api/projects/${pid}/live?f=${ranges.map(([a, b]) => a === b ? a : `${a}-${b}`).join(",")}`)).arrayBuffer();
    if (gen !== LV.gen) return;
    const dv = new DataView(buf), hl = dv.getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    const base = 4 + hl;
    for (const fr of head.frames) {
      LV.blobs.set(`${fr.sig}:${fr.i}`, fr.l.map(([name, x, y, w, h, off, len]) =>
        ({ name, x, y, w, h, blob: new Blob([new Uint8Array(buf, base + off, len)], { type: "image/png" }) })));
      // o servidor já está noutra versão (exportação recortou, outra aba editou…): pede o plano novo
      // em vez de repetir para sempre o pedido com a assinatura velha
      if (fr.sig !== sigAt(fr.i) && !LV.stale) { LV.stale = true; refreshPlan(); }
    }
  } catch { /* tenta de novo no próximo pedido */ }
  finally {
    if (gen === LV.gen) { keys.forEach(k => LV.inflight.delete(k)); LV.reqs--; }
  }
  if (gen !== LV.gen) return;
  if (LV.want && LV.want !== LV.shown) liveDraw(frameAt(shownTime()));
  livePump();
}

/* ------------------------------------------------------------ cursor, play, palavras clicáveis */
async function fetchHits(t) {
  if (!S.cur?.has_words || !S.plan) { S.hits = []; return drawHits(); }
  try {
    const r = await api(`/api/projects/${S.cur.id}/hits?t=${t.toFixed(3)}`);
    if (Math.abs(t - S.t) > 1e-4 || !$("#player").paused) return; // já mudou de quadro
    S.hits = r.hits;
  } catch { S.hits = []; }
  drawHits();
}
const fetchHitsSoon = debounce(t => fetchHits(t), 60);
// mostra o quadro S.t: vídeo + legenda ao vivo + palavras clicáveis
/* A legenda acompanha o quadro que o vídeo está MOSTRANDO, não a agulha. Ao arrastar a agulha o vídeo
   leva um tempo para buscar cada quadro; desenhar antes deixava o recorte da pessoa (feito do próprio
   vídeo) desencontrado da legenda, e o texto de trás aparecia na frente. */
const shownTime = () => LV.vt ?? S.t;   // instante do quadro que o vídeo está mostrando
function showAt() {
  if (!S.cur) return;
  const pl = $("#player");
  if (!pl.seeking) { LV.vt = pl.readyState >= 1 ? pl.currentTime : S.t; liveDraw(frameAt(LV.vt)); paintPerson(); }
  // buscando: quem desenha é o quadro novo quando ele aparecer (onVideoFrame / seeked)
  if (S.plan) fetchHitsSoon(S.t);
}

// t em segundos do vídeo ORIGINAL; dentro de um trecho cortado, vai para a emenda
function seek(t) {
  if (!S.cur) return;
  const end = keptEnd();
  t = Math.max(0, Math.min(end - 0.01, t));
  const c = cutAt(t);
  if (c) t = c[1] >= end - 1e-3 ? Math.max(0, c[0] - 0.01) : c[1];
  if (cutAt(t)) t = e2o(0);   // tudo antes foi cortado
  S.t = t;
  const pl = $("#player");
  if (!pl.paused) pl.pause();
  if (pl.readyState >= 1) {
    // arrastando rápido: não empilha buscas; guarda só a última e aplica quando a atual terminar
    if (pl.seeking) LV.pendingSeek = S.t;
    else { LV.pendingSeek = null; pl.currentTime = S.t; }
  }
  armVideoFrame();
  updateHead(); showAt();
}
// busca no tempo EDITADO (o que a linha do tempo e o relógio mostram)
const seekE = te => seek(e2o(Math.max(0, Math.min(editDur() - 0.01, te))));
const frameStep = () => 1 / (S.cur?.fps || 30);

/* linha do tempo: arrastar move a agulha; clique numa legenda seleciona as palavras dela
   (shift = intervalo, ctrl = soma/tira); clique num clipe da faixa de vídeo seleciona o clipe */
const xToE = clientX => { const r = $("#tlInner").getBoundingClientRect(); return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * editDur(); };
$("#tlInner").addEventListener("pointerdown", e => {
  if (!S.cur || e.button !== 0) return;
  const clip = e.target.closest(".tl-clip");
  TL.drag = { x: e.clientX, y: e.clientY, clip: clip ? +clip.dataset.a : null, moved: false, id: e.pointerId };
  $("#tlInner").setPointerCapture(e.pointerId);
  if (!clip) seekE(xToE(e.clientX));   // régua / legendas: a agulha vai direto para o ponto
});
$("#tlInner").addEventListener("pointermove", e => {
  const d = TL.drag; if (!d || d.id !== e.pointerId) return;
  if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
  if (!d.moved) return;
  seekE(xToE(e.clientX));
  // arrastando com zoom: rola quando a agulha chega na borda
  const vp = tlView(), r = vp.getBoundingClientRect();
  if (TL.zoom > 1.001) { if (e.clientX > r.right - 24) vp.scrollLeft += 18; else if (e.clientX < r.left + 24) vp.scrollLeft -= 18; }
});
const tlUp = e => {
  const d = TL.drag; if (!d || d.id !== e.pointerId) return;
  TL.drag = null;
  if (d.moved || e.type === "pointercancel" || !S.cur) return;
  if (d.clip != null) { selectClip(TL.clip != null && Math.abs(TL.clip - d.clip) < 1e-4 && (e.ctrlKey || e.metaKey) ? null : d.clip); return; }
  selectClip(null);
  if (!S.plan) return;
  const t = e2o(xToE(e.clientX));
  const sc = S.plan.scenes.find(s => t >= s.t_in && t < s.t_out && s.wi?.length);
  if (!sc) return clearSel();
  let sel;
  if (e.shiftKey && S.anchor != null) {
    const a = Math.min(S.anchor, sc.wi[0]), b = Math.max(S.anchor, sc.wi.at(-1));
    const scs = S.plan.scenes.filter(s => s.wi?.length && s.wi.at(-1) >= a && s.wi[0] <= b);
    sel = [...new Set(scs.flatMap(s => s.wi))];
  } else if (e.ctrlKey || e.metaKey) {
    const has = sc.wi.every(i => S.sel.includes(i));
    sel = has ? S.sel.filter(i => !sc.wi.includes(i)) : [...new Set([...S.sel, ...sc.wi])];
  } else sel = [...sc.wi];
  S.sel = sel.sort((x, y) => x - y);
  if (!(e.shiftKey && S.anchor != null)) S.anchor = sc.wi[0];
  if (!S.sel.length) return clearSel();
  hideTip(); markRich(); renderPop();
  $(`#rich .w[data-wi="${S.sel[0]}"]`)?.scrollIntoView({ block: "nearest" });
};
$("#tlInner").addEventListener("pointerup", tlUp);
$("#tlInner").addEventListener("pointercancel", tlUp);
$("#btnPrev").addEventListener("click", () => seekE(o2e(S.t) - frameStep()));
$("#btnNext").addEventListener("click", () => seekE(o2e(S.t) + frameStep()));

// tocando: pula os trechos cortados (um pouco antes de entrar neles, para não piscar o quadro cortado)
function skipCuts(t) {
  const pl = $("#player");
  if (pl.paused || !S.cuts.length || !S.cur) return false;
  const ahead = 1.2 / (S.cur.fps || 30);
  const c = S.cuts.find(([a, b]) => t + ahead >= a && t < b);
  if (!c) return false;
  if (c[1] >= S.cur.duration - 1e-3) { reachEnd(); return true; }
  pl.currentTime = c[1];
  return true;
}
// fim do último trecho: para (como no fim do vídeo)
function reachEnd() { const pl = $("#player"); pl.pause(); seek(firstCaptionTime()); }

// cada quadro que o vídeo apresenta (tocando ou depois de uma busca): legenda e recorte do MESMO quadro
function onVideoFrame(now, md) {
  LV.vfc = false;
  const pl = $("#player");
  LV.vt = md?.mediaTime ?? pl.currentTime;
  if (skipCuts(LV.vt)) { if (!pl.paused) nextVideoFrame(); return; }
  const i = frameAt(LV.vt);
  if (!pl.paused) { S.t = LV.vt; updateHead(); }
  liveDraw(i); paintPerson(); liveDecodeAhead(i); livePump();
  if (!pl.paused) nextVideoFrame();
}
const nextVideoFrame = () => {
  const pl = $("#player");
  if (pl.requestVideoFrameCallback) { if (!LV.vfc) { LV.vfc = true; pl.requestVideoFrameCallback(onVideoFrame); } }
  else requestAnimationFrame(() => onVideoFrame());
};
// parado: espera o próximo quadro que o vídeo apresentar (o da busca) — só com requestVideoFrameCallback
const armVideoFrame = () => { if ($("#player").requestVideoFrameCallback) nextVideoFrame(); };
async function togglePlay() {
  if (!S.cur?.has_words) return;
  const pl = $("#player");
  if (!pl.paused) { pl.pause(); return; }
  if (S.dirty) await saveNow();
  if (o2e(S.t) >= editDur() - 0.1) seekE(0);
  else if (cutAt(S.t)) seek(S.t);
  clearSel(); $("#hits").hidden = true;
  try { await pl.play(); } catch (e) { $("#hits").hidden = false; return toast("Não consegui tocar o vídeo: " + e.message, true); }
  $("#btnPlay").classList.add("playing");
  nextVideoFrame();
}
$("#btnPlay").addEventListener("click", togglePlay);
$("#player").addEventListener("pause", e => {
  // pausou: a legenda fica parada no quadro e as palavras voltam a ser clicáveis
  S.t = e.target.currentTime; $("#btnPlay").classList.remove("playing"); $("#hits").hidden = false;
  updateHead(); showAt(); renderPop();
});
$("#player").addEventListener("timeupdate", e => skipCuts(e.target.currentTime));   // reserva (sem requestVideoFrameCallback)
$("#player").addEventListener("ended", () => seek(firstCaptionTime()));
$("#player").addEventListener("seeked", () => {
  const pl = $("#player");
  if (LV.pendingSeek != null) { const t = LV.pendingSeek; LV.pendingSeek = null; pl.currentTime = t; return; }
  // busca terminada (mesmo quando o quadro não mudou): legenda e recorte do quadro que está na tela
  LV.vt = pl.currentTime; liveDraw(frameAt(LV.vt)); paintPerson();
});
$("#player").addEventListener("click", () => $("#player").pause());

/* ------------------------------------------------------------ atalhos e ajuda */
const HELP = `
  <div class="help-grid">
    <section>
      <h4>Como usar</h4>
      <ol>
        <li><b>Clique numa palavra</b> no vídeo ou no texto para corrigir, mudar a cor ou pôr efeito.</li>
        <li><b>Arraste uma palavra</b> no vídeo para mover a legenda inteira.</li>
        <li><b>Texto atrás da pessoa:</b> clique nas legendas na linha do tempo (shift ou ctrl para várias) e use “Atrás da pessoa” no menu. O vídeo é recortado só nesses trechos; arraste a palavra para posicionar cada trecho e ajuste o tamanho no menu.</li>
        <li><b>Cortar o vídeo:</b> ponha a agulha onde quer dividir e aperte <kbd>Ctrl</kbd>+<kbd>B</kbd> (ou a tesoura). Clique no clipe na faixa de vídeo e aperte <kbd>Delete</kbd>: o trecho sai (vídeo, áudio e legenda) e o resto se junta. A exportação já sai cortada.</li>
        <li>Na aba <b>Estilo</b>, escolha o visual (passe o mouse para ver animado) e ajuste tamanho, cores e fontes.</li>
        <li><b>Copiar formatação:</b> no menu da palavra, “Copiar formatação” (<kbd>Alt</kbd>+<kbd>C</kbd>) guarda os efeitos e a cor; selecione outras palavras e use “Colar formatação” (<kbd>Alt</kbd>+<kbd>V</kbd>).</li>
        <li><b>Vários estilos no mesmo vídeo:</b> clique na palavra onde o novo estilo começa e use “Novo estilo daqui em diante”. Cada bloco tem o próprio estilo e os próprios ajustes: clique numa palavra (ou no bloco, na aba Estilo) para editar aquele bloco.</li>
        <li>Dê <b>play</b> para ver em movimento e <b>exporte</b> quando estiver pronto.</li>
      </ol>
    </section>
    <section>
      <h4>Atalhos</h4>
      <table>
        <tr><td><kbd>Espaço</kbd></td><td>tocar / pausar (em qualquer lugar fora dos campos de texto)</td></tr>
        <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>quadro anterior / próximo</td></tr>
        <tr><td><kbd>Shift</kbd> + <kbd>←</kbd> <kbd>→</kbd></td><td>voltar / avançar 1 segundo</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>B</kbd> ou <kbd>K</kbd></td><td>dividir o clipe na agulha (lâmina)</td></tr>
        <tr><td><kbd>Delete</kbd> / <kbd>⌫</kbd></td><td>apagar o clipe selecionado (o resto se junta)</td></tr>
        <tr><td><kbd>Ctrl</kbd> ou <kbd>Alt</kbd> + roda</td><td>zoom na linha do tempo</td></tr>
        <tr><td><kbd>+</kbd> <kbd>−</kbd></td><td>aumentar / diminuir o zoom</td></tr>
        <tr><td>Roda ou <kbd>Shift</kbd> + roda</td><td>rolar a linha do tempo (com zoom)</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Z</kbd></td><td>desfazer</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd></td><td>refazer</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>fechar o menu da palavra / soltar o clipe</td></tr>
        <tr><td><kbd>Shift</kbd> + clique</td><td>selecionar um trecho</td></tr>
        <tr><td><kbd>Ctrl</kbd> + clique</td><td>somar palavras à seleção</td></tr>
        <tr><td><kbd>?</kbd></td><td>esta ajuda</td></tr>
      </table>
    </section>
  </div>`;
const showHelp = () => ask({ title: "Atalhos e ajuda", html: HELP, ok: "Fechar", cancel: null, wide: true });
$("#btnHelp").addEventListener("click", showHelp);

// foco num campo de texto (lá as teclas são do campo, não atalhos)
const typing = () => { const a = document.activeElement; return !!a && (["TEXTAREA", "INPUT", "SELECT"].includes(a.tagName) || a.isContentEditable); };
window.addEventListener("keydown", e => {
  if (!$("#modal").hidden || typing()) return;
  if (e.key === "?") { e.preventDefault(); showHelp(); return; }
  // espaço: tocar / pausar em qualquer lugar da tela (e nunca "clicar" o último botão focado)
  if (e.code === "Space") {
    e.preventDefault();
    if (e.repeat) return;
    const a = document.activeElement; if (a && a !== document.body) a.blur();
    togglePlay(); return;
  }
  if (!S.cur) return;
  if (e.code === "Escape") { clearSel(); selectClip(null); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.code === "KeyZ" || e.code === "KeyY")) {
    e.preventDefault();
    if (e.code === "KeyY" || e.shiftKey) redo(); else undo();
    return;
  }
  if (mod && !e.shiftKey && !e.altKey && (e.code === "KeyB" || e.code === "KeyK")) { e.preventDefault(); blade(); return; }
  if (!mod && (e.code === "Delete" || e.code === "Backspace")) { if (TL.clip != null) { e.preventDefault(); deleteClip(); } return; }
  if (!mod && !e.altKey) {
    if (e.key === "=" || e.key === "+" || e.code === "NumpadAdd") { e.preventDefault(); zoomBy(1.6); return; }
    if (e.key === "-" || e.code === "NumpadSubtract") { e.preventDefault(); zoomBy(1 / 1.6); return; }
  }
  if (e.code === "ArrowLeft") { e.preventDefault(); seekE(o2e(S.t) - (e.shiftKey ? 1 : frameStep())); }
  if (e.code === "ArrowRight") { e.preventDefault(); seekE(o2e(S.t) + (e.shiftKey ? 1 : frameStep())); }
});
// o espaço solto em cima de um botão também não pode acioná-lo
window.addEventListener("keyup", e => { if (e.code === "Space" && $("#modal").hidden && !typing()) e.preventDefault(); });

/* ------------------------------------------------------------ texto */
const setSave = (txt, cls = "") => { const el = $("#saveState"); el.textContent = txt; el.className = "save-state " + cls; };
let saveTimer = null;
function queueSave(ms = 650) {
  S.dirty = true; setSave("editando…", "dirty");
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, ms);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!S.cur) return;
  const v = $("#text").value;
  try {
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { text: v } });
    if ($("#text").value === v) { S.dirty = false; setSave("salvo", "ok"); }
    await refreshPlan();
  } catch (e) { setSave("erro ao salvar", "dirty"); toast(e.message, true); }
}
let lastTyped = null;
$("#text").addEventListener("input", () => {
  // um passo de desfazer por rajada de digitação (guarda o texto de antes dela)
  if (lastTyped === null) checkpoint(null, S.textBefore ?? $("#text").value);
  clearTimeout(lastTyped); lastTyped = setTimeout(() => { lastTyped = null; S.textBefore = $("#text").value; }, 1500);
  queueSave();
});
$("#text").addEventListener("focus", () => { S.textBefore = $("#text").value; });

/* marcações de uma palavra: mesmo formato que transcript.parse_markup lê */
const MARK_RX = [[/^\(\((.+)\)\)$/, "circle"], [/^\*(.+)\*$/, "emph"], [/^!(.+)!$/, "red"],
                 [/^_(.+)_$/, "underline"], [/^\[(.+)\]$/, "box"], [/^~(.+)$/, "solo"]];
function parseTok(raw) {
  const flags = new Set(); let color = null;
  if (raw.startsWith("!") && (raw.match(/!/g) || []).length >= 2) {
    const m = raw.match(/^!(.+?)!([.,?;:…]*)$/);
    if (m) { raw = m[1] + m[2]; flags.add("red"); }
  }
  const m = raw.match(/^(.*?)([.,!?;:…]*)$/s);
  let core = m[1]; const tail = m[2];
  let changed = true;
  while (changed && core) {
    changed = false;
    for (const [rx, f] of MARK_RX) { const mm = core.match(rx); if (mm) { core = mm[1]; flags.add(f); changed = true; } }
    const mc = core.match(/^\{(#[0-9a-fA-F]{6})\}(.+)$/);
    if (mc) { color = mc[1].toUpperCase(); core = mc[2]; changed = true; }
    const mn = core.match(/^\{-\}(.+)$/);
    if (mn) { flags.add("noemph"); flags.delete("emph"); core = mn[1]; changed = true; }
  }
  return { core, tail, flags, color };
}
function buildTok({ core, tail, flags, color }) {
  // vermelho por fora (o "!" final não pode virar pontuação), cor por dentro
  let s = core;
  if (color) s = `{${color}}${s}`;
  if (flags.has("noemph") && !flags.has("emph")) s = `{-}${s}`;
  if (flags.has("box")) s = `[${s}]`;
  if (flags.has("underline")) s = `_${s}_`;
  if (flags.has("emph")) s = `*${s}*`;
  if (flags.has("circle")) s = `((${s}))`;
  if (flags.has("solo")) s = `~${s}`;
  if (flags.has("red")) s = `!${s}!`;
  return s + tail;
}
// troca trechos [s,e) do texto (de trás para frente, para os índices continuarem valendo)
function spliceText(v, reps) {
  for (const [s, e, txt] of [...reps].sort((a, b) => b[0] - a[0])) v = v.slice(0, s) + txt + v.slice(e);
  return v;
}
function setText(v, undoable = true, group = null) {
  const ta = $("#text");
  if (v === ta.value) return;
  if (undoable) checkpoint(group);
  ta.value = v; S.textBefore = v;
  S.dirty = true; setSave("salvando…", "dirty");
  return saveNow();
}
// liga/desliga um efeito: se todas já têm, tira de todas; senão põe em todas
function toggleFlag(toks, mark) {
  const all = toks.every(t => t.p.flags.has(mark));
  for (const t of toks) {
    if (all) t.p.flags.delete(mark); else t.p.flags.add(mark);
    if (mark === "solo" && !all) t.p.flags.delete("break");
  }
}

// modo texto livre: o texto inteiro editável, com os códigos das marcações
let rawMode = false;
function setRawMode(on) {
  rawMode = on;
  $("#text").hidden = !on; $("#rich").hidden = on; $("#syntax").hidden = !on; $("#richLegend").hidden = on;
  $("#btnRawMode").textContent = on ? "Voltar à visualização" : "Editar texto livre";
  $("#textHint").textContent = on
    ? "Edite o texto à vontade: ele é re-sincronizado com o áudio. Os símbolos em volta das palavras são as marcações (veja os códigos abaixo)."
    : "Clique numa palavra (aqui ou no vídeo) para corrigir, mudar a cor ou pôr efeito. Arraste por cima do texto para pegar várias.";
  if (on) { clearSel(); $("#text").focus(); }
  else if (S.dirty) saveNow(); else renderRich();
}
$("#btnRawMode").addEventListener("click", () => setRawMode(!rawMode));

// no texto livre, clicar numa palavra leva o vídeo até ela
$("#text").addEventListener("click", () => {
  const ta = $("#text");
  if (S.dirty || !S.plan || ta.selectionStart !== ta.selectionEnd) return;
  const c = ta.selectionStart;
  const i = S.plan.words.findIndex(w => w.span && w.span[0] <= c && c <= w.span[1]);
  if (i >= 0) seek(wordViewTime(i));
});

/* ------------------------------------------------------------ texto visual (sem códigos)
   Cada palavra aparece como vai sair: cor, vermelho, elipse, traço, caixa, destaque.
   Clique / arraste seleciona e abre o mesmo menu da palavra do vídeo. */
const lum = c => { const n = parseInt(c.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); };
function renderRich() {
  const box = $("#rich");
  if (rawMode || S.dirty || !S.plan || !S.cur?.has_words) return;
  const v = $("#text").value;
  const ws = S.plan.words.map((w, i) => ({ i, w })).filter(x => x.w.span).sort((a, b) => a.w.span[0] - b.w.span[0]);
  const secs = secList();
  let mk = 0;   // divisões de estilo, em ordem (a k-ésima abre o bloco k+1)
  const gap = s => s.split(/(\{\/?card\}|\{atras(?::[^}\s]*)?\}|\{\/atras\}|\{estilo:[A-Za-z0-9_-]+\}|["“”]|\||\n)/).map(x =>
    x === "\n" ? "<br>" : x === "|" ? `<span class="rt-break" title="Quebra de legenda">⏎</span>`
      : /^\{estilo:/.test(x) ? secChip(secs[++mk], mk)
      : x === "{/atras}" ? `<span class="rt-behind" title="Fim do trecho atrás da pessoa">◂</span>`
      : /^\{atras/.test(x) ? `<span class="rt-behind" title="Texto atrás da pessoa">atrás da pessoa ▸</span>`
      : /^(\{\/?card\}|["“”])$/.test(x) ? `<span class="rt-q" title="Card de citação">“</span>` : escapeHtml(x)).join("");
  let out = "", pos = 0;
  for (const { i, w } of ws) {
    const [s, e] = w.span;
    if (s < pos) continue;
    out += gap(v.slice(pos, s));
    const p = parseTok(v.slice(s, e));
    const cls = ["w"];
    for (const f of ["emph", "red", "circle", "underline", "box", "solo", "noemph"]) if (p.flags.has(f)) cls.push(`f-${f}`);
    if (w.emph && !p.flags.has("emph")) cls.push("f-auto");
    if (w.bg != null) cls.push("f-behind");
    if (w.cut) cls.push("f-cut");
    if (S.sel.includes(i)) cls.push("sel");
    let style = "";
    if (p.color) { style = ` style="--wc:${p.color}"`; cls.push("f-color"); if (lum(p.color) < 70) cls.push("f-dark"); }
    out += `<span class="${cls.join(" ")}" data-wi="${i}"${style}${w.cut ? ' title="Trecho cortado do vídeo: esta palavra não aparece"' : ""}>${escapeHtml(p.core + p.tail)}</span>`;
    pos = e;
  }
  out += gap(v.slice(pos));
  box.innerHTML = (secs.length > 1 ? secChip(secs[0], 0) : "") + out;
  S.nowWi = null; markRichNow();
}
function markRich() {
  for (const el of $$("#rich .w")) el.classList.toggle("sel", S.sel.includes(+el.dataset.wi));
  // a seleção também aparece na linha do tempo (legendas escolhidas)
  for (const sc of S.plan?.scenes || []) sc._el?.classList.toggle("picked", !!sc.wi?.some(i => S.sel.includes(i)));
}
function markRichNow() {
  if (!S.plan || rawMode) return;
  const i = S.plan.words.findIndex(w => S.t >= w.start && S.t < w.end);
  if (i === S.nowWi) return;
  $("#rich .w.now")?.classList.remove("now");
  S.nowWi = i;
  if (i >= 0) $(`#rich .w[data-wi="${i}"]`)?.classList.add("now");
}
// seleção vinda do texto: leva o vídeo até a palavra e abre o menu dela
function selectFromText(sel, anchor) {
  S.sel = sel; S.anchor = anchor;
  markRich();
  if (!sel.length) return clearSel();
  hideTip();
  seek(wordViewTime(sel[0]));
  renderPop();
  setTimeout(() => { const i = $("#wpText"); i.focus(); i.select(); }, 0);
}
let richDragged = false;
$("#rich").addEventListener("mouseup", () => {
  const ns = getSelection();
  if (!ns || ns.isCollapsed || !$("#rich").contains(ns.anchorNode)) return;
  const r = ns.getRangeAt(0);
  const wis = $$("#rich .w").filter(el => r.intersectsNode(el)).map(el => +el.dataset.wi).sort((a, b) => a - b);
  ns.removeAllRanges();
  if (!wis.length) return;
  richDragged = true;
  selectFromText(wis, wis[0]);
});
$("#rich").addEventListener("click", e => {
  if (richDragged) { richDragged = false; return; }
  const el = e.target.closest(".w");
  if (!el) return;
  const wi = +el.dataset.wi;
  if (e.shiftKey && S.anchor != null) {
    const [a, b] = [Math.min(S.anchor, wi), Math.max(S.anchor, wi)];
    selectFromText(Array.from({ length: b - a + 1 }, (_, k) => a + k), S.anchor);
  } else if (e.ctrlKey || e.metaKey) {
    selectFromText(S.sel.includes(wi) ? S.sel.filter(x => x !== wi) : [...S.sel, wi].sort((x, y) => x - y), wi);
  } else selectFromText([wi], wi);
});

/* ------------------------------------------------------------ edição direto no preview */
function drawHits() {
  const box = $("#hits"); box.innerHTML = "";
  box.style.transform = ""; box.classList.remove("dragging");
  if (!LV.hold) releaseHold();
  for (const h of S.hits) {
    const el = document.createElement("div");
    el.className = "hit" + (S.sel.includes(h.wi) ? " sel" : "");
    el.style.left = `${h.x0 * 100}%`; el.style.top = `${h.y0 * 100}%`;
    el.style.width = `${(h.x1 - h.x0) * 100}%`; el.style.height = `${(h.y1 - h.y0) * 100}%`;
    el.dataset.wi = h.wi;
    box.appendChild(el);
  }
  renderPop();
}
const hideTip = () => { $("#phoneTip").hidden = true; lsSet("lp.tipSeen", "1"); };
$("#phoneTipX").addEventListener("click", hideTip);
// arrastar uma palavra move a legenda inteira (layout.offset_x / offset_y) — ou, se ela está num trecho
// atrás da pessoa, só aquele trecho (posição própria no {atras:dx,dy,escala}); clique sem arrastar seleciona
let drag = null, dragMoved = false;
const curOffset = p => getPath(merge(S.base, S.overrides), p) ?? 0;
$("#hits").addEventListener("pointerdown", e => {
  dragMoved = false;   // depois de um arrastar o navegador nem sempre dispara "click": zera a cada toque
  const hit = e.target.closest(".hit");
  if (e.button !== 0 || !hit) return;
  const g = S.plan?.groups?.[S.plan.words[+hit.dataset.wi]?.bg];
  if (!g) selectSec(secOfWord(+hit.dataset.wi));   // vários estilos: arrastar move só o bloco da palavra
  drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, group: g || null,
           ox: g ? g.dx : curOffset("layout.offset_x"), oy: g ? g.dy : curOffset("layout.offset_y") };
});
$("#hits").addEventListener("pointermove", e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  if (!drag.moved) {
    // só captura o ponteiro quando vira arrastar; antes disso o clique precisa chegar na palavra
    drag.moved = true; clearSel();
    $("#hits").setPointerCapture(drag.id);
  }
  const box = $("#hits"), r = $("#phone").getBoundingClientRect();
  box.classList.add("dragging");
  const tf = `translate(${dx}px, ${dy}px)`;
  box.style.transform = tf;
  moveLayers(drag.group ? BACK_LAYERS : [...BACK_LAYERS, ...FRONT_LAYERS], tf);
  drag.nx = Math.max(-.45, Math.min(.45, Math.round((drag.ox + dx / r.width) * 200) / 200));
  drag.ny = Math.max(-.8, Math.min(.8, Math.round((drag.oy + dy / r.height) * 200) / 200));
  if (Math.abs(drag.nx) < .015) drag.nx = 0;   // gruda no centro
  $("#dragTip").hidden = false;
  $("#dragTip").textContent = `${drag.group ? "trecho atrás · " : ""}${drag.nx === 0 ? "centro" : `${drag.nx > 0 ? "→" : "←"} ${Math.round(Math.abs(drag.nx) * 100)}%`} · ${drag.ny === 0 ? (drag.group ? "altura da legenda" : "altura do estilo") : `${drag.ny > 0 ? "↓" : "↑"} ${Math.round(Math.abs(drag.ny) * 100)}%`}`;
});
$("#hits").addEventListener("pointercancel", () => { drag = null; $("#dragTip").hidden = true; releaseHold(); drawHits(); });
$("#hits").addEventListener("pointerup", () => {
  if (!drag) return;
  const d = drag; drag = null; $("#dragTip").hidden = true;
  if (!d.moved) return;
  dragMoved = true; hideTip();
  LV.hold = LV.shown; setTimeout(releaseHold, 2000);
  if (d.group) {
    setGroup(d.group, { dx: d.nx, dy: d.ny });
    toast("Trecho atrás da pessoa movido", false, { label: "Desfazer", fn: undo });
    return;
  }
  checkpoint(); setOverride("layout.offset_x", d.nx, false); setOverride("layout.offset_y", d.ny, false); syncControls();
  toast(multiSec() ? `Legenda do bloco ${secNum(S.sec)} movida` : "Legenda movida", false, { label: "Desfazer", fn: undo });
});
$("#hits").addEventListener("click", e => {
  if (dragMoved) { dragMoved = false; return; }
  const h = e.target.closest(".hit");
  if (!h) return clearSel();
  hideTip();
  const wi = +h.dataset.wi;
  if (e.shiftKey && S.anchor != null) {
    const [a, b] = [Math.min(S.anchor, wi), Math.max(S.anchor, wi)];
    S.sel = Array.from({ length: b - a + 1 }, (_, k) => a + k);
  } else if (e.ctrlKey || e.metaKey) {
    S.sel = S.sel.includes(wi) ? S.sel.filter(x => x !== wi) : [...S.sel, wi].sort((x, y) => x - y);
    S.anchor = wi;
  } else { S.sel = [wi]; S.anchor = wi; }
  drawHits(); markRich();
  $(`#rich .w[data-wi="${S.sel[0]}"]`)?.scrollIntoView({ block: "nearest" });
  const w = S.plan.words[S.sel[0]];
  if (rawMode && w?.span && !S.dirty) $("#text").setSelectionRange(w.span[0], S.plan.words[S.sel.at(-1)].span[1]);
  if (S.sel.length) setTimeout(() => { const i = $("#wpText"); i.focus(); i.select(); }, 0);
});
function clearSel() {
  S.sel = []; S.anchor = null;
  $$("#hits .hit.sel").forEach(el => el.classList.remove("sel"));
  markRich();
  $("#wordPop").hidden = true; shiftPhone(0);
}

const selToks = () => {
  const v = $("#text").value;
  return S.sel.map(i => S.plan.words[i]).filter(w => w?.span)
    .map(w => ({ s: w.span[0], e: w.span[1], p: parseTok(v.slice(w.span[0], w.span[1])) }));
};
/* texto atrás da pessoa: trechos {atras:dx,dy,escala} … {/atras} (S.plan.groups; words[i].bg = trecho) */
const groupOf = i => S.plan?.groups?.[S.plan.words[i]?.bg];
const num = v => String(+(+v).toFixed(3));
// {atras} sem números = posição automática (o servidor escolhe pela silhueta da pessoa)
const groupTag = g => g.auto ? "{atras}" : `{atras:${num(g.dx)},${num(g.dy)},${num(g.s)}}`;
// muda posição/tamanho de um trecho reescrevendo a etiqueta dele (undo: passos seguidos viram um só)
let pendingGroup = null;   // mudança de trecho que espera o plano novo (aplicada no refreshPlan)
function setGroup(g, changes, undoGroup = null) {
  const v = $("#text").value;
  if (S.dirty || editing || !/^\{atras[^}]*\}$/.test(v.slice(g.open[0], g.open[1]))) {
    // o texto mudou e as posições ainda não foram recalculadas: guarda e aplica depois (a última vence)
    pendingGroup = { g: g.g, changes: { ...(pendingGroup?.g === g.g ? pendingGroup.changes : {}), ...changes }, undoGroup };
    return;
  }
  // mexer à mão (arrastar, tamanho) parte da posição atual — mesmo a automática — e vira manual
  return setText(spliceText(v, [[g.open[0], g.open[1], groupTag({ ...g, ...changes, auto: !!changes.auto })]]), true, undoGroup);
}
// tira a etiqueta e um espaço vizinho
const cutTag = (v, [a, b]) => v[b] === " " ? [a, b + 1, ""] : v[a - 1] === " " ? [a - 1, b, ""] : [a, b, ""];
// junta cortes que se sobrepõem (etiquetas coladas disputando o mesmo espaço), senão um come uma letra
const mergeCuts = cuts => cuts.sort((x, y) => x[0] - y[0]).reduce((out, c) => {
  const l = out.at(-1);
  if (l && c[0] <= l[1]) l[1] = Math.max(l[1], c[1]); else out.push([...c]);
  return out;
}, []);

// a seleção já é destaque: escolhida pelo estilo ou marcada à mão (assim o botão sempre muda algo)
const isEmph = toks => S.sel.every((i, k) => S.plan.words[i]?.emph || toks[k]?.p.flags.has("emph"));
const contiguousSel = () => S.sel.every((x, k) => k === 0 || x === S.sel[k - 1] + 1);
// o trecho [a,b) está entre aspas de card?
const cardAround = (v, a, b) => {
  const mb = v.slice(0, a).match(/["“]\s*$/), ma = v.slice(b).match(/^\s*["”]/);
  return mb && ma ? [mb[0].length, ma[0].length] : null;
};
const SWATCHES = () => [
  [null, "Padrão do estilo"], [S.base?.colors?.text, "Cor do texto"], [S.base?.colors?.red, "Vermelho do estilo"],
  [S.base?.colors?.accent, "Cor da elipse"], ["#FFFFFF", "Branco"], ["#FFD60A", "Amarelo"], ["#FF8A00", "Laranja"],
  ["#E3241D", "Vermelho"], ["#49DC7B", "Verde"], ["#3DA5FF", "Azul"], ["#B86CFF", "Roxo"], ["#111111", "Preto"],
].filter(([c], k, a) => k === 0 || (c && a.findIndex(([x]) => x?.toUpperCase() === c.toUpperCase()) === k));

/* efeitos disponíveis e o que cada um faz no estilo atual (preset.effect_notes) */
const PHRASE_ONLY_HIDE = ["solo", "card"];   // não existem nos estilos do motor "frase"
function syncEffects() {
  const st = S.base ? merge(S.base, S.overrides) : {};
  const notes = st.effect_notes || {};
  const phrase = engineOf(st) === "phrase";
  for (const b of $$("#wpMarks button")) {
    const m = b.dataset.mark;
    b.hidden = (phrase && PHRASE_ONLY_HIDE.includes(m)) || (m === "card" && !getPath(st, "rules.cards.enabled"));
    if (m === "behind") b.disabled = S.plan?.live?.matte?.model === false;
    const n = notes[m];
    if (n) b.title = `${b.textContent.trim()}: ${n}`;
  }
  // ícone de cada efeito = prévia renderizada pelo próprio preset (como vai sair no vídeo)
  const pname = st.name, ver = S.base?._v || 0;
  for (const b of $$("#wpMarks button")) {
    const m = b.dataset.mark;
    if (!["destaque", "red", "circle", "underline", "box", "solo"].includes(m) || !pname) continue;
    let img = $("img.fx-ico", b);
    if (!img) {
      img = document.createElement("img"); img.className = "fx-ico"; img.alt = "";
      img.onerror = () => { img.hidden = true; if (b.firstElementChild !== img) b.firstElementChild.hidden = false; };
      b.prepend(img);
    }
    const src = `${ENGINE}/api/presets/${encodeURIComponent(pname)}/fx/${m}.png?v=${ver}`;
    if (img.getAttribute("src") !== src) { img.hidden = false; img.src = src; }
    const old = img.nextElementSibling;
    if (old && old.tagName !== "IMG" && old !== b.lastChild) old.hidden = true;   // esconde o "Aa" genérico
  }
  $("#wpNote").innerHTML = notes.destaque ? `<b>Destaque neste estilo:</b> ${escapeHtml(notes.destaque)}` : "";
}

function renderPop() {
  const pop = $("#wordPop");
  const pl = $("#player");
  // vários estilos: a aba Estilo e os efeitos do menu seguem o bloco da palavra escolhida
  const sk = S.sel.join();
  if (sk !== S.secSel) { S.secSel = sk; if (S.sel.length && S.plan) selectSec(secOfWord(S.sel[0])); }
  markRich();
  if (!S.sel.length || !S.plan || !pl.paused) { pop.hidden = true; shiftPhone(0); return; }
  const toks = selToks();
  if (!toks.length) { pop.hidden = true; shiftPhone(0); return; }
  pop.hidden = false;
  syncEffects();
  $("#wpCount").textContent = toks.length === 1 ? "1 palavra" : `${toks.length} palavras`;
  const inp = $("#wpText");
  if (document.activeElement !== inp || inp.dataset.sel !== S.sel.join()) {
    inp.value = toks.map(t => t.p.core + t.p.tail).join(" ");
    inp.dataset.sel = S.sel.join();
  }
  const v = $("#text").value;
  const lastEnd = toks.at(-1).e;
  for (const b of $$("#wpMarks button")) {
    const m = b.dataset.mark;
    b.classList.toggle("on", m === "break" ? /^\s*\|/.test(v.slice(lastEnd))
      : m === "destaque" ? isEmph(toks)
      : m === "card" ? !!cardAround(v, toks[0].s, lastEnd)
      : m === "behind" ? S.sel.every(i => S.plan.words[i]?.bg != null)
      : m === "section" ? !!startsSec(S.sel[0])
      : toks.every(t => t.p.flags.has(m)));
  }
  // trecho atrás da pessoa: tamanho e posição própria (quando a seleção está num trecho só)
  const gs = new Set(S.sel.map(i => S.plan.words[i]?.bg));
  const g = gs.size === 1 ? groupOf(S.sel[0]) : null;
  $("#wpBehind").hidden = !g;
  const pb = $("#wpPasteFmt");
  pb.disabled = !S.fmt;
  pb.title = S.fmt ? `Aplica a formatação de “${S.fmt.word}” (${fmtName(S.fmt)}) nas palavras selecionadas (Alt+V)`
    : "Copie antes a formatação de uma palavra (Alt+C)";
  const sb = $('#wpMarks button[data-mark="section"]');
  sb.hidden = !canSections();
  sb.disabled = S.sel[0] === 0 && !startsSec(0);
  $("b + span", sb).textContent = startsSec(S.sel[0]) ? "Tirar divisão de estilo" : "Novo estilo daqui em diante";
  if (g) {
    const sl = $("#wpBehindSize");
    if (document.activeElement !== sl) { sl.value = g.s; paintRange(sl); }
    $("#wpBehindSizeOut").textContent = `${(+sl.value).toFixed(2)}×`;
    $("#wpBehindHint").textContent = g.auto
      ? (g.placed ? "Posição automática (pela silhueta da pessoa). Arraste a palavra no vídeo para ajustar à mão."
                  : "Posição automática: sai assim que o recorte da pessoa ficar pronto.")
      : "Posição ajustada à mão. Arraste a palavra no vídeo para mover só este trecho.";
    $("#wpBehindReset").disabled = !!g.auto;
  }
  const cur = toks.every(t => t.p.color === toks[0].p.color) ? toks[0].p.color : undefined;
  const sws = SWATCHES();
  $("#wpColorName").textContent = cur === undefined ? "· várias" : cur === null ? "· padrão do estilo"
    : `· ${sws.find(([c]) => c?.toUpperCase() === cur)?.[1] || cur}`;
  $("#wpColors").innerHTML = sws.map(([c, n]) => c
    ? `<button class="sw${cur === c.toUpperCase() ? " on" : ""}" data-c="${c.toUpperCase()}" title="${n} ${c.toUpperCase()}" aria-label="${n}" style="--c:${c}"></button>`
    : `<button class="sw sw-none${cur === null ? " on" : ""}" data-c="" title="${n}" aria-label="${n}"></button>`).join("") +
    `<label class="sw sw-pick" title="Outra cor"><input type="color" aria-label="Outra cor" value="${(cur || "#ffd60a").toLowerCase()}"></label>`;
  placePop();
}
function shiftPhone(px) {
  const ph = $("#phone"); ph._shift = px; ph.style.transform = px ? `translateX(${-px}px)` : "";
}
function placePop() {
  const pop = $("#wordPop"), wrap = $(".phone-wrap"), phone = $("#phone");
  const wr = wrap.getBoundingClientRect(), r0 = phone.getBoundingClientRect();
  const s0 = phone._shift || 0, pw0 = pop.offsetWidth;
  // posição do vídeo sem deslocamento; se o menu não cabe à direita mas cabe somando os dois lados, desloca
  const natL = r0.left + s0, natR = r0.right + s0, need = pw0 + 26;
  const shift = wr.right - natR >= need || natL - wr.left >= need ? 0
    : Math.max(0, Math.min(natL - wr.left - 8, need - (wr.right - natR)));
  if (shift !== s0) shiftPhone(shift);
  const pr = { left: natL - shift, right: natR - shift, top: r0.top, height: r0.height, width: r0.width };
  const hs = S.hits.filter(h => S.sel.includes(h.wi));
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let top = pr.top - wr.top + pr.height * 0.45 - ph / 2;
  let x0 = pr.left, x1 = pr.right, y1 = pr.top + pr.height * 0.5;
  if (hs.length) {
    x0 = pr.left + Math.min(...hs.map(h => h.x0)) * pr.width; x1 = pr.left + Math.max(...hs.map(h => h.x1)) * pr.width;
    const y0 = pr.top + Math.min(...hs.map(h => h.y0)) * pr.height; y1 = pr.top + Math.max(...hs.map(h => h.y1)) * pr.height;
    top = (y0 + y1) / 2 - wr.top - ph / 2;
  }
  let left;
  if (wr.right - pr.right >= pw + 18) left = pr.right - wr.left + 14;          // ao lado do vídeo
  else if (pr.left - wr.left >= pw + 18) left = pr.left - wr.left - pw - 14;
  else {                                                                          // por cima, abaixo das palavras
    left = (x0 + x1) / 2 - wr.left - pw / 2;
    top = y1 - wr.top + 12;
    if (top + ph > wr.height - 8) top = (hs.length ? pr.top + Math.min(...hs.map(h => h.y0)) * pr.height : y1) - wr.top - ph - 12;
  }
  pop.style.left = `${Math.max(8, Math.min(wr.width - pw - 8, left))}px`;
  pop.style.top = `${Math.max(8, Math.min(wr.height - ph - 8, top))}px`;
}
window.addEventListener("resize", () => { if (!$("#wordPop").hidden) placePop(); });

let editing = false;   // uma edição por vez: as posições das palavras só valem depois do plano novo
async function editSel(fn) {
  if (editing) return;
  editing = true;
  try {
    if (S.dirty) await saveNow();
    const toks = selToks();
    if (!toks.length) return;
    const v = fn(toks, $("#text").value);
    if (typeof v === "string") await setText(v);
  } finally { editing = false; }
}
$("#wpClose").addEventListener("click", clearSel);
$("#wpMarks").addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  const mark = b.dataset.mark;
  if (mark === "section") return splitHere();
  editSel((toks, v) => {
    if (mark === "destaque") {
      // liga: força o destaque; desliga: tira também o destaque que o motor escolheu sozinho
      const on = isEmph(toks);
      for (const t of toks) {
        if (on) { t.p.flags.delete("emph"); t.p.flags.add("noemph"); }
        else { t.p.flags.delete("noemph"); t.p.flags.add("emph"); }
      }
      return spliceText(v, toks.map(t => [t.s, t.e, buildTok(t.p)]));
    }
    if (mark === "break") {
      const end = toks.at(-1).e, m = v.slice(end).match(/^(\s*)\|/);
      return m ? v.slice(0, end) + v.slice(end + m[0].length) : v.slice(0, end) + " |" + v.slice(end);
    }
    if (mark === "behind") {
      if (!S.plan.live?.matte?.model) { toast("O recorte da pessoa não está disponível neste PC", true); return; }
      const groups = S.plan.groups || [];
      if (S.sel.every(i => S.plan.words[i]?.bg != null)) {
        // tudo já atrás: volta para a frente (tira as etiquetas dos trechos tocados)
        const reps = [];
        for (const g of new Set(S.sel.map(i => S.plan.words[i].bg))) {
          reps.push(cutTag(v, groups[g].open));
          if (groups[g].close && groups[g].close[1] > groups[g].close[0]) reps.push(cutTag(v, groups[g].close));
        }
        return spliceText(v, mergeCuts(reps));
      }
      // cada legenda tocada pela seleção vira um trecho próprio, com posição automática: o servidor
      // olha a silhueta da pessoa e põe o texto parcialmente atrás dela (dá para arrastar depois)
      const open = "{atras} ";
      const reps = [];
      for (const sc of S.plan.scenes.filter(sc => sc.wi?.some(i => S.sel.includes(i)))) {
        const ws = sc.wi.filter(i => S.plan.words[i]?.bg == null && S.plan.words[i]?.span);
        if (!ws.length) continue;
        reps.push([S.plan.words[ws[0]].span[0], S.plan.words[ws[0]].span[0], open]);
        reps.push([S.plan.words[ws.at(-1)].span[1], S.plan.words[ws.at(-1)].span[1], " {/atras}"]);
      }
      return spliceText(v, reps);
    }
    if (mark === "card") {
      if (!contiguousSel()) { toast("Para virar card, selecione um trecho seguido (shift+clique)", true); return; }
      const a = toks[0].s, z = toks.at(-1).e, q = cardAround(v, a, z);
      return q ? v.slice(0, a - q[0]) + v.slice(a, z) + v.slice(z + q[1]) : v.slice(0, a) + `"${v.slice(a, z).replace(/["“”]/g, "")}"` + v.slice(z);
    }
    toggleFlag(toks, mark);
    return spliceText(v, toks.map(t => [t.s, t.e, buildTok(t.p)]));
  });
});
$("#wpColors").addEventListener("click", e => {
  const b = e.target.closest("button.sw"); if (!b) return;
  const c = b.dataset.c || null;
  editSel((toks, v) => { toks.forEach(t => { t.p.color = c; }); return spliceText(v, toks.map(t => [t.s, t.e, buildTok(t.p)])); });
});
$("#wpColors").addEventListener("change", e => {
  if (e.target.type !== "color") return;
  const c = e.target.value.toUpperCase();
  editSel((toks, v) => { toks.forEach(t => { t.p.color = c; }); return spliceText(v, toks.map(t => [t.s, t.e, buildTok(t.p)])); });
});
/* copiar / colar formatação: efeitos (destaque, vermelho, elipse, traço, caixa, solo) e cor de uma palavra
   aplicados em outras. O destaque escolhido pelo estilo também conta (vira destaque marcado). */
const FMT_FLAGS = ["emph", "noemph", "red", "circle", "underline", "box", "solo"];
const fmtName = f => {
  const names = { emph: "destaque", noemph: "sem destaque", red: "vermelho", circle: "elipse", underline: "traço", box: "caixa", solo: "solo" };
  const l = FMT_FLAGS.filter(x => f.flags.includes(x)).map(x => names[x]);
  if (f.color) l.push(`cor ${f.color}`);
  return l.length ? l.join(", ") : "sem efeitos (texto comum)";
};
function copyFmt() {
  const t = selToks()[0]; if (!t) return;
  const flags = FMT_FLAGS.filter(f => t.p.flags.has(f));
  if (S.plan.words[S.sel[0]]?.emph && !flags.includes("emph") && !flags.includes("noemph")) flags.push("emph");
  S.fmt = { flags, color: t.p.color, word: t.p.core };
  renderPop();
  toast(`Formatação de “${t.p.core}” copiada: ${fmtName(S.fmt)}. Selecione outras palavras e cole.`);
}
function pasteFmt() {
  const f = S.fmt; if (!f) return;
  editSel((toks, v) => {
    for (const t of toks) {
      for (const x of FMT_FLAGS) t.p.flags.delete(x);
      for (const x of f.flags) t.p.flags.add(x);
      if (f.flags.includes("solo")) t.p.flags.delete("break");
      t.p.color = f.color;
    }
    toast(`Formatação colada em ${toks.length === 1 ? "1 palavra" : `${toks.length} palavras`}`, false, { label: "Desfazer", fn: undo });
    return spliceText(v, toks.map(t => [t.s, t.e, buildTok(t.p)]));
  });
}
$("#wpCopyFmt").addEventListener("click", copyFmt);
$("#wpPasteFmt").addEventListener("click", pasteFmt);
document.addEventListener("keydown", e => {
  if (!e.altKey || e.ctrlKey || e.metaKey || !S.sel.length || $("#wordPop").hidden) return;
  if (typing()) return;
  const k = e.key.toLowerCase();
  if (k === "c") { e.preventDefault(); copyFmt(); }
  if (k === "v") { e.preventDefault(); pasteFmt(); }
});
const pushGroupSize = debounce(v => { const g = groupOf(S.sel[0]); if (g) setGroup(g, { s: v }, `size:${g.g}`); }, 140);
$("#wpBehindSize").addEventListener("input", e => {
  paintRange(e.target); $("#wpBehindSizeOut").textContent = `${(+e.target.value).toFixed(2)}×`; pushGroupSize(+e.target.value);
});
$("#wpBehindSize").addEventListener("dblclick", e => { e.target.value = 1; e.target.dispatchEvent(new Event("input")); });
$("#wpBehindReset").addEventListener("click", () => { const g = groupOf(S.sel[0]); if (g) setGroup(g, { auto: true }); });

function applyWordText() {
  const typed = $("#wpText").value.trim();
  editSel((toks, v) => {
    const now = toks.map(t => t.p.core + t.p.tail).join(" ");
    if (typed === now) return;
    const parts = typed ? typed.split(/\s+/) : [];
    if (parts.length === toks.length) {
      // mesma quantidade de palavras: corrige uma a uma mantendo efeitos e cor
      return spliceText(v, toks.map((t, k) => {
        const n = parseTok(parts[k]);
        return [t.s, t.e, buildTok({ ...t.p, core: n.core || parts[k], tail: n.tail })];
      }));
    }
    if (!contiguousSel()) { toast("Para mudar a quantidade de palavras, selecione um trecho seguido (shift+clique)", true); return; }
    // quantidade diferente: troca o trecho inteiro (os efeitos da primeira palavra vão para a primeira nova)
    let out = parts.slice();
    if (out.length) { const n = parseTok(out[0]); out[0] = buildTok({ ...toks[0].p, core: n.core || out[0], tail: n.tail }); }
    const a = toks[0].s, b = toks.at(-1).e;
    S.sel = out.length ? Array.from({ length: out.length }, (_, k) => S.sel[0] + k) : [];
    if (!out.length) return v.slice(0, a) + v.slice(b).replace(/^[ \t]+/, ""); // apagou: leva o espaço junto
    return v.slice(0, a) + out.join(" ") + v.slice(b);
  });
}
$("#wpText").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); applyWordText(); }
  if (e.key === "Escape") { e.preventDefault(); $("#wpText").blur(); clearSel(); }
});

$("#btnRetrans").addEventListener("click", async () => {
  if (!S.cur) return;
  if (!await ask({ title: "Transcrever de novo?", text: "O texto atual, com as correções e efeitos, será substituído pela nova transcrição. Isso não pode ser desfeito.", ok: "Transcrever de novo", danger: true })) return;
  const j = await api(`/api/projects/${S.cur.id}/transcribe`, { method: "POST", body: { model: $("#retransModel").value } });
  H.past = []; H.future = []; syncHistory();
  $("#inspector").classList.add("disabled"); watchJob(j);
});

/* ------------------------------------------------------------ restaurar / salvar estilo */
$("#btnResetStyle").addEventListener("click", async () => {
  if (!S.cur) return;
  if (!Object.keys(S.overrides).length) return toast("O estilo já está como o original");
  checkpoint();
  S.overrides = {}; storeEd(); syncControls(); syncEffects();
  await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: edBody({ overrides: {} }) }); refreshPlan();
  toast("Estilo restaurado", false, { label: "Desfazer", fn: undo });
});
$("#btnSavePreset").addEventListener("click", async () => {
  const name = $("#newPresetName").value.trim();   // vazio: o servidor usa o próximo número
  const data = merge(S.base, S.overrides);
  delete data.tagline;
  try {
    const r = await api("/api/presets", { method: "POST", body: { name, description: $("#newPresetDesc").value.trim(), data } });
    checkpoint();
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: edBody({ preset: r.name }) });
    S.overrides = {}; setEdPreset(r.name);
    await loadPresets(); refreshPlan();
    $("#newPresetName").value = ""; $("#newPresetDesc").value = "";
    toast(`Estilo “${name || presetTitle(r.name)}” salvo`);
  } catch (e) { toast(e.message, true); }
});

/* ------------------------------------------------------------ exportar */
const Q_LABEL = { 16: "qualidade máxima", 18: "qualidade alta", 22: "qualidade leve" };
function renderExports(highlight) {
  const box = $("#exports"); box.innerHTML = "";
  const files = S.cur?.exports || [];
  if (files.length) box.insertAdjacentHTML("beforeend", `<h3 class="eyebrow">Já exportados</h3>`);
  for (const f of files) {
    const info = S.cur.exports_info?.[f];
    const url = `${ENGINE}/files/${S.cur.id}/${f}?v=${info?.time || Date.now()}`;
    const el = document.createElement("div"); el.className = "export-item"; el.dataset.file = f;
    const isMp4 = f.endsWith(".mp4");
    const sub = info ? [fmtDate(info.time), presetTitle(info.preset), `${info.width}×${info.height}`, Q_LABEL[info.quality]].filter(Boolean).join(" · ") : "";
    el.innerHTML = `${isMp4 ? `<video src="${url}" controls preload="metadata"></video>` : ""}
      <div class="exp-head"><b>${isMp4 ? "Vídeo legendado" : "Só a legenda, transparente (MOV)"}</b>
        <span class="exp-stale" hidden title="O texto ou o estilo mudou depois desta exportação. Exporte de novo para incluir as mudanças.">desatualizado</span></div>
      ${sub ? `<small class="exp-sub">${escapeHtml(sub)}</small>` : ""}
      <div class="row">
        <a class="btn btn-sm btn-primary" href="${ENGINE}/files/${S.cur.id}/${f}?download=1">Baixar</a>
        <button class="btn btn-sm" data-reveal="${f}">Mostrar na pasta</button>
      </div>`;
    if (f === highlight) el.classList.add("fresh");
    box.appendChild(el);
  }
  updateExportBadges();
}
function updateExportBadges() {
  let any = false;
  for (const el of $$("#exports .export-item")) {
    const info = S.cur?.exports_info?.[el.dataset.file];
    const stale = !!(info && S.plan && info.key !== S.plan.key);
    $(".exp-stale", el).hidden = !stale; any ||= stale;
  }
  $("#exportDot").hidden = !any;
}
$("#exports").addEventListener("click", e => {
  const b = e.target.closest("[data-reveal]"); if (!b || !S.cur) return;
  api(`/api/projects/${S.cur.id}/reveal`, { method: "POST", body: { file: b.dataset.reveal } }).catch(err => toast(err.message, true));
});
$("#btnExport").addEventListener("click", async () => {
  if (!S.cur) return;
  if (S.dirty) await saveNow();
  const kind = $("input[name=fmt]:checked").value;
  const j = await api(`/api/projects/${S.cur.id}/render`, {
    method: "POST", body: { kind, resolution: $("#expRes").value, quality: $("#expQ").value },
  });
  watchJob(j);
});
$$("input[name=fmt]").forEach(r => r.addEventListener("change", () => {
  const alpha = $("input[name=fmt]:checked").value === "alpha";
  $("#expQ").disabled = alpha; $("#expRes").disabled = alpha;
  $("#btnExport").textContent = alpha ? "Exportar legenda transparente" : "Exportar vídeo";
}));

/* ------------------------------------------------------------ abas */
const openTab = name => {
  $$(".tab").forEach(x => x.classList.toggle("active", x.dataset.tab === name));
  $$(".pane").forEach(p => p.classList.toggle("active", p.dataset.pane === name));
};
$$(".tab").forEach(t => t.addEventListener("click", () => openTab(t.dataset.tab)));

/* ------------------------------------------------------------ início */
const MODEL_LABEL = {
  "large-v3-turbo": "Rápida e precisa (recomendada)", "large-v3": "Mais precisa, mais lenta",
  medium: "Média", small: "Leve", tiny: "Rascunho, bem rápida",
};
// chip "GPU": o que cada etapa usa neste PC. Enquanto a aceleração NVIDIA baixa (uma vez, em segundo
// plano), consulta de novo e avisa quando terminar ou falhar.
function showHardware() {
  const g = $("#chipGpu");
  const hw = S.status.hw || {}, pack = hw.cuda_pack || {};
  g.classList.toggle("on", S.status.gpu || S.status.nvenc);
  g.title = [`Placa: ${(hw.gpus || []).join(", ") || "nenhuma"}`, `Processador: ${hw.cpu || "?"}`,
    `Transcrição: ${hw.whisper || "processador"}`, `Exportação: ${hw.encoder || "processador"}`,
    `Recorte da pessoa: ${hw.matte || "?"}`, ["running", "error"].includes(pack.state) ? pack.message : ""]
    .filter(Boolean).join("\n");
  if (pack.state === "running") {
    setTimeout(async () => {
      try {
        S.status = await api("/api/status");
        const st = S.status.hw?.cuda_pack?.state;
        if (st === "done") toast("Aceleração NVIDIA instalada: a transcrição agora usa a placa de vídeo");
        else if (st === "error") toast(S.status.hw.cuda_pack.message, true);
        showHardware();
      } catch (e) { /* servidor fechado: tenta de novo na próxima abertura */ }
    }, 15000);
  }
}

/* ------------------------------------------------------------ atualização do motor
   O motor procura versão nova sozinho (latest.json assinado na Release do GitHub), baixa e confere. Aqui só
   aparece o aviso no topo e a janela "Este computador" (clicar no chip GPU). Motor antigo, sem atualizador
   (1.0.0 a 1.0.3): no site, compara a versão dele com a publicada no config.js e oferece o download. */
const U = { st: null, timer: null };
const vnum = v => String(v || "0").split(".").map(n => parseInt(n, 10) || 0);
const vnewer = (a, b) => {
  const x = vnum(a), y = vnum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
const isMac = () => /Mac/i.test(`${navigator.userAgentData?.platform || navigator.platform || ""} ${navigator.userAgent}`);
function downloadUrl() {
  const cfg = window.LEGENDAPRO || {};
  return (isMac() && cfg.DOWNLOAD_URL_MAC) || cfg.DOWNLOAD_URL || "https://legendapro.pages.dev/";
}
function updLine(st) {
  switch (st?.state) {
    case "uptodate": return "Você está na versão mais nova.";
    case "available": return `A versão ${st.latest} está disponível.`;
    case "downloading": return `Baixando a versão ${st.latest}…`;
    case "ready": return `A versão ${st.latest} está pronta para instalar.`;
    case "checking": return "Procurando atualizações…";
    case "failed": return st.message;
    case "error": return st.message;
    default: return "Ainda não procurou atualizações.";
  }
}
async function updRefresh(check = false) {
  clearTimeout(U.timer);
  try { U.st = await api(check ? "/api/update/check" : "/api/update", check ? { method: "POST" } : {}); }
  catch { U.st = null; }            // motor sem atualizador, ou fechado
  updRender();
  U.timer = setTimeout(updRefresh, ["checking", "downloading"].includes(U.st?.state) ? 2000 : 60000);
}
function updRender() {
  const b = $("#updBadge"), st = U.st, cfg = window.LEGENDAPRO || {};
  b.hidden = true; b.classList.remove("busy"); b.onclick = null;
  const show = (text, onclick) => { b.hidden = false; b.textContent = text; b.onclick = onclick || null; b.classList.toggle("busy", !onclick); };
  if (!st) {
    if (!LOCAL_UI && cfg.VERSION && vnewer(cfg.VERSION, S.status?.version))
      show(`Versão ${cfg.VERSION} disponível · Baixar`, () => window.open(downloadUrl(), "_blank"));
    return;
  }
  if (st.state === "downloading") show(`Baixando a versão ${st.latest} · ${Math.round((st.progress || 0) * 100)}%`);
  else if (st.state === "installing") show("Instalando a atualização…");
  else if (st.state === "ready") show(`Versão ${st.latest} pronta · Atualizar agora`, updInstall);
  else if (st.state === "available" && st.installable && st.signed)
    show(`Versão ${st.latest} disponível · Baixar e instalar`, async () => {
      U.st = await api("/api/update/download", { method: "POST" }); updRefresh();
    });
  else if (st.state === "available")
    show(`Versão ${st.latest} disponível · Baixar`, () => window.open(st.download_url || downloadUrl(), "_blank"));
}
async function updInstall() {
  const v = U.st.latest;
  if (!await ask({ title: `Atualizar para a versão ${v}?`, ok: "Atualizar agora",
    text: "O LegendaPRO fecha, instala a versão nova e abre de novo sozinho, em cerca de 1 minuto. Seus projetos e estilos continuam onde estão." })) return;
  try { await api("/api/update/install", { method: "POST" }); } catch (e) { return toast(e.message, true); }
  // espera a versão nova responder (a página do site recarrega; a local vai para a porta nova)
  engineLostShown = true;
  $("#gateTitle").textContent = `Atualizando para a versão ${v}…`;
  $("#gate .gate-card > p").textContent = "Isso leva cerca de 1 minuto. A página continua sozinha quando o LegendaPRO abrir de novo.";
  $("#gate .gate-steps").hidden = true; $("#gate .gate-actions").hidden = true;
  $("#gateWait").hidden = false; $("#gateWait").textContent = "instalando…";
  $("#gate").hidden = false;
  const t0 = Date.now();
  const again = async () => {
    const f = await probeEngine();
    if (f && !vnewer(v, f.status.version)) return LOCAL_UI ? location.assign(f.base + "/") : location.reload();
    if (Date.now() - t0 > 4 * 60000) $("#gateWait").textContent = "está demorando mais que o normal: abra o LegendaPRO pelo atalho";
    setTimeout(again, 2000);
  };
  setTimeout(again, 5000);
}
$("#chipGpu").addEventListener("click", async () => {
  const hw = S.status?.hw || {}, st = U.st;
  const li = (k, v) => `<li>${k}: <b>${escapeHtml(v || "?")}</b></li>`;
  const html = `<ul class="hw-list">${li("Versão do motor", S.status?.version)}${li("Placa de vídeo", (hw.gpus || []).join(", ") || "nenhuma")}${li("Processador", hw.cpu)}${li("Transcrição", hw.whisper)}${li("Exportação", hw.encoder)}${li("Recorte da pessoa", hw.matte)}</ul>` +
    (st ? `<label class="upd-row"><input type="checkbox" id="updAuto"${st.auto ? " checked" : ""}> Atualizar automaticamente</label>
           <p class="upd-note">${escapeHtml(updLine(st))}${st.installable ? "" : " Esta cópia (portátil ou de desenvolvimento) não se instala sozinha: baixe a versão nova pelo site."}</p>`
        : `<p class="upd-note">Este motor é de uma versão sem atualização automática. Baixe a versão nova pelo site uma vez; depois ela se atualiza sozinha.</p>`);
  const res = ask({ title: "Este computador", html, ok: st ? "Procurar atualizações" : "Fechar", cancel: st ? "Fechar" : null });
  $("#updAuto")?.addEventListener("change", e =>
    api("/api/update", { method: "PUT", body: { auto: e.target.checked } }).then(r => { U.st = r; updRender(); }).catch(err => toast(err.message, true)));
  if (await res && st) {
    await updRefresh(true);
    for (let i = 0; i < 20 && U.st?.state === "checking"; i++) { await new Promise(r => setTimeout(r, 500)); await updRefresh(); }
    toast(updLine(U.st), U.st?.state === "error");
  }
});

// Site: acha o motor no PC (portas 7860–7869). O primeiro pedido pode abrir a pergunta do navegador
// sobre "acessar dispositivos da rede local"; enquanto ela estiver aberta, o pedido só espera.
const ENGINE_API = 1;   // mínimo para funcionar; recursos novos olham S.status.api (canSections)
async function probeEngine() {
  const tries = [];
  for (let port = 7860; port < 7870; port++) {
    const base = `http://127.0.0.1:${port}`;
    tries.push(fetch(`${base}/api/status`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => j.engine === "legendapro" ? { base, status: j } : Promise.reject()));
  }
  try { return await Promise.any(tries); } catch { return null; }
}
// Chrome/Edge: se a pessoa negou "acessar dispositivos da rede local", o motor nunca responde; explica
// como liberar em vez de ficar procurando para sempre
async function lnaHint() {
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      const st = await navigator.permissions.query({ name });
      if (st.state === "denied") {
        $("#gateWait").textContent = "o navegador bloqueou o acesso deste site ao seu PC: clique no cadeado ao lado do endereço → Acesso à rede local → Permitir, e recarregue a página";
        return;
      }
      if (st.state) return;
    } catch { /* navegador sem essa permissão */ }
  }
}
async function connectEngine() {
  if (LOCAL_UI) return api("/api/status");
  const cfg = window.LEGENDAPRO || {};
  // os dois downloads aparecem sempre (Windows e Mac); sem link no config.js, o botão some
  $("#gateDownload").href = cfg.DOWNLOAD_URL || "/";
  $("#gateDownloadMac").href = cfg.DOWNLOAD_URL_MAC || "/";
  $("#gateDownloadMac").hidden = !cfg.DOWNLOAD_URL_MAC;
  // por enquanto o motor só existe para Windows: no Mac/celular, avisa em vez de oferecer o .exe
  const plat = `${navigator.userAgentData?.platform || navigator.platform || ""} ${navigator.userAgent}`;
  const mobile = /Android|iPhone|iPad|iPod/i.test(plat) || navigator.userAgentData?.mobile;
  const mac = !mobile && /Mac/i.test(plat);
  if (mac && cfg.DOWNLOAD_URL_MAC) {
    // Mac: o download do Mac vem primeiro; o Safari costuma barrar https → http://127.0.0.1
    $("#gateDownloadMac").after($("#gateDownload"));
    if (/Safari/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg\//i.test(navigator.userAgent))
      $("#gateWait").textContent = "no Mac, use o Chrome ou o Edge: o Safari não deixa a página falar com o motor do seu computador";
  } else if (mobile || mac) {
    $("#gateTitle").textContent = mobile ? "O LegendaPRO roda num computador" : "Versão para Mac em breve";
    $("#gate .gate-card > p").textContent = mobile
      ? "O processamento acontece no motor instalado num computador com Windows 10/11. Abra este endereço no computador."
      : "Por enquanto o motor do LegendaPRO, que faz a transcrição e a exportação no seu computador, existe só para Windows 10/11. A versão para Mac está a caminho.";
    $("#gate .gate-steps").hidden = true; $("#gate .gate-actions").hidden = true; $("#gateWait").hidden = true;
  }
  let found = await probeEngine();
  if (!found) {
    $("#gate").hidden = false;
    while (!found) {           // espera a pessoa abrir o motor (ou permitir o acesso) e segue sozinha
      await new Promise(r => setTimeout(r, 2000));
      found = await probeEngine();
      if (!found) await lnaHint();
    }
    $("#gate").hidden = true;
  }
  ENGINE = found.base;
  if ((found.status.api || 0) < ENGINE_API)
    toast(`O motor instalado (versão ${found.status.version || "antiga"}) é mais velho que o site: baixe a versão nova`, true);
  return found.status;
}

(async function init() {
  $("#inspector").classList.add("disabled");
  S.showAdv = lsGet("lp.adv") === "1";
  S.uploadPreset = lsGet("lp.uploadPreset");
  try {
    S.status = await connectEngine();
    showHardware();
    updRefresh();
    const mopts = S.status.models.map(m => `<option value="${m}"${m === S.status.default_model ? " selected" : ""}>${MODEL_LABEL[m] || m}</option>`).join("");
    $("#uploadModel").innerHTML = mopts; $("#retransModel").innerHTML = mopts;
    await loadPresets();
    await loadProjects();
    const last = lsGet("lp.last");
    if (last && S.projects.some(p => p.id === last)) openProject(last);
  } catch (e) { toast("Servidor indisponível: " + e.message, true); }
})();
