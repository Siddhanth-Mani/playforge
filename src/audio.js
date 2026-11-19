// Tiny synthesised sound effects with WebAudio, so there are no audio files to download.
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('playforge:muted') === '1'; } catch { /* storage blocked */ }

export const isMuted = () => muted;
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem('playforge:muted', muted ? '1' : '0'); } catch { /* storage blocked */ }
}

/** Must be called from a user gesture before sounds can play on iOS. */
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
}

function tone(freq, dur, type = 'square', vol = 0.08, slide = 0, delay = 0) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur, vol = 0.12) {
  if (!ctx || muted) return;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  g.gain.value = vol;
  src.buffer = buf;
  src.connect(g).connect(ctx.destination);
  src.start();
}

const SOUNDS = {
  beep: () => tone(520, 0.15, 'sine', 0.12),
  go: () => tone(880, 0.35, 'sine', 0.14),
  coin: () => { tone(988, 0.08, 'square', 0.05); tone(1319, 0.12, 'square', 0.05, 0, 0.07); },
  boost: () => tone(300, 0.4, 'sawtooth', 0.06, 500),
  hit: () => noise(0.18, 0.15),
  bump: () => tone(140, 0.12, 'triangle', 0.12),
  lap: () => { tone(660, 0.1, 'sine', 0.1); tone(880, 0.16, 'sine', 0.1, 0, 0.1); },
  finish: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'sine', 0.1, 0, i * 0.12)),
  jump: () => tone(380, 0.14, 'square', 0.05, 380),
  stomp: () => tone(220, 0.12, 'square', 0.07, -120),
  hurt: () => { tone(200, 0.25, 'sawtooth', 0.07, -140); noise(0.12, 0.06); },
  respawn: () => tone(440, 0.2, 'sine', 0.06, 220),
  checkpoint: () => { tone(784, 0.1, 'sine', 0.08); tone(1047, 0.15, 'sine', 0.08, 0, 0.1); },
  lose: () => [392, 330, 262].forEach((f, i) => tone(f, 0.25, 'triangle', 0.09, 0, i * 0.18)),
  shoot: () => tone(900, 0.06, 'square', 0.025, -500),
  tick: () => tone(1200, 0.03, 'square', 0.02),
  boom: () => noise(0.25, 0.1),
  power: () => [660, 880, 1100].forEach((f, i) => tone(f, 0.08, 'sine', 0.07, 0, i * 0.05)),
  shield: () => tone(600, 0.3, 'sine', 0.08, -300),
  warning: () => [0, 0.3, 0.6].forEach((d) => tone(440, 0.2, 'sawtooth', 0.05, 0, d)),
  bossfire: () => tone(160, 0.15, 'sawtooth', 0.03, -60),
  bossdown: () => { noise(0.9, 0.18); [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'sine', 0.1, 0, 0.3 + i * 0.12)); },
  thunder: () => noise(0.6, 0.2),
  dive: () => tone(700, 0.3, 'sawtooth', 0.02, -500),
};

export function play(name) {
  const fn = SOUNDS[name];
  if (!fn) return;
  try { fn(); } catch { /* audio not available */ }
}
