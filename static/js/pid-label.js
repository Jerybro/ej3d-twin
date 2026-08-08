// P&ID 標示化協作工作台
// 核心 UX：把整張圖切成分區，帶著工程師一區一區走完 —— AI 判讀、工程師確認、
// 標記本區巡完 → 完成度才有真實分母（「整廠資訊化」是可量的，不是感覺）。
// 人工驗證關卡：模型輸出一律先進「候選」，按下採納才入庫並留稽核。

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function confClass(c) { return c >= 0.75 ? '' : (c >= 0.5 ? 'mid' : 'lo'); }
const KIND_TXT = { equipment: '設備', valve: '閥件', instrument: '儀錶', pipe: '管線', other: '其他' };

const $ = id => document.getElementById(id);
const stage = $('stage');
const ZC = 5, ZR = 4;           // 分區格數（欄×列）：A3 圖面實測這個粒度一區可判 5-15 個元件

let curFile = null, baseMeta = null, zoom = 1;
let sel = null;                 // 目前作用區域 [x0,y0,x1,y1]
let zoneIdx = -1;               // 導覽中的分區序號（-1＝自由框選）
let zonesDone = {};             // {"r-c": {...}}
let annots = [];
let wrap, sheet, overlay, selEl;
const engine = () => $('engine').value;

// ------------------------------------------------------------------ 分區
// 分區之間刻意重疊 —— 位號剛好壓在格線上會被切成兩半，兩邊都認不出來
// （實測 PDI 65105 卡在分區左緣整個漏掉）。重疊帶讓邊界元件至少被完整看到一次；
// 重複命中由標註端依 tag 去重吸收。
const ZOVER = 0.35;             // 重疊比例（佔一格寬/高）

function zoneBox(i) {           // 序號 → 正規化 bbox（左→右、上→下）
  const r = Math.floor(i / ZC), c = i % ZC;
  const ox = ZOVER / ZC, oy = ZOVER / ZR;
  return [Math.max(0, c / ZC - ox), Math.max(0, r / ZR - oy),
          Math.min(1, (c + 1) / ZC + ox), Math.min(1, (r + 1) / ZR + oy)];
}
const zoneKey = i => `${Math.floor(i / ZC)}-${i % ZC}`;

function renderZoneMap() {
  const el = $('zonemap');
  if (!curFile) { el.innerHTML = ''; return; }
  el.style.gridTemplateColumns = `repeat(${ZC}, 1fr)`;
  let html = '';
  for (let i = 0; i < ZC * ZR; i++) {
    const done = zonesDone[zoneKey(i)] ? ' done' : '';
    const cur = i === zoneIdx ? ' cur' : '';
    html += `<div class="zc${done}${cur}" data-i="${i}" title="第 ${i + 1} 區">${i + 1}</div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('.zc').forEach(z =>
    z.addEventListener('click', () => gotoZone(+z.dataset.i)));
  $('zone-hint').textContent = `共 ${ZC * ZR} 區，綠＝已巡完。點格子可直接跳。`;
}

function updateProgress() {
  const total = ZC * ZR, done = Object.keys(zonesDone).length;
  $('prog-bar').style.width = (done / total * 100) + '%';
  $('prog-txt').innerHTML = curFile
    ? `分區進度 <b>${done}/${total}</b>（${Math.round(done / total * 100)}%）｜已確認位號 <b>${annots.length}</b> 個`
    : '尚未開始';
}

function setGuide(step, title, body) {
  $('g-title').textContent = title;
  $('g-body').innerHTML = body;
  [...$('g-steps').children].forEach((n, i) => n.classList.toggle('on', i < step));
}

// ------------------------------------------------------------------ 檔案
async function loadFiles() {
  const el = $('file-list');
  try {
    const files = await fetch('/api/pid/list').then(r => r.json());
    if (!files.length) { el.innerHTML = '<span class="hint">尚無圖面，請先到 P&ID 管理上傳。</span>'; return; }
    el.innerHTML = files.map(f =>
      `<div class="file-item" data-name="${esc(f.name)}">${esc(f.name)}</div>`).join('');
    el.querySelectorAll('.file-item').forEach(d =>
      d.addEventListener('click', () => openDoc(d.dataset.name)));
  } catch { el.innerHTML = '<span class="hint">圖面清單載入失敗。</span>'; }
}

async function openDoc(name) {
  curFile = name; sel = null; zoneIdx = -1;
  $('doc-name').textContent = name;
  document.querySelectorAll('.file-item').forEach(d =>
    d.classList.toggle('active', d.dataset.name === name));
  stage.className = 'empty';
  stage.innerHTML = '<span><span class="spin"></span> 渲染圖面中（首次較久）…</span>';
  setGuide(1, '② 渲染中…', '正在把 PDF 轉成可框選的高解析底圖。');
  try {
    baseMeta = await fetch(`/api/pid/vlm/base/${encodeURIComponent(name)}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); });
  } catch {
    stage.innerHTML = '<span>圖面渲染失敗，請確認 PDF 可讀。</span>';
    setGuide(1, '渲染失敗', '這張 PDF 讀不出來，換一張試試。');
    return;
  }
  stage.className = '';
  stage.innerHTML = `<div id="canvas-wrap"><img id="sheet" src="${esc(baseMeta.url)}" draggable="false" />
    <div id="overlay"></div></div>`;
  wrap = $('canvas-wrap'); sheet = $('sheet'); overlay = $('overlay');
  if (sheet.complete && sheet.naturalWidth) fitZoom();
  else sheet.addEventListener('load', fitZoom, { once: true });
  bindSelection();
  $('start-btn').disabled = false;
  await loadAnnots();
  renderZoneMap();
  setGuide(2, '③ 開始導覽', '按 <b>開始導覽</b>，我會帶你從第 1 區走到第 ' +
    (ZC * ZR) + ' 區；也可以直接在圖上拖曳框選任意區域。');
}

// -------------------------------------------------------------------- 縮放
function applyZoom() {
  if (!sheet || !baseMeta) return;
  sheet.style.width = Math.round(baseMeta.w * zoom) + 'px';
  $('zoom-val').textContent = Math.round(zoom * 100) + '%';
}
function fitZoom() {
  if (!baseMeta) return;
  zoom = Math.min(1, (stage.clientWidth - 24) / baseMeta.w);
  applyZoom();
}
$('zoom-in').addEventListener('click', () => { zoom = Math.min(zoom * 1.4, 8); applyZoom(); });
$('zoom-out').addEventListener('click', () => { zoom = Math.max(zoom / 1.4, 0.02); applyZoom(); });
$('zoom-fit').addEventListener('click', fitZoom);

// ---------------------------------------------------------------- 框選互動
function bindSelection() {
  let sx = 0, sy = 0, dragging = false;
  overlay.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const r = overlay.getBoundingClientRect();
    sx = e.clientX - r.left; sy = e.clientY - r.top;
    dragging = true;
    overlay.setPointerCapture(e.pointerId);
    if (selEl) selEl.remove();
    selEl = document.createElement('div');
    selEl.className = 'sel-box';
    overlay.appendChild(selEl);
    e.preventDefault();
  });
  overlay.addEventListener('pointermove', e => {
    if (!dragging) return;
    const r = overlay.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    selEl.style.cssText = `left:${Math.min(sx, cx)}px;top:${Math.min(sy, cy)}px;` +
      `width:${Math.abs(cx - sx)}px;height:${Math.abs(cy - sy)}px`;
  });
  overlay.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    const r = overlay.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const x0 = Math.min(sx, cx) / r.width, x1 = Math.max(sx, cx) / r.width;
    const y0 = Math.min(sy, cy) / r.height, y1 = Math.max(sy, cy) / r.height;
    if ((x1 - x0) < 0.003 || (y1 - y0) < 0.003) {
      if (selEl) { selEl.remove(); selEl = null; }
      return;                                  // 誤點：保留原本作用區域
    }
    zoneIdx = -1;                              // 手動框選 → 脫離導覽序
    document.querySelectorAll('.zone-box').forEach(b => b.remove());
    renderZoneMap();
    setSel([x0, y0, x1, y1], `自由框選 ${Math.round((x1 - x0) * 100)}%×${Math.round((y1 - y0) * 100)}% 區域`);
  });
}

function setSel(box, label) {
  sel = box;
  $('sel-hint').innerHTML = `作用區域：<b>${esc(label)}</b>，可以判讀了。`;
  ['scan-btn', 'id-btn', 'ask-btn', 'cmp-btn'].forEach(i => { $(i).disabled = false; });
}

// 智慧掃描：OCR 定位 → VLM 只做選擇題 → ISA 解碼（本平台預設路徑）
$('scan-btn').addEventListener('click', async () => {
  if (!sel || !curFile) return;
  const el = $('cands');
  el.innerHTML = '<span class="hint"><span class="spin"></span> OCR 定位中，接著逐個氣泡判外框…</span>';
  $('scan-btn').disabled = true;
  try {
    const r = await fetch('/api/pid/vlm/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile, bbox: sel, provider: engine() }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '掃描失敗');
    renderCands(d, d.stats);
  } catch (err) {
    el.innerHTML = `<span class="hint" style="color:var(--lo)">${esc(err.message)}</span>`;
  } finally { $('scan-btn').disabled = !sel; }
});

// ------------------------------------------------------------------ 導覽
function gotoZone(i, autoScan) {
  if (!curFile || i < 0 || i >= ZC * ZR) return;
  zoneIdx = i;
  const box = zoneBox(i);
  if (selEl) { selEl.remove(); selEl = null; }
  document.querySelectorAll('.zone-box').forEach(b => b.remove());
  const d = document.createElement('div');
  d.className = 'zone-box';
  d.dataset.z = `第 ${i + 1} 區 / ${ZC * ZR}`;
  d.style.cssText = `left:${box[0] * 100}%;top:${box[1] * 100}%;` +
    `width:${(box[2] - box[0]) * 100}%;height:${(box[3] - box[1]) * 100}%`;
  overlay.appendChild(d);
  d.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  setSel(box, `第 ${i + 1} 區（共 ${ZC * ZR} 區）`);
  $('next-btn').disabled = false;
  renderZoneMap();
  setGuide(3, `④ 第 ${i + 1} 區`,
    '按 <b>辨識這區元件</b> 讓 AI 判讀 → 逐項 <b>採納</b> 或 <b>不是</b> → ' +
    '確認完按 <b>本區完成</b> 進下一區。');
  $('answer').style.display = 'none';
  // 導覽推進時直接開判（帶著使用者做）；手動點格子只跳過去不自動花 GPU
  if (autoScan) $('scan-btn').click();
  else $('cands').innerHTML = '<span class="hint">按「智慧掃描」開始判讀這一區。</span>';
}

$('start-btn').addEventListener('click', () => {
  let i = 0;                                   // 從第一個未完成的分區接續
  while (i < ZC * ZR && zonesDone[zoneKey(i)]) i++;
  gotoZone(i >= ZC * ZR ? 0 : i, true);
});

$('next-btn').addEventListener('click', async () => {
  if (zoneIdx < 0) return;
  try {
    const r = await fetch(`/api/pid/vlm/zone/${encodeURIComponent(curFile)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone: zoneKey(zoneIdx), status: 'done' }),
    });
    zonesDone = (await r.json()).zones || zonesDone;
  } catch { /* 進度存不了不擋流程 */ }
  updateProgress();
  let n = zoneIdx + 1;
  while (n < ZC * ZR && zonesDone[zoneKey(n)]) n++;
  if (n >= ZC * ZR) {
    renderZoneMap();
    setGuide(4, '全圖巡完 🎉',
      `這張圖 ${ZC * ZR} 區都走完了，共確認 <b>${annots.length}</b> 個位號。` +
      '可以換下一張圖面繼續。');
    $('next-btn').disabled = true;
    return;
  }
  gotoZone(n, true);
});

// -------------------------------------------------------------------- 分頁
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === t));
  ['work', 'cmp', 'list'].forEach(n =>
    $('tab-' + n).style.display = n === t.dataset.tab ? '' : 'none');
}));

// -------------------------------------------------------------------- 問答
$('qbtns').addEventListener('click', e => {
  const b = e.target.closest('.qbtn');
  if (!b) return;
  $('q').value = b.dataset.q;
  if (sel) doAsk();
});

async function doAsk() {
  if (!sel || !curFile) return;
  const box = $('answer');
  box.style.display = ''; box.className = 'answer';
  box.innerHTML = '<span class="spin"></span> 判讀中…';
  $('ask-btn').disabled = true;
  try {
    const r = await fetch('/api/pid/vlm/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile, bbox: sel, question: $('q').value, provider: engine() }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '判讀失敗');
    box.textContent = d.text;
  } catch (err) {
    box.className = 'answer err'; box.textContent = err.message || '判讀失敗';
  } finally { $('ask-btn').disabled = !sel; }
}
$('ask-btn').addEventListener('click', doAsk);

// ---------------------------------------------------------------- 結構化辨識
$('id-btn').addEventListener('click', async () => {
  if (!sel || !curFile) return;
  const el = $('cands');
  el.innerHTML = '<span class="hint"><span class="spin"></span> 辨識中…</span>';
  $('id-btn').disabled = true;
  try {
    const r = await fetch('/api/pid/vlm/identify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile, bbox: sel, provider: engine() }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || '辨識失敗');
    renderCands(d);
  } catch (err) {
    el.innerHTML = `<span class="hint" style="color:var(--lo)">${esc(err.message)}</span>`;
  } finally { $('id-btn').disabled = !sel; }
});

function renderCands(d, stats) {
  const el = $('cands');
  if (!d.items || !d.items.length) {
    el.innerHTML = `<span class="hint">${esc(d.warn || 'AI 在這區沒有辨識出可標註的元件——可能這區是空白或圖框。')}</span>`;
    return;
  }
  const head = stats
    ? `OCR 定位 ${stats.instruments} 儀錶 / ${stats.equipment} 設備｜
       幾何抓到 ${stats.valves || 0} 閥件｜AI 判外框 ${stats.vlm_calls} 次。請逐項確認：`
    : `AI 判讀出 ${d.items.length} 項，請逐項確認（採納才會入庫）：`;
  el.innerHTML =
    `<div class="hint" style="margin-bottom:7px">${head}</div>` +
    d.items.map((it, i) => `
    <div class="cand" data-i="${i}">
      <div class="cand-top">
        <span class="cand-tag">${esc(it.tag || '（無位號）')}</span>
        <span class="conf ${confClass(it.confidence)}">${Math.round(it.confidence * 100)}%</span>
        <span class="cand-sym">${esc(KIND_TXT[it.kind] || it.kind)}</span>
        ${it.mounting ? `<span class="cand-sym">· ${esc(it.mounting)}</span>` : ''}
      </div>
      <div class="cand-sym">${esc(it.symbol)}${it.note ? '｜' + esc(it.note) : ''}</div>
      ${it.warn ? `<div class="cand-sym" style="color:var(--mid)">⚠ ${esc(it.warn)}</div>` : ''}
      ${(it.evidence || []).length ? `<details class="ev"><summary>判讀依據（${it.evidence.length} 步）</summary>
        ${it.evidence.map(e => `<div class="ev-row">
          <span class="ev-dot ${e.ok ? 'ok' : 'no'}"></span>
          <span class="ev-g"><b>${esc(e.stage)}</b>
            <span class="ev-s">${Math.round((e.score || 0) * 100)}%</span><br>
            <span class="ev-d">${esc(e.detail)}</span></span></div>`).join('')}
      </details>` : ''}
      <div class="cand-act">
        <button class="mini-btn primary acc">採納</button>
        <button class="mini-btn drop-it">不是</button>
      </div>
    </div>`).join('') +
    `<button class="mini-btn ghost" id="acc-all" style="width:100%;margin-top:4px">
      全部採納（${d.items.length} 項）</button>`;
  reviewTotal = d.items.length; reviewDone = 0; updateReview();
  el.querySelectorAll('.cand').forEach(c => {
    const it = d.items[+c.dataset.i];
    c.querySelector('.acc').addEventListener('click', () => accept(it, c));
    c.querySelector('.drop-it').addEventListener('click', () => reject(it, c));
  });
  $('acc-all').addEventListener('click', async e => {
    e.target.disabled = true;
    for (const c of [...el.querySelectorAll('.cand')]) await accept(d.items[+c.dataset.i], c);
  });
}

// 本區審核進度：AI 判出幾項、人工審過幾項——一一審核要看得到還剩幾筆
let reviewTotal = 0, reviewDone = 0;
function updateReview() {
  const el = $('review-txt');
  if (!el) return;
  el.textContent = reviewTotal
    ? `本區審核 ${reviewDone}/${reviewTotal}` + (reviewDone >= reviewTotal ? '（已審完）' : '')
    : '';
  el.style.color = (reviewTotal && reviewDone >= reviewTotal) ? 'var(--hi)' : 'var(--dim)';
}

function markReviewed(cardEl, txt, cls) {
  cardEl.classList.add('taken');
  cardEl.querySelector('.cand-act').innerHTML =
    `<span class="hint" style="color:var(--${cls})">${txt}</span>`;
  reviewDone++; updateReview();
}

async function reject(it, cardEl) {
  markReviewed(cardEl, '已否決 ✕（已留稽核）', 'lo');
  try {
    await fetch(`/api/pid/vlm/reject/${encodeURIComponent(curFile)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: it.tag, kind: it.kind }),
    });
  } catch { /* 留痕失敗不擋審核流程 */ }
}

async function accept(it, cardEl) {
  if (!sel || !curFile) return;
  try {
    const r = await fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // 智慧掃描的每一項都有自己的精確座標；純 AI 判讀才退回整區框
      body: JSON.stringify({ ...it, bbox: it.bbox || sel,
        source: engine() === 'cloud' ? 'vlm-cloud' : 'vlm-local' }),
    });
    if (!r.ok) throw new Error();
    markReviewed(cardEl, '已採納 ✓', 'hi');
    await loadAnnots();
  } catch { alert('採納失敗，請重試'); }
}

// ------------------------------------------------------------ 雙引擎比對
$('cmp-btn').addEventListener('click', async () => {
  if (!sel || !curFile) return;
  const el = $('cmp-out');
  el.innerHTML = '<span class="hint"><span class="spin"></span> 兩個引擎判讀中（地端較慢）…</span>';
  $('cmp-btn').disabled = true;
  try {
    const d = await fetch('/api/pid/vlm/compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile, bbox: sel }),
    }).then(r => r.json());
    const col = (r, cls, name) => `
      <div class="cmp-col"><div class="cmp-h ${cls}">${name}（${(r.items || []).length}）</div>
      <div class="cmp-b">${r.error ? `<div style="color:var(--lo)">${esc(r.error)}</div>`
        : ((r.items || []).map(i =>
          `<div><b>${esc(i.tag || '—')}</b> <span style="color:var(--dim)">${esc(i.symbol)}</span></div>`
        ).join('') || '<div style="color:var(--dim)">無</div>')}</div></div>`;
    el.innerHTML = `<div class="cmp">${col(d.cloud || {}, 'c', '雲端 Claude')}${col(d.local || {}, 'l', '地端 Qwen')}</div>
      <div class="dif">
        <div><b>兩邊都抓到</b>：${(d.diff.both.join('、') || '—')}</div>
        <div style="color:var(--cloud)"><b>只有雲端抓到</b>：${(d.diff.cloud_only.join('、') || '—')}</div>
        <div><b>只有地端抓到</b>：${(d.diff.local_only.join('、') || '—')}</div>
      </div>`;
  } catch {
    el.innerHTML = '<span class="hint" style="color:var(--lo)">比對失敗</span>';
  } finally { $('cmp-btn').disabled = !sel; }
});

// ------------------------------------------------------------ 已採納標註
async function loadAnnots() {
  if (!curFile) return;
  try {
    const d = await fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}`).then(r => r.json());
    annots = d.items || [];
    zonesDone = d.zones || {};
  } catch { annots = []; zonesDone = {}; }
  renderAnnots(); drawAnnotBoxes(); updateProgress(); renderZoneMap();
}

function renderAnnots() {
  const el = $('annots');
  $('an-count').textContent = annots.length ? `（${annots.length}）` : '';
  const ex = $('export-btn');
  ex.href = curFile ? `/api/pid/vlm/export/${encodeURIComponent(curFile)}` : '#';
  ex.style.opacity = annots.length ? '' : '0.45';
  ex.style.pointerEvents = annots.length ? '' : 'none';
  if (!annots.length) { el.innerHTML = '<span class="hint">尚無標註。</span>'; return; }
  el.innerHTML = annots.slice().reverse().map(a => `
    <div class="an-row" data-id="${esc(a.id)}">
      <span class="conf ${confClass(a.confidence)}">${Math.round((a.confidence || 0) * 100)}%</span>
      <span class="g"><b>${esc(a.tag || '（無位號）')}</b>
        <span style="color:var(--dim)">${esc(KIND_TXT[a.kind] || a.kind)}${a.symbol ? '｜' + esc(a.symbol) : ''}</span></span>
      <span class="x" title="刪除">×</span>
    </div>`).join('');
  el.querySelectorAll('.an-row').forEach(r =>
    r.querySelector('.x').addEventListener('click', () => delAnnot(r.dataset.id)));
}

function drawAnnotBoxes() {
  if (!overlay) return;
  overlay.querySelectorAll('.an-box').forEach(b => b.remove());
  for (const a of annots) {
    if (!Array.isArray(a.bbox) || a.bbox.length !== 4) continue;
    const [x0, y0, x1, y1] = a.bbox;
    const d = document.createElement('div');
    d.className = 'an-box ' + confClass(a.confidence || 0);
    d.style.cssText = `left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%`;
    d.innerHTML = `<i>${esc(a.tag || KIND_TXT[a.kind] || '標註')}</i>`;
    overlay.appendChild(d);
  }
}

async function delAnnot(id) {
  try {
    await fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}/${encodeURIComponent(id)}`,
      { method: 'DELETE' });
    await loadAnnots();
  } catch { /* 重載即可看出結果 */ }
}

// -------------------------------------------------------------- 引擎狀態
async function refreshEngine() {
  const pill = $('eng-pill');
  try {
    const s = await fetch('/api/pid/vlm/status').then(r => r.json());
    window.__ENG = s;
    const cur = s[engine()] || {};
    pill.className = 'pill' + (cur.ok ? '' : ' warn');
    pill.textContent = cur.ok
      ? (engine() === 'cloud' ? `雲端就緒｜${cur.model}` : `地端就緒｜${cur.model}`)
      : (cur.reason || '未就緒');
  } catch { pill.className = 'pill warn'; pill.textContent = '引擎狀態未知'; }
}
$('engine').addEventListener('change', refreshEngine);

refreshEngine();
loadFiles();
setGuide(1, '① 選一張圖面',
  '左側點一張 P&ID，系統會把整張圖切成分區，帶你一區一區把位號標示完成。');
