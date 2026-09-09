import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * What to do about a death. Deliberately narrow: the only outcomes are respawn or wait.
 *
 * Being dead is the one state the character cannot leave on its own, so the fallback when the
 * model is absent, slow or wrong is to respawn — and to say that a fallback happened. The rate
 * limit exists because a respawn point next to whatever killed us turns a death into a loop
 * that grinds items away; after enough deaths in a window this stops and asks for an instruction.
 */
export class Recovery {
  constructor({ bridge, planner, emit = () => {}, modelEnabled = false, maxRespawns = 3, windowMs = 300_000, verifyMs = 15_000 }) {
    Object.assign(this, { bridge, planner, emit, modelEnabled, maxRespawns, windowMs, verifyMs });
    this.respawns = [];
  }
  recent(now = Date.now()) { return this.respawns.filter(at => now - at < this.windowMs); }
  async decide(state) {
    if (!this.modelEnabled) return { type: 'respawn', why: 'No model; respawn is the only way out of the death screen' };
    try {
      const choice = await this.planner.decideDeath(state);
      return { ...choice, source: 'model' };
    } catch (error) {
      return { type: 'respawn', why: `Model unavailable (${error.message}); respawning anyway`, source: 'fallback' };
    }
  }
  /** Called once per death. Returns the decision actually taken. */
  async handle() {
    const state = await this.bridge.state();
    if (!state.dead) return { type: 'wait', why: 'Already alive' };
    if (state.hardcore) return this.report({ type: 'wait', why: 'Hardcore world; respawn is not available' });
    if (!state.canRespawn) return this.report({ type: 'wait', why: 'Death screen not up yet; issue respawn when it appears' });
    this.respawns = this.recent();
    if (this.respawns.length >= this.maxRespawns) {
      return this.report({ type: 'wait', why: `${this.respawns.length} respawns in the last ${Math.round(this.windowMs / 60000)} minutes; stopping. Type respawn to override.` });
    }
    const decision = await this.decide(state);
    if (decision.type !== 'respawn') return this.report(decision);
    return this.report({ ...decision, ...await this.respawn() });
  }
  /** Presses respawn and verifies with the client, not with the fact that the request was accepted. */
  async respawn() {
    const fresh = await this.bridge.state();
    if (!fresh.canRespawn) return { type: 'wait', result: 'blocked', why: 'Death screen closed before the request went out' };
    const requestedAt = Date.now();
    const id = randomUUID();
    await this.bridge.respawn(fresh, id);
    this.respawns.push(requestedAt);
    const deadline = requestedAt + this.verifyMs;
    while (Date.now() < deadline) {
      const state = await this.bridge.state();
      if (state.lastRespawnAt > requestedAt && !state.dead && state.online) {
        this.emit({ kind: 'respawned', id, message: `Respawned at ${Math.round(state.x)}, ${Math.round(state.y)}, ${Math.round(state.z)}. The previous goal was not resumed.`, state });
        return { type: 'respawn', result: 'succeeded', id, x: state.x, y: state.y, z: state.z };
      }
      await delay(300);
    }
    return { type: 'respawn', result: 'unverified', id, why: 'Respawn accepted but no live player observed within the deadline' };
  }
  report(decision) {
    this.emit({ kind: 'recovery', message: `Death decision: ${decision.type}${decision.result ? ` (${decision.result})` : ''} — ${decision.why ?? ''}`, decision });
    return decision;
  }
}
