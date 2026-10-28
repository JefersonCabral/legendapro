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
  previewKey: null,
  previewUrl: null,
  jobs: {},           // id -> job
  sel: [],            // palavras selecionadas no preview (índices de plan.words)
  anchor: null,       // início da seleção com shift
  hits: [],           // caixas das palavras visíveis no quadro atual
  dirty: false,       // texto editado e ainda não salvo
  undo: [],           // versões anteriores do texto (Ctrl+Z)
};

/* ------------------------------------------------------------ utilidades */
const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof Blob) ? { "Content-Type": "application/json" } : undefined,
    body: opts.body && !(opts.body instanceof Blob) ? JSON.stringify(opts.body) : opts.body,
  });
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
let toastT;
const toast = (msg, err = false) => {
  const el = $("#toast"); el.textContent = msg; el.classList.toggle("err", err); el.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 3200);
};

/* ------------------------------------------------------------ controles de estilo */
const pct = v => `${Math.round(v * 100)}%`;
const CONTROLS = [
  { g: "Posição e tamanho", open: true, items: [
    { p: "layout.offset_x", l: "Mover para os lados", t: "range", min: -.45, max: .45, step: .005, def: 0, always: true,
      f: v => Math.abs(v) < .001 ? "centro" : v < 0 ? `← ${Math.round(-v * 100)}% esquerda` : `direita ${Math.round(v * 100)}% →` },
    { p: "layout.offset_y", l: "Mover para cima / baixo", t: "range", min: -.8, max: .8, step: .005, def: 0, always: true,
      f: v => Math.abs(v) < .001 ? "posição do estilo" : v < 0 ? `↑ ${Math.round(-v * 100)}% acima` : `↓ ${Math.round(v * 100)}% abaixo` },
    { p: "_offset_reset", t: "button", l: "Voltar a legenda para a posição do estilo", always: true,
      hint: "Ou arraste a legenda direto no vídeo: clique numa palavra e arraste. Vale para todas as legendas.",
      act: () => { setOverride("layout.offset_x", 0); setOverride("layout.offset_y", 0); syncControls(); } },
    { p: "layout.anchor_y", l: "Altura na tela", t: "range", min: .05, max: .95, step: .005, f: pct },
    { p: "layout.base_size", l: "Tamanho do texto", t: "range", min: .045, max: .11, step: .001, f: v => `${(v * 100).toFixed(1)}% da largura` },
    { p: "layout.hero_scale", l: "Tamanho do destaque", t: "range", min: 1, max: 4, step: .05, f: v => `${v.toFixed(2)}×` },
    { p: "layout.serif_scale", l: "Tamanho da ênfase", t: "range", min: 1, max: 2.6, step: .05, f: v => `${v.toFixed(2)}×` },
    { p: "layout.solo_scale", l: "Palavra solo", t: "range", min: 1, max: 2.2, step: .05, f: v => `${v.toFixed(2)}×` },
    { p: "layout.small_scale", l: "Palavras de apoio (a sua, o seu)", t: "range", min: .55, max: 1, step: .01, f: v => `${v.toFixed(2)}×` },
    { p: "layout.line_gap", l: "Entrelinha", t: "range", min: -.1, max: .4, step: .01, f: v => v.toFixed(2) },
    { p: "layout.zigzag", l: "Zigue-zague das linhas", t: "range", min: 0, max: 1.2, step: .05, f: v => v.toFixed(2) },
    { p: "layout.grow", l: "A pilha cresce", t: "select", o: [["center", "do centro (o bloco sobe)"], ["down", "para baixo"]] },
  ]},
  { g: "Cores", items: [
    { p: "colors.text", l: "Texto", t: "color" },
    { p: "colors.hero", l: "Palavra de destaque", t: "color" },
    { p: "colors.red", l: "Destaque vermelho", t: "color" },
    { p: "colors.accent", l: "Elipse", t: "color" },
  ]},
  { g: "Mistura com o vídeo (blend mode)", items: [
    { p: "effects.blend.enabled", l: "Texto mistura com o vídeo", t: "switch", always: true },
    { p: "effects.blend.mode", l: "Modo de mistura", t: "select", always: true, def: "difference", o: [
      ["difference", "Diferença (difference)"], ["normal", "Normal"], ["screen", "Clarear (screen)"], ["overlay", "Sobrepor (overlay)"], ["soft_light", "Luz suave (soft light)"],
      ["hard_light", "Luz direta (hard light)"], ["color_dodge", "Subexposição de cor (color dodge)"], ["add", "Adição (linear dodge)"],
      ["lighten", "Clarear cor (lighten)"], ["multiply", "Multiplicar"], ["darken", "Escurecer"],
      ["exclusion", "Exclusão"], ["divide", "Dividir (divide)"]] },
    { p: "effects.blend.opacity", l: "Intensidade da mistura", t: "range", min: .1, max: 1, step: .01, def: 1, always: true, f: pct },
  ]},
  { g: "Gradiente atrás da legenda", items: [
    { p: "effects.gradient.enabled", l: "Escurecer a parte de baixo do vídeo", t: "switch", always: true },
    { p: "effects.gradient.opacity", l: "Intensidade", t: "range", min: .1, max: 1, step: .01, f: pct },
    { p: "effects.gradient.top", l: "Começa em (altura)", t: "range", min: .2, max: .9, step: .01, f: pct },
    { p: "effects.gradient.full", l: "Escuro total em (altura)", t: "range", min: .4, max: 1, step: .01, f: pct },
    { p: "effects.gradient.color", l: "Cor", t: "color" },
  ]},
  { g: "Fontes", items: [
    { p: "fonts.sans.file", l: "Sans (texto corrido)", t: "font" },
    { p: "layout.tracking_add", l: "Espaço entre letras (todo o texto)", t: "range", min: -.08, max: .15, step: .005, def: 0, always: true,
      f: v => Math.abs(v) < .001 ? "como no estilo" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}% mais ${v > 0 ? "solto" : "justo"}` },
    { p: "layout.word_space", l: "Espaço entre palavras (todo o texto)", t: "range", min: .3, max: 2.5, step: .05, def: 1, always: true,
      f: v => Math.abs(v - 1) < .001 ? "como no estilo" : `${v.toFixed(2)}×` },
    { p: "fonts.sans_i.file", l: "Sans itálica (abertura / caixa)", t: "font" },
    { p: "fonts.hero.file", l: "Palavra de destaque", t: "font" },
    { p: "fonts.serif.file", l: "Ênfase (serifada / itálica)", t: "font" },
    { p: "fonts.serif.weight", l: "Peso da ênfase", t: "range", min: 400, max: 900, step: 50, f: v => String(v) },
  ]},
  { g: "Animação", items: [
    { p: "effects.blur_in.duration", l: "Duração da entrada com blur", t: "range", min: .08, max: .6, step: .01, f: v => `${v.toFixed(2)}s` },
    { p: "effects.blur_in.max_blur", l: "Intensidade do blur", t: "range", min: 0, max: .04, step: .001, f: v => (v * 1000).toFixed(0) },
    { p: "effects.pop.scale_from", l: "Força do pop", t: "range", min: 1, max: 1.4, step: .01, f: v => `${v.toFixed(2)}×` },
    { p: "effects.drift", l: "Deriva lenta", t: "range", min: 0, max: .02, step: .001, f: v => (v * 1000).toFixed(0) },
    { p: "effects.rays.enabled", l: "Raios de luz no destaque", t: "switch" },
    { p: "effects.flicker", l: "Vermelho piscando", t: "switch" },
    { p: "effects.red_glow", l: "Brilho no vermelho", t: "switch" },
    { p: "effects.flash.enabled", l: "Flash de luz entre blocos", t: "switch" },
    { p: "effects.blur_out.overlap", l: "Saída sobrepõe a próxima cena", t: "switch" },
    { p: "effects.rolling_window", l: "Pilha rolante (sem ênfase)", t: "select", o: [[0, "desligada"], [2, "2 linhas"], [3, "3 linhas"]] },
  ]},
  { g: "Decisões automáticas", items: [
    { p: "rules.emphasis_every", l: "Uma ênfase a cada", t: "range", min: 1.5, max: 10, step: .1, f: v => `${v.toFixed(1)}s` },
    { p: "rules.emphasis_gap", l: "Distância mínima entre ênfases", t: "range", min: .3, max: 5, step: .1, f: v => `${v.toFixed(1)}s` },
    { p: "rules.stack_plain_probability", l: "Pilhas sem ênfase", t: "range", min: 0, max: 1, step: .05, f: pct },
    { p: "rules.solo.enabled", l: "Palavras solo em falas pausadas", t: "switch" },
    { p: "rules.solo.probability", l: "Chance de solo", t: "range", min: 0, max: 1, step: .05, f: pct },
    { p: "rules.ellipse.probability", l: "Elipse no fim de frase", t: "range", min: 0, max: 1, step: .05, f: pct },
    { p: "rules.underline.probability", l: "Sublinhado no fim de pilha", t: "range", min: 0, max: 1, step: .05, f: pct },
    { p: "rules.box_negation", l: "Caixa vermelha no “Não”", t: "switch" },
    { p: "rules.sans_italic_lead", l: "Itálico na abertura (Essa é, você)", t: "switch" },
    { p: "rules.cards.enabled", l: "Cards de citação", t: "switch" },
    { p: "rules.cards.auto_repetition", l: "Card automático em repetições", t: "switch" },
    { p: "rules.chunk_max_chars", l: "Máx. de letras por chunk", t: "range", min: 6, max: 22, step: 1, f: v => String(v) },
  ]},
];

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
          <input type="range" min="${c.min}" max="${c.max}" step="${c.step}">`;
        const inp = $("input", w);
        inp.addEventListener("input", () => { paintRange(inp); $("output", w).textContent = c.f(+inp.value); setOverride(c.p, +inp.value); });
        // duplo clique volta ao valor padrão do controle
        if (c.def !== undefined) inp.addEventListener("dblclick", () => { setOverride(c.p, c.def); syncControls(); });
      } else if (c.t === "button") {
        w.innerHTML = `<button class="btn btn-sm btn-block">${c.l}</button>${c.hint ? `<p class="hint">${c.hint}</p>` : ""}`;
        $("button", w).addEventListener("click", c.act);
      } else if (c.t === "switch") {
        w.innerHTML = `<label class="switch"><span>${c.l}</span><input type="checkbox"></label>`;
        $("input", w).addEventListener("change", e => setOverride(c.p, e.target.checked));
      } else if (c.t === "color") {
        w.innerHTML = `<div class="ctl-top"><span>${c.l}</span></div><div class="ctl-color"><input type="color"><code></code></div>`;
        $("input", w).addEventListener("input", e => { $("code", w).textContent = e.target.value.toUpperCase(); setOverride(c.p, e.target.value.toUpperCase()); });
      } else {
        const opts = c.t === "font" ? S.fonts.map(f => [f, f.replace(/\.(ttf|otf)$/i, "")]) : c.o;
        w.innerHTML = `<div class="ctl-top"><span>${c.l}</span></div><select>${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>`;
        $("select", w).addEventListener("change", e => {
          const v = e.target.value; setOverride(c.p, c.o && typeof c.o[0][0] === "number" ? +v : v);
        });
      }
      w._c = c;
      body.appendChild(w);
    }
    root.appendChild(d);
  }
}
const paintRange = inp => inp.style.setProperty("--p", `${((inp.value - inp.min) / (inp.max - inp.min)) * 100}%`);

function syncControls() {
  if (!S.base) return;
  const st = merge(S.base, S.overrides);
  for (const w of $$("#controls .ctl")) {
    const c = w._c; const v = getPath(st, c.p);
    w.classList.toggle("changed", getPath(S.overrides, c.p) !== undefined);
    w.style.display = v === undefined && !c.always ? "none" : "";
    if (c.t === "button") continue;
    if (c.t === "range") { const i = $("input", w); i.value = v ?? c.def ?? c.min; paintRange(i); $("output", w).textContent = c.f(+i.value); }
    else if (c.t === "switch") $("input", w).checked = !!v;
    else if (c.t === "color") { $("input", w).value = (v || "#ffffff").toLowerCase(); $("code", w).textContent = (v || "").toUpperCase(); }
    else $("select", w).value = String(v ?? c.def);
  }
  for (const d of $$("#controls details.group")) d.hidden = !$$(".ctl", d).some(w => w.style.display !== "none");
}

const pushOverrides = debounce(async () => {
  if (!S.cur) return;
  try {
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { overrides: S.overrides } });
    await refreshPlan();
  } catch (e) { toast(e.message, true); }
}, 300);

const ctlDefault = p => CONTROLS.flatMap(g => g.items).find(c => c.p === p)?.def;
function setOverride(p, v) {
  if ((getPath(S.base, p) ?? ctlDefault(p)) === v) delPath(S.overrides, p); else setPath(S.overrides, p, v);
  const w = $(`#controls .ctl[data-p="${p}"]`); if (w) w.classList.toggle("changed", getPath(S.overrides, p) !== undefined);
  pushOverrides();
}

/* ------------------------------------------------------------ presets */
function renderPresets() {
  const grid = $("#presetGrid"); grid.innerHTML = "";
  const curName = S.cur?.preset;
  for (const p of S.presets) {
    const b = document.createElement("button"); b.className = "preset" + (p.name === curName ? " active" : "");
    b.title = p.description || p.name;
    b.innerHTML = `<img loading="lazy" alt="" src="/api/presets/${encodeURIComponent(p.name)}/thumb.jpg?v=${p._v || 0}">
      <span class="preset-name">${escapeHtml(p.title || p.name)}</span>
      ${S.builtin.includes(p.name) ? "" : `<span class="preset-del" title="Apagar preset">×</span>`}`;
    b.addEventListener("click", async e => {
      if (e.target.classList.contains("preset-del")) {
        e.stopPropagation();
        if (!confirm(`Apagar o preset “${p.title || p.name}”?`)) return;
        await api(`/api/presets/${p.name}`, { method: "DELETE" }); await loadPresets(); return;
      }
      if (!S.cur) return;
      await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { preset: p.name } });
      S.cur.preset = p.name; S.base = p; S.overrides = {};
      renderPresets(); syncControls(); syncEffects(); loadProjects(); await refreshPlan();
      toast(`Estilo “${p.title || p.name}” aplicado`);
    });
    grid.appendChild(b);
  }
  const cur = S.presets.find(p => p.name === curName);
  let d = $("#presetDesc");
  if (!d) { d = document.createElement("p"); d.id = "presetDesc"; d.className = "preset-desc"; grid.after(d); }
  d.textContent = cur?.description || "";
}

async function loadPresets() {
  const r = await api("/api/presets");
  S.presets = r.presets.map(p => ({ ...p, _v: Date.now() })); S.fonts = r.fonts; S.builtin = r.builtin || [];
  $("#newPresetName").placeholder = r.next_title || "Preset novo";
  const opts = S.presets.map(p => `<option value="${p.name}">${escapeHtml(p.title || p.name)}</option>`).join("");
  $("#uploadPreset").innerHTML = opts;
  if (S.cur) S.base = S.presets.find(p => p.name === S.cur.preset) || S.base;
  buildControls(); syncControls(); renderPresets();
}

/* ------------------------------------------------------------ projetos */
async function loadProjects() {
  const r = await api("/api/projects"); S.projects = r.projects;
  const list = $("#projectList"); list.innerHTML = "";
  for (const p of S.projects) {
    const el = document.createElement("div"); el.className = "proj" + (S.cur?.id === p.id ? " active" : ""); el.tabIndex = 0; el.title = `${p.name} · ${p.width}×${p.height}`;
    const st = { novo: "na fila", transcrito: "pronto" }[p.status] || p.status;
    el.innerHTML = `<img src="/api/projects/${p.id}/thumb.jpg" alt="">
      <div><div class="proj-name"></div><div class="proj-meta">${fmtTime(p.duration).slice(0, 5)} · ${st}</div><div class="proj-meta">${escapeHtml(S.presets.find(x => x.name === p.preset)?.title || p.preset)}</div></div>
      <button class="proj-del" title="Apagar projeto">×</button>`;
    $(".proj-name", el).textContent = p.name;
    el.addEventListener("click", e => {
      if (e.target.classList.contains("proj-del")) return deleteProject(p);
      openProject(p.id);
    });
    list.appendChild(el);
  }
}

async function deleteProject(p) {
  if (!confirm(`Apagar o projeto “${p.name}” e os vídeos dele?`)) return;
  try { await api(`/api/projects/${p.id}`, { method: "DELETE" }); } catch (e) { return toast(e.message, true); }
  if (S.cur?.id === p.id) closeProject();
  loadProjects();
}

function closeProject() {
  S.cur = null; S.plan = null; S.previewKey = null; previewJob = null; wantPlay = false;
  clearSel(); S.hits = []; drawHits();
  $("#viewer").hidden = true; $("#drop").hidden = false; $("#projectTitleWrap").hidden = true;
  $("#inspector").classList.add("disabled");
  $("#player").pause(); $("#player").removeAttribute("src");
  localStorage.removeItem("lp.last");
}

async function openProject(id) {
  const p = await api(`/api/projects/${id}`);
  S.cur = p; S.t = 0; S.plan = null; previewJob = null; wantPlay = false;
  S.previewKey = p.preview?.key || null;
  S.previewUrl = p.preview ? `/files/${p.id}/${p.preview.file}` : null;
  S.undo = []; S.dirty = false; S.hits = []; clearSel();
  S.base = S.presets.find(x => x.name === p.preset) || S.presets[0];
  S.overrides = p.overrides || {};
  try { localStorage.setItem("lp.last", id); } catch {}
  $("#drop").hidden = true; $("#viewer").hidden = false;
  $("#projectTitleWrap").hidden = false; $("#projectTitle").value = p.name;
  $("#phone").style.aspectRatio = `${p.width} / ${p.height}`;
  $("#tcDur").textContent = fmtTime(p.duration);
  $("#text").value = p.text || ""; setSave("");
  const pl = $("#player"); pl.pause(); pl.removeAttribute("src"); pl.hidden = true; $("#frame").hidden = false;
  $("#inspector").classList.toggle("disabled", !p.has_words);
  renderPresets(); syncControls(); syncEffects(); renderExports(); loadProjects();
  if (p.job && p.job.status === "running") watchJob(p.job);
  if (p.has_words) await refreshPlan(); else { $("#tlTrack").innerHTML = ""; requestFrame(); }
  updatePreviewState();
}

$("#projectTitle").addEventListener("change", async e => {
  if (!S.cur) return;
  await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { name: e.target.value } });
  loadProjects();
});

/* ------------------------------------------------------------ upload */
function upload(file) {
  if (!file) return;
  const model = $("#uploadModel").value, preset = $("#uploadPreset").value;
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/upload?model=${encodeURIComponent(model)}&preset=${encodeURIComponent(preset)}`);
  xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
  $("#drop").hidden = true; $("#viewer").hidden = false; $("#frame").removeAttribute("src");
  showBusy("Enviando o vídeo…", file.name, 0);
  xhr.upload.onprogress = e => e.lengthComputable && showBusy("Enviando o vídeo…", file.name, e.loaded / e.total);
  xhr.onload = async () => {
    let r = {}; try { r = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status !== 200) { hideBusy(); toast(r.error || "Falha no envio", true); closeProject(); return; }
    await openProject(r.project.id);
    watchJob(r.job);
  };
  xhr.onerror = () => { hideBusy(); toast("Falha no envio", true); };
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
  } else if (j.kind === "preview") {
    return; // acompanhado por pollPreview
  } else {
    if (!mine) return;
    $("#expProg").hidden = j.status !== "running";
    $("#btnExport").disabled = j.status === "running";
    $("#expBar").style.width = `${Math.round(j.progress * 100)}%`;
    $("#expMsg").textContent = j.message || "";
    $("#btnCancel").onclick = () => api(`/api/jobs/${j.id}/cancel`, { method: "POST" });
    if (j.status === "done") {
      toast("Exportação concluída");
      const p = await api(`/api/projects/${S.cur.id}`); S.cur.exports = p.exports; renderExports(j.result.file);
    } else if (j.status === "error") toast(`Erro ao renderizar: ${j.error}`, true);
    else if (j.status === "cancelled") toast("Renderização cancelada");
  }
}

/* ------------------------------------------------------------ plano + timeline */
async function refreshPlan() {
  if (!S.cur) return;
  try { S.plan = await api(`/api/projects/${S.cur.id}/plan`); }
  catch (e) { toast(e.message, true); return; }
  S.sel = S.sel.filter(i => i < S.plan.words.length);
  drawTimeline(); requestFrame(); updatePreviewState(); renderPop();
  if (autoMode && S.plan.key !== S.previewKey) autoPreview();
}

function drawTimeline() {
  const tr = $("#tlTrack"), fl = $("#tlFlashes"); tr.innerHTML = ""; fl.innerHTML = "";
  if (!S.plan) return;
  const D = S.cur.duration;
  for (const sc of S.plan.scenes) {
    const el = document.createElement("div");
    el.className = `tl-scene ${sc.mode}`;
    el.style.left = `${(sc.t_in / D) * 100}%`;
    el.style.width = `calc(${(Math.max(0.05, sc.t_out - sc.t_in) / D) * 100}% - 1px)`;
    el.title = `${sc.mode.toUpperCase()} · ${sc.text}`;
    sc._el = el; tr.appendChild(el);
  }
  for (const f of S.plan.flashes) {
    const el = document.createElement("div"); el.className = "tl-flash"; el.style.left = `${(f / D) * 100}%`; fl.appendChild(el);
  }
  const modes = new Set(S.plan.scenes.map(sc => sc.mode));
  const leg = LEGEND.filter(([ms]) => ms.some(m => modes.has(m)) || (ms[0] === "flash" && S.plan.flashes.length));
  $("#tlLegend").innerHTML = leg.map(([, cls, l, d]) => `<span title="${d}"><b class="${cls}"></b>${l}</span>`).join("");
  updateHead();
}

const LEGEND = [
  [["chunk", "plain"], "m-chunk", "Bloco", "poucas palavras por vez, troca seca"],
  [["stack"], "m-stack", "Pilha", "frase em linhas com palavra em evidência"],
  [["hero"], "m-stack", "Destaque", "palavra grande em evidência com a frase em volta"],
  [["block"], "m-stack", "Frase empilhada", "a frase vai se acumulando em linhas"],
  [["fill"], "m-stack", "Caixa", "linhas que preenchem a largura da caixa"],
  [["solo"], "m-solo", "Solo", "palavra grande com pop"],
  [["card"], "m-card", "Card", "fundo chapado"],
  [["flash"], "m-flash", "Flash", "clarão entre frases"],
];
function updateHead() {
  if (!S.cur) return;
  const D = S.cur.duration, f = Math.min(1, S.t / D);
  $("#tlHead").style.left = `calc(${f * 100}% - 1px)`;
  $("#scrub").value = f;
  $("#tcNow").textContent = fmtTime(S.t);
  const names = { chunk: "chunk", stack: "pilha", solo: "solo", card: "card", plain: "bloco", hero: "destaque", block: "frase empilhada", fill: "caixa" };
  let now = null;
  for (const sc of S.plan?.scenes || []) {
    const on = S.t >= sc.t_in && S.t < sc.t_out;
    sc._el?.classList.toggle("now", on);
    if (on) now = sc;
  }
  $("#sceneNow").innerHTML = now ? `<b>${names[now.mode]}</b>${escapeHtml(now.text)}${now.decos.length ? " · " + now.decos.join(", ") : ""}` : "";
}
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ------------------------------------------------------------ prévia de quadro */
let frameBusy = false, framePending = false;
function requestFrame() {
  if (!S.cur) return;
  if (frameBusy) { framePending = true; return; }
  frameBusy = true; $("#frameLoading").classList.add("on");
  const img = new Image();
  const done = () => {
    frameBusy = false; $("#frameLoading").classList.remove("on");
    if (framePending) { framePending = false; requestFrame(); }
  };
  const t = S.t;
  img.onload = () => { $("#frame").src = img.src; done(); fetchHits(t); };
  img.onerror = done;
  img.src = `/api/projects/${S.cur.id}/frame.jpg?t=${t.toFixed(3)}&k=${S.plan?.key || "0"}&h=1280`;
}

async function fetchHits(t) {
  if (!S.cur?.has_words || !S.plan) { S.hits = []; return drawHits(); }
  try {
    const r = await api(`/api/projects/${S.cur.id}/hits?t=${t.toFixed(3)}`);
    if (Math.abs(t - S.t) > 1e-4) return; // já mudou de quadro
    S.hits = r.hits;
  } catch { S.hits = []; }
  drawHits();
}

function seek(t) {
  if (!S.cur) return;
  S.t = Math.max(0, Math.min(S.cur.duration - 0.01, t));
  const pl = $("#player");
  if (!pl.hidden) { pl.pause(); showStill(); }
  updateHead(); requestFrame();
}
$("#scrub").addEventListener("input", e => seek(+e.target.value * S.cur.duration));
$("#btnPrev").addEventListener("click", () => seek(S.t - 1 / (S.cur?.fps || 30)));
$("#btnNext").addEventListener("click", () => seek(S.t + 1 / (S.cur?.fps || 30)));

/* ------------------------------------------------------------ prévia em movimento
   O quadro parado mostra cada alteração na hora. O vídeo da prévia (720p) só é refeito quando
   você pede (Atualizar prévia / play) — ou depois de cada alteração, se "Automática" estiver
   ligada. Uma prévia nova nunca troca o vídeo que está tocando. */
let previewJob = null;   // {id, key, progress} da prévia sendo gerada
let wantPlay = false;    // tocar assim que a prévia ficar pronta
let autoMode = false;
try { autoMode = localStorage.getItem("lp.autoPreview") === "1"; } catch {}
const previewFresh = () => !!(S.previewKey && S.plan && S.previewKey === S.plan.key && S.previewUrl);

function updatePreviewState() {
  const el = $("#previewState");
  $("#btnPlay").classList.toggle("loading", !!previewJob && wantPlay);
  el.classList.remove("stale", "busy");
  const has = !!S.cur?.has_words;
  $("#btnRefresh").hidden = !has || previewFresh() || !!previewJob || autoMode;
  if (!has) { el.textContent = ""; return; }
  if (previewFresh()) el.textContent = "prévia em dia";
  else if (previewJob) { el.textContent = `gerando prévia ${Math.round((previewJob.progress || 0) * 100)}%`; el.classList.add("busy"); }
  else if (autoMode) { el.textContent = "prévia vai se atualizar…"; el.classList.add("stale"); }
  else { el.textContent = S.previewUrl ? "prévia desatualizada" : "sem prévia ainda"; el.classList.add("stale"); }
  $("#btnPlay").title = previewFresh() || !has ? "Tocar a prévia (espaço)" : "Gerar a prévia com as alterações e tocar (espaço)";
}

async function startPreview() {
  if (!S.cur?.has_words || !S.plan || previewFresh()) return;
  if (previewJob && previewJob.key === S.plan.key) return;
  const pid = S.cur.id, key = S.plan.key;
  if (previewJob) { api(`/api/jobs/${previewJob.id}/cancel`, { method: "POST" }).catch(() => {}); previewJob = null; }
  let j;
  try { j = await api(`/api/projects/${pid}/render`, { method: "POST", body: { kind: "preview" } }); }
  catch (e) { toast(e.message, true); return; }
  if (S.cur?.id !== pid) return;
  previewJob = { id: j.id, key, progress: 0 };
  updatePreviewState();
  const tick = async () => {
    if (previewJob?.id !== j.id) return; // substituída por uma mais nova
    let n; try { n = await api(`/api/jobs/${j.id}`); } catch { return; }
    if (previewJob?.id !== j.id) return;
    if (n.status === "running") { previewJob.progress = n.progress; updatePreviewState(); setTimeout(tick, 350); return; }
    previewJob = null;
    if (n.status === "done") {
      S.previewKey = n.result.key; S.previewUrl = n.result.url;
      if (wantPlay) { wantPlay = false; playPreview(); }
      else if (autoMode && !previewFresh()) autoPreview(); // mudou de novo enquanto renderizava
    } else if (n.status === "error") { wantPlay = false; toast(`Erro na prévia: ${n.error}`, true); }
    updatePreviewState();
  };
  setTimeout(tick, 250);
}
const autoPreview = debounce(startPreview, 1200);

$("#btnRefresh").addEventListener("click", async () => { if (S.dirty) await saveNow(); startPreview(); });
$("#autoPreview").checked = autoMode;
$("#autoPreview").addEventListener("change", e => {
  autoMode = e.target.checked;
  try { localStorage.setItem("lp.autoPreview", autoMode ? "1" : "0"); } catch {}
  if (autoMode && !previewFresh()) startPreview();
  updatePreviewState();
});
function showStill() { $("#player").hidden = true; $("#frame").hidden = false; $("#hits").hidden = false; $("#btnPlay").classList.remove("playing"); requestFrame(); }
async function playPreview() {
  const pl = $("#player");
  if (pl.getAttribute("src") !== S.previewUrl) pl.src = S.previewUrl;
  pl.hidden = false; $("#frame").hidden = true; $("#hits").hidden = true; clearSel();
  const start = S.t >= S.cur.duration - 0.1 ? 0 : S.t;
  const go = () => { pl.currentTime = start; pl.play(); $("#btnPlay").classList.add("playing"); };
  if (pl.readyState >= 1) go(); else pl.addEventListener("loadedmetadata", go, { once: true });
}
async function togglePlay() {
  if (!S.cur?.has_words) return;
  const pl = $("#player");
  if (!pl.hidden && !pl.paused) { pl.pause(); return; }
  if (wantPlay) { wantPlay = false; updatePreviewState(); return; }
  if (S.dirty) await saveNow();
  if (previewFresh()) return playPreview();
  wantPlay = true; startPreview(); updatePreviewState();
}
$("#btnPlay").addEventListener("click", togglePlay);
$("#player").addEventListener("timeupdate", e => { S.t = e.target.currentTime; updateHead(); });
$("#player").addEventListener("pause", e => {
  if (e.target.hidden) return;
  // pausou: volta para o quadro parado, onde dá para clicar nas palavras
  S.t = e.target.currentTime; showStill(); updateHead(); renderPop();
});
$("#player").addEventListener("ended", () => { S.t = 0; showStill(); updateHead(); });
$("#player").addEventListener("click", () => $("#player").pause());

window.addEventListener("keydown", e => {
  if (["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (!S.cur) return;
  if (e.code === "Escape") { clearSel(); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); undoText(); return; }
  if (e.code === "Space") { e.preventDefault(); if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur(); togglePlay(); }
  if (e.code === "KeyR" && !e.ctrlKey && !e.metaKey && !previewFresh() && !previewJob) startPreview();
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
  // guarda a versão de antes de cada rajada de digitação para o Ctrl+Z global
  if (lastTyped === null) pushUndo(S.textBefore ?? $("#text").value);
  clearTimeout(lastTyped); lastTyped = setTimeout(() => { lastTyped = null; S.textBefore = $("#text").value; }, 1500);
  queueSave();
});
$("#text").addEventListener("focus", () => { S.textBefore = $("#text").value; });

/* marcações de uma palavra: mesmo formato que transcript.parse_markup lê */
const TOKEN_RX = /\{\/?card\}|["“”]|(?:(?!\{\/?card\})[^\s"“”])+/g;
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
function pushUndo(v) { if (S.undo.at(-1) !== v) { S.undo.push(v); if (S.undo.length > 60) S.undo.shift(); } }
function setText(v, undoable = true) {
  const ta = $("#text");
  if (v === ta.value) return;
  if (undoable) pushUndo(ta.value);
  ta.value = v; S.textBefore = v;
  S.dirty = true; setSave("salvando…", "dirty");
  return saveNow();
}
function undoText() {
  const v = S.undo.pop();
  if (v === undefined) return toast("Nada para desfazer");
  setText(v, false); toast("Desfeito");
}
// liga/desliga um efeito: se todas já têm, tira de todas; senão põe em todas
function toggleFlag(toks, mark) {
  const all = toks.every(t => t.p.flags.has(mark));
  for (const t of toks) {
    if (all) t.p.flags.delete(mark); else t.p.flags.add(mark);
    if (mark === "solo" && !all) t.p.flags.delete("break");
  }
}

$$("#marks button").forEach(btn => btn.addEventListener("click", () => {
  const ta = $("#text"); const mark = btn.dataset.mark;
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  if (mark === "break") {
    pushUndo(v); ta.setRangeText(" | ", s, s, "end");
  } else if (mark === "card") {
    if (s === e) return toast("Selecione o trecho que vira card");
    pushUndo(v); ta.setRangeText(`"${v.slice(s, e).replace(/"/g, "")}"`, s, e, "select");
  } else {
    const toks = textTokens(v, s, e);
    if (!toks.length) return toast("Selecione uma ou mais palavras");
    toggleFlag(toks, mark);
    applyTextTokens(toks);
    return;
  }
  ta.focus(); queueSave(0);
}));
$("#markColor").addEventListener("change", e => {
  const ta = $("#text");
  const toks = textTokens(ta.value, ta.selectionStart, ta.selectionEnd);
  if (!toks.length) return toast("Selecione uma ou mais palavras");
  for (const t of toks) t.p.color = e.target.value.toUpperCase();
  applyTextTokens(toks);
});
// palavras do textarea que tocam a seleção [s,e)
function textTokens(v, s, e) {
  const out = [];
  for (const m of v.matchAll(TOKEN_RX)) {
    const a = m.index, b = a + m[0].length;
    if (s === e ? (s < a || s > b) : (a >= e || b <= s)) continue;
    if (m[0] === "|" || /^(\{\/?card\}|["“”])$/.test(m[0])) continue;
    const p = parseTok(m[0]);
    if (p.core) out.push({ s: a, e: b, p });
  }
  return out;
}
function applyTextTokens(toks) {
  const ta = $("#text");
  const v = spliceText(ta.value, toks.map(t => [t.s, t.e, buildTok(t.p)]));
  const a = toks[0].s, delta = v.length - ta.value.length;
  setText(v);
  ta.focus(); ta.setSelectionRange(a, toks.at(-1).e + delta);
}

// clicar numa palavra do texto leva o vídeo até ela
$("#text").addEventListener("click", () => {
  const ta = $("#text");
  if (S.dirty || !S.plan || ta.selectionStart !== ta.selectionEnd) return;
  const c = ta.selectionStart;
  const i = S.plan.words.findIndex(w => w.span && w.span[0] <= c && c <= w.span[1]);
  if (i < 0) return;
  S.sel = [i]; S.anchor = i;
  seek(S.plan.words[i].start + 0.03);
});

/* ------------------------------------------------------------ edição direto no preview */
function drawHits() {
  const box = $("#hits"); box.innerHTML = "";
  box.style.transform = ""; box.classList.remove("dragging");
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
// arrastar uma palavra move a legenda inteira (layout.offset_x / offset_y); clique sem arrastar seleciona
let drag = null, dragMoved = false;
const curOffset = p => getPath(merge(S.base, S.overrides), p) ?? 0;
$("#hits").addEventListener("pointerdown", e => {
  dragMoved = false;   // depois de um arrastar o navegador nem sempre dispara "click": zera a cada toque
  if (e.button !== 0 || !e.target.closest(".hit")) return;
  drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId,
           ox: curOffset("layout.offset_x"), oy: curOffset("layout.offset_y") };
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
  box.style.transform = `translate(${dx}px, ${dy}px)`;
  drag.nx = Math.max(-.45, Math.min(.45, Math.round((drag.ox + dx / r.width) * 200) / 200));
  drag.ny = Math.max(-.8, Math.min(.8, Math.round((drag.oy + dy / r.height) * 200) / 200));
  if (Math.abs(drag.nx) < .015) drag.nx = 0;   // gruda no centro
  $("#dragTip").hidden = false;
  $("#dragTip").textContent = `${drag.nx === 0 ? "centro" : `${drag.nx > 0 ? "→" : "←"} ${Math.round(Math.abs(drag.nx) * 100)}%`} · ${drag.ny === 0 ? "altura do estilo" : `${drag.ny > 0 ? "↓" : "↑"} ${Math.round(Math.abs(drag.ny) * 100)}%`}`;
});
$("#hits").addEventListener("pointercancel", () => { drag = null; $("#dragTip").hidden = true; drawHits(); });
$("#hits").addEventListener("pointerup", () => {
  if (!drag) return;
  const d = drag; drag = null; $("#dragTip").hidden = true;
  if (!d.moved) return;
  dragMoved = true;
  setOverride("layout.offset_x", d.nx); setOverride("layout.offset_y", d.ny); syncControls();
});
$("#hits").addEventListener("click", e => {
  if (dragMoved) { dragMoved = false; return; }
  const h = e.target.closest(".hit");
  if (!h) return clearSel();
  const wi = +h.dataset.wi;
  if (e.shiftKey && S.anchor != null) {
    const [a, b] = [Math.min(S.anchor, wi), Math.max(S.anchor, wi)];
    S.sel = Array.from({ length: b - a + 1 }, (_, k) => a + k);
  } else if (e.ctrlKey || e.metaKey) {
    S.sel = S.sel.includes(wi) ? S.sel.filter(x => x !== wi) : [...S.sel, wi].sort((x, y) => x - y);
    S.anchor = wi;
  } else { S.sel = [wi]; S.anchor = wi; }
  drawHits();
  const w = S.plan.words[S.sel[0]];
  if (w?.span && !S.dirty) $("#text").setSelectionRange(w.span[0], S.plan.words[S.sel.at(-1)].span[1]);
  if (S.sel.length) setTimeout(() => { const i = $("#wpText"); i.focus(); i.select(); }, 0);
});
function clearSel() {
  S.sel = []; S.anchor = null;
  $$("#hits .hit.sel").forEach(el => el.classList.remove("sel"));
  $("#wordPop").hidden = true; shiftPhone(0);
}

const selToks = () => {
  const v = $("#text").value;
  return S.sel.map(i => S.plan.words[i]).filter(w => w?.span)
    .map(w => ({ s: w.span[0], e: w.span[1], p: parseTok(v.slice(w.span[0], w.span[1])) }));
};
const SWATCHES = () => [
  [null, "Padrão do estilo"], [S.base?.colors?.text, "Texto"], [S.base?.colors?.red, "Destaque"],
  [S.base?.colors?.accent, "Elipse"], ["#FFFFFF", "Branco"], ["#FFD60A", "Amarelo"], ["#FF8A00", "Laranja"],
  ["#E3241D", "Vermelho"], ["#49DC7B", "Verde"], ["#3DA5FF", "Azul"], ["#B86CFF", "Roxo"], ["#111111", "Preto"],
].filter(([c], k, a) => k === 0 || (c && a.findIndex(([x]) => x?.toUpperCase() === c.toUpperCase()) === k));

/* efeitos disponíveis e o que cada um faz no estilo atual (preset.effect_notes) */
const EFFECT_KEY = { emph: "destaque", destaque: "destaque" };
const PHRASE_ONLY_HIDE = ["solo", "card"];   // não existem nos estilos do motor "frase"
function syncEffects() {
  const st = S.base ? merge(S.base, S.overrides) : {};
  const notes = st.effect_notes || {};
  const phrase = (st.rules || {}).engine === "phrase";
  for (const b of $$("#wpMarks button, #marks button")) {
    const m = b.dataset.mark;
    b.hidden = phrase && PHRASE_ONLY_HIDE.includes(m);
    const n = notes[EFFECT_KEY[m] || m];
    if (n) b.title = `${b.textContent.trim()}: ${n}`;
  }
  if (notes.color) $(".mark-color").title = `Cor: ${notes.color}`;
  // ícone de cada efeito = prévia renderizada pelo próprio preset (como vai sair no vídeo)
  const pname = st.name, ver = S.base?._v || 0;
  for (const b of $$("#wpMarks button, #marks button")) {
    const m = b.dataset.mark === "emph" ? "destaque" : b.dataset.mark;
    if (!["destaque", "red", "circle", "underline", "box", "solo"].includes(m) || !pname) continue;
    let img = $("img.fx-ico", b);
    if (!img) {
      img = document.createElement("img"); img.className = "fx-ico"; img.alt = "";
      img.onerror = () => { img.hidden = true; if (b.firstElementChild !== img) b.firstElementChild.hidden = false; };
      b.prepend(img);
    }
    const src = `/api/presets/${encodeURIComponent(pname)}/fx/${m}.png?v=${ver}`;
    if (img.getAttribute("src") !== src) { img.hidden = false; img.src = src; }
    const old = img.nextElementSibling;
    if (old && old.tagName !== "IMG" && old !== b.lastChild) old.hidden = true;   // esconde o "Aa" genérico
  }
  $("#wpNote").innerHTML = notes.destaque ? `<b>Destaque neste estilo:</b> ${escapeHtml(notes.destaque)}` : "";
}

function renderPop() {
  const pop = $("#wordPop");
  const pl = $("#player");
  if (!S.sel.length || !S.plan || (!pl.hidden && !pl.paused)) { pop.hidden = true; shiftPhone(0); return; }
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
      : m === "destaque" ? S.sel.every(i => S.plan.words[i]?.emph) : toks.every(t => t.p.flags.has(m)));
  }
  const cur = toks.every(t => t.p.color === toks[0].p.color) ? toks[0].p.color : undefined;
  const sw = $("#wpColors");
  sw.innerHTML = SWATCHES().map(([c, n]) => c
    ? `<button class="sw${cur === c.toUpperCase() ? " on" : ""}" data-c="${c.toUpperCase()}" title="${n} ${c.toUpperCase()}" style="--c:${c}"></button>`
    : `<button class="sw sw-none${cur === null ? " on" : ""}" data-c="" title="${n}"></button>`).join("") +
    `<label class="sw sw-pick" title="Outra cor"><input type="color" value="${(cur || "#ffd60a").toLowerCase()}"></label>`;
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
      const on = S.sel.every(i => S.plan.words[i]?.emph);
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
    const contiguous = S.sel.every((x, k) => k === 0 || x === S.sel[k - 1] + 1);
    if (!contiguous) { toast("Para mudar a quantidade de palavras, selecione um trecho seguido (shift+clique)", true); return; }
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
  if (!confirm("Transcrever de novo substitui o texto atual. Continuar?")) return;
  const j = await api(`/api/projects/${S.cur.id}/transcribe`, { method: "POST", body: { model: $("#retransModel").value } });
  $("#inspector").classList.add("disabled"); watchJob(j);
});

/* ------------------------------------------------------------ salvar preset */
$("#btnResetStyle").addEventListener("click", async () => {
  if (!S.cur) return;
  S.overrides = {}; syncControls(); syncEffects();
  await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { overrides: {} } }); refreshPlan();
});
$("#btnSavePreset").addEventListener("click", async () => {
  const name = $("#newPresetName").value.trim();   // vazio: o servidor usa o próximo número
  const data = merge(S.base, S.overrides);
  try {
    const r = await api("/api/presets", { method: "POST", body: { name, description: $("#newPresetDesc").value.trim(), data } });
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { preset: r.name } });
    S.cur.preset = r.name; S.overrides = {};
    await loadPresets(); refreshPlan();
    $("#newPresetName").value = ""; $("#newPresetDesc").value = "";
    toast(`“${name || $("#newPresetName").placeholder}” salvo`);
  } catch (e) { toast(e.message, true); }
});

/* ------------------------------------------------------------ exportar */
function renderExports(highlight) {
  const box = $("#exports"); box.innerHTML = "";
  for (const f of S.cur?.exports || []) {
    const url = `/files/${S.cur.id}/${f}?v=${Date.now()}`;
    const el = document.createElement("div"); el.className = "export-item";
    const isMp4 = f.endsWith(".mp4");
    el.innerHTML = `${isMp4 ? `<video src="${url}" controls preload="metadata"></video>` : ""}
      <div class="row"><b>${isMp4 ? "Vídeo legendado" : "Legenda transparente (MOV)"}</b>
      <a href="/files/${S.cur.id}/${f}?download=1">Baixar</a></div>`;
    if (f === highlight) el.style.borderColor = "var(--red)";
    box.appendChild(el);
  }
}
$("#btnExport").addEventListener("click", async () => {
  if (!S.cur) return;
  const kind = $("input[name=fmt]:checked").value;
  const j = await api(`/api/projects/${S.cur.id}/render`, {
    method: "POST", body: { kind, resolution: $("#expRes").value, quality: $("#expQ").value },
  });
  watchJob(j);
});

/* ------------------------------------------------------------ abas */
$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => x.classList.toggle("active", x === t));
  $$(".pane").forEach(p => p.classList.toggle("active", p.dataset.pane === t.dataset.tab));
}));

/* ------------------------------------------------------------ início */
(async function init() {
  $("#inspector").classList.add("disabled");
  try {
    S.status = await api("/api/status");
    $("#chipGpu").classList.toggle("on", S.status.gpu); $("#chipGpu").title = S.status.gpu ? "Transcrição na GPU (CUDA)" : "Transcrição na CPU";
    $("#chipEnc").classList.toggle("on", S.status.nvenc); $("#chipEnc").title = S.status.nvenc ? "Encode de vídeo na GPU" : "Encode na CPU (x264)";
    const mopts = S.status.models.map(m => `<option value="${m}"${m === S.status.default_model ? " selected" : ""}>${m}${m === "large-v3-turbo" ? " (recomendado)" : ""}</option>`).join("");
    $("#uploadModel").innerHTML = mopts; $("#retransModel").innerHTML = mopts;
    await loadPresets();
    await loadProjects();
    let last = null; try { last = localStorage.getItem("lp.last"); } catch {}
    if (last && S.projects.some(p => p.id === last)) openProject(last);
  } catch (e) { toast("Servidor indisponível: " + e.message, true); }
})();
