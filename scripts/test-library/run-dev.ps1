# Starts the development build of Lumina on the test library, with its own database and caches in
# C:\LuminaTest\AppData (your real library and settings are not touched). Build the library first:
#   python scripts\test-library\build_test_library.py build
# The AI models are copied from your normal install when they are there, so nothing has to download.
param([string]$Root = "C:\LuminaTest")

$data = Join-Path $Root "AppData"
$models = Join-Path $data "models"
$installed = Join-Path $env:LOCALAPPDATA "com.amazhr.lumina\models"
if (-not (Test-Path $models) -and (Test-Path $installed)) {
  New-Item -ItemType Directory -Force $models | Out-Null
  Copy-Item "$installed\*" $models -Recurse
}
$env:LUMINA_DATA_DIR = $data
Write-Host "Lumina (dev) on $data - open $(Join-Path $Root 'Library') in the app the first time"
Set-Location (Join-Path $PSScriptRoot "..\..")
npm run tauri dev
