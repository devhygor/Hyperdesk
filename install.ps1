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
# Não usar Start-Process -Wait: ele espera também os processos filhos, e o instalador abre o
# Hyperdesk no final (o script ficaria preso até fechar o app). E o instalador do electron-builder
# passa o trabalho para um segundo processo e sai logo: por isso esperamos o Hyperdesk.exe aparecer,
# e não apagamos o arquivo de instalação enquanto ele ainda está em uso.
$exe = Join-Path $env:LOCALAPPDATA 'Programs\hyperdesk\Hyperdesk.exe'
$versao = $rel.tag_name.TrimStart('v')
# numa atualização o .exe já existe: só vale quando ele estiver na versão nova
function Test-Instalado { (Test-Path $exe) -and ((Get-Item $exe).VersionInfo.ProductVersion -like "$versao*") }
$p = Start-Process $out -PassThru
$p.WaitForExit()
$limite = (Get-Date).AddMinutes(3)
while (-not (Test-Instalado) -and (Get-Date) -lt $limite) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Instalado)) { throw "A instalação não terminou. Rode de novo ou abra $out com dois cliques." }
Start-Sleep 2 # o instalador ainda abre o app sozinho logo depois
Ok 'instalado (atalho no menu Iniciar e na área de trabalho)'
if (-not (Get-Process Hyperdesk -ErrorAction SilentlyContinue)) { Start-Process $exe }

Write-Host "`nNa primeira vez que o Hyperdesk abrir, o Windows pergunta sobre o firewall:" -ForegroundColor Yellow
Write-Host "marque 'Redes privadas' e clique em 'Permitir acesso'." -ForegroundColor Yellow
