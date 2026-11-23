'use strict';
// Lado controlado: captura a tela, manda por WebRTC e repassa o que chega pelos canais de dados.
const api = window.hmd;

let pc = null;
let stream = null;
let videoSender = null;
let ctl = null;
let pending = [];

const MAX_BITRATE = 30_000_000;

// Linux/Wayland: getUserMedia com chromeMediaSourceId derruba o app depois que a pessoa escolhe a
// tela na janela do sistema (portal). O caminho suportado é o getDisplayMedia: o main responde pelo
// setDisplayMediaRequestHandler e o portal do sistema cuida da escolha.
const VIA_PORTAL = navigator.userAgent.includes('Linux');

async function captureViaPortal() {
  const s = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 60, max: 60 } },
    audio: false, // o Linux não tem captura do som do sistema por aqui
  });
  const t = s.getVideoTracks()[0];
  const st = t?.getSettings() || {};
  api.send('hmd:host-captured', { width: st.width || 0, height: st.height || 0, label: t?.label || '' });
  return s;
}

async function capture(sourceId, width, height, audio) {
  if (VIA_PORTAL) return captureViaPortal();
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxWidth: width, maxHeight: height,
      minFrameRate: 30, maxFrameRate: 60,
    },
  };
  const c = { video };
  if (audio) c.audio = { mandatory: { chromeMediaSource: 'desktop' } };
  try {
    return await navigator.mediaDevices.getUserMedia(c);
  } catch (e) {
    if (!audio) throw e;
    delete c.audio; // sem áudio do sistema, mas segue com a imagem
    return navigator.mediaDevices.getUserMedia(c);
  }
}

function preferH264(transceiver) {
  // H.264 costuma ter codificação por hardware (NVENC/QuickSync/AMF)
  // o Chromium só aceita preferências que também existam na lista de recepção
  const send = RTCRtpSender.getCapabilities('video');
  const recv = RTCRtpReceiver.getCapabilities('video');
  if (!send || !recv || !transceiver.setCodecPreferences) return;
  const key = (c) => `${c.mimeType.toLowerCase()}|${c.clockRate}|${c.sdpFmtpLine || ''}`;
  const sendKeys = new Set(send.codecs.map(key));
  const caps = { codecs: recv.codecs.filter((c) => sendKeys.has(key(c)) || !/^video\/(h264|vp8|vp9|av1|h265)$/i.test(c.mimeType)) };
  const rank = (c) => {
    const m = c.mimeType.toLowerCase();
    if (m === 'video/h264') return /profile-level-id=42e0|packetization-mode=1/.test(c.sdpFmtpLine || '') ? 0 : 1;
    if (m === 'video/vp9') return 2;
    if (m === 'video/vp8') return 3;
    return 4;
  };
  const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  api.send('hmd:log', 'codecs:', sorted.slice(0, 6).map((c) => `${c.mimeType} ${c.sdpFmtpLine || ''}`).join(' | '));
  try { transceiver.setCodecPreferences(sorted); } catch (e) { api.send('hmd:log', 'setCodecPreferences falhou', e.message); }
}

async function tuneSender(sender) {
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = MAX_BITRATE;
  p.encodings[0].maxFramerate = 60;
  p.encodings[0].priority = 'high';
  p.encodings[0].networkPriority = 'high';
  p.encodings[0].scaleResolutionDownBy = 1;
  p.degradationPreference = 'maintain-resolution';
  try { await sender.setParameters(p); } catch (e) { console.warn('setParameters', e); }
}

async function start({ sourceId, width, height, audio }) {
  stop();
  pc = new RTCPeerConnection({ iceServers: [] });
  pc.onicecandidate = (e) => { if (e.candidate) api.send('hmd:host-signal', { type: 'ice', candidate: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => api.send('hmd:host-state', pc.connectionState);

  ctl = pc.createDataChannel('ctl', { ordered: true });
  ctl.onmessage = (e) => onCtl(e.data);
  const input = pc.createDataChannel('input', { ordered: true });
  input.onmessage = (e) => api.send('hmd:host-input', e.data);

  try {
    stream = await capture(sourceId, width, height, audio);
  } catch (e) {
    api.send('hmd:host-error', e.message || String(e));
    return;
  }
  const vt = stream.getVideoTracks()[0];
  vt.contentHint = 'motion';
  const vtr = pc.addTransceiver(vt, { direction: 'sendonly', streams: [stream] });
  videoSender = vtr.sender;
  preferH264(vtr);
  const at = stream.getAudioTracks()[0];
  if (at) pc.addTransceiver(at, { direction: 'sendonly', streams: [stream] });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  api.send('hmd:host-signal', { type: 'offer', sdp: pc.localDescription.sdp });
  await tuneSender(videoSender);
  for (const m of pending) await onSignal(m);
  pending = [];
}

async function switchScreen({ sourceId, width, height }) {
  if (!pc || !videoSender) return;
  try {
    const s = await capture(sourceId, width, height, false);
    const nt = s.getVideoTracks()[0];
    nt.contentHint = videoSender.track?.contentHint || 'motion';
    const old = videoSender.track;
    await videoSender.replaceTrack(nt);
    old?.stop();
  } catch (e) {
    console.error('troca de tela', e);
  }
}

function onCtl(data) {
  let m;
  try { m = JSON.parse(data); } catch { return; }
  if (m.t === 'quality' && videoSender?.track) {
    videoSender.track.contentHint = m.mode === 'detail' ? 'detail' : 'motion';
    return;
  }
  api.send('hmd:host-ctl', data);
}

async function onSignal(m) {
  if (!pc) return;
  if (!pc.localDescription) { pending.push(m); return; }
  try {
    if (m.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    else if (m.type === 'ice' && m.candidate) await pc.addIceCandidate(m.candidate);
  } catch (e) {
    console.warn('sinalização', e);
  }
}

function stop() {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { pc?.close(); } catch {}
  pc = null; stream = null; videoSender = null; ctl = null; pending = [];
}

// a sinalização chega em ordem; processamos em fila para não aplicar ICE antes da resposta
let chain = Promise.resolve();
function handle(msg) {
  chain = chain.then(async () => {
    switch (msg.type) {
      case 'start': await start(msg); break;
      case 'switch': await switchScreen(msg); break;
      case 'signal': await onSignal(msg.data); break;
      case 'ctl-send': if (ctl?.readyState === 'open') ctl.send(msg.data); break;
      case 'stop': stop(); break;
    }
  }).catch((e) => console.error(e));
}
api.on('hmd:host', handle);
// no Linux o main chama por aqui com executeJavaScript(…, userGesture=true): o getDisplayMedia
// pode exigir um "gesto do usuário", e esta janela é invisível
window.__hmdHost = (msg) => { handle(msg); return true; };
