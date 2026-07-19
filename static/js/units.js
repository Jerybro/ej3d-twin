// 單位轉換層（全站共用、純顯示）：換算只動「畫面上顯示的數字」，
// 模型輸入輸出、規格檔、守門員全部維持原單位——顯示層永遠可還原、不污染資料。
// 用法：
//   Units.canon('mg_Nm3')            → 'mg/Nm³'（各種寫法正規化；認不得 → null）
//   Units.featUnit('outlet_NOx_mg_Nm3') → 'mg/Nm³'（從特徵名後綴抽單位）
//   Units.family('mg/Nm³')           → ['mg/Nm³','µg/Nm³','g/Nm³']（可換清單；單一單位 → null）
//   Units.convert(120,'mg/Nm³','g/Nm³') → 0.12（同族仿射換算；跨族 → null）
//   Units.disp(0.1234)               → '0.123'（自適應小數位）
window.Units = (function () {
  // 家族表：label → [k, b]，「顯示值 = k × 基準值 + b」；每族第一個即基準單位
  const FAM = {
    temp:   { '°C': [1, 0], '°F': [1.8, 32], 'K': [1, 273.15] },
    press:  { 'kPa': [1, 0], 'bar': [0.01, 0], 'mbar': [10, 0], 'psi': [0.1450377, 0] },
    mflow:  { 't/h': [1, 0], 'kg/h': [1000, 0], 'kg/s': [0.2777778, 0] },
    vflow:  { 'm³/h': [1, 0], 'L/h': [1000, 0], 'L/min': [16.66667, 0] },
    nflow:  { 'kNm³/h': [1, 0], 'Nm³/h': [1000, 0] },
    conc:   { 'mg/Nm³': [1, 0], 'µg/Nm³': [1000, 0], 'g/Nm³': [0.001, 0] },
    power:  { 'MW': [1, 0], 'kW': [1000, 0] },
    energy: { 'kJ/kg': [1, 0], 'MJ/kg': [0.001, 0], 'kcal/kg': [0.2388459, 0] },
    speed:  { 'm/h': [1, 0], 'm/min': [1 / 60, 0] },
  };
  // 寫法別名 → 正規 label（特徵後綴的底線寫法、規格檔自由填寫都收）
  const ALIAS = {
    'c': '°C', '°c': '°C', '℃': '°C', 'degc': '°C', 'f': '°F', '°f': '°F', 'k': 'K',
    'kpa': 'kPa', 'bar': 'bar', 'mbar': 'mbar', 'psi': 'psi',
    't/h': 't/h', 't_h': 't/h', 'kg/h': 'kg/h', 'kg_h': 'kg/h', 'kg/s': 'kg/s',
    'm³/h': 'm³/h', 'm3/h': 'm³/h', 'm3_h': 'm³/h',
    'l/h': 'L/h', 'l_h': 'L/h', 'l/min': 'L/min',
    'knm³/h': 'kNm³/h', 'knm3/h': 'kNm³/h', 'knm3_h': 'kNm³/h',
    'nm³/h': 'Nm³/h', 'nm3/h': 'Nm³/h', 'nm3_h': 'Nm³/h',
    'mg/nm³': 'mg/Nm³', 'mg/nm3': 'mg/Nm³', 'mg_nm3': 'mg/Nm³',
    'µg/nm³': 'µg/Nm³', 'ug/nm³': 'µg/Nm³', 'ug/nm3': 'µg/Nm³', 'ug_nm3': 'µg/Nm³',
    'g/nm³': 'g/Nm³', 'g/nm3': 'g/Nm³', 'g_nm3': 'g/Nm³',
    'mw': 'MW', 'kw': 'kW',
    'kj/kg': 'kJ/kg', 'kj_kg': 'kJ/kg', 'mj/kg': 'MJ/kg', 'kcal/kg': 'kcal/kg',
    'm/h': 'm/h', 'm_h': 'm/h', 'm/min': 'm/min',
    // 單一單位（無族可換，僅供顯示標籤）
    'a': 'A', 'pct': '%', '%': '%', 'mm/s': 'mm/s', 'mm_s': 'mm/s',
  };
  const FAM_OF = {};
  for (const [fk, units] of Object.entries(FAM))
    for (const label of Object.keys(units)) FAM_OF[label] = fk;

  function canon(u) { return ALIAS[String(u || '').trim().toLowerCase()] || null; }
  // 特徵名後綴 → 單位（與 prettyFeat 同一組後綴）
  const SUFFIX = /_((?:mg|ug|g)_Nm3|kNm3_h|t_h|kJ_kg|L_h|kg_h|m3_h|mm_s|m_h|MW|kPa|bar|pct|mbar|C|A)$/;
  function featUnit(feat) {
    const m = SUFFIX.exec(String(feat || ''));
    return m ? canon(m[1]) : null;
  }
  function family(u) {
    const c = canon(u); if (!c) return null;
    const fk = FAM_OF[c]; if (!fk) return null;
    const labels = Object.keys(FAM[fk]);
    return labels.length > 1 ? labels : null;
  }
  function convert(v, from, to) {
    if (v == null || !isFinite(v)) return null;
    const f = canon(from), t = canon(to);
    if (!f || !t || f === t) return f && t ? +v : null;
    const fk = FAM_OF[f];
    if (!fk || FAM_OF[t] !== fk) return null;
    const [kf, bf] = FAM[fk][f], [kt, bt] = FAM[fk][t];
    return kt * ((+v - bf) / kf) + bt;
  }
  function disp(v) {
    if (v == null || !isFinite(v)) return '--';
    const a = Math.abs(v);
    return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
  }
  return { canon, featUnit, family, convert, disp };
})();
