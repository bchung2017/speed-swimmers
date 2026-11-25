import * as THREE from 'three';
import { buildPlayerCar } from './car.js';
import { resolveImpulse } from './physics.js';
import { ROAD_HALF, laneX } from './world.js';

const MAX_SPEED = 100; // engine cutoff; drag limits top speed to ~295 km/h
const MAX_REVERSE = 9;
const ENGINE = 11; // m/s^2 at standstill, tapers to 0 at MAX_SPEED
const BRAKE = 100;
const GRIP = 7; // lateral velocity decay rate (1/s)
const STEER_RATE = 2.7; // rad/s at low speed
const STEER_FALLOFF = 30; // speed (m/s) at which steering authority halves
const STEER_ASSIST = 0.8; // rate (1/s) the heading self-centers toward the road when not steering
const SIDES = [-1, 1];

// Crashes at or above this closing speed (m/s, ~58 km/h) reduce control for a short time.
// Below it, bumps and scrapes only push the car around.
export const LOSS_OF_CONTROL = 16;
// Reduced-control window: CRASH_BASE s at the threshold, +1 s per CRASH_PER_SECOND m/s above it,
// capped at CRASH_MAX s. Control starts at CRASH_CONTROL and recovers linearly to full.
const CRASH_BASE = 0.5;
const CRASH_PER_SECOND = 25;
const CRASH_MAX = 1.6;
const CRASH_CONTROL = 0.35;
// While control is reduced, the tyres also behave more physically: sliding sideways scrubs speed
// (Coulomb friction) and momentum keeps its direction rather than swinging round with the car.
const CRASH_SIDE_FRICTION = 8; // m/s^2
const CRASH_ROLL_FRICTION = 2; // m/s^2
// Rotational inertia multiplier: >1 makes impacts spin the car less violently than a uniform box.
const INERTIA_SCALE = 2;

// The barrier is an immovable body: zero inverse mass and inertia.
const WALL = { x: 0, z: 0, vx: 0, vz: 0, w: 0, invM: 0, invI: 0 };
const wallContact = { depth: 0, nx: 0, nz: 0, px: 0, pz: 0 };
const wrapAngle = (a) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));

export class Player {
  constructor(scene) {
    const v = buildPlayerCar();
    this.group = v.group;
    this.wheels = v.wheels;
    this.tail = v.tail;
    this.length = v.length;
    this.width = v.width;
    this.invM = 1;
    this.invI = 12 / (INERTIA_SCALE * (this.length ** 2 + this.width ** 2));
    this.root = new THREE.Group();
    this.root.add(this.group);
    scene.add(this.root);

    // Headlight cone. No distance falloff (decay 0, range-limited instead): with inverse-square
    // falloff, anything right in front of the bumper (e.g. a barrier during a spin) blows out to a
    // white blob. Intensity matches what the road received at ~30 m under the old falloff.
    const head = new THREE.SpotLight(0xdff6ff, 3.5, 110, 0.4, 0.5, 0);
    head.position.set(0, 0.7, -2.0);
    head.target.position.set(0, 0, -30);
    this.root.add(head, head.target);
    this.headlight = head;
    this.group.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });

    // Red underglow pooled on the road around the car.
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,24,32,0.95)');
    grd.addColorStop(0.55, 'rgba(255,24,32,0.45)');
    grd.addColorStop(1, 'rgba(255,24,32,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    const glowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 6.0).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(c),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0.45,
      }),
    );
    glowPlane.position.set(0, 0.03, 0);
    this.root.add(glowPlane);

    // Scratch vectors, reused every step to avoid per-frame allocation.
    this.vel = new THREE.Vector2();
    this._f = new THREE.Vector2();
    this._r = new THREE.Vector2();
    this._body = { x: 0, z: 0, vx: 0, vz: 0, w: 0, invM: this.invM, invI: this.invI };
    this.reset();
  }

  setHeadlights(on) {
    this.headlight.visible = on;
  }

  reset() {
    this.x = laneX(2);
    this.z = 0;
    this.heading = 0;
    this.prevX = this.x;
    this.prevZ = this.z;
    this.prevHeading = 0;
    this.renderX = this.x;
    this.renderZ = this.z;
    this.renderHeading = 0;
    this.steer = 0;
    this.spin = 0; // yaw rate from collisions (rad/s), on top of steering
    this.vel.set(0, -27);
    this.impact = 0;
    this.lockout = 0;
    this.lockoutTotal = 1;
    this.pitch = 0;
    this.accel = 0;
  }

  // Note: both return a shared vector that is overwritten on the next call.
  get forward() {
    return this._f.set(-Math.sin(this.heading), -Math.cos(this.heading));
  }

  get right() {
    return this._r.set(Math.cos(this.heading), -Math.sin(this.heading));
  }

  get forwardSpeed() {
    return this.vel.dot(this.forward);
  }

  get outOfControl() {
    return this.lockout > 0;
  }

  update(dt, rawInput) {
    this.prevX = this.x;
    this.prevZ = this.z;
    this.prevHeading = this.heading;

    const crashed = this.lockout > 0;
    // 1 = full control; after a crash starts at CRASH_CONTROL and recovers over the window.
    const control = crashed ? CRASH_CONTROL + (1 - CRASH_CONTROL) * (1 - this.lockout / this.lockoutTotal) : 1;
    if (crashed) this.lockout = Math.max(0, this.lockout - dt);
    const input = rawInput;

    const f = this.forward;
    const r = this.right;
    let fwd = this.vel.dot(f);
    let lat = this.vel.dot(r);
    const f0x = f.x;
    const f0z = f.y;
    const r0x = r.x;
    const r0z = r.y;

    // Steering input smoothing.
    const s = input.steer * control;
    const rate = s !== 0 && Math.sign(s) !== Math.sign(this.steer) ? 10 : 6;
    this.steer += THREE.MathUtils.clamp(s - this.steer, -rate * dt, rate * dt);

    // Longitudinal.
    let accel = 0;
    if (input.throttle) accel += fwd >= 0 ? ENGINE * (1 - fwd / MAX_SPEED) : BRAKE;
    if (input.brake) accel -= fwd > 0.5 ? BRAKE : fwd > -MAX_REVERSE ? ENGINE * 0.5 : 0;
    accel -= Math.sign(fwd) * (0.6 + 0.0002 * fwd * fwd); // rolling + air drag
    if (!input.throttle && !input.brake && Math.abs(fwd) < 0.3) fwd = 0;
    fwd += accel * (accel > 0 ? control : 1) * dt;
    if (crashed) fwd -= Math.sign(fwd) * Math.min(Math.abs(fwd), CRASH_ROLL_FRICTION * dt);

    // Yaw: steering (full authority at low speed, softer at high speed) plus collision spin.
    const auth = Math.min(1, Math.abs(fwd) / 5) / (1 + Math.abs(fwd) / STEER_FALLOFF);
    this.heading += (this.steer * STEER_RATE * auth * Math.sign(fwd || 1) + this.spin) * dt;
    this.spin *= Math.exp(-(crashed ? 1.5 : 6) * dt);
    // Gentle self-centering toward the road direction when cruising roughly straight. Only near
    // straight and only at speed: it must never swing a spun-out or stopped car around.
    if (!crashed && input.steer === 0 && fwd > 5 && Math.abs(this.heading) < 0.5) {
      this.heading -= this.heading * Math.min(1, STEER_ASSIST * dt * Math.min(1, fwd / 20));
    }
    this.heading = wrapAngle(this.heading);

    // Grip: bleed off sideways velocity (this is what gives the slide). Reduced while recovering
    // from a crash, plus physical side scrub.
    lat *= Math.exp(-GRIP * control * dt);
    if (crashed) lat -= Math.sign(lat) * Math.min(Math.abs(lat), CRASH_SIDE_FRICTION * dt);

    if (crashed) {
      // Momentum keeps its direction: rebuild velocity in the frame it was measured in.
      this.vel.set(f0x * fwd + r0x * lat, f0z * fwd + r0z * lat);
    } else {
      // Arcade grip: velocity follows the car's new heading.
      const nf = this.forward;
      const nr = this.right;
      this.vel.set(nf.x * fwd + nr.x * lat, nf.y * fwd + nr.y * lat);
    }
    this.x += this.vel.x * dt;
    this.z += this.vel.y * dt;

    this.accel = accel;
    this.#barriers(dt);
    this.impact = Math.max(0, this.impact - dt * 2);
  }

  // Called with the crash severity (closing speed, m/s) after a collision step.
  hit(severity) {
    this.impact = Math.max(this.impact, Math.min(1, severity / 25));
    if (severity >= LOSS_OF_CONTROL) {
      const t = Math.min(CRASH_MAX, CRASH_BASE + (severity - LOSS_OF_CONTROL) / CRASH_PER_SECOND);
      if (t > this.lockout) {
        this.lockout = t;
        this.lockoutTotal = t;
      }
    }
  }

  obb(out) {
    out.x = this.x;
    out.z = this.z;
    out.h = this.heading;
    out.hw = this.width / 2;
    out.hl = this.length / 2;
    return out;
  }

  body() {
    const b = this._body;
    b.x = this.x;
    b.z = this.z;
    b.vx = this.vel.x;
    b.vz = this.vel.y;
    b.w = this.spin;
    return b;
  }

  setBody(b) {
    this.vel.set(b.vx, b.vz);
    this.spin = b.w;
  }

  // Barriers: the car's deepest corner is pushed out and an impulse is applied against an immovable
  // wall at that corner. Spin and scraping come out of the impulse (no heading snapping), and a hard
  // enough hit counts as a crash like any other.
  #barriers(dt) {
    const hw = this.width / 2;
    const hl = this.length / 2;
    const fx = -Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const rx = Math.cos(this.heading);
    const rz = -Math.sin(this.heading);
    const limit = ROAD_HALF - 0.05;
    for (const side of SIDES) {
      let depth = 0;
      let cx = 0;
      let cz = 0;
      for (const a of SIDES) {
        for (const b of SIDES) {
          const px = this.x + rx * hw * a + fx * hl * b;
          const pen = side * px - limit;
          if (pen > depth) {
            depth = pen;
            cx = px;
            cz = this.z + rz * hw * a + fz * hl * b;
          }
        }
      }
      if (depth <= 0) continue;
      this.x -= side * depth;
      wallContact.nx = -side;
      wallContact.nz = 0;
      wallContact.px = cx - side * depth;
      wallContact.pz = cz;
      const body = this.body();
      const severity = resolveImpulse(body, WALL, wallContact, 0.15, 0.3);
      this.setBody(body);
      this.vel.multiplyScalar(Math.exp(-0.4 * dt)); // light scrape
      if (severity > 0) this.hit(severity);
    }
  }

  // Interpolate between the last two physics steps for smooth rendering.
  sync(dt, alpha) {
    this.renderX = this.prevX + (this.x - this.prevX) * alpha;
    this.renderZ = this.prevZ + (this.z - this.prevZ) * alpha;
    // Shortest-path interpolation: heading wraps at ±π.
    this.renderHeading = this.prevHeading + wrapAngle(this.heading - this.prevHeading) * alpha;
    this.root.position.set(this.renderX, 0, this.renderZ);
    this.root.rotation.y = this.renderHeading;
    // Body roll and pitch for weight transfer.
    const fwd = this.forwardSpeed;
    this.group.rotation.z = THREE.MathUtils.lerp(this.group.rotation.z, -this.steer * Math.min(1, fwd / 40) * 0.05, 0.1);
    this.pitch = THREE.MathUtils.lerp(this.pitch, THREE.MathUtils.clamp(-this.accel * 0.004, -0.05, 0.03), 0.1);
    this.group.rotation.x = this.pitch;
    this.tail.color.setScalar(this.accel < -3 ? 2 : 0.4);
    const roll = (fwd * dt) / 0.34;
    this.wheels.forEach((w, i) => {
      w.userData.spin.rotation.x -= roll;
      if (i < 2) w.rotation.y = this.steer * 0.35;
    });
  }
}
