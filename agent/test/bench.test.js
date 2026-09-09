import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTarget, summarize, report } from '../src/bench.js';
test('successive legs point in different directions from the current position',()=>{
 const origin={x:100,z:-50};
 const targets=Array.from({length:6},(_,i)=>nextTarget(origin,i,120));
 for(const t of targets){assert.ok(Number.isInteger(t.x)&&Number.isInteger(t.z));assert.ok(Math.abs(Math.hypot(t.x-origin.x,t.z-origin.z)-120)<1.5);}
 assert.equal(new Set(targets.map(t=>`${t.x},${t.z}`)).size,6);
});
test('summary counts routes and cancels separately and never claims success for a timeout',()=>{
 const rows=[
  {kind:'route',phase:'succeeded',elapsedMs:30000},{kind:'route',phase:'succeeded',elapsedMs:50000},
  {kind:'route',phase:'blocked',elapsedMs:20000},{kind:'route',phase:'timeout',elapsedMs:200000},
  {kind:'cancel',phase:'cancelled',elapsedMs:7000,stopLatencyMs:300,driftBlocks:1.2}];
 const s=summarize(rows);
 assert.deepEqual([s.routes,s.succeeded,s.blocked,s.cancels],[4,2,1,1]);
 assert.equal(s.successRate,0.5);
 assert.equal(s.medianRouteMs,30000);
 assert.deepEqual([s.medianStopMs,s.maxDriftBlocks],[300,1.2]);
});
test('the integrated server is the oracle when it exists and prediction otherwise',async()=>{
 const { oracle } = await import('../src/bench.js');
 assert.deepEqual(oracle({x:1,z:2,serverPositionAvailable:true,serverX:9,serverZ:8}),{x:9,z:8,source:'integrated-server'});
 assert.deepEqual(oracle({x:1,z:2,serverPositionAvailable:false}),{x:1,z:2,source:'client-predicted'});
 assert.equal(summarize([{kind:'route',phase:'succeeded',elapsedMs:1,positionSource:'client-predicted'}]).positionSource,'client-predicted');
 assert.equal(summarize([{kind:'route',phase:'succeeded',elapsedMs:1,positionSource:'integrated-server'}]).positionSource,'integrated-server');
});
test('a menu interruption is not scored as a navigation failure',async()=>{
 const { classify } = await import('../src/bench.js');
 assert.equal(classify('stopped','World unavailable, menu opened or paused'),'interrupted');
 assert.equal(classify('blocked','No observed movement for 15 seconds'),'blocked');
 const at={from:{x:0,z:0},target:{x:1,z:1},legBlocks:1,travelledBlocks:1};
 const rows=[{...at,trial:1,kind:'route',phase:'succeeded',elapsedMs:1000},{...at,trial:2,kind:'route',phase:'interrupted',elapsedMs:9}];
 const s=summarize(rows);
 assert.deepEqual([s.routes,s.succeeded,s.interrupted,s.successRate],[1,1,1,1]);
 assert.match(report(rows,s,{startedAt:'now',trials:2,distance:120,stopEvery:4}),/interrupted by a game menu/);
});
test('report renders every trial including failures',()=>{
 const rows=[{trial:1,kind:'route',from:{x:0,z:0},target:{x:120,z:0},phase:'blocked',reason:'No observed movement for 15 seconds',legBlocks:120,travelledBlocks:3,elapsedMs:16000}];
 const text=report(rows,summarize(rows),{startedAt:'now',trials:1,distance:120,stopEvery:4});
 assert.match(text,/blocked/);assert.match(text,/No observed movement/);assert.match(text,/successRate: 0/);
});
