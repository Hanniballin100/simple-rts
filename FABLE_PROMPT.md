# Fable build prompt — simple-rts roster & faction expansion

You are extending an existing vanilla-JS/canvas RTS. This is a large, multi-part feature.
Work in the numbered PHASES below, in order, and verify after each phase before moving on.
Do NOT try to land everything in one pass.

## Orientation (read before writing any code)

Files (all plain globals, no modules):
- `data.js` — ALL game data: constants, factions, `UNIT_TYPES`, `BUILDING_TYPES`, per-faction
  building overrides (`BUILDING_MODS` → merged into `FBUILD`), and the `PACE` multiplier applied
  to every unit/building at load. **Most new content is a data entry here.** Read this file fully first.
- `game.js` — the engine (loaded after data.js): simulation, pathfinding, combat, powers, input.
  New *verbs* (burrow, capture, mind-control, etc.) are implemented here.
- `art.js` — rendering. New unit/building shapes are drawn here.
- `mapgen.js` — neutral map structures.

Conventions to respect:
- Base stats in `data.js` are pre-`PACE`; the loader multiplies hp/speed/buildTime. Write new
  entries in the same pre-PACE scale as neighbours so relative balance stays readable.
- Per-faction building differences go in `BUILDING_MODS`, not by duplicating `BUILDING_TYPES`.
- Faction rosters are wired via `FACTIONS[fk]`: `worker/infantry/aa/vehicle/air/tower/aaTower/
  extras/advanced/powers/buildingNames`. Add units to the right slot/array or they won't be trainable.
- Reuse existing systems before inventing new ones. Already supported:
  - unit `weapon`: `lob | storm | spray | bomb | missile | gunship | pulse | chain | beam` (+ default gun)
  - `groundEffect: { kind: 'fire'|'toxin'|'magma', r, dur, dps }` (lingering AoE)
  - air: `flying` + either `pad`/`plane` (fixed-wing, ammo, airfield slots) or free-fly
  - `bldgBonus` (anti-building mult), `armor` (damage reduction), `targets: 'ground'|'air'|'both'`,
    `dmgVsGround` (AA units firing at ground), `minRange` (artillery), `req: 'tech'` (tech-gated)
  - buildings: `power`, `cap`, tower `weapon: pulse|chain|beam`, `ownWeaponArt`, neutral `explodes: {}`,
    `income` (minerals/10s), garrison `slots`
  - powers: `powers.passive` + `powers.sig` with `kind: zone|instant|unit|auto|info|once`

Verification harness (use it after each phase — see the `.shots/` workflow and `serve.js`): the sim
can be stepped with `frame()` and screenshots captured via the local POST receiver on port 8378.
Confirm each new unit trains, renders, and its verb works before continuing.

## New flags/systems you will add (engine)

- `detector: true` — this unit reveals stealthed/burrowed enemies within its `sight`.
- `stealth: true` — invisible to enemies until it attacks OR an enemy `detector` sees it.
- `burrow: true` — unit can toggle a burrow stance (see Phase 4).
- `suicide: true` — on reaching its target, detonate (splash via `splash`) and remove self.
- `captures: true` — engineer: order onto an enemy building to convert it to your ownership.
- `repair: <hp/s>` — heals nearby allied units/vehicles; a repair-pad building heals docked craft.
- `petrify: <sec>` — on hit, stun the target (can't move or fire) for N seconds instead of pure dps.
- wall/gate/mine building kinds (Phase 1); tunnel entrances + burrow-travel (Phase 4).
- superweapon building framework (Phase 7): tech-gated structure, long charge timer, targeting reticle.

---

## PHASE 1 — Cross-faction systems (engine-heavy; every faction uses these)

1. **Detection & stealth.** Add `detector` and `stealth`. Stealthed/burrowed enemy units render only
   when inside the `sight` of one of your `detector` units (draw them ghosted, targetable while revealed).
   Give each faction its detector by adding `detector: true` to its existing cheap recon unit:
   Weather Balloon (`wballoon`, flat+resistance), Surveillance Van (`blackvan`, glob+deep),
   Scout Orb (`orb`, greys+reptilians). Hollow gets a new cheap **Seismograph Dowser** recon unit
   with `detector: true`. Detector is the ONLY counter to burrow and shapeshifter cloak — keep the
   recon units cheap and fragile so scouting stays risky.

2. **Walls & gates.** New buildings: `wall` (cheap, high hp, low/no power, blocks ground pathing,
   built in short segments) and `gate` (like a wall but passable to the owner's units, blocks enemies).
   Available to all factions.

3. **Engineer capture.** A `captures: true` infantry unit per faction: order it onto an enemy building
   → it is consumed and the building flips to your ownership. Flavor per faction (plain "Engineer" is
   fine for most; the Reptilian one is the **Shapeshifter**, Phase 6). Balance: fragile, no weapon.

4. **Mines / IEDs.** A cheap buildable static trap that is `stealth: true` and detonates on an enemy
   entering range (reuse the neutral `explodes: { r, dmg, fire? }` mechanic). Available to all, but make
   it cheapest/most central for **Resistance** and **Flat Earthers** (their identity). Needs a detector
   to spot before it triggers.

5. **Repair.** A **Repair Pad** building that heals vehicles/aircraft parked on it, plus a **mobile
   repair unit** (`repair: N`) that heals nearby allies. Give both to the **Globalist family (glob+deep)**
   and the **Alien family (greys+reptilians)** only.

---

## PHASE 2 — The Resistance (break it off the Flat-Earther clone kit)

- **Drone Shop** building — replaces the airpad in `FACTIONS.resistance.airpad`/`buildingNames`; this is
  where their air comes from now.
- **FPV Swarm** — tiny, fast, weak, cheap flyer (think Cave Bat scale, resistance-flavored).
- **RPG Partisan** — glass-cannon infantry with `bldgBonus` and strong-vs-vehicle damage; low hp.
- **Marksman** — long `atkRange`, high single-target dmg, slow cooldown, fragile.
- **Technical rework** — make the existing `technical` an all-purpose Toyota: `targets: 'both'` (AA + ground),
  cheap and fast, but WEAK vs vehicles/armor (it is NOT their anti-vehicle answer — the RPG Partisan is).
- Keep IEDs (Phase 1) central to their play.

---

## PHASE 3 — Flat Earthers

- Keep IEDs central (Phase 1).
- Everything else for flat earth lands in Phases 7–8 (rocket-pad superweapon + The Leveler heavy).

---

## PHASE 4 — Hollow Earthers (biggest engine work: the underground playstyle)

Ship BOTH mechanics:

1. **Tunnel Network (infrastructure).** New cheap **Tunnel Entrance** building (low hp, low power).
   Select ground units → right-click any Tunnel Entrance you own → they burrow in (unselectable +
   untargetable in transit) and emerge at the destination after a delay that scales with distance.
   Entrances can be built forward near the enemy for offense. Destroying an entrance kills units in
   transit through it. (This upgrades the current base-only `Tunnel Network` sig power into a real network.)

2. **Burrow stance.** Toggle ability on Hollow infantry and the Drill-Tank line: burrowed = FULLY
   invisible + untargetable, moves slowly, cannot attack; surfacing grants a one-time ambush first-strike
   bonus. Countered ONLY by enemy detectors. Note the asymmetry: Hollow's **Seismic Sense** passive means
   THEY still see all enemy ground units, so they can't be ambushed the same way (one-way vision) — keep that.

3. **Emergence siege.** When the **Iron Mole** (Phase 8) or a **Drill Tank** surfaces, crack the ground for
   a small AoE and let it erupt directly against enemy structures.

New Hollow content:
- **Vril Priestess** — support caster (`repair`/buff aura) channeling Vril energy; fills the missing support role.
- **Agarthan Guardian** — elite heavy infantry (armored).
- **Cave Saurian** — armored melee beast (surviving Pellucidar dinosaur).
- **Seismograph Dowser** — the cheap detector recon unit from Phase 1.
- Buildings (via `BUILDING_MODS.hollow` + `buildingNames`): **Vril Reactor** (power/tech flavor),
  **Crystal Geode** (economy, `income`).
- **Style:** brass/riveted Jules-Verne dieselpunk + bioluminescent crystal + inner-sun glow; a lost-1940s
  Antarctic-expedition-gone-native vibe. IMPORTANT: retro-occult pulp only — NO Nazi iconography of any kind.

---

## PHASE 5 — The Greys

- **Probe Drone** — one-shot recon: fly it onto an enemy unit to implant a tracker, then the drone VANISHES;
  the tracker grants your team lasting vision on that tagged enemy unit until that unit dies.
- **Zeta Vivisector** — support unit that heals your units and/or drains enemy hp.
- **Cattle Mutilator** — economy unit that generates minerals from kills/wrecks (feeds the zero-point economy).
- **Abduction** — let the Tractor Beam tower / a saucer lift an enemy unit out of play (remove or convert).
- Style: Roswell chrome, big black eyes, sterile lab. (Superweapon Pyramid + Mothership heavy in Phases 7–8.)

---

## PHASE 6 — The Reptilians (control & deception, not brute force)

- **Shapeshifter** — their engineer/capture unit (`captures: true`) AND `stealth`: it reads as a friendly
  enemy unit until it acts. Doubles as their Phase-1 engineer.
- **Basilisk Gaze** — give the existing `basilisk` a `petrify` weapon: its attack briefly turns the target to
  stone (stun: can't move or fire) instead of dealing pure damage. Unique crowd-control; nobody else has it.
- **Chitauri Broodmother** — elite that periodically hatches free weak hatchling swarms and buffs nearby reptoids.
- Style: Icke/Draco/Dulce/Anunnaki, cold-blooded serpent aesthetic. (Superweapon Bloodline Coup + Draco heavy
  in Phases 7–8.)

---

## PHASE 7 — Superweapons (one per faction; tech-gated building, long charge, targeting reticle)

Build a reusable superweapon framework: a `req: 'tech'` structure with a long recharge timer and a
click-to-target reticle, then the per-faction effect:

- **Flat Earthers — Rocket Launch Pad:** Soviet-missile-truck-style — a heavy rocket strike (big single
  blast + splash) on a target point.
- **Resistance — Loitering-Munition Barrage:** a swarm of Shahed-style drones rains onto a target zone
  (cheaper/weaker than the others = on-brand).
- **Globalists — Orbital Kinetic Strike:** precise "rods from god" — fast, high single-point damage.
- **Deep State — Total Blackout (EMP):** NON-damaging; disables enemy power/defenses/production in a zone
  for a duration.
- **Hollow Earthers — "The Big One" (seismic quake):** heavy building damage across a target zone.
- **Greys / Aliens — Pyramid Death Ray:** a Pyramid structure fires a sustained death-ray beam at a target.
- **Reptilians — Bloodline Coup:** target a zone; enemy units in it are mind-controlled to your side for a
  LONG DURATION, then revert to the enemy when it expires (NOT permanent).

---

## PHASE 8 — Apex "AC-130-tier" heavies (ALL gated behind the research/tech lab, `req: 'tech'`)

Model on the existing `gunship` (AC-130) as the power/cost tier. One per faction:

- **Flat Earthers — The Leveler:** a diesel land-DREADNOUGHT (ground). Multi-turret, rakes several targets
  at once (reuse the gunship's `multiTarget`/broadside logic on the ground) AND carries **light anti-air**.
- **Hollow Earthers — Iron Mole:** a mechanical Jules-Verne borer that travels under the map and erupts inside
  the enemy base (uses the Phase-4 emergence siege). Also add the **Vril Disc / "Haunebu"** as Hollow's
  advanced-tier air unit (Vril beam; brass dieselpunk — visually distinct from the chrome Grey saucer).
- **Greys — War Saucer / Mothership:** a heavy capital saucer.
- **Reptilians — Draco:** a winged Draconian overlord kaiju.
- **Resistance — Scrap Super-Technical / Cruise-Missile Truck:** janky, cheap-for-its-power apex (also fills
  their empty `advanced` tier).

---

## Working order & verification

1. Phase 1 first (everything else leans on detection/stealth and the shared building kinds).
2. Then Phases 2–6 (per-faction content), then 7 (superweapons), then 8 (heavies).
3. After each phase: load the game via `serve.js`, train/build the new content, step with `frame()`,
   and screenshot through the 8378 receiver to confirm it trains, renders, and its verb actually works.
4. Keep balance numbers in the pre-`PACE` scale of neighbouring entries; tune, don't guess wildly.
5. Prefer data-driven additions in `data.js`; only touch `game.js`/`art.js` for genuinely new verbs and shapes.
