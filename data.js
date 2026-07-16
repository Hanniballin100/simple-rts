// ============================================================
// data.js — all game data: constants, terrain, factions, units,
// buildings. Balance tweaks and new content go HERE.
// Loaded before art.js and game.js (plain globals, no modules).
// ============================================================

const WORLD_W = 2000;
const WORLD_H = 1400;
const BUILD_RADIUS = 280;    // structures must sit near the HQ or a power plant
const AI_GRACE_PERIOD = 150; // seconds before the AI's first attack wave
const HARVEST_AMOUNT = 6;    // minerals per trip
const HARVEST_TIME = 3.5;    // seconds spent mining
const FOG_TILE = 50;

const PLAYER = 0;
const ENEMY = 1;
const COLORS = { [PLAYER]: '#4da3ff', [ENEMY]: '#ff5f5f' };
const COLORS_DARK = { [PLAYER]: '#2b6cb0', [ENEMY]: '#b03434' };

// impassable terrain: ground units steer around it, air flies over,
// nothing can be built on it
const TERRAIN = [
  { x: 1000, y: 560,  r: 110, type: 'water' }, // central lake — forces flanks
  { x: 640,  y: 420,  r: 80,  type: 'rock' },
  { x: 1360, y: 980,  r: 80,  type: 'rock' },
  { x: 500,  y: 1000, r: 70,  type: 'water' },
  { x: 1500, y: 400,  r: 70,  type: 'water' },
  { x: 1000, y: 950,  r: 60,  type: 'rock' },
  { x: 780,  y: 1250, r: 55,  type: 'rock' },
  { x: 1220, y: 150,  r: 55,  type: 'rock' },
];

// tracer/impact styling per faction
const WEAPON_STYLE = {
  flat: 'bullet', resistance: 'bullet', glob: 'laser', deep: 'laser',
  hollow: 'ember', grey: 'plasma', reptilian: 'plasma',
};

// which building-art family each faction uses
const FAMILY_STYLE = { flat: 'flat', resistance: 'flat', glob: 'glob', deep: 'glob', hollow: 'hollow', grey: 'alien', reptilian: 'alien' };

const STRUCT_HOTKEYS = { p: 'powerplant', b: 'barracks', t: 'TOWER', g: 'AATOWER', f: 'factory', d: 'airpad' };

// ---------- factions ----------

const FACTIONS = {
  flat: {
    name: 'Flat Earthers', family: 'FLAT EARTH', emoji: '🥞',
    desc: 'Defend the ice wall. Cheap Militia swarms, the building-ramming Truck of Truth, and the mighty Balloon of Truth.',
    worker: 'believer', infantry: 'militia', aa: 'laserguy', vehicle: 'truck',
    air: ['wballoon', 'balloon'], tower: 'watchtower', aaTower: 'laserpointer',
    extras: ['preacher', 'catapult', 'cropduster'],
    powers: {
      passive: { name: 'Horizon Is a Lie', desc: 'Enemy aircraft are always visible on your radar.' },
      sig: { name: 'Documentary Drops', desc: 'Every 3 minutes a random enemy unit sees the truth and joins you.', kind: 'auto', period: 180 },
    },
    buildingNames: {
      hq: 'Bunker of Truth', powerplant: 'Diesel Shack', barracks: 'Recruitment Tent',
      factory: 'Truck Garage', airpad: 'Balloon Dock',
      watchtower: 'Watchtower', laserpointer: 'Giant Laser Pointer',
    },
  },
  resistance: {
    name: 'The Resistance', family: 'FLAT EARTH', emoji: '📡',
    desc: 'Off-grid guerrillas. Dirt-cheap Partisans and fast gun-truck Technicals hit before the lamestream reacts.',
    worker: 'believer', infantry: 'partisan', aa: 'laserguy', vehicle: 'technical',
    air: ['wballoon', 'balloon'], tower: 'watchtower', aaTower: 'laserpointer',
    extras: ['preacher', 'catapult', 'cropduster'],
    powers: {
      passive: { name: 'Sleeper Cells', desc: '3 hidden observation camps watch the map from the start.' },
      sig: { name: 'Smuggling Routes', desc: 'Every 2 minutes a truck hauls 150 minerals to your HQ — unless it gets intercepted.', kind: 'auto', period: 120 },
    },
    buildingNames: {
      hq: 'Pirate Radio Bunker', powerplant: 'Diesel Shack', barracks: 'Safehouse',
      factory: 'Chop Shop', airpad: 'Balloon Dock',
      watchtower: 'Watchtower', laserpointer: 'Giant Laser Pointer',
      sleepercell: 'Sleeper Cell',
    },
  },
  glob: {
    name: 'Globalists', family: 'GLOBALISTS', emoji: '🌐',
    desc: 'Order through orbit. Elite Agents, Black SUVs, Black Drones, and the Black Helicopter that rules ground and sky.',
    worker: 'operative', infantry: 'agent', aa: 'jammer', vehicle: 'suv',
    air: ['drone', 'heli'], tower: 'tower5g', aaTower: 'samsite',
    extras: ['riot', 'haarp', 'gunship'],
    powers: {
      passive: { name: 'Compound Interest', desc: 'Your bank earns 2% interest every 10 seconds.' },
      sig: { name: 'Weather Modification', desc: 'Target a zone: enemy ground units in it are slowed 40% for 15s.', kind: 'zone', cd: 90 },
    },
    buildingNames: {
      hq: 'World HQ', powerplant: 'Fusion Plant', barracks: 'Command Center',
      factory: 'Motor Pool', airpad: 'Drone Bay',
      tower5g: '5G Tower', samsite: 'Interceptor Battery',
    },
  },
  deep: {
    name: 'The Deep State', family: 'GLOBALISTS', emoji: '🕶️',
    desc: 'It was never elected and never leaves. Men in Black hit hard; Surveillance Vans see everything, from very far away.',
    worker: 'operative', infantry: 'mib', aa: 'jammer', vehicle: 'blackvan',
    air: ['drone', 'heli'], tower: 'tower5g', aaTower: 'samsite',
    extras: ['riot', 'haarp', 'gunship'],
    powers: {
      passive: { name: 'Deep Cover Recruitment', desc: 'Every 2 minutes a mole from the ENEMY roster reports to your barracks.' },
      sig: { name: 'Gaslight', desc: 'Phantom signatures appear near the enemy base and their defenses scramble to fight nothing.', kind: 'instant', cd: 120 },
    },
    buildingNames: {
      hq: 'Undisclosed Location', powerplant: 'Fusion Plant', barracks: 'Field Office',
      factory: 'Motor Pool', airpad: 'Drone Bay',
      tower5g: '5G Tower', samsite: 'Interceptor Battery',
    },
  },
  hollow: {
    name: 'Hollow Earthers', family: 'HOLLOW EARTH', emoji: '🕳️',
    desc: 'The real world is below. Tough Mole Militia, Drill Tanks that eat buildings, Cave Bat swarms, and free-flowing geothermal power.',
    worker: 'digger', infantry: 'moleman', aa: 'slinger', vehicle: 'drill',
    air: ['cavebat', 'gyro'], tower: 'stalagmite', aaTower: 'geyser',
    extras: ['sapper', 'magma', 'ptero'],
    powers: {
      passive: { name: 'Seismic Sense', desc: 'Enemy ground units are always visible on your radar.' },
      sig: { name: 'Tunnel Network', desc: 'Right-click your HQ or a power plant: selected ground units travel there underground.', kind: 'info' },
    },
    buildingNames: {
      hq: 'Inner Sanctum', powerplant: 'Geothermal Vent', barracks: 'Burrow',
      factory: 'Drill Works', airpad: 'Cavern Roost',
      stalagmite: 'Stalagmite Spitter', geyser: 'Geyser Cannon',
    },
  },
  grey: {
    name: 'The Greys', family: 'ALIENS', emoji: '👽',
    desc: 'You will be probed. Abductors, towering Tripod Striders, and the Flying Saucer — supreme in the air and cruel to the ground.',
    worker: 'probe', infantry: 'greytrooper', aa: 'beamer', vehicle: 'tripod',
    air: ['orb', 'saucer'], tower: 'pylon', aaTower: 'tractor',
    extras: ['hybrid', 'mortarcrawler', 'biobomber'],
    powers: {
      passive: { name: 'Superior Metallurgy', desc: 'Your buildings ignore bonus anti-building damage (sappers, rams, artillery).' },
      sig: { name: 'Cloning Vats', desc: 'Target one of your units: an exact copy emerges from your barracks.', kind: 'unit', cd: 90 },
    },
    buildingNames: {
      hq: 'Mothership Anchor', powerplant: 'Zero-Point Core', barracks: 'Cloning Pod',
      factory: 'Assembler', airpad: 'Saucer Pad',
      pylon: 'Plasma Pylon', tractor: 'Tractor Beam',
    },
  },
  reptilian: {
    name: 'The Reptilians', family: 'ALIENS', emoji: '🦎',
    desc: 'They walk among us — and bite. Melee Reptoid Warriors, the armored Basilisk Crawler, and fire-breathing Sky Drakes.',
    worker: 'probe', infantry: 'raptoid', aa: 'beamer', vehicle: 'basilisk',
    air: ['orb', 'drake'], tower: 'pylon', aaTower: 'tractor',
    extras: ['hybrid', 'mortarcrawler', 'biobomber'],
    powers: {
      passive: { name: 'Skin Suit', desc: 'Your infantry are not recognized as hostile until they attack.' },
      sig: { name: 'Reveal Infiltrator', desc: 'One enemy worker has always been yours. Click to convert it (once per game).', kind: 'once' },
    },
    buildingNames: {
      hq: 'Nest Citadel', powerplant: 'Zero-Point Core', barracks: 'Hatchery',
      factory: 'Assembler', airpad: 'Roost Spire',
      pylon: 'Plasma Pylon', tractor: 'Tractor Beam',
    },
  },
};

// ---------- units ----------
// targets: 'ground' | 'air' | 'both' (default 'ground' for anything armed)
// weapon: 'gun' (default) | 'lob' | 'bomb' | 'storm' | 'spray'
// maxAmmo: aircraft magazine — empty means return to the airpad to rearm

const UNIT_TYPES = {
  // workers
  believer:  { name: 'Believer',        role: 'worker', builtAt: 'hq', hp: 40, speed: 85, dmg: 3, atkRange: 22, cooldown: 1, sight: 170, cost: 50, r: 8, buildTime: 4 },
  operative: { name: 'Field Operative', role: 'worker', builtAt: 'hq', hp: 40, speed: 85, dmg: 3, atkRange: 22, cooldown: 1, sight: 170, cost: 50, r: 8, buildTime: 4 },
  digger:    { name: 'Mole Digger',     role: 'worker', builtAt: 'hq', hp: 50, speed: 80, dmg: 4, atkRange: 22, cooldown: 1, sight: 160, cost: 50, r: 8, buildTime: 4 },
  probe:     { name: 'Harvest Probe',   role: 'worker', builtAt: 'hq', hp: 35, speed: 95, dmg: 2, atkRange: 22, cooldown: 1, sight: 190, cost: 50, r: 8, buildTime: 4 },
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
  // specialist infantry
  preacher: { name: 'Street Preacher',    role: 'combat', builtAt: 'barracks', hp: 70,  speed: 70, dmg: 6,  atkRange: 90,  cooldown: 1,   sight: 200, cost: 55, r: 9,  buildTime: 6, bldgBonus: 3 },
  riot:     { name: 'Riot Trooper',       role: 'combat', builtAt: 'barracks', hp: 180, speed: 60, dmg: 6,  atkRange: 60,  cooldown: 0.8, sight: 190, cost: 75, r: 10, buildTime: 7, armor: 0.35 },
  sapper:   { name: 'Tunnel Sapper',      role: 'combat', builtAt: 'barracks', hp: 90,  speed: 80, dmg: 8,  atkRange: 25,  cooldown: 1,   sight: 190, cost: 65, r: 9,  buildTime: 6, bldgBonus: 4 },
  hybrid:   { name: 'Hybrid Infiltrator', role: 'combat', builtAt: 'barracks', hp: 55,  speed: 95, dmg: 14, atkRange: 110, cooldown: 0.7, sight: 240, cost: 70, r: 9,  buildTime: 6 },
  // vehicles
  truck:     { name: 'Truck of Truth',   role: 'combat', builtAt: 'factory', hp: 280, speed: 58,  dmg: 22, atkRange: 30,  cooldown: 1.1,  sight: 200, cost: 120, r: 13, buildTime: 9,  bldgBonus: 2,   shape: 'square' },
  technical: { name: 'Technical',        role: 'combat', builtAt: 'factory', hp: 170, speed: 105, dmg: 12, atkRange: 105, cooldown: 0.55, sight: 220, cost: 90,  r: 12, buildTime: 7,  shape: 'square' },
  suv:       { name: 'Black SUV',        role: 'combat', builtAt: 'factory', hp: 200, speed: 95,  dmg: 13, atkRange: 110, cooldown: 0.6,  sight: 220, cost: 110, r: 12, buildTime: 8,  shape: 'square' },
  blackvan:  { name: 'Surveillance Van', role: 'combat', builtAt: 'factory', hp: 220, speed: 80,  dmg: 12, atkRange: 150, cooldown: 0.7,  sight: 300, cost: 130, r: 12, buildTime: 9,  shape: 'square' },
  drill:     { name: 'Drill Tank',       role: 'combat', builtAt: 'factory', hp: 320, speed: 55,  dmg: 24, atkRange: 28,  cooldown: 1.2,  sight: 180, cost: 130, r: 13, buildTime: 10, bldgBonus: 2,   shape: 'square' },
  tripod:    { name: 'Tripod Strider',   role: 'combat', builtAt: 'factory', hp: 240, speed: 70,  dmg: 18, atkRange: 140, cooldown: 1,    sight: 250, cost: 140, r: 13, buildTime: 10, shape: 'square', armor: 0.15 },
  basilisk:  { name: 'Basilisk Crawler', role: 'combat', builtAt: 'factory', hp: 350, speed: 60,  dmg: 22, atkRange: 34,  cooldown: 1.1,  sight: 200, cost: 150, r: 14, buildTime: 11, bldgBonus: 1.5, shape: 'square' },
  // artillery (minRange: can't fire when rushed; lobbed projectiles with splash)
  catapult:      { name: 'Flatbed Catapult', role: 'combat', builtAt: 'factory', hp: 140, speed: 45, dmg: 34, atkRange: 280, minRange: 100, cooldown: 3.2, sight: 300, cost: 160, r: 13, buildTime: 11, bldgBonus: 1.5, shape: 'square', weapon: 'lob', projectile: 'rock', splash: 36 },
  haarp:         { name: 'HAARP Truck',      role: 'combat', builtAt: 'factory', hp: 150, speed: 50, dmg: 15, atkRange: 300, minRange: 120, cooldown: 3.5, sight: 320, cost: 180, r: 13, buildTime: 12, shape: 'square', weapon: 'storm' },
  magma:         { name: 'Magma Mortar',     role: 'combat', builtAt: 'factory', hp: 150, speed: 48, dmg: 28, atkRange: 270, minRange: 100, cooldown: 3,   sight: 290, cost: 155, r: 13, buildTime: 11, bldgBonus: 1.3, shape: 'square', weapon: 'lob', projectile: 'magma', splash: 34, groundEffect: { kind: 'fire', r: 26, dur: 2.2, dps: 8 } },
  mortarcrawler: { name: 'Plasma Mortar',    role: 'combat', builtAt: 'factory', hp: 160, speed: 50, dmg: 32, atkRange: 290, minRange: 110, cooldown: 3.3, sight: 310, cost: 175, r: 13, buildTime: 12, shape: 'square', weapon: 'lob', projectile: 'plasma', splash: 40 },
  // air
  wballoon: { name: 'Weather Balloon',  role: 'scout',  builtAt: 'airpad', hp: 60,  speed: 90,  dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 360, cost: 40,  r: 9,  buildTime: 6,  flying: true, shape: 'blimp' },
  balloon:  { name: 'Balloon of Truth', role: 'combat', builtAt: 'airpad', hp: 420, speed: 40,  dmg: 40, atkRange: 36,  cooldown: 2.2,  sight: 240, cost: 200, r: 15, buildTime: 14, flying: true, bldgBonus: 1.5, shape: 'blimp', weapon: 'bomb', splash: 46 },
  drone:    { name: 'Black Drone',      role: 'combat', builtAt: 'airpad', hp: 55,  speed: 135, dmg: 8,  atkRange: 130, cooldown: 0.7,  sight: 280, cost: 85,  r: 8,  buildTime: 7,  flying: true, shape: 'tri', maxAmmo: 8 },
  heli:     { name: 'Black Helicopter', role: 'combat', builtAt: 'airpad', hp: 150, speed: 110, dmg: 13, atkRange: 135, cooldown: 0.65, sight: 260, cost: 160, r: 11, buildTime: 11, flying: true, targets: 'both', shape: 'tri', maxAmmo: 10 },
  cavebat:  { name: 'Cave Bat Swarm',   role: 'combat', builtAt: 'airpad', hp: 45,  speed: 120, dmg: 4,  atkRange: 60,  cooldown: 0.5,  sight: 300, cost: 45,  r: 8,  buildTime: 5,  flying: true, shape: 'tri', maxAmmo: 12 },
  gyro:     { name: 'Gyrocopter',       role: 'combat', builtAt: 'airpad', hp: 130, speed: 100, dmg: 11, atkRange: 125, cooldown: 0.7,  sight: 260, cost: 150, r: 10, buildTime: 10, flying: true, targets: 'both', shape: 'tri', maxAmmo: 10 },
  orb:      { name: 'Scout Orb',        role: 'scout',  builtAt: 'airpad', hp: 50,  speed: 140, dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 380, cost: 40,  r: 8,  buildTime: 5,  flying: true, shape: 'blimp' },
  saucer:   { name: 'Flying Saucer',    role: 'combat', builtAt: 'airpad', hp: 180, speed: 115, dmg: 14, atkRange: 140, cooldown: 0.7,  sight: 300, cost: 190, r: 12, buildTime: 12, flying: true, targets: 'both', shape: 'saucer', maxAmmo: 10 },
  drake:    { name: 'Sky Drake',        role: 'combat', builtAt: 'airpad', hp: 160, speed: 105, dmg: 16, atkRange: 90,  cooldown: 0.8,  sight: 260, cost: 170, r: 11, buildTime: 11, flying: true, shape: 'tri', maxAmmo: 8 },
  cropduster: { name: 'Crop Duster',    role: 'combat', builtAt: 'airpad', hp: 110, speed: 145, dmg: 8,  atkRange: 70,  cooldown: 1,   sight: 280, cost: 130, r: 10, buildTime: 9,  flying: true, shape: 'tri', weapon: 'spray', groundEffect: { kind: 'toxin', r: 26, dur: 2, dps: 5 }, maxAmmo: 6 },
  gunship:    { name: 'Night Gunship',  role: 'combat', builtAt: 'airpad', hp: 220, speed: 85,  dmg: 20, atkRange: 150, cooldown: 1.2, sight: 280, cost: 210, r: 12, buildTime: 13, flying: true, shape: 'tri', maxAmmo: 8 },
  ptero:      { name: 'Pterodactyl',    role: 'combat', builtAt: 'airpad', hp: 170, speed: 120, dmg: 17, atkRange: 60,  cooldown: 0.9, sight: 270, cost: 160, r: 11, buildTime: 11, flying: true, shape: 'tri', maxAmmo: 8 },
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
  airpad:     { hp: 420, w: 96, h: 72, cost: 140, buildTime: 16, sight: 200, power: -40,  cap: 2 },
  // ground-defense towers
  watchtower: { hp: 300, w: 40, h: 40, cost: 75,  buildTime: 10, sight: 240, power: -30, cap: 5, dmg: 10, atkRange: 175, cooldown: 0.7,  targets: 'ground' },
  tower5g:    { hp: 340, w: 40, h: 40, cost: 100, buildTime: 12, sight: 280, power: -30, cap: 5, dmg: 6,  atkRange: 215, cooldown: 0.9,  targets: 'ground', weapon: 'pulse' },
  stalagmite: { hp: 320, w: 40, h: 40, cost: 80,  buildTime: 10, sight: 240, power: -30, cap: 5, dmg: 11, atkRange: 180, cooldown: 0.7,  targets: 'ground' },
  pylon:      { hp: 340, w: 40, h: 40, cost: 105, buildTime: 12, sight: 260, power: -30, cap: 5, dmg: 16, atkRange: 200, cooldown: 0.85, targets: 'ground', weapon: 'chain' },
  // anti-air towers
  laserpointer: { hp: 280, w: 38, h: 38, cost: 90,  buildTime: 10, sight: 280, power: -30, cap: 5, dmg: 14,  atkRange: 230, cooldown: 0.6,  targets: 'air' },
  samsite:      { hp: 320, w: 38, h: 38, cost: 110, buildTime: 12, sight: 300, power: -30, cap: 5, dmg: 18,  atkRange: 260, cooldown: 0.8,  targets: 'air' },
  geyser:       { hp: 300, w: 38, h: 38, cost: 95,  buildTime: 10, sight: 280, power: -30, cap: 5, dmg: 16,  atkRange: 240, cooldown: 0.75, targets: 'air' },
  tractor:      { hp: 320, w: 38, h: 38, cost: 110, buildTime: 12, sight: 300, power: -30, cap: 5, dmg: 2.4, atkRange: 250, cooldown: 0.1,  targets: 'air', weapon: 'beam' },
  // resistance passive: hidden observation posts (never buildable)
  sleepercell:  { hp: 60,  w: 22, h: 22, cost: 0,   buildTime: 0,  sight: 260, power: 0 },
};
