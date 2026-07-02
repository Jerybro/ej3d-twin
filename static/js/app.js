// EJ_3D 數位孿生平台 MVP — 前端 3D 視圖器
// M1: 3D 場景漫遊  M2: 設備熱點資訊卡  領航加值: 洩漏/火災情境模擬 + 疏散路徑

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
sun.position.set(18, 26, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -28, right: 28, top: 28, bottom: -28, far: 80 });
scene.add(sun);

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
for (const sm of plantData.scan_models ?? []) {
  new GLTFLoader().load(`/scans/${sm.file}`, (gltf) => {
    const holder = new THREE.Group();
    holder.add(gltf.scene);
    holder.position.set(...(sm.pos ?? [0, 0, 0]));
    holder.rotation.y = sm.rot_y ?? 0;
    const s = sm.scale ?? 1;
    holder.scale.set(s, s, s);
    markShadow(holder);
    if (sm.label) {
      const el = document.createElement('div');
      el.className = 'eq-label';
      el.textContent = sm.label;
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
const fx = { group: null, gas: null, fire: null, smoke: null, arrows: [], path: null, dangerMat: null };

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
  fx.gas = fx.fire = fx.smoke = fx.path = fx.dangerMat = null;
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
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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

  // 情境特效
  if (fx.gas) fx.gas.update(dt, 42);
  if (fx.fire) fx.fire.update(dt, 80);
  if (fx.smoke) fx.smoke.update(dt, 26);
  if (fx.dangerMat) fx.dangerMat.opacity = 0.14 + 0.1 * Math.abs(Math.sin(t * 2.2));
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
