#!/usr/bin/env bash
# Instala o reconhecimento de voz (cor da legenda por falante) num ambiente isolado (.speaker-venv).
# Não é necessário se o Faceless Studio estiver em ../faceless-studio com o motor de animação instalado:
# nesse caso o app reaproveita o .anim-venv de lá.
set -e
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo "Instale o uv: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
uv venv --python 3.11 .speaker-venv
uv pip install --python .speaker-venv/bin/python --index-url https://download.pytorch.org/whl/cpu torch
uv pip install --python .speaker-venv/bin/python transformers soundfile numpy
echo "Pronto. O modelo de voz (~380 MB) é baixado no primeiro uso."
