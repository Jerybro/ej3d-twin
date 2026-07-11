#Requires -Version 5.1
<#
  serve-tailscale-funnel.ps1
  ---------------------------------------------------------------------------
  將 J.S_3D Studio / ej3d-twin (FastAPI, 127.0.0.1:8600) 透過 Tailscale Funnel
  對「公網」開放，取得 https://<host>.<tailnet>.ts.net 的公開網址（自動 TLS）。

  ⚠ 公網模式：應用層登入 (Google OAuth) 必須開啟。
     本腳本不會、也不該停用 auth；若偵測到 .env 內 AUTH_DISABLED 會大聲警告。

  用法（以「系統管理員」開 PowerShell 執行；NSSM 建服務需要管理員）：
     powershell -ExecutionPolicy Bypass -File deploy\serve-tailscale-funnel.ps1

  常用參數：
     -Port 8600            app 埠（預設 8600）
     -RepoDir <path>       repo 根（預設＝本腳本上一層）
     -ServiceName ej3d-twin  Windows 服務名
     -Python <path>        指定 python（預設自動偵測 .venv / python / py）
     -SkipService          只設 Funnel，不動服務
     -ServiceOnly          只設服務，不動 Funnel
  ---------------------------------------------------------------------------
#>
[CmdletBinding()]
param(
  [int]$Port = 8600,
  [string]$RepoDir,
  [string]$ServiceName = 'ej3d-twin',
  [string]$Python,
  [switch]$SkipService,
  [switch]$ServiceOnly
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "[deploy] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[warn ] $m" -ForegroundColor Yellow }
function Die ($m) { Write-Host "[fail ] $m" -ForegroundColor Red; exit 1 }
function Have($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# --- 0. 前置檢查 -----------------------------------------------------------
if (-not $RepoDir) { $RepoDir = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path (Join-Path $RepoDir 'server\main.py'))) {
  Die "在 $RepoDir 找不到 server\main.py，請用 -RepoDir 指定 repo 根目錄。"
}
Info "Repo 根：$RepoDir"

if (-not (Have 'tailscale')) { Die '找不到 tailscale CLI，請先安裝並執行 tailscale up。' }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
          ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $SkipService -and -not $isAdmin) {
  Warn '未以系統管理員執行——NSSM 服務設定可能失敗。請改用管理員 PowerShell，或加 -SkipService。'
}

if (-not $Python) {
  $venv = Join-Path $RepoDir '.venv\Scripts\python.exe'
  if (Test-Path $venv) { $Python = $venv }
  elseif (Have 'python') { $Python = (Get-Command python).Source }
  elseif (Have 'py') { $Python = (Get-Command py).Source }
  else { Die '找不到 python，請用 -Python 指定。' }
}
Info "Python：$Python"

# --- 1. 取得 Tailscale 網域 (MagicDNS 名) ----------------------------------
$fqdn = $null
try {
  $st = tailscale status --json | ConvertFrom-Json
  if ($st.Self -and $st.Self.DNSName) { $fqdn = $st.Self.DNSName.TrimEnd('.') }
} catch { }
if (-not $fqdn) { Die '無法取得 Tailscale DNSName。確認已 tailscale up，且 admin console 已開 MagicDNS。' }
$publicUrl = "https://$fqdn"
$redirect  = "https://$fqdn/login/google/callback"
Info "Tailscale 網域：$fqdn"

# --- 2. app 服務 (uvicorn 綁 127.0.0.1，只讓 Tailscale 當入口) --------------
$uvArgs = "-m uvicorn server.main:app --app-dir `"$RepoDir`" --host 127.0.0.1 --port $Port"
if (-not $SkipService) {
  if (Have 'nssm') {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
      Info "更新既有服務 $ServiceName"
      nssm set $ServiceName Application "$Python"   | Out-Null
      nssm set $ServiceName AppParameters "$uvArgs" | Out-Null
      nssm set $ServiceName AppDirectory "$RepoDir" | Out-Null
      nssm restart $ServiceName | Out-Null
    } else {
      Info "建立服務 $ServiceName"
      nssm install $ServiceName "$Python" | Out-Null
      nssm set $ServiceName AppParameters "$uvArgs"  | Out-Null
      nssm set $ServiceName AppDirectory "$RepoDir"  | Out-Null
      nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
      nssm start $ServiceName | Out-Null
    }
  } else {
    Warn 'NSSM 未安裝；改用背景程序啟動（重開機不會自動復原）。建議 choco install nssm 後重跑以取得開機自啟。'
    Start-Process -WindowStyle Hidden -FilePath "$Python" -ArgumentList $uvArgs -WorkingDirectory $RepoDir
  }

  # 健康檢查：等 app 起來（/ 為公開頁，未登入也應回 200）
  Info "等待 app 於 127.0.0.1:$Port 起來..."
  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { $ok = $true; break }
    } catch { Start-Sleep -Seconds 1 }
  }
  if ($ok) { Info 'app 本地健康檢查 OK。' }
  else { Warn "本地健康檢查未通過（可能仍在啟動或缺相依套件）。查服務記錄：pip install -r requirements.txt 是否完成。" }
}

# --- 3. .env：對齊 OAuth redirect，並做公網安全把關 -------------------------
$envPath = Join-Path $RepoDir '.env'
if (Test-Path $envPath) {
  $lines = @(Get-Content $envPath)
  if ($lines -match '^\s*AUTH_DISABLED\s*=\s*(1|true|yes)') {
    Warn '========================================================'
    Warn ' 危險：.env 內 AUTH_DISABLED 已開啟！'
    Warn ' 公網 Funnel 模式下這會讓「全世界」免登入直接進站。'
    Warn ' 請移除該行後重啟服務再對外開放。'
    Warn '========================================================'
  }
  $has = $false
  $new = foreach ($l in $lines) {
    if ($l -match '^\s*GOOGLE_REDIRECT_URI\s*=') { $has = $true; "GOOGLE_REDIRECT_URI=$redirect" }
    else { $l }
  }
  if (-not $has) { $new = @($new) + "GOOGLE_REDIRECT_URI=$redirect" }
  # 無 BOM 寫回（避免 python dotenv 解析第一個 key 出錯）
  [System.IO.File]::WriteAllLines($envPath, [string[]]$new, (New-Object System.Text.UTF8Encoding($false)))
  Info "已將 .env 的 GOOGLE_REDIRECT_URI 設為 $redirect"
  if (-not ($lines -match '^\s*GOOGLE_CLIENT_ID\s*=\S')) {
    Warn '.env 缺 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET，OAuth 無法運作，請補上後重啟服務。'
  }
} else {
  Warn ".env 不存在。公網模式必須有 OAuth：於 $envPath 建立並填入"
  Warn "  GOOGLE_CLIENT_ID=...  GOOGLE_CLIENT_SECRET=...  GOOGLE_REDIRECT_URI=$redirect"
}

# --- 4. Tailscale Funnel（公網 443 -> 127.0.0.1:Port）----------------------
if (-not $ServiceOnly) {
  Info "設定 Tailscale Funnel：公網 443 -> 127.0.0.1:$Port"
  tailscale funnel --bg $Port
  if ($LASTEXITCODE -ne 0) {
    Warn '啟用 Funnel 失敗，最常見原因：'
    Warn '  1) admin console → DNS 未開 MagicDNS / HTTPS Certificates'
    Warn '  2) 政策 (ACL) 未給本機 funnel node attribute（見 deploy\README-tailscale.md 範例）'
    Die  '修正後重跑；或加 -ServiceOnly 只設服務、稍後再開 Funnel。'
  }
  tailscale funnel status
}

# --- 5. 總結 ---------------------------------------------------------------
Write-Host ''
Write-Host '==================== 部署完成 ====================' -ForegroundColor Green
Write-Host "  公開網址 : $publicUrl"
Write-Host "  本地服務 : 127.0.0.1:$Port   (服務名 $ServiceName)"
Write-Host ''
Write-Host '  還要做（一次性）：' -ForegroundColor Yellow
Write-Host "   - Google Console -> OAuth client -> Authorized redirect URIs 加："
Write-Host "       $redirect"
Write-Host '   - 確認 tailnet ACL 已給本機 funnel 屬性、MagicDNS + HTTPS Certificates 已開'
Write-Host ''
Write-Host '  管理指令：'
Write-Host '   停止公開   : tailscale funnel reset'
Write-Host "   重啟服務   : nssm restart $ServiceName   (改版後 git pull 再執行)"
Write-Host "   服務/狀態  : Get-Service $ServiceName ; tailscale funnel status"
Write-Host '=================================================='
