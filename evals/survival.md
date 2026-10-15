# Survival acceptance matrix

Status: **not run live for `survival-combat-10`**. Build and automated results are in PLAN.md. Use a
disposable singleplayer world and the rebuilt mod; `/state` must show `bridgeBuild: survival-combat-2`
and `survivalVersion: 1`. Run scenes with `node scripts/survival-live.mjs [seconds]`, which journals
the evidence and prints modes, events, separation, turn rate, sprint state and latency. Keep the Node
session journal. Do not use a valuable world for combat trials.

An earlier build (`survival-evidence-1`) was run live once and is recorded in
`runtime/survival-live-1788970337357.jsonl`. It is kept as the evidence for the steering and
fight/flight defects described in PLAN.md, not as a passed scene.

For each scene record difficulty, weather, equipment, player health, entity UUID/type and positions,
wall/floor geometry, action ID, reflex count, survival event evidence, assessmentMicros, health
loss, escape displacement, and final inventory. Run with and without a deliberately slow planner.
The entity setup is controlled test evidence; it does not identify the old incident's entity.

| Scene | Expected observation/response | Acceptance evidence |
| --- | --- | --- |
| Peaceful, rain, full health, cobblestone gather; cows/neutral mobs nearby | Continue work unless credible attack evidence arrives | No threat preemption due to type/distance/rain; requested inventory reached |
| Neutral enderman, zombified piglin, piglin, wolf, ordinary size-one slime | Continue while unprovoked | Nearby records present, no credible threat; verify size classification |
| Zombie behind sealed wall; player in house | Continue work | Visibility/accessibility false; no retreat |
| Zombie underground or on a ledge, including a visible window gap | Continue if it lacks melee access | Vertical/ground route evidence, no false preemption |
| Exposed zombie on flat ground, player unarmed | Retreat using reachable ground route | One episode start, no blind wall input, health/displacement recorded |
| Exposed skeleton across height gap | Retreat/hold despite no melee route | Ranged profile plus visible exposure |
| Provoked neutral attacks | React to approach/aggression or actual attributed packet | Correct UUID; unrelated bystander never blamed |
| Fall/fire damage with harmless nearby mob | No fabricated mob attacker | Damage source logged; no type-only retaliation |
| Pursuer disappears behind wall | Retain threat briefly, then stable clearance | Decaying evidence ages; no immediate work release on LOS loss |
| Wall blocks direction directly away, side path open | Take safe detour | Route cells avoid wall and improve clearance against all threats |
| Fully blocked route, lava/gap/head obstruction on alternatives | Hold job | No unsafe movement; no repeated preempt/resume counter growth |
| One close hostile, healthy, any hotbar weapon | Defensive melee | Cooldown/reach respected, damage/death observed, slot restored on exit; `weapon`/`weaponDps` in evidence |
| Same hostile, no weapon, or at low health | Retreat instead | Same scene flips response purely on loadout/health, with the estimate in the reason |
| Two hostiles unarmoured vs. the same two in iron with a good sword | Retreat, then fight | Attacker count and gear both move the decision; estimate recorded both times |
| Spider or wolf in contact (faster than a sprint) | Fight, not an endless withdrawal | Reason cites the outrun/no-separation escalation; separation and health recorded |
| Retreat that opens no separation for 60 ticks | Escalate or hold, never freeze | Mode changes away from retreat with a stated reason; no idle sample adjacent to an attacker |
| Low health, many hostiles, creeper or unsupported mob | Avoid unsupported combat | Retreat if route exists, otherwise hold; creeper never becomes a target |
| Retreat across open ground | Smooth continuous heading, sprint used | Median per-sample turn well under 90 degrees, no cardinal staircase, `sprinting` true, displacement grows |
| Threat while the player is swimming or mid-jump | Still engages and still finds a way out | `accessible` true from the contact test with `onGround=false`; a route exists in water; no indefinite hold while taking damage |
| Retreat that ends in water | Swims out rather than sinking | Jump held while in water, displacement onto land, air not exhausted |
| Pursuer left far behind (skeleton at 20 m) | Response ends | Memory dropped past 18 m; work resumes instead of retreating to the horizon |
| Baby zombie in contact with a weapon | Fight | Flagged fast from `isBaby`, escalation reason recorded |
| Armour in the bag, sword in the main inventory | Both end up where they belong | `loadout` events name each move; the safety tier's `weapon` becomes the sword, not a pickaxe |
| Kit maintenance while a skill owns a menu | No slot moves | No `loadout` event during craft/smelt; no cursor conflict or lost item |
| Escape requiring a step up or a ledge drop | Route climbs or drops | Route steps carry non-zero `y`; no fall damage; no blind movement into a shaft |
| Threat killed or relocated after temporary interruption | Resume and replan | Same job goal, existing inventory retained, no duplicate failure entries |
| Return to same still-occupied worksite | Recurrence guard | Job held after recurrence, no repeated gather/retreat loop; release on observed relocation/death |
| F8, stop, menu, death and world transition during hold/fight | Cancel control | Inputs released, epoch fence prevents resumption; no later model decision revives old job |

Repeat flat-ground and wall cases with several seeds and entity positions, and inspect p95/p99
assessmentMicros and total tick time. The search's cell ceiling is a work bound, not a measured
latency guarantee. Add packet/collision regression fixtures for failures discovered live. Do not mark this
matrix passed from the Java policy harness alone.
