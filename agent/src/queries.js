import { CraftingTools } from './crafting.js';
import { DependencyPlanner, parseObtainGoal, formatDependencyPlan } from './dependencies.js';
import { describe, trend } from './observe.js';

/**
 * The commands that only look.
 *
 * They read the client and never touch action authority, so they are safe everywhere: during a
 * goal in the console, and during an autonomous run. That is the whole reason they are factored
 * out here. A run that refuses `/inventory` and `/plan` leaves the operator watching a chain of
 * skills with no way to see what it thinks it needs, which is not supervision.
 *
 * Every handler returns text rather than printing, so the caller decides where it goes -- the
 * console writes it straight out, a run has to redraw its prompt around it.
 */
export const READ_ONLY = new Set(['help', 'inventory', 'craftable', 'can-craft', 'plan', 'look', 'status', 'history', 'failures']);

export const QUERY_HELP = `Look, without disturbing anything:
  /inventory              aggregated counts, and the stations we know about
  /craftable              everything makeable in one or two operations
  /can-craft <item>       whether the materials are there, and what is missing
  /plan [n] <item>        the dependency plan, read-only
  /look [radius]          entities, vitals, light
  /status                 client state
  /history                what changed recently
  /failures               skill failures recorded this session`;

export function queries({ bridge, attempts = null, log = () => {} }) {
  const crafting = new CraftingTools(bridge);
  const planner = new DependencyPlanner();

  async function plan(text) {
    const goal = parseObtainGoal(`plan ${text}`);
    if (!goal) return `Not understood: "${text}". Try /plan iron pickaxe or /plan 12 dirt.`;
    try {
      const snapshot = await crafting.inventory();
      const result = planner.plan(goal.item, goal.count, snapshot.craftingItems, { stations: snapshot.stations ?? [] });
      log({ kind: 'dependency-plan', observedAt: snapshot.observedAt, session: snapshot.session, plan: result });
      return formatDependencyPlan(result);
    } catch (error) {
      const result = planner.plan(goal.item, goal.count, {});
      log({ kind: 'dependency-plan', offline: true, error: error.message, plan: result });
      return `Live inventory unavailable (${error.message}); showing an empty-inventory preview.\n${formatDependencyPlan(result)}`;
    }
  }

  return {
    handles: name => READ_ONLY.has(name),
    async run(name, rest = []) {
      const argument = rest.join(' ').trim();
      switch (name) {
        case 'help': return QUERY_HELP;
        case 'inventory': return JSON.stringify(await crafting.inventory(), null, 2);
        case 'craftable': return JSON.stringify(await crafting.craftable(), null, 2);
        case 'can-craft': return argument ? JSON.stringify(await crafting.canCraft(argument), null, 2) : 'Name an item: /can-craft diamond sword';
        case 'plan': return plan(argument);
        case 'status': return JSON.stringify(await bridge.state(), null, 2);
        case 'look': {
          const observation = await bridge.observe();
          log({ kind: 'observation', observation });
          return describe(observation, { radius: Number(rest[0]) || 32 });
        }
        case 'history': {
          const history = await bridge.history();
          log({ kind: 'history', history });
          return trend(history);
        }
        case 'failures': return attempts?.summary() || 'No skill failures recorded this session.';
        default: return `Unknown query: /${name}`;
      }
    }
  };
}
