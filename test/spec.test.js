import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, encode, decode, describe, missionText, MISSIONS, PLAYERS, LAYOUTS, THEMES } from '../src/spec.js';
import { parsePrompt, EXAMPLES } from '../src/prompt.js';
import { FEATURED } from '../src/gallery.js';

test('normalize fills a complete spec from nothing and never throws', () => {
  for (const input of [undefined, null, 42, 'x', [], {}, { genre: 'chess' }]) {
    const s = normalize(input);
    assert.equal(s.genre, 'racing');
    assert.ok(THEMES[s.theme]);
    assert.ok(PLAYERS.racing[s.player.kind]);
    assert.ok(LAYOUTS.racing[s.map.layout]);
    assert.equal(s.missions.length, 1);
  }
});

test('normalize clamps numbers, rejects unknown values and strips control characters', () => {
  const s = normalize({
    genre: 'racing', theme: 'mars', title: 'A\u0000B\nC'.padEnd(200, 'x'), laps: 99, rivals: -4,
    player: { kind: 'tank', color: 'red; background:url(x)' }, map: { layout: 'moon', seed: 'abc', length: 9 },
    missions: [{ type: 'collect', target: 9999 }, { type: 'collect', target: 3 }, { type: 'boss' }, null, { type: 'time', target: 1 }],
  });
  assert.equal(s.theme, 'fiji-coast');
  assert.equal(s.laps, 5);
  assert.equal(s.rivals, 0);
  assert.equal(s.player.kind, 'hatchback');
  assert.equal(s.player.color, '#e53935');
  assert.equal(s.map.layout, 'coastal-loop');
  assert.equal(s.map.seed, 1953);
  assert.equal(s.map.length, 3);
  assert.equal(s.title.length, 48);
  assert.ok(!/[\u0000-\u001f]/.test(s.title));
  assert.deepEqual(s.missions, [{ type: 'collect', target: 60 }, { type: 'time', target: 20 }]);
});

test('missions from another genre are dropped and a default is added', () => {
  const s = normalize({ genre: 'shooter', missions: [{ type: 'laps' }, { type: 'coins', target: 5 }] });
  assert.deepEqual(s.missions, [{ type: 'boss', target: 1 }]);
});

test('share codes round-trip and reject damaged links', async () => {
  for (const spec of FEATURED) {
    const code = await encode(spec);
    assert.match(code, /^[zj][A-Za-z0-9_-]+$/);
    assert.ok(code.length < 600, `code too long: ${code.length}`);
    assert.deepEqual(await decode(code), spec);
  }
  await assert.rejects(() => decode('zAAAA'), /damaged|incomplete/);
  await assert.rejects(() => decode('q' + 'A'.repeat(20)), /damaged|incomplete/);
  await assert.rejects(() => decode('z' + 'A'.repeat(5000)), /incomplete/);
});

test('a hostile share link decodes to a safe spec', async () => {
  const json = JSON.stringify({ genre: 'platformer', title: '<img src=x onerror=alert(1)>', author: '"><script>', player: { color: 'javascript:alert(1)' }, __proto__: { polluted: true } });
  const code = 'j' + Buffer.from(json).toString('base64url');
  const s = await decode(code);
  assert.equal(s.genre, 'platformer');
  assert.equal(s.player.color, '#e53935');
  assert.equal(s.title, '<img src=x onerror=alert(1)>'); // kept as text; the UI only ever uses textContent
  assert.equal({}.polluted, undefined);
});

test('descriptions and mission text read naturally', () => {
  assert.equal(describe({ genre: 'racing', player: { kind: 'bus' }, rivals: 1, laps: 2 }), '2-lap race on the Fiji coast in an island bus, against 1 rival.');
  assert.equal(describe({ genre: 'racing', rivals: 0 }), '3-lap race on the Fiji coast in a hatchback, against the clock.');
  assert.equal(missionText('racing', { type: 'position', target: 1 }), 'Win the race');
  assert.equal(missionText('racing', { type: 'position', target: 3 }), 'Finish 3rd or better');
  assert.equal(missionText('shooter', { type: 'accuracy', target: 50 }), 'Accuracy of at least 50%');
  for (const [genre, defs] of Object.entries(MISSIONS)) for (const type of Object.keys(defs)) assert.ok(missionText(genre, { type, target: defs[type].def }));
});

test('the prompt parser understands the examples', () => {
  const a = parsePrompt('make a racing game in Fiji').spec;
  assert.equal(a.genre, 'racing');
  assert.equal(a.theme, 'fiji-coast');
  assert.ok(a.missions.some((m) => m.type === 'collect'));

  const b = parsePrompt('A night race through Suva in a red rally car, hard').spec;
  assert.equal(b.theme, 'night-city');
  assert.equal(b.player.kind, 'rally');
  assert.equal(b.player.color, '#e53935');
  assert.equal(b.difficulty, 'hard');

  const c = parsePrompt('Island bus dash through the sugarcane fields, 2 laps').spec;
  assert.equal(c.player.kind, 'bus');
  assert.equal(c.theme, 'sugarcane');
  assert.equal(c.laps, 2);

  const d = parsePrompt('Platformer in the rainforest, collect 30 shells under 2 minutes').spec;
  assert.equal(d.genre, 'platformer');
  assert.deepEqual(d.missions.find((m) => m.type === 'coins'), { type: 'coins', target: 30 });
  assert.deepEqual(d.missions.find((m) => m.type === 'time'), { type: 'time', target: 120 });

  const e = parsePrompt('Space shooter with a boss fight, score 5000 points').spec;
  assert.equal(e.genre, 'shooter');
  assert.equal(e.theme, 'space');
  assert.deepEqual(e.missions.find((m) => m.type === 'score'), { type: 'score', target: 5000 });

  const f = parsePrompt('Volcano figure-8 race with 5 rivals, no crashes').spec;
  assert.equal(f.map.layout, 'figure-eight');
  assert.equal(f.rivals, 5);
  assert.ok(f.missions.some((m) => m.type === 'clean'));

  for (const ex of EXAMPLES) assert.ok(parsePrompt(ex).spec.title.length > 2);
});

test('the parser is deterministic, handles junk and reads titles', () => {
  assert.deepEqual(parsePrompt('a race in Nadi'), parsePrompt('a race in Nadi'));
  assert.notEqual(parsePrompt('a race in Nadi').spec.map.seed, parsePrompt('a race in Lautoka').spec.map.seed);
  const junk = parsePrompt('');
  assert.equal(junk.spec.genre, 'racing');
  assert.equal(junk.notes.length, 1);
  assert.equal(parsePrompt('x'.repeat(5000)).spec.genre, 'racing');
  assert.equal(parsePrompt('a jumping game called Shell Seeker').spec.title, 'Shell Seeker');
  assert.equal(parsePrompt('a boat shooter on the reef').spec.player.kind, 'boat');
});
