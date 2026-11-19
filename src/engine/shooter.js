// Vertical arcade shooter on a fixed 480x720 field (letterboxed to the screen):
// waves of enemies, power-ups, an optional storm or asteroid field, then a boss.
import { rng, THEMES } from '../spec.js';
import { clamp, shade, rrect, byLevel, LEVEL } from './core.js';

export const FW = 480;
export const FH = 720;

const WAVE_TYPES = {
  'open-sky': ['line', 'sine', 'dive', 'turret'],
  asteroids: ['rocks', 'line', 'rocks', 'dive', 'sine'],
  storm: ['sine', 'dive', 'line', 'turret'],
};

export function create(spec) {
  const r = rng(spec.map.seed * 17 + 11);
  const lv = LEVEL[spec.difficulty] ?? 1;
  const types = WAVE_TYPES[spec.map.layout] || WAVE_TYPES['open-sky'];
  const count = [0, 5, 8, 11][spec.map.length];
  const waves = [];
  for (let i = 0; i < count; i++) waves.push(types[(i + Math.floor(r() * 2)) % types.length]);
  const stars = Array.from({ length: 90 }, () => ({ x: r() * FW, y: r() * FH, z: 0.3 + r() * 0.9 }));
  const lives = byLevel(spec, [5, 3, 3]);
  return {
    genre: 'shooter', spec, theme: THEMES[spec.theme], r, lv, waves, stars,
    p: { x: FW / 2, y: FH - 90, r: 13, lives, inv: 0, cd: 0, spread: 0, rapid: 0, shield: 0, tilt: 0 },
    maxLives: 5, bullets: [], ebullets: [], enemies: [], queue: [], drops: [], fx: [], bolts: [],
    wave: -1, waveT: 0, banner: null, boss: null, boltT: 6,
    phase: 'intro', introT: 1.4, time: 0, clock: 0, score: 0, shots: 0, landed: 0, livesLost: 0,
    bossDefeated: false, failed: false, endT: 0, over: false, events: [], god: false,
  };
}

/* ------------------------------------------------------------------ spawning */

function spawnWave(s, type) {
  const r = s.r, lv = s.lv;
  const fire = () => 1.5 + r() * 3.5 / (0.6 + lv * 0.4);
  if (type === 'line') {
    const n = 6 + lv;
    for (let i = 0; i < n; i++) {
      s.enemies.push({ kind: 'drone', x: 50 + (i * (FW - 100)) / (n - 1), y: -30 - (i % 2) * 40, ty: 90 + (i % 2) * 55, hp: 1, r: 15, t: r() * 6, fireT: fire(), bx: 0, value: 100 });
    }
  } else if (type === 'sine') {
    const n = 7 + lv, base = 120 + r() * 240;
    for (let i = 0; i < n; i++) s.queue.push({ at: s.clock + i * 0.35, e: { kind: 'snake', x: base, y: -30, base, hp: 1, r: 14, t: i * 0.5, fireT: fire(), value: 100 } });
  } else if (type === 'dive') {
    const n = 5 + lv;
    for (let i = 0; i < n; i++) s.queue.push({ at: s.clock + i * 0.5, e: { kind: 'diver', x: 40 + r() * (FW - 80), y: -30, ty: 80 + r() * 80, hover: 0.8 + r() * 1.5, hp: 1, r: 14, t: 0, fireT: 99, value: 150 } });
  } else if (type === 'turret') {
    const n = 2 + (lv > 1 ? 1 : 0);
    for (let i = 0; i < n; i++) s.enemies.push({ kind: 'turret', x: (FW / (n + 1)) * (i + 1), y: -40, ty: 110, hp: 7 + lv * 2, max: 7 + lv * 2, r: 24, t: r() * 6, fireT: 1 + i * 0.5, value: 400 });
  } else if (type === 'rocks') {
    const n = 5 + lv;
    for (let i = 0; i < n; i++) s.queue.push({ at: s.clock + i * 0.6, e: rock(r, 40 + r() * (FW - 80), -40, 26) });
  }
}

function rock(r, x, y, size) {
  return { kind: 'rock', x, y, vx: (r() - 0.5) * 80, vy: 70 + r() * 60, r: size, hp: size > 20 ? 4 : 1, t: 0, spin: (r() - 0.5) * 3, fireT: 99, value: size > 20 ? 120 : 50, seed: r() };
}

function spawnBoss(s) {
  const hp = [60, 90, 130][s.lv] + s.spec.map.length * 15;
  s.boss = { x: FW / 2, y: -140, ty: 140, r: 56, hp, max: hp, t: 0, pat: 0, patT: 2.5, dir: 1, minionT: 6, burst: [] };
  s.banner = { text: 'Boss incoming', t: 2.2 };
  s.events.push('warning');
}

function shoot(s, x, y, angle, speed) {
  s.ebullets.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r: 5 });
}

function explode(s, x, y, size, color) {
  for (let i = 0; i < 10 + size / 3; i++) {
    const a = s.r() * Math.PI * 2, v = 40 + s.r() * 160;
    s.fx.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0.5 + s.r() * 0.4, c: color, size: 2 + s.r() * size / 6 });
  }
}

function damagePlayer(s) {
  const p = s.p;
  if (s.god || p.inv > 0 || s.failed || s.bossDefeated) return;
  if (p.shield) { p.shield = 0; p.inv = 1; s.events.push('shield'); return; }
  p.lives--;
  s.livesLost++;
  p.inv = 2;
  s.events.push('hurt');
  explode(s, p.x, p.y, 30, '#ffab40');
  if (p.lives <= 0) { s.failed = true; s.endT = 1.8; s.events.push('lose'); }
}

/* ------------------------------------------------------------------ simulation */

export function step(s, input, dt) {
  s.time += dt;
  if (s.over) return;
  if (s.endT > 0) { s.endT -= dt; if (s.endT <= 0) s.over = true; }
  const p = s.p, r = s.r, bulletSpeed = [190, 230, 270][s.lv];
  if (s.phase === 'intro') {
    s.introT -= dt;
    if (s.introT <= 0) s.phase = 'waves';
  } else if (!s.failed && !s.bossDefeated) s.clock += dt;

  // player movement
  const alive = !s.failed;
  if (alive) {
    let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    let sp = 330;
    if (input.pointer) {
      const tx = input.pointer.x - p.x, ty = input.pointer.y - 70 - p.y;
      const d = Math.hypot(tx, ty);
      sp = Math.min(560, d * 10);
      dx = d > 1 ? tx / d : 0;
      dy = d > 1 ? ty / d : 0;
    }
    p.x = clamp(p.x + dx * sp * dt, 22, FW - 22);
    p.y = clamp(p.y + dy * sp * dt, 260, FH - 34);
    p.tilt += (dx * 0.35 - p.tilt) * Math.min(1, dt * 10);
    p.cd -= dt;
    if ((input.action || input.pointer) && p.cd <= 0 && s.phase !== 'intro') {
      p.cd = p.rapid > 0 ? 0.09 : 0.17;
      const angles = p.spread > 0 ? [-0.22, 0, 0.22] : [0];
      for (const a of angles) {
        s.bullets.push({ x: p.x + a * 30, y: p.y - 18, vx: Math.sin(a) * 640, vy: -Math.cos(a) * 640, r: 4 });
        s.shots++;
      }
      s.events.push('shoot');
    }
    if (p.inv > 0) p.inv -= dt;
    if (p.spread > 0) p.spread -= dt;
    if (p.rapid > 0) p.rapid -= dt;
  }

  // waves, then the boss
  if (s.phase === 'waves') {
    s.waveT += dt;
    const pending = s.enemies.length + s.queue.length;
    if ((pending === 0 && s.waveT > 1.2) || s.waveT > 16 || s.wave < 0) {
      s.wave++;
      s.waveT = 0;
      if (s.wave < s.waves.length) {
        spawnWave(s, s.waves[s.wave]);
        s.banner = { text: `Wave ${s.wave + 1} of ${s.waves.length}`, t: 1.4 };
      } else if (pending === 0) {
        s.phase = 'boss';
        spawnBoss(s);
      } else s.wave--;
    }
  }
  for (let i = s.queue.length - 1; i >= 0; i--) if (s.queue[i].at <= s.clock) { s.enemies.push(s.queue[i].e); s.queue.splice(i, 1); }
  if (s.banner) { s.banner.t -= dt; if (s.banner.t <= 0) s.banner = null; }

  // enemies
  const rate = [0.6, 1, 1.4][s.lv];
  for (const e of s.enemies) {
    e.t += dt;
    if (e.kind === 'drone') {
      if (e.y < e.ty) e.y += 140 * dt;
      else { if (!e.bx) e.bx = e.x; e.x = e.bx + Math.sin(e.t * 1.2) * 50; }
    } else if (e.kind === 'snake') {
      e.x = e.base + Math.sin(e.t * 2.4) * 120;
      e.y += 105 * dt;
    } else if (e.kind === 'diver') {
      if (!e.vy) {
        if (e.y < e.ty) e.y += 160 * dt;
        else if ((e.hover -= dt) <= 0) {
          const a = Math.atan2(p.y - e.y, p.x - e.x);
          e.vx = Math.cos(a) * (280 + s.lv * 40);
          e.vy = Math.sin(a) * (280 + s.lv * 40);
          s.events.push('dive');
        }
      } else { e.x += e.vx * dt; e.y += e.vy * dt; }
    } else if (e.kind === 'turret') {
      if (e.y < e.ty) e.y += 80 * dt;
      else e.x = clamp(e.x + Math.sin(e.t * 0.7) * 40 * dt, 40, FW - 40);
    } else if (e.kind === 'rock') {
      e.x += e.vx * dt; e.y += e.vy * dt;
      if (e.x < e.r || e.x > FW - e.r) e.vx *= -1;
    }
    e.fireT -= dt * rate;
    if (e.fireT <= 0 && e.y > 0 && e.y < FH * 0.6 && !s.failed) {
      if (e.kind === 'turret') {
        const a = Math.atan2(p.y - e.y, p.x - e.x);
        for (const d of [-0.18, 0, 0.18]) shoot(s, e.x, e.y + 16, a + d, bulletSpeed);
        e.fireT = 1.8;
      } else {
        shoot(s, e.x, e.y + 10, Math.PI / 2, bulletSpeed);
        e.fireT = 2 + r() * 3;
      }
    }
    if (!s.failed && Math.hypot(e.x - p.x, e.y - p.y) < e.r + p.r - 4) {
      damagePlayer(s);
      if (e.kind !== 'turret') e.hp = 0;
    }
  }

  // boss
  const b = s.boss;
  if (b && b.hp > 0) {
    b.t += dt;
    b.y += (b.ty - b.y) * Math.min(1, dt * 1.5);
    const angry = b.hp < b.max / 2;
    b.x += b.dir * (angry ? 95 : 60) * dt;
    if (b.x < 90 || b.x > FW - 90) { b.dir *= -1; b.x = clamp(b.x, 90, FW - 90); }
    if (b.y > 80 && !s.failed) {
      b.patT -= dt;
      if (b.patT <= 0) {
        const pat = b.pat++ % 3;
        if (pat === 0) {
          const n = 14 + s.lv * 4, off = b.t;
          for (let i = 0; i < n; i++) shoot(s, b.x, b.y + 20, off + (i / n) * Math.PI * 2, bulletSpeed * 0.8);
        } else if (pat === 1) {
          b.burst = [0, 0.28, 0.56];
        } else {
          for (let i = 0; i < 10; i++) shoot(s, b.x - 60 + r() * 120, b.y + 30, Math.PI / 2 + (r() - 0.5) * 0.5, bulletSpeed * (0.8 + r() * 0.4));
        }
        b.patT = (angry ? 1.6 : 2.3) - s.lv * 0.15;
        s.events.push('bossfire');
      }
      for (let i = b.burst.length - 1; i >= 0; i--) {
        b.burst[i] -= dt;
        if (b.burst[i] <= 0) {
          const a = Math.atan2(p.y - b.y, p.x - b.x);
          for (const d of [-0.15, 0, 0.15]) shoot(s, b.x, b.y + 30, a + d, bulletSpeed * 1.15);
          b.burst.splice(i, 1);
        }
      }
      if (angry && (b.minionT -= dt) <= 0) {
        b.minionT = 7;
        for (const side of [-1, 1]) s.enemies.push({ kind: 'diver', x: b.x + side * 70, y: b.y, ty: b.y + 40, hover: 0.6, hp: 1, r: 14, t: 0, fireT: 99, value: 150 });
      }
    }
    if (!s.failed && Math.hypot(b.x - p.x, b.y - p.y) < b.r + p.r) damagePlayer(s);
  }

  // player bullets
  for (const bl of s.bullets) {
    bl.x += bl.vx * dt; bl.y += bl.vy * dt;
    for (const e of s.enemies) {
      if (e.hp > 0 && Math.hypot(e.x - bl.x, e.y - bl.y) < e.r + bl.r) {
        e.hp--; bl.dead = true; s.landed++;
        if (e.hp > 0) s.events.push('tick');
        break;
      }
    }
    if (!bl.dead && b && b.hp > 0 && b.y > 40 && Math.abs(bl.x - b.x) < b.r * 1.3 && Math.abs(bl.y - b.y) < b.r * 0.7) {
      b.hp--; bl.dead = true; s.landed++;
      if (b.hp <= 0) {
        s.bossDefeated = true;
        s.score += 5000 + (s.livesLost === 0 ? 2000 : 0);
        s.endT = 2.6;
        explode(s, b.x, b.y, 90, '#ffd180');
        explode(s, b.x - 30, b.y + 10, 60, s.theme.accent);
        s.events.push('bossdown');
      }
    }
  }
  s.bullets = s.bullets.filter((bl) => !bl.dead && bl.y > -20 && bl.x > -20 && bl.x < FW + 20);

  // dead enemies: score, debris, power-ups; leave the screen silently
  const keep = [];
  for (const e of s.enemies) {
    if (e.hp <= 0) {
      s.score += e.value;
      explode(s, e.x, e.y, e.r, e.kind === 'rock' ? '#a1887f' : s.theme.accent);
      s.events.push('boom');
      if (e.kind === 'rock' && e.r > 20) { keep.push(rock(r, e.x - 10, e.y, 14), rock(r, e.x + 10, e.y, 14)); }
      if (r() < 0.11 || e.kind === 'turret') s.drops.push({ x: e.x, y: e.y, kind: ['spread', 'rapid', 'shield', 'heart'][Math.floor(r() * 4)], t: 0 });
      continue;
    }
    if (e.y > FH + 50 || e.x < -80 || e.x > FW + 80) continue;
    keep.push(e);
  }
  s.enemies = keep;

  for (const eb of s.ebullets) {
    eb.x += eb.vx * dt; eb.y += eb.vy * dt;
    if (!s.failed && Math.hypot(eb.x - p.x, eb.y - p.y) < eb.r + p.r - 5) { eb.dead = true; damagePlayer(s); }
  }
  s.ebullets = s.ebullets.filter((eb) => !eb.dead && eb.y < FH + 20 && eb.y > -40 && eb.x > -20 && eb.x < FW + 20);
  if (s.bossDefeated) s.ebullets.length = 0;

  for (const d of s.drops) {
    d.y += 90 * dt; d.t += dt;
    if (!s.failed && Math.hypot(d.x - p.x, d.y - p.y) < 26) {
      d.dead = true;
      if (d.kind === 'spread') p.spread = 12;
      else if (d.kind === 'rapid') p.rapid = 10;
      else if (d.kind === 'shield') p.shield = 1;
      else p.lives = Math.min(s.maxLives, p.lives + 1);
      s.score += 50;
      s.events.push('power');
    }
  }
  s.drops = s.drops.filter((d) => !d.dead && d.y < FH + 30);

  // storm: warned lightning columns
  if (s.spec.map.layout === 'storm' && s.phase !== 'intro' && !s.bossDefeated) {
    s.boltT -= dt;
    if (s.boltT <= 0) {
      s.bolts.push({ x: clamp(p.x + (r() - 0.5) * 160, 30, FW - 30), warn: 1.1 - s.lv * 0.15, strike: 0.3 });
      s.boltT = 6 - s.lv + r() * 3;
    }
    for (const bo of s.bolts) {
      if (bo.warn > 0) { bo.warn -= dt; if (bo.warn <= 0) s.events.push('thunder'); }
      else {
        bo.strike -= dt;
        if (Math.abs(p.x - bo.x) < 24) damagePlayer(s);
      }
    }
    s.bolts = s.bolts.filter((bo) => bo.strike > 0);
  }

  for (const f of s.fx) { f.x += f.vx * dt; f.y += f.vy * dt; f.t -= dt; f.vx *= 0.96; f.vy *= 0.96; }
  s.fx = s.fx.filter((f) => f.t > 0);
}

/** Test bot: never takes damage (god mode is set by the test), sits under the nearest target and fires. */
export function autopilot(s) {
  const t = s.boss && s.boss.hp > 0 ? s.boss : s.enemies.filter((e) => e.y > 0).sort((a, b) => b.y - a.y)[0];
  const x = t ? t.x : FW / 2;
  return { left: s.p.x > x + 6, right: s.p.x < x - 6, action: true };
}

export function result(s) {
  return {
    score: s.score, bossDefeated: s.bossDefeated, shots: s.shots, landed: s.landed,
    accuracy: s.shots ? Math.round((s.landed / s.shots) * 100) : 0, livesLost: s.livesLost, failed: s.failed, time: s.clock,
  };
}

export function hud(s) {
  const lives = Math.max(0, s.p.lives);
  const stage = s.phase === 'boss' ? 'Boss' : s.wave >= 0 ? `Wave ${Math.min(s.wave + 1, s.waves.length)}/${s.waves.length}` : 'Ready';
  return [`${'♥'.repeat(lives)}`, stage, s.score.toLocaleString('en')];
}

/** Map a point on the canvas to field coordinates (for touch steering). */
export function toField(W, H, x, y) {
  const sc = Math.min(W / FW, H / FH);
  return { x: (x - (W - FW * sc) / 2) / sc, y: (y - (H - FH * sc) / 2) / sc };
}

/* ------------------------------------------------------------------ drawing */

function drawShip(ctx, kind, color, x, y, tilt, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.rotate(tilt * 0.4);
  if (kind === 'boat') {
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.beginPath(); ctx.moveTo(-14, 18); ctx.lineTo(-22, 40); ctx.lineTo(22, 40); ctx.lineTo(14, 18); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(0, -24); ctx.quadraticCurveTo(16, -6, 13, 20); ctx.lineTo(-13, 20); ctx.quadraticCurveTo(-16, -6, 0, -24); ctx.fill();
    ctx.fillStyle = '#eceff1';
    rrect(ctx, -7, -4, 14, 12, 3); ctx.fill();
  } else if (kind === 'saucer') {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(0, 4, 24, 10, 0, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(178,235,242,.9)';
    ctx.beginPath(); ctx.ellipse(0, -2, 11, 10, 0, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#fff59d';
    for (const dx of [-14, 0, 14]) { ctx.beginPath(); ctx.arc(dx, 6, 2.5, 0, 7); ctx.fill(); }
  } else {
    ctx.fillStyle = shade(color, -0.25);
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(24, 12); ctx.lineTo(24, 17); ctx.lineTo(0, 10); ctx.lineTo(-24, 17); ctx.lineTo(-24, 12); ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.moveTo(0, -26); ctx.quadraticCurveTo(8, -10, 7, 20); ctx.lineTo(-7, 20); ctx.quadraticCurveTo(-8, -10, 0, -26); ctx.fill();
    ctx.fillStyle = 'rgba(178,235,242,.95)';
    ctx.beginPath(); ctx.ellipse(0, -8, 3.5, 7, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffab40';
    ctx.beginPath(); ctx.moveTo(-5, 20); ctx.lineTo(0, 28 + Math.random() * 6); ctx.lineTo(5, 20); ctx.fill();
  }
  ctx.restore();
}

function background(ctx, s, x0, x1) {
  const th = s.theme, key = s.spec.theme, scroll = s.time * 70;
  if (key === 'space') {
    const g = ctx.createLinearGradient(0, 0, 0, FH);
    g.addColorStop(0, th.sky[0]); g.addColorStop(1, th.sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(x0, 0, x1 - x0, FH);
    for (const st of s.stars) {
      ctx.fillStyle = `rgba(255,255,255,${0.3 + st.z * 0.6})`;
      ctx.fillRect(st.x, (st.y + scroll * st.z) % FH, st.z * 2, st.z * 2);
    }
    return;
  }
  const sea = key === 'fiji-coast' || key === 'reef';
  ctx.fillStyle = sea ? th.water : th.ground;
  ctx.fillRect(x0, 0, x1 - x0, FH);
  const chunk = 260;
  const first = Math.floor(-scroll / chunk) - 1;
  for (let k = first; k < first + FH / chunk + 3; k++) {
    const rr = rng(Math.abs(k * 977 + s.spec.map.seed) + 1);
    const y0 = k * chunk + scroll;
    for (let i = 0; i < 3; i++) {
      const x = x0 + rr() * (x1 - x0), y = y0 + rr() * chunk, sz = 30 + rr() * 60;
      if (sea) {
        if (key === 'reef') {
          ctx.fillStyle = ['#ff80ab', '#ffab40', '#26a69a'][i];
          ctx.globalAlpha = 0.55;
          ctx.beginPath(); ctx.arc(x, y, sz * 0.5, 0, 7); ctx.fill();
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = shade(th.water, 0.25);
          ctx.beginPath(); ctx.arc(x, y, sz + 14, 0, 7); ctx.fill();
          ctx.fillStyle = th.ground;
          ctx.beginPath(); ctx.arc(x, y, sz, 0, 7); ctx.fill();
          ctx.fillStyle = th.grass;
          ctx.beginPath(); ctx.arc(x + 4, y - 4, sz * 0.6, 0, 7); ctx.fill();
        }
      } else if (key === 'suva-city' || key === 'night-city') {
        ctx.fillStyle = key === 'night-city' ? ['#2b3245', '#323a52', '#1e2433'][i] : ['#cfd8dc', '#ffe0b2', '#c8e6c9'][i];
        ctx.fillRect(x, y, sz, sz * 0.8);
        if (key === 'night-city') { ctx.strokeStyle = i ? '#40c4ff' : '#ff4081'; ctx.lineWidth = 2; ctx.strokeRect(x + 3, y + 3, sz - 6, sz * 0.8 - 6); }
      } else if (key === 'volcano') {
        ctx.strokeStyle = '#ff6d00'; ctx.lineWidth = 3; ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + sz * 0.6, y + sz * 0.3); ctx.lineTo(x + sz * 0.4, y + sz); ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = key === 'sugarcane' ? '#8bbd55' : '#2e7d32';
        ctx.beginPath(); ctx.arc(x, y, sz * 0.6, 0, 7); ctx.fill();
      }
    }
  }
  const stormy = s.spec.map.layout === 'storm';
  ctx.fillStyle = stormy ? 'rgba(40,44,60,.35)' : 'rgba(255,255,255,.35)';
  for (let k = Math.floor(-scroll * 2 / 400) - 1; k < Math.floor(-scroll * 2 / 400) + 4; k++) {
    const rr = rng(Math.abs(k * 131 + 7) + 2);
    const y = k * 400 + scroll * 2;
    ctx.beginPath(); ctx.ellipse(x0 + rr() * (x1 - x0), y, 90, 30, 0, 0, 7); ctx.fill();
  }
  if (stormy) {
    ctx.strokeStyle = 'rgba(200,220,255,.3)'; ctx.lineWidth = 1.5;
    for (let i = 0; i < 40; i++) {
      const x = ((i * 53 + s.time * 60) % (x1 - x0)) + x0, y = (i * 97 + s.time * 700) % FH;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 14); ctx.stroke();
    }
  }
}

export function draw(ctx, s, W, H, ui = {}) {
  const sc = Math.min(W / FW, H / FH);
  const ox = (W - FW * sc) / 2, oy = (H - FH * sc) / 2;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(sc, sc);
  const x0 = -ox / sc, x1 = (W - ox) / sc;
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, -oy / sc, x1 - x0, H / sc); ctx.clip();
  background(ctx, s, x0, x1);
  ctx.restore();
  // dim the area outside the play field so its edges are clear
  ctx.fillStyle = 'rgba(0,0,0,.35)';
  ctx.fillRect(x0, 0, -x0, FH);
  ctx.fillRect(FW, 0, x1 - FW, FH);

  for (const bo of s.bolts) {
    if (bo.warn > 0) {
      ctx.fillStyle = `rgba(255,235,59,${0.12 + 0.12 * Math.sin(s.time * 30)})`;
      ctx.fillRect(bo.x - 24, 0, 48, FH);
    } else {
      ctx.strokeStyle = '#fffde7'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(bo.x, 0);
      for (let y = 40; y <= FH; y += 40) ctx.lineTo(bo.x + (Math.random() - 0.5) * 30, y);
      ctx.stroke();
    }
  }

  for (const d of s.drops) {
    const col = { spread: '#40c4ff', rapid: '#ffab40', shield: '#b388ff', heart: '#ff5252' }[d.kind];
    ctx.fillStyle = col;
    rrect(ctx, d.x - 13, d.y - 13, 26, 26, 8); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '700 15px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText({ spread: 'S', rapid: 'R', shield: 'O', heart: '♥' }[d.kind], d.x, d.y + 1);
  }

  for (const e of s.enemies) {
    ctx.save();
    ctx.translate(e.x, e.y);
    if (e.kind === 'rock') {
      ctx.rotate(e.t * e.spin);
      ctx.fillStyle = '#8d6e63';
      ctx.beginPath();
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, rr = e.r * (0.8 + ((i * 7 + e.seed * 10) % 4) * 0.08); i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr); }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#6d4c41';
      ctx.beginPath(); ctx.arc(e.r * 0.25, -e.r * 0.2, e.r * 0.25, 0, 7); ctx.fill();
    } else if (e.kind === 'turret') {
      ctx.fillStyle = '#455a64';
      ctx.beginPath();
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; i ? ctx.lineTo(Math.cos(a) * e.r, Math.sin(a) * e.r) : ctx.moveTo(Math.cos(a) * e.r, Math.sin(a) * e.r); }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = s.theme.accent;
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.fillRect(-20, -e.r - 10, 40, 4);
      ctx.fillStyle = '#69f0ae'; ctx.fillRect(-20, -e.r - 10, (40 * e.hp) / e.max, 4);
    } else {
      ctx.rotate(Math.PI);
      const col = e.kind === 'diver' ? '#ff5252' : e.kind === 'snake' ? '#ab47bc' : s.theme.accent;
      ctx.fillStyle = shade(col, -0.3);
      ctx.beginPath(); ctx.moveTo(-16, 6); ctx.lineTo(0, -4); ctx.lineTo(16, 6); ctx.lineTo(0, 12); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(8, 10); ctx.lineTo(-8, 10); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(0, 0, 3, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  const b = s.boss;
  if (b && (b.hp > 0 || s.endT > 1.8)) {
    ctx.save();
    ctx.translate(b.x, b.y);
    const flash = b.hp <= 0 ? Math.random() > 0.5 : false;
    ctx.fillStyle = flash ? '#fff' : '#37474f';
    ctx.beginPath(); ctx.moveTo(-90, -10); ctx.lineTo(-40, -40); ctx.lineTo(40, -40); ctx.lineTo(90, -10); ctx.lineTo(60, 30); ctx.lineTo(-60, 30); ctx.closePath(); ctx.fill();
    ctx.fillStyle = s.theme.accent;
    ctx.beginPath(); ctx.moveTo(-30, 30); ctx.lineTo(0, 54); ctx.lineTo(30, 30); ctx.fill();
    ctx.fillStyle = b.hp < b.max / 2 ? '#ff1744' : '#ffd740';
    ctx.beginPath(); ctx.arc(0, 0, 14 + Math.sin(s.time * 6) * 2, 0, 7); ctx.fill();
    ctx.fillStyle = '#263238';
    for (const dx of [-62, 62]) { rrect(ctx, dx - 9, -6, 18, 30, 4); ctx.fill(); }
    ctx.restore();
    if (b.hp > 0) {
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      rrect(ctx, 40, 14, FW - 80, 10, 5); ctx.fill();
      ctx.fillStyle = b.hp < b.max / 2 ? '#ff5252' : '#ffd740';
      rrect(ctx, 40, 14, ((FW - 80) * b.hp) / b.max, 10, 5); ctx.fill();
    }
  }

  ctx.fillStyle = '#ffeb3b';
  for (const bl of s.bullets) { rrect(ctx, bl.x - 2.5, bl.y - 9, 5, 16, 2.5); ctx.fill(); }
  for (const eb of s.ebullets) {
    ctx.fillStyle = 'rgba(255,82,82,.35)';
    ctx.beginPath(); ctx.arc(eb.x, eb.y, eb.r + 3, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffcdd2';
    ctx.beginPath(); ctx.arc(eb.x, eb.y, eb.r - 1, 0, 7); ctx.fill();
  }

  const p = s.p;
  if (!s.failed && !(p.inv > 0 && Math.floor(s.time * 14) % 2)) {
    drawShip(ctx, s.spec.player.kind, s.spec.player.color, p.x, p.y, p.tilt);
    if (p.shield) {
      ctx.strokeStyle = `rgba(179,136,255,${0.6 + 0.3 * Math.sin(s.time * 8)})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, 30, 0, 7); ctx.stroke();
    }
  }
  for (const f of s.fx) {
    ctx.globalAlpha = Math.min(1, f.t * 2);
    ctx.fillStyle = f.c;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.size, 0, 7); ctx.fill();
  }
  ctx.globalAlpha = 1;

  const text = ui.still ? '' : s.phase === 'intro' ? 'Get ready' : s.banner ? s.banner.text : '';
  if (text) {
    ctx.font = '700 34px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillText(text, FW / 2 + 2, FH * 0.42 + 3);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, FW / 2, FH * 0.42);
  }
  ctx.restore();
}

export function thumb(ctx, spec, w, h) {
  const s = create(spec);
  ctx.save();
  const sc = Math.max(w / FW, h / FH);
  ctx.translate(w / 2, h / 2);
  ctx.scale(sc, sc);
  ctx.translate(-FW / 2, -FH / 2);
  background(ctx, s, 0, FW);
  ctx.restore();
  ctx.save();
  ctx.translate(w / 2, h * 0.72);
  drawShip(ctx, spec.player.kind, spec.player.color, 0, 0, 0, 1.4);
  ctx.restore();
  ctx.fillStyle = THEMES[spec.theme].accent;
  for (const [x, y] of [[0.25, 0.25], [0.5, 0.18], [0.75, 0.25]]) {
    ctx.beginPath(); ctx.moveTo(w * x, h * y + 10); ctx.lineTo(w * x - 9, h * y - 6); ctx.lineTo(w * x + 9, h * y - 6); ctx.fill();
  }
}
