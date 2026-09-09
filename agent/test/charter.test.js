import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCharter } from '../src/setup.js';
import { Planner } from '../src/planner.js';

test('the shipped charter states a purpose, ranked priorities and constraints',()=>{
  const charter=loadCharter();
  assert.ok(charter.length>200,'charter should not be empty or a stub');
  for(const heading of ['## Purpose','## Priorities','## Standing constraints','## Maintenance is not purpose','## When there is nothing to do'])
    assert.ok(charter.includes(heading),`missing ${heading}`);
});

test('a missing charter is empty rather than fatal',()=>{
  // Better that the agent says it has no purpose than that it invents one.
  assert.equal(loadCharter('/nonexistent/charter.md'),'');
});

test('the charter reaches the goal-level system prompt',async()=>{
  let sent;
  const planner=new Planner({modelEnabled:true,model:'m',ollamaUrl:'http://x',charter:'CHARTER SENTINEL TEXT'},
    async(url,init)=>{sent=JSON.parse(init.body);return {ok:true,json:async()=>({message:{content:'{"type":"continue","x":0,"z":0,"direction":"forward","ticks":20,"why":"ok"}'}})};});
  await planner.decide({goal:'g',situation:'s',trend:'t',recent:[],banned:'',active:'idle'});
  const system=sent.messages.find(message=>message.role==='system').content;
  assert.ok(system.includes('CHARTER SENTINEL TEXT'));
  assert.ok(system.includes('may not change'),'the model must be told it does not own the charter');
});

test('without a charter the prompt carries no empty placeholder',async()=>{
  let sent;
  const planner=new Planner({modelEnabled:true,model:'m',ollamaUrl:'http://x'},
    async(url,init)=>{sent=JSON.parse(init.body);return {ok:true,json:async()=>({message:{content:'{"type":"continue","x":0,"z":0,"direction":"forward","ticks":20,"why":"ok"}'}})};});
  await planner.decide({goal:'g',situation:'s',trend:'t',recent:[],banned:'',active:'idle'});
  const system=sent.messages.find(message=>message.role==='system').content;
  assert.ok(!system.includes('charter'),system.slice(0,120));
  assert.ok(system.startsWith('You choose the next action'));
});
