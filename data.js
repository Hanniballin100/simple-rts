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
// ART style key — NOT the lore family. The Resistance used to borrow the flat
// compound's sprites, so two factions that are opposites in fiction read as the
// same base on screen; they have their own 'scrap' language now (containers,
// scaffold, tarps, aerials) the way hollow has its own despite sharing EARTHERS.
const FAMILY_STYLE = { flat: 'flat', resistance: 'scrap', glob: 'glob', deep: 'glob', hollow: 'hollow', grey: 'alien', reptilian: 'alien' };

// Build hotkeys are GONE — WASD pans the camera now, and a letter grid that
// half-collides with the pan keys is worse than no letter grid at all. Build
// from the sidebar; the only letters left are the ones WASD does not want.

// ---------- factions ----------

const FACTIONS = {
  flat: {
    name: 'Flat Earthers', family: 'EARTHERS', emoji: '🥞',
    desc: 'They are not here to win, they are here to still be here. Farms worked by the people who fight, so every body you muster is income switched off — and Marksmen bury the tech tree on the enemy\'s doorstep instead of building it at home. Kill the Bunker and nothing happens. They are finished when the last homestead burns.',
    // Matches the Rig of Truth's `limit: 3`. If this stayed above the cap the
    // AI would read itself as permanently STARVED (workers < economy.workers),
    // which pins it in the recovery branch that ignores the build reserve.
    economy: { workers: 3 },
    // NO hqRebuild. The homesteads ARE the redundancy now — see FLAT_LAST_STAND.
    worker: 'truthrig', infantry: 'militia', aa: 'laserguy', vehicle: 'killdozer',
    air: ['balloon', 'barrageballoon'], tower: 'pillbox', aaTower: 'laserpointer',
    // AMR gunners and Breachers are NOT built here — they are militia who
    // reached a prepper cache (see CACHE_LOADOUT). The tent trains the people
    // who make that possible, and nothing else.
    extras: ['homesteader', 'journalist', 'engineer', 'bugoutvan', 'fireworks', 'quadrunner'],
    advanced: [],   // pending the Institute of Truth / Broadcast Station rework
    structs: ['homestead', 'broadcast', 'bushplane', 'wall', 'gate', 'refinery'],
    powers: {
      passive: { name: 'Horizon Is a Lie', desc: 'Enemy aircraft are always visible on your radar.' },
      // The dome is real, and for fourteen seconds everyone else has to agree.
      // Deliberately a SHIELD, not a kill button: it turns an air push away and
      // buys the compound a window, rather than deleting the wing outright.
      sig: { name: 'The Firmament', desc: 'Target a zone: for 14s the sky over it is SOLID. Enemy aircraft inside grind against the dome (12 dmg/s, badly slowed) and enemy shells and missiles crossing it burn up on contact.', kind: 'zone', cd: 90, r: 215, dur: 14, dps: 12 },
    },
    buildingNames: {
      hq: 'Bunker of Truth', powerplant: 'Diesel Generator', barracks: 'Recruitment Tent',
      factory: 'Truck Garage', airpad: 'Balloon Dock', tech: 'Institute of Truth',
      pillbox: 'Patriot Pillbox', laserpointer: 'Giant Laser Pointer',
      homestead: 'Homestead', preppercache: 'Prepper Cache', bushplane: 'Bush Plane',
      broadcast: 'Broadcast Station',
      wall: 'Ice Wall Segment', gate: 'Checkpoint Gate', mine: 'IED',
    },
  },
  resistance: {
    name: 'The Resistance', family: 'RESISTANCE', emoji: '📡',
    desc: 'Off-grid guerrillas who hit before the lamestream reacts. Dirt-cheap bodies, the fastest and flimsiest buildings anywhere, and another basement whenever they lose one.',
    economy: { workers: 4 },
    // a cell that loses its radio finds another basement — and finding one is
    // cheap, because that is the entire point of being a cell
    hqRebuild: { cost: 150, grace: 60 },
    worker: 'salvagerig', infantry: 'partisan', aa: 'manpad', vehicle: 'technical',
    air: ['fpv', 'shahed'], tower: 'watchtower', aaTower: 'aanest',
    extras: ['rpgpartisan', 'marksman', 'chembiplane', 'engineer'], advanced: ['cruisetruck'],
    structs: ['wall', 'gate', 'refinery', 'superweapon'],
    powers: {
      passive: { name: 'Sleeper Cells', desc: '3 hidden observation camps watch the map from the start.' },
      sig: { name: 'Smuggling Routes', desc: 'Every 2 minutes a truck hauls 150 minerals to your HQ — unless it gets intercepted.', kind: 'auto', period: 120 },
    },
    buildingNames: {
      hq: 'Pirate Radio Bunker', powerplant: 'Diesel Shack', barracks: 'Safehouse',
      factory: 'Chop Shop', airpad: 'Drone Shop', tech: 'Numbers Station',
      watchtower: 'Watchtower', aanest: 'AA Gun Nest',
      sleepercell: 'Sleeper Cell',
      wall: 'Scrap Barricade', gate: 'Checkpoint Gate', mine: 'IED',
      superweapon: 'Loitering-Munition Bay',
    },
  },
  glob: {
    name: 'Globalists', family: 'GLOBALISTS', emoji: '🌐',
    desc: 'Order through orbit, paid for in full. The line holds, the armour rolls over it, and the real budget is overhead. Everything is expensive. Everything works.',
    economy: { workers: 3 },
    worker: 'harvester', infantry: 'pmc', aa: 'jammer', vehicle: 'abrams',
    airFocus: 1.5, // still THE air power, but the AI fields an army under it too
    air: ['apache', 'f35', 'a10'], tower: 'tower5g', aaTower: 'samsite',
    extras: ['riot', 'bradley', 'blackvan', 'himars', 'engineer', 'mechanic'], advanced: ['b52'],
    structs: ['wall', 'gate', 'repairpad', 'refinery', 'datacenter', 'satellite', 'superweapon'],
    powers: {
      passive: { name: 'Quantitative Easing', desc: 'The printer follows the economy: every 10s you gain minerals equal to 12% of the power your base actually DRAWS, up to 40. And when a building falls, 25% of its cost is refunded — too big to fail.' },
      sig: { name: 'Weather Modification', desc: 'Target a zone: enemy ground units in it are slowed 40% for 15s.', kind: 'zone', cd: 90 },
    },
    buildingNames: {
      hq: 'World HQ', powerplant: 'Fusion Plant', barracks: 'Command Center',
      factory: 'Motor Pool', airpad: 'Air Force Base', tech: 'Black Site Lab',
      tower5g: '5G Tower', samsite: 'Patriot Battery',
      wall: 'Security Wall', gate: 'Security Gate', mine: 'Claymore', repairpad: 'Service Bay',
      refinery: 'Refinery', datacenter: 'Data Center',
      satellite: 'Orbital Uplink',
      superweapon: 'Orbital Kinetic Array',
    },
  },
  deep: {
    name: 'The Deep State', family: 'GLOBALISTS', emoji: '🕶️',
    desc: 'It was never elected and never leaves. Its assets run silent and strike first from concealment, its air wing arrives before anyone sees it, and a detector is the only way to find any of it.',
    economy: { workers: 3 },
    // Continuity of Government: it was never in that building anyway
    hqRebuild: { cost: 0, grace: 75, auto: 25 },
    worker: 'blackrig', infantry: 'agent', aa: 'jammer', vehicle: 'spooktank',
    airFocus: 1.4, // still a black-budget air wing, second only to the USAF
    air: ['tr3b', 'b1'], tower: 'tower5g', aaTower: 'samsite',
    extras: ['riot', 'disinfovan', 'frontco', 'engineer', 'mechanic'], advanced: ['b2'],
    structs: ['wall', 'gate', 'repairpad', 'refinery', 'fedreserve', 'superweapon'],
    powers: {
      passive: { name: 'Continuity of Government', desc: 'ASSETS: enemy line troops are quietly turned into sleepers — they keep serving their owner, but you see whatever they see, and you can wake them at will to fight for you. And if your HQ falls, an undisclosed location takes over: it relocates itself, once per game.' },
      sig: { name: 'Gaslight', desc: 'Phantom signatures appear near the enemy base and their defenses scramble to fight nothing.', kind: 'instant', cd: 120 },
    },
    buildingNames: {
      hq: 'Undisclosed Location', powerplant: 'Fusion Plant', barracks: 'Field Office',
      factory: 'Motor Pool', airpad: 'Undisclosed Airstrip', tech: 'Continuity Bunker',
      tower5g: '5G Tower', samsite: 'Patriot Battery', fedreserve: 'Federal Reserve',
      wall: 'Security Wall', gate: 'Security Gate', mine: 'Claymore', repairpad: 'Motor Pool Annex',
      superweapon: 'Blackout Command Node',
    },
  },
  hollow: {
    name: 'Hollow Earthers', family: 'EARTHERS', emoji: '🕳️',
    desc: 'The real world is below, and it left its machines behind. Servitors come out of the ground by the dozen; the Mechanicum takes them apart and builds something better. No relic, no ascension.',
    economy: { workers: 4 },
    worker: 'borerig', infantry: 'moleservitor', aa: 'slinger', vehicle: 'quaketruck',
    air: ['ornithopter', 'vrildisc'], tower: 'seismic', aaTower: 'geyser',
    extras: ['engineer', 'excavationrig'], advanced: ['aerostat'],
    structs: ['wall', 'gate', 'mechanicum', 'geode', 'refinery', 'superweapon'],
    powers: {
      passive: { name: 'Seismic Sense', desc: 'Enemy ground units are always visible on your radar.' },
      // a small circle, not a single body — big enough for a squad that has
      // overextended, far too small to evacuate an army (r/max below)
      sig: { name: 'Vril Recall', desc: 'Target a small patch of ground anywhere on the map: your units standing in it — up to 5, nearest the centre first — flash home to your HQ.', kind: 'recall', r: 75, max: 5, cd: 90 },
    },
    buildingNames: {
      hq: 'Inner Sanctum', powerplant: 'Geothermal Vent', barracks: 'Servitorium',
      factory: 'Drill Works', airpad: 'Cavern Roost', tech: 'Reliquary',
      seismic: 'Seismic Imitator', geyser: 'Geyser Cannon',
      wall: 'Stone Rampart', gate: 'Stone Gate', mine: 'Sinkhole Trap',
      mechanicum: 'Mechanicum', geode: 'Crystal Geode',
      superweapon: 'Seismic Resonator',
    },
  },
  grey: {
    name: 'The Greys', family: 'ALIENS', emoji: '👽',
    desc: 'No workers, no wages. The structures themselves pay out, the abductions replace what dies, and everything on the field was grown for a purpose it did not choose.',
    economy: { workers: 0, start: 150 },
    worker: null, infantry: 'greydrone', aa: 'beamer', vehicle: 'tripod',
    air: ['orb', 'probedrone'], tower: 'pylon', aaTower: 'tractor',
    extras: ['handler', 'technician', 'overseer', 'gravwell', 'engineer', 'vivisector'], advanced: ['saucer', 'mothership'],
    structs: ['wall', 'gate', 'repairpad', 'superweapon'],
    powers: {
      passive: { name: 'Superior Metallurgy', desc: 'Your buildings ignore bonus anti-building damage (sappers, rams, artillery).' },
      sig: { name: 'Cloning Vats', desc: 'Target one of your infantry: an exact copy emerges from your barracks. The vats only fit people-shaped things — no vehicles, no aircraft.', kind: 'unit', cd: 90 },
    },
    buildingNames: {
      hq: 'Mothership Anchor', powerplant: 'Zero-Point Core', barracks: 'Cloning Pod',
      factory: 'Assembler', airpad: 'Saucer Pad', tech: 'Hive Mind Nexus',
      pylon: 'Plasma Pylon', tractor: 'Tractor Beam',
      wall: 'Alloy Barrier', gate: 'Alloy Gate', mine: 'Plasma Mine', repairpad: 'Nanite Bay',
      superweapon: 'Great Pyramid',
    },
  },
  reptilian: {
    name: 'The Reptilians', family: 'ALIENS', emoji: '🦎',
    desc: 'They have been here the whole time, wearing your face. The pit is worked to death and refilled from your own ranks, and the throne takes an army by asking it nicely.',
    economy: { workers: 5, start: 200 },
    worker: 'slave', infantry: 'raptoid', aa: 'beamer', vehicle: 'sirrush',
    air: ['gargoyle', 'screecher'], tower: 'pylon', aaTower: 'tractor',
    extras: ['nephilim', 'priest', 'broodslave', 'shapeshifter', 'broodmother'], advanced: ['draco'],
    // The pit works the crystal by hand, so unlike the other alien faction it
    // has a haul — and by the late game the home field is dry and the walk is
    // most of the shift. The forward drop-off (Gene Vault first) is what keeps
    // the slaves cutting instead of commuting.
    structs: ['wall', 'gate', 'repairpad', 'refinery', 'superweapon'],
    powers: {
      passive: { name: 'Skin Suit', desc: 'Your infantry are not recognized as hostile until they attack.' },
      sig: { name: 'Reveal Infiltrator', desc: 'One enemy worker has always been yours. Click to convert it (once per game).', kind: 'once' },
    },
    buildingNames: {
      hq: 'Nest Citadel', powerplant: 'Zero-Point Core', barracks: 'Hatchery',
      factory: 'Assembler', airpad: 'Roost Spire', tech: 'Gene Vault',
      pylon: 'Plasma Pylon', tractor: 'Tractor Beam',
      wall: 'Alloy Barrier', gate: 'Alloy Gate', mine: 'Plasma Mine', repairpad: 'Regeneration Pit',
      refinery: 'Crystal Maw', superweapon: 'Bloodline Throne',
    },
  },
};

// ---------- structure repair ----------
// Universal and faction-agnostic: select a damaged structure of yours, turn
// Repair on, and it knits back at REPAIR_RATE of its max HP per second while
// billing you continuously. Mending a near-wreck all the way to full costs
// REPAIR_COST of the sticker price, so repairing always beats rebuilding — but
// it is never free, never instant, and it stops the moment the money does.
// Captured civilian structures have no sticker price and are billed off their
// hit points instead (see repairValueOf).
const REPAIR_RATE = 0.05;      // fraction of max HP mended per second
const REPAIR_COST = 0.45;      // fraction of build cost for a 0 -> full mend
const REPAIR_FREE_VALUE = 0.25; // priceless structures bill at this × their HP

// ---------- demolition ----------
// Pull a structure down on purpose and half the build cost comes back. The
// teardown is not instant, and that is the whole design: the crew has to get
// clear, so a building under attack cannot be cashed out the instant it starts
// losing a fight. Kill it before the timer runs and the owner gets nothing —
// denying the refund is worth doing.
const DEMOLISH_TIME = 2.5;     // seconds from ordering it to the building dropping
const DEMOLISH_REFUND = 0.5;   // fraction of build cost paid back on completion

// ---------- SUSPICION & SCRUTINY (how hiding works) ----------
// Stealth is not a switch that a detector flips. It is a CONTEST between how
// noticeable you are being and how hard the other side is looking at the ground
// you are standing on.
//
//   SUSPICION = stealthSkill x what you are doing right now
//   SCRUTINY  = what the observer has watching that spot
//   revealed when  SUSPICION x SCRUTINY >= SUSPICION_CAUGHT
//
// The consequences fall out of the formula rather than being special-cased: an
// elite can sit still inside a busy base and go unseen, the same elite is
// caught the moment it runs, and a tank is invisible in open country however
// fast it drives. Holding still helping is simply what the numbers do, which is
// why `cloakStill` stops needing to be its own mechanic.
// Suspicion is a METER, 0-100, that grows and cools rather than a rate read off
// what you happen to be doing this instant. Behaviour sets a TARGET and the
// meter walks toward it, so breaking into a run does not light you up
// immediately and stopping does not make you safe immediately — you have to
// actually hold still long enough to go quiet. Rising is fast, cooling is slow:
// getting noticed is easier than being forgotten.
const SUSPICION_MAX = 100;
const SUSPICION_RISE = 55;     // meter points per second climbing toward target
const SUSPICION_FALL = 16;     // ...and bleeding back down
const SUSPICION_CAUGHT = 1.0;  // revealed when (suspicion/100) x scrutiny hits this
const SUSP_STILL = 0.6;        // multiplier while holding position
const SUSP_MOVING = 1.0;       // ...walking
const SUSP_SPRINT = 1.5;       // ...at full speed
const SUSP_STILL_AFTER = 1.2;  // seconds of not moving before "still" applies
// Hold-still cloakers (MIB, Journalist) are built around stopping: they hide
// better than their skill suggests when planted, and worse when they do not.
const SUSP_CLOAKSTILL_MOVE = 1.7;
// What an observer's things contribute to scrutiny over a spot they can see.
const SCRUTINY_UNIT = 0.10;    // per unit with the spot inside its sight
const SCRUTINY_BLDG = 0.15;    // per building — a base is a lot of eyes
const SCRUTINY_DETECTOR = 2.5; // a real detector dominates, but stillness can still beat it
const SCRUTINY_DISPROVED = 2;  // "Stealth Is a Psyop": everything you own looks twice as hard
// FIRING HARD-REVEALS. A muzzle flash is not a suspicion modifier, it is a
// location broadcast — no amount of skill hides it, and it lasts long enough to
// be shot at. (Pad aircraft stay lit until they land: see EXPOSE_PAD.)
const EXPOSE_FIRING = 5;       // seconds a shot keeps you visible, anywhere
// How well each stealth thing hides at rest. Lower is better. Infantry beat
// vehicles, vehicles beat aircraft, and a buried mine beats everything.
const STEALTH_SKILL = {
  mine: 0.25,
  specops: 0.5, frontcompany: 0.55, bushplane: 0.6,
  agent: 0.7, mib: 0.7, homesteader: 0.7,
  // 0.55, not 0.85. At 0.85 a Journalist filming DISCREETLY sat at 61
  // suspicion, and a busy base catches anything over ~59 — so the quiet stance
  // was caught in the exact place it exists to work, and the two stances
  // collapsed into one. At 0.55 discreet reads ~43 (sit there all day) and
  // doorstep still pins at 100 (get the story, get found), which is the
  // decision the unit is built around.
  journalist: 0.55,
  blackrig: 1.0, disinfovan: 1.1,
  tr3b: 1.15, b2: 1.2, b1: 1.25,
  spooktank: 1.3,
};
const STEALTH_SKILL_DEFAULT = 0.9;

// ---------- THE HOMESTEAD ECONOMY (Flat Earth) ----------
// The Flat Earthers do not mine for a living — they FARM, and the farmhands are
// the same bodies that fight. A Homestead finishes with HOMESTEAD_SLOTS militia
// already working it, and pays out in proportion to how many are still at home:
// every militia mustered off the land is a quarter of that farm's income gone.
// That is the whole faction in one number. An army in the field is an economy
// switched off, and a full treasury means nobody is fighting.
//
// Bodies lost in the field come back on a slow drip (HOMESTEAD_REFILL each), so
// attrition costs income for a long time after the battle ends.
const HOMESTEAD_SLOTS = 4;             // militia a homestead holds at full strength
// A new farm opens with a COUPLE of hands, not a full yard, and fills up slowly.
// At 4-on-completion a Flat Earther could plant two homesteads and have eight
// free rifles walking at you before anyone else had a barracks running — the
// farms were an early-game militia printer. Starting at 2 and growing one every
// HOMESTEAD_REFILL makes a full yard something you arrive at around the midgame,
// and makes losing a farmhand hurt for a long time.
const HOMESTEAD_START = 2;             // militia a freshly built homestead comes with
const HOMESTEAD_RATE = 0.22;           // minerals/sec per militia actually stationed
const HOMESTEAD_REFILL = 45;           // seconds to grow each missing body back
const HOMESTEAD_CAP = 6;               // hard cap — this is also the victory condition
// The compound builds FAR. A Flat Earther plants homesteads across half a
// county, which is why the faction can be spread out enough to be hard to
// finish off. Everyone else stays on BUILD_RADIUS.
const FLAT_BUILD_RADIUS = 900;
// Without a Diesel Generator the three powered structures do not stop, they
// CRAWL — a quarter speed, where everyone else browns out to a half.
const FLAT_BROWNOUT = 0.25;

// ---------- PROOF (the Flat Earth strategic currency) ----------
// Minerals come out of the ground; PROOF comes off a camera. An Investigative
// Journalist films enemy structures and battles, carries the footage back, and
// banks it at a Broadcast Station — and the bank is a BUILDING, not a number on
// the HUD. Proof sits in the station that holds it, which means it can be taken
// from you: burn the station and every frame inside it burns with it.
// That is the whole risk profile of the faction's tech layer. Minerals are safe
// in an abstract treasury; proof is stacked in a shed with an aerial on it.
const PROOF_CAP = 250;          // per station — a full one stops accepting
const PROOF_CARRY = 40;         // how much footage a Journalist holds before it must go home
const PROOF_FILM_DISCREET = 4;  // proof/sec filming quietly (low suspicion)
const PROOF_FILM_DOORSTEP = 11; // ...and shoving a lens in their face (high suspicion)
// what the two stances do to the meter while filming (added to the target)
const PROOF_SUSP_DISCREET = 10;
const PROOF_SUSP_DOORSTEP = 70;
const PROOF_BATTLE_BONUS = 3;   // extra proof per enemy body that dies on camera
// A STORY ONLY BREAKS ONCE. Every enemy structure holds a finite amount of
// footage, and once it has been covered there is nothing left to film there —
// so a Journalist cannot park on the nearest shed and farm it forever. Getting
// paid means going deeper into their base for a structure nobody has shot yet.
// Sized a little above one camera load (PROOF_CARRY), so a building is roughly
// one trip and then you move on.
const STORY_PER_BUILDING = 55;
// ...except the things that are genuinely a bigger story. Their HQ, their
// research lab and their superweapon are worth going back for.
const STORY_HEADLINE = 110;

// ---------- BROADCASTS (what proof buys) ----------
// Spent at the Broadcast Station. Timed ones are pressure; permanent ones are
// the faction's tech tree, and the two dearest need the Institute of Truth
// standing to unlock — the Institute stops being a research building and
// becomes the thing that lets you say the biggest words.
// `kind`: 'zone' picks a spot on the map, 'instant' fires where it stands,
// 'permanent' is bought once and never expires.
const BROADCASTS = {
  leaked: {
    name: 'Leaked Footage', cost: 45, kind: 'zone', dur: 25, r: 260,
    desc: 'Everything in the target area is laid bare for 25s — units, structures, and whatever was trying not to be seen.',
  },
  followmoney: {
    name: 'Follow the Money', cost: 70, kind: 'permanent',
    desc: 'You have their books. Every enemy refinery, drop-off and worker is permanently visible, wherever it goes.',
  },
  awakening: {
    name: 'Mass Awakening', cost: 80, kind: 'instant', dur: 45, mul: 1.3,
    desc: 'The people have seen it. Every Truther Militia you own hits 30% harder for 45s.',
  },
  sponsors: {
    name: 'Sponsors Pulled Out', cost: 95, kind: 'instant', dur: 30, mul: 0.5,
    desc: 'Their backers are running. Every enemy earns HALF — mining and structure income both — for 30s.',
  },
  deadair: {
    name: 'Dead Air', cost: 110, kind: 'instant', dur: 30, mul: 0.5,
    desc: 'They are transmitting nothing and hearing less. Enemy scrutiny is halved for 30s: for that window your Marksmen and Ex-Special Forces are twice as hard to notice.',
  },
  archive: {
    name: 'The Archive', cost: 140, kind: 'permanent', req: 'tech', bonus: 100,
    desc: 'Deep storage under the Institute. Every Broadcast Station banks 100 more proof, forever.',
  },
  syndication: {
    name: 'Syndication', cost: 180, kind: 'permanent',
    desc: 'The show is carried everywhere. Every homestead you own works one more militia — permanently, on every farm you will ever build.',
  },
  household: {
    name: 'Household Name', cost: 200, kind: 'permanent', req: 'tech', mul: 0.75,
    desc: 'They already know who you are. Every broadcast from here on costs 25% less.',
  },
};

// ---------- prepper caches ----------
// A cache is a buried kit dump, and a militia that reaches one walks away as
// something else (see CACHE_KITS). It is the Flat Earther tech tree, and unlike
// every other faction's it lives at the FRONT: a cache planted inside your own
// build radius is refused outright, so the kit only ever exists where the
// Marksman was brave enough to bury it.
// Finite on purpose — a cache that refilled would be a permanent forward
// barracks nothing could resolve. Four kits, then it is an empty box.
const CACHE_COST = 45;
const CACHE_KITS = 4;                  // militia conversions before it is spent
const CACHE_CARRY = 2;                 // caches a Marksman carries at a time
const CACHE_CAP = 6;                   // live caches per player
const CACHE_RESUPPLY = 4;              // seconds at a homestead to reload a Marksman
const CACHE_CONVERT = 3;               // seconds a militia spends drawing its kit
// A cache must be buried ON SOMEBODY'S DOORSTEP — within this of an enemy
// structure. Outside-your-own-radius alone was not a real constraint: you could
// stash the whole tech tree in a safe empty corner and walk militia out to it
// at leisure, which is all of the payoff and none of the risk. Now the ground
// that qualifies is ground the enemy is standing on.
const CACHE_ENEMY_R = 620;
// What a militia can draw. Sidegrades, never a ladder — you pick the kit for
// the job in front of you, and the choice is made at the front where you can
// already see what you are up against.
const CACHE_LOADOUT = ['amr', 'breacher'];

// ---------- the Bush Plane ----------
// The faction's one act of reach, and it is a late-game ambush rather than an
// air force. It is built like a building and sits on the strip STEALTHED; you
// walk three Homestead Marksmen aboard, and they come off the other end as
// Ex-Special Forces. It flies once, drops, and is gone.
// Scouted ground only — a strike this hard should require you to have LOOKED,
// and it stops the plane being a blind map-wide delete button.
const BUSHPLANE_CREW = 3;              // Marksmen required before it will fly
const BUSHPLANE_SPEED = 240;           // how fast it crosses to the drop
const DEMO_CHARGES = 2;                // charges each Ex-Special Forces carries
const DEMO_FUSE = 6;                   // seconds from planting to the bang
const DEMO_DMG = 900;                  // straight to the structure, before armor
const DEMO_PLANT = 2.5;                // seconds spent setting it

// ---------- Bug Out Van kits ----------
// One body climbs in and the van is rebuilt around it. The van keeps its own
// hull (hp, armor, speed) and takes the stat block below; unload and both come
// back out intact. A van carrying a KIT body is not a transport any more — the
// bay is full of whatever they welded in there.
// `art` is the drawing key: every kit looks different on the field, so an enemy
// can read what is coming at them from the silhouette alone.
const BUGOUT_KITS = {
  engineer:    { name: 'Repair Truck',  art: 'repair',  dmg: 0,  atkRange: 0,   cooldown: 1,   repair: 10 },
  militia:     { name: 'Technical',     art: 'mg',      dmg: 12, atkRange: 150, cooldown: 0.35 },
  // the compound's mobile air defence: the Giant Laser Pointer rig bolted to a
  // van bed. Full damage skyward, feeble against anything on the ground
  // (dmgVsGround) — same bargain every AA trooper in the game makes.
  laserguy:    { name: 'Laser Technical', art: 'laser', dmg: 15, dmgVsGround: 5, atkRange: 215, cooldown: 0.55, targets: 'both' },
  amr:         { name: 'Hunter',        art: 'hunter',  dmg: 78, atkRange: 285, cooldown: 2.4, vehBonus: 2.6, bldgBonus: 0.12 },
  breacher:    { name: 'Demo Van',      art: 'demo',    dmg: 44, atkRange: 60,  cooldown: 1.4, bldgBonus: 3.2 },
  // the Chuck Wagon reloads Marksmen IN THE FIELD — the round trip home is the
  // cache system's whole tax, and this is what buys it off
  homesteader: { name: 'Chuck Wagon',   art: 'wagon',   dmg: 0,  atkRange: 0,   cooldown: 1,   resupplies: true },
  journalist:  { name: 'News Van',      art: 'news',    dmg: 0,  atkRange: 0,   cooldown: 1,   investigator: true, proofDropoff: true },
};

// ---------- DISPROOF (the Flat Earth economy of denial) ----------
// The Institute of Truth does not research new toys — it proves the enemy's
// toys are FAKE, and a disproved thing stops working on you for the rest of
// the match. This is the faction's whole strategic layer, and unlike a meter
// that ticks on its own it is REACTIVE: you scout what they are actually
// fielding and deny that, so no two games research the same order. One at a
// time, no refunds, and every Ham Radio Shack standing shortens the wait.
// Bought at the Institute of Truth, paid in MINERALS — proof is the Broadcast
// Station's currency, so the faction has two strategic taps that draw on
// different economies: minerals buy DENIAL, proof buys PRESSURE.
//
// Two of these used to be off-switches rather than counters. "Stealth Is a
// Psyop" deleted the Deep State's entire identity for 260, and "Crisis Actors"
// permanently voided every conversion, abduction and sleeper mechanic three
// factions are built around. One purchase, no counterplay, forever — the kind
// of card that makes a matchup unplayable instead of interesting.
// Both are GRADED now. They are still the hard counter; the other side still
// gets to play.
const DISPROOFS = {
  stealth:    { name: 'Stealth Is a Psyop',      cost: 260, time: 45,
                desc: 'Nobody is that good. Everything you own looks TWICE as hard — enemy infiltrators need half the suspicion to give themselves away, and the ones holding perfectly still are the only ones you will still miss.' },
  actors:     { name: 'Crisis Actors',           cost: 250, time: 42,
                desc: 'They are paid, and paid people go home. Taking one of your people takes THREE TIMES as long, and anyone they do take walks back to you 30s later. Any of yours already turned come straight back.' },
  ballistics: { name: 'Ballistics Is a Theory',  cost: 220, time: 38,
                desc: 'Shells cannot arc over a flat earth. Enemy artillery and other lobbed weapons scatter wildly when they fire at anything of yours.' },
  nukes:      { name: 'Nukes Are Fake',          cost: 320, time: 55,
                desc: 'The mushroom cloud was a film set. Enemy superweapons do HALF damage to everything you own.' },
  sky:        { name: 'The Sky Is Closed',       cost: 340, time: 60,
                desc: 'The firmament is shut for good. Enemy aircraft over your base take 9 damage a second and fly at half speed — your own wing floats, so it never touches them.' },
};
// The Bloodline Coup's hold. 45s was long enough that a well-timed cast
// decided a fight outright — the borrowed army had time to win it before
// anybody came back.
const COUP_HOLD = 20;

// how Crisis Actors grades: slower to take, and never permanent
const ACTORS_SLOW = 3;      // conversion and abduction attempts against you take this much longer
const ACTORS_RETURN = 30;   // ...and anyone they manage to take walks home after this
const DISPROOF_SKY_R = 340;   // how far the closed sky reaches from your structures

// ---------- Quantitative Easing (Globalist passive) ----------
// The printer pays a slice of the power the base actually DRAWS. Left uncapped
// that is a runaway loop — every structure raises upkeep, upkeep IS the
// revenue, so building more pays for building more. At full build-out it was
// paying ~118/10s (11.8/sec), more than any other faction's ENTIRE economy
// from all sources combined. The cap turns it back into a solid floor instead
// of an engine: good early when the grid is small, no longer a snowball.
const QE_RATE = 0.12;   // fraction of power drawn, paid every 10s
const QE_CAP = 40;      // ...but never more than this per payout (4/sec)

// ---------- LEVERAGE (Deep State) ----------
// Every mineral a Front Company skims is banked twice: once as money, and once
// as a record of what it was skimmed from. That record is LEVERAGE, and it
// buys things money cannot. Every play is non-lethal and aimed at an enemy
// STRUCTURE — the Deep State does not shoot your base, it ruins your quarter.
// (Cost is in leverage, never in minerals; the minerals were already paid.)
const LEVERAGE_PLAYS = {
  books: {
    name: 'Open the Books', cost: 60,
    desc: 'Their entire estate — every building and everything standing near it — is laid bare to you for 25s.',
    dur: 25,
  },
  freeze: {
    name: 'Freeze Assets', cost: 140,
    desc: 'The target structure goes dark for 30s: no production, no weapons, no power on the grid.',
    dur: 30,
  },
  margin: {
    name: 'Margin Call', cost: 220,
    desc: "Their construction is called in — whatever they are building right now is cancelled, and not one mineral comes back.",
  },
};

// ---------- bound escorts (Broodmother, Disinfo Van, Mothership) ----------
// The swarm screens in FRONT of its master and makes contact first; the master
// holds back and keeps working. Without this the escort trailed behind her and
// the fragile thing leading the swarm was the swarm's whole reason to exist.
const BROOD_LEAD = 95;      // how far ahead of the master the screen rides
const BROOD_STANDOFF = 130; // master backs off from anything closer than this

// ---------- Smuggling Routes (Resistance signature) ----------
// The run pays for holding the countryside, and holdings are counted BY
// DISTRICT, not by door: the first captured civilian building claims a
// SMUGGLE_AREA-radius region and every other building inside that region is
// worth nothing extra. Otherwise a Metropolis map — where a city block has a
// dozen structures — would pay several times what a Country map does for the
// same effort.
const SMUGGLE_BASE = 150;       // the run itself
const SMUGGLE_PER_AREA = 45;    // per distinct district held
const SMUGGLE_AREA = 620;       // radius a single holding claims
const SMUGGLE_MAX_AREAS = 4;    // ceiling, so a huge map can't run away either

// ---------- superweapons ----------
// One tech-gated structure per faction (the shared `superweapon` building
// type below); charge = seconds to ready, kind = what firing it does.
const SUPER_DEFS = {
  flat:       { charge: 180, kind: 'rocket',  desc: 'Katyusha salvo — a spread of heavy rockets saturates a small area (inaccurate but devastating)' },
  resistance: { charge: 130, kind: 'barrage', desc: 'Loitering-munition swarm — waves of drones rain on the zone' },
  glob:       { charge: 180, kind: 'orbital', desc: 'Orbital kinetic strike — instant, precise, devastating' },
  deep:       { charge: 150, kind: 'emp',     desc: 'Total Blackout — enemy structures in the zone go dark for 20s' },
  hollow:     { charge: 180, kind: 'quake',   desc: 'The Big One — a quake dismantles every structure in the zone' },
  grey:       { charge: 180, kind: 'ray',     desc: 'Pyramid Death Ray — a sustained beam annihilates the zone' },
  reptilian:  { charge: 190, kind: 'coup',    desc: 'Bloodline Coup — costs 60 loosh to fire and drinks up to 200: the more blood banked, the WIDER the zone. Enemies inside fight for YOU for 20s' },
};

// ---------- units ----------
// targets: 'ground' | 'air' | 'both' (default 'ground' for anything armed)
// weapon: 'gun' (default) | 'lob' | 'bomb' | 'storm' | 'spray' | 'carpet'
// pad: RA2-style airfield craft — occupies one of its airpad's 4 slots,
//      parks there when idle, and burns maxAmmo ammo it reloads on the pad.
//      Air units WITHOUT pad (helicopters, blimps, saucers) fly free.
// plane: fixed-wing — keeps airspeed and a turn rate (turn, rad/s) instead of
//        hovering: strafing runs, loitering circles, bombing passes. A
//        'carpet' bomber walks burstShells bombs along its flight path,
//        scattered over beatenLen x beatenWidth around the aim point.
// req: building type that must be finished before the unit can be trained.

const UNIT_TYPES = {
  // workers — every faction's worker line is its own mining rig (the aliens
  // have none). carry: minerals hauled per trip; limit: hard per-player cap
  // (alive + queued). The flat-earth family's carry less but come lightly
  // armed; the Bore Rig is a slow armored hauler with a drill for a face.
  harvester:  { name: 'Mining Rig',   role: 'worker', builtAt: 'hq', hp: 200, speed: 55, dmg: 5, atkRange: 90, cooldown: 1,   sight: 200, cost: 110, r: 13, buildTime: 9,  carry: 14, shape: 'square', limit: 4 },
  blackrig:   { name: 'Unmarked Rig', role: 'worker', builtAt: 'hq', hp: 190, speed: 58, dmg: 6, atkRange: 95, cooldown: 1,   sight: 260, cost: 105, r: 13, buildTime: 9,  carry: 12, shape: 'square', limit: 4, cloakStill: true },
  // Cut to 3 (from 6): mining is no longer the Flat Earth economy, it is the
  // BRIDGE to the first homestead or two. A big rig fleet competed with the
  // farms for the same money and blunted the whole point of the faction.
  truthrig:   { name: 'Rig of Truth', role: 'worker', builtAt: 'hq', hp: 150, speed: 60, dmg: 4, atkRange: 85, cooldown: 0.9, sight: 190, cost: 90,  r: 12, buildTime: 8,  carry: 9,  shape: 'square', limit: 3 },
  salvagerig: { name: 'Salvage Rig',  role: 'worker', builtAt: 'hq', hp: 130, speed: 72, dmg: 4, atkRange: 90, cooldown: 0.9, sight: 200, cost: 80,  r: 12, buildTime: 7,  carry: 8,  shape: 'square', limit: 5 },
  borerig:    { name: 'Bore Rig',     role: 'worker', builtAt: 'hq', hp: 240, speed: 45, dmg: 8, atkRange: 24, cooldown: 1.1, sight: 170, cost: 120, r: 13, buildTime: 10, carry: 16, shape: 'square', limit: 5 },
  // basic infantry
  // Flat line infantry, and the faction's UNIT OF ACCOUNT — every homestead
  // holds four, every prepper cache converts one, and the Bug Out Van hauls
  // them. Deliberately BEEFY and deliberately not good: a lot of hit points
  // wrapped around a mediocre rifle, because their job is to survive the walk
  // to a cache and come back up as something that can actually fight.
  // They are also free (homesteads grow them), so the sticker price is not the
  // real cost — the real cost is a quarter of a farm's income going quiet.
  militia:     { name: 'Truther Militia', role: 'combat', builtAt: 'barracks', hp: 140, speed: 74, dmg: 6,  atkRange: 100, cooldown: 0.75, sight: 210, cost: 50, r: 9,  buildTime: 5, plantMine: true },
  partisan:    { name: 'Partisan',        role: 'combat', builtAt: 'barracks', hp: 60,  speed: 92, dmg: 4,  atkRange: 95,  cooldown: 0.7,  sight: 210, cost: 35, r: 8,  buildTime: 4, plantMine: true },
  // the Reptilian workforce: cheap, unarmed, worked in the crystal fields
  // until they drop (~lifespan seconds, staggered). Every death — overwork,
  // enemy fire, or the Harvest button — pays looshOnDeath, and the Hatchery
  // automatically buys a replacement. The pit restocks itself.
  slave:       { name: 'Slave',           role: 'worker', builtAt: 'barracks', hp: 35,  speed: 82, dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 160, cost: 25, r: 7,  buildTime: 3, limit: 8, lifespan: 110, looshOnDeath: 3, pitBonus: true },
  // Broodslave: the Gene Vault's own crop, grown for the work rather than
  // caught for it. Nearly three times the price of a Slave and it hauls twice
  // the crystal, burns out sooner, and its death pays THREE TIMES the loosh —
  // the late-game answer to a pit that mines and bleeds too slowly to keep the
  // caste fed. Its own separate cap, so it adds to the pit instead of
  // competing for it (and it takes no Vault/Throne bonus of its own).
  broodslave:  { name: 'Broodslave',       role: 'worker', builtAt: 'barracks', hp: 55,  speed: 78, dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 170, cost: 70, r: 8,  buildTime: 5, limit: 4, carry: 13, lifespan: 95, looshOnDeath: 9, req: 'tech', drawScale: 1.12 },
  // Deep State line infantry now: an agent is nobody until the wire comes in
  agent:       { name: 'Agent',           role: 'combat', builtAt: 'barracks', hp: 110, speed: 68, dmg: 8,  atkRange: 130, cooldown: 0.85, sight: 220, cost: 65, r: 10, buildTime: 6, cloakStill: true, cloakDelay: 1.8 },
  // Globalist line infantry: contractors with MiB-grade training and a
  // MiB-grade invoice — no cloak, just kit
  pmc:         { name: 'PMC Contractor',  role: 'combat', builtAt: 'barracks', hp: 105, speed: 72, dmg: 12, atkRange: 140, cooldown: 0.85, sight: 240, cost: 120, r: 10, buildTime: 7, drawScale: 1.08 },
  mib:         { name: 'Man in Black',    role: 'combat', builtAt: 'barracks', hp: 100, speed: 70, dmg: 11, atkRange: 140, cooldown: 0.9,  sight: 240, cost: 80, r: 10, buildTime: 7, cloakStill: true, cloakDelay: 1.8 },
  // Hollow line infantry: half-flesh menials with pick-rifles — cheap, loyal,
  // and the raw material of the whole ascension ladder — every other body the
  // faction fields started as one of these on a Mechanicum slab. Treat the
  // stats below as the Hollow UNIT OF ACCOUNT: a Lantern Guard is priced and
  // tuned at ~6 servitors, a Dreadnought at ~3 Guards.
  moleservitor: { name: 'Mole Servitor',  role: 'combat', builtAt: 'barracks', hp: 80,  speed: 74, dmg: 6,  atkRange: 95,  cooldown: 0.7,  sight: 190, cost: 45, r: 9,  buildTime: 5 },
  greytrooper: { name: 'Grey Abductor',   role: 'combat', builtAt: 'barracks', hp: 70,  speed: 78, dmg: 7,  atkRange: 120, cooldown: 0.8,  sight: 230, cost: 55, r: 9,  buildTime: 5 },
  raptoid:     { name: 'Reptoid Warrior', role: 'combat', builtAt: 'barracks', hp: 130, speed: 85, dmg: 10, atkRange: 30,  cooldown: 0.8,  sight: 210, cost: 70, r: 10, buildTime: 6 },
  // anti-air infantry: full damage vs air, dmgVsGround when shooting ground
  laserguy: { name: 'Laser Pointer Guy', role: 'combat', builtAt: 'barracks', hp: 65, speed: 75, dmg: 9,  dmgVsGround: 4, atkRange: 175, cooldown: 0.6,  sight: 250, cost: 60, r: 9, buildTime: 6, targets: 'both' },
  // Resistance AA: a shoulder-fired Stinger — brutal to aircraft, near-useless
  // against ground, long reach and a slow reload
  manpad:   { name: 'MANPAD Partisan',   role: 'combat', builtAt: 'barracks', hp: 55, speed: 88, dmg: 17, dmgVsGround: 3, atkRange: 235, cooldown: 1.9, sight: 270, cost: 65, r: 8, buildTime: 6, targets: 'both', rocketArt: true },
  jammer:   { name: 'Signal Jammer',     role: 'combat', builtAt: 'barracks', hp: 80, speed: 70, dmg: 11, dmgVsGround: 5, atkRange: 185, cooldown: 0.7,  sight: 260, cost: 70, r: 9, buildTime: 6, targets: 'both', jams: true },
  slinger:  { name: 'Crystal Slinger',   role: 'combat', builtAt: 'barracks', hp: 70, speed: 72, dmg: 10, dmgVsGround: 4, atkRange: 180, cooldown: 0.65, sight: 250, cost: 65, r: 9, buildTime: 6, targets: 'both' },
  beamer:   { name: 'Beam Walker',       role: 'combat', builtAt: 'barracks', hp: 75, speed: 74, dmg: 10, dmgVsGround: 5, atkRange: 180, cooldown: 0.65, sight: 260, cost: 70, r: 9, buildTime: 6, targets: 'both' },
  // cross-faction support: engineers capture enemy structures (consumed on
  // use); repair units mend nearby allied vehicles and aircraft. All fragile,
  // all unarmed.
  engineer:     { name: 'Engineer',           role: 'combat', builtAt: 'barracks', hp: 60,  speed: 70,  dmg: 0, atkRange: 0, cooldown: 1, sight: 200, cost: 90,  r: 9,  buildTime: 7, captures: true },
  shapeshifter: { name: 'Shapeshifter',       role: 'combat', builtAt: 'barracks', hp: 70,  speed: 80,  dmg: 0, atkRange: 0, cooldown: 1, sight: 220, cost: 110, r: 9,  buildTime: 8, captures: true },
  mechanic:     { name: 'Repair Truck',       role: 'combat', builtAt: 'factory',  hp: 180, speed: 82,  dmg: 0, atkRange: 0, cooldown: 1, sight: 200, cost: 100, r: 12, buildTime: 8, repair: 9, shape: 'square' },
  menderorb:    { name: 'Mender Orb',         role: 'combat', builtAt: 'factory',  hp: 90,  speed: 100, dmg: 0, atkRange: 0, cooldown: 1, sight: 240, cost: 110, r: 9,  buildTime: 8, repair: 8, flying: true, shape: 'blimp' },
  // specialist infantry
  // Megaphone Prophet: a walking field hospital, rally banner, demoralising
  // racket and recruiter, all on the move and all with no gun. You may field
  // THREE, each individually much weaker than the single super-Prophet he
  // replaced — the faction's support is a chorus you position across the line,
  // not one irreplaceable man you dare not lose.
  prophet: { name: 'Megaphone Prophet', role: 'combat', builtAt: 'barracks', hp: 190, speed: 70, dmg: 0, atkRange: 0, cooldown: 1, sight: 240, cost: 200, r: 9, buildTime: 10, limit: 3,
             mendAura: { r: 118, rate: 5 },         // patches up the faithful around him
             buffAura: { r: 118 },                  // ...and they hit 25% harder for it
             debuffAura: { r: 130, weaken: 0.28 },  // the racket puts the enemy off their aim
             convert: { every: 30, r: 105 } },      // and now and then one of them walks over
  riot:     { name: 'Riot Trooper',       role: 'combat', builtAt: 'barracks', hp: 180, speed: 60, dmg: 10, atkRange: 26,  cooldown: 0.8, sight: 190, cost: 75, r: 10, buildTime: 7, armor: 0.35 }, // shield wall: melee baton
  // grey lab crew: the vivisector drains the living and mends the machine,
  // the mutilator turns fresh wrecks into minerals (scavenge = payout/kill)
  vivisector: { name: 'Zeta Vivisector',  role: 'combat', builtAt: 'barracks', hp: 85,  speed: 74, dmg: 5, atkRange: 120, cooldown: 0.8, sight: 240, cost: 120, r: 9,  buildTime: 8, repair: 6, leech: true },
  mutilator:  { name: 'Cattle Mutilator', role: 'combat', builtAt: 'factory',  hp: 200, speed: 85, dmg: 7, atkRange: 110, cooldown: 0.9, sight: 240, cost: 130, r: 12, buildTime: 9, shape: 'square', scavenge: 12 },
  // ---------- Grey network (weak drones + buffer units) ----------
  // A lone drone is pathetic; power comes from the handlers it's tethered to.
  // true chaff now: weaker per body, cloned three at a time — the swarm is
  // the unit, the Handlers are the weapon
  greydrone:  { name: 'Grey Drone',        role: 'combat', builtAt: 'barracks', hp: 38,  speed: 82, dmg: 4, atkRange: 110, cooldown: 0.8, sight: 210, cost: 65,  r: 8,  buildTime: 6, drawScale: 0.9, batch: 3 },
  // Handler: the offense hub — emboldens every drone in its field (buffAura,
  // +25% damage). Kill the handler and the blob goes limp.
  handler:    { name: 'Grey Handler',      role: 'combat', builtAt: 'barracks', hp: 95,  speed: 72, dmg: 5, atkRange: 120, cooldown: 0.9, sight: 250, cost: 75,  r: 9,  buildTime: 7, buffAura: { r: 165 } },
  // Technician: the defense hub — shields nearby drones (hardenAura, −28%
  // damage taken). Offense and defense live in two bodies to protect.
  technician: { name: 'Grey Technician',   role: 'combat', builtAt: 'barracks', hp: 90,  speed: 70, dmg: 4, atkRange: 110, cooldown: 1,   sight: 230, cost: 85,  r: 9,  buildTime: 7, hardenAura: { r: 155 } },
  // Tall White Overseer: elite command node — a far larger buff field that ties
  // scattered drone packs into one network.
  overseer:   { name: 'Tall White Overseer', role: 'combat', builtAt: 'barracks', hp: 135, speed: 66, dmg: 7, atkRange: 130, cooldown: 0.9, sight: 270, cost: 145, r: 10, buildTime: 9, drawScale: 1.2, buffAura: { r: 220 }, req: 'tech' },
  // Tic Tac: the Mothership's bound escort — a silent white lozenge with a sting
  // for air and ground. Brood-spawned only (never trained directly).
  tictac:     { name: 'Tic Tac', flyH: 34, role: 'combat', builtAt: 'airpad', hp: 130, speed: 132, dmg: 12, atkRange: 145, cooldown: 0.6, sight: 280, cost: 0, r: 9, buildTime: 0, flying: true, targets: 'both', shape: 'tictac' },
  // reptilian brood: the mother herself is fragile with a feeble bite — her
  // weapon is a bound swarm of hatchlings that shadows her, tops itself back
  // up as it dies, and dogpiles whatever she attacks. Kill her, kill the swarm.
  // She still emboldens nearby infantry (+25% damage via buffAura).
  broodmother: { name: 'Chitauri Broodmother', role: 'combat', builtAt: 'barracks', hp: 150, speed: 64, dmg: 4, atkRange: 90, cooldown: 1.2, sight: 230, cost: 175, r: 12, buildTime: 12, req: 'tech', brood: { count: 5, regen: 5 }, buffAura: { r: 160 } },
  hatchling:   { name: 'Chitauri Hatchling',   role: 'combat', hp: 35,  speed: 95, dmg: 6, atkRange: 24,  cooldown: 0.6, sight: 200, cost: 0,   r: 7,  buildTime: 0 },
  // ---------- Reptilian caste (loosh-funded elite) ----------
  // Nephilim: expensive giant shock-troops that FEED — every blow heals them
  // (leech), so a survivor snowballs. You field a few, not a horde.
  nephilim: { name: 'Nephilim', role: 'combat', builtAt: 'barracks', hp: 210, speed: 70, dmg: 18, atkRange: 32, cooldown: 0.9, sight: 210, cost: 95, loosh: 40, r: 11, buildTime: 9, armor: 0.15, leech: true, drawScale: 1.3, req: 'tech' },
  // Priest caste: no real bite — a fear aura that saps enemy damage (debuffAura)
  // and a paralysing gaze that petrifies its target (mind-seize). The Basilisk's
  // old crowd-control, rehoused where it isn't campy.
  priest: { name: 'Reptilian Priest', role: 'combat', builtAt: 'barracks', hp: 95, speed: 68, dmg: 4, atkRange: 150, cooldown: 1.7, sight: 250, cost: 80, loosh: 30, r: 9, buildTime: 8, petrify: 2, debuffAura: { r: 165, weaken: 0.4 }, req: 'tech' },
  // Sirrush: the Ishtar-Gate dragon. A heavy armoured quadruped devourer that
  // heals off everything it hits (leech) — the Reptilian tank, replaces the
  // Basilisk. Minerals-funded so the brood can start the fights that earn loosh.
  sirrush: { name: 'Sirrush', role: 'combat', builtAt: 'factory', hp: 470, speed: 66, dmg: 23, atkRange: 34, cooldown: 1.0, sight: 220, cost: 185, r: 15, buildTime: 13, armor: 0.22, bldgBonus: 1.4, leech: true, shape: 'square' },
  // Gargoyle Brood: cheap, fast stone-winged swarm that harasses air and ground
  gargoyle: { name: 'Gargoyle Brood', role: 'combat', builtAt: 'airpad', hp: 60, speed: 120, dmg: 7, atkRange: 60, cooldown: 0.7, sight: 240, cost: 55, r: 8, buildTime: 5, flying: true, targets: 'both', shape: 'tri' },
  // Dread Screecher: a flying priest-beast — its wail is a mobile fear aura
  // (debuffAura) over the battlefield, with a shrieking sonic bolt of its own
  // echolocation: the wail that terrifies also finds — the brood's detector
  screecher: { name: 'Dread Screecher', flyH: 30, role: 'combat', builtAt: 'airpad', hp: 155, speed: 100, dmg: 11, atkRange: 135, cooldown: 1.1, sight: 270, cost: 140, r: 11, buildTime: 10, flying: true, targets: 'both', shape: 'tri', debuffAura: { r: 180, weaken: 0.35 }, detector: true },
  // ---------- the Hollow Mechanicus ----------
  // None of these three are TRAINED. They are made on a Mechanicum slab out
  // of the body below them (see ASCEND) — that is the entire Hollow tech tree.
  //
  // Both war bodies fight on the same doctrine, and it is worth stating once:
  // they are MELEE units with a heavy weapon on a clock. The base attack (dmg
  // /atkRange/cooldown) is the halberd or the fist, swung at contact range.
  // The gun is the `volley` block — a barrage that goes off on its own timer
  // whether or not the body is already in a brawl, at `acc` accuracy standing
  // off and the much worse `meleeAcc` while swinging. See updateVolley().
  //
  // Tech Priest: heals the flesh AND mends the machine (repair), recovers
  // excavated relics (walks to a dug site, channels, teleports home with the
  // prize), and salvages fallen Guard/Dreadnought armor for cheaper rebuilds.
  techpriest: { name: 'Tech Priest', role: 'combat', builtAt: 'mechanicum', hp: 95, speed: 70, dmg: 0, atkRange: 0, cooldown: 1, sight: 240, cost: 0, r: 9, buildTime: 0, repair: 8, priest: true },
  // Lantern Guard — priced and tuned at ~6 Mole Servitors (270 minerals, and
  // roughly 6× a servitor's damage once the barrage is averaged in). The
  // halberd is the day job; every 20-30s the bolter opens up, sweeps ground
  // and anything hovering low, and the Guard charges in behind its own volley.
  lanternguard: {
    name: 'Lantern Guard', role: 'combat', builtAt: 'mechanicum', hp: 430, speed: 66,
    dmg: 44, atkRange: 36, cooldown: 1.0, sight: 250, cost: 0, r: 10, buildTime: 0,
    armor: 0.3, swing: true, vril: true, armorTier: 'guard', drawScale: 1.15,
    volley: {
      name: 'bolter barrage', every: [20, 30], shots: 6, gap: 0.14, dmg: 26,
      range: 230, acc: 0.9, meleeAcc: 0.55, lowAir: true, charge: 3,
    },
  },
  // Dreadnought — a Guard entombed, and priced at ~3 Guards (810 minerals all
  // in). Kills with the power fist; the arm cannon barks every ~15s and the
  // shoulder rack answers it with three rockets that WILL reach aircraft at
  // any altitude. Both keep firing mid-brawl, just badly aimed.
  dreadnought: {
    name: 'Dreadnought', role: 'combat', builtAt: 'mechanicum', hp: 1100, speed: 48,
    dmg: 96, atkRange: 40, cooldown: 0.8, sight: 260, cost: 0, r: 14, buildTime: 0, limit: 2,
    armor: 0.42, bldgBonus: 1.4, clawArm: true, vril: true, armorTier: 'dread', drawScale: 1.9,
    // RELENTLESS: at a walk it is the slowest thing on the field, and a melee
    // unit that cannot catch anything only ever kills buildings — infantry
    // simply strolled away from it. With a target marked it builds momentum
    // and runs foot troops down; it still cannot catch a technical.
    relentless: 1.8,
    volley: {
      name: 'autocannon burst', every: [14, 17], shots: 5, gap: 0.12, dmg: 34,
      range: 210, acc: 0.9, meleeAcc: 0.5, lowAir: true, charge: 3,
      // the shoulder rack fires straight off the back of the burst
      rockets: { count: 3, gap: 0.28, delay: 0.45, dmg: 60, range: 300, acc: 0.95, meleeAcc: 0.6 },
    },
  },
  // resistance specialists: the RPG tube is their can opener (vehBonus
  // multiplies damage vs ground vehicles), the marksman their long arm —
  // one bullet, one man: light infantry die to a single round, but the same
  // round barely dents armor plate or concrete (vehBonus/bldgBonus < 1)
  rpgpartisan: { name: 'RPG Partisan', role: 'combat', builtAt: 'barracks', hp: 55, speed: 85, dmg: 26, atkRange: 150, cooldown: 2.2, sight: 230, cost: 75, r: 9, buildTime: 6, bldgBonus: 2, vehBonus: 2.2, rocketArt: true },
  // bldgBonus 0.08, same as the Homestead Marksman and for the same reason: a
  // precision rifle was doing 12.8 dps to structures, more than ANY line
  // infantry in the game. Snipers kill people; the cell's answer to a building
  // is the RPG Partisan.
  marksman:    { name: 'Marksman',     role: 'combat', builtAt: 'barracks', hp: 50, speed: 75, dmg: 110, atkRange: 260, cooldown: 3.0, sight: 300, cost: 85, r: 9, buildTime: 7, vehBonus: 0.35, bldgBonus: 0.08 },
  // ---------- the Flat Earth field layer ----------
  // THE HOMESTEAD MARKSMAN is the most important body the faction owns, and it
  // does two jobs that are really one job: it is the rifle that watches the
  // approaches, and it is the LOGISTICS. It goes out unseen (stealth — broken
  // only by its own muzzle flash, then it fades again), buries prepper caches
  // in enemy country, and walks home for more.
  // The old Deer Stand version could only shoot from a treeline; this one has
  // given up the stand for a ghillie and works anywhere.
  // bldgBonus 0.08: a rifle round does essentially nothing to a wall, and at
  // the old 0.3 a Marksman out-damaged a militiaman against buildings, which is
  // backwards. Snipers kill people. The faction's answer to structures is the
  // Breacher, the Killdozer and demolition charges.
  homesteader: { name: 'Homestead Marksman', role: 'combat', builtAt: 'barracks', hp: 65, speed: 70,
                 dmg: 130, atkRange: 300, cooldown: 3.4, sight: 320, cost: 150, r: 9, buildTime: 9,
                 vehBonus: 0.3, bldgBonus: 0.08, stealth: true, caches: CACHE_CARRY },
  // EX-SPECIAL FORCES — what a Homestead Marksman becomes when it boards the
  // Bush Plane, and the only way to get one.
  // NOT a better sniper. The faction already has a sniper, and three more of
  // them landing behind the line is just three more rifles. These are DEMOLITION
  // men: they carry charges, and a charge does not care how many hit points a
  // building has. Three of them dropped on a Fusion Plant, a superweapon or a
  // packed airfield removes it, and the enemy's first warning is the fuse.
  // The rifle is there so they can defend the walk in, not so they can trade.
  // same reasoning as the Marksman: the carbine was doing 48 dps to structures,
  // which quietly made the charges optional. The charge IS the unit.
  specops: { name: 'Ex-Special Forces', role: 'combat', builtAt: null, hp: 165, speed: 84,
             dmg: 34, atkRange: 150, cooldown: 0.7, sight: 320, cost: 0, r: 9, buildTime: 0,
             bldgBonus: 0.25, stealth: true, charges: DEMO_CHARGES },
  // The Bush Plane once it is off the ground. A REAL aircraft from the moment
  // it lifts: no weapon, no stealth, and every SAM, AA nest and interceptor on
  // the map gets a shot at it on the way in. Losing it loses the whole team,
  // which is the risk that pays for landing three demolition men behind a line.
  // (The strip it launches from is BUILDING_TYPES.bushplane — different table.)
  bushflight: { name: 'Bush Plane', role: 'combat', builtAt: null, hp: 300, speed: 190,
                dmg: 0, atkRange: 0, cooldown: 1, sight: 300, cost: 0, r: 12, buildTime: 0,
                flying: true, shape: 'tri' },
  // ---------- cache kit: what a militia comes back up as ----------
  // Neither of these is built anywhere. A militia walks to a prepper cache,
  // spends CACHE_CONVERT seconds in it, and climbs out as one of them.
  // ANTI-MATERIEL RIFLE: a rifle that treats a tank like a filing cabinet.
  // Enormous against armor, long, slow, and nearly worthless against people.
  amr:      { name: 'Anti-Materiel Rifle', role: 'combat', builtAt: null, hp: 90, speed: 66,
              dmg: 70, atkRange: 265, cooldown: 2.6, sight: 280, cost: 0, r: 9, buildTime: 0,
              vehBonus: 2.6, bldgBonus: 0.12 },
  // BREACHER: door-to-door work. Short reach, brutal inside it, and the only
  // infantry answer the faction has to a garrisoned building.
  // bldgBonus 1.0 — no structure bonus at all, just a fast gun up close. It was
  // 2.4 (120 dps), then 1.5 (75), and both still beat a 185-mineral Killdozer's
  // 65 from a body that costs one militia and a cache charge. The KILLDOZER is
  // the faction's demolition answer; the Breacher is what clears the doorway in
  // front of it. 50 dps, and it has to stand at 55 range to get it.
  breacher: { name: 'Breacher', role: 'combat', builtAt: null, hp: 175, speed: 76,
              dmg: 30, atkRange: 55, cooldown: 0.6, sight: 190, cost: 0, r: 9, buildTime: 0,
              armor: 0.2, bldgBonus: 1.0 },
  // THE INVESTIGATIVE JOURNALIST gathers PROOF — it walks up to enemy
  // structures and battles and documents them, then carries the footage home.
  // Unarmed, fragile, sees a very long way, and spots what is hiding.
  // (Stealth mode / rush mode and the proof economy itself are still open —
  // this is the body; the Broadcast Station rework wires up what it earns.)
  journalist: { name: 'Investigative Journalist', role: 'combat', builtAt: 'barracks', hp: 70, speed: 88,
                dmg: 0, atkRange: 0, cooldown: 1, sight: 330, cost: 90, r: 9, buildTime: 7,
                cloakStill: true, cloakDelay: 1.5, detector: true, investigator: true },
  // vehicles
  // THE BUG OUT VAN rolls off the line as nothing at all: a panel van, quick,
  // unarmed, with the seats pulled out. What it BECOMES depends on who climbs
  // in — one body, welded into the role it brought with it (see BUGOUT_KITS).
  // Empty, it is still useful: it is the only thing the faction has that can
  // haul militia to a forward cache instead of walking them there.
  // Unload and you get the passenger back and the van back; kill it loaded and
  // you lose both.
  bugoutvan: { name: 'Bug Out Van', role: 'combat', builtAt: 'factory', hp: 300, speed: 92,
               dmg: 0, atkRange: 0, cooldown: 1, sight: 220, cost: 120, r: 13, buildTime: 9,
               shape: 'square', armor: 0.15, cargoCap: 4, bailOut: true, loader: true },
  // Killdozer: a home-armored bulldozer — crawling, nearly bulletproof
  // (armor), and it plows through walls and buildings (heavy bldgBonus)
  killdozer: { name: 'Killdozer',        role: 'combat', builtAt: 'factory', hp: 520, speed: 36,  dmg: 26, atkRange: 30,  cooldown: 1.2,  sight: 180, cost: 185, r: 14, buildTime: 12, bldgBonus: 3, armor: 0.5, shape: 'square' },
  // prepper mobility: a camo quad bike with a varmint rifle across the bars —
  // cheap, quick, and the only fast thing the compound owns
  quadrunner: { name: 'Quad Runner',     role: 'combat', builtAt: 'factory', hp: 100, speed: 125, dmg: 7,  atkRange: 100, cooldown: 0.55, sight: 280, cost: 70,  r: 10, buildTime: 6, shape: 'square' },
  // the armored School Bus: welded plate over yellow steel. Six believers
  // ride inside firing their own weapons out the windows, and the wreck
  // spills them out alive (bailOut) when it finally dies. No gun of its own.
  // no gun of its own — every shot comes from the six believers inside, who
  // shoot FURTHER from the slits than they ever could on foot (portRange).
  // Thick, slow and crush-proof: a rolling pillbox you push forward, not a taxi.
  schoolbus:  { name: 'School Bus Bunker', role: 'combat', builtAt: 'factory', hp: 600, speed: 60, dmg: 0, atkRange: 0,  cooldown: 1,    sight: 220, cost: 230, r: 14, buildTime: 13, shape: 'square', armor: 0.45, cargoCap: 6, portRange: 45, bailOut: true },
  // the all-purpose Toyota: cheap, fast, shoots at everything — and dents
  // nothing armored (the RPG Partisan is the anti-vehicle answer)
  // rides four in the OPEN bed: loaded partisans are visible, fire their own
  // weapons from the truck, and get thrown clear (hurt, alive) if it dies
  technical: { name: 'Technical',        role: 'combat', builtAt: 'factory', hp: 150, speed: 108, dmg: 10, dmgVsGround: 9, atkRange: 110, cooldown: 0.5, sight: 230, cost: 80, r: 12, buildTime: 6, shape: 'square', targets: 'both', cargoCap: 4, bailOut: true },
  // Globalist armor: one tank, the correct tank. Pricey, thick, final.
  abrams:    { name: 'M1 Abrams',        role: 'combat', builtAt: 'factory', hp: 560, speed: 62,  dmg: 38, atkRange: 170, cooldown: 1.7,  sight: 240, cost: 480, r: 14, buildTime: 17, shape: 'square', armor: 0.25, bldgBonus: 1.3 },
  // IFV: an autocannon up top, four PMC fire teams shooting from the ports —
  // and a rear ramp: the squad bails out (hurt, alive) if the hull dies
  bradley:   { name: 'M2 Bradley',       role: 'combat', builtAt: 'factory', hp: 340, speed: 88,  dmg: 12, atkRange: 130, cooldown: 0.45, sight: 240, cost: 280, r: 13, buildTime: 10, shape: 'square', armor: 0.15, cargoCap: 4, bailOut: true },
  // Globalist siege: six guided rockets on a truck. Outranges every tower,
  // wrecks structures, helpless up close and lightly built. Pricey. Works.
  himars:    { name: 'HIMARS',           role: 'combat', builtAt: 'factory', hp: 170, speed: 70,  dmg: 24, atkRange: 320, minRange: 130, cooldown: 3.2, sight: 330, cost: 320, r: 13, buildTime: 13, shape: 'square', weapon: 'lob', projectile: 'shell', scatter: 26, splash: 30, bldgBonus: 1.6, req: 'tech' },
  // Globalist detector: an unmarked van bristling with antennas — no cloak,
  // the Globalists watch openly. Finds spies, stealth and burrowers.
  blackvan:  { name: 'Surveillance Van', role: 'combat', builtAt: 'factory', hp: 220, speed: 80,  dmg: 12, atkRange: 150, cooldown: 0.7,  sight: 300, cost: 130, r: 12, buildTime: 9,  shape: 'square', detector: true },
  // Front Company: an unmarked van that DEPLOYS INTO A BUILDING — a shopfront
  // with a brass plaque and nobody in it. While it stands undetected it skims a
  // cut of every mineral load delivered to an enemy drop-off inside its reach
  // (see thief.r). It is unarmed, it runs silent while parked, and a single
  // detector walking past strips the disguise and leaves a 260-HP shed anyone
  // can shoot. Plant it near THEIR base: that is the whole risk.
  frontco: { name: 'Front Company', role: 'combat', builtAt: 'factory', hp: 190, speed: 84, dmg: 0, atkRange: 0, cooldown: 1, sight: 250, cost: 190, r: 12, buildTime: 11, shape: 'square', cloakStill: true, cloakDelay: 1.2, establishes: 'frontcompany', req: 'tech' },
  // Deep State signature armor: a blacked-out ambush tank that vanishes when
  // it stops (cloakStill) and lands a doubled first strike from concealment;
  // the Disinfo Van seeds phantom radar contacts around itself to bleed fire
  spooktank: { name: 'Redacted', role: 'combat', builtAt: 'factory', hp: 260, speed: 78, dmg: 24, atkRange: 155, cooldown: 1.6, sight: 250, cost: 155, r: 12, buildTime: 9, shape: 'square', armor: 0.15, cloakStill: true, cloakDelay: 1.3 },
  disinfovan: { name: 'Disinfo Van', role: 'combat', builtAt: 'factory', hp: 200, speed: 86, dmg: 7, atkRange: 130, cooldown: 0.8, sight: 280, cost: 140, r: 12, buildTime: 9, shape: 'square', cloakStill: true, detector: true, brood: { type: 'phantom', count: 4, regen: 6 } },
  // the rebuilt Drill Tank: an armored digger whose auger opens Dig Sites
  // (right-click one to dig; progress is visible to EVERYONE). The drill
  // still hurts whatever wanders too close, but this is a tool, not a tank.
  excavationrig: { name: 'Excavation Rig', role: 'combat', builtAt: 'factory', hp: 340, speed: 55, dmg: 12, atkRange: 26, cooldown: 1.2, sight: 190, cost: 140, r: 13, buildTime: 10, shape: 'square', digger: true },
  // Quake Drill Truck: drives, then DEPLOYS — plants its drill and fires a
  // targeted quake: a crack races along the ground and the earth convulses
  // under the target (tremor zone: damage + slow, cruel to buildings).
  // Packed up it is harmless; deployed it cannot move.
  quaketruck: { name: 'Quake Drill Truck', role: 'combat', builtAt: 'factory', hp: 270, speed: 60, dmg: 30, atkRange: 300, minRange: 110, cooldown: 4, sight: 310, cost: 210, r: 13, buildTime: 12, shape: 'square', weapon: 'quake', bldgBonus: 1.8, deployable: true },
  tripod:    { name: 'Tripod Strider',   role: 'combat', builtAt: 'factory', hp: 240, speed: 70,  dmg: 18, atkRange: 140, cooldown: 1,    sight: 250, cost: 140, r: 13, buildTime: 10, shape: 'square', armor: 0.15 },
  // Basilisk: a full multi-segment serpent-lizard. Its gaze does light damage
  // but turns victims to stone (petrify: stunned N seconds — can't move or
  // fire). Unique crowd control, and a heavy, hard-to-kill body.
  basilisk:  { name: 'Basilisk', role: 'combat', builtAt: 'factory', hp: 400, speed: 58, dmg: 13, atkRange: 120, cooldown: 1.4, sight: 230, cost: 165, r: 15, buildTime: 12, bldgBonus: 1.5, shape: 'square', petrify: 2 },
  // artillery (minRange: can't fire when rushed; lobbed projectiles with splash)
  // Firework Battery: a flatbed of bottle-rocket tubes that lobs a fast, wildly
  // inaccurate saturation volley (scatter spreads each shot around the aim)
  fireworks:     { name: 'Firework Battery', role: 'combat', builtAt: 'factory', hp: 130, speed: 46, dmg: 15, atkRange: 275, minRange: 90, cooldown: 0.9, sight: 300, cost: 155, r: 13, buildTime: 11, bldgBonus: 1.4, shape: 'square', weapon: 'lob', projectile: 'firework', splash: 26, scatter: 46 },
  mortarcrawler: { name: 'Plasma Mortar',    role: 'combat', builtAt: 'factory', hp: 160, speed: 50, dmg: 32, atkRange: 290, minRange: 110, cooldown: 3.3, sight: 310, cost: 175, r: 13, buildTime: 12, shape: 'square', weapon: 'lob', projectile: 'plasma', splash: 40 },
  // Grey anti-grav siege: a hovering projector that lobs a micro-singularity —
  // it drags every ground unit in the zone toward the core, then the well
  // collapses in one crushing implosion (see the 'singularity' zone)
  gravwell: { name: 'Gravity-Well Projector', role: 'combat', builtAt: 'factory', hp: 160, speed: 50, dmg: 10, atkRange: 290, minRange: 115, cooldown: 3.9, sight: 320, cost: 185, r: 13, buildTime: 12, shape: 'square', hover: true, weapon: 'lob', projectile: 'plasma', splash: 18, groundEffect: { kind: 'singularity', r: 95, dur: 2.4, pull: 135, dmg: 58, blast: 1.7 } },
  // air
  wballoon: { name: 'Weather Balloon',  role: 'scout',  builtAt: 'airpad', hp: 60,  speed: 90,  dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 360, cost: 40,  r: 9,  buildTime: 6,  flying: true, shape: 'blimp', detector: true },
  balloon:  { name: 'Balloon of Truth', role: 'combat', builtAt: 'airpad', hp: 420, speed: 40,  dmg: 40, atkRange: 36,  cooldown: 2.2,  sight: 240, cost: 200, r: 15, buildTime: 14, flying: true, bldgBonus: 1.5, shape: 'blimp', weapon: 'bomb', splash: 46 },
  // Flat Earth air: the Pigeon Drone ("birds aren't real") is a cheap robo-bird
  // scout that pecks at ground targets; the Barrage Balloon is a tethered
  // area-denial anti-air balloon whose cables shred any aircraft nearby (aaAura)
  barrageballoon: { name: 'Barrage Balloon', role: 'combat', builtAt: 'airpad', hp: 220, speed: 30, dmg: 0, atkRange: 0, cooldown: 1, sight: 220, cost: 95, r: 12, buildTime: 8, flying: true, shape: 'blimp', aaAura: { r: 135, dps: 15 } },
  // globalist rotorcraft roll out of the Motor Pool alongside the SUVs
  drone:    { name: 'Black Drone',      role: 'combat', builtAt: 'factory', hp: 55,  speed: 135, dmg: 8,  atkRange: 130, cooldown: 0.7,  sight: 280, cost: 85,  r: 8,  buildTime: 7,  flying: true, shape: 'tri' },
  // glass-cannon gunship: cheap, vicious, and it does not take a punch
  // glass-cannon gunship, now firing VISIBLE Hydra rockets — and walked back
  // from its reign of terror: slower volleys, softer warheads, pricier
  // it is an attack HELICOPTER, not an interceptor: Hellfires and a chin gun
  // for things on the ground, and it can reach other rotorcraft, drones and
  // balloons loitering at its own altitude (lowAir). Fast jets and the
  // high-altitude fleet are simply out of its envelope now — it used to
  // dominate the entire sky for 150 minerals.
  apache:   { name: 'AH-64 Apache',     role: 'combat', builtAt: 'factory', hp: 115, speed: 118, dmg: 16, dmgVsGround: 16, atkRange: 150, cooldown: 0.72, sight: 270, cost: 190, r: 11, buildTime: 11, flying: true, targets: 'ground', lowAir: true, shape: 'tri', rocketArt: true },
  // resistance drone wing: dirt-cheap racing quads with a payload strapped on
  // detector: with the Weather Balloon gone the cell had NO counter-stealth at
  // all — the only faction in the game without any. A swarm of camera drones is
  // the natural place for it: cheap, fragile, and it has to be flown out and
  // kept alive over the thing you want seen.
  fpv:      { name: 'FPV Swarm',        role: 'combat', builtAt: 'airpad', hp: 40,  speed: 150, dmg: 5,  atkRange: 55,  cooldown: 0.45, sight: 260, cost: 40,  r: 7,  buildTime: 4,  flying: true, shape: 'tri', detector: true },
  // Shahed: a purchasable loitering munition — flies at its target and dives
  // in for one big blast, destroying itself (kamikaze)
  shahed:   { name: 'Shahed',           role: 'combat', builtAt: 'airpad', hp: 60,  speed: 135, dmg: 0,  atkRange: 22,  cooldown: 1,    sight: 320, cost: 55,  r: 9,  buildTime: 5,  flying: true, shape: 'tri', kamikaze: { dmg: 95, splash: 48, bldgBonus: 1.5 } },
  orb:      { name: 'Scout Orb',        role: 'scout',  builtAt: 'airpad', hp: 50,  speed: 140, dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 380, cost: 40,  r: 8,  buildTime: 5,  flying: true, shape: 'blimp', detector: true },
  // reusable designator: fly it onto an enemy to PAINT the target — lasting
  // vision plus a mark that makes your army hit it 30% harder. The drone lives
  // and can be re-tasked to the next target (see the 'probe' order).
  probedrone: { name: 'Probe Drone',    role: 'scout',  builtAt: 'airpad', hp: 75,  speed: 145, dmg: 0,  atkRange: 0,   cooldown: 1,    sight: 320, cost: 60,  r: 8,  buildTime: 5,  flying: true, shape: 'blimp', tracker: true },
  saucer:   { name: 'Flying Saucer', flyH: 32, drawScale: 1.4,   role: 'combat', builtAt: 'airpad', hp: 180, speed: 115, dmg: 14, atkRange: 140, cooldown: 0.7,  sight: 300, cost: 190, r: 12, buildTime: 12, flying: true, targets: 'both', shape: 'saucer', req: 'tech' },
  drake:    { name: 'Sky Drake', flyH: 32,        role: 'combat', builtAt: 'airpad', hp: 160, speed: 105, dmg: 16, atkRange: 90,  cooldown: 0.8,  sight: 260, cost: 170, r: 11, buildTime: 11, flying: true, shape: 'tri', pad: true, maxAmmo: 8, plane: true, turn: 2.8, req: 'tech' },
  // Resistance Chemtrail Biplane: a rickety crop-duster biplane that lays a
  // lingering chemtrail (toxin) as it strafes
  chembiplane: { name: 'Chemtrail Biplane', flyH: 30, role: 'combat', builtAt: 'airpad', hp: 110, speed: 140, dmg: 8, atkRange: 70, cooldown: 1, sight: 280, cost: 130, r: 10, buildTime: 9, flying: true, shape: 'tri', weapon: 'spray', groundEffect: { kind: 'toxin', r: 26, dur: 2, dps: 5 }, pad: true, maxAmmo: 6, plane: true, turn: 2.4 },
  // the globalist air wing: a fast swing-wing strike jet, and two tech-gated
  // heavies — a carpet-bombing B-52 and the stealth-black flying wing
  // Deep State's stealth air-superiority jet: supersonic, hits hard against
  // anything flying, plinks weakly at the ground on the way home. Invisible
  // until it fires.
  b1:      { name: 'B-1 Lancer', flyH: 34,   role: 'combat', builtAt: 'airpad', hp: 200, speed: 210, dmg: 22, dmgVsGround: 9, atkRange: 165, cooldown: 0.55, sight: 300, cost: 190, r: 12, buildTime: 12, flying: true, targets: 'both', shape: 'plane', pad: true, maxAmmo: 8, plane: true, turn: 2.6, stealth: true },
  // the real one IS a stealth bomber: unseen until the bombs are falling
  b2:      { name: 'B-2 Spirit', flyH: 40, drawScale: 1.25,   role: 'combat', builtAt: 'airpad', hp: 300, speed: 125, dmg: 90, atkRange: 44,  cooldown: 1.5,  sight: 300, cost: 360, r: 15, buildTime: 20, flying: true, shape: 'plane', pad: true, maxAmmo: 2, plane: true, turn: 1.5, weapon: 'bomb', splash: 64, bldgBonus: 1.6, stealth: true, req: 'tech', limit: 2 },
  // Deep State signature air: a TR-3B black triangle that hovers dead silent —
  // invisible (stealth) until it opens fire, then it lights up for a moment
  tr3b:    { name: 'TR-3B Black Triangle', flyH: 38, drawScale: 1.2, role: 'combat', builtAt: 'airpad', hp: 250, speed: 118, dmg: 18, atkRange: 165, cooldown: 0.85, sight: 300, cost: 220, r: 12, buildTime: 12, flying: true, targets: 'both', shape: 'plane', stealth: true },
  // the GAU-8 does the talking: wide lazy turns into long saturation runs
  // (weapon 'gunrun') that annihilate vehicles and infantry along the flight
  // path — friend or foe, no IFF. Nearly useless against buildings.
  a10:     { name: 'A-10 Warthog', flyH: 30, drawScale: 1.15, role: 'combat', builtAt: 'airpad', hp: 230, speed: 165, dmg: 22, atkRange: 150, cooldown: 0.6, sight: 300, cost: 200, r: 12, buildTime: 12, flying: true, shape: 'plane', pad: true, maxAmmo: 8, plane: true, turn: 2.4, targets: 'ground', vehBonus: 1.9, bldgBonus: 0.25, splash: 13, weapon: 'gunrun', burstShells: 4, beatenLen: 95, beatenWidth: 28, runOut: 260 },
  // Globalist stealth fighter: lives on the airfield, scrambles at hostile
  // air with eight rails, and can strafe ground targets in a pinch — weakly.
  // Invisible until it opens fire, briefly lit, then gone again.
  // stealth coating dropped (the Deep State kept the classified paint):
  // it flies loud and proud now, pure interceptor
  f35:     { name: 'F-35 Interceptor', flyH: 38, role: 'combat', builtAt: 'airpad', hp: 175, speed: 235, dmg: 24, dmgVsGround: 9, atkRange: 170, cooldown: 0.55, sight: 320, cost: 170, r: 11, buildTime: 10, flying: true, targets: 'both', shape: 'plane', pad: true, maxAmmo: 8, plane: true, turn: 3.2 },
  // the BUFF: a strategic bomber flying off the ordinary Air Force Base. It
  // does not dogfight, orbit or loiter — it lines up a long straight run and
  // walks a STICK of bombs through the target (weapon 'carpet': burstShells
  // bombs spread along beatenLen/beatenWidth of the flight path). Murder on
  // buildings and packed formations, useless against anything nimble, and it
  // has to fly all the way home after two sticks.
  b52: { name: 'B-52 Stratofortress', flyH: 58, drawScale: 1.6, role: 'combat', builtAt: 'airpad', hp: 620, speed: 96, dmg: 46, atkRange: 130, cooldown: 3.2, sight: 320, cost: 520, r: 20, buildTime: 22, flying: true, shape: 'plane', pad: true, maxAmmo: 3, plane: true, turn: 0.8, weapon: 'carpet', splash: 52, bldgBonus: 2.0, burstShells: 10, beatenLen: 260, beatenWidth: 34, stickGap: 0.085, runOut: 240, limit: 2, req: 'tech' },
  biobomber:  { name: 'Bio Bomber',     role: 'combat', builtAt: 'airpad', hp: 200, speed: 90,  dmg: 26, atkRange: 50,  cooldown: 1.6, sight: 260, cost: 200, r: 13, buildTime: 13, flying: true, bldgBonus: 1.5, shape: 'blimp', weapon: 'bomb', splash: 40, groundEffect: { kind: 'toxin', r: 30, dur: 2.5, dps: 6 } },
  // Grey Abductor Saucer: hovers over a ground unit and locks a tractor beam —
  // hold it long enough and the victim is hauled up and away (removed, +minerals).
  // Heavies (hp over abductMax) are too heavy to lift; the beam just drains them.
  abductor:   { name: 'Abductor Saucer', flyH: 30, drawScale: 1.35, role: 'combat', builtAt: 'airpad', hp: 200, speed: 100, dmg: 7, atkRange: 95, cooldown: 0.5, sight: 300, cost: 200, r: 12, buildTime: 13, flying: true, shape: 'saucer', weapon: 'abduct', abductTime: 3, abductMax: 300, abductBounty: 20 },
  // ---------- apex heavies (all tech-gated) ----------
  // Flat: the Combine of Correction — an armor-plated harvester that reaps
  // what it's pointed at. ONE heavy cannon on the cab (no broadside battery),
  // and the header reel crushes infantry under it like wheat.
  combine:  { name: 'Combine of Correction', drawScale: 1.3, role: 'combat', builtAt: 'factory', hp: 700, speed: 42, dmg: 36, atkRange: 195, cooldown: 1.5, sight: 280, cost: 470, r: 20, buildTime: 20, shape: 'square', armor: 0.3, bldgBonus: 1.4, req: 'tech', limit: 2 },
  // Hollow air wing (Cavern Roost). The Ornithopter hits the ground, the Vril
  // Disc owns the sky, the Aerostat holds an umbrella over both — the faction
  // used to field NOTHING that could shoot at an aircraft except a Crystal
  // Slinger on foot, which made a single enemy air wing unanswerable.
  //
  // Tesla Ornithopter: a brass flapping-wing contraption that strafes with
  // crackling vril arcs. Ground only.
  ornithopter: { name: 'Tesla Ornithopter', flyH: 30, drawScale: 1.5, role: 'combat', builtAt: 'airpad', hp: 155, speed: 120, dmg: 14, atkRange: 110, cooldown: 0.6, sight: 270, cost: 160, r: 11, buildTime: 10, flying: true, targets: 'ground', shape: 'tri', vril: true },
  // Vril Disc (Haunebu): the thing they actually recovered down there. A
  // hovering bell-disc that holds altitude on a humming vril field — no
  // airfield slot, no ammo, no rearming, it simply stays up. Their answer to
  // an enemy air wing, and it will strafe the ground on the way past.
  vrildisc: { name: 'Vril Disc', flyH: 34, drawScale: 1.3, role: 'combat', builtAt: 'airpad', hp: 210, speed: 118, dmg: 20, dmgVsGround: 8, atkRange: 165, cooldown: 0.6, sight: 290, cost: 175, r: 12, buildTime: 11, flying: true, targets: 'both', shape: 'saucer', vril: true },
  aerostat: { name: 'Pipe Organ Aerostat', flyH: 36, drawScale: 1.1, role: 'combat', builtAt: 'airpad', hp: 270, speed: 76, dmg: 0, atkRange: 0, cooldown: 1, sight: 290, cost: 230, r: 13, buildTime: 13, flying: true, shape: 'blimp', aaAura: { r: 165, dps: 18 }, aaChord: true, debuffAura: { r: 175, weaken: 0.3 }, vril: true, req: 'tech' },
  // Greys: the capital saucer — no broadside, no bombs. A narrow annihilation
  // lance vaporizes ONE ground target at a time; its bound Tic Tac escort
  // (slow to regrow once shot down) is all that screens the sky above it.
  mothership: { name: 'Mothership', flyH: 44, drawScale: 1.65, role: 'combat', builtAt: 'airpad', hp: 720, speed: 58, dmg: 110, atkRange: 200, cooldown: 3.4, sight: 340, cost: 560, r: 23, buildTime: 24, flying: true, targets: 'ground', shape: 'saucer', lance: true, brood: { type: 'tictac', count: 3, regen: 45 }, req: 'tech', limit: 2 },
  // Draco Royal: the winged apex of the caste — rains fire, and its presence
  // emboldens the whole brood (buffAura). Bought with loosh: the blood-throne's
  // champion. drawScale keeps its bespoke rig imposing.
  draco:    { name: 'Draco Royal', flyH: 34, drawScale: 1.2, role: 'combat', builtAt: 'airpad', hp: 660, speed: 92, dmg: 26, atkRange: 120, cooldown: 0.9, sight: 290, cost: 380, loosh: 90, r: 18, buildTime: 23, flying: true, targets: 'both', shape: 'tri', bldgBonus: 1.5, weapon: 'spray', groundEffect: { kind: 'fire', r: 34, dur: 2.6, dps: 11 }, buffAura: { r: 175 }, req: 'tech', limit: 2 },
  // Resistance: a janky scrap missile truck — cheap-for-its-power siege apex
  cruisetruck: { name: 'Scrap Missile Truck', role: 'combat', builtAt: 'factory', hp: 240, speed: 76, dmg: 70, atkRange: 360, minRange: 130, cooldown: 4.5, sight: 360, cost: 300, r: 13, buildTime: 15, shape: 'square', weapon: 'lob', projectile: 'cruise', splash: 55, bldgBonus: 2, req: 'tech', limit: 2 },
  // faction-power units (never trainable)
  smuggler: { name: 'Smuggler Truck', role: 'scout', hp: 120, speed: 75, dmg: 0, atkRange: 0, cooldown: 1, sight: 180, cost: 0, r: 11, buildTime: 0, shape: 'square' },
  phantom:  { name: 'Unknown Contact', role: 'scout', hp: 20,  speed: 60, dmg: 0, atkRange: 0, cooldown: 1, sight: 40,  cost: 0, r: 9,  buildTime: 0 },
};

// ---------- the Hollow relic economy ----------
// Dig Sites seed across the map at generation (small markers, visible to ALL
// players from the start, never near a starting base). Only Hollow can dig:
// an Excavation Rig parks on a site and opens it over DIG_TIME seconds with a
// progress bar everyone can read; the exposed relic then waits until a Tech
// Priest channels on it and teleports home, banking it.
// Relics grant NO passive boons — they are pure keys. What a banked relic buys
// is permission: the ascension thresholds in ASCEND. No relic, no Guard; no
// four relics, no Dreadnought. The names below are flavor on the marker.
const DIG_TIME = 50;
const RELIC_DEFS = {
  plating:   { name: 'Brazen Plating',       desc: 'a slab of unpitted bronze from the deep foundries' },
  engine:    { name: 'Ancient Engine',       desc: 'still warm, and nobody alive knows what fuels it' },
  capacitor: { name: 'Vril Capacitor',       desc: 'a coil that hums when you look away from it' },
  resonant:  { name: 'Resonant Core',        desc: 'struck once at the founding; the note has not stopped' },
  thirdeye:  { name: 'Third Eye of Agartha', desc: 'a lens ground for an eye that was never human' },
  forges:    { name: 'Deep Forges',          desc: 'the tooling plates of a workshop under the crust' },
  gyros:     { name: 'Gyroscopic Vanes',     desc: 'brass vanes that hold level no matter how you turn them' },
  coffers:   { name: 'Golden Coffers',       desc: 'a sealed strongbox stamped with a forgotten sigil' },
};
// the ascension ladder — the whole Hollow unit system in one table.
// The Servitorium turns out Mole Servitors; the MECHANICUM takes them apart.
// Walk a body in, pay the fee, wait, and something better walks out. Every
// rung consumes the rung below it, so the sticker price of a Lantern Guard is
// really servitor + fee, and a Dreadnought is guard + fee.
// Banked armor (a Tech Priest salvaging a fallen Guard/Dreadnought) halves
// the fee for the next body of that tier.
const ASCEND = {
  // the Priest costs no relic — he is how you GET relics in the first place
  techpriest:   { from: 'moleservitor', at: 'mechanicum', relics: 0, cost: 95,  time: 7 },
  lanternguard: { from: 'moleservitor', at: 'mechanicum', relics: 2, cost: 225, time: 11, tier: 'guard' },
  dreadnought:  { from: 'lanternguard', at: 'mechanicum', relics: 4, cost: 540, time: 20, tier: 'dread', req: 'tech' },
};

// ---------- conversion tiers ----------
// A 3-rung ladder used by any effect that takes a unit off its owner — today
// that is the Deep State's sleeper recruitment. Tier 3 NEVER flips: elite kit
// stays bought (PMCs, Abrams crews, Nephilim, the whole tech-gated shelf).
// Derived from cost/req, with overrides where the sticker price undersells it.
const TIER_OVERRIDE = { pmc: 3, abrams: 3, bradley: 3, himars: 3, apache: 3, f35: 3, a10: 3, b1: 3, tr3b: 3 };
function unitTier(type) {
  const t = UNIT_TYPES[type];
  if (!t) return 3;
  if (TIER_OVERRIDE[type]) return TIER_OVERRIDE[type];
  if (!t.cost) return 3;          // brood/spawned units are bound to their master
  if (t.req || t.loosh) return 3; // tech-gated and blood-bought elites
  if (t.role === 'worker') return 1;
  if (t.cost <= 70) return 1;
  if (t.cost >= 250) return 3;
  return 2;
}

// ---------- buildings ----------
// tower weapon: 'gun' (default) | 'pulse' (AoE) | 'chain' (arcs) | 'beam' (lock + slow)

const BUILDING_TYPES = {
  hq:         { hp: 800, w: 96, h: 96, cost: 0,   buildTime: 0,  sight: 280, power: +60 },
  powerplant: { hp: 320, w: 58, h: 58, cost: 80,  buildTime: 10, sight: 160, power: +100, cap: 6 },
  barracks:   { hp: 450, w: 54, h: 54, cost: 100, buildTime: 12, sight: 200, power: -30,  cap: 3 },
  factory:    { hp: 500, w: 88, h: 68, cost: 150, buildTime: 16, sight: 200, power: -40,  cap: 2 },
  // two airfields is the ceiling for everyone: 8 parked craft is already a
  // serious air force, and a third field turned air factions into a wall of
  // planes nothing on the ground could answer
  airpad:     { hp: 420, w: 96, h: 72, cost: 140, buildTime: 16, sight: 200, power: -40,  cap: 2, padCap: 4 },
  // research site: pricey and power-hungry, unlocks each faction's advanced
  // units (req: 'tech' on the unit); flat-earth family airpads need it too
  tech:       { hp: 480, w: 60, h: 60, cost: 260, buildTime: 20, sight: 220, power: -80, cap: 1 },
  // ground-defense towers
  watchtower: { hp: 300, w: 40, h: 40, cost: 75,  buildTime: 10, sight: 240, power: -30, cap: 5, dmg: 10, atkRange: 175, cooldown: 0.7,  targets: 'ground' },
  // flat-earth fortification: unarmed concrete with firing slits — worthless
  // empty, mean when garrisoned (pooled squad fire, same rules as civilian
  // structures). The militia man their own walls.
  // Unarmed concrete with firing slits — worthless empty, mean when manned, and
  // the militia inside shoot a long way further than they could out of a window
  // (garrisonRange, against the GARRISON_RANGE 200 everything else gets).
  pillbox:    { name: 'Pillbox', hp: 460, w: 42, h: 38, cost: 80, buildTime: 9, sight: 250, power: -10, cap: 6, slots: 3, garrisonRange: 310 },
  tower5g:    { hp: 340, w: 40, h: 40, cost: 100, buildTime: 12, sight: 280, power: -30, cap: 5, dmg: 6,  atkRange: 215, cooldown: 0.9,  targets: 'ground', weapon: 'pulse' },
  stalagmite: { hp: 320, w: 40, h: 40, cost: 80,  buildTime: 10, sight: 240, power: -30, cap: 5, dmg: 11, atkRange: 180, cooldown: 0.7,  targets: 'ground' },
  // Hollow ground defense: the Seismic Imitator slams a resonant piston and a
  // visible shockwave races along the ground into its target (weapon 'quake',
  // small tremor on impact). Its instruments also read every liar in the dirt:
  // this tower is the Hollow detector (stealth, disguise, burrowers).
  seismic:    { name: 'Seismic Imitator', hp: 330, w: 40, h: 40, cost: 95, buildTime: 11, sight: 250, power: -30, cap: 5, dmg: 13, atkRange: 195, cooldown: 1.1, targets: 'ground', weapon: 'quake', ownWeaponArt: true, detector: true, vril: true },
  // ownWeaponArt: the drawing already shows its weapon (crystal, lens, pods,
  // dish) — the engine must not stamp the generic swivel turret over it
  pylon:      { hp: 340, w: 40, h: 40, cost: 105, buildTime: 12, sight: 260, power: -30, cap: 5, dmg: 16, atkRange: 200, cooldown: 0.85, targets: 'ground', weapon: 'chain', ownWeaponArt: true },
  // anti-air towers
  laserpointer: { hp: 280, w: 38, h: 38, cost: 90,  buildTime: 10, sight: 280, power: -30, cap: 5, dmg: 14,  atkRange: 230, cooldown: 0.6,  targets: 'air', ownWeaponArt: true },
  aanest:       { hp: 260, w: 36, h: 36, cost: 70,  buildTime: 8,  sight: 270, power: -20, cap: 5, dmg: 3.5, atkRange: 220, cooldown: 0.14, targets: 'air' }, // rapid tracer stream
  samsite:      { hp: 320, w: 38, h: 38, cost: 110, buildTime: 12, sight: 300, power: -30, cap: 5, dmg: 20,  atkRange: 270, cooldown: 1.6,  targets: 'air', weapon: 'missile', ownWeaponArt: true },
  geyser:       { hp: 300, w: 38, h: 38, cost: 95,  buildTime: 10, sight: 280, power: -30, cap: 5, dmg: 16,  atkRange: 240, cooldown: 0.75, targets: 'air' },
  // continuous lock: it no longer hauls anything out of the sky (the capture
  // was a coin-flip that either did nothing or deleted an expensive aircraft
  // with no counterplay). It just drains hard and holds the target down.
  tractor:      { hp: 320, w: 38, h: 38, cost: 110, buildTime: 12, sight: 300, power: -30, cap: 5, dmg: 6.5, atkRange: 250, cooldown: 0.1,  targets: 'air', weapon: 'beam', ownWeaponArt: true },
  // hollow-earth infrastructure. Tunnel entrances are network nodes (along
  // with the HQ and power plants): ground units enter one and surface at any
  // other after a distance-scaled transit. anywhere: exempt from the
  // build-radius rule — forward entrances near the enemy are the point.
  tunnelentrance: { name: 'Tunnel Entrance', hp: 280, w: 44, h: 44, cost: 60, buildTime: 8, sight: 200, power: -10, cap: 6, anywhere: true },
  geode:          { name: 'Crystal Geode', hp: 340, w: 48, h: 48, cost: 150, buildTime: 14, sight: 170, power: 0, income: 10, cap: 4, req: 'tech' },
  // Deep State economy: it does not mine and it does not print — it takes a
  // bigger cut. Every Front Company skims harder while this stands, and the
  // Reserve pays a small float of its own. Gated behind the Continuity Bunker,
  // so it is the SECOND thing you tech into, after the front companies exist.
  fedreserve:     { name: 'Federal Reserve', hp: 420, w: 58, h: 54, cost: 260, buildTime: 18, sight: 190, power: -40, income: 8, cap: 2, req: 'tech', skimBoost: 0.18 },
  // Globalist premium income: a server farm that prints money off the grid.
  // Power-hungry (fits their infrastructure identity), capped so it's a floor,
  // not a runaway — the late-game answer for a faction with no field income.
  // DIMINISHING: each Data Center after the first pays 25% less than the one
  // before it (16, 12, 9, 6.75 — 43.75 across four instead of a flat 64), so a
  // farm of them stops being the obvious answer to every spare 170 minerals.
  // `needsReq`: they are wired into the Black Site Lab, not merely unlocked by
  // it. Lose the Lab and every Data Center goes dark until you rebuild it —
  // which makes the Lab a target worth defending rather than a tick-box.
  datacenter:     { name: 'Data Center', hp: 380, w: 54, h: 54, cost: 170, buildTime: 15, sight: 180, power: -30, income: 16, cap: 4, req: 'tech', diminish: 0.75, needsReq: true },
  // Refinery: a forward mineral drop-off. Workers deposit here instead of
  // hauling all the way home, so a base can push out to distant fields, and it
  // can be planted off-grid (anywhere).
  //
  // It is deliberately NOT an anchor: a refinery next to a far field buys you a
  // shorter haul, not a free second base — walk a power plant out there if you
  // want to build off it. And it is a `beacon`: everyone sees it, scouted or
  // not. A forward refinery is a claim staked in the open, and the whole map is
  // told where the money is going. Together those make planting one a
  // commitment rather than a freebie.
  refinery:       { name: 'Refinery', hp: 440, w: 58, h: 58, cost: 150, buildTime: 13, sight: 210, power: -10, dropoff: true, anywhere: true, beacon: true, cap: 2, req: 'tech' },
  // fortification kind: walls block ground pathing outright; gates pass the
  // owner's units and block everyone else. wallKind lets segments snap flush
  // against each other (normal structures keep a 32px walkway apart).
  // instant: field structures place immediately for their cost and never tie
  // up the single build queue — lay a whole wall line without stalling your
  // barracks/factory/tech.
  // 7 a segment: walling a base is a real commitment of minerals at ~26px of
  // frontage each, and a diagonal run now packs them tighter still, so the
  // per-segment price has to stay low enough that fortifying is a plan rather
  // than a fortune.
  wall: { name: 'Wall', hp: 380, w: 26, h: 26, cost: 7, buildTime: 0, sight: 80,  power: 0, wallKind: true, instant: true },
  gate: { name: 'Gate', hp: 360, w: 34, h: 34, cost: 24, buildTime: 0, sight: 100, power: 0, wallKind: true, gate: true, instant: true },
  // stealthed proximity trap: trip = trigger radius (enemy ground units);
  // detonation reuses the neutral explodes blast. noBlock: doesn't obstruct
  // pathing or placement — it's buried, things roll right over it.
  mine: { name: 'Landmine', hp: 50, w: 16, h: 16, cost: 25, buildTime: 0, sight: 60, power: 0, stealth: true, noBlock: true, trip: 50, explodes: { r: 70, dmg: 65 }, anywhere: true, instant: true, cap: 10 },
  // service structure: mends the owner's vehicles and aircraft sitting on it
  repairpad: { name: 'Repair Pad', hp: 380, w: 64, h: 64, cost: 120, buildTime: 12, sight: 180, power: -20, cap: 2, repairRate: 8 },
  // globalist orbital surveillance: while a finished one stands, the whole map
  // is revealed (terrain + visible units; cloaked units still need a detector).
  // Pricey, power-hungry, tech-gated, one per player.
  satellite: { name: 'Satellite Uplink', hp: 360, w: 60, h: 60, cost: 320, buildTime: 22, sight: 300, power: -70, cap: 1, req: 'tech', revealMap: true },
  // the Mechanicum: the Hollow tech tree, standing in one building. Servitors
  // walk in and Tech Priests, Lantern Guards and Dreadnoughts walk out (see
  // ASCEND). No tech prereq — this is the SECOND thing a Hollow player builds,
  // because the Priests it makes are the only way to bank a relic. The
  // Dreadnought rite is the one rung that waits on the Reliquary.
  mechanicum: { name: 'Mechanicum', hp: 600, w: 88, h: 76, cost: 170, buildTime: 14, sight: 210, power: -40, cap: 2 },
  // the superweapon slot: same structure everywhere, very different payloads
  // (see SUPER_DEFS); expensive, power-hungry, one per player
  superweapon: { name: 'Superweapon', hp: 550, w: 76, h: 76, cost: 500, buildTime: 25, sight: 220, power: -100, cap: 1, req: 'tech', superweapon: true },
  // ---------- flat-earth compound infrastructure ----------
  // THE HOMESTEAD — the faction's economy, population and life bar in one
  // building. It finishes already worked by HOMESTEAD_SLOTS militia and pays
  // HOMESTEAD_RATE per second for each one still at home, so the income is a
  // live readout of how many people are NOT at the front. Muster the yard and
  // the farm goes quiet until the bodies grow back.
  // Garrisoned militia are the farmhands and the defenders both — the same
  // four rifles either work the land or shoot out of the windows.
  // `beacon`: every player can see it. Deliberate. It is the win condition, and
  // a win condition nobody can find turns every lost game into a search party.
  // A proper farmstead footprint, not a shed: house, barn, silo, yard and
  // worked fields, with room for the hands to actually be seen working it.
  homestead: { name: 'Homestead', hp: 900, w: 150, h: 129, cost: 200, buildTime: 15, sight: 290, power: 0,
               cap: HOMESTEAD_CAP, slots: HOMESTEAD_SLOTS, homestead: true },
  // A buried kit dump. Never built from the menu — a Homestead Marksman plants
  // it (see UNIT_TYPES.homesteader), and only OUTSIDE its owner's build radius.
  // Holds CACHE_KITS conversions, then it is an empty box and folds up.
  // Plainly visible and plainly killable — the tension is that it sits in
  // enemy country, not that it is hidden. A cache nobody can find is a free
  // forward barracks; a cache everyone can see is a decision for both sides.
  preppercache: { name: 'Prepper Cache', hp: 140, w: 26, h: 22, cost: 0, buildTime: 0, sight: 150, power: 0,
                  anywhere: true, cache: true },
  // ================= Broadcast Station =================
  // The proof bank, and a deliberately fragile one. Everything the Journalist
  // risked their neck for is stacked inside this shed, so it is the single most
  // worthwhile thing an enemy can burn on the Flat Earth map — and unlike the
  // Bunker, losing it actually costs you something you cannot get back.
  // Draws power (one of only four things that do), and there can be two: the
  // second is not more capacity, it is REDUNDANCY. Each banks its own footage,
  // a Journalist delivers to whichever is nearer, and a raid only ever takes
  // what the station it burned was holding.
  broadcast: { name: 'Broadcast Station', hp: 420, w: 62, h: 56, cost: 220, buildTime: 18,
               sight: 260, power: -50, cap: 2, proofBank: true },
  // Single use, and it is a building right up until the moment it is not: it
  // sits hidden on the pad, you walk three Homestead Marksmen aboard, and it
  // takes off once and never comes back (see BUSHPLANE).
  bushplane: { name: 'Bush Plane', hp: 300, w: 70, h: 56, cost: 260, buildTime: 18, sight: 200, power: 0,
               cap: 2, req: 'airpad', stealth: true, bushplane: true },
  // the deployed Front Company. Never built from a menu — an unmarked van
  // establishes it (see UNIT_TYPES.frontco). thief.cut is the share taken from
  // every enemy delivery to a drop-off within thief.r.
  frontcompany: { name: 'Front Company', hp: 260, w: 46, h: 42, cost: 0, buildTime: 0, sight: 230, power: 0,
                  stealth: true, anywhere: true, thief: { r: 470, cut: 0.3 } },
  // resistance passive: hidden observation posts (never buildable)
  sleepercell:  { hp: 60,  w: 22, h: 22, cost: 0,   buildTime: 0,  sight: 260, power: 0 },
  // neutral map structures — garrison infantry inside to claim them
  house:     { name: 'Abandoned House', hp: 400, w: 46, h: 42, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 4 },
  apartment: { name: 'Apartment Block', hp: 750, w: 58, h: 66, cost: 0, buildTime: 0, sight: 220, power: 0, slots: 6 },
  barn:      { name: 'Old Barn',        hp: 480, w: 62, h: 52, cost: 0, buildTime: 0, sight: 190, power: 0, slots: 3 },
  silo:      { name: 'Grain Silo',      hp: 440, w: 30, h: 30, cost: 0, buildTime: 0, sight: 175, power: 0, slots: 2 },
  windmill:  { name: 'Windmill',        hp: 380, w: 40, h: 40, cost: 0, buildTime: 0, sight: 215, power: 0, slots: 2 },
  derrick:   { name: 'Oil Derrick',     hp: 500, w: 50, h: 56, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 2, income: 12 },
  // downtown lots (urban maps): the office tower is the garrison prize;
  // gas stations go up when they go down (explodes: blast + lingering fire)
  office:     { name: 'Office Tower',  hp: 950, w: 58, h: 58, cost: 0, buildTime: 0, sight: 230, power: 0, slots: 6 },
  shop:       { name: 'Corner Store',  hp: 380, w: 44, h: 38, cost: 0, buildTime: 0, sight: 190, power: 0, slots: 3 },
  church:     { name: 'Old Church',    hp: 520, w: 46, h: 58, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 4 },
  warehouse:  { name: 'Warehouse',     hp: 700, w: 72, h: 52, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 5 },
  gasstation: { name: 'Gas Station',   hp: 320, w: 54, h: 40, cost: 0, buildTime: 0, sight: 190, power: 0, slots: 2, explodes: { r: 95, dmg: 55, fire: { r: 55, dur: 4, dps: 10 } } },
  // capturable landmarks — garrison infantry to claim, then they serve you:
  // a towering garrison fortress, a hospital that heals nearby units, a bank
  // that prints income, and a radio station that lights up a swathe of the map.
  skyscraper: { name: 'Skyscraper',       hp: 1600, w: 62, h: 62, cost: 0, buildTime: 0, sight: 280, power: 0, slots: 8, tall: true },
  // downtown colossus: fills a whole city block and towers over everything
  megatower:  { name: 'Mega Tower',        hp: 3200, w: 112, h: 100, cost: 0, buildTime: 0, sight: 330, power: 0, slots: 14, tall: true },
  hospital:   { name: 'General Hospital', hp: 1000, w: 74, h: 66, cost: 0, buildTime: 0, sight: 230, power: 0, slots: 6, healAura: { r: 230, rate: 11 } },
  bank:       { name: 'Reserve Bank',  hp: 820,  w: 58, h: 54, cost: 0, buildTime: 0, sight: 210, power: 0, slots: 4, income: 22 },
  radiotower: { name: 'Radio Station',    hp: 440,  w: 40, h: 40, cost: 0, buildTime: 0, sight: 560, power: 0, slots: 2 },
  radar:      { name: 'Radar Station',    hp: 520,  w: 48, h: 48, cost: 0, buildTime: 0, sight: 420, power: 0, slots: 3, detector: true },
  researchlab:{ name: 'Research Lab',     hp: 640,  w: 56, h: 52, cost: 0, buildTime: 0, sight: 220, power: 0, slots: 4, buffAura: { r: 190 } },
  substation: { name: 'Power Substation', hp: 480,  w: 50, h: 46, cost: 0, buildTime: 0, sight: 190, power: 150, slots: 2 },
  mast5g:     { name: '5G Mast',          hp: 360,  w: 36, h: 36, cost: 0, buildTime: 0, sight: 260, power: 0, slots: 2, debuffAura: { r: 210, weaken: 0.4 } },
  tvstation:  { name: 'TV Station',       hp: 560,  w: 56, h: 52, cost: 0, buildTime: 0, sight: 240, power: 0, slots: 4, convert: { every: 40, r: 1000 } },
  monument:   { name: 'Monument',         hp: 760,  w: 48, h: 48, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 3, buffAura: { r: 250 } },
  fueldepot:  { name: 'Fuel Depot',       hp: 420,  w: 60, h: 48, cost: 0, buildTime: 0, sight: 200, power: 0, slots: 3, healAura: { r: 210, rate: 7 }, rearm: true, explodes: { r: 85, dmg: 50, fire: { r: 50, dur: 4, dps: 9 } } },
  // spawns.max is the DETACHMENT SIZE, not a total: the site tops itself back
  // up to this many and then stops, so holding it all game is a standing squad
  // rather than an ever-growing free army
  blacksite:  { name: 'Black Site',       hp: 660,  w: 54, h: 50, cost: 0, buildTime: 0, sight: 230, power: 0, slots: 4, spawns: { type: 'mib', every: 40, max: 4 } },
  // rural/roadside mystery: hold it and salvaged saucers roll off the wreck
  // recovered anti-grav, not a free saucer factory: while held, the owner's
  // aircraft hit 15% harder and slowly knit themselves back together in flight
  ufocrash:   { name: 'UFO Crash Site',   hp: 500,  w: 64, h: 52, cost: 0, buildTime: 0, sight: 250, power: 0, slots: 3, airTech: { dmg: 1.15, heal: 2.5 } },
};

// map settings: how built-up the countryside is. Chosen on the start screen
// (or rolled randomly); mapgen reads these to lay out neutral structures.
const MAP_SETTINGS = {
  metropolis: { name: 'Metropolis' },
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
  flat: { // DUG IN. The compound is slow to raise and hard to shift: sandbags,
          // poured slab and plywood, built by a big workforce that stays put.
    //
    // OFF THE GRID BY DOCTRINE, and now almost completely. Every structure the
    // compound raises carries its own fuel — car batteries, a genset out back,
    // a barrel of diesel and no paperwork. `power: 0` across the board, so
    // there is nothing to black out and nothing to browning-out.
    //
    // The three exceptions are the three things a prepper cannot improvise:
    // TRAINING, MACHINE TOOLS and RESEARCH. The Recruitment Tent, the Truck
    // Garage and the Institute of Truth draw real load, and only a Diesel
    // Generator answers it. One generator covers all three; a second is
    // redundancy, and you will want it, because the generator is a BEACON —
    // every player sees it the moment it finishes, forever, scouted or not.
    // That is the trade: the faction that cannot be browned out advertises the
    // one building that would brown it out.
    hq:         { hp: 1600, power: 0, slots: 5 }, // the Bunker: enormous, and you can man it
    powerplant: { cost: 90,  hp: 300, power: 200, buildTime: 12, w: 52, h: 52, cap: 3, beacon: true },
    // OFF THE GRID. Training militia needs a tent, a sergeant and a field —
    // none of which plug into anything. Only the Garage and the Institute draw.
    barracks:   { cost: 90,  hp: 470, buildTime: 12, w: 50, h: 50, power: 0 },
    factory:    { cost: 145, hp: 540, buildTime: 17 },                // draws (-40)
    airpad:     { cost: 120, hp: 460, buildTime: 17, req: 'tech', power: 0 }, // the sky must be proven fake first
    tech:       { cost: 250, hp: 510 },                               // draws (-80)
    mine:       { cost: 15, explodes: { r: 75, dmg: 70, fire: { r: 40, dur: 2.5, dps: 8 } } }, // cheap IEDs are their thing
    refinery:     { power: 0 },
    pillbox:      { power: 0 },
    laserpointer: { power: 0 },
  },
  resistance: { // NOTHING STAYS PUT. Containers dragged into place and wired up
                // in minutes: the cheapest and by far the FASTEST structures in
                // the game, and the flimsiest. The cell expects to lose them.
    // Still the flimsiest in the game and still the fastest to raise — but the
    // old numbers made a cell's whole estate free damage. The Pirate Radio
    // Bunker in particular folded to a single push, which is a poor fate for a
    // faction whose fiction is that it keeps coming back.
    hq:         { hp: 1000, power: 55 },
    powerplant: { cost: 50,  hp: 230, power: 65,  buildTime: 5,  w: 52, h: 52 },
    barracks:   { cost: 60,  hp: 330, buildTime: 6,  w: 50, h: 50 },
    factory:    { cost: 105, hp: 400, buildTime: 9 },
    airpad:     { cost: 80,  hp: 340, buildTime: 8 }, // the Drone Shop: no proof-of-sky required
    tech:       { cost: 200, hp: 400 },
    // same doctrine, harder: a cell that plugs its guns into the mains is a
    // cell that can be switched off. Scrounged generators only (see the flat
    // note above — both off-grid factions pay for it with a low power cap)
    watchtower: { cost: 65, power: 0 },
    aanest:     { power: 0 },
    mine:       { cost: 15, explodes: { r: 75, dmg: 70, fire: { r: 40, dur: 2.5, dps: 8 } } }, // cheap IEDs are their thing
    superweapon: { cost: 380, hp: 480 }, // cheaper and weaker, on brand
  },
  glob: { // premium infrastructure: pay double, get the best grid and armor
    hq:         { hp: 1100, power: 70 },
    powerplant: { cost: 125, hp: 420, power: 150, buildTime: 13, w: 62, h: 62 },
    barracks:   { cost: 125, hp: 520, buildTime: 13, w: 58, h: 58 },
    factory:    { cost: 175, hp: 560, buildTime: 17 },
    airpad:     { cost: 175, hp: 520, buildTime: 18, w: 132, h: 96 }, // a runway the BUFF actually fits on
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
  reptilian: { // no free income here: the slaves mine, the slaves die, the pit pays
    hq:         { hp: 1050, power: 75 },
    powerplant: { cost: 120, hp: 340, power: 125, buildTime: 12 },
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

// ---------- Bug Out Van variants ----------
// Each kit becomes a REAL unit type, generated from the empty van plus its
// overrides. Loading a body swaps the van for its variant the same way an
// ascension swaps a body (see ASCEND), which means combat, selection, the
// sidebar and the art layer all treat it as an ordinary unit and none of them
// need to know the Bug Out Van exists.
// `cargoCap: 0` on every variant is load-bearing: a kitted van has a welded bay
// and cannot ferry anyone, and the empty van has no weapon — so the van is
// never both armed and carrying, without a rule anywhere enforcing it.
for (const [body, kit] of Object.entries(BUGOUT_KITS)) {
  UNIT_TYPES['van_' + body] = {
    ...UNIT_TYPES.bugoutvan, ...kit,
    vanKit: body, cargoCap: 0, loader: false, cost: 0, buildTime: 0, builtAt: null,
  };
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

// Ground bodies, slimmed. `r` is one number doing three jobs — how far a unit
// shoulders its neighbours apart, how wide a berth it gives a building corner,
// and how big a target it is to crush — and the value that felt right for the
// first was fat for the second: a column threading a built-up base spent its
// time squeezing past corners instead of walking.
//
// Measured, not guessed: 16 rigs marched through an AI base across five seeds.
// 1.0 -> 526 ticks, 0.85 -> 502, 0.8 -> 496, 0.7 -> 493, 0.55 -> 485. The curve
// flattens hard after 0.8 while sprites start visibly overlapping, so 0.8 is
// where this sits. Worth knowing what it does NOT fix: nothing was ever getting
// STUCK in those runs (0 wedged out of 80 at every scale) — this buys smoother,
// slightly faster movement, not a cure for gridlock.
//
// Air is untouched: nothing up there paths around a wall.
const BODY_SCALE = 0.8;
for (const t of Object.values(UNIT_TYPES)) {
  if (!t.flying) t.r = Math.max(4, Math.round(t.r * BODY_SCALE));
}
