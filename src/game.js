import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Player } from './player.js';
import { Traffic } from './traffic.js';
import { World } from './world.js';

const STEP = 1 / 120;
// Retina panels at full devicePixelRatio cost 4x the pixels of 1x; cap it.
const MAX_PIXEL_RATIO = 1.5;
// Dynamic resolution: scale the render size between these to hold frame rate.
const MIN_SCALE = 0.6;
const SLOW_FRAME = 1 / 50;
const FAST_FRAME = 1 / 58;

export class Game {
  constructor(container, input, hud) {
    this.input = input;
    this.hud = hud;

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.basePixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    this.scale = 1;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    // Far plane just past where fog fully hides geometry.
    this.camera = new THREE.PerspectiveCamera(62, container.clientWidth / container.clientHeight, 0.5, 1400);

    // MSAA matters less on high-DPI screens, where it is also most expensive.
    const samples = window.devicePixelRatio > 1 ? 2 : 4;
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.4, 0.9);
    // Run the bloom mip chain at half the usual resolution; it is a blur, so this is not visible.
    const bloomSetSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => bloomSetSize(Math.max(1, w / 2), Math.max(1, h / 2));
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.world = new World(this.scene, renderer);
    this.player = new Player(this.scene);
    this.traffic = new Traffic(this.scene);

    this.camDir = new THREE.Vector2(0, -1);
    this.camPos = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.running = false;
    this.acc = 0;
    this.timer = new THREE.Timer();
    this.perfTime = 0;
    this.perfFrames = 0;
    this.fastWindows = 0;

    this.container = container;
    window.addEventListener('resize', () => this.#resize());
    this.#resize();

    // Compile shaders up front so the first gameplay frame doesn't stall.
    this.reset();
    this.composer.render();

    renderer.setAnimationLoop(() => this.#frame());
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
  #adaptResolution(dt) {
    this.perfTime += dt;
    this.perfFrames++;
    if (this.perfTime < 0.5) return;
    const avg = this.perfTime / this.perfFrames;
    this.perfTime = 0;
    this.perfFrames = 0;
    let next = this.scale;
    if (avg > SLOW_FRAME) {
      next = Math.max(MIN_SCALE, this.scale - 0.1);
      this.fastWindows = 0;
    } else if (avg < FAST_FRAME && ++this.fastWindows >= 4) {
      next = Math.min(1, this.scale + 0.05);
      this.fastWindows = 0;
    }
    if (next !== this.scale) {
      this.scale = next;
      this.#resize();
    }
  }

  reset() {
    this.player.reset();
    this.traffic.reset(this.player);
    this.camDir.set(0, -1);
    this.placeCamera(1);
  }

  setRunning(on) {
    this.running = on;
    this.timer.update();
    this.acc = 0;
  }

  #frame() {
    if (!this.running) return;
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.acc += dt;
    while (this.acc >= STEP) {
      this.player.update(STEP, this.input);
      this.traffic.update(STEP, this.player);
      this.player.collide(this.traffic.cars);
      this.acc -= STEP;
    }
    this.#adaptResolution(dt);
    this.player.sync(dt);
    this.traffic.sync();
    this.world.update(this.player.z);
    this.placeCamera(Math.min(1, dt * 5));
    this.hud.speed(this.player.forwardSpeed * 3.6);
    this.composer.render();
  }

  placeCamera(k) {
    const p = this.player;
    // Camera trails the car's heading with lag, so slides read on screen.
    const f = p.forward;
    this.camDir.lerp(f, k * 0.6).normalize();
    const speed = Math.abs(p.forwardSpeed);
    const dist = 4.5 + speed * 0.012;
    const shake = p.impact * 0.25 + Math.max(0, speed - 50) * 0.0012;
    const defaultHeight = 3;
    this.camPos.set(
      p.x - this.camDir.x * dist + (Math.random() - 0.5) * shake,
      defaultHeight + (Math.random() - 0.5) * shake,
      p.z - this.camDir.y * dist,
    );
    this.camera.position.lerp(this.camPos, k === 1 ? 1 : Math.min(1, k * 3));
    this.lookAt.set(p.x + this.camDir.x * 6, 0.9, p.z + this.camDir.y * 6);
    this.camera.lookAt(this.lookAt);
    const fov = 62 + Math.min(16, speed * 0.17);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, Math.min(1, k * 2));
      this.camera.updateProjectionMatrix();
    }
  }
}
