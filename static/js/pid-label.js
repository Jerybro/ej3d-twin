// P&ID 判讀工作台
// 流程：整張辨識 → 逐項審核（點到哪就在圖上高亮哪）→ 全部審完 → 產生製程說明。
// 兩條鐵則：
//   1. 模型輸出一律先進待審，工程師確認才入庫（否決也留稽核，不靜默丟棄）
//   2. 製程說明只能建立在「已確認」的清單上——用未經確認的輸出寫報告
//      等於把幻覺包裝成結論

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function confClass(c) { return c >= 0.75 ? '' : (c >= 0.5 ? 'mid' : 'lo'); }
const KIND_TXT = { equipment: '設備', valve: '閥件', instrument: '儀錶', pipe: '管線', other: '其他' };

const $ = id => document.getElementById(id);
const stage = $('stage');
const ZC = 5, ZR = 4;

let curFile = null, baseMeta = null, zoom = 1;
let items = [];            // 待審清單（含 state: pending|accepted|rejected）
let curIdx = -1;
let sel = null;
let wrap, sheet, overlay, selEl, ring;
const engine = () => $('engine').value;

// ------------------------------------------------------------------ 檔案
async function loadFiles() {
  const el = $('file-list');
  try {
    const files = await fetch('/api/pid/list').then(r => r.json());
    if (!files.length) { el.innerHTML = '<span class="hint">尚無圖面。</span>'; return; }
    el.innerHTML = files.map(f =>
      `<div class="file-item" data-name="${esc(f.name)}">${esc(f.name)}</div>`).join('');
    el.querySelectorAll('.file-item').forEach(d =>
      d.addEventListener('click', () => openDoc(d.dataset.name)));
  } catch { el.innerHTML = '<span class="hint">清單載入失敗。</span>'; }
}

async function openDoc(name) {
  curFile = name; items = []; curIdx = -1; sel = null;
  $('doc-name').textContent = name;
  document.querySelectorAll('.file-item').forEach(d =>
    d.classList.toggle('active', d.dataset.name === name));
  stage.className = 'empty';
  stage.innerHTML = '<span><span class="spin"></span> 載入圖面中…</span>';
  try {
    baseMeta = await fetch(`/api/pid/vlm/base/${encodeURIComponent(name)}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); });
  } catch {
    stage.innerHTML = '<span>圖面載入失敗。</span>'; return;
  }
  stage.className = '';
  stage.innerHTML = `<div id="canvas-wrap"><img id="sheet" src="${esc(baseMeta.url)}" draggable="false" />
    <div id="overlay"></div></div>`;
  wrap = $('canvas-wrap'); sheet = $('sheet'); overlay = $('overlay');
  if (sheet.complete && sheet.naturalWidth) fitZoom();
  else sheet.addEventListener('load', fitZoom, { once: true });
  bindSelection();
  $('scan-all-btn').disabled = false;
  renderZoneMap();
  await loadAnnots();
  render();
}

// -------------------------------------------------------------------- 縮放
function applyZoom() {
  if (!sheet || !baseMeta) return;
  sheet.style.width = Math.round(baseMeta.w * zoom) + 'px';
  $('zoom-val').textContent = Math.round(zoom * 100) + '%';
}
function fitZoom() {
  if (!baseMeta) return;
  zoom = Math.min(1, (stage.clientWidth - 24) / baseMeta.w); applyZoom();
}
$('zoom-in').addEventListener('click', () => { zoom = Math.min(zoom * 1.4, 8); applyZoom(); });
$('zoom-out').addEventListener('click', () => { zoom = Math.max(zoom / 1.4, 0.02); applyZoom(); });
$('zoom-fit').addEventListener('click', fitZoom);

// 滾輪縮放，並以游標為錨點——放大時盯著的地方不會跑掉
stage.addEventListener('wheel', e => {
  if (!sheet || !baseMeta) return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left + stage.scrollLeft;   // 游標在內容座標系的位置
  const my = e.clientY - r.top + stage.scrollTop;
  const before = zoom;
  zoom = Math.max(0.02, Math.min(8, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  applyZoom();
  const k = zoom / before;
  stage.scrollLeft = mx * k - (e.clientX - r.left);
  stage.scrollTop = my * k - (e.clientY - r.top);
}, { passive: false });

// ------------------------------------------------------- 整張辨識
$('scan-all-btn').addEventListener('click', async () => {
  if (!curFile) return;
  const b = $('scan-all-btn');
  b.disabled = true; b.innerHTML = '<span class="spin"></span> 辨識中，整張圖需要一到兩分鐘…';
  try {
    const d = await fetch('/api/pid/vlm/scan_all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile }),
    }).then(r => r.json());
    if (d.detail) throw new Error(d.detail);
    // 滿分且無警示的儀錶自動通過，人只審真正有疑慮的——
    // 但設備一律要人看：OCR 給 R101 的信心也是 1.0，那只代表「字元讀對了」，
    // 不代表「這是有效設備位號」（實測 7 個設備有 4 個是誤讀）。
    items = (d.items || []).map(i => ({ ...i, state: i.auto_ok ? 'accepted' : 'pending' }));
    const auto = items.filter(i => i.state === 'accepted');
    for (const it of auto) {
      fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...it, source: 'auto' }),
      }).catch(() => {});
    }
    // 可疑項排前面：有警示 → 低信心 → 其餘。讓工程師先處理最需要判斷的，
    // 而不是從字母序第一項慢慢翻到最後才遇到問題。
    const rank = i => (i.warn ? 0 : (i.confidence < 0.7 ? 1 : 2));
    items.sort((a, b) => rank(a) - rank(b) || a.confidence - b.confidence);
    curIdx = items.findIndex(i => i.state === 'pending');
    if (curIdx < 0) curIdx = 0;
    render(); focusItem(curIdx);
    if (auto.length) {
      $('prog-txt').insertAdjacentHTML('beforeend',
        `<br><span style="color:var(--hi)">滿分儀錶 ${auto.length} 項已自動通過，
         只需人工確認其餘 ${items.length - auto.length} 項</span>`);
    }
  } catch (e) {
    alert('辨識失敗：' + (e.message || ''));
  } finally {
    b.disabled = false; b.textContent = '重新辨識整張圖面';
  }
});

// ------------------------------------------------------- 審核
function reviewedCount() { return items.filter(i => i.state !== 'pending').length; }
function allReviewed() { return items.length > 0 && reviewedCount() === items.length; }

function render() {
  const done = reviewedCount(), total = items.length;
  $('prog-bar').style.width = total ? (done / total * 100) + '%' : '0';
  $('prog-txt').innerHTML = total
    ? `審核進度 <b>${done}/${total}</b>（${Math.round(done / total * 100)}%）｜
       已確認 <b>${items.filter(i => i.state === 'accepted').length}</b> 項`
    : '尚未辨識';
  $('li-count').textContent = total ? `（${total}）` : '';
  renderReviewCard();
  renderList();
  drawBoxes();

  const acc = items.filter(i => i.state === 'accepted').length;
  $('desc-btn').disabled = acc < 3;
  if (!descText) {
    $('desc-state').textContent = acc < 3
      ? `再確認 ${3 - acc} 項就會自動產生說明`
      : '準備產生說明…';
  }
}

function renderReviewCard() {
  const host = $('rev-host');
  const it = items[curIdx];
  if (!it) {
    host.innerHTML = items.length
      ? '<div class="hint" style="margin-bottom:12px">全部審完了 ✓ 下方製程說明已依最終清單校正。</div>' : '';
    clearRing(); return;
  }
  const mount = it.mounting ? `｜安裝：${esc(it.mounting)}` : '';
  host.innerHTML = `
    <div class="nav-row">
      <button class="mini-btn" id="prev-b">← 上一項</button>
      <span class="sp"></span>
      <span class="hint">第 ${curIdx + 1} / ${items.length} 項</span>
      <span class="sp"></span>
      <button class="mini-btn" id="next-b">下一項 →</button>
    </div>
    <div class="rev">
      <div class="rev-top">
        <span class="rev-tag">${esc(it.tag || '（無位號）')}</span>
        <span class="conf ${confClass(it.confidence)}">${Math.round(it.confidence * 100)}%</span>
        <span class="rev-sub">${esc(KIND_TXT[it.kind] || it.kind)}</span>
      </div>
      <div class="rev-sub">${esc(it.symbol || '')}${mount}
        ${it.mount_conf ? `<span class="hint">（安裝別信心 ${Math.round(it.mount_conf * 100)}%）</span>` : ''}</div>
      ${it.note ? `<div class="rev-sub" style="opacity:.85">${esc(it.note)}</div>` : ''}
      ${it.warn ? `<div class="rev-sub" style="color:#8a5b00">⚠ ${esc(it.warn)}</div>` : ''}
      ${(it.evidence || []).length ? `<details class="ev"><summary>判讀依據（${it.evidence.length} 步）</summary>
        ${it.evidence.map(e => `<div class="ev-row"><span class="ev-dot ${e.ok ? 'ok' : 'no'}"></span>
          <span class="ev-g"><b>${esc(e.stage)}</b><span class="ev-s">${Math.round((e.score || 0) * 100)}%</span><br>
          ${esc(e.detail)}</span></div>`).join('')}</details>` : ''}
      <img class="rev-crop" alt="局部圖"
           src="/api/pid/vlm/crop/${encodeURIComponent(curFile)}?bbox=${it.bbox.join(',')}&z=7" />
      <div class="crop-cap">↑ 圖上實際樣貌（框中央即此項）${
        it.warn ? '<b style="color:#8a5b00">　請對照確認是否真有此位號</b>' : ''}</div>
      <div class="ctx${it.warn ? ' verify' : ''}" id="ctx-box">${it._ctx
        ? esc(it._ctx)
        : '<span class="spin"></span> ' + (it.warn ? '查核這個判讀是否成立…' : '判讀這顆在圖上的角色與前後連接…')}</div>
      <div class="rev-act">
        <button class="mini-btn primary" id="acc-b">確認正確 <span style="opacity:.75">(Y)</span></button>
        <button class="mini-btn" id="rej-b">不是 <span style="opacity:.6">(N)</span></button>
      </div>
    </div>`;
  $('prev-b').onclick = () => focusItem(Math.max(0, curIdx - 1));
  $('next-b').onclick = () => focusItem(Math.min(items.length - 1, curIdx + 1));
  $('acc-b').onclick = () => decide('accepted');
  $('rej-b').onclick = () => decide('rejected');
}

function renderList() {
  const el = $('li-list');
  if (!items.length) { el.innerHTML = '<span class="hint">按上方按鈕辨識整張圖面。</span>'; return; }
  el.innerHTML = items.map((i, k) => `
    <div class="li ${k === curIdx ? 'cur' : ''} ${i.state !== 'pending' ? 'done' : ''}" data-k="${k}">
      <span class="conf ${confClass(i.confidence)}">${Math.round(i.confidence * 100)}</span>
      <span class="g"><b>${esc(i.tag || '（無位號）')}</b>
        <span style="color:var(--dim)">${esc(KIND_TXT[i.kind] || i.kind)}
        ${i.symbol ? '｜' + esc(i.symbol) : ''}</span></span>
      <span class="st">${i.state === 'accepted' ? '✓' : i.state === 'rejected' ? '✕' : ''}</span>
    </div>`).join('');
  el.querySelectorAll('.li').forEach(d =>
    d.addEventListener('click', () => focusItem(+d.dataset.k)));
}

// 點到哪就在圖上高亮哪——使用者要能立刻找到「PDI65104 在圖中哪裡」
function focusItem(k) {
  curIdx = k;
  const it = items[k];
  render();
  if (!it || !overlay) return;
  clearRing();
  const [x0, y0, x1, y1] = it.bbox;
  ring = document.createElement('div');
  ring.className = 'focus-ring';
  ring.dataset.t = it.tag || KIND_TXT[it.kind] || '';
  const padX = Math.max(0.004, (x1 - x0) * 0.35), padY = Math.max(0.004, (y1 - y0) * 0.35);
  ring.style.cssText = `left:${(x0 - padX) * 100}%;top:${(y0 - padY) * 100}%;` +
    `width:${(x1 - x0 + padX * 2) * 100}%;height:${(y1 - y0 + padY * 2) * 100}%`;
  overlay.appendChild(ring);
  // 太小看不到 → 自動放大到看得清，再捲到畫面中央
  if (zoom < 0.6) { zoom = 0.7; applyZoom(); }
  requestAnimationFrame(() =>
    ring.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }));
  if (it.kind === 'instrument' && !it.mounting) classifyOne(k);
  loadContext(k);
}

// 這顆元件在圖上扮演什麼角色——裁一塊夠大的鄰域讓模型看得到上下游
async function loadContext(k) {
  const it = items[k];
  if (!it || it._ctx || it._ctxBusy) return;
  it._ctxBusy = true;
  try {
    const d = await fetch('/api/pid/vlm/context', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // 被標警示的項目改用查核問法——用「描述功能」去問等於預設它存在，
      // 模型只能編出連接關係，跟警示自相矛盾（實測 D181 就是這樣）
      body: JSON.stringify({ filename: curFile, bbox: it.bbox, tag: it.tag,
                             kind: it.kind, symbol: it.symbol, provider: engine(),
                             verify: !!it.warn }),
    }).then(r => r.json());
    it._ctx = d.text || '（無法判讀這塊區域）';
  } catch { it._ctx = '（情境判讀失敗）'; }
  if (curIdx === k) renderReviewCard();
}
function clearRing() { if (ring) { ring.remove(); ring = null; } }

// 審到哪一項才判那一項的安裝別（就地／盤面），不必先等整張圖跑完推論
async function classifyOne(k) {
  const it = items[k];
  if (!it || it._cls) return;
  it._cls = true;
  try {
    const d = await fetch('/api/pid/vlm/classify_one', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile, bbox: it.bbox, provider: engine() }),
    }).then(r => r.json());
    if (d.mounting) {
      it.mounting = d.mounting; it.mount_conf = d.mount_conf;
      (it.evidence = it.evidence || []).push(
        { stage: '安裝別判定', ok: true, score: d.mount_conf, detail: d.detail });
      if (curIdx === k) renderReviewCard();
    }
  } catch { /* 判不出來就留空，不擋審核 */ }
}

async function decide(state) {
  const it = items[curIdx];
  if (!it || it.state !== 'pending') { focusItem(Math.min(items.length - 1, curIdx + 1)); return; }
  it.state = state;
  try {
    if (state === 'accepted') {
      await fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...it, source: 'scan' }),
      });
    } else {
      await fetch(`/api/pid/vlm/reject/${encodeURIComponent(curFile)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: it.tag, kind: it.kind }),
      });
    }
  } catch { /* 留痕失敗不擋流程 */ }
  const nxt = items.findIndex((x, i) => i > curIdx && x.state === 'pending');
  focusItem(nxt >= 0 ? nxt : Math.min(items.length - 1, curIdx + 1));
  checkStale();          // 標註一改，既有製程說明就可能過期
}

// 只畫「已確認」的框——未確認的不畫，避免整片色塊蓋住圖面
// 框線顏色＝信心度（綠高／黃中／紅低），線型＝審核狀態（實線已確認／虛線待審）。
// 一律綠色等於把「這項很可靠」和「這項很可疑」畫成同一個樣子，
// 使用者反而看不出該優先看哪裡。
function drawBoxes() {
  if (!overlay) return;
  overlay.querySelectorAll('.an-box').forEach(b => b.remove());
  for (const a of items) {
    if (a.state === 'rejected' || !Array.isArray(a.bbox)) continue;
    const [x0, y0, x1, y1] = a.bbox;
    const d = document.createElement('div');
    d.className = 'an-box ' + confClass2(a) + (a.state === 'pending' ? ' pending' : '')
      + (a.kind === 'equipment' ? ' eq' : '');
    d.title = `${a.tag || KIND_TXT[a.kind]}｜信心 ${Math.round(a.confidence * 100)}%`
      + (a.warn ? '｜⚠ ' + a.warn : '');
    d.style.cssText = `left:${x0 * 100}%;top:${y0 * 100}%;` +
      `width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%`;
    overlay.appendChild(d);
  }
}
// 有警示一律降級成低信心配色——警示的意義就是「別信這個數字」
function confClass2(a) {
  if (a.warn) return 'lo';
  return a.confidence >= 0.9 ? 'hi' : (a.confidence >= 0.6 ? 'mid' : 'lo');
}

async function loadAnnots() {
  if (!curFile) return;
  const ex = $('export-btn');
  ex.href = `/api/pid/vlm/export/${encodeURIComponent(curFile)}`;
}

// ------------------------------------------------------- 製程說明
let descText = '';          // 目前這一版說明（修訂時要帶回後端比對）

// 模型把改動過的句子包在 ⟪⟫ 裡 → 轉成 <mark> 高亮
function renderDesc(t) {
  return esc(t).replace(/⟪([\s\S]*?)⟫/g, '<mark>$1</mark>');
}

let descBusy = false, descTimer = null, descBaseline = '';

function annotSignature() {
  return items.filter(i => i.state === 'accepted')
    .map(i => `${i.tag}|${i.kind}|${i.mounting || ''}`).sort().join(';');
}

async function genDesc(feedback) {
  if (descBusy || !curFile) return;
  descBusy = true;
  const out = $('desc-out'), st = $('desc-state');
  st.className = 'dp-state live';
  st.innerHTML = `<span class="spin"></span> ${feedback ? '依你的意見修訂中…' : '校正說明中…'}`;
  $('desc-btn').disabled = true;
  const sig = annotSignature();
  try {
    const d = await fetch('/api/pid/vlm/describe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile, feedback: feedback || '',
                             previous: descText }),
    }).then(r => r.json());
    if (d.detail) throw new Error(d.detail);
    descText = d.text;
    descBaseline = sig;
    out.innerHTML = `<div class="desc">${renderDesc(d.text)}</div>`;
    const acc = items.filter(i => i.state === 'accepted').length;
    st.className = 'dp-state';
    st.innerHTML = d.revised
      ? `依 ${acc} 項已確認標註校正｜<b style="color:#8a5b00">黃底＝本次改動</b>`
      : `依 ${acc} 項已確認標註產生`;
    $('fb-text').value = '';
  } catch (e) {
    st.className = 'dp-state';
    st.textContent = '產生失敗';
    out.innerHTML = `<div class="desc" style="color:var(--lo)">${esc(e.message || '產生失敗')}</div>`;
  } finally {
    descBusy = false;
    $('desc-btn').disabled = items.filter(i => i.state === 'accepted').length < 3;
    if (annotSignature() !== descBaseline) scheduleDesc();   // 期間又審了新的
  }
}

// 每次審核都可能改變結論——去抖動後自動校正，讓使用者真的看到
// 「我審了這一項，說明就跟著變」，但不會每點一下就打一次模型
function scheduleDesc() {
  const acc = items.filter(i => i.state === 'accepted').length;
  if (acc < 3 || descBusy) return;
  if (annotSignature() === descBaseline) return;
  clearTimeout(descTimer);
  $('desc-state').className = 'dp-state live';
  $('desc-state').textContent = descText ? '標註已變更，即將校正說明…' : '即將產生說明…';
  descTimer = setTimeout(() => genDesc(''), 2500);
}

$('desc-btn').addEventListener('click', () => { clearTimeout(descTimer); genDesc(''); });
$('fb-toggle').addEventListener('click', () => {
  const b = $('fb-box');
  b.style.display = b.style.display === 'none' ? '' : 'none';
  if (b.style.display === '') $('fb-text').focus();
});
$('fb-btn').addEventListener('click', () => {
  const t = $('fb-text').value.trim();
  if (!t) { alert('請先寫下要修正或補充的內容'); return; }
  clearTimeout(descTimer); genDesc(t);
});
$('dp-collapse').addEventListener('click', () =>
  $('desc-panel').classList.toggle('collapsed'));

function checkStale() { scheduleDesc(); }

// ------------------------------------------------------- 手動標註
let manBox = null;
function openManual(box) {
  manBox = box;
  $('man-form').style.display = '';
  $('man-hint').innerHTML = `已框選區域，填入位號後即可加入。`;
  $('man-tag').focus();
}
$('man-cancel').addEventListener('click', () => {
  manBox = null; $('man-form').style.display = 'none';
  $('man-hint').textContent = '在圖面上直接拖曳框選一塊區域，即可補上 AI 沒抓到的元件。';
  if (selEl) { selEl.remove(); selEl = null; }
});
$('man-add').addEventListener('click', async () => {
  if (!manBox || !curFile) return;
  const tag = $('man-tag').value.trim();
  if (!tag) { alert('請輸入位號'); return; }
  const it = {
    tag, kind: $('man-kind').value, symbol: '', mounting: '', mount_conf: 0,
    note: $('man-note').value.trim(), confidence: 1.0, bbox: manBox,
    source: 'manual', state: 'accepted',
    evidence: [{ stage: '人工標註', ok: true, score: 1.0,
                 detail: '由工程師手動框選並填寫，非模型輸出' }],
  };
  try {
    await fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(it),
    });
  } catch { alert('儲存失敗'); return; }
  items.push(it);
  $('man-tag').value = ''; $('man-note').value = '';
  $('man-cancel').click();
  render(); checkStale();
});

// ------------------------------------------------------- 分頁
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
  ['review', 'adv'].forEach(n =>
    $('tab-' + n).style.display = n === t.dataset.tab ? '' : 'none');
}));

// ------------------------------------------------------- 進階：分區/問答/比對
function zoneBox(i) {
  const r = Math.floor(i / ZC), c = i % ZC;
  const ox = 0.35 / ZC, oy = 0.35 / ZR;
  return [Math.max(0, c / ZC - ox), Math.max(0, r / ZR - oy),
          Math.min(1, (c + 1) / ZC + ox), Math.min(1, (r + 1) / ZR + oy)];
}
function renderZoneMap() {
  const el = $('zonemap');
  el.style.gridTemplateColumns = `repeat(${ZC}, 1fr)`;
  el.innerHTML = Array.from({ length: ZC * ZR },
    (_, i) => `<div class="zc" data-i="${i}">${i + 1}</div>`).join('');
  el.querySelectorAll('.zc').forEach(z => z.addEventListener('click', () => {
    const b = zoneBox(+z.dataset.i);
    setSel(b, `第 ${+z.dataset.i + 1} 區`);
    clearRing();
    ring = document.createElement('div');
    ring.className = 'focus-ring'; ring.dataset.t = `第 ${+z.dataset.i + 1} 區`;
    ring.style.cssText = `left:${b[0] * 100}%;top:${b[1] * 100}%;` +
      `width:${(b[2] - b[0]) * 100}%;height:${(b[3] - b[1]) * 100}%`;
    overlay.appendChild(ring);
    ring.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }));
}
function setSel(box, label) {
  sel = box;
  $('sel-hint').innerHTML = `作用區域：<b>${esc(label)}</b>`;
  ['ask-btn', 'cmp-btn'].forEach(i => { $(i).disabled = false; });
}
function bindSelection() {
  let sx = 0, sy = 0, drag = false;
  overlay.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const r = overlay.getBoundingClientRect();
    sx = e.clientX - r.left; sy = e.clientY - r.top; drag = true;
    overlay.setPointerCapture(e.pointerId);
    if (selEl) selEl.remove();
    selEl = document.createElement('div');
    selEl.style.cssText = 'position:absolute;border:2px solid var(--accent);' +
      'background:rgba(4,106,251,0.10);pointer-events:none';
    overlay.appendChild(selEl); e.preventDefault();
  });
  overlay.addEventListener('pointermove', e => {
    if (!drag) return;
    const r = overlay.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    selEl.style.left = Math.min(sx, cx) + 'px'; selEl.style.top = Math.min(sy, cy) + 'px';
    selEl.style.width = Math.abs(cx - sx) + 'px'; selEl.style.height = Math.abs(cy - sy) + 'px';
  });
  overlay.addEventListener('pointerup', e => {
    if (!drag) return;
    drag = false;
    const r = overlay.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const x0 = Math.min(sx, cx) / r.width, x1 = Math.max(sx, cx) / r.width;
    const y0 = Math.min(sy, cy) / r.height, y1 = Math.max(sy, cy) / r.height;
    if ((x1 - x0) < 0.004 || (y1 - y0) < 0.004) { if (selEl) { selEl.remove(); selEl = null; } return; }
    const box = [x0, y0, x1, y1];
    setSel(box, `框選 ${Math.round((x1 - x0) * 100)}%×${Math.round((y1 - y0) * 100)}%`);
    openManual(box);          // 框選即可手動補標，也同時成為問答的作用區域
  });
}

$('ask-btn').addEventListener('click', async () => {
  if (!sel || !curFile) return;
  const box = $('answer');
  box.style.display = ''; box.innerHTML = '<span class="spin"></span> 判讀中…';
  try {
    const d = await fetch('/api/pid/vlm/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile, bbox: sel, question: $('q').value, provider: engine() }),
    }).then(r => r.json());
    box.textContent = d.text || d.detail || '（無回應）';
  } catch { box.textContent = '判讀失敗'; }
});

$('cmp-btn').addEventListener('click', async () => {
  if (!sel || !curFile) return;
  const el = $('cmp-out');
  el.innerHTML = '<span class="hint"><span class="spin"></span> 兩個引擎判讀中…</span>';
  try {
    const d = await fetch('/api/pid/vlm/compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile, bbox: sel }),
    }).then(r => r.json());
    const col = (r, name) => `<div style="flex:1"><b style="font-size:11.5px">${name}（${(r.items || []).length}）</b>
      <div class="hint">${r.error ? esc(r.error)
        : ((r.items || []).map(i => esc(i.tag || '—')).join('、') || '無')}</div></div>`;
    el.innerHTML = `<div style="display:flex;gap:10px">${col(d.cloud || {}, '雲端')}${col(d.local || {}, '地端')}</div>
      <div class="hint" style="margin-top:6px">兩邊都抓到：${(d.diff.both.join('、') || '—')}</div>`;
  } catch { el.innerHTML = '<span class="hint">比對失敗</span>'; }
});

(async function initEngine() {
  try {
    const s = await fetch('/api/pid/vlm/status').then(r => r.json());
    const cur = s[engine()] || {};
    $('eng-pill').textContent = cur.ok ? `就緒｜${cur.model}` : (cur.reason || '未就緒');
  } catch { $('eng-pill').textContent = '狀態未知'; }
})();
$('engine').addEventListener('change', () => location.reload());

// 鍵盤快捷：一兩百項用滑鼠點不完。Y/Enter 確認、N 否決、方向鍵切換。
document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) || !items.length) return;
  const k = e.key.toLowerCase();
  if (k === 'y' || e.key === 'Enter') { e.preventDefault(); decide('accepted'); }
  else if (k === 'n') { e.preventDefault(); decide('rejected'); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    e.preventDefault(); focusItem(Math.min(items.length - 1, curIdx + 1));
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    e.preventDefault(); focusItem(Math.max(0, curIdx - 1));
  }
});

loadFiles();
