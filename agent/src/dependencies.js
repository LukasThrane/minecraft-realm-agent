import { catalog, itemId } from './crafting.js';

const naturalLogs = ['oak','birch','spruce','jungle','acacia','dark_oak','mangrove','cherry','pale_oak'].map(wood=>`minecraft:${wood}_log`);
const picks = ['minecraft:wooden_pickaxe','minecraft:stone_pickaxe','minecraft:iron_pickaxe','minecraft:diamond_pickaxe','minecraft:netherite_pickaxe'];
/**
 * Fuels the executor knows how to burn, as [item, items smelted per unit, spare kept back].
 * Ordered by preference: things that are only fuel first, wood last because it is usually wanted
 * for something else.
 */
const FUELS = [['minecraft:coal',8,0],['minecraft:charcoal',8,0],['minecraft:coal_block',80,0],
  ['minecraft:oak_log',1.5,2],['minecraft:birch_log',1.5,2],['minecraft:spruce_log',1.5,2],
  ['minecraft:oak_planks',1.5,4],['minecraft:birch_planks',1.5,4],['minecraft:spruce_planks',1.5,4]];
const ORE_DROPS = {
  'minecraft:iron_ore':'minecraft:raw_iron', 'minecraft:deepslate_iron_ore':'minecraft:raw_iron',
  'minecraft:raw_iron_block':'minecraft:raw_iron',
  'minecraft:gold_ore':'minecraft:raw_gold', 'minecraft:deepslate_gold_ore':'minecraft:raw_gold',
  'minecraft:copper_ore':'minecraft:raw_copper', 'minecraft:deepslate_copper_ore':'minecraft:raw_copper',
  'minecraft:coal_ore':'minecraft:coal', 'minecraft:deepslate_coal_ore':'minecraft:coal',
  'minecraft:diamond_ore':'minecraft:diamond', 'minecraft:deepslate_diamond_ore':'minecraft:diamond',
  'minecraft:stone':'minecraft:cobblestone'
};
const preferred = ['minecraft:oak_planks','minecraft:cobblestone','minecraft:oak_log','minecraft:coal'];
const qualify = counts => Object.fromEntries(Object.entries(counts).map(([item,count])=>{
  if (!Number.isInteger(count) || count < 0) throw Error(`Invalid count for ${item}`);
  return [itemId(item),count];
}));

/**
 * Gather what the plan needs in one trip instead of one item at a time.
 *
 * Backward chaining ensures each requirement as it meets it, so three separate needs for planks
 * produce three separate `gather 1 oak_log` nodes. The plan already knew the total -- it printed
 * `oak_log: 3` in its own summary -- and then walked to a tree three times anyway. Live, that is
 * the agent mining one log, crafting, finding another tree, mining one log, and so on.
 *
 * Only nodes with identical dependencies merge. That is what makes it safe rather than merely
 * convenient: keeping the dependency set unchanged cannot introduce an edge into the merged node's
 * own past, so no ordering that was legal before becomes a cycle. Two cobblestone gathers that both
 * wait on the same wooden pickaxe merge; a gather that waits on a tool made from an earlier gather
 * of the same item does not.
 */
export function mergeGathers(nodes) {
  const first = new Map(), replaced = new Map();
  for (const node of nodes) {
    if (node.kind !== 'gather') continue;
    const key = JSON.stringify([node.item, node.tool ?? null, node.blocks ?? [], [...node.dependsOn].sort()]);
    const target = first.get(key);
    if (!target) { first.set(key, node); continue; }
    target.count += node.count;
    target.batches += node.batches;
    target.produces = { ...target.produces, [target.item]: (target.produces[target.item] ?? 0) + node.count };
    target.verification = `Observe ${target.count} additional ${target.item} in inventory`;
    replaced.set(node.id, target.id);
  }
  if (!replaced.size) return { nodes, rename: id => id };
  const kept = nodes.filter(node => !replaced.has(node.id));
  const follow = id => replaced.get(id) ?? id;
  // Renumber so the preview reads as a sequence rather than one with holes in it.
  const renumber = new Map(kept.map((node, index) => [node.id, `step-${index + 1}`]));
  const rename = id => renumber.get(follow(id)) ?? follow(id);
  for (const node of kept) node.dependsOn = [...new Set(node.dependsOn.map(rename))].filter(id => id !== renumber.get(node.id));
  for (const node of kept) node.id = renumber.get(node.id);
  return { nodes: kept, rename };
}

export class DependencyPlanner {
  constructor(recipes = catalog.recipes) {
    this.byOutput = new Map();
    for (const recipe of recipes) {
      const methods=this.byOutput.get(recipe.output) ?? [];
      methods.push({ ...recipe, kind:'craft' });
      this.byOutput.set(recipe.output,methods);
    }
    this.methodCache = new Map();
  }

  methods(item) {
    if (this.methodCache.has(item)) return this.methodCache.get(item);
    const methods=[...(this.byOutput.get(item) ?? [])];
    if (naturalLogs.includes(item) || item==='minecraft:dirt') methods.push({id:`gather:${item}`,kind:'gather',output:item,count:1,slots:[],blocks:[item]});
    const mining={
      'minecraft:cobblestone':{blocks:['minecraft:stone','minecraft:cobblestone'],tier:0},
      'minecraft:coal':{blocks:['minecraft:coal_ore'],tier:0},
      'minecraft:raw_iron':{blocks:['minecraft:iron_ore','minecraft:deepslate_iron_ore'],tier:1},
      'minecraft:diamond':{blocks:['minecraft:diamond_ore','minecraft:deepslate_diamond_ore'],tier:2}
    }[item];
    if (mining) methods.push({id:`gather:${item}`,kind:'gather',output:item,count:1,slots:[],...mining});
    if (item==='minecraft:iron_ingot') methods.push({id:'smelt:raw_iron',kind:'smelt',output:item,count:1,station:'furnace',slots:[['minecraft:raw_iron']]});
    this.methodCache.set(item,methods);
    return methods;
  }

  planMany(targets, inventory = {}, options = {}) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 32) throw Error('Need 1..32 targets');
    const normalized = targets.map(entry => ({item:itemId(entry.item),count:entry.count}));
    if (new Set(normalized.map(t => t.item)).size !== normalized.length) throw Error('Combine duplicate targets into one total');
    return {...this.plan(normalized[0].item, normalized[0].count, inventory, {...options,targets:normalized}), targets:normalized};
  }

  plan(name, count = 1, inventory = {}, { stations = [], budget = 10000, maxDepth = 40, targets = null } = {}) {
    // "obtain iron_ore" means the iron. Asking for the block is what the model naturally says, and
    // refusing it with "no supported acquisition method" sent a run in circles for four minutes.
    const asked=itemId(name);
    const normalized=ORE_DROPS[asked] ?? asked;
    const target=normalized==='minecraft:logs' || normalized==='minecraft:log'?
      (Object.keys(inventory).map(itemId).find(item=>naturalLogs.includes(item)) ?? 'minecraft:oak_log'):normalized==='minecraft:cobble'?'minecraft:cobblestone':normalized==='minecraft:sticks'?'minecraft:stick':normalized==='minecraft:planks'?
      (Object.keys(inventory).map(itemId).find(item=>item.endsWith('_planks') || item.endsWith('_log'))?.replace(/_log$/,'_planks') ?? 'minecraft:oak_planks'):normalized;
    if (!Number.isInteger(count) || count < 1 || count > 256) throw Error('Goal count must be 1..256');
    const initial=qualify(inventory);
    let state={lots:Object.fromEntries(Object.entries(initial).map(([item,quantity])=>[item,[{count:quantity,producer:null}]])),nodes:[],stations:Object.fromEntries(stations.map(station=>[station,null])),tools:{}};
    let remaining=budget;
    const amount=item=>(state.lots[item] ?? []).reduce((sum,lot)=>sum+lot.count,0);
    const deps=item=>[...new Set((state.lots[item] ?? []).filter(lot=>lot.count>0 && lot.producer).map(lot=>lot.producer))];
    const take=(item,quantity)=>{
      if(amount(item)<quantity) throw Error(`Insufficient ${item}`);
      const sources=[];
      for(const lot of state.lots[item] ?? []) {
        const used=Math.min(quantity,lot.count);
        if(used>0 && lot.producer) sources.push(lot.producer);
        lot.count-=used;quantity-=used;
      }
      return sources;
    };
    const add=node=>{
      const complete={id:`step-${state.nodes.length+1}`,status:'planned',...node,dependsOn:[...new Set(node.dependsOn ?? [])]};
      state.nodes.push(complete);
      return complete.id;
    };
    const useStation=(station,path)=>{
      if(station==='inventory' || !station) return [];
      if(Object.hasOwn(state.stations,station)) return state.stations[station]?[state.stations[station]]:[];
      const item=`minecraft:${station}`;
      ensure(item,1,path);
      const consumed=take(item,1);
      const id=add({kind:'deploy_station',station,consumes:{[item]:1},produces:{},dependsOn:consumed,
        verification:'Station block observed and its menu accessible'});
      state.stations[station]=id;
      return [id];
    };
    const usePick=(tier,path)=>{
      const allowed=picks.slice(tier);
      let item=allowed.find(candidate=>state.tools[candidate] || amount(candidate)>0);
      item ??= allowed[0];
      if(!state.tools[item]) {
        ensure(item,1,path);
        state.tools[item]={dependsOn:take(item,1)};
      }
      return {item,dependsOn:state.tools[item].dependsOn};
    };
    const rankAlternative=(left,right)=>{
      const present=(amount(right)>0)-(amount(left)>0);
      if(present) return present;
      const rank=item=>preferred.includes(item)?preferred.indexOf(item):100;
      return rank(left)-rank(right) || left.localeCompare(right);
    };
    const ensure=(item,quantity,path=[])=>{
      if(--remaining<0) throw Error('Planning search budget exhausted');
      if(amount(item)>=quantity) return;
      if(path.includes(item)) throw Error(`Dependency cycle: ${[...path,item].join(' -> ')}`);
      if(path.length>=maxDepth) throw Error('Dependency depth limit reached');
      const nextPath=[...path,item];
      const methods=[...this.methods(item)].sort((left,right)=>{
        const immediate=method=>method.slots.length>0 && method.slots.every(slot=>slot.some(candidate=>amount(candidate)>0));
        return Number(immediate(right))-Number(immediate(left)) || ({gather:0,smelt:1,craft:2}[left.kind]-{gather:0,smelt:1,craft:2}[right.kind]);
      });
      const errors=[];
      for(const method of methods) {
        const saved=structuredClone(state);
        try {
          const batches=Math.ceil((quantity-amount(item))/method.count);
          const dependencies=useStation(method.station,nextPath);
          let tool;
          if(method.tier!==undefined) {
            const required=usePick(method.tier,nextPath);tool=required.item;dependencies.push(...required.dependsOn);
          }
          const consumes={};
          const grouped=new Map();
          for(const slot of method.slots) {
            const key=JSON.stringify(slot);
            const group=grouped.get(key) ?? {choices:slot,quantity:0};
            group.quantity+=batches;grouped.set(key,group);
          }
          if(method.kind==='smelt') {
            // Coal is not the only thing that burns. Spend fuel we already carry when there is
            // clearly enough of it, and only plan to go and mine coal when there is not. The
            // margin keeps a plan from burning the planks it is about to need for a handle.
            const held=FUELS.find(([fuel,per,margin])=>amount(fuel)>=Math.ceil(batches/per)+margin);
            grouped.set('fuel',held?{choices:[held[0]],quantity:Math.ceil(batches/held[1])}
              :{choices:['minecraft:coal','minecraft:charcoal'],quantity:Math.ceil(batches/8)});
          }
          for(const group of grouped.values()) {
            let needed=group.quantity;
            for(const candidate of [...group.choices].sort(rankAlternative)) {
              const used=Math.min(needed,amount(candidate));
              if(used) {dependencies.push(...take(candidate,used));consumes[candidate]=(consumes[candidate]??0)+used;needed-=used;}
              if(!needed) break;
            }
            if(needed) {
              let resolved=false;
              for(const candidate of [...group.choices].sort(rankAlternative)) {
                const alternativeState=structuredClone(state);
                try {
                  ensure(candidate,needed,nextPath);
                  dependencies.push(...take(candidate,needed));consumes[candidate]=(consumes[candidate]??0)+needed;
                  resolved=true;break;
                } catch(error) {state=alternativeState;if(remaining<0) throw error;}
              }
              if(!resolved) throw Error(`No source for ingredient alternatives: ${group.choices.join(', ')}`);
            }
          }
          const produced=batches*method.count;
          const id=add({kind:method.kind,method:method.id,item,count:produced,batches,consumes,produces:{[item]:produced},station:method.station ?? null,
            tool:tool ?? null,blocks:method.blocks ?? [],dependsOn:dependencies,
            verification:`Observe ${produced} additional ${item} in inventory`,
            assumptions:method.kind==='gather'?['Find reachable exposed blocks','Revalidate tool harvest capability and durability','Observe drops picked up']:['Recipe and menu match current server']});
          state.lots[item] ??= [];state.lots[item].push({count:produced,producer:id});
          return;
        } catch(error) {state=saved;errors.push(error.message);if(remaining<0) throw error;}
      }
      throw Error(`Cannot obtain ${item}: ${errors[0] ?? 'no supported acquisition method'}`);
    };
    try {
      const wanted = targets ?? [{item:target,count}];
      const reserved = {}, roots = [];
      // Final outputs are reserved before later targets consume resources. Tool reservations
      // remain reusable as tools, so an explicitly requested pickaxe is not crafted twice.
      for (const entry of wanted) {
        const item = itemId(entry.item), quantity = entry.count;
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 256) throw Error('Target count must be 1..256');
        const needed = Math.max(0, quantity - (state.tools[item] ? 1 : 0));
        ensure(item, needed);
        roots.push(...deps(item));
        if (picks.includes(item) && !state.tools[item]) {
          state.tools[item] = { dependsOn: take(item, 1) };
          if (needed > 1) { take(item, needed - 1); reserved[item] = needed - 1; }
        } else { take(item, needed); reserved[item] = (reserved[item] ?? 0) + needed; }
      }
      for (const [item, quantity] of Object.entries(reserved)) {
        state.lots[item] ??= []; state.lots[item].push({count:quantity,producer:null});
      }
      const projectedInventory=Object.fromEntries(Object.keys(state.lots).map(item=>[item,amount(item)]).filter(([,quantity])=>quantity>0));
      for(const item of Object.keys(state.tools)) projectedInventory[item]=(projectedInventory[item]??0)+1;
      const {nodes,rename}=mergeGathers(state.nodes);
      return {status:'planned',goal:{type:'obtain',item:target,count},nodes,rootDependencies:[...new Set(roots.map(rename))],
        initialInventory:initial,projectedInventory,stations:Object.fromEntries(Object.entries(state.stations).map(([station,id])=>[station,id?rename(id):id])),
        summary:nodes.filter(node=>node.kind==='gather').reduce((totals,node)=>({...totals,[node.item]:(totals[node.item]??0)+node.count}),{}),
        executable:false,remainingSearchBudget:remaining,limitations:['Plan only: live skill executors not yet wired','No optimality guarantee; ordered bounded backtracking','Ore discovery, access and tool durability require execution-time checks','Fuel: coal or charcoal at eight operations each, or wood already carried at 1.5; assumes one continuous batch','Vanilla 26.2 recipes; server datapacks may differ']};
    } catch(error) {return {status:remaining<0?'incomplete':'blocked',goal:{type:'obtain',item:target,count},nodes:[],reason:error.message,executable:false};}
  }
}

export function parseObtainGoal(text) {
  const match=text.trim().match(/^(?:(?:can|could) you\s+)?(?:please\s+)?(?:create|craft|make|obtain|plan|get|fetch|gather|collect)(?:\s+me)?\s+(?:(a|an|\d+)\s+)?([a-z_: ]+?)[?.!]?$/i);
  if(!match) return null;
  return {type:'obtain',item:itemId(match[2]),count:/^\d+$/.test(match[1]??'')?Number(match[1]):1};
}

export function formatDependencyPlan(plan) {
  if(plan.status!=='planned') return `${plan.status}: ${plan.reason}`;
  return [`Obtain ${plan.goal.count} ${plan.goal.item} — planning preview, not executing`,
    ...plan.nodes.map(node=>`${node.id}: ${node.kind} ${node.count ?? 1} ${node.item ?? node.station}${node.tool?` using ${node.tool}`:''} [after ${node.dependsOn.join(', ')||'inventory'}]`),
    `Gather totals: ${JSON.stringify(plan.summary)}`,`Projected remaining inventory: ${JSON.stringify(plan.projectedInventory)}`].join('\n');
}
