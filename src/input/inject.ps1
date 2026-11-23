# Injetor de mouse/teclado do Hyperdesk.
# Lê comandos pela entrada padrão, um por linha, e chama SendInput:
#   M x y            move o mouse para (x, y) em pixels físicos da área de trabalho virtual
#   B botao 1|0      botão (0 esq, 1 meio, 2 dir, 3 voltar, 4 avançar) apertado/solto
#   W delta          roda vertical (120 = um "clique" da roda; positivo = para cima)
#   H delta          roda horizontal (positivo = para a direita)
#   K scan ext 1|0   tecla por scancode (ext = prefixo E0)
#   V vk 1|0         tecla por virtual-key
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HmdInj {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);

  static readonly int SZ = Marshal.SizeOf(typeof(INPUT));

  static void Send(INPUT i) { SendInput(1, new INPUT[] { i }, SZ); }

  static INPUT Mouse(int dx, int dy, int data, uint flags) {
    var i = new INPUT(); i.type = 0;
    i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags;
    return i;
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT(); i.type = 1;
    i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags;
    return i;
  }

  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);

  // SetCursorPos e não SendInput ABSOLUTE: com monitores de alturas/posições diferentes o modo
  // absoluto (0..65535 da área virtual) erra dezenas de pixels; SetCursorPos acerta o pixel exato.
  public static void Move(int x, int y) { SetCursorPos(x, y); }

  public static void Button(int b, bool down) {
    uint f; int data = 0;
    switch (b) {
      case 0: f = down ? 0x0002u : 0x0004u; break;
      case 1: f = down ? 0x0020u : 0x0040u; break;
      case 2: f = down ? 0x0008u : 0x0010u; break;
      case 3: f = down ? 0x0080u : 0x0100u; data = 1; break;
      case 4: f = down ? 0x0080u : 0x0100u; data = 2; break;
      default: return;
    }
    Send(Mouse(0, 0, data, f));
  }

  public static void Wheel(int d, bool horizontal) { Send(Mouse(0, 0, d, horizontal ? 0x1000u : 0x0800u)); }

  public static void KeyScan(int scan, bool ext, bool down) {
    uint f = 0x0008; // SCANCODE
    if (ext) f |= 0x0001;
    if (!down) f |= 0x0002;
    Send(Key(0, (ushort)scan, f));
  }

  public static void KeyVk(int vk, bool down) { Send(Key((ushort)vk, 0, down ? 0u : 0x0002u)); }

  public static void Run() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    Console.Out.WriteLine("ready"); Console.Out.Flush();
    string l;
    while ((l = Console.In.ReadLine()) != null) { try { Do(l); } catch { } }
  }

  static void Do(string l) {
    var p = l.Split(' ');
    switch (p[0]) {
      case "M": Move(int.Parse(p[1]), int.Parse(p[2])); break;
      case "B": Button(int.Parse(p[1]), p[2] == "1"); break;
      case "W": Wheel(int.Parse(p[1]), false); break;
      case "H": Wheel(int.Parse(p[1]), true); break;
      case "K": KeyScan(int.Parse(p[1]), p[2] == "1", p[3] == "1"); break;
      case "V": KeyVk(int.Parse(p[1]), p[2] == "1"); break;
    }
  }
}
'@
[HmdInj]::Run()
