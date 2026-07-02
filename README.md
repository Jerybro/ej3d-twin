# EJ_3D 數位孿生平台 MVP

穎杰科技「領航示範案・產品3（全廠 3D 數位孿生平台）」的 localhost Web MVP。

對應簡報需求：
- **M1** 3D 廠區場景漫遊（程式生成的特化廠示範場景，之後可換掃描實景）
- **M2** 設備熱點：點擊設備 → 資訊卡（位號、P&ID 圖面、設計資料、即時儀錶）
- **領航加值** 預設情境比對法：氣體洩漏擴散（風向）、危險區域、疏散路徑動畫、閥門誤操作起火
- **Omniverse 相容**：一鍵匯出 OpenUSD（.usda），可直接用 USD Composer / usdview 開啟

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
