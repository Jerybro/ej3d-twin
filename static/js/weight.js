// 重量與重心（Weight & CoG）估算 — 對標 E3D PROPCON 重量/CoG 報表
// 逐設備：def.dims → 體積(m³) → 質量(kg) → 彙總全場重心 CoG。
//
// 估算法（method）：
//   殼體型製程設備（tank/column/vessel/reactor/tower/drum/flash…）→
//     以「表面積 × 等效壁厚 12mm × 鋼密度」估空殼重（避免實心高估）。
//   其餘設備 → 實心體積 × 材料密度。
//   assembly（自建設備）→ 各 prims 幾何分別估體積後加總；殼體判定沿用父設備類型。
//   CoG = Σ(mᵢ·cᵢ)/Σmᵢ，cᵢ 取 def.pos 平移到幾何質心高度（pos[1] + 高度一半）。
//
// 單位鐵則：輸入 sceneData 內數值恆為公尺；本模組全程以公尺/kg 計算，回傳 cog 亦為公尺。

// 材料密度 (kg/m³)
export const MATERIALS = {
  碳鋼: 7850,
  不銹鋼: 8000,
  混凝土: 2400,
  PVC: 1400,
  鋁: 2700,
};
const DEFAULT_MATERIAL = '碳鋼';
const SHELL_WALL_M = 0.012;   // 等效壁厚 12mm（殼體型設備）

// 由設備解析材料密度：優先 def.material（規格指定），否則讀 def.design.材質（實際資料在此）。
// 支援常見鋼種字串（SUS/304/316→不銹鋼），無法辨識則回退碳鋼。
function densityOf(def) {
  const explicit = def?.material;
  if (explicit && MATERIALS[explicit] != null) return MATERIALS[explicit];
  const grade = explicit ?? def?.design?.材質 ?? '';
  if (grade) {
    if (MATERIALS[grade] != null) return MATERIALS[grade];
    if (/SUS|不銹|不鏽|SS3|304|316|321|310/i.test(grade)) return MATERIALS.不銹鋼;
    if (/PVC|塑/i.test(grade)) return MATERIALS.PVC;
    if (/混凝土|RC|concrete/i.test(grade)) return MATERIALS.混凝土;
    if (/鋁|alu/i.test(grade)) return MATERIALS.鋁;
    if (/碳鋼|CS|SS4|A106|A53|碳/i.test(grade)) return MATERIALS.碳鋼;
  }
  return MATERIALS[DEFAULT_MATERIAL];
}
// 材料顯示標籤（報表註記用）
function materialLabelOf(def) {
  return def?.material ?? def?.design?.材質 ?? DEFAULT_MATERIAL;
}

// 殼體型設備 type 白名單（製程容器：以空殼估重較合理）
const SHELL_TYPES = new Set([
  'tank', 'column', 'packedcol', 'fixedbed', 'reactor', 'kettle',
  'flash_v', 'flash_h', 'drum', 'bullet', 'spheretank',
  'cyclone', 'coolingtower', 'coolingt', 'vessel', 'tower',
  'flare', 'stack', 'hx', 'aircooler',
]);
// 名稱關鍵字（type 不在白名單時，用中文名再判一次）
const SHELL_NAME_RE = /槽|塔|罐|桶|反應器|反應槽|容器|分離器|旋風|冷卻塔|熱交換|換熱|冷凝|蒸餾|drum|tank|column|vessel|reactor|tower|flash|separator|drum/i;

// 中空／圍蔽型結構（建物/爐體/框架/機殼）：非製程容器，但也非實心金屬塊。
// 以「外表面積 × 較厚等效壁厚」估外殼＋框架重，避免當實心塊高估數十倍。
const HOLLOW_TYPES = new Set([
  'building', 'block', 'furnace', 'boiler', 'baghouse', 'skid',
  'piperack', 'aircooler', 'platehx', 'compressor', 'blower', 'genset',
  'chiller', 'mcc', 'transformer',
]);
const HOLLOW_WALL_M = 0.05;   // 圍蔽型等效壁厚 50mm（含框架/機殼平均化）

function isShell(type, name) {
  if (type && SHELL_TYPES.has(type)) return true;
  if (name && SHELL_NAME_RE.test(name)) return true;
  return false;
}
function isHollow(type) {
  return type && HOLLOW_TYPES.has(type);
}
// 估法標籤：'shell' 薄殼 / 'hollow' 圍蔽 / 'solid' 實心
function methodOf(def) {
  if (isShell(def.type, def.name)) return 'shell';
  if (isHollow(def.type)) return 'hollow';
  return 'solid';
}

// 依 dims 估「實心體積 (m³)」與「近似高度 (m)」（供質心抬升與表面積推估）
// 回傳 { vol, height, area }：area = 外表面積（殼體估重用）
function geomOfDims(d) {
  if (!d) return { vol: 0, height: 0, area: 0 };
  const r = d.r, h = d.h, len = d.len, w = d.w, ht = d.h, dp = d.d, s = d.s;
  // 立式圓柱：r + h（πr²h）
  if (r != null && h != null) {
    const vol = Math.PI * r * r * h;
    const area = 2 * Math.PI * r * h + 2 * Math.PI * r * r; // 側面 + 兩端
    return { vol, height: h, area };
  }
  // 臥式圓柱：r + len（πr²·len）
  if (r != null && len != null) {
    const vol = Math.PI * r * r * len;
    const area = 2 * Math.PI * r * len + 2 * Math.PI * r * r;
    return { vol, height: 2 * r, area }; // 臥式：外形高度 ≈ 直徑
  }
  // 箱體：w,h,d
  if (w != null && ht != null && dp != null) {
    const vol = w * ht * dp;
    const area = 2 * (w * ht + ht * dp + w * dp);
    return { vol, height: ht, area };
  }
  // 立方/閥體：s（邊長）
  if (s != null) {
    const vol = s * s * s;
    const area = 6 * s * s;
    return { vol, height: s, area };
  }
  // 球：r only（4/3πr³）
  if (r != null) {
    const vol = (4 / 3) * Math.PI * r * r * r;
    const area = 4 * Math.PI * r * r;
    return { vol, height: 2 * r, area };
  }
  // 僅 h（無斷面尺寸）：細長桿/塔架（flare 火炬、lightpole 燈桿、detector 桿等）——以預設等效半徑估
  if (h != null) {
    const rr = 0.3;
    const vol = Math.PI * rr * rr * h;
    const area = 2 * Math.PI * rr * h + 2 * Math.PI * rr * rr;
    return { vol, height: h, area };
  }
  return { vol: 0, height: 0, area: 0 };
}

// prim（assembly 子件）→ { vol, area, top }：top = 該 prim 在本地座標的頂端高度（估質心用）
function geomOfPrim(p) {
  const d = p?.dims ?? {};
  const dy = (p?.pos && p.pos[1]) || 0;
  let vol = 0, area = 0, height = 0;
  if (p.kind === 'box') {
    vol = (d.w || 0) * (d.h || 0) * (d.d || 0);
    area = 2 * ((d.w || 0) * (d.h || 0) + (d.h || 0) * (d.d || 0) + (d.w || 0) * (d.d || 0));
    height = d.h || 0;
  } else if (p.kind === 'cyli') {
    const r = d.r || 0, h = d.h || 0;
    vol = Math.PI * r * r * h;
    area = 2 * Math.PI * r * h + 2 * Math.PI * r * r;
    height = h;
  } else if (p.kind === 'cone' || p.kind === 'snou') {
    // 截頭錐：V = π/3·h·(r1²+r1r2+r2²)
    const r1 = d.r1 ?? 0.9, r2 = d.r2 ?? 0.3, h = d.h ?? 1;
    vol = (Math.PI / 3) * h * (r1 * r1 + r1 * r2 + r2 * r2);
    const sl = Math.hypot(h, r1 - r2);            // 斜高
    area = Math.PI * (r1 + r2) * sl + Math.PI * (r1 * r1 + r2 * r2);
    height = h;
  } else if (p.kind === 'dish') {
    // 半球殼頭：半球體積 2/3πr³
    const r = d.r || 0;
    vol = (2 / 3) * Math.PI * r * r * r;
    area = 2 * Math.PI * r * r;
    height = r;
  } else if (p.kind === 'pyra') {
    // 矩形截頭錐：V = h/3·(A1+A2+√(A1A2))
    const bx = d.bx ?? 1.4, bz = d.bz ?? 1.4, tx = d.tx ?? 0.6, tz = d.tz ?? 0.6, h = d.h ?? 1.2;
    const A1 = bx * bz, A2 = tx * tz;
    vol = (h / 3) * (A1 + A2 + Math.sqrt(A1 * A2));
    area = A1 + A2 + 2 * ((bx + tx) / 2 + (bz + tz) / 2) * h; // 近似側面
    height = h;
  } else if (p.kind === 'ctor') {
    // 圓環／彎頭：V = (ang/2π)·2π²·R·rt²，A = (ang/2π)·4π²·R·rt
    const R = d.r ?? 0.9, rt = d.rt ?? 0.2, frac = ((d.ang ?? 90) / 360);
    vol = frac * 2 * Math.PI * Math.PI * R * rt * rt;
    area = frac * 4 * Math.PI * Math.PI * R * rt;
    height = 2 * rt;
  } else {
    vol = 1; area = 6; height = 1; // 未知 kind：1m³ 佔位
  }
  return { vol, area, cy: dy + height / 2 };
}

// 由估法＋幾何求質量：shell 薄殼(表面積×壁厚)、hollow 圍蔽(表面積×較厚壁)、solid 實心(體積)
function massFromGeom(g, method, density) {
  if (method === 'shell') return g.area * SHELL_WALL_M * density;
  if (method === 'hollow') return g.area * HOLLOW_WALL_M * density;
  return g.vol * density;
}

// 單一設備 → { mass_kg, cog:[x,y,z], method }
function weighEquipment(def) {
  const density = densityOf(def);
  const pos = def.pos ?? [0, 0, 0];
  const method = methodOf(def);

  // assembly：逐 prim 估體積並以質量加權求局部質心高度
  if (def.type === 'assembly' && Array.isArray(def.prims) && def.prims.length) {
    // assembly 子件多為結構/實心件，除非父被判為殼體型才走薄殼
    const primMethod = method === 'shell' ? 'shell' : 'solid';
    let mass = 0, myWeighted = 0;
    for (const p of def.prims) {
      const g = geomOfPrim(p);
      const m = massFromGeom(g, primMethod, density);
      mass += m;
      myWeighted += m * ((pos[1] || 0) + g.cy);
    }
    const cy = mass > 0 ? myWeighted / mass : (pos[1] || 0);
    return { mass_kg: mass, cog: [pos[0], cy, pos[2]], method: primMethod };
  }

  const g = geomOfDims(def.dims);
  const mass = massFromGeom(g, method, density);
  const cy = (pos[1] || 0) + g.height / 2;
  return { mass_kg: mass, cog: [pos[0], cy, pos[2]], method };
}

// 管線環面重（選做）：外徑環面積 × 長度 × 鋼密度
// pipe.r = 外半徑(m)；wallM = 壁厚(m)（無則以外徑 8% 估）
function weighPipe(pipe, lengthM) {
  const ro = pipe.r ?? 0;
  const wall = pipe.wall_m ?? (ro > 0 ? ro * 0.16 : 0); // 缺壁厚：外徑 ~8%
  const ri = Math.max(0, ro - wall);
  const ringArea = Math.PI * (ro * ro - ri * ri);
  return ringArea * (lengthM || 0) * MATERIALS.碳鋼;
}

// 主入口：computeWeights(sceneData, eqObjects)
//   sceneData：場景資料（plant.units[].equipment[]）
//   eqObjects：Map<tag,{group,def}>（此處僅需 def；若未傳則回退掃 sceneData）
// 回傳：{ items:[{tag,name,type,mass_kg,cog:[x,y,z]}], total_kg, cog:[x,y,z], method, count }
export function computeWeights(sceneData, eqObjects) {
  const items = [];
  // 優先用 eqObjects（含即時 def）；否則走 sceneData
  const defs = [];
  if (eqObjects && typeof eqObjects.values === 'function') {
    for (const entry of eqObjects.values()) if (entry?.def) defs.push(entry.def);
  }
  if (!defs.length && sceneData?.plant?.units) {
    for (const u of sceneData.plant.units) for (const eq of (u.equipment ?? [])) defs.push(eq);
  }

  const METHOD_LABEL = { shell: '薄殼', hollow: '圍蔽', solid: '實心' };
  for (const def of defs) {
    const { mass_kg, cog, method } = weighEquipment(def);
    items.push({
      tag: def.tag,
      name: def.name ?? def.tag,
      type: def.type,
      material: materialLabelOf(def),
      method,                              // 'shell' | 'hollow' | 'solid'
      methodLabel: METHOD_LABEL[method] ?? method,
      shell: method === 'shell',           // 向後相容旗標
      mass_kg,
      cog,
    });
  }

  // 管線（選做）：若 sceneData.pipes 有幾何長度可估
  let pipeMass = 0;
  const pipes = sceneData?.pipes ?? [];
  for (const p of pipes) {
    const L = pipeLengthOf(p);
    if (!L) continue;
    const m = weighPipe(p, L);
    pipeMass += m;
  }

  // 全場 CoG（含管線？管線缺質心座標，僅計入總重、不偏移重心以免失真）
  let total = 0, sx = 0, sy = 0, sz = 0;
  for (const it of items) {
    total += it.mass_kg;
    sx += it.mass_kg * it.cog[0];
    sy += it.mass_kg * it.cog[1];
    sz += it.mass_kg * it.cog[2];
  }
  const cog = total > 0 ? [sx / total, sy / total, sz / total] : [0, 0, 0];

  return {
    items,
    total_kg: total,               // 設備總重（不含管線）
    pipe_kg: pipeMass,             // 管線估重（另計）
    grand_total_kg: total + pipeMass,
    cog,                           // 設備重心（公尺）
    count: items.length,
    method: '殼體型製程容器（槽/塔/罐/反應器…）以表面積×等效壁厚12mm×鋼密度估空殼重；圍蔽型結構（建物/爐體/框架/機殼）以表面積×等效壁厚50mm估外殼＋框架；其餘設備以實心體積×材料密度。材料密度取 def.material，缺則讀 def.design.材質（SUS→不銹鋼）。assembly 逐 prim 加總。管線以外徑環面積×長度×鋼密度另計（不併入重心）。CoG＝Σ(mᵢ·cᵢ)/Σmᵢ，質心取 pos 加幾何高度一半。',
  };
}

// 管線長度（m）：優先用內建 nodes/points 折線長度，否則 0（editor 端另有 pipeLength 可用）
function pipeLengthOf(p) {
  if (typeof p?.length_m === 'number') return p.length_m;
  const pts = p?.nodes ?? p?.points ?? p?.path;
  if (Array.isArray(pts) && pts.length >= 2) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const ax = a.x ?? a[0], ay = a.y ?? a[1], az = a.z ?? a[2];
      const bx = b.x ?? b[0], by = b.y ?? b[1], bz = b.z ?? b[2];
      L += Math.hypot((bx - ax) || 0, (by - ay) || 0, (bz - az) || 0);
    }
    return L;
  }
  return 0;
}
