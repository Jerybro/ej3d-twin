// Clash 檢測（對標 AVEVA E3D Clash Detection 模型）
// - 三級分類：Physical Clash（貫穿 > Overlap 值）／Touch（貫穿≤Overlap 或間距≤Gap）／Clearance（間距介於 Gap 與 Clearance）
// - 遮蔽碼 HH/HS/SS/SH：由兩物件的 Obstruction 屬性(hard/soft)組成（def.obst==='soft' → S，預設 H）
// - Hold/Approved 狀態：持久化於 sceneData.clashStatus[key]，Approved 不再視為未處理
// 幾何：AABB 廣相位快速排除 + OBB 窄相位（分離軸定理 SAT）精確相交；
// 管線每段取樣點對設備 OBB 判定（點轉 OBB 本地座標比 half-size；端點合法接管排除）。
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
// 依貫穿/間距分級；回傳 null 表示不成立
function classify(pen, gap, tol) {
  if (pen > tol.overlap) return 'physical';
  if (gap <= tol.gap) return 'touch';
  if (tol.clearance > 0 && gap <= tol.clearance) return 'clearance';
  return null;
}

// ---- OBB（有向包圍盒）----
// 由 group 導出：clone group、暫時歸零 rotation 後 setFromObject 得「本地 AABB」，
// 取本地中心/half-size；再用該 group 的世界四元數與世界中心組 OBB。
// 設備多為 rot_y，此法可正確吃任意軸旋轉。
function makeOBB(group) {
  // 世界變換（確保最新）
  group.updateWorldMatrix(true, false);
  const worldQuat = new THREE.Quaternion();
  const worldPos = new THREE.Vector3();
  const worldScale = new THREE.Vector3();
  group.matrixWorld.decompose(worldPos, worldQuat, worldScale);

  // clone 並歸零旋轉，取得「本地座標系下」的 AABB（含本地位移與縮放，但無旋轉）
  const clone = group.clone(true);
  clone.quaternion.identity();
  clone.rotation.set(0, 0, 0);
  clone.position.set(0, 0, 0);
  clone.updateWorldMatrix(true, true);
  const localBox = new THREE.Box3().setFromObject(clone);

  const localCenter = localBox.getCenter(new THREE.Vector3());
  const halfSize = localBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  // 本地縮放併入 half-size 與本地中心（世界四元數不含縮放）
  halfSize.multiply(worldScale);
  localCenter.multiply(worldScale);

  // 世界中心 = 世界位置 + 世界旋轉作用後的本地中心
  const center = localCenter.clone().applyQuaternion(worldQuat).add(worldPos);

  // 三個世界軸向（單位向量）
  const rot = new THREE.Matrix4().makeRotationFromQuaternion(worldQuat);
  const e = rot.elements;
  const axes = [
    new THREE.Vector3(e[0], e[1], e[2]),
    new THREE.Vector3(e[4], e[5], e[6]),
    new THREE.Vector3(e[8], e[9], e[10]),
  ];
  return { center, halfSize: [halfSize.x, halfSize.y, halfSize.z], axes };
}

const EPS = 1e-6;

// OBB-OBB 分離軸定理：回傳 { pen, gap }
// pen = 重疊時沿最小穿透軸的貫穿深度（不重疊為 0）
// gap = 分離時的最短間距近似（重疊為 0）
function obbSAT(A, B) {
  const T = B.center.clone().sub(A.center);
  // 以 A 的軸為基底表示 T
  const t = [T.dot(A.axes[0]), T.dot(A.axes[1]), T.dot(A.axes[2])];
  // R[i][j] = A.axes[i]·B.axes[j]；absR 加 EPS 抗平行軸退化
  const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const absR = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      R[i][j] = A.axes[i].dot(B.axes[j]);
      absR[i][j] = Math.abs(R[i][j]) + EPS;
    }
  const a = A.halfSize, b = B.halfSize;

  let minPen = Infinity;   // 重疊時最小穿透
  let maxSepGap = 0;       // 分離時各軸投影缺口取最大（下界估計）
  let separated = false;

  const testAxis = (proj, ra, rb) => {
    // proj: 中心距在此軸的投影；ra+rb: 兩盒在此軸的半投影和
    const overlap = ra + rb - Math.abs(proj);
    if (overlap < 0) {
      separated = true;
      const g = -overlap;
      if (g > maxSepGap) maxSepGap = g;
    } else if (overlap < minPen) {
      minPen = overlap;
    }
  };

  // L = A 的 3 軸
  for (let i = 0; i < 3; i++) {
    const ra = a[i];
    const rb = b[0] * absR[i][0] + b[1] * absR[i][1] + b[2] * absR[i][2];
    testAxis(t[i], ra, rb);
  }
  // L = B 的 3 軸
  for (let j = 0; j < 3; j++) {
    const ra = a[0] * absR[0][j] + a[1] * absR[1][j] + a[2] * absR[2][j];
    const rb = b[j];
    const proj = t[0] * R[0][j] + t[1] * R[1][j] + t[2] * R[2][j];
    testAxis(proj, ra, rb);
  }
  // L = A_i × B_j（9 條交叉軸）
  const cross = [
    // i=0
    [[a[1] * absR[2][0] + a[2] * absR[1][0], b[1] * absR[0][2] + b[2] * absR[0][1], t[2] * R[1][0] - t[1] * R[2][0]],
     [a[1] * absR[2][1] + a[2] * absR[1][1], b[0] * absR[0][2] + b[2] * absR[0][0], t[2] * R[1][1] - t[1] * R[2][1]],
     [a[1] * absR[2][2] + a[2] * absR[1][2], b[0] * absR[0][1] + b[1] * absR[0][0], t[2] * R[1][2] - t[1] * R[2][2]]],
    // i=1
    [[a[0] * absR[2][0] + a[2] * absR[0][0], b[1] * absR[1][2] + b[2] * absR[1][1], t[0] * R[2][0] - t[2] * R[0][0]],
     [a[0] * absR[2][1] + a[2] * absR[0][1], b[0] * absR[1][2] + b[2] * absR[1][0], t[0] * R[2][1] - t[2] * R[0][1]],
     [a[0] * absR[2][2] + a[2] * absR[0][2], b[0] * absR[1][1] + b[1] * absR[1][0], t[0] * R[2][2] - t[2] * R[0][2]]],
    // i=2
    [[a[0] * absR[1][0] + a[1] * absR[0][0], b[1] * absR[2][2] + b[2] * absR[2][1], t[1] * R[0][0] - t[0] * R[1][0]],
     [a[0] * absR[1][1] + a[1] * absR[0][1], b[0] * absR[2][2] + b[2] * absR[2][0], t[1] * R[0][1] - t[0] * R[1][1]],
     [a[0] * absR[1][2] + a[1] * absR[0][2], b[0] * absR[2][1] + b[1] * absR[2][0], t[1] * R[0][2] - t[0] * R[1][2]]],
  ];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      // 交叉軸 A_i×B_j 長度 = sin(夾角)；接近 0 表示兩軸近平行，
      // 此軸退化為零長，投影無意義且易產生假分離，跳過（其他 12 軸已覆蓋）。
      const crossLen = Math.hypot(
        A.axes[i].y * B.axes[j].z - A.axes[i].z * B.axes[j].y,
        A.axes[i].z * B.axes[j].x - A.axes[i].x * B.axes[j].z,
        A.axes[i].x * B.axes[j].y - A.axes[i].y * B.axes[j].x);
      if (crossLen < EPS) continue;
      const [ra, rb, proj] = cross[i][j];
      testAxis(proj, ra, rb);
    }

  if (separated) return { pen: 0, gap: maxSepGap };
  return { pen: minPen === Infinity ? 0 : minPen, gap: 0 };
}

// 點是否在 OBB 內：轉本地座標比 half-size
function pointInOBB(p, obb, margin = 0) {
  const d = p.clone().sub(obb.center);
  for (let i = 0; i < 3; i++) {
    const proj = d.dot(obb.axes[i]);
    if (Math.abs(proj) > obb.halfSize[i] + margin) return false;
  }
  return true;
}

export function runClash(sceneData, eqObjects, hiddenTags, tol = CLASH_TOL) {
  const status = sceneData.clashStatus ?? {};
  const out = [];
  const entries = [];
  for (const [tag, entry] of eqObjects) {
    if (hiddenTags?.has(tag)) continue;
    const box = new THREE.Box3().setFromObject(entry.group);   // 廣相位 AABB
    const obb = makeOBB(entry.group);                          // 窄相位 OBB
    entries.push({ tag, box, obb, def: entry.def });
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
      // 廣相位：AABB 無交集且間距超過門檻者直接排除
      const aabbGap = boxGap(A.box, B.box);
      if (aabbGap > 0) {
        const thresh = Math.max(tol.gap, tol.clearance);
        if (aabbGap > thresh) continue;   // 明顯不相交
      }
      // 窄相位：SAT
      const { pen, gap } = obbSAT(A.obb, B.obb);
      const cls = classify(Math.max(pen, 0), gap, tol);
      if (cls) {
        push({ type: cls, a: A.tag, b: B.tag, code: obstCode(A.def) + obstCode(B.def),
               point: A.obb.center.clone().lerp(B.obb.center, 0.5) });
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
      // 廣相位：膨脹 AABB 快速排除整條管
      const boxGrown = E.box.clone().expandByScalar(pipe.r + 0.05);
      let hit = null;
      for (let s = 0; s < pts.length - 1 && !hit; s++) {
        for (let k = 0; k <= 8; k++) {
          v.lerpVectors(pts[s], pts[s + 1], k / 8);
          if (!boxGrown.containsPoint(v)) continue;   // 廣相位未過不進窄相位
          // 窄相位：點轉 OBB 本地座標，以管半徑為容差比 half-size
          if (pointInOBB(v, E.obb, pipe.r + 0.05)) { hit = v.clone(); break; }
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
