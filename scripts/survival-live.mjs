// Live survival trial: arm the safety tier, sample client state, journal the evidence.
//
// This is the harness behind evals/survival.md. It proves nothing on its own -- it records what
// the client actually did so a scene can be judged from evidence instead of from memory.
//
//   node scripts/survival-live.mjs [seconds]
//
// F8 remains the operator takeover at all times.
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig} from '../agent/src/setup.js';
import {Bridge} from '../agent/src/bridge.js';

const seconds = Number(process.argv[2] ?? 20);
const {config, token} = loadConfig([]);
const bridge = new Bridge({url: config.bridgeUrl, token});
const initial = await bridge.state();
if (!initial.online) throw Error('No world loaded');
console.log(`build=${initial.bridgeBuild} survivalVersion=${initial.survivalVersion} health=${initial.health}`);

const rows = [];
try {
  await bridge.reflex(initial, true);
  for (let i = 0; i < seconds * 4; i++) {
    await delay(250);
    const state = await bridge.state();
    rows.push(state);
    if (state.epoch !== initial.epoch || state.dead) break;
  }
} finally { await bridge.stop(); }

const path = `runtime/survival-live-${Date.now()}.jsonl`;
writeFileSync(path, rows.map(state => JSON.stringify({kind: 'state', state})).join('\n') + '\n');

const events = new Map();
for (const state of rows) for (const event of state.survivalEvents ?? []) events.set(`${event.clientTick}:${event.event}`, event);
const micros = rows.map(s => s.survival?.assessmentMicros).filter(Number.isFinite).sort((a, b) => a - b);
const survival = rows.map(s => s.survival).filter(s => s?.assessed);
// Turn rate between samples: the recorded zig-zag was a heading that flipped by 90 every tick.
const turns = survival.slice(1).map((s, i) => Math.abs(((s.yaw - survival[i].yaw + 540) % 360) - 180));
const travelled = survival.length > 1
  ? Math.hypot(survival.at(-1).x - survival[0].x, survival.at(-1).z - survival[0].z) : 0;
const nearest = survival.map(s => s.threats?.[0]?.entity?.distance).filter(Number.isFinite);
console.log(JSON.stringify({
  path, samples: rows.length,
  health: [initial.health, rows.at(-1)?.health],
  modes: [...new Set(survival.map(s => s.mode))],
  weapon: [...new Set(survival.map(s => `${s.weapon}/${s.fightEnabled}`))],
  sprintedSamples: survival.filter(s => s.sprinting).length,
  displacement: Number(travelled.toFixed(1)),
  nearestThreat: nearest.length ? {first: nearest[0], min: Math.min(...nearest), last: nearest.at(-1)} : null,
  turnPerSample: turns.length ? {median: turns.sort((a, b) => a - b)[turns.length >> 1], max: turns.at(-1)} : null,
  assessmentMicros: {p95: micros[Math.floor(micros.length * 0.95)], max: micros.at(-1)},
  events: [...events.values()].map(e => ({
    event: e.event, mode: e.mode, why: e.why,
    threats: (e.threats ?? []).map(t => ({type: t.entity.type, id: t.entity.id, reason: t.reason,
      distance: Number(t.entity.distance?.toFixed?.(1)), visible: t.entity.visible, accessible: t.entity.accessible})),
  })),
}, null, 2));
