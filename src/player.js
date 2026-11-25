import * as THREE from 'three';
import { buildPlayerCar } from './car.js';
import { ROAD_HALF, laneX } from './world.js';

const MAX_SPEED = 100; // engine cutoff; drag limits top speed to ~295 km/h
const MAX_REVERSE = 9;
const ENGINE = 11; // m/s^2 at standstill, tapers to 0 at MAX_SPEED
const BRAKE = 22;
const GRIP = 6; // lateral velocity decay rate (1/s)
const STEER_RATE = 1.3; // rad/s at low speed
const SIDES = [-1, 1];

export class Player {
  constructor(scene) {
    const v = buildPlayerCar();
    this.group = v.group;
    this.wheels = v.wheels;
    this.tail = v.tail;
    this.length = v.length;
    this.width = v.width;
    this.body = new THREE.Group();
    this.body.add(this.group);
    scene.add(this.body);

    // Headlight cone.
    const head = new THREE.SpotLight(0xdff6ff, 350, 110, 0.4, 0.5, 1.4);
    head.position.set(0, 0.7, -2.0);
    head.target.position.set(0, 0, -30);
    this.body.add(head, head.target);

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
        opacity: 0.55,
      }),
    );
    glowPlane.position.set(0, 0.03, 0);
    this.body.add(glowPlane);

    // Scratch vectors, reused every step to avoid per-frame allocation.
    this.vel = new THREE.Vector2();
    this._f = new THREE.Vector2();
    this._r = new THREE.Vector2();
    this._n = new THREE.Vector2();
    this._axes = [new THREE.Vector2(1, 0), new THREE.Vector2(0, 1), this._f, this._r];
    this.reset();
  }

  reset() {
    this.x = laneX(2);
    this.z = 0;
    this.heading = 0;
    this.steer = 0;
    this.vel.set(0, -27);
    this.impact = 0;
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

  update(dt, input) {
    const f = this.forward;
    const r = this.right;
    let fwd = this.vel.dot(f);
    let lat = this.vel.dot(r);

    // Steering input smoothing.
    const s = input.steer;
    const rate = s !== 0 && Math.sign(s) !== Math.sign(this.steer) ? 8 : 4;
    this.steer += THREE.MathUtils.clamp(s - this.steer, -rate * dt, rate * dt);

    // Longitudinal.
    let accel = 0;
    if (input.throttle) accel += fwd >= 0 ? ENGINE * (1 - fwd / MAX_SPEED) : BRAKE;
    if (input.brake) accel -= fwd > 0.5 ? BRAKE : fwd > -MAX_REVERSE ? ENGINE * 0.5 : 0;
    accel -= Math.sign(fwd) * (0.6 + 0.0002 * fwd * fwd); // rolling + air drag
    if (!input.throttle && !input.brake && Math.abs(fwd) < 0.3) fwd = 0;
    fwd += accel * dt;

    // Yaw: full authority at low speed, softer at high speed.
    const auth = Math.min(1, Math.abs(fwd) / 5) / (1 + Math.abs(fwd) / 18);
    this.heading += this.steer * STEER_RATE * auth * Math.sign(fwd || 1) * dt;
    // Gentle self-centering toward the road direction when not steering.
    if (s === 0 && fwd > 5) this.heading -= this.heading * Math.min(1, 0.8 * dt);

    // Grip: bleed off sideways velocity (this is what gives the slide).
    lat *= Math.exp(-GRIP * dt);

    const nf = this.forward;
    const nr = this.right;
    this.vel.set(nf.x * fwd + nr.x * lat, nf.y * fwd + nr.y * lat);
    this.x += this.vel.x * dt;
    this.z += this.vel.y * dt;

    this.accel = accel;
    this.#barriers(dt);
    this.impact = Math.max(0, this.impact - dt * 2);
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
      this.heading *= Math.exp(-6 * dt); // align with the wall
    }
  }

  // Resolve overlaps with traffic (rectangles in the x/z plane).
  collide(cars) {
    const f = this.forward;
    const r = this.right;
    const axes = this._axes;
    const hw = this.width / 2;
    const hl = this.length / 2;

    for (const c of cars) {
      const dx = this.x - c.x;
      const dz = this.z - c.z;
      if (Math.abs(dz) > 12 || Math.abs(dx) > 6) continue;

      let minOverlap = Infinity;
      let n = null;
      for (const a of axes) {
        const rp = hw * Math.abs(r.dot(a)) + hl * Math.abs(f.dot(a));
        const rc = (c.width / 2) * Math.abs(a.x) + (c.length / 2) * Math.abs(a.y);
        const d = dx * a.x + dz * a.y;
        const o = rp + rc - Math.abs(d);
        if (o <= 0) {
          n = null;
          break;
        }
        if (o < minOverlap) {
          minOverlap = o;
          n = this._n.copy(a).multiplyScalar(Math.sign(d) || 1);
        }
      }
      if (!n) continue;

      this.x += n.x * minOverlap;
      this.z += n.y * minOverlap;

      // Relative velocity along the contact normal; traffic moves along -z at c.speed.
      const rvx = this.vel.x;
      const rvz = this.vel.y + c.speed;
      const vn = rvx * n.x + rvz * n.y;
      if (vn >= 0) continue;
      const share = c.type === 'truck' ? 0.9 : 0.55; // how much of the impulse the player takes
      const j = -(1 + 0.3) * vn;
      this.vel.x += n.x * j * share;
      this.vel.y += n.y * j * share;
      c.speed = Math.max(0, c.speed + n.y * j * (1 - share));
      this.heading += (n.x * Math.sign(-this.vel.y) * 0.04 + (Math.random() - 0.5) * 0.06) * Math.min(1, -vn / 10);
      this.impact = Math.max(this.impact, Math.min(1, -vn / 20));
    }
  }

  sync(dt) {
    this.body.position.set(this.x, 0, this.z);
    this.body.rotation.y = this.heading;
    // Body roll and pitch for weight transfer.
    const fwd = this.forwardSpeed;
    this.group.rotation.z = THREE.MathUtils.lerp(this.group.rotation.z, -this.steer * Math.min(1, fwd / 40) * 0.05, 0.1);
    this.pitch = THREE.MathUtils.lerp(this.pitch, THREE.MathUtils.clamp(-this.accel * 0.004, -0.05, 0.03), 0.1);
    this.group.rotation.x = this.pitch;
    this.tail.color.setScalar(this.accel < -3 ? 3 : 0.45);
    const roll = (fwd * dt) / 0.34;
    this.wheels.forEach((w, i) => {
      w.userData.spin.rotation.x -= roll;
      if (i < 2) w.rotation.y = this.steer * 0.35;
    });
  }
}
