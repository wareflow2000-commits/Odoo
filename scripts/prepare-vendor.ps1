$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$fontCss = Join-Path $root 'vendor/fontawesome/css'
$fontDir = Join-Path $root 'vendor/fontawesome/webfonts'
$sqlDir = Join-Path $root 'vendor'

New-Item -ItemType Directory -Force -Path $fontCss, $fontDir, $sqlDir | Out-Null

$downloads = @(
  @{ Url = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'; Path = (Join-Path $fontCss 'all.min.css') },
  @{ Url = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-brands-400.woff2'; Path = (Join-Path $fontDir 'fa-brands-400.woff2') },
  @{ Url = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-regular-400.woff2'; Path = (Join-Path $fontDir 'fa-regular-400.woff2') },
  @{ Url = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2'; Path = (Join-Path $fontDir 'fa-solid-900.woff2') },
  @{ Url = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-v4compatibility.woff2'; Path = (Join-Path $fontDir 'fa-v4compatibility.woff2') },
  @{ Url = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.js'; Path = (Join-Path $sqlDir 'sql-wasm.js') },
  @{ Url = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.wasm'; Path = (Join-Path $sqlDir 'sql-wasm.wasm') }
)

foreach ($item in $downloads) {
  Write-Host ('Downloading ' + $item.Url)
  Invoke-WebRequest -Uri $item.Url -OutFile $item.Path -UseBasicParsing
  if (!(Test-Path $item.Path) -or (Get-Item $item.Path).Length -lt 100) {
    throw ('Download validation failed: ' + $item.Path)
  }
}
Write-Host 'Vendor assets downloaded and validated.'
