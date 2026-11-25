import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Low-poly, flat-shaded vehicles. Vehicles face -z.
// Every part is baked into a few merged geometries with per-vertex colour, one per layer:
//   paint — body panels (vertex colour white for traffic so the instance colour sets the paint)
//   fixed — glass, tyres, trim: never tinted
//   glow  — unlit emissive lights (HDR vertex colours, picked up by bloom)
//   tail  — taillights, brightness driven at runtime for braking

// Section: { z, hw (bottom half-width), tw (top half-width), y0, y1 }.
function loft(sections) {
  const pos = [];
  const ring = (s) => [
    [-s.hw, s.y0, s.z],
    [s.hw, s.y0, s.z],
    [s.tw, s.y1, s.z],
    [-s.tw, s.y1, s.z],
  ];
  const quad = (a, b, c, d) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < sections.length - 1; i++) {
    const a = ring(sections[i]);
    const b = ring(sections[i + 1]);
    for (let k = 0; k < 4; k++) quad(a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]);
  }
  const f = ring(sections[0]);
  const r = ring(sections[sections.length - 1]);
  quad(f[3], f[2], f[1], f[0]);
  quad(r[0], r[1], r[2], r[3]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

const boxGeo = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const tireGeo = new THREE.CylinderGeometry(1, 1, 1, 10).rotateZ(Math.PI / 2).toNonIndexed();
const barrelGeo = new THREE.CylinderGeometry(0.7, 0.7, 1.02, 10).rotateZ(Math.PI / 2).toNonIndexed();
const lipGeo = new THREE.TorusGeometry(0.7, 0.06, 3, 10).rotateY(Math.PI / 2).toNonIndexed();
const hubGeo = new THREE.CylinderGeometry(0.16, 0.16, 1.12, 5).rotateZ(Math.PI / 2).toNonIndexed();
const tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 8).rotateX(Math.PI / 2).toNonIndexed();

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();

class Builder {
  constructor() {
    // sigL / sigR: turn-signal lenses (left = -x, right = +x), brightness driven per instance.
    this.layers = { paint: [], fixed: [], glow: [], tail: [], sigL: [], sigR: [] };
  }

  add(layer, geo, color, matrix) {
    const g = geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    if (matrix) g.applyMatrix4(matrix);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.layers[layer].push(g);
  }

  box(layer, color, w, h, d, x, y, z, rx = 0) {
    tmpQ.setFromEuler(tmpE.set(rx, 0, 0));
    tmpM.compose(tmpP.set(x, y, z), tmpQ, tmpS.set(w, h, d));
    this.add(layer, boxGeo, color, tmpM);
  }

  // Glow colours are scaled above 1.0 so bloom catches them.
  glow(color, intensity, w, h, d, x, y, z) {
    this.box('glow', new THREE.Color(color).multiplyScalar(intensity), w, h, d, x, y, z);
  }

  // Tyre, dark rim barrel, and on both faces a rim lip, five spokes and a hub.
  // detailed = false (traffic): tyre, barrel and hub only — spokes on 64 cars cost ~90k triangles.
  wheel(layer, r, w, x, z, rimColor, detailed = true) {
    tmpM.compose(tmpP.set(x, r, z), tmpQ.identity(), tmpS.set(w, r, r));
    const m = tmpM.clone();
    this.add(layer, tireGeo, 0x151515, m);
    this.add(layer, barrelGeo, 0x101113, m);
    this.add(layer, hubGeo, rimColor, m);
    if (!detailed) return;
    const spokeLen = 0.62 * r;
    for (const face of [-1, 1]) {
      const fx = x + face * (w / 2 + 0.005);
      tmpM.compose(tmpP.set(fx, r, z), tmpQ.identity(), tmpS.set(r, r, r));
      this.add(layer, lipGeo, rimColor, tmpM);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        const cy = r + Math.cos(a) * spokeLen * 0.55;
        const cz = z + Math.sin(a) * spokeLen * 0.55;
        this.box(layer, rimColor, 0.03, spokeLen, 0.12 * r, fx, cy, cz, a);
      }
    }
  }

  build() {
    const out = {};
    for (const [k, list] of Object.entries(this.layers)) out[k] = list.length ? mergeGeometries(list) : null;
    return out;
  }
}

const DARK_RIM = 0x2a2c30;
const SIGNAL_AMBER = 0xff8a10;

// Generic passenger body. p: { L, W, hood, deck, roof, cabin:[zFront, zRoofF, zRoofR, zRear], paint, glass }
function passengerBody(b, p) {
  const hl = p.L / 2;
  const hw = p.W / 2;
  b.add(
    'paint',
    loft([
      { z: -hl, hw: hw - 0.12, tw: hw - 0.2, y0: 0.28, y1: p.hood - 0.22 },
      { z: -hl + 0.3, hw, tw: hw - 0.08, y0: 0.22, y1: p.hood - 0.04 },
      { z: p.cabin[0], hw, tw: hw - 0.06, y0: 0.22, y1: p.hood },
      { z: p.cabin[3], hw, tw: hw - 0.06, y0: 0.22, y1: p.deck },
      { z: hl - 0.25, hw: hw - 0.03, tw: hw - 0.1, y0: 0.26, y1: p.deck },
      { z: hl, hw: hw - 0.1, tw: hw - 0.16, y0: 0.32, y1: p.deck - 0.12 },
    ]),
    p.paint,
  );
  const roofHw = hw - 0.28;
  b.add(
    'fixed',
    loft([
      { z: p.cabin[0], hw: hw - 0.1, tw: hw - 0.1, y0: p.hood - 0.02, y1: p.hood },
      { z: p.cabin[1], hw: hw - 0.14, tw: roofHw, y0: p.hood, y1: p.roof },
      { z: p.cabin[2], hw: hw - 0.14, tw: roofHw, y0: p.deck, y1: p.roof - 0.03 },
      { z: p.cabin[3], hw: hw - 0.1, tw: hw - 0.1, y0: p.deck - 0.02, y1: p.deck },
    ]),
    p.glass ?? 0x0c1118,
  );
  b.box('paint', p.paint, roofHw * 2 + 0.04, 0.05, p.cabin[2] - p.cabin[1], 0, p.roof + 0.01, (p.cabin[1] + p.cabin[2]) / 2);
}

function wheelPositions(p) {
  const hw = p.W / 2;
  const wz = p.L / 2 - (p.overhang ?? 0.85);
  return [
    [-hw + 0.12, -wz],
    [hw - 0.12, -wz],
    [-hw + 0.12, wz],
    [hw - 0.12, wz],
  ];
}

// ---------- Player car: deep-blue 90s sport coupe, red-tinted glass, silver 5-spokes, red underglow ----------

// Collision widths. Lane width is derived from these (see world.js) so that two vehicles side by
// side in adjacent lanes always leave a gap just wider than the player car.
export const PLAYER_WIDTH = 1.78;
export const TRUCK_WIDTH = 2.35;
export const MAX_TRAFFIC_WIDTH = TRUCK_WIDTH;

const playerBodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.45, metalness: 0.3 });
const playerFixedMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, metalness: 0 });
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });

export function buildPlayerCar() {
  const p = {
    L: 4.45,
    W: PLAYER_WIDTH,
    hood: 0.86,
    deck: 0.95,
    roof: 1.3,
    cabin: [-0.65, 0.05, 0.85, 1.55],
    overhang: 0.92,
    paint: 0x1d2f86,
    glass: 0x2a0709,
  };
  const hl = p.L / 2;
  const hw = p.W / 2;
  const b = new Builder();
  passengerBody(b, p);

  // Black trim at the base of the windscreen, body-colour mirrors.
  b.box('fixed', 0x0a0a0c, p.W - 0.2, 0.03, 0.05, 0, p.hood + 0.01, p.cabin[0] + 0.02);
  for (const s of [-1, 1]) b.box('paint', p.paint, 0.14, 0.1, 0.18, s * (hw + 0.05), p.hood + 0.08, p.cabin[0] + 0.3);

  // Rear wing: full-width plane on swept end plates rising from the rear quarters.
  for (const s of [-1, 1]) b.box('paint', p.paint, 0.05, 0.3, 0.2, s * (hw - 0.1), 1.1, hl - 0.3, -0.5);
  b.box('paint', p.paint, p.W - 0.08, 0.05, 0.32, 0, 1.26, hl - 0.2, 0.08);

  // Front: cyan headlight elements, amber outboard corners and side markers, cyan fog lights, grille.
  for (const s of [-1, 1]) {
    b.glow(0x5fe0f0, 2.2, 0.3, 0.08, 0.05, s * (hw - 0.42), 0.68, -hl + 0.1);
    b.glow(0xffa030, 1.6, 0.12, 0.08, 0.05, s * (hw - 0.17), 0.66, -hl + 0.12);
    b.glow(0xffa030, 1.4, 0.03, 0.05, 0.16, s * (hw + 0.005), 0.5, -hl + 0.45);
    b.glow(0x5fe0f0, 1.8, 0.18, 0.08, 0.04, s * (hw - 0.4), 0.35, -hl - 0.01);
  }
  b.box('fixed', 0x0a0b0d, p.W - 0.7, 0.14, 0.03, 0, 0.36, -hl - 0.005);

  // Rear: full-width red taillight bar with red-orange outer segments, recessed plate area, exhaust.
  b.box('fixed', 0x16080a, p.W - 0.26, 0.17, 0.03, 0, 0.79, hl + 0.002);
  b.box('tail', 0xff1a10, 1.0, 0.1, 0.04, 0, 0.79, hl + 0.01);
  for (const s of [-1, 1]) {
    b.box('tail', 0xff1a10, 0.18, 0.09, 0.04, s * 0.62, 0.78, hl + 0.01);
    b.glow(0xff4a18, 0.9, 0.16, 0.08, 0.04, s * (hw - 0.14), 0.77, hl - 0.005);
    b.glow(0xff4a18, 0.9, 0.04, 0.07, 0.24, s * (hw - 0.04), 0.76, hl - 0.18);
  }
  b.box('fixed', 0x0d1022, 0.6, 0.2, 0.03, 0, 0.53, hl + 0.002);
  tmpM.compose(tmpP.set(-0.36, 0.3, hl + 0.02), tmpQ.identity(), tmpS.set(0.055, 0.055, 0.22));
  b.add('fixed', tubeGeo, DARK_RIM, tmpM);

  // Red neon underglow strips: side skirts, front lip, rear.
  for (const s of [-1, 1]) b.glow(0xff1020, 2.2, 0.04, 0.03, p.L - 1.4, s * (hw - 0.02), 0.2, 0.05);
  b.glow(0xff1020, 2.2, p.W - 0.3, 0.03, 0.04, 0, 0.22, -hl + 0.05);
  b.glow(0xff1020, 1.8, p.W - 0.4, 0.03, 0.04, 0, 0.26, hl - 0.05);

  const layers = b.build();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(layers.paint, playerBodyMat));
  group.add(new THREE.Mesh(layers.fixed, playerFixedMat));
  group.add(new THREE.Mesh(layers.glow, glowMat));
  const tail = new THREE.MeshBasicMaterial({ vertexColors: true });
  group.add(new THREE.Mesh(layers.tail, tail));

  // Wheels stay separate so they can spin and steer: one merged mesh each, silver 5-spoke.
  const wb = new Builder();
  wb.wheel('fixed', 0.34, 0.25, 0, 0, 0xc8cacc);
  const wheelGeo = wb.build().fixed.translate(0, -0.34, 0);
  const wheels = wheelPositions(p).map(([x, z]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.34, z);
    const spin = new THREE.Mesh(wheelGeo, playerFixedMat);
    pivot.add(spin);
    pivot.userData.spin = spin;
    group.add(pivot);
    return pivot;
  });

  return { group, wheels, tail, length: p.L, width: p.W };
}

// ---------- Traffic: one InstancedMesh per (type, layer) ----------

export const TRAFFIC_COLORS = [0xe8e8e8, 0xb8bcc2, 0x1a1c20, 0x22304a, 0x7a1418, 0x5a5f66, 0x30343a, 0xd8d4cc];

const TYPES = {
  sedan: { L: 4.7, W: 1.84, hood: 0.88, deck: 1.0, roof: 1.42, cabin: [-0.8, -0.1, 1.0, 1.75] },
  suv: { L: 4.85, W: 1.95, hood: 1.1, deck: 1.35, roof: 1.78, cabin: [-1.0, -0.4, 2.0, 2.3], wheelR: 0.38 },
};

export function trafficGeometry(type) {
  const b = new Builder();
  if (type === 'truck') {
    const L = 8.2;
    const W = TRUCK_WIDTH;
    const hl = L / 2;
    b.box('paint', 0xffffff, W - 0.1, 1.9, 2.0, 0, 1.35, -hl + 1.0);
    b.box('fixed', 0x0c1118, W - 0.16, 0.7, 0.05, 0, 1.85, -hl - 0.01);
    b.box('fixed', 0xc8c8c4, W, 2.9, 6.0, 0, 2.05, hl - 3.0);
    b.box('fixed', 0x222222, W - 0.2, 0.3, L - 0.2, 0, 0.55, 0);
    for (const [s, z] of [[-1, -hl + 1.2], [1, -hl + 1.2], [-1, hl - 1.4], [1, hl - 1.4]]) {
      b.wheel('fixed', 0.48, 0.3, s * (W / 2 - 0.2), z, DARK_RIM, false);
    }
    for (const s of [-1, 1]) {
      b.box('tail', 0xff1a10, 0.25, 0.25, 0.04, s * (W / 2 - 0.2), 0.9, hl + 0.01);
      b.glow(0xfff2dd, 1.4, 0.3, 0.15, 0.04, s * (W / 2 - 0.3), 0.8, -hl - 0.01);
      const sig = s < 0 ? 'sigL' : 'sigR';
      b.box(sig, SIGNAL_AMBER, 0.25, 0.2, 0.04, s * (W / 2 - 0.2), 1.2, hl + 0.01);
      b.box(sig, SIGNAL_AMBER, 0.22, 0.14, 0.04, s * (W / 2 - 0.12), 1.0, -hl - 0.01);
      b.box(sig, SIGNAL_AMBER, 0.04, 0.12, 0.3, s * (W / 2 + 0.01), 1.0, -hl + 0.5);
    }
    b.glow(0xffa030, 1.3, W - 0.3, 0.05, 0.04, 0, 3.45, hl + 0.01);
    return { layers: b.build(), length: L, width: W };
  }
  const p = { ...TYPES[type], paint: 0xffffff };
  const hl = p.L / 2;
  const hw = p.W / 2;
  passengerBody(b, p);
  for (const [x, z] of wheelPositions(p)) b.wheel('fixed', p.wheelR ?? 0.34, 0.25, x, z, DARK_RIM, false);
  const ty = p.deck - 0.14;
  for (const s of [-1, 1]) {
    b.box('tail', 0xff1a10, 0.42, 0.09, 0.04, s * (hw - 0.32), ty, hl + 0.005);
    b.glow(0xfff2dd, 1.4, 0.36, 0.09, 0.04, s * (hw - 0.3), p.hood - 0.18, -hl - 0.005);
    // Signal lenses sit proud of the body surface: rear below the taillight, front below the
    // headlight, plus a side repeater on the front fender.
    const sig = s < 0 ? 'sigL' : 'sigR';
    b.box(sig, SIGNAL_AMBER, 0.3, 0.08, 0.04, s * (hw - 0.32), ty - 0.13, hl + 0.01);
    b.box(sig, SIGNAL_AMBER, 0.26, 0.08, 0.04, s * (hw - 0.3), p.hood - 0.3, -hl - 0.012);
    b.box(sig, SIGNAL_AMBER, 0.03, 0.07, 0.2, s * (hw + 0.01), p.hood - 0.25, -hl + 0.6);
  }
  return { layers: b.build(), length: p.L, width: p.W };
}

export const trafficMats = {
  paint: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.5, metalness: 0.25 }),
  fixed: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.6, metalness: 0.2 }),
  glow: glowMat,
  tail: new THREE.MeshBasicMaterial({ vertexColors: true }),
  sigL: new THREE.MeshBasicMaterial({ vertexColors: true }),
  sigR: new THREE.MeshBasicMaterial({ vertexColors: true }),
};

// Returns { type: { meshes: {layer: InstancedMesh}, count, length, width } }.
export function buildTrafficFleet(scene, counts) {
  const fleet = {};
  for (const [type, count] of Object.entries(counts)) {
    const { layers, length, width } = trafficGeometry(type);
    const meshes = {};
    for (const [layer, geo] of Object.entries(layers)) {
      if (!geo) continue;
      const m = new THREE.InstancedMesh(geo, trafficMats[layer], count);
      m.frustumCulled = false; // instances span the whole highway
      m.castShadow = layer === 'paint' || layer === 'fixed';
      m.receiveShadow = true;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      meshes[layer] = m;
    }
    fleet[type] = { meshes, count, length, width };
  }
  return fleet;
}
