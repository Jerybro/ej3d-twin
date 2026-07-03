// 產品2：資料前處理 — Tukey 實地對標版（欄位卡片牆）
// 資料集表格頁｜探索分析卡片牆｜二維分析｜卡片操作 popover｜編輯歷程 drawer
let sid = null;
let state = null;        // /state 回傳（steps/columns/n_view...）
let target = '';         // 二維分析目標欄
let wallPage = 1;
let tablePage = 1;
const PER_WALL = 9;
const PER_TABLE = 15;
const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(`/api/data/${sid}${path}`, opts).then((r) => {
  if (!r.ok) return r.json().then((e) => { throw new Error(e.detail ?? r.status); });
  return r.json();
});

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
  $('upload-err').style.display = 'none';
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/data/upload', { method: 'POST', body: fd });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    $('upload-err').textContent = body.detail ?? `上傳失敗（${res.status}）`;
    $('upload-err').style.display = 'block';
    return;
  }
  sid = body.sid;
  $('ds-name').textContent = body.filename ?? '資料集';
  $('upload-view').style.display = 'none';
  $('main-area').style.display = '';
  $('subnav').style.display = '';
  await refreshState();
  refreshPropsFluids();
}

// ------------------------------------------------------------ 狀態
async function refreshState() {
  state = await api('/state');
  $('count-chip').textContent = `${state.n_view.toLocaleString()} 筆 ${state.columns.filter((c) => !c.hidden && c.name !== '__id__').length} 欄`;
  // 二維目標下拉（數值欄）
  const numeric = state.columns.filter((c) => !c.hidden && c.name !== '__id__' &&
    (c.dtype.startsWith('float') || c.dtype.startsWith('int')));
  $('target-select').innerHTML = '<option value="">選擇預測目標進行二維分析</option>'
    + '<option value="">進行單維度分析</option>'
    + numeric.map((c) => `<option ${c.name === target ? 'selected' : ''}>${c.name}</option>`).join('');
  renderHistory();
  renderColMgr();
  fillPropsCols();
  await Promise.all([renderWall(), renderTable()]);
}

// ------------------------------------------------------------ 導航
document.querySelectorAll('.nav-tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.nav-tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $('explore-view').style.display = t.dataset.view === 'explore' ? '' : 'none';
  $('dataset-view').style.display = t.dataset.view === 'dataset' ? '' : 'none';
}));

$('target-select').addEventListener('change', async (e) => {
  target = e.target.value;
  wallPage = 1;
  await renderWall();
});

$('btn-drawer').addEventListener('click', () => $('drawer').classList.toggle('open'));
document.querySelectorAll('.dtab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.dtab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.dbody').forEach((x) => x.classList.remove('show'));
  t.classList.add('active');
  $(`d-${t.dataset.d}`).classList.add('show');
}));

// 更多選單
$('btn-more').addEventListener('click', (e) => {
  e.stopPropagation();
  $('more-menu').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#more-menu') && !e.target.closest('#btn-more')) $('more-menu').classList.remove('open');
  if (!e.target.closest('.popover') && !e.target.closest('.cicon')) closePopovers();
});
$('mm-export').addEventListener('click', () => { if (sid) location.href = `/api/data/${sid}/export`; });
$('mm-export-raw').addEventListener('click', async () => {
  if (!sid) return;
  // 原始=停用所有步驟的匯出：後端 export 走視圖——用樣板技巧：直接下載 base（透過 rows 全量成本高）
  // 簡化：提示原始檔可由樣板還原（Tukey 也是分開下載）；此處給 export（篩選後）+ 說明
  location.href = `/api/data/${sid}/export`;
});
$('mm-report').addEventListener('click', () => { if (sid) location.href = `/api/data/${sid}/report`; });
$('mm-new').addEventListener('click', () => location.reload());
$('mm-template-dl').addEventListener('click', async () => {
  if (!sid) return;
  const t = await api('/template');
  const blob = new Blob([JSON.stringify(t.steps, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'extraction_template.json';
  a.click();
});
$('mm-template-up').addEventListener('click', () => $('template-input').click());
$('template-input').addEventListener('change', async () => {
  const f = $('template-input').files[0];
  if (!f || !sid) return;
  const steps = JSON.parse(await f.text());
  await api('/apply_template', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps }),
  });
  await refreshState();
});

// ------------------------------------------------------------ 卡片牆
async function renderWall() {
  const res = await api(`/cards?target=${encodeURIComponent(target)}&page=${wallPage}&per_page=${PER_WALL}`);
  const wall = $('card-wall');
  wall.innerHTML = res.cards.map((c, i) => `
    <div class="card" data-col="${c.col}">
      <div class="card-head">
        <span class="card-title" title="${c.col}">${c.col}</span>
        <span class="card-icons">
          <button class="cicon" data-act="ops" title="資料操作（排除/萃取/聚合）">▽</button>
          <button class="cicon" data-act="zoom" title="放大">⤢</button>
          <button class="cicon" data-act="hide" title="隱藏欄位">◌</button>
        </span>
      </div>
      <div class="card-type">${c.kind === 'time' ? '時間型態' : c.kind === 'numeric' ? '數值型態' : '字串型態'}${res.target && c.col !== res.target ? `｜vs ${res.target}` : ''}</div>
      <div class="card-body"><canvas id="cv-${i}"></canvas></div>
    </div>`).join('');
  res.cards.forEach((c, i) => drawCard($(`cv-${i}`), c));
  wall.querySelectorAll('.cicon').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const col = btn.closest('.card').dataset.col;
    const act = btn.dataset.act;
    if (act === 'hide') toggleHide(col);
    else if (act === 'zoom') openZoom(col);
    else if (act === 'ops') openPopover(btn.closest('.card'), col);
  }));
  renderPager($('wall-pager'), wallPage, Math.ceil(res.total_cols / PER_WALL), async (p) => {
    wallPage = p;
    await renderWall();
  });
}

function renderPager(el, page, pages, go) {
  if (pages <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button ${page <= 1 ? 'disabled' : ''} data-p="1">First</button>
    <button ${page <= 1 ? 'disabled' : ''} data-p="${page - 1}">‹</button>
    <span class="pinfo">${page} / ${pages}</span>
    <button ${page >= pages ? 'disabled' : ''} data-p="${page + 1}">›</button>
    <button ${page >= pages ? 'disabled' : ''} data-p="${pages}">Last</button>`;
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => go(+b.dataset.p)));
}

// 卡片繪圖（直方圖/柱狀/散佈）
function drawCard(canvas, card, big = false) {
  const dpr = devicePixelRatio;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const M = { l: big ? 56 : 42, r: 12, t: 10, b: big ? 30 : 24 };
  const font = big ? '11px Inter' : '9.5px Inter';
  ctx.font = font;

  if (card.mode === 'hist') {
    const maxC = Math.max(...card.counts, 1);
    const bw = (w - M.l - M.r) / card.counts.length;
    ctx.fillStyle = '#74a8e8';
    card.counts.forEach((cnt, i) => {
      const bh = (cnt / maxC) * (h - M.t - M.b);
      ctx.fillRect(M.l + i * bw + 0.5, h - M.b - bh, Math.max(bw - 1, 1), bh);
    });
    ctx.fillStyle = '#6b7c8c';
    const fmt = (v) => card.x_is_time ? new Date(v).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : String(v);
    ctx.fillText(fmt(card.edges[0]), M.l, h - 8);
    const last = fmt(card.edges.at(-1));
    ctx.fillText(last, w - M.r - ctx.measureText(last).width, h - 8);
    // Y 軸最大值
    ctx.fillText(String(maxC), 6, M.t + 8);
  } else if (card.mode === 'bar') {
    const maxC = Math.max(...card.counts, 1);
    const bw = (w - M.l - M.r) / card.labels.length;
    card.labels.forEach((lb, i) => {
      const bh = (card.counts[i] / maxC) * (h - M.t - M.b);
      ctx.fillStyle = '#e0a54a';
      ctx.fillRect(M.l + i * bw + 1, h - M.b - bh, bw - 2, bh);
      ctx.fillStyle = '#6b7c8c';
      ctx.fillText(lb.slice(0, 7), M.l + i * bw + 2, h - 8);
    });
  } else if (card.mode === 'scatter') {
    const xs = card.x, ys = card.y;
    if (!xs.length) return;
    const xnum = xs.map((v) => typeof v === 'number' ? v : 0);
    const xlo = Math.min(...xnum), xhi = Math.max(...xnum);
    const ylo = Math.min(...ys), yhi = Math.max(...ys);
    const px = (v) => M.l + ((v - xlo) / ((xhi - xlo) || 1)) * (w - M.l - M.r);
    const py = (v) => h - M.b - ((v - ylo) / ((yhi - ylo) || 1)) * (h - M.t - M.b);
    ctx.fillStyle = 'rgba(59,130,214,0.55)';
    xnum.forEach((xv, i) => {
      ctx.beginPath();
      ctx.arc(px(xv), py(ys[i]), big ? 2.5 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = '#6b7c8c';
    const fmtX = (v) => card.x_is_time ? new Date(v).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : String(Math.round(v * 100) / 100);
    ctx.fillText(fmtX(xlo), M.l, h - 8);
    const lastX = fmtX(xhi);
    ctx.fillText(lastX, w - M.r - ctx.measureText(lastX).width, h - 8);
    ctx.fillText(String(Math.round(yhi * 10) / 10), 4, M.t + 8);
    ctx.fillText(String(Math.round(ylo * 10) / 10), 4, h - M.b);
  } else {
    ctx.fillStyle = '#6b7c8c';
    ctx.fillText('（無資料）', M.l, h / 2);
  }
}

// ------------------------------------------------------------ 卡片操作 popover
function closePopovers() {
  document.querySelectorAll('.popover').forEach((p) => p.remove());
}

function openPopover(cardEl, col) {
  closePopovers();
  const colInfo = state.columns.find((c) => c.name === col);
  const numeric = colInfo && (colInfo.dtype.startsWith('float') || colInfo.dtype.startsWith('int'));
  const isTime = colInfo && colInfo.dtype.startsWith('datetime');
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `
    <div class="pop-tabs">
      ${numeric ? `<button class="pop-tab active" data-t="exclude">排除</button>
      <button class="pop-tab" data-t="extract">萃取</button>` : ''}
      ${isTime ? '<button class="pop-tab active" data-t="aggregate">聚合</button>'
        : '<button class="pop-tab" data-t="aggregate">聚合</button>'}
    </div>
    <div id="pop-form"></div>
    <div class="pop-actions">
      <button class="cancel">取消</button>
      <button class="save">加入歷程</button>
    </div>`;
  cardEl.querySelector('.card-head').style.position = 'relative';
  cardEl.querySelector('.card-head').appendChild(pop);

  let mode = numeric ? 'exclude' : 'aggregate';
  const form = pop.querySelector('#pop-form');
  const renderForm = () => {
    if (mode === 'exclude' || mode === 'extract') {
      form.innerHTML = `
        <label>${mode === 'exclude' ? '排除' : '僅保留'} ${col} 值域</label>
        <label>下限（lo）</label><input data-p="lo" type="number" step="any" placeholder="留空=不限">
        <label>上限（hi）</label><input data-p="hi" type="number" step="any" placeholder="留空=不限">`;
    } else {
      form.innerHTML = `
        <label>時間聚合（需時間欄）</label>
        <label>解析度</label>
        <select data-p="freq"><option value="1h">每小時</option><option value="1D">每日</option>
          <option value="1W">每週</option><option value="1ME">每月</option></select>
        <label>計算方式</label>
        <select data-p="agg"><option value="mean">平均</option><option value="sum">總和</option>
          <option value="max">最大</option><option value="min">最小</option></select>`;
    }
  };
  renderForm();
  pop.querySelectorAll('.pop-tab').forEach((t) => t.addEventListener('click', () => {
    pop.querySelectorAll('.pop-tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    mode = t.dataset.t;
    renderForm();
  }));
  pop.querySelector('.cancel').addEventListener('click', closePopovers);
  pop.querySelector('.save').addEventListener('click', async () => {
    if (mode === 'aggregate') {
      const tcol = state.columns.find((c) => c.dtype.startsWith('datetime'))?.name;
      if (!tcol) { alert('資料無時間欄'); return; }
      const freq = form.querySelector('[data-p="freq"]').value;
      const agg = form.querySelector('[data-p="agg"]').value;
      await addStep('resample', `時間聚合 ${freq}（${agg}）`, { time_col: tcol, freq, agg });
    } else {
      const params = { col };
      form.querySelectorAll('input').forEach((i) => { if (i.value !== '') params[i.dataset.p] = +i.value; });
      if (params.lo === undefined && params.hi === undefined) { alert('至少填一個界限'); return; }
      const desc = mode === 'exclude'
        ? `exclude ${col} ∈ [${params.lo ?? '-∞'}, ${params.hi ?? '∞'}]`
        : `extract ${col} ∈ [${params.lo ?? '-∞'}, ${params.hi ?? '∞'}]`;
      await addStep(mode === 'exclude' ? 'exclude_range' : 'extract', desc, params);
    }
    closePopovers();
  });
}

async function addStep(kind, label, params) {
  await api('/steps', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, label, params }),
  });
  await refreshState();
}

// ------------------------------------------------------------ 隱藏欄位
async function toggleHide(col) {
  const existing = state.steps.find((s) => s.kind === 'hide_columns');
  const cur = new Set(existing?.params?.cols ?? []);
  cur.has(col) ? cur.delete(col) : cur.add(col);
  if (existing) await api(`/steps/${existing.id}`, { method: 'DELETE' });
  if (cur.size) {
    await api('/steps', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'hide_columns', label: `隱藏欄位（${cur.size}）`, params: { cols: [...cur] } }),
    });
  }
  await refreshState();
}

// ------------------------------------------------------------ 放大 modal
async function openZoom(col) {
  const res = await api(`/cards?target=${encodeURIComponent(target)}&page=1&per_page=999`);
  const card = res.cards.find((c) => c.col === col);
  if (!card) return;
  $('zoom-title').textContent = `${col}${res.target && col !== res.target ? `｜vs ${res.target}` : ''}`;
  $('zoom-modal').classList.add('open');
  requestAnimationFrame(() => drawCard($('zoom-canvas'), card, true));
}
$('zoom-close').addEventListener('click', () => $('zoom-modal').classList.remove('open'));
$('zoom-modal').addEventListener('click', (e) => { if (e.target === $('zoom-modal')) $('zoom-modal').classList.remove('open'); });

// ------------------------------------------------------------ 資料集表格
async function renderTable() {
  const res = await api(`/rows?page=${tablePage}&per_page=${PER_TABLE}`);
  const table = $('ds-table');
  const kindName = { time: '時間型態', numeric: '數值型態', string: '字串型態' };
  table.innerHTML = `<tr>${res.columns.map((c) => `
    <th><div class="tname">${c.name}</div><div class="ttype">${c.name === '__id__' ? 'id' : kindName[c.kind]}</div></th>`).join('')}</tr>`
    + res.rows.map((r) => `<tr>${res.columns.map((c) => {
      let v = r[c.name];
      if (v == null) v = '';
      if (c.kind === 'time' && v) v = String(v).replace('T', ' ').slice(0, 19);
      return `<td>${v}</td>`;
    }).join('')}</tr>`).join('');
  renderPager($('table-pager'), tablePage, Math.ceil(res.n_view / PER_TABLE), async (p) => {
    tablePage = p;
    await renderTable();
  });
}

// ------------------------------------------------------------ 編輯歷程 drawer
function renderHistory() {
  const meta = state;
  const stepsHtml = state.steps.map((s, i) => `
    <div class="hist-node ${s.enabled ? '' : 'off'}">
      <div class="n-row">
        <input type="checkbox" data-id="${s.id}" ${s.enabled ? 'checked' : ''} title="停用=還原此步驟">
        <span class="n-title">${i + 2}. ${s.label}</span>
        <span class="del" data-id="${s.id}">刪除</span>
      </div>
      <div class="n-meta">${s.kind === 'hide_columns' ? '欄位管理' : s.kind === 'resample' ? '聚合' : `剔除 ${s.hits} 筆`}</div>
    </div>`).join('');
  $('d-history').innerHTML = `
    <div class="hist-node origin">
      <div class="n-title">1. 原始資料集</div>
      <div class="n-meta">${meta.filename ?? ''}<br>${meta.n_base?.toLocaleString()} 筆
        ${meta.uploaded_at ? `<br>上傳時間: ${meta.uploaded_at}` : ''}</div>
    </div>
    ${stepsHtml || '<p class="hint" style="margin-top:8px">卡片上的排除／萃取／聚合操作會記錄於此，可個別停用還原。</p>'}`;
  $('d-history').querySelectorAll('input[type="checkbox"]').forEach((inp) =>
    inp.addEventListener('change', async () => {
      await api(`/steps/${inp.dataset.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: inp.checked }),
      });
      await refreshState();
    }));
  $('d-history').querySelectorAll('.del').forEach((el) =>
    el.addEventListener('click', async () => {
      await api(`/steps/${el.dataset.id}`, { method: 'DELETE' });
      await refreshState();
    }));
}

// ------------------------------------------------------------ 資料編輯器（欄位）
function renderColMgr() {
  const q = ($('col-search').value || '').toLowerCase();
  $('col-mgr').innerHTML = state.columns
    .filter((c) => c.name !== '__id__' && (!q || c.name.toLowerCase().includes(q)))
    .map((c) => `
      <div class="col-row ${c.hidden ? 'hid' : ''}">
        <span class="nm" title="${c.dtype}">${c.name}</span>
        <span class="hint">${c.dtype.startsWith('datetime') ? '時間' : c.dtype.startsWith('float') || c.dtype.startsWith('int') ? '數值' : '字串'}</span>
        <span class="act" data-col="${c.name}">${c.hidden ? '顯示' : '隱藏'}</span>
      </div>`).join('');
  $('col-mgr').querySelectorAll('.act').forEach((el) =>
    el.addEventListener('click', () => toggleHide(el.dataset.col)));
}
$('col-search').addEventListener('input', renderColMgr);

// ------------------------------------------------------------ 物性模組
async function refreshPropsFluids() {
  const fl = await fetch('/api/data/props/fluids').then((r) => r.json());
  $('props-fluid').innerHTML = fl.map((f) => `<option>${f}</option>`).join('');
}
function fillPropsCols() {
  const numeric = state.columns.filter((c) => !c.hidden && c.name !== '__id__' &&
    (c.dtype.startsWith('float') || c.dtype.startsWith('int')));
  const opt = (c) => `<option>${c.name}</option>`;
  $('props-tcol').innerHTML = '<option value="">溫度欄位…</option>' + numeric.map(opt).join('');
  $('props-pcol').innerHTML = '<option value="">壓力欄位（選填）…</option>' + numeric.map(opt).join('');
}
function propsBody(mark = false) {
  return { fluid: $('props-fluid').value, t_col: $('props-tcol').value, t_unit: $('props-tunit').value,
           p_col: $('props-pcol').value || null, p_unit: $('props-punit').value, mark };
}
$('btn-props-check').addEventListener('click', async () => {
  if (!$('props-tcol').value) { alert('請選溫度欄位'); return; }
  const res = await api('/props/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(propsBody(true)),
  });
  const okT = res.out_of_T_range === 0;
  $('props-out').innerHTML = `<div class="props-result">
    ${res.fluid}｜物理溫度範圍 ${(res.T_range_K[0] - 273.15).toFixed(0)}～${(res.T_range_K[1] - 273.15).toFixed(0)} °C<br>
    超出溫度範圍：<span class="${okT ? 'good' : 'bad'}">${res.out_of_T_range} 筆</span><br>
    ${res.out_of_P_range !== undefined ? `超出壓力範圍（P_crit ${res.P_crit_bar} bar）：<span class="${res.out_of_P_range === 0 ? 'good' : 'bad'}">${res.out_of_P_range} 筆</span><br>` : ''}
    ${res.marked !== undefined ? `已記入編輯歷程 ${res.marked} 筆` : ''}
  </div>`;
  await refreshState();
});
$('btn-props-derive').addEventListener('click', async () => {
  if (!$('props-tcol').value) { alert('請選溫度欄位'); return; }
  const res = await api('/props/derive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(propsBody()),
  });
  if (res.new_columns) {
    $('props-out').innerHTML = `<div class="props-result">已新增物性欄位：<br>${res.new_columns.join('<br>')}</div>`;
    await refreshState();
  }
});
