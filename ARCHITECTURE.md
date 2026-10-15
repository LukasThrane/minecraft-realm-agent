# Agent-owned Minecraft execution

Autonomous `./realm-agent run` now has one strategic owner. An agent authors a persistent hierarchical plan and explicitly starts one substantial task at a time. Plan entries never become an executable queue. Completing a task wakes the agent; it does not start another objective.

## Runtime and authority

`runner.js` polls the client and serializes tool requests. `mind.js` runs inference in a dedicated Node worker thread. `planner.js` gives the local model a bounded, multi-call tool loop with tool errors returned in the same conversation. Client safety remains independent of inference.

The worker cannot call the Minecraft bridge directly. An operator message, authority change, safety interruption, or task outcome invalidates older execution decisions. It does not cancel inference: the host delivers an updated briefing at model-call boundaries within the same turn. Only shutdown aborts the worker turn. Pending operator messages receive a short reply before further planning. Model-generated revision numbers are unnecessary: the host serializes plan changes and fences tool calls by review generation. The durable plan itself has a monotonically increasing revision.

Tasks have identities and explicit requested, running, recovering, cancelling, suspended, cancelled, failed, and completed states. Requested means the host accepted an intention; running requires client acknowledgement; completed requires the skill's observed outcome. Pausing or cancelling waits for release before allowing replacement work. An uncertain release retains the task's ownership fence.

Safety can suspend a task without discarding its plan or collected materials. Brief eating can instead enter recovering and continue the same authorized task after one second of stable safe clearance, with at most three recoveries and a 30-second limit per recovery. The agent can disable this per task. Hazards, changed authority and prolonged recovery require review. The agent can read, plan and communicate during safety, and explicitly decides whether to resume once the body is available. Emergency physiology now sees food in the main inventory and supports eating while hurt with 19 hunger. The existing client survival controller remains responsible for immediate physical protection.

Periodic reviews default to 20 seconds after the previous review completes; operator messages and meaningful events wake it earlier. The client provides gathering quantities, elapsed ticks, tool durability, food, health, and staircase progress. Inference timeout does not launch fallback work.

## Memory and tools

`runtime/agent-memory-<world hash>.json` stores the mission, plan, tasks, named sites and conversation. The adjacent `.journal.jsonl` is an append-only event record. State snapshots are replaced atomically. Reloaded active tasks become suspended; restarting never authorizes movement.

The worker receives a compact current briefing, recent conversation and events. Older conversation and events are retrievable through tools. Observed stations and current inventory remain separate from remembered sites. Sites and resumable tasks are scoped to the world identity and dimension.

Tools include state, journal, conversation, recipe_plan, set_plan, remember_site, start_task, pause_task, cancel_task, resume_task, report_task, say, yield and finish_mission. `report_task` reads actual task state. Free-form answers remain model-generated and must be grounded in observations; the runtime rejects common action-acknowledgement sentences through `say`.

## Planning and execution

The recipe calculator accepts multiple desired final holdings and reserves their outputs while calculating shared prerequisites. Named iron and diamond kits contain pickaxe, axe, shovel, sword, hoe, helmet, chestplate, leggings and boots. Canonical operator requests such as “get full iron toolsets and armor” also receive a completion checklist independent of intermediate resource objectives. Ingredients alone cannot satisfy that checklist. Kits are calculator inputs, not autonomous projects. The agent decides how to use them.

Plan nodes can reserve material counts for their objective. Other objectives cannot consume those counts through the recipe executor, and scaffolding observes these reserves. `recipe_plan` accepts an objective ID to calculate from the stock available to that objective.

Supported task kinds:

- `obtain`: acquire a set of final targets, rechecking inventory between mechanical steps. Equipped armor counts toward completion. Station failures receive at most two local rechecks before returning failure to the agent.
- `gather`: collect a quota of additional material with food, health, inventory and durability limits. Gathering stays at the collection site unless an explicit remembered return destination is supplied. Resume preserves the original total rather than adding another full quota.
- `eat`: move usable food into reach and consume until the requested food target is observed.
- `equip`: select an item or equip an armor piece, verifying the result.
- `navigate`: travel to explicit coordinates.
- `shaft`: carve and walk a straight descending staircase, with three blocks of headroom and periodic torches. Requires support under each tread and stops on fluid, inaccessible terrain, missing tools or missing torches. An interrupted staircase must be resumed from its recorded origin.

The executor can perform mechanical steps inside the task the agent selected. It does not choose the next project. Batch smelting retains the existing eight-item transaction limit; an obtain task can execute multiple batches without additional mining trips for each batch.

Gathering and staircase execution check the player’s projected path against contact hazards before continuing movement. Baritone is configured to avoid lava, fire, magma and campfires and to disable parkour. These guards need terrain testing in-game; unit coverage is not proof of safe navigation.

Each run serves a read-only localhost inspector with exact model prompts, streamed output, optional model-returned reasoning, timings, tool results and task state. `./realm-agent debug` follows the saved trace across runs. Defaults are 4096 context tokens, 650 output tokens (180 for replies), with compact mission/objective target references.

## Testing

Run `./realm-agent test` for host regressions and `./realm-agent build` to build, run the client checks and install the jar into the Realm instance. Restart Minecraft to load skills protocol 4.

`node scripts/agent-smoke.mjs` exercises the real configured Ollama model through the worker with a simulated body. It never connects to Minecraft and stops on the first authorized task or after four minutes. Add `--interrupt` to ask it to pause that task and eat at 6 health and 19 hunger, still using a simulated body. Model planning quality is separate from controller correctness; inspect its plan and chosen task rather than treating valid JSON as mission success.

Live checks: start the iron kit mission; inspect `/agent-plan` and `/tasks`; ask why the current expedition exists; request eating during gathering; verify observed eating and continuation of the same task; verify retreat or lava still requires review; stop and restart to verify reconciliation. The staircase capability requires in-game verification of digging, reach and placement across actual terrain. It is not a general house-building or storage-management skill.
