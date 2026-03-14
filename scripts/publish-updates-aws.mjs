import fs from 'node:fs'
import path from 'node:path'
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

const DEFAULT_PREFIX = 'win'
const DEFAULT_KEEP = 1
const DEFAULT_DIST = 'dist_electron'
const DEFAULT_REGION = 'sa-east-1'
const LATEST_FILE_NAME = 'latest.yml'
const LATEST_INSTALLER_NAME = 'Ferramenta Setup Latest.exe'
const MAX_LIST_LIMIT = 1000

const parseArgs = (argv) => {
  const args = {
    keep: DEFAULT_KEEP,
    dist: DEFAULT_DIST,
    dryRun: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]

    if (arg === '--version') {
      args.version = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--version=')) {
      args.version = arg.split('=').slice(1).join('=')
      continue
    }

    if (arg === '--region') {
      args.region = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--region=')) {
      args.region = arg.split('=').slice(1).join('=')
      continue
    }

    if (arg === '--bucket') {
      args.bucket = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--bucket=')) {
      args.bucket = arg.split('=').slice(1).join('=')
      continue
    }

    if (arg === '--prefix') {
      args.prefix = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--prefix=')) {
      args.prefix = arg.split('=').slice(1).join('=')
      continue
    }

    if (arg === '--base-url') {
      args.baseUrl = argv[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--base-url=')) {
      args.baseUrl = arg.split('=').slice(1).join('=')
      continue
    }

    if (arg === '--keep') {
      const keep = Number(argv[i + 1])
      if (Number.isFinite(keep) && keep > 0) args.keep = Math.floor(keep)
      i += 1
      continue
    }
    if (arg.startsWith('--keep=')) {
      const keep = Number(arg.split('=').slice(1).join('='))
      if (Number.isFinite(keep) && keep > 0) args.keep = Math.floor(keep)
      continue
    }

    if (arg === '--dist') {
      args.dist = argv[i + 1] || DEFAULT_DIST
      i += 1
      continue
    }
    if (arg.startsWith('--dist=')) {
      args.dist = arg.split('=').slice(1).join('=') || DEFAULT_DIST
      continue
    }

    if (arg === '--dry-run') {
      args.dryRun = true
    }
  }

  return args
}

const parseEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return {}
  const content = fs.readFileSync(filePath, 'utf-8')
  const env = {}

  content.split(/\r?\n/).forEach((line) => {
    const trimmed = String(line || '').trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const idx = trimmed.indexOf('=')
    if (idx <= 0) return

    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  })

  return env
}

const normalizePrefix = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return DEFAULT_PREFIX
  return raw.replace(/^\/+|\/+$/g, '')
}

const normalizeBucket = (value) => String(value || '').trim()

const normalizeRegion = (value) => String(value || '').trim() || DEFAULT_REGION

const normalizeEndpointUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return ''
  }
}

const resolveS3ApiEndpoint = (region) => {
  const fromEnv = normalizeEndpointUrl(process.env.AWS_S3_ENDPOINT || process.env.S3_ENDPOINT)
  if (fromEnv) return fromEnv
  return `https://s3.dualstack.${region}.amazonaws.com`
}

const toPathStyleS3Url = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  let parsed = null
  try {
    parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return raw
  }

  const host = String(parsed.hostname || '').toLowerCase()
  const pathParts = String(parsed.pathname || '').split('/').filter(Boolean)

  const bucketRegionMatch = host.match(/^([^.]+)\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/)
  if (bucketRegionMatch) {
    const bucket = bucketRegionMatch[1]
    const region = bucketRegionMatch[2]
    const prefix = pathParts.join('/')
    const nextPath = [bucket, prefix].filter(Boolean).join('/')
    return `https://s3.${region}.amazonaws.com/${nextPath}/`
  }

  const bucketGlobalMatch = host.match(/^([^.]+)\.s3\.amazonaws\.com$/)
  if (bucketGlobalMatch) {
    const bucket = bucketGlobalMatch[1]
    const prefix = pathParts.join('/')
    const nextPath = [bucket, prefix].filter(Boolean).join('/')
    return `https://s3.amazonaws.com/${nextPath}/`
  }

  return parsed.toString()
}

const buildPathStyleBaseUrl = (bucket, region, prefix) => {
  if (!bucket) return ''
  const normalizedPrefix = normalizePrefix(prefix)
  return `https://s3.${region}.amazonaws.com/${bucket}/${normalizedPrefix}/`
}

const normalizeBaseUrl = (value, bucket, region, prefix) => {
  const raw = String(value || '').trim()
  if (raw) {
    const pathStyle = toPathStyleS3Url(raw)
    const withProtocol = pathStyle.includes('://') ? pathStyle : `https://${pathStyle}`
    return withProtocol.replace(/\/+$/, '') + '/'
  }

  if (!bucket) return ''
  return buildPathStyleBaseUrl(bucket, region, prefix)
}

const isLegacyBlobUrl = (value) => {
  const normalized = normalizeBaseUrl(value, '', DEFAULT_REGION, DEFAULT_PREFIX)
  if (!normalized) return false
  try {
    const parsed = new URL(normalized)
    const host = String(parsed.hostname || '').toLowerCase()
    return host.includes('blob.vercel-storage.com')
  } catch {
    return false
  }
}

const pickFirstSupportedBaseUrl = (candidates) => {
  for (const candidate of candidates) {
    const normalized = normalizeBaseUrl(candidate, '', DEFAULT_REGION, DEFAULT_PREFIX)
    if (!normalized) continue
    if (isLegacyBlobUrl(normalized)) {
      console.warn(`Ignorando URL legado do Vercel Blob: ${normalized}`)
      continue
    }
    return normalized
  }
  return ''
}

const joinStoragePath = (...segments) => {
  return segments
    .map((segment) => String(segment || '').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

const encodePathForUrl = (value) => {
  return String(value || '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

const parseSemver = (value) => {
  const parts = String(value || '').split('.').map((part) => Number(part))
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null
  return parts
}

const compareSemverDesc = (a, b) => {
  const aParts = parseSemver(a)
  const bParts = parseSemver(b)
  if (!aParts || !bParts) return 0

  for (let i = 0; i < 3; i += 1) {
    if (aParts[i] !== bParts[i]) return bParts[i] - aParts[i]
  }
  return 0
}

const getPackageVersion = () => {
  const pkgPath = path.resolve(process.cwd(), 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  return String(pkg?.version || '').trim()
}

const getPackagePublishBaseUrl = () => {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const publish = pkg?.build?.publish

    if (Array.isArray(publish)) {
      const entry = publish.find((item) => item?.provider === 'generic' && item?.url) ||
        publish.find((item) => item?.url)
      return normalizeBaseUrl(entry?.url || '', '', DEFAULT_REGION, DEFAULT_PREFIX)
    }

    if (publish?.url) {
      return normalizeBaseUrl(publish.url, '', DEFAULT_REGION, DEFAULT_PREFIX)
    }
  } catch {
    // noop
  }

  return ''
}

const parseS3BaseUrl = (baseUrl) => {
  const normalized = normalizeBaseUrl(baseUrl, '', DEFAULT_REGION, DEFAULT_PREFIX)
  if (!normalized) return null

  try {
    const parsed = new URL(normalized)
    const host = String(parsed.hostname || '').toLowerCase()
    const pathParts = String(parsed.pathname || '')
      .split('/')
      .filter(Boolean)

    let bucket = ''
    let region = ''
    let prefix = ''

    let match = host.match(/^([^.]+)\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/)
    if (match) {
      bucket = match[1]
      region = match[2]
      prefix = pathParts.join('/')
      return { bucket, region, prefix }
    }

    match = host.match(/^([^.]+)\.s3\.amazonaws\.com$/)
    if (match) {
      bucket = match[1]
      prefix = pathParts.join('/')
      return { bucket, region, prefix }
    }

    match = host.match(/^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/)
    if (match && pathParts.length) {
      region = match[1]
      bucket = pathParts[0]
      prefix = pathParts.slice(1).join('/')
      return { bucket, region, prefix }
    }

    if (host === 's3.amazonaws.com' && pathParts.length) {
      bucket = pathParts[0]
      prefix = pathParts.slice(1).join('/')
      return { bucket, region, prefix }
    }
  } catch {
    return null
  }

  return null
}

const listAllObjects = async (s3, bucket, prefix) => {
  const names = []
  const normalizedPrefix = normalizePrefix(prefix)
  const keyPrefix = normalizedPrefix ? `${normalizedPrefix}/` : ''
  let continuationToken = undefined

  while (true) {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: keyPrefix,
      MaxKeys: MAX_LIST_LIMIT,
      ContinuationToken: continuationToken,
    }))

    const objects = response?.Contents || []
    objects.forEach((item) => {
      const key = String(item?.Key || '')
      if (!key || key.endsWith('/')) return
      if (!keyPrefix) {
        names.push(key)
        return
      }
      if (key.startsWith(keyPrefix)) {
        names.push(key.slice(keyPrefix.length))
      }
    })

    if (!response?.IsTruncated || !response?.NextContinuationToken) break
    continuationToken = response.NextContinuationToken
  }

  return names
}

const getCleanupTargets = (fileNames, keepCount) => {
  const keepFixed = new Set([LATEST_FILE_NAME, LATEST_INSTALLER_NAME])
  const versionMap = new Map()
  const exeRegex = /^Ferramenta Setup (\d+\.\d+\.\d+)\.exe$/
  const blockmapRegex = /^Ferramenta Setup (\d+\.\d+\.\d+)\.exe\.blockmap$/

  fileNames.forEach((name) => {
    const exeMatch = name.match(exeRegex)
    if (exeMatch) {
      const version = exeMatch[1]
      const entry = versionMap.get(version) || { exe: null, blockmap: null }
      entry.exe = name
      versionMap.set(version, entry)
      return
    }

    const blockMatch = name.match(blockmapRegex)
    if (blockMatch) {
      const version = blockMatch[1]
      const entry = versionMap.get(version) || { exe: null, blockmap: null }
      entry.blockmap = name
      versionMap.set(version, entry)
    }
  })

  const sortedVersions = Array.from(versionMap.keys()).sort(compareSemverDesc)
  const keptVersions = sortedVersions.slice(0, keepCount)
  const keepNames = new Set(keepFixed)

  keptVersions.forEach((version) => {
    const entry = versionMap.get(version)
    if (entry?.exe) keepNames.add(entry.exe)
    if (entry?.blockmap) keepNames.add(entry.blockmap)
  })

  const toDelete = fileNames.filter((name) => !keepNames.has(name))
  return { toDelete, keptVersions }
}

const uploadObject = async (s3, bucket, objectPath, localPath, options = {}) => {
  const payload = fs.readFileSync(localPath)
  const { contentType = 'application/octet-stream', cacheControl = '3600', dryRun = false } = options

  if (dryRun) {
    console.log(`[dry-run] upload ${localPath} -> s3://${bucket}/${objectPath}`)
    return
  }

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectPath,
    Body: payload,
    ContentType: contentType,
    CacheControl: cacheControl,
  }))
}

const deleteObjects = async (s3, bucket, keys, dryRun = false) => {
  if (!keys.length) return

  if (dryRun) {
    keys.forEach((key) => console.log(`[dry-run] delete s3://${bucket}/${key}`))
    return
  }

  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000)
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: chunk.map((key) => ({ Key: key })),
        Quiet: false,
      },
    }))
  }
}

const createS3Client = (region) => {
  const endpoint = resolveS3ApiEndpoint(region)
  return new S3Client({
    region,
    forcePathStyle: true,
    endpoint,
  })
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const envFile = parseEnvFile(path.resolve(process.cwd(), '.env.local'))

  if (!process.env.AWS_SDK_LOAD_CONFIG) {
    process.env.AWS_SDK_LOAD_CONFIG = '1'
  }

  if (!process.env.AWS_ACCESS_KEY_ID && envFile.AWS_ACCESS_KEY_ID) {
    process.env.AWS_ACCESS_KEY_ID = envFile.AWS_ACCESS_KEY_ID
  }
  if (!process.env.AWS_SECRET_ACCESS_KEY && envFile.AWS_SECRET_ACCESS_KEY) {
    process.env.AWS_SECRET_ACCESS_KEY = envFile.AWS_SECRET_ACCESS_KEY
  }
  if (!process.env.AWS_SESSION_TOKEN && envFile.AWS_SESSION_TOKEN) {
    process.env.AWS_SESSION_TOKEN = envFile.AWS_SESSION_TOKEN
  }

  if (!process.env.AWS_PROFILE && envFile.AWS_PROFILE) {
    process.env.AWS_PROFILE = envFile.AWS_PROFILE
  }

  const version = String(args.version || getPackageVersion() || '').trim()
  if (!version) throw new Error('Versao nao encontrada. Use --version ou configure package.json.')

  const packagePublishBaseUrl = getPackagePublishBaseUrl()
  const configuredBaseUrl = pickFirstSupportedBaseUrl([
    args.baseUrl,
    process.env.AWS_UPDATES_BASE_URL,
    process.env.UPDATE_BASE_URL,
    envFile.AWS_UPDATES_BASE_URL,
    envFile.UPDATE_BASE_URL,
    packagePublishBaseUrl,
  ])
  const parsedBaseUrl = parseS3BaseUrl(configuredBaseUrl)

  const region = normalizeRegion(
    args.region ||
      process.env.AWS_REGION ||
      envFile.AWS_REGION ||
      parsedBaseUrl?.region,
  )
  const bucket = normalizeBucket(
    args.bucket ||
      process.env.AWS_UPDATES_BUCKET ||
      envFile.AWS_UPDATES_BUCKET ||
      process.env.S3_UPDATES_BUCKET ||
      envFile.S3_UPDATES_BUCKET ||
      parsedBaseUrl?.bucket,
  )
  const prefix = normalizePrefix(
    args.prefix ||
      process.env.AWS_UPDATES_PREFIX ||
      envFile.AWS_UPDATES_PREFIX ||
      process.env.S3_UPDATES_PREFIX ||
      envFile.S3_UPDATES_PREFIX ||
      parsedBaseUrl?.prefix ||
      DEFAULT_PREFIX,
  )
  const keepCount = Number.isFinite(args.keep) && args.keep > 0 ? args.keep : DEFAULT_KEEP
  const dryRun = Boolean(args.dryRun)
  const distDir = path.resolve(process.cwd(), args.dist || DEFAULT_DIST)

  if (!bucket) {
    throw new Error(
      'AWS_UPDATES_BUCKET nao encontrado. Defina no ambiente, .env.local, --bucket ou em build.publish.url no package.json.',
    )
  }

  const baseUrl = normalizeBaseUrl(
    configuredBaseUrl,
    bucket,
    region,
    prefix,
  )

  const latestPath = path.join(distDir, LATEST_FILE_NAME)
  const exeName = `Ferramenta Setup ${version}.exe`
  const exePath = path.join(distDir, exeName)
  const blockmapName = `${exeName}.blockmap`
  const blockmapPath = path.join(distDir, blockmapName)

  ;[latestPath, exePath, blockmapPath].forEach((filePath) => {
    if (!fs.existsSync(filePath)) throw new Error(`Nao achei ${filePath}`)
  })

  const s3Endpoint = resolveS3ApiEndpoint(region)
  console.log(`Endpoint API S3: ${s3Endpoint}`)
  const s3 = createS3Client(region)

  const latestObjectPath = joinStoragePath(prefix, LATEST_FILE_NAME)
  const versionedExeObjectPath = joinStoragePath(prefix, exeName)
  const versionedBlockObjectPath = joinStoragePath(prefix, blockmapName)
  const latestInstallerObjectPath = joinStoragePath(prefix, LATEST_INSTALLER_NAME)

  await uploadObject(s3, bucket, versionedExeObjectPath, exePath, {
    contentType: 'application/vnd.microsoft.portable-executable',
    cacheControl: '31536000',
    dryRun,
  })
  await uploadObject(s3, bucket, versionedBlockObjectPath, blockmapPath, {
    contentType: 'application/octet-stream',
    cacheControl: '31536000',
    dryRun,
  })
  await uploadObject(s3, bucket, latestInstallerObjectPath, exePath, {
    contentType: 'application/vnd.microsoft.portable-executable',
    cacheControl: '300',
    dryRun,
  })
  await uploadObject(s3, bucket, latestObjectPath, latestPath, {
    contentType: 'text/yaml',
    cacheControl: '60',
    dryRun,
  })

  if (dryRun) {
    console.log('[dry-run] limpeza de versoes antigas ignorada.')
  } else {
    const fileNames = await listAllObjects(s3, bucket, prefix)
    const { toDelete, keptVersions } = getCleanupTargets(fileNames, keepCount)
    console.log(`Versoes mantidas (${keepCount}): ${keptVersions.length ? keptVersions.join(', ') : 'nenhuma'}`)

    if (toDelete.length) {
      const keys = toDelete.map((name) => joinStoragePath(prefix, name))
      await deleteObjects(s3, bucket, keys, false)
      toDelete.forEach((name) => console.log(`- removido: ${name}`))
    } else {
      console.log('Nenhum arquivo antigo para remover.')
    }
  }

  const encodedPrefix = encodePathForUrl(prefix)
  const encodedLatestInstaller = encodeURIComponent(LATEST_INSTALLER_NAME)
  const normalizedBaseUrl = baseUrl || buildPathStyleBaseUrl(bucket, region, encodedPrefix)
  const latestInstallerUrl = `${normalizedBaseUrl}${encodedLatestInstaller}`

  console.log('')
  console.log('Updates publicados no AWS S3 com sucesso!')
  console.log(`Versao: ${version}`)
  console.log(`Regiao: ${region}`)
  console.log(`Bucket: ${bucket}`)
  console.log(`Prefixo: ${prefix}`)
  console.log(`Base URL (auto-update): ${normalizedBaseUrl}`)
  console.log(`Instalador Latest: ${latestInstallerUrl}`)
}

main().catch((error) => {
  const name = String(error?.name || '')
  const message = String(error?.message || error || '')
  const lowered = `${name} ${message}`.toLowerCase()

  if (lowered.includes('notsignedup')) {
    console.error('Conta AWS sem acesso ao S3 (NotSignedUp). Ative o servico S3 para esta conta.')
  } else if (lowered.includes('nosuchbucket') || lowered.includes('the specified bucket does not exist')) {
    console.error('Bucket de updates nao existe. Crie o bucket configurado em AWS_UPDATES_BUCKET/build.publish.url.')
  } else if (lowered.includes('accessdenied')) {
    console.error('Sem permissao no bucket S3. Verifique policy e role/credenciais usadas no release.')
  } else if (lowered.includes('credential') || lowered.includes('token')) {
    console.error('Credenciais AWS ausentes ou expiradas. Atualize AWS_ACCESS_KEY_ID/SECRET/SESSION ou AWS_PROFILE.')
  }

  console.error(message || error)
  process.exit(1)
})
