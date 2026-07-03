// AI 小精靈 — 右下角情境建議（本機 LLM 推論，資料不出機器）
// 孿生檢視與 E3D 工作區共用：initSprite({ page, bottom, context })
//   page    'twin' | 'e3d'（後端挑對應顧問人設）
//   bottom  距視窗底部 px（讓位給 scenario-bar / statusbar）
//   context () => object，按下取得建議時呼叫，回傳目前情境摘要
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
#js-sprite .sp-panel{position:absolute;bottom:56px;right:0;width:322px;background:#fff;border:1px solid #DBDDE0;
  border-radius:10px;box-shadow:0 10px 34px rgba(6,16,39,.16);display:none;overflow:hidden}
#js-sprite.open .sp-panel{display:block}
#js-sprite .sp-head{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#F6F7FA;border-bottom:1px solid #DBDDE0}
#js-sprite .sp-title{font-size:12.5px;font-weight:700;color:#061027;letter-spacing:.02em}
#js-sprite .sp-sub{font-size:10.5px;color:#5C6773;margin-left:auto}
#js-sprite .sp-head button{background:none;border:none;cursor:pointer;padding:2px;display:flex;color:#5C6773}
#js-sprite .sp-head button:hover{color:#046AFB}
#js-sprite .sp-head svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round}
#js-sprite .sp-body{padding:11px 13px;font-size:12.5px;line-height:1.62;color:#061027;max-height:340px;overflow-y:auto;
  white-space:pre-wrap;word-break:break-word}
#js-sprite .sp-body .sp-lead{color:#061027;font-weight:600;display:block;margin-bottom:6px}
#js-sprite .sp-body .sp-item{display:block;padding:5px 8px;margin:4px 0;background:#F6F7FA;border:1px solid #E9EDF2;
  border-radius:6px;color:#31404E}
#js-sprite .sp-body.sp-busy{color:#5C6773}
#js-sprite .sp-body.sp-err{color:#d03050}
#js-sprite .sp-foot{padding:6px 12px;border-top:1px solid #E9EDF2;font-size:10px;color:#8B96A0;display:flex;justify-content:space-between}
#js-sprite .sp-pulse{display:inline-block;animation:spPulse 1.1s ease-in-out infinite}
@keyframes spPulse{0%,100%{opacity:.35}50%{opacity:1}}
`;

const IC_SPARK = '<svg viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/><circle cx="12" cy="12" r="3.4"/></svg>';
const IC_REFRESH = '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/></svg>';
const IC_CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';

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
        <span class="sp-sub">本機推論</span>
        <button data-sp="refresh" title="依目前情境重新取得建議">${IC_REFRESH}</button>
        <button data-sp="close" title="收合">${IC_CLOSE}</button>
      </div>
      <div class="sp-body">點右上重新整理取得建議</div>
      <div class="sp-foot"><span>Qwen3.6｜資料不出這台機器</span><span class="sp-when"></span></div>
    </div>
    <button class="sp-fab" title="AI 助手（本機模型情境建議）">${IC_SPARK}<span class="sp-dot"></span></button>`;
  document.body.appendChild(root);

  const body = root.querySelector('.sp-body');
  const when = root.querySelector('.sp-when');
  const dot = root.querySelector('.sp-dot');
  let busy = false;
  let fetchedOnce = false;

  // 引擎狀態燈（不擋 UI，失敗就灰燈）
  fetch('/api/sprite/status').then((r) => r.json())
    .then((s) => dot.classList.toggle('on', !!s.ok)).catch(() => {});

  function render(text) {
    // 「第一行總結＋編號建議」→ 首行粗、編號行卡片化
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    body.classList.remove('sp-busy', 'sp-err');
    body.innerHTML = lines.map((l, i) => {
      const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      if (i === 0) return `<span class="sp-lead">${esc}</span>`;
      if (/^\d+[.、]/.test(l)) return `<span class="sp-item">${esc}</span>`;
      return `<span>${esc}</span>`;
    }).join('');
    when.textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  }

  async function suggest() {
    if (busy) return;
    busy = true;
    body.classList.remove('sp-err');
    body.classList.add('sp-busy');
    body.innerHTML = '<span class="sp-pulse">正在依目前情境思考…</span>';
    try {
      const r = await fetch('/api/sprite/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, context: context() }),
      });
      if (!r.ok) throw new Error((await r.json()).detail || `HTTP ${r.status}`);
      render((await r.json()).text || '（沒有取得建議內容）');
      dot.classList.add('on');
    } catch (err) {
      body.classList.remove('sp-busy');
      body.classList.add('sp-err');
      body.textContent = `${err.message}`;
      dot.classList.remove('on');
    } finally {
      busy = false;
    }
  }

  function setOpen(open) {
    root.classList.toggle('open', open);
    localStorage.setItem('js-sprite-open', open ? '1' : '0');
    if (open && !fetchedOnce) { fetchedOnce = true; suggest(); }
  }

  root.querySelector('.sp-fab').addEventListener('click', () => setOpen(!root.classList.contains('open')));
  root.querySelector('[data-sp="close"]').addEventListener('click', () => setOpen(false));
  root.querySelector('[data-sp="refresh"]').addEventListener('click', suggest);

  // 跨頁還原開啟狀態：首抓延後，等場景資料載完再看（避免 LLM 看到空場景）
  if (localStorage.getItem('js-sprite-open') === '1') {
    root.classList.add('open');
    setTimeout(() => { if (!fetchedOnce) { fetchedOnce = true; suggest(); } }, 2500);
  }
}
