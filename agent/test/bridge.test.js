import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.js';
import { Planner } from '../src/planner.js';
test('transport is loopback-only and includes auth/session metadata',async()=>{
 assert.throws(()=>new Bridge({url:'http://example.com',token:'secret'}));let request;
 const bridge=new Bridge({url:'http://127.0.0.1:3009',token:'local',fetchImpl:async(url,args)=>{request={url,...args};return {ok:true,json:async()=>({})};}});
 await bridge.navigate({x:1,z:2},{session:'s',epoch:3,observedAt:4},'id');
 assert.equal(request.headers.Authorization,'Bearer local');assert.deepEqual(JSON.parse(request.body),{x:1,z:2,session:'s',epoch:3,observedAt:4,id:'id'});
});
test('every action leaves through one envelope carrying identity, freshness, deadline and scope',async()=>{
 let request;
 const bridge=new Bridge({url:'http://127.0.0.1:3009',token:'local',fetchImpl:async(url,args)=>{request={url,...args};return {ok:true,json:async()=>({})};}});
 await bridge.act({type:'move',direction:'forward',ticks:20},{session:'s',epoch:3,observedAt:4},'a1',4000);
 assert.equal(request.url,'http://127.0.0.1:3009/act');
 assert.deepEqual(JSON.parse(request.body),{type:'move',args:{direction:'forward',ticks:20},scope:'travel',actionId:'a1',id:'a1',deadlineMs:4000,session:'s',epoch:3,observedAt:4});
});
test('planner refuses model-produced code or unsupported actions',async()=>{
 const p=new Planner({modelEnabled:true,site:{x:200,z:200},ollamaUrl:'http://127.0.0.1:11434',model:'test'},async()=>({ok:true,json:async()=>({message:{content:'{"type":"execute","code":"anything"}'}})}));
 await assert.rejects(p.interpret('hello',{},new AbortController().signal),/Unsupported action type/);
});
