#!/usr/bin/env python3
"""Injetor de mouse/teclado do Hyperdesk para Linux (sem dependências além do python3).

Mesmo protocolo do inject.ps1 do Windows, uma linha por comando:
  L x y w h        área total das telas (para o modo uinput mapear coordenadas absolutas)
  M x y            move o mouse para (x, y)
  B botao 1|0      0 esq, 1 meio, 2 dir, 3 voltar, 4 avançar
  W delta          roda vertical (120 = um clique; positivo = para cima)
  H delta          roda horizontal (positivo = para a direita)
  K codigo _ 1|0   tecla pelo código evdev (KEY_*)

Modos:
  xtest  - X11 (ou apps XWayland), via libXtst
  uinput - Wayland (ou qualquer sessão), cria um teclado e um "tablet" virtuais em /dev/uinput;
           precisa de permissão de escrita em /dev/uinput (ver README)
"""
import ctypes
import ctypes.util
import fcntl
import os
import struct
import sys
import time


class XTest:
    name = 'xtest'

    def __init__(self):
        x11 = ctypes.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
        xt = ctypes.CDLL(ctypes.util.find_library('Xtst') or 'libXtst.so.6')
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XFlush.argtypes = [ctypes.c_void_p]
        xt.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
        xt.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        self.d = x11.XOpenDisplay(None)
        if not self.d:
            raise RuntimeError('não abriu o display X')
        self.x11, self.xt = x11, xt
        self.acc = {False: 0, True: 0}

    def flush(self):
        self.x11.XFlush(self.d)

    def layout(self, *a):
        pass

    def move(self, x, y):
        self.xt.XTestFakeMotionEvent(self.d, -1, x, y, 0)
        self.flush()

    def button(self, b, down):
        xb = {0: 1, 1: 2, 2: 3, 3: 8, 4: 9}.get(b)
        if xb:
            self.xt.XTestFakeButtonEvent(self.d, xb, 1 if down else 0, 0)
            self.flush()

    def wheel(self, delta, horizontal):
        self.acc[horizontal] += delta
        n = int(self.acc[horizontal] / 120)
        if not n:
            return
        self.acc[horizontal] -= n * 120
        if horizontal:
            btn = 7 if n > 0 else 6
        else:
            btn = 4 if n > 0 else 5
        for _ in range(abs(n)):
            self.xt.XTestFakeButtonEvent(self.d, btn, 1, 0)
            self.xt.XTestFakeButtonEvent(self.d, btn, 0, 0)
        self.flush()

    def key(self, code, down):
        self.xt.XTestFakeKeyEvent(self.d, code + 8, 1 if down else 0, 0)
        self.flush()


# ---- uinput (Wayland)
UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_SET_RELBIT = 0x40045566
UI_SET_ABSBIT = 0x40045567
UI_DEV_CREATE = 0x5501
EV_SYN, EV_KEY, EV_REL, EV_ABS = 0, 1, 2, 3
REL_HWHEEL, REL_WHEEL = 6, 8
REL_HWHEEL_HI_RES, REL_WHEEL_HI_RES = 12, 11
ABS_X, ABS_Y = 0, 1
BTNS = {0: 0x110, 1: 0x112, 2: 0x111, 3: 0x113, 4: 0x114}
ABS_MAX = 65535


class UInput:
    name = 'uinput'

    def __init__(self):
        self.kbd = self._create(b'Hyperdesk teclado', keys=range(1, 249))
        self.ptr = self._create(
            b'Hyperdesk mouse', keys=BTNS.values(),
            rels=(REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES), absolute=True,
        )
        self.area = (0, 0, 1920, 1080)
        self.acc = {False: 0, True: 0}
        time.sleep(0.4)  # o compositor precisa de um instante para adotar os dispositivos

    @staticmethod
    def _create(name, keys=(), rels=(), absolute=False):
        fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        for k in keys:
            fcntl.ioctl(fd, UI_SET_KEYBIT, k)
        if rels:
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_REL)
            for r in rels:
                fcntl.ioctl(fd, UI_SET_RELBIT, r)
        absmax = [0] * 64
        if absolute:
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_ABS)
            fcntl.ioctl(fd, UI_SET_ABSBIT, ABS_X)
            fcntl.ioctl(fd, UI_SET_ABSBIT, ABS_Y)
            absmax[ABS_X] = absmax[ABS_Y] = ABS_MAX
        dev = struct.pack('80sHHHHi' + '64i' * 4, name, 0x06, 0x1d6b, 0x0104, 1, 0,
                          *absmax, *([0] * 64), *([0] * 64), *([0] * 64))
        os.write(fd, dev)
        fcntl.ioctl(fd, UI_DEV_CREATE)
        return fd

    @staticmethod
    def _emit(fd, *events):
        buf = b''.join(struct.pack('llHHi', 0, 0, t, c, v) for t, c, v in events)
        os.write(fd, buf + struct.pack('llHHi', 0, 0, EV_SYN, 0, 0))

    def layout(self, x, y, w, h):
        if w > 1 and h > 1:
            self.area = (x, y, w, h)

    def move(self, x, y):
        ax, ay, aw, ah = self.area
        nx = max(0, min(ABS_MAX, round((x - ax) * ABS_MAX / (aw - 1))))
        ny = max(0, min(ABS_MAX, round((y - ay) * ABS_MAX / (ah - 1))))
        self._emit(self.ptr, (EV_ABS, ABS_X, nx), (EV_ABS, ABS_Y, ny))

    def button(self, b, down):
        if b in BTNS:
            self._emit(self.ptr, (EV_KEY, BTNS[b], 1 if down else 0))

    def wheel(self, delta, horizontal):
        hi = REL_HWHEEL_HI_RES if horizontal else REL_WHEEL_HI_RES
        lo = REL_HWHEEL if horizontal else REL_WHEEL
        self.acc[horizontal] += delta
        n = int(self.acc[horizontal] / 120)
        self.acc[horizontal] -= n * 120
        ev = [(EV_REL, hi, int(delta))]
        if n:
            ev.append((EV_REL, lo, n))
        self._emit(self.ptr, *ev)

    def key(self, code, down):
        if 0 < code < 249:
            self._emit(self.kbd, (EV_KEY, code, 1 if down else 0))


def pick():
    wayland = bool(os.environ.get('WAYLAND_DISPLAY')) or os.environ.get('XDG_SESSION_TYPE') == 'wayland'
    uinput_ok = os.access('/dev/uinput', os.W_OK)
    order = [UInput, XTest] if wayland else [XTest, UInput]
    errors = []
    for cls in order:
        if cls is UInput and not uinput_ok:
            errors.append('uinput: sem permissão em /dev/uinput')
            continue
        try:
            return cls()
        except Exception as e:  # noqa: BLE001
            errors.append(f'{cls.name}: {e}')
    raise RuntimeError('; '.join(errors))


def main():
    try:
        inj = pick()
    except Exception as e:  # noqa: BLE001
        print('error', e, flush=True)
        # continua lendo para o app não ficar reiniciando o processo
        for _ in sys.stdin:
            pass
        return
    wayland = os.environ.get('XDG_SESSION_TYPE') == 'wayland' or bool(os.environ.get('WAYLAND_DISPLAY'))
    print('ready', inj.name, 'wayland' if wayland else 'x11', flush=True)
    for line in sys.stdin:
        p = line.split()
        if not p:
            continue
        try:
            c = p[0]
            if c == 'M':
                inj.move(int(p[1]), int(p[2]))
            elif c == 'B':
                inj.button(int(p[1]), p[2] == '1')
            elif c == 'W':
                inj.wheel(int(p[1]), False)
            elif c == 'H':
                inj.wheel(int(p[1]), True)
            elif c == 'K':
                inj.key(int(p[1]), p[3] == '1')
            elif c == 'L':
                inj.layout(int(p[1]), int(p[2]), int(p[3]), int(p[4]))
        except Exception as e:  # noqa: BLE001
            print('warn', e, file=sys.stderr, flush=True)


if __name__ == '__main__':
    main()
