// 3D 設計工作區 — 對標 AVEVA E3D Design 的操作與介面
// 佈局：Ribbon 功能區（首頁/設備/管線/檢視）＋模型瀏覽器（左）＋屬性格（右）
//      ＋狀態列（座標/選取/捕捉）＋視角三軸指示
// 場景 schema 與孿生檢視共用（plant.json），存檔走 /api/scenes
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { std, markShadow, builders, ASSET_CATEGORIES, labelHeight } from './plant-builders.js';

const viewport = document.getElementById('viewport');

// ---------------------------------------------------------------- 三維基礎
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e141b);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
camera.position.set(16, 14, 18);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
viewport.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
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
let grid = new THREE.GridHelper(80, 40, 0x2a3844, 0x1f2a33);
grid.position.y = 0.02;
scene.add(grid);

const transform = new TransformControls(camera, renderer.domElement);
transform.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (e.value) pushUndo(); // 變換開始前存快照
});
scene.add(transform);

// 圖紙底圖（P&ID 地毯）：載入場景時重建
const underlayMeshes = [];
const texLoader = new THREE.TextureLoader();
function rebuildUnderlays(list) {
  for (const m of underlayMeshes) {
    scene.remove(m);
    m.geometry.dispose();
    m.material.map?.dispose();
    m.material.dispose();
  }
  underlayMeshes.length = 0;
  for (const u of list ?? []) {
    const tex = texLoader.load(u.image);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(u.w, u.h),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.9,
        color: 0xb9c4cd, depthWrite: false,
      })
    );
    sheet.rotation.x = -Math.PI / 2;
    sheet.position.set(u.x, 0.04, u.z);
    sheet.visible = showUnderlay;
    underlayMeshes.push(sheet);
    scene.add(sheet);
  }
}

// 地坪自適應：場景範圍超出預設 80×60 時放大（P&ID 整廠合併場景會很大）
function fitGround(equipList, underlays) {
  let w = 80, d = 60;
  for (const eq of equipList) {
    w = Math.max(w, Math.abs(eq.pos[0]) * 2 + 20);
    d = Math.max(d, Math.abs(eq.pos[2]) * 2 + 20);
  }
  for (const u of underlays ?? []) {
    w = Math.max(w, (Math.abs(u.x) + u.w / 2) * 2 + 16);
    d = Math.max(d, (Math.abs(u.z) + u.h / 2) * 2 + 16);
  }
  w = Math.ceil(w / 20) * 20; d = Math.ceil(d / 20) * 20;
  if (ground.geometry.parameters.width === w && ground.geometry.parameters.height === d) return;
  ground.geometry.dispose();
  ground.geometry = new THREE.PlaneGeometry(w, d);
  scene.remove(grid);
  grid.geometry.dispose();
  grid = new THREE.GridHelper(Math.max(w, d), Math.max(w, d) / 2, 0x2a3844, 0x1f2a33);
  grid.position.y = 0.02;
  grid.visible = showGrid;
  scene.add(grid);
  camera.far = Math.max(300, Math.max(w, d) * 2.5);
  camera.updateProjectionMatrix();
  if (w > 80 || d > 60) {  // 大場景：把鏡頭拉到能看到全場的高度
    const span = Math.max(w, d);
    camera.position.set(span * 0.3, span * 0.35, span * 0.45);
    controls.target.set(0, 0, 0);
  }
}

// ---------------------------------------------------------------- 場景資料
let sceneId = null;         // null = 未儲存
let sceneData = emptyScene('未命名場景');

// ------------------------------------------------------------ Undo / Redo（20 步）
const UNDO_LIMIT = 20;
const undoStack = [];
const redoStack = [];

function pushUndo() {
  undoStack.push(JSON.stringify(sceneData));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(sceneData));
  loadSceneData(JSON.parse(undoStack.pop()), sceneId);
  updateUndoButtons();
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(sceneData));
  loadSceneData(JSON.parse(redoStack.pop()), sceneId);
  updateUndoButtons();
}

function updateUndoButtons() {
  document.getElementById('btn-undo').disabled = !undoStack.length;
  document.getElementById('btn-redo').disabled = !redoStack.length;
}

const eqObjects = new Map();  // tag → { group, def, labelEl }
const pipeObjects = [];       // index 對齊 sceneData.pipes → { group }
const hiddenTags = new Set(); // 模型樹「隱藏」的設備（UI 狀態，不入存檔）

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

  group.visible = !hiddenTags.has(def.tag);
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
  // P&ID 自動抽取場景管線量大：降面數/關陰影，維持可選取
  const lite = sceneData.pipes.length > 60;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) continue;
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(pipe.r, pipe.r, len, lite ? 6 : 12), pipeMat);
    cyl.position.copy(a).addScaledVector(dir, 0.5);
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    cyl.castShadow = !lite;
    cyl.userData.pipeIndex = index;
    group.add(cyl);
    if (!lite) {
      const joint = new THREE.Mesh(new THREE.SphereGeometry(pipe.r * 1.3, 10, 8), pipeMat);
      joint.position.copy(b);
      joint.userData.pipeIndex = index;
      group.add(joint);
    }
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
  clearNodeHandles();
  for (const { group } of eqObjects.values()) scene.remove(group);
  eqObjects.clear();
  for (const p of pipeObjects) if (p) scene.remove(p.group);
  pipeObjects.length = 0;

  sceneData = data;
  sceneId = id;
  for (const eq of allEquipment()) buildEquipment(eq);
  sceneData.pipes.forEach((pipe, i) => buildPipe(pipe, i));
  rebuildUnderlays(sceneData.underlays);
  fitGround([...allEquipment()], sceneData.underlays);
  updateTopbar();
  rebuildTree();
  selectNone();
}

function updateTopbar() {
  document.getElementById('scene-name').textContent =
    sceneId ? `${sceneData.plant.name}（${sceneId}）` : `${sceneData.plant.name}（未儲存）`;
  const viewBtn = document.getElementById('btn-view-twin');
  if (sceneId) {
    viewBtn.style.display = '';
    viewBtn.href = `/twin?scene=${sceneId}`;
  } else viewBtn.style.display = 'none';
  document.getElementById('st-count').textContent =
    `設備 ${allEquipment().length}｜管線 ${sceneData.pipes.length}`;
}

// ------------------------------------------------------------ 模式與選取
let mode = 'idle'; // idle | placing | pipe | measure | pipenode
let placingAsset = null;  // ASSET_CATALOG 項
let ghost = null;
let selected = null;      // { kind: 'eq', def } | { kind: 'pipe', index }
let pipeDraft = [];       // Vector3[]
let pipePreview = null;
let snapOn = true;

const modeHint = document.getElementById('mode-hint');
function setHint(html) {
  modeHint.innerHTML = html;
  document.getElementById('st-mode').textContent = modeHint.textContent;
}

function setMode(m) {
  mode = m;
  document.querySelectorAll('.asset-btn').forEach((b) => b.classList.remove('active'));
  document.getElementById('pipe-btn').classList.remove('active');
  document.getElementById('btn-measure').classList.remove('active');
  document.getElementById('pipe-node-btn').classList.remove('active');
  if (ghost) { scene.remove(ghost); ghost = null; }
  clearPipeDraft();
  clearMeasure();
  if (m !== 'pipenode') clearNodeHandles();
  if (m === 'idle') setHint('點選素材開始，或點擊場景中的設備編輯');
}

function clearPipeDraft() {
  pipeDraft = [];
  if (pipePreview) { scene.remove(pipePreview); pipePreview = null; }
}

function selectNone() {
  selected = null;
  transform.detach();
  clearNodeHandles();
  for (const p of pipeObjects) if (p) p.group.traverse((o) => { if (o.isMesh) o.material = pipeMat; });
  renderPropEmpty();
  syncTreeSelection();
  document.getElementById('st-sel').textContent = '選取：無';
}

function selectEquipment(tag, { attach = true } = {}) {
  selectNone();
  const entry = eqObjects.get(tag);
  if (!entry) return;
  selected = { kind: 'eq', def: entry.def };
  if (attach && !hiddenTags.has(tag)) {
    transform.attach(entry.group);
    setTransformMode(transform.mode ?? 'translate');
  }
  renderPropPanel(entry.def);
  syncTreeSelection();
  document.getElementById('st-sel').textContent = `選取：${entry.def.tag}（${entry.def.name}）`;
}

function selectPipe(index) {
  selectNone();
  selected = { kind: 'pipe', index };
  const p = pipeObjects[index];
  if (p) p.group.traverse((o) => { if (o.isMesh) o.material = pipeHi; });
  renderPipeProps(index);
  document.getElementById('st-sel').textContent = `選取：管線 #${index + 1}`;
  if (mode === 'pipenode') buildNodeHandles(index);
}

// ------------------------------------------------------------ 屬性格（E3D Attributes 式）
const propBody = document.getElementById('prop-body');

function renderPropEmpty() {
  document.getElementById('prop-title').textContent = '屬性';
  propBody.innerHTML = '<div id="prop-empty">未選取物件<br>點擊 3D 視圖或模型樹選取</div>';
}

function pgRow(label, inner) {
  return `<label>${label}</label><div class="pg-v">${inner}</div>`;
}

function renderPropPanel(def) {
  document.getElementById('prop-title').textContent = def.tag;
  const dimRows = Object.entries(def.dims).map(([k, v]) =>
    pgRow(`尺寸 ${k}`, `<input data-k="dims.${k}" type="number" step="0.1" value="${v}">`)).join('');
  const infoRows = [
    def.pid_ref ? pgRow('P&ID', `<span>${def.pid_ref}</span>`) : '',
    def.design?.['尺寸來源'] ? pgRow('尺寸來源', `<span>${def.design['尺寸來源']}</span>`) : '',
    def.instruments?.length ? pgRow('儀錶', `<span>${def.instruments.length} 點</span>`) : '',
  ].filter(Boolean).join('');
  propBody.innerHTML = `
    <div class="pg-section">識別</div>
    <div class="pg-grid">
      ${pgRow('位號 Tag', `<input data-k="tag" value="${def.tag}">`)}
      ${pgRow('名稱', `<input data-k="name" value="${def.name}">`)}
      ${pgRow('類型', `<span>${def.type}</span>`)}
    </div>
    <div class="pg-section">定位</div>
    <div class="pg-grid">
      ${pgRow('東座標 X', `<input data-k="pos.0" type="number" step="0.5" value="${def.pos[0]}">`)}
      ${pgRow('北座標 Z', `<input data-k="pos.2" type="number" step="0.5" value="${def.pos[2]}">`)}
      ${pgRow('旋轉（度）', `<input data-k="rot" type="number" step="5" value="${Math.round((def.rot_y ?? 0) * 180 / Math.PI)}">`)}
    </div>
    <div class="pg-section">尺寸</div>
    <div class="pg-grid">${dimRows}</div>
    ${infoRows ? `<div class="pg-section">資訊</div><div class="pg-grid">${infoRows}</div>` : ''}
    <button class="pbtn" id="prop-zoom">縮放至（F）</button>
    <button class="pbtn danger" id="prop-delete">刪除（Delete）</button>`;

  propBody.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      pushUndo();
      if (k === 'rot') {
        def.rot_y = (+inp.value) * Math.PI / 180;
        eqObjects.get(def.tag).group.rotation.y = def.rot_y;
      } else if (k === 'tag') {
        const nt = inp.value.trim();
        if (!nt || (eqObjects.has(nt) && nt !== def.tag)) { inp.value = def.tag; return; }
        const entry = eqObjects.get(def.tag);
        eqObjects.delete(def.tag);
        def.tag = nt;
        eqObjects.set(nt, entry);
        entry.labelEl.textContent = nt;
        entry.group.traverse((o) => { if (o.isMesh) o.userData.eqTag = nt; });
        rebuildTree();
      } else if (k === 'name') {
        def.name = inp.value;
        rebuildTree();
      } else if (k.startsWith('pos.')) {
        def.pos[+k.slice(4)] = +inp.value;
        eqObjects.get(def.tag).group.position.set(...def.pos);
      } else if (k.startsWith('dims.')) {
        def.dims[k.slice(5)] = +inp.value;
        rebuildEquipment(def);
      }
      document.getElementById('prop-title').textContent = def.tag;
      syncTreeSelection();
    });
  });
  document.getElementById('prop-zoom').addEventListener('click', () => zoomToSelection());
  document.getElementById('prop-delete').addEventListener('click', deleteSelected);
}

function renderPipeProps(index) {
  const pipe = sceneData.pipes[index];
  document.getElementById('prop-title').textContent = `管線 #${index + 1}`;
  propBody.innerHTML = `
    <div class="pg-section">管線</div>
    <div class="pg-grid">
      ${pgRow('管徑 r', `<input data-k="r" type="number" step="0.02" value="${pipe.r}">`)}
      ${pgRow('節點數', `<span>${pipe.pts.length}</span>`)}
      ${pipe.bridge ? pgRow('類別', '<span>跨圖橋接</span>') : ''}
    </div>
    <button class="pbtn" id="prop-nodes">節點編輯</button>
    <button class="pbtn danger" id="prop-delete">刪除（Delete）</button>`;
  propBody.querySelector('[data-k="r"]').addEventListener('change', (e) => {
    pushUndo();
    pipe.r = +e.target.value;
    rebuildAllPipes();
    selectPipe(index);
  });
  document.getElementById('prop-nodes').addEventListener('click', () => enterNodeMode(index));
  document.getElementById('prop-delete').addEventListener('click', deleteSelected);
}

// ------------------------------------------------------------ 模型瀏覽器（Model Explorer）
const treeRoot = document.getElementById('model-tree');
const TYPE_ICON = {
  reactor: '◆', fixedbed: '◆', pfr: '◆', column: '▮', packedcol: '▮',
  flash_v: '◍', flash_h: '◍', cyclone: '◍', hx: '═', kettle: '═', aircooler: '═',
  pump: '●', compressor: '●', recip: '●', blower: '●',
  tank: '⬢', bullet: '⬢', spheretank: '⬢',
};

function rebuildTree(filter = document.getElementById('tree-search').value.trim().toUpperCase()) {
  const frag = document.createDocumentFragment();
  for (const unit of sceneData.plant.units) {
    const eqs = unit.equipment.filter((e) =>
      !filter || e.tag.toUpperCase().includes(filter) || e.name.toUpperCase().includes(filter));
    if (!eqs.length && filter) continue;
    const det = document.createElement('details');
    det.className = 'mt-unit';
    det.open = Boolean(filter) || sceneData.plant.units.length <= 4;
    det.innerHTML = `<summary><span class="tw">▶</span>${unit.name}（${eqs.length}）</summary>`;
    for (const eq of eqs) {
      const row = document.createElement('div');
      row.className = 'mt-eq';
      row.dataset.tag = eq.tag;
      if (hiddenTags.has(eq.tag)) row.classList.add('hidden-eq');
      row.innerHTML = `<span class="mt-ico">${TYPE_ICON[eq.type] ?? '▪'}</span>
        <span class="mt-tag">${eq.tag}</span><span class="mt-name">${eq.name}</span>`;
      row.addEventListener('click', () => selectEquipment(eq.tag));
      row.addEventListener('dblclick', () => { selectEquipment(eq.tag); zoomToSelection(); });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selectEquipment(eq.tag);
        openCtxMenu(e.clientX, e.clientY, eqCtxItems(eq.tag));
      });
      det.appendChild(row);
    }
    frag.appendChild(det);
  }
  if (sceneData.pipes.length) {
    const det = document.createElement('details');
    det.className = 'mt-unit';
    det.innerHTML = `<summary><span class="tw">▶</span>管線（${sceneData.pipes.length}）</summary>`;
    const max = Math.min(sceneData.pipes.length, 200);
    for (let i = 0; i < max; i++) {
      const row = document.createElement('div');
      row.className = 'mt-eq';
      row.dataset.pipe = i;
      row.innerHTML = `<span class="mt-ico">╱</span><span class="mt-tag">#${i + 1}</span>
        <span class="mt-name">${sceneData.pipes[i].bridge ? '橋接' : `${sceneData.pipes[i].pts.length} 節點`}</span>`;
      row.addEventListener('click', () => selectPipe(i));
      det.appendChild(row);
    }
    if (sceneData.pipes.length > max) {
      const more = document.createElement('div');
      more.className = 'mt-eq';
      more.innerHTML = `<span class="mt-name">…共 ${sceneData.pipes.length} 條（僅列前 ${max}）</span>`;
      det.appendChild(more);
    }
    frag.appendChild(det);
  }
  treeRoot.replaceChildren(frag);
  syncTreeSelection();
}

function syncTreeSelection() {
  treeRoot.querySelectorAll('.mt-eq').forEach((el) => {
    el.classList.toggle('selected',
      (selected?.kind === 'eq' && el.dataset.tag === selected.def.tag) ||
      (selected?.kind === 'pipe' && el.dataset.pipe === String(selected.index)));
  });
}

document.getElementById('tree-search').addEventListener('input', () => rebuildTree());

// ------------------------------------------------------------ 右鍵情境選單
const ctxMenu = document.getElementById('ctx-menu');
function openCtxMenu(x, y, items) {
  ctxMenu.innerHTML = '';
  for (const it of items) {
    if (it === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.textContent = it.label;
    if (it.danger) btn.className = 'danger';
    btn.addEventListener('click', () => { closeCtxMenu(); it.run(); });
    ctxMenu.appendChild(btn);
  }
  ctxMenu.style.display = 'block';
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`;
  ctxMenu.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`;
}
function closeCtxMenu() { ctxMenu.style.display = 'none'; }
addEventListener('pointerdown', (e) => { if (!ctxMenu.contains(e.target)) closeCtxMenu(); });

function eqCtxItems(tag) {
  const hidden = hiddenTags.has(tag);
  return [
    { label: '縮放至此（F）', run: () => { selectEquipment(tag); zoomToSelection(); } },
    { label: hidden ? '顯示' : '隱藏', run: () => toggleHidden(tag) },
    'sep',
    { label: '刪除', danger: true, run: () => { selectEquipment(tag); deleteSelected(); } },
  ];
}

function toggleHidden(tag) {
  const entry = eqObjects.get(tag);
  if (!entry) return;
  if (hiddenTags.has(tag)) hiddenTags.delete(tag);
  else {
    hiddenTags.add(tag);
    if (selected?.kind === 'eq' && selected.def.tag === tag) transform.detach();
  }
  entry.group.visible = !hiddenTags.has(tag);
  rebuildTree();
}

// ------------------------------------------------------------ Ribbon：分頁切換
document.querySelectorAll('.rtab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.rtab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.rpage').forEach((p) =>
      p.classList.toggle('active', p.dataset.page === tab.dataset.tab));
  });
});

// 設備分頁：分類群組（E3D discipline gallery 式）
const equipRibbon = document.getElementById('equip-ribbon');
for (const cat of ASSET_CATEGORIES) {
  const g = document.createElement('div');
  g.className = 'rgroup';
  const tools = document.createElement('div');
  tools.className = 'rgroup-tools';
  for (const asset of cat.items) {
    const btn = document.createElement('button');
    btn.className = 'rbtn asset-btn';
    btn.textContent = asset.name;
    btn.title = `放置 ${asset.name}（點地面確定位置）`;
    btn.addEventListener('click', () => startPlacing(asset, btn));
    tools.appendChild(btn);
  }
  const lbl = document.createElement('div');
  lbl.className = 'rgroup-label';
  lbl.textContent = cat.name;
  g.append(tools, lbl);
  equipRibbon.appendChild(g);
}

function startPlacing(asset, btn) {
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

function setPointer(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}

function groundPoint(e) {
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const pt = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, pt) ? pt : null;
}

function snapVal(v) { return snapOn ? Math.round(v * 2) / 2 : Math.round(v * 100) / 100; }

function snapToEquipment(pt) {
  // 2m 內吸附最近設備的接管點（y=0.9）
  let best = null, bestD = 2;
  for (const { def } of eqObjects.values()) {
    const d = Math.hypot(def.pos[0] - pt.x, def.pos[2] - pt.z);
    if (d < bestD) { bestD = d; best = def; }
  }
  return best ? new THREE.Vector3(best.pos[0], 0.9, best.pos[2])
              : new THREE.Vector3(snapVal(pt.x), 0.9, snapVal(pt.z));
}

function pickObject(e) {
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  for (const hit of raycaster.intersectObjects(scene.children, true)) {
    let o = hit.object;
    while (o && !o.userData?.eqTag && o.userData?.pipeIndex === undefined
             && o.userData?.nodeIndex === undefined) o = o.parent;
    if (o?.userData?.eqTag && hiddenTags.has(o.userData.eqTag)) continue;
    if (o) return { obj: o, point: hit.point };
  }
  return null;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  const pt = groundPoint(e);
  if (pt) document.getElementById('st-coords').textContent =
    `X: ${pt.x.toFixed(1)}  Y: 0.0  Z: ${pt.z.toFixed(1)}`;
  if (mode === 'placing' && ghost) {
    if (pt) ghost.position.set(snapVal(pt.x), 0, snapVal(pt.z));
  } else if (mode === 'pipe' && pipeDraft.length) {
    if (pt) updatePipePreview(snapToEquipment(pt));
  } else if (mode === 'measure' && measurePts.length === 1) {
    updateMeasure(e);
  }
});

let downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
  if (transform.dragging) return;
  if (e.button === 2) return; // 右鍵交給 contextmenu

  if (mode === 'placing' && ghost && placingAsset) {
    pushUndo();
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
    rebuildTree();
    updateTopbar();
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

  if (mode === 'measure') {
    const hit = pickObject(e);
    const pt = hit ? hit.point : groundPoint(e);
    if (pt) addMeasurePoint(pt.clone());
    return;
  }

  // idle / pipenode：raycast 選取
  const hit = pickObject(e);
  if (hit) {
    const o = hit.obj;
    if (o.userData.nodeIndex !== undefined) { selectNodeHandle(o.userData.nodeIndex, o.userData.mid); return; }
    if (o.userData.eqTag) { if (mode !== 'pipenode') selectEquipment(o.userData.eqTag); return; }
    if (o.userData.pipeIndex !== undefined) { selectPipe(o.userData.pipeIndex); return; }
  }
  if (mode !== 'pipenode') selectNone();
});

// 右鍵情境選單（E3D 右鍵慣例）；右鍵拖曳=平移（OrbitControls），只有原地
// 右擊才開選單
renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (mode !== 'idle') return;
  if (downXY && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
  const hit = pickObject(e);
  if (hit?.obj.userData.eqTag) {
    selectEquipment(hit.obj.userData.eqTag);
    openCtxMenu(e.clientX, e.clientY, eqCtxItems(hit.obj.userData.eqTag));
  } else if (hit?.obj.userData.pipeIndex !== undefined) {
    const idx = hit.obj.userData.pipeIndex;
    selectPipe(idx);
    openCtxMenu(e.clientX, e.clientY, [
      { label: '節點編輯', run: () => enterNodeMode(idx) },
      'sep',
      { label: '刪除', danger: true, run: deleteSelected },
    ]);
  } else {
    openCtxMenu(e.clientX, e.clientY, [
      { label: '縮放至全場（Home）', run: fitAll },
      { label: '等角視', run: () => setViewPreset('iso') },
      { label: '俯視', run: () => setViewPreset('top') },
    ]);
  }
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
  if (nodeDrag) { commitNodeDrag(); return; }
  if (!selected || selected.kind !== 'eq') return;
  const def = selected.def;
  const g = eqObjects.get(def.tag).group;
  if (transform.mode === 'translate') {
    g.position.y = 0; // 鎖地面
    if (snapOn) g.position.set(snapVal(g.position.x), 0, snapVal(g.position.z));
    def.pos = [g.position.x, 0, g.position.z];
    renderPropPanel(def);
  } else if (transform.mode === 'rotate') {
    g.rotation.x = 0; g.rotation.z = 0; // 只允許水平旋轉
    def.rot_y = g.rotation.y;
    renderPropPanel(def); // 同步旋轉欄位
  } else if (transform.mode === 'scale') {
    // uniform scale 燒進 dims 後歸一
    const s = (g.scale.x + g.scale.y + g.scale.z) / 3;
    for (const k of Object.keys(def.dims)) def.dims[k] = Math.round(def.dims[k] * s * 100) / 100;
    g.scale.set(1, 1, 1);
    rebuildEquipment(def);
    renderPropPanel(def);
  }
});

// ------------------------------------------------------------ 管線節點編輯
let nodeHandles = [];   // Mesh（實心=節點、空心=段中點「插入」）
let nodeDrag = null;    // { index }
let nodeSelected = null;
const nodeMat = std(0xffaa3c, { emissive: 0x804f00, emissiveIntensity: 0.7 });
const nodeMidMat = std(0x46c2e0, { transparent: true, opacity: 0.55 });
const nodeSelMat = std(0xffffff, { emissive: 0x888888, emissiveIntensity: 0.8 });

function enterNodeMode(index) {
  setMode('pipenode');
  document.getElementById('pipe-node-btn').classList.add('active');
  // 切到管線分頁讓節點工具可見
  document.querySelector('.rtab[data-tab="pipe"]').click();
  selectPipe(index);
  setHint('節點編輯：點<b>橘色節點</b>拖曳移動、<b>青色中點</b>插入節點；選中節點按 Delete 刪除、Esc 離開');
}

function buildNodeHandles(index) {
  clearNodeHandles();
  const pipe = sceneData.pipes[index];
  const r = Math.max(pipe.r * 2.2, 0.28);
  pipe.pts.forEach((p, i) => {
    const h = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), nodeMat);
    h.position.set(...p);
    h.userData.nodeIndex = i;
    scene.add(h);
    nodeHandles.push(h);
  });
  for (let i = 0; i < pipe.pts.length - 1; i++) {
    const a = new THREE.Vector3(...pipe.pts[i]);
    const b = new THREE.Vector3(...pipe.pts[i + 1]);
    const m = new THREE.Mesh(new THREE.SphereGeometry(r * 0.65, 10, 8), nodeMidMat);
    m.position.copy(a).lerp(b, 0.5);
    m.userData.nodeIndex = i;
    m.userData.mid = true;
    scene.add(m);
    nodeHandles.push(m);
  }
}

function clearNodeHandles() {
  for (const h of nodeHandles) scene.remove(h);
  nodeHandles = [];
  nodeSelected = null;
  nodeDrag = null;
  if (transform.object && !transform.object.userData?.eqTag) transform.detach();
}

function selectNodeHandle(i, isMid) {
  if (selected?.kind !== 'pipe') return;
  const pipe = sceneData.pipes[selected.index];
  if (isMid) {
    // 中點插入新節點
    pushUndo();
    const a = pipe.pts[i], b = pipe.pts[i + 1];
    pipe.pts.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
    rebuildAllPipes();
    selectPipe(selected.index);
    return;
  }
  nodeSelected = i;
  const handle = nodeHandles.find((h) => !h.userData.mid && h.userData.nodeIndex === i);
  nodeHandles.forEach((h) => { if (!h.userData.mid) h.material = h === handle ? nodeSelMat : nodeMat; });
  transform.setMode('translate');
  transform.attach(handle);
  nodeDrag = { index: i };
}

function commitNodeDrag() {
  if (!nodeDrag || selected?.kind !== 'pipe') return;
  const pipe = sceneData.pipes[selected.index];
  const handle = transform.object;
  if (!handle) { nodeDrag = null; return; }
  const p = handle.position;
  pipe.pts[nodeDrag.index] = [snapVal(p.x), Math.max(0.1, Math.round(p.y * 100) / 100), snapVal(p.z)];
  rebuildAllPipes();
  const idx = selected.index;
  nodeDrag = null;
  selectPipe(idx);   // 重建 handles（mode 仍是 pipenode）
}

document.getElementById('pipe-node-btn').addEventListener('click', () => {
  if (mode === 'pipenode') { setMode('idle'); selectNone(); return; }
  if (selected?.kind === 'pipe') enterNodeMode(selected.index);
  else setHint('先選取一條管線，再按<b>節點編輯</b>');
});

// ------------------------------------------------------------ 量測工具（E3D Measure）
let measurePts = [];
let measureGroup = null;
const measureTip = document.getElementById('measure-tip');
let measureAnchor = null;  // Vector3 中點（畫面座標投影用）

document.getElementById('btn-measure').addEventListener('click', () => {
  if (mode === 'measure') { setMode('idle'); return; }
  setMode('measure');
  document.getElementById('btn-measure').classList.add('active');
  document.querySelector('.rtab[data-tab="view"]').click();
  setHint('量測：點擊<b>兩點</b>（設備表面或地面）顯示距離，Esc 結束');
});

function addMeasurePoint(pt) {
  measurePts.push(pt);
  if (!measureGroup) { measureGroup = new THREE.Group(); scene.add(measureGroup); }
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), nodeMat);
  dot.position.copy(pt);
  measureGroup.add(dot);
  if (measurePts.length === 2) {
    const [a, b] = measurePts;
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    measureGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffaa3c })));
    const d = a.distanceTo(b);
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y), dz = Math.abs(a.z - b.z);
    measureTip.textContent = `${d.toFixed(2)} m（ΔX ${dx.toFixed(2)}・ΔY ${dy.toFixed(2)}・ΔZ ${dz.toFixed(2)}）`;
    measureTip.style.display = 'block';
    measureAnchor = a.clone().lerp(b, 0.5);
    measurePts = [];   // 可連續量下一段
    setHint('量測完成。繼續點兩點量下一段，Esc 結束');
  }
}

function updateMeasure() { /* 預留拖曳預覽 */ }

function clearMeasure() {
  measurePts = [];
  measureAnchor = null;
  measureTip.style.display = 'none';
  if (measureGroup) { scene.remove(measureGroup); measureGroup = null; }
}

// ------------------------------------------------------------ 剖切（水平剖切面）
let clipOn = false;
const clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 10);
document.getElementById('btn-clip').addEventListener('click', () => {
  clipOn = !clipOn;
  document.getElementById('btn-clip').classList.toggle('active', clipOn);
  document.getElementById('clip-slider').style.display = clipOn ? '' : 'none';
  applyClip();
});
document.getElementById('clip-slider').addEventListener('input', applyClip);
function applyClip() {
  if (!clipOn) { renderer.clippingPlanes = []; return; }
  let maxY = 12;
  for (const { def } of eqObjects.values()) {
    maxY = Math.max(maxY, (def.dims.h ?? def.dims.len ?? 4) + 2);
  }
  clipPlane.constant = (document.getElementById('clip-slider').value / 100) * maxY;
  renderer.clippingPlanes = [clipPlane];
}

// ------------------------------------------------------------ 視角/縮放（View）
function sceneBounds() {
  const box = new THREE.Box3();
  let any = false;
  for (const { group, def } of eqObjects.values()) {
    if (hiddenTags.has(def.tag)) continue;
    box.expandByObject(group);
    any = true;
  }
  for (const m of underlayMeshes) { box.expandByObject(m); any = true; }
  if (!any) box.set(new THREE.Vector3(-20, 0, -15), new THREE.Vector3(20, 8, 15));
  return box;
}

function frameBox(box, dir) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.62 + 4;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360);
  camera.position.copy(center).addScaledVector(dir.clone().normalize(), dist);
  controls.target.copy(center);
  camera.far = Math.max(300, dist * 3);
  camera.updateProjectionMatrix();
}

function fitAll() { frameBox(sceneBounds(), camera.position.clone().sub(controls.target).normalize()); }

function zoomToSelection() {
  if (selected?.kind === 'eq') {
    const entry = eqObjects.get(selected.def.tag);
    frameBox(new THREE.Box3().expandByObject(entry.group),
      camera.position.clone().sub(controls.target).normalize());
  } else if (selected?.kind === 'pipe') {
    const box = new THREE.Box3();
    for (const p of sceneData.pipes[selected.index].pts) box.expandByPoint(new THREE.Vector3(...p));
    frameBox(box, camera.position.clone().sub(controls.target).normalize());
  } else fitAll();
}

const VIEW_DIRS = {
  iso: new THREE.Vector3(1, 0.9, 1), top: new THREE.Vector3(0.001, 1, 0.001),
  front: new THREE.Vector3(0, 0.12, 1), right: new THREE.Vector3(1, 0.12, 0),
};
function setViewPreset(k) { frameBox(sceneBounds(), VIEW_DIRS[k]); }
document.querySelectorAll('[data-vp]').forEach((b) =>
  b.addEventListener('click', () => setViewPreset(b.dataset.vp)));
document.getElementById('btn-fit').addEventListener('click', fitAll);
document.getElementById('btn-fit-sel').addEventListener('click', zoomToSelection);

// ------------------------------------------------------------ 顯示切換（底圖/網格/標籤）
let showUnderlay = true, showGrid = true, showLabels = true;
document.getElementById('btn-underlay').classList.add('active');
document.getElementById('btn-grid').classList.add('active');
document.getElementById('btn-labels').classList.add('active');
document.getElementById('btn-underlay').addEventListener('click', (e) => {
  showUnderlay = !showUnderlay;
  e.currentTarget.classList.toggle('active', showUnderlay);
  for (const m of underlayMeshes) m.visible = showUnderlay;
});
document.getElementById('btn-grid').addEventListener('click', (e) => {
  showGrid = !showGrid;
  e.currentTarget.classList.toggle('active', showGrid);
  grid.visible = showGrid;
});
document.getElementById('btn-labels').addEventListener('click', (e) => {
  showLabels = !showLabels;
  e.currentTarget.classList.toggle('active', showLabels);
  labelRenderer.domElement.style.display = showLabels ? '' : 'none';
});

// 捕捉切換
document.getElementById('st-snap').addEventListener('click', (e) => {
  snapOn = !snapOn;
  e.currentTarget.classList.toggle('on', snapOn);
});

// 面板收合
document.getElementById('tree-hide').addEventListener('click', () => { document.body.classList.add('tree-collapsed'); onResize(); });
document.getElementById('tree-reopen').addEventListener('click', () => { document.body.classList.remove('tree-collapsed'); onResize(); });
document.getElementById('prop-hide').addEventListener('click', () => { document.body.classList.add('prop-collapsed'); onResize(); });
document.getElementById('prop-reopen').addEventListener('click', () => { document.body.classList.remove('prop-collapsed'); onResize(); });

// ------------------------------------------------------------ 鍵盤
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') { setMode('idle'); selectNone(); }
  else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveScene(false);
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if (e.key === 'Enter' && mode === 'pipe' && pipeDraft.length >= 2) {
    pushUndo();
    const r = +document.getElementById('pipe-r').value || 0.12;
    sceneData.pipes.push({ r, pts: pipeDraft.map((p) => [Math.round(p.x * 100) / 100, p.y, Math.round(p.z * 100) / 100]) });
    buildPipe(sceneData.pipes.at(-1), sceneData.pipes.length - 1);
    clearPipeDraft();
    rebuildTree();
    updateTopbar();
    setHint('管線已建立。繼續點擊繪製下一條，或 Esc 離開');
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (mode === 'pipenode' && nodeSelected !== null && selected?.kind === 'pipe') {
      const pipe = sceneData.pipes[selected.index];
      if (pipe.pts.length > 2) {
        pushUndo();
        pipe.pts.splice(nodeSelected, 1);
        rebuildAllPipes();
        selectPipe(selected.index);
      }
      return;
    }
    deleteSelected();
  } else if (e.key === 'f' || e.key === 'F') {
    zoomToSelection();
  } else if (e.key === 'Home') {
    fitAll();
  } else if (selected?.kind === 'eq') {
    if (e.key === 'w' || e.key === 'W') setTransformMode('translate');
    if (e.key === 'e' || e.key === 'E') setTransformMode('rotate');
    if (e.key === 'r' || e.key === 'R') setTransformMode('scale');
  }
});

// 變換模式（快捷鍵與按鈕共用，同步按鈕 active 狀態）
function setTransformMode(m) {
  transform.setMode(m);
  document.querySelectorAll('.xf-btn').forEach((b) => b.classList.toggle('active', b.dataset.m === m));
}
document.querySelectorAll('.xf-btn').forEach((b) =>
  b.addEventListener('click', () => { if (selected?.kind === 'eq') setTransformMode(b.dataset.m); }));
document.getElementById('btn-undo').addEventListener('click', undo);
document.getElementById('btn-redo').addEventListener('click', redo);
document.getElementById('btn-del').addEventListener('click', deleteSelected);

function deleteSelected() {
  if (!selected) return;
  pushUndo();
  if (selected.kind === 'eq') {
    const tag = selected.def.tag;
    const entry = eqObjects.get(tag);
    transform.detach();
    scene.remove(entry.group);
    eqObjects.delete(tag);
    hiddenTags.delete(tag);
    for (const u of sceneData.plant.units) {
      u.equipment = u.equipment.filter((e) => e.tag !== tag);
    }
  } else if (selected.kind === 'pipe') {
    sceneData.pipes.splice(selected.index, 1);
    rebuildAllPipes();
  }
  rebuildTree();
  updateTopbar();
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
rebuildTree();
renderPropEmpty();

// ------------------------------------------------------------ 視角三軸指示（axis triad）
const triadCanvas = document.getElementById('axis-triad');
const triadRenderer = new THREE.WebGLRenderer({ canvas: triadCanvas, alpha: true, antialias: true });
triadRenderer.setSize(84, 84, false);
const triadScene = new THREE.Scene();
const triadCam = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 10);
triadCam.position.set(0, 0, 3);
{
  const mk = (dir, color) => {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6),
      new THREE.MeshBasicMaterial({ color }));
    shaft.position.y = 0.45;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.3, 8),
      new THREE.MeshBasicMaterial({ color }));
    head.position.y = 1.0;
    g.add(shaft, head);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    return g;
  };
  triadScene.add(mk(new THREE.Vector3(1, 0, 0), 0xe05555));   // X 東
  triadScene.add(mk(new THREE.Vector3(0, 1, 0), 0x4fc26e));   // Y 上
  triadScene.add(mk(new THREE.Vector3(0, 0, 1), 0x4f7ee0));   // Z 北
}

// ---------------------------------------------------------------- 主迴圈
function onResize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
}
addEventListener('resize', onResize);
new ResizeObserver(onResize).observe(viewport);
onResize();

const tmpQ = new THREE.Quaternion();
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  // 三軸指示同步相機方位
  camera.getWorldQuaternion(tmpQ);
  triadScene.quaternion.copy(tmpQ).invert();
  triadRenderer.render(triadScene, triadCam);
  // 量測標籤跟隨 3D 位置
  if (measureAnchor && measureTip.style.display !== 'none') {
    const v = measureAnchor.clone().project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    measureTip.style.left = `${((v.x + 1) / 2) * r.width - 40}px`;
    measureTip.style.top = `${((1 - v.y) / 2) * r.height - 30}px`;
  }
}
animate();

// console 除錯/自動化測試用
window.EJ3D_EDITOR = {
  get scene() { return sceneData; },
  get undoDepth() { return undoStack.length; },
  get redoDepth() { return redoStack.length; },
  get selected() { return selected; },
  selectEquipment, selectPipe, fitAll, setViewPreset,
};
