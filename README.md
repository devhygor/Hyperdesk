# Hyperdesk

Acesso remoto para os PCs de casa: veja a tela de outro PC e controle-o com o mouse e o teclado deste, com a mesma ideia do AnyDesk/RustDesk, mas direto pela rede local, sem servidor no meio.

O mesmo app é instalado em todos os PCs. Cada um pode **ser controlado** e **controlar** os outros, nos dois sentidos, entre Windows e Linux.

## Instalar

Baixe a última versão em **[Releases](https://github.com/devhygor/Hyperdesk/releases/latest)**.

### Windows

1. Baixe `Hyperdesk-Setup-x.y.z.exe` e execute. Ele se instala sozinho e cria o atalho.
   - Como o app não tem assinatura digital paga, o Windows pode mostrar "O Windows protegeu o computador". Clique em **Mais informações → Executar assim mesmo**.
2. Na primeira vez que abrir, o Windows pergunta sobre o firewall. Marque **Redes privadas** e clique em **Permitir**.

Para usar sem instalar, baixe `Hyperdesk-Portatil-x.y.z.exe`. Essa versão só avisa quando sai versão nova; não se atualiza sozinha.

### Linux

**AppImage** (qualquer distribuição, atualiza sozinho):

```bash
chmod +x Hyperdesk-*.AppImage
./Hyperdesk-*.AppImage
```

No Ubuntu 22.04 ou mais novo, se reclamar de FUSE: `sudo apt install libfuse2` (no 24.04: `sudo apt install libfuse2t64`).

**.deb** (Ubuntu, Debian, Mint):

```bash
sudo apt install ./Hyperdesk-*-amd64.deb
```

#### Deixar o Linux ser controlado

Para *controlar outros PCs* a partir do Linux, não precisa de nada além de instalar. Para os outros PCs *controlarem* o Linux, depende da sessão gráfica:

- **X11 / Xorg**: funciona direto.
- **Wayland** (padrão no Ubuntu e no Fedora recentes): o app cria um teclado e um mouse virtuais, e para isso precisa de permissão no `/dev/uinput`. Rode uma vez:

  ```bash
  echo 'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/60-hyperdesk-uinput.rules
  sudo usermod -aG input "$USER"
  sudo udevadm control --reload-rules && sudo udevadm trigger
  ```

  Depois saia e entre de novo na sessão. No Wayland, o sistema também pede para escolher a tela a compartilhar a cada conexão (é a regra de segurança do Wayland). Para não ter essa pergunta, escolha **"Ubuntu em Xorg"** na tela de login.

Sem permissão, a tela do Linux aparece normalmente para os outros PCs, mas o mouse e o teclado não respondem. O app mostra um aviso amarelo explicando isso.

Se o firewall `ufw` estiver ligado, libere a rede de casa: `sudo ufw allow from 192.168.0.0/16`.

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
