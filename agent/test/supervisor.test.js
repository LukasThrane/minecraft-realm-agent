import test from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor } from '../src/supervisor.js';
import { directCommand, validateAction } from '../src/commands.js';
test('reflex phase cannot hide a completed safety-preempted action',async()=>{
 const fixtureState=fixture();
 await fixtureState.agent.order('go to site');
 const id=fixtureState.agent.active.id;
 const events=[];fixtureState.agent.emit=event=>events.push(event);
 Object.assign(fixtureState.state,{acting:false,phase:'reflex',reflex:'retreat',outcome:{actionId:id,status:'cancelled',failure:'safety_preempted',reason:'Retreat'}});
 await fixtureState.agent.poll();
 assert.equal(fixtureState.agent.active,null);
 assert.equal(events.find(event=>event.kind==='outcome').failure,'safety_preempted');
});
test('a queued action waiting on a reflex renews its lease rather than stopping',async()=>{
 const fixtureState=fixture();
 await fixtureState.agent.order('go to site');
 const id=fixtureState.agent.active.id;
 fixtureState.agent.active.submittedAt=Date.now()-5000;
 Object.assign(fixtureState.state,{actionId:'previous',pendingActionId:id,acting:false,phase:'reflex',reflex:'retreat'});
 await fixtureState.agent.poll();
 assert.equal(fixtureState.calls.at(-1),'lease');
 assert.equal(fixtureState.agent.active.id,id);
});
function fixture(planner = { interpret: async () => ({ type:'navigate',x:10,z:10 }) }) {
  const calls=[]; const state={online:true,canAct:true,navigationAvailable:true,session:'world1',epoch:1,phase:'idle',acting:false,x:0,z:0};
  const bridge={ state:async()=>({...state,observedAt:Date.now()}),
    stop:async()=>{calls.push('stop');state.epoch++;state.phase='stopped';state.acting=false;},
    act:async(action,s,id)=>{calls.push(action.type==='navigate'?{x:action.x,z:action.z}:action);Object.assign(state,{phase:'navigating',acting:true,actionId:id});},
    lease:async()=>calls.push('lease') };
  return {agent:new Supervisor({bridge,planner,site:{x:200,z:200}}),calls,state,bridge};
}
test('plain navigation and emergency words bypass inference',async()=>{
 const f=fixture({interpret:()=>{throw Error('must not call model');}});
 await f.agent.order('walk to 200, 200'); assert.deepEqual(f.calls,['stop',{x:200,z:200}]);
 await f.agent.order('STOP');assert.equal(f.agent.active,null);assert.equal(f.calls.at(-1),'stop');
});
test('late model response cannot move after stop',async()=>{
 let resolve, entered;const ready=new Promise(r=>entered=r);
 const f=fixture({interpret:()=>{entered();return new Promise(r=>resolve=r);}});
 const order=f.agent.order('please head towards the clearing');await ready;await f.agent.stop();resolve({type:'navigate',x:2,z:3});await order;
 assert.equal(f.calls.filter(x=>typeof x==='object').length,0);
});
test('new instruction invalidates older model response',async()=>{
 let resolve,entered;const ready=new Promise(r=>entered=r);
 const f=fixture({interpret:()=>{entered();return new Promise(r=>resolve=r);}});
 const old=f.agent.order('some goal');await ready;await f.agent.order('go to 8 9');resolve({type:'navigate',x:1,z:2});await old;
 assert.deepEqual(f.calls.filter(x=>typeof x==='object'),[{x:8,z:9}]);
});
test('world change during inference requires a fresh instruction',async()=>{
 const f=fixture({interpret:async()=>{f.state.session='world2';return {type:'navigate',x:1,z:1};}});
 await assert.rejects(f.agent.order('find the site'),/World changed/);
});
test('menu queues navigation until gameplay resumes',async()=>{
 const f=fixture();f.state.canAct=false;f.agent.readyPollMs=1;
 let queued;const ready=new Promise(r=>queued=r);f.agent.emit=e=>{if(e.kind==='waiting_for_gameplay')queued();};
 const order=f.agent.order('go to site');await ready;
 assert.equal(f.calls.filter(x=>typeof x==='object').length,0);
 f.state.canAct=true;await order;assert.deepEqual(f.calls.at(-1),{x:200,z:200});
});
test('stop cancels a command waiting for the menu to close',async()=>{
 const f=fixture();f.state.canAct=false;f.agent.readyPollMs=1;
 let queued;const ready=new Promise(r=>queued=r);f.agent.emit=e=>{if(e.kind==='waiting_for_gameplay')queued();};
 const order=f.agent.order('go to site');const rejected=assert.rejects(order,{name:'AbortError'});
 await ready;await f.agent.stop();f.state.canAct=true;await rejected;
 assert.equal(f.calls.filter(x=>typeof x==='object').length,0);
});
test('F8 control epoch change cancels queued navigation',async()=>{
 const f=fixture();f.state.canAct=false;f.agent.readyPollMs=1;
 let queued;const ready=new Promise(r=>queued=r);f.agent.emit=e=>{if(e.kind==='waiting_for_gameplay')queued();};
 const order=f.agent.order('go to site');await ready;f.state.epoch++;f.state.canAct=true;
 await assert.rejects(order,/Control changed/);
});
test('menu wait expires rather than moving much later',async()=>{
 const f=fixture();f.state.canAct=false;f.agent.readyPollMs=1;f.agent.readyTimeoutMs=5;
 await assert.rejects(f.agent.order('go to site'),/expired/);
});
test('absent navigation backend refuses control',async()=>{
 const f=fixture();f.state.navigationAvailable=false;await assert.rejects(f.agent.order('go to site'),/Baritone/);
});
test('poll heartbeats only the owned running action and releases ownership on success',async()=>{
 const f=fixture();await f.agent.order('go to site');await f.agent.poll();assert.equal(f.calls.at(-1),'lease');
 Object.assign(f.state,{phase:'succeeded',acting:false});await f.agent.poll();assert.equal(f.agent.active,null);
});
test('bounded low-level actions and their bounds',()=>{
 assert.deepEqual(directCommand('forward 20',{x:0,z:0}),{type:'move',direction:'forward',ticks:20});
 assert.deepEqual(directCommand('back',{x:0,z:0}),{type:'move',direction:'back',ticks:10});
 assert.deepEqual(directCommand('turn -90',{x:0,z:0}),{type:'look',yaw:-90,pitch:0,relative:true});
 assert.deepEqual(directCommand('slot 3',{x:0,z:0}),{type:'select',slot:3});
 assert.deepEqual(directCommand('jump',{x:0,z:0}),{type:'jump'});
 assert.deepEqual(directCommand('face 90 10',{x:0,z:0}),{type:'look',yaw:90,pitch:10,relative:false});
 assert.equal(directCommand('look 16',{x:0,z:0}),null,'look stays the observation command');
 for (const bad of [{type:'move',direction:'up',ticks:5},{type:'move',direction:'forward',ticks:0},{type:'move',direction:'forward',ticks:101},{type:'select',slot:9},{type:'look',yaw:NaN,pitch:0},{type:'look',yaw:0,pitch:200}])
   assert.throws(()=>validateAction(bad));
});
test('a low-level action goes through the same authority as navigation',async()=>{
 const f=fixture({interpret:()=>{throw Error('must not call model');}});
 await f.agent.order('forward 20');
 assert.deepEqual(f.calls,['stop',{type:'move',direction:'forward',ticks:20}]);
 assert.equal(f.agent.active.id.length,36);
 await f.agent.stop();assert.equal(f.agent.active,null);
});
test('a refused lease does not fail the running action',async()=>{
 const f=fixture();await f.agent.order('go to site');
 const seen=[];f.agent.emit=e=>seen.push(e);
 f.bridge.lease=async()=>{throw Error('Bridge 409: {"error":"Stale session or control epoch"}');};
 await f.agent.poll();
 assert.equal(f.agent.active?.id?.length,36,'the action is still owned');
 assert.match(seen.find(e=>e.kind==='lease_refused').message,/Stale session or control epoch/);
 Object.assign(f.state,{phase:'succeeded',acting:false});await f.agent.poll();
 assert.equal(f.agent.active,null,'the real outcome still arrives');
});
test('blocked action is not automatically retried',async()=>{
 const f=fixture();await f.agent.order('go to site');Object.assign(f.state,{phase:'blocked',acting:false});await f.agent.poll();await f.agent.poll();
 assert.equal(f.calls.filter(x=>typeof x==='object').length,1);
});
test('block modification is the only thing in the build scope',async()=>{
 const { scopeFor } = await import('../src/commands.js');
 assert.deepEqual(directCommand('break',{x:0,z:0}),{type:'break',ticks:100});
 assert.deepEqual(directCommand('mine 40',{x:0,z:0}),{type:'break',ticks:40});
 assert.deepEqual(directCommand('place',{x:0,z:0}),{type:'place'});
 assert.equal(scopeFor({type:'break',ticks:10}),'build');
 assert.equal(scopeFor({type:'place'}),'build');
 for (const travel of ['navigate','move','look','jump','select','respawn']) assert.equal(scopeFor({type:travel}),'travel');
 assert.throws(()=>validateAction({type:'break',ticks:0}));
 assert.throws(()=>validateAction({type:'break',ticks:201}));
});
test('a break carries the build scope all the way to the bridge',async()=>{
 const f=fixture({interpret:()=>{throw Error('must not call model');}});
 const sent=[];
 f.bridge.act=async(action,state,id,deadlineMs,scope)=>{sent.push({action,deadlineMs,scope});Object.assign(f.state,{phase:'breaking',acting:true,actionId:id});};
 const agent=new Supervisor({bridge:f.bridge,planner:{interpret:()=>{throw Error('no');}},site:{x:200,z:200}});
 await agent.order('break 40');
 assert.deepEqual(sent[0].action,{type:'break',ticks:40});
 assert.equal(sent[0].scope,'build');
 assert.equal(sent[0].deadlineMs,40*50+5000);
});
test('forbidden actions and invalid coordinates fail closed',()=>{
 for(const action of [{type:'mine'}, {type:'navigate',x:NaN,z:0},{type:'navigate',x:1.5,z:0},{type:'navigate',x:30_000_000,z:0}]) assert.throws(()=>validateAction(action));
 assert.equal(directCommand('mine diamonds',{x:200,z:200}),null);
});

test('survival event ring is journaled once across repeated polls and new sessions',async()=>{
  const f=fixture();const events=[];f.agent.emit=e=>events.push(e);
  f.state.survivalEvents=[{clientTick:10,event:'start',why:'entity-1 exposed'},{clientTick:30,event:'persist',why:'pursuit'}];
  await f.agent.poll();await f.agent.poll();
  assert.equal(events.filter(e=>e.kind==='survival').length,2);
  f.state.session='world2';f.state.survivalEvents=[{clientTick:2,event:'end',why:'clear'}];
  await f.agent.poll();
  assert.equal(events.filter(e=>e.kind==='survival').length,3);
});
