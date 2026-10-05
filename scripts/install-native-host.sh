#!/usr/bin/env bash
# Instala el host nativo `studio.ghosty.browser` para que la terminal (browser-mcp.mjs) le hable a
# la extensión Ghosty sin pasar por gs. Escribe el JSON en NativeMessagingHosts de Chrome (y de
# Chrome for Testing). Uso: ./scripts/install-native-host.sh [extension-id …] [--dir <carpeta extra>]
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
NODE=$(command -v node)
IDS=()
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) EXTRA+=("$2"); shift 2 ;;
    *) IDS+=("$1"); shift ;;
  esac
done
# Por defecto: el id fijo de desarrollo (la `key` de ext/manifest.json) y el de la tienda. Sólo esos
# ids (allowed_origins) pueden arrancar el host; el socket exige el token de ~/.ghosty/browser.token.
[ ${#IDS[@]} -eq 0 ] && IDS=(okgofgcccjajcokgpjmdlpgjpjoibpca hdbaopibfnjadmhebocfjdebelgbgmkb)
# Chrome lanza el host con un PATH mínimo: un wrapper con la ruta absoluta de node.
WRAP="$HOME/.ghosty/ghosty-native-host"
mkdir -p "$HOME/.ghosty"
printf '#!/bin/sh\nexec "%s" "%s/native-host/ghosty-native-host.mjs" "$@"\n' "$NODE" "$ROOT" > "$WRAP"
chmod 755 "$WRAP"
ORIGINS=$(printf '"chrome-extension://%s/",' "${IDS[@]}"); ORIGINS="[${ORIGINS%,}]"
JSON="{\"name\":\"studio.ghosty.browser\",\"description\":\"Ghosty: puente entre la terminal y la extensión\",\"path\":\"$WRAP\",\"type\":\"stdio\",\"allowed_origins\":$ORIGINS}"
DIRS=("$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" "$HOME/Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts" "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ${EXTRA[@]+"${EXTRA[@]}"})
for d in "${DIRS[@]}"; do
  mkdir -p "$d"
  printf '%s\n' "$JSON" > "$d/studio.ghosty.browser.json"
  echo "✓ $d/studio.ghosty.browser.json"
done
echo "Host: $WRAP  ·  extensiones: ${IDS[*]}"
