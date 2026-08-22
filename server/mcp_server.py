"""MCP 端點（`/mcp`）——讓客戶把自己的 AI 接上平台。

刻意**自己實作 JSON-RPC** 而不是掛 SDK 的 ASGI app：這裡要的東西很小
（initialize / tools/list / tools/call），但認證必須走平台自己那一套金鑰＋
網域分租＋圖面白名單。自己寫 40 行，比為了配合 SDK 的授權模型再造一套簡單，
也少一層版本相依。

協定：Streamable HTTP（單一 POST 端點、JSON 回應）。
Claude Desktop／Code 只要填 URL 與 `Authorization: Bearer <金鑰>` 就能連。

地端模型多半不講 MCP，改吃 OpenAI function calling——同一份工具契約
由 `/mcp/openai-tools` 吐成它們的格式，`/mcp/call` 直接呼叫。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from . import mcp_tools

router = APIRouter(tags=["mcp"])

PROTOCOL = "2025-06-18"
SERVER_INFO = {"name": "ej3d-twin", "title": "Process Intelligence", "version": "1"}
INSTRUCTIONS = (
    "工廠製程資料平台。這裡的資料帶語意：每個點位都對到 P&ID 上的實體設備，"
    "並且是由工程師簽名確認過的——不是一堆沒頭沒尾的 tag。\n"
    "建議順序：list_drawings → get_asset_model／get_flow 看廠是怎麼接的 → "
    "list_datasets → list_points 看每一欄是什麼 → get_stats／get_series 取值。\n"
    "時序一次最多 2000 點；要大量計算請用 get_dataset_file 下載原始檔在本地做完，"
    "再用 post_result 把結果送回來（需要 write:result 權限）。"
)


def _identity(request: Request) -> tuple[str, str]:
    """(email, scope)。auth_guard 已經驗過金鑰並把 owner 放進 session。"""
    from .auth import AUTH_DISABLED, current_user, key_scope

    u = current_user(request)
    if not u:
        raise HTTPException(401, "需要金鑰：Authorization: Bearer ejt_…")
    scope = key_scope() or ("write:result" if AUTH_DISABLED else "read")
    return (u.get("email") or ""), scope


def _err(rid, code: int, msg: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}


@router.post("/mcp")
async def mcp_endpoint(request: Request):
    email, scope = _identity(request)
    try:
        msg = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse(_err(None, -32700, "JSON 解析失敗"), status_code=400)

    batch = msg if isinstance(msg, list) else [msg]
    out = []
    for m in batch:
        rid = m.get("id")
        method = m.get("method") or ""
        params = m.get("params") or {}
        try:
            if method == "initialize":
                res = {"protocolVersion": PROTOCOL,
                       "capabilities": {"tools": {"listChanged": False}},
                       "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS}
            elif method in ("notifications/initialized", "notifications/cancelled"):
                continue                     # 通知不回應
            elif method == "ping":
                res = {}
            elif method == "tools/list":
                res = {"tools": [{"name": t["name"], "description": t["description"],
                                  "inputSchema": t["schema"]}
                                 for t in mcp_tools.allowed(scope)]}
            elif method == "tools/call":
                name = params.get("name") or ""
                args = params.get("arguments") or {}
                data = mcp_tools.call(name, args, email, scope)
                import json as _j

                res = {"content": [{"type": "text",
                                    "text": _j.dumps(data, ensure_ascii=False, default=str)}],
                       "structuredContent": data if isinstance(data, dict) else {"result": data},
                       "isError": False}
            else:
                out.append(_err(rid, -32601, f"不支援的方法：{method}"))
                continue
            if rid is not None:
                out.append({"jsonrpc": "2.0", "id": rid, "result": res})
        except HTTPException as e:
            # 工具層的錯（權限不足、找不到圖面）回成 isError 內容，讓 AI 讀得懂並改正，
            # 而不是丟 JSON-RPC 錯誤讓它整個放棄
            if method == "tools/call" and rid is not None:
                out.append({"jsonrpc": "2.0", "id": rid, "result": {
                    "content": [{"type": "text", "text": f"錯誤 {e.status_code}：{e.detail}"}],
                    "isError": True}})
            elif rid is not None:
                out.append(_err(rid, -32000, str(e.detail)))
        except Exception as e:  # noqa: BLE001
            if rid is not None:
                out.append(_err(rid, -32603, f"{type(e).__name__}: {e}"))
    if not out:
        return JSONResponse(None, status_code=202)
    return JSONResponse(out if isinstance(msg, list) else out[0])


@router.get("/mcp")
def mcp_info(request: Request) -> dict:
    """給人看的：這個端點是什麼、我這把金鑰能用哪些工具、怎麼接。"""
    email, scope = _identity(request)
    base = str(request.base_url).rstrip("/")
    return {
        "server": SERVER_INFO, "protocol": PROTOCOL,
        "identity": {"email": email, "scope": scope},
        "endpoint": f"{base}/mcp",
        "auth": "Authorization: Bearer <金鑰>",
        "tools": [{"name": t["name"], "scope": t["scope"], "description": t["description"]}
                  for t in mcp_tools.allowed(scope)],
        "claude_config": {"mcpServers": {"ej3d-twin": {
            "type": "http", "url": f"{base}/mcp",
            "headers": {"Authorization": "Bearer 你的金鑰"}}}},
        "note": "地端模型不講 MCP 的話，用 GET /mcp/openai-tools 取 function schema，"
                "再 POST /mcp/call 執行。",
    }


@router.get("/mcp/openai-tools")
def openai_tools(request: Request) -> dict:
    """同一份契約的 OpenAI function calling 版本（地端模型用）。"""
    _, scope = _identity(request)
    return {"tools": mcp_tools.openai_schema(scope)}


@router.post("/mcp/call")
async def direct_call(request: Request) -> dict:
    """不走 JSON-RPC 的直呼版：{"name": ..., "arguments": {...}}。"""
    email, scope = _identity(request)
    body = await request.json()
    return {"result": mcp_tools.call(body.get("name") or "", body.get("arguments") or {},
                                     email, scope)}
