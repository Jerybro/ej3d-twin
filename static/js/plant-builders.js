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
  } else if (p.kind === 'extr') {
    // EXTR 擠出：沿 Y 擠出多邊形截面。dims.poly=[[x,z],...] 用之，否則以正 sides 邊形（半徑 r）
    const shape = new THREE.Shape();
    let poly = d.poly;
    if (!Array.isArray(poly) || poly.length < 3) {
      const sides = Math.max(3, Math.round(d.sides ?? 6));
      const r = d.r ?? 0.8;
      poly = [];
      for (let i = 0; i < sides; i++) {
        const a = Math.PI / 2 + (i * 2 * Math.PI) / sides;   // 頂點朝上起點
        poly.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
    }
    shape.moveTo(poly[0][0], poly[0][1]);
    for (let i = 1; i < poly.length; i++) shape.lineTo(poly[i][0], poly[i][1]);
    shape.closePath();
    const h = d.h ?? 2;
    const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    // ExtrudeGeometry 在 XY 平面擠向 +Z；轉成沿 +Y 由 y=0 往上長
    g.rotateX(-Math.PI / 2);
    mesh = new THREE.Mesh(g, std(0x9aa7b4));
  } else if (p.kind === 'revo') {
    // REVO 迴轉：側輪廓繞 Y 迴轉。dims.prof=[[x,y],...] 用之；否則生 (r,0)→(0,h) 之 1/4 橢圓（碟形封頭）
    let prof = d.prof;
    if (!Array.isArray(prof) || prof.length < 2) {
      const r = d.r ?? 1, h = d.h ?? 1, n = 12;
      prof = [];
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * (Math.PI / 2);
        prof.push([Math.cos(t) * r, Math.sin(t) * h]);   // x=半徑, y=高
      }
    }
    const pts = prof.map(([x, y]) => new THREE.Vector2(x, y));
    const g = new THREE.LatheGeometry(pts, Math.max(3, Math.round(d.seg ?? 24)));
    mesh = new THREE.Mesh(g, std(0x9aa7b4));
  } else {
    mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), std(0x8a97a5));
  }
  mesh.position.set(...(p.pos ?? [0, 0, 0]));
  mesh.rotation.set(p.rot_x ?? 0, p.rot_y ?? 0, p.rot_z ?? 0);
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
// shape 欄位（向後相容：I/H 型皆標 shape:'I'，缺 shape 者一律視為 'I'）：
//   I  → I/H 型鋼：{depth,flange,web(tw),tf}
//   L  → 角鋼：    {shape:'L',depth,flange,t}（等/不等邊，depth=長邊、flange=短邊、t=肢厚）
//   C  → 槽鋼PFC： {shape:'C',depth,flange,web(tw),tf}（腹板+同側上下翼板）
//   RHS→ 矩形中空： {shape:'RHS',depth,flange,t}（depth 沿 Z、flange 沿 X、t=壁厚）
//   SHS→ 方形中空： {shape:'SHS',side,t}
//   CHS→ 圓形中空： {shape:'CHS',od,t}（od=外徑）
export const STEEL_SECTIONS = [
  { code: 'IPE200', shape: 'I', depth: 200, flange: 100, web: 5.6, tf: 8.5 },
  { code: 'IPE300', shape: 'I', depth: 300, flange: 150, web: 7.1, tf: 10.7 },
  { code: 'IPE400', shape: 'I', depth: 400, flange: 180, web: 8.6, tf: 13.5 },
  { code: 'IPE500', shape: 'I', depth: 500, flange: 200, web: 10.2, tf: 16 },
  { code: 'HEA300', shape: 'I', depth: 290, flange: 300, web: 8.5, tf: 14 },
  { code: 'HEB200', shape: 'I', depth: 200, flange: 200, web: 9, tf: 15 },
  { code: 'HEB300', shape: 'I', depth: 300, flange: 300, web: 11, tf: 19 },
  { code: 'HEB400', shape: 'I', depth: 400, flange: 300, web: 13.5, tf: 24 },
  { code: 'UB305x165x40', shape: 'I', depth: 303.4, flange: 165, web: 6, tf: 10.2 },
  { code: 'UC254x254x73', shape: 'I', depth: 254.1, flange: 254.6, web: 8.6, tf: 14.2 },
  // 角鋼 L（等邊）
  { code: 'L100x100x10', shape: 'L', depth: 100, flange: 100, t: 10 },
  { code: 'L150x150x15', shape: 'L', depth: 150, flange: 150, t: 15 },
  // 槽鋼 PFC（歐規 channel）
  { code: 'PFC200x90', shape: 'C', depth: 200, flange: 90, web: 7, tf: 12.5 },
  { code: 'PFC300x100', shape: 'C', depth: 300, flange: 100, web: 9, tf: 16.5 },
  // 矩形中空 RHS
  { code: 'RHS200x100x8', shape: 'RHS', depth: 200, flange: 100, t: 8 },
  // 方形中空 SHS
  { code: 'SHS150x150x8', shape: 'SHS', side: 150, t: 8 },
  // 圓形中空 CHS
  { code: 'CHS168x8', shape: 'CHS', od: 168.3, t: 8 },
];
const STEEL_DEFAULT = STEEL_SECTIONS[6];   // HEB300 為預設（近似原本寫死斷面）
export function steelSection(code) {
  return STEEL_SECTIONS.find((s) => s.code === code) ?? STEEL_DEFAULT;
}
// 依 shape 產生人類可讀的斷面尺寸描述（mm）。各 shape 只用自己有的欄位，
// 避免對 I/H-only 的 depth/flange/web/tf 一律內插造成 undefined（QA major）。
export function sectionDesc(sec) {
  const s = sec ?? STEEL_DEFAULT;
  switch (s.shape) {
    case 'CHS': return `⌀${s.od}×t${s.t}`;
    case 'SHS': return `${s.side}×${s.side}×t${s.t}`;
    case 'RHS': return `${s.depth}×${s.flange}×t${s.t}`;
    case 'L': return `L${s.depth}×${s.flange}×${s.t}`;
    case 'C': return `C D${s.depth}×B${s.flange}｜tw${s.web}／tf${s.tf}`;
    default: return `D${s.depth}×B${s.flange}｜tw${s.web}／tf${s.tf}`;  // I/H
  }
}
// 定位線 Justification（對標 E3D P-line）：斷面在其斷面平面內偏移，使指定基準貼定位線。
// hSection 本地座標：長度沿 Y，斷面高 depth 沿 Z（頂面 +Z），翼板寬 flange 沿 X。
// NA=形心（不偏移）；CTOP/TOS=頂面貼線（往 -Z 移 D/2）；CBOT/BOS=底面貼線（往 +Z 移 D/2）；
// LEFT/RIGHT=翼板邊貼線（沿 X ±B/2）。柱直接用此本地偏移；樑旋轉後偏移隨之轉向，方向自動正確。
// 斷面外框 bounding（本地斷面平面：width 沿 X、height/depth 沿 Z），單位 m。
// 各 shape 以其外框而非翼板寬決定定位偏移，L/C/hollow 才會貼對邊。
function secBounds(sec) {
  switch (sec.shape) {
    case 'L': return { w: sec.flange / 1000, d: sec.depth / 1000 };
    case 'C': return { w: sec.flange / 1000, d: sec.depth / 1000 };
    case 'RHS': return { w: sec.flange / 1000, d: sec.depth / 1000 };
    case 'SHS': return { w: sec.side / 1000, d: sec.side / 1000 };
    case 'CHS': return { w: sec.od / 1000, d: sec.od / 1000 };
    default: return { w: sec.flange / 1000, d: sec.depth / 1000 };  // I/H
  }
}
function justOffset(sec, just = 'NA') {
  const { w: B, d: D } = secBounds(sec);
  switch (just) {
    case 'CTOP': case 'TOS': return { dx: 0, dz: -D / 2 };  // 頂面對齊：斷面下移
    case 'CBOT': case 'BOS': return { dx: 0, dz: D / 2 };   // 底面對齊：斷面上移
    case 'LEFT': return { dx: B / 2, dz: 0 };               // 左緣對齊
    case 'RIGHT': return { dx: -B / 2, dz: 0 };             // 右緣對齊
    default: return { dx: 0, dz: 0 };                       // NA：形心
  }
}
// I/H 型：腹板 + 上下兩翼板（本地：長度沿 Y、depth 沿 Z、翼板寬沿 X）
function buildISolid(len, sec, g) {
  const D = sec.depth / 1000, B = sec.flange / 1000, tw = sec.web / 1000, tf = sec.tf / 1000;
  const web = new THREE.Mesh(new THREE.BoxGeometry(tw, len, D - 2 * tf), steelMat);
  const f1 = new THREE.Mesh(new THREE.BoxGeometry(B, len, tf), steelMat);
  f1.position.z = (D - tf) / 2;
  const f2 = f1.clone();
  f2.position.z = -(D - tf) / 2;
  g.add(web, f1, f2);
}
// 角鋼 L：兩片板成 L（水平肢在底 -Z、垂直肢在左 -X）；形心近似置中處理，外框以 bounding 為準
function buildLSolid(len, sec, g) {
  const D = sec.depth / 1000, B = sec.flange / 1000, t = sec.t / 1000;
  // 垂直肢（沿 Z，厚度沿 X）
  const legV = new THREE.Mesh(new THREE.BoxGeometry(t, len, D), steelMat);
  legV.position.set(-B / 2 + t / 2, 0, 0);
  // 水平肢（沿 X，厚度沿 Z）——扣掉與垂直肢重疊段
  const legH = new THREE.Mesh(new THREE.BoxGeometry(B - t, len, t), steelMat);
  legH.position.set(t / 2, 0, -D / 2 + t / 2);
  g.add(legV, legH);
}
// 槽鋼 C(PFC)：腹板（在一側 -X）+ 同側上下兩翼板（往 +X 伸出）
function buildCSolid(len, sec, g) {
  const D = sec.depth / 1000, B = sec.flange / 1000, tw = sec.web / 1000, tf = sec.tf / 1000;
  const web = new THREE.Mesh(new THREE.BoxGeometry(tw, len, D), steelMat);
  web.position.set(-B / 2 + tw / 2, 0, 0);
  const f1 = new THREE.Mesh(new THREE.BoxGeometry(B - tw, len, tf), steelMat);
  f1.position.set(tw / 2, 0, (D - tf) / 2);
  const f2 = f1.clone();
  f2.position.z = -(D - tf) / 2;
  g.add(web, f1, f2);
}
// 矩形/方形中空 RHS/SHS：四片薄板拼成殼（中空看得出來）
function buildHollowRect(len, W, D, t, g) {
  const top = new THREE.Mesh(new THREE.BoxGeometry(W, len, t), steelMat);
  top.position.z = D / 2 - t / 2;
  const bot = top.clone(); bot.position.z = -(D / 2 - t / 2);
  const left = new THREE.Mesh(new THREE.BoxGeometry(t, len, D - 2 * t), steelMat);
  left.position.x = -(W / 2 - t / 2);
  const right = left.clone(); right.position.x = W / 2 - t / 2;
  g.add(top, bot, left, right);
}
// 圓形中空 CHS：外/內兩同心圓柱（沿 Y），兩端加環形蓋，示意中空管壁
function buildCHS(len, sec, g) {
  const ro = sec.od / 2000, t = sec.t / 1000, ri = Math.max(0.001, ro - t);
  const RS = 24;
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(ro, ro, len, RS, 1, true), steelMat);
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(ri, ri, len, RS, 1, true), steelMat);
  // 端環用「純幾何」變換：躺平(法線沿Y)＋各自移到本地 ∓len/2，之後由 sectionSolid 的
  // 統一 geometry.translate(dx,len/2,dz) 帶到兩端（y=0 與 y=len）。不可用 mesh.rotation/position，
  // 否則會被那一輪 geometry.translate 的 len/2 旋轉污染而飄離管軸；分開建 geometry 也避免共用被重複平移。
  const rg1 = new THREE.RingGeometry(ri, ro, RS); rg1.rotateX(-Math.PI / 2); rg1.translate(0, -len / 2, 0);
  const rg2 = new THREE.RingGeometry(ri, ro, RS); rg2.rotateX(Math.PI / 2); rg2.translate(0, len / 2, 0);
  g.add(outer, inner, new THREE.Mesh(rg1, steelMat), new THREE.Mesh(rg2, steelMat));
}
// 端部處理（構件端面裁切）：對已置於本地 y∈[0,len] 的斷面幾何做端面變形。
// end 物件：{ setback:退縮(m), miter:斜接角(度,繞本地Z depth 軸) }；y0End=true 表處理起端(y=0)，否則末端(y=len)。
// 作法：斷面沿 Y 為等斷面，長度盒兩端頂點恰在 y=0 / y=len；把該端頂點沿 Y 位移即可近似裁切。
//   setback → 該端整體內縮；miter → 端面頂點 y 依其斷面 depth 向(本地Z)線性偏移，形成斜切面。
function applyEndCut(geo, len, end, y0End) {
  const s = Math.max(0, end?.setback ?? 0);
  const ang = ((end?.miter ?? 0) * Math.PI) / 180;
  if (s === 0 && ang === 0) return;
  const tanA = Math.tan(ang);
  const pos = geo.attributes.position;
  const yEnd = y0End ? 0 : len;
  const inward = y0End ? 1 : -1;   // 內縮方向：起端往 +Y、末端往 -Y
  const eps = 1e-4;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (Math.abs(y - yEnd) > eps) continue;   // 只動該端平面上的頂點
    const z = pos.getZ(i);                     // 斷面 depth 向位置（本地 Z）
    pos.setY(i, y + inward * (s + z * tanA));  // 退縮 + 斜接（依 depth 位置線性）
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}
// 依 shape 分派建立斷面實體；本地座標：長度沿 Y、depth 沿 Z、寬沿 X。
// 各子件幾何最後平移 (dx, len/2, dz)：len/2 讓實體自 Y=0 往上長（沿用既有慣例），dx/dz 為定位線偏移。
// ends={ e1:{setback,miter}, e2:{...} } 為兩端（e1=y0起端、e2=y末端）端部處理參數。
function sectionSolid(len, sec = STEEL_DEFAULT, just = 'NA', ends = null) {
  const { dx, dz } = justOffset(sec, just);
  const g = new THREE.Group();
  switch (sec.shape) {
    case 'L': buildLSolid(len, sec, g); break;
    case 'C': buildCSolid(len, sec, g); break;
    case 'RHS': buildHollowRect(len, sec.flange / 1000, sec.depth / 1000, sec.t / 1000, g); break;
    case 'SHS': buildHollowRect(len, sec.side / 1000, sec.side / 1000, sec.t / 1000, g); break;
    case 'CHS': buildCHS(len, sec, g); break;
    default: buildISolid(len, sec, g); break;   // I/H（含缺 shape 者）
  }
  g.children.forEach((c) => {
    c.geometry.translate(dx, len / 2, dz);
    if (ends?.e1) applyEndCut(c.geometry, len, ends.e1, true);
    if (ends?.e2) applyEndCut(c.geometry, len, ends.e2, false);
  });
  return g;
}
// I 型相容包裝（保留舊名；一律走 sectionSolid 分派）
function hSection(len, sec = STEEL_DEFAULT, just = 'NA') {
  return sectionSolid(len, sec, just);
}

// 端部參數讀取：def.end1/def.end2 = { setback, miter }。回傳 sectionSolid 用的 ends 物件（無設定則 null）。
function endParams(def) {
  const norm = (e) => (e && ((e.setback ?? 0) !== 0 || (e.miter ?? 0) !== 0))
    ? { setback: e.setback ?? 0, miter: e.miter ?? 0 } : null;
  const e1 = norm(def?.end1), e2 = norm(def?.end2);
  return (e1 || e2) ? { e1, e2 } : null;
}
// 柱腳底板節點：底板 + 四角錨栓孔示意（示意幾何，掛在構件端）。
function basePlateNode(sec, y = 0) {
  const grp = new THREE.Group();
  const bp = Math.max(0.42, secBounds(sec).w + 0.12);
  const plate = new THREE.Mesh(new THREE.BoxGeometry(bp, 0.03, bp), steelMat);
  plate.position.y = y + 0.015;
  grp.add(plate);
  const boltR = 0.018, inset = bp / 2 - 0.06;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {   // 四角錨栓示意
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(boltR, boltR, 0.09, 8), std(0x5a636d));
    bolt.position.set(sx * inset, y + 0.045, sz * inset);
    grp.add(bolt);
  }
  return grp;
}
// 樑柱節點板 gusset / 端板：掛在構件端的三角節點板 + 端板示意（本地 Y 沿長度）。
function gussetNode(sec, atY, dir) {
  const grp = new THREE.Group();
  const { w: B, d: D } = secBounds(sec);
  const t = 0.012;
  // 端板（矩形，貼端面，法線沿 Y）
  const ep = new THREE.Mesh(new THREE.BoxGeometry(B * 1.1, t, D * 1.15), steelMat);
  ep.position.set(0, atY, 0);
  grp.add(ep);
  // 三角節點板（在端面外側，示意斜撐/樑柱連接），沿本地 Z depth 平面
  const gl = Math.min(0.35, D * 0.9 + 0.1);
  const tri = new THREE.Shape();
  tri.moveTo(0, 0); tri.lineTo(gl, 0); tri.lineTo(0, gl); tri.closePath();
  const gg = new THREE.ExtrudeGeometry(tri, { depth: t, bevelEnabled: false, steps: 1 });
  gg.translate(-t / 2, 0, 0);          // 厚度沿 X 置中
  gg.rotateY(Math.PI / 2);             // 板面落在 Y-Z（本地長度-depth）平面
  const gusset = new THREE.Mesh(gg, steelMat);
  gusset.position.set(0, atY + dir * 0.01, D / 2);
  gusset.scale.y = dir;                // 依端方向朝構件內側展開
  grp.add(gusset);
  return grp;
}

builders.scolumn = function ({ h }, def) {
  const sec = steelSection(def?.section);
  const just = def?.just ?? 'NA';
  const g = new THREE.Group();
  const node = def?.node ?? 'baseplate';
  if (node === 'baseplate') g.add(basePlateNode(sec, 0));        // 柱腳底板（預設，沿用原底板行為）
  else if (node === 'gusset') g.add(gussetNode(sec, 0, 1));      // 節點板示意
  g.add(sectionSolid(h, sec, just, endParams(def)));
  return g;
};

builders.sbeam = function ({ len, elev }, def) {
  const sec = steelSection(def?.section);
  const just = def?.just ?? 'NA';
  const g = new THREE.Group();
  const beam = sectionSolid(len, sec, just, endParams(def));
  const node = def?.node ?? 'none';
  if (node === 'gusset') {   // 兩端掛節點板示意（本地 y=0 與 y=len）
    beam.add(gussetNode(sec, 0, 1));
    beam.add(gussetNode(sec, len, -1));
  }
  // 樑姿態：長度(本地Y)→世界X、斷面高 depth(本地Z)→世界Y(垂直)、翼板寬(本地X)→世界Z(水平)。
  // 用 makeBasis 讓 depth 立起來，justOffset 的 TOS/BOS(本地Z→世界Y) 才是垂直對齊、LEFT/RIGHT 才是水平。
  beam.setRotationFromMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)));
  beam.position.set(-len / 2, elev ?? 3, 0);
  g.add(beam);
  return g;
};

// 樓梯：依總高與踏步 going 自動算級數(工安 rise≈0.18m)，畫踏板(格柵)+斜梁(stringer)
// +兩側斜扶手(頂桿1.0m/中桿+立柱)+頂端承接平台+踢腳板。
// dims {w:梯寬, h:總高, run:水平投影}(沿用既有 key)，可另給 {going:單階水平, rise:單階高}。
builders.stairs = function ({ w, h, run, going, rise }) {
  const g = new THREE.Group();
  const W = Math.max(0.6, w ?? 1.0);
  const H = Math.max(0.4, h ?? 3);
  // 級數：優先用給定 rise，否則以 ~0.18m/級 推算（工安 165~190mm）
  const stepRise = rise && rise > 0.05 ? rise : 0.18;
  const n = Math.max(2, Math.round(H / stepRise));
  const r = H / n;                              // 實際每級升高
  const RUN = Math.max(0.8, run ?? n * (going && going > 0.15 ? going : 0.28));
  const gRun = going && going > 0.15 ? going : RUN / n;   // 每級水平投影(踏面深)
  const railH = 1.0;                            // 扶手頂桿高（斜面法向約1.0~1.1m）
  const stringerH = 0.22, stringerT = 0.04;     // 斜梁斷面
  const treadTh = 0.045, tnose = 0.03;          // 踏板厚、突沿
  const x0 = -RUN / 2;                          // 底階前緣 x

  // --- 踏板（格柵條紋示意：主板+兩道防滑條）
  const treadDepth = gRun + tnose;
  for (let i = 0; i < n; i++) {
    const cx = x0 + i * gRun + treadDepth / 2 - tnose;
    const cy = (i + 1) * r - treadTh / 2;
    const tread = new THREE.Mesh(new THREE.BoxGeometry(treadDepth, treadTh, W), steelMat);
    tread.position.set(cx, cy, 0);
    g.add(tread);
    for (const gz of [-W * 0.28, W * 0.28]) {   // 防滑條
      const grip = new THREE.Mesh(new THREE.BoxGeometry(treadDepth * 0.9, treadTh + 0.012, 0.03), steelMat);
      grip.position.set(cx, cy + 0.004, gz);
      g.add(grip);
    }
  }

  // --- 兩側斜梁 stringer（沿斜線）
  const slopeLen = Math.hypot(RUN, H);
  const ang = Math.atan2(H, RUN);
  const sideZ = W / 2 + stringerT / 2;
  for (const side of [-1, 1]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(slopeLen + 0.12, stringerH, stringerT), steelMat);
    s.position.set(0, H / 2 - stringerH * 0.15, side * sideZ);
    s.rotation.z = ang;
    g.add(s);
  }

  // --- 斜向扶手（兩側）：立柱 + 頂桿 + 中桿
  const nPost = Math.max(2, Math.round(RUN / 1.4) + 1);
  const railTopGeo = new THREE.CylinderGeometry(0.022, 0.022, slopeLen, 8);
  const railMidGeo = new THREE.CylinderGeometry(0.018, 0.018, slopeLen, 8);
  for (const side of [-1, 1]) {
    for (let i = 0; i < nPost; i++) {
      const t = i / (nPost - 1);
      const px = x0 + t * RUN;
      const py = t * H + 0.02;                  // 沿斜面踏緣高度
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, railH + 0.02, 8), steelMat);
      post.position.set(px, py + railH / 2, side * sideZ);
      g.add(post);
    }
    for (const [geo, off] of [[railTopGeo, railH], [railMidGeo, railH * 0.52]]) {
      const rail = new THREE.Mesh(geo, steelMat);
      rail.position.set(0, H / 2 + off, side * sideZ);
      rail.rotation.z = ang + Math.PI / 2;      // 圓柱本地Y沿斜線
      g.add(rail);
    }
  }

  // --- 頂端承接平台（格柵）+ 踢腳板 + 平台護欄立柱
  const platD = Math.max(0.9, gRun + 0.6);
  const platX = RUN / 2 + platD / 2 - tnose;
  const platY = H;
  const plat = new THREE.Mesh(new THREE.BoxGeometry(platD, treadTh + 0.01, W), std(0x77828d, { roughness: 0.9 }));
  plat.position.set(platX, platY - treadTh / 2, 0);
  g.add(plat);
  for (const side of [-1, 1]) {                 // 平台踢腳板
    const toe = new THREE.Mesh(new THREE.BoxGeometry(platD, 0.1, 0.02), steelMat);
    toe.position.set(platX, platY + 0.05, side * (W / 2));
    g.add(toe);
    // 平台段扶手（頂桿+中桿+立柱，接續斜扶手）
    for (const px of [RUN / 2 + 0.03, platX + platD / 2 - 0.03]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, railH, 8), steelMat);
      post.position.set(px, platY + railH / 2, side * sideZ);
      g.add(post);
    }
    for (const off of [railH, railH * 0.52]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(platD, 0.036, 0.036), steelMat);
      rail.position.set(platX, platY + off, side * sideZ);
      g.add(rail);
    }
  }
  return g;
};

// 欄杆/扶手：立柱(每~1.5m)+頂桿(預設1.1m)+中桿(~0.52×高)+踢腳板 toe board(100mm)。
// dims {len:總長}(沿用既有 key)，可另給 {h:欄杆高}。工安：頂桿1.1m、中桿約其半、踢腳板100mm。
builders.srail = function ({ len, h }) {
  const g = new THREE.Group();
  const L = Math.max(0.5, len ?? 4);
  const railH = Math.max(0.7, h ?? 1.1);        // 頂桿高
  const midH = railH * 0.52;
  const n = Math.max(2, Math.round(L / 1.5) + 1);   // 立柱數（間距≤1.5m）
  const postGeo = new THREE.CylinderGeometry(0.024, 0.024, railH, 8);
  for (let i = 0; i < n; i++) {
    const post = new THREE.Mesh(postGeo, steelMat);
    post.position.set(-L / 2 + (i / (n - 1)) * L, railH / 2, 0);
    g.add(post);
  }
  for (const [y, rr] of [[railH, 0.022], [midH, 0.018]]) {   // 頂桿+中桿
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, L, 8), steelMat);
    rail.rotation.z = Math.PI / 2;
    rail.position.y = y;
    g.add(rail);
  }
  const toe = new THREE.Mesh(new THREE.BoxGeometry(L, 0.1, 0.025), steelMat);   // 踢腳板
  toe.position.set(0, 0.06, 0);
  g.add(toe);
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

// 直爬梯(含安全護籠)：兩立桿+橫踏桿(間距~0.3m)+2.2m以上護籠環箍(每~1.4m一環)
// +連接環箍的縱條(cage stays)+頂端出口延伸扶手。dims {h:總高}。
// 工安：踏桿間距≤300mm、護籠自2.2m起、環箍半徑約350~400mm。
builders.cageladder = function ({ h }) {
  const g = new THREE.Group();
  const H = Math.max(0.6, h ?? 6);
  const railMat = std(0x8d99a6);
  const cageMat = std(0xe8b83a, { metalness: 0.3, roughness: 0.6 });   // 護籠安全黃
  const halfW = 0.22;                             // 立桿半間距
  // 立桿（兩側，方鋼）
  const stileTop = H + (H > 2.2 ? 1.1 : 0);       // 出口段立桿延伸（登頂護欄）
  for (const sx of [-halfW, halfW]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, stileTop, 0.05), railMat);
    rail.position.set(sx, stileTop / 2, 0);
    g.add(rail);
  }
  // 橫踏桿（~0.3m 間距）
  const step = 0.3;
  const rungs = Math.floor(H / step);
  const rungGeo = new THREE.CylinderGeometry(0.016, 0.016, halfW * 2 + 0.04, 8);
  for (let i = 1; i <= rungs; i++) {
    const rung = new THREE.Mesh(rungGeo, railMat);
    rung.rotation.z = Math.PI / 2;
    rung.position.y = i * step;
    g.add(rung);
  }
  // 安全護籠：2.2m 以上，全環(370半徑)偏爬梯背面，每~1.4m 一環
  const cageR = 0.37, cageStart = 2.2;
  const hoopYs = [];
  if (H > cageStart + 0.3) {
    for (let y = cageStart; y <= H - 0.1; y += 1.4) hoopYs.push(y);
    const hoopGeo = new THREE.TorusGeometry(cageR, 0.02, 6, 24);
    for (const y of hoopYs) {
      const hoop = new THREE.Mesh(hoopGeo, cageMat);
      hoop.rotation.x = Math.PI / 2;             // 環面水平
      hoop.position.set(0, y, cageR - halfW);    // 圓心偏爬梯背側，環繞人員
      g.add(hoop);
    }
    // 縱條（cage stays）：連接各環箍，繞背側半圈布置 5 條
    if (hoopYs.length >= 2) {
      const yLo = hoopYs[0], yHi = hoopYs[hoopYs.length - 1];
      const stayLen = yHi - yLo;
      const stayGeo = new THREE.CylinderGeometry(0.012, 0.012, stayLen, 6);
      const cz = cageR - halfW;                  // 環心 z
      for (let k = 0; k < 5; k++) {
        const a = Math.PI * (0.15 + 0.7 * (k / 4));   // 背側半圈分布
        const stay = new THREE.Mesh(stayGeo, cageMat);
        stay.position.set(Math.cos(a) * cageR, (yLo + yHi) / 2, cz + Math.sin(a) * cageR);
        g.add(stay);
      }
    }
    // 頂端出口延伸扶手（登頂抓握）
    const exitTopGeo = new THREE.CylinderGeometry(0.02, 0.02, halfW * 2 + 0.04, 8);
    const exitTop = new THREE.Mesh(exitTopGeo, railMat);
    exitTop.rotation.z = Math.PI / 2;
    exitTop.position.y = stileTop;
    g.add(exitTop);
  }
  return g;
};

// -------------------------------------------------- 管線支撐（型式庫）＋儀電橋架（elec discipline）
// 型式庫（對標 E3D 管支撐族）：rest 鞍座承載／guide 導向含側擋／anchor 固定含底板全抱箍／
// hanger 由上吊桿＋抱箍／trunnion 焊接凸緣支墩。psupport 的 def.stype 決定幾何，預設 rest（維持既有場景）。
// 幾何契約：管軸沿本地 Z 通過（放置時 rot_y 對齊管向），承管中心在 y=h；底端在 y=0（editor 已依附面調好 h）。
export const SUPPORT_TYPES = [
  { code: 'rest', name: '鞍座 Rest（承載）' },
  { code: 'guide', name: '導向 Guide（側擋）' },
  { code: 'anchor', name: '固定 Anchor（底板抱箍）' },
  { code: 'hanger', name: '吊架 Hanger（由上吊）' },
  { code: 'trunnion', name: '凸緣 Trunnion（焊接支墩）' },
];
export const SUPPORT_TYPE_SET = new Set(SUPPORT_TYPES.map((s) => s.code));
const supMat = { base: 0x55606c, post: 0x6b7683, saddle: 0x8d99a6, attach: 0x9aa5b1 };
// U-bolt 示意：跨管半圓＋兩支腳，管軸沿 Z，故半圓落在 XY 平面、開口朝下扣住管。
function uBolt(r, yc, g) {
  const rad = Math.max(r * 1.15, 0.075);
  const arc = new THREE.Mesh(new THREE.TorusGeometry(rad, 0.012, 5, 12, Math.PI), std(supMat.attach, { metalness: 0.5 }));
  arc.position.y = yc;                            // 半環開口朝下（+Y 側為環頂）扣住管頂
  g.add(arc);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, rad, 8), std(supMat.attach, { metalness: 0.5 }));
    leg.position.set(sx * rad, yc - rad / 2, 0);
    g.add(leg);
  }
}
// clamp 抱箍示意：繞管一圈的環（管軸沿 Z → 環面在 XY，繞 Z）。
function pipeClamp(r, yc, g, color = supMat.attach) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.max(r * 1.12, 0.07), 0.02, 6, 16), std(color, { metalness: 0.5 }));
  ring.position.y = yc;                            // 環面預設在 XY 平面、法線沿 Z＝繞管一圈
  g.add(ring);
}
builders.psupport = function ({ h, r }, def) {
  const g = new THREE.Group();
  const stype = def?.stype ?? 'rest';
  const saddleR = Math.max(r * 1.1, 0.07);
  const yc = h + 0.01;                             // 承管中心高
  if (stype === 'hanger') {
    // 吊架：由上方鋼構垂下吊桿＋抱箍夾住管（無落地支柱）。頂端在承載面（editor 令 h＝吊點下方淨距）。
    const rodH = Math.max(h, 0.1);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, rodH, 8), std(supMat.post));
    rod.position.y = yc + rodH / 2;               // 從承管中心往上吊到承載面
    const clevis = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.06), std(supMat.post));
    clevis.position.y = yc + rodH;                // 頂端吊耳
    g.add(rod, clevis);
    pipeClamp(r, yc, g);                           // 抱箍承管
    return g;
  }
  // 落地族（rest/guide/anchor/trunnion）共用底板＋立柱
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.36), std(supMat.base));
  base.position.y = 0.03;
  const postH = Math.max(h - 0.05, 0.1);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, postH, 0.12), std(supMat.post));
  post.position.y = postH / 2 + 0.06;
  g.add(base, post);
  const saddle = new THREE.Mesh(new THREE.TorusGeometry(saddleR, 0.035, 6, 14, Math.PI), std(supMat.saddle));
  saddle.rotation.z = Math.PI;                    // 開口朝上承管
  saddle.position.y = yc;
  if (stype === 'trunnion') {
    // 凸緣：短圓柱支墩由管底焊出、頂承鞍座；示意為立於柱頂的粗凸緣。
    const stub = new THREE.Mesh(new THREE.CylinderGeometry(Math.max(r * 0.5, 0.05), Math.max(r * 0.5, 0.05), 0.18, 12), std(supMat.saddle, { metalness: 0.5 }));
    stub.position.y = yc - 0.12;
    g.add(stub, saddle);
    return g;
  }
  g.add(saddle);
  if (stype === 'guide') {
    // 導向：鞍座兩側加擋板限制側向位移（管沿 Z，故擋板在 ±X）。
    for (const sx of [-1, 1]) {
      const guide = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, saddleR * 2.4), std(supMat.attach, { metalness: 0.5 }));
      guide.position.set(sx * (saddleR + 0.02), yc + 0.02, 0);
      g.add(guide);
    }
    uBolt(r, yc, g);                               // 導向常配 U-bolt 壓管
  } else if (stype === 'anchor') {
    // 固定：頂加銲接底座塊＋整圈抱箍鎖死三向位移。
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.22), std(supMat.base));
    shoe.position.y = yc - 0.05;
    g.add(shoe);
    pipeClamp(r, yc, g, supMat.base);              // 全抱箍（深色示錨定）
  }
  // rest：純鞍座承載，無附件（維持既有外觀）
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
// ftf（公尺，選填）：spec/bore 選型的 face-to-face 長度。給定時把元件沿管向（本地 X）
// 縮放到該長度取代寫死幾何長，維持徑向（Y/Z）依 r 的比例。
// ------------------------------------------------------------ 電纜橋架自由佈線斷面渲染（profile:'tray'）
// 沿路徑各段建 U 型槽（實底/沖孔）或梯型托盤（ladder，側牆＋橫檔），轉角以短接續盒填角。
// 幾何一律公尺 canonical；材質走「儀電」灰藍，type 差異：ladder=橫檔、solid=實底板、perforated=實底近似＋淺色。
// 本地座標：段沿 +Z（與矩形風管一致），quaternion 對齊流向；托盤「側牆向上」＝本地 +Y。
const TRAY_MATS = {
  solid: std(0x6f7b88, { metalness: 0.45, roughness: 0.5 }),
  perforated: std(0x8794a2, { metalness: 0.4, roughness: 0.6 }),   // 沖孔近似＝實底＋淺色
  ladder: std(0x6f7b88, { metalness: 0.45, roughness: 0.5 }),
};
export function trayMat(type) { return TRAY_MATS[type] ?? TRAY_MATS.solid; }
// 側牆高與板厚：隨寬度略縮放，維持工程比例（150mm 寬→約 50mm 牆；600mm→約 75mm）。
function trayDims(w) {
  const sideH = Math.min(0.075, Math.max(0.045, w * 0.12));   // 側牆高（公尺）
  const th = 0.006;                                            // 板/牆厚（公尺）
  return { sideH, th };
}
// 建一段托盤（本地：長度沿 Z、寬沿 X、側牆向上 +Y）。回傳 Group。
function buildTraySeg(w, len, type, mat) {
  const g = new THREE.Group();
  const { sideH, th } = trayDims(w);
  // 兩側牆（沿 Z 的長條）
  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(th, sideH, len), mat);
    side.position.set(sx * (w / 2 - th / 2), sideH / 2, 0);
    g.add(side);
  }
  if (type === 'ladder') {
    // 梯型：無底板，等距橫檔（沿 X 的短棒）連接兩側牆
    const n = Math.max(2, Math.round(len / 0.3));
    for (let i = 0; i <= n; i++) {
      const rung = new THREE.Mesh(new THREE.BoxGeometry(w - th, th * 1.4, 0.03), mat);
      rung.position.set(0, th * 0.7, -len / 2 + (len * i) / n);
      g.add(rung);
    }
  } else {
    // solid / perforated：實底板（沖孔以淺色材質近似，不逐孔建幾何以控面數）
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w, th, len), mat);
    floor.position.set(0, th / 2, 0);
    g.add(floor);
  }
  return g;
}
// 建整條托盤佈線 body：沿 pts 逐段建托盤＋內角接續盒。掛進傳入的 group（由 editor 端持有 dispose）。
export function buildTrayBody(pipe, index, group, pts) {
  const w = pipe.tray?.w ?? 0.3;
  const type = pipe.tray?.type ?? 'solid';
  const mat = trayMat(type);
  const { sideH, th } = trayDims(w);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dir = b.clone().sub(a), len = dir.length();
    if (len < 1e-4) continue;
    const seg = buildTraySeg(w, len, type, mat);
    seg.position.copy(a).addScaledVector(dir, 0.5);
    seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
    seg.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.userData.pipeIndex = index; } });
    group.add(seg);
    if (i < pts.length - 2) {   // 內角：自動水平彎接續盒（U 型槽轉角，含側牆與底）
      const el = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, th, w), mat);   // 轉角底板
      box.position.y = th / 2;
      el.add(box);
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {         // 四邊短側牆填角
        const wall = new THREE.Mesh(
          dx ? new THREE.BoxGeometry(th, sideH, w) : new THREE.BoxGeometry(w, sideH, th), mat);
        wall.position.set(dx * (w / 2 - th / 2), sideH / 2, dz * (w / 2 - th / 2));
        el.add(wall);
      }
      el.position.copy(pts[i + 1]);
      el.traverse((o) => { if (o.isMesh) o.userData.pipeIndex = index; });
      group.add(el);
    }
  }
}

export function buildPipeComponent(kind, r, ftf) {
  const inner = new THREE.Group();
  const g = inner;
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
  if (ftf && ftf > 1e-4) {
    // 量目前沿管向（本地 X）幾何範圍，縮放到 ftf；徑向不變。用外層 group 包裹以套 scale.x。
    const box = new THREE.Box3().setFromObject(inner);
    const spanX = Math.max(box.max.x - box.min.x, 1e-4);
    inner.scale.x = ftf / spanX;
    const outer = new THREE.Group();
    outer.add(inner);
    return outer;
  }
  return inner;
}

// -------------------------------------------------- 風管終端裝置（HVAC terminal：送風口/回風格柵/百葉）
// 本地座標：X 為流向（掛在風管端/面時 setFromUnitVectors(1,0,0)→pose.dir），面板攤在 Y-Z 平面。
// 幾何示意；尺寸由風管斷面 w/h（矩形）或 d（圓形）驅動，皆公尺 canonical。
const ductTermMat = std(0xc4ccd4, { metalness: 0.4, roughness: 0.45 });
const ductTermFrameMat = std(0x8a949e, { metalness: 0.5, roughness: 0.4 });
export function buildDuctTerminal(kind, w, h, duct) {
  const g = new THREE.Group();
  const shape = duct?.shape ?? 'rect';
  const d = duct?.d ?? w;
  // 面板外框尺寸：矩形沿斷面 w×h；圓/橢圓外接方框，略放大 1.1 倍作面框
  const fw = (shape === 'circ' ? d : w) * 1.1;      // 世界 Z（寬）
  const fh = (shape === 'circ' ? d : h) * 1.1;      // 世界 Y（高）
  const t = Math.max(Math.min(fw, fh) * 0.12, 0.03); // 面板厚（沿流向 X）
  const frame = new THREE.Mesh(new THREE.BoxGeometry(t, fh, fw), ductTermFrameMat);
  g.add(frame);
  if (kind === 'diffuser') {
    // 送風口：方形擴散格柵，數層同心退縮方環（4 向擴散示意）
    const rings = 3;
    for (let i = 1; i <= rings; i++) {
      const s = 1 - i / (rings + 1);
      const ring = new THREE.Mesh(new THREE.BoxGeometry(t * (1 + i * 0.5), fh * s, fw * s), ductTermMat);
      ring.position.x = t * 0.5 + t * i * 0.25;      // 逐層向流出側凸出
      g.add(ring);
    }
  } else if (kind === 'grille') {
    // 回風格柵：一排水平葉片
    const n = 6;
    for (let i = 0; i < n; i++) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(t * 0.6, fh / n * 0.55, fw * 0.86), ductTermMat);
      bar.position.set(t * 0.55, fh * (-0.5 + (i + 0.5) / n), 0);
      g.add(bar);
    }
  } else if (kind === 'louvre') {
    // 百葉：一排傾斜葉片（擋雨/導流示意）
    const n = 5;
    for (let i = 0; i < n; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(t * 0.9, fh / n * 0.7, fw * 0.86), ductTermMat);
      blade.position.set(t * 0.55, fh * (-0.5 + (i + 0.5) / n), 0);
      blade.rotation.z = -0.5;                        // 葉片傾斜
      g.add(blade);
    }
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
// 管線服務別 / 流體別（對標 E3D 依 service 著色）：工業慣用色（近似 ANSI/ISO 流體識別）
// code 存於 pipe.service（純中繼屬性，不影響幾何/存檔 canonical）；無 service 時沿用 spec 灰預設色。
export const PIPE_SERVICES = [
  { code: 'process', name: '製程 Process', color: 0xb0862b },  // 製程流體：赭黃
  { code: 'steam',   name: '蒸汽 Steam',   color: 0xe07b1a },  // 蒸汽：橙
  { code: 'water',   name: '冷卻水 Water', color: 0x2f7fd1 },  // 水：藍
  { code: 'air',     name: '儀錶空氣 Air', color: 0x3fa64a },  // 空氣：綠
  { code: 'gas',     name: '燃氣 Gas',     color: 0xc9a227 },  // 燃氣：黃
  { code: 'drain',   name: '排水 Drain',   color: 0x6b7a45 },  // 排水/汙水：橄欖
  { code: 'flare',   name: '放空 Flare',   color: 0xd23b2e },  // 放空/火炬：紅
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

// 鋼板 / 樓板 PANE：THREE.Shape 矩形板 + ExtrudeGeometry 擠出厚度 t（免 CSG）；
// dims 皆公尺：w=X 寬、d=Z 深、t=Y 厚。預設水平（法線朝上，樓板姿態），底面貼 y=0。
// def.holes（可選）：圓孔 {x,z,r} 或方孔 {x,z,w,d}，座標相對板中心（公尺），以 THREE.Path 挖孔。
builders.plate = function ({ w, d, t }, def) {
  const g = new THREE.Group();
  const W = w ?? 2, D = d ?? 1.5, T = t ?? 0.012;
  // Shape 於 XZ 平面繪製（本地用 X-Y），擠出後繞 X 轉平放：擠出方向(+Z)→Y。
  const shape = new THREE.Shape();
  shape.moveTo(-W / 2, -D / 2);
  shape.lineTo(W / 2, -D / 2);
  shape.lineTo(W / 2, D / 2);
  shape.lineTo(-W / 2, D / 2);
  shape.closePath();
  const holes = def?.holes;
  if (Array.isArray(holes)) {
    for (const hole of holes) {
      if (!hole) continue;
      const cx = hole.x ?? 0, cz = hole.z ?? 0;
      const path = new THREE.Path();
      if (hole.r != null) { // 圓孔
        path.absarc(cx, cz, hole.r, 0, Math.PI * 2, true);
      } else if (hole.w != null && hole.d != null) { // 方孔
        const hw = hole.w / 2, hd = hole.d / 2;
        path.moveTo(cx - hw, cz - hd);
        path.lineTo(cx - hw, cz + hd);
        path.lineTo(cx + hw, cz + hd);
        path.lineTo(cx + hw, cz - hd);
        path.closePath();
      } else {
        continue;
      }
      shape.holes.push(path);
    }
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, steps: 1 });
  // 擠出沿本地 +Z（0→T）；繞 X 轉 -90° 使厚度沿世界 Y，且深 D 落在世界 Z。
  geo.rotateX(-Math.PI / 2);
  // 旋轉後板佔 y∈[-T,0]（原 z∈[0,T]→y∈[-T,0]），上移 T 使底面貼 y=0。
  geo.translate(0, T, 0);
  const mesh = new THREE.Mesh(geo, std(0x9aa4ad, { metalness: 0.5, roughness: 0.55 }));
  g.add(mesh);
  return g;
};

// 格柵樓板 grating：以承重橫檔(bearing bar)陣列示意，區別於實心鋼板 PANE。
// dims {w, d, t}；def.bar_dir='w'|'d' 橫檔方向、def.bar_pitch 間距(m,預設 0.04)。
// 外框做細邊框 + 一組沿指定方向、依 pitch 排列的細長條，另加稀疏交叉扁鋼示意。
builders.grating = function ({ w, d, t }, def) {
  const g = new THREE.Group();
  const W = w ?? 2, D = d ?? 1.5, T = t ?? 0.03;
  const mat = std(0x808b96, { metalness: 0.55, roughness: 0.6 });
  const along = (def?.bar_dir ?? 'w') === 'd' ? 'd' : 'w';   // 承重橫檔延伸方向
  const pitch = Math.min(Math.max(def?.bar_pitch ?? 0.04, 0.02), 0.15);
  const barT = 0.005;                                        // 扁鋼厚
  // 邊框（四邊細框）
  const fr = 0.02;
  for (const [bw, bd, bx, bz] of [[W, fr, 0, D / 2 - fr / 2], [W, fr, 0, -(D / 2 - fr / 2)],
    [fr, D, W / 2 - fr / 2, 0], [fr, D, -(W / 2 - fr / 2), 0]]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(bw, T, bd), mat);
    edge.position.set(bx, T / 2, bz);
    g.add(edge);
  }
  // 承重橫檔（bearing bar）：沿 along 方向的細長扁鋼，依 pitch 於垂直方向排列
  if (along === 'w') {
    const n = Math.max(1, Math.floor(D / pitch));
    for (let i = 0; i <= n; i++) {
      const z = -D / 2 + (i / n) * D;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(W, T, barT), mat);
      bar.position.set(0, T / 2, z);
      g.add(bar);
    }
    // 稀疏交叉桿（cross rod）示意
    const m = Math.max(1, Math.floor(W / (pitch * 4)));
    for (let j = 0; j <= m; j++) {
      const x = -W / 2 + (j / m) * W;
      const rod = new THREE.Mesh(new THREE.BoxGeometry(barT, T * 0.6, D), mat);
      rod.position.set(x, T * 0.3, 0);
      g.add(rod);
    }
  } else {
    const n = Math.max(1, Math.floor(W / pitch));
    for (let i = 0; i <= n; i++) {
      const x = -W / 2 + (i / n) * W;
      const bar = new THREE.Mesh(new THREE.BoxGeometry(barT, T, D), mat);
      bar.position.set(x, T / 2, 0);
      g.add(bar);
    }
    const m = Math.max(1, Math.floor(D / (pitch * 4)));
    for (let j = 0; j <= m; j++) {
      const z = -D / 2 + (j / m) * D;
      const rod = new THREE.Mesh(new THREE.BoxGeometry(W, T * 0.6, barT), mat);
      rod.position.set(0, T * 0.3, z);
      g.add(rod);
    }
  }
  return g;
};

// -------------------------------------------------- 元件選型（spec-driven component sizing）
// DN 名目 → 公稱直徑（mm，供 FTF 內插/查表）
const DN_MM = { DN25: 25, DN40: 40, DN50: 50, DN80: 80, DN100: 100, DN150: 150,
  DN200: 200, DN250: 250, DN300: 300, DN400: 400, DN500: 500 };
// 元件 face-to-face 長度（公尺 canonical）——近似 ASME B16.10 flanged/lug 端面距。
// 每 kind 給 { DNxxx: 公尺 }；缺該 DN 時由 ftfFor 依最近 DN 線性內插近似。
// 值來源：B16.10 Class150 RF flanged 常見值（DN50~DN300），兩端外插為工程近似。
export const COMPONENT_FTF = {
  valve:      { DN25: 0.184, DN40: 0.222, DN50: 0.254, DN80: 0.298, DN100: 0.352, DN150: 0.451, DN200: 0.543, DN250: 0.673, DN300: 0.737, DN400: 0.914, DN500: 1.067 },
  ball:       { DN25: 0.127, DN40: 0.165, DN50: 0.178, DN80: 0.203, DN100: 0.229, DN150: 0.394, DN200: 0.457, DN250: 0.533, DN300: 0.610, DN400: 0.762, DN500: 0.914 },
  bfly:       { DN50: 0.043, DN80: 0.046, DN100: 0.052, DN150: 0.056, DN200: 0.060, DN250: 0.068, DN300: 0.078, DN400: 0.102, DN500: 0.114 },
  check:      { DN25: 0.184, DN40: 0.222, DN50: 0.254, DN80: 0.298, DN100: 0.352, DN150: 0.451, DN200: 0.543, DN250: 0.673, DN300: 0.737, DN400: 0.914, DN500: 1.067 },
  flangepair: { DN25: 0.050, DN40: 0.055, DN50: 0.060, DN80: 0.070, DN100: 0.075, DN150: 0.085, DN200: 0.095, DN250: 0.105, DN300: 0.115, DN400: 0.135, DN500: 0.155 },
  reducer:    { DN25: 0.089, DN40: 0.089, DN50: 0.102, DN80: 0.114, DN100: 0.127, DN150: 0.140, DN200: 0.152, DN250: 0.178, DN300: 0.203, DN400: 0.254, DN500: 0.305 },
  psv:        { DN25: 0.20, DN40: 0.24, DN50: 0.28, DN80: 0.34, DN100: 0.40, DN150: 0.52 },
  fm:         { DN25: 0.20, DN40: 0.24, DN50: 0.30, DN80: 0.36, DN100: 0.42, DN150: 0.52, DN200: 0.62, DN250: 0.72, DN300: 0.82 },
};
// 回傳某 kind 在指定 DN 的 face-to-face 長度（公尺）；缺表時依最近兩 DN 線性內插/外插。
function ftfFor(kind, dn) {
  const tbl = COMPONENT_FTF[kind];
  if (!tbl) return null;
  if (dn && tbl[dn] != null) return tbl[dn];
  const target = DN_MM[dn];
  const keys = Object.keys(tbl).filter((k) => DN_MM[k] != null).sort((a, b) => DN_MM[a] - DN_MM[b]);
  if (!keys.length) return null;
  if (target == null) return tbl[keys[0]];                                     // 未知 DN → 取最小 DN 值
  if (target <= DN_MM[keys[0]]) return tbl[keys[0]];
  if (target >= DN_MM[keys[keys.length - 1]]) return tbl[keys[keys.length - 1]];
  for (let i = 0; i < keys.length - 1; i++) {                                   // 落在兩已知 DN 間 → 線性內插
    const lo = DN_MM[keys[i]], hi = DN_MM[keys[i + 1]];
    if (target >= lo && target <= hi) {
      const t = (target - lo) / (hi - lo);
      return tbl[keys[i]] + t * (tbl[keys[i + 1]] - tbl[keys[i]]);
    }
  }
  return tbl[keys[0]];
}
// 依 spec+dn 選 kind 元件，回選型結果（ftf 公尺；endType 由 spec 語境近似）。
export function pickComponent(spec, dn, kind) {
  const ftf = ftfFor(kind, dn);
  // 端接型式：低壓/PVC 多對焊或承插，其餘依 spec 等級近似法蘭（僅中繼屬性，不影響 canonical 幾何）
  const endType = (spec === 'PVC') ? 'socket'
    : (spec === 'B4B') ? 'flanged-RTJ'
    : 'flanged-RF';
  return { kind, dn: dn ?? null, spec: spec ?? null, ftf, endType };
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
    { type: 'plate', name: '鋼板/樓板 PANE', dims: { w: 2, d: 1.5, t: 0.012 }, prefix: 'PL' },
    { type: 'grating', name: '格柵樓板 GRATING', dims: { w: 2, d: 1.5, t: 0.03 }, prefix: 'GR' },
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
    { type: 'assembly', name: '六角柱體 EXTR', dims: {},
      prims: [{ kind: 'extr', dims: { sides: 6, r: 0.8, h: 2 }, pos: [0, 0, 0] }], prefix: 'EQ' },
    { type: 'assembly', name: '碟形封頭 REVO', dims: {},
      prims: [{ kind: 'revo', dims: { r: 1, h: 1, seg: 24 }, pos: [0, 0, 0] }], prefix: 'EQ' },
  ]},
];
export const ASSET_CATALOG = ASSET_CATEGORIES.flatMap((c) => c.items);

// ---------------------------------------------------------------- 維修/抽出包絡（access envelope）
// 對標 E3D「保留空間淨空」：依設備本體 local AABB 各方向外擴 pad（公尺），
// 建半透明淡色盒＋線框，標 userData.envelope=true 供上層排除點選/圖層/dispose。
// pad = { x, y, z }（單邊外擴公尺；x→E-W、z→N-S、y→上下）。回傳 null 表示無可量幾何。
const ENVELOPE_COLOR = 0x2fa8ff;
function buildEnvelope(body, pad = {}) {
  const box = new THREE.Box3().setFromObject(body);
  if (box.isEmpty()) return null;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const px = Math.max(0, +pad.x || 0), py = Math.max(0, +pad.y || 0), pz = Math.max(0, +pad.z || 0);
  const w = Math.max(0.001, size.x + px * 2);
  const h = Math.max(0.001, size.y + py * 2);
  const d = Math.max(0.001, size.z + pz * 2);
  const geo = new THREE.BoxGeometry(w, h, d);
  const mat = new THREE.MeshBasicMaterial({
    color: ENVELOPE_COLOR, transparent: true, opacity: 0.10,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(center);
  mesh.renderOrder = 2;
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: ENVELOPE_COLOR, transparent: true, opacity: 0.55 }));
  mesh.add(edges);
  // 標記整棵子樹：不可點選（無 eqTag）、可被上層辨識為包絡（非實體幾何）
  mesh.userData.envelope = true;
  edges.userData.envelope = true;
  mesh.castShadow = false; mesh.receiveShadow = false;
  return mesh;
}

export { std, markShadow, builders, dm, dPad, dFlange, dNozzle, dLadder, dHandrailRing, detailedBuilders, mergeByMaterial, labelHeight, buildEnvelope };
// buildTrayBody / trayMat 已於定義處 export（電纜橋架自由佈線）
