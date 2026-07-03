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
function hSection(len, depth = 0.24, flange = 0.18, t = 0.028) {
  // 沿 Y 軸的 H 型鋼（柱姿態），樑用旋轉擺放
  const g = new THREE.Group();
  const web = new THREE.Mesh(new THREE.BoxGeometry(t, len, depth - 2 * t), steelMat);
  const f1 = new THREE.Mesh(new THREE.BoxGeometry(flange, len, t), steelMat);
  f1.position.z = (depth - t) / 2;
  const f2 = f1.clone();
  f2.position.z = -(depth - t) / 2;
  g.add(web, f1, f2);
  g.children.forEach((c) => c.geometry.translate(0, len / 2, 0));
  return g;
}

builders.scolumn = function ({ h }) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.03, 0.42), steelMat);
  base.position.y = 0.015;
  g.add(base, hSection(h));
  return g;
};

builders.sbeam = function ({ len, elev }) {
  const g = new THREE.Group();
  const beam = hSection(len);
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
  }
  return g;
}

export const PIPE_COMPONENTS = [
  { kind: 'valve', name: '閘閥' },
  { kind: 'check', name: '止回閥' },
  { kind: 'flangepair', name: '法蘭對' },
  { kind: 'reducer', name: '異徑管' },
];

// 素材目錄（編輯器面板用）
export const ASSET_CATEGORIES = [
  { name: '反應設備', items: [
    { type: 'reactor', name: '攪拌反應器', dims: { r: 1.5, h: 4 }, prefix: 'R' },
    { type: 'fixedbed', name: '固定床反應器', dims: { r: 1.2, h: 7 }, prefix: 'R' },
    { type: 'pfr', name: '管式反應器', dims: { r: 0.25, len: 5, rows: 3 }, prefix: 'R' },
  ]},
  { name: '分離設備', items: [
    { type: 'column', name: '蒸餾塔', dims: { r: 1.2, h: 9 }, prefix: 'C' },
    { type: 'packedcol', name: '填充塔', dims: { r: 1.0, h: 8 }, prefix: 'C' },
    { type: 'flash_v', name: '立式閃蒸罐', dims: { r: 1.0, h: 4 }, prefix: 'V' },
    { type: 'flash_h', name: '臥式分離槽', dims: { r: 1.1, len: 4.5 }, prefix: 'V' },
    { type: 'cyclone', name: '旋風分離器', dims: { r: 0.8, h: 4 }, prefix: 'S' },
  ]},
  { name: '熱交換', items: [
    { type: 'hx', name: '殼管熱交換器', dims: { r: 0.5, len: 3 }, prefix: 'E' },
    { type: 'kettle', name: '釜式再沸器', dims: { r: 0.9, len: 4 }, prefix: 'E' },
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
  ]},
  { name: '結構鋼構', discipline: 'struct', items: [
    { type: 'scolumn', name: 'H 型鋼柱', dims: { h: 4 }, prefix: 'SC' },
    { type: 'sbeam', name: 'H 型鋼樑', dims: { len: 5, elev: 3 }, prefix: 'SB' },
    { type: 'stairs', name: '樓梯', dims: { w: 1.0, h: 3, run: 3.6 }, prefix: 'STR' },
    { type: 'srail', name: '扶手欄杆', dims: { len: 4 }, prefix: 'HR' },
    { type: 'splat', name: '平台', dims: { w: 3, d: 2.4, elev: 3 }, prefix: 'PF' },
  ]},
  { name: '基元（自建設備）', items: [
    { type: 'assembly', name: '自建設備', dims: {},
      prims: [{ kind: 'cyli', dims: { r: 1.0, h: 2.5 }, pos: [0, 0, 0] }], prefix: 'EQ' },
  ]},
];
export const ASSET_CATALOG = ASSET_CATEGORIES.flatMap((c) => c.items);

export { std, markShadow, builders, dm, dPad, dFlange, dNozzle, dLadder, dHandrailRing, detailedBuilders, mergeByMaterial, labelHeight };
