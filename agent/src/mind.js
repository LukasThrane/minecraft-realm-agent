import { Worker } from 'node:worker_threads';

/** Inference has its own thread. Only the host controller may dispatch body commands. */
export class AgentMind {
  constructor(config) { this.config = config; this.seq = 0; }
  async turn(context, tool, signal, trace = () => {}) {
    if (!this.worker) this.worker = new Worker(new URL('./mind-worker.js', import.meta.url), { workerData: this.config });
    const turn = ++this.seq, worker = this.worker;
    return new Promise((resolve, reject) => {
      const cleanup = () => { worker.off('message', message); worker.off('error', failed); worker.off('exit', exited); signal?.removeEventListener('abort', abort); };
      const failed = error => { cleanup(); this.worker=null; void worker.terminate(); reject(error); };
      const exited = code => { this.worker = null; failed(Error(`Agent worker exited (${code})`)); };
      const abort = () => worker.postMessage({ kind: 'cancel' });
      const message = async msg => {
        if (msg.turn !== turn) return;
        if(msg.kind==='trace') {trace(msg.event);return;}
        if (msg.kind === 'finished') { cleanup(); msg.error ? reject(Error(msg.error)) : resolve(); return; }
        if (msg.kind === 'tool') {
          let result;
          try { signal?.throwIfAborted(); result = await tool(msg.name, msg.args); }
          catch (error) { result = { error: error.message }; }
          worker.postMessage({ kind: 'result', id: msg.id, result });
        }
      };
      worker.on('message', message); worker.on('error', failed); worker.on('exit', exited);
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({ kind: 'turn', turn, context });
      if (signal?.aborted) abort();
    });
  }
  async close() { const worker = this.worker; this.worker = null; if (worker) await worker.terminate(); }
}
