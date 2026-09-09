const DIRECTIONS = ['forward','back','left','right'];
export const FAILURES = ['no_progress','deadline','precondition','interrupted','takeover','assumption_violated','controller_error','safety_preempted'];
/**
 * What a typed failure means for the multi-step job that was running when it happened.
 *
 * The charter's rule is that maintenance interrupts objectives rather than replacing them: when a
 * reflex finishes eating or retreating, the interrupted work resumes with its progress intact. Only
 * `safety_preempted` means that, because only it says the body handled something and is now fine.
 * A takeover is the operator deciding, and every other class is the step itself having failed.
 *
 * Resuming is free for obtain-shaped jobs because their progress lives in the inventory, which is
 * world state: replanning from a fresh observation lands on the same next step by construction.
 */
export const RESUMABLE = new Set(['safety_preempted']);
export function disposition(failure) { return RESUMABLE.has(failure) ? 'resume' : 'abandon'; }
/**
 * The propositions a decision depended on. Bounds mirror Actions.java; the client re-checks them
 * every tick, so a decision dies when the world stops matching it rather than when a clock expires.
 */
export function validateAssumptions(assumes) {
  if (assumes === undefined) return undefined;
  if (!assumes || typeof assumes !== 'object' || Array.isArray(assumes)) throw Error('assumes must be an object');
  const checked = {};
  for (const [key, value] of Object.entries(assumes)) {
    if (key === 'minHealth') {
      if (!(Number.isFinite(value) && value >= 0 && value <= 1024)) throw Error('minHealth must be 0..1024');
      checked[key] = value;
    } else if (key === 'holding') {
      if (typeof value !== 'string' || !value) throw Error('holding must be an item id');
      checked[key] = value;
    } else if (key === 'maxHostilesWithin') {
      const { radius, count } = value ?? {};
      if (!(Number.isFinite(radius) && radius > 0 && radius <= 48)) throw Error('radius must be 0..48');
      if (!(Number.isInteger(count) && count >= 0)) throw Error('count must be a non-negative integer');
      checked[key] = { radius, count };
    } else throw Error(`Unknown assumption: ${key}`);
  }
  return Object.keys(checked).length ? checked : undefined;
}
/**
 * The build scope is where anything that can change the world runs. Skills belong to it because
 * they break and place blocks; mirroring `Actions.BUILD_TYPES` matters, because the client refuses
 * any envelope whose scope and type disagree.
 */
export function scopeFor(action) { return ['break','place','skill'].includes(action.type) ? 'build' : 'travel'; }
/**
 * How long each skill may run before the client calls it a `deadline` failure. Travel-and-mine is
 * bounded by Baritone's search and the walk home rather than by anything we can predict, so it
 * gets the widest window; a menu transaction that has not finished in a minute is stuck.
 */
export const SKILL_DEADLINES = { gather: 240_000, smelt: 180_000, craft: 60_000, deploy_station: 60_000 };
/** Deadlines are part of the action, not a caller convention: nothing runs unbounded. */
export function deadlineFor(action) {
  switch (action.type) {
    case 'skill': return SKILL_DEADLINES[action.kind] ?? 60_000;
    case 'navigate': return 180_000;
    case 'break': return action.ticks * 50 + 5_000;
    case 'move': return action.ticks * 50 + 3_000;
    case 'jump': return 5_000;
    case 'respawn': return 15_000;
    default: return 3_000;
  }
}
// Bounds mirror Actions.java. Both sides check, because neither may trust the other.
export function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw Error('Invalid action');
  if (['stop','status','respawn','jump','place'].includes(action.type)) return { type: action.type };
  if (action.type === 'break') {
    if (!Number.isInteger(action.ticks) || action.ticks < 1 || action.ticks > 200) throw Error('ticks must be an integer 1..200');
    return { type: 'break', ticks: action.ticks };
  }
  if (action.type === 'obtain') {
    // A job, not a client action: it expands into a chain of skills rather than reaching the tick.
    // The item is left as written so `stone pickaxe` and `minecraft:stone_pickaxe` both work; the
    // dependency planner owns that normalisation and rejects what it cannot plan.
    if (typeof action.item !== 'string' || !action.item.trim()) throw Error('obtain needs an item');
    if (!Number.isInteger(action.count) || action.count < 1 || action.count > 256) throw Error('obtain count must be an integer 1..256');
    return { type: 'obtain', item: action.item.trim(), count: action.count };
  }
  if (action.type === 'skill') return validateSkill(action);
  if (action.type === 'navigate') {
    if (![action.x, action.z].every(n => Number.isInteger(n) && Math.abs(n) <= 29_000_000)) throw Error('Coordinates must be integers inside world bounds');
    return { type: 'navigate', x: action.x, z: action.z };
  }
  if (action.type === 'move') {
    if (!DIRECTIONS.includes(action.direction)) throw Error('direction must be forward, back, left or right');
    if (!Number.isInteger(action.ticks) || action.ticks < 1 || action.ticks > 100) throw Error('ticks must be an integer 1..100');
    return { type: 'move', direction: action.direction, ticks: action.ticks };
  }
  if (action.type === 'look') {
    if (![action.yaw, action.pitch].every(Number.isFinite)) throw Error('yaw and pitch must be finite');
    if (Math.abs(action.yaw) > 360 || Math.abs(action.pitch) > 180) throw Error('yaw must be within 360 and pitch within 180 degrees');
    return { type: 'look', yaw: action.yaw, pitch: action.pitch, relative: Boolean(action.relative) };
  }
  if (action.type === 'select') {
    if (!Number.isInteger(action.slot) || action.slot < 0 || action.slot > 8) throw Error('slot must be a hotbar slot 0..8');
    return { type: 'select', slot: action.slot };
  }
  throw Error('Unsupported action type');
}
export function directCommand(text, site) {
  text = text.trim().toLowerCase();
  if (/^(stop|pause|halt|cancel|take over|\/stop)[.!]?$/.test(text)) return { type: 'stop' };
  if (/^(status|where|where am i|\/state)[?!.]?$/.test(text)) return { type: 'status' };
  if (/^(respawn|revive|get up|come back)[.!]?$/.test(text)) return { type: 'respawn' };
  if (/^(go|move|walk|travel)( to)?( the)? (site|base)[.!]?$/.test(text)) return { type: 'navigate', ...site };
  if (/^jump[.!]?$/.test(text)) return { type: 'jump' };
  if (/^place[.!]?$/.test(text)) return { type: 'place' };
  const dig = text.match(/^(?:break|mine|dig)(?:\s+(\d+))?[.!]?$/);
  if (dig) return validateAction({ type: 'break', ticks: Number(dig[1] ?? 100) });
  const direction = text.match(/^(forward|back|left|right)(?:\s+(\d+))?[.!]?$/);
  if (direction) return validateAction({ type: 'move', direction: direction[1], ticks: Number(direction[2] ?? 10) });
  const turn = text.match(/^turn\s+(-?\d+(?:\.\d+)?)[.!]?$/);
  if (turn) return validateAction({ type: 'look', yaw: Number(turn[1]), pitch: 0, relative: true });
  // 'face' not 'look': 'look' is already the read-only observation command in the console.
  const face = text.match(/^face\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)[.!]?$/);
  if (face) return validateAction({ type: 'look', yaw: Number(face[1]), pitch: Number(face[2]) });
  const slot = text.match(/^slot\s+([0-8])[.!]?$/);
  if (slot) return validateAction({ type: 'select', slot: Number(slot[1]) });
  const match = text.match(/^(?:go|goto|move|walk|travel)(?: to)?\s+(-?\d+)\s*[, ]\s*(-?\d+)[.!]?$/);
  return match ? validateAction({ type: 'navigate', x: Number(match[1]), z: Number(match[2]) }) : null;
}

export const SKILL_KINDS = ['gather','craft','deploy_station','smelt'];
const ID = /^minecraft:[a-z0-9_]+$/;

/**
 * Bounds mirror the `skill` case in Actions.java, for the same reason every other action's do:
 * neither side may trust the other. Until now skills were the one action type that reached the
 * client without passing through here at all, so a malformed grid was caught only after it had
 * already been dispatched — which is how a truncated recipe grid became a bridge 400 mid-goal.
 */
export function validateSkill(action) {
  const { kind, item, count } = action;
  if (!SKILL_KINDS.includes(kind)) throw Error(`skill kind must be one of ${SKILL_KINDS.join(', ')}`);
  if (typeof item !== 'string' || !ID.test(item)) throw Error('skill item must be a minecraft: id');
  if (!Number.isInteger(count) || count < 1 || count > 256) throw Error('skill count must be an integer 1..256');
  const checked = { type: 'skill', kind, item, count };
  if (kind === 'smelt' && (item !== 'minecraft:iron_ingot' || count > 8)) throw Error('Smelting supports 1..8 iron ingots');
  if (kind === 'gather') {
    const { blocks, tool } = action;
    if (!Array.isArray(blocks) || !blocks.length || blocks.length > 32) throw Error('gather needs 1..32 target blocks');
    if (!blocks.every(block => typeof block === 'string' && ID.test(block))) throw Error('gather blocks must be block ids');
    checked.blocks = [...blocks];
    if (tool !== null && tool !== undefined) {
      if (typeof tool !== 'string' || !ID.test(tool)) throw Error('gather tool must be an item id');
      checked.tool = tool;
    }
  }
  if (kind === 'craft') {
    const { station, width, grid } = action;
    if (!['inventory','crafting_table'].includes(station)) throw Error('craft station must be inventory or crafting_table');
    if (!Number.isInteger(width) || width < 1 || width > 3) throw Error('craft width must be an integer 1..3');
    if (!Array.isArray(grid) || !grid.length || grid.length > 9 || grid.length % width) throw Error('craft grid must be a rectangle of at most nine slots');
    if (!grid.every(slot => slot === '' || (typeof slot === 'string' && ID.test(slot)))) throw Error('craft grid slots must be empty or item ids');
    if (station === 'inventory' && (width > 2 || grid.length / width > 2)) throw Error('Grid exceeds the inventory crafting square');
    Object.assign(checked, { station, width, grid: [...grid] });
  }
  return checked;
}

/** Stable identity for an intended action, so repeats are recognisable across deliberations. */
export function signature(action) {
  if (!action || !action.type) return '';
  switch (action.type) {
    case 'navigate': return `navigate:${action.x},${action.z}`;
    case 'move': return `move:${action.direction}`;
    case 'select': return `select:${action.slot}`;
    case 'skill': return `skill:${action.kind}:${action.item}`;
    case 'obtain': return `obtain:${action.item}`;
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

export const GOAL_VERBS = new Set(['craft','get','gather','fetch','collect','make','obtain','create']);

/**
 * Which of the console's two input kinds a line is.
 *
 * Bare text is a goal that runs for minutes; `/word` is one immediate thing. The old console
 * inferred this from an ordered pile of patterns, so `craft 6 logs` executed and `fetch 6 logs`
 * fell through to the model as free text -- the same request, two behaviours, for no reason a
 * user could see. Stop needs no slash, because a safety command must never fail on syntax, and
 * `plan` is refused as a bare goal: it reads as an instruction, and a preview that starts mining
 * is the worst available misunderstanding.
 */
export function classify(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'empty' };
  const slashed = text.startsWith('/');
  const body = slashed ? text.slice(1).trim() : text;
  if (!body) return { kind: 'help' };
  // Checked before anything else, and on either spelling: stopping must not depend on syntax.
  if (/^(stop|cancel|halt)[.!]?$/i.test(body)) return { kind: 'stop' };
  if (!slashed) {
    if (/^plan\b/i.test(body)) return { kind: 'preview_only', text: body };
    return { kind: 'goal', text: body };
  }
  const [word = '', ...rest] = body.split(/\s+/);
  const name = word.toLowerCase();
  if (name === 'help') return { kind: 'help' };
  if (name === 'plan') return { kind: 'preview', text: rest.join(' ') };
  if (GOAL_VERBS.has(name)) return { kind: 'goal', text: body };
  return { kind: 'command', name, rest };
}
