# 用 Tailscale Funnel 把 J.S_3D Studio 對公網開放（自架 server）

把 `ej3d-twin`（FastAPI，本機 `127.0.0.1:8600`）透過 **Tailscale Funnel** 公開到
`https://<host>.<tailnet>.ts.net`——自動 TLS、免開防火牆埠、免公網 IP。

```
公網瀏覽器 ──https(443)──▶ <host>.<tailnet>.ts.net ──▶ Tailscale ──http──▶ 127.0.0.1:8600 (uvicorn)
```

> **3D 是瀏覽器端 WebGL 渲染**，server 不需要 GPU 即可對外服務；任何常開的機器都能當 host。
>
> ⚠ **公網 = 任何人都連得到。應用層登入（Google OAuth）必須開啟，切勿 `AUTH_DISABLED`。**
> 一鍵腳本會強制對齊 OAuth，並在偵測到 `AUTH_DISABLED` 時警告。

---

## 一次性前置（每台 server 做一次）

1. **裝 Tailscale 並登入**：安裝後 `tailscale up`。
2. **admin console → DNS**：開 **MagicDNS** 與 **HTTPS Certificates**（Funnel 的自動憑證靠這個）。
3. **開 Funnel 權限**：admin console → **Access Controls**，政策加 `funnel` node attribute。例：
   ```jsonc
   {
     "nodeAttrs": [
       { "target": ["autogroup:member"], "attr": ["funnel"] }
     ]
   }
   ```
   （也可把 `target` 換成特定 tag/主機，只給這台 server。）
4. **Google OAuth**：repo 根 `.env` 需有 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`。
   redirect URI 由腳本自動寫入 `.env`（`GOOGLE_REDIRECT_URI=https://<host>.<tailnet>.ts.net/login/google/callback`），
   **並要把同一串加進 [Google Cloud Console](https://console.cloud.google.com/apis/credentials) 的 Authorized redirect URIs。**
5. **裝 NSSM**（開機自啟服務用）：`choco install nssm`。
6. **裝相依套件**：`pip install -r requirements.txt`。

---

## 部署（dispatch → 桌機 pull → 執行）

桌機上，切到要對外的分支後：

```powershell
git pull
# 以「系統管理員」開 PowerShell：
powershell -ExecutionPolicy Bypass -File deploy\serve-tailscale-funnel.ps1
```

腳本會（冪等，可重複執行）：
- 用 NSSM 建立/更新 `ej3d-twin` 服務（uvicorn 綁 `127.0.0.1:8600`，開機自啟），並做本地健康檢查；
- 把 `.env` 的 `GOOGLE_REDIRECT_URI` 對齊 Tailscale 網域，若 `AUTH_DISABLED` 開著會警告；
- 執行 `tailscale funnel --bg 8600`，印出公開網址與待辦。

常用參數：`-Port`、`-RepoDir`、`-ServiceName`、`-Python`、`-SkipService`（只設 Funnel）、`-ServiceOnly`（只設服務）。

---

## 改版後重新部署

```powershell
git pull
nssm restart ej3d-twin      # 或重跑腳本（Funnel 設定會保留）
```

## 停止 / 收回公開

```powershell
tailscale funnel reset      # 取消公網公開（服務仍在本機跑）
Stop-Service ej3d-twin      # 停掉 app 服務
```

---

## 安全建議（公網務必看）

- **限制可登入者**：目前 `auth.py` 首位登入者為 admin、其餘為 user。對公網建議在 `google_callback` 加**白名單網域/信箱**（只放行 `@engjay...` 或指定 email），否則任何 Google 帳號都能註冊進站。
- **絕不 `AUTH_DISABLED=1`**：那會讓全世界免登入 + 匿名 admin 全開。
- **首頁 `/` 是公開頁**（未登入可見），其餘頁面 302 導向登入、API 回 401——確認首頁不含敏感資訊。
- Funnel 對外只允許 **443 / 8443 / 10000** 三個埠；本地目標埠（8600）不受此限。

---

## 疑難排解

| 症狀 | 可能原因 / 解法 |
|---|---|
| `tailscale funnel` 失敗 | MagicDNS/HTTPS 未開，或 ACL 未給 `funnel` 屬性（見前置 2、3） |
| 開站白頁 / 502 | app 沒起來：`Get-Service ej3d-twin`；缺套件跑 `pip install -r requirements.txt` |
| Google 登入 redirect_uri_mismatch | Google Console 的 redirect URI 沒對上 `.env` 的 `GOOGLE_REDIRECT_URI`（含大小寫/斜線） |
| 憑證錯誤 / 不是 https | admin console 未開 HTTPS Certificates；或機器名改過，重跑腳本取新網域 |
| 重開機後掉線 | 未用 NSSM（背景程序不會自啟）；`choco install nssm` 後重跑腳本 |

> 想改回「只給自己/受邀成員」的私網模式：把腳本第 4 步換成 `tailscale serve --bg --https=443 http://127.0.0.1:8600`，並 `tailscale funnel reset`。
