// Lo que la página de Whiteboard Clock puede usar de la app de escritorio (window.wbDesktop). Solo en la página de la app.
const { contextBridge, ipcRenderer } = require('electron');

const OK = /^https:\/\/whiteboard-clock\.(web\.app|firebaseapp\.com)$/;
const info = ipcRenderer.sendSync('wb:info');
if (OK.test(location.origin) || (info.dev && location.href.startsWith(info.dev))) {
  contextBridge.exposeInMainWorld('wbDesktop', {
    version: info.version,
    settings: info.settings,
    idleSeconds: () => ipcRenderer.invoke('wb:idle'),
    setSetting: (k, v) => ipcRenderer.invoke('wb:set', k, v),
    openExternal: url => ipcRenderer.invoke('wb:open', url),
    checkUpdate: () => ipcRenderer.invoke('wb:check'),
    restartToUpdate: () => ipcRenderer.invoke('wb:restart'),
    onUpdateReady: cb => ipcRenderer.on('wb:update-ready', (e, v) => cb(v)),
  });
}
