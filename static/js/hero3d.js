// 首頁主視覺：程序化 3D 廠區（PBR 材質、黑底電影感打光、慢速環繞）
// 只依賴 three（CDN import map 由頁面提供）。
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// 標註（虛線框＋標籤）：以世界座標包圍盒定義，每幀投影到螢幕
const ANNOTATIONS = [
  { id: 'tanks',   tag: 'T-201 / T-202', min: [3.0, 0.15, -5.45],  max: [12.6, 5.75, -0.95] },
  { id: 'column',  tag: 'C-301',         min: [-4.6, 0.0, -4.9],   max: [-2.2, 11.4, -2.3] },
  { id: 'reactor', tag: 'R-101',         min: [-0.9, 0.0, 1.2],    max: [2.1, 5.1, 4.0] },
  { id: 'drum',    tag: 'V-101',         min: [-11.3, 0.15, 0.35], max: [-5.1, 3.6, 2.45] },
  { id: 'furnace', tag: 'F-101',         min: [-3.4, 0.0, 5.85],   max: [0.2, 3.5, 8.55] },
  { id: 'stack',   tag: 'STACK',         min: [-3.1, 3.4, 7.1],    max: [-2.1, 11.7, 8.1] },
  { id: 'pipes',   tag: 'PIPE RACK',     min: [4.0, 1.7, 3.6],     max: [12.4, 3.2, 5.0] },
];
const LABELS_ZH = { tanks: '儲槽', column: '精餾塔', reactor: '反應器', drum: '臥式儲槽', furnace: '加熱爐', stack: '煙囪', pipes: '製程管線・管架' };

export function mountHero(container, opts = {}) {
  const labels = Object.assign({}, LABELS_ZH, opts.labels || {});
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x000000, 0.011);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  // 看點偏左，讓廠區落在畫面右半（左半留給文案）；opts.targetX 越小廠區越靠右
  const target = new THREE.Vector3(opts.targetX ?? -4.5, 1.6, 1.0);

  // ---------- 材質 ----------
  const M = {
    steel: new THREE.MeshStandardMaterial({ color: 0xc2c7ce, metalness: 0.9, roughness: 0.28 }),
    paint: new THREE.MeshStandardMaterial({ color: 0xd9dde3, metalness: 0.25, roughness: 0.55 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: 0.7, roughness: 0.45 }),
    pipe: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.85, roughness: 0.35 }),
    pipeBlue: new THREE.MeshStandardMaterial({ color: 0x3b6fb8, metalness: 0.6, roughness: 0.4 }),
    rail: new THREE.MeshStandardMaterial({ color: 0xe0b23a, metalness: 0.3, roughness: 0.6 }),
    floor: new THREE.MeshStandardMaterial({ color: 0x0a0c0f, metalness: 0.2, roughness: 0.6 }),
    glow: new THREE.MeshBasicMaterial({ color: 0xff8a3d }),
  };

  // ---------- 工具 ----------
  const root = new THREE.Group(); scene.add(root);
  const add = (mesh, parent = root) => { mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh; };
  const cyl = (r, h, mat, seg = 48) => new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  const torus = (r, t, mat, seg = 64) => { const m = new THREE.Mesh(new THREE.TorusGeometry(r, t, 12, seg), mat); m.rotation.x = Math.PI / 2; return m; };
  const at = (mesh, x, y, z) => { mesh.position.set(x, y, z); return mesh; };

  // 管線：折點串接（直管＋球接頭）
  function pipe(points, r = 0.12, mat = M.pipe) {
    const g = new THREE.Group();
    for (let i = 0; i < points.length - 1; i++) {
      const a = new THREE.Vector3(...points[i]), b = new THREE.Vector3(...points[i + 1]);
      const len = a.distanceTo(b);
      const m = cyl(r, len, mat, 24);
      m.position.copy(a).lerp(b, 0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      add(m, g);
      if (i > 0) add(at(new THREE.Mesh(new THREE.SphereGeometry(r * 1.02, 20, 16), mat), a.x, a.y, a.z), g);
    }
    root.add(g); return g;
  }
  // 法蘭
  function flange(x, y, z, r = 0.2, axis = 'y') {
    const f = cyl(r, 0.06, M.steel, 32); if (axis === 'x') f.rotation.z = Math.PI / 2; if (axis === 'z') f.rotation.x = Math.PI / 2;
    return add(at(f, x, y, z));
  }
  // 頂欄杆（環＋立柱）
  function railing(x, y, z, r, posts = 12) {
    add(at(torus(r, 0.03, M.rail), x, y + 0.9, z));
    add(at(torus(r, 0.02, M.rail), x, y + 0.5, z));
    for (let i = 0; i < posts; i++) {
      const a = (i / posts) * Math.PI * 2;
      add(at(cyl(0.025, 0.95, M.rail, 8), x + Math.cos(a) * r, y + 0.47, z + Math.sin(a) * r));
    }
  }
  // 爬梯
  function ladder(x, y0, y1, z, rot = 0) {
    const g = new THREE.Group(); const h = y1 - y0;
    add(at(cyl(0.03, h, M.steel, 8), -0.18, h / 2, 0), g); add(at(cyl(0.03, h, M.steel, 8), 0.18, h / 2, 0), g);
    for (let y = 0.25; y < h; y += 0.3) { const s = cyl(0.02, 0.36, M.steel, 8); s.rotation.z = Math.PI / 2; add(at(s, 0, y, 0), g); }
    g.position.set(x, y0, z); g.rotation.y = rot; root.add(g);
  }
  // 平台環（塔身）
  function platform(x, y, z, r) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.62, r, 48), M.dark); ring.rotation.x = -Math.PI / 2; add(at(ring, x, y, z));
    railing(x, y, z, r - 0.05, 16);
  }

  // ---------- 地坪 ----------
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), M.floor); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const grid = new THREE.GridHelper(120, 120, 0x1c2026, 0x14171b); grid.position.y = 0.01; grid.material.transparent = true; grid.material.opacity = 0.7; scene.add(grid);
  // 混凝土基座
  const pad = add(at(box(30, 0.16, 22, new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.9 })), 0.5, 0.08, 0.5));

  // ---------- 儲槽 ×2 ----------
  for (const [tx, tz] of [[5.2, -3.2], [10.4, -3.2]]) {
    add(at(cyl(2.2, 4.6, M.paint), tx, 2.3 + 0.16, tz));
    add(at(cyl(2.28, 0.14, M.steel), tx, 4.6 + 0.16, tz));            // 頂緣
    add(at(cyl(2.28, 0.14, M.steel), tx, 0.25, tz));                    // 底緣
    add(at(cyl(2.24, 0.14, M.dark), tx, 2.5, tz));                      // 中帶
    railing(tx, 4.75, tz, 2.05, 20);
    ladder(tx - 2.28, 0.2, 4.7, tz + 0.2, Math.PI / 2);
    add(at(cyl(0.16, 0.5, M.steel), tx + 0.8, 4.95, tz + 0.6));         // 頂端接管
    add(at(cyl(0.35, 0.3, M.steel), tx, 4.98, tz));                     // 人孔
  }
  // 儲槽防溢堤
  add(at(box(9.4, 0.5, 4.8, M.dark), 7.8, 0.4, -3.2));
  add(at(box(9.0, 0.6, 4.4, new THREE.MeshStandardMaterial({ color: 0x0f1216, roughness: 0.95 })), 7.8, 0.35, -3.2));

  // ---------- 精餾塔 ----------
  const cx = -3.4, cz = -3.6;
  add(at(cyl(0.95, 9.4, M.paint), cx, 4.7 + 0.16, cz));
  add(at(new THREE.Mesh(new THREE.SphereGeometry(0.95, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), M.paint), cx, 9.86, cz));
  add(at(cyl(1.15, 0.6, M.dark), cx, 0.46, cz));                        // 裙座
  for (const y of [3.4, 6.2, 8.9]) platform(cx, y, cz, 1.7);
  ladder(cx + 1.0, 0.3, 9.2, cz + 0.4, -Math.PI / 2);
  add(at(cyl(0.16, 1.2, M.steel), cx, 10.6, cz));                       // 頂部接管
  flange(cx, 11.2, cz, 0.24);
  for (const y of [2.2, 4.8, 7.4]) { const n = cyl(0.13, 0.5, M.steel, 16); n.rotation.z = Math.PI / 2; add(at(n, cx + 1.1, y, cz)); flange(cx + 1.4, y, cz, 0.2, 'x'); }

  // ---------- 臥式槽 ----------
  const dx = -8.2, dz = 1.4;
  const drum = cyl(1.05, 4.2, M.paint); drum.rotation.z = Math.PI / 2; add(at(drum, dx, 1.75, dz));
  for (const s of [-1, 1]) { add(at(new THREE.Mesh(new THREE.SphereGeometry(1.05, 40, 24), M.paint), dx + s * 2.1, 1.75, dz)); add(at(box(0.5, 1.2, 2.2, M.dark), dx + s * 1.3, 0.75, dz)); }
  add(at(cyl(0.16, 0.9, M.steel), dx - 0.6, 3.1, dz)); flange(dx - 0.6, 3.5, dz, 0.24);
  add(at(cyl(0.16, 0.9, M.steel), dx + 0.9, 3.1, dz)); flange(dx + 0.9, 3.5, dz, 0.24);

  // ---------- 反應器（球槽＋四腳） ----------
  const rx = 0.6, rz = 2.6;
  add(at(new THREE.Mesh(new THREE.SphereGeometry(1.45, 48, 32), M.steel), rx, 3.0, rz));
  for (const [ax, az] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const leg = cyl(0.09, 2.6, M.dark, 12); leg.position.set(rx + ax * 0.9, 1.4, rz + az * 0.9); leg.rotation.set(az * 0.16, 0, -ax * 0.16); add(leg); }
  add(at(cyl(0.22, 0.7, M.steel), rx, 4.65, rz)); flange(rx, 5.0, rz, 0.3);
  add(at(cyl(0.7, 0.25, M.dark), rx, 4.5, rz));

  // ---------- 加熱爐＋煙囪 ----------
  const fx = -1.6, fz = 7.2;
  add(at(box(3.4, 3.0, 2.6, M.dark), fx, 1.66, fz));
  add(at(box(3.5, 0.18, 2.7, M.steel), fx, 3.24, fz));
  add(at(box(3.5, 0.18, 2.7, M.steel), fx, 0.24, fz));
  add(at(cyl(0.42, 8.5, M.paint), fx - 1.0, 3.3 + 4.25, fz + 0.4));
  add(at(cyl(0.48, 0.16, M.steel), fx - 1.0, 11.6, fz + 0.4));
  add(at(cyl(0.44, 0.16, M.steel), fx - 1.0, 5.6, fz + 0.4));
  // 觀火窗微光
  const win = at(new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.35), M.glow), fx + 1.71, 1.5, fz + 0.5); win.rotation.y = Math.PI / 2; root.add(win);
  const fireLight = new THREE.PointLight(0xff9a4a, 6, 6, 2); fireLight.position.set(fx + 2.2, 1.5, fz + 0.5); scene.add(fireLight);

  // ---------- 管架 ----------
  for (let x = -10; x <= 12; x += 3.5) {
    add(at(box(0.16, 2.6, 0.16, M.dark), x, 1.46, 4.9)); add(at(box(0.16, 2.6, 0.16, M.dark), x, 1.46, 3.7));
    add(at(box(0.16, 0.14, 1.36, M.dark), x, 2.0, 4.3)); add(at(box(0.16, 0.14, 1.36, M.dark), x, 2.72, 4.3));
  }
  for (const [y, z, r, m] of [[2.16, 4.05, 0.13, M.pipe], [2.16, 4.35, 0.10, M.pipe], [2.16, 4.6, 0.16, M.pipeBlue], [2.88, 4.1, 0.11, M.pipe], [2.88, 4.45, 0.13, M.pipe]]) {
    const p = cyl(r, 24, m, 24); p.rotation.z = Math.PI / 2; add(at(p, 1, y, z));
  }

  // ---------- 連接管線 ----------
  pipe([[cx + 1.4, 4.8, cz], [cx + 2.6, 4.8, cz], [cx + 2.6, 2.16, cz], [cx + 2.6, 2.16, 4.05]], 0.13);
  pipe([[cx + 1.4, 2.2, cz], [-1.0, 2.2, cz], [-1.0, 2.2, 0.2], [rx, 2.2, 0.2], [rx, 1.6, rz - 1.4]], 0.11);
  pipe([[dx + 0.9, 3.5, dz], [dx + 0.9, 4.2, dz], [-4.6, 4.2, dz], [-4.6, 2.16, dz], [-4.6, 2.16, 4.05]], 0.12);
  pipe([[5.2 + 0.8, 5.2, -3.2 + 0.6], [5.2 + 0.8, 5.6, -3.2 + 0.6], [3.2, 5.6, -3.2 + 0.6], [3.2, 2.88, -3.2 + 0.6], [3.2, 2.88, 4.1]], 0.11);
  pipe([[10.4 + 0.8, 5.2, -3.2 + 0.6], [10.4 + 0.8, 5.9, -3.2 + 0.6], [12.6, 5.9, -3.2 + 0.6], [12.6, 2.16, -3.2 + 0.6], [12.6, 2.16, 4.6]], 0.16, M.pipeBlue);
  pipe([[rx, 5.0, rz], [rx, 5.6, rz], [fx + 1.0, 5.6, rz], [fx + 1.0, 5.6, fz - 0.6], [fx + 1.0, 3.3, fz - 0.6]], 0.13);
  pipe([[fx - 2.4, 1.6, fz], [-5.5, 1.6, fz], [-5.5, 2.16, fz], [-5.5, 2.16, 4.6]], 0.16, M.pipeBlue);
  // 閥件
  for (const [vx, vy, vz] of [[-1.0, 2.2, -1.6], [3.2, 4.2, -2.6], [-4.6, 3.2, dz]]) {
    add(at(box(0.36, 0.36, 0.36, M.dark), vx, vy, vz)); add(at(cyl(0.05, 0.4, M.steel, 8), vx, vy + 0.35, vz)); add(at(torus(0.22, 0.03, M.rail, 32), vx, vy + 0.55, vz));
  }

  // ---------- 燈光 ----------
  scene.add(new THREE.HemisphereLight(0x9fbfff, 0x05070a, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(12, 20, 10); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 70 }); key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02; scene.add(key);
  const rim = new THREE.DirectionalLight(0x3b8bff, 1.6); rim.position.set(-16, 9, -12); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffe0c0, 0.35); fill.position.set(-6, 6, 16); scene.add(fill);

  // ---------- 標註層 ----------
  const anno = document.createElement('div'); anno.className = 'anno'; container.appendChild(anno);
  const annoEls = ANNOTATIONS.map((a) => {
    const bx = document.createElement('div'); bx.className = 'bx';
    const lb = document.createElement('div'); lb.className = 'lb';
    lb.innerHTML = `<b>${a.tag}</b>${labels[a.id] ?? ''}`;
    bx.appendChild(lb); anno.appendChild(bx);
    const min = new THREE.Vector3(...a.min), max = new THREE.Vector3(...a.max);
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
    return { bx, lb, corners };
  });
  const _v = new THREE.Vector3();
  function updateAnno() {
    const w = container.clientWidth, h = container.clientHeight;
    for (const { bx, lb, corners } of annoEls) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
      for (const c of corners) {
        _v.copy(c).project(camera);
        if (_v.z > 1) { behind = true; break; }
        const sx = (_v.x + 1) / 2 * w, sy = (1 - _v.y) / 2 * h;
        if (sx < x0) x0 = sx; if (sx > x1) x1 = sx; if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
      }
      const pad = 4;
      const vis = !behind && x1 > 0 && x0 < w && y1 > 0 && y0 < h && (x1 - x0) > 24;
      bx.style.display = vis ? '' : 'none';
      if (!vis) continue;
      bx.style.left = (x0 - pad) + 'px'; bx.style.top = (y0 - pad) + 'px';
      bx.style.width = (x1 - x0 + pad * 2) + 'px'; bx.style.height = (y1 - y0 + pad * 2) + 'px';
      // 標籤放框外左上；太靠上就改放框內
      lb.classList.toggle('inside', y0 - pad < 34);
    }
  }

  // ---------- 相機環繞 ----------
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let t0 = performance.now(); let visible = true;
  const R = 44, H = 15, A0 = 0.72;
  function place(t) {
    const a = A0 + (reduced ? 0 : t * 0.035);
    camera.position.set(target.x + Math.cos(a) * R, H + Math.sin(t * 0.25) * 0.25, target.z + Math.sin(a) * R);
    camera.lookAt(target);
  }
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    updateAnno();
  }
  new ResizeObserver(resize).observe(container); resize();
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 }).observe(container);
  function frame(now) {
    requestAnimationFrame(frame);
    if (!visible) return;
    place((now - t0) / 1000);
    renderer.render(scene, camera);
    updateAnno();
  }
  place(0); renderer.render(scene, camera); updateAnno();
  requestAnimationFrame(frame);
  return { renderer, scene, camera };
}
