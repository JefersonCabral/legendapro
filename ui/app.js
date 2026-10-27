"use strict";
/* LegendaPRO — interface local */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const S = {
  status: null, presets: [], fonts: [], projects: [],
  cur: null,          // projeto aberto (dados do servidor)
  base: null,         // preset base (json)
  overrides: {},
  plan: null,
  t: 0,
  previewKey: null,
  previewUrl: null,
  jobs: {},           // id -> job
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
    { p: "layout.anchor_y", l: "Altura na tela", t: "range", min: .25, max: .88, step: .005, f: pct },
    { p: "layout.base_size", l: "Tamanho do texto", t: "range", min: .045, max: .11, step: .001, f: v => `${(v * 100).toFixed(1)}% da largura` },
    { p: "layout.serif_scale", l: "Tamanho da ênfase", t: "range", min: 1, max: 2.6, step: .05, f: v => `${v.toFixed(2)}×` },
    { p: "layout.solo_scale", l: "Palavra solo", t: "range", min: 1, max: 2.2, step: .05, f: v => `${v.toFixed(2)}×` },
    { p: "layout.small_scale", l: "Palavras de apoio (a sua, o seu)", t: "range", min: .55, max: 1, step: .01, f: v => `${v.toFixed(2)}×` },
    { p: "layout.line_gap", l: "Entrelinha", t: "range", min: -.1, max: .4, step: .01, f: v => v.toFixed(2) },
    { p: "layout.zigzag", l: "Zigue-zague das linhas", t: "range", min: 0, max: 1.2, step: .05, f: v => v.toFixed(2) },
    { p: "layout.grow", l: "A pilha cresce", t: "select", o: [["center", "do centro (o bloco sobe)"], ["down", "para baixo"]] },
  ]},
  { g: "Cores", items: [
    { p: "colors.text", l: "Texto", t: "color" },
    { p: "colors.red", l: "Destaque vermelho", t: "color" },
    { p: "colors.accent", l: "Elipse", t: "color" },
  ]},
  { g: "Fontes", items: [
    { p: "fonts.sans.file", l: "Sans (texto corrido)", t: "font" },
    { p: "fonts.sans.tracking", l: "Espaçamento da sans", t: "range", min: -.08, max: .05, step: .005, f: v => v.toFixed(3) },
    { p: "fonts.sans_i.file", l: "Sans itálica (abertura / caixa)", t: "font" },
    { p: "fonts.serif.file", l: "Serifada (ênfase)", t: "font" },
    { p: "fonts.serif.weight", l: "Peso da serifada", t: "range", min: 400, max: 900, step: 50, f: v => String(v) },
  ]},
  { g: "Animação", items: [
    { p: "effects.blur_in.duration", l: "Duração da entrada com blur", t: "range", min: .08, max: .6, step: .01, f: v => `${v.toFixed(2)}s` },
    { p: "effects.blur_in.max_blur", l: "Intensidade do blur", t: "range", min: 0, max: .04, step: .001, f: v => (v * 1000).toFixed(0) },
    { p: "effects.pop.scale_from", l: "Força do pop", t: "range", min: 1, max: 1.4, step: .01, f: v => `${v.toFixed(2)}×` },
    { p: "effects.drift", l: "Deriva lenta", t: "range", min: 0, max: .02, step: .001, f: v => (v * 1000).toFixed(0) },
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
    w.style.display = v === undefined && c.t !== "switch" ? "none" : "";
    if (c.t === "range") { const i = $("input", w); i.value = v ?? c.min; paintRange(i); $("output", w).textContent = c.f(+i.value); }
    else if (c.t === "switch") $("input", w).checked = !!v;
    else if (c.t === "color") { $("input", w).value = (v || "#ffffff").toLowerCase(); $("code", w).textContent = (v || "").toUpperCase(); }
    else $("select", w).value = String(v);
  }
}

const pushOverrides = debounce(async () => {
  if (!S.cur) return;
  try {
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { overrides: S.overrides } });
    await refreshPlan();
  } catch (e) { toast(e.message, true); }
}, 300);

function setOverride(p, v) {
  if (getPath(S.base, p) === v) delPath(S.overrides, p); else setPath(S.overrides, p, v);
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
      <span class="preset-name">${p.name}</span>
      ${["galho", "desculpa"].includes(p.name) ? "" : `<span class="preset-del" title="Apagar preset">×</span>`}`;
    b.addEventListener("click", async e => {
      if (e.target.classList.contains("preset-del")) {
        e.stopPropagation();
        if (!confirm(`Apagar o preset “${p.name}”?`)) return;
        await api(`/api/presets/${p.name}`, { method: "DELETE" }); await loadPresets(); return;
      }
      if (!S.cur) return;
      await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { preset: p.name } });
      S.cur.preset = p.name; S.base = p; S.overrides = {};
      renderPresets(); syncControls(); await refreshPlan();
      toast(`Estilo “${p.name}” aplicado`);
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
  S.presets = r.presets.map(p => ({ ...p, _v: Date.now() })); S.fonts = r.fonts;
  const opts = S.presets.map(p => `<option value="${p.name}">${p.name}</option>`).join("");
  $("#uploadPreset").innerHTML = opts;
  if (S.cur) S.base = S.presets.find(p => p.name === S.cur.preset) || S.base;
  buildControls(); syncControls(); renderPresets();
}

/* ------------------------------------------------------------ projetos */
async function loadProjects() {
  const r = await api("/api/projects"); S.projects = r.projects;
  const list = $("#projectList"); list.innerHTML = "";
  for (const p of S.projects) {
    const el = document.createElement("div"); el.className = "proj" + (S.cur?.id === p.id ? " active" : ""); el.tabIndex = 0;
    const st = { novo: "na fila", transcrito: "pronto" }[p.status] || p.status;
    el.innerHTML = `<img src="/api/projects/${p.id}/thumb.jpg" alt="">
      <div><div class="proj-name"></div><div class="proj-meta">${fmtTime(p.duration).slice(0, 5)} · ${p.width}×${p.height}<br>${p.preset} · ${st}</div></div>
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
  await api(`/api/projects/${p.id}`, { method: "DELETE" });
  if (S.cur?.id === p.id) closeProject();
  loadProjects();
}

function closeProject() {
  S.cur = null; S.plan = null; S.previewKey = null;
  $("#viewer").hidden = true; $("#drop").hidden = false; $("#projectTitleWrap").hidden = true;
  $("#inspector").classList.add("disabled");
  $("#player").pause(); $("#player").removeAttribute("src");
  localStorage.removeItem("lp.last");
}

async function openProject(id) {
  const p = await api(`/api/projects/${id}`);
  S.cur = p; S.t = 0; S.plan = null; S.previewKey = null;
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
  renderPresets(); syncControls(); renderExports(); loadProjects();
  if (p.job && p.job.status === "running") watchJob(p.job);
  if (p.has_words) await refreshPlan(); else { $("#tlTrack").innerHTML = ""; requestFrame(); }
  if (p.has_preview) { S.previewUrl = `/files/${p.id}/preview.mp4?v=${Date.now()}`; }
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
    if (!mine) return;
    const btn = $("#btnPlay");
    if (j.status === "running") { btn.classList.add("loading"); $("#previewState").textContent = `gerando prévia ${Math.round(j.progress * 100)}%`; }
    else {
      btn.classList.remove("loading");
      if (j.status === "done") {
        S.previewKey = j._key; S.previewUrl = j.result.url; updatePreviewState();
        if (j._autoplay) playPreview();
      } else if (j.status === "error") toast(j.error, true);
      updatePreviewState();
    }
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
  drawTimeline(); requestFrame(); updatePreviewState();
}

function drawTimeline() {
  const tr = $("#tlTrack"), fl = $("#tlFlashes"); tr.innerHTML = ""; fl.innerHTML = "";
  if (!S.plan) return;
  const D = S.cur.duration;
  for (const sc of S.plan.scenes) {
    const el = document.createElement("div");
    el.className = `tl-scene ${sc.mode}` + (sc.mode === "stack" && !/\S/.test(sc.text) ? "" : "");
    el.style.left = `${(sc.t_in / D) * 100}%`;
    el.style.width = `calc(${(Math.max(0.05, sc.t_out - sc.t_in) / D) * 100}% - 1px)`;
    el.title = `${sc.mode.toUpperCase()} · ${sc.text}`;
    sc._el = el; tr.appendChild(el);
  }
  for (const f of S.plan.flashes) {
    const el = document.createElement("div"); el.className = "tl-flash"; el.style.left = `${(f / D) * 100}%`; fl.appendChild(el);
  }
  updateHead();
}

function updateHead() {
  if (!S.cur) return;
  const D = S.cur.duration, f = Math.min(1, S.t / D);
  $("#tlHead").style.left = `calc(${f * 100}% - 1px)`;
  $("#scrub").value = f;
  $("#tcNow").textContent = fmtTime(S.t);
  const names = { chunk: "chunk", stack: "pilha", solo: "solo", card: "card" };
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
  img.onload = () => { $("#frame").src = img.src; done(); };
  img.onerror = done;
  img.src = `/api/projects/${S.cur.id}/frame.jpg?t=${S.t.toFixed(3)}&k=${S.plan?.key || "0"}&h=1280`;
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

/* ------------------------------------------------------------ prévia em movimento */
function updatePreviewState() {
  const el = $("#previewState");
  if (!S.cur?.has_words) { el.textContent = ""; return; }
  if (S.previewKey && S.plan && S.previewKey === S.plan.key) { el.textContent = "prévia em dia"; el.classList.remove("stale"); }
  else if (S.previewUrl) { el.textContent = "prévia desatualizada · ▶ gera de novo"; el.classList.add("stale"); }
  else { el.textContent = "▶ gera a prévia em movimento"; el.classList.remove("stale"); }
}
function showStill() { $("#player").hidden = true; $("#frame").hidden = false; $("#btnPlay").classList.remove("playing"); requestFrame(); }
async function playPreview() {
  const pl = $("#player");
  if (pl.getAttribute("src") !== S.previewUrl) pl.src = S.previewUrl;
  pl.hidden = false; $("#frame").hidden = true;
  const start = S.t >= S.cur.duration - 0.1 ? 0 : S.t;
  const go = () => { pl.currentTime = start; pl.play(); $("#btnPlay").classList.add("playing"); };
  if (pl.readyState >= 1) go(); else pl.addEventListener("loadedmetadata", go, { once: true });
}
async function togglePlay() {
  if (!S.cur?.has_words) return;
  const pl = $("#player");
  if (!pl.hidden && !pl.paused) { pl.pause(); return; }
  if (S.previewKey && S.plan && S.previewKey === S.plan.key && S.previewUrl) return playPreview();
  const key = S.plan?.key;
  const j = await api(`/api/projects/${S.cur.id}/render`, { method: "POST", body: { kind: "preview" } });
  j._key = key; j._autoplay = true;
  watchJobWith(j, key);
}
function watchJobWith(j, key) {
  S.jobs[j.id] = j;
  const tick = async () => {
    let n; try { n = await api(`/api/jobs/${j.id}`); } catch { return; }
    n._key = key; n._autoplay = true; onJob(n);
    if (n.status === "running") setTimeout(tick, 350);
  };
  onJob(j); setTimeout(tick, 250);
}
$("#btnPlay").addEventListener("click", togglePlay);
$("#player").addEventListener("timeupdate", e => { S.t = e.target.currentTime; updateHead(); });
$("#player").addEventListener("pause", () => { $("#btnPlay").classList.remove("playing"); });
$("#player").addEventListener("ended", () => { S.t = 0; showStill(); updateHead(); });
$("#player").addEventListener("click", () => $("#player").pause());

window.addEventListener("keydown", e => {
  if (["TEXTAREA", "INPUT", "SELECT"].includes(document.activeElement?.tagName)) return;
  if (!S.cur) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.code === "ArrowLeft") { e.preventDefault(); seek(S.t - (e.shiftKey ? 1 : 1 / (S.cur.fps || 30))); }
  if (e.code === "ArrowRight") { e.preventDefault(); seek(S.t + (e.shiftKey ? 1 : 1 / (S.cur.fps || 30))); }
});

/* ------------------------------------------------------------ texto */
const setSave = (txt, cls = "") => { const el = $("#saveState"); el.textContent = txt; el.className = "save-state " + cls; };
const saveText = debounce(async () => {
  if (!S.cur) return;
  try {
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { text: $("#text").value } });
    setSave("salvo", "ok"); await refreshPlan();
  } catch (e) { setSave("erro ao salvar", "dirty"); toast(e.message, true); }
}, 650);
$("#text").addEventListener("input", () => { setSave("editando…", "dirty"); saveText(); });

const WRAP = {
  emph: ["*", "*"], red: ["!", "!"], circle: ["((", "))"], underline: ["_", "_"], box: ["[", "]"], solo: ["~", ""],
};
function wrapWord(w, mark) {
  const m = w.match(/^(.*?)([.,!?;:…]*)$/); let core = m[1]; const tail = m[2];
  if (!core) return w;
  const [a, b] = WRAP[mark];
  if (core.startsWith(a) && core.endsWith(b) && core.length > a.length + b.length - 1) return core.slice(a.length, core.length - b.length || undefined) + tail;
  return a + core + b + tail;
}
$$("#marks button").forEach(btn => btn.addEventListener("click", () => {
  const ta = $("#text"); const mark = btn.dataset.mark;
  let { selectionStart: s, selectionEnd: e, value: v } = ta;
  if (mark === "break") {
    ta.setRangeText(" | ", s, s, "end");
  } else if (mark === "card") {
    if (s === e) return toast("Selecione o trecho que vira card");
    ta.setRangeText(`"${v.slice(s, e).replace(/"/g, "")}"`, s, e, "select");
  } else {
    // expande a seleção até palavras inteiras
    while (s > 0 && !/\s/.test(v[s - 1])) s--;
    while (e > s && /\s/.test(v[e - 1])) e--;
    while (e < v.length && !/\s/.test(v[e])) e++;
    if (s === e) return toast("Selecione uma ou mais palavras");
    const out = v.slice(s, e).split(/(\s+)/).map(t => (/\S/.test(t) ? wrapWord(t, mark) : t)).join("");
    ta.setRangeText(out, s, e, "select");
  }
  ta.focus(); setSave("editando…", "dirty"); saveText();
}));

$("#btnRetrans").addEventListener("click", async () => {
  if (!S.cur) return;
  if (!confirm("Transcrever de novo substitui o texto atual. Continuar?")) return;
  const j = await api(`/api/projects/${S.cur.id}/transcribe`, { method: "POST", body: { model: $("#retransModel").value } });
  $("#inspector").classList.add("disabled"); watchJob(j);
});

/* ------------------------------------------------------------ salvar preset */
$("#btnResetStyle").addEventListener("click", async () => {
  S.overrides = {}; syncControls();
  await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { overrides: {} } }); refreshPlan();
});
$("#btnSavePreset").addEventListener("click", async () => {
  const name = $("#newPresetName").value.trim();
  if (!name) return toast("Dê um nome para o preset", true);
  const data = merge(S.base, S.overrides);
  try {
    const r = await api("/api/presets", { method: "POST", body: { name, description: $("#newPresetDesc").value.trim(), data } });
    await api(`/api/projects/${S.cur.id}`, { method: "PUT", body: { preset: r.name } });
    S.cur.preset = r.name; S.overrides = {};
    await loadPresets(); refreshPlan();
    $("#newPresetName").value = ""; $("#newPresetDesc").value = "";
    toast(`Preset “${r.name}” salvo`);
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
