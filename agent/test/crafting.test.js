import test from 'node:test';
import assert from 'node:assert/strict';
import { canCraft, craftable, inventoryDict } from '../src/crafting.js';

test('live inventory aggregates stacks and refuses stale data',()=>{
  const observation={online:true,fresh:true,observedAt:Date.now(),inventory:{items:[{item:'minecraft:dirt',count:12},{item:'minecraft:dirt',count:8}]}};
  assert.deepEqual(inventoryDict(observation),{'minecraft:dirt':20});
  assert.throws(()=>inventoryDict({...observation,fresh:false}),/stale/);
});
test('logs become planks then sticks with real output quantities',()=>{
  const result=canCraft('stick',{'minecraft:oak_log':1});
  assert.equal(result.canCraftFromMaterials,true);
  assert.deepEqual(result.plan.steps.map(step=>step.output),['minecraft:oak_planks','minecraft:stick']);
  assert.equal(result.plan.steps[0].count,4);
  assert.equal(result.plan.steps[1].consumes['minecraft:oak_planks'],2);
  assert.equal(result.canCraftWithKnownStations,true);
});
test('diamond sword reports materials separately from station access',()=>{
  const counts={'minecraft:diamond':2,'minecraft:stick':1};
  const result=canCraft('diamond sword',counts);
  assert.equal(result.canCraftFromMaterials,true);
  assert.equal(result.canCraftWithKnownStations,false);
  assert.equal(canCraft('diamond sword',counts,{tableAvailable:true}).canCraftWithKnownStations,true);
  assert.equal(canCraft('diamond sword',{'minecraft:diamond':1,'minecraft:stick':1}).canCraftFromMaterials,false);
});
test('ingredient allocation cannot spend the same plank twice',()=>{
  assert.equal(canCraft('stick',{'minecraft:oak_planks':1}).canCraftFromMaterials,false);
  assert.equal(canCraft('stick',{'minecraft:oak_planks':1,'minecraft:birch_planks':1}).canCraftFromMaterials,true);
});
test('search exhaustion and unknown recipes never claim impossibility',()=>{
  assert.equal(canCraft('stick',{'minecraft:oak_log':1},{operations:0}).canCraftFromMaterials,null);
  assert.equal(canCraft('not_an_item',{}).canCraftFromMaterials,null);
  assert.throws(()=>craftable({}, {depth:3}),/two steps/);
});
