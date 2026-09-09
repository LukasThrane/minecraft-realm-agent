import { catalog, itemId } from './crafting.js';

const naturalLogs = ['oak','birch','spruce','jungle','acacia','dark_oak','mangrove','cherry','pale_oak'].map(wood=>`minecraft:${wood}_log`);
const picks = ['minecraft:wooden_pickaxe','minecraft:stone_pickaxe','minecraft:iron_pickaxe','minecraft:diamond_pickaxe','minecraft:netherite_pickaxe'];
const preferred = ['minecraft:oak_planks','minecraft:cobblestone','minecraft:oak_log','minecraft:coal'];
const qualify = counts => Object.fromEntries(Object.entries(counts).map(([item,count])=>{
  if (!Number.isInteger(count) || count < 0) throw Error(`Invalid count for ${item}`);
  return [itemId(item),count];
}));

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

  plan(name, count = 1, inventory = {}, { stations = [], budget = 10000, maxDepth = 40 } = {}) {
    const normalized=itemId(name);
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
          if(method.kind==='smelt') grouped.set('fuel',{choices:['minecraft:coal'],quantity:Math.ceil(batches/8)});
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
      ensure(target,count);
      const projectedInventory=Object.fromEntries(Object.keys(state.lots).map(item=>[item,amount(item)]).filter(([,quantity])=>quantity>0));
      for(const item of Object.keys(state.tools)) projectedInventory[item]=(projectedInventory[item]??0)+1;
      return {status:'planned',goal:{type:'obtain',item:target,count},nodes:state.nodes,rootDependencies:deps(target),
        initialInventory:initial,projectedInventory,stations:state.stations,
        summary:state.nodes.filter(node=>node.kind==='gather').reduce((totals,node)=>({...totals,[node.item]:(totals[node.item]??0)+node.count}),{}),
        executable:false,remainingSearchBudget:remaining,limitations:['Plan only: live skill executors not yet wired','No optimality guarantee; ordered bounded backtracking','Ore discovery, access and tool durability require execution-time checks','Fuel: coal, eight furnace operations per item, assumes one continuous batch','Vanilla 26.2 recipes; server datapacks may differ']};
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
