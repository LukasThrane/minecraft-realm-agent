import test from 'node:test';
import assert from 'node:assert/strict';
import { assumptionsFor, craftAction, SkillExecutor } from '../src/skills.js';
import { DependencyPlanner } from '../src/dependencies.js';
import { SKILL_DEADLINES, SKILL_KINDS, deadlineFor, scopeFor } from '../src/commands.js';
import { catalog } from '../src/crafting.js';

test('one-log plank crafting sends a complete inventory grid',()=>{
  const inventory={'minecraft:oak_log':1};
  const node=new DependencyPlanner().plan('oak_planks',4,inventory).nodes[0];
  const action=craftAction(node,inventory);
  assert.equal(action.width,2);
  assert.equal(action.station,'inventory');
  assert.deepEqual(action.grid,['minecraft:oak_log','','','']);
  assert.equal(action.count,4);
});

test('all exported recipes fit the client rectangular grid contract',()=>{
  for(const recipe of catalog.recipes) {
    const limit=recipe.station==='inventory'?2:3;
    assert.ok(recipe.width>=1 && recipe.width<=limit,recipe.id);
    assert.ok(recipe.height>=1 && recipe.height<=limit,recipe.id);
    assert.equal(recipe.grid.length,recipe.width*recipe.height,recipe.id);
    assert.deepEqual(recipe.grid.filter(slot=>slot.length),recipe.slots,recipe.id);
  }
});

test('aliases resolve against available wood and plural sticks',()=>{
  const planner=new DependencyPlanner();
  assert.equal(planner.plan('sticks').goal.item,'minecraft:stick');
  assert.equal(planner.plan('planks',10,{'minecraft:birch_log':3}).goal.item,'minecraft:birch_planks');
});

test('executable grids retain empty slots and allocate only owned ingredients',()=>{
  const inventory={'minecraft:oak_planks':3,'minecraft:stick':2};
  const plan=new DependencyPlanner().plan('wooden_pickaxe',1,inventory,{stations:['crafting_table']});
  const action=craftAction(plan.nodes[0],inventory);
  assert.deepEqual(action.grid,['minecraft:oak_planks','minecraft:oak_planks','minecraft:oak_planks','','minecraft:stick','','','minecraft:stick','']);
  assert.equal(action.count,1);
  assert.throws(()=>craftAction(plan.nodes[0],{}),/ingredients changed/);
});

test('inventory craft uses one batch, not the entire planned quantity',()=>{
  const inventory={'minecraft:oak_log':3};
  const node=new DependencyPlanner().plan('oak_planks',10,inventory).nodes[0];
  assert.equal(craftAction(node,inventory).count,4);
});

test('executor requires installed skill capability before any action',async()=>{
  const executor=new SkillExecutor({state:async()=>({})},()=>{});
  await assert.rejects(executor.run({item:'dirt',count:1},new AbortController().signal),/skills unavailable/);
  const stale=new SkillExecutor({state:async()=>({skillsVersion:1})},()=>{});
  await assert.rejects(stale.run({item:'dirt',count:1},new AbortController().signal),/out of date/);
});

test('executor replans from inventory after each output and stops at goal',async()=>{
  let items={'minecraft:oak_log':1};
  const state={skillsVersion:3,session:'world',epoch:1};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',inventory:{items:Object.entries(items).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  let actions=0;
  executor.action=async action=>{actions++;assert.equal(action.kind,'craft');items={'minecraft:oak_planks':4};};
  await executor.run({item:'planks',count:4},new AbortController().signal);
  assert.equal(actions,1);
});

test('cancelled goals never start skills',async()=>{
  const executor=new SkillExecutor({state:async()=>({skillsVersion:3})},()=>{});
  const controller=new AbortController();controller.abort();
  await assert.rejects(executor.run({item:'dirt',count:1},controller.signal),{name:'AbortError'});
});

test('authority changes reject dispatch',async()=>{
  const executor=new SkillExecutor({state:async()=>({canAct:true,session:'world',epoch:2})},()=>{});
  const action={type:'skill',kind:'gather',item:'minecraft:oak_log',count:1,blocks:['minecraft:oak_log'],tool:null};
  await assert.rejects(executor.action(action,{session:'world',epoch:1},new AbortController().signal),/Control changed/);
});

test('a malformed skill never reaches the bridge',async()=>{
  // Skills were the one action type that bypassed host-side validation entirely; a truncated
  // recipe grid was caught only by the client, as a bridge 400 partway through a goal.
  let dispatched=false;
  const executor=new SkillExecutor({state:async()=>({canAct:true,session:'w',epoch:1,health:20}),act:async()=>{dispatched=true;}},()=>{});
  const authority={session:'w',epoch:1};
  const signal=new AbortController().signal;
  await assert.rejects(executor.action({type:'skill',kind:'craft',item:'minecraft:stick',count:4,station:'inventory',width:2,grid:['minecraft:oak_planks']},authority,signal),/rectangle/);
  await assert.rejects(executor.action({type:'skill',kind:'gather',item:'minecraft:oak_log',count:1,blocks:[]},authority,signal),/1\.\.32 target blocks/);
  await assert.rejects(executor.action({type:'skill',kind:'smelt',item:'minecraft:iron_ingot',count:9},authority,signal),/1\.\.8 iron ingots/);
  assert.equal(dispatched,false);
});

test('skills carry a health assumption the client can void them on',()=>{
  const gather={type:'skill',kind:'gather',item:'minecraft:cobblestone',count:3};
  assert.deepEqual(assumptionsFor(gather,{health:20}),{minHealth:6});
  assert.deepEqual(assumptionsFor(gather,{health:5}),{minHealth:3});
  // Never a floor at or above current health: issuing a goal while hurt must not void instantly.
  assert.ok(assumptionsFor(gather,{health:1}).minHealth<=1);
  // A menu transaction cannot walk away from anything, so it asserts nothing.
  assert.equal(assumptionsFor({type:'skill',kind:'craft'},{health:20}),undefined);
});

test('a leaf that keeps failing the same way is refused rather than repeated',async()=>{
  const items={'minecraft:oak_log':1};
  const state={skillsVersion:3,session:'world',epoch:1,health:20};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',stations:[],
    inventory:{items:Object.entries(items).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  let dispatches=0;
  executor.action=async action=>{dispatches++;const error=Error('station_unreachable: no route');error.failure='precondition';throw error;};
  const goal={item:'planks',count:4};
  for(let attempt=0;attempt<3;attempt++)
    await assert.rejects(executor.run(goal,new AbortController().signal),/station_unreachable/);
  await assert.rejects(executor.run(goal,new AbortController().signal),/Refusing to repeat a known failure/);
  assert.equal(dispatches,3);
});

test('executor reuses a station observed in the world across goal runs',async()=>{
  let items={'minecraft:oak_planks':3,'minecraft:stick':2};
  const state={skillsVersion:3,session:'world',epoch:1};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',stations:['crafting_table'],inventory:{items:Object.entries(items).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  const actions=[];
  executor.action=async action=>{actions.push(action);items={'minecraft:wooden_pickaxe':1};};
  await executor.run({item:'wooden_pickaxe',count:1},new AbortController().signal);
  assert.equal(actions.length,1);
  assert.equal(actions[0].kind,'craft');
  assert.equal(actions[0].station,'crafting_table');
});

test('a station stays owned while gathering carries the player out of scan range',async()=>{
  // The regression: an observation taken away from the worksite reported no stations, and the
  // executor took that as proof it owned none and crafted a second crafting table.
  const items={'minecraft:oak_log':3,'minecraft:crafting_table':1};
  let stations=[];
  const state={skillsVersion:3,session:'world',epoch:1};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',stations,
    inventory:{items:Object.entries(items).filter(([,count])=>count>0).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  const kinds=[];
  executor.action=async action=>{
    kinds.push(`${action.kind}:${action.item}`);
    if(action.kind==='deploy_station') {
      items['minecraft:crafting_table']--;
      stations=['crafting_table'];
      return;
    }
    for(const ingredient of action.grid.filter(Boolean)) items[ingredient]--;
    items[action.item]=(items[action.item]??0)+action.count;
    // Gathering and pathing carry the player out of the client's local station scan.
    stations=[];
  };
  await executor.run({item:'wooden_pickaxe',count:1},new AbortController().signal);
  assert.equal(kinds.filter(kind=>kind.startsWith('deploy_station')).length,1,kinds.join(' | '));
  assert.equal(kinds.filter(kind=>kind==='craft:minecraft:crafting_table').length,0,kinds.join(' | '));
  assert.equal(items['minecraft:wooden_pickaxe'],1,kinds.join(' | '));
});

test('a dispatched skill carries the same envelope as every other action',async()=>{
  const sent=[];
  const state={canAct:true,session:'w',epoch:1,health:20,outcome:null};
  const bridge={
    state:async()=>state,
    lease:async()=>({}),
    act:async(action,from,id,deadlineMs,scope,assumes)=>{
      sent.push({action,deadlineMs,scope,assumes});
      state.outcome={actionId:id,status:'succeeded',reason:'done'};
    }
  };
  const executor=new SkillExecutor(bridge,()=>{});
  await executor.action({type:'skill',kind:'gather',item:'minecraft:cobblestone',count:3,blocks:['minecraft:stone'],tool:'minecraft:wooden_pickaxe'},
    {session:'w',epoch:1},new AbortController().signal);
  assert.equal(sent.length,1);
  assert.equal(sent[0].scope,'build','skills change the world and must run in the build scope');
  assert.equal(sent[0].deadlineMs,SKILL_DEADLINES.gather);
  assert.deepEqual(sent[0].assumes,{minHealth:6});
  assert.deepEqual(sent[0].action,{type:'skill',kind:'gather',item:'minecraft:cobblestone',count:3,
    blocks:['minecraft:stone'],tool:'minecraft:wooden_pickaxe'});
});

test('deadlines and scope stay inside the bounds the client enforces',()=>{
  for(const kind of SKILL_KINDS) {
    const deadline=deadlineFor({type:'skill',kind});
    assert.ok(deadline>=1000 && deadline<=600_000,`${kind}: ${deadline}`);
    assert.equal(scopeFor({type:'skill',kind}),'build');
  }
});

test('a safety reflex interrupts a job and the job resumes where it was',async()=>{
  // The charter's rule: maintenance interrupts objectives, it never replaces them. Before this,
  // a creeper appearing mid-gather ended the whole multi-step goal and the operator retyped it.
  const items={'minecraft:oak_log':1};
  const state={skillsVersion:3,session:'world',epoch:1,health:20};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',stations:[],
    inventory:{items:Object.entries(items).filter(([,count])=>count>0).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  const dispatched=[];
  executor.action=async action=>{
    dispatched.push(action.item);
    if(dispatched.length===1) {const error=Error('Preempted by safety reflex: eat');error.failure='safety_preempted';throw error;}
    delete items['minecraft:oak_log'];items['minecraft:oak_planks']=4;
  };
  await executor.run({item:'planks',count:4},new AbortController().signal);
  assert.deepEqual(dispatched,['minecraft:oak_planks','minecraft:oak_planks'],'the same step should be retried, not abandoned');
  // The interruption is not the step's fault and must not count against it.
  assert.equal(executor.attempts.summary(),'');
});

test('a takeover abandons the job rather than resuming it',async()=>{
  const items={'minecraft:oak_log':1};
  const state={skillsVersion:3,session:'world',epoch:1,health:20};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',stations:[],
    inventory:{items:Object.entries(items).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  let dispatches=0;
  executor.action=async()=>{dispatches++;const error=Error('Manual takeover (F8)');error.failure='takeover';throw error;};
  await assert.rejects(executor.run({item:'planks',count:4},new AbortController().signal),/takeover/i);
  assert.equal(dispatches,1,'the operator taking control is a decision, not an interruption');
});

test('more than five temporary safety episodes preserve the job',async()=>{
  const items={'minecraft:oak_log':1};
  const state={skillsVersion:3,session:'world',epoch:1,health:20};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',stations:[],
    inventory:{items:Object.entries(items).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  let dispatches=0;
  executor.action=async()=>{
    if(++dispatches<=7) {const error=Error('retreat');error.failure='safety_preempted';throw error;}
    delete items['minecraft:oak_log'];items['minecraft:oak_planks']=4;
  };
  await executor.run({item:'planks',count:4},new AbortController().signal);
  assert.equal(dispatches,8);
  assert.equal(executor.attempts.summary(),'');
});

test('real executor waits for survival clearance before replanning or dispatch',async()=>{
  let state={skillsVersion:3,session:'w',epoch:1,health:20,reflex:'hold',canAct:true};
  let leases=0,reads=0,acts=0;
  const bridge={state:async()=>state,lease:async()=>{if(++leases===2) state={...state,reflex:''};},
    observe:async()=>{
      reads++;assert.equal(state.reflex,'');
      return {online:true,fresh:true,observedAt:Date.now(),session:'w',stations:[],inventory:{items:[{item:'minecraft:oak_planks',count:4,slot:0}]}};
    },act:async()=>{acts++;}};
  await new SkillExecutor(bridge,()=>{}).run({item:'planks',count:4},new AbortController().signal);
  assert.equal(leases,2);assert.equal(reads,1);assert.equal(acts,0);
});

test('stop and takeover remain authoritative while a job is suspended',async()=>{
  const authority={session:'w',epoch:1};
  const control=new AbortController();
  const bridge={state:async()=>({...authority,reflex:'hold'}),lease:async()=>control.abort()};
  await assert.rejects(new SkillExecutor(bridge,()=>{}).waitForSafety(authority,control.signal),{name:'AbortError'});
  bridge.state=async()=>({...authority,epoch:2,reflex:'hold'});
  await assert.rejects(new SkillExecutor(bridge,()=>{}).waitForSafety(authority,new AbortController().signal),/Control changed/);
});

test('bridge preemption suspends the real action loop, then replans and verifies inventory',async()=>{
  const state={skillsVersion:3,survivalVersion:1,reflexArmed:true,session:'w',epoch:1,health:20,canAct:true,reflex:''};
  let items=[{item:'minecraft:oak_log',count:1,slot:0}], dispatches=0, holdLeases=0;
  const bridge={state:async()=>({...state}),
    observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'w',stations:[],inventory:{items}}),
    lease:async()=>{if(state.reflex && ++holdLeases>=3) state.reflex='';},
    act:async(action,from,id)=>{
      assert.equal(state.reflex,'','no work dispatched into a survival hold');dispatches++;
      if(dispatches===1) {
        state.reflex='hold';state.outcome={actionId:id,status:'cancelled',failure:'safety_preempted',reason:'blocked escape'};
      } else {
        items=[{item:'minecraft:oak_planks',count:4,slot:0}];
        state.outcome={actionId:id,status:'succeeded',reason:'inventory verified'};
      }
    }};
  const executor=new SkillExecutor(bridge,()=>{});
  await executor.run({item:'planks',count:4},new AbortController().signal);
  assert.equal(dispatches,2);assert.equal(holdLeases,3);assert.equal(executor.attempts.summary(),'');
});

test('old reflex builds cannot enter unlimited resume semantics',async()=>{
  const executor=new SkillExecutor({state:async()=>({skillsVersion:3,reflexArmed:true})},()=>{});
  await assert.rejects(executor.run({item:'dirt',count:1},new AbortController().signal),/survival logic is out of date/);
});

test('ore already in the furnace is collected before the plan is remade',async()=>{
  // Live: the agent smelted iron, saw one ingot in its inventory and concluded it had to go and
  // mine two more ore -- while those two were already cooking. Furnace contents are not in the
  // inventory, so the executor has to take them out before it plans from inventory.
  let items={'minecraft:iron_ingot':1}, smelting={'minecraft:iron_ingot':2};
  const state={skillsVersion:3,session:'world',epoch:1,survivalVersion:1};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',
    stations:['crafting_table','furnace'],smelting,
    inventory:{items:Object.entries(items).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  const dispatched=[];
  executor.action=async action=>{
    dispatched.push(action);
    if(action.kind==='smelt'){items={'minecraft:iron_ingot':3};smelting={};}
  };
  await executor.run({item:'iron_ingot',count:3},new AbortController().signal);
  assert.equal(dispatched[0].kind,'smelt','the furnace is emptied first');
  assert.equal(dispatched[0].count,2);
  assert.ok(!dispatched.some(action=>action.kind==='gather'),'no ore is mined for something already smelting');
});

test('fuel is whatever we are carrying that burns, not only coal',()=>{
  const planner=new DependencyPlanner();
  const withCoal=planner.plan('iron_ingot',3,{'minecraft:raw_iron':3,'minecraft:coal':1,'minecraft:stone_pickaxe':1});
  assert.equal(withCoal.status,'planned');
  assert.ok(!withCoal.nodes.some(node=>node.item==='minecraft:coal'),'coal in hand is spent, not re-mined');
  const withWood=planner.plan('iron_ingot',3,{'minecraft:raw_iron':3,'minecraft:oak_planks':12,'minecraft:stone_pickaxe':1});
  assert.equal(withWood.status,'planned');
  assert.ok(!withWood.nodes.some(node=>node.item==='minecraft:coal'),'a stack of planks is fuel; do not go mining coal for it');
  const empty=planner.plan('iron_ingot',3,{'minecraft:raw_iron':3,'minecraft:stone_pickaxe':1});
  assert.ok(empty.nodes.some(node=>node.item==='minecraft:coal'),'with nothing burnable, fuel is planned for');
});

test('agent gather resumes to the original total and does not request a return',async()=>{
  const bridge={state:async()=>({skillsVersion:4,session:'s',epoch:1}),observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'s',inventory:{items:[{item:'minecraft:oak_log',count:18,slot:0}]}})};
  const executor=new SkillExecutor(bridge,()=>{});const actions=[];
  executor.action=async action=>actions.push(action);
  await executor.execute({kind:'gather',item:'minecraft:oak_log',targetTotal:48,minFood:18,minHealth:12,minDurability:10},new AbortController().signal);
  assert.equal(actions.length,1);assert.equal(actions[0].count,30);assert.equal(actions[0].returnToOrigin,false);
});
test('agent eating uses a real skill and propagates safety preemption',async()=>{
  const bridge={state:async()=>({skillsVersion:4,session:'s',epoch:1})};
  const executor=new SkillExecutor(bridge,()=>{});let called;
  executor.action=async action=>{called=action;throw Object.assign(Error('Safety borrowed body'),{failure:'safety_preempted'});};
  await assert.rejects(executor.execute({kind:'eat',targetFood:20},new AbortController().signal),/Safety borrowed/);
  assert.equal(called.kind,'eat');assert.equal(called.targetFood,20);
});
test('equipped armor satisfies batch obtain without crafting a duplicate',async()=>{
  const bridge={state:async()=>({skillsVersion:4,session:'s',epoch:1}),observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'s',inventory:{items:[{item:'minecraft:iron_helmet',count:1,slot:39}]}})};
  const executor=new SkillExecutor(bridge,()=>{});
  executor.action=async()=>{throw Error('Must not craft another helmet');};
  await executor.execute({kind:'obtain',targets:[{item:'minecraft:iron_helmet',count:1}]},new AbortController().signal);
});

test('routine eating continues the same authorized task without a model round trip',async()=>{
  const executor=new SkillExecutor({state:async()=>({session:'s',epoch:1})},()=>{});
  let runs=0,clearances=0;const progress=[];
  executor.executeOnce=async spec=>{runs++;if(runs===1)throw Object.assign(Error('Preempted by safety reflex: eat; food low'),{failure:'safety_preempted'});assert.equal(spec.targetTotal,48);};
  executor.waitForEatingClearance=async()=>{clearances++;};
  await executor.execute({kind:'gather',targetTotal:48,resumeAfterEating:true},new AbortController().signal,p=>progress.push(p));
  assert.equal(runs,2);assert.equal(clearances,1);assert.equal(progress[0].phase,'recovering');
});
test('retreat, disabled continuation and hazards cannot auto-resume eating work',async()=>{
  const executor=new SkillExecutor({state:async()=>({session:'s',epoch:1,onFire:true})},()=>{});
  executor.executeOnce=async()=>{throw Object.assign(Error('Preempted by safety reflex: retreat'),{failure:'safety_preempted'});};
  await assert.rejects(executor.execute({kind:'gather',resumeAfterEating:true},new AbortController().signal),/retreat/);
  executor.executeOnce=async()=>{throw Object.assign(Error('Preempted by safety reflex: eat'),{failure:'safety_preempted'});};
  await assert.rejects(executor.execute({kind:'gather',resumeAfterEating:false},new AbortController().signal),/eat/);
  await assert.rejects(executor.execute({kind:'gather',resumeAfterEating:true},new AbortController().signal),/Hazard/);
});
test('stop cancels an eating recovery wait',async()=>{
  const executor=new SkillExecutor({state:async()=>({session:'s',epoch:1,reflex:'eat'})},()=>{});
  const controller=new AbortController();
  const waiting=executor.waitForEatingClearance({session:'s',epoch:1},{},controller.signal);
  controller.abort();await assert.rejects(waiting,{name:'AbortError'});
});
