// 3D 持久尺寸標註（對標 AVEVA E3D Draw Linear Dimension）
// 資料模型：sceneData.dims = [{ a:[x,y,z], b:[x,y,z] }]，座標恆為公尺 canonical。
// 顯示長度一律走 editor.js 傳入的 fmtLen（隨顯示單位 mm/cm/m 重繪）。
// 本模組零狀態、純函式：回傳一個 THREE.Group；切換單位或載入場景時由 editor.js 呼叫重建。

const DIM_COLOR = 0x2f6fd8;      // 標註線色（藍，與量測的橘做區隔）
const EXT_LEN = 0.35;            // 端點延伸線長度（公尺，固定；不隨單位縮放，純視覺）

// 取一條與 dir 垂直的參考向量：優先用世界 up，退化時（近垂直線）改用 X 軸。
function perp(THREE, dir) {
  const up = new THREE.Vector3(0, 1, 0);
  let n = new THREE.Vector3().crossVectors(dir, up);
  if (n.lengthSq() < 1e-6) n = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(1, 0, 0));
  return n.normalize();
}

/**
 * 建立所有持久尺寸標註的群組。
 * @param {object} sceneData  含 dims 陣列（公尺）
 * @param {typeof import('three')} THREE
 * @param {(m:number, withUnit?:boolean)=>string} fmtLen  editor.js 的長度格式化（隨單位）
 * @param {new (el:HTMLElement)=>any} CSS2DObjectCtor  editor.js 傳入的 CSS2DObject 建構子
 * @returns {THREE.Group} userData.isDimGroup=true；每筆標註的物件帶 userData.dimIndex
 */
export function buildDimensions(sceneData, THREE, fmtLen, CSS2DObjectCtor) {
  const group = new THREE.Group();
  group.userData.isDimGroup = true;
  const dims = sceneData.dims ?? [];
  const lineMat = new THREE.LineBasicMaterial({ color: DIM_COLOR });

  dims.forEach((dim, i) => {
    if (!dim?.a || !dim?.b) return;
    const a = new THREE.Vector3(dim.a[0], dim.a[1], dim.a[2]);
    const b = new THREE.Vector3(dim.b[0], dim.b[1], dim.b[2]);
    const dir = b.clone().sub(a);
    const dist = dir.length();
    if (dist < 1e-6) return;
    dir.normalize();
    const n = perp(THREE, dir);

    // 主尺寸線 a→b
    const main = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lineMat);
    main.userData.dimIndex = i;
    group.add(main);

    // 兩端垂直延伸線（延伸線＝尺寸界線；讓標註端點清楚定位）
    for (const p of [a, b]) {
      const e1 = p.clone().add(n.clone().multiplyScalar(EXT_LEN * 0.5));
      const e2 = p.clone().add(n.clone().multiplyScalar(-EXT_LEN * 0.5));
      const ext = new THREE.Line(new THREE.BufferGeometry().setFromPoints([e1, e2]), lineMat);
      ext.userData.dimIndex = i;
      group.add(ext);
      // 端點小球，方便右鍵點選刪除
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 6),
        new THREE.MeshBasicMaterial({ color: DIM_COLOR }));
      dot.position.copy(p);
      dot.userData.dimIndex = i;
      group.add(dot);
    }

    // 中點文字標籤（fmtLen 隨單位）
    const el = document.createElement('div');
    el.className = 'dim-note';
    el.textContent = fmtLen(dist);
    const label = new CSS2DObjectCtor(el);
    label.position.copy(a.clone().lerp(b, 0.5).add(n.clone().multiplyScalar(EXT_LEN * 0.5)));
    label.userData.dimIndex = i;
    group.add(label);
  });

  return group;
}
