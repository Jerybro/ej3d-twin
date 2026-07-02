# EJ_3D 數位孿生平台 MVP

穎杰科技「領航示範案・產品3（全廠 3D 數位孿生平台）」的 localhost Web MVP。

對應簡報需求（產品3 宣稱逐項落地）：
- **M1** 3D 廠區場景漫遊（程式生成的特化廠示範場景，之後可換掃描實景）
- **M2** 設備熱點：點擊設備 → 資訊卡（位號、設計資料、即時儀錶）＋ **P&ID 示意圖面**（自資產資料庫生成，實案掛接 P&ID／ISO 配管／電氣系統圖）
- **10 個預載典型風險情境**：洩漏（法蘭／人孔／軸封／破管／管廊）、火災（閥門誤操作／攪拌失效／電氣）、**氣爆**（超壓破裂盤／蒸氣雲 VCE），各含風向擴散、危險區域、疏散路徑動畫
- **預設情境比對法（核心）**：「⚡ 異常注入（盲測）」隨機注入一組異常感測訊號 → 比對引擎依 DCS 偏移特徵向量對 10 個情境做相似度排序 → 信心值過門檻（80%＋領先 10%＋連續 3 tick）自動確認並觸發 3D 情境。實測 6–18 秒正確命中
- **施工模擬**：二期規劃設備／管線 ghost 檢視、對既有設備自動衝突檢測（硬碰撞／淨距不足 1.0 m 分級）、點衝突飛到現場
- **工安 AI 影像監識**：AI 攝影機視錐、儲槽區電子圍籬、人員動線模擬；「🚧 模擬闖入」演示闖入管制區告警、承攬商未戴安全帽（PPE）辨識
- **Omniverse 相容**：一鍵匯出 OpenUSD（.usda），可直接用 USD Composer / usdview 開啟

## Omniverse 前導平台定位（無痛遷移路徑）

真 Omniverse 需要 RTX 工作站等級硬體；本平台的定位是**前導平台**——資料層以
OpenUSD 為唯一交換格式，展示層用 Three.js 跑在任何筆電（含內顯），之後上
Omniverse **不需要重做資料**：

| 階段 | 硬體 | 內容 |
|---|---|---|
| 0（現在） | 任何 PC／內顯筆電 | Three.js 前導平台＋USD 匯出 |
| 1 | 單機 RTX | `plant.usda` 直接開進 USD Composer／usdview：同一座廠（幾何＋UsdPreviewSurface 材質＋管線＋情境層＋施工層） |
| 2 | 工作站／伺服器 | 接 Omniverse Nucleus（omni.client 推送同一份 USD）；AI 攝影機已是 UsdGeomCamera，可直接進 Isaac Sim 產工安辨識合成訓練影像 |

USD 匯出內容（經 pip `usd-core`（Pixar OpenUSD）解析驗證，119 prims）：
- `/Plant/U_*`：設備階層＋幾何＋材質＋`ej:*` 自訂屬性（tag／pid／instruments，供下游綁即時數據）
- `/Plant/Piping`：逐段管線（含方位四元數）
- `/Plant/Surveillance`：AI 攝影機 → **UsdGeomCamera**（FOV 換算 focalLength）
- `/Plant/Scenarios`：10 個工安情境（危險區／洩漏點／疏散路徑，預設 invisible，Composer 切 visibility 重現）
- `/Plant/Safety`＋`/Plant/Construction`：電子圍籬＋施工規劃（purpose=guide）

## 渲染負擔（簡報筆電對策）

topbar「效能」chip：**自動（FPS 降階）→ 高 → 中 → 低** 循環切換。
- 低檔：pixelRatio 0.75（渲染像素 −86%）、關陰影、關環境反射、粒子 35%
- 自動：FPS < 28 持續 3 秒自動降檔；> 55 持續 10 秒升檔
- 簡報用內顯筆電建議直接點成「低」鎖定

## 啟動

```bash
pip install fastapi uvicorn
python -m uvicorn server.main:app --app-dir <本資料夾路徑> --port 8600
# 瀏覽器開 http://localhost:8600
```

## 架構

```
data/plant.json     單一真相來源：廠區階層 / 設備 / 儀錶 / 情境（前端3D、模擬器、USD匯出共用）
server/main.py      FastAPI：REST + WebSocket 假數據模擬器（之後換 OPC UA / PI 讀值）
server/usd_export.py OpenUSD 匯出（Plant→Unit→Equipment 階層 + ej:tag 等自訂屬性）
static/             Three.js 前端（場景、熱點、情境特效、WebXR-ready）
scans/              放手機掃描重建的 .glb；在 plant.json 加 "scan_model": "檔名.glb" 即載入
exports/            USD 匯出輸出
```

## 掃描/外部資產載入

大檔不進版控，clone 後先補齊示範資產：

```bash
python tools/fetch_demo_assets.py
```

- **網格（.glb/.gltf）**：丟進 `scans/`，在 `data/plant.json` 的 `scan_models` 加一筆
  `{ "file", "pos", "rot_y", "scale", "label" }`，重新整理即載入。
  示範用 Poly Haven「Modular Industrial Pipes 01」（CC0，可商用）。
- **3DGS（.splat/.ply/.ksplat）**：設定 `plant.json` 的 `splat_scene`，
  介面右上「3DGS 掃描檢視」按鈕切換真實掃描場景（@mkkellogg/gaussian-splats-3d）。

> ⚠ **3DGS 檢視需要獨立 GPU。** 在 Snapdragon（ARM）筆電上 ANGLE 轉譯層
> 編譯 3DGS 著色器極慢且會拖垮整個瀏覽器 GPU 行程——請在 RTX 桌機驗證。
> 示範檔：`nike.splat`（8MB 輕量測試）、`train.splat`（32MB 工業感場景，桌機用）。
> 注意：splat 示範檔屬公開研究資料集，僅供功能測試，勿用於對外簡報。

## 拍攝自己的場景（capture → rebuild）

1. 手機**橫式 4K**、**邊走邊拍**（要位移產生視差，原地環拍會重建失敗）、
   慢速移動、繞目標 2~3 圈不同高度、光線均勻、1~3 分鐘
2. 影片丟 Luma AI / Polycam / Scaniverse（雲端/手機重建），
   或桌機（RTX）跑 Postshot；需要抽畫格時用 `python tools/extract_frames.py 影片.mp4`
3. 匯出 `.glb`（mesh）或 `.ply`（3DGS）→ 依上節設定載入

## Roadmap

- M3：OPC UA / Modbus 真實數據源介接
- M4：WebXR 進 Quest 3、3DGS 效能優化（.ksplat 轉檔、LOD）
- M5：USD 雙向同步（Omniverse Nucleus / 直接給 Isaac Sim 做工安影像訓練資料）
