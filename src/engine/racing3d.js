// 3D view for the racing engine: a small WebGL2 renderer written for this game. There are no
// libraries (the page's CSP only allows its own scripts), and it only reads the race state, so the
// physics, the AI and the Node tests do not depend on it. If WebGL2 is missing, createView()
// returns null and the game keeps its 2D top-down view.
//
// World mapping: race pixels (x, y) become metres (X = x / 10, Z = y / 10) with Y up. A car's
// model space is +X forward, +Y up, +Z to the right, which matches lateral() in racing.js.
import { CARS, PX, kerbColors } from './racing.js';
import { clamp, wrapAngle } from './core.js';

/* ------------------------------------------------------------------ small maths */

const lin = (hex) => {
  const n = parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => (c / 255) ** 2.2);
};
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// 4x4 matrices, column-major like GL.
const M = {
  id: () => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  t: (x, y, z) => Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1),
  s: (x, y, z) => Float32Array.of(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1),
  ry(a) { const c = Math.cos(a), s = Math.sin(a); return Float32Array.of(c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1); },
  rz(a) { const c = Math.cos(a), s = Math.sin(a); return Float32Array.of(c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1); },
  rx(a) { const c = Math.cos(a), s = Math.sin(a); return Float32Array.of(1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1); },
  // Heading in the race's terms: forward (cos a, 0, sin a), right (-sin a, 0, cos a).
  heading(a) { const c = Math.cos(a), s = Math.sin(a); return Float32Array.of(c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1); },
  persp(fovy, asp, n, f) {
    const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
    o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = (2 * f * n) / (n - f);
    return o;
  },
  look(e, c, up) {
    const z = norm(sub(e, c)), x = norm(cross(up, z)), y = cross(z, x);
    return Float32Array.of(x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1);
  },
};
const chain = (...ms) => ms.reduce((a, b) => M.mul(a, b));

// Deterministic noise for prop shapes, so a track looks the same every time it loads.
function rand(seed) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ------------------------------------------------------------------ geometry */

// Materials (the fragment shader switches on these).
const MAT = { matte: 0, paint: 1, glass: 2, chrome: 3, tyre: 4, head: 5, tail: 6, ground: 7, road: 8, kerb: 9, shadow: 10, water: 11, boost: 12, lava: 13, glow: 14, skid: 15, wall: 16 };
const FLOATS = 12; // pos3 nrm3 col3 uv2 mat1

// Vertex soup with an optional transform applied as vertices are added. A zero normal tells
// the shader to shade the face flat from screen-space derivatives.
class Geo {
  constructor() { this.v = []; this.ix = []; this.T = null; }
  get n() { return this.v.length / FLOATS; }
  vert(p, nrm, col, uv, mat) {
    let [x, y, z] = p, [nx, ny, nz] = nrm;
    const t = this.T;
    if (t) {
      [x, y, z] = [t[0] * x + t[4] * y + t[8] * z + t[12], t[1] * x + t[5] * y + t[9] * z + t[13], t[2] * x + t[6] * y + t[10] * z + t[14]];
      if (nx || ny || nz) [nx, ny, nz] = norm([t[0] * nx + t[4] * ny + t[8] * nz, t[1] * nx + t[5] * ny + t[9] * nz, t[2] * nx + t[6] * ny + t[10] * nz]);
    }
    this.v.push(x, y, z, nx, ny, nz, col[0], col[1], col[2], uv[0], uv[1], mat);
    return this.n - 1;
  }
  tri(a, b, c) { this.ix.push(a, b, c); }
  quad(a, b, c, d) { this.ix.push(a, b, c, a, c, d); }
  // Smooth normals from the triangles added since (v0, i0), turned to face away from ref(p).
  smooth(v0, i0, ref) {
    const acc = new Map();
    for (let i = i0; i < this.ix.length; i += 3) {
      const [a, b, c] = [this.ix[i], this.ix[i + 1], this.ix[i + 2]];
      const pa = this.pos(a), n = cross(sub(this.pos(b), pa), sub(this.pos(c), pa));
      for (const k of [a, b, c]) if (k >= v0) { const s = acc.get(k) || [0, 0, 0]; acc.set(k, [s[0] + n[0], s[1] + n[1], s[2] + n[2]]); }
    }
    for (const [k, s] of acc) {
      let nn = norm(s);
      const p = this.pos(k);
      if (dot(nn, sub(p, ref(p))) < 0) nn = [-nn[0], -nn[1], -nn[2]];
      this.v[k * FLOATS + 3] = nn[0]; this.v[k * FLOATS + 4] = nn[1]; this.v[k * FLOATS + 5] = nn[2];
    }
  }
  pos(k) { return [this.v[k * FLOATS], this.v[k * FLOATS + 1], this.v[k * FLOATS + 2]]; }
}

const ZERO = [0, 0, 0];

function box(g, x0, y0, z0, x1, y1, z1, col, mat, uvScale = 0) {
  const faces = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], z1 - z0],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], z1 - z0],
    [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], x1 - x0],
    [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], x1 - x0],
    [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], 0],
    [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], 0],
  ];
  for (const [n, q, w] of faces) {
    // uv in metres on the walls (for windows); the roof and floor use the plain material.
    const h = y1 - y0, wall = uvScale && n[1] === 0;
    const m = wall ? mat : mat === MAT.wall ? MAT.matte : mat;
    const uv = wall ? [[0, 0], [0, h], [w, h], [w, 0]] : [[0, 0], [0, 1], [1, 1], [1, 0]];
    const ids = q.map((p, i) => g.vert(p, n, col, uv[i], m));
    g.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

// Ellipsoid; flat=true gives faceted shading (rocks, foliage), otherwise smooth.
function ellipsoid(g, c, r, col, mat, seg = 12, flat = false, jitter = 0, seed = 1) {
  const R = rand(seed), rows = Math.max(4, seg >> 1), base = g.n;
  const bump = {};
  for (let i = 0; i <= rows; i++) {
    const th = (i / rows) * Math.PI;
    for (let j = 0; j <= seg; j++) {
      const ph = (j / seg) * Math.PI * 2;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      const key = `${i}:${j % seg}`;
      if (!bump[key]) bump[key] = i === 0 || i === rows ? 1 : 1 + (R() - 0.5) * jitter;
      const k = bump[key];
      g.vert([c[0] + n[0] * r[0] * k, c[1] + n[1] * r[1] * k, c[2] + n[2] * r[2] * k], flat ? ZERO : norm([n[0] / r[0], n[1] / r[1], n[2] / r[2]]), col, [j / seg, i / rows], mat);
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < seg; j++) {
    const a = base + i * (seg + 1) + j, b = a + seg + 1;
    g.quad(a, b, b + 1, a + 1);
  }
}

// Tapered tube between two points (trunks, limbs, struts).
function tube(g, p0, p1, r0, r1, col, mat, seg = 7, cap = true) {
  const ax = norm(sub(p1, p0));
  const u = norm(cross(Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], ax)), w = cross(ax, u);
  const base = g.n, tops = [];
  for (let j = 0; j <= seg; j++) {
    const a = (j / seg) * Math.PI * 2, d = [u[0] * Math.cos(a) + w[0] * Math.sin(a), u[1] * Math.cos(a) + w[1] * Math.sin(a), u[2] * Math.cos(a) + w[2] * Math.sin(a)];
    const top = [p1[0] + d[0] * r1, p1[1] + d[1] * r1, p1[2] + d[2] * r1];
    tops.push(top);
    g.vert([p0[0] + d[0] * r0, p0[1] + d[1] * r0, p0[2] + d[2] * r0], d, col, [j / seg, 0], mat);
    g.vert(top, d, col, [j / seg, 1], mat);
  }
  for (let j = 0; j < seg; j++) g.quad(base + j * 2, base + j * 2 + 1, base + j * 2 + 3, base + j * 2 + 2);
  if (cap) {
    const c = g.vert(p1, ax, col, [0, 0], mat);
    const ring = tops.slice(0, seg).map((q) => g.vert(q, ax, col, [0, 0], mat));
    for (let j = 0; j < seg; j++) g.tri(c, ring[j], ring[(j + 1) % seg]);
  }
}

// Disc or ring facing +Z (or -Z) at depth z.
function annulus(g, z, r0, r1, col, mat, seg, facing = 1) {
  const n = [0, 0, facing], base = g.n;
  for (let j = 0; j <= seg; j++) {
    const a = (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    g.vert([c * r0, s * r0, z], n, col, [0, 0], mat);
    g.vert([c * r1, s * r1, z], n, col, [0, 0], mat);
  }
  for (let j = 0; j < seg; j++) g.quad(base + j * 2, base + j * 2 + 1, base + j * 2 + 3, base + j * 2 + 2);
}

/* ------------------------------------------------------------------ cars */

// Body proportions in metres (x: rear -L/2 to front +L/2). belt = top of the lower body,
// nose = bonnet height at the front, rb/rt/ft/fb = cabin rear base/top and front top/base
// (the windscreen runs from fb up to ft), roof = roof height, rf/rr = corner rounding.
const SHAPES = {
  hatchback: { clear: 0.17, belt: 0.84, nose: 0.66, rb: -1.6, rt: -1.22, ft: 0.1, fb: 0.86, roof: 1.46, rf: 0.5, rr: 0.32, pillars: [-0.5], track: 0.94 },
  rally: { clear: 0.15, belt: 0.8, nose: 0.6, rb: -1.66, rt: -1.28, ft: 0.16, fb: 0.96, roof: 1.38, rf: 0.5, rr: 0.32, pillars: [-0.52], wing: true, track: 0.97 },
  pickup: { clear: 0.3, belt: 1.02, nose: 0.94, rb: -0.42, rt: -0.36, ft: 0.52, fb: 1.12, roof: 1.86, rf: 0.42, rr: 0.18, pillars: [], bed: [-1.9, -0.5], track: 0.95 },
  bus: { clear: 0.3, belt: 1.12, nose: 1.06, rb: -2.84, rt: -2.78, ft: 2.52, fb: 2.84, roof: 2.72, rf: 0.32, rr: 0.24, pillars: [-1.8, -0.7, 0.4, 1.5], track: 0.93 },
};

function bodyProfile(P, L, W) {
  const half = L / 2;
  return (x) => {
    const ax = Math.abs(x), r = x > 0 ? P.rf : P.rr;
    const u = clamp((ax - (half - r)) / r, 0, 1);
    const e = 1 - Math.sqrt(1 - u * u); // 0 in the middle, 1 at the very end
    let top = P.belt;
    if (x > P.fb) top = P.belt + (P.nose - P.belt) * ((x - P.fb) / (half - P.fb)) ** 1.5;
    top -= 0.1 * e;
    const bot = P.clear + 0.1 * e;
    return { hw: (W / 2) * (1 - 0.48 * e), top, bot };
  };
}

function lowerBody(g, P, L, W) {
  const prof = bodyProfile(P, L, W), half = L / 2;
  const keys = [P.fb, P.rb, half - P.rf, -half + P.rr];
  const xs = [];
  for (let i = 0; i <= 34; i++) xs.push(-half + (i / 34) * L);
  for (const k of keys) if (k > -half && k < half) xs.push(k);
  for (let i = 1; i <= 5; i++) { xs.push(half - P.rf * (1 - (i / 6) ** 2)); xs.push(-half + P.rr * (1 - (i / 6) ** 2)); }
  xs.sort((a, b) => a - b);
  const RING = 22, v0 = g.n, i0 = g.ix.length;
  const exp = 0.36; // superellipse 2/n with n about 5.5: flat sides, rounded edges
  const ringAt = (x) => {
    const { hw, top, bot } = prof(x), cy = (top + bot) / 2, hy = (top - bot) / 2;
    const out = [];
    for (let j = 0; j < RING; j++) {
      const a = (j / RING) * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
      out.push(g.vert([x, cy + hy * Math.sign(s) * Math.abs(s) ** exp, hw * Math.sign(c) * Math.abs(c) ** exp], ZERO, [1, 1, 1], [0, 0], MAT.paint));
    }
    return out;
  };
  const rings = xs.map(ringAt);
  for (let i = 0; i + 1 < rings.length; i++) for (let j = 0; j < RING; j++) {
    const j2 = (j + 1) % RING;
    g.quad(rings[i][j], rings[i + 1][j], rings[i + 1][j2], rings[i][j2]);
  }
  for (const [ring, x] of [[rings[0], xs[0]], [rings[rings.length - 1], xs[xs.length - 1]]]) {
    const { top, bot } = prof(x);
    const c = g.vert([x + Math.sign(x) * 0.02, (top + bot) / 2, 0], ZERO, [1, 1, 1], [0, 0], MAT.paint);
    for (let j = 0; j < RING; j++) g.tri(c, ring[j], ring[(j + 1) % RING]);
  }
  g.smooth(v0, i0, (p) => {
    const { top, bot } = prof(clamp(p[0], -half, half));
    return [p[0] * 0.8, (top + bot) / 2, 0];
  });
  return prof;
}

// Glasshouse: windscreen, side windows and rear window in glass, roof and pillars in paint.
function cabin(g, P, prof) {
  const base = P.belt - 0.06;
  const hAt = (x) => (x < P.rt ? (x - P.rb) / (P.rt - P.rb) : x > P.ft ? (P.fb - x) / (P.fb - P.ft) : 1);
  const xs = [];
  for (let i = 0; i <= 24; i++) xs.push(P.rb + ((P.fb - P.rb) * i) / 24);
  xs.push(P.rt, P.ft);
  for (const px of P.pillars) xs.push(px - 0.07, px + 0.07);
  xs.sort((a, b) => a - b);
  const prof2 = (x) => {
    const h = clamp(hAt(x), 0, 1), hw = prof(x).hw * 0.9, H = (P.roof - base) * h;
    // cross-section: base left, top left, roof edge left, roof edge right, top right, base right
    return { h, pts: [[-hw, 0], [-hw * 0.8, 0.86 * H], [-hw * 0.72, H], [hw * 0.72, H], [hw * 0.8, 0.86 * H], [hw, 0]] };
  };
  const white = [1, 1, 1];
  for (let i = 0; i + 1 < xs.length; i++) {
    const xa = xs[i], xb = xs[i + 1];
    if (xb - xa < 1e-4) continue;
    const A = prof2(xa), B = prof2(xb), mid = (xa + xb) / 2;
    const roofFull = A.h > 0.999 && B.h > 0.999;
    const pillar = P.pillars.some((px) => Math.abs(mid - px) < 0.07);
    for (let sgm = 0; sgm < 5; sgm++) {
      let mat = MAT.glass;
      if (sgm === 1 || sgm === 3) mat = MAT.paint;
      else if (sgm === 2) mat = roofFull ? MAT.paint : MAT.glass;
      else if (pillar) mat = MAT.paint;
      const p = (S, k, x) => [x, base + S.pts[k][1], S.pts[k][0]];
      const ids = [p(A, sgm, xa), p(B, sgm, xb), p(B, sgm + 1, xb), p(A, sgm + 1, xa)].map((q) => g.vert(q, ZERO, white, [0, 0], mat));
      g.quad(ids[0], ids[1], ids[2], ids[3]);
    }
  }
}

// Where the body's side surface reaches |z| at the front (dir 1) or rear (dir -1).
function surfaceX(prof, L, z, dir) {
  for (let x = (L / 2) * dir; Math.abs(x) > 0; x -= 0.01 * dir) if (prof(x).hw >= z) return x;
  return 0;
}

function buildCarBody(kind) {
  const g = new Geo(), k = CARS[kind], L = k.len / PX, W = k.wid / PX, P = SHAPES[kind];
  const prof = lowerBody(g, P, L, W);
  cabin(g, P, prof);
  const dark = lin('#16181c'), black = lin('#0b0c0e'), plate = lin('#e8e8e2');
  // Lights, grille, bumpers and number plate sit on the rounded ends.
  const hy = P.nose - 0.15, hz = (W / 2) * 0.6;
  const fx = surfaceX(prof, L, hz, 1);
  for (const sz of [-1, 1]) box(g, fx - 0.2, hy - 0.06, sz * hz - 0.17, fx + 0.012, hy + 0.06, sz * hz + 0.17, ZERO, MAT.head);
  const gx = surfaceX(prof, L, 0.3, 1);
  box(g, gx - 0.2, hy - 0.2, -hz + 0.2, gx + 0.01, hy - 0.04, hz - 0.2, dark, MAT.matte);
  const bx = surfaceX(prof, L, W * 0.4, 1);
  box(g, bx - 0.25, P.clear + 0.02, -W * 0.44, bx + 0.02, P.clear + 0.16, W * 0.44, black, MAT.matte);
  const ty = P.belt - 0.14, tz = (W / 2) * 0.7, rx = surfaceX(prof, L, tz, -1);
  for (const sz of [-1, 1]) box(g, rx - 0.012, ty - 0.07, sz * tz - 0.15, rx + 0.2, ty + 0.07, sz * tz + 0.15, ZERO, MAT.tail);
  const px = surfaceX(prof, L, 0.25, -1);
  box(g, px - 0.012, P.clear + 0.24, -0.25, px + 0.1, P.clear + 0.36, 0.25, plate, MAT.matte);
  const rbx = surfaceX(prof, L, W * 0.4, -1);
  box(g, rbx - 0.02, P.clear + 0.02, -W * 0.44, rbx + 0.25, P.clear + 0.16, W * 0.44, black, MAT.matte);
  // Door mirrors.
  for (const sz of [-1, 1]) {
    const zi = sz * (W / 2 - 0.06), zo = sz * (W / 2 + 0.07);
    box(g, P.fb - 0.26, P.belt + 0.06, Math.min(zi, zo), P.fb - 0.14, P.belt + 0.16, Math.max(zi, zo), ZERO, MAT.paint);
  }
  if (P.wing) {
    const x0 = -L / 2 + 0.06;
    for (const sz of [-0.45, 0.45]) box(g, x0 + 0.08, P.belt - 0.05, sz - 0.03, x0 + 0.2, P.belt + 0.42, sz + 0.03, dark, MAT.matte);
    box(g, x0 - 0.04, P.belt + 0.42, -W / 2 + 0.08, x0 + 0.34, P.belt + 0.47, W / 2 - 0.08, ZERO, MAT.paint);
  }
  if (P.bed) box(g, P.bed[0], P.belt - 0.2, -W / 2 + 0.12, P.bed[1], P.belt + 0.01, W / 2 - 0.12, dark, MAT.matte);
  const ph = k.phys, wb = ph.wheelbase / 2, wr = ph.wheelR, ww = kind === 'bus' ? 0.28 : 0.22;
  const tz2 = (W / 2) * P.track - ww / 2 + 0.03;
  return {
    g, L, W,
    wheels: [[wb, wr, -tz2, true], [wb, wr, tz2, true], [-wb, wr, -tz2, false], [-wb, wr, tz2, false]],
    wheel: { r: wr, w: ww },
  };
}

function buildScooter() {
  const g = new Geo(), dark = lin('#1b1d21'), seat = lin('#222428'), jacket = lin('#37474f'), jeans = lin('#283593'), skin = lin('#8d6e63');
  ellipsoid(g, [-0.45, 0.6, 0], [0.55, 0.26, 0.2], ZERO, MAT.paint, 16);
  ellipsoid(g, [0.66, 0.5, 0], [0.26, 0.08, 0.1], ZERO, MAT.paint, 12);
  box(g, -0.2, 0.28, -0.17, 0.36, 0.36, 0.17, dark, MAT.matte);
  g.T = chain(M.t(0.44, 0.3, 0), M.rz(0.22));
  box(g, -0.05, 0, -0.2, 0.06, 0.74, 0.2, ZERO, MAT.paint);
  box(g, 0.055, 0.6, -0.08, 0.075, 0.7, 0.08, ZERO, MAT.head);
  g.T = null;
  tube(g, [0.62, 0.32, 0], [0.4, 1.02, 0], 0.03, 0.03, dark, MAT.chrome, 6, false);
  tube(g, [0.4, 1.04, -0.36], [0.4, 1.04, 0.36], 0.022, 0.022, dark, MAT.matte, 6);
  box(g, -1.0, 0.56, -0.1, -0.97, 0.64, 0.1, ZERO, MAT.tail);
  ellipsoid(g, [-0.42, 0.86, 0], [0.32, 0.07, 0.17], seat, MAT.matte, 12);
  // Rider.
  g.T = chain(M.t(-0.3, 1.2, 0), M.rz(-0.32));
  ellipsoid(g, [0, 0, 0], [0.16, 0.32, 0.2], jacket, MAT.matte, 12);
  g.T = null;
  ellipsoid(g, [-0.12, 1.6, 0], [0.15, 0.15, 0.14], ZERO, MAT.paint, 14);
  ellipsoid(g, [-0.02, 1.6, 0], [0.07, 0.07, 0.11], ZERO, MAT.glass, 10);
  ellipsoid(g, [-0.14, 1.46, 0], [0.06, 0.05, 0.06], skin, MAT.matte, 8);
  for (const sz of [-1, 1]) {
    tube(g, [-0.18, 1.4, sz * 0.19], [0.1, 1.15, sz * 0.27], 0.05, 0.045, jacket, MAT.matte, 6, false);
    tube(g, [0.1, 1.15, sz * 0.27], [0.38, 1.05, sz * 0.32], 0.045, 0.04, jacket, MAT.matte, 6);
    tube(g, [-0.38, 0.92, sz * 0.12], [-0.02, 0.8, sz * 0.16], 0.075, 0.065, jeans, MAT.matte, 6, false);
    tube(g, [-0.02, 0.8, sz * 0.16], [0.1, 0.38, sz * 0.15], 0.06, 0.05, jeans, MAT.matte, 6);
    box(g, 0.02, 0.33, sz * 0.15 - 0.05, 0.22, 0.4, sz * 0.15 + 0.05, dark, MAT.matte);
  }
  const ph = CARS.scooter.phys, wr = ph.wheelR;
  return { g, L: 2.0, W: 0.7, wheels: [[0.72, wr, 0, true], [-0.72, wr, 0, false]], wheel: { r: wr, w: 0.11 }, lean: true };
}

function buildWheel(r, w) {
  const g = new Geo(), seg = 26, tyre = [0.02, 0.02, 0.02], barrel = lin('#2a2d31');
  const rr = r * 0.63;
  // Tread with rounded shoulders.
  const rings = [[-w / 2, r - 0.035], [-w / 2 + 0.03, r], [w / 2 - 0.03, r], [w / 2, r - 0.035]];
  const v0 = g.n, i0 = g.ix.length;
  const ids = rings.map(([z, rad]) => {
    const row = [];
    for (let j = 0; j <= seg; j++) { const a = (j / seg) * Math.PI * 2; row.push(g.vert([Math.cos(a) * rad, Math.sin(a) * rad, z], ZERO, tyre, [0, 0], MAT.tyre)); }
    return row;
  });
  for (let i = 0; i < 3; i++) for (let j = 0; j < seg; j++) g.quad(ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]);
  g.smooth(v0, i0, (p) => [0, 0, p[2]]);
  annulus(g, w / 2, rr, r - 0.035, tyre, MAT.tyre, seg, 1);
  annulus(g, -w / 2, 0, r - 0.035, tyre, MAT.tyre, seg, -1);
  // Rim: dark barrel, bright lip, five spokes and a hub.
  annulus(g, w / 2 - 0.045, 0, rr, barrel, MAT.matte, seg, 1);
  annulus(g, w / 2 - 0.012, rr * 0.9, rr, ZERO, MAT.chrome, seg, 1);
  for (let i = 0; i < 5; i++) {
    g.T = chain(M.t(0, 0, w / 2 - 0.03), M.rz((i / 5) * Math.PI * 2));
    box(g, r * 0.13, -r * 0.055, -0.012, rr * 0.92, r * 0.055, 0.012, ZERO, MAT.chrome);
    g.T = null;
  }
  annulus(g, w / 2 - 0.008, 0, r * 0.17, ZERO, MAT.chrome, 12, 1);
  return g;
}

/* ------------------------------------------------------------------ world */

function propGeo(g, kind, p, R, accent) {
  const s = p.s, X = p.x / PX, Z = p.y / PX;
  g.T = chain(M.t(X, 0, Z), M.ry(p.rot));
  switch (kind) {
    case 'palm': {
      const H = 5.5 * s + R() * 2, lean = 0.6 + R() * 0.8, trunk = lin('#7b5e43'), trunk2 = lin('#5d4632');
      let prev = [0, 0, 0];
      for (let i = 1; i <= 6; i++) {
        const t = i / 6, q = [lean * t * t, H * t, 0];
        tube(g, prev, q, 0.24 - 0.1 * (t - 1 / 6), 0.24 - 0.1 * t, i % 2 ? trunk : trunk2, MAT.matte, 7, false);
        prev = q;
      }
      for (let f = 0; f < 8; f++) {
        const a = (f / 8) * Math.PI * 2 + R() * 0.4, len = 2.6 * s + R() * 0.6;
        const d = [Math.cos(a), 0, Math.sin(a)], side = [-d[2], 0, d[0]];
        const col = lin(f % 2 ? '#43a047' : '#2e7d32');
        let last = null;
        for (let i = 0; i <= 6; i++) {
          const t = i / 6, w = 0.42 * s * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05));
          const c = [prev[0] + d[0] * len * t, prev[1] + 0.5 * s * t - 1.7 * s * t * t, prev[2] + d[2] * len * t];
          const l = g.vert([c[0] + side[0] * w, c[1], c[2] + side[2] * w], ZERO, col, [0, 0], MAT.matte);
          const r = g.vert([c[0] - side[0] * w, c[1] - 0.05, c[2] - side[2] * w], ZERO, col, [0, 0], MAT.matte);
          if (last) g.quad(last[0], l, r, last[1]);
          last = [l, r];
        }
      }
      break;
    }
    case 'building':
    case 'neon': {
      const neon = kind === 'neon';
      const w = 6 * s, d = 4.6 * s, h = neon ? 10 + p.v * 26 : 5 + p.v * 14;
      const walls = neon ? ['#2b3245', '#323a52', '#263043'] : ['#e0c9a6', '#b0bec5', '#ffccbc', '#c5e1a5', '#d7ccc8'];
      const col = lin(walls[Math.floor(p.v * walls.length) % walls.length]);
      g.T = chain(M.t(X, 0, Z), M.ry(Math.round(p.rot / (Math.PI / 2)) * (Math.PI / 2)));
      box(g, -w / 2, 0, -d / 2, w / 2, h, d / 2, col, MAT.wall, 1);
      box(g, -w / 2 - 0.15, h, -d / 2 - 0.15, w / 2 + 0.15, h + 0.3, d / 2 + 0.15, col.map((c) => c * 0.7), MAT.matte);
      if (neon) {
        const glow = lin(['#40c4ff', '#ff4081', '#b388ff', '#69f0ae'][Math.floor(p.v * 4) % 4]);
        box(g, -w / 2 - 0.2, h - 0.6, -d / 2 - 0.2, w / 2 + 0.2, h - 0.35, d / 2 + 0.2, glow, MAT.glow);
      } else {
        box(g, w / 2 - 1.6, h + 0.3, -0.6, w / 2 - 0.4, h + 1.2, 0.6, lin('#9e9e9e'), MAT.matte);
      }
      break;
    }
    case 'cane': {
      const cols = [lin('#9ccc65'), lin('#7cb342'), lin('#c0ca33')];
      for (let b = 0; b < 26; b++) {
        const a = R() * Math.PI * 2, r0 = R() * 1.3 * s, h = (2.4 + R() * 1.6) * s, tilt = 0.18 + R() * 0.3;
        const bx = Math.cos(a) * r0, bz = Math.sin(a) * r0, side = [-Math.sin(a) * 0.16, 0, Math.cos(a) * 0.16];
        const top = [bx + Math.cos(a) * h * tilt, h, bz + Math.sin(a) * h * tilt];
        const col = cols[b % 3];
        const i0 = g.vert([bx - side[0], 0, bz - side[2]], ZERO, col, [0, 0], MAT.matte);
        const i1 = g.vert([bx + side[0], 0, bz + side[2]], ZERO, col, [0, 0], MAT.matte);
        const i2 = g.vert(top, ZERO, col, [0, 0], MAT.matte);
        g.tri(i0, i1, i2);
      }
      break;
    }
    case 'rock': {
      ellipsoid(g, [0, 0.3 * s, 0], [1.5 * s, 1.0 * s, 1.2 * s], lin(R() < 0.5 ? '#5d4a46' : '#4e3f3c'), MAT.matte, 9, true, 0.45, Math.floor(p.v * 1e6));
      break;
    }
    case 'coral': {
      const cols = ['#ff80ab', '#ff8a65', '#ba68c8', '#4dd0e1'];
      const col = lin(cols[Math.floor(p.v * 4) % 4]);
      for (let b = 0; b < 6; b++) {
        const a = R() * Math.PI * 2, h = (1 + R() * 1.4) * s;
        tube(g, [Math.cos(a) * 0.2, 0, Math.sin(a) * 0.2], [Math.cos(a) * h * 0.4, h, Math.sin(a) * h * 0.4], 0.16 * s, 0.07 * s, col, MAT.matte, 6);
      }
      ellipsoid(g, [0, 0.2, 0], [0.6 * s, 0.35 * s, 0.6 * s], col.map((c) => c * 0.75), MAT.matte, 8, true, 0.4, 7);
      break;
    }
    case 'star': {
      const col = lin(accent);
      for (let b = 0; b < 3; b++) {
        const a = R() * Math.PI * 2, h = (1.2 + R() * 2.2) * s;
        g.T = chain(M.t(X + Math.cos(a) * 0.8, 0, Z + Math.sin(a) * 0.8), M.rz((R() - 0.5) * 0.5), M.ry(R() * 3));
        ellipsoid(g, [0, h / 2, 0], [0.35 * s, h / 2, 0.35 * s], col, MAT.glow, 4, true);
      }
      g.T = chain(M.t(X, 0, Z), M.ry(p.rot));
      ellipsoid(g, [0, 0.1, 0], [1.2 * s, 0.4 * s, 1.0 * s], lin('#2a2e52'), MAT.matte, 8, true, 0.4, 3);
      break;
    }
    default: { // rainforest tree
      const trunk = lin('#5d4037');
      tube(g, [0, 0, 0], [0, 3.4 * s, 0], 0.28 * s, 0.2 * s, trunk, MAT.matte, 7, false);
      const greens = ['#2e7d32', '#388e3c', '#1b5e20'];
      for (let b = 0; b < 3; b++) {
        const r = (1.9 - b * 0.35) * s;
        ellipsoid(g, [(R() - 0.5) * 1.2 * s, (3.6 + b * 1.1) * s, (R() - 0.5) * 1.2 * s], [r, r * 0.8, r], lin(greens[b]), MAT.matte, 8, true, 0.3, b + 11);
      }
    }
  }
  g.T = null;
}

function buildWorld(s) {
  const g = new Geo(), { track } = s, th = s.theme, key = s.spec.theme;
  const W = track.w / PX, H = track.h / PX, pad = 420;
  const up = [0, 1, 0], white = [1, 1, 1];
  // Ground (striped in the shader), then sand and sea on the coast.
  const gq = [[-pad, 0, -pad], [-pad, 0, H + pad], [W + pad, 0, H + pad], [W + pad, 0, -pad]].map((p) => g.vert(p, up, white, [0, 0], MAT.ground));
  g.quad(gq[0], gq[1], gq[2], gq[3]);
  if (s.seaY) {
    const sz = s.seaY / PX, sand = lin('#d9c08f');
    const sq = [[-pad, 0.006, sz - 4], [-pad, 0.006, sz], [W + pad, 0.006, sz], [W + pad, 0.006, sz - 4]].map((p) => g.vert(p, up, sand, [0, 0], MAT.matte));
    g.quad(sq[0], sq[1], sq[2], sq[3]);
    const wq = [[-pad, 0.01, sz], [-pad, 0.01, H + pad], [W + pad, 0.01, H + pad], [W + pad, 0.01, sz]].map((p) => g.vert(p, up, white, [0, 0], MAT.water));
    g.quad(wq[0], wq[1], wq[2], wq[3]);
  }
  for (const p of s.pools) {
    const c = g.vert([p.x / PX, 0.012, p.y / PX], up, white, [0, 0], MAT.lava);
    const ring = [];
    for (let j = 0; j < 24; j++) {
      const a = (j / 24) * Math.PI * 2, r = (p.r / PX) * (0.85 + 0.15 * Math.sin(j * 1.7));
      ring.push(g.vert([p.x / PX + Math.cos(a) * r, 0.012, p.y / PX + Math.sin(a) * r], up, white, [0, 0], MAT.lava));
    }
    for (let j = 0; j < 24; j++) g.tri(c, ring[j], ring[(j + 1) % 24]);
  }
  // Road and kerbs as strips along the centre line. Each lap of the strip sits a few mm
  // higher than the last point so the figure-eight crossing does not flicker.
  const { pts, N, half } = track;
  const kerb = 11;
  let dist = 0;
  const strip = (from, to, y, mat, uOf) => {
    let prev = null, d = 0;
    for (let i = 0; i <= N; i++) {
      const p = pts[i % N];
      if (i) d += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) / PX;
      const sn = Math.sin(p.a), cs = Math.cos(p.a), yy = y + 0.004 * (i / N);
      const a = g.vert([(p.x - sn * from) / PX, yy, (p.y + cs * from) / PX], up, white, [uOf(from), d], mat);
      const b = g.vert([(p.x - sn * to) / PX, yy, (p.y + cs * to) / PX], up, white, [uOf(to), d], mat);
      if (prev) g.quad(prev[0], a, b, prev[1]);
      prev = [a, b];
    }
    dist = d;
  };
  strip(-half, half, 0.02, MAT.road, (d) => d / half);
  strip(half, half + kerb, 0.03, MAT.kerb, () => 0);
  strip(-half - kerb, -half, 0.03, MAT.kerb, () => 0);
  // Start gantry.
  const p0 = pts[0];
  g.T = chain(M.t(p0.x / PX, 0, p0.y / PX), M.heading(p0.a));
  const hw = (half + 24) / PX, post = lin('#cfd2d6');
  for (const z of [-hw, hw]) box(g, -0.2, 0, z - 0.2, 0.2, 5.4, z + 0.2, post, MAT.matte);
  box(g, -0.3, 4.6, -hw, 0.3, 5.5, hw, lin(th.accent), MAT.matte);
  box(g, -0.32, 4.75, -hw * 0.6, 0.32, 5.35, hw * 0.6, lin('#111111'), MAT.matte);
  g.T = null;
  for (const b of s.boosts) {
    g.T = chain(M.t(b.x / PX, 0.035, b.y / PX), M.heading(b.a));
    const q = [[-2.6, 0, -1.8, -1, 0], [-2.6, 0, 1.8, 1, 0], [2.6, 0, 1.8, 1, 1], [2.6, 0, -1.8, -1, 1]].map((v) => g.vert([v[0], v[1], v[2]], up, white, [v[3], v[4]], MAT.boost));
    g.quad(q[0], q[1], q[2], q[3]);
    g.T = null;
  }
  const R = rand(s.spec.map.seed * 977 + 13);
  for (const p of s.props) propGeo(g, th.prop, p, R, th.accent);
  return { g, roadLen: dist };
}

function obstacleGeo(key) {
  const g = new Geo();
  if (key === 'suva-city' || key === 'night-city') {
    const orange = lin('#ff6d00'), white = lin('#f5f5f5');
    for (const [x, z] of [[0.5, 0], [-0.35, 0.55], [-0.35, -0.55]]) {
      box(g, x - 0.28, 0, z - 0.28, x + 0.28, 0.05, z + 0.28, lin('#212121'), MAT.matte);
      tube(g, [x, 0.05, z], [x, 0.42, z], 0.24, 0.15, orange, MAT.matte, 10, false);
      tube(g, [x, 0.42, z], [x, 0.56, z], 0.15, 0.11, white, MAT.matte, 10, false);
      tube(g, [x, 0.56, z], [x, 0.85, z], 0.11, 0.02, orange, MAT.matte, 10);
    }
  } else if (key === 'reef') {
    ellipsoid(g, [0, 0.55, 0], [1.0, 0.75, 1.0], lin('#ffeb3b'), MAT.matte, 14);
    tube(g, [0, 0.5, 0], [0, 0.78, 0], 1.04, 0.98, lin('#e53935'), MAT.matte, 14, false);
  } else if (key === 'volcano' || key === 'rainforest' || key === 'space') {
    ellipsoid(g, [0, 0.45, 0], [1.4, 1.0, 1.3], lin(key === 'space' ? '#5c6390' : '#6d5f5a'), MAT.matte, 9, true, 0.35, 5);
  } else {
    const wood = lin('#a1887f'), dark = lin('#6d4c41');
    box(g, -0.8, 0, -0.8, 0.8, 1.3, 0.8, wood, MAT.matte);
    for (const y of [0.05, 1.2]) box(g, -0.83, y, -0.83, 0.83, y + 0.08, 0.83, dark, MAT.matte);
    g.T = M.ry(0.5);
    box(g, -0.55, 1.3, -0.55, 0.55, 2.0, 0.55, wood, MAT.matte);
    g.T = null;
  }
  return g;
}

/* ------------------------------------------------------------------ GL */

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec3 aCol;
layout(location=3) in vec2 aUV;
layout(location=4) in float aMat;
uniform mat4 uVP;
uniform mat4 uModel;
out vec3 vPos; out vec3 vNrm; out vec3 vCol; out vec2 vUV; flat out int vMat;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vPos = w.xyz; vNrm = mat3(uModel) * aNrm; vCol = aCol; vUV = aUV; vMat = int(aMat + 0.5);
  gl_Position = uVP * w;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNrm; in vec3 vCol; in vec2 vUV; flat in int vMat;
uniform vec3 uCam, uSun, uSunCol, uSkyTop, uSkyHor, uG1, uG2, uRoad, uK1, uK2, uWater, uAccent, uPaint;
uniform float uTime, uBrake, uFogNear, uFogFar, uNight, uExposure;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 skyCol(vec3 d) { return mix(uSkyHor, uSkyTop, sqrt(clamp(d.y * 1.4, 0.0, 1.0))); }
vec3 finish(vec3 col) { col = vec3(1.0) - exp(-col * uExposure); return pow(col, vec3(1.0 / 2.2)); }
void main() {
  int m = vMat;
  if (m == 10) { outColor = vec4(0.0, 0.0, 0.0, (1.0 - smoothstep(0.3, 1.0, length(vUV))) * 0.55); return; }
  if (m == 15) { outColor = vec4(0.02, 0.02, 0.02, vCol.r * 0.5); return; }
  vec3 N = dot(vNrm, vNrm) > 1e-6 ? normalize(vNrm) : normalize(cross(dFdx(vPos), dFdy(vPos)));
  vec3 V = normalize(uCam - vPos);
  vec3 base = vCol; float spec = 0.04, gloss = 12.0, coat = 0.0, emis = 0.0;
  if (m == 1) { base = uPaint; spec = 0.45; gloss = 70.0; coat = 0.75; }
  else if (m == 2) { base = vec3(0.01, 0.013, 0.018); spec = 1.0; gloss = 180.0; coat = 1.0; }
  else if (m == 3) { base = vec3(0.62, 0.64, 0.68); spec = 1.4; gloss = 80.0; coat = 0.5; }
  else if (m == 4) { base = vec3(0.016); spec = 0.06; gloss = 10.0; }
  else if (m == 5) { base = vec3(1.0, 0.95, 0.82); emis = 1.8; }
  else if (m == 6) { base = vec3(0.45, 0.01, 0.01); emis = 0.3 + uBrake * 3.0; }
  else if (m == 7) {
    float b = step(0.5, fract(vPos.z / 14.0));
    base = mix(uG1, uG2, b) * (0.84 + 0.3 * noise(vPos.xz * 0.45) + 0.06 * noise(vPos.xz * 4.0));
  } else if (m == 8) {
    base = uRoad * (0.78 + 0.3 * noise(vPos.xz * 2.5) + 0.12 * noise(vPos.xz * 18.0));
    float u = abs(vUV.x), v = vUV.y;
    float edge = step(0.87, u) * step(u, 0.93);
    float dash = step(u, 0.025) * step(fract(v / 6.4), 0.5);
    base = mix(base, vec3(0.78), max(edge, dash) * 0.85);
    if (v < 2.7) { float c = mod(floor((vUV.x + 1.0) * 5.0) + floor(v / 1.35), 2.0); base = mix(vec3(0.82), vec3(0.01), c); }
    spec = 0.15; gloss = 28.0;
  } else if (m == 9) { base = mix(uK1, uK2, step(0.5, fract(vUV.y / 2.0))); spec = 0.1; }
  else if (m == 11) {
    base = uWater;
    N = normalize(vec3(sin(vPos.x * 0.7 + uTime * 1.4) * 0.05 + sin(vPos.z * 2.1 + uTime * 2.3) * 0.02, 1.0, cos(vPos.z * 0.9 + uTime * 1.1) * 0.05));
    spec = 1.2; gloss = 120.0; coat = 0.85;
  } else if (m == 12) {
    float ch = step(0.5, fract(vUV.y * 2.0 - abs(vUV.x) * 0.9 - uTime * 2.5));
    base = mix(uAccent, vec3(1.0), ch * 0.7); emis = 0.6;
  } else if (m == 13) {
    base = mix(vec3(0.9, 0.16, 0.0), vec3(1.0, 0.62, 0.12), noise(vPos.xz * 0.6 + uTime * 0.4)); emis = 1.5;
  } else if (m == 14) { emis = 1.6; }
  else if (m == 16) {
    vec2 cell = vUV / vec2(2.6, 3.2), c = fract(cell), id = floor(cell);
    float win = step(0.2, c.x) * step(c.x, 0.8) * step(0.3, c.y) * step(c.y, 0.82);
    if (win > 0.5) {
      base = vec3(0.025, 0.035, 0.045); spec = 0.9; gloss = 90.0; coat = 0.6;
      if (uNight > 0.5 && hash(id + floor(vPos.xz)) > 0.5) { base = vec3(1.0, 0.72, 0.38); emis = 1.0; coat = 0.0; }
    }
  }
  float ndl = max(dot(N, uSun), 0.0);
  vec3 amb = mix(uG1 * 0.5, uSkyTop, N.y * 0.5 + 0.5) * (0.6 - 0.3 * uNight);
  vec3 col = base * (amb + uSunCol * ndl);
  vec3 H = normalize(uSun + V);
  col += uSunCol * spec * pow(max(dot(N, H), 0.0), gloss) * ndl * (gloss + 8.0) / 64.0;
  if (coat > 0.0) {
    float f = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    col = mix(col, skyCol(reflect(-V, N)), clamp(f * coat + (m == 2 ? 0.18 : 0.0), 0.0, 1.0));
  }
  col += base * emis;
  float d = length(vPos - uCam);
  col = mix(col, uSkyHor, smoothstep(uFogNear, uFogFar, d) * 0.92);
  outColor = vec4(finish(col), 1.0);
}`;

const SKY_VS = `#version 300 es
layout(location=0) in vec2 aP;
out vec2 vP;
void main() { vP = aP; gl_Position = vec4(aP, 0.0, 1.0); }`;

const SKY_FS = `#version 300 es
precision highp float;
in vec2 vP;
uniform vec3 uF, uR, uU, uSkyTop, uSkyHor, uSun, uSunCol;
uniform vec2 uTan;
uniform float uNight, uExposure;
out vec4 outColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 d = normalize(uF + uR * vP.x * uTan.x + uU * vP.y * uTan.y);
  vec3 col = mix(uSkyHor, uSkyTop, sqrt(clamp(d.y * 1.4, 0.0, 1.0)));
  float sd = max(dot(d, uSun), 0.0);
  col += uSunCol * (pow(sd, 900.0) * 6.0 + pow(sd, 12.0) * 0.12) * (1.0 - uNight);
  if (uNight > 0.5 && d.y > 0.02) { vec2 q = floor(d.xz / (d.y + 0.3) * 260.0); col += vec3(step(0.9975, hash(q)) * 1.4); }
  col = vec3(1.0) - exp(-col * uExposure);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

function compile(gl, vs, fs) {
  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}

function upload(gl, geo, dynamic = false) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo.v), dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
  const stride = FLOATS * 4;
  [[0, 3, 0], [1, 3, 12], [2, 3, 24], [3, 2, 36], [4, 1, 44]].forEach(([loc, size, off]) => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
  });
  let count = geo.v.length / FLOATS, ib = null;
  if (geo.ix) {
    ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(geo.ix), gl.STATIC_DRAW);
    count = geo.ix.length;
  }
  gl.bindVertexArray(null);
  return { vao, vb, ib, count, indexed: !!geo.ix };
}

/* ------------------------------------------------------------------ view */

export function createView(canvas) {
  let gl = null;
  try { gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' }); } catch { gl = null; }
  if (!gl) return null;
  let prog, sky;
  try {
    prog = compile(gl, VS, FS);
    sky = compile(gl, SKY_VS, SKY_FS);
  } catch (err) {
    console.warn('3D view unavailable:', err.message);
    return null;
  }
  const skyVao = gl.createVertexArray();
  gl.bindVertexArray(skyVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, Float32Array.of(-1, -1, 3, -1, -1, 3), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const meshes = new Map(); // kind -> { body, wheel, info }
  const shadowQuad = (() => {
    const g = new Geo(), up = [0, 1, 0];
    const q = [[-1, 0, -1], [-1, 0, 1], [1, 0, 1], [1, 0, -1]].map((p) => g.vert(p, up, [1, 1, 1], [p[0], p[2]], MAT.shadow));
    g.quad(q[0], q[1], q[2], q[3]);
    return upload(gl, g);
  })();
  const coconut = (() => {
    const g = new Geo();
    ellipsoid(g, [0, 0, 0], [0.4, 0.38, 0.4], lin('#6d4c41'), MAT.matte, 10);
    for (const [x, y] of [[0.25, 0.2], [0.33, 0.05], [0.24, -0.06]]) ellipsoid(g, [x, y, 0.22], [0.06, 0.06, 0.06], lin('#3e2723'), MAT.matte, 6);
    return upload(gl, g);
  })();
  const skidGeo = { v: [], ix: null };
  const skidMesh = upload(gl, { v: new Array(FLOATS * 6).fill(0), ix: null }, true);

  let world = null, worldFor = null, obstacle = null;
  let lost = false;
  const cam = { pos: null, yaw: 0, t: -1, fov: 1.0 };
  const perCar = new Map(); // id -> smoothed body motion and skid trail ends
  const skids = []; // { a:[x,z], b:[x,z], w, life }

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; view.lost = true; });

  function carMesh(kind) {
    if (!meshes.has(kind)) {
      const info = kind === 'scooter' ? buildScooter() : buildCarBody(kind);
      meshes.set(kind, { body: upload(gl, info.g), wheel: upload(gl, buildWheel(info.wheel.r, info.wheel.w)), info });
    }
    return meshes.get(kind);
  }

  function ensureWorld(s) {
    if (worldFor === s.track) return;
    if (world) { gl.deleteVertexArray(world.mesh.vao); gl.deleteBuffer(world.mesh.vb); gl.deleteBuffer(world.mesh.ib); }
    const w = buildWorld(s);
    world = { mesh: upload(gl, w.g) };
    if (obstacle) { gl.deleteVertexArray(obstacle.vao); }
    obstacle = upload(gl, obstacleGeo(s.spec.theme));
    worldFor = s.track;
    perCar.clear();
    skids.length = 0;
    cam.pos = null;
  }

  function draw(mesh, model) {
    gl.uniformMatrix4fv(prog.u.uModel, false, model);
    gl.bindVertexArray(mesh.vao);
    if (mesh.indexed) gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  }

  function updateCamera(s, dt) {
    const me = s.cars[s.pi], L = me.k.len / PX;
    const speed = Math.hypot(me.vx || 0, me.vy || 0);
    const slide = speed > 3 ? Math.atan2(me.vy || 0, Math.max(me.vx || 0, 1)) : 0;
    const yawT = me.ang + slide * 0.55;
    const dist = 3.4 + L * 1.15, height = 1.35 + L * 0.3;
    const X = me.x / PX, Z = me.y / PX;
    if (!cam.pos || dt <= 0 || dt > 0.5) cam.yaw = yawT;
    else cam.yaw = wrapAngle(cam.yaw + wrapAngle(yawT - cam.yaw) * (1 - Math.exp(-dt * 4.5)));
    const want = [X - Math.cos(cam.yaw) * dist, height, Z - Math.sin(cam.yaw) * dist];
    if (!cam.pos || dt <= 0 || dt > 0.5) cam.pos = want;
    else { const f = 1 - Math.exp(-dt * 12); cam.pos = cam.pos.map((v, i) => v + (want[i] - v) * f); }
    const fovT = (58 + 12 * clamp(speed / 45, 0, 1) + (me.boostT > 0 ? 6 : 0)) * (Math.PI / 180);
    cam.fov = dt > 0 && dt < 0.5 ? cam.fov + (fovT - cam.fov) * (1 - Math.exp(-dt * 3)) : fovT;
    cam.look = [X + Math.cos(cam.yaw) * 3, 0.9 + L * 0.08, Z + Math.sin(cam.yaw) * 3];
  }

  function trackSkids(s, dt) {
    for (const c of s.cars) {
      let st = perCar.get(c.id);
      if (!st) { st = { ax: 0, ay: 0, last: null }; perCar.set(c.id, st); }
      const ay = (c.vx || 0) * (c.yawRate || 0), ax = c.ax || 0;
      const f = dt > 0 ? 1 - Math.exp(-dt * 6) : 1;
      st.ax += (ax - st.ax) * f;
      st.ay += (ay - st.ay) * f;
      const sliding = (c.slip || 0) > 0.15 && Math.abs(c.vx || 0) > 6; // past the tyre's peak grip
      if (!sliding || dt <= 0) { st.last = null; continue; }
      const L = c.k.phys.wheelbase / 2, Wd = (c.k.wid / PX) * 0.4;
      const cs = Math.cos(c.ang), sn = Math.sin(c.ang), X = c.x / PX, Z = c.y / PX;
      const wheels = c.kind === 'scooter' ? [[-L, 0]] : [[-L, -Wd], [-L, Wd]];
      const now = wheels.map(([fx, rz]) => [X + cs * fx - sn * rz, Z + sn * fx + cs * rz]);
      if (st.last) {
        for (let i = 0; i < now.length; i++) skids.push({ a: st.last[i], b: now[i], w: c.kind === 'bus' ? 0.3 : 0.2, life: 1 });
        while (skids.length > 1400) skids.shift();
      }
      st.last = now;
    }
  }

  function skidBuffer() {
    const v = skidGeo.v;
    v.length = 0;
    for (const sk of skids) {
      const dx = sk.b[0] - sk.a[0], dz = sk.b[1] - sk.a[1], l = Math.hypot(dx, dz) || 1;
      if (l > 4) continue;
      const nx = (-dz / l) * sk.w * 0.5, nz = (dx / l) * sk.w * 0.5, a = sk.life;
      const quad = [[sk.a[0] - nx, sk.a[1] - nz], [sk.a[0] + nx, sk.a[1] + nz], [sk.b[0] + nx, sk.b[1] + nz], [sk.b[0] - nx, sk.b[1] - nz]];
      for (const k of [0, 1, 2, 0, 2, 3]) v.push(quad[k][0], 0.04, quad[k][1], 0, 1, 0, a, a, a, 0, 0, MAT.skid);
    }
    return v.length / FLOATS;
  }

  function render(s, width, height) {
    if (lost) return;
    ensureWorld(s);
    const dt = cam.t < 0 ? 0 : clamp(s.time - cam.t, 0, 1);
    cam.t = s.time;
    updateCamera(s, dt);
    trackSkids(s, dt);
    for (const sk of skids) sk.life = Math.max(0, sk.life - dt * 0.03);

    const th = s.theme, key = s.spec.theme;
    const night = key === 'night-city' || key === 'space' ? 1 : 0;
    const skyTop = lin(th.sky[0]), skyHor = lin(th.sky[1]);
    const sun = norm([-0.45, 0.72, -0.52]);
    const sunCol = night ? [0.32, 0.36, 0.5] : key === 'volcano' ? [1.6, 1.0, 0.72] : [1.65, 1.55, 1.38];
    const [k1, k2] = kerbColors(key).map(lin);

    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const aspect = width / Math.max(1, height);
    const proj = M.persp(cam.fov, aspect, 0.25, 900);
    const view = M.look(cam.pos, cam.look, [0, 1, 0]);
    const vp = M.mul(proj, view);
    const exposure = night ? 1.6 : 1.15;

    // Sky.
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(sky.p);
    const F = norm(sub(cam.look, cam.pos)), Rv = norm(cross(F, [0, 1, 0])), Uv = cross(Rv, F);
    const tanY = Math.tan(cam.fov / 2);
    gl.uniform3fv(sky.u.uF, F); gl.uniform3fv(sky.u.uR, Rv); gl.uniform3fv(sky.u.uU, Uv);
    gl.uniform2f(sky.u.uTan, tanY * aspect, tanY);
    gl.uniform3fv(sky.u.uSkyTop, skyTop); gl.uniform3fv(sky.u.uSkyHor, skyHor);
    gl.uniform3fv(sky.u.uSun, sun); gl.uniform3fv(sky.u.uSunCol, sunCol);
    gl.uniform1f(sky.u.uNight, night); gl.uniform1f(sky.u.uExposure, exposure);
    gl.bindVertexArray(skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Opaque world.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.useProgram(prog.p);
    const u = prog.u;
    gl.uniformMatrix4fv(u.uVP, false, vp);
    gl.uniform3fv(u.uCam, cam.pos);
    gl.uniform3fv(u.uSun, sun); gl.uniform3fv(u.uSunCol, sunCol);
    gl.uniform3fv(u.uSkyTop, skyTop); gl.uniform3fv(u.uSkyHor, skyHor);
    gl.uniform3fv(u.uG1, lin(th.ground)); gl.uniform3fv(u.uG2, lin(th.ground2));
    gl.uniform3fv(u.uRoad, lin(th.road)); gl.uniform3fv(u.uK1, k1); gl.uniform3fv(u.uK2, k2);
    gl.uniform3fv(u.uWater, lin(th.water)); gl.uniform3fv(u.uAccent, lin(th.accent));
    gl.uniform3fv(u.uPaint, [0.5, 0.5, 0.5]);
    gl.uniform1f(u.uTime, s.time); gl.uniform1f(u.uBrake, 0);
    gl.uniform1f(u.uFogNear, night ? 50 : 80); gl.uniform1f(u.uFogFar, night ? 260 : 380);
    gl.uniform1f(u.uNight, night); gl.uniform1f(u.uExposure, exposure);
    draw(world.mesh, M.id());

    for (const c of s.coconuts) {
      if (c.t > 0) continue;
      const bob = Math.sin(s.time * 4 + c.x) * 0.12;
      draw(coconut, chain(M.t(c.x / PX, 0.55 + bob, c.y / PX), M.ry(s.time * 1.5 + c.y)));
    }
    for (const o of s.obstacles) {
      const wob = o.hitT > 0.8 ? Math.sin(o.hitT * 40) * 0.12 : 0;
      draw(obstacle, chain(M.t(o.x / PX, 0, o.y / PX), M.ry(o.idx * 1.3), M.rx(wob)));
    }

    const countdown = s.phase === 'countdown';
    for (const c of s.cars) {
      const mesh = carMesh(c.kind), info = mesh.info, st = perCar.get(c.id) || { ax: 0, ay: 0 };
      const base = chain(M.t(c.x / PX, 0, c.y / PX), M.heading(c.ang));
      // Body motion: pitch from braking/acceleration, roll from cornering (a scooter leans in).
      const pitch = clamp(st.ax * 0.0045, -0.06, 0.04);
      const roll = info.lean ? clamp(Math.atan2(st.ay, 9.81), -0.75, 0.75) : clamp(-st.ay * 0.0065, -0.07, 0.07);
      const bodyM = info.lean
        ? chain(base, M.rx(roll), M.rz(pitch * 0.5))
        : chain(base, M.t(0, 0.45, 0), M.rz(pitch), M.rx(roll), M.t(0, -0.45, 0));
      gl.uniform3fv(u.uPaint, lin(c.color));
      gl.uniform1f(u.uBrake, c.braking || countdown || (c.finished && Math.abs(c.vx || 0) < 1) ? 1 : 0);
      draw(mesh.body, bodyM);
      const steer = c.steerAng || 0, spin = c.wheelSpin || 0;
      for (const [wx, wy, wz, front] of info.wheels) {
        const frame = info.lean ? bodyM : base;
        let m = chain(frame, M.t(wx, wy, wz), M.ry(front ? -steer : 0));
        if (wz < 0) m = M.mul(m, M.s(1, 1, -1));
        draw(mesh.wheel, M.mul(m, M.rz(-spin)));
      }
    }

    // Transparent decals: contact shadows and skid marks.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const c of s.cars) {
      const info = carMesh(c.kind).info;
      draw(shadowQuad, chain(M.t(c.x / PX, 0.045, c.y / PX), M.heading(c.ang), M.s(info.L * 0.58, 1, info.W * 0.66)));
    }
    const n = skidBuffer();
    if (n) {
      gl.bindBuffer(gl.ARRAY_BUFFER, skidMesh.vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(skidGeo.v), gl.DYNAMIC_DRAW);
      skidMesh.count = n;
      draw(skidMesh, M.id());
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  function dispose() {
    lost = true;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  const view = { render, dispose, lost: false };
  return view;
}
