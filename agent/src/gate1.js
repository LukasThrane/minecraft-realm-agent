import { setTimeout as delay } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Bridge } from './bridge.js';
import { Supervisor } from './supervisor.js';
import { journal } from './journal.js';
import { flag, root, openSession } from './setup.js';

/**
 * Gate 1 of PLAN.md: client and control baseline.
 *
 * "Verify forward/turn/jump, inventory interaction and takeover. Stop must release inputs
 * within two client ticks after receipt; cancellation must survive an artificially delayed
 * planner response."
 *
 * Every check is judged on the client's own before/after evidence for the action, never on
 * the fact that a request was accepted. Run it in a disposable singleplayer world.
 */
export const TICK_BUDGET = 2;

export function verdict(checks) {
  const failed = checks.filter(c => !c.pass);
  return { checks: checks.length, passed: checks.length - failed.length, failed: failed.length,
    gate: failed.length === 0 ? 'PASS' : 'FAIL', failing: failed.map(c => c.name) };
}
export function report(checks, summary, meta) {
  const cell = v => v == null ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v);
  return ['# Gate 1: client and control baseline', '',
    `Run ${meta.startedAt}. Protocol ${meta.protocol}. Stop budget ${TICK_BUDGET} client ticks.`,
    'Judged on the client\'s before/after evidence per action, not on request acceptance.', '',
    '| check | pass | expected | observed | detail |', '|---|---|---|---|---|',
    ...checks.map(c => `| ${c.name} | ${c.pass ? 'yes' : 'NO'} | ${cell(c.expected)} | ${cell(c.observed)} | ${(c.detail ?? '').slice(0, 70)} |`),
    '', `**${summary.gate}** — ${summary.passed}/${summary.checks} checks.`,
    ...(summary.failed ? ['', 'Failing: ' + summary.failing.join(', ')] : [])].join('\n') + '\n';
}

/**
 * Runs the gate against an existing supervisor, so the console can run it without a second
 * agent competing for the same control lease. The caller owns the bridge and the journal.
 */
export async function runGate1({ agent, bridge, log, site, stopTrials = 5, say = console.log }) {
  const stamp = Date.now();
  const inbox = [];
  const priorEmit = agent.emit;
  agent.emit = event => { inbox.push(event); priorEmit(event); };
  try {
    const start = await bridge.state();
    if (!start.online) throw Error('Join a world first');
    if (start.protocol < 3) throw Error(`Bridge speaks protocol ${start.protocol}; restart Minecraft to load the current mod`);

    const checks = [];
    const record = check => { checks.push(check); log.emit({ kind: 'gate1_check', ...check });
      say(`${check.pass ? 'ok  ' : 'FAIL'} ${check.name}: expected ${check.expected}, observed ${check.observed}${check.detail ? ` (${check.detail})` : ''}`); };

    async function run(order, timeoutMs = 20_000) {
      const before = inbox.length;
      await agent.order(order);
      const id = agent.active?.id;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await agent.poll();
        const done = inbox.slice(before).find(e => e.kind === 'outcome' && e.id === id);
        if (done) return { phase: done.phase, reason: done.message, outcome: done.state.outcome ?? {} };
        await delay(150);
      }
      await agent.stop();
      return { phase: 'timeout', reason: 'No outcome within the harness timeout', outcome: {} };
    }
    const evidenceOf = result => result.outcome?.evidence ?? {};

    // Movement: each direction must displace the player at close to walking pace, judged by the
    // client. The threshold is not token: 20 ticks of walking is roughly 3 blocks, and the first
    // run of this gate passed a 0.4-block crawl under a laxer bar before the input path was fixed.
    for (const direction of ['forward', 'back', 'left', 'right']) {
      const result = await run(`${direction} 20`);
      const moved = evidenceOf(result).displacement ?? 0;
      record({ name: `move ${direction}`, pass: result.phase === 'succeeded' && moved > 1.5,
        expected: '> 1.5 blocks', observed: moved, detail: result.reason });
      await delay(600);
    }
    const turned = await run('turn 90');
    record({ name: 'turn 90', pass: turned.phase === 'succeeded' && Math.abs(Math.abs(evidenceOf(turned).yawChange ?? 0) - 90) < 5,
      expected: '90 degrees', observed: evidenceOf(turned).yawChange, detail: turned.reason });
    const jumped = await run('jump');
    record({ name: 'jump', pass: jumped.phase === 'succeeded' && (evidenceOf(jumped).peakRise ?? 0) > 0.4,
      expected: '> 0.4 blocks rise', observed: evidenceOf(jumped).peakRise, detail: jumped.reason });
    const target = ((await bridge.observe()).inventory?.selectedSlot ?? 0) === 3 ? 5 : 3;
    const selected = await run(`slot ${target}`);
    record({ name: `select slot ${target}`, pass: selected.phase === 'succeeded' && evidenceOf(selected).slotAfter === target,
      expected: target, observed: evidenceOf(selected).slotAfter, detail: selected.reason });

    // Takeover: stop must release inputs within two client ticks of being heard.
    const releases = [];
    for (let trial = 0; trial < stopTrials; trial++) {
      // 40 ticks is still running 700ms later, and is far less blind walking than a long hold.
      await agent.order('forward 40');
      await delay(700);
      const requestedAt = Date.now();
      const posAtStop = await bridge.state();
      await agent.stop();
      let released = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = await bridge.state();
        if (state.stopReleaseAt >= requestedAt) { released = state; break; }
        await delay(50);
      }
      await delay(1000);
      const settled = await bridge.state();
      releases.push({ ticks: released?.stopReleaseTicks ?? null, ms: released?.stopReleaseMs ?? null,
        drift: Math.hypot(settled.x - posAtStop.x, settled.z - posAtStop.z) });
      log.emit({ kind: 'gate1_stop', trial: trial + 1, ...releases.at(-1) });
      await delay(500);
    }
    record({ name: `stop releases inputs (${stopTrials} trials)`, pass: releases.every(r => r.ticks !== null && r.ticks <= TICK_BUDGET),
      expected: `<= ${TICK_BUDGET} ticks`, observed: releases.reduce((max, r) => Math.max(max, r.ticks ?? Infinity), 0),
      detail: releases.map(r => `${r.ticks}t/${r.ms}ms`).join(' ') });
    record({ name: 'movement stops after release', pass: releases.every(r => r.drift < 2),
      expected: '< 2 blocks coast', observed: releases.reduce((max, r) => Math.max(max, r.drift), 0) });

    // Cancellation must survive a planner that answers long after it stopped being relevant.
    const slow = { interpret: () => new Promise(r => setTimeout(() => r({ type: 'navigate', x: 0, z: 0 }), 4000)) };
    const dispatched = [];
    const watched = { state: () => bridge.state(), stop: () => bridge.stop(), lease: s => bridge.lease(s),
      act: async (...call) => { dispatched.push(call[0]); return bridge.act(...call); } };
    const delayed = new Supervisor({ bridge: watched, planner: slow, site, emit: e => log.emit(e) });
    const pending = delayed.order('wander somewhere vague').catch(() => {});
    await delay(400);
    await delayed.stop();
    await pending;
    await delay(4500);
    record({ name: 'stop beats a delayed planner response', pass: dispatched.length === 0,
      expected: '0 actions dispatched', observed: dispatched.length, detail: 'planner answered 4s after cancellation' });

    await agent.stop();
    const summary = verdict(checks);
    const path = resolve(root, `../runtime/gate1-${stamp}.md`);
    writeFileSync(path, report(checks, summary, { startedAt: new Date(stamp).toISOString(), protocol: start.protocol }), { mode: 0o600 });
    say(`\n${summary.gate}: ${summary.passed}/${summary.checks} checks. Report: ${path}`);
    return { summary, path };
  } finally { agent.emit = priorEmit; }
}

async function main() {
  const args = process.argv.slice(2);
  const { config, bridge, agent, log } = await openSession({ args, name: 'gate1',
    planner: { interpret: () => { throw Error('gate 1 uses no model'); } } });
  const start = await bridge.state();
  console.log(`Gate 1 will move your character a few blocks and rotate the view, from ${start.x?.toFixed(0)}, ${start.z?.toFixed(0)}.`);
  console.log('Use a disposable singleplayer world. Turn pause-on-lost-focus off (F3+P) first.');
  if (!args.includes('--yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('Type run to begin: ');
    rl.close();
    if (answer.trim() !== 'run') return console.log('Cancelled. Nothing moved.');
  }
  const { summary } = await runGate1({ agent, bridge, log, site: config.site, stopTrials: Number(flag(args, '--stop-trials') ?? 5) });
  log.close();
  process.exitCode = summary.gate === 'PASS' ? 0 : 1;
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
