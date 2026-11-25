import * as THREE from 'three';
import { buildTrafficFleet, TRAFFIC_COLORS } from './car.js';
import { obbContact, resolveImpulse } from './physics.js';
import { LANES, LANE_W, ROAD_HALF, laneX, mulberry } from './world.js';

const FLEET = { sedan: 38, suv: 18, truck: 8 };
const AHEAD = 700; // traffic exists from player.z - AHEAD ...
const BEHIND = 160; // ... to player.z + BEHIND
const LANE_CHANGE_TIME = 2.2;

// Mass relative to the player car (1.0). Traffic is deliberately light so the player can shove it.
const MASS = { sedan: 0.35, suv: 0.5, truck: 1.4 };
// Closing speeds (m/s) that trigger damage stages.
const DENT_SEVERITY = 2.5; // swap in the fractured rig and dent it
const WRECK_SEVERITY = 7; // the car loses its lane and becomes a sliding wreck
// Fractured rigs are staged on cars within this distance of the player, ready for an instant swap.
const STAGE_RANGE = 70;
const STAGE_MAX = 12;

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const pos = new THREE.Vector3();
const one = new THREE.Vector3(1, 1, 1);
const zero = new THREE.Vector3(0, 0, 0);
const up = new THREE.Vector3(0, 1, 0);
const local = new THREE.Vector3();
const push = new THREE.Vector3();
const worldPush = new THREE.Vector3();
const carVel = new THREE.Vector3();
const TAIL_ON = new THREE.Color().setScalar(2.2);
const TAIL_OFF = new THREE.Color().setScalar(0.6);

const obbA = { x: 0, z: 0, h: 0, hw: 0, hl: 0 };
const obbB = { x: 0, z: 0, h: 0, hw: 0, hl: 0 };
const bodyB = { x: 0, z: 0, vx: 0, vz: 0, w: 0, invM: 0, invI: 0 };

export class Traffic {
  constructor(scene, wreckage) {
    this.rng = mulberry(1337);
    this.wreckage = wreckage;
    this.fleet = buildTrafficFleet(scene, FLEET);
    this.cars = [];
    for (const [type, f] of Object.entries(this.fleet)) {
      const mass = MASS[type];
      for (let idx = 0; idx < f.count; idx++) {
        const color = new THREE.Color(type === 'truck' ? 0xffffff : TRAFFIC_COLORS[Math.floor(this.rng() * TRAFFIC_COLORS.length)]);
        this.cars.push({
          type,
          idx,
          color,
          meshes: f.meshes,
          length: f.length,
          width: f.width,
          invM: 1 / mass,
          invI: 12 / (mass * (f.length ** 2 + f.width ** 2)),
          lane: 0,
          baseX: 0,
          x: 0,
          z: 0,
          heading: 0,
          px: 0,
          pz: 0,
          ph: 0,
          speed: 0,
          cruise: 0,
          fromX: 0,
          toX: 0,
          toLane: -1,
          laneT: 1,
          nextChange: 0,
          offX: 0,
          offV: 0,
          braking: false,
          wasBraking: null,
          wreck: false,
          vx: 0,
          vz: 0,
          w: 0,
          rig: null,
          rigActive: false,
        });
        if (type !== 'truck') f.meshes.paint.setColorAt(idx, color);
        f.meshes.tail.setColorAt(idx, TAIL_OFF);
      }
    }
    // Shuffle so spawn order mixes vehicle types.
    for (let i = this.cars.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.cars[i], this.cars[j]] = [this.cars[j], this.cars[i]];
    }
  }

  reset(player) {
    this.wreckage.clear();
    const placed = [];
    for (const c of this.cars) {
      c.rig = null;
      c.rigActive = false;
      c.z = 1e9; // parked far away until placed
      for (let tries = 0; tries < 50; tries++) {
        const lane = Math.floor(this.rng() * LANES);
        const z = player.z + BEHIND - this.rng() * (AHEAD + BEHIND);
        const nearPlayer = Math.abs(laneX(lane) - player.x) < LANE_W * 0.8 && Math.abs(z - player.z) < 35;
        if (!nearPlayer && this.#laneFree(lane, z, 18, placed)) {
          this.#place(c, lane, z);
          placed.push(c);
          break;
        }
      }
    }
    this.sync(1, player);
  }

  #place(c, lane, z) {
    if (c.rig) this.wreckage.release(c.rig);
    c.rig = null;
    c.rigActive = false;
    c.wreck = false;
    c.lane = lane;
    c.baseX = c.x = c.fromX = c.toX = laneX(lane);
    c.offX = c.offV = 0;
    c.toLane = -1;
    c.laneT = 1;
    c.z = z;
    c.heading = 0;
    c.px = c.x;
    c.pz = c.z;
    c.ph = 0;
    c.cruise = c.type === 'truck' ? 21 + this.rng() * 4 : 24 + this.rng() * 12;
    c.speed = c.cruise;
    c.nextChange = 4 + this.rng() * 14;
    c.braking = false;
  }

  #laneFree(lane, z, gap, list = this.cars) {
    for (const o of list) {
      if ((o.lane === lane || o.toLane === lane) && Math.abs(o.z - z) < gap + o.length) return false;
    }
    return true;
  }

  // Sets leadGap / leadSpeed / leadWreck for the nearest vehicle ahead whose lane span overlaps c.
  #leader(c, player, playerFwd) {
    let bestGap = Infinity;
    let best = 0;
    let wreck = false;
    const span = LANE_W * 0.7;
    for (const o of this.cars) {
      if (o === c || Math.abs(o.x - c.x) > span) continue;
      const gap = c.z - o.z - (c.length + o.length) / 2;
      if (gap > -1 && gap < bestGap) {
        bestGap = gap;
        best = o.speed;
        wreck = o.wreck;
      }
    }
    if (Math.abs(player.x - c.x) < span) {
      const gap = c.z - player.z - (c.length + player.length) / 2;
      if (gap > -1 && gap < bestGap) {
        bestGap = gap;
        best = Math.max(0, playerFwd);
        wreck = false;
      }
    }
    this.leadGap = bestGap;
    this.leadSpeed = best;
    this.leadWreck = wreck;
  }

  update(dt, player) {
    const playerFwd = player.forwardSpeed;
    for (const c of this.cars) {
      c.px = c.x;
      c.pz = c.z;
      c.ph = c.heading;
      if (c.wreck) this.#updateWreck(c, dt);
      else this.#updateLane(c, dt, player, playerFwd);

      // Recycle out-of-range vehicles: ahead normally, behind when the player is slower than traffic.
      const rel = c.z - player.z;
      if (rel > BEHIND || rel < -AHEAD - 50) {
        const spawnBehind = playerFwd < 22;
        for (let tries = 0; tries < 10; tries++) {
          const lane = Math.floor(this.rng() * LANES);
          const z = spawnBehind ? player.z + BEHIND - 10 - this.rng() * 40 : player.z - AHEAD + this.rng() * 250;
          if (this.#laneFree(lane, z, 20)) {
            this.#place(c, lane, z);
            break;
          }
        }
      }
    }
  }

  #updateLane(c, dt, player, playerFwd) {
    this.#leader(c, player, playerFwd);
    const gap = this.leadGap;
    const safe = 8 + c.speed * 1.1;
    let target = c.cruise;
    if (gap < safe) target = Math.max(0, Math.min(target, this.leadSpeed * (gap / safe)));
    const accel = target > c.speed ? 3 : gap < safe * 0.4 ? 16 : 9;
    c.speed += Math.sign(target - c.speed) * Math.min(Math.abs(target - c.speed), accel * dt);
    c.braking = target < c.speed - 0.5 || gap < safe * 0.6;
    c.z -= c.speed * dt;

    // Lane changes: occasional, or immediately to get around a wreck.
    c.nextChange -= dt;
    if (this.leadWreck && gap < 80 && c.nextChange > 0.3) c.nextChange = 0;
    if (c.laneT >= 1 && c.nextChange <= 0) {
      c.nextChange = 6 + this.rng() * 14;
      const lane = c.lane + (this.rng() < 0.5 ? -1 : 1);
      const playerClear = Math.abs(player.x - laneX(lane)) > LANE_W * 0.8 || Math.abs(player.z - c.z) > 30;
      if (lane >= 0 && lane < LANES && playerClear && this.#laneFree(lane, c.z, 14)) {
        c.fromX = c.baseX;
        c.toX = laneX(lane);
        c.toLane = lane;
        c.laneT = 0;
      }
    }
    let laneRate = 0;
    if (c.laneT < 1) {
      c.laneT = Math.min(1, c.laneT + dt / LANE_CHANGE_TIME);
      const s = c.laneT * c.laneT * (3 - 2 * c.laneT);
      c.baseX = c.fromX + (c.toX - c.fromX) * s;
      laneRate = ((c.toX - c.fromX) * 6 * c.laneT * (1 - c.laneT)) / LANE_CHANGE_TIME;
      if (c.laneT >= 1) {
        c.lane = c.toLane;
        c.toLane = -1;
      }
    }

    // Lateral shove from light hits springs back to the lane.
    c.offV += (-10 * c.offX - 5 * c.offV) * dt;
    c.offX += c.offV * dt;
    c.x = c.baseX + c.offX;
    c.heading = -Math.atan2(laneRate + c.offV, c.speed + 0.01);
  }

  #updateWreck(c, dt) {
    // Sliding, spinning, tyre-scrubbing to a stop.
    const sp = Math.hypot(c.vx, c.vz);
    if (sp > 0) {
      const k = Math.max(0, sp - 7 * dt) / sp;
      c.vx *= k;
      c.vz *= k;
    }
    c.w *= Math.exp(-1.5 * dt);
    c.x += c.vx * dt;
    c.z += c.vz * dt;
    c.heading += c.w * dt;
    const ext = Math.abs(Math.cos(c.heading)) * (c.width / 2) + Math.abs(Math.sin(c.heading)) * (c.length / 2);
    const lim = ROAD_HALF - ext;
    if (Math.abs(c.x) > lim) {
      c.x = Math.sign(c.x) * lim;
      if (Math.sign(c.vx) === Math.sign(c.x)) c.vx *= -0.3;
      c.w *= 0.7;
    }
    c.speed = Math.max(0, -c.vz);
    c.lane = Math.max(0, Math.min(LANES - 1, Math.round((c.x - laneX(0)) / LANE_W)));
    c.braking = true;
  }

  // Player vs traffic. Returns the highest crash severity this step (closing speed, m/s).
  collide(player) {
    let worst = 0;
    player.obb(obbA);
    for (const c of this.cars) {
      if (Math.abs(c.z - player.z) > 14 || Math.abs(c.x - player.x) > 8) continue;
      obbB.x = c.x;
      obbB.z = c.z;
      obbB.h = c.heading;
      obbB.hw = c.width / 2;
      obbB.hl = c.length / 2;
      const ct = obbContact(obbA, obbB);
      if (!ct) continue;

      // Push apart in proportion to inverse mass.
      const share = 1 / (1 + c.invM);
      player.x += ct.nx * ct.depth * share;
      player.z += ct.nz * ct.depth * share;
      const back = ct.depth * (1 - share);
      if (c.wreck) {
        c.x -= ct.nx * back;
        c.z -= ct.nz * back;
      } else {
        c.offX -= ct.nx * back;
        c.z -= ct.nz * back;
      }
      obbA.x = player.x;
      obbA.z = player.z;

      const lateral = c.wreck ? c.vx : c.offV;
      bodyB.x = c.x;
      bodyB.z = c.z;
      bodyB.vx = lateral;
      bodyB.vz = c.wreck ? c.vz : -c.speed;
      bodyB.w = c.wreck ? c.w : 0;
      bodyB.invM = c.invM;
      bodyB.invI = c.invI;
      const body = player.body();
      const severity = resolveImpulse(body, bodyB, ct);
      player.setBody(body);

      if (c.wreck || severity >= WRECK_SEVERITY) {
        c.wreck = true;
        c.vx = bodyB.vx;
        c.vz = bodyB.vz;
        c.w = bodyB.w;
      } else {
        c.speed = Math.max(0, -bodyB.vz);
        c.offV += bodyB.vx - lateral;
      }

      if (severity >= DENT_SEVERITY) this.#damage(c, ct, severity);
      worst = Math.max(worst, severity);
    }
    return worst;
  }

  #damage(c, ct, severity) {
    if (!c.rig) c.rig = this.wreckage.acquire(c.type, c.color);
    c.rigActive = true;
    const g = c.rig.group;
    g.visible = true;
    g.position.set(c.x, 0, c.z);
    g.rotation.set(0, c.heading, 0);
    // Contact point and dent direction (into the car, away from the player) in the car's frame.
    const cos = Math.cos(c.heading);
    const sin = Math.sin(c.heading);
    const dx = ct.px - c.x;
    const dz = ct.pz - c.z;
    local.set(dx * cos - dz * sin, 0.7, dx * sin + dz * cos);
    push.set(-ct.nx * cos + ct.nz * sin, 0, -ct.nx * sin - ct.nz * cos);
    worldPush.set(-ct.nx, 0, -ct.nz);
    carVel.set(c.wreck ? c.vx : c.offV, 0, c.wreck ? c.vz : -c.speed);
    this.wreckage.impact(c.rig, local, push, worldPush, carVel, severity);
  }

  // Push interpolated transforms, brake lights and staged rigs to the GPU (once per rendered frame).
  sync(alpha, player) {
    let staged = 0;
    for (const c of this.cars) if (c.rig && !c.rigActive) staged++;

    for (const c of this.cars) {
      const x = c.px + (c.x - c.px) * alpha;
      const z = c.pz + (c.z - c.pz) * alpha;
      const h = c.ph + (c.heading - c.ph) * alpha;

      // Stage a fractured rig on nearby cars so a crash can swap it in instantly; free it when far.
      const near = Math.abs(c.z - player.z) < STAGE_RANGE;
      if (!c.rigActive) {
        if (near && !c.rig && staged < STAGE_MAX) {
          c.rig = this.wreckage.acquire(c.type, c.color);
          staged++;
        } else if (!near && c.rig) {
          this.wreckage.release(c.rig);
          c.rig = null;
          staged--;
        }
      }

      if (c.rigActive) {
        c.rig.group.position.set(x, 0, z);
        c.rig.group.rotation.set(0, h, 0);
        m4.compose(pos.set(x, -50, z), q, zero);
      } else {
        q.setFromAxisAngle(up, h);
        m4.compose(pos.set(x, 0, z), q, one);
      }
      for (const layer in c.meshes) c.meshes[layer].setMatrixAt(c.idx, m4);
      if (c.braking !== c.wasBraking) {
        c.meshes.tail.setColorAt(c.idx, c.braking ? TAIL_ON : TAIL_OFF);
        c.meshes.tail.instanceColor.needsUpdate = true;
        c.wasBraking = c.braking;
      }
    }
    for (const type in this.fleet) {
      const meshes = this.fleet[type].meshes;
      for (const layer in meshes) meshes[layer].instanceMatrix.needsUpdate = true;
    }
  }
}
