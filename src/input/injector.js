'use strict';
const { spawn } = require('child_process');
const path = require('path');

// Mantém um processo PowerShell aberto com o SendInput compilado (Add-Type leva ~1-2 s na
// primeira vez, por isso ele sobe junto com o app e fica esperando comandos).
class Injector {
  constructor() {
    this.proc = null;
    this.ready = false;
    this.queue = [];
    this.keysDown = new Map(); // code -> keymap entry
    this.buttonsDown = new Set();
  }

  start() {
    if (this.proc) return;
    this.lastStart = Date.now();
    // dentro do app empacotado os scripts ficam fora do .asar (asarUnpack), senão o interpretador não lê
    const file = (name) => path.join(__dirname, name).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    this.ready = false;
    if (process.platform === 'win32') {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file('inject.ps1')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      );
    } else {
      this.proc = spawn('python3', ['-u', file('inject_linux.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
    }
    this.proc.on('error', (e) => { this.status = `injetor não iniciou: ${e.message}`; console.error('[injetor]', this.status); });
    this.proc.stdout.on('data', (d) => {
      const out = String(d);
      if (/^error /m.test(out)) {
        this.status = out.match(/^error (.*)$/m)[1];
        console.error('[injetor]', this.status);
      }
      const m = out.match(/^ready ?(.*)$/m);
      if (!this.ready && m) {
        this.ready = true;
        this.status = `ok ${m[1]}`.trim();
        console.log('[injetor]', this.status);
        for (const l of this.queue) this.proc.stdin.write(l + '\n');
        this.queue = [];
      }
    });
    this.proc.stderr.on('data', (d) => console.error('[injetor]', String(d).trim()));
    this.proc.stdin.on('error', () => {});
    const proc = this.proc;
    proc.on('exit', (code) => {
      console.error('[injetor] saiu com código', code);
      if (this.proc !== proc) return; // já foi substituído por um novo (restart)
      this.proc = null;
      this.ready = false;
    });
  }

  write(line) {
    // se o processo morreu, tenta de novo no máximo a cada 10 s (evita laço se o python3 não existir)
    if (!this.proc && Date.now() - (this.lastStart || 0) > 10_000) this.start();
    if (!this.proc) return;
    if (!this.ready) {
      this.queue.push(line);
      if (this.queue.length > 500) this.queue.shift();
      return;
    }
    this.proc.stdin.write(line + '\n');
  }

  move(x, y) { this.write(`M ${Math.round(x)} ${Math.round(y)}`); }

  // área total das telas (o modo uinput do Linux precisa para converter em coordenada absoluta)
  layout(r) { if (process.platform !== 'win32') this.write(`L ${r.x} ${r.y} ${r.width} ${r.height}`); }

  button(b, down) {
    if (down) this.buttonsDown.add(b); else this.buttonsDown.delete(b);
    this.write(`B ${b} ${down ? 1 : 0}`);
  }

  wheel(dy, dx) {
    if (dy) this.write(`W ${Math.round(dy)}`);
    if (dx) this.write(`H ${Math.round(dx)}`);
  }

  key(code, entry, down) {
    if (down) this.keysDown.set(code, entry); else this.keysDown.delete(code);
    const [scan, ext, vk] = entry;
    if (vk) this.write(`V ${vk} ${down ? 1 : 0}`);
    else this.write(`K ${scan} ${ext ? 1 : 0} ${down ? 1 : 0}`);
  }

  // solta tudo que ficou apertado (queda de conexão no meio de um Ctrl, por exemplo)
  releaseAll() {
    for (const [code, entry] of [...this.keysDown]) this.key(code, entry, false);
    for (const b of [...this.buttonsDown]) this.button(b, false);
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch {} }
    this.proc = null;
    this.ready = false;
  }

  // reabre o processo (ex.: depois de liberar o /dev/uinput no Linux)
  restart() {
    this.stop();
    this.status = '';
    this.lastStart = 0;
    this.start();
  }
}

module.exports = { Injector };
