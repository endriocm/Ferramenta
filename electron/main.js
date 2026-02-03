const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs/promises')
const fsSync = require('fs')

const isDev = !app.isPackaged
let mainWindow = null
let updateState = { status: 'idle', message: '', progress: 0, info: null }
let updateFeedUrl = ''

const STORAGE_KEYS = new Set([
  'pwr.receita.bovespa',
  'pwr.receita.bmf',
  'pwr.receita.estruturadas',
  'pwr.receita.manual',
  'pwr.market.cache',
])

const DEFAULT_CONFIG = {
  workDir: '',
  updateBaseUrl: '',
  license: { enabled: false, endpoint: '' },
  auth: { enabled: false, endpoint: '' },
}

const normalizeName = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')

const isExcelFile = (name) => {
  const lower = String(name || '').toLowerCase()
  return (lower.endsWith('.xlsx') || lower.endsWith('.xls')) && !name.startsWith('~$')
}

const pickFileFromFolder = async (folderPath) => {
  const entries = await fs.readdir(folderPath, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!isExcelFile(entry.name)) continue
    const filePath = path.join(folderPath, entry.name)
    const stat = await fs.stat(filePath)
    files.push({
      filePath,
      fileName: entry.name,
      lastModified: stat.mtimeMs,
    })
  }

  if (!files.length) return null
  const preferred = files.find((file) => {
    const normalized = normalizeName(file.fileName)
    return normalized.includes('relatorio') && normalized.includes('posicao')
  })
  if (preferred) return { folderPath, ...preferred }
  const sorted = files.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
  return { folderPath, ...sorted[0] }
}

const ensureDir = async (dirPath) => {
  if (!dirPath) return
  await fs.mkdir(dirPath, { recursive: true })
}

const getUserDataPath = () => app.getPath('userData')
const getDataDir = () => path.join(getUserDataPath(), 'data')
const getLogDir = () => path.join(getUserDataPath(), 'logs')
const getConfigPath = () => path.join(getUserDataPath(), 'config.json')

const sanitizeKey = (key) => String(key || '').replace(/[^a-z0-9._-]/gi, '_')
const getStoragePath = (key) => path.join(getDataDir(), `${sanitizeKey(key)}.json`)

const readJsonFile = async (filePath) => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const writeJsonFile = async (filePath, payload) => {
  await ensureDir(path.dirname(filePath))
  const raw = JSON.stringify(payload ?? null)
  await fs.writeFile(filePath, raw, 'utf-8')
}

const appendLog = async (message) => {
  try {
    await ensureDir(getLogDir())
    const line = `[${new Date().toISOString()}] ${message}\n`
    await fs.appendFile(path.join(getLogDir(), 'app.log'), line, 'utf-8')
  } catch {
    // noop
  }
}

let configCache = null
const loadConfig = async () => {
  if (configCache) return configCache
  const stored = await readJsonFile(getConfigPath())
  configCache = { ...DEFAULT_CONFIG, ...(stored || {}) }
  return configCache
}

const saveConfig = async (patch) => {
  const current = await loadConfig()
  const next = { ...current, ...(patch || {}) }
  configCache = next
  await writeJsonFile(getConfigPath(), next)
  return next
}

const setUpdateState = (next) => {
  updateState = { ...updateState, ...(next || {}) }
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('updates:status', updateState)
  }
}

const ensureUpdateFeed = async () => {
  if (isDev) return ''
  const config = await loadConfig()
  const base = process.env.UPDATE_BASE_URL || config.updateBaseUrl
  if (!base) return ''
  const normalized = base.endsWith('/') ? base : `${base}/`
  updateFeedUrl = normalized
  autoUpdater.setFeedURL({ provider: 'generic', url: normalized })
  return normalized
}

const setupAutoUpdater = async () => {
  if (isDev) {
    setUpdateState({ status: 'disabled', message: 'Atualizacoes desativadas em DEV.' })
    return
  }

  autoUpdater.autoDownload = false

  autoUpdater.on('checking-for-update', () => {
    setUpdateState({ status: 'checking', message: 'Verificando atualizacoes...' })
  })

  autoUpdater.on('update-available', (info) => {
    setUpdateState({ status: 'available', info, message: 'Atualizacao disponivel.' })
  })

  autoUpdater.on('update-not-available', (info) => {
    setUpdateState({ status: 'not-available', info, message: 'Nenhuma atualizacao encontrada.' })
  })

  autoUpdater.on('download-progress', (progress) => {
    setUpdateState({ status: 'downloading', progress: progress?.percent ?? 0, message: 'Baixando atualizacao...' })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ status: 'downloaded', info, message: 'Atualizacao pronta para instalar.' })
  })

  autoUpdater.on('error', (error) => {
    setUpdateState({ status: 'error', message: error?.message || 'Falha ao atualizar.' })
  })

  await ensureUpdateFeed()
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1300,
    height: 820,
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (isDev && devServerUrl) {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(path.join(__dirname, '..', 'pwr', 'dist', 'index.html'))
  }
  return win
}

app.whenReady().then(async () => {
  mainWindow = createWindow()
  await setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths?.length) return null
  const folderPath = result.filePaths[0]
  return pickFileFromFolder(folderPath)
})

ipcMain.handle('resolve-folder', async (_event, folderPath) => {
  if (!folderPath) return null
  try {
    return await pickFileFromFolder(folderPath)
  } catch {
    return null
  }
})

ipcMain.handle('read-file', async (_event, filePath) => {
  if (!filePath) return null
  const buffer = await fs.readFile(filePath)
  return buffer
})

ipcMain.handle('save-file', async (_event, payload = {}) => {
  const defaultPath = payload?.defaultPath || 'export.xlsx'
  const result = await dialog.showSaveDialog({
    defaultPath,
    filters: [{ name: 'Excel', extensions: ['xlsx'] }],
  })
  if (result.canceled || !result.filePath) return null
  const buffer = payload?.buffer
  if (!buffer) return null
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  await fs.writeFile(result.filePath, data)
  return { filePath: result.filePath }
})

ipcMain.handle('storage:get', async (_event, key) => {
  if (!key || !STORAGE_KEYS.has(key)) return null
  return readJsonFile(getStoragePath(key))
})

ipcMain.handle('storage:set', async (_event, payload = {}) => {
  const key = payload?.key
  if (!key || !STORAGE_KEYS.has(key)) return false
  await writeJsonFile(getStoragePath(key), payload.value)
  return true
})

ipcMain.handle('storage:remove', async (_event, key) => {
  if (!key || !STORAGE_KEYS.has(key)) return false
  const filePath = getStoragePath(key)
  if (fsSync.existsSync(filePath)) {
    await fs.unlink(filePath)
  }
  return true
})

ipcMain.handle('config:get', async () => {
  return loadConfig()
})

ipcMain.handle('config:set', async (_event, patch = {}) => {
  const next = await saveConfig(patch)
  return next
})

ipcMain.handle('config:selectWorkDir', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths?.length) return null
  const workDir = result.filePaths[0]
  const next = await saveConfig({ workDir })
  return { workDir, config: next }
})

ipcMain.handle('updates:getStatus', async () => updateState)

ipcMain.handle('updates:check', async () => {
  if (isDev) return { status: 'disabled', message: 'Atualizacoes desativadas em DEV.' }
  const feed = await ensureUpdateFeed()
  if (!feed) {
    setUpdateState({ status: 'error', message: 'UPDATE_BASE_URL nao configurado.' })
    return updateState
  }
  try {
    await autoUpdater.checkForUpdates()
    return { status: 'checking' }
  } catch (error) {
    const message = error?.message || 'Falha ao verificar atualizacao.'
    setUpdateState({ status: 'error', message })
    await appendLog(`update-check-error: ${message}`)
    return updateState
  }
})

ipcMain.handle('updates:download', async () => {
  if (isDev) return { status: 'disabled', message: 'Atualizacoes desativadas em DEV.' }
  const feed = await ensureUpdateFeed()
  if (!feed) {
    setUpdateState({ status: 'error', message: 'UPDATE_BASE_URL nao configurado.' })
    return updateState
  }
  try {
    await autoUpdater.downloadUpdate()
    return { status: 'downloading' }
  } catch (error) {
    const message = error?.message || 'Falha ao baixar atualizacao.'
    setUpdateState({ status: 'error', message })
    await appendLog(`update-download-error: ${message}`)
    return updateState
  }
})

ipcMain.handle('updates:install', async () => {
  if (isDev) return { status: 'disabled', message: 'Atualizacoes desativadas em DEV.' }
  try {
    autoUpdater.quitAndInstall(false, true)
    return { status: 'installing' }
  } catch (error) {
    const message = error?.message || 'Falha ao instalar atualizacao.'
    setUpdateState({ status: 'error', message })
    await appendLog(`update-install-error: ${message}`)
    return updateState
  }
})
