#!/bin/sh
# Installs onnx-say, the narrator's ONNX voice: it and speak.py, with sherpa-onnx in a Python venv of
# their own, in NARRATOR_ONNX_HOME (~/.local/share/narrator-onnx by default), a folder a plugin update
# leaves alone. It downloads no model: see the README for where to find one.
set -eu

# 1.13.8, the last sherpa-onnx with espeak-ng inside: 2.0 left it out, and without it the Piper,
# Kokoro, Kitten and Matcha models it reads text with turn no text into speech.
SHERPA_ONNX=1.13.8

from=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
home=${NARRATOR_ONNX_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/narrator-onnx}

if ! command -v python3 >/dev/null 2>&1; then
  echo 'install.sh: onnx-say needs python3' >&2
  exit 1
fi

mkdir -p "$home"
python3 -m venv "$home/venv"
"$home/venv/bin/python" -m pip install --quiet --disable-pip-version-check "sherpa-onnx==$SHERPA_ONNX"
cp "$from/onnx-say" "$from/speak.py" "$home/"
chmod +x "$home/onnx-say"

echo "Installed. Set the narrator's Speak command, in /config, to:"
echo "  $home/onnx-say <model folder>"
