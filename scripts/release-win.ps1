param(
  [ValidateSet("patch","minor","major")]
  [string]$Bump = "patch"
)

$ErrorActionPreference = "Stop"

function Require-Cmd($name, $installHint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Não encontrei '$name'. $installHint"
  }
}

function Run($label, [scriptblock]$cmd) {
  Write-Host ">> $label"
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "Falhou: $label (exit $LASTEXITCODE)" }
}

# garante que estamos na raiz do projeto
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Require-Cmd "npm" "Instala Node.js + npm."
Require-Cmd "vercel" "Instala com: npm i -g vercel"

# 1) bump de versão
Run "npm version $Bump" { npm version $Bump --no-git-tag-version | Out-Host }
$version = node -p "require('./package.json').version"
Write-Host "Versão nova: $version"

# 2) build do instalador
Run "npm run build:electron" { npm run build:electron | Out-Host }

# 3) limpar versões antigas no Blob
Run "cleanup blob updates" { node scripts/cleanup-blob-updates.mjs --prefix "updates/win/" --keep 2 | Out-Host }

# 4) publicar no Blob
$dist = "dist_electron"
$latestPath   = Join-Path $dist "latest.yml"
$exeName      = "Ferramenta Setup $version.exe"
$exePath      = Join-Path $dist $exeName
$blockName    = "$exeName.blockmap"
$blockPath    = Join-Path $dist $blockName

if (-not (Test-Path $latestPath)) { throw "Não achei $latestPath" }
if (-not (Test-Path $exePath))    { throw "Não achei $exePath" }
if (-not (Test-Path $blockPath))  { throw "Não achei $blockPath" }

Run "upload latest.yml" {
  vercel blob put $latestPath --pathname "updates/win/latest.yml" --cache-control-max-age 60 --force | Out-Host
}

Run "upload Setup.exe ($version)" {
  vercel blob put $exePath --pathname ("updates/win/" + $exeName) --force | Out-Host
}

Run "upload blockmap ($version)" {
  vercel blob put $blockPath --pathname ("updates/win/" + $blockName) --force | Out-Host
}

Run "upload Latest.exe (link fixo)" {
  vercel blob put $exePath --pathname "updates/win/Ferramenta Setup Latest.exe" --force | Out-Host
}

Run "cleanup blob updates" { node scripts/cleanup-blob-updates.mjs --prefix "updates/win/" --keep 2 | Out-Host }

$baseUrl = "https://xeo22it86oecxkxw.public.blob.vercel-storage.com/updates/win/"
Write-Host ""
Write-Host "✅ Release publicada com sucesso!"
Write-Host "Versão: $version"
Write-Host "Base URL (auto-update): $baseUrl"
Write-Host ("Instalador (link fixo): " + $baseUrl + "Ferramenta%20Setup%20Latest.exe")
