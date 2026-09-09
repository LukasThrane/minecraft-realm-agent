import { readFileSync } from 'node:fs';

export const catalog = JSON.parse(readFileSync(new URL('../../config/recipes-26.2.json', import.meta.url)));
export const itemId = name => name.includes(':') ? name : `minecraft:${name.trim().toLowerCase().replaceAll(' ', '_')}`;

export function inventoryDict(observation) {
  if (!observation.online || !observation.fresh || Date.now() - observation.observedAt > 2000) throw Error('Inventory observation unavailable or stale');
  const counts = {};
  for (const entry of observation.inventory?.items ?? []) {
    if (!Number.isInteger(entry.count) || entry.count < 1) throw Error('Invalid inventory count');
    counts[entry.item] = (counts[entry.item] ?? 0) + entry.count;
  }
  return counts;
}

export function consume(recipe, counts, budget) {
  const slots = [...recipe.slots].sort((left, right) => left.length - right.length);
  const results = [];
  function choose(index, available, used) {
    if (--budget.remaining < 0) { budget.truncated = true; return; }
    if (index === slots.length) {
      const after = { ...available };
      after[recipe.output] = (after[recipe.output] ?? 0) + recipe.count;
      results.push({ after, used });
      return;
    }
    for (const item of slots[index]) {
      if (!(available[item] > 0)) continue;
      choose(index + 1, { ...available, [item]: available[item] - 1 }, { ...used, [item]: (used[item] ?? 0) + 1 });
    }
  }
  choose(0, counts, {});
  return results;
}

function key(counts) {
  return JSON.stringify(Object.entries(counts).filter(([, count]) => count > 0).sort(([left], [right]) => left.localeCompare(right)));
}

export function craftable(counts, { recipes = catalog.recipes, depth = 2, operations = 250000, tableAvailable = false } = {}) {
  if (![1, 2].includes(depth)) throw Error('Crafting preview supports one or two steps');
  const budget = { remaining: operations, truncated: false };
  let frontier = [{ counts, steps: [] }];
  const visited = new Set([key(counts)]);
  const outputs = new Map();
  for (let level = 0; level < depth && frontier.length && !budget.truncated; level++) {
    const next = [];
    for (const state of frontier) {
      for (const recipe of recipes) {
        if (budget.truncated) break;
        if (recipe.slots.some(slot => !slot.some(item => state.counts[item] > 0))) continue;
        for (const { after, used } of consume(recipe, state.counts, budget)) {
          const steps = [...state.steps, { recipe: recipe.id, output: recipe.output, count: recipe.count, station: recipe.station, consumes: used }];
          const needsTable = steps.some(step => step.station === 'crafting_table');
          const previous = outputs.get(recipe.output);
          if (!previous || (previous.requiresCraftingTable && !needsTable)) {
            outputs.set(recipe.output, { item: recipe.output, produced: recipe.count, steps,
              requiresCraftingTable: needsTable, executableWithKnownStations: !needsTable || tableAvailable });
          }
          const identity = key(after);
          if (!visited.has(identity)) { visited.add(identity); next.push({ counts: after, steps }); }
        }
      }
    }
    frontier = next;
  }
  return { source: catalog.source, maxSteps: depth, complete: !budget.truncated,
    craftable: [...outputs.values()] };
}

export function canCraft(name, counts, options = {}) {
  if (typeof name !== 'string' || !name.trim()) throw Error('Specify an item, for example can-craft diamond sword');
  const target = itemId(name);
  const recipes = options.recipes ?? catalog.recipes;
  const relevant = new Set([target]);
  for (let depth = 0; depth < 2; depth++) {
    for (const recipe of recipes.filter(recipe => relevant.has(recipe.output))) {
      for (const slot of recipe.slots) for (const item of slot) relevant.add(item);
    }
  }
  const result = craftable(counts, { ...options, recipes: recipes.filter(recipe => relevant.has(recipe.output)) });
  const plan = result.craftable.find(entry => entry.item === target);
  const candidates = recipes.filter(recipe => recipe.output === target);
  return { target, owned: counts[target] ?? 0, canCraftFromMaterials: plan ? true : result.complete && candidates.length ? false : null,
    canCraftWithKnownStations: plan?.executableWithKnownStations ?? false,
    plan: plan ?? null, complete: result.complete,
    reason: plan ? 'Plan found' : !candidates.length ? 'Recipe unsupported or unknown' : !result.complete ? 'Search budget exhausted' : 'No plan within two crafting operations',
    requirements: candidates.map(recipe => ({ recipe: recipe.id, station: recipe.station, outputCount: recipe.count,
      ingredientSlots: recipe.slots.map(alternatives => ({ alternatives, available: Object.fromEntries(alternatives.map(item => [item, counts[item] ?? 0])) })) })) };
}

export class CraftingTools {
  constructor(bridge) { this.bridge = bridge; }
  async inventory() {
    const observation = await this.bridge.observe();
    const items = inventoryDict(observation);
    const craftingItems = inventoryDict({ ...observation, inventory: { items: observation.inventory.items.filter(entry => entry.slot >= 0 && entry.slot < 36) } });
    return { observedAt: observation.observedAt, session: observation.session, items, craftingItems };
  }
  async craftable() { const inventory = await this.inventory(); return { ...inventory, ...craftable(inventory.craftingItems) }; }
  async canCraft(item) { const inventory = await this.inventory(); return { ...inventory, ...canCraft(item, inventory.craftingItems) }; }
}
