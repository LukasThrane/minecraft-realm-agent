import test from 'node:test';
import assert from 'node:assert/strict';
import { Recovery } from '../src/recovery.js';
import { Supervisor } from '../src/supervisor.js';
import { validateAction, directCommand } from '../src/commands.js';
function fixture(over = {}) {
  const state = { online:true, canAct:false, navigationAvailable:true, session:'w', epoch:4, phase:'stopped',
    x:10, y:64, z:20, dead:true, deathScreen:true, hardcore:false, canRespawn:true, deathMessage:'Windove was slain by a zombie',
    deaths:1, lastDeathAt:1000, lastRespawnAt:0, ...over };
  const calls = [];
  const bridge = { state: async () => ({ ...state, observedAt: Date.now() }),
    respawn: async (s, id) => { calls.push(['respawn', s.epoch, id]); Object.assign(state, { dead:false, canRespawn:false, lastRespawnAt: Date.now() + 1, x:0, y:70, z:0 }); },
    stop: async () => calls.push(['stop']), navigate: async goal => calls.push(['navigate', goal]), lease: async () => calls.push(['lease']) };
  return { state, calls, bridge };
}
const events = list => ({ emit: e => list.push(e) });

test('death is respawned and verified against the client, not the accepted request',async()=>{
 const f=fixture();const seen=[];
 const decision=await new Recovery({bridge:f.bridge,planner:null,...events(seen),verifyMs:2000}).handle();
 assert.deepEqual([decision.type,decision.result],['respawn','succeeded']);
 assert.equal(f.calls[0][0],'respawn');
 assert.equal(f.calls[0][1],4,'must use the epoch observed after the death halt');
 const respawned=seen.find(e=>e.kind==='respawned');
 assert.match(respawned.message,/Respawned at 0, 70, 0/);
 assert.match(respawned.message,/previous goal was not resumed/);
 assert.match(seen.at(-1).message,/Death decision: respawn \(succeeded\)/);
});
test('an accepted respawn that never produces a live player is unverified, not success',async()=>{
 const f=fixture();f.bridge.respawn=async()=>{};
 const decision=await new Recovery({bridge:f.bridge,planner:null,...events([]),verifyMs:400}).handle();
 assert.deepEqual([decision.type,decision.result],['respawn','unverified']);
});
test('hardcore and a missing death screen wait instead of pressing anything',async()=>{
 for (const over of [{hardcore:true},{canRespawn:false,deathScreen:false}]) {
  const f=fixture(over);
  const decision=await new Recovery({bridge:f.bridge,planner:null,...events([])}).handle();
  assert.equal(decision.type,'wait');
  assert.equal(f.calls.length,0);
 }
});
test('repeated deaths stop respawning rather than looping into a spawn trap',async()=>{
 const f=fixture();const recovery=new Recovery({bridge:f.bridge,planner:null,...events([]),maxRespawns:2,verifyMs:500});
 for (let i=0;i<2;i++) { Object.assign(f.state,{dead:true,canRespawn:true}); await recovery.handle(); }
 Object.assign(f.state,{dead:true,canRespawn:true});
 const third=await recovery.handle();
 assert.equal(third.type,'wait');
 assert.match(third.why,/stopping/);
 assert.equal(f.calls.filter(c=>c[0]==='respawn').length,2);
});
test('a model refusal is honoured but a broken model still gets the character up',async()=>{
 const f=fixture();
 const waited=await new Recovery({bridge:f.bridge,modelEnabled:true,planner:{decideDeath:async()=>({type:'wait',why:'items are below'})},...events([])}).handle();
 assert.deepEqual([waited.type,waited.source],['wait','model']);
 assert.equal(f.calls.length,0);
 const broken=await new Recovery({bridge:f.bridge,modelEnabled:true,planner:{decideDeath:async()=>{throw Error('Ollama 500');}},...events([]),verifyMs:1000}).handle();
 assert.deepEqual([broken.type,broken.source,broken.result],['respawn','fallback','succeeded']);
 assert.match(broken.why,/Model unavailable/);
});
test('the poll loop notices a death once and hands it to recovery',async()=>{
 const f=fixture({dead:false,canRespawn:false,phase:'navigating'});const seen=[];
 const handled=[];
 const agent=new Supervisor({bridge:f.bridge,planner:{interpret:async()=>({type:'navigate',x:1,z:1})},site:{x:200,z:200},emit:e=>seen.push(e)});
 agent.recovery={handle:async()=>{handled.push(Date.now());return {type:'respawn'};}};
 await agent.poll();
 assert.equal(handled.length,0);
 Object.assign(f.state,{dead:true,deathScreen:true,canRespawn:true,phase:'stopped'});
 await agent.poll();await agent.poll();
 assert.equal(handled.length,1,'one death must not be handled twice');
 assert.match(seen.find(e=>e.kind==='died').message,/slain by a zombie/);
 Object.assign(f.state,{dead:false});await agent.poll();
 Object.assign(f.state,{dead:true});await agent.poll();
 assert.equal(handled.length,2,'a later death is a new death');
});
test('respawn is a first-class action and typing it reaches recovery',async()=>{
 assert.deepEqual(validateAction({type:'respawn'}),{type:'respawn'});
 assert.deepEqual(directCommand('respawn',{x:0,z:0}),{type:'respawn'});
 const f=fixture();let called=false;
 const agent=new Supervisor({bridge:f.bridge,planner:{interpret:()=>{throw Error('must not call model');}},site:{x:200,z:200}});
 agent.recovery={handle:async()=>{called=true;return {type:'respawn'};}};
 await agent.order('respawn');
 assert.ok(called);
 assert.equal(f.calls.filter(c=>c[0]==='stop').length,0,'asking to respawn must not cancel through the control path');
});
test('every entry point gets recovery, because a harness forgot it once and the run died',async()=>{
 const { openSession } = await import('../src/setup.js');
 const { readFileSync } = await import('node:fs');
 // Structural: the harnesses must not build their own supervisor, or they can omit recovery again.
 for (const file of ['../src/bench.js','../src/gate1.js','../src/cli.js']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  assert.match(source, /openSession\(/, `${file} must assemble its agent through openSession`);
  assert.doesNotMatch(source.replace(/new Supervisor\(\{ bridge: watched[\s\S]*?\}\);/,''), /new Supervisor\(/,
    `${file} must not construct a Supervisor directly`);
 }
 assert.equal(typeof openSession,'function');
});
