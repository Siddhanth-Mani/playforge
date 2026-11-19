// Turns a plain-English request into a spec without any AI service, so the app works offline
// and with no API key. It reads genre, place, vehicle, colour, difficulty, numbers and goals.
import { normalize, THEMES } from './spec.js';

const has = (t, words) => words.some((w) => new RegExp(`\\b${w}`, 'i').test(t));

const GENRE_WORDS = {
  racing: ['rac', 'race', 'drive', 'driving', 'car', 'rally', 'kart', 'lap', 'speed', 'drift', 'bus', 'truck', 'motor', 'scooter'],
  platformer: ['platform', 'jump', 'runner', 'run and', 'adventure', 'explor', 'climb', 'parkour', 'side.?scroll'],
  shooter: ['shoot', 'shooter', 'space', 'alien', 'invader', 'blast', 'laser', 'spaceship', 'ship', 'boss', 'bullet', 'plane', 'jet', 'fighter'],
};

const PLACES = [
  // [words, theme, racing layout, platformer layout, shooter layout, name for titles]
  [['suva', 'city', 'town', 'street', 'downtown', 'urban'], 'suva-city', 'city-grid', 'hills', 'open-sky', 'Suva'],
  [['night', 'neon', 'midnight', 'dark'], 'night-city', 'city-grid', 'caves', 'storm', 'Midnight'],
  [['sugar ?cane', 'cane', 'farm', 'field', 'countryside', 'lautoka', 'ba\\b', 'rakiraki'], 'sugarcane', 'mountain-pass', 'hills', 'open-sky', 'Sugarcane'],
  [['rain ?forest', 'jungle', 'forest', 'waterfall', 'taveuni', 'highlands'], 'rainforest', 'mountain-pass', 'caves', 'storm', 'Rainforest'],
  [['volcano', 'lava', 'fire', 'magma'], 'volcano', 'figure-eight', 'caves', 'storm', 'Volcano'],
  [['reef', 'coral', 'ocean', 'sea', 'underwater', 'lagoon', 'island'], 'reef', 'coastal-loop', 'islands', 'open-sky', 'Reef'],
  [['space', 'galaxy', 'planet', 'star', 'moon', 'alien', 'asteroid'], 'space', 'oval', 'islands', 'asteroids', 'Galaxy'],
  [['fiji', 'beach', 'coast', 'nadi', 'denarau', 'coral coast', 'sigatoka', 'pacific', 'tropical', 'palm'], 'fiji-coast', 'coastal-loop', 'islands', 'open-sky', 'Fiji'],
];

const VEHICLES = [
  [['bus'], 'racing', 'bus'], [['truck', 'pickup', 'ute', '4x4'], 'racing', 'pickup'], [['rally', 'drift', 'off.?road'], 'racing', 'rally'],
  [['scooter', 'moped', 'motor ?bike', 'bike'], 'racing', 'scooter'], [['hatch', 'small car'], 'racing', 'hatchback'],
  [['robot', 'bot\\b', 'android'], 'platformer', 'robot'], [['surf'], 'platformer', 'surfer'], [['explorer', 'kid', 'hero'], 'platformer', 'explorer'],
  [['boat', 'drua', 'canoe', 'ship at sea'], 'shooter', 'boat'], [['ufo', 'saucer'], 'shooter', 'saucer'], [['jet', 'plane', 'fighter'], 'shooter', 'jet'],
];

const COLORS = {
  red: '#e53935', blue: '#1e88e5', green: '#43a047', yellow: '#fdd835', orange: '#fb8c00', purple: '#8e24aa',
  pink: '#ec407a', black: '#263238', white: '#eceff1', gold: '#ffb300', silver: '#b0bec5', teal: '#00897b',
};

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30, fifty: 50 };
const num = (s) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s.toLowerCase()]);
const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|fifty)';

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 999_999 + 1;
}

export function parsePrompt(input) {
  const t = String(input || '').toLowerCase().slice(0, 500);
  const notes = [];

  // genre: strongest match wins; ties go racing > platformer > shooter
  const scores = Object.fromEntries(Object.entries(GENRE_WORDS).map(([g, words]) => [g, words.filter((w) => has(t, [w])).length]));
  let genre = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  genre = genre[1] > 0 ? genre[0] : 'racing';
  if (/\b(space ?ship|spaceship)\b/.test(t) && !scores.racing) genre = 'shooter';
  if (!Object.values(scores).some(Boolean)) notes.push('No game type mentioned, so this is a racing game.');

  // place / theme (first match in PLACES order, so "suva at night" picks night only if "night" is said)
  let place = PLACES.find(([words]) => has(t, words));
  if (place && place[1] === 'suva-city' && has(t, ['night', 'neon'])) place = PLACES[1];
  if (!place) place = genre === 'shooter' ? PLACES[6] : PLACES[7];
  const [, theme, raceLayout, platLayout, shootLayout, placeName] = place;
  let layout = { racing: raceLayout, platformer: platLayout, shooter: shootLayout }[genre];
  if (genre === 'racing') {
    if (has(t, ['figure.?(8|eight)'])) layout = 'figure-eight';
    else if (has(t, ['oval', 'speedway', 'stadium'])) layout = 'oval';
    else if (has(t, ['mountain', 'hill', 'pass', 'winding'])) layout = 'mountain-pass';
    else if (has(t, ['block', 'grid', 'streets'])) layout = 'city-grid';
  }

  const vehicle = VEHICLES.find(([words, g]) => g === genre && has(t, words));
  const colorWord = Object.keys(COLORS).find((c) => new RegExp(`\\b${c}\\b`).test(t));
  const difficulty = has(t, ['easy', 'kids?', 'relax', 'chill', 'beginner', 'simple']) ? 'easy'
    : has(t, ['hard', 'difficult', 'insane', 'extreme', 'challeng', 'expert', 'brutal']) ? 'hard' : 'normal';
  const length = has(t, ['short', 'quick', 'mini']) ? 1 : has(t, ['long', 'epic', 'marathon', 'big']) ? 3 : 2;

  const spec = {
    genre, theme, difficulty,
    player: { kind: vehicle ? vehicle[2] : undefined, color: colorWord ? COLORS[colorWord] : undefined },
    map: { layout, seed: hashSeed(t || 'playforge'), length },
    missions: [],
  };

  const lapM = t.match(new RegExp(`${NUM}\\s*laps?`));
  if (lapM) spec.laps = num(lapM[1]);
  const rivalM = t.match(new RegExp(`${NUM}\\s*(?:rivals?|opponents?|cars?|racers?|enemies|ai)`));
  if (rivalM && genre === 'racing') spec.rivals = num(rivalM[1]);
  if (has(t, ['alone', 'solo', 'time trial', 'no rivals'])) spec.rivals = 0;

  const collectM = t.match(new RegExp(`(?:collect|grab|get|find)\\s*${NUM}\\s*(\\w+)?`));
  const secondsM = t.match(new RegExp(`(?:under|within|in less than|before)\\s*${NUM}\\s*(seconds?|secs?|minutes?|mins?)`));
  const seconds = secondsM ? num(secondsM[1]) * (/^min/.test(secondsM[2]) ? 60 : 1) : null;

  if (genre === 'racing') {
    spec.missions.push({ type: 'position', target: has(t, ['podium', 'top 3', 'top three']) ? 3 : 1 });
    if (collectM || has(t, ['coconut'])) spec.missions.push({ type: 'collect', target: collectM ? num(collectM[1]) : 10 });
    if (seconds) spec.missions.push({ type: 'time', target: seconds });
    if (has(t, ['clean', 'no crash', 'without crash', 'careful'])) spec.missions.push({ type: 'clean', target: 0 });
    if (spec.missions.length === 1) spec.missions.push({ type: 'collect', target: 8 });
  } else if (genre === 'platformer') {
    spec.missions.push({ type: 'goal', target: 1 });
    spec.missions.push({ type: 'coins', target: collectM ? num(collectM[1]) : 15 });
    if (seconds) spec.missions.push({ type: 'time', target: seconds });
    if (has(t, ['no damage', 'without getting hit', 'perfect', 'flawless'])) spec.missions.push({ type: 'unhurt', target: 0 });
  } else {
    spec.missions.push({ type: 'boss', target: 1 });
    const scoreM = t.match(/(?:score|points?)\D{0,12}(\d{3,6})|(\d{3,6})\s*points/);
    if (scoreM) spec.missions.push({ type: 'score', target: Number(scoreM[1] || scoreM[2]) });
    if (has(t, ['accura', 'sniper', 'precise'])) spec.missions.push({ type: 'accuracy', target: 60 });
    if (has(t, ['no damage', 'perfect', 'flawless'])) spec.missions.push({ type: 'unhurt', target: 0 });
  }

  const nouns = { racing: has(t, ['bus']) ? 'Bus Dash' : has(t, ['drift']) ? 'Drift' : 'Rally', platformer: 'Run', shooter: has(t, ['boat']) ? 'Sea Patrol' : 'Raiders' };
  spec.title = `${placeName === 'Fiji' && theme === 'fiji-coast' && genre === 'racing' ? 'Coral Coast' : placeName} ${nouns[genre]}`;

  const quoted = String(input || '').match(/(?:called|named|title[d]?)\s+["“']?([^"”'.,!]{3,40})/i);
  if (quoted) spec.title = quoted[1].trim();

  return { spec: normalize(spec), notes, themeLabel: THEMES[theme].label };
}

export const EXAMPLES = [
  'Make a racing game in Fiji with 3 laps and collect 10 coconuts',
  'A night race through Suva in a red rally car, hard',
  'Island bus dash through the sugarcane fields, 2 laps',
  'Platformer in the rainforest, collect 30 shells under 2 minutes',
  'Space shooter with a boss fight, score 5000 points',
  'Volcano figure-8 race with 5 rivals, no crashes',
];
