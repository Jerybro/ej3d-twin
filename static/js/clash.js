// Clash 檢測（對標 AVEVA E3D Clash Detection 模型）
// - 三級分類：Physical Clash（貫穿 > Overlap 值）／Touch（貫穿≤Overlap 或間距≤Gap）／Clearance（間距介於 Gap 與 Clearance）
// - 遮蔽碼 HH/HS/SS/SH：由兩物件的 Obstruction 屬性(hard/soft)組成（def.obst==='soft' → S，預設 H）
// - Hold/Approved 狀態：持久化於 sceneData.clashStatus[key]，Approved 不再視為未處理
// 純 AABB 幾何近似；管線每段取樣點對設備 AABB 判定（端點合法接管排除）。
import * as THREE from 'three';

const MAX_RESULTS = 400;
// 預設容差（公尺）：Overlap 1mm、Gap 50mm、Clearance 0（關閉，避免洗版；可由呼叫端覆寫）
export const CLASH_TOL = { overlap: 0.001, gap: 0.05, clearance: 0 };

const obstCode = (def) => (def?.obst === 'soft' ? 'S' : 'H');
export const clashKey = (a, b) => [a, b].sort().join(' × ');

function boxGap(A, B) {   // AABB 間最短距離（重疊時為 0）
  const dx = Math.max(A.min.x - B.max.x, B.min.x - A.max.x, 0);
  const dy = Math.max(A.min.y - B.max.y, B.min.y - A.max.y, 0);
  const dz = Math.max(A.min.z - B.max.z, B.min.z - A.max.z, 0);
  return Math.hypot(dx, dy, dz);
}
function boxPenetration(A, B) {   // 重疊時的最小貫穿深度（各軸取最小）
  const ox = Math.min(A.max.x, B.max.x) - Math.max(A.min.x, B.min.x);
  const oy = Math.min(A.max.y, B.max.y) - Math.max(A.min.y, B.min.y);
  const oz = Math.min(A.max.z, B.max.z) - Math.max(A.min.z, B.min.z);
  return Math.min(ox, oy, oz);
}
// 依貫穿/間距分級；回傳 null 表示不成立
function classify(pen, gap, tol) {
  if (pen > tol.overlap) return 'physical';
  if (gap <= tol.gap) return 'touch';
  if (tol.clearance > 0 && gap <= tol.clearance) return 'clearance';
  return null;
}

export function runClash(sceneData, eqObjects, hiddenTags, tol = CLASH_TOL) {
  const status = sceneData.clashStatus ?? {};
  const out = [];
  const entries = [];
  for (const [tag, entry] of eqObjects) {
    if (hiddenTags?.has(tag)) continue;
    const box = new THREE.Box3().setFromObject(entry.group);
    entries.push({ tag, box, def: entry.def });
  }
  const push = (o) => {
    o.code = o.code ?? 'HH';
    o.status = status[clashKey(o.a, o.b)] ?? 'new';
    out.push(o);
  };

  // 設備 × 設備
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const A = entries[i], B = entries[j];
      const pen = boxPenetration(A.box, B.box);
      const gap = pen > 0 ? 0 : boxGap(A.box, B.box);
      const cls = classify(Math.max(pen, 0), gap, tol);
      if (cls) {
        push({ type: cls, a: A.tag, b: B.tag, code: obstCode(A.def) + obstCode(B.def),
               point: A.box.getCenter(new THREE.Vector3()).lerp(B.box.getCenter(new THREE.Vector3()), 0.5) });
      }
      if (out.length >= MAX_RESULTS) return finish(out, true);
    }
  }

  // 管線 × 設備（跳過橋接與合法端點接管）
  const v = new THREE.Vector3();
  sceneData.pipes.forEach((pipe, pi) => {
    if (pipe.bridge) return;
    const pts = pipe.pts.map((p) => new THREE.Vector3(...p));
    for (const E of entries) {
      const r = E.def.dims?.r ?? Math.max(E.def.dims?.w ?? 2, E.def.dims?.d ?? 2) / 2;
      const cx = E.def.pos[0], cz = E.def.pos[2];
      const endOk = [pts[0], pts[pts.length - 1]].some(
        (p) => Math.hypot(p.x - cx, p.z - cz) < r + 2.5);
      if (endOk) continue;
      const boxGrown = E.box.clone().expandByScalar(pipe.r + 0.05);
      let hit = null;
      for (let s = 0; s < pts.length - 1 && !hit; s++) {
        for (let k = 0; k <= 8; k++) {
          v.lerpVectors(pts[s], pts[s + 1], k / 8);
          if (boxGrown.containsPoint(v)) { hit = v.clone(); break; }
        }
      }
      if (hit) {
        push({ type: 'physical', a: `PIPE #${pi + 1}`, b: E.tag,
               code: 'H' + obstCode(E.def), point: hit, pipeIndex: pi });
        if (out.length >= MAX_RESULTS) return;
      }
    }
  });
  return finish(out, out.length >= MAX_RESULTS);
}

function finish(list, capped) {
  const order = { physical: 0, pipe: 1, touch: 2, clearance: 3 };
  // 未處理優先、Approved 沉底；同狀態內依嚴重度
  const sOrder = { new: 0, held: 1, approved: 2 };
  list.sort((a, b) => (sOrder[a.status] - sOrder[b.status]) || (order[a.type] - order[b.type]));
  const open = list.filter((c) => c.status !== 'approved').length;
  return { clashes: list.slice(0, MAX_RESULTS), capped, open, total: list.length };
}
