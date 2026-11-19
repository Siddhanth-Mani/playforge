// Hand-made games shown on the home screen.
import { normalize } from './spec.js';

export const FEATURED = [
  { title: 'Coral Coast Rally', genre: 'racing', theme: 'fiji-coast', player: { kind: 'rally', color: '#e53935' }, map: { layout: 'coastal-loop', seed: 1970, length: 2 }, laps: 3, rivals: 3, missions: [{ type: 'position', target: 1 }, { type: 'collect', target: 12 }], author: 'PlayForge' },
  { title: 'Suva After Dark', genre: 'racing', theme: 'night-city', player: { kind: 'hatchback', color: '#40c4ff' }, map: { layout: 'city-grid', seed: 679, length: 2 }, laps: 2, rivals: 4, difficulty: 'hard', missions: [{ type: 'position', target: 2 }, { type: 'clean', target: 3 }], author: 'PlayForge' },
  { title: 'Cane Field Bus Dash', genre: 'racing', theme: 'sugarcane', player: { kind: 'bus', color: '#fdd835' }, map: { layout: 'mountain-pass', seed: 1882, length: 1 }, laps: 2, rivals: 3, difficulty: 'easy', missions: [{ type: 'position', target: 1 }, { type: 'time', target: 150 }], author: 'PlayForge' },
  { title: 'Taveuni Shell Run', genre: 'platformer', theme: 'rainforest', player: { kind: 'explorer', color: '#fb8c00' }, map: { layout: 'caves', seed: 180, length: 2 }, missions: [{ type: 'goal', target: 1 }, { type: 'coins', target: 30 }, { type: 'unhurt', target: 1 }], author: 'PlayForge' },
  { title: 'Reef Hopper', genre: 'platformer', theme: 'reef', player: { kind: 'surfer', color: '#ec407a' }, map: { layout: 'islands', seed: 4242, length: 1 }, difficulty: 'easy', missions: [{ type: 'goal', target: 1 }, { type: 'coins', target: 25 }], author: 'PlayForge' },
  { title: 'Storm over Kadavu', genre: 'shooter', theme: 'fiji-coast', player: { kind: 'jet', color: '#1e88e5' }, map: { layout: 'storm', seed: 77, length: 2 }, missions: [{ type: 'boss', target: 1 }, { type: 'score', target: 12000 }], author: 'PlayForge' },
  { title: 'Asteroid Drift', genre: 'shooter', theme: 'space', player: { kind: 'saucer', color: '#b388ff' }, map: { layout: 'asteroids', seed: 2049, length: 1 }, missions: [{ type: 'boss', target: 1 }, { type: 'accuracy', target: 45 }], author: 'PlayForge' },
  { title: 'Volcano Eight', genre: 'racing', theme: 'volcano', player: { kind: 'pickup', color: '#ffb300' }, map: { layout: 'figure-eight', seed: 333, length: 2 }, laps: 3, rivals: 5, missions: [{ type: 'position', target: 3 }, { type: 'collect', target: 15 }], author: 'PlayForge' },
].map(normalize);
