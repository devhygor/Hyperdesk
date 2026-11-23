'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const ok = (ch) => typeof ch === 'string' && ch.startsWith('hmd:');

contextBridge.exposeInMainWorld('hmd', {
  invoke: (ch, ...a) => (ok(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.reject(new Error('canal inválido'))),
  send: (ch, ...a) => { if (ok(ch)) ipcRenderer.send(ch, ...a); },
  on: (ch, fn) => {
    if (!ok(ch)) return () => {};
    const l = (_e, ...a) => fn(...a);
    ipcRenderer.on(ch, l);
    return () => ipcRenderer.removeListener(ch, l);
  },
});
