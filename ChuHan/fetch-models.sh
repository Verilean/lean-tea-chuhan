#!/usr/bin/env bash
# Download the diffusers.js SD model into ChuHan/models/ so the server can
# serve it from /models/ (fast localhost load, no slow HF single-stream).
# Idempotent: skips files already present at the right size. Run from the
# repo root:  bash ChuHan/fetch-models.sh
# (Could be wired into `lake build` via a custom target, but a script keeps
#  the ~2.5GB download explicit and out of the build's critical path.)
set -euo pipefail

REPO="aislamov/stable-diffusion-2-1-base-onnx"
BASE="https://huggingface.co/${REPO}/resolve/main"
DIR="ChuHan/models/${REPO}"

# path : expected-size(bytes, 0 = don't check)
FILES=(
  "model_index.json:587"
  "scheduler/scheduler_config.json:341"
  "tokenizer/merges.txt:524619"
  "tokenizer/special_tokens_map.json:460"
  "tokenizer/tokenizer_config.json:737"
  "tokenizer/vocab.json:1059962"
  "text_encoder/model.onnx:681552894"
  "unet/model.onnx:1750977785"
  "vae_encoder/model.onnx:136775805"
  "vae_decoder/model.onnx:2111342"
  "vae_decoder/model.onnx_data:97389312"
)

have() { command -v "$1" >/dev/null 2>&1; }

for entry in "${FILES[@]}"; do
  path="${entry%%:*}"; want="${entry##*:}"
  out="${DIR}/${path}"
  if [[ -f "$out" ]]; then
    got=$(wc -c < "$out" | tr -d ' ')
    if [[ "$want" == "0" || "$got" == "$want" ]]; then echo "ok   $path ($got)"; continue; fi
    echo "re-getting $path (size $got != $want)"
  fi
  mkdir -p "$(dirname "$out")"
  # axel (parallel) for the big weights; curl -L handles HF's signed
  # redirect reliably for the rest (axel 403s on some signed URLs).
  bytes="$want"
  if have axel && [[ "$want" -gt 50000000 ]]; then
    axel -q -n 8 -o "$out" "${BASE}/${path}" || curl -fSL "${BASE}/${path}" -o "$out"
  else
    curl -fSL "${BASE}/${path}" -o "$out"
  fi
  echo "got  $path ($(wc -c < "$out" | tr -d ' '))"
done
echo "done → $DIR"
