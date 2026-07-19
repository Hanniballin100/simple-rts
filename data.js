// ============================================================
// data.js — all game data: constants, terrain, factions, units,
// buildings. Balance tweaks and new content go HERE.
// Loaded before art.js and game.js (plain globals, no modules).
// ============================================================

let WORLD_W = 2000;          // set by generateMap() from the chosen map size
let WORLD_H = 1400;
const BUILD_RADIUS = 420;    // structures must sit near the HQ or a power plant
const AI_GRACE_PERIOD = 180; // seconds before the AI's first attack wave
const PAD_CAP = 4;           // stationed aircraft per airfield, RA2-style
// where the four aircraft park on an airpad (offsets from its center)
const PAD_SLOT_POS = [[-26, -15], [26, -15], [-26, 19], [26, 19]];
const HARVEST_AMOUNT = 6;    // minerals per trip
const HARVEST_TIME = 3.5;    // seconds spent mining
const FOG_TILE = 50;
const UNIT_DRAW_SCALE = 1.2; // visual-only: units render this much bigger than their collision radius

const PLAYER = 0;
const ENEMY = 1;    // first AI opponent; extra AIs are owners 2, 3, ...
const NEUTRAL = -1; // map-owned civilian structures (garrison infantry to claim)
const COLORS = {
  0: '#4da3ff', 1: '#ff5f5f', 2: '#ffa938',
  3: '#b06fff', 4: '#ffe14d', 5: '#ff7ad9',
  [NEUTRAL]: '#a8a290',
};
const COLORS_DARK = {
  0: '#2b6cb0', 1: '#b03434', 2: '#b06d1c',
  3: '#6f3fb0', 4: '#b09a26', 5: '#b0408c',
  [NEUTRAL]: '#6e6a5e',
};

// map sizes: world dimensions (multiples of FOG_TILE) + how many total
// players (you + AIs) fit on the start ring
const MAP_SIZES = {
  small:  { name: 'Small',  w: 2600, h: 1800, maxPlayers: 2 },
  medium: { name: 'Medium', w: 3600, h: 2400, maxPlayers: 4 },
  large:  { name: 'Large',  w: 4800, h: 3200, maxPlayers: 5 },
  huge:   { name: 'Huge',   w: 6000, h: 4200, maxPlayers: 6 },
};

// garrison combat: occupied civilian structures fire at this range, with the
// occupants' summed damage scaled down a touch
const GARRISON_RANGE = 200;
const GARRISON_COOLDOWN = 0.75;
const GARRISON_DMG_SCALE = 0.7;

// terrain comes in three flavors:
//   water/rock — impassable to ground units, air flies over
//   forest     — passable but slows ground units; nothing can be built on any of them
const TERRAIN_TYPES = {
  water:  { passes: false },
  rock:   { passes: false },
  forest: { passes: true, slow: 0.65 },
};

// filled in by generateMap(); each entry {x, y, r, type, seed}
let TERRAIN = [];

// tracer/impact styling per faction
const WEAPON_STYLE = {
  flat: 'bullet', resistance: 'bullet', glob: 'laser', deep: 'laser',
  hollow: 'ember', grey: 'plasma', reptilian: 'plasma',
};

// which building-art family each faction uses
const FAMILY_STYLE = { flat: 'flat', resistance: 'flat', glob: 'glob', deep: 'glob', hollow: 'hollow', grey: 'alien', reptilian: 'alien' };

const STRUCT_HOTKEYS = { p: 'powerplant', b: 'barracks', t: 'TOWER', g: 'AATOWER', f: 'factory', d: 'airpad', r: 'tech' };

// ---------- factions ----------

const FACTIONS = {
  flat: {
    name: 'Flat Earthers', family: 'EARTHERS', emoji: '🥞',
    desc: 'Defend the ice wall. Cheap Militia swarms, the building-ramming Truck of Truth, and the mighty Balloon of Truth. Flimsy bargain buildings, kept fueled by a convoy of lightly armed Rigs of Truth. Deeply suspicious of the sky — the Balloon Dock unlocks only after the Institute of Truth proves it is fake.',
    economy: { workers: 5 },
    worker: 'truthrig', infantry: 'militia', aa: 'laserguy', vehicle: 'truck',
    air: ['wballoon', 'balloon'], tower: 'watchtower', aaTower: 'laserpointer',
    extras: ['preacher', 'catapult', 'cropduster', 'engineer'], advanced: [],
    structs: ['wall', 'gate', 'mine'],
    powers: {
      passive: { name: 'Horizon Is a Lie', desc: 'Enemy aircraft are always visible on your radar.' },
      sig: { name: 'Documentary Drops', desc: 'Every 3 minutes a random enemy unit sees the truth and joins you.', kind: 'auto', period: 180 },
    },
    buildingNames: {
      hq: 'Bunker of Truth', powerplant: 'Diesel Shack', barracks: 'Recruitment Tent',
      factory: 'Truck Garage', airpad: 'Balloon Dock', tech: 'Institute of Truth',
      watchtower: 'Watchtower', laserpointer: 'Giant Laser Pointer',
      wall: 'Ice Wall Segment', gate: 'Checkpoint Gate', mine: 'IED',
    },
  },
  resistance: {
    name: 'The Resistance', family: 'RESISTANCE', emoji: '📡',
    desc: 'Off-grid guerrillas. Dirt-cheap Partisans and fast gun-truck Technicals hit before the lamestream reacts. The cheapest structures anywhere — none of them built to last. Fast scrap-built Salvage Rigs keep the minerals moving.',
    economy: { workers: 4 },
    worker: 'salvagerig', infantry: 'partisan', aa: 'laserguy', vehicle: 'technical',
    air: ['wballoon', 'balloon'], tower: 'watchtower', aaTower: 'aanest',
    extras: ['preacher', 'catapult', 'cropduster', 'engineer'], advanced: [],
    structs: ['wall', 'gate', 'mine'],
    powers: {
      passive: { name: 'Sleeper Cells', desc: '3 hidden observation camps watch the map from the start.' },
      sig: { name: 'Smuggling Routes', desc: 'Every 2 minutes a truck hauls 150 minerals to your HQ — unless it gets intercepted.', kind: 'auto', period: 120 },
    },
    buildingNames: {
      hq: 'Pirate Radio Bunker', powerplant: 'Diesel Shack', barracks: 'Safehouse',
      factory: 'Chop Shop', airpad: 'Balloon Dock', tech: 'Numbers Station',
      watchtower: 'Watchtower', aanest: 'AA Gun Nest',
      sleepercell: 'Sleeper Cell',
      wall: 'Scrap Barricade', gate: 'Checkpoint Gate', mine: 'IED',
    },
  },
  glob: {
    name: 'Globalists', family: 'GLOBALISTS', emoji: '🌐',
    desc: 'Order through orbit. Elite Agents, Black SUVs, and a Motor Pool that turns out Black Drones and Helicopters. The Air Force Base fields B-1 Lancers — and once the Black Site Lab opens, AC-130 Gunships and B-2 Spirits. Premium infrastructure, and armed autonomous Mining Rigs instead of field hands.',
    economy: { workers: 3 },
    worker: 'harvester', infantry: 'agent', aa: 'jammer', vehicle: 'suv',
    air: ['drone', 'heli'], tower: 'tower5g', aaTower: 'samsite',
    extras: ['riot', 'haarp', 'b1', 'blackvan', 'engineer', 'mechanic'], advanced: ['gunship', 'b2'],
    structs: ['wall', 'gate', 'mine', 'repairpad'],
    powers: {
      passive: { name: 'Compound Interest', desc: 'Your bank earns 2% interest every 10 seconds.' },
      sig: { name: 'Weather Modification', desc: 'Target a zone: enemy ground units in it are slowed 40% for 15s.', kind: 'zone', cd: 90 },
    },
    buildingNames: {
      hq: 'World HQ', powerplant: 'Fusion Plant', barracks: 'Command Center',
      factory: 'Motor Pool', airpad: 'Air Force Base', tech: 'Black Site Lab',
      tower5g: '5G Tower', samsite: 'Patriot Battery', hangar: 'Spectre Hangar',
      wall: 'Security Wall', gate: 'Security Gate', mine: 'Claymore', repairpad: 'Service Bay',
    },
  },
  deep: {
    name: 'The Deep State', family: 'GLOBALISTS', emoji: '🕶️',
    desc: 'It was never elected and never leaves. Men in Black hit hard; Surveillance Vans see everything, from very far away. Well-funded facilities, with sharp-eyed Unmarked Rigs doing the dirty work.',
    economy: { workers: 3 },
    worker: 'blackrig', infantry: 'mib', aa: 'jammer', vehicle: 'blackvan',
    air: ['drone', 'heli'], tower: 'tower5g', aaTower: 'samsite',
    extras: ['riot', 'haarp', 'b1', 'engineer', 'mechanic'], advanced: ['gunship', 'b2'],
    structs: ['wall', 'gate', 'mine', 'repairpad'],
    powers: {
      passive: { name: 'Deep Cover Recruitment', desc: 'Every 2 minutes a mole from the ENEMY roster reports to your barracks.' },
      sig: { name: 'Gaslight', desc: 'Phantom signatures appear near the enemy base and their defenses scramble to fight nothing.', kind: 'instant', cd: 120 },
    },
    buildingNames: {
      hq: 'Undisclosed Location', powerplant: 'Fusion Plant', barracks: 'Field Office',
      factory: 'Motor Pool', airpad: 'Undisclosed Airstrip', tech: 'Continuity Bunker',
      tower5g: '5G Tower', samsite: 'Patriot Battery', hangar: 'Unmarked Hangar',
      wall: 'Security Wall', gate: 'Security Gate', mine: 'Claymore', repairpad: 'Motor Pool Annex',
    },
  },
  hollow: {
    name: 'Hollow Earthers', family: 'EARTHERS', emoji: '🕳️',
    desc: 'The real world is below. Tough Mole Militia, Drill Tanks that eat buildings, and Cave Bat swarms. Dug-in structures are the sturdiest around, Geothermal Vents make the cheapest power, and hulking Bore Rigs haul oversized loads.',
    economy: { workers: 4 },
    worker: 'borerig', infantry: 'moleman', aa: 'slinger', vehicle: 'drill',
    air: ['cavebat', 'gyro'], tower: 'stalagmite', aaTower: 'geyser',
    extras: ['sapper', 'magma', 'dowser', 'engineer'], advanced: ['ptero'],
    structs: ['wall', 'gate', 'mine'],
    powers: {
      passive: { name: 'Seismic Sense', desc: 'Enemy ground units are always visible on your radar.' },
      sig: { name: 'Tunnel Network', desc: 'Right-click your HQ, a power plant, or a Tunnel Entrance: selected ground units travel there underground.', kind: 'info' },
    },
    buildingNames: {
      hq: 'Inner Sanctum', powerplant: 'Geothermal Vent', barracks: 'Burrow',
      factory: 'Drill Works', airpad: 'Cavern Roost', tech: 'Core Forge',
      stalagmite: 'Stalagmite Spitter', geyser: 'Geyser Cannon',
      wall: 'Stone Rampart', gate: 'Stone Gate', mine: 'Sinkhole Trap',
    },
  },
  grey: {
    name: 'The Greys', family: 'ALIENS', emoji: '👽',
    desc: 'You will be probed. Abductors, towering Tripod Striders, and the Flying Saucer — supreme in the air and cruel to the ground. No miners: Zero-Point Cores conjure minerals from the vacuum itself.',
    economy: { workers: 0, start: 150 },
    worker: null, infantry: 'greytrooper', aa: 'beamer', vehicle: 'tripod',
    air: ['orb'], tower: 'pylon', aaTower: 'tractor',
    extras: ['hybrid', 'mortarcrawler', 'biobomber', 'engineer', 'menderorb'], advanced: ['saucer'],
    structs: ['wall', 'gate', 'mine', 'repairpad'],
    powers: {
      passive: { name: 'Superior Metallurgy', desc: 'Your buildings ignore bonus anti-building damage (sappers, rams, artillery).' },
      sig: { name: 'Cloning Vats', desc: 'Target one of your units: an exact copy emerges from your barracks.', kind: 'unit', cd: 90 },
    },
    buildingNames: {
      hq: 'Mothership Anchor', powerplant: 'Zero-Point Core', barracks: 'Cloning Pod',
      factory: 'Assembler', airpad: 'Saucer Pad', tech: 'Hive Mind Nexus',
      pylon: 'Plasma Pylon', tractor: 'Tractor Beam',
      wall: 'Alloy Barrier', gate: 'Alloy Gate', mine: 'Plasma Mine', repairpad: 'Nanite Bay',
    },
  },
  reptilian: {
    name: 'The Reptilians', family: 'ALIENS', emoji: '🦎',
    desc: 'They walk among us — and bite. Melee Reptoid Warriors, the armored Basilisk Crawler, and fire-breathing Sky Drakes. No miners: the nest generates minerals — or steal an enemy worker and put it to work.',
    economy: { workers: 0, start: 150 },
    worker: null, infantry: 'raptoid', aa: 'beamer', vehicle: 'basilisk',
    air: ['orb'], tower: 'pylon', aaTower: 'tractor',
    extras: ['hybrid', 'mortarcrawler', 'biobomber', 'shapeshifter', 'menderorb'], advanced: ['drake'],
    structs: ['wall', 'gate', 'mine', 'repairpad'],
    powers: {
      passive: { name: 'Skin Suit', desc: 'Your infantry are not recognized as hostile until they attack.' },
      sig: { name: 'Reveal Infiltrator', desc: 'One enemy worker has always been yours. Click to convert it (once per game).', kind: 'once' },
    },
    buildingNames: {
      hq: 'Nest Citadel', powerplant: 'Zero-Point Core', barracks: 'Hatchery',
      factory: 'Assembler', airpad: 'Roost Spire', tech: 'Gene Vault',
      pylon: 'Plasma Pylon', tractor: 'Tractor Beam',
      wall: 'Alloy Barrier', gate: 'Alloy Gate', mine: 'Plasma Mine', repairpad: 'Regeneration Pit',
    },
  },
};

// ---------- units ----------
// targets: 'ground' | 'air' | 'both' (default 'ground' for anything armed)
// weapon: 'gun' (default) | 'lob' | 'bomb' | 'storm' | 'spray' | 'gunship'
// pad: RA2-style airfield craft — occupies one of its airpad's 4 slots,
//      parks there when idle, and burns maxAmmo ammo it reloads on the pad.
//      Air units WITHOUT pad (helicopters, blimps, saucers) fly free.
// plane: fixed-wing — keeps airspeed and a turn rate (turn, rad/s) instead of
//        hovering: strafing runs, loitering circles, bombing passes; the
//        gunship orbits its target (orbitR) firing broadsides, with a heavy
//        shell every shellEvery-th shot (shellDmg/shellSplash).
// req: building type that must be finished before the unit can be trained.

const UNIT_TYPES = {
  // workers — every faction's worker line is its own mining rig (the aliens
  // have none). carry: minerals hauled per trip; limit: hard per-player cap
  // (alive + queued). The flat-earth family's carry less but come lightly
  // armed; the Bore Rig is a slow armored hauler with a drill for a face.
  harvester:  { name: 'Mining Rig',   role: 'worker', builtAt: 'hq', hp: 200, speed: 55, dmg: 5, atkRange: 90, cooldown: 1,   sight: 200, cost: 110, r: 13, buildTime: 9,  carry: 14, shape: 'square', limit: 4 },
  blackrig:   { name: 'Unmarked Rig', role: 'worker', builtAt: 'hq', hp: 190, speed: 58, dmg: 6, atkRange: 95, cooldown: 1,   sight: 260, cost: 105, r: 13, buildTime: 9,  carry: 12, shape: 'square', limit: 4 },
  truthrig:   { name: 'Rig of Truth', role: 'worker', builtAt: 'hq', hp: 150, speed: 60, dmg: 4, atkRange: 85, cooldown: 0.9, sight: 190, cost: 90,  r: 12, buildTime: 8,  carry: 9,  shape: 'square', limit: 6 },
  salvagerig: { name: 'Salvage Rig',  role: 'worker', builtAt: 'hq', hp: 130, speed: 72, dmg: 4, atkRange: 90, cooldown: 0.9, sight: 200, cost: 80,  r: 12, buildTime: 7,  carry: 8,  shape: 'square', limit: 5 },
  borerig:    { name: 'Bore Rig',     role: 'worker', builtAt: 'hq', hp: 240, speed: 45, dmg: 8, atkRange: 24, cooldown: 1.1, sight: 170, cost: 120, r: 13, buildTime: 10, carry: 16, shape: 'square', limit: 5 },
  // basic infantry
  militia:     { name: 'Truther Militia', role: 'combat', builtAt: 'barracks', hp: 75,  speed: 80, dmg: 5,  atkRange: 100, cooldown: 0.75, sight: 210, cost: 45, r: 9,  buildTime: 5 },
  partisan:    { name: 'Partisan',        role: 'combat', builtAt: 'barracks', hp: 60,  speed: 92, dmg: 4,  atkRange: 95,  cooldown: 0.7,  sight: 210, cost: 35, r: 8,  buildTime: 4 },
  agent:       { name: 'Agent',           role: 'combat', builtAt: 'barracks', hp: 110, speed: 68, dmg: 8,  atkRange: 130, cooldown: 0.85, sight: 220, cost: 65, r: 10, buildTime: 6 },
  mib:         { name: 'Man in Black',    role: 'combat', builtAt: 'barracks', hp: 100, speed: 70, dmg: 11, atkRange: 140, cooldown: 0.9,  sight: 240, cost: 80, r: 10, buildTime: 7 },
  moleman:     { name: 'Mole Militia',    role: 'combat', builtAt: 'barracks', hp: 85,  speed: 75, dmg: 5,  atkRange: 90,  cooldown: 0.7,  sight: 190, cost: 50, r: 9,  buildTime: 5 },
  greytrooper: { name: 'Grey Abductor',   role: 'combat', builtAt: 'barracks', hp: 70,  speed: 78, dmg: 7,  atkRange: 120, cooldown: 0.8,  sight: 230, cost: 55, r: 9,  buildTime: 5 },
  raptoid:     { name: 'Reptoid Warrior', role: 'combat', builtAt: 'barracks', hp: 130, speed: 85, dmg: 10, atkRange: 30,  cooldown: 0.8,  sight: 210, cost: 70, r: 10, buildTime: 6 },
  // anti-air infantry: full damage vs air, dmgVsGround when shooting ground
  laserguy: { name: 'Laser Pointer Guy', role: 'combat', builtAt: 'barracks', hp: 65, speed: 75, dmg: 9,  dmgVsGround: 4, atkRange: 175, cooldown: 0.6,  sight: 250, cost: 60, r: 9, buildTime: 6, targets: 'both' },
  jammer:   { name: 'Signal Jammer',     role: 'combat', builtAt: 'barracks', hp: 80, speed: 70, dmg: 11, dmgVsGround: 5, atkRange: 185, cooldown: 0.7,  sight: 260, cost: 70, r: 9, buildTime: 6, targets: 'both', jams: true },
  slinger:  { name: 'Crystal Slinger',   role: 'combat', builtAt: 'barracks', hp: 70, speed: 72, dmg: 10, dmgVsGround: 4, atkRange: 180, cooldown: 0.65, sight: 250, cost: 65, r: 9, buildTime: 6, targets: 'both' },
  beamer:   { name: 'Beam Walker',       role: 'combat', builtAt: 'barracks', hp: 75, speed: 74, dmg: 10, dmgVsGround: 5, atkRange: 180, cooldown: 0.65, sight: 260, cost: 70, r: 9, buildTime: 6, targets: 'both' },
  // cross-faction support: engineers capture enemy structures (consumed on
  // use); the dowser is Hollow's cheap walking detector; repair units mend
  // nearby allied vehicles and aircraft. All fragile, all unarmed.
  engineer:     { name: 'Engineer',           role: 'combat', builtAt: 'barracks', hp: 60,  speed: 70,  dmg: 0, atkRange: 0, cooldown: 1, sight: 200, cost: 90,  r: 9,  buildTime: 7, captures: true },
  shapeshifter: { name: 'Shapeshifter',       role: 'combat', builtAt: 'barracks', hp: 70,  speed: 80,  dmg: 0, atkRange: 0, cooldown: 1, sight: 220, cost: 110, r: 9,  buildTime: 8, captures: true },
  dowser:       { name: 'Seismograph Dowser', role: 'scout',  builtAt: 'barracks', hp: 55,  speed: 78,  dmg: 0, atkRange: 0, cooldown: 1, sight: 300, cost: 45,  r: 8,  buildTime: 5, detector: true },
  mechanic:     { name: 'Repair Truck',       role: 'combat', builtAt: 'factory',  hp: 180, speed: 82,  dmg: 0, atkRange: 0, cooldown: 1, sight: 200, cost: 100, r: 12, buildTime: 8, repair: 9, shape: 'square' },
  menderorb:    { name: 'Mender Orb',         role: 'combat', builtAt: 'factory',  hp: 90,  speed: 100, dmg: 0, atkRange: 0, cooldown: 1, sight: 240, cost: 110, r: 9,  buildTime: 8, repair: 8, flying: true, shape: 'blimp' },
  // specialist infantry
  preacher: { name: 'Street Preacher',    role: 'combat', builtAt: 'barracks', hp: 70,  speed: 70, dmg: 6,  atkRange: 90,  cooldown: 1,   sight: 200, cost: 55, r: 9,  buildTime: 6, bldgBonus: 3 },
  riot:     { name: 'Riot Trooper',       role: 'combat', builtAt: 'barracks', hp: 180, speed: 60, dmg: 10, atkRange: 26,  cooldown: 0.8, sight: 190, cost: 75, r: 10, buildTime: 7, armor: 0.35 }, // shield wall: melee baton
  sapper:   { name: 'Tunnel Sapper',      role: 'combat', builtAt: 'barracks', hp: 90,  speed: 80, dmg: 8,  atkRange: 25,  cooldown: 1,   sight: 190, cost: 65, r: 9,  buildTime: 6, bldgBonus: 4 },
  hybrid:   { name: 'Hybrid Infiltrator', role: 'combat', builtAt: 'barracks', hp: 55,  speed: 95, dmg: 14, atkRange: 110, cooldown: 0.7, sight: 240, cost: 70, r: 9,  buildTime: 6 },
  // vehicles
  truck:     { name: 'Truck of Truth',   role: 'combat', builtAt: 'factory', hp: 280, speed: 58,  dmg: 22, atkRange: 30,  cooldown: 1.1,  sight: 200, cost: 120, r: 13, buildTime: 9,  bldgBonus: 2,   shape: 'square' },
  technical: { name: 'Technical',        role: 'combat', builtAt: 'factory', hp: 170, speed: 105, dmg: 12, atkRange: 105, cooldown: 0.55, sight: 220, cost: 90,  r: 12, buildTime: 7,  shape: 'square' },
  suv:       { name: 'Black SUV',        role: 'combat', builtAt: 'factory', hp: 200, speed: 95,  dmg: 13, atkRange: 110, cooldown: 0.6,  sight: 220, cost: 110, r: 12, buildTime: 8,  shape: 'square' },
  blackvan:  { name: 'Surveillance Van', role: 'combat', builtAt: 'factory', hp: 220, speed: 80,  dmg: 12, atkRange: 150, cooldown: 0.7,  sight: 300, cost: 130, r: 12, buildTime: 9,  shape: 'square', detector: true },
  drill:     { name: 'Drill Tank',       role: 'combat', builtAt: 'factory', hp: 320, speed: 55,  dmg: 24, atkRange: 28,  cooldown: 1.2,  sight: 180, cost: 130, r: 13, buildTime: 10, bldgBonus: 2,   shape: 'square' },
  tripod:    { name: 'Tripod Strider',   role: 'combat', builtAt: 'factory', hp: 240, speed: 70,  dmg: 18, atkRange: 140, cooldown: 1,    sight: 250, cost: 140, r: 13, buildTime: 10, shape: 'square', armor: 0.15 },
  basilisk:  { name: 'Basilisk Crawler', role: 'combat', builtAt: 'factory', hp: 350, speed: 60,  dmg: 22, atkRange: 34,  cooldown: 1.1,  sight: 200, cost: 150, r: 14, buildTime: 11, bldgBonus: 1.5, shape: 'square' },
  // artillery (minRange: can't fire when rushed; lobbed projectiles with splash)
  catapult:      { name: 'Flatbed Catapult', role: 'combat', builtAt: 'factory', hp: 140, speed: 45, dmg: 34, atkRange: 280, minRange: 100, cooldown: 3.2, sight: 300, cost: 160, r: 13, buildTime: 11, bldgBonus: 1.5, shape: 'square', weapon: 'lob', projectile: 'rock', splash: 36 },
  haarp:         { name: 'HAARP Truck',      role: 'combat', builtAt: 'factory', hp: 150, speed: 50, dmg: 15, atkRange: 300, minRange: 120, cooldown: 3.5, sight: 320, cost: 180, r: 13, buildTime: 12, shape: 'square', weapon: 'storm' },
  magma:         { name: 'Magma Mortar',     role: 'combat', builtAt: 'factory', hp: 150, speed: 48, dmg: 28, atkRange: 270, minRange: 100, cooldown: 3,   sight: 290, cost: 155, r: 13, buildTime: 11, bldgBonus: 1.3, shape: 'square', weapon: 'lob', projectile: 'magma', splash: 34, groundEffect: { kind: 'fire', r: 26, dur: 2.2, dps: 8 } },
  mortarcrawler: { name: 'Plasma Mortar',    role: 'combat', builtAt: 'factory', hp: 160, speed: 50, dmg: 32, atkRange: 290, minRange: 110, cooldown: 3.3, sight: 310, cost: 175, r: 13, buildTime: 12, shape: 'square', weapon: 'lob', projectile: 'plasma', splash: 40 },
  // air
  wballoon: { name: 'Weather Balloon',  role: 'scout',  builtAt: 'airpad', hp: 60,  speed: 90,  dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 360, cost: 40,  r: 9,  buildTime: 6,  flying: true, shape: 'blimp', detector: true },
  balloon:  { name: 'Balloon of Truth', role: 'combat', builtAt: 'airpad', hp: 420, speed: 40,  dmg: 40, atkRange: 36,  cooldown: 2.2,  sight: 240, cost: 200, r: 15, buildTime: 14, flying: true, bldgBonus: 1.5, shape: 'blimp', weapon: 'bomb', splash: 46 },
  // globalist rotorcraft roll out of the Motor Pool alongside the SUVs
  drone:    { name: 'Black Drone',      role: 'combat', builtAt: 'factory', hp: 55,  speed: 135, dmg: 8,  atkRange: 130, cooldown: 0.7,  sight: 280, cost: 85,  r: 8,  buildTime: 7,  flying: true, shape: 'tri' },
  heli:     { name: 'Black Helicopter', role: 'combat', builtAt: 'factory', hp: 150, speed: 110, dmg: 13, atkRange: 135, cooldown: 0.65, sight: 260, cost: 160, r: 11, buildTime: 11, flying: true, targets: 'both', shape: 'tri' },
  cavebat:  { name: 'Cave Bat Swarm',   role: 'combat', builtAt: 'airpad', hp: 45,  speed: 120, dmg: 4,  atkRange: 60,  cooldown: 0.5,  sight: 300, cost: 45,  r: 8,  buildTime: 5,  flying: true, shape: 'tri' },
  gyro:     { name: 'Gyrocopter',       role: 'combat', builtAt: 'airpad', hp: 130, speed: 100, dmg: 11, atkRange: 125, cooldown: 0.7,  sight: 260, cost: 150, r: 10, buildTime: 10, flying: true, targets: 'both', shape: 'tri' },
  orb:      { name: 'Scout Orb',        role: 'scout',  builtAt: 'airpad', hp: 50,  speed: 140, dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 380, cost: 40,  r: 8,  buildTime: 5,  flying: true, shape: 'blimp', detector: true },
  saucer:   { name: 'Flying Saucer',    role: 'combat', builtAt: 'airpad', hp: 180, speed: 115, dmg: 14, atkRange: 140, cooldown: 0.7,  sight: 300, cost: 190, r: 12, buildTime: 12, flying: true, targets: 'both', shape: 'saucer', req: 'tech' },
  drake:    { name: 'Sky Drake',        role: 'combat', builtAt: 'airpad', hp: 160, speed: 105, dmg: 16, atkRange: 90,  cooldown: 0.8,  sight: 260, cost: 170, r: 11, buildTime: 11, flying: true, shape: 'tri', pad: true, maxAmmo: 8, plane: true, turn: 2.8, req: 'tech' },
  cropduster: { name: 'Crop Duster',    role: 'combat', builtAt: 'airpad', hp: 110, speed: 145, dmg: 8,  atkRange: 70,  cooldown: 1,   sight: 280, cost: 130, r: 10, buildTime: 9,  flying: true, shape: 'tri', weapon: 'spray', groundEffect: { kind: 'toxin', r: 26, dur: 2, dps: 5 }, pad: true, maxAmmo: 6, plane: true, turn: 2.4 },
  ptero:      { name: 'Pterodactyl',    role: 'combat', builtAt: 'airpad', hp: 170, speed: 120, dmg: 17, atkRange: 60,  cooldown: 0.9, sight: 270, cost: 160, r: 11, buildTime: 11, flying: true, shape: 'tri', pad: true, maxAmmo: 8, plane: true, turn: 2.7, req: 'tech' },
  // the globalist air wing: a fast swing-wing strike jet, and two tech-gated
  // heavies — an orbiting AC-130 and the stealth-black flying wing
  b1:      { name: 'B-1 Lancer',    role: 'combat', builtAt: 'airpad', hp: 200, speed: 210, dmg: 16, atkRange: 160, cooldown: 0.55, sight: 300, cost: 190, r: 12, buildTime: 12, flying: true, targets: 'both', shape: 'plane', pad: true, maxAmmo: 8, plane: true, turn: 2.6 },
  b2:      { name: 'B-2 Spirit',    role: 'combat', builtAt: 'airpad', hp: 300, speed: 125, dmg: 90, atkRange: 44,  cooldown: 1.5,  sight: 300, cost: 360, r: 15, buildTime: 20, flying: true, shape: 'plane', pad: true, maxAmmo: 2, plane: true, turn: 1.5, weapon: 'bomb', splash: 64, bldgBonus: 1.6, req: 'tech' },
  // lumbering death circle: wide slow pylon turn, battery rakes up to
  // multiTarget enemies in range at once; flies from its own single-plane hangar
  gunship: { name: 'AC-130 Gunship', role: 'combat', builtAt: 'hangar', hp: 380, speed: 80, dmg: 11, atkRange: 230, cooldown: 0.22, sight: 320, cost: 420, r: 20, buildTime: 20, flying: true, shape: 'plane', pad: true, maxAmmo: 40, plane: true, turn: 1.3, weapon: 'gunship', orbitR: 195, shellEvery: 8, shellDmg: 45, shellSplash: 34, multiTarget: 3, req: 'tech' },
  biobomber:  { name: 'Bio Bomber',     role: 'combat', builtAt: 'airpad', hp: 200, speed: 90,  dmg: 26, atkRange: 50,  cooldown: 1.6, sight: 260, cost: 200, r: 13, buildTime: 13, flying: true, bldgBonus: 1.5, shape: 'blimp', weapon: 'bomb', splash: 40, groundEffect: { kind: 'toxin', r: 30, dur: 2.5, dps: 6 } },
  // faction-power units (never trainable)
  smuggler: { name: 'Smuggler Truck', role: 'scout', hp: 120, speed: 75, dmg: 0, atkRange: 0, cooldown: 1, sight: 180, cost: 0, r: 11, buildTime: 0, shape: 'square' },
  phantom:  { name: 'Unknown Contact', role: 'scout', hp: 20,  speed: 60, dmg: 0, atkRange: 0, cooldown: 1, sight: 40,  cost: 0, r: 9,  buildTime: 0 },
};

// ---------- buildings ----------
// tower weapon: 'gun' (default) | 'pulse' (AoE) | 'chain' (arcs) | 'beam' (lock + slow)

const BUILDING_TYPES = {
  hq:         { hp: 800, w: 96, h: 96, cost: 0,   buildTime: 0,  sight: 280, power: +60 },
  powerplant: { hp: 320, w: 58, h: 58, cost: 80,  buildTime: 10, sight: 160, power: +100, cap: 6 },
  barracks:   { hp: 450, w: 54, h: 54, cost: 100, buildTime: 12, sight: 200, power: -30,  cap: 3 },
  factory:    { hp: 500, w: 88, h: 68, cost: 150, buildTime: 16, sight: 200, power: -40,  cap: 2 },
  airpad:     { hp: 420, w: 96, h: 72, cost: 140, buildTime: 16, sight: 200, power: -40,  cap: 2, padCap: 4 },
  // dedicated heavy hangar: holds a single AC-130, gated behind the tech lab
  hangar:     { hp: 520, w: 124, h: 92, cost: 220, buildTime: 18, sight: 220, power: -50, cap: 2, padCap: 1, req: 'tech' },
  // research site: pricey and power-hungry, unlocks each faction's advanced
  // units (req: 'tech' on the unit); flat-earth family airpads need it too
  tech:       { hp: 480, w: 60, h: 60, cost: 260, buildTime: 20, sight: 220, power: -80, cap: 1 },
  // ground-defense towers
  watchtower: { hp: 300, w: 40, h: 40, cost: 75,  buildTime: 10, sight: 240, power: -30, cap: 5, dmg: 10, atkRange: 175, cooldown: 0.7,  targets: 'ground' },
  tower5g:    { hp: 340, w: 40, h: 40, cost: 100, buildTime: 12, sight: 280, power: -30, cap: 5, dmg: 6,  atkRange: 215, cooldown: 0.9,  targets: 'ground', weapon: 'pulse' },
  stalagmite: { hp: 320, w: 40, h: 40, cost: 80,  buildTime: 10, sight: 240, power: -30, cap: 5, dmg: 11, atkRange: 180, cooldown: 0.7,  targets: 'ground' },
  // ownWeaponArt: the drawing already shows its weapon (crystal, lens, pods,
  // dish) — the engine must not stamp the generic swivel turret over it
  pylon:      { hp: 340, w: 40, h: 40, cost: 105, buildTime: 12, sight: 260, power: -30, cap: 5, dmg: 16, atkRange: 200, cooldown: 0.85, targets: 'ground', weapon: 'chain', ownWeaponArt: true },
  // anti-air towers
  laserpointer: { hp: 280, w: 38, h: 38, cost: 90,  buildTime: 10, sight: 280, power: -30, cap: 5, dmg: 14,  atkRange: 230, cooldown: 0.6,  targets: 'air', ownWeaponArt: true },
  aanest:       { hp: 260, w: 36, h: 36, cost: 70,  buildTime: 8,  sight: 270, power: -20, cap: 5, dmg: 3.5, atkRange: 220, cooldown: 0.14, targets: 'air' }, // rapid tracer stream
  samsite:      { hp: 320, w: 38, h: 38, cost: 110, buildTime: 12, sight: 300, power: -30, cap: 5, dmg: 20,  atkRange: 270, cooldown: 1.6,  targets: 'air', weapon: 'missile', ownWeaponArt: true },
  geyser:       { hp: 300, w: 38, h: 38, cost: 95,  buildTime: 10, sight: 280, power: -30, cap: 5, dmg: 16,  atkRange: 240, cooldown: 0.75, targets: 'air' },
  tractor:      { hp: 320, w: 38, h: 38, cost: 110, buildTime: 12, sight: 300, power: -30, cap: 5, dmg: 2.4, atkRange: 250, cooldown: 0.1,  targets: 'air', weapon: 'beam', ownWeaponArt: true },
  // fortification kind: walls block ground pathing outright; gates pass the
  // owner's units and block everyone else. wallKind lets segments snap flush
  // against each other (normal structures keep a 32px walkway apart).
  wall: { name: 'Wall', hp: 380, w: 26, h: 26, cost: 15, buildTime: 2, sight: 80,  power: 0, wallKind: true },
  gate: { name: 'Gate', hp: 360, w: 34, h: 34, cost: 35, buildTime: 3, sight: 100, power: 0, wallKind: true, gate: true },
  // stealthed proximity trap: trip = trigger radius (enemy ground units);
  // detonation reuses the neutral explodes blast. noBlock: doesn't obstruct
  // pathing or placement — it's buried, things roll right over it.
  mine: { name: 'Landmine', hp: 50, w: 16, h: 16, cost: 30, buildTime: 3, sight: 60, power: 0, stealth: true, noBlock: true, trip: 50, explodes: { r: 70, dmg: 65 } },
  // service structure: mends the owner's vehicles and aircraft sitting on it
  repairpad: { name: 'Repair Pad', hp: 380, w: 64, h: 64, cost: 120, buildTime: 12, sight: 180, power: -20, cap: 2, repairRate: 8 },
  // resistance passive: hidden observation posts (never buildable)
  sleepercell:  { hp: 60,  w: 22, h: 22, cost: 0,   buildTime: 0,  sight: 260, power: 0 },
  // neutral map structures — garrison infantry inside to claim them
  house:     { name: 'Abandoned House', hp: 400, w: 46, h: 42, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 4 },
  apartment: { name: 'Apartment Block', hp: 750, w: 58, h: 66, cost: 0, buildTime: 0, sight: 220, power: 0, slots: 6 },
  barn:      { name: 'Old Barn',        hp: 480, w: 62, h: 52, cost: 0, buildTime: 0, sight: 190, power: 0, slots: 3 },
  derrick:   { name: 'Oil Derrick',     hp: 500, w: 50, h: 56, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 2, income: 12 },
  // downtown lots (urban maps): the office tower is the garrison prize;
  // gas stations go up when they go down (explodes: blast + lingering fire)
  office:     { name: 'Office Tower',  hp: 950, w: 58, h: 58, cost: 0, buildTime: 0, sight: 230, power: 0, slots: 6 },
  shop:       { name: 'Corner Store',  hp: 380, w: 44, h: 38, cost: 0, buildTime: 0, sight: 190, power: 0, slots: 3 },
  church:     { name: 'Old Church',    hp: 520, w: 46, h: 58, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 4 },
  warehouse:  { name: 'Warehouse',     hp: 700, w: 72, h: 52, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 5 },
  gasstation: { name: 'Gas Station',   hp: 320, w: 54, h: 40, cost: 0, buildTime: 0, sight: 190, power: 0, slots: 2, explodes: { r: 95, dmg: 55, fire: { r: 55, dur: 4, dps: 10 } } },
};

// map settings: how built-up the countryside is. Chosen on the start screen
// (or rolled randomly); mapgen reads these to lay out neutral structures.
const MAP_SETTINGS = {
  urban:   { name: 'Urban' },
  town:    { name: 'Town' },
  country: { name: 'Country' },
};

// ---------- per-faction building variation ----------
// The same construction slot means something different to every faction:
// a Diesel Shack is not a Fusion Plant. Overrides below are merged over the
// BUILDING_TYPES base stats into FBUILD at load.
// income: minerals granted per 10 seconds while the building stands — the
// alien economy runs on this instead of miners.
const BUILDING_MODS = {
  flat: { // cheap, flimsy, quick to raise; big workforce keeps them fueled
    hq:         { hp: 850,  power: 55 },
    powerplant: { cost: 60,  hp: 240, power: 70,  buildTime: 8,  w: 52, h: 52 },
    barracks:   { cost: 80,  hp: 380, buildTime: 10, w: 50, h: 50 },
    factory:    { cost: 130, hp: 440, buildTime: 14 },
    airpad:     { cost: 110, hp: 380, buildTime: 14, req: 'tech' }, // the sky must be proven fake first
    tech:       { cost: 240, hp: 420 },
    watchtower: { cost: 70 },
    mine:       { cost: 20, buildTime: 2, explodes: { r: 75, dmg: 70, fire: { r: 40, dur: 2.5, dps: 8 } } }, // IEDs are their thing
  },
  resistance: { // guerrilla salvage: cheapest structures in the game
    hq:         { hp: 800,  power: 55 },
    powerplant: { cost: 55,  hp: 220, power: 65,  buildTime: 7,  w: 52, h: 52 },
    barracks:   { cost: 70,  hp: 340, buildTime: 9,  w: 50, h: 50 },
    factory:    { cost: 115, hp: 400, buildTime: 13 },
    airpad:     { cost: 100, hp: 350, buildTime: 13, req: 'tech' }, // trust the airwaves before the airways
    tech:       { cost: 220, hp: 400 },
    watchtower: { cost: 65 },
    mine:       { cost: 20, buildTime: 2, explodes: { r: 75, dmg: 70, fire: { r: 40, dur: 2.5, dps: 8 } } }, // IEDs are their thing
  },
  glob: { // premium infrastructure: pay double, get the best grid and armor
    hq:         { hp: 1100, power: 70 },
    powerplant: { cost: 125, hp: 420, power: 150, buildTime: 13, w: 62, h: 62 },
    barracks:   { cost: 125, hp: 520, buildTime: 13, w: 58, h: 58 },
    factory:    { cost: 175, hp: 560, buildTime: 17 },
    airpad:     { cost: 160, hp: 470, buildTime: 17 },
    tech:       { cost: 300, hp: 560 },
  },
  deep: { // black-budget funding: nearly Globalist quality, slightly leaner
    hq:         { hp: 1050, power: 70 },
    powerplant: { cost: 115, hp: 400, power: 140, buildTime: 12, w: 62, h: 62 },
    barracks:   { cost: 115, hp: 500, buildTime: 12, w: 58, h: 58 },
    factory:    { cost: 165, hp: 540, buildTime: 16 },
    airpad:     { cost: 150, hp: 450, buildTime: 16 },
    tech:       { cost: 280, hp: 540 },
  },
  hollow: { // dug into bedrock: sturdiest structures, dirt-cheap geothermal power
    hq:         { hp: 1250, power: 55 },
    powerplant: { cost: 70,  hp: 340, power: 120, buildTime: 9 },
    barracks:   { cost: 105, hp: 560, buildTime: 13 },
    factory:    { cost: 155, hp: 620, buildTime: 17 },
    airpad:     { cost: 130, hp: 460 },
    tech:       { hp: 580 },
  },
  grey: { // zero-point economy: no miners, structures conjure minerals
    hq:         { hp: 1000, power: 80, income: 16 },
    powerplant: { cost: 130, hp: 350, power: 130, buildTime: 13, income: 11 },
    barracks:   { cost: 125, hp: 430 },
    factory:    { cost: 180, hp: 520 },
    airpad:     { cost: 165, hp: 440 },
  },
  reptilian: { // the nest provides: same structure income, slightly cheaper
    hq:         { hp: 1050, power: 75, income: 16 },
    powerplant: { cost: 120, hp: 340, power: 125, buildTime: 12, income: 11 },
    barracks:   { cost: 110, hp: 470 },
    factory:    { cost: 170, hp: 530 },
    airpad:     { cost: 150, hp: 450 },
  },
};

// FBUILD[faction][type] = final building stats for that faction
const FBUILD = {};
for (const fk of Object.keys(FACTIONS)) {
  FBUILD[fk] = {};
  for (const [bk, base] of Object.entries(BUILDING_TYPES)) {
    FBUILD[fk][bk] = { ...base, ...(BUILDING_MODS[fk] || {})[bk] };
  }
}

// ---------- global pace tuning ----------
// One knob for how fast the game feels: more hp makes fights last longer,
// lower speeds slow army movement, longer build times stretch the macro game.
// Applied to every unit and building at load so the stat tables above stay
// readable as relative balance numbers.
const PACE = { hp: 1.35, speed: 0.85, buildTime: 1.2 };
for (const t of Object.values(UNIT_TYPES)) {
  t.hp = Math.round(t.hp * PACE.hp);
  t.speed = Math.round(t.speed * PACE.speed);
  if (t.buildTime) t.buildTime = Math.round(t.buildTime * PACE.buildTime);
}
for (const table of [BUILDING_TYPES, ...Object.values(FBUILD)]) {
  for (const b of Object.values(table)) {
    b.hp = Math.round(b.hp * PACE.hp);
    if (b.buildTime) b.buildTime = Math.round(b.buildTime * PACE.buildTime);
  }
}
