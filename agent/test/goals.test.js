import test from 'node:test';
import assert from 'node:assert/strict';
import { Goals, URGENT, NORMAL } from '../src/goals.js';
import { DependencyPlanner } from '../src/dependencies.js';

test('the queue is worked most urgent first, then oldest first',()=>{
  const goals=new Goals();
  const first=goals.add({item:'oak_log',count:4,why:'wood'});
  const urgent=goals.add({item:'cooked_beef',count:2,priority:URGENT,why:'hungry'});
  const later=goals.add({item:'diamond',count:24});
  assert.equal(goals.next().id,urgent.id,'urgency comes first');
  goals.complete(urgent);
  assert.equal(goals.next().id,first.id,'then whatever was asked for first');
  goals.complete(first);
  assert.equal(goals.next().id,later.id);
});

test('asking for the same thing twice raises it rather than queueing it twice',()=>{
  const goals=new Goals();
  goals.add({item:'diamond',count:3,priority:NORMAL});
  const again=goals.add({item:'minecraft:diamond',count:24,priority:1,why:'full gear'});
  assert.equal(goals.pending().length,1,'one goal, whatever it was called');
  assert.equal(again.count,24); assert.equal(again.priority,1);
  assert.equal(again.why,'full gear');
});

test('goals we already satisfy are retired without being run',()=>{
  const goals=new Goals();
  goals.add({item:'diamond',count:3});
  const outstanding=goals.add({item:'diamond_pickaxe',count:1});
  const done=goals.prune({'minecraft:diamond':5},new DependencyPlanner());
  assert.deepEqual(done.map(goal=>goal.item),['minecraft:diamond']);
  assert.equal(goals.next().id,outstanding.id,'and the rest of the queue carries on');
});

test('a dropped goal stays dropped and reports why',()=>{
  const goals=new Goals();
  const goal=goals.add({item:'oak_boat',count:1});
  assert.equal(goals.drop(goal.id,'not now').status,'dropped');
  assert.equal(goals.next(),null);
  assert.equal(goals.drop(goal.id),null,'dropping twice is not a second event');
  assert.match(goals.recent().join(' '),/oak_boat: dropped \(not now\)/);
});
