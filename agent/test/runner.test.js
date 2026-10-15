import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../src/runner.js';
import { AgentMemory } from '../src/memory.js';
import { SkillExecutor } from '../src/skills.js';
import { Planner } from '../src/planner.js';
import { DependencyPlanner } from '../src/dependencies.js';

const objective = (id='wood') => ({id,parent:null,title:'Collect building wood',success:'Have the material budget',status:'planned'});
function harness({mind, execute}={}) {
  const state={session:'s',epoch:1,worldKey:'world',online:true,canAct:true,skillsVersion:4,reflexArmed:true,health:20,food:20,x:0,y:64,z:0};
  const inventory=[]; const calls=[]; const events=[];
  const bridge={state:async()=>({...state,observedAt:Date.now()}),observe:async()=>({session:state.session,online:true,fresh:true,observedAt:Date.now(),inventory:{items:inventory},stations:[]}),
    stop:async()=>{state.acting=false;state.stopPending=false;state.pendingActionId=null;},reflex:async()=>{}};
  const skills=new SkillExecutor(bridge);
  skills.execute=execute??(async(spec,signal)=>{
    calls.push(spec);state.acting=true;
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  const runner=new Runner({agent:{stop:bridge.stop},bridge,skills,mind:mind??{turn:async()=>{},close:async()=>{}},goal:'Build a house',emit:e=>events.push(e)});
  runner.memory.setPlan([objective(),objective('stone')],0);
  return {runner,state,inventory,calls,events,bridge,skills};
}
const gather = {objectiveId:'wood',kind:'gather',item:'oak_log',count:48,why:'Whole house budget'};

test('plans never auto-start and completing a task returns to the agent',async()=>{
  let finish; const h=harness({execute:()=>new Promise(resolve=>{finish=resolve;})});
  await h.runner.cycle();await h.runner.thinking;
  assert.equal(h.runner.active,null);
  const result=await h.runner.tool('start_task',gather);
  assert.equal(result.status,'requested');
  const active=h.runner.active;finish();await active.finished;
  assert.equal(active.record.status,'completed');assert.equal(h.runner.active,null);
  await h.runner.cycle();await h.runner.thinking;
  assert.equal(h.runner.active,null);assert.equal(h.runner.actions,1);
});
test('a second task cannot replace work without explicit cancellation',async()=>{
  const h=harness();await h.runner.tool('start_task',gather);
  await assert.rejects(h.runner.tool('start_task',{...gather,objectiveId:'stone',item:'cobblestone'}),/owns the body/);
  await assert.rejects(h.runner.tool('set_plan',{revision:1,nodes:[objective('stone')]}),/Pause or cancel/);
  const id=h.runner.active.record.id;
  h.runner.active.record.startedAt=Date.now()-60000; // past the commitment window; this test is about the control path
  await h.runner.tool('pause_task',{taskId:id,why:'Eat first'});
  assert.equal(h.state.acting,false);assert.equal(h.runner.active,null);
  assert.equal(h.runner.memory.data.tasks[0].status,'suspended');
});
test('gather resume preserves the original quota',async()=>{
  const h=harness();await h.runner.tool('start_task',gather);
  const id=h.runner.active.record.id;
  h.runner.active.record.startedAt=Date.now()-60000; // past the commitment window; this test is about the control path
  await h.runner.tool('pause_task',{taskId:id,why:'prepare'});
  h.inventory.push({item:'minecraft:oak_log',count:18,slot:0});
  await h.runner.tool('resume_task',{taskId:id,why:'continue expedition'});
  assert.equal(h.calls[1].targetTotal,48);
  assert.equal(h.calls[1].resumeAfterEating,true);
  await h.runner.release('cancelled','test complete');
});

test('a safety update preserves a generated strategic plan without permitting stale execution',async()=>{
  const answers=[{tool:'set_plan',args:{nodes:[objective()]}},{tool:'yield',args:{}}];
  const executed=[];let updates=0;
  const planner=new Planner({model:'cheap',ollamaUrl:'http://unused'},async()=>({ok:true,json:async()=>({message:{content:JSON.stringify(answers.shift())}})}));
  await planner.turn({},async(name,args)=>{
    if(name==='_updates') return ++updates===2?{changed:true,operatorMessages:[],briefing:{state:{reflex:'eat'}}}:{changed:false};
    executed.push(name);return {};
  });
  assert.equal(executed.filter(name=>name==='set_plan').length,1);
});
test('operator input invalidates queued commands from an older inference',async()=>{
  const h=harness();const controller=new AbortController();
  const result=h.runner.queueTool('start_task',gather,h.runner.revision,controller.signal);
  h.runner.tell('Do not mine. Eat now.');await h.runner.cycle();
  assert.match((await result).error,/Obsolete/);assert.equal(h.calls.length,0);await h.runner.thinking;
});
test('operator input during a snapshot fences the later dispatch',async()=>{
  const h=harness();const observe=h.bridge.observe;
  h.bridge.observe=async()=>{h.runner.tell('cancel that');return observe();};
  await assert.rejects(h.runner.start(gather),/obsolete/);assert.equal(h.calls.length,0);
});
test('safety permits thinking and planning but blocks task starts',async()=>{
  let turns=0;const h=harness({mind:{turn:async()=>{turns++;}}});
  h.state.reflex='retreat';await h.runner.cycle();await h.runner.thinking;
  assert.equal(turns,1);await assert.rejects(h.runner.start(gather),/unavailable/);
  h.runner.memory.setPlan([objective()],1);
});
test('safety outcomes suspend work without automatic resume',async()=>{
  const h=harness({execute:async()=>{throw Object.assign(Error('Eating reflex'),{failure:'safety_preempted'});}});
  await h.runner.start(gather);const active=h.runner.active;await active.finished;
  assert.equal(active.record.status,'suspended');
  await h.runner.cycle();await h.runner.thinking;
  assert.equal(h.runner.active,null);assert.equal(h.runner.actions,1);
});
test('unconfirmed release retains ownership and refuses replacement',async()=>{
  const h=harness();await h.runner.start(gather);
  h.runner.agent.stop=async()=>{throw Error('connection lost');};
  await assert.rejects(h.runner.release('cancelled','stop'),/connection lost/);
  assert.equal(h.runner.active.record.status,'cancelling');
  await assert.rejects(h.runner.start(gather),/owns the body/);
});
test('restart preserves dialogue and plan but suspends active tasks',()=>{
  const directory=mkdtempSync(join(tmpdir(),'windove-memory-'));
  try {
    const path=join(directory,'memory.json');const memory=new AgentMemory(path);
    memory.setPlan([objective()],0);memory.message('user','Do not make another pickaxe');
    memory.data.tasks.push({id:'task',status:'running'});memory.event('task_started',{taskId:'task',why:'Build the house'});
    const reloaded=new AgentMemory(path);
    assert.equal(reloaded.data.tasks[0].status,'suspended');
    assert.equal(reloaded.data.plan[0].title,objective().title);
    assert.match(reloaded.data.conversation[0].content,/another pickaxe/);
    assert.equal(reloaded.query('Build the house')[0].taskId,'task');
  } finally {rmSync(directory,{recursive:true,force:true});}
});
test('plan validates parent cycles and revisions',()=>{
  const memory=new AgentMemory();
  assert.throws(()=>memory.setPlan([{...objective('a'),parent:'b'},{...objective('b'),parent:'a'}],0),/cyclic/);
  memory.setPlan([objective()],0);assert.throws(()=>memory.setPlan([],0),/Plan changed/);
});
test('tool errors return within the same model turn with conversation retained',async()=>{
  const answers=[{tool:'start_task',args:gather},{tool:'state',args:{}},{tool:'yield',args:{}}];const sent=[],seen=[];
  const planner=new Planner({model:'cheap',ollamaUrl:'http://unused'},async(_url,init)=>{
    sent.push(JSON.parse(init.body));return {ok:true,json:async()=>({message:{content:JSON.stringify(answers.shift())}})};
  });
  await planner.turn({conversation:[{role:'user',content:'Remember the house'}]},async(name)=>{
    seen.push(name);return name==='start_task'?{error:'Task busy; pause first'}:{};
  });
  assert.equal(sent.length,3);assert.ok(sent[1].messages.some(m=>m.content.includes('Task busy')));
  assert.ok(sent[0].messages.some(m=>m.content==='Remember the house'));assert.ok(seen.includes('_message'));
});
test('batch planning shares tools and reserves all kit targets',()=>{
  const planner=new DependencyPlanner();
  const targets=['iron_pickaxe','iron_axe','iron_shovel','iron_sword','iron_hoe','iron_helmet','iron_chestplate','iron_leggings','iron_boots'].map(item=>({item,count:1}));
  const plan=planner.planMany(targets);
  assert.equal(plan.status,'planned',plan.reason);assert.equal(plan.summary['minecraft:raw_iron'],35);
  assert.equal(plan.nodes.filter(n=>n.item==='minecraft:iron_pickaxe').length,1);
  for(const target of targets) assert.equal(plan.projectedInventory['minecraft:'+target.item],1);
  const already=planner.planMany(targets,Object.fromEntries(targets.map(t=>['minecraft:'+t.item,1])));
  assert.equal(already.nodes.length,0);
});
test('full kit cannot finish with only a pickaxe',async()=>{
  const h=harness();h.runner.memory.setPlan([{...objective(),status:'complete',targets:[{item:'iron_helmet',count:1}]}],1);
  h.inventory.push({item:'minecraft:iron_pickaxe',count:1,slot:0});
  await assert.rejects(h.runner.tool('finish_mission',{}),/Missing completion target/);
});
test('failed inference leaves work unchanged and never starts fallback work',async()=>{
  const h=harness({mind:{turn:async()=>{throw Error('timeout');}}});
  await h.runner.start(gather);const id=h.runner.active.record.id;
  await h.runner.cycle();await h.runner.thinking;
  assert.equal(h.runner.active.record.id,id);assert.equal(h.calls.length,1);
  assert.ok(h.events.some(e=>e.kind==='thinking_failed'));await h.runner.release('cancelled','test complete');
});

test('material reservations protect another objective during planning',async()=>{
  const h=harness();h.inventory.push({item:'minecraft:oak_log',count:8,slot:0});
  h.runner.memory.setPlan([{...objective(),reserves:{'minecraft:oak_log':8}},objective('stone')],1);
  const plan=await h.runner.tool('recipe_plan',{objectiveId:'stone',targets:[{item:'oak_planks',count:4}]});
  assert.equal(plan.summary['minecraft:oak_log'],1,'must collect a new log instead of spending house stock');
  const own=await h.runner.tool('recipe_plan',{objectiveId:'wood',targets:[{item:'oak_planks',count:4}]});
  assert.equal(own.summary['minecraft:oak_log'],undefined,'owner can use its own stock');
});

test('an eating sentence cannot masquerade as execution',async()=>{
  const h=harness();
  await assert.rejects(h.runner.tool('say',{text:'Eating to maintain health.'}),/report_task/);
  assert.equal(h.calls.length,0);assert.ok(!h.events.some(e=>e.kind==='say'));
  await h.runner.tool('say',{text:'I need to pause mining before I can eat.'});
  assert.ok(h.events.some(e=>e.kind==='say'));
});

test('named full-kit calculator includes axe and hoe and credits the held pickaxe',async()=>{
  const h=harness();h.inventory.push({item:'minecraft:iron_pickaxe',count:1,slot:0});
  const result=await h.runner.tool('recipe_plan',{kit:'iron_toolset_and_armor'});
  assert.equal(result.targets.length,9);assert.equal(result.summary['minecraft:raw_iron'],32);
  assert.ok(result.targets.some(t=>t.item==='minecraft:iron_axe'));
  assert.ok(result.targets.some(t=>t.item==='minecraft:iron_hoe'));
});

test('an operator kit mission cannot finish when the model only closes ingredient objectives',async()=>{
  const h=harness();h.runner.retarget('get full iron toolsets and armor');
  h.runner.memory.setPlan([{...objective(),status:'complete',targets:[{item:'raw_iron',count:32}]}],1);
  h.inventory.push({item:'minecraft:raw_iron',count:32,slot:0},{item:'minecraft:iron_pickaxe',count:1,slot:1});
  await assert.rejects(h.runner.tool('finish_mission',{}),/Mission still needs/);
  assert.equal(h.runner.stopped,false);
});

test('a completed kit does not require consumed intermediate materials to remain held',async()=>{
  const h=harness();h.runner.retarget('get full iron toolsets and armor');
  h.runner.memory.setPlan([{...objective(),status:'complete',targets:[{item:'raw_iron',count:32}]}],1);
  h.inventory.push(...h.runner.memory.data.missionTargets.map((t,slot)=>({...t,slot})));
  assert.equal((await h.runner.tool('finish_mission',{})).complete,true);
});

test('empty goal is read-only and preserves mission, plan and review',()=>{
  const h=harness();const revision=h.runner.revision;
  assert.equal(h.runner.retarget('   '),'Build a house');
  assert.equal(h.runner.memory.data.mission,'Build a house');assert.equal(h.runner.revision,revision);
  assert.equal(h.runner.memory.data.plan.length,2);
});

test('messages and safety updates do not cancel slow inference, and stale mutations remain fenced',async()=>{
  let finish,signal;const h=harness({mind:{turn:async(_context,_tool,s)=>{signal=s;await new Promise(r=>finish=r);}}});
  await h.runner.cycle();await new Promise(r=>setImmediate(r));
  const thinking=h.runner.thinking, revision=h.runner.revision;
  h.runner.tell('hello');h.runner.tell('what are you doing?');h.state.reflex='retreat';await h.runner.cycle();
  assert.equal(h.runner.thinking,thinking);assert.equal(signal.aborted,false);
  const stale=h.runner.queueTool('start_task',gather,revision,signal);await h.runner.cycle();
  assert.match((await stale).error,/Obsolete/);assert.equal(h.calls.length,0);
  const update=h.runner.queueTool('_updates',{},revision,signal);await h.runner.cycle();
  const delivered=await update;assert.deepEqual(delivered.operatorMessages,['hello','what are you doing?']);
  assert.equal(delivered.briefing.state.reflex,'retreat');assert.equal(delivered.revision,h.runner.revision);
  finish();await thinking;
});

test('live update replaces stale mutation with a short reply within one planner turn',async()=>{
  const answers=[{tool:'start_task',args:gather},{tool:'say',args:{text:'I am reviewing your mission; no task has started.'}},{tool:'yield',args:{}}];
  let updates=0;const sent=[],executed=[];
  const planner=new Planner({model:'cheap',ollamaUrl:'http://unused'},async(_url,init)=>{
    sent.push(JSON.parse(init.body));return {ok:true,json:async()=>({message:{content:JSON.stringify(answers.shift())}})};
  });
  await planner.turn({conversation:[]},async(name,args)=>{
    if(name==='_updates') return ++updates===2?{changed:true,revision:1,operatorMessages:['hello?'],briefing:{activeTask:null}}:{changed:false};
    executed.push(name);return {};
  });
  assert.ok(!executed.includes('start_task'));assert.ok(executed.includes('say'));
  // The reply turn keeps every tool: "eat right now" has to be answered by eating, not only by
  // saying so, and narrowing the choice to say is what stopped that happening.
  assert.ok(sent[1].format.properties.tool.enum.includes('start_task'));
  assert.ok(sent[1].messages.some(m=>m.content.includes('hello?')));
  assert.ok(sent[1].messages.at(-1).content.includes('not carried out by describing it'));
});

test('an unanswered message survives inference failure into the next review',async()=>{
  const received=[];const h=harness({mind:{turn:async context=>{received.push(context.operatorMessages);throw Error('timeout');}}});
  h.runner.tell('What are you doing?');
  await h.runner.cycle();await h.runner.thinking;
  h.runner.forceReview=true;await h.runner.cycle();await h.runner.thinking;
  assert.deepEqual(received,[['What are you doing?'],['What are you doing?']]);
});

test('a routine review is capped at one decision and pays no charter',async()=>{
  const config={model:'cheap',ollamaUrl:'http://unused',charter:'CHARTER SENTINEL TEXT'};
  const routine=[];
  const looping=new Planner(config,async(_url,init)=>{
    routine.push(JSON.parse(init.body));
    return {ok:true,json:async()=>({message:{content:JSON.stringify({tool:'state',args:{}})}})};
  });
  await looping.turn({turnKind:'routine',conversation:[]},async()=>({}));
  assert.equal(routine.length,3,'a routine review may not run a twelve-call loop');
  assert.ok(!routine[0].messages[0].content.includes('CHARTER SENTINEL TEXT'));
  assert.ok(routine[0].options.num_predict<=300);
  const planning=[];
  const writing=new Planner(config,async(_url,init)=>{
    planning.push(JSON.parse(init.body));
    return {ok:true,json:async()=>({message:{content:JSON.stringify({tool:'yield',args:{}})}})};
  });
  await writing.turn({turnKind:'planning',conversation:[]},async()=>({}));
  assert.ok(planning[0].messages[0].content.includes('CHARTER SENTINEL TEXT'));
});

test('the briefing is pinned ahead of trimming and stays in every call',async()=>{
  const sent=[];
  const planner=new Planner({model:'cheap',ollamaUrl:'http://unused',agentPromptChars:600},async(_url,init)=>{
    sent.push(JSON.parse(init.body));
    return {ok:true,json:async()=>({message:{content:JSON.stringify({tool:'state',args:{}})}})};
  });
  await planner.turn({turnKind:'routine',mission:'Build a house at the marked site',
    conversation:Array.from({length:6},(_,i)=>({role:'user',content:`older message ${i}`}))},
    async()=>({padding:'x'.repeat(400)}));
  for(const body of sent) assert.ok(body.messages[1].content.includes('Build a house at the marked site'),
    'the current briefing must survive trimming');
});

test('a finished task wakes the agent without voiding a decision already in flight',async()=>{
  let finish;const h=harness({execute:()=>new Promise(resolve=>{finish=resolve;})});
  await h.runner.tool('start_task',gather);
  const revision=h.runner.revision,active=h.runner.active;
  finish();await active.finished;
  assert.equal(h.runner.revision,revision,'a task outcome is a reason to look, not a fence');
  assert.equal(h.runner.forceReview,true);
});

test('a brief safety reflex is recorded, and only a persistent one costs a review',async()=>{
  let turns=0;const h=harness({mind:{turn:async()=>{turns++;},close:async()=>{}}});
  await h.runner.cycle();await h.runner.thinking;turns=0;
  h.runner.lastReview=Date.now();
  h.state.reflex='eat';await h.runner.cycle();await h.runner.thinking;
  assert.equal(turns,0,'one skeleton must not cost more inference than the expedition it interrupts');
  assert.ok(h.events.some(event=>event.kind==='safety'));
  h.runner.reflexSince=Date.now()-31000;await h.runner.cycle();await h.runner.thinking;
  assert.equal(turns,1,'safety that will not clear is the agent\'s problem');
});

test('a running task is not interrupted by the idle review clock',async()=>{
  let turns=0;const h=harness({mind:{turn:async()=>{turns++;},close:async()=>{}}});
  await h.runner.cycle();await h.runner.thinking;turns=0;
  await h.runner.tool('start_task',gather);
  h.runner.lastReview=Date.now()-60000;await h.runner.cycle();
  assert.equal(turns,0,'work in progress is not a question');
  h.runner.lastReview=Date.now()-310000;await h.runner.cycle();await h.runner.thinking;
  assert.equal(turns,1,'the long backstop still supervises');
  await h.runner.release('cancelled','test complete');
});

test('objective and task ids are matched the way a small model writes them',async()=>{
  const h=harness();
  await h.runner.tool('start_task',{...gather,objectiveId:'Collect-Building-Wood'});
  assert.equal(h.runner.active.record.objectiveId,'wood');
  assert.equal(h.runner.active.record.id,'t1','short ids are reproducible; UUIDs were invented instead');
  assert.equal((await h.runner.tool('report_task',{taskId:'current'})).id,'t1');
  h.runner.active.record.startedAt=Date.now()-60000; // past the commitment window; this test is about the control path
  await h.runner.tool('pause_task',{taskId:'t1',why:'test'});
  assert.equal(h.runner.memory.data.tasks[0].status,'suspended');
});

test('the briefing states what the mission still needs so no call is spent asking',async()=>{
  const h=harness();h.runner.retarget('get full iron toolsets and armor');
  h.inventory.push({item:'minecraft:iron_pickaxe',count:1,slot:0});
  const briefing=h.runner.briefing(await h.runner.snapshot());
  assert.equal(briefing.mission.complete,false);
  assert.ok(briefing.mission.missing.some(entry=>entry.item==='minecraft:iron_helmet'));
  assert.equal(briefing.materials.stillToGather['minecraft:raw_iron'],32);
});

test('eating preempts the running task rather than being refused',async()=>{
  const h=harness();await h.runner.tool('start_task',gather);
  assert.equal(h.runner.active.record.id,'t1');
  const result=await h.runner.tool('start_task',{objectiveId:'wood',kind:'eat',targetFood:20,why:'Operator said eat now'});
  assert.equal(result.suspended,'t1','the mining task is suspended, not the eating refused');
  assert.equal(h.runner.memory.data.tasks[0].status,'suspended');
  assert.equal(h.runner.active.record.spec.kind,'eat');
  assert.match(result.note,/resume_task/);
  await h.runner.release('cancelled','test complete');
});

test('a claim is checked against the activity that would make it true',async()=>{
  const h=harness();await h.runner.tool('start_task',gather);
  await assert.rejects(h.runner.tool('say',{text:'Eating now to restore health and food.'}),/the running task is gather/);
  await h.runner.tool('say',{text:'Gathering the logs the house needs.'});
  assert.ok(h.events.some(event=>event.kind==='say'));
  await h.runner.release('cancelled','test complete');
});

test('the briefing names the eating call when the state warrants it',async()=>{
  const h=harness();h.state.health=6;h.state.food=19;
  h.inventory.push({item:'minecraft:cooked_beef',count:8,slot:0});
  const briefing=h.runner.briefing(await h.runner.snapshot());
  assert.ok(briefing.attention.some(note=>note.includes('kind:"eat"')));
  h.state.health=20;h.state.food=20;
  assert.equal(h.runner.briefing(await h.runner.snapshot()).attention,undefined,'a healthy agent is not nagged');
});

test('a task gets a commitment window before it can be swapped for another',async()=>{
  const h=harness();await h.runner.tool('start_task',gather);
  await assert.rejects(h.runner.tool('pause_task',{taskId:'t1',why:'Preempt to craft instead'}),/commitment/);
  assert.equal(h.runner.active.record.id,'t1','the swap is refused, not the task');
  // The operator always outranks the window, and so does an honest cancellation.
  h.runner.unanswered.push('do something else');
  await h.runner.tool('pause_task',{taskId:'t1',why:'Operator asked'});
  assert.equal(h.runner.memory.data.tasks[0].status,'suspended');
});

test('an aged task may be paused normally',async()=>{
  const h=harness();await h.runner.tool('start_task',gather);
  h.runner.active.record.startedAt=Date.now()-60000;
  await h.runner.tool('pause_task',{taskId:'t1',why:'It has stalled'});
  assert.equal(h.runner.active,null);
});

test('tasks that die instantly back the review clock off instead of spinning',async()=>{
  const h=harness({execute:async()=>{throw Object.assign(Error('food floor reached'),{failure:'expedition_limit'});}});
  for (let attempt=0;attempt<2;attempt++) {
    await h.runner.start(gather);await h.runner.active?.finished;
    h.runner.memory.data.tasks.at(-1).status='suspended';
  }
  assert.equal(h.runner.quickFailures,2);
  h.runner.lastReview=Date.now()-60000;h.runner.forceReview=false;
  let turns=0;h.runner.mind={turn:async()=>{turns++;},close:async()=>{}};
  await h.runner.cycle();
  assert.equal(turns,0,'a minute is not long enough after two instant failures');
  // The operator always resets it: they have changed something the agent could not.
  h.runner.tell('I dropped food for you');
  await h.runner.cycle();await h.runner.thinking;
  assert.equal(turns,1);
});

test('a state condition never bans the step that hit it',async()=>{
  const h=harness({execute:async()=>{throw Object.assign(Error('expedition_limit: food floor reached'),{failure:'expedition_limit'});}});
  for (let attempt=0;attempt<4;attempt++) {
    await h.runner.start(gather);await h.runner.active?.finished;
  }
  assert.equal(h.runner.attempts.banned({type:'skill',kind:'gather',item:'minecraft:oak_log'}),'',
    'being hungry at that moment is not a reason to refuse gathering for the rest of the run');
});
