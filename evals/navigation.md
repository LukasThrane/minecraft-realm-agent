# Navigation acceptance procedure

Use a disposable local world. No Realm connection is necessary. Record results honestly; do not infer success from simulated adapter tests.

0. Turn pause-on-lost-focus off before anything else: press F3+P in game, or quit the client and run `scripts/client-options.py`. Left on, switching to the terminal opens the game menu, and the bridge correctly reads that as human takeover and cancels the running action. Every trial will end as `stopped` for a reason that has nothing to do with navigation.
1. Launch the isolated client, create a Survival world with cheats off, and return to gameplay.
2. Run the private agent console. `status` must show the current player coordinates and `positionSource: client-predicted`.
3. Start with a nearby destination on open ground. Observe actual screen motion and use F3 coordinates to cross-check the console. For a stronger oracle, add a server-thread observer in the integrated test server before using results as a formal benchmark.
4. During travel, press F8. Movement must stop and the service must not restart it. Repeat with terminal `stop`, menu opening, client disconnect and service termination. A heartbeat loss should cancel within three seconds plus tick scheduling.
5. Test a blocked destination. A no-progress result must be blocked, never success, and must not loop endlessly.
6. Repeat on slopes, forest routes and near water. Verify no block breaking or placement. Run with journal enabled and with the emit callback disabled to isolate logging effects.
7. Run 20 routes before treating navigation as a dependable baseline. Target at least 19 successes, zero unauthorized block changes and reliable cancellation. These are acceptance goals, not current measured results.

## Automated run

`bench 20` in the console (or `./realm-agent bench --trials 20 --distance 120`) walks 120-block legs in successive directions from wherever the character stands, cancels every fourth leg mid-route to measure release latency and post-stop drift, and writes `runtime/bench-<stamp>.jsonl` plus a `runtime/bench-<stamp>.md` table. It prompts before moving anything; `--yes` skips the prompt. Ctrl+C stops the bot and keeps the trials that ran.

The harness covers steps 3, 5 and 7 and the terminal-`stop` half of step 4. It does not cover F8, disconnect or service termination (step 4), block-change auditing (step 6), or terrain selection — legs are direction-varied, not terrain-controlled. Run those by hand and record them alongside the generated table.

Record per trial: game/mod versions, start, target, terrain, elapsed time, observed displacement, result, cancellation latency, block changes, JSONL filename and optional video. Keep failed trials.

The current MVP does not yet implement the integrated-server oracle or automated terrain setup. Those are future evaluation features. Client-coordinate observations alone are not server acknowledgements.
