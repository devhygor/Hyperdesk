'use strict';
// Lado controlador: recebe o vídeo do outro PC e manda mouse/teclado pelo canal de dados.
const api = window.hmd;
const $ = (s) => document.querySelector(s);
const video = $('#v');
const stage = $('#stage');

let params = null;
let ws = null;
let pc = null;
let input = null;
let ctl = null;
let hostInfo = null;
let ended = false;
let lastFailed = false;
let triedSaved = false;
let triedAuto = false;
let usingSaved = false;
let pendingKey = null;   // chave derivada da última tentativa (para "lembrar")
let rememberAsked = false;
let connectedOnce = false;

const pressedKeys = new Set();
const pressedButtons = new Set();

const REASONS = {
  busy: 'Esse PC já está sendo controlado por outra pessoa.',
  disabled: 'Esse PC está com as conexões desligadas.',
  locked: 'Muitas tentativas erradas. Espere 5 minutos e tente de novo.',
  noscreen: 'O outro PC não encontrou nenhuma tela para mostrar.',
  capture: 'O outro PC não conseguiu capturar a tela.',
};

// ---------------------------------------------------------------- utilidades
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
function normalizeSecret(s) {
  s = String(s ?? '').trim();
  return /^[\d\s]+$/.test(s) ? s.replace(/\s+/g, '') : s;
}
async function derive(secret, saltHex, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(normalizeSecret(secret)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: iter }, base, 256);
  return new Uint8Array(bits);
}
async function sendProof(key) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(hostInfo.nonce));
  send({ type: 'auth', proof: hex(new Uint8Array(sig)), name: params.myName });
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
const sendIn = (o) => { if (input?.readyState === 'open') input.send(JSON.stringify(o)); };
const sendCtl = (o) => { if (ctl?.readyState === 'open') ctl.send(JSON.stringify(o)); };

// ---------------------------------------------------------------- telas de status
function status(text, { spinner = true, closable = false } = {}) {
  $('#overlay').classList.remove('hidden');
  $('#authForm').classList.add('hidden');
  $('#statusCard').classList.remove('hidden');
  $('#statusText').textContent = text;
  $('#spinner').classList.toggle('hidden', !spinner);
  $('#statusClose').classList.toggle('hidden', !closable);
}
function hideOverlay() { $('#overlay').classList.add('hidden'); }
function fail(text) {
  if (ended) return;
  ended = true;
  $('#dot').className = 'dot bad';
  releaseAll();
  status(text, { spinner: false, closable: true });
  try { pc?.close(); } catch {}
  try { ws?.close(); } catch {}
}
$('#statusClose').onclick = () => window.close();

function askSecret() {
  $('#overlay').classList.remove('hidden');
  $('#statusCard').classList.add('hidden');
  $('#authForm').classList.remove('hidden');
  $('#authTitle').textContent = `Acessar ${hostInfo.hostName}`;
  $('#authError').classList.toggle('hidden', !lastFailed);
  $('#authGo').disabled = false;
  $('#secret').value = '';
  setTimeout(() => $('#secret').focus(), 30);
}
$('#authCancel').onclick = () => window.close();
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  const secret = $('#secret').value;
  if (!secret.trim()) return;
  $('#authGo').disabled = true;
  rememberAsked = $('#remember').checked;
  status('Verificando…');
  pendingKey = await derive(secret, hostInfo.salt, hostInfo.iter);
  await sendProof(pendingKey);
};

// ---------------------------------------------------------------- sinalização
function connect() {
  status(`Conectando a ${params.name || params.host}…`);
  const host = params.host.includes(':') ? `[${params.host}]` : params.host;
  ws = new WebSocket(`ws://${host}:${params.port}`);
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } queue(m); };
  ws.onclose = () => {
    if (ended) return;
    fail(connectedOnce ? 'A conexão foi encerrada pelo outro PC.' : `Não foi possível conectar a ${params.host}:${params.port}. O Hyperdesk está aberto lá e o firewall liberou?`);
  };
}

let chain = Promise.resolve();
const queue = (m) => { chain = chain.then(() => onMsg(m)).catch((e) => console.error(e)); };

async function onMsg(m) {
  switch (m.type) {
    case 'challenge': {
      hostInfo = m;
      $('#peer').textContent = m.hostName;
      if (!triedSaved) {
        triedSaved = true;
        const saved = await api.invoke('hmd:get-saved-key', m.hostId, m.salt);
        if (saved) { usingSaved = true; pendingKey = unhex(saved); status('Entrando com a senha salva…'); return sendProof(pendingKey); }
      }
      if (params.autoSecret && !triedAuto) {
        triedAuto = true;
        pendingKey = await derive(params.autoSecret, m.salt, m.iter);
        return sendProof(pendingKey);
      }
      askSecret();
      break;
    }
    case 'auth-fail':
      if (usingSaved) { usingSaved = false; await api.invoke('hmd:forget-key', hostInfo.hostId); }
      lastFailed = true;
      break;
    case 'auth-ok':
      connectedOnce = true;
      if (m.via === 'password' && rememberAsked && pendingKey && !usingSaved) {
        api.invoke('hmd:save-key', hostInfo.hostId, hostInfo.salt, hex(pendingKey), hostInfo.hostName);
      }
      api.invoke('hmd:viewer-connected', { hostId: hostInfo.hostId, hostName: hostInfo.hostName });
      fillScreens(m.screens, m.current);
      status('Abrindo a tela…');
      break;
    case 'error':
      fail(REASONS[m.reason] || 'O outro PC recusou a conexão.');
      break;
    case 'offer':
      await onOffer(m.sdp);
      break;
    case 'ice':
      if (pc && m.candidate) { try { await pc.addIceCandidate(m.candidate); } catch {} }
      break;
  }
}

// a resposta pede ao outro lado para já começar com taxa alta (rede local aguenta)
function boost(sdp) {
  let inVideo = false;
  return sdp.split('\r\n').map((l) => {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    if (inVideo && l.startsWith('a=fmtp:') && !l.includes('apt=')) {
      return l + ';x-google-start-bitrate=12000;x-google-min-bitrate=2000;x-google-max-bitrate=40000';
    }
    return l;
  }).join('\r\n');
}

async function onOffer(sdp) {
  try { pc?.close(); } catch {}
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'ice', candidate: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    if (!video.srcObject) video.srcObject = e.streams[0] || new MediaStream([e.track]);
    else if (!video.srcObject.getTracks().includes(e.track)) video.srcObject.addTrack(e.track);
    try { e.receiver.playoutDelayHint = 0; } catch {}
    try { e.receiver.jitterBufferTarget = 0; } catch {}
  };
  pc.ondatachannel = (e) => {
    if (e.channel.label === 'input') input = e.channel;
    if (e.channel.label === 'ctl') { ctl = e.channel; ctl.onmessage = onCtl; }
    e.channel.onopen = maybeReady;
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') { $('#dot').className = 'dot ok'; maybeReady(); }
    else if (s === 'disconnected') { $('#dot').className = 'dot'; }
    else if (s === 'failed') fail('A conexão de vídeo caiu.');
  };
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const ans = await pc.createAnswer();
  ans.sdp = boost(ans.sdp);
  await pc.setLocalDescription(ans);
  send({ type: 'answer', sdp: pc.localDescription.sdp });
}

let readyDone = false;
function maybeReady() {
  if (readyDone || pc?.connectionState !== 'connected' || input?.readyState !== 'open') return;
  readyDone = true;
  hideOverlay();
  startStats();
  flashBar();
  if (params.testInput) {
    // teste automático (só em desenvolvimento): leva o mouse do outro PC para o centro da tela
    setTimeout(() => { sendIn({ t: 'm', x: 0.5, y: 0.5 }); api.send('hmd:log', 'teste: mouse enviado para o centro'); }, 1500);
  }
}

function onCtl(e) {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.t === 'clip' && typeof m.text === 'string') api.send('hmd:viewer-clip', m.text);
  if (m.t === 'screens') fillScreens(m.screens, m.current);
}
api.on('hmd:clip-local', (text) => sendCtl({ t: 'clip', text }));

// ---------------------------------------------------------------- barra de ferramentas
function fillScreens(list, current) {
  const sel = $('#screens');
  sel.innerHTML = '';
  for (const s of list || []) {
    const o = document.createElement('option');
    o.value = s.sourceId;
    o.textContent = `${s.label} · ${s.width}×${s.height}`;
    sel.appendChild(o);
  }
  if (current) sel.value = current;
  sel.classList.toggle('hidden', (list || []).length < 2);
}
$('#screens').onchange = (e) => { releaseAll(); sendCtl({ t: 'screen', sourceId: e.target.value }); e.target.blur(); };

let quality = 'motion';
$('#quality').onclick = (e) => {
  quality = quality === 'motion' ? 'detail' : 'motion';
  e.target.textContent = quality === 'motion' ? 'Fluidez' : 'Nitidez';
  sendCtl({ t: 'quality', mode: quality });
  e.target.blur();
};
$('#audio').onclick = (e) => {
  video.muted = !video.muted;
  e.target.textContent = video.muted ? 'Som: mudo' : 'Som: ligado';
  e.target.blur();
};
// Seta local ligada por padrão: ela anda na hora. A seta do outro PC vem dentro do vídeo e chega
// sempre com o atraso da transmissão inteira, e é isso que mais dá a sensação de "lag".
function setLocalCursor(on) {
  document.body.classList.toggle('local-cursor', on);
  $('#cursor').textContent = on ? 'Seta local: sim' : 'Seta local: não';
  try { localStorage.setItem('hmd-local-cursor', on ? '1' : '0'); } catch {}
}
let savedCursor = null;
try { savedCursor = localStorage.getItem('hmd-local-cursor'); } catch {}
setLocalCursor(savedCursor !== '0');
$('#cursor').onclick = (e) => {
  setLocalCursor(!document.body.classList.contains('local-cursor'));
  e.target.blur();
};
$('#fs').onclick = async (e) => { await api.invoke('hmd:viewer-fullscreen'); e.target.blur(); };
$('#close').onclick = () => window.close();
$('#keysBtn').onclick = (e) => { $('#keys').classList.toggle('open'); e.stopPropagation(); };
document.addEventListener('click', () => $('#keys').classList.remove('open'));
for (const b of document.querySelectorAll('[data-combo]')) {
  b.onclick = () => {
    const codes = b.dataset.combo.split('+');
    for (const c of codes) sendIn({ t: 'k', c, d: true });
    for (const c of [...codes].reverse()) sendIn({ t: 'k', c, d: false });
    $('#keys').classList.remove('open');
    b.blur();
  };
}

// a barra some sozinha; volta ao encostar o mouse no topo
let barTimer = null;
function flashBar() {
  document.body.classList.remove('bar-hidden');
  clearTimeout(barTimer);
  barTimer = setTimeout(() => {
    if (!$('#bar').matches(':hover') && !$('#keys').classList.contains('open')) document.body.classList.add('bar-hidden');
  }, 2500);
}
$('#hotzone').addEventListener('mouseenter', flashBar);
$('#bar').addEventListener('mouseleave', flashBar);
window.addEventListener('mousemove', (e) => { if (e.clientY < 6) flashBar(); });

// ---------------------------------------------------------------- mouse e teclado
function videoPoint(e, clamp) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const r = stage.getBoundingClientRect();
  const s = Math.min(r.width / vw, r.height / vh);
  const w = vw * s, h = vh * s;
  let x = (e.clientX - (r.left + (r.width - w) / 2)) / w;
  let y = (e.clientY - (r.top + (r.height - h) / 2)) / h;
  if (clamp) { x = Math.min(Math.max(x, 0), 1); y = Math.min(Math.max(y, 0), 1); }
  else if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x, y };
}

stage.addEventListener('pointerdown', (e) => { try { stage.setPointerCapture(e.pointerId); } catch {} });
stage.addEventListener('mousemove', (e) => {
  const p = videoPoint(e, pressedButtons.size > 0);
  if (p) sendIn({ t: 'm', x: p.x, y: p.y });
});
stage.addEventListener('mousedown', (e) => {
  e.preventDefault();
  window.focus();
  const p = videoPoint(e, true);
  if (!p) return;
  pressedButtons.add(e.button);
  sendIn({ t: 'b', b: e.button, d: true, x: p.x, y: p.y });
});
window.addEventListener('mouseup', (e) => {
  if (!pressedButtons.has(e.button)) return;
  e.preventDefault();
  pressedButtons.delete(e.button);
  const p = videoPoint(e, true);
  sendIn({ t: 'b', b: e.button, d: false, ...(p || {}) });
});
stage.addEventListener('contextmenu', (e) => e.preventDefault());
stage.addEventListener('auxclick', (e) => e.preventDefault());

let wheelY = 0, wheelX = 0;
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const mult = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
  // ~100 px por clique da roda no Chromium -> 120 unidades no Windows
  wheelY += (-e.deltaY * mult * 1.2) / (window.devicePixelRatio || 1);
  wheelX += (e.deltaX * mult * 1.2) / (window.devicePixelRatio || 1);
  const y = Math.trunc(wheelY), x = Math.trunc(wheelX);
  if (y || x) { sendIn({ t: 'w', y, x }); wheelY -= y; wheelX -= x; }
}, { passive: false });

function typingInForm(e) { return !$('#overlay').classList.contains('hidden'); }

window.addEventListener('keydown', (e) => {
  if (typingInForm(e)) return;
  if (e.ctrlKey && e.altKey && e.code === 'Enter') {
    e.preventDefault();
    releaseAll();
    api.invoke('hmd:viewer-fullscreen');
    return;
  }
  e.preventDefault();
  pressedKeys.add(e.code);
  sendIn({ t: 'k', c: e.code, d: true }); // repetições também vão: o Windows não repete tecla injetada
}, true);
window.addEventListener('keyup', (e) => {
  if (typingInForm(e)) return;
  e.preventDefault();
  if (!pressedKeys.delete(e.code) && e.code !== 'PrintScreen') return;
  if (e.code === 'PrintScreen') sendIn({ t: 'k', c: e.code, d: true }); // o Windows só entrega o keyup do Print
  sendIn({ t: 'k', c: e.code, d: false });
}, true);

function releaseAll() {
  for (const c of pressedKeys) sendIn({ t: 'k', c, d: false });
  for (const b of pressedButtons) sendIn({ t: 'b', b, d: false });
  pressedKeys.clear();
  pressedButtons.clear();
}
window.addEventListener('blur', releaseAll);

// ---------------------------------------------------------------- estatísticas
// Mostra na barra (e grava no log) quanto atraso cada parte põe: a espera do buffer de vídeo,
// a decodificação neste PC e a rede. Assim dá para saber de onde vem o "lag".
let prev = null;
let statsTick = 0;
let lastLogged = 0;
function startStats() {
  setInterval(async () => {
    if (!pc) return;
    const st = await pc.getStats();
    let v = null, rtt = null;
    const codecs = {};
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') v = r;
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') rtt = r.currentRoundTripTime;
      if (r.type === 'codec') codecs[r.id] = r.mimeType;
    });
    if (!v) return;
    const codec = (codecs[v.codecId] || '').split('/')[1] || '';
    const d = (k) => (v[k] || 0) - (prev?.[k] || 0);
    const dt = prev ? (v.timestamp - prev.timestamp) / 1000 : 0;
    const mbps = dt > 0 ? (d('bytesReceived') * 8) / dt / 1e6 : 0;
    const emitted = d('jitterBufferEmittedCount');
    const bufferMs = emitted > 0 ? (d('jitterBufferDelay') / emitted) * 1000 : 0;
    const decoded = d('framesDecoded');
    const decodeMs = decoded > 0 ? (d('totalDecodeTime') / decoded) * 1000 : 0;
    const dropped = d('framesDropped');
    const netMs = rtt != null ? (rtt * 1000) / 2 : 0;
    const delay = Math.round(bufferMs + decodeMs + netMs);
    prev = v;
    if (!dt) return;
    const fps = Math.round(v.framesPerSecond || 0);
    $('#stats').textContent = `${v.frameWidth}×${v.frameHeight} · ${fps} fps · ${mbps.toFixed(1)} Mb/s · atraso ~${delay} ms${codec ? ` · ${codec}` : ''}`;
    $('#stats').title = `buffer ${Math.round(bufferMs)} ms · decodificar ${decodeMs.toFixed(1)} ms · rede ${Math.round(netMs)} ms` +
      ` · decodificador: ${v.decoderImplementation || '?'}${v.powerEfficientDecoder ? ' (placa de vídeo)' : ''}`;
    // no log: as 5 primeiras medições e, depois, a cada 30 s quando estiver ruim
    statsTick++;
    const bad = delay > 60 || fps < 45 || dropped > 2;
    const now = Date.now();
    if (params.statsLog || statsTick <= 5 || (bad && now - lastLogged > 30_000)) {
      lastLogged = now;
      api.send('hmd:log', `recebendo: ${v.frameWidth}x${v.frameHeight} ${fps} fps ${mbps.toFixed(1)} Mb/s · atraso ~${delay} ms ` +
        `(buffer ${Math.round(bufferMs)}, decodificar ${decodeMs.toFixed(1)}, rede ${Math.round(netMs)}) · perdidos ${dropped} ` +
        `· decodificador ${v.decoderImplementation || '?'}${v.powerEfficientDecoder ? ' (hardware)' : ''}`);
    }
  }, 1000);
}

// ---------------------------------------------------------------- início
(async () => {
  params = await api.invoke('hmd:viewer-ready');
  if (!params) return fail('Janela sem destino.');
  $('#peer').textContent = params.name || params.host;
  connect();
})();
