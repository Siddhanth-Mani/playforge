// Optional: let Google Gemini design the game, using the player's own API key.
// The key stays in this browser (localStorage) and is sent only to Google's API, in a header.
// Whatever comes back goes through normalize(), so a bad or hostile reply can't break the game.
import { normalize, GENRES, THEMES, PLAYERS, LAYOUTS, MISSIONS, DIFFICULTIES } from './spec.js';

const KEY = 'playforge:gemini';
export const DEFAULT_MODEL = 'gemini-2.5-flash';

export function getSettings() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { key: typeof v.key === 'string' ? v.key : '', model: typeof v.model === 'string' && v.model ? v.model : DEFAULT_MODEL };
  } catch {
    return { key: '', model: DEFAULT_MODEL };
  }
}
export function saveSettings({ key, model }) {
  try { localStorage.setItem(KEY, JSON.stringify({ key: String(key || '').trim(), model: String(model || '').trim() || DEFAULT_MODEL })); } catch { /* storage blocked */ }
}
export function clearSettings() {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

export function buildPrompt(request) {
  const missions = Object.fromEntries(Object.entries(MISSIONS).map(([g, m]) => [g, Object.fromEntries(Object.entries(m).map(([k, d]) => [k, `${d.label} (${d.min}-${d.max} ${d.unit})`.trim()]))]));
  const opts = { genre: Object.keys(GENRES), theme: Object.keys(THEMES), difficulty: DIFFICULTIES, playerKinds: PLAYERS, layouts: LAYOUTS, missions };
  return [
    'You design small browser games for PlayForge. Turn the request into one JSON object and nothing else.',
    'Shape: {"title": string up to 40 chars, "genre", "theme", "difficulty", "player": {"kind", "color": "#rrggbb"},',
    '"map": {"layout", "seed": 1-999999, "length": 1-3}, "laps": 1-5, "rivals": 0-5, "missions": [{"type", "target"}] (1 to 4)}.',
    'player.kind, map.layout and mission types must come from the lists for the chosen genre. laps and rivals only matter for racing.',
    'Pick a fun, specific title. Prefer Fijian places and flavour when the request mentions Fiji or names no place.',
    `Allowed values: ${JSON.stringify(opts)}`,
    `Request: ${JSON.stringify(String(request).slice(0, 500))}`,
  ].join('\n');
}

/** Ask Gemini for a spec. Throws an Error with a readable message on any failure. */
export async function designWithAI(request, settings = getSettings(), fetchImpl = globalThis.fetch) {
  const { key, model } = settings;
  if (!key) throw new Error('No API key saved');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || DEFAULT_MODEL)}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(request) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.9 },
      }),
    });
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'Gemini took too long to answer' : 'Could not reach Gemini');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 403) throw new Error('Gemini rejected the API key or model name');
    if (res.status === 429) throw new Error('Gemini rate limit reached, try again in a minute');
    throw new Error(`Gemini returned an error (${res.status})`);
  }
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('Gemini did not return a game design'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Gemini did not return a game design');
  return normalize(parsed);
}
