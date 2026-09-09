# Testing MVP: implementation and file plan

Date: 2026-09-09. Scope: direct-client navigation, private commands and outcome logging. The broader research design remains in [PLAN.md](PLAN.md).

## Features in this increment

- Fabric 26.2 bridge connected to a standalone Baritone navigation candidate.
- Actual Minecraft window as the view; no proxies or spectator connection required.
- Navigate to integer x,z; `go to site` means 200,200.
- Private terminal commands, optional local model interpretation, JSONL event records.
- F8 takeover, explicit stop, action/session identifiers, stale observation rejection, deadlines, no-progress detection and a three-second heartbeat lease.
- No movement at startup. No mining, construction, container access, attack or unrestricted generated code is exposed.

This is a navigation testing MVP, not an autonomous survival agent. A successful compile or simulated service test is not proof of reliable world navigation.

## Files and ownership

| File | Role / extension boundary |
| --- | --- |
| `client-mod/settings.gradle`, `build.gradle`, `gradle.properties` | Pinned Fabric build and split client sources; Java release 25. |
| `client-mod/src/main/resources/fabric.mod.json` | Client-only mod declaration. |
| `client-mod/src/client/java/dev/windove/bridge/BridgeClient.java` | Loopback transport and tick-owned navigation lifecycle. Future skills must go through this same cancellation/permission boundary. |
| `config/dependencies.json` | Pinned versions and Baritone artifact SHA-256. |
| `config/mvp.json` | Bridge URL, site and optional local model configuration. |
| `agent/package.json` | Dependency-free Node ESM service and test commands. |
| `agent/src/bridge.js` | Authenticated transport adapter, independent of planning. |
| `agent/src/commands.js` | Immediate stop/status parsing and supported action validation. |
| `agent/src/planner.js` | Optional Ollama intent translator; never executes code. Replaceable later with visual planning. |
| `agent/src/supervisor.js` | Command generations, cancellation, heartbeat and outcome tracking. |
| `agent/src/journal.js` | Bounded asynchronous JSONL logging. |
| `agent/src/cli.js` | Private terminal and polling; not a gameplay controller. |
| `agent/src/setup.js` | Config and per-instance bridge token loading shared by every console. |
| `agent/src/bench.js` | Repeated-route acceptance harness over the same supervisor; reports measurements, never claims them. |
| `agent/src/observe.js` | Observation formatting and staleness rules. The text a planner reads; no control authority. |
| `client-mod/src/client/java/dev/windove/bridge/Reflexes.java` | Safety tier: threat retreat and eating, evaluated on the tick. Deterministic, no model. |
| `client-mod/src/client/java/dev/windove/bridge/Progress.java` | Tick-rate progress scoring, so stagnation is measured rather than guessed. |
| `client-mod/src/client/java/dev/windove/bridge/Actions.java` | Action envelope: validation, before/after snapshots and evidence. One place to add a skill. |
| `agent/src/gate1.js` | Runnable PLAN gate 1: movement, rotation, jump, inventory interaction, two-tick stop release, delayed-planner cancellation. |
| `agent/src/runner.js` | Autonomous loop: persistent goal, non-blocking deliberation, typed-failure memory, loop guards. |
| `agent/src/recovery.js` | Death policy: respawn or wait, rate limited, verified against the client. Never resumes the interrupted goal. |
| `client-mod/src/client/java/dev/windove/bridge/Observations.java` | Read-only tick snapshot: entities, inventory, vitals, light. Writes no game state. |
| `agent/test/bridge.test.js`, `supervisor.test.js`, `bench.test.js`, `observe.test.js`, `recovery.test.js` | Transport, invalid actions, cancellation, stale results, benchmark scoring, observation formatting and death recovery. |
| `scripts/dependencies.py` | Check/fetch the pinned Baritone artifact. |
| `scripts/client-options.py` | Set `pauseOnLostFocus:false` so alt-tabbing to the terminal does not cancel actions. Refuses while the client runs. |
| `windove` | The single entry point. Subcommands for console, gates, build, test and setup. |
| `scripts/build.sh`, `client.sh`, `agent.sh`, `test.sh` | Build, isolated client launch, private service and service tests. |
| `evals/navigation.md` | Manual world evaluation procedure and evidence requirements. |
| `README.md` | Test startup and current limitations. |

Generated, not source: `.cache/gradle/`, `client-mod/libs/`, `client-mod/build/`, `client-mod/run/`, `runtime/`. No existing account configuration or normal Minecraft instance is overwritten. The isolated dev client uses its own game directory. The bridge generates a private token in that instance’s `config/windove-bridge-token.txt`.

## Models and downloads

| Component | Download decision |
| --- | --- |
| Deterministic command/navigation baseline | No model required. Run first. |
| `qwen2.5:14b` | Reuse installed Ollama model with `--model`; language interpretation only. Do not call it a VLM. No fine-tuning. |
| Future visual planner | Not downloaded in this increment. Compare a local VLM and, if selected, remote inference on identical recorded observations. Choose weights only after latency/memory measurements and runtime compatibility checks. |
| OpenHA / CrossAgent | Research candidates from PLAN.md; no weights downloaded. Published CUDA-oriented pipelines are not assumed to run on Apple Silicon or 26.2. |
| Fabric / Minecraft / navigation libraries | Build resolves Minecraft 26.2, Loader 0.19.5, API 0.159.0+26.2 and Loom 1.17.20. Baritone’s unofficial 26.2 candidate is downloaded with a pinned SHA-256 matching GitHub release metadata. |

The development client downloads game assets through Loom. This is test infrastructure, not another Minecraft account or Realm subscription.

## Protocol v3

All endpoints bind to `127.0.0.1:3009`, require a bearer token, and reject browser Origin headers. The bridge is intended for the local service, not a browser calling it directly.

`POST /act` is the single entry for every action, at every level. A request carries `type`, `args`, `actionId`, `session`, `epoch`, `observedAt`, `deadlineMs` and `scope`; `travel` is the only scope that exists and it forbids breaking and placement. `/navigate` and `/respawn` remain as shims that build the same envelope, so there is one path into the tick rather than several.

Action types: `navigate` (x,z), `move` (direction forward/back/left/right, 1..100 ticks), `look` (yaw, pitch, relative), `jump`, `select` (hotbar slot 0..8), `respawn`, `break` (1..200 ticks) and `place`.

Two scopes exist. `travel` forbids breaking and placement and covers everything above except the last two. `build` permits them, and the bridge refuses it with 403 unless the client is running its own integrated server — a structural check on game state, not a setting, so no prompt or model output can reach past it onto a Realm. `break` and `place` act on the block under the crosshair at normal reach and take no coordinate argument, so nothing out of view can be modified. Their evidence is the block registry name before and after at the affected position. Bounds are enforced in `Actions.java` and again in `commands.js`; neither side trusts the other. Preconditions are revalidated on the tick, not trusted from acceptance.

Every action ends with an `outcome` in the plan's vocabulary — `succeeded`, `blocked`, `cancelled`, `failed` — carrying before/after client observations and the evidence that action is judged by: displacement for movement, yaw change for rotation, peak rise for a jump, the selected slot for inventory. Dispatch is never success.

Every non-success also carries a **typed** `failure`: `no_progress`, `deadline`, `precondition`, `interrupted`, `takeover`, `assumption_violated` or `controller_error`. Free text cannot be matched against a remedy the next time the same thing goes wrong, which is the mechanism MineEvolve's gains rest on. Alongside it the outcome reports `progress` (fraction of the recent 40-tick window that advanced), `stagnantTicks`, `remaining` and `bestRemaining`, measured every tick in each action's own terms — distance to goal for navigation, ticks left for a movement window, block state for a break. A genuinely stuck action looks different here from a merely slow one, which a fixed timeout cannot distinguish.

A request may carry `assumes`: the propositions the decision depended on. `minHealth`, `holding` and `maxHostilesWithin: {radius, count}` are supported, bounded identically in `Actions.java` and `commands.js`. They are checked when the action starts and on **every tick after**, and a violation ends the action as `blocked` with `assumption_violated`. This is deliberately not a timestamp: a clock rejects decisions that are merely old while admitting ones that are recent and catastrophically wrong. It is only possible because observations are structured rather than pixels.

`/state` also reports `tick`, `acting`, `stopReleaseTicks`, `stopReleaseMs` and `maxStopReleaseTicks`, so the plan's two-tick stop requirement is a measured number rather than a claim.

Observation endpoints are read-only: they cannot start, steer or extend an action, and looking never cancels one.

- `POST /reflex`: arms or disarms the client-side safety tier, under the same session and epoch authority as any other control call. Once armed it runs on the client tick whether or not the agent process is responsive, which is the entire reason it lives in the mod.
- `GET /history`: the last 60 compact observations, sampled every 10 ticks (about 30 seconds of world time), always on. Each carries position, health, food, light, hostile count, nearest hostile distance and slots used. This is the temporal perception every surveyed system feeds its planner as a frame sequence; twenty numbers per sample carry more of the same signal to a text model than twenty images, and cost nothing to produce. It has to already exist when something asks what just happened, so it is not request-gated.
- `GET /observe`: nearest entities within 48 blocks (hostile flag, position, distance, health), inventory contents and selected slot, player vitals and rotation, light and sky light at the player, weather and game time. Sorted nearest-first before the 64-entity cap, so the cap can never hide something adjacent. Reports `observedAt`, `ageMs` and `fresh`.
- `GET /frame`: PNG of the client's own view, downscaled to roughly 640 wide, with `X-Windove-Captured-At`, `X-Windove-Age-Ms`, `X-Windove-Fresh`, `X-Windove-Width/Height` and `X-Windove-Session`. Returns 503 until the render thread has produced one.
- `POST /respawn`: presses respawn, using the same session/epoch authority as `/navigate`. Refused with 409 unless the client is dead with the death screen showing, and always refused in a hardcore world. Death rotates the control epoch, so the request must carry an epoch observed after the death.
- `GET /state`: latest tick observation, session, control epoch, phase, action ID, online/canAct flags, coordinates and health. Position is explicitly marked client-predicted.
- `POST /navigate`: integer x,z, unique ID, session, epoch and observation timestamp. Revalidated on the client tick; returns accepted, not success.
- `POST /lease`: refresh the current session/epoch lease for three seconds.
- `POST /stop`: invalidate queued control immediately; release navigation on the next client tick.

Observation is sampled on the client tick only while a request arrived in the last five seconds: at most 10 Hz for `/observe`, 5 Hz for `/frame`, and nothing at all when nobody is looking. Frame capture is an asynchronous GPU readback whose callback lands on a later frame, so a request waits a bounded 1.5 s and otherwise returns the previous frame with its true age rather than blocking the game. A pending readback that never completes is abandoned after three seconds.

Client observation carries the client's blind spots. Entities outside loaded chunks are absent, and mob AI targets are server state that never reaches this client — threat has to be inferred from type, distance and health, not read from an intent flag.

A goal must remain near the destination for ten client ticks before a client-observed success is reported. A fifteen-second movement stall or three-minute action deadline ends navigation as blocked. The service does not automatically repeat a blocked goal. F8/menu/death/session transitions cancel control. A hung game thread cannot process a stop; do not claim a hard real-time guarantee independent of game health.

## Extension order

0. Turn pause-on-lost-focus off (F3+P or `scripts/client-options.py`) before any measurement. It is the difference between measuring navigation and measuring window focus.
1. Complete real-client load and movement tests. Replace the Baritone candidate if it fails; do not work around a broken backend with planner retries.
2. Split controller/policy/observation classes as additional skills are introduced; retain the same session/epoch contract.
3. Screenshots, entity and inventory observation behind the versioned observation interface: **done** (protocol 2, `look` and `frame`). Death detection and respawn: **done** — the first complete observe → decide → verified act loop, on a case where the correct answer is unambiguous. Still to do at this step: a `VlmPlanner` on the existing planner boundary, and a measured decision on local versus remote inference using recorded observations. Keep immediate commands and the heartbeat independent of inference.

### Death handling

Death is the one state the character cannot leave on its own, so it is the one condition the poll loop notices without being asked. On the first tick where the client reports `dead`, the supervisor emits `died` and hands the decision to `Recovery`, exactly once per death.

`Recovery` may only respawn or wait. With `--model` the decision comes from `planner.decideDeath`, constrained by a two-value schema; without a model, or when the model errors or times out, it respawns and records that a fallback happened rather than leaving the character on the death screen. It refuses in hardcore worlds, refuses before the death screen exists, and stops after three respawns in five minutes so a spawn point next to whatever did the killing cannot become an item-grinding loop. `respawn` typed by hand overrides.

Success is the client reporting a live player with a `lastRespawnAt` later than the request; an accepted request that never produces one is reported `unverified`, never succeeded. The interrupted goal is never resumed: after respawn the character is somewhere else with different inventory, and that is a new decision.
4. Add tested eat/retreat skills and threat arbitration. No claim that avoidance settings currently provide dependable survival.
5. Add target-level region permissions, bounded gathering and inventory-delta verification. An 80-block region is not proof of ownership. Keep mining impossible during relocation.
6. Add recipe actions and blueprint sections, then dynamic multi-step goals and memory. Never introduce a second independent loop that writes movement inputs.
7. Add a browser frontend over the same private service and journal; it must not block the client tick or introduce another action authority.

Each new action needs a schema, cancellation behavior, permissions, verifiable success evidence and failure tests. Preserve protocol compatibility or explicitly bump the protocol version.

## Authenticated Realm profile

`runtime/realm-client/` is the isolated game directory for **Windove MVP 26.2** in the normal Minecraft Launcher. `scripts/install-launcher.py` installs the official Fabric version manifest, copies the three required mods and adds a backed-up launcher profile. Authentication remains with the normal launcher; no account token is copied into agent configuration. `./windove` defaults to this instance's bridge token; `--dev` explicitly selects the unauthenticated development instance.

The Gradle development client is for local testing only and cannot authenticate to Realms. The production-style profile corrects this difference. Authenticated Realm login is not claimed as tested merely because this installation was created.

## Focus-loss command handling

Navigation requests wait in the service for up to 60 seconds while Minecraft has a menu open or is paused. Return to gameplay to dispatch the request using a fresh observation. Stop, replacement commands, world changes and control-epoch changes invalidate pending intent. No mod update is required for this service-side behavior. Opening a menu during an already running action still cancels that action; it is not automatically resumed.
