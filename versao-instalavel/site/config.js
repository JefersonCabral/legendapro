/* =====================================================================
   LegendaPRO — configuração do site de download
   ---------------------------------------------------------------------
   Troque só estas três linhas quando sair uma versão nova.
   O instalador NÃO fica no Cloudflare Pages (limite de 25 MiB por
   arquivo): ele mora num bucket R2 com domínio público ou no
   GitHub Releases. Veja LEIA-ME.md.
   ===================================================================== */

// Instaladores na página de Releases do GitHub. "latest/download" aponta sempre para a versão mais nova
// (a Release é criada sozinha pelo GitHub Actions quando sai uma tag v*).
const RELEASES = "https://github.com/JefersonCabral/legendapro/releases/latest/download";
const DOWNLOAD_URL = RELEASES + "/LegendaPRO-Setup.exe";
const VERSION = "1.0.0";
const SIZE_MB = 178;

/* Mac: os .dmg já vão para a mesma Release. Enquanto o Mac não for testado num Mac de verdade, estes ficam
   vazios e o site mostra "Versão para Mac em breve". Para liberar, troque por:
     RELEASES + "/LegendaPRO-mac-arm64.dmg"   e   RELEASES + "/LegendaPRO-mac-x86_64.dmg" */
const DOWNLOAD_URL_MAC = "";        // Mac com chip Apple (M1…M4)
const DOWNLOAD_URL_MAC_INTEL = "";  // Mac Intel

/* Não precisa mexer daqui para baixo. */
window.LEGENDAPRO = Object.freeze({ DOWNLOAD_URL, VERSION, SIZE_MB, DOWNLOAD_URL_MAC, DOWNLOAD_URL_MAC_INTEL });
