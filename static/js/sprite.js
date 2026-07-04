// AI 助手 — 右下角情境對話（本機 LLM 推論，資料不出機器）
// 孿生檢視與 E3D 工作區共用：initSprite({ page, bottom, context })
//   page    'twin' | 'e3d'（後端挑對應顧問人設）
//   bottom  距視窗底部 px（讓位給 scenario-bar / statusbar）
//   context () => object，每次請求時呼叫，回傳目前頁面情境摘要
// 開場自動分析目前頁面；使用者可在輸入框主動追問，維持多輪對話（每輪即時帶入場景 context）。
const CSS = `
#js-sprite{position:fixed;right:16px;z-index:1200;font-family:'Inter','Noto Sans TC',sans-serif}
#js-sprite .sp-fab{width:46px;height:46px;border-radius:50%;background:#fff;border:1px solid #DBDDE0;
  box-shadow:0 4px 16px rgba(6,16,39,.14);cursor:pointer;display:flex;align-items:center;justify-content:center;
  transition:box-shadow .15s,transform .15s}
#js-sprite .sp-fab:hover{box-shadow:0 6px 20px rgba(4,106,251,.22);transform:translateY(-1px)}
#js-sprite .sp-fab svg{width:22px;height:22px;stroke:#046AFB;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
#js-sprite .sp-fab .sp-dot{position:absolute;top:2px;right:2px;width:9px;height:9px;border-radius:50%;
  border:2px solid #fff;background:#9AA3AD}
#js-sprite .sp-fab .sp-dot.on{background:#16a34a}
#js-sprite .sp-panel{position:absolute;bottom:56px;right:0;width:332px;background:#fff;border:1px solid #DBDDE0;
  border-radius:10px;box-shadow:0 10px 34px rgba(6,16,39,.16);display:none;overflow:hidden}
#js-sprite.open .sp-panel{display:flex;flex-direction:column}
#js-sprite .sp-head{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#F6F7FA;border-bottom:1px solid #DBDDE0}
#js-sprite .sp-title{font-size:12.5px;font-weight:700;color:#061027;letter-spacing:.02em}
#js-sprite .sp-head button:first-of-type{margin-left:auto}
#js-sprite .sp-head button{background:none;border:none;cursor:pointer;padding:2px;display:flex;color:#5C6773}
#js-sprite .sp-head button:hover{color:#046AFB}
#js-sprite .sp-head button:disabled{color:#C2C8CF;cursor:default}
#js-sprite .sp-head svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
#js-sprite .sp-thread{display:flex;flex-direction:column;gap:8px;padding:12px;min-height:66px;max-height:320px;overflow-y:auto}
#js-sprite .sp-msg{max-width:88%;padding:7px 10px;border-radius:10px;font-size:12.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word}
#js-sprite .sp-msg.bot{align-self:flex-start;background:#F6F7FA;border:1px solid #E9EDF2;color:#061027;border-bottom-left-radius:3px}
#js-sprite .sp-msg.user{align-self:flex-end;background:#046AFB;color:#fff;border-bottom-right-radius:3px}
#js-sprite .sp-msg.err{align-self:flex-start;background:#fdeef1;border:1px solid #f6c9d4;color:#d03050}
#js-sprite .sp-input-row{display:flex;align-items:flex-end;gap:6px;padding:8px 10px;border-top:1px solid #E9EDF2}
#js-sprite .sp-input{flex:1;border:1px solid #DBDDE0;border-radius:8px;padding:6px 9px;font-family:inherit;font-size:12.5px;
  line-height:1.5;color:#061027;resize:none;outline:none;min-height:32px;max-height:84px;overflow-y:auto}
#js-sprite .sp-input:focus{border-color:#046AFB}
#js-sprite .sp-input::placeholder{color:#9AA3AD}
#js-sprite .sp-send{flex:none;width:34px;height:32px;border:none;background:#046AFB;border-radius:8px;cursor:pointer;
  display:flex;align-items:center;justify-content:center}
#js-sprite .sp-send:hover{background:#0357d6}
#js-sprite .sp-send:disabled{background:#B7BEC7;cursor:default}
#js-sprite .sp-send svg{width:16px;height:16px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
#js-sprite .sp-foot{padding:6px 12px;border-top:1px solid #E9EDF2;font-size:10px;color:#8B96A0;display:flex;justify-content:space-between}
#js-sprite .sp-pulse{display:inline-block;color:#5C6773;animation:spPulse 1.1s ease-in-out infinite}
@keyframes spPulse{0%,100%{opacity:.35}50%{opacity:1}}
`;

const IC_SPARK = '<svg viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.4"/></svg>';
const IC_REFRESH = '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/></svg>';
const IC_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const IC_SEND = '<svg viewBox="0 0 24 24"><path d="M12 20V5M6 11l6-6 6 6"/></svg>';

export function initSprite({ page = 'twin', bottom = 56, context = () => ({}) } = {}) {
  if (document.getElementById('js-sprite')) return;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'js-sprite';
  root.style.bottom = `${bottom}px`;
  root.innerHTML = `
    <div class="sp-panel">
      <div class="sp-head">
        <span class="sp-title">AI 助手</span>
        <button data-sp="refresh" title="重新分析目前頁面">${IC_REFRESH}</button>
        <button data-sp="close" title="收合">${IC_CLOSE}</button>
      </div>
      <div class="sp-thread"></div>
      <div class="sp-input-row">
        <textarea class="sp-input" rows="1" placeholder="輸入問題，Enter 送出"></textarea>
        <button class="sp-send" title="送出">${IC_SEND}</button>
      </div>
      <div class="sp-foot"><span>本機 Qwen3.6</span><span class="sp-when"></span></div>
    </div>
    <button class="sp-fab" title="AI 助手">${IC_SPARK}<span class="sp-dot"></span></button>`;
  document.body.appendChild(root);

  const thread = root.querySelector('.sp-thread');
  const input = root.querySelector('.sp-input');
  const sendBtn = root.querySelector('.sp-send');
  const refreshBtn = root.querySelector('[data-sp="refresh"]');
  const when = root.querySelector('.sp-when');
  const dot = root.querySelector('.sp-dot');
  const history = [];           // {role:'user'|'assistant', content}
  let busy = false;
  let fetchedOnce = false;

  // 引擎狀態燈（不擋 UI，失敗就灰燈）
  fetch('/api/sprite/status').then((r) => r.json())
    .then((s) => dot.classList.toggle('on', !!s.ok)).catch(() => {});

  const stamp = () => { when.textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false }); };

  // 用 textContent 塞內容（自動跳脫，白名單無 HTML），CSS pre-wrap 保留換行
  function bubble(role, text) {
    const el = document.createElement('div');
    el.className = `sp-msg ${role === 'user' ? 'user' : 'bot'}`;
    el.textContent = text;
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
    return el;
  }

  function setBusy(b) {
    busy = b;
    input.disabled = b;
    sendBtn.disabled = b;
    refreshBtn.disabled = b;
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 84)}px`;
  }

  // 開場：分析目前頁面（清空對話重來）
  async function opener() {
    if (busy) return;
    setBusy(true);
    history.length = 0;
    thread.innerHTML = '';
    const pending = bubble('bot', '');
    pending.innerHTML = '<span class="sp-pulse">分析目前頁面…</span>';
    try {
      const r = await fetch('/api/sprite/suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, context: context() }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
      const text = (await r.json()).text || '（沒有取得建議）';
      pending.textContent = text;
      history.push({ role: 'assistant', content: text });
      dot.classList.add('on');
      stamp();
    } catch (err) {
      pending.className = 'sp-msg err';
      pending.textContent = err.message;
      dot.classList.remove('on');
    } finally {
      setBusy(false);
    }
  }

  // 使用者主動追問（多輪）
  async function ask() {
    const q = input.value.trim();
    if (!q || busy) return;
    input.value = '';
    autoGrow();
    bubble('user', q);
    history.push({ role: 'user', content: q });
    setBusy(true);
    const pending = bubble('bot', '');
    pending.innerHTML = '<span class="sp-pulse">思考中…</span>';
    try {
      const r = await fetch('/api/sprite/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, context: context(), history }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
      const text = (await r.json()).text || '（沒有回應）';
      pending.textContent = text;
      history.push({ role: 'assistant', content: text });
      dot.classList.add('on');
      stamp();
    } catch (err) {
      pending.className = 'sp-msg err';
      pending.textContent = err.message;
      dot.classList.remove('on');
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  function setOpen(open) {
    root.classList.toggle('open', open);
    localStorage.setItem('js-sprite-open', open ? '1' : '0');
    if (open) {
      input.focus();
      if (!fetchedOnce) { fetchedOnce = true; opener(); }
    }
  }

  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  sendBtn.addEventListener('click', ask);
  refreshBtn.addEventListener('click', opener);
  root.querySelector('.sp-fab').addEventListener('click', () => setOpen(!root.classList.contains('open')));
  root.querySelector('[data-sp="close"]').addEventListener('click', () => setOpen(false));

  // 跨頁還原開啟狀態：首抓延後，等場景資料載完再分析（避免 LLM 看到空場景）
  if (localStorage.getItem('js-sprite-open') === '1') {
    root.classList.add('open');
    setTimeout(() => { if (!fetchedOnce) { fetchedOnce = true; opener(); } }, 2500);
  }
}
