import * as THREE from 'three';
import { PROFILE } from './platform.js';

// Time-of-day presets. Colours are sRGB hex; directions point toward the sun (player drives -z).
export const PRESETS = {
  day: {
    label: 'Day',
    zenith: 0x3d7cc9,
    horizon: 0xbcd4e6,
    ground: 0x8f9aa2,
    sunDir: [0.45, 0.8, 0.4],
    sunColor: 0xfff1dc,
    sunIntensity: 3.0,
    sunDisc: 1,
    shadows: true,
    hemiSky: 0xc4dbf2,
    hemiGround: 0x5e584c,
    hemiIntensity: 1.1,
    fog: 0xb6cadb,
    fogDensity: 0.00045,
    exposure: 0.85,
    envIntensity: 1.0,
    windows: 0,
    lamps: false,
    headlights: false,
    clouds: 0xffffff,
    cloudOpacity: 0.7,
    water: 0x2f5671,
    road: 1,
    bloom: 0.22,
  },
  golden: {
    label: 'Golden Hour',
    zenith: 0x4b6496,
    horizon: 0xf3b37a,
    ground: 0x6d5a4c,
    sunDir: [-0.22, 0.1, -0.97],
    sunColor: 0xffb46e,
    sunIntensity: 2.6,
    sunDisc: 1.6,
    shadows: true,
    hemiSky: 0xf2c49b,
    hemiGround: 0x3e352d,
    hemiIntensity: 0.75,
    fog: 0xe2b896,
    fogDensity: 0.0006,
    exposure: 0.9,
    envIntensity: 0.8,
    windows: 0.3,
    lamps: true,
    headlights: true,
    clouds: 0xffc3a0,
    cloudOpacity: 0.85,
    water: 0x5a5466,
    road: 0.8,
    bloom: 0.3,
  },
  night: {
    label: 'Night',
    zenith: 0x02040a,
    horizon: 0x0c1322,
    ground: 0x05070d,
    sunDir: [-0.3, 0.6, 0.2],
    sunColor: 0x8090b0,
    sunIntensity: 0.35,
    sunDisc: 0,
    shadows: false,
    hemiSky: 0x3a4a6a,
    hemiGround: 0x0a0a0c,
    hemiIntensity: 0.6,
    fog: 0x070a12,
    fogDensity: 0.0012,
    exposure: 0.95,
    envIntensity: 0.25,
    windows: 1.3,
    lamps: true,
    headlights: true,
    clouds: 0x1b2232,
    cloudOpacity: 0.45,
    water: 0x0c1621,
    road: 0.5,
    bloom: 0.4,
  },
};

export const PRESET_ORDER = ['day', 'golden', 'night'];

const SHADOW_EXTENT = PROFILE.shadowExtent; // half-size (m) of the sun's shadow box around the player

function skyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      zenith: { value: new THREE.Color() },
      horizon: { value: new THREE.Color() },
      ground: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color() },
      sunDisc: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // always at the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 zenith, horizon, ground, sunDir, sunColor;
      uniform float sunDisc;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = d.y > 0.0
          ? mix(horizon, zenith, pow(d.y, 0.45))
          : mix(horizon, ground, pow(min(1.0, -d.y * 4.0), 0.6));
        float s = max(dot(d, sunDir), 0.0);
        col += sunColor * sunDisc * (pow(s, 1200.0) * 8.0 + pow(s, 14.0) * 0.25);
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
}

function cloudTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  for (let i = 0; i < 14; i++) {
    const x = 30 + Math.random() * 68;
    const y = 50 + Math.random() * 30;
    const r = 14 + Math.random() * 22;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(c);
}

export class Lighting {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMaterial());
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight();
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight();
    this.sun.shadow.mapSize.set(PROFILE.shadowMap, PROFILE.shadowMap);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -SHADOW_EXTENT;
    cam.right = cam.top = SHADOW_EXTENT;
    cam.near = 1;
    cam.far = 700;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    scene.add(this.sun, this.sun.target);

    // Clouds: one Points draw, kept centred on the camera so they read as distant sky.
    const n = 40;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 5000;
      pos[i * 3 + 1] = 600 + Math.random() * 400;
      pos[i * 3 + 2] = -Math.random() * 3200 + 600;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.clouds = new THREE.Points(
      geo,
      new THREE.PointsMaterial({ map: cloudTexture(), size: 520, transparent: true, depthWrite: false, fog: false }),
    );
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new THREE.Mesh(this.sky.geometry, this.sky.material);
    this.envScene.add(this.envSky);
    this.envTarget = null;
    this.sunDir = new THREE.Vector3();
  }

  apply(name) {
    const p = PRESETS[name];
    const u = this.sky.material.uniforms;
    u.zenith.value.set(p.zenith);
    u.horizon.value.set(p.horizon);
    u.ground.value.set(p.ground);
    this.sunDir.set(...p.sunDir).normalize();
    u.sunDir.value.copy(this.sunDir);
    u.sunColor.value.set(p.sunColor);
    u.sunDisc.value = p.sunDisc;

    this.hemi.color.set(p.hemiSky);
    this.hemi.groundColor.set(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity;
    this.sun.color.set(p.sunColor);
    this.sun.intensity = p.sunIntensity;
    this.sun.castShadow = p.shadows;

    this.scene.fog = new THREE.FogExp2(p.fog, p.fogDensity * PROFILE.fogScale);
    this.scene.background = null;
    this.renderer.toneMappingExposure = p.exposure;
    this.clouds.material.color.set(p.clouds);
    this.clouds.material.opacity = p.cloudOpacity;

    // Sky reflections for glass, water and paint.
    if (this.envTarget) this.envTarget.dispose();
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.02);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = p.envIntensity;
    return p;
  }

  // Keep sky, clouds and the shadow box centred on what the camera sees.
  update(camera, focusX, focusZ) {
    this.sky.position.copy(camera.position);
    this.clouds.position.set(camera.position.x, 0, camera.position.z);
    // Snap the shadow box to whole shadow-map texels so shadow edges don't shimmer while driving.
    const texel = (SHADOW_EXTENT * 2) / this.sun.shadow.mapSize.x;
    this.sun.target.position.set(Math.round(focusX / texel) * texel, 0, Math.round((focusZ - 25) / texel) * texel);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 300);
  }
}
