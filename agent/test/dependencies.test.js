import test from 'node:test';
import assert from 'node:assert/strict';
import { DependencyPlanner, parseObtainGoal } from '../src/dependencies.js';

test('empty inventory expands iron pickaxe with shared stations and exact resource accounting',()=>{
  const plan=new DependencyPlanner().plan('iron pickaxe');
  assert.equal(plan.status,'planned');
  assert.equal(plan.executable,false);
  assert.deepEqual(plan.summary,{'minecraft:oak_log':3,'minecraft:cobblestone':11,'minecraft:raw_iron':3,'minecraft:coal':1});
  assert.equal(plan.nodes.filter(node=>node.kind==='deploy_station' && node.station==='crafting_table').length,1);
  const inventory={};
  const completed=new Set();
  for(const node of plan.nodes) {
    for(const dependency of node.dependsOn) assert.ok(completed.has(dependency));
    if(node.tool) assert.ok(inventory[node.tool]>0);
    for(const [item,count] of Object.entries(node.consumes)) {
      assert.ok((inventory[item]??0)>=count,`${node.id}: insufficient ${item}`);
      inventory[item]-=count;
    }
    for(const [item,count] of Object.entries(node.produces)) inventory[item]=(inventory[item]??0)+count;
    completed.add(node.id);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(inventory).filter(([,count])=>count>0)),plan.projectedInventory);
});

test('existing materials and station avoid unnecessary acquisition',()=>{
  const plan=new DependencyPlanner().plan('iron_pickaxe',1,{iron_ingot:3,stick:2},{stations:['crafting_table']});
  assert.equal(plan.status,'planned');
  assert.equal(plan.nodes.length,1);
  assert.equal(plan.nodes[0].kind,'craft');
});

test('completed goals require no action and previews cannot leak inventory between calls',()=>{
  const planner=new DependencyPlanner();
  assert.equal(planner.plan('iron_pickaxe',1,{iron_pickaxe:1}).nodes.length,0);
  assert.ok(planner.plan('iron_pickaxe').nodes.length>1);
});

test('unsupported goals and exhausted search do not claim feasibility',()=>{
  const planner=new DependencyPlanner();
  assert.equal(planner.plan('not_a_real_item').status,'blocked');
  assert.equal(planner.plan('iron_pickaxe',1,{}, {budget:0}).status,'incomplete');
  assert.throws(()=>planner.plan('dirt',0));
});

test('ingredient leftovers are shared and existing better tools are reused',()=>{
  const plan=new DependencyPlanner().plan('cobblestone',11,{diamond_pickaxe:1});
  assert.equal(plan.nodes.length,1);
  assert.equal(plan.nodes[0].tool,'minecraft:diamond_pickaxe');
  assert.equal(plan.projectedInventory['minecraft:diamond_pickaxe'],1);
});

test('conversational obtain requests normalize to typed goals',()=>{
  assert.deepEqual(parseObtainGoal('can you create an iron pickaxe?'),{type:'obtain',item:'minecraft:iron_pickaxe',count:1});
  assert.equal(parseObtainGoal('plan 12 dirt').count,12);
  assert.equal(parseObtainGoal('go to 200 200'),null);
});

test('gathering verbs and common resource names reach the dependency planner',()=>{
  const planner=new DependencyPlanner();
  for(const verb of ['get','fetch','gather','collect']) {
    const goal=parseObtainGoal(`${verb} 6 logs`);
    const plan=planner.plan(goal.item,goal.count,{'minecraft:birch_log':2});
    assert.equal(plan.status,'planned');
    assert.equal(plan.goal.item,'minecraft:birch_log');
    assert.equal(plan.summary['minecraft:birch_log'],4);
  }
  assert.equal(planner.plan('cobble',3,{'minecraft:wooden_pickaxe':1}).goal.item,'minecraft:cobblestone');
});
