import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, trend } from './observe.js';
import { runGate1 } from './gate1.js';
import { runBench } from './bench.js';
import { root, openSession } from './setup.js';
import { CraftingTools } from './crafting.js';
import { DependencyPlanner, parseObtainGoal, formatDependencyPlan } from './dependencies.js';
import { SkillExecutor } from './skills.js';
const args = process.argv.slice(2);
const { config, bridge, agent, log } = await openSession({ args, name: 'events',
  emit: event => console.log(event.message ?? `${event.state?.phase}: ${event.state?.reason}`) });
const input = createInterface({ input: process.stdin, output: process.stdout });
const crafting = new CraftingTools(bridge);
const dependencies = new DependencyPlanner();
const skills = new SkillExecutor(bridge,message=>{console.log(message);log.emit({kind:'skill-progress',message});});
let skillAbort;
let closing = false, lastError = '', nextSample = 0, busy = false;
async function shutdown() { if (closing) return;closing=true;skillAbort?.abort();try { await agent.stop(); } catch {}input.close();log.close(); }
process.on('SIGINT', shutdown);process.on('SIGTERM', shutdown);input.on('close', shutdown);
input.on('line', line => {
  if(line.trim().toLowerCase()==='cancel') line='stop';
  if(line.trim()==='help') console.log('Goals: get|fetch|gather|collect|craft <count> <item> | plan <count> <item> | cancel. Examples: get 6 logs, craft stone pickaxe, plan 10 planks.');
  if (line.trim()==='quit') { void shutdown();return; }
  if (line.trim()==='help') {console.log('inventory | craftable | can-craft <item> | go to 200 200 | go to site | forward|back|left|right [ticks] | turn 90 | face <yaw> <pitch> | jump | slot 0-8 | break [ticks] | place | status | look [radius] | history | frame | reflex on|off | respawn | gate1 | bench [routes] | stop | quit. Return to Minecraft and close the menu to start a queued command. F8 takes over.');return;}
  // Observation is read-only and deliberately bypasses the supervisor: looking must never
  // cancel, extend or start an action, so it does not touch action authority at all.
  const [word, ...rest] = line.trim().split(/\s+/);
  const goal = parseObtainGoal(line);
  if(word==='stop') skillAbort?.abort();
  if(goal && word!=='plan') {
    if(busy || agent.active) {console.error('An action is running. Type stop first.');return;}
    busy=true;skillAbort=new AbortController();
    void skills.run(goal,skillAbort.signal).catch(error=>console.error(`Goal stopped: ${error.message}`))
      .finally(async()=>{try {await bridge.stop();} catch {}busy=false;skillAbort=null;});return;
  }
  if (goal) {
    void crafting.inventory().then(snapshot=>{
      const plan=dependencies.plan(goal.item,goal.count,snapshot.craftingItems,{stations:snapshot.stations??[]});
      log.emit({kind:'dependency-plan',observedAt:snapshot.observedAt,session:snapshot.session,plan});
      console.log(formatDependencyPlan(plan));
    }).catch(error=>{
      const plan=dependencies.plan(goal.item,goal.count,{});
      log.emit({kind:'dependency-plan',offline:true,error:error.message,plan});
      console.error(`Live inventory unavailable (${error.message}); showing an empty-inventory preview.`);
      console.log(formatDependencyPlan(plan));
    });return;
  }
  if (word==='inventory' || word==='craftable' || word==='can-craft') {
    const query=word==='inventory'?crafting.inventory():word==='craftable'?crafting.craftable():crafting.canCraft(rest.join(' '));
    void query.then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>console.error(error.message));return;
  }
  if (word==='look') {void look(Number(rest[0])||32).catch(e=>console.error(e.message));return;}
  if (word==='reflex') {void bridge.state().then(s=>bridge.reflex(s,rest[0]!=='off')).then(r=>console.log(`Safety reflexes ${r.armed?'armed':'disarmed'}`)).catch(e=>console.error(e.message));return;}
  if (word==='history') {void bridge.history().then(h=>{log.emit({kind:'history',history:h});console.log(trend(h));}).catch(e=>console.error(e.message));return;}
  // Harnesses run on this console's own supervisor: one agent, one control lease, no second
  // process competing for it. The poll loop stands down while one is running.
  if (word==='gate1'||word==='bench') {
    if (busy) {console.error('A harness is already running. Type stop to cancel it.');return;}
    busy = true;
    const run = word==='gate1'
      ? runGate1({agent,bridge,log,site:config.site,stopTrials:Number(rest[0])||5})
      : runBench({agent,bridge,log,trials:Number(rest[0])||20,distance:Number(rest[1])||120});
    void run.catch(e=>console.error(e.message)).finally(()=>{busy=false;});
    return;
  }
  if (word==='frame') {void frame().catch(e=>console.error(e.message));return;}
  if(busy && word!=='stop' && word!=='status') {console.error('A skill or harness is running. Type stop first.');return;}
  void agent.order(line).then(state => {if(state) console.log(JSON.stringify(state,null,2));}).catch(e => {if(e.name!=='AbortError') console.error(e.message);});
});
async function look(radius) {
  const observation = await bridge.observe();
  log.emit({kind:'observation',radius,observation});
  console.log(describe(observation,{radius}));
}
async function frame() {
  const captured = await bridge.frame();
  const path = resolve(root,`../runtime/frames/frame-${captured.capturedAt}.png`);
  mkdirSync(dirname(path),{recursive:true});writeFileSync(path,captured.bytes,{mode:0o600});
  log.emit({kind:'frame',path,capturedAt:captured.capturedAt,ageMs:captured.ageMs,fresh:captured.fresh,width:captured.width,height:captured.height});
  console.log(`${captured.width}x${captured.height}, ${captured.ageMs}ms old${captured.fresh?'':' (STALE: client produced no new frame in time)'} -> ${path}`);
}
console.log(`Private testing console. Model ${config.modelEnabled ? config.model : 'disabled'}. Type help. Nothing moves until you give a command.`);
while (!closing) {
  try {
    if (busy) { await new Promise(r=>setTimeout(r,200)); continue; }
    const state = await agent.poll();lastError='';
    if (agent.active && Date.now()>nextSample) {nextSample=Date.now()+3000;log.emit({kind:'sample',state});console.log(`Observed ${state.x?.toFixed(1)}, ${state.y?.toFixed(1)}, ${state.z?.toFixed(1)} (${state.positionSource}); ${state.phase}`);}
  } catch(e) {if(e.message!==lastError) console.error(e.message);lastError=e.message;}
  await new Promise(r=>setTimeout(r,500));
}
