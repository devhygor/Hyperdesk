#!/usr/bin/env bash
# Instalador do Hyperdesk para Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/devhygor/Hyperdesk/main/install.sh | bash
#
# O que ele faz (pede a senha do sudo só para os passos do sistema):
#   1. descobre a distribuição e instala o que falta (FUSE 2 para o AppImage, python3, libXtst);
#   2. baixa a última versão (AppImage, que se atualiza sozinho) para ~/.local/share/hyperdesk;
#   3. cria o atalho no menu de aplicativos e o comando "hyperdesk";
#   4. libera o teclado/mouse virtual (/dev/uinput) para os outros PCs controlarem este no Wayland;
#   5. libera a rede de casa no ufw, se ele estiver ligado;
#   6. faz o Hyperdesk abrir sozinho ao entrar na sessão (use --sem-iniciar-junto para não fazer).
#
# Para remover:  curl -fsSL https://raw.githubusercontent.com/devhygor/Hyperdesk/main/install.sh | bash -s -- --remover
set -euo pipefail

REPO="devhygor/Hyperdesk"
APP_DIR="$HOME/.local/share/hyperdesk"
APP="$APP_DIR/Hyperdesk.AppImage"
BIN_DIR="$HOME/.local/bin"
DESKTOP="$HOME/.local/share/applications/hyperdesk.desktop"
ICON="$HOME/.local/share/icons/hicolor/256x256/apps/hyperdesk.png"
AUTOSTART="$HOME/.config/autostart/hyperdesk.desktop"
UDEV_RULE="/etc/udev/rules.d/60-hyperdesk-uinput.rules"
MODULES_CONF="/etc/modules-load.d/hyperdesk-uinput.conf"
APPARMOR_PROFILE="/etc/apparmor.d/hyperdesk"

say()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
info() { printf '    \033[1;36mi\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31mErro:\033[0m %s\n' "$*" >&2; exit 1; }

AUTOSTART_ON=1
REMOVE=0
for a in "$@"; do
  case "$a" in
    --sem-iniciar-junto) AUTOSTART_ON=0 ;;
    --remover) REMOVE=1 ;;
    *) die "opção desconhecida: $a" ;;
  esac
done

[ "$(id -u)" -ne 0 ] || die "rode sem sudo: o script pede a senha só quando precisar."

SUDO=""
if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi
need_root() {
  [ -n "$SUDO" ] || die "precisa do sudo para: $1"
}

# ------------------------------------------------------------------ remover
if [ "$REMOVE" = 1 ]; then
  say "Removendo o Hyperdesk"
  pkill -f "$APP" 2>/dev/null || true
  rm -f "$APP" "$BIN_DIR/hyperdesk" "$DESKTOP" "$ICON" "$AUTOSTART"
  rmdir "$APP_DIR" 2>/dev/null || true
  if [ -f "$UDEV_RULE" ] || [ -f "$MODULES_CONF" ]; then
    need_root "remover a regra do uinput"
    $SUDO rm -f "$UDEV_RULE" "$MODULES_CONF"
    $SUDO udevadm control --reload-rules 2>/dev/null || true
  fi
  if [ -f "$APPARMOR_PROFILE" ]; then
    need_root "remover o perfil do AppArmor"
    $SUDO apparmor_parser -R "$APPARMOR_PROFILE" 2>/dev/null || true
    $SUDO rm -f "$APPARMOR_PROFILE"
  fi
  ok "removido (as configurações ficam em ~/.config/Hyperdesk)"
  exit 0
fi

# ------------------------------------------------------------------ sistema
say "Verificando este PC"
ARCH="$(uname -m)"
[ "$ARCH" = "x86_64" ] || die "por enquanto só existe versão para PCs x86_64 (este é $ARCH)."

DISTRO="Linux"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO="${PRETTY_NAME:-${NAME:-Linux}}"
fi
ok "sistema: $DISTRO ($ARCH)"

SESSION="${XDG_SESSION_TYPE:-}"
[ -n "$SESSION" ] || { [ -n "${WAYLAND_DISPLAY:-}" ] && SESSION=wayland; } || true
[ -n "$SESSION" ] || { [ -n "${DISPLAY:-}" ] && SESSION=x11; } || true
ok "sessão gráfica: ${SESSION:-desconhecida}"

PM=""
for p in apt-get dnf zypper pacman; do
  if command -v "$p" >/dev/null 2>&1; then PM="$p"; break; fi
done
[ -n "$PM" ] && ok "gerenciador de pacotes: $PM" || warn "não reconheci o gerenciador de pacotes; vou só conferir o que já existe"

# ------------------------------------------------------------------ dependências
has_lib() {
  local f
  # o ldconfig fica em /sbin, fora do PATH de usuário comum em várias distros
  { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null || /usr/sbin/ldconfig -p 2>/dev/null; } | grep -q "$1" && return 0
  for f in /usr/lib/"$1"* /usr/lib64/"$1"* /usr/lib/*/"$1"* /lib/*/"$1"*; do
    [ -e "$f" ] && return 0
  done
  return 1
}
apt_has() { apt-cache show "$1" >/dev/null 2>&1; }

say "Instalando o que falta"
PKGS=()
case "$PM" in
  apt-get)
    has_lib libfuse.so.2 || { if apt_has libfuse2t64; then PKGS+=(libfuse2t64); else PKGS+=(libfuse2); fi; }
    has_lib libXtst.so.6 || PKGS+=(libxtst6)
    command -v python3 >/dev/null 2>&1 || PKGS+=(python3)
    command -v curl >/dev/null 2>&1 || PKGS+=(curl)
    ;;
  dnf)
    has_lib libfuse.so.2 || PKGS+=(fuse-libs)
    has_lib libXtst.so.6 || PKGS+=(libXtst)
    command -v python3 >/dev/null 2>&1 || PKGS+=(python3)
    ;;
  zypper)
    has_lib libfuse.so.2 || PKGS+=(libfuse2)
    has_lib libXtst.so.6 || PKGS+=(libXtst6)
    command -v python3 >/dev/null 2>&1 || PKGS+=(python3)
    ;;
  pacman)
    has_lib libfuse.so.2 || PKGS+=(fuse2)
    has_lib libXtst.so.6 || PKGS+=(libxtst)
    command -v python3 >/dev/null 2>&1 || PKGS+=(python)
    ;;
esac

if [ "${#PKGS[@]}" -gt 0 ]; then
  need_root "instalar ${PKGS[*]}"
  echo "    pacotes: ${PKGS[*]} (pode pedir sua senha)"
  case "$PM" in
    apt-get) $SUDO apt-get update -qq && DEBIAN_FRONTEND=noninteractive $SUDO -E apt-get install -y -qq "${PKGS[@]}" >/dev/null ;;
    dnf)     $SUDO dnf install -y -q "${PKGS[@]}" >/dev/null ;;
    zypper)  $SUDO zypper --non-interactive install "${PKGS[@]}" ;;
    pacman)  $SUDO pacman -S --needed --noconfirm "${PKGS[@]}" ;;
  esac
  ok "instalado: ${PKGS[*]}"
else
  ok "nada faltando"
fi

FUSE_OK=1
has_lib libfuse.so.2 || FUSE_OK=0
command -v python3 >/dev/null 2>&1 || warn "python3 não encontrado: os outros PCs vão ver a tela, mas não controlar"

# ------------------------------------------------------------------ download
say "Baixando a última versão"
JSON="$(curl -fsSL -H 'User-Agent: Hyperdesk-installer' "https://api.github.com/repos/$REPO/releases/latest")" \
  || die "não consegui falar com o GitHub (sem internet?)"
URL="$(printf '%s' "$JSON" | grep -o '"browser_download_url": *"[^"]*x86_64\.AppImage"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
VER="$(printf '%s' "$JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"v\{0,1\}\([^"]*\)"/\1/')"
[ -n "$URL" ] || die "não achei o AppImage na última release."
mkdir -p "$APP_DIR" "$BIN_DIR"
pkill -f "$APP" 2>/dev/null || true
curl -fL --progress-bar -o "$APP.tmp" "$URL"
mv -f "$APP.tmp" "$APP"
chmod +x "$APP"
ok "versão $VER em $APP"

# sem FUSE (distro sem o pacote), roda o AppImage extraindo na hora
RUN="$APP"
if [ "$FUSE_OK" = 0 ]; then
  warn "FUSE 2 não disponível: o atalho vai abrir com --appimage-extract-and-run (um pouco mais lento para abrir)"
  RUN="$APP --appimage-extract-and-run"
fi

# ------------------------------------------------------------------ AppArmor (Ubuntu 23.10+)
# O Ubuntu bloqueia "user namespaces" para programas sem perfil do AppArmor. O Chromium (base do
# Electron) usa isso como sandbox; sem ela, tenta a sandbox SUID, que no AppImage não funciona, e o
# app fecha com "The SUID sandbox helper binary was found, but is not configured correctly".
# Solução recomendada pelo Ubuntu: um perfil liberando userns só para o executável do Hyperdesk.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ]; then
  say "Ajustando a segurança do sistema (AppArmor)"
  need_root "criar o perfil do AppArmor"
  $SUDO tee "$APPARMOR_PROFILE" >/dev/null <<'EOF'
# Hyperdesk (AppImage): libera user namespaces para a sandbox do Chromium funcionar.
abi <abi/4.0>,
include <tunables/global>

profile hyperdesk /{tmp/.mount_Hyper*,tmp/appimage_extracted_*}/hyperdesk flags=(unconfined) {
  userns,

  include if exists <local/hyperdesk>
}
EOF
  if $SUDO apparmor_parser -r "$APPARMOR_PROFILE" 2>/dev/null; then
    ok "perfil do AppArmor criado em $APPARMOR_PROFILE"
  else
    $SUDO rm -f "$APPARMOR_PROFILE"
    warn "não consegui carregar o perfil do AppArmor; o Hyperdesk vai abrir com --no-sandbox"
    RUN="$RUN --no-sandbox"
  fi
fi

# ------------------------------------------------------------------ atalhos
say "Criando atalhos"
mkdir -p "$(dirname "$DESKTOP")" "$(dirname "$ICON")"
curl -fsSL -o "$ICON" "https://raw.githubusercontent.com/$REPO/main/assets/icon.png" || warn "não baixei o ícone"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Hyperdesk
Comment=Acesso remoto entre os PCs da casa
Exec=$RUN %U
Icon=hyperdesk
Terminal=false
Categories=Network;RemoteAccess;
StartupWMClass=Hyperdesk
EOF
printf '#!/bin/sh\nexec %s "$@"\n' "$RUN" > "$BIN_DIR/hyperdesk"
chmod +x "$BIN_DIR/hyperdesk"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP")" >/dev/null 2>&1 || true
ok "atalho no menu de aplicativos e comando 'hyperdesk'"

if [ "$AUTOSTART_ON" = 1 ]; then
  mkdir -p "$(dirname "$AUTOSTART")"
  cp "$DESKTOP" "$AUTOSTART"
  ok "abre sozinho ao entrar na sessão (para tirar: apague $AUTOSTART)"
fi

# ------------------------------------------------------------------ uinput (controle no Wayland)
say "Liberando o controle de mouse e teclado"
if [ -w /dev/uinput ]; then
  ok "/dev/uinput já liberado"
else
  need_root "liberar o /dev/uinput"
  # uaccess: o usuário logado na tela ganha acesso sozinho, sem precisar de grupo nem sair da sessão
  $SUDO mkdir -p "$(dirname "$UDEV_RULE")" "$(dirname "$MODULES_CONF")"
  printf 'KERNEL=="uinput", MODE="0660", TAG+="uaccess", OPTIONS+="static_node=uinput"\n' | $SUDO tee "$UDEV_RULE" >/dev/null
  echo uinput | $SUDO tee "$MODULES_CONF" >/dev/null
  $SUDO modprobe uinput 2>/dev/null || true
  $SUDO udevadm control --reload-rules 2>/dev/null || true
  $SUDO udevadm trigger --subsystem-match=misc --action=change 2>/dev/null || true
  sleep 1
  if [ -w /dev/uinput ]; then
    ok "/dev/uinput liberado"
  else
    warn "a regra foi criada; se o controle não funcionar, saia e entre de novo na sessão"
  fi
fi
if [ "$SESSION" = "wayland" ]; then
  info "aviso (não é erro): no Wayland, a cada conexão este PC mostra uma janela para escolher a tela;"
  info "alguém precisa clicar em Compartilhar aqui. Se a tela de login tiver a sessão Xorg, ela evita isso."
fi

# ------------------------------------------------------------------ firewall
if command -v ufw >/dev/null 2>&1 && [ -n "$SUDO" ]; then
  if $SUDO ufw status 2>/dev/null | grep -qE "Status: (active|ativo)"; then
    say "Liberando a rede de casa no firewall (ufw)"
    for net in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12 100.64.0.0/10; do
      $SUDO ufw allow from "$net" comment 'Hyperdesk' >/dev/null
    done
    ok "redes locais e Tailscale liberadas"
  fi
fi

# ------------------------------------------------------------------ pronto
say "Pronto!"
echo "    Abra o Hyperdesk pelo menu de aplicativos (ou rode: hyperdesk)."
echo "    Ele se atualiza sozinho quando sair versão nova."
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  # shellcheck disable=SC2086
  nohup $RUN >/dev/null 2>&1 &
  echo "    Abrindo agora…"
fi
