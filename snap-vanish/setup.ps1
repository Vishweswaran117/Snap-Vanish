# Downloads the on-device models and runtimes into .\vendor (one time).
# Usage:  powershell -ExecutionPolicy Bypass -File setup.ps1 [-NoLama]
param([switch]$NoLama)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force vendor\mediapipe\wasm, vendor\models, vendor\ort | Out-Null
$MP  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14'
$ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist'
function Get-File($url, $dest, $optional = $false) {
  if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { Write-Host "have   $dest"; return }
  Write-Host "fetch  $dest"
  try { Invoke-WebRequest -Uri $url -OutFile $dest }
  catch { Remove-Item $dest -ErrorAction SilentlyContinue; Write-Host "FAILED $url"; if (-not $optional) { throw } }
}
Get-File "$MP/vision_bundle.mjs" 'vendor\mediapipe\vision_bundle.mjs'
foreach ($f in 'vision_wasm_internal.js','vision_wasm_internal.wasm','vision_wasm_nosimd_internal.js','vision_wasm_nosimd_internal.wasm') { Get-File "$MP/wasm/$f" "vendor\mediapipe\wasm\$f" }
Get-File 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task' 'vendor\models\hand_landmarker.task'
Get-File 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite' 'vendor\models\selfie_segmenter.tflite'
if (-not $NoLama) {
  Get-File "$ORT/ort.min.js" 'vendor\ort\ort.min.js'
  foreach ($f in 'ort-wasm.wasm','ort-wasm-simd.wasm','ort-wasm-threaded.wasm','ort-wasm-simd-threaded.wasm') { Get-File "$ORT/$f" "vendor\ort\$f" $true }
  Get-File 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx' 'vendor\lama_fp32.onnx'
}
Write-Host 'Done. Now load this folder in chrome://extensions (Developer mode > Load unpacked).'
