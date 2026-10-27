# LegendaPRO

Motor próprio de **legendas dinâmicas** (sem Remotion nem framework de vídeo): Python + numpy/OpenCV/Pillow + ffmpeg, com transcrição Whisper na GPU e interface web local.

## Abrir

Dê dois cliques em **`LegendaPRO.bat`**. O navegador abre em `http://127.0.0.1:7860`.

1. **Vídeo**: arraste o arquivo para a tela. A transcrição começa sozinha (`large-v3-turbo` na GPU).
2. **Texto**: corrija ou cole o seu roteiro. Ele é re-sincronizado com o áudio. Os botões aplicam efeitos às palavras selecionadas.
3. **Estilo**: escolha um preset e ajuste nos controles. *Salvar como novo preset* cria um preset reutilizável.
4. **Exportar**: MP4 com a legenda gravada, ou MOV ProRes 4444 com transparência para usar no Premiere, DaVinci ou CapCut.

Atalhos no palco: `espaço` toca a prévia, `←`/`→` andam um quadro, `shift+←/→` andam 1 segundo.

## Marcações no texto (opcionais, o automático decide o resto)

| Marcação | Efeito |
|---|---|
| `*palavra*` | ênfase em serifada itálica |
| `!palavra!` | destaque vermelho |
| `((palavra))` | elipse desenhada à mão |
| `_palavra_` | sublinhado em traço |
| `[palavra]` | caixa vermelha atrás |
| `~palavra` | palavra solo com pop |
| `\|` | força uma nova cena |
| `"…"` | trecho vira card de citação (presets com cards) |

## Como o motor decide

`legendapro/planner.py` divide a fala em frases e orações (pontuação, pausas e conjunções) e escolhe um modo para cada trecho:

- **chunk**: 1–2 palavras com troca seca (o "miolo" da fala)
- **pilha**: linhas que entram com blur, em zigue-zague, misturando sans e serifada
- **solo**: palavra única grande com pop (falas pausadas)
- **card**: fundo chapado com serifada fina (citações e repetições como "cada vez mais… cada vez mais")

As ênfases vêm de `legendapro/nlp_pt.py`: tamanho da palavra, léxico de impacto e de dor (o vermelho), fim de oração, repetição, ritmo da fala e gerúndios. Elas são distribuídas por um orçamento (`emphasis_every`) com espaçamento mínimo (`emphasis_gap`).

## Presets

Cada preset é um JSON em `presets/`. Os dois de referência foram reconstruídos quadro a quadro a partir dos vídeos em `ref/`:

- **Preset 1** (`preset-1`, antigo galho): vídeo 1. Serifada gigante, pilha crescendo para baixo, vermelho escuro com brilho, cards verdes e flash de luz.
- **Preset 2** (`preset-2`, antigo desculpa): vídeo 2. Pilha centralizada que sobe, vermelho vivo piscando, caixa no "Não", elipse verde, sublinhado e solos.

Seções do JSON:

- `fonts`: papéis `sans`, `sans_i`, `serif`, `card`, cada um com arquivo em `fonts/`, `weight` (para fonte variável) e `tracking`
- `layout`: `anchor_y`, `base_size` (fração da largura), escalas, entrelinhas, `zigzag`, `grow` (`center`/`down`)
- `colors`: `text`, `red`, `accent`, `card_bg`, `card_text`
- `effects`: `blur_in`, `blur_out`, `pop`, `cut`, `shadow`, `glow_red`, `flicker`, `red_glow`, `flash`, `drift`, `rolling_window`
- `rules`: frequência de ênfase, probabilidades de solo, elipse e sublinhado, caixa na negação, cards etc.

**Novo preset:** ajuste na aba *Estilo* e clique em *Salvar como novo preset*, ou copie um JSON em `presets/` e edite. Fontes novas (`.ttf`/`.otf`) colocadas em `fonts/` aparecem na interface.

## Linha de comando

```
python -m legendapro render  --video in.mp4 --preset preset-2 -o out.mp4
python -m legendapro render  --video in.mp4 --text roteiro.txt --preset preset-1 -o out.mp4
python -m legendapro render  --srt legenda.srt --preset preset-1 --alpha -o legenda.mov
python -m legendapro plan    --video in.mp4 --preset preset-1 -o plano.json   # plano editável
python -m legendapro render  --plan plano.json --video in.mp4 -o out.mp4
python -m legendapro preview --video in.mp4 --preset preset-2 --at 1.2 3.4 -o prev.jpg
```

## Estrutura

```
legendapro/  transcript.py (Whisper/SRT/JSON/texto + alinhamento)  nlp_pt.py (heurísticas PT)
             planner.py (cenas)  render.py (compositor + ffmpeg)  gpu.py  server.py  cli.py
ui/          interface (HTML/CSS/JS puro)
presets/     estilos (JSON)
fonts/       Poppins, Playfair Display, DM Mono (licença OFL)
projects/    seus projetos (vídeo, palavras, texto, exportações)
ref/         vídeos de referência; analysis/ guarda a análise quadro a quadro
tools/       utilitários de análise (strip, clean, fontcmp)
```

## Requisitos

Python 3.11+, ffmpeg no PATH, `pip install -r requirements.txt`. Com GPU NVIDIA, a transcrição usa CUDA (`int8_float16`) e o encode usa NVENC. Sem GPU, tudo roda na CPU.
