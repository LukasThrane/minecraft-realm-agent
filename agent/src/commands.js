const DIRECTIONS = ['forward','back','left','right'];
export const FAILURES = ['no_progress','deadline','precondition','interrupted','takeover','assumption_violated','controller_error','safety_preempted'];
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
/** Block modification is the only thing in the build scope, and the bridge refuses it off singleplayer. */
export function scopeFor(action) { return ['break','place'].includes(action.type) ? 'build' : 'travel'; }
/** Deadlines are part of the action, not a caller convention: nothing runs unbounded. */
export function deadlineFor(action) {
  switch (action.type) {
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
