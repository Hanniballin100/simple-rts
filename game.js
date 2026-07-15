// ============================================================
// Flat Earth vs Globalists — a Red Alert-flavored mini RTS
// Sidebar construction, power grid, fog of war, air units,
// EVA announcer, synthesized sound effects.
// ============================================================

const WORLD_W = 2000;
const WORLD_H = 1400;
const BUILD_RADIUS = 280;   // structures must be placed near an existing one
const AI_GRACE_PERIOD = 150;
const HARVEST_AMOUNT = 6;
const HARVEST_TIME = 3.5;

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

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');

const PLAYER = 0;
const ENEMY = 1;
const COLORS = { [PLAYER]: '#4da3ff', [ENEMY]: '#ff5f5f' };
const COLORS_DARK = { [PLAYER]: '#2b6cb0', [ENEMY]: '#b03434' };

// ---------- factions & rosters ----------

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

// targets: 'ground' | 'air' | 'both' (default 'ground' for anything armed)
const UNIT_TYPES = {
  // workers
  believer:  { name: 'Believer',        role: 'worker', builtAt: 'hq', hp: 40, speed: 85, dmg: 3, atkRange: 22, cooldown: 1.0, sight: 170, cost: 50, r: 8, buildTime: 4 },
  operative: { name: 'Field Operative', role: 'worker', builtAt: 'hq', hp: 40, speed: 85, dmg: 3, atkRange: 22, cooldown: 1.0, sight: 170, cost: 50, r: 8, buildTime: 4 },
  digger:    { name: 'Mole Digger',     role: 'worker', builtAt: 'hq', hp: 50, speed: 80, dmg: 4, atkRange: 22, cooldown: 1.0, sight: 160, cost: 50, r: 8, buildTime: 4 },
  probe:     { name: 'Harvest Probe',   role: 'worker', builtAt: 'hq', hp: 35, speed: 95, dmg: 2, atkRange: 22, cooldown: 1.0, sight: 190, cost: 50, r: 8, buildTime: 4 },
  // basic infantry (balance pass: damage cut ~25-30% so massed infantry
  // doesn't out-value vehicles and towers)
  militia:     { name: 'Truther Militia', role: 'combat', builtAt: 'barracks', hp: 75,  speed: 80, dmg: 5,  atkRange: 100, cooldown: 0.75, sight: 210, cost: 45, r: 9,  buildTime: 5 },
  partisan:    { name: 'Partisan',        role: 'combat', builtAt: 'barracks', hp: 60,  speed: 92, dmg: 4,  atkRange: 95,  cooldown: 0.7,  sight: 210, cost: 35, r: 8,  buildTime: 4 },
  agent:       { name: 'Agent',           role: 'combat', builtAt: 'barracks', hp: 110, speed: 68, dmg: 8,  atkRange: 130, cooldown: 0.85, sight: 220, cost: 65, r: 10, buildTime: 6 },
  mib:         { name: 'Man in Black',    role: 'combat', builtAt: 'barracks', hp: 100, speed: 70, dmg: 11, atkRange: 140, cooldown: 0.9,  sight: 240, cost: 80, r: 10, buildTime: 7 },
  moleman:     { name: 'Mole Militia',    role: 'combat', builtAt: 'barracks', hp: 85,  speed: 75, dmg: 5,  atkRange: 90,  cooldown: 0.7,  sight: 190, cost: 50, r: 9,  buildTime: 5 },
  greytrooper: { name: 'Grey Abductor',   role: 'combat', builtAt: 'barracks', hp: 70,  speed: 78, dmg: 7,  atkRange: 120, cooldown: 0.8,  sight: 230, cost: 55, r: 9,  buildTime: 5 },
  raptoid:     { name: 'Reptoid Warrior', role: 'combat', builtAt: 'barracks', hp: 130, speed: 85, dmg: 10, atkRange: 30,  cooldown: 0.8,  sight: 210, cost: 70, r: 10, buildTime: 6 },
  // anti-air infantry: full damage vs air, dmgVsGround when shooting ground
  laserguy: { name: 'Laser Pointer Guy', role: 'combat', builtAt: 'barracks', hp: 65, speed: 75, dmg: 9,  dmgVsGround: 4, atkRange: 175, cooldown: 0.6,  sight: 250, cost: 60, r: 9, buildTime: 6, targets: 'both' },
  jammer:   { name: 'Signal Jammer',     role: 'combat', builtAt: 'barracks', hp: 80, speed: 70, dmg: 11, dmgVsGround: 5, atkRange: 185, cooldown: 0.7,  sight: 260, cost: 70, r: 9, buildTime: 6, targets: 'both' },
  slinger:  { name: 'Crystal Slinger',   role: 'combat', builtAt: 'barracks', hp: 70, speed: 72, dmg: 10, dmgVsGround: 4, atkRange: 180, cooldown: 0.65, sight: 250, cost: 65, r: 9, buildTime: 6, targets: 'both' },
  beamer:   { name: 'Beam Walker',       role: 'combat', builtAt: 'barracks', hp: 75, speed: 74, dmg: 10, dmgVsGround: 5, atkRange: 180, cooldown: 0.65, sight: 260, cost: 70, r: 9, buildTime: 6, targets: 'both' },
  // specialist infantry
  preacher: { name: 'Street Preacher',    role: 'combat', builtAt: 'barracks', hp: 70,  speed: 70, dmg: 6,  atkRange: 90,  cooldown: 1.0, sight: 200, cost: 55, r: 9,  buildTime: 6, bldgBonus: 3 },
  riot:     { name: 'Riot Trooper',       role: 'combat', builtAt: 'barracks', hp: 180, speed: 60, dmg: 6,  atkRange: 60,  cooldown: 0.8, sight: 190, cost: 75, r: 10, buildTime: 7 },
  sapper:   { name: 'Tunnel Sapper',      role: 'combat', builtAt: 'barracks', hp: 90,  speed: 80, dmg: 8,  atkRange: 25,  cooldown: 1.0, sight: 190, cost: 65, r: 9,  buildTime: 6, bldgBonus: 4 },
  hybrid:   { name: 'Hybrid Infiltrator', role: 'combat', builtAt: 'barracks', hp: 55,  speed: 95, dmg: 14, atkRange: 110, cooldown: 0.7, sight: 240, cost: 70, r: 9,  buildTime: 6 },
  // artillery (minRange: can't fire when rushed)
  catapult:      { name: 'Flatbed Catapult', role: 'combat', builtAt: 'factory', hp: 140, speed: 45, dmg: 40, atkRange: 280, minRange: 100, cooldown: 3.2, sight: 300, cost: 160, r: 13, buildTime: 11, bldgBonus: 1.5, shape: 'square' },
  haarp:         { name: 'HAARP Truck',      role: 'combat', builtAt: 'factory', hp: 150, speed: 50, dmg: 45, atkRange: 300, minRange: 120, cooldown: 3.5, sight: 320, cost: 180, r: 13, buildTime: 12, shape: 'square' },
  magma:         { name: 'Magma Mortar',     role: 'combat', builtAt: 'factory', hp: 150, speed: 48, dmg: 38, atkRange: 270, minRange: 100, cooldown: 3.0, sight: 290, cost: 155, r: 13, buildTime: 11, bldgBonus: 1.3, shape: 'square' },
  mortarcrawler: { name: 'Plasma Mortar',    role: 'combat', builtAt: 'factory', hp: 160, speed: 50, dmg: 42, atkRange: 290, minRange: 110, cooldown: 3.3, sight: 310, cost: 175, r: 13, buildTime: 12, shape: 'square' },
  // attack aircraft
  cropduster: { name: 'Crop Duster',    role: 'combat', builtAt: 'airpad', hp: 110, speed: 145, dmg: 18, atkRange: 70,  cooldown: 1.0, sight: 280, cost: 130, r: 10, buildTime: 9,  flying: true, shape: 'tri' },
  gunship:    { name: 'Night Gunship',  role: 'combat', builtAt: 'airpad', hp: 220, speed: 85,  dmg: 20, atkRange: 150, cooldown: 1.2, sight: 280, cost: 210, r: 12, buildTime: 13, flying: true, shape: 'tri' },
  ptero:      { name: 'Pterodactyl',    role: 'combat', builtAt: 'airpad', hp: 170, speed: 120, dmg: 17, atkRange: 60,  cooldown: 0.9, sight: 270, cost: 160, r: 11, buildTime: 11, flying: true, shape: 'tri' },
  biobomber:  { name: 'Bio Bomber',     role: 'combat', builtAt: 'airpad', hp: 200, speed: 90,  dmg: 30, atkRange: 50,  cooldown: 1.6, sight: 260, cost: 200, r: 13, buildTime: 13, flying: true, bldgBonus: 1.5, shape: 'blimp' },
  // vehicles
  truck:     { name: 'Truck of Truth',   role: 'combat', builtAt: 'factory', hp: 280, speed: 58,  dmg: 22, atkRange: 30,  cooldown: 1.1,  sight: 200, cost: 120, r: 13, buildTime: 9,  bldgBonus: 2,   shape: 'square' },
  technical: { name: 'Technical',        role: 'combat', builtAt: 'factory', hp: 170, speed: 105, dmg: 12, atkRange: 105, cooldown: 0.55, sight: 220, cost: 90,  r: 12, buildTime: 7,  shape: 'square' },
  suv:       { name: 'Black SUV',        role: 'combat', builtAt: 'factory', hp: 200, speed: 95,  dmg: 13, atkRange: 110, cooldown: 0.6,  sight: 220, cost: 110, r: 12, buildTime: 8,  shape: 'square' },
  blackvan:  { name: 'Surveillance Van', role: 'combat', builtAt: 'factory', hp: 220, speed: 80,  dmg: 12, atkRange: 150, cooldown: 0.7,  sight: 300, cost: 130, r: 12, buildTime: 9,  shape: 'square' },
  drill:     { name: 'Drill Tank',       role: 'combat', builtAt: 'factory', hp: 320, speed: 55,  dmg: 24, atkRange: 28,  cooldown: 1.2,  sight: 180, cost: 130, r: 13, buildTime: 10, bldgBonus: 2,   shape: 'square' },
  tripod:    { name: 'Tripod Strider',   role: 'combat', builtAt: 'factory', hp: 240, speed: 70,  dmg: 18, atkRange: 140, cooldown: 1.0,  sight: 250, cost: 140, r: 13, buildTime: 10, shape: 'square' },
  basilisk:  { name: 'Basilisk Crawler', role: 'combat', builtAt: 'factory', hp: 350, speed: 60,  dmg: 22, atkRange: 34,  cooldown: 1.1,  sight: 200, cost: 150, r: 14, buildTime: 11, bldgBonus: 1.5, shape: 'square' },
  // air
  wballoon: { name: 'Weather Balloon',  role: 'scout',  builtAt: 'airpad', hp: 60,  speed: 90,  dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 360, cost: 40,  r: 9,  buildTime: 6,  flying: true, shape: 'blimp' },
  balloon:  { name: 'Balloon of Truth', role: 'combat', builtAt: 'airpad', hp: 420, speed: 40,  dmg: 45, atkRange: 36,  cooldown: 2.2,  sight: 240, cost: 200, r: 15, buildTime: 14, flying: true, bldgBonus: 1.5, shape: 'blimp' },
  drone:    { name: 'Black Drone',      role: 'combat', builtAt: 'airpad', hp: 55,  speed: 135, dmg: 8,  atkRange: 130, cooldown: 0.7,  sight: 280, cost: 85,  r: 8,  buildTime: 7,  flying: true, shape: 'tri' },
  heli:     { name: 'Black Helicopter', role: 'combat', builtAt: 'airpad', hp: 150, speed: 110, dmg: 13, atkRange: 135, cooldown: 0.65, sight: 260, cost: 160, r: 11, buildTime: 11, flying: true, targets: 'both', shape: 'tri' },
  cavebat:  { name: 'Cave Bat Swarm',   role: 'combat', builtAt: 'airpad', hp: 45,  speed: 120, dmg: 4,  atkRange: 60,  cooldown: 0.5,  sight: 300, cost: 45,  r: 8,  buildTime: 5,  flying: true, shape: 'tri' },
  gyro:     { name: 'Gyrocopter',       role: 'combat', builtAt: 'airpad', hp: 130, speed: 100, dmg: 11, atkRange: 125, cooldown: 0.7,  sight: 260, cost: 150, r: 10, buildTime: 10, flying: true, targets: 'both', shape: 'tri' },
  orb:      { name: 'Scout Orb',        role: 'scout',  builtAt: 'airpad', hp: 50,  speed: 140, dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 380, cost: 40,  r: 8,  buildTime: 5,  flying: true, shape: 'blimp' },
  saucer:   { name: 'Flying Saucer',    role: 'combat', builtAt: 'airpad', hp: 180, speed: 115, dmg: 14, atkRange: 140, cooldown: 0.7,  sight: 300, cost: 190, r: 12, buildTime: 12, flying: true, targets: 'both', shape: 'saucer' },
  drake:    { name: 'Sky Drake',        role: 'combat', builtAt: 'airpad', hp: 160, speed: 105, dmg: 16, atkRange: 90,  cooldown: 0.8,  sight: 260, cost: 170, r: 11, buildTime: 11, flying: true, shape: 'tri' },
  // faction-power units (never trainable)
  smuggler: { name: 'Smuggler Truck', role: 'scout', hp: 120, speed: 75, dmg: 0, atkRange: 0, cooldown: 1, sight: 180, cost: 0, r: 11, buildTime: 0, shape: 'square' },
  phantom:  { name: 'Unknown Contact', role: 'scout', hp: 20,  speed: 60, dmg: 0, atkRange: 0, cooldown: 1, sight: 40,  cost: 0, r: 9,  buildTime: 0 },
};

const BUILDING_TYPES = {
  hq:         { hp: 800, w: 84, h: 84, cost: 0,   buildTime: 0,  sight: 280, power: +60 },
  powerplant: { hp: 320, w: 56, h: 56, cost: 80,  buildTime: 10, sight: 160, power: +100, cap: 6 },
  barracks:   { hp: 450, w: 64, h: 64, cost: 100, buildTime: 12, sight: 200, power: -30,  cap: 3 },
  factory:    { hp: 500, w: 74, h: 62, cost: 150, buildTime: 16, sight: 200, power: -40,  cap: 2 },
  airpad:     { hp: 420, w: 66, h: 66, cost: 140, buildTime: 16, sight: 200, power: -40,  cap: 2 },
  // ground-defense towers
  watchtower: { hp: 300, w: 40, h: 40, cost: 75,  buildTime: 10, sight: 240, power: -30, cap: 5, dmg: 10, atkRange: 175, cooldown: 0.7,  targets: 'ground' },
  tower5g:    { hp: 340, w: 40, h: 40, cost: 100, buildTime: 12, sight: 280, power: -30, cap: 5, dmg: 14, atkRange: 215, cooldown: 0.9,  targets: 'ground' },
  stalagmite: { hp: 320, w: 40, h: 40, cost: 80,  buildTime: 10, sight: 240, power: -30, cap: 5, dmg: 11, atkRange: 180, cooldown: 0.7,  targets: 'ground' },
  pylon:      { hp: 340, w: 40, h: 40, cost: 105, buildTime: 12, sight: 260, power: -30, cap: 5, dmg: 15, atkRange: 200, cooldown: 0.85, targets: 'ground' },
  // anti-air towers
  laserpointer: { hp: 280, w: 38, h: 38, cost: 90,  buildTime: 10, sight: 280, power: -30, cap: 5, dmg: 14, atkRange: 230, cooldown: 0.6,  targets: 'air' },
  samsite:      { hp: 320, w: 38, h: 38, cost: 110, buildTime: 12, sight: 300, power: -30, cap: 5, dmg: 18, atkRange: 260, cooldown: 0.8,  targets: 'air' },
  geyser:       { hp: 300, w: 38, h: 38, cost: 95,  buildTime: 10, sight: 280, power: -30, cap: 5, dmg: 16, atkRange: 240, cooldown: 0.75, targets: 'air' },
  tractor:      { hp: 320, w: 38, h: 38, cost: 110, buildTime: 12, sight: 300, power: -30, cap: 5, dmg: 17, atkRange: 250, cooldown: 0.8,  targets: 'air' },
  // resistance passive: hidden observation posts (never buildable)
  sleepercell:  { hp: 60,  w: 22, h: 22, cost: 0,   buildTime: 0,  sight: 260, power: 0 },
};

// ---------- game state ----------

let nextId = 1;
let started = false;
const state = {
  factions: { [PLAYER]: 'flat', [ENEMY]: 'glob' },
  minerals: { [PLAYER]: 300, [ENEMY]: 300 },
  construction: { [PLAYER]: null, [ENEMY]: null }, // {type,t,duration,ready,announced}
  units: [],
  buildings: [],
  patches: [],
  flashes: [],
  zones: [],   // temporary area effects, e.g. weather modification
  sig: { [PLAYER]: { cd: 0, timer: 0, used: false }, [ENEMY]: { cd: 0, timer: 0, used: false } },
  infiltrator: { [PLAYER]: null, [ENEMY]: null }, // reptilian sleeper worker ids
  time: 0,
  over: false,
};

const cam = { x: 0, y: 0, zoom: 1 };
const keys = {};
const mouse = { x: 0, y: 0, sx: 0, sy: 0, inside: false, sel: null };
let selection = [];
let placing = null;
let attackMoveArmed = false;
let abilityTargeting = null; // 'zone' | 'unit' while a faction power waits for a click
let panDrag = null;
let mmDown = false;
const groups = {};

const facOf = owner => FACTIONS[state.factions[owner]];
const buildingName = b => facOf(b.owner).buildingNames[b.type] || b.type;

// ---------- audio: EVA announcer + synth sfx ----------

let muted = false;
let audioCtx = null;
const evaLast = {};
let sfxCount = 0, sfxWindow = 0;

function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
document.addEventListener('pointerdown', ensureAudio, { once: false });

function eva(text) {
  if (muted || !window.speechSynthesis) return;
  const now = performance.now();
  if (evaLast[text] && now - evaLast[text] < 6000) return;
  evaLast[text] = now;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0; u.pitch = 0.7; u.volume = 0.9;
  speechSynthesis.speak(u);
}

function sfx(kind) {
  if (muted || !audioCtx || audioCtx.state !== 'running') return;
  const now = performance.now();
  if (now - sfxWindow > 120) { sfxWindow = now; sfxCount = 0; }
  if (++sfxCount > 4) return; // throttle
  const t0 = audioCtx.currentTime;
  const gain = audioCtx.createGain();
  gain.connect(audioCtx.destination);

  if (kind === 'shot') {
    const o = audioCtx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(700, t0);
    o.frequency.exponentialRampToValueAtTime(180, t0 + 0.07);
    gain.gain.setValueAtTime(0.04, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
    o.connect(gain); o.start(t0); o.stop(t0 + 0.09);
  } else if (kind === 'laser') {
    const o = audioCtx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(1400, t0);
    o.frequency.exponentialRampToValueAtTime(250, t0 + 0.09);
    gain.gain.setValueAtTime(0.03, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.1);
    o.connect(gain); o.start(t0); o.stop(t0 + 0.11);
  } else if (kind === 'boom') {
    const len = 0.35, buf = audioCtx.createBuffer(1, audioCtx.sampleRate * len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 350;
    gain.gain.setValueAtTime(0.22, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + len);
    src.connect(lp); lp.connect(gain); src.start(t0);
  } else if (kind === 'click') {
    const o = audioCtx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 900;
    gain.gain.setValueAtTime(0.05, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.03);
    o.connect(gain); o.start(t0); o.stop(t0 + 0.04);
  }
}

function setMuted(m) {
  muted = m;
  document.getElementById('mute-btn').textContent = muted ? '🔇' : '🔊';
  if (muted && window.speechSynthesis) speechSynthesis.cancel();
}
document.getElementById('mute-btn').addEventListener('click', () => setMuted(!muted));

// ---------- helpers ----------

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function nearest(from, list, filter) {
  let best = null, bd = Infinity;
  for (const e of list) {
    if (filter && !filter(e)) continue;
    const d = dist(from, e);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

function enemiesOf(owner) {
  return state.units.filter(u => u.owner !== owner && u.hp > 0)
    .concat(state.buildings.filter(b => b.owner !== owner && b.hp > 0));
}

function entityRadius(e) {
  return e.w ? Math.max(e.w, e.h) / 2 : UNIT_TYPES[e.type].r;
}

// can something with these weapon stats hit this target?
function canTarget(stats, target) {
  if (!stats.dmg) return false;
  const isAir = target.kind === 'unit' && UNIT_TYPES[target.type].flying;
  const t = stats.targets || 'ground';
  return isAir ? (t === 'air' || t === 'both') : (t === 'ground' || t === 'both');
}

const hitsAir = stats => stats.targets === 'air' || stats.targets === 'both';

// ---------- power ----------

function powerOf(owner) {
  let cap = 0, used = 0;
  for (const b of state.buildings) {
    if (b.owner !== owner || b.hp <= 0 || !b.done) continue;
    const p = BUILDING_TYPES[b.type].power || 0;
    if (p > 0) cap += p; else used -= p;
  }
  return { cap, used, low: used > cap };
}

// ---------- fog of war ----------

const FOG_TILE = 50;
const FW = WORLD_W / FOG_TILE, FH = WORLD_H / FOG_TILE;
const vis = new Uint8Array(FW * FH);
const fogCanvas = document.createElement('canvas');
fogCanvas.width = FW; fogCanvas.height = FH;
const fogCtx = fogCanvas.getContext('2d');

function tileState(x, y) {
  const tx = clamp(Math.floor(x / FOG_TILE), 0, FW - 1);
  const ty = clamp(Math.floor(y / FOG_TILE), 0, FH - 1);
  return vis[ty * FW + tx];
}

function markSight(x, y, sight) {
  const tx0 = Math.max(0, Math.floor((x - sight) / FOG_TILE));
  const tx1 = Math.min(FW - 1, Math.floor((x + sight) / FOG_TILE));
  const ty0 = Math.max(0, Math.floor((y - sight) / FOG_TILE));
  const ty1 = Math.min(FH - 1, Math.floor((y + sight) / FOG_TILE));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const cx = tx * FOG_TILE + FOG_TILE / 2, cy = ty * FOG_TILE + FOG_TILE / 2;
      if ((cx - x) ** 2 + (cy - y) ** 2 <= sight * sight) vis[ty * FW + tx] = 2;
    }
  }
}

function updateFog() {
  for (let i = 0; i < vis.length; i++) if (vis[i] === 2) vis[i] = 1;
  for (const u of state.units) {
    if (u.owner === PLAYER && u.hp > 0) markSight(u.x, u.y, UNIT_TYPES[u.type].sight);
  }
  for (const b of state.buildings) {
    if (b.owner === PLAYER && b.hp > 0) markSight(b.x, b.y, BUILDING_TYPES[b.type].sight);
  }
}

function visibleToPlayer(e) {
  if (e.owner === PLAYER) return true;
  const t = tileState(e.x, e.y);
  return e.kind === 'building' ? t >= 1 : t === 2;
}

// ---------- entity creation ----------

function makeUnit(owner, type, x, y) {
  const t = UNIT_TYPES[type];
  const u = {
    id: nextId++, kind: 'unit', owner, type,
    x, y, hp: t.hp, maxHp: t.hp,
    order: { type: 'idle' },
    carrying: 0, mineTimer: 0, cooldown: 0,
  };
  // reptilian skin suit: barracks infantry pass as friendly until they attack
  if (state.factions[owner] === 'reptilian' && t.builtAt === 'barracks' && t.role === 'combat') {
    u.disguised = true;
  }
  state.units.push(u);
  return u;
}

function makeBuilding(owner, type, x, y) {
  const t = BUILDING_TYPES[type];
  const b = {
    id: nextId++, kind: 'building', owner, type,
    x, y, w: t.w, h: t.h,
    hp: t.hp, maxHp: t.hp,
    done: true, queue: [], cooldown: 0, rally: null,
  };
  state.buildings.push(b);
  return b;
}

function makePatch(x, y, amount = 900) {
  state.patches.push({ id: nextId++, kind: 'patch', x, y, amount });
}

// ---------- world setup ----------

function setupWorld(playerFaction) {
  state.factions[PLAYER] = playerFaction; // enemy faction is set by startGame

  makeBuilding(PLAYER, 'hq', 220, WORLD_H - 220);
  makeBuilding(ENEMY, 'hq', WORLD_W - 220, 220);

  const clusters = [
    [120, WORLD_H - 420], [400, WORLD_H - 130],
    [WORLD_W - 120, 420], [WORLD_W - 400, 130],
    [WORLD_W / 2 - 60, WORLD_H / 2], [WORLD_W / 2 + 60, WORLD_H / 2 + 80],
    [260, 260], [WORLD_W - 260, WORLD_H - 260],
  ];
  for (const [cx, cy] of clusters) {
    for (let i = 0; i < 3; i++) makePatch(cx + (i - 1) * 42, cy + (i % 2) * 34);
  }

  for (let i = 0; i < 3; i++) {
    makeUnit(PLAYER, facOf(PLAYER).worker, 320 + i * 26, WORLD_H - 300);
    makeUnit(ENEMY, facOf(ENEMY).worker, WORLD_W - 320 - i * 26, 300);
  }

  // faction setup powers
  for (const owner of [PLAYER, ENEMY]) {
    const opp = owner === PLAYER ? ENEMY : PLAYER;
    if (state.factions[owner] === 'resistance') {
      // sleeper cells: hidden observation camps around the map
      for (const [sx, sy] of [[1000, 130], [330, 500], [1670, 900]]) {
        makeBuilding(owner, 'sleepercell', sx, sy);
      }
    }
    if (state.factions[owner] === 'reptilian') {
      const w = state.units.find(u => u.owner === opp && UNIT_TYPES[u.type].role === 'worker');
      if (w) state.infiltrator[owner] = w.id;
    }
  }

  centerCameraOnHome();
  updateFog();
}

function centerCameraOnHome() {
  const hq = state.buildings.find(b => b.owner === PLAYER && b.type === 'hq');
  if (!hq) return;
  cam.x = hq.x - canvas.width / cam.zoom / 2;
  cam.y = hq.y - canvas.height / cam.zoom / 2;
  clampCam();
}

// ---------- camera ----------

function minZoom() {
  return Math.max(canvas.width / WORLD_W, canvas.height / WORLD_H, 0.5);
}

function clampCam() {
  cam.zoom = clamp(cam.zoom, minZoom(), 2);
  cam.x = clamp(cam.x, 0, Math.max(0, WORLD_W - canvas.width / cam.zoom));
  cam.y = clamp(cam.y, 0, Math.max(0, WORLD_H - canvas.height / cam.zoom));
}

function resizeCanvas() {
  canvas.width = clamp(window.innerWidth - 212 - 40, 600, 1500);
  canvas.height = clamp(window.innerHeight - 140, 400, 1000);
  const total = canvas.width + 212 + 6;
  document.getElementById('topbar').style.width = total + 'px';
  document.getElementById('bottombar').style.width = total + 'px';
  document.getElementById('sidebar').style.height = canvas.height + 'px';
  clampCam();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ---------- construction (RA2 sidebar style) ----------

function countStruct(owner, type) {
  return state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.type === type).length;
}

function atStructCap(owner, type) {
  const cap = BUILDING_TYPES[type].cap;
  return cap !== undefined && countStruct(owner, type) >= cap;
}

function startConstruction(owner, type) {
  if (state.construction[owner]) return false;
  if (atStructCap(owner, type)) return false;
  const cost = BUILDING_TYPES[type].cost;
  if (state.minerals[owner] < cost) return false;
  state.minerals[owner] -= cost;
  state.construction[owner] = { type, t: 0, duration: BUILDING_TYPES[type].buildTime, ready: false, announced: false };
  return true;
}

function placementBlocked(type, x, y) {
  const t = BUILDING_TYPES[type];
  if (x - t.w / 2 < 10 || y - t.h / 2 < 10 || x + t.w / 2 > WORLD_W - 10 || y + t.h / 2 > WORLD_H - 10) return true;
  return state.buildings.some(b => b.hp > 0 &&
      Math.abs(b.x - x) < (b.w + t.w) / 2 + 8 && Math.abs(b.y - y) < (b.h + t.h) / 2 + 8)
    || state.patches.some(p => p.amount > 0 && dist(p, { x, y }) < t.w / 2 + 30)
    || TERRAIN.some(o => dist(o, { x, y }) < o.r + Math.max(t.w, t.h) / 2 + 6);
}

// expansion is anchored to the power grid: structures must sit near the HQ or
// a power plant, so extending the base means extending the grid
function withinBuildRadius(owner, x, y) {
  return state.buildings.some(b => b.owner === owner && b.hp > 0 && b.done &&
    (b.type === 'hq' || b.type === 'powerplant') && dist(b, { x, y }) <= BUILD_RADIUS);
}

function tryPlace(owner, x, y) {
  const c = state.construction[owner];
  if (!c || !c.ready) return false;
  if (placementBlocked(c.type, x, y) || !withinBuildRadius(owner, x, y)) return false;
  makeBuilding(owner, c.type, x, y);
  state.construction[owner] = null;
  return true;
}

function tickConstruction(owner, dt) {
  const c = state.construction[owner];
  if (!c || c.ready) return;
  c.t += dt * (powerOf(owner).low ? 0.5 : 1);
  if (c.t >= c.duration) {
    c.ready = true;
    if (owner === PLAYER && !c.announced) { c.announced = true; eva('Construction complete'); }
  }
}

// ---------- faction powers ----------

const oppOf = owner => owner === PLAYER ? ENEMY : PLAYER;

function castWeather(owner, x, y) {
  state.zones.push({ x, y, r: 150, until: state.time + 15, caster: owner });
  state.sig[owner].cd = FACTIONS[state.factions[owner]].powers.sig.cd;
  if (owner === PLAYER) eva('Weather modification deployed');
}

function castClone(owner, unit) {
  const home = state.buildings.find(b => b.owner === owner && b.hp > 0 && b.done && b.type === 'barracks')
    || state.buildings.find(b => b.owner === owner && b.hp > 0 && b.type === 'hq');
  if (!home) return false;
  makeUnit(owner, unit.type, home.x + 20, home.y + home.h / 2 + 22);
  state.sig[owner].cd = FACTIONS[state.factions[owner]].powers.sig.cd;
  if (owner === PLAYER) eva('Clone ready');
  return true;
}

function castGaslight(owner) {
  const hq = state.buildings.find(b => b.owner === oppOf(owner) && b.type === 'hq' && b.hp > 0);
  if (!hq) return;
  for (let i = 0; i < 4; i++) {
    const p = makeUnit(owner, 'phantom', hq.x + Math.cos(i * 1.7) * 180, hq.y + Math.sin(i * 1.7) * 180);
    p.expires = state.time + 20;
  }
  state.sig[owner].cd = FACTIONS[state.factions[owner]].powers.sig.cd;
  if (owner === PLAYER) eva('They are chasing ghosts');
}

function castRevealInfiltrator(owner) {
  const sig = state.sig[owner];
  if (sig.used) return false;
  const u = state.units.find(x => x.id === state.infiltrator[owner] && x.hp > 0);
  sig.used = true;
  if (!u) { if (owner === PLAYER) eva('The infiltrator was lost'); return false; }
  u.owner = owner;
  u.order = { type: 'idle' };
  if (owner === PLAYER) eva('The infiltrator answers the call');
  else eva('One of our workers was never ours');
  return true;
}

function documentaryDrop(owner) {
  const pool = state.units.filter(u => u.owner === oppOf(owner) && u.hp > 0 && u.type !== 'phantom');
  if (!pool.length) return;
  const u = pool[Math.floor(Math.random() * pool.length)];
  u.owner = owner;
  u.disguised = false;
  u.order = { type: 'idle' };
  u.carrying = 0;
  eva(owner === PLAYER ? 'They have seen the truth' : 'We have lost someone to their propaganda');
}

function spawnSmuggler(owner) {
  const hq = state.buildings.find(b => b.owner === owner && b.type === 'hq' && b.hp > 0);
  if (!hq) return;
  const edges = [
    { x: 20, y: WORLD_H / 2 }, { x: WORLD_W - 20, y: WORLD_H / 2 },
    { x: WORLD_W / 2, y: 20 }, { x: WORLD_W / 2, y: WORLD_H - 20 },
  ];
  const e = edges[Math.floor(Math.random() * edges.length)];
  const u = makeUnit(owner, 'smuggler', e.x, e.y);
  u.order = { type: 'deliver' };
  if (owner === PLAYER) eva('Supply truck inbound');
}

function spawnDeepCoverRecruit(owner) {
  const bar = state.buildings.find(b => b.owner === owner && b.hp > 0 && b.done && b.type === 'barracks');
  if (!bar) return;
  const ef = facOf(oppOf(owner));
  const pool = [ef.infantry, ef.aa, ef.extras[0]];
  const type = pool[Math.floor(Math.random() * pool.length)];
  const u = makeUnit(owner, type, bar.x, bar.y + bar.h / 2 + 22);
  u.disguised = false; // moles fight openly for you
  if (owner === PLAYER) eva('A mole has reported for duty');
}

function updateAbilities(dt) {
  state.zones = state.zones.filter(z => z.until > state.time);
  for (const owner of [PLAYER, ENEMY]) {
    const sig = state.sig[owner];
    sig.cd = Math.max(0, sig.cd - dt);
    const fkey = state.factions[owner];
    sig.timer += dt;
    if (fkey === 'glob' && sig.timer >= 10) {
      sig.timer -= 10;
      state.minerals[owner] = Math.floor(state.minerals[owner] * 1.02);
    } else if (fkey === 'flat' && sig.timer >= 180) {
      sig.timer -= 180;
      documentaryDrop(owner);
    } else if (fkey === 'resistance' && sig.timer >= 120) {
      sig.timer -= 120;
      spawnSmuggler(owner);
    } else if (fkey === 'deep' && sig.timer >= 120) {
      sig.timer -= 120;
      spawnDeepCoverRecruit(owner);
    }
    // AI casts its manual powers on simple rules
    if (owner === ENEMY) {
      if (fkey === 'deep' && sig.cd <= 0) castGaslight(ENEMY);
      if (fkey === 'reptilian' && !sig.used && ai.time > 240) castRevealInfiltrator(ENEMY);
    }
  }
}

// ---------- orders ----------

function orderMove(u, x, y) { u.order = { type: 'move', x, y }; }
function orderAttack(u, target) { u.order = { type: 'attack', targetId: target.id }; }
function orderAttackMove(u, x, y) { u.order = { type: 'attackmove', x, y }; }
function orderHarvest(u, patch) { u.order = { type: 'harvest', patchId: patch.id }; u.mineTimer = 0; }

function findEntity(id) {
  return state.units.find(u => u.id === id) || state.buildings.find(b => b.id === id);
}

// ---------- unit update ----------

function moveToward(u, tx, ty, dt, stopDist = 2) {
  const d = Math.hypot(tx - u.x, ty - u.y);
  if (d <= stopDist) return true;
  const t = UNIT_TYPES[u.type];
  let speed = t.speed;
  // weather modification: enemy zones slow ground units
  if (!t.flying) {
    for (const z of state.zones) {
      if (z.caster !== u.owner && dist(z, u) <= z.r) { speed *= 0.6; break; }
    }
  }
  const step = Math.min(speed * dt, d);
  let nx = u.x + (tx - u.x) / d * step;
  let ny = u.y + (ty - u.y) / d * step;

  // ground units steer around terrain (air flies over)
  if (!t.flying) {
    const ob = TERRAIN.find(o => Math.hypot(nx - o.x, ny - o.y) < o.r + t.r);
    if (ob) {
      const away = Math.atan2(u.y - ob.y, u.x - ob.x);
      const desired = Math.atan2(ty - u.y, tx - u.x);
      const diff = a => Math.abs(((a - desired + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const tang = diff(away + Math.PI / 2) < diff(away - Math.PI / 2) ? away + Math.PI / 2 : away - Math.PI / 2;
      nx = u.x + Math.cos(tang) * step;
      ny = u.y + Math.sin(tang) * step;
      if (Math.hypot(nx - ob.x, ny - ob.y) < ob.r + t.r) {
        nx = ob.x + Math.cos(away) * (ob.r + t.r + 1);
        ny = ob.y + Math.sin(away) * (ob.r + t.r + 1);
      }
    }
  }
  u.x = clamp(nx, 10, WORLD_W - 10);
  u.y = clamp(ny, 10, WORLD_H - 10);
  return false;
}

let lastUnderAttack = -1e9;

function dealDamage(attacker, target, dmg, stats) {
  // grey superior metallurgy: buildings ignore anti-building bonuses
  if (target.kind === 'building' && stats.bldgBonus && state.factions[target.owner] !== 'grey') {
    dmg *= stats.bldgBonus;
  }
  target.hp -= dmg;
  if (target.owner === PLAYER) {
    const now = performance.now();
    if (now - lastUnderAttack > 20000) {
      lastUnderAttack = now;
      eva('Our base is under attack');
    }
  }
}

function tryAttack(u, target, dt) {
  const t = UNIT_TYPES[u.type];
  const range = t.atkRange + entityRadius(target);
  const d = dist(u, target);
  if (d > range) {
    moveToward(u, target.x, target.y, dt, range - 4);
    return;
  }
  if (t.minRange && d < t.minRange) return; // artillery: too close to fire
  if (u.cooldown <= 0) {
    const isAir = target.kind === 'unit' && UNIT_TYPES[target.type].flying;
    const dmg = (!isAir && t.dmgVsGround !== undefined) ? t.dmgVsGround : t.dmg;
    u.disguised = false; // skin suit drops the moment they open fire
    dealDamage(u, target, dmg, t);
    u.cooldown = t.cooldown;
    state.flashes.push({ x1: u.x, y1: u.y, x2: target.x, y2: target.y, t: 0.09, owner: u.owner });
    if (tileState(u.x, u.y) === 2 || tileState(target.x, target.y) === 2) {
      sfx(state.factions[u.owner] === 'glob' ? 'laser' : 'shot');
    }
    if (target.hp <= 0 && u.order.type === 'attack') u.order = { type: 'idle' };
  }
}

function autoAcquire(u) {
  const t = UNIT_TYPES[u.type];
  const foe = nearest(u, enemiesOf(u.owner), e =>
    !e.disguised && canTarget(t, e) && dist(u, e) <= t.sight && dist(u, e) >= (t.minRange || 0));
  if (foe) orderAttack(u, foe);
}

function depositTarget(u) {
  return nearest(u, state.buildings, b => b.owner === u.owner && b.type === 'hq' && b.hp > 0);
}

function updateUnit(u, dt) {
  u.cooldown = Math.max(0, u.cooldown - dt);
  const o = u.order;
  const stats = UNIT_TYPES[u.type];

  switch (o.type) {
    case 'idle':
      if (stats.role === 'combat') autoAcquire(u);
      break;

    case 'move':
      if (moveToward(u, o.x, o.y, dt, 6)) u.order = { type: 'idle' };
      break;

    case 'attackmove': {
      const foe = nearest(u, enemiesOf(u.owner), e =>
        !e.disguised && canTarget(stats, e) && dist(u, e) <= stats.sight && dist(u, e) >= (stats.minRange || 0));
      if (foe) { tryAttack(u, foe, dt); break; }
      if (moveToward(u, o.x, o.y, dt, 8)) u.order = { type: 'idle' };
      break;
    }

    case 'attack': {
      const target = findEntity(o.targetId);
      if (!target || target.hp <= 0 || !canTarget(stats, target)) { u.order = { type: 'idle' }; break; }
      tryAttack(u, target, dt);
      break;
    }

    case 'harvest': {
      const patch = state.patches.find(p => p.id === o.patchId);
      if (!patch || patch.amount <= 0) {
        const next = nearest(u, state.patches, p => p.amount > 0 && dist(u, p) < 500);
        if (next) orderHarvest(u, next); else u.order = { type: 'idle' };
        break;
      }
      if (u.carrying >= HARVEST_AMOUNT) { u.order = { type: 'return', patchId: patch.id }; break; }
      if (moveToward(u, patch.x, patch.y, dt, 16)) {
        u.mineTimer += dt;
        if (u.mineTimer >= HARVEST_TIME) {
          u.mineTimer = 0;
          const take = Math.min(HARVEST_AMOUNT, patch.amount);
          patch.amount -= take;
          u.carrying = take;
          u.order = { type: 'return', patchId: patch.id };
        }
      }
      break;
    }

    case 'tunnel': {
      // hollow earth: walk to the nearest grid node, pop out at the destination
      const dest = findEntity(o.destId);
      if (!dest || dest.hp <= 0) { u.order = { type: 'idle' }; break; }
      const entrance = nearest(u, state.buildings, b =>
        b.owner === u.owner && b.hp > 0 && b.done && (b.type === 'hq' || b.type === 'powerplant'));
      if (!entrance) { u.order = { type: 'idle' }; break; }
      if (moveToward(u, entrance.x, entrance.y, dt, entityRadius(entrance) + 8)) {
        u.x = dest.x + Math.sin(u.id * 2.7) * 40;
        u.y = dest.y + dest.h / 2 + 20;
        u.order = { type: 'idle' };
      }
      break;
    }

    case 'deliver': {
      // resistance smuggler truck hauling minerals home
      const hq = state.buildings.find(b => b.owner === u.owner && b.type === 'hq' && b.hp > 0);
      if (!hq) { u.order = { type: 'idle' }; break; }
      if (moveToward(u, hq.x, hq.y, dt, entityRadius(hq) + 12)) {
        state.minerals[u.owner] += 150;
        u.hp = 0;
        if (u.owner === PLAYER) eva('Supplies delivered');
      }
      break;
    }

    case 'return': {
      const depot = depositTarget(u);
      if (!depot) { u.order = { type: 'idle' }; break; }
      const stop = entityRadius(depot) + 10;
      if (moveToward(u, depot.x, depot.y, dt, stop)) {
        state.minerals[u.owner] += u.carrying;
        u.carrying = 0;
        const patch = state.patches.find(p => p.id === o.patchId && p.amount > 0);
        if (patch) orderHarvest(u, patch);
        else {
          const next = nearest(u, state.patches, p => p.amount > 0);
          if (next) orderHarvest(u, next); else u.order = { type: 'idle' };
        }
      }
      break;
    }
  }

  // separation only within the same layer (ground vs ground, air vs air)
  const myFlying = !!stats.flying;
  for (const other of state.units) {
    if (other === u || other.hp <= 0) continue;
    if (!!UNIT_TYPES[other.type].flying !== myFlying) continue;
    const d = dist(u, other);
    const minD = stats.r + UNIT_TYPES[other.type].r;
    if (d > 0 && d < minD) {
      const push = (minD - d) / 2;
      u.x += (u.x - other.x) / d * push;
      u.y += (u.y - other.y) / d * push;
    }
  }
}

// ---------- buildings: towers + production ----------

function trainUnit(owner, unitType) {
  const ut = UNIT_TYPES[unitType];
  const trainers = state.buildings.filter(b =>
    b.owner === owner && b.hp > 0 && b.done && b.type === ut.builtAt && b.queue.length < 5);
  if (!trainers.length) return false;
  if (state.minerals[owner] < ut.cost) return false;
  trainers.sort((a, b) => a.queue.length - b.queue.length);
  state.minerals[owner] -= ut.cost;
  trainers[0].queue.push({ type: unitType, t: 0, duration: ut.buildTime });
  return true;
}

function updateBuilding(b, dt) {
  const bt = BUILDING_TYPES[b.type];
  const power = powerOf(b.owner);

  // towers shoot (unless the grid is down)
  if (bt.dmg && !power.low) {
    b.cooldown = Math.max(0, b.cooldown - dt);
    if (b.cooldown <= 0) {
      const foe = nearest(b, enemiesOf(b.owner), e => !e.disguised && canTarget(bt, e) && dist(b, e) <= bt.atkRange + entityRadius(e));
      if (foe) {
        dealDamage(b, foe, bt.dmg, bt);
        b.cooldown = bt.cooldown;
        state.flashes.push({ x1: b.x, y1: b.y - b.h / 2, x2: foe.x, y2: foe.y, t: 0.09, owner: b.owner });
        if (tileState(b.x, b.y) === 2 || tileState(foe.x, foe.y) === 2) {
          sfx(state.factions[b.owner] === 'glob' ? 'laser' : 'shot');
        }
      }
    }
  }

  if (b.queue.length === 0) return;
  const job = b.queue[0];
  job.t += dt * (power.low ? 0.5 : 1);
  if (job.t >= job.duration) {
    b.queue.shift();
    const u = makeUnit(b.owner, job.type, b.x + Math.sin(nextId) * 30, b.y + b.h / 2 + 22);
    if (b.owner === PLAYER) eva('Unit ready');
    const ut = UNIT_TYPES[job.type];
    if (b.rally) {
      const rp = state.patches.find(p => p.amount > 0 && dist(p, b.rally) < 40);
      if (ut.role === 'worker' && rp) orderHarvest(u, rp);
      else if (ut.role === 'combat') orderAttackMove(u, b.rally.x, b.rally.y);
      else orderMove(u, b.rally.x, b.rally.y);
    } else if (ut.role === 'worker') {
      const patch = nearest(u, state.patches, p => p.amount > 0 && dist(u, p) < 600);
      if (patch) orderHarvest(u, patch);
    }
  }
}

// ---------- enemy AI ----------

const ai = { attackWaveSize: 5, thinkTimer: 0, time: 0, infantryCount: 0 };

function aiPickSpot(type) {
  const hq = state.buildings.find(b => b.owner === ENEMY && b.type === 'hq' && b.hp > 0);
  if (!hq) return null;
  const towardCenter = { x: WORLD_W / 2 - hq.x, y: WORLD_H / 2 - hq.y };
  const len = Math.hypot(towardCenter.x, towardCenter.y);
  const dir = { x: towardCenter.x / len, y: towardCenter.y / len };
  let base;
  const f = facOf(ENEMY);
  if (type === 'powerplant') base = { x: hq.x - dir.x * 180, y: hq.y - dir.y * 180 };
  else if (type === f.tower || type === f.aaTower) base = { x: hq.x + dir.x * 240, y: hq.y + dir.y * 240 };
  else base = { x: hq.x - 160, y: hq.y + 140 };

  for (let k = 0; k < 14; k++) {
    const x = base.x + Math.cos(k * 2.4) * (k * 26);
    const y = base.y + Math.sin(k * 2.4) * (k * 26);
    if (!placementBlocked(type, x, y) && withinBuildRadius(ENEMY, x, y)) return { x, y };
  }
  return null;
}

function aiDesiredStructure(counts, power) {
  const f = facOf(ENEMY);
  if (power.used + 30 > power.cap && !atStructCap(ENEMY, 'powerplant')) return 'powerplant';
  // walk the build order; each repeat of a type raises its desired count
  const order = ['barracks', f.tower, 'factory', f.aaTower, 'airpad', 'barracks', f.tower, f.aaTower];
  const want = {};
  for (const t of order) {
    want[t] = (want[t] || 0) + 1;
    if ((counts[t] || 0) < want[t] && !atStructCap(ENEMY, t)) return t;
  }
  return null;
}

function updateAI(dt) {
  ai.time += dt;
  tickConstruction(ENEMY, dt);
  ai.thinkTimer -= dt;
  if (ai.thinkTimer > 0) return;
  ai.thinkTimer = 1.0;

  const f = facOf(ENEMY);
  const myUnits = state.units.filter(u => u.owner === ENEMY && u.hp > 0);
  const workers = myUnits.filter(u => UNIT_TYPES[u.type].role === 'worker');
  const army = myUnits.filter(u => UNIT_TYPES[u.type].role === 'combat');
  const hq = state.buildings.find(b => b.owner === ENEMY && b.type === 'hq' && b.hp > 0);
  if (!hq) return;

  const counts = {};
  for (const b of state.buildings) {
    if (b.owner === ENEMY && b.hp > 0) counts[b.type] = (counts[b.type] || 0) + 1;
  }
  const power = powerOf(ENEMY);

  // place finished construction
  const c = state.construction[ENEMY];
  if (c && c.ready) {
    const spot = aiPickSpot(c.type);
    if (spot) tryPlace(ENEMY, spot.x, spot.y);
  }

  // idle workers mine
  for (const w of workers) {
    if (w.order.type === 'idle') {
      const patch = nearest(w, state.patches, p => p.amount > 0);
      if (patch) orderHarvest(w, patch);
    }
  }

  // start next structure; reserve its cost so unit spam can't starve it
  const desired = !state.construction[ENEMY] ? aiDesiredStructure(counts, power) : null;
  if (desired && workers.length >= 3 && state.minerals[ENEMY] >= BUILDING_TYPES[desired].cost) {
    startConstruction(ENEMY, desired);
  }
  const reserve = (!state.construction[ENEMY] && desired) ? BUILDING_TYPES[desired].cost : 0;

  // workers
  if (workers.length < 6 && state.minerals[ENEMY] >= UNIT_TYPES[f.worker].cost + reserve) {
    trainUnit(ENEMY, f.worker);
  }

  // train toward a target composition: pick the most-lacking type and save for
  // it — training whatever is affordable would starve the expensive units
  const mix = [];
  if (counts.barracks) mix.push([f.infantry, 4], [f.aa, 1.2], [f.extras[0], 0.8]);
  if (counts.factory) mix.push([f.vehicle, 1.6], [f.extras[1], 0.8]);
  if (counts.airpad) mix.push([f.air[1], 1.2], [f.extras[2], 0.6]);
  if (mix.length) {
    const byType = {};
    for (const u of army) byType[u.type] = (byType[u.type] || 0) + 1;
    for (const b of state.buildings) {
      if (b.owner === ENEMY && b.hp > 0) {
        for (const j of b.queue) byType[j.type] = (byType[j.type] || 0) + 1;
      }
    }
    const totalW = mix.reduce((s, [, w]) => s + w, 0);
    const totalArmy = mix.reduce((s, [t]) => s + (byType[t] || 0), 0);
    let pick = null, worst = -Infinity;
    for (const [t, w] of mix) {
      const deficit = w / totalW - (byType[t] || 0) / (totalArmy || 1);
      if (deficit > worst) { worst = deficit; pick = t; }
    }
    if (pick && state.minerals[ENEMY] >= UNIT_TYPES[pick].cost + reserve) trainUnit(ENEMY, pick);
  }

  // defense (disguised reptilian infantry don't register as hostile)
  const threat = nearest(hq, state.units.filter(u => u.owner === PLAYER && u.hp > 0), u => !u.disguised && dist(hq, u) < 450);
  if (threat) {
    for (const s of army) {
      if (canTarget(UNIT_TYPES[s.type], threat)) orderAttack(s, threat);
    }
    return;
  }

  // attack waves
  const idleArmy = army.filter(s => s.order.type === 'idle');
  if (ai.time > AI_GRACE_PERIOD && idleArmy.length >= ai.attackWaveSize) {
    const target = nearest(hq, state.buildings.filter(b => b.owner === PLAYER && b.hp > 0))
      || nearest(hq, state.units.filter(u => u.owner === PLAYER && u.hp > 0));
    if (target) {
      for (const s of idleArmy) orderAttackMove(s, target.x, target.y);
      ai.attackWaveSize = Math.min(12, ai.attackWaveSize + 1);
    }
  }
}

// ---------- input ----------

canvas.addEventListener('contextmenu', e => e.preventDefault());

function screenToWorld(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / cam.zoom + cam.x,
    y: (e.clientY - r.top) / cam.zoom + cam.y,
  };
}

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (!started) return;
  const before = screenToWorld(e);
  cam.zoom = clamp(cam.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), minZoom(), 2);
  const r = canvas.getBoundingClientRect();
  cam.x = before.x - (e.clientX - r.left) / cam.zoom;
  cam.y = before.y - (e.clientY - r.top) / cam.zoom;
  clampCam();
}, { passive: false });

canvas.addEventListener('mousedown', e => {
  if (!started) return;
  const p = screenToWorld(e);
  if (e.button === 1) {
    e.preventDefault();
    panDrag = { sx: e.clientX, sy: e.clientY, camX: cam.x, camY: cam.y };
    return;
  }
  if (e.button === 0) {
    if (abilityTargeting) {
      const mode = abilityTargeting;
      abilityTargeting = null;
      if (mode === 'zone') castWeather(PLAYER, p.x, p.y);
      if (mode === 'unit') {
        const target = state.units.find(u => u.owner === PLAYER && u.hp > 0 && dist(u, p) <= UNIT_TYPES[u.type].r + 8);
        if (target) castClone(PLAYER, target);
      }
      refreshPanel();
      refreshSidebar();
      return;
    }
    if (placing) {
      if (tryPlace(PLAYER, p.x, p.y)) { placing = null; sfx('click'); refreshPanel(); refreshSidebar(); }
      return;
    }
    if (attackMoveArmed) {
      attackMoveArmed = false;
      for (const u of selection) {
        if (u.kind === 'unit' && u.owner === PLAYER && UNIT_TYPES[u.type].role === 'combat') orderAttackMove(u, p.x, p.y);
      }
      refreshPanel();
      return;
    }
    mouse.sel = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
  } else if (e.button === 2) {
    placing = null;
    attackMoveArmed = false;
    // rally point when a single production building is selected
    if (selection.length === 1 && selection[0].kind === 'building' && selection[0].owner === PLAYER) {
      selection[0].rally = { x: p.x, y: p.y };
      sfx('click');
      return;
    }
    issueCommand(p.x, p.y);
  }
});

canvas.addEventListener('mousemove', e => {
  const p = screenToWorld(e);
  mouse.x = p.x; mouse.y = p.y;
  const r = canvas.getBoundingClientRect();
  mouse.sx = e.clientX - r.left; mouse.sy = e.clientY - r.top;
  mouse.inside = true;
  if (mouse.sel) { mouse.sel.x2 = p.x; mouse.sel.y2 = p.y; }
});

canvas.addEventListener('mouseleave', () => { mouse.inside = false; });

window.addEventListener('mousemove', e => {
  if (panDrag) {
    cam.x = panDrag.camX - (e.clientX - panDrag.sx) / cam.zoom;
    cam.y = panDrag.camY - (e.clientY - panDrag.sy) / cam.zoom;
    clampCam();
  }
});

window.addEventListener('mouseup', e => {
  if (e.button === 1) { panDrag = null; return; }
  if (e.button !== 0) return;
  mmDown = false;
  if (!mouse.sel) return;
  const s = mouse.sel;
  const p = screenToWorld(e);
  s.x2 = p.x; s.y2 = p.y;
  mouse.sel = null;
  const x1 = Math.min(s.x1, s.x2), x2 = Math.max(s.x1, s.x2);
  const y1 = Math.min(s.y1, s.y2), y2 = Math.max(s.y1, s.y2);
  const isClick = (x2 - x1 < 6 && y2 - y1 < 6);

  if (isClick) {
    const u = state.units.find(u => u.owner === PLAYER && u.hp > 0 && dist(u, { x: x1, y: y1 }) <= UNIT_TYPES[u.type].r + 4);
    const b = state.buildings.find(b => b.owner === PLAYER && b.hp > 0 &&
      Math.abs(b.x - x1) <= b.w / 2 && Math.abs(b.y - y1) <= b.h / 2);
    // no own entity under the cursor: inspect a visible enemy instead
    // (disguised infiltrators are excluded — clicking would blow their cover)
    const eu = !u && !b && state.units.find(un => un.owner !== PLAYER && un.hp > 0 && !un.disguised &&
      visibleToPlayer(un) && dist(un, { x: x1, y: y1 }) <= UNIT_TYPES[un.type].r + 4);
    const eb = !u && !b && !eu && state.buildings.find(bd => bd.owner !== PLAYER && bd.hp > 0 &&
      visibleToPlayer(bd) && Math.abs(bd.x - x1) <= bd.w / 2 && Math.abs(bd.y - y1) <= bd.h / 2);
    selection = u ? [u] : b ? [b] : eu ? [eu] : eb ? [eb] : [];
  } else {
    selection = state.units.filter(u =>
      u.owner === PLAYER && u.hp > 0 && u.x >= x1 && u.x <= x2 && u.y >= y1 && u.y <= y2);
  }
  refreshPanel();
});

function issueCommand(x, y) {
  const units = selection.filter(e => e.kind === 'unit' && e.hp > 0 && e.owner === PLAYER);
  if (units.length === 0) return;
  const pt = { x, y };

  // hollow earth tunnel network: right-click your HQ / power plant
  if (state.factions[PLAYER] === 'hollow') {
    const node = state.buildings.find(b => b.owner === PLAYER && b.hp > 0 && b.done &&
      (b.type === 'hq' || b.type === 'powerplant') &&
      Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
    if (node) {
      for (const u of units) {
        if (UNIT_TYPES[u.type].flying) orderMove(u, node.x, node.y + node.h / 2 + 20);
        else u.order = { type: 'tunnel', destId: node.id };
      }
      sfx('click');
      return;
    }
  }

  const foe = enemiesOf(PLAYER).find(e => visibleToPlayer(e) &&
    (e.kind === 'unit' ? dist(e, pt) <= UNIT_TYPES[e.type].r + 6
                       : Math.abs(e.x - x) <= e.w / 2 && Math.abs(e.y - y) <= e.h / 2));
  const patch = state.patches.find(p => p.amount > 0 && dist(p, pt) <= 20 && tileState(p.x, p.y) >= 1);

  units.forEach((u, i) => {
    const stats = UNIT_TYPES[u.type];
    if (foe && canTarget(stats, foe)) { orderAttack(u, foe); return; }
    if (patch && stats.role === 'worker') { orderHarvest(u, patch); return; }
    const ang = (i / Math.max(1, units.length)) * Math.PI * 2;
    const rad = i === 0 ? 0 : 16 + 10 * Math.floor(i / 6);
    orderMove(u, x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);
  });
}

const STRUCT_HOTKEYS = { p: 'powerplant', b: 'barracks', t: 'TOWER', g: 'AATOWER', f: 'factory', d: 'airpad' };

window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (!started) return;
  const k = e.key.toLowerCase();

  if (e.key === 'Escape') { placing = null; attackMoveArmed = false; abilityTargeting = null; refreshPanel(); }
  if (k === 'h') centerCameraOnHome();
  if (k === 'm') setMuted(!muted);

  if (STRUCT_HOTKEYS[k]) {
    let type = STRUCT_HOTKEYS[k];
    if (type === 'TOWER') type = facOf(PLAYER).tower;
    if (type === 'AATOWER') type = facOf(PLAYER).aaTower;
    sidebarStructureClick(type);
  }

  if (k === 'a' && selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].role === 'combat')) {
    attackMoveArmed = true;
    refreshPanel();
  }

  if (/^[1-5]$/.test(e.key)) {
    if (e.ctrlKey) {
      groups[e.key] = selection.slice();
      e.preventDefault();
    } else if (groups[e.key]) {
      selection = groups[e.key].filter(en => en.hp > 0);
      refreshPanel();
    }
  }
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

function minimapPan(e) {
  const r = mmCanvas.getBoundingClientRect();
  const wx = (e.clientX - r.left) / r.width * WORLD_W;
  const wy = (e.clientY - r.top) / r.height * WORLD_H;
  cam.x = wx - canvas.width / cam.zoom / 2;
  cam.y = wy - canvas.height / cam.zoom / 2;
  clampCam();
}
mmCanvas.addEventListener('mousedown', e => { if (e.button === 0) { mmDown = true; minimapPan(e); } });
mmCanvas.addEventListener('mousemove', e => { if (mmDown) minimapPan(e); });

// ---------- sidebar ----------

const elCredits = document.getElementById('credits');
const elPowerFill = document.getElementById('powerfill');
const elPowerText = document.getElementById('powertext');
const gridStructures = document.getElementById('grid-structures');
const gridUnits = document.getElementById('grid-units');
const cameoButtons = {}; // key -> {btn, name, cost, progress, badge, kind}

function sidebarStructureClick(type) {
  const c = state.construction[PLAYER];
  if (c && c.ready && c.type === type) { placing = type; refreshPanel(); return; }
  if (c) { eva('Unable to comply, building in progress'); return; }
  if (atStructCap(PLAYER, type)) { eva('Build limit reached'); return; }
  if (state.minerals[PLAYER] < BUILDING_TYPES[type].cost) { eva('Insufficient funds'); return; }
  startConstruction(PLAYER, type);
  sfx('click');
  refreshSidebar();
}

function sidebarUnitClick(type) {
  const ut = UNIT_TYPES[type];
  const hasTrainer = state.buildings.some(b => b.owner === PLAYER && b.hp > 0 && b.done && b.type === ut.builtAt);
  if (!hasTrainer) { eva(`Requires ${facOf(PLAYER).buildingNames[ut.builtAt] || ut.builtAt}`); return; }
  if (state.minerals[PLAYER] < ut.cost) { eva('Insufficient funds'); return; }
  if (trainUnit(PLAYER, type)) sfx('click');
  refreshSidebar();
}

function makeCameo(grid, key, label, cost, onClick) {
  const btn = document.createElement('button');
  btn.className = 'cameo';
  const prog = document.createElement('div'); prog.className = 'cameo-progress';
  const name = document.createElement('span'); name.className = 'cameo-name'; name.textContent = label;
  const costEl = document.createElement('span'); costEl.className = 'cameo-cost'; costEl.textContent = '$' + cost;
  const badge = document.createElement('span'); badge.className = 'badge'; badge.style.display = 'none';
  btn.append(prog, name, costEl, badge);
  btn.addEventListener('click', onClick);
  grid.appendChild(btn);
  cameoButtons[key] = { btn, costEl, prog, badge, baseCost: cost, baseLabel: label };
}

function buildSidebar() {
  gridStructures.innerHTML = '';
  gridUnits.innerHTML = '';
  for (const k of Object.keys(cameoButtons)) delete cameoButtons[k];
  const f = facOf(PLAYER);

  const structs = ['powerplant', 'barracks', f.tower, f.aaTower, 'factory', 'airpad'];
  for (const s of structs) {
    makeCameo(gridStructures, 's:' + s, f.buildingNames[s] || s, BUILDING_TYPES[s].cost, () => sidebarStructureClick(s));
  }
  const unitList = [f.worker, f.infantry, f.aa, f.extras[0], f.vehicle, f.extras[1], ...f.air, f.extras[2]];
  for (const u of unitList) {
    makeCameo(gridUnits, 'u:' + u, UNIT_TYPES[u].name, UNIT_TYPES[u].cost, () => sidebarUnitClick(u));
  }

  const gridPowers = document.getElementById('grid-powers');
  gridPowers.innerHTML = '';
  makeCameo(gridPowers, 'p:passive', f.powers.passive.name, 0, () => {});
  makeCameo(gridPowers, 'p:sig', f.powers.sig.name, 0, sigClick);
  for (const k of ['p:passive', 'p:sig']) {
    cameoButtons[k].btn.classList.add('power');
    cameoButtons[k].btn.title = k === 'p:passive' ? f.powers.passive.desc : f.powers.sig.desc;
  }
  cameoButtons['p:passive'].costEl.textContent = 'PASSIVE';
}

function sigClick() {
  const pk = facOf(PLAYER).powers.sig;
  const sig = state.sig[PLAYER];
  if (pk.kind === 'auto' || pk.kind === 'info') return;
  if (pk.kind === 'once') {
    if (!sig.used) { castRevealInfiltrator(PLAYER); sfx('click'); }
    refreshSidebar();
    return;
  }
  if (sig.cd > 0) return;
  if (pk.kind === 'instant') { castGaslight(PLAYER); sfx('click'); refreshSidebar(); return; }
  abilityTargeting = pk.kind;
  refreshPanel();
}

function refreshSidebar() {
  if (!started) return;
  elCredits.textContent = '$ ' + state.minerals[PLAYER];
  const power = powerOf(PLAYER);
  elPowerFill.style.width = power.cap ? clamp(100 - power.used / power.cap * 100, 0, 100) + '%' : '0%';
  elPowerFill.classList.toggle('low', power.low);
  elPowerText.textContent = `⚡ ${power.used} / ${power.cap}`;

  const c = state.construction[PLAYER];
  for (const [key, ui] of Object.entries(cameoButtons)) {
    const [kind, type] = [key[0], key.slice(2)];
    if (kind === 'p') {
      if (type !== 'sig') continue;
      const pk = facOf(PLAYER).powers.sig;
      const sig = state.sig[PLAYER];
      ui.btn.classList.remove('castable');
      if (pk.kind === 'auto') {
        ui.prog.style.height = (sig.timer / pk.period * 100) + '%';
        ui.costEl.textContent = Math.ceil(pk.period - sig.timer) + 's';
      } else if (pk.kind === 'info') {
        ui.costEl.textContent = 'ALWAYS ON';
      } else if (pk.kind === 'once') {
        ui.costEl.textContent = sig.used ? 'USED' : 'READY';
        if (!sig.used) ui.btn.classList.add('castable');
      } else {
        ui.prog.style.height = sig.cd > 0 ? (sig.cd / pk.cd * 100) + '%' : '0%';
        ui.costEl.textContent = sig.cd > 0 ? Math.ceil(sig.cd) + 's' : 'READY';
        if (sig.cd <= 0) ui.btn.classList.add('castable');
      }
      continue;
    }
    if (kind === 's') {
      const isThis = c && c.type === type;
      const capped = atStructCap(PLAYER, type);
      ui.btn.classList.toggle('ready', !!(isThis && c.ready));
      ui.btn.classList.toggle('disabled', !!(c && !isThis) || (capped && !isThis));
      ui.prog.style.height = isThis && !c.ready ? (c.t / c.duration * 100) + '%' : '0%';
      const cap = BUILDING_TYPES[type].cap;
      ui.costEl.textContent = isThis && c.ready ? 'PLACE'
        : capped ? 'MAX'
        : '$' + ui.baseCost + (cap ? ` (${countStruct(PLAYER, type)}/${cap})` : '');
    } else {
      const ut = UNIT_TYPES[type];
      const trainers = state.buildings.filter(b => b.owner === PLAYER && b.hp > 0 && b.done && b.type === ut.builtAt);
      ui.btn.classList.toggle('disabled', trainers.length === 0);
      const queued = trainers.reduce((n, b) => n + b.queue.filter(j => j.type === type).length, 0);
      ui.badge.style.display = queued ? '' : 'none';
      ui.badge.textContent = queued;
      const active = trainers.find(b => b.queue.length && b.queue[0].type === type);
      ui.prog.style.height = active ? (active.queue[0].t / active.queue[0].duration * 100) + '%' : '0%';
    }
  }
}

// ---------- faction select ----------

(function buildFactionSelect() {
  const wrap = document.getElementById('family-groups');
  const families = [...new Set(Object.values(FACTIONS).map(f => f.family))];
  for (const fam of families) {
    const col = document.createElement('div');
    col.className = 'family';
    const h = document.createElement('div');
    h.className = 'family-title';
    h.textContent = fam;
    col.appendChild(h);
    for (const [key, f] of Object.entries(FACTIONS)) {
      if (f.family !== fam) continue;
      const btn = document.createElement('button');
      btn.className = 'card';
      btn.innerHTML = `<span class="card-title">${f.emoji} ${f.name}</span><span class="card-desc">${f.desc}</span>`;
      btn.addEventListener('click', () => startGame(key));
      col.appendChild(btn);
    }
    wrap.appendChild(col);
  }
})();

function startGame(faction) {
  document.getElementById('faction-select').classList.add('hidden');
  // the AI plays a random faction from a different family
  const others = Object.keys(FACTIONS).filter(k => FACTIONS[k].family !== FACTIONS[faction].family);
  const enemy = others[Math.floor(Math.random() * others.length)];
  state.factions[ENEMY] = enemy;
  setupWorld(faction);
  document.getElementById('faction-label').textContent =
    `${FACTIONS[faction].emoji} ${FACTIONS[faction].name}  vs  ${FACTIONS[enemy].emoji} ${FACTIONS[enemy].name}`;
  buildSidebar();
  started = true;
  refreshPanel();
  refreshSidebar();
  eva('Battle control online');
}

// ---------- bottom panel ----------

const elSelInfo = document.getElementById('selinfo');
const elActions = document.getElementById('actions');
const elSupply = document.getElementById('supply');

function refreshPanel() {
  elActions.innerHTML = '';
  selection = selection.filter(e => e.hp > 0);

  if (placing) {
    elSelInfo.textContent = `Placing ${facOf(PLAYER).buildingNames[placing] || placing} — click a spot near your base, Esc to cancel`;
    return;
  }
  if (attackMoveArmed) {
    elSelInfo.textContent = 'Attack-move — left-click a destination, Esc to cancel';
    return;
  }
  if (abilityTargeting) {
    elSelInfo.textContent = abilityTargeting === 'zone'
      ? 'Weather Modification — click a target area, Esc to cancel'
      : 'Cloning Vats — click one of your units, Esc to cancel';
    return;
  }
  elSelInfo.style.color = '';
  if (selection.length === 0) { elSelInfo.textContent = 'Nothing selected'; return; }

  const first = selection[0];
  if (selection.length === 1 && first.owner !== PLAYER) {
    // enemy intel card
    elSelInfo.style.color = '#ff9f8f';
    const fName = facOf(first.owner).name;
    if (first.kind === 'unit') {
      const t = UNIT_TYPES[first.type];
      const parts = [`☠ ${t.name} (${fName})`, `HP ${Math.ceil(first.hp)}/${t.hp}`];
      if (t.dmg) {
        parts.push(`DMG ${t.dmg}${t.dmgVsGround !== undefined ? ` air / ${t.dmgVsGround} grd` : ''} every ${t.cooldown}s`);
        parts.push(`Range ${t.atkRange}${t.minRange ? ` (min ${t.minRange})` : ''}`);
      } else {
        parts.push('Unarmed');
      }
      parts.push(`Speed ${t.speed}`);
      if (t.flying) parts.push('Flying');
      if (hitsAir(t)) parts.push('Anti-air');
      if (t.bldgBonus) parts.push(`${t.bldgBonus}× vs buildings`);
      elSelInfo.textContent = parts.join('  |  ');
    } else {
      const bt = BUILDING_TYPES[first.type];
      const parts = [`☠ ${buildingName(first)} (${fName})`, `HP ${Math.ceil(first.hp)}/${bt.hp}`];
      if (bt.dmg) parts.push(`DMG ${bt.dmg} every ${bt.cooldown}s`, `Range ${bt.atkRange}`, bt.targets === 'air' ? 'Anti-air only' : 'Ground only');
      if (bt.power > 0) parts.push(`+${bt.power} power`);
      elSelInfo.textContent = parts.join('  |  ');
    }
    return;
  }
  if (selection.length === 1 && first.kind === 'building') {
    const bt = BUILDING_TYPES[first.type];
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      (first.queue.length ? ` — training (${first.queue.length} queued)` : '') +
      ' — right-click to set rally point';
  } else {
    const counts = {};
    for (const s of selection) counts[UNIT_TYPES[s.type].name] = (counts[UNIT_TYPES[s.type].name] || 0) + 1;
    elSelInfo.textContent = 'Selected: ' + Object.entries(counts).map(([n, c]) => `${c}× ${n}`).join(', ');
    if (selection.some(s => UNIT_TYPES[s.type].role === 'combat')) {
      const btn = document.createElement('button');
      btn.textContent = 'Attack-Move [A]';
      btn.onclick = () => { attackMoveArmed = true; refreshPanel(); };
      elActions.appendChild(btn);
    }
  }
}

// ---------- rendering ----------

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!started) return;
  ctx.save();
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  ctx.fillStyle = '#182018';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= WORLD_W; gx += 100) {
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, WORLD_H); ctx.stroke();
  }
  for (let gy = 0; gy <= WORLD_H; gy += 100) {
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(WORLD_W, gy); ctx.stroke();
  }

  // terrain
  for (const o of TERRAIN) {
    if (o.type === 'water') {
      ctx.fillStyle = '#122630';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#1d3a4a'; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = 'rgba(90,140,170,0.3)';
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(o.x - 18 + i * 18, o.y - 12 + i * 14, o.r * 0.25, 0.3, 2.6);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = '#3a3f46';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#474d56';
      ctx.beginPath(); ctx.arc(o.x - o.r * 0.3, o.y - o.r * 0.25, o.r * 0.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#262a30'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.stroke();
    }
  }

  for (const p of state.patches) {
    if (p.amount <= 0 || tileState(p.x, p.y) === 0) continue;
    const s = 10 + 8 * Math.min(1, p.amount / 900);
    ctx.fillStyle = '#3fd7d0';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x + s, p.y);
    ctx.lineTo(p.x, p.y + s); ctx.lineTo(p.x - s, p.y);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#1a8a85'; ctx.stroke();
  }

  // buildings
  for (const b of state.buildings) {
    if (b.hp <= 0 || !visibleToPlayer(b)) continue;
    const bt = BUILDING_TYPES[b.type];
    ctx.fillStyle = COLORS_DARK[b.owner];
    ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
    ctx.strokeStyle = COLORS[b.owner];
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);

    if (bt.dmg) {
      ctx.fillStyle = powerOf(b.owner).low ? '#666' : '#fff';
      ctx.beginPath();
      ctx.arc(b.x, b.y - b.h / 2, 5, 0, Math.PI * 2);
      ctx.fill();
      if (bt.targets === 'air') {
        ctx.strokeStyle = powerOf(b.owner).low ? '#666' : '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(b.x - 4, b.y - b.h / 2 - 7);
        ctx.lineTo(b.x, b.y - b.h / 2 - 12);
        ctx.lineTo(b.x + 4, b.y - b.h / 2 - 7);
        ctx.stroke();
      }
    }
    if (bt.power > 0 && b.type !== 'hq') {
      ctx.fillStyle = '#ffd75f';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚡', b.x, b.y - b.h / 2 + 12);
    }
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(buildingName(b), b.x, b.y + 4);

    if (selection.includes(b)) {
      ctx.strokeStyle = b.owner === PLAYER ? '#7fff9f' : '#ff8f8f';
      ctx.strokeRect(b.x - b.w / 2 - 3, b.y - b.h / 2 - 3, b.w + 6, b.h + 6);
      if (bt.atkRange) {
        ctx.strokeStyle = 'rgba(127,255,159,0.25)';
        ctx.beginPath();
        ctx.arc(b.x, b.y, bt.atkRange, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (b.rally) {
        ctx.strokeStyle = 'rgba(127,255,159,0.6)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.rally.x, b.rally.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#7fff9f';
        ctx.fillRect(b.rally.x - 2, b.rally.y - 12, 3, 12);
        ctx.beginPath();
        ctx.moveTo(b.rally.x + 1, b.rally.y - 12);
        ctx.lineTo(b.rally.x + 12, b.rally.y - 9);
        ctx.lineTo(b.rally.x + 1, b.rally.y - 6);
        ctx.closePath(); ctx.fill();
      }
    }
    drawBar(b.x, b.y - b.h / 2 - 8, b.w, b.hp / b.maxHp);

    if (b.queue.length) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(b.x - b.w / 2, b.y + b.h / 2 + 3, b.w, 5);
      ctx.fillStyle = '#ffd75f';
      ctx.fillRect(b.x - b.w / 2, b.y + b.h / 2 + 3, b.w * clamp(b.queue[0].t / b.queue[0].duration, 0, 1), 5);
    }
  }

  // ground units, then air units on top
  for (const flyingPass of [false, true]) {
    for (const u of state.units) {
      if (u.hp <= 0 || !visibleToPlayer(u)) continue;
      const t = UNIT_TYPES[u.type];
      if (!!t.flying !== flyingPass) continue;

      if (t.flying) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(u.x + 10, u.y + 16, t.r * 0.9, t.r * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // your own gaslight phantoms look ghostly to you; enemy ones look real
      if (u.type === 'phantom' && u.owner === PLAYER) ctx.globalAlpha = 0.4;
      // reptilian skin suit: enemy infantry render in YOUR color until they attack
      ctx.fillStyle = (u.disguised && u.owner === ENEMY) ? COLORS[PLAYER] : COLORS[u.owner];
      if (t.shape === 'square') {
        ctx.fillRect(u.x - t.r, u.y - t.r, t.r * 2, t.r * 2);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.strokeRect(u.x - t.r, u.y - t.r, t.r * 2, t.r * 2);
      } else if (t.shape === 'tri') {
        ctx.beginPath();
        ctx.moveTo(u.x, u.y - t.r - 2);
        ctx.lineTo(u.x + t.r, u.y + t.r);
        ctx.lineTo(u.x - t.r, u.y + t.r);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      } else if (t.shape === 'blimp') {
        ctx.beginPath();
        ctx.ellipse(u.x, u.y, t.r * 1.3, t.r * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(u.x - 2, u.y + t.r * 0.8, 4, 4);
      } else if (t.shape === 'saucer') {
        ctx.beginPath();
        ctx.ellipse(u.x, u.y + 2, t.r * 1.4, t.r * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.beginPath();
        ctx.arc(u.x, u.y - 3, t.r * 0.5, Math.PI, 0);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(u.x, u.y, t.r, 0, Math.PI * 2);
        ctx.fill();
        if (t.role === 'combat') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
      }

      // role glyphs so unit types read at a glance
      if (t.role === 'worker') {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(u.x - 2.5, u.y - 2.5, 5, 5);
      } else if (t.builtAt === 'barracks') {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (hitsAir(t)) {
          // anti-air: upward arrow
          ctx.moveTo(u.x, u.y + 4); ctx.lineTo(u.x, u.y - 4);
          ctx.moveTo(u.x - 3, u.y - 1); ctx.lineTo(u.x, u.y - 4); ctx.lineTo(u.x + 3, u.y - 1);
        } else {
          // basic infantry: rifle line
          ctx.moveTo(u.x - t.r + 2, u.y); ctx.lineTo(u.x + t.r + 3, u.y - 3);
        }
        ctx.stroke();
      } else if (t.flying && hitsAir(t)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(u.x - 3, u.y - t.r - 4);
        ctx.lineTo(u.x, u.y - t.r - 8);
        ctx.lineTo(u.x + 3, u.y - t.r - 4);
        ctx.stroke();
      }
      if (u.carrying > 0) {
        ctx.fillStyle = '#3fd7d0';
        ctx.fillRect(u.x - 3, u.y - t.r - 7, 6, 5);
      }
      if (selection.includes(u)) {
        ctx.strokeStyle = u.owner === PLAYER ? '#7fff9f' : '#ff8f8f';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(u.x, u.y, t.r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (u.hp < u.maxHp) drawBar(u.x, u.y - t.r - 12, t.r * 2.4, u.hp / u.maxHp);
      ctx.globalAlpha = 1;
    }
  }

  // weather modification zones
  for (const z of state.zones) {
    ctx.fillStyle = 'rgba(80,130,190,0.15)';
    ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,230,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(160,200,245,0.55)'; ctx.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const rx = z.x + Math.sin(i * 2.4) * z.r * 0.8;
      const ry = z.y + Math.cos(i * 1.9) * z.r * 0.65 + ((state.time * 130 + i * 37) % 44) - 22;
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 3, ry + 9); ctx.stroke();
    }
  }

  for (const f of state.flashes) {
    if (tileState(f.x1, f.y1) !== 2 && tileState(f.x2, f.y2) !== 2) continue;
    ctx.strokeStyle = f.owner === PLAYER ? 'rgba(140,200,255,0.9)' : 'rgba(255,160,140,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(f.x1, f.y1);
    ctx.lineTo(f.x2, f.y2);
    ctx.stroke();
  }

  // fog
  fogCtx.clearRect(0, 0, FW, FH);
  for (let ty = 0; ty < FH; ty++) {
    for (let tx = 0; tx < FW; tx++) {
      const v = vis[ty * FW + tx];
      if (v === 2) continue;
      fogCtx.fillStyle = v === 0 ? 'rgba(0,0,0,0.95)' : 'rgba(0,0,0,0.5)';
      fogCtx.fillRect(tx, ty, 1, 1);
    }
  }
  ctx.drawImage(fogCanvas, 0, 0, FW, FH, 0, 0, WORLD_W, WORLD_H);

  if (mouse.sel) {
    const s = mouse.sel;
    ctx.strokeStyle = '#7fff9f';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  }

  if (placing) {
    const t = BUILDING_TYPES[placing];
    const ok = !placementBlocked(placing, mouse.x, mouse.y) && withinBuildRadius(PLAYER, mouse.x, mouse.y);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = ok ? '#4da3ff' : '#ff5f5f';
    ctx.fillRect(mouse.x - t.w / 2, mouse.y - t.h / 2, t.w, t.h);
    if (t.atkRange) {
      ctx.strokeStyle = '#4da3ff';
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, t.atkRange, 0, Math.PI * 2);
      ctx.stroke();
    }
    // show the buildable radius around grid anchors (HQ + power plants)
    ctx.strokeStyle = 'rgba(127,255,159,0.2)';
    for (const b of state.buildings) {
      if (b.owner !== PLAYER || b.hp <= 0 || !b.done) continue;
      if (b.type !== 'hq' && b.type !== 'powerplant') continue;
      ctx.beginPath();
      ctx.arc(b.x, b.y, BUILD_RADIUS, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();
  drawMinimap();
}

function drawBar(cx, y, w, frac) {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(cx - w / 2, y, w, 4);
  ctx.fillStyle = frac > 0.5 ? '#5fce5f' : frac > 0.25 ? '#ffd75f' : '#ff6b5f';
  ctx.fillRect(cx - w / 2, y, w * clamp(frac, 0, 1), 4);
}

function drawMinimap() {
  mmCtx.fillStyle = '#101810';
  mmCtx.fillRect(0, 0, mmCanvas.width, mmCanvas.height);

  // RA2-style radar outage when the grid is down
  if (started && powerOf(PLAYER).low) {
    mmCtx.fillStyle = '#0a0d0a';
    mmCtx.fillRect(0, 0, mmCanvas.width, mmCanvas.height);
    for (let i = 0; i < 120; i++) {
      mmCtx.fillStyle = `rgba(90,110,90,${0.05 + (i * 7919 % 13) / 40})`;
      mmCtx.fillRect((i * 7919) % mmCanvas.width, (i * 104729) % mmCanvas.height, 2, 2);
    }
    mmCtx.fillStyle = '#9fd79f';
    mmCtx.font = 'bold 13px monospace';
    mmCtx.textAlign = 'center';
    mmCtx.fillText('LOW POWER', mmCanvas.width / 2, mmCanvas.height / 2 - 4);
    mmCtx.font = '10px monospace';
    mmCtx.fillText('RADAR OFFLINE', mmCanvas.width / 2, mmCanvas.height / 2 + 10);
    return;
  }

  const sx = mmCanvas.width / WORLD_W, sy = mmCanvas.height / WORLD_H;
  for (const o of TERRAIN) {
    mmCtx.fillStyle = o.type === 'water' ? '#1d3a4a' : '#4a4f56';
    mmCtx.beginPath();
    mmCtx.arc(o.x * sx, o.y * sy, o.r * sx, 0, Math.PI * 2);
    mmCtx.fill();
  }
  for (const p of state.patches) {
    if (p.amount <= 0 || tileState(p.x, p.y) === 0) continue;
    mmCtx.fillStyle = '#3fd7d0';
    mmCtx.fillRect(p.x * sx - 1, p.y * sy - 1, 3, 3);
  }
  for (const b of state.buildings) {
    if (b.hp <= 0 || !visibleToPlayer(b)) continue;
    mmCtx.fillStyle = COLORS[b.owner];
    mmCtx.fillRect(b.x * sx - 3, b.y * sy - 3, 6, 6);
  }
  for (const u of state.units) {
    if (u.hp <= 0 || !visibleToPlayer(u)) continue;
    mmCtx.fillStyle = (u.disguised && u.owner === ENEMY) ? COLORS[PLAYER] : COLORS[u.owner];
    mmCtx.fillRect(u.x * sx - 1, u.y * sy - 1, 2, 2);
  }
  const tw = mmCanvas.width / FW, th = mmCanvas.height / FH;
  for (let ty = 0; ty < FH; ty++) {
    for (let tx = 0; tx < FW; tx++) {
      const v = vis[ty * FW + tx];
      if (v === 2) continue;
      mmCtx.fillStyle = v === 0 ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.4)';
      mmCtx.fillRect(tx * tw, ty * th, tw + 0.5, th + 0.5);
    }
  }
  // radar intel passives pierce the fog: flat sees enemy air, hollow sees enemy ground
  const pf = state.factions[PLAYER];
  if (pf === 'flat' || pf === 'hollow') {
    for (const u of state.units) {
      if (u.owner !== ENEMY || u.hp <= 0 || u.disguised) continue;
      const fly = !!UNIT_TYPES[u.type].flying;
      if ((pf === 'flat' && fly) || (pf === 'hollow' && !fly)) {
        mmCtx.fillStyle = '#ffb45f';
        mmCtx.fillRect(u.x * sx - 1.5, u.y * sy - 1.5, 3, 3);
      }
    }
  }
  mmCtx.strokeStyle = '#cfd6dd';
  mmCtx.lineWidth = 1;
  mmCtx.strokeRect(cam.x * sx, cam.y * sy, canvas.width / cam.zoom * sx, canvas.height / cam.zoom * sy);
}

// ---------- main loop ----------

function checkGameOver() {
  const playerHq = state.buildings.some(b => b.owner === PLAYER && b.type === 'hq' && b.hp > 0);
  const enemyHq = state.buildings.some(b => b.owner === ENEMY && b.type === 'hq' && b.hp > 0);
  if (playerHq && enemyHq) return;
  state.over = true;
  const el = document.getElementById('overlay-text');
  el.textContent = playerHq ? 'VICTORY! The truth is yours.' : 'DEFEAT';
  el.style.color = playerHq ? '#7fff9f' : '#ff6b5f';
  document.getElementById('overlay').classList.remove('hidden');
  eva(playerHq ? 'Mission accomplished' : 'Battle control terminated');
}

let lastTime = performance.now();
let panelTimer = 0;
let wasLowPower = false;

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (started && !state.over) {
    const pan = 520 * dt / cam.zoom;
    if (keys['arrowleft']) cam.x -= pan;
    if (keys['arrowright']) cam.x += pan;
    if (keys['arrowup']) cam.y -= pan;
    if (keys['arrowdown']) cam.y += pan;
    if (mouse.inside && !panDrag) {
      const M = 26;
      if (mouse.sx < M) cam.x -= pan;
      if (mouse.sx > canvas.width - M) cam.x += pan;
      if (mouse.sy < M) cam.y -= pan;
      if (mouse.sy > canvas.height - M) cam.y += pan;
    }
    clampCam();

    state.time += dt;
    for (const u of state.units) if (u.hp > 0) updateUnit(u, dt);
    for (const b of state.buildings) if (b.hp > 0) updateBuilding(b, dt);
    tickConstruction(PLAYER, dt);
    updateAI(dt);
    updateAbilities(dt);
    for (const u of state.units) {
      if (u.expires && state.time > u.expires) u.hp = 0; // phantoms fade
    }
    updateFog();

    // destroyed-building effects
    for (const b of state.buildings) {
      if (b.hp <= 0) {
        if (tileState(b.x, b.y) === 2) sfx('boom');
        if (b.owner === PLAYER) eva('Structure lost');
      }
    }
    state.units = state.units.filter(u => u.hp > 0);
    state.buildings = state.buildings.filter(b => b.hp > 0);
    for (const f of state.flashes) f.t -= dt;
    state.flashes = state.flashes.filter(f => f.t > 0);

    const beforeLen = selection.length;
    selection = selection.filter(e => e.hp > 0);
    if (selection.length !== beforeLen) refreshPanel();

    const low = powerOf(PLAYER).low;
    if (low && !wasLowPower) eva('Low power');
    wasLowPower = low;

    checkGameOver();

    const mine = state.units.filter(u => u.owner === PLAYER);
    const w = mine.filter(u => UNIT_TYPES[u.type].role === 'worker').length;
    elSupply.textContent = `Workers: ${w}  Army: ${mine.length - w}`;

    panelTimer += dt;
    if (panelTimer > 0.25) { panelTimer = 0; refreshSidebar(); }
  }

  draw();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
