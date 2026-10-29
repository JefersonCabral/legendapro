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

  // Sistema de quem visita: por enquanto o motor só existe para Windows
  var plat = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "") + " " + navigator.userAgent;
  var mobile = /Android|iPhone|iPad|iPod/i.test(plat) || (navigator.userAgentData && navigator.userAgentData.mobile);
  var mac = !mobile && /Mac/i.test(plat);

  var macUrl = typeof cfg.DOWNLOAD_URL_MAC === "string" ? cfg.DOWNLOAD_URL_MAC : "";
  var macIntelUrl = typeof cfg.DOWNLOAD_URL_MAC_INTEL === "string" ? cfg.DOWNLOAD_URL_MAC_INTEL : "";

  // Links de download
  document.querySelectorAll("[data-download]").forEach(function (a) {
    if (mac && macUrl) {
      // o navegador não diz com certeza se o Mac é chip Apple ou Intel: o botão é do chip Apple (a maioria)
      // e o link do Intel aparece logo abaixo
      a.setAttribute("href", macUrl);
      a.setAttribute("download", macUrl.split("/").pop().split("?")[0]);
      var lb = a.querySelector("span") || a;
      lb.textContent = "Baixar para Mac (chip Apple)";
      if (macIntelUrl && !a.classList.contains("btn-small")) {
        var alt = document.createElement("a");
        alt.className = "mac-alt";
        alt.href = macIntelUrl;
        alt.textContent = "Mac com processador Intel? Baixe esta versão";
        a.insertAdjacentElement("afterend", alt);
      }
      return;
    }
    if (mac || mobile) {
      a.setAttribute("href", "#perguntas");
      a.removeAttribute("download");
      a.classList.add("is-soon");
      var label = a.querySelector("span") || a;
      label.textContent = mac ? "Versão para Mac em breve" : "Disponível para computador Windows";
      return;
    }
    if (url) a.setAttribute("href", url);
    var file = url.split("/").pop().split("?")[0];
    if (file) a.setAttribute("download", file);
  });

  // Versão e tamanho
  document.querySelectorAll("[data-version]").forEach(function (el) {
    el.textContent = version ? "v" + version : "";
  });
  document.querySelectorAll("[data-size]").forEach(function (el) {
    el.textContent = fmtSize(size);
  });

  if (/SEU-DOMINIO/i.test(url)) {
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
