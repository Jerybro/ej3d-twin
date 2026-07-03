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
  history.replaceState(null, '', `?sid=${body.sid}`);
  enterSession(body.sid, body.filename);
}

async function enterSession(newSid, filename) {
  sid = newSid;
  $('upload-view').style.display = 'none';
  $('main-area').style.display = '';
  $('subnav').style.display = '';
  await refreshState();
  $('ds-name').textContent = filename ?? state.filename ?? '資料集';
  refreshPropsFluids();
}

// ?sid= 會話還原（重新整理不遺失工作階段）
const urlSid = new URLSearchParams(location.search).get('sid');
if (urlSid) {
  sid = urlSid;
  api('/state').then(() => enterSession(urlSid)).catch(() => { sid = null; });
}

// ------------------------------------------------------------ 狀態
async function refreshState() {
  state = await api('/state');
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
  $('explore-view').style.display = v === 'explore' ? '' : 'none';
  $('dataset-view').style.display = v === 'dataset' ? '' : 'none';
  $('model-view').style.display = v === 'model' ? '' : 'none';
  // 次導航依頁切換：探索分析＝二維目標下拉；資料集＝每頁顯示
  $('target-select').style.display = v === 'explore' ? '' : 'none';
  $('perpage-wrap').style.display = v === 'dataset' ? 'flex' : 'none';
  if (v === 'model') renderModels();
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
$('theme-menu').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
  themeKey = b.dataset.theme;
  localStorage.setItem('ej-chart-theme', themeKey);
  markThemeMenu();
  $('theme-menu').classList.remove('open');
  if (sid) await renderWall();
}));

document.addEventListener('click', (e) => {
  if (!e.target.closest('#more-drawer') && !e.target.closest('#btn-more')) $('more-drawer').classList.remove('open');
  if (!e.target.closest('#theme-menu') && !e.target.closest('#btn-theme')) $('theme-menu').classList.remove('open');
  if (!e.target.closest('.popover') && !e.target.closest('.cicon') && !e.target.closest('.thops')) closePopovers();
  // 框選面板：點 canvas 是拖曳流程的一部分，不在此收合
  if (!e.target.closest('.brush-panel') && e.target.tagName !== 'CANVAS') closeBrushPanel();
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
  snapshotSteps();
  await api('/apply_template', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps }),
  });
  await refreshState();
});

// ------------------------------------------------------------ 卡片牆
async function renderWall() {
  const res = await api(`/cards?target=${encodeURIComponent(target)}&page=${wallPage}&per_page=${PER_WALL}`);
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
  requestAnimationFrame(() => drawCard($('zoom-canvas'), card, true));
}
bindBrush($('zoom-canvas'));
$('zoom-close').addEventListener('click', () => $('zoom-modal').classList.remove('open'));
$('zoom-modal').addEventListener('click', (e) => { if (e.target === $('zoom-modal')) $('zoom-modal').classList.remove('open'); });

// ------------------------------------------------------------ 資料集表格（Tukey 多行欄頭）
async function renderTable() {
  const res = await api(`/rows?page=${tablePage}&per_page=${perTable}`);
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

async function renderModels() {
  if (!sid) return;
  clearTimeout(modelPollTimer);
  const models = await apiML('/models');
  $('model-empty').style.display = models.length ? 'none' : '';
  $('model-main').style.display = models.length ? '' : 'none';
  if (models.length) {
    const fmt = (m, k) => m.metrics_cv ? m.metrics_cv[k] : '—';
    const stName = { done: '完成', training: '訓練中…', error: '失敗' };
    $('model-table').innerHTML = `<thead><tr>
      <th>排名</th><th>模型</th><th>目標</th><th>演算法</th>
      <th>RMSE</th><th>MAE</th><th>MAAPE</th><th>R²</th>
      <th>狀態</th><th>建立時間</th><th></th></tr></thead><tbody>${
      models.map((m, i) => `<tr data-id="${m.id}">
        <td>${m.status === 'done' ? `#${i + 1}` : ''}</td>
        <td>${m.name}</td><td>${m.target}</td>
        <td>${(ALGO_META?.find((a) => a.key === m.algo)?.name) ?? m.algo}${m.auto_tune ? '（自動調參）' : ''}</td>
        <td>${fmt(m, 'rmse')}</td><td>${fmt(m, 'mae')}</td><td>${fmt(m, 'maape')}</td><td>${fmt(m, 'r2')}</td>
        <td class="st-${m.status}" title="${m.error ?? ''}">${stName[m.status] ?? m.status}</td>
        <td>${m.created}</td>
        <td><span class="del" data-id="${m.id}">刪除</span></td></tr>`).join('')}</tbody>`;
    $('model-table').querySelectorAll('.del').forEach((el) => el.addEventListener('click', async (e) => {
      e.stopPropagation();
      await apiML(`/models/${el.dataset.id}`, { method: 'DELETE' });
      $('model-detail').style.display = 'none';
      await renderModels();
    }));
    $('model-table').querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () =>
      openModelDetail(tr.dataset.id)));
    if (models.some((m) => m.status === 'training')) modelPollTimer = setTimeout(renderModels, 2500);
  }
}

async function openModelDetail(mid) {
  const m = await apiML(`/models/${mid}`);
  if (m.status !== 'done') { alert(m.status === 'error' ? `訓練失敗：${m.error}` : '訓練中，請稍候'); return; }
  await loadAlgoMeta();
  const algoName = ALGO_META.find((a) => a.key === m.algo)?.name ?? m.algo;
  const row = (label, mt) => `<tr><td>${label}</td><td>${mt.rmse}</td><td>${mt.mae}</td><td>${mt.maape}</td><td>${mt.r2}</td></tr>`;
  const tuned = m.tuned_params ? `<div class="md-sub">自動調參結果：${
    Object.entries(m.tuned_params).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('×') : v}`).join('、')}</div>` : '';
  $('model-detail').innerHTML = `
    <h3>${m.name}</h3>
    <div class="md-sub">${algoName}｜訓練資料 ${m.n_rows.toLocaleString()} 筆 ${m.features.length} 特徵｜目標 ${m.target}</div>
    ${tuned}
    <table class="md-metrics">
      <tr><th>模型指標</th><th>RMSE</th><th>MAE</th><th>MAAPE</th><th>R²</th></tr>
      ${row('交叉驗證集', m.metrics_cv)}${row('訓練資料集', m.metrics_train)}
    </table>
    <div class="md-charts">
      <div class="md-chart"><h4>模型準確度 Actual – Predicted</h4><canvas id="md-pa"></canvas></div>
      <div class="md-chart"><h4>模型準確度 Actual – Error</h4><canvas id="md-err"></canvas></div>
      <div class="md-chart wide"><h4>重要變數分析 Feature Importance</h4><canvas id="md-fi"></canvas></div>
    </div>`;
  $('model-detail').style.display = '';
  requestAnimationFrame(() => {
    drawXY($('md-pa'), m.plots.pa.actual, m.plots.pa.pred, '實際值', '預測值', true);
    drawXY($('md-err'), m.plots.err.actual, m.plots.err.error, '實際值', '誤差值', false, true);
    drawFI($('md-fi'), m.plots.fi.names, m.plots.fi.values);
  });
  $('model-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  $('wiz-form-title').textContent = wizMode === 'auto'
    ? '全自動建立——九種演算法各建一個模型（自動調參）' : '手動建立模型';
  $('wiz-target').innerHTML = numeric.map((c) => `<option>${c.name}</option>`).join('');
  const renderFeatures = () => {
    const tgt = $('wiz-target').value;
    $('wiz-features').innerHTML = numeric.filter((c) => c.name !== tgt).map((c) =>
      `<label><input type="checkbox" checked value="${c.name}">${c.name}</label>`).join('');
  };
  $('wiz-target').onchange = renderFeatures;
  renderFeatures();
  $('wiz-manual-only').style.display = wizMode === 'manual' ? '' : 'none';
  if (wizMode === 'manual') {
    $('wiz-algo').innerHTML = ALGO_META.map((a) => `<option value="${a.key}" ${a.key === 'XGB' ? 'selected' : ''}>${a.name}</option>`).join('');
    const renderParams = () => {
      const meta = ALGO_META.find((a) => a.key === $('wiz-algo').value);
      $('wiz-params').innerHTML = meta.params.length ? meta.params.map((p) => `
        <div class="wp"><label>${p.label}</label>${
        p.type === 'choice'
          ? `<select data-key="${p.key}">${p.choices.map((c) => `<option ${c === p.default ? 'selected' : ''}>${c}</option>`).join('')}</select>`
          : `<input data-key="${p.key}" type="${p.type === 'str' ? 'text' : 'number'}" step="any"
               placeholder="預設 ${p.default ?? '自動'}">`}</div>`).join('')
        : '<p class="hint" style="grid-column:1/-1">此演算法無關鍵超參數（用預設即可）</p>';
      $('wiz-tune').disabled = !meta.tunable;
    };
    $('wiz-algo').onchange = renderParams;
    renderParams();
  }
  $('wiz-step-mode').style.display = 'none';
  $('wiz-step-form').style.display = '';
});

$('wiz-submit').addEventListener('click', async () => {
  const features = [...$('wiz-features').querySelectorAll('input:checked')].map((i) => i.value);
  if (!features.length) { alert('至少勾選一個自變數'); return; }
  const body = {
    mode: wizMode,
    name: $('wiz-name').value.trim(),
    target: $('wiz-target').value,
    features,
  };
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
