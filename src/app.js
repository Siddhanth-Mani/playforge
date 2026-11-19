// PlayForge interface: home (make a game from a sentence), play, edit/remix, share, saved games.
// Every piece of text goes in through textContent, never innerHTML, because titles and author names
// arrive from share links that anyone can craft.
import { normalize, describe, encode, decode, GENRES, THEMES, PLAYERS, LAYOUTS, MISSIONS, DIFFICULTIES, missionText } from './spec.js';
import { parsePrompt, EXAMPLES } from './prompt.js';
import { designWithAI, getSettings, saveSettings, clearSettings, DEFAULT_MODEL } from './ai.js';
import { FEATURED } from './gallery.js';
import { evaluate, headline } from './missions.js';
import * as audio from './audio.js';
import * as racing from './engine/racing.js';
import * as platformer from './engine/platformer.js';
import * as shooter from './engine/shooter.js';
import { formatTime } from './engine/core.js';

const ENGINES = { racing, platformer, shooter };
const REPO = 'https://github.com/Siddhanth-Mani/playforge';
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

/* ------------------------------------------------------------------ DOM helper */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.5.1-1-.1-1 2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.5 11l-.1 1 .1 1-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7 7 0 0 0 1.7-1l2.5 1 2-3.5Z',
  share: 'M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7',
  close: 'M6 6l12 12M18 6 6 18',
  pause: 'M8 5v14M16 5v14',
  back: 'M15 5l-7 7 7 7',
  sound: 'M4 9v6h4l5 4V5L8 9H4Zm12.5-.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mute: 'M4 9v6h4l5 4V5L8 9H4Zm12 1 5 5m0-5-5 5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  dice: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm3.5 4h.01M15.5 8h.01M12 12h.01M8.5 16h.01M15.5 16h.01',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm6 12 .8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M7 7l10 10M17 7 7 17',
  plus: 'M12 5v14M5 12h14',
};

function icon(name, label) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  if (!label) return svg;
  return [svg, h('span', { class: 'sr-only' }, label)];
}

let toastTimer = 0;
function toast(msg, ms = 2600) {
  $toast.textContent = msg;
  $toast.hidden = false;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.classList.remove('show'); setTimeout(() => { $toast.hidden = true; }, 250); }, ms);
}

/* ------------------------------------------------------------------ storage */

const GAMES_KEY = 'playforge:games';
const BEST_KEY = 'playforge:best';
const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

function loadGames() {
  const raw = read(GAMES_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter((g) => g && typeof g.code === 'string' && g.code.length < 4000).map((g) => ({ code: g.code, spec: normalize(g.spec), saved: Number(g.saved) || 0 }));
}
function upsertGame(code, spec) {
  const list = loadGames().filter((g) => g.code !== code);
  list.unshift({ code, spec: normalize(spec), saved: Date.now() });
  if (!write(GAMES_KEY, list.slice(0, 60))) toast('Could not save: browser storage is full or blocked');
}
function removeGame(code) {
  write(GAMES_KEY, loadGames().filter((g) => g.code !== code));
}
function getBest(code) {
  const all = read(BEST_KEY, {});
  const b = all && typeof all === 'object' ? all[code] : null;
  return b && typeof b.done === 'number' ? b : null;
}
function setBest(code, done, of) {
  const all = read(BEST_KEY, {});
  const map = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  const prev = map[code];
  if (prev && prev.done >= done) return false;
  map[code] = { done, of };
  const keys = Object.keys(map);
  if (keys.length > 200) delete map[keys[0]];
  write(BEST_KEY, map);
  return true;
}

const shareUrl = (code) => `${location.origin}${location.pathname}#/play/${code}`;

async function share(spec, code) {
  const url = shareUrl(code);
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: spec.title, text: `Play “${spec.title}”, made with PlayForge`, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied. Anyone with it can play and remix this game.');
  } catch {
    openSheet('Share this game', [
      h('p', { class: 'muted' }, 'Copy this link and send it to someone:'),
      h('input', { class: 'field', readonly: true, value: url, onfocus: (e) => e.target.select(), 'aria-label': 'Game link' }),
    ], [h('button', { class: 'btn', onclick: closeSheet }, 'Done')]);
  }
}

/* ------------------------------------------------------------------ sheets */

let sheetEl = null;
let sheetReturn = null;
function openSheet(title, body, actions, { dismissable = true, onDismiss } = {}) {
  closeSheet();
  sheetReturn = document.activeElement;
  const titleId = `sheet-${Date.now()}`;
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'grabber', 'aria-hidden': 'true' }),
    h('h2', { id: titleId, class: 'sheet-title' }, title),
    h('div', { class: 'sheet-body' }, body),
    actions && actions.length ? h('div', { class: 'sheet-actions' }, actions) : null);
  const back = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === back && dismissable) { closeSheet(); if (onDismiss) onDismiss(); } } }, sheet);
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); closeSheet(); if (onDismiss) onDismiss(); }
    if (e.key === 'Tab') {
      const f = [...sheet.querySelectorAll('button, input, select, textarea, a[href]')].filter((x) => !x.disabled);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });
  document.body.append(back);
  sheetEl = back;
  requestAnimationFrame(() => {
    back.classList.add('open');
    const first = sheet.querySelector('.sheet-actions .btn.primary') || sheet.querySelector('button, input, a[href]');
    if (first) first.focus({ preventScroll: true });
  });
}
function closeSheet() {
  if (!sheetEl) return;
  sheetEl.remove();
  sheetEl = null;
  if (sheetReturn && document.contains(sheetReturn)) sheetReturn.focus({ preventScroll: true });
  sheetReturn = null;
}

/* ------------------------------------------------------------------ thumbnails */

function thumbCanvas(spec, w, hgt, cls = 'thumb') {
  const c = h('canvas', { class: cls, width: w * 2, height: hgt * 2, 'aria-hidden': 'true' });
  const ctx = c.getContext('2d');
  ctx.scale(2, 2);
  try { ENGINES[spec.genre].thumb(ctx, spec, w, hgt); } catch { ctx.fillStyle = '#ccc'; ctx.fillRect(0, 0, w, hgt); }
  return c;
}

/* ------------------------------------------------------------------ home */

function settingsSheet() {
  const s = getSettings();
  const key = h('input', { class: 'field', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste a Gemini API key', value: s.key, 'aria-label': 'Gemini API key' });
  const model = h('input', { class: 'field', type: 'text', spellcheck: 'false', value: s.model, placeholder: DEFAULT_MODEL, 'aria-label': 'Model name' });
  openSheet('Game designer', [
    h('p', null, 'PlayForge has a built-in designer that reads your sentence on this device. It understands places, vehicles, colours, laps, rivals, difficulty and goals, and works offline.'),
    h('p', null, 'If you add your own Google Gemini API key, Gemini designs the game instead and the built-in designer becomes the fallback. Free keys come from ',
      h('a', { href: 'https://aistudio.google.com/apikey', target: '_blank', rel: 'noopener' }, 'Google AI Studio'), '.'),
    h('label', { class: 'label' }, 'API key', key),
    h('label', { class: 'label' }, 'Model', model),
    h('p', { class: 'muted small' }, 'The key is stored only in this browser and is sent only to Google. Game links never contain it.'),
  ], [
    s.key ? h('button', { class: 'btn plain danger', onclick: () => { clearSettings(); closeSheet(); toast('Key removed. Using the built-in designer.'); showHome(); } }, 'Remove key') : null,
    h('button', { class: 'btn primary', onclick: () => {
      const k = key.value.trim();
      if (k && !/^[A-Za-z0-9_\-]{20,80}$/.test(k)) { toast('That does not look like a Gemini API key'); key.focus(); return; }
      saveSettings({ key: k, model: model.value });
      closeSheet();
      toast(k ? 'Saved. Gemini will design your next game.' : 'Using the built-in designer.');
      showHome();
    } }, 'Save'),
  ]);
}

function gameCard(spec, onPlay) {
  return h('button', { class: 'game-card', onclick: onPlay, 'aria-label': `Play ${spec.title}` },
    thumbCanvas(spec, 320, 200),
    h('span', { class: 'game-card-text' },
      h('span', { class: 'pill' }, GENRES[spec.genre].label),
      h('span', { class: 'game-card-title' }, spec.title),
      h('span', { class: 'game-card-sub' }, describe(spec))));
}

async function playSpec(spec) {
  const code = await encode(spec);
  location.hash = `#/play/${code}`;
}

function gameActions(g) {
  openSheet(g.spec.title, [h('p', { class: 'muted' }, describe(g.spec))], [
    h('button', { class: 'btn primary', onclick: () => { closeSheet(); location.hash = `#/play/${g.code}`; } }, 'Play'),
    h('button', { class: 'btn', onclick: () => { closeSheet(); location.hash = `#/edit/${g.code}`; } }, 'Edit'),
    h('button', { class: 'btn', onclick: () => { closeSheet(); share(g.spec, g.code); } }, 'Share link'),
    h('button', { class: 'btn plain danger', onclick: () => {
      removeGame(g.code);
      closeSheet();
      showHome();
      toast(`Removed “${g.spec.title}”`);
    } }, 'Remove from my games'),
  ]);
}

let pendingNote = '';

function showHome() {
  document.title = 'PlayForge: describe a game, then play it';
  const ai = getSettings();
  const input = h('textarea', { id: 'prompt', class: 'prompt', rows: 3, maxlength: 500, placeholder: 'A racing game in Fiji with 3 laps and coconuts to collect', 'aria-label': 'Describe your game', enterkeyhint: 'go' });
  try { input.value = sessionStorage.getItem('playforge:draft') || ''; } catch { /* storage blocked */ }
  const makeBtn = h('button', { class: 'btn primary make', type: 'button' }, 'Make game');

  async function make() {
    const text = input.value.trim();
    if (!text) { toast('Describe the game you want first'); input.focus(); return; }
    makeBtn.disabled = true;
    makeBtn.textContent = ai.key ? 'Designing with Gemini…' : 'Designing…';
    audio.unlock();
    let spec = null, note = '';
    try {
      if (ai.key) {
        try { spec = await designWithAI(text, ai); } catch (e) { note = `${e.message}. The built-in designer made it instead.`; }
      }
      if (!spec) {
        const res = parsePrompt(text);
        spec = res.spec;
        if (!note && res.notes.length) note = res.notes[0];
      }
      const code = await encode(spec);
      upsertGame(code, spec);
      try { sessionStorage.removeItem('playforge:draft'); } catch { /* storage blocked */ }
      pendingNote = note;
      location.hash = `#/play/${code}`;
    } catch (e) {
      toast(`Something went wrong: ${e.message}`);
    } finally {
      makeBtn.disabled = false;
      makeBtn.textContent = 'Make game';
    }
  }
  makeBtn.addEventListener('click', make);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); make(); } });
  input.addEventListener('input', () => { try { sessionStorage.setItem('playforge:draft', input.value); } catch { /* storage blocked */ } });

  const games = loadGames();
  const mine = games.length
    ? h('div', { class: 'list' }, games.map((g) => {
      const best = getBest(g.code);
      return h('div', { class: 'row' },
        h('button', { class: 'row-main', onclick: () => { location.hash = `#/play/${g.code}`; }, 'aria-label': `Play ${g.spec.title}` },
          thumbCanvas(g.spec, 72, 48, 'row-thumb'),
          h('span', { class: 'row-text' },
            h('span', { class: 'row-title' }, g.spec.title),
            h('span', { class: 'row-sub' }, best ? `${GENRES[g.spec.genre].label} · best ${best.done} of ${best.of} missions` : `${GENRES[g.spec.genre].label} · not played yet`))),
        h('button', { class: 'icon-btn', onclick: () => gameActions(g) }, icon('more', `More options for ${g.spec.title}`)));
    }))
    : h('div', { class: 'empty' },
      h('p', { class: 'empty-title' }, 'No games yet'),
      h('p', { class: 'muted' }, 'Games you make appear here, so you can play them again, edit them or share them.'),
      h('a', { class: 'btn', href: '#/new' }, 'Build one step by step'));

  $app.replaceChildren(h('div', { class: 'page home' },
    h('header', { class: 'top' },
      h('div', null,
        h('p', { class: 'eyebrow' }, 'PlayForge'),
        h('h1', { class: 'large-title' }, 'Make a game')),
      h('button', { class: 'icon-btn tinted', onclick: settingsSheet }, icon('gear', 'Game designer settings'))),
    h('section', { class: 'composer' },
      input,
      h('div', { class: 'composer-bar' },
        h('span', { class: 'mode' }, icon('sparkle'), ai.key ? 'Gemini designer' : 'Built-in designer'),
        makeBtn)),
    h('div', { class: 'chips', role: 'list', 'aria-label': 'Example ideas' },
      EXAMPLES.map((ex) => h('button', { class: 'chip', role: 'listitem', onclick: () => { input.value = ex; input.focus(); } }, ex))),
    h('section', null,
      h('div', { class: 'section-head' }, h('h2', null, 'Your games'), games.length ? h('a', { class: 'link', href: '#/new' }, 'New from scratch') : null),
      mine),
    h('section', null,
      h('div', { class: 'section-head' }, h('h2', null, 'Featured')),
      h('div', { class: 'grid' }, FEATURED.map((spec) => gameCard(spec, () => playSpec(spec))))),
    h('footer', { class: 'foot' },
      h('p', null, 'Three engines (racing, platformer, arcade shooter), eight places and a designer that turns a sentence into a game. Games live in their links: nothing is uploaded.'),
      h('p', null, 'Made by ', h('a', { href: 'https://siddhanth.ryzn.pro/', target: '_blank', rel: 'noopener' }, 'Siddhanth Mani'), ' · ', h('a', { href: REPO, target: '_blank', rel: 'noopener' }, 'Source on GitHub')))));
}

/* ------------------------------------------------------------------ play */

let game = null;
const isTouch = () => document.documentElement.classList.contains('is-touch');
window.addEventListener('touchstart', () => document.documentElement.classList.add('is-touch'), { passive: true, once: true });
if (matchMedia('(pointer: coarse)').matches) document.documentElement.classList.add('is-touch');

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down', Space: 'action', KeyJ: 'action', KeyK: 'action',
};

function onKey(e) {
  if (!game || sheetEl) return;
  const k = KEYMAP[e.code];
  if (k) {
    game.input[k] = e.type === 'keydown';
    e.preventDefault();
  } else if (e.type === 'keydown' && (e.code === 'Escape' || e.code === 'KeyP')) {
    e.preventDefault();
    pauseGame();
  }
}
window.addEventListener('keydown', onKey);
window.addEventListener('keyup', onKey);
window.addEventListener('blur', () => { if (game) { for (const k of Object.keys(game.input)) game.input[k] = k === 'pointer' ? null : false; } });
document.addEventListener('visibilitychange', () => { if (document.hidden && game && game.running) pauseGame(); });

function holdButton(label, key, cls) {
  const b = h('button', { class: `pad ${cls || ''}`, 'aria-label': label, type: 'button' }, h('span', { 'aria-hidden': 'true' }, cls === 'pad-wide' ? label : ''));
  const on = (e) => { e.preventDefault(); if (game) game.input[key] = true; b.classList.add('down'); };
  const off = () => { if (game) game.input[key] = false; b.classList.remove('down'); };
  b.addEventListener('pointerdown', on);
  b.addEventListener('pointerup', off);
  b.addEventListener('pointercancel', off);
  b.addEventListener('pointerleave', off);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
  return b;
}

function controlsHint(genre) {
  if (isTouch()) {
    return { racing: 'Steer with the arrows on the left. Hold the green pedal to drive, the grey one to brake.', platformer: 'Move with the arrows, tap Jump. Hold it for a higher jump.', shooter: 'Drag anywhere to fly. Your ship fires while your finger is down.' }[genre];
  }
  return { racing: '↑ or W to drive, ↓ or S to brake, ← → to steer. Esc pauses.', platformer: '← → to run, Space or ↑ to jump (hold for higher). Esc pauses.', shooter: 'Arrow keys or WASD to fly, hold Space to fire. Esc pauses.' }[genre];
}

function missionList(spec, results) {
  return h('ul', { class: 'missions' }, (results || spec.missions.map((m) => ({ text: missionText(spec.genre, m) }))).map((m) =>
    h('li', { class: m.done ? 'done' : m.failed ? 'failed' : '' },
      m.done || m.failed ? h('span', { class: 'mark' }, icon(m.done ? 'check' : 'cross')) : h('span', { class: 'mark dot' }),
      h('span', null, m.text),
      m.progress ? h('span', { class: 'progress' }, m.progress) : null)));
}

function showPlay(spec, code) {
  document.title = `${spec.title} · PlayForge`;
  const engine = ENGINES[spec.genre];
  const canvas = h('canvas', { class: 'stage', 'aria-label': `${spec.title}, game view` });
  const pills = [h('span', { class: 'pill-hud' }), h('span', { class: 'pill-hud' }), h('span', { class: 'pill-hud' })];
  const strip = h('div', { class: 'mission-strip', 'aria-hidden': 'true' });
  const muteBtn = h('button', { class: 'hud-btn', onclick: () => { audio.setMuted(!audio.isMuted()); muteBtn.replaceChildren(...[icon(audio.isMuted() ? 'mute' : 'sound', audio.isMuted() ? 'Sound off' : 'Sound on')].flat()); } }, icon(audio.isMuted() ? 'mute' : 'sound', audio.isMuted() ? 'Sound off' : 'Sound on'));
  const hud = h('div', { class: 'hud' },
    h('button', { class: 'hud-btn', onclick: () => { location.hash = '#/'; } }, icon('close', 'Leave game')),
    h('div', { class: 'hud-pills' }, pills),
    muteBtn,
    h('button', { class: 'hud-btn', onclick: () => pauseGame() }, icon('pause', 'Pause')));

  let touch = null;
  if (spec.genre === 'racing') {
    touch = h('div', { class: 'touch' },
      h('div', { class: 'pad-group' }, holdButton('Steer left', 'left', 'pad-left'), holdButton('Steer right', 'right', 'pad-right')),
      h('div', { class: 'pad-group' }, holdButton('Brake', 'down', 'pad-brake'), holdButton('Drive', 'up', 'pad-gas')));
  } else if (spec.genre === 'platformer') {
    touch = h('div', { class: 'touch' },
      h('div', { class: 'pad-group' }, holdButton('Move left', 'left', 'pad-left'), holdButton('Move right', 'right', 'pad-right')),
      h('div', { class: 'pad-group' }, holdButton('Jump', 'action', 'pad-wide')));
  }

  const wrap = h('div', { class: 'play' }, canvas, hud, strip, touch);
  $app.replaceChildren(wrap);
  const ctx = canvas.getContext('2d');

  game = {
    spec, code, engine, canvas, ctx, state: null, running: false, raf: 0, last: 0, acc: 0, hudT: 0,
    input: { left: false, right: false, up: false, down: false, action: false, pointer: null },
    pills, strip, wrap, touch, hud,
  };

  if (spec.genre === 'shooter') {
    const toField = (e) => { const r = canvas.getBoundingClientRect(); return shooter.toField(r.width, r.height, e.clientX - r.left, e.clientY - r.top); };
    canvas.addEventListener('pointerdown', (e) => { if (!game) return; canvas.setPointerCapture(e.pointerId); game.input.pointer = toField(e); });
    canvas.addEventListener('pointermove', (e) => { if (game && game.input.pointer) game.input.pointer = toField(e); });
    const up = () => { if (game) game.input.pointer = null; };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  }

  const resize = () => {
    if (!game || game.canvas !== canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    game.dpr = dpr;
    game.w = r.width;
    game.h = r.height;
    if (game.state) render();
  };
  game.resize = resize;
  window.addEventListener('resize', resize);
  resize();

  // draw a still frame behind the intro sheet
  game.state = engine.create(spec);
  game.state.events.length = 0;
  render();
  updateHud(true);

  const meta = [spec.author ? `Made by ${spec.author}` : null, spec.remixOf ? `Remix of “${spec.remixOf}”` : null].filter(Boolean).join(' · ');
  const best = getBest(code);
  const mine = loadGames().some((g) => g.code === code);
  openSheet(spec.title, [
    thumbCanvas(spec, 340, 150, 'sheet-thumb'),
    h('p', null, describe(spec)),
    meta ? h('p', { class: 'muted small' }, meta) : null,
    h('h3', { class: 'sub-head' }, 'Missions'),
    missionList(spec),
    best ? h('p', { class: 'muted small' }, `Your best: ${best.done} of ${best.of} missions`) : null,
    h('p', { class: 'hint' }, controlsHint(spec.genre)),
    pendingNote ? h('p', { class: 'note' }, pendingNote) : null,
  ], [
    h('button', { class: 'btn primary', onclick: () => { closeSheet(); audio.unlock(); start(); } }, 'Play'),
    h('div', { class: 'btn-row' },
      mine
        ? h('button', { class: 'btn', onclick: () => { closeSheet(); location.hash = `#/edit/${code}`; } }, 'Edit')
        : h('button', { class: 'btn', onclick: () => { closeSheet(); location.hash = `#/remix/${code}`; } }, 'Remix'),
      h('button', { class: 'btn', onclick: () => share(spec, code) }, icon('share'), 'Share')),
  ], { dismissable: false });
  pendingNote = '';
}

function render() {
  const g = game;
  g.ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
  const hudBottom = g.hud.getBoundingClientRect().bottom - g.canvas.getBoundingClientRect().top;
  const touchH = g.touch && isTouch() ? g.touch.getBoundingClientRect().height + 16 : 0;
  g.engine.draw(g.ctx, g.state, g.w, g.h, { top: hudBottom + 36, bottom: touchH, still: !g.running && !g.started });
}

function updateHud(force) {
  const g = game;
  const vals = g.engine.hud(g.state);
  vals.forEach((v, i) => { if (g.pills[i].textContent !== v) g.pills[i].textContent = v; });
  g.hudT = 0;
  const res = evaluate(g.spec, g.engine.result(g.state));
  const sig = res.map((m) => `${m.text}|${m.progress}|${m.done}|${m.failed}`).join(';');
  if (force || sig !== g.stripSig) {
    g.stripSig = sig;
    g.strip.replaceChildren(...res.map((m) => h('span', { class: `strip-item${m.done ? ' done' : ''}${m.failed ? ' failed' : ''}` }, m.done ? '✓ ' : m.failed ? '✕ ' : '', m.progress || m.text)));
  }
}

function start() {
  const g = game;
  g.state = g.engine.create(g.spec);
  g.running = true;
  g.started = true;
  g.last = performance.now();
  g.acc = 0;
  for (const k of Object.keys(g.input)) g.input[k] = k === 'pointer' ? null : false;
  cancelAnimationFrame(g.raf);
  g.raf = requestAnimationFrame(frame);
  g.canvas.focus?.();
}

const DT = 1 / 60;
function frame(now) {
  const g = game;
  if (!g || !g.running) return;
  g.acc += Math.min(0.1, (now - g.last) / 1000);
  g.last = now;
  let steps = 0;
  while (g.acc >= DT && steps < 6) {
    g.engine.step(g.state, g.input, DT);
    for (const ev of g.state.events) audio.play(ev);
    g.state.events.length = 0;
    g.acc -= DT;
    steps++;
  }
  render();
  g.hudT += 1;
  if (g.hudT >= 6) updateHud(false);
  if (g.state.over) { g.running = false; updateHud(true); showResults(); return; }
  g.raf = requestAnimationFrame(frame);
}

function pauseGame() {
  const g = game;
  if (!g || !g.running) return;
  g.running = false;
  cancelAnimationFrame(g.raf);
  openSheet('Paused', [missionList(g.spec, evaluate(g.spec, g.engine.result(g.state)))], [
    h('button', { class: 'btn primary', onclick: resume }, 'Resume'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { closeSheet(); start(); } }, 'Restart'),
      h('button', { class: 'btn', onclick: () => { closeSheet(); location.hash = '#/'; } }, 'Quit')),
  ], { onDismiss: resume });
}

function resume() {
  closeSheet();
  const g = game;
  if (!g || g.running || !g.state || g.state.over) return;
  g.running = true;
  g.last = performance.now();
  g.raf = requestAnimationFrame(frame);
}

function stats(spec, r) {
  if (spec.genre === 'racing') return [['Position', r.finished ? `${r.position} of ${r.cars}` : '–'], ['Time', formatTime(r.time)], ['Coconuts', r.collected], ['Hits', r.hits]];
  if (spec.genre === 'platformer') return [['Time', formatTime(r.time)], ['Shells', r.coins], ['Hits taken', r.hits]];
  return [['Score', r.score.toLocaleString('en')], ['Accuracy', `${r.accuracy}%`], ['Lives lost', r.livesLost], ['Time', formatTime(r.time)]];
}

function showResults() {
  const g = game;
  const r = g.engine.result(g.state);
  const res = evaluate(g.spec, r, true);
  const done = res.filter((m) => m.done).length;
  const newBest = setBest(g.code, done, res.length);
  if (done === res.length) audio.play('finish');
  openSheet(headline(g.spec, r), [
    h('p', { class: 'score-line' }, `${done} of ${res.length} mission${res.length === 1 ? '' : 's'} complete${newBest && done ? ' · new best' : ''}`),
    h('dl', { class: 'stats' }, stats(g.spec, r).map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, String(v))))),
    missionList(g.spec, res),
  ], [
    h('button', { class: 'btn primary', onclick: () => { closeSheet(); start(); } }, 'Play again'),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', onclick: () => { closeSheet(); location.hash = `#/remix/${g.code}`; } }, 'Remix'),
      h('button', { class: 'btn', onclick: () => share(g.spec, g.code) }, icon('share'), 'Share')),
    h('button', { class: 'btn plain', onclick: () => { closeSheet(); location.hash = '#/'; } }, 'Home'),
  ], { dismissable: false });
}

function stopGame() {
  if (!game) return;
  game.running = false;
  cancelAnimationFrame(game.raf);
  window.removeEventListener('resize', game.resize);
  game = null;
}

/* ------------------------------------------------------------------ editor */

const SWATCHES = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00897b', '#1e88e5', '#8e24aa', '#ec407a', '#263238', '#eceff1'];
const LENGTHS = { 1: 'Short', 2: 'Medium', 3: 'Long' };

function segmented(label, options, value, onPick) {
  return h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label },
    Object.entries(options).map(([v, text]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(String(v) === String(value)), class: String(v) === String(value) ? 'on' : '',
      onclick: () => onPick(v),
    }, text)));
}

function chipPicker(label, options, value, onPick, swatch) {
  return h('div', { class: 'pick', role: 'radiogroup', 'aria-label': label },
    Object.entries(options).map(([v, text]) => {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: `pick-chip${v === value ? ' on' : ''}`, onclick: () => onPick(v) },
        swatch ? h('span', { class: 'swatch', 'aria-hidden': 'true' }) : null, text);
      if (swatch) b.firstChild.style.background = swatch(v);
      return b;
    }));
}

function stepper(label, value, min, max, step, onChange, fmt = String) {
  const out = h('output', { 'aria-live': 'polite' }, fmt(value));
  return h('div', { class: 'stepper', role: 'group', 'aria-label': label },
    h('button', { type: 'button', 'aria-label': `Decrease ${label}`, disabled: value <= min, onclick: () => onChange(Math.max(min, value - step)) }, '−'),
    out,
    h('button', { type: 'button', 'aria-label': `Increase ${label}`, disabled: value >= max, onclick: () => onChange(Math.min(max, value + step)) }, '+'));
}

function missionStep(d) {
  if (d.max >= 1000) return 500;
  if (d.max >= 300) return 10;
  if (d.unit === '%') return 5;
  return 1;
}

function showEditor(spec, remix) {
  let draft = normalize(spec);
  if (remix && spec.author !== undefined) {
    draft = normalize({ ...draft, remixOf: spec.title, author: '', title: `${spec.title} remix`.slice(0, 48) });
  }
  const original = remix ? spec.title : '';
  document.title = `${remix ? 'Remix' : 'Edit'}: ${draft.title} · PlayForge`;

  const set = (patch) => {
    const y = window.scrollY;
    draft = normalize({ ...draft, ...patch });
    renderEditor();
    window.scrollTo(0, y);
  };

  function renderEditor() {
    const defs = MISSIONS[draft.genre];
    const preview = thumbCanvas(draft, 360, 170, 'editor-thumb');
    const title = h('input', { class: 'field', value: draft.title, maxlength: 48, 'aria-label': 'Game name', oninput: (e) => { draft.title = e.target.value; }, onchange: (e) => set({ title: e.target.value }) });
    const author = h('input', { class: 'field', value: draft.author, maxlength: 32, placeholder: 'Your name (optional)', 'aria-label': 'Made by', oninput: (e) => { draft.author = e.target.value; } });
    const colorInput = h('input', { type: 'color', class: 'color-input', value: draft.player.color, 'aria-label': 'Custom colour', onchange: (e) => set({ player: { ...draft.player, color: e.target.value } }) });

    const missionRows = Object.entries(defs).map(([type, d]) => {
      const m = draft.missions.find((x) => x.type === type);
      const on = !!m;
      const toggle = h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: on, 'aria-label': d.name || d.label, onchange: (e) => {
        if (e.target.checked) set({ missions: [...draft.missions, { type, target: d.def }] });
        else if (draft.missions.length === 1) { e.target.checked = true; toast('A game needs at least one mission'); }
        else set({ missions: draft.missions.filter((x) => x.type !== type) });
      } });
      const single = d.min === d.max;
      return h('div', { class: 'cell' },
        h('label', { class: 'cell-label' }, toggle, h('span', null, single || d.name ? d.name || d.label : `${d.label}${d.unit ? ` (${d.unit})` : ''}`)),
        on && !single ? stepper(d.label, m.target, d.min, d.max, missionStep(d), (v) => set({ missions: draft.missions.map((x) => (x.type === type ? { ...x, target: v } : x)) }), (v) => (draft.genre === 'racing' && type === 'position' ? `${v}${['th', 'st', 'nd', 'rd'][v] || 'th'}` : d.max >= 1000 ? v.toLocaleString('en') : String(v))) : null);
    });

    const go = async (fn) => {
      const clean = normalize({ ...draft, title: title.value, author: author.value });
      const code = await encode(clean);
      upsertGame(code, clean);
      fn(code, clean);
    };

    $app.replaceChildren(h('div', { class: 'page editor' },
      h('nav', { class: 'navbar' },
        h('button', { class: 'nav-btn', onclick: () => history.length > 1 ? history.back() : (location.hash = '#/') }, icon('back'), 'Back'),
        h('span', { class: 'nav-title' }, remix ? 'Remix' : 'Edit game'),
        h('button', { class: 'nav-btn strong', onclick: () => go((code) => { location.hash = `#/play/${code}`; }) }, 'Play')),
      original ? h('p', { class: 'muted small center' }, `Your copy of “${original}”. Change anything, then share your version.`) : null,
      h('div', { class: 'preview' }, preview, h('p', { class: 'preview-cap' }, describe(draft))),

      h('h2', { class: 'group-head' }, 'Name'),
      h('div', { class: 'group' }, h('div', { class: 'cell' }, title), h('div', { class: 'cell' }, author)),

      h('h2', { class: 'group-head' }, 'Game type'),
      h('div', { class: 'group padded' }, segmented('Game type', { racing: 'Racing', platformer: 'Platformer', shooter: 'Shooter' }, draft.genre,
        (g) => { if (g !== draft.genre) set({ genre: g, player: { color: draft.player.color }, map: { seed: draft.map.seed, length: draft.map.length }, missions: [] }); })),

      h('h2', { class: 'group-head' }, 'Place'),
      h('div', { class: 'group padded' }, chipPicker('Place', Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, v.label])), draft.theme, (t) => set({ theme: t }), (t) => THEMES[t].accent)),

      h('h2', { class: 'group-head' }, draft.genre === 'racing' ? 'Vehicle' : draft.genre === 'platformer' ? 'Hero' : 'Craft'),
      h('div', { class: 'group padded' },
        chipPicker('Player', PLAYERS[draft.genre], draft.player.kind, (k) => set({ player: { ...draft.player, kind: k } })),
        h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' },
          SWATCHES.map((c) => {
            const b = h('button', { type: 'button', role: 'radio', class: `sw${c === draft.player.color ? ' on' : ''}`, 'aria-checked': String(c === draft.player.color), 'aria-label': `Colour ${c}`, onclick: () => set({ player: { ...draft.player, color: c } }) });
            b.style.background = c;
            return b;
          }),
          colorInput)),

      h('h2', { class: 'group-head' }, 'Map'),
      h('div', { class: 'group padded' },
        chipPicker('Layout', LAYOUTS[draft.genre], draft.map.layout, (l) => set({ map: { ...draft.map, layout: l } })),
        h('div', { class: 'row-split' },
          segmented('Length', LENGTHS, draft.map.length, (v) => set({ map: { ...draft.map, length: Number(v) } })),
          h('button', { class: 'btn small', type: 'button', onclick: () => set({ map: { ...draft.map, seed: 1 + Math.floor(Math.random() * 999998) } }) }, icon('dice'), 'New map'))),

      draft.genre === 'racing' ? [
        h('h2', { class: 'group-head' }, 'Race'),
        h('div', { class: 'group' },
          h('div', { class: 'cell' }, h('span', null, 'Laps'), stepper('Laps', draft.laps, 1, 5, 1, (v) => set({ laps: v }))),
          h('div', { class: 'cell' }, h('span', null, 'Rivals'), stepper('Rivals', draft.rivals, 0, 5, 1, (v) => set({ rivals: v })))),
      ] : null,

      h('h2', { class: 'group-head' }, 'Difficulty'),
      h('div', { class: 'group padded' }, segmented('Difficulty', Object.fromEntries(DIFFICULTIES.map((d) => [d, d[0].toUpperCase() + d.slice(1)])), draft.difficulty, (d) => set({ difficulty: d }))),

      h('h2', { class: 'group-head' }, 'Missions'),
      h('div', { class: 'group' }, missionRows),
      h('p', { class: 'group-foot' }, 'Players see these before they start and get a tick for each one they complete.'),

      h('div', { class: 'editor-actions' },
        h('button', { class: 'btn primary', onclick: () => go((code) => { location.hash = `#/play/${code}`; }) }, 'Play this game'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => go((code, s) => share(s, code)) }, icon('share'), 'Share link'),
          h('button', { class: 'btn', onclick: () => go(() => toast('Saved to your games')) }, 'Save')))));
  }
  renderEditor();
}

/* ------------------------------------------------------------------ router */

async function route() {
  stopGame();
  closeSheet();
  const parts = (location.hash.slice(1) || '/').split('/');
  const view = parts[1] || '';
  const code = parts.slice(2).join('/');
  try {
    if (view === 'play' && code) { showPlay(await decode(code), code); return; }
    if ((view === 'edit' || view === 'remix') && code) { const spec = await decode(code); showEditor(spec, view === 'remix'); window.scrollTo(0, 0); return; }
    if (view === 'new') { showEditor(normalize({ title: 'My game' }), false); window.scrollTo(0, 0); return; }
    showHome();
  } catch (e) {
    showHome();
    toast(e.message || 'That link did not work');
  }
}

window.addEventListener('hashchange', route);
route();
