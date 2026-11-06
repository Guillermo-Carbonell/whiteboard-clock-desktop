// El tooltip del mini reloj: una ventanita aparte, porque el mini reloj es del alto de la barra y ahí no entra.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tip', {
  onText: cb => ipcRenderer.on('tip:text', (e, t, down) => cb(t, down)),
  ready: () => ipcRenderer.send('tip:ready'),
});
