# Scales a JPEG to fit LongEdge pixels and keeps its EXIF (date, camera, lens, GPS, orientation): the test
# library's photos stay realistic at a fraction of the size. -StripExif writes it without any metadata.
#   powershell -File resize-keep-exif.ps1 <source> <target> [LongEdge] [-StripExif]
param(
  [Parameter(Mandatory)][string]$Source,
  [Parameter(Mandatory)][string]$Target,
  [int]$LongEdge = 2560,
  [switch]$StripExif
)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($Source)
try {
  $scale = [Math]::Min(1.0, $LongEdge / [Math]::Max($src.Width, $src.Height))
  $w = [int][Math]::Round($src.Width * $scale)
  $h = [int][Math]::Round($src.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $w, $h)
  $g.Dispose()
  if (-not $StripExif) {
    foreach ($item in $src.PropertyItems) {
      # Size tags are written for the new size; the embedded thumbnail is left out
      if ($item.Id -in 0xA002, 0xA003, 0x0100, 0x0101, 0x501B, 0x5090, 0x5091) { continue }
      try { $bmp.SetPropertyItem($item) } catch {}
    }
  }
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 88L
  New-Item -ItemType Directory -Force (Split-Path $Target) | Out-Null
  $bmp.Save($Target, $codec, $params)
  $bmp.Dispose()
} finally {
  $src.Dispose()
}
