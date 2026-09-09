import { validateAction } from './commands.js';
export class Planner {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }
  /**
   * One goal-level decision. The model never sees pixels or a tick: it sees a situation, a trend,
   * the typed outcomes of what it already tried, and what is running right now. `continue` is a
   * first-class answer and the cheapest one, because the body is already busy while this runs.
   */
  async decide({ goal, situation, trend, recent, banned, active, rejection }, signal) {
    if (!this.config.modelEnabled) throw Error('Model disabled; start with --model');
    const response = await this.fetch(`${this.config.ollamaUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)].filter(Boolean)),
      body: JSON.stringify({ model: this.config.model, stream: false, options: { temperature: 0.2, num_predict: 200 },
        // x and z are required unconditionally: a per-type conditional requirement is not
        // expressible here, and leaving them optional produced navigate decisions with no
        // destination, rejected in a loop the model could not see or learn from.
        // Every field is required: a per-type conditional requirement is not expressible here, and
        // optional fields came back missing, producing navigate with no destination and move with
        // no duration. Fields irrelevant to the chosen type are ignored.
        format: { type: 'object', additionalProperties: false, required: ['type','x','z','direction','ticks','item','count','why'], properties: {
          type: { type: 'string', enum: ['continue','done','obtain','navigate','move','break','place','jump','select'] },
          x: { type: 'integer' }, z: { type: 'integer' },
          direction: { type: 'string', enum: ['forward','back','left','right'] },
          ticks: { type: 'integer' }, slot: { type: 'integer' },
          item: { type: 'string' }, count: { type: 'integer' },
          why: { type: 'string' } } },
        messages: [{ role: 'system', content: [
          // Purpose is operator-authored and arrives from config/charter.md. The model derives
          // objectives from it and is never asked to invent one; an agent that writes its own
          // charter has no fallback, because nothing outranks whatever it last decided it wanted.
          this.config.charter ? `Your standing charter, which you did not write and may not change:\n${this.config.charter}\n` : '',
          'You choose the next action for a Minecraft character. One JSON object, no prose.',
          'Actions: continue (keep doing what is already running), obtain {item,count}, navigate {x,z},',
          'move {direction,ticks 1..100}, break {ticks 1..200} (breaks the block under the crosshair), place, jump, select {slot 0..8}.',
          'obtain is how you get anything: it gathers, crafts, places stations and smelts by itself, working out the whole',
          'dependency chain from what you already carry. Ask for the finished thing -- obtain {item:"stone pickaxe",count:1} --',
          'not for its ingredients, and never step through a recipe with break and place. It runs for minutes; answer',
          'continue while it does. If it fails it will say what was missing.',
          'Prefer continue when the running action is still making progress: it costs nothing and the body never stops.',
          'Answer done when lastOutcomes show the goal has already been achieved. Do not keep re-issuing a finished goal.',
          'Navigation is handled by a pathfinder, so navigate to a destination rather than stepping there with move.',
          'Every field is required. x and z are the navigate destination; direction and ticks belong to move; all are ignored by the actions that do not use them.',
          'If the situation says you are already at the destination, do not navigate there again.',
          'Never repeat something listed as already failed. Choose a different approach instead.',
          'If lastRejection is set, your previous answer was malformed or forbidden. Fix exactly that.',
          'why must be one short sentence.',
          this.config.charter ? 'When the goal is satisfied or absent, choose the next action from the charter rather than stopping.' : ''
        ].filter(Boolean).join(' ') },
          { role: 'user', content: JSON.stringify({ goal, situation, recentChanges: trend, runningNow: active,
            alreadyFailed: banned || 'nothing yet', lastOutcomes: recent, lastRejection: rejection || null }) }]
      })
    });
    if (!response.ok) throw Error(`Ollama ${response.status}`);
    return JSON.parse((await response.json()).message.content);
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
