import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelStream } from '../src/planner.js';
import { DebugMonitor } from '../src/debug.js';

test('model output streams before completion and preserves split UTF-8',async()=>{
  const records=[{message:{content:'{"tool":"say","args":{"text":"hé'}},{message:{content:'llo"}}'}},{done:true,eval_count:12,eval_duration:1e9}];
  const bytes=new TextEncoder().encode(records.map(JSON.stringify).join('\n')+'\n');
  const events=[];
  const body=(async function*(){for(const byte of bytes)yield new Uint8Array([byte]);})();
  const result=await readModelStream({body},e=>events.push(e));
  assert.equal(JSON.parse(result).args.text,'héllo');
  assert.equal(events[0].kind,'model_chunk');assert.equal(events.at(-1).eval_count,12);
});
test('incomplete and failed model streams are explicit errors',async()=>{
  const body=(async function*(){yield new TextEncoder().encode('{"message":{"content":"partial"}}\n');})();
  await assert.rejects(readModelStream({body},()=>{}),/before completion/);
  await assert.rejects(readModelStream({json:async()=>({error:'out of memory'})},()=>{}),/out of memory/);
});
test('inspector retains exact input, partial output, metrics and tool rejection evidence',()=>{
  const monitor=new DebugMonitor();
  monitor.trace({kind:'model_start',id:'one',messages:[{role:'user',content:'make iron tools'}],options:{num_predict:650}});
  monitor.trace({kind:'model_chunk',id:'one',content:'{"tool":'});
  assert.equal(monitor.data.calls[0].output,'{"tool":');assert.equal(monitor.data.calls[0].status,'generating');
  monitor.trace({kind:'model_end',id:'one',eval_count:4,eval_duration:2e9});
  monitor.event({kind:'tool_rejected',tool:'start_task',result:{error:'Safety owns body'}});
  assert.equal(monitor.data.calls[0].status,'finished');assert.equal(monitor.data.calls[0].messages[0].content,'make iron tools');
  assert.equal(monitor.data.events[0].result.error,'Safety owns body');
});
