// 判讀工作台新版面（階段式）——掛在 pid-label.js 之後。
// 不改審核／模型／評註的邏輯，只管四件事：
//   1. 步驟列：現在在哪一步、每步的計數、①→② 自動、其餘手動
//   2. 右欄只顯示當前階段的容器；工具列依階段露出對應控制項
//   3. 框選的意義隨階段固定：①②③ 框選＝新增元件、④ 框選＝留評註
//   4. ③ 的檢視器：選中元件就看到它的框／證據／評註／點位／上下游
// 做法：pid-label.js 的函式都是頂層 function 宣告，呼叫端在呼叫時才解析名字，
// 所以這裡重新指派同名變數就能攔到（openDoc/render/focusItem/openManual/switchTab/renderNotes/renderModel）。

let curStage = 1;
const STG_NAMES = { 1: '辨識', 2: '審核', 3: '資產模型', 4: '評註與說明' };

function setStage(n, opt) {
  n = Math.max(1, Math.min(4, n | 0));
  const prev = curStage;
  curStage = n;
  document.body.className = document.body.className.replace(/\bst-\d\b/g, '').trim() + ' st-' + n;
  document.querySelectorAll('.stg').forEach(el => el.classList.toggle('on', el.id === 'st' + n));
  document.querySelectorAll('#steps .step[data-st]').forEach(s => {
    const k = +s.dataset.st;
    s.classList.toggle('on', k === n);
  });
  // 工具列：③ 才有資產模型檢視與順序圖
  const hasDoc = !!curFile;
  $('cmp-grp').style.display = (n === 3 && hasDoc) ? '' : 'none';
  $('flow-btn').style.display = (n === 3 && hasDoc) ? '' : 'none';
  if (hasDoc) {
    if (n === 3 && cmpMode === 'off') setCompare('side');     // 進 ③ 預設並排看模型
    if (n !== 3 && prev === 3 && cmpMode !== 'off') setCompare('off');
  }
  // 離開階段時把框選開的表單收掉（框選意義隨階段變，不該帶著舊表單過去）
  if (prev !== n) {
    if ($('man-form').style.display !== 'none') $('man-cancel').click();
    if (noteTarget && !noteTarget.tag) $('note-cancel').click();
  }
  $('tb-hint').textContent = n === 4 ? '框選＝留評註' : (n === 1 ? '' : '框選空白處＝新增元件；選中框可拖把手改大小');
  if (n === 3) renderInspector();
  if (n === 4) { renderNotes(); renderStage4Focus(); }
  updateSteps();
  if (!(opt && opt.silent)) localStorage.setItem('pid.stage.' + (curFile || ''), String(n));
}

function updateSteps() {
  const total = items.length, done = total ? reviewedCount() : 0;
  const acc = items.filter(i => i.state === 'accepted').length;
  $('sv1').textContent = total ? `${total} 項候選` : '';
  $('sv2').textContent = total ? `${done}／${total}` : '';
  $('sv3').textContent = assetModel ? `${(assetModel.stats || {}).equipment || 0} 設備` : '';
  $('sv4').textContent = notes.length ? `${notes.length} 則` : '';
  const s1 = $$('#steps [data-st="1"]'), s2 = $$('#steps [data-st="2"]'), s3 = $$('#steps [data-st="3"]'), s4 = $$('#steps [data-st="4"]');
  s1.classList.toggle('done', total > 0);
  s2.classList.toggle('done', total > 0 && done === total);
  s3.classList.toggle('done', !!assetModel);
  s4.classList.toggle('done', notes.length > 0 || !!descText);
  $('step-map').href = curFile ? `/twin/mapping?drawing=${encodeURIComponent(curFile)}` : '/twin/mapping';
  $('go-map').href = $('step-map').href;
  $('as-map').href = $('step-map').href;
  void acc;
}
// $ 原本只接 id；這裡要查 selector 用 $$
const $$ = sel => document.querySelector(sel);

// --------------------------------------------------------------- 攔截舊函式
// openDoc：開圖後決定起始階段（有候選→②，沒有→①），並套工具列
{
  const _openDoc = openDoc;
  openDoc = async function (name) {
    await _openDoc(name);
    const saved = +localStorage.getItem('pid.stage.' + name);
    const start = items.length ? (saved >= 2 && saved <= 4 ? saved : 2) : 1;
    setStage(start, { silent: true });
    $('file-dd').classList.remove('open');
    inspCache = {};
    loadPointsForFile();
  };
}
// render：每次重畫更新步驟列；① 有候選進來就自動到 ②
{
  const _render = render;
  render = function () {
    _render();
    updateSteps();
    if (curStage === 1 && items.length) setStage(2);
    if (curStage === 3) renderInspector();
  };
}
// focusItem：③ 選中元件 → 檢視器
{
  const _focusItem = focusItem;
  focusItem = function (k) {
    if (linkPick) { finishLinkPick((items[k] || {}).tag); return; }   // 正在指定上下游：點到誰就是誰
    // ③④ 點元件只是看它／對它留評註，不要觸發審核卡用的雲端「情境判讀」與「安裝別判定」（那是 ② 的事、要錢）
    const it = items[k];
    const hold = curStage !== 2 && it && !it._ctx;
    if (hold) { it._ctxBusy = true; if (!it._cls) { it._cls = true; it.__clsHold = true; } }
    _focusItem(k);
    if (hold) { it._ctxBusy = false; if (it.__clsHold) { it._cls = false; delete it.__clsHold; } }
    if (curStage === 3) renderInspector();
    if (curStage === 4) { const it = items[k]; if (it) openNoteFor(it); renderStage4Focus(); }
  };
}
// renderNotes / renderModel：計數與檢視器跟著更新
{
  const _renderNotes = renderNotes;
  renderNotes = function () { _renderNotes(); updateSteps(); if (curStage === 3) renderInspector(); if (curStage === 4) renderStage4Focus(); };
  const _renderModel = renderModel;
  renderModel = function () { _renderModel(); updateSteps(); if (curStage === 3) renderInspector(); };
}
// switchTab：舊碼在建模／順序圖後會切「資產庫」分頁 → 對應到 ③
switchTab = function (name) {
  if (name === 'assets') setStage(3);
  else if (name === 'review') setStage(2);
  else if (name === 'adv') $('adv-pop').classList.add('open');
};
// openManual：框選意義隨階段固定
openManual = function (box) {
  const inTags = tagsInBox(box);
  if (linkPick) {            // 指定上下游時框選一塊＝用框裡的元件
    if (selEl) { selEl.remove(); selEl = null; }
    if (!inTags.length) { alert('框裡沒有已入庫的元件——先在 ② 把它框進資產庫，或直接點圖上的框'); return; }
    finishLinkPick(inTags[0]);
    return;
  }
  manBox = box;
  if (curStage === 4) {
    // ④：框選＝留評註（沿用 0.15 的表單：這是什麼／同時加入資產庫／內容）
    $('man-form').style.display = 'none';
    noteTarget = { bbox: box, tag: '', tags: inTags };
    $('note-new').style.display = '';
    $('note-target').innerHTML = '評註對象：<b>此框選區域</b>' + (inTags.length ? `（含 ${esc(inTags.join('、'))}）` : '');
    $('note-label').value = inTags.join('、');
    updateAssetRow();
    (inTags.length ? $('note-text') : $('note-label')).focus();
  } else {
    // ①②③：框選＝新增元件
    if (noteTarget && !noteTarget.tag) { noteTarget = null; $('note-new').style.display = 'none'; }
    $('man-form').style.display = '';
    $('man-hint').textContent = inTags.length
      ? `框裡已有 ${inTags.join('、')}（在資產庫）。要新增別的元件請填位號；只是想看它請點空白處取消。`
      : '填入位號後加入資產庫（已確認、人工標註）。';
    $('man-tag').value = '';
    $('man-tag').focus();
  }
  $('forms').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

// --------------------------------------------------------------- 頂列互動
document.querySelectorAll('#steps .step[data-st]').forEach(s => s.addEventListener('click', () => setStage(+s.dataset.st)));
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => setStage(+b.dataset.go)));
$('file-dd-btn').addEventListener('click', e => { e.stopPropagation(); $('file-dd').classList.toggle('open'); $('adv-pop').classList.remove('open'); });
$('adv-btn').addEventListener('click', e => { e.stopPropagation(); $('adv-pop').classList.toggle('open'); $('file-dd').classList.remove('open'); });
document.addEventListener('click', e => {
  if (!e.target.closest('#file-dd')) $('file-dd').classList.remove('open');
  if (!e.target.closest('#adv-pop') && !e.target.closest('#adv-btn')) $('adv-pop').classList.remove('open');
});
// 切回舊版：帶著同一張圖
{
  const p = new URLSearchParams(location.search);
  const old = $('old-ui');
  const sync = () => { const q = new URLSearchParams(); if (curFile) q.set('file', curFile); for (const k of ['back', 'cmp']) if (p.get(k)) q.set(k, p.get(k)); old.href = '/twin/pid/label' + (q.toString() ? '?' + q : ''); };
  sync();
  const _od = openDoc; openDoc = async function (n) { await _od(n); sync(); };
}
// 版號
fetch('/api/version').then(r => r.json()).then(v => { $('top-meta').textContent = `v${v.version}`; }).catch(() => {});

// --------------------------------------------------------------- ③ 檢視器
let inspCache = {};          // { points: {tag: [...]}, loadedAt }
async function loadPointsForFile() {
  // 這張圖有哪些資料集對過點位 → 每台設備底下的點位（平均值／單位／確認狀態）
  if (!curFile) return;
  try {
    const ds = await getJSON('/api/pid/mapping/datasets');
    const mine = (ds || []).filter(d => (d.drawings || []).includes(curFile));
    const byTag = {};
    for (const d of mine) {
      const m = await getJSON(`/api/pid/mapping/${encodeURIComponent(d.sid)}`);
      for (const p of m.points || []) {
        if (!p.tag || p.ignored) continue;
        (byTag[p.tag] = byTag[p.tag] || []).push({ ...p, sid: d.sid, file: d.filename });
      }
    }
    inspCache.points = byTag;
    inspCache.datasets = mine;
  } catch { inspCache.points = {}; }
  if (curStage === 3) renderInspector();
}

function modelRowFor(it) {
  if (!assetModel || !it) return null;
  if (it.kind === 'equipment') return (assetModel.equipment || []).find(e => e.tag === it.tag) || null;
  if (it.kind === 'instrument') return (assetModel.instruments || []).find(x => x.tag === it.tag) || null;
  if (it.kind === 'valve') return (assetModel.valves || []).find(v => v.bbox && it.bbox && Math.hypot(
    (v.bbox[0] + v.bbox[2] - it.bbox[0] - it.bbox[2]) / 2, (v.bbox[1] + v.bbox[3] - it.bbox[1] - it.bbox[3]) / 2) < 0.01) || null;
  return null;
}

function renderInspector() {
  const host = $('insp'); if (!host) return;
  const it = items[curIdx];
  if (!assetModel && !it) {
    host.className = 'insp';
    host.innerHTML = `<div class="insp-empty">尚未建立資產模型。審核完成後按下方「建立／更新資產模型」，之後點左圖任一元件就看得到它的全部。</div>`;
    return;
  }
  if (!it) {
    const s = (assetModel && assetModel.stats) || {};
    const onDr = s.equipment_on_drawing != null ? s.equipment_on_drawing : (assetModel.equipment || []).filter(e => e.bbox).length;
    host.className = 'insp';
    host.innerHTML = `<div class="insp-empty">點左圖任一元件，看它的框、證據、評註、點位與上下游。</div>
      <div class="insp-stats">
        <div class="as-stat"><b>${onDr}／${s.equipment || 0}</b><span>設備有框</span></div>
        <div class="as-stat"><b>${s.instruments || 0}</b><span>儀錶</span></div>
        <div class="as-stat"><b>${s.valves || 0}</b><span>閥件</span></div>
      </div>
      <div class="hint" style="margin-top:8px">上次建模：${esc((assetModel.built_at || '').replace('T', ' ').slice(0, 16) || '—')}</div>`;
    return;
  }
  const row = modelRowFor(it);
  const tag = it.tag || '';
  const kindTxt = (typeof KIND_TXT !== 'undefined' && KIND_TXT[it.kind]) || it.kind;
  const name = (row && (row.name || row.type || row.function)) || it.symbol || '';
  const spec = row && row.spec ? row.spec : '';
  const st = it.state === 'accepted' ? '已確認' : it.state === 'rejected' ? '已否決' : '待審';
  const who = (it.verified_by || '').split('@')[0];
  const ev = (it.evidence || []).slice(-5);
  const myNotes = notes.filter(n => n.tag === tag || (n.tags || []).includes(tag));
  const pts = (inspCache.points || {})[tag] || [];
  let up = [], down = [];
  const fn = (flowEdges && flowEdges.nodes || []).find(n => n.tag === tag);
  if (fn) { up = fn.upstream || []; down = fn.downstream || []; }
  const bb = Array.isArray(it.bbox) ? it.bbox.map(v => v.toFixed(3)).join(', ') : '—';
  host.className = 'insp sel';
  host.innerHTML = `
    <div class="insp-top"><span class="insp-tag">${esc(tag || '（無位號）')}</span><span class="insp-k">${esc(kindTxt)}</span>
      <span class="sp" style="flex:1"></span><span class="conf ${it.state === 'accepted' ? '' : 'mid'}">${st}</span></div>
    <div class="insp-sub">${esc(name)}${spec ? '　' + esc(spec) : ''}${who ? `　由 ${esc(who)} 確認` : ''}</div>
    <div class="insp-sec"><h4>框 <i></i><span style="font-weight:400">${bb}</span></h4>
      <div class="insp-act">
        <button class="mini-btn" id="insp-rebox" title="在圖上重畫這個框（E）">重框</button>
        <button class="mini-btn" id="insp-note" title="為這個元件留評註">加評註</button>
        <button class="mini-btn" id="insp-del" title="從資產庫刪除（Delete）">刪除</button>
      </div></div>
    ${ev.length ? `<div class="insp-sec"><h4>證據 <i></i></h4>${ev.map(e => `<div class="insp-row"><span class="k" title="${esc(e.detail || '')}">${esc(e.stage || '')}${e.detail ? '：' + esc(e.detail) : ''}</span><span class="v ${e.ok ? 'ok' : 'g'}">${e.score != null ? Math.round(e.score * 100) + '%' : ''}</span></div>`).join('')}</div>` : ''}
    <div class="insp-sec"><h4>評註 <i></i><span style="font-weight:400">${myNotes.length}</span></h4>
      ${myNotes.length ? myNotes.map(n => `<div class="insp-row"><span class="k">${esc(n.id)} ${esc(n.label || n.text || '')}</span><span class="v" style="font-weight:400;color:var(--dim)">${esc((n.by || '').split('@')[0])}</span></div>`).join('') : '<div class="insp-empty">沒有評註。</div>'}</div>
    <div class="insp-sec"><h4>點位 <i></i><span style="font-weight:400">${pts.length}</span></h4>
      ${pts.length ? pts.slice(0, 6).map(p => `<div class="insp-row"><span class="k" title="${esc(p.col)}">${esc(p.measure || p.col)}${p.sub ? '·' + esc(p.sub) : ''}${p.stat ? ' ' + esc(p.stat) : ''}</span><span class="v ${p.confirmed ? 'ok' : 'g'}">${p.stats && p.stats.mean != null ? fmtNum(p.stats.mean) : '—'}${p.unit ? ' ' + esc(p.unit) : ''}${p.confirmed ? '' : '（未簽名）'}</span></div>`).join('') + (pts.length > 6 ? `<div class="hint">＋${pts.length - 6} 個</div>` : '')
        : `<div class="insp-empty">還沒綁數據。<a href="${$('step-map').href}">到點位對照</a>把欄位拖到它身上。</div>`}</div>
    <div class="insp-sec"><h4>上下游 <i></i><span style="font-weight:400">${fn ? '' : '（尚未推導）'}</span></h4>
      ${linkPick ? `<div class="insp-row" style="border:0;color:var(--accent);font-weight:600">點圖上要設為${linkPick.dir === 'up' ? '上游' : '下游'}的元件（或框選它）　<button class="mini-btn" id="lp-cancel">取消</button></div>` : ''}
      <div class="insp-row"><span class="k">上游</span><span class="v" style="font-weight:400">${up.map(t => `<span class="tagchip" data-t="${esc(t)}">${esc(t)}<span class="lp-x" data-rm-up="${esc(t)}" title="刪除這條連線"> ×</span></span>`).join('')}<button class="mini-btn lp-add" data-dir="up" title="指定一台上游：點圖上的元件或框選它">＋ 上游</button></span></div>
      <div class="insp-row"><span class="k">下游</span><span class="v" style="font-weight:400">${down.map(t => `<span class="tagchip" data-t="${esc(t)}">${esc(t)}<span class="lp-x" data-rm-down="${esc(t)}" title="刪除這條連線"> ×</span></span>`).join('')}<button class="mini-btn lp-add" data-dir="down" title="指定一台下游：點圖上的元件或框選它">＋ 下游</button></span></div>
      <div class="hint" style="margin-top:4px">自動推導來自箭頭與項次號；線稿沒接到或跨圖的，用「＋」自己指定，重建圖與順序圖會跟著更新。</div></div>`;
  $('insp-rebox').onclick = () => startRebox(curIdx);
  $('insp-note').onclick = () => openNoteFor(it);
  $('insp-del').onclick = () => deleteCurrent();
  host.querySelectorAll('.tagchip').forEach(c => c.addEventListener('click', e => {
    if (e.target.classList.contains('lp-x')) return;
    const k = items.findIndex(i => i.tag === c.dataset.t && i.state !== 'rejected');
    if (k >= 0) focusItem(k);
  }));
  host.querySelectorAll('.lp-add').forEach(b => b.addEventListener('click', () => startLinkPick(b.dataset.dir)));
  const lc = $('lp-cancel'); if (lc) lc.onclick = () => { linkPick = null; $('tb-hint').textContent = ''; renderInspector(); };
  host.querySelectorAll('[data-rm-up]').forEach(x => x.addEventListener('click', async e => {
    e.stopPropagation(); if (!confirm(`刪除連線 ${x.dataset.rmUp} → ${tag}？`)) return;
    await postFlow(x.dataset.rmUp, tag, 'remove'); await reloadFlow();
  }));
  host.querySelectorAll('[data-rm-down]').forEach(x => x.addEventListener('click', async e => {
    e.stopPropagation(); if (!confirm(`刪除連線 ${tag} → ${x.dataset.rmDown}？`)) return;
    await postFlow(tag, x.dataset.rmDown, 'remove'); await reloadFlow();
  }));
}

// ---- 人工指定上下游：自動推導靠箭頭與項次號，線稿沒接到／跨圖的要人補 ----
let linkPick = null;     // { dir: 'up'|'down', base: tag }
function startLinkPick(dir) {
  const it = items[curIdx]; if (!it || !it.tag) { alert('先選一個有位號的元件'); return; }
  linkPick = { dir, base: it.tag };
  $('tb-hint').textContent = `點圖上要設為 ${it.tag} 的${dir === 'up' ? '上游' : '下游'}的元件，或框選它；Esc 取消`;
  renderInspector();
}
async function finishLinkPick(tag) {
  if (!linkPick) return;
  const { dir, base } = linkPick;
  linkPick = null; $('tb-hint').textContent = '';
  if (!tag) { alert('點到的元件沒有位號，無法接上下游'); renderInspector(); return; }
  if (tag === base) { alert('不能接自己'); renderInspector(); return; }
  const a = dir === 'up' ? tag : base, b = dir === 'up' ? base : tag;
  try { await postFlow(a, b, 'add'); } catch (e) { alert('新增連線失敗：' + e.message); }
  await reloadFlow();
}
async function postFlow(a, b, action) {
  return getJSON(`/api/pid/model/flow/${encodeURIComponent(curFile)}/manual`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, b, action }) });
}
async function reloadFlow() {
  flowEdges = null; flowData = null;
  await loadFlowEdges(); if (flowEdges) flowEdges._for = curFile;
  $('rebuild-img').dataset.for = '';                       // 重建圖上的箭頭要跟著換
  if (cmpMode !== 'off') setCompare(cmpMode);
  renderInspector();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && linkPick) { linkPick = null; $('tb-hint').textContent = ''; renderInspector(); } });
const fmtNum = v => v == null ? '—' : (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

// --------------------------------------------------------------- 啟動
setStage(1, { silent: true });


// --------------------------------------------------------------- ④ 元件 ↔ 說明 ↔ 評註
// 說明是長文，圖是空間——兩邊要互指：選中元件就列出說明裡講它的句子，
// 句子可直接「寫錯了→提意見」；說明裡的位號點了跳回圖上；沒被提到的元件列出來，
// 讓人知道說明漏了誰（留評註就是補給它的料）。
function descSentences() {
  return (descText || '').split(/(?<=[。！？；\n])/).map(x => x.trim()).filter(Boolean);
}
function tagInText(tag, t) {
  if (!tag) return false;
  const re = new RegExp('(^|[^0-9A-Za-z.])' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9A-Za-z.])');
  return re.test(t);
}
function renderStage4Focus() {
  const host = $('st4-focus'); if (!host) return;
  const it = items[curIdx];
  const accTags = [...new Set(items.filter(i => i.state === 'accepted' && i.tag).map(i => i.tag))];
  if (!it) {
    if (!descText) { host.className = 'insp'; host.innerHTML = '<div class="insp-empty">點左圖任一元件：對它留評註。按下方「產生說明」之後，這裡會顯示說明提到了哪些元件、漏了哪些。</div>'; return; }
    const mentioned = accTags.filter(t => tagInText(t, descText));
    const missing = accTags.filter(t => !tagInText(t, descText));
    host.className = 'insp';
    host.innerHTML = `<div class="insp-sub">製程說明提到 <b>${mentioned.length}／${accTags.length}</b> 個已確認位號。點左圖任一元件看它在說明裡怎麼寫。</div>
      ${missing.length ? `<div class="insp-sec"><h4>說明沒提到 <i></i><span style="font-weight:400">${missing.length}</span></h4>
        <div>${missing.slice(0, 30).map(t => `<span class="tagchip" data-t="${esc(t)}">${esc(t)}</span>`).join('')}${missing.length > 30 ? `<span class="hint">＋${missing.length - 30}</span>` : ''}</div>
        <div class="hint" style="margin-top:4px">點一個→在圖上選中；留一句評註（例如它的角色），重新產生說明就會補進去。</div></div>` : ''}`;
    host.querySelectorAll('.tagchip').forEach(c => c.addEventListener('click', () => { const k = items.findIndex(i => i.tag === c.dataset.t && i.state !== 'rejected'); if (k >= 0) focusItem(k); }));
    return;
  }
  const tag = it.tag || '';
  const myNotes = notes.filter(n => n.tag === tag || (n.tags || []).includes(tag));
  const sents = tag ? descSentences().filter(x => tagInText(tag, x)) : [];
  host.className = 'insp sel';
  host.innerHTML = `
    <div class="insp-top"><span class="insp-tag">${esc(tag || '（無位號）')}</span><span class="insp-k">${esc((typeof KIND_TXT !== 'undefined' && KIND_TXT[it.kind]) || it.kind)}</span>
      <span style="flex:1"></span><button class="mini-btn" id="f4-note">對它留評註</button></div>
    <div class="insp-sub">${esc(it.symbol || (modelRowFor(it) || {}).name || '')}</div>
    <div class="insp-sec"><h4>說明裡怎麼寫它 <i></i><span style="font-weight:400">${sents.length} 句</span></h4>
      ${!descText ? '<div class="insp-empty">還沒有製程說明——按下方「產生說明」。</div>'
        : sents.length ? sents.map((x, i) => `<div class="f4-s" data-i="${i}"><div class="f4-t">${esc(x)}</div>
            <div class="insp-act" style="margin-top:4px"><button class="mini-btn" data-jump="${i}">跳到說明處</button><button class="mini-btn" data-wrong="${i}">這句寫錯 → 提意見</button></div></div>`).join('')
        : `<div class="insp-empty">說明沒提到 ${esc(tag)}。對它留一句評註（它在製程裡做什麼、有什麼現場狀況），重新產生說明就會補進去。</div>`}</div>
    <div class="insp-sec"><h4>它的評註 <i></i><span style="font-weight:400">${myNotes.length}</span></h4>
      ${myNotes.length ? myNotes.map(n => `<div class="insp-row"><span class="k">${esc(n.id)} ${esc(n.label && n.label !== tag ? n.label + '：' : '')}${esc(n.text || '')}</span><span class="v" style="font-weight:400;color:var(--dim)">${esc((n.by || '').split('@')[0])}</span></div>`).join('') : '<div class="insp-empty">還沒有。</div>'}</div>`;
  $('f4-note').onclick = () => openNoteFor(it);
  host.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => jumpToSentence(sents[+b.dataset.jump])));
  host.querySelectorAll('[data-wrong]').forEach(b => b.addEventListener('click', () => {
    const x = sents[+b.dataset.wrong];
    $('fb-box').style.display = '';
    $('desc-panel').classList.remove('collapsed');
    $('fb-text').value = `「${x.length > 60 ? x.slice(0, 60) + '…' : x}」這句不對：`;
    $('fb-text').focus();
    $('fb-text').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
}
// 把說明捲到那一句並選取反白——說明的 DOM 被位號籤切成很多節點，用字元偏移對回去
function jumpToSentence(sent) {
  const root = $('desc-out'); if (!root || !sent) return;
  $('desc-panel').classList.remove('collapsed');
  const probe = sent.replace(/⟦N\d+⟧/g, '').slice(0, 18);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; let all = '';
  for (let n; (n = walker.nextNode());) { nodes.push({ n, start: all.length }); all += n.nodeValue; }
  const at = all.indexOf(probe);
  if (at < 0) { root.scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  const hit = nodes.filter(x => x.start <= at).pop();
  const end = Math.min(all.length, at + sent.length);
  const hitEnd = nodes.filter(x => x.start <= end).pop();
  try {
    const r = document.createRange();
    r.setStart(hit.n, at - hit.start);
    r.setEnd(hitEnd.n, Math.min(hitEnd.n.nodeValue.length, end - hitEnd.start));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    (hit.n.parentElement || root).scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch { root.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
}
// 說明裡的位號點了→圖上選中（④ 同時開它的評註）
{
  const out = $('desc-out');
  if (out) out.addEventListener('click', e => {
    const s = e.target.closest('.src'); if (!s) return;
    const k = items.findIndex(i => i.tag === s.dataset.tag && i.state !== 'rejected');
    if (k >= 0) focusItem(k);
  });
}
