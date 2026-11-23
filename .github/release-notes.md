## Instalar (jeito fácil)

**Windows**: abra o PowerShell e cole:

```powershell
irm https://raw.githubusercontent.com/devhygor/Hyperdesk/main/install.ps1 | iex
```

**Linux** (qualquer distro): abra o Terminal e cole:

```bash
curl -fsSL https://raw.githubusercontent.com/devhygor/Hyperdesk/main/install.sh | bash
```

O instalador do Linux resolve sozinho as dependências (inclusive o erro `libfuse.so.2`) e a permissão para o PC ser controlado.

## Ou baixe o arquivo

| Sistema | Arquivo | Atualiza sozinho? |
|---|---|---|
| Windows (recomendado) | `Hyperdesk-Setup-x.y.z.exe` | Sim |
| Windows sem instalar | `Hyperdesk-Portatil-x.y.z.exe` | Não (avisa e abre esta página) |
| Linux (qualquer distro) | `Hyperdesk-x.y.z-x86_64.AppImage` | Sim |
| Ubuntu / Debian / Mint | `Hyperdesk-x.y.z-amd64.deb` | Não (avisa e abre esta página) |

O passo a passo completo, por tipo de PC, está no [README](https://github.com/devhygor/Hyperdesk#instalar).
