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
| `data.js` | All game data: constants, terrain, factions, unit/building stats. Balance changes go here. |
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

- RA2-style sidebar construction: pay up front, build timer, place within your power grid's radius
- Power system — low power halves production, disables towers, and knocks out your radar
- Fog of war, terrain (lakes and rock formations), and a full air game with dedicated anti-air
- Artillery with minimum range, specialist infantry, faction-unique vehicles and aircraft
- EVA-style speech announcer and synthesized sound effects (mute with M)
- Enemy AI that plays a random faction from another family, with its own build order, army composition, defense, and attack waves
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
