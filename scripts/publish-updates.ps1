$ErrorActionPreference = "Stop"

$baseUrl  = "https://xeo22it86oecxkxw.public.blob.vercel-storage.com/updates/win/"
$version  = node -p "require('./package.json').version"

$dist     = "dist_electron"
$exe      = "Ferramenta Setup $version.exe"
$blockmap = "$exe.blockmap"

Write-Host "Versao: $version"
Write-Host "Arquivos: $dist\latest.yml | $dist\$exe | $dist\$blockmap"

# 1) latest.yml (cache curto pra atualizar rápido)
vercel blob put "$dist/latest.yml" --pathname "updates/win/latest.yml" --cache-control-max-age 60 --force

# 2) instalador e blockmap da versão
vercel blob put "$dist/$exe" --pathname "updates/win/$exe" --force
vercel blob put "$dist/$blockmap" --pathname "updates/win/$blockmap" --force

# 3) "Latest" (link fixo pra quem vai instalar do zero)
# IMPORTANTE: não coloca %20 aqui; deixa com espaço normal
vercel blob put "$dist/$exe" --pathname "updates/win/Ferramenta Setup Latest.exe" --force

Write-Host ""
Write-Host "Base URL (auto-update): $baseUrl"
Write-Host ("Instalador Latest: " + $baseUrl + "Ferramenta%20Setup%20Latest.exe")
