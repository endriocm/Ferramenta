param(
  [ValidateSet("patch","minor","major")]
  [string]$Bump = "patch",
  [switch]$SkipBump,
  [switch]$SkipBuild,
  [int]$Keep = 0
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

function Convert-ToPathStyleS3Url([string]$value) {
  $raw = [string]$value
  if ($null -eq $value) { $raw = "" }
  $raw = $raw.Trim()
  if (-not $raw) { return "" }
  if ($raw -notmatch '^\w+://') { $raw = "https://$raw" }

  # Converte virtual-hosted-style para path-style para evitar problemas DNS
  # em alguns ambientes locais.
  if ($raw -match '^https?://([^.]+)\.s3[.-]([a-z0-9-]+)\.amazonaws\.com/?(.*)$') {
    $bucket = [string]$matches[1]
    $region = [string]$matches[2]
    $rest = [string]$matches[3]
    $rest = $rest.Trim('/')
    $combined = if ($rest) { "$bucket/$rest" } else { $bucket }
    return "https://s3.$region.amazonaws.com/$combined/"
  }
  if ($raw -match '^https?://([^.]+)\.s3\.amazonaws\.com/?(.*)$') {
    $bucket = [string]$matches[1]
    $rest = [string]$matches[2]
    $rest = $rest.Trim('/')
    $combined = if ($rest) { "$bucket/$rest" } else { $bucket }
    return "https://s3.amazonaws.com/$combined/"
  }

  try {
    $uri = [Uri]$raw
    $host = [string]$uri.Host
    if (-not $host) { return $raw }

    $hostLower = $host.ToLower()
    $path = [string]$uri.AbsolutePath
    if ($null -eq $path) { $path = "" }
    $path = $path.Trim('/')

    $bucketRegion = [regex]::Match($hostLower, '^([^.]+)\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$')
    if ($bucketRegion.Success) {
      $bucket = [string]$bucketRegion.Groups[1].Value
      $region = [string]$bucketRegion.Groups[2].Value
      $combined = if ($path) { "$bucket/$path" } else { $bucket }
      return "https://s3.$region.amazonaws.com/$combined/"
    }

    $bucketGlobal = [regex]::Match($hostLower, '^([^.]+)\.s3\.amazonaws\.com$')
    if ($bucketGlobal.Success) {
      $bucket = [string]$bucketGlobal.Groups[1].Value
      $combined = if ($path) { "$bucket/$path" } else { $bucket }
      return "https://s3.amazonaws.com/$combined/"
    }
  } catch {
    return $raw
  }

  return $raw
}

function Normalize-BaseUrl([string]$value) {
  $raw = Convert-ToPathStyleS3Url $value
  if (-not $raw) { return "" }
  if ($raw -notmatch '^\w+://') { $raw = "https://$raw" }
  if (-not $raw.EndsWith('/')) { $raw = "$raw/" }
  return $raw
}

function Is-LegacyBlobUrl([string]$value) {
  $normalized = Normalize-BaseUrl $value
  if (-not $normalized) { return $false }
  try {
    $uri = [Uri]$normalized
    if (-not $uri.Host) { return $false }
    return $uri.Host.ToLower().Contains("blob.vercel-storage.com")
  } catch {
    return $false
  }
}

function Sanitize-UpdateBaseUrl([string]$value, [string]$source) {
  $normalized = Normalize-BaseUrl $value
  if (-not $normalized) { return "" }
  if (-not (Is-LegacyBlobUrl $normalized)) { return $normalized }
  Write-Host ">> aviso: URL legado Vercel Blob ignorada em $($source): $normalized"
  return ""
}

function Resolve-UpdateBaseUrl() {
  $fromUpdateBase = Sanitize-UpdateBaseUrl $env:UPDATE_BASE_URL "UPDATE_BASE_URL"
  if ($fromUpdateBase) { return $fromUpdateBase }

  $fromAwsBase = Sanitize-UpdateBaseUrl $env:AWS_UPDATES_BASE_URL "AWS_UPDATES_BASE_URL"
  if ($fromAwsBase) { return $fromAwsBase }

  try {
    $pkg = Get-Content "package.json" -Raw | ConvertFrom-Json
    $publish = $pkg.build.publish

    if ($publish -is [System.Array]) {
      foreach ($item in $publish) {
        $url = Sanitize-UpdateBaseUrl $item.url "package.json build.publish.url"
        if ($url) { return $url }
      }
    } elseif ($publish) {
      $url = Sanitize-UpdateBaseUrl $publish.url "package.json build.publish.url"
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
  if (-not $region) { $region = "sa-east-1" }

  $prefix = [string]$env:AWS_UPDATES_PREFIX
  if ($null -eq $env:AWS_UPDATES_PREFIX) { $prefix = "" }
  $prefix = $prefix.Trim()
  if (-not $prefix) { $prefix = "win" }
  $prefix = $prefix.Trim('/')

  return "https://s3.$region.amazonaws.com/$bucket/$prefix/"
}

function Parse-EnvFile([string]$filePath) {
  $map = @{}
  if (-not (Test-Path $filePath)) { return $map }

  $lines = Get-Content $filePath
  foreach ($line in $lines) {
    $trimmed = [string]$line
    if ($null -eq $trimmed) { continue }
    $trimmed = $trimmed.Trim()
    if (-not $trimmed) { continue }
    if ($trimmed.StartsWith("#")) { continue }

    $idx = $trimmed.IndexOf("=")
    if ($idx -le 0) { continue }

    $key = $trimmed.Substring(0, $idx).Trim()
    $value = $trimmed.Substring($idx + 1).Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    $map[$key] = $value
  }

  return $map
}

function Resolve-AwsProfileFromCredentialsFile() {
  $credentialsPath = Join-Path $env:USERPROFILE ".aws\credentials"
  if (-not (Test-Path $credentialsPath)) { return "" }

  $profiles = @()
  $lines = Get-Content $credentialsPath
  foreach ($line in $lines) {
    $m = [regex]::Match([string]$line, '^\s*\[(.+?)\]\s*$')
    if (-not $m.Success) { continue }
    $name = [string]$m.Groups[1].Value
    if (-not $name) { continue }
    $profiles += $name.Trim()
  }

  if (-not $profiles.Count) { return "" }
  if ($profiles -contains "ferramenta-release") { return "ferramenta-release" }
  if ($profiles -contains "default") { return "default" }
  return [string]$profiles[0]
}

function Initialize-AwsEnvironment() {
  if (-not [string]$env:AWS_SDK_LOAD_CONFIG) {
    $env:AWS_SDK_LOAD_CONFIG = "1"
  }

  $envFilePath = Join-Path (Get-Location) ".env.local"
  $envFile = Parse-EnvFile $envFilePath

  if (-not [string]$env:AWS_PROFILE -and $envFile.ContainsKey("AWS_PROFILE")) {
    $env:AWS_PROFILE = [string]$envFile["AWS_PROFILE"]
  }
  if (-not [string]$env:AWS_REGION -and $envFile.ContainsKey("AWS_REGION")) {
    $env:AWS_REGION = [string]$envFile["AWS_REGION"]
  }
  if (-not [string]$env:AWS_REGION) {
    $env:AWS_REGION = "sa-east-1"
  }

  $hasStaticKey = [string]$env:AWS_ACCESS_KEY_ID -and [string]$env:AWS_SECRET_ACCESS_KEY
  if (-not $hasStaticKey -and -not [string]$env:AWS_PROFILE) {
    $fallbackProfile = Resolve-AwsProfileFromCredentialsFile
    if ($fallbackProfile) {
      $env:AWS_PROFILE = $fallbackProfile
    }
  }

  if ([string]$env:AWS_PROFILE) {
    Write-Host ">> AWS profile em uso: $($env:AWS_PROFILE)"
  }
  Write-Host ">> AWS region em uso: $($env:AWS_REGION)"
}

function Resolve-KeepCount([int]$keepValue) {
  if ($keepValue -gt 0) { return $keepValue }

  $rawEnvKeep = [string]$env:AWS_UPDATES_KEEP
  if ($null -eq $env:AWS_UPDATES_KEEP) { $rawEnvKeep = "" }
  $rawEnvKeep = $rawEnvKeep.Trim()
  if ($rawEnvKeep) {
    $parsedEnvKeep = 0
    if ([int]::TryParse($rawEnvKeep, [ref]$parsedEnvKeep) -and $parsedEnvKeep -gt 0) {
      return $parsedEnvKeep
    }
  }

  # Manter mais versoes aumenta chance de update diferencial via blockmap.
  return 5
}

function Sync-PublishUrl([string]$baseUrl) {
  if (-not $baseUrl) {
    Write-Host ">> aviso: URL de update nao definida em UPDATE_BASE_URL/AWS_UPDATES_BASE_URL/AWS_UPDATES_BUCKET."
    return
  }
  if (Is-LegacyBlobUrl $baseUrl) {
    throw "URL legado do Vercel Blob detectada para auto-update. Configure somente URL AWS S3."
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
Initialize-AwsEnvironment

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
$keepCount = Resolve-KeepCount $Keep
Write-Host ">> politica de retencao: manter $keepCount versoes de instalador/blockmap no S3"
Run "publish updates to AWS S3" {
  node scripts/publish-updates-aws.mjs --version $version --keep $keepCount | Out-Host
}

Write-Host ""
Write-Host "Release publicada com sucesso!"
Write-Host "Versao: $version"
