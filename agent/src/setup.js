import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export function flag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw Error(`${name} requires a value`);
  return value;
}
/**
 * The standing purpose, authored by the operator and never by the agent.
 *
 * Loaded from disk on every start rather than baked in, so editing the charter and restarting is
 * the whole workflow for changing what the agent is for. Missing is not fatal: the agent then has
 * no purpose to fall back on and says so, which is a better failure than inventing one.
 */
export function loadCharter(path = resolve(root, '../config/charter.md')) {
  try { return readFileSync(path, 'utf8').trim(); }
  catch { return ''; }
}
/** Shared entry for every console: same config file, same per-instance bridge token. */
export function loadConfig(args) {
  const config = JSON.parse(readFileSync(resolve(root, '../config/mvp.json')));
  config.modelEnabled = args.includes('--model');
  config.charter = loadCharter();
  const tokenFile = flag(args, '--token-file')
    ?? resolve(root, args.includes('--dev') ? '../client-mod/run/config/windove-bridge-token.txt' : '../runtime/realm-client/config/windove-bridge-token.txt');
  let token;
  try { token = readFileSync(tokenFile, 'utf8').trim(); }
  catch { console.error(`Start the client bridge first. Token file missing: ${tokenFile}`); process.exit(1); }
  return { config, token };
}

/**
 * The one place an agent is assembled. Every entry point uses it, so no console or harness can
 * be built without death recovery attached — which is exactly the bug this replaces: the bench
 * ran with no recovery, the character died mid-run, and every later trial failed for 60 seconds
 * at a time against a death screen nothing was watching.
 */
export async function openSession({ args = [], emit = () => {}, name = 'session', planner: plannerOverride } = {}) {
  const { Bridge } = await import('./bridge.js');
  const { Supervisor } = await import('./supervisor.js');
  const { Recovery } = await import('./recovery.js');
  const { Planner } = await import('./planner.js');
  const { journal } = await import('./journal.js');
  const { config, token } = loadConfig(args);
  const log = journal(resolve(root, `../runtime/${name}-${Date.now()}.jsonl`));
  const relay = event => { log.emit(event); emit(event); };
  const bridge = new Bridge({ url: config.bridgeUrl, token });
  const planner = plannerOverride ?? new Planner(config);
  const agent = new Supervisor({ bridge, planner, site: config.site, emit: relay });
  agent.recovery = new Recovery({ bridge, planner, modelEnabled: config.modelEnabled, emit: relay });
  return { config, token, bridge, agent, log, planner };
}
