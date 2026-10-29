# LegendaPRO — versão para distribuir (site + motor no PC)

A pessoa abre o **site** (Cloudflare Pages) e usa o LegendaPRO no navegador. Quem transcreve, desenha e exporta
é o **motor** instalado no PC dela: a página conversa com ele em `http://127.0.0.1:7860–7869`. Os vídeos vão do
navegador direto para o motor, no mesmo computador, e **nunca passam pelo site**. A mesma interface também abre
direto do motor (atalho do programa), sem internet.

O projeto original (`D:\LegendaPRO\legendapro`, `ui`, `presets`…) não foi alterado. Esta pasta tem uma cópia
adaptada.

| Pasta | O que é |
|---|---|
| `app/` | o motor (cópia adaptada do original) e a interface (`app/ui`) |
| `build/` | monta o motor para Windows: Python embutido, dependências, ffmpeg, instalador e zip (ver `build/LEIA-ME.md`) |
| `build/mac/` | monta o motor para Mac (`.app` + `.dmg`), rodado no GitHub Actions (ver `build/mac/LEIA-ME.md`) |
| `build/ci_smoke.py` | teste de ponta a ponta do motor empacotado, no Windows ou no Mac. Com `LEGENDAPRO_FORCE_CPU=1`, simula um PC sem placa de vídeo |
| `site/` | site estático para o Cloudflare Pages: página de download em `/` e o app em `/app/` (ver `site/LEIA-ME.md`) |
| `dist/` | gerado pelo build (fora do git): `LegendaPRO-Setup.exe` (~178 MB) e o zip portátil (~251 MB) |

## Como as peças se falam

```
navegador ── https://<seu-site>/app/ ──► Cloudflare Pages (só HTML/JS/CSS/fontes)
    │
    └── http://127.0.0.1:7860 (fetch, <video>, <img>) ──► motor no PC (Python + ffmpeg + GPU)
                                                            dados em %LOCALAPPDATA%\LegendaPRO
```

- **Descoberta:** no site, `app.js` procura o motor nas portas 7860–7869 (`/api/status` com `engine: "legendapro"`).
  Se não achar, mostra a tela "Abra o LegendaPRO no seu computador", com os botões **Abrir o motor**
  (`legendapro://abrir`, registrado pelo instalador) e **Baixar**, e segue sozinha quando o motor responde. Se o
  motor for fechado no meio do uso, a tela volta e a página recarrega quando ele reabrir.
- **Segurança do motor:**
  - só aceita `Host` 127.0.0.1/localhost, o que barra o "DNS rebinding";
  - recusa pedidos com `Origin` de outro site;
  - CORS liberado só para a interface local e para os sites configurados.
- **Sites configurados:** ficam em `app/legendapro/__init__.py` (`SITE_ORIGINS`, hoje `https://legendapro.pages.dev`
  e as prévias `*.legendapro.pages.dev`). Também valem a variável `LEGENDAPRO_ORIGINS` e o arquivo `origens.txt` na
  pasta de dados. **Ao escolher o domínio definitivo, coloque-o em `SITE_ORIGINS` e gere o instalador de novo.**
- **Permissão do navegador:** Chrome e Edge novos perguntam uma vez se o site pode "acessar dispositivos da rede
  local". A pessoa precisa clicar em Permitir. O motor responde o preflight com `Access-Control-Allow-Private-Network`.
- **Versões:** `/api/status` devolve `version` e `api`. Se o motor for mais velho que o site (`api` menor que o
  esperado), a interface avisa para baixar a versão nova.
- **Mac e celular:** o site detecta e mostra "Versão para Mac em breve" ou "roda num computador" em vez do `.exe`.

## Onde fica cada coisa no PC da pessoa

- **Programa:** `%LOCALAPPDATA%\Programs\LegendaPRO`, instalado por usuário, sem pedir administrador.
- **Dados:** `%LOCALAPPDATA%\LegendaPRO`. O desinstalador não apaga essa pasta. Dentro dela:
  - `projects\`;
  - `presets\`: os de fábrica são instalados e atualizados por um manifesto (`.fabrica.json`). Preset apagado não
    volta, e preset editado ou salvo pela pessoa nunca é sobrescrito;
  - `models\`: Whisper e recorte, baixados na primeira vez;
  - `fonts\`: fontes extras;
  - `cuda\`: aceleração NVIDIA.
- **Outra pasta de dados:** `LEGENDAPRO_DATA=<pasta>`. Modo portátil: o arquivo `portatil.txt` ao lado de
  `app\legendapro` manda os dados para `app\dados`.
- **Fontes:** todas as fontes dos 11 estilos e da interface vêm dentro do programa (`app\fonts`). O motor nunca usa
  as fontes do Windows. Se um estilo pedir uma fonte que não existe, ele procura em `dados\fonts` e, se não achar,
  usa a Poppins em vez de dar erro.

## Hardware: o que é usado em cada etapa

| Etapa | NVIDIA | AMD | Intel | Sem placa |
|---|---|---|---|---|
| Transcrição (Whisper) | GPU (CUDA, `int8_float16`) | processador | processador | processador (`int8`, todos os núcleos) |
| Recorte da pessoa (RVM) | DirectML | DirectML | DirectML | processador |
| Exportação | `h264_nvenc` | `h264_amf` | `h264_qsv` | `libx264` |
| Desenho da legenda | processador (numpy/OpenCV, em paralelo) | igual | igual | igual |

- **Encoder:** escolhido por `gpu.best_encoder()`. Ele testa de verdade, com os mesmos argumentos da exportação e
  da prévia, só os encoders das marcas que o Windows lista; se a lista falhar, testa todos. Se a placa falhar no
  meio de uma exportação, ela é refeita no `libx264` e o processador vira o padrão na sessão (`EncoderFailed`).
- **Aceleração NVIDIA:** as DLLs CUDA 12 vêm em versões fixas, testadas com o ctranslate2 4.8.1: cuBLAS 12.9.2.10,
  nvrtc 12.9.86 e cuDNN 9.24.0.43. São ~1,2 GB de download (~2 GB instaladas) e não vão no instalador: quando o
  programa vê uma NVIDIA (pelo nome ou pelo `nvcuda.dll` do driver), baixa uma vez em segundo plano com o pip do
  Python embutido. Até terminar, a transcrição usa o processador; o chip GPU da interface mostra o andamento e avisa
  quando acabar. Se a CUDA falhar, volta para o processador e não tenta de novo na sessão.
- **Recorte:** o ONNX oficial do RVM (`rvm_resnet50_fp32.onnx`, 107 MB, baixado na primeira vez, com trava para não
  baixar duas vezes ao mesmo tempo). O DirectML sem `device_id` já escolhe a placa de alto desempenho: nesta
  máquina, ~9 quadros/s na GTX 1650 contra ~1,6 no adaptador 0, que é a Intel. Se a placa falhar no meio, continua
  no processador. Os PNGs do recorte são gravados com `imencode`/`tofile`, porque o `cv2.imwrite` não grava em
  caminho com acento, como `C:\Users\João`.
- **Whisper:** o download, para `DATA\models\whisper`, fica separado da carga na placa: falta de internet não é
  confundida com falha da CUDA, e o servidor baixa fora da trava da GPU.

## Verificado (out/2026, GTX 1650 + Intel UHD, i5-10500H)

- **Paridade com o original:** 396 de 396 combinações (6 projetos × 11 estilos × 6 marcações) com plano e pixels
  idênticos (MP4, MOV, camadas da prévia, áreas de clique), antes e depois das correções.
- **Baterias antigas:**
  - estresse: 1.716 combinações, 0 falhas;
  - texto atrás: 396 combinações, 0 falhas;
  - fidelidade prévia × exportação: no máximo 0,26/255;
  - posição automática: 32 de 33. O caso que sobra (Preset 6 no close da mulher) é o mesmo limite já conhecido no
    original.
- **Interface no Chrome headless**, nos 11 estilos e sem erro de JavaScript: menu da palavra, desfazer, sliders,
  salvar e apagar estilo, texto atrás, exportação MP4/MOV, envio com acento no nome, transcrição na GPU e proxy de
  MKV.
- **Encoders:** NVENC, QSV e x264 funcionam neste PC. O AMF não foi testado por falta de placa AMD. A volta
  automática para o processador foi testada com um encoder quebrado de propósito.
- **Pacote:** o DirectML aparece no Python embutido, e o ffmpeg tem os 4 encoders.

## Pendências

- **Domínio:** quando definir o domínio do site, colocar em `SITE_ORIGINS` e gerar o instalador de novo.
- **Mac:** o motor já está preparado (mlx-whisper no chip Apple, CoreML, VideoToolbox, app na barra de menu) e o
  `.dmg` é gerado e testado no GitHub Actions. Ver `build/mac/LEIA-ME.md`. Falta testar num Mac de verdade; depois,
  preencher `DOWNLOAD_URL_MAC` no `site/config.js`. Sem a conta Apple, a primeira abertura pede "Abrir mesmo assim".
- **Transcrição na placa AMD/Intel:** hoje vai para o processador. O caminho é o whisper.cpp com Vulkan, que exige
  compilar o binário.
- **Licença:** o RVM é GPL-3.0, então distribuir com ele obriga a GPL e o código aberto. O ffmpeg do pacote é GPL
  (build gyan.dev "essentials"), com a licença em `app\bin`.
- **Assinatura do `.exe`:** sem certificado, o Windows mostra o aviso do SmartScreen.
