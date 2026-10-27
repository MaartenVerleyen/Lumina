# Sets Lumina's version everywhere it is written down (app, Rust crate, setup app, npm package).
#   powershell -ExecutionPolicy Bypass -File scripts\set-version.ps1 3.7.0
# Then add a release-notes entry for it in src\utils\welcome.ts and commit.
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = "Stop"
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Use a version like 3.7.0" }
$root = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Set-JsonVersion([string]$path) {
  $text = [IO.File]::ReadAllText($path)
  # Only the first "version" (the top-level one); the rest of the file is left exactly as it is
  $regex = New-Object System.Text.RegularExpressions.Regex('"version":\s*"[^"]*"')
  [IO.File]::WriteAllText($path, $regex.Replace($text, "`"version`": `"$Version`"", 1), $utf8)
}

function Set-CargoVersion([string]$path) {
  $text = [IO.File]::ReadAllText($path)
  $regex = New-Object System.Text.RegularExpressions.Regex('(?m)^version = "[^"]*"')
  [IO.File]::WriteAllText($path, $regex.Replace($text, "version = `"$Version`"", 1), $utf8)
}

Set-JsonVersion "$root\package.json"
Set-JsonVersion "$root\src-tauri\tauri.conf.json"
Set-JsonVersion "$root\installer\src-tauri\tauri.conf.json"
Set-CargoVersion "$root\src-tauri\Cargo.toml"
Set-CargoVersion "$root\installer\src-tauri\Cargo.toml"
# package-lock.json and Cargo.lock follow on the next npm install / cargo build
Push-Location $root
try { npm install --package-lock-only --silent | Out-Null } finally { Pop-Location }

Write-Host "Version set to $Version."
if (-not (Select-String -Path "$root\src\utils\welcome.ts" -Pattern "version: `"$Version`"" -Quiet)) {
  Write-Host "Next: add the release notes for $Version to src\utils\welcome.ts (RELEASE_NOTES)."
}
