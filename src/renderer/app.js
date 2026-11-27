'use strict';
const api = window.hmd;
const $ = (s) => document.querySelector(s);

let st = null;
let peers = [];

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 4000);
}
const errMsg = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderState(s) {
  st = s;
  if (document.activeElement !== $('#name')) $('#name').value = s.name;
  $('#ips').textContent = s.ips.length ? s.ips.join('  ·  ') : 'sem rede';
  $('#allow').checked = s.allowIncoming;
  $('#showBanner').checked = s.showBanner !== false;
  $('#codeBox').classList.toggle('hidden', !s.allowIncoming || !!s.session);
  $('#offBox').classList.toggle('hidden', s.allowIncoming);
  $('#code').textContent = s.code ? `${s.code.slice(0, 3)} ${s.code.slice(3)}` : '—';
  $('#sessionBox').classList.toggle('hidden', !s.session);
  if (s.session) $('#sessionPeer').textContent = `${s.session.peer} (${s.session.ip})`;
  $('#passStatus').textContent = s.hasPassword ? 'Definida' : 'Não definida';
  $('#passSet').textContent = s.hasPassword ? 'Trocar' : 'Definir';
  $('#passClear').classList.toggle('hidden', !s.hasPassword);
  $('#version').textContent = `v${s.version}`;
  const badInput = s.inputStatus && (!s.inputStatus.startsWith('ok') || s.inputStatus.includes('sem-uinput'));
  $('#inputWarn').classList.toggle('hidden', !badInput);
  if (badInput) {
    const fixable = s.platform === 'linux' && /uinput|display/i.test(s.inputStatus);
    $('#inputWarnText').textContent = s.platform === 'linux'
      ? (/python3|ENOENT/i.test(s.inputStatus)
        ? 'Os outros PCs vão ver esta tela, mas não conseguem controlar: falta o python3. Instale com o gerenciador de pacotes da sua distro.'
        : 'Os outros PCs vão ver esta tela, mas ainda não conseguem controlar o mouse e o teclado. Falta liberar uma permissão do sistema (só uma vez).')
      : `O controle de mouse e teclado não iniciou: ${s.inputStatus}`;
    $('#fixInput').classList.toggle('hidden', !fixable);
  }
  renderRecent();
}

function item({ name, sub, live, onConnect, onRemove }) {
  const it = el('div', 'item');
  it.appendChild(el('div', 'pc' + (live ? ' live' : '')));
  const info = el('div', 'info');
  info.appendChild(el('b', null, name));
  info.appendChild(el('span', null, sub));
  it.appendChild(info);
  if (onRemove) {
    const x = el('button', 'ghost x', '✕');
    x.title = 'Remover dos recentes';
    x.onclick = onRemove;
    it.appendChild(x);
  }
  const b = el('button', 'primary', 'Conectar');
  b.onclick = onConnect;
  it.appendChild(b);
  it.ondblclick = onConnect;
  return it;
}

const connect = (host, port, name) => api.invoke('hmd:connect', { host, port, name }).catch((e) => toast(errMsg(e)));

function renderPeers() {
  const box = $('#peers');
  box.innerHTML = '';
  for (const p of peers) {
    box.appendChild(item({
      name: p.name, sub: `${p.address}${p.port !== 47810 ? ':' + p.port : ''}`, live: true,
      onConnect: () => connect(p.address, p.port, p.name),
    }));
  }
  $('#peersEmpty').classList.toggle('hidden', peers.length > 0);
  renderRecent();
}

function renderRecent() {
  if (!st) return;
  const onLan = new Set(peers.map((p) => p.id));
  const list = (st.recent || []).filter((r) => !onLan.has(r.hostId));
  const box = $('#recent');
  box.innerHTML = '';
  for (const r of list) {
    box.appendChild(item({
      name: r.name, sub: `${r.host}${r.port !== 47810 ? ':' + r.port : ''}`,
      onConnect: () => connect(r.host, r.port, r.name),
      onRemove: () => api.invoke('hmd:remove-recent', r.host),
    }));
  }
  $('#recentTitle').classList.toggle('hidden', list.length === 0);
}

// ---- eventos
$('#allow').onchange = (e) => api.invoke('hmd:set-allow', e.target.checked).then(renderState);
$('#showBanner').onchange = (e) => api.invoke('hmd:set-banner', e.target.checked).then(renderState);
$('#newCode').onclick = () => api.invoke('hmd:new-code').then(renderState);
$('#copyCode').onclick = () => { navigator.clipboard.writeText(st.code); toast('Código copiado.'); };
$('#kick').onclick = () => api.invoke('hmd:disconnect-session');
$('#name').onchange = (e) => api.invoke('hmd:set-name', e.target.value).then(renderState);
$('#name').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };

$('#passSet').onclick = () => { $('#passForm').classList.remove('hidden'); $('#passInput').focus(); };
$('#passCancel').onclick = () => { $('#passForm').classList.add('hidden'); $('#passInput').value = ''; };
$('#passForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    renderState(await api.invoke('hmd:set-password', $('#passInput').value));
    $('#passForm').classList.add('hidden');
    $('#passInput').value = '';
    toast('Senha fixa salva.');
  } catch (err) { toast(errMsg(err)); }
};
$('#passClear').onclick = async () => {
  renderState(await api.invoke('hmd:set-password', ''));
  toast('Senha fixa removida.');
};

$('#connectForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#hostInput').value.trim();
  if (v) connect(v);
};

$('#fixInput').onclick = async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Aguardando a senha…';
  try {
    const r = await api.invoke('hmd:fix-linux-input');
    toast(r.message);
  } catch (err) { toast(errMsg(err)); }
  e.target.disabled = false;
  e.target.textContent = 'Liberar agora';
};

// ---- atualização
let upd = null;
function renderUpdate(u) {
  upd = u;
  const box = $('#update');
  box.classList.toggle('hidden', u.state === 'idle');
  box.classList.toggle('error', u.state === 'error');
  const btn = $('#updateBtn');
  btn.disabled = false;
  btn.classList.remove('hidden');
  if (u.state === 'available') {
    $('#updateText').textContent = `Nova versão ${u.latest} disponível (você está na ${u.current}).`;
    btn.textContent = u.canInstall ? 'Atualizar agora' : 'Baixar';
  } else if (u.state === 'downloading') {
    $('#updateText').textContent = `Baixando a versão ${u.latest}… ${u.progress || 0}%`;
    btn.classList.add('hidden');
  } else if (u.state === 'ready') {
    $('#updateText').textContent = `Versão ${u.latest} baixada.`;
    btn.textContent = 'Reiniciar e atualizar';
  } else if (u.state === 'error') {
    $('#updateText').textContent = `Não deu para atualizar sozinho (${u.error}).`;
    btn.textContent = 'Abrir página de download';
  }
}
$('#updateBtn').onclick = () => {
  if (!upd) return;
  if (upd.state === 'ready') api.invoke('hmd:update-restart');
  else if (upd.state === 'error') api.invoke('hmd:update-open');
  else api.invoke('hmd:update-install');
};
api.on('hmd:update', renderUpdate);

api.on('hmd:state', renderState);
api.on('hmd:peers', (p) => { peers = p; renderPeers(); });

(async () => {
  renderState(await api.invoke('hmd:get-state'));
  renderUpdate(await api.invoke('hmd:get-update'));
  peers = await api.invoke('hmd:get-peers');
  renderPeers();
})();

$('#openLogs').onclick = () => api.invoke('hmd:open-logs');

// ---- Sobre
async function openAbout() {
  const a = await api.invoke('hmd:about');
  $('#aboutVersion').textContent = a.version;
  $('#aboutOs').textContent = a.os + (a.session ? ` · ${a.session}` : '');
  $('#aboutTech').textContent = `Electron ${a.electron} · Chromium ${a.chrome.split('.')[0]}`;
  $('#aboutUpdateText').textContent = a.autoUpdate
    ? 'O app verifica sozinho ao abrir e a cada 6 horas, e instala com um clique.'
    : 'O app verifica sozinho ao abrir e a cada 6 horas. Nesta forma de instalação, a versão nova é baixada pela página.';
  $('#about').classList.remove('hidden');
}
$('#openAbout').onclick = openAbout;
$('#aboutClose').onclick = () => $('#about').classList.add('hidden');
$('#about').onclick = (e) => { if (e.target.id === 'about') $('#about').classList.add('hidden'); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#about').classList.add('hidden'); });
for (const el of document.querySelectorAll('[data-url]')) {
  el.onclick = (e) => { e.preventDefault(); api.invoke('hmd:open-url', el.dataset.url); };
}
$('#aboutCheck').onclick = async (e) => {
  const btn = e.target;
  const txt = $('#aboutUpdateText');
  btn.disabled = true;
  btn.textContent = 'Buscando…';
  txt.classList.remove('ok');
  try {
    const u = await api.invoke('hmd:update-check');
    if (u.checkError) {
      txt.textContent = `Não consegui consultar o GitHub agora (${u.checkError}). Verifique a internet.`;
    } else if (u.state === 'available' || u.state === 'downloading' || u.state === 'ready') {
      txt.textContent = `Versão ${u.latest} disponível! Use a faixa azul no topo da janela para atualizar.`;
      renderUpdate(u);
    } else {
      txt.textContent = `Você está na versão mais recente (${u.current}).`;
      txt.classList.add('ok');
    }
  } catch (err) {
    txt.textContent = `Falhou: ${errMsg(err)}`;
  }
  btn.disabled = false;
  btn.textContent = 'Buscar atualização';
};
