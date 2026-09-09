import test from 'node:test';
import assert from 'node:assert/strict';
import { verdict, report, TICK_BUDGET } from '../src/gate1.js';
test('the gate fails if any single check fails',()=>{
 const passing=[{name:'a',pass:true},{name:'b',pass:true}];
 assert.equal(verdict(passing).gate,'PASS');
 const mixed=[...passing,{name:'stop releases inputs',pass:false}];
 const result=verdict(mixed);
 assert.deepEqual([result.gate,result.passed,result.failed],['FAIL',2,1]);
 assert.deepEqual(result.failing,['stop releases inputs']);
});
test('the budget is the plan\'s two client ticks and the report names what failed',()=>{
 assert.equal(TICK_BUDGET,2);
 const checks=[{name:'move forward',pass:false,expected:'> 0.5 blocks',observed:0,detail:'No observed movement'}];
 const text=report(checks,verdict(checks),{startedAt:'now',protocol:3});
 assert.match(text,/Stop budget 2 client ticks/);
 assert.match(text,/\| move forward \| NO \|/);
 assert.match(text,/\*\*FAIL\*\*/);
 assert.match(text,/Failing: move forward/);
});
