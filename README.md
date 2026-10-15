# Minecraft Realm Agent

An experimental agent that plays Minecraft Java Edition 26.2 through the player's own client. A
Fabric client mod exposes a local HTTP bridge inside the running game; a Node.js process observes
the game through it, plans with deterministic recipe and skill logic, and sends actions back. A
local language model (via Ollama) is optional and only used for goal-level decisions.

Because it drives the normal, authenticated client instead of a separate bot connection, the same
setup works in singleplayer and on a Minecraft Realm. It is a personal research project: most
testing has been in disposable singleplayer worlds, and live reliability is not established.

## How it fits together

```text
Minecraft client + Fabric mod  <-- HTTP, 127.0.0.1:3009, bearer token -->  Node agent  -->  Ollama (optional)
```

**Client mod** (`client-mod/`, Java 25, Fabric Loader 0.19.5, Fabric API)

- Starts an HTTP server bound to `127.0.0.1:3009`. Every request needs a bearer token that the mod
  generates into the game directory's `config/realm-agent-bridge-token.txt`; requests with a
  browser `Origin` header are rejected.
- Read-only endpoints (`/state`, `/observe`, `/history`, `/frame`) report position, vitals,
  inventory, nearby entities, light and a downscaled screenshot, each with its age.
- Control goes through `/act`, `/stop`, `/lease`, `/reflex` and `/respawn`. Actions run on the
  client tick and end with an outcome (`succeeded`, `blocked`, `cancelled`, `failed`), a typed
  failure reason and before/after evidence. Control expires without a 3-second heartbeat, and F8,
  opening a menu, death or a session change cancels it.
- Skills implemented in the mod: `gather`, `craft`, `smelt`, `deploy_station`, `eat`, `equip` and
  `shaft` (a descending staircase). Pathfinding uses a pinned, unofficial Baritone build for 26.2.
- A survival controller (threat assessment, retreat-or-fight choice, hazard escape, eating) runs on
  the client tick, so it keeps working while the Node process is busy or gone.

**Node agent** (`agent/`, Node 22+, no npm dependencies)

- A console for goals and immediate commands, a supervisor that owns cancellation, the heartbeat
  and outcome tracking, and JSONL journals under `runtime/`.
- A recipe planner over the vanilla 26.2 recipe catalog (`config/recipes-26.2.json`). A goal like
  `craft stone pickaxe` is resolved into gathering, crafting, station placement and smelting steps,
  and replanned from live inventory after every step. No model is involved.
- Death recovery: respawn or wait, rate limited, refused in hardcore worlds.

**Local model** (off unless `--model` is passed; `config/mvp.json` sets `qwen2.5:14b` at
`http://127.0.0.1:11434`)

- In the console, translates free-form text into navigate, stop or status requests, and chooses
  respawn or wait after a death. Outputs are constrained to JSON schemas and validated.
- In `run` mode, an agent in a worker thread keeps a persistent, hierarchical plan and starts one
  task at a time through a fixed tool set (`set_plan`, `start_task`, `pause_task`, `cancel_task`,
  `recipe_plan`, `say` and others). It cannot call the bridge directly; tasks are carried out by
  the deterministic executor. The operator-written `config/charter.md` is part of its system prompt.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the task and memory model and [MVP.md](MVP.md) for the
bridge protocol.

## Requirements

- Minecraft Java Edition 26.2 and the official Minecraft Launcher
- Java 25+ and Gradle 9 on the `PATH` (no Gradle wrapper is committed)
- Node.js 22+ and Python 3
- Optional: [Ollama](https://ollama.com) with the model named in `config/mvp.json`

`scripts/install-launcher.py` uses the macOS launcher location
(`~/Library/Application Support/minecraft`); other platforms need that path changed.

## Build and install

```sh
./scripts/build.sh     # verify/fetch the pinned Baritone jar, build the mod, run its checks
curl -o .cache/fabric-profile.json \
  https://meta.fabricmc.net/v2/versions/loader/26.2/0.19.5/profile/json
./realm-agent install  # with the launcher closed
```

`install` adds a **Realm Agent 26.2** launcher profile with its own game directory
(`runtime/realm-client/`), copies the mod, Baritone and Fabric API into it, and backs up
`launcher_profiles.json` to `runtime/launcher-backups/` first. Sign-in stays with the launcher; no
account token is read by the agent. After later changes, `./realm-agent build` rebuilds and copies
the mod into that profile; restart Minecraft to load it.

For local testing without the launcher, `./scripts/client.sh` starts a Fabric development client
(it cannot join Realms); connect to it with `./realm-agent console --dev`.

## Running

1. Start the **Realm Agent 26.2** profile and open a world or join a Realm.
2. Press F3+P so the game does not pause when the terminal has focus (or run
   `./realm-agent options` once with Minecraft closed).
3. Start the console with `./realm-agent`. Nothing moves until you give a command.

Bare text is a goal and runs until it finishes or is stopped (`craft stone pickaxe`, `get 6 logs`,
`craft iron_pickaxe`). Commands with a slash are immediate: `/status`, `/inventory`, `/craftable`,
`/plan iron pickaxe` (read-only preview), `/look`, `/frame`, `/go 200 200`, `/reflex on|off`,
`/help`. `stop` or F8 in the game cancels whatever is running.

```sh
./realm-agent console --model                        # free-form wording through the local model
./realm-agent run "get full iron toolsets and armor" # autonomous run with the model as planner
./realm-agent debug                                  # read-only viewer for the saved model trace
```

A run prints a localhost URL for a live inspector showing prompts, streamed model output, tool
calls and task state. Agent memory is stored per world in `runtime/agent-memory-*.json`.

## Tests

```sh
./realm-agent test     # node --test over agent/test/*.test.js, against a simulated bridge
./realm-agent build    # also runs survivalTest, an assertion harness for survival policy
```

`./realm-agent gate1` and `./realm-agent bench` are live acceptance runs that move the character
and write reports to `runtime/`; use a disposable world. `node scripts/agent-smoke.mjs` runs the
configured Ollama model against a simulated body. Procedures are in [evals/](evals/).

## Limitations

- Skills break and place blocks on Realms as well as in singleplayer. Run it only where terrain
  changes are acceptable.
- Gathering only searches loaded blocks near the player, and smelting runs in batches of at most
  eight items.
- The survival controller and the Baritone build have not been validated across real terrain; the
  live survival scenes in [evals/survival.md](evals/survival.md) have not been run.
- The client only knows what the client sees: no server-side mob targets, nothing outside loaded
  chunks, and positions are client-predicted.
- Planning quality from a small local model varies. Unit tests check the controller, not the
  model's decisions.
- Only one modded client can run at a time, since both would bind port 3009.

[PLAN.md](PLAN.md) holds the research plan, acceptance gates and test notes.
