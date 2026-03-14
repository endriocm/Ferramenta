const { contextBridge, ipcRenderer, webFrame } = require('electron')

const ZOOM_MIN = 0.3
const ZOOM_MAX = 3
const ZOOM_WHEEL_SENSITIVITY = 0.0015

const clampZoom = (value) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value))

const normalizeWheelDelta = (event) => {
  const rawDelta = Number(event?.deltaY) || 0
  if (event?.deltaMode === 1) return rawDelta * 16
  if (event?.deltaMode === 2) return rawDelta * (window.innerHeight || 800)
  return rawDelta
}

let pendingWheelDelta = 0
let wheelZoomFrame = 0

const flushWheelZoom = () => {
  wheelZoomFrame = 0
  if (!pendingWheelDelta) return
  const current = Number(webFrame.getZoomFactor()) || 1
  const scaleFactor = Math.exp(-pendingWheelDelta * ZOOM_WHEEL_SENSITIVITY)
  pendingWheelDelta = 0
  const next = clampZoom(Number((current * scaleFactor).toFixed(4)))
  if (Math.abs(next - current) < 0.0005) return
  webFrame.setZoomFactor(next)
}

const applyWheelZoom = (event) => {
  const hasModifier = Boolean(event.ctrlKey || event.metaKey)
  if (!hasModifier) return

  // Reproduz o comportamento de navegador: Ctrl + scroll para zoom.
  event.preventDefault()
  pendingWheelDelta += normalizeWheelDelta(event)
  if (!wheelZoomFrame) {
    wheelZoomFrame = window.requestAnimationFrame(flushWheelZoom)
  }
}

window.addEventListener('wheel', applyWheelZoom, { passive: false, capture: true })

const on = (channel, handler) => {
  if (typeof handler !== 'function') return () => {}
  const wrapped = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('electronAPI', {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectImportFolder: () => ipcRenderer.invoke('select-import-folder'),
  scanImportFolder: (folderPath) => ipcRenderer.invoke('scan-import-folder', folderPath),
  resolveFolder: (folderPath) => ipcRenderer.invoke('resolve-folder', folderPath),
  listFolderFiles: (folderPath) => ipcRenderer.invoke('list-folder-files', folderPath),
  listFolderDirectories: (folderPath) => ipcRenderer.invoke('list-folder-directories', folderPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  saveFile: (payload) => ipcRenderer.invoke('save-file', payload),
  savePdf: (payload) => ipcRenderer.invoke('save-pdf', payload),
  clipboard: {
    writeImageDataUrl: (dataUrl) => ipcRenderer.invoke('clipboard:writeImageDataUrl', dataUrl),
  },
  ocr: {
    readImageDataUrl: (dataUrl) => ipcRenderer.invoke('ocr:readImageDataUrl', dataUrl),
  },
  storage: {
    get: (key) => ipcRenderer.invoke('storage:get', key),
    getMultiple: (keys) => ipcRenderer.invoke('storage:getMultiple', keys),
    set: (key, value) => ipcRenderer.invoke('storage:set', { key, value }),
    remove: (key) => ipcRenderer.invoke('storage:remove', key),
  },
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (patch) => ipcRenderer.invoke('config:set', patch),
    selectWorkDir: () => ipcRenderer.invoke('config:selectWorkDir'),
  },
  updates: {
    getStatus: () => ipcRenderer.invoke('updates:getStatus'),
    getUrls: () => ipcRenderer.invoke('updates:getUrls'),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    setUrl: (url) => ipcRenderer.invoke('updates:setUrl', url),
    resetUrl: () => ipcRenderer.invoke('updates:resetUrl'),
    onStatus: (handler) => on('updates:status', handler),
    onProgress: (handler) => on('update:download-progress', handler),
    onState: (handler) => on('update:state', handler),
  },
  runtime: {
    getApiState: () => ipcRenderer.invoke('runtime:getApiState'),
    getApiBaseUrl: () => ipcRenderer.invoke('runtime:getApiBaseUrl'),
    onApiReady: (handler) => on('runtime:apiReady', handler),
  },
})
contextBridge.exposeInMainWorld('pwr', {
  openExternal: (url) => ipcRenderer.invoke('pwr:openExternal', url),
})
