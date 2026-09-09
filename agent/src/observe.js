/**
 * Turns a client observation into the compact text a planner reads.
 *
 * Deliberately lossy and ordered: nearest hostiles first, then everything else. A planner
 * that only reads the first line must still see the thing that is about to hit us.
 */
export const STALE_MS = 1000;

export function threats(observation, radius = 16) {
  return (observation.entities ?? []).filter(e => e.hostile && e.distance <= radius).sort((a, b) => a.distance - b.distance);
}
export function isStale(observation, now = Date.now()) {
  return !observation.observedAt || now - observation.observedAt > STALE_MS;
}
const round = (n, places = 0) => Number.isFinite(n) ? Number(n.toFixed(places)) : null;
const short = name => String(name).replace(/^minecraft:/, '');
const near = (entity, unit = 'm') => `${short(entity.type)} ${round(entity.distance, 1)}${unit}`;

export function describe(observation, { radius = 32, maxEntities = 8 } = {}) {
  if (!observation?.online) return 'No world connected.';
  const self = observation.self ?? {};
  const lines = [];
  lines.push(`at ${round(self.x)},${round(self.y)},${round(self.z)} facing ${round(self.yaw)} | health ${round(self.health, 1)}/${round(self.maxHealth)} food ${self.food} | light ${observation.light} (sky ${observation.skyLight})`
    + [self.inWater && 'in water', self.onFire && 'ON FIRE', !self.onGround && 'airborne', observation.thundering ? 'thundering' : observation.raining && 'raining'].filter(Boolean).map(s => ` | ${s}`).join(''));
  const inRange = (observation.entities ?? []).filter(e => e.distance <= radius);
  const hostile = inRange.filter(e => e.hostile);
  const rest = inRange.filter(e => !e.hostile);
  lines.push(hostile.length
    ? `hostiles (${hostile.length}): ` + hostile.slice(0, maxEntities).map(e => `${near(e)} ${round(e.health, 1)}/${round(e.maxHealth)}hp`).join(', ')
    : `hostiles: none within ${radius}m`);
  if (rest.length) lines.push(`other (${rest.length}): ` + rest.slice(0, maxEntities).map(e => near(e)).join(', '));
  const items = observation.inventory?.items ?? [];
  const held = items.find(i => i.slot === observation.inventory?.selectedSlot);
  lines.push(`inventory ${items.length}/${observation.inventory?.size ?? '?'} slots used, holding ${held ? `${held.count}x ${short(held.item)}` : 'nothing'}`
    + (items.length ? `: ${items.filter(i => i !== held).slice(0, 10).map(i => `${i.count}x ${short(i.item)}`).join(', ')}` : ''));
  if (isStale(observation)) lines.push(`STALE: observation is ${observation.ageMs}ms old`);
  return lines.join('\n');
}

/**
 * What changed over the recent past, in one line. This is the temporal perception every surveyed
 * system feeds its planner as a frame sequence; for a model that reasons in text, a trend over
 * twenty numbers carries more of the same signal than twenty images, and costs nothing to produce.
 */
export function trend(history) {
  const samples = (history?.samples ?? []).filter(s => s.online);
  if (samples.length < 2) return 'No history yet.';
  const first = samples[0], last = samples.at(-1);
  const seconds = Math.round((last.atMs - first.atMs) / 1000);
  const travelled = Math.hypot(last.x - first.x, last.z - first.z);
  const peakHostiles = samples.reduce((max, s) => Math.max(max, s.hostiles ?? 0), 0);
  const closest = samples.reduce((min, s) => Math.min(min, s.nearestHostile ?? Infinity), Infinity);
  const parts = [
    `last ${seconds}s: moved ${travelled.toFixed(0)} blocks`,
    `health ${round(first.health, 1)}→${round(last.health, 1)}`,
    `food ${first.food}→${last.food}`,
    `light ${first.light}→${last.light}`,
    `inventory ${first.inventoryUsed}→${last.inventoryUsed} slots`
  ];
  if (peakHostiles) parts.push(`hostiles peaked at ${peakHostiles}, closest ${closest.toFixed(1)}m`);
  if (last.health < first.health) parts.push(`LOSING HEALTH (${round(first.health - last.health, 1)} lost)`);
  if (travelled < 1 && seconds > 5) parts.push('STATIONARY');
  return parts.join(' | ');
}
