param(
  [ValidateSet("patch","minor","major")]
  [string]$Bump = "patch",
  [switch]$SkipBump,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Require-Cmd($name, $installHint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "Nao encontrei '$name'. $installHint"
  }
}

function Run($label, [scriptblock]$cmd) {
  Write-Host ">> $label"
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "Falhou: $label (exit $LASTEXITCODE)" }
}

function Normalize-BaseUrl([string]$value) {
  $raw = [string]$value
  if ($null -eq $value) { $raw = "" }
  $raw = $raw.Trim()
  if (-not $raw) { return "" }
  if ($raw -notmatch '^\w+://') { $raw = "https://$raw" }
  if (-not $raw.EndsWith('/')) { $raw = "$raw/" }
  return $raw
}

function Resolve-UpdateBaseUrl() {
  $fromUpdateBase = Normalize-BaseUrl $env:UPDATE_BASE_URL
  if ($fromUpdateBase) { return $fromUpdateBase }

  $fromAwsBase = Normalize-BaseUrl $env:AWS_UPDATES_BASE_URL
  if ($fromAwsBase) { return $fromAwsBase }

  try {
    $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
    $publish = $pkg.build.publish

    if ($publish -is [System.Array]) {
      foreach ($item in $publish) {
        $url = Normalize-BaseUrl $item.url
        if ($url) { return $url }
      }
    } elseif ($publish) {
      $url = Normalize-BaseUrl $publish.url
      if ($url) { return $url }
    }
  } catch {
    # noop
  }

  $bucket = [string]$env:AWS_UPDATES_BUCKET
  if ($null -eq $env:AWS_UPDATES_BUCKET) { $bucket = "" }
  $bucket = $bucket.Trim()
  if (-not $bucket) { return "" }

  $region = [string]$env:AWS_REGION
  if ($null -eq $env:AWS_REGION) { $region = "" }
  $region = $region.Trim()
  if (-not $region) { $region = "us-east-1" }

  $prefix = [string]$env:AWS_UPDATES_PREFIX
  if ($null -eq $env:AWS_UPDATES_PREFIX) { $prefix = "" }
  $prefix = $prefix.Trim()
  if (-not $prefix) { $prefix = "win" }
  $prefix = $prefix.Trim('/')

  return "https://$bucket.s3.$region.amazonaws.com/$prefix/"
}

function Sync-PublishUrl([string]$baseUrl) {
  if (-not $baseUrl) {
    Write-Host ">> aviso: URL de update nao definida em UPDATE_BASE_URL/AWS_UPDATES_BASE_URL/AWS_UPDATES_BUCKET."
    return
  }

  try {
    $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
    if (-not $pkg.build) {
      $pkg | Add-Member -NotePropertyName "build" -NotePropertyValue ([PSCustomObject]@{})
    }

    $pkg.build.publish = @(
      [PSCustomObject]@{
        provider = "generic"
        url = $baseUrl
      }
    )

    $json = $pkg | ConvertTo-Json -Depth 100
    Set-Content "package.json" ($json + "`n")
  } catch {
    throw "Falhou ao sincronizar build.publish.url no package.json."
  }

  Write-Host ">> build.publish.url sincronizada para: $baseUrl"
}

# garante que estamos na raiz do projeto
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Require-Cmd "npm" "Instala Node.js + npm."
Require-Cmd "node" "Instala Node.js."

# 1) bump de versao
if ($SkipBump) {
  $version = node -p "require('./package.json').version"
  Write-Host "Versao atual (sem bump): $version"
} else {
  Run "npm version $Bump" { npm version $Bump --no-git-tag-version | Out-Host }
  $version = node -p "require('./package.json').version"
  Write-Host "Versao nova: $version"
}

# 2) build do instalador
Sync-PublishUrl (Resolve-UpdateBaseUrl)

if ($SkipBuild) {
  Write-Host ">> pulando build:electron (--SkipBuild)"
} else {
  Run "npm run build:electron" { npm run build:electron | Out-Host }
}

# 3) publicar no AWS S3
Run "publish updates to AWS S3" {
  node scripts/publish-updates-aws.mjs --version $version --keep 1 | Out-Host
}

Write-Host ""
Write-Host "Release publicada com sucesso!"
Write-Host "Versao: $version"
