# Instalador do Hyperdesk para Windows.
#
#   irm https://raw.githubusercontent.com/devhygor/Hyperdesk/main/install.ps1 | iex
#
# Baixa o instalador da última versão, tira o bloqueio de "arquivo da internet" (evita a tela azul
# do SmartScreen) e instala. Depois o Hyperdesk se atualiza sozinho.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    OK  $t" -ForegroundColor Green }

Say 'Procurando a última versão'
$rel = Invoke-RestMethod 'https://api.github.com/repos/devhygor/Hyperdesk/releases/latest' -Headers @{ 'User-Agent' = 'Hyperdesk-installer' }
$asset = $rel.assets | Where-Object { $_.name -like 'Hyperdesk-Setup-*.exe' } | Select-Object -First 1
if (-not $asset) { throw 'Não achei o instalador na última release.' }
Ok "versão $($rel.tag_name)"

Say 'Baixando'
$out = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $out -UseBasicParsing
Unblock-File $out
Ok $out

Say 'Instalando'
Get-Process Hyperdesk -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process $out -Wait
Remove-Item $out -ErrorAction SilentlyContinue
Ok 'instalado (atalho no menu Iniciar e na área de trabalho)'

Write-Host "`nNa primeira vez que o Hyperdesk abrir, o Windows pergunta sobre o firewall:" -ForegroundColor Yellow
Write-Host "marque 'Redes privadas' e clique em 'Permitir acesso'." -ForegroundColor Yellow
