# Site de download do LegendaPRO

Site estático de uma página (HTML/CSS/JS puro, sem framework, sem build) para hospedar no **Cloudflare Pages**.

```
site/
├── index.html        página única
├── config.js         DOWNLOAD_URL, VERSION, SIZE_MB  ← o único arquivo a editar numa versão nova
├── _headers          cabeçalhos de segurança e cache do Cloudflare Pages
├── LEIA-ME.md        este arquivo
└── assets/
    ├── styles.css
    ├── script.js     aplica o config.js nos botões e anima a legenda de exemplo
    └── favicon.svg
```

O `LEIA-ME.md` também vai junto no upload e fica acessível em `/LEIA-ME.md`. Se não quiser isso, publique uma cópia da pasta sem ele.

## 1. Onde fica o instalador

O Cloudflare Pages aceita no máximo **25 MiB por arquivo**, então o `.exe` **não** vai na pasta do site. Ele fica num bucket **R2** (recomendado) ou no **GitHub Releases**, e o site só aponta para ele.

### Opção A — R2

1. Crie o bucket (uma vez):

   ```sh
   npx wrangler r2 bucket create legendapro-downloads
   ```

2. Suba o instalador (use o nome com a versão, assim um link antigo nunca entrega o arquivo errado):

   ```sh
   npx wrangler r2 object put legendapro-downloads/LegendaPRO-Setup-1.0.0.exe \
     --file ./LegendaPRO-Setup-1.0.0.exe \
     --content-type application/vnd.microsoft.portable-executable \
     --content-disposition "attachment; filename=\"LegendaPRO-Setup-1.0.0.exe\"" \
     --remote
   ```

   - `--remote` é obrigatório no Wrangler 4; sem ele o arquivo vai para o armazenamento local de teste.
   - O `wrangler r2 object put` aceita arquivos de até ~300 MB. Acima disso, use a API S3 do R2 (rclone ou AWS CLI com o endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).

3. Deixe o bucket público por um **domínio próprio**: painel Cloudflare → R2 → `legendapro-downloads` → Settings → Public access → **Custom Domains** → `downloads.seudominio.com`. (O subdomínio `r2.dev` também funciona, mas tem limite de taxa e não é indicado para produção.)

4. O link final fica: `https://downloads.seudominio.com/LegendaPRO-Setup-1.0.0.exe`. Abra no navegador para conferir que o download começa.

### Opção B — GitHub Releases

Crie uma release no repositório, anexe o `.exe` e copie o link do arquivo, no formato
`https://github.com/<usuario>/<repo>/releases/download/v1.0.0/LegendaPRO-Setup-1.0.0.exe`.

## 2. Trocar o link, a versão e o tamanho

Edite só o topo de `config.js`:

```js
const DOWNLOAD_URL = "https://downloads.seudominio.com/LegendaPRO-Setup-1.0.0.exe";
const VERSION = "1.0.0";
const SIZE_MB = 180;   // tamanho do .exe em MB
```

O `script.js` aplica esses valores em todos os botões de download e nos selos de versão/tamanho.
O `index.html` também traz o link placeholder e "v1.0.0 · 180 MB" escritos direto no HTML, só como reserva para quem estiver com JavaScript desligado; se quiser, troque lá também (procure `SEU-DOMINIO`).

O `_headers` manda o navegador revalidar o `config.js` sempre, então a troca vale assim que o site for publicado de novo.
Se mudar `assets/styles.css` ou `assets/script.js`, suba o `?v=1` correspondente no `index.html` (`?v=2`…), porque esses arquivos ficam em cache por 1 dia.

Enquanto o `DOWNLOAD_URL` tiver `SEU-DOMINIO`, o console do navegador mostra um aviso.

## 3. Publicar o site

### (a) Pelo painel do Cloudflare Pages (upload direto)

1. Painel Cloudflare → **Workers & Pages** → **Create** → aba **Pages** → **Upload assets** (Direct Upload).
2. Nome do projeto: `legendapro`.
3. Arraste a pasta `site` (ou um `.zip` com o conteúdo dela) e clique em **Deploy site**.
4. O site sai em `https://legendapro.pages.dev`. Para usar um domínio próprio: projeto → **Custom domains** → **Set up a custom domain**.
5. Para uma versão nova: projeto → **Create deployment** → envie a pasta de novo.

### (b) Pela linha de comando (Wrangler)

Na pasta `versao-instalavel` (a que contém `site/`):

```sh
npx wrangler login                     # uma vez, abre o navegador
npx wrangler pages project create legendapro --production-branch main   # só na primeira vez
npx wrangler pages deploy site --project-name legendapro
```

O `deploy` envia a pasta inteira; o `_headers` é lido automaticamente pelo Pages.

## 4. Conferir depois de publicar

- O botão "Baixar para Windows" baixa o `.exe` do R2/GitHub (e não uma página 404).
- Versão e tamanho aparecem embaixo do botão.
- Cabeçalhos: `curl -I https://legendapro.pages.dev/` deve mostrar `content-security-policy`, `x-content-type-options: nosniff` e `referrer-policy`.
- No celular, a página não rola para os lados.

## Notas

- **CSP**: só scripts e estilos do próprio site, mais o Google Fonts (`fonts.googleapis.com` para o CSS e `fonts.gstatic.com` para as fontes). Não use `style="..."` nem `<script>` inline no HTML: a CSP bloqueia.
- **Fontes**: Poppins para tudo e DM Mono só para rótulos técnicos, ambas OFL, carregadas do Google Fonts. Sem serifada e sem itálico na interface.
- **SmartScreen**: enquanto o instalador não for assinado digitalmente, o Windows mostra "O Windows protegeu o computador". A seção de perguntas do site explica o "Mais informações → Executar assim mesmo". Um certificado de assinatura de código resolve isso de vez.

## O app no navegador (`/app/`)

- `site/app/` é uma **cópia gerada** da interface do motor (`app/ui`). Depois de mudar qualquer coisa em `app/ui`,
  rode `python build/make_site.py` e publique de novo. O script também copia as fontes da interface para
  `site/fonts/`.
- No site, a interface procura o motor do PC em `http://127.0.0.1:7860–7869`. Para isso, a regra `/app/*` do
  `_headers` tem uma CSP própria: libera `http://127.0.0.1:*` em `connect-src`, `img-src` e `media-src`, e **não**
  pode ter `upgrade-insecure-requests`, que trocaria `http://127.0.0.1` por `https`.
- O motor só atende sites conhecidos. O domínio de produção precisa estar em `SITE_ORIGINS`
  (`app/legendapro/__init__.py`) antes de gerar o instalador. O padrão já aceita `https://legendapro.pages.dev` e as
  prévias `https://*.legendapro.pages.dev`. Se o projeto no Pages tiver outro nome, ajuste ali.
