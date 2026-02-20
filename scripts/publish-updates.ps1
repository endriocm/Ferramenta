$ErrorActionPreference = "Stop"

$version = node -p "require('./package.json').version"
Write-Host "Versao: $version"

node scripts/publish-updates-aws.mjs --version $version --keep 1
if ($LASTEXITCODE -ne 0) {
  throw "Falha ao publicar updates no AWS S3."
}
