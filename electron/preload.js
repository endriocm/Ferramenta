const { contextBridge, ipcRenderer } = require('electron')

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
  resolveFolder: (folderPath) => ipcRenderer.invoke('resolve-folder', folderPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  saveFile: (payload) => ipcRenderer.invoke('save-file', payload),
  storage: {
    get: (key) => ipcRenderer.invoke('storage:get', key),
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
})
contextBridge.exposeInMainWorld('pwr', {
  openExternal: (url) => ipcRenderer.invoke('pwr:openExternal', url),
})
