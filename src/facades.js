import * as THREE from 'three';

// Procedural facade textures. Each archetype is one tile of facade (TILE metres square, a grid of
// floors x bays) drawn to a canvas, plus a matching night mask with a random subset of windows lit.
// Building materials tile these by the instance's real size, so windows stay a constant size.

export const TILE = 24; // metres covered by one texture tile (both axes)
const SIZE = 512;

const rand = (() => {
  let s = 99;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
})();

function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

// spec: { wall, window, floors, bays, wx, wy, sill, frame, bands, brick, sheen, lit, roof }
function draw(spec) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  const e = document.createElement('canvas');
  e.width = e.height = SIZE;
  const ge = e.getContext('2d');
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, SIZE, SIZE);

  g.fillStyle = spec.wall;
  g.fillRect(0, 0, SIZE, SIZE);
  // Surface variation.
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = shade(spec.wall, 0.88 + rand() * 0.24);
    g.fillRect(rand() * SIZE, rand() * SIZE, 2 + rand() * 6, 2 + rand() * 3);
  }
  if (spec.brick) {
    g.fillStyle = shade(spec.wall, 0.75);
    for (let y = 0; y < SIZE; y += 5) {
      g.fillRect(0, y, SIZE, 1);
      for (let x = (y / 5) % 2 ? 0 : 6; x < SIZE; x += 12) g.fillRect(x, y, 1, 5);
    }
  }

  const cw = SIZE / spec.bays;
  const ch = SIZE / spec.floors;
  if (spec.bands) {
    g.fillStyle = shade(spec.wall, 0.8);
    for (let f = 0; f < spec.floors; f += spec.bands) g.fillRect(0, f * ch, SIZE, 4);
  }
  for (let f = 0; f < spec.floors; f++) {
    for (let b = 0; b < spec.bays; b++) {
      const w = cw * spec.wx;
      const h = ch * spec.wy;
      const x = b * cw + (cw - w) / 2;
      const y = f * ch + ch - h - ch * (spec.sill ?? 0.15);
      const k = 0.8 + rand() * 0.4;
      if (spec.sheen) {
        const grd = g.createLinearGradient(x, y, x + w * 0.6, y + h);
        grd.addColorStop(0, shade(spec.window, k * 1.25));
        grd.addColorStop(1, shade(spec.window, k * 0.8));
        g.fillStyle = grd;
      } else {
        g.fillStyle = shade(spec.window, k);
      }
      g.fillRect(x, y, w, h);
      if (spec.frame) {
        g.strokeStyle = spec.frame;
        g.lineWidth = 2;
        g.strokeRect(x, y, w, h);
      }
      if (rand() < spec.lit) {
        const warm = rand() < 0.8;
        const v = 0.5 + rand() * 0.5;
        ge.fillStyle = warm ? shade('#ffc985', v) : shade('#cfe6ff', v);
        ge.fillRect(x + 1, y + 1, w - 2, h - 2);
      }
    }
  }
  // Roof colour patch: top faces sample this corner (see building shader).
  g.fillStyle = spec.roof ?? '#55585c';
  g.fillRect(0, SIZE - 8, 8, 8);
  ge.fillStyle = '#000';
  ge.fillRect(0, SIZE - 8, 8, 8);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  const emissive = new THREE.CanvasTexture(e);
  emissive.colorSpace = THREE.SRGBColorSpace;
  emissive.wrapS = emissive.wrapT = THREE.RepeatWrapping;
  return { map, emissive };
}

export const FACADES = {
  glass: {
    spec: { wall: '#27313b', window: '#6f97b8', floors: 8, bays: 8, wx: 0.94, wy: 0.86, sill: 0.07, sheen: true, lit: 0.35 },
    roughness: 0.12,
    metalness: 0.75,
  },
  darkglass: {
    spec: { wall: '#12171c', window: '#34505f', floors: 8, bays: 8, wx: 0.96, wy: 0.9, sill: 0.05, sheen: true, lit: 0.3 },
    roughness: 0.1,
    metalness: 0.8,
  },
  white: {
    spec: { wall: '#dcdedb', window: '#5d7b90', floors: 8, bays: 8, wx: 0.7, wy: 0.68, sheen: true, lit: 0.35, roof: '#8d9093' },
    roughness: 0.4,
    metalness: 0.2,
  },
  brick: {
    spec: { wall: '#8b4a36', window: '#20262b', floors: 8, bays: 12, wx: 0.44, wy: 0.56, frame: '#d8d2c6', brick: true, lit: 0.4, roof: '#4b4440' },
    roughness: 0.92,
    metalness: 0,
  },
  limestone: {
    spec: { wall: '#c8b996', window: '#283037', floors: 8, bays: 10, wx: 0.46, wy: 0.6, frame: '#e9e1cf', bands: 4, lit: 0.4, roof: '#6b655b' },
    roughness: 0.85,
    metalness: 0,
  },
  concrete: {
    spec: { wall: '#8e9196', window: '#3a4957', floors: 8, bays: 1, wx: 1, wy: 0.42, sill: 0.3, sheen: true, lit: 0.35 },
    roughness: 0.8,
    metalness: 0.05,
  },
  stone: {
    spec: { wall: '#958f84', window: '#958f84', floors: 4, bays: 6, wx: 0.96, wy: 0.9, frame: '#7d776d', lit: 0 },
    roughness: 0.95,
    metalness: 0,
  },
};

// Patch a standard material so box UVs tile by the instance's scale (from instanceMatrix): each side
// face repeats the facade every TILE metres, top faces sample the roof patch, and each building gets
// a horizontal offset so neighbours don't line up.
export function facadeMaterial(kind) {
  const f = FACADES[kind];
  const { map, emissive } = draw(f.spec);
  const m = new THREE.MeshStandardMaterial({
    map,
    emissiveMap: emissive,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    roughness: f.roughness,
    metalness: f.metalness,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      #ifdef USE_INSTANCING
        vec3 iS = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        float iO = fract(dot(instanceMatrix[3].xz, vec2(0.0731, 0.0517)));
      #else
        vec3 iS = vec3(1.0);
        float iO = 0.0;
      #endif
        vec2 fs = abs(normal.x) > 0.5 ? iS.zy : (abs(normal.z) > 0.5 ? iS.xy : vec2(0.0));
        vec2 fuv = fs.x > 0.0 ? uv * fs / ${TILE.toFixed(1)} + vec2(iO, 0.0) : vec2(0.006, 0.006);
        vMapUv = fuv;
        #ifdef USE_EMISSIVEMAP
        vEmissiveMapUv = fuv;
        #endif`,
    );
  };
  m.customProgramCacheKey = () => 'facade';
  return m;
}
