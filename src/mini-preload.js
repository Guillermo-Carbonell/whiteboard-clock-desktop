// El mini reloj sobre la barra de Windows: solo recibe el estado del reloj y manda los botones a la app.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('mini', {
  onState: cb => ipcRenderer.on('mini:state', (e, s) => cb(s)),
  cmd: c => ipcRenderer.send('mini:cmd', c),
  open: () => ipcRenderer.send('mini:open'),
  ready: () => ipcRenderer.send('mini:ready'),
});
