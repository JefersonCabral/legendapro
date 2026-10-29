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

/* Mac: os .dmg saem do GitHub Actions (aba Actions ou Releases do repositório). Enquanto estiverem
   vazios, o site mostra "Versão para Mac em breve". */
const DOWNLOAD_URL_MAC = "";        // Mac com chip Apple (M1…M4): LegendaPRO-mac-arm64.dmg
const DOWNLOAD_URL_MAC_INTEL = "";  // Mac Intel: LegendaPRO-mac-x86_64.dmg

/* Não precisa mexer daqui para baixo. */
window.LEGENDAPRO = Object.freeze({ DOWNLOAD_URL, VERSION, SIZE_MB, DOWNLOAD_URL_MAC, DOWNLOAD_URL_MAC_INTEL });
