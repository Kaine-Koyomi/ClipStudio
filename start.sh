#!/usr/bin/env bash
# Inicia o Clip Studio (porta 3009 — roda junto com o Faceless Studio, que usa a 3008).
cd "$(dirname "$0")"

node_ok() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; }
NODE=""
for cand in "$(command -v node)" "$HOME"/.nvm/versions/node/v2[4-9]*/bin/node "$HOME"/.asdf/installs/nodejs/2[4-9]*/bin/node "$HOME"/.nvm/versions/node/v22*/bin/node; do
  [ -x "$cand" ] && node_ok "$cand" && { NODE="$cand"; break; }
done
[ -n "$NODE" ] || { echo "Node >= 22.13 não encontrado. Instale com: nvm install 24"; exit 1; }
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"
echo "Usando Node $("$NODE" -v)"

command -v ffmpeg >/dev/null || { echo "Instale o ffmpeg: sudo apt install ffmpeg"; exit 1; }
command -v yt-dlp >/dev/null || { echo "Instale o yt-dlp: pipx install yt-dlp"; exit 1; }
[ -d node_modules/express ] || npm install
exec "$NODE" --disable-warning=ExperimentalWarning src/server.js
