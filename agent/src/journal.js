import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function journal(path) {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
  let dropped = 0, failed = false;
  stream.on('error', e => { failed = true; console.error('Journal unavailable:', e.message); });
  return { emit(event) {
    if (failed || stream.writableLength > 1024 * 1024) { dropped++; return; }
    stream.write(JSON.stringify({ ...event, ts: new Date().toISOString(), dropped })+'\n');
  }, close: () => stream.end() };
}
