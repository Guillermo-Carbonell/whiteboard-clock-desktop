// Whiteboard Clock para Windows.
// Es una ventana que abre la app web (whiteboard-clock.web.app): lo de adentro se actualiza solo con cada deploy.
// Lo que suma la app de escritorio:
//  · la inactividad se mide desde Windows (mouse y teclado de toda la compu), sin pedir permisos al navegador;
//  · los links de afuera (Drive, Discord…) se abren en el navegador predeterminado;
//  · arranca con Windows y queda un ícono en la barra (se prende y apaga desde Configuración);
//  · se actualiza sola y avisa con un cartel para reiniciar.
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, powerMonitor, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// WB_URL solo para probar la app sin instalar (npm start); la instalada siempre abre la de verdad
const DEV_URL = !app.isPackaged && process.env.WB_URL;
const APP_URL = DEV_URL || 'https://whiteboard-clock.web.app/';
const APP_HOSTS = new Set(['whiteboard-clock.web.app', 'whiteboard-clock.firebaseapp.com', ...(DEV_URL ? [new URL(DEV_URL).hostname] : [])]);
// ventanitas de inicio de sesión (Google) que tienen que abrirse adentro de la app
const AUTH_HOSTS = new Set(['accounts.google.com', 'whiteboard-clock.firebaseapp.com']);

app.setAppUserModelId('games.whiteboard.clock'); // avisos de Windows con el nombre y el ícono de la app

/* ───────── una sola app abierta ───────── */
if (!app.requestSingleInstanceLock()) { app.quit(); }

/* ───────── opciones (arrancar con Windows, ícono en la barra, tamaño de la ventana) ───────── */
const cfgFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = { autoStart: true, tray: true, bounds: null, maximized: false };
let cfg = { ...DEFAULTS };
function loadCfg() { try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { cfg = { ...DEFAULTS }; } }
function saveCfg() { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 1)); } catch { /* */ } }
function applyAutoStart() { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart, path: process.execPath }); }

/* ───────── la ventana ───────── */
let win = null, tray = null, quitting = false, pendingUpdate = '';
const isApp = u => { try { return APP_HOSTS.has(new URL(u).hostname); } catch { return false; } };
const isAuth = u => { try { const x = new URL(u); return AUTH_HOSTS.has(x.hostname) && (x.hostname !== 'whiteboard-clock.firebaseapp.com' || x.pathname.startsWith('/__/auth')); } catch { return false; } };
const openOutside = u => { if (/^(https?|mailto):/i.test(u)) shell.openExternal(u); };

function createWindow() {
  const b = cfg.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1360, height: b.height || 860, x: b.x, y: b.y, minWidth: 420, minHeight: 500,
    title: 'Whiteboard Clock', icon: path.join(__dirname, '..', 'build', 'icon.png'), backgroundColor: '#1a1d21', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  win.setMenuBarVisibility(false);
  if (cfg.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });

  // links: los de la app quedan adentro; el inicio de sesión de Google abre su ventanita; todo lo demás, al navegador predeterminado
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuth(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, parent: win, modal: false } };
    if (isApp(url)) { win.loadURL(url); return { action: 'deny' }; }
    openOutside(url); return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!isApp(url) && !isAuth(url)) { e.preventDefault(); openOutside(url); } });

  // sin conexión: una pantalla propia con "Reintentar" en vez de la del navegador
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => { if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html')); });
  win.webContents.on('did-finish-load', () => { if (pendingUpdate) win.webContents.send('wb:update-ready', pendingUpdate); });

  // atajos que en el navegador vienen solos: F5, Ctrl+F5, zoom
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const k = i.key.toLowerCase(), c = i.control || i.meta;
    if (k === 'f5' || (c && k === 'r')) { e.preventDefault(); (c || i.shift) ? win.webContents.reloadIgnoringCache() : win.webContents.reload(); }
    else if (c && (k === '=' || k === '+')) { e.preventDefault(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5); }
    else if (c && k === '-') { e.preventDefault(); win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5); }
    else if (c && k === '0') { e.preventDefault(); win.webContents.setZoomLevel(0); }
    else if (c && i.shift && k === 'i') { e.preventDefault(); win.webContents.toggleDevTools(); }
  });

  // cerrar: con el ícono en la barra, se esconde (el reloj sigue); sin él, se cierra
  const keepBounds = () => { if (!win || win.isDestroyed()) return; cfg.maximized = win.isMaximized(); if (!cfg.maximized && !win.isMinimized()) cfg.bounds = win.getBounds(); saveCfg(); };
  win.on('resize', keepBounds); win.on('move', keepBounds);
  win.on('close', e => { keepBounds(); if (!quitting && cfg.tray && tray) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  win.loadURL(APP_URL);
}
function showWin() { if (!win) return createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

/* ───────── ícono en la barra de Windows ───────── */
function setTray(on) {
  if (!on) { if (tray) { tray.destroy(); tray = null; } return; }
  if (tray) return;
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'tray.png'));
  tray = new Tray(img); tray.setToolTip('Whiteboard Clock');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir Whiteboard Clock', click: showWin },
    { label: 'Abrir Whiteboard Tasks', click: () => { showWin(); win.loadURL(APP_URL + 'tasks.html'); } },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWin);
}

/* ───────── lo que la página le puede pedir a la app ───────── */
ipcMain.on('wb:info', e => { e.returnValue = { version: app.getVersion(), dev: DEV_URL || '', settings: { autoStart: !!cfg.autoStart, tray: !!cfg.tray } }; });
ipcMain.handle('wb:idle', () => powerMonitor.getSystemIdleTime()); // segundos sin tocar mouse ni teclado, en toda la compu
ipcMain.handle('wb:set', (e, k, v) => {
  if (k === 'autoStart') { cfg.autoStart = !!v; applyAutoStart(); }
  if (k === 'tray') { cfg.tray = !!v; setTray(cfg.tray); }
  saveCfg(); return true;
});
ipcMain.handle('wb:open', (e, url) => openOutside(String(url || '')));
ipcMain.handle('wb:restart', () => { quitting = true; autoUpdater.quitAndInstall(true, true); });
ipcMain.handle('wb:check', async () => {
  if (!app.isPackaged) return 'none';
  try { const r = await autoUpdater.checkForUpdates(); return r && r.isUpdateAvailable ? 'found' : 'none'; } catch { return 'error'; }
});

/* ───────── actualizaciones de la app (las de la página llegan solas) ───────── */
function startUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', info => { pendingUpdate = info.version; if (win) win.webContents.send('wb:update-ready', info.version); });
  autoUpdater.on('error', () => { /* sin internet o GitHub caído: se vuelve a probar más tarde */ });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check(); setInterval(check, 3 * 3600e3);
}

/* ───────── arranque ───────── */
app.on('second-instance', showWin);
app.whenReady().then(() => {
  loadCfg(); applyAutoStart();
  // Google no deja iniciar sesión desde "apps": la ventana se presenta como el Chrome que es por dentro
  const ua = session.defaultSession.getUserAgent().replace(/\s?Electron\/[\d.]+/, '').replace(/\s?whiteboard-clock-desktop\/[\d.]+/i, '').replace(/\s?Whiteboard Clock\/[\d.]+/i, '');
  session.defaultSession.setUserAgent(ua); app.userAgentFallback = ua;
  Menu.setApplicationMenu(null);
  createWindow(); setTray(cfg.tray); startUpdates();
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!cfg.tray || !tray) app.quit(); });
