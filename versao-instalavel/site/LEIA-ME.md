# Site do LegendaPRO (Cloudflare Pages)

Site estático (HTML/CSS/JS puro, sem build): a página de download em `/` e o próprio app em `/app/`. O app no
navegador conversa com o **motor** instalado no PC da pessoa (`http://127.0.0.1:7860–7869`). Os instaladores do
motor ficam na página de **Releases** do GitHub, não no Pages, que aceita no máximo 25 MiB por arquivo.

```
site/
├── index.html        página de download
├── config.js         links dos instaladores, versão, tamanho   ← o que se edita numa versão nova
├── _headers          segurança e cache (CSP própria para /app/*)
├── app/              a interface do motor (cópia gerada de app/ui por build/make_site.py)
├── fonts/            fontes da interface (Poppins, DM Mono; OFL)
└── assets/           CSS, JS e ícone da página de download
```

## Publicar no Cloudflare Pages (ligado ao GitHub)

Assim, cada `git push` na `main` atualiza o site sozinho.

1. Painel do Cloudflare → **Workers & Pages** → **Create** → aba **Pages** → **Connect to Git**.
2. Autorize o GitHub e escolha o repositório **`JefersonCabral/legendapro`**.
3. Configure:

   | Campo | Valor |
   |---|---|
   | Project name | **`legendapro`**. É ele que define o endereço `https://legendapro.pages.dev`, que o motor já aceita. |
   | Production branch | `main` |
   | Framework preset | `None` |
   | Build command | *(vazio)* |
   | Build output directory | **`versao-instalavel/site`** |
   | Root directory (Advanced) | *(vazio)* |

4. Clique em **Save and Deploy**. O site sai em `https://legendapro.pages.dev`, e o app em
   `https://legendapro.pages.dev/app/`.

**Se o Cloudflare der outro endereço** (ex.: `legendapro-abc.pages.dev`, porque o nome estava ocupado), o motor
recusa o site até saber o novo endereço:
1. Coloque o endereço em `SITE_ORIGINS`, em `versao-instalavel/app/legendapro/__init__.py`.
2. Suba a versão em `VERSION`, no mesmo arquivo.
3. Gere uma versão nova do motor (ver abaixo).

**Alternativa sem Git:** **Upload assets** (Direct Upload), arrastando a pasta `versao-instalavel/site`. Pela
linha de comando, na pasta `versao-instalavel`: `npx wrangler pages deploy site --project-name legendapro`.

## Instaladores: versão nova do motor

A Release é criada pelo GitHub Actions (`.github/workflows/motor.yml`). Ele monta e testa os instaladores de
Windows e Mac e anexa tudo quando sai uma **tag**:

```sh
git tag v1.0.0
git push origin v1.0.0
```

Em ~15 minutos aparecem, em `https://github.com/JefersonCabral/legendapro/releases`:
- `LegendaPRO-Setup.exe`;
- `LegendaPRO-portatil.zip`;
- `LegendaPRO-mac-arm64.dmg`;
- `LegendaPRO-mac-x86_64.dmg`.

O `config.js` usa `.../releases/latest/download/<arquivo>`, que sempre entrega a versão mais nova. Para uma versão
nova, basta a tag: o site não muda. Se o tamanho do `.exe` mudar bastante, atualize o `SIZE_MB`.

**Mac:** os `.dmg` já vão para a Release, mas o site mostra "Versão para Mac em breve" enquanto
`DOWNLOAD_URL_MAC` estiver vazio no `config.js`. Depois de testar num Mac, troque pelas linhas indicadas no
próprio arquivo.

## Conferir depois de publicar

- **Página `/`:**
  - o botão "Baixar para Windows" baixa o `.exe` da Release, e não uma página 404;
  - versão e tamanho aparecem embaixo do botão.
- **App `/app/`:**
  - com o motor fechado, aparece a tela "Abra o LegendaPRO no seu computador";
  - com o motor aberto, o navegador pergunta sobre **acesso à rede local** e, depois de **Permitir**, a lista de
    projetos carrega.
- **Cabeçalhos:** `curl -I https://legendapro.pages.dev/app/` deve mostrar a `content-security-policy` com
  `connect-src 'self' http://127.0.0.1:*`.

## Notas

- **CSP:**
  - na página de download, só o próprio site e o Google Fonts;
  - no app, também `http://127.0.0.1:*`, para falar com o motor, e `'unsafe-inline'` só em estilos;
  - **não** coloque `upgrade-insecure-requests` na regra `/app/*`: ela trocaria `http://127.0.0.1` por `https` e
    o motor não seria encontrado.
- **Depois de mudar `app/ui`:** rode `python versao-instalavel/build/make_site.py` para atualizar `site/app/` e
  `site/fonts/`.
- **Depois de mudar `assets/styles.css` ou `assets/script.js`:** suba o `?v=` no `index.html`, porque esses
  arquivos ficam em cache por 1 dia.
- **Avisos de instalação:** sem assinatura paga, o Windows mostra "O Windows protegeu o computador" e o Mac pede
  "Abrir mesmo assim". As perguntas frequentes da página explicam os dois.
- **Arquivos públicos:** o `LEIA-ME.md` também é publicado (`/LEIA-ME.md`). Não tem nada sigiloso.
