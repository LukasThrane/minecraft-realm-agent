import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { deadlineFor, directCommand, scopeFor, validateAction, validateAssumptions } from './commands.js';
export class Supervisor {
  constructor({ bridge, planner, site, emit = () => {}, readyTimeoutMs = 60000, readyPollMs = 100 }) {
    Object.assign(this, { bridge, planner, site, emit });
    this.readyTimeoutMs = readyTimeoutMs; this.readyPollMs = readyPollMs;
    this.revision = 0; this.abort = new AbortController(); this.active = null; this.lastPhase = ''; this.dead = false;
  }
  invalidate() { ++this.revision; this.abort.abort(); this.abort = new AbortController(); this.active = null; }
  async stop() {
    this.invalidate();
    await this.bridge.stop();
    this.emit({ kind: 'stop', message: 'Stop accepted by bridge; release occurs on next client tick' });
  }
  async order(text, assumes) {
    const direct = directCommand(text, this.site);
    if (direct?.type === 'stop') return this.stop();
    if (direct?.type === 'status') return this.bridge.state();
    if (direct?.type === 'respawn') return this.recovery ? this.recovery.handle() : this.bridge.state();
    // Stop the old goal before interpreting a replacement. Slow inference never retains control.
    this.invalidate(); const revision = this.revision, signal = this.abort.signal;
    await this.bridge.stop();
    if (revision !== this.revision) return;
    this.emit({ kind: 'order', message: text });
    // A terminal command may arrive while focus loss has opened Minecraft's menu.
    // Keep the intent here, never in the game input queue, until gameplay resumes.
    const state = await this.waitForGameplay(revision, signal);
    if (!state || revision !== this.revision) return;
    const action = validateAction(direct ?? await this.planner.interpret(text, state, signal));
    if (revision !== this.revision) return;
    if (action.type === 'stop') return this.stop();
    if (action.type === 'status') return this.bridge.state();
    if (action.type === 'respawn') return this.recovery ? this.recovery.handle() : this.bridge.state();
    const fresh = await this.waitForGameplay(revision, signal, state.session, state.epoch);
    if (!fresh) return;
    if (revision !== this.revision) return;
    if (fresh.session !== state.session) throw Error('World changed during planning; issue the command again');
    if (Date.now() - fresh.observedAt > 2000) throw Error('Client observation is stale');
    const id = randomUUID();
    await this.bridge.act(action, fresh, id, deadlineFor(action), scopeFor(action), validateAssumptions(assumes));
    if (revision !== this.revision) { await this.bridge.stop(); return; }
    this.active = { id, session: fresh.session, submittedAt: Date.now() };
    this.emit({ kind: 'submitted', id, action, message: `${action.type} submitted${action.type === 'navigate' ? ` to ${action.x}, ${action.z}` : ''}; not yet verified` });
  }
  /**
   * Submit without stopping the body first.
   *
   * `order` cancels before it interprets, which is right for a person typing "stop that, do this"
   * and exactly wrong for an agent that lives inside its own inference latency. The client already
   * swaps actions atomically on a tick, so a replacement needs no stop: whatever is running keeps
   * running at 20 Hz until the new action takes the tick. That is the continuity RTC and AsyncVLA
   * train an adapter to approximate, available here for free because our actions are semantic.
   */
  async dispatch(action, assumes) {
    const checked = validateAction(action);
    const state = await this.bridge.state();
    if (!state.online) throw Error('No world connected');
    if (!state.canAct) throw Error('Client cannot act (menu, pause or death)');
    if (Date.now() - state.observedAt > 2000) throw Error('Client observation is stale');
    const id = randomUUID();
    const revision = this.revision;
    await this.bridge.act(checked, state, id, deadlineFor(checked), scopeFor(checked), validateAssumptions(assumes));
    if (revision !== this.revision) { await this.bridge.stop(); return null; }
    this.active = { id, session: state.session, submittedAt: Date.now() };
    this.emit({ kind: 'dispatched', id, action: checked, assumes, message: `${checked.type} dispatched without stopping the body` });
    return id;
  }
  async waitForGameplay(revision, signal, expectedSession, expectedEpoch) {
    const deadline = Date.now() + this.readyTimeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
      const state = await this.bridge.state();
      if (revision !== this.revision) return null;
      if (!state.online) throw Error('No world connected; join a world and issue the command again');
      if (!state.navigationAvailable) throw Error('Baritone is not loaded');
      expectedSession ??= state.session;
      if (state.session !== expectedSession) throw Error('World changed during planning; issue the command again');
      // The bridge's stop request increments the epoch once on receipt and again
      // on its tick. Establish the cancellation fence only after that stop settles.
      if (!state.stopPending) {
        expectedEpoch ??= state.epoch;
        if (state.epoch !== expectedEpoch) throw Error('Control changed (for example F8); queued command cancelled');
      }
      if (state.canAct && !state.stopPending && !state.acting && Date.now() - state.observedAt <= 2000) return state;
      if (!announced) {
        announced = true;
        this.emit({ kind: 'waiting_for_gameplay', message: 'Command queued for up to 60 seconds. Return to Minecraft and close the menu (Esc / Back to Game). Type stop to cancel.' });
      }
      await delay(this.readyPollMs, undefined, { signal });
    }
    throw Error('Queued command expired while waiting for gameplay; issue it again when ready');
  }
  async poll() {
    const revision = this.revision;
    const state = await this.bridge.state();
    if (revision !== this.revision) return state;
    if (this.active) {
      if (state.session !== this.active.session || Date.now() - state.observedAt > 2000) { await this.stop(); throw Error('Session changed or observations stale'); }
      if (state.outcome?.actionId === this.active.id && state.outcome.status) {
        const outcome = state.outcome;
        this.emit({ kind: 'outcome', id: this.active.id, phase: outcome.status === 'cancelled' ? 'stopped' : outcome.status,
          failure: outcome.failure ?? '', message: outcome.reason, state, outcome });
        this.active = null;
      } else if (state.pendingActionId === this.active.id && state.reflex) {
        await this.bridge.lease(state);
      } else if (state.actionId === this.active.id && !state.acting && ['succeeded','blocked','stopped','failed'].includes(state.phase)) {
        this.emit({ kind: 'outcome', id: this.active.id, phase: state.phase, failure: state.outcome?.failure ?? state.failure ?? '',
          message: state.reason, state, outcome: state.outcome });this.active = null;
      } else if (state.actionId === this.active.id && state.acting) {
        // A lease races the control epoch: if it moved between reading state and renewing, the
        // renewal is refused. That is not a failure of the action, and the next poll reads the
        // truth either way. Losing control for real still shows up as an outcome, not silence.
        try { await this.bridge.lease(state); } catch (error) { this.emit({ kind: 'lease_refused', message: `Lease not renewed: ${error.message}` }); }
      } else if (Date.now() - this.active.submittedAt > 2000) {
        await this.stop();throw Error('Action was not started by client');
      }
    }
    // Death is the one condition that must be noticed without being asked about.
    if (state.dead && !this.dead) {
      this.dead = true; this.active = null;
      this.emit({ kind: 'died', message: `Died: ${state.deathMessage || 'unknown cause'} at ${Math.round(state.x)}, ${Math.round(state.y)}, ${Math.round(state.z)}`, state });
      if (this.recovery) await this.recovery.handle().catch(error => this.emit({ kind: 'recovery_failed', message: `Death handling failed: ${error.message}` }));
    } else if (!state.dead && this.dead) {
      this.dead = false;
    }
    const phase = `${state.session}:${state.phase}`;
    if (phase !== this.lastPhase) { this.lastPhase = phase;this.emit({ kind: 'state', state }); }
    return state;
  }
}
