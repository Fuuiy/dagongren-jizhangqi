const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  pin: (v) => ipcRenderer.send('win:pin', v),
  setCompact: (v) => ipcRenderer.send('win:compact', v),
  fetchHolidays: (y) => ipcRenderer.invoke('holidays:fetch', y),
  getVersion: () => ipcRenderer.invoke('app:version'),
  trayState: () => ipcRenderer.invoke('app:tray'),
  exportData: (name, content) => ipcRenderer.invoke('data:export', name, content),
  importData: () => ipcRenderer.invoke('data:import'),
  // 托盘右键菜单发来的指令（目前只有「缩成小窗 / 展开」）
  onTrayCommand: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('tray:cmd', (e, cmd) => cb(String(cmd || '')));
  },
  isDesktop: true
});
