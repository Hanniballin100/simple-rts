# Flat Earth vs Globalists

A Red Alert 2–inspired browser RTS built with vanilla JavaScript and HTML5 canvas. No dependencies, no build step.

## Play

```
node serve.js
```

Then open http://localhost:8377 and choose your truth.

## Code layout

| File | Contents |
|---|---|
| `rng.js` | Seeded PRNG, split into a `simRandom()` stream (hashed, in lockstep) and a free-running `fxRandom()` stream (cosmetic only). |
| `data.js` | All game data: constants, map sizes, terrain types, factions, unit/building stats. Balance changes go here. |
| `iso.js` | 2:1 isometric projection layer: project/unproject helpers used at render + input time (the simulation stays flat cartesian). |
| `mapgen.js` | Random map generator: start positions, mineral fields, terrain features. |
| `art.js` | Unit & building drawings (animated vector, RA2-style iso volumes with NE lighting) + particle effects. |
| `game.js` | Engine: state, orders, combat, AI, input, sidebar UI, depth-sorted iso rendering. |
| `desync.js` | `hashState()` and the determinism self-test harness. Dev only — nothing in the game depends on it. |
| `mockup.html/js` | Standalone art style demo. |

## Factions

Seven factions in four families, each with its own roster, passive trait, and signature power:

| Family | Faction | Passive | Signature |
|---|---|---|---|
| Earthers | 🥞 Flat Earthers | Horizon Is a Lie — enemy air always on radar | Documentary Drops — enemies periodically defect |
| Earthers | 🕳️ Hollow Earthers | Seismic Sense — enemy ground always on radar | Tunnel Network — travel between your grid nodes |
| Resistance | 📡 The Resistance | Sleeper Cells — hidden map vision | Smuggling Routes — interceptable supply trucks |
| Globalists | 🌐 Globalists | Compound Interest — your bank earns 2%/10s | Weather Modification — castable slow zone |
| Globalists | 🕶️ The Deep State | Deep Cover Recruitment — moles from the enemy roster | Gaslight — phantom signatures scramble defenses |
| Aliens | 👽 The Greys | Superior Metallurgy — immune to anti-building bonuses | Cloning Vats — copy any of your units |
| Aliens | 🦎 The Reptilians | Skin Suit — infantry pass as friendly until they strike | Reveal Infiltrator — one enemy worker was always yours |

## Features

- Random map generator — every game is a fresh layout with a coherent water plan (coastline, winding river with fords, big lakes, or landlocked), rocky ridges, mesas, forests, and mineral fields at every base plus contested expansions
- Four map sizes (Small to Huge — up to 6000×4200) and up to 5 AI opponents in a free-for-all — every AI plays its own faction and fights everyone, including each other
- Neutral structures dot the map: garrison infantry in houses, apartments, barns, shops, churches, warehouses, or office towers (6 slots) and they fight for you (evacuate any time); hold an Oil Derrick for bonus income — and mind the gas stations, they explode and burn when destroyed
- Map settings — Urban (a real city: street grid, zoned blocks from office-tower downtown to residential sprawl, parking lots, pocket parks), Town (villages around plazas), or Country (scattered farmsteads with crop fields, heavy forest, extra oil) — pick one or let the generator roll
- Terrain matters: water and rock block ground movement, forests slow units pushing through, and nothing can be built on any of them
- RA2-style sidebar construction: pay up front, build timer, place within your power grid's radius
- Power system — low power halves production, disables towers, and knocks out your radar
- Ground units path around buildings and terrain instead of walking through them
- RA2-style airfields — each holds 4 stationed aircraft that park on its pads and return to rearm; helicopters, drones, saucers, and blimps fly free
- Real fixed-wing flight — jets and winged beasts keep airspeed and a turn radius: strafing runs, bombing passes, loitering circles on station, and a landing approach back at the field; the AC-130 Gunship — a huge airframe flying from its own dedicated single-plane Spectre Hangar — flies a slow, wide pylon turn around its target, raking up to three enemies at once with cannon fire and howitzer shells; armed aircraft chain to the next nearest target after a kill, fly home only when the magazine runs dry, and all aircraft slowly repair at a friendly airfield
- Tech buildings — every faction has an expensive, power-hungry research site (Black Site Lab, Institute of Truth, Gene Vault...) gating its heavy hitters: the Globalist families unlock the AC-130 and the B-2 Spirit, the others their signature aircraft — and the Flat Earth factions must research the sky before they may build airfields at all
- Globalist air doctrine — drones and Black Helicopters roll out of the Motor Pool; the Air Force Base is for real planes: B-1 Lancers on day one, AC-130s and B-2s after the lab
- Asymmetric economies — every non-alien faction mines with its own capped Mining Rig: the Globalists' armed Mining Rig, the Deep State's sharp-eyed Unmarked Rig, the flat-earth family's light-hauling but lightly armed Rig of Truth and Salvage Rig, and Hollow Earth's slow armored big-load Bore Rig; the alien factions have no miners at all: their HQ and Zero-Point Cores generate minerals
- Faction-flavored buildings — the same construction slot costs and delivers differently per faction: Diesel Shacks are cheap and weak, Fusion Plants pricey powerhouses, Hollow Earth structures dug-in and tough
- Fog of war and a full air game with dedicated anti-air
- Artillery with minimum range, specialist infantry, faction-unique vehicles and aircraft
- EVA-style speech announcer and synthesized sound effects (mute with M)
- Enemy AIs play random factions from other families, each with its own build order, army composition, defense, and attack waves
- Click any enemy unit or building for a full intel card

## Determinism

The simulation is deterministic: the same seed and the same sequence of
commands produce bit-identical state forever. This is groundwork for lockstep
multiplayer; the networking itself is not built.

Three rules hold it up.

**One seeded stream for the sim, one free stream for the eye.** `simRandom()`
is seeded from `state.seed` at `startGame(faction, seed)` and covers everything
that can change *whether* or *where* something happens — damage rolls, scatter,
AI picks, spawn jitter, loot, the whole of `mapgen.js`. `fxRandom()` covers
particles, smoke, muzzle flashes and all of `art.js`; it is seeded from the
clock on purpose, so an accidental sim dependency on it shows up immediately as
a desync instead of hiding behind a shared seed. There is no `Math.random()` in
the sim path.

**A fixed timestep.** `stepSim()` advances exactly `TICK = 1/30` of a second
and takes no wall-clock delta at all. `frame(now)` accumulates real time, runs
up to `MAX_CATCHUP = 5` ticks, drops the backlog past that, and renders.
`state.time` is derived from `state.tick`, never accumulated, so it cannot
drift. `stepTicks(n)` advances the sim headless, with no rendering and no
clock.

**A command layer.** Input never mutates state. It posts
`{tick, owner, seq, type, payload}` into a tick-keyed queue, and `stepSim()`
drains that tick's bucket first, sorted by owner then by the issuer-assigned
sequence number — never by insertion order. Commands carry ids, never object
references. Selection, camera, zoom, control groups and the placement cursor
stay client-side and never enter the queue.

### Seats

Three separate ideas that used to all be spelled `PLAYER`:

| | what it is | who may read it |
|---|---|---|
| `PLAYER` | the constant `0`. Just an owner id. | anyone |
| `localOwner` | which seat this screen is sitting in | view only — rendering, the panel, the announcer, sound, fog display |
| `humanOwners` | which seats are driven by a person instead of `updateAI()` | sim — it is hashed, because every client has to agree who gets a brain |

`startGame(faction, seed, opts)` takes the lobby's seat assignment:

```js
startGame('flat', 909, {
  humans: [{ owner: 0, faction: 'flat' }, { owner: 2, faction: 'grey' }],
  as: 2,                       // this screen is player two
})
```

Single player is the one-element case and needs no `opts`.

The rule the whole design rests on: **nothing derived from `localOwner` may
reach sim state.** `viewpointTest` is what enforces it.

### Proving it

`desync.js` provides `hashState()` — a uint32 fold of every sim-relevant field,
including the RNG cursor and draw count, hashing floats by their exact bits —
and a harness that runs a match twice in one page and compares the hash at
every tick.

```js
Desync.selftest({ seed: 4242, faction: 'flat', opponents: 3 }, 400)
// -> { ok: true, ticks: 401, finalHash: ... }
```

The full proof is a 4000-tick, four-AI game run twice: identical at every tick.
Add `script: Desync.scriptedPlayer` to exercise the command queue too. The
long-run recipe is at the bottom of `desync.js` (it has to be chunked to fit
the console, not for any reason to do with the result).

There is a second test, and it catches a different class of bug:

```js
Desync.viewpointTest({ seed: 4242, faction: 'flat', opponents: 3 }, 400, 0, 1)
// -> { ok: true, ticks: 401, seats: [0, 1] }
```

`selftest` runs both matches from the same seat, so it cannot see view state
leaking into the simulation — both runs read the same fog and agree with each
other about all of it. `viewpointTest` runs the same match from two *different*
seats. Everything about who is watching may differ; nothing the hash can see
may. A failure means something the local screen owns has reached sim state, and
it names the tick.

That is not hypothetical. Fog of war used to be a single grid built for owner
zero, and the scout `explore` order picked its destination out of it — so every
side's scouts navigated by the human player's vision. `selftest` was green
through 4000 ticks with that bug in place. `viewpointTest` fails on it one tick
after a scout is given the order. Fog is per-owner now, and `tileStateFor` /
`visibleTo` / `nearestUnexplored` all take an owner: **the simulation may only
ask what a named side knows, never what the screen knows.**

### The one caveat

`Math.sin`, `cos`, `atan2`, `hypot` and `sqrt` are **not** specified to be
bit-identical across JavaScript engines, and they are load-bearing in the sim:
roughly 150 calls on sim paths, in distance checks, facing, and every unit's
movement integration. Replacing them means a lookup-table rewrite of the
movement and combat core.

**The choice made here is to accept them**, which means determinism is
guaranteed between clients on the same engine (Chrome↔Chrome, Firefox↔Firefox),
not across engines. In practice V8, SpiderMonkey and JSC agree on these far
more often than the spec requires, so a cross-engine match will usually work
and will occasionally desync — the harness will say exactly which tick. If
cross-engine play becomes a requirement, that is the work: fixed-point or
table-driven trig and distance, done as its own pass.

The one place this was *not* accepted is `prand()` in `mapgen.js`, which used
`fract(sin(x) * 43758.5)`. That idiom amplifies a one-ulp disagreement into a
completely different value, and `prand` decides where city blocks and landmarks
go, so it is now an integer hash.

## Controls

| Input | Action |
|---|---|
| Drag / click | Select units / buildings (click an enemy to inspect it); a box with army in it ignores workers |
| Right-click | Move, harvest, attack, set rally point |
| Right-click sidebar button | Cancel queued construction / training (full refund) |
| A + click | Attack-move |
| P / B / T / G / F / D / R | Build power / barracks / tower / AA tower / factory / airpad / tech |
| Ctrl+1–5, 1–5 | Assign / recall control groups |
| Mouse wheel / edge / middle-drag / arrows | Camera |
| H | Jump to base |
| M | Mute |
