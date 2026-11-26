import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { facadeMaterial, TILE } from './facades.js';
import { PROFILE } from './platform.js';
import { ROAD_HALF, mulberry } from './world.js';

// Procedural city alongside the highway, streamed in SEG-metre blocks.
//
// Each block is generated deterministically from its index, so driving back over it rebuilds the
// same place. Each side of the highway independently gets a district type (downtown towers, midrise
// brick, park, waterfront with a far-shore skyline and bridges) from smooth noise, so districts run
// for kilometres and change gradually.
//
// Rendering: every kind of object is one InstancedMesh (~20 draw calls for the whole city). Each
// active block keeps its own instance data; when the set of blocks changes, the active blocks are
// packed together and each mesh draws only the instances in use.

const SEG = 300;
const ACTIVE = PROFILE.viewBlocks; // blocks kept alive: 1 behind the player, the rest ahead
// Trees and far skyline towers are thinned by this (near buildings are kept: they define the street).
const DENSITY = PROFILE.cityDensity;
const EDGE = ROAD_HALF + 0.7; // outer face of the barriers
const SHORE = EDGE + 38; // waterfront: promenade width before the water
const FAR_SHORE = 1150; // waterfront: distance to the opposite shore

// Per-block instance capacity for each mesh.
const CAP = {
  glass: 70,
  darkglass: 50,
  white: 40,
  brick: 110,
  limestone: 80,
  concrete: 50,
  stone: 4,
  spire: 8,
  waterTower: 30,
  deciduous: 260,
  conifer: 120,
  ground: 6,
  water: 2,
  overpass: 2,
  railway: 1,
  footbridge: 1,
  gantry: 1,
  suspension: 2,
  cablestay: 2,
};

const BUILDING_KINDS = ['glass', 'darkglass', 'white', 'brick', 'limestone', 'concrete'];

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const p3 = new THREE.Vector3();
const s3 = new THREE.Vector3();
const col = new THREE.Color();
const up = new THREE.Vector3(0, 1, 0);

// ---------- geometry templates (merged, vertex-coloured) ----------

const unitBox = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();

function part(geo, color, x, y, z, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) {
  const g = geo.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.applyMatrix4(
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz),
    ),
  );
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

const box = (color, x, y, z, sx, sy, sz, rx, ry, rz) => part(unitBox, color, x, y, z, sx, sy, sz, rx, ry, rz);

// A thin box from point a to point b (cables, truss members).
function strut(color, a, b, t) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const g = part(unitBox, color, 0, 0, 0, t, len, t);
  const qq = new THREE.Quaternion().setFromUnitVectors(up, d.clone().normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().addScaledVector(d, 0.5), qq, new THREE.Vector3(1, 1, 1)));
  return g;
}

const SPAN = ROAD_HALF * 2 + 14; // overpasses span the road plus abutments

function overpassTemplate() {
  const parts = [];
  const h = 7.2;
  parts.push(box(0x9a968e, 0, h, 0, SPAN, 1.3, 14));
  parts.push(box(0x8b877f, 0, h + 1.2, -6.6, SPAN, 1.1, 0.5));
  parts.push(box(0x8b877f, 0, h + 1.2, 6.6, SPAN, 1.1, 0.5));
  parts.push(box(0x7d7a73, 0, h - 0.9, 0, SPAN, 0.5, 12)); // girder line
  for (const s of [-1, 1]) parts.push(box(0x8a867e, s * (SPAN / 2 - 2.5), h / 2, 0, 5, h, 15));
  return mergeGeometries(parts);
}

// Green steel elevated railway (riveted girders on trestle bents) crossing over the highway.
function railwayTemplate() {
  const parts = [];
  const h = 10;
  const green = 0x2f5d4e;
  for (const s of [-1, 1]) {
    parts.push(box(green, 0, h, s * 3.2, SPAN + 30, 1.8, 0.6));
    parts.push(box(green, s * (SPAN / 2 + 4), h / 2, 0, 1.2, h, 7.5));
    parts.push(box(green, s * (SPAN / 2 + 4), h / 2, 0, 0.6, h, 0.6, 0, 0, 0));
  }
  parts.push(box(0x3b3b38, 0, h + 1, 0, SPAN + 30, 0.4, 7));
  for (let x = -SPAN / 2 - 14; x < SPAN / 2 + 14; x += 3) {
    for (const s of [-1, 1]) {
      parts.push(strut(green, new THREE.Vector3(x, h - 0.9, s * 3.2), new THREE.Vector3(x + 3, h + 0.9, s * 3.2), 0.18));
    }
  }
  // A short train of silver cars parked on the viaduct.
  for (let i = 0; i < 4; i++) {
    const x = -24 + i * 15.5;
    parts.push(box(0xc9ccce, x, h + 2.8, 0, 15, 3.4, 3));
    parts.push(box(0x2b3138, x, h + 3.2, 1.52, 14, 0.9, 0.05));
    parts.push(box(0x2b3138, x, h + 3.2, -1.52, 14, 0.9, 0.05));
  }
  return mergeGeometries(parts);
}

function footbridgeTemplate() {
  const parts = [];
  const h = 6.8;
  parts.push(box(0x4a4d52, 0, h, 0, SPAN, 0.5, 3.2));
  for (const s of [-1, 1]) {
    parts.push(box(0x34373b, 0, h + 0.65, s * 1.55, SPAN, 0.08, 0.08));
    for (let x = -SPAN / 2; x <= SPAN / 2; x += 2) parts.push(box(0x34373b, x, h + 0.35, s * 1.55, 0.06, 0.7, 0.06));
    parts.push(box(0x56595e, s * (SPAN / 2 - 1), h / 2, 0, 1.4, h, 3));
  }
  // Ornamental arched lamp standard over the median.
  parts.push(box(0x24272a, 0, h + 4, 0, 0.25, 8, 0.25));
  parts.push(box(0x24272a, 0, h + 7.7, 0, 9, 0.18, 0.18));
  for (const s of [-1, 1]) parts.push(box(0x3e5a46, s * 4.4, h + 7.3, 0, 0.6, 0.8, 0.6));
  return mergeGeometries(parts);
}

function gantryTemplate() {
  const parts = [];
  const h = 7;
  const steel = 0x8a8f94;
  for (const s of [-1, 1]) parts.push(box(steel, s * (ROAD_HALF + 1.2), h / 2 + 0.5, 0, 0.5, h + 1, 0.5));
  parts.push(box(steel, 0, h + 0.6, -0.4, ROAD_HALF * 2 + 3, 0.25, 0.25));
  parts.push(box(steel, 0, h + 0.6, 0.4, ROAD_HALF * 2 + 3, 0.25, 0.25));
  // Green guide signs with white text bars and a border.
  for (const x of [-ROAD_HALF * 0.55, 0, ROAD_HALF * 0.55]) {
    parts.push(box(0x1f6b3e, x, h + 2, 0.2, 6.2, 3, 0.12));
    parts.push(box(0xeeeeee, x, h + 2.7, 0.27, 4.2, 0.35, 0.02));
    parts.push(box(0xeeeeee, x - 0.5, h + 2.0, 0.27, 3.2, 0.35, 0.02));
    parts.push(box(0xeeeeee, x, h + 1.2, 0.27, 0.5, 0.6, 0.02));
  }
  return mergeGeometries(parts);
}

// Suspension bridge running outward along +x from the shore, over the water.
function suspensionTemplate() {
  const parts = [];
  const deckY = 42;
  const len = FAR_SHORE + 40;
  const towers = [len * 0.28, len * 0.72];
  const stone = 0xa79a85;
  parts.push(box(0x5b5e63, len / 2, deckY, 0, len, 2.4, 26));
  parts.push(box(0x6e7176, len / 2, deckY + 1.6, 0, len, 1.2, 1.4));
  for (const tx of towers) {
    for (const s of [-1, 1]) parts.push(box(stone, tx, 45, s * 11, 9, 90, 7));
    parts.push(box(stone, tx, 82, 0, 9, 10, 29));
    parts.push(box(stone, tx, 58, 0, 9, 4, 29));
    parts.push(box(stone, tx, -5, 0, 14, 12, 34)); // pier in the water
  }
  // Main cables: parabolic sag between towers, straight backstays to the ends; vertical suspenders.
  const top = 88;
  for (const s of [-1, 1]) {
    const z = s * 11;
    const pts = [];
    pts.push(new THREE.Vector3(0, deckY + 2, z));
    for (let i = 0; i <= 24; i++) {
      const x = towers[0] + ((towers[1] - towers[0]) * i) / 24;
      const t = (x - (towers[0] + towers[1]) / 2) / ((towers[1] - towers[0]) / 2);
      pts.splice(pts.length, 0, new THREE.Vector3(x, deckY + 4 + (top - deckY - 4) * t * t, z));
    }
    pts.push(new THREE.Vector3(len, deckY + 2, z));
    const all = [pts[0], ...pts.slice(1)];
    for (let i = 0; i < all.length - 1; i++) parts.push(strut(0x3a3d42, all[i], all[i + 1], 0.9));
    for (let i = 1; i < 24; i++) {
      const pnt = pts[1 + i];
      parts.push(strut(0x4a4d52, new THREE.Vector3(pnt.x, deckY + 1, z), pnt, 0.25));
    }
  }
  return mergeGeometries(parts);
}

// Cable-stayed bridge: two A-pylons with fanned stays.
function cableStayTemplate() {
  const parts = [];
  const deckY = 36;
  const len = FAR_SHORE + 40;
  const pylons = [len * 0.33, len * 0.67];
  const white = 0xe1e2e0;
  parts.push(box(0x6a6d72, len / 2, deckY, 0, len, 2.2, 24));
  for (const px of pylons) {
    for (const s of [-1, 1]) {
      parts.push(strut(white, new THREE.Vector3(px, -4, s * 14), new THREE.Vector3(px, 120, 0), 3.2));
    }
    parts.push(box(white, px, -4, 0, 12, 10, 32));
    for (let i = 1; i <= 9; i++) {
      for (const dir of [-1, 1]) {
        const anchor = new THREE.Vector3(px + dir * i * 26, deckY + 1, 0);
        for (const s of [-1, 1]) {
          parts.push(strut(0xcfd2d4, new THREE.Vector3(px, 120 - i * 4.5, s * 0.8), anchor.clone().setZ(s * 11), 0.22));
        }
      }
    }
  }
  return mergeGeometries(parts);
}

function waterTowerTemplate() {
  const parts = [];
  const wood = 0x6b4c35;
  parts.push(part(new THREE.CylinderGeometry(2.4, 2.4, 4.5, 10).toNonIndexed(), wood, 0, 5.75, 0));
  parts.push(part(new THREE.ConeGeometry(2.7, 2, 10).toNonIndexed(), 0x3c3530, 0, 9, 0));
  for (const [x, z] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]]) parts.push(box(0x2b2b2b, x, 1.75, z, 0.2, 3.5, 0.2));
  return mergeGeometries(parts);
}

function deciduousTemplate() {
  const parts = [];
  parts.push(part(new THREE.IcosahedronGeometry(1, 0).toNonIndexed(), 0xffffff, 0, 1.15, 0, 1, 0.85, 1));
  parts.push(box(0x5a4a3c, 0, 0.3, 0, 0.12, 0.6, 0.12));
  return mergeGeometries(parts);
}

function coniferTemplate() {
  const parts = [];
  parts.push(part(new THREE.ConeGeometry(0.55, 1.6, 7).toNonIndexed(), 0xffffff, 0, 1.2, 0));
  parts.push(box(0x4a3c30, 0, 0.2, 0, 0.1, 0.4, 0.1));
  return mergeGeometries(parts);
}

// ---------- district noise ----------

function hash1(n) {
  const h = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function noise1(t) {
  const i = Math.floor(t);
  const f = t - i;
  const s = f * f * (3 - 2 * f);
  return hash1(i) * (1 - s) + hash1(i + 1) * s;
}

// A waterfront block gets a bridge on roughly every other roll, never two blocks in a row.
const bridgeRoll = (k, side) => district(k, side) === 'waterfront' && hash1(k * 3.7 + side * 1.3) < 0.45;
const hasBridge = (k, side) => bridgeRoll(k, side) && !bridgeRoll(k + 1, side);

// District for block k on a side: smooth noise so neighbourhoods span several blocks.
function district(k, side) {
  const n = noise1(k * 0.17 + (side < 0 ? 0 : 57.3));
  if (side < 0 ? n < 0.3 : n < 0.14) return 'waterfront';
  if (n > 0.68) return 'downtown';
  if (n < (side < 0 ? 0.42 : 0.3)) return 'park';
  return 'midrise';
}

// ---------- the city ----------

export class City {
  constructor(scene) {
    this.scene = scene;
    this.meshes = {};
    const n = (k) => CAP[k] * ACTIVE;

    const add = (key, geo, mat, opts = {}) => {
      const m = new THREE.InstancedMesh(geo, mat, n(key));
      m.frustumCulled = false;
      m.castShadow = opts.cast ?? true;
      m.receiveShadow = opts.receive ?? true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (opts.colors) m.setColorAt(0, col.set(0xffffff));
      m.count = 0;
      scene.add(m);
      this.meshes[key] = m;
    };

    const buildingBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.facadeMats = [];
    for (const kind of [...BUILDING_KINDS, 'stone']) {
      const mat = facadeMaterial(kind);
      this.facadeMats.push(mat);
      add(kind, buildingBox, mat, { colors: true });
    }
    const vc = (opts = {}) => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05, ...opts });
    add('spire', new THREE.CylinderGeometry(0.15, 1, 1, 6).translate(0, 0.5, 0), new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.3, metalness: 0.8 }));
    add('waterTower', waterTowerTemplate(), vc());
    add('deciduous', deciduousTemplate(), vc({ flatShading: true, roughness: 0.9 }), { colors: true });
    add('conifer', coniferTemplate(), vc({ flatShading: true, roughness: 0.9 }), { colors: true });
    add('ground', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0), new THREE.MeshStandardMaterial({ roughness: 0.95 }), { colors: true, cast: false });
    this.waterMat = new THREE.MeshStandardMaterial({ color: 0x2f5671, roughness: 0.08, metalness: 0.4, normalMap: waterNormals(), normalScale: new THREE.Vector2(0.35, 0.35) });
    this.waterMat.normalMap.repeat.set(60, 60);
    add('water', new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0.5, 0, 0), this.waterMat, { cast: false });
    add('overpass', overpassTemplate(), vc());
    add('railway', railwayTemplate(), vc({ roughness: 0.6, metalness: 0.3 }));
    add('footbridge', footbridgeTemplate(), vc({ roughness: 0.5, metalness: 0.4 }));
    add('gantry', gantryTemplate(), vc({ roughness: 0.6, metalness: 0.3 }));
    const bridgeMat = vc({ roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide });
    add('suspension', suspensionTemplate(), bridgeMat, { receive: false });
    add('cablestay', cableStayTemplate(), bridgeMat, { receive: false });

    this.slotBlock = new Array(ACTIVE).fill(null);
    // Per-block instance data: blocks[slot][key] = { matrices, colors, n }.
    this.blocks = Array.from({ length: ACTIVE }, () => {
      const b = {};
      for (const key of Object.keys(CAP)) {
        b[key] = { matrices: new Float32Array(CAP[key] * 16), colors: new Float32Array(CAP[key] * 3), n: 0 };
      }
      return b;
    });
  }

  setNight(windows) {
    for (const m of this.facadeMats) m.emissiveIntensity = windows;
  }

  setWater(hex) {
    this.waterMat.color.set(hex);
  }

  update(playerZ, time) {
    const kp = Math.floor(playerZ / SEG);
    let changed = false;
    for (let k = kp + 1; k > kp + 1 - ACTIVE; k--) {
      const slot = ((k % ACTIVE) + ACTIVE) % ACTIVE;
      if (this.slotBlock[slot] !== k) {
        this.#build(k, slot);
        this.slotBlock[slot] = k;
        changed = true;
      }
    }
    if (changed) this.#pack(kp);
    this.waterMat.normalMap.offset.set(time * 0.004, time * 0.011);
  }

  // Copy every active block's instances contiguously into each mesh and draw only those. Nearest
  // blocks go first (and within a block, rows run from the road outward), so the GPU draws near
  // buildings first and its depth test skips shading most of what they hide.
  #pack(kp) {
    const order = [];
    for (let k = kp; k > kp + 1 - ACTIVE; k--) order.push(this.blocks[((k % ACTIVE) + ACTIVE) % ACTIVE]);
    order.push(this.blocks[(((kp + 1) % ACTIVE) + ACTIVE) % ACTIVE]);
    for (const key of Object.keys(CAP)) {
      const m = this.meshes[key];
      const mat = m.instanceMatrix.array;
      const colors = m.instanceColor?.array;
      let n = 0;
      for (const block of order) {
        const d = block[key];
        mat.set(d.matrices.subarray(0, d.n * 16), n * 16);
        if (colors) colors.set(d.colors.subarray(0, d.n * 3), n * 3);
        n += d.n;
      }
      m.count = n;
      m.instanceMatrix.clearUpdateRanges();
      m.instanceMatrix.addUpdateRange(0, n * 16);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) {
        m.instanceColor.clearUpdateRanges();
        m.instanceColor.addUpdateRange(0, n * 3);
        m.instanceColor.needsUpdate = true;
      }
    }
  }

  // ---------- block generation ----------

  #put(key, matrix, color) {
    const d = this.block[key];
    if (d.n >= CAP[key]) return;
    matrix.toArray(d.matrices, d.n * 16);
    col.set(color ?? 0xffffff);
    d.colors[d.n * 3] = col.r;
    d.colors[d.n * 3 + 1] = col.g;
    d.colors[d.n * 3 + 2] = col.b;
    d.n++;
  }

  #place(key, x, y, z, sx, sy, sz, yaw = 0, color) {
    q.setFromAxisAngle(up, yaw);
    this.#put(key, m4.compose(p3.set(x, y, z), q, s3.set(sx, sy, sz)), color);
  }

  #build(k, slot) {
    this.block = this.blocks[slot];
    for (const key of Object.keys(CAP)) this.block[key].n = 0;
    const rnd = mulberry(k * 7919 + 17);
    const z0 = k * SEG;
    const z1 = z0 + SEG;

    for (const side of [-1, 1]) {
      const type = district(k, side);
      if (type === 'waterfront') this.#waterfront(rnd, side, z0, z1, k);
      else if (type === 'park') this.#park(rnd, side, z0, z1);
      else this.#urban(rnd, side, z0, z1, type);
    }

    // Structures over the highway (only where neither side is open water, so they have land to stand on).
    const open = district(k, -1) === 'waterfront' || district(k, 1) === 'waterfront';
    if (!open) {
      const r = rnd();
      const z = z0 + 60 + rnd() * (SEG - 120);
      if (r < 0.3) this.#place('overpass', 0, 0, z, 1, 1, 1);
      else if (r < 0.45) this.#place('railway', 0, 0, z, 1, 1, 1);
      else if (r < 0.62) this.#place('footbridge', 0, 0, z, 1, 1, 1);
    }
    if (rnd() < 0.35) this.#place('gantry', 0, 0, z0 + 20 + rnd() * (SEG - 40), 1, 1, 1);
  }

  #ground(side, from, to, z0, color, y = -0.05) {
    const x = side < 0 ? -to : from;
    this.#place('ground', x, y, (z0 + z0 + SEG) / 2, to - from, 1, SEG, 0, color);
  }

  // One building, with setbacks and crown for towers. x0..x0+depth is its extent away from the road.
  #building(rnd, side, x0, depth, zc, front, h, kind) {
    const xc = side * (x0 + depth / 2);
    const tint = 0.85 + rnd() * 0.3;
    const c = col.setScalar(tint).getHex();
    if (h > 90) {
      const podium = 14 + rnd() * 16;
      const podiumKind = rnd() < 0.5 ? kind : rnd() < 0.5 ? 'limestone' : 'concrete';
      this.#place(podiumKind, xc, 0, zc, depth, podium, front, 0, c);
      const k1 = 0.62 + rnd() * 0.25;
      const shaft = h - podium;
      const crown = rnd() < 0.6 ? shaft * (0.08 + rnd() * 0.12) : 0;
      this.#place(kind, xc, podium, zc, depth * k1, shaft - crown, front * k1, 0, c);
      if (crown > 0) this.#place(kind, xc, h - crown, zc, depth * k1 * 0.7, crown, front * k1 * 0.7, 0, c);
      if (h > 200 && rnd() < 0.45) this.#place('spire', xc, h, zc, 1, 20 + rnd() * 70, 1);
    } else {
      this.#place(kind, xc, 0, zc, depth, h, front, 0, c);
      if ((kind === 'brick' || kind === 'limestone') && h < 60 && rnd() < 0.45) {
        this.#place('waterTower', xc + (rnd() - 0.5) * depth * 0.4, h, zc + (rnd() - 0.5) * front * 0.4, 1, 1, 1, rnd() * 6);
      }
    }
  }

  // Rows of lots running parallel to the road, separated by avenues; lots along each row separated
  // by cross streets. Heights rise with distance from the highway in downtown.
  #rows(rnd, side, z0, z1, xStart, rows, style) {
    let x = xStart;
    for (let r = 0; r < rows; r++) {
      const depth = 16 + rnd() * 24;
      let z = z0 + rnd() * 10;
      while (z < z1 - 12) {
        const front = Math.min(z1 - z - 2, 14 + rnd() * 30);
        if (front < 10) break;
        if (rnd() > 0.1) {
          let h;
          let kind;
          if (style === 'downtown') {
            h = r === 0 ? 25 + rnd() * 45 : r < 3 ? 40 + rnd() * 140 : 80 + rnd() * 230;
            kind = h > 90 ? pick(rnd, ['glass', 'glass', 'darkglass', 'white', 'concrete']) : pick(rnd, ['limestone', 'brick', 'concrete', 'glass']);
          } else {
            h = r < 3 ? 12 + rnd() * 30 : 18 + rnd() * 60;
            kind = pick(rnd, ['brick', 'brick', 'limestone', 'concrete', 'white']);
          }
          this.#building(rnd, side, x, depth, z + front / 2, front - 1.5, h, kind);
        }
        z += front + (rnd() < 0.3 ? 14 : 2);
      }
      x += depth + 12 + rnd() * 10;
    }
    return x;
  }

  // Tall towers far from the road: the skyline.
  #skyline(rnd, side, z0, z1, xFrom, xTo, count, hMin, hMax) {
    for (let i = 0; i < count; i++) {
      const x = xFrom + rnd() * (xTo - xFrom);
      const w = 25 + rnd() * 35;
      const h = hMin + Math.pow(rnd(), 1.6) * (hMax - hMin);
      const kind = pick(rnd, ['glass', 'darkglass', 'white', 'glass', 'concrete', 'limestone']);
      const z = z0 + rnd() * SEG;
      // Thin the lower towers on lighter profiles; the tall landmarks always stay.
      if (rnd() > DENSITY && h < hMax * 0.6) continue;
      this.#building(rnd, side, x, w, z, w * (0.7 + rnd() * 0.6), h, kind);
    }
  }

  // size: canopy radius range [min, max] in metres.
  #trees(rnd, side, xFrom, xTo, z0, z1, count, y = 0, coniferShare = 0.25, size = [2.2, 4.5]) {
    for (let i = 0; i < count; i++) {
      const x = side * (xFrom + rnd() * (xTo - xFrom));
      const z = z0 + rnd() * (z1 - z0);
      const s = size[0] + rnd() * (size[1] - size[0]);
      if (rnd() > DENSITY) continue;
      const g = col.setRGB(0.18 + rnd() * 0.12, 0.32 + rnd() * 0.18, 0.12 + rnd() * 0.08).getHex();
      if (rnd() < coniferShare) this.#place('conifer', x, y, z, s * 0.9, s * 1.3, s * 0.9, rnd() * 6, g);
      else this.#place('deciduous', x, y, z, s, s, s, rnd() * 6, g);
    }
  }

  #urban(rnd, side, z0, z1, style) {
    this.#ground(side, EDGE - 0.5, 2600, z0, style === 'downtown' ? 0x6e6f71 : 0x76756f);
    if (style === 'downtown' && rnd() < 0.7) {
      // Sunken highway: stone retaining wall with a planted strip and street trees on top.
      this.#place('stone', side * (EDGE + 2.2), 0, (z0 + z1) / 2, 3, 7.5, SEG, 0, 0xffffff);
      this.#trees(rnd, side, EDGE + 1.8, EDGE + 2.8, z0, z1, 18, 7.5, 0, [1.8, 2.8]);
    } else {
      this.#trees(rnd, side, EDGE + 3.5, EDGE + 7, z0, z1, 14, 0, 0, [1.8, 3]);
    }
    const end = this.#rows(rnd, side, z0, z1, EDGE + 10, style === 'downtown' ? 8 : 7, style);
    if (style === 'downtown') this.#skyline(rnd, side, z0, z1, end + 20, 1400, 14, 150, 460);
    else this.#skyline(rnd, side, z0, z1, end + 40, 1500, 9, 60, 260);
  }

  #park(rnd, side, z0, z1) {
    const parkEnd = EDGE + 140 + rnd() * 80;
    this.#ground(side, EDGE - 0.5, parkEnd, z0, 0x4f6b3a);
    this.#ground(side, parkEnd, 2600, z0, 0x76756f);
    this.#trees(rnd, side, EDGE + 5, parkEnd - 5, z0, z1, 230, 0, 0.3, [2.5, 5.5]);
    const end = this.#rows(rnd, side, z0, z1, parkEnd + 6, 4, 'midrise');
    this.#skyline(rnd, side, z0, z1, end + 40, 1500, 10, 80, 320);
  }

  #waterfront(rnd, side, z0, z1, k) {
    this.#ground(side, EDGE - 0.5, SHORE, z0, 0x8b867c);
    this.#trees(rnd, side, EDGE + 6, SHORE - 6, z0, z1, 16, 0, 0, [2, 3.5]);
    this.#place('water', side < 0 ? -(FAR_SHORE + 40) : SHORE, -1.2, (z0 + z1) / 2, FAR_SHORE + 40 - SHORE, 1, SEG);
    // The far shore: a dense skyline across the water.
    this.#ground(side, FAR_SHORE + 40, 3000, z0, 0x5f6062);
    this.#skyline(rnd, side, z0, z1, FAR_SHORE + 60, 1900, 34, 40, 420);
    // Occasional bridge crossing to the far shore.
    if (hasBridge(k, side)) {
      const key = hash1(k * 9.1) < 0.55 ? 'suspension' : 'cablestay';
      // Template runs along +x; a half-turn about y points it along -x without mirroring.
      this.#place(key, side * SHORE, 0, z0 + SEG * 0.5, 1, 1, 1, side < 0 ? Math.PI : 0);
    }
  }
}

function pick(rnd, list) {
  return list[Math.floor(rnd() * list.length)];
}

function waterNormals() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const img = g.createImageData(s, s);
  // Sum of a few sine ripples, encoded as a tangent-space normal map.
  const waves = Array.from({ length: 6 }, () => [Math.random() * 6.28, 1 + Math.floor(Math.random() * 4), Math.floor(Math.random() * 4) - 2]);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let dx = 0;
      let dy = 0;
      for (const [ph, fx, fy] of waves) {
        const a = ((x * fx + y * fy) / s) * Math.PI * 2 + ph;
        dx += Math.cos(a) * fx;
        dy += Math.cos(a) * fy;
      }
      const i = (y * s + x) * 4;
      img.data[i] = 128 + dx * 10;
      img.data[i + 1] = 128 + dy * 10;
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export { TILE };
