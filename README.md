# Hyperdesk

Acesso remoto para os PCs de casa: veja a tela de outro PC e controle-o com o mouse e o teclado deste, com a mesma ideia do AnyDesk/RustDesk, mas direto pela rede local, sem servidor no meio.

O mesmo app é instalado em todos os PCs. Cada um pode **ser controlado** e **controlar** os outros, nos dois sentidos, entre Windows e Linux.

## Instalar

Escolha o seu caso. Em todos eles o Hyperdesk fica instalado e **se atualiza sozinho** depois.

> Precisa instalar em **todos** os PCs: tanto no que vai controlar quanto no que vai ser controlado.

### Windows 10 / 11

**Jeito mais fácil:** abra o **PowerShell** (menu Iniciar → digite "PowerShell" → Enter), cole a linha abaixo e aperte Enter:

```powershell
irm https://raw.githubusercontent.com/devhygor/Hyperdesk/main/install.ps1 | iex
```

Ele baixa a última versão e instala sozinho. Não aparece a tela "O Windows protegeu o computador".

**Ou pelo navegador:**

1. Abra a página de [**Releases**](https://github.com/devhygor/Hyperdesk/releases/latest) e baixe **`Hyperdesk-Setup-x.y.z.exe`**.
2. Dê dois cliques no arquivo. Se aparecer **"O Windows protegeu o computador"**, clique em **Mais informações → Executar assim mesmo** (aparece porque o app não tem assinatura digital paga).
3. Ele instala sozinho e abre. O atalho fica no menu Iniciar e na área de trabalho.

**Nos dois jeitos:** na primeira vez que o Hyperdesk abrir, o Windows pergunta sobre o firewall. Marque **Redes privadas** e clique em **Permitir acesso**. Sem isso, os outros PCs não acham este.

Para usar sem instalar (num pendrive, por exemplo), baixe `Hyperdesk-Portatil-x.y.z.exe`. Essa versão só avisa quando sai versão nova; não se atualiza sozinha.

### Linux (Ubuntu, Mint, Pop!_OS, Debian, Fedora, Arch, Manjaro, openSUSE…)

Abra o **Terminal** (`Ctrl+Alt+T` na maioria das distros), cole a linha abaixo e aperte Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/devhygor/Hyperdesk/main/install.sh | bash
```

Se reclamar que o `curl` não existe, instale-o primeiro (`sudo apt install curl` no Ubuntu/Mint/Debian) e repita.

O instalador descobre sozinho qual é a sua distro e:

1. instala o que falta (o FUSE 2 que o AppImage precisa, que é o erro `libfuse.so.2`, o `python3` e a `libXtst`);
2. baixa a última versão para `~/.local/share/hyperdesk`;
3. cria o atalho no menu de aplicativos e o comando `hyperdesk`;
4. libera a permissão para os outros PCs controlarem o mouse e o teclado deste (`/dev/uinput`);
5. libera a rede de casa no firewall `ufw`, se ele estiver ligado;
6. faz o Hyperdesk abrir sozinho quando você entra na sessão, e já o abre.

Ele pede a sua senha uma vez (é o `sudo`, para instalar os pacotes e a permissão). Já foi testado no Ubuntu 24.04, Debian 12, Fedora 41 e Arch.

Opções:

```bash
# instalar sem abrir sozinho ao entrar na sessão
curl -fsSL https://raw.githubusercontent.com/devhygor/Hyperdesk/main/install.sh | bash -s -- --sem-iniciar-junto

# remover
curl -fsSL https://raw.githubusercontent.com/devhygor/Hyperdesk/main/install.sh | bash -s -- --remover
```

#### Instalar no Linux sem o script

<details>
<summary>Passo a passo manual por distro</summary>

1. Instale as dependências:

   | Distro | Comando |
   |---|---|
   | Ubuntu 24.04+ / Mint 22+ / Pop!_OS 24.04+ | `sudo apt install libfuse2t64 libxtst6 python3` |
   | Ubuntu 22.04 / Mint 21 / Debian 12 | `sudo apt install libfuse2 libxtst6 python3` |
   | Fedora | `sudo dnf install fuse-libs libXtst python3` |
   | Arch / Manjaro | `sudo pacman -S --needed fuse2 libxtst python` |
   | openSUSE | `sudo zypper install libfuse2 libXtst6 python3` |

   Instale **só** esses pacotes. No Ubuntu, não instale o pacote `fuse` sozinho: ele remove o `fuse3`, de que o sistema precisa.

2. Baixe `Hyperdesk-x.y.z-x86_64.AppImage` em [Releases](https://github.com/devhygor/Hyperdesk/releases/latest), e então:

   ```bash
   chmod +x Hyperdesk-*.AppImage
   ./Hyperdesk-*.AppImage
   ```

3. Libere o controle de mouse e teclado (só uma vez):

   ```bash
   echo 'KERNEL=="uinput", MODE="0660", TAG+="uaccess", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/60-hyperdesk-uinput.rules
   echo uinput | sudo tee /etc/modules-load.d/hyperdesk-uinput.conf
   sudo modprobe uinput && sudo udevadm control --reload-rules && sudo udevadm trigger
   ```

**Alternativa em Ubuntu/Mint/Debian:** o pacote `.deb` (`sudo apt install ./Hyperdesk-x.y.z-amd64.deb`) não precisa de FUSE, mas não se atualiza sozinho: ele só avisa e abre a página de download.

</details>

#### Bom saber no Linux

- Se faltar a permissão de controle, o app mostra um **aviso amarelo** com o botão **Liberar agora**, que pede a senha numa janela do sistema e resolve sem terminal.
- No **Wayland** (padrão no Ubuntu e no Fedora recentes), o sistema pede para escolher a tela a compartilhar **a cada conexão**. É uma regra de segurança do próprio Wayland. Para não ter essa pergunta, escolha a sessão **"Ubuntu em Xorg"** (ou "Xorg") na tela de login, na engrenagem do canto.
- O som do Linux ainda não é transmitido (só a imagem).

## Usar

1. Abra o Hyperdesk nos dois PCs.
2. No PC que vai controlar, o outro aparece em **Na sua rede**. Clique em **Conectar**.
3. Digite o **código de 6 dígitos** que aparece no outro PC, ou a **senha fixa** dele. Marque "lembrar" para não ter que digitar de novo.

Fora da rede de casa (pelo Tailscale, por exemplo), digite o IP no campo de conexão (`100.x.y.z` ou `ip:porta`).

Na janela de controle, a barra no topo some sozinha. Encoste o mouse no alto da janela para ela voltar. Nela dá para trocar de monitor, alternar entre Fluidez e Nitidez, ligar ou desligar o som, usar teclas que o sistema deste PC não deixa passar (Win, Alt+Tab, Ctrl+Shift+Esc…) e entrar em tela cheia (`Ctrl+Alt+Enter`).

O texto copiado num PC vai sozinho para a área de transferência do outro.

Enquanto alguém controla, o PC mostra um aviso fixo no topo com o botão **Desconectar**.

## Atualizações

O app consulta as releases deste repositório ao abrir e a cada 6 horas. Quando sai versão nova, aparece uma notificação do sistema e uma faixa no topo da janela:

- **Instalador do Windows e AppImage**: o botão **Atualizar agora** baixa a versão nova, e **Reiniciar e atualizar** instala.
- **Portátil e .deb**: o botão **Baixar** abre a página da release.
- **Linux instalado pelo script**: é o AppImage, então se atualiza sozinho.

## Como funciona

| Parte | Como |
|---|---|
| Descoberta | UDP broadcast na porta 47811 a cada 2 s |
| Sinalização | WebSocket na porta 47810 (servidor dentro do app) |
| Autenticação | O segredo não passa pela rede: o cliente deriva `PBKDF2(segredo, salt)` e devolve `HMAC(chave, nonce)`. Depois de 5 erros, o IP fica bloqueado por 5 min. O código muda a cada sessão |
| Vídeo e som | WebRTC P2P (DTLS), H.264 preferido (codificação por hardware), até 60 fps / 30 Mb/s, resolução cheia. Som do sistema só no Windows |
| Mouse e teclado (Windows) | Canal de dados do WebRTC → `src/input/inject.ps1` (C# via Add-Type): `SetCursorPos` + `SendInput` por scancode (ABNT2 → ABNT2 sem tradução) |
| Mouse e teclado (Linux) | `src/input/inject_linux.py` (só python3): XTest no X11, `/dev/uinput` no Wayland, por código evdev |
| Atualização | `src/updater.js`: API de releases do GitHub + `electron-updater` |

## Desenvolvimento

```powershell
npm install
npm start
```

Para testar duas instâncias no mesmo PC (as variáveis só valem fora do app empacotado):

```powershell
$env:HMD_PROFILE='a'; $env:HMD_TEST_PASSWORD='teste12345'; npx electron .
```

```powershell
$env:HMD_PROFILE='b'; $env:HMD_PORT='47820'; $env:HMD_AUTOCONNECT='127.0.0.1:47810'; $env:HMD_AUTOSECRET='teste12345'; $env:HMD_STATS_LOG='1'; npx electron .
```

`HMD_SNAPSHOT=<pasta>` salva prints das janelas depois de 9 s.

### Lançar uma versão

1. Mude `version` no `package.json` e faça commit.
2. `git tag v0.2.0 && git push origin main v0.2.0`

O GitHub Actions (`.github/workflows/release.yml`) gera os executáveis do Windows e do Linux e publica a release. Os apps instalados avisam sozinhos.

Para gerar localmente: `npm run dist:win` ou `npm run dist:linux` (o build do Linux precisa rodar no Linux).

## Limitações conhecidas

- Não controla janelas abertas como administrador nem a tela do UAC, a menos que o Hyperdesk também rode como administrador.
- Ctrl+Alt+Del não pode ser enviado (o Windows reserva essa combinação).
- O PC precisa estar logado e com o app aberto (ainda não roda como serviço).
- No Wayland com vários monitores, o mouse virtual cobre a área de todas as telas juntas; se ficar desalinhado, use uma tela só ou a sessão Xorg.

## Próximos passos

- **Monitor virtual**: criar uma segunda tela falsa no PC controlado (Virtual Display Driver) e mostrá-la neste PC, como se o notebook tivesse dois monitores.
- Rodar como serviço (tela de login/UAC), transferência de arquivos, mais de um controlador ao mesmo tempo.

## Licença

MIT
