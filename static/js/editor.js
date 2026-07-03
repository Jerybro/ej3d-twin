// 3D 模塊編輯器 — 工業素材放置 / 變換 / 管線繪製 / 場景存檔
// 存檔格式 = plant.json schema（孿生檢視原生相容）
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { builders, markShadow, labelHeight, ASSET_CATALOG, std } from './plant-builders.js';

// ---------------------------------------------------------------- 基礎場景
const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e141b);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 300);
camera.position.set(16, 14, 18);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
viewport.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.maxPolarAngle = 1.5;

scene.add(new THREE.HemisphereLight(0xbdd2e2, 0x1a222b, 1.4));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
sun.position.set(18, 26, 10);
sun.castShadow = true;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 60),
  new THREE.MeshStandardMaterial({ color: 0x1c232b, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new THREE.GridHelper(80, 40, 0x2a3844, 0x1f2a33);
grid.position.y = 0.02;
scene.add(grid);

const transform = new TransformControls(camera, renderer.domElement);
transform.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });
scene.add(transform);

// ---------------------------------------------------------------- 場景資料
let sceneId = null;         // null = 未儲存
let sceneData = emptyScene('未命名場景');
const eqObjects = new Map();  // tag → { group, def, labelEl }
const pipeObjects = [];       // index 對齊 sceneData.pipes → { group }

function emptyScene(name) {
  return {
    plant: { id: 'NEW', name, units: [{ id: 'U-100', name: '主區', equipment: [] }] },
    pipes: [], instruments: {}, scan_models: [], props: [],
    scenarios: [{ id: 'normal', name: '正常運轉', kind: 'normal', desc: '' }],
  };
}

const allEquipment = () => sceneData.plant.units.flatMap((u) => u.equipment);

function nextTag(prefix) {
  let n = 101;
  const tags = new Set(allEquipment().map((e) => e.tag));
  while (tags.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

// ------------------------------------------------------------ 設備渲染
function buildEquipment(def) {
  const group = new THREE.Group();
  const body = builders[def.type](def.dims);
  markShadow(body);
  body.traverse((o) => { if (o.isMesh) { o.userData.eqTag = def.tag; } });
  group.add(body);
  group.position.set(...def.pos);
  group.rotation.y = def.rot_y ?? 0;

  const el = document.createElement('div');
  el.style.cssText = 'padding:2px 8px;border-radius:10px;background:rgba(12,20,28,.82);border:1px solid #2a3f5a;color:#46c2e0;font-size:11px;font-weight:700;white-space:nowrap;';
  el.textContent = def.tag;
  const label = new CSS2DObject(el);
  label.position.set(0, labelHeight(def), 0);
  group.add(label);

  scene.add(group);
  eqObjects.set(def.tag, { group, def, labelEl: el });
  return group;
}

function rebuildEquipment(def) {
  const entry = eqObjects.get(def.tag);
  if (!entry) return;
  const old = entry.group.children.find((c) => !c.isCSS2DObject);
  entry.group.remove(old);
  const body = builders[def.type](def.dims);
  markShadow(body);
  body.traverse((o) => { if (o.isMesh) o.userData.eqTag = def.tag; });
  entry.group.add(body);
  entry.group.children.find((c) => c.isCSS2DObject)?.position.set(0, labelHeight(def), 0);
}

// ------------------------------------------------------------ 管線渲染
const pipeMat = std(0x646f7b);
const pipeHi = std(0xffaa3c, { emissive: 0x442a00, emissiveIntensity: 0.6 });

function buildPipe(pipe, index) {
  const group = new THREE.Group();
  group.userData.pipeIndex = index;
  const pts = pipe.pts.map((p) => new THREE.Vector3(...p));
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) continue;
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(pipe.r, pipe.r, len, 12), pipeMat);
    cyl.position.copy(a).addScaledVector(dir, 0.5);
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    cyl.castShadow = true;
    cyl.userData.pipeIndex = index;
    group.add(cyl);
    const joint = new THREE.Mesh(new THREE.SphereGeometry(pipe.r * 1.3, 10, 8), pipeMat);
    joint.position.copy(b);
    joint.userData.pipeIndex = index;
    group.add(joint);
  }
  scene.add(group);
  pipeObjects[index] = { group };
}

function rebuildAllPipes() {
  for (const p of pipeObjects) if (p) scene.remove(p.group);
  pipeObjects.length = 0;
  sceneData.pipes.forEach((pipe, i) => buildPipe(pipe, i));
}

// ------------------------------------------------------------ 載入場景
function loadSceneData(data, id) {
  transform.detach();
  for (const { group } of eqObjects.values()) scene.remove(group);
  eqObjects.clear();
  for (const p of pipeObjects) if (p) scene.remove(p.group);
  pipeObjects.length = 0;

  sceneData = data;
  sceneId = id;
  for (const eq of allEquipment()) buildEquipment(eq);
  sceneData.pipes.forEach((pipe, i) => buildPipe(pipe, i));
  updateTopbar();
  selectNone();
}

function updateTopbar() {
  document.getElementById('scene-name').textContent =
    sceneId ? `${sceneData.plant.name}（${sceneId}）` : `${sceneData.plant.name}（未儲存）`;
  const viewBtn = document.getElementById('btn-view');
  if (sceneId) {
    viewBtn.style.display = '';
    viewBtn.href = `/twin?scene=${sceneId}`;
  } else viewBtn.style.display = 'none';
}

// ------------------------------------------------------------ 模式與選取
let mode = 'idle'; // idle | placing | pipe
let placingAsset = null;  // ASSET_CATALOG 項
let ghost = null;
let selected = null;      // { kind: 'eq', def } | { kind: 'pipe', index }
let pipeDraft = [];       // Vector3[]
let pipePreview = null;

const modeHint = document.getElementById('mode-hint');
function setHint(html) { modeHint.innerHTML = html; }

function setMode(m) {
  mode = m;
  document.querySelectorAll('.asset-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById('pipe-btn').classList.remove('active');
  if (ghost) { scene.remove(ghost); ghost = null; }
  clearPipeDraft();
  if (m === 'idle') setHint('點選素材開始，或點擊場景中的設備編輯');
}

function clearPipeDraft() {
  pipeDraft = [];
  if (pipePreview) { scene.remove(pipePreview); pipePreview = null; }
}

function selectNone() {
  selected = null;
  transform.detach();
  document.getElementById('prop-panel').classList.remove('show');
  for (const p of pipeObjects) if (p) p.group.traverse((o) => { if (o.isMesh) o.material = pipeMat; });
}

function selectEquipment(tag) {
  selectNone();
  const entry = eqObjects.get(tag);
  if (!entry) return;
  selected = { kind: 'eq', def: entry.def };
  transform.attach(entry.group);
  transform.setMode('translate');
  renderPropPanel(entry.def);
}

function selectPipe(index) {
  selectNone();
  selected = { kind: 'pipe', index };
  const p = pipeObjects[index];
  if (p) p.group.traverse((o) => { if (o.isMesh) o.material = pipeHi; });
  const panel = document.getElementById('prop-panel');
  panel.classList.add('show');
  document.getElementById('prop-title').textContent = `管線 #${index + 1}`;
  document.getElementById('prop-rows').innerHTML =
    `<div class="prop-row"><label>節點數</label><span>${sceneData.pipes[index].pts.length}</span></div>
     <div class="prop-row"><label>管徑 r</label><span>${sceneData.pipes[index].r} m</span></div>`;
}

// ------------------------------------------------------------ 屬性面板
function renderPropPanel(def) {
  const panel = document.getElementById('prop-panel');
  panel.classList.add('show');
  document.getElementById('prop-title').textContent = `${def.tag}｜${def.name}`;
  const rows = [];
  rows.push(`<div class="prop-row"><label>Tag</label><input data-k="tag" value="${def.tag}"></div>`);
  rows.push(`<div class="prop-row"><label>名稱</label><input data-k="name" value="${def.name}"></div>`);
  for (const [k, v] of Object.entries(def.dims)) {
    rows.push(`<div class="prop-row"><label>尺寸 ${k}</label><input data-k="dims.${k}" type="number" step="0.1" value="${v}"></div>`);
  }
  document.getElementById('prop-rows').innerHTML = rows.join('');
  document.getElementById('prop-rows').querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      if (k === 'tag') {
        const nt = inp.value.trim();
        if (!nt || (eqObjects.has(nt) && nt !== def.tag)) { inp.value = def.tag; return; }
        const entry = eqObjects.get(def.tag);
        eqObjects.delete(def.tag);
        def.tag = nt;
        eqObjects.set(nt, entry);
        entry.labelEl.textContent = nt;
        entry.group.traverse((o) => { if (o.isMesh) o.userData.eqTag = nt; });
      } else if (k === 'name') {
        def.name = inp.value;
      } else if (k.startsWith('dims.')) {
        def.dims[k.slice(5)] = +inp.value;
        rebuildEquipment(def);
      }
      document.getElementById('prop-title').textContent = `${def.tag}｜${def.name}`;
    });
  });
}

// ------------------------------------------------------------ 素材面板
const grid2 = document.getElementById('asset-grid');
for (const asset of ASSET_CATALOG) {
  const btn = document.createElement('button');
  btn.className = 'asset-btn';
  btn.textContent = asset.name;
  btn.addEventListener('click', () => {
    setMode('placing');
    placingAsset = asset;
    btn.classList.add('active');
    ghost = builders[asset.type](asset.dims);
    ghost.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.5;
      }
    });
    scene.add(ghost);
    setHint(`放置 <b>${asset.name}</b>：點擊地面確定位置，Esc 取消`);
  });
  grid2.appendChild(btn);
}

document.getElementById('pipe-btn').addEventListener('click', () => {
  if (mode === 'pipe') { setMode('idle'); return; }
  setMode('pipe');
  document.getElementById('pipe-btn').classList.add('active');
  selectNone();
  setHint('管線繪製：依序點擊路徑點（靠近設備自動吸附），<b>Enter</b> 完成、<b>Esc</b> 取消');
});

// ------------------------------------------------------------ 滑鼠互動
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function groundPoint(e) {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const pt = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, pt) ? pt : null;
}

function snapToEquipment(pt) {
  // 2m 內吸附最近設備的接管點（y=0.9）
  let best = null, bestD = 2;
  for (const { def } of eqObjects.values()) {
    const d = Math.hypot(def.pos[0] - pt.x, def.pos[2] - pt.z);
    if (d < bestD) { bestD = d; best = def; }
  }
  return best ? new THREE.Vector3(best.pos[0], 0.9, best.pos[2]) : new THREE.Vector3(pt.x, 0.9, pt.z);
}

renderer.domElement.addEventListener('pointermove', (e) => {
  if (mode === 'placing' && ghost) {
    const pt = groundPoint(e);
    if (pt) ghost.position.set(Math.round(pt.x * 2) / 2, 0, Math.round(pt.z * 2) / 2);
  } else if (mode === 'pipe' && pipeDraft.length) {
    const pt = groundPoint(e);
    if (pt) updatePipePreview(snapToEquipment(pt));
  }
});

let downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
  if (transform.dragging) return;

  if (mode === 'placing' && ghost && placingAsset) {
    const def = {
      tag: nextTag(placingAsset.prefix),
      name: placingAsset.name,
      type: placingAsset.type,
      pos: [ghost.position.x, 0, ghost.position.z],
      rot_y: 0,
      dims: JSON.parse(JSON.stringify(placingAsset.dims)),
      pid_ref: '', design: {}, instruments: [],
    };
    sceneData.plant.units[0].equipment.push(def);
    buildEquipment(def);
    setMode('idle');
    selectEquipment(def.tag);
    return;
  }

  if (mode === 'pipe') {
    const pt = groundPoint(e);
    if (pt) {
      pipeDraft.push(snapToEquipment(pt));
      updatePipePreview();
      setHint(`管線繪製：已 ${pipeDraft.length} 點，<b>Enter</b> 完成、<b>Esc</b> 取消`);
    }
    return;
  }

  // idle：raycast 選取設備或管線
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  for (const hit of raycaster.intersectObjects(scene.children, true)) {
    let o = hit.object;
    while (o && !o.userData?.eqTag && o.userData?.pipeIndex === undefined) o = o.parent;
    if (o?.userData?.eqTag) { selectEquipment(o.userData.eqTag); return; }
    if (o?.userData?.pipeIndex !== undefined) { selectPipe(o.userData.pipeIndex); return; }
  }
  selectNone();
});

function updatePipePreview(cursor) {
  if (pipePreview) scene.remove(pipePreview);
  const pts = cursor ? [...pipeDraft, cursor] : pipeDraft;
  if (pts.length < 1) return;
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  pipePreview = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0xffaa3c, dashSize: 0.5, gapSize: 0.3 }));
  pipePreview.computeLineDistances();
  scene.add(pipePreview);
}

// TransformControls 變換寫回 def
transform.addEventListener('mouseUp', () => {
  if (!selected || selected.kind !== 'eq') return;
  const def = selected.def;
  const g = eqObjects.get(def.tag).group;
  if (transform.mode === 'translate') {
    g.position.y = 0; // 鎖地面
    def.pos = [g.position.x, 0, g.position.z];
  } else if (transform.mode === 'rotate') {
    g.rotation.x = 0; g.rotation.z = 0; // 只允許水平旋轉
    def.rot_y = g.rotation.y;
  } else if (transform.mode === 'scale') {
    // uniform scale 燒進 dims 後歸一
    const s = (g.scale.x + g.scale.y + g.scale.z) / 3;
    for (const k of Object.keys(def.dims)) def.dims[k] = Math.round(def.dims[k] * s * 100) / 100;
    g.scale.set(1, 1, 1);
    rebuildEquipment(def);
    renderPropPanel(def);
  }
});

// ------------------------------------------------------------ 鍵盤
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { setMode('idle'); selectNone(); }
  else if (e.key === 'Enter' && mode === 'pipe' && pipeDraft.length >= 2) {
    sceneData.pipes.push({ r: 0.1, pts: pipeDraft.map((p) => [Math.round(p.x * 100) / 100, p.y, Math.round(p.z * 100) / 100]) });
    buildPipe(sceneData.pipes.at(-1), sceneData.pipes.length - 1);
    clearPipeDraft();
    setHint('管線已建立。繼續點擊繪製下一條，或 Esc 離開');
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  } else if (selected?.kind === 'eq') {
    if (e.key === 'w' || e.key === 'W') transform.setMode('translate');
    if (e.key === 'e' || e.key === 'E') transform.setMode('rotate');
    if (e.key === 'r' || e.key === 'R') transform.setMode('scale');
  }
});

document.getElementById('prop-delete').addEventListener('click', deleteSelected);

function deleteSelected() {
  if (!selected) return;
  if (selected.kind === 'eq') {
    const tag = selected.def.tag;
    const entry = eqObjects.get(tag);
    transform.detach();
    scene.remove(entry.group);
    eqObjects.delete(tag);
    for (const u of sceneData.plant.units) {
      u.equipment = u.equipment.filter((e) => e.tag !== tag);
    }
  } else if (selected.kind === 'pipe') {
    sceneData.pipes.splice(selected.index, 1);
    rebuildAllPipes();
  }
  selectNone();
}

// ------------------------------------------------------------ 存檔/開啟
async function saveScene(asNew = false) {
  let id = sceneId;
  if (asNew || !id) {
    id = prompt('場景 id（小寫英數、-、_）：', id ?? 'my-plant');
    if (!id) return;
    const name = prompt('場景名稱：', sceneData.plant.name);
    if (name) sceneData.plant.name = name;
    sceneData.plant.id = id.toUpperCase();
  }
  const res = await fetch(`/api/scenes/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sceneData),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`儲存失敗：${err.detail ?? res.status}`);
    return;
  }
  sceneId = id;
  updateTopbar();
  setHint(`已儲存 <b>${id}</b>`);
}

document.getElementById('btn-save').addEventListener('click', () => saveScene(false));
document.getElementById('btn-saveas').addEventListener('click', () => saveScene(true));
document.getElementById('btn-new').addEventListener('click', () => {
  if (!confirm('清空目前場景？（未儲存的變更會遺失）')) return;
  loadSceneData(emptyScene('未命名場景'), null);
});

const modal = document.getElementById('open-modal');
document.getElementById('btn-open').addEventListener('click', async () => {
  const scenes = await fetch('/api/scenes').then((r) => r.json());
  document.getElementById('scene-list').innerHTML = scenes.map((s) =>
    `<div class="scene-item" data-id="${s.id}"><span>${s.name}</span><span class="meta">${s.id}・${s.equipment} 設備・${s.pipes} 管線</span></div>`
  ).join('') || '<div class="meta" style="color:#8ba0b3;padding:8px">（無場景）</div>';
  modal.classList.add('show');
  document.querySelectorAll('.scene-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const data = await fetch(`/api/scenes/${el.dataset.id}`).then((r) => r.json());
      loadSceneData(data, el.dataset.id);
      modal.classList.remove('show');
    });
  });
});
document.getElementById('modal-close').addEventListener('click', () => modal.classList.remove('show'));

// URL ?scene= 直接開啟
const initId = new URLSearchParams(location.search).get('scene');
if (initId) {
  fetch(`/api/scenes/${initId}`).then((r) => { if (r.ok) return r.json(); throw 0; })
    .then((d) => loadSceneData(d, initId)).catch(() => {});
}
updateTopbar();

// ---------------------------------------------------------------- 主迴圈
function onResize() {
  if (!innerWidth || !innerHeight) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);
new ResizeObserver(onResize).observe(document.body);
onResize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate();
