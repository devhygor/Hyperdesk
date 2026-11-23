'use strict';
// Gera assets/icon.png (256x256) sem dependências: dois monitores sobrepostos num fundo escuro.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4);

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4;
  const A = a / 255, ia = 1 - A;
  const da = px[i + 3] / 255;
  const oa = A + da * ia;
  px[i] = Math.round((r * A + px[i] * da * ia) / (oa || 1));
  px[i + 1] = Math.round((g * A + px[i + 1] * da * ia) / (oa || 1));
  px[i + 2] = Math.round((b * A + px[i + 2] * da * ia) / (oa || 1));
  px[i + 3] = Math.round(oa * 255);
}

// distância com sinal até um retângulo arredondado (antisserrilhado de 1 px)
function rrect(x0, y0, x1, y1, rad, color, stroke = 0) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  for (let y = Math.floor(y0) - 2; y <= Math.ceil(y1) + 2; y++) {
    for (let x = Math.floor(x0) - 2; x <= Math.ceil(x1) + 2; x++) {
      const qx = Math.abs(x + 0.5 - cx) - (hw - rad), qy = Math.abs(y + 0.5 - cy) - (hh - rad);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
      let cov = stroke ? Math.min(Math.max(0.5 - d, 0), 1) * Math.min(Math.max(d + stroke + 0.5, 0), 1)
                       : Math.min(Math.max(0.5 - d, 0), 1);
      const [r, g, b, a] = typeof color === 'function' ? color(x, y) : color;
      blend(x, y, r, g, b, a * cov);
    }
  }
}

const grad = (x, y) => {
  const t = (x + y) / (2 * S);
  return [Math.round(91 + (139 - 91) * t), Math.round(140 + (92 - 140) * t), Math.round(255 + (246 - 255) * t), 255];
};

rrect(8, 8, 248, 248, 52, [16, 19, 28, 255]);
// monitor de trás
rrect(40, 62, 168, 150, 12, [91, 140, 255, 255], 10);
// monitor da frente (preenchido)
rrect(92, 108, 220, 196, 12, grad);
rrect(104, 120, 208, 184, 6, [16, 19, 28, 200]);
// pé
rrect(140, 204, 172, 214, 4, grad);

const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('ícone gerado em', out);
