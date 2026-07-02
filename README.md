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

## 之後接真場景（掃描流程）

1. 手機繞拍室內場景（4K、慢速、多角度、光線均勻）
2. 用 Luma AI / Polycam / Postshot 重建 → 匯出 `.glb`（mesh）或 `.ply`（3DGS）
3. `.glb` 放進 `scans/`，`data/plant.json` 加 `"scan_model": "xxx.glb"`
4. 設備熱點座標依掃描場景微調 `pos`

## Roadmap

- M3：OPC UA / Modbus 真實數據源介接
- M4：3DGS（Gaussian Splatting）原生載入、WebXR 進 Quest 3
- M5：USD 雙向同步（Omniverse Nucleus / 直接給 Isaac Sim 做工安影像訓練資料）
