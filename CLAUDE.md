# ej3d-twin 專案規則

## 改動一律留紀錄（Jery 2026-08-18 明訂）

每次改動平台，**兩件事一起做**，不能只 commit：

1. `CHANGELOG.md` 的 `[Unreleased]` 底下加一條——寫**使用者看得到的差別**，一句話。實作細節留在 commit 訊息。
2. 決定要不要進版：修 bug／文案 → 修訂版（0.9.x）；新功能 → 次版本（0.x.0）；資料格式或 API 不相容 → 主版本。進版時同步改 `VERSION`、把 `[Unreleased]` 改成 `[x.y.z] — 日期`、commit 訊息 `release: x.y.z`。

版本的單一真相是 `VERSION` 檔；`/api/version` 讀它並附 commit 短碼；首頁頁尾顯示、點開就是變更紀錄。使用者回報問題要能說「0.9.0（56cf79a）」，不是「昨天那版」。

## 部署

正式站＝桌機 8600（Tailscale Funnel `desktop-gfudr3i.taila82213.ts.net`），裸 uvicorn 程序、不是 Windows 服務。
改完 push 後手動跑 `powershell -ExecutionPolicy Bypass -File deploy\auto-pull.ps1`（拉版→重啟→健檢，失敗自動回退）。排程目前**未啟用**（Jery 覺得每 2 分鐘閃視窗煩）。

開發用 8610：`AUTH_DISABLED=1 PID_DEV_DOMAIN=dev.local python -m uvicorn server.main:app --port 8610`，測試資料落在 `data/*/dev.local/`，測完刪掉。

## 不進版控的東西

`uploads/`、`data/pid_annot/`、`data/pid_model/`、`data/pid_notes/`、`data/pid_groups.json`、`data/pid_inspect/`、`logs/`、`server_8600.*.log`、`.env`。這些是執行期資料或含客戶圖面，`git add -A` 前看一眼 `git status`。
