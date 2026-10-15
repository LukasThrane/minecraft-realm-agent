import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { AgentMemory } from './memory.js';
import { DebugMonitor, serveDebug } from './debug.js';
import { AgentMind } from './mind.js';
import { DependencyPlanner } from './dependencies.js';
import { inventoryDict, itemId } from './crafting.js';
import { describe } from './observe.js';
import { Attempts } from './commands.js';

const KIT_PIECES=['pickaxe','axe','shovel','sword','hoe','helmet','chestplate','leggings','boots'];
/** Enough to answer "are we carrying anything to eat"; the client owns what is worth eating. */
const EDIBLE=/^minecraft:(cooked_\w+|bread|apple|golden_apple|carrot|golden_carrot|baked_potato|melon_slice|sweet_berries|glow_berries|beetroot|dried_kelp|beef|porkchop|mutton|chicken|rabbit|cod|salmon|pumpkin_pie|cookie)$/;
const kitTargets=material=>KIT_PIECES.map(piece=>({item:`minecraft:${material}_${piece}`,count:1}));
// A recognized operator kit request has a verifiable completion contract independent of the
// agent's intermediate resource objectives. This never creates a plan or starts work.
function missionTargets(goal) {
  const match=String(goal).match(/^(?:get|obtain|make|craft)(?: a| the)? (?:full|complete) (iron|diamond) toolsets? and armo[u]?r(?:[.!]|$)/i);
  return match?kitTargets(match[1].toLowerCase()):[];
}

/** One strategic owner; one body task; plans never execute themselves. */
export class Runner {
  constructor({ agent, bridge, mind, config = {}, goal, skills, memory = new AgentMemory(), emit = () => {},
    cycleMs = 200, reviewMs = 45000, activeReviewMs = 300000, commitMs = 45000, maxActions = 200, debug = null }) {
    Object.assign(this, { agent, bridge, skills, memory, emit, cycleMs, reviewMs, activeReviewMs, commitMs, maxActions, debug });
    this.mind = mind ?? new AgentMind(config);
    this.planner = new DependencyPlanner(); this.attempts = new Attempts();
    this.revision = 0; this.requests = []; this.forceReview = true; this.lastReview = 0;
    this.active = null; this.actions = 0; this.thinking = null; this.stopped = false;
    this.inbox = []; this.unanswered=[]; this.memory.data.mission = goal; this.goal = goal; this.memory.data.missionTargets=missionTargets(goal);
    this.memory.message('user', `Mission for this run: ${goal}. Reconcile previous plans with fresh observations before starting work.`);
    this.memory.event('mission', { goal });
  }
  note(kind, details = {}) {
    this.memory.event(kind, details); this.debug?.event({kind,...details});
    if (details.message) this.emit({ kind, ...details });
  }
  /**
   * Ask for a review without voiding decisions already in flight.
   *
   * Bumping the revision fences every pending tool call as obsolete, which is right when the
   * operator speaks or control changes hands and wrong for everything else. A task finishing, a
   * heart lost, a reflex passing -- those are reasons to look, not reasons to throw away a
   * decision that took half a minute to produce. Conflating them is how a run spent twelve
   * minutes of inference to start seven tasks.
   */
  wake(reason) { this.forceReview = true; this.wakeReason = reason; }
  invalidate(reason) {
    this.revision++; this.forceReview = true;
    this.updateReason=reason;
    // Preserve useful inference and deliver updates at tool boundaries. Only shutdown aborts
    // the model; stale mutations are fenced independently from conversation continuity.
    if (this.stopped) this.turnAbort?.abort(Error(reason));
  }
  tell(text) {
    this.memory.message('user', text); this.inbox.push(text); this.unanswered.push(text); this.quickFailures=0;
    this.invalidate('Operator spoke');
    this.note('operator', { message: `you: ${text}` });
    this.emit({kind:'message_received',message:`Message received. ${this.thinking?'The current model call is finishing; your message will be handled next.':'The agent will review it now.'}`});
  }
  retarget(goal) {
    goal=String(goal??'').trim();
    if (!goal) return this.memory.data.mission;
    this.memory.data.previousMission=this.memory.data.mission;
    this.goal = goal; this.memory.data.mission = goal; this.memory.data.missionTargets=missionTargets(goal);
    this.tell(`Replace the mission with: ${goal}. Review and revise the old plan.`);
    this.note('mission', { goal });
    return goal;
  }
  reservations(exceptObjective) {
    const result={};
    for (const node of this.memory.data.plan) if (node.id!==exceptObjective && !['abandoned','complete'].includes(node.status)) {
      for(const [item,count] of Object.entries(node.reserves??{})) result[item]=(result[item]??0)+count;
    }
    return result;
  }
  async snapshot() {
    const observation = await this.bridge.observe();
    const counts = inventoryDict(observation);
    const state = await this.bridge.state();
    if (observation.session !== state.session) throw Error('Session changed while observing; retry');
    this.observation = observation;
    return { observedAt: observation.observedAt, state, observation, inventory: counts,
      mission: this.memory.data.mission, missionTargets:this.memory.data.missionTargets, planRevision: this.memory.data.revision,
      plan: this.memory.data.plan, reservations:this.reservations(), tasks: this.memory.data.tasks.slice(-16),
      activeTask: this.active?.record ?? null, progress: state.skillProgress ?? null,
      sites: this.memory.data.sites.filter(s => s.worldKey === state.worldKey),
      recentEvents: this.memory.data.events.slice(-5) };
  }
  /**
   * What the mission still needs, calculated here so the model does not spend a call asking.
   *
   * Every review used to open with recipe_plan, and finish_mission was attempted six times in one
   * run against a host that already knew the answer. Arithmetic the host can do is not worth a
   * forward pass.
   */
  materials(current) {
    const open=this.memory.data.plan.filter(node=>['planned','active','blocked'].includes(node.status));
    const targets=(this.memory.data.missionTargets??[]).length?this.memory.data.missionTargets
      :open.flatMap(node=>node.targets??[]);
    if(!targets.length) return null;
    try {
      const plan=this.planner.planMany(targets,current.inventory,{stations:current.observation.stations??[]});
      if(plan.status!=='planned') return {status:plan.status,reason:plan.reason};
      return {status:'planned',stillToGather:plan.summary,remainingSteps:plan.nodes.length,
        nextSteps:plan.nodes.slice(0,4).map(node=>`${node.kind} ${node.count??1} ${node.item??node.station}`)};
    } catch(error) { return {status:'error',reason:error.message}; }
  }
  missionStatus(current) {
    const targets=this.memory.data.missionTargets??[];
    if(!targets.length) return null;
    const missing=targets.map(target=>({item:itemId(target.item),need:target.count,have:current.inventory[itemId(target.item)]??0}))
      .filter(entry=>entry.have<entry.need);
    return {complete:missing.length===0 && !this.active,missing};
  }
  /**
   * The short list of things the host can already see are worth doing something about.
   *
   * Told to eat, the model paused the running task, said it was eating, and started mining again
   * -- three reviews in a row. It was not refusing; it did not connect the instruction to the one
   * call that carries it out. Naming that call, only when the state actually warrants it, costs a
   * line of context and saves a review.
   */
  attention(current) {
    const notes=[], state=current.state;
    const carrying=Object.entries(current.inventory).some(([item,count])=>count>0 && EDIBLE.test(item));
    if (carrying && (state.health<14 || state.food<18))
      notes.push(`Health ${Math.round(state.health)}/20, food ${state.food}/20, and you are carrying food. start_task {kind:"eat",targetFood:20} suspends the running task for you and you resume it afterwards.`);
    if (this.active && state.reflex) notes.push(`Safety is handling ${state.reflex}; the task keeps its progress.`);
    return notes.length?notes:undefined;
  }
  briefing(current) {
    const {state,observation,...rest}=current;
    const fields=['session','worldKey','epoch','observedAt','online','canAct','dead','reflex','health','food','saturation','x','y','z','acting','stopPending','pendingActionId','skillsVersion'];
    return {...rest,state:Object.fromEntries(fields.filter(k=>state[k]!==undefined).map(k=>[k,state[k]])),
      situation:describe(observation),stations:observation.stationSites??[],smelting:observation.smelting??{},
      equipment:observation.inventory?.items.filter(i=>i.slot>=36 || i.durability!==undefined),
      // Measured: the task list was 11,558 of the briefing's 15,930 characters, because every
      // record carried its whole spec including nine kit targets. Five lines of what happened is
      // what a decision needs; the detail is a report_task away. That bloat is what made a prompt
      // 5,300 tokens and cost thirty-five seconds to re-read on every review.
      tasks:rest.tasks.slice(-5).map(task=>({id:task.id,kind:task.spec?.kind,status:task.status,
        item:task.spec?.item,count:task.spec?.count,targets:task.spec?.targets?.length,
        why:String(task.reason??'').slice(0,120)})),
      activeTask:rest.activeTask&&{id:rest.activeTask.id,kind:rest.activeTask.spec?.kind,
        status:rest.activeTask.status,item:rest.activeTask.spec?.item,count:rest.activeTask.spec?.count,
        targets:rest.activeTask.spec?.targets?.length,progress:rest.activeTask.progress?.message},
      materials:this.materials(current),mission:{text:rest.mission,...(this.missionStatus(current)??{})},
      attention:this.attention(current),
      missionTargets:undefined,
      recentEvents:rest.recentEvents.map(({plan,spec,progress,...event})=>event)};
  }
  /**
   * Find what the model meant.
   *
   * It wrote `iron-kit`, `iron_tools_and_armor` and `iron-tools-and-armor` for one objective and
   * invented task ids outright; every miss cost a whole generation to be told "Unknown task".
   * A small model will not carry identifiers verbatim, so the host meets it where it is.
   */
  /**
   * Item targets, in whatever shape they arrived.
   *
   * A live plan came back correct in every respect except one node that wrote its single target
   * as an object rather than a one-element array. The host rejected the whole plan, the model
   * regenerated it identically six times, and the review died having decided nothing. The shape
   * was never the point; the items are.
   */
  normalizeTargets(value, missionTargets = []) {
    if (value === undefined || value === null) return undefined;
    if (value === 'mission' || value === 'objective') return missionTargets.length ? missionTargets : undefined;
    const bounded = count => Math.min(256, Math.max(1, Math.round(Number(count))));
    const list = [];
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === 'string') { list.push({ item: itemId(entry), count: 1 }); continue; }
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.item === 'string') {
        list.push({ item: itemId(entry.item), count: Number.isFinite(Number(entry.count)) ? bounded(entry.count) : 1 });
        continue;
      }
      for (const [item, count] of Object.entries(entry))
        if (Number.isFinite(Number(count))) list.push({ item: itemId(item), count: bounded(count) });
    }
    // Names, not field paths. Asked for targets it wrote `materials.stillToGather`, reaching for
    // a value in its own briefing; the plan then held an item that does not exist and every task
    // built on it failed. Anything the planner has no way to obtain is refused here, once, with
    // its name, rather than surviving into the plan.
    const unknown = list.filter(target => !this.planner.methods(target.item).length).map(target => target.item);
    if (unknown.length) throw Error(`No such item: ${unknown.join(', ')}. targets is a list of {item,count} with real Minecraft item ids, or the string "mission".`);
    return list.length ? list : undefined;
  }
  findObjective(id) {
    const key=text=>String(text??'').toLowerCase().replace(/[^a-z0-9]/g,'');
    const wanted=key(id), nodes=this.memory.data.plan;
    if(!wanted) return null;
    return nodes.find(node=>node.id===id) ?? nodes.find(node=>key(node.id)===wanted)
      ?? nodes.find(node=>key(node.title)===wanted) ?? nodes.find(node=>key(node.title).startsWith(wanted))
      ?? nodes.find(node=>wanted.startsWith(key(node.id))) ?? null;
  }
  findTask(id) {
    const wanted=String(id??'').trim(), tasks=this.memory.data.tasks;
    if(!wanted || /^(active|current|running)$/i.test(wanted)) return this.active?.record ?? null;
    // Only one task ever owns the body, so an id that matches nothing while work is running is
    // almost certainly aimed at that work. Live, `cancel_task {taskId:"iron_resources"}` -- an
    // objective id -- was answered "nothing is running" while a task was running.
    return tasks.find(task=>task.id===wanted) ?? tasks.find(task=>task.id.startsWith(wanted))
      ?? tasks.find(task=>wanted.startsWith(task.id)) ?? this.active?.record ?? null;
  }
  queueTool(name, args, revision, signal) {
    return new Promise(resolve => {
      if (signal.aborted) return resolve({error:'Review interrupted; decisions are obsolete'});
      this.requests.push({ name, args, revision, signal, resolve });
    });
  }
  deliberate() {
    this.forceReview = false; this.lastReview = Date.now();
    let revision = this.revision;
    const controller = new AbortController(); this.turnAbort = controller;
    this.thinkingSince=Date.now();this.lastThinkingNotice=Date.now();this.turnCalls=0;this.turnProductive=false;
    this.emit({kind:"thinking",message:"Agent reviewing the mission and current situation…"});
    this.thinking = (async () => {
      const context = this.briefing(await this.snapshot());
      controller.signal.throwIfAborted();
      context.conversation = this.memory.data.conversation.slice(-8);
      context.operatorMessages = [...this.unanswered]; this.inbox.splice(0);
      // A plan that already covers this mission does not need rewriting to decide what to do
      // next, and rewriting it is what costs six calls and a thousand tokens of charter.
      const planned=this.memory.data.plan.length && this.memory.data.planMission===this.memory.data.mission;
      context.turnKind = planned ? 'routine' : 'planning';
      await this.mind.turn(context, async(name,args) => {
        const result=await this.queueTool(name,args,revision,controller.signal);
        if(name==='_updates' && result.revision!==undefined) revision=result.revision;
        return result;
      }, controller.signal, event=>{ if(event.kind==='model_start') this.turnCalls++; this.debug?.trace(event); });
    })().catch(error => {
      if (!controller.signal.aborted) this.note('thinking_failed', { message: `Agent review failed: ${error.message}. Safety remains active; retrying on the review interval.` });
    }).finally(() => {
      this.thinking = null; this.lastReview = Date.now();
      // A review that ran out of budget has unfinished business -- typically an operator request
      // answered but not yet acted on. Come back to it once, soon; twice would be the runaway.
      if (this.budgetExhausted && !this.budgetRetried) { this.budgetRetried = true; this.followUp = Date.now()+8000; }
      else { this.budgetRetried = false; this.followUp = 0; }
      this.budgetExhausted = false;
    });
  }
  async cycle() {
    const state = await this.bridge.state();
    this.debug?.state(state,this.memory.data);
    const fence = `${state.session}:${state.epoch}:${state.worldKey}`;
    if (this.fence && this.fence !== fence) {
      this.invalidate('World or control authority changed');
      if (this.active) await this.release('suspended', 'Control changed');
    }
    this.fence = fence;
    // A reflex is the safety tier doing its job, not a question. It is recorded, and it only
    // becomes the agent's problem if it does not clear: waking a review on every hit meant one
    // skeleton cost more inference than the whole expedition it interrupted.
    if (state.reflex && !this.reflex) {
      this.reflexSince = Date.now(); this.reflexEscalated = false;
      this.note('safety', { message: `Safety owns the body: ${state.reflex}. Recorded; work resumes without a review unless it persists.` });
    }
    if (state.reflex && !this.reflexEscalated && Date.now()-this.reflexSince >= (this.reflexReviewMs ?? 30000)) {
      this.reflexEscalated = true;
      this.wake('Safety has owned the body for 30 seconds');
      this.note('safety_persists', { message: `Safety has owned the body for 30s (${state.reflex}); asking the agent to reconsider.` });
    }
    this.reflex = state.reflex;
    const stalled=Boolean(this.active && state.stagnantTicks>1200);
    if (stalled && !this.stalled) { this.wake('Task stalled');this.note('task_stalled',{taskId:this.active.record.id,message:'Task progress stalled; requesting agent review.'}); }
    this.stalled=stalled;
    const condition = state.dead ? 'dead' : state.health <= 7 ? 'critical' : state.health <= 12 ? 'hurt' : state.food < 18 ? 'hungry' : 'stable';
    if (condition !== this.condition) {
      // Crossing into danger is a decision; every other crossing is a fact. Hunger ticking past
      // eighteen and back is not worth half a minute of inference.
      if (this.condition && (condition === 'critical' || condition === 'dead')) this.invalidate('Health became critical');
      this.condition = condition;
      this.note('condition', { condition, health:state.health, food:state.food });
    }
    if (state.dead && !this.recovering && this.agent.recovery) {
      this.recovering = this.agent.recovery.handle().catch(e => this.note('recovery_failed',{message:e.message})).finally(() => {this.recovering=null;});
    }
    if (!state.reflexArmed && state.online && !state.dead) await this.bridge.reflex(state,true);
    // RPCs are applied serially here, never concurrently with another body mutation.
    if(this.thinking && Date.now()-this.lastThinkingNotice>=15000) {
      this.lastThinkingNotice=Date.now();
      this.emit({kind:'thinking_progress',message:`Agent reviewing: ${this.turnCalls} model call${this.turnCalls===1?'':'s'}, ${Math.round((Date.now()-this.thinkingSince)/1000)}s. ${this.active?'The current task keeps running.':'No task is executing; /tasks shows suspended work.'}`});
    }
    const request = this.requests.shift();
    if (request) {
      let result;
      try {
        if (request.signal.aborted) throw Error('Review stopped');
        if (request.name==='_updates') {
          if(request.revision===this.revision && !this.inbox.length) result={changed:false,revision:this.revision};
          else {
            const revision=this.revision, count=this.inbox.length;
            const briefing=this.briefing(await this.snapshot());
            // A delta, not the whole briefing again: appending a second copy of it doubled the
            // prompt for every call after the first one in a review.
            result={changed:true,revision,reason:this.updateReason,operatorMessages:this.inbox.splice(0,count),
              briefing:{state:briefing.state,activeTask:briefing.activeTask,mission:briefing.mission,
                attention:briefing.attention,situation:briefing.situation}};
            if(revision===this.revision) this.forceReview=false;
          }
        } else {
          if(request.revision!==this.revision && !['_message','say','report_task'].includes(request.name)) throw Error('Obsolete review: read updates before applying this decision');
          result = await this.tool(request.name, request.args);
          if(['start_task','resume_task','say','set_plan','finish_mission'].includes(request.name)) this.turnProductive=true;
          if(!request.name.startsWith('_')) this.debug?.event({kind:'tool_result',tool:request.name,args:request.args,result});
        }
      } catch (error) { result = { error:error.message }; this.debug?.event({kind:'tool_rejected',tool:request.name,args:request.args,result}); }
      request.resolve(result ?? {});
    }
    // While a task is running and making progress there is nothing to decide, so the clock that
    // matters is the idle one. The long clock behind it is a supervision backstop, not a poll.
    const since = Date.now()-this.lastReview;
    const backoff = Math.min(4, 1 + (this.quickFailures ?? 0));
    const due = this.forceReview || (this.followUp && Date.now() >= this.followUp)
      || since >= (this.active ? this.activeReviewMs : this.reviewMs * backoff);
    if (!this.thinking && !this.stopped && state.online && !state.dead && due) this.deliberate();
    return state;
  }
  async tool(name, args = {}) {
    if (name === '_message') { this.memory.message(args.role,args.content); return {}; }
    // Deliberately not a wake. A review that spent its whole budget without deciding anything
    // will do the same again immediately; five of those in a row is what a runaway looks like.
    // Running out of calls having started work is a full review, not a failed one. Only a
    // review that decided nothing is worth coming straight back to.
    if (name === '_budget') {
      this.budgetExhausted=!this.turnProductive;
      this.note('review_budget', {message:this.turnProductive
        ? 'Agent used its whole tool budget; work is under way, so the next review waits its turn.'
        : 'Agent used its whole tool budget without deciding anything; reviewing again shortly.'});
      return {};
    }
    if (name === 'yield') return {activeTask:this.active?.record.id ?? null};
    if (name === 'state') { const current=await this.snapshot(); return args.full?current:this.briefing(current); }
    if (name === 'journal') return this.memory.query(args.query,args.limit);
    if (name === 'conversation') return this.memory.data.conversation.filter(m => m.content.toLowerCase().includes(String(args.query ?? '').toLowerCase())).slice(-Math.min(100,Math.max(1,args.limit ?? 20)));
    if (name === 'report_task') {
      const task=this.findTask(args.taskId);
      if(!task) throw Error(`Unknown task. Open tasks: ${this.memory.data.tasks.slice(-5).map(t=>`${t.id} (${t.status})`).join(', ')||'none'}`);
      const message=`Task ${task.id}: ${task.spec?.kind??'task'} is ${task.status}${task.reason?` (${task.reason})`:''}.`;
      this.note('task_report',{taskId:task.id,message});return task;
    }
    if (name === 'say') {
      if (typeof args.text !== 'string' || !args.text.trim()) throw Error('say needs text');
      // Action reports belong to observed task events. Catch the common false acknowledgement
      // forms; open-ended conversational truthfulness still depends on grounding and evaluation.
      // The guard is against claiming something is happening when nothing is. Whether that is a
      // false claim depends on the body, not on the verb: "Gathering logs" while a gather runs is
      // simply true, and rejecting it cost a whole generation to say nothing.
      const claim=args.text.trim().match(/^(?:i(?: am|'m| have| just)?\s+)?(eating|ate|equipping|equipped|mining|gathering|crafting|smelting|walking|moving|resuming)\b/i);
      if (claim) {
        // "Eating now to restore health" while a mining task runs is the exact failure the
        // operator kept catching: a sentence standing in for an action. Whether the claim is true
        // depends on which activity owns the body, so check that one, not merely that some task
        // exists.
        const verb=claim[1].toLowerCase(), kind=this.active?.record.spec.kind, eating=kind==='eat'||this.reflex==='eat';
        const supported={eating,ate:eating,equipping:kind==='equip',equipped:kind==='equip',
          mining:['gather','obtain','shaft'].includes(kind),gathering:['gather','obtain'].includes(kind),
          crafting:kind==='obtain',smelting:kind==='obtain',
          walking:['navigate','gather','obtain'].includes(kind),moving:['navigate','gather','obtain','shaft'].includes(kind),
          resuming:Boolean(kind)}[verb];
        // Naming the call matters. Told only to "start that task first" the model paused the
        // mining task, announced it was eating, and stopped -- five reviews in a row.
        const objectiveId=this.memory.data.plan.find(node=>['planned','active','blocked'].includes(node.status))?.id ?? 'your objective';
        const how=verb==='eating'||verb==='ate'
          ? ` To make it true: start_task {objectiveId:"${objectiveId}",kind:"eat",targetFood:20,why:"..."} -- it suspends the running task for you.`
          : ' Start the task that does it first.';
        if (!supported) throw Error(`Nothing is ${verb==='ate'?'eating':verb} right now${kind?`; the running task is ${kind}`:''}.${how} say carries intentions; report_task carries verified status.`);
      }
      this.unanswered=[]; this.note('say',{message:`agent: ${args.text}`}); return {delivered:true};
    }
    if (name === 'set_plan') {
      // Status and parent are bookkeeping. Omitting the status is not a different plan, and a
      // parent naming something that is not a node is not a hierarchy -- rejecting the whole plan
      // over either cost a generation to re-emit the same three objectives.
      // A rewritten plan that spells an objective `iron_resources` where it was `iron-resources`
      // is the same objective, not a deletion; treating it as new orphaned the task attached to it
      // and the whole revision was refused.
      const key=text=>String(text??'').toLowerCase().replace(/[^a-z0-9]/g,'');
      const known=new Map(this.memory.data.plan.map(node=>[key(node.id),node.id]));
      const settle=id=>known.get(key(id)) ?? id;
      const ids=new Set((args.nodes??[]).map(node=>settle(node?.id)));
      const nodes=args.nodes?.map(node=>({...node,id:settle(node?.id),
        status:['planned','active','complete','blocked','abandoned'].includes(node?.status)?node.status:'planned',
        parent:node?.parent && ids.has(settle(node.parent)) && settle(node.parent)!==settle(node.id) ? settle(node.parent) : null,
        targets:this.normalizeTargets(node?.targets,this.memory.data.missionTargets??[])}));
      const updated=this.memory.setPlan(nodes,this.memory.data.revision);
      // What the plan was written for. A plan that already covers this mission makes every later
      // review a routine one, which is what keeps the charter out of the prompt.
      this.memory.data.planMission=this.memory.data.mission; this.memory.save();
      this.emit({kind:'plan_updated',message:`Agent plan revised: ${updated.plan.map(n=>n.title).join('; ')}`});return updated;
    }
    if (name === 'recipe_plan') {
      const current = await this.snapshot();
      const reserved=this.reservations(args.objectiveId);
      const available=Object.fromEntries(Object.entries(current.inventory).map(([item,n])=>[item,Math.max(0,n-(reserved[item]??0))]));
      let targets=this.normalizeTargets(args.targets,this.memory.data.missionTargets??[]);
      if (args.kit) {
        if (!['iron_toolset_and_armor','diamond_toolset_and_armor'].includes(args.kit)) throw Error('Unknown kit; use explicit targets');
        const material=args.kit.split('_')[0];
        targets=kitTargets(material);
      }
      const plan=this.planner.planMany(targets,available,{stations:current.observation.stations ?? []});
      if(args.full) return {...plan,reserved};
      this.emit({kind:'recipe_checked',message:`Material calculation: ${Object.entries(plan.summary??{}).map(([item,n])=>`${n} ${item.replace('minecraft:','')}`).join(', ') || plan.reason || 'targets already held'}. No task started.`});
      return {status:plan.status,reason:plan.reason,targets:plan.targets,summary:plan.summary,reserved,
        projectedInventory:plan.projectedInventory,nextSteps:plan.nodes.slice(0,6).map(n=>({kind:n.kind,item:n.item,count:n.count,tool:n.tool})),stepCount:plan.nodes.length,
        note:'Calculator only. Author a concise project plan, then explicitly start one task. Obtain accepts all these targets together; gather accepts an expedition quota.'};
    }
    if (name === 'remember_site') {
      if (!args.name || !args.kind || ![args.x,args.y,args.z].every(Number.isInteger)) throw Error('Site needs name, kind and integer x,y,z');
      const state = await this.bridge.state();
      if (Math.hypot(state.x-args.x,state.y-args.y,state.z-args.z)>48) throw Error('Only record sites within current observation range');
      const site = {name:args.name,kind:args.kind,x:args.x,y:args.y,z:args.z,worldKey:state.worldKey,observedAt:state.observedAt};
      this.memory.data.sites = this.memory.data.sites.filter(s => !(s.name===site.name && s.worldKey===site.worldKey));
      this.memory.data.sites.push(site); this.note('site_recorded',{site}); return site;
    }
    if (name === 'start_task') return this.start(args);
    if (['pause_task','cancel_task'].includes(name)) {
      const record = this.findTask(args.taskId);
      if (!record) throw Error('Unknown task; nothing is running');
      // Work needs a moment to be work. Observed live: obtain paused for gather, gather paused
      // for obtain, five times in nine minutes, each swap costing a stop, a review and a restart
      // while the two objectives it was alternating between wanted the same materials. Safety,
      // failure and the operator all still interrupt -- they come through other paths.
      const running = this.active?.record.id === record.id ? Date.now()-(record.startedAt ?? record.createdAt) : Infinity;
      if (name === 'pause_task' && running < this.commitMs && !this.unanswered.length)
        throw Error(`Task ${record.id} has been running ${Math.round(running/1000)}s of a ${Math.round(this.commitMs/1000)}s commitment. Let it work -- swapping between objectives costs a review each way. Pause it once it stalls or fails, or cancel it if it is genuinely the wrong task.`);
      if (this.active?.record.id === record.id) await this.release(name==='pause_task'?'suspended':'cancelled',args.why || name);
      else if (record.status==='suspended') { record.status=name==='pause_task'?'suspended':'cancelled'; this.memory.save(); }
      else throw Error(`Task is ${record.status}`);
      return record;
    }
    if (name === 'resume_task') {
      const record = this.findTask(args.taskId) ?? this.memory.data.tasks.filter(t=>t.status==='suspended').at(-1);
      if (!record || record.status!=='suspended') throw Error('Only suspended tasks can resume');
      return this.start({...record.spec,why:args.why ?? record.spec.why},record);
    }
    if (name === 'finish_mission') {
      if (this.active) throw Error('A task is still running');
      const current = await this.snapshot();
      for(const target of this.memory.data.missionTargets??[]) if((current.inventory[target.item]??0)<target.count) throw Error(`Mission still needs ${target.item}; intermediate materials do not complete the kit`);
      const plan = this.memory.data.plan;
      if (!plan.some(n=>n.status==='complete') || plan.some(n=>!['complete','abandoned'].includes(n.status))) throw Error('Review and close all objectives before finishing');
      const finalObjectives=(this.memory.data.missionTargets??[]).length?[]:plan.filter(n=>n.status==='complete' && (!n.parent || n.retain===true));
      for (const node of finalObjectives) for (const target of node.targets ?? [])
        if ((current.inventory[itemId(target.item)]??0)<target.count) throw Error(`Missing completion target: ${target.item}`);
      this.note('mission_complete',{message:'Agent marked the mission complete after reviewing the plan and current inventory.'});
      this.stopped=true; return {complete:true};
    }
    throw Error(`Unknown tool: ${name}`);
  }
  nextTaskId() {
    let next=this.memory.data.tasks.length+1;
    while (this.memory.data.tasks.some(task=>task.id===`t${next}`)) next++;
    return `t${next}`;
  }
  async start(spec, resumed = null) {
    // Eating is the one thing that cannot wait its turn. Regeneration needs a full hunger bar,
    // the window closes while the agent is still composing a sentence about it, and an operator
    // who says "eat right now" is not asking for a plan revision. So the host suspends the
    // running task rather than refusing -- the task stays suspended, and resuming it stays the
    // agent's decision, which is the part that actually matters.
    if (this.active && spec.kind === 'eat') {
      const interrupted = this.active.record.id;
      await this.release('suspended', 'Preempted to eat; resume when ready');
      this.preempted = interrupted;
    }
    if (this.active) throw Error(`Task ${this.active.record.id} (${this.active.record.spec.kind}) owns the body. Call pause_task {taskId:"${this.active.record.id}"} first, then start this one.`);
    if (this.actions >= this.maxActions) throw Error('Task budget exhausted; stop or restart the run');
    const revision = this.revision;
    const current = await this.snapshot();
    if (revision !== this.revision || this.stopped) throw Error('Task request became obsolete while observing');
    if (!current.state.online || !current.state.canAct || current.state.reflex || current.state.stopPending || current.state.acting || current.state.pendingActionId)
      throw Error('Body unavailable or under safety/manual control; inspect state before retrying');
    if (current.state.skillsVersion !== 4) throw Error('Client needs the new agent skills protocol. Build, install and restart Minecraft.');
    const objective = this.findObjective(spec.objectiveId);
    if (!objective) throw Error(`No such objective. Open objectives: ${this.memory.data.plan.filter(n=>['planned','active','blocked'].includes(n.status)).map(n=>`${n.id} (${n.title})`).join(', ')||'none; write a plan first'}`);
    if (!['planned','active','blocked'].includes(objective.status)) throw Error(`Objective ${objective.id} is ${objective.status}`);
    if (!spec.why || typeof spec.why!=='string') throw Error('Record why this task serves the objective');
    spec={...spec,objectiveId:objective.id};
    // An obtain with no targets means the objective's, or the mission's. Refusing it taught the
    // model nothing it could act on and cost a generation each time.
    if(spec.kind==='obtain') {
      const asked=this.normalizeTargets(spec.targets,this.memory.data.missionTargets??[]);
      spec={...spec,targets:asked ?? (objective.targets?.length?objective.targets:this.memory.data.missionTargets)};
    }
    // One expedition collects one thing. Asked to gather it supplied the whole shopping list,
    // which is what obtain is for; a single-item list is simply what it meant.
    if(spec.kind==='gather' && !spec.item) {
      const asked=this.normalizeTargets(spec.targets,this.memory.data.missionTargets??[]) ?? objective.targets ?? [];
      if(asked.length!==1) throw Error('gather takes one {item,count}. For several items use kind "obtain", which batches the whole dependency chain in one task.');
      spec={...spec,item:asked[0].item,count:spec.count??asked[0].count};
    }
    const protectedItems=this.reservations(spec.objectiveId);
    const available=Object.fromEntries(Object.entries(current.inventory).map(([item,n])=>[item,Math.max(0,n-(protectedItems[item]??0))]));
    const checked = {...this.skills.prepare(spec,{...current,inventory:spec.kind==='obtain'?available:current.inventory},resumed?.spec),protectedItems};
    if (resumed && resumed.worldKey !== current.state.worldKey) throw Error('Cannot resume a task in a different world');
    if (checked.kind==='obtain') {
      const preview=this.planner.planMany(checked.targets,available,{stations:current.observation.stations??[]});
      if (preview.status!=='planned') throw Error(preview.reason);
      if (!preview.nodes.length) return {status:'already_satisfied',targets:checked.targets};
    }
    // Short ids, because the model has to reproduce them. Given UUIDs it invented plausible
    // names instead -- `mine_emeralds` for a task that never existed.
    const record = resumed ?? {id:this.nextTaskId(),objectiveId:spec.objectiveId,worldKey:current.state.worldKey,createdAt:Date.now(),spec:checked};
    record.spec=checked;record.status='requested';record.reason=spec.why;record.updatedAt=Date.now();record.startedAt=Date.now();
    if (!resumed) this.memory.data.tasks.push(record);
    objective.status='active';this.memory.save();
    const controller = new AbortController(); const active = {record,controller}; this.active=active;this.actions++;
    this.note('task_requested',{taskId:record.id,spec:record.spec,message:`Task ${record.id} requested: ${record.spec.kind} — ${spec.why}`});
    active.finished = this.skills.execute(record.spec,controller.signal,progress => {
      if (this.active !== active || controller.signal.aborted) return;
      record.progress=progress;record.updatedAt=Date.now();
      if (progress.phase==='running' || progress.phase==='recovering') record.status=progress.phase;
      this.memory.save();
      if (progress.message) this.note('task_progress',{taskId:record.id,progress,message:progress.message});
    }).then(() => {
      if (controller.signal.aborted) return;
      this.quickFailures=0;
      record.status='completed';this.note('task_completed',{taskId:record.id,message:`Task ${record.id} completed and verified. Returning to agent.`});
    }).catch(error => {
      if (controller.signal.aborted) return;
      record.status=['safety_preempted','control_changed','assumption_violated','expedition_limit'].includes(error.failure)?'suspended':'failed';
      // A task that dies in the first few seconds has not learned anything the next review will
      // learn either. Observed live: six starts in nine minutes, each failing instantly on the
      // same precondition, each buying another full review. Back off instead of spinning.
      this.quickFailures=Date.now()-(record.startedAt??0)<5000?(this.quickFailures??0)+1:0;
      record.reason=error.message;
      this.note('task_'+record.status,{taskId:record.id,failure:error.failure,message:`Task ${record.status}: ${error.message}`});
    }).finally(() => {
      record.updatedAt=Date.now();this.memory.save();
      // A finished task is a reason to look, not a reason to void a decision already in flight.
      if (this.active===active && !controller.signal.aborted) {this.active=null;this.wake('Task outcome needs review');}
    });
    const preempted=spec.kind==='eat'?this.preempted:undefined;
    this.preempted=undefined;
    return {taskId:record.id,status:record.status,spec:record.spec,
      ...(preempted?{suspended:preempted,note:`Task ${preempted} was suspended to eat; resume_task {taskId:"${preempted}"} when you are ready.`}:{})};
  }
  async release(status, why) {
    const active=this.active;
    if (!active) return;
    active.record.status='cancelling';active.controller.abort();this.memory.save();
    await active.finished;
    await this.agent.stop({keepSafety:true});
    for (let i=0;i<30;i++) {
      const state=await this.bridge.state();
      if (!state.acting && !state.pendingActionId && !state.stopPending) {
        active.record.status=status;active.record.reason=why;
        this.active=null;this.fence=`${state.session}:${state.epoch}:${state.worldKey}`;
        this.note('task_'+status,{taskId:active.record.id,message:`Task ${status}: ${why}`});return;
      }
      await delay(100);
    }
    // Keep ownership fenced: an unconfirmed stop cannot be followed by new work.
    throw Error('Client release unconfirmed; no replacement task may start');
  }
  async run(signal) {
    const stop=()=>{this.stopped=true;this.invalidate('Operator stopped the run');this.active?.controller.abort();};
    signal?.addEventListener('abort',stop,{once:true});
    if(signal?.aborted) stop();
    await this.bridge.reflex(await this.bridge.state(),true);
    this.note('run_started',{message:`Mission: ${this.goal}. Agent owns all task starts.`});
    try {
      while (!this.stopped && !signal?.aborted) {
        try { await this.cycle(); } catch(error) {this.emit({kind:'cycle_failed',message:error.message});}
        try {await delay(this.cycleMs,undefined,{signal});} catch {break;}
      }
    } finally {
      signal?.removeEventListener('abort',stop);
      this.stopped=true;this.invalidate('Run stopped');
      for(const request of this.requests.splice(0)) request.resolve({error:'Run stopped'});
      await this.release('suspended','Run stopped').catch(error=>this.emit({message:error.message}));
      await this.mind.close?.();
      await this.agent.stop().catch(()=>{});
      this.note('run_stopped',{message:`Stopped. Plan and conversation saved; resuming requires an agent decision.`});
    }
  }
}
async function main() {
  const readline = await import('node:readline');
  const { classify } = await import('./commands.js');
  const { queries, QUERY_HELP } = await import('./queries.js');
  const { openSession, flag } = await import('./setup.js');
  const args = process.argv.slice(2);
  const goal = args.filter(a => !a.startsWith('--') && a !== flag(args, '--cycle') && a !== flag(args, '--every')).join(' ').trim();
  if (!goal) { console.error('Give a goal, for example: ./realm-agent run "walk to 200 200"'); process.exit(2); }
  // A run prints continuously while the operator is typing into the same terminal. Without
  // redrawing the input line, every log line shreds whatever is half-typed: a live run turned
  // "nah wait get 4 logs instead" into six fragments scattered through the output, and the
  // operator resorted to typing "hello? stop" because nothing looked like it was being read.
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  // Wall clock plus the gap since the previous line, so deliberation latency and the dead time
  // between actions are readable straight from the transcript instead of being guessed at.
  let printedAt = Date.now();
  const stamp = () => {
    const now = new Date(), gap = (Date.now() - printedAt) / 1000;
    printedAt = Date.now();
    return `[${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')} +${gap.toFixed(1)}s]`;
  };
  const print = text => {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    console.log(`${stamp()} ${text}`);
    input.prompt(true);
  };
  const { config, bridge, agent, log } = await openSession({ args: [...args, '--model'], name: 'run',
    emit: event => print(event.message ?? `${event.state?.phase}: ${event.state?.reason}`) });
  const state = await bridge.state();
  if (!state.online) throw Error('Join a world first');
  if (state.protocol < 3) throw Error(`Bridge speaks protocol ${state.protocol}; restart Minecraft`);
  if (state.skillsVersion !== 4) throw Error('Restart Minecraft to load the rebuilt mod (skills version 4 required).');
  const { SkillExecutor } = await import('./skills.js');
  const emit = event => { log.emit(event); print(event.message); };
  const world = createHash('sha256').update(state.worldKey || state.session).digest('hex').slice(0,16);
  const { root } = await import('./setup.js');
  const memory = new AgentMemory(`${root}/../runtime/agent-memory-${world}.json`);
  const debug=new DebugMonitor(`${root}/../runtime/agent-debug.json`);
  let inspector;
  try {inspector=await serveDebug(()=>debug.data);print(`Live inspector: ${inspector.url}`);} catch(error) {print(`Inspector server unavailable: ${error.message}. Trace saved to runtime/agent-debug.json`);}
  const runner = new Runner({ agent, bridge, config, memory, debug,
    goal, skills: new SkillExecutor(bridge, message => emit({ kind: 'skill-progress', message })), emit,
    cycleMs: Number(flag(args, '--cycle') ?? 500), reviewMs: Number(flag(args, '--every') ?? 20000) });
  const controller = new AbortController();
  // A second Ctrl+C must always work. Registering any SIGINT listener disables Node's default
  // terminate, so once the run has ended the handler has nothing left to abort and the terminal
  // looks wedged with nothing reading it -- which is exactly how a finished run got stuck.
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) { console.log('\nForce quit.'); process.exit(130); }
    stopping = true; print('Stopping. Press Ctrl+C again to force quit.'); controller.abort();
  });
  // Operator conversation is independent of the mission and the body task.
  const look = queries({ bridge, attempts: runner.attempts, log: event => log.emit(event) });
  input.on('line', line => {
    const routed = classify(line);
    if (routed.kind === 'stop') { print('Stopping.'); controller.abort(); return; }
    if (routed.kind === 'empty') { input.prompt(); return; }
    if (routed.kind === 'help') { print(`${QUERY_HELP}\n\nAnything else is conversation with the agent. /agent-plan shows the plan, /tasks shows task history. "stop" ends the run.`); input.prompt(); return; }
    // Read-only commands work here for the same reason they work during a console goal: they look
    // and never touch action authority. `/plan` reaching this as a `preview` is why it is matched
    // before the goal path -- it previously fell through and silently retargeted the run.
    if (line.trim() === '/agent-plan') { print(JSON.stringify(memory.data.plan,null,2)); return; }
    if (line.trim() === '/tasks') { print(JSON.stringify(memory.data.tasks.slice(-10),null,2)); return; }
    if (routed.kind === 'preview') { void look.run('plan', [routed.text]).then(print).catch(e => print(e.message)); return; }
    if (routed.kind === 'command' && look.handles(routed.name)) {
      void look.run(routed.name, routed.rest).then(print).catch(e => print(e.message)); return;
    }
    if (routed.kind === 'command' && (routed.name === 'quit' || routed.name === 'exit')) { print('Stopping.'); controller.abort(); return; }
    if (routed.kind === 'command' && routed.name === 'goal') {
      if(!routed.rest.length) print(`Current mission: ${runner.memory.data.mission}`);
      else runner.retarget(routed.rest.join(' '));
      input.prompt(); return;
    }
    if (routed.kind === 'command') {
      print(`/${routed.name} changes something, and a run owns the body. Say what you want in plain words instead, or stop. /help lists what you can look at.`);
      input.prompt(); return;
    }
    // A bare line is talk, not a new mission. The overseer reads it, decides what it means for
    // what it is doing, answers, and explicitly controls its tasks. Replacing the mission
    // outright is what `/goal` is for, and it stays available for exactly that.
    runner.tell(routed.text ?? line.trim());
    input.prompt();
  });
  print('Talk to the agent at any time -- ask what it is doing, or ask it to do something and it decides where that fits.');
  print('"/goal <text>" replaces its mission outright, "/help" looks at things, "stop" ends the run.');
  try { await runner.run(controller.signal); } finally {
    stopping = true;
    input.close(); log.close();
    debug.save(true);await inspector?.close();
    // Closing the interface leaves stdin resumed, which keeps the event loop alive forever with
    // nothing consuming what is typed. Release it, and force the exit if anything else lingers.
    process.stdin.pause(); process.stdin.unref?.();
    setTimeout(() => process.exit(0), 2000).unref();
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
