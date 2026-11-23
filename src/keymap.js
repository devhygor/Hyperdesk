'use strict';
// KeyboardEvent.code -> [scancode, extended, vk]
// Usamos scancode (posição física da tecla): o layout do PC controlado decide o caractere,
// então ABNT2 -> ABNT2 funciona sem tradução. Algumas teclas só funcionam bem por VK.
const K = {};
const set = (code, scan, ext = 0) => { K[code] = [scan, ext, 0]; };

set('Escape', 0x01);
'1234567890'.split('').forEach((d, i) => set('Digit' + d, 0x02 + i));
set('Minus', 0x0c); set('Equal', 0x0d); set('Backspace', 0x0e); set('Tab', 0x0f);
'QWERTYUIOP'.split('').forEach((c, i) => set('Key' + c, 0x10 + i));
set('BracketLeft', 0x1a); set('BracketRight', 0x1b); set('Enter', 0x1c); set('ControlLeft', 0x1d);
'ASDFGHJKL'.split('').forEach((c, i) => set('Key' + c, 0x1e + i));
set('Semicolon', 0x27); set('Quote', 0x28); set('Backquote', 0x29); set('ShiftLeft', 0x2a); set('Backslash', 0x2b);
'ZXCVBNM'.split('').forEach((c, i) => set('Key' + c, 0x2c + i));
set('Comma', 0x33); set('Period', 0x34); set('Slash', 0x35); set('ShiftRight', 0x36);
set('NumpadMultiply', 0x37); set('AltLeft', 0x38); set('Space', 0x39); set('CapsLock', 0x3a);
for (let i = 1; i <= 10; i++) set('F' + i, 0x3a + i);
set('ScrollLock', 0x46);
set('Numpad7', 0x47); set('Numpad8', 0x48); set('Numpad9', 0x49); set('NumpadSubtract', 0x4a);
set('Numpad4', 0x4b); set('Numpad5', 0x4c); set('Numpad6', 0x4d); set('NumpadAdd', 0x4e);
set('Numpad1', 0x4f); set('Numpad2', 0x50); set('Numpad3', 0x51); set('Numpad0', 0x52); set('NumpadDecimal', 0x53);
set('IntlBackslash', 0x56); set('F11', 0x57); set('F12', 0x58);
set('IntlRo', 0x73); set('IntlYen', 0x7d); set('NumpadComma', 0x7e);

// estendidas (prefixo E0)
set('NumpadEnter', 0x1c, 1); set('ControlRight', 0x1d, 1); set('NumpadDivide', 0x35, 1);
set('PrintScreen', 0x37, 1); set('AltRight', 0x38, 1);
set('Home', 0x47, 1); set('ArrowUp', 0x48, 1); set('PageUp', 0x49, 1);
set('ArrowLeft', 0x4b, 1); set('ArrowRight', 0x4d, 1);
set('End', 0x4f, 1); set('ArrowDown', 0x50, 1); set('PageDown', 0x51, 1);
set('Insert', 0x52, 1); set('Delete', 0x53, 1);
set('MetaLeft', 0x5b, 1); set('MetaRight', 0x5c, 1); set('ContextMenu', 0x5d, 1);

// por VK
K.NumLock = [0, 0, 0x90];
K.Pause = [0, 0, 0x13];
K.AudioVolumeMute = [0, 0, 0xad];
K.AudioVolumeDown = [0, 0, 0xae];
K.AudioVolumeUp = [0, 0, 0xaf];
K.MediaTrackNext = [0, 0, 0xb0];
K.MediaTrackPrevious = [0, 0, 0xb1];
K.MediaPlayPause = [0, 0, 0xb3];

// Linux: código evdev (KEY_*). Para as teclas comuns (scancode set 1 até 0x58) ele é igual ao
// scancode; as estendidas e as de mídia têm números próprios.
const LINUX_EXTRA = {
  NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
  Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107,
  ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
  MetaLeft: 125, MetaRight: 126, ContextMenu: 127,
  NumLock: 69, Pause: 119, IntlRo: 89, IntlYen: 124, NumpadComma: 121,
  AudioVolumeMute: 113, AudioVolumeDown: 114, AudioVolumeUp: 115,
  MediaTrackNext: 163, MediaPlayPause: 164, MediaTrackPrevious: 165,
};
const L = {};
for (const [code, [scan, ext, vk]] of Object.entries(K)) {
  if (code in LINUX_EXTRA) L[code] = [LINUX_EXTRA[code], 0, 0];
  else if (!ext && !vk && scan <= 0x58) L[code] = [scan, 0, 0];
}

module.exports = { KEYMAP: process.platform === 'linux' ? L : K };
