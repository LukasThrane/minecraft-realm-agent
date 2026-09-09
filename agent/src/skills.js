import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { catalog, CraftingTools } from './crafting.js';
import { DependencyPlanner } from './dependencies.js';

export function craftAction(node, inventory) {
  const recipe=catalog.recipes.find(recipe=>recipe.id===node.method);
  if(!recipe?.grid) throw Error('Recipe lacks executable grid layout');
  if(!Number.isInteger(recipe.width) || recipe.width<1 || recipe.width>3 || recipe.grid.length===0 || recipe.grid.length%recipe.width!==0 || recipe.grid.length>9) throw Error('Recipe has invalid executable grid dimensions');
  const stock={...inventory};
  const grid=[];
  function allocate(index) {
    if(index===recipe.grid.length) return true;
    const alternatives=recipe.grid[index];
    if(!alternatives.length) {grid[index]='';return allocate(index+1);}
    for(const item of alternatives) if(stock[item]>0) {
      stock[item]--;grid[index]=item;
      if(allocate(index+1)) return true;
      stock[item]++;
    }
    return false;
  }
  if(!allocate(0)) throw Error('Recipe ingredients changed; cannot allocate grid');
  return {type:'skill',kind:'craft',item:recipe.output,count:recipe.count,station:recipe.station,width:recipe.width,grid};
}

export class SkillExecutor {
  constructor(bridge, emit=console.log) {
    this.bridge=bridge;this.emit=emit;this.inventory=new CraftingTools(bridge);this.planner=new DependencyPlanner();
  }
  async action(action, authority, signal) {
    let state=await this.bridge.state();
    const check=()=>{
      signal.throwIfAborted();
      if(state.session!==authority.session || state.epoch!==authority.epoch) throw Error('Control changed; goal cancelled');
    };
    const readyUntil=Date.now()+60000;
    if(!state.canAct) this.emit('Return to Minecraft and close the menu; waiting up to 60 seconds.');
    while(!state.canAct) {
      check();
      if(Date.now()>readyUntil) throw Error('Client not ready');
      await delay(200,undefined,{signal});state=await this.bridge.state();
    }
    check();
    const id=randomUUID();
    await this.bridge.act(action,state,id,120000,'build');
    const deadline=Date.now()+125000;
    while(Date.now()<deadline) {
      check();
      await this.bridge.lease(authority);
      await delay(200,undefined,{signal});state=await this.bridge.state();check();
      if(state.outcome?.actionId===id) {
        if(state.outcome.status!=='succeeded') throw Error(state.outcome.reason);
        this.emit(state.outcome.reason);return;
      }
    }
    throw Error('Skill deadline exceeded');
  }
  async run(goal, signal) {
    const authority=await this.bridge.state();
    if(authority.skillsVersion!==1) throw Error('Client skills unavailable. Run ./windove build and restart Minecraft.');
    if(authority.acting || authority.pendingActionId) throw Error('Stop the current action before starting a skill goal');
    const stations=new Set();
    for(let step=0;step<128;step++) {
      signal.throwIfAborted();
      const snapshot=await this.inventory.inventory();
      if(snapshot.session!==authority.session) throw Error('World changed; goal cancelled');
      if(Array.isArray(snapshot.stations)) {
        stations.clear();
        for(const station of snapshot.stations) if(['crafting_table','furnace'].includes(station)) stations.add(station);
      }
      const plan=this.planner.plan(goal.item,goal.count,snapshot.craftingItems,{stations:[...stations]});
      if(plan.status!=='planned') throw Error(plan.reason);
      const node=plan.nodes[0];
      if(!node) {this.emit(`Goal verified: ${goal.count} ${plan.goal.item}`);return;}
      const action=node.kind==='craft'?craftAction(node,snapshot.craftingItems):{
        type:'skill',kind:node.kind,item:node.item??`minecraft:${node.station}`,count:node.count??1,blocks:node.blocks??[],tool:node.tool??null
      };
      if(node.kind==='smelt') action.count=Math.min(action.count,8);
      this.emit(`${node.kind}: ${action.count} ${action.item}`);
      await this.action(action,authority,signal);
      if(node.kind==='deploy_station') stations.add(node.station);
    }
    throw Error('Goal exceeded 128 skill steps');
  }
}
