#!/bin/bash
# Ajudante da atualização no Mac (chamado por updater.install, fora do programa).
# 1. espera o motor e o ícone da barra de menu fecharem; 2. guarda o LegendaPRO.app como .anterior;
# 3. copia o app novo do .dmg; 4. abre e confere se responde com a versão nova; 5. se não responder em
# 2 minutos, volta o anterior e marca a versão como "falhou".
# uso: atualizar.sh <pid do motor> <pid do lançador ou 0> <dmg> <caminho do .app> <versão> <log> <marcador>
ENGINE=$1; LAUNCHER=$2; DMG=$3; APPB=$4; VER=$5; LOG=$6; MARKER=$7
OLD="$APPB.anterior"
INSTALLING="$(dirname "$LOG")/instalando"   # criado pelo motor ao sair para atualizar
trap 'rm -f "$INSTALLING"' EXIT
note() { echo "$(date +%H:%M:%S) $*" >> "$LOG.ajudante.txt"; }

find_port() {   # porta (7860–7869) do motor que responde com a versão pedida; pode haver outro aberto
  for p in $(seq 7860 7869); do
    v=$(curl -s -m 2 "http://127.0.0.1:$p/api/status" | sed -n 's/.*"engine": "legendapro", "version": "\([^"]*\)".*/\1/p')
    [ "$v" = "$1" ] && { echo "$p"; return; }
  done
}

start_app() { open -a "$1" "legendapro://atualizado"; }   # pelo link: não abre outra aba

note "atualizando para $VER"
for pid in $ENGINE $LAUNCHER; do
  [ "$pid" != "0" ] && for i in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
done
sleep 1

MNT=$(mktemp -d /tmp/legendapro-dmg.XXXX)
if ! hdiutil attach -nobrowse -readonly -noverify -mountpoint "$MNT" "$DMG" >/dev/null; then
  note "não consegui abrir o .dmg"; touch "$MARKER"; start_app "$APPB"; exit 1
fi
rm -rf "$OLD"
if ! mv "$APPB" "$OLD"; then
  note "não consegui mover o app (está numa pasta sem permissão?)"; hdiutil detach "$MNT" >/dev/null
  touch "$MARKER"; start_app "$APPB"; exit 1
fi
ditto "$MNT/LegendaPRO.app" "$APPB"
hdiutil detach "$MNT" >/dev/null
xattr -dr com.apple.quarantine "$APPB" 2>/dev/null

OK=0
if [ -d "$APPB/Contents/MacOS" ]; then
  start_app "$APPB"
  for i in $(seq 1 60); do
    sleep 2
    [ -n "$(find_port "$VER")" ] && { OK=1; break; }
  done
fi

if [ $OK = 1 ]; then
  note "versão $VER respondendo; apagando a anterior"; rm -rf "$OLD"; exit 0
fi

note "a versão nova não respondeu: voltando a anterior"
touch "$MARKER"
P=$(find_port "$VER")
[ -n "$P" ] && kill $(lsof -ti tcp:"$P" -sTCP:LISTEN) 2>/dev/null
osascript -e 'quit app "LegendaPRO"' 2>/dev/null
sleep 2
rm -rf "$APPB"
mv "$OLD" "$APPB"
start_app "$APPB"
exit 1
