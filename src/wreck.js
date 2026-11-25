import * as THREE from 'three';
import { trafficGeometry, trafficMats } from './car.js';
import { ROAD_HALF } from './world.js';

// Crash damage for traffic vehicles.
//
// Each vehicle type is pre-fractured once at startup: its merged geometry is cut into grid cells,
// one chunk per (cell, material layer). A "rig" is a ready-to-show group of those chunks. Rigs are
// pooled and staged on traffic cars near the player ahead of time, so on impact the instanced car
// is swapped for its rig in the same frame, dented around the contact point, and chunks + shards
// are thrown off in proportion to crash severity.

const GRID = { sedan: [2, 2, 4], suv: [2, 2, 4], truck: [2, 3, 6] };
const PREWARM = { sedan: 8, suv: 5, truck: 3 };
const MAX_DETACH = { sedan: 7, suv: 7, truck: 9 };
const SHARD_POOL = 260;
const DEBRIS_LIFE = 14;
const GRAVITY = 9.8;

const rigTailMat = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color().setScalar(0.6) });
const LAYER_MATS = { fixed: trafficMats.fixed, glow: trafficMats.glow, tail: rigTailMat };

function fracture(type) {
  const { layers, length, width } = trafficGeometry(type);
  const box = new THREE.Box3();
  for (const g of Object.values(layers)) {
    if (!g) continue;
    g.computeBoundingBox();
    box.union(g.boundingBox);
  }
  const size = box.getSize(new THREE.Vector3());
  const [nx, ny, nz] = GRID[type];
  const cell = (v, lo, span, n) => Math.min(n - 1, Math.max(0, Math.floor(((v - lo) / span) * n)));
  const chunks = [];
  for (const [layer, g] of Object.entries(layers)) {
    if (!g) continue;
    const pos = g.attributes.position.array;
    const col = g.attributes.color.array;
    const buckets = new Map();
    for (let t = 0; t < pos.length; t += 9) {
      const cx = (pos[t] + pos[t + 3] + pos[t + 6]) / 3;
      const cy = (pos[t + 1] + pos[t + 4] + pos[t + 7]) / 3;
      const cz = (pos[t + 2] + pos[t + 5] + pos[t + 8]) / 3;
      const key =
        cell(cx, box.min.x, size.x, nx) + nx * (cell(cy, box.min.y, size.y, ny) + ny * cell(cz, box.min.z, size.z, nz));
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
    for (const tris of buckets.values()) {
      const p = new Float32Array(tris.length * 9);
      const c = new Float32Array(tris.length * 9);
      tris.forEach((t, i) => {
        p.set(pos.subarray(t, t + 9), i * 9);
        c.set(col.subarray(t, t + 9), i * 9);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      geo.computeBoundingBox();
      const offset = geo.boundingBox.getCenter(new THREE.Vector3());
      geo.translate(-offset.x, -offset.y, -offset.z);
      geo.computeBoundingSphere();
      chunks.push({ layer, geometry: geo, offset, radius: geo.boundingSphere.radius });
    }
  }
  return { chunks, length, width };
}

class Rig {
  constructor(template) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.paintMat = trafficMats.paint.clone();
    this.parts = template.chunks.map((ch) => {
      const mesh = new THREE.Mesh(ch.geometry, ch.layer === 'paint' ? this.paintMat : LAYER_MATS[ch.layer]);
      mesh.position.copy(ch.offset);
      this.group.add(mesh);
      return { mesh, chunk: ch, detached: false, deformed: false };
    });
    this.inUse = false;
  }

  reset(color) {
    this.paintMat.color.copy(color);
    for (const part of this.parts) {
      if (part.detached) {
        this.group.add(part.mesh);
        part.detached = false;
      }
      if (part.deformed) {
        part.mesh.geometry.dispose();
        part.mesh.geometry = part.chunk.geometry;
        part.deformed = false;
      }
      part.mesh.visible = true;
      part.mesh.position.copy(part.chunk.offset);
      part.mesh.quaternion.identity();
      part.mesh.scale.setScalar(1);
    }
    this.group.visible = false;
  }
}

const v3 = new THREE.Vector3();
const v3b = new THREE.Vector3();
const q = new THREE.Quaternion();
const m4 = new THREE.Matrix4();
const shardScale = new THREE.Vector3();

export class Wreckage {
  constructor(scene) {
    this.scene = scene;
    this.templates = {};
    this.pools = {};
    for (const type of Object.keys(GRID)) {
      this.templates[type] = fracture(type);
      this.pools[type] = [];
      for (let i = 0; i < PREWARM[type]; i++) this.pools[type].push(this.#newRig(type));
    }
    this.debris = [];

    // Small shards: one InstancedMesh, recycled ring buffer.
    const shardGeo = new THREE.TetrahedronGeometry(1, 0);
    this.shards = new THREE.InstancedMesh(
      shardGeo,
      new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.5, metalness: 0.3 }),
      SHARD_POOL,
    );
    this.shards.frustumCulled = false;
    this.shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shardState = [];
    for (let i = 0; i < SHARD_POOL; i++) {
      this.shards.setMatrixAt(i, m4.makeScale(0, 0, 0));
      this.shards.setColorAt(i, new THREE.Color(0x888888));
      this.shardState.push({ life: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Quaternion(), axis: new THREE.Vector3(), spin: 0, size: 0 });
    }
    this.nextShard = 0;
    scene.add(this.shards);
  }

  #newRig(type) {
    const rig = new Rig(this.templates[type]);
    rig.type = type;
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
    this.debris = this.debris.filter((d) => d.rig !== rig);
    rig.reset(rig.paintMat.color);
    rig.inUse = false;
  }

  // Dent the rig around a contact point and throw off chunks + shards.
  // local: contact point in the vehicle's frame; push: unit dent direction in the vehicle's frame;
  // worldPush: same direction in world space; carVel: vehicle velocity (world); severity in m/s.
  impact(rig, local, push, worldPush, carVel, severity) {
    const radius = Math.min(2.2, 0.9 + severity * 0.04);
    const dent = Math.min(0.55, severity * 0.022);

    for (const part of rig.parts) {
      if (part.detached) continue;
      const centre = part.chunk.offset;
      if (centre.distanceTo(local) > radius + part.chunk.radius) continue;
      if (!part.deformed) {
        part.mesh.geometry = part.chunk.geometry.clone();
        part.deformed = true;
      }
      const pos = part.mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v3.fromBufferAttribute(pos, i).add(centre);
        const d = v3.distanceTo(local);
        if (d >= radius) continue;
        const k = dent * (1 - d / radius) ** 2;
        v3.addScaledVector(push, k);
        v3.x += (Math.random() - 0.5) * k * 0.5;
        v3.y += (Math.random() - 0.5) * k * 0.5;
        v3.z += (Math.random() - 0.5) * k * 0.5;
        v3.sub(centre);
        pos.setXYZ(i, v3.x, v3.y, v3.z);
      }
      pos.needsUpdate = true;
      part.mesh.geometry.computeBoundingSphere();
    }

    // Detach the chunks nearest the impact, more for harder hits.
    const count = Math.round(Math.min(1, Math.max(0, (severity - 7) / 23)) * MAX_DETACH[rig.type]);
    if (count > 0) {
      const candidates = rig.parts
        .filter((p) => !p.detached)
        .sort((a, b) => a.chunk.offset.distanceTo(local) - b.chunk.offset.distanceTo(local))
        .slice(0, count);
      rig.group.updateMatrixWorld(true);
      for (const part of candidates) {
        part.detached = true;
        this.scene.attach(part.mesh);
        const s = severity * (0.25 + Math.random() * 0.45);
        const vel = new THREE.Vector3(carVel.x, 0, carVel.z)
          .addScaledVector(worldPush, s)
          .add(v3b.set((Math.random() - 0.5) * severity * 0.3, 1.5 + Math.random() * severity * 0.22, (Math.random() - 0.5) * severity * 0.3));
        const ang = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(severity * 0.5);
        this.debris.push({ mesh: part.mesh, vel, ang, life: DEBRIS_LIFE, rig, radius: part.chunk.radius, resting: false });
      }
    }

    // Shards from the contact point, tinted like paint and glass.
    rig.group.updateMatrixWorld(true);
    const origin = v3b.copy(local).applyMatrix4(rig.group.matrixWorld);
    const n = Math.min(70, Math.round(severity * 2.2));
    for (let i = 0; i < n; i++) {
      const color = Math.random() < 0.35 ? GLASS : rig.paintMat.color;
      this.#shard(origin, worldPush, carVel, severity, color);
    }
  }

  #shard(origin, dir, carVel, severity, color) {
    const i = this.nextShard;
    this.nextShard = (i + 1) % SHARD_POOL;
    const s = this.shardState[i];
    s.life = 2.5 + Math.random() * 2.5;
    s.p.copy(origin).add(v3.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5));
    const sp = severity * (0.2 + Math.random() * 0.6);
    s.v.set(carVel.x, 0, carVel.z)
      .addScaledVector(dir, sp)
      .add(v3.set((Math.random() - 0.5) * severity * 0.5, 1 + Math.random() * severity * 0.3, (Math.random() - 0.5) * severity * 0.5));
    s.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    s.spin = (Math.random() - 0.5) * 30;
    s.size = 0.04 + Math.random() * 0.12;
    this.shards.setColorAt(i, color);
    this.shards.instanceColor.needsUpdate = true;
  }

  update(dt, playerZ) {
    dt = Math.min(dt, 1 / 30);

    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0 || d.mesh.position.z - playerZ > 250) {
        d.mesh.visible = false;
        this.debris.splice(i, 1);
        continue;
      }
      if (d.resting) continue;
      const m = d.mesh;
      d.vel.y -= GRAVITY * dt;
      m.position.addScaledVector(d.vel, dt);
      const w = d.ang.length();
      if (w > 1e-3) m.quaternion.premultiply(q.setFromAxisAngle(v3.copy(d.ang).divideScalar(w), w * dt));
      const floor = d.radius * 0.45;
      if (m.position.y < floor) {
        m.position.y = floor;
        if (d.vel.y < 0) d.vel.y *= -0.3;
        const f = Math.exp(-3 * dt);
        d.vel.x *= f;
        d.vel.z *= f;
        d.ang.multiplyScalar(Math.exp(-4 * dt));
        if (d.vel.lengthSq() < 0.05 && Math.abs(d.vel.y) < 0.3) d.resting = true;
      }
      const lim = ROAD_HALF - d.radius * 0.5;
      if (Math.abs(m.position.x) > lim) {
        m.position.x = Math.sign(m.position.x) * lim;
        d.vel.x *= -0.3;
      }
    }

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
        s.v.x *= Math.exp(-4 * dt);
        s.v.z *= Math.exp(-4 * dt);
        s.spin *= Math.exp(-4 * dt);
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

const GLASS = new THREE.Color(0x9fb8c8);
