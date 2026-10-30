"""LegendaPRO: motor de legendas dinâmicas."""

VERSION = "1.2.0"
API = 2      # sobe quando a interface do site precisa de algo novo do motor (2: vários estilos, {estilo:id})

# Sites que podem usar este motor pelo navegador (a interface hospedada no Cloudflare Pages).
# Os vídeos nunca vão para o site: o navegador manda direto para o motor, em 127.0.0.1.
# Para acrescentar o seu domínio sem mudar o código: variável LEGENDAPRO_ORIGINS (separada por vírgula)
# ou o arquivo origens.txt na pasta de dados (um endereço por linha).
SITE_ORIGINS = [
    "https://legendapro.pages.dev",
]
# prévias de deploy do Cloudflare Pages (https://<hash>.legendapro.pages.dev)
SITE_ORIGIN_SUFFIXES = [".legendapro.pages.dev"]
