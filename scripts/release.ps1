# Builds a Lumina release and publishes it on GitHub, where Lumina's updater finds it (latest.json).
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1 [-DryRun]
#
# Before: scripts\set-version.ps1 <version>, release notes in src\utils\welcome.ts, everything committed and
# pushed. -DryRun builds and writes everything to release\ but uploads nothing (and skips the git checks).
# Needs the update key (see docs\RELEASING.md) and, to publish, the GitHub CLI signed in (gh auth login).
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$repo = "MaartenVerleyen/Lumina"
$utf8 = New-Object System.Text.UTF8Encoding($false)
Set-Location $root

# 1. One version everywhere
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$others = @{
  "src-tauri\tauri.conf.json"           = (Get-Content src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
  "installer\src-tauri\tauri.conf.json" = (Get-Content installer\src-tauri\tauri.conf.json -Raw | ConvertFrom-Json).version
  "src-tauri\Cargo.toml"                = (Select-String -Path src-tauri\Cargo.toml -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
}
foreach ($file in $others.Keys) {
  if ($others[$file] -ne $version) { throw "$file says $($others[$file]), package.json says $version. Run scripts\set-version.ps1 $version" }
}
Write-Host "Releasing Lumina $version$(if ($DryRun) { ' (dry run)' })"

# 2. Release notes (the same ones the welcome tour shows after the update)
$notes = node --no-warnings -e "import('./src/utils/welcome.ts').then(m => { const r = m.RELEASE_NOTES.find(n => n.version === process.argv[1]); if (!r) process.exit(3); console.log(r.items.map(i => '- **' + i.title + '.** ' + i.text).join('\n')); })" $version
if ($LASTEXITCODE -ne 0) { throw "No release notes for $version in src\utils\welcome.ts (RELEASE_NOTES)" }
$notes = ($notes -join "`n")

# 3. Publish only what is committed and pushed
if (-not $DryRun) {
  if (git status --porcelain) { throw "There are uncommitted changes. Commit them first." }
  git fetch --quiet origin
  if (-not (git branch -r --contains HEAD)) { throw "This commit is not on GitHub yet. Push it first." }
  if (git ls-remote --tags origin "v$version") { throw "Release v$version already exists on GitHub." }
  gh auth status 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The GitHub CLI is not signed in: run gh auth login" }
}

# 4. Update key: the updater only accepts installers signed with it
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { $env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $HOME ".tauri\lumina-updater.key" }
if (-not (Test-Path $env:TAURI_SIGNING_PRIVATE_KEY)) { throw "Update key not found: $($env:TAURI_SIGNING_PRIVATE_KEY) (see docs\RELEASING.md)" }
if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "" }
if (-not $env:LUMINA_SIGN_COMMAND) { Write-Warning "No code-signing certificate configured: Windows will show an 'unknown publisher' warning." }

# 5. Build: the app with its updater files (.sig), then Lumina Setup around it
$override = Join-Path $env:TEMP "lumina-release-config.json"
[IO.File]::WriteAllText($override, '{"bundle":{"createUpdaterArtifacts":true}}', $utf8)
npx tauri build --config $override
if ($LASTEXITCODE -ne 0) { throw "Lumina build failed" }
& "$root\installer\build-setup.ps1" -SkipApp
& "$root\scripts\sign.ps1" "$root\release\Lumina-Setup-$version.exe"

# 6. latest.json for the updater
$nsis = "$root\src-tauri\target\release\bundle\nsis\Lumina_${version}_x64-setup.exe"
if (-not (Test-Path "$nsis.sig")) { throw "No update signature next to $nsis" }
Copy-Item $nsis, "$nsis.sig" "$root\release\" -Force
$asset = Split-Path $nsis -Leaf
$latest = [ordered]@{
  version   = $version
  notes     = $notes
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = (Get-Content "$nsis.sig" -Raw).Trim()
      url       = "https://github.com/$repo/releases/download/v$version/$asset"
    }
  }
}
[IO.File]::WriteAllText("$root\release\latest.json", ($latest | ConvertTo-Json -Depth 5), $utf8)
$notesFile = "$root\release\notes-$version.md"
[IO.File]::WriteAllText($notesFile, "$notes`n`nDownload **Lumina-Setup-$version.exe** to install. Lumina updates itself from here on.`n", $utf8)

$files = @("$root\release\Lumina-Setup-$version.exe", "$root\release\$asset", "$root\release\$asset.sig", "$root\release\latest.json")
if ($DryRun) {
  Write-Host "`nDry run done. Would publish v$version with:"
  $files | ForEach-Object { Write-Host "  $_" }
  exit 0
}

# 7. Publish (latest.json goes up last, so the updater never points at a release that is still uploading)
$sha = git rev-parse HEAD
gh release create "v$version" --repo $repo --target $sha --title "Lumina $version" --notes-file $notesFile $files[0] $files[1] $files[2]
if ($LASTEXITCODE -ne 0) { throw "Creating the GitHub release failed" }
gh release upload "v$version" --repo $repo $files[3]
if ($LASTEXITCODE -ne 0) { throw "Uploading latest.json failed: the release exists but the updater can't see it yet" }
Write-Host "`nPublished: https://github.com/$repo/releases/tag/v$version"
