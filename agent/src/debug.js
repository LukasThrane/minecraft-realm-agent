import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Read-only loopback inspector. No bridge token or action endpoints. */
export class DebugMonitor {
  constructor(path) {this.path=path;this.data={updatedAt:Date.now(),calls:[],events:[],state:null};this.lastSave=0;}
  save(force=false) {
    if(!this.path || !force && Date.now()-this.lastSave<250) return;
    this.lastSave=Date.now();this.data.updatedAt=Date.now();mkdirSync(dirname(this.path),{recursive:true});
    writeFileSync(this.path+'.tmp',JSON.stringify(this.data));renameSync(this.path+'.tmp',this.path);
  }
  trace(event) {
    const at=Date.now();
    if(event.kind==='model_start') {
      this.data.calls.push({...event,at,status:'generating',output:'',thinking:''});this.data.calls=this.data.calls.slice(-20);
    } else {
      const call=this.data.calls.find(c=>c.id===event.id);
      if(call) {
        if(event.kind==='model_chunk') {call.output+=event.content??'';call.thinking+=event.thinking??'';call.firstTokenAt??=at;call.lastTokenAt=at;}
        else Object.assign(call,event,{status:event.kind==='model_end'?'finished':'failed',endedAt:at});
      }
    }
    if(event.kind!=='model_chunk' && this.path) {
      mkdirSync(dirname(this.path),{recursive:true});
      const call=this.data.calls.find(c=>c.id===event.id);
      appendFileSync(this.path+'.jsonl',JSON.stringify({at,...event,...(event.kind==='model_end'?{output:call?.output,thinking:call?.thinking}:{})})+'\n');
    }
    this.save(event.kind!=='model_chunk');
  }
  event(event) {
    const entry={at:Date.now(),...event};
    this.data.events.push(entry);this.data.events=this.data.events.slice(-100);
    if(this.path) {mkdirSync(dirname(this.path),{recursive:true});appendFileSync(this.path+'.jsonl',JSON.stringify(entry)+'\n');}
    this.save(true);
  }
  state(state, memory) {this.data.state=state;this.data.mission=memory.mission;this.data.plan=memory.plan;this.data.tasks=memory.tasks.slice(-20);this.save();}
}
export async function serveDebug(read) {
  const secret=randomBytes(18).toString('hex');const prefix='/'+secret;
  const html=readFileSync(new URL('./debug.html',import.meta.url),'utf8');
  const server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method!=='GET' || !req.url?.startsWith(prefix+'/')) {res.writeHead(404);res.end();return;}
    if(req.url===prefix+'/snapshot') {
      try {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(read()));}
      catch(error) {res.writeHead(503);res.end(JSON.stringify({error:error.message}));}return;
    }
    if(req.url!==prefix+'/') {res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}${prefix}/`,close:()=>new Promise(resolve=>server.close(resolve))};
}
if(import.meta.url===`file://${process.argv[1]}`) {
  const index=process.argv.indexOf('--file');
  const path=index>=0?resolve(process.argv[index+1]):resolve(fileURLToPath(new URL('../../runtime/agent-debug.json',import.meta.url)));
  const server=await serveDebug(()=>JSON.parse(readFileSync(path,'utf8')));
  console.log(`Live agent inspector (read-only): ${server.url}`);
}
