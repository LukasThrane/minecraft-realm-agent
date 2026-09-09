# Windove MVP

## Inventory and recipe tools

Start `./windove`, then use `inventory`, `craftable`, or `can-craft diamond sword`.
These are read-only queries: no Minecraft restart or model is required. They return structured inventory counts, two-operation crafting plans, ingredient alternatives and station requirements. Material feasibility is separate from having a crafting table available; owning the table item does not mean a usable table is open.

The recipe catalog comes from vanilla 26.2. Server datapacks, special recipes and component-dependent outputs are not covered. Preview results are independent alternatives, not simultaneously craftable shopping lists.

Gathering, crafting, station placement and smelting do execute. `craft stone pickaxe` or `get 6 logs` runs the whole dependency chain, replanning from live inventory after every step. `plan <item>` stays a read-only preview. Stations are remembered by position for the life of the world, so walking out of sight of a crafting table does not lose it; `failures` lists skill failures recorded this session and `forget` clears them.

Navigation-only testing agent for the real Minecraft 26.2 client. File/model plan: [MVP.md](MVP.md). Research architecture: [PLAN.md](PLAN.md).

## Play in singleplayer

The simplest way to test. Open the **Minecraft Launcher**, pick **Windove MVP 26.2**, Play, then
**Singleplayer** and create or open a world. Press **F3+P** once inside, then:

```sh
./windove
```

Try `/status`, then `/inventory`, then `craft stone pickaxe`. Everything that follows about the
Realm applies equally here; singleplayer just also has the integrated server as a movement oracle.

## Play on your Realm

1. Open your normal **Minecraft Launcher**, signed into the Microsoft account invited to the Realm.
2. Select **Windove MVP 26.2** (under Installations if needed), then Play.
3. Join the Realm from Minecraft's Realms screen, as you normally would. The agent is idle by default.
4. In Terminal:

```sh
cd /Users/lukasthrane/minecraft-bot
./windove
```

`./windove` is the only entry point. `./windove build` rebuilds and installs the mod, `./windove test` runs the service tests, `./windove options` sets client options. The acceptance gates are console commands, not separate scripts.

**First, press F3+P in Minecraft.** That turns off pause-on-lost-focus. Left on, switching to Terminal opens the game menu, which the bridge reads as a human takeover and cancels whatever is running — that is what ended the first route in the last session. With it off you can type a command and watch the bot go without alt-tabbing back. To make it permanent, quit the client and run `python3 scripts/client-options.py`.

## The console

The console has exactly two kinds of input, told apart by a slash rather than by guessing.

**Bare text is a goal.** It runs until it finishes or you stop it, chaining gathering, crafting,
station placement and smelting, and replanning from live inventory after every step. No model
required.

```text
craft stone pickaxe
get 6 logs
craft 64 planks
craft iron_pickaxe
```

**`/commands` are immediate.** They print, or move the player once, and they are over.

```text
/inventory              # aggregated counts, plus stations we know about
/craftable              # everything makeable in one or two operations
/can-craft diamond sword
/plan iron pickaxe      # read-only dependency preview; never executes
/look [radius]          # nearby entities, inventory, vitals, light
/status  /history  /frame
/go 200 200   /go site
/forward|/back|/left|/right [ticks]
/turn 90   /face <yaw> <pitch>   /jump   /slot 0-8
/break [ticks]   /place   /respawn
/failures               # skill failures recorded this session
/forget                 # clear them, releasing a banned goal
/reflex on|off
/gate1 [trials]   /bench [routes] [distance]
/stop   /quit
```

`stop` and `cancel` work with or without the slash — a safety command must never fail on syntax.
Goal verbs also accept a slash, so `/craft stone pickaxe` and `craft stone pickaxe` are the same
thing. Read-only commands keep working while a goal runs, so you can watch it. `/plan` previews and
never executes; typing a bare `plan ...` is refused rather than quietly interpreted as an order.

Use `/status` first, then a short nearby route. If Minecraft's menu is open, a command waits for up
to 60 seconds: enter it, switch back to Minecraft, and press Esc or Back to Game. It starts only
after gameplay resumes. `stop`, F8, or a world change cancels the queued command.

If the bot dies, the console says so on its own and decides what to do — with `--model` the model chooses respawn or wait, otherwise it respawns, because the death screen is the one place the character cannot leave by itself. It stops after three respawns in five minutes rather than looping, and it never resumes whatever it was doing before it died: you are somewhere else with different inventory, so that is a new instruction. Hardcore worlds are refused.

**Block modification runs in the `build` policy scope.** `break`, `place` and every skill carry it; relocation stays in `travel`, which forbids breaking and placement, so pathing never digs. The client reports `buildScopeAvailable` (true only in singleplayer) but **does not enforce it**: skills gather and place blocks on a Realm, which is what makes `craft stone pickaxe` work there. An earlier version of this file claimed the scope was refused outright off singleplayer. That was never true of the shipped code and is certainly not true now that skills use the scope deliberately. `break` and `place` still act only on whatever is under the crosshair at normal reach — there is no coordinate argument, so nothing can be changed out of view — but skills mine and place under Baritone's control, so treat the work area as genuinely modifiable and keep the agent somewhere you are willing to have terrain changed.

`look` and `frame` are read-only and bypass the supervisor entirely: observing never cancels, extends or starts an action, so you can watch a route without disturbing it. Both report the age of what they returned — a frame that says `STALE` is the previous one, not the current view.

Press **F8 in Minecraft** to cancel navigation and take over. Opening a menu also cancels the current navigation action. `quit` stops the agent and requests a movement stop; it does not quit Minecraft or disconnect your account from the Realm. To leave the Realm, disconnect inside Minecraft.

No proxy is involved. This uses your actual client and account rather than a second bot session. The old ViaProxy/ZenithProxy stack is archived in `legacy/` and must not be running: one account holds one session, so a live proxy session will get your real client kicked.

**The development client launched with `scripts/client.sh` cannot join Realms.** It has a dummy Fabric development identity. The authenticated normal-launcher profile is the Realm route. The bridge/navigation mod loaded in development; authenticated Realm login and real-world route reliability still need verification.

## The charter

`config/charter.md` is the agent's standing purpose: what it is for, its ranked priorities, the
constraints it may not violate, and what to do when nothing else is running. **You write it; the
agent never edits it.** It is loaded on every start and injected into the goal-level system prompt,
so changing what the agent is for is: edit the file, restart.

It matters most in the case that has no other answer — when an objective finishes and none is
pending. The charter's "When there is nothing to do" ladder is what the agent falls back to, which
is why it is a document rather than a config value: it has to be specific enough to pick a next
action from.

Maintenance — eating, fleeing, surfacing — is deliberately *not* in the priorities. Those are
bounded interruptions that borrow the body and hand it back; they are never the objective.

Today the charter reaches the model only in `./windove run` (the autonomous loop, which needs
`--model`). The console's goal execution is deterministic and does not consult it.

## Optional model interpretation

Your installed `qwen2.5:14b` is reused; no additional model download is required. Start Ollama, then:

```sh
./windove console --model
```

The model translates broader wording into navigation/status/stop requests. Unsupported tasks are rejected. It is not yet a visual planner or autonomous survival policy. Exact stop and coordinate commands bypass inference. Do not expect mining, building or fighting in this increment.

## Autonomous runs

```bash
./windove run "walk to 200 200 and stay alive"
```

A goal that persists, and a body that never waits for the model. Deliberation runs concurrently with whatever is already executing: when a decision lands it either confirms the running action — costing no interruption — or replaces it on the next client tick. Measured deliberation latency with `qwen2.5:14b` is 3.5–10 s, which is 70–200 client ticks the character spends moving rather than standing still.

Guards, all of which fire without a model: an identical restatement of the running action is treated as `continue` rather than restarting the pathfinder; a typed failure repeated three times is refused and the planner is told why; malformed decisions are fed back to the next deliberation and six unusable ones in a row stop the run; there is an action budget. Ctrl+C stops cleanly.

## Autonomous runs and `obtain`

`./windove run "<goal>"` needs `--model` and Ollama. The model chooses goal-level actions; it never
touches the control loop. Its most useful verb is `obtain {item,count}`, which hands the whole
dependency chain to the same executor the console uses — so an autonomous run can now gather, craft,
place stations and smelt, which it could not before.

Jobs are started, never awaited: deliberation continues while the chain runs, and a repeated
`obtain` decision is recognised as "keep going" rather than restarting it.

**A run reads stdin**, using the same input language as the console: bare text is a goal, `stop`
needs no slash. Type a new goal at any time to redirect it — the change takes effect at the next
deliberation, and if a job is running it is cancelled and the client released before anything
replaces it. A run whose goal is already met stops on its own rather than idling.

Look-only commands work during a run — `/inventory`, `/plan`, `/look`, `/status`, `/history`,
`/failures`, `/help` — because they read the client and never touch action authority. Commands that
change something are refused; a run owns the body. A single word that is not a recognisable goal is
questioned rather than acted on, so a typo no longer redirects the agent; `/goal <text>` overrides.

While a job is running and making progress the agent stops asking the model what to do, because the
answer is always "keep going" and, at ~11 tok/s locally, that answer is not free. It resumes
thinking when the job ends, stalls, sixty seconds pass, or you type something.

If the safety tier interrupts a job — eating, retreating, surfacing — the job **resumes** rather
than dying, because progress for these jobs is the inventory. Only a takeover or a genuine step
failure abandons it. Repeated interruption is reported as an unsafe working area rather than retried
forever.

## The safety tier

Armed automatically for the length of an autonomous run, and by hand with `reflex on` / `reflex off` in the console. It runs **on the client tick**, so it keeps working while the agent process is deliberating, slow or gone — a deliberation takes seconds and a creeper does not wait.

Priority is manual takeover, then safety, then task. A reflex preempts whatever action is running and that action ends as `cancelled` with `safety_preempted`, so the agent learns why its goal stopped instead of watching it vanish. F8 disarms the whole tier: a person taking over outranks it.

Two reflexes, both deliberately conservative. **Retreat** turns away from the nearest hostile within 5 blocks and sprints off, clearing at 8 blocks so it cannot chatter, capped at 60 ticks. **Eat** consumes food from the hotbar below 6 hunger.

Retreat is not a survival guarantee and should not be mistaken for one. A client-side reflex cannot see the cliff or lava it might be reversing into, and running away from a mob that is faster than you only ever buys time. It exists so a slower layer gets seconds to decide; the real answer is combat, which is deliberately not built until the plan's gate 3 has controlled evidence that it helps.

## Acceptance gates

The plan's critical path is client compatibility → reliable movement → responsive survival → adaptive planning, and work stops on a higher layer if a lower gate fails. Both runnable gates move your character; use a disposable singleplayer world.

Type `gate1` in the console, or `./windove gate1` outside it. Both run on the same supervisor, so a harness never becomes a second agent competing for the control lease.

Gate 1, client and control baseline: each movement direction, a 90 degree turn, a jump, hotbar selection, five trials of stop-releases-inputs against the plan's two-client-tick budget, and a cancellation that has to survive a planner answering four seconds late. Every check is judged on the client's own before/after evidence for that action, never on the request being accepted. Writes `runtime/gate1-<stamp>.md` and exits non-zero if any check fails.

## Measuring navigation

Type `bench 20` in the console, or `./windove bench --trials 20 --distance 120` outside it.

Gate 2, navigation without a model.

Walks 120-block legs in successive directions, cancels every fourth leg mid-route to time the release, and writes a table to `runtime/bench-<stamp>.md` with a JSONL trace beside it. It asks for confirmation before moving your character; `--yes` skips that, Ctrl+C ends it cleanly. Procedure and what it does not cover: [evals/navigation.md](evals/navigation.md). Run it on a disposable world before running it on the Realm.

## Local tests and builds

```sh
./windove test
./windove build
```

The build uses Java 25+ and Gradle 9.7.1 (the installed versions on this machine were checked). Fabric dependencies and game assets are cached under `.cache/gradle`. The Node service uses Node 22+ and no npm dependencies.

For disposable singleplayer tests, either use the same normal-launcher profile or launch the isolated development client:

```sh
./scripts/client.sh
# In another terminal, after the bridge has started:
./windove console --dev
```

Create a new world, close menus and return to gameplay. In singleplayer, use **F3+P** if switching to Terminal pauses the game. Do not open the normal and development modded clients simultaneously: both bind the bridge to port 3009.

After rebuilding, close the game and launcher and run `python3 scripts/install-launcher.py` to copy the new mod into the authenticated profile. It preserves a launcher-profile backup. This machine already has the official Fabric manifest at `.cache/fabric-profile.json`; on a fresh checkout fetch it from `https://meta.fabricmc.net/v2/versions/loader/26.2/0.19.5/profile/json` before installing.

## Evidence and limitations

Private JSONL logs are written to `runtime/events-*.jsonl`. A submitted goal, changed client position and observed arrival are separate events. Coordinates are marked client-predicted, not server-acknowledged. The initial service tests use an injected bridge to verify cancellation and ordering; they do not test Minecraft physics.

The navigation candidate is an unofficial Baritone 26.2 fork pinned by checksum. Its initial load is verified, but terrain trials and the checks in [evals/navigation.md](evals/navigation.md) remain necessary. There is no automatic retry loop for blocked routes. Loss of agent heartbeat cancels movement after three seconds plus client tick scheduling.

The bridge exposes no mining, placement, container or attack action. Navigation settings prohibit breaking and placement. These restrictions apply to bridge-issued navigation; they do not restrict the human player's own inputs or other independently installed mods.
# Dependency-plan previews

Start `./windove` with Minecraft joined. `plan iron pickaxe` and `plan 12 dirt` are read-only previews. `can you create 10 planks`, `craft sticks`, or `create a wooden pickaxe` now execute skills and replan from updated inventory after each step. `inventory`, `craftable`, and `can-craft iron_pickaxe` remain read-only queries. No model download is required.

Install the updated client using `./windove build`, restart Minecraft and rejoin before executing skills. Return to gameplay and close the pause menu after entering the request. `stop`, Ctrl+C and F8 cancel execution. This is a gameplay-testing MVP: gathering searches only local loaded blocks, stations must remain nearby, and furnace processing supports raw iron with coal in an empty furnace. Failed steps stop with a reason; interrupted furnace contents remain in the world. Compilation and service tests do not establish live-game reliability.

If the client bridge is not running on `127.0.0.1:3009`, goal previews automatically fall back to an explicit empty-inventory plan. Commands that need live state (`inventory`, `craftable`, `look`, movement) still require Minecraft and the bridge mod to be active.
