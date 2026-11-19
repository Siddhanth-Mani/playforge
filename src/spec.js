// A game is a small JSON "spec". Everything (prompt parser, AI, editor, share links) produces a spec,
// and normalize() is the single gate that makes any spec safe and complete before the engine sees it.

export const GENRES = {
  racing: { label: 'Racing', noun: 'Rally' },
  platformer: { label: 'Platformer', noun: 'Run' },
  shooter: { label: 'Arcade shooter', noun: 'Raiders' },
};

export const THEMES = {
  'fiji-coast': { label: 'Fiji coast', ground: '#e9d7a6', ground2: '#dcc58c', grass: '#7cb342', water: '#29a3c7', road: '#4a4f57', sky: ['#7fd3f7', '#c9eefc'], prop: 'palm', accent: '#ff7043' },
  'suva-city': { label: 'Suva city', ground: '#9aa3ab', ground2: '#8b949c', grass: '#6d9b4a', water: '#2f7fa8', road: '#3a3f46', sky: ['#9ccff0', '#e3f2fb'], prop: 'building', accent: '#ffca28' },
  sugarcane: { label: 'Sugarcane fields', ground: '#9ccc65', ground2: '#8bbd55', grass: '#7cb342', water: '#3c9fc4', road: '#6d5d4b', sky: ['#a7dcf5', '#eaf7fd'], prop: 'cane', accent: '#f9a825' },
  rainforest: { label: 'Rainforest', ground: '#4e8f3a', ground2: '#447f32', grass: '#3d7a2c', water: '#2e8fa0', road: '#5b4a3a', sky: ['#8fd1c4', '#d9f3ee'], prop: 'tree', accent: '#ff8a65' },
  volcano: { label: 'Volcano', ground: '#4a3b39', ground2: '#3e3130', grass: '#5d4037', water: '#ff6d00', road: '#2b2626', sky: ['#5b2c2c', '#c0583a'], prop: 'rock', accent: '#ffab40' },
  'night-city': { label: 'City at night', ground: '#262b36', ground2: '#2d3340', grass: '#1f3d2b', water: '#123b5a', road: '#14171d', sky: ['#0b1026', '#28305a'], prop: 'neon', accent: '#40c4ff' },
  reef: { label: 'Coral reef', ground: '#1f7ea8', ground2: '#1b7299', grass: '#26a69a', water: '#0d5c86', road: '#e8d7a8', sky: ['#4fc3f7', '#b3e5fc'], prop: 'coral', accent: '#ff80ab' },
  space: { label: 'Outer space', ground: '#0e1022', ground2: '#141734', grass: '#1d2140', water: '#3949ab', road: '#2a2e52', sky: ['#05060f', '#1a1d3d'], prop: 'star', accent: '#b388ff' },
};

export const PLAYERS = {
  racing: { hatchback: 'Hatchback', rally: 'Rally car', pickup: 'Pickup truck', bus: 'Island bus', scooter: 'Scooter' },
  platformer: { explorer: 'Explorer', robot: 'Robot', surfer: 'Surfer' },
  shooter: { jet: 'Jet', boat: 'Speed boat', saucer: 'Saucer' },
};

export const LAYOUTS = {
  racing: { 'coastal-loop': 'Coastal loop', oval: 'Oval', 'figure-eight': 'Figure eight', 'mountain-pass': 'Mountain pass', 'city-grid': 'City blocks' },
  platformer: { hills: 'Rolling hills', islands: 'Island hops', caves: 'Caves' },
  shooter: { 'open-sky': 'Open sky', asteroids: 'Asteroid field', storm: 'Storm front' },
};

export const MISSIONS = {
  racing: {
    position: { label: 'Finish in position', unit: 'or better', min: 1, max: 6, def: 1 },
    time: { label: 'Finish within', unit: 'seconds', min: 20, max: 600, def: 120 },
    collect: { label: 'Collect', name: 'Collect coconuts', unit: 'coconuts', min: 1, max: 60, def: 10 },
    clean: { label: 'Hit things at most', unit: 'times', min: 0, max: 20, def: 3 },
  },
  platformer: {
    goal: { label: 'Reach the flag', unit: '', min: 1, max: 1, def: 1 },
    coins: { label: 'Collect', name: 'Collect shells', unit: 'shells', min: 1, max: 80, def: 20 },
    time: { label: 'Finish within', unit: 'seconds', min: 15, max: 600, def: 90 },
    unhurt: { label: 'Take damage at most', unit: 'times', min: 0, max: 5, def: 0 },
  },
  shooter: {
    score: { label: 'Score at least', unit: 'points', min: 100, max: 100000, def: 3000 },
    boss: { label: 'Defeat the boss', unit: '', min: 1, max: 1, def: 1 },
    accuracy: { label: 'Accuracy of at least', unit: '%', min: 5, max: 100, def: 40 },
    unhurt: { label: 'Lose at most', unit: 'lives', min: 0, max: 2, def: 1 },
  },
};

export const DIFFICULTIES = ['easy', 'normal', 'hard'];
const HEX = /^#[0-9a-f]{6}$/i;

const pick = (value, allowed, fallback) => (Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback);
const clampInt = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const text = (v, max, d = '') => {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || d;
};

export function defaultTheme(genre) {
  return { racing: 'fiji-coast', platformer: 'rainforest', shooter: 'space' }[genre];
}

/** Make any object a complete, safe spec. Never throws. */
export function normalize(input) {
  const s = input && typeof input === 'object' ? input : {};
  const genre = pick(s.genre, GENRES, 'racing');
  const theme = pick(s.theme, THEMES, defaultTheme(genre));
  const players = PLAYERS[genre];
  const layouts = LAYOUTS[genre];
  const player = s.player && typeof s.player === 'object' ? s.player : {};
  const map = s.map && typeof s.map === 'object' ? s.map : {};
  const missionDefs = MISSIONS[genre];

  const seen = new Set();
  const missions = (Array.isArray(s.missions) ? s.missions : [])
    .filter((m) => m && missionDefs[m.type] && !seen.has(m.type) && seen.add(m.type))
    .slice(0, 4)
    .map((m) => {
      const d = missionDefs[m.type];
      return { type: m.type, target: clampInt(m.target, d.min, d.max, d.def) };
    });
  if (!missions.length) {
    missions.push(genre === 'racing' ? { type: 'position', target: 1 } : genre === 'platformer' ? { type: 'goal', target: 1 } : { type: 'boss', target: 1 });
  }

  return {
    v: 1,
    title: text(s.title, 48, `${THEMES[theme].label} ${GENRES[genre].noun}`),
    genre,
    theme,
    player: {
      kind: pick(player.kind, players, Object.keys(players)[0]),
      color: HEX.test(player.color) ? player.color.toLowerCase() : '#e53935',
    },
    map: {
      layout: pick(map.layout, layouts, Object.keys(layouts)[0]),
      seed: clampInt(map.seed, 1, 999_999, 1953),
      length: clampInt(map.length, 1, 3, 2),
    },
    difficulty: DIFFICULTIES.includes(s.difficulty) ? s.difficulty : 'normal',
    laps: clampInt(s.laps, 1, 5, 3),
    rivals: clampInt(s.rivals, 0, 5, 3),
    missions,
    author: text(s.author, 32),
    remixOf: text(s.remixOf, 48),
  };
}

const WHERE = {
  'fiji-coast': 'on the Fiji coast', 'suva-city': 'through Suva', sugarcane: 'through the cane fields', rainforest: 'in the rainforest',
  volcano: 'on a volcano', 'night-city': 'through the city at night', reef: 'over a coral reef', space: 'in outer space',
};
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

/** One-line description, used on cards and share previews. */
export function describe(spec) {
  const s = normalize(spec);
  const who = PLAYERS[s.genre][s.player.kind].toLowerCase();
  const where = WHERE[s.theme];
  if (s.genre === 'racing') {
    const rivals = s.rivals ? `against ${s.rivals} rival${s.rivals === 1 ? '' : 's'}` : 'against the clock';
    return `${s.laps}-lap race ${where} in ${article(who)} ${who}, ${rivals}.`;
  }
  if (s.genre === 'platformer') return `Jump-and-run ${where} as the ${who}: ${LAYOUTS.platformer[s.map.layout].toLowerCase()}.`;
  return `Arcade shooter ${where} in ${article(who)} ${who}, ending in a boss fight.`;
}

export function missionText(genre, m) {
  const d = MISSIONS[genre][m.type];
  if (!d) return '';
  if (d.min === 1 && d.max === 1) return d.label;
  if (genre === 'racing' && m.type === 'position') return m.target === 1 ? 'Win the race' : `Finish ${ordinal(m.target)} or better`;
  return `${d.label} ${m.target}${d.unit === '%' ? '%' : ` ${d.unit}`}`.trim();
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ---------------------------------------------------------------- share codes */
// spec -> JSON -> deflate -> base64url. Falls back to plain base64url where CompressionStream is missing.

function toB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encode(spec) {
  const json = new TextEncoder().encode(JSON.stringify(normalize(spec)));
  if (typeof CompressionStream === 'function') return 'z' + toB64url(await pipe(json, new CompressionStream('deflate-raw')));
  return 'j' + toB64url(json);
}

export async function decode(code) {
  if (typeof code !== 'string' || code.length < 2 || code.length > 4000) throw new Error('That game link is incomplete');
  try {
    let bytes = fromB64url(code.slice(1));
    if (code[0] === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
    else if (code[0] !== 'j') throw new Error('bad prefix');
    return normalize(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new Error('That game link is damaged or incomplete');
  }
}

/* ---------------------------------------------------------------- seeded random */
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
