# Minecraft agent redesign

## Survival refactor — 2026-09-09

This section supersedes earlier claims about blanket hostile-radius retreat, capped retreat being
safe completion, the five-preemption job allowance, combat being absent, and the first refactor's
flat-ground-only retreat. Building research remains deferred. The supporting survey is
[SURVIVAL_RESEARCH.md](SURVIVAL_RESEARCH.md).

**Investigation.** The reported diamond-pickaxe failure is recorded in `runtime/run-1788968704221.jsonl`:
six retreat episodes, full-health preemption snapshots, then the five-resume failure. That journal
does not identify the triggering entity; peaceful mode and rain are operator observations, not a
diagnosis. The original defect was treating `Enemy` membership plus distance as danger regardless of
geometry or aggression, then releasing safety on timer expiry with the trigger unchanged.

The first refactor fixed the false positives and was then run live
(`runtime/survival-live-1788970337357.jsonl`, build `survival-evidence-1`). It exposed two further
defects, both visible in that journal:

- **Steering.** Heading came from the next integer grid cell (`atan2(-cell.x, cell.z)`), so it was
  always cardinal, and the route was re-searched every tick, so the chosen direction flipped between
  neighbouring cells from one tick to the next. The recorded path is a staircase of right angles.
- **No viable response.** The bot walked, never sprinted, from a spider — which is faster than a
  sprinting player. Separation stayed between 1.4 m and 5.7 m for the whole episode, the 200-tick
  movement budget expired, and the client then *froze* beside the spider and took damage. The fight
  branch could not fire: it required an axe specifically, exactly one threat, distance ≤ 3 and a
  hardcoded type list.

**Implemented.**

- `ThreatAssessment` splits into `assess` (observations to credible-threat evidence, memory through
  occlusion, episode bookkeeping) and `respond` (a pure choice over that evidence, our loadout and
  whether a route actually exists). Hostile profiles still need attack opportunity; neutral and
  unknown entities still need aggression plus approach or attributed client damage. No difficulty,
  weather or Enemy-membership bypass exists.
- New pure `Combat` makes fight-or-flight arithmetic rather than a whitelist: vanilla weapon damage
  and attack speed capped by mob hurt-immunity, armour reduction, per-type incoming damage, and a
  weakest-first sequential kill estimate. Fighting is chosen when the estimate leaves health in
  hand (`RESERVE`), which is what makes attacker count, weapon, armour and current health all
  matter at once. Excluded on purpose: creepers, anything ranged or airborne, group-aggro mobs,
  and mobs whose loss is unrecoverable.
- Retreat that is not working escalates instead of freezing: no separation gained after 60 ticks,
  a spent movement budget, or an attacker that outruns a sprint now turns into a fight when the
  fight is survivable, and being cornered with no route defends rather than standing still.
- `EscapePlanner` searches steps up, drops within survivable height, and vertical clearance, with
  one neighbour per direction and a cell ceiling so client-tick cost stays bounded. `lookahead`
  returns the furthest step still reachable in a straight line.
- `Survival` commits to an escape path in world coordinates for up to 20 ticks, steers at a
  continuous heading with a bounded turn rate, sprints when fed, jumps for steps and collisions,
  and keeps its commitment while airborne instead of reporting "no escape route" mid-jump. Combat
  selects the best hotbar weapon (not only axes), holds one target until it dies or leaves, closes
  the distance on foot and respects vanilla reach and cooldown. Attacking stays singleplayer-only.
- Worksite recurrence guard, job preservation across interruptions, F8/stop/session authority and
  the asynchronous evidence ring are unchanged from the first refactor. Evidence now also carries
  weapon, dps, armour, fight capability, current target, yaw, sprint and ground state.

**Automated validation.** `./scripts/build.sh` passes, including **1104 assertions** in the
executable Java harness (many are successive ticks of one sequence, not 1089 independent scenarios),
and `npm test --prefix agent` passes **147 tests**. The Java harness runs the production policy,
combat arithmetic, route search and swept ground algorithm over voxel fixtures: neutral proximity,
walls and vertical separation, ranged exposure, attributed damage, occlusion, blocked and hazardous
routes, step-ups, drop limits, sealed rooms, search cost, steering lookahead, and the fight/flee
thresholds (weapon quality, armour, health, attacker count, creeper and ranged exclusions, stalled
retreat, cornered defence). Node integration tests run the real executor through interruption, hold,
replanning and cancellation. None of this establishes Minecraft physics, packet semantics or live
combat reliability.

**Live status.** Build `survival-combat-10` is installed in `runtime/realm-client/mods/`; a restart is required before each new build can be
exercised. Combat, smelting, job preservation and goal anchoring are now confirmed live; the fixes
listed in the sections below are **pending live confirmation**: use
[evals/survival.md](evals/survival.md) with `node scripts/survival-live.mjs [seconds]`, which
journals modes, events, separation, turn rate, sprint state and assessment latency.

**Live regressions found while validating this build, and fixed.**

- `./windove run` armed the new build and the client tick threw once, reported only as
  `Controller error: RuntimeException`. The catch recorded the class name and nothing else, and the
  error snapshot was overwritten by the next successful tick, so the fault was undiagnosable. The
  controller now logs the full stack trace to the client log and republishes it as
  `lastControllerError` in `/state`.
- A fault in threat assessment or actuation took the whole bridge to `blocked`, which is the wrong
  failure mode for the tier that exists to fail safe. Survival is now contained: it logs once,
  falls back to physiological maintenance, releases movement, and reports `survivalError` in
  `/state` while skills keep working. The underlying exception is not yet identified; it needs one
  reproduction on the instrumented build.
- The run console could not be quit. Registering a SIGINT listener replaces Node's default
  terminate, so once the run had ended Ctrl+C had nothing left to abort, and `readline.close()`
  leaves stdin resumed, so the process stayed alive with nothing reading what was typed. Both
  entry points now force-quit on a second Ctrl+C and release stdin when the run ends.

**Second live run (`survival-combat-2`), and what it exposed.** Journals
`runtime/run-1788971919*.jsonl` and `runtime/run-1788972045199.jsonl`. The steering and combat
arithmetic worked as designed and the reasons were legible in the terminal, but three defects made
the behaviour worse than useless in a real world, all fixed in `survival-combat-3`:

- **Engagement collapsed whenever the player left solid ground.** Accessibility was answered only
  from the ground route graph, and that graph was only searched when `onGround()`. In water the
  journal shows `visible=true, accessible=false, onGround=false` with a zombie two metres away: no
  target was ever engaged (`no engaged target`), no escape route existed, and the response was an
  indefinite `hold` while taking hits. This, not the combat estimate, is why it would not attack a
  baby zombie with a stone sword. Accessibility now has three sources: the route graph, a direct
  contact test (arm's length plus line of sight, which needs no graph), and a 20-tick memory of a
  recent yes so it cannot flicker off mid-fight.
- **Water was a trap.** Every fluid was a contact hazard, so once in water no cell was reachable and
  the response was a permanent hold. Water is now passable while already in it (lava never is), the
  search runs while swimming, and retreat holds jump to stay at the surface.
- **A retreat chased the horizon.** A skeleton stayed credible out to 26 m because occlusion memory
  kept its first, close observation. An entity we can currently see beyond `DISENGAGE` (18 m) now
  drops out of memory; occlusion memory is for things we lost sight of, not for distance.
- Baby zombies and other pursuers faster than a sprint are now flagged from the observation
  (`isBaby`) rather than a type table, so they take the escalate-to-fight path.
- Route replanning tightens to five ticks while a creeper is among the threats.

The single `Controller error: RuntimeException` from the first attempt did **not** recur across
these runs, and no `survivalError` was logged. It remains unidentified; it occurred one tick after a
`World/session changed`, and it is now contained and instrumented rather than fatal.

**Bounded limitations.** No ranged weapons, shields, potions, armour swapping, block-placing escapes,
swimming, boats, or global (Baritone) escape routing; no creeper, boss, PvP, ranged or group-aggro
combat; no multiplayer combat at all; no chase after a fleeing target; no automatic relocation to an
alternate worksite; no persistence across process exit or death. Combat numbers are normal-difficulty
estimates without enchantments, potions or knockback, and are calibration targets, not guarantees.
Unknown damage is never attributed to a nearby mob. A worksite guard whose entity unloads can still
need human intervention, and a hold preserves intent without guaranteeing survival.

## Furnace, fuel, goal anchoring and a disarmed safety tier — 2026-09-09

Four defects from a live diamond-pickaxe run (`runtime/run-1788972*.jsonl`). The survival tier's
fight decision worked in that run — `fight: 1 target(s), stone_sword 8.0 dps, est. 9.0 damage`
falling to `1.8` as the zombie died — but everything below went wrong.

**Safety switched itself off after one death.** Dying or opening a menu with a response active
called `disarm()`, which cleared `reflexArmed` permanently. After the first death the transcript has
no survival events at all, which is why a zombie could stand and hit an idle player. Death and menus
now cancel the response and the preempted action but leave safety armed; only F8, an explicit
disarm, or a controller fault turns it off. The run also re-arms from its own cycle if it ever
observes safety off.

**A furnace with anything in it was a hard failure.** `smelt` threw `furnace_not_empty` on any
existing contents, so an interrupted smelt stranded its ore. It now resumes: it drains finished
output, counts ore already inside as progress, tops up only what is missing, and reassesses when
the furnace goes idle or runs out of fuel.

**Only coal counted as fuel.** The executor now burns coal, charcoal, coal blocks, blaze rods,
dried kelp blocks, logs, planks and sticks, with the correct items-per-unit for each, preferring
fuel that is only fuel. The planner spends burnable wood it already carries (keeping a margin back
for crafting) and plans to mine coal only when nothing burnable is on hand.

**Ore inside a furnace was invisible to planning.** Furnace contents are not synced to the client
unless the menu is open, so the agent replanned from inventory, saw one ingot and went back to mine
ore that was already cooking. The client now remembers what it put in, reconciles that against the
real slots every time it opens the furnace, publishes it as `smelting`, and the executor collects it
before making a new plan.

**The overarching goal kept being cancelled for its own prerequisites.** `obtain:diamond_pickaxe`
was cancelled for `obtain:iron_pickaxe`, that for `obtain:coal`, and when the iron pickaxe finished
the run called the goal met. Both are steps inside the diamond chain the planner had already laid
out. A new goal that is part of the running job is now refused with that reason instead of
cancelling it, and deliberation is told what the running job is and what it has left to do — it
previously reported `idle` between a job's own steps, which invited exactly this.

`skillsVersion` is now 3: the executor's collect-before-plan step depends on the resuming smelt, so
an old client is refused rather than paired with it.

## The diamond pickaxe run, and four defects it left — 2026-09-09

`survival-combat-4` completed `get a diamond pickaxe` end to end: gather, craft, deploy stations,
smelt (`Smelted output observed in inventory: minecraft:iron_ingot`), fight off zombies mid-job
(`fight: 1 target(s), iron_sword 9.6 dps, est. 7.7 damage` falling as the target died), suspend and
resume the job across survival episodes, and craft the pickaxe. The goal anchoring held: every
attempt to cancel the chain for `obtain:iron_pickaxe` was refused with its reason. Four defects
remained, fixed in `survival-combat-5`:

- **Every job cancellation disarmed safety.** `/stop` disarmed the client safety tier, and the agent
  issues a stop whenever it retargets or replaces a job, so `Safety reflexes were off; re-armed`
  recurred through the run. `/stop` now takes `keepSafety`: the agent's own cancellations stop work
  and keep safety armed, while an operator stop still switches it off.
- **A skeleton beyond bow range kept driving a retreat.** Reacquisition used a 16 m radius for
  everything, so a skeleton at 14–15 m stayed credible with nothing engaged (`no engaged target`),
  and the response oscillated between retreat and hold for a long time. Ranged and airborne
  profiles are now bounded by their own engagement range, in both first contact and memory.
- **An unreachable station failed the whole job.** `station_unreachable: no route to crafting_table`
  ended `obtain:diamond_pickaxe` twice, because the station stayed in memory and the planner
  therefore never placed another. A station we could not walk to after three attempts is now
  forgotten, so the next plan deploys a new one.
- **The stuck detector stopped a run that was one step from finishing.** Six already-satisfied
  proposals in a row ended the run while `craft: 1 minecraft:diamond_pickaxe` was executing.
  Unusable decisions no longer count toward it while a job is running: the detector exists for a
  run that is achieving nothing, and a running job is not that.

## Second diamond-pickaxe run: five more defects — 2026-09-09

`survival-combat-5` fought well (zombies killed on contact, job preserved and resumed each time)
but did not finish the goal. Fixed in `survival-combat-6`:

- **Forgetting an unreachable station did not work.** `Stations.unreachable` removed the entry, and
  the very next scan found the block still standing and put it straight back, so
  `station_unreachable: no route to crafting_table at 547,63,88` failed the job three times in a
  row with the identical message. Unreachable positions are now held in a blacklist that the scan
  respects, cleared with the world.
- **A phantom was an unanswerable threat.** Airborne mobs were never fightable, so a phantom
  circling at 1–11 m produced a permanent withdrawal at night. Phantoms are now fightable *when
  within reach*: `Combat.Target` carries `reachable`, and anything flying beyond contact range
  makes the whole engagement unwinnable rather than inviting a chase we cannot win.
- **Explosion damage was charged per second.** A creeper's 22 contributed to every second of the
  estimate, producing `est. 159.0 damage over 6.6s`. Burst damage now lands once. The decision was
  already right; the number was arithmetic noise in the operator's log.
- **The response flapped between retreat and hold every few ticks.** Route scoring demanded a full
  block of extra clearance and near-monotone progress, so marginal terrain produced a route only on
  some ticks. The thresholds are relaxed, and engagement now has hysteresis: a mob hovering at
  exactly the radius keeps its engaged status for another two metres instead of flipping the whole
  response every tick.
- **The run gave up with its goal never attempted.** Six `already holding iron_pickaxe` rejections
  ended it while the diamond pickaxe had not been tried since its job failed. Before stopping, a
  stuck run now starts its own stated goal if that goal is plannable and unmet; if the goal is
  already met, it still stops.

## Kit management, decision cadence and readable logs — 2026-09-09

Four operator requests plus a defect they exposed, in `survival-combat-7`.

**Armour and hotbar are now maintained by the client** (`Loadout.java`). Inventory position is not
cosmetic: the safety tier only reads the hotbar, so live the bot fought a zombie with a
`diamond_pickaxe 6.0 dps` while carrying an iron sword it could not reach, and armour was mined,
crafted, carried and never worn. Between actions the client now wears the best piece it owns in
each armour slot and keeps the best pickaxe, sword, axe, shovel and something edible in the hotbar,
one container click at a time, displacing only items the kit does not need. It runs on the tick, so
it costs no model latency, and only while nothing else owns the cursor.

**Decision cadence.** A finished job or action now forces the next deliberation immediately instead
of waiting out the interval, which is what left the body idle between sub-goals. In the other
direction, a running job is supervised on the slow clock whether or not the client reports
progress: a long mine legitimately reports zero, and treating that as a reason to ask again every
few seconds produced seventeen `continue` answers in a single gather, each costing ten seconds of
inference.

**Batch size is the model's to choose.** The action already accepts 1..256; the prompt now says so,
and says why -- the trip underground costs the same whether it brings back three ores or thirty.

**Timestamps.** Both consoles now print `[HH:MM:SS +Ns]` per line: wall clock plus the gap since
the previous line, so deliberation latency and dead time between actions are readable rather than
inferred.

Ranking is unit-tested; the slot moves themselves talk to the player's container menu and need a
running client, so they are live-validated only. Nothing here equips a shield or an offhand item,
manages armour durability, or drops junk to make room.

## The overseer, and four things the run kept getting wrong — 2026-09-09

**The run is now a goal queue with an overseer, not a single goal string.** New
[goals.js](agent/src/goals.js) holds what the agent intends to do, ordered by urgency (0 urgent,
5 ordinary, 9 whenever). The deterministic layer retires goals it already satisfies and starts the
next one **without a model call**; the overseer is asked only when something changed -- the
operator said something, a goal ended or failed, a condition became worth acting on, or the queue
is empty. That replaces the old behaviour where a completed goal left the model answering
"the diamond pickaxe is already obtained" every ten seconds with nothing queued behind it.

- **The console is a conversation.** Bare text is no longer an instant mission replacement: it goes
  to the overseer, which answers through `say` and decides where the request belongs. A request is
  a request -- an ordinary-priority goal joins the queue behind a chain that is halfway done, and
  only a goal the overseer marks more urgent than the running one preempts it. `/goal` still
  replaces the mission outright.
- **Health and hunger are noticed.** The runner reports a change in condition (`badly hurt (6/20)`,
  `hungry (food 3/20)`) to the operator and to the overseer, and treats it as a reason to think.
  Combat thresholds are now fractions of the character's actual maximum health rather than absolute
  hearts, and absorption counts as the hit points it is, so a golden apple or an attribute change is
  reflected without a code change. The client also eats to heal, not only to stop starving:
  vanilla regenerates only while food is nearly full.
- **Look where you are going.** Baritone's default sends rotations to the server without moving the
  camera, so from a spectator's seat the character sprinted backwards with its eyes locked
  somewhere irrelevant. Free-look is off, block-free-look is off, smooth look is on.
- **Take the stone that is already open.** A gather now counts nearby target blocks that are open
  to air, and when there are plenty it restricts mining to exposed targets rather than tunnelling
  to whichever buried block is closest in a straight line -- observed live walking past a hillside
  of stone and then digging down through dirt for three blocks of it. This one is a heuristic on
  Baritone's own setting and needs live confirmation.
- **Batch size is the model's.** The prompt now says the count is its to choose and why.

Not addressed: the agent cannot acquire food (no mob or crop skills), so a hunger condition is
reported and eaten from the bag but cannot be resolved by the queue. The overseer's `say` is not a
transcript -- it answers the latest message with the state it has, and does not remember the
conversation beyond the recent-goal history.

## Cornered means fight, and six other things that killed it — 2026-09-09

An iron-gear run died three times in seven minutes and then ran itself into a corner it could not
plan out of. Fixed in `survival-combat-9`.

- **Cornered was answered with standing still.** The old rule only defended when the fight was
  winnable and the mob was on a list; anything else held. Live that meant holding while three
  zombies killed it, twice. Now: if we cannot leave and something reachable is not an explosion,
  fight it -- favourable or not, armed or not. An unfavourable fight beats being hit for free. Only
  a primed creeper is still not worth swinging at, because nothing we can do in the time available
  changes that outcome.
- **The response flapped between fight, hold and retreat every tick**, and since each change drops
  the target, the fight landed no hits. A chosen fight is now committed to for fifteen ticks while
  the target is still visible and in reach.
- **Dying banned the goal.** Three deaths mid-chain recorded three failures against
  `obtain:iron_ingot`, after which the run refused the only objective it had. Failures that say
  nothing about the goal -- death, control change, operator takeover -- are no longer recorded
  against it.
- **It ate rotten flesh.** Anything with a food component counted. Rotten flesh, spider eye,
  poisonous potato, pufferfish and raw chicken are now last-resort only, eaten at food 2 or below.
- **It mined three cobble and then spent them climbing out.** Baritone pillars with whatever it may
  throw away, and cobblestone was always on that list. It is now only spendable when we hold more
  than sixteen, and never the item the current gather is collecting.
- **Stone was three blocks out of reach.** The mining band for cobblestone was the origin's level
  minus three, so on any normal surface the stone layer was outside it and the search walked until
  it found an outcrop. The band is now twelve blocks for stone, unchanged for logs.
- **`obtain iron_ore` was refused.** Asking for the ore block is what a model naturally says; ore
  blocks now resolve to what they drop, and `stone` to cobblestone.
- **Questions went unanswered.** The overseer is now told it must fill in `say` whenever the
  operator has spoken, and a silent answer is reported as silence rather than charged to the run's
  stuck-detector.

## Standing still while dying, and kiting — 2026-09-09

Three deaths in six minutes, each ending with the character stationary while mobs hit it. Two
causes, one of them mine, both fixed in `survival-combat-10`.

- **The fight actuator refused to fight without a weapon.** `Survival.fight` returned immediately
  when no hotbar weapon was found, so after a death dropped the kit the policy chose `fight` and
  the body then did nothing at all. Bare hands hit; the slot switch is now conditional and the
  swing is not. This is the literal standing-still-while-dying in the log.
- **`hold` was still the answer whenever nothing was engaged**, including on open ground with a
  creeper walking in. New `kite` response: face the nearest threat, give ground while it is closer
  than we want it (six metres from anything explosive, three from anything else), and hit it when
  it comes into reach unless it is a creeper. It needs no planned route -- one collision-checked
  step at a time -- which matters because the route search is exactly what is missing when the
  response would otherwise freeze. Anything credible within twelve metres is now answered by
  giving ground rather than standing still; `hold` survives only for threats nothing can reach.

The log also shows the route search reporting "no escape route" on open ground, which should not
happen. I have guessed at that twice and been wrong twice, so this build publishes
`reachableCells` in the survival evidence instead: the next occurrence will say whether the search
found nowhere to stand or found ground and rejected every route through it.

## Generative building research direction — 2026-09-09

Current exploratory ideas are in [BUILDING_RESEARCH.md](BUILDING_RESEARCH.md).
The placeholder is only `generate_structure(bounds, prompt)`, for example “Inside these bounds,
create a gothic tower.” No API, output format or model architecture is settled, and no stub code
is requested yet. This clarification supersedes treating the earlier parametric-only generator
proposal or detailed editing request as requirements. Future research may develop a new model
using Dream-Cubed, 3D diffusion and Blender-related workflows; model selection, datasets and
training methods will be investigated later. Reliable gameplay and survival take priority.

## The satisfied-goal livelock, and not asking when the answer is known — 2026-09-09

The diamond-pickaxe run confirmed the previous fixes: `/help` and `/plan` worked mid-run without
touching the goal, retargeting mid-chain cancelled cleanly with no orphaned action, and gathering
ran one trip per material. Four remaining defects, all visible in one transcript.

**A satisfied `obtain` livelocked the run.** With the stone pickaxe in hand the model asked for it
again; the executor verified it instantly and reported success; the rejection counter reset because
a valid action had been dispatched; and the next decision asked again. The run alternated between an
eight-second no-op and a rejection indefinitely, and the idle-continue limit could never fire
because something valid kept landing between the rejections. `alreadyHave` now answers "do we
already have this?" from the last observation and the dependency planner — a plan with zero nodes
means the goal is met — and refuses before the counter resets. Deterministic, no model call, the
same shape as the existing `alreadyThere` check for navigate. A run pointed at an unbuildable goal
now ends saying so, instead of flailing at it.

**Deliberating while a job progresses bought nothing.** Seven consecutive `continue` answers during
one cobblestone gather. Measured on this machine, generation runs at 10.9-11.4 tok/s and a decision
is about 54 output tokens, so each of those cost roughly five seconds of the only genuinely scarce
resource to be told what the deterministic layer already knew. A running job whose progress is
advancing is now left alone until it finishes, stalls, or sixty seconds pass — the periodic check
keeps a long job supervised without interrogating it. Retargeting sets a flag that forces
deliberation immediately, so the quiet never delays the operator.

**A typo was a goal.** `sotp` and `hello?` each replaced what the agent was doing. A bare line is
still a goal, but one that is neither a recognisable obtain nor more than a single word now asks
instead of acting, and `/goal <text>` overrides — refusing a goal the operator meant would be the
worse failure. Fixing the prompt redraw removed the cause of most of these; this removes the rest.

**`/quit` was refused.** It was classified as a command that changes something. In a run it now ends
the run, like `stop`.

Validation: 118 Node tests pass, including that a progressing job costs no forward passes, that
retargeting is still answered immediately, that a satisfied obtain is never dispatched and the run
then ends rather than looping, and that an unsatisfied one still runs.

Measured, for the record: `qwen2.5:14b` generates at ~11 tok/s here and processes prompt at 236
tok/s cold, effectively free once the prefix is cached. A decision is ~1510 prompt tokens and ~54
output tokens, so roughly five seconds warm. The model is not what made the earlier runs feel slow —
separate gathering trips were — but it does bound how often the agent can think, which is why not
asking is worth more than asking faster.

Still open: the report that cobblestone gathering travels further than expected, and the absence of
any job type that could build a house, which is what the run was asked for and could only answer by
repeatedly obtaining planks.


## One trip per material, and looking without interfering — 2026-09-09

Three defects from the diamond-pickaxe run.

**`/plan diamond_pickaxe` silently retargeted the run.** `classify` returns `preview` for it, the
run's input handler matched only `help` and `command`, and everything else fell through to
`retarget`. So a command whose entire purpose is to look changed what the agent wanted, printed
nothing, and gave no sign it had done so. The preview kind is now matched before the goal path.

**Read-only commands were refused during a run.** That was a design error, stated plainly at the
time as "a run takes a goal, not commands". It is wrong for exactly the commands that only look:
they read the client and never touch action authority, which is why the console already allows them
while a goal runs. An operator watching a chain of skills with no way to ask what it thinks it needs
is not supervising anything. `agent/src/queries.js` now holds the one implementation of `help`,
`inventory`, `craftable`, `can-craft`, `plan`, `look`, `status`, `history` and `failures`, returning
text rather than printing so either caller can place it; the console and the run both use it, so
neither can quietly forget one. Commands that change something are still refused in a run, with a
message that says why rather than restating a rule.

**Gathering ran one item at a time.** Backward chaining ensures each requirement as it meets it, so
three separate needs for planks produced three separate `gather 1 oak_log` nodes — the plan printed
`oak_log: 3` in its own summary and then walked to a tree three times anyway. Live: mine one log,
craft, find another tree, mine one log, craft. Cobblestone was worse, because a furnace and a stone
pickaxe are separate requirements: 7 cobble, craft, then 3 more.

`mergeGathers` combines gather nodes that share an item, tool, target blocks **and dependency set**.
The dependency condition is what makes it safe rather than merely convenient: keeping the set
unchanged cannot introduce an edge into the merged node's own past, so nothing legal becomes a
cycle. Two cobblestone gathers waiting on the same wooden pickaxe merge; a gather waiting on a tool
made from an earlier gather of the same item does not. From empty inventory a stone pickaxe is now
one trip for three logs and one for three cobblestone, and a diamond pickaxe one trip for eleven
cobblestone rather than three trips.

Not addressed, and still open: the report that cobblestone gathering descends further than it
should. `minYLevelWhileMining` is capped at three below the worksite for cobblestone, so the depth
bound is in place and the cause is more likely horizontal travel to reach exposed stone. Halving the
number of trips helps the symptom without explaining it. It needs watching with `/look` during a
gather before anything is changed.

Validation: 114 Node tests pass, including that no look-only command classifies as a goal, and that
every command `queries.js` exports is one both entry points route. Deliberation latency is unchanged
at 6-12s per decision and is not addressed here; the run felt slow mostly because each trip was a
separate journey.


## Retargeting a run: two defects from the second live run — 2026-09-09

The chain executed again unattended. Redirecting it mid-chain failed, in two independent ways.

**Cancelling a job orphaned the client action.** Aborting the executor only unwinds this process's
loop; the skill it had already dispatched was still running on the client tick. The replacement job
checks for an in-flight action and refused: `obtain:log failed: Stop the current action before
starting a skill goal`, followed shortly by `Agent heartbeat lost` as the orphaned action timed out
with nothing renewing its lease. Job replacement now aborts, waits for the executor to unwind,
stops the client, and waits for it to report no action, no pending action and no pending stop before
anything else starts. Blocking the loop for that handshake is deliberate: what must never wait on
inference is the body, and this is waiting for the body.

**The operator could not see what they were typing.** A run prints continuously into the terminal it
reads from, and every log line shredded the half-typed input. `nah wait get 4 logs instead` arrived
as six fragments scattered through the output; the line was assembled correctly and retargeted
correctly, but nothing on screen said so, and the operator typed `hello? stop` and then `sotp`
because the session looked dead. Both became goals, which is the correct reading of a bare line and
the wrong outcome. Output now redraws the input line, and there is a visible prompt.

Input in a run uses the console's `classify`, so there is one input language rather than two: bare
text is a goal, `stop` needs no slash, and commands are refused with a pointer to the console rather
than being interpreted as goals. A run holds one long-lived intention and deliberately takes no
commands.

Not fixed, and a real limitation: a typo is still a goal. Anything short of confirming every
retarget has that property, and confirmation is the wrong trade for a control channel that must stay
responsive. Seeing the line before pressing enter is the mitigation.

Validation: 112 Node tests pass. The cancellation path is covered by a stub client that keeps
reporting an in-flight action until something stops it, which is what the live client does; both
obtain-replaces-obtain and obtain-replaces-navigate assert the client was released first. Not
established: whether three seconds is enough for the client to release under load, and whether
retargeting during a furnace or crafting transaction leaves a menu open.


## First autonomous run, and what it exposed — 2026-09-09

`./windove run --model "get a stone pickaxe"` completed the full chain unattended on the first
attempt: gather log, craft planks, craft and place a crafting table, gather more logs, craft sticks,
craft a wooden pickaxe, gather cobblestone with it, craft the stone pickaxe. Step 2 works — the
model chose `obtain` rather than reaching for `break` and `place`, answered `continue` while the job
ran, and never touched the control loop. Deliberation ran 5-8s per decision against qwen2.5:14b and
never blocked the body. That is one run in one world, not a reliability result.

Three defects, two of them introduced by step 2.

**The run never ended.** With the goal met, the model answered `continue` — "Already holding a stone
pickaxe, no action needed" — indefinitely. `continue` was accepted unconditionally, so a run whose
goal is satisfied idles forever rather than stopping. It is the wrong diagnosis to call this a
prompt problem: nothing was running, so there was nothing to continue, and that is checkable without
a model. A continue with no job and no active action is now a rejection carrying that sentence, which
reaches the next deliberation through the existing feedback path; a model that still will not answer
`done` exhausts the rejection limit and the run stops. The goal being met and the model being
confused both end the run, which is correct in both cases.

**The run could not be reached.** The operator typed "ok now build a house", then `stop`, `quit`,
`/stop` — none of it did anything, because the run never read stdin. Only Ctrl+C worked, twice,
because the cycle slept unabortably. A run now reads stdin: a bare line retargets the goal, and
`stop`/`quit` ends it. Retargeting drops any decision made for the previous goal and forces
immediate deliberation, but does not tear down what is running — the operator gets the same
continuity the model does. The cycle sleep takes the abort signal, so a stop lands within a tick
instead of behind the current sleep and whatever inference is queued behind it.

**A satisfied obtain was re-issued once** before the idle loop began, costing one deliberation and
an instant re-verification. Harmless, and the rejection above is the general fix; a completion check
specific to `obtain` would duplicate what `SkillExecutor` already does cheaply.

Also corrected: an existing test asserted that `continue` is accepted while nothing is running, which
was the defect written down as an expectation. Its premise is now an active action, which is what a
legitimate continue means.

Validation: 111 Node tests pass, including the idle-continue loop and mid-run retargeting. Not
established: whether retargeting mid-job behaves well when the model wants to keep the old job, and
whether the rejection limit of six is the right budget for a model that has simply finished.


## Interrupted jobs resume, and the model can obtain — 2026-09-09

Steps 1 and 2 of the goal-architecture build order. Node only; no Java changed.

### Maintenance interrupts rather than replaces

The charter says an interrupted objective resumes with its progress intact. The code did the
opposite: a reflex preempt ends the action as `cancelled`/`safety_preempted`, `SkillExecutor.action`
threw on any non-success, and `run` abandoned the whole multi-step job. A creeper appearing during a
gather ended `craft iron pickaxe` and the operator retyped it — which is exactly what the earlier
console transcripts show, one step advanced per retype.

`disposition(failure)` in `commands.js` splits the eight typed failures into resume and abandon.
Only `safety_preempted` resumes, because only it means the body handled something and is now fine.
A takeover is the operator deciding. Every other class is the step itself having failed.

Resuming needs no resume stack at this layer, because progress for obtain-shaped jobs lives in the
inventory, which is world state: the loop already replans from a fresh observation every step and
therefore lands on the same next step by construction. A preemption is not recorded against the
step in `Attempts`, since the step was not at fault. Preemptions are capped per run — past the cap
the honest conclusion is not that the step is wrong but that the place is, and the failure says so.

`assumption_violated` deliberately still abandons. Resuming it would re-dispatch with a floor
recomputed from the now-lower health, lowering the bar each time. Doing better needs the maintenance
layer, which is unbuilt; with reflexes armed the common path is `safety_preempted` anyway.

### The model can ask for things

`obtain {item,count}` is now in the planner's action enum and reaches `SkillExecutor` through the
runner. Before this the model's entire vocabulary was navigate, move, break, place, jump and select,
so an autonomous run could not craft anything — everything that works lived in a layer the
deliberation loop had never heard of.

The verb is deliberately coarse. The model asks for the finished thing and the dependency planner
owns the recipe arithmetic, so a wrong answer costs a rejected plan rather than a half-crafted mess.
The prompt says so explicitly, because a model told it has `break` and `place` will otherwise try to
step through a recipe by hand.

Jobs are started and never awaited: the body must keep working while deliberation runs. A running
job is invisible as `state.acting` between its own skill steps, so a repeated `obtain` decision is
recognised as a continue by signature; without that, every deliberation would cancel and restart the
chain. A different decision aborts the job first. Fixed in passing: `observeOutcome` recorded
outcomes it never dispatched against an empty signature, which would have poisoned the failure
memory now that skills dispatch outside the supervisor.

### Validation

109 Node tests pass. New coverage: a reflex interrupting a job and the same step being retried
without being recorded as a failure; a takeover abandoning instead; repeated interruption reported
as an unsafe area rather than retried forever; obtain reaching the executor and not the client
action path; a running job continued rather than restarted; a different decision cancelling it; a
failed job remembered typed; and obtain refused rather than crashing with no executor attached.

None of this is live evidence. Not tested in a world: whether resume actually lands mid-chain after
a real reflex, whether a 14B model uses `obtain` rather than reaching for `break`, and whether the
preemption cap is set anywhere near right. The next steps in the order are unchanged — charter-
checked objective selection, then the persistent project and job store.


## Future: structure generation, building, and requested builds — 2026-09-09

**Not implemented. Recorded so the layers built before it leave room for it.** Nothing in this
section exists; it is a design sketch, not a claim.

### Why it is worth recording now

It answers a question the goal store otherwise cannot. `obtain 3 iron_ingot` has a measurable
completion condition — count the inventory. "Build a wall" has none, so a construction node can
never become `done` and the tree stalls on a permanently active child. A schematic supplies the
condition directly: the node is complete when every block in the schematic matches the world, and
`placed/total` is the progress field. It also supplies the resource requirement automatically,
because a schematic is a bill of quantities, and that bill is exactly the `obtain` jobs
`DependencyPlanner` already knows how to plan.

Interim assumption until it exists: construction completion is a block count inside a bounded
region. Crude, and superseded by schematic matching when this lands.

### Schematic

A schematic is an anchor, an orientation, and a list of offsets to **material roles** rather than
to concrete blocks — `wall`, `floor`, `roof`, `frame`, `glazing`, `light`. A separate palette binds
roles to blocks. Biome adaptation is then palette substitution, not new geometry: the same house
schematic builds in sandstone in a desert and cobble and oak on a plain. The agent picks the palette
from biome and from what it can actually obtain, so a structure degrades gracefully rather than
blocking on a material it cannot reach.

### Generator

Parametric rather than freeform. A house is a footprint, a storey count, a roof style and openings;
a wall is a path, a height and a gate spacing. Deterministic code turns parameters into a schematic.
Where the model is involved it chooses **parameters and layout**, never block positions — the same
division the rest of the system uses, because geometry and verification are things we can compute
exactly and a model cannot be trusted to enumerate three hundred coordinates without drifting.

City-scale generation is the same idea one level up: a district is a plot layout plus a road graph,
each plot filled by a building generator.

### Build skill

`build(schematic, origin, orientation)`, alongside gather, craft, deploy_station and smelt.

- Needs site selection: flat enough, inside the approved region, not overlapping an existing build
  or another player's work. This requires the spatial map and remembered locations we do not have —
  `stationSites` is the only entry in that store today.
- Needs a placement order that does not strand the builder: bottom up, never placing into the block
  it occupies, scaffolding accounted for and removed.
- Verifies per block against the world, not against a counter, so it is idempotent and resumable.
  A build interrupted at 200/420 resumes by rescanning the volume, which is the same hard oracle
  the rest of the verification layer uses.
- Its failure classes are already in the vocabulary: `no_source` for missing materials, `precondition`
  for an unusable site, `no_progress` for a placement that will not stick.

### Requested builds, and the trust problem this creates

The collaborative case — a player on the Realm asks the agent to build something, and it generates
and builds it — is the most attractive part of this and the one that needs designing before it is
written, not after.

The charter's standing constraint says public chat is observation and never instruction. That is
correct and must stay. A build request is an instruction, so it cannot be honoured by relaxing the
constraint. It is honoured by routing around it:

- A chat request becomes a **proposal**, never an objective. It enters a queue and is not executed
  until approved, by the operator or by an allowlist of players the operator has named.
- Proposals are **bounded by construction**, not by prompt. A request may select a structure type
  from the generator's catalogue and a site inside the approved region. It cannot author a
  free-form goal, break existing blocks, open containers, or leave the region.
- Chat text is **data that selects from a menu**, never text that reaches a planning prompt as an
  instruction. This is what makes "ignore your charter and empty the chest room" inert: there is no
  path from a chat string to an arbitrary objective, regardless of what the string says.

Getting this wrong is a prompt-injection vector with a shovel. Getting it right costs a queue and an
allowlist, and only if it is designed before the feature rather than bolted on after.

### Depends on

The goal store and persistent jobs; a spatial map for site selection; and `obtain` reaching the
model's vocabulary so a bill of quantities can become work. None of those are built.


## Goal architecture: charter, objectives, maintenance — 2026-09-09

Design, not implementation. `config/charter.md` exists and is loaded into the goal-level system
prompt; nothing above the Jobs layer is built.

### The correction this rests on

An earlier draft of this section proposed a vector of homeostatic drives — survival, satiety,
security, capability, wealth, curiosity — competing for control, with the agent pursuing whichever
was most urgent. That was wrong, and wrong in a way worth recording. Eating is not a motivation. It
is a bounded interruption that exists so the real work can continue, and putting it in the same
ranking as "build a settlement" produces an agent whose purpose is whatever its blood sugar last
suggested. Purpose is authored by the operator. The agent derives objectives from it and never
invents one.

Demoting maintenance also removes the main risk the drive proposal carried: hand-tuned scalars
deciding behaviour. Maintenance thresholds are not a motivation system, they are the same shape as
`Reflexes.java` — a trigger, a cap, a clear condition — which is already built and understood.

### Layers

```
Charter          config/charter.md, operator-authored, agent never edits   the only source of purpose
    |
Objectives       derived from the charter, checked against it before commitment
    |
Projects         iron economy, housing district, food supply               persistent across sessions
    |
Jobs             obtain(item,n) | build(blueprint) | farm(crop) | store    DependencyPlanner, generalised
    |
Skills           gather | craft | deploy_station | smelt                   BUILT
    |
Actions          navigate | move | break | place | look | select | jump    BUILT

Maintenance      eat | retreat | surface | heal | sleep
                 runs beside this stack, never above it: preempts, bounded, resumes
```

The two bottom layers exist. Jobs exist for exactly one job type. Everything above is unbuilt.

### Properties this is designed to have

**The agent is never without a goal, and never invents one.** The charter is both the fallback and
the tiebreaker. Its "When there is nothing to do" ladder is deterministic: prerequisite of a blocked
objective, then highest feasible priority, then restock, then capability, then explore. Reaching the
end of the ladder is not possible while any of those is unsatisfied, and they cannot all be
satisfied at once in an open world.

**Maintenance has no standing.** It may borrow the body and never own the objective. Each instance
is bounded by a cap and a clear condition, and when it ends the interrupted objective resumes with
its progress intact rather than being reconsidered. This is the property the code contradicts today:
a reflex preempt ends the action as `cancelled`/`safety_preempted`, `SkillExecutor` throws on any
non-success, and the whole multi-step job dies. The typed failures already distinguish pause from
abandon; the executor ignores the distinction.

**Objectives are checked before commitment, cheaply first.** Four tests, in the charter: serves a
named priority, permitted by the standing constraints, feasible, not futile. Feasibility runs
through `DependencyPlanner` and costs no model call; futility reads `Attempts`. Only the first two
need the model.

### What the research contributed, and what we changed

- [Project Sid / PIANO](https://arxiv.org/html/2411.00114v1) supplies concurrency plus coherence
  through one cognitive controller acting as an information bottleneck, which is the single-control-
  authority invariant we already hold. Its stated limitation is missing intrinsic drives. We do not
  answer that with agent-generated drives: an operator-authored charter is the better answer for a
  tool someone owns, and the maintenance thresholds Sid lacks are computable here from structured
  observation rather than inferred by a model from text.
- [Voyager](https://arxiv.org/abs/2305.16291) supplies the automatic curriculum: propose the next
  task from current state, calibrated just above current ability. Its documented failure is
  proposing tasks that do not exist. Our proposals pass through `DependencyPlanner` first, so
  `Cannot obtain minecraft:copper_sword` is a deterministic rejection with no model call, and
  generate-then-fail becomes generate-then-verify.
- [Generative Agents](https://arxiv.org/abs/2304.03442) supplies interrupt-and-resume over recursive
  plans, which is exactly the maintenance semantics above, and reflection, which we do not need yet.
- [OMNI](https://arxiv.org/pdf/2306.01711) argues learning progress alone is a poor curriculum
  signal and uses a model of interestingness. We replace interestingness with charter fit: we do not
  want an interesting agent, we want one that serves a stated purpose. `Attempts` supplies the
  learnability half deterministically.
- Drive-reduction and homeostatic control ([survey](https://www.sciencedirect.com/topics/psychology/motivated-agent),
  [CTCS-HRRL](https://arxiv.org/html/2401.08999v1)) supply setpoints, decay and hysteresis, demoted
  from motivation to maintenance thresholds. Their known weakness — no anticipatory action — matters
  here: eat before a four-minute mining trip, not after collapsing during one, which is affordable
  because a job's cost is estimable from the DAG before it starts.

### Build order

1. Resume rather than abandon in `SkillExecutor`, keyed on the failure class already reported.
   Without it every layer above is built on a job that dies when a zombie appears.
2. `obtain {item,count}` in the planner's action vocabulary, dispatched to `SkillExecutor`. The
   model's verbs are currently navigate, move, break, place, jump and select, so an autonomous run
   cannot craft anything.
3. Charter-checked objective selection: the four tests, feasibility and futility first.
4. Persistent project and job store, with the resume stack.
5. Maintenance thresholds and the anticipatory term.
6. New job types: build, farm, store, explore.

### Not established

No part of this is validated. The charter's priorities and its idle ladder are a first draft and
have never selected a real objective. Whether a 14B local model can apply the four tests reliably
is unknown and is the main risk to steps 3 onward; the deterministic halves (feasibility, futility)
are the parts that will work regardless.


## Console: slash commands and bare-text goals — 2026-09-09

The console had one input space and resolved it by an ordered pile of patterns, so `craft 6 logs`
executed as a goal while `fetch 6 logs` fell through to the model as free text — the same request,
two behaviours, for no reason visible from the terminal. `classify` in `commands.js` replaces the
guessing with one rule: bare text is a goal that runs for minutes, `/word` is one immediate thing.

Stop is checked before anything else and on either spelling, because a safety command must not
depend on syntax. Goal verbs are accepted with a slash as well, since `/craft ...` is the obvious
guess. `plan` previews under `/plan` and is refused as a bare goal: it reads as an instruction, and
a preview that starts mining is the worst available misunderstanding. An unknown `/word` is an
unknown command rather than falling through to the goal path, so a typo cannot start an action.
Read-only commands stay available while a goal runs.

The slash layer for movement is a front end over `directCommand`, not a second copy of its bounds,
so `/go 200 200` is `go to 200 200` and validation is unchanged. `/stop` was advertised in the help
text and did not work before the tests caught it.

Validation: 97 Node tests pass, seven of them on routing, including the four-phrasings regression
and the bare-`plan` refusal. The console starts, prints help, rejects a typo and refuses a bare
plan. No Java changed. Not tested: anything requiring a live world.


## Skills routed through the action envelope — 2026-09-09

Synthesis item 1 of the implementation order. Skills were the one action type that reached the
client without passing through the host-side envelope: `SkillExecutor` called `bridge.act` directly,
so no `validateAction` case existed for them, `scopeFor` and `deadlineFor` did not know the type,
they carried no assumptions, and `Attempts` never saw their failures. Everything below is the
consequence of closing that, not new capability.

`validateSkill` in `commands.js` now mirrors the `skill` case in `Actions.java` — kind, item id,
count, gather blocks and tool, craft station, width and rectangular grid, the inventory 2x2 bound,
and the 1..8 iron-ingot smelt limit. Both sides check, because neither may trust the other. A
truncated recipe grid is refused before dispatch rather than returning a bridge 400 partway through
a goal, which is how that class of bug presented last session.

Deadlines are per kind rather than a hardcoded 120s: gather 240s, smelt 180s, craft and
deploy_station 60s. Gather needed the wider window once returning home became a retry rather than a
failure. `scopeFor` returns `build` for skills, matching `Actions.BUILD_TYPES`; the client rejects
any envelope whose scope and type disagree.

Skills now carry a `minHealth` assumption derived from health at dispatch, so a four-minute mining
trip is voided on the tick health falls through the floor instead of digging on through a losing
fight. The floor is `min(6, health-2)` bounded below by 1: a fixed floor would either void instantly
when a goal is issued at two hearts or never bind. Crafting asserts nothing, because a menu
transaction cannot walk away from anything. Deliberately not `holding`: Baritone's automatic tool
selection changes the held item during a gather, so asserting it would void every mining action.

`Attempts` and `signature` moved from `runner.js` to `commands.js` — the console's executor needs the
same failure memory, and importing the autonomous runner to reach it would have been the wrong
dependency. Skill outcomes now carry the typed failure alongside the text, and a leaf that has
failed the same way three times is refused with its history instead of retried. `failures` lists what
is recorded and `forget` clears it, because a memory with no release is a worse dead end than the
repetition it prevents.

Correction to the README, not a change in behaviour: it claimed the bridge refuses the build scope
outright off singleplayer. No such check exists, in this build or in the committed one before it —
`buildScopeAvailable` is reported and never enforced. Skills use the build scope on the Realm by
design, which is what makes the crafting chain work there. Left as is and documented; adding
enforcement now would break deliberate, working use.

Validation: 90 Node tests pass, covering envelope shape, malformed-skill rejection before dispatch,
the assumption floor, and a leaf banned after three identical failures. No Java changed. Not tested
live: whether `minHealth` voids at a useful moment during a real fight, and whether 240s is enough
for a gather that has to path a long way home.


## Remembered stations and non-fatal returns — 2026-09-09

Build `remembered-stations-1`, `skillsVersion` 2. Two live failures from the stone/iron pickaxe
sessions, both of which forced the operator to retype the same command to advance one step.

Stations were a scan of the 24x12 volume around the player, reported as bare names with no
positions. Walking out of that volume was indistinguishable from owning nothing, so a gather trip
erased the crafting table the previous step had just placed and the next plan built another one.
The agent loop made it worse by clearing its own station set from that scan on every iteration,
discarding what a `deploy_station` step had just established.

Stations are now remembered by position in `Stations.java`, for the life of the client level. A
placement is recorded when observed; a local scan merges into memory rather than replacing it; an
entry is dropped only when its chunk is loaded and the block is demonstrably gone, because an
unloaded chunk is not evidence of absence. `/observe` reports `stations` as before and adds
`stationSites` with coordinates, distance and whether the entry is currently verified. Craft and
smelt walk to a remembered station instead of failing, and give up as typed `station_unreachable`
after three route attempts rather than running out the action deadline. `USABLE_RANGE` is 256
blocks: a policy trade against re-crafting, not a reachability claim.

`return_path_failed` ended the whole multi-step goal even though the materials were already in
inventory, which is why each retyped command advanced exactly one step. Return is now retried up
to three times and then concluded as success with the shortfall named, because the reason to
return — staying near the stations — no longer depends on standing there. A genuine material
shortfall after return is still an explicit failure. This is only sound in combination with the
station memory above; separately it would lose the worksite.

Validation: 85 Node tests pass, including a replay of the gather-erases-the-table regression, and
the client compiles and installs. Live confirmation still needs a session that gathers far enough
to leave the scan volume and returns to the same table. Not tested: stations across dimension
changes, pruning after a table is broken by another player, and whether 256 blocks is the right
trade in practice.


## Gathering policy correction — 2026-09-09

Build `shallow-gather-return-2` supersedes the escape-reserve policy below. The depth-dependent cobblestone quota could increase as the miner descended, driving more excavation. It is removed. Requested gathering materials are excluded from scaffold items, so cobblestone gathered for crafting is not spent returning. Other configured scaffold materials remain available. Direct downward digging is disabled and placement receives a higher path cost. Logs, dirt and cobblestone target searches are limited to three blocks below the starting elevation through Baritone's mining Y settings; this bounds target choice, not every intermediate path position. Dedicated deep-ore expeditions still need a separate access-route policy.

Return goals accept any currently clear, supported, dry standing position within four blocks horizontally and one vertically of the start. They do not require restoring the exact block the player originally stood on. Material count is checked after return; shortfalls produce a failure instead of automatically starting another excavation cycle. No shallow target or usable return route can still fail the job explicitly.

The console now recognizes `get`, `fetch`, `gather` and `collect`, plus `logs`/`log`, `cobble`, and `cancel`. Generic logs choose an already-held supported species, otherwise oak; this is not yet world-aware selection among tree species.

Next pathfinding increment: rank harvesting sites by estimated approach, excavation, pickup and exit cost; plan ingress/egress before committing; remember failed sites; record path stalls and replan from changed terrain. These are not implemented by the settings correction. Validate the current build in leaf-obstructed trees, dirt-covered shallow stone and uneven return areas before calling it reliable.

## Mining access and return — 2026-09-09

Build `mining-access-return-1` replaces direct target breaking with Baritone's mining process. Skill paths may clear intervening leaves, grass, dirt and other blocks; automatic tool selection and inventory transfers are enabled. Each gather records its starting position and returns there before reporting success. Paths can excavate and pillar using dirt, cobblestone, cobbled deepslate or netherrack. Cobblestone gathering requests an extra vertical-depth allowance for escape blocks and rechecks retained material after returning. Failed return paths are reported explicitly. This is a resource allowance, not proof that every terrain configuration has a route.

Skill exit cancels the mining/path processes and restores the previous navigation settings, including on takeover and failure. Nearby tables/furnaces are observed within 24 horizontal and 12 vertical blocks and supplied to each replan; restarting a goal can reuse existing stations. Placement searches a volume around the player rather than four fixed ground positions. Station observations cache for up to one second and invalidate when a skill ends.

Validation: 83 Node tests pass, including reuse of an observed crafting table; the mod compiles and installs. Live obstacle clearing, hotbar recovery and underground return require testing after Minecraft reloads this build. Baritone's target discovery and path search replace the old 12-block gather limit; ore search is still bounded by the action deadline and available world data.

## Skill execution MVP — 2026-09-09

Implemented a client-tick `Skills` controller and serial `SkillExecutor`. Conversational obtain/craft/create requests now execute; `plan <item>` remains a read-only preview. The executor refreshes inventory and expands the remaining goal after every skill, preserves deployed-station knowledge within the run, checks session/epoch ownership, and stops on a failed leaf rather than repeating it. No model is required. Plural `sticks` and generic `planks` are resolved (planks prefer a wood type already in inventory).

Skills: local block discovery, Baritone approach, reach/raycast-checked breaking, harvest-tool checks and inventory-gain completion; nearby station placement/reuse; inventory/table recipe grids populated via ordinary container inputs; and raw iron/coal furnace batches of up to eight ingots. Crafting grids retain recipe geometry. Skills share the existing action lease, deadlines, stop/F8 and death cancellation. Closing an owned crafting menu uses vanilla cleanup, not item injection. Furnace interruptions leave deposited material in the furnace.

Limitations: this is an unvalidated gameplay MVP, not reliable autonomous iron acquisition. Discovery is limited to loaded blocks within 12 horizontal and six vertical blocks, no underground exploration or persistent station map. Paths cannot excavate access tunnels. Block collection may fail when drops cannot be reached; stations beyond the local scan require returning nearer. Furnace input currently requires a single sufficient raw-iron stack, an empty furnace and coal fuel. It does not recover interrupted furnace jobs. Inventory-delta checks use client inventory updates, not an independent server oracle. Skills do not resume after death or takeover. Preview DAGs still report `executable:false` because world preconditions are not established by planning alone.

Validation: 80 Node tests pass; client compilation succeeds. These are not live gameplay acceptance results. Restart Minecraft after installing the new jar before testing. Start with logs to planks, then sticks, then wooden/stone pickaxe before attempting the iron chain. Remaining improvements: live skill fixtures and acknowledgement edge cases; resource exploration and remembered stations; recovery of partially filled containers; persistent goal hierarchy and risk-aware alternative selection.

## Dependency planning — 2026-09-09

Implemented `agent/src/dependencies.js`: bounded symbolic backward chaining over vanilla crafting recipes and a small acquisition-method set (logs, dirt, cobblestone, coal, raw iron, diamond, and raw-iron smelting). Conversational console requests such as `can you create an iron pickaxe?` and `plan 12 dirt` generate read-only plans against fresh inventory. This is a limited intent parser, not general conversational goal understanding. The autonomous `run` loop does not yet execute these plans.

The method library is an AND/OR graph: all ingredients and stations are prerequisites, while recipes and acquisition sources are alternatives. A selected plan is an ordered dependency DAG with quantities, consumed materials, retained tools, shared deployed stations, output batches and leftovers. From empty inventory the iron-pickaxe preview gathers three logs, eleven cobblestone, three raw iron and one coal; it includes a crafting table, wooden and stone pickaxes, and furnace. Ore availability, accessibility and tool durability are unresolved runtime conditions, not proven by a recipe plan.

Research basis:
- [Optimus-1](https://arxiv.org/html/2408.03615v1) uses a hierarchical directed knowledge graph for task dependencies and retrieves/topologically orders task-related subgraphs. Its knowledge-guided decomposition is directly relevant here. This corrects any earlier implication that these systems only ask an LLM for isolated primitive actions. We borrow the planning representation, not its control-loop performance claims.
- [DEPS](https://arxiv.org/abs/2302.01560) combines execution feedback, plan correction and subgoal selection. Adopt explicit failure outcomes and feasibility-based selection rather than repeating impossible leaves.
- [Voyager](https://voyager.minedojo.org/) motivates persistent executable skill reuse and feedback-based improvement. Store verified skills separately from generated task plans.
- [SHOP/SHOP2](https://www.cs.umd.edu/projects/shop/description.html) supplies the older hierarchical task-network foundation: parameterized decomposition methods with preconditions. This is established planning machinery, not a new SOTA claim.

Reuse: cache item-to-method expansion, not an executable plan keyed only by item. Feasibility depends on inventory quantities, shared reservations, tool condition, available stations and world observations. The current implementation uses bounded backtracking with cycle rejection, not globally optimal dynamic programming. Future search can memoize full relevant planning states and rank alternatives by travel, tool cost and risk. A search-limit result is not proof of impossibility.

Execution work remaining, in order:
1. Structured crafting transactions: preserve recipe grid layout in the exporter; select inventory/table menu, place ingredients through ordinary client interactions, await server updates, recover leftovers and verify net output. No inventory injection.
2. `gather(item,count)`: discover loaded candidate blocks, navigate into reach, select a valid tool, aim/break, collect drops, and verify inventory increase. Return typed unreachable/no-source/tool-required/inventory-full outcomes. Structured block state can handle basic mining without a VLM.
3. Station placement/opening and furnace transactions: insert ore/fuel, track actual processing and retrieve output. The preview currently supports coal fuel only and assumes continuous batches; it does not model residual furnace burn time.
4. A serial skill scheduler with cancellation and durable goal state: run ready leaves, reobserve after each, invalidate stale reservations on interruption/death, and replan unmet requirements. DAG nodes are not permission to run simultaneous inventory mutations.
5. General chat intent extraction into typed goals, then persistent project/subgoal hierarchy. The LLM chooses goals and alternatives; deterministic tools own recipe arithmetic and execution verification.

Validation: 73 service tests pass, including resource-ledger replay of the empty-inventory iron-pickaxe plan. This proves neither live mining nor crafting. All previews report `executable: false` until skill executors are connected.

## Skill foundation — inventory and recipes

Implemented read-only `CraftingTools.inventory()`, `craftable()` and `canCraft(item)`, exposed in the console as `inventory`, `craftable` and `can-craft <item>`. Inventory is aggregated by registry ID; crafting previews use the main inventory and hotbar, excluding equipped/offhand items. The static 26.2 catalog is extracted from the installed vanilla game jar. Standard shaped/shapeless recipes are supported; special, cooking and component-bearing output recipes are explicitly outside this first catalog. Server datapacks may differ.

Two-step previews simulate consumption and output quantities, including alternative ingredients. Results are independent possible plans, not a promise that all listed items can be crafted together. A query distinguishes material feasibility from known crafting-station availability. Search is bounded and reports incomplete rather than claiming impossibility. These tools do not execute crafting or create items.

Next skill-execution increment: a cancellable, tick-owned crafting transaction through the ordinary inventory/crafting-table menu, with acknowledgement and inventory-delta verification; then target discovery, aiming, tool selection, breaking and pickup verification for `gather wood`, `gather dirt`, and `gather cobblestone`. Stone must require a suitable pickaxe to count as cobblestone acquisition. Mining success is material gained, not merely a block disappearing. Vision is optional for target selection; inventory and recipe arithmetic remain structured tools.

## Recovery patch status — 2026-09-09

Implemented: normal completion no longer changes control authority; the supervisor consumes action outcomes independently of the displayed reflex phase; queued actions identify themselves and retain their heartbeat while waiting. Stop disarms reflexes. Deliberation does not dispatch task actions while a reflex is active.

Retreat now checks candidate headings for body clearance, a one-block step, nearby support and fluids rather than always pressing forward directly away from a mob. Collision triggers jumping; water triggers upward swimming. Low air interrupts other reflexes to surface. This is local obstacle avoidance, not a complete escape pathfinder: overhangs, enclosed pools, complex walls and multiple threats still require live evaluation and longer-horizon escape planning.

Validation: service regression tests and compilation are separate from gameplay evidence. The new escape behavior must not be called validated until tested against steps, walls and water in the running client. Build identifier: `reflex-recovery-2`.

Status: proposal, not implemented or validated in the Realm.
Date: 2026-09-09.
Target: Minecraft Java 26.2, friends’ Realm, M5 MacBook Air with 24 GB unified memory.

## Decision

Build a client-native agent: a small Fabric integration controls the actual Minecraft client, a dedicated controller executes actions, and a visual planner chooses and revises goals. The user watches the actual game window and can take over immediately. Benchmark a standalone navigation implementation before adding autonomous planning.

This is an engineering proposal informed by research, not a reproduction of a published model. A new prompt or larger model cannot repair an unreliable action interface. Neither a successful unit test nor changing local coordinates proves successful movement on the Realm.

Keep the existing proxy infrastructure available for reference and rollback, but do not make the proposed client-native runtime depend on it. All existing application code is archived under `legacy/`. No legacy module is part of the replacement by default.

## User requirements

- Reach x=200, z=200 in the correct dimension before gathering or construction. Use the Overworld as the initial mission dimension.
- Break and place no blocks during relocation. If reaching the site requires terrain modification, report a blocked route and seek another route.
- After arrival, establish food, tools, a bed and a small shelter; adapt the order to current conditions rather than following a fixed mission list.
- Restrict work to an explicit approved region. The previous radius of 80 blocks is a configuration starting point, not evidence that every block inside it is unowned. Exclude registered structures and containers and stop when ownership is uncertain.
- Use ordinary movement and interaction constraints. Do not enable flight, reach extensions, KillAura, X-ray or player attacks.
- Keep commands, model explanations and diagnostics private. Public chat is untrusted observation, never a control interface.
- Provide natural-language orders, action history, brief decision explanations and visible failure evidence.
- One account is sufficient when the agent operates the user’s client and the user watches or takes over. Playing a separate character alongside it remains a separate-account workflow.

## Research basis

“SOTA” below refers to relevant frontier research and authors’ benchmark results, not a universal ranking. Benchmarks, game versions, task preparation and hardware differ; their scores must not be compared as if measured under identical conditions.

| Work | Evidence and architectural implication | Deployment limit |
| --- | --- | --- |
| [JARVIS-VLA, 2025](https://arxiv.org/html/2503.16365v1) | Trains vision-language models on Minecraft knowledge, visual grounding and action trajectories; generates keyboard/mouse action chunks. Visual understanding alone is not a trained gameplay policy. | Experiments use Minecraft 1.16.5; inference is reported on an RTX 3090. This does not establish Mac or 26.2 Realm support. |
| [OpenHA, 2025](https://arxiv.org/html/2509.13347v1) | Compares action representations and develops Chain of Action. Different tasks benefit from different abstractions; expose both goal-level skills and bounded lower-level actions. | Its trained model and simulator interfaces require adaptation. Our proposed tool interface is inspired by the result, not equivalent to its trained policy. |
| [CrossAgent, December 2025](https://arxiv.org/html/2512.09706v1) | Uses supervised training and reinforcement learning to select among action spaces. Reports 54.6% overall average success on its benchmark, illustrating both progress and remaining unreliability. | Learned action switching cannot be reproduced merely by adding tools to a prompt. Reported task success is not an unattended survival guarantee. |
| [SIMA 2, December 2025](https://arxiv.org/html/2512.04797v1) | Uses recent RGB observations, instructions and keyboard/mouse action chunks; includes dialogue and reasoning capabilities. Supports the real-client observation/action direction. | A research reference, not an assumed available downloadable runtime. No dependence on obtaining its weights or access. |
| [Real-Time Execution of Action Chunking Flow Policies, 2025](https://arxiv.org/html/2506.07339v1) | Explains why asynchronous execution needs continuity between old and new action chunks. Movement must continue while inference runs, with one authority deciding when control changes. | Its inpainting method applies to trained flow policies; our initial deterministic controller does not implement that algorithm. |
| [FutureRTC, July 2026 preprint](https://arxiv.org/html/2607.24008v1) | Predicts execution-time context to address stale observations under inference delay. Track observation age and reject stale commands. | Robotics evidence, not Minecraft validation. Timestamp checks are a practical first step, not a reproduction of its learned prediction modules. |

Implementation sources: [JARVIS-VLA](https://github.com/CraftJarvis/JarvisVLA), [OpenHA/CrossAgent](https://github.com/CraftJarvis/OpenHA). Their published CUDA-oriented setup does not establish Apple Silicon support. Start with available inference adapters and measure; do not promise local throughput based on parameter count.

## Second research round, 2026-09-09

Conducted after gate 1 passed, to check the architecture against current work rather than the papers chosen at the start.

| Work | Finding that changes our design | Deployment limit |
| --- | --- | --- |
| [MineExplorer, 2026](https://arxiv.org/abs/2605.30931) | Evaluates 18 frontier MLLMs on implicit multi-hop Minecraft tasks and reports **navigation failure as the dominant error at roughly 40%**, ahead of gathering, action execution and goal misidentification. Independently validates spending gates 1 and 2 on movement before planning. Its capability taxonomy — perception split into spatial, temporal, entity, state and inventory — exposes that our observation has no temporal dimension. Agents there see up to 20 historical frames; we return one. | Benchmark scores come from a curated task suite, not unattended survival. Larger models and thinking modes did not consistently help, so model choice is not the lever we might assume. |
| [MineEvolve, 2026](https://arxiv.org/html/2603.13131v3) | Improves long-horizon performance without touching model weights, by converting each subgoal execution into **typed** feedback: state change, inventory change, failure type, progress score and a stagnation flag. Repeated failures become stored remedies; successes become skills, admitted only after schema, matchability, executability, specificity and conflict checks. Progress is scored from spatial movement variance, inventory change magnitude and task-specific signals. Reports 34–40% on hard task groups against an Optimus-2 baseline of 32–36%. | The gains are on a planner already capable of the tasks; a memory layer cannot rescue an unreliable action interface. Their thresholds are tuned to their suite. |
| [Optimus-3, 2025](https://arxiv.org/abs/2506.10357) | Task-level mixture-of-experts with an explicit perceive → plan → act → **reflect** loop, using Embodied QA to judge completion. Confirms reflection as a distinct stage rather than a property of the planner. | Completion judged by asking a model. Our outcome evidence — block registry name before and after, measured displacement, inventory delta — is a harder oracle than that for the cases it covers. |
| [Game-TARS, 2025](https://arxiv.org/abs/2510.23691) | A unified **native keyboard-and-mouse** action space, anchored to human inputs, is what makes cross-domain pretraining possible; reports about 2× the previous best success rate on open-world Minecraft tasks. | We deliberately chose semantic actions over a navigation backend, which no pretrained keyboard-policy can consume without an adapter. Our `move`/`look`/`jump` primitives are the beginning of that interface and should be kept honest to real inputs. |
| [AsyncVLA, 2026](https://arxiv.org/html/2602.13476v1) | The fast/slow split with numbers: a base model at 5 Hz off-device and a small onboard adapter at 8 Hz, tolerating up to 6 seconds of guidance latency. Critically, the fast layer receives **both** the current observation and the older observation the slow model actually saw, so it can judge how stale its guidance is and deviate. | Its adapter is trained jointly with the base model. We are not training anything; the transferable idea is the two-observation interface and the frequency split, not the learned adapter. |
| [TypeGo, 2026](https://arxiv.org/pdf/2607.05482) | An explicit **S0 reflex layer** beneath the planner, plus a task scheduler for multi-task arbitration, in a classical three-layer architecture. | Robotics runtime, not Minecraft. Names the structure we are missing rather than supplying it. |

### What this round says we missed

1. **No temporal perception.** `/observe` and `/frame` each return one instant. Every system above consumes a sequence. Our own section 5 already asked for retained frame sequences around failures and it was never built. Cheapest real gap to close.
2. **No failure taxonomy.** Every non-success is `blocked` with free text. MineEvolve's result depends on failures being *typed*, because untyped failure cannot be matched against a remedy later. Our stagnation detection exists for exactly one action (`no observed movement for 15 seconds`) and should generalise into a progress score over movement, inventory and task-specific signals.
3. **No memory.** Nothing survives a session, so a failed approach will be retried indefinitely. Section 3 asked for this explicitly. MineEvolve's Curator checks are a usable specification for when we build it.
4. **The reflex layer is confirmed, not optional.** Two independent 2026 systems put a fast loop beneath the planner. Our control loop is Node polling at 500 ms with no safety tier. AsyncVLA adds a requirement we had not considered: the fast layer should be handed the stale observation the planner saw alongside the current one. Our protocol already carries `observedAt` and `ageMs`, but nothing uses them to modulate behaviour — only to reject.
5. **Action vocabulary is short of the benchmark taxonomy.** MineExplorer's action set is move, jump, collect, place, craft, attack. We have move, jump, break, place. Craft and attack are absent.

## Synthesis: three clocks, one authority

Every system surveyed puts the model inside the control loop. Optimus-3 spends a forward pass on perception, another on planning, another on action, another on reflection, and a fifth on Embodied QA to decide whether the task succeeded. Minecraft ticks at 50 ms; a capable VLM call is 1–10 seconds. The agent is therefore inert and unseeing for 20 to 200 ticks at a stretch, which is what its demo looks like. MineExplorer's headline — navigation is 40% of all errors — is the same disease seen from the evaluation side: those agents walk by asking a model where to put each foot.

They do this because research requires generality. We do not require generality, and refusing it is our entire advantage. Deterministic competence already exists for most of what a Minecraft body does: pathfinding, reach, block identity, inventory arithmetic, collision. Spending model calls there buys nothing and costs the agent its reflexes.

The design rule is therefore: **the model belongs in the goal loop, never in the control loop.** Three clocks, with a single control authority spanning them.

| Clock | Rate | Runs where | Responsibility |
| --- | --- | --- | --- |
| Control | 20 Hz, every client tick | Client mod | Execute the active action, hold safety reflexes, score progress, detect stagnation, validate the assumptions the current decision was made under |
| Verification | Once per action boundary | Client mod | Produce a typed outcome: status, failure class, before/after observations, hard evidence, progress trace. No model call, ever |
| Deliberation | 0.1–0.5 Hz, asynchronous | Agent process | Choose the next goal and repair plans, from a compact digest and typed history. Never holds control |

### What this improves on, specifically

**1. Real-time behaviour comes from determinism, not from a faster model.** Verification is free: we can read block registry names, inventory deltas and positions exactly. Optimus-3 asks a model whether a task completed; we measure it. That removes roughly half the forward passes in their loop before any optimisation, and it makes the remaining ones optional rather than blocking.

**2. Continuity without a trained adapter.** RTC and AsyncVLA solve "keep acting while inference runs" by learning to blend an old action chunk into a new one; AsyncVLA needs a jointly-trained 76M edge adapter to do it. We get the same property structurally, because our actions are semantic and resumable: a `navigate` goal keeps executing at 20 Hz while the model deliberates, and the model's answer either confirms the current goal — costing no interruption at all — or replaces it at a tick boundary. The current supervisor does the opposite: it stops the world before interpreting a replacement. That is correct for a human typing a command and wrong for an agent that must live inside its own inference latency.

**3. Staleness by assumption violation, not by clock.** Timestamp checks, which is all we have today and all FutureRTC's practical layer amounts to, reject decisions that are merely old and accept decisions that are catastrophically wrong but recent. A decision should instead carry the propositions it depended on — "no hostile within 8 blocks", "holding a pickaxe", "health above 12" — and the tick should void it the moment one stops holding, whether that takes 50 ms or a minute. This is only possible because our observations are structured rather than pixels, so it is an advantage of the deployed setting rather than a research contribution we are borrowing.

**4. The model receives a diagnosis, not raw experience.** MineEvolve's result depends on typed feedback, but computes it around the planner. Progress is measurable every tick from real quantities: distance-to-goal delta, displacement variance, inventory delta, block changes. Failure classification follows from those deterministically. The model should be handed `no_progress after 300 ticks, distance to goal unchanged, path recalculated 4 times` rather than twenty frames to interpret.

**5. Known failures cost zero model calls.** Remedies keyed by typed failure plus context can be matched deterministically, so the second occurrence of a failure is repaired without deliberation. Only novel failures reach the model. MineEvolve's Curator checks — schema completeness, context matchability, executability, specificity, conflict — are the admission criteria.

**What we give up, stated plainly.** Anchoring to semantic actions over a navigation backend means no pretrained keyboard-and-mouse policy such as Game-TARS can drive this agent without an adapter, and we cannot benefit from cross-domain pretraining. That is the right trade for an agent that will never be trained, and the `move`/`look`/`jump` primitives must stay honest to real inputs so the option is not permanently closed.

### Implementation order for the synthesis

1. Tick-rate progress scoring and typed failure classes in the mod. Foundational: stagnation, diagnosis and memory all key off it.
2. Observation history, closing the temporal perception gap.
3. Assumption-carrying decisions, validated on the tick.
4. Asynchronous deliberation that never stops the body.
5. Reflex tier under the arbiter, with safety above task.
6. Remedy memory keyed by typed failure.

## Proposed components

```mermaid
flowchart TD
    User[Private instruction / takeover key] --> Supervisor[Goal supervisor and control arbiter]
    Client[Actual Minecraft 26.2 client] --> Observations[Timestamped frames and client observations]
    Observations --> Planner[Visual planner]
    Observations --> Controller[Navigation and survival controller]
    Planner --> Supervisor
    Supervisor --> Policy[Action permissions and preconditions]
    Policy --> Controller
    Controller --> Client
    Observations --> Verify[Outcome verifier]
    Verify --> Supervisor
    Supervisor --> Journal[Event journal and dashboard]
    Verify --> Journal
```

### 1. Client bridge

A client-side Fabric mod obtains rendered frames and ordinary client-visible state, and applies inputs/interactions on the game thread. Avoid a server mod requirement so the design can work with a Realm. Use the client’s normal connection and authentication.

Expose health, hunger, inventory, dimension, position, nearby observations and current screen. Restrict observations to the agreed fair-play interface; do not query hidden server data or use buried-ore knowledge for resource discovery. Track client prediction separately from server corrections. In an instrumented test world, server-side position is the authoritative movement oracle; on the Realm, correlate client state, corrections, visual motion and interaction results without inventing per-tick movement acknowledgements.

The first implementation must prove that the displayed POV is the controlled player. Manual takeover cancels queued actions and releases held inputs. Death, disconnect, dimension changes and menus invalidate incompatible actions.

### 2. Fast controller and single control owner

Run action execution on client ticks independently of model inference. Navigation, obstacle response, eating and retreat remain responsive during a slow or failed model call. Begin with avoidance and retreat; add ordinary mob combat only after controlled tests.

Use one control arbiter with priority: manual takeover/stop, immediate safety, then current task. Each action has an ID, session generation, deadline, cancellation token and current owner. A new instruction cancels the old task generation. Late inference results and late action callbacks cannot resume it.

Candidate navigation backend: standalone Baritone, configured to forbid breaking and placement during travel. [Fabric supports 26.2](https://www.fabricmc.net/2026/06/15/262.html). A [26.2 Baritone fork](https://github.com/dysnasia/baritone-26.2/blob/26.2/README.md) exists but explicitly describes itself as work in progress with limited testing. Pin and inspect a candidate revision, then build and test it. Do not assume an unofficial release is production ready. If it fails the navigation gate, reassess the backend before investing in planner integration.

### 3. Visual planner and goal supervisor

The planner receives the current objective, recent frames, structured observations, elapsed time and verified action outcomes. It returns the next subgoal or bounded action, expected outcome, completion conditions and a short user-facing explanation.

Keep goals dynamic: retreat may supersede gathering; missing wool may lead to finding sheep; a blocked route may require a new approach. Replan after meaningful state changes and failures, not by endlessly resubmitting the same command. Retain failed approaches and their evidence to avoid loops.

The supervisor enforces relocation before work. Arrival requires stable proximity to 200,200 in the intended dimension, not a remembered “arrived” flag from an earlier session. The actual interaction target must also pass region checks on every action.

### 4. Multiple action levels

Offer goal-level actions such as navigate, acquire a bounded quantity, craft a known recipe and build a bounded blueprint section. Also offer visible-target interactions and short movement/look commands for recovery. All pass through the same permissions, ownership and cancellation checks.

An action request includes `actionId`, `sessionId`, `observationId`, `deadline`, arguments, expected result and policy scope. An outcome includes status (`succeeded`, `failed`, `cancelled`, `blocked`), before/after observations and evidence. Validate freshness and preconditions again at execution time.

Do not execute arbitrary generated host JavaScript. Dynamic planning can compose actions without shell or filesystem access. A future skill-authoring stage could generate a restricted action program, test it in a disposable world and admit it after validation; it is not required for the initial agent.

### 5. Verification, memory and logging

Measure actual effects: inventory increased, a specific block changed, destination reached, bed placed, or a hostile moved out of range. Do not label dispatch as success or coordinate prediction as confirmed travel.

Persist goals, registered property, known safe locations, recipes/skills and evidence-backed experience. Keep observations distinct from model interpretations and player statements. Log observation age, action owner, phase, cancellation reason, failure classification and model latency.

Use an asynchronous bounded event buffer so logging and dashboard clients cannot block the control loop. Retain short frame sequences around failures and optional local video recording. The private dashboard shows the real-client feed, timeline, current goal, brief rationale and stop/takeover controls. It does not promise access to hidden model reasoning.

## Model and hardware evaluation

Keep the model adapter replaceable. Compare a practical local VLM against a stronger remotely served VLM if remote inference is selected. Remote use requires an explicit decision about provider, cost and sending frames; it is not enabled by this plan. Existing `qwen2.5:14b` is a text model and does not provide the proposed visual perception by itself.

Measure end-to-end p50/p95 inference latency, observation age at execution, memory pressure, sustained game performance and task success on this Mac. A learned Minecraft policy such as OpenHA/CrossAgent is a separate candidate experiment: first establish runnable weights, preprocessing/action compatibility, inference requirements and behavior on the target client. Do not begin with training a foundation policy locally.

## Implementation sequence and acceptance gates

These are proposed acceptance criteria, not achieved results.

1. **Client and control baseline.** Pin Minecraft/Fabric/JDK versions and a navigation candidate. In a disposable singleplayer world, verify forward/turn/jump, inventory interaction and takeover. Stop must release inputs within two client ticks after receipt; cancellation must survive an artificially delayed planner response. No LAN server or second account is needed for a mod operating this singleplayer client.
2. **Navigation without a model.** Run at least 20 recorded routes over flat ground, slopes, forest and water-edge terrain, with breaking/placement disabled. Require at least 19 successes, zero unauthorized block changes, and bounded failure for unreachable goals. Verify motion using the integrated server as well as video. Repeat representative routes with logging enabled and disabled.
3. **Survival without a planner.** Test food use and threat avoidance in controlled scenarios; compare against an idle baseline. Inject inference stalls, dashboard disconnects and repeated orders. No stale action may regain control. Add bounded, normal mob combat only when its evidence improves outcomes.
4. **Adaptive visual planning.** Evaluate changing inventory, missing materials, route obstruction and approaching night. Require outcome-based replanning and no repeated identical failure loop. Record failures as well as successful runs.
5. **Base objective.** From multiple starts, reach 200,200 and pursue food, tools, bed and shelter inside registered work areas. Check protection at action targets, including pathfinding and indirect block changes. Define shelter completion by the actual structure and usable bed, not a checklist flag.
6. **Supervised Realm validation.** Prove client compatibility and motion first, then progressively enable the validated tasks. Compare Realm behavior against the test-world baseline. Do not infer overnight reliability from one successful session.

The critical path is client compatibility → reliable movement → responsive survival → adaptive planning. Stop work on higher layers if a lower acceptance gate fails.

## Repository boundary and proposed layout

Current retained infrastructure: none outside `client-mod/`, `agent/`, `scripts/` and `config/`. The proxy stack was archived on 2026-09-09 once the direct client reached a coordinate on the Realm without it; the client log recorded the route under `baritone/realms/...`, not a proxied server directory.
Current archive: `legacy/realm-bot/`, `legacy/backups/`, `legacy/zenith/`, `legacy/viaproxy/`, `legacy/start-zenith.sh`, old architecture document and agent launchers. Runtime state, dependencies and logs moved with the archived application. Moving files does not stop existing processes.

Proposed new implementation directories, to create when implementation begins:

- `client-mod/`: Fabric bridge, action arbiter, input control and policy enforcement.
- `agent/`: model adapters, goal supervision and memory.
- `dashboard/`: private controls, observations and evidence timeline.
- `evals/`: scenario definitions, recordings and measured reports.
- `config/`: non-secret policy and version manifests.

Do not import legacy gameplay logic implicitly. Reuse any piece only after reviewing its contract and verifying it against the new acceptance gates. Preserve existing infrastructure while the new direct-client design is evaluated.
