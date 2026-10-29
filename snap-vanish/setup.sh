#!/usr/bin/env bash
# Downloads the on-device models and runtimes into ./vendor (one time). Usage: bash setup.sh [--no-lama]
set -e
cd "$(dirname "$0")"
LAMA=1; [ "$1" = "--no-lama" ] && LAMA=0
mkdir -p vendor/mediapipe/wasm vendor/models vendor/ort
MP=https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14
ORT=https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist
get() { # url dest [opt]
  if [ -s "$2" ]; then echo "have   $2"; return; fi
  echo "fetch  $2"
  if ! curl -fL --retry 3 -o "$2" "$1"; then
    rm -f "$2"; echo "FAILED $1"; [ "$3" = "opt" ] || exit 1
  fi
}
get $MP/vision_bundle.mjs vendor/mediapipe/vision_bundle.mjs
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  get $MP/wasm/$f vendor/mediapipe/wasm/$f
done
get https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task vendor/models/hand_landmarker.task
get https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite vendor/models/selfie_segmenter.tflite
if [ $LAMA = 1 ]; then
  get $ORT/ort.min.js vendor/ort/ort.min.js
  for f in ort-wasm.wasm ort-wasm-simd.wasm ort-wasm-threaded.wasm ort-wasm-simd-threaded.wasm; do get $ORT/$f vendor/ort/$f opt; done
  get https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx vendor/lama_fp32.onnx
fi
echo "Done. Now load this folder in chrome://extensions (Developer mode > Load unpacked)."
