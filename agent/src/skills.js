import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { catalog, CraftingTools, itemId } from './crafting.js';
import { Attempts, blameless, deadlineFor, disposition, scopeFor, validateAction, validateAssumptions } from './commands.js';
import { DependencyPlanner } from './dependencies.js';

/** Enough to answer "are we carrying anything to eat"; the client owns what is worth eating. */
const EDIBLE=/^minecraft:(cooked_\w+|bread|apple|golden_apple|carrot|golden_carrot|baked_potato|melon_slice|sweet_berries|glow_berries|beetroot|dried_kelp|beef|porkchop|mutton|chicken|rabbit|cod|salmon|pumpkin_pie|cookie)$/;

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
  constructor(bridge, emit=console.log, { attempts=new Attempts() }={}) {
    this.bridge=bridge;this.emit=emit;this.inventory=new CraftingTools(bridge);this.planner=new DependencyPlanner();
    // Outlives one goal on purpose: retyping a command that has failed the same way three times
    // should say so, not walk the same broken route again.
    this.attempts=attempts;
  }
  prepare(spec, current, previous) {
    const common = { objectiveId:spec.objectiveId, kind:spec.kind, why:spec.why, resumeAfterEating:spec.resumeAfterEating!==false };
    const integer = (n,min,max,label) => {if (!Number.isInteger(n) || n<min || n>max) throw Error(`${label} must be ${min}..${max}`);return n;};
    if (spec.kind==='obtain') {
      const plan=this.planner.planMany(spec.targets,current.inventory,{stations:current.observation.stations??[]});
      if (plan.status!=='planned') throw Error(plan.reason);
      return {...common,targets:plan.targets};
    }
    if (spec.kind==='gather') {
      const item=itemId(spec.item);const count=integer(spec.count,1,256,'count');
      const method=this.planner.methods(item).find(m=>m.kind==='gather');
      if (!method) throw Error('No gathering capability for '+item);
      // Floors exist so an expedition turns back before it starves, not so it can never leave.
      // Observed live: a respawned character with no food and hunger at seventeen could not start
      // any gather at all -- three refusals banned the attempt outright, and the run spent nine
      // minutes discovering that every remaining plan went through the same banned step.
      const carriesFood=Object.entries(current.inventory).some(([item,count])=>count>0 && EDIBLE.test(item));
      const limits={minFood:integer(spec.minFood??(carriesFood?18:0),0,20,'minFood'),
        minHealth:integer(spec.minHealth??(carriesFood?12:6),1,20,'minHealth'),
        minDurability:integer(spec.minDurability??10,1,100,'minDurability')};
      let destination;
      if (spec.returnTo) {
        destination=current.sites.find(site=>site.name===spec.returnTo);
        if (!destination) throw Error(`Unknown return site "${spec.returnTo}". Known: ${current.sites.map(site=>site.name).join(', ') || 'none recorded -- use remember_site, or omit returnTo to stay where the work is'}`);
      }
      return {...common,item,count,targetTotal:previous?.targetTotal??(current.inventory[item]??0)+count,...limits,
        ...(spec.returnTo?{returnTo:spec.returnTo,destination}: {})};
    }
    if (spec.kind==='eat') return {...common,targetFood:integer(spec.targetFood??20,1,20,'targetFood')};
    if (spec.kind==='equip') {
      if (typeof spec.item!=='string' || !current.inventory[itemId(spec.item)]) throw Error('Equipment item is not in inventory');
      return {...common,item:itemId(spec.item)};
    }
    if (spec.kind==='navigate') return {...common,...validateAction({type:'navigate',x:spec.x,z:spec.z})};
    if (spec.kind==='shaft') {
      const action=validateAction({type:'skill',kind:'shaft',item:'minecraft:cobblestone',count:spec.steps,direction:spec.direction,torchEvery:spec.torchEvery??6});
      return {...common,steps:action.count,direction:action.direction,torchEvery:action.torchEvery,
        origin:previous?.origin??{x:Math.floor(current.state.x),y:Math.floor(current.state.y),z:Math.floor(current.state.z)}};
    }
    throw Error('Unsupported task kind: '+spec.kind);
  }

  /** One explicitly authorized task. Safety suspension is returned to the agent, never auto-resumed. */
  async execute(spec, signal, progress = () => {}) {
    const authority=await this.bridge.state();
    for(let recoveries=0;;recoveries++) {
      signal.throwIfAborted();
      try {return await this.executeOnce(spec,signal,progress);}
      catch(error) {
        if(signal.aborted || !spec.resumeAfterEating || error.failure!=='safety_preempted' || !/\beat\b/.test(error.message) || spec.kind==='shaft' || recoveries>=3) throw error;
        progress({phase:'recovering',message:'Eating reflex paused this task; preserving its progress and waiting for safe clearance.'});
        await this.waitForEatingClearance(authority,spec,signal);
        progress({phase:'running',message:'Eating recovery cleared. Continuing the same authorized task from observed progress.'});
      }
    }
  }
  async waitForEatingClearance(authority,spec,signal) {
    let stableSince=0;
    const deadline=Date.now()+30000;
    while(Date.now()<deadline) {
      signal.throwIfAborted();const state=await this.bridge.state();
      const fail=message=>Object.assign(Error(message),{failure:'safety_preempted'});
      if(state.session!==authority.session || state.epoch!==authority.epoch || state.dead) throw Object.assign(Error('Control changed during recovery'),{failure:'control_changed'});
      if(state.onFire || state.inLava || state.contactHazard) throw fail('Hazard encountered; agent must reconsider this route');
      if(state.reflex && state.reflex!=='eat') throw fail('Recovery changed to '+state.reflex+'; agent review required');
      const safe=!state.reflex && state.canAct && !state.acting && !state.pendingActionId && state.health>=(spec.minHealth??12) && state.food>=(spec.minFood??18);
      if(safe) {stableSince ||= Date.now();if(Date.now()-stableSince>=1000)return;} else stableSince=0;
      await delay(100,undefined,{signal});
    }
    throw Object.assign(Error('Eating recovery did not safely clear within 30 seconds'),{failure:'safety_preempted'});
  }
  async executeOnce(spec, signal, progress = () => {}) {
    const authority=await this.bridge.state();
    if (authority.skillsVersion!==4) throw Error('Client skills version 4 required');
    const options={strict:true,progress,protectedItems:spec.protectedItems??{}};
    const perform=(action)=>this.action(action,authority,signal,options);
    try {
      if (spec.kind==='obtain') return await this.run({targets:spec.targets},signal,options);
      if (spec.kind==='eat') return await perform({type:'skill',kind:'eat',item:'minecraft:air',count:1,targetFood:spec.targetFood});
      if (spec.kind==='equip') return await perform({type:'skill',kind:'equip',item:spec.item,count:1});
      if (spec.kind==='navigate') return await perform({type:'navigate',x:spec.x,z:spec.z});
      if (spec.kind==='shaft') {
        // A partially carved shaft is not restarted from a different origin after interruption.
        if (Math.hypot(authority.x-spec.origin.x,authority.y-spec.origin.y,authority.z-spec.origin.z)>2)
          throw Error('Return to the recorded shaft origin before resuming construction');
        return await perform({type:'skill',kind:'shaft',item:'minecraft:cobblestone',count:spec.steps,direction:spec.direction,torchEvery:spec.torchEvery,minFood:18,minHealth:12,minDurability:10});
      }
      const snapshot=await this.inventory.inventory();
      const remaining=Math.max(0,spec.targetTotal-(snapshot.items[spec.item]??0));
      if (remaining) {
        const method=this.planner.methods(spec.item).find(m=>m.kind==='gather');
        const picks=['wooden','stone','iron','diamond','netherite'].map(m=>`minecraft:${m}_pickaxe`);
        const tool=method.tier===undefined?null:picks.slice(method.tier).reverse().find(item=>snapshot.items[item]>0);
        if (method.tier!==undefined && !tool) throw Error('Gather requires a suitable existing pickaxe; plan tool preparation first');
        await perform({type:'skill',kind:'gather',item:spec.item,count:remaining,blocks:method.blocks,tool,returnToOrigin:false,
          minFood:spec.minFood,minHealth:spec.minHealth,minDurability:spec.minDurability,reserves:spec.protectedItems??{}});
      }
      if (spec.destination) await perform({type:'navigate',x:spec.destination.x,z:spec.destination.z});
    } catch (error) {
      // A client outcome has already released its keys; errors during polling may not have.
      if (!signal.aborted && error.failure!=='safety_preempted') await this.bridge.stop({keepSafety:true}).catch(()=>{});
      throw error;
    }
  }

  async waitForSafety(authority, signal) {
    let announced=false;
    for (;;) {
      signal.throwIfAborted();
      const state=await this.bridge.state();
      if(state.session!==authority.session || state.epoch!==authority.epoch)
        throw Object.assign(Error('Control changed; goal cancelled'), { failure: 'control_changed' });
      if(!state.reflex) return;
      if(!announced) {this.emit('Job suspended for survival; waiting for stable clearance. Stop still cancels.');announced=true;}
      await this.bridge.lease(authority);
      await delay(200,undefined,{signal});
    }
  }
  async action(rawAction, authority, signal, options = {}) {
    // Skills used to be the one action type that reached the client without host-side validation,
    // a policy scope or a deadline of its own. They go through the same envelope as everything
    // else now, so a malformed grid is refused here rather than becoming a bridge 400 mid-goal.
    const action=validateAction(rawAction);
    const deadlineMs=deadlineFor(action);
    if (!options.strict) await this.waitForSafety(authority,signal);
    let state=await this.bridge.state();
    const check=()=>{
      signal.throwIfAborted();
      if(state.session!==authority.session || state.epoch!==authority.epoch)
        throw Object.assign(Error('Control changed; goal cancelled'), { failure: 'control_changed' });
    };
    if (options.strict && state.reflex) throw Object.assign(Error('Safety owns the body'),{failure:'safety_preempted'});
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
    options.progress?.({phase:'requested',actionId:id,action});
    let reported=false, lastReport=0;
    let deadline=Date.now()+deadlineMs+5000, polledAt=Date.now();
    while(Date.now()<deadline) {
      check();
      await this.bridge.lease(authority);
      await delay(200,undefined,{signal});state=await this.bridge.state();check();
      // A queued action has no execution time while survival owns the body. Preserve the
      // deadline budget across that race, without extending a running skill's own deadline.
      const now=Date.now();
      if (state.actionId===id && state.acting && (!reported || now-lastReport>5000)) {
        options.progress?.({phase:'running',actionId:id,action,observedAt:state.observedAt,details:state.skillProgress??{progress:state.progress,stagnantTicks:state.stagnantTicks},
          ...(!reported?{message:`Client acknowledged ${action.kind??action.type} execution`}:{})});
        reported=true;lastReport=now;
      }
      if(state.reflex && state.pendingActionId===id) deadline+=now-polledAt;
      polledAt=now;
      if(state.outcome?.actionId===id) {
        if(state.outcome.status!=='succeeded') {
          // Carry the typed failure alongside the text: free text cannot be matched later.
          const error=Error(state.outcome.reason);
          error.failure=state.outcome.reason?.startsWith('expedition_limit:')?'expedition_limit':state.outcome.failure ?? state.failure ?? 'controller_error';
          throw error;
        }
        this.emit(state.outcome.reason);return;
      }
    }
    const expired=Error('Skill deadline exceeded');expired.failure='deadline';throw expired;
  }
  async run(goal, signal, options = {}) {
    const authority=await this.bridge.state();
    if(authority.reflexArmed && authority.survivalVersion!==1) throw Error('Client survival logic is out of date. Build and restart Minecraft before autonomous work.');
    if(![3,4].includes(authority.skillsVersion)) throw Error('Client skills unavailable or out of date. Run ./realm-agent build and restart Minecraft.');
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
    let stations=[], step=0, repairs=0;
    while(step<128) {
      signal.throwIfAborted();
      if (!options.strict) await this.waitForSafety(authority,signal);
      const snapshot=await this.inventory.inventory();
      if(snapshot.session!==authority.session) throw Error('World changed; goal cancelled');
      stations=[...new Set([...(snapshot.stations??[]).filter(station=>['crafting_table','furnace'].includes(station)),...deployed])];
      // Anything we left in a furnace is already paid for. Collect it before planning, or the
      // plan is made from an inventory that is missing it and sends us back to mine more ore.
      const cooking=Object.entries(snapshot.smelting??{}).find(([,left])=>left>0);
      if(cooking && stations.includes('furnace') && !this.attempts.banned({type:'skill',kind:'smelt',item:cooking[0]})) {
        const collect={type:'skill',kind:'smelt',item:cooking[0],count:Math.min(cooking[1],8),blocks:[],tool:null};
        this.emit(`collect: ${collect.count} ${collect.item} left in the furnace`);
        try { await this.action(collect,authority,signal,options); continue; }
        catch(error) {
          if(!options.strict && disposition(error.failure)==='resume') {this.emit(`Interrupted by the safety tier (${error.message}); the furnace still holds ${collect.item}`);continue;}
          if(options.strict) throw error;
          if(error.failure) this.attempts.record(collect,error.failure);
          this.emit(`Could not collect ${collect.item} from the furnace: ${error.message}`);
        }
      }
      for (const [item,count] of Object.entries(options.protectedItems??{})) {
        snapshot.items[item]=Math.max(0,(snapshot.items[item]??0)-count);
        snapshot.craftingItems[item]=Math.max(0,(snapshot.craftingItems[item]??0)-count);
      }
      const wanted=goal.targets?.map(target=>({...target,count:Math.max(0,target.count-((snapshot.items[target.item]??0)-(snapshot.craftingItems[target.item]??0)))})).filter(t=>t.count>0);
      if (wanted && !wanted.length) return;
      const plan=wanted?this.planner.planMany(wanted,snapshot.craftingItems,{stations}):this.planner.plan(goal.item,goal.count,snapshot.craftingItems,{stations});
      if(plan.status!=='planned') throw Error(plan.reason);
      const node=plan.nodes[0];
      if(!node) {this.emit(`Goal verified: ${JSON.stringify(goal.targets??[{item:plan.goal.item,count:goal.count}])}`);return;}
      const action=node.kind==='craft'?craftAction(node,snapshot.craftingItems):{
        type:'skill',kind:node.kind,item:node.item??`minecraft:${node.station}`,count:node.count??1,blocks:node.blocks??[],tool:node.tool??null
      };
      if (options.strict) {
        if(node.kind==='gather') {action.returnToOrigin=false;action.minFood=18;action.minHealth=12;action.minDurability=10;}
        action.reserves=plan.nodes.reduce((total,n)=>{for(const [item,count] of Object.entries(n.consumes??{})) total[item]=(total[item]??0)+count;return total;},{});
        for (const [item,count] of Object.entries(options.protectedItems??{})) action.reserves[item]=(action.reserves[item]??0)+count;
        for (const target of goal.targets??[]) action.reserves[target.item]=Math.max(action.reserves[target.item]??0,target.count);
      }
      if(node.kind==='smelt') action.count=Math.min(action.count,8);
      const banned=this.attempts.banned(action);
      if(banned) throw Error(`Refusing to repeat a known failure: ${banned}. Change the situation or type stop.`);
      this.emit(`${node.kind}: ${action.count} ${action.item}`);
      try { await this.action(action,authority,signal,options); }
      catch(error) {
        // Safety owns the body until it reports clearance. The objective was never the problem, so it is
        // not recorded as a failure of this step, and the next loop replans from a fresh
        // observation -- which is the resume, because progress for these jobs is the inventory.
        if(!options.strict && disposition(error.failure)==='resume') {
          this.emit(`Interrupted by the safety tier (${error.message}); preserving ${node.kind} ${action.item}`);
          continue;
        }
        if (options.strict && /^station_(missing|unreachable):/.test(error.message) && repairs++<2) {
          deployed.clear();
          options.progress?.({phase:'repair',message:`Rechecking stations after local failure: ${error.message}`});
          continue;
        }
        if(error.failure && !blameless(error.failure)) this.attempts.record(action,error.failure);
        throw error;
      }
      step++;
      this.attempts.record(action,'');
      if(node.kind==='deploy_station') deployed.add(node.station);
    }
    throw Error('Goal exceeded 128 skill steps');
  }
}
