import * as THREE from 'three';
import { trafficGeometry, trafficMats } from './car.js';

// Crash damage for traffic vehicles: inward dents plus debris particles. Nothing detaches.
//
// A "rig" is a standalone, deformable copy of a vehicle (its own vertex buffers). Rigs are pooled and
// staged on traffic cars near the player ahead of time, so on impact the instanced car is swapped for
// its rig in the same frame and dented around the contact point. Shards (paint, glass, trim) are
// thrown from the contact point in proportion to crash severity.

const PREWARM = { sedan: 8, suv: 5, truck: 3 };
// Height of each type's centre of mass: rigs pivot around it when they tumble.
export const CENTRE_HEIGHT = { sedan: 0.7, suv: 0.85, truck: 1.6 };
const MAX_DENT = 0.45; // metres any vertex may be pushed in from its original position
const SHARD_POOL = 320;
const GRAVITY = 9.8;

// Rig materials render both sides: a deep dent can fold a triangle over, and with back-face culling
// that would show as a hole in the bodywork.
const rigMats = {
  fixed: trafficMats.fixed.clone(),
  glow: trafficMats.glow.clone(),
  tail: new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color().setScalar(0.6) }),
  sigL: new THREE.MeshBasicMaterial({ vertexColors: true }),
  sigR: new THREE.MeshBasicMaterial({ vertexColors: true }),
};
for (const m of Object.values(rigMats)) m.side = THREE.DoubleSide;

const GLASS = new THREE.Color(0x9fb8c8);
const TRIM = new THREE.Color(0x1a1b1e);

// Deterministic per-position noise in [-0.5, 0.5]. Geometry is non-indexed, so one corner exists as
// several vertices; keying the noise on the original position moves them identically (no cracks).
function hash3(x, y, z) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h) - 0.5;
}

class Rig {
  constructor(template, type) {
    this.type = type;
    // Outer group is placed at the centre of mass (and rotated in YXZ order: yaw, then pitch/roll);
    // the inner group shifts the model down so it pivots around that point.
    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    this.group.visible = false;
    this.inner = new THREE.Group();
    this.inner.position.y = -CENTRE_HEIGHT[type];
    this.group.add(this.inner);
    this.paintMat = trafficMats.paint.clone();
    this.paintMat.side = THREE.DoubleSide;
    // Own signal materials so a wreck can flash its hazards.
    this.sigMats = { sigL: rigMats.sigL.clone(), sigR: rigMats.sigR.clone() };
    this.layers = [];
    for (const [layer, geo] of Object.entries(template)) {
      if (!geo) continue;
      const g = geo.clone();
      const mat = layer === 'paint' ? this.paintMat : (this.sigMats[layer] ?? rigMats[layer]);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = mesh.receiveShadow = layer === 'paint' || layer === 'fixed';
      this.inner.add(mesh);
      this.layers.push({ mesh, original: geo.attributes.position.array });
    }
    this.dirty = false;
    this.inUse = false;
  }

  reset(color) {
    this.paintMat.color.copy(color);
    if (this.dirty) {
      for (const { mesh, original } of this.layers) {
        mesh.geometry.attributes.position.array.set(original);
        mesh.geometry.attributes.position.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
      }
      this.dirty = false;
    }
    this.group.visible = false;
  }

  // Push vertices near `local` along `push` (both in the vehicle's frame), falling off with distance.
  dent(local, push, severity) {
    const radius = Math.min(2.0, 0.8 + severity * 0.04);
    const depth = Math.min(MAX_DENT, 0.04 + severity * 0.018);
    const r2 = radius * radius;
    for (const { mesh, original } of this.layers) {
      const attr = mesh.geometry.attributes.position;
      const pos = attr.array;
      let touched = false;
      for (let i = 0; i < pos.length; i += 3) {
        const ox = original[i];
        const oy = original[i + 1];
        const oz = original[i + 2];
        const dx = ox - local.x;
        const dy = oy - local.y;
        const dz = oz - local.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        const f = 1 - Math.sqrt(d2) / radius;
        const k = depth * f * f * (1 + 0.6 * hash3(ox, oy, oz));
        let nx = pos[i] + push.x * k;
        let ny = pos[i + 1] + push.y * k;
        let nz = pos[i + 2] + push.z * k;
        // Cap total displacement so repeated hits crumple rather than pass through the car.
        const ex = nx - ox;
        const ey = ny - oy;
        const ez = nz - oz;
        const e = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (e > MAX_DENT) {
          const s = MAX_DENT / e;
          nx = ox + ex * s;
          ny = oy + ey * s;
          nz = oz + ez * s;
        }
        pos[i] = nx;
        pos[i + 1] = ny;
        pos[i + 2] = nz;
        touched = true;
      }
      if (touched) attr.needsUpdate = true;
    }
    this.dirty = true;
  }
}

const v3 = new THREE.Vector3();
const q = new THREE.Quaternion();
const m4 = new THREE.Matrix4();
const shardScale = new THREE.Vector3();

export class Wreckage {
  constructor(scene) {
    this.scene = scene;
    this.templates = {};
    this.pools = {};
    for (const type of Object.keys(PREWARM)) {
      this.templates[type] = trafficGeometry(type).layers;
      this.pools[type] = [];
      for (let i = 0; i < PREWARM[type]; i++) this.pools[type].push(this.#newRig(type));
    }

    // Debris particles: one InstancedMesh used as a ring buffer.
    this.shards = new THREE.InstancedMesh(
      new THREE.TetrahedronGeometry(1, 0),
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.5, metalness: 0.3 }),
      SHARD_POOL,
    );
    this.shards.frustumCulled = false;
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shardState = [];
    for (let i = 0; i < SHARD_POOL; i++) {
      this.shards.setMatrixAt(i, m4.makeScale(0, 0, 0));
      this.shards.setColorAt(i, GLASS);
      this.shardState.push({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Quaternion(), axis: new THREE.Vector3(), spin: 0, size: 0 });
    }
    this.nextShard = 0;
    scene.add(this.shards);
  }

  #newRig(type) {
    const rig = new Rig(this.templates[type], type);
    this.scene.add(rig.group);
    return rig;
  }

  // Show every rig once so its shaders compile before the first crash.
  prewarm(on, at) {
    for (const pool of Object.values(this.pools)) {
      for (const rig of pool) {
        if (rig.inUse) continue;
        rig.group.visible = on;
        if (on) rig.group.position.copy(at);
      }
    }
  }

  acquire(type, color) {
    const pool = this.pools[type];
    let rig = pool.find((r) => !r.inUse);
    if (!rig) {
      rig = this.#newRig(type);
      pool.push(rig);
    }
    rig.reset(color);
    rig.inUse = true;
    return rig;
  }

  release(rig) {
    rig.reset(rig.paintMat.color);
    rig.inUse = false;
  }

  // local: contact point in the vehicle's frame; push: unit dent direction in the vehicle's frame;
  // worldPush: same direction in world space; carVel: vehicle velocity (world); severity in m/s.
  impact(rig, local, push, worldPush, carVel, severity) {
    rig.dent(local, push, severity);

    rig.group.updateMatrixWorld(true);
    const origin = v3.copy(local).applyMatrix4(rig.inner.matrixWorld);
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const n = Math.min(140, Math.round(severity * 3.5));
    for (let i = 0; i < n; i++) {
      const roll = Math.random();
      const color = roll < 0.5 ? rig.paintMat.color : roll < 0.8 ? GLASS : TRIM;
      this.#shard(ox, oy, oz, worldPush, carVel, severity, color);
    }
  }

  #shard(ox, oy, oz, dir, carVel, severity, color) {
    const i = this.nextShard;
    this.nextShard = (i + 1) % SHARD_POOL;
    const s = this.shardState[i];
    s.life = 2.5 + Math.random() * 3;
    s.p.set(ox + (Math.random() - 0.5) * 0.8, oy + Math.random() * 0.5, oz + (Math.random() - 0.5) * 0.8);
    // Mostly carried on in the direction of the hit, some splashing back, scattered and lofted.
    const sp = severity * (0.15 + Math.random() * 0.5) * (Math.random() < 0.7 ? 1 : -0.5);
    s.v.set(
      carVel.x + dir.x * sp + (Math.random() - 0.5) * severity * 0.45,
      1 + Math.random() * severity * 0.28,
      carVel.z + dir.z * sp + (Math.random() - 0.5) * severity * 0.45,
    );
    s.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    s.spin = (Math.random() - 0.5) * 30;
    s.size = (0.03 + Math.random() * 0.1) * (0.7 + Math.min(1, severity / 30) * 0.6);
    this.shards.setColorAt(i, color);
    this.shards.instanceColor.needsUpdate = true;
  }

  update(dt) {
    dt = Math.min(dt, 1 / 30);
    let dirty = false;
    for (let i = 0; i < SHARD_POOL; i++) {
      const s = this.shardState[i];
      if (s.life <= 0) continue;
      dirty = true;
      s.life -= dt;
      s.v.y -= GRAVITY * dt;
      s.p.addScaledVector(s.v, dt);
      if (s.p.y < s.size) {
        s.p.y = s.size;
        s.v.y *= -0.25;
        const f = Math.exp(-4 * dt);
        s.v.x *= f;
        s.v.z *= f;
        s.spin *= f;
      }
      s.r.premultiply(q.setFromAxisAngle(s.axis, s.spin * dt));
      const size = s.life > 0 ? s.size * Math.min(1, s.life) : 0;
      this.shards.setMatrixAt(i, m4.compose(s.p, s.r, shardScale.setScalar(size)));
    }
    if (dirty) this.shards.instanceMatrix.needsUpdate = true;
  }

  clear() {
    for (const pool of Object.values(this.pools)) for (const rig of pool) if (rig.inUse) this.release(rig);
    for (const s of this.shardState) s.life = 0;
    for (let i = 0; i < SHARD_POOL; i++) this.shards.setMatrixAt(i, m4.makeScale(0, 0, 0));
    this.shards.instanceMatrix.needsUpdate = true;
  }
}
