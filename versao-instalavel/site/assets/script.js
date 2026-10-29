/* LegendaPRO — site de download. Lê window.LEGENDAPRO (config.js). */
(function () {
  "use strict";

  var cfg = window.LEGENDAPRO || {};
  var url = typeof cfg.DOWNLOAD_URL === "string" ? cfg.DOWNLOAD_URL : "";
  var version = cfg.VERSION ? String(cfg.VERSION) : "";
  var size = Number(cfg.SIZE_MB);

  function fmtSize(mb) {
    if (!isFinite(mb) || mb <= 0) return "";
    if (mb >= 1024) return (mb / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " GB";
    return Math.round(mb).toLocaleString("pt-BR") + " MB";
  }

  // Os dois downloads (Windows e Mac) aparecem sempre; o do sistema de quem visita fica em destaque
  var plat = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "") + " " + navigator.userAgent;
  var mobile = /Android|iPhone|iPad|iPod/i.test(plat) || (navigator.userAgentData && navigator.userAgentData.mobile);
  var mac = !mobile && /Mac/i.test(plat);
  var links = {
    win: url,
    mac: typeof cfg.DOWNLOAD_URL_MAC === "string" ? cfg.DOWNLOAD_URL_MAC : "",
    "mac-intel": typeof cfg.DOWNLOAD_URL_MAC_INTEL === "string" ? cfg.DOWNLOAD_URL_MAC_INTEL : ""
  };

  document.querySelectorAll("[data-download]").forEach(function (a) {
    var kind = a.getAttribute("data-download") || "win";
    var href = links[kind];
    if (!href) {                      // link vazio no config.js: esse sistema ainda não tem versão
      if (kind === "mac-intel") { a.hidden = true; return; }
      a.setAttribute("href", "#perguntas");
      a.removeAttribute("download");
      a.classList.add("is-soon");
      (a.querySelector("span") || a).textContent = kind === "mac" ? "Mac: em breve" : "Windows: em breve";
      return;
    }
    a.setAttribute("href", href);
    var file = href.split("/").pop().split("?")[0];
    if (file) a.setAttribute("download", file);
    if (kind === "win" && fmtSize(size)) a.title = "Instalador para Windows · " + fmtSize(size);
  });

  // destaque no botão do sistema de quem está acessando (no Mac, o de Mac vira o principal e vem primeiro)
  if (mac && links.mac) {
    document.querySelectorAll(".dl-group").forEach(function (g) {
      var w = g.querySelector('[data-download="win"]'), m = g.querySelector('[data-download="mac"]');
      if (!w || !m) return;
      w.classList.remove("btn-primary");
      m.classList.add("btn-primary");
      g.insertBefore(m, w);
    });
  }

  // Versão e tamanho
  document.querySelectorAll("[data-version]").forEach(function (el) {
    el.textContent = version ? "v" + version : "";
  });
  document.querySelectorAll("[data-size]").forEach(function (el) {
    el.textContent = fmtSize(size);
  });

  if (/SEU-DOMINIO/i.test(url) || !url) {
    console.warn("[LegendaPRO] DOWNLOAD_URL ainda é o placeholder. Edite config.js antes de publicar.");
  }

  // Ano no rodapé
  var y = document.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());

  // Legenda animada do hero: troca as frases em ciclo (para se o usuário pede menos movimento)
  var demo = document.getElementById("demoCaption");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (demo && !reduce) {
    var lines = [
      ["a sua", "legenda", "agora tem ritmo"],
      ["cada palavra", "no tempo", "da sua fala"],
      ["destaque", "automático", "sem esforço"],
      ["tudo", "no seu PC", "sem nuvem"]
    ];
    var i = 0;
    var parts = demo.querySelectorAll("[data-part]");
    setInterval(function () {
      i = (i + 1) % lines.length;
      demo.classList.remove("play");
      void demo.offsetWidth; // reinicia a animação
      parts.forEach(function (p, k) { p.textContent = lines[i][k]; });
      demo.classList.add("play");
    }, 3200);
  }
})();
