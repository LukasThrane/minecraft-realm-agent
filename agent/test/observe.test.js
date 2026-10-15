import test from 'node:test';
import assert from 'node:assert/strict';
import { describe, threats, isStale, STALE_MS } from '../src/observe.js';
import { Bridge } from '../src/bridge.js';
const world = over => ({ online:true, observedAt:Date.now(), ageMs:10, light:4, skyLight:0,
  self:{x:200.4,y:64,z:200.1,yaw:178,health:17.5,maxHealth:20,food:18,onGround:true},
  entities:[{type:'minecraft:zombie',hostile:true,distance:6.2,health:20,maxHealth:20},
            {type:'minecraft:cow',hostile:false,distance:9.1},
            {type:'minecraft:creeper',hostile:true,distance:30.4,health:20,maxHealth:20}],
  inventory:{selectedSlot:0,size:41,items:[{slot:0,item:'minecraft:stone_sword',count:1},{slot:1,item:'minecraft:oak_log',count:32}]}, ...over });
test('nearest hostile is reported before anything else and radius excludes the rest',()=>{
 const text=describe(world(),{radius:16});
 assert.match(text.split('\n')[1],/^hostiles \(1\): zombie 6\.2m/);
 assert.doesNotMatch(text,/creeper/);
 assert.deepEqual(threats(world(),16).map(e=>e.type),['minecraft:zombie']);
});
test('an empty field is stated, never omitted',()=>{
 const text=describe(world({entities:[]}),{radius:16});
 assert.match(text,/hostiles: none within 16m/);
});
test('a stale observation says so instead of reading as current',()=>{
 const old=world({observedAt:Date.now()-STALE_MS-1,ageMs:STALE_MS+1});
 assert.ok(isStale(old));assert.match(describe(old),/STALE/);
 assert.ok(!isStale(world()));
});
test('urgent state appears on the first line',()=>{
 assert.match(describe(world({self:{...world().self,onFire:true,health:3}})).split('\n')[0],/ON FIRE/);
});
test('no world connected is not rendered as an empty but healthy world',()=>{
 assert.equal(describe({online:false}),'No world connected.');
});
test('frame fetch surfaces the client-reported age and refuses non-image replies',async()=>{
 const png=Buffer.from([0x89,0x50,0x4e,0x47]);
 const headers=new Headers({'x-realm-agent-captured-at':'1000','x-realm-agent-age-ms':'240','x-realm-agent-fresh':'true','x-realm-agent-width':'640','x-realm-agent-height':'360'});
 const ok=new Bridge({url:'http://127.0.0.1:3009',token:'t',fetchImpl:async()=>new Response(png,{status:200,headers})});
 const frame=await ok.frame();
 assert.deepEqual([frame.ageMs,frame.fresh,frame.width],[240,true,640]);
 assert.ok(frame.bytes.equals(png));
 const none=new Bridge({url:'http://127.0.0.1:3009',token:'t',fetchImpl:async()=>new Response(JSON.stringify({error:'No frame captured yet'}),{status:503,headers:{'content-type':'application/json'}})});
 await assert.rejects(none.frame(),/No frame captured yet/);
});
test('the trend says what changed, and shouts when it is bad',async()=>{
 const { trend } = await import('../src/observe.js');
 const at=(ms,over)=>({online:true,atMs:ms,tick:ms/50,x:0,z:0,health:20,food:20,light:15,inventoryUsed:3,hostiles:0,...over});
 assert.match(trend({samples:[at(0),at(30000,{x:40})]}),/last 30s: moved 40 blocks/);
 assert.match(trend({samples:[at(0),at(30000,{health:11})]}),/LOSING HEALTH \(9 lost\)/);
 assert.match(trend({samples:[at(0),at(30000)]}),/STATIONARY/);
 assert.match(trend({samples:[at(0),at(30000,{x:40,hostiles:3,nearestHostile:4.2})]}),/hostiles peaked at 3, closest 4\.2m/);
 assert.equal(trend({samples:[]}),'No history yet.');
});

test('client evidence overrides legacy Enemy classification in threat summaries',()=>{
  const observation={online:true,observedAt:Date.now(),self:{},entities:[{uuid:'neutral',hostile:true,type:'minecraft:enderman',distance:2}],
    survival:{mode:'',reason:'no credible threat',threats:[]}};
  assert.deepEqual(threats(observation),[]);
  assert.match(describe(observation),/hostiles: none/);
  assert.match(describe(observation),/other \(1\): enderman/);
});
