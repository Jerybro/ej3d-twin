// EJ_3D 數位孿生平台 MVP — 前端 3D 視圖器
// M1: 3D 場景漫遊  M2: 設備熱點資訊卡  領航加值: 洩漏/火災情境模擬 + 疏散路徑

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { std, markShadow, builders, detailedBuilders, dm, dFlange, mergeByMaterial, labelHeight } from './plant-builders.js';

const ACCENT = new THREE.Color('#46c2e0');
const ALARM_RED = new THREE.Color('#ff2a2d');

// ---------------------------------------------------------------- 資料載入
// ?scene=<id> 載入編輯器自建場景（預設 demo）
const SCENE_ID = new URLSearchParams(location.search).get('scene') ?? 'demo';
const [plantData, scenarioList] = await Promise.all([
  fetch(`/api/plant?scene=${SCENE_ID}`).then((r) => r.json()),
  fetch(`/api/scenarios?scene=${SCENE_ID}`).then((r) => r.json()),
]);
const scenarioDefs = Object.fromEntries(plantData.scenarios.map((s) => [s.id, s]));

// ---------------------------------------------------------------- 基礎場景
const viewport = document.getElementById('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e141b);
scene.fog = new THREE.Fog(0x0e141b, 45, 110);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 300);
camera.position.set(17, 13, 20);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;
viewport.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
viewport.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.maxPolarAngle = 1.45;
controls.minDistance = 4;
controls.maxDistance = 70;

scene.add(new THREE.HemisphereLight(0xbdd2e2, 0x1a222b, 1.25));
// 環境貼圖：金屬 PBR 材質（如掃描資產）沒有環境反射會渲染成全黑
let roomEnvTex;
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  roomEnvTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = roomEnvTex;
  scene.environmentIntensity = 0.45;
  pmrem.dispose();
}

// ------------------------------------------------- 實景背景（equirect 全景）
// 真實廠區照片全景 → 天空盒 + PBR 環境反射。靜態貼圖一張，渲染負擔幾乎為零；
// 8K 原圖先縮 4K 再上 GPU，顧內顯筆電的記憶體
const DARK_BG = scene.background;
const DARK_FOG = scene.fog;
let skyOn = false;
let skyTex = null;
let skyEnvTex = null;

async function loadSkyTexture(cfg) {
  const img = await new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`載入失敗: ${cfg.file}`));
    im.src = `/scans/${cfg.file}`;
  });
  const W = Math.min(img.width, 4096);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = W / 2;
  cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 真實地坪：實景模式時把格線地面換成掃描級混凝土材質（ARM 一張餵 ao/rough/metal 三通道）
let groundTex = null;
function loadGroundTextures() {
  if (groundTex) return groundTex;
  const tl = new THREE.TextureLoader();
  const load = (f, srgb) => {
    const t = tl.load(`/scans/ground/${f}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(10, 6.5);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  groundTex = {
    map: load('concrete_floor_02_diff_2k.jpg', true),
    normalMap: load('concrete_floor_02_nor_gl_2k.jpg'),
    arm: load('concrete_floor_02_arm_2k.jpg'),
  };
  return groundTex;
}

function setGroundReal(on) {
  const m = ground.material;
  if (on) {
    const t = loadGroundTextures();
    m.map = t.map;
    m.normalMap = t.normalMap;
    m.roughnessMap = t.arm; // ARM 的 G 通道
    m.metalnessMap = t.arm; // ARM 的 B 通道（aoMap 需要 uv1，Plane 沒有，略過）
    m.color.setHex(0xffffff);
    m.metalness = 1; // 讓 metalnessMap（B 通道≈0）主導
  } else {
    m.map = m.normalMap = m.roughnessMap = m.metalnessMap = null;
    m.color.setHex(0x1c232b);
    m.metalness = 0;
  }
  m.needsUpdate = true;
  grid.visible = !on; // 真實地坪時收掉工程格線
}

async function setSky(on) {
  const cfg = plantData.environment;
  if (on && !skyTex) {
    skyTex = await loadSkyTexture(cfg);
    const pmrem = new THREE.PMREMGenerator(renderer);
    skyEnvTex = pmrem.fromEquirectangular(skyTex).texture;
    pmrem.dispose();
  }
  skyOn = on;
  setGroundReal(on);
  if (on) {
    scene.background = skyTex;
    scene.backgroundIntensity = cfg.background_intensity ?? 0.9;
    scene.backgroundRotation = new THREE.Euler(0, cfg.yaw ?? 0, 0);
    scene.environment = skyEnvTex;
    scene.environmentRotation = new THREE.Euler(0, cfg.yaw ?? 0, 0);
    scene.fog = null; // 霧的深色會把地坪邊緣糊到照片上，實景模式關掉
  } else {
    scene.background = DARK_BG;
    scene.environment = roomEnvTex;
    scene.fog = DARK_FOG;
  }
  const btn = document.getElementById('sky-toggle');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.textContent = on ? '深色模式' : '實景背景';
  }
}

const skyBtn = document.getElementById('sky-toggle');
if (!plantData.environment) {
  skyBtn.style.display = 'none';
} else {
  skyBtn.title = plantData.environment.label ?? '實景背景';
  skyBtn.addEventListener('click', async () => {
    if (skyBtn.disabled) return;
    skyBtn.disabled = true;
    try {
      await setSky(!skyOn);
    } catch (err) {
      console.error('實景背景載入失敗:', err);
      skyBtn.textContent = '實景載入失敗';
    }
    skyBtn.disabled = false;
  });
  // 預設開實景；示範資產還沒 fetch 時安靜退回深色模式
  setSky(true).catch(() => { skyBtn.style.display = 'none'; });
}
const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
sun.position.set(18, 26, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -28, right: 28, top: 28, bottom: -28, far: 80 });
scene.add(sun);

// ------------------------------------------------- 效能分級（減渲染負擔）
// 簡報現場常是內顯筆電：三檔畫質＋FPS 自動降階，讓前導平台在任何機器都跑得動
const QUALITY = {
  high: { pr: Math.min(devicePixelRatio, 2), shadows: true, shadowSize: 2048, env: 0.45, particles: 1.0, label: '高' },
  med: { pr: Math.min(devicePixelRatio, 1.25), shadows: true, shadowSize: 1024, env: 0.3, particles: 0.6, label: '中' },
  low: { pr: 0.75, shadows: false, shadowSize: 512, env: 0, particles: 0.35, label: '低' },
};
const TIER_ORDER = ['low', 'med', 'high'];
let qualityMode = 'auto'; // auto | high | med | low
let qualityTier = 'high';
let particleScale = 1;
const perf = { acc: 0, frames: 0, fps: 60, lowSecs: 0, highSecs: 0 };

function applyQuality(tier) {
  qualityTier = tier;
  const q = QUALITY[tier];
  if (typeof splatMode === 'undefined' || !splatMode) renderer.setPixelRatio(q.pr);
  renderer.shadowMap.enabled = q.shadows;
  sun.castShadow = q.shadows;
  sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
  if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  scene.environmentIntensity = q.env;
  particleScale = q.particles;
  // 低檔強制退回低耗能模型；回升後恢復使用者選擇（函式在後段定義，靠 hoisting）
  syncDetailToTier();
  // 切陰影開關需要重編材質
  scene.traverse((o) => { if (o.isMesh) o.material.needsUpdate = true; });
  updatePerfChip();
}

function updatePerfChip() {
  const el = document.getElementById('perf-chip');
  if (!el) return;
  const modeTxt = qualityMode === 'auto' ? `自動·${QUALITY[qualityTier].label}` : QUALITY[qualityTier].label;
  el.innerHTML = `效能 <b>${modeTxt}</b> <span class="unit">${Math.round(perf.fps)}fps</span>`;
}

document.getElementById('perf-chip')?.addEventListener('click', () => {
  const cycle = ['auto', 'high', 'med', 'low'];
  qualityMode = cycle[(cycle.indexOf(qualityMode) + 1) % cycle.length];
  perf.lowSecs = perf.highSecs = 0;
  applyQuality(qualityMode === 'auto' ? qualityTier : qualityMode);
});

function autoAdaptQuality() {
  if (qualityMode !== 'auto') return;
  const i = TIER_ORDER.indexOf(qualityTier);
  if (perf.fps < 28) {
    perf.highSecs = 0;
    if (++perf.lowSecs >= 3 && i > 0) { perf.lowSecs = 0; applyQuality(TIER_ORDER[i - 1]); }
  } else if (perf.fps > 55) {
    perf.lowSecs = 0;
    if (++perf.highSecs >= 10 && i < TIER_ORDER.length - 1) { perf.highSecs = 0; applyQuality(TIER_ORDER[i + 1]); }
  } else {
    perf.lowSecs = perf.highSecs = 0;
  }
}

// 程式生成示範廠的所有內容都掛在 plantGroup 下，方便與 3DGS 掃描檢視模式互切
const plantGroup = new THREE.Group();
scene.add(plantGroup);

// 地坪自適應：預設 70×45，場景（如 P&ID 整廠合併）超出時放大
let GROUND_W = 70, GROUND_D = 45;
for (const unit of plantData.plant.units) {
  for (const eq of unit.equipment) {
    GROUND_W = Math.max(GROUND_W, Math.abs(eq.pos[0]) * 2 + 20);
    GROUND_D = Math.max(GROUND_D, Math.abs(eq.pos[2]) * 2 + 20);
  }
}
for (const u of plantData.underlays ?? []) {  // 圖紙底圖比設備群更寬
  GROUND_W = Math.max(GROUND_W, (Math.abs(u.x) + u.w / 2) * 2 + 16);
  GROUND_D = Math.max(GROUND_D, (Math.abs(u.z) + u.h / 2) * 2 + 16);
}
GROUND_W = Math.ceil(GROUND_W / 10) * 10;
GROUND_D = Math.ceil(GROUND_D / 10) * 10;
if (GROUND_W > 70 || GROUND_D > 45) {  // 大場景：視距/霧/遠平面一起放大
  const span = Math.max(GROUND_W, GROUND_D);
  camera.far = Math.max(300, span * 2.5);
  camera.position.set(span * 0.35, span * 0.3, span * 0.5);
  camera.updateProjectionMatrix();
  controls.maxDistance = span * 1.2;
  // 就地改霧參數（DARK_FOG 持有同一實例，深色/實景切換才不會還原成小場景霧）
  scene.fog.near = span * 0.9;
  scene.fog.far = span * 2.2;
}
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(GROUND_W, GROUND_D),
  new THREE.MeshStandardMaterial({ color: 0x1c232b, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
plantGroup.add(ground);
const grid = new THREE.GridHelper(Math.max(GROUND_W, GROUND_D), Math.max(GROUND_W, GROUND_D) / 2, 0x2a3844, 0x1f2a33);
grid.position.y = 0.02;
plantGroup.add(grid);

// 圖紙底圖（P&ID 地毯）：設備站在圖面自己的位置上，可直接對圖
const texLoader = new THREE.TextureLoader();
for (const u of plantData.underlays ?? []) {
  const tex = texLoader.load(u.image);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8; // 斜視角下位號文字才不糊
  const sheet = new THREE.Mesh(
    new THREE.PlaneGeometry(u.w, u.h),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.9,
      color: 0xb9c4cd, // 壓暗紙白，貼合深色主題
      depthWrite: false,
    })
  );
  sheet.rotation.x = -Math.PI / 2;
  sheet.position.set(u.x, 0.04, u.z); // 在網格之上、設備之下
  plantGroup.add(sheet);
}

// 場景敷設（精細模式限定）：防溢堤、管線法蘭與管架、照明桿
function buildDressing() {
  const g = new THREE.Group();
  // 儲槽區防溢堤（沿電子圍籬多邊形）
  const bund = plantData.fence?.polygon;
  if (bund) {
    for (let i = 0; i < bund.length; i++) {
      const a = bund[i], b = bund[(i + 1) % bund.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(len, 0.55, 0.18), dm.concrete);
      wall.position.set((a[0] + b[0]) / 2, 0.275, (a[1] + b[1]) / 2);
      wall.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      g.add(wall);
    }
  }
  // 主管線：接頭法蘭對+管架支撐（P&ID 自動抽取的大量管線跳過——敷設是給
  // 手繪示範廠的細節，數千段的法蘭/管架會拖垮效能）
  for (const pipe of plantData.pipes.length > 60 ? [] : plantData.pipes) {
    const pts = pipe.pts.map((p) => new THREE.Vector3(...p));
    for (let i = 1; i < pts.length - 1; i++) {
      const fl = dFlange(pipe.r * 1.8, dm.steelDark);
      const dir = pts[i + 1].clone().sub(pts[i - 1]).normalize();
      fl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      fl.position.copy(pts[i]);
      g.add(fl);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = pts[i].clone().lerp(pts[i + 1], 0.5);
      if (mid.y > 1.6) continue;
      const sup = new THREE.Mesh(new THREE.BoxGeometry(0.1, mid.y, 0.1), dm.steelDark);
      sup.position.set(mid.x, mid.y / 2, mid.z);
      g.add(sup);
      const cross = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 0.12), dm.steelDark);
      cross.position.set(mid.x, mid.y - pipe.r - 0.04, mid.z);
      g.add(cross);
    }
  }
  // 廠區照明桿
  for (const [lx, lz] of [[-14, 10], [14, 8]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 6, 10), dm.galv);
    pole.position.set(lx, 3, lz);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.07, 0.07), dm.galv);
    arm.position.set(lx + 0.5, 5.9, lz);
    const lampHead = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.25), dm.lamp);
    lampHead.position.set(lx + 1.0, 5.85, lz);
    g.add(pole, arm, lampHead);
  }
  const merged = mergeByMaterial(g);
  markShadow(merged);
  return merged;
}


const eqMap = {}; // tag → { group(殼層), body(可換本體), def, unitName, labelEl, treeEl }

function setEquipmentBody(entry, builderSet) {
  if (entry.body) entry.group.remove(entry.body);
  // 精細建模器共用材質物件，警報脈動會改 emissive → 每台 clone 材質避免互相污染
  // 新素材（編輯器擴充）尚無精細版 → fallback 簡易幾何
  const build = builderSet[entry.def.type] ?? builders[entry.def.type];
  let body = build(entry.def.dims);
  if (builderSet === detailedBuilders && builderSet[entry.def.type]) body = mergeByMaterial(body);
  body.traverse((o) => {
    if (o.isMesh) {
      o.material = o.material.clone();
      o.userData.eqTag = entry.def.tag;
      o.userData.baseEmissive = o.material.emissive.getHex();
      o.userData.baseIntensity = o.material.emissiveIntensity ?? 1;
    }
  });
  markShadow(body);
  entry.group.add(body);
  entry.body = body;
}

for (const unit of plantData.plant.units) {
  for (const eq of unit.equipment) {
    const group = new THREE.Group();
    group.position.set(...eq.pos);
    group.rotation.y = eq.rot_y ?? 0; // 編輯器可存旋轉
    plantGroup.add(group);

    const labelEl = document.createElement('div');
    labelEl.className = 'eq-label';
    labelEl.textContent = eq.tag;
    labelEl.style.pointerEvents = 'auto';
    labelEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); selectEquipment(eq.tag, true); });
    const label = new CSS2DObject(labelEl);
    label.position.set(0, labelHeight(eq), 0);
    group.add(label);

    const entry = { group, body: null, def: eq, unitName: unit.name, labelEl, treeEl: null };
    setEquipmentBody(entry, builders);
    eqMap[eq.tag] = entry;
  }
}

// 管線（裝飾用，串接設備）
// P&ID 自動抽取的管線可達數千段——合併成單一 BufferGeometry（一次 draw call），
// 手繪少量管線走原路徑（個別 mesh 保留陰影品質）
const pipeMat = std(0x646f7b);
const bridgeMat = std(0x2e8ba8); // 跨圖橋接管：主題青，一眼辨識「這條是縫合線」
{
  const manyPipes = plantData.pipes.length > 60;
  const geos = [];
  const bridgeGeos = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const pipe of plantData.pipes) {
    const pts = pipe.pts.map((p) => new THREE.Vector3(...p));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dir = b.clone().sub(a);
      const len = dir.length();
      if (len < 0.01) continue;
      const cylGeo = new THREE.CylinderGeometry(pipe.r, pipe.r, len, manyPipes ? 6 : 12);
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
      const mid = a.clone().addScaledVector(dir, 0.5);
      cylGeo.applyQuaternion(q);
      cylGeo.translate(mid.x, mid.y, mid.z);
      if (manyPipes) {
        (pipe.bridge ? bridgeGeos : geos).push(cylGeo);
      } else {
        const cyl = new THREE.Mesh(cylGeo, pipe.bridge ? bridgeMat : pipeMat);
        cyl.castShadow = true;
        plantGroup.add(cyl);
        const joint = new THREE.Mesh(new THREE.SphereGeometry(pipe.r * 1.3, 10, 8), pipeMat);
        joint.position.copy(b);
        plantGroup.add(joint);
      }
    }
  }
  for (const [gs, mat] of [[geos, pipeMat], [bridgeGeos, bridgeMat]]) {
    if (!gs.length) continue;
    const merged = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(gs, false), mat);
    merged.castShadow = false; // 數千段的陰影貼圖成本不值得
    plantGroup.add(merged);
  }
}

// 掃描/外部資產載入：把重建出的 .glb/.gltf 丟進 scans/ 並在 plant.json 的 scan_models 設定位置
function flyToScanAsset(sm) {
  const focus = new THREE.Vector3(...(sm.pos ?? [0, 0, 0])).add(new THREE.Vector3(0, 1.2, 0));
  const dir = camera.position.clone().sub(controls.target).normalize();
  const toPos = focus.clone().addScaledVector(dir, 8);
  toPos.y = Math.max(toPos.y, 4);
  flyCam(toPos, focus);
}

for (const sm of plantData.scan_models ?? []) {
  new GLTFLoader().load(`/scans/${sm.file}`, (gltf) => {
    const holder = new THREE.Group();
    holder.add(gltf.scene);
    holder.position.set(...(sm.pos ?? [0, 0, 0]));
    holder.rotation.y = sm.rot_y ?? 0;
    const s = sm.scale ?? 1;
    holder.scale.set(s, s, s);
    markShadow(holder);
    // 掃描資產通常自帶較暗的 PBR 貼圖，補一盞填充光
    const fill = new THREE.PointLight(0xcfe3f0, 30, 16, 2);
    fill.position.set(0, 3, 0);
    holder.add(fill);
    if (sm.label) {
      const el = document.createElement('div');
      el.className = 'eq-label';
      el.textContent = sm.label;
      el.style.pointerEvents = 'auto';
      el.addEventListener('pointerdown', (e) => { e.stopPropagation(); flyToScanAsset(sm); });
      const lbl = new CSS2DObject(el);
      lbl.position.set(0, 2.2, 0);
      holder.add(lbl);
    }
    plantGroup.add(holder);
  }, undefined, (err) => console.error('scan model 載入失敗:', sm.file, err));
}

// ---------------------------------------------------------------- 設備樹 UI
const treeRoot = document.getElementById('plant-tree');
for (const unit of plantData.plant.units) {
  const unitDiv = document.createElement('div');
  unitDiv.className = 'tree-unit';
  // P&ID 場景的 unit.name 已含圖號（「分離｜C12070-1」）— 不再重複前綴 id
  const unitLabel = unit.name.includes(unit.id) ? unit.name : `${unit.id}｜${unit.name}`;
  unitDiv.innerHTML = `<div class="tree-unit-name">${unitLabel}</div>`;
  for (const eq of unit.equipment) {
    const item = document.createElement('div');
    item.className = 'tree-eq';
    item.innerHTML = `<span class="eq-tag">${eq.tag}</span><span class="eq-name">${eq.name}</span>`;
    item.addEventListener('click', () => selectEquipment(eq.tag, true));
    unitDiv.appendChild(item);
    eqMap[eq.tag].treeEl = item;
  }
  treeRoot.appendChild(unitDiv);
}

// 設備樹收合（狀態記 localStorage）
{
  const leftPanel = document.getElementById('left-panel');
  const expandBtn = document.getElementById('tree-expand');
  const setCollapsed = (on) => {
    leftPanel.classList.toggle('hidden', on);
    expandBtn.classList.toggle('hidden', !on);
    localStorage.setItem('ej-tree-collapsed', on ? '1' : '');
  };
  document.getElementById('tree-collapse').addEventListener('click', () => setCollapsed(true));
  expandBtn.addEventListener('click', () => setCollapsed(false));
  if (localStorage.getItem('ej-tree-collapsed') === '1') setCollapsed(true);
}

// 外部資產也列進設備樹，點擊飛到定位
if (plantData.scan_models?.length) {
  const extDiv = document.createElement('div');
  extDiv.className = 'tree-unit';
  extDiv.innerHTML = '<div class="tree-unit-name">EXT｜外部資產（公開資料示範）</div>';
  for (const sm of plantData.scan_models) {
    const item = document.createElement('div');
    item.className = 'tree-eq';
    item.innerHTML = `<span class="eq-tag">GLB</span><span class="eq-name">${sm.label ?? sm.file}</span>`;
    item.addEventListener('click', () => flyToScanAsset(sm));
    extDiv.appendChild(item);
  }
  treeRoot.appendChild(extDiv);
}

// ---------------------------------------------------------------- 選取邏輯
let selectedTag = null;
const camTween = { active: false, t: 0, fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(), fromTgt: new THREE.Vector3(), toTgt: new THREE.Vector3() };

function flyCam(toPos, toTgt) {
  camTween.fromPos.copy(camera.position);
  camTween.toPos.copy(toPos);
  camTween.fromTgt.copy(controls.target);
  camTween.toTgt.copy(toTgt);
  camTween.t = 0;
  camTween.active = true;
}

// console／導覽用：EJ3D.fly([camX,camY,camZ],[lookX,lookY,lookZ])
window.EJ3D = { fly: (p, t) => flyCam(new THREE.Vector3(...p), new THREE.Vector3(...t)) };

function selectEquipment(tag, flyTo = false) {
  if (selectedTag && eqMap[selectedTag]) eqMap[selectedTag].treeEl.classList.remove('active');
  selectedTag = tag;
  const entry = eqMap[tag];
  entry.treeEl.classList.add('active');
  renderInfoCard(entry);
  if (flyTo) {
    const p = entry.group.position;
    const focus = new THREE.Vector3(p.x, labelHeight(entry.def) * 0.45, p.z);
    const dir = camera.position.clone().sub(controls.target).normalize();
    const toPos = focus.clone().addScaledVector(dir, 11);
    toPos.y = Math.max(toPos.y, 5);
    flyCam(toPos, focus);
  }
}

const infoCard = document.getElementById('info-card');
document.getElementById('info-close').addEventListener('click', () => {
  infoCard.classList.add('hidden');
  clearInterval(sparkTimer);
  if (selectedTag) { eqMap[selectedTag].treeEl.classList.remove('active'); selectedTag = null; }
});

function renderInfoCard(entry) {
  const eq = entry.def;
  document.getElementById('info-tag').textContent = eq.tag;
  document.getElementById('info-name').textContent = eq.name;
  document.getElementById('info-meta').textContent = `${entry.unitName}｜類型：${eq.type}｜圖面：${eq.pid_ref}`;
  document.getElementById('info-design').innerHTML = Object.entries(eq.design)
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  document.getElementById('info-instruments').innerHTML = eq.instruments.length
    ? eq.instruments.map((t) => `
        <tr><td>${t}</td><td><span class="inst-val" id="inst-${t}">--</span></td></tr>
        <tr class="spark-row"><td colspan="2"><svg class="spark" id="spark-${t}" viewBox="0 0 240 36" preserveAspectRatio="none"></svg></td></tr>`).join('')
    : '<tr><td colspan="2">（無儀錶點位）</td></tr>';
  infoCard.classList.remove('hidden');
  refreshSparks(eq.instruments);
}

// 趨勢 sparkline：資訊卡開啟時每 2 秒拉時序歷史重畫
let sparkTimer = null;
async function refreshSparks(tags) {
  clearInterval(sparkTimer);
  const draw = async () => {
    for (const tag of tags) {
      const el = document.getElementById(`spark-${tag}`);
      if (!el) return; // 資訊卡已換設備/關閉
      const hist = await fetch(`/api/history/${tag}?n=300`).then((r) => r.json()).catch(() => []);
      if (hist.length < 2) continue;
      const vs = hist.map((p) => p[1]);
      const min = Math.min(...vs), max = Math.max(...vs);
      const spanV = max - min || 1;
      const pts = vs.map((v, i) => `${(i / (vs.length - 1)) * 240},${33 - ((v - min) / spanV) * 30}`).join(' ');
      const inst = instrumentDefs[tag];
      const hiY = inst?.alarm_hi != null && inst.alarm_hi >= min && inst.alarm_hi <= max
        ? 33 - ((inst.alarm_hi - min) / spanV) * 30 : null;
      el.innerHTML = `
        ${hiY !== null ? `<line x1="0" y1="${hiY}" x2="240" y2="${hiY}" stroke="#ff4d4f" stroke-width="0.8" stroke-dasharray="4 3"/>` : ''}
        <polyline points="${pts}" fill="none" stroke="#46c2e0" stroke-width="1.5"/>
        <text x="2" y="9" font-size="8" fill="#8ba0b3">${max.toFixed(1)}</text>
        <text x="2" y="34" font-size="8" fill="#8ba0b3">${min.toFixed(1)}</text>`;
    }
  };
  await draw();
  sparkTimer = setInterval(draw, 2000);
}

// 點擊 3D 物件選取（區分拖曳與點擊）
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (splatMode) return; // 掃描檢視模式下不做設備選取
  if (!downXY || Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) > 5) return;
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  for (const hit of raycaster.intersectObjects(scene.children, true)) {
    let o = hit.object;
    while (o && !o.userData?.eqTag) o = o.parent;
    if (o?.userData?.eqTag) { selectEquipment(o.userData.eqTag, true); return; }
  }
});

// ---------------------------------------------------------------- 情境特效
const fx = { group: null, gas: null, fire: null, smoke: null, shock: null, arrows: [], path: null, dangerMat: null };

function makeSpriteTexture(inner = 'rgba(255,255,255,0.9)') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
const softTex = makeSpriteTexture();

class Emitter {
  constructor({ count, color, origin, velFn, life, sizeFn, opacity, blending }) {
    this.origin = new THREE.Vector3(...origin);
    this.velFn = velFn;
    this.life = life;
    this.sizeFn = sizeFn;
    this.baseOpacity = opacity;
    this.parts = [];
    this.group = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({
        map: softTex, color, transparent: true, opacity: 0, depthWrite: false,
        blending: blending ?? THREE.NormalBlending,
      });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      this.group.add(sp);
      this.parts.push({ sp, age: 0, lifespan: 0, vel: new THREE.Vector3(), alive: false });
    }
    this.cursor = 0;
  }
  spawn(n) {
    for (let i = 0; i < n; i++) {
      const p = this.parts[this.cursor];
      this.cursor = (this.cursor + 1) % this.parts.length;
      p.alive = true;
      p.age = 0;
      p.lifespan = this.life[0] + Math.random() * (this.life[1] - this.life[0]);
      p.sp.visible = true;
      p.sp.position.copy(this.origin).add(new THREE.Vector3((Math.random() - 0.5) * 0.5, Math.random() * 0.3, (Math.random() - 0.5) * 0.5));
      p.vel.copy(this.velFn());
    }
  }
  update(dt, rate) {
    this.acc = (this.acc ?? 0) + rate * dt;
    const n = Math.floor(this.acc);
    if (n > 0) { this.spawn(n); this.acc -= n; }
    for (const p of this.parts) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.lifespan) { p.alive = false; p.sp.visible = false; continue; }
      const k = p.age / p.lifespan;
      p.sp.position.addScaledVector(p.vel, dt);
      const s = this.sizeFn(k);
      p.sp.scale.set(s, s, 1);
      p.sp.material.opacity = this.baseOpacity * (1 - k);
    }
  }
}

function clearFx() {
  if (fx.group) { plantGroup.remove(fx.group); fx.group = null; }
  fx.gas = fx.fire = fx.smoke = fx.shock = fx.path = fx.dangerMat = null;
  fx.arrows = [];
}

function buildDangerZone(sc, parent) {
  const dz = sc.danger_zone;
  const zone = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: 0xff2a2d, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false })
  );
  zone.scale.set(dz.rx, dz.rz, 1);
  if (sc.wind) zone.rotation.z = -Math.atan2(sc.wind[2], sc.wind[0]);
  const holder = new THREE.Group();
  holder.rotation.x = -Math.PI / 2;
  holder.position.set(dz.center[0], 0.04, dz.center[2]);
  holder.add(zone);
  parent.add(holder);
  fx.dangerMat = zone.material;

  const edgePts = [];
  for (let i = 0; i <= 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    edgePts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
  }
  const edge = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(edgePts),
    new THREE.LineBasicMaterial({ color: 0xff2a2d, transparent: true, opacity: 0.7 })
  );
  edge.scale.copy(zone.scale);
  edge.rotation.copy(zone.rotation);
  holder.add(edge);
}

function buildEvacPath(sc, parent) {
  const pts = sc.evac_path.map((p) => new THREE.Vector3(p[0], 0.08, p[2]));
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0x35e08c, dashSize: 0.7, gapSize: 0.45, linewidth: 2 })
  );
  line.computeLineDistances();
  parent.add(line);

  // 累計長度，供箭頭沿線移動
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = cum[cum.length - 1];
  const posAt = (dist) => {
    for (let i = 1; i < pts.length; i++) {
      if (dist <= cum[i]) {
        const k = (dist - cum[i - 1]) / (cum[i] - cum[i - 1]);
        return {
          p: pts[i - 1].clone().lerp(pts[i], k),
          dir: pts[i].clone().sub(pts[i - 1]).normalize(),
        };
      }
    }
    return { p: pts.at(-1).clone(), dir: new THREE.Vector3(0, 0, 1) };
  };
  for (let i = 0; i < 4; i++) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.28, 0.75, 12),
      new THREE.MeshBasicMaterial({ color: 0x35e08c })
    );
    cone.position.y = 0.3;
    parent.add(cone);
    fx.arrows.push({ cone, s: i / 4, total, posAt });
  }

  // 集合點
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.9, 1.25, 40),
    new THREE.MeshBasicMaterial({ color: 0x35e08c, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(sc.muster[0], 0.05, sc.muster[2]);
  parent.add(ring);
  const musterEl = document.createElement('div');
  musterEl.className = 'muster-label';
  musterEl.textContent = '⛑ 集合點';
  const musterLabel = new CSS2DObject(musterEl);
  musterLabel.position.set(sc.muster[0], 1.2, sc.muster[2]);
  parent.add(musterLabel);
}

function applyScenario(sid) {
  clearFx();
  const sc = scenarioDefs[sid];
  document.getElementById('scenario-desc').textContent = sc.desc || '';
  if (sc.kind === 'normal') return;

  fx.group = new THREE.Group();
  plantGroup.add(fx.group);
  buildDangerZone(sc, fx.group);
  buildEvacPath(sc, fx.group);

  if (sc.kind === 'gas_leak') {
    const wind = new THREE.Vector3(...sc.wind).normalize().multiplyScalar(sc.wind_speed * 0.55);
    fx.gas = new Emitter({
      count: 260,
      color: new THREE.Color(sc.gas_color || '#dfe6ea'),
      origin: sc.leak_point,
      velFn: () => wind.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.35 + Math.random() * 0.4, (Math.random() - 0.5) * 0.5)),
      life: [4.5, 7],
      sizeFn: (k) => 0.6 + k * 3.2,
      opacity: 0.42,
    });
    fx.group.add(fx.gas.group);
  } else if (sc.kind === 'fire') {
    fx.fire = new Emitter({
      count: 140,
      color: new THREE.Color('#ff9a2a'),
      origin: sc.leak_point,
      velFn: () => new THREE.Vector3((Math.random() - 0.5) * 0.7, 2.2 + Math.random() * 1.2, (Math.random() - 0.5) * 0.7),
      life: [0.6, 1.2],
      sizeFn: (k) => 1.1 * (1 - k * 0.6),
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
    });
    fx.smoke = new Emitter({
      count: 160,
      color: new THREE.Color('#4a4f55'),
      origin: [sc.leak_point[0], sc.leak_point[1] + 1.4, sc.leak_point[2]],
      velFn: () => new THREE.Vector3((Math.random() - 0.3) * 0.6, 1.1 + Math.random() * 0.7, (Math.random() - 0.5) * 0.6),
      life: [3, 5.5],
      sizeFn: (k) => 0.8 + k * 3.5,
      opacity: 0.4,
    });
    fx.group.add(fx.fire.group, fx.smoke.group);
  } else if (sc.kind === 'explosion') {
    // 火球（加色混合、向四面八方噴）＋濃煙＋地面衝擊波環（循環擴張）
    fx.fire = new Emitter({
      count: 240,
      color: new THREE.Color('#ff8420'),
      origin: sc.leak_point,
      velFn: () => new THREE.Vector3((Math.random() - 0.5) * 3.2, 1.4 + Math.random() * 2.4, (Math.random() - 0.5) * 3.2),
      life: [0.5, 1.1],
      sizeFn: (k) => 1.7 * (1 - k * 0.35),
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
    });
    fx.smoke = new Emitter({
      count: 220,
      color: new THREE.Color('#2f3338'),
      origin: [sc.leak_point[0], sc.leak_point[1] + 1.2, sc.leak_point[2]],
      velFn: () => new THREE.Vector3((Math.random() - 0.5) * 1.4, 1.4 + Math.random() * 1.0, (Math.random() - 0.5) * 1.4),
      life: [3.5, 6],
      sizeFn: (k) => 1.2 + k * 4.5,
      opacity: 0.5,
    });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xffc46a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(sc.leak_point[0], 0.12, sc.leak_point[2]);
    fx.group.add(ring);
    fx.shock = { ring, t: 0, rMax: Math.max(sc.danger_zone.rx, sc.danger_zone.rz) };
    fx.group.add(fx.fire.group, fx.smoke.group);
  }
}

// ---------------------------------------------------------------- 情境按鈕
const scButtons = {};
const btnHolder = document.getElementById('scenario-buttons');
let currentScenario = 'normal';
for (const sc of scenarioList) {
  const btn = document.createElement('button');
  btn.className = 'sc-btn' + (sc.kind !== 'normal' ? ' danger' : '') + (sc.id === 'normal' ? ' active' : '');
  btn.textContent = sc.name;
  btn.title = sc.desc;
  btn.addEventListener('click', async () => {
    await fetch(`/api/scenario/${sc.id}`, { method: 'POST' });
    setScenario(sc.id);
  });
  btnHolder.appendChild(btn);
  scButtons[sc.id] = btn;
}
function setScenario(sid) {
  if (sid === currentScenario) return;
  currentScenario = sid;
  Object.entries(scButtons).forEach(([id, b]) => b.classList.toggle('active', id === sid));
  applyScenario(sid);
}

// ------------------------------------------------------- 3DGS 掃描檢視模式
// 真實掃描（3D Gaussian Splatting）與程式生成示範廠互切：
// 之後 Luma/Postshot 匯出的 .ply/.splat/.ksplat 丟進 scans/、改 plant.json 的 splat_scene 即可
const DEFAULT_VIEW = { pos: new THREE.Vector3(17, 13, 20), target: new THREE.Vector3(0, 1, 0) };
let splatMode = false;
let splatViewer = null;
const viewToggle = document.getElementById('view-toggle');
if (!plantData.splat_scene) viewToggle.style.display = 'none';

async function ensureSplatLoaded() {
  if (splatViewer) return;
  const cfg = plantData.splat_scene;
  const GS = await import('@mkkellogg/gaussian-splats-3d');
  // 無 COOP/COEP 標頭的環境不能用 SharedArrayBuffer，關閉共享記憶體排序
  splatViewer = new GS.DropInViewer({ sharedMemoryForWorkers: false, gpuAcceleratedSort: false });
  await splatViewer.addSplatScene(`/scans/${cfg.file}`, {
    position: cfg.pos ?? [0, 0, 0],
    rotation: cfg.rot ?? [0, 0, 0, 1],
    scale: [cfg.scale ?? 1, cfg.scale ?? 1, cfg.scale ?? 1],
    splatAlphaRemovalThreshold: 5,
    progressiveLoad: false,
  });
  splatViewer.visible = false;
  scene.add(splatViewer);
}

viewToggle.addEventListener('click', async () => {
  if (viewToggle.disabled) return;
  try {
    if (!splatMode) {
      viewToggle.disabled = true;
      viewToggle.textContent = '3DGS 載入中…';
      await ensureSplatLoaded();
      splatMode = true;
      plantGroup.visible = false;
      splatViewer.visible = true;
      renderer.setPixelRatio(1); // 3DGS 過繪很重，降取樣減輕內顯負擔
      document.body.classList.add('splat-mode');
      const c = plantData.splat_scene.camera;
      flyCam(new THREE.Vector3(...c.pos), new THREE.Vector3(...c.target));
      viewToggle.textContent = '返回示範廠';
    } else {
      splatMode = false;
      plantGroup.visible = true;
      if (splatViewer) splatViewer.visible = false;
      renderer.setPixelRatio(QUALITY[qualityTier].pr);
      document.body.classList.remove('splat-mode');
      flyCam(DEFAULT_VIEW.pos.clone(), DEFAULT_VIEW.target.clone());
      viewToggle.textContent = '3DGS 掃描檢視';
    }
  } catch (err) {
    console.error('3DGS 載入失敗:', err);
    viewToggle.textContent = '3DGS 載入失敗';
  } finally {
    viewToggle.disabled = false;
  }
});

// ------------------------------------------------- AI 情境比對（異常注入盲測）
// 簡報「預設情境比對法」：注入異常感測訊號 → 後端依 DCS 偏移特徵向量
// 對 10 個預載情境做相似度比對 → 信心值過門檻自動確認並觸發 3D 情境
const matchPanel = document.getElementById('match-panel');
const matchStatus = document.getElementById('match-status');
const matchList = document.getElementById('match-list');
const injectBtn = document.getElementById('btn-inject');
let injectActive = false;

function renderMatch(m) {
  const active = !!(m && m.active);
  if (active !== injectActive) {
    injectActive = active;
    injectBtn.classList.toggle('active', active);
    injectBtn.textContent = active ? '⏹ 停止注入' : '⚡ 異常注入（盲測）';
    matchPanel.classList.toggle('hidden', !active);
    if (!active) {
      matchStatus.textContent = '監看 DCS 特徵中…';
      matchStatus.classList.remove('confirmed');
      matchList.innerHTML = '';
    }
  }
  if (!active) return;
  const top = m.ranked[0];
  if (m.confirmed && top) {
    matchStatus.textContent = `✔ 已確認（信心 ${Math.round(top.conf * 100)}%）：${scenarioDefs[m.truth]?.name ?? top.name}`;
    matchStatus.classList.add('confirmed');
  } else {
    matchStatus.textContent = '⟳ DCS 感測偏移發展中，比對進行中…';
    matchStatus.classList.remove('confirmed');
  }
  matchList.innerHTML = m.ranked.map((r, i) => `
    <div class="match-row${i === 0 ? ' best' : ''}">
      <div class="match-row-head"><span>${r.name}</span><span class="conf">${Math.round(r.conf * 100)}%</span></div>
      <div class="match-bar"><i style="width:${Math.min(100, r.conf * 100)}%"></i></div>
    </div>`).join('');
}

injectBtn.addEventListener('click', async () => {
  await fetch(injectActive ? '/api/inject/stop' : '/api/inject/random', { method: 'POST' });
});

// ----------------------------------------------- 工安 AI：圍籬／攝影機／人員
const fencePoly = plantData.fence?.polygon ?? [];
const FENCE_H = 1.4;
const safetyGroup = new THREE.Group();
plantGroup.add(safetyGroup);
const fenceMats = [];

if (fencePoly.length) {
  for (let i = 0; i < fencePoly.length; i++) {
    const a = fencePoly[i], b = fencePoly[(i + 1) % fencePoly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd23c, transparent: true, opacity: 0.09, side: THREE.DoubleSide, depthWrite: false });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(len, FENCE_H), mat);
    wall.position.set((a[0] + b[0]) / 2, FENCE_H / 2, (a[1] + b[1]) / 2);
    wall.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
    safetyGroup.add(wall);
    fenceMats.push(mat);
  }
  const ring = [...fencePoly, fencePoly[0]];
  const topLineMat = new THREE.LineBasicMaterial({ color: 0xffd23c, transparent: true, opacity: 0.8 });
  const topLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(ring.map((p) => new THREE.Vector3(p[0], FENCE_H, p[1]))),
    topLineMat
  );
  safetyGroup.add(topLine);
  fenceMats.push(topLineMat);
  const fenceEl = document.createElement('div');
  fenceEl.className = 'cam-label';
  fenceEl.textContent = `⛔ ${plantData.fence.name}`;
  const fenceLabel = new CSS2DObject(fenceEl);
  const cx = fencePoly.reduce((s, p) => s + p[0], 0) / fencePoly.length;
  const cz = Math.max(...fencePoly.map((p) => p[1]));
  fenceLabel.position.set(cx, FENCE_H + 0.5, cz);
  safetyGroup.add(fenceLabel);
}

function inFence(x, z) {
  let inside = false;
  for (let i = 0, j = fencePoly.length - 1; i < fencePoly.length; j = i++) {
    const [xi, zi] = fencePoly[i], [xj, zj] = fencePoly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// AI 攝影機：桿＋雲台＋視錐（實際專案由 NVR/AI box 推播辨識事件，這裡以幾何模擬）
const cams = [];
for (const c of plantData.cameras ?? []) {
  const pos = new THREE.Vector3(...c.pos);
  const look = new THREE.Vector3(...c.look);
  const dir = look.clone().sub(pos).normalize();
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, pos.y, 10), std(0x4a5560));
  pole.position.set(pos.x, pos.y / 2, pos.z);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.32), std(0x1f6ea8, { emissive: 0x0d2f47, emissiveIntensity: 0.7 }));
  head.position.copy(pos);
  head.lookAt(look);
  const coneR = Math.tan(THREE.MathUtils.degToRad(c.fov / 2)) * c.range;
  const coneGeo = new THREE.ConeGeometry(coneR, c.range, 24, 1, true);
  coneGeo.translate(0, -c.range / 2, 0); // 錐頂移到原點（攝影機處）
  const coneMat = new THREE.MeshBasicMaterial({ color: 0x46c2e0, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.copy(pos);
  cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
  const el = document.createElement('div');
  el.className = 'cam-label';
  el.textContent = `📹 ${c.id}`;
  el.title = c.name;
  const label = new CSS2DObject(el);
  label.position.set(pos.x, pos.y + 0.55, pos.z);
  g.add(pole, head, cone, label);
  markShadow(pole);
  safetyGroup.add(g);
  cams.push({ def: c, pos, dir, cosHalf: Math.cos(THREE.MathUtils.degToRad(c.fov / 2)), range: c.range, coneMat });
}

function seenByCamera(p) {
  for (const c of cams) {
    const v = p.clone().sub(c.pos);
    const d = v.length();
    if (d < c.range && v.normalize().dot(c.dir) > c.cosHalf) return c;
  }
  return null;
}

// 模擬人員：沿巡檢動線走，AI 攝影機視野內做闖入／PPE 判定
// 兩種人形：簡易（膠囊）／精細（四肢+反光背心+安全帽，行走擺動）
function buildWorkerSimple(w) {
  const g = new THREE.Group();
  const vest = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.62, 6, 12), std(0xff7a1a, { metalness: 0.1, roughness: 0.8 }));
  vest.position.y = 0.75;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 16, 12), std(0xe0b48c, { metalness: 0, roughness: 0.9 }));
  head.position.y = 1.35;
  g.add(vest, head);
  if (w.helmet) {
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.175, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      std(0xffd23c, { metalness: 0.2, roughness: 0.5 })
    );
    helmet.position.y = 1.37;
    g.add(helmet);
  }
  markShadow(g);
  return { body: g, limbs: null };
}

function buildWorkerDetailed(w) {
  const g = new THREE.Group();
  const navy = new THREE.MeshStandardMaterial({ color: 0x2b3f55, roughness: 0.85, metalness: 0.05 });
  const vestM = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.8, metalness: 0.05 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xd9dee2, roughness: 0.4, emissive: 0x8a9298, emissiveIntensity: 0.5 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0b48c, roughness: 0.9 });
  const limbs = {};
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -0.09 : 0.09;
    const hip = new THREE.Group(); // 髖關節（腿掛在下面擺動）
    hip.position.set(sx, 0.72, 0);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.7, 0.15), navy);
    leg.position.y = -0.35;
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.09, 0.24), new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.9 }));
    shoe.position.set(0, -0.72, 0.04);
    hip.add(leg, shoe);
    g.add(hip);
    limbs[`leg${side}`] = hip;
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * 3.1, 1.24, 0);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.12), vestM);
    arm.position.y = -0.26;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), skin);
    hand.position.y = -0.56;
    shoulder.add(arm, hand);
    g.add(shoulder);
    limbs[`arm${side}`] = shoulder;
  }
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.58, 0.24), vestM);
  torso.position.y = 1.02;
  g.add(torso);
  for (const sy of [0.92, 1.12]) { // 反光條
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.05, 0.26), stripe);
    band.position.y = sy;
    g.add(band);
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), skin);
  head.position.y = 1.46;
  g.add(head);
  if (w.helmet) {
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), dm.safetyY);
    helmet.position.y = 1.47;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.02, 16), dm.safetyY);
    brim.position.y = 1.48;
    g.add(helmet, brim);
  } else {
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.145, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.95 }));
    hair.position.y = 1.47;
    g.add(hair);
  }
  markShadow(g);
  return { body: g, limbs };
}

const workers = [];
function setWorkerBody(w, detailed) {
  if (w.body) w.group.remove(w.body);
  const { body, limbs } = (detailed ? buildWorkerDetailed : buildWorkerSimple)(w.def);
  w.group.add(body);
  w.body = body;
  w.limbs = limbs;
}

for (const w of plantData.workers ?? []) {
  const g = new THREE.Group();
  const el = document.createElement('div');
  el.className = 'worker-label';
  el.textContent = w.name;
  const label = new CSS2DObject(el);
  label.position.set(0, 1.9, 0);
  g.add(label);
  g.position.set(w.loop[0][0], 0, w.loop[0][1]);
  safetyGroup.add(g);
  const entry = { def: w, group: g, body: null, limbs: null, phase: 0, moving: false, labelEl: el, wp: 1, mode: 'loop', dwell: 0, path: null, pi: 0 };
  setWorkerBody(entry, false);
  workers.push(entry);
}

const visionChip = document.getElementById('vision-chip');
const visionStatus = document.getElementById('vision-status');
const intrudeBtn = document.getElementById('btn-intrude');

intrudeBtn.addEventListener('click', () => {
  const w = workers.find((x) => x.def.intrude_to);
  if (!w || w.mode !== 'loop') return;
  w.mode = 'intrude';
  w.path = [...w.def.intrude_to];
  w.pi = 0;
});

function stepWorker(w, dt) {
  const speed = w.def.speed;
  w.moving = false;
  let target;
  if (w.mode === 'loop') {
    target = w.def.loop[w.wp];
  } else if (w.mode === 'intrude') {
    target = w.path[w.pi];
  } else if (w.mode === 'dwell') {
    w.dwell -= dt;
    if (w.dwell <= 0) { w.mode = 'return'; w.pi = w.path.length - 1; }
    return;
  } else { // return（原路走回）
    target = w.path[w.pi];
  }
  const p = w.group.position;
  const dx = target[0] - p.x, dz = target[1] - p.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.15) {
    if (w.mode === 'loop') w.wp = (w.wp + 1) % w.def.loop.length;
    else if (w.mode === 'intrude') {
      w.pi++;
      if (w.pi >= w.path.length) { w.mode = 'dwell'; w.dwell = 5; }
    } else { // return
      w.pi--;
      if (w.pi < 0) { w.mode = 'loop'; w.path = null; }
    }
    return;
  }
  const step = Math.min(speed * dt, dist);
  p.x += (dx / dist) * step;
  p.z += (dz / dist) * step;
  w.group.rotation.y = Math.atan2(dx, dz);
  w.moving = true;
}

const _wp = new THREE.Vector3();
function updateSafety(dt, t) {
  const events = [];
  for (const w of workers) {
    stepWorker(w, dt);
    // 精細人形行走擺動
    if (w.limbs) {
      if (w.moving) w.phase += dt * 5.2 * w.def.speed;
      const s = w.moving ? Math.sin(w.phase) * 0.55 : 0;
      w.limbs.legL.rotation.x = s;
      w.limbs.legR.rotation.x = -s;
      w.limbs.armL.rotation.x = -s * 0.8;
      w.limbs.armR.rotation.x = s * 0.8;
    }
    _wp.set(w.group.position.x, 0.9, w.group.position.z);
    const cam = seenByCamera(_wp);
    let violation = null;
    if (cam && fencePoly.length && inFence(_wp.x, _wp.z)) {
      violation = `闖入管制區（${cam.def.id}）`;
    } else if (cam && !w.def.helmet) {
      violation = `未戴安全帽（${cam.def.id}）`;
    }
    if (violation) {
      w.labelEl.className = 'worker-label violation';
      w.labelEl.textContent = `⚠ ${w.def.name}｜${violation}`;
      events.push(`${w.def.id} ${violation}`);
    } else {
      w.labelEl.className = 'worker-label';
      w.labelEl.textContent = w.def.name;
    }
  }
  const alarm = events.length > 0;
  visionChip.classList.toggle('alarm', alarm);
  visionStatus.textContent = alarm ? events[0] : '正常';
  const fencePulse = alarm ? 0.25 + 0.3 * Math.abs(Math.sin(t * 5)) : 0.09;
  for (const m of fenceMats) {
    m.color.setHex(alarm ? 0xff4d4f : 0xffd23c);
    if (m.transparent && m.opacity !== undefined && !m.isLineBasicMaterial) m.opacity = fencePulse;
  }
}

// -------------------------------- 真實掃描道具（Poly Haven CC0，施工場景敷設）
const propsGroup = new THREE.Group();
plantGroup.add(propsGroup);
{
  const loader = new GLTFLoader();
  for (const p of plantData.props ?? []) {
    loader.load(`/scans/${p.model}`, (gltf) => {
      // modular kit 的 gltf 是整組零件攤開；pick 指定子件名稱只取那一件
      let source = gltf.scene;
      if (p.pick) {
        const picked = gltf.scene.getObjectByName(p.pick);
        if (!picked) { console.warn('pick 不到子件:', p.model, p.pick); return; }
        picked.position.set(0, 0, 0);
        picked.rotation.set(0, 0, 0);
        source = picked;
      }
      for (const [x, y, z, ry = 0, s = 1] of p.instances) {
        const inst = source.clone(true);
        inst.position.set(x, y, z);
        inst.rotation.y = ry;
        inst.scale.setScalar(s);
        markShadow(inst);
        propsGroup.add(inst);
      }
    }, undefined, () => console.warn('道具載入失敗（先跑 tools/fetch_demo_assets.py）:', p.model));
  }
}

// ------------------------------------------ 精細/低耗能 模型切換
// 精細＝真實化工廠建模（簡報用）；低耗能＝原簡易幾何（弱機/內顯保底）
// 效能自動降階掉到「低」檔時強制退回低耗能，回升後恢復使用者選擇
let detailWanted = true;
let detailOn = false;
let dressGroup = null;

function setDetail(on) {
  if (on === detailOn) return;
  detailOn = on;
  const set = on ? detailedBuilders : builders;
  for (const entry of Object.values(eqMap)) setEquipmentBody(entry, set);
  for (const w of workers) setWorkerBody(w, on);
  if (on && !dressGroup) {
    dressGroup = buildDressing();
    plantGroup.add(dressGroup);
  }
  if (dressGroup) dressGroup.visible = on;
  propsGroup.visible = on; // 真實掃描道具跟精細模式連動（低耗能版一併卸載負擔）
  const btn = document.getElementById('detail-toggle');
  if (btn) {
    btn.classList.toggle('active', on);
    btn.textContent = on ? '精細模型' : '低耗能版';
  }
}

function syncDetailToTier() {
  setDetail(detailWanted && qualityTier !== 'low');
}

document.getElementById('detail-toggle')?.addEventListener('click', () => {
  detailWanted = !detailWanted;
  syncDetailToTier();
});
syncDetailToTier(); // 預設精細（初始檔位=高）

// -------------------------------------------- 施工模擬：規劃資產＋衝突檢測
const conGroup = new THREE.Group();
conGroup.visible = false;
plantGroup.add(conGroup);
const conflictPanel = document.getElementById('conflict-panel');
const conflictList = document.getElementById('conflict-list');
const conBtn = document.getElementById('mode-construction');
let constructionMode = false;
const conflictMarkers = [];
const conLabels = []; // CSS2DRenderer 不吃父層 visible，標籤要自己開關

function ghostMat(color = 0x46c2e0, opacity = 0.35) {
  return new THREE.MeshStandardMaterial({ color, transparent: true, opacity, metalness: 0.2, roughness: 0.6, depthWrite: false });
}

// 既有設備 → 2D 足跡障礙模型（圓柱 or 方框），供淨距計算
function buildObstacles() {
  const obs = [];
  for (const unit of plantData.plant.units) {
    for (const eq of unit.equipment) {
      const [x, , z] = eq.pos;
      const d = eq.dims;
      if (eq.type === 'reactor' || eq.type === 'tank') obs.push({ tag: eq.tag, kind: 'cyl', x, z, r: d.r, y0: 0, y1: d.h + (eq.type === 'reactor' ? d.r : 0) });
      else if (eq.type === 'hx') obs.push({ tag: eq.tag, kind: 'box', x, z, hx: d.len / 2, hz: d.r, y0: 0, y1: d.r * 2 + 0.3 });
      else if (eq.type === 'pump') obs.push({ tag: eq.tag, kind: 'box', x, z, hx: d.w / 2, hz: d.d / 2, y0: 0, y1: d.h });
      else if (eq.type === 'valve') obs.push({ tag: eq.tag, kind: 'box', x, z, hx: d.s / 2, hz: d.s / 2, y0: eq.pos[1] - d.s, y1: eq.pos[1] + d.s });
      else if (eq.type === 'detector') obs.push({ tag: eq.tag, kind: 'cyl', x, z, r: 0.2, y0: 0, y1: d.h });
      else if (eq.type === 'building') obs.push({ tag: eq.tag, kind: 'box', x, z, hx: d.w / 2, hz: d.d / 2, y0: 0, y1: d.h });
    }
  }
  return obs;
}

function obstacleGap(o, x, z) {
  if (o.kind === 'cyl') return Math.hypot(x - o.x, z - o.z) - o.r;
  const ax = Math.abs(x - o.x) - o.hx, az = Math.abs(z - o.z) - o.hz;
  if (ax <= 0 && az <= 0) return Math.max(ax, az); // 在框內 → 負值
  return Math.hypot(Math.max(ax, 0), Math.max(az, 0));
}

function detectConflicts() {
  const con = plantData.construction;
  if (!con) return [];
  const obstacles = buildObstacles();
  const clearance = con.clearance ?? 1.0;
  const found = {};
  for (const pipe of con.planned_pipes ?? []) {
    const pts = pipe.pts.map((p) => new THREE.Vector3(...p));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const segLen = a.distanceTo(b);
      const n = Math.max(2, Math.ceil(segLen / 0.25));
      for (let k = 0; k <= n; k++) {
        const p = a.clone().lerp(b, k / n);
        for (const o of obstacles) {
          if (p.y < o.y0 - pipe.r || p.y > o.y1 + pipe.r) continue;
          const gap = obstacleGap(o, p.x, p.z) - pipe.r;
          if (gap >= clearance) continue;
          const key = `${pipe.id}|${o.tag}`;
          if (!found[key] || gap < found[key].gap) {
            found[key] = { pipe: pipe.id, note: pipe.note, tag: o.tag, gap, pos: p.clone() };
          }
        }
      }
    }
  }
  return Object.values(found).sort((a, b) => a.gap - b.gap);
}

function buildConstruction() {
  const con = plantData.construction;
  if (!con) return;
  for (const eq of con.planned_equipment ?? []) {
    const g = builders[eq.type](eq.dims);
    g.traverse((o) => { if (o.isMesh) o.material = ghostMat(); });
    g.position.set(...eq.pos);
    const el = document.createElement('div');
    el.className = 'eq-label';
    el.textContent = `${eq.tag}（規劃）`;
    el.title = eq.note ?? '';
    const label = new CSS2DObject(el);
    label.position.set(0, (eq.dims.h ?? 2) + 1.2, 0);
    label.visible = false;
    conLabels.push(label);
    g.add(label);
    conGroup.add(g);
  }
  const conflicts = detectConflicts();
  const conflictSet = new Set(conflicts.map((c) => c.pipe));
  for (const pipe of con.planned_pipes ?? []) {
    const mat = ghostMat(conflictSet.has(pipe.id) ? 0xffaa3c : 0x46c2e0, 0.5);
    const pts = pipe.pts.map((p) => new THREE.Vector3(...p));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dir = b.clone().sub(a);
      const len = dir.length();
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(pipe.r, pipe.r, len, 12), mat);
      cyl.position.copy(a).addScaledVector(dir, 0.5);
      cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      conGroup.add(cyl);
    }
    const el = document.createElement('div');
    el.className = 'eq-label';
    el.textContent = `${pipe.id}（規劃）`;
    el.title = pipe.note ?? '';
    const label = new CSS2DObject(el);
    label.position.copy(pts[0]).add(new THREE.Vector3(0, 0.9, 0));
    label.visible = false;
    conLabels.push(label);
    conGroup.add(label);
  }
  // 衝突標記＋清單
  conflictList.innerHTML = conflicts.length
    ? conflicts.map((c, i) => {
        const hard = c.gap < 0;
        return `<div class="conflict-item ${hard ? 'hard' : ''}" data-ci="${i}" style="cursor:pointer">
          <span class="c-kind">${hard ? '⛔ 硬碰撞' : '⚠ 淨距不足'}</span>｜${c.pipe} × ${c.tag}<br>
          <span class="c-dist">${c.note ?? ''}｜${hard ? `干涉 ${(-c.gap).toFixed(2)} m` : `淨距 ${c.gap.toFixed(2)} m（需 ≥ ${con.clearance} m）`}</span>
        </div>`;
      }).join('')
    : '<div class="conflict-ok">✔ 規劃路徑無衝突</div>';
  conflictList.querySelectorAll('[data-ci]').forEach((el) => {
    el.addEventListener('click', () => {
      const c = conflicts[+el.dataset.ci];
      const focus = c.pos.clone();
      const dir = camera.position.clone().sub(controls.target).normalize();
      flyCam(focus.clone().addScaledVector(dir, 9).setY(Math.max(6, focus.y + 4)), focus);
    });
  });
  for (const c of conflicts) {
    const hard = c.gap < 0;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 16, 12),
      new THREE.MeshBasicMaterial({ color: hard ? 0xff4d4f : 0xffaa3c, transparent: true, opacity: 0.9, depthWrite: false })
    );
    marker.position.copy(c.pos);
    conGroup.add(marker);
    conflictMarkers.push(marker);
  }
}
buildConstruction();

conBtn.addEventListener('click', () => {
  constructionMode = !constructionMode;
  conGroup.visible = constructionMode;
  for (const l of conLabels) l.visible = constructionMode;
  conBtn.classList.toggle('active', constructionMode);
  conflictPanel.classList.toggle('hidden', !constructionMode);
  if (constructionMode) {
    // 飛到二期擴建區俯瞰
    flyCam(new THREE.Vector3(16, 14, -16), new THREE.Vector3(8, 1, -6));
  }
});

// ------------------------------------------------------------- P&ID 圖面
const pidModal = document.getElementById('pid-modal');
const pidTitle = document.getElementById('pid-title');
const pidSvg = document.getElementById('pid-svg');
document.getElementById('pid-close').addEventListener('click', () => pidModal.classList.add('hidden'));
pidModal.addEventListener('click', (e) => { if (e.target === pidModal) pidModal.classList.add('hidden'); });
document.getElementById('info-pid-btn').addEventListener('click', () => {
  if (selectedTag) openPid(eqMap[selectedTag].def, eqMap[selectedTag].unitName);
});

function pidSymbol(eq, cx, cy) {
  const S = '#9fd8ea';
  switch (eq.type) {
    case 'reactor': return `
      <rect x="${cx - 45}" y="${cy - 65}" width="90" height="130" rx="30" fill="none" stroke="${S}" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy - 95}" r="14" fill="none" stroke="${S}" stroke-width="2"/>
      <text x="${cx}" y="${cy - 90}" text-anchor="middle" font-size="12" fill="${S}">M</text>
      <line x1="${cx}" y1="${cy - 81}" x2="${cx}" y2="${cy - 20}" stroke="${S}" stroke-width="2"/>
      <line x1="${cx - 22}" y1="${cy - 10}" x2="${cx + 22}" y2="${cy - 10}" stroke="${S}" stroke-width="2"/>`;
    case 'tank': return `
      <path d="M ${cx - 50} ${cy - 55} A 50 22 0 0 1 ${cx + 50} ${cy - 55} L ${cx + 50} ${cy + 55} L ${cx - 50} ${cy + 55} Z" fill="none" stroke="${S}" stroke-width="2"/>
      <line x1="${cx - 50}" y1="${cy + 20}" x2="${cx + 50}" y2="${cy + 20}" stroke="${S}" stroke-width="1" stroke-dasharray="5 4"/>`;
    case 'pump': return `
      <circle cx="${cx}" cy="${cy}" r="42" fill="none" stroke="${S}" stroke-width="2"/>
      <path d="M ${cx - 20} ${cy - 20} L ${cx + 34} ${cy} L ${cx - 20} ${cy + 20} Z" fill="none" stroke="${S}" stroke-width="2"/>`;
    case 'valve': return `
      <path d="M ${cx - 40} ${cy - 22} L ${cx + 40} ${cy + 22} L ${cx + 40} ${cy - 22} L ${cx - 40} ${cy + 22} Z" fill="none" stroke="${S}" stroke-width="2"/>
      <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 42}" stroke="${S}" stroke-width="2"/>
      <rect x="${cx - 16}" y="${cy - 56}" width="32" height="14" fill="none" stroke="${S}" stroke-width="2"/>`;
    case 'hx': return `
      <circle cx="${cx}" cy="${cy}" r="45" fill="none" stroke="${S}" stroke-width="2"/>
      <path d="M ${cx - 45} ${cy} L ${cx - 20} ${cy} L ${cx - 8} ${cy - 18} L ${cx + 8} ${cy + 18} L ${cx + 20} ${cy} L ${cx + 45} ${cy}" fill="none" stroke="${S}" stroke-width="2"/>`;
    case 'detector': return `
      <circle cx="${cx}" cy="${cy}" r="34" fill="none" stroke="${S}" stroke-width="2"/>
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="15" fill="${S}">GD</text>
      <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="11" fill="${S}">偵測</text>`;
    default: return `<rect x="${cx - 55}" y="${cy - 40}" width="110" height="80" fill="none" stroke="${S}" stroke-width="2"/>`;
  }
}

function openPid(eq, unitName) {
  const W = 720, H = 430, cx = 300, cy = 215;
  const insts = eq.instruments ?? [];
  const bubbles = insts.map((tag, i) => {
    const ang = -Math.PI / 3 + i * (Math.PI / 3.2);
    const bx = cx + Math.cos(ang) * 165, by = cy + Math.sin(ang) * 130;
    const [letters, num] = tag.split('-');
    return `
      <line x1="${cx}" y1="${cy}" x2="${bx}" y2="${by}" stroke="#5a7788" stroke-width="1" stroke-dasharray="4 4"/>
      <circle cx="${bx}" cy="${by}" r="22" fill="#0c1319" stroke="#7ee2f5" stroke-width="1.6"/>
      <line x1="${bx - 22}" y1="${by}" x2="${bx + 22}" y2="${by}" stroke="#7ee2f5" stroke-width="1"/>
      <text x="${bx}" y="${by - 5}" text-anchor="middle" font-size="12" fill="#7ee2f5" font-weight="700">${letters}</text>
      <text x="${bx}" y="${by + 14}" text-anchor="middle" font-size="10" fill="#7ee2f5">${num}</text>`;
  }).join('');
  pidTitle.textContent = `${eq.pid_ref}｜${eq.tag} ${eq.name}`;
  pidSvg.innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#0a1017"/>
    <rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="#24333f" stroke-width="1.5"/>
    <line x1="70" y1="${cy}" x2="${cx - 60}" y2="${cy}" stroke="#9fd8ea" stroke-width="2.5"/>
    <path d="M ${cx - 72} ${cy - 6} L ${cx - 60} ${cy} L ${cx - 72} ${cy + 6} Z" fill="#9fd8ea"/>
    <text x="72" y="${cy - 10}" font-size="11" fill="#8ba0b3">進料 FROM ${eq.type === 'tank' ? '製程' : '上游'}</text>
    <line x1="${cx + 60}" y1="${cy}" x2="${W - 80}" y2="${cy}" stroke="#9fd8ea" stroke-width="2.5"/>
    <path d="M ${W - 92} ${cy - 6} L ${W - 80} ${cy} L ${W - 92} ${cy + 6} Z" fill="#9fd8ea"/>
    <text x="${W - 200}" y="${cy - 10}" font-size="11" fill="#8ba0b3">出料 TO 下游</text>
    ${pidSymbol(eq, cx, cy)}
    <text x="${cx}" y="${cy + 100}" text-anchor="middle" font-size="15" font-weight="700" fill="#dbe5ee">${eq.tag}</text>
    <text x="${cx}" y="${cy + 118}" text-anchor="middle" font-size="11" fill="#8ba0b3">${eq.name}</text>
    ${bubbles}
    <g font-size="10" fill="#8ba0b3">
      <rect x="${W - 250}" y="${H - 96}" width="234" height="80" fill="none" stroke="#24333f"/>
      <line x1="${W - 250}" y1="${H - 72}" x2="${W - 16}" y2="${H - 72}" stroke="#24333f"/>
      <line x1="${W - 250}" y1="${H - 48}" x2="${W - 16}" y2="${H - 48}" stroke="#24333f"/>
      <text x="${W - 242}" y="${H - 80}">EJ_3D 數位孿生平台｜${plantData.plant.name}</text>
      <text x="${W - 242}" y="${H - 56}">圖號 ${eq.pid_ref}｜區域 ${unitName}</text>
      <text x="${W - 242}" y="${H - 32}">REV A｜示意圖（由資產資料庫自動生成）</text>
    </g>
  </svg>`;
  pidModal.classList.remove('hidden');
}

// -------------------------------------------- 製程計算（灰箱代理模型 What-if）
const calcBtn = document.getElementById('calc-toggle');
const calcPanel = document.getElementById('calc-panel');
const CALC_SLIDERS = [
  { key: 'feed_TOL', label: '進料 TOL', min: 60, max: 92, step: 0.1, unit: 'wt%' },
  { key: 'feed_TMB', label: '進料 TMB', min: 0, max: 25, step: 0.1, unit: 'wt%' },
  { key: 'feed_MEB', label: '進料 MEB', min: 0, max: 12, step: 0.1, unit: 'wt%' },
  { key: 'feed_C9', label: '進料 C9 總量', min: 0, max: 31, step: 0.1, unit: 'wt%' },
  { key: 'feed_C10', label: '進料 C10', min: 0, max: 6, step: 0.05, unit: 'wt%' },
  { key: 'feed_nonARO', label: '進料 non-ARO', min: 0, max: 1.5, step: 0.01, unit: 'wt%' },
];
const CALC_TARGETS = [
  { key: 'out_BZ', label: 'BZ 苯' },
  { key: 'out_TOL', label: 'TOL 甲苯' },
  { key: 'out_X', label: 'X 二甲苯' },
  { key: 'out_C9', label: 'C9 芳烴' },
];
let calcInfo = null;
let calcTimer = null;

async function initCalc() {
  try {
    calcInfo = await fetch('/api/surrogate/info').then((r) => { if (!r.ok) throw 0; return r.json(); });
  } catch {
    calcBtn.style.display = 'none'; // 模型未啟用（缺 joblib/sklearn）
    return;
  }
  const holder = document.getElementById('calc-sliders');
  holder.innerHTML = CALC_SLIDERS.map((s) => {
    const v = calcInfo.defaults.feed[s.key] ?? s.min;
    return `<div class="calc-slider">
      <label><span>${s.label}</span><b id="cv-${s.key}">${(+v).toFixed(2)} ${s.unit}</b></label>
      <input type="range" id="cs-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${v}">
    </div>`;
  }).join('');
  const r = calcInfo.results;
  document.getElementById('calc-metrics').textContent =
    `977 天品質日報驗證｜測試集 R² ${CALC_TARGETS.map((t) => `${t.label.split(' ')[0]} ${r[t.key].R2_hybrid}`).join('・')}`;

  // 催化劑健康（三年 DCS 實績模型；模型檔缺席時安靜隱藏）
  try {
    const cat = await fetch('/api/surrogate/catalyst').then((x) => { if (!x.ok) throw 0; return x.json(); });
    document.getElementById('calc-catalyst').innerHTML = `
      <div class="info-section">催化劑活性追蹤（R611）</div>
      <table class="info-table">
        <tr><td>運轉時數</td><td>${Math.round(cat.hours_on_stream).toLocaleString()} hr</td></tr>
        <tr><td>維持轉化率所需溫度</td><td><span class="calc-pred">${cat.required_Tin_C} °C</span>（實際 ${cat.actual_last_Tin_C} °C）</td></tr>
        <tr><td>衰退速率</td><td>${cat.deact_rate_C_per_1000hr} °C / 1000 hr</td></tr>
        <tr><td>預估距 EOR（${cat.eor_temp_C}°C）</td><td><span class="calc-pred">${cat.est_days_to_EOR != null ? '約 ' + cat.est_days_to_EOR + ' 天' : '—'}</span></td></tr>
      </table>
      <div class="panel-hint">三年 DCS 實績｜溫度預測 MAE ${cat.model.MAE_C}°C</div>`;
  } catch { /* 無催化劑模型 → 區塊留空 */ }
  for (const s of CALC_SLIDERS) {
    document.getElementById(`cs-${s.key}`).addEventListener('input', (e) => {
      document.getElementById(`cv-${s.key}`).textContent = `${(+e.target.value).toFixed(2)} ${s.unit}`;
      clearTimeout(calcTimer);
      calcTimer = setTimeout(runCalc, 250);
    });
  }
  await runCalc();
}

async function runCalc() {
  const feed = {};
  for (const s of CALC_SLIDERS) feed[s.key] = +document.getElementById(`cs-${s.key}`).value;
  const res = await fetch('/api/surrogate/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feed }),
  }).then((r) => r.json()).catch(() => null);
  if (!res) return;
  document.getElementById('calc-results').innerHTML = CALC_TARGETS.map((t) => {
    const pred = res.prediction[t.key];
    const act = res.baseline_actual[t.key];
    const d = pred - act;
    const cls = d >= 0 ? 'calc-diff-up' : 'calc-diff-dn';
    return `<tr><td>${t.label}</td>
      <td><span class="calc-pred">${pred.toFixed(2)} wt%</span>
      <span class="${cls}">（${d >= 0 ? '+' : ''}${d.toFixed(2)} vs 實測 ${act.toFixed(2)}）</span></td></tr>`;
  }).join('');
  runReactor(res.feed_used);
}

// 反應器平衡計算（解析化 Aspen）：守恆×2 + 平衡商×2 牛頓法
async function runReactor(feedUsed) {
  const box = document.getElementById('calc-reactor');
  // S601 進料 wt% → 反應器模型物種鍵
  const feed = {
    BZ: feedUsed.feed_BZ, TOL: feedUsed.feed_TOL, EB: feedUsed.feed_EB,
    XYL: (feedUsed.feed_pX ?? 0) + (feedUsed.feed_mX ?? 0) + (feedUsed.feed_oX ?? 0),
    PB: feedUsed.feed_NPB, MEB: feedUsed.feed_MEB, TMB: feedUsed.feed_TMB,
    Indane: feedUsed.feed_Indane, C10p: (feedUsed.feed_C10 ?? 0) + (feedUsed.feed_C11p ?? 0),
    nonARO: feedUsed.feed_nonARO,
  };
  const r = await fetch('/api/reactor/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(feed),
  }).then((x) => { if (!x.ok) throw 0; return x.json(); }).catch(() => null);
  if (!r) { box.innerHTML = ''; return; }
  const o = r.outlet_wt_pct;
  box.innerHTML = `
    <div class="info-section">R611 反應器平衡計算（解析式，無 Aspen）</div>
    <table class="info-table">
      <tr><td>甲苯轉化率</td><td><span class="calc-pred">${r.toluene_conversion_pct.toFixed(1)} %</span></td></tr>
      <tr><td>出口 BZ／TOL</td><td>${o.BZ.toFixed(1)}／${o.TOL.toFixed(1)} wt%</td></tr>
      <tr><td>出口 XYL／TMB</td><td>${o.XYL.toFixed(1)}／${o.TMB.toFixed(1)} wt%</td></tr>
    </table>
    <div class="panel-hint">守恆×2＋平衡商×2（K1 ${r.equations.K1}・K2 ${r.equations.K2}）牛頓法｜驗證：轉化率 MAE 0.54%</div>`;
}

calcBtn.addEventListener('click', () => {
  const show = calcPanel.classList.contains('hidden');
  calcPanel.classList.toggle('hidden', !show);
  calcBtn.classList.toggle('active', show);
  if (show) infoCard.classList.add('hidden'); // 與資訊卡同側，互斥
});
initCalc();

// ---------------------------------------------------- 數據圖層（熱力圖）
// 數據孿生的視覺核心：設備依儀錶偏離度上色（藍=基準 → 紅=逼近警報值）
const instrumentDefs = plantData.instruments;
const tagDeviation = {};
const eqHeat = {};
let heatOn = false;
const HEAT_COLOR = new THREE.Color();

function heatColor(dev) {
  // HSL 藍(0.62)→青→綠→黃→紅(0)，偏離越大越熱
  return HEAT_COLOR.setHSL(0.62 * (1 - dev), 0.85, 0.5);
}

const heatBtn = document.getElementById('heat-toggle');
const heatLegend = document.getElementById('heat-legend');
heatBtn?.addEventListener('click', () => {
  heatOn = !heatOn;
  heatBtn.classList.toggle('active', heatOn);
  heatLegend.classList.toggle('hidden', !heatOn);
});

// ---------------------------------------------------------------- WebSocket
const wsStatus = document.getElementById('ws-status');
const gdChip = document.getElementById('gd-chip');
const gdValue = document.getElementById('gd-value');
const banner = document.getElementById('alarm-banner');
let alarmEquipment = new Set();

function connectWS() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { wsStatus.textContent = '● DCS 模擬連線'; wsStatus.className = 'chip ok'; };
  ws.onclose = () => {
    wsStatus.textContent = '○ 連線中斷，重試中…';
    wsStatus.className = 'chip down';
    setTimeout(connectWS, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type !== 'tick') return;
    setScenario(msg.scenario);
    renderMatch(msg.match);

    // 數據源狀態（sim / OPC UA / Modbus）
    if (msg.source) {
      const names = { sim: '模擬數據', opcua: 'OPC UA', modbus: 'Modbus' };
      const nm = names[msg.source.kind] ?? msg.source.kind;
      wsStatus.textContent = msg.source.connected ? `● ${nm}` : `○ ${nm} 斷線`;
      wsStatus.className = 'chip ' + (msg.source.connected ? 'ok' : 'down');
      wsStatus.title = msg.source.detail ?? '';
    }

    // 熱力圖：每設備取所綁儀錶的最大正規化偏離度
    for (const [tag, d] of Object.entries(msg.tags)) {
      const inst = instrumentDefs[tag];
      if (!inst) continue;
      const span = inst.alarm_hi != null ? Math.abs(inst.alarm_hi - inst.base) : Math.max(Math.abs(inst.base) * 0.25, 1);
      tagDeviation[tag] = Math.min(1, Math.abs(d.v - inst.base) / span);
    }
    for (const [eqTag, entry] of Object.entries(eqMap)) {
      let dev = 0;
      for (const t of entry.def.instruments) dev = Math.max(dev, tagDeviation[t] ?? 0);
      eqHeat[eqTag] = dev;
    }

    // 儀錶值 → 資訊卡 + GD chip
    for (const [tag, d] of Object.entries(msg.tags)) {
      const el = document.getElementById(`inst-${tag}`);
      if (el) {
        el.textContent = `${d.v} ${d.unit}`;
        el.classList.toggle('alarm', d.alarm);
        el.title = d.name;
      }
    }
    const gd = msg.tags['GD-001'];
    if (gd) {
      gdValue.textContent = gd.v;
      gdChip.classList.toggle('alarm', gd.alarm);
    }

    // 警報設備集合（供 3D 紅色脈動）
    alarmEquipment = new Set(msg.alarm_equipment);
    for (const [tag, entry] of Object.entries(eqMap)) {
      const alarming = alarmEquipment.has(tag);
      entry.labelEl.classList.toggle('alarming', alarming);
      entry.treeEl.classList.toggle('alarming', alarming);
    }

    // 警報橫幅
    if (msg.message || msg.alarms.length) {
      banner.classList.remove('hidden');
      document.getElementById('alarm-message').textContent = msg.message || '製程警報';
      document.getElementById('alarm-list').innerHTML = msg.alarms.map((a) => `<span>▲ ${a.text}</span>`).join('');
    } else {
      banner.classList.add('hidden');
    }
  };
}
connectWS();

// ---------------------------------------------------------------- 主迴圈
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;

  // 相機飛行
  if (camTween.active) {
    camTween.t = Math.min(camTween.t + dt / 0.9, 1);
    const k = 1 - Math.pow(1 - camTween.t, 3);
    camera.position.lerpVectors(camTween.fromPos, camTween.toPos, k);
    controls.target.lerpVectors(camTween.fromTgt, camTween.toTgt, k);
    if (camTween.t >= 1) camTween.active = false;
  }
  controls.update();

  // 設備警報脈動 / 選取高亮 / 數據熱力圖
  const pulse = 0.35 + 0.45 * Math.abs(Math.sin(t * 4));
  for (const [tag, entry] of Object.entries(eqMap)) {
    const alarming = alarmEquipment.has(tag) && currentScenario !== 'normal';
    const selected = tag === selectedTag;
    const heat = heatOn && entry.def.instruments.length ? (eqHeat[tag] ?? 0) : null;
    entry.group.traverse((o) => {
      if (!o.isMesh) return;
      if (alarming) {
        o.material.emissive.copy(ALARM_RED);
        o.material.emissiveIntensity = pulse;
      } else if (selected) {
        o.material.emissive.copy(ACCENT);
        o.material.emissiveIntensity = 0.45;
      } else if (heat !== null) {
        o.material.emissive.copy(heatColor(heat));
        o.material.emissiveIntensity = 0.3 + heat * 0.5;
      } else {
        o.material.emissive.setHex(o.userData.baseEmissive);
        o.material.emissiveIntensity = o.userData.baseIntensity;
      }
    });
  }

  // FPS 統計＋自動降階（每秒結算一次）
  // 只計正常幀：視窗失焦/被遮擋時瀏覽器會節流 rAF 出現超長幀，
  // 混進統計會把「視窗在背景」誤判成「跑不動」而亂降檔
  if (dt < 0.08) {
    perf.acc += dt;
    perf.frames++;
  }
  perf.wall = (perf.wall ?? 0) + dt;
  if (perf.wall >= 1) {
    if (perf.frames >= 10) { // 有效幀太少＝被節流，跳過這輪判斷
      perf.fps = perf.frames / perf.acc;
      autoAdaptQuality();
    }
    perf.acc = 0;
    perf.frames = 0;
    perf.wall = 0;
    updatePerfChip();
  }

  // 情境特效（粒子生成率隨畫質檔位縮放）
  if (fx.gas) fx.gas.update(dt, 42 * particleScale);
  if (fx.fire) fx.fire.update(dt, (fx.shock ? 130 : 80) * particleScale);
  if (fx.smoke) fx.smoke.update(dt, (fx.shock ? 40 : 26) * particleScale);
  if (fx.shock) {
    fx.shock.t = (fx.shock.t + dt / 1.8) % 1;
    const r = 0.5 + fx.shock.t * fx.shock.rMax;
    fx.shock.ring.scale.set(r, r, 1);
    fx.shock.ring.material.opacity = 0.85 * (1 - fx.shock.t);
  }
  if (fx.dangerMat) fx.dangerMat.opacity = 0.14 + 0.1 * Math.abs(Math.sin(t * 2.2));

  // 工安 AI：人員移動 + 攝影機辨識判定
  updateSafety(dt, t);

  // 施工衝突標記脈動
  for (const m of conflictMarkers) m.scale.setScalar(0.8 + 0.35 * Math.abs(Math.sin(t * 3)));

  for (const a of fx.arrows) {
    a.s = (a.s + (dt * 3) / a.total) % 1;
    const { p, dir } = a.posAt(a.s * a.total);
    a.cone.position.set(p.x, 0.35, p.z);
    a.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  }

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
animate();

function onResize() {
  if (!innerWidth || !innerHeight) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);
// 視窗在背景/尚未 layout 時啟動 innerWidth 可能是 0 → canvas 0×0 全黑；
// ResizeObserver 在視窗真正有尺寸時補一次
new ResizeObserver(onResize).observe(document.body);
onResize();
