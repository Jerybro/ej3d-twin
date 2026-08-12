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

if ($Uninstall) {
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Host "已移除排程 $TaskName" }
  catch { Write-Host "排程不存在或移除失敗：$_" }
  exit 0
}

if ($Install) {
  # 轉移期防呆：pid_groups.json 曾被版控、新版改為執行期狀態檔（gitignore）。
  # 第一次 pull 會把它從索引移除並刪檔——先備份、pull 完還原，桌機圖組不丟。
  $pg = Join-Path $RepoDir "data\pid_groups.json"
  if (Test-Path $pg) { Copy-Item $pg "$pg.keep" -Force }
  git -C $RepoDir ls-files --error-unmatch data/pid_groups.json 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { git -C $RepoDir checkout -- data/pid_groups.json 2>$null }

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

  if (Test-Path "$pg.keep") {           # 還原桌機既有圖組（檔已改列 gitignore，不再擋 pull）
    Copy-Item "$pg.keep" $pg -Force; Remove-Item "$pg.keep" -Force
    Write-Host "已還原 data\pid_groups.json（執行期狀態，現已不進版控）"
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
if ($local -eq $remote) { exit 0 }    # 已是最新：靜默

$pull = git pull --ff-only origin $Branch 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Log "[錯誤] pull 失敗（分支發散？）：$pull"; exit 1 }
Log ("[更新] {0} -> {1}" -f $local.Substring(0, 7), $remote.Substring(0, 7))

$changed = git diff --name-only $local $remote
if ($changed -match "requirements\.txt") {
  $py = Join-Path $RepoDir ".venv\Scripts\python.exe"
  if (-not (Test-Path $py)) { $py = "python" }
  Log "[依賴] requirements.txt 有變更，pip install"
  & $py -m pip install -r (Join-Path $RepoDir "requirements.txt") --quiet 2>&1 |
    Select-Object -Last 3 | ForEach-Object { Log "    $_" }
}

try { Restart-Service -Name $ServiceName -ErrorAction Stop; Log "[重啟] $ServiceName" }
catch { Log "[錯誤] 服務重啟失敗：$_"; exit 1 }

$ok = $false
foreach ($i in 1..20) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch {}
}
if ($ok) { Log "[完成] 新版上線，healthz OK" }
else {
  Log ("[回退] 健康檢查失敗，退回 {0}" -f $local.Substring(0, 7))
  git reset --hard $local 2>&1 | Out-Null
  try { Restart-Service -Name $ServiceName -ErrorAction Stop } catch { Log "[回退] 服務重啟又失敗：$_" }
  Log "[回退] 完成——請查伺服器日誌找新版壞因，修好再 push"
}
