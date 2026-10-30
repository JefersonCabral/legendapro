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

Todos os arquivos usam quebra de linha LF (out/2026; antes o `render.py` era CRLF).

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
| 9 | v8 | Figtree VF wght 800, tracking −0,11, espaço 0,5 | texto rosa #FFC3C4 em **modo diferença** com o vídeo (medido: difference vence todos os 19 modos testados; no claro vira verde-petróleo), palavra negativa vermelha #FF1B38 maior (`red_auto`, `red_scale`), linha entra inteira com fade 0,3 s (`reveal: "line"`), sai seco |
| 10 | v9 | Inter VF opsz 18 wght 420 + Inter Italic VF wght 700 | **caixa que se preenche** (`rules.layout_engine = "fill"`, cena `fill`): caixa de 0,41 W; a referência fica no topo (0,161 H), mas o preset começa embaixo (anchor_y 0,72) e o usuário move; Title Case (`case: "title"`); a linha com palavra-chave é escalada até preencher a caixa (pequenas = chave / 1,85, mesma linha de base); linhas curtas em zigue-zague; pequenas deslizam da esquerda, chave sobe de baixo, rampa linear com "snap" quando a próxima palavra começa (`until: "word_end"`); chave em difference; corte seco |
| 11 | v10 | Inter VF opsz 32 (330 destaque / 370 texto) | **destaque que desliza o bloco inteiro**: nasce translúcido e sobe com ease exponencial (`duration: "scene"`, `ease: "out_exp"`, k 3,8) até o corte, direção alternada por destaque (`from` lista + `hero_n`, `dist_by_from`); frase de baixo acende palavra a palavra (fade linear 0,42 s) e o destaque puxa as orações seguintes da frase (`hero_absorb_after`); números contam até o valor (`effects.count_up`); `min_word_time`/`min_scene_time` 0,55 por causa do fade lento |

Medidas completas em `analysis/v3..v7/REPORT.md`. Comparativo do preset 8 sobre a própria fala da referência: `tools/compare_refs.py` → `compare_v7()`. Não implementado: variante para fundo claro (v4), serifada escrita letra a letra (v6), zooms de edição (são do vídeo, não da legenda), no v7 a variação final com escala por letra, a lista com ✦, a escada à esquerda e a recentralização de linha.

**Destaque por palavra** (todos os presets): botão "Destaque" no menu da palavra. Acende quando a palavra já é o destaque do estilo (`plan.words[i].emph`). Ligar = `*palavra*`; desligar = `{-}palavra` (flag `noemph`: o trecho fica sem destaque mas continua ocupando a vaga no orçamento, para nenhum outro destaque aparecer em outro lugar). Várias palavras marcadas na mesma oração viram vários destaques (`split_forced`).

**Posição global da legenda** (todos os presets): `layout.offset_x` / `offset_y` (fração da largura/altura, ±0,3) aplicados em `Renderer.shift` depois de montar cada cena — translação pura, decorações e cliques acompanham; o gradiente fica parado. Na UI: arrastar qualquer palavra no preview move tudo (o ponteiro só é capturado quando o arrasto começa, senão o clique deixa de chegar na palavra), sliders "Mover para os lados / cima-baixo" (duplo clique zera) e botão "Voltar a legenda para a posição do estilo".

**Espaçamento global (todos os presets)**: `layout.tracking_add` (somado ao tracking de todas as fontes do preset) e `layout.word_space` (multiplica o espaço entre palavras) em `Fonts`; controles "Espaço entre letras / entre palavras (todo o texto)" no grupo Fontes. Substituíram o antigo "Espaçamento da sans", que só mexia no texto comum.

**Leitura garantida (todos os presets)**: `Planner.readable` — toda palavra fica ≥ `rules.min_word_time` (0,3 s) na tela; em fala rápida ela entra um pouco antes. Motor frase: palavra de ligação no fim de um bloco vai para o próximo (`plain_groups`, blocos do stack/fill); bloco plain curto demais (< `min_scene_time` 0,3 s) é juntado ao anterior/seguinte (`merge_short`), respeitando Quebra marcada à mão. Caixa (`[texto]`) funciona em todos os motores frase (sem `colors.box`, usa a cor vermelha do preset).

**Efeitos por estilo na UI**: os ícones dos botões (Destaque, Vermelho, Elipse, Traço, Caixa, Solo) são renderizados pelo próprio motor do preset (`/api/presets/<nome>/fx/<efeito>.png`, cache em `presets/_thumbs/fx_*`); cada preset tem `effect_notes` (o que Destaque/Vermelho/Caixa… fazem nele); o menu da palavra mostra "Destaque neste estilo: …", títulos dos botões usam as notas e Solo/Card ficam escondidos nos presets do motor frase.

**Verificação completa** (out/2026): bateria por preset (palavras únicas e com texto certo, todas clicáveis, legíveis ≥ 0,15 s a > 50%, edição de texto, cada efeito muda plano e pixels) + todos os projetos × presets + teste na UI clicando os botões dos 10 presets — tudo passando.

**Modo de mistura (blend mode)**: `effects.blend` (enabled, mode, opacity, roles) em `Canvas.mix` / `blend_rgb` com 13 modos (difference, screen, overlay, soft light, multiply…). Grupo "Mistura com o vídeo" na aba Estilo, para qualquer preset. No MOV transparente não há fundo, então cai em normal.

**Gradiente atrás da legenda**: `effects.gradient` (enabled, top, full, opacity, curve, color) em todos os presets, liga/desliga na aba Estilo.

Presets novos: botão "Salvar como novo preset" na aba Estilo, ou copiar um JSON em `presets/`. Os presets 1–6 não podem ser apagados pela API.

## Interface

- **A interface não usa fonte serifada** (pedido do dono): tudo em Poppins, sem itálico; DM Mono só nos rótulos técnicos. Serifadas ficam só nas legendas dos presets.

- Abrir com `LegendaPRO.bat`, que serve em http://127.0.0.1:7860.
- Cada projeto fica em `projects/<id>/`: `input.*`, `meta.json`, `words.json`, `text.txt`, `thumb.jpg`, `preview.mp4`, `legendado.mp4`, `legenda-alpha.mov`.
- Abas:
  - **Texto**: texto visual sem códigos (`#rich`: cada palavra com a cor/efeito como vai sair, destaque automático sublinhado em âmbar, palavra falada acesa). Clicar/arrastar/shift+clique seleciona e abre o mesmo menu da palavra do vídeo. "Editar texto livre" mostra o `textarea` com os códigos. Retranscrever fica num grupo recolhido.
  - **Estilo**: cartões de estilo com "Preset N" + nome curto (`presets.TAGLINES`, campo `tagline`); passar o mouse toca a prévia animada (`/api/presets/<n>/anim.mp4`, cache em `presets/_thumbs/<n>.mp4`). Controles em Básico/Avançado (`adv`, `lp.adv`) e por motor (`eng: classic|phrase`). "Altura na tela" (`layout.anchor_y`) saiu da UI: ao abrir o projeto, um ajuste antigo vira `offset_y` (mesmo efeito).
  - **Exportar**: MP4 ou alpha, resolução, qualidade. `meta.exports_info[arquivo] = {key, preset, time, width, height, quality}`; se `key` ≠ chave do plano atual, mostra "desatualizado" e um ponto na aba. "Mostrar na pasta" = `POST /api/projects/<id>/reveal` (Explorer com o arquivo selecionado).
- **Desfazer/refazer** (botões no topo, Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y): cada passo guarda texto + preset + ajustes (`H` em `app.js`); arrastar um slider vira um passo só. Troca de estilo, "Restaurar estilo" e mover a legenda mostram aviso com "Desfazer".
- Confirmações (apagar projeto/estilo, retranscrever) e a ajuda (tecla `?`) usam a janela `#modal` do app, nunca `confirm()`.
- O projeto abre no primeiro quadro com a legenda inteira (`firstCaptionTime`, usa `scenes[i].wi` do `/plan`); dica sobre o vídeo na primeira vez (`lp.tipSeen`).
- Tela inicial: grade de estilos (lembra o último, `lp.uploadPreset`); modelo de transcrição em "Opções avançadas", com nomes simples.
- Preset apagado: projetos que o usavam caem no padrão (`presets.resolve_existing`).
- Atalhos no palco: espaço, ←/→, shift+←/→, Esc (limpa seleção), Ctrl+Z / Ctrl+Shift+Z, `?` (ajuda).
- **Edição direto no preview**: `/api/projects/<id>/hits?t=` devolve as caixas (0..1) das palavras visíveis (`Renderer.hits`). Cada token do plano tem `wi` (índice da palavra) e `/plan` devolve `words[i].span` (posição no `text.txt`, via `parse_markup(text, spans=True)`). Clicar na palavra abre um menu flutuante (`#wordPop`): corrigir texto, ligar/desligar efeitos, quebra e cor. Tudo vira marcação no texto, que continua sendo a única fonte da verdade.
- **Cor por palavra**: marcação `{#RRGGBB}palavra` → flag `color:#RRGGBB` → token com `user_color` (vence o vermelho e é ignorado pela guarda de contraste). Ordem ao montar as marcações na UI: `!` por fora, cor por dentro (`buildTok` em `app.js`).
- **Prévia ao vivo** (pedido do dono: "editar em tempo real, como no CapCut/Premiere"; substituiu a prévia em MP4 e o quadro parado do servidor): o `<video>` toca o arquivo original (com som) e canvases por cima (`#live`) recebem a legenda que o motor desenha sob demanda, sem vídeo, em camadas RGBA — `normal`, `screen` (brilhos/raios, CSS `mix-blend-mode: screen`), `blend` (modo de mistura do estilo, via CSS) e `flash` (lavagem do clarão, só quando aparece); o gradiente vai uma vez só (`/live_bg.png`, camada `bg`). `Renderer.frame_layers(t)` + `LayerCanvas`; a guarda de contraste olha o quadro do vídeo no início da cena (`Renderer.guard_bg`). Fidelidade medida contra o quadro exportado: diferença média ≤ 0,24/255 e 0% de pixels com diferença > 24, nos 11 presets.
  - `/plan` devolve `live = {fps 30, w, h, segs, blend, bg}`; `segs` = assinatura por faixa de quadros (hash do estilo + cenas/clarões ativos; "0" = vazio). O navegador guarda os quadros por `assinatura:índice`, então uma edição só refaz os quadros cujas cenas mudaram. `/live?f=a-b,c` devolve `[uint32][JSON][PNGs]` (só o recorte com desenho). Pede primeiro o quadro da tela, depois ~1–4 s à frente, depois o resto do vídeo em segundo plano; sincroniza no play com `requestVideoFrameCallback`.
  - Medido (vídeo de 13 s): ~8 ms por quadro no servidor (4× o tempo real a 30 fps); editar uma palavra → legenda nova em ~90 ms; mudar estilo ~300 ms (inclui 120 ms de espera dos controles); troca de preset ~400 ms; play com a legenda em dia em 192/192 quadros.
  - Vídeo que o navegador não toca (codec fora de h264/vp8/vp9/av1, áudio fora de aac/mp3/opus/vorbis/flac, ou contêiner mkv/avi): `job_proxy` gera `proxy.mp4` (H.264 ≤ 720p, NVENC) só para a prévia; `meta.playable` guarda a decisão. Exportação sempre usa o original.
- **Texto atrás da pessoa** (pedido do dono, out/2026): marcação `{atras}` … `{/atras}` ou `{atras:dx,dy,escala}` (posição própria em fração da largura/altura, somada à geral; escala multiplica o `size` das palavras — no motor da caixa, a largura da caixa). As bordas viram quebra de legenda. `Planner.mark_behind` põe `sc["behind"] = {g, dx, dy, s}`.
  - Recorte: **Robust Video Matting** ResNet50 (`models/rvm_resnet50_fp32.torchscript`, ~103 MB, GPL-3.0, fora do git), fp32 (em fp16 dá NaN na GTX 1650). Só nos quadros das cenas de trás (+1 s de saída, +0,4 s de aquecimento), uma vez, em `projects/<id>/matte/<quadro>.png` (cinza, resolução do vídeo, índice no fps do vídeo). ~10–12 quadros/s em 480p, ~14 em 1080p. Roda num **subprocesso** (`python -m legendapro.matte`) sem as pastas nvidia-cu12 no PATH: no mesmo processo do Whisper o PyTorch (CUDA 13) misturava versões do cuDNN (`CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH`). `meta.matte_v` sobe a cada recorte (entra na assinatura dos quadros da prévia). Vídeo com menos quadros que a conta pela duração: o último recorte é repetido.
  - Exportação: vídeo → gradiente → texto de trás → pessoa por cima (pixels de antes do texto) → resto. No MOV transparente, onde a pessoa passa fica só o gradiente. A exportação recorta antes o que faltar.
  - Prévia ao vivo: camadas `back_normal/back_screen/back_blend`, depois `person` (o navegador desenha o próprio `<video>` + gradiente mascarado pelo recorte, em meia resolução, a cada quadro do vídeo — `paintPerson`), depois a frente.
  - UI: clicar numa legenda da linha do tempo seleciona as palavras dela (shift = intervalo, ctrl = soma); botão "Atrás da pessoa" no menu (cada legenda vira um trecho próprio, nasce a ~1/3 da altura e 1,4× maior, porque na altura normal a pessoa cobre o texto); arrastar uma palavra de trás move só o trecho; tamanho no menu. O recorte começa sozinho e o progresso aparece ao lado do tempo; trechos de trás ficam listrados na linha do tempo.
  - **Posição automática** (padrão ao marcar pela interface; `{atras}` sem números): `matte.place` olha a silhueta média da pessoa durante cada legenda e escolhe altura, centro (no meio da pessoa) e tamanho (0,7–2,1×). Mira em ~1/3 do bloco coberto, dentro da tela. Penaliza linha quase toda escondida, pesando pelo tamanho da letra (a palavra de destaque conta mais). `server.place_behind` aplica isso no plano; sem recorte ainda, usa um palpite (1/3 da altura, 1,4×) e refaz quando o recorte fica pronto (`matte_v` entra na chave do plano). Arrastar ou mudar o tamanho grava números (vira manual); "Posicionar automaticamente" volta para `{atras}`.
  - Testado em 3 vídeos reais (mulher em close + plano aberto, "PARTE 1" de corpo inteiro, senhor) × 11 presets. Com posição fixa, o close deixava só 17% do texto visível em média; com a automática, ~56% em média (39% no pior estilo). Em todos os casos nenhum pixel de texto passa por cima da pessoa (pior erro 1,6/255), e a prévia fica igual à exportação (≤ 0,3/255).
  - Limite conhecido: num close em que a cabeça é mais larga que a palavra de destaque em qualquer altura (ex.: Preset 6, que tem um bloco de 3 linhas, no vídeo da mulher), o destaque fica quase todo escondido. Nesse caso, ajustar à mão.
  - **Agulha e recorte (bug corrigido):** a legenda da prévia acompanha o quadro que o vídeo **mostra** (`LV.vt`, via `requestVideoFrameCallback` também com o vídeo parado, e no `seeked`), não a posição da agulha. Antes, ao arrastar, a legenda ia para o ponto novo enquanto o vídeo ainda buscava o quadro, e o recorte (feito do próprio `<video>`) saía vazio ou de outro quadro: o texto de trás aparecia na frente. As buscas são agrupadas (`LV.pendingSeek`: só a última posição espera a busca atual terminar). `paintPerson` checa `videoWidth`, não `readyState`, que cai entre uma busca e outra. Teste com Chrome headless via CDP (`scrub_test.mjs`): durante o arrasto, texto de trás sem pessoa caiu de 13/22 amostras para 1–2/23 (só o instante de um quadro de tela); parado, 0; play, 100% com a pessoa.
  - **Grade de quadros:** exportação (`render_video`) e recorte decodificam com `-vf fps=<fps>` e o recorte escolhe o quadro por número (`select=gte(n\,k)`), nunca por `-ss`. Em vídeo de taxa variável (ex.: o "senhorvideo", 24 quadros reais declarados a 60 fps) o `-ss` desalinhava 1–2 quadros. Verificado: recorte k = quadro k da exportação (diferença 0).
- Revisão independente (out/2026), 12 itens corrigidos:
  - a prévia recarrega o plano quando o servidor responde outra assinatura (antes entrava em laço de pedidos);
  - `refreshPlan` descarta resposta velha ou de outro projeto;
  - trocar de projeto salva antes a digitação pendente;
  - guarda de contraste com trava por renderizador (threads da prévia);
  - recorte sem cache na exportação (cache da prévia em uint8);
  - a fila do recorte é recalculada dentro do `GPU_LOCK`;
  - mudanças de trecho chegando antes do plano novo ficam pendentes (`pendingGroup`);
  - cortes de etiquetas vizinhas são unidos (`mergeCuts`);
  - o `meta.json` é relido antes de gravar nos trabalhos longos.
- `meta.json`: leitura e gravação sob `_meta_lock` (no Windows, trocar o arquivo enquanto outra requisição lê dava "Acesso negado" e a alteração se perdia).
- **Layout**: colunas 220/370 px até 1440 px de largura; menu da palavra empurra o vídeo para o lado quando não cabe ao lado dele (`shiftPhone`); legenda da timeline mostra só os tipos de cena do vídeo atual; grupos de controles vazios para o estilo somem; estilos em grade de 3.
- Linha do tempo: cada bloco mostra o texto da legenda; pontos âmbar marcam as palavras em destaque.
- Card só aparece no menu quando o estilo tem `rules.cards.enabled` (hoje só o Preset 1); Solo e Card somem nos estilos do motor "frase".
- Contraste: `--muted #a39789`, `--faint #7e7369`; textos de ajuda ≥ 11 px.
- **Análise de usabilidade (out/2026)** feita e aplicada por completo. Verificação: bateria no navegador com os 11 presets (todas as palavras no texto visual, cada efeito muda texto e plano, desfazer volta exato, cor, 0 erros JS), envio + transcrição, exportação + selo desatualizado, prévia, arrastar, apagar com confirmação, salvar/apagar estilo.

## Versão para distribuir (`versao-instalavel/`, out/2026)

Pedido do dono: deixar a ferramenta "online", com o processamento no PC de quem usa (NVIDIA, AMD, Intel ou só CPU), site no **Cloudflare** e dados no PC da pessoa. Modelo escolhido por ele: **híbrido**. A pessoa abre o site e usa a interface ali; o motor instalado no PC faz tudo, e a página fala com ele em `127.0.0.1:7860–7869`. O original (`legendapro/`, `ui/`) **não foi tocado**: a pasta `versao-instalavel/` tem uma cópia adaptada. Detalhes, medidas e pendências estão em `versao-instalavel/LEIA-ME.md`.

- `app/`: motor adaptado. Mudanças principais:
  - `paths.py`: dados em `%LOCALAPPDATA%\LegendaPRO`, ffmpeg embutido e presets por manifesto;
  - `gpu.py`: encoder por marca, CUDA baixada sob demanda e volta para a CPU;
  - `matte.py`: ONNX + DirectML;
  - `server.py`: CORS, Host e Origin.
- Interface: `app.js` com `ENGINE` / `E()` e descoberta do motor.
- **Paridade:** 396 de 396 combinações idênticas ao original. Ao mudar o motor original, levar a mudança para a cópia, ou unificar os dois.
- `build/`:
  - `build.ps1`: Python 3.12 embutido, `requirements-dist.txt` fechado com `--no-deps` (por causa do onnxruntime-directml), ffmpeg 7.1.1 e Inno Setup (instalado por usuário via winget);
  - saída: `dist/LegendaPRO-Setup.exe` (~178 MB) e o zip;
  - `iniciar.py` é o lançador (ver se já está aberto, protocolo `legendapro://`);
  - `make_site.py` copia `app/ui` para `site/app`.
- `site/`: página de download, o app em `/app/` e `_headers` com CSP própria para `/app/*`, sem `upgrade-insecure-requests`.
- **Domínio ainda não definido:** `SITE_ORIGINS` em `app/legendapro/__init__.py` aceita `legendapro.pages.dev`. Trocar quando o dono decidir e gerar o instalador de novo.
- **Mac:** o motor está preparado no mesmo código (`build/mac/`, ver o LEIA-ME de lá):
  - transcrição com mlx-whisper no chip Apple; reserva com faster-whisper;
  - recorte com CoreML;
  - exportação com VideoToolbox;
  - app na barra de menu (rumps), com link `legendapro://` via Apple Event;
  - `.dmg` gerado e testado no GitHub Actions (`.github/workflows/mac.yml`, chip Apple em `macos-15` e Intel em `macos-15-intel`), com o teste com aceleração e com `LEGENDAPRO_FORCE_CPU=1`. O runner arm64 tem Metal: lá rodam de verdade o MLX e o VideoToolbox.
  - Logs dos jobs exigem admin; o `ci_smoke.py` publica cada etapa como anotação (`::notice::`/`::error::`), que a API pública de check-runs devolve.
  - O dono **não tem conta de desenvolvedor Apple**. O Mac dele é chip M, modelo desconhecido. A assinatura é ad hoc e a primeira abertura pede "Abrir mesmo assim".
  - `DOWNLOAD_URL_MAC` vazio no `site/config.js` faz o site mostrar "em breve". **Falta o dono testar no Mac dele.**
- **Fixações que importam:**
  - `av==18.0.0`: o faster-whisper 1.2.1 usa `metadata_errors`, que a av 19 tirou;
  - mlx-whisper com `--no-deps`: ele declara o torch só para converter modelos;
  - onnxruntime 1.23.2 no Mac Intel: o projeto parou de publicar para Intel depois dessa versão.
- **Bug de corrida no brilho (corrigido só na cópia, v1.0.3):**
  - **Sintoma:** manchas de brilho na palavra errada, nos presets 3, 4 e 6.
  - **Causa:** os quadros são desenhados em várias threads, e `Sprites.get` não tinha trava. Duas threads criavam o mesmo sprite, uma cópia era descartada e o id dela ia parar em outro sprite. `glow_img` usava `id(spr)` na chave do cache, então esse outro sprite recebia o brilho errado.
  - **Correção:** `setdefault` em `Sprites.get` e a chave do brilho passa a ser a chave do sprite.
  - **O original (`legendapro/render.py`) ainda tem o bug.** O dono pediu para não mexer nele; aplicar lá quando ele autorizar.
- **Comparação original × online (out/2026):** vídeos exportados idênticos pixel a pixel nos 11 presets; prévia no navegador igual (mesma lógica e mesmo ritmo); `anim.mp4` dos cartões idênticos byte a byte. Scripts em `cmp/` na pasta temporária da sessão.
- **Atualização automática (v1.1.0):**
  - **Publicação:** `updater.py` lê o `latest.json` da Release. O arquivo é gerado por `build/make_manifest.py` no job `manifesto` do `motor.yml` e assinado com Ed25519.
  - **Chaves:** a pública está no código; a privada fica em `%USERPROFILE%\.legendapro\chave-atualizacao-PRIVADA.txt` e tem que estar no segredo **`LEGENDAPRO_UPDATE_KEY`** do GitHub. Sem ele, o manifesto sai sem assinatura e o motor só avisa, sem instalar sozinho.
  - **Quando instala:** baixa e confere o SHA-256. Instala no "Atualizar agora" (nunca com trabalho rodando) ou sozinho ao abrir.
  - **Ajudante do Windows (`atualizar.ps1`):** copia a pasta com robocopy para `.anterior`, instala com o Inno em `/VERYSILENT`, reabre na mesma porta e confere a versão. Se a nova não responder, copia a anterior de volta e marca `falhou-<v>`.
    - Renomear a pasta falhava sempre que algo estava com ela aberta, então passou a ser cópia.
    - Com DETACHED_PROCESS o PowerShell não inicia; usar CREATE_NO_WINDOW.
    - O registro do ajudante fica fora da pasta da versão, porque o `cleanup` do motor novo apaga essa pasta.
  - **Ajudante do Mac (`atualizar.sh`):** troca o `.app` e reabre por `open -a <app> legendapro://atualizado`. **Ainda não foi testado num Mac.**
  - **Interface:** aviso no topo e janela "Este computador" (clique no chip GPU).
  - **Motores 1.0.x** (sem atualizador): o site oferece o download.
  - **Testado no Windows** com instaladores "LegendaPRO Teste" (outro AppId, `/DSemProtocolo`, pasta curta em `%LOCALAPPDATA%\LPTeste`; o caminho longo da pasta temporária estoura os 260 caracteres): 8.0.0→8.0.1, 8.0.2→8.0.3 (ao abrir) e volta automática com versão quebrada.
- **Corte de vídeo (v1.1.0):**
  - **Dados:** `meta.cuts` são os trechos apagados, em segundos do vídeo original; `meta.splits` são as divisões da lâmina. O servidor normaliza os dois.
  - **Plano:** as palavras dentro de cortes saem da legenda. Os `wi` continuam apontando para o texto inteiro, e `words[i].cut` vem marcado.
  - **Exportação:** pula os quadros e usa `aselect` no áudio.
  - **Interface:** linha do tempo editada com zoom (Ctrl/Alt + roda), faixa de clipes com miniaturas, Ctrl+B/K e Delete; o play pula os cortes.
- **Destaques (v1.1.0):**
  - **Dois destaques na mesma oração:** antes, marcar uma palavra derrubava o destaque automático da oração. Agora `Planner.plan` planeja sem as marcações e re-marca os destaques automáticos que se perderiam.
  - **Cor:** o brilho e os raios seguem a cor escolhida na palavra (`user_color`).
- **PC sem placa:** `LEGENDAPRO_FORCE_CPU=1` simula. Testado com vídeo real: transcrição, recorte e x264 corretos.

## Vídeos já processados

- **Referências** (`ref/`): `tools/clean.py` gerou versões sem a legenda gravada, para testes. Ainda sobram restos ("fantasmas") da legenda original.
- **Woman speaking (IA)** (`projects_cli/woman/` e projeto da UI `8f75e21b8e48`):
  - 10 s, 720×1280, 24 fps, 30 palavras transcritas sem erro.
  - Saídas em `Downloads/Woman_legendado_desculpa.mp4` e `Downloads/Woman_legendado_galho.mp4`.
- **Projetos de teste do texto atrás da pessoa** (na UI, com recorte pronto e trechos marcados; podem ser apagados):
  - "TESTE ATRÁS" `7e57a11c0de4`: cópia do "senhorvideo", que é VFR (24 quadros reais declarados a 60 fps);
  - "TESTE Woman" `3adab87cc8a7`: a mulher falando sobre IA, 10 s, 24 fps. Close no começo; no fim corta para um plano aberto na bancada;
  - "TESTE PARTE 1" `22c51713094b`: homem de corpo inteiro, 8 s.
- Projetos do dono na UI: "PARTE 1" `0aa8983fe3ea`, "senhorvideo" `e85aca749034`, "PARTE 2" (criado por ele). Testes sempre em cópias, nunca nos dele.

## Lições operacionais

- Nunca matar todos os processos python. Para parar o servidor, achar o PID com `netstat -ano | grep :7860` e matar só esse.
- Não contornar bloqueios de remoção com glob. Usar uma pasta nova.
- Rodar renders pesados em sequência, não em paralelo: a GPU tem só 4 GB.
- No git ficam fora: `projects/`, `projects_cli/`, `out/`, `ref/`, `analysis/`, `presets/_thumbs/`, `models/` e arquivos de vídeo.
- **Testar a UI sem o navegador do dono:** há dois Chrome conectados à conta (Windows e macOS), e a extensão exige que ele escolha qual usar, o que ele prefere evitar. Para validar, usar o Chrome headless controlado por CDP com Node (WebSocket nativo do Node 24): `chrome.exe --headless=new --remote-debugging-port=9333 --autoplay-policy=no-user-gesture-required --user-data-dir=<temp>`, depois `Runtime.evaluate` com `awaitPromise` e `Page.captureScreenshot`. Antes de navegar, gravar `lp.last` no localStorage para abrir o projeto. Assim já foram feitos o teste de arrastar a agulha (`scrub_test.mjs`) e o de sincronia no play.
- `Runtime.evaluate` (extensão ou CDP) estoura em ~45 s: baterias longas rodam em segundo plano na página (`window.__res`) e o resultado é lido depois.
- No console do Windows, `print` com caracteres fora do cp1252 (ex.: ≠) quebra o script: usar `PYTHONIOENCODING=utf-8` e gravar os resultados em JSON.
- Edição por script com heredoc: escapes (`\{`, `\n`, a `\` de continuação de linha) costumam não bater ou viram o caractere de verdade; para trechos com barra invertida, usar a ferramenta Edit.
- O dono quer revisão: ao terminar algo grande, rodar as baterias de novo (`stress.py`, `stress_behind.py`, `fidelity.py`, `behind_auto.py` na pasta temporária da sessão; recriar se sumirem) e fazer uma revisão de código independente.

## Ideias para o futuro

- **Exportar para o CapCut** (pesquisado em out/2026, ainda não feito; o dono perguntou). O CapCut do dono é o **9.6** (`%LOCALAPPDATA%/CapCut/Apps/9.6.0.4097`). Os projetos ficam em `%LOCALAPPDATA%/CapCut/User Data/Projects/com.lveditor.draft/<pasta>/`, e o `draft_content.json` é **JSON aberto** (`"version":360000`, `"new_version":"189.0.0"`). Só o JianYing chinês 6.0+ criptografa.
  - Caminho recomendado ("opção 1"): gerar uma pasta de projeto com o vídeo + o MOV transparente da legenda numa faixa por cima. Fica idêntico ao LegendaPRO e o resto continua editável no CapCut.
  - "Opção 2": legenda como texto nativo do CapCut, editável. Seria só uma aproximação: não existe lá a entrada com desfoque por palavra, os halos em camadas, a mistura de diferença, a elipse desenhada nem o nosso texto atrás da pessoa.
  - "Preset" de texto do CapCut: os modelos vêm da loja deles e não são importáveis.
  - Risco: o formato não é oficial e muda entre versões; há relatos de 8.x/9.x recusando projetos feitos a partir de modelos antigos ("unconventional path"). Montar copiando a estrutura de um projeto real da 9.6 do dono e testar abrindo no app. Referências: capcut-cli (renezander030), pyCapCut/pyJianYingDraft, VectCutAPI.
- Texto atrás da pessoa: escolher **uma** pessoa clicando nela (hoje o RVM recorta todas). Caminho possível: SAM 2 ou componentes conectados a partir do clique.
- Mais presets a partir de novos reels de referência (mesmo processo: quadros → medidas → JSON).
- `red_fallback` configurável na UI.
- Limpeza melhor dos restos de legenda nas versões limpas das referências.
