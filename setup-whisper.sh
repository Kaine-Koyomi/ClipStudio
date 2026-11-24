#!/usr/bin/env bash
# Instala o faster-whisper num ambiente isolado (.whisper-venv). Só é necessário para vídeos
# SEM legenda no YouTube — a maioria tem legenda automática e não precisa disto.
set -e
cd "$(dirname "$0")"
if command -v uv >/dev/null; then
  uv venv --python 3.11 .whisper-venv
  uv pip install --python .whisper-venv/bin/python faster-whisper
else
  python3 -m venv .whisper-venv
  .whisper-venv/bin/pip install --upgrade pip faster-whisper
fi
echo "Pronto. O modelo do Whisper (~500 MB no 'small') é baixado na primeira transcrição."
