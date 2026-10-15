# Survival control: evidence, research and implementation

Investigation date: 2026-09-09. This is a targeted engineering survey, not a claim of an exhaustive
leaderboard or a reproduction of the cited systems. Research benchmarks use different interfaces,
versions and tasks; their scores cannot establish reliability for this Fabric 26.2 client.

## What the recorded evidence establishes

`runtime/run-1788968704221.jsonl` records the diamond-pickaxe job exhausting its five-resume
allowance after six retreat starts. The recorded preemption snapshots have health 20. Neither
the outcomes nor these state samples identify the triggering entity. Peaceful mode and rain are
operator observations; there is no evidence here identifying a particular mob or implicating rain.
Older journals also record retreats during real health loss, so globally suppressing retreat would
remove a needed response as well as the false positives.

The inspected implementation used `Enemy` plus radius for both entry and persistence. That
interface is a classification, not evidence of an attack opportunity. It could classify conditional
or harmless entities as dangers and could not distinguish a wall from open ground. The 60-tick
expiry released the body without establishing safety, so the same predicate could immediately
preempt a resumed action. There was no entity attack controller: existing `break` interacted with
blocks, and Baritone supplied movement/mining. The Node allowance eventually abandoned the job.

## Relevant state of the art and established methods

| Work | What its primary source supports | Relevance and limit here |
| --- | --- | --- |
| [Voyager, 2023](https://arxiv.org/abs/2305.16291) | An automatic curriculum, executable skill library and iterative feedback support open-ended Minecraft learning. | Retain high-level skills and explicit feedback. Skill-library results do not prove a tick-rate defensive controller. |
| [STEVE-1, 2023/2024](https://arxiv.org/abs/2306.00937) | Instruction-following Minecraft behavior built from pretrained VPT and MineCLIP, evaluated on early-game tasks. | Learned low-level skills are a possible later comparison. They require their own runtime and evaluation; they are not an immediate replacement for collision-aware control in this mod. |
| [JARVIS-VLA, 2025](https://craftjarvis.github.io/JarvisVLA/files/JARVIS_VLA_paper.pdf) | Post-training a VLA with action and non-trajectory vision-language tasks improves Minecraft atomic-task performance. | Training and evaluation should cover multiple capabilities, including combat. Its task gains do not provide an evidence rule for this client's mob aggression or guarantee safe interruption recovery. |
| [Optimus-3, 2025](https://arxiv.org/abs/2506.10357) | Knowledge-enhanced data generation, task-level expert routing and multimodal reasoning-augmented RL address heterogeneous Minecraft tasks. | Capability-specific policies are relevant; importing a generalist model is unnecessary for fixing this deterministic predicate and ownership defect. |
| [NitroGen, CVPR 2026](https://openaccess.thecvf.com/content/CVPR2026/html/Magne_NitroGen_An_Open_Foundation_Model_for_Generalist_Gaming_Agents_CVPR_2026_paper.html) | A generalist vision-action model trained on 40,000 hours across more than 1,000 games; the paper reports transfer to unseen games. | Broad combat/control competence is an active research direction. Cross-game transfer is not a Fabric/Baritone integration or a survival guarantee. No model was downloaded or substituted. |
| [MineExplorer, 2026](https://arxiv.org/abs/2605.30931) | Atomic and multi-hop Minecraft exploration tasks with milestone evaluators; stronger models still struggle with longer dependencies. | Evaluate complete gather → interrupt → survive → resume trajectories, not only one successful attack or navigation step. |
| [Deep Visual Navigation under Partial Observability, 2021](https://arxiv.org/abs/2109.07752) | Behavior-specific memory addresses limited observation in visual robot navigation, including blind-spot scenarios. | The engineering inference is to retain recent evidence across occlusion. We use bounded deterministic evidence memory, not the paper's trained policy. |
| [Dynamic Window Approach, 1997](https://publications.ri.cmu.edu/the-dynamic-window-approach-to-collision-avoidance) | Reactive collision avoidance selects admissible motion under geometric and motion constraints. | The established principle is to reject unsafe trajectories before scoring progress. Our bounded ground graph and swept body checks borrow this principle; they are not DWA and provide no formal braking or dynamic-obstacle guarantee. |
| [Baritone GoalRunAway source](https://baritone.leijurv.com/src-html/baritone/api/pathing/goals/GoalRunAway.html) | A distance-based goal supports retreat away from positions, with optional Y restrictions. | A goal heuristic alone cannot establish threat credibility or safety. For this bounded baseline, a small explicit ground search gives directly testable reachability and avoids introducing another asynchronous Baritone owner during interruption. |

### Choosing to fight, and committing to a movement plan

The second live run turned the remaining questions into control problems rather than perception
problems: when is fighting the better option, and why did a valid route produce right-angle
shuffling? These are old problems outside Minecraft.

| Work | What its primary source supports | Relevance and limit here |
| --- | --- | --- |
| [Pure pursuit path tracking, CMU-RI-TR-92-01, 1992](https://publications.ri.cmu.edu/storage/publications/pub_files/pub3/coulter_r_craig_1992_1/coulter_r_craig_1992_1.pdf) | A path follower steers towards a lookahead point on the path rather than the nearest next point; lookahead distance trades cornering accuracy against oscillation. | This is exactly the defect in the recorded retreat: steering at the next grid cell gives cardinal, oscillating motion. We aim at the furthest still-reachable step instead. We do not implement curvature control or a tuned lookahead distance, and Minecraft movement is not a nonholonomic vehicle. |
| [Three States and a Plan: The A.I. of F.E.A.R., GDC 2006](https://www.gamedevs.org/uploads/three-states-plan-ai-of-fear.pdf) | Combat agents commit to a generated plan and replan only when it is invalidated, which is what makes behaviour look deliberate rather than twitchy. | The engineering inference is plan commitment with explicit invalidation, which is why an escape path is now held in world coordinates for a bounded time instead of re-searched every tick. We do not use GOAP, and no claim is made about squad behaviour. |
| [Baritone GoalRunAway source](https://baritone.leijurv.com/src-html/baritone/api/pathing/goals/GoalRunAway.html) | A distance-based goal supports retreat away from positions, with optional Y restrictions. | Retreat as pure distance maximisation is precisely what fails against a faster pursuer; the response now has to judge whether withdrawal is achieving anything. |

The fight/flee estimate itself is deliberately not learned and not novel: it is time-to-kill against
expected incoming damage, the standard arithmetic behind utility scoring in game AI, using published
vanilla weapon, armour and mob values. Its value here is that attacker count, weapon, armour and
health enter one comparable number with a stated reserve, so the decision and its evidence can be
read back from the journal. The numbers are calibration targets: enchantments, potions, knockback
and mob pathing all move the true outcome, and only live trials can settle the thresholds.

The resulting design choice is an engineering inference: preserve a fast deterministic safety
controller below the model, separate observations from threat judgments, and test temporal
transitions and route feasibility directly. This is not a new SOTA claim. Thresholds below are
initial engineering settings awaiting live calibration.

## Implemented baseline

- `ThreatAssessment` consumes client observations. Known hostile profiles require visibility and
  an attack opportunity: ground accessibility for melee, exposed range for ranged profiles.
  Conditional/unknown types need an aggression signal plus actual entity approach, or attributed
  damage. Generic `Enemy` membership is not consulted. Small ordinary slimes are not hostile;
  larger ones are classified in the client adapter. Rain and difficulty are not decision inputs.
- `Survival` reads local entities, visibility, client-synchronized aggression, position changes,
  creeper priming, health and hotbar equipment. Local 26.2 bytecode inspection confirmed
  `LivingEntity.handleDamageEvent` stores the received `DamageSource`; the adapter consumes new
  source objects and uses their source entity when available. It does not read server AI targets.
  Approach measures the entity's own movement toward the player, not the player's movement toward
  a stationary entity. Unknown or environmental damage is logged without inventing an attacker.
- Recent credible evidence survives 100 ticks without renewal, then requires 40 quiet ticks before
  work resumes. Known hostile reacquisition uses a wider radius. This is bounded uncertainty
  management, not proof that an occluded mob stopped pursuing.
- One uninterrupted survival episode owns the body through response changes. It gets 200 ticks
  of active threat response, then holds the job pending clearance. A missing safe route holds
  immediately. The cap never reports safety or repeatedly returns ownership to work.
- If a cleared episode is followed within 1,200 ticks by the same entity within eight blocks of
  its previously confirmed position, the site is marked recurrent. After a short defensive window,
  the job stays held until the client observes the entity dying or moving more than eight blocks
  from that position. Occlusion alone cannot clear this site guard. An unloaded entity can therefore
  require human takeover; alternative worksite selection is not implemented.
- Combat is singleplayer-only and decided numerically in `Combat`, not by a whitelist of situations.
  It compares our sustained damage (best hotbar weapon's vanilla damage and attack speed, capped by
  ten-tick mob hurt immunity) against expected incoming damage from every engaged attacker, killing
  weakest-first, reduced by worn armour, plus half a second of exposure. A fight is chosen when the
  estimate still leaves a four-heart reserve and health is at least eight, so attacker count, weapon,
  armour and health all move one comparable number. Creepers, ranged and airborne mobs, group-aggro
  mobs and unwinnable mobs are excluded outright. The actuator selects the best weapon slot, holds
  one target until it dies or leaves, closes on foot and checks vanilla reach and cooldown every
  strike. It does not chase, block, use ranged weapons or fight in multiplayer.
- A retreat that is not working escalates rather than freezing: no separation gained after 60 ticks,
  an exhausted movement budget, or contact with something faster than a sprint turns into a fight
  when the fight is survivable. Being cornered with no route defends instead of standing still.
  Neither escalation can turn a creeper or a ranged mob into a target.
- `EscapePlanner` searches a local graph within six blocks in each horizontal direction, including
  one-block step-ups and drops of up to three blocks, taking the flattest working step per direction
  and stopping at a cell ceiling so tick cost stays bounded. It scores three-dimensional endpoint
  clearance against all remembered threats and penalizes route length; routes must improve clearance
  and cannot materially approach a threat along the way. `GroundSafety` checks the swept body at
  quarter-block intervals, headroom, all four support corners for level steps, the fall column for
  drops, fluids, unloaded chunks and listed contact hazards.
- The chosen path is committed in world coordinates for up to 20 ticks and revalidated each tick,
  rather than re-searched every tick. Steering aims at the furthest step still reachable in a
  straight line, turns at a bounded rate, sprints when fed and jumps for steps and collisions.
  While airborne the commitment is kept, because there is no ground to search from and a dropped
  route would otherwise be reported as "no escape route" mid-jump. No mining or block placement.
- The Node executor retains the goal, waits for safety clearance before replanning from inventory,
  and checks session/epoch/abort while waiting. Temporary survival interruptions do not consume
  failure or completed-step budgets. Old armed reflex builds are rejected to avoid pairing the new
  resume semantics with the old loop. The runner does not deliberate during a survival hold.
- `/state` carries `survivalVersion: 1`, assessment evidence, elapsed assessment microseconds and a
  bounded 32-event ring. Events identify UUID/type, geometry, aggression, damage evidence, selected
  response, route and start/persist/end reasons. The supervisor deduplicates and journals events
  asynchronously. A disconnected logger can miss events older than the ring; no disk I/O is added
  to the client tick. Legacy `hostile` fields and `maxHostilesWithin` remain raw classification
  interfaces for compatibility, not the safety policy. Observations include the new assessment.

## Unsupported and not yet established

No global escape planning, stairs/jumps/drops, swimming escape, shield tactics, ranged combat,
creeper defusing, boss combat, PvP, general neutral-mob combat, armor/damage prediction, healing
strategy, hazard-source escape, or automatic selection of a different worksite. Surfacing and
hotbar eating remain physiological maintenance. Unknown mob types may only become credible after
observable aggression/approach or attributed damage. Damage sources missing an entity cannot be
attributed. A conservative hold can require operator intervention and is not a promise of survival.
Jobs are preserved in the running process, not persisted across process exit or death.

Automated checks execute the production assessment, memory, response selection, graph search and
swept ground algorithm. Terrain fixtures provide voxel occupancy; they do not simulate Minecraft
physics or packet delivery. Node tests exercise real executor wait/dispatch/replan behavior over a
simulated transport. The first refactor (`survival-evidence-1`) was run live once and journalled in
`runtime/survival-live-1788970337357.jsonl`. It removed the false positives but exposed two real
control defects: cardinal-only steering from a per-tick grid search, and a walk-only retreat from a
spider that gains no separation and then freezes when the movement budget expires. That evidence,
not a fixture, is why this iteration adds combat arithmetic, escalation out of a failing retreat,
committed continuous steering with sprinting, and vertical escape steps. The current build
(`survival-combat-2`) is installed but has not itself been run live: no new-code live Minecraft
result is claimed. See `evals/survival.md` for the live matrix and `scripts/survival-live.mjs` for
the harness.
