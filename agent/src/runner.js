import { setTimeout as delay } from 'node:timers/promises';
import { describe, trend } from './observe.js';
import { Attempts, signature, validateAction } from './commands.js';
import { DependencyPlanner } from './dependencies.js';

// Both live in commands.js now: the console's skill executor needs the same failure memory, and
// importing the autonomous runner to get at it would have been the wrong dependency.
export { Attempts, signature };

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
  if (filled.type === 'obtain' && !Number.isInteger(filled.count)) filled.count = 1;
  return filled;
}
export class Runner {
  constructor({ agent, bridge, planner, goal, skills, emit = () => {}, cycleMs = 500, deliberateEveryMs = 3000,
                maxActions = 200, attempts = new Attempts() }) {
    Object.assign(this, { agent, bridge, planner, goal, skills, emit, cycleMs, deliberateEveryMs, maxActions, attempts });
    this.job = null; this.observation = null; this.forceDeliberation = false;
    // Used only to answer "do we already have this?" without a model call.
    this.jobPlanner = new DependencyPlanner();
    // A job that is running and advancing has nothing to ask about, but it should not be able to
    // run unsupervised forever either.
    this.jobCheckMs = 60_000;
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
    if (!this.thinking && this.shouldDeliberate(state)) this.deliberate(state);
    return state;
  }

  /**
   * Whether to spend a forward pass right now.
   *
   * While a job is running and advancing, the answer is `continue` -- observed seven times in a row
   * during one cobblestone gather. On this machine that answer costs about five seconds of the only
   * genuinely scarce resource, for no information the deterministic layer did not already have. So
   * do not ask: wait for the job to finish, stall, or the operator to say something. The periodic
   * check remains so a long job is still supervised, just not interrogated every six seconds.
   */
  shouldDeliberate(state) {
    if (this.forceDeliberation) return true;
    if (Date.now() - this.lastDeliberationAt < this.deliberateEveryMs) return false;
    if (this.job && (state.progress ?? 1) > 0 && Date.now() - this.lastDeliberationAt < this.jobCheckMs) return false;
    return true;
  }

  /**
   * Do we already have what this job would produce? Answered from the last observation and the
   * dependency planner, so it costs nothing.
   *
   * Without this the run livelocks on a satisfied goal: the model asks for a stone pickaxe it is
   * already holding, the executor verifies it instantly and reports success, the rejection counter
   * resets because a valid action was dispatched, and the next decision asks again. Observed for
   * as long as the operator was willing to watch it.
   */
  alreadyHave(action) {
    const items = this.observation?.inventory?.items;
    if (action.type !== 'obtain' || !Array.isArray(items)) return '';
    const counts = {};
    for (const entry of items) if (Number.isInteger(entry.count) && entry.count > 0) counts[entry.item] = (counts[entry.item] ?? 0) + entry.count;
    try {
      const plan = this.jobPlanner.plan(action.item, action.count, counts);
      if (plan.status === 'planned' && plan.nodes.length === 0) return `already holding ${action.count} ${plan.goal.item}`;
    } catch { /* an unplannable item is not a satisfied one */ }
    return '';
  }

  /** Non-blocking by construction: the promise is stored, never awaited inside the loop. */
  deliberate(state) {
    this.forceDeliberation = false;
    this.lastDeliberationAt = Date.now();
    const startedAt = Date.now();
    this.thinking = (async () => {
      const [observation, history] = await Promise.all([this.bridge.observe(), this.bridge.history()]);
      this.observation = observation;
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
      // Nothing is running, so there is nothing to continue. This is the shape "goal achieved but
      // never declared" takes: the model keeps answering continue because it correctly sees no work
      // to do, and the run idles forever because continue is always accepted. Saying so is enough --
      // the rejection reaches the next deliberation, and a model that still will not answer done
      // after several attempts stops the run rather than idling in it.
      if (!this.job && !state.acting) {
        return this.reject('Nothing is running, so continue does nothing. Choose an action, or answer done if the goal is already met.', 'idle_continue');
      }
      this.rejection = ''; this.consecutiveRejections = 0;
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
    const satisfied = this.alreadyHave(action);
    // Checked before the counter resets, or a no-op that reports success would clear the very
    // evidence that the run is going nowhere.
    if (satisfied) return this.reject(`${signature(action)} is ${satisfied}, so there is nothing to obtain. Answer done if the goal is met, or choose something else.`, 'already_satisfied');
    this.rejection = ''; this.consecutiveRejections = 0;
    // A running job is not visible as `state.acting` between its own steps, so restating it has to
    // be recognised here or every deliberation would cancel and restart the chain.
    if (this.job && signature(action) === this.job.signature) {
      return this.note({ kind: 'continue', message: `continue (${decision.latencyMs}ms): ${this.job.signature} still running` });
    }
    if (this.job) await this.cancelJob(signature(action));
    if (action.type === 'obtain') return this.startJob(action, decision);
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

  /**
   * Start a job. Started, never awaited: the loop must keep deliberating while it runs, which is
   * the whole reason the body does not stop for inference.
   *
   * `obtain` is the model's only verb that reaches the skill layer, and it is deliberately coarse.
   * The model says what it wants; the dependency planner owns the recipe arithmetic and the
   * executor owns verification, so a wrong answer here costs a rejected plan rather than a
   * half-crafted mess.
   */
  startJob(action, decision) {
    if (!this.skills) return this.reject('obtain is unavailable: this run has no skill executor');
    const controller = new AbortController();
    const job = { signature: signature(action), controller };
    this.job = job; this.running = job.signature; this.actions++;
    job.finished = this.skills.run({ item: action.item, count: action.count }, controller.signal)
      .then(() => { this.remember(action, 'succeeded', ''); this.attempts.record(action, ''); this.note({ kind: 'job_done', message: `${job.signature} complete` }); })
      .catch(error => {
        if (error.name === 'AbortError') return;
        const failure = error.failure ?? 'precondition';
        this.attempts.record(action, failure); this.remember(action, 'blocked', failure);
        this.note({ kind: 'job_failed', message: `${job.signature} failed: ${error.message}` });
      })
      .finally(() => { if (this.job === job) { this.job = null; this.running = ''; } });
    this.note({ kind: 'decided', message: `${job.signature} (${decision.latencyMs}ms): ${decision.why ?? ''}` });
  }

  /**
   * Cancel a running job and wait for the client to actually let go.
   *
   * Aborting the executor only unwinds this process's loop. The skill it already dispatched is
   * still running on the client tick, and the next job refuses to start while an action is in
   * flight. Observed live, retargeting mid-chain: `obtain:log failed: Stop the current action
   * before starting a skill goal`, followed by a lost heartbeat as the orphaned action timed out.
   *
   * Blocking the loop here is deliberate and is not the thing the architecture forbids. What must
   * never wait on inference is the body; waiting on a stop handshake is waiting for the body.
   */
  async cancelJob(replacedBy = '') {
    const job = this.job;
    if (!job) return;
    this.job = null; this.running = '';
    job.controller.abort();
    this.note({ kind: 'job_replaced', message: `${job.signature} cancelled${replacedBy ? ` for ${replacedBy}` : ''}` });
    await job.finished?.catch(() => {});
    try { await this.agent.stop(); } catch {}
    for (let waited = 0; waited < 3000; waited += 100) {
      const state = await this.bridge.state().catch(() => null);
      if (!state || (!state.acting && !state.pendingActionId && !state.stopPending)) return;
      await delay(100);
    }
    this.note({ kind: 'job_cancel_slow', message: 'Client still reports an action after 3s; the next job may be refused' });
  }

  /** The short typed history the next deliberation reads. Bounded so it cannot grow into the prompt. */
  remember(action, status, failure) {
    this.recent.push({ action: signature(action), status, failure: failure || 'none' });
    if (this.recent.length > 20) this.recent.shift();
  }

  /**
   * Replace the goal mid-run, without stopping the body.
   *
   * The operator gets the same continuity the model does: a new instruction takes effect at the
   * next deliberation rather than tearing down what is running, and a stale decision made for the
   * previous goal is dropped rather than applied to this one.
   */
  retarget(goal) {
    this.goal = goal; this.decision = null; this.lastDeliberationAt = 0; this.forceDeliberation = true;
    this.rejection = ''; this.consecutiveRejections = 0;
    this.note({ kind: 'goal_changed', message: `Goal is now: ${goal}` });
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
    // Skills dispatch outside the supervisor, so an outcome we never dispatched is not ours to
    // record; attributing it to an empty signature would quietly poison the failure memory.
    if (!this.inFlight.has(event.id)) return;
    const action = this.inFlight.get(event.id);
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
        // Abortable, so a stop lands within a tick rather than after the current sleep and
        // whatever inference is in flight behind it.
        try { await delay(this.cycleMs, undefined, { signal }); } catch { break; }
      }
    } finally {
      await this.cancelJob().catch(() => {});
      this.agent.emit = priorEmit;
      await this.bridge.state().then(state => this.bridge.reflex(state, false)).catch(() => {});
      await this.agent.stop().catch(() => {});
      this.note({ kind: 'run_stopped', message: `Stopped after ${this.actions} actions` });
    }
  }
}

async function main() {
  const readline = await import('node:readline');
  const { classify } = await import('./commands.js');
  const { queries, QUERY_HELP } = await import('./queries.js');
  const { parseObtainGoal } = await import('./dependencies.js');
  const { openSession, flag } = await import('./setup.js');
  const args = process.argv.slice(2);
  const goal = args.filter(a => !a.startsWith('--') && a !== flag(args, '--cycle') && a !== flag(args, '--every')).join(' ').trim();
  if (!goal) { console.error('Give a goal, for example: ./windove run "walk to 200 200"'); process.exit(2); }
  // A run prints continuously while the operator is typing into the same terminal. Without
  // redrawing the input line, every log line shreds whatever is half-typed: a live run turned
  // "nah wait get 4 logs instead" into six fragments scattered through the output, and the
  // operator resorted to typing "hello? stop" because nothing looked like it was being read.
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  const print = text => {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    console.log(text);
    input.prompt(true);
  };
  const { config, bridge, agent, log } = await openSession({ args: [...args, '--model'], name: 'run',
    emit: event => print(event.message ?? `${event.state?.phase}: ${event.state?.reason}`) });
  const state = await bridge.state();
  if (!state.online) throw Error('Join a world first');
  if (state.protocol < 3) throw Error(`Bridge speaks protocol ${state.protocol}; restart Minecraft`);
  const { Planner } = await import('./planner.js');
  const { SkillExecutor } = await import('./skills.js');
  const emit = event => { log.emit(event); print(event.message); };
  const runner = new Runner({ agent, bridge, planner: new Planner({ ...config, modelEnabled: true }),
    goal, skills: new SkillExecutor(bridge, message => emit({ kind: 'skill-progress', message })), emit,
    cycleMs: Number(flag(args, '--cycle') ?? 500), deliberateEveryMs: Number(flag(args, '--every') ?? 3000) });
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  // The run reads stdin, because watching an agent you cannot redirect is not supervision. Same
  // input language as the console -- bare text is a goal, stop needs no slash -- so there is one
  // thing to learn rather than two. A run holds one long-lived intention, so it takes no commands.
  const look = queries({ bridge, attempts: runner.attempts, log: event => log.emit(event) });
  input.on('line', line => {
    const routed = classify(line);
    if (routed.kind === 'stop') { print('Stopping.'); controller.abort(); return; }
    if (routed.kind === 'empty') { input.prompt(); return; }
    if (routed.kind === 'help') { print(`${QUERY_HELP}\n\nAnything else is a new goal. "stop" ends the run.`); input.prompt(); return; }
    // Read-only commands work here for the same reason they work during a console goal: they look
    // and never touch action authority. `/plan` reaching this as a `preview` is why it is matched
    // before the goal path -- it previously fell through and silently retargeted the run.
    if (routed.kind === 'preview') { void look.run('plan', [routed.text]).then(print).catch(e => print(e.message)); return; }
    if (routed.kind === 'command' && look.handles(routed.name)) {
      void look.run(routed.name, routed.rest).then(print).catch(e => print(e.message)); return;
    }
    if (routed.kind === 'command' && (routed.name === 'quit' || routed.name === 'exit')) { print('Stopping.'); controller.abort(); return; }
    if (routed.kind === 'command' && routed.name === 'goal') { runner.retarget(routed.rest.join(' ')); input.prompt(); return; }
    if (routed.kind === 'command') {
      print(`/${routed.name} changes something, and a run owns the body. Type a goal, or stop. /help lists what you can look at.`);
      input.prompt(); return;
    }
    const text = routed.text ?? line.trim();
    // A bare line is a goal, which makes a typo a goal too: `sotp` and `hello?` both silently
    // replaced what the agent was doing. Anything that is neither a recognisable obtain nor more
    // than one word is almost certainly not an instruction, so it asks rather than acting. `/goal`
    // overrides, because refusing a goal the operator meant would be the worse failure.
    if (!parseObtainGoal(text) && text.split(/\s+/).length < 2) {
      print(`"${text}" does not look like a goal, so nothing changed. Use /goal ${text} to set it anyway, /help to look at things, or stop to end the run.`);
      input.prompt(); return;
    }
    runner.retarget(text);
    input.prompt();
  });
  print('Type a new goal at any time to redirect it, "/help" to look at things, or "stop" to end the run.');
  try { await runner.run(controller.signal); } finally { input.close(); log.close(); }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
