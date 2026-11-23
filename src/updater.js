'use strict';
// Verifica se há versão nova na última release do GitHub e, quando o formato permite, baixa e instala.
//   • instalador do Windows (NSIS) e AppImage: electron-updater baixa e instala ao reiniciar;
//   • .exe portátil e .deb: só avisa e abre a página da release.
const { app, shell, Notification } = require('electron');

const REPO = 'devhygor/Hyperdesk';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const EVERY = 6 * 60 * 60 * 1000;

const info = {
  current: app.getVersion(),
  latest: null,
  url: RELEASES,
  state: 'idle', // idle | available | downloading | ready | error
  canInstall: false,
  progress: 0,
  error: null,
};
let onChange = () => {};
let onClickNotification = () => {};
let notified = null;
let updater = null;

function canAutoInstall() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_FILE;
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return false;
}

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

const set = (patch) => { Object.assign(info, patch); onChange({ ...info }); };

async function check() {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'Hyperdesk-updater', Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) return info;
    const rel = await r.json();
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!latest || !newer(latest, info.current)) return info;
    if (info.state === 'downloading' || info.state === 'ready') return info;
    set({ latest, url: rel.html_url || RELEASES, state: 'available', canInstall: canAutoInstall() });
    if (notified !== latest && Notification.isSupported()) {
      notified = latest;
      const n = new Notification({
        title: 'Hyperdesk: nova versão',
        body: `A versão ${latest} está disponível (você tem a ${info.current}). Clique para atualizar.`,
      });
      n.on('click', () => onClickNotification());
      n.show();
    }
  } catch (e) {
    console.error('[atualização]', e.message);
  }
  return info;
}

async function install() {
  if (!info.canInstall) { shell.openExternal(info.url); return; }
  try {
    if (!updater) {
      updater = require('electron-updater').autoUpdater;
      updater.autoDownload = false;
      updater.autoInstallOnAppQuit = true;
      updater.on('download-progress', (p) => set({ progress: Math.round(p.percent || 0) }));
      updater.on('update-downloaded', () => set({ state: 'ready', progress: 100 }));
      updater.on('error', (e) => set({ state: 'error', error: String(e?.message || e) }));
    }
    set({ state: 'downloading', progress: 0, error: null });
    await updater.checkForUpdates();
    await updater.downloadUpdate();
  } catch (e) {
    set({ state: 'error', error: String(e?.message || e) });
  }
}

function restart() {
  if (updater && info.state === 'ready') updater.quitAndInstall(false, true);
}

function start({ changed, clicked }) {
  onChange = changed || onChange;
  onClickNotification = clicked || onClickNotification;
  setTimeout(check, 8000);
  setInterval(check, EVERY);
}

module.exports = { start, check, install, restart, info: () => ({ ...info }), RELEASES };
