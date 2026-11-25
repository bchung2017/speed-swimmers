import { buildTrafficVehicle } from './car.js';
import { LANES, laneX, mulberry } from './world.js';

const COUNT = 64;
const AHEAD = 700; // traffic exists from player.z - AHEAD ...
const BEHIND = 160; // ... to player.z + BEHIND
const LANE_CHANGE_TIME = 2.2;

export class Traffic {
  constructor(scene) {
    this.rng = mulberry(1337);
    this.cars = [];
    for (let i = 0; i < COUNT; i++) {
      const v = buildTrafficVehicle(this.rng);
      scene.add(v.group);
      this.cars.push({ ...v, lane: 0, x: 0, z: 0, speed: 0, cruise: 0, fromX: 0, toX: 0, laneT: 1, nextChange: 0 });
    }
  }

  reset(player) {
    const placed = [];
    for (const c of this.cars) {
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
  }

  #place(c, lane, z) {
    c.lane = lane;
    c.x = c.fromX = c.toX = laneX(lane);
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

  // Nearest vehicle ahead (smaller z) whose lane span overlaps x.
  #leader(c, player) {
    let best = null;
    let bestGap = Infinity;
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
        best = Math.max(0, player.forwardSpeed);
      }
    }
    return { gap: bestGap, speed: best };
  }

  update(dt, player) {
    for (const c of this.cars) {
      // Car following.
      const { gap, speed: leadSpeed } = this.#leader(c, player);
      const safe = 8 + c.speed * 1.1;
      let target = c.cruise;
      if (gap < safe) target = Math.max(0, Math.min(target, leadSpeed * (gap / safe)));
      const accel = target > c.speed ? 3 : 9;
      c.speed += Math.sign(target - c.speed) * Math.min(Math.abs(target - c.speed), accel * dt);
      c.braking = target < c.speed - 0.5 || gap < safe * 0.6;
      c.z -= c.speed * dt;

      // Occasional lane changes into a clear adjacent lane.
      c.nextChange -= dt;
      if (c.laneT >= 1 && c.nextChange <= 0) {
        c.nextChange = 6 + this.rng() * 14;
        const dir = this.rng() < 0.5 ? -1 : 1;
        const lane = c.lane + dir;
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
          c.toLane = undefined;
        }
      }

      // Recycle out-of-range vehicles: ahead normally, behind when the player is slower than traffic.
      const rel = c.z - player.z;
      if (rel > BEHIND || rel < -AHEAD - 50) {
        const spawnBehind = player.forwardSpeed < 22;
        for (let tries = 0; tries < 10; tries++) {
          const lane = Math.floor(this.rng() * LANES);
          const z = spawnBehind
            ? player.z + BEHIND - 10 - this.rng() * 40
            : player.z - AHEAD + this.rng() * 250;
          if (this.#laneFree(lane, z, 20)) {
            this.#place(c, lane, z);
            break;
          }
        }
      }

      const dx = c.laneT < 1 ? (c.toX - c.fromX) * 6 * c.laneT * (1 - c.laneT) / LANE_CHANGE_TIME : 0;
      c.group.position.set(c.x, 0, c.z);
      c.group.rotation.y = -Math.atan2(dx, c.speed + 0.01);
      c.tail.emissiveIntensity = c.braking ? 3.5 : 0.8;
      for (const w of c.wheels) w.userData.spin.rotation.x -= (c.speed * dt) / 0.36;
    }
  }
}
