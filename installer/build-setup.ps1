# Builds Lumina Setup: the app's NSIS installer first, then the setup app that embeds it.
# Output: release\Lumina-Setup-<version>.exe
#   powershell -ExecutionPolicy Bypass -File installer\build-setup.ps1 [-SkipApp]
param([switch]$SkipApp)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content "$root\package.json" -Raw | ConvertFrom-Json).version

if (-not $SkipApp) {
  Write-Host "Building Lumina $version..."
  Push-Location $root
  try { npm run tauri build; if ($LASTEXITCODE -ne 0) { throw "Lumina build failed" } } finally { Pop-Location }
}

$payload = Get-ChildItem "$root\src-tauri\target\release\bundle\nsis\*_${version}_x64-setup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $payload) { throw "No NSIS installer for $version in src-tauri\target\release\bundle\nsis (build without -SkipApp)" }
$env:LUMINA_INSTALLER = $payload.FullName

Write-Host "Building Lumina Setup around $($payload.Name)..."
Push-Location "$root\installer"
try { npx tauri build --no-bundle; if ($LASTEXITCODE -ne 0) { throw "Setup build failed" } } finally { Pop-Location }

New-Item -ItemType Directory -Force "$root\release" | Out-Null
$out = "$root\release\Lumina-Setup-$version.exe"
Copy-Item "$root\installer\src-tauri\target\release\lumina-setup.exe" $out -Force
Write-Host ("Done: {0} ({1:N1} MB)" -f $out, ((Get-Item $out).Length / 1MB))
