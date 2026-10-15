import { randomUUID } from 'node:crypto';
import { validateAction } from './commands.js';
export class Planner {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }
  /** Multiple bounded tool calls in one persistent conversation turn. */
  async turn(context, tool, signal, trace = () => {}) {
    // Cost is the design constraint. At ~10 tokens/second every sentence here is paid for on
    // every call of every review, so this says what the model cannot infer from its briefing and
    // nothing else. The charter is 1,000 tokens and belongs to planning, not to "should I start
    // the next task"; a measured run spent 2,340 tokens of a 4,096 context on standing text and
    // then invented task ids out of the charter, because the plan had been squeezed out.
    // Unknown means planning. A turn that has not been told the plan is current is one where
    // the charter still has to be paid for; only an explicitly routine review goes without it.
    const planning = context.turnKind !== 'routine';
    const instructions = [
      'You control a Minecraft character. You own a revisable plan; nothing executes unless you start it.',
      'Return exactly one JSON object: {tool, args}. No prose.',
      'Your briefing is complete and fresh. It already contains the plan, the active task, inventory, the material',
      'calculation for the mission and whether the mission is complete. Do not spend a call re-reading what it says.',
      'Tools:',
      'start_task {objectiveId,kind,why,...}: starts ONE task, returns immediately, runs while you think. One at a time.',
      '  obtain {targets:"objective" or [{item,count}]} desired TOTAL holdings, whole dependency chain, batched.',
      '  gather {item,count,returnTo?,minFood?,minHealth?,minDurability?} one expedition; stays there unless returnTo.',
      '  eat {targetFood}: start it at any time -- it suspends the running task for you, and you resume that afterwards.',
      '  equip {item}; navigate {x,z}; shaft {direction,steps,torchEvery}.',
      'pause_task / cancel_task / resume_task {taskId,why}: taskId is the short id in the briefing.',
      'set_plan {nodes:[{id,parent,title,success,status,why,targets?,reserves?}]}: replaces the plan. Two to four',
      '  objectives with concrete success conditions, never one per recipe. targets:"mission" references the checklist.',
      'say {text}: answer the operator. recipe_plan {kit? or targets?}: calculator. journal / conversation {query,limit}.',
      'remember_site {name,x,y,z,kind}. report_task {taskId}. yield {}: end this review.',
      'finish_mission {}: only when the briefing already says the mission is complete.',
      'say carries answers and intentions. Execution status comes from task events, never from say.',
      'If a tool errors, fix that one thing or yield. Never repeat an identical failing call.',
      planning && this.config.charter ? `Operator charter, which governs everything and you may not change:\n${this.config.charter}` : '',
      planning
        ? 'Planning review: write the plan with set_plan, then start the first task.'
        : 'Routine review: one decision -- start, pause, resume, adjust or answer -- then yield.'
    ].filter(Boolean).join('\n');
    // Order matters for two reasons. The briefing sits directly after the system prompt so it is
    // never the thing trimming reaches first, and nothing is ever inserted before the end, so the
    // prefix stays byte-identical across the calls of one review and Ollama can reuse its cache.
    // Measured without that: 153,091 prompt tokens re-processed across 60 calls, 245 seconds.
    const shorten = (text, limit) => text.length > limit ? text.slice(0, limit) + ' [truncated]' : text;
    const messages = [
      { role: 'system', content: instructions },
      { role: 'user', content: JSON.stringify({ event: 'review', ...context, conversation: undefined }) },
      ...(context.conversation ?? []).slice(-4).map(m => ({ ...m, content: shorten(m.content, 400) }))
    ];
    /** System prompt and briefing. Trimming starts above these; it may never remove them. */
    const PINNED = 2;
    let replyPending=Boolean(context.operatorMessages?.length), repeated='';
    const addUpdate=update=>{
      if(!update?.changed) return false;
      messages.push({role:'user',content:JSON.stringify({event:'live_update',...update})});
      if(update.operatorMessages?.length) replyPending=true;
      return true;
    };
    // A routine review is one decision. The twelve-call budget was spent in full on all five
    // reviews of a measured run -- sixty model calls, twelve minutes of inference, four completed
    // tasks -- because a loop that may look before it acts always will. Answering the operator
    // costs a call that decides nothing, so a turn that owes a reply gets one more.
    const budget = Math.max(1, Math.min(
      context.toolBudget ?? (planning ? 6 : context.operatorMessages?.length ? 4 : 3),
      this.config.agentToolBudget ?? 12));
    for (let call = 0; call < budget; call++) {
      signal?.throwIfAborted();
      addUpdate(await tool('_updates',{}));
      const answering=replyPending;
      while (messages.length>PINNED+1 && JSON.stringify(messages).length>(this.config.agentPromptChars??9000)) messages.splice(PINNED,1);
      const requestBody={ model:this.config.model,stream:true,
        options:{temperature:0.2,num_ctx:this.config.agentContextTokens??8192,
          num_predict:planning?(this.config.agentPlanTokens??520):(this.config.agentOutputTokens??260)},
        format:{type:'object',required:['tool','args'],properties:{
          // Deliberately not narrowed to say when a reply is owed. Forcing the answer first cost
          // the action: told "eat right now, pause the task and actually eat", the model could
          // only produce sentences, and spent the review producing them.
          tool:{type:'string',enum:['state','journal','conversation','recipe_plan','set_plan','remember_site','start_task','pause_task','cancel_task','resume_task','report_task','say','yield','finish_mission']},
          args:{type:'object'}},additionalProperties:false},
        messages:answering?[...messages,{role:'user',content:'The operator is waiting. Do what they asked -- start, pause or resume the task that carries it out -- and answer them with say in one or two sentences. An instruction is not carried out by describing it.'}]:messages};
      const id=randomUUID();trace({kind:'model_start',id,options:requestBody.options,messages:requestBody.messages});
      let content;
      try {
        const response=await this.fetch(`${this.config.ollamaUrl}/api/chat`,{
          method:'POST',headers:{'Content-Type':'application/json'},
          signal:AbortSignal.any([signal,AbortSignal.timeout(this.config.agentInferenceTimeoutMs??120000)].filter(Boolean)),
          body:JSON.stringify(requestBody)});
        if(!response.ok) throw Error(`Ollama ${response.status}`);
        content=await readModelStream(response,event=>trace({id,...event}));
      } catch(error) {trace({kind:'model_error',id,error:error.message});throw error;}
      const update=await tool('_updates',{});
      const changed=addUpdate(update);
      let request;
      try { request = JSON.parse(content); if (!request.tool || !request.args || Array.isArray(request.args)) throw Error('Expected tool and args'); }
      catch (error) { messages.push({ role: 'assistant', content }, { role: 'user', content: 'Invalid tool JSON: ' + error.message }); continue; }
      // A completed call is retained for read-only conversation, but a stale mutation cannot
      // act on the old world. Continue this same turn with the newly supplied context.
      if(changed && !['say','report_task','state','journal','conversation','recipe_plan','set_plan'].includes(request.tool)) {trace({kind:'decision_discarded',id,reason:'World or operator update before execution'});continue;}
      if(changed && request.tool==='set_plan' && update.operatorMessages?.length) continue;
      await tool('_message', { role: 'assistant', content });
      const result = await tool(request.tool, request.args);
      const feedback = { role: 'user', content: shorten(JSON.stringify({ tool: request.tool, result }), 900) };
      await tool('_message', feedback);
      messages.push({ role: 'assistant', content }, feedback);
      // Identical call, identical error, twice. Telling it again will not help, and each retry is
      // another twenty seconds and another eight hundred tokens of context. Observed live: the
      // same plan regenerated six times against the same complaint.
      const fingerprint = result?.error ? request.tool + JSON.stringify(request.args) : '';
      if (fingerprint && fingerprint === repeated) {
        trace({ kind: 'repeat_abandoned', id, tool: request.tool, error: result.error });
        await tool('_message', { role: 'user', content: 'Same call, same error, twice. Ending this review; try something different at the next one.' });
        return;
      }
      repeated = fingerprint;
      if(request.tool==='say' && !result?.error && !changed) {
        replyPending=false;
        messages.push({role:'user',content:'Operator reply delivered. Continue the existing mission now: preserve any recipe results already computed, write the plan if needed, and explicitly start the next useful task when safe. Do not ask the operator to restate the mission.'});
      }
      if (request.tool === 'yield' && !result?.error || request.tool === 'finish_mission' && !result?.error) return;
    }
    await tool('_budget', {});
  }
  /** One bounded decision about a death. The only outputs that exist are respawn and wait. */
  async decideDeath(state, signal) {
    if (!this.config.modelEnabled) throw Error('Model disabled');
    const response = await this.fetch(`${this.config.ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20000)].filter(Boolean)),
      body: JSON.stringify({ model: this.config.model, stream: false, options: { temperature: 0, num_predict: 120 },
        format: { type: 'object', properties: { type: { type: 'string', enum: ['respawn','wait'] }, why: { type: 'string' } }, required: ['type','why'], additionalProperties: false },
        messages: [{ role: 'system', content: 'The Minecraft character you assist has died and the death screen is showing. Choose respawn to press the respawn button, or wait to do nothing. Respawning returns the character to its spawn point and abandons dropped items where they fell. Answer with one JSON object and a short reason.' },
          { role: 'user', content: JSON.stringify({ deathMessage: state.deathMessage, deaths: state.deaths, canRespawn: state.canRespawn, hardcore: state.hardcore, position: { x: state.x, y: state.y, z: state.z } }) }]
      })
    });
    if (!response.ok) throw Error(`Ollama ${response.status}`);
    const choice = JSON.parse((await response.json()).message.content);
    if (!['respawn','wait'].includes(choice.type)) throw Error('Model returned an unsupported death decision');
    return choice;
  }
  async interpret(text, state, signal) {
    if (!this.config.modelEnabled) throw Error('Model disabled. Use "go to 200 200", "go to site", "status", or "stop". Start with --model for broader wording.');
    const response = await this.fetch(`${this.config.ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
      body: JSON.stringify({ model: this.config.model, stream: false, options: { temperature: 0, num_predict: 160 },
        format: { type: 'object', properties: { type: { type: 'string', enum: ['navigate','stop','status','unsupported'] }, x: { type: 'integer' }, z: { type: 'integer' } }, required: ['type'], additionalProperties: false },
        messages: [{ role: 'system', content: 'Translate a private owner instruction into one JSON action. Supported: navigate to explicit integer x,z or the configured site; stop; status. Unsupported tasks must return type unsupported. Do not invent coordinates. No mining, building, combat, code execution or public chat. Site: '+JSON.stringify(this.config.site) },
          { role: 'user', content: JSON.stringify({ instruction: text, position: { x: state.x, z: state.z } }) }]
      })
    });
    if (!response.ok) throw Error(`Ollama ${response.status}`);
    return validateAction(JSON.parse((await response.json()).message.content));
  }
}

/** Parse Ollama NDJSON incrementally, including UTF-8 split across network chunks. */
export async function readModelStream(response, trace) {
  let content='',thinking='',final;
  const accept=part=>{
    if(part.error) throw Error(part.error);
    const text=part.message?.content??'', thought=part.message?.thinking??'';
    content+=text;thinking+=thought;
    if(text || thought) trace({kind:'model_chunk',content:text,thinking:thought});
    if(part.done) final=part;
  };
  if(!response.body) {const part=await response.json();accept(part);final=part;}
  else {
    const decoder=new TextDecoder();let buffer='';
    for await(const chunk of response.body) {
      buffer+=decoder.decode(chunk,{stream:true});
      let newline;while((newline=buffer.indexOf('\n'))>=0) {const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line.trim())accept(JSON.parse(line));}
    }
    buffer+=decoder.decode();if(buffer.trim())accept(JSON.parse(buffer));
    if(!final) throw Error('Model stream ended before completion');
  }
  trace({kind:'model_end',eval_count:final.eval_count,eval_duration:final.eval_duration,prompt_eval_count:final.prompt_eval_count,prompt_eval_duration:final.prompt_eval_duration,load_duration:final.load_duration,done_reason:final.done_reason});
  return content;
}
