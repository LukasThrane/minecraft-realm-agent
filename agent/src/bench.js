import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Bridge } from './bridge.js';
import { Supervisor } from './supervisor.js';
import { journal } from './journal.js';
import { loadConfig, flag, root, openSession } from './setup.js';

const GOLDEN = 2.399963229728653; // radians; spreads successive routes over different terrain

/** Next destination relative to wherever the previous trial ended. Deterministic, not random. */
export function nextTarget(origin, index, distance) {
  const angle = index * GOLDEN;
  return { x: Math.round(origin.x + distance * Math.cos(angle)), z: Math.round(origin.z + distance * Math.sin(angle)) };
}
const span = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/**
 * A trial the client took away from us measured nothing about navigation. Alt-tabbing pauses a
 * singleplayer world and opens the menu, which the bridge correctly reads as human takeover.
 * Scoring that as a navigation failure would be a lie in the safe direction, which is still a lie.
 */
export function classify(phase, reason = '') {
  return /menu opened or paused|World unavailable/i.test(reason) ? 'interrupted' : phase;
}
/** Prefer the integrated server's position when there is one; say which was used. */
export function oracle(state) {
  return state.serverPositionAvailable
    ? { x: state.serverX, z: state.serverZ, source: 'integrated-server' }
    : { x: state.x, z: state.z, source: 'client-predicted' };
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
export function summarize(rows) {
  const routes = rows.filter(r => r.kind === 'route' && r.phase !== 'interrupted');
  const interrupted = rows.filter(r => r.phase === 'interrupted').length;
  const cancels = rows.filter(r => r.kind === 'cancel');
  const elapsed = routes.filter(r => r.phase === 'succeeded').map(r => r.elapsedMs).sort((a, b) => a - b);
  const latency = cancels.filter(r => r.stopLatencyMs != null).map(r => r.stopLatencyMs).sort((a, b) => a - b);
  const count = phase => routes.filter(r => r.phase === phase).length;
  return {
    positionSource: rows.every(r => r.positionSource === 'integrated-server') ? 'integrated-server'
      : rows.some(r => r.positionSource === 'integrated-server') ? 'mixed' : 'client-predicted',
    maxServerDrift: rows.reduce((max, r) => Math.max(max, r.maxServerDrift ?? 0), 0),
    interrupted, routes: routes.length, succeeded: count('succeeded'), blocked: count('blocked'), stopped: count('stopped'),
    errored: routes.filter(r => r.phase === 'error').length,
    successRate: routes.length ? count('succeeded') / routes.length : null,
    medianRouteMs: percentile(elapsed, 0.5), p90RouteMs: percentile(elapsed, 0.9),
    cancels: cancels.length, medianStopMs: percentile(latency, 0.5), maxStopMs: latency.at(-1) ?? null,
    maxDriftBlocks: cancels.reduce((m, r) => Math.max(m, r.driftBlocks ?? 0), 0)
  };
}
export function report(rows, summary, meta) {
  const cell = v => v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : v;
  const lines = [
    '# Navigation benchmark', '',
    `Run ${meta.startedAt}. ${meta.trials} trials, ${meta.distance} block legs, cancel trial every ${meta.stopEvery || '—'}.`,
    `Positions: ${summary.positionSource}. In singleplayer the integrated server is the oracle; on a Realm only client prediction exists, and no per-tick server acknowledgement is invented. Block changes are not observed by this harness.`, '',
    '| # | kind | from | target | result | reason | leg | travelled | elapsed s | stop ms | drift |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.trial} | ${r.kind} | ${r.from.x},${r.from.z} | ${r.target.x},${r.target.z} | ${r.phase} | ${(r.reason ?? '').slice(0, 60)} | ${cell(r.legBlocks)} | ${cell(r.travelledBlocks)} | ${cell(r.elapsedMs / 1000)} | ${cell(r.stopLatencyMs)} | ${cell(r.driftBlocks)} |`),
    '', '## Summary', '',
    ...Object.entries(summary).map(([k, v]) => `- ${k}: ${cell(v)}`),
    ...(summary.interrupted ? ['', `${summary.interrupted} trial(s) were interrupted by a game menu and are excluded from the success rate; they measured nothing. Press F3+P so alt-tabbing does not pause the world.`] : [])
  ];
  return lines.join('\n') + '\n';
}

/** Runs against an existing supervisor so the console can call it without a second agent. */
export async function runBench({ agent, bridge, log, trials = 10, distance = 120, stopEvery = 4, routeTimeoutMs = 200_000, say = console.log }) {
  if (!Number.isInteger(trials) || trials < 1 || trials > 200) throw Error('trials must be 1..200');
  if (!(distance >= 20 && distance <= 2000)) throw Error('distance must be 20..2000 blocks');
  const stamp = Date.now();
  const inbox = [];
  const priorEmit = agent.emit;
  agent.emit = event => { inbox.push(event); priorEmit(event); };
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  try {
    const rows = [];
    for (let index = 0; index < trials && !interrupted; index++) {
      const observed = await bridge.state();
      const from = oracle(observed);
      const target = nextTarget(from, index, distance);
      const kind = stopEvery > 0 && (index + 1) % stopEvery === 0 ? 'cancel' : 'route';
      const row = { trial: index + 1, kind, from: { x: from.x, z: from.z }, target, legBlocks: span(from, target),
        positionSource: from.source, maxServerDrift: 0 };
      const began = Date.now();
      try {
        await agent.order(`go to ${target.x} ${target.z}`);
        const id = agent.active?.id;
        if (!id) throw Error('Bridge did not accept the goal');
        let stopAt = null, atStop = null;
        while (Date.now() - began < routeTimeoutMs && !interrupted) {
          const state = await agent.poll();
          if (state.serverPositionAvailable) row.maxServerDrift = Math.max(row.maxServerDrift, state.serverDrift ?? 0);
          log.emit({ kind: 'bench_sample', trial: row.trial, state });
          if (kind === 'cancel' && !stopAt && state.phase === 'navigating' && Date.now() - began > 5000) {
            atStop = oracle(state); stopAt = Date.now();
            await agent.stop();
            while (Date.now() - stopAt < 5000) {
              const after = await bridge.state();
              if (after.phase !== 'navigating') { row.stopLatencyMs = Date.now() - stopAt; break; }
              await delay(100);
            }
            await delay(1500);
            const settled = await bridge.state();
            row.driftBlocks = span(atStop, oracle(settled));
            row.phase = 'cancelled'; row.reason = settled.reason;
            break;
          }
          const outcome = inbox.find(e => e.kind === 'outcome' && e.id === id);
          if (outcome) { row.phase = classify(outcome.phase, outcome.message); row.reason = outcome.message; break; }
          await delay(400);
        }
        row.phase ??= 'timeout';
      } catch (error) {
        row.phase = 'error'; row.reason = error.message;
        try { await agent.stop(); } catch {}
      }
      const end = oracle(await bridge.state());
      row.elapsedMs = Date.now() - began;
      row.end = { x: end.x, z: end.z };
      row.travelledBlocks = span(row.from, row.end);
      // Spread first: row carries its own `kind` (route/cancel) and would otherwise overwrite the
      // journal's record type, leaving trials unfindable by kind in the log.
      rows.push(row); log.emit({ ...row, kind: 'bench_trial', trialKind: row.kind });
      say(`${row.trial}/${trials} ${row.kind} -> ${target.x},${target.z}: ${row.phase} in ${(row.elapsedMs / 1000).toFixed(1)}s (${row.travelledBlocks.toFixed(0)} of ${row.legBlocks.toFixed(0)} blocks)`);
      await delay(1000);
    }
    try { await agent.stop(); } catch {}
    const summary = summarize(rows);
    const path = resolve(root, `../runtime/bench-${stamp}.md`);
    writeFileSync(path, report(rows, summary, { startedAt: new Date(stamp).toISOString(), trials, distance, stopEvery }), { mode: 0o600 });
    say(JSON.stringify(summary, null, 2));
    say(`Report: ${path}`);
    if (interrupted) say('Interrupted; the rows above are the trials that ran.');
    return { summary, path, rows };
  } finally { agent.emit = priorEmit; process.off('SIGINT', onInterrupt); }
}

async function main() {
  const args = process.argv.slice(2);
  const { config, bridge, agent, log } = await openSession({ args, name: 'bench',
    planner: { interpret: () => { throw Error('bench never uses the model'); } } });
  const trials = Number(flag(args, '--trials') ?? 10), distance = Number(flag(args, '--distance') ?? 120);
  const start = await bridge.state();
  if (!start.online) throw Error('Join a world first');
  if (!start.navigationAvailable) throw Error('Baritone is not loaded');
  console.log(`Benchmark will move your character ${trials} times, ~${distance} blocks per leg, starting from ${start.x.toFixed(0)}, ${start.z.toFixed(0)}.`);
  console.log('Set pause-on-lost-focus off (F3+P) or the game menu will cancel every trial when you switch away.');
  if (!args.includes('--yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type run to begin: ');
    rl.close();
    if (answer.trim() !== 'run') return console.log('Cancelled. Nothing moved.');
  }
  await runBench({ agent, bridge, log, trials, distance,
    stopEvery: Number(flag(args, '--stop-every') ?? 4), routeTimeoutMs: Number(flag(args, '--route-timeout') ?? 200) * 1000 });
  log.close();
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
