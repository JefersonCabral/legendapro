# MEMÓRIA DO PROJETO — LegendaPRO

Registro de tudo o que foi decidido e construído, para retomar o trabalho em qualquer sessão.
Uso básico e estrutura de pastas estão no `README.md`; aqui ficam o histórico, os porquês e as medidas.

## Pedido original e regras do dono

- Reproduzir as legendas de dois reels de referência (`ref/v1.mp4` = **galho**, `ref/v2.mp4` = **desculpa**) analisando quadro a quadro: blur, mistura de fontes, cores, animações.
- O sistema deve se adaptar a **qualquer transcrição** e decidir sozinho quais palavras ganham ênfase, blur, agrupamento etc.
- **Proibido usar Remotion ou qualquer framework de vídeo.** Tudo feito com código próprio (Python + numpy/OpenCV/Pillow + ffmpeg).
- Pode pesquisar, baixar e instalar fontes melhores.
- Interface bonita e organizada: adicionar vídeo → transcrever → legendar → exportar. Fácil de adicionar presets novos.
- **Pode usar a GPU (GTX 1650, 4 GB)** sempre que precisar, para transcrição e render.
- Repositório: https://github.com/JefersonCabral/legendapro (branch `main`).

## Arquitetura

| Arquivo | Papel |
|---|---|
| `legendapro/transcript.py` | `Word(text,start,end,flags)`, markup, carregadores (Whisper/SRT/JSON/texto), `align_text` (difflib alinha texto editado aos tempos do Whisper), `get_model` com cache, `transcribe` |
| `legendapro/nlp_pt.py` | Léxicos PT (STOP, LEADERS, RED, IMPACT, LEAD_ITALIC) e `score()` de ênfase |
| `legendapro/planner.py` | Divide em frases/orações e gera cenas (chunk, stack, solo, card), decorações, flashes e timing |
| `legendapro/render.py` | Compositor: fontes/sprites, layout, Canvas uint8, efeitos, guarda de contraste, pipeline ffmpeg + NVENC |
| `legendapro/gpu.py` | Registra DLLs CUDA 12 dos pacotes pip (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12==9.*`) e detecta CUDA/NVENC |
| `legendapro/server.py` | Servidor stdlib (ThreadingHTTPServer, porta 7860), API JSON, jobs em thread, `GPU_LOCK` |
| `legendapro/cli.py` | `transcribe`, `plan`, `render`, `preview` |
| `ui/` | HTML/CSS/JS puro, tema escuro "sala de edição" |
| `presets/*.json` | Estilos (`fonts`, `layout`, `colors`, `effects`, `rules`) |

**Atenção:** `render.py` usa quebra de linha CRLF. Ao editar por script, preserve (`newline=''`).

## Transcrição

- faster-whisper **`large-v3-turbo`**, CUDA `int8_float16`. Se a CUDA falhar, cai para CPU `int8`, inclusive com nova tentativa após RuntimeError.
- Problema já resolvido: faltava `cublas64_12.dll`. A solução foi instalar as wheels nvidia e registrar as DLLs com `os.add_dll_directory` em `gpu.py`.

## Motor de cenas (planner)

Modos de cena:
- **chunk**: 1–2 palavras, troca seca. É o "miolo" da fala.
- **stack**: linhas que entram com blur, em zigue-zague. Linhas curtas de LEADERS ("a sua") ficam acima da ênfase em serifada grande.
- **solo**: palavra única com pop. O pop começa com opacidade 1, sem fade.
- **card**: fundo chapado com serifada fina, para citações e repetições (`auto_repetition`, ex.: "cada vez mais… cada vez mais").

Ênfase (`nlp_pt.score`):

| Sinal | Peso |
|---|---|
| Palavra do léxico vermelho | +2.4 (+1.0 se houver "não" nas 3 palavras anteriores) |
| Palavra de impacto | +1.3 |
| Sufixo | +0.5 |
| Gerúndio | +0.6 |
| Fim de oração / fim de frase | +0.7 / +0.4 |
| Repetição | +0.9 |
| Fala lenta | +0.5 |
| Marcação manual `*…*` | +10 |

A distribuição usa um orçamento global (`emphasis_every`) com espaço mínimo entre ênfases (`emphasis_gap`). A primeira oração (o gancho) sempre recebe ênfase.

Regras que vieram de correções:
- Pilha alta demais vira uma janela de ±2 palavras em volta da ênfase.
- Caixa vermelha na negação só entra em oração que fecha frase, com no máximo 5 palavras e respeitando cooldown.
- Maiúscula só no início de frase ou no "Não".
- O `t_in` dos tokens é igual ao `t_in` da cena (início − 0.02), para não haver quadro vazio entre chunks.
- Com `blur_out.overlap=false` (desculpa), se não houver tempo para a saída com blur, vira corte seco. Isso evita a pilha sobrepor o solo seguinte.
- Elipse e sublinhado têm cooldown.

Marcações no texto: `*ênfase*`, `!vermelho!`, `((elipse))`, `_sublinhado_`, `[caixa]`, `~solo`, `|` (quebra), `"…"`/`{card}` (card).

## Render

- O canvas é uint8. A conta em float acontece só no recorte (boundingRect) de cada máscara: caiu de 145 ms para ~35 ms por quadro em 1080p.
- Os quadros são determinísticos (dependem só de `t`) e renderizados em paralelo com ThreadPoolExecutor.
- Saída MP4 com `h264_nvenc -preset p5 -rc vbr -cq N -b:v 0`. Saída com transparência em ProRes 4444 `yuva444p10le`.
- Desempenho: um vídeo de 20 s renderiza em 6,7 s (antes levava 32 s).
- **Guarda de contraste:** se o vermelho cair sobre fundo da mesma família de cor, as palavras de destaque daquela cena trocam para `colors.red_fallback` (padrão: `colors.text`, branco). O fundo conta como vermelho quando mais de 22% da área da palavra atende a um destes critérios:
  - matiz a até ±28° do vermelho, com saturação acima de 0.35 e valor acima de 0.3;
  - distância RGB menor que 0.3.

  Isso nasceu do vídeo da mulher de camisa coral.

## Presets (medidas tiradas das referências)

Fontes: Poppins SemiBold (tracking −0.035) para o texto sans e Playfair Display Italic VF (peso 700/800) para a serifada. A UI usa DM Mono. Todas são OFL e ficam em `fonts/`; também foram instaladas por usuário no Windows.

**Preset 1 — galho** (v1):
- vermelho #B00008 com brilho (`glow_red` 0.55 / 0.011)
- serifada ×1.95, base 0.074 W
- `anchor_y` 0.675, pilha cresce para baixo, zigzag 0.55
- cards verdes #0AAB2A com texto branco
- flash de 0.2 s
- `emphasis_every` 3.2, `emphasis_gap` 0.8

**Preset 2 — desculpa** (v2):
- vermelho #DA000B piscando (flicker)
- caixa vermelha no "Não"
- elipse verde #49DC7B, sublinhado em traço
- solos ×1.62, serifada ×1.5, base 0.072 W
- `anchor_y` 0.60, pilha centralizada
- `rolling_window` 2, flash de 0.26 s
- sem cards
- `emphasis_every` 3.4, `emphasis_gap` 2.2

### Motor "frase" (rules.engine = "phrase") — presets das referências v3–v6

Cada trecho vira um **bloco** curto (`plain`) ou um **destaque** (`hero`): palavra-herói grande no centro, linhas de apoio pequenas acima/abaixo encaixadas com recuo (`above_align/indent`, `below_align/indent`, `gap_above` = base da linha de cima → topo da altura-x do herói, `gap_below` = base do herói → topo da linha de baixo), cauda serifada opcional. Âncora `anchor_mode`: `baseline` (linha de base fixa), `top` ou `center`. Animação por papel em `effects.anim.{plain,support,hero,serif}` (`type` cut/fade/rise/slide, `reveal` word/scene, `duration`, `fade`, `from` — pode ser lista para alternar —, `dist`, `blur`, `motion_blur`, `ease`), saída em `effects.exit`. Brilho em camadas `effects.glow.<papel>` (`layers` [[σ, op]], `blend` normal/screen), degradê `colors.hero_fill`, raios `effects.rays`. Fontes com eixos variáveis (`axes`: wght/opsz/wdth). Os presets são gerados por `tools/make_phrase_presets.py`; `tools/compare_refs.py` faz o comparativo lado a lado com as referências (`analysis/compare/`).

Os presets são numerados (arquivo `presets/preset-N.json`, título "Preset N"). Nomes antigos continuam aceitos como apelido (`legendapro/presets.py`: galho=1, desculpa=2, brilho=3, serifa-amarela=4, corte-limpo=5, holofote=6). Os seis são protegidos contra exclusão; preset salvo pela UI recebe o próximo número.

| preset | ref | fontes | marca |
|---|---|---|---|
| 3 (brilho) | v3 | DM Sans 500 + Geist 700 | minúsculas, herói branco enorme com halo screen, palavras surgem com subida, gradiente |
| 4 (serifa-amarela) | v4 | Tinos + Arimo 700 | serifada branca com brilho, herói #F4FC14 sobe com borrão de movimento, gradiente |
| 5 (corte-limpo) | v5 | Inter Display SemiBold | 1–2 palavras, corte seco, base fixa 0,5795; destaque marcado à mão fica 1,6× maior |
| 6 (holofote) | v6 | Inter Tight 400/750 + Playfair 2 Italic | herói amarelo com degradê, halo e raios de luz (a luz atravessa a palavra devagar, em velocidade constante, durante todo o destaque: `turn_span` 1, `sweep_ease` linear), só em alguns destaques (1 a cada ~6 s); narração normal igual ao preset 4 (bloco seco, apoio acende palavra a palavra) |

| 7 | v7 | Inter VF opsz 32 (400 / 740) + Inter Italic VF (550 / 700) | **frase empilhada** (`rules.layout_engine = "stack"`, cena `block`): a frase inteira vai se acumulando em linhas a partir de um topo fixo — apoio regular → herói bold → continuação itálica → fecho bold itálico; cada palavra "assenta" (nasce com 28–32% de opacidade, desliza 0,113 W de baixo ou da direita — linha com 4+ palavras vem da direita —, curva (1−t/0,95)^4 para posição e opacidade); bloco sai com fade de 0,25 s que termina no próximo; caixa revelada por cortina (gancho com número ou `[texto]`). Versão para vídeo com pessoa: texto branco, sombra e gradiente |
| 8 | v7 | igual ao 7 | versão fiel: texto #242424 para fundo claro, caixa escura |

Medidas completas em `analysis/v3..v7/REPORT.md`. Comparativo do preset 8 sobre a própria fala da referência: `tools/compare_refs.py` → `compare_v7()`. Não implementado: variante para fundo claro (v4), serifada escrita letra a letra (v6), zooms de edição (são do vídeo, não da legenda), no v7 a variação final com escala por letra, a lista com ✦, a escada à esquerda e a recentralização de linha.

**Destaque por palavra** (todos os presets): botão "Destaque" no menu da palavra. Acende quando a palavra já é o destaque do estilo (`plan.words[i].emph`). Ligar = `*palavra*`; desligar = `{-}palavra` (flag `noemph`: o trecho fica sem destaque mas continua ocupando a vaga no orçamento, para nenhum outro destaque aparecer em outro lugar). Várias palavras marcadas na mesma oração viram vários destaques (`split_forced`).

**Posição global da legenda** (todos os presets): `layout.offset_x` / `offset_y` (fração da largura/altura, ±0,3) aplicados em `Renderer.shift` depois de montar cada cena — translação pura, decorações e cliques acompanham; o gradiente fica parado. Na UI: arrastar qualquer palavra no preview move tudo (o ponteiro só é capturado quando o arrasto começa, senão o clique deixa de chegar na palavra), sliders "Mover para os lados / cima-baixo" (duplo clique zera) e botão "Voltar a legenda para a posição do estilo".

**Gradiente atrás da legenda**: `effects.gradient` (enabled, top, full, opacity, curve, color) em todos os presets, liga/desliga na aba Estilo.

Presets novos: botão "Salvar como novo preset" na aba Estilo, ou copiar um JSON em `presets/`. Os presets 1–6 não podem ser apagados pela API.

## Interface

- **A interface não usa fonte serifada** (pedido do dono): tudo em Poppins, sem itálico; DM Mono só nos rótulos técnicos. Serifadas ficam só nas legendas dos presets.

- Abrir com `LegendaPRO.bat`, que serve em http://127.0.0.1:7860.
- Cada projeto fica em `projects/<id>/`: `input.*`, `meta.json`, `words.json`, `text.txt`, `thumb.jpg`, `preview.mp4`, `legendado.mp4`, `legenda-alpha.mov`.
- Abas:
  - **Texto**: botões de marcação, retranscrever.
  - **Estilo**: miniaturas dos presets e controles ligados aos caminhos do JSON.
  - **Exportar**: MP4 ou alpha, resolução, qualidade.
- Atalhos no palco: espaço, ←/→, shift+←/→, Esc (limpa seleção), Ctrl+Z (desfaz edições de texto).
- **Edição direto no preview**: `/api/projects/<id>/hits?t=` devolve as caixas (0..1) das palavras visíveis (`Renderer.hits`). Cada token do plano tem `wi` (índice da palavra) e `/plan` devolve `words[i].span` (posição no `text.txt`, via `parse_markup(text, spans=True)`). Clicar na palavra abre um menu flutuante (`#wordPop`): corrigir texto, ligar/desligar efeitos, quebra e cor. Tudo vira marcação no texto, que continua sendo a única fonte da verdade.
- **Cor por palavra**: marcação `{#RRGGBB}palavra` → flag `color:#RRGGBB` → token com `user_color` (vence o vermelho e é ignorado pela guarda de contraste). Ordem ao montar as marcações na UI: `!` por fora, cor por dentro (`buildTok` em `app.js`).
- **Prévia automática**: depois de cada alteração (1,2 s de espera), refaz `preview-<job>.mp4` em 720p. O nome muda a cada vez para não sobrescrever o arquivo que o navegador está tocando. `meta.preview = {file, key}` diz se a prévia está em dia. Ao pausar, o palco volta ao quadro parado, onde dá para clicar nas palavras.
- A legenda das cores da timeline fica logo abaixo dela; o texto da aba Estilo explica que os ajustes valem para o vídeo inteiro e só chegam ao arquivo exportado depois de renderizar de novo.

## Vídeos já processados

- **Referências** (`ref/`): `tools/clean.py` gerou versões sem a legenda gravada, para testes. Ainda sobram restos ("fantasmas") da legenda original.
- **Woman speaking (IA)** (`projects_cli/woman/` e projeto da UI `8f75e21b8e48`):
  - 10 s, 720×1280, 24 fps, 30 palavras transcritas sem erro.
  - Saídas em `Downloads/Woman_legendado_desculpa.mp4` e `Downloads/Woman_legendado_galho.mp4`.

## Lições operacionais

- Nunca matar todos os processos python. Para parar o servidor, achar o PID com `netstat -ano | grep :7860` e matar só esse.
- Não contornar bloqueios de remoção com glob. Usar uma pasta nova.
- Rodar renders pesados em sequência, não em paralelo: a GPU tem só 4 GB.
- No git ficam fora: `projects/`, `projects_cli/`, `out/`, `ref/`, `analysis/`, `presets/_thumbs/` e arquivos de vídeo.

## Ideias para o futuro

- Mais presets a partir de novos reels de referência (mesmo processo: quadros → medidas → JSON).
- `red_fallback` configurável na UI.
- Limpeza melhor dos restos de legenda nas versões limpas das referências.
