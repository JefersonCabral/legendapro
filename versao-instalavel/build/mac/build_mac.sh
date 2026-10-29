#!/bin/bash
# Monta o LegendaPRO.app e o .dmg num Mac (roda no GitHub Actions; ver .github/workflows/mac.yml).
#   bash versao-instalavel/build/mac/build_mac.sh arm64 1.0.0      (chip Apple)
#   bash versao-instalavel/build/mac/build_mac.sh x86_64 1.0.0     (Mac Intel)
# Saída: versao-instalavel/dist-mac/LegendaPRO.app e LegendaPRO-mac-<arch>.dmg
#
# Sem conta de desenvolvedor Apple, o app recebe assinatura "ad hoc" (o chip Apple exige alguma assinatura):
# na primeira vez a pessoa libera em Ajustes > Privacidade e Segurança > Abrir mesmo assim. Com a conta,
# defina APPLE_SIGN_ID (ex.: "Developer ID Application: Nome (TEAMID)"), APPLE_ID, APPLE_TEAM_ID e
# APPLE_APP_PASSWORD: o script assina de verdade e envia para a notarização (sem aviso nenhum).
set -euo pipefail

ARCH="${1:-arm64}"
VERSION="${2:-1.0.0}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"                 # versao-instalavel/
OUT="$ROOT/dist-mac"
CACHE="$ROOT/build/cache-mac"
APPB="$OUT/LegendaPRO.app"
RES="$APPB/Contents/Resources"

# versões fixas (python-build-standalone e ffmpeg estático com VideoToolbox + x264)
PY_TAG="20261020"
PY_VER="3.12.15"
if [ "$ARCH" = "arm64" ]; then
  PY_TRIPLE="aarch64-apple-darwin"
  FF_BASE="https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2"
else
  PY_TRIPLE="x86_64-apple-darwin"
  FF_BASE="https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2"
fi
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_TAG}/cpython-${PY_VER}+${PY_TAG}-${PY_TRIPLE}-install_only.tar.gz"

step() { printf '\n==> %s\n' "$*"; }
fetch() {   # fetch <url> <arquivo no cache>
  [ -f "$CACHE/$2" ] || { echo "    baixando $1"; curl -fL --retry 3 -o "$CACHE/$2.part" "$1"; mv "$CACHE/$2.part" "$CACHE/$2"; }
}

mkdir -p "$CACHE"
rm -rf "$OUT"
mkdir -p "$APPB/Contents/MacOS" "$RES"

step "Python $PY_VER ($PY_TRIPLE)"
fetch "$PY_URL" "python-$PY_TRIPLE.tar.gz"
tar -xzf "$CACHE/python-$PY_TRIPLE.tar.gz" -C "$RES"          # cria Resources/python
PY="$RES/python/bin/python3"
"$PY" --version

step "Dependências (requirements-$ARCH.txt)"
"$PY" -m pip install --no-cache-dir --disable-pip-version-check -r "$HERE/requirements-$ARCH.txt"
"$PY" -m pip uninstall -y pip >/dev/null 2>&1 || true            # o app não instala nada depois (sem CUDA no Mac)

step "Código do motor e lançador"
rsync -a --exclude '__pycache__' "$ROOT/app/" "$RES/app/"
cp "$HERE/launcher.py" "$RES/launcher.py"

step "ffmpeg / ffprobe"
mkdir -p "$RES/app/bin"
for b in ffmpeg ffprobe; do
  fetch "$FF_BASE/$b.zip" "$b-$ARCH.zip"
  unzip -o -q "$CACHE/$b-$ARCH.zip" -d "$RES/app/bin"
  chmod +x "$RES/app/bin/$b"
done
xattr -cr "$RES/app/bin" || true
ENC="$("$RES/app/bin/ffmpeg" -hide_banner -encoders)"
for e in h264_videotoolbox libx264 prores_ks aac; do
  echo "$ENC" | grep -q " $e " || { echo "ffmpeg sem o encoder $e"; exit 1; }
done
echo "    encoders ok: h264_videotoolbox libx264 prores_ks aac"

step "Executável, Info.plist e ícone"
cat > "$APPB/Contents/MacOS/LegendaPRO" <<'EOF'
#!/bin/bash
# executável do LegendaPRO.app: o Python embutido roda o lançador da barra de menu
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
export PYTHONNOUSERSITE=1 PYTHONUTF8=1 PYTHONDONTWRITEBYTECODE=1
exec "$RES/python/bin/python3" "$RES/launcher.py" "$@"
EOF
chmod +x "$APPB/Contents/MacOS/LegendaPRO"
sed "s/__VERSION__/$VERSION/g" "$HERE/Info.plist" > "$APPB/Contents/Info.plist"
"$PY" "$ROOT/build/make_icon.py" "$RES/app/fonts/Poppins-SemiBold.ttf" "$RES/LegendaPRO.icns"

step "Pré-compila o código (abre mais rápido)"
"$PY" -m compileall -q "$RES/app/legendapro" "$RES/launcher.py" || true

step "Conferência do Python do app"
(cd "$RES/app" && "$PY" -c "
import legendapro.server, faster_whisper, cv2, onnxruntime as ort
print('    onnxruntime', ort.__version__, ort.get_available_providers())
try:
    import mlx_whisper, mlx.core as mx; print('    mlx-whisper ok, mlx', mx.__version__)
except Exception as e: print('    sem mlx (esperado no Mac Intel):', e)
import rumps; print('    rumps ok')
")

step "Assinatura"
if [ -n "${APPLE_SIGN_ID:-}" ]; then
  codesign --force --deep --options runtime --timestamp --sign "$APPLE_SIGN_ID" "$APPB"
else
  codesign --force --deep --sign - "$APPB"          # ad hoc: sem conta de desenvolvedor
fi
codesign --verify --deep --strict "$APPB" && echo "    assinatura ok"

step "DMG"
STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APPB" "$STAGE/"
ln -s /Applications "$STAGE/Aplicativos"
cat > "$STAGE/Primeira vez - leia.txt" <<'EOF'
LegendaPRO para Mac

1. Arraste o LegendaPRO para a pasta Aplicativos.
2. Abra o LegendaPRO pelo Launchpad ou pela pasta Aplicativos.
3. Se o Mac disser que não pode abrir porque o desenvolvedor não foi verificado:
   abra Ajustes do Sistema > Privacidade e Segurança, role até o fim e clique em "Abrir mesmo assim".
   Isso só é pedido na primeira vez.
4. O LegendaPRO fica como "LP" na barra de menu (lá em cima, à direita). Por ele você abre a tela,
   a pasta dos projetos ou sai do programa.
EOF
DMG="$OUT/LegendaPRO-mac-$ARCH.dmg"
hdiutil create -volname "LegendaPRO" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
if [ -n "${APPLE_SIGN_ID:-}" ] && [ -n "${APPLE_ID:-}" ]; then
  codesign --force --sign "$APPLE_SIGN_ID" "$DMG"
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$DMG"
fi
du -sh "$APPB" "$DMG"
echo "Pronto: $DMG"
