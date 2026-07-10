// 智慧運轉 —— flowsheet 求解器結果疊加到 3D 數位孿生
// 承載即 3D 檢視器本身：頂欄「智慧運轉」chip 開啟後，每拍 POST
// /agatha/flowsheet/{id}/run/（sequential modular 求解），把各 block 的
// 模型預測直接畫上 3D：設備標籤變即時值徽章、出定義域設備紅色脈動
// （併入 app.js 警報通道）。
//   - 右下「監看卡」：常用旋鈕、KPI、傳遞值、演示（小卡，不搶畫面）。
//   - 「Block 工作面」（半版）：點設備 → 資訊卡「⤢ 放大檢視」→ 該 block 的
//     flowsheet 綁定完整載入——即時值+趨勢、輸入來源（上游/鎖定/邊界）、
//     what-if 旋鈕（訓練域拉軸+輸入框）、該模型的最佳化。
// 場景需在 scene JSON 頂層宣告 "flowsheet": "<id>" 才會出現此功能。

export const flowAlarm = new Set(); // 出定義域設備 tag（app.js 主迴圈讀取 → 紅色脈動）

const $ = (id) => document.getElementById(id);

// 常用操作旋鈕（跨 block 的高頻操作；λ 為虛擬旋鈕：換算一次/二次風量特徵）
const KNOBS = [
  { key: 'lam', label: '過剩空氣 λ', unit: '', min: 1.30, max: 1.85, step: 0.01, val: 1.55, dec: 2, pseudo: true },
  { key: 'urea_inject_L_h', label: '尿素噴注', unit: 'L/h', min: 40, max: 260, step: 1, val: 120, dec: 0 },
  { key: 'lime_slurry_kg_h', label: '消石灰漿', unit: 'kg/h', min: 80, max: 320, step: 1, val: 180, dec: 0 },
  { key: 'carbon_inject_kg_h', label: '活性碳', unit: 'kg/h', min: 4, max: 30, step: 0.5, val: 12, dec: 1 },
];

let ctx = null;          // { plantData, eqMap, sceneId }
let spec = null;         // flowsheet 規格（含 order、feature_ranges）
let on = false;
let timer = null;
let running = false;
let tickN = 0;
let lastRun = null;      // 最近一次 run 回應
let wsTag = null;        // Block 工作面目前顯示的 block id（null=關閉）
let demo = { fan: false, lhv: false };
const fedBy = {};        // blockId → Set(被 connection 餵的特徵，不由前端提供)
const overrides = {};    // blockId → { feat: val }：what-if／最佳化套用值，蓋過模擬訊號
const HIST = {};         // blockId → [最近 90 拍的顯示值]（工作面趨勢圖用）

// ---------------------------------------------------------------- 邊界訊號
// 與工程檢視頁同一套假 DCS 模擬器（漂移 + 演示情境），鍵一律用模型特徵名。
const P = { feed: 20, lhv: 9500, cl: 1, hg: 1, pf: 0.62, grate: 12, pat: 180, feedw: 62, drum: 40, water: 4, pulse: 20, fouling: 2, bag_extra: 0, fan_vib_x: 0, fan_brg_x: 0 };
function drift(v, t, k) { return v + (t - v) * k + (Math.random() - 0.5) * Math.abs(t || 1) * 0.01; }

function knob(key) {
  const el = $(`fs-${key}`);
  const def = KNOBS.find((k) => k.key === key);
  return el ? +el.value : def.val;
}

function boundary() {
  P.feed = drift(P.feed, 20, 0.15);
  P.lhv = drift(P.lhv, demo.lhv ? 7800 : 9500, 0.12);
  P.cl = drift(P.cl, 1, 0.1); P.hg = drift(P.hg, 1, 0.1);
  P.grate = drift(P.grate, 12, 0.1); P.pat = drift(P.pat, 180, 0.1);
  P.fouling = Math.min(18, P.fouling + 0.004);
  P.fan_vib_x = drift(P.fan_vib_x, demo.fan ? 5.5 : 0, 0.10);
  P.fan_brg_x = drift(P.fan_brg_x, demo.fan ? 20 : 0, 0.10);
  const lam = knob('lam'), feed = P.feed, lhv = P.lhv;
  // λ 虛擬旋鈕 → 一次/二次風量（與訓練資料生成器同一組式）
  const heat = feed * lhv / 3600, stoich = feed * 4.6, total = lam * stoich;
  const primary = total * P.pf, secondary = total * (1 - P.pf);
  const furnace = 1000 - 300 * (lam - 1.30) + 5.5 * (heat - 52) + 0.25 * (P.pat - 180);
  const flue = total * 1.15, fexit = furnace - 42;
  const raw_hcl = Math.max(20, 850 * P.cl), raw_hg = Math.max(3, 40 * P.hg);
  const raw_dust = Math.max(1, 4 + 0.5 * (feed - 20));
  const inlet_dust = raw_dust + knob('lime_slurry_kg_h') / 1000 + knob('carbon_inject_kg_h') / 2000;
  const bag_dP = 8 + 0.7 * inlet_dust + 0.12 * P.pulse + 9 * Math.min(1, tickN / 400) + P.bag_extra;
  const collect = 99.92 - 0.0006 * bag_dP, out_dust = inlet_dust * 1000 * (1 - collect / 100);
  const fan_curr = 80 + 0.4 * (flue - 120) + 0.9 * bag_dP;
  const fan_vib = 2.2 + 1.6 * Math.min(1, tickN / 400) + P.fan_vib_x;
  const fan_brg = 60 + 0.25 * (fan_curr - 100) + 6 * Math.min(1, tickN / 400) + P.fan_brg_x;
  return {
    waste_feed_t_h: feed, waste_LHV_kJ_kg: lhv, primary_air_kNm3_h: primary, secondary_air_kNm3_h: secondary,
    grate_speed_m_h: P.grate, primary_air_temp_C: P.pat, urea_inject_L_h: knob('urea_inject_L_h'),
    furnace_temp_C: furnace, flue_gas_flow_kNm3_h: flue, heat_release_MW: heat, feedwater_t_h: P.feedw,
    drum_pressure_bar: P.drum, boiler_inlet_gas_C: fexit, lime_slurry_kg_h: knob('lime_slurry_kg_h'),
    water_inject_m3_h: P.water, inlet_HCl_mg_Nm3: raw_hcl, scrubber_exit_temp_C: 150 - 3 * P.water,
    carbon_inject_kg_h: knob('carbon_inject_kg_h'), inlet_Hg_ug_Nm3: raw_hg,
    bag_dP_mbar: bag_dP, collection_eff_pct: collect, outlet_dust_mg_Nm3: out_dust, inlet_dust_g_Nm3: inlet_dust,
    fan_motor_current_A: fan_curr, fan_vibration_mm_s: fan_vib, fan_bearing_temp_C: fan_brg,
    inlet_steam_temp_C: 400 - 0.6 * P.fouling, condenser_vac_kPa: -92,
  };
}

// ---------------------------------------------------------------- 求解一拍
async function tick() {
  if (running) return; // 上一拍還沒回來，跳過（不堆疊）
  running = true;
  tickN++;
  const S = boundary();
  const inputs = {};
  for (const b of spec.blocks) {
    const feats = Object.keys(b.defaults || {});
    const row = {};
    for (const f of feats) {
      if (fedBy[b.id]?.has(f)) continue;            // 上游模型輸出會覆蓋，不送
      row[f] = +(S[f] ?? b.defaults[f]).toFixed(4); // 邊界模擬值，缺者用規格預設
    }
    Object.assign(row, overrides[b.id] || {});      // what-if／最佳化套用值優先
    inputs[b.id] = row;
  }
  let r = null;
  try {
    r = await fetch(`/agatha/flowsheet/${encodeURIComponent(spec.flowsheet_id)}/run/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs, source: 'twin3d' }),
      signal: AbortSignal.timeout(6000),
    }).then((x) => x.json());
  } catch { /* 斷線這拍略過，下一拍再試 */ }
  running = false;
  if (!r || !r.blocks) { $('flow-tick').textContent = `求解器未回應（第 ${tickN} 拍）`; return; }
  lastRun = r;
  paint(r);
}

// ---------------------------------------------------------------- 渲染
function bandOf(blk, res) {
  if (blk.kind === 'anomaly') {
    const p = res.prediction || {};
    if (p.over_threshold) return 'crit';
    return p.health >= 70 ? 'ok' : p.health >= 50 ? 'warn' : 'crit';
  }
  const v = res.prediction?.value;
  if (v == null || blk.warn == null) return 'ok';
  if (blk.better === 'low') return v >= blk.crit ? 'crit' : v >= blk.warn ? 'warn' : 'ok';
  return v <= blk.crit ? 'crit' : v <= blk.warn ? 'warn' : 'ok';
}

function fmt(v) {
  if (v == null) return '--';
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function shownValueOf(blk, res) {
  // 顯示值：anomaly 用 health，regression 用 value（趨勢圖同源）
  return blk.kind === 'anomaly' ? res?.prediction?.health : res?.prediction?.value;
}

function paint(r) {
  const guardCount = { ok: 0, warn: 0, out: 0, unknown: 0 };
  for (const blk of spec.blocks) {
    const res = r.blocks[blk.id];
    const entry = ctx.eqMap[blk.id];
    if (!res || !entry) continue;
    const guard = res.guard?.status ?? 'unknown';
    guardCount[guard] = (guardCount[guard] ?? 0) + 1;

    // 趨勢緩衝（工作面用）
    const sv = shownValueOf(blk, res);
    if (sv != null && isFinite(sv)) {
      (HIST[blk.id] ??= []).push(sv);
      if (HIST[blk.id].length > 90) HIST[blk.id].shift();
    }

    // 3D 標籤 → 即時值徽章
    const band = res.error || res.skipped ? 'ok' : bandOf(blk, res);
    const shown = res.error ? '模型錯誤' : res.skipped ? '待上游' :
      blk.kind === 'anomaly' ? `${Math.round(res.prediction?.health ?? 0)}<span class="unit"> /100</span>` :
        `${fmt(res.prediction?.value)}<span class="unit"> ${blk.unit || ''}</span>`;
    entry.labelEl.classList.add('flow-badge');
    entry.labelEl.classList.toggle('fl-warn', band === 'warn' || guard === 'warn');
    entry.labelEl.classList.toggle('fl-crit', band === 'crit');
    entry.labelEl.classList.toggle('fl-guard-out', guard === 'out');
    entry.labelEl.innerHTML = `${blk.id}<span class="fl-val">${shown}</span>`;

    // 出定義域 → 併入警報通道（3D 紅色脈動 + 標籤閃爍）
    if (guard === 'out') { flowAlarm.add(blk.id); entry.labelEl.classList.add('alarming'); }
    else { flowAlarm.delete(blk.id); entry.labelEl.classList.remove('alarming'); }
  }

  // 監看卡：狀態行 / KPI / 傳遞值
  $('flow-tick').innerHTML = `● 第 <b>${tickN}</b> 拍 · ${r.ms} ms · ${spec.blocks.length} blocks`;
  const gsum = $('flow-guard');
  if (guardCount.out) { gsum.textContent = `✖ ${guardCount.out} 台出定義域`; gsum.className = 'fl-guard-sum out'; }
  else if (guardCount.warn) { gsum.textContent = `⚠ ${guardCount.warn} 台外插`; gsum.className = 'fl-guard-sum warn'; }
  else { gsum.textContent = `守門員 ${guardCount.ok} ok`; gsum.className = 'fl-guard-sum'; }

  const BAND_CLS = { ok: '', warn: 'warn', crit: 'crit' };
  $('flow-kpis').innerHTML = spec.blocks.filter((b) => b.kind !== 'anomaly').map((b) => {
    const res = r.blocks[b.id];
    const band = res ? bandOf(b, res) : 'ok';
    return `<div class="fl-kpi ${BAND_CLS[band]}">
      <div class="k">${b.output_label || b.id}</div>
      <div class="v">${fmt(res?.prediction?.value)}<span class="unit"> ${b.unit || ''}</span></div></div>`;
  }).join('');

  $('flow-conns').innerHTML = (r.connections || []).map((c) =>
    `↦ ${c.from} → ${c.to}　<b>${fmt(c.value)}</b> ${c.unit || ''}`).join('<br>') || '—';

  // 資訊卡開著且是綁定設備 → 即時更新 AI 模型段
  const openTag = document.getElementById('info-tag')?.textContent;
  if (openTag && r.blocks[openTag] && !document.getElementById('info-card').classList.contains('hidden')) {
    const eq = ctx.eqMap[openTag]?.def;
    if (eq) $('info-model').innerHTML = flowInfoSection(eq);
  }

  // Block 工作面開著 → 即時更新（值/趨勢/輸入表/守門，不重建控件避免打斷拖拉）
  if (wsTag && r.blocks[wsTag]) refreshWs();

  layoutRightRail(); // 資訊卡內容每拍可能長高/縮短 → 重排右側，保證不疊
}

function clearBadges() {
  for (const b of spec?.blocks ?? []) {
    const entry = ctx.eqMap[b.id];
    if (!entry) continue;
    entry.labelEl.classList.remove('flow-badge', 'fl-warn', 'fl-crit', 'fl-guard-out', 'alarming');
    entry.labelEl.textContent = b.id;
  }
  flowAlarm.clear();
}

// ---------------------------------------------------------------- 資訊卡 AI 模型段
export function flowInfoSection(eq) {
  const m = eq?.model;
  if (!m) return '';
  const kindName = { optimize: '最佳化', quality: '品質預測', occ: '健康預警', health: '健康預警' }[m.kind ?? m.product_type] ?? (m.task || '');
  const res = lastRun?.blocks?.[eq.tag];
  const inFlow = !!spec?.blocks?.find((b) => b.id === eq.tag);
  let liveRows = `<tr><td>即時預測</td><td class="inst-val">開啟「智慧運轉」後顯示</td></tr>`;
  if (on && res) {
    const guard = res.guard?.status ?? 'unknown';
    const gtext = { ok: '✓ 訓練域內', warn: '⚠ 外插（接近訓練域邊緣）', out: '✖ 出定義域', unknown: '— 無統計' }[guard];
    const bad = (res.guard?.checks ?? []).map((c) => `${c.feature} ${fmt(c.value)}∉[${fmt(c.lo)},${fmt(c.hi)}]`).join('、');
    const shown = res.error ? `<span class="fl-chip out">模型錯誤</span>` : res.skipped ? `<span class="fl-chip unknown">待上游</span>` :
      m.task === 'anomaly'
        ? `<span class="inst-val">${Math.round(res.prediction?.health ?? 0)} /100</span>${res.prediction?.over_threshold ? ' <span class="fl-chip out">超標</span>' : ''}`
        : `<span class="inst-val">${fmt(res.prediction?.value)} ${res.unit || ''}</span>`;
    liveRows = `
      <tr><td>即時預測</td><td>${shown}</td></tr>
      <tr><td>定義域</td><td><span class="fl-chip ${guard}">${gtext}</span>${bad ? `<div style="font-size:10.5px;color:var(--text-dim);margin-top:2px">${bad}</div>` : ''}</td></tr>`;
  }
  return `
    <div class="info-section">AI 模型（模型服務 L3）</div>
    <table class="info-table">
      <tr><td>model_key</td><td class="mono">${m.model_key}</td></tr>
      <tr><td>類型</td><td>${kindName}（${m.task}）</td></tr>
      ${liveRows}
      <tr><td>能力</td><td style="font-size:11px;color:var(--text-dim)">${(m.capabilities || []).join(' · ')}</td></tr>
    </table>
    ${on && inFlow ? `<button class="pid-btn" id="btn-block-ws" data-tag="${eq.tag}">⤢ 放大檢視（載入 flowsheet 綁定）</button>` : ''}`;
}

// ---------------------------------------------------------------- Block 工作面
// 點設備放大：該 block 的即時值+趨勢、輸入來源、what-if、最佳化，全部載進半版。

function specBlock(tag) { return spec?.blocks?.find((b) => b.id === tag); }
function knobFeatures(blk) {
  // 決策/what-if 變數候選＝該 block 的邊界特徵（被 connection 餵的是上游結果，不能當旋鈕）
  return Object.keys(blk.defaults || {}).filter((f) => !fedBy[blk.id]?.has(f));
}

function openBlockWs(tag) {
  const blk = specBlock(tag);
  if (!blk) return;
  wsTag = tag;
  document.getElementById('info-card').classList.add('hidden'); // 工作面即放大版資訊卡
  $('block-ws').classList.remove('hidden');
  buildWs(blk);
  refreshWs();
}
function closeBlockWs() {
  wsTag = null;
  $('block-ws').classList.add('hidden');
}

function buildWs(blk) {
  const eqm = ctx.eqMap[blk.id]?.def?.model || {};
  const anom = blk.kind === 'anomaly';
  const canOpt = (eqm.capabilities || []).includes('optimize');
  const feats = knobFeatures(blk);
  $('ws-body').innerHTML = `
    <div><span class="ws-tag">${blk.id}</span><span class="ws-name">${blk.name || ''}</span></div>
    <div class="ws-sub">${anom ? '健康預警' : '預測'}模型 · <span style="font-family:ui-monospace,Consolas,monospace">${blk.model_key}</span> · ${blk.output_label || ''}</div>
    <div class="ws-cols">
      <div>
        <div class="info-section">即時輸出（每拍更新）</div>
        <div class="ws-big" id="ws-val">--</div>
        <div id="ws-guard" style="margin-top:6px"></div>
        <svg class="ws-spark" id="ws-spark" viewBox="0 0 300 48" preserveAspectRatio="none"></svg>
        <div class="info-section">目前輸入（來源標記）</div>
        <table class="ws-inputs" id="ws-inputs"></table>
      </div>
      <div>
        <div class="info-section">what-if 旋鈕（拉動或輸入＝鎖定，下一拍生效）</div>
        <div id="ws-knobs"></div>
        ${canOpt ? `
        <div class="info-section">此模型最佳化</div>
        <div class="fo-row fo-inline">
          <select id="ws-mode">
            <option value="min">目標：最小化</option>
            <option value="max">目標：最大化</option>
            <option value="target">目標：逼近指定值</option>
          </select>
          <input type="number" id="ws-value" placeholder="目標值" style="display:none">
        </div>
        <button class="fo-run" id="ws-run">⚙ 執行最佳化（勾選的變數）</button>
        <div id="ws-out"></div>` : `
        <div class="panel-hint" style="margin-top:10px">此模型類型（${anom ? '健康預警' : blk.kind}）不提供最佳化；可用上方旋鈕做 what-if。</div>`}
      </div>
    </div>`;
  // 旋鈕
  renderWsKnobs(blk, feats);
  if (canOpt) {
    $('ws-mode').addEventListener('change', () => {
      $('ws-value').style.display = $('ws-mode').value === 'target' ? '' : 'none';
    });
    $('ws-run').addEventListener('click', () => runWsOptimize(blk));
  }
}

function renderWsKnobs(blk, feats) {
  const box = $('ws-knobs');
  if (!feats.length) { box.innerHTML = '<div class="panel-hint">此 block 的輸入全部來自上游，無可調變數。</div>'; return; }
  box.innerHTML = feats.map((f) => {
    const rg = blk.feature_ranges?.[f];
    const lo = rg?.[0], hi = rg?.[1];
    const cur = lastRun?.blocks?.[blk.id]?.inputs?.[f] ?? blk.defaults[f];
    const step = rg ? Math.max((hi - lo) / 200, 1e-6).toPrecision(2) : 'any';
    const ov = overrides[blk.id]?.[f];
    return `<div class="fo-knob ${ov != null ? 'overridden' : ''}" id="ws-knob-${f}">
      <div class="fo-knob-head">
        <label><input type="checkbox" class="ws-use" data-f="${f}" checked><span class="fo-feat" title="${f}">${f}</span></label>
        <span class="fo-cur" id="ws-cur-${f}">目前 ${fmt(cur)}</span>
        ${ov != null ? `<button class="fo-clear" data-f="${f}" title="解除鎖定，回到即時訊號">✕</button>` : ''}
      </div>
      ${rg ? `
      <div class="fo-ctrl">
        <input type="range" id="ws-sl-${f}" min="${lo}" max="${hi}" step="${step}" value="${ov ?? cur}">
        <input type="number" id="ws-in-${f}" step="${step}" value="${(+(ov ?? cur)).toFixed(3)}">
      </div>
      <div class="fo-range">訓練域 ${fmt(lo)} ~ ${fmt(hi)}</div>` : `
      <div class="fo-range">（無訓練域統計，僅能參與最佳化、不能手動鎖定）</div>`}
    </div>`;
  }).join('');
  for (const f of feats) {
    const sl = $(`ws-sl-${f}`), inp = $(`ws-in-${f}`);
    if (!sl) continue;
    const setOv = (v) => {
      (overrides[blk.id] ??= {})[f] = +v;
      const kn = $(`ws-knob-${f}`);
      if (kn && !kn.classList.contains('overridden')) renderWsKnobs(blk, feats); // 補 ✕ 鈕與樣式
    };
    sl.addEventListener('input', () => { inp.value = (+sl.value).toFixed(3); setOv(sl.value); });
    inp.addEventListener('change', () => {
      const v = Math.min(Math.max(+inp.value, +sl.min), +sl.max); // 夾回訓練域
      inp.value = (+v).toFixed(3); sl.value = v; setOv(v);
    });
  }
  box.querySelectorAll('.fo-clear').forEach((btn) => btn.addEventListener('click', () => {
    delete overrides[blk.id]?.[btn.dataset.f];
    renderWsKnobs(blk, feats);
  }));
}

function refreshWs() {
  const blk = specBlock(wsTag);
  const res = lastRun?.blocks?.[wsTag];
  if (!blk || !res) return;
  const anom = blk.kind === 'anomaly';
  // 即時值 + 帶色
  const v = shownValueOf(blk, res);
  const band = res.error || res.skipped ? 'ok' : bandOf(blk, res);
  const col = band === 'crit' ? 'var(--alarm)' : band === 'warn' ? '#b96f10' : 'var(--text)';
  $('ws-val').innerHTML = res.error ? '模型錯誤' : res.skipped ? '待上游' :
    `${anom ? Math.round(v ?? 0) : fmt(v)}<span class="unit"> ${anom ? '/100' : (blk.unit || '')}</span>`;
  $('ws-val').style.color = col;
  // 守門
  const guard = res.guard?.status ?? 'unknown';
  const gtext = { ok: '✓ 訓練域內', warn: '⚠ 外插（接近訓練域邊緣）', out: '✖ 出定義域', unknown: '— 無統計' }[guard];
  const bad = (res.guard?.checks ?? []).map((c) => `${c.feature} ${fmt(c.value)}∉[${fmt(c.lo)},${fmt(c.hi)}]`).join('、');
  $('ws-guard').innerHTML = `<span class="fl-chip ${guard}">${gtext}</span>${bad ? `<div style="font-size:10.5px;color:var(--text-dim);margin-top:3px">${bad}</div>` : ''}`;
  // 趨勢
  const hist = HIST[wsTag] || [];
  if (hist.length >= 2) {
    const min = Math.min(...hist), max = Math.max(...hist), span = (max - min) || 1;
    const pts = hist.map((y, i) => `${(i / (hist.length - 1)) * 300},${44 - ((y - min) / span) * 38}`).join(' ');
    $('ws-spark').innerHTML = `
      <polyline points="${pts}" fill="none" stroke="#046AFB" stroke-width="1.6"/>
      <text x="3" y="10" font-size="8" fill="#8ba0b3">${fmt(max)}</text>
      <text x="3" y="45" font-size="8" fill="#8ba0b3">${fmt(min)}</text>`;
  }
  // 輸入表（來源標記：上游/鎖定/邊界）
  const fed = fedBy[wsTag] ?? new Set();
  const ov = overrides[wsTag] || {};
  $('ws-inputs').innerHTML = Object.entries(res.inputs || {}).map(([f, val]) => {
    const src = fed.has(f) ? '<span class="ws-src up">上游</span>' :
      (ov[f] != null ? '<span class="ws-src ov">鎖定</span>' : '<span class="ws-src bd">邊界</span>');
    return `<tr><td>${f}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${fmt(val)}</td><td style="width:44px;text-align:right">${src}</td></tr>`;
  }).join('');
  // 旋鈕「目前值」小字
  for (const [f, val] of Object.entries(res.inputs || {})) {
    const cur = $(`ws-cur-${f}`);
    if (cur) cur.textContent = `目前 ${fmt(val)}`;
  }
}

async function runWsOptimize(blk) {
  const mode = $('ws-mode').value;
  const knobs = [...document.querySelectorAll('.ws-use:checked')].map((c) => c.dataset.f);
  const out = $('ws-out');
  if (!knobs.length) { out.innerHTML = '<div class="fo-headline err">至少勾選一個決策變數</div>'; return; }
  if (mode === 'target' && $('ws-value').value === '') { out.innerHTML = '<div class="fo-headline err">逼近模式需要目標值</div>'; return; }
  const btn = $('ws-run');
  btn.disabled = true; btn.textContent = '⚙ 求解中…';
  try {
    const body = { mode, knobs };
    if (mode === 'target') body.value = +$('ws-value').value;
    const r = await fetch(`/agatha/model/${encodeURIComponent(blk.model_key)}/optimize/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((x) => x.json());
    if (!r || !r.best) throw new Error(r?.detail || '回應缺 best');
    const modeTxt = { min: '最小化', max: '最大化', target: `逼近 ${body.value}` }[mode];
    out.innerHTML = `
      <div class="fo-headline">${blk.output_label || '目標'} ${modeTxt}：預估 ${fmt(r.baseline_pred)} → <b>${fmt(r.pred)}</b> ${blk.unit || ''}
        <div style="font-size:10.5px;font-weight:400;color:var(--text-dim);margin-top:3px">預估以訓練基準狀態計算；「套用」後以現場即時狀態（含上游模型輸出）重新求解驗證</div></div>
      <div class="fo-result"><table>
        ${Object.entries(r.best).map(([f, v]) => `
          <tr><td>${f}</td><td class="fo-best">${fmt(v)}</td>
          <td style="text-align:right"><button class="fo-apply" data-f="${f}" data-v="${v}">套用</button></td></tr>`).join('')}
        <tr><td colspan="3" style="text-align:right;border-bottom:none">
          <button class="fo-apply" id="ws-apply-all">全部套用 → 下一拍生效</button></td></tr>
      </table></div>`;
    out.querySelectorAll('.fo-apply[data-f]').forEach((b) => b.addEventListener('click', () => {
      (overrides[blk.id] ??= {})[b.dataset.f] = +b.dataset.v;
      renderWsKnobs(blk, knobFeatures(blk));
    }));
    $('ws-apply-all')?.addEventListener('click', () => {
      for (const [f, v] of Object.entries(r.best)) (overrides[blk.id] ??= {})[f] = +v;
      renderWsKnobs(blk, knobFeatures(blk));
    });
  } catch (e) {
    out.innerHTML = `<div class="fo-headline err">最佳化失敗：${e.message || e}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = '⚙ 執行最佳化（勾選的變數）';
  }
}

// ---------------------------------------------------------------- 右側排版（防疊）
// 監看卡頂端 = 資訊卡「實際」底部 + 10px（量測矩形，不猜高度）；
// 資訊卡關閉→回彈到預設（bottom 錨定）；剩餘空間太小→監看卡整張讓位。
function layoutRightRail() {
  const panel = $('flow-panel');
  if (!on || panel.classList.contains('hidden')) return;
  const info = document.getElementById('info-card');
  const infoVisible = info && !info.classList.contains('hidden');
  if (infoVisible) {
    const top = info.getBoundingClientRect().bottom + 10;
    const room = innerHeight - 70 - top; // 底部錨在 70px（scenario bar 上緣）
    if (room < 140) { panel.style.display = 'none'; return; } // 空間太小整張讓位
    panel.style.display = '';
    panel.style.top = `${top}px`;
    panel.style.maxHeight = 'none'; // top+bottom 雙錨定，高度由空間決定
  } else {
    panel.style.display = '';
    panel.style.top = 'auto';
    panel.style.maxHeight = '';
  }
}

// ---------------------------------------------------------------- 開關與掛載
function setOn(v) {
  on = v;
  document.body.classList.toggle('flow-on', on); // 資訊卡封頂（style.css）
  $('flow-toggle').classList.toggle('active', on);
  $('flow-panel').classList.toggle('hidden', !on);
  if (on) { tick(); timer = setInterval(tick, 2200); layoutRightRail(); }
  else {
    clearInterval(timer); timer = null; clearBadges(); closeBlockWs();
    const panel = $('flow-panel');
    panel.style.top = 'auto'; panel.style.maxHeight = ''; panel.style.display = '';
  }
}

export async function initTwinFlow(context) {
  ctx = context;
  const fid = ctx.plantData?.flowsheet;
  if (!fid) return; // 此場景沒綁 flowsheet → 功能不出現
  try {
    const r = await fetch(`/agatha/flowsheet/${encodeURIComponent(fid)}/spec/`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(String(r.status));
    spec = await r.json();
  } catch { return; } // 求解器未上線 → 安靜不出現（與製程計算同策略）
  for (const c of spec.connections ?? []) {
    (fedBy[c.to] ??= new Set()).add(c.target_input);
  }
  // 常用操作滑桿（calc-slider 同樣式）
  $('flow-sliders').innerHTML = KNOBS.map((k) => `
    <div class="calc-slider">
      <label><span>${k.label}${k.unit ? `（${k.unit}）` : ''}</span><b id="fv-${k.key}">${k.val.toFixed(k.dec)}${k.unit ? ` ${k.unit}` : ''}</b></label>
      <input type="range" id="fs-${k.key}" min="${k.min}" max="${k.max}" step="${k.step}" value="${k.val}">
    </div>`).join('');
  for (const k of KNOBS) {
    $(`fs-${k.key}`).addEventListener('input', (e) => {
      $(`fv-${k.key}`).textContent = `${(+e.target.value).toFixed(k.dec)}${k.unit ? ` ${k.unit}` : ''}`;
    });
  }
  $('flow-demo-fan').addEventListener('click', (e) => {
    demo.fan = !demo.fan; e.target.classList.toggle('active', demo.fan);
    e.target.textContent = demo.fan ? '演示中：風機劣化' : '演示：風機劣化';
  });
  $('flow-demo-lhv').addEventListener('click', (e) => {
    demo.lhv = !demo.lhv; e.target.classList.toggle('active', demo.lhv);
    e.target.textContent = demo.lhv ? '演示中：熱值下降' : '演示：熱值下降';
  });
  // 資訊卡「⤢ 放大檢視」→ Block 工作面（事件代理：卡片內容每拍重繪，不能綁死）
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#btn-block-ws');
    if (btn) openBlockWs(btn.dataset.tag);
  });
  $('ws-close').addEventListener('click', closeBlockWs);

  // 資訊卡開/關/內容變動（app.js 控制）→ 重排右側；視窗改尺寸同理
  const infoCard = document.getElementById('info-card');
  new MutationObserver(layoutRightRail).observe(infoCard,
    { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  addEventListener('resize', layoutRightRail);

  const btn = $('flow-toggle');
  btn.style.display = '';
  btn.addEventListener('click', () => setOn(!on));
  // ?flow=1 → 進頁自動開啟（首頁「智慧運轉」卡的入口）
  if (new URLSearchParams(location.search).get('flow') === '1') setOn(true);
}
