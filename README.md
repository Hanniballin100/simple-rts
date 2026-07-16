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
| `data.js` | All game data: constants, map sizes, terrain types, factions, unit/building stats. Balance changes go here. |
| `mapgen.js` | Random map generator: start positions, mineral fields, terrain features. |
| `art.js` | Unit & building drawings (top-down animated vector) + particle effects. |
| `game.js` | Engine: state, orders, combat, AI, input, sidebar UI, rendering. |
| `mockup.html/js` | Standalone art style demo. |

## Factions

Seven factions in four families, each with its own roster, passive trait, and signature power:

| Family | Faction | Passive | Signature |
|---|---|---|---|
| Flat Earth | 🥞 Flat Earthers | Horizon Is a Lie — enemy air always on radar | Documentary Drops — enemies periodically defect |
| Flat Earth | 📡 The Resistance | Sleeper Cells — hidden map vision | Smuggling Routes — interceptable supply trucks |
| Globalists | 🌐 Globalists | Compound Interest — your bank earns 2%/10s | Weather Modification — castable slow zone |
| Globalists | 🕶️ The Deep State | Deep Cover Recruitment — moles from the enemy roster | Gaslight — phantom signatures scramble defenses |
| Hollow Earth | 🕳️ Hollow Earthers | Seismic Sense — enemy ground always on radar | Tunnel Network — travel between your grid nodes |
| Aliens | 👽 The Greys | Superior Metallurgy — immune to anti-building bonuses | Cloning Vats — copy any of your units |
| Aliens | 🦎 The Reptilians | Skin Suit — infantry pass as friendly until they strike | Reveal Infiltrator — one enemy worker was always yours |

## Features

- Random map generator — every game is a fresh layout with a coherent water plan (coastline, winding river with fords, big lakes, or landlocked), rocky ridges, mesas, forests, and mineral fields at every base plus contested expansions
- Four map sizes (Small to Huge — up to 6000×4200) and up to 5 AI opponents in a free-for-all — every AI plays its own faction and fights everyone, including each other
- Neutral structures dot the map: garrison infantry in houses (4 slots), apartment blocks (6), or barns (3) and they fight for you (evacuate any time); hold an Oil Derrick to earn bonus income
- Map settings — Urban (dense paved districts of apartments and houses, sparse woods), Town (villages around plazas), or Country (scattered farmsteads with crop fields, heavy forest, extra oil) — pick one or let the generator roll
- Terrain matters: water and rock block ground movement, forests slow units pushing through, and nothing can be built on any of them
- RA2-style sidebar construction: pay up front, build timer, place within your power grid's radius
- Power system — low power halves production, disables towers, and knocks out your radar
- Ground units path around buildings and terrain instead of walking through them
- RA2-style airfields — each holds 4 stationed jets that park on its pads and return to rearm; helicopters, drones, saucers, and blimps fly free
- Asymmetric economies — Flat Earth swarms cheap Believers, Hollow Earth Diggers haul oversized loads, the Globalist factions field a few armed autonomous Mining Rigs, and the alien factions have no miners at all: their HQ and Zero-Point Cores generate minerals
- Faction-flavored buildings — the same construction slot costs and delivers differently per faction: Diesel Shacks are cheap and weak, Fusion Plants pricey powerhouses, Hollow Earth structures dug-in and tough
- Fog of war and a full air game with dedicated anti-air
- Artillery with minimum range, specialist infantry, faction-unique vehicles and aircraft
- EVA-style speech announcer and synthesized sound effects (mute with M)
- Enemy AIs play random factions from other families, each with its own build order, army composition, defense, and attack waves
- Click any enemy unit or building for a full intel card

## Controls

| Input | Action |
|---|---|
| Drag / click | Select units / buildings (click an enemy to inspect it) |
| Right-click | Move, harvest, attack, set rally point |
| A + click | Attack-move |
| P / B / T / G / F / D | Build power / barracks / tower / AA tower / factory / airpad |
| Ctrl+1–5, 1–5 | Assign / recall control groups |
| Mouse wheel / edge / middle-drag / arrows | Camera |
| H | Jump to base |
| M | Mute |
