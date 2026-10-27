"""Heurísticas de português para decidir ênfase, cor e agrupamento."""
import re
from .transcript import normalize

STOP = set("""
a o as os um uma uns umas de do da dos das em no na nos nas num numa dum duma por pelo pela
pelos pelas pra pro pras pros para com sem sob sobre ate e ou mas que se como quando onde aonde
porque pq pois ja tambem so mais menos muito muita muitos muitas tao eu tu ele ela nos vos eles
elas voce voces vc me te lhe lhes meu minha meus minhas teu tua teus tuas seu sua seus suas nosso
nossa nossos nossas esse essa esses essas isso este esta estes estas isto aquele aquela aquilo e
foi era ser estar esta estou ta to vai vou vamos ter tem tenho tinha ha ao aos a as ne entao
assim ainda bem la aqui ai cara tipo gente coisa faz fazer fica ficar sei sabe acho todo toda
qual quais quem quer
""".split())

# palavras "função" que formam a linha pequena antes de uma ênfase (a sua *estrutura*)
LEADERS = set("a o as os um uma de do da em no na e os seus suas sua seu meu minha teu tua pra pro para com mais".split())

RED = set("""
nao nada nunca ninguem jamais nenhum nenhuma vermelho culpa desculpa desculpas erro erros errado
errada problema problemas medo perder perdendo perdeu prejuizo fracasso fracassar falha falhar ruim
pior piores dificil dor crise quebrar quebrado falir faliu divida dividas mentira mentiras travado
parado sozinho cuidado perigo golpe pessimo odeio burro burrice preguica desistir desiste
desistiu caro morte morrer fim pare proibido errar
""".split())

IMPACT = set("""
vida tudo todos sempre resultado resultados dinheiro sucesso foco liberdade sonho sonhos valor
cliente clientes crescer cresce mudar muda segredo estrategia verdade poder melhor melhores primeiro
unico unica milhao milhoes mil gratis agora hoje simples rapido facil lucro vendas vender venda
escala escalar tempo futuro marca autoridade posicionamento estrutura comunicacao esforcos
experiencia profissional profissionais mercado realmente exatamente
prioridade direito trampo atencao galho
""".split())

LEAD_ITALIC = set("essa esse isso isto voce tu eu ela ele nos aquilo".split())

PRON_SUBJ = set("eu tu ele ela nos voce voces eles elas".split())

PUNCT_END = re.compile(r"[.!?…]+[\"”]?$")
PUNCT_CLAUSE = re.compile(r"[,;:]$")


def ends_sentence(text):
    return bool(PUNCT_END.search(text))


def ends_clause(text):
    return bool(PUNCT_CLAUSE.search(text)) or ends_sentence(text)


def is_stop(w):
    return normalize(w) in STOP


def is_red(w):
    return normalize(w) in RED


def score(words, i):
    """Pontuação de ênfase da palavra i (maior = mais importante)."""
    w = words[i]
    n = w.norm
    if not n:
        return -9
    s = min(len(n), 11) / 4.0
    if n in STOP:
        s -= 2.6
    if n in IMPACT:
        s += 1.3
    if n in RED and n not in ("nao",):
        s += 2.4
        # negação antes ("não faz nada") reforça
        if any(x.norm == "nao" for x in words[max(0, i - 3):i]):
            s += 1.0
    if re.search(r"(cao|coes|mento|mentos|dade|dades|ismo|ura|ncia|ncias)$", n):
        s += 0.5
    if re.search(r"(ando|endo|indo)$", n) and len(n) > 5:
        s += 0.6
    if n.isdigit():
        s += 1.5
    if ends_clause(w.text):
        s += 0.7
    if ends_sentence(w.text):
        s += 0.4
    # repetição próxima ("galho em galho")
    win = words[max(0, i - 6): i] + words[i + 1: i + 7]
    if n not in STOP and any(x.norm == n for x in win):
        s += 0.9
    # fala mais lenta na palavra = ênfase do locutor
    dur = w.end - w.start
    if len(n) > 0 and dur / max(len(n), 3) > 0.085:
        s += 0.5
    if "emph" in w.flags:
        s += 10
    return s
