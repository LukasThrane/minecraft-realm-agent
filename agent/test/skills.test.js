import test from 'node:test';
import assert from 'node:assert/strict';
import { craftAction, SkillExecutor } from '../src/skills.js';
import { DependencyPlanner } from '../src/dependencies.js';
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
});

test('executor replans from inventory after each output and stops at goal',async()=>{
  let items={'minecraft:oak_log':1};
  const state={skillsVersion:1,session:'world',epoch:1};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',inventory:{items:Object.entries(items).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  let actions=0;
  executor.action=async action=>{actions++;assert.equal(action.kind,'craft');items={'minecraft:oak_planks':4};};
  await executor.run({item:'planks',count:4},new AbortController().signal);
  assert.equal(actions,1);
});

test('cancelled goals never start skills',async()=>{
  const executor=new SkillExecutor({state:async()=>({skillsVersion:1})},()=>{});
  const controller=new AbortController();controller.abort();
  await assert.rejects(executor.run({item:'dirt',count:1},controller.signal),{name:'AbortError'});
});

test('authority changes reject dispatch',async()=>{
  const executor=new SkillExecutor({state:async()=>({canAct:true,session:'world',epoch:2})},()=>{});
  await assert.rejects(executor.action({}, {session:'world',epoch:1},new AbortController().signal),/Control changed/);
});

test('executor reuses a station observed in the world across goal runs',async()=>{
  let items={'minecraft:oak_planks':3,'minecraft:stick':2};
  const state={skillsVersion:1,session:'world',epoch:1};
  const bridge={state:async()=>state,observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'world',stations:['crafting_table'],inventory:{items:Object.entries(items).map(([item,count],slot)=>({item,count,slot}))}})};
  const executor=new SkillExecutor(bridge,()=>{});
  const actions=[];
  executor.action=async action=>{actions.push(action);items={'minecraft:wooden_pickaxe':1};};
  await executor.run({item:'wooden_pickaxe',count:1},new AbortController().signal);
  assert.equal(actions.length,1);
  assert.equal(actions[0].kind,'craft');
  assert.equal(actions[0].station,'crafting_table');
});
