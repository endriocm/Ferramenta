const { app, BrowserWindow, dialog, ipcMain, Menu, globalShortcut, shell, clipboard, nativeImage, session } = require('electron')
let autoUpdater
const path = require('path')
const crypto = require('crypto')
const fs = require('fs/promises')
const fsSync = require('fs')
const { execFile } = require('child_process')

const isDev = !app.isPackaged
const isDebugDevtools = process.env.OPEN_DEVTOOLS === '1'
const isPerfLogEnabled = process.env.PERF_LOG === '1'
const DEFAULT_UPDATE_BASE_URL = 'https://ferramenta-updates-937506434821.s3.sa-east-1.amazonaws.com/win/'
const EMBEDDED_SERVER_PORT = 4170
const EMBEDDED_SERVER_FALLBACK_PORT = EMBEDDED_SERVER_PORT + 1
const buildEmbeddedApiBaseUrl = (port) => `http://localhost:${port}`
const perfStartedAt = Date.now()
const logPerf = (label) => {
  if (!isPerfLogEnabled) return
  const elapsed = Date.now() - perfStartedAt
  console.log(`[perf] ${elapsed}ms ${label}`)
}
let mainWindow = null
let embeddedServer = null
let embeddedApiState = {
  ready: false,
  baseUrl: buildEmbeddedApiBaseUrl(EMBEDDED_SERVER_PORT),
  error: '',
}
let updateState = {
  status: 'idle',
  message: '',
  progress: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  info: null,
}
let updateFeedUrl = ''

const STORAGE_KEYS = new Set([
  'pwr.receita.bovespa',
  'pwr.receita.bmf',
  'pwr.receita.estruturadas',
  'pwr.receita.manual',
  'pwr.receita.xp',
  'pwr.receita.xp.override',
  'pwr.receita.xp.lastSyncAt',
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

const buildFileId = (filePath) => crypto
  .createHash('sha1')
  .update(String(filePath || '').toLowerCase())
  .digest('hex')
  .slice(0, 20)

const listExcelFilesFromFolder = async (folderPath, { rootPath = folderPath } = {}) => {
  if (!folderPath) return []
  const entries = await fs.readdir(folderPath, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const filePath = path.join(folderPath, entry.name)
    if (entry.isDirectory()) {
      const nestedFiles = await listExcelFilesFromFolder(filePath, { rootPath })
      files.push(...nestedFiles)
      continue
    }
    if (!entry.isFile()) continue
    if (!isExcelFile(entry.name)) continue
    const stat = await fs.stat(filePath)
    files.push({
      id: buildFileId(filePath),
      source: 'electron',
      rootPath,
      folderPath,
      filePath,
      fileName: entry.name,
      relativePath: path.relative(rootPath, filePath).split(path.sep).join('/'),
      lastModified: stat.mtimeMs,
      size: stat.size,
    })
  }
  return files.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
}

const listDirectoriesFromFolder = async (folderPath) => {
  if (!folderPath) return []
  const entries = await fs.readdir(folderPath, { withFileTypes: true })
  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directoryPath = path.join(folderPath, entry.name)
    let stat = null
    try {
      stat = await fs.stat(directoryPath)
    } catch {
      stat = null
    }
    directories.push({
      folderPath: directoryPath,
      folderName: entry.name,
      lastModified: Number(stat?.mtimeMs || 0) || 0,
    })
  }
  return directories.sort((a, b) => {
    const byDate = (b.lastModified || 0) - (a.lastModified || 0)
    if (byDate !== 0) return byDate
    return String(a.folderName || '').localeCompare(String(b.folderName || ''), 'pt-BR')
  })
}

const pickFileFromFolder = async (folderPath) => {
  const files = await listExcelFilesFromFolder(folderPath)
  if (!files.length) return null
  const preferred = files.find((file) => {
    const normalized = normalizeName(file.fileName)
    return normalized.includes('relatorio') && normalized.includes('posicao')
  })
  if (preferred) return { folderPath, ...preferred }
  return { folderPath, ...files[0] }
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

const escapePowerShellLiteral = (value) => String(value || '').replace(/'/g, "''")

const runWindowsImageOcr = async (filePath) => {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'OCR disponivel apenas no app Windows.' }
  }
  if (!filePath) {
    return { ok: false, error: 'Arquivo de imagem nao informado.' }
  }

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType=WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.IsGenericMethod
})[0]
function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${escapePowerShellLiteral(filePath)}')) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  throw 'OCR indisponivel neste Windows.'
}
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
[pscustomobject]@{
  text = [string]$result.Text
  lines = @($result.Lines | ForEach-Object { [string]$_.Text })
} | ConvertTo-Json -Compress -Depth 4
`.trim()

  try {
    const response = await new Promise((resolve, reject) => {
      execFile(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 30_000, cwd: app.getPath('temp') },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr || stdout || error.message || 'Falha ao executar OCR.'))
            return
          }
          resolve(String(stdout || '').trim())
        },
      )
    })

    if (!response) {
      return { ok: false, error: 'OCR retornou vazio.' }
    }

    // PowerShell 5's ConvertTo-Json does not escape raw ASCII control characters
    // (U+0000–U+001F) inside string values, which breaks JSON.parse.
    // Strip them before parsing — they carry no semantic value in OCR text.
    const sanitizedResponse = response.replace(/[\x00-\x1F\x7F]/g, '')
    const parsed = JSON.parse(sanitizedResponse)
    return {
      ok: true,
      text: String(parsed?.text || '').trim(),
      lines: Array.isArray(parsed?.lines)
        ? parsed.lines.map((line) => String(line || '').trim()).filter(Boolean)
        : [],
    }
  } catch (error) {
    await appendLog(`ocr:image error: ${error?.message || error}`)
    return { ok: false, error: error?.message || 'Falha ao ler a imagem.' }
  }
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

const clearChromiumCaches = async () => {
  try {
    await session.defaultSession.clearCache()
  } catch {
    // noop — session pode não estar disponível se a janela já foi destruída
  }

  const codeCache = path.join(getUserDataPath(), 'Code Cache')
  await fs.rm(codeCache, { recursive: true, force: true }).catch(() => {})

  const gpuCache = path.join(getUserDataPath(), 'GPUCache')
  await fs.rm(gpuCache, { recursive: true, force: true }).catch(() => {})

  try {
    const logPath = path.join(getLogDir(), 'app.log')
    const stat = await fs.stat(logPath).catch(() => null)
    if (stat && stat.size > 1_048_576) {
      await fs.writeFile(logPath, '', 'utf-8')
    }
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

const sendToWindow = (channel, payload) => {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send(channel, payload)
  }
}

const setEmbeddedApiState = (next = {}) => {
  embeddedApiState = { ...embeddedApiState, ...(next || {}) }
  sendToWindow('runtime:apiReady', embeddedApiState)
}

const normalizeBaseUrl = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withProtocol = raw.includes('://') ? raw : `https://${raw}`
  const normalized = withProtocol.endsWith('/') ? withProtocol : `${withProtocol}/`
  return normalized
}

const isValidBaseUrl = (value) => {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

const isLegacyBlobUpdateUrl = (value) => {
  if (!value) return false
  try {
    const parsed = new URL(value)
    const host = String(parsed.hostname || '').toLowerCase()
    return host.includes('blob.vercel-storage.com')
  } catch {
    return false
  }
}

const sanitizeUpdateBaseUrl = (value, source) => {
  const normalized = normalizeBaseUrl(value)
  if (!normalized) return ''
  if (!isLegacyBlobUpdateUrl(normalized)) return normalized
  appendLog(`updates: ignoring legacy vercel blob URL from ${source}: ${normalized}`)
  return ''
}

const getDefaultUpdateBaseUrl = () => {
  try {
    const pkgPath = path.join(app.getAppPath(), 'package.json')
    const pkg = require(pkgPath)
    const publish = pkg?.build?.publish
    if (Array.isArray(publish)) {
      const entry = publish.find((item) => item?.provider === 'generic' && item?.url) || publish[0]
      return normalizeBaseUrl(entry?.url || '')
    }
    if (publish?.url) return normalizeBaseUrl(publish.url)
  } catch {
    // noop
  }
  return ''
}

const resolveUpdateUrls = async () => {
  const config = await loadConfig()
  const envUrl = sanitizeUpdateBaseUrl(process.env.UPDATE_BASE_URL, 'UPDATE_BASE_URL')
  let customUrl = sanitizeUpdateBaseUrl(config.updateBaseUrl, 'config.updateBaseUrl')
  const defaultUrl = sanitizeUpdateBaseUrl(getDefaultUpdateBaseUrl() || DEFAULT_UPDATE_BASE_URL, 'default')

  if (config.updateBaseUrl && !customUrl) {
    customUrl = ''
    await saveConfig({ updateBaseUrl: '' })
    appendLog('updates: removed invalid/legacy update URL from local config')
  }

  const effectiveUrl = (isValidBaseUrl(envUrl) && envUrl) ||
    (isValidBaseUrl(customUrl) && customUrl) ||
    (isValidBaseUrl(defaultUrl) && defaultUrl) ||
    ''
  return {
    customUrl: isValidBaseUrl(customUrl) ? customUrl : '',
    defaultUrl: isValidBaseUrl(defaultUrl) ? defaultUrl : '',
    effectiveUrl,
  }
}

const ensureUpdateFeed = async () => {
  if (isDev) return ''
  const { effectiveUrl } = await resolveUpdateUrls()
  if (!effectiveUrl) return ''
  updateFeedUrl = effectiveUrl
  autoUpdater.setFeedURL({ provider: 'generic', url: effectiveUrl })
  return effectiveUrl
}

const setupAutoUpdater = async () => {
  if (isDev) {
    setUpdateState({ status: 'disabled', message: 'Atualizacoes desativadas em DEV.' })
    return
  }

  autoUpdater = require('electron-updater').autoUpdater
  autoUpdater.autoDownload = false

  autoUpdater.on('checking-for-update', () => {
    sendToWindow('update:state', { state: 'checking' })
    setUpdateState({
      status: 'checking',
      message: 'Verificando atualizacoes...',
      progress: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
    })
  })

  autoUpdater.on('update-available', (info) => {
    sendToWindow('update:state', { state: 'available', info })
    setUpdateState({
      status: 'available',
      info,
      message: 'Atualizacao disponivel.',
      progress: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    sendToWindow('update:state', { state: 'not-available', info })
    setUpdateState({
      status: 'not-available',
      info,
      message: 'Nenhuma atualizacao encontrada.',
      progress: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    sendToWindow('update:download-progress', progress)
    const percent = Number.isFinite(progress?.percent) ? progress.percent : 0
    setUpdateState({
      status: 'downloading',
      progress: percent,
      bytesPerSecond: Number.isFinite(progress?.bytesPerSecond) ? progress.bytesPerSecond : 0,
      transferred: Number.isFinite(progress?.transferred) ? progress.transferred : 0,
      total: Number.isFinite(progress?.total) ? progress.total : 0,
      message: 'Baixando atualizacao...',
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    sendToWindow('update:state', { state: 'downloaded', info })
    setUpdateState({
      status: 'downloaded',
      info,
      message: 'Atualizacao pronta para instalar.',
      progress: 100,
      bytesPerSecond: 0,
      transferred: updateState.total || updateState.transferred,
      total: updateState.total || updateState.transferred,
    })
  })

  autoUpdater.on('error', (error) => {
    sendToWindow('update:state', { state: 'error', message: String(error) })
    setUpdateState({
      status: 'error',
      message: error?.message || 'Falha ao atualizar.',
      progress: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0,
    })
  })

  await ensureUpdateFeed()
}

const DESIGN_WINDOW_WIDTH = 1300
const DESIGN_WINDOW_HEIGHT = 820

const applyAutoZoom = (win) => {
  if (!win || win.isDestroyed() || !win.webContents) return
  // Ignorar enquanto a janela estiver minimizada — getSize() retorna valores inválidos
  if (win.isMinimized()) return
  const [w, h] = win.getContentSize()
  if (!w || !h || w < 100 || h < 100) return
  const widthScale = w / DESIGN_WINDOW_WIDTH
  const heightScale = h / DESIGN_WINDOW_HEIGHT
  const scale = Math.min(1, Math.max(0.75, Math.min(widthScale, heightScale)))
  win.webContents.setZoomFactor(scale)
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1300,
    height: 820,
    backgroundColor: '#0b0f17',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.setMenuBarVisibility(false)

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (isDev && devServerUrl) {
    win.loadURL(devServerUrl)
  } else {
    win.loadFile(path.join(__dirname, '..', 'pwr', 'dist', 'index.html'))
  }
  win.webContents.once('did-finish-load', () => {
    logPerf('did-finish-load')
    applyAutoZoom(win)
    sendToWindow('runtime:apiReady', embeddedApiState)
    if (isDebugDevtools && !win.isDestroyed()) {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  })
  win.on('resize', () => applyAutoZoom(win))
  // Reaplicar zoom correto ao restaurar da barra de tarefas
  win.on('restore', () => applyAutoZoom(win))
  return win
}

const startServerOnPort = (serverApp, port) => {
  return new Promise((resolve, reject) => {
    process.env.PORT = String(port)
    const server = serverApp.listen(port, () => resolve(server))
    server.once('error', (error) => reject(error))
  })
}

const startEmbeddedServer = async () => {
  try {
    const serverPath = path.join(__dirname, '..', 'server', 'index.js')
    if (!fsSync.existsSync(serverPath)) {
      const errorMessage = 'embedded-server: server/index.js nao encontrado, pulando bootstrap da API.'
      appendLog(errorMessage)
      setEmbeddedApiState({ ready: false, error: errorMessage })
      return false
    }

    const hubxpRuntimeDir = path.join(getUserDataPath(), 'hubxp-runtime')
    if (!process.env.HUBXP_RUNTIME_DIR) process.env.HUBXP_RUNTIME_DIR = hubxpRuntimeDir
    if (!process.env.HUBXP_DEBUG_DIR) process.env.HUBXP_DEBUG_DIR = path.join(hubxpRuntimeDir, 'debug')
    if (!process.env.HUBXP_SESSION_FILE) process.env.HUBXP_SESSION_FILE = path.join(hubxpRuntimeDir, 'hubxp-session.json')
    if (!process.env.PWR_CONFIG_PATH) process.env.PWR_CONFIG_PATH = getConfigPath()

    const { app: serverApp } = require(serverPath)
    if (!serverApp?.listen) {
      const errorMessage = 'embedded-server: modulo carregado sem app.listen.'
      appendLog(errorMessage)
      setEmbeddedApiState({ ready: false, error: errorMessage })
      return false
    }

    let selectedPort = EMBEDDED_SERVER_PORT
    let server = null

    try {
      server = await startServerOnPort(serverApp, selectedPort)
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
      appendLog(`embedded-server: porta ${selectedPort} em uso, tentando porta ${EMBEDDED_SERVER_FALLBACK_PORT}`)
      selectedPort = EMBEDDED_SERVER_FALLBACK_PORT
      server = await startServerOnPort(serverApp, selectedPort)
    }

    embeddedServer = server
    const baseUrl = buildEmbeddedApiBaseUrl(selectedPort)
    appendLog(`embedded-server: servidor iniciado na porta ${selectedPort}`)
    setEmbeddedApiState({ ready: true, baseUrl, error: '' })
    logPerf(`server-ready (${selectedPort})`)
    return true
  } catch (error) {
    const errorMessage = `embedded-server: erro ao iniciar - ${error?.message || error}`
    appendLog(errorMessage)
    setEmbeddedApiState({ ready: false, error: errorMessage })
    logPerf('server-failed')
    return false
  }
}
app.whenReady().then(async () => {
  logPerf('app-ready')
  if (process.platform === 'win32') {
    Menu.setApplicationMenu(null)
  }

  mainWindow = createWindow()
  logPerf('window-created')
  void startEmbeddedServer()
  await setupAutoUpdater()

  if (isDebugDevtools) {
    const toggle = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.toggleDevTools()
      }
    }
    globalShortcut.register('F12', toggle)
    globalShortcut.register('CommandOrControl+Shift+I', toggle)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', (event) => {
  event.preventDefault()
  if (isDebugDevtools) {
    globalShortcut.unregisterAll()
  }
  const timeout = new Promise((resolve) => setTimeout(resolve, 8_000))
  Promise.race([clearChromiumCaches().catch(() => {}), timeout])
    .finally(() => app.exit(0))
})

ipcMain.handle('app:getVersion', () => app.getVersion())
ipcMain.handle('runtime:getApiState', async () => embeddedApiState)
ipcMain.handle('runtime:getApiBaseUrl', async () => embeddedApiState.baseUrl)

ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
    await shell.openExternal(url)
  }
})

ipcMain.handle('pwr:openExternal', async (_event, url) => {
  if (!url || typeof url !== 'string') return false
  await shell.openExternal(url)
  return true
})

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths?.length) return null
  const folderPath = result.filePaths[0]
  return pickFileFromFolder(folderPath)
})

ipcMain.handle('select-import-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths?.length) return null
  const folderPath = result.filePaths[0]
  const files = await listExcelFilesFromFolder(folderPath, { rootPath: folderPath })
  return {
    folderPath,
    folderName: path.basename(folderPath),
    files,
  }
})

ipcMain.handle('scan-import-folder', async (_event, folderPath) => {
  if (!folderPath) return []
  try {
    return await listExcelFilesFromFolder(folderPath, { rootPath: folderPath })
  } catch {
    return []
  }
})

ipcMain.handle('resolve-folder', async (_event, folderPath) => {
  if (!folderPath) return null
  try {
    return await pickFileFromFolder(folderPath)
  } catch {
    return null
  }
})

ipcMain.handle('list-folder-files', async (_event, folderPath) => {
  if (!folderPath) return []
  try {
    return await listExcelFilesFromFolder(folderPath)
  } catch {
    return []
  }
})

ipcMain.handle('list-folder-directories', async (_event, folderPath) => {
  if (!folderPath) return []
  try {
    return await listDirectoriesFromFolder(folderPath)
  } catch {
    return []
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

ipcMain.handle('save-pdf', async (_event, payload = {}) => {
  const htmlContent = payload?.html || ''
  const defaultPath = payload?.defaultPath || 'relatorio.pdf'
  const landscape = payload?.landscape !== false
  if (!htmlContent) return { ok: false, error: 'Nenhum conteudo HTML fornecido.' }

  const result = await dialog.showSaveDialog({
    defaultPath,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, error: 'Cancelado pelo usuario.' }

  let pdfWin = null
  try {
    pdfWin = new BrowserWindow({
      width: 1280,
      height: 900,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    pdfWin.webContents.on('did-finish-load', () => {})
    await pdfWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`)
    // Aguardar renderizacao completa
    await new Promise((resolve) => setTimeout(resolve, 600))
    const pdfTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout ao gerar PDF.')), 30_000),
    )
    const pdfBuffer = await Promise.race([
      pdfWin.webContents.printToPDF({ landscape, printBackground: true, marginsType: 0, pageSize: 'A4' }),
      pdfTimeout,
    ])
    await fs.writeFile(result.filePath, pdfBuffer)
    return { ok: true, filePath: result.filePath }
  } catch (error) {
    await appendLog(`save-pdf error: ${error?.message || error}`)
    return { ok: false, error: error?.message || 'Falha ao gerar PDF.' }
  } finally {
    if (pdfWin && !pdfWin.isDestroyed()) pdfWin.destroy()
  }
})

ipcMain.handle('clipboard:writeImageDataUrl', async (_event, dataUrl) => {
  const raw = String(dataUrl || '').trim()
  if (!raw.startsWith('data:image/')) return false
  try {
    const image = nativeImage.createFromDataURL(raw)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  } catch (error) {
    await appendLog(`clipboard:writeImageDataUrl error: ${error?.message || error}`)
    return false
  }
})

ipcMain.handle('ocr:readImageDataUrl', async (_event, dataUrl) => {
  const raw = String(dataUrl || '').trim()
  const match = raw.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/)
  if (!match) return { ok: false, error: 'Formato de imagem invalido.' }

  const mimeType = String(match[1] || '').toLowerCase()
  const extension = mimeType.includes('jpeg')
    ? 'jpg'
    : (mimeType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
  const tempFilePath = path.join(
    app.getPath('temp'),
    `pwr-ocr-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${extension || 'png'}`,
  )

  try {
    const buffer = Buffer.from(match[2], 'base64')
    await fs.writeFile(tempFilePath, buffer)
    const ocrResult = await runWindowsImageOcr(tempFilePath)
    // DEBUG: dump OCR result to temp file
    try {
      const debugPath = path.join(app.getPath('temp'), 'pwr-ocr-debug.json')
      await fs.writeFile(debugPath, JSON.stringify(ocrResult, null, 2), 'utf-8')
      await appendLog(`OCR debug written to ${debugPath}`)
    } catch {}
    return ocrResult
  } catch (error) {
    await appendLog(`ocr:imageDataUrl error: ${error?.message || error}`)
    return { ok: false, error: error?.message || 'Falha ao preparar a imagem.' }
  } finally {
    try {
      if (fsSync.existsSync(tempFilePath)) {
        await fs.unlink(tempFilePath)
      }
    } catch {
      // noop
    }
  }
})

ipcMain.handle('storage:get', async (_event, key) => {
  if (!key || !STORAGE_KEYS.has(key)) return null
  return readJsonFile(getStoragePath(key))
})

ipcMain.handle('storage:getMultiple', async (_event, keys) => {
  if (!Array.isArray(keys)) return {}
  const entries = await Promise.all(
    keys
      .filter((k) => k && STORAGE_KEYS.has(k))
      .map(async (k) => [k, await readJsonFile(getStoragePath(k))]),
  )
  return Object.fromEntries(entries.filter(([, v]) => v != null))
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

ipcMain.handle('updates:getUrls', async () => {
  return resolveUpdateUrls()
})

ipcMain.handle('updates:setUrl', async (_event, url) => {
  const normalized = normalizeBaseUrl(url)
  if (normalized && !isValidBaseUrl(normalized)) {
    return { ok: false, message: 'URL de atualizacao invalida.' }
  }
  if (normalized && isLegacyBlobUpdateUrl(normalized)) {
    return { ok: false, message: 'URL antiga do Vercel Blob nao e suportada. Use URL AWS S3.' }
  }
  await saveConfig({ updateBaseUrl: normalized })
  await ensureUpdateFeed()
  return { ok: true, urls: await resolveUpdateUrls() }
})

ipcMain.handle('updates:resetUrl', async () => {
  await saveConfig({ updateBaseUrl: '' })
  await ensureUpdateFeed()
  return { ok: true, urls: await resolveUpdateUrls() }
})

ipcMain.handle('updates:check', async () => {
  if (isDev) return { status: 'disabled', message: 'Atualizacoes desativadas em DEV.' }
  const feed = await ensureUpdateFeed()
  if (!feed) {
    setUpdateState({ status: 'error', message: 'URL de atualizacao nao configurada.' })
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
    setUpdateState({ status: 'error', message: 'URL de atualizacao nao configurada.' })
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

