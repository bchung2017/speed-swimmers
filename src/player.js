import * as THREE from 'three';
import { buildPlayerCar } from './car.js';
import { ROAD_HALF, laneX } from './world.js';

const MAX_SPEED = 100; // engine cutoff; drag limits top speed to ~295 km/h
const MAX_REVERSE = 9;
const ENGINE = 11; // m/s^2 at standstill, tapers to 0 at MAX_SPEED
const BRAKE = 22;
const GRIP = 7; // lateral velocity decay rate (1/s)
const STEER_RATE = 1.9; // rad/s at low speed
const STEER_FALLOFF = 30; // speed (m/s) at which steering authority halves
const SIDES = [-1, 1];

// Losing control: crashes at or above this closing speed (m/s, ~58 km/h) take the wheel away.
// Below it, bumps and scrapes only push the car around.
export const LOSS_OF_CONTROL = 16;
const CRASH_GRIP = 0.8; // sideways grip while out of control: the car slides on its momentum
const CRASH_SCRUB = 4; // m/s^2 of tyre scrub while sliding

const NO_INPUT = { throttle: 0, brake: 0, steer: 0 };

export class Player {
  constructor(scene) {
    const v = buildPlayerCar();
    this.group = v.group;
    this.wheels = v.wheels;
    this.tail = v.tail;
    this.length = v.length;
    this.width = v.width;
    this.invM = 1;
    this.invI = 12 / (this.length ** 2 + this.width ** 2);
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
    const input = crashed ? NO_INPUT : rawInput;
    if (crashed) this.lockout = Math.max(0, this.lockout - dt);

    const f = this.forward;
    const r = this.right;
    let fwd = this.vel.dot(f);
    let lat = this.vel.dot(r);

    // Steering input smoothing.
    const s = input.steer;
    const rate = s !== 0 && Math.sign(s) !== Math.sign(this.steer) ? 10 : 6;
    this.steer += THREE.MathUtils.clamp(s - this.steer, -rate * dt, rate * dt);

    // Longitudinal.
    let accel = 0;
    if (input.throttle) accel += fwd >= 0 ? ENGINE * (1 - fwd / MAX_SPEED) : BRAKE;
    if (input.brake) accel -= fwd > 0.5 ? BRAKE : fwd > -MAX_REVERSE ? ENGINE * 0.5 : 0;
    accel -= Math.sign(fwd) * (0.6 + 0.0002 * fwd * fwd + (crashed ? CRASH_SCRUB : 0)); // rolling + air drag
    if (!input.throttle && !input.brake && Math.abs(fwd) < 0.3) fwd = 0;
    fwd += accel * dt;

    // Yaw: steering (full authority at low speed, softer at high speed) plus collision spin.
    const auth = Math.min(1, Math.abs(fwd) / 5) / (1 + Math.abs(fwd) / STEER_FALLOFF);
    this.heading += (this.steer * STEER_RATE * auth * Math.sign(fwd || 1) + this.spin) * dt;
    this.spin *= Math.exp(-(crashed ? 0.7 : 6) * dt);
    // Gentle self-centering toward the road direction when not steering.
    if (!crashed && s === 0 && fwd > 5) this.heading -= this.heading * Math.min(1, 0.8 * dt);

    // Grip: bleed off sideways velocity (this is what gives the slide).
    lat *= Math.exp(-(crashed ? CRASH_GRIP : GRIP) * dt);

    const nf = this.forward;
    const nr = this.right;
    this.vel.set(nf.x * fwd + nr.x * lat, nf.y * fwd + nr.y * lat);
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
      // Bigger crash, longer without control: 1 s at the threshold up to 3.5 s.
      this.lockout = Math.max(this.lockout, Math.min(3.5, 1 + (severity - LOSS_OF_CONTROL) / 12));
      this.steer = 0;
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

  // Half extent of the rotated car along world x.
  #extentX() {
    const c = Math.abs(Math.cos(this.heading));
    const s = Math.abs(Math.sin(this.heading));
    return c * (this.width / 2) + s * (this.length / 2);
  }

  #barriers(dt) {
    const ex = this.#extentX();
    const limit = ROAD_HALF - 0.05;
    for (const side of SIDES) {
      const over = side * this.x + ex - limit;
      if (over <= 0) continue;
      this.x -= side * over;
      if (side * this.vel.x > 0) {
        this.impact = Math.max(this.impact, Math.min(1, Math.abs(this.vel.x) / 15));
        this.vel.x = -this.vel.x * 0.25;
      }
      this.vel.multiplyScalar(Math.exp(-1.2 * dt)); // scrape
      this.spin *= Math.exp(-4 * dt);
      if (!this.outOfControl) this.heading *= Math.exp(-6 * dt); // align with the wall
    }
  }

  // Interpolate between the last two physics steps for smooth rendering.
  sync(dt, alpha) {
    this.renderX = this.prevX + (this.x - this.prevX) * alpha;
    this.renderZ = this.prevZ + (this.z - this.prevZ) * alpha;
    this.renderHeading = this.prevHeading + (this.heading - this.prevHeading) * alpha;
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
