# Code-signs one file: Lumina.exe, its installer and Lumina Setup. Called by Tauri (bundle.windows.signCommand)
# and by scripts\release.ps1. Until a certificate is set up it only warns: see docs\RELEASING.md.
#
#   $env:LUMINA_SIGN_COMMAND = 'signtool sign /fd sha256 /tr http://time.certum.pl /td sha256 /sha1 <THUMBPRINT> {file}'
#
# {file} is replaced by the quoted full path of the file to sign.
param([Parameter(Mandatory = $true)][string]$File)

$template = $env:LUMINA_SIGN_COMMAND
if (-not $template) {
  Write-Warning "Not code-signed (LUMINA_SIGN_COMMAND is not set): $File"
  exit 0
}

$full = (Resolve-Path -LiteralPath $File).Path
$line = $template.Replace("{file}", "`"$full`"")
Write-Host "Signing $full"
cmd /c $line
if ($LASTEXITCODE -ne 0) {
  Write-Error "Signing failed (exit code $LASTEXITCODE): $File"
  exit $LASTEXITCODE
}
