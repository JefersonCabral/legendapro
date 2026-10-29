"use strict";
/* LegendaPRO — interface local */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const S = {
  status: null, presets: [], fonts: [], projects: [], builtin: [],
  cur: null,          // projeto aberto (dados do servidor)
  base: null,         // preset base (json)
  overrides: {},
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
const snap = text => ({ text: text ?? $("#text").value, preset: S.cur?.preset, overrides: structuredClone(S.overrides) });
const sameSnap = (a, b) => a.text === b.text && a.preset === b.preset && JSON.stringify(a.overrides) === JSON.stringify(b.overrides);
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
  S.overrides = structuredClone(s.overrides);
  if (presetChanged) { S.cur.preset = s.preset; S.base = S.presets.find(p => p.name === s.preset) || S.base; }
  clearTimeout(saveTimer);
  $("#text").value = s.text; S.textBefore = s.text; S.dirty = false;
  try { await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { text: s.text, preset: s.preset, reset_overrides: false, overrides: S.overrides } }); }
  catch (e) { return toast(e.message, true); }
  setSave("salvo", "ok");
  renderPresets(); syncControls(); syncEffects();
  if (presetChanged) loadProjects();
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
    { p: "rules.chunk_max_chars", l: "Máximo de letras por legenda curta", t: "range", min: 6, max: 22, step: 1, f: v => `${v} letras` },
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

const pushOverrides = debounce(async () => {
  if (!S.cur) return;
  try {
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { overrides: S.overrides } });
    await refreshPlan();
  } catch (e) { toast(e.message, true); }
}, 120);

const ctlDefault = p => CONTROLS.flatMap(g => g.items).find(c => c.p === p)?.def;
function setOverride(p, v, cp = true) {
  if (cp) checkpoint(`ctl:${p}`);
  if ((getPath(S.base, p) ?? ctlDefault(p)) === v) delPath(S.overrides, p); else setPath(S.overrides, p, v);
  for (const w of $$(`#controls .ctl[data-p="${p}"]`)) w.classList.toggle("changed", getPath(S.overrides, p) !== undefined);
  pushOverrides();
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
  if (S.cur?.preset === p.name) openProject(S.cur.id);   // o projeto volta para o estilo padrão
}

async function applyPreset(p) {
  if (!S.cur || p.name === S.cur.preset) return;
  checkpoint();
  await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { preset: p.name } });
  S.cur.preset = p.name; S.base = p; S.overrides = {};
  S.uploadPreset = p.name; lsSet("lp.uploadPreset", p.name);
  renderPresets(); syncControls(); syncEffects(); loadProjects(); await refreshPlan();
  toast(`Estilo “${p.title || p.name}” aplicado`, false, { label: "Desfazer", fn: undo });
}

function renderPresets() {
  const grid = $("#presetGrid"); grid.innerHTML = "";
  const curName = S.cur?.preset;
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
  if (S.cur) S.base = S.presets.find(p => p.name === S.cur.preset) || S.base;
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
      <div class="proj-meta">${fmtTime(p.duration).slice(0, 5)} · ${st}</div>
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
  $("#tlTrack").innerHTML = ""; $("#tlFlashes").innerHTML = "";
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
  S.base = S.presets.find(x => x.name === p.preset) || S.presets[0];
  S.overrides = p.overrides || {};
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
  $("#tcDur").textContent = fmtTime(p.duration);
  $("#text").value = p.text || ""; S.textBefore = $("#text").value; setSave("");
  const pl = $("#player"); pl.pause(); $("#hits").hidden = false; $("#btnPlay").classList.remove("playing");
  if (p.source) { if (pl.getAttribute("src") !== E(p.source)) pl.src = E(p.source); }
  else pl.removeAttribute("src");
  if (p.source_job && !p.job) watchJob(p.source_job);   // vídeo que o navegador não toca: prepara uma cópia leve
  $("#inspector").classList.toggle("disabled", !p.has_words);
  $("#phoneTip").hidden = !p.has_words || lsGet("lp.tipSeen") === "1";
  syncHistory();
  renderPresets(); syncControls(); syncEffects(); renderExports(); loadProjects();
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
  S.sel = S.sel.filter(i => i < S.plan.words.length);
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
function drawTimeline() {
  const tr = $("#tlTrack"), fl = $("#tlFlashes"); tr.innerHTML = ""; fl.innerHTML = "";
  if (!S.plan) return;
  const D = S.cur.duration;
  for (const sc of S.plan.scenes) {
    const el = document.createElement("div");
    el.className = `tl-scene ${sc.mode}${sc.behind ? " behind" : ""}${sc.behind && S.plan.live?.matte?.need ? " pending" : ""}`;
    el.style.left = `${(sc.t_in / D) * 100}%`;
    el.style.width = `calc(${(Math.max(0.05, sc.t_out - sc.t_in) / D) * 100}% - 1px)`;
    el.innerHTML = `<span>${escapeHtml(sc.text.replace(/ \/ /g, " "))}</span>`;
    sc._el = el; tr.appendChild(el);
  }
  for (const f of S.plan.flashes) {
    const el = document.createElement("div"); el.className = "tl-flash"; el.style.left = `${(f / D) * 100}%`; fl.appendChild(el);
  }
  const emph = S.plan.words.filter(w => w.emph);
  for (const w of emph) {
    const el = document.createElement("div"); el.className = "tl-emph"; el.style.left = `${(w.start / D) * 100}%`; fl.appendChild(el);
  }
  const modes = new Set(S.plan.scenes.map(sc => sc.mode));
  if (S.plan.flashes.length) modes.add("flash");
  if (emph.length) modes.add("emph");
  if (S.plan.scenes.some(sc => sc.behind)) modes.add("behind");
  const leg = LEGEND.filter(([ms]) => ms.some(m => modes.has(m)));
  $("#tlLegend").innerHTML = leg.map(([, cls, l, d]) => `<span title="${d}"><b class="${cls}"></b>${l}</span>`).join("");
  updateHead();
}

function updateHead() {
  if (!S.cur) return;
  const D = S.cur.duration, f = Math.min(1, S.t / D);
  $("#tlHead").style.left = `calc(${f * 100}% - 1px)`;
  $("#scrub").value = f;
  $("#tcNow").textContent = fmtTime(S.t);
  let now = null;
  for (const sc of S.plan?.scenes || []) {
    const on = S.t >= sc.t_in && S.t < sc.t_out;
    sc._el?.classList.toggle("now", on);
    if (on) now = sc;
  }
  $("#sceneNow").innerHTML = now ? `<b>${MODE_NAMES[now.mode] || now.mode}</b>${escapeHtml(now.text)}` : "";
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
async function liveBg() {
  const lv = S.plan?.live, pid = S.cur?.id;
  if (!lv || lv.bg === LV.bg) return;
  LV.bg = lv.bg;
  if (!lv.bg) return paintBg(null);
  try {
    const img = await createImageBitmap(await (await fetch(`${ENGINE}/api/projects/${pid}/live_bg.png?k=${lv.bg}`)).blob());
    if (LV.bg === lv.bg && S.cur?.id === pid) paintBg(img);
  } catch { LV.bg = null; }
}
// plano novo: ajusta as camadas ao tamanho/modo de mistura e solta quadros que não servem mais
function liveSetup() {
  const lv = S.plan?.live; if (!lv) return;
  for (const c of $$("#live canvas")) {
    if (c.width !== lv.w || c.height !== lv.h) { c.width = lv.w; c.height = lv.h; LV.shown = LV.bg = null; }
  }
  liveBg();
  for (const n of ["blend", "back_blend"]) $(`#live canvas[data-l="${n}"]`).style.mixBlendMode = BLEND_CSS[lv.blend] || "normal";
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

function seek(t) {
  if (!S.cur) return;
  S.t = Math.max(0, Math.min(S.cur.duration - 0.01, t));
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
$("#scrub").addEventListener("input", e => seek(+e.target.value * S.cur.duration));
// clique (sem arrastar) numa legenda da linha do tempo seleciona as palavras dela;
// shift+clique seleciona um intervalo de legendas, ctrl+clique soma ou tira legendas
let tlDown = null;
$("#scrub").addEventListener("pointerdown", e => { tlDown = { x: e.clientX, y: e.clientY }; });
$("#scrub").addEventListener("pointerup", e => {
  const d = tlDown; tlDown = null;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || !S.plan) return;
  const r = $("#scrub").getBoundingClientRect(), t = (e.clientX - r.left) / r.width * S.cur.duration;
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
});
$("#btnPrev").addEventListener("click", () => seek(S.t - 1 / (S.cur?.fps || 30)));
$("#btnNext").addEventListener("click", () => seek(S.t + 1 / (S.cur?.fps || 30)));

// tocando: a cada quadro do vídeo, desenha a legenda do mesmo instante
// cada quadro que o vídeo apresenta (tocando ou depois de uma busca): legenda e recorte do MESMO quadro
function onVideoFrame(now, md) {
  LV.vfc = false;
  const pl = $("#player");
  LV.vt = md?.mediaTime ?? pl.currentTime;
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
  if (S.t >= S.cur.duration - 0.1) seek(0);
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
        <li>Na aba <b>Estilo</b>, escolha o visual (passe o mouse para ver animado) e ajuste tamanho, cores e fontes.</li>
        <li>Dê <b>play</b> para ver em movimento e <b>exporte</b> quando estiver pronto.</li>
      </ol>
    </section>
    <section>
      <h4>Atalhos</h4>
      <table>
        <tr><td><kbd>Espaço</kbd></td><td>tocar / pausar</td></tr>
        <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>quadro anterior / próximo</td></tr>
        <tr><td><kbd>Shift</kbd> + <kbd>←</kbd> <kbd>→</kbd></td><td>voltar / avançar 1 segundo</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Z</kbd></td><td>desfazer</td></tr>
        <tr><td><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd></td><td>refazer</td></tr>
        <tr><td><kbd>Esc</kbd></td><td>fechar o menu da palavra</td></tr>
        <tr><td><kbd>Shift</kbd> + clique</td><td>selecionar um trecho</td></tr>
        <tr><td><kbd>Ctrl</kbd> + clique</td><td>somar palavras à seleção</td></tr>
        <tr><td><kbd>?</kbd></td><td>esta ajuda</td></tr>
      </table>
    </section>
  </div>`;
const showHelp = () => ask({ title: "Atalhos e ajuda", html: HELP, ok: "Fechar", cancel: null, wide: true });
$("#btnHelp").addEventListener("click", showHelp);

window.addEventListener("keydown", e => {
  if (!$("#modal").hidden) return;
  if (["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (e.key === "?") { e.preventDefault(); showHelp(); return; }
  if (!S.cur) return;
  if (e.code === "Escape") { clearSel(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.code === "KeyZ" || e.code === "KeyY")) {
    e.preventDefault();
    if (e.code === "KeyY" || e.shiftKey) redo(); else undo();
    return;
  }
  if (e.code === "Space") { e.preventDefault(); if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur(); togglePlay(); }
  if (e.code === "ArrowLeft") { e.preventDefault(); seek(S.t - (e.shiftKey ? 1 : 1 / (S.cur.fps || 30))); }
  if (e.code === "ArrowRight") { e.preventDefault(); seek(S.t + (e.shiftKey ? 1 : 1 / (S.cur.fps || 30))); }
});

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
  const gap = s => s.split(/(\{\/?card\}|\{atras(?::[^}\s]*)?\}|\{\/atras\}|["“”]|\||\n)/).map(x =>
    x === "\n" ? "<br>" : x === "|" ? `<span class="rt-break" title="Quebra de legenda">⏎</span>`
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
    if (S.sel.includes(i)) cls.push("sel");
    let style = "";
    if (p.color) { style = ` style="--wc:${p.color}"`; cls.push("f-color"); if (lum(p.color) < 70) cls.push("f-dark"); }
    out += `<span class="${cls.join(" ")}" data-wi="${i}"${style}>${escapeHtml(p.core + p.tail)}</span>`;
    pos = e;
  }
  out += gap(v.slice(pos));
  box.innerHTML = out;
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
  toast("Legenda movida", false, { label: "Desfazer", fn: undo });
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
      : toks.every(t => t.p.flags.has(m)));
  }
  // trecho atrás da pessoa: tamanho e posição própria (quando a seleção está num trecho só)
  const gs = new Set(S.sel.map(i => S.plan.words[i]?.bg));
  const g = gs.size === 1 ? groupOf(S.sel[0]) : null;
  $("#wpBehind").hidden = !g;
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
  S.overrides = {}; syncControls(); syncEffects();
  await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { overrides: {} } }); refreshPlan();
  toast("Estilo restaurado", false, { label: "Desfazer", fn: undo });
});
$("#btnSavePreset").addEventListener("click", async () => {
  const name = $("#newPresetName").value.trim();   // vazio: o servidor usa o próximo número
  const data = merge(S.base, S.overrides);
  delete data.tagline;
  try {
    const r = await api("/api/presets", { method: "POST", body: { name, description: $("#newPresetDesc").value.trim(), data } });
    checkpoint();
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { preset: r.name } });
    S.cur.preset = r.name; S.overrides = {};
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
$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => x.classList.toggle("active", x === t));
  $$(".pane").forEach(p => p.classList.toggle("active", p.dataset.pane === t.dataset.tab));
}));

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

// Site: acha o motor no PC (portas 7860–7869). O primeiro pedido pode abrir a pergunta do navegador
// sobre "acessar dispositivos da rede local"; enquanto ela estiver aberta, o pedido só espera.
const ENGINE_API = 1;
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
  $("#gateDownload").href = cfg.DOWNLOAD_URL || "/";
  // por enquanto o motor só existe para Windows: no Mac/celular, avisa em vez de oferecer o .exe
  const plat = `${navigator.userAgentData?.platform || navigator.platform || ""} ${navigator.userAgent}`;
  const mobile = /Android|iPhone|iPad|iPod/i.test(plat) || navigator.userAgentData?.mobile;
  const mac = !mobile && /Mac/i.test(plat);
  if (mac && cfg.DOWNLOAD_URL_MAC) {
    // Mac com o motor publicado: baixa o .dmg; o Safari costuma barrar https → http://127.0.0.1
    $("#gateDownload").href = cfg.DOWNLOAD_URL_MAC;
    $("#gateDownload").textContent = "Baixar para Mac";
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
    const mopts = S.status.models.map(m => `<option value="${m}"${m === S.status.default_model ? " selected" : ""}>${MODEL_LABEL[m] || m}</option>`).join("");
    $("#uploadModel").innerHTML = mopts; $("#retransModel").innerHTML = mopts;
    await loadPresets();
    await loadProjects();
    const last = lsGet("lp.last");
    if (last && S.projects.some(p => p.id === last)) openProject(last);
  } catch (e) { toast("Servidor indisponível: " + e.message, true); }
})();
