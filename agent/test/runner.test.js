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
 // A continue is only meaningful while something is running; that is its whole premise.
 const h=harness({decisions:[{type:CONTINUE,why:'still walking'}],state:{acting:true}});
 await h.runner.cycle();await h.runner.thinking;await h.runner.cycle();
 assert.equal(h.dispatched.length,0);
 assert.equal(h.stops.length,0,'a continue must not stop the body');
 assert.match(h.events.find(e=>e.kind==='continue').message,/still walking/);
});
test('continuing nothing is refused, and an idling run ends rather than idling forever',async()=>{
 // Observed live: after the goal was met the model answered continue with "already holding a
 // stone pickaxe" indefinitely. Continue was always accepted, so the run never ended and the
 // operator could not reach it. Nothing was running, so there was nothing to continue.
 const h=harness({decisions:[{type:CONTINUE,why:'Already holding a stone pickaxe.'}]});
 for(let cycle=0;cycle<8;cycle++){await h.runner.cycle();await h.runner.thinking;}
 assert.ok(h.events.some(e=>e.kind==='idle_continue'),'the model must be told continue is unavailable');
 assert.ok(h.events.some(e=>e.kind==='deliberation_stuck'));
 assert.equal(h.runner.stopped,true);
 assert.equal(h.dispatched.length,0);
});
test('a new goal redirects a run without tearing down what is running',async()=>{
 const h=harness({decisions:[{type:CONTINUE,why:'walking'}],state:{acting:true}});
 await h.runner.cycle();await h.runner.thinking;
 h.runner.decision={type:'navigate',x:9,z:9,why:'stale, for the old goal'};
 h.runner.retarget('build a house');
 assert.equal(h.runner.goal,'build a house');
 assert.equal(h.runner.decision,null,'a decision made for the previous goal must not be applied to this one');
 assert.equal(h.stops.length,0,'redirecting is not stopping');
 assert.ok(h.events.some(e=>e.kind==='goal_changed'));
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

/** A runner with a stubbed skill executor, so obtain can be driven without a client. */
function jobHarness({ decisions = [], run } = {}) {
  const world = { online:true, canAct:true, acting:false, dead:false, session:'w', epoch:1, phase:'idle',
    progress:1, stagnantTicks:0, x:0, z:0, observedAt:Date.now() };
  const dispatched = [], jobs = [];
  // The client keeps reporting an in-flight action until something actually stops it, which is
  // what made retargeting mid-chain fail live: the replacement job was refused by a client that
  // had never been told to let go.
  const client = { acting: false };
  const agent = { emit: () => {}, poll: async () => ({ ...world, observedAt: Date.now() }),
    dispatch: async action => { dispatched.push(action); return `id-${dispatched.length}`; },
    stop: async () => { client.acting = false; } };
  const carried = [];
  const bridge = { observe: async () => ({ online:true, self:{}, entities:[], inventory:{ items: carried } }),
    history: async () => ({ samples: [] }), state: async () => ({ ...world, acting: client.acting }) };
  let index = 0;
  const planner = { decide: async () => decisions[Math.min(index++, decisions.length - 1)] };
  const skills = { run: run ?? (async goal => { jobs.push(goal); client.acting = true; }) };
  const events = [];
  const runner = new Runner({ agent, bridge, planner, skills, goal: 'test', emit: e => events.push(e), deliberateEveryMs: 0 });
  // These tests are about job replacement and continuation, not about how often the runner thinks.
  // Deliberating on every cycle isolates them from the skip-while-progressing rule below.
  runner.jobCheckMs = 0;
  return { runner, dispatched, jobs, events, client, carried };
}

test('obtain reaches the skill executor and never the client action path',async()=>{
  // The wall this removes: the model's verbs were navigate/move/break/place/jump/select, so an
  // autonomous run could not craft anything at all.
  let resolveJob; const pending = new Promise(r => { resolveJob = r; });
  const h = jobHarness({ decisions:[{type:'obtain',item:'stone pickaxe',count:1,why:'need a better tool'}],
    run: async goal => { h.jobs.push(goal); await pending; } });
  await h.runner.cycle(); await h.runner.thinking; await h.runner.cycle();
  assert.deepEqual(h.jobs,[{item:'stone pickaxe',count:1}]);
  assert.equal(h.dispatched.length,0,'obtain is a job, not a client action');
  resolveJob(); await new Promise(r => setTimeout(r, 10));
});

test('a running job is continued, not restarted, by a repeated decision',async()=>{
  let resolveJob; const pending = new Promise(r => { resolveJob = r; });
  const h = jobHarness({ decisions:[{type:'obtain',item:'oak_log',count:6,why:'wood'}],
    run: async goal => { h.jobs.push(goal); await pending; } });
  for (let cycle = 0; cycle < 3; cycle++) { await h.runner.cycle(); await h.runner.thinking; }
  await h.runner.cycle();
  assert.equal(h.jobs.length,1,'the chain must not be cancelled and restarted every deliberation');
  assert.ok(h.events.some(e => e.kind === 'continue' && /still running/.test(e.message)));
  resolveJob();
});

test('a different decision cancels the running job and waits for the client to let go',async()=>{
  // Live failure this covers: aborting the executor unwinds this process but leaves the skill it
  // already dispatched running on the client, so the replacement was refused with
  // "Stop the current action before starting a skill goal" and the action then timed out.
  let aborted = false;
  const h = jobHarness({ decisions:[{type:'obtain',item:'oak_log',count:6,why:'wood'},
                                    {type:'navigate',x:10,z:10,direction:'forward',ticks:20,item:'',count:1,why:'move'}],
    run: async (goal, signal) => {
      h.jobs.push(goal); h.client.acting = true;
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(Error('aborted'),{name:'AbortError'})); }));
    } });
  await h.runner.cycle(); await h.runner.thinking; await h.runner.cycle();
  assert.equal(h.client.acting,true,'the client is mid-skill before the replacement arrives');
  await h.runner.thinking; await h.runner.cycle();
  assert.equal(aborted,true);
  assert.equal(h.client.acting,false,'the client must be released before anything replaces the job');
  assert.equal(h.dispatched.length,1);
  assert.equal(h.dispatched[0].type,'navigate');
});

test('one obtain replacing another leaves no action in flight',async()=>{
  const h = jobHarness({ decisions:[{type:'obtain',item:'oak_log',count:6,why:'wood'},
                                    {type:'obtain',item:'cobblestone',count:9,why:'changed my mind'}],
    run: async (goal, signal) => {
      h.jobs.push(goal); h.client.acting = true;
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'),{name:'AbortError'}))));
    } });
  await h.runner.cycle(); await h.runner.thinking; await h.runner.cycle();
  await h.runner.thinking; await h.runner.cycle();
  assert.deepEqual(h.jobs.map(job => job.item),['oak_log','cobblestone']);
  assert.ok(!h.events.some(e => e.kind === 'job_failed'),h.events.filter(e=>e.kind==='job_failed').map(e=>e.message).join('; '));
});

test('a failed job is remembered typed, so it is not proposed forever',async()=>{
  const h = jobHarness({ decisions:[{type:'obtain',item:'copper sword',count:1,why:'try it'}],
    run: async () => { throw Object.assign(Error('Cannot obtain minecraft:copper_sword: no supported acquisition method'),{failure:'precondition'}); } });
  for (let cycle = 0; cycle < 4; cycle++) { await h.runner.cycle(); await h.runner.thinking; await new Promise(r=>setTimeout(r,5)); }
  assert.match(h.runner.attempts.summary(),/obtain:copper sword/);
  assert.ok(h.events.some(e => e.kind === 'job_failed'));
});

test('obtain is refused rather than crashing when no executor is attached',async()=>{
  const h = harness({ decisions:[{type:'obtain',item:'stone pickaxe',count:1,why:'x'}] });
  await h.runner.cycle(); await h.runner.thinking; await h.runner.cycle();
  assert.ok(h.events.some(e => /no skill executor/.test(e.message)));
  assert.equal(h.dispatched.length,0);
});

test('a job that is progressing is not interrogated every cycle',async()=>{
  // Observed live: seven consecutive `continue` answers during one cobblestone gather. At the
  // measured ~11 tok/s each of those costs about five seconds to be told nothing changed.
  let decisions = 0;
  const h = jobHarness({ decisions:[{type:'obtain',item:'oak_log',count:6,why:'wood'}],
    run: async goal => { h.jobs.push(goal); h.client.acting = true; await new Promise(() => {}); } });
  h.runner.jobCheckMs = 60_000;
  h.runner.planner = { decide: async () => { decisions++; return {type:'obtain',item:'oak_log',count:6,why:'wood'}; } };
  await h.runner.cycle(); await h.runner.thinking; await h.runner.cycle();
  assert.equal(h.jobs.length,1);
  const afterStart = decisions;
  for (let cycle = 0; cycle < 6; cycle++) { await h.runner.cycle(); await h.runner.thinking; }
  assert.equal(decisions,afterStart,'a running, progressing job should cost no forward passes');
});

test('the operator is never made to wait for the skip',async()=>{
  const h = jobHarness({ decisions:[{type:'obtain',item:'oak_log',count:6,why:'wood'}],
    run: async goal => { h.jobs.push(goal); h.client.acting = true; await new Promise(() => {}); } });
  h.runner.jobCheckMs = 60_000;
  await h.runner.cycle(); await h.runner.thinking; await h.runner.cycle();
  assert.equal(h.runner.shouldDeliberate({progress:1}),false,'quiet while the job progresses');
  h.runner.retarget('something else');
  assert.equal(h.runner.shouldDeliberate({progress:1}),true,'a new goal is answered immediately');
});

test('asking for something already held is refused, and the run stops rather than looping',async()=>{
  // The livelock: the model asks for a stone pickaxe it is holding, the executor verifies it
  // instantly and reports success, the rejection counter resets because a valid action was
  // dispatched, and the next decision asks again. Forever.
  const h = jobHarness({ decisions:[{type:'obtain',item:'stone_pickaxe',count:1,why:'capability'}] });
  h.runner.jobCheckMs = 0;
  h.carried.push({ item:'minecraft:stone_pickaxe', count:1, slot:0 });
  for (let cycle = 0; cycle < 10; cycle++) { await h.runner.cycle(); await h.runner.thinking; }
  assert.equal(h.jobs.length,0,'a satisfied obtain must never be dispatched');
  assert.ok(h.events.some(e => e.kind === 'already_satisfied'));
  assert.ok(h.events.some(e => e.kind === 'deliberation_stuck'),'the run must end rather than idle');
});

test('an unsatisfied obtain still runs',async()=>{
  const h = jobHarness({ decisions:[{type:'obtain',item:'stone_pickaxe',count:1,why:'capability'}] });
  h.runner.jobCheckMs = 0;
  h.carried.push({ item:'minecraft:oak_log', count:1, slot:0 });
  await h.runner.cycle(); await h.runner.thinking; await h.runner.cycle();
  assert.deepEqual(h.jobs,[{item:'stone_pickaxe',count:1}]);
});
