// Whiteboard Clock para Windows.
// Es una ventana que abre la app web (whiteboard-clock.web.app): lo de adentro se actualiza solo con cada deploy.
// Lo que suma la app de escritorio:
//  · la inactividad se mide desde Windows (mouse y teclado de toda la compu), sin pedir permisos al navegador;
//  · los links de afuera (Drive, Discord…) se abren en el navegador predeterminado;
//  · arranca con Windows y queda un ícono en la barra (se prende y apaga desde Configuración);
//  · se actualiza sola y avisa con un cartel para reiniciar;
//  · los íconos muestran si el reloj corre o está en pausa, y hay un mini reloj fijo sobre la barra de Windows.
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, powerMonitor, nativeImage, session, dialog, screen } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
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

/* ───────── links "whiteboardclock://" (la página los usa para abrir una tarea en la app) ───────── */
const PROTO = 'whiteboardclock';
if (app.isPackaged) app.setAsDefaultProtocolClient(PROTO); else if (process.argv[1]) app.setAsDefaultProtocolClient(PROTO, process.execPath, [path.resolve(process.argv[1])]);
/** whiteboardclock://open/?u=tasks%23%2Ft%2F12 → "tasks#/t/12" (solo páginas de la app: Tasks o Clock, nunca otra web). */
function linkTarget(argv) {
  const raw = (argv || []).find(a => typeof a === 'string' && a.toLowerCase().startsWith(PROTO + '://')); if (!raw) return null;
  try { const u = new URL(raw).searchParams.get('u') || ''; return /^(tasks(\.html)?)?#\/[\w/-]*$/.test(u) || /^(tasks(\.html)?)?$/.test(u) ? u : null; } catch { return null; }
}
let pendingLink = linkTarget(process.argv);
/** Opens that page of the app in the window (same page: only the part after # changes, without reloading). */
function openLink(rel) {
  if (!rel) return;
  if (!win) { pendingLink = rel; return createWindow(); }
  showWin();
  const want = new URL(rel, APP_URL), cur = (() => { try { return new URL(win.webContents.getURL()); } catch { return null; } })();
  const page = x => x.pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/index';
  if (cur && cur.origin === want.origin && page(cur) === page(want)) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(want.hash)}`).catch(() => win.loadURL(want.href));
  else win.loadURL(want.href);
}

/* ───────── opciones (arrancar con Windows, ícono en la barra, tamaño de la ventana) ───────── */
const cfgFile = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = { autoStart: true, tray: true, mini: true, bounds: null, maximized: false };
let cfg = { ...DEFAULTS };
function loadCfg() { try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { cfg = { ...DEFAULTS }; } delete cfg.miniPos; }
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
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true, backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  if (cfg.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });

  // links: los de la app quedan adentro; el inicio de sesión de Google abre su ventanita; todo lo demás, al navegador predeterminado
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAuth(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 680, autoHideMenuBar: true, parent: win, modal: false, webPreferences: { preload: path.join(__dirname, 'auth-preload.js'), contextIsolation: true, sandbox: true } } };
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
  win.on('close', e => {
    keepBounds();
    if (quitting) return;
    e.preventDefault();
    if (cfg.tray && tray) win.hide(); else quitFlow();
  });
  // el aviso de "si cerrás se pausa" de la página no tiene que trabar la salida: de eso se encarga quitFlow
  win.webContents.on('will-prevent-unload', e => e.preventDefault());
  win.on('session-end', () => { quitting = true; }); // Windows se apaga: salir sin preguntar
  win.on('show', () => handleAfk()); win.on('hide', () => handleAfk());
  win.on('closed', () => { win = null; if (mini && !mini.isDestroyed()) mini.destroy(); mini = null; });
  win.loadURL(pendingLink ? new URL(pendingLink, APP_URL).href : APP_URL); pendingLink = null;
}
/* ───────── salir: si el reloj está corriendo, preguntar y pausarlo antes de cerrar ───────── */
const withTimeout = (p, ms, v) => Promise.race([p, new Promise(r => setTimeout(() => r(v), ms))]);
const runInPage = (code, ms) => (win && !win.isDestroyed()) ? withTimeout(win.webContents.executeJavaScript(code, true).catch(() => null), ms, null) : Promise.resolve(null);
let asking = false;
async function quitFlow() {
  if (quitting || asking) return;
  asking = true;
  try {
    const info = await runInPage('window.__wbQuitInfo ? window.__wbQuitInfo() : null', 3000);
    if (info && info.running) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      const { response } = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['Pausar y salir', 'Cancelar'], defaultId: 0, cancelId: 1, noLink: true,
        title: 'Whiteboard Clock', message: 'Tenés el reloj prendido',
        detail: `${info.label || 'Sin tarea'}\n\nSi salís, el reloj queda en pausa.`,
      });
      if (response !== 0) return;
      await runInPage('window.__wbPauseForQuit ? window.__wbPauseForQuit() : true', 8000);
    }
    quitting = true; refreshMini(); app.quit();
  } finally { asking = false; }
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
    { label: 'Salir', click: () => quitFlow() },
  ]));
  tray.on('click', showWin);
  paintClock();
}

/* ───────── lo que la página le puede pedir a la app ───────── */
ipcMain.on('wb:info', e => { e.returnValue = { version: app.getVersion(), dev: DEV_URL || '', settings: { autoStart: !!cfg.autoStart, tray: !!cfg.tray, mini: !!cfg.mini } }; });
ipcMain.handle('wb:idle', () => powerMonitor.getSystemIdleTime()); // segundos sin tocar mouse ni teclado, en toda la compu
ipcMain.handle('wb:set', (e, k, v) => {
  if (k === 'autoStart') { cfg.autoStart = !!v; applyAutoStart(); }
  if (k === 'tray') { cfg.tray = !!v; setTray(cfg.tray); }
  if (k === 'mini') { cfg.mini = !!v; refreshMini(); }
  saveCfg(); return true;
});
ipcMain.handle('wb:open', (e, url) => openOutside(String(url || '')));
ipcMain.handle('wb:show', () => showWin());

/* ───────── el reloj en los íconos y el mini reloj sobre la barra ─────────
   La página avisa cada vez que el reloj arranca, se pausa o se detiene (y cada 30 s, con lo que lleva). */
const img = f => nativeImage.createFromPath(path.join(__dirname, '..', 'build', f));
const ICONS = { run: { ov: img('ov-run.png'), tray: img('tray-run.png') }, pause: { ov: img('ov-pause.png'), tray: img('tray-pause.png') }, off: { ov: null, tray: img('tray.png') } };
let clock = { state: 'off', label: '', dur: 0, at: 0, afk: null };
ipcMain.on('wb:clock', (e, v) => {
  if (!win || e.sender !== win.webContents || !v) return;
  const state = ['run', 'pause'].includes(v.state) ? v.state : 'off';
  const a = v.afk && typeof v.afk === 'object' && ['ask', 'paused'].includes(v.afk.kind) ? v.afk : null;
  const afk = a ? { kind: a.kind, key: String(a.key || '').slice(0, 200), since: Number(a.since) || 0, deadline: Number(a.deadline) || 0, pausedAt: Number(a.pausedAt) || 0, why: String(a.why || 'idle').slice(0, 20) } : null;
  clock = { state, label: String(v.label || '').slice(0, 120), dur: Number(v.dur) || 0, at: Number(v.at) || Date.now(), afk };
  paintClock();
});
function paintClock() {
  const ic = ICONS[clock.state];
  if (win && !win.isDestroyed()) win.setOverlayIcon(ic.ov, clock.state === 'run' ? 'Reloj corriendo' : clock.state === 'pause' ? 'Reloj en pausa' : '');
  if (tray) {
    tray.setImage(ic.tray);
    tray.setToolTip((clock.state === 'run' ? '▶ ' + clock.label : clock.state === 'pause' ? '⏸ En pausa · ' + clock.label : 'Whiteboard Clock').slice(0, 120));
  }
  refreshMini(); handleAfk();
}

// ¿hay un juego o un video en pantalla completa? (ahí el mini reloj se esconde)
// Se mira la ventana de adelante: si ocupa toda una pantalla y no es de Windows (escritorio, barra, menú Inicio,
// íconos ocultos…), es un juego o un video en pantalla completa. Además, los juegos en pantalla completa "exclusiva".
let W32 = null;
try {
  if (process.platform === 'win32') {
    const koffi = require('koffi'), u = koffi.load('user32.dll'), sh = koffi.load('shell32.dll');
    const RECT = koffi.struct('WB_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    W32 = {
      quns: sh.func('int __stdcall SHQueryUserNotificationState(_Out_ int *pquns)'),
      fg: u.func('void * __stdcall GetForegroundWindow()'),
      rect: u.func('bool __stdcall GetWindowRect(void *hWnd, _Out_ WB_RECT *lpRect)'),
      cls: u.func('int __stdcall GetClassNameW(void *hWnd, _Out_ uint8_t *lpClassName, int nMaxCount)'),
      find: u.func('void * __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)'),
      findEx: u.func('void * __stdcall FindWindowExW(void *hParent, void *hAfter, str16 lpClassName, str16 lpWindowName)'),
      visible: u.func('bool __stdcall IsWindowVisible(void *hWnd)'),
      RECT,
    };
  }
} catch { W32 = null; }
const SHELL = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland',
  'Windows.UI.Core.CoreWindow', 'XamlExplorerHostIslandWindow', 'ForegroundStaging', 'MultitaskingViewFrame', 'TaskSwitcherWnd', 'Shell_InputSwitchTopLevelWindow']);
function fullScreenNow() {
  if (!W32) return false;
  try {
    const q = [0]; if (W32.quns(q) === 0 && (q[0] === 3 || q[0] === 4)) return true; // juego exclusivo o modo presentación
    const h = W32.fg(); if (!h) return false;
    const buf = Buffer.alloc(512), n = W32.cls(h, buf, 256), cls = buf.toString('utf16le', 0, Math.max(0, n) * 2);
    if (SHELL.has(cls)) return false;
    const r = {}; if (!W32.rect(h, r)) return false;
    const d = screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
    return screen.getAllDisplays().some(x => Math.abs(d.x - x.bounds.x) <= 2 && Math.abs(d.y - x.bounds.y) <= 2 && d.width >= x.bounds.width - 2 && d.height >= x.bounds.height - 2);
  } catch { return false; }
}

const MINI_W = 330;
let mini = null, miniReady = false, fsBusy = false, fsHits = 0, spotTick = 0;
// Dónde están los íconos de al lado de la hora (la flechita ^, los íconos, la hora): la barra de la pantalla principal.
// Sirve en Windows 10 y 11, con la barra abajo o arriba, y con cualquier zoom de pantalla. Si no se puede leer, null.
function trayArea() {
  if (!W32) return null;
  try {
    const bar = W32.find('Shell_TrayWnd', null); if (!bar) return null;
    const box = r => { const o = {}; if (!W32.rect(r, o)) return null; return screen.screenToDipRect(null, { x: o.left, y: o.top, width: o.right - o.left, height: o.bottom - o.top }); };
    const notify = W32.findEx(bar, null, 'TrayNotifyWnd', null);
    // todo lo que Windows pone a la derecha de la barra como ventana propia (en Windows 10, por ejemplo, "Noticias e intereses" con el clima)
    const right = []; let c = null;
    for (let k = 0; k < 64; k++) {
      c = W32.findEx(bar, c, null, null); if (!c) break;
      if (!W32.visible(c)) continue;
      const r = box(c); if (r && r.width > 0 && r.height > 0) right.push(r);
    }
    return { bar: box(bar), tray: notify ? box(notify) : null, kids: right };
  } catch { return null; }
}
// Windows 11: el clima (botón de Widgets) no es una ventana aparte; se pregunta a Windows dónde está (cada 30 s, sin trabar nada).
// Se guarda como proporción desde el borde derecho de la barra, así no importa el zoom de la pantalla.
let widgets = { at: 0, busy: false, fromRight: null, guess: null };
function readWidgets() {
  if (widgets.busy || Date.now() - widgets.at < 30e3 || process.platform !== 'win32') return;
  widgets.busy = true; widgets.at = Date.now();
  const ps = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A=[System.Windows.Automation.AutomationElement]
$tb=$A::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty,'Shell_TrayWnd')))
$w=$tb.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty,'WidgetsButton')))
$t=$tb.Current.BoundingRectangle
if($w -and -not $w.Current.IsOffscreen){$r=$w.Current.BoundingRectangle; "OK $($t.Left) $($t.Right) $($r.Left) $($r.Right)"} else {"NONE"}`;
  require('child_process').execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, timeout: 10e3 }, (err, out) => {
    widgets.busy = false;
    const m = !err && String(out).match(/OK\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
    if (m) { const [L, R, wl] = [+m[1], +m[2], +m[3]]; widgets.fromRight = R > L ? (R - wl) / (R - L) : null; }
    else if (!err && /NONE/.test(out)) widgets.fromRight = null;
    else widgets.fromRight = undefined; // no se pudo preguntar: se usa la configuración de la barra
    if (widgets.fromRight === undefined) readWidgetsReg();
    refreshMini();
  });
}
// plan B: con el clima prendido y los íconos a la izquierda, Windows 11 lo pone al lado de la flechita ^
function readWidgetsReg() {
  require('child_process').execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'], { windowsHide: true, timeout: 5e3 }, (err, out) => {
    if (err) { widgets.guess = null; return; }
    const v = k => { const m = String(out).match(new RegExp(k + '\\s+REG_DWORD\\s+0x([0-9a-f]+)', 'i')); return m ? parseInt(m[1], 16) : null; };
    const on = v('TaskbarDa') !== 0, left = v('TaskbarAl') === 0;
    widgets.guess = on && left ? 170 : 0; refreshMini();
  });
}
function miniRect() {
  const d = screen.getPrimaryDisplay(), b = d.bounds, w = d.workArea;
  const below = (b.y + b.height) - (w.y + w.height), above = w.y - b.y, th = below || above;
  if (th < 20) return null; // la barra se oculta sola o está al costado: no hay lugar fijo
  const h = Math.max(24, Math.min(36, th - 4));
  const y = below ? w.y + w.height + Math.round((below - h) / 2) : b.y + Math.round((above - h) / 2);
  const win11 = process.platform === 'win32' && Number(os.release().split('.')[2] || 0) >= 22000;
  let x = b.x + b.width - MINI_W - (win11 ? 290 : 300); // por si no se pudo leer dónde están los íconos
  const ta = trayArea(), t = ta?.tray;
  // solo si lo que leyó tiene sentido: dentro de la pantalla, a la derecha, y no más ancho que media pantalla
  if (t && t.width > 30 && t.width < b.width / 2 && t.x > b.x + MINI_W + 40 && t.x + t.width <= b.x + b.width + 4) {
    let left = t.x;
    const mid = b.x + b.width / 2;
    // lo que haya pegado a la izquierda de los íconos (el clima de Windows 10, por ejemplo): el mini reloj va antes
    for (const k of ta.kids || []) if (k.x > mid && k.x < left && k.x + k.width <= t.x + 4 && k.width < b.width / 3) left = k.x;
    // Windows 11: el botón del clima, si está a la derecha
    if (win11) {
      readWidgets();
      const bar = ta.bar;
      if (widgets.fromRight > 0 && widgets.fromRight < 0.5 && bar) { const wl = bar.x + bar.width - widgets.fromRight * bar.width; if (wl > mid && wl < left) left = wl; }
      else if (widgets.fromRight === undefined && widgets.guess) left -= widgets.guess;
    }
    x = left - MINI_W - 8;
  }
  return { x: Math.round(x), y: Math.round(y), width: MINI_W, height: h };
}
function makeMini(r) {
  mini = new BrowserWindow({ ...r, frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, movable: false, alwaysOnTop: true, show: false, hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'mini-preload.js'), contextIsolation: true, sandbox: true } });
  mini.setAlwaysOnTop(true, 'screen-saver');
  mini.setMenuBarVisibility(false);
  miniReady = false;
  mini.loadFile(path.join(__dirname, 'mini.html'));
  mini.on('closed', () => { mini = null; miniReady = false; });
}
function refreshMini() {
  if (!app.isReady()) return;
  const r = (cfg.mini && clock.state !== 'off' && !fsBusy && win && !quitting) ? miniRect() : null;
  if (!r) { if (mini && !mini.isDestroyed() && mini.isVisible()) mini.hide(); return; }
  if (!mini || mini.isDestroyed()) makeMini(r);
  // con la pantalla al 125 % o 150 % Windows redondea: solo se mueve si de verdad cambió (si no, parpadea)
  const b = mini.getBounds(); if (Math.abs(b.x - r.x) > 2 || Math.abs(b.y - r.y) > 2 || Math.abs(b.width - r.width) > 2 || Math.abs(b.height - r.height) > 2) mini.setBounds(r);
  if (miniReady) mini.webContents.send('mini:state', clock);
  if (miniReady && !mini.isVisible()) mini.showInactive();
}
const fromUs = e => (mini && !mini.isDestroyed() && e.sender === mini.webContents) || (toast && !toast.isDestroyed() && e.sender === toast.webContents);
ipcMain.on('mini:ready', e => {
  if (mini && !mini.isDestroyed() && e.sender === mini.webContents) { miniReady = true; refreshMini(); }
  else if (toast && !toast.isDestroyed() && e.sender === toast.webContents) { toastReady = true; handleAfk(); }
});
ipcMain.on('mini:cmd', (e, c) => { if (!fromUs(e) || !win) return; if (['pause', 'resume', 'stop', 'afk-ok', 'afk-pause', 'afk-resume', 'afk-keep'].includes(c)) win.webContents.send('wb:clock-cmd', c); });
ipcMain.on('mini:open', e => { if (fromUs(e)) showWin(); });

/* ───────── "¿Seguís ahí?" ─────────
   Con la ventana abierta: la trae adelante y el cartel sale en la página, como en la web.
   Con la ventana cerrada (en la barra): un cartel propio abajo a la derecha, encima de todo, que se responde ahí mismo. */
let toast = null, toastReady = false, afkSeen = '';
const TOAST_W = 360, TOAST_H = 168;
function toastRect() {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - TOAST_W - 12, y: wa.y + wa.height - TOAST_H - 12, width: TOAST_W, height: TOAST_H };
}
function hideToast() { if (toast && !toast.isDestroyed() && toast.isVisible()) toast.hide(); }
function showToast() {
  const r = toastRect();
  if (!toast || toast.isDestroyed()) {
    toast = new BrowserWindow({ ...r, frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'mini-preload.js'), contextIsolation: true, sandbox: true } });
    toast.setAlwaysOnTop(true, 'screen-saver');
    toastReady = false;
    toast.loadFile(path.join(__dirname, 'toast.html'));
    toast.on('closed', () => { toast = null; toastReady = false; });
  }
  const b = toast.getBounds(); if (Math.abs(b.x - r.x) > 2 || Math.abs(b.y - r.y) > 2) toast.setBounds(r);
  if (!toastReady) return;
  toast.webContents.send('mini:state', clock);
  if (!toast.isVisible()) toast.showInactive(); else toast.moveTop();
}
function handleAfk() {
  const a = clock.afk;
  if (!a || quitting) { afkSeen = ''; hideToast(); if (win && !win.isDestroyed()) win.flashFrame(false); return; }
  const open = win && !win.isDestroyed() && win.isVisible();
  if (afkSeen !== a.key) {
    afkSeen = a.key;
    if (open) { // la ventana está abierta: adelante, con el ícono titilando, y el cartel lo muestra la página
      if (win.isMinimized()) win.restore();
      win.show(); win.setAlwaysOnTop(true); win.focus(); win.setAlwaysOnTop(false); win.flashFrame(true);
    }
  }
  if (open) hideToast(); else showToast();
}
function watchMini() {
  if (process.platform === 'win32' && Number(os.release().split('.')[2] || 0) >= 22000) readWidgets(); // así ya se sabe dónde está el clima antes de mostrar el mini reloj
  setInterval(() => {
    // se esconde recién si la pantalla completa sigue un momento (abrir el menú o los íconos ocultos no cuenta); vuelve al toque
    const fs1 = fullScreenNow(); fsHits = fs1 ? fsHits + 1 : 0;
    const busy = fsHits >= 3; if (busy !== fsBusy) { fsBusy = busy; refreshMini(); }
    else if (mini && !mini.isDestroyed() && mini.isVisible() && ++spotTick % 5 === 0) refreshMini(); // cada 2 s: si aparecieron íconos o cambió la pantalla, se reacomoda
    if (mini && !mini.isDestroyed() && mini.isVisible()) mini.moveTop();
    if (toast && !toast.isDestroyed() && toast.isVisible()) toast.moveTop(); // si tocás la barra, Windows la pone adelante: el mini reloj vuelve arriba
  }, 400);
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => refreshMini());
}

/* ───────── "Continuar con Google" en el navegador de la persona ─────────
   Google se abre en su navegador (con su cuenta, autocompletar y llaves de acceso). Esa página, al terminar, vuelve a
   http://127.0.0.1:PUERTO/cb con el inicio de sesión; la app lo recibe acá (solo desde esta misma compu) y entra. */
let loginWait = null;
ipcMain.handle('wb:google', () => {
  if (loginWait) loginWait.finish(null);
  return new Promise(resolve => {
    const state = crypto.randomBytes(24).toString('base64url');
    let done = false, timer = null;
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/cb' || u.searchParams.get('s') !== state) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Whiteboard Clock</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#1a1d21;color:#e6e8eb;font:16px 'Segoe UI',system-ui,sans-serif;text-align:center"><div><h2 style="font-weight:600;margin:0 0 8px">Listo</h2><p style="color:#9aa3ad;margin:0">Ya entraste en la app de Whiteboard Clock.<br>Esta pestaña se puede cerrar.</p></div><script>history.replaceState(null,'','/');setTimeout(()=>window.close(),800)</script>`);
      finish({ idToken: u.searchParams.get('id') || '', accessToken: u.searchParams.get('at') || '' });
      showWin();
    });
    const finish = v => { if (done) return; done = true; clearTimeout(timer); try { srv.close(); } catch { /* */ } loginWait = null; resolve(v); };
    loginWait = { finish };
    srv.on('error', () => finish(null));
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      shell.openExternal(`${APP_URL}?desk=login&p=${port}&s=${state}`);
      timer = setTimeout(() => finish(null), 5 * 60e3); // 5 minutos para terminar en el navegador
    });
  });
});
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
app.on('second-instance', (e, argv) => { const l = linkTarget(argv); if (l) openLink(l); else showWin(); });
app.whenReady().then(() => {
  loadCfg(); applyAutoStart();
  // Google no deja iniciar sesión desde "apps": la ventana se presenta como el Chrome que es por dentro
  const ua = session.defaultSession.getUserAgent().replace(/\s?Electron\/[\d.]+/, '').replace(/\s?whiteboard-clock-desktop\/[\d.]+/i, '').replace(/\s?Whiteboard Clock\/[\d.]+/i, '');
  session.defaultSession.setUserAgent(ua); app.userAgentFallback = ua;
  Menu.setApplicationMenu(null);
  createWindow(); setTray(cfg.tray); startUpdates(); watchMini();
});
app.on('before-quit', () => { quitting = true; }); // actualizar o apagar Windows: salir directo
app.on('window-all-closed', () => { if (!cfg.tray || !tray) app.quit(); });
