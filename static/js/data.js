// 產品2：資料前處理 — Tukey 實地對標版（欄位卡片牆）
// 資料集表格頁｜探索分析卡片牆｜二維分析｜卡片操作 popover｜編輯歷程 drawer
let sid = null;
let state = null;        // /state 回傳（steps/columns/n_view...）
let target = '';         // 二維分析目標欄
let wallPage = 1;
let tablePage = 1;
const PER_WALL = 9;
let perTable = 15;

// SVG stroke icons（Lucide 風，stroke=currentColor）
const IC = (d, extra = '') => `<svg class="ic sm" viewBox="0 0 24 24">${extra}${d.map((p) => `<path d="${p}"/>`).join('')}</svg>`;
const ICONS = {
  funnel: IC(['M22 4H2l8 9.2V19l4 2v-7.8z']),
  zoom: IC(['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7']),
  eyeoff: IC(['M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94', 'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19', 'M14.12 14.12a3 3 0 1 1-4.24-4.24', 'M1 1l22 22']),
  calendar: IC(['M16 2v4', 'M8 2v4', 'M3 10h18'], '<rect x="3" y="4" width="18" height="18" rx="2"/>'),
  hash: IC(['M4 9h16', 'M4 15h16', 'M10 3L8 21', 'M16 3l-2 18']),
  text: IC(['M4 7V5h16v2', 'M12 5v14', 'M9 19h6']),
  key: IC(['M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m3 3L21 8m-3-3l3 3']),
  dots: IC(['M12 5.5v.01', 'M12 12v.01', 'M12 18.5v.01']),
};
const kindIcon = (kind) => kind === 'time' ? ICONS.calendar : kind === 'numeric' ? ICONS.hash : ICONS.text;
const kindName = { time: '時間型態', numeric: '數值型態', string: '字串型態' };
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
  const wantView = new URLSearchParams(location.search).get('view');
  history.replaceState(null, '', `?sid=${body.sid}${wantView ? `&view=${wantView}` : ''}`);
  enterSession(body.sid, body.filename);
}

async function enterSession(newSid, filename) {
  sid = newSid;
  $('upload-view').style.display = 'none';
  $('mysets-view').style.display = 'none';
  $('main-area').style.display = '';
  $('subnav').style.display = '';
  syncNavTabs();
  await refreshState();
  $('ds-name').textContent = filename ?? state.filename ?? '資料集';
  refreshPropsFluids();
  // 首頁應用入口直達（/data?view=model）
  const wantView = new URLSearchParams(location.search).get('view');
  if (wantView) {
    document.querySelector(`.nav-tab[data-view="${wantView}"]`)?.click();
  }
}

// ?sid= 會話還原（重新整理不遺失工作階段）
const urlSid = new URLSearchParams(location.search).get('sid');
if (urlSid) {
  sid = urlSid;
  api('/state').then(() => enterSession(urlSid)).catch(() => { sid = null; syncNavTabs(); renderMySets(); });
} else {
  syncNavTabs();
  renderMySets();
}

// ------------------------------------------------------------ 我的資料集（儲存管理）
// 卡片列：渲染到導航分頁（mysets-list）與上傳頁（mysets-list-up）兩處
const DS_ICON = '<svg viewBox="0 0 24 24"><path d="M4 5h16v4H4z"/><path d="M4 10.5h16v4H4z"/><path d="M4 16h16v4H4z"/><circle cx="7" cy="7" r="0.4"/><circle cx="7" cy="12.5" r="0.4"/><circle cx="7" cy="18" r="0.4"/></svg>';
async function renderMySets() {
  let sets = [];
  try { sets = await fetch('/api/data/sessions').then((r) => (r.ok ? r.json() : [])); } catch { /* 未登入等 */ }
  const meta = (s) => [
    s.n_rows != null ? `${s.n_rows.toLocaleString()} 筆` : null,
    s.n_models ? `${s.n_models} 個模型` : null,
    s.uploaded_at, s.owner ?? '共用',
    s.sid === sid ? '<span class="cur-tag">使用中</span>' : null,
  ].filter(Boolean).join('｜');
  const html = sets.length ? sets.map((s) => `
    <div class="ds-item${s.sid === sid ? ' cur' : ''}">
      <div class="ds-ic">${DS_ICON}</div>
      <div class="ds-info">
        <div class="ds-fn">${escHtml(s.filename ?? s.sid)}</div>
        <div class="ds-meta">${meta(s)}</div>
      </div>
      <div class="ds-acts">
        ${s.sid === sid ? '' : `<a class="pri" href="/data?sid=${s.sid}">開啟</a>`}
        ${s.has_source ? `<a href="/api/data/${s.sid}/source">下載原檔</a>` : ''}
        <button class="dgr ms-del" data-sid="${s.sid}">刪除</button>
      </div>
    </div>`).join('')
    : '<p class="hint">還沒有資料集——上傳第一個 CSV／Excel 開始。</p>';
  ['mysets-list', 'mysets-list-up'].forEach((id) => { const el = $(id); if (el) el.innerHTML = html; });
  if ($('mysets-card')) $('mysets-card').style.display = sets.length ? '' : 'none';
  // 刪除採兩段式確認（不用原生 confirm——會凍住 renderer）
  document.querySelectorAll('.ms-del').forEach((el) => el.addEventListener('click', async () => {
    if (el.dataset.armed !== '1') {
      el.dataset.armed = '1';
      el.textContent = '確認刪除？';
      setTimeout(() => { el.dataset.armed = '0'; el.textContent = '刪除'; }, 3000);
      return;
    }
    const res = await fetch(`/api/data/${el.dataset.sid}`, { method: 'DELETE' });
    if (res.ok) {
      if (el.dataset.sid === sid) { location.href = '/data'; return; }
      await renderMySets();
    } else { el.textContent = (await res.json()).detail ?? '刪除失敗'; }
  }));
}
// 無資料集時只留「我的資料集」分頁（資料集/探索/模型都需要工作階段才有意義）
function syncNavTabs() {
  document.querySelectorAll('.nav-tab[data-view]').forEach((t) => {
    if (t.dataset.view !== 'mysets') t.style.display = sid ? '' : 'none';
  });
}

// ------------------------------------------------------------ 最佳化工作區（多目標配方最佳化）
const OPT = { models: [], median: {}, prec: 'low' };
async function renderOptimize() {
  if (!sid) return;
  const list = await apiML('/models');
  const sel = list.filter((m) => m.status === 'done' && (m.task === 'regression' || m.task === 'hybrid'));
  if (!sel.length) {
    $('opt2-empty').style.display = ''; $('opt2-main').style.display = 'none'; return;
  }
  $('opt2-empty').style.display = 'none'; $('opt2-main').style.display = '';
  // 取各模型完整記錄（features）與中位數（起始值預設）
  OPT.models = await Promise.all(sel.map((m) => apiML(`/models/${m.id}`)));
  OPT.median = {};
  await Promise.all(OPT.models.map(async (m) => {
    try {
      const b = (await apiML(`/models/${m.id}/whatif`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"values":{}}',
      })).baseline;
      Object.entries(b).forEach(([f, v]) => { if (!(f in OPT.median)) OPT.median[f] = v; });
    } catch { /* 忽略 */ }
  }));
  // 初始各一列
  $('opt2-obj-table').innerHTML = `<tr><th>目標模型</th><th>條件</th><th>權重</th><th></th></tr>`;
  $('opt2-knob-table').innerHTML = `<tr><th>可調參數</th><th>搜尋範圍</th><th></th></tr>`;
  if (!$('opt2-obj-table').querySelectorAll('tr[data-row]').length) optAddObj();
  if (!$('opt2-knob-table').querySelectorAll('tr[data-row]').length) optAddKnob();
  optRefreshUnion();
  $('opt2-out').innerHTML = '<p class="hint" style="text-align:center;padding:30px">設定最佳化目標與參數後，點「開始分析」顯示推薦的參數組合。</p>';
}
function optUnionFeatures() {
  const mids = [...$('opt2-obj-table').querySelectorAll('select[data-obj-mid]')].map((s) => s.value);
  const set = new Set();
  OPT.models.filter((m) => mids.includes(m.id)).forEach((m) => (m.features || []).forEach((f) => set.add(f)));
  return [...set].sort();
}
function optAddObj() {
  const opts = OPT.models.map((m) => `<option value="${escHtml(m.id)}">${escHtml(m.name)}（目標 ${escHtml(m.target)}）</option>`).join('');
  const tr = document.createElement('tr');
  tr.dataset.row = '1';
  tr.innerHTML = `
    <td><select data-obj-mid>${opts}</select></td>
    <td><select data-obj-type>
        <option value="range">落在範圍</option><option value="max">最大化</option><option value="min">最小化</option>
      </select>
      <span data-obj-range><input type="number" step="any" data-obj-min placeholder="下限">
      <span class="opt2-cond-op">～</span><input type="number" step="any" data-obj-max placeholder="上限"></span></td>
    <td><input type="number" step="0.5" min="0" data-obj-w value="1" style="width:70px"></td>
    <td><button class="opt2-del" data-obj-del>移除</button></td>`;
  $('opt2-obj-table').appendChild(tr);
  tr.querySelector('[data-obj-type]').addEventListener('change', (e) => {
    tr.querySelector('[data-obj-range]').style.display = e.target.value === 'range' ? '' : 'none';
  });
  tr.querySelector('[data-obj-mid]').addEventListener('change', optRefreshUnion);
  tr.querySelector('[data-obj-del]').addEventListener('click', () => {
    if ($('opt2-obj-table').querySelectorAll('tr[data-row]').length > 1) { tr.remove(); optRefreshUnion(); }
  });
}
function optKnobOptions(feats, cur) {
  // 保留已選；若原選已不在目標特徵聯集，插入停用占位項提示重選（不靜默改成第一個）
  const stale = cur && !feats.includes(cur)
    ? `<option value="" selected disabled>（原選 ${escHtml(cur)} 已不在目標範圍，請重選）</option>` : '';
  return stale + feats.map((f) => `<option value="${escHtml(f)}" ${f === cur ? 'selected' : ''}>${escHtml(f)}</option>`).join('');
}
function optAddKnob() {
  const tr = document.createElement('tr');
  tr.dataset.row = '1';
  tr.innerHTML = `
    <td><select data-knob-name>${optKnobOptions(optUnionFeatures(), null)}</select></td>
    <td><input type="number" step="any" data-knob-lo placeholder="自動下限">
      <span class="opt2-cond-op">～</span><input type="number" step="any" data-knob-hi placeholder="自動上限"></td>
    <td><button class="opt2-del" data-knob-del>移除</button></td>`;
  $('opt2-knob-table').appendChild(tr);
  tr.querySelector('[data-knob-name]').addEventListener('change', optRefreshRef);
  tr.querySelector('[data-knob-del]').addEventListener('click', () => { tr.remove(); optRefreshRef(); });
}
function optRefreshUnion() {
  // 目標變更→更新 knob 下拉候選（保留已選；原選失效時停用占位提示）＋重建起始值表
  const feats = optUnionFeatures();
  $('opt2-knob-table').querySelectorAll('select[data-knob-name]').forEach((s) => {
    s.innerHTML = optKnobOptions(feats, s.value);
  });
  optRefreshRef();
}
function optRefreshRef() {
  const feats = optUnionFeatures();
  const knobs = new Set([...$('opt2-knob-table').querySelectorAll('select[data-knob-name]')].map((s) => s.value));
  const refFeats = feats.filter((f) => !knobs.has(f));
  if (!refFeats.length) {
    $('opt2-ref-table').innerHTML = '<tr><td style="color:var(--text2);font-size:13px">所有特徵都設為可調參數，無其他起始值需設定。</td></tr>';
    return;
  }
  // 保留使用者已手動輸入的起始值（重建 innerHTML 前先快照，優先於中位數）
  const cur = {};
  $('opt2-ref-table').querySelectorAll('input[data-ref]').forEach((i) => { if (i.value !== '') cur[i.dataset.ref] = i.value; });
  $('opt2-ref-table').innerHTML = `<tr>${refFeats.map((f) => `<th>${escHtml(f)}</th>`).join('')}</tr>
    <tr>${refFeats.map((f) => `<td><input type="number" step="any" data-ref="${escHtml(f)}" value="${cur[f] ?? OPT.median[f] ?? ''}" style="width:110px"></td>`).join('')}</tr>`;
}
function optGather() {
  const objectives = [...$('opt2-obj-table').querySelectorAll('tr[data-row]')].map((tr) => {
    const type = tr.querySelector('[data-obj-type]').value;
    const cond = { type };
    if (type === 'range') {
      cond.min = parseFloat(tr.querySelector('[data-obj-min]').value);
      cond.max = parseFloat(tr.querySelector('[data-obj-max]').value);
    }
    const midSel = tr.querySelector('[data-obj-mid]');
    return { mid: midSel.value, name: OPT.models.find((m) => m.id === midSel.value)?.name,
      condition: cond, weight: parseFloat(tr.querySelector('[data-obj-w]').value) || 1 };
  });
  const knobs = [...$('opt2-knob-table').querySelectorAll('tr[data-row]')].map((tr) => {
    const k = { name: tr.querySelector('[data-knob-name]').value };
    const lo = tr.querySelector('[data-knob-lo]').value, hi = tr.querySelector('[data-knob-hi]').value;
    if (lo !== '' && hi !== '') { k.lo = parseFloat(lo); k.hi = parseFloat(hi); }
    return k;
  });
  const reference = {};
  $('opt2-ref-table').querySelectorAll('input[data-ref]').forEach((i) => {
    if (i.value !== '') reference[i.dataset.ref] = parseFloat(i.value);
  });
  return { objectives, knobs, reference, precision: OPT.prec, top_n: 5 };
}
function optRenderResult(r) {
  const kv = (k, v) => `<span class="kv">${escHtml(k)}：<b>${v}</b></span>`;
  const head = `<div class="md-sub" style="margin-bottom:10px">精準度 ${
    { low: '低', med: '中', high: '高' }[r.precision]}｜可行樣本 ${r.feasible_count.toLocaleString()}${
    r.warning ? `｜<span style="color:#B8860B">${escHtml(r.warning)}</span>` : ''}</div>`;
  const note = r.note ? `<div class="opt2-note">${escHtml(r.note)}</div>` : '';
  const cards = r.recommendations.map((rec) => {
    // 目標按位置對應（不用 mid 當鍵——同一模型可作多個不同條件的目標，mid 會覆蓋）
    const rows = rec.objectives.map((ob, i) => {
      const meta = r.objectives[i] || {};
      const cond = meta.type === 'range' ? `範圍 ${meta.min}～${meta.max}`
        : meta.type === 'max' ? '最大化' : '最小化';
      const dCls = ob.desirability < 0.5 ? ' class="d-lo"' : '';
      const inr = ob.in_range === null ? '—' : (ob.in_range ? '✓ 達標' : `✗ 差 ${Math.abs(ob.margin)}`);
      return `<tr><td>${escHtml(ob.name)}</td><td style="color:var(--text2)">${cond}</td>
        <td><b>${ob.pred}</b></td><td${dCls}>${(ob.desirability * 100).toFixed(0)}%</td>
        <td style="color:${ob.in_range === false ? 'var(--danger)' : 'var(--text2)'}">${inr}</td></tr>`;
    }).join('');
    return `<div class="opt2-rec${rec.rank === 1 ? ' best' : ''}">
      <div class="opt2-rec-head"><span class="opt2-rank">${rec.rank}</span>
        <span class="opt2-score">綜合分 <b>${(rec.score * 100).toFixed(0)}</b>／100</span>
        <span class="opt2-badge ${rec.feasible ? 'ok' : 'bad'}">${rec.feasible ? '全目標達標' : '未全達標'}</span></div>
      <div class="opt2-kv">${Object.entries(rec.knobs).map(([k, v]) => kv(k, v)).join('')}</div>
      <table class="opt2-otbl"><tr><th>目標</th><th>條件</th><th>預測值</th><th>滿意度</th><th>達標</th></tr>${rows}</table>
    </div>`;
  }).join('');
  // 起始值對照
  const b = r.baseline;
  const bRows = b.objectives.map((ob) => `<tr><td>${escHtml(ob.name)}</td><td><b>${ob.pred}</b></td><td>${(ob.desirability * 100).toFixed(0)}%</td></tr>`).join('');
  const baseline = `<div class="opt2-rec" style="opacity:.85">
    <div class="opt2-rec-head"><span class="opt2-score" style="font-weight:600">起始值（目前操作點）</span>
      <span class="opt2-score" style="margin-left:auto">綜合分 <b>${(b.score * 100).toFixed(0)}</b>／100</span></div>
    <div class="opt2-kv">${Object.entries(b.knobs).map(([k, v]) => kv(k, v)).join('')}</div>
    <table class="opt2-otbl"><tr><th>目標</th><th>預測值</th><th>滿意度</th></tr>${bRows}</table></div>`;
  $('opt2-out').innerHTML = head + note + cards + baseline;
}
$('opt2-add-obj').addEventListener('click', () => { optAddObj(); optRefreshUnion(); });
$('opt2-add-knob').addEventListener('click', () => { optAddKnob(); optRefreshRef(); });
$('opt2-goto-model').addEventListener('click', () => document.querySelector('.nav-tab[data-view="model"]').click());
document.querySelectorAll('.opt2-p').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.opt2-p').forEach((x) => x.classList.toggle('on', x === b));
  OPT.prec = b.dataset.prec;
}));
$('opt2-run').addEventListener('click', async () => {
  const body = optGather();
  if (!body.objectives.length) { $('opt2-out').innerHTML = '<p class="hint" style="padding:20px">請至少新增一個最佳化目標。</p>'; return; }
  // 前端先擋範圍條件缺值
  for (const o of body.objectives) {
    if (o.condition.type === 'range' && (Number.isNaN(o.condition.min) || Number.isNaN(o.condition.max))) {
      $('opt2-out').innerHTML = `<p class="hint" style="padding:20px;color:var(--danger)">目標「${o.name}」的範圍條件需要填下限與上限。</p>`; return;
    }
  }
  $('opt2-run').disabled = true;
  $('opt2-out').innerHTML = '<p class="hint" style="text-align:center;padding:30px">搜尋最佳參數組合中…（多目標運算，請稍候）</p>';
  try {
    const r = await apiML('/optimize2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    optRenderResult(r);
  } catch (e) {
    $('opt2-out').innerHTML = `<p class="hint" style="padding:20px;color:var(--danger)">最佳化失敗：${e.message}</p>`;
  } finally { $('opt2-run').disabled = false; }
});

// 登入身分顯示與登出（AUTH_DISABLED 時顯示未啟用）
fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then((me) => {
  if (!me) return;
  $('mm-user').textContent = me.auth_disabled ? '帳號：未啟用登入' : `帳號：${me.email}（${me.role}）`;
  if (!me.auth_disabled) $('mm-logout').style.display = '';
}).catch(() => {});
$('mm-logout').addEventListener('click', () => { location.href = '/logout'; });
$('mm-mysets').addEventListener('click', () => {
  document.querySelector('.nav-tab[data-view="mysets"]')?.click();
  $('more-drawer').classList.remove('open');
});
$('btn-upload-new').addEventListener('click', () => { location.href = '/data'; });

// AI 小精靈的情境摘要（sprite.js module 從 window 取用）
window.JS_DATA_CTX = () => {
  const ctx = { 頁面: sid ? '資料工作台' : '上傳頁' };
  const activeTab = document.querySelector('.nav-tab.active[data-view]');
  if (activeTab) ctx.目前分頁 = activeTab.textContent.trim();
  if (state) {
    ctx.資料 = {
      檔名: state.filename, 原始筆數: state.n_base, 現行筆數: state.n_view,
      欄數: (state.columns ?? []).filter((c) => !c.hidden && c.name !== '__id__').length,
      處理步驟數: (state.steps ?? []).filter((s) => s.enabled !== false).length,
    };
  }
  const ms = window._lastModels ?? [];
  if (ms.length) {
    const done = ms.filter((m) => m.status === 'done');
    ctx.模型 = { 總數: ms.length, 完成: done.length,
      訓練中: ms.filter((m) => m.status === 'training').length };
    const best = done.find((m) => m.metrics_cv?.rmse != null);
    if (best) ctx.模型.最佳迴歸 = { 名稱: best.name, 演算法: best.algo, rmse: best.metrics_cv.rmse, r2: best.metrics_cv.r2 };
  }
  return ctx;
};

// ------------------------------------------------------------ 狀態
async function refreshState() {
  state = await api('/state');
  // 資料視圖變更 → AI 助教既有評估標記過期（有評估結果才提示）
  if ($('ai-data-out')?.querySelector('.ai-out')) $('ai-data-stale').style.display = '';
  $('count-chip').textContent = `${state.n_view.toLocaleString()} 筆 ${state.columns.filter((c) => !c.hidden && c.name !== '__id__').length} 欄`;
  // 二維目標下拉（數值欄＋時間欄——選時間欄＝整牆時序圖 X=time）
  const timeCols = state.columns.filter((c) => !c.hidden && c.dtype.startsWith('datetime'));
  const numeric = state.columns.filter((c) => !c.hidden && c.name !== '__id__' &&
    (c.dtype.startsWith('float') || c.dtype.startsWith('int')));
  $('target-select').innerHTML = '<option value="">選擇預測目標進行二維分析</option>'
    + '<option value="">進行單維度分析</option>'
    + timeCols.map((c) => `<option value="${c.name}" ${c.name === target ? 'selected' : ''}>${c.name}（時序）</option>`).join('')
    + numeric.map((c) => `<option ${c.name === target ? 'selected' : ''}>${c.name}</option>`).join('');
  renderHistory();
  renderColMgr();
  fillPropsCols();
  await Promise.all([renderWall(), renderTable()]);
}

// ------------------------------------------------------------ 導航
document.querySelectorAll('.nav-tab[data-view]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.nav-tab[data-view]').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  const v = t.dataset.view;
  // 「我的資料集」是獨立畫面（不需要工作階段）：蓋掉上傳頁與工作區；
  // 其餘分頁屬於工作區（有 sid 才會顯示這些分頁）
  // 「我的資料集」與「最佳化」是獨立畫面；其餘分頁屬於工作區（有 sid 才顯示）
  const isMy = v === 'mysets';
  const isOpt = v === 'optimize';
  const standalone = isMy || isOpt;
  $('mysets-view').style.display = isMy ? '' : 'none';
  $('optimize-view').style.display = isOpt ? '' : 'none';
  $('upload-view').style.display = (standalone || sid) ? 'none' : '';
  $('main-area').style.display = (!standalone && sid) ? '' : 'none';
  $('subnav').style.display = (!standalone && sid) ? '' : 'none';
  $('explore-view').style.display = v === 'explore' ? '' : 'none';
  $('dataset-view').style.display = v === 'dataset' ? '' : 'none';
  $('model-view').style.display = v === 'model' ? '' : 'none';
  // 次導航依頁切換：探索分析＝二維目標下拉；資料集＝每頁顯示
  $('target-select').style.display = v === 'explore' ? '' : 'none';
  $('perpage-wrap').style.display = v === 'dataset' ? 'flex' : 'none';
  if (v === 'model') renderModels();
  if (isMy) renderMySets();
  if (isOpt) renderOptimize();
  if (v === 'explore' && wallDirty) { wallDirty = false; renderWall(); }
}));

$('perpage-select').addEventListener('change', async (e) => {
  perTable = +e.target.value;
  tablePage = 1;
  await renderTable();
});

$('target-select').addEventListener('change', async (e) => {
  target = e.target.value;
  wallPage = 1;
  await renderWall();
});

$('btn-drawer').addEventListener('click', () => $('drawer').classList.toggle('open'));
$('drawer-close').addEventListener('click', () => $('drawer').classList.remove('open'));
document.querySelectorAll('.dtab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.dtab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.dbody').forEach((x) => x.classList.remove('show'));
  t.classList.add('active');
  $(`d-${t.dataset.d}`).classList.add('show');
}));

// 更多側邊欄
$('btn-more').addEventListener('click', (e) => {
  e.stopPropagation();
  $('more-drawer').classList.toggle('open');
});
$('more-close').addEventListener('click', () => $('more-drawer').classList.remove('open'));

// 圖表主題色
function markThemeMenu() {
  $('theme-menu').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('on', b.dataset.theme === themeKey));
}
$('btn-theme').addEventListener('click', (e) => {
  e.stopPropagation();
  markThemeMenu();
  $('theme-menu').classList.toggle('open');
});
let wallDirty = false;   // 主題在非探索視圖切換時，回到探索再重繪（隱藏 canvas 尺寸為 0 會畫空白）
$('theme-menu').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
  themeKey = b.dataset.theme;
  localStorage.setItem('ej-chart-theme', themeKey);
  markThemeMenu();
  $('theme-menu').classList.remove('open');
  if (!sid) return;
  if ($('explore-view').style.display !== 'none') await renderWall();
  else wallDirty = true;
}));

document.addEventListener('click', (e) => {
  if (!e.target.closest('#more-drawer') && !e.target.closest('#btn-more')) $('more-drawer').classList.remove('open');
  if (!e.target.closest('#theme-menu') && !e.target.closest('#btn-theme')) $('theme-menu').classList.remove('open');
  if (!e.target.closest('.popover') && !e.target.closest('.cicon') && !e.target.closest('.thops')) closePopovers();
  // 框選面板：點 canvas 是拖曳流程的一部分，不在此收合
  if (!e.target.closest('.brush-panel') && e.target.tagName !== 'CANVAS') closeBrushPanel();
});
$('mm-export').addEventListener('click', () => { if (sid) location.href = `/api/data/${sid}/export`; });
$('mm-export-raw').addEventListener('click', () => { if (sid) location.href = `/api/data/${sid}/export?raw=1`; });
$('mm-report').addEventListener('click', () => { if (sid) location.href = `/api/data/${sid}/report`; });
// 上傳新資料集＝乾淨開始（reload 會帶著 ?sid 回到舊會話）
$('mm-new').addEventListener('click', () => { location.href = '/data'; });
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
  snapshotSteps();
  await api('/apply_template', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps }),
  });
  await refreshState();
});

// ------------------------------------------------------------ 卡片牆
async function renderWall() {
  // 隱藏狀態下 canvas 尺寸為 0，畫了也是空白——標記 dirty，切回探索分析時再畫
  if ($('explore-view').style.display === 'none') { wallDirty = true; return; }
  const res = await api(`/cards?target=${encodeURIComponent(target)}&page=${wallPage}&per_page=${PER_WALL}`);
  // 欄位數縮減後頁碼可能超界
  const maxPage = Math.max(1, Math.ceil(res.total_cols / PER_WALL));
  if (wallPage > maxPage) { wallPage = maxPage; return renderWall(); }
  res.cards.forEach((c) => { c.target = res.target; });   // 矩形框選 Y 欄
  const wall = $('card-wall');
  wall.innerHTML = res.cards.map((c, i) => `
    <div class="card" data-col="${c.col}">
      <div class="card-head">
        <div class="row1">
          <span class="card-title" title="${c.col}">${c.col}</span>
          <span class="card-icons">
            <button class="cicon" data-act="ops" title="資料操作（排除/萃取/聚合）">${ICONS.funnel}</button>
            <button class="cicon" data-act="zoom" title="放大">${ICONS.zoom}</button>
            <button class="cicon" data-act="hide" title="隱藏欄位">${ICONS.eyeoff}</button>
          </span>
        </div>
        <div class="card-type">${kindIcon(c.kind)} ${kindName[c.kind] ?? c.kind}${res.target && c.col !== res.target ? `　vs ${res.target}` : ''}</div>
      </div>
      <div class="card-body"><canvas id="cv-${i}"></canvas></div>
    </div>`).join('');
  res.cards.forEach((c, i) => {
    const cv = $(`cv-${i}`);
    drawCard(cv, c);
    bindBrush(cv);
  });
  wall.querySelectorAll('.cicon').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const col = btn.closest('.card').dataset.col;
    const act = btn.dataset.act;
    if (act === 'hide') toggleHide(col);
    else if (act === 'zoom') openZoom(col);
    else if (act === 'ops') openPopover(btn.closest('.card-head'), col);
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

// 卡片繪圖 — 可選主題色（預設綠黑 AI 風，深淺=資料密度）＋完整軸刻度＋框選
const C_AXIS = '#061027';
const C_LABEL = '#555555';
const C_GRID = '#ECEEF2';
// 深淺語意：柱越高（筆數越多）顏色越深；散佈點半透明重疊越密越深
const THEMES = {
  green:  { name: '綠', lo: [183, 212, 196], hi: [4, 46, 34],
            dot: 'rgba(5, 95, 70, 0.5)', selF: 'rgba(16, 185, 129, 0.12)', selL: 'rgba(5, 150, 105, 0.65)' },
  blue:   { name: '藍', lo: [186, 206, 233], hi: [5, 34, 84],
            dot: 'rgba(4, 106, 251, 0.45)', selF: 'rgba(4, 106, 251, 0.10)', selL: 'rgba(4, 106, 251, 0.6)' },
  purple: { name: '紫', lo: [211, 199, 227], hi: [51, 18, 84],
            dot: 'rgba(126, 58, 242, 0.45)', selF: 'rgba(126, 58, 242, 0.10)', selL: 'rgba(126, 58, 242, 0.6)' },
  amber:  { name: '琥珀', lo: [233, 216, 183], hi: [102, 54, 4],
            dot: 'rgba(217, 119, 6, 0.5)', selF: 'rgba(217, 119, 6, 0.10)', selL: 'rgba(217, 119, 6, 0.6)' },
  ink:    { name: '墨', lo: [182, 188, 198], hi: [6, 16, 39],
            dot: 'rgba(6, 16, 39, 0.45)', selF: 'rgba(6, 16, 39, 0.08)', selL: 'rgba(6, 16, 39, 0.55)' },
};
let themeKey = localStorage.getItem('ej-chart-theme') ?? 'green';
if (!THEMES[themeKey]) themeKey = 'green';
const theme = () => THEMES[themeKey];
const ink = (t) => {
  const { lo, hi } = theme();
  return `rgb(${lo.map((l, i) => Math.round(l + (hi[i] - l) * t)).join(',')})`;
};
const GEOM = new WeakMap();      // canvas → 幾何映射（框選 px→值）

function niceTicks(lo, hi, n = 6) {
  if (!(hi > lo)) return [lo];
  const step0 = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  // 標準 nice-step 分界（1.5/3/7），避免 norm≈4.7 落到 step=2 產生過密刻度
  const step = (norm >= 7 ? 10 : norm >= 3 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) out.push(v);
  return out;
}
const fmtTick = (v) => {
  const a = Math.abs(v);
  if (a !== 0 && (a >= 100000 || a < 0.01)) return v.toExponential(1);
  if (a >= 100) return String(Math.round(v));
  return String(Math.round(v * 100) / 100);
};
const fmtTime = (sec) => new Date(sec * 1000).toLocaleDateString('en', { month: 'short', day: 'numeric' });

function drawCard(canvas, card, big = false, selPx = null) {
  const dpr = devicePixelRatio;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.clientHeight || canvas.parentElement.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const M = { l: big ? 66 : 56, r: 16, t: 12, b: big ? 62 : 54 };
  ctx.font = big ? '12px Inter' : '11px Inter';
  const plotW = w - M.l - M.r;
  const plotH = h - M.t - M.b;

  // 值域（也是框選幾何）
  let xlo = null, xhi = null, yhi = 1, ylo = 0;
  if (card.mode === 'hist') {
    xlo = card.edges[0]; xhi = card.edges.at(-1);
    yhi = Math.max(...card.counts, 1);
  } else if (card.mode === 'scatter' && card.x.length) {
    const xn = card.x.map((v) => (typeof v === 'number' ? v : 0));
    xlo = Math.min(...xn); xhi = Math.max(...xn);
    ylo = Math.min(...card.y); yhi = Math.max(...card.y);
  }
  GEOM.set(canvas, { card, big, M, w, h, plotW, plotH, xlo, xhi, ylo, yhi });
  const px = (v) => M.l + ((v - xlo) / ((xhi - xlo) || 1)) * plotW;
  const py = (v) => h - M.b - ((v - ylo) / ((yhi - ylo) || 1)) * plotH;

  // Y 軸刻度＋淺灰橫格線（Tukey 同款）
  const yAxis = (ticks) => {
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ticks.forEach((tv) => {
      const y = py(tv);
      ctx.strokeStyle = C_GRID;
      ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke();
      ctx.fillStyle = C_LABEL;
      ctx.fillText(fmtTick(tv), M.l - 8, y + 3.5);
    });
    ctx.textAlign = 'left';
  };
  // X 軸多刻度；時間/擁擠標籤 45° 斜排（Tukey 同款）
  const xAxis = (isTime) => {
    if (xlo == null || !(xhi > xlo)) return;
    const ticks = isTime
      ? Array.from({ length: 6 }, (_, i) => xlo + ((xhi - xlo) * i) / 5)
      : niceTicks(xlo, xhi, big ? 7 : 5);
    const fmt = isTime ? fmtTime : fmtTick;
    const rotate = isTime || ticks.some((t) => ctx.measureText(fmt(t)).width > plotW / ticks.length - 10);
    ticks.forEach((tv) => {
      const x = px(tv);
      ctx.strokeStyle = C_AXIS;
      ctx.beginPath(); ctx.moveTo(x, h - M.b); ctx.lineTo(x, h - M.b + 4); ctx.stroke();
      ctx.fillStyle = C_LABEL;
      const lb = fmt(tv);
      if (rotate) {
        ctx.save();
        ctx.translate(x, h - M.b + 7);
        ctx.rotate(-Math.PI / 4);
        ctx.textAlign = 'right';
        ctx.fillText(lb, 0, 9);
        ctx.restore();
        ctx.textAlign = 'left';
      } else {
        ctx.fillText(lb, x - ctx.measureText(lb).width / 2, h - M.b + 18);
      }
    });
  };
  const axes = () => {
    ctx.strokeStyle = C_AXIS;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.l, M.t);
    ctx.lineTo(M.l, h - M.b);
    ctx.lineTo(w - M.r, h - M.b);
    ctx.stroke();
  };
  const xlabel = (txt) => {
    ctx.fillStyle = C_LABEL;
    ctx.fillText(txt, (w - ctx.measureText(txt).width) / 2, h - 6);
  };
  // 框選選取帶/矩形：selPx = [x0,x1]（X 帶）或 [x0,y0,x1,y1]（矩形）
  const selBand = () => {
    if (!selPx) return;
    let a, b, t, btm;
    if (selPx.length === 4) {
      a = Math.max(Math.min(selPx[0], selPx[2]), M.l);
      b = Math.min(Math.max(selPx[0], selPx[2]), w - M.r);
      t = Math.max(Math.min(selPx[1], selPx[3]), M.t);
      btm = Math.min(Math.max(selPx[1], selPx[3]), h - M.b);
    } else {
      a = Math.max(Math.min(selPx[0], selPx[1]), M.l);
      b = Math.min(Math.max(selPx[0], selPx[1]), w - M.r);
      t = M.t; btm = h - M.b;
    }
    ctx.fillStyle = theme().selF;
    ctx.fillRect(a, t, b - a, btm - t);
    ctx.strokeStyle = theme().selL;
    ctx.strokeRect(a + 0.5, t + 0.5, b - a - 1, btm - t - 1);
  };

  if (card.mode === 'hist') {
    yAxis(niceTicks(0, yhi, 4).filter(Number.isInteger));
    axes();
    card.counts.forEach((cnt, i) => {
      const x0 = px(card.edges[i]);
      const x1 = px(card.edges[i + 1]);
      const bh = (cnt / yhi) * plotH;
      ctx.fillStyle = ink(cnt / yhi);
      ctx.fillRect(x0 + 0.5, h - M.b - bh, Math.max(x1 - x0 - 1.5, 1), bh);
    });
    xAxis(!!card.x_is_time);
    xlabel(card.col);
  } else if (card.mode === 'bar') {
    const maxC = Math.max(...card.counts, 1);
    yhi = maxC;   // py() 閉包讀此變數——不先設定，格線/刻度會全部畫錯位置
    yAxis(niceTicks(0, maxC, 4).filter(Number.isInteger));
    axes();
    const bw = plotW / card.labels.length;
    card.labels.forEach((lb, i) => {
      const bh = (card.counts[i] / maxC) * plotH;
      ctx.fillStyle = ink(card.counts[i] / maxC);
      ctx.fillRect(M.l + i * bw + 1, h - M.b - bh, bw - 2, bh);
      ctx.fillStyle = C_LABEL;
      ctx.fillText(lb.slice(0, 7), M.l + i * bw + 2, h - M.b + 18);
    });
    xlabel(card.col);
  } else if (card.mode === 'scatter') {
    if (!card.x.length) return;
    yAxis(niceTicks(ylo, yhi, 5));
    axes();
    ctx.fillStyle = theme().dot;
    card.x.forEach((xv, i) => {
      ctx.beginPath();
      ctx.arc(px(typeof xv === 'number' ? xv : 0), py(card.y[i]), big ? 2.5 : 1.8, 0, Math.PI * 2);
      ctx.fill();
    });
    xAxis(!!card.x_is_time);
    xlabel(card.col);
  } else {
    ctx.fillStyle = C_LABEL;
    ctx.fillText('（無資料）', M.l, h / 2);
  }
  selBand();
}

// ------------------------------------------------------------ 圖表框選 → 排除/萃取
let brushPanel = null;
function closeBrushPanel(redraw = true) {
  if (!brushPanel) return;
  const ref = brushPanel._ref;
  brushPanel.remove();
  brushPanel = null;
  if (redraw && ref) drawCard(ref.canvas, ref.g.card, ref.g.big);
}

// ranges = { x: {col, lo, hi, isTime}|null, y: {col, lo, hi}|null }
const fmtRangeV = (v, isTime) => isTime
  ? new Date(v * 1000).toLocaleString('sv').slice(0, 16)
  : String(Math.round(v * 1000) / 1000);

function openBrushPanel(cx, cy, canvas, g, ranges) {
  closeBrushPanel(false);
  const lines = [];
  if (ranges.x) lines.push(`${ranges.x.col}：${fmtRangeV(ranges.x.lo, ranges.x.isTime)} ～ ${fmtRangeV(ranges.x.hi, ranges.x.isTime)}`);
  if (ranges.y) lines.push(`${ranges.y.col}：${fmtRangeV(ranges.y.lo)} ～ ${fmtRangeV(ranges.y.hi)}`);
  brushPanel = document.createElement('div');
  brushPanel.className = 'brush-panel';
  brushPanel._ref = { canvas, g };
  brushPanel.innerHTML = `
    <div class="bp-range">${lines.join('<br>')}</div>
    <div class="bp-actions">
      <button data-a="exclude">排除</button>
      <button data-a="extract">萃取</button>
      <button data-a="cancel">取消</button>
    </div>`;
  document.body.appendChild(brushPanel);
  brushPanel.style.left = `${Math.min(cx, innerWidth - brushPanel.offsetWidth - 12)}px`;
  brushPanel.style.top = `${Math.min(cy + 10, innerHeight - brushPanel.offsetHeight - 12)}px`;
  brushPanel.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.a;
    if (act === 'cancel') { closeBrushPanel(); return; }
    closeBrushPanel(false);
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const verb = act === 'exclude' ? 'exclude' : 'extract';
    const dispOf = (r, isTime) => isTime
      ? `${fmtRangeV(r.lo, true)}～${fmtRangeV(r.hi, true)}`
      : `[${r3(r.lo)}, ${r3(r.hi)}]`;
    if (ranges.x && ranges.y) {
      // 矩形框選（散佈圖）：X、Y 兩欄同時條件
      const desc = `${verb} ${ranges.x.col} ∈ ${dispOf(ranges.x, ranges.x.isTime)} 且 ${ranges.y.col} ∈ ${dispOf(ranges.y)}`;
      await addStep(act === 'exclude' ? 'exclude_box' : 'extract_box', desc, {
        x_col: ranges.x.col, x_lo: ranges.x.isTime ? ranges.x.lo : r3(ranges.x.lo),
        x_hi: ranges.x.isTime ? ranges.x.hi : r3(ranges.x.hi),
        y_col: ranges.y.col, y_lo: r3(ranges.y.lo), y_hi: r3(ranges.y.hi),
      });
    } else {
      const r = ranges.x ?? ranges.y;
      const isTime = ranges.x ? ranges.x.isTime : false;
      const desc = `${verb} ${r.col} ∈ ${dispOf(r, isTime)}`;
      await addStep(act === 'exclude' ? 'exclude_range' : 'extract', desc,
        { col: r.col, lo: isTime ? r.lo : r3(r.lo), hi: isTime ? r.hi : r3(r.hi) });
    }
  }));
}

function bindBrush(canvas) {
  let x0 = null;
  let y0 = null;
  let dragging = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  canvas.style.cursor = 'crosshair';
  canvas.addEventListener('pointerdown', (e) => {
    const g = GEOM.get(canvas);
    if (!g || g.xlo == null || !(g.xhi > g.xlo)) return;   // bar/空卡不支援
    closeBrushPanel();
    [x0, y0] = pos(e);
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const g = GEOM.get(canvas);
    const [x1, y1] = pos(e);
    // 散佈圖＝自由矩形；直方圖＝X 值域帶（Y 軸是筆數，無資料語意）
    drawCard(canvas, g.card, g.big, g.card.mode === 'scatter' ? [x0, y0, x1, y1] : [x0, x1]);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    const g = GEOM.get(canvas);
    const [x1, y1] = pos(e);
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const clampX = (v) => Math.min(Math.max(v, g.M.l), g.w - g.M.r);
    const clampY = (v) => Math.min(Math.max(v, g.M.t), g.h - g.M.b);
    const toX = (pv) => g.xlo + ((clampX(pv) - g.M.l) / (g.plotW || 1)) * (g.xhi - g.xlo);
    const toY = (pv) => g.ylo + ((g.h - g.M.b - clampY(pv)) / (g.plotH || 1)) * (g.yhi - g.ylo);
    const isTime = !!g.card.x_is_time || g.card.kind === 'time';
    if (g.card.mode === 'scatter') {
      // 橫拖=X 篩選、直拖=Y 篩選、斜拖=矩形（兩欄同時）；欄位以後端 x_col/y_col 為準
      const xCol = g.card.x_col ?? g.card.col;
      const yCol = g.card.y_col ?? g.card.target;
      const xr = dx >= 5 ? { col: xCol, lo: Math.min(toX(x0), toX(x1)), hi: Math.max(toX(x0), toX(x1)), isTime } : null;
      const yr = dy >= 5 && yCol
        ? { col: yCol, lo: Math.min(toY(y0), toY(y1)), hi: Math.max(toY(y0), toY(y1)) } : null;
      if (!xr && !yr) { drawCard(canvas, g.card, g.big); return; }  // 誤觸
      openBrushPanel(e.clientX, e.clientY, canvas, g, { x: xr, y: yr });
    } else {
      if (dx < 5) { drawCard(canvas, g.card, g.big); return; }      // 誤觸
      openBrushPanel(e.clientX, e.clientY, canvas, g, {
        x: { col: g.card.col, lo: Math.min(toX(x0), toX(x1)), hi: Math.max(toX(x0), toX(x1)), isTime },
        y: null,
      });
    }
  });
}

// ------------------------------------------------------------ 卡片操作 popover
function closePopovers() {
  document.querySelectorAll('.popover').forEach((p) => p.remove());
}

function openPopover(anchorEl, col) {
  closePopovers();
  const colInfo = state.columns.find((c) => c.name === col);
  const numeric = colInfo && (colInfo.dtype.startsWith('float') || colInfo.dtype.startsWith('int'));
  const isTime = colInfo && colInfo.dtype.startsWith('datetime');
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `
    <div class="pop-tabs">
      ${numeric ? `<button class="pop-tab active" data-t="exclude">排除資料</button>
      <button class="pop-tab" data-t="extract">萃取資料</button>` : ''}
      ${isTime ? '<button class="pop-tab active" data-t="aggregate">聚合資料</button>'
        : '<button class="pop-tab" data-t="aggregate">聚合資料</button>'}
    </div>
    <div id="pop-form"></div>
    <div class="pop-actions">
      <button class="cancel">取消</button>
      <button class="save">加入歷程</button>
    </div>`;
  // sticky/relative 皆可作 absolute 定位基準；只在 static 時補 relative
  if (getComputedStyle(anchorEl).position === 'static') anchorEl.style.position = 'relative';
  if (anchorEl.tagName === 'TH') { pop.style.right = 'auto'; pop.style.left = '0'; }
  anchorEl.appendChild(pop);

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
  snapshotSteps();
  await api('/steps', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, label, params }),
  });
  await refreshState();
}

// ------------------------------------------------------------ 復原/還原（歷程快照制 20 步）
const undoStack = [];
const redoStack = [];
const UNDO_MAX = 20;

function snapshotSteps() {
  undoStack.push(JSON.stringify(state?.steps ?? []));
  if (undoStack.length > UNDO_MAX) undoStack.shift();
  redoStack.length = 0;
  updateUndoBtns();
}

async function restoreSteps(json) {
  await api('/apply_template', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps: JSON.parse(json) }),
  });
  await refreshState();
}

async function undoSteps() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(state?.steps ?? []));
  await restoreSteps(undoStack.pop());
  updateUndoBtns();
}

async function redoSteps() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(state?.steps ?? []));
  await restoreSteps(redoStack.pop());
  updateUndoBtns();
}

function updateUndoBtns() {
  $('btn-undo').disabled = !undoStack.length;
  $('btn-redo').disabled = !redoStack.length;
}

$('btn-undo').addEventListener('click', undoSteps);
$('btn-redo').addEventListener('click', redoSteps);
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && !e.shiftKey && k === 'z') { e.preventDefault(); undoSteps(); }
  else if ((e.ctrlKey && k === 'y') || (e.ctrlKey && e.shiftKey && k === 'z')) { e.preventDefault(); redoSteps(); }
});

// ------------------------------------------------------------ 隱藏欄位
async function toggleHide(col) {
  snapshotSteps();
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
  card.target = res.target;
  $('zoom-title').textContent = `${col}${res.target && col !== res.target ? `｜vs ${res.target}` : ''}`;
  const { lo, hi } = theme();
  $('zoom-modal').querySelector('.zl-bar').style.background =
    `linear-gradient(90deg, rgb(${lo.join(',')}), rgb(${hi.join(',')}))`;
  $('zoom-modal').classList.add('open');
  drawCard($('zoom-canvas'), card, true);   // 同步繪製（rAF 在背景分頁不觸發）
}
bindBrush($('zoom-canvas'));
$('zoom-close').addEventListener('click', () => $('zoom-modal').classList.remove('open'));
$('zoom-modal').addEventListener('click', (e) => { if (e.target === $('zoom-modal')) $('zoom-modal').classList.remove('open'); });

// ------------------------------------------------------------ 資料集表格（Tukey 多行欄頭）
async function renderTable() {
  const res = await api(`/rows?page=${tablePage}&per_page=${perTable}`);
  // 筆數縮減後頁碼可能超界
  const maxPage = Math.max(1, Math.ceil(res.n_view / perTable));
  if (tablePage > maxPage) { tablePage = maxPage; return renderTable(); }
  const table = $('ds-table');
  table.innerHTML = `<tr>${res.columns.map((c) => {
    const isId = c.name === '__id__';
    const typeLine = isId
      ? `${ICONS.key} id`
      : `${kindIcon(c.kind)} ${kindName[c.kind] ?? c.kind}`;
    return `
    <th class="rel" data-col="${c.name}">
      <div class="tname">${c.name}
        ${isId ? '' : `<button class="thops" title="資料操作（排除/萃取/聚合）">${ICONS.dots}</button>`}
      </div>
      <div class="tgroup">一般欄位</div>
      <div class="ttype">${typeLine}</div>
    </th>`;
  }).join('')}</tr>`
    + res.rows.map((r) => `<tr>${res.columns.map((c) => {
      let v = r[c.name];
      if (v == null) v = '';
      if (c.kind === 'time' && v) v = String(v).replace('T', ' ').slice(0, 19);
      return `<td>${v}</td>`;
    }).join('')}</tr>`).join('');
  table.querySelectorAll('.thops').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const th = btn.closest('th');
    openPopover(th, th.dataset.col);
  }));
  renderPager($('table-pager'), tablePage, Math.ceil(res.n_view / perTable), async (p) => {
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
      snapshotSteps();
      await api(`/steps/${inp.dataset.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: inp.checked }),
      });
      await refreshState();
    }));
  $('d-history').querySelectorAll('.del').forEach((el) =>
    el.addEventListener('click', async () => {
      snapshotSteps();
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

// ------------------------------------------------------------ 模型（AutoML，對標 Tukey fitting）
let ALGO_META = null;      // /api/automl/algos
let modelPollTimer = null;
const apiML = (path, opts) => fetch(`/api/automl/${sid}${path}`, opts).then((r) => {
  if (!r.ok) return r.json().then((e) => { throw new Error(e.detail ?? r.status); });
  return r.json();
});

async function loadAlgoMeta() {
  if (!ALGO_META) ALGO_META = (await fetch('/api/automl/algos').then((r) => r.json())).algos;
  return ALGO_META;
}

let aiWasTraining = false;
async function renderModels() {
  if (!sid) return;
  clearTimeout(modelPollTimer);
  const models = await apiML('/models');
  window._lastModels = models;   // AI 小精靈情境摘要用
  $('model-empty').style.display = models.length ? 'none' : '';
  $('model-main').style.display = models.length ? '' : 'none';
  if (models.length) {
    const stName = { done: '完成', training: '訓練中…', error: '失敗' };
    // 指標四欄多語意：迴歸 RMSE/MAE/MAAPE/R²、分類 Acc/F1/P/R、異常 門檻/超標%/平均/最大
    const mv = (m) => {
      const c = m.metrics_cv;
      if (!c) return ['—', '—', '—', '—'];
      if (m.task === 'classification') return [c.accuracy, c.f1, c.precision, c.recall];
      if (m.task === 'anomaly') return [c.threshold, `${c.exceed_pct}%`, c.mean_risk, c.max_risk];
      return [c.rmse, c.mae, c.maape, c.r2];
    };
    // 按目標分組：排名只在「同一個預測目標」內比才有意義（不同 Y 的分數不可比）
    const groups = new Map();
    models.forEach((m) => {
      const g = m.task === 'anomaly' ? '__anomaly__' : m.target;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(m);
    });
    const thead = `<thead><tr>
      <th>排名${qi(METRIC_TIPS['排名'])}</th><th>模型</th><th>任務</th><th>演算法</th>
      <th>RMSE｜Acc${qi(`依任務顯示不同指標——迴歸：${METRIC_TIPS.RMSE}｜分類：${METRIC_TIPS.Accuracy}｜異常偵測：${METRIC_TIPS['風險門檻']}`)}</th>
      <th>MAE｜F1${qi(`迴歸：${METRIC_TIPS.MAE}｜分類：${METRIC_TIPS.F1}｜異常偵測：${METRIC_TIPS['超標 %']}`)}</th>
      <th>MAAPE｜Prec${qi(`迴歸：${METRIC_TIPS.MAAPE}｜分類：${METRIC_TIPS.Precision}`)}</th>
      <th>R²｜Recall${qi(`迴歸：${METRIC_TIPS['R²']}｜分類：${METRIC_TIPS.Recall}`)}</th>
      <th>狀態</th><th>建立時間</th><th></th></tr></thead>`;
    $('model-table-wrap').innerHTML = [...groups.entries()].map(([g, ms]) => `
      <div class="mgroup">
        <div class="mg-title">${g === '__anomaly__'
          ? `設備異常偵測（無監督）${qi('無目標欄：以訓練資料為健康基準，監控偏離程度——與預測模型的排名邏輯不同，故獨立一組。')}`
          : `目標 ${g}${qi('同一個預測目標的模型才能互相比較排名——不同目標的分數單位與難度都不同，放在一起比沒有意義。')}`}</div>
        <table class="model-table">${thead}<tbody>${
        ms.map((m, i) => `<tr data-id="${m.id}">
          <td>${m.status === 'done' ? `#${i + 1}` : ''}</td>
          <td>${escHtml(m.name)}</td>
          <td>${m.task === 'classification' ? '分類' : m.task === 'timeseries' ? '時序' : m.task === 'anomaly' ? '異常偵測' : m.task === 'hybrid' ? '混合（模擬＋AI）' : '迴歸'}</td>
          <td>${(ALGO_META?.find((a) => a.key === m.algo)?.name) ?? m.algo}${m.auto_tune ? '（自動調參）' : ''}</td>
          ${mv(m).map((v) => `<td>${v}</td>`).join('')}
          <td class="st-${m.status}" title="${m.error ?? ''}">${stName[m.status] ?? m.status}</td>
          <td>${m.created}</td>
          <td><span class="del" data-id="${m.id}">刪除</span></td></tr>`).join('')}</tbody></table>
      </div>`).join('');
    $('model-table-wrap').querySelectorAll('.del').forEach((el) => el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await apiML(`/models/${el.dataset.id}`, { method: 'DELETE' });
      $('model-detail').style.display = 'none';
      await renderModels();
    }));
    $('model-table-wrap').querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () =>
      openModelDetail(tr.dataset.id)));
    // 訓練批次全部完成的那一刻 → AI 自動總評（每做一次操作即回饋目前狀態）
    if (models.some((m) => m.status === 'training')) {
      aiWasTraining = true;
      modelPollTimer = setTimeout(renderModels, 2500);
    } else if (aiWasTraining) {
      aiWasTraining = false;
      aiAdvise('models', null, $('ai-models-out'), $('btn-ai-models'));
    }
  }
}
$('btn-ai-models').addEventListener('click', () =>
  aiAdvise('models', null, $('ai-models-out'), $('btn-ai-models')));
$('btn-ai-data').addEventListener('click', () => {
  $('ai-data-stale').style.display = 'none';
  aiAdvise('data', null, $('ai-data-out'), $('btn-ai-data'));
});

const METRIC_HEADS = {
  regression: ['RMSE', 'MAE', 'MAAPE', 'R²'],
  classification: ['Accuracy', 'F1', 'Precision', 'Recall'],
  anomaly: ['健康分數', '風險門檻', '超標 %', '事件數'],
};

// ------------------------------------------------------------ AI 助教（本機 LLM）
// hoisted：renderMySets 等在模組載入時即可能同步呼叫，const 會 TDZ
function escHtml(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
let aiOk = null;       // null=未探測
let aiBusy = false;    // 本機引擎單併發，忙碌時擋新請求
async function aiStatus() {
  if (aiOk !== null) return aiOk;
  try { aiOk = (await fetch('/api/ai/status').then((r) => r.json())).ok; } catch { aiOk = false; }
  return aiOk;
}
async function aiAdvise(scope, mid, outEl, btn) {
  if (!outEl) return;
  if (!(await aiStatus())) {
    outEl.innerHTML = '<p class="hint">本機 AI 引擎未啟動——啟動後重新整理即可使用 AI 助教。</p>';
    return;
  }
  if (aiBusy) {
    outEl.innerHTML = '<p class="hint">AI 助教正在處理另一項評估——請稍候再點「重新評估」。</p>';
    return;
  }
  aiBusy = true;
  if (btn) btn.disabled = true;
  outEl.innerHTML = '<p class="hint">AI 助教評估中…（本機引擎，約 5–20 秒）</p>';
  try {
    const res = await fetch('/api/ai/advise', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sid, scope, mid }),
    });
    if (!res.ok) throw new Error((await res.json()).detail ?? res.status);
    const r = await res.json();
    outEl.innerHTML = `<div class="ai-out">${escHtml(r.advice)}</div>`;
  } catch (e) {
    outEl.innerHTML = `<p class="hint" style="color:var(--danger)">AI 評估失敗：${escHtml(e.message)}</p>`;
  } finally {
    aiBusy = false;
    if (btn) btn.disabled = false;
  }
}

// 圓圈問號：qi(說明) 產生 span，泡泡由全域 delegation 定位（見檔尾 initQiTips）
const qi = (tip) => tip ? `<span class="qi" data-tip="${String(tip).replace(/"/g, '&quot;')}">?</span>` : '';
// 指標縮寫白話字典——全部表頭共用
const METRIC_TIPS = {
  RMSE: '均方根誤差：預測與實際平均差多少（與目標同單位），大誤差會被平方放大——特別怕大錯時看這個。越小越好。',
  MAE: '平均絕對誤差：預測與實際平均差多少，每筆誤差等權、不放大離群。越小越好，跟 RMSE 一起看：RMSE 遠大於 MAE 代表有少數大錯。',
  MAAPE: '平均反正切百分比誤差：「平均差了百分之幾」的穩健版——實際值接近 0 時一般百分比誤差會爆表，這個不會。0＝完美，越小越好。',
  'R²': '判定係數：模型解釋了資料變化的多少比例。1＝完美、0＝跟直接猜平均值一樣、負值＝比猜平均還差（模型無效）。',
  Accuracy: '準確率：整體答對的比例。類別數量懸殊時會失真（全猜多數類也能拿高分），要搭配 F1 看。',
  F1: '精確率與召回率的調和平均：兩者都高才會高。類別不平衡時比 Accuracy 可靠。',
  Precision: '精確率：模型說「是」的裡面，真的是的比例——抓出來的有多準（誤報率的反面）。',
  Recall: '召回率：實際為「是」的裡面，被模型抓到的比例——該抓的抓到多少（漏報率的反面）。',
  '健康分數': 'AI 健康分數 0–100：由風險值換算——100＝完全貼合健康基準、50＝風險剛好到門檻、0＝風險達門檻兩倍。「近期」取資料末端 5% 的平均。≥70 正常、40–70 注意、<40 危急。',
  '風險門檻': '判定異常的風險值分界線，預設取健康資料風險值的第 99 百分位（P99）。可在下方「風險值門檻試算」換方法重算並套用。',
  '超標 %': '風險值超過門檻的資料筆數比例——健康基準資料上通常應在 1% 上下（P99 門檻的定義使然）。',
  '事件數': '連續超標段的數量：風險值連續多筆超過門檻算一次「故障事件」，詳見下方整合型故障事件列表。',
  '排名': '完成的模型依驗證分數排序：迴歸看 RMSE 最小、分類看 Accuracy 最高。',
};
const mh = (h) => `<th>${h}${qi(METRIC_TIPS[h])}</th>`;
const metricVals = (mt, kind) => kind === 'classification'
  ? [mt.accuracy, mt.f1, mt.precision, mt.recall]
  : kind === 'anomaly'
    ? [mt.health_now, mt.threshold, `${mt.exceed_pct}%`, mt.n_events]
    : [mt.rmse, mt.mae, mt.maape, mt.r2];
const healthColor = (s) => s >= 70 ? 'var(--ok)' : s >= 40 ? '#D97706' : 'var(--danger)';
const metricRow = (label, mt, kind) => `<tr><td>${label}</td>${
  metricVals(mt, kind === true ? 'classification' : kind || 'regression')
    .map((v) => `<td>${v}</td>`).join('')}</tr>`;

async function openModelDetail(mid) {
  const m = await apiML(`/models/${mid}`);
  if (m.status !== 'done') {
    // 不用 alert（原生對話框會凍住頁面），錯誤直接顯示在詳情區
    $('model-detail').style.display = '';
    $('model-detail').innerHTML = `<h3>${escHtml(m.name)}</h3><p class="hint" style="margin-top:6px">${
      m.status === 'error' ? `訓練失敗：${m.error}` : '訓練中，請稍候…（列表會自動更新）'}</p>`;
    return;
  }
  await loadAlgoMeta();
  const cls = m.task === 'classification';
  const isTs = m.task === 'timeseries';
  const isAn = m.task === 'anomaly';
  const kind = cls ? 'classification' : isAn ? 'anomaly' : 'regression';
  const heads = METRIC_HEADS[kind];
  const algoMeta = ALGO_META.find((a) => a.key === m.algo);
  const algoName = algoMeta?.name ?? m.algo;
  const tuned = m.tuned_params ? `<div class="md-sub">自動調參結果${qi('系統自動嘗試多組超參數（隨機搜尋＋交叉驗證）後選出的最佳組合——這個模型實際使用的就是這組值。')}：${
    Object.entries(m.tuned_params).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('×') : v}`).join('、')}</div>` : '';
  const charts = cls ? `
      <div class="md-chart"><h4>混淆矩陣 Confusion Matrix（驗證集）</h4><canvas id="md-cm"></canvas></div>
      <div class="md-chart"><h4>重要變數分析 Feature Importance</h4><canvas id="md-fi"></canvas></div>` : isTs ? `
      <div class="md-chart wide"><h4>時序預測——訓練脈絡＋外推 vs 實際</h4><canvas id="md-ts"></canvas></div>` : isAn ? `
      <div class="md-chart wide"><h4>健康分數趨勢（0–100）</h4><canvas id="md-health"></canvas></div>
      <div class="md-chart wide"><h4><span>FDC 關鍵感測器管制圖（SPC）</span>
        <select class="mini fdc-pick" id="fdc-sel"></select></h4><canvas id="md-fdc"></canvas></div>
      <div class="md-chart wide"><h4>風險值監控——風險值＋門檻</h4><canvas id="md-risk"></canvas></div>
      <div class="md-chart wide"><h4>風險貢獻度——超標點各感測器偏離程度</h4><canvas id="md-fi"></canvas></div>` : `
      <div class="md-chart"><h4>模型準確度 Actual – Predicted</h4><canvas id="md-pa"></canvas></div>
      <div class="md-chart"><h4>模型準確度 Actual – Error</h4><canvas id="md-err"></canvas></div>
      <div class="md-chart wide"><h4>${m.task === 'hybrid'
        ? `殘差修正重要變數${qi('殘差模型 r(x) 的變數重要性——AI 主要靠哪些變數修正「實際與模擬的差」。這裡排前面的變數，代表物理模擬在這些條件下與現場落差最大，值得回頭檢查模擬假設或現場儀器。')}`
        : '重要變數分析 Feature Importance'}</h4><canvas id="md-fi"></canvas></div>`;
  // PHM 摘要卡（Tukey PHM Edge 同款：健康分數/故障事件/超標率）
  const mcv = m.metrics_cv ?? {};
  const sumCards = isAn ? `
    <div class="sum-cards">
      <div class="sum-card">
        <div class="sc-label">AI 健康分數（近期）${qi(`${METRIC_TIPS['健康分數']} 「7 天後預測」＝以每日健康分數的穩健趨勢外推 7 天的估計值。`)}</div>
        <div class="sc-big" style="color:${healthColor(mcv.health_now ?? 0)}">${mcv.health_now ?? '—'}</div>
        <div class="sc-sub">${(mcv.health_now ?? 0) >= 70 ? '正常' : (mcv.health_now ?? 0) >= 40 ? '注意' : '危急'}｜0–100${
          mcv.health_7d != null ? `｜7 天後預測 <span style="color:${healthColor(mcv.health_7d)};font-weight:600">${mcv.health_7d}</span>` : ''}</div>
      </div>
      <div class="sum-card">
        <div class="sc-label">故障事件${qi(METRIC_TIPS['事件數'])}</div>
        <div class="sc-big" style="color:${(mcv.n_events ?? 0) ? 'var(--danger)' : 'var(--ok)'}">${mcv.n_events ?? 0}</div>
        <div class="sc-sub">連續超標段（依峰值排序）</div>
      </div>
      <div class="sum-card">
        <div class="sc-label">超標比例${qi(`${METRIC_TIPS['超標 %']} ${METRIC_TIPS['風險門檻']}`)}</div>
        <div class="sc-big">${mcv.exceed_pct ?? '—'}%</div>
        <div class="sc-sub">風險門檻 ${mcv.threshold ?? '—'}</div>
      </div>
    </div>` : '';
  // 故障事件列表（Tukey：FDC 管制圖下方整合型故障事件列表）
  const fmtEvT = (s) => new Date(s * 1000).toLocaleString('sv').slice(0, 16);
  const eventsTable = isAn && m.events?.length ? `
    <div class="md-chart wide" style="margin-top:20px"><h4>整合型故障事件列表</h4>
      <table class="md-metrics" style="margin:0;width:100%">
        <tr><th>開始</th><th>結束</th><th>持續（筆）</th><th>峰值風險</th><th>最低健康</th><th>主導感測器</th></tr>
        ${m.events.map((e) => `<tr><td>${fmtEvT(e.t_start)}</td><td>${fmtEvT(e.t_end)}</td>
          <td>${e.n}</td><td>${e.peak_risk}</td>
          <td style="color:${healthColor(e.min_health)}">${e.min_health}</td><td>${e.top_sensor}</td></tr>`).join('')}
      </table></div>` : '';
  const isHy = m.task === 'hybrid';
  const taskName = cls ? '分類' : isTs ? '時序預測（單變量）' : isAn
    ? `設備異常偵測（無監督）${qi('設備健康度的完整定義：模型以你提供的訓練資料為「健康運轉基準」，對每個時間點計算風險值（偏離基準的程度），再換算 0–100 健康分數——100＝完全貼合基準、50＝偏離達門檻、0＝偏離達門檻兩倍。重要前提：這是非監督式——訓練時沒有故障資料可參照，健康度代表『偏離平常運轉的程度』，不保證每次偏離都是故障；訓練資料若混入異常段，基準被汙染、分數會失準。對照：手上有標記過的故障資料時（監督式），可把故障標記當分類目標建分類模型，對已知故障型態判定準確度更高——兩種健康度的代表性不同，解讀要分清楚。')}`
    : isHy
      ? `混合模型（物理模擬＋AI 殘差）${qi(`預測＝代理模型 g(x)＋殘差模型 r(x)：g 學模擬基準欄「${m.sim_col}」（把物理模擬的知識蒸餾進 AI），r 學「實際−模擬」的殘差（儀器偏差、老化、模擬沒抓到的現場效應）。下方指標表有三方對比：純物理模擬的誤差、純 AI 的誤差、混合模型的誤差——混合通常最準，且物理基準來自受認證的模擬軟體，可信度有背書。新資料預測不需要模擬欄。`)}`
      : '迴歸';
  $('model-detail').innerHTML = `
    <h3 style="display:flex;align-items:center;gap:8px"><span id="md-name">${escHtml(m.name)}</span>
      <button class="mini" id="btn-rename" title="改名"
        style="width:auto;padding:2px 10px;font-size:12px;cursor:pointer">改名</button></h3>
    <div class="md-sub">${algoName}${qi(algoMeta?.desc)}｜${taskName}｜訓練資料 ${m.n_rows.toLocaleString()} 筆｜目標 ${m.target}</div>
    ${tuned}
    ${sumCards}
    <table class="md-metrics">
      <tr><th>模型指標</th>${heads.map(mh).join('')}</tr>
      ${isHy && m.compare ? `
        ${metricRow(`純物理模擬（基準欄 ${m.sim_col}）`, m.compare.sim, kind)}
        ${metricRow('純 AI（同演算法對照）', m.compare.ai, kind)}` : ''}
      ${isAn ? metricRow(m.val_desc ?? '健康基準', m.metrics_cv, kind)
        : metricRow(isHy ? `混合模型（${m.val_desc ?? '交叉驗證'}）` : (m.val_desc ?? '交叉驗證集'), m.metrics_cv, kind)
          + metricRow('訓練資料集', m.metrics_train, kind)}
      <tbody id="ev-metric-row"></tbody>
    </table>
    ${isHy && m.compare ? `<p class="hint" style="margin:-6px 0 14px">三方同折對比${qi('三行都在同一組驗證切分上計算，可直接比較：純物理模擬＝模擬基準欄直接當預測的誤差（物理模型與現場的差距）；純 AI＝同一演算法直接學實際值（沒有物理背書）；混合模型＝物理打底＋AI 修正——若混合列誤差最小，代表兩者互補成功。')}：
      混合模型是否同時勝過純模擬與純 AI，是這個模型值不值得採用的判準。</p>` : ''}
    <div class="md-charts">${charts}</div>
    ${eventsTable}
    ${isAn ? `
    <details class="md-app" id="app-thresh">
      <summary>風險值門檻試算——為異常偵測模型計算合理門檻</summary>
      <p class="hint" style="margin:8px 0">以不同統計方法對現行視圖的風險值分佈試算門檻；
        「套用」會更新此模型的建議門檻與風險圖。</p>
      <div class="opt-row">
        <select class="mini" id="th-method" style="width:auto">
          <option value="p99">風險值 99 百分位</option>
          <option value="p995">風險值 99.5 百分位</option>
          <option value="sigma3">平均 + 3 倍標準差</option>
          <option value="iqr">IQR 上界（Q3 + 1.5×IQR）</option>
        </select>${qi('門檻取法：99／99.5 百分位＝假設訓練段幾乎全健康，把最高的 1%／0.5% 風險值當分界（門檻越高越不易誤報、但可能晚報）；平均+3σ＝常態假設下約 0.1% 誤報率的經典管制界限；IQR 上界＝箱型圖離群判準（Q3+1.5×IQR），對偏態分布較穩健。試算只顯示結果，「試算並套用」才會改掉模型的門檻並重算健康分數與事件。')}
        <button class="dbtn" style="width:auto;padding:8px 22px;margin:0" id="btn-thresh">試算</button>
        <button class="dbtn" style="width:auto;padding:8px 22px;margin:0" id="btn-thresh-apply">試算並套用</button>
      </div>
      <div id="th-out"></div>
    </details>` : ''}
    <details class="md-app" id="app-eval">
      <summary>模型評估——以「現行資料視圖」重新評估（隨選）</summary>
      <p class="hint" style="margin:8px 0">${isAn
        ? '對現在這份資料（可含新上傳/新篩選段）以已訓練的健康基準計算風險值——監控新資料是否偏離健康狀態。'
        : '資料視圖若已改變（新增篩選步驟、樣板複用到新資料），這裡評的就是模型在現在這份資料上的表現，與上方訓練時指標對照可看外推退化。'}</p>
      <button class="dbtn" style="width:auto;padding:8px 22px" id="btn-eval">建立評估</button>
      <div id="ev-out">${m.evaluation ? '' : '<p class="hint" style="margin-top:8px">尚無評估——點擊「建立評估」開始。</p>'}</div>
    </details>
    ${(isTs || isAn) ? '' : `
    <details class="md-app" id="app-whatif">
      <summary>操作差異試算——改變輸入條件，看預測怎麼變（單筆試算）</summary>
      <p class="hint" style="margin:8px 0">基準值＝現行視圖各特徵中位數；留空＝維持基準。</p>
      <div class="wiz-params" id="wi-grid"></div>
      <button class="dbtn" style="width:auto;padding:8px 22px;margin-top:10px" id="btn-whatif">試算</button>
      <div id="wi-out"></div>
    </details>
    <details class="md-app" id="app-batch" ${m.batch ? 'open' : ''}>
      <summary>批次試算（品質結果試算）——上傳新資料整批預測</summary>
      <p class="hint" style="margin:8px 0">上傳含模型特徵欄的 CSV／Excel；含目標欄（${m.target}）時併算實際 vs 預測準確度，
        含時間欄時繪隨時間對比圖。完整結果（原欄＋預測欄）可下載。</p>
      <div class="opt-row">
        <input type="file" id="bt-file" accept=".csv,.xlsx,.xls,.xlsm" style="font-size:13px">
        <button class="dbtn" style="width:auto;padding:8px 22px;margin:0" id="btn-batch">執行試算</button>
      </div>
      <div id="bt-out"></div>
    </details>`}
    ${(cls || isTs || isAn) ? '' : `
    <details class="md-app" id="app-opt">
      <summary>配方優化（參數最佳化）——設定目標，輸出最佳參數建議</summary>
      <div class="opt-row">
        <select class="mini" id="opt-mode" style="width:auto">
          <option value="target">達到目標值</option>
          <option value="max">最大化 ${m.target}</option>
          <option value="min">最小化 ${m.target}</option>
        </select>
        <input class="mini" id="opt-value" type="number" step="any" placeholder="目標值" style="width:160px">
      </div>
      <label style="font-size:13px;color:var(--text2);margin:8px 0 4px;display:block">可調參數（未勾＝固定在基準值；邊界＝資料 P1–P99）</label>
      <div id="opt-knobs"></div>
      <button class="dbtn" style="width:auto;padding:8px 22px;margin-top:10px" id="btn-opt">執行優化</button>
      <div id="opt-out"></div>
    </details>`}
    <details class="md-app" id="app-ai" open>
      <summary>AI 助教——模型狀態評估與下一步建議${qi('本機 AI 引擎讀取這個模型的指標、重要變數、評估與試算結果，用白話評估目前狀態（好壞、過擬合跡象、可信度）並給下一步建議。每次開啟詳情自動評估一次；做了評估/門檻/批次試算等操作後可點「重新評估」更新。')}</summary>
      <div id="ai-model-out"></div>
      <button class="dbtn" style="width:auto;padding:8px 22px;margin-top:10px" id="btn-ai-model">重新評估</button>
    </details>`;
  $('model-detail').style.display = '';
  // 同步繪製（rAF 在背景分頁不會觸發，會整頁空圖）
  (() => {
    try {
    if (cls) drawCM($('md-cm'), m.plots.cm.labels, m.plots.cm.matrix);
    else if (isTs) drawTSF($('md-ts'), m.plots.tsf);
    else if (isAn) {
      if (m.plots.health) drawHealth($('md-health'), m.plots.health, m.plots.health_pred);
      drawRisk($('md-risk'), m.plots.risk);
      const fdc = m.plots.fdc;
      if (fdc?.cols?.length) {
        $('fdc-sel').innerHTML = fdc.cols.map((c, i) => `<option value="${i}">${c.name}</option>`).join('');
        const drawSel = () => drawFDC($('md-fdc'), fdc.t, fdc.cols[+$('fdc-sel').value]);
        $('fdc-sel').onchange = drawSel;
        drawSel();
      }
    } else {
      drawXY($('md-pa'), m.plots.pa.actual, m.plots.pa.pred, '實際值', '預測值', true);
      drawXY($('md-err'), m.plots.err.actual, m.plots.err.error, '實際值', '誤差值', false, true);
    }
    if (m.plots.fi && $('md-fi')) drawFI($('md-fi'), m.plots.fi.names, m.plots.fi.values);
    if (m.evaluation) renderEvaluation(m, m.evaluation);
    if (m.batch && $('bt-out')) renderBatch(m, m.batch);
    } catch (e) { console.error('detail charts:', e); }
  })();
  bindModelApps(m);
  // AI 助教：開詳情自動評估一次（本機引擎不在就顯示提示）
  $('btn-ai-model').addEventListener('click', () => aiAdvise('model', m.id, $('ai-model-out'), $('btn-ai-model')));
  aiAdvise('model', m.id, $('ai-model-out'), $('btn-ai-model'));
  $('model-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------------- 模型應用：評估 / 試算 / 優化
function renderEvaluation(m, ev) {
  const cls = m.task === 'classification';
  const isTs = m.task === 'timeseries';
  const isAn = m.task === 'anomaly';
  const kind = cls ? 'classification' : isAn ? 'anomaly' : 'regression';
  $('ev-metric-row').innerHTML = metricRow(`現行視圖評估（${ev.n_rows.toLocaleString()} 筆）`, ev.metrics, kind);
  $('ev-out').innerHTML = `
    <div class="md-sub" style="margin-top:10px">評估時間 ${ev.evaluated_at}｜${ev.n_rows.toLocaleString()} 筆</div>
    <table class="md-metrics">
      <tr><th>評估指標</th>${METRIC_HEADS[kind].map(mh).join('')}</tr>
      ${metricRow('現行視圖', ev.metrics, kind)}
    </table>
    <div class="md-chart" style="max-width:${(isTs || isAn) ? '100%' : '560px'}"><h4>${
      cls ? '混淆矩陣（現行視圖）' : isTs ? '時序預測 vs 實際（現行視圖）'
        : isAn ? '風險值監控（現行視圖）' : 'Actual – Predicted（現行視圖）'}</h4>
      <canvas id="ev-chart"></canvas></div>`;
  // 同步繪製（rAF 在背景分頁不觸發）
  if (cls) drawCM($('ev-chart'), ev.cm.labels, ev.cm.matrix);
  else if (isTs) drawTSF($('ev-chart'), ev.tsf);
  else if (isAn) drawRisk($('ev-chart'), ev.risk);
  else drawXY($('ev-chart'), ev.pa.actual, ev.pa.pred, '實際值', '預測值', true);
}

// 批次試算結果（品質結果試算）：資訊列＋指標＋實際vs預測圖＋變數散佈＋預覽表＋下載
function renderBatch(m, b) {
  const cls = m.task === 'classification';
  const kind = cls ? 'classification' : 'regression';
  const s = b.sample ?? {};
  const hasT = !!s.t?.length;
  const hasA = !!s.actual?.length;
  const charts = [];
  if (!cls && hasT) charts.push(`<div class="md-chart wide"><h4>預測目標隨時間變化${hasA ? '——實際 vs 預測' : ''}</h4><canvas id="bt-ts"></canvas></div>`);
  else if (!cls && hasA) charts.push('<div class="md-chart"><h4>實際值 vs 預測值</h4><canvas id="bt-avp"></canvas></div>');
  if (cls && b.cm) charts.push('<div class="md-chart"><h4>混淆矩陣（測試資料）</h4><canvas id="bt-cm"></canvas></div>');
  if (!cls && s.cols) charts.push(`<div class="md-chart wide"><h4><span>預測目標與變數關係</span>
      <select class="mini fdc-pick" id="bt-xsel">${m.features.map((f, i) => `<option value="${i}">${f}</option>`).join('')}</select>
    </h4><canvas id="bt-xy"></canvas></div>`);
  $('bt-out').innerHTML = `
    <div class="md-sub" style="margin-top:12px">測試資料 ${b.filename}｜${b.at}｜
      ${b.n_rows.toLocaleString()} 筆（可預測 ${b.n_pred.toLocaleString()} 筆）</div>
    ${b.metrics ? `<table class="md-metrics">
      <tr><th>試算指標</th>${METRIC_HEADS[kind].map(mh).join('')}</tr>
      ${metricRow('測試資料集', b.metrics, kind)}
    </table>` : '<p class="hint" style="margin:8px 0">測試資料未含目標欄——僅輸出預測值，無準確度指標。</p>'}
    <div class="md-charts">${charts.join('')}</div>
    ${b.preview?.rows?.length ? `
    <div class="md-chart wide" style="margin-top:16px"><h4>試算結果概覽（前 ${b.preview.rows.length} 列）</h4>
      <div style="overflow-x:auto"><table class="md-metrics" style="margin:0;white-space:nowrap">
        <tr>${b.preview.cols.map((c) => `<th>${c}</th>`).join('')}</tr>
        ${b.preview.rows.map((r) => `<tr>${r.map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')}
      </table></div></div>` : ''}
    <button class="dbtn" style="width:auto;padding:8px 22px;margin-top:12px" id="btn-bt-dl">下載完整試算結果</button>`;
  $('btn-bt-dl').addEventListener('click', () => {
    location.href = `/api/automl/${sid}/models/${m.id}/batch/download`;
  });
  try {
    if ($('bt-ts')) drawBatchTS($('bt-ts'), s);
    if ($('bt-avp')) drawXY($('bt-avp'), s.actual, s.pred, '實際值', '預測值', true);
    if ($('bt-cm')) drawCM($('bt-cm'), b.cm.labels, b.cm.matrix);
    if ($('bt-xy')) {
      const drawSel = () => drawXY($('bt-xy'), s.cols[m.features[+$('bt-xsel').value]], s.pred,
        m.features[+$('bt-xsel').value], '預測值', false);
      $('bt-xsel').onchange = drawSel;
      drawSel();
    }
  } catch (e) { console.error('batch charts:', e); }
}

// 批次試算時間圖：實際（深灰）vs 預測（主題色）
function drawBatchTS(canvas, s) {
  const ys = s.pred.concat(s.actual ?? []).filter((v) => v != null);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const pad = (hi - lo) * 0.08 || 1;
  const g = _timeAxes(canvas, s.t, lo - pad, hi + pad, 5);
  if (!g) return;
  const { ctx, M, px, py } = g;
  const line = (arr, color, wd) => {
    ctx.strokeStyle = color; ctx.lineWidth = wd;
    ctx.beginPath();
    let started = false;
    arr.forEach((v, i) => {
      if (v == null) { started = false; return; }
      const x = px(s.t[i]), y = py(v);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    });
    ctx.stroke(); ctx.lineWidth = 1;
  };
  if (s.actual) line(s.actual, '#4a5560', 1.4);
  line(s.pred, theme().selL, 1.6);
  ctx.fillStyle = '#4a5560';
  if (s.actual) ctx.fillText('— 實際值', M.l + 8, M.t + 12);
  ctx.fillStyle = theme().selL;
  ctx.fillText('— 預測值', M.l + (s.actual ? 70 : 8), M.t + 12);
}

// 通用時間軸底圖（0 尺寸防呆）：回 {ctx,M,w,h,px,py,isTime}
function _timeAxes(canvas, t, ylo, yhi, yTicks = 5) {
  const dpr = devicePixelRatio;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return null;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px Inter';
  const M = { l: 64, r: 16, t: 14, b: 44 };
  const isTime = t.length && t[t.length - 1] > 1e9;
  const xlo = Math.min(...t), xhi = Math.max(...t);
  const px = (v) => M.l + ((v - xlo) / ((xhi - xlo) || 1)) * (w - M.l - M.r);
  const py = (v) => h - M.b - ((v - ylo) / ((yhi - ylo) || 1)) * (h - M.t - M.b);
  ctx.textAlign = 'right';
  niceTicks(ylo, yhi, yTicks).forEach((tv) => {
    const y = py(tv);
    ctx.strokeStyle = C_GRID; ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke();
    ctx.fillStyle = C_LABEL; ctx.fillText(fmtTick(tv), M.l - 8, y + 3.5);
  });
  ctx.textAlign = 'left';
  Array.from({ length: 6 }, (_, i) => xlo + ((xhi - xlo) * i) / 5).forEach((tv) => {
    const x = px(tv);
    ctx.strokeStyle = C_AXIS; ctx.beginPath(); ctx.moveTo(x, h - M.b); ctx.lineTo(x, h - M.b + 4); ctx.stroke();
    ctx.fillStyle = C_LABEL;
    const lb = isTime ? fmtTime(tv) : fmtTick(tv);
    ctx.fillText(lb, x - ctx.measureText(lb).width / 2, h - M.b + 18);
  });
  ctx.strokeStyle = C_AXIS;
  ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, h - M.b); ctx.lineTo(w - M.r, h - M.b); ctx.stroke();
  return { ctx, M, w, h, px, py, isTime };
}

// 健康分數趨勢（0–100，Tukey PHM Edge 同款：綠正常/黃注意/紅危急區帶＋7 天預測虛線）
function drawHealth(canvas, hd, pred) {
  const tAll = pred?.t?.length ? hd.t.concat(pred.t) : hd.t;
  const g = _timeAxes(canvas, tAll, 0, 100, 5);
  if (!g) return;
  const { ctx, M, w, h, px, py } = g;
  // 三色狀態區帶（淡）
  const band = (lo, hi, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(M.l, py(hi), w - M.l - M.r, py(lo) - py(hi));
  };
  band(70, 100, 'rgba(24, 160, 88, 0.06)');
  band(40, 70, 'rgba(217, 119, 6, 0.06)');
  band(0, 40, 'rgba(208, 48, 80, 0.07)');
  // 分數線（分段依狀態上色）
  ctx.lineWidth = 1.6;
  for (let i = 1; i < hd.score.length; i++) {
    ctx.strokeStyle = healthColor(Math.min(hd.score[i - 1], hd.score[i]));
    ctx.beginPath();
    ctx.moveTo(px(hd.t[i - 1]), py(hd.score[i - 1]));
    ctx.lineTo(px(hd.t[i]), py(hd.score[i]));
    ctx.stroke();
  }
  // 7 天預測：現在分隔虛線＋預測虛線（從最後實際點接出）
  if (pred?.t?.length) {
    const tNow = hd.t[hd.t.length - 1];
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = C_AXIS;
    ctx.beginPath(); ctx.moveTo(px(tNow), M.t); ctx.lineTo(px(tNow), h - M.b); ctx.stroke();
    ctx.setLineDash([6, 5]);
    const pt = [tNow, ...pred.t];
    const ps = [hd.score[hd.score.length - 1], ...pred.score];
    for (let i = 1; i < ps.length; i++) {
      ctx.strokeStyle = healthColor(Math.min(ps[i - 1], ps[i]));
      ctx.beginPath();
      ctx.moveTo(px(pt[i - 1]), py(ps[i - 1]));
      ctx.lineTo(px(pt[i]), py(ps[i]));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = C_LABEL;
    const lb = `7 天預測 ${pred.day7 ?? pred.score[pred.score.length - 1]}`;
    ctx.fillText(lb, Math.min(px(tNow) + 6, w - M.r - ctx.measureText(lb).width), M.t + 12);
  }
  ctx.lineWidth = 1;
  ctx.fillStyle = C_LABEL;
  ctx.fillText('≥70 正常｜40–70 注意｜<40 危急', M.l + 8, g.M.t + 12);
}

// FDC/SPC 管制圖：感測器數值＋UCL/LCL（紅）＋UWL/LWL（黃）＋超限紅點
function drawFDC(canvas, t, col) {
  const pad = (col.ucl - col.lcl) * 0.15 || 1;
  const ylo = Math.min(col.lcl, ...col.y) - pad;
  const yhi = Math.max(col.ucl, ...col.y) + pad;
  const g = _timeAxes(canvas, t, ylo, yhi, 5);
  if (!g) return;
  const { ctx, M, w, px, py } = g;
  const hline = (v, color, label) => {
    ctx.strokeStyle = color; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(M.l, py(v)); ctx.lineTo(w - M.r, py(v)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.fillText(label, w - M.r - ctx.measureText(label).width, py(v) - 4);
  };
  hline(col.ucl, '#d03050', `UCL ${col.ucl}`);
  hline(col.lcl, '#d03050', `LCL ${col.lcl}`);
  hline(col.uwl, '#D97706', 'UWL');
  hline(col.lwl, '#D97706', 'LWL');
  ctx.strokeStyle = theme().selL; ctx.lineWidth = 1.3;
  ctx.beginPath();
  col.y.forEach((v, i) => { const x = px(t[i]), y = py(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.lineWidth = 1;
  ctx.fillStyle = '#d03050';
  col.y.forEach((v, i) => {
    if (v > col.ucl || v < col.lcl) { ctx.beginPath(); ctx.arc(px(t[i]), py(v), 2.5, 0, Math.PI * 2); ctx.fill(); }
  });
}

// 風險值監控圖：風險值線（主題色）＋門檻紅虛線＋超標紅點
function drawRisk(canvas, rk) {
  const dpr = devicePixelRatio;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px Inter';
  const M = { l: 64, r: 16, t: 14, b: 44 };
  const isTime = rk.t.length && rk.t[rk.t.length - 1] > 1e9;   // epoch 秒 vs 流水序
  const xlo = Math.min(...rk.t), xhi = Math.max(...rk.t);
  const ylo = 0, yhi = Math.max(...rk.risk, rk.threshold) * 1.05;
  const px = (v) => M.l + ((v - xlo) / ((xhi - xlo) || 1)) * (w - M.l - M.r);
  const py = (v) => h - M.b - ((v - ylo) / ((yhi - ylo) || 1)) * (h - M.t - M.b);
  ctx.textAlign = 'right';
  niceTicks(ylo, yhi, 5).forEach((tv) => {
    const y = py(tv);
    ctx.strokeStyle = C_GRID; ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke();
    ctx.fillStyle = C_LABEL; ctx.fillText(fmtTick(tv), M.l - 8, y + 3.5);
  });
  ctx.textAlign = 'left';
  Array.from({ length: 6 }, (_, i) => xlo + ((xhi - xlo) * i) / 5).forEach((tv) => {
    const x = px(tv);
    ctx.strokeStyle = C_AXIS; ctx.beginPath(); ctx.moveTo(x, h - M.b); ctx.lineTo(x, h - M.b + 4); ctx.stroke();
    ctx.fillStyle = C_LABEL;
    const lb = isTime ? fmtTime(tv) : fmtTick(tv);
    ctx.fillText(lb, x - ctx.measureText(lb).width / 2, h - M.b + 18);
  });
  ctx.strokeStyle = C_AXIS;
  ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, h - M.b); ctx.lineTo(w - M.r, h - M.b); ctx.stroke();
  // 風險值線
  ctx.strokeStyle = theme().selL; ctx.lineWidth = 1.4;
  ctx.beginPath();
  rk.risk.forEach((v, i) => { const x = px(rk.t[i]), y = py(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.lineWidth = 1;
  // 門檻紅虛線＋超標紅點
  ctx.strokeStyle = '#d03050'; ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(M.l, py(rk.threshold)); ctx.lineTo(w - M.r, py(rk.threshold)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#d03050';
  rk.risk.forEach((v, i) => {
    if (v > rk.threshold) { ctx.beginPath(); ctx.arc(px(rk.t[i]), py(v), 2.5, 0, Math.PI * 2); ctx.fill(); }
  });
  ctx.fillText(`門檻 ${rk.threshold}`, w - M.r - ctx.measureText(`門檻 ${rk.threshold}`).width, py(rk.threshold) - 6);
}

// 時序預測疊圖：訓練脈絡（淺灰）＋測試實際（深灰）＋外推預測（主題色）＋切分虛線
function drawTSF(canvas, tsf) {
  const dpr = devicePixelRatio;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px Inter';
  const M = { l: 64, r: 16, t: 14, b: 44 };
  const tAll = tsf.t_hist.concat(tsf.t_test);
  const yAll = tsf.y_hist.concat(tsf.y_test, tsf.pred);
  const xlo = Math.min(...tAll), xhi = Math.max(...tAll);
  const ylo = Math.min(...yAll), yhi = Math.max(...yAll);
  const px = (v) => M.l + ((v - xlo) / ((xhi - xlo) || 1)) * (w - M.l - M.r);
  const py = (v) => h - M.b - ((v - ylo) / ((yhi - ylo) || 1)) * (h - M.t - M.b);
  ctx.textAlign = 'right';
  niceTicks(ylo, yhi, 5).forEach((tv) => {
    const y = py(tv);
    ctx.strokeStyle = C_GRID; ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke();
    ctx.fillStyle = C_LABEL; ctx.fillText(fmtTick(tv), M.l - 8, y + 3.5);
  });
  ctx.textAlign = 'left';
  Array.from({ length: 6 }, (_, i) => xlo + ((xhi - xlo) * i) / 5).forEach((tv) => {
    const x = px(tv);
    ctx.strokeStyle = C_AXIS; ctx.beginPath(); ctx.moveTo(x, h - M.b); ctx.lineTo(x, h - M.b + 4); ctx.stroke();
    ctx.fillStyle = C_LABEL;
    const lb = fmtTime(tv);
    ctx.fillText(lb, x - ctx.measureText(lb).width / 2, h - M.b + 18);
  });
  ctx.strokeStyle = C_AXIS;
  ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, h - M.b); ctx.lineTo(w - M.r, h - M.b); ctx.stroke();
  const line = (ts, ys, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    ys.forEach((v, i) => { const x = px(ts[i]), y = py(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.lineWidth = 1;
  };
  line(tsf.t_hist, tsf.y_hist, '#C3C8D0', 1.2);
  line(tsf.t_test, tsf.y_test, '#6B7280', 1.4);
  line(tsf.t_test, tsf.pred, theme().selL, 1.8);
  // 訓練／測試切分虛線
  const xSplit = px(tsf.t_test[0]);
  ctx.strokeStyle = C_LABEL; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(xSplit, M.t); ctx.lineTo(xSplit, h - M.b); ctx.stroke();
  ctx.setLineDash([]);
  // 圖例
  const legend = [['訓練段', '#C3C8D0'], ['實際', '#6B7280'], ['外推預測', theme().selL]];
  let lx = w - 250;
  legend.forEach(([txt, color]) => {
    ctx.fillStyle = color; ctx.fillRect(lx, M.t, 16, 3);
    ctx.fillStyle = C_LABEL; ctx.fillText(txt, lx + 20, M.t + 5);
    lx += 30 + ctx.measureText(txt).width + 20;
  });
}

// 時序線圖：實際（灰）vs 預測（主題色）
function drawTS(canvas, t, actual, pred) {
  const dpr = devicePixelRatio;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px Inter';
  const M = { l: 64, r: 16, t: 14, b: 44 };
  const xlo = Math.min(...t), xhi = Math.max(...t);
  const all = actual.concat(pred);
  const ylo = Math.min(...all), yhi = Math.max(...all);
  const px = (v) => M.l + ((v - xlo) / ((xhi - xlo) || 1)) * (w - M.l - M.r);
  const py = (v) => h - M.b - ((v - ylo) / ((yhi - ylo) || 1)) * (h - M.t - M.b);
  ctx.textAlign = 'right';
  niceTicks(ylo, yhi, 5).forEach((tv) => {
    const y = py(tv);
    ctx.strokeStyle = C_GRID; ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke();
    ctx.fillStyle = C_LABEL; ctx.fillText(fmtTick(tv), M.l - 8, y + 3.5);
  });
  ctx.textAlign = 'left';
  Array.from({ length: 6 }, (_, i) => xlo + ((xhi - xlo) * i) / 5).forEach((tv) => {
    const x = px(tv);
    ctx.strokeStyle = C_AXIS; ctx.beginPath(); ctx.moveTo(x, h - M.b); ctx.lineTo(x, h - M.b + 4); ctx.stroke();
    ctx.fillStyle = C_LABEL;
    const lb = fmtTime(tv);
    ctx.fillText(lb, x - ctx.measureText(lb).width / 2, h - M.b + 18);
  });
  ctx.strokeStyle = C_AXIS;
  ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, h - M.b); ctx.lineTo(w - M.r, h - M.b); ctx.stroke();
  const line = (ys, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    ys.forEach((v, i) => { const x = px(t[i]), y = py(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke(); ctx.lineWidth = 1;
  };
  line(actual, '#9AA1AC', 1.2);
  line(pred, theme().selL, 1.6);
  // 圖例
  ctx.fillStyle = '#9AA1AC'; ctx.fillRect(w - 150, M.t, 16, 3);
  ctx.fillStyle = C_LABEL; ctx.fillText('實際', w - 128, M.t + 5);
  ctx.fillStyle = theme().selL; ctx.fillRect(w - 90, M.t, 16, 3);
  ctx.fillStyle = C_LABEL; ctx.fillText('預測', w - 68, M.t + 5);
}

function bindModelApps(m) {
  const cls = m.task === 'classification';
  // 模型改名（Tukey ⋮ 對齊）：h3 內就地編輯，不用原生對話框（會凍 renderer）
  $('btn-rename').addEventListener('click', async () => {
    const span = $('md-name');
    if (span.querySelector('input')) return;
    const old = span.textContent;
    span.innerHTML = `<input class="mini" value="${old.replace(/"/g, '&quot;')}"
      style="width:260px;font-size:15px;font-weight:600">`;
    const inp = span.querySelector('input');
    inp.focus(); inp.select();
    const commit = async () => {
      const name = inp.value.trim();
      if (!name || name === old) { span.textContent = old; return; }
      try {
        await apiML(`/models/${m.id}/rename`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        span.textContent = name;
        await renderModels();
      } catch (e) { span.textContent = old; console.error('rename:', e); }
    };
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commit();
      if (ev.key === 'Escape') span.textContent = old;
    });
    inp.addEventListener('blur', commit);
  });

  $('btn-eval').addEventListener('click', async () => {
    $('btn-eval').disabled = true;
    try {
      const ev = await apiML(`/models/${m.id}/evaluate`, { method: 'POST' });
      renderEvaluation(m, ev);
    } catch (e) {
      $('ev-out').innerHTML = `<p class="hint" style="margin-top:8px;color:var(--danger)">評估失敗：${e.message}</p>`;
    } finally { $('btn-eval').disabled = false; }
  });

  // 批次試算（品質結果試算）：上傳測試資料集整批預測
  if ($('btn-batch')) {
    $('btn-batch').addEventListener('click', async () => {
      const f = $('bt-file').files[0];
      if (!f) {
        $('bt-out').innerHTML = '<p class="hint" style="margin-top:8px">請先選擇測試資料檔（CSV／Excel）。</p>';
        return;
      }
      $('btn-batch').disabled = true;
      $('bt-out').innerHTML = '<p class="hint" style="margin-top:8px">試算中…</p>';
      try {
        const fd = new FormData();
        fd.append('file', f);
        const b = await apiML(`/models/${m.id}/batch`, { method: 'POST', body: fd });
        renderBatch(m, b);
      } catch (e) {
        $('bt-out').innerHTML = `<p class="hint" style="margin-top:8px;color:var(--danger)">批次試算失敗：${e.message}</p>`;
      } finally { $('btn-batch').disabled = false; }
    });
  }

  // 風險值門檻試算（異常偵測）
  if ($('app-thresh')) {
    const runThresh = async (apply) => {
      $('btn-thresh').disabled = $('btn-thresh-apply').disabled = true;
      try {
        const r = await apiML(`/models/${m.id}/threshold`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: $('th-method').value, apply }),
        });
        $('th-out').innerHTML = `
          <table class="md-metrics" style="margin-top:12px">
            <tr><th>方法</th><th>門檻</th><th>超標筆數</th><th>超標比例</th></tr>
            <tr><td>${r.method_name}</td><td><b>${r.threshold}</b></td>
              <td>${r.exceed.toLocaleString()} / ${r.n_rows.toLocaleString()}</td><td>${r.exceed_pct}%</td></tr>
          </table>${r.applied ? '<p class="hint" style="margin-top:6px">已套用為模型建議門檻。</p>' : ''}`;
        if (apply) await openModelDetail(m.id);
      } catch (e) {
        $('th-out').innerHTML = `<p class="hint" style="margin-top:8px;color:var(--danger)">門檻試算失敗：${e.message}</p>`;
      }
      finally {
        if ($('btn-thresh')) { $('btn-thresh').disabled = $('btn-thresh-apply').disabled = false; }
      }
    };
    $('btn-thresh').addEventListener('click', () => runThresh(false));
    $('btn-thresh-apply').addEventListener('click', () => runThresh(true));
  }

  // what-if：開啟時抓 baseline 填 placeholder（時序/異常模型無此區）
  if (!$('app-whatif')) return;
  let wiLoaded = false;
  $('app-whatif').addEventListener('toggle', async () => {
    if (!$('app-whatif').open || wiLoaded) return;
    wiLoaded = true;
    try {
      const base = (await apiML(`/models/${m.id}/whatif`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"values":{}}',
      })).baseline;
      $('wi-grid').innerHTML = m.features.map((f) => `
        <div class="wp"><label>${f}</label>
          <input data-f="${f}" type="number" step="any" placeholder="基準 ${base[f]}"></div>`).join('');
    } catch (e) { $('wi-grid').innerHTML = `<p class="hint">${e.message}</p>`; }
  });
  $('btn-whatif').addEventListener('click', async () => {
    const values = {};
    $('wi-grid').querySelectorAll('input[data-f]').forEach((i) => { if (i.value !== '') values[i.dataset.f] = +i.value; });
    $('btn-whatif').disabled = true;
    try {
      const r = await apiML(`/models/${m.id}/whatif`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      $('wi-out').innerHTML = cls ? `
        <table class="md-metrics" style="margin-top:12px">
          <tr><th>基準預測</th><th>試算預測</th><th>是否改變</th></tr>
          <tr><td>${r.baseline_pred}</td><td>${r.pred}</td>
            <td>${r.changed ? '<b class="wi-up">類別改變</b>' : '不變'}</td></tr>
        </table>${r.proba ? `<div class="md-sub" style="margin-top:6px">機率：${
          Object.entries(r.proba).map(([k, v]) => `${k} ${v}`).join('、')}</div>` : ''}` : `
        <table class="md-metrics" style="margin-top:12px">
          <tr><th>基準預測 ${m.target}</th><th>試算預測</th><th>差異 Δ</th></tr>
          <tr><td>${r.baseline_pred}</td><td>${r.pred}</td>
            <td class="${r.delta > 0 ? 'wi-up' : r.delta < 0 ? 'wi-dn' : ''}">${r.delta > 0 ? '+' : ''}${r.delta}</td></tr>
        </table>`;
    } catch (e) { alert(`試算失敗：${e.message}`); } finally { $('btn-whatif').disabled = false; }
  });

  if (cls || !$('app-opt')) return;
  // 配方優化
  $('opt-knobs').innerHTML = `<div class="feat-grid" style="max-height:150px">${
    m.features.map((f) => `<label><input type="checkbox" checked value="${f}">${f}</label>`).join('')}</div>`;
  $('opt-mode').addEventListener('change', () => {
    $('opt-value').style.display = $('opt-mode').value === 'target' ? '' : 'none';
  });
  $('btn-opt').addEventListener('click', async () => {
    const knobs = [...$('opt-knobs').querySelectorAll('input:checked')].map((i) => i.value);
    const mode = $('opt-mode').value;
    if (mode === 'target' && $('opt-value').value === '') { alert('請輸入目標值'); return; }
    $('btn-opt').disabled = true;
    $('opt-out').innerHTML = '<p class="hint" style="margin-top:8px">搜尋中…（隨機搜尋 3000 組＋鄰域細化）</p>';
    try {
      const r = await apiML(`/models/${m.id}/optimize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, value: $('opt-value').value, knobs }),
      });
      $('opt-out').innerHTML = `
        <table class="md-metrics" style="margin-top:12px">
          <tr><th>參數</th><th>基準值</th><th>建議值</th><th>變化</th><th>搜尋邊界</th></tr>
          ${Object.keys(r.best).map((k) => {
            const d = r.best[k] - r.baseline[k];
            return `<tr><td>${k}</td><td>${r.baseline[k]}</td><td><b>${r.best[k]}</b></td>
              <td class="${d > 0 ? 'wi-up' : d < 0 ? 'wi-dn' : ''}">${d > 0 ? '+' : ''}${Math.round(d * 100000) / 100000}</td>
              <td>[${r.bounds[k][0]}, ${r.bounds[k][1]}]</td></tr>`;
          }).join('')}
        </table>
        <table class="md-metrics" style="margin-top:10px">
          <tr><th>基準預測 ${m.target}</th><th>建議配方預測</th>${mode === 'target' ? '<th>目標值</th>' : ''}</tr>
          <tr><td>${r.baseline_pred}</td><td><b>${r.pred}</b></td>${mode === 'target' ? `<td>${r.value}</td>` : ''}</tr>
        </table>`;
    } catch (e) { $('opt-out').innerHTML = `<p class="hint" style="margin-top:8px">優化失敗：${e.message}</p>`; }
    finally { $('btn-opt').disabled = false; }
  });
}

// 混淆矩陣（深淺＝筆數，主題色）
function drawCM(canvas, labels, matrix) {
  const dpr = devicePixelRatio;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11.5px Inter';
  const n = labels.length;
  const M = { l: 90, r: 16, t: 28, b: 48 };
  const cw = (w - M.l - M.r) / n, ch = (h - M.t - M.b) / n;
  const maxV = Math.max(...matrix.flat(), 1);
  matrix.forEach((rowArr, i) => rowArr.forEach((v, j) => {
    const x = M.l + j * cw, y = M.t + i * ch;
    ctx.fillStyle = v ? ink(v / maxV) : '#F6F7FA';
    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
    ctx.fillStyle = v / maxV > 0.55 ? '#fff' : C_LABEL;
    const t = String(v);
    ctx.fillText(t, x + cw / 2 - ctx.measureText(t).width / 2, y + ch / 2 + 4);
  }));
  ctx.fillStyle = C_LABEL;
  labels.forEach((lb, j) => {
    const t = String(lb).slice(0, 10);
    ctx.fillText(t, M.l + j * cw + cw / 2 - ctx.measureText(t).width / 2, h - M.b + 16);
  });
  ctx.textAlign = 'right';
  labels.forEach((lb, i) => ctx.fillText(String(lb).slice(0, 10), M.l - 8, M.t + i * ch + ch / 2 + 4));
  ctx.textAlign = 'left';
  ctx.fillText('預測類別', M.l + (w - M.l - M.r) / 2 - 24, h - 8);
  ctx.save(); ctx.translate(14, M.t + (h - M.t - M.b) / 2 + 24); ctx.rotate(-Math.PI / 2);
  ctx.fillText('實際類別', 0, 0); ctx.restore();
}

// XY 散佈（diag=對角參考線；zero=誤差零線）
function drawXY(canvas, xs, ys, xLabel, yLabel, diag = false, zero = false) {
  const dpr = devicePixelRatio;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px Inter';
  const M = { l: 64, r: 16, t: 12, b: 44 };
  let xlo = Math.min(...xs), xhi = Math.max(...xs);
  let ylo = Math.min(...ys), yhi = Math.max(...ys);
  if (diag) { xlo = ylo = Math.min(xlo, ylo); xhi = yhi = Math.max(xhi, yhi); }
  const px = (v) => M.l + ((v - xlo) / ((xhi - xlo) || 1)) * (w - M.l - M.r);
  const py = (v) => h - M.b - ((v - ylo) / ((yhi - ylo) || 1)) * (h - M.t - M.b);
  ctx.textAlign = 'right';
  niceTicks(ylo, yhi, 5).forEach((tv) => {
    const y = py(tv);
    ctx.strokeStyle = C_GRID; ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(w - M.r, y); ctx.stroke();
    ctx.fillStyle = C_LABEL; ctx.fillText(fmtTick(tv), M.l - 8, y + 3.5);
  });
  ctx.textAlign = 'left';
  niceTicks(xlo, xhi, 6).forEach((tv) => {
    const x = px(tv);
    ctx.strokeStyle = C_AXIS; ctx.beginPath(); ctx.moveTo(x, h - M.b); ctx.lineTo(x, h - M.b + 4); ctx.stroke();
    ctx.fillStyle = C_LABEL;
    const lb = fmtTick(tv);
    ctx.fillText(lb, x - ctx.measureText(lb).width / 2, h - M.b + 17);
  });
  ctx.strokeStyle = C_AXIS;
  ctx.beginPath(); ctx.moveTo(M.l, M.t); ctx.lineTo(M.l, h - M.b); ctx.lineTo(w - M.r, h - M.b); ctx.stroke();
  if (diag) { ctx.strokeStyle = C_LABEL; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(px(xlo), py(xlo)); ctx.lineTo(px(xhi), py(xhi)); ctx.stroke(); ctx.setLineDash([]); }
  if (zero) { ctx.strokeStyle = C_LABEL; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(M.l, py(0)); ctx.lineTo(w - M.r, py(0)); ctx.stroke(); ctx.setLineDash([]); }
  ctx.fillStyle = theme().dot;
  xs.forEach((xv, i) => { ctx.beginPath(); ctx.arc(px(xv), py(ys[i]), 2.2, 0, Math.PI * 2); ctx.fill(); });
  ctx.fillStyle = C_LABEL;
  ctx.fillText(xLabel, (w - ctx.measureText(xLabel).width) / 2, h - 6);
  ctx.save(); ctx.translate(12, (h + ctx.measureText(yLabel).width) / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(yLabel, 0, 0); ctx.restore();
}

// Feature importance 水平條（依重要度深淺）
function drawFI(canvas, names, values) {
  const dpr = devicePixelRatio;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11.5px Inter';
  const M = { l: Math.min(280, Math.max(...names.map((n) => ctx.measureText(n).width)) + 20), r: 60, t: 8, b: 8 };
  const maxV = Math.max(...values, 1e-12);
  const rowH = Math.min(26, (h - M.t - M.b) / names.length);
  names.forEach((n, i) => {
    const y = M.t + i * rowH;
    const bw = Math.max((values[i] / maxV) * (w - M.l - M.r), 1);
    ctx.fillStyle = ink(values[i] / maxV);
    ctx.fillRect(M.l, y + 3, bw, rowH - 7);
    ctx.fillStyle = C_LABEL;
    ctx.textAlign = 'right'; ctx.fillText(n, M.l - 8, y + rowH / 2 + 4);
    ctx.textAlign = 'left'; ctx.fillText(String(values[i]), M.l + bw + 6, y + rowH / 2 + 4);
  });
  ctx.textAlign = 'left';
}

// ------------------------------------------------------------ 建模精靈
let wizMode = 'auto';
const openWizard = async () => {
  await loadAlgoMeta();
  wizMode = 'auto';
  $('wiz-name').value = '';   // 清掉上次殘留的名稱
  $('model-wizard').classList.add('open');
  $('wiz-step-mode').style.display = '';
  $('wiz-step-form').style.display = 'none';
  document.querySelectorAll('.wiz-mode').forEach((c) => c.classList.toggle('on', c.dataset.mode === 'auto'));
};
$('btn-new-model').addEventListener('click', openWizard);
$('btn-model-empty').addEventListener('click', openWizard);
$('wiz-close').addEventListener('click', () => $('model-wizard').classList.remove('open'));
$('wiz-mode-cancel').addEventListener('click', () => $('model-wizard').classList.remove('open'));
document.querySelectorAll('.wiz-mode').forEach((c) => c.addEventListener('click', () => {
  wizMode = c.dataset.mode;
  document.querySelectorAll('.wiz-mode').forEach((x) => x.classList.toggle('on', x === c));
}));
$('wiz-back').addEventListener('click', () => {
  $('wiz-step-form').style.display = 'none';
  $('wiz-step-mode').style.display = '';
});

$('wiz-mode-ok').addEventListener('click', () => {
  const numeric = state.columns.filter((c) => !c.hidden && c.name !== '__id__' &&
    (c.dtype.startsWith('float') || c.dtype.startsWith('int')));
  // 字串欄可當分類目標（任務由後端依欄型態自動判定）
  const stringCols = state.columns.filter((c) => !c.hidden && c.name !== '__id__' &&
    !c.dtype.startsWith('float') && !c.dtype.startsWith('int') && !c.dtype.startsWith('datetime'));
  $('wiz-form-title').textContent = wizMode === 'auto'
    ? '全自動建立——全部適用演算法各建一個模型（自動調參）' : '手動建立模型';
  $('wiz-target').innerHTML = numeric.map((c) => `<option>${c.name}</option>`).join('')
    + stringCols.map((c) => `<option value="${c.name}">${c.name}（分類）</option>`).join('');
  const renderFeatures = () => {
    const tgt = $('wiz-target').value;
    const isAn = $('wiz-task').value === 'anomaly';   // 異常偵測無目標，不排除任何欄
    const sim = $('wiz-task').value === 'hybrid' ? $('wiz-sim-col').value : null;
    $('wiz-features').innerHTML = numeric.filter((c) => (isAn || c.name !== tgt) && c.name !== sim).map((c) =>
      `<label><input type="checkbox" checked value="${c.name}">${c.name}</label>`).join('');
  };
  $('wiz-sim-col').onchange = renderFeatures;
  $('wiz-target').onchange = () => { renderFeatures(); renderAlgos(); };
  renderFeatures();
  // 任務型態：時序預測需要時間欄；時序＝單變量（特徵工程請於上傳前完成）
  const hasTime = state.columns.some((c) => !c.hidden && c.dtype.startsWith('datetime'));
  $('wiz-task').value = 'auto';
  $('wiz-task').querySelector('[value="timeseries"]').disabled = !hasTime;
  const taskKey = () => {
    if ($('wiz-task').value === 'timeseries') return 'timeseries';
    if ($('wiz-task').value === 'anomaly') return 'anomaly';
    if ($('wiz-task').value === 'hybrid') return 'hybrid';
    const tgt = state.columns.find((c) => c.name === $('wiz-target').value);
    const isNum = tgt && (tgt.dtype.startsWith('float') || tgt.dtype.startsWith('int'));
    return isNum ? 'regression' : 'classification';
  };
  const syncTask = () => {
    const tv = $('wiz-task').value;
    const isTs = tv === 'timeseries';
    const isAn = tv === 'anomaly';
    const isHy = tv === 'hybrid';
    $('wiz-ts-cfg').style.display = isTs ? '' : 'none';
    $('wiz-anom-cfg').style.display = isAn ? '' : 'none';
    $('wiz-hybrid-cfg').style.display = isHy ? '' : 'none';
    $('wiz-val-cfg').style.display = (isTs || isAn) ? 'none' : '';
    $('wiz-target').style.display = isAn ? 'none' : '';
    $('wiz-target').previousElementSibling.style.display = isAn ? 'none' : '';
    $('wiz-feat-label').style.display = isTs ? 'none' : '';
    $('wiz-features').style.display = isTs ? 'none' : '';
    $('wiz-feat-label').textContent = isAn ? '監測欄位（設備感測器，至少兩欄）' : '自變數（預設全選）';
    if (isHy) {
      // 模擬基準欄候選＝數值欄扣掉目標欄
      const tgt = $('wiz-target').value;
      $('wiz-sim-col').innerHTML = numeric.filter((c) => c.name !== tgt)
        .map((c) => `<option>${c.name}</option>`).join('');
    }
    renderFeatures();
    renderAlgos();
  };
  $('wiz-task').onchange = syncTask;
  // 驗證方法動態參數
  const VAL_HINTS = {
    kfold: 'K 折：資料分 K 份輪流當驗證集；不洗牌＝依資料順序切。',
    holdout: '保留法：切出一段當測試集；勾洗牌＝隨機抽樣、不勾＝取資料末端（時間排序資料建議不勾）。',
    timesplit: '時序切分：只用過去預測未來的走前驗證，永不洗牌；折數＝輸入框數字。',
  };
  const syncVal = () => {
    const m = $('wiz-val-method').value;
    $('wiz-val-k-wrap').style.display = m === 'holdout' ? 'none' : '';
    $('wiz-val-ts-wrap').style.display = m === 'holdout' ? '' : 'none';
    $('wiz-val-shuffle-wrap').style.display = m === 'timesplit' ? 'none' : '';
    $('wiz-val-hint').textContent = VAL_HINTS[m];
  };
  $('wiz-val-method').onchange = syncVal;
  syncVal();

  const renderAlgos = () => {
    if (wizMode !== 'manual') return;
    const tk = taskKey();
    // 混合模型的代理與殘差都是迴歸管線 → 用迴歸演算法集
    const filterTk = tk === 'hybrid' ? 'regression' : tk;
    const list = ALGO_META.filter((a) => a.tasks.includes(filterTk));
    const def = tk === 'timeseries' ? 'ARIMA' : tk === 'anomaly' ? 'PCA_T2' : 'XGB';
    $('wiz-algo').innerHTML = list.map((a) =>
      `<option value="${a.key}" ${a.key === def ? 'selected' : ''}>${a.name}</option>`).join('');
    renderParams();
  };
  const renderParams = () => {
    const meta = ALGO_META.find((a) => a.key === $('wiz-algo').value);
    if (!meta) { $('wiz-params').innerHTML = ''; $('wiz-algo-desc').textContent = ''; return; }
    $('wiz-algo-desc').textContent = meta.desc ?? '';
    // 數值輸入的步進：後端 schema 指定 step（float），int 預設 1——step="any" 的箭頭是一次跳 1
    $('wiz-params').innerHTML = meta.params.length ? meta.params.map((p) => `
      <div class="wp"><label>${p.label}${qi(p.desc)}</label>${
      p.type === 'choice'
        ? `<select data-key="${p.key}">${p.choices.map((c) => `<option ${c === p.default ? 'selected' : ''}>${c}</option>`).join('')}</select>`
        : p.type === 'str'
          ? `<input data-key="${p.key}" type="text" placeholder="預設 ${p.default ?? '自動'}">`
          : `<input data-key="${p.key}" type="number" step="${p.step ?? (p.type === 'int' ? 1 : 'any')}"
               ${p.min != null ? `min="${p.min}"` : ''} ${p.max != null ? `max="${p.max}"` : ''}
               placeholder="預設 ${p.default ?? '自動'}">`}</div>`).join('')
      : '<p class="hint" style="grid-column:1/-1">此演算法無關鍵超參數（用預設即可）</p>';
    $('wiz-tune').disabled = !meta.tunable || taskKey() === 'timeseries';
  };
  $('wiz-manual-only').style.display = wizMode === 'manual' ? '' : 'none';
  if (wizMode === 'manual') $('wiz-algo').onchange = renderParams;
  syncTask();
  $('wiz-step-mode').style.display = 'none';
  $('wiz-step-form').style.display = '';
});

$('wiz-submit').addEventListener('click', async () => {
  const isTs = $('wiz-task').value === 'timeseries';
  const isAn = $('wiz-task').value === 'anomaly';
  const features = [...$('wiz-features').querySelectorAll('input:checked')].map((i) => i.value);
  if (!features.length && !isTs) { alert(isAn ? '至少勾選兩個監測欄位' : '至少勾選一個自變數'); return; }
  if (isAn && features.length < 2) { alert('異常偵測至少需要兩個監測欄位'); return; }
  const body = {
    mode: wizMode,
    name: $('wiz-name').value.trim(),
    target: $('wiz-target').value,
    features,
  };
  if (isAn) {
    body.task_type = 'anomaly';
  } else if (isTs) {
    body.task_type = 'timeseries';
    body.test_size = (+$('wiz-ts-test').value || 20) / 100;
    body.features = [];
  } else if ($('wiz-task').value === 'hybrid') {
    body.task_type = 'hybrid';
    body.sim_col = $('wiz-sim-col').value;
    body.validation = {
      method: $('wiz-val-method').value,
      k: +$('wiz-val-k').value || 5,
      test_size: (+$('wiz-val-test').value || 20) / 100,
      n_splits: +$('wiz-val-k').value || 5,
      shuffle: $('wiz-val-shuffle').checked,
    };
  } else {
    body.validation = {
      method: $('wiz-val-method').value,
      k: +$('wiz-val-k').value || 5,
      test_size: (+$('wiz-val-test').value || 20) / 100,
      n_splits: +$('wiz-val-k').value || 5,
      shuffle: $('wiz-val-shuffle').checked,
    };
  }
  if (wizMode === 'manual') {
    body.algo = $('wiz-algo').value;
    body.auto_tune = $('wiz-tune').checked;
    body.params = {};
    $('wiz-params').querySelectorAll('[data-key]').forEach((el) => {
      if (el.value !== '') body.params[el.dataset.key] = el.value;
    });
  }
  $('wiz-submit').disabled = true;
  try {
    await apiML('/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('model-wizard').classList.remove('open');
    await renderModels();
  } catch (e) {
    alert(`建立失敗：${e.message}`);
  } finally {
    $('wiz-submit').disabled = false;
  }
});

// ------------------------------------------------------------ 資料健檢
$('btn-health').addEventListener('click', async () => {
  const res = await api('/health');
  // __id__ 與時間欄本來就是流水號/時戳，ID-ness 警告屬預期，不列出
  const issues = res.issues.filter((it) => it.col !== '__id__'
    && !state.columns.find((c) => c.name === it.col)?.dtype.startsWith('datetime'));
  $('health-out').innerHTML = issues.length
    ? issues.map((it) => `<div class="props-result"><b>${it.col}</b><br>${it.warnings.join('<br>')}</div>`).join('')
    : '<div class="props-result"><span class="good">全數欄位通過三判準</span></div>';
});

$('btn-scan').addEventListener('click', async () => {
  const res = await api('/scan');
  if (!res.hits.length) {
    $('scan-out').innerHTML = '<div class="props-result"><span class="good">未掃出異常（預設參數）</span></div>';
    return;
  }
  const ruleName = Object.fromEntries(res.rules.map((r) => [r.kind, r.name]));
  const ruleParams = Object.fromEntries(res.rules.map((r) => [r.kind, r.params]));
  $('scan-out').innerHTML = res.hits.flatMap((row) =>
    res.rules.filter((r) => row[r.kind] > 0).map((r) => `
      <label class="scan-row">
        <input type="checkbox" data-col="${row.col}" data-kind="${r.kind}">
        ${row.col}｜${ruleName[r.kind]}
        <span class="cnt">${row[r.kind]} 筆</span>
      </label>`)).join('')
    + '<button class="dbtn" id="btn-scan-apply" style="margin-top:8px">將勾選項加入編輯歷程</button>';
  $('btn-scan-apply').addEventListener('click', async () => {
    const checked = [...$('scan-out').querySelectorAll('input:checked')];
    if (!checked.length) { alert('請先勾選要加入的規則'); return; }
    snapshotSteps();
    for (const inp of checked) {
      const kind = inp.dataset.kind;
      const col = inp.dataset.col;
      await api('/steps', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, label: `${ruleName[kind]}（${col}）`,
          params: { col, ...ruleParams[kind] } }),
      });
    }
    $('scan-out').innerHTML = '';
    await refreshState();
  });
});

// ------------------------------------------------------------ AI 小精靈（右下角，與孿生/E3D 共用模組）
import('/static/js/sprite.js').then(({ initSprite }) =>
  initSprite({ page: 'data', bottom: 16, context: () => window.JS_DATA_CTX?.() ?? {} })).catch(() => {});

// ------------------------------------------------------------ 圓圈問號懸浮說明
// 泡泡掛 body＋fixed 定位：不被表格/卡片的 overflow 裁切；事件 delegation 涵蓋動態內容
(() => {
  const pop = document.createElement('div');
  pop.className = 'qi-pop';
  document.body.appendChild(pop);
  document.addEventListener('mouseover', (e) => {
    const q = e.target.closest?.('.qi');
    if (!q) { if (pop.style.display !== 'none') pop.style.display = 'none'; return; }
    pop.textContent = q.dataset.tip ?? '';
    pop.style.display = 'block';
    const r = q.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let x = r.left + r.width / 2 - pw / 2;
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    let y = r.top - ph - 9;
    if (y < 8) y = r.bottom + 9;   // 上方放不下改下方
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
  });
})();

// ------------------------------------------------------------ 流體物性（進階，選配）
async function refreshPropsFluids() {
  const fl = await fetch('/api/data/props/fluids').then((r) => r.json());
  $('fluid-list').innerHTML = fl.map((f) => `<option value="${f}">`).join('');
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
  if (!$('props-fluid').value) { alert('請先搜尋並選定製程流體'); return; }
  if (!$('props-tcol').value) { alert('請選溫度欄位'); return; }
  snapshotSteps();
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
  if (!$('props-fluid').value) { alert('請先搜尋並選定製程流體'); return; }
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
