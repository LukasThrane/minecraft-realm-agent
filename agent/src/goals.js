import { itemId } from './crafting.js';

/**
 * What the agent is trying to get done, in the order it intends to do it.
 *
 * This exists because a run used to hold exactly one goal string, so every new instruction
 * replaced the last one and a finished goal left nothing behind. The operator asking for diamond
 * gear mid-run threw away the pickaxe chain; a completed goal left the model answering "already
 * obtained" every ten seconds with nothing queued behind it. A queue makes both ordinary: the
 * overseer adds what it decides to pursue, urgency decides what runs first, and the deterministic
 * layer starts the next one without asking anybody.
 */
export const URGENT = 0, NORMAL = 5, BACKGROUND = 9;

export class Goals {
  constructor() { this.items = []; this.seq = 0; }

  /** Adding the same item twice raises the count and the urgency rather than queueing it twice. */
  add({ item, count = 1, priority = NORMAL, why = '', source = 'agent' }) {
    const id = itemId(String(item));
    const bounded = Math.min(9, Math.max(0, Math.round(priority)));
    const open = this.items.find(goal => goal.item === id && goal.status === 'pending');
    if (open) {
      open.count = Math.max(open.count, count);
      open.priority = Math.min(open.priority, bounded);
      if (why) open.why = why;
      return open;
    }
    const goal = { id: ++this.seq, item: id, count, priority: bounded, why, source, status: 'pending', added: Date.now() };
    this.items.push(goal);
    return goal;
  }

  /** Most urgent first; among equals, whatever was asked for first. */
  pending() {
    return this.items.filter(goal => goal.status === 'pending')
      .sort((left, right) => left.priority - right.priority || left.added - right.added || left.id - right.id);
  }
  next() { return this.pending()[0] ?? null; }
  find(id) { return this.items.find(goal => goal.id === id) ?? null; }
  complete(goal) { if (goal) { goal.status = 'complete'; goal.endedAt = Date.now(); } }
  fail(goal, reason) { if (goal) { goal.status = 'failed'; goal.reason = reason; goal.endedAt = Date.now(); } }
  drop(id, why = '') {
    const goal = this.find(Number(id));
    if (!goal || goal.status !== 'pending') return null;
    goal.status = 'dropped'; goal.reason = why; goal.endedAt = Date.now();
    return goal;
  }

  /**
   * Retire goals we already satisfy. The planner answers this, not a string comparison, so
   * "3 diamonds" is met by three diamonds however they arrived.
   */
  prune(counts, planner) {
    const done = [];
    for (const goal of this.pending()) {
      try {
        const plan = planner.plan(goal.item, goal.count, counts);
        if (plan.status === 'planned' && plan.nodes.length === 0) { this.complete(goal); done.push(goal); }
      } catch { /* something we cannot plan is not something we can call satisfied */ }
    }
    return done;
  }

  /** The queue as the overseer sees it, bounded so it cannot grow into the prompt. */
  summary() {
    return this.pending().slice(0, 8).map(goal =>
      `#${goal.id} ${goal.count} ${goal.item} (priority ${goal.priority}${goal.why ? `, ${goal.why}` : ''})`);
  }
  recent(limit = 5) {
    return this.items.filter(goal => goal.status !== 'pending').slice(-limit)
      .map(goal => `#${goal.id} ${goal.count} ${goal.item}: ${goal.status}${goal.reason ? ` (${goal.reason})` : ''}`);
  }
}
