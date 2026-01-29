const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  resolveFolder: (folderPath) => ipcRenderer.invoke('resolve-folder', folderPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
})
