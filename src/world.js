import * as THREE from 'three';
import { MAX_TRAFFIC_WIDTH, PLAYER_WIDTH } from './car.js';

export const LANES = 5;
// Widest vehicle + player + a small margin: two cars side by side in adjacent lanes always leave
// a gap just wider than the player, so it can be threaded at speed with a straight wheel.
// Traffic also leans within its lane (traffic.js) under a pair budget that preserves this gap.
export const SQUEEZE_MARGIN = 0.25;
export const LANE_W = MAX_TRAFFIC_WIDTH + PLAYER_WIDTH + SQUEEZE_MARGIN;
const SHOULDER = 1.5;
export const ROAD_HALF = (LANES * LANE_W) / 2 + SHOULDER; // inner face of barriers
export const laneX = (i) => -(LANES * LANE_W) / 2 + LANE_W / 2 + i * LANE_W;

const DASH_PERIOD = 12;
const LAMP_PERIOD = 40;
const LAMP_COUNT = 68; // per side: covers the full view distance
const VIEW_AHEAD = 2700; // matches the city's streamed distance
const LAMP_ON = new THREE.Color(0xfff0d8).multiplyScalar(6);
const LAMP_OFF = new THREE.Color(0x8a8d90);

function roadTexture(renderer) {
  const ppm = 24;
  const w = Math.round(ROAD_HALF * 2 * ppm);
  const h = DASH_PERIOD * ppm;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#383a3f';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 4000; i++) {
    const v = 44 + Math.random() * 36;
    g.fillStyle = `rgb(${v},${v},${v + 3})`;
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  const px = (x) => (x + ROAD_HALF) * ppm;
  const line = 0.15 * ppm;
  g.fillStyle = '#d9a520';
  g.fillRect(px(-ROAD_HALF + SHOULDER) - line, 0, line, h);
  g.fillStyle = '#d8d8d4';
  g.fillRect(px(ROAD_HALF - SHOULDER), 0, line, h);
  for (let i = 1; i < LANES; i++) {
    const x = px(-(LANES * LANE_W) / 2 + i * LANE_W) - line / 2;
    g.fillRect(x, 0, line, 3 * ppm);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function jerseyBarrier(length, side) {
  const s = new THREE.Shape();
  // Profile in (x outward, y up); side flips it to face the road.
  s.moveTo(0, 0);
  s.lineTo(0, 0.08);
  s.lineTo(0.06, 0.33);
  s.lineTo(0.22, 0.8);
  s.lineTo(0.27, 1.05);
  s.lineTo(0.6, 1.05);
  s.lineTo(0.6, 0);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false });
  geo.translate(0, 0, -length / 2);
  if (side < 0) geo.rotateY(Math.PI); // mirror in x without flipping winding (profile is uniform along z)
  const mesh = new THREE.Mesh(
    geo,
    // Not flatShading: derivative-based normals on these km-long sliver faces collapse to NaN at
    // grazing angles, and bloom spreads a single NaN pixel across the frame. The extruded
    // geometry already carries per-face normals.
    new THREE.MeshStandardMaterial({ color: 0x6d7076, roughness: 0.92 }),
  );
  mesh.position.x = side * ROAD_HALF;
  return mesh;
}

export class World {
  constructor(scene, renderer) {
    this.scene = scene;

    // Sky, sun and fog live in lighting.js; surroundings in city.js.
    // Road: one long plane snapped to the dash period so markings stay world-fixed.
    const roadLen = VIEW_AHEAD + 300;
    const tex = roadTexture(renderer);
    tex.repeat.set(1, roadLen / DASH_PERIOD);
    this.road = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF * 2, roadLen).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0 }),
    );
    this.road.geometry.translate(0, 0, -roadLen / 2 + 250);
    this.road.receiveShadow = true;
    scene.add(this.road);

    this.barriers = new THREE.Group();
    this.barriers.add(jerseyBarrier(roadLen, -1), jerseyBarrier(roadLen, 1));
    this.barriers.children.forEach((b) => {
      b.position.z = -roadLen / 2 + 250;
      b.castShadow = b.receiveShadow = true;
    });
    scene.add(this.barriers);

    this.#buildLamps();
  }

  // Asphalt brightness (<= 1 so white lane lines never cross the bloom threshold).
  setRoadTone(k) {
    this.road.material.color.setScalar(k);
  }

  // Streetlights on (dusk/night) or off (day): real lights, glowing heads and light pools.
  setLamps(on) {
    for (const l of this.lampLights) l.visible = on;
    this.lampHeads.material.color.copy(on ? LAMP_ON : LAMP_OFF);
    this.lampPools.visible = on;
  }

  #buildLamps() {
    const n = LAMP_COUNT * 2;
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7, metalness: 0.4, flatShading: true });
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.18, 11, 6), poleMat, n);
    const arms = new THREE.InstancedMesh(new THREE.BoxGeometry(2.6, 0.14, 0.14), poleMat, n);
    const heads = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.9, 0.18, 0.4),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff0d8).multiplyScalar(6) }),
      n,
    );
    const pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: radialTexture(),
        color: 0xffe2b8,
        transparent: true,
        opacity: 0.13,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      n,
    );
    const m = new THREE.Matrix4();
    const lampX = ROAD_HALF + 0.35;
    this.lampOffsets = [];
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = -Math.floor(i / 2) * LAMP_PERIOD - (side > 0 ? LAMP_PERIOD / 2 : 0) + 80;
      const x = side * lampX;
      poles.setMatrixAt(i, m.makeTranslation(x, 5.5 + 1.05, z));
      arms.setMatrixAt(i, m.makeTranslation(x - side * 1.3, 11.9, z));
      heads.setMatrixAt(i, m.makeTranslation(x - side * 2.4, 11.8, z));
      const px = x - side * 3.6;
      pools.setMatrixAt(i, m.makeScale(18, 1, 18).setPosition(px, 0.02, z));
      this.lampOffsets.push(new THREE.Vector3(px, 10, z));
    }
    this.lamps = new THREE.Group();
    this.lamps.add(poles, arms, heads, pools);
    poles.castShadow = arms.castShadow = true;
    this.lampHeads = heads;
    this.lampPools = pools;
    this.scene.add(this.lamps);

    // A few real lights on the lamps nearest the player so cars pick up highlights.
    // Every light adds per-pixel cost to every lit material, so keep this small.
    this.lampLights = [];
    this.nearest = new Int32Array(4);
    this.nearestD = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffe6c4, 140, 40, 1.6);
      this.lamps.add(l);
      this.lampLights.push(l);
    }
  }

  update(playerZ) {
    // Large geometry follows the player continuously (it is uniform along z).
    this.road.position.z = Math.floor(playerZ / DASH_PERIOD) * DASH_PERIOD;
    this.barriers.position.z = playerZ;
    const lampBase = Math.floor(playerZ / LAMP_PERIOD) * LAMP_PERIOD;
    this.lamps.position.z = lampBase;

    // Attach real lights to the lamps nearest a point just ahead of the player (no allocation).
    const local = playerZ - lampBase - 15;
    const idx = this.nearest;
    const dist = this.nearestD.fill(Infinity);
    for (let i = 0; i < this.lampOffsets.length; i++) {
      const d = Math.abs(this.lampOffsets[i].z - local);
      for (let k = 0; k < idx.length; k++) {
        if (d < dist[k]) {
          for (let m = idx.length - 1; m > k; m--) {
            dist[m] = dist[m - 1];
            idx[m] = idx[m - 1];
          }
          dist[k] = d;
          idx[k] = i;
          break;
        }
      }
    }
    for (let k = 0; k < idx.length; k++) this.lampLights[k].position.copy(this.lampOffsets[idx[k]]);
  }
}

export function mulberry(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
