# simple-rts — session handoff / continue prompt

Paste this into a new session to pick up the art/design overhaul.

---

You're continuing a large art + gameplay overhaul of **simple-rts**, a
vanilla-JS isometric RTS at `C:\Users\Owner\Desktop\simple-rts`. A
conspiracy-theory-themed RA2-like: 7 factions (Flat Earthers, Resistance,
Globalists, Deep State, Hollow Earthers, Greys, Reptilians).

## Files
- `data.js` — all stats, faction rosters, unit/building tables. Balance + new content go here.
- `art.js` — rendering (an IIFE exposing `window.Art`). Registries: `D` = top-down
  sprites (aircraft), `I` = iso unit sprites (ground vehicles/infantry), `B` = buildings,
  `T` = live vehicle turrets. Helpers: `isoHull3D`, `isoVehicle`, `isoTrooper`, `isoBox`,
  `billboard`, `drum3d`, `blinker`, `rr`, `shade`, `wheels`, `treads`, `rotor`.
- `game.js` — the sim (movement, combat, orders, fog, build, draw loop).
- `iso.js` — projection (`isoX/isoY`, `isoAngle`, `isoShear`, `FLY_H`).
- `serve.js` — static server + a `POST /shot?name=X` receiver that writes `.shots/X.jpg`.
- `UNITS_OVERVIEW.md` — roster reference (now somewhat stale; regenerate if needed).

## How to verify changes (important)
The Browser pane throttles requestAnimationFrame, so:
1. Start the server: it's already run with `node serve.js 8377`; open `http://localhost:8377/`
   in the in-app Browser pane (`preview_start {url}`), NOT a dev-server name.
2. Step the sim from `javascript_tool`: `let now=performance.now(); for(let i=0;i<N;i++){now+=33;frame(now);}`
   (timestamps must strictly increase; `frame(now)` also calls `draw()`).
3. Screenshot: `const url=document.getElementById('game').toDataURL('image/jpeg',0.9);
   await fetch('/shot?name=foo',{method:'POST',body:url});` then Read `.shots/foo.jpg`.
   (`computer` screenshots time out; the first eval right after navigate often times out —
   just retry.) Wrap fetches with an AbortController timeout.
4. Camera: `cam.x/cam.y` are ISO SCREEN space. Center on world (wx,wy):
   `cam.x=isoX(wx,wy)-canvas.width/cam.zoom/2; cam.y=isoY(wx,wy)-canvas.height/cam.zoom/2; clampCam();`
   (`cam.zoom` clamps to max 2; for close art inspection render `Art.drawIso`/`Art.building`
   to an offscreen canvas at big scale instead). In-pane canvas is 600x400.
5. Console-scoped globals: `selectedSize/selectedOpponents/selectedSetting` then `startGame('glob')`;
   `makeUnit(owner,type,x,y)` returns the unit; attack order = `u.order={type:'attack',targetId:foe.id}`;
   `makeBuilding(owner,type,x,y)` (sets done:true). Building art in an offscreen canvas needs the
   iso shear: `g.transform(1,0.5,-1,0.5,0,0)` before calling `Art.building(...)`.
6. Always `node --check art.js data.js game.js` before loading, and `read_console_messages onlyErrors:true` after.

## Rendering conventions established
- **Ground vehicles**: `I.<type>` via `isoVehicle(...,{poly|tiers, under, detail, above})`.
  `isoHull3D` uses the TRUE iso projection (rotate by world facing + shear) so the nose points
  along travel and side walls are extruded (real 3D volume). `tiers:[{poly,h,body,detail}]` stacks
  boxes (e.g. car body + raised cabin).
- **Vehicle turrets**: register `T.<type>` — drawn live over the cached hull each frame, aiming at
  `u.turret` (a slewed angle) so the gun tracks independently. The sim maintains `u.turret` for any
  `Art.hasIsoTurret(type)` unit. Use `ctx.transform(1,0.5,-1,0.5,0,0)` then `rotate(angle)` inside T fns.
- **Aircraft**: `D.<type>` top-down, drawn nose at +x. `drawUnitIso` rotates them by `isoAngle(qFacing)`
  with NO vertical squash (a squash skews the heading — that was the "flying sideways" bug). Per-unit
  `flyH` (altitude tier) and `drawScale` in data.
- **Superweapons**: one `B.superweapon` branching on `o.superKind` (rocket/barrage/orbital/emp/quake/
  ray/coup); launch animation via `o.fireP` (-1 idle, else 0..1), set from `b.fireT` in `fireSuperweapon`.
- **Airpads**: `B.airpad` branches on `o.faction` (each looks like its name).
- **Walls**: `B.wall` uses `o.conn` (cardinal-neighbour bitmask from `wallConn` in game.js) to draw a
  connected rampart (posts + panels). Drag-placement via `commitWallLine`.
- Facing is quantized to 32 buckets (`qf`), gait to 8.

## Custom mechanics added (reuse these patterns)
- `scatter` (lob weapons) — spreads each shot around the aim (Firework Battery).
- `debuffAura {r,weaken}` + `convert {r,every}` — Megaphone Prophet (enemies fire weaker via
  `weakenedUntil`; enemy infantry desert). In `updateUnit` aura block; multiplier in `fireAt`.
- `aaAura {r,dps}` — Barrage Balloon damages enemy aircraft in range (updateUnit).
- `kamikaze {dmg,splash,bldgBonus}` — Shahed detonates on reaching its target (`tryAttack`;
  `canTarget` allows a zero-gun munition).
- `armor` (0..1 damage reduction), `bldgBonus`, `vehBonus` already existed.

## DONE (committed on main)
3D vehicle hull system + all ground vehicles; natural forward-only driving w/ turn rate; independent
turrets; 32-bucket facing; aircraft orientation fix + per-unit altitude/scale; Black Helicopter +
AC-130 reworks; Globalist air wing (removed B-1/B-2, added A-10 Warthog + MQ-9 Reaper); 7 superweapon
silos w/ launch animations; per-faction airpads; RA2 drag walls + connected wall art; IED rework
(infantry-planted, ONE per unit's life, Flat/Resistance/Hollow only); roster cuts (Hollow: Cave Bat,
Gyrocopter, Tunnel Sapper, Dowser, Pterodactyl; Greys+Reptilians: Hybrid Infiltrator); Globalist
Satellite Uplink building (full-map vision) replacing the Surveillance Van; Technical rework.
Full faction redesigns done: **Globalists**, **Flat Earth** (Killdozer, Firework Battery, Megaphone
Prophet, Pigeon Drone "birds aren't real", Barrage Balloon), **Resistance** (MANPAD, Shahed,
Chemtrail Biplane).

## TODO — remaining faction redesigns
All four DONE (committed on main):
- **Deep State** — cloak-when-stationary faction identity (`cloakStill`: mib/blackrig/blackvan cloak
  when idle, drop it on move/fire, doubled ambush first-strike). New Redacted ambush tank, Disinfo Van
  (seeds phantom signatures via `spawns:{type:'phantom'}`), TR-3B Black Triangle stealth aircraft.
- **Greys** — anti-grav (ground craft hover, `hover` bob). Plasma Mortar → Gravity-Well Projector
  (new `singularity` zone: pulls ground units in, then collapse blast). Bio Bomber → Abductor Saucer
  (`weapon:'abduct'` tractor-lift removes a ground unit after a channel; heavies over `abductMax`
  immune; `u.abducted` vanishes with no wreck). Reptilians KEEP mortarcrawler/biobomber (divergence).
- **Reptilians** — Basilisk Crawler → Basilisk (rewrote I.basilisk as a multi-segment undulating
  serpent w/ gaze cone; bigger/tougher, keeps petrify). Broodmother → fragile with a bound brood
  (`brood:{count,regen}` + `u.broodOf`: hatchlings shadow her, focus her target, regrow, expire on her
  death). Old `spawns` timer mechanic is still used by the Disinfo Van.
- **Hollow Earth** — filled the empty `air` list with Haunebu (bell-domed Vril saucer, targets both)
  and Feathered Serpent (Quetzalcoatl, spray + fire zone). Kept the tech-gated Vril Disc.

New reusable mechanics added this pass (all in game.js): `cloakStill`/`u.cloaked` dynamic cloak +
`u.movedT` tracking in moveToward; `singularity` zone (pull + delayed collapse) via extended
groundEffect fields (pull/dmg/blastAt); `abduct` weapon kind; `brood`/`broodOf` bound-swarm; `hover`
draw bob. Verified per-faction via offscreen contact sheets + scripted mechanic tests + 20s live sims.

## Working style the user likes
Implement each faction fully (art + mechanics), verify in-engine with a screenshot contact sheet,
commit per faction with a descriptive message, then briefly checkpoint. Commit-message trailer:
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Keep aircraft "looking like their name" and
correctly oriented. Ask before big scope forks; otherwise keep rolling ("go ahead / continue").
