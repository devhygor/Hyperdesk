'use strict';
// Hyperdesk — processo principal.
// Cada PC roda o mesmo app e é, ao mesmo tempo:
//   • servidor: anuncia-se na rede (UDP), aceita uma conexão por vez (WebSocket p/ sinalização),
//     transmite a tela por WebRTC e aplica o mouse/teclado recebidos (SendInput);
//   • cliente: lista os PCs da rede e abre janelas de visualização para controlá-los.
const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen, clipboard,
  Tray, Menu, nativeImage, safeStorage, shell,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const dgram = require('dgram');
const { WebSocketServer } = require('ws');
const { Injector } = require('./input/injector');
const { KEYMAP } = require('./keymap');
const updater = require('./updater');

const DEV = !app.isPackaged;
const env = (k) => (DEV ? process.env[k] : undefined);

// Perfis separados só para testar duas instâncias no mesmo PC (npm start com HMD_PROFILE=b).
if (env('HMD_PROFILE')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Hyperdesk-' + env('HMD_PROFILE')));
}
// ---------------------------------------------------------------- log em arquivo
// Tudo o que vai para o console também vai para <userData>/logs/hyperdesk.log (troca ao passar de
// 2 MB, guardando o anterior como .old), para dar para diagnosticar sem terminal aberto.
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'hyperdesk.log');
(() => {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch {}
  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch {}
  };
  for (const [name, level] of [['log', 'INFO'], ['warn', 'WARN'], ['error', 'ERRO']]) {
    const orig = console[name].bind(console);
    console[name] = (...a) => { write(level, a); orig(...a); };
  }
  console.log(`[Hyperdesk] iniciando v${app.getVersion()} em ${process.platform} ${os.release()} ` +
    `(sessão ${process.env.XDG_SESSION_TYPE || '-'}, electron ${process.versions.electron})`);
  process.on('uncaughtException', (e) => console.error('[erro não tratado]', e));
  process.on('unhandledRejection', (e) => console.error('[promessa rejeitada]', e));
  app.on('render-process-gone', (_e, wc, d) => console.error('[processo de janela morreu]', wc.getURL().split('/').pop(), d.reason, d.exitCode));
  app.on('child-process-gone', (_e, d) => console.error('[processo interno morreu]', d.type, d.reason, d.exitCode, d.serviceName || ''));
})();

const PORT = Number(env('HMD_PORT')) || 47810;
const DISCOVERY_PORT = 47811;
const APP_ID = 'hyperdesk';
const PBKDF2_ITER = 120000;

const gotLock = env('HMD_PROFILE') ? true : app.requestSingleInstanceLock();
if (!gotLock) app.quit();

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Linux: a partir do Electron 38 o app já abre como Wayland nativo numa sessão Wayland (no Electron 33
// rodava via XWayland, e capturar a tela pelo PipeWire nessa mistura derrubava o processo principal).
// A captura no Wayland passa pelo portal do sistema (PipeWire), ligado por padrão.

// ---------------------------------------------------------------- configurações
let settings = {};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { settings = {}; }
  settings.deviceId ||= crypto.randomUUID();
  settings.salt ||= crypto.randomBytes(16).toString('hex');
  settings.allowIncoming ??= true;
  settings.savedKeys ||= {};
  settings.recent ||= [];
  saveSettings();
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

const myName = () => settings.name || os.hostname();

function myIps() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ ifname, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

// ---------------------------------------------------------------- autenticação
// O segredo (código de 6 dígitos ou senha fixa) nunca passa pela rede: o cliente deriva
// PBKDF2(segredo, salt) e devolve HMAC(chave, nonce). A senha fixa fica guardada só como chave derivada.
function normalizeSecret(s) {
  s = String(s ?? '').trim();
  return /^[\d\s]+$/.test(s) ? s.replace(/\s+/g, '') : s;
}

function deriveKey(secret) {
  return crypto.pbkdf2Sync(normalizeSecret(secret), Buffer.from(settings.salt, 'hex'), PBKDF2_ITER, 32, 'sha256');
}

const access = { code: '', codeKey: null };

function newCode() {
  access.code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  access.codeKey = deriveKey(access.code);
  pushState();
}

function checkProof(proofHex, nonce) {
  let proof;
  try { proof = Buffer.from(String(proofHex), 'hex'); } catch { return null; }
  if (proof.length !== 32) return null;
  const candidates = [['code', access.codeKey]];
  if (settings.passwordKey) candidates.push(['password', Buffer.from(settings.passwordKey, 'hex')]);
  for (const [via, key] of candidates) {
    if (!key) continue;
    const expected = crypto.createHmac('sha256', key).update(nonce).digest();
    if (crypto.timingSafeEqual(expected, proof)) return via;
  }
  return null;
}

const fails = new Map(); // ip -> { count, until }
function registerFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) { f.until = Date.now() + 5 * 60_000; f.count = 0; }
  fails.set(ip, f);
}

// ---------------------------------------------------------------- servidor (este PC sendo controlado)
const injector = new Injector();
let wss = null;
let session = null; // { ws, send, peer, ip, screens, current }

function startServer() {
  wss = new WebSocketServer({ port: PORT, maxPayload: 1 << 20 });
  wss.on('error', (e) => console.error('[servidor]', e.message));
  wss.on('connection', (ws, req) => {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

    if (!settings.allowIncoming) { send({ type: 'error', reason: 'disabled' }); return ws.close(); }
    if (session) { send({ type: 'error', reason: 'busy' }); return ws.close(); }
    const lock = fails.get(ip);
    if (lock && lock.until > Date.now()) { send({ type: 'error', reason: 'locked' }); return ws.close(); }

    let authed = false;
    let nonce = '';
    const challenge = () => {
      nonce = crypto.randomBytes(16).toString('hex');
      send({
        type: 'challenge', nonce, salt: settings.salt, iter: PBKDF2_ITER,
        hostId: settings.deviceId, hostName: myName(),
      });
    };
    challenge();
    const timeout = setTimeout(() => { if (!authed) ws.close(); }, 3 * 60_000);

    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }

      if (!authed) {
        if (m.type !== 'auth') return;
        if (session) { send({ type: 'error', reason: 'busy' }); return ws.close(); }
        const via = checkProof(m.proof, nonce);
        if (!via) {
          registerFail(ip);
          const l = fails.get(ip);
          if (l.until > Date.now()) { send({ type: 'error', reason: 'locked' }); return ws.close(); }
          send({ type: 'auth-fail' });
          return challenge();
        }
        authed = true;
        clearTimeout(timeout);
        fails.delete(ip);
        session = { ws, send, peer: String(m.name || 'Outro PC').slice(0, 60), ip, screens: [], current: null };
        try {
          session.screens = await listScreens();
        } catch (e) {
          console.error('[telas]', e);
        }
        const first = session.screens.find((s) => s.primary) || session.screens[0];
        if (!first) { send({ type: 'error', reason: 'noscreen' }); return ws.close(); }
        send({ type: 'auth-ok', via, screens: publicScreens(), current: first.sourceId });
        startCapture(first, true);
        showBanner();
        pushState();
        return;
      }

      if (session?.ws !== ws) return;
      if (m.type === 'answer' || m.type === 'ice') hostWin?.webContents.send('hmd:host', { type: 'signal', data: m });
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (session?.ws === ws) endSession();
    });
    ws.on('error', () => {});
  });
}

const IS_LINUX = process.platform === 'linux';

async function listScreens() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  // No Linux não chamamos o desktopCapturer aqui: no Wayland cada chamada abre a janela do sistema
  // para escolher a tela. A lista sai das telas do sistema, e a escolha de verdade é feita no portal.
  const sources = IS_LINUX
    ? displays.map((d) => ({ id: `display:${d.id}`, display_id: String(d.id) }))
    : await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  return sources.map((s, i) => {
    const d = displays.find((x) => String(x.id) === s.display_id) || displays[i] || primary;
    // pixels físicos (o SendInput trabalha neles); dipToScreenRect só existe no Windows
    const rect = process.platform === 'win32'
      ? screen.dipToScreenRect(null, d.bounds)
      : { x: Math.round(d.bounds.x * d.scaleFactor), y: Math.round(d.bounds.y * d.scaleFactor),
          width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) };
    return {
      sourceId: s.id,
      label: `Tela ${i + 1}${d.id === primary.id ? ' (principal)' : ''}`,
      width: rect.width,
      height: rect.height,
      primary: d.id === primary.id,
      rect,
    };
  });
}

const publicScreens = () =>
  (session?.screens || []).map(({ sourceId, label, width, height, primary }) => ({ sourceId, label, width, height, primary }));

function startCapture(scr, first) {
  session.current = scr;
  const rs = session.screens.map((s) => s.rect);
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  injector.layout({
    x: x0, y: y0,
    width: Math.max(...rs.map((r) => r.x + r.width)) - x0,
    height: Math.max(...rs.map((r) => r.y + r.height)) - y0,
  });
  const msg = {
    type: first ? 'start' : 'switch',
    sourceId: scr.sourceId, width: scr.width, height: scr.height,
    audio: !IS_LINUX && first, // som do sistema só no Windows (e só na primeira captura)
  };
  // A captura usa getDisplayMedia nos dois sistemas: o setDisplayMediaRequestHandler abaixo entrega
  // a tela pedida. É disparada com "gesto do usuário" porque a janela é invisível.
  pendingCapture = { sourceId: scr.sourceId, audio: msg.audio };
  hostWin.webContents
    .executeJavaScript(`window.__hmdHost(${JSON.stringify(msg)})`, true)
    .catch((e) => console.error('[servidor] captura:', e.message));
}

// Linux: o portal decide qual tela é capturada. Descobrimos qual é pelo tamanho do vídeo,
// para o mouse cair no lugar certo.
function onCaptured({ width, height, label }) {
  if (!session || !width || !height) return;
  console.log(`[servidor] capturando ${width}x${height} ${label || ''}`);
  if (!IS_LINUX) return; // no Windows a tela é exatamente a pedida
  const match = session.screens.find((s) => s.width === width && s.height === height)
    || session.screens.find((s) => Math.abs(s.width / s.height - width / height) < 0.01)
    || session.current;
  if (match && match !== session.current) {
    session.current = match;
    sendCtlToViewer({ t: 'screens', screens: publicScreens(), current: match.sourceId });
  }
}

// Responde ao getDisplayMedia da janela invisível.
//   • Windows: entrega a tela pedida (pendingCapture) e, na primeira captura, o som do sistema;
//   • Linux: no Wayland a chamada abre o portal do sistema e a pessoa escolhe a tela.
// O caminho antigo (getUserMedia + chromeMediaSourceId) ficava preso em ~38 fps no Electron 44 e
// derrubava o app no Wayland.
let pendingCapture = null;
function setupDisplayMediaHandler() {
  const { session: electronSession } = require('electron');
  electronSession.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const wanted = IS_LINUX ? sources[0]
        : sources.find((s) => s.id === pendingCapture?.sourceId) || sources[0];
      if (!wanted) return callback({});
      const streams = { video: wanted };
      if (!IS_LINUX && pendingCapture?.audio) streams.audio = 'loopback';
      callback(streams);
    } catch (e) {
      console.error('[servidor] portal:', e.message);
      callback({});
    }
  });
}

function endSession() {
  if (!session) return;
  hostWin?.webContents.send('hmd:host', { type: 'stop' });
  injector.releaseAll();
  try { session.ws.close(); } catch {}
  session = null;
  hideBanner();
  newCode(); // código novo a cada sessão
  pushState();
}

// ---- mensagens que chegam do PC controlador (via canal de dados do WebRTC)
function handleInput(str) {
  if (!session?.current) return;
  let m;
  try { m = JSON.parse(str); } catch { return; }
  const r = session.current.rect;
  const toPx = () => {
    const x = Math.min(Math.max(+m.x || 0, 0), 1);
    const y = Math.min(Math.max(+m.y || 0, 0), 1);
    return [r.x + x * (r.width - 1), r.y + y * (r.height - 1)];
  };
  switch (m.t) {
    case 'm': injector.move(...toPx()); break;
    case 'b':
      if ('x' in m) injector.move(...toPx());
      injector.button(m.b | 0, !!m.d);
      break;
    case 'w': injector.wheel(+m.y || 0, +m.x || 0); break;
    case 'k': {
      const entry = KEYMAP[m.c];
      if (entry) injector.key(m.c, entry, !!m.d);
      break;
    }
    case 'release': injector.releaseAll(); break;
  }
}

async function handleCtl(str) {
  if (!session) return;
  let m;
  try { m = JSON.parse(str); } catch { return; }
  if (m.t === 'screen') {
    session.screens = await listScreens().catch(() => session.screens);
    const scr = session.screens.find((s) => s.sourceId === m.sourceId);
    if (scr) {
      injector.releaseAll();
      startCapture(scr, false);
      sendCtlToViewer({ t: 'screens', screens: publicScreens(), current: scr.sourceId });
    }
  } else if (m.t === 'clip' && typeof m.text === 'string') {
    setClipboardFromRemote(m.text);
  }
}

// Linux: libera o /dev/uinput para o usuário logado (mesma regra do install.sh), pedindo a senha
// pela janela do sistema (pkexec), e reabre o injetor.
function fixLinuxInput() {
  if (process.platform !== 'linux') return { ok: false, message: 'Só no Linux.' };
  const script = [
    'mkdir -p /etc/udev/rules.d /etc/modules-load.d',
    `printf '%s\\n' 'KERNEL=="uinput", MODE="0660", TAG+="uaccess", OPTIONS+="static_node=uinput"' > /etc/udev/rules.d/60-hyperdesk-uinput.rules`,
    'echo uinput > /etc/modules-load.d/hyperdesk-uinput.conf',
    'modprobe uinput || true',
    'udevadm control --reload-rules || true',
    'udevadm trigger --subsystem-match=misc --action=change || true',
  ].join(' && ');
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const p = spawn('pkexec', ['sh', '-c', script], { stdio: 'ignore' });
    p.on('error', () => resolve({ ok: false, message: 'Não achei o pkexec. Rode o instalador pelo terminal (veja o README).' }));
    p.on('exit', (code) => {
      if (code !== 0) return resolve({ ok: false, message: code === 126 ? 'Cancelado.' : `Falhou (código ${code}).` });
      setTimeout(() => {
        injector.restart();
        setTimeout(() => {
          pushState();
          const ok = (injector.status || '').startsWith('ok');
          resolve({ ok, message: ok ? 'Controle liberado.' : 'Regra criada. Se ainda não funcionar, saia e entre de novo na sessão.' });
        }, 3000);
      }, 800);
    });
  });
}

const sendCtlToViewer =(m) => hostWin?.webContents.send('hmd:host', { type: 'ctl-send', data: JSON.stringify(m) });

// ---------------------------------------------------------------- área de transferência (texto, nos dois sentidos)
// No Electron 44 o clipboard do processo principal ficou assíncrono (readText/writeText devolvem
// Promise); com await funciona também nas versões antigas, que devolviam o valor direto.
let lastClip = '';
let polling = false;
async function setClipboardFromRemote(text) {
  if (text.length > 1_000_000) return;
  lastClip = text;
  try { await clipboard.writeText(text); } catch (e) { console.error('[área de transferência]', e.message); }
}
async function readClipboard() {
  try { return String((await clipboard.readText()) ?? ''); } catch { return lastClip; }
}
async function pollClipboard() {
  if (polling) return; // a leitura anterior ainda não voltou
  polling = true;
  let t;
  try { t = await readClipboard(); } finally { polling = false; }
  if (t === lastClip) return;
  lastClip = t;
  if (!t || t.length > 1_000_000) return;
  if (session) sendCtlToViewer({ t: 'clip', text: t });
  for (const w of viewerWins.keys()) if (!w.isDestroyed()) w.webContents.send('hmd:clip-local', t);
}

// ---------------------------------------------------------------- descoberta na rede local
const peers = new Map(); // id -> { id, name, port, address, seen }
let udp = null;

function broadcastAddrs() {
  const out = new Set(['255.255.255.255']);
  for (const { address, netmask } of myIps()) {
    const a = address.split('.').map(Number);
    const m = netmask.split('.').map(Number);
    out.add(a.map((x, i) => (x & m[i]) | (~m[i] & 255)).join('.'));
  }
  return [...out];
}

function startDiscovery() {
  udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('error', (e) => console.error('[descoberta]', e.message));
  udp.on('message', (buf, rinfo) => {
    let m;
    try { m = JSON.parse(buf); } catch { return; }
    if (m.app !== APP_ID || !m.id || m.id === settings.deviceId) return;
    const prev = peers.get(m.id);
    peers.set(m.id, {
      id: m.id, name: String(m.name || '').slice(0, 60), port: m.port | 0,
      address: prev?.address && Date.now() - prev.seen < 5000 ? prev.address : rinfo.address,
      seen: Date.now(),
    });
    if (!prev) pushPeers();
  });
  udp.bind(DISCOVERY_PORT, () => { try { udp.setBroadcast(true); } catch {} });

  setInterval(() => {
    if (!settings.allowIncoming) return;
    const msg = Buffer.from(JSON.stringify({ app: APP_ID, v: 1, id: settings.deviceId, name: myName(), port: PORT }));
    for (const addr of broadcastAddrs()) udp.send(msg, DISCOVERY_PORT, addr, () => {});
  }, 2000);

  setInterval(() => {
    let changed = false;
    for (const [id, p] of peers) if (Date.now() - p.seen > 7000) { peers.delete(id); changed = true; }
    if (changed) pushPeers();
  }, 3000);
}

const peerList = () => [...peers.values()].map(({ id, name, port, address }) => ({ id, name, port, address }));
function pushPeers() { mainWin?.webContents.send('hmd:peers', peerList()); }

// ---------------------------------------------------------------- janelas
let mainWin = null;
let hostWin = null;
let bannerWin = null;
let tray = null;
const viewerWins = new Map(); // BrowserWindow -> params

const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
const webPrefs = (extra = {}) => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  ...extra,
});

function state() {
  return {
    name: myName(),
    ips: myIps().map((i) => i.address),
    port: PORT,
    code: access.code,
    allowIncoming: settings.allowIncoming,
    hasPassword: !!settings.passwordKey,
    session: session ? { peer: session.peer, ip: session.ip } : null,
    recent: settings.recent,
    version: app.getVersion(),
    platform: process.platform,
    inputStatus: injector.status || '',
  };
}
function pushState() { mainWin?.webContents.send('hmd:state', state()); updateTray(); }

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 980, height: 680, minWidth: 760, minHeight: 560,
    backgroundColor: '#0b0d12', title: 'Hyperdesk', icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: webPrefs(),
  });
  mainWin.setMenu(null);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('close', (e) => {
    // com acesso liberado, fechar só esconde (o PC continua controlável pela bandeja)
    if (!app.isQuitting && settings.allowIncoming) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

function showMain() {
  if (!mainWin) createMainWindow();
  mainWin.show();
  mainWin.focus();
}

function createHostWindow() {
  // janela invisível que captura a tela e mantém o WebRTC do lado controlado
  hostWin = new BrowserWindow({
    show: false, width: 200, height: 100,
    webPreferences: webPrefs({ backgroundThrottling: false }),
  });
  hostWin.loadFile(path.join(__dirname, 'renderer', 'host.html'));
}

function openViewer(params) {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 480, minHeight: 320,
    backgroundColor: '#05060a', title: `Hyperdesk — ${params.name || params.host}`, icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: webPrefs({ backgroundThrottling: false }),
  });
  win.setMenu(null);
  viewerWins.set(win, { ...params, myName: myName() });
  win.on('closed', () => viewerWins.delete(win));
  win.loadFile(path.join(__dirname, 'renderer', 'viewer.html'));
  return win;
}

function showBanner() {
  hideBanner();
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 420, h = 46;
  bannerWin = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y + 8, width: w, height: h,
    frame: false, resizable: false, movable: true, alwaysOnTop: true, skipTaskbar: true,
    transparent: true, hasShadow: false, show: false, focusable: true,
    webPreferences: webPrefs(),
  });
  bannerWin.setAlwaysOnTop(true, 'screen-saver');
  bannerWin.loadFile(path.join(__dirname, 'renderer', 'banner.html'), { query: { peer: session?.peer || '' } });
  bannerWin.once('ready-to-show', () => bannerWin?.showInactive());
  bannerWin.on('closed', () => { bannerWin = null; });
}
function hideBanner() { if (bannerWin && !bannerWin.isDestroyed()) bannerWin.destroy(); bannerWin = null; }

function trayIcon() {
  const img = nativeImage.createFromPath(iconPath);
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}
function createTray() {
  tray = new Tray(trayIcon());
  tray.on('click', showMain);
  updateTray();
}
function updateTray() {
  if (!tray) return;
  const status = session ? `${session.peer} está controlando este PC` :
    settings.allowIncoming ? `Código: ${access.code}` : 'Acesso desligado';
  tray.setToolTip(`Hyperdesk — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    ...(updater.info().state === 'available'
      ? [{ label: `Nova versão ${updater.info().latest} disponível`, click: showMain }] : []),
    { label: 'Abrir', click: showMain },
    ...(session ? [{ label: 'Desconectar quem está controlando', click: endSession }] : []),
    { label: 'Permitir conexões', type: 'checkbox', checked: settings.allowIncoming, click: (i) => setAllow(i.checked) },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function setAllow(v) {
  settings.allowIncoming = !!v;
  saveSettings();
  if (!v && session) endSession();
  pushState();
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  // tela principal
  ipcMain.handle('hmd:get-state', () => state());
  ipcMain.handle('hmd:get-update', () => updater.info());
  ipcMain.handle('hmd:update-check', () => updater.check());
  ipcMain.handle('hmd:update-install', () => updater.install());
  ipcMain.handle('hmd:update-open', () => shell.openExternal(updater.info().url));
  ipcMain.handle('hmd:open-logs', () => shell.openPath(LOG_DIR));
  ipcMain.handle('hmd:about', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    os: `${process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : process.platform} ${os.release()} (${process.arch})`,
    session: process.env.XDG_SESSION_TYPE || '',
    input: injector.status || '',
    autoUpdate: updater.canAutoInstall(),
    logDir: LOG_DIR,
  }));
  ipcMain.handle('hmd:open-url', (_e, url) => {
    // só links do próprio projeto
    if (/^https:\/\/github\.com\/devhygor(\/|$)/.test(String(url))) shell.openExternal(url);
  });
  ipcMain.handle('hmd:fix-linux-input', () => fixLinuxInput());
  ipcMain.handle('hmd:update-restart', () => { app.isQuitting = true; updater.restart(); });
  ipcMain.handle('hmd:get-peers', () => peerList());
  ipcMain.handle('hmd:new-code', () => { newCode(); return state(); });
  ipcMain.handle('hmd:set-allow', (_e, v) => { setAllow(v); return state(); });
  ipcMain.handle('hmd:set-name', (_e, name) => {
    settings.name = String(name || '').trim().slice(0, 40) || undefined;
    saveSettings(); pushState(); return state();
  });
  ipcMain.handle('hmd:set-password', (_e, pass) => {
    pass = normalizeSecret(pass);
    if (!pass) delete settings.passwordKey;
    else {
      if (pass.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');
      settings.passwordKey = deriveKey(pass).toString('hex');
    }
    saveSettings(); pushState(); return state();
  });
  ipcMain.handle('hmd:disconnect-session', () => { endSession(); });
  ipcMain.on('hmd:disconnect-session', () => endSession());
  ipcMain.handle('hmd:connect', (_e, p) => {
    const host = String(p?.host || '').trim();
    if (!host) throw new Error('Informe o IP ou nome do PC.');
    let port = Number(p.port) || 47810;
    let h = host;
    const m = host.match(/^([^:\[\]]+):(\d+)$/); // "ip:porta"
    if (m) { h = m[1]; port = Number(m[2]); }
    openViewer({ host: h, port, name: p.name || '' });
  });
  ipcMain.handle('hmd:remove-recent', (_e, host) => {
    settings.recent = settings.recent.filter((r) => r.host !== host);
    saveSettings(); pushState();
  });

  // janela de visualização (este PC controlando outro)
  ipcMain.handle('hmd:viewer-ready', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const p = viewerWins.get(win);
    if (!p) return null;
    return {
      ...p,
      autoSecret: env('HMD_AUTOSECRET'),
      testInput: !!env('HMD_TEST_INPUT'),
      statsLog: !!env('HMD_STATS_LOG'),
    };
  });
  ipcMain.handle('hmd:get-saved-key', (_e, hostId, salt) => {
    const s = settings.savedKeys[hostId];
    if (!s || s.salt !== salt || !safeStorage.isEncryptionAvailable()) return null;
    try { return safeStorage.decryptString(Buffer.from(s.key, 'base64')); } catch { return null; }
  });
  ipcMain.handle('hmd:save-key', (_e, hostId, salt, keyHex, hostName) => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    settings.savedKeys[hostId] = {
      salt, name: hostName, key: safeStorage.encryptString(String(keyHex)).toString('base64'),
    };
    saveSettings(); return true;
  });
  ipcMain.handle('hmd:forget-key', (_e, hostId) => { delete settings.savedKeys[hostId]; saveSettings(); });
  ipcMain.handle('hmd:viewer-connected', (e, info) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const p = viewerWins.get(win);
    if (!p) return;
    win.setTitle(`Hyperdesk — ${info.hostName || p.host}`);
    settings.recent = [
      { host: p.host, port: p.port, name: info.hostName || p.name || p.host, hostId: info.hostId, at: Date.now() },
      ...settings.recent.filter((r) => !(r.host === p.host && r.port === p.port)),
    ].slice(0, 8);
    saveSettings(); pushState();
  });
  ipcMain.handle('hmd:viewer-fullscreen', (e, v) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    win.setFullScreen(typeof v === 'boolean' ? v : !win.isFullScreen());
    return win.isFullScreen();
  });
  ipcMain.on('hmd:viewer-clip', (_e, text) => { if (typeof text === 'string') setClipboardFromRemote(text); });
  ipcMain.on('hmd:log', (_e, ...a) => console.log('[viewer]', ...a));

  // janela invisível do servidor
  ipcMain.on('hmd:host-signal', (_e, data) => session?.send(data));
  ipcMain.on('hmd:host-input', (_e, str) => handleInput(str));
  ipcMain.on('hmd:host-ctl', (_e, str) => handleCtl(str));
  ipcMain.on('hmd:host-state', (_e, st) => {
    console.log('[servidor] webrtc:', st);
    if (st === 'failed') endSession();
  });
  ipcMain.on('hmd:host-captured', (_e, info) => onCaptured(info || {}));
  ipcMain.on('hmd:host-error', (_e, msg) => {
    console.error('[servidor] captura:', msg);
    session?.send({ type: 'error', reason: 'capture', detail: String(msg) });
    endSession();
  });
}

// ---------------------------------------------------------------- inicialização
app.on('second-instance', showMain);
app.on('window-all-closed', (e) => e.preventDefault?.());
app.on('before-quit', () => { app.isQuitting = true; injector.stop(); });

app.whenReady().then(() => {
  if (!gotLock) return;
  loadSettings();
  if (env('HMD_TEST_PASSWORD')) settings.passwordKey = deriveKey(env('HMD_TEST_PASSWORD')).toString('hex');
  newCode();
  registerIpc();
  injector.start();
  startServer();
  startDiscovery();
  setupDisplayMediaHandler();
  createHostWindow();
  createMainWindow();
  createTray();
  setInterval(pollClipboard, 700);
  updater.start({
    changed: (u) => { mainWin?.webContents.send('hmd:update', u); updateTray(); },
    clicked: showMain,
  });
  // o injetor demora um pouco a subir; atualiza o aviso de "controle indisponível" na tela
  setTimeout(pushState, 4000);
  readClipboard().then((t) => { lastClip = t; });
  console.log(`[Hyperdesk] ${myName()} pronto na porta ${PORT}`);

  if (env('HMD_SNAPSHOT')) {
    // desenvolvimento: salva prints das janelas para conferir o visual
    setTimeout(async () => {
      const dir = env('HMD_SNAPSHOT');
      fs.mkdirSync(dir, { recursive: true });
      if (mainWin && env('HMD_SNAPSHOT_JS')) { await mainWin.webContents.executeJavaScript(env('HMD_SNAPSHOT_JS'), true); await new Promise((r) => setTimeout(r, 2500)); }
      if (mainWin) fs.writeFileSync(path.join(dir, 'main.png'), (await mainWin.webContents.capturePage()).toPNG());
      let i = 0;
      for (const w of viewerWins.keys()) fs.writeFileSync(path.join(dir, `viewer${i++}.png`), (await w.webContents.capturePage()).toPNG());
      console.log('[snapshot] salvo em', dir);
    }, Number(env('HMD_SNAPSHOT_DELAY')) || 9000);
  }

  if (env('HMD_AUTOCONNECT')) {
    const [h, p] = env('HMD_AUTOCONNECT').split(':');
    openViewer({ host: h, port: Number(p) || 47810, name: 'teste' });
  }
});
