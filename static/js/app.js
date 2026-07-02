// EJ_3D 數位孿生平台 MVP — 前端 3D 視圖器
// M1: 3D 場景漫遊  M2: 設備熱點資訊卡  領航加值: 洩漏/火災情境模擬 + 疏散路徑

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const ACCENT = new THREE.Color('#46c2e0');
const ALARM_RED = new THREE.Color('#ff2a2d');

// ---------------------------------------------------------------- 資料載入
const [plantData, scenarioList] = await Promise.all([
  fetch('/api/plant').then((r) => r.json()),
  fetch('/api/scenarios').then((r) => r.json()),
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
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  pmrem.dispose();
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

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(70, 45),
  new THREE.MeshStandardMaterial({ color: 0x1c232b, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
plantGroup.add(ground);
const grid = new THREE.GridHelper(70, 35, 0x2a3844, 0x1f2a33);
grid.position.y = 0.02;
plantGroup.add(grid);

// ---------------------------------------------------------------- 設備建模
function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.45, ...extra });
}
function markShadow(obj) {
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
}

const builders = {
  reactor({ r, h }) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 32), std(0x8a97a5));
    body.position.y = h / 2;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), std(0x8a97a5));
    dome.position.y = h;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 1.2, 12), std(0x6b7683));
    nozzle.position.set(0, h + r * 0.7, 0);
    g.add(body, dome, nozzle);
    return g;
  },
  tank({ r, h }) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 32), std(0xaab4bd));
    body.position.y = h / 2;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r, 0.08, 8, 40), std(0x76828d));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = h;
    g.add(body, rim);
    return g;
  },
  pump({ w, h, d }) {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.4, d), std(0x3c4652));
    base.position.y = h * 0.2;
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.35, h * 0.35, w * 0.8, 20), std(0x2e7fbf));
    motor.rotation.z = Math.PI / 2;
    motor.position.y = h * 0.65;
    g.add(base, motor);
    return g;
  },
  valve({ s }) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.8, s), std(0xd9a53a));
    body.position.y = s * 0.4;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(s * 0.45, 0.05, 8, 24), std(0xc94f4f));
    wheel.position.y = s * 1.1;
    g.add(body, wheel);
    return g;
  },
  hx({ r, len }) {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 24), std(0x7f8b96));
    shell.rotation.z = Math.PI / 2;
    shell.position.y = r + 0.3;
    for (const sx of [-len / 2, len / 2]) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 12), std(0x6b7683));
      cap.position.set(sx, r + 0.3, 0);
      g.add(cap);
    }
    for (const sx of [-len / 3, len / 3]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, r + 0.3, 0.8), std(0x3c4652));
      leg.position.set(sx, (r + 0.3) / 2, 0);
      g.add(leg);
    }
    g.add(shell);
    return g;
  },
  detector({ h }) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, h, 10), std(0x5a6672));
    pole.position.y = h / 2;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.2), std(0x46c2e0, { emissive: 0x1a4b58, emissiveIntensity: 0.6 }));
    head.position.y = h;
    g.add(pole, head);
    return g;
  },
  building({ w, h, d }) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0x2b3440, { metalness: 0.1, roughness: 0.9 }));
    box.position.y = h / 2;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.15, d + 0.4), std(0x1f2731));
    roof.position.y = h + 0.07;
    g.add(box, roof);
    return g;
  },
};

function labelHeight(eq) {
  const d = eq.dims;
  switch (eq.type) {
    case 'reactor': case 'tank': return d.h + 1.2;
    case 'hx': return d.r + 1.6;
    case 'building': return d.h + 1.0;
    case 'detector': return d.h + 0.6;
    default: return 1.7;
  }
}

const eqMap = {}; // tag → { group, def, unitName, labelEl, treeEl }
for (const unit of plantData.plant.units) {
  for (const eq of unit.equipment) {
    const group = builders[eq.type](eq.dims);
    group.position.set(...eq.pos);
    markShadow(group);
    group.traverse((o) => {
      if (o.isMesh) {
        o.userData.eqTag = eq.tag;
        o.userData.baseEmissive = o.material.emissive.getHex();
        o.userData.baseIntensity = o.material.emissiveIntensity ?? 1;
      }
    });
    plantGroup.add(group);

    const labelEl = document.createElement('div');
    labelEl.className = 'eq-label';
    labelEl.textContent = eq.tag;
    labelEl.style.pointerEvents = 'auto';
    labelEl.addEventListener('pointerdown', (e) => { e.stopPropagation(); selectEquipment(eq.tag, true); });
    const label = new CSS2DObject(labelEl);
    label.position.set(0, labelHeight(eq), 0);
    group.add(label);

    eqMap[eq.tag] = { group, def: eq, unitName: unit.name, labelEl, treeEl: null };
  }
}

// 管線（裝飾用，串接設備）
const pipeMat = std(0x646f7b);
for (const pipe of plantData.pipes) {
  const pts = pipe.pts.map((p) => new THREE.Vector3(...p));
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dir = b.clone().sub(a);
    const len = dir.length();
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(pipe.r, pipe.r, len, 12), pipeMat);
    cyl.position.copy(a).addScaledVector(dir, 0.5);
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    cyl.castShadow = true;
    plantGroup.add(cyl);
    const joint = new THREE.Mesh(new THREE.SphereGeometry(pipe.r * 1.3, 10, 8), pipeMat);
    joint.position.copy(b);
    plantGroup.add(joint);
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
  unitDiv.innerHTML = `<div class="tree-unit-name">${unit.id}｜${unit.name}</div>`;
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
    ? eq.instruments.map((t) => `<tr><td>${t}</td><td><span class="inst-val" id="inst-${t}">--</span></td></tr>`).join('')
    : '<tr><td colspan="2">（無儀錶點位）</td></tr>';
  infoCard.classList.remove('hidden');
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
const workers = [];
for (const w of plantData.workers ?? []) {
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
  const el = document.createElement('div');
  el.className = 'worker-label';
  el.textContent = w.name;
  const label = new CSS2DObject(el);
  label.position.set(0, 1.9, 0);
  g.add(label);
  g.position.set(w.loop[0][0], 0, w.loop[0][1]);
  safetyGroup.add(g);
  workers.push({ def: w, group: g, labelEl: el, wp: 1, mode: 'loop', dwell: 0, path: null, pi: 0 });
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
}

const _wp = new THREE.Vector3();
function updateSafety(dt, t) {
  const events = [];
  for (const w of workers) {
    stepWorker(w, dt);
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

  // 設備警報脈動 / 選取高亮
  const pulse = 0.35 + 0.45 * Math.abs(Math.sin(t * 4));
  for (const [tag, entry] of Object.entries(eqMap)) {
    const alarming = alarmEquipment.has(tag) && currentScenario !== 'normal';
    const selected = tag === selectedTag;
    entry.group.traverse((o) => {
      if (!o.isMesh) return;
      if (alarming) {
        o.material.emissive.copy(ALARM_RED);
        o.material.emissiveIntensity = pulse;
      } else if (selected) {
        o.material.emissive.copy(ACCENT);
        o.material.emissiveIntensity = 0.45;
      } else {
        o.material.emissive.setHex(o.userData.baseEmissive);
        o.material.emissiveIntensity = o.userData.baseIntensity;
      }
    });
  }

  // FPS 統計＋自動降階（每秒結算一次）
  perf.acc += dt;
  perf.frames++;
  if (perf.acc >= 1) {
    perf.fps = perf.frames / perf.acc;
    perf.acc = 0;
    perf.frames = 0;
    autoAdaptQuality();
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

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labelRenderer.setSize(innerWidth, innerHeight);
});
