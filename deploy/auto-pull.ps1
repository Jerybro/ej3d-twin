# deploy\auto-pull.ps1 — 桌機自動追版：push 到 origin/main 後 2 分鐘內自動部署
#
# 安裝（桌機「系統管理員」PowerShell，跑一次）：
#   powershell -ExecutionPolicy Bypass -File deploy\auto-pull.ps1 -Install
# 移除：同上加 -Uninstall。紀錄檔：deploy\auto-pull.log（不進版控）。
#
# 每輪檢查的行為（設計原則：寧可不動、絕不弄壞現場）：
#   1. 工作樹有未提交修改（追蹤檔）→ 略過並記 log，絕不清掉桌機上的修改
#   2. origin/main 沒新 commit → 靜默結束（不灌爆 log）
#   3. 有新版 → git pull --ff-only（發散不硬併，記 log 等人來）
#      → requirements.txt 有變更才 pip install
#      → 重啟服務 → healthz 健康檢查 40 秒
#      → 檢查失敗自動回退前一版並重啟（新版壞了不能讓網站一直躺著）
param(
  [switch]$Install,
  [switch]$Uninstall,
  [int]$IntervalMinutes = 2,
  [string]$ServiceName = "ej3d-twin",
  [string]$Branch = "main",
  [int]$Port = 8600,
  [string]$RepoDir = ""
)
$ErrorActionPreference = "Continue"   # git 寫 stderr 是常態，Stop 會誤殺
if (-not $RepoDir) { $RepoDir = Split-Path $PSScriptRoot -Parent }
$LogFile  = Join-Path $PSScriptRoot "auto-pull.log"
$TaskName = "ej3d-twin-autopull"

function Log($msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $msg
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Get-PythonPath {
  $venv = Join-Path $RepoDir ".venv\Scripts\python.exe"
  if (Test-Path $venv) { return $venv }
  $c = Get-Command python -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  # 排程是非互動工作階段，PATH 可能跟登入殼層不同——留一條絕對路徑後路
  return "C:\Users\Admin\AppData\Local\Microsoft\WindowsApps\python.exe"
}

function Get-ListeningPid {
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
    return ($c | Select-Object -First 1).OwningProcess
  } catch { return $null }
}

# 重啟服務——服務化與裸程序兩種跑法都要能處理。
# 桌機目前是使用者工作階段裡的 `python -m uvicorn`（不是 Windows 服務），
# 只呼叫 Restart-Service 會失敗退出，結果是「檔案更新了、跑的還是舊程式」——
# 對外網址看起來活著卻服務舊版，比整個掛掉更難察覺。
function Restart-App {
  $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($svc) {
    try { Restart-Service -Name $ServiceName -ErrorAction Stop; Log "[重啟] 服務 $ServiceName"; return $true }
    catch { Log "[錯誤] 服務重啟失敗：$_"; return $false }
  }
  $old = Get-ListeningPid
  if ($old) {
    try { Stop-Process -Id $old -Force -Confirm:$false } catch {}
    foreach ($i in 1..15) {                     # 沒等舊的死透就起新的，新程序會因連接埠被佔而靜默夭折
      Start-Sleep -Milliseconds 400
      if (-not (Get-ListeningPid)) { break }
    }
  }
  $py = Get-PythonPath
  try {
    Start-Process -FilePath $py -WindowStyle Hidden -WorkingDirectory $RepoDir `
      -ArgumentList '-m','uvicorn','server.main:app','--host','127.0.0.1','--port',"$Port"
    Log "[重啟] 程序模式 $py -m uvicorn :$Port"
    return $true
  } catch { Log "[錯誤] 程序啟動失敗：$_"; return $false }
}

function Test-Healthy {
  param([int]$Tries = 20)
  foreach ($i in 1..$Tries) {
    Start-Sleep -Seconds 2
    try {
      $r = Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $true }
    } catch {}
  }
  return $false
}

if ($Uninstall) {
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "已移除排程 $TaskName" }
  catch { Write-Host "排程不存在或移除失敗：$_" }
  exit 0
}

if ($Install) {
  # 轉移期防呆：這些路徑曾被版控、後來改列 gitignore（執行期狀態＋含客戶
  # 圖面資料）。從索引移除的那一版被 pull 下來時，git 會連working tree 的
  # 檔案一起刪——先整包備份、pull 完還原，機器上既有的圖組／模型不丟。
  $Runtime = @("data\pid_groups.json", "data\pid_model", "data\pid_notes")
  $Keep = Join-Path $env:TEMP ("ej3d-runtime-keep-" + (Get-Date -Format 'yyyyMMddHHmmss'))
  foreach ($rel in $Runtime) {
    $src = Join-Path $RepoDir $rel
    if (Test-Path $src) {
      $dst = Join-Path $Keep $rel
      New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
      Copy-Item $src $dst -Recurse -Force
    }
  }

  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -ServiceName $ServiceName -Branch $Branch -Port $Port" `
    -WorkingDirectory $RepoDir
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "已註冊排程 $TaskName：每 $IntervalMinutes 分鐘檢查 origin/$Branch，有新版自動部署 $ServiceName"
  Write-Host "立即執行第一次檢查…"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath `
      -ServiceName $ServiceName -Branch $Branch -Port $Port

  if (Test-Path $Keep) {                # 還原既有執行期資料（已改列 gitignore，不再擋 pull）
    foreach ($rel in $Runtime) {
      $src = Join-Path $Keep $rel
      if (-not (Test-Path $src)) { continue }
      $dst = Join-Path $RepoDir $rel
      New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
      Copy-Item $src $dst -Recurse -Force
      Write-Host "已還原 $rel（執行期資料，現已不進版控）"
    }
    Remove-Item $Keep -Recurse -Force
  }
  Write-Host "完成。紀錄檔：$LogFile"
  exit 0
}

# ---------------------------------------------------------------- 檢查模式
Set-Location $RepoDir

# 只看追蹤檔的修改：執行期新產生的檔案（未追蹤）不該擋更新
$dirty = git status --porcelain --untracked-files=no
if ($dirty) { Log "[略過] 工作樹有未提交修改，不自動 pull：$($dirty -join '; ')"; exit 0 }

git fetch origin $Branch --quiet
if ($LASTEXITCODE -ne 0) { Log "[錯誤] git fetch 失敗（網路？）"; exit 1 }
$local  = (git rev-parse HEAD).Trim()
$remote = (git rev-parse "origin/$Branch").Trim()
if ($local -eq $remote) {
  # 已是最新：靜默結束——但先確認服務真的活著。
  # 桌機重開機、或 uvicorn 當掉時，版本當然「沒落後」，光比對 commit
  # 會讓網站一路躺著沒人知道。追版與看門狗合在同一支排程，開機後
  # 第一次觸發就會把服務拉起來。
  if (-not (Get-ListeningPid)) {
    Log "[看門狗] 版本已最新，但 $Port 沒有服務在聽 → 啟動"
    if (Restart-App) {
      if (Test-Healthy) { Log "[看門狗] 服務已恢復，healthz OK" }
      else { Log "[看門狗] 啟動後健康檢查失敗，需人工介入" }
    }
  }
  exit 0
}

$pull = git pull --ff-only origin $Branch 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Log "[錯誤] pull 失敗（分支發散？）：$pull"; exit 1 }
Log ("[更新] {0} -> {1}" -f $local.Substring(0, 7), $remote.Substring(0, 7))

$changed = git diff --name-only $local $remote
if ($changed -match "requirements\.txt") {
  $py = Get-PythonPath
  Log "[依賴] requirements.txt 有變更，pip install"
  & $py -m pip install -r (Join-Path $RepoDir "requirements.txt") --quiet 2>&1 |
    Select-Object -Last 3 | ForEach-Object { Log "    $_" }
}

if (-not (Restart-App)) { exit 1 }

if (Test-Healthy) { Log "[完成] 新版上線，healthz OK" }
else {
  Log ("[回退] 健康檢查失敗，退回 {0}" -f $local.Substring(0, 7))
  git reset --hard $local 2>&1 | Out-Null
  if (Restart-App) {
    if (Test-Healthy -Tries 10) { Log "[回退] 完成，舊版已恢復服務——請查伺服器日誌找新版壞因，修好再 push" }
    else { Log "[回退] 舊版也起不來，網站目前是掛的，需人工介入" }
  }
}
