import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { catalog, CraftingTools } from './crafting.js';
import { Attempts, deadlineFor, disposition, scopeFor, validateAction, validateAssumptions } from './commands.js';
import { DependencyPlanner } from './dependencies.js';

/**
 * What a skill is allowed to assume about the world while it runs.
 *
 * The client re-checks these every tick and voids the action the moment one stops holding, so a
 * four-minute mining trip no longer keeps digging through a fight it is losing. The floor is
 * derived from health at dispatch rather than fixed, because a fixed one would either void
 * instantly when the goal is issued at two hearts or never bind at all.
 *
 * Deliberately not `holding`: Baritone's automatic tool selection changes the held item during a
 * gather, so asserting it would void every mining action within a second of starting one.
 */
export function assumptionsFor(action, state) {
  const health = Number.isFinite(state?.health) ? state.health : null;
  if (health === null || action.kind === 'craft') return undefined;
  return { minHealth: Math.max(1, Math.min(6, Math.floor(health) - 2)) };
}

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
  constructor(bridge, emit=console.log, { attempts=new Attempts(), maxPreemptions=5 }={}) {
    this.bridge=bridge;this.emit=emit;this.inventory=new CraftingTools(bridge);this.planner=new DependencyPlanner();
    // Outlives one goal on purpose: retyping a command that has failed the same way three times
    // should say so, not walk the same broken route again.
    this.attempts=attempts;
    // A reflex may interrupt the work; it may not become the work. Past this cap the honest
    // conclusion is not that the step is wrong but that the place is, and that is worth saying.
    this.maxPreemptions=maxPreemptions;
  }
  async action(rawAction, authority, signal) {
    // Skills used to be the one action type that reached the client without host-side validation,
    // a policy scope or a deadline of its own. They go through the same envelope as everything
    // else now, so a malformed grid is refused here rather than becoming a bridge 400 mid-goal.
    const action=validateAction(rawAction);
    const deadlineMs=deadlineFor(action);
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
    await this.bridge.act(action,state,id,deadlineMs,scopeFor(action),validateAssumptions(assumptionsFor(action,state)));
    const deadline=Date.now()+deadlineMs+5000;
    while(Date.now()<deadline) {
      check();
      await this.bridge.lease(authority);
      await delay(200,undefined,{signal});state=await this.bridge.state();check();
      if(state.outcome?.actionId===id) {
        if(state.outcome.status!=='succeeded') {
          // Carry the typed failure alongside the text: free text cannot be matched later.
          const error=Error(state.outcome.reason);
          error.failure=state.outcome.failure ?? state.failure ?? 'controller_error';
          throw error;
        }
        this.emit(state.outcome.reason);return;
      }
    }
    const expired=Error('Skill deadline exceeded');expired.failure='deadline';throw expired;
  }
  async run(goal, signal) {
    const authority=await this.bridge.state();
    if(authority.skillsVersion!==2) throw Error('Client skills unavailable or out of date. Run ./windove build and restart Minecraft.');
    if(authority.acting || authority.pendingActionId) throw Error('Stop the current action before starting a skill goal');
    // The client remembers stations by position now, so the snapshot is the authority. This used
    // to be cleared and refilled from a scan around the player, which meant a table we had just
    // placed stopped existing as soon as a gather walked us out of its radius, and the very next
    // plan cheerfully built another one.
    //
    // Stations deployed during this run stay in the union anyway. If one really is gone the next
    // craft fails as `station_missing` with a position, which is a better answer than quietly
    // spending two more logs to duplicate something we already own.
    const deployed=new Set();
    let stations=[], preemptions=0;
    for(let step=0;step<128;step++) {
      signal.throwIfAborted();
      const snapshot=await this.inventory.inventory();
      if(snapshot.session!==authority.session) throw Error('World changed; goal cancelled');
      stations=[...new Set([...(snapshot.stations??[]).filter(station=>['crafting_table','furnace'].includes(station)),...deployed])];
      const plan=this.planner.plan(goal.item,goal.count,snapshot.craftingItems,{stations});
      if(plan.status!=='planned') throw Error(plan.reason);
      const node=plan.nodes[0];
      if(!node) {this.emit(`Goal verified: ${goal.count} ${plan.goal.item}`);return;}
      const action=node.kind==='craft'?craftAction(node,snapshot.craftingItems):{
        type:'skill',kind:node.kind,item:node.item??`minecraft:${node.station}`,count:node.count??1,blocks:node.blocks??[],tool:node.tool??null
      };
      if(node.kind==='smelt') action.count=Math.min(action.count,8);
      const banned=this.attempts.banned(action);
      if(banned) throw Error(`Refusing to repeat a known failure: ${banned}. Change the situation or type stop.`);
      this.emit(`${node.kind}: ${action.count} ${action.item}`);
      try { await this.action(action,authority,signal); }
      catch(error) {
        // The body dealt with something and is fine. The objective was never the problem, so it is
        // not recorded as a failure of this step, and the next loop replans from a fresh
        // observation -- which is the resume, because progress for these jobs is the inventory.
        if(disposition(error.failure)==='resume' && ++preemptions<=this.maxPreemptions) {
          this.emit(`Interrupted by the safety tier (${error.message}); resuming ${node.kind} ${action.item}`);
          continue;
        }
        if(error.failure) this.attempts.record(action,error.failure);
        if(disposition(error.failure)==='resume')
          throw Error(`Interrupted ${preemptions-1} times by safety reflexes; this area is not safe enough to work in`);
        throw error;
      }
      this.attempts.record(action,'');
      if(node.kind==='deploy_station') deployed.add(node.station);
    }
    throw Error('Goal exceeded 128 skill steps');
  }
}
