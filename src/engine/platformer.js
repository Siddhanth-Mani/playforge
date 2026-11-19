// Side-scrolling platformer on a 40px tile grid. The level generator only makes gaps and steps that
// fit inside the jump arc (checked by the tests), so every generated level can be finished.
import { rng, THEMES } from '../spec.js';
import { clamp, approach, shade, rrect, byLevel, LEVEL, formatTime } from './core.js';

export const T = 40;
export const ROWS = 15;
export const PHYS = { g: 2200, jump: 820, run: 270, accel: 2400, air: 1600, fric: 2600, coyote: 0.1, buffer: 0.13, maxFall: 1000 };
export const PW = 26;
export const PH = 36;

/* ------------------------------------------------------------------ level */

export function buildLevel(spec) {
  const r = rng(spec.map.seed * 13 + 5);
  const cols = [0, 170, 250, 330][spec.map.length];
  const lv = LEVEL[spec.difficulty] ?? 1;
  const maxGap = [2, 3, 3][lv];
  const layout = spec.map.layout;
  const h = new Int8Array(cols);
  const grid = new Uint8Array(cols * ROWS); // row 0 is the top
  const enemies = [];
  const coins = [];
  const keys = new Set();

  const cell = (c, level, v) => { if (c >= 0 && c < cols && level >= 0 && level < ROWS) grid[c * ROWS + (ROWS - 1 - level)] = v; };
  const cellAt = (c, level) => grid[c * ROWS + (ROWS - 1 - level)];
  // coin in the cell `level` tiles up from the bottom
  const addCoin = (c, level) => {
    const k = `${c},${level}`;
    if (keys.has(k) || c < 0 || c >= cols || level >= ROWS - 1) return;
    keys.add(k);
    coins.push({ x: c * T + T / 2, y: (ROWS - level - 0.5) * T, taken: false });
  };

  let c = 0;
  let cur = 3;
  const run = (len, height) => { for (let i = 0; i < len && c < cols; i++) h[c++] = height; };
  run(8, cur);
  const end = cols - 16;
  const gapP = { hills: 0.22, islands: 0.38, caves: 0.2 }[layout] ?? 0.25;
  const enemyP = [0.3, 0.45, 0.6][lv];
  const speed = [55, 75, 95][lv];

  while (c < end) {
    const roll = r();
    if (roll < gapP) {
      const next = clamp(cur + [-1, 0, 0, 1][Math.floor(r() * 4)], 2, 6);
      if (r() < 0.3 && layout !== 'caves') {
        // wide gap with a stepping-stone platform: 3 empty, 3 platform, 3 empty
        const top = Math.max(cur, next) + 1;
        for (let i = 0; i < 9; i++) h[c + i] = 0;
        for (let i = 3; i < 6; i++) { cell(c + i, top - 1, 2); addCoin(c + i, top); }
        c += 9;
      } else {
        let w = 1 + Math.floor(r() * maxGap);
        if (next > cur) w = Math.min(w, 2);
        for (let i = 0; i < w; i++) { h[c + i] = 0; addCoin(c + i, Math.max(cur, next) + 2); }
        c += w;
      }
      cur = next;
      run(5 + Math.floor(r() * 3), cur); // a full jump lands about five tiles out, so leave room
    } else if (roll < gapP + 0.28) {
      cur = clamp(cur + (r() < 0.5 ? -1 : 1) * (r() < 0.3 ? 2 : 1), 2, 7);
      run(4 + Math.floor(r() * 4), cur);
    } else {
      const len = 5 + Math.floor(r() * 5);
      const start = c;
      run(len, cur);
      const hasEnemy = len >= 6 && r() < enemyP;
      if (hasEnemy) {
        enemies.push({ x: (start + 2) * T, y: (ROWS - cur) * T - 26, w: 30, h: 26, vx: speed * (r() < 0.5 ? -1 : 1), min: (start + 1) * T, max: (start + len - 1) * T - 30, alive: true, squash: 0 });
      }
      if (!hasEnemy && r() < 0.45) { // never a low platform over an enemy: it would block the jump over it
        const pw = 2 + Math.floor(r() * 2);
        const px = start + 1 + Math.floor(r() * Math.max(1, len - pw - 1));
        for (let i = 0; i < pw; i++) { cell(px + i, cur + 2, 2); addCoin(px + i, cur + 3); }
      } else {
        for (let i = 1; i < len - 1; i += 2) addCoin(start + i, cur);
      }
    }
  }
  while (c < cols) h[c++] = cur;

  for (let col = 0; col < cols; col++) for (let lvl = 0; lvl < h[col]; lvl++) cell(col, lvl, 1);
  const ceil = new Int8Array(cols);
  if (layout === 'caves') {
    for (let col = 0; col < cols; col++) {
      let hi = 0;
      for (let d = -1; d <= 1; d++) hi = Math.max(hi, h[clamp(col + d, 0, cols - 1)]);
      ceil[col] = clamp(1 + Math.round(1 + Math.sin(col * 0.35 + spec.map.seed) * 1.2), 1, ROWS - hi - 6);
      for (let row = 0; row < ceil[col]; row++) grid[col * ROWS + row] = 3;
    }
  }

  const wantCoins = Math.max(20, (spec.missions.find((m) => m.type === 'coins')?.target ?? 0) + 6);
  for (let guard = 0; coins.length < wantCoins && guard < 6000; guard++) {
    const col = 10 + Math.floor(r() * (cols - 22));
    const lvl = h[col] + (r() < 0.5 ? 0 : 1);
    if (h[col] > 0 && !cellAt(col, lvl) && !cellAt(col, h[col])) addCoin(col, lvl);
  }

  let cp = Math.floor(cols / 2);
  while (cp < cols - 20 && (h[cp] === 0 || h[cp + 1] === 0 || cellAt(cp, h[cp]) || cellAt(cp, h[cp] + 1))) cp++;
  const flagCol = cols - 6;
  return {
    cols, h, grid, ceil, enemies, coins, layout, maxGap,
    width: cols * T,
    checkpoint: { x: cp * T + 6, y: (ROWS - h[cp]) * T, col: cp },
    start: { x: 2 * T, y: (ROWS - h[2]) * T },
    flag: { x: flagCol * T + T / 2, y: (ROWS - h[flagCol]) * T },
  };
}

export function solidAt(L, c, row) {
  if (c < 0 || c >= L.cols) return true;
  if (row < 0 || row >= ROWS) return false;
  return L.grid[c * ROWS + row] !== 0;
}

/* ------------------------------------------------------------------ state */

export function create(spec) {
  const L = buildLevel(spec);
  const r = rng(spec.map.seed * 3 + 1);
  const hearts = byLevel(spec, [5, 4, 3]);
  const hills = [0, 1].map((layer) => Array.from({ length: 24 }, () => 0.4 + r() * 0.6));
  const props = [];
  for (let x = 0; x < L.width; x += 120 + r() * 160) props.push({ x, s: 0.7 + r() * 0.6, v: r() });
  return {
    genre: 'platformer', spec, theme: THEMES[spec.theme], L, hills, props,
    p: { x: L.start.x, y: L.start.y - PH, vx: 0, vy: 0, ground: false, coyote: 0, buffer: 0, jumpWas: false, face: 1, inv: 0, walk: 0 },
    cp: { x: L.start.x, y: L.start.y },
    hearts, maxHearts: hearts, hits: 0, coins: 0, look: 60,
    time: 0, clock: 0, reached: false, failed: false, endT: 0, over: false, events: [], intro: 1.2,
  };
}

function hurt(s, knock) {
  const p = s.p;
  if (p.inv > 0) return;
  s.hearts--;
  s.hits++;
  p.inv = 1.4;
  s.events.push('hurt');
  if (knock) { p.vx = knock * 320; p.vy = -380; }
  if (s.hearts <= 0) { s.failed = true; s.endT = 1.4; s.events.push('lose'); }
}

export function step(s, input, dt) {
  s.time += dt;
  if (s.over) return;
  const p = s.p, L = s.L;
  if (s.endT > 0) {
    s.endT -= dt;
    if (s.endT <= 0) s.over = true;
  }
  if (s.intro > 0) { s.intro -= dt; input = {}; }
  if (s.reached || s.failed) input = {};
  else if (s.intro <= 0) s.clock += dt;

  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const held = !!(input.up || input.action);
  p.vx = approach(p.vx, dir * PHYS.run, (p.ground ? (dir ? PHYS.accel : PHYS.fric) : PHYS.air) * dt);
  if (held && !p.jumpWas) p.buffer = PHYS.buffer;
  p.jumpWas = held;
  p.coyote = p.ground ? PHYS.coyote : p.coyote - dt;
  p.buffer -= dt;
  if (p.buffer > 0 && p.coyote > 0) {
    p.vy = -PHYS.jump;
    p.buffer = 0;
    p.coyote = 0;
    p.ground = false;
    s.events.push('jump');
  }
  if (!held && p.vy < -300) p.vy = -300;
  p.vy = Math.min(p.vy + PHYS.g * dt, PHYS.maxFall);
  if (dir) p.face = dir;
  if (p.inv > 0) p.inv -= dt;

  // horizontal move then vertical move, each resolved against the tile grid
  p.x += p.vx * dt;
  const top = Math.floor(p.y / T), bot = Math.floor((p.y + PH - 0.01) / T);
  if (p.vx > 0) {
    const c = Math.floor((p.x + PW) / T);
    for (let row = top; row <= bot; row++) if (solidAt(L, c, row)) { p.x = c * T - PW - 0.01; p.vx = 0; break; }
  } else if (p.vx < 0) {
    const c = Math.floor(p.x / T);
    for (let row = top; row <= bot; row++) if (solidAt(L, c, row)) { p.x = (c + 1) * T + 0.01; p.vx = 0; break; }
  }
  p.y += p.vy * dt;
  p.ground = false;
  const l = Math.floor(p.x / T), rr = Math.floor((p.x + PW - 0.01) / T);
  if (p.vy > 0) {
    const row = Math.floor((p.y + PH) / T);
    for (let c = l; c <= rr; c++) if (solidAt(L, c, row)) { p.y = row * T - PH; p.vy = 0; p.ground = true; break; }
  } else if (p.vy < 0) {
    const row = Math.floor(p.y / T);
    for (let c = l; c <= rr; c++) if (solidAt(L, c, row)) { p.y = (row + 1) * T; p.vy = 0; break; }
  }
  p.walk += Math.abs(p.vx) * dt;
  s.look = approach(s.look, p.face * 70, 160 * dt);

  if (p.y > ROWS * T + 80 && !s.failed) {
    hurt(s, 0);
    p.inv = 1.4;
    p.x = s.cp.x; p.y = s.cp.y - PH - 2; p.vx = 0; p.vy = 0;
    if (!s.failed) s.events.push('respawn');
  }
  if (p.x > L.checkpoint.x && s.cp.x !== L.checkpoint.x) { s.cp = { x: L.checkpoint.x, y: L.checkpoint.y }; s.events.push('checkpoint'); }

  for (const e of L.enemies) {
    if (!e.alive) { if (e.squash > 0) e.squash -= dt; continue; }
    e.x += e.vx * dt;
    if (e.x < e.min) { e.x = e.min; e.vx = Math.abs(e.vx); }
    if (e.x > e.max) { e.x = e.max; e.vx = -Math.abs(e.vx); }
    if (s.failed || s.reached) continue;
    if (p.x < e.x + e.w && p.x + PW > e.x && p.y < e.y + e.h && p.y + PH > e.y) {
      if (p.vy > 0 && p.y + PH - e.y < 20) {
        e.alive = false;
        e.squash = 0.4;
        p.vy = -520;
        s.events.push('stomp');
      } else hurt(s, Math.sign(p.x - e.x) || -1);
    }
  }

  for (const c of L.coins) {
    if (c.taken) continue;
    if (Math.abs(p.x + PW / 2 - c.x) < 24 && Math.abs(p.y + PH / 2 - c.y) < 28) {
      c.taken = true;
      s.coins++;
      s.events.push('coin');
    }
  }

  if (!s.reached && !s.failed && p.x + PW >= L.flag.x) {
    s.reached = true;
    s.finishTime = s.clock;
    s.endT = 2;
    s.events.push('finish');
  }
}

/** Simple bot used by the tests (and the demo mode): run right, jump at edges, walls and enemies. */
export function autopilot(s) {
  const p = s.p, L = s.L;
  if (!p.ground) return { right: true, up: p.vy < 0 };
  const ahead = Math.floor((p.x + PW + 12) / T);
  const footRow = Math.floor((p.y + PH + 2) / T);
  const bodyRow = Math.floor((p.y + PH - 4) / T);
  const edge = !solidAt(L, ahead, footRow);
  const smallDrop = edge && (solidAt(L, ahead, footRow + 1) || solidAt(L, ahead, footRow + 2));
  let jump = (edge && !smallDrop) || solidAt(L, ahead, bodyRow) || solidAt(L, ahead, bodyRow - 1);
  for (const e of L.enemies) if (e.alive && e.x > p.x && e.x - p.x < 120 && Math.abs(e.y - p.y) < 60) jump = true;
  return { right: true, up: jump };
}

export function result(s) {
  return { reached: s.reached, coins: s.coins, time: s.reached ? s.finishTime : s.clock, hits: s.hits, failed: s.failed };
}

export function hud(s) {
  return [`${'♥'.repeat(Math.max(0, s.hearts))}${'♡'.repeat(Math.max(0, s.maxHearts - s.hearts))}`, `${s.coins} shells`, formatTime(s.reached ? s.finishTime : s.clock)];
}

/* ------------------------------------------------------------------ drawing */

// Seen from the side, the reef's blue "ground" would read as water, so it becomes a sandbank.
function sideTheme(key) {
  const th = THEMES[key];
  const side = {
    reef: { ground: '#e3cf98', grass: '#4db6ac' },
    rainforest: { ground: '#6b4a2f', grass: '#4caf50' },
    sugarcane: { ground: '#9a7650', grass: '#8bc34a' },
  }[key];
  return side ? { ...th, ...side } : th;
}

function sideProp(ctx, kind, x, base, sc, v, t) {
  ctx.save();
  ctx.translate(x, base);
  ctx.scale(sc, sc);
  switch (kind) {
    case 'palm':
      ctx.strokeStyle = '#8d6e63'; ctx.lineWidth = 9; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(14, -60, 6, -120); ctx.stroke();
      ctx.fillStyle = '#43a047';
      for (let i = 0; i < 6; i++) {
        ctx.save(); ctx.translate(6, -120); ctx.rotate(-Math.PI + (i / 5) * Math.PI + Math.sin(t + v * 9) * 0.05);
        ctx.beginPath(); ctx.ellipse(30, 0, 32, 8, 0.25, 0, 7); ctx.fill(); ctx.restore();
      }
      break;
    case 'building':
    case 'neon': {
      const w = 70 + v * 50, hh = 110 + v * 140;
      ctx.fillStyle = kind === 'neon' ? '#1e2433' : ['#cfd8dc', '#ffe0b2', '#c8e6c9', '#f8bbd0'][Math.floor(v * 4)];
      ctx.fillRect(-w / 2, -hh, w, hh);
      ctx.fillStyle = kind === 'neon' ? (v > 0.5 ? '#40c4ff' : '#ff4081') : 'rgba(40,60,80,.35)';
      for (let y = -hh + 14; y < -20; y += 26) for (let xx = -w / 2 + 10; xx < w / 2 - 14; xx += 22) if (kind !== 'neon' || (xx + y + Math.floor(v * 10)) % 3) ctx.fillRect(xx, y, 12, 14);
      break;
    }
    case 'cane':
      ctx.strokeStyle = '#7cb342'; ctx.lineWidth = 4;
      for (let i = -4; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i * 9, 0); ctx.lineTo(i * 9 + Math.sin(t * 1.5 + i) * 4, -70 - (i % 2) * 14); ctx.stroke(); }
      break;
    case 'tree':
      ctx.fillStyle = '#5d4037'; ctx.fillRect(-6, -60, 12, 60);
      ctx.fillStyle = '#2e7d32';
      ctx.beginPath(); ctx.arc(0, -90, 44, 0, 7); ctx.arc(-30, -66, 28, 0, 7); ctx.arc(30, -66, 28, 0, 7); ctx.fill();
      break;
    case 'rock':
      ctx.fillStyle = '#4e3f3c';
      ctx.beginPath(); ctx.moveTo(-60, 0); ctx.lineTo(-20, -90 - v * 60); ctx.lineTo(10, -60); ctx.lineTo(40, -110 - v * 40); ctx.lineTo(70, 0); ctx.fill();
      ctx.fillStyle = '#ff6d00';
      ctx.beginPath(); ctx.arc(40, -110 - v * 40, 6 + Math.sin(t * 3) * 2, 0, 7); ctx.fill();
      break;
    case 'coral': {
      ctx.strokeStyle = ['#ff80ab', '#ffab40', '#ea80fc'][Math.floor(v * 3)]; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -50); ctx.moveTo(0, -30); ctx.lineTo(-22, -60); ctx.moveTo(0, -24); ctx.lineTo(24, -54); ctx.stroke();
      break;
    }
    default:
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 2 + v * 30);
      ctx.fillRect(0, -200 - v * 300, 3, 3);
  }
  ctx.restore();
}

function drawEnemy(ctx, e, themeKey, t) {
  ctx.save();
  ctx.translate(e.x + e.w / 2, e.y + e.h);
  if (!e.alive) ctx.scale(1.2, Math.max(0.2, e.squash));
  const crab = ['fiji-coast', 'reef', 'sugarcane'].includes(themeKey);
  if (crab) {
    ctx.fillStyle = '#e53935';
    ctx.beginPath(); ctx.ellipse(0, -11, 15, 11, 0, Math.PI, 0); ctx.fill();
    ctx.fillRect(-15, -11, 30, 4);
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 3;
    const leg = Math.sin(t * 14 + e.x) * 3;
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.moveTo(sx * 10, -6); ctx.lineTo(sx * 16, leg); ctx.stroke(); ctx.beginPath(); ctx.arc(sx * 19, -16, 5, 0, 7); ctx.stroke(); }
    ctx.fillStyle = '#fff';
    ctx.fillRect(-6, -24, 4, 6); ctx.fillRect(2, -24, 4, 6);
  } else if (themeKey === 'volcano') {
    ctx.fillStyle = '#ff6d00';
    ctx.beginPath(); ctx.ellipse(0, -12, 15 + Math.sin(t * 6) * 2, 12, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffd180';
    ctx.beginPath(); ctx.arc(-5, -15, 3, 0, 7); ctx.arc(5, -15, 3, 0, 7); ctx.fill();
  } else if (themeKey === 'rainforest') {
    ctx.fillStyle = '#1b5e20';
    ctx.beginPath(); ctx.ellipse(0, -12, 15, 12, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#76ff03';
    ctx.fillRect(-1, -24, 2, 12);
    ctx.fillStyle = '#212121';
    ctx.fillRect(-15, -4, 30, 4);
  } else {
    ctx.translate(0, Math.sin(t * 5 + e.x) * 3 - 6);
    ctx.fillStyle = '#546e7a';
    rrect(ctx, -14, -22, 28, 18, 6); ctx.fill();
    ctx.fillStyle = '#ff5252';
    ctx.fillRect(-4, -16, 8, 5);
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.fillRect(-18, -26, 36, 3);
  }
  ctx.restore();
}

export function drawHero(ctx, kind, color, x, y, face, walk, ground) {
  ctx.save();
  ctx.translate(x + PW / 2, y + PH);
  ctx.scale(face, 1);
  const leg = ground ? Math.sin(walk * 0.08) * 5 : 3;
  ctx.fillStyle = '#263238';
  ctx.fillRect(-8 + leg * 0.3, -10, 6, 10);
  ctx.fillRect(2 - leg * 0.3, -10, 6, 10);
  if (kind === 'robot') {
    ctx.fillStyle = '#b0bec5';
    rrect(ctx, -12, -32, 24, 22, 5); ctx.fill();
    ctx.fillStyle = color;
    rrect(ctx, -10, -30, 20, 8, 3); ctx.fill();
    ctx.fillStyle = '#e3f2fd';
    ctx.fillRect(2, -28, 6, 4);
    ctx.strokeStyle = '#78909c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -32); ctx.lineTo(0, -38); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, -39, 3, 0, 7); ctx.fill();
  } else {
    ctx.fillStyle = color;
    rrect(ctx, -10, -26, 20, 18, 5); ctx.fill();
    ctx.fillStyle = '#8d5524';
    ctx.beginPath(); ctx.arc(1, -31, 8, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillRect(4, -33, 3, 3);
    if (kind === 'explorer') {
      ctx.fillStyle = '#a1887f';
      ctx.fillRect(-11, -38, 22, 4);
      rrect(ctx, -7, -44, 14, 8, 3); ctx.fill();
    } else {
      ctx.fillStyle = '#212121';
      ctx.beginPath(); ctx.arc(1, -34, 8, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#ffeb3b';
      rrect(ctx, -18, -30, 6, 26, 3); ctx.fill();
    }
  }
  ctx.restore();
}

export function draw(ctx, s, W, H, ui = {}) {
  const th = sideTheme(s.spec.theme), key = s.spec.theme, L = s.L, p = s.p;
  const z = clamp(Math.min(H / (ROWS * T), W / (11 * T)), 0.45, 2);
  const viewW = W / z;
  const levelH = ROWS * T * z;
  const extra = H - levelH;
  const oy = extra > 0 ? extra - Math.min(extra, ui.bottom ?? 0) : 0;
  const camX = clamp(p.x + PW / 2 + s.look - viewW / 2, 0, Math.max(0, L.width - viewW));

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, th.sky[0]); g.addColorStop(1, th.sky[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // parallax hills
  s.hills.forEach((pts, layer) => {
    const par = layer ? 0.45 : 0.2;
    ctx.fillStyle = layer ? shade(th.grass, -0.15) : shade(th.sky[0], -0.18);
    ctx.globalAlpha = layer ? 0.85 : 0.6;
    ctx.beginPath();
    ctx.moveTo(0, H);
    const span = W * 0.4;
    const off = (camX * z * par) % span;
    for (let i = -1; i <= W / span + 2; i++) {
      const k = Math.floor((camX * z * par) / span) + i;
      const hh = pts[((k % pts.length) + pts.length) % pts.length];
      ctx.quadraticCurveTo(i * span - off + span / 2, oy + levelH * (0.55 - hh * 0.32 + layer * 0.12), (i + 1) * span - off, oy + levelH * (0.62 + layer * 0.1));
    }
    ctx.lineTo(W, H);
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  ctx.save();
  ctx.translate(0, oy);
  ctx.scale(z, z);
  ctx.translate(-camX, 0);

  // background props on a slower layer
  ctx.save();
  ctx.translate(camX * 0.35, 0);
  for (const pr of s.props) {
    const wx = pr.x + camX * 0.35; // where it lands in world space after the parallax shift
    if (wx < camX - 200 || wx > camX + viewW + 200) continue;
    sideProp(ctx, th.prop, pr.x, (ROWS - 2.2) * T, pr.s, pr.v, s.time);
  }
  ctx.restore();

  // water or lava at the bottom shows through the pits
  ctx.fillStyle = th.water;
  ctx.fillRect(camX - 10, (ROWS - 0.9) * T, viewW + 20, T * 2);
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  for (let x = Math.floor(camX / 40) * 40; x < camX + viewW; x += 40) ctx.fillRect(x + Math.sin(s.time * 2 + x) * 6, (ROWS - 0.9) * T + 4, 18, 3);

  const c0 = Math.max(0, Math.floor(camX / T) - 1), c1 = Math.min(L.cols - 1, Math.ceil((camX + viewW) / T) + 1);
  for (let c = c0; c <= c1; c++) {
    const hh = L.h[c];
    if (hh > 0) {
      const y = (ROWS - hh) * T;
      ctx.fillStyle = th.ground;
      ctx.fillRect(c * T, y, T + 0.5, hh * T);
      ctx.fillStyle = shade(th.ground, -0.08);
      for (let lvl = 1; lvl < hh; lvl++) if ((c + lvl) % 3 === 0) ctx.fillRect(c * T + 8, y + lvl * T + 10, 6, 6);
      ctx.fillStyle = th.grass;
      ctx.fillRect(c * T, y, T + 0.5, 10);
      ctx.fillStyle = shade(th.grass, 0.2);
      ctx.fillRect(c * T, y, T + 0.5, 3);
    }
    for (let row = 0; row < ROWS; row++) {
      const v = L.grid[c * ROWS + row];
      if (v === 2) {
        ctx.fillStyle = shade(th.ground, -0.1);
        rrect(ctx, c * T + 1, row * T + 2, T - 2, T - 6, 6); ctx.fill();
        ctx.fillStyle = th.grass;
        rrect(ctx, c * T + 1, row * T + 2, T - 2, 9, 4); ctx.fill();
      } else if (v === 3) {
        ctx.fillStyle = shade(th.ground, -0.3);
        ctx.fillRect(c * T, row * T, T + 0.5, T + 0.5);
      }
    }
  }

  // checkpoint and flag
  const cp = L.checkpoint;
  ctx.fillStyle = '#eceff1';
  ctx.fillRect(cp.x, cp.y - 60, 4, 60);
  ctx.fillStyle = s.cp.x === cp.x ? '#43a047' : '#90a4ae';
  ctx.beginPath(); ctx.moveTo(cp.x + 4, cp.y - 60); ctx.lineTo(cp.x + 28, cp.y - 52); ctx.lineTo(cp.x + 4, cp.y - 44); ctx.fill();
  const f = L.flag;
  ctx.fillStyle = '#eceff1';
  ctx.fillRect(f.x - 3, f.y - 150, 6, 150);
  ctx.fillStyle = th.accent;
  const wave = Math.sin(s.time * 5) * 4;
  ctx.beginPath(); ctx.moveTo(f.x + 3, f.y - 150); ctx.quadraticCurveTo(f.x + 30, f.y - 140 + wave, f.x + 56, f.y - 132); ctx.lineTo(f.x + 3, f.y - 112); ctx.fill();

  for (const c of L.coins) {
    if (c.taken || c.x < camX - 40 || c.x > camX + viewW + 40) continue;
    const b = Math.sin(s.time * 4 + c.x * 0.05) * 3;
    ctx.fillStyle = '#ffd54f';
    ctx.beginPath(); ctx.moveTo(c.x - 11, c.y + 7 + b); ctx.quadraticCurveTo(c.x, c.y - 16 + b, c.x + 11, c.y + 7 + b); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#ffa000'; ctx.lineWidth = 1.5;
    for (const dx of [-5, 0, 5]) { ctx.beginPath(); ctx.moveTo(c.x, c.y - 6 + b); ctx.lineTo(c.x + dx, c.y + 6 + b); ctx.stroke(); }
  }
  for (const e of L.enemies) if ((e.alive || e.squash > 0) && e.x > camX - 60 && e.x < camX + viewW + 60) drawEnemy(ctx, e, key, s.time);

  if (!(p.inv > 0 && Math.floor(s.time * 12) % 2)) drawHero(ctx, s.spec.player.kind, s.spec.player.color, p.x, p.y, p.face, p.walk, p.ground);
  ctx.restore();

  if (key === 'night-city' || key === 'space' || L.layout === 'caves') {
    ctx.fillStyle = L.layout === 'caves' ? 'rgba(10,8,20,.18)' : 'rgba(10,10,40,.12)';
    ctx.fillRect(0, 0, W, H);
  }
  if (s.intro > 0 && !ui.still) {
    ctx.font = `700 ${Math.round(Math.min(W, H) * 0.09)}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = Math.min(1, s.intro * 2);
    ctx.fillText('Ready?', W / 2, H * 0.38);
    ctx.globalAlpha = 1;
  }
}

export function thumb(ctx, spec, w, h) {
  const L = buildLevel(spec);
  const th = sideTheme(spec.theme);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, th.sky[0]); g.addColorStop(1, th.sky[1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const cols = 40;
  const tw = w / cols, sc = h / (ROWS * T) * 1.6;
  ctx.fillStyle = th.water;
  ctx.fillRect(0, h - 6, w, 6);
  for (let c = 0; c < cols; c++) {
    const hh = L.h[c + 6];
    if (hh) {
      const top = h - hh * T * sc;
      ctx.fillStyle = th.ground;
      ctx.fillRect(c * tw, top, tw + 0.5, h - top);
      ctx.fillStyle = th.grass;
      ctx.fillRect(c * tw, top, tw + 0.5, 4);
    }
    for (let row = 0; row < ROWS; row++) {
      if (L.grid[(c + 6) * ROWS + row] === 2) { ctx.fillStyle = th.grass; ctx.fillRect(c * tw, h - (ROWS - row) * T * sc, tw, 5); }
    }
  }
  ctx.fillStyle = spec.player.color;
  rrect(ctx, tw * 2, h - L.h[8] * T * sc - 20, 12, 18, 3); ctx.fill();
}
