/* =====================================================================
   LegendaPRO — configuração do site de download
   ---------------------------------------------------------------------
   Troque só estas três linhas quando sair uma versão nova.
   O instalador NÃO fica no Cloudflare Pages (limite de 25 MiB por
   arquivo): ele mora num bucket R2 com domínio público ou no
   GitHub Releases. Veja LEIA-ME.md.
   ===================================================================== */

const DOWNLOAD_URL = "https://downloads.SEU-DOMINIO/LegendaPRO-Setup.exe";
const VERSION = "1.0.0";
const SIZE_MB = 178;

/* Não precisa mexer daqui para baixo. */
window.LEGENDAPRO = Object.freeze({ DOWNLOAD_URL, VERSION, SIZE_MB });
