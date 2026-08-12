# Determinism refactor — prompt for a fresh session

Paste everything below into a new Claude Code session opened on
`C:\Users\Owner\Desktop\simple-rts`.

---

## The task

Make the simulation in this game **deterministic**, so that two machines running
the same starting seed and the same sequence of player commands produce
bit-identical game state forever. This is the prerequisite for lockstep
multiplayer. Do NOT build the networking — only make the sim deterministic and
prove it.

This is a browser RTS: vanilla JS, no build step, no dependencies. Load order is
`data.js → iso.js → mapgen.js → art.js → game.js` (see `index.html`).
`serve.js` is a tiny static server; `.claude/launch.json` runs it on port 8377.

## Why it currently is not deterministic

Three separate problems. Please confirm each yourself before changing anything —
these counts were taken at commit `f86d9d9` and may have drifted.

1. **~175 `Math.random()` calls** — roughly 74 in `game.js`, 21 in `art.js`,
   80 in `mapgen.js`. Every one is an independent, unseeded source of divergence.
2. **Variable timestep.** `frame(now)` derives
   `dt = clamp((now - lastTime) / 1000, 0, 0.05)` from `requestAnimationFrame`
   timestamps. Two clients never see the same `dt` sequence, so even with
   identical randomness they diverge on frame one. Float accumulation in
   `state.time` compounds it.
3. **No command layer.** ~21 `addEventListener` handlers mutate `state` directly
   (see `issueCommand`, `selectAt`, `sidebarUnitClick`, `startResearch`, …).
   There is no record of "what the player did", only its effects.

## What to build

### 1. A seeded PRNG, split by purpose

Add a small deterministic generator (mulberry32 or xorshift128 — cheap and
adequate; do not use `Math.random` as a fallback anywhere).

Create **two independent streams**:

- `simRandom()` — everything that touches game state: damage rolls, scatter,
  AI decisions, spawn jitter, brood placement, loot, map generation.
- `fxRandom()` — everything cosmetic: particles, sprite jitter, smoke, muzzle
  flashes, `art.js` in its entirety.

Only `simRandom` is seeded from the match seed and must stay in lockstep.
`fxRandom` may free-run — it must **never** be read by sim code. Keeping them
separate is what lets the art/animation pass proceed without breaking netcode.

Audit every current `Math.random()` and route it to the correct stream. Be
careful with the ambiguous ones — anything that decides *whether* something
happens (a crit, a dodge, an AI pick) is sim, even if it looks cosmetic.
`mapgen.js` is entirely sim. `prand(seed)` in `mapgen.js` is already a
deterministic hash and is a good model.

### 2. A fixed timestep

Decouple simulation from rendering. Target shape:

```
const TICK = 1 / 30;              // sim ticks per second — pick and document
accumulator += realDeltaSeconds;
while (accumulator >= TICK) { stepSim(TICK); accumulator -= TICK; tickNo++; }
render(alpha = accumulator / TICK);
```

- `stepSim` must take **only** the constant `TICK`, never a wall-clock delta.
- Cap the catch-up loop (e.g. 5 ticks) so a stalled tab does not spiral.
- Replace `state.time` accumulation with `tickNo * TICK`, or keep `state.time`
  but derive it from `tickNo` so it cannot drift.
- Rendering may interpolate; interpolation must not write to sim state.

Note that `frame(now)` currently does sim AND draw. It is stepped manually from
the console during testing (see below), so keep a way to advance N ticks
deterministically without rendering.

### 3. A command layer

Player input must stop mutating state directly. Instead:

- Input handlers produce **command objects**: `{tick, owner, type, payload}` —
  e.g. `{type:'move', unitIds:[...], x, y}`, `{type:'build', structure:'barracks'}`,
  `{type:'research', key:'stealth'}`.
- Commands go into a queue keyed by the tick they execute on.
- `stepSim` drains that tick's commands, applies them in a **deterministic
  order** (sort by owner, then by a stable command id — never by insertion
  order, which varies by machine), then runs the sim.
- Selection, camera, and other view-only actions stay client-side and must
  never enter the queue.

The AI must also emit commands rather than mutating state directly, or at
minimum run at a fixed point in the tick with no dependence on wall time.
Check `updateAI` and `ais[owner].thinkTimer` for wall-clock dependencies.

### 4. Prove it

Add a desync self-test — this is the deliverable that matters:

- A `hashState()` that folds the sim-relevant parts of `state` (unit positions,
  hp, owners, order types, building state, minerals, research, RNG cursor) into
  a single integer. Exclude particles, camera, selection, sprite caches.
- A harness that runs the same seed + same scripted command list twice in one
  page and asserts the hash matches at every tick.
- Then a harder one: run 3000+ ticks of a 4-AI game twice and compare. This is
  the real test, because the AI touches the most state.

Report the tick number of the first divergence if any, and fix until clean.

## Constraints and cautions

- **Do not change game balance or behaviour.** This is a mechanical refactor.
  If a fix changes outcomes (e.g. re-ordering damage application), say so
  explicitly rather than quietly absorbing it.
- Watch for hidden order-dependence: `Object.keys` order, `Array.sort`
  stability, `Set`/`Map` iteration, and `state.units.filter(...)[0]` style
  "pick the first match" — all of these are fine locally but only if the
  underlying array order is itself deterministic.
- `state.units` is compacted with `.filter(u => u.hp > 0)` each tick; make sure
  ids, not indices, drive anything persistent.
- Floating point IS deterministic across machines for `+ - * /` under IEEE 754.
  `Math.sin`/`cos`/`hypot`/`pow` are **not** guaranteed identical across
  engines. Inventory their use in sim paths and decide: accept (same-engine
  play only), or replace with lookup tables / integer math. Say which you chose.
- Keep it vanilla JS with no build step and no new dependencies.

## How to verify in this repo

There is an established harness. Read `.claude/` and the memory notes if
present, but in short:

- Start the server via the `simple-rts` config in `.claude/launch.json` (port
  8377). Do not run a dev server from Bash.
- The Browser pane throttles `requestAnimationFrame`, so **step the sim by hand**
  from `javascript_tool`: keep a monotonically increasing clock and call
  `frame(now)` in a loop. Keep each call under ~2500 frames or the tool times
  out.
- `serve.js` has a built-in screenshot receiver: `POST /shot?name=foo` with a
  canvas dataURL writes `.shots/foo.jpg`, which you can then read.
- **Never call `startGame()` twice without reloading the page** — bases stack
  and `state.time` does not reset.
- Setup globals: `selectedSize`, `selectedOpponents`, `superweaponsOn`, then
  `startGame('flat'|'glob'|'deep'|'hollow'|'grey'|'reptilian'|'resistance')`.

## Suggested order of work

1. Confirm the three problems and the current counts. Report what you find.
2. PRNG + stream split, with the `Math.random` audit. Commit.
3. Fixed timestep. Commit.
4. `hashState` + the double-run desync harness. Commit — **this is where you
   find out whether steps 2–3 actually worked.**
5. Command layer. Commit.
6. Final proof: 3000+ ticks, 4 AIs, two runs, identical hashes.

Work in small commits with the sim runnable after each one. If the command
layer turns out to be much larger than the rest, stop after step 4 and report —
a deterministic sim with direct input is already most of the value, and the
command layer can follow separately.
