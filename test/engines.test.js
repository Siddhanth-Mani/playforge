// The engines have no DOM code, so whole games can be simulated here frame by frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, LAYOUTS } from '../src/spec.js';
import * as racing from '../src/engine/racing.js';
import * as platformer from '../src/engine/platformer.js';
import * as shooter from '../src/engine/shooter.js';
import { evaluate, headline } from '../src/missions.js';
import { FEATURED } from '../src/gallery.js';

const DT = 1 / 60;
function run(engine, s, control, maxSeconds) {
  let steps = 0;
  const events = new Set();
  while (!s.over && steps < maxSeconds * 60) {
    engine.step(s, control(s), DT);
    for (const e of s.events) events.add(e);
    s.events.length = 0;
    steps++;
  }
  return events;
}

test('race tracks are closed loops with even spacing for every layout', () => {
  for (const layout of Object.keys(LAYOUTS.racing)) {
    for (const length of [1, 2, 3]) {
      const t = racing.buildTrack(normalize({ map: { layout, seed: 99, length } }));
      assert.ok(t.N > 300, `${layout} too short`);
      for (let i = 0; i < t.N; i++) {
        const a = t.pts[i], b = t.pts[(i + 1) % t.N];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        assert.ok(d > 4 && d < 16, `${layout} gap ${d.toFixed(1)} at ${i}`);
      }
    }
  }
});

test('the same seed builds the same track, a new seed a different one', () => {
  const a = racing.buildTrack(normalize({ map: { seed: 5 } }));
  const b = racing.buildTrack(normalize({ map: { seed: 5 } }));
  const c = racing.buildTrack(normalize({ map: { seed: 6 } }));
  assert.deepEqual(a.pts.slice(0, 20), b.pts.slice(0, 20));
  assert.notDeepEqual(a.pts.slice(0, 20), c.pts.slice(0, 20));
});

test('an autopiloted race finishes on every layout, and rivals finish too', () => {
  for (const layout of Object.keys(LAYOUTS.racing)) {
    const spec = normalize({ map: { layout, seed: 4242, length: 1 }, laps: 2, rivals: 3, difficulty: 'normal' });
    const s = racing.create(spec);
    s.autopilot = true;
    const events = run(racing, s, () => ({}), 300);
    const r = racing.result(s);
    assert.ok(r.finished, `${layout}: did not finish`);
    assert.ok(r.position >= 1 && r.position <= 4);
    assert.ok(r.time > 20 && r.time < 200, `${layout}: odd time ${r.time}`);
    assert.ok(events.has('go') && events.has('finish') && events.has('lap'));
    assert.ok(s.order.length >= 2, `${layout}: no rival finished`);
  }
});

test('nothing moves during the countdown and the player starts last', () => {
  const s = racing.create(normalize({ rivals: 3 }));
  const before = s.cars.map((c) => [c.x, c.y]);
  for (let i = 0; i < 120; i++) racing.step(s, { up: true }, DT);
  assert.deepEqual(s.cars.map((c) => [c.x, c.y]), before);
  assert.equal(racing.result(s).position, 4);
});

test('easy rivals are slower than hard ones', () => {
  const easy = racing.create(normalize({ difficulty: 'easy' }));
  const hard = racing.create(normalize({ difficulty: 'hard' }));
  const avg = (s) => s.cars.filter((c) => !c.isPlayer).reduce((a, c) => a + c.skill, 0) / (s.cars.length - 1);
  assert.ok(avg(easy) < avg(hard) - 0.1);
});

test('platformer levels only contain gaps and steps the jump can clear', () => {
  for (const layout of Object.keys(LAYOUTS.platformer)) {
    for (const difficulty of ['easy', 'normal', 'hard']) {
      for (const seed of [1, 77, 4242, 9001]) {
        const L = platformer.buildLevel(normalize({ genre: 'platformer', map: { layout, seed, length: 3 }, difficulty }));
        let gap = 0;
        for (let c = 1; c < L.cols; c++) {
          if (L.h[c] === 0) { gap++; continue; }
          const prev = L.h[c - 1 - gap];
          if (gap) assert.ok(gap <= 3 || gap === 9, `${layout} gap ${gap} at ${c}`);
          if (gap > 0 && gap <= 3 && L.h[c] > prev) assert.ok(gap <= 2, 'uphill gap too wide');
          if (!gap) assert.ok(L.h[c] - prev <= 2, `${layout} step of ${L.h[c] - prev} at ${c}`);
          gap = 0;
        }
        assert.ok(L.h[L.cols - 6] > 0, 'flag must stand on ground');
        assert.ok(L.coins.length >= 20);
      }
    }
  }
});

test('a simple bot can finish every generated platformer level', () => {
  for (const layout of Object.keys(LAYOUTS.platformer)) {
    for (const difficulty of ['easy', 'normal', 'hard']) {
      for (const seed of [1, 77, 4242, 9001, 123456]) {
        const s = platformer.create(normalize({ genre: 'platformer', map: { layout, seed, length: 1 }, difficulty }));
        run(platformer, s, platformer.autopilot, 240);
        assert.ok(platformer.result(s).reached, `${layout}/${difficulty}/${seed} not finished at x=${Math.round(s.p.x)}`);
      }
    }
  }
});

test('platformer: falling in a pit costs a heart and respawns, running out ends the run', () => {
  const s = platformer.create(normalize({ genre: 'platformer', difficulty: 'hard' }));
  s.intro = 0;
  s.p.y = 10_000;
  platformer.step(s, {}, DT);
  assert.equal(s.hearts, 2);
  assert.ok(s.p.y < 600);
  s.p.inv = 0; s.p.y = 10_000; platformer.step(s, {}, DT);
  s.p.inv = 0; s.p.y = 10_000; platformer.step(s, {}, DT);
  assert.ok(s.failed);
  run(platformer, s, () => ({}), 5);
  assert.ok(s.over);
  assert.equal(headline(s.spec, platformer.result(s)), 'Out of hearts');
});

test('the coin mission always has enough shells in the level', () => {
  const s = platformer.create(normalize({ genre: 'platformer', map: { length: 1 }, missions: [{ type: 'coins', target: 80 }] }));
  assert.ok(s.L.coins.length >= 86);
});

test('shooter: waves then a boss, beatable on every layout', () => {
  for (const layout of Object.keys(LAYOUTS.shooter)) {
    const s = shooter.create(normalize({ genre: 'shooter', map: { layout, seed: 7, length: 1 }, difficulty: 'hard' }));
    s.god = true;
    const events = run(shooter, s, shooter.autopilot, 400);
    const r = shooter.result(s);
    assert.ok(r.bossDefeated, `${layout}: boss not defeated`);
    assert.ok(events.has('warning') && events.has('bossdown'));
    assert.ok(r.accuracy > 0 && r.accuracy <= 100);
    assert.ok(r.score >= 5000);
  }
});

test('shooter: a player who never moves eventually loses', () => {
  const s = shooter.create(normalize({ genre: 'shooter', difficulty: 'hard' }));
  run(shooter, s, () => ({}), 400);
  const r = shooter.result(s);
  assert.ok(r.failed);
  assert.ok(r.livesLost >= 3);
});

test('touch coordinates map back onto the shooter field', () => {
  assert.deepEqual(shooter.toField(960, 720, 480, 360), { x: 240, y: 360 });
  assert.deepEqual(shooter.toField(480, 1440, 240, 720), { x: 240, y: 360 });
});

test('missions are scored live and at the end', () => {
  const spec = normalize({ missions: [{ type: 'position', target: 1 }, { type: 'collect', target: 5 }, { type: 'clean', target: 2 }, { type: 'time', target: 60 }] });
  const live = evaluate(spec, { finished: false, position: 2, time: 30, collected: 5, hits: 3 });
  assert.deepEqual(live.map((m) => [m.done, m.failed]), [[false, false], [true, false], [false, true], [false, false]]);
  const end = evaluate(spec, { finished: true, position: 1, time: 75, collected: 5, hits: 1 }, true);
  assert.deepEqual(end.map((m) => m.done), [true, true, true, false]);
  assert.equal(headline(spec, { finished: true, position: 1 }), 'You finished 1st');
});

test('every featured game can be created and stepped without errors', () => {
  const engines = { racing, platformer, shooter };
  for (const spec of FEATURED) {
    const e = engines[spec.genre];
    const s = e.create(spec);
    for (let i = 0; i < 600; i++) e.step(s, { up: true, right: true, action: true }, DT);
    assert.equal(e.hud(s).length, 3);
    assert.ok(evaluate(spec, e.result(s)).length === spec.missions.length);
  }
});
