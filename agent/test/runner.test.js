import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner, Attempts, signature, CONTINUE } from '../src/runner.js';
function harness({ decisions = [], state = {} } = {}) {
  const world = { online:true, canAct:true, acting:false, dead:false, session:'w', epoch:1, phase:'idle',
    progress:1, stagnantTicks:0, x:0, z:0, observedAt:Date.now(), ...state };
  const dispatched = [], stops = [];
  const agent = { emit: () => {}, poll: async () => ({ ...world, observedAt: Date.now() }),
    dispatch: async (action, assumes) => { dispatched.push({ action, assumes }); return `id-${dispatched.length}`; },
    stop: async () => { stops.push(1); } };
  const bridge = { observe: async () => ({ online:true, self:{}, entities:[], inventory:{items:[]} }), history: async () => ({ samples: [] }) };
  let index = 0;
  const planner = { decide: async () => decisions[Math.min(index++, decisions.length - 1)] };
  const events = [];
  const runner = new Runner({ agent, bridge, planner, goal: 'test', emit: e => events.push(e), deliberateEveryMs: 0 });
  return { runner, dispatched, stops, events, world, agent };
}
test('deliberation never blocks the body',async()=>{
 let release;const slow=new Promise(r=>release=r);
 const h=harness({decisions:[]});
 h.runner.planner={decide:()=>slow};
 const started=Date.now();
 await h.runner.cycle();               // starts thinking
 await h.runner.cycle();               // must not wait for it
 assert.ok(Date.now()-started<200,'cycles returned while a decision was still in flight');
 assert.equal(h.dispatched.length,0);
 release({type:'jump',why:'because'});
 await h.runner.thinking;
 await h.runner.cycle();
 assert.equal(h.dispatched.length,1);
});
test('continue is a real answer that costs no interruption',async()=>{
 const h=harness({decisions:[{type:CONTINUE,why:'still walking'}]});
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.equal(h.dispatched.length,0);
 assert.equal(h.stops.length,0,'a continue must not stop the body');
 assert.match(h.events.find(e=>e.kind==='continue').message,/still walking/);
});
test('a repeated typed failure is refused rather than looped',async()=>{
 const h=harness({decisions:[{type:'navigate',x:5,z:5,why:'try again'}]});
 for(let i=0;i<3;i++) h.runner.attempts.record({type:'navigate',x:5,z:5},'no_progress');
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.equal(h.dispatched.length,0);
 assert.match(h.events.find(e=>e.kind==='decision_banned').message,/already failed 3 times \(no_progress\)/);
});
test('a success clears the failure record for that action',()=>{
 const attempts=new Attempts();
 attempts.record({type:'navigate',x:1,z:2},'no_progress');
 attempts.record({type:'navigate',x:1,z:2},'no_progress');
 assert.match(attempts.summary(),/navigate:1,2: 2x no_progress/);
 attempts.record({type:'navigate',x:1,z:2},'');
 assert.equal(attempts.summary(),'');
});
test('an invalid or out-of-vocabulary decision is rejected, not executed',async()=>{
 const h=harness({decisions:[{type:'mine_diamonds',why:'greedy'}]});
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.equal(h.dispatched.length,0);
 assert.match(h.events.find(e=>e.kind==='decision_rejected').message,/Unsupported action type/);
});
test('outcomes are matched back to the action that caused them',async()=>{
 const h=harness({decisions:[{type:'jump',why:'up'}]});
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 h.runner.observeOutcome({id:'id-1',phase:'blocked',failure:'precondition',outcome:{progress:0,stagnantTicks:5}});
 assert.deepEqual(h.runner.recent.at(-1),{action:'jump',status:'blocked',failure:'precondition',progress:0,stagnantTicks:5});
 assert.equal(signature({type:'navigate',x:1,z:2}),'navigate:1,2');
});
test('the action budget stops the run instead of running forever',async()=>{
 const h=harness({decisions:[{type:'jump',why:'again'}]});
 h.runner.maxActions=1;
 for(let i=0;i<3;i++){await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();}
 assert.equal(h.dispatched.length,1);
 assert.ok(h.runner.stopped);
});
test('a rejection is fed back to the next deliberation instead of being repeated blindly',async()=>{
 const seen=[];
 const h=harness({decisions:[{type:'navigate',why:'no coordinates'}]});
 h.runner.planner={decide:async input=>{seen.push(input.rejection);return {type:'navigate',why:'again'};}};
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.equal(h.runner.rejection.length>0,true);
 await h.runner.cycle();await h.runner.thinking;
 assert.match(seen.at(-1)??'',/navigate/,'the next prompt carries what was wrong with the last answer');
});
test('a run that only produces unusable decisions stops instead of looping forever',async()=>{
 const h=harness({decisions:[{type:'navigate',why:'still no coordinates'}]});
 h.runner.rejectionLimit=3;
 for(let i=0;i<5;i++){await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();}
 assert.ok(h.runner.stopped);
 assert.match(h.events.find(e=>e.kind==='deliberation_stuck').message,/stopping rather than looping/);
 assert.equal(h.dispatched.length,0);
});
test('restating the running action is treated as continue, whatever the model called it',async()=>{
 const h=harness({decisions:[{type:'navigate',x:200,z:200,why:'go'}],state:{acting:false}});
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.equal(h.dispatched.length,1,'first one dispatches');
 h.world.acting=true;h.world.progress=1;
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.equal(h.dispatched.length,1,'an identical goal must not restart the pathfinder');
 assert.match(h.events.filter(e=>e.kind==='continue').at(-1).message,/already running, progress 1.00/);
 h.world.progress=0;
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.equal(h.dispatched.length,2,'a stalled identical goal is allowed to be re-issued');
});
test('done ends the run instead of re-issuing a finished goal',async()=>{
 const h=harness({decisions:[{type:'done',why:'arrived at 200,200'}]});
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.ok(h.runner.stopped);
 assert.equal(h.dispatched.length,0);
 assert.match(h.events.find(e=>e.kind==='goal_reached').message,/arrived at 200,200/);
});
test('the safety tier is armed in the client before anything moves, and disarmed after',async()=>{
 const calls=[];
 const h=harness({decisions:[{type:CONTINUE,why:'idle'}]});
 h.runner.bridge.reflex=async(state,armed)=>{calls.push(armed);return {armed};};
 h.runner.bridge.state=async()=>({session:'w',epoch:1});
 const controller=new AbortController();
 h.runner.cycleMs=1;
 const running=h.runner.run(controller.signal);
 await new Promise(r=>setTimeout(r,30));
 controller.abort();
 await running;
 assert.deepEqual(calls,[true,false],'armed on entry, disarmed on exit');
 assert.match(h.events.find(e=>e.kind==='reflex_armed').message,/armed in the client/);
});
test('a run still starts when the client cannot arm reflexes, and says so',async()=>{
 const h=harness({decisions:[{type:CONTINUE,why:'idle'}]});
 h.runner.bridge.reflex=async()=>{throw Error('Bridge 404');};
 h.runner.bridge.state=async()=>({session:'w',epoch:1});
 const controller=new AbortController();h.runner.cycleMs=1;
 const running=h.runner.run(controller.signal);
 await new Promise(r=>setTimeout(r,30));controller.abort();await running;
 assert.match(h.events.find(e=>e.kind==='reflex_unavailable').message,/Could not arm safety reflexes/);
});
test('navigating to where we already stand is refused and the planner is told',async()=>{
 const h=harness({decisions:[{type:'navigate',x:200,z:200,why:'go there'}],state:{x:200.4,z:199.1}});
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.equal(h.dispatched.length,0);
 assert.match(h.events.find(e=>e.kind==='already_satisfied').message,/Already standing at 200,200/);
 assert.match(h.runner.rejection,/Answer done if the goal is met/);
});
test('missing duration fields get the obvious default instead of wasting a cycle',async()=>{
 const { withDefaults } = await import('../src/runner.js');
 assert.equal(withDefaults({type:'move',direction:'forward'}).ticks,20);
 assert.equal(withDefaults({type:'move',direction:'forward',ticks:1}).ticks,20,'a one-tick step is not a real answer');
 assert.equal(withDefaults({type:'break'}).ticks,100);
 assert.equal(withDefaults({type:'select'}).slot,0);
 assert.equal(withDefaults({type:'move',direction:'left',ticks:40}).ticks,40,'a real answer is left alone');
 const h=harness({decisions:[{type:'move',direction:'forward',why:'step'}]});
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.deepEqual(h.dispatched[0].action,{type:'move',direction:'forward',ticks:20});
});
