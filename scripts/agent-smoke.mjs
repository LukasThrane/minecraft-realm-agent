// Real local-model test with a simulated body. Never connects to Minecraft.
import { readFileSync } from 'node:fs';
import { DebugMonitor } from '../agent/src/debug.js';
import { Runner } from '../agent/src/runner.js';
import { SkillExecutor } from '../agent/src/skills.js';
const config=JSON.parse(readFileSync(new URL('../config/mvp.json',import.meta.url)));
config.agentToolBudget=8;
const conversation=process.argv.includes('--conversation');let replies=0;
const controller=new AbortController();
const state={session:'smoke',worldKey:'simulation',epoch:1,online:true,canAct:true,skillsVersion:4,reflexArmed:true,health:20,food:20,x:0,y:64,z:0};
const items=conversation?[{slot:0,item:'minecraft:cooked_beef',count:32},{slot:1,item:'minecraft:oak_planks',count:1},{slot:2,item:'minecraft:dirt',count:1}]:[{slot:0,item:'minecraft:iron_pickaxe',count:1},{slot:1,item:'minecraft:cooked_beef',count:8}];
const bridge={state:async()=>({...state,observedAt:Date.now()}),observe:async()=>({online:true,fresh:true,observedAt:Date.now(),session:'smoke',self:{...state,maxHealth:20},inventory:{items},stations:conversation?[]:['crafting_table','furnace'],entities:[]}),reflex:async()=>{},stop:async()=>{state.acting=false;}};
const skills=new SkillExecutor(bridge);
let started, asked=false; const interrupt=process.argv.includes('--interrupt'); let ate=false;
skills.execute=async(spec,signal)=>{
  started??=spec;state.acting=true;console.log(JSON.stringify({event:'SIMULATED_TASK',spec}));
  if(interrupt && spec.kind==='eat') {
    state.food=20;state.acting=false;ate=true;
    setTimeout(()=>controller.abort(),20);return;
  }
  // Once, like a real operator. Re-sending it on every task start made the scenario unwinnable:
  // each new task drew another instruction, so no reply could ever be the last word.
  if(interrupt && !asked) {asked=true;setTimeout(()=>{state.health=6;state.food=19;runner.tell('Eat food right now. Pause the current task and actually eat before doing any more work.');},20);}
  else setTimeout(()=>controller.abort(),0);
  await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
};
const debug=new DebugMonitor(new URL('../runtime/agent-smoke-debug.json',import.meta.url).pathname);
const runner=new Runner({debug,bridge,agent:{stop:bridge.stop},skills,config,goal:conversation?'get full iron toolsets and armor':'Get a full iron toolset and armor. I already have one iron pickaxe. Plan the whole kit and batch resources.',emit:e=>console.log(JSON.stringify(e)),cycleMs:50});
const tool=runner.tool.bind(runner);
runner.tool=async(name,args)=>{const result=await tool(name,args);if(name==='say') replies++;if(!name.startsWith('_')) console.log(JSON.stringify({tool:name,result}));return result;};
const timers=[];
if(conversation) {
  for(const [ms,text] of [[5000,'hey whats up'],[12000,'hello? What are you doing?'],[23000,'hello?']]) timers.push(setTimeout(()=>runner.tell(text),ms));
  timers.push(setTimeout(()=>{state.reflex='retreat';},15000));
  timers.push(setTimeout(()=>{state.reflex='';},20000));
  timers.push(setTimeout(()=>{if(runner.retarget('')!=='get full iron toolsets and armor') throw Error('Empty goal erased mission');},25000));
}
const timeout=setTimeout(()=>controller.abort(),240000);
try {await runner.run(controller.signal);} finally {clearTimeout(timeout);for(const timer of timers) clearTimeout(timer);}
console.log(JSON.stringify({plan:runner.memory.data.plan,toolCalls:runner.memory.data.conversation.filter(m=>m.role==='assistant'),started}));
if(!started || !runner.memory.data.plan.length || interrupt && !ate || conversation && !replies) process.exitCode=1;
