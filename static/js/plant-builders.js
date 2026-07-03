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
    case 'reactor': case 'tank': return d.h + 1.2;
    case 'hx': return d.r + 1.6;
    case 'building': return d.h + 1.0;
    case 'detector': return d.h + 0.6;
    default: return 1.7;
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

// 素材目錄（編輯器面板用）
export const ASSET_CATALOG = [
  { type: 'reactor', name: '反應器', dims: { r: 1.5, h: 4 }, prefix: 'R' },
  { type: 'column', name: '蒸餾塔', dims: { r: 1.2, h: 9 }, prefix: 'C' },
  { type: 'tank', name: '儲槽', dims: { r: 2, h: 5 }, prefix: 'T' },
  { type: 'valve', name: '閥', dims: { s: 0.5 }, prefix: 'V' },
  { type: 'pump', name: '泵', dims: { w: 1.0, h: 0.8, d: 0.7 }, prefix: 'P' },
  { type: 'hx', name: '熱交換器', dims: { r: 0.5, len: 3 }, prefix: 'E' },
  { type: 'furnace', name: '加熱爐', dims: { w: 3, h: 3, d: 2.5 }, prefix: 'F' },
  { type: 'detector', name: '偵測器', dims: { h: 2.4 }, prefix: 'GD' },
  { type: 'building', name: '建物', dims: { w: 6, h: 3, d: 4 }, prefix: 'B' },
];

export { std, markShadow, builders, dm, dPad, dFlange, dNozzle, dLadder, dHandrailRing, detailedBuilders, mergeByMaterial, labelHeight };
