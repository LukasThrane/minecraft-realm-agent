import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/commands.js';
import { READ_ONLY } from '../src/queries.js';
import { parseObtainGoal } from '../src/dependencies.js';

test('bare text is a goal, a slash is a command',()=>{
  assert.deepEqual(classify('craft stone pickaxe'),{kind:'goal',text:'craft stone pickaxe'});
  assert.deepEqual(classify('/inventory'),{kind:'command',name:'inventory',rest:[]});
  assert.deepEqual(classify('/go 200 200'),{kind:'command',name:'go',rest:['200','200']});
});

test('the same request phrased four ways behaves identically',()=>{
  // The regression this replaces: `craft 6 logs` executed while `fetch 6 logs` fell through to
  // the model as free text, for no reason visible from the console.
  for(const text of ['craft 6 logs','get 6 logs','fetch 6 logs','collect 6 logs']) {
    assert.equal(classify(text).kind,'goal',text);
    assert.deepEqual(parseObtainGoal(classify(text).text),{type:'obtain',item:'minecraft:logs',count:6},text);
  }
});

test('goal verbs are accepted with a slash too and mean the same thing',()=>{
  assert.deepEqual(classify('/craft stone pickaxe'),{kind:'goal',text:'craft stone pickaxe'});
  assert.deepEqual(classify('/get 6 logs'),{kind:'goal',text:'get 6 logs'});
});

test('stop needs no slash, in any casing',()=>{
  for(const text of ['stop','STOP','cancel','halt','/stop','/cancel'])
    assert.equal(classify(text).kind,'stop',text);
});

test('plan previews rather than executes, and never executes by accident',()=>{
  assert.deepEqual(classify('/plan iron pickaxe'),{kind:'preview',text:'iron pickaxe'});
  // Bare `plan ...` reads as an instruction; a preview that starts mining is the worst outcome.
  assert.equal(classify('plan iron pickaxe').kind,'preview_only');
});

test('empty input and a bare slash do nothing dangerous',()=>{
  assert.equal(classify('').kind,'empty');
  assert.equal(classify('   ').kind,'empty');
  assert.equal(classify('/').kind,'help');
  assert.equal(classify('/help').kind,'help');
});

test('an unknown command is a command, not a goal that starts mining',()=>{
  // Falling through to the goal path is how a typo used to become an action.
  assert.deepEqual(classify('/invnetory'),{kind:'command',name:'invnetory',rest:[]});
});

test('a look-only command is never mistaken for a new goal',()=>{
  // Observed live in a run: `/plan diamond_pickaxe` printed nothing and silently retargeted the
  // goal to "diamond_pickaxe". A command that only looks must never change what the agent wants.
  const routed=classify('/plan diamond_pickaxe');
  assert.equal(routed.kind,'preview');
  assert.notEqual(routed.kind,'goal');
  for(const text of ['/inventory','/look 16','/status','/history','/failures','/can-craft diamond sword'])
    assert.equal(classify(text).kind,'command',text);
});

test('every look-only command is one both entry points recognise',()=>{
  for(const name of READ_ONLY) {
    if(name==='help'||name==='plan') continue; // routed by classify as their own kinds
    assert.equal(classify(`/${name}`).kind,'command',name);
    assert.equal(classify(`/${name}`).name,name);
  }
});
