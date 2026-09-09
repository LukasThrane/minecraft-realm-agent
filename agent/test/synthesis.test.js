import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssumptions, FAILURES } from '../src/commands.js';
import { Bridge } from '../src/bridge.js';
import { Supervisor } from '../src/supervisor.js';
test('assumptions are bounded and unknown propositions are refused',()=>{
 assert.deepEqual(validateAssumptions({minHealth:12}),{minHealth:12});
 assert.deepEqual(validateAssumptions({maxHostilesWithin:{radius:8,count:0}}),{maxHostilesWithin:{radius:8,count:0}});
 assert.deepEqual(validateAssumptions({holding:'minecraft:iron_pickaxe'}),{holding:'minecraft:iron_pickaxe'});
 assert.equal(validateAssumptions(undefined),undefined);
 assert.equal(validateAssumptions({}),undefined);
 for (const bad of [{sneakily:true},{minHealth:-1},{minHealth:'a lot'},{holding:''},
   {maxHostilesWithin:{radius:0,count:0}},{maxHostilesWithin:{radius:100,count:0}},{maxHostilesWithin:{radius:8,count:-1}}])
  assert.throws(()=>validateAssumptions(bad),undefined,JSON.stringify(bad));
});
test('assumptions ride the envelope only when present',async()=>{
 const sent=[];
 const bridge=new Bridge({url:'http://127.0.0.1:3009',token:'t',fetchImpl:async(url,args)=>{sent.push(JSON.parse(args.body));return {ok:true,json:async()=>({})};}});
 const state={session:'s',epoch:1,observedAt:2};
 await bridge.act({type:'break',ticks:20},state,'a',5000,'build',{minHealth:10});
 assert.deepEqual(sent[0].assumes,{minHealth:10});
 await bridge.act({type:'jump'},state,'b',5000);
 assert.ok(!('assumes' in sent[1]),'no empty assumes field on a decision that assumed nothing');
});
test('an outcome carries a typed failure the caller can match on later',async()=>{
 const state={online:true,canAct:true,navigationAvailable:true,session:'w',epoch:1,phase:'idle',acting:false,x:0,z:0};
 const bridge={state:async()=>({...state,observedAt:Date.now()}),stop:async()=>{state.acting=false;},
   act:async(a,s,id)=>{Object.assign(state,{phase:'navigating',acting:true,actionId:id});},lease:async()=>{}};
 const seen=[];
 const agent=new Supervisor({bridge,planner:{interpret:()=>{throw Error('no');}},site:{x:200,z:200},emit:e=>seen.push(e)});
 await agent.order('go to site');
 Object.assign(state,{phase:'blocked',acting:false,reason:'No observed movement for 15 seconds',
   outcome:{failure:'no_progress',status:'blocked',progress:0,stagnantTicks:300}});
 await agent.poll();
 const outcome=seen.find(e=>e.kind==='outcome');
 assert.equal(outcome.failure,'no_progress');
 assert.ok(FAILURES.includes(outcome.failure));
 assert.equal(outcome.outcome.stagnantTicks,300,'the diagnosis reaches the caller, not just the verdict');
});
