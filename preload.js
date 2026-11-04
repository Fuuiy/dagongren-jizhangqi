const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  pin: (v) => ipcRenderer.send('win:pin', v),
  setCompact: (v) => ipcRenderer.send('win:compact', v),
  fetchHolidays: (y) => ipcRenderer.invoke('holidays:fetch', y),
  getVersion: () => ipcRenderer.invoke('app:version'),
  exportData: (name, content) => ipcRenderer.invoke('data:export', name, content),
  importData: () => ipcRenderer.invoke('data:import'),
  isDesktop: true
});
