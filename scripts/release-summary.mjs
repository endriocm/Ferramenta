import fs from 'node:fs'
import path from 'node:path'
import { HeadBucketCommand, ListBucketsCommand, S3Client } from '@aws-sdk/client-s3'

const DEFAULT_REGION = 'us-east-1'
const DEFAULT_PREFIX = 'win'
const DIST_DIR = 'dist_electron'
const LATEST_FILE = 'latest.yml'

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

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const normalized = String(value || '').trim()
    if (normalized) return normalized
  }
  return ''
}

const normalizeBaseUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withProtocol = raw.includes('://') ? raw : `https://${raw}`
  return withProtocol.replace(/\/+$/, '') + '/'
}

const parseS3BaseUrl = (baseUrl) => {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return null

  try {
    const parsed = new URL(normalized)
    const host = String(parsed.hostname || '').toLowerCase()
    const pathParts = String(parsed.pathname || '').split('/').filter(Boolean)

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

const format = (status, label, value) => {
  const suffix = value ? `: ${value}` : ''
  console.log(`${status} ${label}${suffix}`)
}

const run = async () => {
  const envFile = parseEnvFile(path.resolve(process.cwd(), '.env.local'))
  const pkgPath = path.resolve(process.cwd(), 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  const version = String(pkg?.version || '').trim()
  const publish = pkg?.build?.publish

  let publishUrl = ''
  if (Array.isArray(publish)) {
    publishUrl = firstNonEmpty(
      publish.find((item) => item?.provider === 'generic')?.url,
      publish.find((item) => item?.url)?.url,
    )
  } else {
    publishUrl = firstNonEmpty(publish?.url)
  }

  const configuredBaseUrl = normalizeBaseUrl(
    firstNonEmpty(
      process.env.UPDATE_BASE_URL,
      process.env.AWS_UPDATES_BASE_URL,
      envFile.UPDATE_BASE_URL,
      envFile.AWS_UPDATES_BASE_URL,
      publishUrl,
    ),
  )
  const parsedBaseUrl = parseS3BaseUrl(configuredBaseUrl)

  const region = firstNonEmpty(
    process.env.AWS_REGION,
    envFile.AWS_REGION,
    parsedBaseUrl?.region,
    DEFAULT_REGION,
  )
  const bucket = firstNonEmpty(
    process.env.AWS_UPDATES_BUCKET,
    envFile.AWS_UPDATES_BUCKET,
    parsedBaseUrl?.bucket,
  )
  const prefix = firstNonEmpty(
    process.env.AWS_UPDATES_PREFIX,
    envFile.AWS_UPDATES_PREFIX,
    parsedBaseUrl?.prefix,
    DEFAULT_PREFIX,
  )

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

  const hasEnvCredentials = Boolean(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY,
  )
  const hasProfile = Boolean(process.env.AWS_PROFILE)
  const hasAnyCredentials = hasEnvCredentials || hasProfile

  const distDir = path.resolve(process.cwd(), DIST_DIR)
  const installerName = `Ferramenta Setup ${version}.exe`
  const installerPath = path.join(distDir, installerName)
  const blockmapPath = `${installerPath}.blockmap`
  const latestPath = path.join(distDir, LATEST_FILE)

  let blocking = false

  console.log('')
  console.log('Release summary')
  console.log('---------------')
  format(version ? '[ok]' : '[fail]', 'version', version || 'missing in package.json')
  if (!version) blocking = true

  format(configuredBaseUrl ? '[ok]' : '[warn]', 'update base url', configuredBaseUrl || 'not configured')
  format(bucket ? '[ok]' : '[fail]', 'updates bucket', bucket || 'missing')
  if (!bucket) blocking = true
  format('[ok]', 'updates region', region)
  format('[ok]', 'updates prefix', prefix)

  if (hasAnyCredentials) {
    const source = hasEnvCredentials ? 'env credentials' : 'AWS profile'
    format('[ok]', 'aws auth source', source)
  } else {
    format('[fail]', 'aws auth source', 'missing credentials/profile')
    blocking = true
  }

  format(fs.existsSync(installerPath) ? '[ok]' : '[warn]', 'artifact exe', installerName)
  format(fs.existsSync(blockmapPath) ? '[ok]' : '[warn]', 'artifact blockmap', path.basename(blockmapPath))
  format(fs.existsSync(latestPath) ? '[ok]' : '[warn]', 'artifact latest', LATEST_FILE)

  let s3ServiceBlocked = false
  if (hasAnyCredentials) {
    try {
      const s3 = new S3Client({ region })
      await s3.send(new ListBucketsCommand({}))
      format('[ok]', 's3 service', 'available')
    } catch (error) {
      const name = String(error?.name || '')
      const message = String(error?.message || error || '')
      const lowered = `${name} ${message}`.toLowerCase()
      if (lowered.includes('notsignedup')) {
        format('[fail]', 's3 service', 'account not signed up for S3')
        blocking = true
        s3ServiceBlocked = true
      } else if (lowered.includes('accessdenied')) {
        format('[warn]', 's3 service', 'list buckets denied (continuing with head-bucket check)')
      } else {
        format('[warn]', 's3 service', message || 'unable to validate service')
      }
    }
  }

  if (bucket && hasAnyCredentials && !s3ServiceBlocked) {
    try {
      const s3 = new S3Client({ region })
      await s3.send(new HeadBucketCommand({ Bucket: bucket }))
      format('[ok]', 's3 bucket access', `s3://${bucket}`)
    } catch (error) {
      const name = String(error?.name || '')
      const message = String(error?.message || error || '')
      const lowered = `${name} ${message}`.toLowerCase()

      const httpStatus = Number(error?.$metadata?.httpStatusCode || 0)

      if (lowered.includes('notsignedup')) {
        format('[fail]', 's3 bucket access', 'account not signed up for S3')
      } else if (lowered.includes('nosuchbucket')) {
        format('[fail]', 's3 bucket access', 'bucket does not exist')
      } else if (name === 'NotFound' && httpStatus === 404) {
        format('[fail]', 's3 bucket access', 'bucket does not exist')
      } else if (lowered.includes('accessdenied')) {
        format('[fail]', 's3 bucket access', 'access denied')
      } else if (lowered.includes('credential')) {
        format('[fail]', 's3 bucket access', 'credentials unavailable/expired')
      } else {
        format('[fail]', 's3 bucket access', message || 'unknown error')
      }
      blocking = true
    }
  }

  console.log('')
  if (blocking) {
    console.log('Result: blocking issues found for release/publish.')
    process.exit(1)
  } else {
    console.log('Result: release prerequisites look good.')
  }
}

run().catch((error) => {
  console.error(error?.message || error)
  process.exit(1)
})
