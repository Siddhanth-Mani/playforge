// Checks a game's missions against the engine's result. Used live in the HUD and on the results sheet.
import { missionText, ordinal } from './spec.js';

/** @returns {{type:string,text:string,done:boolean,failed:boolean,progress:string}[]} */
export function evaluate(spec, r, final = false) {
  return spec.missions.map((m) => {
    const t = m.target;
    let done = false, failed = false, progress = '';
    if (spec.genre === 'racing') {
      if (m.type === 'position') { done = r.finished && r.position <= t; progress = ordinal(r.position); }
      if (m.type === 'time') { done = r.finished && r.time <= t; failed = r.time > t; progress = `${Math.floor(r.time)}s / ${t}s`; }
      if (m.type === 'collect') { done = r.collected >= t; progress = `${Math.min(r.collected, t)}/${t}`; }
      if (m.type === 'clean') { failed = r.hits > t; done = r.finished && !failed; progress = `${r.hits} hit${r.hits === 1 ? '' : 's'}`; }
    } else if (spec.genre === 'platformer') {
      if (m.type === 'goal') { done = r.reached; failed = r.failed; progress = r.reached ? 'Done' : ''; }
      if (m.type === 'coins') { done = r.coins >= t; progress = `${Math.min(r.coins, t)}/${t}`; }
      if (m.type === 'time') { done = r.reached && r.time <= t; failed = r.time > t; progress = `${Math.floor(r.time)}s / ${t}s`; }
      if (m.type === 'unhurt') { failed = r.hits > t; done = r.reached && !failed; progress = `${r.hits} hit${r.hits === 1 ? '' : 's'}`; }
    } else {
      if (m.type === 'score') { done = r.score >= t; progress = `${r.score.toLocaleString('en')}/${t.toLocaleString('en')}`; }
      if (m.type === 'boss') { done = r.bossDefeated; failed = r.failed; progress = r.bossDefeated ? 'Done' : ''; }
      if (m.type === 'accuracy') { done = r.bossDefeated && r.shots >= 20 && r.accuracy >= t; progress = `${r.accuracy}%`; }
      if (m.type === 'unhurt') { failed = r.livesLost > t; done = r.bossDefeated && !failed; progress = `${r.livesLost} lost`; }
    }
    if (final && !done) failed = true;
    return { type: m.type, text: missionText(spec.genre, m), done, failed: failed && !done, progress };
  });
}

/** Headline for the results sheet. */
export function headline(spec, r) {
  if (spec.genre === 'racing') return r.finished ? `You finished ${ordinal(r.position)}` : 'Race abandoned';
  if (spec.genre === 'platformer') return r.reached ? 'Course clear' : r.failed ? 'Out of hearts' : 'Run abandoned';
  return r.bossDefeated ? 'Boss defeated' : r.failed ? 'Shot down' : 'Mission abandoned';
}
