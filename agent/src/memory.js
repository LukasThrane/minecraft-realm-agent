import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Durable intentions and evidence. Loading never authorizes execution. */
export class AgentMemory {
  constructor(path = null) {
    this.path = path;
    this.data = { version: 1, mission: '', revision: 0, plan: [], tasks: [], sites: [], conversation: [], events: [] };
    if (path && existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved.version !== 1) throw Error('Unsupported agent memory version');
      this.data = saved;
    }
    for (const task of this.data.tasks) if (['requested','running','recovering','cancelling'].includes(task.status)) {
      task.status = 'suspended'; task.reason = 'Process restarted; reconcile observations before explicit resume';
    }
  }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path + '.tmp', JSON.stringify(this.data, null, 2));
    renameSync(this.path + '.tmp', this.path);
  }
  event(kind, details = {}) {
    const event = { at: Date.now(), kind, ...details };
    this.data.events.push(event);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path + '.journal.jsonl', JSON.stringify(event) + '\n');
    }
    // The append-only journal retains the complete record; this is the working cache.
    this.data.events = this.data.events.slice(-300);
    this.save(); return event;
  }
  message(role, content) { this.data.conversation.push({ role, content }); this.save(); }
  query(query = '', limit = 30) {
    limit = Math.min(100, Math.max(1, Number(limit) || 30));
    const events = this.path && existsSync(this.path + '.journal.jsonl')
      ? readFileSync(this.path + '.journal.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : this.data.events;
    return events.filter(e => JSON.stringify(e).toLowerCase().includes(String(query).toLowerCase())).slice(-limit);
  }
  setPlan(nodes, expectedRevision) {
    if (expectedRevision !== this.data.revision) throw Error('Plan changed; read state and use its planRevision');
    if (!Array.isArray(nodes) || nodes.length > 64) throw Error('plan must contain at most 64 nodes');
    const ids = new Set();
    for (const node of nodes) {
      if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id)) throw Error('Plan ids must be unique strings');
      ids.add(node.id);
      if (typeof node.title !== 'string' || !node.title || typeof node.success !== 'string' || !node.success) throw Error('Each objective needs title and success conditions');
      if (!['planned','active','complete','blocked','abandoned'].includes(node.status)) throw Error('Invalid objective status');
      for (const [item,count] of Object.entries(node.reserves??{})) {
        if (!/^minecraft:[a-z0-9_]+$/.test(item) || !Number.isInteger(count) || count<0) throw Error('Reserves require item ids and nonnegative integer counts');
      }
      if (node.targets!==undefined && (!Array.isArray(node.targets) || node.targets.some(t=>typeof t.item!=='string' || !Number.isInteger(t.count) || t.count<1 || t.count>256))) throw Error('Invalid objective targets');
    }
    for (const node of nodes) {
      const chain = new Set([node.id]); let parent = node.parent;
      while (parent) {
        if (!ids.has(parent) || chain.has(parent)) throw Error('Invalid or cyclic plan parent');
        chain.add(parent); parent = nodes.find(n => n.id === parent).parent;
      }
    }
    for (const task of this.data.tasks.filter(t => ['requested','running','recovering','cancelling'].includes(t.status))) {
      const node = nodes.find(n => n.id === task.objectiveId);
      if (!node || ['abandoned','complete'].includes(node.status)) throw Error('Pause or cancel the objective’s task before removing or closing it');
    }
    this.data.plan = structuredClone(nodes); this.data.revision++;
    this.event('plan_updated', { revision: this.data.revision, plan: nodes });
    return { planRevision: this.data.revision, plan: this.data.plan };
  }
}
