import * as THREE from 'three';

export const LANES = 5;
export const LANE_W = 3.7;
const SHOULDER = 1.5;
export const ROAD_HALF = (LANES * LANE_W) / 2 + SHOULDER; // inner face of barriers
export const laneX = (i) => -(LANES * LANE_W) / 2 + LANE_W / 2 + i * LANE_W;

const DASH_PERIOD = 12;
const LAMP_PERIOD = 40;
const LAMP_COUNT = 32; // per side
const VIEW_AHEAD = 1300;
const SKY_TILE = 800;

function roadTexture(renderer) {
  const ppm = 24;
  const w = Math.round(ROAD_HALF * 2 * ppm);
  const h = DASH_PERIOD * ppm;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#1b1d21';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 4000; i++) {
    const v = 20 + Math.random() * 22;
    g.fillStyle = `rgb(${v},${v},${v + 3})`;
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  const px = (x) => (x + ROAD_HALF) * ppm;
  const line = 0.15 * ppm;
  g.fillStyle = '#d9a520';
  g.fillRect(px(-ROAD_HALF + SHOULDER) - line, 0, line, h);
  g.fillStyle = '#d8d8d4';
  g.fillRect(px(ROAD_HALF - SHOULDER), 0, line, h);
  for (let i = 1; i < LANES; i++) {
    const x = px(-(LANES * LANE_W) / 2 + i * LANE_W) - line / 2;
    g.fillRect(x, 0, line, 3 * ppm);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function windowTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 64, 128);
  for (let y = 4; y < 124; y += 8) {
    for (let x = 4; x < 60; x += 8) {
      if (Math.random() < 0.28) {
        g.fillStyle = Math.random() < 0.85 ? '#ffc27a' : '#9fe8f5';
        g.fillRect(x, y, 4, 5);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  return t;
}

function jerseyBarrier(length, side) {
  const s = new THREE.Shape();
  // Profile in (x outward, y up); side flips it to face the road.
  s.moveTo(0, 0);
  s.lineTo(0, 0.08);
  s.lineTo(0.06, 0.33);
  s.lineTo(0.22, 0.8);
  s.lineTo(0.27, 1.05);
  s.lineTo(0.6, 1.05);
  s.lineTo(0.6, 0);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false });
  geo.translate(0, 0, -length / 2);
  if (side < 0) geo.scale(-1, 1, 1);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x6d7076, roughness: 0.92, flatShading: true, side: THREE.DoubleSide }),
  );
  mesh.position.x = side * ROAD_HALF;
  return mesh;
}

export class World {
  constructor(scene, renderer) {
    this.scene = scene;

    scene.background = new THREE.Color(0x05070d);
    scene.fog = new THREE.FogExp2(0x070a12, 0.0019);
    scene.add(new THREE.HemisphereLight(0x3a4a6a, 0x0a0a0c, 0.6));
    const moon = new THREE.DirectionalLight(0x8090b0, 0.35);
    moon.position.set(-30, 60, -20);
    scene.add(moon);

    // Road: one long plane snapped to the dash period so markings stay world-fixed.
    const roadLen = VIEW_AHEAD + 300;
    const tex = roadTexture(renderer);
    tex.repeat.set(1, roadLen / DASH_PERIOD);
    this.road = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF * 2, roadLen).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, metalness: 0.15 }),
    );
    this.road.geometry.translate(0, 0, -roadLen / 2 + 250);
    scene.add(this.road);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, roadLen).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 1 }),
    );
    this.ground.geometry.translate(0, -0.6, -roadLen / 2 + 250);
    scene.add(this.ground);

    this.barriers = new THREE.Group();
    this.barriers.add(jerseyBarrier(roadLen, -1), jerseyBarrier(roadLen, 1));
    this.barriers.children.forEach((b) => (b.position.z = -roadLen / 2 + 250));
    scene.add(this.barriers);

    this.#buildLamps();
    this.#buildSkyline();
  }

  #buildLamps() {
    const n = LAMP_COUNT * 2;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7, metalness: 0.4, flatShading: true });
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.18, 11, 6), poleMat, n);
    const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(2.6, 0.14, 0.14), poleMat, n);
    const heads = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.9, 0.18, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff0d8, emissiveIntensity: 6 }),
      n,
    );
    const pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: radialTexture(),
        color: 0xffe2b8,
        transparent: true,
        opacity: 0.13,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      n,
    );
    const m = new THREE.Matrix4();
    const lampX = ROAD_HALF + 0.35;
    this.lampOffsets = [];
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = -Math.floor(i / 2) * LAMP_PERIOD - (side > 0 ? LAMP_PERIOD / 2 : 0) + 80;
      const x = side * lampX;
      poles.setMatrixAt(i, m.makeTranslation(x, 5.5 + 1.05, z));
      arms.setMatrixAt(i, m.makeTranslation(x - side * 1.3, 11.9, z));
      heads.setMatrixAt(i, m.makeTranslation(x - side * 2.4, 11.8, z));
      const px = x - side * 3.6;
      pools.setMatrixAt(i, m.makeScale(18, 1, 18).setPosition(px, 0.02, z));
      this.lampOffsets.push(new THREE.Vector3(px, 10, z));
    }
    this.lamps = new THREE.Group();
    this.lamps.add(poles, arms, heads, pools);
    this.scene.add(this.lamps);

    // A handful of real lights on the lamps nearest the player so cars pick up highlights.
    this.lampLights = [];
    for (let i = 0; i < 6; i++) {
      const l = new THREE.PointLight(0xffe6c4, 140, 40, 1.6);
      this.lamps.add(l);
      this.lampLights.push(l);
    }
  }

  #buildSkyline() {
    const rnd = mulberry(7);
    const tiles = 3;
    const perTile = 70;
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const winTex = windowTexture();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0d1018,
      roughness: 0.9,
      emissive: 0xffffff,
      emissiveMap: winTex,
      emissiveIntensity: 0.55,
      flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, perTile * tiles);
    const m = new THREE.Matrix4();
    const items = [];
    for (let i = 0; i < perTile; i++) {
      const side = rnd() < 0.5 ? -1 : 1;
      const x = side * (140 + rnd() * 420);
      const z = rnd() * SKY_TILE;
      const w = 18 + rnd() * 30;
      const d = 18 + rnd() * 30;
      const h = 25 + Math.pow(rnd(), 2) * 160;
      items.push([x, z, w, h, d]);
    }
    let k = 0;
    for (let t = 0; t < tiles; t++) {
      for (const [x, z, w, h, d] of items) {
        mesh.setMatrixAt(k++, m.makeScale(w, h, d).setPosition(x, -0.5, -z - t * SKY_TILE + SKY_TILE));
      }
    }
    this.skyline = mesh;
    this.scene.add(mesh);
  }

  update(playerZ) {
    // Large geometry follows the player continuously (it is uniform along z).
    this.road.position.z = Math.floor(playerZ / DASH_PERIOD) * DASH_PERIOD;
    this.ground.position.z = playerZ;
    this.barriers.position.z = playerZ;
    const lampBase = Math.floor(playerZ / LAMP_PERIOD) * LAMP_PERIOD;
    this.lamps.position.z = lampBase;
    this.skyline.position.z = Math.floor(playerZ / SKY_TILE) * SKY_TILE;

    // Attach real lights to the lamps nearest the player.
    const local = playerZ - lampBase;
    const sorted = this.lampOffsets
      .map((p) => ({ p, d: Math.abs(p.z - local + 15) }))
      .sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.lampLights.length; i++) this.lampLights[i].position.copy(sorted[i].p);
  }
}

export function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
