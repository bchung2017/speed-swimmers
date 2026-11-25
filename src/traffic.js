import * as THREE from 'three';
import { buildTrafficFleet, TRAFFIC_COLORS } from './car.js';
import { LANES, laneX, mulberry } from './world.js';

const FLEET = { sedan: 38, suv: 18, truck: 8 };
const AHEAD = 700; // traffic exists from player.z - AHEAD ...
const BEHIND = 160; // ... to player.z + BEHIND
const LANE_CHANGE_TIME = 2.2;

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const pos = new THREE.Vector3();
const one = new THREE.Vector3(1, 1, 1);
const up = new THREE.Vector3(0, 1, 0);
const col = new THREE.Color();
const TAIL_ON = new THREE.Color().setScalar(3.5);
const TAIL_OFF = new THREE.Color().setScalar(0.8);

export class Traffic {
  constructor(scene) {
    this.rng = mulberry(1337);
    this.fleet = buildTrafficFleet(scene, FLEET);
    this.cars = [];
    for (const [type, f] of Object.entries(this.fleet)) {
      for (let idx = 0; idx < f.count; idx++) {
        this.cars.push({
          type,
          idx,
          meshes: f.meshes,
          length: f.length,
          width: f.width,
          lane: 0,
          x: 0,
          z: 0,
          speed: 0,
          cruise: 0,
          fromX: 0,
          toX: 0,
          toLane: -1,
          laneT: 1,
          nextChange: 0,
          braking: false,
          wasBraking: null,
        });
        if (type !== 'truck') {
          f.meshes.paint.setColorAt(idx, col.set(TRAFFIC_COLORS[Math.floor(this.rng() * TRAFFIC_COLORS.length)]));
        }
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
    const placed = [];
    for (const c of this.cars) {
      c.z = 1e9; // parked far away until placed
      for (let tries = 0; tries < 50; tries++) {
        const lane = Math.floor(this.rng() * LANES);
        const z = player.z + BEHIND - this.rng() * (AHEAD + BEHIND);
        const nearPlayer = Math.abs(laneX(lane) - player.x) < 3 && Math.abs(z - player.z) < 35;
        if (!nearPlayer && this.#laneFree(lane, z, 18, placed)) {
          this.#place(c, lane, z);
          placed.push(c);
          break;
        }
      }
    }
    this.sync();
  }

  #place(c, lane, z) {
    c.lane = lane;
    c.x = c.fromX = c.toX = laneX(lane);
    c.toLane = -1;
    c.laneT = 1;
    c.z = z;
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

  // Sets this.leadGap / this.leadSpeed for the nearest vehicle ahead whose lane span overlaps c.
  #leader(c, player, playerFwd) {
    let bestGap = Infinity;
    let best = 0;
    for (const o of this.cars) {
      if (o === c || Math.abs(o.x - c.x) > 2.6) continue;
      const gap = c.z - o.z - (c.length + o.length) / 2;
      if (gap > -1 && gap < bestGap) {
        bestGap = gap;
        best = o.speed;
      }
    }
    if (Math.abs(player.x - c.x) < 2.6) {
      const gap = c.z - player.z - (c.length + player.length) / 2;
      if (gap > -1 && gap < bestGap) {
        bestGap = gap;
        best = Math.max(0, playerFwd);
      }
    }
    this.leadGap = bestGap;
    this.leadSpeed = best;
  }

  update(dt, player) {
    const playerFwd = player.forwardSpeed;
    for (const c of this.cars) {
      // Car following.
      this.#leader(c, player, playerFwd);
      const gap = this.leadGap;
      const safe = 8 + c.speed * 1.1;
      let target = c.cruise;
      if (gap < safe) target = Math.max(0, Math.min(target, this.leadSpeed * (gap / safe)));
      const accel = target > c.speed ? 3 : 9;
      c.speed += Math.sign(target - c.speed) * Math.min(Math.abs(target - c.speed), accel * dt);
      c.braking = target < c.speed - 0.5 || gap < safe * 0.6;
      c.z -= c.speed * dt;

      // Occasional lane changes into a clear adjacent lane.
      c.nextChange -= dt;
      if (c.laneT >= 1 && c.nextChange <= 0) {
        c.nextChange = 6 + this.rng() * 14;
        const lane = c.lane + (this.rng() < 0.5 ? -1 : 1);
        const playerClear = Math.abs(player.x - laneX(lane)) > 3 || Math.abs(player.z - c.z) > 30;
        if (lane >= 0 && lane < LANES && playerClear && this.#laneFree(lane, c.z, 14)) {
          c.fromX = c.x;
          c.toX = laneX(lane);
          c.toLane = lane;
          c.laneT = 0;
        }
      }
      if (c.laneT < 1) {
        c.laneT = Math.min(1, c.laneT + dt / LANE_CHANGE_TIME);
        const s = c.laneT * c.laneT * (3 - 2 * c.laneT);
        c.x = c.fromX + (c.toX - c.fromX) * s;
        if (c.laneT >= 1) {
          c.lane = c.toLane;
          c.toLane = -1;
        }
      }

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

  // Push transforms and brake-light state to the instanced meshes (once per rendered frame).
  sync() {
    for (const c of this.cars) {
      const dx = c.laneT < 1 ? ((c.toX - c.fromX) * 6 * c.laneT * (1 - c.laneT)) / LANE_CHANGE_TIME : 0;
      q.setFromAxisAngle(up, -Math.atan2(dx, c.speed + 0.01));
      m4.compose(pos.set(c.x, 0, c.z), q, one);
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
