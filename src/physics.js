// 2D rigid-body helpers in the x/z plane.
// Heading h: forward = (-sin h, -cos h), right = (cos h, -sin h) — matches three.js rotation.y.
// A point at offset r from the centre moves with velocity omega * (r.z, -r.x) when the body yaws.

const fx = (h) => -Math.sin(h);
const fz = (h) => -Math.cos(h);
const rx = (h) => Math.cos(h);
const rz = (h) => -Math.sin(h);

// Torque-arm cross product consistent with the yaw convention above.
export const cross = (ax, az, bx, bz) => az * bx - ax * bz;

// Half-extent of an oriented box along unit axis (ax, az).
function radius(b, ax, az) {
  return b.hw * Math.abs(rx(b.h) * ax + rz(b.h) * az) + b.hl * Math.abs(fx(b.h) * ax + fz(b.h) * az);
}

const contact = { depth: 0, nx: 0, nz: 0, px: 0, pz: 0 };

// Separating-axis test for two oriented boxes { x, z, h, hw, hl }.
// Returns a shared contact object (normal points from b to a) or null.
export function obbContact(a, b) {
  const axes = [rx(a.h), rz(a.h), fx(a.h), fz(a.h), rx(b.h), rz(b.h), fx(b.h), fz(b.h)];
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  let depth = Infinity;
  let nx = 0;
  let nz = 0;
  for (let i = 0; i < 8; i += 2) {
    const ax = axes[i];
    const az = axes[i + 1];
    const d = dx * ax + dz * az;
    const o = radius(a, ax, az) + radius(b, ax, az) - Math.abs(d);
    if (o <= 0) return null;
    if (o < depth) {
      depth = o;
      const s = d < 0 ? -1 : 1;
      nx = ax * s;
      nz = az * s;
    }
  }
  // Contact point: on a's face toward b, centred on the overlap of both boxes along the tangent.
  const tx = -nz;
  const tz = nx;
  const at = a.x * tx + a.z * tz;
  const bt = b.x * tx + b.z * tz;
  const ea = radius(a, tx, tz);
  const eb = radius(b, tx, tz);
  const mid = (Math.max(at - ea, bt - eb) + Math.min(at + ea, bt + eb)) / 2;
  const ra = radius(a, nx, nz);
  const an = a.x * nx + a.z * nz;
  contact.depth = depth;
  contact.nx = nx;
  contact.nz = nz;
  contact.px = (an - ra) * nx + mid * tx;
  contact.pz = (an - ra) * nz + mid * tz;
  return contact;
}

// Bodies: { vx, vz, w (yaw rate), invM, invI, x, z }. Applies restitution + friction impulse.
// Returns the closing speed along the normal (>= 0), i.e. crash severity in m/s.
export function resolveImpulse(a, b, c, restitution = 0.2, friction = 0.35) {
  const rax = c.px - a.x;
  const raz = c.pz - a.z;
  const rbx = c.px - b.x;
  const rbz = c.pz - b.z;
  const vax = a.vx + a.w * raz;
  const vaz = a.vz - a.w * rax;
  const vbx = b.vx + b.w * rbz;
  const vbz = b.vz - b.w * rbx;
  const rvx = vax - vbx;
  const rvz = vaz - vbz;
  const vn = rvx * c.nx + rvz * c.nz;
  if (vn >= 0) return 0;

  // Gentle contacts (scrapes, resting) get no bounce, so sliding along a car or wall doesn't
  // ping-pong into a stream of tiny impacts.
  if (vn > -2) restitution = 0;
  const tA = cross(rax, raz, c.nx, c.nz);
  const tB = cross(rbx, rbz, c.nx, c.nz);
  const j = (-(1 + restitution) * vn) / (a.invM + b.invM + tA * tA * a.invI + tB * tB * b.invI);
  apply(a, b, c.nx * j, c.nz * j, rax, raz, rbx, rbz);

  // Coulomb friction along the tangent (scrape), capped by the normal impulse.
  const tx = -c.nz;
  const tz = c.nx;
  const vt = rvx * tx + rvz * tz;
  const sA = cross(rax, raz, tx, tz);
  const sB = cross(rbx, rbz, tx, tz);
  let jt = -vt / (a.invM + b.invM + sA * sA * a.invI + sB * sB * b.invI);
  jt = Math.max(-friction * j, Math.min(friction * j, jt));
  apply(a, b, tx * jt, tz * jt, rax, raz, rbx, rbz);

  return -vn;
}

function apply(a, b, ix, iz, rax, raz, rbx, rbz) {
  a.vx += ix * a.invM;
  a.vz += iz * a.invM;
  a.w += cross(rax, raz, ix, iz) * a.invI;
  b.vx -= ix * b.invM;
  b.vz -= iz * b.invM;
  b.w -= cross(rbx, rbz, ix, iz) * b.invI;
}
