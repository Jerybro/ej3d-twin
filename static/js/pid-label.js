// P&ID 判讀工作台
// 流程：整張辨識 → 逐項審核（點到哪就在圖上高亮哪）→ 全部審完 → 產生製程說明。
// 兩條鐵則：
//   1. 模型輸出一律先進待審，工程師確認才入庫（否決也留稽核，不靜默丟棄）
//   2. 製程說明只能建立在「已確認」的清單上——用未經確認的輸出寫報告
//      等於把幻覺包裝成結論

// 伺服器 500 時回的是 HTML 錯誤頁，直接 JSON.parse 會炸出
// 「Unexpected token 'I'」這種看不懂的訊息。統一在這裡吸收掉。
async function getJSON(url, opt) {
  const r = await fetch(url, opt);
  const txt = await r.text();
  let d = null;
  try { d = JSON.parse(txt); } catch { /* 非 JSON */ }
  if (!r.ok) {
    throw new Error((d && d.detail) || `伺服器錯誤 ${r.status}`
      + (r.status >= 500 ? '（後端例外，請看終端機訊息）' : ''));
  }
  if (d === null) throw new Error('伺服器回應格式異常');
  return d;
}

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

// ------------------------------------------------------------------ 上傳
async function uploadFiles(files) {
  const st = $('up-state');
  const list = [...files].filter(f => /\.(pdf|jpe?g|png)$/i.test(f.name));
  if (!list.length) { st.textContent = '只接受 PDF／JPG／PNG'; return; }
  let ok = 0;
  for (const [i, f] of list.entries()) {
    st.innerHTML = `<span class="spin"></span> 上傳中 ${i + 1}/${list.length}：${esc(f.name)}`;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const r = await fetch('/api/pid/upload', { method: 'POST', body: fd });
      if (r.ok) ok++;
      else { const e = await r.json().catch(() => ({})); throw new Error(e.detail || r.status); }
    } catch (e) {
      st.innerHTML = `<span style="color:var(--lo)">${esc(f.name)} 上傳失敗：${esc(e.message || '')}</span>`;
      return;
    }
  }
  st.innerHTML = `<span style="color:var(--hi)">已上傳 ${ok} 個檔案</span>`;
  await loadFiles();
  loadGroups();            // 新圖進來 → 重算建議分組
}

$('file-input').addEventListener('change', e => {
  uploadFiles(e.target.files); e.target.value = '';
});
['dragenter', 'dragover'].forEach(t => $('drop').addEventListener(t, e => {
  e.preventDefault(); $('drop').classList.add('over');
}));
['dragleave', 'drop'].forEach(t => $('drop').addEventListener(t, e => {
  e.preventDefault(); $('drop').classList.remove('over');
}));
$('drop').addEventListener('drop', e => uploadFiles(e.dataTransfer.files));

// ------------------------------------------------------------------ 圖組
// 一套廠的圖從來不是一張。分組之後，本圖清冊查不到的項次號會自動到同組
// 其他圖的清冊找——「答案寫在下一張」是真實存在的情形（潤泰 500~508
// 畫在礦化圖上，但清冊在燒結那張）。歸屬由人定義，猜錯比沒有更糟。
let groups = [], ungrouped = [], suggestions = [];

async function loadGroups() {
  try {
    const d = await getJSON('/api/pid/group');
    groups = d.groups || []; ungrouped = d.ungrouped || [];
    suggestions = d.suggestions || [];
  } catch { groups = []; }
  renderGroups();
}

function renderGroups() {
  const el = $('grp-list');
  const rows = groups.map(g => {
    const on = g.files.includes(curFile);
    return `<div class="grp ${on ? 'on' : ''}">
      <div class="grp-h" data-g="${esc(g.id)}">
        <b>${esc(g.name)}</b>
        <span style="color:var(--dim)">${g.files.length}</span>
        <span class="x" data-del="${esc(g.id)}" title="刪除圖組">×</span>
      </div>
      ${g.files.map(f => `<div class="grp-f ${f === curFile ? 'cur' : ''}"
          data-open="${esc(f)}">· ${esc(f.replace(/\.pdf$/i, '').slice(0, 34))}</div>`).join('')}
    </div>`;
  });
  const sug = suggestions.map(s => `<div class="sug">建議分組：<b>${esc(s.key)}</b>
    共 ${s.files.length} 張<br>${esc(s.reason)}
    <button class="mini-btn" style="margin-top:5px;width:100%"
            data-sug="${esc(s.key)}">用這個建議建立</button></div>`);
  el.innerHTML = (rows.join('') + sug.join('')) ||
    '<span class="hint">尚無圖組。上傳同一套廠的多張圖後，這裡會出現建議分組。</span>';

  el.querySelectorAll('[data-open]').forEach(d =>
    d.addEventListener('click', () => openDoc(d.dataset.open)));
  el.querySelectorAll('[data-del]').forEach(d =>
    d.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('刪除這個圖組？圖面本身不會被刪除。')) return;
      await fetch(`/api/pid/group/${encodeURIComponent(d.dataset.del)}`, { method: 'DELETE' });
      loadGroups();
    }));
  el.querySelectorAll('[data-g]').forEach(d =>
    d.addEventListener('click', () => showGroupOverview(d.dataset.g)));
  el.querySelectorAll('[data-sug]').forEach(d =>
    d.addEventListener('click', async () => {
      const s = suggestions.find(x => x.key === d.dataset.sug);
      if (!s) return;
      await fetch('/api/pid/group', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: s.key + ' 圖組', files: s.files }),
      });
      loadGroups();
    }));
}

$('grp-toggle').addEventListener('click', () => {
  const b = $('grp-new');
  const open = b.style.display === 'none';
  b.style.display = open ? '' : 'none';
  if (open) {
    const all = groups.flatMap(g => g.files).concat(ungrouped);
    $('grp-pick').innerHTML = [...new Set(all)].sort().map(f =>
      `<label class="pick"><input type="checkbox" value="${esc(f)}" />
        ${esc(f.replace(/\.pdf$/i, '').slice(0, 30))}</label>`).join('');
    $('grp-name').focus();
  }
});
$('grp-cancel').addEventListener('click', () => { $('grp-new').style.display = 'none'; });
$('grp-save').addEventListener('click', async () => {
  const name = $('grp-name').value.trim();
  const files = [...$('grp-pick').querySelectorAll('input:checked')].map(i => i.value);
  if (!name) { alert('請填圖組名稱'); return; }
  if (files.length < 2) { alert('請至少選兩張圖'); return; }
  const r = await fetch('/api/pid/group', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, files }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); alert(e.detail || '建立失敗'); return; }
  $('grp-name').value = ''; $('grp-new').style.display = 'none';
  loadGroups();
});

// 整組彙總：一套圖的全貌先看過，再決定進哪一張審
async function showGroupOverview(gid) {
  try {
    const d = await getJSON(`/api/pid/group/${encodeURIComponent(gid)}/overview`);
    const t = d.totals || {};
    const sheets = (d.sheets || []).map(s =>
      `<tr><td style="padding:3px 8px 3px 0">${esc(s.file.replace(/\.pdf$/i, '').slice(0, 30))}</td>
       <td style="text-align:right">${s.built ? (s.equipment || 0) : '—'}</td>
       <td style="text-align:right">${s.built ? (s.instruments || 0) : '—'}</td>
       <td style="text-align:right">${s.built ? (s.valves || 0) : '—'}</td>
       <td style="text-align:right">${s.registry_rows || 0}</td>
       <td style="text-align:right">${s.built ? '已建模' : '<span style="color:var(--mid)">未建模</span>'}</td></tr>`).join('');
    const edges = (d.links?.edges || []).slice(0, 8).map(e =>
      `<div style="font-size:11.5px;color:var(--dim);padding:2px 0">
        ${esc(e.from.slice(0, 18))} → ${esc(e.to.slice(0, 18))}
        <span style="color:var(--accent)">${esc(e.kind)}</span> ${esc(e.via)}</div>`).join('');
    const gaps = (d.links?.unmatched || []).map(u =>
      `<div style="font-size:11.5px;color:#8a5b00;padding:2px 0">
        ⚠ ${esc(u.raw)} 指向的圖不在本組內（${esc(u.reason)}）</div>`).join('');
    $('rev-host').innerHTML = `<div class="rev">
      <div class="rev-top"><span class="rev-tag">${esc(d.group.name)}</span>
        <span class="rev-sub">${d.sheets.length} 張圖</span></div>
      <div class="rev-sub">合計：設備 <b>${t.equipment || 0}</b>｜儀錶 <b>${t.instruments || 0}</b>｜
        閥件 <b>${t.valves || 0}</b>｜迴路 <b>${t.loops || 0}</b>｜
        清冊 <b>${t.registry_located || 0}/${t.registry_rows || 0}</b> 列已定位</div>
      <table style="width:100%;font-size:11.5px;margin-top:9px;color:#24406e">
        <tr style="color:var(--dim)"><th style="text-align:left">圖面</th><th>設備</th><th>儀錶</th><th>閥</th><th>清冊</th><th></th></tr>
        ${sheets}</table>
      ${edges ? `<div class="rev-sub" style="margin-top:9px"><b>跨圖接續</b></div>${edges}` : ''}
      ${gaps ? `<div class="rev-sub" style="margin-top:7px"><b>缺口</b>（指向的圖尚未上傳）</div>${gaps}` : ''}
      <div class="rev-sub" style="margin-top:9px;font-size:11.5px">
        點上方圖組裡的圖名進入審核。本圖清冊查不到的項次號，
        系統會自動到同組其他圖的清冊查找並標為跨圖參照。</div>
    </div>`;
  } catch (e) { alert(e.message || '載入失敗'); }
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
  loadConvention(name);
  assetModel = null;
  loadModel(true);           // 之前建過模就直接帶出資產庫（404 靜默）
  renderGroups();            // 高亮目前這張圖所屬的圖組
}

// 開掃之前先告訴使用者這張圖是什麼體系、將套用哪份規範、信心多少。
// 判錯圖種等於整套規則失效，所以這個要在最前面讓人有機會攔下來。
async function loadConvention(name) {
  const el = $('conv-box');
  el.style.display = '';
  el.className = 'conv';
  el.innerHTML = '<span class="spin"></span> 判讀圖面體系…';
  try {
    const d = await getJSON(`/api/pid/vlm/convention/${encodeURIComponent(name)}`);
    const pct = Math.round((d.confidence || 0) * 100);
    const lvl = pct >= 70 ? 'ok' : (pct >= 40 ? 'mid' : 'lo');
    el.className = 'conv ' + lvl;
    el.innerHTML =
      `<div class="conv-top"><b>${esc(d.profile)}</b>
        <span class="conf ${lvl === 'ok' ? '' : (lvl === 'mid' ? 'mid' : 'lo')}">${pct}%</span></div>
       <div class="conv-sub">套用規範：<b>${esc(d.rules_file || '未指定，將用預設')}</b></div>
       ${(d.findings || []).length ? `<details class="ev"><summary>判定依據（${d.findings.length} 項）</summary>
         ${d.findings.map(f => `<div class="ev-row"><span class="ev-dot ${f.ok ? 'ok' : 'no'}"></span>
           <span class="ev-g"><b>${esc(f.stage)}</b><br>${esc(f.detail)}</span></div>`).join('')}
       </details>` : ''}`;
  } catch (e) {
    el.className = 'conv lo';
    el.textContent = '體系判讀失敗：' + (e.message || '');
  }
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
    const d = await getJSON('/api/pid/vlm/scan_all', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: curFile }),
    });
    items = (d.items || []).map(i => ({ ...i, state: 'pending' }));
    // 可疑項排前面：有警示 → 低信心 → 其餘。讓工程師先處理最需要判斷的，
    // 而不是從字母序第一項慢慢翻到最後才遇到問題。
    const rank = i => (i.warn ? 0 : (i.confidence < 0.7 ? 1 : 2));
    items.sort((a, b) => rank(a) - rank(b) || a.confidence - b.confidence);
    // 幾何檢查（氣泡＋編號族群）已在後端完成，且與 OCR 完全獨立。
    // 通過幾何驗證、信心滿分的儀錶直接放行，人只審有疑慮的。
    let auto = 0;
    for (const it of items) {
      if (it.kind === 'instrument' && it.confidence >= 1.0 && !it.warn) {
        it.state = 'accepted'; auto++;
        fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...it, source: 'auto-geom' }),
        }).catch(() => {});
      }
    }
    curIdx = items.findIndex(i => i.state === 'pending');
    if (curIdx < 0) curIdx = 0;
    render(); focusItem(curIdx);
    $('cc-state').innerHTML = `幾何驗證通過自動放行 <b style="color:var(--hi)">${auto}</b> 項｜`
      + `需人工審核 <b>${items.length - auto}</b> 項`;
    scheduleDesc();
    loadLocateCandidates();          // PFD：設備定位候選另外補進佇列
  } catch (e) {
    alert('辨識失敗：' + (e.message || ''));
  } finally {
    b.disabled = false; b.textContent = '重新辨識整張圖面';
  }
});

// ------------------------------------- 設備定位候選（PFD）
// 清冊早就知道 209 是捏和擠出機，缺的是「它在圖上哪裡」。定位器把框長出來，
// 工程師逐項確認才入庫——與儀錶同一條人工驗證關卡。
let registryRows = [];

async function loadLocateCandidates() {
  if (!curFile) return;
  try {
    const d = await getJSON(`/api/pid/model/locate/${encodeURIComponent(curFile)}`);
    registryRows = d.registry || [];
    const have = new Set(items.map(i => `${i.kind}:${i.tag}`));
    const add = (d.items || [])
      .filter(i => !have.has(`equipment:${i.tag}`))
      .map(i => ({ ...i, state: 'pending' }));
    if (!add.length) return;
    items = items.concat(add);
    const s = d.stats || {};
    $('cc-state').innerHTML += `<br>設備定位器：清冊 <b>${s.registry_rows || 0}</b> 列中 `
      + `<b style="color:var(--accent)">${s.registry_located || 0}</b> 列已長出候選框，`
      + `新增 <b>${add.length}</b> 項待審`;
    render();
  } catch { /* 非 PFD 或尚未建模，靜默略過 */ }
}

// ------------------------------------- OCR × VLM 雙重檢查（背景逐項跑）
// 不能只靠 OCR：它的信心只代表「字元讀對了」，不代表「這裡真的有這個位號」
// （實測 R101 信心 1.0 但圖上不存在）。讓 VLM 獨立再讀一次同一塊區域，
// 兩個方法一致才算真的可信，也才自動放行；不一致的一律留給人審。
let ccStop = false;

async function startCrossCheck() {
  ccStop = false;
  const queue = items.filter(i => i.state === 'pending' && i.kind !== 'valve');
  let done = 0, agreed = 0, flagged = 0;
  for (const it of queue) {
    if (ccStop || !curFile) break;
    try {
      const d = await fetch('/api/pid/vlm/crosscheck', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: curFile, bbox: it.bbox, tag: it.tag,
                               provider: engine() }),
      }).then(r => r.json());
      it.cross = d;
      it.confidence = Math.max(0.05, Math.min(1, it.confidence + (d.delta || 0)));
      (it.evidence = it.evidence || []).push({
        stage: 'OCR × VLM 雙重檢查', ok: d.verdict === 'agree',
        score: d.verdict === 'agree' ? 1.0 : (d.verdict === 'unclear' ? 0.5 : 0.2),
        detail: d.detail,
      });
      if (d.verdict === 'none' || d.verdict === 'conflict') {
        it.warn = (it.warn ? it.warn + '｜' : '') + d.detail;
        flagged++;
      }
      // 雙重確認通過、又是規則約束嚴格的儀錶 → 自動放行
      if (d.verdict === 'agree' && it.kind === 'instrument' && !it.warn) {
        it.state = 'accepted';
        agreed++;
        fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...it, source: 'auto-crosscheck' }),
        }).catch(() => {});
      }
    } catch { /* 單項失敗不中斷整批 */ }
    done++;
    $('cc-state').innerHTML =
      `雙重檢查 ${done}/${queue.length}｜<b style="color:var(--hi)">${agreed}</b> 項雙重確認自動通過`
      + (flagged ? `｜<b style="color:var(--lo)">${flagged}</b> 項不一致待判` : '');
    if (done % 4 === 0 || done === queue.length) { render(); scheduleDesc(); }
  }
  $('cc-state').innerHTML += '　✓ 完成';
  render();
}

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

// 提問句：把「現在在問你什麼」講成一句人話。
// 元件種類不同、有沒有位號，問法就不同——閥件多半無位號，硬套
// 「真的是閥件這個閥件嗎」會變成廢話。
function askText(it) {
  const kind = KIND_TXT[it.kind] || '元件';
  if (it.kind === 'equipment' && it.symbol && it.tag) {
    return `圖上這個框，真的是 <b>${esc(it.tag)}　${esc(it.symbol)}</b> 嗎？`;
  }
  if (!it.tag) {
    return `圖上這個位置，真的有一個<b>${esc(kind)}</b>嗎？`;
  }
  return `圖上這個位置，真的是 <b>${esc(it.tag)}</b> 這個${esc(kind)}嗎？`;
}

function renderReviewCard() {
  const host = $('rev-host');
  const it = items[curIdx];
  // 全部審完 → 給明確的完成畫面與後續動作，不要讓人點完最後一項沒反應
  if (items.length && allReviewed()) {
    const acc = items.filter(i => i.state === 'accepted').length;
    const rej = items.length - acc;
    host.innerHTML = `
      <div class="rev" style="border-color:var(--hi);background:rgba(18,161,80,0.08)">
        <div class="rev-top"><span class="rev-tag" style="color:#0b6b36">審核完成 ✓</span></div>
        <div class="rev-sub">共 ${items.length} 項：確認 <b>${acc}</b>、否決 <b>${rej}</b>。
          否決項已留稽核，不會入庫。</div>
        <div class="rev-act">
          <button class="mini-btn primary" id="done-model">建立資產模型 →</button>
          <a class="mini-btn" id="done-export"
             href="/api/pid/vlm/export/${encodeURIComponent(curFile)}">匯出 CSV</a>
          <button class="mini-btn" id="done-recheck">回頭複查</button>
        </div>
        <div class="rev-sub" style="margin-top:8px">下一步：把已確認的標註編譯成
          帶屬性的資產物件（閥件尺寸／儀錶迴路／管線編號），並掛上管網拓撲。</div>
      </div>`;
    $('done-model').onclick = () => { switchTab('assets'); buildModel(); };
    $('done-recheck').onclick = () => focusItem(0);
    clearRing();
    return;
  }
  if (!it) { host.innerHTML = ''; clearRing(); return; }
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
      ${it.cross ? `<div class="cross ${it.cross.verdict}">
        ${it.cross.verdict === 'agree' ? '✓ OCR 與 AI 讀到相同位號'
          : it.cross.verdict === 'none' ? '✕ AI 判定該處沒有位號'
          : it.cross.verdict === 'unclear' ? '？ AI 讀不清楚，無法交叉驗證'
          : it.cross.verdict === 'partial' ? '△ 兩者部分相符'
          : `✕ 兩者不一致：AI 讀為「${esc(it.cross.vlm_tag)}」`}</div>` : ''}
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
      ${regPickerHtml(it)}
      <input class="rev-note" id="rev-note" placeholder="備註（選填）：寫下判斷理由或現場補充"
             value="${esc(it.user_note || '')}" />
      <div class="ask">${askText(it)}</div>
      <div class="rev-act">
        <button class="mini-btn primary" id="acc-b">是，寫入台帳 <span style="opacity:.75">(Y)</span></button>
        <button class="mini-btn" id="rej-b">不是，判讀有誤 <span style="opacity:.6">(N)</span></button>
      </div>
      <div class="act-note">寫入台帳＝這筆成為正式資產資料並記上你的簽名；
        判讀有誤＝不入庫，但保留稽核紀錄（不會靜默消失）。</div>
    </div>`;
  $('prev-b').onclick = () => focusItem(Math.max(0, curIdx - 1));
  $('next-b').onclick = () => focusItem(Math.min(items.length - 1, curIdx + 1));
  $('acc-b').onclick = () => decide('accepted');
  $('rej-b').onclick = () => decide('rejected');
  bindRegPicker(it);
}

// L2 改配對：AI 配錯清冊列時，工程師直接改指正確項次。
// 只有 PFD（有設備清冊）才有意義——P&ID 沒清冊可配，這塊不顯示。
function regPickerHtml(it) {
  if (it.kind !== 'equipment' || !registryRows.length) return '';
  const cur = it.registry_item || '';
  const opts = registryRows.map(r =>
    `<option value="${esc(r.item)}"${r.item === cur ? ' selected' : ''}>${esc(r.item)}　${esc(r.name || '')}</option>`).join('');
  return `<div style="margin-top:10px">
    <div class="rev-sub" style="margin-bottom:4px">對照設備清冊
      ${cur ? '' : '<b style="color:#8a5b00">（未配對，請選擇）</b>'}</div>
    <select class="rev-note" id="reg-pick" style="padding:7px 9px">
      <option value=""${cur ? '' : ' selected'}>（不對照清冊）</option>${opts}
    </select></div>`;
}

function bindRegPicker(it) {
  const sel = $('reg-pick');
  if (!sel) return;
  sel.onchange = () => {
    const row = registryRows.find(r => r.item === sel.value);
    it.registry_item = sel.value;
    it.symbol = row ? (row.name || '設備') : '設備（待確認類型）';
    it.warn = sel.value ? '' : it.warn;
    it.evidence = (it.evidence || []).filter(e => e.stage !== '人工改配對');
    it.evidence.push({
      stage: '人工改配對', ok: true, score: 1.0,
      detail: row ? `審核者將此項改指清冊「${row.item}　${row.name || ''}」`
                  : '審核者將此項標記為不對照清冊',
    });
    render();
  };
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

// 圖上高亮：審核卡與資產庫共用——「這一項在圖中哪裡」是兩邊共同的需求
function showRing(bbox, label) {
  if (!overlay || !Array.isArray(bbox)) return;
  clearRing();
  const [x0, y0, x1, y1] = bbox;
  ring = document.createElement('div');
  ring.className = 'focus-ring';
  ring.dataset.t = label || '';
  const padX = Math.max(0.004, (x1 - x0) * 0.35), padY = Math.max(0.004, (y1 - y0) * 0.35);
  ring.style.cssText = `left:${(x0 - padX) * 100}%;top:${(y0 - padY) * 100}%;` +
    `width:${(x1 - x0 + padX * 2) * 100}%;height:${(y1 - y0 + padY * 2) * 100}%`;
  overlay.appendChild(ring);
  // 太小看不到 → 自動放大到看得清，再捲到畫面中央
  if (zoom < 0.6) { zoom = 0.7; applyZoom(); }
  requestAnimationFrame(() =>
    ring.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }));
}

// 點到哪就在圖上高亮哪——使用者要能立刻找到「PDI65104 在圖中哪裡」
function focusItem(k) {
  curIdx = k;
  const it = items[k];
  render();
  if (!it) return;
  showRing(it.bbox, it.tag || KIND_TXT[it.kind] || '');
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
  // 人工備註優先於機器產生的描述——工程師寫的判斷理由才是台帳要留的東西
  const nb = $('rev-note');
  if (nb && nb.value.trim()) {
    it.user_note = nb.value.trim();
    it.note = it.user_note;
  }
  it.state = state;
  try {
    if (state === 'accepted') {
      await fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...it, source: it.source === '定位器' ? 'locate' : 'scan' }),
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
  loadHistory();
}

// ------------------------------------------------------- 歷史建檔與復原
// 台帳是多人協作的東西：同事昨天審過一輪、今天你接手，得看得到他改了什麼，
// 也得能退回去。同網域共用同一份台帳，跨網域互不可見。
async function loadHistory() {
  const el = $('hist-box');
  if (!el || !curFile) return;
  try {
    const d = await getJSON(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}/history`);
    const vs = d.versions || [];
    if (!vs.length) {
      el.innerHTML = `<span class="hint">此網域（${esc(d.domain)}）尚無建檔紀錄。
        目前台帳 ${d.current.items} 筆。</span>`;
      return;
    }
    el.innerHTML = `<div class="hint" style="margin-bottom:6px">網域
        <b>${esc(d.domain)}</b>｜目前 ${d.current.items} 筆｜共 ${vs.length} 個版本
        <button class="mini-btn" id="undo-b" style="float:right;padding:3px 9px">回到上一動</button></div>`
      + vs.slice(0, 12).map(v => `<div class="hv" data-v="${esc(v.version)}">
          <span class="hv-t">${esc((v.at || v.version).replace('T', ' ').slice(0, 16))}</span>
          <span class="hv-a">${esc(v.action || '—')}</span>
          <span class="hv-n">${v.items} 筆</span>
          ${v.by ? `<span class="hv-b">${esc(v.by.split('@')[0])}</span>` : ''}
        </div>`).join('');
    $('undo-b').onclick = async () => {
      if (!confirm('回到上一動？目前的台帳狀態會被前一版取代（仍可再往回還原）。')) return;
      const r = await fetch(`/api/pid/vlm/annot/${encodeURIComponent(curFile)}/undo`,
                            { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(j.detail || '無法回復'); return; }
      alert(`已回到上一動，台帳現有 ${j.items} 筆`);
      loadHistory();
    };
    el.querySelectorAll('.hv').forEach(h => h.addEventListener('click', async () => {
      if (!confirm(`還原到 ${h.dataset.v} 這一版？`)) return;
      const r = await fetch(
        `/api/pid/vlm/annot/${encodeURIComponent(curFile)}/restore/${encodeURIComponent(h.dataset.v)}`,
        { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { alert(j.detail || '還原失敗'); return; }
      alert(`已還原，台帳現有 ${j.items} 筆`);
      loadHistory();
    }));
  } catch { el.innerHTML = '<span class="hint">歷史紀錄載入失敗。</span>'; }
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
  ['review', 'assets', 'adv'].forEach(n =>
    $('tab-' + n).style.display = n === t.dataset.tab ? '' : 'none');
}));
function switchTab(name) {
  document.querySelector(`.tab[data-tab="${name}"]`)?.click();
}

// ------------------------------------------------------- 資產庫
// 審核的下一步：已確認標註 → 型別化資產物件（屬性充實＋拓撲掛線）。
// 機器推定的屬性（尺寸/狀態/掛網）用黃色籤標示，滑過可看依據——
// 與審核流同一條鐵則：系統給的東西要能被查證。
let assetModel = null;

async function loadModel(silent) {
  if (!curFile) return;
  try {
    assetModel = await getJSON(`/api/pid/model/${encodeURIComponent(curFile)}`);
    renderModel();
    $('as-state').textContent = '上次建模：' +
      (assetModel.built_at || '').replace('T', ' ').slice(0, 16);
  } catch (e) {
    assetModel = null;
    $('as-body').innerHTML = '';
    $('as-state').textContent = silent ? '' : (e.message || '尚未建立資產模型');
  }
}

async function buildModel() {
  if (!curFile) return;
  const b = $('as-build');
  b.disabled = true;
  $('as-state').innerHTML =
    '<span class="spin"></span> 編譯資產模型中（若無 OCR 快取需重掃整頁，約 30 秒）…';
  try {
    assetModel = await getJSON(
      `/api/pid/model/build/${encodeURIComponent(curFile)}`, { method: 'POST' });
    renderModel();
    $('as-state').textContent = '建模完成：' +
      (assetModel.built_at || '').replace('T', ' ').slice(0, 16);
  } catch (e) {
    $('as-state').innerHTML =
      `<span style="color:var(--lo)">${esc(e.message || '建模失敗')}</span>`;
  } finally { b.disabled = false; }
}

function renderModel() {
  const m = assetModel;
  if (!m) return;
  const s = m.stats || {};
  const topoLine = m.topology && m.topology.ok
    ? `管網拓撲：${m.topology.stats.nodes} 節點｜閥件橋接 ${m.topology.bridge.bridged} 顆`
      + (m.topology.bridge.orphan ? `（${m.topology.bridge.orphan} 顆未掛上）` : '')
    : '';
  $('as-body').innerHTML = `
    <div class="as-stats">
      <div class="as-stat"><b>${s.equipment || 0}</b><span>設備</span></div>
      <div class="as-stat"><b>${s.instruments || 0}</b><span>儀錶</span></div>
      <div class="as-stat"><b>${s.valves || 0}</b><span>閥件</span></div>
      <div class="as-stat"><b>${s.loops || 0}</b><span>控制迴路</span></div>
      <div class="as-stat"><b>${s.lines || 0}</b><span>管線編號</span></div>
      <div class="as-stat"><b>${s.valves_on_net || 0}</b><span>閥已掛網</span></div>
    </div>
    ${topoLine ? `<div class="hint" style="margin-bottom:8px">${esc(topoLine)}</div>` : ''}
    <a class="mini-btn" style="width:100%;text-align:center;padding:8px;margin-bottom:9px"
       href="/twin/pid/rebuild?f=${encodeURIComponent(curFile)}" target="_blank">盲測重建比對
      <span style="opacity:.65">（只靠資料庫重畫這張圖）</span></a>
    <input class="as-search" id="as-q" placeholder="搜尋位號／名稱／屬性…" />
    <div id="as-list"></div>`;
  $('as-q').addEventListener('input', renderAssetList);
  renderAssetList();
}

function chip(label, sys, src) {
  return `<span class="as-chip${sys ? ' sys' : ''}"${src ? ` title="${esc(src)}"` : ''}>${esc(label)}</span>`;
}

function renderAssetList() {
  const m = assetModel;
  if (!m) return;
  const q = ($('as-q')?.value || '').trim().toUpperCase();
  const hit = (...fields) =>
    !q || fields.some(f => String(f || '').toUpperCase().includes(q));
  const rows = [];
  const grp = (title, arr) => {
    if (arr.length) rows.push(`<div class="as-grp">${title}（${arr.length}）<i></i></div>`, ...arr);
  };

  grp('設備', (m.equipment || []).filter(e => hit(e.tag, e.name, e.type, e.spec)).map((e, i) => `
    <div class="as-row${e.bbox ? '' : ' nofix'}" data-g="equipment" data-i="${m.equipment.indexOf(e)}">
      <div class="t"><b>${esc(e.tag)}</b>
        <span class="k">${esc(e.name || e.type || '')}</span>
        ${e.on_drawing ? '' : '<span class="as-chip sys" title="清冊有此列，但圖上尚未框到／未審核">未定位</span>'}</div>
      ${e.spec ? chip(e.spec) : ''}${e.driver ? chip(e.driver) : ''}
      ${e.vfd ? chip('變頻') : ''}${e.qty > 1 ? chip('×' + e.qty) : ''}
      <div class="as-src">${esc(e.source)}${e.remark ? '｜' + esc(e.remark) : ''}${e.note ? '｜備註：' + esc(e.note) : ''}</div>
    </div>`));

  grp('儀錶', (m.instruments || []).filter(x => hit(x.tag, x.function, x.loop)).map(x => `
    <div class="as-row" data-g="instruments" data-i="${m.instruments.indexOf(x)}">
      <div class="t"><b>${esc(x.tag)}</b><span class="k">${esc(x.function || '')}</span></div>
      ${x.mounting ? chip(x.mounting) : ''}${x.loop ? chip('迴路 ' + x.loop) : ''}
      ${x.note ? `<div class="as-src">備註：${esc(x.note)}</div>` : ''}
    </div>`));

  grp('閥件', (m.valves || []).filter(v => hit(v.id, v.size, v.state)).map(v => `
    <div class="as-row" data-g="valves" data-i="${m.valves.indexOf(v)}">
      <div class="t"><b>${esc(v.id)}</b>
        <span class="k">${v.net !== null && v.net !== undefined ? '管網 #' + v.net : '未掛上管網'}</span></div>
      ${v.size ? chip(v.size + ' 系統推定', true, v.size_src) : ''}
      ${v.state ? chip(v.state, true, v.state_src) : ''}
      ${v.bore ? chip(v.bore, true, v.bore_src) : ''}
      ${v.note ? `<div class="as-src">備註：${esc(v.note)}</div>` : ''}
    </div>`));

  grp('管線編號', (m.lines || []).filter(l => hit(l.raw, l.service, l.spec)).map(l => `
    <div class="as-row" data-g="lines" data-i="${m.lines.indexOf(l)}">
      <div class="t"><b>${esc(l.raw)}</b></div>
      ${chip(l.size_in + '"')}${chip('流體 ' + l.service)}${l.spec ? chip('等級 ' + l.spec) : ''}
      <div class="as-src">${esc(l.source)}</div>
    </div>`));

  grp('控制迴路', (m.loops || []).filter(l => hit(l.loop, ...(l.members || []))).map(l => `
    <div class="as-row" data-g="loops" data-i="${m.loops.indexOf(l)}">
      <div class="t"><b>迴路 ${esc(l.loop)}</b>
        <span class="k">${(l.members || []).join('、')}</span></div>
      ${l.has_controller ? chip('控制器') : ''}${l.has_transmitter ? chip('傳送器') : ''}
      ${l.has_valve ? chip('控制閥') : ''}${l.has_element ? chip('感測元件') : ''}
    </div>`));

  $('as-list').innerHTML = rows.join('') ||
    '<span class="hint">沒有符合搜尋的資產。</span>';
  $('as-list').querySelectorAll('.as-row').forEach(r =>
    r.addEventListener('click', () => {
      const arr = assetModel[r.dataset.g] || [];
      const it = arr[+r.dataset.i];
      if (!it) return;
      if (r.dataset.g === 'loops') {
        // 迴路本身沒有座標——跳到迴路第一顆儀錶的位置
        const first = (assetModel.instruments || [])
          .find(x => (it.members || []).includes(x.tag));
        if (first) showRing(first.bbox, '迴路 ' + it.loop);
        return;
      }
      if (it.bbox) showRing(it.bbox, it.tag || it.id || it.raw || '');
    }));
}

$('as-build').addEventListener('click', buildModel);

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
loadGroups();
