// 共用建模模組：設備幾何（簡易/精細雙版本）、材質、合併工具
// app.js（孿生檢視）與 editor.js（3D 編輯器）共用；ASSET_CATALOG 供編輯器素材面板
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';


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

// ------------------------------------------- 精細模型（真實化工廠建模器）

const dm = {
  tankShell: new THREE.MeshStandardMaterial({ color: 0xdde2e6, roughness: 0.38, metalness: 0.7 }),
  stainless: new THREE.MeshStandardMaterial({ color: 0xb9c3cc, roughness: 0.26, metalness: 0.92 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x525d68, roughness: 0.5, metalness: 0.8 }),
  galv: new THREE.MeshStandardMaterial({ color: 0x93a0ab, roughness: 0.42, metalness: 0.85 }),
  concrete: new THREE.MeshStandardMaterial({ color: 0x8f8d86, roughness: 0.96, metalness: 0.02 }),
  safetyY: new THREE.MeshStandardMaterial({ color: 0xe8b83a, roughness: 0.6, metalness: 0.3 }),
  motor: new THREE.MeshStandardMaterial({ color: 0x2e6fb0, roughness: 0.45, metalness: 0.6 }),
  bodyDark: new THREE.MeshStandardMaterial({ color: 0x3d444d, roughness: 0.65, metalness: 0.7 }),
  white: new THREE.MeshStandardMaterial({ color: 0xe6eaed, roughness: 0.55, metalness: 0.25 }),
  glass: new THREE.MeshStandardMaterial({ color: 0x9fd8ea, roughness: 0.12, metalness: 0.4, emissive: 0x1a3540, emissiveIntensity: 0.6 }),
  lamp: new THREE.MeshStandardMaterial({ color: 0xfff2cc, emissive: 0xffe9b0, emissiveIntensity: 1.6 }),
};

function dPad(r, g) { // 設備混凝土基礎
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.06, 0.16, 28), dm.concrete);
  pad.position.y = 0.08;
  g.add(pad);
}

function dFlange(r, mat = dm.steelDark) {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.06, 18), mat);
}

function dNozzle(g, r, len, pos, dir) { // 帶法蘭的接管短節；dir: 單位方向
  const d = new THREE.Vector3(...dir);
  const stub = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 14), dm.stainless);
  stub.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  stub.position.set(...pos).addScaledVector(d, len / 2);
  const fl = dFlange(r * 1.7, dm.stainless);
  fl.quaternion.copy(stub.quaternion);
  fl.position.set(...pos).addScaledVector(d, len);
  g.add(stub, fl);
}

function dLadder(g, h, x, z, faceAngle = 0) { // 護籠直爬梯
  const lad = new THREE.Group();
  for (const side of [-0.2, 0.2]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.05), dm.galv);
    rail.position.set(side, h / 2, 0);
    lad.add(rail);
  }
  const rungGeo = new THREE.BoxGeometry(0.42, 0.03, 0.03);
  for (let y = 0.3; y < h; y += 0.32) {
    const rung = new THREE.Mesh(rungGeo, dm.galv);
    rung.position.set(0, y, 0);
    lad.add(rung);
  }
  const hoopGeo = new THREE.TorusGeometry(0.38, 0.02, 6, 12, Math.PI);
  for (let y = 2.2; y < h - 0.2; y += 0.7) {
    const hoop = new THREE.Mesh(hoopGeo, dm.safetyY);
    hoop.rotation.set(0, Math.PI / 2, Math.PI / 2);
    hoop.position.set(0, y, 0.02);
    lad.add(hoop);
  }
  lad.position.set(x, 0, z);
  lad.rotation.y = faceAngle;
  g.add(lad);
}

function dHandrailRing(g, radius, y) { // 圓形平台護欄
  for (const dy of [0, -0.45]) {
    const rail = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.025, 6, 40), dm.safetyY);
    rail.rotation.x = Math.PI / 2;
    rail.position.y = y + dy;
    g.add(rail);
  }
  const postGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6);
  const n = Math.max(6, Math.round(radius * 5));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const post = new THREE.Mesh(postGeo, dm.safetyY);
    post.position.set(Math.cos(a) * radius, y - 0.5, Math.sin(a) * radius);
    g.add(post);
  }
}

const detailedBuilders = {
  tank({ r, h }) { // 立式儲槽：塗裝殼板+錐頂+護欄+護籠爬梯+人孔+接管+基礎
    const g = new THREE.Group();
    dPad(r + 0.45, g);
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 40), dm.tankShell);
    shell.position.y = h / 2 + 0.16;
    g.add(shell);
    for (let i = 1; i <= 3; i++) { // 殼板焊道
      const seam = new THREE.Mesh(new THREE.TorusGeometry(r + 0.01, 0.015, 6, 48), dm.galv);
      seam.rotation.x = Math.PI / 2;
      seam.position.y = (h / 4) * i + 0.16;
      g.add(seam);
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(r + 0.05, r * 0.28, 40), dm.tankShell);
    roof.position.y = h + 0.16 + r * 0.14;
    g.add(roof);
    const vent = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 10), dm.stainless);
    vent.position.y = h + 0.16 + r * 0.28 + 0.2;
    g.add(vent);
    dHandrailRing(g, r * 0.94, h + 0.7);
    dLadder(g, h + 0.3, 0, r + 0.06, 0);
    // 側人孔（帶螺栓法蘭）
    const mw = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 18), dm.tankShell);
    mw.rotation.z = Math.PI / 2;
    mw.position.set(r - 0.02, 1.0, 0);
    const mwf = dFlange(0.45, dm.steelDark);
    mwf.rotation.z = Math.PI / 2;
    mwf.position.set(r + 0.1, 1.0, 0);
    g.add(mw, mwf);
    dNozzle(g, 0.1, 0.5, [0, 0.55, -r + 0.1], [0, 0, -1]); // 底部出口
    dNozzle(g, 0.08, 0.45, [-r + 0.1, h - 0.5, 0], [-1, 0, 0]); // 上部回流
    // 液位計立管
    const lg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, h * 0.8, 8), dm.stainless);
    lg.position.set(r * 0.75, h * 0.4 + 0.3, r * 0.72);
    g.add(lg);
    return g;
  },
  reactor({ r, h }) { // 夾套批次反應器：碟形封頭+攪拌機+側平台+爬梯
    const g = new THREE.Group();
    dPad(r + 0.5, g);
    const legGeo = new THREE.BoxGeometry(0.16, 1.0, 0.16);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.Mesh(legGeo, dm.steelDark);
      leg.position.set(Math.cos(a) * r * 0.8, 0.66, Math.sin(a) * r * 0.8);
      g.add(leg);
    }
    const bodyH = h - 1.1;
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, bodyH, 36), dm.stainless);
    shell.position.y = 1.16 + bodyH / 2;
    const bot = new THREE.Mesh(new THREE.SphereGeometry(r, 36, 14, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), dm.stainless);
    bot.position.y = 1.16;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 36, 14, 0, Math.PI * 2, 0, Math.PI / 2), dm.stainless);
    dome.position.y = 1.16 + bodyH;
    g.add(shell, bot, dome);
    // 夾套（外殼段）
    const jacket = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.08, r * 1.08, bodyH * 0.62, 36), dm.tankShell);
    jacket.position.y = 1.16 + bodyH * 0.42;
    g.add(jacket);
    dNozzle(g, 0.07, 0.4, [r * 1.02, 1.16 + bodyH * 0.14, 0], [1, 0, 0]); // 夾套進出
    dNozzle(g, 0.07, 0.4, [r * 1.02, 1.16 + bodyH * 0.72, 0], [1, 0, 0]);
    // 攪拌機：馬達+減速機
    const gear = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), dm.steelDark);
    gear.position.y = 1.16 + bodyH + r + 0.2;
    const mot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.85, 20), dm.motor);
    mot.position.y = 1.16 + bodyH + r + 0.85;
    g.add(gear, mot);
    dNozzle(g, 0.09, 0.35, [r * 0.5, 1.16 + bodyH + r * 0.75, 0], [0.6, 0.8, 0]); // 頂部進料
    dNozzle(g, 0.09, 0.35, [-r * 0.5, 1.16 + bodyH + r * 0.75, 0], [-0.6, 0.8, 0]);
    // 側操作平台+護欄+爬梯
    const plat = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.07, 1.1), dm.galv);
    plat.position.set(r + 0.7, h * 0.72, 0);
    g.add(plat);
    for (const [px, pz] of [[r + 0.12, -0.5], [r + 1.28, -0.5], [r + 0.12, 0.5], [r + 1.28, 0.5]]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6), dm.safetyY);
      post.position.set(px, h * 0.72 + 0.5, pz);
      g.add(post);
    }
    for (const pz of [-0.5, 0.5]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.04), dm.safetyY);
      rail.position.set(r + 0.7, h * 0.72 + 1.0, pz);
      g.add(rail);
    }
    dLadder(g, h * 0.72, r + 1.5, 0, Math.PI / 2);
    return g;
  },
  pump({ w, h, d }) { // 離心泵：基座+蝸殼+吸入/吐出法蘭+散熱片馬達
    const g = new THREE.Group();
    dPad(Math.max(w, d) * 0.85, g);
    const base = new THREE.Mesh(new THREE.BoxGeometry(w * 1.15, 0.18, d), dm.steelDark);
    base.position.y = 0.25;
    g.add(base);
    const volute = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.42, h * 0.42, 0.32, 24), dm.bodyDark);
    volute.rotation.x = Math.PI / 2;
    volute.position.set(-w * 0.32, h * 0.62, 0);
    g.add(volute);
    dNozzle(g, 0.09, 0.28, [-w * 0.32, h * 0.62, 0.18], [0, 0, 1]); // 吸入
    dNozzle(g, 0.075, 0.3, [-w * 0.32, h * 0.62 + h * 0.4, 0], [0, 1, 0]); // 吐出
    const mot = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.34, h * 0.34, w * 0.72, 22), dm.motor);
    mot.rotation.z = Math.PI / 2;
    mot.position.set(w * 0.22, h * 0.62, 0);
    g.add(mot);
    const finGeo = new THREE.TorusGeometry(h * 0.36, 0.018, 6, 22);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(finGeo, dm.steelDark);
      fin.rotation.y = Math.PI / 2;
      fin.position.set(w * 0.05 + i * 0.14, h * 0.62, 0);
      g.add(fin);
    }
    const jbox = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.14), dm.steelDark);
    jbox.position.set(w * 0.28, h * 0.62 + h * 0.38, 0);
    g.add(jbox);
    return g;
  },
  valve({ s }) { // 氣動控制閥：雙側法蘭+閥體+膜片致動器
    const g = new THREE.Group();
    const pipeGeo = new THREE.CylinderGeometry(s * 0.22, s * 0.22, s * 0.8, 14);
    for (const side of [-1, 1]) {
      const stub = new THREE.Mesh(pipeGeo, dm.stainless);
      stub.rotation.z = Math.PI / 2;
      stub.position.set(side * s * 0.75, s * 0.5, 0);
      const fl = dFlange(s * 0.42, dm.steelDark);
      fl.rotation.z = Math.PI / 2;
      fl.position.set(side * s * 0.42, s * 0.5, 0);
      g.add(stub, fl);
    }
    const body = new THREE.Mesh(new THREE.SphereGeometry(s * 0.42, 18, 14), dm.bodyDark);
    body.scale.set(1, 0.85, 0.85);
    body.position.y = s * 0.5;
    g.add(body);
    const yoke = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.09, s * 0.13, s * 0.55, 10), dm.steelDark);
    yoke.position.y = s * 0.95;
    g.add(yoke);
    const dia = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.5, s * 0.5, s * 0.3, 22), dm.motor);
    dia.position.y = s * 1.35;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(s * 0.5, 22, 8, 0, Math.PI * 2, 0, Math.PI / 2), dm.motor);
    cap.scale.y = 0.45;
    cap.position.y = s * 1.5;
    g.add(dia, cap);
    return g;
  },
  hx({ r, len }) { // 殼管熱交換器：混凝土墩+鞍座+管箱+螺栓環+接管
    const g = new THREE.Group();
    const cy = r + 0.55;
    for (const sx of [-len / 3, len / 3]) {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 1.0), dm.concrete);
      pier.position.set(sx, 0.18, 0);
      const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.35, cy - 0.35 - r * 0.55, 0.9), dm.steelDark);
      saddle.position.set(sx, 0.35 + (cy - 0.35 - r * 0.55) / 2, 0);
      g.add(pier, saddle);
    }
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len * 0.78, 28), dm.tankShell);
    shell.rotation.z = Math.PI / 2;
    shell.position.set(-len * 0.05, cy, 0);
    g.add(shell);
    const chan = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.08, r * 1.08, len * 0.16, 28), dm.stainless);
    chan.rotation.z = Math.PI / 2;
    chan.position.set(len * 0.42, cy, 0);
    g.add(chan);
    for (const bx of [len * 0.335, len * 0.5]) { // 管箱螺栓環
      const bolts = new THREE.Mesh(new THREE.TorusGeometry(r * 1.1, 0.03, 8, 28), dm.steelDark);
      bolts.rotation.y = Math.PI / 2;
      bolts.position.set(bx, cy, 0);
      g.add(bolts);
    }
    const rear = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12), dm.tankShell);
    rear.scale.x = 0.55;
    rear.position.set(-len * 0.44, cy, 0);
    g.add(rear);
    dNozzle(g, 0.08, 0.32, [-len * 0.2, cy + r - 0.03, 0], [0, 1, 0]); // 殼側進
    dNozzle(g, 0.08, 0.32, [len * 0.15, cy - r + 0.03, 0], [0, -1, 0]); // 殼側出
    dNozzle(g, 0.07, 0.3, [len * 0.46, cy + r * 0.55, 0], [0, 1, 0]); // 管側進出
    dNozzle(g, 0.07, 0.3, [len * 0.46, cy - r * 0.55, 0], [0, -1, 0]);
    return g;
  },
  detector({ h }) { // 氣體偵測器：桿+偵測頭+警示牌+太陽能板
    const g = new THREE.Group();
    dPad(0.25, g);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, h, 12), dm.galv);
    pole.position.y = h / 2 + 0.16;
    g.add(pole);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.28, 0.2), std(0x46c2e0, { emissive: 0x1a4b58, emissiveIntensity: 0.7 }));
    head.position.y = h + 0.1;
    g.add(head);
    const sensor = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 10), dm.stainless);
    sensor.position.y = h - 0.08;
    g.add(sensor);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.02), dm.safetyY);
    sign.position.set(0, h * 0.55, 0.05);
    g.add(sign);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.22), dm.glass);
    panel.position.set(0, h + 0.3, -0.05);
    panel.rotation.x = -0.5;
    g.add(panel);
    return g;
  },
  building({ w, h, d }) { // 控制室：窗+門+屋頂空調+天線
    const g = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.18, d + 0.6), dm.concrete);
    slab.position.y = 0.09;
    g.add(slab);
    const walls = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), dm.white);
    walls.position.y = h / 2 + 0.18;
    g.add(walls);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 0.35, 0.14, d + 0.35), dm.steelDark);
    roof.position.y = h + 0.25;
    g.add(roof);
    const winGeo = new THREE.BoxGeometry(1.1, 0.9, 0.04);
    for (const wx of [-w / 4, w / 4]) {
      const win = new THREE.Mesh(winGeo, dm.glass);
      win.position.set(wx, h * 0.6 + 0.18, -d / 2 - 0.01);
      g.add(win);
    }
    const winS = new THREE.Mesh(winGeo, dm.glass);
    winS.rotation.y = Math.PI / 2;
    winS.position.set(-w / 2 - 0.01, h * 0.6 + 0.18, 0);
    g.add(winS);
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.06), dm.steelDark);
    door.position.set(w / 4, 1.13, d / 2 + 0.01);
    g.add(door);
    const hvac = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 0.8), dm.galv);
    hvac.position.set(-w / 4, h + 0.6, 0);
    g.add(hvac);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 1.6, 8), dm.galv);
    ant.position.set(w / 3, h + 1.1, -d / 3);
    g.add(ant);
    return g;
  },
};

// 同材質幾何合併：精細模型上千小件（踏板/立柱/法蘭）逐件 draw 會壓垮 CPU，

function mergeByMaterial(group) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const key = o.material.uuid;
    if (!buckets.has(key)) buckets.set(key, { mat: o.material, geos: [] });
    buckets.get(key).geos.push(o.geometry.clone().applyMatrix4(o.matrixWorld));
  });
  const merged = new THREE.Group();
  for (const { mat, geos } of buckets.values()) {
    merged.add(new THREE.Mesh(BufferGeometryUtils.mergeGeometries(geos, false), mat));
  }
  return merged;
}


function labelHeight(eq) {
  const d = eq.dims;
  switch (eq.type) {
    case 'reactor': case 'tank': case 'column': case 'packedcol': case 'fixedbed':
    case 'flash_v': case 'cyclone': case 'coolingtower': return (d.h ?? 3) + 1.2;
    case 'hx': case 'kettle': case 'flash_h': case 'bullet': return (d.r ?? 0.5) * 2 + 1.6;
    case 'spheretank': return (d.r ?? 2) * 2.4 + 1.0;
    case 'flare': case 'stack': return (d.h ?? 10) + 2.0;
    case 'building': case 'block': case 'aircooler': case 'piperack': return (d.h ?? 2) + 1.0;
    case 'conveyor': return (d.h ?? 2) + 0.8;
    case 'detector': return (d.h ?? 2) + 0.6;
    case 'furnace': return (d.h ?? 3) * 1.7 + 1.0;
    default: return (d.h ?? 1.2) + 1.5;
  }
}



// ------------------------------------------- 新素材：蒸餾塔 / 加熱爐
builders.column = function ({ r, h }) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 32), std(0xaab4bd));
  body.position.y = h / 2;
  const top = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), std(0xaab4bd));
  top.position.y = h;
  g.add(body, top);
  for (let i = 1; i <= 3; i++) { // 塔盤示意環
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.03, 0.03, 6, 32), std(0x76828d));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = (h / 4) * i;
    g.add(ring);
  }
  return g;
};
builders.furnace = function ({ w, h, d }) {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0x8a6a4f, { metalness: 0.3, roughness: 0.7 }));
  box.position.y = h / 2;
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.14, w * 0.18, h * 1.6, 20), std(0x6b7683));
  stack.position.set(w * 0.28, h + h * 0.8, 0);
  g.add(box, stack);
  return g;
};

detailedBuilders.column = function ({ r, h }) {
  const g = new THREE.Group();
  dPad(r + 0.45, g);
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 40), dm.tankShell);
  shell.position.y = h / 2 + 0.16;
  g.add(shell);
  const top = new THREE.Mesh(new THREE.SphereGeometry(r, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2), dm.tankShell);
  top.position.y = h + 0.16;
  g.add(top);
  const nTray = Math.max(3, Math.round(h / 2.2));
  for (let i = 1; i <= nTray; i++) { // 塔盤法蘭環
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.02, 0.03, 6, 40), dm.galv);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = (h / (nTray + 1)) * i + 0.16;
    g.add(ring);
  }
  dHandrailRing(g, r * 0.8, h + 0.9);
  dLadder(g, h + 0.4, 0, r + 0.06, 0);
  dNozzle(g, 0.1, 0.45, [0, 1.0, -r + 0.1], [0, 0, -1]);
  dNozzle(g, 0.09, 0.4, [-r + 0.1, h - 0.6, 0], [-1, 0, 0]);
  dNozzle(g, 0.09, 0.4, [r - 0.1, 0.7, 0], [1, 0, 0]);
  const plat = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.07, 1.0), dm.galv);
  plat.position.set(r + 0.65, h * 0.55, 0);
  g.add(plat);
  return g;
};
detailedBuilders.furnace = function ({ w, h, d }) {
  const g = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.18, d + 0.6), dm.concrete);
  slab.position.y = 0.09;
  g.add(slab);
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.85, d), dm.bodyDark);
  box.position.y = h * 0.425 + 0.18;
  g.add(box);
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.13, w * 0.17, h * 1.7, 24), dm.galv);
  stack.position.set(w * 0.28, h * 1.65, 0);
  g.add(stack);
  for (const bx of [-w * 0.25, w * 0.25]) {
    const burner = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.5, 12), dm.steelDark);
    burner.rotation.x = Math.PI / 2;
    burner.position.set(bx, 0.9, d / 2 + 0.2);
    g.add(burner);
  }
  dLadder(g, h * 0.85, w / 2 + 0.1, 0, Math.PI / 2);
  return g;
};


// ==================================================== 素材大擴充（Aspen blocks 對照）
// 反應設備
builders.pfr = function ({ r, len, rows }) { // 管式反應器：水平管排
  const g = new THREE.Group();
  const n = rows ?? 3;
  for (let i = 0; i < n; i++) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 16), std(0x8a97a5));
    tube.rotation.z = Math.PI / 2;
    tube.position.y = 0.6 + i * (r * 2.4);
    g.add(tube);
    const bend = new THREE.Mesh(new THREE.TorusGeometry(r * 1.2, r, 10, 16, Math.PI), std(0x6b7683));
    bend.position.set((i % 2 ? -1 : 1) * len / 2, 0.6 + i * (r * 2.4) + r * 1.2, 0);
    bend.rotation.z = i % 2 ? Math.PI / 2 : -Math.PI / 2;
    g.add(bend);
  }
  for (const sx of [-len / 3, len / 3]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.6, 0.5), std(0x3c4652));
    leg.position.set(sx, 0.3, 0);
    g.add(leg);
  }
  return g;
};
builders.fixedbed = function ({ r, h }) { // 固定床反應器：立式+橢圓封頭+裙座
  const g = new THREE.Group();
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r * 1.05, 0.9, 28), std(0x3c4652));
  skirt.position.y = 0.45;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h - 1.8, 32), std(0x8a97a5));
  body.position.y = 0.9 + (h - 1.8) / 2;
  const top = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2), std(0x8a97a5));
  top.scale.y = 0.55; top.position.y = h - 0.9;
  const bot = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), std(0x8a97a5));
  bot.scale.y = 0.55; bot.position.y = 0.9;
  const nz = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 10), std(0x6b7683));
  nz.position.y = h - 0.3;
  g.add(skirt, body, top, bot, nz);
  return g;
};
// 分離設備
builders.packedcol = function ({ r, h }) { // 填充塔：塔體+填充段外環
  const g = builders.column({ r, h });
  for (const yy of [h * 0.3, h * 0.65]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.06, r + 0.06, h * 0.16, 32, 1, true), std(0xd9a53a, { metalness: 0.3, roughness: 0.7 }));
    band.position.y = yy;
    g.add(band);
  }
  return g;
};
builders.flash_v = function ({ r, h }) { // 立式閃蒸罐
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h - r, 28), std(0xaab4bd));
  body.position.y = (h - r) / 2 + r * 0.5;
  const top = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), std(0xaab4bd));
  top.scale.y = 0.6; top.position.y = h - r * 0.5;
  const bot = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), std(0xaab4bd));
  bot.scale.y = 0.6; bot.position.y = r * 0.5;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, r * 0.9, 0.12), std(0x3c4652));
    leg.position.set(Math.cos(a) * r * 0.8, r * 0.45, Math.sin(a) * r * 0.8);
    g.add(leg);
  }
  g.add(body, top, bot);
  return g;
};
builders.flash_h = function ({ r, len }) { // 臥式分離槽：橫圓柱+鞍座
  const g = new THREE.Group();
  const cy = r + 0.5;
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 28), std(0xaab4bd));
  shell.rotation.z = Math.PI / 2;
  shell.position.y = cy;
  for (const sx of [-len / 2, len / 2]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 12), std(0x98a4ae));
    cap.scale.x = 0.5; cap.position.set(sx, cy, 0);
    g.add(cap);
  }
  for (const sx of [-len / 3, len / 3]) {
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.3, cy - r * 0.4, r * 1.6), std(0x3c4652));
    saddle.position.set(sx, (cy - r * 0.4) / 2, 0);
    g.add(saddle);
  }
  const boot = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.3, 0.6, 16), std(0x98a4ae));
  boot.position.set(len * 0.25, cy - r - 0.25, 0);
  g.add(boot, shell);
  return g;
};
builders.cyclone = function ({ r, h }) { // 旋風分離器
  const g = new THREE.Group();
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h * 0.4, 24), std(0x9aa5ad));
  barrel.position.y = h * 0.8;
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.15, h * 0.6, 24), std(0x9aa5ad));
  cone.position.y = h * 0.3;
  const inlet = new THREE.Mesh(new THREE.BoxGeometry(r * 1.6, r * 0.7, r * 0.5), std(0x7f8b96));
  inlet.position.set(-r * 1.1, h * 0.92, 0);
  const vortex = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.4, r * 0.4, h * 0.25, 16), std(0x7f8b96));
  vortex.position.y = h * 1.05;
  const legGeo = new THREE.BoxGeometry(0.1, h * 0.35, 0.1);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    const leg = new THREE.Mesh(legGeo, std(0x3c4652));
    leg.position.set(Math.cos(a) * r * 0.9, h * 0.18, Math.sin(a) * r * 0.9);
    g.add(leg);
  }
  g.add(barrel, cone, inlet, vortex);
  return g;
};
// 熱交換
builders.kettle = function ({ r, len }) { // 釜式再沸器
  const g = builders.flash_h({ r, len });
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, len * 0.4, 20), std(0x98a4ae));
  dome.rotation.z = Math.PI / 2;
  dome.position.set(-len * 0.1, r * 2 + 0.2, 0);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.35, r * 0.35, r * 0.8, 14), std(0x7f8b96));
  neck.position.set(-len * 0.1, r * 1.4 + 0.3, 0);
  g.add(dome, neck);
  return g;
};
builders.aircooler = function ({ w, h, d }) { // 空冷器
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.25, d), std(0x7f8b96));
  box.position.y = h;
  const legGeo = new THREE.BoxGeometry(0.14, h, 0.14);
  for (const off of [[-w / 2 + 0.2, -d / 2 + 0.2], [w / 2 - 0.2, -d / 2 + 0.2], [-w / 2 + 0.2, d / 2 - 0.2], [w / 2 - 0.2, d / 2 - 0.2]]) {
    const leg = new THREE.Mesh(legGeo, std(0x3c4652));
    leg.position.set(off[0], h / 2, off[1]);
    g.add(leg);
  }
  const nFan = Math.max(1, Math.round(w / 2.2));
  for (let i = 0; i < nFan; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.min(w / nFan, d) * 0.35, 0.06, 8, 24), std(0xd9a53a));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(-w / 2 + (i + 0.5) * (w / nFan), h + h * 0.13 + 0.05, 0);
    g.add(ring);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.2, 10), std(0x3c4652));
    hub.position.copy(ring.position);
    g.add(hub);
  }
  g.add(box);
  return g;
};
// 流體機械
builders.compressor = function ({ w, h, d }) { // 離心壓縮機
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(w * 1.3, 0.25, d * 1.2), std(0x3c4652));
  base.position.y = 0.13;
  const volute = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.5, h * 0.5, d * 0.6, 24), std(0x2e7fbf));
  volute.rotation.x = Math.PI / 2;
  volute.position.set(-w * 0.3, h * 0.65, 0);
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.38, h * 0.38, w * 0.7, 20), std(0x8a97a5));
  motor.rotation.z = Math.PI / 2;
  motor.position.set(w * 0.28, h * 0.65, 0);
  const nozUp = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.18, h * 0.18, h * 0.5, 14), std(0x7f8b96));
  nozUp.position.set(-w * 0.3, h * 1.1, 0);
  g.add(base, volute, motor, nozUp);
  return g;
};
builders.recip = function ({ w, h, d }) { // 往復壓縮機
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.7, d), std(0x4a5560));
  body.position.y = h * 0.45;
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.5, h * 0.5, 0.18, 24), std(0x2e7fbf));
  wheel.rotation.x = Math.PI / 2;
  wheel.position.set(-w / 2 - 0.1, h * 0.55, 0);
  const cyl1 = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.2, h * 0.2, w * 0.4, 14), std(0x8a97a5));
  cyl1.rotation.z = Math.PI / 2;
  cyl1.position.set(w * 0.55, h * 0.5, d * 0.2);
  const cyl2 = cyl1.clone(); cyl2.position.z = -d * 0.2;
  g.add(body, wheel, cyl1, cyl2);
  return g;
};
builders.blower = function ({ w, h, d }) { // 風機
  const g = new THREE.Group();
  const scroll = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.5, h * 0.5, d * 0.7, 20), std(0x7f8b96));
  scroll.rotation.x = Math.PI / 2;
  scroll.position.y = h * 0.55;
  const outlet = new THREE.Mesh(new THREE.BoxGeometry(w * 0.35, h * 0.4, d * 0.5), std(0x6b7683));
  outlet.position.set(0, h * 1.0, 0);
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(h * 0.25, h * 0.25, w * 0.5, 16), std(0x2e7fbf));
  motor.rotation.z = Math.PI / 2;
  motor.position.set(w * 0.45, h * 0.55, 0);
  g.add(scroll, outlet, motor);
  return g;
};
// 儲存容器
builders.bullet = function ({ r, len }) { // 臥式儲槽
  return builders.flash_h({ r, len });
};
builders.spheretank = function ({ r }) { // 球槽
  const g = new THREE.Group();
  const cy = r * 1.35;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 36, 24), std(0xdde2e6, { metalness: 0.6, roughness: 0.35 }));
  ball.position.y = cy;
  g.add(ball);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, cy, 10), std(0x3c4652));
    leg.position.set(Math.cos(a) * r * 0.72, cy / 2, Math.sin(a) * r * 0.72);
    g.add(leg);
  }
  const eq = new THREE.Mesh(new THREE.TorusGeometry(r + 0.01, 0.03, 6, 48), std(0x9aa5ad));
  eq.rotation.x = Math.PI / 2;
  eq.position.y = cy;
  g.add(eq);
  return g;
};
// 公用結構
builders.block = function ({ w, h, d }) { // 自由 BLOCK（自訂尺寸）
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0x55606c, { metalness: 0.2, roughness: 0.8 }));
  box.position.y = h / 2;
  g.add(box);
  return g;
};
builders.coolingtower = function ({ w, h, d }) { // 冷卻水塔（機械通風）
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.75, d), std(0x6f7d70, { metalness: 0.1, roughness: 0.9 }));
  body.position.y = h * 0.375;
  const stackR = Math.min(w, d) * 0.3;
  const fanStack = new THREE.Mesh(new THREE.CylinderGeometry(stackR * 1.15, stackR, h * 0.25, 24, 1, true), std(0x8f9aa5));
  fanStack.position.y = h * 0.87;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(stackR * 0.8, 0.05, 8, 24), std(0x3c4652));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = h * 0.83;
  for (let i = 0; i < 4; i++) {
    const louver = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, 0.05, 0.02), std(0x4a5560));
    louver.position.set(0, 0.3 + i * 0.28, d / 2 + 0.01);
    g.add(louver);
  }
  g.add(body, fanStack, ring);
  return g;
};
builders.flare = function ({ h }) { // 火炬塔
  const g = new THREE.Group();
  const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, h, 16), std(0x8f9aa5));
  stack.position.y = h / 2;
  const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.2, 0.8, 14), std(0x3c4652));
  tip.position.y = h + 0.4;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.0, 12), std(0xff8420, { emissive: 0xff6a00, emissiveIntensity: 1.2 }));
  flame.position.y = h + 1.3;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, h * 0.55, 8), std(0x55606c));
    strut.position.set(Math.cos(a) * 0.9, h * 0.26, Math.sin(a) * 0.9);
    strut.rotation.z = Math.cos(a) * 0.32;
    strut.rotation.x = -Math.sin(a) * 0.32;
    g.add(strut);
  }
  g.add(stack, tip, flame);
  return g;
};
builders.stack = function ({ r, h }) { // 煙囪
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r, h, 24), std(0x9aa5ad, { metalness: 0.2, roughness: 0.8 }));
  body.position.y = h / 2;
  const band1 = new THREE.Mesh(new THREE.TorusGeometry(r * 0.72, 0.05, 6, 24), std(0xc94f4f));
  band1.rotation.x = Math.PI / 2;
  band1.position.y = h * 0.95;
  g.add(body, band1);
  return g;
};
builders.piperack = function ({ w, h, d, bays }) { // 管架（多層鋼構）
  const g = new THREE.Group();
  const n = bays ?? 3;
  const colGeo = new THREE.BoxGeometry(0.15, h, 0.15);
  for (let i = 0; i <= n; i++) {
    const x = -w / 2 + (i / n) * w;
    for (const sz of [-d / 2, d / 2]) {
      const col = new THREE.Mesh(colGeo, std(0x8a6a4f, { metalness: 0.4, roughness: 0.6 }));
      col.position.set(x, h / 2, sz);
      g.add(col);
    }
  }
  for (const lv of [0.45, 0.75, 1.0]) {
    for (let i = 0; i <= n; i++) {
      const x = -w / 2 + (i / n) * w;
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, d), std(0x8a6a4f));
      beam.position.set(x, h * lv, 0);
      g.add(beam);
    }
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, 0.12), std(0x8a6a4f));
    rail.position.set(0, h * lv, -d / 2);
    const rail2 = rail.clone(); rail2.position.z = d / 2;
    g.add(rail, rail2);
  }
  return g;
};
builders.conveyor = function ({ len, h, w }) { // 輸送帶
  const g = new THREE.Group();
  const belt = new THREE.Mesh(new THREE.BoxGeometry(len, 0.18, w), std(0x2c333b, { roughness: 0.95 }));
  belt.position.y = h;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(len, 0.1, w * 1.15), std(0xd9a53a));
  frame.position.y = h - 0.15;
  const n = Math.max(2, Math.round(len / 3));
  for (let i = 0; i <= n; i++) {
    const x = -len / 2 + (i / n) * len;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.1), std(0x55606c));
    legL.position.set(x, h / 2 - 0.1, -w / 2);
    const legR = legL.clone(); legR.position.z = w / 2;
    g.add(legL, legR);
  }
  g.add(belt, frame);
  return g;
};

// -------------------------------------------------- 自建設備（primitives 堆疊）
// E3D Create Equipment 流程：BOX/CYLI/CONE/DISH 基元組合成設備
// def.prims: [{kind, dims, pos:[dx,dy,dz], rot_y}]；builders 第二參數傳 def
// 矩形截頭錐（PYRA / 漏斗）：8 頂點手工幾何，底 bx×bz、頂 tx×tz、高 h
function pyraGeometry(bx, bz, tx, tz, h) {
  const g = new THREE.BufferGeometry();
  const bX = bx / 2, bZ = bz / 2, tX = tx / 2, tZ = tz / 2;
  const v = [
    -bX, 0, -bZ, bX, 0, -bZ, bX, 0, bZ, -bX, 0, bZ,   // 底 0-3
    -tX, h, -tZ, tX, h, -tZ, tX, h, tZ, -tX, h, tZ,   // 頂 4-7
  ];
  const idx = [
    0, 2, 1, 0, 3, 2,           // 底（朝下）
    4, 5, 6, 4, 6, 7,           // 頂（朝上）
    0, 1, 5, 0, 5, 4,           // -Z 面
    1, 2, 6, 1, 6, 5,           // +X 面
    2, 3, 7, 2, 7, 6,           // +Z 面
    3, 0, 4, 3, 4, 7,           // -X 面
  ];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildPrim(p) {
  const d = p.dims;
  let mesh;
  if (p.kind === 'box') {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(d.w, d.h, d.d), std(0x8a97a5));
    mesh.geometry.translate(0, d.h / 2, 0);
  } else if (p.kind === 'cyli') {
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(d.r, d.r, d.h, 28), std(0x9aa7b4));
    mesh.geometry.translate(0, d.h / 2, 0);
  } else if (p.kind === 'cone') {
    mesh = new THREE.Mesh(new THREE.CylinderGeometry(d.r2 ?? 0.3, d.r1 ?? 1, d.h, 28), std(0x9aa7b4));
    mesh.geometry.translate(0, d.h / 2, 0);
  } else if (p.kind === 'dish') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(d.r, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), std(0x9aa7b4));
  } else if (p.kind === 'snou') {
    // SNOU 偏心漸縮：漸縮錐 + 頂面沿 X 偏移 off（eccentric reducer）
    const h = d.h ?? 1;
    const g = new THREE.CylinderGeometry(d.r2 ?? 0.45, d.r1 ?? 0.9, h, 28);
    g.translate(0, h / 2, 0);
    g.applyMatrix4(new THREE.Matrix4().set(1, (d.off ?? 0.3) / h, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1));
    mesh = new THREE.Mesh(g, std(0x9aa7b4));
  } else if (p.kind === 'pyra') {
    mesh = new THREE.Mesh(pyraGeometry(d.bx ?? 1.4, d.bz ?? 1.4, d.tx ?? 0.6, d.tz ?? 0.6, d.h ?? 1.2), std(0x9aa7b4));
  } else if (p.kind === 'ctor') {
    // CTOR 圓環／彎頭：環中心半徑 r、管半徑 rt、弧角 ang（度）
    mesh = new THREE.Mesh(new THREE.TorusGeometry(d.r ?? 0.9, d.rt ?? 0.2, 16, 28, (d.ang ?? 90) * Math.PI / 180), std(0x9aa7b4));
  } else {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), std(0x8a97a5));
  }
  mesh.position.set(...(p.pos ?? [0, 0, 0]));
  mesh.rotation.y = p.rot_y ?? 0;
  return mesh;
}

builders.assembly = function (_dims, def) {
  const g = new THREE.Group();
  for (const p of def?.prims ?? []) g.add(buildPrim(p));
  if (!g.children.length) {  // 空 assembly 放佔位圓柱
    g.add(buildPrim({ kind: 'cyli', dims: { r: 0.8, h: 2 }, pos: [0, 0, 0] }));
  }
  return g;
};

// -------------------------------------------------- 結構鋼構（STRUCTURES 專業）
const steelMat = std(0x9aa4ad, { metalness: 0.5, roughness: 0.55 });
// 標準鋼構斷面目錄（對標 E3D Structural section catalogue）——真實 mm 尺寸(EN/UK)
// depth=斷面高 D，flange=翼板寬 B，web=腹板厚 tw，tf=翼板厚（單位 mm，用時 /1000）
export const STEEL_SECTIONS = [
  { code: 'IPE200', depth: 200, flange: 100, web: 5.6, tf: 8.5 },
  { code: 'IPE300', depth: 300, flange: 150, web: 7.1, tf: 10.7 },
  { code: 'IPE400', depth: 400, flange: 180, web: 8.6, tf: 13.5 },
  { code: 'IPE500', depth: 500, flange: 200, web: 10.2, tf: 16 },
  { code: 'HEA300', depth: 290, flange: 300, web: 8.5, tf: 14 },
  { code: 'HEB200', depth: 200, flange: 200, web: 9, tf: 15 },
  { code: 'HEB300', depth: 300, flange: 300, web: 11, tf: 19 },
  { code: 'HEB400', depth: 400, flange: 300, web: 13.5, tf: 24 },
  { code: 'UB305x165x40', depth: 303.4, flange: 165, web: 6, tf: 10.2 },
  { code: 'UC254x254x73', depth: 254.1, flange: 254.6, web: 8.6, tf: 14.2 },
];
const STEEL_DEFAULT = STEEL_SECTIONS[6];   // HEB300 為預設（近似原本寫死斷面）
export function steelSection(code) {
  return STEEL_SECTIONS.find((s) => s.code === code) ?? STEEL_DEFAULT;
}
// 定位線 Justification（對標 E3D P-line）：斷面在其斷面平面內偏移，使指定基準貼定位線。
// hSection 本地座標：長度沿 Y，斷面高 depth 沿 Z（頂面 +Z），翼板寬 flange 沿 X。
// NA=形心（不偏移）；CTOP/TOS=頂面貼線（往 -Z 移 D/2）；CBOT/BOS=底面貼線（往 +Z 移 D/2）；
// LEFT/RIGHT=翼板邊貼線（沿 X ±B/2）。柱直接用此本地偏移；樑旋轉後偏移隨之轉向，方向自動正確。
function justOffset(sec, just = 'NA') {
  const D = sec.depth / 1000, B = sec.flange / 1000;
  switch (just) {
    case 'CTOP': case 'TOS': return { dx: 0, dz: -D / 2 };  // 頂面對齊：斷面下移
    case 'CBOT': case 'BOS': return { dx: 0, dz: D / 2 };   // 底面對齊：斷面上移
    case 'LEFT': return { dx: B / 2, dz: 0 };               // 左翼板邊對齊
    case 'RIGHT': return { dx: -B / 2, dz: 0 };             // 右翼板邊對齊
    default: return { dx: 0, dz: 0 };                       // NA：形心
  }
}
function hSection(len, sec = STEEL_DEFAULT, just = 'NA') {
  // 沿 Y 軸的 I/H 型鋼（柱姿態），樑用旋轉擺放；斷面尺寸 mm→m
  const D = sec.depth / 1000, B = sec.flange / 1000, tw = sec.web / 1000, tf = sec.tf / 1000;
  const { dx, dz } = justOffset(sec, just);   // 定位線偏移（本地斷面平面）
  const g = new THREE.Group();
  const web = new THREE.Mesh(new THREE.BoxGeometry(tw, len, D - 2 * tf), steelMat);
  const f1 = new THREE.Mesh(new THREE.BoxGeometry(B, len, tf), steelMat);
  f1.position.z = (D - tf) / 2;
  const f2 = f1.clone();
  f2.position.z = -(D - tf) / 2;
  g.add(web, f1, f2);
  g.children.forEach((c) => c.geometry.translate(dx, len / 2, dz));
  return g;
}

builders.scolumn = function ({ h }, def) {
  const sec = steelSection(def?.section);
  const just = def?.just ?? 'NA';
  const g = new THREE.Group();
  const bp = Math.max(0.42, sec.flange / 1000 + 0.12);   // 底板隨翼板寬
  const base = new THREE.Mesh(new THREE.BoxGeometry(bp, 0.03, bp), steelMat);
  base.position.y = 0.015;                    // 底板留在定位線節點，僅斷面依 just 偏移
  g.add(base, hSection(h, sec, just));
  return g;
};

builders.sbeam = function ({ len, elev }, def) {
  const sec = steelSection(def?.section);
  const just = def?.just ?? 'NA';
  const g = new THREE.Group();
  const beam = hSection(len, sec, just);      // 定位線偏移於本地斷面平面套用，隨旋轉轉向
  beam.rotation.z = -Math.PI / 2;             // 轉水平（沿 +X）
  beam.position.set(-len / 2, elev ?? 3, 0);
  g.add(beam);
  return g;
};

builders.stairs = function ({ w, h, run }) {
  const g = new THREE.Group();
  const n = Math.max(3, Math.round(h / 0.2));
  for (let i = 0; i < n; i++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(run / n, 0.05, w), steelMat);
    step.position.set(-run / 2 + (i + 0.5) * (run / n), (i + 1) * (h / n), 0);
    g.add(step);
  }
  for (const side of [-1, 1]) {  // 斜樑
    const s = new THREE.Mesh(new THREE.BoxGeometry(Math.hypot(run, h), 0.16, 0.05), steelMat);
    s.position.set(0, h / 2, side * (w / 2 + 0.03));
    s.rotation.z = Math.atan2(h, run);
    g.add(s);
    const rail = s.clone();
    rail.position.y = h / 2 + 0.95;
    rail.scale.set(1, 0.25, 1);
    g.add(rail);
  }
  return g;
};

builders.srail = function ({ len }) {
  const g = new THREE.Group();
  const n = Math.max(2, Math.round(len / 1.5) + 1);
  for (let i = 0; i < n; i++) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1.1, 8), steelMat);
    post.position.set(-len / 2 + (i / (n - 1)) * len, 0.55, 0);
    g.add(post);
  }
  for (const y of [1.1, 0.6]) {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, len, 8), steelMat);
    rail.rotation.z = Math.PI / 2;
    rail.position.y = y;
    g.add(rail);
  }
  return g;
};

builders.splat = function ({ w, d, elev }) {
  const g = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), std(0x77828d, { roughness: 0.9 }));
  deck.position.y = elev;
  const kick = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, 0.02), steelMat);
  kick.position.set(0, elev + 0.08, d / 2);
  const kick2 = kick.clone();
  kick2.position.z = -d / 2;
  g.add(deck, kick, kick2);
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, elev, 0.08), steelMat);
    leg.position.set(sx * (w / 2 - 0.1), elev / 2, sz * (d / 2 - 0.1));
    g.add(leg);
  }
  return g;
};

// -------------------------------------------------- 素材庫擴充（E3D 常見設備補齊）
builders.platehx = function ({ w, h, d }) {
  const g = new THREE.Group();
  const stack = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0x7d92a8, { metalness: 0.4, roughness: 0.5 }));
  stack.position.y = h / 2 + 0.15;
  const frameF = new THREE.Mesh(new THREE.BoxGeometry(0.12, h * 1.06, d * 1.06), std(0x3a4a5a));
  frameF.position.set(w / 2 + 0.07, h / 2 + 0.15, 0);
  const frameB = frameF.clone();
  frameB.position.x = -w / 2 - 0.07;
  const base = new THREE.Mesh(new THREE.BoxGeometry(w * 1.2, 0.15, d * 1.2), std(0x55606c));
  base.position.y = 0.075;
  const bolts = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, w * 1.25, 6), std(0x9aa4ad));
  bolts.rotation.z = Math.PI / 2;
  bolts.position.y = h + 0.05;
  g.add(stack, frameF, frameB, base, bolts);
  return g;
};

builders.filterv = function ({ r, h }) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h * 0.7, 20), std(0x9aa7b4));
  shell.position.y = h * 0.45;
  const head = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), std(0x8d99a6));
  head.position.y = h * 0.8;
  const legsY = h * 0.1;
  for (const a of [0, 2.09, 4.19]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, h * 0.22, 0.08), std(0x55606c));
    leg.position.set(Math.cos(a) * r * 0.8, legsY, Math.sin(a) * r * 0.8);
    g.add(leg);
  }
  const swing = new THREE.Mesh(new THREE.TorusGeometry(r * 0.6, 0.03, 6, 14, Math.PI), std(0x55606c));
  swing.position.y = h * 0.82;
  g.add(shell, head, swing);
  return g;
};

builders.agitank = function ({ r, h }) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), std(0x9aa7b4));
  shell.position.y = h / 2;
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.28, r * 0.28, 0.7, 12), std(0x2e6da8));
  motor.position.y = h + 0.55;
  const gear = new THREE.Mesh(new THREE.BoxGeometry(r * 0.7, 0.35, r * 0.5), std(0x3a4a5a));
  gear.position.y = h + 0.15;
  g.add(shell, motor, gear);
  return g;
};

builders.hopper = function ({ r, h }) {
  const g = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.15, h * 0.4, 20), std(0x8d99a6));
  cone.position.y = h * 0.2 + 0.6;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h * 0.6, 20), std(0x9aa7b4));
  body.position.y = h * 0.7 + 0.6;
  for (const a of [0.52, 2.62, 4.71]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, h * 0.55, 0.1), std(0x55606c));
    leg.position.set(Math.cos(a) * r * 0.9, h * 0.28, Math.sin(a) * r * 0.9);
    g.add(leg);
  }
  g.add(cone, body);
  return g;
};

builders.skid = function ({ w, h, d }) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), std(0xd9a53a));
  base.position.y = 0.08;
  g.add(base);
  for (const [fx, fz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, h, 0.08), std(0x55606c));
    post.position.set(fx * (w / 2 - 0.06), h / 2, fz * (d / 2 - 0.06));
    g.add(post);
  }
  const roofX = new THREE.Mesh(new THREE.BoxGeometry(w, 0.07, 0.07), std(0x55606c));
  roofX.position.y = h;
  roofX.position.z = d / 2 - 0.06;
  const roofX2 = roofX.clone();
  roofX2.position.z = -d / 2 + 0.06;
  const pumpA = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.7, 12), std(0x2e6da8));
  pumpA.rotation.z = Math.PI / 2;
  pumpA.position.set(-w * 0.2, 0.48, 0);
  const pumpB = pumpA.clone();
  pumpB.position.x = w * 0.2;
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.1, 0.2), std(0x3a4a5a));
  panel.position.set(0, 0.72, d / 2 - 0.2);
  g.add(roofX, roofX2, pumpA, pumpB, panel);
  return g;
};

// -------------------------------------------------- 素材庫擴充二期（公用/電氣/固體處理）
builders.rotarykiln = function ({ r, len }) {
  const g = new THREE.Group();
  const tilt = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 20), std(0x8d99a6, { metalness: 0.35, roughness: 0.55 }));
  shell.rotation.z = Math.PI / 2;
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(r * 1.12, 0.09, 8, 22), std(0x55606c));
  ring1.rotation.y = Math.PI / 2;
  ring1.position.x = -len * 0.28;
  const ring2 = ring1.clone();
  ring2.position.x = len * 0.28;
  const gearRing = new THREE.Mesh(new THREE.TorusGeometry(r * 1.2, 0.12, 8, 26), std(0x3a4a5a));
  gearRing.rotation.y = Math.PI / 2;
  gearRing.position.x = len * 0.05;
  tilt.add(shell, ring1, ring2, gearRing);
  tilt.rotation.z = 0.055;                       // 迴轉窯慣例：略傾斜（出料端低）
  tilt.position.y = r + 0.9;
  g.add(tilt);
  for (const sx of [-0.28, 0.28]) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, r * 1.6), std(0x6b7683));
    pier.position.set(sx * len, 0.5, 0);
    g.add(pier);
  }
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.2, r * 2 + 0.8, r * 2 + 0.6), std(0x55606c));
  hood.position.set(len / 2 + 0.5, r + 0.7, 0);
  g.add(hood);
  return g;
};

builders.scrubber = function ({ r, h }) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h * 0.82, 22), std(0x9aa7b4));
  shell.position.y = h * 0.5;
  const head = new THREE.Mesh(new THREE.SphereGeometry(r, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2), std(0x8d99a6));
  head.position.y = h * 0.91;
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.96, r * 1.02, h * 0.09, 22), std(0x55606c));
  skirt.position.y = h * 0.045;
  for (const yy of [0.42, 0.62]) {                // 填充床段外箍
    const band = new THREE.Mesh(new THREE.TorusGeometry(r * 1.02, 0.045, 6, 22), std(0x6b7683));
    band.rotation.x = Math.PI / 2;
    band.position.y = h * yy;
    g.add(band);
  }
  const duct = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.3, r * 1.6, 12), std(0x8d99a6));
  duct.rotation.z = Math.PI / 2;
  duct.position.set(r * 1.5, h * 0.22, 0);
  const vent = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.22, r * 0.22, h * 0.16, 12), std(0x8d99a6));
  vent.position.y = h * 1.02;
  g.add(shell, head, skirt, duct, vent);
  return g;
};

builders.centrifuge = function ({ r, h }) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(r * 2.6, 0.18, r * 2.2), std(0x55606c));
  base.position.y = 0.09;
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.92, h, 22), std(0x7d92a8, { metalness: 0.45, roughness: 0.4 }));
  bowl.position.y = h / 2 + 0.18;
  const lid = new THREE.Mesh(new THREE.SphereGeometry(r, 22, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), std(0x8d99a6));
  lid.scale.y = 0.45;
  lid.position.y = h + 0.18;
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.34, r * 0.34, r * 1.1, 12), std(0x2e6da8));
  motor.rotation.z = Math.PI / 2;
  motor.position.set(r * 1.5, h * 0.5 + 0.18, 0);
  g.add(base, bowl, lid, motor);
  return g;
};

builders.baghouse = function ({ w, h, d }) {
  const g = new THREE.Group();
  const legH = h * 0.28;
  const hopH = h * 0.24;
  const boxH = h - legH - hopH;
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, boxH, d), std(0x9aa7b4));
  box.position.y = legH + hopH + boxH / 2;
  const hop = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(w, d) * 0.7, 0.12, hopH, 4), std(0x8d99a6));
  hop.rotation.y = Math.PI / 4;                   // 四段圓柱旋 45°＝方錐料斗
  hop.position.y = legH + hopH / 2;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, legH, 0.12), std(0x55606c));
    leg.position.set(sx * (w / 2 - 0.15), legH / 2, sz * (d / 2 - 0.15));
    g.add(leg);
  }
  const outlet = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, h * 0.3, 12), std(0x8d99a6));
  outlet.position.set(-w / 2 + 0.4, h + h * 0.08, 0);
  const walkway = new THREE.Mesh(new THREE.BoxGeometry(w * 1.04, 0.08, 0.7), std(0x6b7683));
  walkway.position.set(0, h + 0.04, d / 2 + 0.35);
  g.add(box, hop, outlet, walkway);
  return g;
};

builders.boiler = function ({ w, h, d }) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.72, d), std(0x9aa7b4));
  body.position.y = h * 0.36 + 0.12;
  const base = new THREE.Mesh(new THREE.BoxGeometry(w * 1.06, 0.12, d * 1.06), std(0x55606c));
  base.position.y = 0.06;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(d * 0.28, d * 0.28, w * 0.86, 18), std(0x8d99a6));
  drum.rotation.z = Math.PI / 2;
  drum.position.y = h * 0.72 + 0.12 + d * 0.26;
  const stackPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, h * 0.9, 14), std(0x6b7683));
  stackPipe.position.set(-w / 2 + 0.5, h * 0.72 + h * 0.45, -d / 2 + 0.5);
  const burner = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.5, 12), std(0x3a4a5a));
  burner.rotation.x = Math.PI / 2;
  burner.position.set(w * 0.12, h * 0.3, d / 2 + 0.22);
  g.add(body, base, drum, stackPipe, burner);
  return g;
};

builders.chiller = function ({ w, h, d }) {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, d), std(0x55606c));
  frame.position.y = 0.07;
  const evap = new THREE.Mesh(new THREE.CylinderGeometry(d * 0.34, d * 0.34, w * 0.9, 16), std(0x9aa7b4));
  evap.rotation.z = Math.PI / 2;
  evap.position.y = 0.14 + d * 0.34;
  const cond = evap.clone();
  cond.position.y = evap.position.y + d * 0.72;
  const compr = new THREE.Mesh(new THREE.CylinderGeometry(d * 0.2, d * 0.2, w * 0.34, 12), std(0x2e6da8));
  compr.rotation.z = Math.PI / 2;
  compr.position.set(w * 0.1, cond.position.y + d * 0.42, 0);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.5, h * 0.7, 0.22), std(0x3a4a5a));
  panel.position.set(w / 2 - 0.3, h * 0.42, d / 2 + 0.12);
  g.add(frame, evap, cond, compr, panel);
  return g;
};

builders.deaerator = function ({ r, len }) {
  const g = new THREE.Group();
  const storH = r * 2.2;
  const stor = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r * 0.92, storH, 20), std(0x9aa7b4));
  stor.position.y = storH / 2 + 0.15;
  const drumY = storH + 0.15 + r * 0.9;
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.78, r * 0.78, len * 0.8, 18), std(0x8d99a6));
  drum.rotation.z = Math.PI / 2;
  drum.position.y = drumY;
  for (const sx of [-1, 1]) {
    const headCap = new THREE.Mesh(new THREE.SphereGeometry(r * 0.78, 16, 10), std(0x8d99a6));
    headCap.scale.x = 0.55;
    headCap.position.set(sx * len * 0.4, drumY, 0);
    g.add(headCap);
  }
  const domeVent = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.3, r * 0.8, 12), std(0x6b7683));
  domeVent.position.set(0, drumY + r * 1.1, 0);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.98, r * 1.04, 0.15, 20), std(0x55606c));
  ring.position.y = 0.075;
  g.add(stor, drum, domeVent, ring);
  return g;
};

builders.transformer = function ({ w, h, d }) {
  const g = new THREE.Group();
  const tank = new THREE.Mesh(new THREE.BoxGeometry(w * 0.62, h * 0.62, d), std(0x6b7683, { metalness: 0.3, roughness: 0.6 }));
  tank.position.y = h * 0.31 + 0.1;
  const base = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.1, d * 1.05), std(0x3a4a5a));
  base.position.y = 0.05;
  g.add(tank, base);
  for (const sx of [-1, 1]) {                     // 兩側散熱鰭片
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(w * 0.16, h * 0.52, 0.06), std(0x55606c));
      fin.position.set(sx * w * 0.39, h * 0.31 + 0.1, -d / 2 + 0.12 + (i * (d - 0.24)) / 3);
      g.add(fin);
    }
  }
  for (let i = -1; i <= 1; i++) {                 // 三相套管
    const bushing = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, h * 0.3, 8), std(0xb8c2cc));
    bushing.position.set(i * w * 0.18, h * 0.62 + 0.1 + h * 0.15, 0);
    g.add(bushing);
  }
  const conservator = new THREE.Mesh(new THREE.CylinderGeometry(d * 0.14, d * 0.14, w * 0.5, 12), std(0x9aa7b4));
  conservator.rotation.z = Math.PI / 2;
  conservator.position.set(0, h * 0.86, -d / 2 + 0.05);
  g.add(conservator);
  return g;
};

builders.mcc = function ({ w, h, d }) {
  const g = new THREE.Group();
  const n = Math.max(2, Math.round(w / 0.8));
  const cw = w / n;
  for (let i = 0; i < n; i++) {
    const cab = new THREE.Mesh(new THREE.BoxGeometry(cw * 0.94, h, d), std(0x3a4a5a));
    cab.position.set(-w / 2 + cw * (i + 0.5), h / 2 + 0.05, 0);
    const door = new THREE.Mesh(new THREE.BoxGeometry(cw * 0.8, h * 0.86, 0.03), std(0x55606c));
    door.position.set(cab.position.x, h / 2 + 0.05, d / 2 + 0.02);
    g.add(cab, door);
  }
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, 0.1, d * 1.02), std(0x2a333d));
  plinth.position.y = 0.05;
  g.add(plinth);
  return g;
};

builders.genset = function ({ w, h, d }) {
  const g = new THREE.Group();
  const skidBase = new THREE.Mesh(new THREE.BoxGeometry(w, 0.16, d), std(0xd9a53a));
  skidBase.position.y = 0.08;
  const engine = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, h * 0.6, d * 0.72), std(0x3a4a5a));
  engine.position.set(-w * 0.13, h * 0.3 + 0.16, 0);
  const alternator = new THREE.Mesh(new THREE.CylinderGeometry(d * 0.3, d * 0.3, w * 0.3, 14), std(0x2e6da8));
  alternator.rotation.z = Math.PI / 2;
  alternator.position.set(w * 0.24, h * 0.3 + 0.16, 0);
  const radiator = new THREE.Mesh(new THREE.BoxGeometry(w * 0.1, h * 0.62, d * 0.8), std(0x55606c));
  radiator.position.set(-w / 2 + w * 0.06, h * 0.31 + 0.16, 0);
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, h * 0.5, 10), std(0x6b7683));
  exhaust.position.set(-w * 0.2, h * 0.85 + 0.16, d * 0.2);
  g.add(skidBase, engine, alternator, radiator, exhaust);
  return g;
};

builders.safetyshower = function ({ h }) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, h, 10), std(0x2e8b57));
  pole.position.y = h / 2;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 8), std(0x2e8b57));
  arm.rotation.z = Math.PI / 2;
  arm.position.set(0.25, h - 0.05, 0);
  const showerHead = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.05, 0.12, 14), std(0x9aa7b4));
  showerHead.position.set(0.5, h - 0.12, 0);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.12, 0.1, 14), std(0x9aa7b4));
  bowl.position.set(0.3, 1.05, 0);
  const basePlate = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.06, 12), std(0x55606c));
  basePlate.position.y = 0.03;
  g.add(pole, arm, showerHead, bowl, basePlate);
  return g;
};

builders.cageladder = function ({ h }) {
  const g = new THREE.Group();
  const railMat = std(0x8d99a6);
  for (const sx of [-0.22, 0.22]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, h, 0.05), railMat);
    rail.position.set(sx, h / 2, 0);
    g.add(rail);
  }
  const rungs = Math.floor(h / 0.3);
  for (let i = 1; i <= rungs; i++) {
    const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.44, 6), railMat);
    rung.rotation.z = Math.PI / 2;
    rung.position.y = i * 0.3;
    g.add(rung);
  }
  for (let y = 2.2; y < h - 0.2; y += 0.6) {      // 2.2m 以上護籠圈
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.02, 6, 16, Math.PI), railMat);
    hoop.rotation.x = -Math.PI / 2;
    hoop.position.set(0, y, 0.05);
    g.add(hoop);
  }
  return g;
};

// -------------------------------------------------- 管線支撐＋儀電橋架（elec discipline）
builders.psupport = function ({ h, r }) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.36), std(0x55606c));
  base.position.y = 0.03;
  const postH = Math.max(h - 0.05, 0.1);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, postH, 0.12), std(0x6b7683));
  post.position.y = postH / 2 + 0.06;
  const saddle = new THREE.Mesh(new THREE.TorusGeometry(Math.max(r * 1.1, 0.07), 0.035, 6, 14, Math.PI), std(0x8d99a6));
  saddle.rotation.z = Math.PI;                    // 開口朝上承管；管沿 Z 通過（放置時 rot_y 對齊管向）
  saddle.position.y = h + 0.01;
  g.add(base, post, saddle);
  return g;
};

builders.cabletray = function ({ w, len, elev }) {
  const g = new THREE.Group();
  const m = std(0x7f8a96, { metalness: 0.4, roughness: 0.5 });
  for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(len, 0.09, 0.04), m);
    rail.position.set(0, elev + 0.045, sz * (w / 2));
    g.add(rail);
  }
  const n = Math.max(2, Math.floor(len / 0.35));
  for (let i = 0; i <= n; i++) {
    const rung = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, w), m);
    rung.position.set(-len / 2 + (len * i) / n, elev + 0.02, 0);
    g.add(rung);
  }
  return g;
};

builders.traybend = function ({ w, elev }) {
  const g = new THREE.Group();
  const m = std(0x7f8a96, { metalness: 0.4, roughness: 0.5 });
  const L = w * 2.2;
  const armX = new THREE.Mesh(new THREE.BoxGeometry(L, 0.05, w), m);
  armX.position.set(L / 2 - w / 2, elev + 0.025, 0);
  const armZ = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, L), m);
  armZ.position.set(0, elev + 0.025, L / 2 - w / 2);
  g.add(armX, armZ);
  return g;
};

builders.trayriser = function ({ w, h }) {
  const g = new THREE.Group();
  const m = std(0x7f8a96, { metalness: 0.4, roughness: 0.5 });
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.04, h, 0.09), m);
    rail.position.set(sx * (w / 2), h / 2, 0);
    g.add(rail);
  }
  const n = Math.max(2, Math.floor(h / 0.35));
  for (let i = 0; i <= n; i++) {
    const rung = new THREE.Mesh(new THREE.BoxGeometry(w, 0.035, 0.03), m);
    rung.position.set(0, Math.max((h * i) / n, 0.02), 0);
    g.add(rung);
  }
  return g;
};

builders.jbox = function ({ w, h, d }) {
  const g = new THREE.Group();
  const mount = 0.8;                               // 掛桿安裝高度
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0x8b95a1, { metalness: 0.3, roughness: 0.55 }));
  box.position.y = mount + h / 2;
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.07, mount + h / 2, 0.07), std(0x55606c));
  pole.position.y = (mount + h / 2) / 2;
  const door = new THREE.Mesh(new THREE.BoxGeometry(w * 0.86, h * 0.86, 0.02), std(0x707c88));
  door.position.set(0, mount + h / 2, d / 2 + 0.012);
  g.add(box, pole, door);
  return g;
};

builders.lightpole = function ({ h }) {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, h, 10), std(0x6b7683));
  pole.position.y = h / 2;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.1, 8), std(0x6b7683));
  arm.rotation.z = Math.PI / 2;
  arm.position.set(0.5, h - 0.15, 0);
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.1, 0.24), std(0xdfe6ee));
  lamp.position.set(1.0, h - 0.2, 0);
  const basePl = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.08, 10), std(0x55606c));
  basePl.position.y = 0.04;
  g.add(pole, arm, lamp, basePl);
  return g;
};

// -------------------------------------------------- 風管 HVAC（hvac discipline）
builders.duct = function ({ w, h, len, elev }) {
  const g = new THREE.Group();
  const m = std(0xaeb6bf, { metalness: 0.5, roughness: 0.35 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(len, h, w), m);
  body.position.y = elev + h / 2;
  g.add(body);
  const nf = Math.max(1, Math.floor(len / 1.5));
  for (let i = 0; i <= nf; i++) {                 // 法蘭接縫
    const fl = new THREE.Mesh(new THREE.BoxGeometry(0.05, h + 0.1, w + 0.1), std(0x8d99a6));
    fl.position.set(-len / 2 + (len * i) / nf, elev + h / 2, 0);
    g.add(fl);
  }
  return g;
};

builders.ductbend = function ({ w, h, elev }) {
  const g = new THREE.Group();
  const m = std(0xaeb6bf, { metalness: 0.5, roughness: 0.35 });
  const L = Math.max(w * 2, 1.2);
  const armX = new THREE.Mesh(new THREE.BoxGeometry(L, h, w), m);
  armX.position.set(L / 2 - w / 2, elev + h / 2, 0);
  const armZ = new THREE.Mesh(new THREE.BoxGeometry(w, h, L), m);
  armZ.position.set(0, elev + h / 2, L / 2 - w / 2);
  g.add(armX, armZ);
  return g;
};

builders.ductriser = function ({ w, h, hgt }) {
  const g = new THREE.Group();
  const m = std(0xaeb6bf, { metalness: 0.5, roughness: 0.35 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, h), m);
  body.position.y = hgt / 2;
  g.add(body);
  for (let y = 1; y < hgt; y += 1.5) {
    const fl = new THREE.Mesh(new THREE.BoxGeometry(w + 0.1, 0.05, h + 0.1), std(0x8d99a6));
    fl.position.y = y;
    g.add(fl);
  }
  return g;
};

builders.ahu = function ({ w, h, d }) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, 0.12, d * 1.02), std(0x55606c));
  base.position.y = 0.06;
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), std(0xb9c1ca, { metalness: 0.35, roughness: 0.5 }));
  box.position.y = h / 2 + 0.12;
  g.add(base, box);
  const seams = Math.max(2, Math.round(w / 1.2));
  for (let i = 1; i < seams; i++) {               // 模組段接縫
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.03, h, d + 0.04), std(0x8d99a6));
    seam.position.set(-w / 2 + (w * i) / seams, h / 2 + 0.12, 0);
    g.add(seam);
  }
  const fanRing = new THREE.Mesh(new THREE.TorusGeometry(h * 0.26, 0.05, 8, 20), std(0x3a4a5a));
  fanRing.position.set(w / 2 - 0.01, h * 0.55, 0);
  fanRing.rotation.y = Math.PI / 2;
  const outlet = new THREE.Mesh(new THREE.BoxGeometry(0.5, h * 0.4, d * 0.4), std(0xaeb6bf));
  outlet.position.set(w / 2 + 0.25, h * 0.7, 0);
  g.add(fanRing, outlet);
  return g;
};

builders.rooffan = function ({ r, h }) {
  const g = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.75, r * 0.9, h * 0.55, 14), std(0x9aa7b4));
  stem.position.y = h * 0.275;
  const cowl = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.75, h * 0.3, 14), std(0x8d99a6));
  cowl.position.y = h * 0.7;
  const rainCap = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.15, r * 1.15, 0.06, 14), std(0x55606c));
  rainCap.position.y = h * 0.88;
  const motor = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.2, r * 0.2, 0.3, 10), std(0x2e6da8));
  motor.position.y = h * 0.95;
  g.add(stem, cowl, rainCap, motor);
  return g;
};

// -------------------------------------------------- 管線元件（Piping Components）
// E3D Component Editor：閥/法蘭對/異徑管/止回閥，沿管線弧長定位
export function buildPipeComponent(kind, r) {
  const g = new THREE.Group();
  const m = std(0xb8c2cc, { metalness: 0.35, roughness: 0.5 });
  const R = Math.max(r * 2.2, 0.16);
  if (kind === 'valve') {
    const c1 = new THREE.Mesh(new THREE.ConeGeometry(R, R * 1.5, 12), m);
    c1.rotation.z = -Math.PI / 2;
    c1.position.x = -R * 0.75;
    const c2 = new THREE.Mesh(new THREE.ConeGeometry(R, R * 1.5, 12), m);
    c2.rotation.z = Math.PI / 2;
    c2.position.x = R * 0.75;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.35, r * 0.35, R * 1.6, 8), m);
    stem.position.y = R * 0.8;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(R * 0.7, r * 0.3, 6, 16), m);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.y = R * 1.6;
    g.add(c1, c2, stem, wheel);
  } else if (kind === 'check') {
    const c1 = new THREE.Mesh(new THREE.ConeGeometry(R, R * 1.5, 12), m);
    c1.rotation.z = -Math.PI / 2;
    c1.position.x = -R * 0.75;
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(R, R, r * 0.6, 14), m);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = R * 0.55;
    g.add(c1, disc);
  } else if (kind === 'flangepair') {
    for (const dx of [-1, 1]) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.85, R * 0.85, r * 0.55, 16), m);
      f.rotation.z = Math.PI / 2;
      f.position.x = dx * r * 0.45;
      g.add(f);
    }
  } else if (kind === 'reducer') {
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 1.05, R * 1.4, 16), m);
    cone.rotation.z = -Math.PI / 2;
    g.add(cone);
  } else if (kind === 'ball') {
    const body = new THREE.Mesh(new THREE.SphereGeometry(R * 0.85, 14, 10), m);
    const lever = new THREE.Mesh(new THREE.BoxGeometry(R * 1.5, r * 0.4, r * 0.4), m);
    lever.position.set(R * 0.4, R * 1.0, 0);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.3, R * 0.9, 8), m);
    stem.position.y = R * 0.55;
    g.add(body, stem, lever);
  } else if (kind === 'bfly') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.8, R * 0.8, r * 1.1, 16), m);
    body.rotation.z = Math.PI / 2;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.28, r * 0.28, R * 1.2, 8), m);
    stem.position.y = R * 0.55;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(R * 1.1, r * 0.35, r * 0.5), m);
    handle.position.y = R * 1.15;
    g.add(body, stem, handle);
  } else if (kind === 'psv') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.55, R * 0.7, R * 1.2, 12), m);
    body.position.y = R * 0.6;
    const bonnet = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.35, R * 0.35, R * 0.9, 10), m);
    bonnet.position.y = R * 1.6;
    const outlet = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r * 0.8, R * 1.0, 10), m);
    outlet.rotation.x = Math.PI / 2;
    outlet.position.set(0, R * 0.8, R * 0.6);
    g.add(body, bonnet, outlet);
  } else if (kind === 'fm') {
    const body = new THREE.Mesh(new THREE.BoxGeometry(R * 1.6, R * 1.3, R * 1.1), m);
    const disp = new THREE.Mesh(new THREE.BoxGeometry(R * 0.9, R * 0.55, r * 0.3), std(0x2c3e50));
    disp.position.set(0, R * 0.45, R * 0.6);
    g.add(body, disp);
  }
  return g;
}

export const PIPE_COMPONENTS = [
  { kind: 'valve', name: '閘閥' },
  { kind: 'ball', name: '球閥' },
  { kind: 'bfly', name: '蝶閥' },
  { kind: 'check', name: '止回閥' },
  { kind: 'psv', name: '安全閥' },
  { kind: 'flangepair', name: '法蘭對' },
  { kind: 'reducer', name: '異徑管' },
  { kind: 'fm', name: '流量計' },
];

// -------------------------------------------------- 管線規格目錄（spec-driven）
// E3D Specification：選 spec+bore 決定管徑/材質色；元件依 spec 語境選型
export const PIPE_SPECS = [
  { code: 'A1A', name: '碳鋼 150#', color: 0x646f7b },
  { code: 'A3B', name: '碳鋼 300#', color: 0x5a6b7d },
  { code: 'F1C', name: '不銹鋼 150#', color: 0x8d99a6 },
  { code: 'B4B', name: '合金鋼 600#', color: 0x7d6a55 },
  { code: 'PVC', name: 'PVC 化工', color: 0x9a8fb0 },
];
export const PIPE_BORES = [
  { dn: 'DN25', r: 0.017 }, { dn: 'DN40', r: 0.024 }, { dn: 'DN50', r: 0.03 },
  { dn: 'DN80', r: 0.045 }, { dn: 'DN100', r: 0.057 }, { dn: 'DN150', r: 0.084 },
  { dn: 'DN200', r: 0.11 }, { dn: 'DN250', r: 0.14 }, { dn: 'DN300', r: 0.16 },
  { dn: 'DN400', r: 0.21 }, { dn: 'DN500', r: 0.26 },
];
// E3D Schedule（管壁厚）：pipe.r＝外半徑固定不變，schedule 決定壁厚→內徑 bore
// 壁厚採 ASME B36.10 實值（mm）；本 DN 範圍內 STD≈Sch40、XS≈Sch80
export const PIPE_SCHEDULES = ['STD', '40', '80', 'XS'];
const PIPE_WALL_40 = { DN25: 3.38, DN40: 3.68, DN50: 3.91, DN80: 5.49, DN100: 6.02,
  DN150: 7.11, DN200: 8.18, DN250: 9.27, DN300: 10.31, DN400: 12.70, DN500: 15.09 };
const PIPE_WALL_80 = { DN25: 4.55, DN40: 5.08, DN50: 5.54, DN80: 7.62, DN100: 8.56,
  DN150: 10.97, DN200: 12.70, DN250: 15.09, DN300: 17.48, DN400: 21.44, DN500: 26.19 };
// 回傳管壁厚（公尺）；查無 DN 或自訂外徑時回 null
export function pipeWall(dn, sched) {
  if (!dn) return null;
  const t = (sched === '80' || sched === 'XS') ? PIPE_WALL_80 : PIPE_WALL_40;
  return t[dn] != null ? t[dn] / 1000 : null;
}

// 素材目錄（編輯器面板用）
export const ASSET_CATEGORIES = [
  { name: '反應設備', items: [
    { type: 'reactor', name: '攪拌反應器', dims: { r: 1.5, h: 4 }, prefix: 'R' },
    { type: 'fixedbed', name: '固定床反應器', dims: { r: 1.2, h: 7 }, prefix: 'R' },
    { type: 'pfr', name: '管式反應器', dims: { r: 0.25, len: 5, rows: 3 }, prefix: 'R' },
    { type: 'agitank', name: '攪拌槽', dims: { r: 1.3, h: 3 }, prefix: 'M' },
    { type: 'rotarykiln', name: '迴轉窯（乾燥/焚化）', dims: { r: 1.1, len: 9 }, prefix: 'RK' },
  ]},
  { name: '分離設備', items: [
    { type: 'column', name: '蒸餾塔', dims: { r: 1.2, h: 9 }, prefix: 'C' },
    { type: 'packedcol', name: '填充塔', dims: { r: 1.0, h: 8 }, prefix: 'C' },
    { type: 'flash_v', name: '立式閃蒸罐', dims: { r: 1.0, h: 4 }, prefix: 'V' },
    { type: 'flash_h', name: '臥式分離槽', dims: { r: 1.1, len: 4.5 }, prefix: 'V' },
    { type: 'cyclone', name: '旋風分離器', dims: { r: 0.8, h: 4 }, prefix: 'S' },
    { type: 'filterv', name: '籃式過濾器', dims: { r: 0.6, h: 2.4 }, prefix: 'FL' },
    { type: 'scrubber', name: '洗滌塔', dims: { r: 1.0, h: 6 }, prefix: 'C' },
    { type: 'centrifuge', name: '離心機', dims: { r: 0.9, h: 1.2 }, prefix: 'CF' },
    { type: 'baghouse', name: '袋式集塵器', dims: { w: 3, h: 4.5, d: 2.2 }, prefix: 'BF' },
  ]},
  { name: '熱交換', items: [
    { type: 'hx', name: '殼管熱交換器', dims: { r: 0.5, len: 3 }, prefix: 'E' },
    { type: 'kettle', name: '釜式再沸器', dims: { r: 0.9, len: 4 }, prefix: 'E' },
    { type: 'platehx', name: '板式熱交換器', dims: { w: 1.6, h: 1.4, d: 0.8 }, prefix: 'E' },
    { type: 'aircooler', name: '空冷器', dims: { w: 4.5, h: 3, d: 2.5 }, prefix: 'E' },
    { type: 'furnace', name: '加熱爐', dims: { w: 3, h: 3, d: 2.5 }, prefix: 'F' },
  ]},
  { name: '流體機械', items: [
    { type: 'pump', name: '離心泵', dims: { w: 1.0, h: 0.8, d: 0.7 }, prefix: 'P' },
    { type: 'compressor', name: '離心壓縮機', dims: { w: 3, h: 1.8, d: 1.6 }, prefix: 'K' },
    { type: 'recip', name: '往復壓縮機', dims: { w: 2.5, h: 1.6, d: 1.8 }, prefix: 'K' },
    { type: 'blower', name: '風機', dims: { w: 1.4, h: 1.2, d: 1.0 }, prefix: 'K' },
  ]},
  { name: '儲存容器', items: [
    { type: 'tank', name: '立式儲槽', dims: { r: 2, h: 5 }, prefix: 'T' },
    { type: 'bullet', name: '臥式儲槽', dims: { r: 1.3, len: 6 }, prefix: 'T' },
    { type: 'spheretank', name: '球槽', dims: { r: 3 }, prefix: 'T' },
    { type: 'hopper', name: '料倉', dims: { r: 1.4, h: 4 }, prefix: 'HP' },
    { type: 'skid', name: '撬裝設備', dims: { w: 3.6, h: 2.2, d: 2 }, prefix: 'SK' },
  ]},
  { name: '管閥儀錶', items: [
    { type: 'valve', name: '閥', dims: { s: 0.5 }, prefix: 'V' },
    { type: 'detector', name: '偵測器', dims: { h: 2.4 }, prefix: 'GD' },
  ]},
  { name: '公用結構', items: [
    { type: 'building', name: '建物', dims: { w: 6, h: 3, d: 4 }, prefix: 'B' },
    { type: 'block', name: '自由 BLOCK', dims: { w: 2, h: 2, d: 2 }, prefix: 'X' },
    { type: 'coolingtower', name: '冷卻水塔', dims: { w: 4, h: 4, d: 4 }, prefix: 'CT' },
    { type: 'flare', name: '火炬塔', dims: { h: 12 }, prefix: 'FL' },
    { type: 'stack', name: '煙囪', dims: { r: 0.8, h: 14 }, prefix: 'ST' },
    { type: 'piperack', name: '管架', dims: { w: 8, h: 4, d: 2, bays: 4 }, prefix: 'PR' },
    { type: 'conveyor', name: '輸送帶', dims: { len: 8, h: 2, w: 1 }, prefix: 'CV' },
    { type: 'boiler', name: '蒸汽鍋爐', dims: { w: 3.2, h: 3.4, d: 2.6 }, prefix: 'B' },
    { type: 'chiller', name: '冰水機組', dims: { w: 3, h: 1.9, d: 1.2 }, prefix: 'CH' },
    { type: 'deaerator', name: '除氧器', dims: { r: 0.9, len: 4 }, prefix: 'DA' },
    { type: 'safetyshower', name: '安全淋浴洗眼站', dims: { h: 2.4 }, prefix: 'SS' },
  ]},
  { name: '電氣設備', items: [
    { type: 'transformer', name: '油浸式變壓器', dims: { w: 2.4, h: 2.2, d: 1.6 }, prefix: 'TR' },
    { type: 'mcc', name: 'MCC 配電盤列', dims: { w: 4, h: 2.2, d: 0.8 }, prefix: 'MCC' },
    { type: 'genset', name: '柴油發電機組', dims: { w: 4, h: 2.2, d: 1.6 }, prefix: 'G' },
  ]},
  { name: '結構鋼構', discipline: 'struct', items: [
    { type: 'scolumn', name: 'H 型鋼柱', dims: { h: 4 }, prefix: 'SC' },
    { type: 'sbeam', name: 'H 型鋼樑', dims: { len: 5, elev: 3 }, prefix: 'SB' },
    { type: 'stairs', name: '樓梯', dims: { w: 1.0, h: 3, run: 3.6 }, prefix: 'STR' },
    { type: 'srail', name: '扶手欄杆', dims: { len: 4 }, prefix: 'HR' },
    { type: 'cageladder', name: '籠式直爬梯', dims: { h: 6 }, prefix: 'LD' },
    { type: 'psupport', name: '管線支撐', dims: { h: 1.2, r: 0.12 }, prefix: 'PS' },
    { type: 'splat', name: '平台', dims: { w: 3, d: 2.4, elev: 3 }, prefix: 'PF' },
  ]},
  { name: '儀電橋架', discipline: 'elec', items: [
    { type: 'cabletray', name: '電纜橋架（直線）', dims: { w: 0.45, len: 6, elev: 3 }, prefix: 'CT' },
    { type: 'traybend', name: '橋架水平彎', dims: { w: 0.45, elev: 3 }, prefix: 'CT' },
    { type: 'trayriser', name: '橋架垂直段', dims: { w: 0.45, h: 3 }, prefix: 'CT' },
    { type: 'jbox', name: '接線箱', dims: { w: 0.6, h: 0.8, d: 0.3 }, prefix: 'JB' },
    { type: 'lightpole', name: '廠區照明燈桿', dims: { h: 6 }, prefix: 'LP' },
  ]},
  { name: '風管 HVAC', discipline: 'hvac', items: [
    { type: 'duct', name: '矩形風管（直管）', dims: { w: 0.8, h: 0.5, len: 6, elev: 3 }, prefix: 'DU' },
    { type: 'ductbend', name: '風管水平彎', dims: { w: 0.8, h: 0.5, elev: 3 }, prefix: 'DU' },
    { type: 'ductriser', name: '風管垂直段', dims: { w: 0.8, h: 0.5, hgt: 3 }, prefix: 'DU' },
    { type: 'ahu', name: '空調箱 AHU', dims: { w: 3.6, h: 2, d: 1.6 }, prefix: 'AHU' },
    { type: 'rooffan', name: '屋頂排風機', dims: { r: 0.55, h: 1.4 }, prefix: 'EF' },
  ]},
  { name: '基元（自建設備）', items: [
    { type: 'assembly', name: '自建設備', dims: {},
      prims: [{ kind: 'cyli', dims: { r: 1.0, h: 2.5 }, pos: [0, 0, 0] }], prefix: 'EQ' },
  ]},
];
export const ASSET_CATALOG = ASSET_CATEGORIES.flatMap((c) => c.items);

export { std, markShadow, builders, dm, dPad, dFlange, dNozzle, dLadder, dHandrailRing, detailedBuilders, mergeByMaterial, labelHeight };
