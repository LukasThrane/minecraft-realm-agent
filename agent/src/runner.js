import { setTimeout as delay } from 'node:timers/promises';
import { describe, trend } from './observe.js';
import { validateAction } from './commands.js';

/**
 * Autonomous operation: a goal that persists, a body that never waits for the model.
 *
 * The loop below deliberately does not await deliberation. The client keeps executing whatever it
 * already has at 20 Hz while a decision is in flight; when one lands it either confirms what is
 * running — costing no interruption at all — or replaces it on the next tick. Optimus-3's demo is
 * slow because every stage of its loop is a forward pass the body waits on; nothing here waits.
 */
export const CONTINUE = 'continue', DONE = 'done';

export const ARRIVED_WITHIN = 2.5;
/**
 * A navigate to where we already stand is a no-op that still costs a dispatch, a path restart and
 * ten ticks of arrival checking. The model kept issuing them because arriving is not something it
 * reliably notices, so the deterministic layer notices instead and says so.
 */
export function alreadyThere(action, state) {
  if (action?.type !== 'navigate' || !Number.isFinite(state?.x)) return false;
  return Math.hypot(state.x - action.x, state.z - action.z) <= ARRIVED_WITHIN;
}
/**
 * Structured output omits fields it was not forced to emit, producing `move` with no ticks and
 * `break` with no duration. Rejecting those wastes a whole deliberation cycle, so supply the
 * obvious default and only refuse what has no safe one.
 */
export function withDefaults(decision) {
  const filled = { ...decision };
  if (filled.type === 'move' && !Number.isInteger(filled.ticks)) filled.ticks = 20;
  if (filled.type === 'move' && filled.ticks < 5) filled.ticks = 20;
  if (filled.type === 'break' && !Number.isInteger(filled.ticks)) filled.ticks = 100;
  if (filled.type === 'select' && !Number.isInteger(filled.slot)) filled.slot = 0;
  return filled;
}
/** Stable identity for an intended action, so repeats are recognisable across deliberations. */
export function signature(action) {
  if (!action || !action.type) return '';
  switch (action.type) {
    case 'navigate': return `navigate:${action.x},${action.z}`;
    case 'move': return `move:${action.direction}`;
    case 'select': return `select:${action.slot}`;
    default: return action.type;
  }
}

/**
 * Session-scoped memory of what has already failed and how.
 *
 * Gate 4 requires no repeated identical failure loop. Keying on the typed failure rather than the
 * text is what makes a repeat recognisable at all, and it is the first half of the remedy store:
 * once a pattern is banned the planner is told, so the next decision has to differ.
 */
export class Attempts {
  constructor({ limit = 3 } = {}) { this.limit = limit; this.records = new Map(); }
  record(action, failure) {
    if (!failure) { this.records.delete(signature(action)); return; }
    const key = signature(action);
    const seen = this.records.get(key) ?? { count: 0, failures: new Set() };
    seen.count++; seen.failures.add(failure);
    this.records.set(key, seen);
  }
  banned(action) {
    const seen = this.records.get(signature(action));
    return seen && seen.count >= this.limit ? `${signature(action)} already failed ${seen.count} times (${[...seen.failures].join(', ')})` : '';
  }
  summary() {
    return [...this.records.entries()]
      .map(([key, seen]) => `${key}: ${seen.count}x ${[...seen.failures].join('/')}`).join('; ');
  }
}

export class Runner {
  constructor({ agent, bridge, planner, goal, emit = () => {}, cycleMs = 500, deliberateEveryMs = 3000,
                maxActions = 200, attempts = new Attempts() }) {
    Object.assign(this, { agent, bridge, planner, goal, emit, cycleMs, deliberateEveryMs, maxActions, attempts });
    this.thinking = null; this.decision = null; this.lastDeliberationAt = 0;
    this.actions = 0; this.recent = []; this.stopped = false; this.inFlight = new Map();
    // Deliberation has its own stagnation: a model that keeps emitting the same malformed or
    // forbidden decision is as stuck as a body that keeps walking into a wall, and needs the
    // same treatment — tell it what went wrong, and stop if telling it does not help.
    this.rejection = ''; this.consecutiveRejections = 0; this.rejectionLimit = 6; this.running = '';
  }
  note(event) { this.emit(event); }

  /** One turn of the loop. Separated so tests can drive it deterministically. */
  async cycle() {
    const state = await this.agent.poll();
    if (state.dead) return state; // recovery owns this; deliberating about it would just be slower

    if (this.decision) {
      const decision = this.decision; this.decision = null;
      await this.apply(decision, state);
    }
    if (!this.thinking && Date.now() - this.lastDeliberationAt >= this.deliberateEveryMs) this.deliberate(state);
    return state;
  }

  /** Non-blocking by construction: the promise is stored, never awaited inside the loop. */
  deliberate(state) {
    this.lastDeliberationAt = Date.now();
    const startedAt = Date.now();
    this.thinking = (async () => {
      const [observation, history] = await Promise.all([this.bridge.observe(), this.bridge.history()]);
      return this.planner.decide({
        goal: this.goal,
        situation: describe(observation, { radius: 24 }),
        trend: trend(history),
        recent: this.recent.slice(-5),
        banned: this.attempts.summary(),
        rejection: this.rejection,
        active: state.acting ? `${state.actionType} running, progress ${state.progress?.toFixed(2)}, stagnant ${state.stagnantTicks} ticks` : 'idle'
      });
    })()
      .then(decision => { this.decision = { ...decision, latencyMs: Date.now() - startedAt }; })
      .catch(error => this.note({ kind: 'deliberation_failed', message: `Deliberation failed: ${error.message}` }))
      .finally(() => { this.thinking = null; });
  }

  async apply(decision, state) {
    if (state.reflex) return;
    if (decision.type === DONE) {
      this.stopped = true;
      return this.note({ kind: 'goal_reached', message: `Goal reported complete (${decision.latencyMs}ms): ${decision.why ?? ''}` });
    }
    if (!decision.type || decision.type === CONTINUE) {
      this.note({ kind: 'continue', message: `continue (${decision.latencyMs}ms): ${decision.why ?? ''}` });
      return;
    }
    let action;
    try { action = validateAction(withDefaults(decision)); }
    catch (error) { return this.reject(`${decision.type}: ${error.message}`); }
    if (alreadyThere(action, state)) {
      return this.reject(`Already standing at ${action.x},${action.z} — that navigate is complete. Answer done if the goal is met, or choose a different action.`, 'already_satisfied');
    }
    const banned = this.attempts.banned(action);
    if (banned) return this.reject(`${banned}. Choose something different.`, 'decision_banned');
    this.rejection = ''; this.consecutiveRejections = 0;
    // Restating the running action is a continue, whatever the model called it. Re-dispatching an
    // identical goal makes the client halt and restart the pathfinder every few seconds for no
    // gain, so the deterministic layer decides this rather than trusting the model to say the word.
    if (state.acting && signature(action) === this.running && (state.progress ?? 1) > 0) {
      return this.note({ kind: 'continue', message: `continue (${decision.latencyMs}ms): ${signature(action)} already running, progress ${state.progress?.toFixed(2)}` });
    }
    if (this.actions >= this.maxActions) { this.stopped = true; return this.note({ kind: 'budget', message: `Action budget of ${this.maxActions} reached; stopping` }); }
    try {
      const id = await this.agent.dispatch(action, decision.assumes);
      if (id) { this.inFlight.set(id, action); this.running = signature(action); }
      this.actions++;
      this.note({ kind: 'decided', message: `${signature(action)} (${decision.latencyMs}ms): ${decision.why ?? ''}` });
    } catch (error) { this.note({ kind: 'dispatch_failed', message: `Could not dispatch ${signature(action)}: ${error.message}` }); }
  }

  /** Refusals are fed back to the next deliberation, and a run that only refuses is stopped. */
  reject(message, kind = 'decision_rejected') {
    this.rejection = message;
    this.note({ kind, message: `Rejected: ${message}` });
    if (++this.consecutiveRejections >= this.rejectionLimit) {
      this.stopped = true;
      this.note({ kind: 'deliberation_stuck', message: `${this.consecutiveRejections} decisions in a row were unusable; stopping rather than looping` });
    }
  }
  /** Every outcome the supervisor emits, matched back to the action that caused it. */
  observeOutcome(event) {
    const action = this.inFlight.get(event.id) ?? {};
    this.inFlight.delete(event.id);
    if (signature(action) === this.running) this.running = '';
    this.attempts.record(action, event.failure);
    this.recent.push({ action: signature(action), status: event.phase, failure: event.failure || 'none',
      progress: event.outcome?.progress, stagnantTicks: event.outcome?.stagnantTicks });
    if (this.recent.length > 20) this.recent.shift();
  }

  async run(signal) {
    // Arm the safety tier before anything moves. It lives in the client, so it keeps working
    // while this process is deliberating, slow, or gone; that is the entire reason it exists.
    try { await this.bridge.reflex(await this.bridge.state(), true); this.note({ kind: 'reflex_armed', message: 'Safety reflexes armed in the client' }); }
    catch (error) { this.note({ kind: 'reflex_unavailable', message: `Could not arm safety reflexes: ${error.message}` }); }
    // Subscribe to outcomes the same way the harnesses do, and hand the emit back afterwards.
    const priorEmit = this.agent.emit;
    this.agent.emit = event => { if (event.kind === 'outcome') this.observeOutcome(event); priorEmit(event); };
    this.note({ kind: 'run_started', message: `Goal: ${this.goal}` });
    try {
      while (!this.stopped && !signal?.aborted) {
        try { await this.cycle(); }
        catch (error) { this.note({ kind: 'cycle_failed', message: error.message }); }
        await delay(this.cycleMs);
      }
    } finally {
      this.agent.emit = priorEmit;
      await this.bridge.state().then(state => this.bridge.reflex(state, false)).catch(() => {});
      await this.agent.stop().catch(() => {});
      this.note({ kind: 'run_stopped', message: `Stopped after ${this.actions} actions` });
    }
  }
}

async function main() {
  const { openSession, flag } = await import('./setup.js');
  const args = process.argv.slice(2);
  const goal = args.filter(a => !a.startsWith('--') && a !== flag(args, '--cycle') && a !== flag(args, '--every')).join(' ').trim();
  if (!goal) { console.error('Give a goal, for example: ./windove run "walk to 200 200"'); process.exit(2); }
  const { config, bridge, agent, log } = await openSession({ args: [...args, '--model'], name: 'run',
    emit: event => console.log(event.message ?? `${event.state?.phase}: ${event.state?.reason}`) });
  const state = await bridge.state();
  if (!state.online) throw Error('Join a world first');
  if (state.protocol < 3) throw Error(`Bridge speaks protocol ${state.protocol}; restart Minecraft`);
  const { Planner } = await import('./planner.js');
  const runner = new Runner({ agent, bridge, planner: new Planner({ ...config, modelEnabled: true }),
    goal, emit: event => { log.emit(event); console.log(event.message); },
    cycleMs: Number(flag(args, '--cycle') ?? 500), deliberateEveryMs: Number(flag(args, '--every') ?? 3000) });
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  await runner.run(controller.signal);
  log.close();
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
