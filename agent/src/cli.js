import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { runGate1 } from './gate1.js';
import { runBench } from './bench.js';
import { root, openSession } from './setup.js';
import { classify } from './commands.js';
import { parseObtainGoal } from './dependencies.js';
import { queries, QUERY_HELP } from './queries.js';
import { SkillExecutor } from './skills.js';

/**
 * Two kinds of input, told apart by a slash rather than by guessing.
 *
 * `/word` is one immediate thing: it prints, or it moves the player once, and it is over. Bare
 * text is a goal, which runs for as long as it takes and is interrupted with stop. The previous
 * console inferred which was which from an ordered pile of patterns, so `craft 6 logs` was a goal
 * and `fetch 6 logs` fell through to the model as free text -- the same request, two behaviours,
 * for no reason a user could see.
 *
 * Stop is the exception that needs no slash. A safety command must never fail because of syntax.
 */
const args = process.argv.slice(2);
const { config, bridge, agent, log } = await openSession({ args, name: 'events',
  emit: event => console.log(event.message ?? `${event.state?.phase}: ${event.state?.reason}`) });
const input = createInterface({ input: process.stdin, output: process.stdout });
const skills = new SkillExecutor(bridge, message => { console.log(message); log.emit({ kind: 'skill-progress', message }); });
// One implementation of the look-only commands, shared with `./windove run`, so they behave the
// same in both places and neither can quietly forget one.
const views = queries({ bridge, attempts: skills.attempts, log: event => log.emit(event) });
let skillAbort;
let closing = false, lastError = '', nextSample = 0, busy = false;

async function shutdown() {
  if (closing) return;
  closing = true; skillAbort?.abort();
  try { await agent.stop(); } catch {}
  input.close(); log.close();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); input.on('close', shutdown);

/**
 * One-shot world actions, expressed as the phrasing `directCommand` already parses. The slash layer
 * is a front end over that parser, not a second copy of its bounds.
 */
const WORLD = {
  go: rest => rest[0] === 'site' ? 'go to site' : `go to ${rest[0]} ${rest[1]}`,
  forward: rest => `forward ${rest[0] ?? 10}`, back: rest => `back ${rest[0] ?? 10}`,
  left: rest => `left ${rest[0] ?? 10}`, right: rest => `right ${rest[0] ?? 10}`,
  turn: rest => `turn ${rest[0]}`, face: rest => `face ${rest[0]} ${rest[1]}`,
  jump: () => 'jump', place: () => 'place', slot: rest => `slot ${rest[0]}`,
  break: rest => `break ${rest[0] ?? 100}`, respawn: () => 'respawn', status: () => 'status'
};

const HELP = `
Bare text is a goal. It runs until it finishes or you stop it:
  craft stone pickaxe        get 6 logs        craft 64 planks
  Chains gathering, crafting, station placement and smelting, replanning from
  inventory after every step.${config.modelEnabled ? '' : '  Free-form wording needs --model.'}

/commands are immediate.
  Look:    /inventory  /craftable  /can-craft <item>  /plan [n] <item>
           /look [radius]  /status  /history  /frame
  Move:    /go <x> <z>  /go site  /forward|/back|/left|/right [ticks]
           /turn <deg>  /face <yaw> <pitch>  /jump  /slot 0-8
  World:   /break [ticks]  /place  /respawn
  Memory:  /failures  /forget          Safety: /reflex on|off
  Tests:   /gate1 [trials]  /bench [routes] [distance]
  Control: /stop  /quit

stop and cancel work with or without the slash. F8 in Minecraft takes over.
Read-only commands keep working while a goal runs.`.trim();

input.on('line', line => { void handle(line).catch(error => { if (error.name !== 'AbortError') console.error(error.message); }); });

async function handle(raw) {
  const routed = classify(raw);
  switch (routed.kind) {
    case 'empty': return;
    case 'stop': skillAbort?.abort(); return agent.stop().catch(e => console.error(e.message));
    case 'help': return void console.log(HELP);
    case 'goal': return goal(routed.text);
    case 'preview': return void console.log(await views.run('plan', [routed.text]));
    case 'preview_only': return void console.error('Use /plan for a read-only preview.');
    default: return command(routed.name, routed.rest);
  }
}

async function command(name, rest) {
  if (name === 'quit') return void shutdown();
  // Looking never cancels, extends or starts an action, so it works while a goal is running.
  if (views.handles(name)) return void console.log(await views.run(name, rest));
  if (busy && name !== 'frame' && name !== 'forget') return void console.error('A goal or harness is running. Type stop first.');

  switch (name) {
    case 'frame': return frame();
    case 'forget': skills.attempts.records.clear(); return void console.log('Skill failure memory cleared.');
    case 'reflex': {
      const armed = await bridge.reflex(await bridge.state(), rest[0] !== 'off');
      return void console.log(`Safety reflexes ${armed.armed ? 'armed' : 'disarmed'}`);
    }
    case 'gate1': case 'bench': {
      busy = true;
      const run = name === 'gate1'
        ? runGate1({ agent, bridge, log, site: config.site, stopTrials: Number(rest[0]) || 5 })
        : runBench({ agent, bridge, log, trials: Number(rest[0]) || 20, distance: Number(rest[1]) || 120 });
      return void run.catch(e => console.error(e.message)).finally(() => { busy = false; });
    }
  }
  if (!WORLD[name]) return void console.error(`Unknown command: /${name}. Type /help.`);
  const state = await agent.order(WORLD[name](rest));
  if (state) console.log(JSON.stringify(state, null, 2));
}

/**
 * A goal, not a command. `plan` is deliberately not accepted here: it reads as an instruction to
 * go and do the thing, and a preview that starts mining is the worst possible misunderstanding.
 */
async function goal(text) {
  const parsed = parseObtainGoal(text);
  if (!parsed) {
    if (!config.modelEnabled) return void console.error(`Not understood: "${text}". Try: craft stone pickaxe, get 6 logs. Type /help, or start with --model for free-form wording.`);
    const state = await agent.order(text);
    if (state) console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (busy || agent.active) return void console.error('A goal is already running. Type stop first.');
  busy = true; skillAbort = new AbortController();
  void skills.run(parsed, skillAbort.signal)
    .catch(error => { if (error.name !== 'AbortError') console.error(`Goal stopped: ${error.message}`); })
    .finally(async () => { try { await bridge.stop(); } catch {} busy = false; skillAbort = null; });
}

async function frame() {
  const captured = await bridge.frame();
  const path = resolve(root, `../runtime/frames/frame-${captured.capturedAt}.png`);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, captured.bytes, { mode: 0o600 });
  log.emit({ kind: 'frame', path, capturedAt: captured.capturedAt, ageMs: captured.ageMs, fresh: captured.fresh, width: captured.width, height: captured.height });
  console.log(`${captured.width}x${captured.height}, ${captured.ageMs}ms old${captured.fresh ? '' : ' (STALE: client produced no new frame in time)'} -> ${path}`);
}

console.log(`Private testing console. Model ${config.modelEnabled ? config.model : 'disabled'}. Type /help. Nothing moves until you give a command.`);
while (!closing) {
  try {
    if (busy) { await new Promise(r => setTimeout(r, 200)); continue; }
    const state = await agent.poll(); lastError = '';
    if (agent.active && Date.now() > nextSample) {
      nextSample = Date.now() + 3000; log.emit({ kind: 'sample', state });
      console.log(`Observed ${state.x?.toFixed(1)}, ${state.y?.toFixed(1)}, ${state.z?.toFixed(1)} (${state.positionSource}); ${state.phase}`);
    }
  } catch (e) { if (e.message !== lastError) console.error(e.message); lastError = e.message; }
  await new Promise(r => setTimeout(r, 500));
}
