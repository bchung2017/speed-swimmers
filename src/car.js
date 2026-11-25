import * as THREE from 'three';

// Low-poly, flat-shaded vehicles built from lofted trapezoid sections.
// Vehicles face -z. Section: { z, hw (bottom half-width), tw (top half-width), y0, y1 }.

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
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      quad(a[k], a[k2], b[k2], b[k]);
    }
  }
  const f = ring(sections[0]);
  const r = ring(sections[sections.length - 1]);
  quad(f[3], f[2], f[1], f[0]);
  quad(r[0], r[1], r[2], r[3]);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

const mats = new Map();
function paint(color, opts = {}) {
  const key = `${color}|${JSON.stringify(opts)}`;
  if (!mats.has(key)) {
    mats.set(
      key,
      new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.55, metalness: 0.25, ...opts }),
    );
  }
  return mats.get(key);
}

export function glow(color, intensity) {
  return new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity });
}

const glassMat = paint(0x0c1118, { roughness: 0.4, metalness: 0.3 });
const tireMat = paint(0x151515, { roughness: 0.9, metalness: 0 });
const rimMat = paint(0x2a2c30, { roughness: 0.4, metalness: 0.6 });

const tireGeo = new THREE.CylinderGeometry(1, 1, 1, 10).rotateZ(Math.PI / 2);
const rimGeo = new THREE.CylinderGeometry(0.62, 0.62, 1.04, 5).rotateZ(Math.PI / 2);
const boxGeo = new THREE.BoxGeometry(1, 1, 1);

function box(mat, w, h, d, x, y, z) {
  const m = new THREE.Mesh(boxGeo, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  return m;
}

function wheel(r, w, x, z) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(tireGeo, tireMat);
  tire.scale.set(w, r, r);
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.scale.set(w, r, r);
  const spin = new THREE.Group();
  spin.add(tire, rim);
  g.add(spin);
  g.position.set(x, r, z);
  g.userData.spin = spin;
  return g;
}

// Generic passenger vehicle. p: { L, W, hood, deck, roof, cabin:[zFront, zRoofF, zRoofR, zRear], color }
function passenger(p) {
  const car = new THREE.Group();
  const hl = p.L / 2;
  const hw = p.W / 2;
  const body = paint(p.color);

  const hull = loft([
    { z: -hl, hw: hw - 0.12, tw: hw - 0.2, y0: 0.28, y1: p.hood - 0.22 },
    { z: -hl + 0.3, hw, tw: hw - 0.08, y0: 0.22, y1: p.hood - 0.04 },
    { z: p.cabin[0], hw, tw: hw - 0.06, y0: 0.22, y1: p.hood },
    { z: p.cabin[3], hw, tw: hw - 0.06, y0: 0.22, y1: p.deck },
    { z: hl - 0.25, hw: hw - 0.03, tw: hw - 0.1, y0: 0.26, y1: p.deck },
    { z: hl, hw: hw - 0.1, tw: hw - 0.16, y0: 0.32, y1: p.deck - 0.12 },
  ]);
  car.add(new THREE.Mesh(hull, body));

  const roofHw = hw - 0.28;
  const cabin = loft([
    { z: p.cabin[0], hw: hw - 0.1, tw: hw - 0.1, y0: p.hood - 0.02, y1: p.hood },
    { z: p.cabin[1], hw: hw - 0.14, tw: roofHw, y0: p.hood, y1: p.roof },
    { z: p.cabin[2], hw: hw - 0.14, tw: roofHw, y0: p.deck, y1: p.roof - 0.03 },
    { z: p.cabin[3], hw: hw - 0.1, tw: hw - 0.1, y0: p.deck - 0.02, y1: p.deck },
  ]);
  car.add(new THREE.Mesh(cabin, glassMat));
  const roofLen = p.cabin[2] - p.cabin[1];
  car.add(box(body, roofHw * 2 + 0.04, 0.05, roofLen, 0, p.roof + 0.01, (p.cabin[1] + p.cabin[2]) / 2));

  const wr = p.wheelR ?? 0.34;
  const wz = hl - (p.overhang ?? 0.85);
  const wheels = [
    wheel(wr, 0.25, -hw + 0.12, -wz),
    wheel(wr, 0.25, hw - 0.12, -wz),
    wheel(wr, 0.25, -hw + 0.12, wz),
    wheel(wr, 0.25, hw - 0.12, wz),
  ];
  car.add(...wheels);

  const tail = glow(0xff1a10, 0.8);
  if (!p.customRear) {
    const ty = p.deck - 0.14;
    car.add(box(tail, 0.42, 0.09, 0.04, -hw + 0.32, ty, hl + 0.005));
    car.add(box(tail, 0.42, 0.09, 0.04, hw - 0.32, ty, hl + 0.005));
  }
  const head = glow(0xfff2dd, 2);
  car.add(box(head, 0.36, 0.09, 0.04, -hw + 0.3, p.hood - 0.18, -hl - 0.005));
  car.add(box(head, 0.36, 0.09, 0.04, hw - 0.3, p.hood - 0.18, -hl - 0.005));

  return { group: car, wheels, tail, length: p.L, width: p.W };
}

// The player car: slate-grey 90s sport coupe with rear wing, cyan/amber lighting.
export function buildPlayerCar() {
  const v = passenger({
    L: 4.45,
    W: 1.78,
    hood: 0.86,
    deck: 0.95,
    roof: 1.3,
    cabin: [-0.65, 0.05, 0.85, 1.55],
    overhang: 0.92,
    color: 0x5c626b,
    customRear: true,
  });
  const { group } = v;
  const body = paint(0x5c626b);
  const hl = v.length / 2;
  const hw = v.width / 2;

  // Rear wing: full-width plane on tall end plates rising from the rear quarters.
  for (const s of [-1, 1]) {
    const plate = box(body, 0.05, 0.3, 0.2, s * (hw - 0.1), 1.1, hl - 0.3);
    plate.rotation.x = -0.5;
    group.add(plate);
  }
  const plane = box(body, v.width - 0.08, 0.05, 0.32, 0, 1.26, hl - 0.2);
  plane.rotation.x = 0.08;
  group.add(plane);

  // Rear fascia: full-width taillight bar (red centre, amber outer corners that wrap the sides),
  // recessed plate area, cyan lights at the lower bumper corners, single exhaust on the left.
  const amberLens = glow(0xff8a20, 0.7);
  group.add(box(paint(0x1a1c20), v.width - 0.3, 0.16, 0.03, 0, 0.79, hl + 0.002));
  group.add(box(v.tail, 1.0, 0.1, 0.04, 0, 0.79, hl + 0.01));
  for (const s of [-1, 1]) {
    group.add(box(v.tail, 0.18, 0.09, 0.04, s * 0.62, 0.78, hl + 0.01));
    group.add(box(amberLens, 0.16, 0.08, 0.04, s * (hw - 0.14), 0.77, hl - 0.005));
    group.add(box(amberLens, 0.04, 0.07, 0.24, s * (hw - 0.04), 0.76, hl - 0.18));
  }
  group.add(box(paint(0x16181c), 0.6, 0.2, 0.03, 0, 0.53, hl + 0.002));
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.22, 8).rotateX(Math.PI / 2), rimMat);
  exhaust.position.set(-0.36, 0.32, hl + 0.02);
  group.add(exhaust);

  // Front lighting: cyan headlight elements, amber outboard corner + side marker, cyan fog lights.
  const cyan = glow(0x5fe0f0, 4);
  const amber = glow(0xffa030, 3);
  const rearCyan = glow(0x5fe0f0, 1.5);
  for (const s of [-1, 1]) {
    group.add(box(cyan, 0.3, 0.08, 0.05, s * (hw - 0.42), 0.68, -hl + 0.1));
    group.add(box(amber, 0.12, 0.08, 0.05, s * (hw - 0.17), 0.66, -hl + 0.12));
    group.add(box(amber, 0.03, 0.05, 0.16, s * (hw + 0.005), 0.5, -hl + 0.45));
    group.add(box(cyan, 0.18, 0.08, 0.04, s * (hw - 0.4), 0.35, -hl - 0.01));
    group.add(box(rearCyan, 0.1, 0.08, 0.04, s * (hw - 0.2), 0.52, hl + 0.005));
  }

  return v;
}

const TRAFFIC_COLORS = [0xe8e8e8, 0xb8bcc2, 0x1a1c20, 0x22304a, 0x7a1418, 0x5a5f66, 0x30343a, 0xd8d4cc];

export function buildTrafficVehicle(rng) {
  const color = TRAFFIC_COLORS[Math.floor(rng() * TRAFFIC_COLORS.length)];
  const kind = rng();
  if (kind < 0.12) return boxTruck(rng);
  if (kind < 0.4) {
    return {
      ...passenger({ L: 4.85, W: 1.95, hood: 1.1, deck: 1.35, roof: 1.78, cabin: [-1.0, -0.4, 2.0, 2.3], wheelR: 0.38, color }),
      type: 'suv',
    };
  }
  return {
    ...passenger({ L: 4.7, W: 1.84, hood: 0.88, deck: 1.0, roof: 1.42, cabin: [-0.8, -0.1, 1.0, 1.75], color }),
    type: 'sedan',
  };
}

function boxTruck() {
  const g = new THREE.Group();
  const L = 8.2;
  const W = 2.45;
  const hl = L / 2;
  const cab = paint(0xdedede);
  const cargo = paint(0xc8c8c4, { roughness: 0.85, metalness: 0 });
  g.add(box(cab, W - 0.1, 1.9, 2.0, 0, 1.35, -hl + 1.0));
  g.add(box(glassMat, W - 0.16, 0.7, 0.05, 0, 1.85, -hl - 0.01));
  g.add(box(cargo, W, 2.9, 6.0, 0, 2.05, hl - 3.0));
  g.add(box(paint(0x222222), W - 0.2, 0.3, L - 0.2, 0, 0.55, 0));
  const wheels = [
    wheel(0.48, 0.3, -W / 2 + 0.2, -hl + 1.2),
    wheel(0.48, 0.3, W / 2 - 0.2, -hl + 1.2),
    wheel(0.48, 0.3, -W / 2 + 0.2, hl - 1.4),
    wheel(0.48, 0.3, W / 2 - 0.2, hl - 1.4),
  ];
  g.add(...wheels);
  const tail = glow(0xff1a10, 0.8);
  g.add(box(tail, 0.25, 0.25, 0.04, -W / 2 + 0.2, 0.9, hl + 0.01));
  g.add(box(tail, 0.25, 0.25, 0.04, W / 2 - 0.2, 0.9, hl + 0.01));
  g.add(box(glow(0xffa030, 2), W - 0.3, 0.05, 0.04, 0, 3.45, hl + 0.01));
  const head = glow(0xfff2dd, 2);
  g.add(box(head, 0.3, 0.15, 0.04, -W / 2 + 0.3, 0.8, -hl - 0.01));
  g.add(box(head, 0.3, 0.15, 0.04, W / 2 - 0.3, 0.8, -hl - 0.01));
  return { group: g, wheels, tail, length: L, width: W, type: 'truck' };
}
