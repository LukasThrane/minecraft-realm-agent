import { parentPort, workerData } from 'node:worker_threads';
import { Planner } from './planner.js';
const planner = new Planner(workerData);
let controller, seq = 0;
const pending = new Map();
parentPort.on('message', async message => {
  if (message.kind === 'cancel') { controller?.abort(); return; }
  if (message.kind === 'result') {
    const call = pending.get(message.id); if (!call) return;
    pending.delete(message.id); call.resolve(message.result); return;
  }
  if (message.kind !== 'turn') return;
  controller = new AbortController();
  const turn = message.turn;
  const tool = (name, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    const signal = controller.signal;
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { pending.delete(id); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve: value => { signal.removeEventListener('abort', abort); resolve(value); } });
    parentPort.postMessage({ kind: 'tool', turn, id, name, args });
  });
  try {
    await planner.turn(message.context, tool, controller.signal, event=>parentPort.postMessage({kind:'trace',turn,event}));
    parentPort.postMessage({ kind: 'finished', turn });
  } catch (error) { parentPort.postMessage({ kind: 'finished', turn, error: error.message }); }
});
