// 產品2：資料前處理 — 上傳 / 時序繪圖 / 框選剔除 / 規則清洗 / 皮爾森 / CoolProp
let sid = null;
let columns = [];       // 欄位摘要
let seriesData = null;  // {x, cols, row_idx, excluded}
let selectedRows = new Set();
const PALETTE = ['#46c2e0', '#ffaa3c', '#35e08c', '#e07b8b', '#9d7be0', '#e0d05a'];

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 上傳
const drop = $('drop');
const fileInput = $('file-input');
fileInput.addEventListener('change', () => upload(fileInput.files[0]));
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]);
});

async function upload(file) {
  if (!file) return;
  drop.textContent = '解析中…';
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/data/upload', { method: 'POST', body: fd });
  drop.textContent = '點擊或拖放 CSV / Excel';
  drop.appendChild(fileInput);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`上傳失敗：${err.detail ?? res.status}`);
    return;
  }
  const info = await res.json();
  sid = info.sid;
  columns = info.columns;
  $('file-meta').innerHTML = `${info.filename}<br>${info.n_rows.toLocaleString()} 列 × ${columns.length} 欄`;
  renderColumns();
  updateStat(info.n_rows, 0);
  for (const id of ['btn-export', 'btn-apply-rules', 'btn-corr', 'btn-props-check', 'btn-props-derive']) $(id).disabled = false;
  refreshPropsCols();
}

function renderColumns() {
  const numeric = columns.filter((c) => c.dtype.startsWith('float') || c.dtype.startsWith('int'));
  $('col-list').innerHTML = numeric.map((c, i) => `
    <label class="col-item">
      <input type="checkbox" data-col="${c.name}" ${i < 2 ? 'checked' : ''}>
      <span>${c.name}</span><span class="dtype">${c.dtype}</span>
    </label>`).join('');
  $('col-list').querySelectorAll('input').forEach((inp) =>
    inp.addEventListener('change', loadSeries));
  loadSeries();
}

const checkedCols = () =>
  [...$('col-list').querySelectorAll('input:checked')].map((i) => i.dataset.col);

async function loadSeries() {
  const cols = checkedCols();
  if (!sid || !cols.length) { seriesData = null; draw(); return; }
  seriesData = await fetch(`/api/data/${sid}/series?cols=${encodeURIComponent(cols.join(','))}`)
    .then((r) => r.json()).catch(() => null);
  selectedRows.clear();
  updateSelButtons();
  draw();
}

function updateStat(kept, excluded) {
  $('stat-chip').innerHTML = `保留 <b>${kept.toLocaleString()}</b>｜剔除 ${excluded.toLocaleString()}`;
}

// ---------------------------------------------------------------- 繪圖
const canvas = $('chart');
const ctx = canvas.getContext('2d');
const M = { l: 60, r: 16, t: 24, b: 34 };
let dragBox = null; // [x0,y0,x1,y1] px

function fitCanvas() {
  const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
  canvas.width = w * devicePixelRatio;
  canvas.height = h * devicePixelRatio;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  draw();
}
new ResizeObserver(fitCanvas).observe(canvas.parentElement);

function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  $('chart-hint').style.display = seriesData ? 'none' : '';
  if (!seriesData) return;
  const cols = Object.keys(seriesData.cols);
  const n = seriesData.x.length;
  if (!n) return;
  const px = (i) => M.l + (i / Math.max(n - 1, 1)) * (w - M.l - M.r);

  // 每欄 normalize 0–1 疊圖（多量綱共畫）
  cols.forEach((c, ci) => {
    const vals = seriesData.cols[c];
    const nums = vals.filter((v) => v != null);
    if (!nums.length) return;
    const lo = Math.min(...nums), hi = Math.max(...nums);
    const span = hi - lo || 1;
    const py = (v) => h - M.b - ((v - lo) / span) * (h - M.t - M.b);
    // 線
    ctx.strokeStyle = PALETTE[ci % PALETTE.length];
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    let started = false;
    vals.forEach((v, i) => {
      if (v == null) { started = false; return; }
      if (!started) { ctx.moveTo(px(i), py(v)); started = true; }
      else ctx.lineTo(px(i), py(v));
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
    // 點（狀態色：剔除紅、選取黃、正常欄色）
    vals.forEach((v, i) => {
      if (v == null) return;
      const row = seriesData.row_idx[i];
      const ex = seriesData.excluded[i];
      const sel = selectedRows.has(row);
      if (!ex && !sel && n > 1500) return; // 大數據只畫線＋異常點
      ctx.fillStyle = ex ? '#ff4d4f' : sel ? '#ffe14d' : PALETTE[ci % PALETTE.length];
      ctx.beginPath();
      ctx.arc(px(i), py(v), ex || sel ? 3 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    });
    // 圖例
    ctx.fillStyle = PALETTE[ci % PALETTE.length];
    ctx.fillRect(M.l + ci * 130, 8, 10, 10);
    ctx.fillStyle = '#dbe5ee';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText(`${c}（${lo.toFixed(1)}~${hi.toFixed(1)}）`, M.l + ci * 130 + 14, 17);
  });

  if (dragBox) {
    ctx.strokeStyle = '#ffe14d';
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(dragBox[0], dragBox[1], dragBox[2] - dragBox[0], dragBox[3] - dragBox[1]);
    ctx.setLineDash([]);
  }
}

// 框選：拖曳矩形 → 命中任一勾選欄的點 → 加入 selectedRows
let dragStart = null;
canvas.addEventListener('pointerdown', (e) => { dragStart = [e.offsetX, e.offsetY]; });
canvas.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  dragBox = [Math.min(dragStart[0], e.offsetX), Math.min(dragStart[1], e.offsetY),
             Math.max(dragStart[0], e.offsetX), Math.max(dragStart[1], e.offsetY)];
  draw();
});
canvas.addEventListener('pointerup', () => {
  if (dragBox && seriesData && (dragBox[2] - dragBox[0] > 6)) hitTest(dragBox);
  dragStart = null;
  dragBox = null;
  draw();
});

function hitTest(box) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const n = seriesData.x.length;
  const px = (i) => M.l + (i / Math.max(n - 1, 1)) * (w - M.l - M.r);
  for (const c of Object.keys(seriesData.cols)) {
    const vals = seriesData.cols[c];
    const nums = vals.filter((v) => v != null);
    if (!nums.length) continue;
    const lo = Math.min(...nums), hi = Math.max(...nums);
    const span = hi - lo || 1;
    const py = (v) => h - M.b - ((v - lo) / span) * (h - M.t - M.b);
    vals.forEach((v, i) => {
      if (v == null) return;
      const X = px(i), Y = py(v);
      if (X >= box[0] && X <= box[2] && Y >= box[1] && Y <= box[3]) {
        selectedRows.add(seriesData.row_idx[i]);
      }
    });
  }
  updateSelButtons();
}

function updateSelButtons() {
  const has = selectedRows.size > 0;
  $('btn-exclude').disabled = !has;
  $('btn-restore').disabled = !has;
  $('btn-clear-sel').disabled = !has;
  $('btn-exclude').textContent = has ? `剔除圈選（${selectedRows.size}）` : '剔除圈選';
}

$('btn-clear-sel').addEventListener('click', () => { selectedRows.clear(); updateSelButtons(); draw(); });

async function applyExclusion(restore) {
  const res = await fetch(`/api/data/${sid}/exclude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: [...selectedRows], reason: '手動圈選', restore }),
  }).then((r) => r.json());
  updateStat(res.kept, res.excluded);
  selectedRows.clear();
  updateSelButtons();
  await loadSeries();
}
$('btn-exclude').addEventListener('click', () => applyExclusion(false));
$('btn-restore').addEventListener('click', () => applyExclusion(true));
$('btn-export').addEventListener('click', () => { location.href = `/api/data/${sid}/export`; });

// ---------------------------------------------------------------- Tabs
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tab-body').forEach((x) => x.classList.remove('show'));
  t.classList.add('active');
  $(`tab-${t.dataset.tab}`).classList.add('show');
}));

// ---------------------------------------------------------------- 規則
const RULE_KINDS = [
  { kind: 'range', name: '值域（停機/冷態）', params: ['lo', 'hi'] },
  { kind: 'jump', name: '跳變・絕對值', params: ['max_abs'] },
  { kind: 'jump_pct', name: '跳變・百分比', params: ['max_pct'] },
  { kind: 'quantile', name: '分位離群', params: ['lo_q', 'hi_q'] },
  { kind: 'flatline', name: '凍結值（連續等值）', params: ['min_run'] },
];
let rules = [];

$('btn-add-rule').addEventListener('click', () => {
  rules.push({ kind: 'range', col: '', lo: '', hi: '' });
  renderRules();
});

function renderRules() {
  const numeric = columns.filter((c) => c.dtype.startsWith('float') || c.dtype.startsWith('int'));
  $('rule-list').innerHTML = rules.map((r, i) => {
    const spec = RULE_KINDS.find((k) => k.kind === r.kind);
    return `<div class="rule-row" data-i="${i}">
      <span class="rule-del" data-i="${i}">移除</span>
      <select data-f="kind">${RULE_KINDS.map((k) => `<option value="${k.kind}" ${k.kind === r.kind ? 'selected' : ''}>${k.name}</option>`).join('')}</select>
      <select data-f="col"><option value="">欄位…</option>${numeric.map((c) => `<option ${c.name === r.col ? 'selected' : ''}>${c.name}</option>`).join('')}</select>
      <div class="rule-grid">${spec.params.map((p) => `<input data-f="${p}" type="number" step="any" placeholder="${p}" value="${r[p] ?? ''}">`).join('')}</div>
    </div>`;
  }).join('');
  $('rule-list').querySelectorAll('select, input').forEach((el) => {
    el.addEventListener('change', () => {
      const i = +el.closest('.rule-row').dataset.i;
      rules[i][el.dataset.f] = el.dataset.f === 'kind' || el.dataset.f === 'col' ? el.value : +el.value;
      if (el.dataset.f === 'kind') renderRules();
    });
  });
  $('rule-list').querySelectorAll('.rule-del').forEach((el) =>
    el.addEventListener('click', () => { rules.splice(+el.dataset.i, 1); renderRules(); }));
}

$('btn-apply-rules').addEventListener('click', async () => {
  const valid = rules.filter((r) => r.col);
  const res = await fetch(`/api/data/${sid}/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: valid.map((r) => ({ ...r, label: `${RULE_KINDS.find((k) => k.kind === r.kind).name}:${r.col}` })) }),
  }).then((r) => r.json());
  updateStat(res.kept, res.excluded);
  $('reason-stats').innerHTML = Object.entries(res.by_reason).map(([k, v]) =>
    `<div class="reason-stat"><span>${k}</span><b>${v}</b></div>`).join('')
    || '<span class="hint">規則未命中任何資料</span>';
  await loadSeries();
});

// ---------------------------------------------------------------- 皮爾森
$('btn-corr').addEventListener('click', async () => {
  const cols = checkedCols();
  const res = await fetch(`/api/data/${sid}/corr?cols=${encodeURIComponent(cols.join(','))}`)
    .then((r) => { if (!r.ok) throw r; return r.json(); }).catch(async (r) => {
      const err = await r.json?.().catch(() => ({}));
      $('corr-out').innerHTML = `<span class="hint">${err?.detail ?? '計算失敗（勾選 ≥2 個數值欄）'}</span>`;
      return null;
    });
  if (!res) return;
  const n = res.cols.length;
  const cell = (v) => {
    const t = Math.max(-1, Math.min(1, v));
    const col = t >= 0 ? `rgba(70,194,224,${Math.abs(t) * 0.9})` : `rgba(255,77,79,${Math.abs(t) * 0.9})`;
    return `<div class="corr-cell" style="background:${col}" title="${v}">${(v * 100).toFixed(0)}</div>`;
  };
  let html = `<div id="corr-grid" style="grid-template-columns:70px repeat(${n},1fr)">`;
  html += '<div></div>' + res.cols.map((c) => `<div class="corr-label" title="${c}">${c.slice(0, 8)}</div>`).join('');
  res.matrix.forEach((row, i) => {
    html += `<div class="corr-label" title="${res.cols[i]}">${res.cols[i].slice(0, 10)}</div>` + row.map(cell).join('');
  });
  html += '</div>';
  html += `<p class="hint">皮爾森 r ×100（藍正紅負）｜計算樣本 ${res.n_used.toLocaleString()} 列（已排除剔除項）</p>`;
  $('corr-out').innerHTML = html;
});

// ---------------------------------------------------------------- CoolProp
async function refreshPropsCols() {
  const fluids = await fetch('/api/data/props/fluids').then((r) => r.json());
  $('props-fluid').innerHTML = fluids.map((f) => `<option>${f}</option>`).join('');
  const numeric = columns.filter((c) => c.dtype.startsWith('float') || c.dtype.startsWith('int'));
  const opts = '<option value="">—</option>' + numeric.map((c) => `<option>${c.name}</option>`).join('');
  $('props-tcol').innerHTML = '<option value="">溫度欄位…</option>' + numeric.map((c) => `<option>${c.name}</option>`).join('');
  $('props-pcol').innerHTML = '<option value="">壓力欄位（選填）…</option>' + numeric.map((c) => `<option>${c.name}</option>`).join('');
}

function propsBody(mark = false) {
  return {
    fluid: $('props-fluid').value,
    t_col: $('props-tcol').value,
    t_unit: $('props-tunit').value,
    p_col: $('props-pcol').value || null,
    p_unit: $('props-punit').value,
    mark,
  };
}

$('btn-props-check').addEventListener('click', async () => {
  if (!$('props-tcol').value) { alert('請選溫度欄位'); return; }
  const res = await fetch(`/api/data/${sid}/props/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(propsBody(true)),
  }).then((r) => r.json());
  const okT = res.out_of_T_range === 0;
  $('props-out').innerHTML = `<div class="props-result">
    ${res.fluid}｜物理溫度範圍 ${(res.T_range_K[0] - 273.15).toFixed(0)}～${(res.T_range_K[1] - 273.15).toFixed(0)} °C<br>
    超出溫度範圍：<span class="${okT ? 'good' : 'bad'}">${res.out_of_T_range} 筆</span><br>
    ${res.out_of_P_range !== undefined ? `超出壓力範圍（P_crit ${res.P_crit_bar} bar）：<span class="${res.out_of_P_range === 0 ? 'good' : 'bad'}">${res.out_of_P_range} 筆</span><br>` : ''}
    ${res.marked !== undefined ? `已標記剔除 ${res.marked} 筆（原因：物理不合理）` : ''}
  </div>`;
  loadSeries();
});

$('btn-props-derive').addEventListener('click', async () => {
  if (!$('props-tcol').value) { alert('請選溫度欄位'); return; }
  const res = await fetch(`/api/data/${sid}/props/derive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(propsBody()),
  }).then((r) => r.json());
  if (res.new_columns) {
    columns = res.columns;
    renderColumns();
    refreshPropsCols();
    $('props-out').innerHTML = `<div class="props-result">已新增物性欄位：<br>${res.new_columns.join('<br>')}</div>`;
  }
});

refreshPropsCols(); // 流體清單頁載即取
