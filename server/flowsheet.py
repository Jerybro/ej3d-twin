"""Flowsheet 求解器（sequential modular）＋ 定義域守門員（L2.5，對標製程模擬器的逐塊求解）。

把已發布的 L2 模型（`registry.py`）依宣告式 flowsheet 規格（`data/flowsheets/*.json`）
串成一條「上游 block 輸出 → 下游 block 輸入」的管線，依拓撲序逐塊呼叫 `registry.predict()`：

  1. **求解**：sequential modular——不是聯立解方程組，而是依拓撲序逐塊算，
     上游算完的輸出直接餵給下游當輸入（規格 §connections 宣告的那幾條，僅此而已，
     不自動推論隱含依賴）。單一 block 失敗只讓依賴它的下游 skip，其餘 block 照跑。
  2. **守門員**：對每個 feature 用該模型發布時快照的 `feature_stats`（registry.py 新增）
     做定義域檢查——落在 [p1, p99] 內＝ok；落在 [min, max] 但超出 [p1, p99]＝warn；
     超出 [min, max]＝out（外插，預測不可信）；無統計快照＝unknown（無法判斷）。

本檔為「薄封裝層＋圖演算法」：一律轉呼叫 `registry.predict()`（直接函式呼叫，不繞 HTTP），
**不改** registry.py 既有函式簽章、**不動** `/agatha/model/*` 既有端點。usage 記帳沿用
model_api.py 的 `_record` 寫法（try/except 包住，缺 usage module 不 crash）。

Router 變數名：``router``（供 main.py ``from .flowsheet import router as flowsheet_router`` 掛載；
本檔依鐵律不自行掛載，掛載動作留給呼叫端）。
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from . import registry
from .dataprep import BASE_DIR  # 專案根推導方式與 registry.DATA_DIR 同源（BASE_DIR/uploads/data）

router = APIRouter(prefix="/agatha/flowsheet", tags=["agatha-flowsheet"])

# flowsheet 規格檔目錄：專案根 data/flowsheets/（與 registry.DATA_DIR=uploads/data 不同樹，
# 是「宣告式規格」而非「使用者資料」，故不落在 uploads/ 下；推導方式同樣以 BASE_DIR 為錨點）。
FLOWSHEETS_DIR = BASE_DIR / "data" / "flowsheets"
FLOWSHEETS_DIR.mkdir(parents=True, exist_ok=True)


# ══════════════════════════════════════════════════════ 共用 helper

def _usage_record(model_key: str, endpoint: str, *, source: str, n_inputs: int,
                   ok: bool, ms: int, http: int, err: str | None) -> None:
    """委由 usage.py 記帳（缺 module / 記帳失敗皆吞掉，不影響主流程）。
    caller 固定 None——flowsheet run 是伺服端內部逐塊呼叫，非使用者直接打 model API。
    """
    try:
        from . import usage
        usage.record(model_key, endpoint, caller=None, source=source,
                     n_inputs=n_inputs, ok=ok, ms=ms, http=http, err=err)
    except Exception:  # noqa: BLE001  稽核失敗（含缺 module）不得影響主流程
        pass


def _spec_path(fid: str) -> Path:
    return FLOWSHEETS_DIR / f"{fid}.json"


def _load_spec(fid: str) -> dict:
    """讀規格檔（找不到 → 404；JSON 壞掉 → 422）。"""
    p = _spec_path(fid)
    if not p.exists():
        raise HTTPException(404, f"flowsheet 不存在：{fid}")
    try:
        spec = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        raise HTTPException(422, f"flowsheet 規格檔損毀：{e}") from None
    if not isinstance(spec, dict) or not isinstance(spec.get("blocks"), list):
        raise HTTPException(422, "flowsheet 規格檔格式錯誤（缺 blocks）")
    return spec


def _topo_order(blocks: list, connections: list) -> list:
    """Kahn 演算法拓撲排序，只依 connections 建邊（隱含依賴不推論）。

    - 無任何依賴的 block 之間，保留 blocks[] 原宣告順序（穩定排序：每輪掃描
      候選集時依 blocks[] 原序取用，而非依 dict/set 迭代順序，確保結果可重現）。
    - connections 成環 → HTTPException(422)，detail 指出環上的 block id 清單。
    """
    ids = [b["id"] for b in blocks]
    id_set = set(ids)
    indeg = {i: 0 for i in ids}
    adj: dict[str, list] = {i: [] for i in ids}
    for c in connections:
        u, v = c.get("from"), c.get("to")
        if u not in id_set or v not in id_set:
            continue  # 規格檔本身若引用不存在的 block，交給 run() 執行期再報，這裡先寬容跳過
        adj[u].append(v)
        indeg[v] += 1

    # 以「原順序索引」當穩定排序鍵，逐輪從入度 0 集合裡照 blocks[] 原序挑
    order_index = {i: k for k, i in enumerate(ids)}
    ready = sorted([i for i in ids if indeg[i] == 0], key=lambda i: order_index[i])
    out: list[str] = []
    indeg_work = dict(indeg)
    while ready:
        ready.sort(key=lambda i: order_index[i])
        u = ready.pop(0)
        out.append(u)
        for v in adj[u]:
            indeg_work[v] -= 1
            if indeg_work[v] == 0:
                ready.append(v)

    if len(out) != len(ids):
        cyclic = [i for i in ids if i not in out]
        raise HTTPException(422, f"flowsheet connections 成環，涉及 block：{cyclic}")
    return out


# ══════════════════════════════════════════════════════ 1. flowsheet 清單

@router.get("/")
def list_flowsheets() -> list:
    """掃 data/flowsheets/*.json，回精簡清單 [{flowsheet_id, name, n_blocks}]。

    單一規格檔壞掉不擋住其他檔案的列出（靜默跳過壞檔）。
    """
    out = []
    for p in sorted(FLOWSHEETS_DIR.glob("*.json")):
        try:
            spec = json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if not isinstance(spec, dict):
            continue
        out.append({
            "flowsheet_id": spec.get("flowsheet_id") or p.stem,
            "name": spec.get("name") or p.stem,
            "n_blocks": len(spec.get("blocks") or []),
        })
    return out


# ══════════════════════════════════════════════════════ 2. 規格＋拓撲序

@router.get("/{fid}/spec/")
def get_flowsheet_spec(fid: str) -> dict:
    """規格檔全文，外加 order（拓撲排序）與 n_connections。

    找不到 → 404；connections 成環 → 422（detail 指出環上的 block）。
    """
    spec = _load_spec(fid)
    connections = spec.get("connections") or []
    order = _topo_order(spec["blocks"], connections)
    out = dict(spec)
    out["order"] = order
    out["n_connections"] = len(connections)
    # 每個 block 附特徵訓練域 [p1, p99]（來自發布時的 feature_stats 快照）——
    # 前端「最佳化工作台」的拉軸範圍即守門域，與 automl.optimize 的搜尋邊界一致。
    blocks = []
    for b in out.get("blocks") or []:
        nb = dict(b)
        try:
            stats = registry.feature_stats(b.get("model_key")) or {}
            nb["feature_ranges"] = {
                f: [s.get("p1"), s.get("p99")]
                for f, s in stats.items()
                if s.get("p1") is not None and s.get("p99") is not None
            }
        except Exception:  # noqa: BLE001  無快照不擋 spec
            nb["feature_ranges"] = {}
        blocks.append(nb)
    out["blocks"] = blocks
    return out


# ══════════════════════════════════════════════════════ 2'. 儲存 / 刪除（設計器）

_FID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,39}$")


@router.post("/")
def save_flowsheet(body: dict = Body(...)) -> dict:
    """新增／覆存 flowsheet 規格（設計器用）——客戶自組流程的落盤點。

    以註冊表為真相來源逐項驗證與正規化：
      - blocks[].model_key 必須是已發布模型；kind 由模型 task 推導（不信任前端傳值）。
      - connection 的 source_output＝上游模型 target（後端覆寫）；target_input 必須是
        下游模型 features 之一；上游必須是迴歸模型（anomaly 無數值輸出可傳）。
      - defaults 只保留合法特徵；缺的自動以該模型訓練中位數 p50 補齊（客戶不必手填）；
        被 connection 餵的特徵自 defaults 移除（執行期由上游覆蓋）。
      - trains 過濾不存在的 id；全空 → 單一主線＝blocks 宣告順序。
      - connections 拓撲驗環（成環 → 422）。
    """
    spec = body.get("spec") if isinstance(body.get("spec"), dict) else body
    fid = str(spec.get("flowsheet_id") or "").strip().lower()
    if not _FID_RE.match(fid):
        raise HTTPException(422, "flowsheet_id 格式：小寫英數/連字號/底線，3~40 字，英數開頭")
    blocks_in = spec.get("blocks") or []
    if not blocks_in:
        raise HTTPException(422, "至少需要一個 block")

    # --- blocks：驗 model_key、以模型 task 正規化 kind，蒐集 features/target ---
    seen_ids: set = set()
    blocks: list = []
    feats_of: dict = {}
    target_of: dict = {}
    kind_of: dict = {}
    for b in blocks_in:
        bid = str(b.get("id") or "").strip()
        if not bid:
            raise HTTPException(422, "每個 block 都需要 id")
        if bid in seen_ids:
            raise HTTPException(422, f"block id 重複：{bid}")
        seen_ids.add(bid)
        mk = str(b.get("model_key") or "").strip()
        if not mk:
            raise HTTPException(422, f"block {bid} 缺 model_key")
        try:
            rec = registry.get(mk)
        except HTTPException:
            raise HTTPException(422, f"block {bid} 的模型不存在或未發布：{mk}") from None
        task = rec.get("task")
        kind = "anomaly" if task == "anomaly" else "regression"
        feats_of[bid] = list(rec.get("features") or [])
        target_of[bid] = rec.get("target")
        kind_of[bid] = kind
        blocks.append({
            "id": bid,
            "name": str(b.get("name") or rec.get("display_name") or bid),
            "model_key": mk,
            "kind": kind,
            "output_label": str(b.get("output_label") or ("健康分數" if kind == "anomaly" else (rec.get("target") or ""))),
            "unit": str(b.get("unit") or ("/100" if kind == "anomaly" else "")),
            "better": b.get("better") if b.get("better") in ("low", "high") else ("high" if kind == "anomaly" else "low"),
            "warn": b.get("warn"),
            "crit": b.get("crit"),
            "ico": str(b.get("ico") or ""),
            "defaults": {},
        })

    # --- connections：端點/特徵合法性 + source_output 以上游 target 為準 ---
    conns: list = []
    fed: dict = {}
    seen_conn: set = set()
    for c in spec.get("connections") or []:
        u, v = str(c.get("from") or "").strip(), str(c.get("to") or "").strip()
        ti = str(c.get("target_input") or "").strip()
        if u not in seen_ids or v not in seen_ids:
            raise HTTPException(422, f"connection 引用不存在的 block：{u} → {v}")
        if u == v:
            raise HTTPException(422, f"connection 不可自迴接：{u}")
        if kind_of[u] != "regression":
            raise HTTPException(422, f"connection 上游 {u} 是異常偵測模型，無數值輸出可傳遞")
        if ti not in feats_of[v]:
            raise HTTPException(422, f"connection {u}→{v}：{ti} 不是 {v} 模型的輸入特徵")
        key = (u, v, ti)
        if key in seen_conn:
            continue
        seen_conn.add(key)
        conns.append({
            "from": u, "source_output": target_of[u],
            "to": v, "target_input": ti,
            "unit": str(c.get("unit") or ""),
        })
        fed.setdefault(v, set()).add(ti)

    # --- defaults：合法鍵過濾 → conn-fed 移除 → 缺值以訓練 p50 補 ---
    filled: dict = {}
    for b, src in zip(blocks, blocks_in):
        bid = b["id"]
        stats = {}
        try:
            stats = registry.feature_stats(b["model_key"]) or {}
        except Exception:  # noqa: BLE001
            pass
        given = src.get("defaults") or {}
        for f in feats_of[bid]:
            if f in fed.get(bid, set()):
                continue
            if f in given and given[f] is not None and given[f] != "":
                b["defaults"][f] = float(given[f])
            elif stats.get(f, {}).get("p50") is not None:
                b["defaults"][f] = float(stats[f]["p50"])
                filled.setdefault(bid, []).append(f)
            # 沒統計又沒給 → 留空；執行期缺輸入會逐塊回報，不在儲存時擋

    # --- trains：過濾不存在的 id；全空 → 主線＝宣告順序 ---
    trains = []
    for t in spec.get("trains") or []:
        row = [i for i in (t or []) if i in seen_ids]
        if row:
            trains.append(row)
    if not trains:
        trains = [[b["id"] for b in blocks]]

    _topo_order(blocks, conns)  # 成環 → 422

    out = {
        "flowsheet_id": fid,
        "name": str(spec.get("name") or fid),
        "desc": str(spec.get("desc") or ""),
        "trains": trains,
        "blocks": blocks,
        "connections": conns,
    }
    _spec_path(fid).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return {"ok": True, "flowsheet_id": fid, "n_blocks": len(blocks),
            "n_connections": len(conns), "auto_filled_defaults": filled}


@router.delete("/{fid}/")
def delete_flowsheet(fid: str) -> dict:
    """刪除 flowsheet 規格檔（不動模型與資料）。"""
    p = _spec_path(fid)
    if not p.exists():
        raise HTTPException(404, f"flowsheet 不存在：{fid}")
    p.unlink()
    return {"ok": True, "flowsheet_id": fid}


# ══════════════════════════════════════════════════════ 3. 求解（sequential modular）

_LEVEL_RANK = {"ok": 0, "unknown": 1, "warn": 2, "out": 3}  # guard 級別排序（取最差）


def _guard_feature(value: float, stats: dict | None) -> tuple:
    """單一 feature 的守門員判定。回 (level, detail|None)。

    - 無 stats（該模型發布時快照失敗，或此 feature 不在快照裡）→ "unknown"。
    - value 無法轉成數值（型別怪異）→ "unknown"（不當例外炸掉整個 run）。
    - p1 ≤ v ≤ p99 → "ok"（不進 checks 明細，只列非 ok 者）。
    - min ≤ v ≤ max 但超出 [p1, p99] → "warn"。
    - v < min 或 v > max → "out"（外插，預測不可信）。
    """
    try:
        v = float(value)
    except (TypeError, ValueError):
        return "unknown", None
    if not stats:
        return "unknown", None
    lo, hi = stats.get("p1"), stats.get("p99")
    mn, mx = stats.get("min"), stats.get("max")
    if lo is None or hi is None or mn is None or mx is None:
        return "unknown", None
    if lo <= v <= hi:
        return "ok", None
    if mn <= v <= mx:
        return "warn", {"lo": lo, "hi": hi, "band": "p1_p99"}
    return "out", {"lo": mn, "hi": mx, "band": "min_max"}


def _guard_block(inputs: dict, required: list, feature_stats: dict | None) -> dict:
    """block 級守門員：對「模型實際會吃的」required features 逐一判定
    （不理會 inputs 裡多餘的 key，避免使用者塞了不相關欄位污染 checks）。

    回 {status, checks:[{feature,value,lo,hi,band}]}（契約欄名為 status，前端依此渲染）；
    block status = 各 feature 級別中最差者（out > warn > unknown > ok）；
    checks 只列非 ok 的 feature（ok 太多筆、不值得列）。
    """
    level = "ok"
    checks = []
    for feat in required:
        val = inputs.get(feat)
        stats = (feature_stats or {}).get(feat)
        lv, detail = _guard_feature(val, stats)
        if _LEVEL_RANK[lv] > _LEVEL_RANK[level]:
            level = lv
        if lv != "ok":
            row = {"feature": feat, "value": val}
            if detail:
                row.update(detail)
            checks.append(row)
    return {"status": level, "checks": checks}


@router.post("/{fid}/run/")
def run_flowsheet(fid: str, body: dict = Body(...)) -> dict:
    """依拓撲序逐 block 求解：spec defaults ← body inputs 覆蓋 ← 上游 connection 值覆蓋。

    body: {inputs: {block_id: {feature: value, ...}, ...}, source?}

    - 缺任一 required feature → 該 block 標 error，依賴它的下游標 skipped，其餘 block 照跑。
    - 上游若是 anomaly（沒有 regression 意義下的「值」可傳）→ 422（規格設計錯誤，非執行期
      資料問題，故不比照「該 block error、下游 skip」處理，而是直接擋——這代表 connections
      宣告本身有誤，值得讓呼叫端立即知道並修正規格檔，而非讓求解靜默跑歪）。
    - 全部 block 都 error 仍回 200（前端逐塊顯示錯誤）；只有 fid 不存在（404）、
      規格成環（422）、body 非法（422）才丟 HTTP 錯。
    """
    t0 = time.perf_counter()
    spec = _load_spec(fid)
    blocks = spec["blocks"]
    connections = spec.get("connections") or []
    order = _topo_order(blocks, connections)
    block_by_id = {b["id"]: b for b in blocks}

    if not isinstance(body, dict):
        raise HTTPException(422, "body 需為 JSON 物件")
    body_inputs = body.get("inputs") or {}
    if not isinstance(body_inputs, dict):
        raise HTTPException(422, "inputs 需為 {block_id: {feature: value}} 物件")
    # body.source 僅供前端標示呼叫來源，usage 記帳固定用 f"flowsheet:{fid}"（規格 §任務2），
    # 不透傳 body.source，故此處不取用（避免留一個沒被讀取的區域變數）。

    # 上游 connection 值覆蓋表：target block → {target_input: value}（求解過程中逐步填入）
    incoming: dict[str, dict] = {b["id"]: {} for b in blocks}
    # connections 一律先靜態驗規格本身是否合法（成環已在 _topo_order 擋過），跑任何 block
    # 之前就快速失敗，不浪費一次模型呼叫：
    #   - from/to 引用不存在的 block → 規格檔手誤，422。
    #   - from 是 anomaly block → anomaly 沒有 regression 意義下的「值」可傳給下游，
    #     這是 connections 宣告本身有誤（非執行期資料問題），422 讓呼叫端修正規格檔，
    #     不比照「該 block error、下游 skip」處理（那是資料層級的失敗，這是規格層級的）。
    for c in connections:
        u, v = c.get("from"), c.get("to")
        if u not in block_by_id or v not in block_by_id:
            raise HTTPException(422, f"connections 引用不存在的 block：{c}")
        if block_by_id[u].get("kind") == "anomaly":
            raise HTTPException(
                422,
                f"connections 規格錯誤：{u} 是 anomaly block，anomaly 不可作為資料來源"
                f"（connection {u}→{v} 無法取得 regression 值）",
            )

    results: dict[str, dict] = {}
    conn_out: list[dict] = []  # 回應用：實際跑出的 connection 值（含 value/unit）

    for bid in order:
        b = block_by_id[bid]
        model_key = b["model_key"]
        kind = b.get("kind", "regression")

        # --- 檢查上游是否有 error/skipped（有則本 block 直接 skip，不呼叫模型） ---
        upstream_ids = [c["from"] for c in connections if c["to"] == bid]
        failed_upstream = [u for u in upstream_ids
                           if results.get(u, {}).get("error") or results.get(u, {}).get("skipped")]
        if failed_upstream:
            results[bid] = {
                "model_key": model_key,
                "kind": kind,
                "skipped": f"上游 {failed_upstream[0]} 失敗",
            }
            continue

        # --- 組 inputs：spec defaults ← body inputs 覆蓋 ← 上游 connection 值覆蓋 ---
        inputs = dict(b.get("defaults") or {})
        inputs.update(body_inputs.get(bid) or {})
        inputs.update(incoming.get(bid) or {})

        # --- 缺 feature 檢查（用 registry.capability 宣告的 required features） ---
        try:
            cap = registry.capability(model_key)
        except HTTPException as e:
            results[bid] = {"model_key": model_key, "kind": kind, "error": f"model_key 無法解析：{e.detail}"}
            continue
        required = cap.get("input_schema", {}).get("required", [])
        missing = [f for f in required if f not in inputs or inputs[f] is None or inputs[f] == ""]
        if missing:
            results[bid] = {
                "model_key": model_key,
                "kind": kind,
                "inputs": inputs,
                "error": f"缺少輸入: {', '.join(missing)}",
            }
            continue

        # --- 呼叫 registry.predict（直接函式呼叫，不繞 HTTP）＋ usage 記帳 ---
        rt0 = time.perf_counter()
        try:
            pred_resp = registry.predict(model_key, inputs, check_enabled=True)
            ms = int((time.perf_counter() - rt0) * 1000)
            _usage_record(model_key, "predict", source=f"flowsheet:{fid}", n_inputs=1,
                          ok=True, ms=ms, http=200, err=None)
        except HTTPException as e:
            ms = int((time.perf_counter() - rt0) * 1000)
            _usage_record(model_key, "predict", source=f"flowsheet:{fid}", n_inputs=1,
                          ok=False, ms=ms, http=e.status_code, err=str(e.detail))
            results[bid] = {
                "model_key": model_key,
                "kind": kind,
                "inputs": inputs,
                "error": str(e.detail),
            }
            continue

        prediction = (pred_resp.get("predictions") or [{}])[0]

        # --- 守門員：用發布時快照的 feature_stats，只查該模型實際會吃的 required features ---
        fstats = registry.feature_stats(model_key)
        guard = _guard_block(inputs, required, fstats)

        results[bid] = {
            "model_key": model_key,
            "kind": kind,
            "inputs": inputs,
            "prediction": prediction,
            "guard": guard,
        }

        # --- 把本 block 輸出餵給下游（僅限 connections 宣告的那幾條；anomaly-as-source
        #     已在迴圈開始前靜態擋過，這裡不會再遇到） ---
        for c in connections:
            if c["from"] != bid:
                continue
            src_out = c.get("source_output")
            # 注意：source_output（如 "raw_NOx_mg_Nm3"）只是規格檔裡「這條 connection 代表
            # 哪個物理量」的文件性標籤，不是 predictions[0] 字典真正的 key——regression 的
            # predictions[0] 一律只有 "value" 這個 key（見 registry._predict_tabular）。
            # 上游 connection 取值固定取 predictions[0]["value"]，source_output 僅原樣透傳
            # 到回應的 connections[] 供前端顯示用（規格 §任務2「regression 取 value」）。
            if "value" not in prediction:
                # 走到這裡代表上游 kind 不是預期的 regression（如 classification 只有
                # label/proba，没有 value）——規格檔手誤（不該把它接成資料來源），422。
                raise HTTPException(
                    422,
                    f"connections 規格錯誤：{bid} 的 predictions 無 'value' 欄可取"
                    f"（僅 regression/hybrid 可作為 connections 資料來源）",
                )
            val = prediction["value"]
            incoming.setdefault(c["to"], {})[c["target_input"]] = val
            conn_out.append({
                "from": bid, "to": c["to"],
                "source_output": src_out, "target_input": c["target_input"],
                "value": val, "unit": c.get("unit"),
            })

    ms_total = int((time.perf_counter() - t0) * 1000)
    return {
        "flowsheet_id": fid,
        "order": order,
        "blocks": results,
        "connections": conn_out,
        "ms": ms_total,
    }
