// Small helpers shared by the three game engines. No DOM access here, so the engines run in Node tests.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

export const LEVEL = { easy: 0, normal: 1, hard: 2 };
export const byLevel = (spec, values) => values[LEVEL[spec.difficulty] ?? 1];

/** Lighten (amt > 0) or darken (amt < 0) a #rrggbb colour. */
export function shade(hex, amt) {
  const n = parseInt(String(hex).slice(1), 16);
  const target = amt < 0 ? 0 : 255;
  const t = Math.min(1, Math.abs(amt));
  const ch = (v) => Math.round(v + (target - v) * t);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

export function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export function formatTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}
