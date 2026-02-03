const { contextBridge, ipcRenderer } = require('electron')

const on = (channel, handler) => {
  if (typeof handler !== 'function') return () => {}
  const wrapped = (_event, payload) => handler(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('electronAPI', {
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
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onStatus: (handler) => on('updates:status', handler),
  },
})
