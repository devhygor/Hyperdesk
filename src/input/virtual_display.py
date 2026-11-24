#!/usr/bin/env python3
"""Cria uma tela virtual (um monitor a mais) no GNOME/Wayland, para o Hyperdesk.

Usa a API do próprio GNOME (org.gnome.Mutter.ScreenCast, a mesma do gnome-remote-desktop):
"RecordVirtual" cria um monitor de mentira, e ele existe enquanto alguém consome o vídeo dele pelo
PipeWire. Este script consome e descarta esse vídeo (o Hyperdesk captura a tela pelo portal, como
qualquer outra). O tamanho do monitor é o que pedimos na negociação do formato.

Uso: virtual_display.py LARGURA ALTURA
Imprime "ready <largura>x<altura>" quando o monitor existe, ou "error <motivo>".
Termina (e o monitor some) quando a entrada padrão fecha ou recebe "quit".
"""
import json
import os
import subprocess
import sys
import threading

def say(msg):
    sys.stdout.write(msg + '\n')
    sys.stdout.flush()


DEBUG = os.environ.get('HMD_VD_DEBUG') == '1'


def dbg(msg):
    if DEBUG:
        sys.stderr.write('[vd] %s\n' % msg)
        sys.stderr.flush()

try:
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gio, GLib, Gst
except Exception as e:  # noqa: BLE001
    say('error faltam pacotes no Linux. Rode: sudo apt install python3-gi gir1.2-gstreamer-1.0 '
        'gstreamer1.0-pipewire (ou rode de novo o instalador do Hyperdesk). Detalhe: %s' % e)
    sys.exit(1)

W = int(sys.argv[1]) if len(sys.argv) > 1 else 1920
H = int(sys.argv[2]) if len(sys.argv) > 2 else 1080
BUS_NAME = 'org.gnome.Mutter.ScreenCast'
CLIENT = 'hyperdesk-virtual'

Gst.init(None)
loop = GLib.MainLoop()
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
state = {'session': None, 'pipeline': None, 'ready': False}


def call(path, iface, method, args, rtype=None):
    return bus.call_sync(BUS_NAME, path, iface, method, args,
                         GLib.VariantType(rtype) if rtype else None,
                         Gio.DBusCallFlags.NONE, 10000, None)


def stop(code=0):
    try:
        if state['pipeline'] is not None:
            state['pipeline'].set_state(Gst.State.NULL)
    except Exception:  # noqa: BLE001
        pass
    try:
        if state['session']:
            call(state['session'], BUS_NAME + '.Session', 'Stop', None)
    except Exception:  # noqa: BLE001
        pass
    loop.quit()
    sys.exit(code)


def fail(msg):
    say('error ' + msg)
    stop(1)


def on_gst_message(_bus, msg):
    t = msg.type
    dbg('gst %s de %s' % (t, msg.src.get_name() if msg.src else '?'))
    if t == Gst.MessageType.ERROR:
        err, _dbg = msg.parse_error()
        fail('PipeWire/GStreamer: %s' % err.message)
    elif t == Gst.MessageType.STATE_CHANGED and msg.src == state['pipeline']:
        _old, new, _pending = msg.parse_state_changed()
        if new == Gst.State.PLAYING and not state['ready']:
            state['ready'] = True
            say('ready %dx%d' % (W, H))


def on_stream_added(_conn, _sender, _path, _iface, _signal, params):
    node_id = params.unpack()[0]
    dbg('PipeWireStreamAdded nó %s' % node_id)
    src = Gst.ElementFactory.make('pipewiresrc', None)
    if src is None:
        fail('falta o pacote gstreamer1.0-pipewire (sudo apt install gstreamer1.0-pipewire)')
        return
    # "target-object" nas versões novas do PipeWire, "path" nas antigas
    names = [p.name for p in src.list_properties()]
    src.set_property('target-object' if 'target-object' in names else 'path', str(node_id))
    if 'always-copy' in names:
        src.set_property('always-copy', True)
    if 'client-name' in names:
        src.set_property('client-name', CLIENT)
    state['node'] = node_id
    caps = Gst.ElementFactory.make('capsfilter', None)
    capstr = os.environ.get('HMD_VD_CAPS') or 'video/x-raw,format=BGRx,width=%d,height=%d' % (W, H)
    # sem "framerate": o GNOME oferece taxa variável (0/1) e qualquer faixa aqui impede a negociação
    dbg('caps ' + capstr)
    caps.set_property('caps', Gst.Caps.from_string(capstr))
    sink = Gst.ElementFactory.make('fakesink', None)
    sink.set_property('sync', False)
    p = Gst.Pipeline.new('hmd-virtual')
    for e in (src, caps, sink):
        p.add(e)
    src.link(caps)
    caps.link(sink)
    gbus = p.get_bus()
    gbus.add_signal_watch()
    gbus.connect('message', on_gst_message)
    state['pipeline'] = p
    # o pipewiresrc fica esperando a ligação dentro do set_state: roda em outro fio para o laço
    # principal (temporizadores, entrada padrão) continuar andando
    def go():
        if p.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
            GLib.idle_add(lambda: fail('não consegui ligar o vídeo da tela virtual'))
    threading.Thread(target=go, daemon=True).start()
    # Quem liga o vídeo do GNOME a este script é o gerenciador do PipeWire (WirePlumber). Se em 4 s
    # não ligou, liga à mão com o pw-link.
    GLib.timeout_add_seconds(4, link_by_hand)


def link_by_hand():
    if state['ready']:
        return False
    try:
        objs = json.loads(subprocess.run(['pw-dump'], capture_output=True, text=True, timeout=5).stdout or '[]')
    except Exception as e:  # noqa: BLE001
        dbg('pw-dump falhou: %s' % e)
        return False
    nodes = {o['id']: o for o in objs if o.get('type', '').endswith('Node')}
    mine = [i for i, o in nodes.items()
            if CLIENT in (o['info']['props'].get('application.name', ''), o['info']['props'].get('node.name', ''))]
    outs, ins = [], []
    for o in objs:
        if not o.get('type', '').endswith('Port'):
            continue
        pr = o['info']['props']
        nid = pr.get('node.id')
        if nid == state.get('node') and o['info'].get('direction') == 'output':
            outs.append(o['id'])
        if nid in mine and o['info'].get('direction') == 'input':
            ins.append(o['id'])
    dbg('ligando à mão: saídas %s -> entradas %s' % (outs, ins))
    for a, b in zip(outs, ins):
        subprocess.run(['pw-link', str(a), str(b)], capture_output=True, timeout=5)
    return False


def on_stdin(source, _cond):
    line = source.readline()
    if not line or line.strip() == 'quit':
        stop(0)
        return False
    return True


def main():
    try:
        session = call('/org/gnome/Mutter/ScreenCast', BUS_NAME, 'CreateSession',
                       GLib.Variant('(a{sv})', ({},)), '(o)').unpack()[0]
    except GLib.Error as e:
        fail('o GNOME não deixou criar a tela virtual (%s)' % e.message)
        return
    state['session'] = session
    dbg('sessão %s' % session)
    try:
        # cursor-mode 0 = sem seta no vídeo (o vídeo deste script é descartado mesmo)
        stream = call(session, BUS_NAME + '.Session', 'RecordVirtual',
                      GLib.Variant('(a{sv})', ({'cursor-mode': GLib.Variant('u', 0)},)), '(o)').unpack()[0]
    except GLib.Error as e:
        fail('RecordVirtual falhou (%s)' % e.message)
        return
    dbg('stream %s' % stream)
    bus.signal_subscribe(BUS_NAME, BUS_NAME + '.Stream', 'PipeWireStreamAdded', stream, None,
                         Gio.DBusSignalFlags.NONE, on_stream_added)
    try:
        call(session, BUS_NAME + '.Session', 'Start', None)
        dbg('Start ok')
    except GLib.Error as e:
        fail('não consegui iniciar a tela virtual (%s)' % e.message)
        return
    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, on_stdin)
    # se em 15 s o monitor não estiver pronto, desiste
    GLib.timeout_add_seconds(15, lambda: (not state['ready'] and fail('a tela virtual não ficou pronta')) and False)
    loop.run()


if __name__ == '__main__':
    main()
