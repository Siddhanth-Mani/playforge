// Racing: a closed track built from the spec's layout and seed, laps, AI rivals, coconuts to
// collect, boost pads and obstacles. Game logic (create/step/result) has no DOM access, so whole
// races run in Node tests; draw() and thumb() take a 2D canvas context, and racing3d.js draws the
// same state in WebGL.
//
// Units: the world is in pixels with 10 px = 1 m, so speeds in px/s are 10x m/s.
// Cars use a dynamic bicycle model (see drive()): tyre slip angles with a Pacejka-style grip
// curve, load transfer under braking and acceleration, a friction circle on each axle,
// engine power and gears, aerodynamic drag and rolling resistance.
import { rng, THEMES, ordinal } from '../spec.js';
import { clamp, wrapAngle, shade, rrect, byLevel, formatTime } from './core.js';

export const STEP = 10; // distance between track points, in world pixels

export const PX = 10; // pixels per metre
export const G = 9.81;

// max/accel/len/wid are in px (the 2D view and the AI use them); `phys` is the real car in kg,
// metres and watts. Power is set so the car is grip-limited up to vGrip m/s and power-limited
// after that, and drag is solved so the top speed matches `max`.
export const CARS = {
  hatchback: { max: 500, accel: 330, turn: 2.7, len: 34, wid: 18, mass: 1,
    phys: { kg: 1150, wheelbase: 2.45, cgFront: 0.6, cgHeight: 0.52, launch: 8.0, vGrip: 17, drive: 'front', mu: 1.05, steer: 0.62, gears: 5 } },
  rally: { max: 540, accel: 360, turn: 2.8, len: 36, wid: 19, mass: 1,
    phys: { kg: 1250, wheelbase: 2.6, cgFront: 0.55, cgHeight: 0.48, launch: 8.8, vGrip: 19, drive: 'all', mu: 1.12, steer: 0.62, gears: 6 } },
  pickup: { max: 480, accel: 300, turn: 2.45, len: 40, wid: 20, mass: 1.3,
    phys: { kg: 1850, wheelbase: 3.1, cgFront: 0.55, cgHeight: 0.7, launch: 7.0, vGrip: 16, drive: 'rear', mu: 1.0, steer: 0.58, gears: 5 } },
  bus: { max: 440, accel: 270, turn: 2.2, len: 58, wid: 22, mass: 1.8,
    phys: { kg: 4200, wheelbase: 3.9, cgFront: 0.5, cgHeight: 1.0, launch: 4.0, vGrip: 13, drive: 'rear', mu: 0.95, steer: 0.6, gears: 5 } },
  scooter: { max: 470, accel: 380, turn: 3.2, len: 24, wid: 10, mass: 0.6,
    phys: { kg: 260, wheelbase: 1.45, cgFront: 0.48, cgHeight: 0.6, launch: 7.5, vGrip: 16, drive: 'rear', mu: 1.1, steer: 0.5, gears: 6 } },
};
for (const k of Object.values(CARS)) {
  const p = k.phys;
  p.vTop = k.max / PX;                          // m/s
  p.power = p.kg * p.launch * p.vGrip;          // W
  p.rolling = 0.013 * p.kg * G;                 // N
  p.drag = Math.max(0.05, (p.power / p.vTop - p.rolling) / (p.vTop * p.vTop)); // N per (m/s)^2
  p.inertia = p.kg * (p.wheelbase * 0.62) ** 2; // yaw inertia, kg m^2
  p.a = p.wheelbase * (1 - p.cgFront);           // centre of mass to front axle
  p.b = p.wheelbase * p.cgFront;                 // centre of mass to rear axle
  p.wheelR = k.len > 50 ? 0.45 : k.len > 38 ? 0.38 : k.len < 26 ? 0.3 : 0.32;
}
const RIVAL_NAMES = ['Mere', 'Tevita', 'Ana', 'Josaia', 'Salote', 'Ravi', 'Litia', 'Sami'];
const RIVAL_COLORS = ['#1e88e5', '#fdd835', '#43a047', '#8e24aa', '#fb8c00', '#00897b'];

/* ------------------------------------------------------------------ track */

function catmull(ctrl, perSeg) {
  const out = [];
  const n = ctrl.length;
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let j = 0; j < perSeg; j++) {
      const t = j / perSeg, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

function resample(poly, step) {
  const out = [poly[0]];
  let need = step;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let pos = 0;
    while (seg - pos >= need) {
      pos += need;
      const t = pos / seg;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      need = step;
    }
    need -= seg - pos;
  }
  const last = out[out.length - 1];
  if (Math.hypot(last[0] - out[0][0], last[1] - out[0][1]) < step * 0.5) out.pop();
  return out;
}

function roundCorners(poly) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[(i - 1 + n) % n], v = poly[i], q = poly[(i + 1) % n];
    // a point on the incoming edge, then one on the outgoing edge, so the spline rounds the corner
    for (const o of [p, q]) {
      const len = Math.hypot(o[0] - v[0], o[1] - v[1]);
      const c = Math.min(150, len / 2.6);
      out.push([v[0] + ((o[0] - v[0]) * c) / len, v[1] + ((o[1] - v[1]) * c) / len]);
    }
  }
  return out;
}

// Uneven control-point spacing makes Catmull-Rom splines overshoot and loop at tight corners.
function densify(poly, maxLen) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxLen));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

function controlPoints(spec, r) {
  const R = 1000 * [0, 0.8, 1, 1.3][spec.map.length];
  const ctrl = [];
  const layout = spec.map.layout;
  if (layout === 'oval') {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      ctrl.push([Math.cos(a) * R * 1.5, Math.sin(a) * R * 0.75]);
    }
  } else if (layout === 'figure-eight') {
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * Math.PI * 2;
      ctrl.push([Math.sin(t) * R * 1.55, Math.sin(t) * Math.cos(t) * R * 1.5]);
    }
  } else if (layout === 'city-grid') {
    const W = R * 2.6, H = R * 1.5;
    const x1 = W * (0.15 + 0.15 * r()), x2 = x1 + W * (0.18 + 0.1 * r()), d1 = H * (0.22 + 0.12 * r());
    const x3 = W * (0.5 + 0.12 * r()), x4 = x3 + W * (0.18 + 0.1 * r()), d2 = H * (0.22 + 0.12 * r());
    const poly = [[0, 0], [x1, 0], [x1, d1], [x2, d1], [x2, 0], [W, 0], [W, H], [x4, H], [x4, H - d2], [x3, H - d2], [x3, H], [0, H]];
    return densify(roundCorners(poly), 160);
  } else {
    const mountain = layout === 'mountain-pass';
    const n = mountain ? 18 : 14;
    const raw = [];
    for (let i = 0; i < n; i++) raw.push(mountain ? 0.6 + 0.75 * r() : 0.78 + 0.44 * r());
    const rad = raw.map((v, i) => (raw[(i - 1 + n) % n] + 2 * v + raw[(i + 1) % n]) / 4);
    for (let i = 0; i < n; i++) {
      const a = ((i + (r() - 0.5) * 0.5) / n) * Math.PI * 2;
      ctrl.push([Math.cos(a) * R * rad[i] * 1.45, Math.sin(a) * R * rad[i] * 0.85]);
    }
  }
  return ctrl;
}

/** Build the track: evenly spaced centre-line points with heading and how sharply it bends ahead. */
export function buildTrack(spec) {
  const r = rng(spec.map.seed * 7 + 3);
  let pts = resample(catmull(controlPoints(spec, r), 24), STEP);
  let N = pts.length;

  const heading = (arr, i) => {
    const a = arr[(i - 1 + N) % N], b = arr[(i + 1) % N];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  // start on the straightest stretch
  const turn0 = pts.map((_, i) => Math.abs(wrapAngle(heading(pts, (i + 6) % N) - heading(pts, i))));
  let bestI = 0, bestScore = Infinity;
  for (let i = 0; i < N; i++) {
    let sc = 0;
    for (let d = -24; d <= 12; d++) sc += turn0[(i + d + N) % N];
    if (sc < bestScore) { bestScore = sc; bestI = i; }
  }
  pts = pts.slice(bestI).concat(pts.slice(0, bestI));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const M = 460;
  const out = pts.map(([x, y]) => ({ x: x - minX + M, y: y - minY + M, a: 0 }));
  N = out.length;
  for (let i = 0; i < N; i++) {
    const a = out[(i - 1 + N) % N], b = out[(i + 1) % N];
    out[i].a = Math.atan2(b.y - a.y, b.x - a.x);
  }
  const turn = out.map((p, i) => Math.abs(wrapAngle(out[(i + 8) % N].a - p.a)));
  const bend = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let m = 0;
    for (let d = 0; d < 40; d++) m = Math.max(m, turn[(i + d) % N]);
    bend[i] = m;
  }
  const width = byLevel(spec, [136, 124, 112]);
  // Fastest safe speed at each point (m/s): radius from the heading change over 8 points,
  // v = sqrt(mu g R) with a margin, then a backward pass so the AI starts braking in time.
  const vlim = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const R = (8 * STEP / PX) / Math.max(turn[i], 1e-3);
    vlim[i] = Math.min(90, Math.sqrt(0.78 * G * R));
  }
  const brake = 6.5, ds = STEP / PX;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = N - 1; i >= 0; i--) {
      const next = vlim[(i + 1) % N];
      vlim[i] = Math.min(vlim[i], Math.sqrt(next * next + 2 * brake * ds));
    }
  }
  return { pts: out, N, bend, turn, vlim, width, half: width / 2, w: maxX - minX + 2 * M, h: maxY - minY + 2 * M };
}

const lateral = (p, d) => ({ x: p.x - Math.sin(p.a) * d, y: p.y + Math.cos(p.a) * d });

function nearTrack(track, x, y, dist) {
  const d2 = dist * dist;
  for (let i = 0; i < track.N; i += 3) {
    const p = track.pts[i];
    const dx = p.x - x, dy = p.y - y;
    if (dx * dx + dy * dy < d2) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ state */

export function create(spec) {
  const track = buildTrack(spec);
  const { pts, N, half } = track;
  const r = rng(spec.map.seed * 31 + 7);
  const theme = THEMES[spec.theme];
  const base = byLevel(spec, [0.8, 0.9, 0.97]);
  const pk = spec.player.kind;
  const rivalKinds = pk === 'bus' || pk === 'scooter' ? [pk] : ['rally', 'hatchback', 'pickup', 'rally', 'hatchback'];

  const n = spec.rivals + 1;
  const cars = [];
  for (let slot = 0; slot < n; slot++) {
    const isPlayer = slot === n - 1; // the player starts at the back of the grid
    const idx = N - 6 - Math.floor(slot / 2) * 7;
    const pos = lateral(pts[idx], (slot % 2 ? 1 : -1) * half * 0.42);
    const kind = isPlayer ? pk : rivalKinds[slot % rivalKinds.length];
    cars.push({
      id: slot, isPlayer, kind, k: CARS[kind],
      color: isPlayer ? spec.player.color : RIVAL_COLORS[(slot + spec.map.seed) % RIVAL_COLORS.length],
      name: isPlayer ? 'You' : RIVAL_NAMES[(slot + spec.map.seed) % RIVAL_NAMES.length],
      x: pos.x, y: pos.y, ang: pts[idx].a, speed: 0,
      vx: 0, vy: 0, ax: 0, yawRate: 0, steerAng: 0, wheelSpin: 0, gear: 1, rpm: 900, slip: 0, braking: false, throttle: 0,
      idx, lap: -1, prog: idx - N, off: 0, lat: 0,
      finished: false, finishTime: 0, boostT: 0, bumpT: 0,
      skill: isPlayer ? 1 : clamp(base + (r() - 0.5) * 0.06, 0.7, 1.02),
      lane: (r() - 0.5) * half * 0.6,
    });
  }

  const collectTarget = spec.missions.find((m) => m.type === 'collect')?.target ?? 0;
  const nCoco = clamp(Math.ceil(collectTarget / spec.laps) + 5, 8, 70);
  const coconuts = [];
  for (let j = 0; j < nCoco; j++) {
    const i = 40 + Math.floor(((j + 0.5) / nCoco) * (N - 60));
    coconuts.push({ ...lateral(pts[i], (r() - 0.5) * half * 1.2), t: 0 });
  }

  const boosts = [];
  const nBoost = 2 + spec.map.length;
  for (let b = 0; b < nBoost; b++) {
    const want = 60 + Math.floor(((b + 0.5) * (N - 90)) / nBoost);
    let pick = -1;
    for (let d = 0; d < N / (2 * nBoost) && pick < 0; d++) {
      for (const i of [want + d, want - d]) if (i > 50 && i < N - 30 && track.bend[i] < 0.2) { pick = i; break; }
    }
    if (pick >= 0) boosts.push({ ...lateral(pts[pick], (r() - 0.5) * half * 0.5), a: pts[pick].a, idx: pick });
  }

  const obstacles = [];
  const nObs = Math.round(byLevel(spec, [3, 6, 10]) * (0.6 + 0.4 * spec.map.length));
  for (let tries = 0; obstacles.length < nObs && tries < 400; tries++) {
    const i = 80 + Math.floor(r() * (N - 120));
    if (boosts.some((b) => Math.abs(b.idx - i) < 30) || obstacles.some((o) => Math.abs(o.idx - i) < 25)) continue;
    const side = r() < 0.5 ? -1 : 1;
    const lat = side * half * (0.35 + 0.4 * r());
    obstacles.push({ ...lateral(pts[i], lat), idx: i, lat, hitT: 0 });
  }

  let seaY = 0;
  if (spec.theme === 'fiji-coast') seaY = track.h - 460 + 300;
  const props = [];
  const tries = 700 * spec.map.length;
  for (let t = 0; t < tries && props.length < 90 + 70 * spec.map.length; t++) {
    const x = r() * track.w, y = r() * track.h;
    if (seaY && y > seaY - 50) continue;
    if (nearTrack(track, x, y, half + 70)) continue;
    props.push({ x, y, s: 0.7 + r() * 0.7, rot: r() * Math.PI * 2, v: r() });
  }
  const pools = [];
  if (spec.theme === 'volcano') {
    for (let t = 0; t < 300 && pools.length < 5 + spec.map.length * 2; t++) {
      const x = r() * track.w, y = r() * track.h, rad = 50 + r() * 70;
      if (!nearTrack(track, x, y, half + rad + 40)) pools.push({ x, y, r: rad });
    }
  }

  const s = {
    genre: 'racing', spec, theme, track, half, N, cars, pi: n - 1, coconuts, boosts, obstacles, props, pools, seaY,
    laps: spec.laps, phase: 'countdown', count: 3, time: 0, raceTime: 0, collected: 0, hits: 0,
    order: [], position: 0, endAt: 0, over: false, autopilot: false, events: ['beep'],
    cam: { x: cars[n - 1].x, y: cars[n - 1].y, z: 1 },
  };
  return s;
}

/* ------------------------------------------------------------------ simulation */

export function aiControl(s, car) {
  const { pts, N, bend } = s.track;
  const look = 8 + Math.floor(Math.abs(car.speed) / 28); // about 0.3 s ahead plus 8 m
  const p = pts[(car.idx + look) % N];
  let lane = car.lane;
  for (const o of s.obstacles) {
    const ahead = (o.idx - car.idx + N) % N;
    if ((ahead < 60 || ahead > N - 4) && Math.abs(o.lat - lane) < 46) lane = clamp(o.lat > 0 ? o.lat - 52 : o.lat + 52, -s.half * 0.85, s.half * 0.85);
  }
  for (const c of s.cars) {
    if (c === car) continue;
    const ahead = (c.idx - car.idx + N) % N;
    if (ahead >= 1 && ahead < 9 && Math.abs(c.lat - lane) < 34) lane = clamp(c.lat > 0 ? c.lat - 42 : c.lat + 42, -s.half * 0.85, s.half * 0.85);
  }
  const t = lateral(p, lane);
  const diff = wrapAngle(Math.atan2(t.y - car.y, t.x - car.x) - car.ang);
  let mod = 1;
  if (!car.isPlayer) {
    const gap = s.cars[s.pi].prog - car.prog; // positive: player ahead of this rival
    if (gap > 150) mod = 1.06;
    else if (gap < -150) mod = 0.95;
  }
  // Corner limit a little ahead, scaled by skill so weaker rivals brake earlier.
  const vl = s.track.vlim;
  let corner = Infinity;
  for (let d = 0; d < 6; d++) corner = Math.min(corner, vl[(car.idx + d) % N]);
  const grip = Math.sqrt(car.k.phys.mu / 1.05) * (car.k.phys.cgHeight > 0.8 ? 0.94 : 1); // tall bus: lower
  const target = Math.min(car.k.max * car.skill * mod, corner * PX * grip * (0.9 + 0.1 * car.skill));
  // Pure pursuit: the steering angle whose arc passes through the target point, as a fraction of
  // the lock available at this speed, with a little yaw-rate damping against weaving.
  const ph = car.k.phys;
  const ld = Math.max(4, Math.hypot(t.x - car.x, t.y - car.y) / PX);
  const want = Math.atan((2 * ph.wheelbase * Math.sin(diff)) / ld);
  const lock = ph.steer / (1 + Math.hypot(car.vx, car.vy) / 14);
  const yawWant = (2 * Math.max(car.vx, 1) * Math.sin(diff)) / ld;
  const steer = clamp(want / lock + 0.25 * (yawWant - car.yawRate), -1, 1);
  return { steer, up: car.speed < target, down: car.speed > target + 25, mod };
}

// Pacejka "magic formula" with typical road-tyre coefficients: grip rises with slip angle, peaks
// near 6 degrees and falls off a little beyond it, which is what lets a car slide.
const tyre = (slip, load, mu) => mu * load * Math.sin(1.9 * Math.atan(10 * slip));
const RATIOS = [3.4, 2.2, 1.6, 1.25, 1.0, 0.84];

// One car, one fixed step. Body frame: vx forward, vy to the right (the same side lateral()
// uses), yawRate positive turns toward the right. Forces in newtons, distances in metres.
export function drive(s, car, ctl, dt) {
  const k = car.k, p = k.phys;
  // Collisions and the track edge scale car.speed directly; carry that into the model.
  const ext = car.speed / PX;
  if (Math.abs(ext - car.vx) > 1e-6) {
    const f = car.vx !== 0 ? clamp(ext / car.vx, 0, 1) : 0;
    car.vx = ext;
    car.vy *= f;
    car.yawRate *= f;
  }
  const boosting = car.boostT > 0;
  const offroad = car.off > s.half;
  const mu = p.mu * (offroad ? 0.62 : 1);
  // Governor: rival skill and catch-up, boost pads, grass.
  const vCap = p.vTop * car.skill * (ctl.mod || 1) * (boosting ? 1.3 : 1) * (offroad ? 0.55 : 1);
  const steerIn = clamp(ctl.steer || 0, -1, 1);

  const sub = 2, h = dt / sub;
  let braking = false;
  for (let it = 0; it < sub; it++) {
    const v = car.vx;
    const speed = Math.hypot(car.vx, car.vy);
    // Full lock at parking speed, less at speed, as a driver would.
    const lock = p.steer / (1 + speed / 14);
    car.steerAng += clamp(steerIn * lock - car.steerAng, -4.5 * h, 4.5 * h);
    const delta = car.steerAng;

    // Longitudinal force request.
    let Fx = 0;
    braking = false;
    if (ctl.up) {
      if (v < -0.5) { Fx = mu * p.kg * G * 0.9; braking = true; }
      else if (v < vCap) Fx = Math.min(p.kg * p.launch * (boosting ? 1.6 : 1), (p.power * (boosting ? 1.8 : 1)) / Math.max(Math.abs(v), 1));
    } else if (ctl.down) {
      if (v > 0.5) { Fx = -mu * p.kg * G * 0.95; braking = true; } // ABS: brakes never lock
      else if (v > -8) Fx = -p.kg * 3.5;                            // reverse
    }
    if (v > vCap * 1.02 && !braking) Fx = Math.min(Fx, -p.kg * 2.5); // over the governor: engine braking
    const resist = p.drag * v * Math.abs(v) + Math.sign(v) * p.rolling * (offroad ? 4 : 1);

    // Axle loads with longitudinal load transfer from the measured acceleration (the body pitches
    // after the force builds, so the last step's value is used).
    const transfer = (p.kg * clamp(car.ax || 0, -1.2 * G, 1.2 * G) * p.cgHeight) / p.wheelbase;
    const Wf = Math.max(0.15 * p.kg * G, p.kg * G * p.cgFront - transfer);
    const Wr = Math.max(0.15 * p.kg * G, p.kg * G * (1 - p.cgFront) + transfer);

    if (Math.abs(v) > 2.5) {
      const vxAbs = Math.abs(v), dir = Math.sign(v);
      const sf = Math.atan2(car.vy + p.a * car.yawRate, vxAbs) - delta * dir;
      const sr = Math.atan2(car.vy - p.b * car.yawRate, vxAbs);
      // Friction circle per axle. Cornering force comes first (traction control and ABS trim
      // the drive and brake force to what is left), but at least 35% stays for drive or brakes.
      // Brakes are split by axle load (EBD); drive goes to the driven axle(s).
      const shareF = braking ? Wf / (Wf + Wr) : p.drive === 'front' ? 1 : p.drive === 'all' ? 0.5 : 0;
      const axle = (slip, W, fx) => {
        const lim = mu * W;
        let fy = clamp(-tyre(slip, W, mu), -lim, lim);
        const room = Math.max(0.35 * lim, Math.sqrt(Math.max(0, lim * lim - fy * fy)));
        fx = clamp(fx, -room, room);
        const side = Math.sqrt(Math.max(0, lim * lim - fx * fx));
        return [fx, clamp(fy, -side, side)];
      };
      const [fxF, Fyf] = axle(sf, Wf, Fx * shareF);
      const [fxR, Fyr] = axle(sr, Wr, Fx * (1 - shareF));
      Fx = fxF + fxR;
      car.slip = Math.max(Math.abs(sr), Math.abs(sf) * 0.7);
      const cosd = Math.cos(delta), sind = Math.sin(delta);
      let ax = (Fx - resist - Fyf * sind) / p.kg + car.vy * car.yawRate;
      const ay = (Fyr + Fyf * cosd) / p.kg - v * car.yawRate;
      let yawAcc = (p.a * Fyf * cosd - p.b * Fyr) / p.inertia;
      // Stability control (ESC): when the car yaws faster or slower than the steering asks for
      // (limited to what the tyres can hold), single-wheel braking adds a correcting moment.
      const rRef = clamp((v * Math.tan(delta)) / p.wheelbase, -(mu * G) / vxAbs, (mu * G) / vxAbs);
      const err = car.yawRate - rRef;
      if (Math.abs(err) > 0.08) {
        yawAcc -= Math.sign(err) * Math.min(Math.abs(err) - 0.08, 1) * 9;
        ax -= 0.8 * Math.min(Math.abs(err), 1);
      }
      car.ax = ax - car.vy * car.yawRate;
      car.vx += ax * h;
      car.vy += ay * h;
      car.yawRate += yawAcc * h;
    } else {
      // Parking speeds: slip angles are singular near zero, so roll like a kinematic bicycle.
      car.ax = (Fx - resist) / p.kg;
      car.vx += car.ax * h;
      if (!ctl.up && !ctl.down && Math.abs(car.vx) < 0.3) car.vx = 0;
      car.vy *= Math.exp(-12 * h);
      car.yawRate = (car.vx * Math.tan(delta)) / p.wheelbase;
      car.slip = 0;
    }
    car.ang = wrapAngle(car.ang + car.yawRate * h);
    const c = Math.cos(car.ang), sn = Math.sin(car.ang);
    car.x += (c * car.vx - sn * car.vy) * PX * h;
    car.y += (sn * car.vx + c * car.vy) * PX * h;
  }
  car.braking = braking;
  car.throttle = ctl.up ? 1 : 0;
  car.speed = car.vx * PX;
  car.wheelSpin = (car.wheelSpin + (car.vx / p.wheelR) * dt) % (Math.PI * 2);
  // Gearbox for the HUD: shift up at 6,400 rpm, down when the lower gear sits under 5,200.
  const n = p.gears;
  const toRpm = 60 / (2 * Math.PI);
  const final = 6600 / ((p.vTop / p.wheelR) * toRpm * RATIOS[n - 1]); // top gear peaks at top speed
  const wheelRpm = (Math.abs(car.vx) / p.wheelR) * (60 / (2 * Math.PI));
  const rpmAt = (g) => wheelRpm * RATIOS[g - 1] * final;
  let g = clamp(car.gear || 1, 1, n);
  if (rpmAt(g) > 6400 && g < n) g++;
  else if (g > 1 && rpmAt(g - 1) < 5200) g--;
  car.gear = car.vx < -0.5 ? 0 : g;
  car.rpm = clamp(rpmAt(g), 900, 7200);
  if (car.boostT > 0) car.boostT -= dt;
  if (car.bumpT > 0) car.bumpT -= dt;
}

function locate(s, car) {
  const { pts, N } = s.track;
  let best = Infinity, bi = car.idx;
  const scan = (i) => {
    const dx = pts[i].x - car.x, dy = pts[i].y - car.y;
    const q = dx * dx + dy * dy;
    if (q < best) { best = q; bi = i; }
  };
  for (let d = -30; d <= 50; d++) scan((car.idx + d + N) % N);
  if (best > (s.half + 260) ** 2) for (let i = 0; i < N; i++) scan(i);
  const old = car.idx;
  if (old > N * 0.75 && bi < N * 0.25) car.lap++;
  else if (old < N * 0.25 && bi > N * 0.75) car.lap--;
  car.idx = bi;
  car.off = Math.sqrt(best);
  car.lat = (car.x - pts[bi].x) * -Math.sin(pts[bi].a) + (car.y - pts[bi].y) * Math.cos(pts[bi].a);
  car.prog = car.lap * N + bi;
  const lim = s.half + 80;
  if (car.off > lim) {
    const p = pts[bi], f = lim / car.off;
    car.x = p.x + (car.x - p.x) * f;
    car.y = p.y + (car.y - p.y) * f;
    car.speed *= 0.96;
  }
}

export function rank(s) {
  const me = s.cars[s.pi];
  if (me.finished) return s.position;
  let ahead = s.order.length;
  for (const c of s.cars) if (c !== me && !c.finished && c.prog >= me.prog) ahead++; // ties go against the player
  return ahead + 1;
}

export function step(s, input, dt) {
  s.time += dt;
  if (s.over) return;
  if (s.phase === 'countdown') {
    const before = Math.ceil(s.count);
    s.count -= dt;
    if (s.count <= 0) { s.phase = 'race'; s.events.push('go'); }
    else if (Math.ceil(s.count) !== before) s.events.push('beep');
    updateCamera(s, dt);
    return;
  }
  s.raceTime += dt;
  const me = s.cars[s.pi];

  for (const car of s.cars) {
    let ctl;
    if (car.isPlayer && !s.autopilot && !car.finished) {
      ctl = { steer: (input.right ? 1 : 0) - (input.left ? 1 : 0), up: !!input.up, down: !!input.down };
    } else {
      ctl = aiControl(s, car);
      if (car.finished) { ctl.up = car.speed < 180; ctl.down = car.speed > 220; }
    }
    drive(s, car, ctl, dt);
    const lapBefore = car.lap;
    locate(s, car);
    if (car.isPlayer && car.lap > lapBefore && car.lap > 0 && car.lap < s.laps) s.events.push('lap');
    if (!car.finished && car.lap >= s.laps) {
      car.finished = true;
      car.finishTime = s.raceTime;
      s.order.push(car.id);
      if (car.isPlayer) {
        s.position = s.order.length;
        s.endAt = s.time + 3;
        s.events.push('finish');
      }
    }
  }

  // cars bumping into each other
  for (let i = 0; i < s.cars.length; i++) {
    for (let j = i + 1; j < s.cars.length; j++) {
      const a = s.cars[i], b = s.cars[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const min = (a.k.len + b.k.len) * 0.36;
      if (d >= min || d < 0.01) continue;
      const nx = dx / d, ny = dy / d, push = min - d;
      const wa = b.k.mass / (a.k.mass + b.k.mass);
      a.x -= nx * push * wa; a.y -= ny * push * wa;
      b.x += nx * push * (1 - wa); b.y += ny * push * (1 - wa);
      a.speed *= 0.985; b.speed *= 0.985;
      const pl = a.isPlayer ? a : b.isPlayer ? b : null;
      if (pl && !pl.finished && pl.bumpT <= 0 && Math.abs(a.speed - b.speed) > 60) {
        pl.bumpT = 1;
        s.hits++;
        s.events.push('bump');
      }
    }
  }

  for (const o of s.obstacles) {
    if (o.hitT > 0) o.hitT -= dt;
    for (const car of s.cars) {
      const dx = car.x - o.x, dy = car.y - o.y;
      const d = Math.hypot(dx, dy), min = 14 + car.k.wid * 0.7;
      if (d >= min || d < 0.01) continue;
      car.x = o.x + (dx / d) * min;
      car.y = o.y + (dy / d) * min;
      if (Math.abs(car.speed) > 60 && o.hitT <= 0) {
        car.speed *= 0.45;
        o.hitT = 1.2; // one knock per contact, not one per frame
        if (car.isPlayer && !car.finished) { s.hits++; s.events.push('hit'); }
      }
    }
  }

  for (const b of s.boosts) {
    for (const car of s.cars) {
      if (Math.hypot(car.x - b.x, car.y - b.y) < 34) {
        if (car.boostT <= 0.2 && car.isPlayer) s.events.push('boost');
        car.boostT = 1.4;
      }
    }
  }

  for (const c of s.coconuts) {
    if (c.t > 0) { c.t -= dt; continue; }
    if (!me.finished && Math.hypot(me.x - c.x, me.y - c.y) < 30) {
      c.t = 9;
      s.collected++;
      s.events.push('coin');
    }
  }

  updateCamera(s, dt);
  if ((s.endAt && s.time >= s.endAt) || s.raceTime > 900) s.over = true;
}

function updateCamera(s, dt) {
  const p = s.cars[s.pi];
  const f = 1 - Math.exp(-dt * 5);
  s.cam.x += (p.x + Math.cos(p.ang) * p.speed * 0.35 - s.cam.x) * f;
  s.cam.y += (p.y + Math.sin(p.ang) * p.speed * 0.35 - s.cam.y) * f;
  const z = 1 - 0.18 * clamp(Math.abs(p.speed) / p.k.max, 0, 1.3);
  s.cam.z += (z - s.cam.z) * (1 - Math.exp(-dt * 2));
}

export function result(s) {
  const me = s.cars[s.pi];
  return {
    finished: me.finished,
    position: rank(s),
    cars: s.cars.length,
    time: me.finished ? me.finishTime : s.raceTime,
    collected: s.collected,
    hits: s.hits,
  };
}

export function hud(s) {
  const me = s.cars[s.pi];
  const res = result(s);
  return [
    `Lap ${clamp(me.lap + 1, 1, s.laps)}/${s.laps}`,
    s.cars.length > 1 ? `${ordinal(res.position)} of ${s.cars.length}` : 'Time trial',
    formatTime(res.time),
  ];
}

/* ------------------------------------------------------------------ drawing */

export function kerbColors(theme) {
  return {
    'suva-city': ['#9e9e9e', '#eeeeee'], 'night-city': ['#40c4ff', '#14171d'], reef: ['#ffffff', '#80deea'],
    space: ['#b388ff', '#2a2e52'], volcano: ['#ff6d00', '#2b2626'],
  }[theme] || ['#d84339', '#fafafa'];
}

function trackPath(s) {
  if (!s.path) {
    const p = new Path2D();
    s.track.pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
    p.closePath();
    s.path = p;
  }
  return s.path;
}

function strokeTrack(ctx, path, width, themeKey, th) {
  const [k1, k2] = kerbColors(themeKey);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = shade(th.ground, -0.14);
  ctx.lineWidth = width + 40;
  ctx.stroke(path);
  ctx.strokeStyle = k1;
  ctx.lineWidth = width + 14;
  ctx.stroke(path);
  ctx.setLineDash([26, 26]);
  ctx.strokeStyle = k2;
  ctx.stroke(path);
  ctx.setLineDash([]);
  ctx.strokeStyle = th.road;
  ctx.lineWidth = width;
  ctx.stroke(path);
}

function drawProp(ctx, kind, p, th, t) {
  const s = p.s;
  ctx.save();
  ctx.translate(p.x, p.y);
  switch (kind) {
    case 'palm': {
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      ctx.beginPath(); ctx.ellipse(10 * s, 8 * s, 30 * s, 20 * s, 0, 0, 7); ctx.fill();
      ctx.rotate(p.rot);
      for (let i = 0; i < 6; i++) {
        ctx.rotate(Math.PI / 3);
        ctx.fillStyle = i % 2 ? '#4caf50' : '#388e3c';
        ctx.beginPath(); ctx.ellipse(16 * s, 0, 18 * s, 6 * s, 0, 0, 7); ctx.fill();
      }
      ctx.fillStyle = '#795548';
      ctx.beginPath(); ctx.arc(0, 0, 5 * s, 0, 7); ctx.fill();
      break;
    }
    case 'building':
    case 'neon': {
      const w = 60 * s, h = 46 * s;
      ctx.rotate(Math.round(p.rot / (Math.PI / 2)) * (Math.PI / 2));
      ctx.fillStyle = 'rgba(0,0,0,.2)';
      ctx.fillRect(-w / 2 + 8, -h / 2 + 8, w, h);
      const roofs = kind === 'neon' ? ['#2b3245', '#323a52', '#263043'] : ['#e0c9a6', '#b0bec5', '#ffccbc', '#c5e1a5', '#d7ccc8'];
      ctx.fillStyle = roofs[Math.floor(p.v * roofs.length)];
      ctx.fillRect(-w / 2, -h / 2, w, h);
      if (kind === 'neon') {
        ctx.strokeStyle = p.v > 0.5 ? '#40c4ff' : '#ff4081';
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 3 + p.v * 9);
        ctx.strokeRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = 'rgba(0,0,0,.12)';
        ctx.fillRect(-w / 2 + 8, -h / 2 + 8, 12 * s, 9 * s);
        ctx.fillRect(w / 2 - 22 * s, h / 2 - 18 * s, 14 * s, 10 * s);
      }
      break;
    }
    case 'cane': {
      ctx.rotate(p.rot);
      ctx.fillStyle = '#7cb342';
      ctx.fillRect(-40 * s, -26 * s, 80 * s, 52 * s);
      ctx.strokeStyle = '#558b2f';
      ctx.lineWidth = 3;
      for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(-38 * s, i * 7 * s); ctx.lineTo(38 * s, i * 7 * s); ctx.stroke(); }
      break;
    }
    case 'tree': {
      ctx.fillStyle = 'rgba(0,0,0,.18)';
      ctx.beginPath(); ctx.arc(8 * s, 8 * s, 30 * s, 0, 7); ctx.fill();
      ctx.fillStyle = '#2e7d32';
      ctx.beginPath(); ctx.arc(0, 0, 30 * s, 0, 7); ctx.fill();
      ctx.fillStyle = '#43a047';
      ctx.beginPath(); ctx.arc(-8 * s, -8 * s, 17 * s, 0, 7); ctx.arc(12 * s, -2 * s, 13 * s, 0, 7); ctx.fill();
      break;
    }
    case 'rock': {
      ctx.rotate(p.rot);
      ctx.fillStyle = '#5d4e4a';
      ctx.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2, rr = (20 + ((i * 37 + p.v * 50) % 9)) * s;
        i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#6d5f5a';
      ctx.beginPath(); ctx.arc(-5 * s, -5 * s, 8 * s, 0, 7); ctx.fill();
      break;
    }
    case 'coral': {
      const cols = ['#ff80ab', '#ffab40', '#ea80fc', '#ff8a65'];
      ctx.fillStyle = cols[Math.floor(p.v * cols.length)];
      for (let i = 0; i < 5; i++) {
        const a = p.rot + i * 1.3;
        ctx.beginPath(); ctx.arc(Math.cos(a) * 14 * s, Math.sin(a) * 14 * s, 9 * s, 0, 7); ctx.fill();
      }
      break;
    }
    default: { // space: craters and small stars
      if (p.v < 0.5) {
        ctx.fillStyle = '#1d2140';
        ctx.beginPath(); ctx.arc(0, 0, 26 * s, 0, 7); ctx.fill();
        ctx.strokeStyle = '#2a2e52'; ctx.lineWidth = 4;
        ctx.stroke();
      } else {
        ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * Math.sin(t * 2 + p.v * 20)})`;
        ctx.fillRect(-2, -2, 4, 4);
      }
    }
  }
  ctx.restore();
}

export function drawCar(ctx, car, color, kind) {
  const k = CARS[kind];
  const L = k.len, W = k.wid;
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.ang);
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  rrect(ctx, -L / 2 + 3, -W / 2 + 4, L, W, 6); ctx.fill();
  if (kind === 'scooter') {
    ctx.fillStyle = '#263238';
    rrect(ctx, -L / 2, -3, L, 6, 3); ctx.fill();
    ctx.fillStyle = color;
    rrect(ctx, -L / 2 + 3, -W / 2, L - 8, W, 4); ctx.fill();
    ctx.fillStyle = '#ffe0b2';
    ctx.beginPath(); ctx.arc(-2, 0, 5, 0, 7); ctx.fill();
    ctx.fillStyle = '#37474f';
    ctx.beginPath(); ctx.arc(-3, 0, 4, 0, 7); ctx.fill();
  } else {
    ctx.fillStyle = color;
    rrect(ctx, -L / 2, -W / 2, L, W, kind === 'bus' ? 5 : 7); ctx.fill();
    ctx.fillStyle = '#1d2733';
    if (kind === 'bus') {
      rrect(ctx, L / 2 - 9, -W / 2 + 3, 6, W - 6, 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(-L / 2 + 6, -W / 2 + 4, L - 18, W - 8);
      ctx.fillStyle = color;
      for (let x = -L / 2 + 14; x < L / 2 - 12; x += 10) ctx.fillRect(x, -W / 2 + 4, 2, W - 8);
    } else {
      rrect(ctx, L * 0.06, -W / 2 + 3, L * 0.2, W - 6, 3); ctx.fill();
      rrect(ctx, -L * 0.38, -W / 2 + 4, L * 0.12, W - 8, 2); ctx.fill();
      if (kind === 'pickup') {
        ctx.fillStyle = shade(color, -0.3);
        rrect(ctx, -L / 2 + 3, -W / 2 + 3, L * 0.38, W - 6, 2); ctx.fill();
      } else {
        ctx.fillStyle = shade(color, 0.22);
        rrect(ctx, -L * 0.24, -W / 2 + 4, L * 0.28, W - 8, 3); ctx.fill();
      }
      if (kind === 'rally') {
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.fillRect(-L / 2, -2, L, 4);
      }
    }
    ctx.fillStyle = '#fff59d';
    ctx.fillRect(L / 2 - 3, -W / 2 + 2, 3, 4);
    ctx.fillRect(L / 2 - 3, W / 2 - 6, 3, 4);
  }
  ctx.restore();
}

function drawObstacle(ctx, o, themeKey) {
  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.hitT > 0.8) ctx.rotate(Math.sin(o.hitT * 40) * 0.2);
  if (themeKey === 'suva-city' || themeKey === 'night-city') {
    ctx.fillStyle = '#ff6d00';
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, 7); ctx.fill();
    ctx.fillStyle = '#ff6d00';
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, 7); ctx.fill();
  } else if (themeKey === 'reef') {
    ctx.fillStyle = '#ffeb3b';
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, 7); ctx.fill();
    ctx.fillStyle = '#e53935';
    ctx.fillRect(-13, -3, 26, 6);
  } else if (themeKey === 'volcano' || themeKey === 'rainforest' || themeKey === 'space') {
    ctx.fillStyle = themeKey === 'space' ? '#5c6390' : '#6d5f5a';
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.15)';
    ctx.beginPath(); ctx.arc(-4, -4, 6, 0, 7); ctx.fill();
  } else {
    ctx.fillStyle = '#a1887f';
    ctx.fillRect(-13, -13, 26, 26);
    ctx.strokeStyle = '#6d4c41'; ctx.lineWidth = 3;
    ctx.strokeRect(-12, -12, 24, 24);
    ctx.beginPath(); ctx.moveTo(-12, -12); ctx.lineTo(12, 12); ctx.stroke();
  }
  ctx.restore();
}

export function draw(ctx, s, W, H, ui = {}) {
  const th = s.theme, key = s.spec.theme, { cam, track } = s;
  const z = cam.z * clamp(Math.min(W, H) / 620, 0.7, 1.3);
  const vx0 = cam.x - W / 2 / z - 120, vx1 = cam.x + W / 2 / z + 120;
  const vy0 = cam.y - H / 2 / z - 120, vy1 = cam.y + H / 2 / z + 120;

  ctx.fillStyle = th.ground;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(z, z);
  ctx.translate(-cam.x, -cam.y);

  // mown stripes
  ctx.fillStyle = th.ground2;
  const band = 140;
  for (let y = Math.floor(vy0 / band) * band; y < vy1; y += band) if ((y / band) % 2 === 0) ctx.fillRect(vx0, y, vx1 - vx0, band / 2);

  if (s.seaY) {
    ctx.fillStyle = shade(th.ground, 0.25);
    ctx.fillRect(vx0, s.seaY - 40, vx1 - vx0, 40);
    ctx.fillStyle = th.water;
    ctx.fillRect(vx0, s.seaY, vx1 - vx0, Math.max(0, vy1 - s.seaY));
    ctx.strokeStyle = 'rgba(255,255,255,.45)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      const y = s.seaY + 30 + i * 70 + Math.sin(s.time * 1.5 + i) * 6;
      ctx.beginPath();
      for (let x = Math.floor(vx0 / 40) * 40; x < vx1; x += 40) ctx.lineTo(x, y + Math.sin(x * 0.02 + s.time * 2 + i) * 6);
      ctx.stroke();
    }
  }
  for (const p of s.pools) {
    const g = ctx.createRadialGradient(p.x, p.y, p.r * 0.2, p.x, p.y, p.r);
    g.addColorStop(0, '#ffd180'); g.addColorStop(0.5, '#ff6d00'); g.addColorStop(1, 'rgba(255,61,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
  }

  strokeTrack(ctx, trackPath(s), track.width, key, th);
  ctx.setLineDash([34, 30]);
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  ctx.lineWidth = 3;
  ctx.stroke(trackPath(s));
  ctx.setLineDash([]);

  // start / finish line
  const p0 = track.pts[0], sq = track.width / 10;
  ctx.save();
  ctx.translate(p0.x, p0.y);
  ctx.rotate(p0.a);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 10; col++) {
      ctx.fillStyle = (row + col) % 2 ? '#111' : '#fff';
      ctx.fillRect(row * sq - sq, -track.width / 2 + col * sq, sq, sq);
    }
  }
  ctx.restore();

  for (const b of s.boosts) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.a);
    ctx.fillStyle = th.accent;
    rrect(ctx, -26, -18, 52, 36, 8); ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.45 * Math.sin(s.time * 8)})`;
    ctx.lineWidth = 4;
    for (const off of [-12, 4]) {
      ctx.beginPath(); ctx.moveTo(off, -11); ctx.lineTo(off + 10, 0); ctx.lineTo(off, 11); ctx.stroke();
    }
    ctx.restore();
  }

  for (const c of s.coconuts) {
    if (c.t > 0) continue;
    const bob = Math.sin(s.time * 4 + c.x) * 1.5;
    ctx.fillStyle = 'rgba(0,0,0,.2)';
    ctx.beginPath(); ctx.ellipse(c.x + 3, c.y + 5, 11, 7, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#6d4c41';
    ctx.beginPath(); ctx.arc(c.x, c.y + bob, 11, 0, 7); ctx.fill();
    ctx.fillStyle = '#8d6e63';
    ctx.beginPath(); ctx.arc(c.x - 3, c.y - 3 + bob, 4, 0, 7); ctx.fill();
    ctx.fillStyle = '#3e2723';
    for (const [dx, dy] of [[3, 2], [6, -1], [4, 5]]) { ctx.beginPath(); ctx.arc(c.x + dx, c.y + dy + bob, 1.4, 0, 7); ctx.fill(); }
  }

  for (const o of s.obstacles) drawObstacle(ctx, o, key);

  for (const p of s.props) {
    if (p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue;
    drawProp(ctx, th.prop, p, th, s.time);
  }

  const me = s.cars[s.pi];
  for (const c of s.cars) if (c !== me) drawCar(ctx, c, c.color, c.kind);
  if (me.boostT > 0) {
    ctx.fillStyle = 'rgba(255,171,64,.55)';
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(me.x - Math.cos(me.ang) * (me.k.len / 2 + i * 9), me.y - Math.sin(me.ang) * (me.k.len / 2 + i * 9), 7 - i * 1.5, 0, 7);
      ctx.fill();
    }
  }
  drawCar(ctx, me, me.color, me.kind);
  ctx.restore();
  drawOverlay(ctx, s, W, H, ui);
}

// Minimap, speedometer and countdown. The 2D view draws them over its own frame; the 3D view
// draws them on a transparent canvas above the WebGL one.
export function drawOverlay(ctx, s, W, H, ui = {}) {
  const { track } = s, me = s.cars[s.pi];
  const font = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif';
  const top = ui.top ?? 64;
  const mw = Math.min(150, W * 0.3);
  const sc = Math.min(mw / track.w, 110 / track.h);
  const bw = track.w * sc + 16, bh = track.h * sc + 16;
  const bx = W - bw - 12, by = top;
  ctx.fillStyle = 'rgba(15,18,24,.45)';
  rrect(ctx, bx, by, bw, bh, 12); ctx.fill();
  ctx.save();
  ctx.translate(bx + 8, by + 8);
  ctx.scale(sc, sc);
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 3 / sc;
  ctx.stroke(trackPath(s));
  for (const c of s.cars) {
    ctx.fillStyle = c.isPlayer ? '#fff' : c.color;
    ctx.beginPath(); ctx.arc(c.x, c.y, (c.isPlayer ? 5 : 3.5) / sc, 0, 7); ctx.fill();
    if (c.isPlayer) { ctx.strokeStyle = me.color; ctx.lineWidth = 2 / sc; ctx.stroke(); }
  }
  ctx.restore();

  // Speedometer: km/h, gear and an rpm bar, above the touch controls when they are showing.
  if (!ui.still) {
    const kmh = Math.round(Math.abs(me.vx || 0) * 3.6);
    const pw = 132, ph = 64, px = 12, py = H - (ui.bottom || 0) - ph - 14;
    ctx.fillStyle = 'rgba(15,18,24,.55)';
    rrect(ctx, px, py, pw, ph, 12); ctx.fill();
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.font = `700 28px ${font}`;
    ctx.fillText(String(kmh), px + 12, py + 36);
    const numW = ctx.measureText(String(kmh)).width;
    ctx.font = `600 11px ${font}`;
    ctx.fillStyle = 'rgba(255,255,255,.7)';
    ctx.fillText('km/h', px + 16 + numW, py + 36);
    ctx.textAlign = 'right';
    ctx.font = `700 22px ${font}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(me.gear === 0 ? 'R' : String(me.gear || 1), px + pw - 12, py + 34);
    const frac = clamp(((me.rpm || 900) - 900) / 6300, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    rrect(ctx, px + 12, py + ph - 18, pw - 24, 6, 3); ctx.fill();
    ctx.fillStyle = frac > 0.86 ? '#ff5252' : me.color;
    rrect(ctx, px + 12, py + ph - 18, Math.max(6, (pw - 24) * frac), 6, 3); ctx.fill();
  }

  if (!ui.still && (s.phase === 'countdown' || (s.phase === 'race' && s.raceTime < 0.8))) {
    const label = s.phase === 'countdown' ? String(Math.ceil(s.count)) : 'Go!';
    ctx.font = `700 ${Math.round(Math.min(W, H) * 0.2)}px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,.25)';
    ctx.fillText(label, W / 2 + 3, H / 2 + 4);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, W / 2, H / 2);
  }
}

export function thumb(ctx, spec, w, h) {
  const track = buildTrack(spec);
  const th = THEMES[spec.theme];
  ctx.fillStyle = th.ground;
  ctx.fillRect(0, 0, w, h);
  const sc = Math.min((w - 16) / track.w, (h - 16) / track.h);
  ctx.save();
  ctx.translate((w - track.w * sc) / 2, (h - track.h * sc) / 2);
  ctx.scale(sc, sc);
  if (spec.theme === 'fiji-coast') {
    ctx.fillStyle = th.water;
    ctx.fillRect(-track.w, track.h - 160, track.w * 3, track.h);
  }
  const path = new Path2D();
  track.pts.forEach((q, i) => (i ? path.lineTo(q.x, q.y) : path.moveTo(q.x, q.y)));
  path.closePath();
  strokeTrack(ctx, path, track.width * 1.6, spec.theme, th);
  const p0 = track.pts[0];
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(p0.x, p0.y, 40, 0, 7); ctx.fill();
  ctx.fillStyle = spec.player.color;
  ctx.beginPath(); ctx.arc(p0.x, p0.y, 26, 0, 7); ctx.fill();
  ctx.restore();
}
