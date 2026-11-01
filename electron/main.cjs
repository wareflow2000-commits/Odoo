'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

app.setName('OW');
const APP_ROOT = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = 47831;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};
let localServer;
let mainWindow;

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function startLocalServer() {
  return new Promise((resolve, reject) => {
    const root = path.resolve(APP_ROOT);
    localServer = http.createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
      let pathname;
      try { pathname = decodeURIComponent(new URL(req.url, 'http://' + HOST + ':' + PORT).pathname); }
      catch (_) { return send(res, 400, 'Bad Request'); }
      if (pathname === '/') pathname = '/index.html';
      const filePath = path.resolve(root, '.' + pathname);
      if (filePath !== root && !filePath.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
      fs.stat(filePath, (statError, stat) => {
        if (statError || !stat.isFile()) return send(res, 404, 'Not Found');
        const stream = fs.createReadStream(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Cache-Control': 'no-store',
          'Content-Length': stat.size
        });
        if (req.method === 'HEAD') return res.end();
        stream.on('error', () => { if (!res.headersSent) send(res, 500, 'Read Error'); else res.destroy(); });
        stream.pipe(res);
      });
    });
    localServer.on('error', reject);
    localServer.listen(PORT, HOST, () => resolve('http://' + HOST + ':' + PORT + '/index.html'));
  });
}

async function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f2eff2',
    icon: path.join(APP_ROOT, 'assets', 'OW Monogram on Plum App Icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https:\/\//i.test(target)) shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith('http://' + HOST + ':' + PORT + '/')) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(url);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    try {
      const url = await startLocalServer();
      await createWindow(url);
    } catch (error) {
      dialog.showErrorBox('OW — تعذر تشغيل التطبيق', 'تعذر بدء خادم التطبيق المحلي على المنفذ ' + PORT + '. أغلق أي تطبيق آخر يستخدم المنفذ ثم أعد المحاولة.\n\n' + String(error.message || error));
      app.quit();
    }
  });
}
app.on('before-quit', () => { if (localServer) localServer.close(); });
app.on('window-all-closed', () => app.quit());
