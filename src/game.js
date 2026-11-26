import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { City } from './city.js';
import { Lighting } from './lighting.js';
import { MOBILE, PROFILE } from './platform.js';
import { Player } from './player.js';
import { Traffic } from './traffic.js';
import { World } from './world.js';
import { Wreckage } from './wreck.js';

const STEP = 1 / 120;
// High-DPI panels at full devicePixelRatio cost 4-9x the pixels of 1x; cap it (see platform.js).
const MAX_PIXEL_RATIO = PROFILE.maxPixelRatio;
// Dynamic resolution: scale the render size between these to hold frame rate.
const MIN_SCALE = PROFILE.minScale;
const SLOW_FRAME = 1 / 50;
const FAST_FRAME = 1 / 58;

// Bloom: only HDR emissives (lights) exceed the threshold; lit paint stays below it.
// Strength comes from the time-of-day preset (lighting.js).
const BLOOM_STRENGTH = 0.4;
const BLOOM_RADIUS = 0.3;
const BLOOM_THRESHOLD = 1.0;
// Cap on per-pixel brightness fed into bloom, so no single light can flood the frame.
const BLOOM_MAX = 3.0;

// Chase camera (metres).
const CAM_DISTANCE = 4.5;
const CAM_DISTANCE_PER_MS = 0.012; // extra distance per m/s of speed
const CAM_HEIGHT = 3;
const CAM_LOOK_AHEAD = 6;
const CAM_LOOK_HEIGHT = 0.9;
// Field of view: CAM_VFOV vertically on landscape screens, but never narrower than CAM_MIN_HFOV
// horizontally, so a portrait phone still sees the lanes either side. Both widen with speed.
const CAM_VFOV = 60;
const CAM_MIN_HFOV = MOBILE ? 78 : 70;
const CAM_FOV_SPEED = 0.17; // extra degrees per m/s
const CAM_FOV_MAX_EXTRA = 16;
const CAM_VFOV_MAX = 105; // caps the vertical stretch on very tall screens

export class Game {
  constructor(container, input, hud) {
    this.input = input;
    this.hud = hud;

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.basePixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.scale = 1;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PROFILE.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    // Far plane covers the distant skyline (the sky dome is drawn at the far plane regardless).
    this.camera = new THREE.PerspectiveCamera(62, container.clientWidth / container.clientHeight, 0.5, PROFILE.farPlane);

    // MSAA matters less on high-DPI screens, where it is also most expensive.
    const samples = PROFILE.msaa;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    // Clamp what enters the bloom chain (also turns any stray Inf into a finite value).
    const hp = this.bloom.materialHighPassFilter;
    hp.fragmentShader = hp.fragmentShader.replace(
      'gl_FragColor = mix( outputColor, texel, alpha );',
      `gl_FragColor = mix( outputColor, vec4( min( texel.rgb, vec3( ${BLOOM_MAX.toFixed(2)} ) ), texel.a ), alpha );`,
    );
    hp.needsUpdate = true;
    // Run the bloom mip chain at half the usual resolution; it is a blur, so this is not visible.
    const bloomSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => bloomSetSize(Math.max(1, w / 2), Math.max(1, h / 2));
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.lighting = new Lighting(this.scene, renderer);
    this.world = new World(this.scene, renderer);
    this.city = new City(this.scene);
    this.player = new Player(this.scene);
    this.wreckage = new Wreckage(this.scene);
    this.traffic = new Traffic(this.scene, this.wreckage);

    this.camDir = new THREE.Vector2(0, -1);
    this.carDir = new THREE.Vector2();
    this.lookAt = new THREE.Vector3();
    this.running = false;
    this.acc = 0;
    this.time = 0;
    this.timer = new THREE.Timer();
    this.perfTime = 0;
    this.perfFrames = 0;
    this.fastWindows = 0;
    this.slowWindows = 0;

    this.container = container;
    window.addEventListener('resize', () => this.#resize());
    this.#resize();

    // Compile shaders up front (including the crash rigs) so the first frame and first crash don't stall.
    this.timeOfDay = 'day';
    this.setTimeOfDay('day');
    this.reset();
    this.wreckage.prewarm(true, new THREE.Vector3(this.player.x, 0, this.player.z - 12));
    this.renderStill();
    this.wreckage.prewarm(false);

    renderer.setAnimationLoop((t) => this.#frame(t));
  }

  #resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const pr = this.basePixelRatio * this.scale;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
  }

  // Every half second, step render resolution down if frames are slow, back up if there is headroom.
  // Asymmetric hysteresis (1 s to drop, 5 s to raise) so it doesn't oscillate: each resize reallocates
  // render targets and costs a frame.
  #adaptResolution(dt) {
    this.perfTime += dt;
    this.perfFrames++;
    if (this.perfTime < 0.5) return;
    const avg = this.perfTime / this.perfFrames;
    this.perfTime = 0;
    this.perfFrames = 0;
    let next = this.scale;
    if (avg > SLOW_FRAME) {
      this.fastWindows = 0;
      if (++this.slowWindows >= 2) {
        next = Math.max(MIN_SCALE, this.scale - 0.1);
        this.slowWindows = 0;
      }
    } else {
      this.slowWindows = 0;
      if (avg < FAST_FRAME && ++this.fastWindows >= 10) {
        next = Math.min(1, this.scale + 0.05);
        this.fastWindows = 0;
      }
    }
    if (next !== this.scale) {
      this.scale = next;
      this.#resize();
    }
  }

  // Apply a lighting preset (see lighting.js) to everything that depends on it.
  setTimeOfDay(name) {
    this.timeOfDay = name;
    const p = this.lighting.apply(name);
    this.city.setNight(p.windows);
    this.city.setWater(p.water);
    this.world.setLamps(p.lamps);
    this.world.setRoadTone(p.road);
    this.player.setHeadlights(p.headlights);
    this.bloom.strength = p.bloom;
  }

  // Render one frame without advancing the simulation (compiles shaders after lighting changes).
  renderStill() {
    this.lighting.update(this.camera, this.player.renderX, this.player.renderZ);
    this.composer.render();
  }

  reset() {
    this.player.reset();
    this.city.update(this.player.z, 0);
    this.traffic.reset(this.player);
    this.camDir.set(0, -1);
    this.player.sync(0, 1);
    this.placeCamera(1);
  }

  setRunning(on) {
    this.running = on;
    this.timer.update();
    this.acc = 0;
  }

  step() {
    this.player.update(STEP, this.input);
    this.input.tick?.(STEP);
    this.traffic.update(STEP, this.player);
    const severity = this.traffic.collide(this.player);
    if (severity > 0) this.player.hit(severity);
  }

  #frame(t) {
    if (!this.running) return;
    this.timer.update(t);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.time += dt;
    this.acc += dt;
    while (this.acc >= STEP) {
      this.step();
      this.acc -= STEP;
    }
    // Render between the last two physics states so motion is smooth at any frame rate.
    const alpha = this.acc / STEP;
    this.#adaptResolution(dt);
    this.player.sync(dt, alpha);
    this.traffic.sync(alpha, this.player);
    this.wreckage.update(dt, this.player.z);
    this.world.update(this.player.renderZ);
    this.city.update(this.player.renderZ, this.time);
    this.placeCamera(Math.min(1, dt * 5));
    this.lighting.update(this.camera, this.player.renderX, this.player.renderZ);
    this.hud.speed(this.player.forwardSpeed * 3.6);
    this.composer.render();
  }

  placeCamera(k) {
    const p = this.player;
    // Only the camera's direction is smoothed (so slides and spins read on screen); its position is
    // locked to the car. Chasing the car's position with a lerp lags metres behind at speed, and
    // that lag changes with every frame-time wobble, which reads as jitter.
    this.carDir.set(-Math.sin(p.renderHeading), -Math.cos(p.renderHeading));
    this.camDir.lerp(this.carDir, k * 0.6).normalize();
    const speed = Math.abs(p.forwardSpeed);
    const dist = CAM_DISTANCE + speed * CAM_DISTANCE_PER_MS;
    // Shake only on impact, as a smooth wobble rather than per-frame noise.
    const shake = p.impact * 0.3;
    const sx = Math.sin(this.time * 41) * shake;
    const sy = Math.sin(this.time * 53 + 1) * shake;
    this.camera.position.set(p.renderX - this.camDir.x * dist + sx, CAM_HEIGHT + sy, p.renderZ - this.camDir.y * dist);
    this.lookAt.set(
      p.renderX + this.camDir.x * CAM_LOOK_AHEAD,
      CAM_LOOK_HEIGHT,
      p.renderZ + this.camDir.y * CAM_LOOK_AHEAD,
    );
    this.camera.lookAt(this.lookAt);
    const extra = Math.min(CAM_FOV_MAX_EXTRA, speed * CAM_FOV_SPEED);
    const fromH = THREE.MathUtils.radToDeg(
      2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(CAM_MIN_HFOV + extra) / 2) / this.camera.aspect),
    );
    const fov = Math.min(CAM_VFOV_MAX, Math.max(CAM_VFOV + extra, fromH));
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, Math.min(1, k * 2));
      this.camera.updateProjectionMatrix();
    }
  }
}
