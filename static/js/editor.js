// 3D 設計工作區 — 對標 AVEVA E3D Design 的操作與介面
// 佈局：Ribbon 功能區（首頁/設備/管線/檢視）＋模型瀏覽器（左）＋屬性格（右）
//      ＋狀態列（座標/選取/捕捉）＋視角三軸指示
// 場景 schema 與孿生檢視共用（plant.json），存檔走 /api/scenes
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { std, markShadow, builders, ASSET_CATEGORIES, labelHeight,
         buildPrim, buildPipeComponent, PIPE_COMPONENTS,
         PIPE_SPECS, PIPE_SERVICES, PIPE_BORES, PIPE_SCHEDULES, pipeWall,
         STEEL_SECTIONS, steelSection } from './plant-builders.js';
import { initSprite } from './sprite.js';
import { runClash, clashKey } from './clash.js';
import { computeWeights } from './weight.js';
import { buildDimensions } from './dimensions.js';

// 結構鋼構定位線 Justification 選項（對標 E3D P-line）：柱常用 NA，梁常用 CTOP/TOS
const JUST_OPTIONS = [
  { v: 'NA', t: 'NA 中性軸（形心）' },
  { v: 'CTOP', t: 'CTOP 頂面中心' },
  { v: 'CBOT', t: 'CBOT 底面中心' },
  { v: 'TOS', t: 'TOS 頂面' },
  { v: 'BOS', t: 'BOS 底面' },
  { v: 'LEFT', t: 'LEFT 左翼板邊' },
  { v: 'RIGHT', t: 'RIGHT 右翼板邊' },
];

const viewport = document.getElementById('viewport');

// ---------------------------------------------------------------- 圖示系統
// 品味鐵則：零 emoji 裝飾——ribbon 圖示全部 24x24 stroke SVG（與首頁同語彙）
const ICONS = {
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  saveas: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 4H6a2 2 0 0 0-2 2v10"/>',
  open: '<path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-8l-2-3H5a2 2 0 0 0-2 2z"/>',
  new: '<path d="M12 5v14M5 12h14"/>',
  del: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>',
  move: '<path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  scale: '<path d="M21 3l-7 7M21 3h-6M21 3v6M3 21l7-7M3 21h6M3 21v-6"/>',
  fitsel: '<circle cx="12" cy="12" r="3"/><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/>',
  fitall: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  measure: '<path d="M2 15l13-13 7 7-13 13-7-7z"/><path d="M7 10l2 2M10 7l2 2M13 4l2 2"/>',
  angle: '<path d="M4 20L16 4"/><path d="M4 20h16"/><path d="M11.5 20a8 8 0 0 0-2.4-5.7"/>',
  tree: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  map: '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  label: '<path d="M12 3H5a2 2 0 0 0-2 2v7l9 9 9-9-9-9z"/><circle cx="8" cy="8" r="1.4"/>',
  pin: '<path d="M12 3a5 5 0 0 1 5 5c0 4-5 10-5 10S7 12 7 8a5 5 0 0 1 5-5z"/><circle cx="12" cy="8" r="1.6"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4V3z"/>',
  walk: '<circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2.5-6M14.5 21l-1.5-5-2-2 1-5"/><path d="M9 9l3-1.5 2.5 2 2.5 1"/>',
  clipbox: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h16" stroke-dasharray="3 2.4"/>',
  clipsel: '<rect x="7" y="7" width="13" height="13" rx="1.5"/><path d="M4 14V5a1 1 0 0 1 1-1h9"/>',
  clipsix: '<path d="M12 2l8 4.5v11L12 22l-8-4.5v-11L12 2z"/><path d="M4 6.5l8 4.5 8-4.5M12 11v11"/>',
  clear: '<path d="M5 5l14 14M19 5L5 19"/>',
  alert: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18v.5"/>',
  pipe: '<path d="M4 20V9a2 2 0 0 1 2-2h9"/><path d="M11 3l4 4-4 4"/><path d="M20 4v11a2 2 0 0 1-2 2h-2"/>',
  node: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  ga: '<rect x="3" y="3" width="18" height="18" rx="1.5"/><circle cx="9" cy="9" r="2.6"/><rect x="14" y="13" width="5" height="5"/><path d="M3 17h7M9 3v4"/>',
  iso: '<path d="M4 17l8-5 8 5M12 12V3"/><path d="M4 17v4h16v-4"/><path d="M8 5l4-2 4 2"/>',
  cap: '<path d="M12 2l8 4.5v11L12 22l-8-4.5v-11L12 2z"/><path d="M4 6.5l8 4.5 8-4.5" fill="rgba(4,106,251,.2)" stroke="none"/><path d="M4 6.5l8 4.5 8-4.5"/>',
  mto: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M9 4v16"/>',
  batch: '<rect x="3" y="3" width="9" height="9" rx="1"/><path d="M8 14v6h12V8h-6"/><path d="M6 6h3M6 8.5h3"/>',
  duct: '<rect x="3" y="8" width="18" height="8" rx="1"/><path d="M7 8V5M17 8V5"/>',
  laycube: '<path d="M12 3l7 4v10l-7 4-7-4V7l7-4z"/><path d="M12 11l7-4M12 11L5 7M12 11v10"/>',
  laypipe: '<path d="M4 6h7a7 7 0 0 1 7 7v5"/><path d="M4 11h7a2 2 0 0 1 2 2v5"/>',
  laybeam: '<path d="M6 4h12M6 20h12M12 4v16"/>',
  nozzle: '<path d="M3 12h7"/><path d="M10 7v10M14 7v10"/><path d="M14 12h7"/>',
  array: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  mirror: '<path d="M12 3v18"/><path d="M9 7L4 12l5 5"/><path d="M15 7l5 5-5 5"/>',
  support: '<path d="M7 9a5 5 0 0 1 10 0"/><path d="M12 9v9M7 18h10"/>',
  layelec: '<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>',
  elev: '<path d="M3 19h18M3 13h12M3 7h12"/><path d="M19 16V6M16 9l3-3 3 3"/>',
  layhvac: '<rect x="3" y="9" width="12" height="7" rx="1"/><path d="M15 10.5h6M15 14.5h6M7 9V5h8"/>',
};
document.querySelectorAll('.ric[data-ic]').forEach((el) => {
  const d = ICONS[el.dataset.ic];
  if (d) el.innerHTML = `<svg viewBox="0 0 24 24">${d}</svg>`;
});

// ---------------------------------------------------------------- 單位系統（對標 E3D）
// 鐵律：sceneData 內所有數值恆為「公尺」(canonical)。mm 只存在於兩個邊界——
//   顯示格式化（公尺 ×1000）與 輸入解析（mm ÷1000）。
//   undo 快照 / 存檔(/api/scenes) / USD 匯出 / plant.json / 孿生檢視 一律讀未轉換的公尺值。
const DISP_UNITS = {
  mm: { f: 1000, dp: 0, step: 1,     label: 'mm' },
  cm: { f: 100,  dp: 1, step: 0.1,   label: 'cm' },
  m:  { f: 1,    dp: 3, step: 0.001, label: 'm'  },
};
let dispUnit = localStorage.getItem('ej3d-disp-unit') || 'mm';
const U = () => DISP_UNITS[dispUnit] ?? DISP_UNITS.mm;
const roundMM = (m) => Math.round((m ?? 0) * 1000) / 1000;      // canonical 精度＝1mm，消浮點尾數
const toDisp = (m) => {                                          // 公尺 → 顯示單位數值（供 input value）
  const u = U();
  return u.f === 1000 ? Math.round((m ?? 0) * 1000) : +(roundMM(m) * u.f).toFixed(u.dp);
};
const fromDisp = (v) => roundMM((parseFloat(v) || 0) / U().f);  // 顯示單位數值 → 公尺
const fmtLen = (m, withUnit = true) => {                        // 格式化長度字串（顯示用；先收斂到 1mm 消幽靈小數）
  const u = U();
  const s = u.f === 1000 ? String(Math.round((m ?? 0) * 1000)) : (roundMM(m) * u.f).toFixed(u.dp);
  return withUnit ? `${s} ${u.label}` : s;
};
const unitLabel = () => U().label;
// 吸附網格（mm）——與顯示單位解耦，讓「可輸入精確 mm」為真（E3D 慣例：粗網格＋1mm 微調）
let snapStepMm = +localStorage.getItem('ej3d-snap-mm') || 25;
const SNAP_STEPS = [1, 5, 10, 25, 50, 100];
// 計數型 dims（非長度，不做 mm 轉換）
const COUNT_DIMS = new Set(['rows', 'bays']);
// 半徑型 dims：E3D 容器以「直徑」規格，面板顯示/輸入 ⌀＝r×2、寫回 ÷2（canonical 仍存半徑）
const DIA_DIMS = { r: '直徑 ⌀', r1: '底徑 ⌀', r2: '頂徑 ⌀' };

// ---------------------------------------------------------------- 三維基礎
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe6ebf1);  // E3D 淺色視圖

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
// E3D 滑鼠慣例：左鍵純選取、中鍵按住＝旋轉（F2/F3/F5 切縮放/平移/旋轉）、
// 右鍵拖＝平移、滾輪＝朝游標縮放
controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
controls.zoomToCursor = true;

const NAV_MODES = {
  rotate: { btn: THREE.MOUSE.ROTATE, label: 'MB2：旋轉' },
  zoom: { btn: THREE.MOUSE.DOLLY, label: 'MB2：縮放' },
  pan: { btn: THREE.MOUSE.PAN, label: 'MB2：平移' },
};
function setNavMode(k) {
  controls.mouseButtons.MIDDLE = NAV_MODES[k].btn;
  document.getElementById('st-nav').textContent = NAV_MODES[k].label;
}

scene.add(new THREE.HemisphereLight(0xffffff, 0x8d99a6, 1.25));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.4);
sun.position.set(18, 26, 10);
sun.castShadow = true;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 60),
  new THREE.MeshStandardMaterial({ color: 0xd9dfe6, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
let grid = new THREE.GridHelper(80, 40, 0xaeb9c6, 0xc8d1da);
grid.position.y = 0.02;
scene.add(grid);

const transform = new TransformControls(camera, renderer.domElement);
transform.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (e.value) pushUndo(); // 變換開始前存快照
});
scene.add(transform);
// E3D increment：拖曳中即吸附（mm 網格／15°），隨狀態列捕捉開關與網格粒度連動
function applySnapSettings() {
  transform.setTranslationSnap(snapOn ? snapStepMm / 1000 : null);
  transform.setRotationSnap(snapOn ? THREE.MathUtils.degToRad(15) : null);
}

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
  grid = new THREE.GridHelper(Math.max(w, d), Math.max(w, d) / 2, 0xaeb9c6, 0xc8d1da);
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
  for (const id of ['btn-undo', 'qat-undo']) document.getElementById(id).disabled = !undoStack.length;
  for (const id of ['btn-redo', 'qat-redo']) document.getElementById(id).disabled = !redoStack.length;
}

const eqObjects = new Map();  // tag → { group, def, labelEl }
const pipeObjects = [];       // index 對齊 sceneData.pipes → { group }
const hiddenTags = new Set(); // 模型樹「隱藏」的設備（UI 狀態，不入存檔）

// ---------------------------------------------------------------- 圖層顯示（設備/管線/結構）
const LAYERS = { equip: true, pipe: true, struct: true, elec: true, hvac: true };
const STRUCT_TYPES = new Set(['scolumn', 'sbeam', 'stairs', 'srail', 'splat', 'cageladder', 'psupport']);
const ELEC_TYPES = new Set(['cabletray', 'traybend', 'trayriser', 'jbox', 'lightpole']);
const HVAC_TYPES = new Set(['duct', 'ductbend', 'ductriser', 'ahu', 'rooffan']);
function eqLayerOn(def) {
  if (STRUCT_TYPES.has(def.type)) return LAYERS.struct;
  if (ELEC_TYPES.has(def.type)) return LAYERS.elec;
  if (HVAC_TYPES.has(def.type)) return LAYERS.hvac;
  return LAYERS.equip;
}
function applyLayers() {
  for (const entry of eqObjects.values()) {
    entry.group.visible = !hiddenTags.has(entry.def.tag) && eqLayerOn(entry.def);
  }
  pipeObjects.forEach((p, i) => {
    if (!p) return;
    const pipe = sceneData.pipes[i];
    const layerOn = pipe?.profile === 'duct' ? LAYERS.hvac : LAYERS.pipe;
    const svcKey = pipeServiceKey(pipe);   // 風管→null（不受服務篩選）；管線→service code 或 '__none__'
    p.group.visible = layerOn && !(svcKey && hiddenServices.has(svcKey));   // 服務圖例篩選：隱藏該服務別
  });
}

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
  const body = builders[def.type](def.dims, def);   // assembly 讀 def.prims
  markShadow(body);
  body.traverse((o) => { if (o.isMesh) { o.userData.eqTag = def.tag; } });
  group.add(body);
  renderNozzles(group, def);
  group.position.set(...def.pos);
  group.rotation.y = def.rot_y ?? 0;

  const el = document.createElement('div');
  el.style.cssText = 'padding:2px 8px;border-radius:10px;background:rgba(255,255,255,.92);border:1px solid #c6d0da;color:#046AFB;font-size:11px;font-weight:700;white-space:nowrap;';
  el.textContent = def.tag;
  const label = new CSS2DObject(el);
  label.position.set(0, labelHeight(def), 0);
  group.add(label);

  group.visible = !hiddenTags.has(def.tag) && eqLayerOn(def);
  scene.add(group);
  eqObjects.set(def.tag, { group, def, labelEl: el });
  return group;
}

function rebuildEquipment(def) {
  const entry = eqObjects.get(def.tag);
  if (!entry) return;
  // 移除 body＋管嘴群組全重繪（只換 body 會留下嘴殘影）
  for (const c of entry.group.children.filter((x) => !x.isCSS2DObject)) {
    c.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });   // 清巢狀管嘴標籤 DOM，防孤兒鬼標籤
    entry.group.remove(c);
  }
  const body = builders[def.type](def.dims, def);
  markShadow(body);
  body.traverse((o) => { if (o.isMesh) o.userData.eqTag = def.tag; });
  entry.group.add(body);
  renderNozzles(entry.group, def);
  entry.group.children.find((c) => c.isCSS2DObject)?.position.set(0, labelHeight(def), 0);
}

// ------------------------------------------------------------ 管線渲染
const pipeMat = std(0x646f7b);
const insulMat = new THREE.MeshStandardMaterial({ color: 0xcdd6df, transparent: true, opacity: 0.26, roughness: 1 });
const pipeHi = std(0xffaa3c, { emissive: 0x442a00, emissiveIntensity: 0.6 });

// 服務別著色：每個 service code 一個共用材質快取（避免每段 new）。無 service→回傳預設 pipeMat（維持現況灰）。
const SERVICE_BY_CODE = Object.fromEntries(PIPE_SERVICES.map((s) => [s.code, s]));
const serviceMats = new Map();
function serviceMat(code) {
  const svc = SERVICE_BY_CODE[code];
  if (!svc) return pipeMat;                                 // 無此服務別→沿用預設灰
  if (!serviceMats.has(code)) serviceMats.set(code, std(svc.color));
  return serviceMats.get(code);
}
// 管段「基底材質」（非選取狀態的還原目標）：風管用 ductMat；管線有 service 用服務色，否則 pipeMat。
function pipeBaseMat(pipe) {
  if (pipe?.profile === 'duct') return ductMat;
  return pipe?.service ? serviceMat(pipe.service) : pipeMat;
}
// UI 狀態：被圖例隱藏的服務別（不入存檔）。'__none__' 代表「無服務別」的管線群。
const hiddenServices = new Set();
const pipeServiceKey = (pipe) => (pipe?.profile === 'duct' ? null : (pipe?.service || '__none__'));

// 坡度：slope 存「‰（每公尺水平落差 mm）」canonical，預設 0（水平）。
// 落差只在渲染層套用——pts 仍為水平公尺 canonical，twin/USD 讀 pts 不受污染。
// dpts[i].y = pts[i].y − (slope/1000)×(至第 i 節點的水平弧長)。
const pipeSlopePermille = (pipe) => (pipe.profile === 'duct' ? 0 : (+pipe.slope || 0));
// 產生「已套坡度」的顯示節點陣列（不改 pipe.pts）；坡度 0 時回傳原始節點。
function slopedDisplayPts(pipe, pts) {
  const s = pipeSlopePermille(pipe);
  if (!s) return pts;
  const out = [];
  let hArc = 0;                                            // 累積水平弧長（XZ 平面）
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) hArc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    out.push(new THREE.Vector3(pts[i].x, pts[i].y - (s / 1000) * hArc, pts[i].z));
  }
  return out;
}

function buildPipe(pipe, index) {
  const group = new THREE.Group();
  group.userData.pipeIndex = index;
  const ptsRaw = pipe.pts.map((p) => new THREE.Vector3(...p));   // canonical 水平節點（勿改）
  if (pipe.profile === 'duct') { buildDuctBody(pipe, index, group, ptsRaw); scene.add(group); pipeObjects[index] = { group }; return; }
  // 坡度：僅渲染層下降 Y（pts 不變）。pts 供 arcToPose/報表使用仍是水平 canonical。
  const pts = slopedDisplayPts(pipe, ptsRaw);
  const slopePM = pipeSlopePermille(pipe);
  const baseMat = pipeBaseMat(pipe);   // 服務別著色：有 pipe.service 用服務色，否則沿用預設 pipeMat（現況灰）
  // P&ID 自動抽取場景管線量大：降面數/關陰影，維持可選取
  const lite = sceneData.pipes.length > 60;
  // 異徑管後段變徑：依元件弧長位置建立管徑分段表
  const reducers = (pipe.components ?? []).filter((c) => c.kind === 'reducer').sort((x, y) => x.at - y.at);
  const radiusAt = (arc) => {
    let r = pipe.r;
    for (const rd of reducers) if (arc > rd.at) r *= 0.62;
    return Math.max(r, 0.03);
  };
  let arcAcc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dir = b.clone().sub(a);
    const len = dir.length();
    const segR = radiusAt(arcAcc + len / 2);
    arcAcc += len;
    if (len < 1e-4) continue;
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(segR, segR, len, lite ? 6 : 12), baseMat);
    cyl.position.copy(a).addScaledVector(dir, 0.5);
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    cyl.castShadow = !lite;
    cyl.userData.pipeIndex = index;
    group.add(cyl);
    if (pipe.insul > 0) {   // 保溫外殼（半透明，含保溫外徑）
      const ins = new THREE.Mesh(new THREE.CylinderGeometry(segR + pipe.insul, segR + pipe.insul, len, lite ? 6 : 12), insulMat);
      ins.position.copy(cyl.position);
      ins.quaternion.copy(cyl.quaternion);
      ins.userData.pipeIndex = index;
      ins.userData.insul = true;
      group.add(ins);
    }
    if (!lite && i < pts.length - 2) {
      // 直角折點畫 quarter-torus 彎頭（E3D elbow 視覺），其餘畫球
      const u = pts[i].clone().sub(pts[i + 1]).normalize();      // 指向前一段
      const v = pts[i + 2].clone().sub(pts[i + 1]).normalize();  // 指向後一段
      const angle = u.angleTo(v) * 180 / Math.PI;
      let joint;
      if (angle > 82 && angle < 98) {
        const R = pipe.r * 1.8;
        joint = new THREE.Mesh(new THREE.TorusGeometry(R, pipe.r, 8, 10, Math.PI / 2), baseMat);
        const X = u.clone().negate(), Y = v.clone().negate();
        const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
        joint.setRotationFromMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
        joint.position.copy(pts[i + 1]).addScaledVector(u, R).addScaledVector(v, R);
      } else {
        joint = new THREE.Mesh(new THREE.SphereGeometry(pipe.r * 1.3, 10, 8), baseMat);
        joint.position.copy(pts[i + 1]);
      }
      joint.userData.pipeIndex = index;
      group.add(joint);
    }
  }
  // 管中元件（閥/法蘭對/異徑管/止回閥）：沿弧長定位、對齊管向
  for (const c of pipe.components ?? []) {
    const pose = arcToPose(pipe, c.at);
    if (!pose) continue;
    const comp = buildPipeComponent(c.kind, radiusAt(c.at - 0.01));
    comp.position.copy(pose.pos);
    if (slopePM) comp.position.y -= (slopePM / 1000) * horizArcTo(ptsRaw, c.at);   // 坡度：元件跟著渲染層下降
    comp.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), pose.dir);
    comp.traverse((o) => { o.userData.pipeIndex = index; });
    group.add(comp);
  }
  // 坡度標註：於管頭放小箭頭＋‰ 標籤（僅坡度非 0 時），純視覺、可跟隨 layer 隱藏
  if (slopePM && pts.length >= 2) addSlopeMarker(group, pipe, pts, slopePM, index);
  scene.add(group);
  pipeObjects[index] = { group };
}

// 至弧長 at（沿 pts 3D 弧長）對應的「水平弧長」（XZ 平面），供坡度落差計算。
// 坡度落差以水平長度為基準；3D 弧長與水平弧長在水平管段相等，故直接沿段累積水平投影。
function horizArcTo(pts, at) {
  let arc = 0, hArc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const seg = pts[i + 1].distanceTo(pts[i]);
    const hSeg = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    if (arc + seg >= at) {                                   // at 落在本段：線性插值水平弧長
      const t = seg > 1e-9 ? (at - arc) / seg : 0;
      return hArc + hSeg * Math.max(0, Math.min(1, t));
    }
    arc += seg; hArc += hSeg;
  }
  return hArc;
}

// 管頭坡度標記：一個朝下坡方向的小箭頭 + 顯示 ‰ 與 1:N 的 CSS2D 標籤。
function addSlopeMarker(group, pipe, dpts, slopePM, index) {
  const a = dpts[0], b = dpts[1];
  const seg = b.clone().sub(a);
  const r = Math.max(pipe.r ?? 0.05, 0.05);
  // 小箭頭：沿第一段走向，長度約 6×半徑（有上限），顏色橙色標示流向/下坡
  const arrowLen = Math.min(Math.max(r * 6, 0.3), seg.length() || 0.3);
  const arrow = new THREE.ArrowHelper(seg.clone().normalize(), a.clone(), arrowLen, 0xff8a1e, arrowLen * 0.4, r * 1.6);
  arrow.traverse((o) => { o.userData.pipeIndex = index; o.userData.slopeMarker = true; });   // 標記：選取上/下色不改坡度箭頭材質
  group.add(arrow);
  const el = document.createElement('div');
  el.className = 'pipe-slope-label';
  el.style.cssText = 'padding:1px 6px;border-radius:4px;background:rgba(255,138,30,.92);color:#fff;font-size:10px;font-weight:700;white-space:nowrap;pointer-events:none;';
  el.textContent = slopeLabelText(slopePM);
  const lbl = new CSS2DObject(el);
  lbl.position.copy(a).add(new THREE.Vector3(0, r * 2.2 + 0.15, 0));
  lbl.userData.pipeIndex = index;
  group.add(lbl);
}

// 坡度字串：以 ‰ 與 1:N 併陳（N=1000/‰，四捨五入）。下坡以負號/DN 語意保留數值原樣。
function slopeLabelText(slopePM) {
  const abs = Math.abs(slopePM);
  const ratio = abs > 1e-6 ? `1:${Math.round(1000 / abs)}` : '—';
  return `坡度 ${slopePM}‰（${ratio}）`;
}

// ------------------------------------------------------------ 風管路由（profile:'duct' 復用管線子系統）
const ductMat = std(0xaeb6bf, { metalness: 0.5, roughness: 0.35 });
function buildDuctBody(pipe, index, group, pts) {
  const w = pipe.duct?.w ?? 0.8, h = pipe.duct?.h ?? 0.5;
  const shape = pipe.duct?.shape ?? 'rect';          // 'rect'（矩形）/'circ'（圓，直徑 w）/'oval'（橢圓 w×h）
  const d = pipe.duct?.d ?? w;                        // 圓形直徑（公尺）；沿用 w 作為預設避免舊資料破圖
  // 依斷面形狀建立一段直管幾何（本地座標：矩形沿 Z、圓/橢圓沿 Y 對齊流向）
  const buildSeg = (len) => {
    if (shape === 'circ') {                            // 圓：等徑圓柱
      const r = d / 2;
      return { mesh: new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 20), ductMat), axis: new THREE.Vector3(0, 1, 0) };
    }
    if (shape === 'oval') {                            // 橢圓：圓柱非等比縮放 X=w、Y=h
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, len, 20), ductMat);
      cyl.scale.set(w, 1, h);
      return { mesh: cyl, axis: new THREE.Vector3(0, 1, 0) };
    }
    return { mesh: new THREE.Mesh(new THREE.BoxGeometry(w, h, len), ductMat), axis: new THREE.Vector3(0, 0, 1) };
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dir = b.clone().sub(a), len = dir.length();
    if (len < 1e-4) continue;
    const { mesh: seg, axis } = buildSeg(len);
    seg.position.copy(a).addScaledVector(dir, 0.5);
    seg.quaternion.setFromUnitVectors(axis, dir.clone().normalize());
    seg.castShadow = true;
    seg.userData.pipeIndex = index;
    group.add(seg);
    if (i < pts.length - 2) {                          // 內角：彎頭（矩形→方盒；圓/橢圓→球）
      let el;
      if (shape === 'rect') {
        el = new THREE.Mesh(new THREE.BoxGeometry(w * 1.06, h * 1.06, Math.max(w, h) * 1.06), ductMat);
      } else {
        const r = shape === 'circ' ? d / 2 : Math.max(w, h) / 2;
        el = new THREE.Mesh(new THREE.SphereGeometry(r * 1.06, 14, 12), ductMat);
        if (shape === 'oval') el.scale.set(w / Math.max(w, h), 1, h / Math.max(w, h));
      }
      el.position.copy(pts[i + 1]);
      el.userData.pipeIndex = index;
      group.add(el);
    }
  }
  for (const c of pipe.components ?? []) {              // 三通/風門/漸縮 沿風管弧長定位
    const pose = arcToPose(pipe, c.at);
    if (!pose) continue;
    const comp = buildDuctFitting(c.kind, w, h, pipe.duct);
    comp.position.copy(pose.pos);
    comp.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), pose.dir);
    comp.traverse((o) => { o.userData.pipeIndex = index; });
    group.add(comp);
  }
}
// duct：風管元件幾何。本地 X 軸＝流向（放置時 setFromUnitVectors(1,0,0)→pose.dir）。
function buildDuctFitting(kind, w, h, duct) {
  const g = new THREE.Group();
  const shape = duct?.shape ?? 'rect';
  const d = duct?.d ?? w;
  // 依斷面畫一片薄「端面套環」（本地 X 為流向厚度方向）
  const collarAt = (thick, scale = 1.12) => {
    if (shape === 'circ') {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(d / 2 * scale, d / 2 * scale, thick, 20), ductMat);
      c.rotation.z = Math.PI / 2;                       // 圓柱 Y 軸→轉到 X（流向）
      return c;
    }
    if (shape === 'oval') {
      // 單位圓柱（直徑1，軸沿本地 Y）先縮放再旋轉：Three 合成序為 T·R·S，故 scale 作用於旋轉前的本地軸。
      // 目標：世界 X(厚度)=thick、世界 Y(高)=h、世界 Z(寬)=w。旋轉 z=π/2 後 本地Y→世界X、本地X→世界Y、本地Z→世界Z。
      const c = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, thick, 20), ductMat);
      c.scale.set(h * scale, 1, w * scale);            // 本地X→高(世界Y)=h、本地Y→厚(世界X)=thick、本地Z→寬(世界Z)=w
      c.rotation.z = Math.PI / 2;
      return c;
    }
    return new THREE.Mesh(new THREE.BoxGeometry(thick, h * scale, w * scale), ductMat);
  };
  if (kind === 'tee') {
    const collar = collarAt(w * 0.36, 1.14);
    const neck = new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, h * 0.4, w * 0.5), ductMat);
    neck.position.y = h * 0.34;
    const branch = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, h * 0.7, w * 0.7), ductMat);
    branch.position.y = h * 0.68;
    g.add(collar, neck, branch);
  } else if (kind === 'damper') {
    const collar = collarAt(w * 0.22, 1.12);
    const flap = new THREE.Mesh(new THREE.BoxGeometry(0.02, h * 0.88, w * 0.88), std(0x3a4a5a));
    flap.rotation.x = 0.5;
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.26, 6), std(0x9aa4ad));
    handle.position.y = h * 0.62;
    g.add(collar, flap, handle);
  } else if (kind === 'transition') {
    // 漸縮：一段沿流向(X)的錐狀過渡，入口＝本管斷面、出口＝縮小約 0.6 倍
    const L = Math.max(w, h) * 0.9;                     // 過渡段長
    const half = L / 2;
    const t = 0.02;                                    // 端面薄板厚
    const inFace = collarAt(t, 1.0);  inFace.position.x = -half;
    const outFace = shape === 'rect'
      ? new THREE.Mesh(new THREE.BoxGeometry(t, h * 0.6, w * 0.6), ductMat)
      : shape === 'circ'
        ? (() => { const m = new THREE.Mesh(new THREE.CylinderGeometry(d / 2 * 0.6, d / 2 * 0.6, t, 20), ductMat); m.rotation.z = Math.PI / 2; return m; })()
        : (() => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, t, 20), ductMat); m.scale.set(h * 0.6, 1, w * 0.6); m.rotation.z = Math.PI / 2; return m; })();
    outFace.position.x = half;
    // 斜壁：用一段沿 X 的方錐（BoxGeometry 兩端不同尺寸以 4 片斜板近似不易，改用四稜台 Cylinder 近似）
    const rIn = (shape === 'circ' ? d / 2 : Math.max(w, h) / 2);
    const rOut = rIn * 0.6;
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(rOut, rIn, L, shape === 'rect' ? 4 : 20), ductMat);
    if (shape === 'oval') cone.scale.set(h / Math.max(w, h), 1, w / Math.max(w, h)); // 本地X→高、本地Y→長(保持)、本地Z→寬
    if (shape === 'rect') cone.rotation.y = Math.PI / 4; // 4-gon 錐頂點在 45°→繞自身軸轉正，使方形面對齊
    // 用外層 group 承接「軸→流向」旋轉，避免和上面的自轉在同一 Euler 疊加出錯
    const coneWrap = new THREE.Group();
    coneWrap.rotation.z = Math.PI / 2;                  // 錐 Y 軸→X（流向）
    coneWrap.add(cone);
    cone.userData.transCone = true;
    g.add(coneWrap, inFace, outFace);
  } else {
    g.add(collarAt(w * 0.3, 1.12));
  }
  return g;
}

function rebuildAllPipes() {
  for (const p of pipeObjects) if (p) {
    p.group.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });   // 清坡度標籤 DOM，防孤兒鬼標籤
    scene.remove(p.group);
  }
  pipeObjects.length = 0;
  sceneData.pipes.forEach((pipe, i) => buildPipe(pipe, i));
  applyLayers();
}

// ------------------------------------------------------------ 載入場景
function loadSceneData(data, id) {
  transform.detach();
  clearNodeHandles();
  // 移除群組前先清 CSS2D 標籤 DOM（設備/管嘴/坡度 ‰ 標籤掛在 overlay，scene.remove 不回收 → undo/redo 會殘留孤兒）
  for (const { group } of eqObjects.values()) { group.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); }); scene.remove(group); }
  eqObjects.clear();
  for (const p of pipeObjects) if (p) { p.group.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); }); scene.remove(p.group); }
  pipeObjects.length = 0;

  sceneData = data;
  sceneId = id;
  for (const eq of allEquipment()) buildEquipment(eq);
  sceneData.pipes.forEach((pipe, i) => buildPipe(pipe, i));
  rebuildUnderlays(sceneData.underlays);
  rebuildElevs();
  rebuildDims();
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
let mode = 'idle'; // idle | placing | pipe | measure | pipenode | nozzle
let placingAsset = null;  // ASSET_CATALOG 項
let ductDraw = false;     // 繪製模式：true=下一條管線為風管
let ductSize = [0.8, 0.5];
let ghost = null;
let selected = null;      // { kind: 'eq', def } | { kind: 'pipe', index }
let repaintPanel = null;  // 目前右側面板的重繪閉包（切換單位時即時刷新 value/step/單位標籤）
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
  document.getElementById('duct-btn').classList.remove('active');
  ductDraw = false;
  document.getElementById('btn-measure').classList.remove('active');
  document.getElementById('btn-measure-angle').classList.remove('active');
  document.getElementById('btn-dim3d').classList.remove('active');
  dimPts = [];
  document.getElementById('pipe-node-btn').classList.remove('active');
  document.getElementById('btn-nozzle').classList.remove('active');
  if (ghost) { scene.remove(ghost); ghost = null; }
  if (compGhost) { scene.remove(compGhost); compGhost = null; }
  pendingComp = null;
  clearPipeDraft();
  clearMeasure();
  alignSrcTag = null;
  if (m !== 'pipenode') clearNodeHandles();
  if (m === 'idle') setHint('點選素材開始，或點擊場景中的設備編輯');
}

function clearPipeDraft() {
  pipeDraft = [];
  if (pipePreview) { scene.remove(pipePreview); pipePreview = null; }
}

function selectNone() {
  selected = null;
  repaintPanel = null;
  transform.detach();
  clearNodeHandles();
  pipeObjects.forEach((p, i) => { if (!p) return; const m = pipeBaseMat(sceneData.pipes[i]); p.group.traverse((o) => { if (o.isMesh && !o.userData.insul && !o.userData.slopeMarker) o.material = m; }); });
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
  if (p) p.group.traverse((o) => { if (o.isMesh && !o.userData.insul && !o.userData.slopeMarker) o.material = pipeHi; });
  renderPipeProps(index);
  document.getElementById('st-sel').textContent = `選取：管線 #${index + 1}`;
  if (mode === 'pipenode') buildNodeHandles(index);
}

// ------------------------------------------------------------ 管嘴選取（點嘴選嘴，非母設備）
function selectNozzle(tag, nzId) {
  const entry = eqObjects.get(tag);
  if (!entry) return;
  const nz = (entry.def.nozzles ?? []).find((n) => n.id === nzId);
  if (!nz) { selectEquipment(tag); return; }
  selectNone();
  selected = { kind: 'nozzle', def: entry.def, nz };
  renderNozzleProps(entry.def, nz);
  document.getElementById('st-sel').textContent = `選取：${tag} / ${nz.id}（管嘴）`;
}
function renderNozzleProps(def, nz) {
  repaintPanel = () => renderNozzleProps(def, nz);
  document.getElementById('prop-title').textContent = `${def.tag} / ${nz.id}`;
  const opts = PIPE_BORES.map((b) => `<option value="${b.dn}" ${b.dn === nz.dn ? 'selected' : ''}>${b.dn}（⌀${Math.round(b.r * 2000)}mm）</option>`).join('');
  const NZ_DIRS = [['北 N', [0, 0, -1]], ['南 S', [0, 0, 1]], ['東 E', [1, 0, 0]], ['西 W', [-1, 0, 0]], ['上 U', [0, 1, 0]], ['下 D', [0, -1, 0]]];
  const curDir = JSON.stringify((nz.dir ?? [0, 0, 1]).map((v) => Math.round(v)));
  const known = NZ_DIRS.some(([, v]) => JSON.stringify(v) === curDir);
  const dirOpts = (known ? '' : `<option value="" selected disabled>（自訂 ${nz.dir.map((v) => (+v).toFixed(2)).join(',')}）</option>`)
    + NZ_DIRS.map(([name, v]) => `<option value='${JSON.stringify(v)}' ${JSON.stringify(v) === curDir ? 'selected' : ''}>${name}</option>`).join('');
  propBody.innerHTML = `
    <div class="pg-section">管嘴 Nozzle</div>
    <div class="pg-grid">
      ${pgRow('位號', `<span>${nz.id}</span>`)}
      ${pgRow('口徑 DN', `<select data-nz="dn">${opts}</select>`)}
      ${pgRow(`標高 U (${unitLabel()})`, `<input data-nz="u" type="number" step="${U().step}" value="${toDisp(nz.pos?.[1] ?? 0)}">`)}
      ${pgRow('方向 P-line', `<select data-nz="dir">${dirOpts}</select>`)}
      ${pgRow('母設備', `<span class="pg-owner" style="cursor:pointer">${def.tag}</span>`)}
    </div>
    <button class="pbtn" id="nz-selparent">選取母設備</button>
    <button class="pbtn danger" id="nz-del">刪除管嘴（Delete）</button>`;
  propBody.querySelector('[data-nz="dn"]').addEventListener('change', (e) => {
    pushUndo();
    nz.dn = e.target.value;
    rebuildEquipment(def);
    selectNozzle(def.tag, nz.id);
  });
  propBody.querySelector('[data-nz="u"]').addEventListener('change', (e) => {
    pushUndo();
    nz.pos = nz.pos ?? [0, 0, 0];
    nz.pos[1] = fromDisp(e.target.value);
    rebuildEquipment(def);
    selectNozzle(def.tag, nz.id);
  });
  propBody.querySelector('[data-nz="dir"]').addEventListener('change', (e) => {
    if (!e.target.value) return;
    pushUndo();
    nz.dir = JSON.parse(e.target.value);
    rebuildEquipment(def);
    selectNozzle(def.tag, nz.id);
  });
  const goParent = () => selectEquipment(def.tag);
  document.getElementById('nz-selparent').addEventListener('click', goParent);
  propBody.querySelector('.pg-owner').addEventListener('click', goParent);
  document.getElementById('nz-del').addEventListener('click', () => {
    pushUndo();
    def.nozzles = (def.nozzles ?? []).filter((n) => n.id !== nz.id);
    rebuildEquipment(def);
    rebuildTree(); updateTopbar();
    selectEquipment(def.tag);
    setHint(`已刪除管嘴 <b>${def.tag}/${nz.id}</b>`);
  });
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
  repaintPanel = () => renderPropPanel(def);
  document.getElementById('prop-title').textContent = def.tag;
  const owner = sceneData.plant.units.find((u) => u.equipment.includes(def));
  const dimRows = Object.entries(def.dims).map(([k, v]) => {
    if (COUNT_DIMS.has(k)) return pgRow(`${k}`, `<input data-k="dims.${k}" type="number" step="1" value="${v}">`);
    if (DIA_DIMS[k]) return pgRow(`${DIA_DIMS[k]} (${unitLabel()})`, `<input data-k="dims.${k}" type="number" step="${U().step}" value="${toDisp(v * 2)}">`);
    return pgRow(`尺寸 ${k} (${unitLabel()})`, `<input data-k="dims.${k}" type="number" step="${U().step}" value="${toDisp(v)}">`);
  }).join('');
  const infoRows = [
    def.pid_ref ? pgRow('P&ID', `<span>${def.pid_ref}</span>`) : '',
    def.design?.['尺寸來源'] ? pgRow('尺寸來源', `<span>${def.design['尺寸來源']}</span>`) : '',
    def.instruments?.length ? pgRow('儀錶', `<span>${def.instruments.length} 點</span>`) : '',
  ].filter(Boolean).join('');
  propBody.innerHTML = `
    <div class="pg-section">General</div>
    <div class="pg-grid">
      ${pgRow('Name', `<input data-k="tag" value="${def.tag}">`)}
      ${pgRow('Description', `<input data-k="name" value="${def.name}">`)}
      ${pgRow('Type', `<span>${def.type}</span>`)}
      ${pgRow('Owner', `<span class="pg-owner" style="cursor:pointer" title="點擊定位到模型樹">ZONE ${owner?.id ?? '—'}</span>`)}
    </div>
    <div class="pg-section">Positional</div>
    <div class="pg-grid">
      ${pgRow(`東 E (${unitLabel()})`, `<input data-k="pos.0" type="number" step="${U().step}" value="${toDisp(def.pos[0])}">`)}
      ${pgRow(`北 N (${unitLabel()})`, `<input data-k="pos.2" type="number" step="${U().step}" value="${toDisp(def.pos[2])}">`)}
      ${pgRow(`上 U (${unitLabel()})`, `<span>${toDisp(def.pos[1] ?? 0)}</span>`)}
      ${pgRow('旋轉（度）', `<input data-k="rot" type="number" step="5" value="${Math.round((def.rot_y ?? 0) * 180 / Math.PI)}">`)}
      ${pgRow('WRT', `<span>/WORL</span>`)}
    </div>
    ${dimRows ? `<div class="pg-section">Design Parameters</div><div class="pg-grid">${dimRows}</div>` : ''}
    ${['scolumn', 'sbeam'].includes(def.type) ? (() => {
      const s = steelSection(def.section);
      const jv = def.just ?? 'NA';
      return `<div class="pg-section">斷面 Section</div><div class="pg-grid">
        ${pgRow('型鋼', `<select data-k="section" style="width:100%">${STEEL_SECTIONS.map((x) =>
          `<option value="${x.code}" ${s.code === x.code ? 'selected' : ''}>${x.code}</option>`).join('')}</select>`)}
        ${pgRow('斷面 (mm)', `<span>D${s.depth}×B${s.flange}｜tw${s.web}／tf${s.tf}</span>`)}
        ${pgRow('定位線 Justification', `<select data-k="just" style="width:100%">${JUST_OPTIONS.map((o) =>
          `<option value="${o.v}" ${jv === o.v ? 'selected' : ''}>${o.t}</option>`).join('')}</select>`)}</div>`;
    })() : ''}
    ${def.nozzles?.length ? `<div class="pg-section">管嘴 Nozzles</div><div class="pg-grid">${def.nozzles.map((nz, i) =>
      pgRow(nz.id, `<select data-nzdn="${i}" class="rsel" style="width:86px">${PIPE_BORES.map((b) =>
        `<option ${b.dn === nz.dn ? 'selected' : ''}>${b.dn}</option>`).join('')}</select>
        <button data-nzdel="${i}" style="margin-left:6px;border:none;background:none;color:#d03050;cursor:pointer;font-size:11.5px;font-family:inherit">刪除</button>`)).join('')}</div>` : ''}
    ${def.type === 'piperack' ? `<div class="pg-section">儀電</div><button class="pbtn" id="prop-tray">沿此管架佈橋架</button><button class="pbtn" id="prop-tray-chain">串接共線管架佈線</button>` : ''}
    ${def.type === 'assembly' ? primsSection(def) : ''}
    ${infoRows ? `<div class="pg-section">Information</div><div class="pg-grid">${infoRows}</div>` : ''}
    <button class="pbtn" id="prop-zoom">縮放至（F）</button>
    <button class="pbtn danger" id="prop-delete">刪除（Delete）</button>`;
  if (def.type === 'assembly') wirePrims(def);
  propBody.querySelector('.pg-owner')?.addEventListener('click', () => {
    const det = treeRoot.querySelector(`details[data-zone="${owner?.id}"]`);
    if (det) { det.open = true; det.scrollIntoView({ block: 'nearest' }); }
  });

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
        def.pos[+k.slice(4)] = fromDisp(inp.value);
        eqObjects.get(def.tag).group.position.set(...def.pos);
      } else if (k.startsWith('dims.')) {
        const dk = k.slice(5);
        def.dims[dk] = COUNT_DIMS.has(dk) ? Math.max(1, Math.round(+inp.value))
          : DIA_DIMS[dk] ? Math.round(fromDisp(inp.value) / 2 * 10000) / 10000   // ⌀→半徑（保 0.1mm）
          : fromDisp(inp.value);
        rebuildEquipment(def);
      }
      document.getElementById('prop-title').textContent = def.tag;
      syncTreeSelection();
    });
  });
  propBody.querySelector('[data-k="section"]')?.addEventListener('change', (e) => {
    pushUndo();
    def.section = e.target.value;
    rebuildEquipment(def);
    renderPropPanel(def);
  });
  propBody.querySelector('[data-k="just"]')?.addEventListener('change', (e) => {
    pushUndo();
    def.just = e.target.value;
    rebuildEquipment(def);
    renderPropPanel(def);
  });
  propBody.querySelectorAll('[data-nzdn]').forEach((sel) => sel.addEventListener('change', () => {
    pushUndo();
    def.nozzles[+sel.dataset.nzdn].dn = sel.value;
    rebuildEquipment(def);
  }));
  propBody.querySelectorAll('[data-nzdel]').forEach((b) => b.addEventListener('click', () => {
    pushUndo();
    def.nozzles.splice(+b.dataset.nzdel, 1);
    rebuildEquipment(def);
    renderPropPanel(def);
    setHint(`已刪除 <b>${def.tag}</b> 管嘴`);
  }));
  document.getElementById('prop-tray')?.addEventListener('click', () => {
    // 沿管架頂層自動佈電纜橋架：長度/位置/轉向承接管架
    pushUndo();
    const unit = sceneData.plant.units.find((u) => u.equipment.includes(def)) ?? sceneData.plant.units[0];
    const tray = {
      tag: nextTag('CT'), type: 'cabletray', name: '電纜橋架（沿管架）',
      dims: { w: 0.45, len: def.dims.w ?? 8, elev: +((def.dims.h ?? 4) + 0.15).toFixed(2) },
      pos: [...def.pos], rot_y: def.rot_y ?? 0,
      design: {}, instruments: [], pid_ref: '',
    };
    unit.equipment.push(tray);
    buildEquipment(tray);
    rebuildTree();
    updateTopbar();
    setHint(`已沿 <b>${def.tag}</b> 頂層佈橋架 <b>${tray.tag}</b>（EL.${Math.round(((def.dims.h ?? 4) + 0.15) * 1000)}，儀電圖層）`);
  });
  document.getElementById('prop-tray-chain')?.addEventListener('click', () => {
    pushUndo();
    const res = chainTrayFromRack(def);
    rebuildTree(); updateTopbar();
    setHint(res.trays > 1 ? `已串接 ${res.racks} 座共線管架：${res.trays} 段橋架＋${res.bends} 轉角彎頭（儀電圖層）` : `僅此管架佈 1 段橋架（找不到共線相鄰管架）`);
  });
  document.getElementById('prop-zoom').addEventListener('click', () => zoomToSelection());
  document.getElementById('prop-delete').addEventListener('click', deleteSelected);
}

// ---------------- 基元堆疊（E3D Create Equipment：BOX/CYLI/CONE/DISH 組合） ----------------
const PRIM_KINDS = {
  box: { name: 'BOX 方箱', dims: { w: 1.6, h: 1.2, d: 1.6 } },
  cyli: { name: 'CYLI 圓柱', dims: { r: 0.9, h: 1.8 } },
  cone: { name: 'CONE 錐段', dims: { r1: 0.9, r2: 0.45, h: 1.0 } },
  dish: { name: 'DISH 封頭', dims: { r: 0.9 } },
  snou: { name: 'SNOU 偏心漸縮', dims: { r1: 0.9, r2: 0.45, h: 1.0, off: 0.3 } },
  pyra: { name: 'PYRA 角錐/漏斗', dims: { bx: 1.4, bz: 1.4, tx: 0.5, tz: 0.5, h: 1.2 } },
  ctor: { name: 'CTOR 圓環/彎頭', dims: { r: 0.9, rt: 0.2, ang: 90 } },
};
// 基元中非長度型的參數（角度等），不做 mm 轉換
const PRIM_NONLEN = new Set(['ang']);
const primHeight = (p) => p.kind === 'dish' ? p.dims.r : (p.dims.h ?? 1);

function primsSection(def) {
  const rows = (def.prims ?? []).map((p, i) => {
    const dimStr = Object.entries(p.dims).map(([k, v]) => `${k}=${PRIM_NONLEN.has(k) ? v : toDisp(v)}`).join(' ');
    return `<label>${PRIM_KINDS[p.kind]?.name.split(' ')[0] ?? p.kind} #${i + 1}</label>
      <div class="pg-v" style="display:flex;gap:4px;align-items:center">
        <span style="flex:1;background:none;padding:4px 6px" title="${unitLabel()}">${dimStr}｜y=${toDisp(p.pos?.[1] ?? 0)}</span>
        <button class="pane-x" data-pedit="${i}" title="編修">…</button>
        <button class="pane-x" data-pdel="${i}" title="刪除">✕</button>
      </div>`;
  }).join('');
  const opts = Object.entries(PRIM_KINDS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  return `<div class="pg-section">Primitives（堆疊建模）</div>
    <div class="pg-grid">${rows}</div>
    <div style="display:flex;gap:6px;margin-top:6px">
      <select class="rsel" id="prim-kind" style="flex:1">${opts}</select>
      <button class="pbtn" id="prim-add" style="width:auto;margin:0;padding:6px 12px">堆上去</button>
    </div>`;
}

function wirePrims(def) {
  document.getElementById('prim-add')?.addEventListener('click', () => {
    pushUndo();
    def.prims ??= [];
    const kind = document.getElementById('prim-kind').value;
    const top = def.prims.reduce((y, p) => Math.max(y, (p.pos?.[1] ?? 0) + primHeight(p)), 0);
    def.prims.push({ kind, dims: JSON.parse(JSON.stringify(PRIM_KINDS[kind].dims)), pos: [0, top, 0] });
    rebuildEquipment(def);
    renderPropPanel(def);
  });
  propBody.querySelectorAll('[data-pdel]').forEach((b) => b.addEventListener('click', () => {
    pushUndo();
    def.prims.splice(+b.dataset.pdel, 1);
    rebuildEquipment(def);
    renderPropPanel(def);
  }));
  propBody.querySelectorAll('[data-pedit]').forEach((b) => b.addEventListener('click', () => {
    const p = def.prims[+b.dataset.pedit];
    const cur = Object.entries(p.dims).map(([k, v]) => `${k}=${PRIM_NONLEN.has(k) ? v : toDisp(v)}`).join(', ') + `, y=${toDisp(p.pos?.[1] ?? 0)}`;
    const s = prompt(`基元參數（長度 ${unitLabel()}／角度 度，如 r=1200, h=3000, y=2500）：`, cur);
    if (!s) return;
    pushUndo();
    for (const kv of s.split(',')) {
      const [k, v] = kv.split('=').map((x) => x.trim());
      if (!k || Number.isNaN(+v)) continue;
      if (k === 'y') { p.pos = p.pos ?? [0, 0, 0]; p.pos[1] = fromDisp(v); }
      else p.dims[k] = PRIM_NONLEN.has(k) ? +v : fromDisp(v);
    }
    rebuildEquipment(def);
    renderPropPanel(def);
  }));
}

function renderPipeProps(index) {
  repaintPanel = () => renderPipeProps(index);
  const pipe = sceneData.pipes[index];
  document.getElementById('prop-title').textContent = `管線 #${index + 1}`;
  const isDuct = pipe.profile === 'duct';
  const DUCT_FITTINGS = [{ kind: 'tee', name: '風管三通' }, { kind: 'damper', name: '風門' }, { kind: 'transition', name: '漸縮' }];
  const DUCT_SHAPES = [{ v: 'rect', name: '矩形' }, { v: 'circ', name: '圓形' }, { v: 'oval', name: '橢圓' }];
  const compKinds = isDuct ? DUCT_FITTINGS : PIPE_COMPONENTS;
  const compName = Object.fromEntries([...PIPE_COMPONENTS, ...DUCT_FITTINGS].map((c) => [c.kind, c.name]));
  const compRows = (pipe.components ?? []).map((c, i) =>
    `<label>${compName[c.kind] ?? c.kind}</label>
     <div class="pg-v" style="display:flex;gap:4px;align-items:center">
       <input data-cat="${i}" type="number" step="${U().step}" value="${toDisp(c.at)}" title="距管頭弧長（${unitLabel()}）" style="flex:1">
       <button class="pane-x" data-cdel="${i}" title="刪除">✕</button>
     </div>`).join('');
  const compOpts = compKinds.map((c) => `<option value="${c.kind}">${c.name}</option>`).join('');
  propBody.innerHTML = `
    <div class="pg-section">General</div>
    <div class="pg-grid">
      ${pgRow('Name', `<span>PIPE #${index + 1}</span>`)}
      ${pgRow('Owner', `<span>ZONE PIPES</span>`)}
      ${pipe.bridge ? pgRow('類別', '<span>跨圖橋接</span>') : ''}
    </div>
    <div class="pg-section">Specification</div>
    <div class="pg-grid">
      ${isDuct ? (() => {
        const duct = pipe.duct ?? {};
        const shape = duct.shape ?? 'rect';
        const w = duct.w ?? 0.8, h = duct.h ?? 0.5, dd = duct.d ?? w;
        let rows = pgRow('斷面形狀', `<select data-duct="shape" style="width:100%">${DUCT_SHAPES.map((s) =>
          `<option value="${s.v}" ${shape === s.v ? 'selected' : ''}>${s.name}</option>`).join('')}</select>`);
        if (shape === 'circ') {
          rows += pgRow(`直徑 ⌀ (${unitLabel()})`, `<input data-duct="d" type="number" step="${U().step}" value="${toDisp(dd)}">`);
        } else {
          rows += pgRow(`寬 W (${unitLabel()})`, `<input data-duct="w" type="number" step="${U().step}" value="${toDisp(w)}">`);
          rows += pgRow(`高 H (${unitLabel()})`, `<input data-duct="h" type="number" step="${U().step}" value="${toDisp(h)}">`);
        }
        return rows;
      })() : ''}
      ${isDuct ? '' : pgRow('Spec', `<select data-k="spec" style="width:100%">${PIPE_SPECS.map((sp) =>
        `<option value="${sp.code}" ${pipe.spec === sp.code ? 'selected' : ''}>${sp.code}｜${sp.name}</option>`).join('')}</select>`)}
      ${isDuct ? '' : pgRow('服務別 Service', `<select data-k="service" style="width:100%"><option value="" ${!pipe.service ? 'selected' : ''}>（無）＝用 Spec 色</option>${PIPE_SERVICES.map((sv) =>
        `<option value="${sv.code}" ${pipe.service === sv.code ? 'selected' : ''}>${sv.name}</option>`).join('')}</select>`)}
      ${isDuct ? '' : pgRow('Bore', `<select data-k="dn" style="width:100%">${
        (!pipe.dn && !PIPE_BORES.some((b) => Math.abs(b.r - pipe.r) < 0.01))
          ? '<option value="" selected disabled>（自訂 bore）</option>' : ''}${PIPE_BORES.map((b) =>
        `<option value="${b.dn}" ${pipe.dn === b.dn || (!pipe.dn && Math.abs(b.r - pipe.r) < 0.01) ? 'selected' : ''}>${b.dn}（⌀${Math.round(b.r * 2000)}mm）</option>`).join('')}</select>`)}
      ${isDuct ? '' : pgRow(`外徑 ⌀ (${unitLabel()})`, `<input data-k="od" type="number" step="${U().step}" value="${toDisp(pipe.r * 2)}">`)}
      ${isDuct ? '' : pgRow('Schedule', `<select data-k="sched" style="width:100%">${PIPE_SCHEDULES.map((s) =>
        `<option value="${s}" ${(pipe.sched ?? 'STD') === s ? 'selected' : ''}>Sch ${s}</option>`).join('')}</select>`)}
      ${(() => {
        const wall = isDuct ? null : pipeWall(pipe.dn, pipe.sched ?? 'STD');
        return wall == null ? ''
          : pgRow(`壁厚 (${unitLabel()})`, `<span>${fmtLen(wall, false)}</span>`)
          + pgRow(`內徑 bore (${unitLabel()})`, `<span>${fmtLen(pipe.r * 2 - 2 * wall, false)}</span>`);
      })()}
      ${pgRow(`保溫厚 (${unitLabel()})`, `<input data-k="insul" type="number" step="${U().step}" value="${toDisp(pipe.insul ?? 0)}">`)}
      ${(pipe.insul ?? 0) > 0 ? pgRow(`含保溫外徑 (${unitLabel()})`, `<span>${fmtLen(pipe.r * 2 + 2 * pipe.insul, false)}</span>`) : ''}
      ${isDuct ? '' : pgRow('坡度 Slope (‰)', `<input data-k="slope" type="number" step="1" value="${+pipe.slope || 0}" title="每公尺水平落差 mm（‰）；下坡為正。0＝水平">`)}
      ${isDuct ? '' : (() => {
        const s = +pipe.slope || 0;
        if (!s) return '';   // 水平不顯 Fall 列，維持面板精簡
        const hLen = pipeHorizLength(pipe);          // 水平長度（公尺 canonical）
        const fall = (s / 1000) * hLen;              // 總落差＝水平長度×坡度
        const ratio = `1:${Math.round(1000 / Math.abs(s))}`;
        return pgRow('總落差 Fall', `<span>${fmtLen(fall)}（${ratio}／水平 ${fmtLen(hLen)}）</span>`);
      })()}
      ${pgRow('節點數', `<span>${pipe.pts.length}</span>`)}
      ${pgRow('總長', `<span>${fmtLen(pipeLength(pipe))}</span>`)}
    </div>
    <div class="pg-section">Components（管中元件）</div>
    ${compRows ? `<div class="pg-grid">${compRows}</div>` : ''}
    <div style="display:flex;gap:6px;margin-top:6px">
      <select class="rsel" id="comp-kind" style="flex:1">${compOpts}</select>
      <button class="pbtn" id="comp-place" style="width:auto;margin:0;padding:6px 12px">沿管放置</button>
    </div>
    <button class="pbtn" id="prop-nodes">節點編輯</button>
    <button class="pbtn danger" id="prop-delete">刪除（Delete）</button>`;
  propBody.querySelector('[data-k="od"]')?.addEventListener('change', (e) => {   // 風管不渲染此欄→null-safe
    pushUndo();
    pipe.dn = null;   // 手改外徑＝自訂 bore，清掉 DN 名目避免下拉與實際 r 矛盾（也不污染存檔/USD）
    pipe.r = Math.round(fromDisp(e.target.value) / 2 * 10000) / 10000;   // 外徑 ÷2 → 半徑（保 0.1mm 精度）
    rebuildAllPipes();
    selectPipe(index);
  });
  propBody.querySelector('[data-k="spec"]')?.addEventListener('change', (e) => {   // 風管不渲染此欄→null-safe
    pushUndo();
    pipe.spec = e.target.value;
    selectPipe(index);
  });
  propBody.querySelector('[data-k="service"]')?.addEventListener('change', (e) => {   // 服務別著色（風管不渲染此欄→null-safe）
    pushUndo();
    pipe.service = e.target.value || undefined;   // 空＝無服務別，存 undefined（回用 Spec 色、不污染存檔）
    rebuildAllPipes();   // 重建以套用服務色材質（材質在 buildPipe 決定）
    selectPipe(index);
  });
  propBody.querySelector('[data-k="dn"]')?.addEventListener('change', (e) => {   // 風管不渲染此欄→null-safe
    pushUndo();
    pipe.dn = e.target.value;
    pipe.r = PIPE_BORES.find((b) => b.dn === pipe.dn)?.r ?? pipe.r;
    rebuildAllPipes();
    selectPipe(index);
  });
  propBody.querySelector('[data-k="sched"]')?.addEventListener('change', (e) => {
    pushUndo();
    pipe.sched = e.target.value;
    selectPipe(index);   // 壁厚僅影響顯示（bore＝OD−2×壁厚），外徑/幾何不變
  });
  propBody.querySelector('[data-k="insul"]')?.addEventListener('change', (e) => {
    pushUndo();
    pipe.insul = Math.max(0, fromDisp(e.target.value));   // 保溫層厚（公尺）
    rebuildAllPipes();   // 重建以套用/移除保溫外殼
    selectPipe(index);
  });
  propBody.querySelector('[data-k="slope"]')?.addEventListener('change', (e) => {   // 風管不渲染此欄→null-safe
    pushUndo();
    // 坡度存 ‰（每公尺水平落差 mm）；純中繼屬性，只影響渲染/報表，不改 pipe.pts。
    const v = Math.round(parseFloat(e.target.value) || 0);   // 收斂為整數 ‰
    pipe.slope = v || undefined;   // 0 存 undefined，維持水平預設乾淨（不污染存檔）
    rebuildAllPipes();   // 重建以套用/移除坡度視覺落差與標記
    selectPipe(index);
  });
  // 風管斷面形狀：切換 rect/circ/oval，改變後重繪面板（切換 W/H↔⌀ 欄位）並重建
  propBody.querySelector('[data-duct="shape"]')?.addEventListener('change', (e) => {
    pushUndo();
    pipe.duct = pipe.duct ?? {};
    pipe.duct.shape = e.target.value;
    if (pipe.duct.shape === 'circ' && pipe.duct.d == null) pipe.duct.d = pipe.duct.w ?? 0.8;  // 圓形沿用寬作預設直徑
    pipe.r = Math.max(pipe.duct.w ?? 0, pipe.duct.h ?? 0, pipe.duct.d ?? 0) / 2;   // 同步等效半徑（clash/支撐用）
    rebuildAllPipes();
    selectPipe(index);   // 觸發 renderPipeProps 重繪，換出對應尺寸欄位
  });
  // 風管斷面尺寸（mm 顯示、公尺寫回 pipe.duct）
  propBody.querySelectorAll('[data-duct="w"], [data-duct="h"], [data-duct="d"]').forEach((inp) =>
    inp.addEventListener('change', (e) => {
      pushUndo();
      pipe.duct = pipe.duct ?? {};
      pipe.duct[inp.dataset.duct] = Math.max(0.001, fromDisp(e.target.value));   // 顯示值→公尺，下限 1mm
      pipe.r = Math.max(pipe.duct.w ?? 0, pipe.duct.h ?? 0, pipe.duct.d ?? 0) / 2;   // 同步等效半徑（clash/支撐用）
      rebuildAllPipes();
      selectPipe(index);
    }));
  propBody.querySelectorAll('[data-cat]').forEach((inp) => inp.addEventListener('change', () => {
    pushUndo();
    pipe.components[+inp.dataset.cat].at =
      Math.max(0.2, Math.min(fromDisp(inp.value), pipeLength(pipe) - 0.2));
    rebuildAllPipes();
    selectPipe(index);
  }));
  propBody.querySelectorAll('[data-cdel]').forEach((b) => b.addEventListener('click', () => {
    pushUndo();
    pipe.components.splice(+b.dataset.cdel, 1);
    rebuildAllPipes();
    selectPipe(index);
  }));
  document.getElementById('comp-place').addEventListener('click', () => {
    pendingComp = { kind: document.getElementById('comp-kind').value, pipeIndex: index };
    mode = 'placecomp';
    setHint(`沿<b>管線 #${index + 1}</b>移動游標，點擊放置<b>${compName[pendingComp.kind]}</b>（Esc 取消）`);
  });
  document.getElementById('prop-nodes').addEventListener('click', () => enterNodeMode(index));
  document.getElementById('prop-delete').addEventListener('click', deleteSelected);
}

// ---------------- 管線元件放置（沿弧長定位，E3D Position Through） ----------------
let pendingComp = null;
let compGhost = null;

function pipeLength(pipe) {
  let L = 0;
  for (let i = 0; i < pipe.pts.length - 1; i++) {
    L += Math.hypot(pipe.pts[i + 1][0] - pipe.pts[i][0],
                    pipe.pts[i + 1][1] - pipe.pts[i][1],
                    pipe.pts[i + 1][2] - pipe.pts[i][2]);
  }
  return L;
}

// 水平長度（XZ 平面投影，公尺 canonical）：供坡度總落差 Fall＝水平長度×坡度 使用。
// pts 為水平 canonical，故此值≈pipeLength；仍以 XZ 投影計算以求語意正確且不受既有 Y 影響。
function pipeHorizLength(pipe) {
  let L = 0;
  for (let i = 0; i < pipe.pts.length - 1; i++) {
    L += Math.hypot(pipe.pts[i + 1][0] - pipe.pts[i][0],
                    pipe.pts[i + 1][2] - pipe.pts[i][2]);
  }
  return L;
}

// 游標 → 管線最近點的弧長位置（用地面點對每段投影）
function nearestArcOnPipe(pipe, pt) {
  let best = { d: Infinity, at: 0, pos: null, dir: null };
  let acc = 0;
  for (let i = 0; i < pipe.pts.length - 1; i++) {
    const a = new THREE.Vector3(...pipe.pts[i]);
    const b = new THREE.Vector3(...pipe.pts[i + 1]);
    const ab = b.clone().sub(a);
    const len = ab.length();
    if (len < 1e-4) { acc += len; continue; }
    const t = Math.max(0.05, Math.min(0.95,
      pt.clone().sub(a).dot(ab) / (len * len)));
    const q = a.clone().addScaledVector(ab, t);
    const d = Math.hypot(q.x - pt.x, q.z - pt.z);   // 俯視距離（游標在地面）
    if (d < best.d) best = { d, at: acc + t * len, pos: q, dir: ab.normalize() };
    acc += len;
  }
  return best;
}

function arcToPose(pipe, at) {
  let acc = 0;
  for (let i = 0; i < pipe.pts.length - 1; i++) {
    const a = new THREE.Vector3(...pipe.pts[i]);
    const b = new THREE.Vector3(...pipe.pts[i + 1]);
    const len = a.distanceTo(b);
    if (acc + len >= at || i === pipe.pts.length - 2) {
      const t = Math.max(0, Math.min(1, (at - acc) / Math.max(len, 1e-6)));
      return { pos: a.lerp(b, t), dir: b.clone().sub(a).normalize() };
    }
    acc += len;
  }
  return null;
}

// ------------------------------------------------------------ 模型瀏覽器（Model Explorer）
const treeRoot = document.getElementById('model-tree');
const TYPE_ICON = {
  reactor: '◆', fixedbed: '◆', pfr: '◆', column: '▮', packedcol: '▮',
  flash_v: '◍', flash_h: '◍', cyclone: '◍', hx: '═', kettle: '═', aircooler: '═',
  pump: '●', compressor: '●', recip: '●', blower: '●',
  tank: '⬢', bullet: '⬢', spheretank: '⬢',
};

// E3D/PDMS 資料庫階層字樣（WORL→SITE→ZONE→EQUI/PIPE）——識別度核心，照抄縮寫
function rebuildTree(filter = document.getElementById('tree-search').value.trim().toUpperCase()) {
  const frag = document.createDocumentFragment();
  const worl = document.createElement('details');
  worl.className = 'mt-unit';
  worl.open = true;
  worl.innerHTML = `<summary><span class="tw">▶</span><span class="mt-dbtype">WORL</span>*</summary>`;
  const site = document.createElement('details');
  site.className = 'mt-unit';
  site.open = true;
  site.style.paddingLeft = '10px';
  site.innerHTML = `<summary><span class="tw">▶</span><span class="mt-dbtype">SITE</span>${sceneData.plant.id}</summary>`;
  worl.appendChild(site);

  for (const unit of sceneData.plant.units) {
    const eqs = unit.equipment.filter((e) =>
      !filter || e.tag.toUpperCase().includes(filter) || e.name.toUpperCase().includes(filter));
    if (!eqs.length && filter) continue;
    const det = document.createElement('details');
    det.className = 'mt-unit';
    det.dataset.zone = unit.id;
    det.style.paddingLeft = '10px';
    det.open = Boolean(filter) || sceneData.plant.units.length <= 4;
    det.innerHTML = `<summary><span class="tw">▶</span><span class="mt-dbtype">ZONE</span>${unit.name}（${eqs.length}）</summary>`;
    det.querySelector('summary').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtxMenu(e.clientX, e.clientY, [
        { label: '全部顯示', run: () => { for (const eq of unit.equipment) if (hiddenTags.has(eq.tag)) toggleHidden(eq.tag); } },
        { label: '全部隱藏', run: () => { for (const eq of unit.equipment) if (!hiddenTags.has(eq.tag)) toggleHidden(eq.tag); } },
      ]);
    });
    for (const eq of eqs) {
      const row = document.createElement('div');
      row.className = 'mt-eq';
      row.dataset.tag = eq.tag;
      if (hiddenTags.has(eq.tag)) row.classList.add('hidden-eq');
      row.innerHTML = `<span class="mt-dbtype">EQUI</span><span class="mt-ico">${TYPE_ICON[eq.type] ?? '▪'}</span>
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
    site.appendChild(det);
  }
  if (sceneData.pipes.length) {
    const det = document.createElement('details');
    det.className = 'mt-unit';
    det.dataset.zone = 'PIPES';
    det.style.paddingLeft = '10px';
    det.innerHTML = `<summary><span class="tw">▶</span><span class="mt-dbtype">ZONE</span>管線（${sceneData.pipes.length}）</summary>`;
    const max = Math.min(sceneData.pipes.length, 200);
    for (let i = 0; i < max; i++) {
      const row = document.createElement('div');
      row.className = 'mt-eq';
      row.dataset.pipe = i;
      row.innerHTML = `<span class="mt-dbtype">PIPE</span><span class="mt-tag">#${i + 1}</span>
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
    site.appendChild(det);
  }
  frag.appendChild(worl);
  treeRoot.replaceChildren(frag);
  syncTreeSelection();
}

// CE 麵包屑（E3D 頂部路徑）：WORL * › SITE x › ZONE y › EQUI tag
function updateBreadcrumb() {
  const bc = document.getElementById('ce-breadcrumb');
  const segs = [['WORL', '*', null], ['SITE', sceneData.plant.id, null]];
  if (selected?.kind === 'eq') {
    const unit = sceneData.plant.units.find((u) => u.equipment.includes(selected.def));
    if (unit) segs.push(['ZONE', unit.name, unit.id]);
    segs.push(['EQUI', selected.def.tag, null]);
  } else if (selected?.kind === 'pipe') {
    segs.push(['ZONE', '管線', 'PIPES']);
    segs.push(['PIPE', `#${selected.index + 1}`, null]);
  }
  bc.innerHTML = segs.map(([t, v, zone]) =>
    `<span class="bc-seg" ${zone ? `data-zone="${zone}"` : ''}><span class="bc-type">${t}</span>${v}</span>`
  ).join('<span class="bc-sep">›</span>');
  bc.querySelectorAll('[data-zone]').forEach((el) => el.addEventListener('click', () => {
    const det = treeRoot.querySelector(`details[data-zone="${el.dataset.zone}"]`);
    if (det) { det.open = true; det.scrollIntoView({ block: 'nearest' }); }
  }));
}

function syncTreeSelection() {
  let selRow = null;
  treeRoot.querySelectorAll('.mt-eq').forEach((el) => {
    const on = (selected?.kind === 'eq' && el.dataset.tag === selected.def.tag) ||
      (selected?.kind === 'pipe' && el.dataset.pipe === String(selected.index));
    el.classList.toggle('selected', on);
    if (on) selRow = el;
  });
  // CE 連動：自動展開祖先節點並捲動到可視（E3D Model Explorer 行為）
  if (selRow) {
    for (let p = selRow.parentElement; p && p !== treeRoot; p = p.parentElement) {
      if (p.tagName === 'DETAILS') p.open = true;
    }
    selRow.scrollIntoView({ block: 'nearest' });
  }
  updateBreadcrumb();
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
    if (it.children) {   // 子選單（hover 展開）
      const wrap = document.createElement('div');
      wrap.className = 'ctx-sub';
      const btn = document.createElement('button');
      btn.textContent = it.label;
      wrap.appendChild(btn);
      const sub = document.createElement('div');
      sub.className = 'ctx-sub-menu';
      for (const c of it.children) {
        const cb = document.createElement('button');
        cb.textContent = c.label;
        cb.addEventListener('click', () => { closeCtxMenu(); c.run(); });
        sub.appendChild(cb);
      }
      wrap.appendChild(sub);
      ctxMenu.appendChild(wrap);
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
    { label: '輸入座標…', run: () => {
      selectEquipment(tag);
      const inp = propBody.querySelector('input[data-k="pos.0"]');
      if (inp) { inp.focus(); inp.select(); }
    } },
    { label: '對齊到…', run: () => startAlignPick(tag) },
    { label: '複製', run: () => duplicateEquipment(tag) },
    'sep',
    { label: '刪除', danger: true, run: () => { selectEquipment(tag); deleteSelected(); } },
  ];
}

// 複製設備（tag 依前綴遞增、位置偏移 +2,+2）
function duplicateEquipment(tag) {
  const src = eqObjects.get(tag)?.def;
  if (!src) return;
  pushUndo();
  const prefix = (src.tag.match(/^[A-Z]+/i)?.[0] ?? 'X').toUpperCase();
  const def = JSON.parse(JSON.stringify(src));
  def.tag = nextTag(prefix);
  def.pos = [src.pos[0] + 2, 0, src.pos[2] + 2];
  def.instruments = [];
  const unit = sceneData.plant.units.find((u) => u.equipment.includes(src)) ?? sceneData.plant.units[0];
  unit.equipment.push(def);
  buildEquipment(def);
  rebuildTree();
  updateTopbar();
  selectEquipment(def.tag);
}

// 對齊到…（E3D Align with Feature 簡化版）：點目標設備 → 選對齊軸
let alignSrcTag = null;
function startAlignPick(tag) {
  alignSrcTag = tag;
  mode = 'alignpick';
  setHint(`對齊 <b>${tag}</b>：點選<b>目標設備</b>（Esc 取消）`);
}
function finishAlignPick(dstTag, x, y) {
  const src = eqObjects.get(alignSrcTag)?.def;
  const dst = eqObjects.get(dstTag)?.def;
  mode = 'idle';
  if (!src || !dst || dstTag === alignSrcTag) { alignSrcTag = null; setHint('對齊取消'); return; }
  openCtxMenu(x, y, [
    { label: `對齊東座標（E＝${fmtLen(dst.pos[0])}）`, run: () => applyAlign(src, dst, true, false) },
    { label: `對齊北座標（N＝${fmtLen(dst.pos[2])}）`, run: () => applyAlign(src, dst, false, true) },
    { label: '兩者對齊（重合）', run: () => applyAlign(src, dst, true, true) },
  ]);
}
function applyAlign(src, dst, ex, nz) {
  pushUndo();
  if (ex) src.pos[0] = dst.pos[0];
  if (nz) src.pos[2] = dst.pos[2];
  eqObjects.get(src.tag).group.position.set(...src.pos);
  selectEquipment(src.tag);
  alignSrcTag = null;
}

function toggleHidden(tag) {
  const entry = eqObjects.get(tag);
  if (!entry) return;
  if (hiddenTags.has(tag)) hiddenTags.delete(tag);
  else {
    hiddenTags.add(tag);
    if (selected?.kind === 'eq' && selected.def.tag === tag) transform.detach();
  }
  entry.group.visible = !hiddenTags.has(tag) && eqLayerOn(entry.def);
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

// QAT Discipline 下拉 → 情境頁籤顯示（E3D：手動切換，非點物件自動切）
// 結構 STRUCTURES：只帶出設備 tab，且素材群組過濾為結構鋼構
document.getElementById('qat-discipline').addEventListener('change', (e) => {
  const v = e.target.value;
  const show = { pipe: ['equip', 'pipe'], equip: ['equip'], struct: ['equip'], elec: ['equip'], hvac: ['equip'], none: [] }[v];
  document.querySelectorAll('.ctx-tab').forEach((t) => {
    const on = show.includes(t.dataset.tab);
    t.classList.toggle('hidden', !on);
    if (!on && t.classList.contains('active')) {
      document.querySelector('.rtab[data-tab="home"]').click();
    }
  });
  const disc = { struct: 'struct', elec: 'elec', hvac: 'hvac' }[v] ?? 'general';
  equipRibbon.querySelectorAll('.rgroup').forEach((g) => {
    g.style.display = g.dataset.disc === disc ? '' : 'none';
  });
  const equipTab = document.querySelector('.rtab[data-tab="equip"]');
  equipTab.textContent = { struct: '結構 STRUCTURES', elec: '儀電 ELECTRICAL', hvac: '風管 HVAC' }[v] ?? '設備 EQUIPMENT';
});

// QAT 迷你鈕鏡射主要功能
document.getElementById('qat-save').addEventListener('click', () => saveScene(false));
document.getElementById('qat-saveas').addEventListener('click', () => saveScene(true));
document.getElementById('qat-undo').addEventListener('click', undo);
document.getElementById('qat-redo').addEventListener('click', redo);

// 視窗開關（HOME > 視窗）
document.getElementById('btn-win-tree').addEventListener('click', () => {
  document.body.classList.toggle('tree-collapsed');
  onResize();
});
document.getElementById('btn-win-prop').addEventListener('click', () => {
  document.body.classList.toggle('prop-collapsed');
  onResize();
});

// 設備分頁：分類群組（E3D discipline gallery 式）
const equipRibbon = document.getElementById('equip-ribbon');
for (const cat of ASSET_CATEGORIES) {
  const g = document.createElement('div');
  g.className = 'rgroup';
  g.dataset.disc = cat.discipline ?? 'general';
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

// 預設 discipline＝管線：結構鋼構群組先隱藏（切 STRUCTURES 才亮）
equipRibbon.querySelectorAll('.rgroup[data-disc="struct"], .rgroup[data-disc="elec"], .rgroup[data-disc="hvac"]').forEach((g) => { g.style.display = 'none'; });

function startPlacing(asset, btn) {
  setMode('placing');
  placingAsset = asset;
  btn.classList.add('active');
  ghost = builders[asset.type](asset.dims, asset);
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
document.getElementById('duct-btn').addEventListener('click', () => {
  if (mode === 'pipe' && ductDraw) { setMode('idle'); return; }
  setMode('pipe');
  ductDraw = true;
  ductSize = document.getElementById('duct-size').value.split(',').map(Number);
  document.getElementById('duct-btn').classList.add('active');
  selectNone();
  setHint('風管繪製：依序點擊路徑點，<b>Enter</b> 完成；轉角自動放方形彎頭，之後可沿風管放三通/風門。Esc 取消');
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

// 吸附：開＝對齊 snapStepMm 網格；關＝1mm 精度（取代舊的 0.5m／1cm 粗量化）
function snapVal(v) {
  if (snapOn) { const s = snapStepMm / 1000; return roundMM(Math.round(v / s) * s); }
  return roundMM(v);
}

// Shift＝正交鎖定（E3D 畫管慣例）：新點強制與上一點同 E 或同 N（取位移大者）
function orthoLock(pt, e) {
  if (!e?.shiftKey || !pipeDraft.length) return pt;
  const prev = pipeDraft[pipeDraft.length - 1];
  const dx = Math.abs(pt.x - prev.x), dz = Math.abs(pt.z - prev.z);
  const locked = pt.clone();
  if (dx >= dz) locked.z = prev.z;
  else locked.x = prev.x;
  return locked;
}

function snapToEquipment(pt) {
  // 管嘴優先：1.5m 內吸附最近 nozzle 端點（含高度）——配管接嘴
  let bestNz = null, bestNzD = 1.5;
  for (const { def } of eqObjects.values()) {
    for (const nz of def.nozzles ?? []) {
      const w = nozzleWorld(def, nz);
      const d = Math.hypot(w.x - pt.x, w.z - pt.z);
      if (d < bestNzD) { bestNzD = d; bestNz = w; }
    }
  }
  if (bestNz) return bestNz;
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
             && o.userData?.nodeIndex === undefined && o.userData?.routeDir === undefined) o = o.parent;
    if (o?.userData?.eqTag && hiddenTags.has(o.userData.eqTag)) continue;
    if (o) return { obj: o, point: hit.point };
  }
  return null;
}

// 專門對 3D 標註群做 raycast，回傳命中的 dimIndex（無則 null；供右鍵刪除）
function pickDim(e) {
  if (!dimGroup) return null;
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  for (const hit of raycaster.intersectObjects(dimGroup.children, true)) {
    let o = hit.object;
    while (o && o.userData?.dimIndex === undefined) o = o.parent;
    if (o && o.userData?.dimIndex !== undefined) return o.userData.dimIndex;
  }
  return null;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  const pt = groundPoint(e);
  if (pt) document.getElementById('st-coords').textContent =
    `E: ${fmtLen(pt.x, false)}  N: ${fmtLen(pt.z, false)}  U: 0 (${unitLabel()})`;
  if (mode === 'placing' && ghost) {
    if (pt) ghost.position.set(snapVal(pt.x), 0, snapVal(pt.z));
  } else if (mode === 'pipe' && pipeDraft.length) {
    if (pt) updatePipePreview(orthoLock(snapToEquipment(pt), e));
  } else if (mode === 'placecomp' && pendingComp && pt) {
    const pipe = sceneData.pipes[pendingComp.pipeIndex];
    const near = nearestArcOnPipe(pipe, pt);
    if (near.pos) {
      if (!compGhost) {
        compGhost = pipe.profile === 'duct'
          ? buildDuctFitting(pendingComp.kind, pipe.duct?.w ?? 0.8, pipe.duct?.h ?? 0.5, pipe.duct)
          : buildPipeComponent(pendingComp.kind, pipe.r);
        compGhost.traverse((o) => {
          if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.55; }
        });
        scene.add(compGhost);
      }
      compGhost.position.copy(near.pos);
      compGhost.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), near.dir);
      pendingComp.at = roundMM(near.at);
      setHint(`放置於距管頭 <b>${fmtLen(pendingComp.at)}</b>（點擊確定、Esc 取消）`);
    }
  }
});

let downXY = null;
let mb2Down = null;   // 中鍵按下點（單擊置中判定）
let pivotPin = null;  // 粉紅 pivot 指示

renderer.domElement.addEventListener('pointerdown', (e) => {
  downXY = [e.clientX, e.clientY];
  if (e.button === 1) {
    // E3D：中鍵按下時在游標點放 pivot pin（粉紅）
    mb2Down = [e.clientX, e.clientY];
    const hit = pickObject(e);
    const pt = hit ? hit.point : groundPoint(e);
    if (pt) {
      pivotPin = new THREE.Group();
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xff69b4 }));
      pivotPin.add(ball);
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(dx ? 0.9 : 0.03, 0.03, dz ? 0.9 : 0.03),
          new THREE.MeshBasicMaterial({ color: 0xff69b4 }));
        pivotPin.add(bar);
      }
      pivotPin.position.copy(pt);
      pivotPin.userData.pt = pt.clone();
      scene.add(pivotPin);
    }
  }
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button === 1 && pivotPin) {
    // 中鍵單擊（無拖曳）＝游標點置中（E3D MB2 click centre）
    if (mb2Down && Math.hypot(e.clientX - mb2Down[0], e.clientY - mb2Down[1]) < 5) {
      controls.target.copy(pivotPin.userData.pt);
    }
    scene.remove(pivotPin);
    pivotPin = null;
    mb2Down = null;
  }
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
  if (transform.dragging) return;
  if (e.button !== 0) return; // 左鍵＝選取；中鍵導航、右鍵選單各自處理

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
    if (placingAsset.prims) def.prims = JSON.parse(JSON.stringify(placingAsset.prims));
    sceneData.plant.units[0].equipment.push(def);
    buildEquipment(def);
    setMode('idle');
    rebuildTree();
    updateTopbar();
    selectEquipment(def.tag);
    return;
  }

  if (mode === 'nozzle') {
    setPointer(e);
    raycaster.setFromCamera(pointer, camera);
    for (const hit of raycaster.intersectObjects(scene.children, true)) {
      let o = hit.object;
      while (o && !o.userData?.eqTag) o = o.parent;
      if (!o?.userData?.eqTag || hiddenTags.has(o.userData.eqTag)) continue;
      addNozzleAt(o.userData.eqTag, hit);
      return;
    }
    setHint('加管嘴：請點擊<b>設備表面</b>（Esc 結束）');
    return;
  }

  if (mode === 'pipe') {
    const pt = groundPoint(e);
    if (pt) {
      pipeDraft.push(orthoLock(snapToEquipment(pt), e));
      updatePipePreview();
      setHint(`管線繪製：已 ${pipeDraft.length} 點（<b>Shift</b>=正交鎖定），<b>Enter</b> 完成、<b>Esc</b> 取消`);
    }
    return;
  }

  if (mode === 'measure') {
    const hit = pickObject(e);
    const pt = hit ? hit.point : groundPoint(e);
    if (pt) addMeasurePoint(pt.clone());
    return;
  }

  if (mode === 'dim3d') {
    const hit = pickObject(e);
    const pt = hit ? hit.point : groundPoint(e);
    if (pt) addDimPoint(pt);
    return;
  }

  // placecomp：點擊確認元件位置
  if (mode === 'placecomp' && pendingComp?.at !== undefined) {
    pushUndo();
    const pipe = sceneData.pipes[pendingComp.pipeIndex];
    pipe.components ??= [];
    pipe.components.push({ kind: pendingComp.kind, at: pendingComp.at });
    pipe.components.sort((a, b) => a.at - b.at);
    const idx = pendingComp.pipeIndex;
    setMode('idle');
    rebuildAllPipes();
    selectPipe(idx);
    return;
  }

  // alignpick：點目標設備完成對齊
  if (mode === 'alignpick') {
    const hit = pickObject(e);
    if (hit?.obj.userData.eqTag) finishAlignPick(hit.obj.userData.eqTag, e.clientX, e.clientY);
    return;
  }

  // idle / pipenode：raycast 選取
  const hit = pickObject(e);
  if (hit) {
    const o = hit.obj;
    if (o.userData.routeDir !== undefined) return; // 箭頭點擊不改選取
    if (o.userData.nodeIndex !== undefined) { selectNodeHandle(o.userData.nodeIndex, o.userData.mid); return; }
    if (o.userData.nzId && mode !== 'pipenode' && mode !== 'nozzle') { selectNozzle(o.userData.eqTag, o.userData.nzId); return; }
    if (o.userData.eqTag) { if (mode !== 'pipenode') selectEquipment(o.userData.eqTag); return; }
    if (o.userData.pipeIndex !== undefined) { selectPipe(o.userData.pipeIndex); return; }
  }
  if (mode !== 'pipenode') selectNone();
});

// ------------------------------------------------------------ PowerWheel（E3D 3D 視圖右鍵放射選單）
const powerWheel = document.getElementById('power-wheel');
function openPowerWheel(x, y, items) {
  powerWheel.innerHTML = '';
  const R = 82;
  items.slice(0, 8).forEach((it, i) => {
    const ang = (i / Math.min(items.length, 8)) * Math.PI * 2 - Math.PI / 2;
    const tile = document.createElement('button');
    tile.className = 'pw-tile' + (it.danger ? ' danger' : '');
    tile.textContent = it.label;
    tile.style.transform = `translate(${Math.cos(ang) * R}px, ${Math.sin(ang) * R}px)`;
    tile.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (it.items) { openPowerWheel(x, y, it.items); return; }  // 第二環（視向）
      closePowerWheel();
      it.run();
    });
    powerWheel.appendChild(tile);
  });
  const center = document.createElement('button');
  center.className = 'pw-center';
  center.textContent = '✕';
  center.addEventListener('click', closePowerWheel);
  powerWheel.appendChild(center);
  powerWheel.style.left = `${Math.min(Math.max(x - 115, 8), innerWidth - 238)}px`;
  powerWheel.style.top = `${Math.min(Math.max(y - 115, 8), innerHeight - 238)}px`;
  powerWheel.classList.add('show');
}
function closePowerWheel() { powerWheel.classList.remove('show'); }
addEventListener('pointerdown', (e) => { if (!powerWheel.contains(e.target)) closePowerWheel(); });

const VIEW_WHEEL = () => [
  { label: '北', run: () => setViewPreset('n') },
  { label: '東', run: () => setViewPreset('e') },
  { label: '南', run: () => setViewPreset('s') },
  { label: '西', run: () => setViewPreset('w') },
  { label: '俯視', run: () => setViewPreset('top') },
  { label: '等角', run: () => setViewPreset('iso') },
];

// 右鍵：3D 視圖＝PowerWheel（E3D 2.1+ 慣例）；模型樹/節點維持清單選單；
// 右鍵拖曳=平移，只有原地右擊才開
renderer.domElement.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (downXY && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
  // 3D 標註右鍵 → 刪除該筆（在 idle 或 dim3d 模式皆可）
  if ((mode === 'idle' || mode === 'dim3d') && dimGroup?.children.length) {
    const di = pickDim(e);
    if (di !== null) {
      openCtxMenu(e.clientX, e.clientY, [
        { label: '刪除標註', danger: true, run: () => deleteDim(di) },
      ]);
      return;
    }
  }
  // pipenode 模式：節點右鍵 → 輸入數值（E3D Enter Value）
  if (mode === 'pipenode') {
    const hit = pickObject(e);
    if (hit?.obj.userData.nodeIndex !== undefined && !hit.obj.userData.mid && selected?.kind === 'pipe') {
      const i = hit.obj.userData.nodeIndex;
      const pipe = sceneData.pipes[selected.index];
      openCtxMenu(e.clientX, e.clientY, [{
        label: '輸入數值…（E, U, N）', run: () => {
          const cur = pipe.pts[i];
          const s = prompt(`節點座標 E, U, N（${unitLabel()}，逗號分隔）：`,
            `${toDisp(cur[0])}, ${toDisp(cur[1])}, ${toDisp(cur[2])}`);
          if (!s) return;
          const raw = s.split(',').map((x) => parseFloat(x.trim()));
          if (raw.length !== 3 || raw.some(Number.isNaN)) return;
          pushUndo();
          pipe.pts[i] = raw.map((x) => roundMM(x / U().f));
          rebuildAllPipes();
          selectPipe(selected.index);
        },
      }]);
    }
    return;
  }
  if (mode !== 'idle') return;
  const hit = pickObject(e);
  if (hit?.obj.userData.eqTag) {
    const tag = hit.obj.userData.eqTag;
    selectEquipment(tag);
    openPowerWheel(e.clientX, e.clientY, [
      { label: '縮放至', run: () => zoomToSelection() },
      { label: hiddenTags.has(tag) ? '顯示' : '隱藏', run: () => toggleHidden(tag) },
      { label: '複製', run: () => duplicateEquipment(tag) },
      { label: '對齊到…', run: () => startAlignPick(tag) },
      { label: '輸入座標', run: () => {
        const inp = propBody.querySelector('input[data-k="pos.0"]');
        if (inp) { inp.focus(); inp.select(); }
      } },
      { label: '量距離', run: () => startMeasure('dist') },
      { label: '剖切至此', run: () => {
        const box = new THREE.Box3().expandByObject(eqObjects.get(tag).group).expandByScalar(1);
        clipStart('box', box);
      } },
      { label: '刪除', danger: true, run: deleteSelected },
    ]);
  } else if (hit?.obj.userData.pipeIndex !== undefined) {
    const idx = hit.obj.userData.pipeIndex;
    selectPipe(idx);
    openPowerWheel(e.clientX, e.clientY, [
      { label: '節點編輯', run: () => enterNodeMode(idx) },
      { label: '縮放至', run: () => zoomToSelection() },
      { label: '量距離', run: () => startMeasure('dist') },
      { label: '刪除', danger: true, run: deleteSelected },
    ]);
  } else {
    const clickPt = groundPoint(e);
    openPowerWheel(e.clientX, e.clientY, [
      { label: '全場', run: fitAll },
      { label: '視向…', items: VIEW_WHEEL() },
      { label: '量距離', run: () => startMeasure('dist') },
      { label: '剖切盒', run: () => {
        if (!clickPt) return;
        const b = new THREE.Box3(
          clickPt.clone().add(new THREE.Vector3(-4, -0.5, -4)),
          clickPt.clone().add(new THREE.Vector3(4, 8, 4)));
        clipStart('box', b);
      } },
      { label: '漫遊', run: enterWalk },
      { label: '視角書籤', run: renderViewsPanel },
      { label: '等角', run: () => setViewPreset('iso') },
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
    for (const k of Object.keys(def.dims)) if (!COUNT_DIMS.has(k)) def.dims[k] = roundMM(def.dims[k] * s);
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
  clearRoutingArrows();
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
  const isEnd = i === 0 || i === pipe.pts.length - 1;
  if (isEnd) {
    // 端點：Quick Routing 箭頭全權接管（gizmo 會跟箭頭疊在同點打架）
    transform.detach();
    nodeDrag = null;
    buildRoutingArrows(i);
    setHint('端點：拖<b>方位箭頭</b>正交延伸（轉向自動生彎頭）；右鍵輸入數值、Delete 刪節點');
  } else {
    clearRoutingArrows();
    transform.setMode('translate');
    transform.attach(handle);
    nodeDrag = { index: i };
  }
}

// ------------------------------------------------------------ Quick Routing（端點延伸箭頭）
let routeArrows = [];
let routeDrag = null;   // { dir, endIndex, base }
const routeMat = new THREE.MeshBasicMaterial({ color: 0x46c2e0 });

function buildRoutingArrows(endIndex) {
  clearRoutingArrows();
  if (selected?.kind !== 'pipe') return;
  const pipe = sceneData.pipes[selected.index];
  const base = new THREE.Vector3(...pipe.pts[endIndex]);
  const dirs = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, 1, 0),
  ];
  for (const dir of dirs) {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.85, 6), routeMat);
    shaft.position.y = 0.6;
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.35, 8), routeMat);
    head.position.y = 1.15;
    g.add(shaft, head);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.position.copy(base);
    g.traverse((o) => { o.userData.routeDir = dir; o.userData.routeEnd = endIndex; });
    scene.add(g);
    routeArrows.push(g);
  }
}

function clearRoutingArrows() {
  for (const a of routeArrows) scene.remove(a);
  routeArrows = [];
  routeDrag = null;
}

// 箭頭拖曳：游標射線與箭頭軸線最近點 → 沿軸延伸量（吸附 0.5m）
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || mode !== 'pipenode' || !routeArrows.length) return;
  const hit = pickObject(e);
  if (!hit || hit.obj.userData.routeDir === undefined) return;
  const pipe = sceneData.pipes[selected.index];
  routeDrag = {
    dir: hit.obj.userData.routeDir.clone(),
    endIndex: hit.obj.userData.routeEnd,
    base: new THREE.Vector3(...pipe.pts[hit.obj.userData.routeEnd]),
    s: 0,
  };
  controls.enabled = false;
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!routeDrag) return;
  setPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const { base, dir } = routeDrag;
  const O = raycaster.ray.origin, d = raycaster.ray.direction;
  const w = new THREE.Vector3().subVectors(O, base);
  const b = dir.dot(d);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-6) return;
  let s = (b * d.dot(w) - dir.dot(w)) / denom;
  s = Math.max(0, snapVal(s));   // 延伸量吸附與放置/節點同源（snapStepMm 網格／關＝1mm）
  routeDrag.s = s;
  const tip = base.clone().addScaledVector(dir, s);
  if (pipePreview) scene.remove(pipePreview);
  const geo = new THREE.BufferGeometry().setFromPoints([base, tip]);
  pipePreview = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x46c2e0, dashSize: 0.5, gapSize: 0.3 }));
  pipePreview.computeLineDistances();
  scene.add(pipePreview);
  setHint(`延伸 <b>${fmtLen(s)}</b>（放開確定；轉向自動生成彎頭）`);
});
renderer.domElement.addEventListener('pointerup', () => {
  if (!routeDrag) return;
  const { dir, endIndex, base, s } = routeDrag;
  if (pipePreview) { scene.remove(pipePreview); pipePreview = null; }
  controls.enabled = true;
  if (s >= 0.4 && selected?.kind === 'pipe') {
    pushUndo();
    const pipe = sceneData.pipes[selected.index];
    const np = base.clone().addScaledVector(dir, s);
    const pt = [roundMM(np.x), roundMM(np.y), roundMM(np.z)];
    if (endIndex === 0) pipe.pts.unshift(pt);
    else pipe.pts.push(pt);
    const idx = selected.index;
    routeDrag = null;
    rebuildAllPipes();
    selectPipe(idx);
    // 重選新端點讓箭頭跟到新端（連續路由）
    selectNodeHandle(endIndex === 0 ? 0 : sceneData.pipes[idx].pts.length - 1, false);
    return;
  }
  routeDrag = null;
});

function commitNodeDrag() {
  if (!nodeDrag || selected?.kind !== 'pipe') return;
  const pipe = sceneData.pipes[selected.index];
  const handle = transform.object;
  if (!handle) { nodeDrag = null; return; }
  const p = handle.position;
  pipe.pts[nodeDrag.index] = [snapVal(p.x), Math.max(0.1, roundMM(p.y)), snapVal(p.z)];
  rebuildAllPipes();
  if (hasSupports(pipe.uid)) { regenSupportsForPipe(pipe); rebuildTree(); }   // 節點編輯完自動重生支撐
  const idx = selected.index;
  nodeDrag = null;
  selectPipe(idx);   // 重建 handles（mode 仍是 pipenode）
}

document.getElementById('pipe-node-btn').addEventListener('click', () => {
  if (mode === 'pipenode') { setMode('idle'); selectNone(); return; }
  if (selected?.kind === 'pipe') enterNodeMode(selected.index);
  else setHint('先選取一條管線，再按<b>節點編輯</b>');
});

// ------------------------------------------------------------ 量測工具（E3D Measure：距離＋角度、持久標註）
let measurePts = [];
let measureGroup = null;      // 標註持久群（球/線/弧/CSS2D 標籤）
let measureMode = 'dist';     // 'dist' | 'angle'
let lastMeasureMode = 'dist'; // 空白鍵重複上次量測用
const measureLineMat = new THREE.LineBasicMaterial({ color: 0xffaa3c });

function startMeasure(kind) {
  if (mode === 'measure' && measureMode === kind) { setMode('idle'); return; }
  setMode('measure');
  measureMode = kind;
  lastMeasureMode = kind;
  const btn = document.getElementById(kind === 'dist' ? 'btn-measure' : 'btn-measure-angle');
  btn.classList.add('active');
  setHint(kind === 'dist'
    ? '量距離：點擊<b>兩點</b>（設備表面或地面）；可連續量，Esc 結束'
    : '量角度：點<b>三點</b>，<b>第一點＝頂點</b>；可連續量，Esc 結束');
}
document.getElementById('btn-measure').addEventListener('click', () => startMeasure('dist'));
document.getElementById('btn-measure-angle').addEventListener('click', () => startMeasure('angle'));

function measureNote(text, at) {
  const el = document.createElement('div');
  el.className = 'm-note';
  el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.position.copy(at);
  measureGroup.add(obj);
}

function addMeasurePoint(pt) {
  measurePts.push(pt);
  if (!measureGroup) { measureGroup = new THREE.Group(); scene.add(measureGroup); }
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), nodeMat);
  dot.position.copy(pt);
  measureGroup.add(dot);

  if (measureMode === 'dist' && measurePts.length === 2) {
    const [a, b] = measurePts;
    measureGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), measureLineMat));
    const d = a.distanceTo(b);
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y), dz = Math.abs(a.z - b.z);
    measureNote(`${fmtLen(d)}（ΔE ${fmtLen(dx, false)}・ΔU ${fmtLen(dy, false)}・ΔN ${fmtLen(dz, false)}）`,
      a.clone().lerp(b, 0.5).add(new THREE.Vector3(0, 0.4, 0)));
    measurePts = [];
    setHint('量測完成。繼續點兩點量下一段，<b>空白鍵</b>重複、Esc 結束');
  } else if (measureMode === 'angle' && measurePts.length === 3) {
    const [v, a, b] = measurePts;   // v=頂點
    const u1 = a.clone().sub(v), u2 = b.clone().sub(v);
    const ang = u1.angleTo(u2) * 180 / Math.PI;
    measureGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([v, a]), measureLineMat));
    measureGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([v, b]), measureLineMat));
    // 弧：兩方向向量插值取樣（角度 <180° 適用）
    const r = Math.min(u1.length(), u2.length(), 3) * 0.5;
    const n1 = u1.clone().normalize(), n2 = u2.clone().normalize();
    const arc = [];
    for (let i = 0; i <= 20; i++) {
      const m = n1.clone().lerp(n2, i / 20).normalize().multiplyScalar(r);
      arc.push(v.clone().add(m));
    }
    measureGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc), measureLineMat));
    measureNote(`∠ ${ang.toFixed(1)}°`, v.clone().add(n1.clone().add(n2).normalize().multiplyScalar(r + 0.5)));
    measurePts = [];
    setHint('角度完成。繼續點三點量下一組（第一點＝頂點），Esc 結束');
  }
}

function clearMeasure() {
  measurePts = [];
  if (measureGroup) { scene.remove(measureGroup); measureGroup = null; }
}

// ------------------------------------------------------------ 3D 持久尺寸標註（E3D Draw Linear Dimension：sceneData.dims 持久化）
// 資料：sceneData.dims = [{ a:[x,y,z], b:[x,y,z] }]（公尺 canonical）。
// 群組由 dimensions.js 純函式重建；切單位（fmtLen 變）、載入場景、增刪皆重建。
let dimGroup = null;      // 目前的標註群（buildDimensions 產物）
let dimPts = [];          // 標註模式暫存的第一點

function rebuildDims() {
  if (dimGroup) {
    dimGroup.traverse((o) => {
      if (o.isCSS2DObject) { o.element.remove(); return; }   // 清 CSS2D DOM，防孤兒標籤
      o.geometry?.dispose();                                  // 釋放 GPU 資源，防切單位/增刪反覆重建洩漏
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
    });
    scene.remove(dimGroup);
    dimGroup = null;
  }
  dimGroup = buildDimensions(sceneData, THREE, fmtLen, CSS2DObject);
  scene.add(dimGroup);
}

function startDim() {
  if (mode === 'dim3d') { setMode('idle'); return; }
  setMode('dim3d');
  document.getElementById('btn-dim3d').classList.add('active');
  setHint('3D 標註：點<b>兩點</b>（設備表面或地面）建立持久尺寸；可連續標，Esc 結束');
}
document.getElementById('btn-dim3d').addEventListener('click', startDim);

// 標註模式點擊：收兩點→push 進 sceneData.dims→重建群組並存進場景資料
function addDimPoint(pt) {
  dimPts.push(pt.clone());
  if (dimPts.length === 2) {
    const [a, b] = dimPts;
    if (a.distanceTo(b) >= 1e-4) {
      pushUndo();
      sceneData.dims = sceneData.dims ?? [];
      sceneData.dims.push({
        a: [roundMM(a.x), roundMM(a.y), roundMM(a.z)],
        b: [roundMM(b.x), roundMM(b.y), roundMM(b.z)],
      });
      rebuildDims();
      setHint(`已建立標註 <b>${fmtLen(a.distanceTo(b))}</b>。繼續點兩點標下一段，Esc 結束`);
    }
    dimPts = [];
  } else {
    setHint('3D 標註：已收第一點，再點<b>第二點</b>完成；Esc 取消');
  }
}

// 右鍵刪除：傳入 pickObject 命中的 userData.dimIndex，移除該筆後重建
function deleteDim(dimIndex) {
  if (!sceneData.dims || dimIndex == null || dimIndex < 0 || dimIndex >= sceneData.dims.length) return;
  pushUndo();
  sceneData.dims.splice(dimIndex, 1);
  rebuildDims();
  setHint(`已刪除標註（剩 ${sceneData.dims.length} 筆）`);
}

// ------------------------------------------------------------ 剖切（Clip Box＋六平面，對標 E3D Clip and Cap）
// 六面法向朝內：+X 面 normal(-1,0,0) constant=max.x → 盒內保留
const clip = {
  mode: null,             // null | 'box' | 'six'
  box: new THREE.Box3(),
  planes: [],             // 6 THREE.Plane（±X ±Y ±Z 順序）
  enabled: [true, true, true, true, true, true],
  helper: null,
  handles: [],            // CSS2D 面手柄（box 模式）
};
const CLIP_AXES = [
  { n: new THREE.Vector3(1, 0, 0), side: 'min', axis: 'x' },   // -X 面（normal 朝 +X）
  { n: new THREE.Vector3(-1, 0, 0), side: 'max', axis: 'x' },  // +X 面
  { n: new THREE.Vector3(0, 1, 0), side: 'min', axis: 'y' },
  { n: new THREE.Vector3(0, -1, 0), side: 'max', axis: 'y' },
  { n: new THREE.Vector3(0, 0, 1), side: 'min', axis: 'z' },
  { n: new THREE.Vector3(0, 0, -1), side: 'max', axis: 'z' },
];

function clipRebuildPlanes() {
  clip.planes = CLIP_AXES.map(({ n, side, axis }) => {
    const v = clip.box[side][axis];
    // 平面式 n·p + c ≥ 0 保留：-X 面 c = -min.x；+X 面 c = max.x
    return new THREE.Plane(n.clone(), side === 'min' ? -v : v);
  });
  renderer.clippingPlanes = clip.mode
    ? clip.planes.filter((_, i) => clip.enabled[i])
    : [];
  clipCapUpdate();
}

function clipFaceCenter(i) {
  const c = clip.box.getCenter(new THREE.Vector3());
  const { side, axis } = CLIP_AXES[i];
  c[axis] = clip.box[side][axis];
  return c;
}

function clipShow() {
  clipClearVisuals();
  clip.helper = new THREE.Box3Helper(clip.box, 0x46c2e0);
  scene.add(clip.helper);
  if (clip.mode === 'box') {
    CLIP_AXES.forEach((cfg, i) => {
      const el = document.createElement('div');
      el.className = 'clip-handle';
      el.title = '拖曳沿法向調整剖切面';
      const obj = new CSS2DObject(el);
      obj.position.copy(clipFaceCenter(i));
      scene.add(obj);
      clip.handles.push(obj);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        const move = (ev) => {
          // 游標射線與「面中心＋法向軸線」最近點 → 新面位置
          setPointer(ev);
          raycaster.setFromCamera(pointer, camera);
          const P0 = clipFaceCenter(i);
          const n = CLIP_AXES[i].axis;
          const dirN = new THREE.Vector3();
          dirN[n] = 1;
          const O = raycaster.ray.origin, d = raycaster.ray.direction;
          const w = new THREE.Vector3().subVectors(O, P0);
          const b = dirN.dot(d);
          const denom = 1 - b * b;
          if (Math.abs(denom) < 1e-6) return;
          const s = (b * d.dot(w) - dirN.dot(w)) / denom;
          let v = P0[n] + s;
          if (snapOn) v = Math.round(v * 2) / 2;
          const { side, axis } = CLIP_AXES[i];
          const other = side === 'min' ? clip.box.max[axis] : clip.box.min[axis];
          clip.box[side][axis] = side === 'min' ? Math.min(v, other - 0.5) : Math.max(v, other + 0.5);
          clipRebuildPlanes();
          clip.handles.forEach((h, j) => h.position.copy(clipFaceCenter(j)));
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      });
    });
  }
}

function clipClearVisuals() {
  if (clip.helper) { scene.remove(clip.helper); clip.helper = null; }
  for (const h of clip.handles) scene.remove(h);
  clip.handles = [];
}

function clipStart(mode, box) {
  clip.mode = mode;
  clip.box.copy(box);
  clip.enabled = [true, true, true, true, true, true];
  clipRebuildPlanes();
  clipShow();
  if (mode === 'six') renderClipPanel();
  setHint(mode === 'box'
    ? '剖切盒啟用：拖曳<b>面手柄</b>調整範圍；VIEW > 清除 結束'
    : '六平面剖切啟用：右側屬性面板逐面開關/滑動；VIEW > 清除 結束');
}

function clipClear() {
  clip.mode = null;
  clipClearVisuals();
  clipCapUpdate();
  renderer.clippingPlanes = [];
  if (document.querySelector('.pg-clip')) renderPropEmpty();
  setHint('剖切已清除');
}

// 六平面情境面板（占用右側 Properties——E3D 情境編輯面板行為）
function renderClipPanel() {
  repaintPanel = renderClipPanel;
  const b = sceneBounds();
  document.getElementById('prop-title').textContent = '六平面剖切';
  const rows = CLIP_AXES.map((cfg, i) => {
    const { side, axis } = cfg;
    const lo = b.min[axis] - 2, hi = b.max[axis] + 2;
    const v = clip.box[side][axis];
    const name = `${side === 'min' ? '−' : '＋'}${axis.toUpperCase()}`;
    return `<label><input type="checkbox" data-ci="${i}" ${clip.enabled[i] ? 'checked' : ''}> ${name}</label>
      <div class="pg-v"><input type="range" data-cs="${i}" min="${toDisp(lo)}" max="${toDisp(hi)}" step="${U().step}" value="${toDisp(v)}"></div>`;
  }).join('');
  propBody.innerHTML = `<div class="pg-section pg-clip">Clip Planes</div>
    <div class="pg-grid">${rows}</div>
    <button class="pbtn" id="clip-panel-clear">清除剖切</button>`;
  propBody.querySelectorAll('[data-ci]').forEach((cb) => cb.addEventListener('change', () => {
    clip.enabled[+cb.dataset.ci] = cb.checked;
    clipRebuildPlanes();
  }));
  propBody.querySelectorAll('[data-cs]').forEach((sl) => sl.addEventListener('input', () => {
    const i = +sl.dataset.cs;
    const { side, axis } = CLIP_AXES[i];
    clip.box[side][axis] = fromDisp(sl.value);
    clipRebuildPlanes();
    clip.handles.forEach((h, j) => h.position.copy(clipFaceCenter(j)));
  }));
  document.getElementById('clip-panel-clear').addEventListener('click', clipClear);
}

document.getElementById('btn-clipbox').addEventListener('click', () =>
  clipStart('box', sceneBounds().expandByScalar(1)));
document.getElementById('btn-clipbox-sel').addEventListener('click', () => {
  let box;
  if (selected?.kind === 'eq') {
    box = new THREE.Box3().expandByObject(eqObjects.get(selected.def.tag).group).expandByScalar(1);
  } else if (selected?.kind === 'pipe') {
    box = new THREE.Box3();
    for (const p of sceneData.pipes[selected.index].pts) box.expandByPoint(new THREE.Vector3(...p));
    box.expandByScalar(1);
  } else box = sceneBounds().expandByScalar(1);
  clipStart('box', box);
});
document.getElementById('btn-clipsix').addEventListener('click', () =>
  clipStart('six', sceneBounds().expandByScalar(1)));
document.getElementById('btn-clipclear').addEventListener('click', clipClear);

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

// 場景慣例：+Z＝南（P&ID 地毯 v 軸向下），看向北＝相機在南側（+Z）朝 -Z
const VIEW_DIRS = {
  iso: new THREE.Vector3(1, 0.9, 1), top: new THREE.Vector3(0.001, 1, 0.001),
  bottom: new THREE.Vector3(0.001, -1, 0.001),
  n: new THREE.Vector3(0, 0.14, 1), s: new THREE.Vector3(0, 0.14, -1),
  e: new THREE.Vector3(-1, 0.14, 0), w: new THREE.Vector3(1, 0.14, 0),
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

// 捕捉切換 ＋ 吸附網格粒度（mm）＋ 顯示單位（mm/cm/m）
const snapBtn = document.getElementById('st-snap');
const snapSel = document.getElementById('st-snapstep');
const unitSel = document.getElementById('st-unit');
snapSel.innerHTML = SNAP_STEPS.map((s) => `<option value="${s}">${s}mm</option>`).join('');
snapSel.value = String(snapStepMm);
unitSel.value = dispUnit;
function updateSnapLabel() { snapBtn.textContent = snapOn ? `捕捉 ${snapStepMm}mm` : '捕捉 關'; }
function refreshPropPanel() {
  if (repaintPanel) { repaintPanel(); return; }
  if (selected?.kind === 'eq') renderPropPanel(selected.def);
  else if (selected?.kind === 'pipe') renderPipeProps(selected.index);
}
updateSnapLabel();
snapBtn.addEventListener('click', () => {
  snapOn = !snapOn;
  snapBtn.classList.toggle('on', snapOn);
  applySnapSettings();
  updateSnapLabel();
});
snapSel.addEventListener('change', () => {
  snapStepMm = +snapSel.value;
  localStorage.setItem('ej3d-snap-mm', String(snapStepMm));
  applySnapSettings();
  updateSnapLabel();
});
unitSel.addEventListener('change', () => {
  dispUnit = unitSel.value;
  localStorage.setItem('ej3d-disp-unit', dispUnit);
  refreshPropPanel();
  rebuildDims();   // 標註文字走 fmtLen，切單位需重建
});
applySnapSettings();

// ------------------------------------------------------------ 2D 圖框標題欄（GA/ISO 共用）
function dwgTitleBlock(right, bottom, meta) {
  // 三列制式標題欄：公司+專案 / 圖名 / 圖號·Rev·日期·比例
  const W = Math.min(460, right - 12), H = 64;
  const x = right - W, y = bottom - H;
  const c1 = x + W * 0.52, c2 = x + W * 0.68, c3 = x + W * 0.84;
  return `
  <g>
    <rect x="${x}" y="${y}" width="${W}" height="${H}" fill="#fff" stroke="#12283a" stroke-width="1.4"/>
    <line x1="${x}" y1="${y + 19}" x2="${x + W}" y2="${y + 19}" stroke="#12283a" stroke-width="0.8"/>
    <line x1="${x}" y1="${y + 42}" x2="${x + W}" y2="${y + 42}" stroke="#12283a" stroke-width="0.8"/>
    <line x1="${c1}" y1="${y + 42}" x2="${c1}" y2="${y + H}" stroke="#12283a" stroke-width="0.6"/>
    <line x1="${c2}" y1="${y + 42}" x2="${c2}" y2="${y + H}" stroke="#12283a" stroke-width="0.6"/>
    <line x1="${c3}" y1="${y + 42}" x2="${c3}" y2="${y + H}" stroke="#12283a" stroke-width="0.6"/>
    <text x="${x + 8}" y="${y + 13.5}" font-size="10" font-weight="700" fill="#12283a">J.S Process Intelligence｜J.S_3D Studio</text>
    <text x="${x + W - 8}" y="${y + 13.5}" font-size="9" fill="#5b6b7a" text-anchor="end">${meta.project}</text>
    <text x="${x + 8}" y="${y + 35.5}" font-size="12.5" font-weight="700" fill="#12283a">${meta.title}</text>
    <text x="${x + 8}" y="${y + 56}" font-size="9.5" fill="#12283a">圖號 ${meta.dwgno}</text>
    <text x="${c1 + 6}" y="${y + 56}" font-size="9.5" fill="#12283a">Rev ${meta.rev}</text>
    <text x="${c2 + 6}" y="${y + 56}" font-size="9.5" fill="#12283a">${meta.date}</text>
    <text x="${c3 + 6}" y="${y + 56}" font-size="9.5" fill="#12283a">${meta.scaleTxt}</text>
  </g>`;
}

// ------------------------------------------------------------ GA 出圖（俯視配置圖）
// 對標 E3D ADP Gridline Dimensioning：由設備分佈自動推結構格線位置（公尺 canonical）。
// 回傳 { ex:[E 座標…], nz:[N 座標…] }，皆為公尺、由小到大排序、無重複。
function gaGridAxes(b) {
  const MODULE = 5;                                   // 預設 5m 模組（依設備聚集取整）
  const snap = (v) => Math.round(v / MODULE) * MODULE;
  const collect = (vals) => [...new Set(vals.map(snap))].sort((a, x) => a - x);
  const eqs = allEquipment().filter((e) => !hiddenTags.has(e.tag));
  let ex = collect(eqs.map((e) => e.pos[0]));
  let nz = collect(eqs.map((e) => e.pos[2]));
  // 設備太少或聚集過密/過疏 → 退回沿場界均勻 5m 格線，保證圖面有可讀格網
  const uniform = (lo, hi) => {
    const a = [];
    for (let g = Math.floor(lo / MODULE) * MODULE; g <= hi + 1e-6; g += MODULE) a.push(g);
    return a;
  };
  if (ex.length < 2 || ex.length > 12) ex = uniform(b.min.x, b.max.x);
  if (nz.length < 2 || nz.length > 12) nz = uniform(b.min.z, b.max.z);
  return { ex, nz };
}

// 結構格線層：縱線 1/2/3…（沿 E）、橫線 A/B/C…（沿 N），端點畫圈標號（A-1 式）。
// sx/sz：公尺→SVG px 映射（沿用 gaSvg 慣例）；drawTop/drawBottom/drawLeft/drawRight：繪圖區 px 邊界。
function gaGridlineParts(axes, sx, sz, drawTop, drawBottom, drawLeft, drawRight) {
  const parts = [];
  const R = 9;                                         // 端點圈半徑 px
  const off = 16;                                      // 圈心離繪圖邊的 px 距離
  const colNum = (i) => String(i + 1);                 // 縱線編號 1,2,3…
  const rowLtr = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');
  // 縱向格線（沿 E，垂直線）＋上下端圈號（數字）
  axes.ex.forEach((e, i) => {
    const x = +sx(e);
    parts.push(`<line x1="${x}" y1="${drawTop}" x2="${x}" y2="${drawBottom}" stroke="#274b66" stroke-width="0.7" stroke-dasharray="10 4 2 4" opacity="0.55"/>`);
    for (const cy of [drawTop - off, drawBottom + off]) {
      parts.push(`<circle cx="${x}" cy="${cy}" r="${R}" fill="#fff" stroke="#274b66" stroke-width="1.2"/>`);
      parts.push(`<text x="${x}" y="${(cy + 3.2).toFixed(1)}" font-size="9.5" font-weight="700" fill="#12283a" text-anchor="middle">${colNum(i)}</text>`);
    }
  });
  // 橫向格線（沿 N，水平線）＋左右端圈號（字母）
  axes.nz.forEach((n, i) => {
    const y = +sz(n);
    parts.push(`<line x1="${drawLeft}" y1="${y}" x2="${drawRight}" y2="${y}" stroke="#274b66" stroke-width="0.7" stroke-dasharray="10 4 2 4" opacity="0.55"/>`);
    for (const cx of [drawLeft - off, drawRight + off]) {
      parts.push(`<circle cx="${cx}" cy="${y}" r="${R}" fill="#fff" stroke="#274b66" stroke-width="1.2"/>`);
      parts.push(`<text x="${cx}" y="${(y + 3.2).toFixed(1)}" font-size="9.5" font-weight="700" fill="#12283a" text-anchor="middle">${rowLtr(i)}</text>`);
    }
  });
  return parts;
}

// 尺寸標註鏈：沿圖框上緣標各縱格線間距、沿左緣標各橫格線間距（mm，沿用出圖層 ×1000 慣例）；
// 並標主要設備中心→最近格線的距離。tickLen=延伸線長 px。
function gaDimChainParts(axes, sx, sz, chainTop, chainLeft) {
  const parts = [];
  const BLUE = '#046AFB';                              // 沿用出圖層 mm 標註色
  const mm = (m) => (m * 1000).toFixed(0);            // 公尺→mm 字串（出圖層慣例）
  // 上緣：縱格線間距鏈（水平量測）
  if (axes.ex.length >= 2) {
    const y = chainTop;
    const xs = axes.ex.map((e) => +sx(e));
    parts.push(`<line x1="${xs[0]}" y1="${y}" x2="${xs[xs.length - 1]}" y2="${y}" stroke="${BLUE}" stroke-width="0.8"/>`);
    xs.forEach((x) => parts.push(`<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}" stroke="${BLUE}" stroke-width="0.8"/>`));
    for (let i = 0; i < axes.ex.length - 1; i++) {
      const mx = (xs[i] + xs[i + 1]) / 2;
      parts.push(`<text x="${mx.toFixed(1)}" y="${y - 5}" font-size="9.5" fill="${BLUE}" text-anchor="middle" font-weight="600">${mm(axes.ex[i + 1] - axes.ex[i])}</text>`);
    }
  }
  // 左緣：橫格線間距鏈（垂直量測，文字旋轉 -90°）
  if (axes.nz.length >= 2) {
    const x = chainLeft;
    const ys = axes.nz.map((n) => +sz(n));
    parts.push(`<line x1="${x}" y1="${ys[0]}" x2="${x}" y2="${ys[ys.length - 1]}" stroke="${BLUE}" stroke-width="0.8"/>`);
    ys.forEach((y) => parts.push(`<line x1="${x - 4}" y1="${y}" x2="${x + 4}" y2="${y}" stroke="${BLUE}" stroke-width="0.8"/>`));
    for (let i = 0; i < axes.nz.length - 1; i++) {
      const my = (ys[i] + ys[i + 1]) / 2;
      parts.push(`<text x="${(x - 5).toFixed(1)}" y="${my.toFixed(1)}" font-size="9.5" fill="${BLUE}" text-anchor="middle" font-weight="600" transform="rotate(-90 ${(x - 5).toFixed(1)} ${my.toFixed(1)})">${mm(axes.nz[i + 1] - axes.nz[i])}</text>`);
    }
  }
  // 主要設備中心→最近格線偏置（E 向對最近縱線、N 向對最近橫線），只標非零偏置避免雜訊
  const nearest = (arr, v) => arr.reduce((a, x) => Math.abs(x - v) < Math.abs(a - v) ? x : a, arr[0]);
  for (const eq of allEquipment()) {
    if (hiddenTags.has(eq.tag)) continue;
    const [ecx, , ecz] = eq.pos;
    const cx = +sx(ecx), cy = +sz(ecz);
    if (axes.ex.length) {
      const g = nearest(axes.ex, ecx), dm = ecx - g;
      if (Math.abs(dm) >= 0.05) {                      // ≥50mm 才標
        const gx = +sx(g);
        parts.push(`<line x1="${gx}" y1="${cy}" x2="${cx}" y2="${cy}" stroke="${BLUE}" stroke-width="0.6" stroke-dasharray="3 2" opacity="0.85"/>`);
        parts.push(`<text x="${((gx + cx) / 2).toFixed(1)}" y="${(cy - 2).toFixed(1)}" font-size="8" fill="${BLUE}" text-anchor="middle">${mm(Math.abs(dm))}</text>`);
      }
    }
    if (axes.nz.length) {
      const g = nearest(axes.nz, ecz), dm = ecz - g;
      if (Math.abs(dm) >= 0.05) {
        const gy = +sz(g);
        parts.push(`<line x1="${cx}" y1="${gy}" x2="${cx}" y2="${cy}" stroke="${BLUE}" stroke-width="0.6" stroke-dasharray="3 2" opacity="0.85"/>`);
        parts.push(`<text x="${(cx + 3).toFixed(1)}" y="${((gy + cy) / 2).toFixed(1)}" font-size="8" fill="${BLUE}">${mm(Math.abs(dm))}</text>`);
      }
    }
  }
  return parts;
}

function gaSvg(meta = {}) {
  const b = sceneBounds();
  const pad = 6;
  const x0 = b.min.x - pad, z0 = b.min.z - pad;
  const W = (b.max.x - b.min.x) + pad * 2;
  const H = (b.max.z - b.min.z) + pad * 2;
  const S = 12;  // px per m
  const sx = (x) => ((x - x0) * S).toFixed(1);
  const sz = (z) => ((z - z0) * S).toFixed(1);
  const parts = [];
  // 10m 網格
  for (let gx = Math.ceil(x0 / 10) * 10; gx <= x0 + W; gx += 10) {
    parts.push(`<line x1="${sx(gx)}" y1="0" x2="${sx(gx)}" y2="${H * S}" stroke="#d8dde3" stroke-width="0.6"/>`);
    parts.push(`<text x="${sx(gx)}" y="12" font-size="9" fill="#9aa4ad" text-anchor="middle">E${gx.toFixed(0)}</text>`);
  }
  for (let gz = Math.ceil(z0 / 10) * 10; gz <= z0 + H; gz += 10) {
    parts.push(`<line x1="0" y1="${sz(gz)}" x2="${W * S}" y2="${sz(gz)}" stroke="#d8dde3" stroke-width="0.6"/>`);
    parts.push(`<text x="4" y="${sz(gz)}" font-size="9" fill="#9aa4ad">N${gz.toFixed(0)}</text>`);
  }
  // 管線（橋接虛線）
  for (const pipe of sceneData.pipes) {
    const d = pipe.pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0])} ${sz(p[2])}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="#5b6b7a" stroke-width="${Math.max(pipe.r * S * 0.8, 1)}"${pipe.bridge ? ' stroke-dasharray="6 4" stroke="#2e8ba8"' : ''} opacity="0.75"/>`);
  }
  // 設備投影（圓/矩形＋位號）
  for (const eq of allEquipment()) {
    if (hiddenTags.has(eq.tag)) continue;
    const [ex, , ez] = eq.pos;
    const dims = eq.dims ?? {};
    if (dims.r !== undefined && dims.len === undefined) {
      parts.push(`<circle cx="${sx(ex)}" cy="${sz(ez)}" r="${(dims.r * S).toFixed(1)}" fill="rgba(70,140,200,0.12)" stroke="#274b66" stroke-width="1.2"/>`);
    } else {
      const w = dims.len ?? dims.w ?? 2, dd = dims.d ?? (dims.r ? dims.r * 2 : 2);
      const deg = -((eq.rot_y ?? 0) * 180 / Math.PI);
      parts.push(`<rect x="${((ex - x0 - w / 2) * S).toFixed(1)}" y="${((ez - z0 - dd / 2) * S).toFixed(1)}" width="${(w * S).toFixed(1)}" height="${(dd * S).toFixed(1)}" fill="rgba(70,140,200,0.12)" stroke="#274b66" stroke-width="1.2" transform="rotate(${deg.toFixed(1)} ${sx(ex)} ${sz(ez)})"/>`);
    }
    parts.push(`<text x="${sx(ex)}" y="${(parseFloat(sz(ez)) - (dims.r ? dims.r * S : 8) - 4).toFixed(1)}" font-size="10" font-weight="600" fill="#12283a" text-anchor="middle">${eq.tag}</text>`);
  }
  // 結構格線 + 尺寸標註鏈（對標 E3D ADP Gridline Dimensioning）
  // 繪圖區 px 範圍：設備投影落在 [0, W*S]×[0, H*S]（x0/z0 已含 pad=6m 邊界）
  const axes = gaGridAxes(b);
  const drawTop = 0, drawBottom = H * S, drawLeft = 0, drawRight = W * S;
  parts.push(...gaGridlineParts(axes, sx, sz, drawTop, drawBottom, drawLeft, drawRight));
  // 尺寸鏈畫在格線圈之外（上緣圈 off=16 + R=9，鏈再外推）
  parts.push(...gaDimChainParts(axes, sx, sz, drawTop - 32, drawLeft - 32));
  // 圖框（雙線）＋制式標題欄＋比例尺
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  // 為格線端圈＋尺寸鏈預留邊距（px）：內容整體平移 MARGIN，頁面對應加大
  const MARGIN = 52;
  const PW = W * S + MARGIN * 2, PH = H * S + MARGIN * 2 + 78;
  const tb = dwgTitleBlock(PW - 7, PH - 7, {
    project: `設備 ${allEquipment().length}・管線 ${sceneData.pipes.length}${meta.by ? ' · ' + meta.by : ''}`,
    title: meta.title ?? `${sceneData.plant.name}｜GENERAL ARRANGEMENT 配置圖`,
    dwgno: meta.dwgno ?? `${(sceneId ?? 'SCN').toUpperCase()}-GA-001`,
    rev: meta.rev ?? 'A', date: dateStr, scaleTxt: `1m=${S}px`,
  });
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PW} ${PH}" font-family="Inter,'Noto Sans TC',sans-serif" style="background:#fff">
  <rect x="1" y="1" width="${PW - 2}" height="${PH - 2}" fill="#fdfefe" stroke="#12283a" stroke-width="1.8"/>
  <rect x="7" y="7" width="${PW - 14}" height="${PH - 14}" fill="none" stroke="#12283a" stroke-width="0.7"/>
  <g transform="translate(${MARGIN} ${MARGIN})" clip-path="none">
  ${parts.join('\n  ')}
  </g>
  <g transform="translate(16 ${PH - 24})">
    <line x1="0" y1="0" x2="${10 * S}" y2="0" stroke="#12283a" stroke-width="3"/>
    <text x="${5 * S}" y="-5" font-size="9" fill="#12283a" text-anchor="middle">10 m</text>
  </g>
  ${tb}
</svg>`;
  return svg;
}
function gaDefaults() {
  return { title: `${sceneData.plant.name}｜GENERAL ARRANGEMENT 配置圖`,
           dwgno: `${(sceneId ?? 'SCN').toUpperCase()}-GA-001`, rev: 'A', by: dwgLastBy };
}
function exportGA() {
  openDwgDialog('GA', gaDefaults(), (m) => {
    saveBlob(`${sceneId ?? 'scene'}-GA.svg`, gaSvg(m), 'image/svg+xml', true);
    setHint('GA 配置圖已輸出（新分頁預覽＋下載 SVG）');
  });
}
document.getElementById('btn-ga').addEventListener('click', exportGA);

// ------------------------------------------------------------ Spec/Bore 選單（E3D spec-driven routing）
{
  const specSel = document.getElementById('pipe-spec');
  const boreSel = document.getElementById('pipe-bore');
  specSel.innerHTML = PIPE_SPECS.map((sp) => `<option value="${sp.code}">${sp.code}｜${sp.name}</option>`).join('');
  boreSel.innerHTML = PIPE_BORES.map((b) => `<option value="${b.dn}" ${b.dn === 'DN100' ? 'selected' : ''}>${b.dn}</option>`).join('');
}

// ------------------------------------------------------------ ISO 等角單管圖（對標 E3D Isometric 交付，輕量版）
function isoSvg(idx, meta = {}) {
  const pipe = sceneData.pipes[idx];
  if ((pipe?.pts?.length ?? 0) < 2) {   // 退化管線（<2 節點）→ 佔位圖，避免 Infinity viewBox
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80" style="background:#fff"><rect x="1" y="1" width="318" height="78" fill="none" stroke="#12283a"/><text x="14" y="46" font-size="13" fill="#12283a">管線 #${idx + 1}：節點不足，無法產生 ISO</text></svg>`;
  }
  const pts = pipe.pts;
  // 等角投影：X=東、Z=北、Y=上（30° 軸測）
  const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
  const proj = (w) => [(w[0] - w[2]) * c30, (w[0] + w[2]) * s30 - w[1]];
  const P = pts.map(proj);
  const xs = P.map((q) => q[0]), ys = P.map((q) => q[1]);
  const pad = 2.5, S = 26;
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  const W = Math.max((Math.max(...xs) - x0 + pad) * S, 560);
  const H = (Math.max(...ys) - y0 + pad) * S + 128;
  const px = (q) => ((q[0] - x0) * S).toFixed(1);
  const py = (q) => ((q[1] - y0) * S).toFixed(1);
  const parts = [];
  const dPath = P.map((q, i) => `${i ? 'L' : 'M'}${px(q)} ${py(q)}`).join(' ');
  parts.push(`<path d="${dPath}" fill="none" stroke="#12283a" stroke-width="3.4" stroke-linejoin="round"/>`);
  parts.push(`<path d="${dPath}" fill="none" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>`);
  const bom = [];
  for (let i = 0; i < pts.length; i++) {
    parts.push(`<circle cx="${px(P[i])}" cy="${py(P[i])}" r="2.5" fill="#12283a"/>`);
    if (i < pts.length - 1) {
      const seg = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]);
      const mx = (+px(P[i]) + +px(P[i + 1])) / 2, my = (+py(P[i]) + +py(P[i + 1])) / 2;
      parts.push(`<text x="${mx}" y="${my - 7}" font-size="11" fill="#046AFB" text-anchor="middle" font-weight="600">${(seg * 1000).toFixed(0)}</text>`);
      bom.push(`直管段 ${(seg * 1000).toFixed(0)}mm`);
    }
  }
  // 節點高程標註（ISO 慣例 EL.）
  for (let i = 0; i < pts.length; i++) {
    parts.push(`<text x="${+px(P[i]) + 6}" y="${+py(P[i]) + 12}" font-size="9" fill="#5b6b7a">EL.${(pts[i][1] * 1000).toFixed(0)}</text>`);
  }
  // 元件符號：沿弧長定位（閥=蝶結、法蘭=雙短線、異徑=三角）
  const compName = Object.fromEntries(PIPE_COMPONENTS.map((c) => [c.kind, c.name]));
  for (const c of pipe.components ?? []) {
    let acc = 0, q = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const seg = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]);
      if (acc + seg >= c.at || i === pts.length - 2) {
        const t = Math.max(0, Math.min(1, (c.at - acc) / Math.max(seg, 1e-6)));
        q = proj(pts[i].map((v, k) => v + (pts[i + 1][k] - v) * t));
        break;
      }
      acc += seg;
    }
    if (!q) continue;
    const cx = +((q[0] - x0) * S).toFixed(1), cy = +((q[1] - y0) * S).toFixed(1);
    if (c.kind === 'flangepair') {
      parts.push(`<path d="M${cx - 4} ${cy - 6} v12 M${cx + 4} ${cy - 6} v12" stroke="#12283a" stroke-width="2"/>`);
    } else if (c.kind === 'reducer') {
      parts.push(`<path d="M${cx - 6} ${cy - 6} L${cx + 6} ${cy} L${cx - 6} ${cy + 6} Z" fill="#fff" stroke="#12283a" stroke-width="1.4"/>`);
    } else {
      parts.push(`<path d="M${cx - 7} ${cy - 5} L${cx + 7} ${cy + 5} L${cx + 7} ${cy - 5} L${cx - 7} ${cy + 5} Z" fill="#fff" stroke="#12283a" stroke-width="1.4"/>`);
    }
    parts.push(`<text x="${cx}" y="${cy + 18}" font-size="9.5" fill="#5b6b7a" text-anchor="middle">${compName[c.kind] ?? c.kind}</text>`);
    bom.push(`${compName[c.kind] ?? c.kind}（沿管 ${(c.at * 1000).toFixed(0)}mm）`);
  }
  // 北向標記（等角：北=右上）
  parts.push(`<g transform="translate(${W - 58} 26)"><path d="M0 14 L10 -4 L20 14" fill="none" stroke="#12283a" stroke-width="1.6"/><text x="10" y="27" font-size="10" text-anchor="middle" fill="#12283a" font-weight="700">N</text></g>`);
  const bomRows = bom.slice(0, 6).map((b, i) => `<text x="14" y="${H - 74 + i * 12}" font-size="9.5" fill="#12283a">${i + 1}. ${b}</text>`).join('');
  const more = bom.length > 6 ? `<text x="14" y="${H - 74 + 6 * 12}" font-size="9.5" fill="#5b6b7a">…共 ${bom.length} 項</text>` : '';
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const PH = H + 78;
  const tb = dwgTitleBlock(W - 7, PH - 7, {
    project: `${sceneData.plant?.name ?? sceneId ?? ''}${meta.by ? ' · ' + meta.by : ''}`,
    title: meta.title ?? `ISOMETRIC 單管圖｜管線 #${idx + 1}`,
    dwgno: meta.dwgno ?? `${(sceneId ?? 'SCN').toUpperCase()}-ISO-${String(idx + 1).padStart(3, '0')}`,
    rev: meta.rev ?? 'A', date: dateStr,
    scaleTxt: `${pipe.dn ?? `⌀${Math.round(pipe.r * 2000)}mm`}｜${(pipeLength(pipe) * 1000).toFixed(0)}mm`,
  });
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${PH}" font-family="Inter,'Noto Sans TC',sans-serif" style="background:#fff">
  <rect x="1" y="1" width="${W - 2}" height="${PH - 2}" fill="#fdfefe" stroke="#12283a" stroke-width="1.8"/>
  <rect x="7" y="7" width="${W - 14}" height="${PH - 14}" fill="none" stroke="#12283a" stroke-width="0.7"/>
  ${parts.join('\n  ')}
  <g>
    <line x1="7" y1="${H - 110}" x2="${W - 7}" y2="${H - 110}" stroke="#12283a" stroke-width="1"/>
    <text x="14" y="${H - 90}" font-size="12" font-weight="700" fill="#12283a">元件表 BOM</text>
    ${bomRows}${more}
    <text x="${W - 12}" y="${H - 90}" font-size="10" fill="#5b6b7a" text-anchor="end">Spec ${pipe.spec ?? '—'}｜${pipe.dn ?? `⌀${Math.round(pipe.r * 2000)}mm`}｜總長 ${(pipeLength(pipe) * 1000).toFixed(0)} mm｜尺寸 mm／高程 EL.mm</text>
  </g>
  ${tb}
</svg>`;
  return svg;
}
function isoDefaults(idx) {
  return { title: `ISOMETRIC 單管圖｜管線 #${idx + 1}`,
           dwgno: `${(sceneId ?? 'SCN').toUpperCase()}-ISO-${String(idx + 1).padStart(3, '0')}`, rev: 'A', by: dwgLastBy };
}
function exportISO() {
  if (selected?.kind !== 'pipe') { setHint('先選取一條管線再<b>出 ISO</b>'); return; }
  const idx = selected.index;
  openDwgDialog('ISO', isoDefaults(idx), (m) => {
    saveBlob(`${sceneId ?? 'scene'}-pipe${idx + 1}-ISO.svg`, isoSvg(idx, m), 'image/svg+xml', true);
    setHint('ISO 單管圖已輸出（新分頁預覽＋下載 SVG）');
  });
}
document.getElementById('btn-iso').addEventListener('click', exportISO);

// ------------------------------------------------------------ 管線清單（Pipe List，對標 E3D Pipe List 報表）
function renderPipeListPanel() {
  repaintPanel = renderPipeListPanel;
  document.getElementById('prop-title').textContent = `管線清單（${sceneData.pipes.length}）`;
  const rows = sceneData.pipes.map((p, i) => {
    const dn = p.dn ?? `⌀${Math.round(p.r * 2000)}mm`;
    const wall = pipeWall(p.dn, p.sched ?? 'STD');
    const bore = wall != null ? `｜bore ${Math.round((p.r * 2 - 2 * wall) * 1000)}mm` : '';
    return `<div data-pl="${i}" style="display:flex;gap:8px;padding:6px 4px;border-bottom:1px solid var(--bdr);cursor:pointer;font-size:12px">
      <span style="width:56px;color:var(--accent);font-weight:600">PIPE ${i + 1}</span>
      <span style="flex:1">${p.spec ?? '—'}｜${dn}${p.sched ? ' Sch' + p.sched : ''}${bore}</span>
      <span style="color:var(--dim);white-space:nowrap">${fmtLen(pipeLength(p))}</span>
    </div>`;
  }).join('');
  const totalL = sceneData.pipes.reduce((a, p) => a + pipeLength(p), 0);
  propBody.innerHTML = `<div class="pg-section">Pipe List</div>
    ${sceneData.pipes.length
      ? rows + `<div style="display:flex;gap:8px;padding:8px 4px;font-size:12px;font-weight:600"><span style="flex:1">合計 ${sceneData.pipes.length} 條</span><span>${fmtLen(totalL)}</span></div>`
      : '<div style="color:var(--dim);font-size:12px;padding:8px 0">尚無管線——切到 PIPING 繪製</div>'}`;
  propBody.querySelectorAll('[data-pl]').forEach((row) => row.addEventListener('click', () => {
    selectPipe(+row.dataset.pl);
    zoomToSelection();
  }));
}
document.getElementById('btn-pipelist').addEventListener('click', renderPipeListPanel);

// ------------------------------------------------------------ 服務別圖例／篩選（對標 E3D 依 service 著色圖例）
// 各服務色塊＋名稱＋管線數量；點列切換該服務別管線顯示/隱藏（filter，走 applyLayers）。
// repaintPanel 設為自身，切單位/重繪時保持面板。純 UI 狀態（hiddenServices），不入存檔。
const hex6 = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
function renderServiceLegend() {
  repaintPanel = renderServiceLegend;
  document.getElementById('prop-title').textContent = '服務別圖例';
  // 逐服務別統計管線數（僅計非風管管線）
  const counts = {};
  let noneCount = 0;
  for (const p of sceneData.pipes) {
    if (p.profile === 'duct') continue;
    if (p.service && SERVICE_BY_CODE[p.service]) counts[p.service] = (counts[p.service] ?? 0) + 1;
    else noneCount++;
  }
  const legendRow = (key, name, colorInt, n) => {
    const hidden = hiddenServices.has(key);
    return `<div data-svc="${key}" title="點擊切換顯示/隱藏" style="display:flex;gap:8px;align-items:center;padding:6px 4px;border-bottom:1px solid var(--bdr);cursor:pointer;font-size:12px;opacity:${hidden ? 0.42 : 1}">
      <span style="width:16px;height:16px;border-radius:3px;flex:none;background:${hex6(colorInt)};border:1px solid rgba(0,0,0,.25)"></span>
      <span style="flex:1">${name}</span>
      <span style="color:var(--dim);white-space:nowrap">${n} 條${hidden ? '｜隱藏' : ''}</span>
    </div>`;
  };
  const rows = PIPE_SERVICES.map((sv) => legendRow(sv.code, sv.name, sv.color, counts[sv.code] ?? 0)).join('')
    + legendRow('__none__', '（無服務別）＝Spec 色', 0x646f7b, noneCount);
  propBody.innerHTML = `<div class="pg-section">Service 服務別著色</div>
    <div style="color:var(--dim);font-size:11px;padding:2px 0 6px">點色塊列切換該服務別管線顯示／隱藏</div>
    ${rows}
    <button class="pbtn" id="svc-showall" style="margin-top:8px">全部顯示</button>`;
  propBody.querySelectorAll('[data-svc]').forEach((row) => row.addEventListener('click', () => {
    const key = row.dataset.svc;
    if (hiddenServices.has(key)) hiddenServices.delete(key); else hiddenServices.add(key);
    applyLayers();          // 套用可見性（不重建幾何，僅切 group.visible）
    renderServiceLegend();  // 重繪圖例列狀態
  }));
  document.getElementById('svc-showall').addEventListener('click', () => {
    hiddenServices.clear();
    applyLayers();
    renderServiceLegend();
  });
}
document.getElementById('btn-service-legend')?.addEventListener('click', renderServiceLegend);

// ------------------------------------------------------------ 重量與重心（Weight & CoG）報表
// 對標 E3D PROPCON：逐設備估質量→彙總全場總重＋重心。長度用 fmtLen 隨單位切換重繪。
function renderWeightPanel() {
  repaintPanel = renderWeightPanel;
  const rep = computeWeights(sceneData, eqObjects);
  document.getElementById('prop-title').textContent = `重量與重心（${rep.count}）`;
  const kg = (v) => (v >= 1000 ? (v / 1000).toFixed(2) + ' t' : Math.round(v) + ' kg');
  const rows = rep.items
    .slice()
    .sort((a, b) => b.mass_kg - a.mass_kg)
    .map((it) => `<div data-wt="${it.tag}" style="display:flex;gap:8px;padding:6px 4px;border-bottom:1px solid var(--bdr);cursor:pointer;font-size:12px">
      <span style="width:70px;color:var(--accent);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.tag}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${it.name}${it.method !== 'solid' ? '｜' + it.methodLabel : ''}</span>
      <span style="color:var(--dim);white-space:nowrap">${kg(it.mass_kg)}</span>
    </div>`).join('');
  const tt = rep.total_kg;
  const cog = rep.cog;
  propBody.innerHTML = `<div class="pg-section">Weight & CoG</div>
    ${rep.count
      ? rows
        + `<div style="display:flex;gap:8px;padding:8px 4px;font-size:12px;font-weight:600;border-top:2px solid var(--bdr)">
            <span style="flex:1">設備總重 ${rep.count} 台</span>
            <span>${Math.round(tt).toLocaleString()} kg</span>
          </div>
          <div style="display:flex;gap:8px;padding:2px 4px;font-size:12px;color:var(--accent);font-weight:600">
            <span style="flex:1"></span><span>${(tt / 1000).toFixed(2)} tonne</span>
          </div>`
        + (rep.pipe_kg > 0.5
          ? `<div style="display:flex;gap:8px;padding:2px 4px;font-size:12px;color:var(--dim)"><span style="flex:1">管線估重（另計）</span><span>${kg(rep.pipe_kg)}</span></div>` : '')
        + `<div class="pg-section" style="margin-top:8px">重心 CoG（設備）</div>
          <div class="pg-grid">
            ${pgRow(`東 E (${unitLabel()})`, `<span>${fmtLen(cog[0])}</span>`)}
            ${pgRow(`上 U (${unitLabel()})`, `<span>${fmtLen(cog[1])}</span>`)}
            ${pgRow(`北 N (${unitLabel()})`, `<span>${fmtLen(cog[2])}</span>`)}
          </div>
          <div style="padding:8px 4px 2px"><button class="rbtn" id="btn-weight-csv" style="width:100%"><span class="ric" data-ic="mto"></span>匯出重量表 CSV</button></div>
          <div style="font-size:11px;color:var(--dim);padding:8px 4px;line-height:1.5">估算法：${rep.method}</div>`
      : '<div style="color:var(--dim);font-size:12px;padding:8px 0">尚無設備——先在設備 tab 佈設</div>'}`;
  propBody.querySelectorAll('[data-wt]').forEach((row) => row.addEventListener('click', () => {
    const entry = eqObjects.get(row.dataset.wt);
    if (entry) { selectEquipment(row.dataset.wt); zoomToSelection(); }
  }));
  const csvBtn = document.getElementById('btn-weight-csv');
  if (csvBtn) csvBtn.addEventListener('click', () => exportWeightCsv(rep));
}
function exportWeightCsv(rep) {
  const r = rep ?? computeWeights(sceneData, eqObjects);
  const esc = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = [];
  rows.push(['J.S_3D Studio 重量與重心報表（Weight & CoG）', sceneData.plant?.name ?? sceneId ?? '']);
  rows.push(['輸出時間', new Date().toLocaleString('zh-TW', { hour12: false })]);
  rows.push(['估算法', r.method]);
  rows.push([]);
  rows.push(['位號', '名稱', '類型', '材料', '估法', '質量(kg)', '重心 X(m)', '重心 Y(m)', '重心 Z(m)']);
  for (const it of r.items) {
    rows.push([it.tag, it.name, it.type, it.material, it.methodLabel ?? (it.shell ? '薄殼' : '實心'),
      it.mass_kg.toFixed(1), it.cog[0].toFixed(3), it.cog[1].toFixed(3), it.cog[2].toFixed(3)]);
  }
  rows.push([]);
  rows.push(['[彙總]']);
  rows.push(['設備總重(kg)', r.total_kg.toFixed(1), '設備總重(tonne)', (r.total_kg / 1000).toFixed(3)]);
  rows.push(['管線估重(kg)', r.pipe_kg.toFixed(1)]);
  rows.push(['總重含管線(kg)', r.grand_total_kg.toFixed(1)]);
  rows.push(['全場重心 CoG(m)', r.cog[0].toFixed(3), r.cog[1].toFixed(3), r.cog[2].toFixed(3)]);
  const csv = '﻿' + rows.map((row) => row.map(esc).join(',')).join('\r\n');
  saveBlob(`${sceneId ?? 'scene'}-Weight.csv`, csv, 'text/csv;charset=utf-8', false);
  setHint(`重量表已輸出：設備 ${r.count} 台、總重 ${(r.total_kg / 1000).toFixed(2)} t（CSV）`);
}
document.getElementById('btn-weight').addEventListener('click', renderWeightPanel);

// ------------------------------------------------------------ 剖面蓋色（Clip and Cap）
let capOn = false;
let capMeshes = [];
const capMat = new THREE.MeshBasicMaterial({
  color: 0x046AFB, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false,
});
function clipCapUpdate() {
  for (const m of capMeshes) { scene.remove(m); m.geometry.dispose(); }
  capMeshes = [];
  if (!capOn || !clip.mode) return;
  const size = clip.box.getSize(new THREE.Vector3());
  const c = clip.box.getCenter(new THREE.Vector3());
  CLIP_AXES.forEach((cfg, i) => {
    if (!clip.enabled[i]) return;
    const { axis, side, n } = cfg;
    // 貼面往盒內縮 1cm，避免被自身剖切平面裁掉
    const v = clip.box[side][axis] + n[axis] * 0.01;
    let dims, pos, rot;
    if (axis === 'x') { dims = [size.z, size.y]; pos = [v, c.y, c.z]; rot = [0, Math.PI / 2, 0]; }
    else if (axis === 'y') { dims = [size.x, size.z]; pos = [c.x, v, c.z]; rot = [Math.PI / 2, 0, 0]; }
    else { dims = [size.x, size.y]; pos = [c.x, c.y, v]; rot = [0, 0, 0]; }
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(dims[0], 0.1), Math.max(dims[1], 0.1)), capMat);
    quad.position.set(...pos);
    quad.rotation.set(...rot);
    scene.add(quad);
    capMeshes.push(quad);
  });
}
document.getElementById('btn-clipcap').addEventListener('click', (e) => {
  capOn = !capOn;
  e.currentTarget.classList.toggle('active', capOn);
  if (capOn && !clip.mode) setHint('蓋面已開啟——先啟用<b>剖切盒</b>或<b>六平面</b>即會顯示切面填色');
  clipCapUpdate();
});

// ------------------------------------------------------------ 圖層顯示切換（檢視 tab）
for (const [btnId, key] of [['btn-lay-eq', 'equip'], ['btn-lay-pipe', 'pipe'], ['btn-lay-struct', 'struct'], ['btn-lay-elec', 'elec'], ['btn-lay-hvac', 'hvac']]) {
  document.getElementById(btnId).addEventListener('click', (e) => {
    LAYERS[key] = !LAYERS[key];
    e.currentTarget.classList.toggle('active', LAYERS[key]);
    applyLayers();
  });
}

// ------------------------------------------------------------ MTO 材料表（CSV：管線＋彙總＋設備）
function mtoCsv() {
  const typeName = new Map(ASSET_CATEGORIES.flatMap((c) => c.items.map((it) => [it.type, it.name])));
  const compName = Object.fromEntries(PIPE_COMPONENTS.map((c) => [c.kind, c.name]));
  const esc = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const rows = [];
  rows.push(['J.S_3D Studio 材料表（MTO）', sceneData.plant?.name ?? sceneId ?? '']);
  rows.push(['輸出時間', new Date().toLocaleString('zh-TW', { hour12: false })]);
  rows.push([]);
  rows.push(['[管線]']);
  rows.push(['編號', 'Spec', '口徑', '長度(m)', '元件']);
  const sums = new Map();
  sceneData.pipes.forEach((p, i) => {
    const L = pipeLength(p);
    const dn = p.dn ?? `r${p.r}`;
    const comps = (p.components ?? []).map((c) => `${compName[c.kind] ?? c.kind}@${c.at.toFixed(2)}m`).join('; ');
    rows.push([`PIPE-${i + 1}`, p.spec ?? '—', dn, L.toFixed(2), comps]);
    const k = `${p.spec ?? '—'}|${dn}`;
    const acc = sums.get(k) ?? { L: 0, n: 0 };
    acc.L += L; acc.n += 1; sums.set(k, acc);
  });
  rows.push([]);
  rows.push(['[管線彙總]']);
  rows.push(['Spec', '口徑', '總長(m)', '條數']);
  for (const [k, acc] of [...sums].sort()) {
    const [sp, dn] = k.split('|');
    rows.push([sp, dn, acc.L.toFixed(2), acc.n]);
  }
  rows.push([]);
  rows.push(['[設備]']);
  rows.push(['位號', '名稱', '類型', '單元']);
  let eqN = 0;
  for (const unit of sceneData.plant.units) {
    for (const eq of unit.equipment) {
      eqN += 1;
      rows.push([eq.tag, eq.name ?? typeName.get(eq.type) ?? '', eq.type, unit.name ?? unit.id ?? '']);
    }
  }
  const totalL = [...sums.values()].reduce((a, acc) => a + acc.L, 0);
  rows.push([]);
  rows.push(['[統計]', `設備 ${eqN}`, `管線 ${sceneData.pipes.length}`, `管線總長 ${totalL.toFixed(1)} m`]);
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
function exportMTO() {
  saveBlob(`${sceneId ?? 'scene'}-MTO.csv`, mtoCsv(), 'text/csv;charset=utf-8', false);
  setHint(`材料表已輸出：管線 ${sceneData.pipes.length} 條、設備 ${allEquipment().length} 台（CSV）`);
}
document.getElementById('btn-mto').addEventListener('click', exportMTO);

// ------------------------------------------------------------ 設備排程表（Equipment Schedule，CSV｜長度單位固定 mm）
// 對標 E3D Equipment Report：逐設備一列。長度一律 mm（canonical 公尺 ×1000 取整），表頭已標單位。
// 尺寸換算沿用 renderPropPanel 的 dims 規則：DIA_DIMS 存半徑→顯示直徑（×2）；COUNT_DIMS 為計數不換算。
function eqScheduleCsv() {
  const typeName = new Map(ASSET_CATEGORIES.flatMap((c) => c.items.map((it) => [it.type, it.name])));
  const esc = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const mm = (m) => Math.round((m ?? 0) * 1000);         // 公尺 → mm（整數），與顯示單位解耦
  // 關鍵尺寸字串：把 def.dims 攤成人類可讀（⌀xxx / 高 xxx / 長 xxx…），長度皆 mm
  const dimStr = (dims) => Object.entries(dims ?? {}).map(([k, v]) => {
    if (COUNT_DIMS.has(k)) return `${k} ${v}`;
    if (DIA_DIMS[k]) return `${DIA_DIMS[k].replace('直徑 ', '').replace('底徑 ', '底')
      .replace('頂徑 ', '頂')}${mm(v * 2)}`;             // 半徑→直徑 mm
    return `${k} ${mm(v)}`;
  }).join(' × ');
  const rows = [];
  rows.push(['J.S_3D Studio 設備排程表（Equipment Schedule）', sceneData.plant?.name ?? sceneId ?? '']);
  rows.push(['輸出時間', new Date().toLocaleString('zh-TW', { hour12: false })]);
  rows.push(['長度單位', 'mm']);
  rows.push([]);
  rows.push(['位號 Tag', '名稱 Name', '型別 Type', '所屬 ZONE', '關鍵尺寸(mm)', '鋼構斷面 Section', '材質 Material', 'P&ID']);
  let eqN = 0;
  for (const unit of sceneData.plant.units) {
    for (const eq of unit.equipment) {
      eqN += 1;
      const zone = `${unit.id ?? ''}${unit.name ? '｜' + unit.name : ''}` || (unit.name ?? unit.id ?? '');
      // 鋼構斷面：僅型鋼件（scolumn/sbeam）帶斷面，展開 D×B｜tw/tf
      let section = '';
      if (['scolumn', 'sbeam'].includes(eq.type) || eq.section) {
        const s = steelSection(eq.section);
        section = `${s.code}（D${s.depth}×B${s.flange}｜tw${s.web}/tf${s.tf}）`;
      }
      const material = eq.material ?? eq.design?.['材質'] ?? '';
      rows.push([eq.tag, eq.name ?? typeName.get(eq.type) ?? '', eq.type, zone,
        dimStr(eq.dims), section, material, eq.pid_ref ?? '']);
    }
  }
  rows.push([]);
  rows.push(['[統計]', `設備 ${eqN} 台`]);
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
function exportEqSchedule() {
  saveBlob(`${sceneId ?? 'scene'}-EquipmentSchedule.csv`, eqScheduleCsv(), 'text/csv;charset=utf-8', false);
  setHint(`設備排程表已輸出：設備 ${allEquipment().length} 台（CSV）`);
}
document.getElementById('btn-eq-schedule').addEventListener('click', exportEqSchedule);

// ------------------------------------------------------------ 管嘴排程表（Nozzle Schedule，CSV｜長度單位固定 mm）
// 對標 E3D Nozzle Schedule：遍歷所有設備的 def.nozzles，逐管嘴一列。
// 口徑由 nz.dn 查 PIPE_BORES 得 bore（半徑 r → 直徑 r×2000 mm）；標高＝nz.pos[1]（U 向）×1000 mm。
function nzScheduleCsv() {
  const esc = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const mm = (m) => Math.round((m ?? 0) * 1000);
  // 方向向量 → 方位字（對標 renderNozzleProps 的 NZ_DIRS）
  const DIR_NAMES = [[[0, 0, -1], '北 N'], [[0, 0, 1], '南 S'], [[1, 0, 0], '東 E'],
    [[-1, 0, 0], '西 W'], [[0, 1, 0], '上 U'], [[0, -1, 0], '下 D']];
  const dirLabel = (dir) => {
    if (!dir) return '';
    const key = JSON.stringify(dir.map((v) => Math.round(v)));
    const hit = DIR_NAMES.find(([v]) => JSON.stringify(v) === key);
    return hit ? hit[1] : dir.map((v) => (+v).toFixed(2)).join(',');
  };
  const rows = [];
  rows.push(['J.S_3D Studio 管嘴排程表（Nozzle Schedule）', sceneData.plant?.name ?? sceneId ?? '']);
  rows.push(['輸出時間', new Date().toLocaleString('zh-TW', { hour12: false })]);
  rows.push(['長度單位', 'mm']);
  rows.push([]);
  rows.push(['母設備 Tag', '管嘴 Nozzle', '口徑 DN', '口徑 bore(mm)', '標高 U(mm)', '方向 Dir']);
  let nzN = 0;
  for (const unit of sceneData.plant.units) {
    for (const eq of unit.equipment) {
      for (const nz of (eq.nozzles ?? [])) {
        nzN += 1;
        const bore = PIPE_BORES.find((b) => b.dn === nz.dn);
        const boreMm = bore ? Math.round(bore.r * 2000) : '';     // 內徑代表值：r×2（直徑）→mm
        rows.push([eq.tag, nz.id, nz.dn ?? '', boreMm, mm(nz.pos?.[1] ?? 0), dirLabel(nz.dir)]);
      }
    }
  }
  rows.push([]);
  rows.push(['[統計]', `管嘴 ${nzN} 支`]);
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
function exportNzSchedule() {
  const nzTotal = allEquipment().reduce((a, eq) => a + (eq.nozzles?.length ?? 0), 0);
  saveBlob(`${sceneId ?? 'scene'}-NozzleSchedule.csv`, nzScheduleCsv(), 'text/csv;charset=utf-8', false);
  setHint(`管嘴排程表已輸出：管嘴 ${nzTotal} 支（CSV）`);
}
document.getElementById('btn-nz-schedule').addEventListener('click', exportNzSchedule);

// ------------------------------------------------------------ 出圖工具：制式圖框彈窗＋批次打包 ZIP
let dwgLastBy = '';
let dwgOnOk = null;
function saveBlob(name, text, mime, preview) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  if (preview) window.open(url, '_blank');
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function openDwgDialog(kind, defs, onOk) {
  dwgOnOk = onOk;
  document.getElementById('dwg-mtitle').textContent = `出圖設定｜${kind}`;
  document.getElementById('dwg-title').value = defs.title ?? '';
  document.getElementById('dwg-no').value = defs.dwgno ?? '';
  document.getElementById('dwg-rev').value = defs.rev ?? 'A';
  document.getElementById('dwg-by').value = defs.by ?? dwgLastBy;
  document.getElementById('dwg-modal').classList.add('show');
  setTimeout(() => document.getElementById('dwg-title').focus(), 30);
}
document.getElementById('dwg-ok').addEventListener('click', () => {
  const m = {
    title: document.getElementById('dwg-title').value.trim(),
    dwgno: document.getElementById('dwg-no').value.trim(),
    rev: document.getElementById('dwg-rev').value.trim() || 'A',
    by: document.getElementById('dwg-by').value.trim(),
  };
  dwgLastBy = m.by;
  document.getElementById('dwg-modal').classList.remove('show');
  const cb = dwgOnOk; dwgOnOk = null;
  cb?.(m);
});
document.getElementById('dwg-cancel').addEventListener('click', () => {
  document.getElementById('dwg-modal').classList.remove('show');
  dwgOnOk = null;
});

/* 極簡 ZIP（STORE，無壓縮）——免外部依賴 */
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeZip(files) {
  const enc = new TextEncoder();
  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const nb = enc.encode(f.name), db = enc.encode(f.text), crc = crc32(db);
    const lh = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(db.length), ...u32(db.length),
      ...u16(nb.length), ...u16(0)]);
    parts.push(lh, nb, db);
    central.push({ nb, crc, size: db.length, offset });
    offset += lh.length + nb.length + db.length;
  }
  const cdStart = offset; const cds = [];
  for (const c of central) {
    const ch = Uint8Array.from([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0),
      ...u16(0), ...u16(0), ...u16(0), ...u32(c.crc), ...u32(c.size), ...u32(c.size),
      ...u16(c.nb.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(c.offset)]);
    cds.push(ch, c.nb);
    offset += ch.length + c.nb.length;
  }
  const cdSize = offset - cdStart;
  const eocd = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(cdStart), ...u16(0)]);
  return new Blob([...parts, ...cds, eocd], { type: 'application/zip' });
}
function exportBatch() {
  const base = sceneId ?? 'scene';
  const files = [{ name: `${base}-GA.svg`, text: gaSvg({ by: dwgLastBy }) }];
  sceneData.pipes.forEach((p, i) => { if ((p.pts?.length ?? 0) >= 2) files.push({ name: `ISO/${base}-pipe${i + 1}-ISO.svg`, text: isoSvg(i, { by: dwgLastBy }) }); });
  files.push({ name: `${base}-MTO.csv`, text: mtoCsv() });
  const url = URL.createObjectURL(makeZip(files));
  const a = document.createElement('a'); a.href = url; a.download = `${base}-drawings.zip`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setHint(`出圖批次完成：GA 1＋ISO ${sceneData.pipes.length}＋MTO，打包 ZIP（${files.length} 檔）`);
}
document.getElementById('btn-batch').addEventListener('click', exportBatch);

// ------------------------------------------------------------ 設備管嘴（Nozzle：點表面放置、畫管吸附嘴端）
const nozzleMat = std(0x2e6da8, { metalness: 0.4, roughness: 0.45 });
function renderNozzles(group, def) {
  const nzRoot = new THREE.Group();
  nzRoot.name = 'nozzles';
  for (const nz of def.nozzles ?? []) {
    const r = PIPE_BORES.find((b) => b.dn === nz.dn)?.r ?? 0.08;
    const stub = new THREE.Group();
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.32, 12), nozzleMat);
    neck.position.y = 0.16;
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.7, r * 1.7, 0.05, 14), nozzleMat);
    flange.position.y = 0.32;
    stub.add(neck, flange);
    stub.position.set(...nz.pos);
    stub.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...nz.dir).normalize());
    // 每個 mesh 帶母設備 tag＋管嘴 id（點嘴選嘴用）
    stub.traverse((o) => { if (o.isMesh) { o.userData.eqTag = def.tag; o.userData.nzId = nz.id; } });
    // 3D 標籤：id·DN（隨全域標籤開關；CSS2D）
    const el = document.createElement('div');
    el.className = 'nz-label';
    el.style.cssText = 'padding:1px 5px;border-radius:6px;background:rgba(4,106,251,.9);color:#fff;font-size:9px;font-weight:600;white-space:nowrap;pointer-events:none;';
    el.textContent = `${nz.id}·${nz.dn}`;
    const lbl = new CSS2DObject(el);
    lbl.position.set(0, 0.44, 0);
    stub.add(lbl);
    nzRoot.add(stub);
  }
  group.add(nzRoot);
}

function nozzleWorld(def, nz) {
  const dir = new THREE.Vector3(...nz.dir).normalize();
  const p = new THREE.Vector3(...nz.pos).add(dir.multiplyScalar(0.32));
  p.applyAxisAngle(new THREE.Vector3(0, 1, 0), def.rot_y ?? 0);
  return p.add(new THREE.Vector3(...def.pos));
}

function addNozzleAt(tag, hit) {
  const entry = eqObjects.get(tag);
  if (!entry) return;
  pushUndo();
  const def = entry.def;
  // 法向 → 世界主軸向（管嘴軸向正交慣例），再轉設備局部（反轉 rot_y）
  const n = hit.face?.normal
    ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
    : new THREE.Vector3(1, 0, 0);
  const comps = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
  const k = comps.indexOf(Math.max(...comps));
  const dirW = new THREE.Vector3(0, 0, 0);
  dirW.setComponent(k, Math.sign(n.getComponent(k)) || 1);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const local = hit.point.clone().sub(new THREE.Vector3(...def.pos)).applyAxisAngle(yAxis, -(def.rot_y ?? 0));
  const dirL = dirW.clone().applyAxisAngle(yAxis, -(def.rot_y ?? 0));
  def.nozzles = def.nozzles ?? [];
  const usedNz = new Set(def.nozzles.map((n) => n.id));
  let nzi = 1; while (usedNz.has(`N${nzi}`)) nzi++;
  const nzId = `N${nzi}`;
  const dn = document.getElementById('pipe-bore').value || 'DN100';
  def.nozzles.push({
    id: nzId, dn,
    pos: [+local.x.toFixed(2), +local.y.toFixed(2), +local.z.toFixed(2)],
    dir: [+dirL.x.toFixed(3), +dirL.y.toFixed(3), +dirL.z.toFixed(3)],
  });
  rebuildEquipment(def);
  if (selected?.kind === 'eq' && selected.def === def) renderPropPanel(def);
  setHint(`已加管嘴 <b>${def.tag}/${nzId}</b>（${dn}）——繪管時 1.5m 內自動吸附嘴端；可續點加嘴，Esc 結束`);
}

document.getElementById('btn-nozzle').addEventListener('click', () => {
  if (mode === 'nozzle') { setMode('idle'); return; }
  setMode('nozzle');
  document.getElementById('btn-nozzle').classList.add('active');
  setHint('加管嘴：點擊<b>設備表面</b>放置（口徑取管線 tab 目前 Bore），Esc 結束');
});

// ------------------------------------------------------------ 管線支撐自動生成（高架水平段每 4m）
function rackAxisInfo(r) {
  const th = r.rot_y ?? 0;
  return { dir: new THREE.Vector3(Math.cos(th), 0, -Math.sin(th)), c: new THREE.Vector3(r.pos[0], 0, r.pos[2]), len: r.dims.w ?? 8, top: +((r.dims.h ?? 4) + 0.15).toFixed(2) };
}
function rackEnds(r) {
  const a = rackAxisInfo(r), half = a.dir.clone().multiplyScalar(a.len / 2);
  return [a.c.clone().sub(half), a.c.clone().add(half)];
}
function chainTrayFromRack(start) {
  const racks = sceneData.plant.units.flatMap((u) => u.equipment).filter((e) => e.type === 'piperack');
  const GAP = 3.0;
  const comp = [start], seen = new Set([start.tag]), queue = [start];
  while (queue.length) {
    const cur = queue.shift(), ce = rackEnds(cur);
    for (const r of racks) {
      if (seen.has(r.tag)) continue;
      const re = rackEnds(r);
      if (ce.some((p) => re.some((q) => p.distanceTo(q) < GAP))) { seen.add(r.tag); comp.push(r); queue.push(r); }
    }
  }
  let unit = sceneData.plant.units.find((u) => u.id === 'U-TRAY');
  if (!unit) { unit = { id: 'U-TRAY', name: '橋架佈線', equipment: [] }; sceneData.plant.units.push(unit); }
  const added = [];
  const emit = (d) => { unit.equipment.push(d); added.push(d); };   // 先入 unit 再產下一個 tag，確保唯一
  for (const r of comp) {
    const a = rackAxisInfo(r);
    emit({ tag: nextTag('CT'), type: 'cabletray', name: '電纜橋架（串接）',
      dims: { w: 0.45, len: a.len, elev: a.top }, pos: [...r.pos], rot_y: r.rot_y ?? 0,
      design: {}, instruments: [], pid_ref: '' });
  }
  let bends = 0;
  for (let i = 0; i < comp.length; i++) for (let j = i + 1; j < comp.length; j++) {
    const A = comp[i], B = comp[j];
    if (Math.abs(rackAxisInfo(A).dir.dot(rackAxisInfo(B).dir)) > 0.9) continue;   // 同向非轉角
    const ea = rackEnds(A), eb = rackEnds(B);
    let corner = null, bestD = GAP;
    for (const p of ea) for (const q of eb) { const d = p.distanceTo(q); if (d < bestD) { bestD = d; corner = p.clone().add(q).multiplyScalar(0.5); } }
    if (!corner) continue;
    const dirA = new THREE.Vector3(A.pos[0], 0, A.pos[2]).sub(corner).normalize();
    const dirB = new THREE.Vector3(B.pos[0], 0, B.pos[2]).sub(corner).normalize();
    let bestRot = 0, bestSc = -9;
    for (const th of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const lx = new THREE.Vector3(Math.cos(th), 0, -Math.sin(th)), lz = new THREE.Vector3(Math.sin(th), 0, Math.cos(th));
      const sc = lx.dot(dirA) + lz.dot(dirB);
      if (sc > bestSc) { bestSc = sc; bestRot = th; }
    }
    const top = Math.max(rackAxisInfo(A).top, rackAxisInfo(B).top);
    emit({ tag: nextTag('CT'), type: 'traybend', name: '橋架水平彎',
      dims: { w: 0.45, elev: top }, pos: [+corner.x.toFixed(2), 0, +corner.z.toFixed(2)], rot_y: +bestRot.toFixed(3),
      design: {}, instruments: [], pid_ref: '' });
    bends += 1;
  }
  for (const e of added) buildEquipment(e);   // 已入 unit，此處只建 mesh
  return { racks: comp.length, trays: comp.length, bends };
}

function removeSupportsOf(uid) {
  let n = 0;
  for (const u of sceneData.plant.units) {
    for (const eq of u.equipment.filter((e) => e.sup_of === uid)) {
      const entry = eqObjects.get(eq.tag);
      if (entry) {
        if (transform.object === entry.group) transform.detach();
        scene.remove(entry.group);
        eqObjects.delete(eq.tag);
      }
      hiddenTags.delete(eq.tag);
      n += 1;
    }
    u.equipment = u.equipment.filter((e) => e.sup_of !== uid);
  }
  return n;
}

function regenSupportsForPipe(pipe) {
  const SPAN = 4, spots = [], pts = pipe.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay, az] = pts[i], [bx, by, bz] = pts[i + 1];
    if (Math.abs(by - ay) > 0.01) continue;              // 只支撐水平段
    if (ay - pipe.r < 0.4) continue;                     // 貼地管免支撐
    const len = Math.hypot(bx - ax, bz - az);
    for (let s = SPAN / 2; s < len; s += SPAN) {
      const t = s / len;
      spots.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, y: ay, yaw: Math.atan2(bx - ax, bz - az) });
    }
  }
  const removed = pipe.uid ? removeSupportsOf(pipe.uid) : 0;   // 先清舊
  if (!spots.length) return { made: 0, removed };
  pipe.uid = pipe.uid ?? `PL-${Math.random().toString(36).slice(2, 8)}`;
  let unit = sceneData.plant.units.find((u) => u.id === 'U-SUP');
  if (!unit) { unit = { id: 'U-SUP', name: '管線支撐', equipment: [] }; sceneData.plant.units.push(unit); }
  for (const sp of spots) {
    const def = {
      tag: nextTag('PS'), type: 'psupport', name: '管線支撐',
      dims: { h: +(sp.y - pipe.r).toFixed(2), r: Math.max(pipe.r, 0.05) },
      pos: [+sp.x.toFixed(2), 0, +sp.z.toFixed(2)], rot_y: +sp.yaw.toFixed(3),
      sup_of: pipe.uid, design: {}, instruments: [], pid_ref: '',
    };
    unit.equipment.push(def);
    buildEquipment(def);
  }
  return { made: spots.length, removed };
}
function hasSupports(uid) {
  return !!uid && sceneData.plant.units.some((u) => u.equipment.some((e) => e.sup_of === uid));
}
document.getElementById('btn-supports').addEventListener('click', () => {
  if (selected?.kind !== 'pipe') { setHint('先選取一條管線再<b>生成支撐</b>'); return; }
  const pipe = sceneData.pipes[selected.index];
  pushUndo();
  const r = regenSupportsForPipe(pipe);
  rebuildTree();
  updateTopbar();
  if (!r.made) { setHint('此管線沒有可支撐的高架水平段（貼地或垂直）' + (r.removed ? `——已清除舊 ${r.removed} 支` : '')); return; }
  setHint(`已沿管線 #${selected.index + 1} ${r.removed ? `重生（清除舊 ${r.removed} 支）` : '生成'} <b>${r.made}</b> 支支撐（間距 4m，結構圖層）——改管節點後自動重生`);
});

// ------------------------------------------------------------ 陣列／鏡射複製（佔右側屬性面板）
const PP_ROW = 'display:flex;align-items:center;gap:8px;margin:7px 0;font-size:12px;color:var(--dim)';
const PP_INP = 'flex:1;border:1px solid var(--bdr);border-radius:6px;padding:5px 8px;font-family:inherit;font-size:12.5px;color:var(--text);background:var(--panel)';
const PP_BTN = 'width:100%;margin-top:8px;padding:7px 0;border:none;border-radius:7px;background:var(--accent);color:#fff;font-family:inherit;font-size:12.5px;font-weight:600;cursor:pointer';
const PP_GHOST = 'width:100%;margin-top:6px;padding:6px 0;border:1px solid var(--bdr);border-radius:7px;background:none;color:var(--dim);font-family:inherit;font-size:12px;cursor:pointer';

function renderArrayPanel(kind) {
  if (selected?.kind !== 'eq') { setHint(`先選取設備再使用<b>${kind === 'array' ? '陣列' : '鏡射'}</b>`); return; }
  repaintPanel = () => renderArrayPanel(kind);
  const src = selected.def;
  const isArr = kind === 'array';
  document.getElementById('prop-title').textContent = `${isArr ? '陣列' : '鏡射'}｜${src.tag}`;
  propBody.innerHTML = isArr ? `
    <div style="${PP_ROW}"><span style="width:52px">方向</span><select id="ap-dir" style="${PP_INP}">
      <option value="E+">東（E＋）</option><option value="E-">西（E−）</option>
      <option value="N+">北（N＋）</option><option value="N-">南（N−）</option></select></div>
    <div style="${PP_ROW}"><span style="width:52px">間距 ${unitLabel()}</span><input id="ap-gap" type="number" step="${U().step}" value="${toDisp(5)}" style="${PP_INP}"></div>
    <div style="${PP_ROW}"><span style="width:52px">複製數</span><input id="ap-n" type="number" min="1" max="30" value="2" style="${PP_INP}"></div>
    <button id="ap-go" style="${PP_BTN}">生成陣列</button>
    <button id="ap-done" style="${PP_GHOST}">返回屬性</button>` : `
    <div style="${PP_ROW}"><span style="width:52px">鏡射軸</span><select id="ap-axis" style="${PP_INP}">
      <option value="E">南北向軸（左右翻）</option><option value="N">東西向軸（前後翻）</option></select></div>
    <div style="${PP_ROW}"><span style="width:52px">軸位置 ${unitLabel()}</span><input id="ap-at" type="number" step="${U().step}" value="${toDisp(src.pos[0])}" style="${PP_INP}"></div>
    <button id="ap-go" style="${PP_BTN}">生成鏡射</button>
    <button id="ap-done" style="${PP_GHOST}">返回屬性</button>`;
  document.getElementById('ap-done').addEventListener('click', () => selectEquipment(src.tag));
  if (!isArr) {
    document.getElementById('ap-axis').addEventListener('change', (e) => {
      document.getElementById('ap-at').value = toDisp(e.target.value === 'E' ? src.pos[0] : src.pos[2]);
    });
  }
  document.getElementById('ap-go').addEventListener('click', () => {
    const prefix = (src.tag.match(/^[A-Z]+/i)?.[0] ?? 'X').toUpperCase();
    const unit = sceneData.plant.units.find((u) => u.equipment.includes(src)) ?? sceneData.plant.units[0];
    pushUndo();
    let lastTag = src.tag;
    if (isArr) {
      const [dx, dz] = { 'E+': [1, 0], 'E-': [-1, 0], 'N+': [0, 1], 'N-': [0, -1] }[document.getElementById('ap-dir').value];
      const gap = fromDisp(document.getElementById('ap-gap').value) || 5;
      const n = Math.min(30, Math.max(1, Math.round(+document.getElementById('ap-n').value || 1)));
      for (let i = 1; i <= n; i++) {
        const d2 = JSON.parse(JSON.stringify(src));
        d2.tag = nextTag(prefix);
        d2.pos = [src.pos[0] + dx * gap * i, src.pos[1] ?? 0, src.pos[2] + dz * gap * i];
        d2.instruments = [];
        unit.equipment.push(d2);
        buildEquipment(d2);
        lastTag = d2.tag;
      }
      setHint(`陣列完成：自 <b>${src.tag}</b> 新增 ${n} 台`);
    } else {
      const axis = document.getElementById('ap-axis').value;
      const at = fromDisp(document.getElementById('ap-at').value);
      const d2 = JSON.parse(JSON.stringify(src));
      d2.tag = nextTag(prefix);
      d2.instruments = [];
      if (axis === 'E') { d2.pos[0] = +(2 * at - src.pos[0]).toFixed(2); d2.rot_y = -(src.rot_y ?? 0); }
      else { d2.pos[2] = +(2 * at - src.pos[2]).toFixed(2); d2.rot_y = Math.PI - (src.rot_y ?? 0); }
      unit.equipment.push(d2);
      buildEquipment(d2);
      lastTag = d2.tag;
      setHint(`鏡射完成：<b>${src.tag}</b> → <b>${d2.tag}</b>`);
    }
    rebuildTree();
    updateTopbar();
    selectEquipment(lastTag);
  });
}
document.getElementById('btn-array').addEventListener('click', () => renderArrayPanel('array'));
document.getElementById('btn-mirror').addEventListener('click', () => renderArrayPanel('mirror'));

// ------------------------------------------------------------ 標高基準面（EL Datum：sceneData.elevs 持久化）
const elevGroup = new THREE.Group();
elevGroup.visible = false;
scene.add(elevGroup);
let elevOn = false;

function rebuildElevs() {
  for (const c of [...elevGroup.children]) {
    if (c.isCSS2DObject) c.element.remove();
    elevGroup.remove(c);
  }
  for (const h of sceneData.elevs ?? []) {
    const grid = new THREE.GridHelper(60, 30, 0x7fa8e8, 0xd4e2f4);
    grid.position.y = h;
    const el = document.createElement('div');
    el.style.cssText = 'padding:1px 7px;border-radius:4px;background:rgba(4,106,251,.88);color:#fff;font-size:10.5px;font-weight:700;white-space:nowrap;';
    el.textContent = `EL.${h >= 0 ? '+' : ''}${(h * 1000).toFixed(0)}`;
    const lbl = new CSS2DObject(el);
    lbl.position.set(-29, h + 0.05, -29);
    elevGroup.add(grid, lbl);
  }
}

function renderElevPanel() {
  repaintPanel = renderElevPanel;
  document.getElementById('prop-title').textContent = '標高基準面';
  const elevs = sceneData.elevs ?? [];
  const rows = elevs.map((h, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:5px 2px;border-bottom:1px solid var(--bdr);font-size:12.5px">
      <span style="flex:1;color:var(--text);font-weight:600">EL.${h >= 0 ? '+' : ''}${fmtLen(h)}</span>
      <button data-edel="${i}" style="border:none;background:none;color:#d03050;cursor:pointer;font-size:11.5px;font-family:inherit">刪除</button>
    </div>`).join('');
  propBody.innerHTML = `
    <div style="${PP_ROW}"><span style="width:64px">標高 ${unitLabel()}</span><input id="el-h" type="number" step="${U().step}" value="${toDisp(3)}" style="${PP_INP}"></div>
    <button id="el-add" style="${PP_BTN}">加入基準面</button>
    <div style="margin-top:12px">${rows || '<div style="color:var(--dim);font-size:12px;padding:6px 0">尚無基準面——輸入標高後加入（EL.0 為地坪）</div>'}</div>`;
  document.getElementById('el-add').addEventListener('click', () => {
    const h = fromDisp(document.getElementById('el-h').value);
    if (!Number.isFinite(h)) return;
    pushUndo();
    sceneData.elevs = sceneData.elevs ?? [];
    if (!sceneData.elevs.includes(h)) sceneData.elevs.push(h);
    sceneData.elevs.sort((a, b) => a - b);
    rebuildElevs();
    renderElevPanel();
  });
  propBody.querySelectorAll('[data-edel]').forEach((b) => b.addEventListener('click', () => {
    pushUndo();
    sceneData.elevs.splice(+b.dataset.edel, 1);
    rebuildElevs();
    renderElevPanel();
  }));
}

document.getElementById('btn-elev').addEventListener('click', (e) => {
  elevOn = !elevOn;
  e.currentTarget.classList.toggle('active', elevOn);
  elevGroup.visible = elevOn;
  if (elevOn) {
    rebuildElevs();
    renderElevPanel();
    setHint('標高基準面：屬性面板管理標高清單；再按一次<b>標高</b>隱藏');
  }
});

// ------------------------------------------------------------ Clash 檢測面板（工具 tab）
const clashDock = document.getElementById('clash-dock');
let clashMarks = [];   // BoxHelper 高亮

function clearClashMarks() {
  for (const m of clashMarks) scene.remove(m);
  clashMarks = [];
}

function runClashDock() {
  const t0 = performance.now();
  const { clashes, capped, open, total } = runClash(sceneData, eqObjects, hiddenTags);
  const ms = Math.round(performance.now() - t0);
  const n = { physical: 0, touch: 0, clearance: 0 };
  for (const c of clashes) if (n[c.type] !== undefined) n[c.type]++;
  document.getElementById('clash-summary').textContent =
    `Physical ${n.physical}｜Touch ${n.touch}｜Clearance ${n.clearance}　未處理 ${open}/${total}（${ms}ms${capped ? '，已截斷' : ''}）`;
  document.getElementById('clash-count').textContent = `　${clashes.length} 筆`;
  const list = document.getElementById('clash-list');
  const CB = { physical: ['#d9534f', 'Physical'], touch: ['#e0a800', 'Touch'], clearance: ['#4a90d9', 'Clearance'] };
  const SB = { held: ['#8e6bd6', 'HELD'], approved: ['#3fae6b', 'APPROVED'] };
  const badge = (bg, txt) => `<span style="display:inline-block;padding:1px 6px;border-radius:4px;background:${bg};color:#fff;font-size:10px;font-weight:600">${txt}</span>`;
  list.innerHTML = clashes.length ? clashes.map((c, i) => {
    const cb = CB[c.type] ?? ['#888', c.type];
    return `<div class="clash-row" data-ci="${i}" style="opacity:${c.status === 'approved' ? 0.5 : 1}">
      ${badge(cb[0], cb[1])}
      <span style="color:var(--dim);font-family:monospace;font-size:11px" title="遮蔽碼 Hard/Soft">${c.code}</span>
      <span>${c.a}</span><span>${c.b}</span>
      <span style="color:var(--dim)">(${fmtLen(c.point.x, false)}, ${fmtLen(c.point.z, false)}) ${unitLabel()}</span>
      ${SB[c.status] ? badge(SB[c.status][0], SB[c.status][1]) : ''}
      <span style="margin-left:auto;display:flex;gap:4px">
        <button data-hold="${i}" class="pane-x" title="Hold（追蹤，暫不解）">⏸</button>
        <button data-appr="${i}" class="pane-x" title="Approve（核可 by-design，抑制）">✓</button>
      </span>
    </div>`;
  }).join('') : '<div style="padding:14px;color:var(--dim)">無碰撞——場景乾淨</div>';
  clashDock.classList.add('show');
  const setStatus = (i, st) => {
    const c = clashes[i];
    pushUndo();
    sceneData.clashStatus = sceneData.clashStatus ?? {};
    const key = clashKey(c.a, c.b);
    if (sceneData.clashStatus[key] === st) delete sceneData.clashStatus[key];   // 再按一次＝取消
    else sceneData.clashStatus[key] = st;
    runClashDock();
  };
  list.querySelectorAll('[data-hold]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setStatus(+b.dataset.hold, 'held'); }));
  list.querySelectorAll('[data-appr]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); setStatus(+b.dataset.appr, 'approved'); }));
  list.querySelectorAll('.clash-row').forEach((row) => row.addEventListener('click', () => {
    list.querySelectorAll('.clash-row').forEach((r) => r.classList.toggle('selected', r === row));
    const c = clashes[+row.dataset.ci];
    clearClashMarks();
    for (const tag of [c.a, c.b]) {
      const entry = eqObjects.get(tag);
      if (entry) {
        const h = new THREE.BoxHelper(entry.group, 0xff4d4f);
        scene.add(h);
        clashMarks.push(h);
      }
    }
    if (c.pipeIndex !== undefined) selectPipe(c.pipeIndex);
    const box = new THREE.Box3(
      c.point.clone().add(new THREE.Vector3(-5, -1, -5)),
      c.point.clone().add(new THREE.Vector3(5, 9, 5)));
    frameBox(box, camera.position.clone().sub(controls.target).normalize());
  }));
}
document.getElementById('btn-clash-run').addEventListener('click', runClashDock);
document.getElementById('clash-close').addEventListener('click', () => {
  clashDock.classList.remove('show');
  clearClashMarks();
});

// ------------------------------------------------------------ 視角書籤（E3D Save & Restore Views）
function captureThumb() {
  renderer.render(scene, camera);  // preserveDrawingBuffer=false → 先渲染同幀取圖
  const src = renderer.domElement;
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 100;
  c.getContext('2d').drawImage(src, 0, 0, 160, 100);
  return c.toDataURL('image/jpeg', 0.6);
}

document.getElementById('btn-view-save').addEventListener('click', () => {
  const name = prompt('視角名稱：', `視角 ${(sceneData.views?.length ?? 0) + 1}`);
  if (!name) return;
  sceneData.views ??= [];
  sceneData.views.push({
    name,
    pos: camera.position.toArray(),
    target: controls.target.toArray(),
    hidden: [...hiddenTags],
    thumb: captureThumb(),
  });
  setHint(`視角 <b>${name}</b> 已存（隨場景儲存）`);
  renderViewsPanel();
});

let camTween = null;
function flyTo(pos, target) {
  camTween = {
    fromP: camera.position.clone(), toP: new THREE.Vector3(...pos),
    fromT: controls.target.clone(), toT: new THREE.Vector3(...target),
    t: 0,
  };
}

function renderViewsPanel() {
  const views = sceneData.views ?? [];
  document.getElementById('prop-title').textContent = '視角書籤';
  propBody.innerHTML = views.length
    ? views.map((v, i) => `
      <div class="scene-item" data-vi="${i}" style="gap:8px">
        <img src="${v.thumb}" width="72" height="45" style="border-radius:5px;border:1px solid var(--bdr)">
        <span style="flex:1">${v.name}</span>
        <button class="pane-x" data-del="${i}" title="刪除">✕</button>
      </div>`).join('')
    : '<div id="prop-empty">尚無書籤<br>VIEW > 存視角 建立</div>';
  propBody.querySelectorAll('[data-vi]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.dataset.del !== undefined) return;
    const v = views[+el.dataset.vi];
    flyTo(v.pos, v.target);
    hiddenTags.clear();
    for (const t of v.hidden ?? []) hiddenTags.add(t);
    for (const [tag, entry] of eqObjects) entry.group.visible = !hiddenTags.has(tag) && eqLayerOn(entry.def);
    rebuildTree();
  }));
  propBody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    views.splice(+b.dataset.del, 1);
    renderViewsPanel();
  }));
}
document.getElementById('btn-view-restore').addEventListener('click', renderViewsPanel);

// ------------------------------------------------------------ Walk 漫遊（E3D Walk F6：第一人稱）
const walk = { on: false, keys: new Set(), plc: null, prevFov: 55 };
function walkStep() {
  if (camTween) {  // 視角書籤飛行
    camTween.t = Math.min(1, camTween.t + 0.045);
    const k = camTween.t * camTween.t * (3 - 2 * camTween.t);
    camera.position.lerpVectors(camTween.fromP, camTween.toP, k);
    controls.target.lerpVectors(camTween.fromT, camTween.toT, k);
    if (camTween.t >= 1) camTween = null;
  }
  if (!walk.on) return;
  const sp = (walk.keys.has('shift') ? 8 : 4) / 60;
  if (walk.keys.has('w') || walk.keys.has('arrowup')) walk.plc.moveForward(sp);
  if (walk.keys.has('s') || walk.keys.has('arrowdown')) walk.plc.moveForward(-sp);
  if (walk.keys.has('a') || walk.keys.has('arrowleft')) walk.plc.moveRight(-sp);
  if (walk.keys.has('d') || walk.keys.has('arrowright')) walk.plc.moveRight(sp);
  camera.position.y = 1.7;  // 眼高鎖定
}

function enterWalk() {
  if (walk.on) return;
  walk.plc ??= new PointerLockControls(camera, renderer.domElement);
  walk.prevFov = camera.fov;
  walk.on = true;
  controls.enabled = false;
  camera.fov = 90;
  camera.position.y = 1.7;
  camera.updateProjectionMatrix();
  document.getElementById('btn-walk').classList.add('active');
  setHint('漫遊中：<b>WASD/方向鍵</b>移動、<b>Shift</b> 加速、滑鼠轉頭、<b>Esc</b> 離開');
  walk.plc.lock();
  walk.plc.addEventListener('unlock', exitWalk);
}
function exitWalk() {
  if (!walk.on) return;
  walk.on = false;
  walk.keys.clear();
  walk.plc.removeEventListener('unlock', exitWalk);
  camera.fov = walk.prevFov;
  camera.updateProjectionMatrix();
  // 走到哪看到哪：target 設為前方 10m，OrbitControls 無縫接手
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  controls.target.copy(camera.position).addScaledVector(dir, 10);
  controls.enabled = true;
  document.getElementById('btn-walk').classList.remove('active');
  setHint('已離開漫遊');
}
document.getElementById('btn-walk').addEventListener('click', enterWalk);
addEventListener('keydown', (e) => { if (walk.on) walk.keys.add(e.key.toLowerCase()); });
addEventListener('keyup', (e) => { walk.keys.delete(e.key.toLowerCase()); });

// ------------------------------------------------------------ PowerCompass
// E3D 球形方位羅盤：點 N/S/E/W/U/D 切視向、可拖曳移位、方位環隨相機轉
const compassEl = document.getElementById('power-compass');
const compassRose = document.getElementById('pc-rose');
compassEl.querySelectorAll('.pc-hot').forEach((hot) => {
  hot.addEventListener('click', (e) => {
    e.stopPropagation();
    if (compassDragMoved) return;
    setViewPreset(hot.dataset.vp);
  });
});
let compassDrag = null, compassDragMoved = false;
compassEl.addEventListener('pointerdown', (e) => {
  compassDrag = { x: e.clientX, y: e.clientY, left: compassEl.offsetLeft, top: compassEl.offsetTop };
  compassDragMoved = false;
  compassEl.setPointerCapture(e.pointerId);
});
compassEl.addEventListener('pointermove', (e) => {
  if (!compassDrag) return;
  const dx = e.clientX - compassDrag.x, dy = e.clientY - compassDrag.y;
  if (Math.hypot(dx, dy) > 5) compassDragMoved = true;
  if (compassDragMoved) {
    compassEl.style.left = `${compassDrag.left + dx}px`;
    compassEl.style.top = `${compassDrag.top + dy}px`;
    compassEl.style.bottom = 'auto';
  }
});
compassEl.addEventListener('pointerup', () => {
  if (compassDragMoved) {
    localStorage.setItem('ej-compass-pos', JSON.stringify({ left: compassEl.style.left, top: compassEl.style.top }));
  }
  compassDrag = null;
});
try {
  const saved = JSON.parse(localStorage.getItem('ej-compass-pos') ?? 'null');
  if (saved) { compassEl.style.left = saved.left; compassEl.style.top = saved.top; compassEl.style.bottom = 'auto'; }
} catch { /* 忽略壞值 */ }

// 面板收合
document.getElementById('tree-hide').addEventListener('click', () => { document.body.classList.add('tree-collapsed'); onResize(); });
document.getElementById('tree-reopen').addEventListener('click', () => { document.body.classList.remove('tree-collapsed'); onResize(); });
document.getElementById('prop-hide').addEventListener('click', () => { document.body.classList.add('prop-collapsed'); onResize(); });
document.getElementById('prop-reopen').addEventListener('click', () => { document.body.classList.remove('prop-collapsed'); onResize(); });

// ------------------------------------------------------------ 鍵盤
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') {
    if (walk.on) exitWalk();  // pointer lock 失敗/headless 時的保險退出
    setMode('idle');
    selectNone();
  }
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
    const ptsOut = pipeDraft.map((p) => [roundMM(p.x), roundMM(p.y), roundMM(p.z)]);
    if (ductDraw) {
      const [w, h] = ductSize;
      sceneData.pipes.push({ r: Math.max(w, h) / 2, profile: 'duct', duct: { w, h }, spec: 'HVAC', dn: `${(w * 1000) | 0}×${(h * 1000) | 0}`, pts: ptsOut });
    } else {
      const spec = document.getElementById('pipe-spec').value;
      const dn = document.getElementById('pipe-bore').value;
      const r = PIPE_BORES.find((b) => b.dn === dn)?.r ?? 0.12;
      sceneData.pipes.push({ r, spec, dn, pts: ptsOut });
    }
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
  } else if (e.key === ' ' && mode !== 'measure' && mode !== 'pipe' && !walk.on) {
    e.preventDefault();  // 空白鍵＝以上次模式重複量測（E3D 3.1.7）
    startMeasure(lastMeasureMode);
  } else if (e.key === 'F2') {
    e.preventDefault();
    setNavMode('zoom');
  } else if (e.key === 'F3') {
    e.preventDefault();
    setNavMode('pan');
  } else if (e.key === 'F5') {
    e.preventDefault();  // E3D 導航模式鍵（蓋掉瀏覽器重整）
    setNavMode('rotate');
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
  if (selected.kind === 'nozzle') {
    const def = selected.def;
    def.nozzles = (def.nozzles ?? []).filter((n) => n.id !== selected.nz.id);
    rebuildEquipment(def);
    rebuildTree(); updateTopbar();
    selectEquipment(def.tag);
    return;
  }
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
    const uid = sceneData.pipes[selected.index]?.uid;
    sceneData.pipes.splice(selected.index, 1);
    if (uid) removeSupportsOf(uid);   // 支撐隨管刪除
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
updateBreadcrumb();

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
const tmpDir = new THREE.Vector3();
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  // 三軸指示同步相機方位
  camera.getWorldQuaternion(tmpQ);
  triadScene.quaternion.copy(tmpQ).invert();
  triadRenderer.render(triadScene, triadCam);
  // PowerCompass 方位環隨相機 yaw 旋轉（N 永遠指向場景北＝-Z）
  camera.getWorldDirection(tmpDir);
  const yaw = Math.atan2(tmpDir.x, -tmpDir.z) * 180 / Math.PI;
  compassRose.setAttribute('transform', `rotate(${-yaw} 48 48)`);
  // Walk 漫遊移動積分
  walkStep();
}
animate();

// console 除錯/自動化測試用
// AI 小精靈：右下角建模建議（statusbar 上方）
initSprite({
  page: 'e3d',
  bottom: 40,
  context: () => {
    const eq = sceneData.plant?.units?.flatMap((u) => u.equipment ?? []) ?? [];
    let sel = null;
    if (selected?.kind === 'eq') {
      const d = selected.def;
      sel = { 種類: '設備', 位號: d.tag, 類型: d.type, 尺寸: d.dims };
    } else if (selected?.kind === 'pipe') {
      const pp = sceneData.pipes[selected.index];
      sel = { 種類: '管線', 編號: selected.index + 1, spec: pp.spec ?? null, 管徑: pp.dn ?? `r${pp.r}`,
              節點數: pp.pts.length, 總長m: +pipeLength(pp).toFixed(1),
              元件數: (pp.components ?? []).length };
    }
    return {
      場景: sceneData.plant?.name ?? '未命名',
      設備數: eq.length,
      設備類型分佈: eq.slice(0, 200).reduce((m, d) => { m[d.type] = (m[d.type] ?? 0) + 1; return m; }, {}),
      管線數: sceneData.pipes?.length ?? 0,
      無元件管線數: (sceneData.pipes ?? []).filter((pp) => !(pp.components ?? []).length).length,
      無Spec管線數: (sceneData.pipes ?? []).filter((pp) => !pp.spec).length,
      目前選取: sel,
      剖切模式: clip.mode,
    };
  },
});

window.EJ3D_EDITOR = {
  get scene() { return sceneData; },
  get undoDepth() { return undoStack.length; },
  get redoDepth() { return redoStack.length; },
  get selected() { return selected; },
  get clipMode() { return clip.mode; },
  get measureCount() { return measureGroup ? measureGroup.children.length : 0; },
  selectEquipment, selectPipe, fitAll, setViewPreset,
  startMeasure, addMeasurePoint, clipStart, clipClear, enterNodeMode,
  duplicateEquipment,
  V3: (x, y, z) => new THREE.Vector3(x, y, z),
};
