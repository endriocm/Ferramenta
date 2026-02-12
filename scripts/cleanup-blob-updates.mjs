import fs from 'fs'
import path from 'path'
import { list, del } from '@vercel/blob'

const DEFAULT_PREFIX = 'updates/win/'
const DEFAULT_KEEP = 2
const MAX_LIST_LIMIT = 1000
const DELETE_BATCH_SIZE = 50

const parseArgs = (argv) => {
  const args = { prefix: DEFAULT_PREFIX, keep: DEFAULT_KEEP }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--prefix') {
      args.prefix = argv[i + 1] || DEFAULT_PREFIX
      i += 1
      continue
    }
    if (arg.startsWith('--prefix=')) {
      args.prefix = arg.split('=').slice(1).join('=') || DEFAULT_PREFIX
      continue
    }
    if (arg === '--keep') {
      const value = Number(argv[i + 1])
      if (Number.isFinite(value) && value > 0) args.keep = Math.floor(value)
      i += 1
      continue
    }
    if (arg.startsWith('--keep=')) {
      const value = Number(arg.split('=').slice(1).join('='))
      if (Number.isFinite(value) && value > 0) args.keep = Math.floor(value)
    }
  }
  return args
}

const normalizePrefix = (value) => {
  if (!value) return DEFAULT_PREFIX
  return value.endsWith('/') ? value : `${value}/`
}

const parseEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return {}
  const content = fs.readFileSync(filePath, 'utf-8')
  const env = {}
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
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

const ensureToken = () => {
  if (process.env.BLOB_READ_WRITE_TOKEN) return
  const envPath = path.resolve(process.cwd(), '.env.local')
  const env = parseEnvFile(envPath)
  if (env.BLOB_READ_WRITE_TOKEN) {
    process.env.BLOB_READ_WRITE_TOKEN = env.BLOB_READ_WRITE_TOKEN
    return
  }
  console.error(
    'BLOB_READ_WRITE_TOKEN nao encontrado. Defina a variavel de ambiente ou adicione em .env.local.',
  )
  process.exit(1)
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

const listAll = async (prefix) => {
  const blobs = []
  let cursor = undefined
  let hasMore = true
  while (hasMore) {
    const result = await list({ prefix, limit: MAX_LIST_LIMIT, cursor })
    blobs.push(...(result?.blobs || []))
    hasMore = Boolean(result?.hasMore)
    cursor = result?.cursor
    if (!hasMore) break
  }
  return blobs
}

const buildKeepSet = (prefix, blobs, keepCount) => {
  const keepFixed = new Set([
    `${prefix}latest.yml`,
    `${prefix}Ferramenta Setup Latest.exe`,
  ])
  const versions = new Map()
  const exeRegex = /Ferramenta Setup (\d+\.\d+\.\d+)\.exe$/
  const blockRegex = /Ferramenta Setup (\d+\.\d+\.\d+)\.exe\.blockmap$/

  blobs.forEach((blob) => {
    const pathname = blob.pathname || ''
    const exeMatch = pathname.match(exeRegex)
    if (exeMatch) {
      const version = exeMatch[1]
      const entry = versions.get(version) || { exe: null, blockmap: null }
      entry.exe = pathname
      versions.set(version, entry)
      return
    }
    const blockMatch = pathname.match(blockRegex)
    if (blockMatch) {
      const version = blockMatch[1]
      const entry = versions.get(version) || { exe: null, blockmap: null }
      entry.blockmap = pathname
      versions.set(version, entry)
    }
  })

  const sortedVersions = Array.from(versions.keys()).sort(compareSemverDesc)
  const keptVersions = sortedVersions.slice(0, keepCount)
  const keepPaths = new Set(keepFixed)
  keptVersions.forEach((version) => {
    const entry = versions.get(version)
    if (entry?.exe) keepPaths.add(entry.exe)
    if (entry?.blockmap) keepPaths.add(entry.blockmap)
  })

  return { keepPaths, keptVersions }
}

const chunk = (items, size) => {
  const chunks = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const prefix = normalizePrefix(args.prefix)
  const keepCount = Number.isFinite(args.keep) && args.keep > 0 ? args.keep : DEFAULT_KEEP

  ensureToken()

  const blobs = await listAll(prefix)
  if (!blobs.length) {
    console.log(`Nenhum blob encontrado em ${prefix}`)
    return
  }

  const { keepPaths, keptVersions } = buildKeepSet(prefix, blobs, keepCount)
  const toDelete = blobs.filter((blob) => !keepPaths.has(blob.pathname))

  console.log(`Versoes mantidas (${keepCount}): ${keptVersions.length ? keptVersions.join(', ') : 'nenhuma'}`)
  console.log('Arquivos fixos mantidos: latest.yml, Ferramenta Setup Latest.exe')

  if (!toDelete.length) {
    console.log('Nada para deletar.')
    return
  }

  const deleteTargets = toDelete.map((blob) => blob.url || blob.pathname).filter(Boolean)
  for (const batch of chunk(deleteTargets, DELETE_BATCH_SIZE)) {
    await del(batch)
  }

  console.log('Arquivos deletados:')
  toDelete.forEach((blob) => {
    console.log(`- ${blob.pathname}`)
  })
  console.log(`Total deletado: ${toDelete.length}`)
}

main().catch((error) => {
  console.error('Falha ao limpar blobs:', error?.message || error)
  process.exit(1)
})
