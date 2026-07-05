# EJ_3D L1+L2 後端 API 實作規格（Tukey 對標 facade + 發布制模型註冊表）

> 版本：v1（2026-07-05）｜作者：API 架構師（依 Peter 設計約束產出）
> 範圍：**本輪只做後端**——L1 資料 API facade + L2 模型 API 後端 + 發布制模型註冊表 + usage 治理。**不做前端頁**。
> 鐵律：**絕不破壞既有 `/api/automl/*` 與 `/api/data/*`**；facade 一律是新增的「薄封裝層」，底層重用既有 `automl.py` / `dataprep.py` 函式，不改既有函式簽章與路徑。

---

## 0. 設計總覽

| 對標對象（Tukey backstage） | ej3d 實作 |
|---|---|
| 後端命名空間 `/tukey/agatha/*`（Django REST 風格、query 參數、trailing slash） | 新增 facade router，前綴 **`/agatha`**，路徑 trailing slash、query 用 `product_type` / `model_type` / `dataset_id` / `model_id` |
| 模型 API 名稱 `{hash}_{model_id}`（如 `c1d9e52a_10532`）＝穩定 key | **`model_key = {hash}_{model_id}`**（`hash`=8 碼、`model_id`=遞增整數），與暫時 `sid` 脫鉤 |
| product_type 四類 occ / 品質預測 / 參數最佳化 / 時間序列 | 映射到 ej3d automl task：`anomaly` /（`regression`+`classification`）/ `optimize`（reg/hybrid）/ `timeseries` |
| API 啟用開關 / 累積使用次數 / 最後使用時間 / 所有 API 使用紀錄 | 註冊表 `enabled` 欄位 + usage 計數/時間 + JSON 稽核紀錄 |
| 模型應用帶參 URL `?modelType=&datasetID=&modelID=` 啟動 | facade query 風格對標；L3 由 3D block 用 `model_key` 直接呼叫 `predict` |

**分層**

- **L1（資料 API facade）**：把既有 `/api/data/*` 以 Tukey query 風格重新曝露；核心價值是補上底層 20 個端點缺的 `_visible()` 擁有權閘（見盤點-dataprep）。
- **L2（模型 API 後端）**：`model_key` 發布制註冊表 + 統一 `predict` 契約 + capability 宣告 + usage 治理。底層一律轉呼叫 `automl.py` 既有推論端點函式。
- **L3（前瞻，本輪不實作，但契約先定死）**：`model_key` 即 3D block 綁定呼叫 key；`POST /agatha/model/{model_key}/predict/` 契約要能被 block 直接餵 `inputs` 呼叫。

---

## 1. 新增檔案清單與職責

所有新增檔案放在 `server/`，**不動任何既有檔案的既有內容**；只在 `main.py` 末端多掛兩個 router（見 §7 非破壞性檢查清單第 1 條）。

| 檔案 | 職責 | 依賴既有 |
|---|---|---|
| `server/registry.py` | **發布制模型註冊表核心**。`model_key ↔ (sid,mid)` 解析、發布/停用/啟用、capability 推導、joblib 路徑指向、product_type↔task 映射。純資料層 + 薄推論封裝，無 FastAPI 路由。 | `automl._load` / `_load_pipe` / `_pipe_path` / `_mdir`；`dataprep._load_meta` |
| `server/usage.py` | **usage 治理核心**。累積使用次數、最後使用時間、稽核紀錄（append-only JSON）。提供 `record(model_key, endpoint, request_meta, ok, ...)` 與查詢函式。 | 無（純 JSON I/O + 檔案鎖） |
| `server/facade_data.py` | **L1 資料 API facade router**（前綴 `/agatha`，資料相關）。Tukey query 風格轉呼叫既有 `/api/data/*` 對應函式，並補 `_visible()` 擁有權閘。 | `dataprep.*`（見 §4 對應表） |
| `server/facade_model.py` | **L2 模型 API facade router**（前綴 `/agatha`，模型相關）。發布/清單/capability/**統一 predict**/停用啟用/usage 查詢。轉呼叫 `registry.py` + `automl.py` 推論端點函式，並經 `usage.py` 記錄每次呼叫。 | `registry.*`、`usage.*`、`automl.*` 推論函式 |

> **為何拆兩個 router 檔**：L1 只封裝 `dataprep`，L2 只封裝 `registry`+`automl`；拆開後任一層改動不牽動另一層，且各自可獨立 `include_router`。兩者共用同一前綴 `/agatha`，路徑不重疊。

---

## 2. 儲存 schema 與檔案位置

### 2.1 註冊表（發布制模型清單）

- **檔案**：`uploads/registry/models.json`（單一 JSON；`registry.py` 內 `REGISTRY_DIR = BASE_DIR/"uploads"/"registry"`，開機 `mkdir`）
- **並發**：以 `threading.Lock` 保護讀改寫（對標 automl 已用 `threading`）；寫入採「temp 檔 + `os.replace` 原子換檔」。
- **model_id 序號**：檔案頂層 `next_model_id`（起始 10001，遞增），對標 Tukey 的整數 model_id。
- **hash**：發布當下對 `(sid, mid, created)` 做 `sha1` 取前 8 碼（穩定、與內容綁定）。

```jsonc
// uploads/registry/models.json
{
  "next_model_id": 10003,
  "models": {
    "c1d9e52a_10001": {                 // ← model_key（穩定，對外唯一）
      "model_key":    "c1d9e52a_10001",
      "hash":         "c1d9e52a",
      "model_id":     10001,
      "display_name": "R-101 溫度異常偵測",   // 發布時可命名，預設取 rec.name
      "product_type": "occ",             // occ / quality / optimize / timeseries
      "task":         "anomaly",         // ej3d automl task（見 §3 對應）

      // ── 與暫時 sid 脫鉤所需的「內容指紋」——重訓/清資料集也不失聯 ──
      "origin": {
        "sid": "a1b2c3d4",              // 發布當下的 data session（可失效）
        "mid": "9f8e7d6c",              // automl 模型 record id（8 碼）
        "joblib_path": "uploads/data/automl/a1b2c3d4/9f8e7d6c.joblib", // 快取指向；resolve 時以此為主、sid/mid 為輔
        "record_path": "uploads/data/automl/a1b2c3d4/9f8e7d6c.json"
      },
      "features":     ["TI101", "PI101", "FI101"],  // 發布當下快照（脫鉤後仍可宣告契約）
      "target":       "（無監督）",
      "algo":         "iforest",
      "capabilities": ["predict", "evaluate", "threshold"],  // §3 task→操作矩陣推導

      "enabled":      true,              // 啟用/停用開關（治理）
      "published_at": "2026-07-05 14:20:31",
      "published_by": "ezmn990329@gmail.com",  // current_user().email，可為 null
      "updated_at":   "2026-07-05 14:20:31",
      "note":         ""
    }
  }
}
```

**脫鉤/失聯策略（Peter 約束 1）**：`resolve(model_key)` 先試 `origin.joblib_path` 是否存在；存在即用（即使原 `sid` 的 data session 已刪、資料集已清）。若不存在，回 `409 model artifact missing`（不 crash、不亂猜），並在 usage 稽核記一筆 `resolve_fail`。**發布快照的 `features/target/task/product_type/algo` 常駐於註冊表本身**，因此即使 `record.json` 也被清掉，contract 宣告（§5 GET capability）仍可回傳，只有實際 `predict` 會因缺 joblib 而 409。

### 2.2 usage 治理

- **計數/時間（每 model_key 一筆彙總）**：`uploads/registry/usage_counters.json`

```jsonc
{
  "c1d9e52a_10001": {
    "total_calls":   142,               // 累積使用次數
    "last_used_at":  "2026-07-05 16:03:09",  // 最後使用時間
    "by_endpoint":   { "predict": 130, "evaluate": 12 },
    "last_status":   "ok"
  }
}
```

- **稽核紀錄（append-only，所有 API 使用紀錄）**：`uploads/registry/audit/{YYYY-MM}.jsonl`（按月分檔，避免單檔無限膨脹；一行一筆 JSON）

```jsonc
// 每次呼叫 append 一行
{"at":"2026-07-05 16:03:09","model_key":"c1d9e52a_10001","endpoint":"predict","product_type":"occ",
 "caller":"ezmn990329@gmail.com","source":"block:eq-R101" ,"n_inputs":1,"ok":true,"ms":41,"http":200,"err":null}
```

> `source` 用來標記呼叫來源：facade 直呼為 `"api"`，L3 由 3D block 呼叫時前端帶 `source="block:{equipment_id}"`（見 §6）。

- **`usage.py` API**
  - `record(model_key, endpoint, *, caller, source, n_inputs, ok, ms, http, err) -> None`：同時更新 counters + append audit（單一 Lock）。
  - `counters(model_key) -> dict`：回該 key 彙總。
  - `audit(model_key=None, limit=200, month=None) -> list`：查稽核（可全域、可單 key）。

---

## 3. product_type ↔ task ↔ capability 對應

Tukey 四類 product_type 對映 ej3d automl 五種 task。**注意 ej3d 的 task 比 Tukey 細（品質預測拆 regression/classification；optimize 是 reg/hybrid 的操作而非獨立訓練 task）**，故映射為「多對一 / 一對多」：

| product_type（Tukey/facade 對外） | ej3d task（底層 automl rec.task） | 中文 | 允許 capabilities（照抄盤點-automl §4 矩陣） |
|---|---|---|---|
| `occ` | `anomaly` | 設備異常偵測 | `predict`, `evaluate`, `threshold` |
| `quality` | `regression` | 品質預測（連續） | `predict`, `evaluate`, `whatif`, `batch` |
| `quality` | `classification` | 品質預測（分類） | `predict`, `evaluate`, `whatif`, `batch` |
| `quality` | `hybrid` | 品質預測（模擬+AI 混合） | `predict`, `evaluate`, `whatif`, `batch`, `optimize` |
| `optimize` | `regression` / `hybrid` | 參數最佳化 | `predict`, `evaluate`, `whatif`, `optimize`（＋多目標 `optimize2`） |
| `timeseries` | `timeseries` | 時間序列 | `predict`, `evaluate`（**無 joblib**：評估時即時 `_ts_forecast`） |

**映射規則（`registry.product_type_of(task)` 與 capability 推導）**

- 發布時由 `rec.task` 反推預設 `product_type`：`anomaly→occ`、`timeseries→timeseries`、`regression/classification→quality`。
- `hybrid` 與 `regression` 若使用者發布時指定 `product_type=optimize`，則歸 `optimize`；否則歸 `quality`。**發布 API 接受可選 `product_type` 覆寫**，但只允許與 task 相容的值（不相容回 422）。
- `capabilities` 一律由 `(task, product_type)` 查上表**推導**，不接受手填——避免發布出 automl 硬擋的組合（如對 anomaly 宣告 whatif）。這直接落實盤點-automl §5 第 5 條。

**統一 `predict` 的 task 分派（關鍵）**：盤點-automl §5 第 1 條指出唯一統一推論原語 `_predict_any(pack, X)` 只涵蓋 tabular+hybrid；anomaly/timeseries 各走各路。故 `registry.predict(model_key, inputs)` 內部**必須保留 task 分派**：

| task | predict 底層走法 |
|---|---|
| regression / classification / hybrid | `_load_pipe` → `_predict_any(pack, X)`（X 由 inputs 依 `features` 排序組 `np.ndarray[float]`） |
| anomaly | `joblib.load` pack →`_anomaly_score(pack["algo"], pack["meta"], X)` → 回 risk（＋以 rec 內門檻換算 health） |
| timeseries | 無單點 predict 語意 → predict 回 `422 timeseries 不支援單點 predict，請用 forecast/evaluate` |

---

## 4. L1 資料 API facade — 端點表（前綴 `/agatha`）

**風格**：trailing slash、query 參數。`dataset_id` 即 ej3d 的 `sid`（8-hex）。每個端點**先過 `_visible()` 閘**（盤點-dataprep 指出底層缺此閘），再轉呼叫既有 `dataprep` 函式。facade 一律 `request: Request` 以取 `current_user`。

| Method | Facade Path | Query / Body | Response | 對應既有函式（dataprep.py） |
|---|---|---|---|---|
| GET | `/agatha/data/find_dataset_list/` | `owner_only=no` | `[{dataset_id, filename, owner, uploaded_at, n_rows, n_models}]`（經 `_visible` 過濾） | `list_sessions`（`/api/data/sessions`）＋逐筆 `_visible` |
| GET | `/agatha/data/find_target_list/` | `dataset_id`（required） | `{dataset_id, columns:[{name, kind}]}` | `state`（`/api/data/{sid}/state`）取 `columns` |
| GET | `/agatha/data/dataset_state/` | `dataset_id` | 同 `/api/data/{sid}/state` | `state(sid)` |
| GET | `/agatha/data/dataset_cards/` | `dataset_id`, `target=""`, `page=1`, `per_page=9`, `bins=24` | 同 `/cards` | `cards(...)` |
| GET | `/agatha/data/dataset_rows/` | `dataset_id`, `page=1`, `per_page=15` | 同 `/rows` | `rows(...)` |
| GET | `/agatha/data/dataset_series/` | `dataset_id`, `cols`(CSV,required), `max_points=5000` | 同 `/series` | `series(...)` |
| GET | `/agatha/data/dataset_hist/` | `dataset_id`, `col`(required), `bins=30` | 同 `/hist` | `hist(...)` |
| GET | `/agatha/data/dataset_corr/` | `dataset_id`, `cols=""`, `method=pearson` | 同 `/corr` | `corr(...)` |
| GET | `/agatha/data/dataset_health/` | `dataset_id` | 同 `/health` | `health(...)` |
| GET | `/agatha/data/dataset_export/` | `dataset_id`, `raw=no` | CSV `PlainTextResponse` | `export(...)`（`raw` 由 `no/yes`→bool） |

**擁有權閘實作（facade 共用 helper，放 `facade_data.py`）**

```python
def _guard(sid: str, request) -> dict:
    from .auth import current_user
    from .dataprep import _load_meta, _visible
    meta = _load_meta(sid)            # 不存在 → 404
    if not meta:
        raise HTTPException(404, "dataset 不存在")
    u = current_user(request)
    if not _visible(meta, u):         # 補上底層 20 個端點缺的閘
        raise HTTPException(403, "無權存取此 dataset")
    return meta
```

> **非破壞**：facade 只「新增」`_visible` 檢查，不改 `dataprep` 內既有端點的無閘行為（既有前端仍照舊工作）。`yes/no` ↔ `bool` 轉換一律在 facade 層做，對標 Tukey 的 `only_success=yes` 字串風格。

---

## 5. L2 模型 API facade — 端點表（前綴 `/agatha`）

**風格**：Tukey query（`product_type` / `model_type` / `dataset_id` / `model_id`）、trailing slash。`model_type` 對外＝product_type 的別名相容欄（Tukey `model_type=OCC`），facade 大小寫不敏感、與 `product_type` 二選一即可。**每個模型端點呼叫後經 `usage.record` 記帳**。

| # | Method | Facade Path | Query / Body | Response | 對應（registry/automl） |
|---|---|---|---|---|---|
| 1 | POST | `/agatha/model/publish/` | body `{dataset_id, model_id(=automl mid), product_type?(覆寫), display_name?, note?}` | `{model_key, model_id, hash, product_type, task, capabilities[], enabled, features[]}` | `automl._load(sid,mid)` 讀 rec →`registry.publish(...)`；分配 `model_id`+`hash` |
| 2 | GET | `/agatha/agatha/find_model_list/` | `product_type?`, `model_type?`, `dataset_id?`, `only_enabled=yes`, `include_usage=no` | `[{model_key, display_name, product_type, task, enabled, capabilities[], features[], target, total_calls?, last_used_at?}]` | `registry.list_models(filters)`（＋`usage.counters` if `include_usage`） |
| 3 | GET | `/agatha/model/{model_key}/info/` | — | 單筆註冊表 record（含 capabilities、features、target、origin 摘要、enabled） | `registry.get(model_key)` |
| 4 | GET | `/agatha/model/{model_key}/capability/` | — | `{model_key, product_type, task, capabilities[], input_schema:{features:[{name}], required:[...]}, output_schema}` | `registry.capability(model_key)`（**L3 block 綁定前查契約用**） |
| 5 | **POST** | `/agatha/model/{model_key}/predict/` | body `{inputs: {feat:val,...} \| [{...},...], source?}` | 見 §6 predict 契約 | `registry.resolve`→ task 分派（§3）：`_predict_any` / `_anomaly_score` |
| 6 | POST | `/agatha/model/{model_key}/evaluate/` | body `{}` | 依 task 四形狀（照抄盤點-automl `/evaluate`） | 轉呼 `automl.evaluate(sid,mid)` via resolve |
| 7 | POST | `/agatha/model/{model_key}/whatif/` | body `{values:{feat:val}}` | 照抄 `/whatif`（reg/cls/hybrid） | `automl.whatif(sid,mid,body)`；task 不符→422 |
| 8 | POST | `/agatha/model/{model_key}/batch/` | multipart `file` | 照抄 `/batch` | `automl.batch(sid,mid,file)` |
| 9 | POST | `/agatha/model/{model_key}/threshold/` | body `{method, apply?}` | 照抄 `/threshold`（僅 anomaly） | `automl.threshold(sid,mid,body)` |
| 10 | POST | `/agatha/model/{model_key}/optimize/` | body `{mode, value?, knobs?}` | 照抄 `/optimize`（reg/hybrid） | `automl.optimize(sid,mid,body)` |
| 11 | POST | `/agatha/optimize2/` | body `{objectives:[{model_key,...}], knobs, ...}` | 照抄 `/optimize2`（多模型多目標） | `registry.resolve` 逐 `model_key`→(sid,mid) 後轉 `automl.optimize2`（見下註） |
| 12 | PATCH | `/agatha/model/{model_key}/enabled/` | body `{enabled: bool}` | `{model_key, enabled}` | `registry.set_enabled(...)` |
| 13 | DELETE | `/agatha/model/{model_key}/` | — | `{ok:true}`（僅移出註冊表，不刪 automl 底層 joblib） | `registry.unregister(...)` |
| 14 | GET | `/agatha/model/{model_key}/usage/` | `limit=200` | `{counters:{total_calls,last_used_at,by_endpoint}, audit:[...]}` | `usage.counters` + `usage.audit(model_key)` |
| 15 | GET | `/agatha/usage/audit_log/` | `limit=200`, `month?`, `model_key?` | 「所有 API 使用紀錄」稽核頁資料 | `usage.audit(...)`（全域） |

**端點 6–11 的非侵入轉呼叫作法**：既有 `automl` 端點函式簽章為 `(sid, mid, body/file)`。facade 先 `sid, mid, rec = registry.resolve(model_key)`，再**直接 import 呼叫該既有 async/sync 函式**（它們本就是普通函式，非只能經 HTTP）。若某函式強依賴 `Request`（automl 推論端點皆不依賴），才改走內部 helper。**capability 前置檢查**：呼叫前先 `assert endpoint in rec.capabilities`，否則回 `409 此模型（{product_type}）不支援 {endpoint}`，避免打到 automl 才被硬擋。

**optimize2 的 model_key 泛化**（對標盤點-automl §5 第 4 條）：`/optimize2` 底層要求所有目標同 `sid`。facade 版允許 `objectives[].model_key` 跨發布模型；resolve 後**若解析出的 (sid) 不一致**，回 `422 optimize2 目前僅支援同資料集發布的模型`（本輪限制，先不做跨 sid 特徵對齊；留 L3+ 擴充）。同 sid 時把各 `model_key→mid` 還原後原封轉呼 `automl.optimize2`。

---

## 6. predict 統一契約（L3 3D block 綁定的核心，端點 #5）

**這是 Peter 約束 5：`model_key` 就是 3D block 綁定呼叫 key，block 直接餵 `inputs` 呼叫。**

**Request**
```jsonc
POST /agatha/model/{model_key}/predict/
{
  "inputs": {"TI101": 210.5, "PI101": 3.2, "FI101": 88.0},  // 單筆：feat→val（缺的 feat→422）
  // 或 batch：  "inputs": [{...}, {...}]
  "source": "block:eq-R101"   // 選填；未給預設 "api"。用於 usage 稽核來源標記
}
```

**Response（依 task，統一外殼 + task-specific payload）**
```jsonc
{
  "model_key": "c1d9e52a_10001",
  "product_type": "occ",
  "task": "anomaly",
  "n": 1,
  "predictions": [ ... ],   // 見下
  "used_features": ["TI101","PI101","FI101"]
}
```

| task | `predictions[i]` 形狀 | 底層 |
|---|---|---|
| regression | `{"value": 12.34}` | `_predict_any(pack, X)` |
| classification | `{"label": "OK", "proba": {"OK":0.87,"NG":0.13}}`（proba 若模型支援） | `_predict_any` + `predict_proba` |
| hybrid | `{"value": 12.34}` | `_predict_any`（認 `kind=="hybrid"`） |
| anomaly | `{"risk": 0.91, "health": 8.5, "over_threshold": true}` | `_anomaly_score(algo, meta, X)` + rec 內門檻 |
| timeseries | — | 422（單點 predict 無語意；請用 `/evaluate/`） |

**契約保證（給 3D block 端）**

1. **只需 `model_key` + `inputs`**：block 不需知道 `sid/mid`；resolve 由 registry 負責（Peter 約束 5）。
2. **input_schema 可預查**：block 綁定前呼 `GET /capability/` 拿 `features` 與 `required`，即可自動生成餵值表單。
3. **inputs 對齊**：facade 依 `rec.features` 順序把 dict 組成 `np.ndarray[float]`；多給的 key 忽略、缺 required key → `422 缺少特徵：[...]`（不靜默補 0）。
4. **停用即擋**：`enabled=false` → `403 模型已停用`（block 呼叫也擋，且記 usage）。
5. **每次呼叫記帳**：無論成敗都 `usage.record(...)`（`source` 帶入稽核），落實約束 4。

---

## 7. 非破壞性檢查清單（合併前必須逐條驗）

1. **`main.py` 只新增、不修改既有行**：在檔案末端 `include_router` 區塊「之後」加：
   ```python
   from .facade_data import router as facade_data_router   # noqa: E402
   from .facade_model import router as facade_model_router # noqa: E402
   app.include_router(facade_data_router)
   app.include_router(facade_model_router)
   ```
   既有 `dataprep_router` / `automl_router` 掛載順序、前綴、行為完全不動。
2. **既有路徑零改動**：`/api/data/*`（23 端點）與 `/api/automl/*`（含 `/{sid}/models/*`、`/optimize2`）的 method/path/query/body/response 一字不改。facade 前綴 `/agatha` 與既有 `/api/*` 完全不重疊。
3. **既有函式簽章零改動**：facade 只 **import 呼叫** `dataprep` / `automl` 的既有函式，不改其參數、回傳、例外。若需新 helper，一律新增到 facade 檔，不塞進既有檔。
4. **不改既有落盤路徑**：automl 的 `_mdir/_mpath/_pipe_path`（`uploads/data/automl/{sid}/{mid}.*`）與 dataprep 的 `uploads/data/{sid}.*` 全不動。註冊表/usage 一律寫**新目錄** `uploads/registry/*`，與既有互不覆蓋。
5. **不刪既有資料**：`DELETE /agatha/model/{model_key}/` 只移出註冊表 JSON，**不刪**底層 joblib/record（automl 既有 `/{sid}/models/{mid}` DELETE 才刪實體，行為保留）。
6. **task 硬擋沿用、不繞過**：facade 不自行推論 anomaly/ts 的不支援操作；capability 檢查先擋，真要打底層也讓 automl 既有硬擋生效（不改 automl 的 task 檢查）。
7. **auth 非破壞**：L1 facade **新增** `_visible` 閘，但不改 `dataprep` 既有端點的無閘行為（`AUTH_DISABLED=1` 時 `current_user` 回 admin，facade 自然放行，與現況一致）。
8. **並發安全且隔離**：註冊表/usage 各自 `threading.Lock` + 原子換檔；不與 automl 的 `threading` 訓練鎖共用鎖物件（避免耦合）。
9. **失聯不 crash**：`resolve` 遇 joblib 遺失回 409 並記稽核，不拋未捕捉例外、不影響既有端點。
10. **`.gitignore` 檢查**：確認 `uploads/` 既有忽略規則涵蓋 `uploads/registry/`（產物不進版控），或按需新增一行。
11. **回歸測試**：合併前對既有 `/api/data/sessions`、`/api/automl/{sid}/models`、任一 `/whatif`、`/optimize2` 各打一次，回應與合併前逐欄比對一致（facade 掛載不得改變既有回應）。

---

## 8. 實作順序建議（本輪，後端 only）

1. `usage.py`（無依賴，先可單測）→ 2. `registry.py`（publish/resolve/capability/set_enabled，依 automl helper）→ 3. `facade_model.py`（predict 契約 + publish + list + usage 端點）→ 4. `facade_data.py`（L1 加 `_visible` 閘）→ 5. `main.py` 掛載兩 router → 6. 跑 §7 第 11 條回歸。前端頁（L2 管理台、L3 block 綁定 UI）**不在本輪**。
