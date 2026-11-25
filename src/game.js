import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Player } from './player.js';
import { Traffic } from './traffic.js';
import { World } from './world.js';

const STEP = 1 / 120;

export class Game {
  constructor(container, input, hud) {
    this.input = input;
    this.hud = hud;

    const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, container.clientWidth / container.clientHeight, 0.1, 2500);

    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.4, 0.9);
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

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      this.composer.setSize(w, h);
    };
    window.addEventListener('resize', resize);
    resize();

    // Compile shaders up front so the first gameplay frame doesn't stall.
    this.reset();
    this.composer.render();

    renderer.setAnimationLoop(() => this.#frame());
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
    this.player.sync(dt);
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
    const dist = 6.2 + speed * 0.012;
    const shake = p.impact * 0.25 + Math.max(0, speed - 50) * 0.0012;
    this.camPos.set(
      p.x - this.camDir.x * dist + (Math.random() - 0.5) * shake,
      1.9 + (Math.random() - 0.5) * shake,
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
