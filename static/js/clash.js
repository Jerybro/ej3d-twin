// Clash 檢測（對標 E3D Clash Detection：Touch / Overlap / 管線干涉）
// 純幾何近似：設備 AABB 兩兩相交＝Overlap、間距 <0.3m＝Touch；
// 管線每段取樣點對設備 AABB 距離 < 管徑＋0.05 ＝干涉（端點合法接管排除）。
import * as THREE from 'three';

const MAX_RESULTS = 300;

export function runClash(sceneData, eqObjects, hiddenTags) {
  const out = [];
  const entries = [];
  for (const [tag, entry] of eqObjects) {
    if (hiddenTags?.has(tag)) continue;
    const box = new THREE.Box3().setFromObject(entry.group);
    entries.push({ tag, box, def: entry.def });
  }

  // 設備 × 設備
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const A = entries[i], B = entries[j];
      if (A.box.intersectsBox(B.box)) {
        out.push({ type: 'overlap', a: A.tag, b: B.tag,
                   point: A.box.getCenter(new THREE.Vector3()).lerp(B.box.getCenter(new THREE.Vector3()), 0.5) });
      } else {
        const touch = A.box.clone().expandByScalar(0.3);
        if (touch.intersectsBox(B.box)) {
          out.push({ type: 'touch', a: A.tag, b: B.tag,
                     point: A.box.getCenter(new THREE.Vector3()).lerp(B.box.getCenter(new THREE.Vector3()), 0.5) });
        }
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
      // 端點在接管圈內（半徑 r+2.5）＝設計上的合法連接，整條對此設備跳過
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
        out.push({ type: 'pipe', a: `PIPE #${pi + 1}`, b: E.tag, point: hit, pipeIndex: pi });
        if (out.length >= MAX_RESULTS) return;
      }
    }
  });
  return finish(out, out.length >= MAX_RESULTS);
}

function finish(list, capped) {
  const order = { overlap: 0, pipe: 1, touch: 2 };
  list.sort((a, b) => order[a.type] - order[b.type]);
  return { clashes: list.slice(0, MAX_RESULTS), capped };
}
