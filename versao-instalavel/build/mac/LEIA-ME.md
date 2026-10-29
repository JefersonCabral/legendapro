# Motor do LegendaPRO para Mac

O motor é o mesmo código de `versao-instalavel/app` (o Windows e o Mac compartilham tudo). No Mac ele usa:

| Etapa | Mac com chip Apple (M1…M4) | Mac Intel |
|---|---|---|
| Transcrição | mlx-whisper (Metal) | faster-whisper no processador |
| Recorte da pessoa | ONNX Runtime + CoreML | ONNX Runtime no processador |
| Exportação | `h264_videotoolbox` (`-q:v`) | `h264_videotoolbox` (bitrate) |
| Dados | `~/Library/Application Support/LegendaPRO` | igual |

- **Reserva:** se o MLX ou o Metal não estiverem disponíveis ou falharem, a transcrição cai para o faster-whisper.
  Se o VideoToolbox falhar, a exportação vai para o libx264.
- **Requisito:** macOS 14 (Sonoma) ou mais novo, por causa das bibliotecas MLX, onnxruntime e OpenCV.

## Como é gerado

No GitHub Actions (`.github/workflows/mac.yml`), a cada envio que mexe em `versao-instalavel/`:

1. `build_mac.sh <arm64|x86_64> <versão>` monta o `LegendaPRO.app` e o `.dmg`:
   - Python 3.12 do python-build-standalone;
   - dependências em `requirements-<arch>.txt`;
   - ffmpeg/ffprobe estáticos de ffmpeg.martin-riedl.de, com os encoders conferidos;
   - `launcher.py` para a barra de menu;
   - `Info.plist` com o link `legendapro://`.
2. `ci_smoke.py` roda o teste de ponta a ponta numa máquina Mac do GitHub: fala gerada com o `say`, envio,
   transcrição, recorte, exportações MP4 e MOV, e a recusa de outro site. As máquinas do GitHub são virtuais e
   **não têm Metal**, então lá a transcrição roda no processador; o caminho do MLX só é exercitado num Mac de verdade.
3. O `.dmg` fica na aba **Actions** do repositório (artefato `LegendaPRO-mac-arm64` / `-x86_64`). Em tag `v*`,
   ele vai também para a página **Releases**.

Num Mac, dá para gerar à mão: `bash versao-instalavel/build/mac/build_mac.sh arm64 1.0.0`.

## Assinatura

- **Sem conta de desenvolvedor Apple (hoje):** assinatura "ad hoc". Na primeira vez, o Mac avisa que o
  desenvolvedor não foi verificado. A pessoa abre **Ajustes do Sistema → Privacidade e Segurança → Abrir mesmo
  assim**. O `.dmg` traz um "Primeira vez - leia.txt" explicando, e o site também.
- **Com a conta (US$ 99/ano):** crie os segredos `APPLE_SIGN_ID`, `APPLE_ID`, `APPLE_TEAM_ID` e
  `APPLE_APP_PASSWORD` no repositório. O build passa a assinar com o Developer ID e enviar para a notarização, e
  o aviso some.

## O app

- Fica como **LP** na barra de menu, sem ícone no Dock. O menu tem: Abrir o LegendaPRO, Abrir a pasta dos
  projetos e Sair.
- Sobe o motor numa porta livre de 7860 a 7869.
- Aberto pelo Launchpad, abre a interface no navegador. Aberto pelo link do site (`legendapro://abrir`, que chega
  como Apple Event), não abre outra aba.
- Registro do motor: `~/Library/Logs/LegendaPRO.log`.

## Ainda precisa ser testado num Mac de verdade

- transcrição pelo MLX;
- recorte pelo CoreML;
- barra de menu;
- link `legendapro://`;
- primeira abertura sem assinatura;
- uso pelo site no Chrome;
- se o Safari bloqueia o acesso a `127.0.0.1`.
