# API → 數位孿生 BLOCK 橋接路線圖

> 使用者需求（2026-07-04）：「未來有 API 之後，要直接讓 API 能 CALL 到數位孿生的 BLOCK。」
> 目標＝讓外部系統（DCS/MES/排程器）透過 API 呼叫已訓練的模型（品質預測／設備健康度／
> 最佳化），並把結果直接注入 3D 數位孿生場景，讓孿生檢視即時反映模型輸出。

## 現況（已具備的基礎）

- 平台本身已是 FastAPI，Swagger 在 `/api-docs`。
- 模型推論端點已存在：`/api/automl/{sid}/models/{mid}/batch`（批次）、`/whatif`（單點）、
  `/optimize2`（多目標最佳化）。
- 孿生資料源抽象層已存在：`server/sources.py`（Sim / OPC UA / Modbus，`/api/datasource` 切換）、
  `History` ring buffer、`/api/history/{tag}`。
- 3D 場景 schema：`data/scenes/*.json`，設備有位號 `tag`。

## 三層橋接設計（分期）

### P1 — 模型 API 金鑰與「API 已啟用」開關
對標 Tukey 每個模型/目標的「API 已啟用」欄。
- `rec["api_enabled"]`（bool）＋每模型可發 `api_key`（存 `data/automl/{sid}/{mid}.json`，
  金鑰只存雜湊，明碼僅出示一次）。
- 新端點 `POST /api/v1/models/{token}/predict`（token 內含 sid+mid，或以 api_key 認證）：
  body=特徵 dict → 回預測值。走 `_predict_any`，與現有 whatif 同引擎。
- 權限：沿用 `server/auth.py` 的 admin 檢查發金鑰；外部呼叫走 api_key 免登入。

### P2 — 位號映射（資料欄 ↔ 3D 設備 tag）
把模型的輸出對應到 3D 場景的設備。這是「數據上 3D」閉環的關鍵缺口。
- 映射表 `data/scenes/{scene}.tagmap.json`：`{ "8AR1_TIC70016": "equip:R611", ... }`
  （資料位號 → 場景設備 uid/tag）。
- 映射 UI：孿生檢視或 P&ID 頁提供「資料位號 ↔ 設備」拖拉對應；OCR 位號可自動預填。
- `server/scenes.py` 加 `apply_readings(scene, {tag: value})`：把讀數寫進設備的即時狀態
  （沿用現有 `History`／熱力圖圖層）。

### P3 — 孿生注入 API（模型輸出 → 場景）
- `POST /api/v1/twin/{scene}/inject`：body=`{ readings: {tag: value}, health: {equip: score} }`
  → 依 tagmap 更新場景設備讀數與健康著色（綠/黃/紅），孿生檢視 WebSocket 即時推送。
- 典型串接：排程器每 5 分鐘 → 呼叫 `models/{token}/predict` 取設備健康分數 →
  `twin/{scene}/inject` 更新 3D → 現場大螢幕即時顯示廠區健康度。
- 設備健康度模型（PHM）的 0–100 分數直接對應設備著色，7 天預測對應趨勢箭頭。

## 閉環願景（七步旅程的最後一哩）
資料工作台建模 → 模型 API 啟用（P1）→ 位號映射（P2）→ 孿生注入（P3）
＝ AutoML 算出的設備健康分數／品質預測**即時映射到 3D 廠區設備上**，
把目前「內建模擬器驅動的孿生」升級為「真實模型輸出驅動的孿生」。

## NDA / 安全注意
- api_key 只存雜湊，不進版控（隨 `data/automl/` gitignore）。
- 外部注入端點須驗 api_key + 場景擁有者權限，避免任意寫入 3D 場景。
- 客戶位號經 tagmap 才對外，位號本身不隨 API 明碼外流（沿用 NDA 紀律）。
