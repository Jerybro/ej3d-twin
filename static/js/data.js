// 產品2：資料前處理 — Tukey 對標版
// 編輯歷程 steps pipeline / 單雙變量自動圖表 / 框選剔除 / 健檢 / 報表 / CoolProp
let sid = null;
let columns = [];
let seriesData = null;
let stepsState = [];
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
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/data/upload', { method: 'POST', body: fd });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`上傳失敗：${err.detail ?? res.status}`);
    return;
  }
  const info = await res.json();
  sid = info.sid;
  $('file-meta').innerHTML = `${info.filename}<br>${info.n_rows.toLocaleString()} 列 × ${info.columns.length} 欄`;
  $('col-search').style.display = '';
  for (const id of ['btn-export', 'btn-report', 'btn-add-rule', 'btn-agg', 'btn-bi',
                    'btn-corr', 'btn-health', 'btn-props-check', 'btn-props-derive']) $(id).disabled = false;
  await refreshState();
  refreshPropsCols();
}

// ------------------------------------------------------ 狀態（steps 重放結果）
async function refreshState() {
  const st = await fetch(`/api/data/${sid}/state`).then((r) => r.json());
  columns = st.columns;
  stepsState = st.steps;
  $('stat-chip').innerHTML = `保留 <b>${st.n_view.toLocaleString()}</b>｜剔除 ${st.excluded.toLocaleString()}｜共 ${st.n_base.toLocaleString()}`;
  renderColumns();
  renderSteps();
  fillSelects();
  await loadSeries();
}

// ---------------------------------------------------------------- 欄位清單
let healthWarns = {};
function renderColumns() {
  const q = ($('col-search').value || '').toLowerCase();
  const checked = new Set(checkedCols());
  $('col-list').innerHTML = columns
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .map((c) => {
      const numeric = c.dtype.startsWith('float') || c.dtype.startsWith('int');
      return `<div class="col-item ${c.hidden ? 'is-hidden' : ''}">
        ${numeric ? `<input type="checkbox" data-col="${c.name}" ${checked.has(c.name) ? 'checked' : ''}>` : '<span style="width:13px"></span>'}
        ${healthWarns[c.name] ? '<span class="warn-dot" title="健檢警告"></span>' : ''}
        <span class="cname" data-col="${c.name}" title="${c.dtype}｜點擊看分布">${c.name}</span>
        <span class="hide-btn" data-col="${c.name}">${c.hidden ? '顯示' : '隱藏'}</span>
      </div>`;
    }).join('');
  $('col-list').querySelectorAll('input').forEach((inp) => inp.addEventListener('change', loadSeries));
  $('col-list').querySelectorAll('.cname').forEach((el) =>
    el.addEventListener('click', () => showHist(el.dataset.col)));
  $('col-list').querySelectorAll('.hide-btn').forEach((el) =>
    el.addEventListener('click', () => toggleHide(el.dataset.col)));
}
$('col-search').addEventListener('input', renderColumns);

async function toggleHide(col) {
  // 隱藏欄位以單一 hide_columns 步驟維護（Tukey 資料編輯器同款）
  const existing = stepsState.find((s) => s.kind === 'hide_columns');
  const cur = new Set(existing?.params?.cols ?? []);
  cur.has(col) ? cur.delete(col) : cur.add(col);
  if (existing) await fetch(`/api/data/${sid}/steps/${existing.id}`, { method: 'DELETE' });
  if (cur.size) {
    await fetch(`/api/data/${sid}/steps`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'hide_columns', label: `隱藏欄位（${cur.size}）`, params: { cols: [...cur] } }),
    });
  }
  await refreshState();
}

const checkedCols = () =>
  [...$('col-list').querySelectorAll('input:checked')].map((i) => i.dataset.col);

function fillSelects() {
  const numeric = columns.filter((c) => !c.hidden && (c.dtype.startsWith('float') || c.dtype.startsWith('int')));
  const all = columns.filter((c) => !c.hidden);
  const opt = (c) => `<option>${c.name}</option>`;
  $('rule-col').innerHTML = '<option value="">欄位…</option>' + numeric.map(opt).join('');
  $('bi-x').innerHTML = '<option value="">X 欄位…</option>' + all.map(opt).join('');
  $('bi-y').innerHTML = '<option value="">Y 欄位…</option>' + all.map(opt).join('');
  $('props-tcol').innerHTML = '<option value="">溫度欄位…</option>' + numeric.map(opt).join('');
  $('props-pcol').innerHTML = '<option value="">壓力欄位（選填）…</option>' + numeric.map(opt).join('');
  renderRuleParams();
}

// ------------------------------------------------------------ 編輯歷程
function renderSteps() {
  $('step-list').innerHTML = stepsState.length ? stepsState.map((s) => `
    <div class="step-row ${s.enabled ? '' : 'off'}">
      <input type="checkbox" data-id="${s.id}" ${s.enabled ? 'checked' : ''} title="停用=還原此步驟">
      <span class="lbl">${s.label}</span>
      <span class="hits">${s.kind === 'hide_columns' ? '' : `−${s.hits}`}</span>
      <span class="del" data-id="${s.id}">刪除</span>
    </div>`).join('')
    : '<span class="hint">清理動作會記錄於此，可個別停用還原（同一份資料、不同歷程）</span>';
  $('step-list').querySelectorAll('input').forEach((inp) =>
    inp.addEventListener('change', async () => {
      await fetch(`/api/data/${sid}/steps/${inp.dataset.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: inp.checked }),
      });
      await refreshState();
    }));
  $('step-list').querySelectorAll('.del').forEach((el) =>
    el.addEventListener('click', async () => {
      await fetch(`/api/data/${sid}/steps/${el.dataset.id}`, { method: 'DELETE' });
      await refreshState();
    }));
}

async function addStep(kind, label, params) {
  await fetch(`/api/data/${sid}/steps`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, label, params }),
  });
  await refreshState();
}

// 規則編輯器
const RULE_PARAMS = {
  range: ['lo', 'hi'], jump: ['max_abs'], jump_pct: ['max_pct'],
  quantile: ['lo_q', 'hi_q'], flatline: ['min_run'],
};
function renderRuleParams() {
  const kind = $('rule-kind').value;
  $('rule-params').innerHTML = RULE_PARAMS[kind].map((p) =>
    `<input data-p="${p}" type="number" step="any" placeholder="${p}">`).join('');
}
$('rule-kind').addEventListener('change', renderRuleParams);
$('btn-add-rule').addEventListener('click', () => {
  const kind = $('rule-kind').value;
  const col = $('rule-col').value;
  if (!col) { alert('請選欄位'); return; }
  const params = { col };
  $('rule-params').querySelectorAll('input').forEach((i) => { if (i.value !== '') params[i.dataset.p] = +i.value; });
  const kindName = $('rule-kind').selectedOptions[0].textContent;
  addStep(kind, `${kindName}：${col}`, params);
});

// 時間聚合
$('btn-agg').addEventListener('click', () => {
  const freq = $('agg-freq').value;
  if (!freq) { alert('請選解析度'); return; }
  const tcol = columns.find((c) => c.dtype.startsWith('datetime'))?.name;
  if (!tcol) { alert('資料無時間欄位'); return; }
  const agg = $('agg-fn').value;
  addStep('resample', `時間聚合 ${freq}（${agg}）`, { time_col: tcol, freq, agg });
});

// ---------------------------------------------------------------- 主圖
async function loadSeries() {
  const cols = checkedCols();
  if (!sid || !cols.length) { seriesData = null; draw(); return; }
  seriesData = await fetch(`/api/data/${sid}/series?cols=${encodeURIComponent(cols.join(','))}`)
    .then((r) => r.json()).catch(() => null);
  selectedRows.clear();
  updateSelButtons();
  draw();
}

const canvas = $('chart');
const ctx = canvas.getContext('2d');
const M = { l: 60, r: 16, t: 24, b: 30 };
let dragBox = null;

function fitCanvas(cv, c2) {
  const w = cv.parentElement.clientWidth, h = cv.parentElement.clientHeight;
  cv.width = w * devicePixelRatio;
  cv.height = h * devicePixelRatio;
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  c2.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
new ResizeObserver(() => { fitCanvas(canvas, ctx); draw(); }).observe(canvas.parentElement);

function draw() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  $('chart-hint').style.display = seriesData ? 'none' : '';
  if (!seriesData) return;
  const cols = Object.keys(seriesData.cols);
  const n = seriesData.x.length;
  if (!n) return;
  const px = (i) => M.l + (i / Math.max(n - 1, 1)) * (w - M.l - M.r);
  cols.forEach((c, ci) => {
    const vals = seriesData.cols[c];
    const nums = vals.filter((v) => v != null);
    if (!nums.length) return;
    const lo = Math.min(...nums), hi = Math.max(...nums);
    const span = hi - lo || 1;
    const py = (v) => h - M.b - ((v - lo) / span) * (h - M.t - M.b);
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
    vals.forEach((v, i) => {
      if (v == null) return;
      const row = seriesData.row_idx[i];
      const ex = seriesData.excluded[i];
      const sel = selectedRows.has(row);
      if (!ex && !sel && n > 1500) return;
      ctx.fillStyle = ex ? '#ff4d4f' : sel ? '#ffe14d' : PALETTE[ci % PALETTE.length];
      ctx.beginPath();
      ctx.arc(px(i), py(v), ex || sel ? 3 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = PALETTE[ci % PALETTE.length];
    ctx.fillRect(M.l + ci * 140, 8, 10, 10);
    ctx.fillStyle = '#dbe5ee';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText(`${c}（${lo.toFixed(1)}~${hi.toFixed(1)}）`, M.l + ci * 140 + 14, 17);
  });
  if (dragBox) {
    ctx.strokeStyle = '#ffe14d';
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(dragBox[0], dragBox[1], dragBox[2] - dragBox[0], dragBox[3] - dragBox[1]);
    ctx.setLineDash([]);
  }
}

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
      if (X >= box[0] && X <= box[2] && Y >= box[1] && Y <= box[3]) selectedRows.add(seriesData.row_idx[i]);
    });
  }
  updateSelButtons();
}

function updateSelButtons() {
  const has = selectedRows.size > 0;
  $('btn-exclude').disabled = !has;
  $('btn-clear-sel').disabled = !has;
  $('btn-exclude').textContent = has ? `剔除圈選（${selectedRows.size}）` : '剔除圈選';
}

$('btn-clear-sel').addEventListener('click', () => { selectedRows.clear(); updateSelButtons(); draw(); });
$('btn-exclude').addEventListener('click', async () => {
  await addStep('manual_exclude', `手動圈選剔除（${selectedRows.size} 筆）`, { rows: [...selectedRows] });
  selectedRows.clear();
  updateSelButtons();
});
$('btn-export').addEventListener('click', () => { location.href = `/api/data/${sid}/export`; });
$('btn-report').addEventListener('click', () => { location.href = `/api/data/${sid}/report`; });

// ------------------------------------------------------------ 下方 detail 圖
const detail = $('detail');
const dctx = detail.getContext('2d');
new ResizeObserver(() => fitCanvas(detail, dctx)).observe(detail.parentElement);

function clearDetail(title) {
  fitCanvas(detail, dctx);
  dctx.clearRect(0, 0, detail.clientWidth, detail.clientHeight);
  $('detail-title').textContent = title;
}

async function showHist(col) {
  const res = await fetch(`/api/data/${sid}/hist?col=${encodeURIComponent(col)}`).then((r) => r.json()).catch(() => null);
  if (!res || res.type === 'empty') { clearDetail(`${col}：無資料`); return; }
  const w = detail.clientWidth, h = detail.clientHeight;
  const Mm = { l: 50, r: 16, t: 28, b: 24 };
  if (res.type === 'hist') {
    clearDetail(`${col}｜直方圖｜均值 ${res.stats.mean}・std ${res.stats.std}・遺漏 ${res.stats.missing_pct}%`);
    const maxC = Math.max(...res.counts);
    const bw = (w - Mm.l - Mm.r) / res.counts.length;
    dctx.fillStyle = '#46c2e0';
    res.counts.forEach((cnt, i) => {
      const bh = (cnt / maxC) * (h - Mm.t - Mm.b);
      dctx.fillRect(Mm.l + i * bw + 1, h - Mm.b - bh, bw - 2, bh);
    });
    dctx.fillStyle = '#8ba0b3';
    dctx.font = '10px Inter';
    dctx.fillText(String(res.edges[0]), Mm.l, h - 8);
    dctx.fillText(String(res.edges.at(-1)), w - Mm.r - 40, h - 8);
  } else if (res.type === 'bar') {
    clearDetail(`${col}｜類別分布（前 ${res.labels.length}）`);
    const maxC = Math.max(...res.counts);
    const bw = (w - Mm.l - Mm.r) / res.labels.length;
    res.labels.forEach((lb, i) => {
      const bh = (res.counts[i] / maxC) * (h - Mm.t - Mm.b);
      dctx.fillStyle = '#ffaa3c';
      dctx.fillRect(Mm.l + i * bw + 2, h - Mm.b - bh, bw - 4, bh);
      dctx.fillStyle = '#8ba0b3';
      dctx.font = '10px Inter';
      dctx.save();
      dctx.translate(Mm.l + i * bw + bw / 2, h - 10);
      dctx.fillText(lb.slice(0, 10), -dctx.measureText(lb.slice(0, 10)).width / 2, 0);
      dctx.restore();
    });
  }
}

$('btn-bi').addEventListener('click', async () => {
  const x = $('bi-x').value, y = $('bi-y').value;
  if (!x || !y) { alert('請選 X 與 Y'); return; }
  const res = await fetch(`/api/data/${sid}/bivariate?x=${encodeURIComponent(x)}&y=${encodeURIComponent(y)}`)
    .then((r) => { if (!r.ok) throw 0; return r.json(); }).catch(() => null);
  if (!res) { clearDetail('雙變量繪製失敗'); return; }
  const w = detail.clientWidth, h = detail.clientHeight;
  const Mm = { l: 56, r: 16, t: 28, b: 26 };
  if (res.type === 'scatter') {
    clearDetail(`${x} × ${y}｜散佈圖（${res.x.length} 點）`);
    const xs = res.x, ys = res.y;
    const xlo = Math.min(...xs), xhi = Math.max(...xs), ylo = Math.min(...ys), yhi = Math.max(...ys);
    const pxf = (v) => Mm.l + ((v - xlo) / ((xhi - xlo) || 1)) * (w - Mm.l - Mm.r);
    const pyf = (v) => h - Mm.b - ((v - ylo) / ((yhi - ylo) || 1)) * (h - Mm.t - Mm.b);
    dctx.fillStyle = 'rgba(70,194,224,0.55)';
    xs.forEach((xv, i) => {
      dctx.beginPath();
      dctx.arc(pxf(xv), pyf(ys[i]), 2, 0, Math.PI * 2);
      dctx.fill();
    });
  } else if (res.type === 'box') {
    clearDetail(`${res.cat} × ${res.num}｜箱型圖（${res.groups.length} 組）`);
    const g = res.groups;
    const lo = Math.min(...g.map((v) => v.min)), hi = Math.max(...g.map((v) => v.max));
    const pyf = (v) => h - Mm.b - ((v - lo) / ((hi - lo) || 1)) * (h - Mm.t - Mm.b);
    const bw = (w - Mm.l - Mm.r) / g.length;
    g.forEach((grp, i) => {
      const cx = Mm.l + i * bw + bw / 2;
      dctx.strokeStyle = '#46c2e0';
      dctx.fillStyle = 'rgba(70,194,224,0.25)';
      dctx.beginPath();
      dctx.moveTo(cx, pyf(grp.min)); dctx.lineTo(cx, pyf(grp.max));
      dctx.stroke();
      const bx = cx - bw * 0.28, bws = bw * 0.56;
      dctx.fillRect(bx, pyf(grp.q3), bws, pyf(grp.q1) - pyf(grp.q3));
      dctx.strokeRect(bx, pyf(grp.q3), bws, pyf(grp.q1) - pyf(grp.q3));
      dctx.strokeStyle = '#ffe14d';
      dctx.beginPath();
      dctx.moveTo(bx, pyf(grp.med)); dctx.lineTo(bx + bws, pyf(grp.med));
      dctx.stroke();
      dctx.fillStyle = '#8ba0b3';
      dctx.font = '10px Inter';
      dctx.fillText(grp.label.slice(0, 8), cx - 16, h - 8);
    });
  }
});

// ---------------------------------------------------------------- Tabs
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tab-body').forEach((x) => x.classList.remove('show'));
  t.classList.add('active');
  $(`tab-${t.dataset.tab}`).classList.add('show');
}));

// ------------------------------------------------------------ 相關分析＋健檢
$('btn-corr').addEventListener('click', async () => {
  const cols = checkedCols();
  const method = $('corr-method').value;
  const res = await fetch(`/api/data/${sid}/corr?cols=${encodeURIComponent(cols.join(','))}&method=${method}`)
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
  html += `</div><p class="hint">${res.method} r ×100（藍正紅負）｜樣本 ${res.n_used.toLocaleString()} 列（清理後）</p>`;
  $('corr-out').innerHTML = html;
});

$('btn-health').addEventListener('click', async () => {
  const res = await fetch(`/api/data/${sid}/health`).then((r) => r.json());
  healthWarns = Object.fromEntries(res.issues.map((i) => [i.col, i.warnings]));
  renderColumns();
  $('health-out').innerHTML = res.issues.length
    ? res.issues.map((i) => `<div class="health-item"><b>${i.col}</b><div class="w">${i.warnings.join('<br>')}</div></div>`).join('')
    : '<span class="hint" style="color:var(--ok)">全欄位通過健檢</span>';
});

// ---------------------------------------------------------------- CoolProp
async function refreshPropsCols() {
  const fl = await fetch('/api/data/props/fluids').then((r) => r.json());
  $('props-fluid').innerHTML = fl.map((f) => `<option>${f}</option>`).join('');
}
function propsBody(mark = false) {
  return { fluid: $('props-fluid').value, t_col: $('props-tcol').value, t_unit: $('props-tunit').value,
           p_col: $('props-pcol').value || null, p_unit: $('props-punit').value, mark };
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
    ${res.marked !== undefined ? `已記入編輯歷程 ${res.marked} 筆（物理不合理）` : ''}
  </div>`;
  await refreshState();
});
$('btn-props-derive').addEventListener('click', async () => {
  if (!$('props-tcol').value) { alert('請選溫度欄位'); return; }
  const res = await fetch(`/api/data/${sid}/props/derive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(propsBody()),
  }).then((r) => r.json());
  if (res.new_columns) {
    $('props-out').innerHTML = `<div class="props-result">已新增物性欄位：<br>${res.new_columns.join('<br>')}</div>`;
    await refreshState();
  }
});
refreshPropsCols();
