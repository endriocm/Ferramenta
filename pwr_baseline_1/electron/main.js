const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs/promises')

const isDev = !app.isPackaged

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
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
