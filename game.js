// ============================================================
// game.js — engine: state, orders, combat, AI, input, UI, render.
// Game data (factions/units/buildings) lives in data.js;
// unit/building art and particle effects live in art.js.
// ============================================================

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const mmCanvas = document.getElementById('minimap');
const mmCtx = mmCanvas.getContext('2d');

// ---------- game state ----------

let nextId = 1;
let started = false;
// every seat in the match, human or AI. PLAYER is just owner zero — which seat
// a person is sitting in is localOwner, and which seats are people at all is
// humanOwners; see below.
let OWNERS = [PLAYER, ENEMY];
const state = {
  factions: {},     // owner -> faction key
  minerals: {},     // owner -> bank
  loosh: {},        // owner -> reptilian blood-currency (harvested from death)
  construction: {}, // owner -> {type,t,duration,ready} | null
  units: [],
  buildings: [],
  patches: [],
  projectiles: [], // lobbed rocks, dropped bombs
  zones: [],       // temporary area effects: rain, storm, fire, toxin
  sig: {},         // owner -> {cd, timer, used}
  eco: {},         // owner -> structure-income tick timer
  infiltrator: {}, // owner -> reptilian sleeper worker id
  disproof: {},    // owner -> { key: true } for each thing they have proved fake
  research: {},    // owner -> { key, t, dur } the disproof currently being proved
  digSites: [],    // hollow relic sites: {id,x,y,relic,progress,taken}
  relics: {},      // owner -> [relic keys banked]
  armorBank: {},   // owner -> {guard,dread}: salvaged suits discounting ascension
  armorWrecks: [], // fallen Guard/Dreadnought shells: {id,x,y,tier,owner,until}
  bcast: {},       // owner -> { key: true } permanent broadcasts bought
  bcastT: {},      // owner -> { key: untilTime } timed broadcasts running
  reveals: [],     // Leaked Footage windows: {owner,x,y,r,until}
  charges: [],     // live demolition charges: {id,bld,owner,at,x,y}
  floats: [],      // short-lived world-space numbers ("+6" over a skim)
  leverage: {},    // owner -> total skimmed by Front Companies (the ledger)
  books: {},       // owner -> {on, until}: whose estate is currently laid open to them
  hqGrace: {},     // owner -> {until,at} while an HQ-less faction may still rebuild
  hqRebuilt: {},   // owner -> has already used its one rebuild
  seed: 0,         // match seed: the single input to the sim RNG stream
  tick: 0,         // completed sim ticks. state.time is derived from this.
  time: 0,         // = tick * TICK. Never accumulated, so it cannot drift.
  alpha: 0,        // render-only: fraction of a tick since the last stepSim
  over: false,
};

const cam = { x: 0, y: 0, zoom: 1 };
const keys = {};
const mouse = { x: 0, y: 0, sel: null };
let selection = [];
let pings = [];              // minimap ping ripples: view-only, never hashed
// "has the announcer already said this?" flags. Every one of these used to
// live on a sim object — state.skimSeen, state.construction[o].announced,
// b.announcedReady — which meant a hashed field was being written according to
// who happened to be watching. They are view state and they live out here now.
let skimHintSeen = false;
let announcedBuild = {};        // owner -> the construction job already announced
let announcedSuper = new Set(); // building ids whose "ready" line has played
let placing = null;          // building type being placed
let attackMoveArmed = false; // 'E' pressed, next left-click is attack-move
let abilityTargeting = null; // 'zone' | 'unit' while a faction power waits for a click
let wallDrag = null;         // { x0, y0 } while dragging out a wall stretch (RA2-style)
let plantArmed = false;      // 'E' pressed, next left-click sends infantry to plant an IED
const WALL_STEP = 26;        // world spacing between segments of a dragged wall line
const STRUCT_GAP = 8;        // min world gap between structure footprints (RA2-tight).
                             // Units route AROUND clusters this seals rather than
                             // squeezing between — the path grid + A* handle it.
let superTargeting = null;   // building id of a charged superweapon awaiting its target
let leverageTargeting = null; // LEVERAGE_PLAYS key awaiting a target structure
let cacheTargeting = null;   // Marksman ids awaiting a ground click to bury a cache
let dropTargeting = null;    // Bush Plane building id awaiting its drop zone
let demoTargeting = null;    // Ex-Special Forces ids awaiting an enemy structure
let bcastTargeting = null;   // BROADCASTS key awaiting a spot on the map
let panDrag = null;          // middle- or right-mouse camera drag
let mmDown = false;          // dragging on minimap
let lastClick = { t: -1e9, x: 0, y: 0 }; // for double-click select-all-of-type
let lastPanelSig = null;     // action buttons rebuild only when this changes
const groups = {};           // control groups 1-5
let lastUnderAttack = -1e9;

const ais = {}; // owner -> {attackWaveSize, thinkTimer, time}; one brain per AI
const cameoButtons = {}; // sidebar buttons: key -> {btn, costEl, prog, badge, baseCost, baseLabel}

// small shared helpers
const facOf = owner => FACTIONS[state.factions[owner]];
// ---------- loosh: the Reptilian blood-economy ----------
// A second currency harvested purely from death — your own brood dying and the
// enemy infantry you slay both feed it. Pays for the elite caste tier and fuels
// the Bloodline Throne. Only Reptilian players ever bank it.
const isReptilian = owner => state.factions[owner] === 'reptilian';
function grantLoosh(owner, n) { if (isReptilian(owner)) state.loosh[owner] = (state.loosh[owner] || 0) + n; }
// ---------- LEVERAGE: who actually runs the ledger ----------
// Only a faction that can put a skimming front company on the board earns
// leverage, so only that faction should be offered the plays that spend it.
// Asked of the ROSTER rather than the faction key, so a future balance change
// that hands front companies to somebody else carries the panel along with it.
const _leverageFactions = {};
function usesLeverage(owner) {
  const key = state.factions[owner];
  const f = FACTIONS[key];
  if (!f) return false;
  if (_leverageFactions[key] === undefined) {
    _leverageFactions[key] = [f.worker, f.infantry, f.aa, f.vehicle, f.air, ...(f.extras || []), ...(f.advanced || [])]
      .some(u => u && UNIT_TYPES[u] && UNIT_TYPES[u].establishes);
  }
  return _leverageFactions[key];
}
// ---------- DISPROOF: what this owner has proved fake ----------
// Every effect below is checked at the POINT OF INTERACTION rather than being
// pushed onto units, so a disproof applies retroactively to everything the
// enemy already owns the instant it completes.
const isFlat = owner => state.factions[owner] === 'flat';
const disproved = (owner, key) => !!(state.disproof[owner] && state.disproof[owner][key]);
// the Ham Radio Shack finally earns its slot: each one shortens the wait
function researchSpeed(owner) {
  let mul = 1;
  for (const b of state.buildings) {
    if (b.owner !== owner || b.hp <= 0 || !b.done) continue;
    mul += bstatsOf(b).research || 0;
  }
  return mul;
}
function startResearch(owner, key) {
  if (state.research[owner] || disproved(owner, key)) return false;
  const D = DISPROOFS[key];
  if (!D || state.minerals[owner] < D.cost) return false;
  state.minerals[owner] -= D.cost;
  state.research[owner] = { key, t: 0, dur: D.time };
  if (owner === localOwner) { sfx('click'); eva('The research begins'); }
  return true;
}
function tickResearch(owner, dt) {
  const r = state.research[owner];
  if (!r) return;
  r.t += dt * researchSpeed(owner);
  if (r.t < r.dur) return;
  state.research[owner] = null;
  (state.disproof[owner] = state.disproof[owner] || {})[r.key] = true;
  if (owner === localOwner) { sfx('boom'); eva(DISPROOFS[r.key].name + ' — proven'); }
}
// "The Sky Is Closed": enemy aircraft loitering over a denier's base grind
// against a firmament that, as far as its owner is concerned, was always there
function updateClosedSky(dt) {
  for (const o of OWNERS) {
    if (!disproved(o, 'sky')) continue;
    state.skyT = state.skyT || {};
    state.skyT[o] = (state.skyT[o] || 0) - dt;
    if (state.skyT[o] > 0) continue;
    state.skyT[o] = 0.25;
    const mine = state.buildings.filter(b => b.owner === o && b.hp > 0);
    if (!mine.length) continue;
    for (const u of state.units) {
      if (u.owner === o || u.owner === NEUTRAL || u.hp <= 0) continue;
      if (!UNIT_TYPES[u.type].flying) continue;
      if (!mine.some(b => dist(b, u) <= DISPROOF_SKY_R)) continue;
      dealDamage(null, u, 9 * 0.25, {});
      u.slowUntil = state.time + 0.4;
      if (fxRandom() < 0.25) Particles.pulse(u.x, u.y - (u.alt || 0), 10, [169, 195, 204]);
    }
  }
}

// is this entity standing inside a forest blob? (Deer Stand's whole career)
function inForest(e) {
  for (const o of terrainNear(e.x, e.y)) {
    if (o.type === 'forest' && dist(o, e) <= o.r) return true;
  }
  return false;
}
// ---------- the Hollow relic economy ----------
// Dig Sites are neutral, indestructible, and VISIBLE TO EVERYONE from the
// first frame (markers + minimap): the whole map knows where the relics are,
// and the dig progress bar is public — that's the tension. Only Hollow rigs
// can dig; only Tech Priests can carry a relic home.
const isHollow = owner => state.factions[owner] === 'hollow';
const relicCount = owner => (state.relics[owner] || []).length;
function seedDigSites() {
  state.digSites = [];
  const hqs = state.buildings.filter(b => b.type === 'hq');
  // Fisher-Yates, not sort-by-random-comparator: a random comparator gives an
  // engine-dependent permutation (V8, SpiderMonkey and JSC all disagree), which
  // is exactly the kind of thing that desyncs a lockstep match.
  const keys = simShuffle(Object.keys(RELIC_DEFS));
  const want = Math.min(keys.length, OWNERS.length <= 2 ? 6 : 8);
  let tries = 0;
  while (state.digSites.length < want && tries++ < 4000) {
    const x = 140 + simRandom() * (WORLD_W - 280), y = 140 + simRandom() * (WORLD_H - 280);
    if (hqs.some(h => Math.hypot(h.x - x, h.y - y) < 430)) continue;   // never in a starting camp
    if (state.digSites.some(s => Math.hypot(s.x - x, s.y - y) < 280)) continue;
    if (state.patches.some(p => Math.hypot(p.x - x, p.y - y) < 90)) continue;
    // NEVER inside a structure. Dig sites seed after the map is laid out, so
    // on built-up settings (Metropolis especially) the countryside is full of
    // civilian blocks and a site would otherwise land inside an office tower —
    // visible, unreachable, and undiggable. Clear the footprint plus room for
    // an Excavation Rig to park alongside it.
    if (state.buildings.some(b => Math.abs(b.x - x) < b.w / 2 + 40 && Math.abs(b.y - y) < b.h / 2 + 40)) continue;
    let blocked = false;
    for (const o of terrainNear(x, y)) {
      if (!TERRAIN_TYPES[o.type].passes && Math.hypot(x - o.x, y - o.y) < o.r + 34) { blocked = true; break; }
    }
    if (blocked) continue;
    state.digSites.push({ id: nextId++, x, y, relic: keys[state.digSites.length], progress: 0, taken: false });
  }
}
function bankRelic(owner, key) {
  (state.relics[owner] = state.relics[owner] || []).push(key);
  if (owner === localOwner) eva('Relic recovered: ' + RELIC_DEFS[key].name);
}
// ascension fee, halved when a salvaged suit of that tier waits in the bank
// (the Priest rite has no tier — there is no armor to inherit)
function ascendFee(owner, key) {
  const A = ASCEND[key];
  const bank = A.tier && state.armorBank[owner] && state.armorBank[owner][A.tier];
  return bank > 0 ? Math.round(A.cost / 2) : A.cost;
}
// is this ascension available to `owner` right now, relics and tech aside from
// the fee? Used by the Mechanicum panel, the right-click order and the AI.
function ascendReady(owner, key) {
  const A = ASCEND[key];
  // apexes cap at 2 across the board, and the Dreadnought reaches the field by
  // rite rather than by purchase — so its ceiling has to be enforced HERE
  // (trainUnit never sees it) or the Mechanicum would out-produce every other
  // faction's heavy simply by not going through a factory.
  const cap = UNIT_TYPES[key] && UNIT_TYPES[key].limit;
  if (cap) {
    const have = state.units.reduce((n, u) => n + (u.owner === owner && u.hp > 0 &&
      (u.type === key || (u.ascension && u.ascension.to === key)) ? 1 : 0), 0);
    if (have >= cap) return false;
  }
  return relicCount(owner) >= A.relics && (!A.req || hasStruct(owner, A.req));
}
const buildingName = b => (facOf(b.owner) && facOf(b.owner).buildingNames[b.type])
  || BUILDING_TYPES[b.type].name || b.type;
// building stats vary per faction (a Diesel Shack is not a Fusion Plant);
// neutral structures fall back to the base table
const bstats = (owner, type) => (FBUILD[state.factions[owner]] || BUILDING_TYPES)[type];
const bstatsOf = b => bstats(b.owner, b.type);
const canGarrison = u => {
  const t = UNIT_TYPES[u.type];
  return t.builtAt === 'barracks' && t.role === 'combat' && !t.flying;
};
// Which structures actually emit units, and so have somewhere to send them.
// Derived from the unit table rather than listed by hand, so a new production
// building inherits its rally point for free — and a wall, a power plant or a
// tech lab never offers one, having nothing to rally.
const PRODUCER_TYPES = new Set(Object.values(UNIT_TYPES).map(u => u.builtAt).filter(Boolean));
const producesUnits = b => !!b && b.kind === 'building' && PRODUCER_TYPES.has(b.type);

const hostilesOf = owner => OWNERS.filter(o => o !== owner); // free-for-all
const randomHostile = owner => {
  const hs = hostilesOf(owner);
  return hs[Math.floor(simRandom() * hs.length)];
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hitsAir = stats => stats.targets === 'air' || stats.targets === 'both';
// LOW AIR: things that hover down where a rifle can reach them — balloons,
// helicopters, drones, gargoyles, saucers. Fixed-wing craft (plane) come
// through too fast and the high-altitude fliers are simply out of reach.
// Weapons flagged `lowAir` (the Guard's bolter, the Dreadnought's autocannon)
// can engage this set without being true anti-air.
const isLowAir = stats => stats.flying && !stats.plane && (stats.flyH || 28) <= 36;

// tank tracks vs footsoldiers: who rolls over whom. Heavy ground hulls crush
// un-armored foot troops; armored riot gear, giants and vehicles are safe.
const isCrusher = stats => !stats.flying && stats.r >= 12;
const isCrushable = stats => !stats.flying && stats.r <= 10 && (stats.armor || 0) < 0.25 &&
  (!stats.builtAt || stats.builtAt === 'barracks');

// ---------- audio state (functions below) ----------

let muted = false;
let audioCtx = null;
const evaLast = {};
let sfxCount = 0, sfxWindow = 0;

// ---------- fog of war state (sized by initFog once the map exists) ----------

let FW = 0, FH = 0;
// ONE GRID PER OWNER. 0 unexplored, 1 explored, 2 currently visible.
// This used to be a single array built for owner zero, which was fine while
// there was only ever one human at the screen — but the simulation reads fog
// (a scout picks its next destination from it), so on two clients that have
// explored different ground the same scout walks two different ways and the
// match comes apart. Whose fog it is now has to be stated at every call.
let visAll = [];             // owner -> Uint8Array(FW * FH)
// Which side is at this keyboard. Only the VIEW may depend on it: rendering,
// the panel, the announcer, sound. If a value derived from localOwner ever
// reaches sim state, Desync.viewpointTest() will catch it.
let localOwner = PLAYER;
// Which seats are driven by a person rather than by updateAI(). This is SIM
// state: every client must agree on it, or one machine runs an AI brain the
// others do not. It is NOT the same question as localOwner — in a two-human
// match both clients have the same humanOwners and different localOwners.
const humanOwners = new Set([PLAYER]);
const isHuman = o => humanOwners.has(o);
let fogImg = null;           // ImageData reused every frame (fillRect per tile is too slow on big maps)
const fogCanvas = document.createElement('canvas');
const fogCtx = fogCanvas.getContext('2d');

// ---------- remembered structures ----------
// Explored ground is not a live feed. Fog state 1 means "I have been here",
// and until this existed the renderer took that as licence to draw the CURRENT
// building list over it — so you watched an enemy base go up brick by brick
// through fog you had walked past once an hour ago, and watched buildings you
// had never seen destroyed quietly disappear.
//
// What a side actually knows about ground it is not watching is what it saw
// last time. memGhosts[owner] holds that: a frozen copy of each building, taken
// on the tick its owner lost sight of it, and kept until they look again.
//
// This is VIEW state, deliberately. It lives outside `state` so hashState()
// never sees it, and nothing in the simulation reads it — the AI's knowledge of
// the map is unchanged. It is per-owner all the same, so the local screen is a
// lookup into it rather than the thing that builds it.
let memGhosts = [];          // owner -> Map(buildingId -> frozen copy)
let memObs = [];             // owner -> Set(buildingId) observed on the last tick

function initFog() {
  FW = Math.round(WORLD_W / FOG_TILE);
  FH = Math.round(WORLD_H / FOG_TILE);
  visAll = [];
  memGhosts = [];
  memObs = [];
  for (const o of OWNERS) {
    visAll[o] = new Uint8Array(FW * FH);
    memGhosts[o] = new Map();
    memObs[o] = new Set();
  }
  fogCanvas.width = FW;
  fogCanvas.height = FH;
  fogImg = fogCtx.createImageData(FW, FH);
}
// the local player's grid, for the renderer
function localVis() { return visAll[localOwner] || new Uint8Array(FW * FH); }
// ...and the local player's remembered structures. Same guard as localVis: the
// minimap can paint a frame before initFog() has run.
const NO_GHOSTS = new Map();
function localGhosts() { return memGhosts[localOwner] || NO_GHOSTS; }


function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* no audio */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

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
    for (let i = 0; i < d.length; i++) d[i] = (fxRandom() * 2 - 1) * (1 - i / d.length);
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

function nearest(from, list, filter) {
  let best = null, bd = Infinity;
  for (const e of list) {
    if (filter && !filter(e)) continue;
    const d = dist(from, e);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// support units (healers, aura buffers) quietly decide fights, so target
// acquisition treats them as ~170px closer than they are: guns swing onto
// the medic over the nearer rifleman when both are in reach
function supportBias(e) {
  if (e.kind !== 'unit') return 0;
  const t = UNIT_TYPES[e.type];
  return (t.repair || t.mendAura || t.buffAura || t.hardenAura || t.debuffAura) ? 170 : 0;
}

function nearestTarget(from, list, filter) {
  let best = null, bd = Infinity;
  for (const e of list) {
    if (filter && !filter(e)) continue;
    const d = dist(from, e) - supportBias(e);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// per-frame memo (state.time only advances once per frame): enemiesOf and
// powerOf are called per unit / per building per frame, and rebuilding those
// arrays thousands of times a second was churning enough garbage to cause
// visible GC hitches on big late-game maps
let enemyMemo = { t: -1 };
function enemiesOf(owner) {
  if (enemyMemo.t !== state.time) enemyMemo = { t: state.time };
  return enemyMemo[owner] || (enemyMemo[owner] =
    state.units.filter(u => u.owner !== owner && u.hp > 0 && !u.garrisoned)
      .concat(state.buildings.filter(b => b.owner !== owner && b.owner !== NEUTRAL && b.hp > 0)));
}

function entityRadius(e) {
  return e.w ? Math.max(e.w, e.h) / 2 : UNIT_TYPES[e.type].r;
}

// ---------- stealth & detection ----------
// A stealthed unit (mine, cloaked infiltrator) or burrowed unit is invisible
// and untargetable to an enemy owner unless one of that owner's `detector`
// units has it inside its sight radius. Attacking breaks stealth briefly
// (exposedUntil); burrow is only ever broken by detectors.

let detMemo = { t: -1 };
function detectorsOf(owner) {
  if (detMemo.t !== state.time) detMemo = { t: state.time };
  return detMemo[owner] || (detMemo[owner] = [
    ...state.units.filter(u => u.owner === owner && u.hp > 0 && !u.garrisoned && UNIT_TYPES[u.type].detector),
    ...state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.done &&
      bstatsOf(b).detector), // Radar Station and friends
  ]);
}

// ---------- SUSPICION: how noticeable this thing is being right now ----------
// stealthSkill is what it is capable of at rest; the multiplier is what it is
// actually doing. Speed matters continuously rather than as a sprint flag — a
// bomber crossing the map is loud, a man walking is not — so nothing new has to
// be tracked to know how hard something is trying not to be seen.
function stealthSkillOf(e) {
  const s = STEALTH_SKILL[e.type];
  return s === undefined ? STEALTH_SKILL_DEFAULT : s;
}
// where this thing's meter is HEADED, 0-100, given what it is doing now
function suspicionTargetOf(e) {
  const skill = stealthSkillOf(e);
  let mul;
  if (e.kind === 'building') mul = SUSP_STILL;            // a building always holds still
  else {
    const stats = UNIT_TYPES[e.type];
    // `=== undefined`, not `||`: movedT is a timestamp and 0 is a real one. A
    // truthiness test here reads "moved on tick zero" as "has never moved", so
    // everything on the field counted as holding still at match start.
    const movedT = e.movedT === undefined ? -999 : e.movedT;
    if (state.time - movedT >= SUSP_STILL_AFTER) mul = SUSP_STILL;
    // hold-still cloakers are built around stopping and are worse than their
    // skill suggests the moment they do not
    else if (stats.cloakStill) mul = SUSP_CLOAKSTILL_MOVE;
    else {
      const fast = clamp(((stats.speed || 60) - 60) / 120, 0, 1);
      mul = SUSP_MOVING + (SUSP_SPRINT - SUSP_MOVING) * fast;
    }
  }
  // filming is added ON TOP of the behaviour multiplier, not folded into it:
  // a doorstepping Journalist is standing perfectly still and still lighting up
  return clamp(skill * mul * SUSPICION_MAX + filmSuspicion(e), 0, SUSPICION_MAX);
}
// where it actually IS. Buildings never move, so their meter sits on target and
// needs no inertia; units carry a live one that updateSuspicion walks.
function suspicionOf(e) {
  if (e.kind === 'building') return suspicionTargetOf(e) / SUSPICION_MAX;
  return (e.suspicion === undefined ? suspicionTargetOf(e) : e.suspicion) / SUSPICION_MAX;
}
// one step of the meter — called per unit per tick
function updateSuspicion(u, dt) {
  const stats = UNIT_TYPES[u.type];
  if (!(u.disguised || u.burrowed || stats.stealth || stats.cloakStill)) return;
  if (u.suspicion === undefined) u.suspicion = suspicionTargetOf(u);
  // a shot pins the meter at maximum: you cannot cool down while still lit
  if (u.exposedUntil > state.time) { u.suspicion = SUSPICION_MAX; return; }
  const want = suspicionTargetOf(u);
  const rate = want > u.suspicion ? SUSPICION_RISE : SUSPICION_FALL;
  const step = rate * dt;
  u.suspicion = Math.abs(want - u.suspicion) <= step ? want
    : u.suspicion + Math.sign(want - u.suspicion) * step;
}

// ---------- SCRUTINY: how hard `owner` is looking at this patch of ground ----
// Every pair of eyes that can see the spot counts, so a dense base is a hard
// place to sneak through and open country is not. Memoised per fog tile per
// tick: the answer is asked once per stealthed thing per tick at most, and the
// grid is coarse enough that near-identical positions share a result.
let scrutMemo = { t: -1, m: new Map() };
function scrutinyAt(owner, x, y) {
  if (scrutMemo.t !== state.time) scrutMemo = { t: state.time, m: new Map() };
  const key = owner + ':' + tileIndex(x, y);
  const hit = scrutMemo.m.get(key);
  if (hit !== undefined) return hit;
  const pt = { x, y };
  let s = 0;
  for (const u of state.units) {
    if (u.owner !== owner || u.hp <= 0 || u.garrisoned) continue;
    const ut = UNIT_TYPES[u.type];
    if (dist(u, pt) > ut.sight) continue;
    s += ut.detector ? SCRUTINY_DETECTOR : SCRUTINY_UNIT;
  }
  for (const b of state.buildings) {
    if (b.owner !== owner || b.hp <= 0 || !b.done) continue;
    const bt = bstatsOf(b);
    if (dist(b, pt) > bt.sight) continue;
    s += bt.detector ? SCRUTINY_DETECTOR : SCRUTINY_BLDG;
  }
  // "Stealth Is a Psyop" no longer opts you out of the system — it just means
  // everything you own is looking twice as hard, everywhere, forever.
  if (disproved(owner, 'stealth')) s *= SCRUTINY_DISPROVED;
  // Dead Air: somebody hostile to this observer is jamming them blind
  if (bcastAgainst(owner, 'deadair')) s *= BROADCASTS.deadair.mul;
  scrutMemo.m.set(key, s);
  return s;
}

// the contest itself
function isRevealed(e, owner) {
  return suspicionOf(e) * scrutinyAt(owner, e.x, e.y) >= SUSPICION_CAUGHT;
}
// RENDER-ONLY: the hardest anyone hostile is looking at this spot. Used to draw
// the suspicion pip's threshold mark, so the bar answers "am I about to be seen
// HERE" rather than a number with no reference point.
function worstScrutinyAt(owner, x, y) {
  let worst = 0;
  for (const o of OWNERS) {
    if (o === owner) continue;
    const s = scrutinyAt(o, x, y);
    if (s > worst) worst = s;
  }
  return worst;
}

// is entity e hidden from `owner` right now? (covers the reptilian disguise,
// stealth flags, and the burrow stance) — the universal targeting filter.
// The skin-suit disguise is cloak-CLASS, not absolute: a detector sees the
// lizard under the suit, so defenses with detector support fight back.
function hiddenFrom(e, owner) {
  if (e.owner === owner) return false;
  if (e.trackedBy && e.trackedBy[owner]) return false; // an implanted tracker pierces everything
  if (e.kind === 'unit' && e.transit) return true;     // underground in a tunnel: gone entirely
  const stats = e.kind === 'building' ? bstatsOf(e) : UNIT_TYPES[e.type];
  // Only these ever get to be unseen. Everything else in the game is visible
  // if it is in your vision, which is what keeps this a system about
  // infiltrators rather than about every unit on the field.
  if (!(e.disguised || e.burrowed || stats.stealth || stats.cloakStill)) return false;
  // FIRING HARD-REVEALS, and it outranks everything above. A muzzle flash is a
  // location broadcast: no skill hides it, no stillness discounts it, and it
  // holds long enough that what you shot at can shoot back.
  if (e.exposedUntil > state.time) return false;
  return !isRevealed(e, owner);
}

function canTarget(stats, target) {
  if (!stats.dmg && !stats.kamikaze) return false; // kamikaze munitions have no gun
  const isAir = target.kind === 'unit' && UNIT_TYPES[target.type].flying;
  const t = stats.targets || 'ground';
  if (!isAir) return t === 'ground' || t === 'both';
  // a lowAir weapon is not anti-air: it can only reach what loiters down at its
  // own altitude — rotorcraft, drones, balloons, saucers — never a fast jet or
  // the high-altitude fleet (see isLowAir)
  return t === 'air' || t === 'both' || (!!stats.lowAir && isLowAir(UNIT_TYPES[target.type]));
}

// What a browned-out owner runs at. Everyone limps along at half; the Flat
// Earthers CRAWL at a quarter, because almost nothing of theirs is on the grid
// in the first place — if the Diesel Generator is gone, the three buildings
// that did need it are the three you cared about, and losing them should hurt.
function brownoutRate(owner) {
  return state.factions[owner] === 'flat' ? FLAT_BROWNOUT : 0.5;
}

let powerMemo = { t: -1 };
function powerOf(owner) {
  if (powerMemo.t !== state.time) powerMemo = { t: state.time };
  if (powerMemo[owner]) return powerMemo[owner];
  let cap = 0, used = 0;
  for (const b of state.buildings) {
    if (b.owner !== owner || b.hp <= 0 || !b.done) continue;
    if (b.empUntil > state.time) continue; // blacked-out structures are off the grid entirely
    const p = bstatsOf(b).power || 0;
    if (p > 0) cap += p; else used -= p;
  }
  return (powerMemo[owner] = { cap, used, low: used > cap });
}

// does the owner have a finished building of this type? (tech prereqs)
function hasStruct(owner, type) {
  return state.buildings.some(b => b.owner === owner && b.hp > 0 && b.done && b.type === type);
}

// Fog lookups come in two flavours. The For(owner, ...) ones answer the real
// question — what does THIS side know? — and are the only ones the simulation
// is allowed to ask. The bare ones answer for whoever is at the keyboard, and
// belong to rendering, the panel and sound.
function tileIndex(x, y) {
  const tx = clamp(Math.floor(x / FOG_TILE), 0, FW - 1);
  const ty = clamp(Math.floor(y / FOG_TILE), 0, FH - 1);
  return ty * FW + tx;
}
function tileStateFor(owner, x, y) {
  const v = visAll[owner];
  return v ? v[tileIndex(x, y)] : 0;
}
function tileState(x, y) { return tileStateFor(localOwner, x, y); }

// nearest never-seen (state 0) tile center to a world point, from ONE side's
// point of view — used by the scout Explore order. Returns null when that side
// has revealed the whole map. The owner argument is load-bearing: this decides
// where a scout walks, and reading the local player's fog here made the same
// scout walk somewhere different on every client.
function nearestUnexplored(owner, wx, wy) {
  const v = visAll[owner];
  if (!v) return null;
  let best = null, bestD = Infinity;
  for (let ty = 0; ty < FH; ty++) {
    for (let tx = 0; tx < FW; tx++) {
      if (v[ty * FW + tx] !== 0) continue;
      const cx = tx * FOG_TILE + FOG_TILE / 2, cy = ty * FOG_TILE + FOG_TILE / 2;
      const d = (cx - wx) ** 2 + (cy - wy) ** 2;
      if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
    }
  }
  return best;
}

function markSight(owner, x, y, sight) {
  const v = visAll[owner];
  if (!v) return; // neutral, or the no-IFF pseudo-owners: nobody is looking
  const tx0 = Math.max(0, Math.floor((x - sight) / FOG_TILE));
  const tx1 = Math.min(FW - 1, Math.floor((x + sight) / FOG_TILE));
  const ty0 = Math.max(0, Math.floor((y - sight) / FOG_TILE));
  const ty1 = Math.min(FH - 1, Math.floor((y + sight) / FOG_TILE));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const cx = tx * FOG_TILE + FOG_TILE / 2, cy = ty * FOG_TILE + FOG_TILE / 2;
      if ((cx - x) ** 2 + (cy - y) ** 2 <= sight * sight) v[ty * FW + tx] = 2;
    }
  }
}

// Every side's fog, every tick. One pass over the world marks each sighting
// into whichever owner's grid it belongs to, so this costs barely more than
// the single-player version did — the per-owner part is only the decay sweep.
// Public-by-design structures. Refineries advertise themselves the moment they
// finish — everyone watches the money move.
// HOMESTEADS ARE CONDITIONAL. They used to be flat beacons, which handed every
// opponent the Flat Earth economy on the minimap from minute one for free. Now
// they stay hidden like anything else while the Bunker stands, and only light
// up once it falls — at which point they ARE the win condition, and finding six
// farms scattered across a 900 build radius should not be a search party.
function isBeacon(b) {
  const bt = bstatsOf(b);
  if (bt.beacon) return true;
  return !!bt.homestead && !hasHq(b.owner);
}

function updateFog() {
  for (const o of OWNERS) {
    const v = visAll[o];
    for (let i = 0; i < v.length; i++) if (v[i] === 2) v[i] = 1;
  }
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    if (!u.garrisoned) markSight(u.owner, u.x, u.y, UNIT_TYPES[u.type].sight);
    // probe-drone trackers: lasting vision of the tagged unit, wherever it goes
    if (u.trackedBy) for (const o of OWNERS) if (o !== u.owner && u.trackedBy[o]) markSight(o, u.x, u.y, 140);
    // ASSETS: you see whatever your sleepers see, from inside their army
    if (u.sleeperFor !== undefined && u.sleeperFor !== null && !u.garrisoned) {
      markSight(u.sleeperFor, u.x, u.y, UNIT_TYPES[u.type].sight);
    }
  }
  for (const b of state.buildings) {
    if (b.hp > 0) markSight(b.owner, b.x, b.y, bstatsOf(b).sight);
  }
  // Open the Books: their whole estate laid bare, building by building
  for (const o of OWNERS) {
    const bk = state.books[o];
    if (!bk || state.time >= bk.until) continue;
    for (const b of state.buildings) {
      if (b.owner === bk.on && b.hp > 0) markSight(o, b.x, b.y, Math.max(bstatsOf(b).sight, 260));
    }
  }
  // Orbital uplink (Globalist Satellite): imagery, not a live feed. It lifts
  // the black off the whole map and keeps every structure on it plotted — but
  // it does NOT show you their army. Overhead photography finds buildings;
  // finding units still takes eyes on the ground.
  //
  // That distinction is free, because it is already the difference between the
  // two fog states: visibleTo() needs 1 (explored) for a building and 2
  // (currently seen) for a unit. So the uplink raises 0 to 1 and stops there —
  // and never pulls a tile DOWN from 2, which would blind your own scouts.
  for (const b of state.buildings) {
    if (!(b.hp > 0 && b.done && bstatsOf(b).revealMap)) continue;
    const v = visAll[b.owner];
    if (!v) continue;
    for (let i = 0; i < v.length; i++) if (v[i] === 0) v[i] = 1;
  }
  // Beacons (the Refinery) are public: every side gets the ground under one
  // opened to `explored`, so the structure draws instead of sitting under
  // unscouted black. Same rule as the uplink above — 0 is raised to 1 and
  // nothing is ever pulled DOWN from 2, so this cannot blind anyone's scouts.
  // It lights the footprint and no more: you are told a refinery is there, not
  // what is guarding it.
  for (const b of state.buildings) {
    if (!(b.hp > 0 && b.done && isBeacon(b))) continue;
    const r = Math.max(b.w, b.h) / 2 + FOG_TILE;
    const tx0 = Math.max(0, Math.floor((b.x - r) / FOG_TILE));
    const tx1 = Math.min(FW - 1, Math.floor((b.x + r) / FOG_TILE));
    const ty0 = Math.max(0, Math.floor((b.y - r) / FOG_TILE));
    const ty1 = Math.min(FH - 1, Math.floor((b.y + r) / FOG_TILE));
    for (const o of OWNERS) {
      const v = visAll[o];
      if (!v) continue;
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const i = ty * FW + tx;
          if (v[i] === 0) v[i] = 1;
        }
      }
    }
  }
  // sight is settled for this tick; freeze whatever just went out of view
  refreshMemory();
}

function visibleTo(owner, e) {
  if (e.owner === owner) return true;
  // Follow the Money and Leaked Footage both PIERCE STEALTH, which is why they
  // are tested before hiddenFrom. Following the money is the whole point: an
  // Unmarked Rig is still a rig, and a broadcast that exposes every earner
  // except the ones sneaking is not exposing anything. It makes this the Flat
  // Earth answer to a black budget, which is exactly what it should be.
  if (bcastHas(owner, 'followmoney') && isMoneyTarget(e)) return true;
  if (state.reveals.length && inRevealZone(owner, e)) return true;
  if (hiddenFrom(e, owner)) return false; // stealthed/burrowed and undetected
  // beacons (the Refinery) are public knowledge the moment they finish: no
  // scouting required, and no forgetting them once built. Everyone watches the
  // money move. Unfinished ones still have to be found the normal way — the
  // claim is only staked once the thing is standing.
  if (e.kind === 'building' && e.done && isBeacon(e)) return true;
  const t = tileStateFor(owner, e.x, e.y);
  return e.kind === 'building' ? t >= 1 : t === 2;
}
function visibleToPlayer(e) { return visibleTo(localOwner, e); }

// Is `owner` LOOKING AT this right now, as opposed to merely having explored
// the ground it stands on? visibleTo() answers the second question for
// buildings (state 1 is enough) because that is what target acquisition and the
// AI have always wanted. The screen wants the first: anything not observed is
// drawn from memory instead of from the live object.
function observing(owner, e) {
  if (e.owner === owner) return true;
  if (hiddenFrom(e, owner)) return false;
  if (e.kind === 'building' && e.done && isBeacon(e)) return true; // public by design
  return tileStateFor(owner, e.x, e.y) === 2;
}
function observingPlayer(e) { return observing(localOwner, e); }

// Freeze what each side can no longer see. Runs with the fog, once per tick.
//
// The snapshot is taken on the LAST tick of observation, not every tick: while
// you are watching a building the live object is what gets drawn, so a ghost
// would be wasted work. That makes this cost one Set rebuild per owner rather
// than a clone of every building for every owner, 30 times a second.
function refreshMemory() {
  const byId = new Map();
  for (const b of state.buildings) if (b.hp > 0) byId.set(b.id, b);
  for (const o of OWNERS) {
    const ghosts = memGhosts[o], prev = memObs[o];
    if (!ghosts) continue;
    const now = new Set();
    for (const b of byId.values()) {
      if (!observing(o, b)) continue;
      now.add(b.id);
      ghosts.delete(b.id); // in plain sight: the real building supersedes memory
    }
    for (const id of prev) {
      if (now.has(id)) continue;
      const b = byId.get(id);
      // Watched it fall? Then you know it is gone and no ghost is left behind.
      // Only a building that was standing when you looked away is remembered.
      if (b) ghosts.set(id, Object.assign({}, b, { ghost: true }));
    }
    memObs[o] = now;
  }
}

// is this entity currently running silent? (drawn ghosted for its owner,
// and for enemies whose detector has it pinned)
function isCloaked(e) {
  const stats = e.kind === 'building' ? bstatsOf(e) : UNIT_TYPES[e.type];
  if (e.exposedUntil > state.time) return false;        // lit up by its own muzzle flash
  return !!(e.burrowed || e.disguised || stats.stealth || stats.cloakStill);
}

function makeUnit(owner, type, x, y) {
  const t = UNIT_TYPES[type];
  const u = {
    id: nextId++, kind: 'unit', owner, type,
    x, y, hp: t.hp, maxHp: t.hp,
    order: { type: 'idle' },
    carrying: 0, mineTimer: 0, cooldown: 0,
    facing: Math.atan2(WORLD_H / 2 - y, WORLD_W / 2 - x), travel: 0,
    ammo: t.maxAmmo || 0,
  };
  // reptilian skin suit: barracks infantry pass as friendly until they attack
  if (state.factions[owner] === 'reptilian' && t.builtAt === 'barracks' && t.role === 'combat') {
    u.disguised = true;
  }
  // slaves are worked to death on a staggered clock — the whole workforce
  // must never expire in one synchronized wave. The work regime (Drive
  // button) stretches or slashes the lifespans of NEW slaves.
  if (t.lifespan) u.expires = state.time + t.lifespan * (0.75 + simRandom() * 0.5) * driveLifeMul(owner);
  // a Marksman walks out of the tent already carrying its caches, and an
  // Ex-Special Forces comes off the plane with its charges
  if (t.caches) u.caches = t.caches;
  if (t.charges) u.charges = t.charges;
  state.units.push(u);
  return u;
}

function makeBuilding(owner, type, x, y) {
  const t = bstats(owner, type);
  const b = {
    id: nextId++, kind: 'building', owner, type,
    x, y, w: t.w, h: t.h,
    hp: t.hp, maxHp: t.hp,
    done: true, queue: [], cooldown: 0, rally: null,
  };
  if (t.slots) b.garrison = []; // unit ids stationed inside
  state.buildings.push(b);
  markPathDirty(); // footprints reshape the walkable grid
  // a Refinery ships with a free miner (and lifts the mining cap — see trainUnit)
  if (t.dropoff && facOf(owner) && facOf(owner).worker) {
    makeUnit(owner, facOf(owner).worker, x + (simRandom() - 0.5) * 24, y + t.h / 2 + 22);
  }
  // a Homestead is not an empty building — it comes with the family already
  // living in it, and they start working the moment the roof is on
  if (t.homestead) { b.refillT = 0; stockHomestead(b, HOMESTEAD_START); }
  return b;
}

// ---------- demolition charges (Ex-Special Forces) ----------
// A charge ignores hit points as a wall of attrition and just takes a huge bite
// out of the structure it is stuck to. The fuse is long enough that a defender
// who SEES it planted can still kill the man and save the building — which is
// the whole counterplay, and why the plant takes time and breaks stealth.
function plantCharge(u, b) {
  if (!u.charges || !b || b.hp <= 0 || b.kind !== 'building') return false;
  if (b.owner === u.owner || b.owner === NEUTRAL) return false;
  u.charges--;
  state.charges.push({ id: nextId++, bld: b.id, owner: u.owner, at: state.time + DEMO_FUSE, x: b.x, y: b.y });
  u.exposedUntil = state.time + 4;   // setting it is not a quiet job
  if (u.owner === localOwner) eva('Charge set');
  else if (b.owner === localOwner) eva('Charge on your structure!');
  return true;
}
function updateCharges() {
  if (!state.charges.length) return;
  const live = [];
  for (const c of state.charges) {
    const b = state.buildings.find(x => x.id === c.bld && x.hp > 0);
    if (!b) continue;                       // building already gone; charge goes with it
    if (state.time < c.at) { live.push(c); continue; }
    dealDamage({ owner: c.owner, x: c.x, y: c.y, kind: 'unit' }, b, DEMO_DMG, { demo: true });
    Particles.boom(c.x, c.y, 2.2);
    if (b.owner === localOwner) eva('Structure demolished');
  }
  state.charges = live;
}

// ---------- the Bush Plane ----------
// Three Marksmen walk aboard and Ex-Special Forces come off. Everything about
// it is one-shot: the strip building is consumed, the plane is not a unit you
// keep, and there is no second sortie.
function planeCrew(b) { return (b.crew || []).length; }
function boardPlane(b, u) {
  if (!bstatsOf(b).bushplane || b.launched) return false;
  if (u.type !== 'homesteader' || u.owner !== b.owner) return false;
  b.crew = b.crew || [];
  if (b.crew.length >= BUSHPLANE_CREW) return false;
  b.crew.push(u.id);
  u.hp = 0; u.abducted = true;              // consumed into the airframe
  if (b.owner === localOwner) {
    eva(b.crew.length >= BUSHPLANE_CREW
      ? 'Bush Plane fuelled — pick a drop zone'
      : `Marksman aboard (${b.crew.length}/${BUSHPLANE_CREW})`);
  }
  return true;
}
// Scouted ground only — tile state 0 is never-seen. Ground you once saw and
// have since lost sight of still counts: you must have LOOKED at the place you
// are about to hit, not be looking at it now.
function canDropAt(owner, x, y) {
  if (x < 0 || y < 0 || x > WORLD_W || y > WORLD_H) return false;
  return tileStateFor(owner, x, y) > 0;
}
function launchPlane(b, x, y) {
  if (!bstatsOf(b).bushplane || b.launched || planeCrew(b) < BUSHPLANE_CREW) return false;
  if (!canDropAt(b.owner, x, y)) {
    if (b.owner === localOwner) eva('Drop zone not scouted');
    return false;
  }
  b.launched = true;
  // it TAKES OFF: a real aircraft leaves the strip, crosses the map under fire
  // like anything else with wings, and only then does anyone hit the silk.
  const plane = makeUnit(b.owner, 'bushflight', b.x, b.y);
  plane.crewCount = planeCrew(b);
  plane.facing = Math.atan2(y - b.y, x - b.x);
  plane.order = { type: 'airdrop', x, y };
  b.hp = 0;                                  // the strip goes with it — single use
  if (b.owner === localOwner) eva('Bush Plane away');
  return true;
}
// Everyone aboard dies with the aircraft. This is the whole risk of the play:
// the flight in is the window where an alert enemy can still stop it.
function bushPlaneLost(u) {
  if (u.owner === localOwner) eva('Bush Plane down — team lost');
  Particles.boom(u.x, u.y, 1.8);
}

// ---------- the Bug Out Van ----------
// Which body is welded into this vehicle, if any. A kitted van is a different
// unit TYPE (see the BUGOUT_KITS generator in data.js), so this is just a
// readback of what it became.
function vanKitOf(v) {
  return v && v.kind === 'unit' ? (UNIT_TYPES[v.type].vanKit || null) : null;
}
// Weld a body in: the van becomes its variant and the passenger is stashed so
// unloading can give it back. Refused if the van is ferrying — the bay is a
// bay, and it holds one thing at a time.
function loadVanKit(van, body) {
  if (!UNIT_TYPES[van.type].loader || vanKitOf(van)) return false;
  if ((van.cargo || []).length) { if (van.owner === localOwner) eva('Bay is full of passengers'); return false; }
  const kit = BUGOUT_KITS[body.type];
  if (!kit || body.owner !== van.owner) return false;
  van.type = 'van_' + body.type;
  van.hp = Math.min(van.hp, UNIT_TYPES[van.type].hp);
  van.maxHp = UNIT_TYPES[van.type].hp;
  van.kitBody = body.id;
  body.garrisoned = true; body.transportId = van.id;
  body.x = van.x; body.y = van.y;
  if (van.owner === localOwner) eva(`${kit.name} ready`);
  return true;
}
// Cut them back out: the van is a van again and the body walks away. Both
// survive; killing a kitted van kills both, which is the risk you took.
function unloadVanKit(van) {
  const body = vanKitOf(van) ? state.units.find(u => u.id === van.kitBody && u.hp > 0) : null;
  if (!body) return false;
  van.type = 'bugoutvan';
  van.maxHp = UNIT_TYPES.bugoutvan.hp;
  van.hp = Math.min(van.hp, van.maxHp);
  delete van.kitBody;
  body.garrisoned = false; body.transportId = null;
  body.x = van.x + (simRandom() - 0.5) * 20;
  body.y = van.y + UNIT_TYPES[van.type].r + 14;
  body.order = { type: 'idle' };
  return true;
}

// ---------- PROOF: banked in buildings, not in a treasury ----------
// There is no state.proof[owner]. The total is whatever the owner's Broadcast
// Stations are currently holding, which is what makes the bank raidable: the
// number on the HUD is a sum of things standing on the map, and it goes down
// when one of them stops standing.
function proofStations(owner) {
  return state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.done &&
    bstatsOf(b).proofBank);
}
function proofOf(owner) {
  return proofStations(owner).reduce((n, b) => n + (b.proof || 0), 0);
}
function proofCapOf(owner) {
  return proofStations(owner).length * proofCapPer(owner);
}
// Bank footage into one station, up to its own cap. Returns what would not fit
// so the caller can tell the player their bank is full rather than silently
// evaporating the trip they just made.
function bankProof(b, amount) {
  const room = proofCapPer(b.owner) - (b.proof || 0);
  const took = Math.max(0, Math.min(room, amount));
  b.proof = (b.proof || 0) + took;
  return amount - took;
}
// Spending draws from the fullest station first, so a raid that takes one is
// least likely to take the one you were about to spend.
function spendProof(owner, amount) {
  if (proofOf(owner) < amount) return false;
  let left = amount;
  for (const b of proofStations(owner).sort((x, y) => (y.proof || 0) - (x.proof || 0))) {
    if (left <= 0) break;
    const take = Math.min(b.proof || 0, left);
    b.proof -= take; left -= take;
  }
  return true;
}
// A station that falls takes its footage with it — the whole point of banking
// in a building. Called from the death sweep before the building is filtered out.
function proofStationLost(b) {
  const lost = Math.round(b.proof || 0);
  if (!lost) return;
  if (b.owner === localOwner) eva(`Broadcast Station destroyed — ${lost} proof lost`);
  Particles.pulse(b.x, b.y, 30, [235, 220, 160]);
}

// ---------- THE JOURNALIST: getting the story ----------
// Two stances, and the choice is the whole unit. DISCREET films slowly and
// barely moves the suspicion meter, so you can sit on a building for a long
// time. DOORSTEP films nearly three times faster and drives suspicion to the
// ceiling, so you will get the story and they will get you. The pip above the
// unit is the readout for that gamble — it was already there for the stealth
// system, and this is the decision it was waiting for.
const JOURNO_STANCES = ['discreet', 'doorstep'];
function stanceOf(u) { return u.stance === 'doorstep' ? 'doorstep' : 'discreet'; }
function filmRate(u) {
  return stanceOf(u) === 'doorstep' ? PROOF_FILM_DOORSTEP : PROOF_FILM_DISCREET;
}
// what filming adds to the suspicion TARGET — pushing a lens at somebody is not
// a quiet activity, and doorstepping is not meant to be survivable for long
function filmSuspicion(u) {
  if (!u.filming) return 0;
  return stanceOf(u) === 'doorstep' ? PROOF_SUSP_DOORSTEP : PROOF_SUSP_DISCREET;
}
function journoCap(u) { return PROOF_CARRY; }
// where footage can be handed in: a Broadcast Station, or a News Van parked
// forward (the same favour the Chuck Wagon does the Marksmen)
function proofDropoffs(owner) {
  return [
    ...state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.done && bstatsOf(b).proofBank),
    ...state.units.filter(u => u.owner === owner && u.hp > 0 &&
      (UNIT_TYPES[u.type].vanKit ? BUGOUT_KITS[UNIT_TYPES[u.type].vanKit].proofDropoff : false)),
  ];
}
// A News Van has no vault of its own — it relays what it is handed straight to
// a station, so it is a shortcut on the walk, not extra storage.
function handInProof(owner, amount) {
  let left = amount;
  for (const b of proofStations(owner).sort((x, y) => (x.proof || 0) - (y.proof || 0))) {
    if (left <= 0) break;
    left = bankProof(b, left);
  }
  return left;   // whatever the vaults could not take
}
// battle footage: an enemy dying on camera is worth more than another shot of
// their motor pool. Called from the death sweep.
function creditBattleFootage(victim) {
  for (const u of state.units) {
    if (u.hp <= 0 || !UNIT_TYPES[u.type].investigator) continue;
    if (u.owner === victim.owner) continue;
    if (dist(u, victim) > UNIT_TYPES[u.type].sight) continue;
    u.proof = Math.min(journoCap(u), (u.proof || 0) + PROOF_BATTLE_BONUS);
  }
}

// ---------- BROADCASTS ----------
// Permanents are bought once; timed ones run on a clock owned by the CASTER.
// Debuffs are therefore asked the other way round — "is anyone hostile to me
// currently running this?" — which is what bcastAgainst answers.
function bcastHas(owner, key) { return !!(state.bcast[owner] && state.bcast[owner][key]); }
function bcastActive(owner, key) {
  const t = state.bcastT[owner];
  return !!(t && t[key] > state.time);
}
function bcastAgainst(victim, key) {
  return OWNERS.some(o => o !== victim && bcastActive(o, key));
}
// Household Name discounts everything that comes after it
function bcastCost(owner, key) {
  const B = BROADCASTS[key];
  if (!B) return Infinity;
  return Math.round(B.cost * (bcastHas(owner, 'household') ? BROADCASTS.household.mul : 1));
}
// The Archive deepens every vault you own
function proofCapPer(owner) {
  return PROOF_CAP + (bcastHas(owner, 'archive') ? BROADCASTS.archive.bonus : 0);
}
// Syndication puts one more pair of hands on every farm, including future ones
function homesteadSlotsOf(owner) {
  return HOMESTEAD_SLOTS + (bcastHas(owner, 'syndication') ? 1 : 0);
}
function canBroadcast(owner, key) {
  const B = BROADCASTS[key];
  if (!B) return 'unknown';
  if (B.kind === 'permanent' && bcastHas(owner, key)) return 'owned';
  if (B.req && !hasStruct(owner, B.req)) return 'req';
  if (!proofStations(owner).length) return 'nostation';
  if (proofOf(owner) < bcastCost(owner, key)) return 'proof';
  return null;
}
function fireBroadcast(owner, key, x, y) {
  if (canBroadcast(owner, key)) return false;
  const B = BROADCASTS[key];
  if (!spendProof(owner, bcastCost(owner, key))) return false;
  if (B.kind === 'permanent') (state.bcast[owner] = state.bcast[owner] || {})[key] = true;
  else if (B.kind === 'zone') state.reveals.push({ owner, x, y, r: B.r, until: state.time + B.dur });
  else (state.bcastT[owner] = state.bcastT[owner] || {})[key] = state.time + B.dur;
  // Syndication takes effect on farms that already exist, not just new ones
  if (key === 'syndication') {
    for (const b of state.buildings) {
      if (b.owner === owner && b.hp > 0 && b.done && bstatsOf(b).homestead) stockHomestead(b, 1);
    }
  }
  if (owner === localOwner) { sfx('boom'); eva(`${B.name} — on air`); }
  return true;
}
function updateReveals() {
  if (state.reveals.length) state.reveals = state.reveals.filter(r => r.until > state.time);
}
// is this entity inside a live Leaked Footage window belonging to `owner`?
// what Follow the Money plots permanently: anything that earns or hauls
function isMoneyTarget(e) {
  if (e.kind === 'building') return !!(bstatsOf(e).dropoff || bstatsOf(e).income);
  return UNIT_TYPES[e.type].role === 'worker';
}
function inRevealZone(owner, e) {
  for (const r of state.reveals) {
    if (r.owner !== owner) continue;
    if (dist(r, e) <= r.r) return true;
  }
  return false;
}

// Slot count for a structure, accounting for Syndication on homesteads.
// Every place that asks "how many fit in here" has to agree, or a Syndicated
// farm grows a fifth body that the refill loop then treats as overfull.
function slotsOf(b) {
  const bt = bstatsOf(b);
  return bt.homestead ? homesteadSlotsOf(b.owner) : (bt.slots || 0);
}

// ---------- prepper caches ----------
// The one hard rule: a cache may not be buried inside its owner's own build
// radius. The Flat Earthers can build further out than anyone (FLAT_BUILD_
// RADIUS), so "outside it" means genuinely deep — which is the point. Their
// tech tree lives in enemy country, and the Marksman has to carry it there.
function cacheCount(owner) {
  return state.buildings.reduce((n, b) =>
    n + (b.owner === owner && b.hp > 0 && bstatsOf(b).cache ? 1 : 0), 0);
}
// is there an enemy structure close enough to make this ground worth the risk?
function nearEnemyBase(owner, x, y) {
  return state.buildings.some(b => b.hp > 0 && b.owner !== owner && b.owner !== NEUTRAL &&
    dist(b, { x, y }) <= CACHE_ENEMY_R);
}
function canPlantCache(owner, x, y) {
  if (cacheCount(owner) >= CACHE_CAP) return 'cap';
  if (state.minerals[owner] < CACHE_COST) return 'funds';
  // You cannot bury a cache somewhere you have never been. This is a FOG rule
  // before it is a placement rule: the near-an-enemy test below reads the real
  // world, so answering it over unexplored ground would tell you whether they
  // have a building there — a free scout for the price of a hover. Refusing on
  // "you have not looked" leaks nothing, and it is what the unit would say.
  if (tileStateFor(owner, x, y) === 0) return 'unscouted';
  // THE TWO ZONES DO NOT OVERLAP. Being on their doorstep beats being near
  // home: the "too close" rule exists to stop you stashing the tech tree in a
  // safe backyard, and ground an enemy structure is sitting on is not a safe
  // backyard whatever the distance from your own HQ says. Without this the two
  // radii could intersect on a small map and lock out the very ground the
  // mechanic is meant to be fought over.
  const front = nearEnemyBase(owner, x, y);
  if (!front && withinBuildRadius(owner, x, y)) return 'tooclose';
  if (!front) return 'nofront';
  if (placementBlocked(owner, 'preppercache', x, y)) return 'blocked';
  return null;
}
// why a refused cache was refused — the player gets told, because "nothing
// happened" is the worst possible feedback for a rule they cannot see
const CACHE_REFUSAL = {
  cap: 'Cache limit reached',
  funds: 'Insufficient funds',
  tooclose: 'Too close to home — bury it beyond your build radius',
  unscouted: 'You have not scouted this ground',
  nofront: 'Too far from the enemy — a cache goes on their doorstep',
  blocked: 'No room to bury it here',
};
function plantCache(u, x, y) {
  if (!u.caches) return false;
  const why = canPlantCache(u.owner, x, y);
  if (why) { if (u.owner === localOwner) eva(CACHE_REFUSAL[why]); return false; }
  state.minerals[u.owner] -= CACHE_COST;
  const b = makeBuilding(u.owner, 'preppercache', x, y);
  b.kits = CACHE_KITS;
  // Every cache is STOCKED with one kit, set when it goes in the ground and
  // changeable any time. That is what makes drawing gear a single right-click
  // instead of a menu: the militia do not choose, the cache already decided.
  b.kit = CACHE_LOADOUT[0];
  u.caches--;
  if (u.owner === localOwner) eva('Cache buried');
  return true;
}
// draw a kit: the militia is spent and something else climbs out in its place.
// The cache loses a charge, and an empty cache folds up — it is a box, not a
// barracks, and it was never meant to outlive its contents.
function drawKit(u, b, kit) {
  if (!b || b.hp <= 0 || !b.kits || !CACHE_LOADOUT.includes(kit)) return false;
  if (u.type !== 'militia' || u.owner !== b.owner) return false;
  const n = makeUnit(u.owner, kit, u.x, u.y);
  n.facing = u.facing;
  u.hp = 0; u.abducted = true;          // spent, no wreck and no death cry
  b.kits--;
  Particles.pulse(b.x, b.y, 18, [235, 200, 120]);
  if (b.kits <= 0) { b.hp = 0; if (b.owner === localOwner) eva('Cache empty'); }
  return true;
}

// ---------- the homestead: who is home, and what that is worth ----------
// Fill every empty slot with a militia, already garrisoned. Used once when the
// farm finishes and once per HOMESTEAD_REFILL as bodies grow back.
function stockHomestead(b, howMany = Infinity) {
  const slots = slotsOf(b);
  let made = 0;
  while (farmPopulation(b) < slots && b.garrison.length < slots && made < howMany) {
    const u = makeUnit(b.owner, 'militia', b.x, b.y);
    u.homeFarm = b.id;              // this farm raised them, and is short one until they die
    u.garrisoned = b.id;
    b.garrison.push(u.id);
    made++;
  }
  return made;
}
// EVERYONE this farm has raised who is still breathing — in the yard or out in
// the field. A homestead grows a replacement only when one of ITS people is
// actually dead, never merely absent.
// Without this the farm was an infinite militia printer: muster four, walk them
// away, and the yard quietly grew four more while the first four were still
// alive. Free army, on a timer, forever. Mustering has to cost you the farm's
// output, not duplicate its population.
function farmPopulation(b) {
  let n = 0;
  for (const u of state.units) if (u.hp > 0 && u.homeFarm === b.id) n++;
  return n;
}
// Only militia farm. A Marksman parked in a homestead is a wasted rifle, not a
// farmhand, and the AMR gunner you stuffed in there is not going to pick corn.
function farmhandsIn(b) {
  return (b.garrison || []).reduce((n, id) => {
    const u = state.units.find(x => x.id === id && x.hp > 0);
    return n + (u && u.type === 'militia' ? 1 : 0);
  }, 0);
}
// What every farm this owner holds pays, per second. This is the whole Flat
// Earth economy and it is a live readout of how many people are NOT fighting.
function homesteadIncome(owner) {
  let rate = 0;
  for (const b of state.buildings) {
    if (b.owner !== owner || b.hp <= 0 || !b.done || !bstatsOf(b).homestead) continue;
    rate += farmhandsIn(b) * HOMESTEAD_RATE;
  }
  return rate;
}

function makePatch(x, y, amount = 900, opts = {}) {
  state.patches.push({ id: nextId++, kind: 'patch', x, y, amount, rich: !!opts.rich, yield: opts.yield || 1 });
}

function setupWorld(map) {
  mapDecor = map.decor || [];
  initFog();
  buildTerrainProps(); // before renderGround — props bake into the ground
  renderGround();

  // bases + starting workers, spaced toward the map center
  // (income factions bring no workers — their structures provide)
  for (const owner of OWNERS) {
    const s = map.starts[owner];
    makeBuilding(owner, 'hq', s.x, s.y);
    if (!facOf(owner).worker) continue;
    const home = Math.atan2(WORLD_H / 2 - s.y, WORLD_W / 2 - s.x);
    for (let i = 0; i < 3; i++) {
      makeUnit(owner, facOf(owner).worker,
        s.x + Math.cos(home) * 100 + (i - 1) * 26,
        s.y + Math.sin(home) * 100 + (i % 2) * 22);
    }
    // Workers and nothing else. Every faction opens on the same terms: its
    // HQ and its three miners. No free scout, no free farm, no free anything —
    // whatever you want on the field, you buy.
  }

  // 3-patch cluster at every generated mineral spot; urban ore fields (found in
  // city lots and parks) are a tighter, richer cluster — more minerals per haul
  for (const spot of map.patchSpots) {
    if (spot.rich) {
      for (let i = 0; i < 4; i++) makePatch(spot.x + (i % 2 - 0.5) * 40, spot.y + ((i >> 1) - 0.5) * 34, spot.amount, { rich: true, yield: spot.yield || 1.7 });
    } else {
      for (let i = 0; i < 3; i++) makePatch(spot.x + (i - 1) * 42, spot.y + (i % 2) * 34, spot.amount);
    }
  }

  // neutral settlements and derricks — garrison infantry to claim them
  for (const n of map.neutrals) makeBuilding(NEUTRAL, n.type, n.x, n.y);

  // faction setup powers
  for (const owner of OWNERS) {
    if (state.factions[owner] === 'resistance') {
      // sleeper cells: hidden observation camps scattered around the map
      for (let i = 0, tries = 0; i < 3 && tries < 60; tries++) {
        const sx = 120 + simRandom() * (WORLD_W - 240);
        const sy = 120 + simRandom() * (WORLD_H - 240);
        if (map.starts.some(st => dist(st, { x: sx, y: sy }) < 350)) continue;
        makeBuilding(owner, 'sleepercell', sx, sy);
        i++;
      }
    }
    if (state.factions[owner] === 'reptilian') {
      // one random enemy worker was always ours (skips worker-less factions)
      const pool = state.units.filter(u => u.owner !== owner && UNIT_TYPES[u.type].role === 'worker');
      if (pool.length) state.infiltrator[owner] = pool[Math.floor(simRandom() * pool.length)].id;
    }
  }

  centerCameraOnHome();
  updateFog();
}

function centerCameraOnHome() {
  const hq = state.buildings.find(b => b.owner === localOwner && b.type === 'hq');
  if (!hq) return;
  cam.x = isoX(hq.x, hq.y) - canvas.width / cam.zoom / 2;
  cam.y = isoY(hq.x, hq.y) - canvas.height / cam.zoom / 2;
  clampCam();
}

function minZoom() {
  return Math.max(canvas.width / isoSpanW(), canvas.height / isoSpanH(), 0.5);
}

// cam.x/cam.y live in iso screen space; clamp by keeping the CENTER of the
// view over the world rectangle (the iso diamond has empty corners, so a
// plain bounding-box clamp would let the camera sit over pure void)
function clampCam() {
  cam.zoom = clamp(cam.zoom, minZoom(), 2);
  const hw = canvas.width / cam.zoom / 2, hh = canvas.height / cam.zoom / 2;
  const c = isoUnproject(cam.x + hw, cam.y + hh);
  const wx = clamp(c.x, 0, WORLD_W), wy = clamp(c.y, 0, WORLD_H);
  cam.x = isoX(wx, wy) - hw;
  cam.y = isoY(wx, wy) - hh;
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

function countStruct(owner, type) {
  return state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.type === type).length;
}

function atStructCap(owner, type) {
  const cap = bstats(owner, type).cap;
  return cap !== undefined && countStruct(owner, type) >= cap;
}

// ---------- you cannot open a new farm while one stands empty ----------
// A homestead with nobody in it is not a farm, it is a building with a fence.
// Without this you could muster every yard, spend the militia, and keep laying
// down fresh farms as pure hit points and extra win-condition targets — the
// land would grow while the people who work it did not. Fill what you have.
// Returns the empty ones so callers can say how many.
function emptyHomesteads(owner) {
  return state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.done &&
    bstatsOf(b).homestead && farmhandsIn(b) === 0);
}
function homesteadBlocked(owner, type) {
  return !!bstats(owner, type).homestead && emptyHomesteads(owner).length > 0;
}

function startConstruction(owner, type) {
  if (state.construction[owner]) return false;
  if (atStructCap(owner, type)) return false;
  if (homesteadBlocked(owner, type)) return false;
  const rq = bstats(owner, type).req;
  if (rq && !hasStruct(owner, rq)) return false;
  const cost = bstats(owner, type).cost;
  if (state.minerals[owner] < cost) return false;
  state.minerals[owner] -= cost;
  state.construction[owner] = { type, t: 0, duration: bstats(owner, type).buildTime, ready: false };
  return true;
}

function placementBlocked(owner, type, x, y) {
  const t = bstats(owner, type);
  if (x - t.w / 2 < 10 || y - t.h / 2 < 10 || x + t.w / 2 > WORLD_W - 10 || y + t.h / 2 > WORLD_H - 10) return true;
  // 32px between structures: wide enough for the fattest ground unit (26px
  // mining rig) to pass — tighter packing let bases seal their own workers
  // into courtyards with no physical way out. Wall segments are the
  // exception: they snap flush against other wall pieces to form a line.
  return state.buildings.some(b => {
      if (b.hp <= 0 || bstatsOf(b).noBlock) return false; // mines don't crowd out anything
      // Wall-kind against wall-kind gets a RADIAL minimum separation instead of
      // the axis-aligned box every other structure uses. The box test made
      // diagonal wall runs impossible: two 26px segments stepped along a
      // 45-degree drag sit ~18 apart on BOTH axes, which the box scored as
      // overlapping — so the first piece went down and every one after it was
      // silently refused, leaving the long gaps you get on a diagonal drag.
      // Radially they are 26 apart, they seal the line, and this lets them.
      if (t.wallKind && bstatsOf(b).wallKind) {
        return Math.hypot(b.x - x, b.y - y) < (b.w + t.w) * 0.29;
      }
      return Math.abs(b.x - x) < (b.w + t.w) / 2 + STRUCT_GAP && Math.abs(b.y - y) < (b.h + t.h) / 2 + STRUCT_GAP;
    })
    || state.patches.some(p => p.amount > 0 && dist(p, { x, y }) < t.w / 2 + 30)
    || TERRAIN.some(o => dist(o, { x, y }) < o.r + Math.max(t.w, t.h) / 2 + 6);
}

// How far from an anchor this owner may build. Everyone gets BUILD_RADIUS; the
// Flat Earthers homestead across half a county (FLAT_BUILD_RADIUS), which is
// what lets their win condition be spread out enough to be worth spreading out.
// It is also the fence the prepper caches must clear — see canPlantCache.
function buildRadiusOf(owner) {
  return state.factions[owner] === 'flat' ? FLAT_BUILD_RADIUS : BUILD_RADIUS;
}
function withinBuildRadius(owner, x, y) {
  const R = buildRadiusOf(owner);
  return state.buildings.some(b => b.owner === owner && b.hp > 0 && b.done &&
    (b.type === 'hq' || b.type === 'powerplant' || bstatsOf(b).anchor) && dist(b, { x, y }) <= R);
}

// `instantType` is passed by the place command (it carries what the player had
// on the cursor); the AI omits it and always goes through the build queue. It
// used to read the `placing` global directly, which is view state and has no
// business being consulted from inside a tick.
function tryPlace(owner, x, y, instantType) {
  // instant field structures (walls, gates, mines): pay per placement, never
  // touch the build queue.
  if (instantType && bstats(owner, instantType).instant) {
    const type = instantType, st = bstats(owner, type);
    if (atStructCap(owner, type)) return false;
    if (state.minerals[owner] < st.cost) { eva('Insufficient funds'); return false; }
    if (placementBlocked(owner, type, x, y) || (!st.anywhere && !withinBuildRadius(owner, x, y))) return false;
    state.minerals[owner] -= st.cost;
    makeBuilding(owner, type, x, y);
    return true;
  }
  const c = state.construction[owner];
  if (!c || !c.ready) return false;
  // `anywhere` structures (mines, forward tunnel entrances) skip the
  // build-radius leash — planting them deep in enemy country is the point
  if (placementBlocked(owner, c.type, x, y) ||
      (!bstats(owner, c.type).anywhere && !withinBuildRadius(owner, x, y))) return false;
  makeBuilding(owner, c.type, x, y);
  state.construction[owner] = null;
  return true;
}

// lay a whole run of wall segments between two points (RA2 drag placement).
// Segments are spaced WALL_STEP apart along the drag; each is placed only if
// affordable, uncapped, unobstructed and inside the build radius. A click with
// no drag lays a single segment.
function commitWallLine(owner, x0, y0, x1, y1) {
  const ex = Math.round(x1 / WALL_STEP) * WALL_STEP, ey = Math.round(y1 / WALL_STEP) * WALL_STEP;
  const dx = ex - x0, dy = ey - y0;
  const n = Math.max(0, Math.round(Math.hypot(dx, dy) / WALL_STEP));
  const st = bstats(owner, 'wall');
  let placed = 0;
  for (let i = 0; i <= n; i++) {
    const x = x0 + dx * (i / (n || 1)), y = y0 + dy * (i / (n || 1));
    if (state.minerals[owner] < st.cost || atStructCap(owner, 'wall')) break;
    if (placementBlocked(owner, 'wall', x, y) || !withinBuildRadius(owner, x, y)) continue;
    state.minerals[owner] -= st.cost;
    makeBuilding(owner, 'wall', x, y);
    placed++;
  }
  if (placed) sfx('click');
  return placed;
}

// gates aren't dropped on open ground — you cut one into your own wall. Returns
// the player wall under (x,y) IF it sits on a straight run (wall neighbors on
// opposite sides, so the gate reads as an inline door), else null.
function gateTargetWall(owner, x, y) {
  const wall = state.buildings.find(b => b.owner === owner && b.type === 'wall' && b.hp > 0 &&
    Math.abs(b.x - x) <= b.w / 2 + 4 && Math.abs(b.y - y) <= b.h / 2 + 4);
  if (!wall) return null;
  const c = wallConn(wall); // e=1,w=2,n=4,s=8
  const straight = (((c & 1) && (c & 2)) || ((c & 4) && (c & 8)));
  return straight ? wall : null;
}

// convert a straight wall segment under the cursor into a gate (charges the
// upgrade cost — the wall's cost is already sunk). Keeps the tool armed.
function convertWallToGate(owner, x, y) {
  const wall = gateTargetWall(owner, x, y);
  if (!wall) { eva('Gates go on a straight wall segment'); return false; }
  const cost = Math.max(0, bstats(owner, 'gate').cost - bstats(owner, 'wall').cost);
  if (state.minerals[owner] < cost) { eva('Insufficient funds'); return false; }
  state.minerals[owner] -= cost;
  const gx = wall.x, gy = wall.y;
  state.buildings = state.buildings.filter(b => b !== wall); // swap wall -> gate in place
  makeBuilding(owner, 'gate', gx, gy);
  markPathDirty();
  sfx('click');
  return true;
}

function tickConstruction(owner, dt) {
  const c = state.construction[owner];
  if (!c || c.ready) return;
  c.t += dt * (powerOf(owner).low ? brownoutRate(owner) : 1);
  if (c.t >= c.duration) {
    c.ready = true;
    // keyed on the job object, so a second building of the same type announces
    // again — and so nothing about the announcement touches `c` itself
    if (owner === localOwner && announcedBuild[owner] !== c) {
      announcedBuild[owner] = c;
      eva('Construction complete');
    }
  }
}

// ---------- superweapons ----------
// each faction's tech-gated doomsday structure charges while it stands, then
// fires one of the SUPER_DEFS effects at a targeted point and resets.

function superReady(b) {
  if (!(bstatsOf(b).superweapon && b.done && (b.charge || 0) >= superChargeOf(b))) return false;
  // the Bloodline Throne fires on blood, not time alone: 60 loosh minimum
  if (superKindOf(b) === 'coup' && (state.loosh[b.owner] || 0) < 60) return false;
  return true;
}
function superChargeOf(b) {
  return (SUPER_DEFS[state.factions[b.owner]] || { charge: 180 }).charge;
}
function superKindOf(b) {
  return (SUPER_DEFS[state.factions[b.owner]] || { kind: 'rocket' }).kind;
}

function fireSuperweapon(b, x, y) {
  const owner = b.owner;
  const kind = superKindOf(b);
  b.charge = 0;
  b.fireT = state.time; // drives the launch animation on the silo art
  const seen = tileState(x, y) === 2;
  if (kind === 'rocket') {
    // Katyusha saturation salvo: a spread of heavy rockets rains across a small
    // area around the mark — inaccurate individually, devastating together, and
    // harder-hitting than the Resistance barrage but over a tighter footprint
    const N = 8, scatterR = 100;
    for (let i = 0; i < N; i++) {
      const a = simRandom() * Math.PI * 2, rr = Math.sqrt(simRandom()) * scatterR;
      const px = clamp(x + Math.cos(a) * rr, 10, WORLD_W - 10);
      const py = clamp(y + Math.sin(a) * rr, 10, WORLD_H - 10);
      state.projectiles.push({ kind: 'superrocket', x: px, y: py, tx: px, ty: py, owner, t: 0,
        dur: 1.5 + simRandom() * 1.5, hgt: 0, stats: { dmg: 95, splash: 54, bldgBonus: 1.5, sup: true } });
    }
    if (seen) sfx('boom');
  } else if (kind === 'orbital') {
    // rods from god: instant, pinpoint, brutal
    splashDamage(x, y, 90, 380, owner, { bldgBonus: 1.4, sup: true }, true);
    Particles.bolt(x, y - 600, x, y, [180, 230, 255], 0);
    Particles.boom(x, y, 2.4);
    state.zones.push({ x, y, r: 90, until: state.time + 0.6, caster: owner, kind: 'orbital' });
    if (seen) sfx('boom');
  } else if (kind === 'quake') {
    // The Big One: tears every structure in the zone apart
    for (const t of state.buildings) {
      if (t.owner === owner || t.owner === NEUTRAL || t.hp <= 0) continue;
      const d = dist(t, { x, y });
      if (d <= 240) dealDamage(null, t, 340 * (1 - 0.5 * d / 240), { bldgBonus: 1.6 });
    }
    state.zones.push({ x, y, r: 240, until: state.time + 2.5, caster: owner, kind: 'quake' });
    if (seen) sfx('boom');
  } else if (kind === 'emp') {
    // Total Blackout: enemy structures in the zone go dark (no fire, no
    // production, no power) for 20 seconds — non-damaging
    for (const t of state.buildings) {
      if (t.owner === owner || t.owner === NEUTRAL || t.hp <= 0) continue;
      if (dist(t, { x, y }) <= 260) t.empUntil = state.time + 20;
    }
    state.zones.push({ x, y, r: 260, until: state.time + 20, caster: owner, kind: 'emp' });
    if (owner === localOwner) eva('Blackout deployed');
  } else if (kind === 'barrage') {
    // loitering-munition swarm: a cloud of drones circles in, then a rolling
    // series of small strikes rains across the zone (weaker, on brand)
    state.zones.push({ x, y, r: 170, until: state.time + 8, caster: owner, kind: 'barrage',
      tick: 0.2, dmg: 55, sup: true });
    if (owner === localOwner) eva('Munitions inbound');
  } else if (kind === 'ray') {
    // Pyramid Death Ray: a sustained beam grinds the zone to nothing
    state.zones.push({ x, y, r: 120, until: state.time + 5, caster: owner, kind: 'ray',
      tick: 0.25, dmg: 70, srcId: b.id, sup: true });
    if (owner === localOwner) eva('Death ray firing');
  } else if (kind === 'coup') {
    // Bloodline Coup: fired on BLOOD — consumes 60 loosh minimum and drinks
    // up to 200; every point past the minimum widens the zone. Enemy units
    // inside defect for 45s, then revert.
    const spend = clamp(state.loosh[owner] || 0, 60, 200);
    state.loosh[owner] = (state.loosh[owner] || 0) - spend;
    const r = 120 + (spend - 60); // 120px at the minimum, 260px fully fed
    for (const u of state.units) {
      if (u.owner === owner || u.hp <= 0 || u.garrisoned || u.type === 'phantom') continue;
      if (UNIT_TYPES[u.type].role === 'worker') continue; // only fighters turn
      if (dist(u, { x, y }) <= r) {
        u.coupOrig = u.coupOrig !== undefined ? u.coupOrig : u.owner;
        // Crisis Actors: they still turn, they just do not stay turned
        u.coupRevert = state.time + (disproved(u.owner, 'actors') ? ACTORS_RETURN : COUP_HOLD);
        u.owner = owner;
        u.disguised = false;
        u.order = { type: 'idle' };
        Particles.pulse(u.x, u.y, 20, [201, 167, 255]);
      }
    }
    state.zones.push({ x, y, r, until: state.time + 1.5, caster: owner, kind: 'coup' });
    if (owner === localOwner) eva('The bloodline commands them');
  }
  if (owner === localOwner && kind !== 'emp' && kind !== 'barrage' && kind !== 'ray' && kind !== 'coup') {
    eva('Superweapon fired');
  }
}

// a building sits dark under EMP: no weapons, no production, no power output
function isOffline(b) {
  return b.empUntil > state.time;
}

// ---------- losing the HQ isn't always losing ----------
// Factions with hqRebuild get a GRACE WINDOW when their last HQ falls instead
// of an instant defeat: a tent city, a cell with another basement, or a
// government that was never in that building to begin with. One per game.
//   cost  — what a replacement costs (0 for the Deep State)
//   grace — seconds before the loss actually lands
//   auto  — if set, it relocates itself this many seconds in, no input needed
const hqRebuildDef = owner => (facOf(owner) || {}).hqRebuild;
function hasHq(owner) {
  return state.buildings.some(b => b.owner === owner && b.type === 'hq' && b.hp > 0);
}
// ---------- the last stand (Flat Earth) ----------
// Nobody lives at the Bunker. They live on the LAND, and you cannot kill a
// people by burning their courthouse. A Flat Earther is in the game while the
// Bunker stands OR any homestead does, so finishing them means clearing the
// compound and then every farm — up to HOMESTEAD_CAP of them, scattered across
// a build radius twice anyone else's.
// Homesteads light up on the minimap only once the Bunker is down (isBeacon):
// hidden while the compound stands, public once they ARE the win condition, so
// the hunt is long but never blind. They have no hqRebuild — these are it.
function hasHomestead(owner) {
  return state.buildings.some(b => b.owner === owner && b.hp > 0 && b.done &&
    bstatsOf(b).homestead);
}
// still in the game? An HQ stands, the grace window is open, or the land holds.
function hasHqOrCanRebuild(owner) {
  if (hasHq(owner)) return true;
  if (hasHomestead(owner)) return true;
  const g = state.hqGrace[owner];
  return !!g && state.time < g.until;
}
// open the window the moment the last HQ dies (once per game, per owner)
function noteHqLost(owner) {
  const def = hqRebuildDef(owner);
  if (!def || state.hqRebuilt[owner] || state.hqGrace[owner]) return;
  state.hqGrace[owner] = { until: state.time + def.grace, at: state.time };
  if (owner === localOwner) {
    eva(def.auto ? 'HQ lost — continuity protocol running' : `HQ lost — rebuild within ${def.grace}s`);
  }
}
// somewhere legal, near what's left of the owner's base
function pickRelocateSpot(owner) {
  const anchors = state.buildings.filter(b => b.owner === owner && b.hp > 0);
  const around = anchors.length ? anchors[Math.floor(simRandom() * anchors.length)]
    : { x: WORLD_W / 2, y: WORLD_H / 2 };
  for (let i = 0; i < 300; i++) {
    const a = simRandom() * Math.PI * 2, r = 120 + simRandom() * 320;
    const x = clamp(around.x + Math.cos(a) * r, 80, WORLD_W - 80);
    const y = clamp(around.y + Math.sin(a) * r, 80, WORLD_H - 80);
    if (!placementBlocked(owner, 'hq', x, y)) return { x, y };
  }
  return null;
}
function rebuildHq(owner, x, y) {
  const def = hqRebuildDef(owner);
  if (!def || state.hqRebuilt[owner] || hasHq(owner)) return false;
  if (state.minerals[owner] < def.cost) { if (owner === localOwner) eva('Insufficient funds'); return false; }
  if (placementBlocked(owner, 'hq', x, y)) { if (owner === localOwner) eva('No room there'); return false; }
  state.minerals[owner] -= def.cost;
  state.hqRebuilt[owner] = true;
  state.hqGrace[owner] = null;
  const b = makeBuilding(owner, 'hq', x, y);
  Particles.pulse(x, y, 60, [125, 255, 214]);
  if (owner === localOwner) eva(def.auto ? 'Continuity of government restored' : 'Headquarters re-established');
  else if (isPlayerVisible(x, y)) eva('The enemy has re-established a headquarters');
  return b;
}
const isPlayerVisible = (x, y) => tileState(x, y) === 2;
// runs every frame: opens the window, fires the automatic relocation, and
// lets the AI put its own house back together
function updateHqContinuity(dt) {
  for (const owner of OWNERS) {
    if (hasHq(owner)) { if (state.hqGrace[owner]) state.hqGrace[owner] = null; continue; }
    const def = hqRebuildDef(owner);
    if (!def || state.hqRebuilt[owner]) continue;
    noteHqLost(owner);
    const g = state.hqGrace[owner];
    if (!g) continue;
    // an automatic relocation needs no input; the AI always rebuilds on its
    // own too, since it has no sidebar to click
    const elapsed = state.time - g.at;
    const autoNow = def.auto !== undefined && elapsed >= def.auto;
    if (autoNow || (!isHuman(owner) && elapsed >= 4)) {
      const spot = pickRelocateSpot(owner);
      if (spot) rebuildHq(owner, spot.x, spot.y);
    }
  }
}

// ---------- spending LEVERAGE ----------
// Applied to an enemy STRUCTURE; the play decides what happens to its owner.
// Returns true if the leverage was actually spent.
function playLeverage(owner, key, target) {
  const play = LEVERAGE_PLAYS[key];
  if (!play || !target || target.kind !== 'building' || target.hp <= 0) return false;
  if (target.owner === owner || target.owner === NEUTRAL) {
    if (owner === localOwner) eva('Point it at THEIR property');
    return false;
  }
  if ((state.leverage[owner] || 0) < play.cost) {
    if (owner === localOwner) eva('Not enough leverage');
    return false;
  }
  const victim = target.owner;
  if (key === 'freeze') {
    // reuse the blackout the Deep State superweapon already speaks: dark
    // structure, no production, no guns, off the grid
    target.empUntil = Math.max(target.empUntil || 0, state.time + play.dur);
    Particles.pulse(target.x, target.y, 46, [190, 140, 255]);
  } else if (key === 'books') {
    state.books[owner] = { on: victim, until: state.time + play.dur };
  } else if (key === 'margin') {
    if (!state.construction[victim]) {
      if (owner === localOwner) eva('They have nothing on the books right now');
      return false;                       // nothing to call in — no charge
    }
    state.construction[victim] = null;    // cancelled, and no refund
    Particles.pulse(target.x, target.y, 40, [190, 140, 255]);
  }
  state.leverage[owner] -= play.cost;
  if (owner === localOwner) eva(play.name + ' — executed');
  // the victim is told only what they could work out for themselves
  if (victim === localOwner) {
    eva(key === 'freeze' ? buildingName(target) + ' has gone dark'
      : key === 'margin' ? 'Construction cancelled — the paperwork fell through'
      : 'Someone is reading our files');
  }
  return true;
}

// ---------- structure repair ----------
// What a structure is worth for repair billing: its sticker price, or — for
// captured civilian buildings, HQs and anything else the build menu never
// charged for — a slice of its hit points, so a free Mega Tower isn't a free
// fortress to keep standing.
const repairValueOf = b => bstatsOf(b).cost || Math.round(bstatsOf(b).hp * REPAIR_FREE_VALUE);
// is there anything to mend, and is the structure in a state to accept it?
// Rubble, foundations, EMP'd shells and neutral property are all out.
function canRepair(b) {
  return b.hp > 0 && b.done && b.owner !== NEUTRAL && b.hp < b.maxHp && !isOffline(b);
}
// per-second cost of mending this structure at full rate — what the button
// quotes, so the price you read is the price you pay
const repairRateOf = b => b.maxHp * REPAIR_RATE;
const repairCostPerSec = b => repairValueOf(b) * REPAIR_COST * REPAIR_RATE;

// ---------- demolition ----------
// What pulling this down pays back. Captured civilian structures were never
// bought, so they refund nothing — you may still clear them off your ground.
const demolishRefund = b => Math.floor((bstatsOf(b).cost || 0) * DEMOLISH_REFUND);
// A structure can be scrapped whether or not it is finished or damaged; the one
// thing that stops you is it not being yours.
const canDemolish = b => !!b && b.kind === 'building' && b.hp > 0 && b.owner !== NEUTRAL;

// ---------- THE FIRMAMENT: the dome, made briefly non-negotiable ----------
function castFirmament(owner, x, y) {
  const pk = FACTIONS[state.factions[owner]].powers.sig;
  state.zones.push({ kind: 'firmament', x, y, r: pk.r, until: state.time + pk.dur,
                     caster: owner, dps: pk.dps });
  state.sig[owner].cd = pk.cd;
  if (owner === localOwner) { sfx('laser'); eva('The firmament holds'); }
}

function castWeather(owner, x, y) {
  state.zones.push({ x, y, r: 150, until: state.time + 15, caster: owner, kind: 'rain' });
  state.sig[owner].cd = FACTIONS[state.factions[owner]].powers.sig.cd;
  if (owner === localOwner) eva('Weather modification deployed');
}

function castClone(owner, unit) {
  // the vats only fit people-shaped things — no vehicles, no aircraft
  if (UNIT_TYPES[unit.type].builtAt !== 'barracks') return false;
  const home = state.buildings.find(b => b.owner === owner && b.hp > 0 && b.done && b.type === 'barracks')
    || state.buildings.find(b => b.owner === owner && b.hp > 0 && b.type === 'hq');
  if (!home) return false;
  makeUnit(owner, unit.type, home.x + 20, home.y + home.h / 2 + 22);
  state.sig[owner].cd = FACTIONS[state.factions[owner]].powers.sig.cd;
  if (owner === localOwner) eva('Clone ready');
  return true;
}

function castGaslight(owner) {
  const myHq = state.buildings.find(b => b.owner === owner && b.type === 'hq' && b.hp > 0);
  const hq = nearest(myHq || { x: WORLD_W / 2, y: WORLD_H / 2 }, state.buildings,
    b => b.owner !== owner && b.type === 'hq' && b.hp > 0);
  if (!hq) return;
  for (let i = 0; i < 4; i++) {
    const p = makeUnit(owner, 'phantom', hq.x + Math.cos(i * 1.7) * 180, hq.y + Math.sin(i * 1.7) * 180);
    p.expires = state.time + 20;
  }
  state.sig[owner].cd = FACTIONS[state.factions[owner]].powers.sig.cd;
  if (owner === localOwner) eva('They are chasing ghosts');
}

function castRevealInfiltrator(owner) {
  const sig = state.sig[owner];
  if (sig.used) return false;
  const u = state.units.find(x => x.id === state.infiltrator[owner] && x.hp > 0);
  sig.used = true;
  if (!u) { if (owner === localOwner) eva('The infiltrator was lost'); return false; }
  const wasPlayers = u.owner === localOwner;
  u.owner = owner;
  u.order = { type: 'idle' };
  if (owner === localOwner) eva('The infiltrator answers the call');
  else if (wasPlayers) eva('One of our workers was never ours');
  return true;
}

// Vril Recall: a small circle of ground, anywhere on the map — everything of
// yours standing in it comes home in a flash of green light. The radius is
// deliberately tight and the count is capped (see the faction's sig def), so
// this pulls a squad out of a bad fight; it does not evacuate an army.
const recallDef = owner => FACTIONS[state.factions[owner]].powers.sig;
// who a cast at (x,y) would actually take — shared with the targeting reticle
// so the circle you see is exactly the circle you get
function recallTargets(owner, x, y) {
  const S = recallDef(owner), pt = { x, y };
  return state.units
    .filter(u => u.owner === owner && u.hp > 0 && !u.garrisoned && !u.transit && dist(u, pt) <= S.r)
    .sort((a, b) => dist(a, pt) - dist(b, pt))   // nearest the centre wins the seats
    .slice(0, S.max);
}
function castRecall(owner, x, y) {
  const hq = state.buildings.find(b => b.owner === owner && b.type === 'hq' && b.hp > 0);
  if (!hq) return;
  const picks = recallTargets(owner, x, y);
  // an empty circle doesn't burn the cooldown — a misclick shouldn't cost 90s
  if (!picks.length) { if (owner === localOwner) eva('Nothing of yours stands there'); return; }
  const S = recallDef(owner);
  Particles.pulse(x, y, S.r, [125, 255, 214]);   // the circle collapses inward
  picks.forEach((u, i) => {
    Particles.pulse(u.x, u.y, 30, [125, 255, 214]);
    // fan them out below the HQ so a recalled squad doesn't land in one heap
    const spread = (i - (picks.length - 1) / 2) * 22;
    u.x = hq.x + spread + (simRandom() - 0.5) * 10;
    u.y = hq.y + hq.h / 2 + 26 + (simRandom() - 0.5) * 12;
    u.order = { type: 'idle' };
    delete u.dodge; delete u.veer;
    Particles.pulse(u.x, u.y, 30, [125, 255, 214]);
  });
  state.sig[owner].cd = S.cd;
  if (owner === localOwner) eva(`Recall complete — ${picks.length} home`);
}

// ---------- what the smuggling run is worth ----------
// The routes pay for CONTROLLING THE COUNTRYSIDE, not for owning a lot of
// doors. Held civilian structures only count if they are genuinely spread out:
// each one claims a SMUGGLE_AREA-radius region, and a building inside a region
// already claimed by another adds nothing. Four warehouses on one city block is
// one route; four holdings across the map is four. That keeps the payout
// honest on Metropolis, where you could otherwise garrison a whole street.
function smuggleRun(owner) {
  const held = state.buildings.filter(b => b.owner === owner && b.hp > 0 &&
    bstatsOf(b).slots && !bstatsOf(b).cost);   // captured civilian property only
  const claimed = [];
  for (const b of held) {
    if (claimed.some(c => dist(c, b) < SMUGGLE_AREA)) continue;  // same district
    claimed.push(b);
    if (claimed.length >= SMUGGLE_MAX_AREAS) break;
  }
  return { pay: SMUGGLE_BASE + claimed.length * SMUGGLE_PER_AREA, areas: claimed.length };
}

function spawnSmuggler(owner) {
  const hq = state.buildings.find(b => b.owner === owner && b.type === 'hq' && b.hp > 0);
  if (!hq) return;
  const edges = [
    { x: 20, y: WORLD_H / 2 }, { x: WORLD_W - 20, y: WORLD_H / 2 },
    { x: WORLD_W / 2, y: 20 }, { x: WORLD_W / 2, y: WORLD_H - 20 },
  ];
  const e = edges[Math.floor(simRandom() * edges.length)];
  const u = makeUnit(owner, 'smuggler', e.x, e.y);
  const run = smuggleRun(owner);
  u.payload = run.pay;   // banked at dispatch: what you held when it set out
  u.order = { type: 'deliver' };
  if (owner === localOwner) {
    eva(run.areas ? `Supply truck inbound — $${run.pay} (${run.areas} districts held)`
                  : `Supply truck inbound — $${run.pay}`);
  }
}

// You turn RANK AND FILE, not the leadership. A mole is somebody's line
// trooper who was always yours — never the elite kit (tier 3: tech-gated,
// blood-bought or simply expensive), never a one-of-a-kind figure like the
// Megaphone Prophet, and never an unarmed specialist who'd just stand around.
function moleEligible(type) {
  if (!type) return false;
  const ut = UNIT_TYPES[type];
  if (!ut || ut.role !== 'combat' || !ut.dmg) return false; // moles fight; no engineers, no scouts
  if (ut.limit) return false;                               // never a unique — the Prophet stays bought
  if (unitTier(type) >= 3) return false;                    // never elite kit
  return true;
}
// ---------- ASSETS: the sleeper network ----------
// The old version handed you a free body every two minutes, which is a
// reinforcement, not subversion. A sleeper is subtler and far nastier: an
// enemy unit that was ALWAYS yours. It keeps serving its owner — walks in
// their army, fights in their line, counts in their supply — while you see
// everything it sees. Then you wake it, and it turns in the middle of their
// formation at the worst possible moment for them.
//
// u.sleeperFor = owner of the handler. The unit's real owner never changes
// until it is woken (see wakeSleeper), so nothing about it looks wrong.
const SLEEPER_MAX = 3;          // assets in place at once
function sleeperCount(owner) {
  return state.units.reduce((n, u) => n + (u.hp > 0 && u.sleeperFor === owner ? 1 : 0), 0);
}
function recruitSleeper(owner) {
  if (sleeperCount(owner) >= SLEEPER_MAX) return;
  // anybody's line trooper will do, so long as they're not elite kit, not a
  // one-of-a-kind, and not already somebody else's asset
  const pool = state.units.filter(u => u.hp > 0 && u.owner !== owner && u.owner !== NEUTRAL &&
    !u.sleeperFor && !u.garrisoned && !u.transit && moleEligible(u.type));
  if (!pool.length) return;
  const u = pool[Math.floor(simRandom() * pool.length)];
  u.sleeperFor = owner;
  // Crisis Actors: the handler can still turn them, but the arrangement has a
  // shelf life — they come to their senses and stop reporting
  if (disproved(u.owner, 'actors')) u.sleeperUntil = state.time + ACTORS_RETURN;
  if (owner === localOwner) eva('An asset is in place');
}
// wake one: it turns on the spot, right where it stands
function wakeSleeper(u) {
  if (!u || u.hp <= 0 || u.sleeperFor === undefined) return false;
  const handler = u.sleeperFor;
  const wasOwner = u.owner;
  delete u.sleeperFor;
  u.owner = handler;
  u.disguised = false;
  u.carrying = 0;
  u.order = { type: 'idle' };
  delete u.homeId; delete u.slot;          // no longer welcome at its old airfield
  Particles.pulse(u.x, u.y, 34, [190, 140, 255]);
  if (handler === localOwner) eva(UNIT_TYPES[u.type].name + ' was always ours');
  else if (wasOwner === localOwner) eva('One of ours was never ours');
  return true;
}
// the handler sees through every asset — this feeds the fog reveal
function sleeperEyes(owner) {
  return state.units.filter(u => u.hp > 0 && u.sleeperFor === owner && !u.garrisoned);
}

function updateAbilities(dt) {
  state.zones = state.zones.filter(z => z.until > state.time);
  // ---------- the Mechanicum queue ----------
  // One body on the slab at a time. b.rites is the line, in arrival order; the
  // body at the front has its finish time stamped and works, everyone behind it
  // waits garrisoned with no `at`. A Mechanicum that falls hands its whole
  // queue back — bodies and fees both (see cancelRite).
  const RITE_DONE = {
    techpriest: 'The Priest is anointed',
    lanternguard: 'A Lantern Guard rises',
    dreadnought: 'A Dreadnought walks',
  };
  for (const b of state.buildings) {
    if (!b.rites || !b.rites.length) continue;
    if (b.hp <= 0 || b.type !== 'mechanicum') {
      for (const id of b.rites.slice()) cancelRite(findEntity(id));
      b.rites = [];
      continue;
    }
    // shed anyone who died on the slab or was pulled out of the line
    b.rites = b.rites.filter(id => {
      const u = findEntity(id);
      return u && u.hp > 0 && u.ascension && u.ascension.bld === b.id;
    });
    const head = b.rites.length ? findEntity(b.rites[0]) : null;
    if (head && head.ascension.at === undefined) {
      head.ascension.at = state.time + ASCEND[head.ascension.to].time;
      if (b.owner === localOwner) eva('The slab takes the ' + UNIT_TYPES[head.ascension.to].name);
    }
  }
  for (const u of state.units) {
    // only the body actually on the slab has an `at` — the rest are queued
    if (u.ascension && u.ascension.at !== undefined && u.hp > 0 && state.time >= u.ascension.at) {
      const to = u.ascension.to, b = findEntity(u.ascension.bld);
      const nt = UNIT_TYPES[to];
      if (b && b.rites) b.rites = b.rites.filter(id => id !== u.id);
      u.type = to;
      u.maxHp = nt.hp; u.hp = nt.hp;
      u.garrisoned = false;
      if (b) { u.x = b.x + (simRandom() - 0.5) * 20; u.y = b.y + b.h / 2 + 16; }
      u.order = { type: 'idle' };
      u.bornT = state.time;
      delete u.ascension;
      delete u.volQ; delete u.volT; // the new body starts its fire cycle fresh
      Particles.pulse(u.x, u.y, 30, [125, 255, 214]);
      if (u.owner === localOwner) eva(RITE_DONE[to] || 'The rite is complete');
    }
  }
  state.armorWrecks = state.armorWrecks.filter(w => w.until > state.time);
  updateCharges();
  updateReveals();
  state.floats = state.floats.filter(f => state.time - f.t < 1.6);
  for (const owner of OWNERS) {
    // structure income: zero-point cores etc. pay out every 10 seconds
    state.eco[owner] += dt;
    if (state.eco[owner] >= 10) {
      state.eco[owner] -= 10;
      let income = 0;
      const nth = {};   // how many of each diminishing type have paid out already
      for (const b of state.buildings) {
        if (b.owner !== owner || b.hp <= 0 || !b.done) continue;
        const bt = bstatsOf(b);
        if (!bt.income) continue;
        // `needsReq`: wired into its prerequisite rather than merely unlocked by
        // it. A Data Center with no Black Site Lab standing is a dark room.
        if (bt.needsReq && bt.req && !hasStruct(owner, bt.req)) continue;
        // `diminish`: each one after the first pays that fraction of the last.
        // state.buildings order is itself simulation state and identical on
        // every client, so "which one is the third" needs no sorting.
        if (bt.diminish) {
          const i = nth[b.type] = (nth[b.type] || 0) + 1;
          income += bt.income * Math.pow(bt.diminish, i - 1);
        } else income += bt.income;
      }
      if (bcastAgainst(owner, 'sponsors')) income *= BROADCASTS.sponsors.mul;
      income = Math.round(income);
      // the homestead payroll rides the same 10s beat as every other structure
      // income, so there is one rhythm to the economy and one place to read it
      income += Math.round(homesteadIncome(owner) * 10);
      if (income) state.minerals[owner] += income;
    }
    const sig = state.sig[owner];
    sig.cd = Math.max(0, sig.cd - dt);
    const fkey = state.factions[owner];
    sig.timer += dt;
    if (fkey === 'glob' && sig.timer >= 10) {
      // Quantitative Easing: the printer follows the ECONOMY — income scales
      // with power actually drawn, so there's no incentive to spam idle plants.
      // CAPPED (see QE_CAP): uncapped it repaid every structure you raised,
      // which made a surviving Globalist unbeatable rather than merely rich.
      sig.timer -= 10;
      state.minerals[owner] += Math.min(QE_CAP, Math.round(powerOf(owner).used * QE_RATE));
    } else if (fkey === 'flat') {
      tickResearch(owner, dt);
    } else if (fkey === 'resistance' && sig.timer >= 120) {
      sig.timer -= 120;
      spawnSmuggler(owner);
    } else if (fkey === 'deep' && sig.timer >= 75) {
      sig.timer -= 75;
      recruitSleeper(owner);
    }
    // AIs cast their manual powers on simple rules (throttled so the cluster
    // scans don't run every frame)
    if (!isHuman(owner)) {
      sig.tryT = (sig.tryT || 0) - dt;
      if (sig.tryT <= 0) {
        sig.tryT = 2;
        if (fkey === 'deep' && sig.cd <= 0) castGaslight(owner);
        // ASSETS: an AI handler wakes a sleeper when it is standing INSIDE a
        // fight — surrounded by its nominal allies with the handler's own
        // troops in reach. Turning it in an empty field would waste it.
        if (fkey === 'deep') {
          for (const a of sleeperEyes(owner)) {
            const friendsOfTheirs = state.units.reduce((n, e) => n +
              (e.hp > 0 && e.owner === a.owner && e !== a && dist(e, a) < 170 ? 1 : 0), 0);
            const mineNear = state.units.some(e => e.hp > 0 && e.owner === owner && dist(e, a) < 420);
            if (friendsOfTheirs >= 2 && mineNear) { wakeSleeper(a); break; }
          }
        }
        else if (fkey === 'reptilian' && !sig.used && ais[owner].time > 240) castRevealInfiltrator(owner);
        else if (fkey === 'glob' && sig.cd <= 0) {
          // rain on the densest enemy GROUND cluster to blunt an attack/defense
          let best = null, bestN = 0;
          for (const e of state.units) {
            if (e.owner === owner || e.owner === NEUTRAL || e.hp <= 0 || UNIT_TYPES[e.type].flying || hiddenFrom(e, owner)) continue;
            let n = 0;
            for (const o of state.units) if (o.owner !== owner && o.owner !== NEUTRAL && o.hp > 0 && !UNIT_TYPES[o.type].flying && dist(e, o) <= 150) n++;
            if (n > bestN) { bestN = n; best = e; }
          }
          if (best && bestN >= 2) castWeather(owner, best.x, best.y);
        } else if (fkey === 'grey' && sig.cd <= 0) {
          // clone the AI's most valuable INFANTRY — the vats only take
          // barracks-built bodies, so no free motherships
          let best = null, bestCost = 0;
          for (const u of state.units) {
            if (u.owner !== owner || u.hp <= 0 || UNIT_TYPES[u.type].role !== 'combat' || u.garrisoned ||
                UNIT_TYPES[u.type].builtAt !== 'barracks') continue;
            const c = UNIT_TYPES[u.type].cost || 0;
            if (c > bestCost) { bestCost = c; best = u; }
          }
          if (best && bestCost >= 90) castClone(owner, best);
        } else if (fkey === 'hollow' && sig.cd <= 0) {
          // Vril Recall as a RESCUE: yank a beaten squad out of a fight it is
          // losing, before the bodies are lost. A candidate has to be all three
          // of hurt, deep in hostile ground (too far to walk home), and
          // actually under threat right now — a wounded unit trudging home on
          // its own is not an emergency.
          const S = FACTIONS.hollow.powers.sig;
          const hq = state.buildings.find(b => b.owner === owner && b.type === 'hq' && b.hp > 0);
          // what a body is worth saving: the ascension ladder means a Guard is
          // six servitors and a Dreadnought is three Guards, and a Priest is
          // the only thing that can bank a relic
          const worth = u => u.type === 'dreadnought' ? 6
            : (u.type === 'lanternguard' || UNIT_TYPES[u.type].priest) ? 3 : 1;
          const hurt = hq ? state.units.filter(u => u.owner === owner && u.hp > 0 && !u.garrisoned &&
            !u.transit && UNIT_TYPES[u.type].role === 'combat' && u.hp < u.maxHp * 0.45 &&
            dist(u, hq) > 700 &&
            state.units.some(e => e.owner !== owner && e.owner !== NEUTRAL && e.hp > 0 &&
              UNIT_TYPES[e.type].dmg && !hiddenFrom(e, owner) && dist(e, u) <= 300)) : [];
          // centre the circle on whichever casualty has the most company —
          // recallTargets() then decides who actually fits inside it
          let best = null, bestScore = 0;
          for (const u of hurt) {
            const score = hurt.reduce((k, o) => k + (dist(u, o) <= S.r ? worth(o) : 0), 0);
            if (score > bestScore) { bestScore = score; best = u; }
          }
          // 3 is the floor: three servitors, one Lantern Guard or one Tech
          // Priest. Anything less isn't worth a 90-second cooldown.
          if (best && bestScore >= 3) castRecall(owner, best.x, best.y);
        }
      }
    }
  }
}

// hollow-earth tunnel network: which structures act as entrances, and how
// fast units travel underground (world px/s — quicker than walking, not free)
// the tunnel network is RETIRED (the Hollow rework dropped all burrowing);
// an empty node list dead-ends every tunnel code path without ripping it out
const TUNNEL_NODES = [];
const TUNNEL_SPEED = 220;

// units in transit ride outside the normal update loop: they surface at the
// destination when their timer runs out, and die if either end of the tunnel
// is destroyed while they're down there
function updateTransits() {
  for (const u of state.units) {
    if (!u.transit || u.hp <= 0) continue;
    const src = state.buildings.find(b => b.id === u.transit.srcId && b.hp > 0);
    const dest = state.buildings.find(b => b.id === u.transit.destId && b.hp > 0);
    if (!src || !dest) { u.hp = 0; continue; } // the tunnel caved in on them
    if (state.time >= u.transit.arrive) {
      u.garrisoned = null;
      u.x = clamp(dest.x + Math.sin(u.id * 2.7) * (dest.w / 2 + 16), 10, WORLD_W - 10);
      u.y = clamp(dest.y + dest.h / 2 + 16 + (u.id % 3) * 9, 10, WORLD_H - 10);
      delete u.transit;
      u.order = { type: 'idle' };
      Particles.smoke(u.x, u.y, 3);
    }
  }
}

// burrow stance: toggle the selected hollow units under/above ground.
// Surfacing arms a one-shot ambush bonus; heavy drillers crack the ground.
// sim side of the burrow toggle: takes the units, not the selection
function burrowUnits(units) {
  let any = false;
  for (const u of units) {
    if (u.transit) continue;
    if (!UNIT_TYPES[u.type].burrow) continue;
    any = true;
    if (u.burrowed) {
      u.burrowed = false;
      u.ambush = true; // first strike after surfacing hits double
      const ea = UNIT_TYPES[u.type].emergeAoE;
      if (ea) {
        splashDamage(u.x, u.y, ea.r, ea.dmg, u.owner, { bldgBonus: 1.5 });
        Particles.boom(u.x, u.y, 1.2);
        if (tileState(u.x, u.y) === 2) sfx('boom');
      }
    } else {
      u.burrowed = true;
    }
  }
  if (any) sfx('click');
}

// tip every rider out of a transport in a ring around it
function unloadTransport(v) {
  if (!v.cargo || !v.cargo.length) return;
  v.cargo.forEach((id, i) => {
    const p = findEntity(id);
    if (!p || p.hp <= 0) return;
    p.garrisoned = false; p.transportId = null;
    const a = i / v.cargo.length * Math.PI * 2;
    p.x = v.x + Math.cos(a) * (UNIT_TYPES[v.type].r + 10);
    p.y = v.y + Math.sin(a) * (UNIT_TYPES[v.type].r + 10);
    p.order = { type: 'idle' };
  });
  v.cargo = [];
}

function orderMove(u, x, y) { u.order = { type: 'move', x, y }; }

function orderAttack(u, target) { u.order = { type: 'attack', targetId: target.id }; }

function orderAttackMove(u, x, y) { u.order = { type: 'attackmove', x, y }; }

function orderHarvest(u, patch) { u.order = { type: 'harvest', patchId: patch.id }; u.mineTimer = 0; }

function findEntity(id) {
  return state.units.find(u => u.id === id) || state.buildings.find(b => b.id === id);
}

// does the segment (x1,y1)-(x2,y2) pass through the axis-aligned box at
// (cx,cy) with half-extents ex/ey? (slab test)
function segHitsRect(x1, y1, x2, y2, cx, cy, ex, ey) {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  for (const [p, d, e] of [[x1 - cx, dx, ex], [y1 - cy, dy, ey]]) {
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(p) > e) return false;
      continue;
    }
    let ta = (-e - p) / d, tb = (e - p) / d;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

// ============================================================
// pathfinding: a coarse passability grid over static obstacles (water,
// rock, buildings) + A* with line-of-sight smoothing. moveToward() steers
// for the next waypoint; the existing local avoidance handles the rest.
// Spatial indexes over TERRAIN and buildings also serve the per-frame
// collision scans that used to walk every obstacle on the map.
// ============================================================

const PATH_CELL = 24;
const OB_CELL = 240;
let pgW = 0, pgH = 0;
let pgPass = new Uint8Array(0);
let pfG, pfF, pfFrom, pfVer, pfClosed;
let pfVersion = 0;
const pfHeap = [];
let pathDirty = true;
let pathEpoch = 0;
let pathBudget = 0;
let terrainIndex = new Map();
let bldIndex = new Map();
const EMPTY_ARR = [];

function markPathDirty() { pathDirty = true; }

// does this structure physically stop that owner's ground units? Mines are
// buried (stop nothing); a gate opens for its owner and shuts on everyone else
function blocksUnit(b, owner) {
  const bt = bstatsOf(b);
  if (bt.noBlock) return false;
  if (bt.gate && b.owner === owner) return false;
  return true;
}

// A wall flanking one of a unit's OWN open gates yields to that unit. Wall
// segments sit one WALL_STEP apart, so the collision radii of the two walls
// beside a gate meet across the opening and seal it — this carves the corridor
// back open, but only for the gate's owner (enemies still hit the walls).
function wallByOpenGate(wall, u) {
  if (wall.type !== 'wall') return false;
  for (const g of bldNear(wall.x, wall.y)) {
    if (g.type !== 'gate' || g.hp <= 0 || g.owner !== u.owner) continue;
    if (Math.abs(g.x - wall.x) <= WALL_STEP * 1.2 && Math.abs(g.y - wall.y) <= WALL_STEP * 1.2 &&
        Math.hypot(u.x - g.x, u.y - g.y) <= WALL_STEP * 1.7) return true;
  }
  return false;
}

function terrainNear(x, y) {
  return terrainIndex.get(((x / OB_CELL) | 0) * 8192 + ((y / OB_CELL) | 0)) || EMPTY_ARR;
}
function bldNear(x, y) {
  return bldIndex.get(((x / OB_CELL) | 0) * 8192 + ((y / OB_CELL) | 0)) || EMPTY_ARR;
}

// which cardinal neighbours a wall/gate connects to (bitmask e=1,w=2,n=4,s=8),
// so wall art can draw a continuous rampart instead of stray blocks
function wallConn(b) {
  let m = 0;
  const S = WALL_STEP, TOL = 15;
  for (const o of bldNear(b.x, b.y)) {
    if (o === b || o.hp <= 0 || o.owner !== b.owner) continue;
    if (o.type !== 'wall' && o.type !== 'gate') continue;
    const dx = o.x - b.x, dy = o.y - b.y;
    if (Math.abs(dy) < TOL && dx > S - TOL && dx < S + TOL) m |= 1;        // E (+x)
    else if (Math.abs(dy) < TOL && -dx > S - TOL && -dx < S + TOL) m |= 2; // W (-x)
    else if (Math.abs(dx) < TOL && -dy > S - TOL && -dy < S + TOL) m |= 4; // N (-y)
    else if (Math.abs(dx) < TOL && dy > S - TOL && dy < S + TOL) m |= 8;   // S (+y)
  }
  return m;
}

function ensurePathGrid() {
  if (!pathDirty) return;
  pathDirty = false;
  pathEpoch++;
  // coarse obstacle indexes (entries repeated into every cell they touch)
  terrainIndex = new Map();
  for (const o of TERRAIN) {
    const m = o.r + 60;
    for (let gy = ((o.y - m) / OB_CELL) | 0; gy <= ((o.y + m) / OB_CELL) | 0; gy++) {
      for (let gx = ((o.x - m) / OB_CELL) | 0; gx <= ((o.x + m) / OB_CELL) | 0; gx++) {
        const k = gx * 8192 + gy;
        let a = terrainIndex.get(k);
        if (!a) terrainIndex.set(k, a = []);
        a.push(o);
      }
    }
  }
  bldIndex = new Map();
  for (const b of state.buildings) {
    if (b.hp <= 0) continue;
    const mx = b.w / 2 + 60, my = b.h / 2 + 60;
    for (let gy = ((b.y - my) / OB_CELL) | 0; gy <= ((b.y + my) / OB_CELL) | 0; gy++) {
      for (let gx = ((b.x - mx) / OB_CELL) | 0; gx <= ((b.x + mx) / OB_CELL) | 0; gx++) {
        const k = gx * 8192 + gy;
        let a = bldIndex.get(k);
        if (!a) bldIndex.set(k, a = []);
        a.push(b);
      }
    }
  }
  // passability grid
  pgW = Math.ceil(WORLD_W / PATH_CELL);
  pgH = Math.ceil(WORLD_H / PATH_CELL);
  const n = pgW * pgH;
  if (pgPass.length !== n) {
    pgPass = new Uint8Array(n);
    pfG = new Float64Array(n);
    pfF = new Float64Array(n);
    pfFrom = new Int32Array(n);
    pfVer = new Int32Array(n);
    pfClosed = new Int32Array(n);
    pfVersion = 0;
  }
  pgPass.fill(1);
  const CL = 12; // clearance for the fattest ground unit
  for (const o of TERRAIN) {
    if (TERRAIN_TYPES[o.type].passes) continue;
    const rr2 = o.r + CL;
    const x0 = Math.max(0, ((o.x - rr2) / PATH_CELL) | 0), x1 = Math.min(pgW - 1, ((o.x + rr2) / PATH_CELL) | 0);
    const y0 = Math.max(0, ((o.y - rr2) / PATH_CELL) | 0), y1 = Math.min(pgH - 1, ((o.y + rr2) / PATH_CELL) | 0);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cx2 = gx * PATH_CELL + PATH_CELL / 2, cy2 = gy * PATH_CELL + PATH_CELL / 2;
        if ((cx2 - o.x) ** 2 + (cy2 - o.y) ** 2 < rr2 * rr2) pgPass[gy * pgW + gx] = 0;
      }
    }
  }
  for (const b of state.buildings) {
    if (b.hp <= 0) continue;
    // gates stay open on the shared grid (per-owner passability lives in the
    // local collision check); buried mines never block anything
    const gbt = bstatsOf(b);
    if (gbt.gate || gbt.noBlock) continue;
    const ex = b.w / 2 + 10, ey = b.h / 2 + 10;
    const x0 = Math.max(0, ((b.x - ex) / PATH_CELL) | 0), x1 = Math.min(pgW - 1, ((b.x + ex) / PATH_CELL) | 0);
    const y0 = Math.max(0, ((b.y - ey) / PATH_CELL) | 0), y1 = Math.min(pgH - 1, ((b.y + ey) / PATH_CELL) | 0);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cx2 = gx * PATH_CELL + PATH_CELL / 2, cy2 = gy * PATH_CELL + PATH_CELL / 2;
        if (Math.abs(cx2 - b.x) < ex && Math.abs(cy2 - b.y) < ey) pgPass[gy * pgW + gx] = 0;
      }
    }
  }
  // gates punch a passable corridor through the wall line so A* actually routes
  // units THROUGH them — the flanking walls' expansion otherwise pinches the
  // lone gate cell too narrow to find, and paths detour around the whole wall.
  // Clear across the passage axis (perpendicular to the wall run).
  for (const b of state.buildings) {
    if (b.hp <= 0 || !bstatsOf(b).gate) continue;
    const c = wallConn(b);                       // e=1,w=2,n=4,s=8
    const wallEW = (c & 1) || (c & 2);           // walls run E-W -> passage is N-S
    for (let s = -PATH_CELL; s <= PATH_CELL; s += PATH_CELL) {
      const px = (c && !wallEW) ? b.x + s : b.x; // vary along the passage
      const py = (c && !wallEW) ? b.y : b.y + s;
      pgPass[clamp((py / PATH_CELL) | 0, 0, pgH - 1) * pgW + clamp((px / PATH_CELL) | 0, 0, pgW - 1)] = 1;
    }
  }
}

function cellIdxAt(x, y) {
  const gx = clamp((x / PATH_CELL) | 0, 0, pgW - 1);
  const gy = clamp((y / PATH_CELL) | 0, 0, pgH - 1);
  return gy * pgW + gx;
}

// nearest walkable cell to a point (goals often sit ON a building or shore)
function freeCellNear(x, y) {
  const c = cellIdxAt(x, y);
  if (pgPass[c]) return c;
  const gx0 = c % pgW, gy0 = (c / pgW) | 0;
  for (let r = 1; r <= 9; r++) {
    for (let gy = gy0 - r; gy <= gy0 + r; gy++) {
      if (gy < 0 || gy >= pgH) continue;
      for (let gx = gx0 - r; gx <= gx0 + r; gx++) {
        if (gx < 0 || gx >= pgW) continue;
        if (Math.max(Math.abs(gx - gx0), Math.abs(gy - gy0)) !== r) continue;
        if (pgPass[gy * pgW + gx]) return gy * pgW + gx;
      }
    }
  }
  return -1;
}

function heapPush(i) {
  pfHeap.push(i);
  let c = pfHeap.length - 1;
  while (c > 0) {
    const p = (c - 1) >> 1;
    if (pfF[pfHeap[p]] <= pfF[pfHeap[c]]) break;
    const tmp = pfHeap[p]; pfHeap[p] = pfHeap[c]; pfHeap[c] = tmp;
    c = p;
  }
}
function heapPop() {
  const top = pfHeap[0];
  const last = pfHeap.pop();
  if (pfHeap.length) {
    pfHeap[0] = last;
    let c = 0;
    for (;;) {
      let s = c;
      const l = c * 2 + 1, r = l + 1;
      if (l < pfHeap.length && pfF[pfHeap[l]] < pfF[pfHeap[s]]) s = l;
      if (r < pfHeap.length && pfF[pfHeap[r]] < pfF[pfHeap[s]]) s = r;
      if (s === c) break;
      const tmp = pfHeap[s]; pfHeap[s] = pfHeap[c]; pfHeap[c] = tmp;
      c = s;
    }
  }
  return top;
}

// is the straight world-space segment fully walkable on the grid?
function losClear(x0, y0, x1, y1) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (PATH_CELL * 0.5));
  for (let i = 1; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
    if (!pgPass[cellIdxAt(x, y)]) return false;
  }
  return true;
}

const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// A* from (sx,sy) to (tx,ty); returns smoothed world waypoints or null
function astar(sx, sy, tx, ty) {
  ensurePathGrid();
  const goal = freeCellNear(tx, ty);
  if (goal < 0) return null;
  const start = cellIdxAt(sx, sy); // start may sit in a blocked cell: escape allowed
  if (start === goal) return [];
  pfVersion++;
  pfHeap.length = 0;
  pfG[start] = 0;
  pfF[start] = 0;
  pfFrom[start] = -1;
  pfVer[start] = pfVersion;
  heapPush(start);
  const gxT = goal % pgW, gyT = (goal / pgW) | 0;
  let expansions = 0;
  while (pfHeap.length) {
    const cur = heapPop();
    if (pfClosed[cur] === pfVersion) continue;
    pfClosed[cur] = pfVersion;
    if (cur === goal) {
      // reconstruct cell path, then line-of-sight smooth it
      const pts = [];
      for (let i = cur; i >= 0; i = pfFrom[i]) {
        pts.push({ x: (i % pgW) * PATH_CELL + PATH_CELL / 2, y: ((i / pgW) | 0) * PATH_CELL + PATH_CELL / 2 });
      }
      pts.reverse();
      const smooth = [];
      let ax = sx, ay = sy, k = 0;
      while (k < pts.length) {
        let j = Math.min(pts.length - 1, k + 40);
        for (; j > k; j--) {
          if (losClear(ax, ay, pts[j].x, pts[j].y)) break;
        }
        smooth.push(pts[j]);
        ax = pts[j].x; ay = pts[j].y;
        k = j + 1;
      }
      return smooth;
    }
    if (++expansions > 9000) return null;
    const gx = cur % pgW, gy = (cur / pgW) | 0;
    for (let di = 0; di < 8; di++) {
      const dx = DIRS8[di][0], dy = DIRS8[di][1];
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= pgW || ny >= pgH) continue;
      const ni = ny * pgW + nx;
      if (!pgPass[ni]) continue;
      // no cutting corners diagonally past a blocked cell
      if (dx && dy && (!pgPass[gy * pgW + nx] || !pgPass[ny * pgW + gx])) continue;
      const ng = pfG[cur] + (dx && dy ? 1.4142 : 1);
      if (pfVer[ni] === pfVersion && ng >= pfG[ni]) continue;
      pfVer[ni] = pfVersion;
      pfG[ni] = ng;
      pfFrom[ni] = cur;
      const ddx = Math.abs(nx - gxT), ddy = Math.abs(ny - gyT);
      pfF[ni] = ng + Math.max(ddx, ddy) + 0.4142 * Math.min(ddx, ddy);
      heapPush(ni);
    }
  }
  return null;
}

// the unit's current steering point for target (tx,ty): manages its cached
// path, advances waypoints, and re-plans when the target or world changed.
// Returns null to steer straight (final leg, failed path, or over budget).
function pathPoint(u, tx, ty) {
  ensurePathGrid();
  let p = u.path;
  if (!p || p.epoch !== pathEpoch || Math.hypot(p.tx - tx, p.ty - ty) > 56) {
    if (u.pathWait && u.pathWait > state.time) return null; // budget backoff
    if (pathBudget <= 0) { u.pathWait = state.time + 0.35; return null; }
    pathBudget--;
    const pts = astar(u.x, u.y, tx, ty);
    u.path = p = { tx, ty, pts, i: 0, epoch: pathEpoch };
    u.pathWait = 0;
  }
  if (!p.pts) return null; // unreachable / failed: straight steering
  while (p.i < p.pts.length && Math.hypot(p.pts[p.i].x - u.x, p.pts[p.i].y - u.y) < PATH_CELL) p.i++;
  return p.i < p.pts.length ? p.pts[p.i] : null;
}

function moveToward(u, tx, ty, dt, stopDist = 2, ignoreId = null) {
  const d = Math.hypot(tx - u.x, ty - u.y);
  if (d <= stopDist) return true;
  // a planted siege engine must pack its drill before it can roll
  if (u.deployed) {
    u.deployed = false;
    u.deployingUntil = state.time + 1.2;
    Particles.pulse(u.x, u.y, 24, [150, 128, 96]); // the drill wrenches free
    return false;
  }
  if (u.deployingUntil > state.time && UNIT_TYPES[u.type].deployable) return false;
  u.wdWant = true; // actively trying to move — eligible for the wedge-breaker
  const t = UNIT_TYPES[u.type];
  // grid path: steer for the next waypoint instead of beelining into lakes
  // and base walls (arrival is still measured against the true target)
  let sx2 = tx, sy2 = ty;
  if (!t.flying && d > PATH_CELL * 1.5) {
    const wp = pathPoint(u, tx, ty);
    if (wp) { sx2 = wp.x; sy2 = wp.y; }
  }
  let speed = t.speed;
  // a Lantern Guard sprinting in behind its own barrage (see updateVolley)
  if (u.chargeUntil > state.time) speed *= 1.5;
  // a relentless bruiser builds momentum once it has something marked
  if (t.relentless && u.order.type === 'attack') speed *= t.relentless;
  // rain/storm/tremor zones slow ground units; a tractor beam slows anything it holds
  if (!t.flying) {
    for (const z of state.zones) {
      if ((z.kind === 'rain' || z.kind === 'storm' || z.kind === 'tremor') && z.caster !== u.owner && dist(z, u) <= z.r) { speed *= 0.6; break; }
    }
    // pushing through a forest is slow going
    for (const o of terrainNear(u.x, u.y)) {
      if (TERRAIN_TYPES[o.type].passes && dist(o, u) <= o.r) { speed *= TERRAIN_TYPES[o.type].slow; break; }
    }
  }
  if (u.slowUntil && u.slowUntil > state.time) speed *= 0.55;
  if (u.burrowed) speed *= 0.5; // clawing through bedrock
  const sd = Math.hypot(sx2 - u.x, sy2 - u.y) || 1;
  const step = Math.min(speed * dt, d);
  let nx = u.x + (sx2 - u.x) / sd * step;
  let ny = u.y + (sy2 - u.y) / sd * step;

  // committed building detour: keep heading for the chosen corner even on
  // frames where the direct step wouldn't collide, or the unit flip-flops
  // between corner-seeking and target-seeking at the footprint's rim
  if (!t.flying && u.dodge) {
    if (Math.abs(u.dodge.tx - sx2) > 40 || Math.abs(u.dodge.ty - sy2) > 40 ||
        !state.buildings.some(b => b.id === u.dodge.bld && b.hp > 0)) {
      delete u.dodge; // destination changed or building died: re-plan
    } else {
      const dd = Math.hypot(u.dodge.x - u.x, u.dodge.y - u.y);
      // arrival must be at least a body-radius wide: with a one-step window a
      // crowd of units contesting the same corner shove each other off the
      // exact point forever and the dodge never clears (harvester gridlock)
      if (dd <= Math.max(step, t.r)) {
        delete u.dodge; // corner rounded; aim at the target again
      } else {
        nx = u.x + (u.dodge.x - u.x) / dd * step;
        ny = u.y + (u.dodge.y - u.y) / dd * step;
      }
    }
  }

  // ground units steer around impassable terrain and buildings (air flies
  // over, forests let you through); ignoreId skips the building being walked to
  if (!t.flying) {
    const hits = (x, y) => {
      for (const o of terrainNear(x, y)) {
        if (!TERRAIN_TYPES[o.type].passes && Math.hypot(x - o.x, y - o.y) < o.r + t.r) return true;
      }
      return false;
    };
    let ob = null;
    for (const o of terrainNear(nx, ny)) {
      if (!TERRAIN_TYPES[o.type].passes && Math.hypot(nx - o.x, ny - o.y) < o.r + t.r) { ob = o; break; }
    }
    if (ob) {
      // destination sits inside the obstacle and we're touching it: close enough
      if (Math.hypot(tx - ob.x, ty - ob.y) < ob.r + t.r &&
          Math.hypot(u.x - ob.x, u.y - ob.y) < ob.r + t.r + 6) { delete u.veer; return true; }
      const away = Math.atan2(u.y - ob.y, u.x - ob.x);
      const desired = Math.atan2(sy2 - u.y, sx2 - u.x);
      const diff = a => Math.abs(((a - desired + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      // commit to one side of this rock: when the target sits straight behind it
      // the two ways around score nearly equal, and re-picking every frame left
      // units grinding in place against the rim
      if (!u.veer || u.veer.ob !== ob.seed || Math.abs(u.veer.tx - sx2) > 40 || Math.abs(u.veer.ty - sy2) > 40) {
        u.veer = { ob: ob.seed, side: diff(away + Math.PI / 2) < diff(away - Math.PI / 2) ? 1 : -1, tx: sx2, ty: sy2 };
      }
      const slide = side => {
        const tang = away + side * Math.PI / 2;
        let sx = u.x + Math.cos(tang) * step, sy = u.y + Math.sin(tang) * step;
        if (Math.hypot(sx - ob.x, sy - ob.y) < ob.r + t.r) {
          sx = ob.x + Math.cos(away) * (ob.r + t.r + 1);
          sy = ob.y + Math.sin(away) * (ob.r + t.r + 1);
        }
        return [sx, sy];
      };
      [nx, ny] = slide(u.veer.side);
      // that lane runs into a second rock: flip once and round the other way
      if (hits(nx, ny)) {
        u.veer.side *= -1;
        [nx, ny] = slide(u.veer.side);
        if (hits(nx, ny)) { nx = u.x; ny = u.y; } // wedged between rocks; hold
      }
    } else {
      delete u.veer;
      let bld = null;
      for (const b of bldNear(nx, ny)) {
        if (b.hp > 0 && b.id !== ignoreId && blocksUnit(b, u.owner) && !wallByOpenGate(b, u) &&
            Math.abs(nx - b.x) < b.w / 2 + t.r && Math.abs(ny - b.y) < b.h / 2 + t.r) { bld = b; break; }
      }
      if (bld) {
        const ex = bld.w / 2 + t.r, ey = bld.h / 2 + t.r;
        // destination inside this building and we're already hugging it: arrived
        if (Math.abs(tx - bld.x) < ex && Math.abs(ty - bld.y) < ey &&
            Math.abs(u.x - bld.x) < ex + 8 && Math.abs(u.y - bld.y) < ey + 8) {
          delete u.dodge;
          return true;
        }
        // commit to rounding one corner of the expanded footprint: the one with
        // the shortest unit -> corner -> destination path (re-chosen only when
        // the building or destination changes, so we can't jitter between sides)
        if (!u.dodge || u.dodge.bld !== bld.id ||
            Math.abs(u.dodge.tx - sx2) > 40 || Math.abs(u.dodge.ty - sy2) > 40) {
          // a corner we can't reach in a straight line is no corner at all
          // (unless we're stuck inside — then any exit goes); a corner whose
          // ONWARD leg crosses just means another corner gets rounded after it,
          // so that only costs a mild penalty
          const cross = (x1, y1, x2, y2) => segHitsRect(x1, y1, x2, y2, bld.x, bld.y, ex - 2, ey - 2);
          // a corner buried inside a NEIGHBORING building (tight tower rows,
          // city blocks) is unreachable — steer for a free corner instead
          const buried = c => {
            for (const b2 of bldNear(c.x, c.y)) {
              if (b2.hp > 0 && b2.id !== bld.id && b2.id !== ignoreId && blocksUnit(b2, u.owner) &&
                  Math.abs(c.x - b2.x) < b2.w / 2 + t.r + 2 &&
                  Math.abs(c.y - b2.y) < b2.h / 2 + t.r + 2) return true;
            }
            return false;
          };
          let best = null, bestCost = Infinity;
          for (const csx of [-1, 1]) {
            for (const csy of [-1, 1]) {
              const c = { x: bld.x + csx * (ex + 8), y: bld.y + csy * (ey + 8) };
              const cost = Math.hypot(c.x - u.x, c.y - u.y) + Math.hypot(sx2 - c.x, sy2 - c.y)
                + (cross(u.x, u.y, c.x, c.y) ? 1e5 : 0)
                + (buried(c) ? 5e4 : 0)
                + (cross(c.x, c.y, sx2, sy2) ? (ex + ey) * 2 : 0);
              if (cost < bestCost) { bestCost = cost; best = c; }
            }
          }
          u.dodge = { bld: bld.id, x: best.x, y: best.y, tx: sx2, ty: sy2 };
        }
        const dd = Math.hypot(u.dodge.x - u.x, u.dodge.y - u.y);
        nx = u.x + (u.dodge.x - u.x) / (dd || 1) * Math.min(step, dd);
        ny = u.y + (u.dodge.y - u.y) / (dd || 1) * Math.min(step, dd);
        if (dd <= Math.max(step, t.r)) delete u.dodge; // corner rounded (body-radius window; see above)
        // never step from outside into the footprint (walking OUT is allowed,
        // for units that get built over or shoved inside)
        const wasInside = Math.abs(u.x - bld.x) < ex - 1 && Math.abs(u.y - bld.y) < ey - 1;
        if (!wasInside && Math.abs(nx - bld.x) < ex - 1 && Math.abs(ny - bld.y) < ey - 1) {
          nx = u.x;
          ny = u.y;
        }
      }
    }
  }
  // ground vehicles drive like vehicles: they only ever move FORWARD along the
  // hull heading (never strafe sideways), swinging the nose toward the steering
  // direction at a limited turn rate and easing off the throttle while the turn
  // is still wide — so they arc toward the target and pivot in place to reverse,
  // always moving the way they point. Infantry keep the instant facing snap.
  const isVeh = t.shape === 'square' && !t.flying;
  if (isVeh) {
    const mdx0 = nx - u.x, mdy0 = ny - u.y;
    const stepLen = Math.hypot(mdx0, mdy0);
    if (stepLen > 0.01) {
      const want = Math.atan2(mdy0, mdx0);
      if (u.facing === undefined) u.facing = want;
      const df = ((want - u.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const turn = (t.turnRate || 3.6) * dt;
      u.facing += clamp(df, -turn, turn);
      // forward throttle: full when lined up, ~0 while broadside or reversing
      const drive = stepLen * Math.max(0, Math.cos(df));
      u.x = clamp(u.x + Math.cos(u.facing) * drive, 10, WORLD_W - 10);
      u.y = clamp(u.y + Math.sin(u.facing) * drive, 10, WORLD_H - 10);
      u.travel += drive;
      u.movedT = state.time; // maneuvering breaks the hold-still cloak
    }
    return false;
  }
  const px = u.x, py = u.y;
  u.x = clamp(nx, 10, WORLD_W - 10);
  u.y = clamp(ny, 10, WORLD_H - 10);
  const mdx = u.x - px, mdy = u.y - py;
  if (Math.abs(mdx) > 0.01 || Math.abs(mdy) > 0.01) {
    u.facing = Math.atan2(mdy, mdx);
    u.travel += Math.hypot(mdx, mdy);
    u.movedT = state.time; // moving breaks the hold-still cloak
  }
  return false;
}

// fixed-wing flight: planes never hover — they keep airspeed and steer by
// turning their heading toward the target at a limited rate, so they carve
// arcs, overshoot strafing runs, and naturally circle whatever they chase.
// Returns true once within `arrive` of the point.
function flyToward(u, tx, ty, dt, arrive = 24, approach = false) {
  const t = UNIT_TYPES[u.type];
  let speed = t.speed;
  if (u.slowUntil && u.slowUntil > state.time) speed *= 0.55;
  // landing approach: bleed airspeed near the field so the turn radius
  // (speed / turn rate) shrinks below the arrive window — otherwise fast
  // jets orbit their own pad forever, unable to hit the slot
  if (approach) speed *= clamp(Math.hypot(tx - u.x, ty - u.y) / 120, 0.2, 1);
  const want = Math.atan2(ty - u.y, tx - u.x);
  const diff = ((want - u.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const maxTurn = (t.turn || 2.2) * dt;
  u.facing += clamp(diff, -maxTurn, maxTurn);
  u.x += Math.cos(u.facing) * speed * dt;
  u.y += Math.sin(u.facing) * speed * dt;
  // bank off the map edge instead of pinning against it
  if (u.x < 14) { u.x = 14; u.facing = Math.cos(u.facing) < 0 ? Math.PI - u.facing : u.facing; }
  if (u.x > WORLD_W - 14) { u.x = WORLD_W - 14; u.facing = Math.cos(u.facing) > 0 ? Math.PI - u.facing : u.facing; }
  if (u.y < 14) { u.y = 14; u.facing = Math.sin(u.facing) < 0 ? -u.facing : u.facing; }
  if (u.y > WORLD_H - 14) { u.y = WORLD_H - 14; u.facing = Math.sin(u.facing) > 0 ? -u.facing : u.facing; }
  u.travel += speed * dt;
  return Math.hypot(tx - u.x, ty - u.y) <= arrive;
}

// circle a point (combat air patrol / loitering pylon turn). The plane chases a
// lead point on the ring; turn-rate lag makes the real orbit ~1.5x the chased
// ring, so aim inside to make the flown circle come out near `radius`
function flyOrbit(u, cx, cy, dt, radius = 70) {
  const ang = Math.atan2(u.y - cy, u.x - cx) + 0.85;
  const r2 = radius * 0.65;
  flyToward(u, cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2, dt, 0);
}

function dealDamage(attacker, target, dmg, stats) {
  // capturable landmarks are objectives, not rubble: while NEUTRAL they shrug off
  // all damage — you claim them by garrisoning, not by blowing them up. Once
  // owned they're a normal building and can be destroyed (killing the garrison).
  if (target.kind === 'building' && target.owner === NEUTRAL) {
    const bt = bstatsOf(target);
    if (bt.slots && (bt.income || bt.healAura || bt.buffAura || bt.debuffAura || bt.detector || bt.power > 0 || bt.spawns || bt.convert || bt.airTech)) return;
  }
  // grey superior metallurgy: buildings ignore anti-building BONUSES —
  // a weapon that's simply bad against structures (bldgBonus < 1) is still
  // bad against theirs
  if (target.kind === 'building' && stats.bldgBonus &&
      (stats.bldgBonus <= 1 || state.factions[target.owner] !== 'grey')) {
    dmg *= stats.bldgBonus;
  }
  // shaped charges (RPGs) multiply against ground vehicles
  if (target.kind === 'unit' && stats.vehBonus && !UNIT_TYPES[target.type].flying &&
      UNIT_TYPES[target.type].builtAt === 'factory') {
    dmg *= stats.vehBonus;
  }
  // armored units (riot shields, tripod plating) shrug off part of everything
  if (target.kind === 'unit' && UNIT_TYPES[target.type].armor) {
    dmg *= 1 - UNIT_TYPES[target.type].armor;
  }
  // Grey target-painting: a probe-designated target takes extra damage from the
  // marking player's whole army until the mark lapses
  if (target.kind === 'unit' && attacker && target.designatedBy === attacker.owner && target.designatedUntil > state.time) {
    dmg *= 1.3;
  }
  // Grey Technician shielding: a hardened ally shrugs off part of the blow
  if (target.kind === 'unit' && target.hardenedUntil > state.time) dmg *= 0.72;
  // "Nukes Are Fake": the mushroom cloud was a film set, so it only half hurts
  if (stats.sup && target.owner !== undefined && disproved(target.owner, 'nukes')) dmg *= 0.5;
  target.hp -= dmg;
  // loosh harvest: book it once, on the lethal blow. A Reptilian killer reaps
  // loosh from any kill (more from enemy infantry); a Reptilian owner reaps it
  // from its OWN dying brood — atrocity and martyrdom both pay.
  if (target.kind === 'unit' && target.hp <= 0 && !target.looshBooked) {
    target.looshBooked = true;
    if (attacker && attacker.owner !== target.owner && isReptilian(attacker.owner)) {
      const tt = UNIT_TYPES[target.type];
      const infantry = tt.role === 'combat' && !tt.flying && tt.builtAt === 'barracks';
      grantLoosh(attacker.owner, infantry ? 6 : 3);
    }
    grantLoosh(target.owner, 2); // grantLoosh no-ops for non-Reptilian owners
  }
  // workers under fire run for home instead of stuttering at the patch —
  // unarmed miners bolt at the first hit, armed rigs stand their ground
  // until half health. They resume mining on their own once it's over.
  if (target.kind === 'unit' && target.hp > 0 && UNIT_TYPES[target.type].role === 'worker' &&
      !target.garrisoned && !target.transit && !(target.fleeUntil > state.time) &&
      (!UNIT_TYPES[target.type].dmg || target.hp < target.maxHp * 0.5)) {
    const home = nearest(target, state.buildings, b => b.owner === target.owner && b.hp > 0 && b.done &&
      (b.type === 'hq' || bstatsOf(b).dropoff));
    if (home) {
      target.fleeUntil = state.time + 5;
      target.resumeHarvest = true;
      target.order = { type: 'move', x: home.x, y: home.y + home.h / 2 + 30 };
    }
  }
  if (target.owner === localOwner) {
    const now = performance.now();
    if (now - lastUnderAttack > 20000) {
      lastUnderAttack = now;
      eva('Our base is under attack');
    }
  }
}

function splashDamage(cx, cy, radius, dmg, owner, stats, hitAir = false) {
  const pt = { x: cx, y: cy };
  for (const u of state.units) {
    if (u.owner === owner || u.hp <= 0 || u.garrisoned) continue;
    if (u.burrowed) continue; // safe under the blast
    if (!hitAir && UNIT_TYPES[u.type].flying) continue;
    const d = dist(u, pt);
    if (d <= radius + UNIT_TYPES[u.type].r) {
      dealDamage(null, u, dmg * (1 - 0.5 * Math.min(1, d / radius)), stats);
    }
  }
  for (const b of state.buildings) {
    if (b.owner === owner || b.hp <= 0) continue;
    const d = dist(b, pt);
    if (d <= radius + entityRadius(b)) {
      dealDamage(null, b, dmg * (1 - 0.5 * Math.min(1, d / radius)), stats);
    }
  }
}

const FIREWORK_COLORS = [[255, 90, 90], [255, 210, 90], [120, 220, 255], [180, 130, 255], [120, 255, 150], [255, 130, 220]];
function spawnProjectile(kind, x, y, tx, ty, owner, stats) {
  const d = Math.hypot(tx - x, ty - y);
  const p = {
    kind, sx: x, sy: y, x, y, tx, ty, owner, stats,
    t: 0, dur: kind === 'bomb' ? 0.55 : Math.max(0.35, d / 260),
    arc: kind === 'bomb' ? 26 : clamp(d * 0.18, 18, 55),
    angle: Math.atan2(ty - y, tx - x),
  };
  if (kind === 'firework') p.col = FIREWORK_COLORS[Math.floor(fxRandom() * FIREWORK_COLORS.length)];
  state.projectiles.push(p);
  return p;   // callers may tune the shot after the fact (see the carpet stick)
}

function updateProjectiles(dt) {
  for (const p of state.projectiles) {
    if (p.kind === 'missile') {
      // homing: track the target (unit OR building) until impact or dry tank
      p.life -= dt;
      const tgt = findEntity(p.targetId);
      if (!tgt || tgt.hp <= 0 || tgt.garrisoned || p.life <= 0) {
        p.done = true;
        Particles.boom(p.x, p.y, 0.35);
        continue;
      }
      p.angle = Math.atan2(tgt.y - p.y, tgt.x - p.x);
      const step = p.speed * dt;
      if (dist(p, tgt) <= step + entityRadius(tgt)) {
        p.done = true;
        // srcId keeps the kill attributed (loosh, leech-free)
        if (p.stats.dmg) dealDamage((p.srcId && findEntity(p.srcId)) || null, tgt, p.stats.dmg, p.stats);
        Particles.boom(tgt.x, tgt.y, p.stats.dmg ? 0.5 : 0.35);
        if (tileState(tgt.x, tgt.y) === 2) sfx('boom');
      } else {
        p.x += Math.cos(p.angle) * step;
        p.y += Math.sin(p.angle) * step;
        p.trail = (p.trail || 0) - dt;
        if (p.trail <= 0) { p.trail = 0.05; Particles.smoke(p.x, p.y, 1.6, p.alt !== undefined ? p.alt : FLY_H); }
      }
      continue;
    }
    if (p.kind === 'superrocket') {
      // heavy rocket arcing down onto its mark
      p.t += dt;
      const f = p.t / p.dur;
      p.hgt = Math.sin(Math.min(1, f) * Math.PI * 0.5 + Math.PI * 0.5) * 520 + 520 * (1 - f);
      p.hgt = (1 - f) * 620; // straightforward descent from altitude
      if (p.t >= p.dur) {
        p.done = true;
        splashDamage(p.tx, p.ty, p.stats.splash, p.stats.dmg, p.owner, p.stats, true);
        Particles.boom(p.tx, p.ty, 3);
        Particles.boom(p.tx + 20, p.ty - 10, 2);
        Particles.boom(p.tx - 18, p.ty + 8, 2);
        if (tileState(p.tx, p.ty) === 2) sfx('boom');
      }
      continue;
    }
    p.t += dt;
    // in-flight trails: a cruise missile smokes, a firework showers sparks
    if (p.kind === 'cruise') {
      p.trail = (p.trail || 0) - dt;
      if (p.trail <= 0) { p.trail = 0.04; Particles.smoke(p.x, p.y, 1.4, p.hgt || 0); }
    } else if (p.kind === 'firework') {
      p.trail = (p.trail || 0) - dt;
      if (p.trail <= 0) { p.trail = 0.03; Particles.spawn({ kind: 'spark', x: p.x, y: p.y, z: p.hgt || 0, vx: (fxRandom() - 0.5) * 30, vy: (fxRandom() - 0.5) * 30, drag: 3, life: 0.3, col: p.col }); }
    }
    if (p.t >= p.dur) {
      p.done = true;
      const s = p.stats;
      splashDamage(p.tx, p.ty, s.splash || 36, s.dmg, p.owner, s);
      if (p.kind === 'firework') { Particles.pulse(p.tx, p.ty, 34, p.col); for (let i = 0; i < 10; i++) { const a = fxRandom() * Math.PI * 2, sp = 40 + fxRandom() * 90; Particles.spawn({ kind: 'spark', x: p.tx, y: p.ty, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 3, life: 0.4 + fxRandom() * 0.3, col: p.col }); } }
      else Particles.boom(p.tx, p.ty, p.kind === 'bomb' ? 1.1 : 0.85);
      if (tileState(p.tx, p.ty) === 2) sfx('boom');
      if (s.groundEffect) {
        const ge = s.groundEffect;
        state.zones.push({
          x: p.tx, y: p.ty, r: ge.r, until: state.time + ge.dur,
          caster: p.owner, kind: ge.kind, dps: ge.dps,
          // singularity extras (ignored by fire/toxin): inward pull, collapse blast
          pull: ge.pull, dmg: ge.dmg, blastAt: ge.blast ? state.time + ge.blast : undefined,
        });
      }
    } else {
      const f = p.t / p.dur;
      // ground-plane position; the lob arc is a SCREEN-space height (p.hgt)
      // applied at draw time, not baked into world y. Bombs fall from the
      // release altitude instead of arcing up
      p.x = p.sx + (p.tx - p.sx) * f;
      p.y = p.sy + (p.ty - p.sy) * f;
      p.hgt = p.kind === 'bomb' ? (1 - f) * (FLY_H + 6) : Math.sin(Math.PI * f) * p.arc;
    }
  }
  // ---------- the Firmament eats what crosses it ----------
  // A solid sky stops things thrown through it. Shells and missiles from
  // OUTSIDE the caster's side burn up on the dome; the caster's own fire is
  // unaffected, so it shields a position rather than sealing it.
  for (const z of state.zones) {
    if (z.kind !== 'firmament') continue;
    for (const p of state.projectiles) {
      if (p.done || p.owner === z.caster) continue;
      const px = p.x !== undefined ? p.x : p.sx, py = p.y !== undefined ? p.y : p.sy;
      if (Math.hypot(px - z.x, py - z.y) > z.r) continue;
      p.done = true;
      Particles.pulse(px, py, 16, [169, 195, 204]);
    }
  }
  state.projectiles = state.projectiles.filter(p => !p.done);
}

function updateZones(dt) {
  for (const z of state.zones) {
    if (z.kind === 'firmament') {
      // aircraft caught under the dome grind along the underside of it
      z.tick = (z.tick || 0) - dt;
      if (z.tick <= 0) {
        z.tick = 0.25;
        for (const u of state.units) {
          if (u.owner === z.caster || u.owner === NEUTRAL || u.hp <= 0) continue;
          if (!UNIT_TYPES[u.type].flying || dist(z, u) > z.r) continue;
          dealDamage(null, u, z.dps * 0.25, {});
          u.slowUntil = state.time + 0.4;
          if (fxRandom() < 0.3) Particles.pulse(u.x, u.y - (u.alt || 0), 12, [169, 195, 204]);
        }
      }
    } else if (z.kind === 'storm') {
      z.tick = (z.tick || 0.1) - dt;
      if (z.tick <= 0) {
        z.tick = 0.55;
        const a = simRandom() * Math.PI * 2, rad = simRandom() * z.r;
        const bx = z.x + Math.cos(a) * rad, by = z.y + Math.sin(a) * rad;
        Particles.bolt(bx + 8, by - 6, bx, by, [255, 245, 180], 55); // strike from the sky
        splashDamage(bx, by, 24, z.dmg || 15, z.caster, { sup: z.sup }, true); // the storm doesn't care what flies
        if (tileState(bx, by) === 2) sfx('boom');
      }
    } else if (z.kind === 'fire' || z.kind === 'toxin' || z.kind === 'tremor') {
      z.tick = (z.tick || 0) - dt;
      if (z.tick <= 0) {
        z.tick = 0.4;
        for (const u of state.units) {
          if (u.owner === z.caster || u.hp <= 0 || u.garrisoned || u.burrowed || UNIT_TYPES[u.type].flying) continue;
          if (dist(u, z) <= z.r + UNIT_TYPES[u.type].r) u.hp -= (z.dps || 5) * 0.4;
        }
        // a tremor kicks up dust while it shakes
        if (z.kind === 'tremor') {
          const a = fxRandom() * Math.PI * 2, rad = fxRandom() * z.r;
          Particles.pulse(z.x + Math.cos(a) * rad, z.y + Math.sin(a) * rad, 8, [150, 128, 96]);
        }
      }
    } else if (z.kind === 'wave') {
      // a seismic crack racing along the ground toward its target; the quake
      // lands when it arrives
      const dx = z.tx - z.x, dy = z.ty - z.y, d = Math.hypot(dx, dy);
      const step = (z.speed || 420) * dt;
      if (d <= step) {
        z.until = 0; // spent
        splashDamage(z.tx, z.ty, z.splash || 46, z.dmg, z.caster, { bldgBonus: z.bldgBonus || 1, vril: true });
        // the ground convulses: brief stagger for whoever kept their footing
        for (const u of state.units) {
          if (u.owner === z.caster || u.hp <= 0 || u.garrisoned || UNIT_TYPES[u.type].flying) continue;
          if (dist(u, { x: z.tx, y: z.ty }) <= (z.splash || 46) + UNIT_TYPES[u.type].r) {
            u.petrifiedUntil = Math.max(u.petrifiedUntil || 0, state.time + (z.stun || 0.6));
          }
        }
        state.zones.push({ x: z.tx, y: z.ty, r: (z.splash || 46) * 0.9, until: state.time + 1.6, caster: z.caster, kind: 'tremor', dps: 6 });
        Particles.boom(z.tx, z.ty, 1.2);
        if (tileState(z.tx, z.ty) === 2) sfx('boom');
      } else {
        z.x += dx / d * step; z.y += dy / d * step;
        Particles.pulse(z.x + (fxRandom() - 0.5) * 10, z.y + (fxRandom() - 0.5) * 10, 9, [166, 142, 104]);
      }
    } else if (z.kind === 'barrage') {
      // loitering munitions: a small blast lands somewhere in the zone each tick
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.35;
        const a = simRandom() * Math.PI * 2, rad = Math.sqrt(simRandom()) * z.r;
        const bx = z.x + Math.cos(a) * rad, by = z.y + Math.sin(a) * rad;
        splashDamage(bx, by, 40, z.dmg, z.caster, { bldgBonus: 1.2, sup: z.sup });
        Particles.boom(bx, by, 0.8);
        if (tileState(bx, by) === 2) sfx('boom');
      }
    } else if (z.kind === 'ray') {
      // death ray: everything caught in the beam takes heavy sustained damage
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.25;
        splashDamage(z.x, z.y, z.r, z.dmg, z.caster, { bldgBonus: 1.5 }, true);
        Particles.boom(z.x + (fxRandom() - 0.5) * z.r, z.y + (fxRandom() - 0.5) * z.r, 0.7);
        if (tileState(z.x, z.y) === 2) sfx('boom');
      }
    } else if (z.kind === 'singularity') {
      // gravity well: haul every enemy ground unit in toward the core...
      for (const u of state.units) {
        if (u.owner === z.caster || u.hp <= 0 || u.garrisoned || u.burrowed || UNIT_TYPES[u.type].flying) continue;
        const dx = z.x - u.x, dy = z.y - u.y, d = Math.hypot(dx, dy);
        if (d <= z.r && d > 3) { const s = Math.min((z.pull || 120) * dt, d - 2); u.x += dx / d * s; u.y += dy / d * s; }
      }
      // ...then collapse in one crushing implosion once the well caves in
      if (!z.blasted && z.blastAt && state.time >= z.blastAt) {
        z.blasted = true;
        splashDamage(z.x, z.y, z.r * 0.85, z.dmg || 40, z.caster, { bldgBonus: 1.2 });
        Particles.boom(z.x, z.y, 1.8);
        if (tileState(z.x, z.y) === 2) sfx('boom');
      }
    }
  }
}

function tryAttack(u, target, dt) {
  const t = UNIT_TYPES[u.type];
  if (t.maxAmmo && u.ammo <= 0) { u.order = { type: 'rearm' }; return; } // winchester — RTB
  if (t.plane) { planeAttack(u, target, t, dt); return; }
  const range = t.atkRange + entityRadius(target);
  const d = dist(u, target);
  // deployable siege fights planted: deploy on station, pack up to chase
  if (t.deployable) {
    if (d > range) {
      if (u.deployed || u.deployingUntil > state.time) {
        u.deployed = false;
        u.deployingUntil = Math.max(u.deployingUntil || 0, state.time + 1.2);
        return;
      }
      moveToward(u, target.x, target.y, dt, range - 4, target.kind === 'building' ? target.id : null);
      return;
    }
    if (!u.deployed) {
      u.deployed = true;
      u.deployingUntil = state.time + 2;
      Particles.pulse(u.x, u.y, 28, [150, 128, 96]); // outriggers slam down
    }
  } else if (d > range) {
    moveToward(u, target.x, target.y, dt, range - 4,
      target.kind === 'building' ? target.id : null);
    return;
  }
  // loitering munition: dive into the target and detonate, destroying itself
  if (t.kamikaze) {
    const k = t.kamikaze;
    splashDamage(target.x, target.y, k.splash, k.dmg, u.owner, { bldgBonus: k.bldgBonus || 1 }, target.kind === 'unit' && UNIT_TYPES[target.type].flying);
    Particles.boom(target.x, target.y, 1.8);
    if (tileState(target.x, target.y) === 2) sfx('boom');
    u.hp = 0;
    return;
  }
  const aimA = Math.atan2(target.y - u.y, target.x - u.x);
  // turreted vehicles keep their travel heading and swing only the gun
  if (Art.hasIsoTurret(u.type)) { u.aimAngle = aimA; u.aimT = state.time; }
  else u.facing = aimA;
  if (t.minRange && d < t.minRange) return; // artillery: too close to fire
  fireAt(u, target, t);
}

// how a fixed-wing craft prosecutes a target, by weapon fit
function planeAttack(u, target, t, dt) {
  const d = dist(u, target);
  const range = t.atkRange + entityRadius(target);
  {
    // bombing run / strafing pass: line up, release/shoot, overshoot, come
    // around, repeat. A target inside the plane's turning circle can never
    // be lined up by steering straight at it — so when close and badly
    // aimed, peel off to an initial point well outside the turn radius
    // (heading jittered, so successive runs come in on different axes),
    // then run back in straight and hot.
    const aim = Math.abs(((Math.atan2(target.y - u.y, target.x - u.x) - u.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const turnR = t.speed / (t.turn || 2);
    if (u.runIP && u.runIP.tid !== target.id) u.runIP = null; // new target, new run
    if (u.runIP) {
      if (flyToward(u, u.runIP.x, u.runIP.y, dt, 40)) u.runIP = null;
    } else if (d < turnR * 1.4 && aim > 0.45) {
      // runOut stretches the whole racetrack — gun-run craft carry the pass
      // long past the target before hauling around for another go
      const R = turnR * 2.2 + 60 + (t.runOut || 0);
      let ix, iy;
      if (aim > Math.PI * 0.55) {
        // just blew past: carry the run straight out the FAR side, don't
        // wrench into a bank on top of the target
        ix = u.x + Math.cos(u.facing) * R; iy = u.y + Math.sin(u.facing) * R;
      } else {
        const back = Math.atan2(u.y - target.y, u.x - target.x) + (simRandom() - 0.5) * 1.3;
        ix = target.x + Math.cos(back) * R; iy = target.y + Math.sin(back) * R;
      }
      u.runIP = { x: clamp(ix, 40, WORLD_W - 40), y: clamp(iy, 40, WORLD_H - 40), tid: target.id };
    } else {
      flyToward(u, target.x, target.y, dt, 0);
    }
    // fire gates by weapon fit: bombs release on overflight; the Spectre's
    // broadside rakes whenever the target is in reach of the pass (it flies
    // A-10-style racetracks now, not a tight pylon circle); the GAU-8 hoses
    // its wide beaten zone through most of the run-in; guns need the nose on
    if (t.weapon === 'bomb' || t.weapon === 'carpet') { if (d <= range) fireAt(u, target, t); }
    else if (t.weapon === 'gunrun') { if (d <= range && aim < 0.85) fireAt(u, target, t); }
    else if (d <= range && aim < 0.5) fireAt(u, target, t);
  }
}

function fireAt(u, target, t) {
  if (u.burrowed) return; // no firing ports underground
  if (t.forestOnly && !inForest(u)) return; // no stand to shoot from out here
  if (t.deployable && (!u.deployed || u.deployingUntil > state.time)) return; // still planting the drill
  if (u.cooldown <= 0) {
    const isAir = target.kind === 'unit' && UNIT_TYPES[target.type].flying;
    let dmg = (!isAir && t.dmgVsGround !== undefined) ? t.dmgVsGround : t.dmg;
    if (t.swing) u.clawT = state.time; // the halberd sweeps (art)
    u.disguised = false; // skin suit drops the moment they open fire
    // A stealth aircraft that opens fire is BLOWN. Pad craft stay lit all the
    // way home and only wash the paint on the apron (cleared when they land to
    // rearm); free-flying stealth has no base to return to, so it fades after a
    // long exposure instead.
    // One rule for everything that hides: you shot, you are lit, for
    // EXPOSE_FIRING seconds. Pad aircraft are the exception and stay lit all
    // the way home (cleared when they land to rearm), because a jet cannot
    // simply hold still until people forget about it.
    if (t.stealth || t.cloakStill || t.forestOnly) {
      if (t.cloakStill && u.cloaked) u.ambush = true;   // decloak first-strike
      u.exposedUntil = (t.stealth && t.pad) ? Infinity : state.time + EXPOSE_FIRING;
    }
    if (u.ambush) { dmg *= 2; delete u.ambush; } // surfacing / decloak first-strike bonus
    // Mass Awakening: the people have seen it, and the militia hit like it
    if (u.type === 'militia' && bcastActive(u.owner, 'awakening')) dmg *= BROADCASTS.awakening.mul;
    if (u.buffedUntil > state.time) dmg *= 1.25; // broodmother's blessing
    if (u.weakenedUntil > state.time) dmg *= 0.55; // shouted down by a Megaphone Prophet
    // recovered UFO tech (a held Crash Site): reverse-engineered weapons
    if (t.flying && state.airTechOwners && state.airTechOwners.has(u.owner)) dmg *= 1.15;
    u.cooldown = t.cooldown;
    if (t.maxAmmo) u.ammo--;
    // turreted vehicles fire along the gun, not the chassis
    const a = (Art.hasIsoTurret(u.type) && u.turret !== undefined) ? u.turret : u.facing;
    const visible = tileState(u.x, u.y) === 2 || tileState(target.x, target.y) === 2;
    const wkind = t.weapon || 'gun';

    if (wkind === 'bomb' || wkind === 'lob') {
      // physical projectile: aimed at where the target IS — it can be dodged.
      // scatter spreads each shot around the aim point (Firework Battery)
      let ptx = target.x, pty = target.y;
      // shells cannot arc over a flat earth: a defender who has disproved
      // ballistics makes every lobbed shot aimed at them wander badly
      let scat = t.scatter || 0;
      if (target.owner !== undefined && disproved(target.owner, 'ballistics')) scat += 95;
      if (scat) { const sa = simRandom() * Math.PI * 2, sr = simRandom() * scat; ptx += Math.cos(sa) * sr; pty += Math.sin(sa) * sr; }
      spawnProjectile(wkind === 'bomb' ? 'bomb' : (t.projectile || 'rock'),
        u.x, u.y, ptx, pty, u.owner, t);
      if (visible) sfx('shot');
    } else if (wkind === 'quake') {
      // the crack races along the ground; the earth convulses on arrival
      state.zones.push({
        kind: 'wave', x: u.x, y: u.y, tx: target.x, ty: target.y, r: 14, speed: 420,
        until: state.time + 6, caster: u.owner, dmg,
        bldgBonus: t.bldgBonus || 1, splash: 48, stun: 0.6,
      });
      if (visible) sfx('boom');
    } else if (wkind === 'storm') {
      state.zones.push({ x: target.x, y: target.y, r: 60, until: state.time + 3, caster: u.owner, kind: 'storm', dmg: t.dmg });
      if (visible) sfx('laser');
    } else if (wkind === 'carpet') {
      // B-52 stick: real bombs, released in a train along the flight path and
      // walked through the aim point. Unlike the A-10's gun run these fall as
      // PROJECTILES (they take time to arrive, and the shadow of the stick is
      // the warning), and unlike the A-10 they respect IFF — this is a bomb
      // run on coordinates, not a strafe over a melee.
      const dirX = Math.cos(u.facing), dirY = Math.sin(u.facing);
      const n = t.burstShells || 5;
      for (let i = 0; i < n; i++) {
        const along = ((i / Math.max(1, n - 1)) - 0.4) * (t.beatenLen || 140);
        const off = (simRandom() - 0.5) * (t.beatenWidth || 30);
        const ix = target.x + dirX * along - dirY * off;
        const iy = target.y + dirY * along + dirX * off;
        const p = spawnProjectile('bomb', u.x + dirX * along * 0.35, u.y + dirY * along * 0.35, ix, iy, u.owner,
          { dmg, splash: t.splash || 38, bldgBonus: t.bldgBonus || 1 });
        // the bay opens once and the stick WALKS: each bomb in the train falls
        // a beat after the one ahead of it, so the run reads as a rolling line
        // of detonations you can watch coming rather than one instant carpet.
        if (p && t.stickGap) p.dur += i * t.stickGap;
      }
      if (visible) sfx('boom');
      if (target.hp <= 0 && u.order.type === 'attack') nextTargetOrIdle(u, t);
    } else if (wkind === 'gunrun') {
      // GAU-8 saturation run: walk a burst of shells with honest scatter
      // along the flight path through the aim point. Monstrous against
      // vehicles and infantry in the beaten zone — and NO IFF: friendly
      // ground forces in the corridor eat it too, just like the real one.
      // (Buildings barely notice: bldgBonus < 1.)
      const dirX = Math.cos(u.facing), dirY = Math.sin(u.facing);
      for (let i = 0; i < (t.burstShells || 3); i++) {
        // the first shell of each burst flies true; the rest walk the
        // beaten zone ahead of the aim point
        const along = i === 0 ? (simRandom() - 0.5) * 10 : (simRandom() - 0.35) * (t.beatenLen || 55);
        const off = (simRandom() - 0.5) * (i === 0 ? 6 : (t.beatenWidth || 14));
        const ix = target.x + dirX * along - dirY * off;
        const iy = target.y + dirY * along + dirX * off;
        splashDamage(ix, iy, t.splash || 13, dmg, -99, t); // -99: no IFF, ground only
        Particles.boom(ix, iy, 0.45);
      }
      if (visible) sfx('shot');
      if (target.hp <= 0 && u.order.type === 'attack') nextTargetOrIdle(u, t);
    } else if (wkind === 'abduct') {
      // tractor beam: pin a ground unit, drain it, and after enough continuous
      // beam-time haul it up and away — abducted, gone, worth a few minerals.
      // Too-heavy targets can't be lifted; the beam just holds and drains them.
      Particles.bolt(u.x, u.y, target.x, target.y, [190, 140, 255], unitAlt(u));
      dealDamage(u, target, dmg, t);
      if (target.kind === 'unit' && !UNIT_TYPES[target.type].flying) {
        target.slowUntil = state.time + 0.55;
        u.abductHold = (u.abductId === target.id) ? (u.abductHold || 0) + t.cooldown : 0;
        u.abductId = target.id;
        target.beamHoldFrac = u.abductHold /
          ((t.abductTime || 3) * (disproved(target.owner, 'actors') ? ACTORS_SLOW : 1)); // capture countdown bar
        target.beamHoldT = state.time;
        // Crisis Actors: a paid actor does not go quietly — the beam needs
        // ACTORS_SLOW times as long to get them off the ground
        const holdNeeded = (t.abductTime || 3) * (disproved(target.owner, 'actors') ? ACTORS_SLOW : 1);
        if (target.hp > 0 && UNIT_TYPES[target.type].hp <= (t.abductMax || 320) && u.abductHold >= holdNeeded) {
          target.hp = 0; target.abducted = true;
          state.minerals[u.owner] = (state.minerals[u.owner] || 0) + (t.abductBounty || 20);
          Particles.pulse(target.x, target.y, 45, [190, 140, 255]);
          u.abductId = null; u.abductHold = 0;
          if (u.owner === localOwner) eva('Specimen acquired');
          else if (target.owner === localOwner) eva('They took one of ours');
        }
      }
      if (visible) sfx('laser');
      if (target.hp <= 0 && u.order.type === 'attack') nextTargetOrIdle(u, t);
    } else if (t.rocketArt) {
      // shoulder-launched: a visible homing rocket carries the warhead —
      // the damage lands on impact, not on the trigger pull
      state.projectiles.push({
        kind: 'missile', x: u.x + Math.cos(a) * (t.r + 2), y: u.y + Math.sin(a) * (t.r + 2),
        targetId: target.id, owner: u.owner, srcId: u.id,
        stats: { ...t, dmg }, angle: a, speed: 300, life: 3,
        alt: (isAir ? undefined : 3),
      });
      if (visible) sfx('shot');
    } else {
      dealDamage(u, target, dmg, t);
      if (t.jams && isAir) target.slowUntil = state.time + 0.6; // scrambled avionics
      if (t.petrify && target.kind === 'unit') target.petrifiedUntil = state.time + t.petrify; // the gaze
      if (t.leech) u.hp = Math.min(u.maxHp, u.hp + dmg * 0.8); // vivisection pays
      // a close-quarters hit swings the power fist (dreadnought art)
      if (t.clawArm && dist(u, target) <= 60 + entityRadius(target)) u.clawT = state.time;
      // turreted vehicles fire from the barrel tip up on the turret; everyone
      // else from the sprite edge at body height, so tracer meets muzzle flash
      const turreted = Art.hasIsoTurret(u.type);
      const muzR = (t.r + 2) * (turreted ? 1.4 : 1);
      const muzZ = unitAlt(u) + (turreted ? 8 : 0);
      if (t.lance) {
        // annihilation lance: a fat beam column slamming down, not a tracer
        Particles.bolt(u.x, u.y, target.x, target.y, [125, 255, 214], unitAlt(u));
        Particles.bolt(u.x + 1.5, u.y + 1.5, target.x, target.y, [225, 255, 244], unitAlt(u));
        Particles.pulse(target.x, target.y, 32, [125, 255, 214]);
      } else {
        Particles.shot(u.x + Math.cos(a) * muzR, u.y + Math.sin(a) * muzR,
          target.x, target.y, WEAPON_STYLE[state.factions[u.owner]],
          muzZ, target.kind === 'unit' ? unitAlt(target) : 0);
      }
      if (wkind === 'spray' && t.groundEffect && !isAir) {
        state.zones.push({
          x: target.x, y: target.y, r: t.groundEffect.r, until: state.time + t.groundEffect.dur,
          caster: u.owner, kind: t.groundEffect.kind, dps: t.groundEffect.dps,
        });
      }
      if (visible) sfx(t.lance || state.factions[u.owner] === 'glob' ? 'laser' : 'shot');
      if (target.hp <= 0 && u.order.type === 'attack') nextTargetOrIdle(u, t);
    }
  }
}

// on a kill, flying attackers swing straight onto the next nearest enemy
// instead of breaking off — pad craft keep hunting until the ammo runs dry
// (the empty-magazine check in updateUnit sends them home). Ground units
// still drop to idle and re-acquire by sight.
// A fence is only worth shooting when it is actually in the way.
//
// u.path.pts === null is the pathfinder reporting NO ROUTE AT ALL to where this
// unit wants to be. Anything else — a gap blown in the line, an open gate, a
// way round the end — means A* has a way through, and the wall is scenery.
// Without this, a wave would walk up to a breached wall and start chewing the
// segment beside the hole, because that segment was simply the nearest enemy
// thing. Aircraft never path, so u.path is undefined and they never pick a wall
// at all, which is correct: a wall has never stopped a plane.
//
// An explicit attack order still works — this only governs what a unit chooses
// for itself.
const noRouteThrough = u => !!(u.path && u.path.pts === null);
const isIdleWall = (u, e) =>
  e.kind === 'building' && bstatsOf(e).wallKind && !noRouteThrough(u);

function nextTargetOrIdle(u, t) {
  if (t.flying && !(t.maxAmmo && u.ammo <= 0)) {
    const foe = nearestTarget(u, enemiesOf(u.owner), e =>
      !hiddenFrom(e, u.owner) && canTarget(t, e) && !isIdleWall(u, e) &&
      dist(u, e) <= Math.max(t.sight * 1.6, 450) && dist(u, e) >= (t.minRange || 0));
    if (foe) { orderAttack(u, foe); return; }
  }
  u.order = { type: 'idle' };
}

// ---------- Mechanicum fire cycles ----------
// A volley is a weapon on a CLOCK, not on a trigger. The Lantern Guard and the
// Dreadnought are melee units — their `dmg`/`atkRange` is the halberd and the
// power fist. What makes them worth their price is the heavy weapon that goes
// off every `every` seconds on its own initiative: it picks its own target,
// empties a burst into it, and (for the Guard) the body charges in behind its
// own fire.
//
// The clock does NOT stop for a brawl. That is deliberate — a Dreadnought
// wrestling a tank still barks, it just can't aim, so every shot rolls against
// `meleeAcc` (bad) instead of `acc` (good) whenever something hostile is inside
// swinging distance. A miss still draws a tracer, off to one side.
//
// Bolts and shells are hitscan so they can reach a hovering balloon (see
// isLowAir); the Dreadnought's shoulder rockets are real homing missiles and
// will chase anything in the sky, at any altitude.
function volleyPick(u, range, mode) {
  return nearestTarget(u, enemiesOf(u.owner), e => {
    if (hiddenFrom(e, u.owner)) return false;
    if (dist(u, e) > range + entityRadius(e)) return false;
    if (e.kind === 'building') return mode !== 'air';
    const et = UNIT_TYPES[e.type];
    if (!et.flying) return mode !== 'air';
    return mode === 'air' ? true : isLowAir(et);
  });
}
// is something hostile close enough to be swinging at us right now?
function inBrawl(u, t) {
  return !!nearestTarget(u, enemiesOf(u.owner), e =>
    !hiddenFrom(e, u.owner) && dist(u, e) <= t.atkRange + entityRadius(e) + 18);
}
function updateVolley(u, t, dt) {
  const V = t.volley;
  if (u.transit || u.burrowed || u.petrifiedUntil > state.time) return;
  const rollGap = () => Array.isArray(V.every)
    ? V.every[0] + simRandom() * (V.every[1] - V.every[0])
    : V.every;
  if (u.volT === undefined) u.volT = rollGap() * (0.3 + simRandom() * 0.7); // stagger the first one
  // fire any shots whose moment has come
  if (u.volQ && u.volQ.length) {
    const brawling = inBrawl(u, t);
    while (u.volQ.length && u.volQ[0].at <= state.time) {
      const shot = u.volQ.shift();
      const tgt = findEntity(shot.tid);
      if (!tgt || tgt.hp <= 0 || tgt.garrisoned) continue;
      const acc = brawling ? shot.meleeAcc : shot.acc;
      const hit = simRandom() < acc;
      const a = Math.atan2(tgt.y - u.y, tgt.x - u.x);
      if (shot.rocket) {
        // a real missile off the shoulder rack: a miss carries a dud warhead
        state.projectiles.push({
          kind: 'missile', x: u.x + (shot.i % 2 ? 7 : -7), y: u.y - 6,
          targetId: tgt.id, owner: u.owner, srcId: u.id,
          stats: { dmg: hit ? shot.dmg : 0, bldgBonus: t.bldgBonus || 1 },
          angle: a, speed: 300, life: 3,
        });
      } else {
        u.firingT = state.time; // muzzle flash (art)
        const spread = hit ? 0 : (10 + simRandom() * 26) * (simRandom() < 0.5 ? -1 : 1);
        const ex = tgt.x + Math.cos(a + Math.PI / 2) * spread;
        const ey = tgt.y + Math.sin(a + Math.PI / 2) * spread;
        if (hit) dealDamage(u, tgt, shot.dmg, t);
        Particles.shot(u.x + Math.cos(a) * (t.r + 2), u.y + Math.sin(a) * (t.r + 2),
          hit ? tgt.x : ex, hit ? tgt.y : ey, WEAPON_STYLE[state.factions[u.owner]],
          unitAlt(u), tgt.kind === 'unit' ? unitAlt(tgt) : 0);
      }
      if (tileState(u.x, u.y) === 2) sfx(shot.rocket ? 'boom' : 'shot');
    }
    return; // one barrage at a time
  }
  u.volT -= dt;
  if (u.volT > 0) return;
  // the clock is up: find something worth the ammunition
  const gunTgt = volleyPick(u, V.range, V.lowAir ? 'low' : 'ground');
  const R = V.rockets;
  const rockTgt = R ? (volleyPick(u, R.range, 'air') || gunTgt) : null;
  if (!gunTgt && !rockTgt) { u.volT = 0.5; return; } // nothing in reach — check back shortly
  u.volT = rollGap();
  u.volQ = [];
  let clock = state.time;
  if (gunTgt) {
    for (let i = 0; i < V.shots; i++) {
      u.volQ.push({ at: clock + i * V.gap, tid: gunTgt.id, dmg: V.dmg, acc: V.acc, meleeAcc: V.meleeAcc, i });
    }
    clock += V.shots * V.gap;
  }
  if (R && rockTgt) {
    clock += R.delay || 0;
    for (let i = 0; i < R.count; i++) {
      u.volQ.push({ at: clock + i * R.gap, tid: rockTgt.id, dmg: R.dmg, acc: R.acc, meleeAcc: R.meleeAcc, i, rocket: true });
    }
  }
  // the Guard charges in behind its own barrage — but only at something it can
  // actually reach with a halberd
  if (V.charge && gunTgt && !(gunTgt.kind === 'unit' && UNIT_TYPES[gunTgt.type].flying)) {
    u.chargeUntil = state.time + V.charge + V.shots * V.gap;
    if (u.order.type === 'idle' || u.order.type === 'attackmove') orderAttack(u, gunTgt);
  }
  Particles.pulse(u.x, u.y - 6, 14, [125, 255, 214]);
}

function autoAcquire(u, dt) {
  const t = UNIT_TYPES[u.type];
  if (t.maxAmmo && u.ammo <= 0) return; // nothing left to shoot with
  // stagger the full-map target sweeps — every idle unit scanning every
  // frame was a big slice of late-game frame time
  u.scanT = (u.scanT === undefined ? (u.id % 10) * 0.03 : u.scanT) - dt;
  if (u.scanT > 0) return;
  u.scanT = 0.3;
  const foe = nearestTarget(u, enemiesOf(u.owner), e =>
    !hiddenFrom(e, u.owner) && canTarget(t, e) && !isIdleWall(u, e) &&
    dist(u, e) <= t.sight && dist(u, e) >= (t.minRange || 0));
  if (foe) orderAttack(u, foe);
}

// idle repair units drift to the nearest damaged ally and patch it up
function repairAcquire(u, dt) {
  u.scanT = (u.scanT === undefined ? (u.id % 10) * 0.03 : u.scanT) - dt;
  if (u.scanT > 0) return;
  u.scanT = 0.4;
  const ally = nearest(u, state.units, a => a.owner === u.owner && a !== u && a.hp > 0 &&
    !a.garrisoned && !a.transit && a.hp < a.maxHp && !UNIT_TYPES[a.type].repair && dist(u, a) <= 220);
  if (ally) u.order = { type: 'repair', targetId: ally.id };
}

// is this mineral field clear enough to work? Used to stop fled miners from
// commuting back into the raid that chased them off.
const MINE_DANGER_R = 300;
function patchIsSafe(owner, p) {
  return !state.units.some(e => e.owner !== owner && e.owner !== NEUTRAL && e.hp > 0 &&
    UNIT_TYPES[e.type].dmg && !e.garrisoned && !hiddenFrom(e, owner) && dist(e, p) < MINE_DANGER_R);
}

function depositTarget(u) {
  // Haul to the nearest drop-off: the HQ or any finished Refinery. A forward
  // refinery near a distant field keeps the round-trip short.
  //
  // Ranked by rectDist, not centre distance: a wide HQ whose near wall is right
  // there can sit "further away" than a small refinery across the yard once you
  // measure to the middle, and the rig would trek past the open loading bay.
  let best = null, bd = Infinity;
  for (const b of state.buildings) {
    if (!(b.owner === u.owner && b.hp > 0 && (b.type === 'hq' || (bstatsOf(b).dropoff && b.done)))) continue;
    const d = rectDist(u, b);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

// distance from a unit to a building's actual footprint rectangle — radial
// distance to center says a rig hugging the long wall of an HQ is "far away"
function rectDist(u, b) {
  const dx = Math.max(0, Math.abs(u.x - b.x) - b.w / 2);
  const dy = Math.max(0, Math.abs(u.y - b.y) - b.h / 2);
  return Math.hypot(dx, dy);
}

// The point on a building's perimeter a unit should actually walk to: its own
// position, clamped onto the footprint grown by a small margin. Every wall is a
// loading bay, so a rig coming up from the south unloads at the south wall.
//
// This matters more than it looks. moveToward() feeds its destination to A*,
// and A* snaps a goal inside a building to freeCellNear(), which scans outward
// rings top-left first — so aiming at the CENTRE sent every hauler on the map
// around to the same north-west corner, whichever field it had come from. Aim
// at the near wall and the snap lands on the near side.
function dockPoint(u, b, margin = 6) {
  const ex = b.w / 2 + margin, ey = b.h / 2 + margin;
  return {
    x: clamp(u.x, b.x - ex, b.x + ex),
    y: clamp(u.y, b.y - ey, b.y + ey),
  };
}

// ---------- airfield slots (RA2-style: 4 aircraft stationed per pad) ----------

// stationed-aircraft capacity of a pad-host building
function padCapOf(b) {
  return bstatsOf(b).padCap || PAD_CAP;
}

function padLoad(b) {
  return state.units.filter(u => u.hp > 0 && u.homeId === b.id && UNIT_TYPES[u.type].pad).length
    + b.queue.filter(j => UNIT_TYPES[j.type].pad).length;
}

function freeSlot(b) {
  const taken = new Set(state.units
    .filter(u => u.hp > 0 && u.homeId === b.id && UNIT_TYPES[u.type].pad)
    .map(u => u.slot));
  for (let s = 0; s < padCapOf(b); s++) if (!taken.has(s)) return s;
  return 0;
}

function padSlotsFree(owner, padType = 'airpad') {
  return state.buildings.some(b => b.owner === owner && b.hp > 0 && b.done &&
    b.type === padType && padLoad(b) < padCapOf(b));
}

// resolve an aircraft's home pad; adopts a new one (and slot) if the old died.
// A craft only homes to the building type that trains it — no AC-130s
// squatting on fighter pads.
function findPadFor(u) {
  const padType = UNIT_TYPES[u.type].builtAt;
  let home = state.buildings.find(b => b.id === u.homeId && b.owner === u.owner && b.hp > 0 && b.done && b.type === padType);
  if (home) return home;
  home = nearest(u, state.buildings, b => b.owner === u.owner && b.type === padType &&
    b.hp > 0 && b.done && padLoad(b) < padCapOf(b));
  if (home) { u.homeId = home.id; u.slot = freeSlot(home); }
  return home;
}

// ---------- per-frame unit upkeep (the passives that run before the order) ----------

// airborne feel (visual): craft ease onto their flight ceiling instead of
// snapping, and bank into turns. u.alt drives the render lift + weapon origins
// (see unitAlt); u.roll tips the sprite by how hard it's turning this frame.
function updateFlightFeel(u, stats, dt) {
  const tgtAlt = u.landed ? 0 : (stats.flyH || FLY_H);
  if (u.alt === undefined) u.alt = tgtAlt;
  u.alt += (tgtAlt - u.alt) * Math.min(1, dt * 2.5);
  const pf = u._pf === undefined ? (u.facing || 0) : u._pf;
  const df = ((u.facing - pf + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  u._pf = u.facing || 0;
  // saucers/blimps hold level; winged & rotor craft roll. Cap the bank.
  const bankK = (stats.shape === 'saucer' || stats.shape === 'blimp') ? 0.04 : 0.16;
  const tgtRoll = clamp(df / Math.max(dt, 0.001) * bankK, -0.5, 0.5);
  if (u.roll === undefined) u.roll = 0;
  u.roll += (tgtRoll - u.roll) * Math.min(1, dt * 6);
}

// turreted vehicles: the gun slews toward its aim point (set in tryAttack while
// a target is engaged) and drifts back to the hull heading otherwise, so the
// chassis can steer freely while the weapon stays on target
function updateTurretSlew(u, dt) {
  if (u.turret === undefined) u.turret = u.facing || 0;
  const desired = (u.aimT > state.time - 0.4 && u.aimAngle !== undefined) ? u.aimAngle : (u.facing || 0);
  const d = ((desired - u.turret + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  u.turret += clamp(d, -8 * dt, 8 * dt);
}

// ---------- the brood SCREENS; the master fights from behind it ----------
// The reptilian mother keeps a bound swarm of hatchlings — spawned once, then
// topped back up as they die. The swarm is her weapon. A bound escort does not
// trail its mistress like ducklings: it rides out in FRONT of her, on the side
// the enemy is on, and it makes contact first while she hangs back and keeps
// working. Cut loose by her death it scatters and soon expires (no queen, no
// swarm). She in turn keeps her distance — while any escort still lives she
// backs away from anything that closes inside BROOD_STANDOFF, so the swarm is
// what the enemy actually reaches.
function updateBrood(u, stats, dt) {
  if (stats.brood && !u.transit) {
    const broodType = stats.brood.type || 'hatchling';
    if (!u.broodInit) {
      u.broodInit = true;
      for (let i = 0; i < stats.brood.count; i++) {
        const h = makeUnit(u.owner, broodType, u.x + (simRandom() - 0.5) * 30, u.y + 12 + i * 3);
        h.broodOf = u.id;
      }
    } else {
      const alive = state.units.reduce((n, h) => n + (h.broodOf === u.id && h.hp > 0 ? 1 : 0), 0);
      u.broodT = (u.broodT || 0) + dt;
      if (alive < stats.brood.count && u.broodT >= stats.brood.regen) {
        u.broodT = 0;
        makeUnit(u.owner, broodType, u.x + (simRandom() - 0.5) * 24, u.y + 14).broodOf = u.id;
      }
    }
  }
  if (u.broodOf) {
    const mom = state.units.find(m => m.id === u.broodOf && m.hp > 0);
    if (!mom) {
      if (u.expires === undefined) u.expires = state.time + 6;
    } else {
      const mo = mom.order || { type: 'idle' };
      const momTgt = mo.type === 'attack' && mo.targetId ? findEntity(mo.targetId) : null;
      // whatever the swarm can find for itself, out to well past her sight —
      // the escort picks its own fights rather than waiting to be pointed
      const own = stats.dmg ? nearestTarget(u, enemiesOf(u.owner), e => !hiddenFrom(e, u.owner) &&
        canTarget(stats, e) && dist(mom, e) <= UNIT_TYPES[mom.type].sight + 140) : null;
      const threat = momTgt || own;
      if (threat && stats.dmg) {
        u.order = { type: 'attack', targetId: threat.id };
      } else {
        // no contact: hold station AHEAD of her, facing where trouble was last
        // seen (or simply the way she is heading)
        const ref = threat || u._lastThreat;
        let ax = mom.x, ay = mom.y + BROOD_LEAD;
        if (ref) {
          const d = dist(ref, mom) || 1;
          ax = mom.x + (ref.x - mom.x) / d * BROOD_LEAD;
          ay = mom.y + (ref.y - mom.y) / d * BROOD_LEAD;
        }
        const spread = ((u.id % 5) - 2) * 22;
        if (dist(u, { x: ax + spread, y: ay }) > 45) {
          u.order = { type: 'move', x: ax + spread, y: ay };
        } else if (u.order.type === 'move') {
          u.order = { type: 'idle' };
        }
      }
      if (threat) u._lastThreat = { x: threat.x, y: threat.y };
    }
  }
  if (stats.brood && !u.transit && !u.garrisoned) {
    const escort = state.units.some(h => h.broodOf === u.id && h.hp > 0);
    if (escort) {
      const near = nearestTarget(u, enemiesOf(u.owner), e => !hiddenFrom(e, u.owner) &&
        (e.kind === 'unit' ? UNIT_TYPES[e.type].dmg : bstatsOf(e).dmg) && dist(u, e) < BROOD_STANDOFF);
      if (near) {
        const d = dist(u, near) || 1;
        const bx = u.x + (u.x - near.x) / d * 90, by = u.y + (u.y - near.y) / d * 90;
        moveToward(u, clamp(bx, 40, WORLD_W - 40), clamp(by, 40, WORLD_H - 40), dt, 0);
      }
    }
  }
}

// support passives that radiate out of a unit every frame: free swarms, the
// friendly buff/harden auras, the enemy debuff + desertion aura, and the
// Barrage Balloon's tether cables shredding anything airborne that strays near
function updateAuras(u, stats, dt) {
  // broodmother: hatch free swarms on a timer, embolden nearby infantry
  if (stats.spawns && !u.transit) {
    u.spawnT = (u.spawnT || 0) + dt;
    if (u.spawnT >= stats.spawns.every) {
      u.spawnT = 0;
      for (let i = 0; i < stats.spawns.count; i++) {
        const h = makeUnit(u.owner, stats.spawns.type, u.x + (i - 0.5) * 20, u.y + 16);
        h.expires = state.time + stats.spawns.expires;
      }
      if (u.owner === localOwner) sfx('click');
    }
  }
  // a walking field hospital: mends anything of yours nearby, including
  // vehicles, and unlike the medic's chase-one-patient order it works on the
  // move and on everyone at once
  if (stats.mendAura) {
    u.mendT = (u.mendT || 0) - dt;
    if (u.mendT <= 0) {
      u.mendT = 0.5;
      for (const a of state.units) {
        if (a.owner !== u.owner || a === u || a.hp <= 0 || a.garrisoned || a.transit) continue;
        if (a.hp >= a.maxHp || dist(a, u) > stats.mendAura.r) continue;
        a.hp = Math.min(a.maxHp, a.hp + stats.mendAura.rate * 0.5);
        if (fxRandom() < 0.22) Particles.bolt(u.x, u.y, a.x, a.y, [140, 255, 170], 8);
      }
    }
  }
  if (stats.buffAura) {
    u.auraT = (u.auraT || 0) - dt;
    if (u.auraT <= 0) {
      u.auraT = 0.5;
      for (const a of state.units) {
        if (a.owner !== u.owner || a === u || a.hp <= 0 || a.garrisoned) continue;
        const at = UNIT_TYPES[a.type];
        if (at.builtAt !== 'barracks' || at.role !== 'combat') continue;
        if (dist(a, u) <= stats.buffAura.r) a.buffedUntil = state.time + 0.7;
      }
    }
  }
  // Grey Technician: hardens nearby infantry (they take reduced damage — the
  // "Reinforce" half of the network, as a support unit)
  if (stats.hardenAura) {
    u.hdT = (u.hdT || 0) - dt;
    if (u.hdT <= 0) {
      u.hdT = 0.4;
      for (const a of state.units) {
        if (a.owner !== u.owner || a === u || a.hp <= 0 || a.garrisoned) continue;
        const at = UNIT_TYPES[a.type];
        if (at.builtAt !== 'barracks' || at.role !== 'combat') continue;
        if (dist(a, u) <= stats.hardenAura.r) a.hardenedUntil = state.time + 0.6;
      }
    }
  }
  // Megaphone Prophet: nearby enemies fire weaker (debuffAura); enemy infantry
  // in range slowly desert to the prophet's side (convert)
  if (stats.debuffAura) {
    u.dbT = (u.dbT || 0) - dt;
    if (u.dbT <= 0) {
      u.dbT = 0.4;
      for (const e of state.units) {
        if (e.owner === u.owner || e.owner === NEUTRAL || e.hp <= 0 || e.garrisoned) continue;
        if (dist(e, u) <= stats.debuffAura.r) e.weakenedUntil = state.time + 0.6;
      }
    }
  }
  if (stats.convert) {
    u.cvT = (u.cvT || 0) + dt;
    if (u.cvT >= stats.convert.every) {
      u.cvT = 0;
      const victim = nearest(u, state.units, e => e.owner !== u.owner && e.owner !== NEUTRAL && e.hp > 0 &&
        !e.garrisoned && UNIT_TYPES[e.type].builtAt === 'barracks' && UNIT_TYPES[e.type].role === 'combat' &&
        dist(e, u) <= stats.convert.r);
      if (victim) {
        // Crisis Actors: they listen, they just stop listening later
        if (disproved(victim.owner, 'actors')) {
          victim.coupOrig = victim.coupOrig !== undefined ? victim.coupOrig : victim.owner;
          victim.coupRevert = state.time + ACTORS_RETURN;
        }
        victim.owner = u.owner; victim.disguised = false; victim.carrying = 0; victim.order = { type: 'idle' };
        if (tileState(victim.x, victim.y) === 2) Particles.pulse(victim.x, victim.y, 30, [255, 230, 140]);
      }
    }
  }
  if (stats.volley) updateVolley(u, stats, dt);
  // Barrage Balloon: its tether cables shred enemy aircraft that stray near
  // (the Aerostat's chords ring out as expanding shockwaves)
  if (stats.aaAura) {
    u.aaT = (u.aaT || 0) - dt;
    if (u.aaT <= 0) {
      u.aaT = 0.25;
      let struck = null;
      for (const e of state.units) {
        if (e.owner === u.owner || e.owner === NEUTRAL || e.hp <= 0) continue;
        if (!UNIT_TYPES[e.type].flying) continue;
        if (dist(e, u) <= stats.aaAura.r) { dealDamage(u, e, stats.aaAura.dps * 0.25, {}); struck = e; }
      }
      if (struck && stats.aaRockets && simRandom() < 0.55) {
        // a rocket streaks off one of the shoulder racks (visual — the aura
        // damage is already booked; the rocket lands with a dry warhead)
        state.projectiles.push({
          kind: 'missile', x: u.x + (simRandom() < 0.5 ? -7 : 6), y: u.y - 3,
          targetId: struck.id, owner: u.owner, stats: { dmg: 0 },
          angle: Math.atan2(struck.y - u.y, struck.x - u.x), speed: 280, life: 1.8,
        });
      }
      if (struck && stats.aaChord && state.time - (u.chordT || -9) > 0.7) {
        u.chordT = state.time;
        Particles.pulse(u.x, u.y, stats.aaAura.r * 0.55, [125, 255, 214]);
      }
    }
  }
}

// stuck watchdog: a unit with somewhere to be that hasn't covered any ground in
// 2.5s is pinned — usually a crowd wedged on a stale dodge commitment. Forget
// the steering plan; if that didn't help either, slide the unit out along the
// least-blocked direction (escalation, rare).
function updateStuckWatchdog(u, stats, o, dt) {
  u.wdT = (u.wdT || 0) + dt;
  if (u.wdX === undefined) { u.wdX = u.x; u.wdY = u.y; }
  if (u.wdT < 2.5) return;
  // only units that actually TRIED to move count as pinned — a mortar holding
  // position to fire is standing still on purpose, not wedged. Measure NET
  // displacement over the window, not accumulated travel: a unit oscillating in
  // a tight lane racks up travel while going nowhere, and the old travel-based
  // check let it stay wedged forever.
  if (u.wdWant && o.type !== 'idle' && o.type !== 'loiter' && !u.landed &&
      Math.hypot(u.x - u.wdX, u.y - u.wdY) < 5) {
    delete u.dodge;
    delete u.veer;
    delete u.path; // stale route may be the reason we're pinned — re-plan
    u.wdStrikes = (u.wdStrikes || 0) + 1;
    if (u.wdStrikes >= 2 && !stats.flying) {
      // still pinned after a replan: pick the cardinal direction with the most
      // open ground and shove — breaks base-notch wedges
      let bestA = null, bestClear = -1;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        let clear = 0;
        for (; clear < 60; clear += 10) {
          const px2 = u.x + Math.cos(a) * (clear + 10), py2 = u.y + Math.sin(a) * (clear + 10);
          const hit = bldNear(px2, py2).some(b => b.hp > 0 && blocksUnit(b, u.owner) &&
            Math.abs(px2 - b.x) < b.w / 2 + stats.r && Math.abs(py2 - b.y) < b.h / 2 + stats.r) ||
            terrainNear(px2, py2).some(t2 => !TERRAIN_TYPES[t2.type].passes && Math.hypot(px2 - t2.x, py2 - t2.y) < t2.r + stats.r);
          if (hit) break;
        }
        if (clear > bestClear) { bestClear = clear; bestA = a; }
      }
      if (bestA !== null && bestClear > 0) {
        u.x = clamp(u.x + Math.cos(bestA) * Math.min(24, bestClear), 10, WORLD_W - 10);
        u.y = clamp(u.y + Math.sin(bestA) * Math.min(24, bestClear), 10, WORLD_H - 10);
      }
      u.wdStrikes = 0;
    }
  } else {
    u.wdStrikes = 0;
  }
  u.wdT = 0;
  u.wdWant = false;
  u.wdX = u.x;
  u.wdY = u.y;
}

// armed rigs defend themselves: pop off at anything in weapon range without
// ever dropping the order they're on — mine, haul, and shoot back
function workerSelfDefense(u, stats, dt) {
  u.defT = (u.defT === undefined ? (u.id % 10) * 0.035 : u.defT) - dt;
  if (u.defT <= 0) {
    u.defT = 0.35;
    const foe = nearest(u, enemiesOf(u.owner), e =>
      !hiddenFrom(e, u.owner) && canTarget(stats, e) && dist(u, e) <= stats.atkRange + entityRadius(e));
    u.defFoeId = foe ? foe.id : null;
  }
  if (u.defFoeId && u.cooldown <= 0) {
    const foe = findEntity(u.defFoeId);
    if (foe && foe.hp > 0 && !hiddenFrom(foe, u.owner) && dist(u, foe) <= stats.atkRange + entityRadius(foe)) {
      u.facing = Math.atan2(foe.y - u.y, foe.x - u.x);
      fireAt(u, foe, stats);
    } else {
      u.defFoeId = null;
    }
  }
}

// transport riders: pinned to the vehicle, firing their own weapons out of the
// ports/bed at whatever the ride drives past. A carrier with `portRange` is a
// proper firing-port bunker rather than a bed with passengers in it — braced
// and elevated, its riders reach further than they ever could on foot, which
// is the whole case for pushing the School Bus at a defended line.
function updateCargoRiders(u, dt) {
  u.cargo = u.cargo.filter(id => { const p = findEntity(id); return p && p.hp > 0; });
  const reach = UNIT_TYPES[u.type].portRange || 0;
  // A Bug Out Van ferrying troops is a FERRY. Nobody shoots out of it — not the
  // van (it has no weapon) and not the militia in the back. If you want that
  // van fighting, weld a kit into it and give up carrying anyone.
  const ferrying = !!UNIT_TYPES[u.type].loader;
  for (const id of u.cargo) {
    const p = findEntity(id);
    p.x = u.x; p.y = u.y;
    p.cooldown = Math.max(0, p.cooldown - dt);
    const pt = UNIT_TYPES[p.type];
    if (ferrying || !pt.dmg || p.cooldown > 0) continue;
    const foe = nearestTarget(u, enemiesOf(u.owner), e =>
      !hiddenFrom(e, u.owner) && canTarget(pt, e) && dist(u, e) <= pt.atkRange + reach + entityRadius(e));
    if (foe) { p.facing = Math.atan2(foe.y - u.y, foe.x - u.x); fireAt(p, foe, pt); }
  }
}

// separation only within the same layer (ground vs ground, air vs air);
// aircraft parked on a pad hold their slot, and fixed-wing craft are never
// shoved — they are always moving anyway. Each unit resolves overlap on
// alternating TICKS — half the cost, visually identical.
//
// This alternated on `frameNo` until it desynced a live match: frameNo counts
// RENDERED FRAMES, so which units separate on a given tick depended on the
// client's frame rate. Two machines shoved different units on the same tick
// and drifted apart within a minute. Neither same-page test could see it —
// both runs shared one frameNo — which is exactly why the fingerprint that
// clients exchange over the wire earns its keep.
function separateFromNeighbors(u, stats) {
  if (u.landed || stats.plane) return;
  if (((u.id + state.tick) & 1) === 0) return;
  const myFlying = !!stats.flying;
  const sgx = (u.x / SEP_CELL) | 0, sgy = (u.y / SEP_CELL) | 0;
  for (let cx2 = sgx - 1; cx2 <= sgx + 1; cx2++) {
    for (let cy2 = sgy - 1; cy2 <= sgy + 1; cy2++) {
      const cell = sepGrid.get(cx2 * 4096 + cy2);
      if (!cell) continue;
      for (const other of cell) {
        if (other === u || other.hp <= 0 || other.garrisoned) continue;
        const ot = UNIT_TYPES[other.type];
        // Fixed-wing craft take no part in jostling — in EITHER direction. The
        // early-out above stops a plane being shoved; without this, a plane
        // still shoved everyone else, so an F-35 running in on a Mothership
        // bulldozed it across the map instead of shooting it (the jet is
        // immovable, so the whole correction landed on the saucer).
        if (ot.plane) continue;
        if (!!ot.flying !== myFlying) continue;
        // tanks don't yield to enemy footsoldiers (and the footsoldier gets no
        // shove out from under the tracks) — overlap develops, the crush pass kills
        if (u.owner !== other.owner &&
            ((isCrusher(stats) && isCrushable(ot)) || (isCrushable(stats) && isCrusher(ot)))) continue;
        const d = dist(u, other);
        const minD = stats.r + ot.r;
        if (d > 0 && d < minD) {
          const push = (minD - d) / 2;
          u.x += (u.x - other.x) / d * push;
          u.y += (u.y - other.y) / d * push;
        }
      }
    }
  }
}

function updateUnit(u, dt) {
  if (u.garrisoned) return; // stationed inside a structure; it fights for us
  u.cooldown = Math.max(0, u.cooldown - dt);
  const o = u.order;
  const stats = UNIT_TYPES[u.type];

  if (stats.flying) updateFlightFeel(u, stats, dt);

  // stationed aircraft lift off the moment they get a real order
  if (u.landed && o.type !== 'idle' && o.type !== 'rearm') u.landed = false;

  // recovered UFO tech (a held Crash Site): anti-grav alloys knit airframes
  // back together in flight (the weapon boost lives in fireAt)
  if (stats.flying && u.hp < u.maxHp && state.airTechOwners && state.airTechOwners.has(u.owner))
    u.hp = Math.min(u.maxHp, u.hp + 2.5 * dt);

  // petrified: a statue until the stone wears off
  if (u.petrifiedUntil > state.time) return;

  // deep-state passive: units run silent when they hold still (and aren't
  // still lit up from a recent shot). Moving or firing drops the cloak; a
  // detector still sees them. A first shot from cloak lands as an ambush.
  if (stats.cloakStill) {
    u.cloaked = !u.transit && !(u.exposedUntil > state.time) &&
      (state.time - (u.movedT || -99) > (stats.cloakDelay || 1.5));
  }
  // the Deer Stand Marksman vanishes among the trees: cloaked while inside a
  // forest (until a recent shot lights him up), plainly visible outside it
  if (stats.forestOnly) {
    u.cloaked = !u.transit && !(u.exposedUntil > state.time) && inForest(u);
  }
  if (u.digging && u.order.type !== 'dig') u.digging = false; // auger down

  if (Art.hasIsoTurret(u.type)) updateTurretSlew(u, dt);

  // burrowed: a blind slow crawl — combat orders degrade to movement, and
  // fireAt below refuses to shoot until the unit surfaces
  if (u.burrowed && (o.type === 'attack' || o.type === 'attackmove')) {
    const tgt = o.targetId ? findEntity(o.targetId) : o;
    u.order = tgt ? { type: 'move', x: tgt.x, y: tgt.y } : { type: 'idle' };
  }

  updateBrood(u, stats, dt);
  updateAuras(u, stats, dt);
  updateStuckWatchdog(u, stats, o, dt);

  // out of ammo: break off and return to the airfield (unless already parked —
  // a landed craft must fall through to the idle case, where it reloads)
  if (stats.maxAmmo && u.ammo <= 0 && o.type !== 'rearm' && !u.landed) {
    u.order = { type: 'rearm' };
    return;
  }

  if (stats.role === 'worker' && stats.dmg && o.type !== 'attack' && o.type !== 'tunnel')
    workerSelfDefense(u, stats, dt);
  updateSuspicion(u, dt);
  if (u.cargo && u.cargo.length) updateCargoRiders(u, dt);

  switch (o.type) {
    case 'idle':
      if (stats.pad && u.landed) {
        // parked on the pad: top off ammo, patch the airframe, hold position
        if (u.ammo < stats.maxAmmo) u.ammo = Math.min(stats.maxAmmo, u.ammo + stats.maxAmmo * dt / 4);
        if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * dt / 40);
        // interceptor scramble: AA-capable craft launch themselves the moment
        // hostile air crosses their radar (canTarget keeps bombers parked —
        // ground-attack craft only sortie when ordered). Never with a partial
        // magazine: reload fully, then fly the next sortie.
        if (hitsAir(stats) && (!stats.maxAmmo || u.ammo >= stats.maxAmmo)) autoAcquire(u, dt);
        break;
      }
      if (stats.pad && findPadFor(u)) { u.order = { type: 'rearm' }; break; }
      if (stats.plane) { u.order = { type: 'loiter', x: u.x, y: u.y }; break; } // no pad left: circle
      // free-flying craft mend slowly while hovering near a friendly airfield
      if (stats.flying && u.hp < u.maxHp && state.buildings.some(b =>
          b.owner === u.owner && b.hp > 0 && b.done && bstatsOf(b).padCap && rectDist(u, b) < 130)) {
        u.hp = Math.min(u.maxHp, u.hp + u.maxHp * dt / 40);
      }
      if (u.burrowed) break; // lying in wait — no auto-anything underground
      // slaves are never idle (the whip finds them a crystal field), and any
      // worker that fled gunfire heads back to work once the coast clears
      if (stats.role === 'worker' && (stats.lifespan || u.resumeHarvest) && !(u.fleeUntil > state.time)) {
        u.mineScanT = (u.mineScanT === undefined ? (u.id % 10) * 0.05 : u.mineScanT) - dt;
        if (u.mineScanT <= 0) {
          u.mineScanT = 0.5;
          // Only go back to a field that is actually CLEAR. Sending them to the
          // nearest patch regardless meant a rig fled home, timed out, walked
          // straight back into the same guns and fled again — a visible stutter
          // that never resolved while the raider sat on the crystal. If every
          // patch is hot they wait at home and re-check, instead of commuting
          // into the same fight forever.
          const patch = nearest(u, state.patches, p => p.amount > 0 && patchIsSafe(u.owner, p));
          if (patch) { delete u.resumeHarvest; orderHarvest(u, patch); break; }
        }
      }
      // guerrilla sappers seed IEDs passively: an idle militiaman quietly
      // buries a free charge where he stands — staggered timers, spaced away
      // from existing mines, capped per side. No clicks involved.
      if (stats.plantMine) {
        u.plantT = (u.plantT === undefined ? 6 + (u.id % 10) * 1.4 : u.plantT) - dt;
        if (u.plantT <= 0) {
          u.plantT = 15;
          const mines = state.buildings.reduce((n, b) => n + (b.owner === u.owner && b.hp > 0 && bstatsOf(b).trip ? 1 : 0), 0);
          if (mines < 8 &&
              !state.buildings.some(b => b.owner === u.owner && b.hp > 0 && bstatsOf(b).trip && dist(b, u) < 90) &&
              !placementBlocked(u.owner, 'mine', u.x, u.y)) {
            makeBuilding(u.owner, 'mine', u.x, u.y);
            if (tileState(u.x, u.y) === 2 && u.owner === localOwner) Particles.smoke(u.x, u.y, 2.5);
          }
        }
      }
      if (stats.repair) { repairAcquire(u, dt); break; }
      if (stats.role === 'combat') autoAcquire(u, dt);
      break;

    case 'move':
      if (stats.plane) {
        // fly there, then hold on station — a plane never just stops
        if (flyToward(u, o.x, o.y, dt, 40)) u.order = { type: 'loiter', x: o.x, y: o.y };
      } else if (moveToward(u, o.x, o.y, dt, 6)) u.order = { type: 'idle' };
      break;

    case 'loiter': // circling a point (scouting overwatch / stranded plane)
      flyOrbit(u, o.x, o.y, dt, 72);
      if (stats.role === 'combat') autoAcquire(u, dt);
      break;

    case 'explore': {
      // auto-recon: keep heading for the nearest unseen ground; when the map is
      // fully lit, stand down. Re-picks a target once the current one is seen.
      o.reT = (o.reT || 0) - dt;
      if (o.tx === undefined || o.tx === null || tileStateFor(u.owner, o.tx, o.ty) >= 1 || o.reT <= 0) {
        o.reT = 0.6;
        const spot = nearestUnexplored(u.owner, u.x, u.y);
        if (!spot) { u.order = { type: 'idle' }; if (u.owner === localOwner) eva('Area explored'); break; }
        o.tx = spot.x; o.ty = spot.y;
      }
      if (stats.plane) { if (flyToward(u, o.tx, o.ty, dt, 40)) o.tx = null; }
      else if (moveToward(u, o.tx, o.ty, dt, 24)) o.tx = null;
      if (stats.role === 'combat') autoAcquire(u, dt);
      break;
    }

    case 'attackmove': {
      // keep engaging the cached foe; rescan on a stagger instead of every frame
      let foe = o.foeId ? findEntity(o.foeId) : null;
      if (foe && (foe.hp <= 0 || hiddenFrom(foe, u.owner) || dist(u, foe) > stats.sight + 60 ||
          dist(u, foe) < (stats.minRange || 0))) foe = null;
      u.scanT = (u.scanT === undefined ? (u.id % 10) * 0.03 : u.scanT) - dt;
      if (!foe && u.scanT <= 0) {
        u.scanT = 0.25;
        foe = nearestTarget(u, enemiesOf(u.owner), e =>
          !hiddenFrom(e, u.owner) && canTarget(stats, e) && dist(u, e) <= stats.sight && dist(u, e) >= (stats.minRange || 0));
      }
      o.foeId = foe ? foe.id : null;
      if (foe) { tryAttack(u, foe, dt); break; }
      if (stats.plane) {
        if (flyToward(u, o.x, o.y, dt, 40)) u.order = { type: 'loiter', x: o.x, y: o.y };
      } else if (moveToward(u, o.x, o.y, dt, 8)) u.order = { type: 'idle' };
      break;
    }

    case 'attack': {
      const target = findEntity(o.targetId);
      // covers targets finished off by projectiles (bombs) or someone else,
      // and targets that slipped back under cloak or into a tunnel
      if (!target || target.hp <= 0 || !canTarget(stats, target) ||
          hiddenFrom(target, u.owner)) { nextTargetOrIdle(u, stats); break; }
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
      const carry = UNIT_TYPES[u.type].carry || HARVEST_AMOUNT; // rigs and diggers haul more
      if (u.carrying >= carry) { u.order = { type: 'return', patchId: patch.id }; break; }
      // each worker aims at its own spot on a ring around the patch (golden-angle
      // spread by id) so a crowd doesn't shove itself off the patch center, and
      // digging counts whenever we're near the patch — even while being jostled
      const ang = u.id * 2.4;
      const ring = 6 + UNIT_TYPES[u.type].r;
      moveToward(u, patch.x + Math.cos(ang) * ring, patch.y + Math.sin(ang) * ring, dt, 4);
      if (dist(u, patch) <= ring + 22) {
        // the Brutal regime swings the picks faster (slaves only)
        u.mineTimer += dt * (UNIT_TYPES[u.type].lifespan ? driveMineMul(u.owner) : 1);
        if (u.mineTimer >= HARVEST_TIME) {
          u.mineTimer = 0;
          const take = Math.min(Math.round(carry * (patch.yield || 1)), patch.amount); // urban ore hauls richer (whole units, no fractional pennies)
          patch.amount -= take;
          u.carrying = take;
          u.order = { type: 'return', patchId: patch.id };
        }
      }
      break;
    }

    case 'rearm': {
      // fly home and settle onto our pad slot; reloading happens while parked
      u.landed = false;
      const home = findPadFor(u);
      if (!home) { u.order = { type: 'idle' }; break; } // no airfield left — stranded
      if (u.slot === undefined) u.slot = freeSlot(home);
      // a one-slot pad host would park its resident dead center
      const [ox, oy] = padCapOf(home) === 1 ? [0, 6] : PAD_SLOT_POS[u.slot % PAD_CAP];
      const px = home.x + ox, py = home.y + oy;
      const arrived = stats.plane ? flyToward(u, px, py, dt, 16, true) : moveToward(u, px, py, dt, 5);
      if (arrived) {
        u.landed = true;
        delete u.exposedUntil; // back on the apron: the paint goes back on
        u.x = px; u.y = py;          // settle square on the pad markings
        u.facing = -Math.PI / 2;     // parked nose-north, RA2 style
        u.order = { type: 'idle' };
      }
      break;
    }

    case 'dig': {
      // Excavation Rig: park on the site and open it (public progress bar)
      const s = state.digSites.find(z => z.id === o.siteId);
      if (!s || s.taken || !stats.digger || s.progress >= DIG_TIME) { u.order = { type: 'idle' }; break; }
      if (dist(u, s) > 28 + stats.r) { moveToward(u, s.x, s.y, dt, 24 + stats.r); break; }
      u.facing = Math.atan2(s.y - u.y, s.x - u.x);
      u.digging = true; // art: spin the auger
      s.progress += dt;
      if (s.progress >= DIG_TIME) {
        s.progress = DIG_TIME;
        Particles.pulse(s.x, s.y, 26, [125, 255, 214]);
        if (u.owner === localOwner) eva('Relic exposed — send a Tech Priest');
        u.order = { type: 'idle' };
      }
      break;
    }

    case 'recover': {
      // Tech Priest: channel over the exposed relic, then teleport it home
      const s = state.digSites.find(z => z.id === o.siteId);
      if (!s || s.taken || s.progress < DIG_TIME || !stats.priest) { u.order = { type: 'idle' }; break; }
      if (dist(u, s) > 18 + stats.r) { moveToward(u, s.x, s.y, dt, 14 + stats.r); u.channelT = 0; break; }
      u.channelT = (u.channelT || 0) + dt;
      if (u.channelT >= 2) {
        u.channelT = 0;
        s.taken = true;
        bankRelic(u.owner, s.relic);
        Particles.pulse(u.x, u.y, 34, [125, 255, 214]);
        const hq = state.buildings.find(b => b.owner === u.owner && b.type === 'hq' && b.hp > 0);
        if (hq) {
          u.x = hq.x + (simRandom() - 0.5) * 30;
          u.y = hq.y + hq.h / 2 + 26;
          delete u.dodge; delete u.veer;
          Particles.pulse(u.x, u.y, 34, [125, 255, 214]);
        }
        u.order = { type: 'idle' };
      }
      break;
    }

    case 'salvage': {
      // Tech Priest: strip a fallen Guard/Dreadnought shell — the armor is
      // eternal, the meat is replaceable (halves the next ascension fee)
      const w = state.armorWrecks.find(z => z.id === o.wreckId);
      if (!w || w.owner !== u.owner || !stats.priest) { u.order = { type: 'idle' }; break; }
      if (dist(u, w) > 16 + stats.r) { moveToward(u, w.x, w.y, dt, 12 + stats.r); u.channelT = 0; break; }
      u.channelT = (u.channelT || 0) + dt;
      if (u.channelT >= 2.5) {
        u.channelT = 0;
        state.armorWrecks = state.armorWrecks.filter(z => z !== w);
        state.armorBank[u.owner][w.tier]++;
        Particles.pulse(w.x, w.y, 26, [125, 255, 214]);
        if (u.owner === localOwner) eva('Armor recovered — the next suit comes cheaper');
        u.order = { type: 'idle' };
      }
      break;
    }

    case 'ascend': {
      // walk into the Mechanicum, pay the fee, and be remade
      const b = findEntity(o.destId);
      const A = ASCEND[o.key];
      if (!A || !b || b.hp <= 0 || !b.done || b.type !== A.at || u.type !== A.from ||
          !ascendReady(u.owner, o.key)) {
        u.order = { type: 'idle' }; break;
      }
      if (!moveToward(u, b.x, b.y + b.h / 2 + 14, dt, 12, b.id)) break;
      const fee = ascendFee(u.owner, o.key);
      if (state.minerals[u.owner] < fee) { if (u.owner === localOwner) eva('Insufficient funds'); u.order = { type: 'idle' }; break; }
      state.minerals[u.owner] -= fee;
      // remember what this rite cost so it can be refunded if it never happens
      const salvaged = !!(A.tier && state.armorBank[u.owner][A.tier] > 0);
      if (salvaged) state.armorBank[u.owner][A.tier]--; // the banked suit is worn
      u.garrisoned = true;
      u.x = b.x; u.y = b.y;
      // THE SLAB TAKES ONE BODY AT A TIME. Joining the queue is all that
      // happens here; `at` (the finish time) is stamped by updateAbilities when
      // this body reaches the front of the line — an undefined `at` IS the
      // "still waiting my turn" state, and everything else keys off that.
      u.ascension = { to: o.key, bld: b.id, fee, salvaged };
      (b.rites = b.rites || []).push(u.id);
      u.order = { type: 'idle' };
      break;
    }

    case 'establish': {
      // park and become the building. It can go anywhere — deep in their
      // territory is the point — but not on top of something else.
      if (placementBlocked(u.owner, stats.establishes, u.x, u.y)) {
        if (u.owner === localOwner) eva('No room to open here');
        u.order = { type: 'idle' }; break;
      }
      const b = makeBuilding(u.owner, stats.establishes, u.x, u.y);
      b.done = true;
      u.abducted = true; u.hp = 0;    // consumed, no wreck
      Particles.pulse(b.x, b.y, 30, [190, 140, 255]);
      if (u.owner === localOwner) eva('Front company open for business');
      break;
    }

    // ---------- Marksman: walk out there and bury it ----------
    case 'plant': {
      if (!u.caches) { u.order = { type: 'idle' }; break; }
      if (moveToward(u, o.x, o.y, dt, 8)) {
        plantCache(u, u.x, u.y);
        u.order = { type: 'idle' };
      }
      break;
    }
    // ---------- Marksman: home for more ----------
    // The round trip is the tax on the whole cache system. A Chuck Wagon in the
    // field pays it off (BUGOUT_KITS.homesteader), which is most of why you
    // would build one.
    case 'resupply': {
      const src = findEntity(o.destId);
      const ok = src && src.hp > 0 && src.owner === u.owner &&
        (src.kind === 'building' ? (bstatsOf(src).homestead || src.type === 'barracks')
                                 : vanKitOf(src) === 'homesteader');
      if (!ok) { u.order = { type: 'idle' }; break; }
      if (moveToward(u, src.x, src.y, dt, entityRadius(src) * 0.8 + 10, src.id)) {
        u.resupplyT = (u.resupplyT || 0) + dt;
        if (u.resupplyT >= CACHE_RESUPPLY) {
          u.resupplyT = 0;
          u.caches = UNIT_TYPES[u.type].caches || 0;
          if (u.owner === localOwner) eva('Marksman resupplied');
          u.order = { type: 'idle' };
        }
      } else u.resupplyT = 0;
      break;
    }
    // ---------- Ex-Special Forces: stick a charge on it ----------
    case 'demo': {
      const b = findEntity(o.destId);
      if (!u.charges || !b || b.hp <= 0 || b.kind !== 'building' || b.owner === u.owner) {
        u.order = { type: 'idle' }; break;
      }
      if (moveToward(u, b.x, b.y, dt, entityRadius(b) * 0.8 + 10, b.id)) {
        u.demoT = (u.demoT || 0) + dt;
        if (u.demoT >= DEMO_PLANT) { u.demoT = 0; plantCharge(u, b); u.order = { type: 'idle' }; }
      } else u.demoT = 0;
      break;
    }
    // ---------- the run in, and the jump ----------
    case 'airdrop': {
      if (moveToward(u, o.x, o.y, dt, 14)) {
        const n = u.crewCount || BUSHPLANE_CREW;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2;
          makeUnit(u.owner, 'specops', u.x + Math.cos(a) * 26, u.y + Math.sin(a) * 26);
        }
        Particles.pulse(u.x, u.y, 34, [235, 220, 160]);
        if (u.owner === localOwner) eva('Team on the ground');
        u.crewCount = 0;                      // empty now: shooting it down costs nothing
        // turn for the nearest map edge and go home the long way
        const ex = (u.x < WORLD_W / 2) ? -80 : WORLD_W + 80;
        u.order = { type: 'depart', x: ex, y: u.y };
      }
      break;
    }
    case 'depart': {
      if (moveToward(u, o.x, o.y, dt, 20) ||
          u.x < -60 || u.y < -60 || u.x > WORLD_W + 60 || u.y > WORLD_H + 60) {
        u.hp = 0; u.abducted = true;          // off the map, no wreck
      }
      break;
    }
    // ---------- Journalist: get the story ----------
    case 'film': {
      const tgt = findEntity(o.destId);
      if (!tgt || tgt.hp <= 0 || tgt.owner === u.owner || tgt.owner === NEUTRAL ||
          (u.proof || 0) >= journoCap(u)) {
        u.filming = false; u.order = { type: 'idle' }; break;
      }
      const reach = entityRadius(tgt) + 26;
      if (moveToward(u, tgt.x, tgt.y, dt, reach, tgt.id)) {
        u.filming = true;
        u.proof = Math.min(journoCap(u), (u.proof || 0) + filmRate(u) * dt);
        if ((u.proof || 0) >= journoCap(u)) {
          u.filming = false;
          if (u.owner === localOwner) eva('Footage complete — get it home');
          // full camera walks itself back rather than standing in their base
          const drop = nearest(u, proofDropoffs(u.owner), () => true);
          u.order = drop ? { type: 'filepiece', destId: drop.id } : { type: 'idle' };
        }
      } else u.filming = false;
      break;
    }
    // ---------- ...and file it ----------
    case 'filepiece': {
      const drop = findEntity(o.destId);
      if (!drop || drop.hp <= 0 || drop.owner !== u.owner || !(u.proof > 0)) {
        u.order = { type: 'idle' }; break;
      }
      if (moveToward(u, drop.x, drop.y, dt, entityRadius(drop) + 14, drop.id)) {
        const rejected = handInProof(u.owner, u.proof);
        const filed = Math.round(u.proof - rejected);
        u.proof = rejected;
        if (u.owner === localOwner) {
          eva(rejected > 0 ? `Filed ${filed} proof — the vaults are full`
                           : `Filed ${filed} proof`);
        }
        u.order = { type: 'idle' };
      }
      break;
    }
    // ---------- walk to the van and get welded in ----------
    case 'fitvan': {
      const van = findEntity(o.destId);
      if (!van || van.hp <= 0 || van.owner !== u.owner || !UNIT_TYPES[van.type].loader || vanKitOf(van)) {
        u.order = { type: 'idle' }; break;
      }
      if (moveToward(u, van.x, van.y, dt, UNIT_TYPES[van.type].r + stats.r + 6)) {
        loadVanKit(van, u);
        u.order = { type: 'idle' };
      }
      break;
    }
    // ---------- Marksman: climb aboard the Bush Plane ----------
    case 'boardplane': {
      const b = findEntity(o.destId);
      if (!b || b.hp <= 0 || b.owner !== u.owner || !bstatsOf(b).bushplane || b.launched ||
          planeCrew(b) >= BUSHPLANE_CREW) { u.order = { type: 'idle' }; break; }
      if (moveToward(u, b.x, b.y, dt, entityRadius(b) * 0.8 + 10, b.id)) {
        boardPlane(b, u);
        u.order = { type: 'idle' };
      }
      break;
    }
    // ---------- militia: walk to the cache and come back up as something ----------
    case 'drawkit': {
      const b = findEntity(o.destId);
      if (!b || b.hp <= 0 || !b.kits || b.owner !== u.owner) { u.order = { type: 'idle' }; break; }
      if (moveToward(u, b.x, b.y, dt, entityRadius(b) * 0.8 + 10, b.id)) {
        u.kitT = (u.kitT || 0) + dt;
        if (u.kitT >= CACHE_CONVERT) { u.kitT = 0; drawKit(u, b, o.kit); }
      } else u.kitT = 0;
      break;
    }

    case 'probe': {
      // probe drone: fly onto the mark and PAINT it — lasting vision plus a
      // designation that makes the owner's whole army hit it 30% harder. The
      // drone survives and can be re-tasked to paint the next target.
      const tgt = findEntity(o.targetId);
      if (!tgt || tgt.kind !== 'unit' || tgt.hp <= 0 || tgt.garrisoned || tgt.transit) {
        u.order = { type: 'idle' };
        break;
      }
      if (moveToward(u, tgt.x, tgt.y, dt, UNIT_TYPES[tgt.type].r + 6)) {
        tgt.trackedBy = tgt.trackedBy || {};
        tgt.trackedBy[u.owner] = true;
        tgt.designatedBy = u.owner;
        tgt.designatedUntil = state.time + 20;
        u.order = { type: 'idle' };
        Particles.pulse(tgt.x, tgt.y, 30, [125, 255, 214]);
        if (u.owner === localOwner) eva('Target designated');
      }
      break;
    }

    case 'capture': {
      // engineer: walk onto an enemy structure and flip it to our flag
      const b = findEntity(o.targetId);
      if (!b || b.kind !== 'building' || b.hp <= 0 || b.owner === u.owner || b.owner === NEUTRAL) {
        u.order = { type: 'idle' };
        break;
      }
      if (moveToward(u, b.x, b.y, dt, entityRadius(b) * 0.7, b.id) ||
          rectDist(u, b) <= stats.r + 8) {
        // evict any old-owner garrison before the flag changes hands
        if (b.garrison && b.garrison.length) {
          let gi = 0;
          for (const id of b.garrison) {
            const g = state.units.find(x => x.id === id && x.hp > 0);
            if (!g) continue;
            const a = (gi++ / b.garrison.length) * Math.PI * 2;
            g.garrisoned = null;
            g.x = b.x + Math.cos(a) * (entityRadius(b) + 14);
            g.y = b.y + Math.sin(a) * (entityRadius(b) + 14);
            g.order = { type: 'idle' };
          }
          b.garrison = [];
        }
        const wasPlayers = b.owner === localOwner;
        b.owner = u.owner;
        b.queue = [];
        b.rally = null;
        b.beamId = null;
        u.hp = 0; // the engineer stays behind to run the place
        if (u.owner === localOwner) eva('Structure captured');
        else if (wasPlayers) eva('They have taken one of our structures');
      }
      break;
    }

    case 'repair': {
      // mobile repair unit: chase the patient, then weld it back together
      const tgt = findEntity(o.targetId);
      if (!tgt || tgt.kind !== 'unit' || tgt.hp <= 0 || tgt.hp >= tgt.maxHp || tgt.garrisoned) {
        u.order = { type: 'idle' };
        break;
      }
      if (dist(u, tgt) > 50) { moveToward(u, tgt.x, tgt.y, dt, 38); break; }
      u.facing = Math.atan2(tgt.y - u.y, tgt.x - u.x);
      tgt.hp = Math.min(tgt.maxHp, tgt.hp + stats.repair * dt);
      u.welding = (u.welding || 0) - dt;
      if (u.welding <= 0) {
        u.welding = 0.3;
        Particles.bolt(u.x, u.y, tgt.x, tgt.y, [140, 255, 170], UNIT_TYPES[u.type].flying ? unitAlt(u) : 8);
      }
      break;
    }

    case 'garrison': {
      // walk to a civilian structure and climb in
      const b = findEntity(o.destId);
      const slots = (b && b.kind === 'building' && b.hp > 0) ? slotsOf(b) : 0;
      if (!slots || (b.owner !== NEUTRAL && b.owner !== u.owner) || b.garrison.length >= slots) {
        u.order = { type: 'idle' };
        break;
      }
      if (moveToward(u, b.x, b.y, dt, entityRadius(b) * 0.7, b.id)) {
        if (b.garrison.length < slots) {
          b.garrison.push(u.id);
          b.owner = u.owner; // the occupier claims the structure
          u.garrisoned = b.id;
          u.x = b.x;
          u.y = b.y;
        }
        u.order = { type: 'idle' };
      }
      break;
    }

    case 'board': {
      // climb into a friendly transport (Bradley ports, technical bed)
      const tr = findEntity(o.destId);
      const cap = (tr && tr.kind === 'unit' && tr.hp > 0) ? UNIT_TYPES[tr.type].cargoCap : 0;
      if (!cap || tr.owner !== u.owner || (tr.cargo || []).length >= cap) {
        u.order = { type: 'idle' };
        break;
      }
      // arrival ring must clear the separation push (both radii + slack), or
      // the passenger walks forever at arm's length from the door
      if (moveToward(u, tr.x, tr.y, dt, UNIT_TYPES[tr.type].r + stats.r + 8)) {
        tr.cargo = tr.cargo || [];
        if (tr.cargo.length < cap) {
          tr.cargo.push(u.id);
          u.garrisoned = true;
          u.transportId = tr.id;
          u.x = tr.x; u.y = tr.y;
        }
        u.order = { type: 'idle' };
      }
      break;
    }

    case 'tunnel': {
      // hollow earth: walk to the nearest network node, drop underground, and
      // surface at the destination node after a distance-scaled transit
      const dest = findEntity(o.destId);
      if (!dest || dest.hp <= 0) { u.order = { type: 'idle' }; break; }
      const entrance = nearest(u, state.buildings, b =>
        b.owner === u.owner && b.hp > 0 && b.done && TUNNEL_NODES.includes(b.type));
      if (!entrance) { u.order = { type: 'idle' }; break; }
      if (entrance.id === dest.id) { u.order = { type: 'idle' }; break; } // already there
      if (moveToward(u, entrance.x, entrance.y, dt, entityRadius(entrance) + 8, entrance.id)) {
        u.garrisoned = -1; // underground: unselectable, untargetable, unseen
        u.transit = { srcId: entrance.id, destId: dest.id, arrive: state.time + 1 + dist(entrance, dest) / TUNNEL_SPEED };
        u.order = { type: 'idle' };
        u.burrowed = false;
        const si = selection.indexOf(u);
        if (si >= 0) { selection.splice(si, 1); refreshPanel(); }
      }
      break;
    }

    case 'deliver': {
      // resistance smuggler truck hauling minerals home
      const hq = state.buildings.find(b => b.owner === u.owner && b.type === 'hq' && b.hp > 0);
      if (!hq) { u.order = { type: 'idle' }; break; }
      if (moveToward(u, hq.x, hq.y, dt, entityRadius(hq) + 12, hq.id) ||
          rectDist(u, hq) <= UNIT_TYPES[u.type].r + 14) {
        state.minerals[u.owner] += u.payload || SMUGGLE_BASE;
        u.hp = 0;
        if (u.owner === localOwner) eva('Supplies delivered — $' + (u.payload || SMUGGLE_BASE));
      }
      break;
    }

    case 'return': {
      const depot = depositTarget(u);
      if (!depot) { u.order = { type: 'idle' }; break; }
      // walk to the nearest WALL, not the middle: the whole footprint unloads
      const dock = dockPoint(u, depot);
      // touching any wall of the depot counts — a hauler pressed against the
      // HQ by traffic or neighboring buildings must not be told "not close enough"
      if (moveToward(u, dock.x, dock.y, dt, UNIT_TYPES[u.type].r + 6, depot.id) ||
          rectDist(u, depot) <= UNIT_TYPES[u.type].r + 14) {
        // THE AUDIT: a hostile Front Company within reach of this drop-off
        // takes its cut off the top. The victim is told NOTHING — they simply
        // bank less than they mined and have to work out why.
        let load = u.carrying;
        const field = state.patches.find(p => p.id === o.patchId);
        const skimmer = nearest(depot, state.buildings, b => b.hp > 0 && b.owner !== u.owner &&
          b.owner !== NEUTRAL && bstatsOf(b).thief &&
          (dist(b, depot) <= bstatsOf(b).thief.r ||            // sat on their depot
           (field && dist(b, field) <= bstatsOf(b).thief.r))); // ...or on the field they worked
        if (skimmer) {
          // every Federal Reserve standing widens the take
          const boost = state.buildings.reduce((n, b) => n + (b.owner === skimmer.owner && b.hp > 0 &&
            b.done && bstatsOf(b).skimBoost ? bstatsOf(b).skimBoost : 0), 0);
          const rate = Math.min(0.75, bstatsOf(skimmer).thief.cut + boost);
          const cut = Math.min(load, Math.max(1, Math.round(load * rate)));
          load -= cut;
          state.leverage[skimmer.owner] = (state.leverage[skimmer.owner] || 0) + cut;
          state.minerals[skimmer.owner] += cut;
          skimmer.skimT = state.time;                 // the plaque flickers (art)
          skimmer.skimAmt = cut;
          state.floats.push({ x: skimmer.x, y: skimmer.y - 18, text: '+' + cut, t: state.time, col: '#c9a7ff' });
          if (skimmer.owner === localOwner && !skimHintSeen) {
            skimHintSeen = true;
            eva('First cut banked — spend LEVERAGE from your HQ or any front company');
          }
        }
        // Sponsors Pulled Out: their backers are gone and the load is worth half
        state.minerals[u.owner] += bcastAgainst(u.owner, 'sponsors')
          ? Math.round(load * BROADCASTS.sponsors.mul) : load;
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

  separateFromNeighbors(u, stats);
}

// spatial hash for the separation pass — the old all-pairs sweep was O(n²)
// across the whole map and chewed frame time once armies got big
const SEP_CELL = 48; // > 2x the largest unit radius, so 3x3 cells cover any pair
const sepGrid = new Map();
function rebuildSepGrid() {
  sepGrid.clear();
  for (const u of state.units) {
    if (u.hp <= 0 || u.garrisoned) continue;
    const key = ((u.x / SEP_CELL) | 0) * 4096 + ((u.y / SEP_CELL) | 0);
    const cell = sepGrid.get(key);
    if (cell) cell.push(u); else sepGrid.set(key, [u]);
  }
}

// live + queued count of one unit type, for limit-capped units (mining rigs)
function unitCount(owner, type) {
  let n = 0;
  for (const u of state.units) if (u.owner === owner && u.hp > 0 && u.type === type) n++;
  for (const b of state.buildings) {
    if (b.owner === owner && b.hp > 0) n += b.queue.filter(j => j.type === type).length;
  }
  return n;
}

// how many of a capped unit this owner may field RIGHT NOW: the base limit
// plus one per operational drop-off — while a Refinery stands, the miner
// count stays adjusted up; lose it and the cap settles back down
function minerCap(owner, unitType) {
  const ut = UNIT_TYPES[unitType];
  if (!ut.limit) return Infinity;
  let bonus = ut.role === 'worker'
    ? state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.done && bstatsOf(b).dropoff).length : 0;
  // the pit deepens twice over, and the two stack: the Gene Vault breeds a
  // bigger crop (+4), and the Bloodline Throne's authority works another four
  // out of them (+4). Both only while the structure actually stands, and only
  // for the Slave line — the Broodslave is Vault-gated already and keeps its
  // own flat cap on top, rather than doubling up on the same bonuses.
  if (ut.pitBonus) {
    if (hasStruct(owner, 'tech')) bonus += 4;
    if (hasStruct(owner, 'superweapon')) bonus += 4;
  }
  return ut.limit + bonus;
}

// how hard the lash falls: the per-owner slave work regime. Brutal drives the
// fields 35% faster and works slaves to death in half the time (loosh gushes,
// replacements drain the bank); Merciful lets them live 60% longer (cheap,
// but the loosh slows to a drip).
const SLAVE_DRIVES = ['Merciful', 'Normal', 'Brutal'];
function slaveDriveOf(owner) { return (state.slaveDrive && state.slaveDrive[owner]) || 'Normal'; }
function driveMineMul(owner) { return slaveDriveOf(owner) === 'Brutal' ? 1.35 : 1; }
function driveLifeMul(owner) { const d = slaveDriveOf(owner); return d === 'Brutal' ? 0.55 : d === 'Merciful' ? 1.6 : 1; }

function trainUnit(owner, unitType) {
  const ut = UNIT_TYPES[unitType];
  if (ut.req && !hasStruct(owner, ut.req)) return false;
  if (ut.limit && unitCount(owner, unitType) >= minerCap(owner, unitType)) return false;
  let trainers = state.buildings.filter(b =>
    b.owner === owner && b.hp > 0 && b.done && b.type === ut.builtAt && b.queue.length < 5);
  if (ut.pad) trainers = trainers.filter(b => padLoad(b) < padCapOf(b)); // needs a free pad slot
  if (!trainers.length) return false;
  if (state.minerals[owner] < ut.cost) return false;
  if ((ut.loosh || 0) > (state.loosh[owner] || 0)) return false; // caste tier runs on loosh
  trainers.sort((a, b) => ut.pad ? padLoad(a) - padLoad(b) : a.queue.length - b.queue.length);
  state.minerals[owner] -= ut.cost;
  if (ut.loosh) state.loosh[owner] -= ut.loosh;
  // Deep Forges relic: the assembly lines remember how it was done
  trainers[0].queue.push({ type: unitType, t: 0, duration: ut.buildTime });
  return true;
}

function updateBuilding(b, dt) {
  const bt = bstatsOf(b);
  const power = powerOf(b.owner);

  // ---------- controlled demolition ----------
  // Runs before everything else and returns: a structure being pulled down is
  // not producing, charging or shooting. It is NOT cancelled by taking damage —
  // the counterplay is to finish it off before the timer expires, which denies
  // the refund entirely.
  if (b.demolishT !== undefined) {
    b.demolishT -= dt;
    Particles.smoke(b.x + (fxRandom() - 0.5) * b.w * 0.7, b.y - b.h / 4, 3);
    if (b.demolishT <= 0) {
      state.minerals[b.owner] = (state.minerals[b.owner] || 0) + demolishRefund(b);
      b.demolished = true; // the death sweep skips the wreck effects for this one
      b.hp = 0;
      if (b.owner === localOwner) eva('Structure demolished');
    }
    return;
  }

  // ---------- repair (every faction, every structure) ----------
  // Mending runs on the same grid as everything else: a brownout halves the
  // rate and an EMP stops it dead. Running out of minerals switches the job
  // OFF and says so rather than stalling silently, so the button never claims
  // to be doing something it isn't.
  //
  // MINERALS ARE WHOLE NUMBERS. A repair tick costs a fraction of one, so the
  // fraction is banked on the building (repairOwed) and only whole minerals are
  // ever taken out of the treasury — otherwise a few seconds of welding turned
  // the player's balance into 1483.6274 and every other price in the game reads
  // as an integer.
  if (b.repairing) {
    if (!canRepair(b)) {
      b.repairing = false;
      b.repairOwed = 0;
    } else {
      const mult = power.low ? 0.5 : 1;
      b.repairOwed = (b.repairOwed || 0) + repairCostPerSec(b) * mult * dt;
      const due = Math.floor(b.repairOwed);
      if (due > state.minerals[b.owner]) {
        b.repairing = false;
        b.repairOwed = 0;
        if (b.owner === localOwner) eva('Repairs stopped — out of minerals');
      } else {
        if (due > 0) { state.minerals[b.owner] -= due; b.repairOwed -= due; }
        b.hp = Math.min(b.maxHp, b.hp + repairRateOf(b) * mult * dt);
        b.repairT = state.time; // the welding sparks key off this
        if (b.hp >= b.maxHp) {
          b.repairing = false;
          b.repairOwed = 0; // the last part-mineral is forgiven, not carried
          if (b.owner === localOwner) eva(buildingName(b) + ' restored');
        }
      }
    }
  }

  // buried mines: lie in wait, detonate when enemy ground forces roll over
  // (setting hp to 0 hands off to the death handler, which fires `explodes`)
  if (bt.trip && b.done) {
    b.tripT = (b.tripT === undefined ? (b.id % 10) * 0.05 : b.tripT) - dt;
    if (b.tripT <= 0) {
      b.tripT = 0.25;
      const prey = state.units.some(u => u.owner !== b.owner && u.hp > 0 && !u.garrisoned &&
        !u.transit && !u.burrowed && !UNIT_TYPES[u.type].flying && dist(u, b) <= bt.trip + UNIT_TYPES[u.type].r);
      if (prey) b.hp = 0;
    }
    return;
  }

  // landmark auras only work once the site is actually claimed
  if (b.done && b.owner !== NEUTRAL) updateCapturedAuras(b, bt, dt);

  // repair pad: mends the owner's vehicles and aircraft sitting on it
  if (bt.repairRate && b.done && !power.low) {
    b.repT = (b.repT || 0) - dt;
    if (b.repT <= 0) {
      b.repT = 0.5;
      for (const u of state.units) {
        if (u.owner !== b.owner || u.hp <= 0 || u.hp >= u.maxHp || u.garrisoned) continue;
        const ut = UNIT_TYPES[u.type];
        if (ut.builtAt !== 'factory' && !ut.flying) continue;
        if (rectDist(u, b) <= 30) {
          u.hp = Math.min(u.maxHp, u.hp + bt.repairRate * 0.5);
          if (fxRandom() < 0.3) Particles.smoke(u.x + (fxRandom() - 0.5) * 14, u.y, 1.5, 6);
        }
      }
    }
  }

  // superweapon: charge while powered, halt when blacked out
  if (bt.superweapon && b.done) {
    if (!power.low && !isOffline(b)) {
      // (the Bloodline Throne no longer siphons the bank to charge faster —
      // loosh is spent at FIRING time: 60 minimum, up to 200 for a wider coup)
      b.charge = Math.min(superChargeOf(b), (b.charge || 0) + dt);
    }
    if (b.owner === localOwner && !announcedSuper.has(b.id) && superReady(b)) {
      announcedSuper.add(b.id); eva('Superweapon ready');
    }
    if ((b.charge || 0) < superChargeOf(b)) announcedSuper.delete(b.id);
  }

  // blacked-out structures do nothing: no fire, no production. A tractor beam
  // that gets EMP'd drops its lock (so the beam can't keep drawing / holding
  // an aircraft while the tower is dark).
  if (isOffline(b)) {
    if (b.beamId) b.beamId = null;
    if (fxRandom() < 0.25) Particles.smoke(b.x + (fxRandom() - 0.5) * b.w * 0.6, b.y - b.h / 2, 2);
    return;
  }

  // damaged buildings smolder
  if (b.hp < b.maxHp * 0.5 && fxRandom() < 0.04) {
    Particles.smoke(b.x + (fxRandom() - 0.5) * b.w * 0.7, b.y - b.h / 2, 3);
  }

  // garrisoned civilian structures fight for their occupier
  if (b.garrison && b.garrison.length && b.owner !== NEUTRAL) {
    b.cooldown = Math.max(0, b.cooldown - dt);
    if (b.cooldown <= 0) {
      const squad = b.garrison.map(id => state.units.find(u => u.id === id && u.hp > 0)).filter(Boolean);
      const anyAA = squad.some(u => hitsAir(UNIT_TYPES[u.type]));
      // Most garrisons are people leaning out of a window. A Patriot Pillbox is
      // poured concrete with proper firing slits and a rest to brace on, so the
      // same rifles reach considerably further out of it (garrisonRange).
      const gr = bt.garrisonRange || GARRISON_RANGE;
      const foe = nearest(b, enemiesOf(b.owner), e => !hiddenFrom(e, b.owner) &&
        dist(b, e) <= gr + entityRadius(e) &&
        (anyAA || !(e.kind === 'unit' && UNIT_TYPES[e.type].flying)));
      if (foe) {
        b.cooldown = GARRISON_COOLDOWN;
        const foeAir = foe.kind === 'unit' && UNIT_TYPES[foe.type].flying;
        const dmg = squad.reduce((s, u) => {
          const ut = UNIT_TYPES[u.type];
          return (foeAir && !hitsAir(ut)) ? s : s + (ut.dmg || 0);
        }, 0) * GARRISON_DMG_SCALE;
        if (dmg > 0) {
          dealDamage(b, foe, dmg, {});
          b.turret = Math.atan2(foe.y - b.y, foe.x - b.x);
          Particles.shot(b.x + Math.cos(b.turret) * (b.w / 2), b.y + Math.sin(b.turret) * (b.h / 2),
            foe.x, foe.y, 'bullet', 10, foe.kind === 'unit' ? unitAlt(foe) : 0);
          if (tileState(b.x, b.y) === 2) sfx('shot');
        }
      }
    }
  }

  // towers shoot (unless the grid is down)
  if (bt.dmg && !power.low) fireTower(b, bt, dt);

  // A homestead grows its people back — slowly, one body per HOMESTEAD_REFILL,
  // and ONLY for people it has actually lost. Mustering the yard out costs you
  // that farm's income until they walk back; it does not conjure replacements
  // while the originals are still alive somewhere on the map.
  // The farm also runs at whatever fraction of its yard is standing in it, so a
  // raid that kills three militia is an economic wound as well as a military
  // one — three quarters of that farm's output, gone for over two minutes.
  if (bt.homestead) {
    if (farmPopulation(b) < slotsOf(b) && b.garrison.length < slotsOf(b)) {
      b.refillT = (b.refillT || 0) + dt;
      if (b.refillT >= HOMESTEAD_REFILL) { b.refillT = 0; stockHomestead(b, 1); }
    } else b.refillT = 0;
  }

  advanceProduction(b, power, dt);
}

// ---------- what a claimed landmark does for whoever holds it ----------
// None of this runs for a neutral, unclaimed site — a landmark is inert until
// somebody garrisons it. The caller gates on `b.done && b.owner !== NEUTRAL`.
function updateCapturedAuras(b, bt, dt) {
  // hospital / fuel depot: mends the owner's nearby units in a radius; a depot
  // also tops off passing aircraft so they needn't fly home to rearm
  if (bt.healAura) {
    b.healT = (b.healT || 0) - dt;
    if (b.healT <= 0) {
      b.healT = 0.5;
      for (const u of state.units) {
        if (u.owner !== b.owner || u.hp <= 0 || u.garrisoned || dist(u, b) > bt.healAura.r) continue;
        if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + bt.healAura.rate * 0.5);
        if (bt.rearm && UNIT_TYPES[u.type].maxAmmo) u.ammo = UNIT_TYPES[u.type].maxAmmo;
      }
    }
  }
  // Research Lab / Monument: emboldens the owner's units (buffedUntil is read
  // in the damage step for +25%)
  if (bt.buffAura) {
    b.auraT = (b.auraT || 0) - dt;
    if (b.auraT <= 0) {
      b.auraT = 0.4;
      for (const u of state.units)
        if (u.owner === b.owner && u.hp > 0 && !u.garrisoned && dist(u, b) <= bt.buffAura.r) u.buffedUntil = state.time + 0.6;
    }
  }
  // 5G Mast: weakens enemy units nearby (−45% damage)
  if (bt.debuffAura) {
    b.debT = (b.debT || 0) - dt;
    if (b.debT <= 0) {
      b.debT = 0.4;
      for (const e of state.units)
        if (e.owner !== b.owner && e.owner !== NEUTRAL && e.hp > 0 && !e.garrisoned && dist(e, b) <= bt.debuffAura.r) e.weakenedUntil = state.time + 0.6;
    }
  }
  // Black Site: staffs a DETACHMENT, it does not print an army. Each site keeps
  // up to `max` of its unit alive and replaces losses; hold it all game and you
  // get a standing squad, not thirty free Men in Black. Units are tagged with
  // the site that made them, so two captured sites field two detachments rather
  // than sharing one cap.
  if (bt.spawns) {
    const cap = bt.spawns.max || Infinity;
    const mine = cap === Infinity ? 0 : state.units.reduce((n, u) =>
      n + (u.hp > 0 && u.spawnedBy === b.id && u.owner === b.owner ? 1 : 0), 0);
    if (mine >= cap) {
      b.spawnT = 0; // at strength: the clock only runs once there's a gap to fill
    } else {
      b.spawnT = (b.spawnT || 0) + dt;
      if (b.spawnT >= bt.spawns.every) {
        b.spawnT = 0;
        const u = makeUnit(b.owner, bt.spawns.type, b.x + (simRandom() - 0.5) * 20, b.y + b.h / 2 + 22);
        u.spawnedBy = b.id;
        if (b.owner === localOwner) eva('Reinforcements salvaged');
      }
    }
  }
  // TV Station: manufactures consent — flips a random enemy combat unit to the
  // owner every so often
  if (bt.convert) {
    b.convT = (b.convT || 0) + dt;
    if (b.convT >= bt.convert.every) {
      b.convT = 0;
      const pool = state.units.filter(u => u.owner !== b.owner && u.owner !== NEUTRAL && u.hp > 0 && !u.garrisoned &&
        u.type !== 'phantom' && UNIT_TYPES[u.type].role === 'combat' &&
        dist(u, b) <= bt.convert.r);
      if (pool.length) {
        const v = pool[Math.floor(simRandom() * pool.length)];
        if (disproved(v.owner, 'actors')) {
          v.coupOrig = v.coupOrig !== undefined ? v.coupOrig : v.owner;
          v.coupRevert = state.time + ACTORS_RETURN;
        }
        v.owner = b.owner; v.disguised = false; v.order = { type: 'idle' };
        Particles.pulse(v.x, v.y, 30, [150, 200, 255]);
      }
    }
  }
}

// a defensive structure's weapon, dispatched on its weapon kind
function fireTower(b, bt, dt) {
  b.cooldown = Math.max(0, b.cooldown - dt);
  const wkind = bt.weapon || 'gun';

  if (wkind === 'pulse') {
    // radiation field: hurts EVERY enemy ground unit in radius
    if (b.cooldown <= 0) {
      const victims = state.units.filter(u => u.owner !== b.owner && u.hp > 0 && !hiddenFrom(u, b.owner) &&
        !UNIT_TYPES[u.type].flying && dist(b, u) <= bt.atkRange + UNIT_TYPES[u.type].r);
      if (victims.length) {
        b.cooldown = bt.cooldown;
        for (const v of victims) dealDamage(b, v, bt.dmg, bt);
        Particles.pulse(b.x, b.y, bt.atkRange, [140, 208, 255]);
        if (tileState(b.x, b.y) === 2) sfx('laser');
      }
    }
  } else if (wkind === 'chain') {
    // arcs to up to 2 extra targets at 60% falloff per hop
    if (b.cooldown <= 0) {
      const foe = nearest(b, enemiesOf(b.owner), e => !hiddenFrom(e, b.owner) && canTarget(bt, e) && dist(b, e) <= bt.atkRange + entityRadius(e));
      if (foe) {
        b.cooldown = bt.cooldown;
        b.turret = Math.atan2(foe.y - b.y, foe.x - b.x);
        const hit = new Set();
        let prev = b, cur = foe, dmg = bt.dmg;
        for (let hop = 0; hop < 3 && cur; hop++) {
          Particles.bolt(prev.x, prev.y, cur.x, cur.y, [201, 167, 255]);
          dealDamage(b, cur, dmg, bt);
          hit.add(cur.id);
          dmg *= 0.6;
          prev = cur;
          cur = nearest(prev, state.units, un => un.owner !== b.owner && un.hp > 0 && !hiddenFrom(un, b.owner) &&
            !UNIT_TYPES[un.type].flying && !hit.has(un.id) && dist(prev, un) <= 85);
        }
        if (tileState(b.x, b.y) === 2 || tileState(foe.x, foe.y) === 2) sfx('laser');
      }
    }
  } else if (wkind === 'missile') {
    // patriot battery: launches a visible homing missile. Sticky target:
    // keep pounding the same craft while it's valid instead of flitting to
    // whatever drifted 2px closer this shot.
    if (b.cooldown <= 0) {
      let foe = b.foeId ? state.units.find(un => un.id === b.foeId) : null;
      if (!foe || foe.hp <= 0 || foe.garrisoned || hiddenFrom(foe, b.owner) || !canTarget(bt, foe) ||
          dist(b, foe) > bt.atkRange + entityRadius(foe)) {
        foe = nearestTarget(b, state.units, un => un.owner !== b.owner && un.hp > 0 &&
          !hiddenFrom(un, b.owner) && !un.garrisoned && canTarget(bt, un) &&
          dist(b, un) <= bt.atkRange + entityRadius(un));
      }
      b.foeId = foe ? foe.id : null;
      if (foe) {
        b.cooldown = bt.cooldown;
        b.turret = Math.atan2(foe.y - b.y, foe.x - b.x);
        state.projectiles.push({
          kind: 'missile', x: b.x, y: b.y, targetId: foe.id,
          owner: b.owner, stats: bt, angle: b.turret, speed: 320, life: 4,
        });
        if (tileState(b.x, b.y) === 2) sfx('shot');
      }
    }
  } else if (wkind === 'beam') {
    // continuous lock: drains and slows one aircraft
    let tgt = b.beamId ? state.units.find(un => un.id === b.beamId && un.hp > 0) : null;
    if (!tgt || hiddenFrom(tgt, b.owner) || !canTarget(bt, tgt) || dist(b, tgt) > bt.atkRange + entityRadius(tgt) + 12) {
      tgt = nearest(b, state.units, un => un.owner !== b.owner && un.hp > 0 && !hiddenFrom(un, b.owner) &&
        canTarget(bt, un) && dist(b, un) <= bt.atkRange + entityRadius(un));
    }
    if (tgt) {
      // the lock holds the craft down and drains it. It no longer hauls the
      // victim away — a five-second timer that deleted an aircraft outright
      // was either irrelevant or unanswerable, with nothing in between.
      b.beamId = tgt.id;
      b.turret = Math.atan2(tgt.y - b.y, tgt.x - b.x);
      if (b.cooldown <= 0) {
        b.cooldown = bt.cooldown;
        dealDamage(b, tgt, bt.dmg, bt);
        tgt.slowUntil = state.time + 0.25;   // pinned in the beam, as before
      }
    } else {
      b.beamId = null;
      b.beamHold = 0;
    }
  } else if (bt.weapon === 'quake' && b.cooldown <= 0) {
    // Seismic Imitator: a piston slam sends a visible crack racing along
    // the ground into its target (same wave the Quake Truck fires)
    let foe = b.foeId ? findEntity(b.foeId) : null;
    if (!foe || foe.hp <= 0 || foe.garrisoned || hiddenFrom(foe, b.owner) || !canTarget(bt, foe) ||
        dist(b, foe) > bt.atkRange + entityRadius(foe)) {
      foe = nearestTarget(b, enemiesOf(b.owner), e => !hiddenFrom(e, b.owner) && canTarget(bt, e) && dist(b, e) <= bt.atkRange + entityRadius(e));
    }
    b.foeId = foe ? foe.id : null;
    if (foe) {
      state.zones.push({
        kind: 'wave', x: b.x, y: b.y + b.h / 2, tx: foe.x, ty: foe.y, r: 12, speed: 460,
        until: state.time + 4, caster: b.owner, dmg: bt.dmg,
        bldgBonus: 1.2, splash: 34, stun: 0.45,
      });
      b.cooldown = bt.cooldown;
      b.turret = Math.atan2(foe.y - b.y, foe.x - b.x);
      if (tileState(b.x, b.y) === 2) sfx('boom');
    }
  } else if (b.cooldown <= 0) {
    // sticky target: a tower keeps shooting what it's shooting while that
    // target stays valid — fresh bodies appearing nearby (a squad piling out
    // of a transport) no longer instantly pull every shot off the vehicle
    let foe = b.foeId ? findEntity(b.foeId) : null;
    if (!foe || foe.hp <= 0 || foe.garrisoned || hiddenFrom(foe, b.owner) || !canTarget(bt, foe) ||
        dist(b, foe) > bt.atkRange + entityRadius(foe)) {
      foe = nearestTarget(b, enemiesOf(b.owner), e => !hiddenFrom(e, b.owner) && canTarget(bt, e) && dist(b, e) <= bt.atkRange + entityRadius(e));
    }
    b.foeId = foe ? foe.id : null;
    if (foe) {
      dealDamage(b, foe, bt.dmg, bt);
      b.cooldown = bt.cooldown;
      b.turret = Math.atan2(foe.y - b.y, foe.x - b.x);
      // muzzle flash + tracer leave from the turret's actual barrel height
      Particles.shot(b.x + Math.cos(b.turret) * 10, b.y + Math.sin(b.turret) * 10,
        foe.x, foe.y, WEAPON_STYLE[state.factions[b.owner]],
        (Art.turretLift[b.type] || 8) + 2,
        foe.kind === 'unit' ? unitAlt(foe) : 0);
      if (tileState(b.x, b.y) === 2 || tileState(foe.x, foe.y) === 2) {
        sfx(state.factions[b.owner] === 'glob' ? 'laser' : 'shot');
      }
    }
  }
}

// production queue: one job at a time, at half speed during a brownout
function advanceProduction(b, power, dt) {
  if (b.queue.length === 0) return;
  const job = b.queue[0];
  job.t += dt * (power.low ? 0.5 : 1);
  if (job.t >= job.duration) {
    b.queue.shift();
    const ut = UNIT_TYPES[job.type];
    // RA2-style emerge: ground units are born at the building's front door,
    // facing out, and drive/walk clear of it (with a puff of exhaust); aircraft
    // just appear on the pad. bornT drives the materialize pop in drawUnitIso.
    // Batch-cloned units (ut.batch — Grey Drones) tumble out several at once.
    for (let bi = 0; bi < (ut.batch || 1); bi++) {
      const u = makeUnit(b.owner, job.type, b.x + Math.sin(nextId) * 12 + bi * 7, b.y + b.h / 2 + 8 + bi * 4);
      u.bornT = state.time;
      if (bstatsOf(b).padCap) u.homeId = b.id; // aircraft remember their airfield
      if (ut.pad) u.slot = freeSlot(b);         // claim a parking slot on it
      if (!ut.flying) {
        u.facing = Math.PI / 2; // nose out of the doorway
        if (bi === 0 && tileState(b.x, b.y) === 2) { Particles.smoke(b.x - 9, b.y + b.h / 2, 3); Particles.smoke(b.x + 9, b.y + b.h / 2, 3); }
      }
      if (b.rally) {
        const rp = state.patches.find(p => p.amount > 0 && dist(p, b.rally) < 40);
        if (ut.role === 'worker' && rp) orderHarvest(u, rp);
        else if (ut.role === 'combat') orderAttackMove(u, b.rally.x, b.rally.y);
        else orderMove(u, b.rally.x, b.rally.y);
      } else if (ut.role === 'worker') {
        const patch = nearest(u, state.patches, p => p.amount > 0 && dist(u, p) < 600);
        if (patch) orderHarvest(u, patch);
      } else if (!ut.flying) {
        orderMove(u, b.x + Math.sin(nextId) * 24 + bi * 9, b.y + b.h / 2 + 48 + bi * 6); // clear the doorway
      }
    }
    if (b.owner === localOwner) eva('Unit ready');
  }
}

function aiPickSpot(owner, type) {
  // forward refinery: plant it right beside its chosen field (it's `anywhere`,
  // so it needn't hug the home base). It is not an anchor, so nothing else can
  // be built off it — it shortens the haul and that is all it does.
  if (type === 'refinery' && ais[owner] && ais[owner]._refSpot) {
    const c = ais[owner]._refSpot;
    for (const rad of [75, 100, 130, 165]) {
      for (let i = 0; i < 12; i++) {
        const a = i * (Math.PI * 2 / 12);
        const x = c.x + Math.cos(a) * rad, y = c.y + Math.sin(a) * rad;
        if (!placementBlocked(owner, type, x, y)) return { x, y };
      }
    }
  }
  // search rings around every grid anchor (HQ + power plants) until a spot fits
  const anchors = state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.done &&
    (b.type === 'hq' || b.type === 'powerplant' || bstatsOf(b).anchor));
  if (!anchors.length) return null;
  const hq = anchors.find(b => b.type === 'hq') || anchors[0];
  const f = facOf(owner);
  const t = bstats(owner, type);
  // don't wall the economy off: keep clear of mineral fields (so haulers can
  // still reach them AND get back to the HQ to deposit), and leave a walkable
  // lane between structures — a base packed to the bare STRUCT_GAP minimum can
  // seal its own workers away from the ore. The AI builds looser than a player.
  const patchClear = (x, y) => !state.patches.some(p => p.amount > 0 && Math.hypot(p.x - x, p.y - y) < t.w / 2 + 90);
  const laneClear = (x, y) => !state.buildings.some(b => b.hp > 0 && !bstatsOf(b).wallKind &&
    Math.abs(b.x - x) < (b.w + t.w) / 2 + 34 && Math.abs(b.y - y) < (b.h + t.h) / 2 + 34);
  // towers scan toward the map center first; support structures scan away from it
  const centerAngle = Math.atan2(WORLD_H / 2 - hq.y, WORLD_W / 2 - hq.x);
  const startAngle = (type === f.tower || type === f.aaTower) ? centerAngle : centerAngle + Math.PI;
  for (const anchor of anchors) {
    for (const rad of [120, 160, 200, 240, 285, 335, 390]) {
      for (let i = 0; i < 12; i++) {
        const a = startAngle + i * (Math.PI * 2 / 12);
        const x = anchor.x + Math.cos(a) * rad;
        const y = anchor.y + Math.sin(a) * rad;
        if (!placementBlocked(owner, type, x, y) && withinBuildRadius(owner, x, y) &&
            patchClear(x, y) && laneClear(x, y)) return { x, y };
      }
    }
  }
  // fallback: relax the extra lane spacing rather than fail to build at all
  for (const anchor of anchors) {
    for (const rad of [130, 175, 220, 270, 330, 390]) {
      for (let i = 0; i < 12; i++) {
        const a = startAngle + i * (Math.PI * 2 / 12);
        const x = anchor.x + Math.cos(a) * rad, y = anchor.y + Math.sin(a) * rad;
        if (!placementBlocked(owner, type, x, y) && withinBuildRadius(owner, x, y) && patchClear(x, y)) return { x, y };
      }
    }
  }
  return null;
}

function aiDesiredStructure(owner, counts, power) {
  const f = facOf(owner);
  // walk the build order; each repeat of a type raises its desired count.
  // income factions (no miners) weave in extra power structures — those ARE
  // their economy
  const order = f.economy.workers === 0
    ? ['barracks', 'powerplant', f.tower, 'powerplant', 'factory', f.aaTower, 'powerplant', 'airpad', 'powerplant', 'tech', 'barracks', f.tower, 'powerplant', f.aaTower]
    : ['barracks', f.tower, 'factory', f.aaTower, 'airpad', 'barracks', 'tech', f.tower, f.aaTower];
  // an air power stands up its first airfield right after the factory instead
  // of waiting out the aaTower(-and-its-tech-prereq) detour
  if (f.airFocus > 1) {
    order.splice(order.indexOf('airpad'), 1);
    order.splice(order.indexOf('factory') + 1, 0, 'airpad');
  }
  // hollow stands the Mechanicum up EARLY — with no Tech Priests there are no
  // relics, and with no relics the faction never leaves the servitor tier
  if (state.factions[owner] === 'hollow') {
    order.splice(1, 0, 'mechanicum');
  }
  // air-doctrine factions (2+ airfield-built types) double up on airpads so the
  // 4-plane pad cap doesn't ground half their roster; a true air power
  // (airFocus) fields a third
  if ([...f.air, ...f.extras, ...(f.advanced || [])].filter(u => UNIT_TYPES[u].builtAt === 'airpad').length >= 2) {
    order.push('airpad');
    if (f.airFocus > 1) order.push('airpad');
  }
  // once teched up, everyone wants their doomsday device (needs the extra power)
  if (superweaponsOn && (f.structs || []).includes('superweapon')) order.push('powerplant', 'superweapon');
  // income structures (e.g. Hollow's Crystal Geode) ARE economy for the worker
  // factions — slot them into the MID game (2 right after the factory, the rest
  // woven in later) so they're paying out before the late-game choke, not after
  const incomeStruct = (f.structs || []).find(s => (bstats(owner, s).income || 0) > 0);
  if (incomeStruct) {
    const cap = bstats(owner, incomeStruct).cap || 3;
    const at = order.indexOf('factory');
    if (at >= 0) order.splice(at + 1, 0, incomeStruct);   // one early (don't stall the tech rush)
    for (let i = 1; i < cap; i++) order.push(incomeStruct); // the rest fill in during expansion
  }
  // HOMESTEADS ARE THE ECONOMY, and they are also the life bar — an AI that
  // treats them as optional expansion starves and then dies to one raid. They
  // go EARLY and they go to the cap: the first before the factory (it pays for
  // the factory), the rest as fast as the money allows.
  const homeStruct = (f.structs || []).find(s => bstats(owner, s).homestead);
  if (homeStruct) {
    const cap = bstats(owner, homeStruct).cap || HOMESTEAD_CAP;
    const at = order.indexOf('barracks');
    if (at >= 0) order.splice(at + 1, 0, homeStruct, homeStruct);
    else order.unshift(homeStruct, homeStruct);
    for (let i = 2; i < cap; i++) order.push(homeStruct);
  }
  // late-game expansion tail: keep thickening power, defense and production so a
  // finished base never goes fully static while it still has minerals to spend
  order.push('powerplant', f.tower, f.aaTower, 'factory', 'powerplant', f.tower, f.aaTower, 'barracks');
  const want = {};
  let pick = null;
  for (const t of order) {
    want[t] = (want[t] || 0) + 1;
    // skip past a homestead it is not allowed to lay yet, rather than fixating
    // on it and reserving 200 it cannot spend while a yard refills
    if ((counts[t] || 0) < want[t] && !atStructCap(owner, t) && !homesteadBlocked(owner, t)) {
      // a gated structure (flat-family airpads) sends the AI for its prereq first
      const rq = bstats(owner, t).req;
      pick = (rq && !(counts[rq] > 0)) ? (atStructCap(owner, rq) ? null : rq) : t;
      break;
    }
  }
  if (!pick) return null;

  // ---------- can the grid actually carry it? ----------
  // The old check reserved a FLAT 30 of headroom before every build. That is
  // fine for a tower and nowhere near enough for a Research Lab at -80: the AI
  // would raise it, brown out, and then sit through the counter-attack with
  // silent towers and half-speed production. Reserve what THIS building draws.
  const draw = Math.max(0, -(bstats(owner, pick).power || 0));
  if (pick !== 'powerplant' && power.used + draw > power.cap) {
    // another plant is the answer if one is allowed...
    if (!atStructCap(owner, 'powerplant')) return 'powerplant';
    // ...and if the grid is maxed out, build NOTHING rather than knowingly
    // browning out the base. The minerals go to units instead, and the think
    // tick reconsiders every second as power frees up.
    return null;
  }
  return pick;
}

// ---------- the AI's think phases (one think tick runs them in order) ----------

// forward economy: once established, drop a Refinery next to a rich field that
// sits far from every current drop-off, so haulers stop crossing the map. The
// spot is stashed for aiPickSpot. It buys a shorter haul, not a forward base:
// the refinery is not a build anchor, so the AI's construction stays at home.
function aiForwardRefinery(owner, ai, f, counts) {
  const refReq = bstats(owner, 'refinery').req;
  if (!(f.worker && (f.structs || []).includes('refinery') && !state.construction[owner] && ai.time > 75 &&
      (!refReq || counts[refReq]) &&
      (counts['refinery'] || 0) < (bstats(owner, 'refinery').cap || 4))) return;
  const drops = state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.done && (b.type === 'hq' || bstatsOf(b).dropoff));
  let bestP = null, bestScore = -Infinity;
  for (const p of state.patches) {
    if (p.amount < 350) continue;
    const dHome = Math.min(...drops.map(b => dist(b, p)));
    if (dHome < 520) continue;                 // already served from home
    const score = p.amount - dHome * 0.3;      // rich, but not absurdly far
    if (score > bestScore) { bestScore = score; bestP = p; }
  }
  if (bestP && state.minerals[owner] >= bstats(owner, 'refinery').cost + 60) {
    startConstruction(owner, 'refinery');
    ai._refSpot = { x: bestP.x, y: bestP.y };
  }
}

// ---------- patch up the base ----------
// Every faction repairs. The AI mends what MATTERS first (the HQ, then
// production, then defenses) and never touches walls — it would trickle its
// whole bank into a fence line. It also refuses to repair while a fight is
// happening on top of the structure: paying to out-heal an active attack is
// how an AI goes broke and still loses the building.
const AI_REPAIR_PRIORITY = { hq: 4, factory: 3, barracks: 3, airpad: 3, tech: 3, refinery: 2, powerplant: 2 };
function aiRepairBase(owner) {
  let job = null, bestScore = -Infinity;
  for (const b of state.buildings) {
    if (b.owner !== owner || !canRepair(b)) continue;
    if (bstatsOf(b).wallKind || bstatsOf(b).noBlock) continue;      // not the fence, not the mines
    const frac = b.hp / b.maxHp;
    if (frac > 0.92) continue;                                      // a scratch can wait
    if (b.repairing) { job = b; break; }                            // already on it — leave it alone
    const threatened = state.units.some(e => e.owner !== owner && e.owner !== NEUTRAL && e.hp > 0 &&
      !hiddenFrom(e, owner) && UNIT_TYPES[e.type].dmg && dist(e, b) < 260);
    if (threatened) continue;
    const score = (AI_REPAIR_PRIORITY[b.type] || 1) * (1 - frac);
    if (score > bestScore) { bestScore = score; job = b; }
  }
  // one structure at a time, and only with a real cushion in the bank, so
  // repairs never starve the build order or the army
  if (job && !job.repairing && state.minerals[owner] > 180) job.repairing = true;
  // ...and drop the job before the bank hits zero. A human can choose to
  // spend their last mineral on a wall; an AI that does it stops producing.
  if (state.minerals[owner] < 70) {
    for (const b of state.buildings) if (b.owner === owner && b.repairing) b.repairing = false;
  }
}

// ---------- the hollow AI: rigs dig, priests fetch, servitors ascend ----------
// This runs BEFORE the army mix on purpose. The Mechanicum ladder IS the
// Hollow army, so a rite the AI wants but can't afford yet RESERVES its fee
// (same trick the build order uses) instead of losing the race to another
// 45-mineral servitor every think tick — which is exactly how the faction
// used to stall out at the servitor tier forever. Returns the updated reserve.
function aiHollowRites(owner, counts, reserve) {
  const mech = state.buildings.find(b => b.owner === owner && b.hp > 0 && b.done && b.type === 'mechanicum');
  const priests = state.units.filter(x => x.owner === owner && x.hp > 0 && UNIT_TYPES[x.type].priest && !x.garrisoned);
  const guards = state.units.filter(x => x.owner === owner && x.hp > 0 && x.type === 'lanternguard');
  const dreads = state.units.filter(x => x.owner === owner && x.hp > 0 && x.type === 'dreadnought');
  const pending = to => state.units.some(x => x.owner === owner && x.hp > 0 &&
    ((x.ascension && x.ascension.to === to) || (x.order.type === 'ascend' && x.order.key === to)));
  // a body with nothing better to do is raw material; idle ones first
  const spare = type => state.units.find(x => x.owner === owner && x.hp > 0 && x.type === type &&
      !x.ascension && !x.garrisoned && !x.transit && x.order.type === 'idle') ||
    state.units.find(x => x.owner === owner && x.hp > 0 && x.type === type &&
      !x.ascension && !x.garrisoned && !x.transit && x.order.type !== 'ascend');
  // rites in priority order: priests first — no priest, no relic, no faction
  const wanted = [];
  if (priests.length < 2) wanted.push('techpriest');
  if (guards.length + dreads.length < 8) wanted.push('lanternguard');
  if (guards.length >= 3 && dreads.length < 4) wanted.push('dreadnought');
  for (const key of wanted) {
    if (!mech || !ascendReady(owner, key)) continue;
    const fee = ascendFee(owner, key);
    // A body already walking to the slab still has to pay on arrival, so its
    // fee is reserved too — otherwise the army mix spends the minerals out
    // from under it, the rite is refused at the door, and the AI loops
    // forever sending servitors it can't afford to consecrate.
    if (pending(key)) { reserve += fee; break; }
    const body = spare(ASCEND[key].from);
    if (!body) continue;
    if (state.minerals[owner] >= fee + reserve) body.order = { type: 'ascend', destId: mech.id, key };
    else reserve += fee; // save for it: the army mix has to wait its turn
    break; // one rite in flight at a time keeps the economy honest
  }
  const rigs = state.units.filter(x => x.owner === owner && x.hp > 0 && UNIT_TYPES[x.type].digger);
  // an Excavation Rig is not an army unit, it is the economy: with relics
  // gating every rite, leaving rig production to the general unit mix left
  // the AI stuck at the servitor tier for the whole match. Buy them on
  // purpose, as long as there is anything left in the ground to open.
  const open = state.digSites.filter(s => !s.taken).length;
  // (bought OUTSIDE the structure reserve, like a worker — a rig that waits
  // its turn behind every queued building never gets bought at all)
  if (open && counts.factory && rigs.length < Math.min(2, open) &&
      !state.buildings.some(b => b.owner === owner && b.queue.some(j => UNIT_TYPES[j.type].digger)) &&
      state.minerals[owner] >= UNIT_TYPES.excavationrig.cost) {
    trainUnit(owner, 'excavationrig');
  }
  for (const s of state.digSites) {
    if (s.taken) continue;
    if (s.progress < DIG_TIME) {
      if (state.units.some(x => x.owner === owner && x.hp > 0 && x.order.type === 'dig' && x.order.siteId === s.id)) continue;
      // any rig not already on a hole — digging outranks whatever the wave
      // logic last told it to do
      const rig = rigs.find(r => r.order.type !== 'dig');
      if (rig) rig.order = { type: 'dig', siteId: s.id };
    } else {
      if (state.units.some(x => x.owner === owner && x.hp > 0 && x.order.type === 'recover' && x.order.siteId === s.id)) continue;
      const p = priests.find(x => x.order.type === 'idle');
      if (p) p.order = { type: 'recover', siteId: s.id };
    }
  }
  for (const w of state.armorWrecks) {
    if (w.owner !== owner) continue;
    if (state.units.some(x => x.owner === owner && x.hp > 0 && x.order.type === 'salvage' && x.order.wreckId === w.id)) continue;
    const p = priests.find(x => x.order.type === 'idle');
    if (p) p.order = { type: 'salvage', wreckId: w.id };
  }
  return reserve;
}

// train toward a target composition: pick the most-lacking type and save for
// it — training whatever is affordable would starve the expensive units.
// Candidates come straight from the faction roster, filtered by whether the
// right production building (and any tech prereq) actually stands.
function aiTrainArmy(owner, f, counts, army, reserve) {
  const mix = [];
  const addMix = (type, w) => {
    if (!type || !w) return;
    const ut = UNIT_TYPES[type];
    if (ut.role !== 'combat') return;               // scouts don't join the army
    if (!ut.dmg) return;                            // engineers/repair crews stay home
    if (ut.forestOnly) return;                      // the AI can't hunt from a deer stand
    if (ut.digger) return;                          // Excavation Rigs open dig sites, they don't join waves
    if (!counts[ut.builtAt]) return;                // no building that makes it
    if (ut.req && !counts[ut.req]) return;          // tech not researched yet
    mix.push([type, w]);
  };
  addMix(f.infantry, 4); addMix(f.aa, 1.2); addMix(f.extras[0], 0.8);
  addMix(f.vehicle, 1.6); addMix(f.extras[1], 0.8);
  // interceptors (air-only jets) are trained against the enemy air actually
  // seen — none fielded means none built, a sky full of saucers means a squadron
  let foeAir = 0;
  for (const e of state.units) {
    if (e.owner !== owner && e.owner !== NEUTRAL && e.hp > 0 && UNIT_TYPES[e.type].role === 'combat' &&
        UNIT_TYPES[e.type].flying && !hiddenFrom(e, owner)) foeAir++;
  }
  // airFocus factions (Deep State's black budget, the Globalist USAF) weight
  // their whole air wing up — the sky IS their doctrine
  const af = f.airFocus || 1;
  for (const a of f.air) addMix(a, (UNIT_TYPES[a].targets === 'air' ? Math.min(3, foeAir * 0.5) : 1.2) * af);
  for (const a of f.extras.slice(2)) addMix(a, 0.6);
  for (const a of (f.advanced || [])) addMix(a, 0.5 * (UNIT_TYPES[a].flying ? af : 1));
  if (mix.length) {
    const byType = {};
    for (const u of army) byType[u.type] = (byType[u.type] || 0) + 1;
    for (const b of state.buildings) {
      if (b.owner === owner && b.hp > 0) {
        for (const j of b.queue) byType[j.type] = (byType[j.type] || 0) + 1;
      }
    }
    const totalW = mix.reduce((s, [, w]) => s + w, 0);
    const totalArmy = mix.reduce((s, [t]) => s + (byType[t] || 0), 0);
    // pick the most-deficient unit the AI can AFFORD right now (respecting the
    // structure reserve). Only considering affordable units means a poor faction
    // still diversifies with what it can pay for, instead of endlessly waiting on
    // one pricey pick and defaulting to cheap infantry forever.
    let pick = null, worst = -Infinity, dream = null, dreamDef = -Infinity;
    for (const [t, w] of mix) {
      const deficit = w / totalW - (byType[t] || 0) / (totalArmy || 1);
      if (deficit > dreamDef) { dreamDef = deficit; dream = t; }
      if (state.minerals[owner] < UNIT_TYPES[t].cost + reserve) continue;
      if (deficit > worst) { worst = deficit; pick = t; }
    }
    // if the army's REAL hole is something expensive (an Abrams column, a
    // B-2 wing), save toward it instead of dribbling out another cheap jet —
    // this is what stops the F-35/B-1 monoculture
    if (pick && dream && dream !== pick && dreamDef > worst + 0.12) pick = null;
    if (pick) trainUnit(owner, pick);
  }

  // ---------- and once it is rich, it buys the big one ----------
  // The apex never won the deficit pick: it is the dearest thing on the roster,
  // so by the time the AI could afford one the mix had already spent the bank on
  // three cheap jets. Late game, with the tech building up and real money in
  // hand, buy it ON PURPOSE up to its cap — the same way workers and rigs are
  // bought outside the mix rather than competing inside it.
  const ai = ais[owner];
  if (ai && ai.time > 240) {
    // dearest FIRST: the Greys list a cheap Flying Saucer alongside the
    // Mothership, and buying in roster order meant they filled their saucer cap
    // and never once fielded the thing the tech tree exists for
    const ladder = [...(f.advanced || [])].sort((a, b) => (UNIT_TYPES[b].cost || 0) - (UNIT_TYPES[a].cost || 0));
    for (const apex of ladder) {
      const at = UNIT_TYPES[apex];
      if (!at || !counts[at.builtAt]) continue;
      if (at.req && !counts[at.req]) continue;
      const cap = at.limit || 2;
      const have = unitCount(owner, apex) +
        state.buildings.reduce((n, b) => n + (b.owner === owner && b.hp > 0 ? b.queue.filter(j => j.type === apex).length : 0), 0);
      if (have >= cap) continue;
      // a cushion on top of the price, so buying it never empties the bank
      if (state.minerals[owner] < at.cost + reserve + 150) continue;
      if (at.loosh && (state.loosh[owner] || 0) < at.loosh) continue;
      trainUnit(owner, apex);
      break;
    }
  }

  // the enemy runs silent (disguise, cloak, burrow): keep a couple of
  // detectors alive or the whole base fights blind
  const foeCloaky = state.units.some(e => e.owner !== owner && e.owner !== NEUTRAL && e.hp > 0 &&
    (e.disguised || UNIT_TYPES[e.type].cloakStill || UNIT_TYPES[e.type].stealth || UNIT_TYPES[e.type].burrow));
  if (foeCloaky) {
    const detType = [f.vehicle, f.aa, ...f.air, ...f.extras].filter(Boolean)
      .find(tp => UNIT_TYPES[tp].detector);
    if (detType) {
      const have = state.units.reduce((n, x) => n + (x.owner === owner && x.hp > 0 && x.type === detType ? 1 : 0), 0) +
        state.buildings.reduce((n, b) => n + (b.owner === owner && b.hp > 0 ? b.queue.filter(j => j.type === detType).length : 0), 0);
      if (have < 2 && state.minerals[owner] >= UNIT_TYPES[detType].cost + reserve) trainUnit(owner, detType);
    }
  }
}

// ---------- the Deep State runs its front companies ----------
// Nobody else would ever build a Front Company: it has no gun, so the army
// mix filters it straight out. It has to be bought on purpose, driven to
// THEIR doorstep, and opened — and then the ledger it fills has to be spent.
function aiDeepStateFronts(owner, counts, reserve) {
  const FRONTS = 2;
  const open = state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.type === 'frontcompany');
  const vans = state.units.filter(u => u.owner === owner && u.hp > 0 && UNIT_TYPES[u.type].establishes);
  if (counts.factory && counts.tech && open.length + vans.length < FRONTS &&
      state.minerals[owner] >= UNIT_TYPES.frontco.cost + reserve &&
      !state.buildings.some(b => b.owner === owner && b.queue.some(j => UNIT_TYPES[j.type].establishes))) {
    trainUnit(owner, 'frontco');
  }
  // drive each idle van to an enemy drop-off and open up just outside it
  for (const v of vans) {
    if (v.order.type !== 'idle') continue;
    const mark = nearest(v, state.buildings, b => b.owner !== owner && b.owner !== NEUTRAL && b.hp > 0 &&
      (b.type === 'hq' || bstatsOf(b).dropoff) &&
      !open.some(f => dist(f, b) <= bstatsOf(f).thief.r * 0.6));
    if (!mark) continue;
    // stand off a little: close enough to skim, far enough to go unnoticed
    const d = dist(v, mark) || 1;
    const sx = mark.x + (v.x - mark.x) / d * 300, sy = mark.y + (v.y - mark.y) / d * 300;
    if (dist(v, { x: sx, y: sy }) > 60) v.order = { type: 'move', x: clamp(sx, 60, WORLD_W - 60), y: clamp(sy, 60, WORLD_H - 60) };
    else v.order = { type: 'establish' };
  }
  // spend the ledger: the most expensive play it can afford, on whatever of
  // theirs matters most (production first, then anything at all)
  const lev = state.leverage[owner] || 0;
  if (lev >= LEVERAGE_PLAYS.books.cost) {
    const affordable = Object.entries(LEVERAGE_PLAYS)
      .filter(([, pl]) => lev >= pl.cost).sort((a, b) => b[1].cost - a[1].cost);
    const foe = randomHostile(owner);
    const prize = state.buildings.find(b => b.owner === foe && b.hp > 0 &&
        ['factory', 'barracks', 'airpad', 'tech'].includes(b.type)) ||
      state.buildings.find(b => b.owner === foe && b.hp > 0 && b.type !== 'wall');
    if (prize) {
      for (const [key] of affordable) if (playLeverage(owner, key, prize)) break;
    }
  }
}

// the flat compound hires its ONE Prophet once a Revival Tent stands, and
// mans its pillboxes with militia so the concrete isn't just scenery.
// Runs BEFORE the army mix and RESERVES the Prophet's fee, the same trick the
// Mechanicum rites use: at 280 he is dearer than anything else the compound
// buys, so left to compete with the unit mix he simply never got hired, the
// meter never left the desertion band, and the faction's whole economy was
// dead weight. Returns the updated reserve.
function aiFlatCompound(owner, f, counts, reserve) {
  if (counts.revivaltent) {
    const have = state.units.reduce((k, x) => k + (x.owner === owner && x.hp > 0 && UNIT_TYPES[x.type].mendAura ? 1 : 0), 0) +
      state.buildings.reduce((k, b) => k + (b.owner === owner && b.hp > 0 ? b.queue.filter(j => UNIT_TYPES[j.type].mendAura).length : 0), 0);
    const hasProphet = have >= (UNIT_TYPES.prophet.limit || 1);
    if (!hasProphet) {
      if (state.minerals[owner] >= UNIT_TYPES.prophet.cost + reserve) trainUnit(owner, 'prophet');
      else reserve += UNIT_TYPES.prophet.cost; // save toward him; the army waits
    }
  }
  // ---------- and it disproves things ----------
  // It picks by what the enemy is ACTUALLY fielding, which is the whole point
  // of the mechanic: stealth if anything is running silent, sky if they have a
  // wing up, nukes once a superweapon stands.
  if (counts.tech && !state.research[owner]) {
    const done = state.disproof[owner] || {};
    const foes = state.units.filter(u => u.owner !== owner && u.owner !== NEUTRAL && u.hp > 0);
    const foeBld = state.buildings.filter(b => b.owner !== owner && b.owner !== NEUTRAL && b.hp > 0);
    const want = [];
    if (foes.some(u => { const t = UNIT_TYPES[u.type]; return u.disguised || t.cloakStill || t.stealth || t.burrow; })) want.push('stealth');
    if (foes.filter(u => UNIT_TYPES[u.type].flying).length >= 3) want.push('sky');
    if (foeBld.some(b => bstatsOf(b).superweapon)) want.push('nukes');
    if (foes.some(u => UNIT_TYPES[u.type].weapon === 'lob')) want.push('ballistics');
    // anyone who can take your people off you: reptilian coup, grey tractor
    // beams, deep-state handlers, a captured TV Station
    if (foeBld.some(b => bstatsOf(b).convert) ||
        foes.some(u => { const t = UNIT_TYPES[u.type]; return t.convert || t.weapon === 'abduct' || t.handler; }) ||
        ['reptilian', 'grey', 'deep'].some(fk => OWNERS.some(o => o !== owner && state.factions[o] === fk))) want.push('actors');
    // nothing pressing? prove the cheapest outstanding thing anyway — an idle
    // Institute is the same waste as an idle factory
    for (const k of Object.keys(DISPROOFS).sort((a, b) => DISPROOFS[a].cost - DISPROOFS[b].cost)) want.push(k);
    for (const k of want) {
      if (done[k]) continue;
      if (state.minerals[owner] >= DISPROOFS[k].cost + reserve) startResearch(owner, k);
      break;
    }
  }
  for (const b of state.buildings) {
    if (b.owner !== owner || b.hp <= 0 || !b.done || !b.garrison) continue;
    const bt = bstatsOf(b);
    if (!bt.slots || !bt.cost) continue; // own pillboxes only, not captured landmarks
    const inbound = state.units.filter(x => x.owner === owner && x.hp > 0 &&
      x.order.type === 'garrison' && x.order.destId === b.id).length;
    let free = bt.slots - b.garrison.length - inbound;
    // only spare militia man the slits — the wave army stays in the field
    for (const x of state.units) {
      if (free <= 0) break;
      if (x.owner !== owner || x.hp <= 0 || x.garrisoned || x.type !== f.infantry) continue;
      if (x.order.type !== 'idle' || dist(x, b) > 600) continue;
      x.order = { type: 'garrison', destId: b.id };
      free--;
    }
  }
  // HAND THE RESERVE BACK. The caller does `reserve = aiFlatCompound(...)`, so
  // falling off the end here returned undefined and every later affordability
  // test became `minerals < cost + undefined` — NaN, which is false, so nothing
  // was ever unaffordable. The Flat Earth AI spent its entire income on militia
  // and could never save the 200 for its first homestead: no farms, no economy,
  // dead faction. Every path out of this function must return a number.
  return reserve;
}

// fortify: lay a square wall perimeter around the base once established, with
// a gap in the middle of each side (and open corners) so the army can still
// sortie. A couple segments per think, only when flush so production isn't
// starved. Segments snap to the wall grid so they join into a rampart.
function aiFortify(owner, ai, hq) {
  if (!ai.wallPlan) {
    ai.wallPlan = []; ai.wallIdx = 0;
    const snap = v => Math.round(v / WALL_STEP) * WALL_STEP;
    const R = snap(290), hx = snap(hq.x), hy = snap(hq.y), n = (2 * R) / WALL_STEP;
    const side = (fx, fy, dx, dy) => {
      for (let i = 0; i <= n; i++) {
        if (i > n * 0.38 && i < n * 0.62) continue; // gap in the middle of each side
        ai.wallPlan.push({ x: fx + dx * i * WALL_STEP, y: fy + dy * i * WALL_STEP });
      }
    };
    side(hx - R, hy - R, 1, 0); side(hx - R, hy + R, 1, 0); // top, bottom
    side(hx - R, hy - R, 0, 1); side(hx + R, hy - R, 0, 1); // left, right
  }
  let laid = 0;
  while (ai.wallIdx < ai.wallPlan.length && laid < 2 && state.minerals[owner] > 280) {
    const p = ai.wallPlan[ai.wallIdx++];
    if (!placementBlocked(owner, 'wall', p.x, p.y) && withinBuildRadius(owner, p.x, p.y)) {
      state.minerals[owner] -= bstats(owner, 'wall').cost;
      makeBuilding(owner, 'wall', p.x, p.y);
      laid++;
    }
  }
}

// decide what to capture — a SYSTEM, not a grab-everything reflex. The AI
// pursues at most ONE capture at a time, only when its army can clearly spare a
// body, and scores each landmark by its CURRENT need (economy? healing?
// detection? power?), discounted by distance and by how contested the site is.
// If nothing clears the bar, it captures nothing and keeps fighting.
function aiCapture(owner, f, army, workers, hq, power) {
  const poor = state.minerals[owner] < 300 && (!f.worker || workers.length <= (f.economy.workers || 3));
  const hurt = army.length ? army.reduce((s, u) => s + u.hp / u.maxHp, 0) / army.length < 0.72 : false;
  const cloakFoe = state.units.some(u => u.owner !== owner && u.owner !== NEUTRAL && u.hp > 0 &&
    (UNIT_TYPES[u.type].cloakStill || UNIT_TYPES[u.type].stealth || UNIT_TYPES[u.type].burrow));
  const lowPow = power.low;
  const myAir = army.reduce((n, u) => n + (UNIT_TYPES[u.type].flying ? 1 : 0), 0);
  const value = b => { const s = bstatsOf(b); let v = 0;
    if (s.income) v += s.income * (poor ? 2.4 : 0.7);   // banks/derricks matter most when broke
    if (s.spawns) v += 20;                               // free units are always worthwhile
    if (s.airTech) v += 8 + myAir * 7;                   // crash-site tech pays off with a real air wing
    if (s.healAura) v += hurt ? 42 : 9;                  // hospitals/depots when the army is bleeding
    if (s.buffAura) v += hurt ? 26 : 7;
    if (s.detector) v += cloakFoe ? 38 : 5;              // radar when the enemy runs silent
    if (s.power > 0) v += lowPow ? 32 : 4;               // substation only when the grid is low
    if (s.convert) v += 15;
    return v;
  };
  let best = null, bestScore = 0;
  for (const b of state.buildings) {
    if (b.hp <= 0 || b.owner !== NEUTRAL || !bstatsOf(b).slots) continue;
    if (b.garrison && b.garrison.length >= bstatsOf(b).slots) continue;
    const d = dist(hq, b);
    if (d > 1500) continue;                              // not worth crossing the map for
    const contested = state.units.some(u => u.owner !== owner && u.owner !== NEUTRAL && u.hp > 0 && dist(u, b) < 260);
    const score = value(b) * (1 - d / 2400) * (contested ? 0.35 : 1);
    if (score > bestScore) { bestScore = score; best = b; }
  }
  if (best && bestScore >= 12) { // only if the payoff clears the bar
    const claimer = army.find(s => s.order.type === 'idle' && !UNIT_TYPES[s.type].flying && UNIT_TYPES[s.type].builtAt === 'barracks');
    if (claimer) claimer.order = { type: 'garrison', destId: best.id };
  }
}

// defense: react to enemies threatening ANY base structure, not just the HQ.
// Pick the threat closest to the HQ (HQ-proximate attackers weighted first),
// and pull the whole army onto it (disguised reptilians don't register).
// Returns true when the army was committed — the think tick ends there.
function aiDefend(owner, army, hq) {
  const myBldgs = state.buildings.filter(b => b.owner === owner && b.hp > 0);
  let threat = null, best = Infinity;
  for (const u of state.units) {
    if (u.owner === owner || u.hp <= 0 || u.garrisoned || hiddenFrom(u, owner)) continue;
    const dh = dist(hq, u);
    let score = dh < 560 ? dh : Infinity;             // wide ring around the HQ
    if (score === Infinity) {                          // else: raiding an outlying building?
      for (const b of myBldgs) { if (dist(b, u) < 300) { score = 400 + dh * 0.01; break; } }
    }
    if (score !== Infinity) score -= supportBias(u);  // gut the medics and buffers first
    if (score < best) { best = score; threat = u; }
  }
  if (!threat) return false;
  for (const s of army) {
    if (!canTarget(UNIT_TYPES[s.type], threat)) continue;
    // stickiness: a defender already engaging a live nearby threat keeps
    // shooting it — disembarking a squad next to it must not yank every
    // gun off the transport onto the fresh bodies
    if (s.order.type === 'attack') {
      const cur = findEntity(s.order.targetId);
      if (cur && cur.kind === 'unit' && cur.hp > 0 && cur.owner !== owner && !hiddenFrom(cur, owner) &&
          dist(hq, cur) < 700) continue;
    }
    orderAttack(s, threat);
  }
  return true;
}

// attack waves: free-for-all — march on whoever's base is closest
function aiAttackWave(owner, ai, army, hq) {
  const idleArmy = army.filter(s => s.order.type === 'idle');
  if (!(ai.time > AI_GRACE_PERIOD && idleArmy.length >= ai.attackWaveSize)) return;
  const target = nearest(hq, state.buildings.filter(b => b.owner !== owner && b.owner !== NEUTRAL && b.hp > 0 && b.type !== 'sleepercell'))
    || nearest(hq, state.units.filter(u => u.owner !== owner && u.hp > 0 && !hiddenFrom(u, owner) && !u.garrisoned));
  if (target) {
    for (const s of idleArmy) orderAttackMove(s, target.x, target.y);
    ai.attackWaveSize = Math.min(12, ai.attackWaveSize + 1);
  }
}

function updateAI(owner, dt) {
  const ai = ais[owner];
  ai.time += dt;
  tickConstruction(owner, dt);
  ai.thinkTimer -= dt;
  if (ai.thinkTimer > 0) return;
  ai.thinkTimer = 1.0;

  const f = facOf(owner);
  const myUnits = state.units.filter(u => u.owner === owner && u.hp > 0);
  const workers = myUnits.filter(u => UNIT_TYPES[u.type].role === 'worker');
  const army = myUnits.filter(u => UNIT_TYPES[u.type].role === 'combat');
  const hq = state.buildings.find(b => b.owner === owner && b.type === 'hq' && b.hp > 0);
  if (!hq) return;

  const counts = {};
  for (const b of state.buildings) {
    if (b.owner === owner && b.hp > 0) counts[b.type] = (counts[b.type] || 0) + 1;
  }
  const power = powerOf(owner);

  // place finished construction
  const c = state.construction[owner];
  if (c && c.ready) {
    const spot = aiPickSpot(owner, c.type);
    if (spot) tryPlace(owner, spot.x, spot.y);
  }

  // fire a charged superweapon at the fattest enemy target cluster
  const sw = state.buildings.find(b => b.owner === owner && b.hp > 0 && superReady(b) && !isOffline(b));
  if (sw) {
    const tgt = nearest(sw, state.buildings.filter(b => b.owner !== owner && b.owner !== NEUTRAL &&
      b.hp > 0 && b.type !== 'sleepercell' && !bstatsOf(b).noBlock))
      || nearest(sw, state.units.filter(u => u.owner !== owner && u.hp > 0 && !u.garrisoned && !hiddenFrom(u, owner)));
    if (tgt) fireSuperweapon(sw, tgt.x, tgt.y);
  }

  // idle workers mine
  for (const w of workers) {
    if (w.order.type === 'idle') {
      const patch = nearest(w, state.patches, p => p.amount > 0);
      if (patch) orderHarvest(w, patch);
    }
  }

  aiForwardRefinery(owner, ai, f, counts);
  aiRepairBase(owner);

  // economy recovery: below the starting workforce (raided, or just off the
  // start), rebuild rigs FIRST — a starved base can't fund anything else
  const workerCap = f.worker ? Math.max(f.economy.workers, minerCap(owner, f.worker)) : 0;
  const starved = f.worker && workers.length < f.economy.workers;
  if (starved && state.minerals[owner] >= UNIT_TYPES[f.worker].cost) trainUnit(owner, f.worker);

  // start next structure; reserve its cost so unit spam can't starve it
  const desired = !state.construction[owner] ? aiDesiredStructure(owner, counts, power) : null;
  if (desired && (!f.worker || workers.length >= 3) && state.minerals[owner] >= bstats(owner, desired).cost) {
    startConstruction(owner, desired);
  }
  let reserve = (!state.construction[owner] && desired) ? bstats(owner, desired).cost : 0;

  // grow the workforce all the way to the rig CAP (not just the start count) —
  // mining throughput, not patch size, is what chokes the worker economies.
  // (income factions have no rig to train; trainUnit still enforces the cap)
  if (f.worker && !starved && workers.length < workerCap &&
      state.minerals[owner] >= UNIT_TYPES[f.worker].cost + reserve) {
    trainUnit(owner, f.worker);
  }


  // the Mechanicum ladder IS the Hollow army, so the rites run BEFORE the army
  // mix and reserve their fees out from under it
  if (isHollow(owner)) reserve = aiHollowRites(owner, counts, reserve);
  // the compound's Prophet is dearer than any unit, so his fee is reserved
  // before the army mix gets a look at the bank
  if (state.factions[owner] === 'flat') reserve = aiFlatCompound(owner, f, counts, reserve);
  aiTrainArmy(owner, f, counts, army, reserve);

  // faction business nobody else transacts
  if (state.factions[owner] === 'deep') aiDeepStateFronts(owner, counts, reserve);

  // wall in the base once it's established and flush
  if (ai.time > 100 && state.minerals[owner] > 300) aiFortify(owner, ai, hq);

  // at most ONE capture in flight, and only when the army can spare a body
  const outCapturing = state.units.filter(s => s.owner === owner && s.order.type === 'garrison').length;
  if (ai.time > 40 && army.length >= 5 && outCapturing === 0) aiCapture(owner, f, army, workers, hq, power);

  // the army answers a raid before it goes looking for one
  if (aiDefend(owner, army, hq)) return;
  aiAttackWave(owner, ai, army, hq);
}

// mouse event -> iso screen space (the space cam.x/cam.y pan in)
function screenToIso(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / cam.zoom + cam.x,
    y: (e.clientY - r.top) / cam.zoom + cam.y,
  };
}

// mouse event -> world (cartesian) ground-plane point
function screenToWorld(e) {
  const p = screenToIso(e);
  return isoUnproject(p.x, p.y);
}

// screen-space pick: does a ground-plane click land on the unit's DRAWN
// sprite? (airborne craft render FLY_H above their ground position)
function clickHitsUnit(u, wx, wy, pad = 4) {
  const t = UNIT_TYPES[u.type];
  const alt = unitAlt(u);
  return Math.hypot(isoX(u.x, u.y) - isoX(wx, wy),
    isoY(u.x, u.y) - alt - isoY(wx, wy)) <= t.r * UNIT_DRAW_SCALE + pad;
}

// is the unit's sprite currently within the camera viewport?
function onScreen(u) {
  const sx = (isoX(u.x, u.y) - cam.x) * cam.zoom;
  const sy = (isoY(u.x, u.y) - unitAlt(u) - cam.y) * cam.zoom;
  return sx >= 0 && sx <= canvas.width && sy >= 0 && sy <= canvas.height;
}

// ---- view-side command issuers ----
// These read the selection and the placement cursor — client-only state — and
// post a command. They never touch the simulation directly.
const selectedUnitIds = pred => idsOf(selection.filter(e =>
  e.kind === 'unit' && e.hp > 0 && e.owner === localOwner && (!pred || pred(e))));
const selectedBuildingIds = pred => idsOf(selection.filter(e =>
  e.kind === 'building' && e.hp > 0 && e.owner === localOwner && (!pred || pred(e))));

function burrowCmd() {
  const u = selectedUnitIds(e => UNIT_TYPES[e.type].burrow && !e.transit);
  if (u.length) { cmd('burrow', { u }); refreshPanel(); }
}
function exploreCmd() {
  const u = selectedUnitIds(e => UNIT_TYPES[e.type].role === 'scout');
  if (u.length) { cmd('explore', { u }); sfx('click'); eva('Scouting'); }
}
// right-click a structure cameo: stop placing it, and scrap whatever is queued
function cancelStructureCmd(type) {
  if (placing === type) { placing = null; sfx('click'); refreshPanel(); refreshSidebar(); }
  if (!bstats(localOwner, type).instant) cmd('cancelbuild', { t: type });
}

function selectAt(x, y) {
  const u = state.units.find(u => u.owner === localOwner && u.hp > 0 && !u.garrisoned && clickHitsUnit(u, x, y, 4));
  const b = state.buildings.find(b => b.owner === localOwner && b.hp > 0 &&
    Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
  // no own entity under the cursor: inspect a visible enemy instead
  // (disguised infiltrators are excluded — clicking would blow their cover)
  const eu = !u && !b && state.units.find(un => un.owner !== localOwner && un.hp > 0 && !hiddenFrom(un, localOwner) && !un.garrisoned &&
    visibleToPlayer(un) && clickHitsUnit(un, x, y, 4));
  // observingPlayer, not visibleToPlayer: an intel card is LIVE readout — hp,
  // queue, garrison — so it may only be opened on a structure actually in sight.
  // Clicking a remembered one selects nothing, which is the honest answer.
  const eb = !u && !b && !eu && state.buildings.find(bd => bd.owner !== localOwner && bd.hp > 0 &&
    observingPlayer(bd) && Math.abs(bd.x - x) <= bd.w / 2 && Math.abs(bd.y - y) <= bd.h / 2);
  selection = u ? [u] : b ? [b] : eu ? [eu] : eb ? [eb] : [];
}

// View side of the right-click: it reads the selection (client-only), turns it
// into ids, and posts a command. It does not touch the sim.
function rightCommand(x, y) {
  // An armed targeting mode owns the right button too. RTS muscle memory puts
  // orders on right-click, so after pressing Bury Cache or Set Charge the
  // right-click has to DO the thing rather than order a move over the top of
  // it. Left-click still works; both routes go through the same commands.
  if (cacheTargeting) {
    const ids = cacheTargeting;
    cacheTargeting = null;
    const why = canPlantCache(localOwner, x, y);
    if (why) eva(CACHE_REFUSAL[why]);
    else { cmd('plant', { u: ids, x, y }); sfx('click'); }
    refreshPanel();
    return;
  }
  if (demoTargeting) {
    const ids = demoTargeting;
    demoTargeting = null;
    const tgt = state.buildings.find(b => b.hp > 0 && b.owner !== localOwner && b.owner !== NEUTRAL &&
      Math.abs(x - b.x) <= b.w / 2 + 10 && Math.abs(y - b.y) <= b.h / 2 + 10);
    if (tgt) { cmd('demo', { u: ids, b: tgt.id }); sfx('click'); }
    else eva('Charges go on enemy structures');
    refreshPanel();
    return;
  }
  if (bcastTargeting) {
    const key = bcastTargeting;
    bcastTargeting = null;
    cmd('broadcast', { k: key, x, y });
    sfx('click'); refreshPanel();
    return;
  }
  if (dropTargeting) {
    const id = dropTargeting;
    dropTargeting = null;
    if (!canDropAt(localOwner, x, y)) eva('Drop zone not scouted');
    else { cmd('launchplane', { b: id, x, y }); sfx('click'); }
    refreshPanel();
    return;
  }
  // rally point when a single production building is selected — a wall or a
  // power plant has nothing to send anywhere, so it falls through to a move
  if (selection.length === 1 && selection[0].owner === localOwner && producesUnits(selection[0])) {
    cmd('rally', { b: selection[0].id, x, y });
    sfx('click');
    return;
  }
  const u = idsOf(selection.filter(e => e.kind === 'unit' && e.hp > 0 && e.owner === localOwner));
  if (u.length) cmd('move', { u, x, y });
}

// The right-click order, as a command handler. Takes an owner and a list of
// unit IDS — never the selection, which is view state and differs per client.
// Target resolution happens HERE, at execution time, so every client resolves
// against the same world.
function issueCommand(owner, unitIds, x, y) {
  const units = cmdUnits(unitIds, owner);
  if (units.length === 0) return;
  const pt = { x, y };

  // the Hollow relic economy: dig sites, armor wrecks, ascension buildings
  if (isHollow(owner)) {
    const site = state.digSites.find(s => !s.taken && dist(s, pt) <= 26);
    if (site) {
      let any = false;
      for (const u of units) {
        if (UNIT_TYPES[u.type].digger && site.progress < DIG_TIME) { u.order = { type: 'dig', siteId: site.id }; any = true; }
        else if (UNIT_TYPES[u.type].priest && site.progress >= DIG_TIME) { u.order = { type: 'recover', siteId: site.id }; any = true; }
      }
      if (any) { sfx('click'); return; }
    }
    const wr = state.armorWrecks.find(w => w.owner === owner && dist(w, pt) <= 20);
    if (wr && units.some(u => UNIT_TYPES[u.type].priest)) {
      for (const u of units) if (UNIT_TYPES[u.type].priest) u.order = { type: 'salvage', wreckId: wr.id };
      sfx('click');
      return;
    }
    // right-click the Mechanicum with bodies: each one takes the WAR rite for
    // its tier (servitor -> Lantern Guard, Guard -> Dreadnought). The Tech
    // Priest rite shares the servitor slot, so it lives on the building's
    // panel button instead — see beginRite().
    const ab = state.buildings.find(b => b.owner === owner && b.hp > 0 && b.done &&
      Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
    if (ab) {
      let any = false;
      for (const [key, A] of Object.entries(ASCEND)) {
        if (ab.type !== A.at || key === 'techpriest' || !ascendReady(owner, key)) continue;
        for (const u of units) {
          if (u.type === A.from && !u.ascension) { u.order = { type: 'ascend', destId: ab.id, key }; any = true; }
        }
      }
      if (any) { sfx('click'); return; }
    }
  }

  // right-click an enemy structure with a Journalist selected: go film it. This
  // beats the normal attack order because the Journalist has no weapon — an
  // attack order on a camera crew is just a walk toward the guns.
  const filmTgt = state.buildings.find(b2 => b2.hp > 0 && b2.owner !== owner && b2.owner !== NEUTRAL &&
    Math.abs(x - b2.x) <= b2.w / 2 + 12 && Math.abs(y - b2.y) <= b2.h / 2 + 12);
  if (filmTgt) {
    const crew = units.filter(u => UNIT_TYPES[u.type].investigator && (u.proof || 0) < journoCap(u));
    if (crew.length) {
      for (const u of crew) u.order = { type: 'film', destId: filmTgt.id };
      sfx('click'); return;
    }
  }
  // right-click a Broadcast Station (or News Van) carrying footage: file it
  const dropTgt = proofDropoffs(owner).find(d => d.kind === 'building'
    ? (Math.abs(x - d.x) <= d.w / 2 + 12 && Math.abs(y - d.y) <= d.h / 2 + 12)
    : clickHitsUnit(d, x, y, 8));
  if (dropTgt) {
    const loaded = units.filter(u => u.proof > 0);
    if (loaded.length) {
      for (const u of loaded) u.order = { type: 'filepiece', destId: dropTgt.id };
      sfx('click'); return;
    }
  }
  // right-click one of your own prepper caches with militia selected: they walk
  // over and draw whatever it is stocked with. This is the ordinary way to gear
  // up — the per-kit buttons are still there for when you want the other one.
  const cch = state.buildings.find(b => b.owner === owner && b.hp > 0 && b.kits > 0 &&
    bstatsOf(b).cache && Math.abs(x - b.x) <= b.w / 2 + 12 && Math.abs(y - b.y) <= b.h / 2 + 12);
  if (cch) {
    let any = false, room = cch.kits;
    for (const u of units) {
      if (room <= 0) break;
      if (u.type !== 'militia' || u.garrisoned) continue;
      u.order = { type: 'drawkit', destId: cch.id, kit: cch.kit || CACHE_LOADOUT[0] };
      room--; any = true;
    }
    if (any) { sfx('click'); return; }
  }

  // right-click an empty Bug Out Van with a body that has a kit: WELD IT IN.
  // This deliberately beats the generic transport check below — "put a unit in
  // the van and the van becomes that thing" is the whole unit, and having a
  // right-click quietly load the militiaman as a passenger instead read as the
  // van being broken. Ferrying is still there, on its own button.
  const van = state.units.find(v => v.owner === owner && v.hp > 0 && UNIT_TYPES[v.type].loader &&
    !vanKitOf(v) && !(v.cargo || []).length && clickHitsUnit(v, x, y, 6));
  if (van) {
    const body = units.find(u => BUGOUT_KITS[u.type] && !u.garrisoned && u.id !== van.id);
    if (body) { body.order = { type: 'fitvan', destId: van.id }; sfx('click'); return; }
  }

  // right-click a friendly transport: selected light infantry climb aboard
  // (works with the transport itself in the selection — a boxed squad of
  // Bradley + PMCs right-clicking the Bradley is the normal case)
  const trn = state.units.find(v => v.owner === owner && v.hp > 0 && UNIT_TYPES[v.type].cargoCap &&
    clickHitsUnit(v, x, y, 6));
  if (trn) {
    let boarding = (trn.cargo || []).length;
    const cap = UNIT_TYPES[trn.type].cargoCap;
    let any = false;
    for (const u of units) {
      if (boarding >= cap) break;
      const ut = UNIT_TYPES[u.type];
      if (ut.flying || ut.builtAt !== 'barracks' || ut.r > 10 || u.garrisoned) continue;
      u.order = { type: 'board', destId: trn.id };
      boarding++; any = true;
    }
    if (any) { sfx('click'); return; }
  }

  // right-click a neutral (or own-held) civilian structure: infantry garrison it
  const gb = state.buildings.find(b => b.hp > 0 && bstatsOf(b).slots &&
    (b.owner === NEUTRAL || (b.owner === owner && b.done)) && visibleTo(owner, b) &&
    Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
  if (gb) {
    let any = false;
    for (const u of units) {
      if (canGarrison(u)) { u.order = { type: 'garrison', destId: gb.id }; any = true; }
    }
    if (any) { sfx('click'); return; }
  }

  // Target resolution runs at EXECUTION time on every client, so it has to ask
  // about the ISSUING side's vision, not the local one. These were
  // visibleToPlayer()/tileState() — i.e. whoever happened to be at the keyboard.
  const foe = enemiesOf(owner).find(e => visibleTo(owner, e) &&
    (e.kind === 'unit' ? clickHitsUnit(e, x, y, 6)
                       : Math.abs(e.x - x) <= e.w / 2 && Math.abs(e.y - y) <= e.h / 2));
  const patch = state.patches.find(p => p.amount > 0 && dist(p, pt) <= 20 && tileStateFor(owner, p.x, p.y) >= 1);
  // a damaged friendly unit under the cursor: repair units tend to it
  const ally = state.units.find(a => a.owner === owner && a.hp > 0 && !a.garrisoned &&
    a.hp < a.maxHp && clickHitsUnit(a, x, y, 6));

  units.forEach((u, i) => {
    const stats = UNIT_TYPES[u.type];
    if (foe && stats.captures && foe.kind === 'building') { u.order = { type: 'capture', targetId: foe.id }; return; }
    if (foe && stats.tracker && foe.kind === 'unit') { u.order = { type: 'probe', targetId: foe.id }; return; }
    if (foe && canTarget(stats, foe)) { orderAttack(u, foe); return; }
    if (ally && stats.repair && ally !== u) { u.order = { type: 'repair', targetId: ally.id }; return; }
    if (patch && stats.role === 'worker') { orderHarvest(u, patch); return; }
    const ang = (i / Math.max(1, units.length)) * Math.PI * 2;
    const rad = i === 0 ? 0 : 16 + 10 * Math.floor(i / 6);
    orderMove(u, x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);
  });
}

// what would a left/right command at world (x,y) do, given the current
// selection? Read-only mirror of issueCommand, used to draw a contextual
// cursor reticle so the player sees "attack / repair / capture / ..." on hover.
function hoverContext(x, y) {
  if (placing || attackMoveArmed || plantArmed || abilityTargeting || superTargeting || leverageTargeting || wallDrag ||
      cacheTargeting || dropTargeting || demoTargeting || bcastTargeting) return null;
  const units = selection.filter(e => e.kind === 'unit' && e.hp > 0 && e.owner === localOwner);
  if (!units.length) return null;
  // hollow tunnel node
  if (state.factions[localOwner] === 'hollow') {
    const node = state.buildings.find(b => b.owner === localOwner && b.hp > 0 && b.done && TUNNEL_NODES.includes(b.type) &&
      Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
    if (node && units.some(u => !UNIT_TYPES[u.type].flying)) return { kind: 'tunnel', x: node.x, y: node.y, size: entityRadius(node) };
  }
  // garrisonable civilian structure
  const gb = state.buildings.find(b => b.hp > 0 && bstatsOf(b).slots && (b.owner === NEUTRAL || b.owner === localOwner) &&
    visibleToPlayer(b) && Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
  if (gb && units.some(canGarrison)) return { kind: 'garrison', x: gb.x, y: gb.y, size: entityRadius(gb) };
  // enemy under the cursor
  const foe = enemiesOf(localOwner).find(e => visibleToPlayer(e) &&
    (e.kind === 'unit' ? clickHitsUnit(e, x, y, 6) : Math.abs(e.x - x) <= e.w / 2 && Math.abs(e.y - y) <= e.h / 2));
  if (foe) {
    if (foe.kind === 'building' && units.some(u => UNIT_TYPES[u.type].captures)) return { kind: 'capture', x: foe.x, y: foe.y, size: entityRadius(foe) };
    if (foe.kind === 'unit' && units.some(u => UNIT_TYPES[u.type].tracker)) return { kind: 'probe', x: foe.x, y: foe.y, size: entityRadius(foe) };
    if (units.some(u => canTarget(UNIT_TYPES[u.type], foe))) return { kind: 'attack', x: foe.x, y: foe.y, size: entityRadius(foe) };
  }
  // a damaged ally for repair units
  const ally = state.units.find(a => a.owner === localOwner && a.hp > 0 && !a.garrisoned && a.hp < a.maxHp && clickHitsUnit(a, x, y, 6));
  if (ally && units.some(u => UNIT_TYPES[u.type].repair && u !== ally)) return { kind: 'repair', x: ally.x, y: ally.y, size: entityRadius(ally) };
  // a mineral patch for workers
  const patch = state.patches.find(p => p.amount > 0 && dist(p, { x, y }) <= 20 && tileState(p.x, p.y) >= 1);
  if (patch && units.some(u => UNIT_TYPES[u.type].role === 'worker')) return { kind: 'harvest', x: patch.x, y: patch.y, size: 16 };
  return null; // plain move: leave the default cursor alone
}

// draw the contextual command reticle in iso-screen space
function drawReticle(hc) {
  const sx = isoX(hc.x, hc.y), sy = isoY(hc.x, hc.y);
  const r = Math.max(12, (hc.size || 12) * UNIT_DRAW_SCALE + 6);
  const pulse = 1 + 0.12 * Math.sin(state.time * 8);
  const s = r * pulse;
  const COL = { attack: '#ff5f5f', capture: '#ffd75f', repair: '#7fff9f', probe: '#7de3ff', garrison: '#7fff9f', tunnel: '#c9a7ff', harvest: '#7fffbf' }[hc.kind] || '#7fff9f';
  ctx.save();
  ctx.strokeStyle = COL; ctx.fillStyle = COL; ctx.lineWidth = 2;
  if (hc.kind === 'attack' || hc.kind === 'capture' || hc.kind === 'probe') {
    // corner brackets around the target
    const L = s * 0.5;
    for (const [cxs, cys] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(sx + cxs * s, sy + cys * s - cys * L);
      ctx.lineTo(sx + cxs * s, sy + cys * s);
      ctx.lineTo(sx + cxs * s - cxs * L, sy + cys * s);
      ctx.stroke();
    }
    if (hc.kind === 'attack') { // center crosshair
      ctx.beginPath(); ctx.moveTo(sx - 5, sy); ctx.lineTo(sx + 5, sy); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx, sy + 5); ctx.stroke();
    } else if (hc.kind === 'capture') { // wrench-in ↑ glyph
      ctx.beginPath(); ctx.moveTo(sx, sy + 4); ctx.lineTo(sx, sy - 5); ctx.moveTo(sx - 3, sy - 2); ctx.lineTo(sx, sy - 5); ctx.lineTo(sx + 3, sy - 2); ctx.stroke();
    }
  } else if (hc.kind === 'repair') {
    ctx.beginPath(); ctx.arc(sx, sy, s * 0.8, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(sx - 5, sy); ctx.lineTo(sx + 5, sy); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx, sy + 5); ctx.stroke();
  } else if (hc.kind === 'garrison' || hc.kind === 'tunnel') {
    // downward arrow into a box (enter)
    ctx.strokeRect(sx - s * 0.7, sy - s * 0.5, s * 1.4, s);
    ctx.beginPath(); ctx.moveTo(sx, sy - s * 0.9); ctx.lineTo(sx, sy + 2);
    ctx.moveTo(sx - 4, sy - 3); ctx.lineTo(sx, sy + 2); ctx.lineTo(sx + 4, sy - 3); ctx.stroke();
  } else if (hc.kind === 'harvest') {
    ctx.beginPath();
    ctx.moveTo(sx, sy - s * 0.7); ctx.lineTo(sx + s * 0.6, sy); ctx.lineTo(sx, sy + s * 0.7); ctx.lineTo(sx - s * 0.6, sy); ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

function minimapPan(e) {
  // the minimap is a plain top-down map: click → world point → center camera
  const r = mmCanvas.getBoundingClientRect();
  const wx = (e.clientX - r.left) / r.width * WORLD_W;
  const wy = (e.clientY - r.top) / r.height * WORLD_H;
  cam.x = isoX(wx, wy) - canvas.width / cam.zoom / 2;
  cam.y = isoY(wx, wy) - canvas.height / cam.zoom / 2;
  clampCam();
}

// right-click the minimap: order the selected units to that world point
// (attack-moves onto anything hostile there, like an in-world right-click)
function minimapCommand(e) {
  const r = mmCanvas.getBoundingClientRect();
  const wx = clamp((e.clientX - r.left) / r.width * WORLD_W, 10, WORLD_W - 10);
  const wy = clamp((e.clientY - r.top) / r.height * WORLD_H, 10, WORLD_H - 10);
  const mine = selection.filter(e => e.kind === 'unit' && e.hp > 0 && e.owner === localOwner);
  if (!mine.length) return;
  if (mine.some(s => UNIT_TYPES[s.type].role === 'combat')) cmd('attackmove', { u: idsOf(mine), x: wx, y: wy });
  else cmd('move', { u: idsOf(mine), x: wx, y: wy });
  // minimap pings are a view artefact — they live outside `state` so they can
  // never reach the hash, and two clients are free to disagree about them
  pings.push({ x: wx, y: wy, t: state.time });
  sfx('click');
}

// Pull a body back off the slab — the player changed their mind, or the
// Mechanicum came down around it. The fee is refunded and any salvaged suit
// goes back in the bank, because the rite never happened; a body that is still
// alive walks back out as whatever it already was.
function cancelRite(u) {
  if (!u || !u.ascension) return;
  const a = u.ascension, A = ASCEND[a.to], b = findEntity(a.bld);
  state.minerals[u.owner] = (state.minerals[u.owner] || 0) + (a.fee || 0);
  if (a.salvaged && A && A.tier) state.armorBank[u.owner][A.tier]++;
  delete u.ascension;
  if (b && b.rites) b.rites = b.rites.filter(id => id !== u.id);
  if (u.hp > 0) {
    u.garrisoned = false;
    if (b) { u.x = b.x + (simRandom() - 0.5) * 30; u.y = b.y + b.h / 2 + 20; }
    u.order = { type: 'idle' };
  }
}

// Mechanicum panel button: send the nearest idle body of the right tier in for
// this rite. Prefers whatever is already selected (so a hand-picked Guard gets
// entombed rather than a random one), then falls back to the closest idle body.
// `preferIds` is what the player had selected when they pressed the button,
// carried in the command. The choice of body has to be made from the command
// payload plus world state, never from `selection` — two clients with
// different selections would entomb different units.
function beginRite(b, key, preferIds) {
  const owner = b.owner;
  const A = ASCEND[key];
  // the rite's own prerequisites, checked HERE and not just on the button that
  // calls this: the Dreadnought needs the Reliquary standing, and every rung
  // needs its relics. Without this a disabled-looking rite still walked the
  // body over to the slab, where the order handler quietly refused it.
  if (!ascendReady(owner, key)) {
    if (owner === localOwner) eva(relicCount(owner) < A.relics
      ? `The rite needs ${A.relics} relics — ${relicCount(owner)} banked`
      : `The rite needs the ${facOf(owner).buildingNames[A.req] || A.req}`);
    return;
  }
  // the line is short on purpose: bodies in it are out of the fight, and the
  // fee is taken at the door, so a fat queue is a fat hole in your army AND
  // your bank. Five is plenty to keep the slab busy.
  const queued = (b.rites || []).length +
    state.units.filter(u => u.owner === owner && u.hp > 0 && u.order.type === 'ascend' && u.order.destId === b.id).length;
  if (queued >= 5) { if (owner === localOwner) eva('The slab is backed up'); return; }
  const free = u => u.owner === owner && u.hp > 0 && u.type === A.from &&
    !u.ascension && !u.garrisoned && !u.transit;
  const offered = (preferIds || []).map(id => state.units.find(u => u.id === id)).filter(u => u && free(u));
  const picked = offered.find(u => u.order.type === 'idle') || offered[0] ||
    nearest(b, state.units, u => free(u) && u.order.type === 'idle') ||
    nearest(b, state.units, free);
  if (!picked) { if (owner === localOwner) eva(`No ${UNIT_TYPES[A.from].name} to give`); return; }
  if (state.minerals[owner] < ascendFee(owner, key)) { if (owner === localOwner) eva('Insufficient funds'); return; }
  picked.order = { type: 'ascend', destId: b.id, key };
  sfx('click');
}

function evacuate(b) {
  let i = 0;
  const n = Math.max(1, b.garrison.length);
  for (const id of b.garrison) {
    const u = state.units.find(x => x.id === id && x.hp > 0);
    if (!u) continue;
    const a = (i++ / n) * Math.PI * 2;
    u.garrisoned = null;
    u.x = b.x + Math.cos(a) * (entityRadius(b) + 14);
    u.y = b.y + Math.sin(a) * (entityRadius(b) + 14);
    u.order = { type: 'idle' };
  }
  b.garrison = [];
  // Only CAPTURED CIVILIAN property reverts when you empty it — an abandoned
  // house is a house again. Anything you paid to build stays yours: a Patriot
  // Pillbox you stop manning is still your pillbox, and a homestead you muster
  // is still your farm. This used to fire unconditionally, so mustering a
  // homestead handed it to NEUTRAL: it stopped paying income, stopped counting
  // for the last-stand rule, and the enemy could walk a rifleman in and take
  // the farm you built. (Same bug for pillboxes, quietly, all along.)
  if (!bstatsOf(b).cost) b.owner = NEUTRAL;
  sfx('click');
  refreshPanel();
}

function sidebarStructureClick(type) {
  const st = bstats(localOwner, type);
  // field fortifications (walls, gates, mines): no build queue — go straight
  // into placement and pay per piece, so laying them never stalls the real
  // production queue
  if (st.instant) {
    if (placing === type) { placing = null; refreshPanel(); return; } // toggle off
    if (atStructCap(localOwner, type)) { eva('Build limit reached'); return; }
    const rq = st.req;
    if (rq && !hasStruct(localOwner, rq)) { eva(`Requires ${facOf(localOwner).buildingNames[rq] || rq}`); return; }
    if (state.minerals[localOwner] < st.cost) { eva('Insufficient funds'); return; }
    placing = type;
    sfx('click');
    refreshPanel();
    refreshSidebar();
    return;
  }
  const c = state.construction[localOwner];
  if (c && c.ready && c.type === type) { placing = type; refreshPanel(); return; }
  if (c) { eva('Unable to comply, building in progress'); return; }
  if (atStructCap(localOwner, type)) { eva('Build limit reached'); return; }
  if (homesteadBlocked(localOwner, type)) {
    const n = emptyHomesteads(localOwner).length;
    eva(`${n} homestead${n === 1 ? ' stands' : 's stand'} empty — work the land you have`);
    return;
  }
  const rq = st.req;
  if (rq && !hasStruct(localOwner, rq)) { eva(`Requires ${facOf(localOwner).buildingNames[rq] || rq}`); return; }
  if (state.minerals[localOwner] < st.cost) { eva('Insufficient funds'); return; }
  cmd('build', { t: type });
  sfx('click');
  refreshSidebar();
}

function sidebarUnitClick(type) {
  const ut = UNIT_TYPES[type];
  const hasTrainer = state.buildings.some(b => b.owner === localOwner && b.hp > 0 && b.done && b.type === ut.builtAt);
  if (!hasTrainer) { eva(`Requires ${facOf(localOwner).buildingNames[ut.builtAt] || ut.builtAt}`); return; }
  if (ut.req && !hasStruct(localOwner, ut.req)) { eva(`Requires ${facOf(localOwner).buildingNames[ut.req] || ut.req}`); return; }
  if (ut.pad && !padSlotsFree(localOwner, ut.builtAt)) { eva('Airfields at capacity'); return; }
  if (ut.limit && unitCount(localOwner, type) >= minerCap(localOwner, type)) { eva('Unit limit reached'); return; }
  if (state.minerals[localOwner] < ut.cost) { eva('Insufficient funds'); return; }
  if ((ut.loosh || 0) > (state.loosh[localOwner] || 0)) { eva('Not enough loosh'); return; }
  cmd('train', { t: type });
  sfx('click');
  refreshSidebar();
}

function makeCameo(grid, key, label, cost, onClick, onCancel) {
  const btn = document.createElement('button');
  btn.className = 'cameo';
  const prog = document.createElement('div'); prog.className = 'cameo-progress';
  const name = document.createElement('span'); name.className = 'cameo-name'; name.textContent = label;
  const costEl = document.createElement('span'); costEl.className = 'cameo-cost'; costEl.textContent = '$' + cost;
  const badge = document.createElement('span'); badge.className = 'badge'; badge.style.display = 'none';
  btn.append(prog, name, costEl, badge);
  btn.addEventListener('click', onClick);
  // right-click cancels whatever this cameo has queued (full refund)
  btn.addEventListener('contextmenu', e => { e.preventDefault(); if (onCancel) onCancel(); });
  grid.appendChild(btn);
  cameoButtons[key] = { btn, costEl, prog, badge, baseCost: cost, baseLabel: label };
}

// right-click on a structure cameo: scrap the queued (or ready-to-place)
// construction of that type and refund the full cost
function cancelConstruction(owner, type) {
  const c = state.construction[owner];
  if (!c || c.type !== type) return false;
  state.construction[owner] = null;
  state.minerals[owner] += bstats(owner, type).cost;
  if (owner === localOwner) eva('Construction canceled');
  sfx('click');
  return true;
}

// right-click on a unit cameo: pull the most recently queued unit of that
// type back out of its trainer's queue and refund the full cost
function cancelTraining(owner, type) {
  const ut = UNIT_TYPES[type];
  let best = null;
  for (const b of state.buildings) {
    if (b.owner !== owner || b.hp <= 0 || b.type !== ut.builtAt) continue;
    for (let i = b.queue.length - 1; i >= 0; i--) {
      if (b.queue[i].type === type) {
        if (!best || i > best.i) best = { b, i }; // deepest in queue = least progress lost
        break;
      }
    }
  }
  if (!best) {
    // a slave pit rarely has a standing queue — right-click culls a living
    // slave instead, and THAT death doesn't restock: the one way to shrink
    // the pit (the death still pays its loosh; the knife is the knife)
    if (ut.lifespan) {
      const pool = state.units.filter(u2 => u2.owner === owner && u2.hp > 0 && u2.type === type);
      const s = pool[pool.length - 1];
      if (s) { s.noRestock = true; s.hp = 0; sfx('click'); }
    }
    return;
  }
  best.b.queue.splice(best.i, 1);
  state.minerals[owner] += ut.cost;
  sfx('click');
}

// one-line "what it is, what it does" tooltips for sidebar cameos —
// generated from the stats, so new units and buildings describe themselves
function unitBlurb(type) {
  const t = UNIT_TYPES[type];
  const b = [];
  if (t.role === 'worker') b.push('worker — mines minerals and hauls them to a drop-off');
  else if (t.role === 'scout') b.push('scout — fast, far-sighted, fragile');
  if (t.captures) b.push('walk it into an enemy building to capture it (consumed)');
  if (t.tracker) b.push('fly onto an enemy unit to paint it: lasting vision + your army hits it 30% harder');
  if (t.repair) b.push(t.builtAt === 'factory' || t.flying ? 'repair unit — patches nearby damaged friendlies' : 'medic — heals nearby friendlies');
  if (t.kamikaze) b.push('one-way munition: dives into its target and detonates');
  if (t.dmg) {
    if (t.weapon === 'gunrun') b.push('saturation gun runs — shreds vehicles and infantry along the flight path, friend or foe alike');
    else if (t.weapon === 'bomb') b.push('bombing runs: releases on overflight');
    else if (t.weapon === 'lob') b.push('arcing artillery' + (t.minRange ? ' — outranges towers, helpless up close' : ''));
    else if (t.weapon === 'storm') b.push('calls a lightning storm onto the target zone');
    else if (t.weapon === 'spray') b.push('strafes with lingering area denial');
    else if (t.weapon === 'carpet') b.push('carpet bombing: walks a stick of bombs along its flight path');
    else if (t.weapon === 'abduct') b.push('tractor beam: pins and drains a ground unit, then abducts it outright');
    b.push(t.targets === 'air' ? 'anti-air ONLY' : t.targets === 'both' ? 'hits ground and air' : 'ground targets only');
    if (t.lowAir) b.push('can also reach LOW fliers — rotorcraft, drones, balloons, saucers — but never fast jets or high-altitude craft');
    if (t.dmgVsGround !== undefined && t.dmgVsGround < t.dmg) b.push('weak vs ground');
    if (t.vehBonus) b.push(`${t.vehBonus}× vs vehicles`);
    if (t.bldgBonus > 1) b.push(`${t.bldgBonus}× vs buildings`);
    else if (t.bldgBonus) b.push('feeble vs buildings');
    if (t.lance) b.push('one narrow annihilating blast at a time');
  } else if (t.role === 'combat' && !t.repair && !t.tracker && !t.kamikaze && !t.captures) {
    // a gunless carrier isn't "unarmed", it's EMPTY — say the thing the player
    // has to do about it, the way the pillbox blurb does
    b.push(t.cargoCap ? 'no gun of its own — rolling steel until you load it' : 'unarmed');
  }
  if (t.petrify) b.push('its gaze petrifies the victim to stone');
  if (t.leech) b.push('heals off the damage it deals');
  if (t.buffAura) b.push('aura: nearby friendlies deal +25% damage');
  if (t.hardenAura) b.push('aura: nearby friendlies take less damage');
  if (t.debuffAura) b.push('fear aura: nearby enemies hit weaker');
  if (t.brood) b.push('leads a bound escort that regrows over time');
  if (t.detector) b.push('DETECTOR: reveals stealth, disguise and burrowers');
  if (t.stealth) b.push('stealth — invisible until it fires');
  if (t.forestOnly) b.push('only fires from INSIDE a forest — invisible among the trees until the muzzle flash');
  if (t.establishes) b.push('DEPLOYS into a disguised front — skims a share of every enemy mineral delivery within reach, until a detector finds it');
  if (t.digger) b.push('right-click a Dig Site to excavate its relic (everyone sees the progress)');
  if (t.priest) b.push('recovers exposed relics (teleports home with the prize) and salvages fallen Guard/Dreadnought armor to halve the next rite');
  if (t.relentless) b.push('relentless: builds speed once it has a target marked, and runs foot troops down');
  if (t.volley) {
    const V = t.volley;
    const every = Array.isArray(V.every) ? `${V.every[0]}-${V.every[1]}s` : `${V.every}s`;
    b.push(`${V.name}: ${V.shots} rounds of ${V.dmg} every ${every} at range ${V.range}` +
      (V.lowAir ? ', reaching ground and low-flying craft' : ''));
    if (V.rockets) b.push(`then ${V.rockets.count} shoulder rockets (${V.rockets.dmg}) that WILL hit aircraft at any altitude`);
    b.push('the barrage keeps firing mid-melee, but wildly off-aim');
    if (V.charge) b.push('charges in behind its own volley');
  }
  if (t.deployable) b.push('must DEPLOY to fire (automatic in range); packs up to move');
  if (t.aaAura) b.push(`a shockwave field shreds aircraft within ${t.aaAura.r}`);
  if (t.armorTier) b.push('its fallen armor can be salvaged by a Tech Priest to halve the next rite');
  if (ASCEND[type]) {
    const A = ASCEND[type];
    b.push(`NOT trained — made in the Mechanicum out of one ${UNIT_TYPES[A.from].name} + $${A.cost}` +
      (A.relics ? ` + ${A.relics} relics` : '') +
      (A.req ? `, and only once the ${facOf(localOwner).buildingNames[A.req] || A.req} stands` : ''));
  }
  if (t.mendAura) b.push(`field hospital: mends everything of yours within ${t.mendAura.r} for ${t.mendAura.rate}/s, on the move`);
  if (t.convert) b.push(`every ${t.convert.every}s one enemy footsoldier within ${t.convert.r} walks over to your side`);

  if (t.cloakStill) b.push('cloaks while holding still; the first shot from cloak hits double');
  if (t.burrow) b.push('can burrow: hidden and safe, but slow and unarmed below');
  if (t.plantMine) b.push('buries free IEDs on its own while idle (spaced out, up to 8 per side)');
  if (t.jams) b.push('its hits scramble aircraft avionics');
  if (t.pad) b.push(`lives on the airfield: ${t.maxAmmo} shots per sortie, lands to rearm`);
  if (t.cargoCap) b.push(`carries ${t.cargoCap} light infantry who fire from inside (right-click to board)${t.bailOut ? ' — riders bail out, hurt but alive, if it dies' : ' — riders die with the vehicle'}`);
  if (t.portRange) b.push(`firing ports: riders shoot +${t.portRange} further from the slits than on foot`);
  if (isCrusher(t)) b.push('crushes light infantry under its hull');
  if (t.limit) b.push(`max ${t.limit}`);
  if (t.loosh) b.push(`also costs ${t.loosh} LOOSH`);
  if (t.lifespan) b.push(`worked to death in ~${t.lifespan}s — every death pays ${t.looshOnDeath || 0} loosh and the Hatchery auto-buys a replacement; the Drive button sets the regime, and the pit deepens by 4 for the Gene Vault and 4 more for the Bloodline Throne`);
  if (t.batch) b.push(`cloned ${t.batch} at a time`);
  const s = b.join('; ') || 'combat unit';
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function buildingBlurb(type) {
  const bt = bstats(localOwner, type);
  const b = [];
  if (type === 'barracks') b.push('trains infantry');
  if (type === 'factory') b.push('builds vehicles');
  if (bt.padCap) b.push(`airfield: builds, parks and rearms up to ${bt.padCap} aircraft`);
  if (type === 'tech') b.push('research site — unlocks the advanced roster');
  if (bt.dmg) b.push(`defense tower — ${bt.targets === 'air' ? 'ANTI-AIR only' : bt.targets === 'both' ? 'hits ground and air' : 'anti-ground'}, ${bt.dmg} dmg at range ${bt.atkRange}`);
  if (bt.power > 0) b.push(`+${bt.power} power`);
  else if (bt.power < 0) b.push(`draws ${-bt.power} power`);
  if (bt.income) b.push(`prints +${bt.income} minerals / 10s`);
  if (bt.dropoff) b.push('mineral drop-off — each one also raises your mining-rig cap by one');
  if (bt.beacon) b.push('BEACON: every player sees it the moment it finishes, scouted or not — and it does NOT extend your build radius');
  if (bt.repairRate) b.push('repairs vehicles and aircraft parked on it');
  if (bt.healAura) b.push('heals nearby friendlies');
  if (bt.research) b.push(`research annexe: every one of these standing speeds Institute disproofs by ${Math.round(bt.research * 100)}%`);
  if (bt.slots && bt.cost) b.push(`unarmed concrete until garrisoned — right-click with infantry (${bt.slots} slots) to man the firing slits`);
  if (bt.detector) b.push('DETECTOR: reveals stealth, disguise and burrowers');
  if (bt.superweapon) {
    b.push('superweapon — charges over minutes, then devastates a target zone anywhere on the map');
    if (isReptilian(localOwner)) b.push('the throne also deepens the slave pit by 4 while it stands');
  }
  if (bt.thief) b.push(`skims ${Math.round(bt.thief.cut * 100)}% of every enemy mineral load delivered within ${bt.thief.r} — silently, until a detector exposes it`);
  if (bt.trip) b.push('buried charge — detonates under enemy ground forces');
  if (type === 'wall') b.push('blocks ground movement');
  if (type === 'gate') b.push('wall segment that lets your own ground forces through');
  if (type === 'tunnelentrance') b.push('tunnel mouth — your ground units travel underground between entrances');
  if (bt.revealMap) b.push('lifts the fog from the whole map and plots every structure on it — but not their army: overhead imagery finds buildings, not units');
  if (bt.spawns) b.push(bt.spawns.max
    ? `staffs a detachment of ${bt.spawns.max} ${UNIT_TYPES[bt.spawns.type].name}s — replaces losses every ${bt.spawns.every}s, but never grows past ${bt.spawns.max}`
    : `turns out a free ${UNIT_TYPES[bt.spawns.type].name} every ${bt.spawns.every}s`);
  if (type === 'mechanicum') {
    b.push('the ascension slab: Mole Servitors walk in and Tech Priests, Lantern Guards and Dreadnoughts walk out');
    b.push(Object.entries(ASCEND).map(([k, A]) =>
      `${UNIT_TYPES[k].name} $${A.cost}${A.relics ? ' + ' + A.relics + ' relics' : ''}` +
      (A.req ? ` + ${facOf(localOwner).buildingNames[A.req] || A.req}` : '')).join(', '));
    b.push('select it and press a rite, or right-click it with bodies already selected');
  }
  const s = b.join('; ') || 'structure';
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

function buildSidebar() {
  gridStructures.innerHTML = '';
  gridUnits.innerHTML = '';
  for (const k of Object.keys(cameoButtons)) delete cameoButtons[k];
  const f = facOf(localOwner);

  let structs = ['powerplant', 'barracks', f.tower, f.aaTower, 'factory', 'airpad', 'tech', ...(f.structs || [])];
  if (!superweaponsOn) structs = structs.filter(s => s !== 'superweapon');
  for (const s of structs) {
    // a faction that never renamed a slot falls back to the base table's name
    // (Hollow has no word for "Refinery"), and only then to the raw type key
    makeCameo(gridStructures, 's:' + s, f.buildingNames[s] || bstats(localOwner, s).name || s, bstats(localOwner, s).cost,
      () => sidebarStructureClick(s), () => cancelStructureCmd(s));
    cameoButtons['s:' + s].btn.title = buildingBlurb(s) +
      (bstats(localOwner, s).req ? `\nRequires ${f.buildingNames[bstats(localOwner, s).req] || bstats(localOwner, s).req}` : '');
  }
  const unlocks = [...(f.advanced || []).map(u => UNIT_TYPES[u].name),
    ...(bstats(localOwner, 'airpad').req === 'tech' ? [f.buildingNames.airpad || 'Airfield'] : [])];
  cameoButtons['s:tech'].btn.title = buildingBlurb('tech') +
    (unlocks.length ? '\nUnlocks: ' + unlocks.join(', ') : '');
  // worker-less factions have no worker cameo — their buildings pay the bills
  const unitList = [f.worker, f.infantry, f.aa, f.extras[0], f.vehicle, f.extras[1],
    ...f.air, ...f.extras.slice(2), ...(f.advanced || [])].filter(Boolean);
  for (const u of unitList) {
    makeCameo(gridUnits, 'u:' + u, UNIT_TYPES[u].name, UNIT_TYPES[u].cost,
      () => sidebarUnitClick(u), () => cmd('canceltrain', { t: u }));
    cameoButtons['u:' + u].btn.title = unitBlurb(u) +
      (UNIT_TYPES[u].req ? `\nRequires ${f.buildingNames[UNIT_TYPES[u].req] || UNIT_TYPES[u].req}` : '');
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
  const pk = facOf(localOwner).powers.sig;
  const sig = state.sig[localOwner];
  if (pk.kind === 'auto' || pk.kind === 'info') return;
  // The 'once' and 'instant' powers fire the moment you press the button, so
  // they have to travel as COMMANDS like everything else. They used to call
  // castRevealInfiltrator/castGaslight straight from here, which mutated the
  // world outside the tick — one client changed an infiltrator's owner and
  // spawned phantoms that the other client never heard about, so Reveal
  // Infiltrator desynced a networked match the instant it was pressed.
  // (The targeted kinds were always fine: they arm abilityTargeting and the
  // map click posts an `ability` command.)
  if (pk.kind === 'once') {
    if (!sig.used) { cmd('sig'); sfx('click'); }
    refreshSidebar();
    return;
  }
  if (sig.cd > 0) return;
  if (pk.kind === 'instant') { cmd('sig'); sfx('click'); refreshSidebar(); return; }
  abilityTargeting = pk.kind;
  refreshPanel();
}

// The research strip. Same job the Conviction meter did — tell the player what
// is happening and what it is worth — but about a thing they chose to do.
function refreshResearch() {
  if (!isFlat(localOwner)) { elResWrap.classList.remove('on'); elResWhy.classList.remove('on'); return; }
  elResWrap.classList.add('on'); elResWhy.classList.add('on');

  const r = state.research[localOwner];
  const done = Object.keys(state.disproof[localOwner] || {});
  const all = Object.keys(DISPROOFS);
  const spd = researchSpeed(localOwner);

  if (r) {
    const left = Math.ceil((r.dur - r.t) / spd);
    elResFill.style.width = (r.t / r.dur * 100).toFixed(1) + '%';
    elResFill.classList.remove('falling');
    elResFill.classList.toggle('hot', r.t / r.dur > 0.75);
    elResText.textContent = `🔬 ${left}s`;
    elResWhy.innerHTML = `proving <b>${DISPROOFS[r.key].name}</b>` +
      (spd > 1 ? ` · <b>x${spd.toFixed(2)}</b> from Ham Radios` : ' · <span class="bad">no Ham Radio</span>') +
      '<br>' + (done.length ? 'proven: <b>' + done.map(k => DISPROOFS[k].name).join('</b> · <b>') + '</b>'
                            : `${all.length - done.length} left to disprove`);
  } else {
    elResFill.style.width = (done.length / all.length * 100).toFixed(1) + '%';
    elResFill.classList.toggle('falling', done.length === 0);
    elResFill.classList.toggle('hot', done.length === all.length);
    elResText.textContent = `🔬 ${done.length}/${all.length}`;
    elResWhy.innerHTML = (done.length ? 'proven: <b>' + done.map(k => DISPROOFS[k].name).join('</b> · <b>') + '</b>'
                                       : '<span class="bad">nothing disproved yet</span>') +
      '<br>' + (done.length === all.length ? 'the record is complete'
                : 'select the <b>Institute of Truth</b> to begin the next disproof');
  }
  elResWrap.title = 'DISPROOF — the Flat Earth strategic layer.\n' +
    'The Institute of Truth proves an enemy capability FAKE, and a disproved\n' +
    'thing stops working on you for the rest of the match. One at a time, no\n' +
    'refunds. Every Ham Radio Shack standing shortens the wait.\n' +
    'Scout what they are actually fielding, then deny exactly that.';
}

function refreshSidebar() {
  if (!started) return;
  refreshResearch();
  elCredits.textContent = '$ ' + state.minerals[localOwner] +
    (isReptilian(localOwner) ? '   ☠ ' + Math.floor(state.loosh[localOwner] || 0) : '') +
    (isHollow(localOwner) ? '   🗿 ' + relicCount(localOwner) : '') +
    (facOf(localOwner) && facOf(localOwner).hqRebuild && facOf(localOwner).hqRebuild.auto !== undefined
      ? '   🗄 ' + Math.floor(state.leverage[localOwner] || 0) : '');
  const power = powerOf(localOwner);
  elPowerFill.style.width = power.cap ? clamp(100 - power.used / power.cap * 100, 0, 100) + '%' : '0%';
  elPowerFill.classList.toggle('low', power.low);
  elPowerText.textContent = `⚡ ${power.used} / ${power.cap}`;

  const c = state.construction[localOwner];
  for (const [key, ui] of Object.entries(cameoButtons)) {
    const [kind, type] = [key[0], key.slice(2)];
    if (kind === 'p') {
      if (type !== 'sig') continue;
      const pk = facOf(localOwner).powers.sig;
      const sig = state.sig[localOwner];
      // toggle with an explicit boolean: remove-then-maybe-add rewrote the
      // class attribute every refresh even when nothing changed
      if (pk.kind === 'auto') {
        const period = pk.period;
        ui.btn.classList.toggle('castable', false);
        ui.prog.style.height = clamp(sig.timer / period * 100, 0, 100) + '%';
        ui.costEl.textContent = Math.ceil(Math.max(0, period - sig.timer)) + 's';
      } else if (pk.kind === 'info') {
        ui.btn.classList.toggle('castable', false);
        ui.costEl.textContent = 'ALWAYS ON';
      } else if (pk.kind === 'once') {
        ui.costEl.textContent = sig.used ? 'USED' : 'READY';
        ui.btn.classList.toggle('castable', !sig.used);
      } else {
        ui.prog.style.height = sig.cd > 0 ? (sig.cd / pk.cd * 100) + '%' : '0%';
        ui.costEl.textContent = sig.cd > 0 ? Math.ceil(sig.cd) + 's' : 'READY';
        ui.btn.classList.toggle('castable', sig.cd <= 0);
      }
      continue;
    }
    if (kind === 's') {
      const st = bstats(localOwner, type);
      // field fortifications never enter the build queue, so they stay live
      // even while a real structure is under construction
      if (st.instant) {
        const capped = atStructCap(localOwner, type);
        const rq = st.req;
        const locked = !!rq && !hasStruct(localOwner, rq);
        const active = placing === type;
        const poor = state.minerals[localOwner] < st.cost;
        ui.btn.classList.toggle('ready', active);
        ui.btn.classList.toggle('disabled', locked || capped || (poor && !active));
        ui.prog.style.height = '0%';
        ui.costEl.textContent = active ? 'PLACING'
          : locked ? '🔒 ' + (facOf(localOwner).buildingNames[rq] || rq)
          : capped ? 'MAX'
          : '$' + ui.baseCost;
        continue;
      }
      const isThis = c && c.type === type;
      const capped = atStructCap(localOwner, type);
      const rq = st.req;
      // NB: must be a real boolean — classList.toggle(name, undefined) is a
      // plain toggle and would flip the class every refresh (sidebar strobe)
      const locked = !!rq && !hasStruct(localOwner, rq);
      ui.btn.classList.toggle('ready', !!(isThis && c.ready));
      ui.btn.classList.toggle('disabled', !!(c && !isThis) || (capped && !isThis) || locked);
      ui.prog.style.height = isThis && !c.ready ? (c.t / c.duration * 100) + '%' : '0%';
      const cap = bstats(localOwner, type).cap;
      ui.costEl.textContent = isThis && c.ready ? 'PLACE'
        : locked ? '🔒 ' + (facOf(localOwner).buildingNames[rq] || rq)
        : capped ? 'MAX'
        : '$' + ui.baseCost + (cap ? ` (${countStruct(localOwner, type)}/${cap})` : '');
    } else {
      const ut = UNIT_TYPES[type];
      const trainers = state.buildings.filter(b => b.owner === localOwner && b.hp > 0 && b.done && b.type === ut.builtAt);
      const locked = !!ut.req && !hasStruct(localOwner, ut.req);
      // the LIVE cap, not the base one — refineries lift the miner ceiling
      // (and the Gene Vault deepens the slave pit) while they stand
      const cap = ut.limit ? minerCap(localOwner, type) : 0;
      const have = ut.limit ? unitCount(localOwner, type) : 0;
      const capped = !!ut.limit && have >= cap;
      ui.btn.classList.toggle('disabled', trainers.length === 0 || locked || capped);
      ui.costEl.textContent = locked ? '🔒 ' + (facOf(localOwner).buildingNames[ut.req] || ut.req)
        : capped ? 'MAX'
        : '$' + ui.baseCost + (ut.loosh ? ` ☠${ut.loosh}` : '') + (ut.limit ? ` (${have}/${cap})` : '');
      const queued = trainers.reduce((n, b) => n + b.queue.filter(j => j.type === type).length, 0);
      ui.badge.style.display = queued ? '' : 'none';
      ui.badge.textContent = queued;
      const active = trainers.find(b => b.queue.length && b.queue[0].type === type);
      ui.prog.style.height = active ? (active.queue[0].t / active.queue[0].duration * 100) + '%' : '0%';
    }
  }
}

// `opts.humans` is the lobby's seat assignment: [{ owner, faction }, ...].
// `opts.as` is which of those seats this screen is sitting in. Both default to
// the single-player answer — one human, owner zero, watching itself.
function startGame(faction, seed, opts) {
  // ONE seed drives every sim-side roll for the whole match: map layout, AI
  // faction picks, spawn jitter, damage rolls. Pass one in (tests, replays, a
  // future lobby handshake) or let the clock pick one. Nothing else may seed
  // the sim stream after this point.
  state.seed = (seed !== undefined ? seed : Date.now()) >>> 0;
  RNG.seedSim(state.seed);
  state.tick = 0;
  state.time = 0;
  accumulator = 0;
  commandQueue.clear();
  for (const k of Object.keys(cmdSeq)) delete cmdSeq[k];
  // Full world reset. This used to be missing, and a second startGame() in one
  // page stacked a fresh set of bases on top of the old ones — which is fine
  // for a human who reloads between games, and fatal for a desync harness that
  // has to run the same match twice in one page.
  state.units = [];
  state.buildings = [];
  state.patches = [];
  state.projectiles = [];
  state.zones = [];
  state.digSites = [];
  state.armorWrecks = [];
  state.charges = [];
  state.reveals = [];
  state.bcast = {}; state.bcastT = {};
  state.floats = [];
  state.airTechOwners = new Set();
  state.over = false;
  state._slaveT = 0;
  selection = [];
  pings = [];
  nextId = 1;
  for (const k of Object.keys(ais)) delete ais[k];
  // module-level sim scratch that survives a match otherwise: the path epoch
  // is stamped onto every cached unit path, and the per-tick memos are keyed
  // on state.time, which has just gone back to zero
  pathEpoch = 0;
  pathDirty = true;
  enemyMemo = { t: -1 };
  detMemo = { t: -1 };
  powerMemo = { t: -1 };
  document.getElementById('faction-select').classList.add('hidden');
  const size = MAP_SIZES[selectedSize];
  // In a networked match the lobby has already counted the seats — humans plus
  // whatever AIs were asked for. Single player derives it from the opponent
  // picker, which is the same sum with exactly one human.
  const total = (opts && opts.extraSeats)
    ? clamp(opts.extraSeats, 2, size.maxPlayers)
    : clamp(selectedOpponents, 1, size.maxPlayers - 1) + 1;
  OWNERS = Array.from({ length: total }, (_, o) => o);

  // seat assignment. Single player is the one-element case of the lobby.
  const seats = (opts && opts.humans && opts.humans.length)
    ? opts.humans
    : [{ owner: PLAYER, faction }];
  humanOwners.clear();
  for (const h of seats) humanOwners.add(h.owner);
  localOwner = (opts && opts.as !== undefined) ? opts.as : seats[0].owner;
  // the AIs play random factions from families other than the first human's
  const others = Object.keys(FACTIONS).filter(k => FACTIONS[k].family !== FACTIONS[faction].family);
  for (const h of seats) state.factions[h.owner] = h.faction || faction;
  state.slaveDrive = {}; // per-owner slave work regime (defaults to Normal)
  let aiSlot = 0;        // which AI seat we are filling, for opts.aiFactions
  for (const owner of OWNERS) {
    state.construction[owner] = null;
    state.sig[owner] = { cd: 0, timer: 0, used: false };
    state.infiltrator[owner] = null;
    state.eco[owner] = 0;
    if (!isHuman(owner)) {
      // an explicit pick wins; otherwise the seed chooses, avoiding the first
      // human's own family. The simRandom() draw happens either way so that
      // choosing a faction cannot shift the RNG cursor and desync a lobby.
      const roll = others[Math.floor(simRandom() * others.length)];
      const picked = (opts && opts.aiFactions) ? opts.aiFactions[aiSlot] : null;
      aiSlot++;
      state.factions[owner] = (picked && FACTIONS[picked]) ? picked : roll;
      ais[owner] = { attackWaveSize: 5, thinkTimer: simRandom(), time: 0 };
    }
    // worker-less factions get a head start while their income ramps up
    state.minerals[owner] = 300 + (facOf(owner).economy.start || 0);
    state.loosh[owner] = 0;
    state.disproof[owner] = {};
    state.research[owner] = null;
    state.relics[owner] = [];
    state.armorBank[owner] = { guard: 0, dread: 0 };
    state.leverage[owner] = 0;
    state.books[owner] = null;
    state.hqGrace[owner] = null;
    state.hqRebuilt[owner] = false;
  }
  state.digSites = []; state.armorWrecks = [];
  state.charges = [];
  state.reveals = []; state.bcast = {}; state.bcastT = {};
  state.floats = [];
  skimHintSeen = false;
  announcedBuild = {};
  announcedSuper.clear();

  setupWorld(generateMap(selectedSize, OWNERS.length, selectedSetting === 'random' ? null : selectedSetting));
  // seedDigSites() calls terrainNear(), which reads terrainIndex — and
  // terrainIndex is only ever rebuilt by ensurePathGrid() on the first tick,
  // i.e. AFTER this runs. On a fresh page it was therefore empty (so the
  // "never inside impassable terrain" check silently passed everything), and
  // on a second match it still held the PREVIOUS map's obstacles. Build it
  // here so the check actually looks at this map.
  markPathDirty();
  ensurePathGrid();
  seedDigSites(); // after bases exist — sites keep clear of every starting camp
  const vs = OWNERS.filter(o => o !== localOwner)
    .map(o => `${facOf(o).emoji} ${facOf(o).name}`).join('  +  ');
  // the header names THIS screen's side, which is not the `faction` argument
  // once the screen can be sitting in a seat other than the first one
  const me = facOf(localOwner);
  document.getElementById('faction-label').textContent = `${me.emoji} ${me.name}  vs  ${vs}`;
  buildSidebar();
  started = true;
  refreshPanel();
  refreshSidebar();
  eva('Battle control online');
}

// which buttons SHOULD be showing right now, as a cheap string — so the
// periodic panel refresh can update the info text live without tearing down
// and rebuilding the action buttons every tick (a rebuild mid-click drops the
// click, which is why Launch/orders sometimes needed several presses)
function panelSignature() {
  let s = (placing || '') + '|' + (attackMoveArmed ? 'a' : '') + (plantArmed ? 'p' : '') +
    (abilityTargeting || '') + (superTargeting || '') + (leverageTargeting || '') + (wallDrag ? 'w' : '') +
    (cacheTargeting ? 'c' : '') + (dropTargeting || '') + (demoTargeting ? 'd' : '') + (bcastTargeting || '') +
    // leverage crosses a play's price threshold -> its button enables
    (state.leverage[localOwner] ? 'L' + Object.values(LEVERAGE_PLAYS).filter(pl => state.leverage[localOwner] >= pl.cost).length : '') +
    (isReptilian(localOwner) ? 'd' + slaveDriveOf(localOwner) : '') +
    // the Institute's buttons enable/disable as a disproof finishes, as one
    // starts, and as the bank crosses each price
    (isFlat(localOwner) ? 'R' + Object.keys(state.disproof[localOwner] || {}).length +
      (state.research[localOwner] ? state.research[localOwner].key : '-') +
      Object.values(DISPROOFS).filter(D => state.minerals[localOwner] >= D.cost).length : '') +
    // the HQ grace window owns the whole panel while it runs, and its
    // Re-establish button has to appear the instant the HQ falls
    (state.hqGrace[localOwner] && !hasHq(localOwner) ? 'HQ!' : '') + '|';
  for (const e of selection) {
    if (e.hp <= 0) continue;
    s += e.kind + e.id + '·';
    if (e.kind === 'building') {
      const bt = bstatsOf(e);
      if (e.garrison) s += 'g' + e.garrison.length;
      if (bt.superweapon) s += 'S' + (((e.charge || 0) >= superChargeOf(e) && !isOffline(e)) ? '1' : '0');
      // the Bush Plane's Launch button appears the moment the third Marksman
      // walks aboard, so the crew count has to be part of the signature
      if (bt.bushplane) s += 'F' + planeCrew(e) + (e.launched ? '!' : '');
      // the ✓ moves between the Stock buttons, and the count ticks down
      if (bt.cache) s += 'C' + e.kits + (e.kit || '');
      if (e.rites) s += 'M' + e.rites.join('.'); // the Mechanicum queue owns a cancel button each
      // Repair/Stop swap as damage is taken and mended — the button has to follow
      s += 'R' + (e.repairing ? '1' : canRepair(e) ? '2' : '0');
      s += 'D' + (e.demolishT !== undefined ? '1' : '0'); // Demolish <-> Stop demolition
    } else {
      const ut = UNIT_TYPES[e.type];
      if (ut.burrow) s += e.burrowed ? 'B1' : 'B0';
      if (ut.plantMine) s += e.planted ? 'P1' : 'P0';
      if (e.sleeperFor === localOwner) s += 'A1'; // asset: owns a Wake button
      // Bury Cache <-> Resupply swap as the last cache goes in the ground, and
      // Set Charge disappears with the last charge
      if (ut.caches) s += 'K' + (e.caches || 0);
      if (ut.charges) s += 'X' + (e.charges || 0);
      if (ut.investigator) s += 'J' + stanceOf(e) + (e.proof > 0 ? 'f' : '-');
      if (ut.vanKit || ut.loader) s += 'V' + (ut.vanKit || '-') + (e.cargo || []).length;
    }
  }
  return s;
}

// While the player is mid-gesture — placing a structure, aiming a power, down
// to their last HQ — that state OWNS the panel and nothing else is shown.
// Returns true when it took over.
function panelTargetingMode(addAction) {
  if (placing) {
    const nm = facOf(localOwner).buildingNames[placing] || placing;
    elSelInfo.textContent = placing === 'gate'
      ? `Placing ${nm} — click a straight segment of your wall, Esc to cancel`
      : placing === 'hq'
        ? `Re-establishing ${nm} — click ANYWHERE on the map, Esc to cancel`
        : `Placing ${nm} — click a spot near your base, Esc to cancel`;
    return true;
  }
  // the grace window: HQ gone, clock running, one rebuild left. This outranks
  // every other panel state — nothing else matters while it is counting down.
  const g = state.hqGrace[localOwner], def = hqRebuildDef(localOwner);
  if (g && def && !hasHq(localOwner)) {
    const left = Math.max(0, Math.ceil(g.until - state.time));
    elSelInfo.style.color = '#ff9f8f';
    elSelInfo.textContent = def.auto !== undefined
      ? `HQ DOWN — continuity protocol relocating, ${Math.max(0, Math.ceil(def.auto - (state.time - g.at)))}s`
      : `HQ DOWN — re-establish within ${left}s or the war is lost`;
    if (def.auto === undefined) {
      const btn = document.createElement('button');
      btn.textContent = `Re-establish HQ — ${def.cost}`;
      btn.disabled = state.minerals[localOwner] < def.cost;
      btn.onclick = () => { placing = 'hq'; refreshPanel(); };
      addAction(btn);
    }
    return true;
  }
  if (attackMoveArmed) {
    elSelInfo.textContent = 'Attack-move — left-click a destination, Esc to cancel';
    return true;
  }
  if (abilityTargeting) {
    elSelInfo.textContent =
      abilityTargeting === 'zone' ? (isFlat(localOwner)
        ? 'The Firmament — click the patch of sky to make solid, Esc to cancel'
        : 'Weather Modification — click a target area, Esc to cancel')
      : abilityTargeting === 'recall'
        ? `Vril Recall — click a patch of ground (${recallTargets(localOwner, mouse.x, mouse.y).length}/${recallDef(localOwner).max} in the circle), Esc to cancel`
        : 'Cloning Vats — click one of your infantry, Esc to cancel';
    return true;
  }
  if (leverageTargeting) {
    const play = LEVERAGE_PLAYS[leverageTargeting];
    elSelInfo.style.color = '#c9a7ff';
    elSelInfo.textContent = `${play.name} (${play.cost} leverage) — click an ENEMY structure, Esc to cancel`;
    return true;
  }
  if (superTargeting) {
    const sw = state.buildings.find(b => b.id === superTargeting);
    elSelInfo.textContent = (sw ? buildingName(sw) : 'Superweapon') + ' — click a target, Esc to cancel';
    return true;
  }
  return false;
}

// ---------- repair, for every faction and every structure ----------
// Deliberately BEFORE the per-type branches (each of which owns its own
// buttons), so a Superweapon, a Mechanicum and a garrisoned pillbox all get the
// same repair control. Works on a whole box-selection of buildings at once,
// which is how you actually use it after a raid.
function panelRepairControls(addAction) {
  const mine = selection.filter(e => e.kind === 'building' && e.owner === localOwner);
  const busy = mine.filter(e => e.repairing);
  const hurt = mine.filter(e => canRepair(e) && !e.repairing);
  if (busy.length) {
    const btn = document.createElement('button');
    const rate = busy.reduce((s, e) => s + repairCostPerSec(e), 0);
    btn.textContent = `Stop repairs (${busy.length})`;
    btn.title = `Currently spending $${rate.toFixed(1)}/s`;
    btn.onclick = () => { cmd('repair', { b: idsOf(busy), on: false }); refreshPanel(); };
    addAction(btn);
  }
  if (hurt.length) {
    const btn = document.createElement('button');
    const rate = hurt.reduce((s, e) => s + repairCostPerSec(e), 0);
    btn.textContent = `Repair ${hurt.length > 1 ? `all (${hurt.length})` : ''} — $${rate.toFixed(1)}/s`.replace('  ', ' ');
    btn.title = 'Mends at ' + Math.round(REPAIR_RATE * 100) + '% of max HP per second, billed as it goes' +
      (powerOf(localOwner).low ? ' — HALF SPEED while the grid is browned out' : '');
    btn.onclick = () => { cmd('repair', { b: idsOf(hurt), on: true }); refreshPanel(); };
    addAction(btn);
  }

  // ---------- demolition ----------
  // Last in the block, so it never sits where Repair was a moment ago and eats
  // a click meant for something else.
  const razing = mine.filter(e => e.demolishT !== undefined);
  const standing = mine.filter(e => e.demolishT === undefined && canDemolish(e));
  if (razing.length) {
    const btn = document.createElement('button');
    const left = Math.max(...razing.map(e => e.demolishT));
    btn.textContent = `Stop demolition (${razing.length})`;
    btn.title = `${left.toFixed(1)}s from dropping`;
    btn.onclick = () => { cmd('demolish', { b: idsOf(razing), on: false }); refreshPanel(); };
    addAction(btn);
  }
  if (standing.length) {
    const back = standing.reduce((s, e) => s + demolishRefund(e), 0);
    const btn = document.createElement('button');
    btn.textContent = `Demolish ${standing.length > 1 ? `(${standing.length}) ` : ''}— +$${back}`;
    btn.title = `Pulls it down over ${DEMOLISH_TIME}s and refunds ` +
      `${Math.round(DEMOLISH_REFUND * 100)}% of the build cost. ` +
      'Destroyed before the timer runs out and you get nothing' +
      (back === 0 ? ' — this one cost you nothing to take, so it pays nothing back' : '');
    btn.onclick = () => { cmd('demolish', { b: idsOf(standing), on: true }); refreshPanel(); };
    addAction(btn);
  }
}

function refreshPanel() {
  selection = selection.filter(e => e.hp > 0);
  const sig = panelSignature();
  const rebuild = sig !== lastPanelSig;
  lastPanelSig = sig;
  const addAction = el => { if (rebuild) elActions.appendChild(el); };
  if (rebuild) elActions.innerHTML = '';

  if (panelTargetingMode(addAction)) return;
  elSelInfo.style.color = '';
  if (selection.length === 0) { elSelInfo.textContent = 'Nothing selected'; return; }

  const first = selection[0];
  if (selection.length === 1 && first.owner === NEUTRAL) {
    const bt = bstatsOf(first);
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      (bt.slots ? ` — right-click with infantry to garrison (${bt.slots} slots)` : '') +
      (bt.income ? ` — pays +${bt.income} minerals / 10s while held` : '') +
      (bt.airTech ? ' — recovered UFO tech: your aircraft hit +15% and self-repair while held' : '');
    return;
  }
  if (selection.length === 1 && first.owner !== localOwner) {
    // one of ours, standing in their line: offer to wake it
    if (first.kind === 'unit' && first.sleeperFor === localOwner) {
      elSelInfo.style.color = '#c9a7ff';
      elSelInfo.textContent = `ASSET — ${UNIT_TYPES[first.type].name} (embedded with ${facOf(first.owner).name})` +
        `  |  HP ${Math.ceil(first.hp)}/${UNIT_TYPES[first.type].hp}  |  you see what it sees`;
      const btn = document.createElement('button');
      btn.textContent = 'Wake asset';
      btn.title = 'It turns on the spot and fights for you from here on. It cannot be put back to sleep.';
      btn.onclick = () => { cmd('wake', { u: first.id }); refreshPanel(); refreshSidebar(); };
      addAction(btn);
      return;
    }
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
      else if (t.lowAir) parts.push('Low air only');
      if (t.bldgBonus) parts.push(`${t.bldgBonus}× vs buildings`);
      elSelInfo.textContent = parts.join('  |  ');
    } else {
      const bt = bstatsOf(first);
      const parts = [`☠ ${buildingName(first)} (${fName})`, `HP ${Math.ceil(first.hp)}/${bt.hp}`];
      if (bt.dmg) parts.push(`DMG ${bt.dmg} every ${bt.cooldown}s`, `Range ${bt.atkRange}`, bt.targets === 'air' ? 'Anti-air only' : 'Ground only');
      if (bt.power > 0) parts.push(`+${bt.power} power`);
      if (bt.income) parts.push(`+${bt.income} minerals / 10s`);
      elSelInfo.textContent = parts.join('  |  ');
    }
    return;
  }
  panelRepairControls(addAction);
  if (selection.length === 1 && first.kind === 'building') panelForBuilding(first, addAction);
  else panelForSelection(addAction);

  // The Flat Earth field actions are placement modes, so they say so in the
  // same words structure placement does — including how to back out. This runs
  // LAST because the selection panels rewrite the info line; unlike `placing`
  // they do not take the panel over, so the Cancel toggle stays reachable.
  const aimHint = cacheTargeting
    ? 'Burying a cache — click past your build radius and near their base, right-click to place, Esc to cancel'
    : demoTargeting ? 'Setting a charge — click an enemy structure, Esc to cancel'
    : dropTargeting ? 'Choosing a drop zone — click scouted ground, Esc to cancel'
    : bcastTargeting ? `${BROADCASTS[bcastTargeting].name} — click the area to expose, Esc to cancel` : null;
  if (aimHint) elSelInfo.textContent = aimHint;
}

// the single-structure panel: garrison, rally, production, rites, faction plays
function panelForBuilding(first, addAction) {
  const bt = bstatsOf(first);
  // ---------- the Bush Plane on its strip ----------
  // Not a garrison and not a factory: it is a loaded gun that fires once.
  if (bt.bushplane && first.owner === localOwner && first.done) {
    const crew = planeCrew(first);
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      (first.launched ? ' — away'
        : crew >= BUSHPLANE_CREW ? ' — fuelled and loaded, pick a drop zone'
        : ` — crew ${crew}/${BUSHPLANE_CREW} (walk Homestead Marksmen aboard)`);
    if (!first.launched && crew >= BUSHPLANE_CREW) {
      const btn = document.createElement('button');
      const aiming = dropTargeting === first.id;
      btn.textContent = aiming ? 'Cancel (Esc)' : 'Launch';
      btn.title = aiming ? 'Stop targeting — the plane stays on the strip.'
        : 'Scouted ground only. One sortie — the plane and the strip are both consumed. ' +
          'The three Marksmen come off as Ex-Special Forces with demolition charges.';
      btn.onclick = () => { dropTargeting = aiming ? null : first.id; sfx('click'); refreshPanel(); };
      addAction(btn);
    }
    return;
  }
  // ---------- the Broadcast Station: the vault, and what it can say ----------
  if (bt.proofBank && first.owner === localOwner) {
    const held = Math.round(first.proof || 0), total = Math.round(proofOf(localOwner));
    const n = proofStations(localOwner).length;
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      ` — holding ${held}/${proofCapPer(localOwner)} proof` +
      (n > 1 ? ` (${total} across ${n} stations)` : '') +
      (held ? ' — all of it burns if this falls' : '');
    for (const [key, B] of Object.entries(BROADCASTS)) {
      const why = canBroadcast(localOwner, key);
      const cost = bcastCost(localOwner, key);
      const btn = document.createElement('button');
      const owned = B.kind === 'permanent' && bcastHas(localOwner, key);
      const running = B.kind === 'instant' && bcastActive(localOwner, key);
      btn.textContent = owned ? `✓ ${B.name}`
        : running ? `${B.name} — ${Math.ceil((state.bcastT[localOwner][key] - state.time))}s`
        : `${B.name} — ${cost}`;
      btn.disabled = !!why;
      btn.title = B.desc +
        (B.kind === 'permanent' ? '\nPERMANENT — bought once.' : `\nLasts ${B.dur}s.`) +
        (B.req ? `\nRequires ${facOf(localOwner).buildingNames[B.req] || B.req}` : '') +
        (why === 'req' ? '\n(not unlocked)' : why === 'proof' ? `\n(need ${cost} proof, have ${total})` : '');
      btn.onclick = () => {
        if (canBroadcast(localOwner, key)) return;
        // a zone broadcast picks its spot; everything else fires where it stands
        if (B.kind === 'zone') { bcastTargeting = key; sfx('click'); refreshPanel(); }
        else { cmd('broadcast', { k: key }); sfx('click'); refreshPanel(); }
      };
      addAction(btn);
    }
    return;
  }
  // ---------- a prepper cache in the field ----------
  // Pick what it hands out, then right-click it with militia. The cache holds
  // the decision so the militia do not have to.
  if (bt.cache && first.owner === localOwner) {
    elSelInfo.textContent = `${buildingName(first)} — ${first.kits} kit${first.kits === 1 ? '' : 's'} left` +
      ` — stocked: ${UNIT_TYPES[first.kit || CACHE_LOADOUT[0]].name}` +
      ' — right-click it with militia to draw';
    for (const kit of CACHE_LOADOUT) {
      const on = (first.kit || CACHE_LOADOUT[0]) === kit;
      const btn = document.createElement('button');
      btn.textContent = `${on ? '✓ ' : ''}Stock ${UNIT_TYPES[kit].name}`;
      btn.title = unitBlurb(kit);
      btn.onclick = () => { cmd('cachekit', { b: first.id, k: kit }); sfx('click'); refreshPanel(); };
      addAction(btn);
    }
    return;
  }
  if (bt.slots) {
    // A homestead is not a bunker with people in it — the people ARE the
    // income, so the panel reads out what the yard is currently worth and what
    // turning it out would cost.
    const farm = bt.homestead;
    const hands = farm ? farmhandsIn(first) : 0;
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      ` — garrison ${first.garrison.length}/${slotsOf(first)}` +
      (farm ? ` — ${hands} farming, +${(hands * HOMESTEAD_RATE).toFixed(2)} minerals/sec` +
              (first.garrison.length < slotsOf(first)
                ? ` — next body in ${Math.max(0, Math.ceil(HOMESTEAD_REFILL - (first.refillT || 0)))}s` : '')
            : '') +
      (bt.income ? ` — +${bt.income} minerals / 10s` : '') +
      (bt.airTech ? ' — aircraft +15% dmg, self-repairing' : '');
    if (first.garrison.length) {
      const btn = document.createElement('button');
      btn.textContent = `${farm ? 'Muster' : 'Evacuate'} (${first.garrison.length})`;
      if (farm) {
        btn.title = `Turns the yard out to fight. This farm stops paying its ` +
          `${(hands * HOMESTEAD_RATE).toFixed(2)}/sec until they are back in, and empty slots ` +
          `regrow one body every ${HOMESTEAD_REFILL}s.`;
      }
      btn.onclick = () => cmd('evacuate', { b: [first.id] });
      addAction(btn);
    }
    return;
  }
  // the Institute of Truth: one button per disproof. This is where the flat
  // faction's whole strategic layer lives, so it is the FIRST thing offered on
  // the building rather than buried under repair.
  if (first.type === 'tech' && first.owner === localOwner && isFlat(localOwner) && first.done) {
    const r = state.research[localOwner];
    const done = state.disproof[localOwner] || {};
    const spd = researchSpeed(localOwner);
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      (r ? ` — proving ${DISPROOFS[r.key].name}, ${Math.ceil((r.dur - r.t) / spd)}s left`
         : Object.keys(done).length >= Object.keys(DISPROOFS).length
           ? ' — every last thing disproved'
           : ` — ${Object.keys(done).length}/${Object.keys(DISPROOFS).length} disproved, pick the next`);
    for (const [key, D] of Object.entries(DISPROOFS)) {
      const btn = document.createElement('button');
      if (done[key]) { btn.textContent = `✔ ${D.name}`; btn.disabled = true; btn.title = D.desc + '\nPROVEN.'; }
      else if (r && r.key === key) { btn.textContent = `… ${D.name}`; btn.disabled = true; btn.title = D.desc; }
      else {
        btn.textContent = `${D.name} — $${D.cost}`;
        btn.disabled = !!r || state.minerals[localOwner] < D.cost;
        btn.title = D.desc + `\n\n$${D.cost}, ${D.time}s` +
          (spd > 1 ? ` (x${spd.toFixed(2)} with your Ham Radios → ${Math.ceil(D.time / spd)}s)` : '') +
          (r ? '\nThe Institute can only prove one thing at a time.' : '');
        btn.onclick = () => { cmd('research', { k: key }); refreshPanel(); refreshSidebar(); };
      }
      addAction(btn);
    }
    return;
  }
  // the Mechanicum: one button per rite, then the QUEUE. Clicking a rite
  // sends the nearest idle body of the right tier walking in; bodies that
  // arrive line up and are consecrated one at a time, in arrival order.
  if (first.type === 'mechanicum' && first.owner === localOwner) {
    const line = (first.rites || []).map(id => findEntity(id)).filter(Boolean);
    // the head of the line is the one actually on the slab (it has an `at`)
    const head = line[0];
    const headLeft = head && head.ascension.at !== undefined
      ? Math.max(0, Math.ceil(head.ascension.at - state.time)) : null;
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      ` — relics ${relicCount(localOwner)}` +
      (line.length
        ? ` — SLAB: ${UNIT_TYPES[head.ascension.to].name}` +
          (headLeft === null ? '' : ` ${headLeft}s`) +
          (line.length > 1
            ? `  |  waiting: ${line.slice(1).map(u => UNIT_TYPES[u.ascension.to].name).join(', ')}`
            : '')
        : ' — slab empty');
    for (const [key, A] of Object.entries(ASCEND)) {
      const to = UNIT_TYPES[key], from = UNIT_TYPES[A.from];
      const fee = ascendFee(localOwner, key);
      const btn = document.createElement('button');
      btn.textContent = `${to.name} — $${fee}` + (fee < A.cost ? ' (salvaged)' : '');
      if (relicCount(localOwner) < A.relics) {
        btn.textContent += ` [${relicCount(localOwner)}/${A.relics} relics]`;
        btn.disabled = true;
      } else if (A.req && !hasStruct(localOwner, A.req)) {
        btn.textContent += ` [needs ${facOf(localOwner).buildingNames[A.req] || A.req}]`;
        btn.disabled = true;
      } else {
        btn.title = `Consumes one ${from.name}`;
        // the selection travels WITH the command, as a preference the sim may
        // use; it is never read from inside the tick
        btn.onclick = () => { cmd('rite', { b: first.id, k: key, u: selectedUnitIds() }); refreshPanel(); };
      }
      addAction(btn);
    }
    // one cancel button per queued body, in order: click it and that body
    // walks back out unchanged with its fee refunded
    line.forEach((u, i) => {
      const btn = document.createElement('button');
      const working = i === 0 && u.ascension.at !== undefined;
      btn.textContent = `✕ ${i + 1}. ${UNIT_TYPES[u.ascension.to].name}` +
        (working ? ' (on the slab)' : ' (waiting)');
      btn.title = `Cancel — the ${UNIT_TYPES[u.type].name} walks back out and $${u.ascension.fee || 0} is refunded`;
      btn.onclick = () => { cmd('cancelrite', { u: u.id }); refreshPanel(); };
      addAction(btn);
    });
    return;
  }
  if (bt.superweapon) {
    const need = superChargeOf(first), have = Math.min(need, first.charge || 0);
    const charged = have >= need;
    const isCoup = superKindOf(first) === 'coup';
    const bank = Math.floor(state.loosh[first.owner] || 0);
    let status;
    if (isOffline(first)) status = 'BLACKED OUT';
    else if (!charged) status = `charging ${Math.floor(have)}/${need}s`;
    else if (isCoup && bank < 60) status = `charged — the throne thirsts: needs 60 loosh (have ${bank})`;
    else if (isCoup) { const spend = clamp(bank, 60, 200); status = `READY — will drink ${spend} loosh (coup radius ${120 + (spend - 60)})`; }
    else status = 'READY TO FIRE';
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP — ` + status;
    const ready = superReady(first);
    if (first.owner === localOwner && ready && !isOffline(first)) {
      const btn = document.createElement('button');
      btn.textContent = 'Launch [Q, then click target]';
      btn.onclick = () => { superTargeting = first.id; refreshPanel(); };
      addAction(btn);
    }
    return;
  }
  elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
    (first.queue.length ? ` — training (${first.queue.length} queued)` : '') +
    ((first.type === 'hq' || bstatsOf(first).thief) && usesLeverage(localOwner)
      ? ` — LEVERAGE ${Math.floor(state.leverage[localOwner] || 0)}` : '') +
    (bstatsOf(first).thief ? ` — skimming ${Math.round(bstatsOf(first).thief.r)} around it` : '') +
    (producesUnits(first) ? ' — right-click to set rally point' : '');
  // LEVERAGE: spend it from the seat of the operation OR from any front
  // company — whichever you happen to have clicked. Hiding it on one
  // building meant nobody ever found it.
  // ...but only for the side that has a ledger to spend from. This used to be
  // ungated, so Open the Books and Freeze Assets sat on every faction's HQ,
  // permanently unaffordable, for a currency they could never earn.
  if ((first.type === 'hq' || bstatsOf(first).thief) && first.owner === localOwner &&
      usesLeverage(localOwner) && LEVERAGE_PLAYS) {
    for (const [key, play] of Object.entries(LEVERAGE_PLAYS)) {
      const btn = document.createElement('button');
      btn.textContent = `${play.name} — ${play.cost}`;
      btn.title = play.desc;
      btn.disabled = (state.leverage[localOwner] || 0) < play.cost;
      btn.onclick = () => { leverageTargeting = key; refreshPanel(); };
      addAction(btn);
    }
  }
}

// everything else: a unit, or any multi-entity box-selection
function panelForSelection(addAction) {
  const counts = {};
  for (const s of selection) {
    const nm = s.kind === 'unit' ? UNIT_TYPES[s.type].name : buildingName(s);
    counts[nm] = (counts[nm] || 0) + 1;
  }
  let info = 'Selected: ' + Object.entries(counts).map(([n, c]) => `${c}× ${n}`).join(', ');
  if (selection.length === 1 && selection[0].kind === 'unit') {
    const uu = selection[0], ut = UNIT_TYPES[uu.type];
    info += ` — ${Math.ceil(uu.hp)}/${ut.hp} HP`;
    if (ut.maxAmmo) info += ` — Ammo ${Math.floor(uu.ammo)}/${ut.maxAmmo}${uu.order.type === 'rearm' ? ' (rearming)' : ''}`;
    if (ut.captures) info += ' — right-click an enemy structure to capture it';
    if (ut.repair) info += ' — repairs nearby damaged allies';
    if (ut.detector) info += ' — detector: reveals stealthed & burrowed enemies';
    if (ut.cloakStill) info += uu.cloaked ? ' — cloaked (holding still)' : ' — cloaks when it holds still';
    if (ut.spawns && ut.spawns.type === 'phantom') info += ' — throws off phantom signatures';
    if (ut.brood) info += ut.brood.type === 'phantom' ? ' — shrouded by a bound phantom escort' : ' — leads a bound brood swarm';
    if (ut.plantMine) info += ' — buries free IEDs on its own while standing idle';
    if (ut.cargoCap) info += ` — carrying ${(uu.cargo || []).length}/${ut.cargoCap} (right-click it with infantry to board)`;
  }
  elSelInfo.textContent = info;
  // an unmarked van that can open a shopfront where it stands
  const vans = selection.filter(e => e.kind === 'unit' && e.owner === localOwner && e.hp > 0 &&
    UNIT_TYPES[e.type].establishes);
  if (vans.length) {
    const btn = document.createElement('button');
    btn.textContent = `Establish Front Company (${vans.length})`;
    btn.title = 'Deploys into a disguised building that skims a share of every enemy delivery nearby. Consumed.';
    btn.onclick = () => { cmd('establish', { u: idsOf(vans) }); refreshPanel(); };
    addAction(btn);
  }
  // transports in the selection: one button dumps every rider out
  const trs = selection.filter(s => s.kind === 'unit' && s.owner === localOwner && s.cargo && s.cargo.length);
  if (trs.length) {
    const total = trs.reduce((n, v) => n + v.cargo.length, 0);
    const btn = document.createElement('button');
    btn.textContent = `Unload (${total})`;
    btn.onclick = () => { cmd('unload', { u: idsOf(trs) }); sfx('click'); refreshPanel(); };
    addAction(btn);
  }
  // evacuate any garrisoned civilian structures caught in the selection
  const gbs = selection.filter(s => s.kind === 'building' && s.garrison && s.garrison.length);
  if (gbs.length) {
    const total = gbs.reduce((n, b) => n + b.garrison.length, 0);
    // turning a farm out is MUSTERING, and it deserves its own word and its own
    // warning: those four are the income, and the yard is empty until they walk
    // back or grow back
    const farms = gbs.filter(b => bstatsOf(b).homestead);
    const btn = document.createElement('button');
    btn.textContent = `${farms.length === gbs.length ? 'Muster' : 'Evacuate'} (${total})`;
    if (farms.length) {
      const lost = farms.reduce((n, b) => n + farmhandsIn(b), 0) * HOMESTEAD_RATE;
      btn.title = `Turns the yard out to fight. Costs ${lost.toFixed(2)} minerals/sec until they are back ` +
        `in — a homestead pays only for the militia actually standing in it, and empty slots regrow ` +
        `one every ${HOMESTEAD_REFILL}s.`;
    }
    btn.onclick = () => { cmd('evacuate', { b: idsOf(gbs) }); selection = selection.filter(s => s.kind === 'unit'); refreshPanel(); };
    addAction(btn);
  }
  // ---------- Flat Earth field logistics ----------
  const mine = selection.filter(s => s.kind === 'unit' && s.owner === localOwner && s.hp > 0);
  // Marksmen: bury a cache (ground-targeted), or walk home for more
  const carriers = mine.filter(u => UNIT_TYPES[u.type].caches);
  if (carriers.length) {
    const loaded = carriers.filter(u => u.caches > 0);
    if (loaded.length) {
      const btn = document.createElement('button');
      const held = loaded.reduce((n, u) => n + u.caches, 0);
      // toggles, like structure placement does. Right-click now COMMITS the
      // plant rather than cancelling it, so the button has to be the way out —
      // otherwise the only cancel is an Escape key nobody was told about.
      btn.textContent = cacheTargeting ? 'Cancel (Esc)' : `Bury Cache (${held})`;
      btn.title = cacheTargeting ? 'Stop placing — nothing is spent.'
        : `${CACHE_COST} minerals. Must be planted OUTSIDE your build radius and NEAR AN ENEMY ` +
          `structure. Holds ${CACHE_KITS} kits, then it is gone.`;
      btn.onclick = () => { cacheTargeting = cacheTargeting ? null : idsOf(loaded); sfx('click'); refreshPanel(); };
      addAction(btn);
    }
    const empties = carriers.filter(u => !u.caches);
    if (empties.length) {
      const src = nearest(empties[0], state.buildings, b => b.owner === localOwner && b.hp > 0 && b.done &&
        (bstatsOf(b).homestead || b.type === 'barracks'));
      if (src) {
        const btn = document.createElement('button');
        btn.textContent = `Resupply (${empties.length})`;
        btn.title = `Walk to a homestead or the Recruitment Tent and reload. ${CACHE_RESUPPLY}s.`;
        btn.onclick = () => { cmd('resupply', { u: idsOf(empties), b: src.id }); sfx('click'); refreshPanel(); };
        addAction(btn);
      }
    }
  }
  // militia standing anywhere on the map: send them to the nearest cache and
  // pick what they come back up as
  const grunts = mine.filter(u => u.type === 'militia' && !u.garrisoned);
  if (grunts.length) {
    const cache = nearest(grunts[0], state.buildings, b => b.owner === localOwner && b.hp > 0 && b.kits > 0);
    if (cache) {
      for (const kit of CACHE_LOADOUT) {
        const btn = document.createElement('button');
        btn.textContent = `Draw ${UNIT_TYPES[kit].name} (${grunts.length})`;
        btn.title = `${unitBlurb(kit)}\nSends them to the nearest cache (${cache.kits} kits left). ` +
          `Each conversion spends one militia and one kit.`;
        btn.onclick = () => { cmd('drawkit', { u: idsOf(grunts), b: cache.id, k: kit }); sfx('click'); refreshPanel(); };
        addAction(btn);
      }
    }
  }
  // Bug Out Van: weld a body in, or cut it back out
  const emptyVans = mine.filter(u => UNIT_TYPES[u.type].loader && !(u.cargo || []).length);
  const bodies = mine.filter(u => BUGOUT_KITS[u.type]);
  if (emptyVans.length && bodies.length) {
    const btn = document.createElement('button');
    btn.textContent = `Fit ${BUGOUT_KITS[bodies[0].type].name}`;
    btn.title = 'Welds the selected body into the van. The van becomes that vehicle; ' +
      'unload to get both back. A kitted van cannot carry passengers.';
    btn.onclick = () => { cmd('fitkit', { v: emptyVans[0].id, u: bodies[0].id }); sfx('click'); refreshPanel(); };
    addAction(btn);
  }
  const kitted = mine.filter(u => UNIT_TYPES[u.type].vanKit);
  if (kitted.length) {
    const btn = document.createElement('button');
    btn.textContent = `Strip Kit (${kitted.length})`;
    btn.onclick = () => { cmd('unfitkit', { u: idsOf(kitted) }); sfx('click'); refreshPanel(); };
    addAction(btn);
  }
  // Ferrying now needs asking for, because right-clicking a van FITS a kit.
  // This is the way to haul militia forward to a cache without welding one of
  // them into the bodywork.
  const riders = mine.filter(u => u.type === 'militia' && !u.garrisoned);
  if (emptyVans.length && riders.length) {
    const btn = document.createElement('button');
    btn.textContent = `Load as Passengers (${Math.min(riders.length, UNIT_TYPES.bugoutvan.cargoCap)})`;
    btn.title = 'Rides in the back instead of being welded in. A van carrying passengers has no weapon.';
    btn.onclick = () => { cmd('board', { u: idsOf(riders), v: emptyVans[0].id }); sfx('click'); refreshPanel(); };
    addAction(btn);
  }
  // Journalists: which way they are working, and what they are holding
  const crews = mine.filter(u => UNIT_TYPES[u.type].investigator);
  if (crews.length) {
    const held = Math.round(crews.reduce((n, u) => n + (u.proof || 0), 0));
    const cur = stanceOf(crews[0]);
    const btn = document.createElement('button');
    btn.textContent = cur === 'doorstep' ? 'Stance: Doorstep' : 'Stance: Discreet';
    btn.title = cur === 'doorstep'
      ? `Filming at ${PROOF_FILM_DOORSTEP}/sec and driving suspicion to +${PROOF_SUSP_DOORSTEP}. You will get the story and they will find you.`
      : `Filming at ${PROOF_FILM_DISCREET}/sec at only +${PROOF_SUSP_DISCREET} suspicion. Slow, and you can sit there a long while.`;
    btn.onclick = () => {
      cmd('stance', { u: idsOf(crews), v: cur === 'doorstep' ? 'discreet' : 'doorstep' });
      sfx('click'); refreshPanel();
    };
    addAction(btn);
    if (held > 0) {
      const drop = nearest(crews[0], proofDropoffs(localOwner), () => true);
      const f = document.createElement('button');
      f.textContent = `File Footage (${held})`;
      f.title = drop ? 'Carry it to the nearest Broadcast Station or News Van and bank it.'
                     : 'Nowhere to file it — build a Broadcast Station.';
      f.disabled = !drop;
      f.onclick = () => { cmd('filepiece', { u: idsOf(crews.filter(u => u.proof > 0)), b: drop.id }); sfx('click'); refreshPanel(); };
      addAction(f);
    }
  }
  // Ex-Special Forces: stick a charge on something
  const sappers = mine.filter(u => u.charges > 0);
  if (sappers.length) {
    const btn = document.createElement('button');
    const held = sappers.reduce((n, u) => n + u.charges, 0);
    btn.textContent = demoTargeting ? 'Cancel (Esc)' : `Set Charge (${held})`;
    btn.title = demoTargeting ? 'Stop targeting — no charge is spent.'
      : `${DEMO_DMG} damage to one enemy structure on a ${DEMO_FUSE}s fuse. ` +
        `Setting it takes ${DEMO_PLANT}s and breaks stealth — they can still kill the man and save the building.`;
    btn.onclick = () => { demoTargeting = demoTargeting ? null : idsOf(sappers); sfx('click'); refreshPanel(); };
    addAction(btn);
  }
  // Marksmen + a plane on the strip: walk them aboard
  const plane = state.buildings.find(b => b.owner === localOwner && b.hp > 0 && b.done &&
    bstatsOf(b).bushplane && !b.launched && planeCrew(b) < BUSHPLANE_CREW);
  const crewable = mine.filter(u => u.type === 'homesteader');
  if (plane && crewable.length) {
    const btn = document.createElement('button');
    btn.textContent = `Board Bush Plane (${planeCrew(plane)}/${BUSHPLANE_CREW})`;
    btn.title = 'Marksmen who board come off the other end as Ex-Special Forces. Consumed on boarding.';
    btn.onclick = () => { cmd('boardplane', { u: idsOf(crewable), b: plane.id }); sfx('click'); refreshPanel(); };
    addAction(btn);
  }
  // a fuelled plane in the selection: pick the drop zone
  const ready = selection.filter(s => s.kind === 'building' && s.owner === localOwner && s.hp > 0 &&
    bstatsOf(s).bushplane && !s.launched && planeCrew(s) >= BUSHPLANE_CREW);
  if (ready.length) {
    const btn = document.createElement('button');
    btn.textContent = dropTargeting ? 'Cancel (Esc)' : 'Launch';
    btn.title = dropTargeting ? 'Stop targeting — the plane stays on the strip.'
      : 'Scouted ground only. One sortie — the plane and the strip are both consumed.';
    btn.onclick = () => { dropTargeting = dropTargeting ? null : ready[0].id; sfx('click'); refreshPanel(); };
    addAction(btn);
  }

  // reptilian slaves: cull the selected ones on demand for burst loosh
  const slaves = selection.filter(s => s.kind === 'unit' && s.owner === localOwner && s.hp > 0 && UNIT_TYPES[s.type].looshOnDeath);
  if (slaves.length) {
    const btn = document.createElement('button');
    btn.textContent = `Harvest Loosh (${slaves.length})`;
    btn.onclick = () => {
      cmd('cull', { u: idsOf(slaves) }); // the death sweep books the loosh + auto-replaces
      eva('The pit feeds');
      sfx('click');
      refreshPanel();
    };
    addAction(btn);
    // the work regime: cycle Merciful -> Normal -> Brutal for the whole pit
    const drv = document.createElement('button');
    drv.textContent = `Drive: ${slaveDriveOf(localOwner)}`;
    drv.title = 'Brutal: mine 35% faster, die twice as fast (loosh gushes). ' +
      'Merciful: live 60% longer (cheap, little loosh). Applies to newly bought slaves.';
    drv.onclick = () => {
      const i = SLAVE_DRIVES.indexOf(slaveDriveOf(localOwner));
      cmd('drive', { v: SLAVE_DRIVES[(i + 1) % SLAVE_DRIVES.length] });
      sfx('click');
      refreshPanel();
    };
    addAction(drv);
  }
  if (selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].role === 'combat')) {
    const btn = document.createElement('button');
    btn.textContent = 'Attack-Move [E]';
    btn.onclick = () => { attackMoveArmed = true; refreshPanel(); };
    addAction(btn);
  }
  if (selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].burrow && !s.transit)) {
    const anyUp = selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].burrow && !s.burrowed);
    const btn = document.createElement('button');
    btn.textContent = (anyUp ? 'Burrow' : 'Surface') + ' [X]';
    btn.onclick = burrowCmd;
    addAction(btn);
  }
  if (selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].role === 'scout')) {
    const btn = document.createElement('button');
    btn.textContent = 'Explore [V]';
    btn.onclick = exploreCmd;
    addAction(btn);
  }
}

// a Dig Site: an ancient rune-carved cairn — it must NOT read as a random
// boulder, so the glyphs pulse teal and a slow glimmer rises off the stones
function drawDigSite(s) {
  const px = isoX(s.x, s.y), py = isoY(s.x, s.y);
  ctx.save();
  ctx.translate(px, py);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.ellipse(0, 3, 22, 11, 0, 0, Math.PI * 2); ctx.fill();
  // disturbed earth ring around the stones
  ctx.fillStyle = 'rgba(90,78,58,0.55)';
  ctx.beginPath(); ctx.ellipse(0, 1.5, 21, 10, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#6f6a5e';
  ctx.beginPath(); ctx.ellipse(0, 0, 16, 8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#57534a';
  ctx.beginPath(); ctx.ellipse(0, -1, 10, 5, 0, 0, Math.PI * 2); ctx.fill();
  // the standing stone: an off-center menhir so the site has a skyline
  ctx.fillStyle = '#615c50';
  ctx.beginPath();
  ctx.moveTo(-9, 1); ctx.lineTo(-7.4, -12); ctx.lineTo(-4.2, -13); ctx.lineTo(-2.6, 0);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#3a372f'; ctx.lineWidth = 0.8; ctx.stroke();
  const dug = s.progress >= DIG_TIME;
  const pulse = 0.45 + 0.4 * Math.sin(state.time * 2.6 + s.id);
  if (dug) {
    const g = 0.55 + 0.35 * Math.sin(state.time * 3);
    ctx.fillStyle = `rgba(125,255,214,${g.toFixed(2)})`;
    ctx.beginPath(); ctx.arc(2, -4, 4.5, 0, Math.PI * 2); ctx.fill();
  } else {
    // carved glyphs, breathing teal — the unmistakable "dig here"
    ctx.fillStyle = `rgba(125,255,214,${pulse.toFixed(2)})`;
    ctx.fillRect(-6.6, -9.6, 1.4, 3.4);
    ctx.fillRect(-4.4, -7.4, 1.2, 2.2);
    ctx.fillRect(3, -3.4, 3.6, 1.2);
    ctx.fillRect(6.2, -1.4, 2.4, 1);
    // a mote of vril light drifting up off the stones
    const rise = (state.time * 0.5 + s.id * 0.37) % 1;
    ctx.fillStyle = `rgba(125,255,214,${(0.7 * (1 - rise)).toFixed(2)})`;
    ctx.beginPath(); ctx.arc(-5.6 + Math.sin(state.time + s.id) * 2, -14 - rise * 14, 1.3, 0, Math.PI * 2); ctx.fill();
  }
  if (s.progress > 0 && !dug) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(-14, -20, 28, 4);
    ctx.fillStyle = '#7dffd6'; ctx.fillRect(-13, -19, 26 * (s.progress / DIG_TIME), 2);
  }
  // a finished dig names the prize
  if (dug) {
    ctx.font = '9px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(200,255,235,0.85)';
    ctx.fillText(RELIC_DEFS[s.relic].name, 0, -24);
  }
  ctx.restore();
}
// a fallen suit of Guard/Dreadnought armor, fading as it rots
function drawArmorWreck(w) {
  const px = isoX(w.x, w.y), py = isoY(w.x, w.y);
  const sc = w.tier === 'dread' ? 1.5 : 1;
  ctx.save();
  ctx.translate(px, py);
  ctx.globalAlpha = Math.min(1, (w.until - state.time) / 10);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath(); ctx.ellipse(0, 2, 9 * sc, 4.5 * sc, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#8a7a52';
  ctx.beginPath(); ctx.ellipse(-2 * sc, -2, 6 * sc, 4 * sc, 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#6d6041';
  ctx.beginPath(); ctx.ellipse(3 * sc, 0, 4 * sc, 3 * sc, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(125,255,214,0.7)';
  ctx.fillRect(-1, -6 * sc, 2, 2); // the lantern still glows
  ctx.restore();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!started) return;
  // void beyond the ground diamond reads as unexplored blackness
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);
  // ground is prerendered already-projected; blit ONLY the visible slice
  // (scaling the whole multi-thousand-pixel canvas each frame is slow)
  {
    const gsc = groundCanvas.width / isoSpanW();
    const vw = canvas.width / cam.zoom, vh = canvas.height / cam.zoom;
    let gx0 = (cam.x + WORLD_H) * gsc, gy0 = cam.y * gsc;
    let gw = vw * gsc, gh = vh * gsc;
    let dx0 = cam.x, dy0 = cam.y;
    // clamp the source rect to the canvas (out-of-range sources glitch)
    if (gx0 < 0) { dx0 -= gx0 / gsc; gw += gx0; gx0 = 0; }
    if (gy0 < 0) { dy0 -= gy0 / gsc; gh += gy0; gy0 = 0; }
    gw = Math.min(gw, groundCanvas.width - gx0);
    gh = Math.min(gh, groundCanvas.height - gy0);
    if (gw > 0 && gh > 0) {
      ctx.drawImage(groundCanvas, gx0, gy0, gw, gh, dx0, dy0, gw / gsc, gh / gsc);
    }
  }

  frameNo++;
  if (frameNo % 600 === 0) purgeSpriteCache();

  // area-effect zones first — ground decals that everything stands on
  drawZones();
  drawAuraRings();

  // view bounds in iso space — everything off-screen skips the draw pass
  const cx0 = cam.x - 60, cx1 = cam.x + canvas.width / cam.zoom + 60;
  const cy0 = cam.y - 90, cy1 = cam.y + canvas.height / cam.zoom + 60;
  const inView = (x, y, m) => {
    const px = isoX(x, y), py = isoY(x, y);
    return px >= cx0 - m && px <= cx1 + m && py >= cy0 - m && py <= cy1 + m;
  };

  // painter's algorithm: patches, buildings, ground units and landed
  // aircraft in one pass, sorted by world x+y (screen depth)
  drawList.length = 0;
  for (const p of state.patches) {
    if (p.amount > 0 && tileState(p.x, p.y) !== 0 && inView(p.x, p.y, 40)) {
      drawList.push({ d: p.x + p.y - 30, k: 0, e: p });
    }
  }
  // dig sites and armor wrecks are ground furniture; sites ignore the fog —
  // every faction knows where the legends are buried
  for (const s of state.digSites) {
    if (!s.taken && inView(s.x, s.y, 40)) drawList.push({ d: s.x + s.y - 28, k: 4, e: s });
  }
  for (const w of state.armorWrecks) {
    if (tileState(w.x, w.y) !== 0 && inView(w.x, w.y, 30)) drawList.push({ d: w.x + w.y - 10, k: 5, e: w });
  }
  // buildings you are actually looking at, drawn live...
  for (const b of state.buildings) {
    if (b.hp > 0 && observingPlayer(b) && inView(b.x, b.y, (b.w + b.h) / 2 + 60)) {
      drawList.push({ d: b.x + b.y, k: 1, e: b });
    }
  }
  // ...and the rest of what you know about, drawn as you last saw it. A ghost
  // only exists for a building nobody on this screen is watching, so these two
  // loops can never both produce the same structure.
  for (const g of localGhosts().values()) {
    if (inView(g.x, g.y, (g.w + g.h) / 2 + 60)) drawList.push({ d: g.x + g.y, k: 1, e: g });
  }
  for (const u of state.units) {
    if (u.hp <= 0 || u.garrisoned || !visibleToPlayer(u)) continue;
    if (UNIT_TYPES[u.type].flying && !u.landed) continue; // airborne drawn above
    if (!inView(u.x, u.y, 70)) continue;
    let d = u.x + u.y;
    // a craft parked ON its pad must paint after the pad building, or the
    // north parking slots vanish under the airfield graphic
    if (u.landed && u.homeId) {
      const hb = state.buildings.find(b => b.id === u.homeId);
      if (hb) d = Math.max(d, hb.x + hb.y + 1);
    }
    drawList.push({ d, k: 2, e: u });
  }
  drawList.sort((a, b) => a.d - b.d || a.k - b.k);
  // sprites blit crisp & fast without resampling (retro-appropriate)
  ctx.imageSmoothingEnabled = false;
  for (const it of drawList) {
    if (it.k === 0) drawPatchIso(it.e);
    else if (it.k === 4) drawDigSite(it.e);
    else if (it.k === 5) drawArmorWreck(it.e);
    else if (it.k === 1) {
      // memory reads as memory: a remembered structure is drawn a shade thinner
      // than one you have eyes on, so a stale base never passes for live intel
      if (it.e.ghost) { ctx.save(); ctx.globalAlpha = 0.7; drawBuildingIso(it.e); ctx.restore(); }
      else drawBuildingIso(it.e);
    }
    else drawUnitIso(it.e);
  }

  drawProjectilesIso();

  // airborne units above the ground layer, depth-sorted among themselves
  drawList.length = 0;
  for (const u of state.units) {
    if (u.hp > 0 && !u.garrisoned && visibleToPlayer(u) && UNIT_TYPES[u.type].flying && !u.landed &&
        inView(u.x, u.y, 90)) {
      drawList.push({ d: u.x + u.y, k: 2, e: u });
    }
  }
  drawList.sort((a, b) => a.d - b.d);
  for (const it of drawList) drawUnitIso(it.e);

  drawBeamsIso();
  Particles.draw(ctx);
  drawOverlays();
  ctx.restore();
  // the radar repaints everything; 20Hz is plenty for blips
  if (frameNo % 3 === 0) drawMinimap();
}

const drawList = []; // reused every frame (GC)

// ---------- sprite cache ----------
// Vector art is expensive (gradients + dozens of path ops per entity per
// frame). Render each entity's sprite to an offscreen canvas and blit it,
// re-rendering only every `interval` frames (staggered animation clock) or
// when its look signature changes (facing bucket, power, team color...).
const spriteCache = new Map(); // key -> {cv, g, stamp, sig, used}
let frameNo = 0;

function cachedSprite(key, w, h, ax, ay, sig, interval, render) {
  let e = spriteCache.get(key);
  if (!e || e.cv.width !== w || e.cv.height !== h) {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    e = { cv, g: cv.getContext('2d'), stamp: -1e9, sig: null, used: 0 };
    spriteCache.set(key, e);
  }
  e.used = frameNo;
  if (e.sig !== sig || frameNo - e.stamp >= interval) {
    e.sig = sig;
    e.stamp = frameNo;
    e.g.clearRect(0, 0, w, h);
    e.g.save();
    e.g.translate(ax, ay);
    render(e.g);
    e.g.restore();
  }
  return e;
}

function purgeSpriteCache() {
  for (const [key, e] of spriteCache) {
    if (frameNo - e.used > 900) spriteCache.delete(key);
  }
}

// ---------- terrain props: upright trees and boulders ----------
// Purely visual — collision stays the TERRAIN blob circle. Generated once
// per map with the same deterministic jitter the old baked art used, and
// drawn through the depth sort so units walk in front of and behind them.
let terrainProps = [];
function buildTerrainProps() {
  terrainProps = [];
  for (const o of TERRAIN) {
    if (o.type === 'forest') {
      const n = Math.max(6, Math.round(o.r * o.r / 260));
      for (let i = 0; i < n; i++) {
        const a = prand(o.seed + i * 17) * Math.PI * 2;
        const rd = Math.sqrt(prand(o.seed + i * 17 + 1)) * o.r * 0.82;
        terrainProps.push({
          kind: 'tree', x: o.x + Math.cos(a) * rd, y: o.y + Math.sin(a) * rd,
          s: 5 + prand(o.seed + i * 17 + 2) * 5, v: i % 3,
        });
      }
    } else if (o.type === 'rock') {
      const n = Math.max(2, Math.round(o.r / 20));
      for (let i = 0; i < n; i++) {
        const a = prand(o.seed + i * 11) * Math.PI * 2;
        const rd = prand(o.seed + i * 11 + 1) * o.r * 0.55;
        terrainProps.push({
          kind: 'rock', x: o.x + Math.cos(a) * rd, y: o.y + Math.sin(a) * rd,
          s: 4.5 + prand(o.seed + i * 11 + 2) * 6.5 + o.r * 0.05, v: i % 2,
        });
      }
    }
  }
}

// static prop painter (baked into the ground image at map generation)
function renderProp(ctx, kind, s, v) {
  const ix = 0, iy = 0;
  const p = { v };
  if (kind === 'tree') {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(ix + 2.5, iy + 1, s * 1.15, s * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    if (p.v === 2) {
      // conifer: trunk under stacked fronds
      ctx.fillStyle = '#4a3826';
      ctx.fillRect(ix - 1, iy - s * 0.8, 2, s * 0.8);
      for (let i = 0; i < 3; i++) {
        const w2 = s * (1.15 - i * 0.28), yy = iy - s * (0.7 + i * 0.75);
        ctx.fillStyle = i % 2 ? '#2f4d26' : '#3c5c2e';
        ctx.beginPath();
        ctx.moveTo(ix - w2, yy);
        ctx.lineTo(ix, yy - s * 1.1);
        ctx.lineTo(ix + w2, yy);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      // broadleaf: trunk under a clumped canopy, lit from the NE
      ctx.fillStyle = '#4a3826';
      ctx.fillRect(ix - 1.2, iy - s * 1.1, 2.4, s * 1.1);
      ctx.fillStyle = p.v ? '#2f4d26' : '#3c5c2e';
      ctx.beginPath();
      ctx.arc(ix, iy - s * 1.7, s, 0, Math.PI * 2);
      ctx.arc(ix - s * 0.55, iy - s * 1.35, s * 0.72, 0, Math.PI * 2);
      ctx.arc(ix + s * 0.55, iy - s * 1.4, s * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.v ? '#46683a' : '#557a42';
      ctx.beginPath();
      ctx.arc(ix + s * 0.3, iy - s * 1.95, s * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // boulder: faceted lump, lit from the NE
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(ix + 2, iy + 1, s * 1.1, s * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.v ? '#4a5058' : '#565d67';
    ctx.beginPath();
    ctx.moveTo(ix - s, iy);
    ctx.lineTo(ix - s * 0.55, iy - s * 0.85);
    ctx.lineTo(ix + s * 0.35, iy - s);
    ctx.lineTo(ix + s, iy - s * 0.25);
    ctx.lineTo(ix + s * 0.7, iy + s * 0.28);
    ctx.lineTo(ix - s * 0.6, iy + s * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#2c3036';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.moveTo(ix - s * 0.55, iy - s * 0.85);
    ctx.lineTo(ix + s * 0.35, iy - s);
    ctx.lineTo(ix + s, iy - s * 0.25);
    ctx.lineTo(ix + s * 0.2, iy - s * 0.3);
    ctx.closePath();
    ctx.fill();
  }
}

// mineral patches: ground stain + a cluster of upright crystal shards. Country
// ore is teal crystal; urban ore (found in city lots) is amber, richer per haul.
function drawPatchIso(p) {
  const ix = isoX(p.x, p.y), iy = isoY(p.x, p.y);
  const s = 10 + 8 * Math.min(1, p.amount / 900);
  const rich = p.rich;
  const crys = rich ? '#e6a63a' : '#3fd7d0';
  const edge = rich ? '#96631d' : '#1a8a85';
  const lit = rich ? 'rgba(255,236,182,0.55)' : 'rgba(220,255,252,0.5)';
  ctx.fillStyle = rich ? 'rgba(150,108,36,0.42)' : 'rgba(31,106,102,0.45)';
  ctx.beginPath();
  ctx.ellipse(ix, iy, s * 1.7, s * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 3; i++) {
    const a = p.id * 2.1 + i * 2.4;
    const ox = Math.cos(a) * s * 0.7, oy = Math.sin(a) * s * 0.35;
    const h = s * (0.75 + 0.2 * ((p.id + i) % 3));
    ctx.fillStyle = crys;
    ctx.beginPath();
    ctx.moveTo(ix + ox, iy + oy - h);
    ctx.lineTo(ix + ox + h * 0.38, iy + oy);
    ctx.lineTo(ix + ox, iy + oy + h * 0.3);
    ctx.lineTo(ix + ox - h * 0.38, iy + oy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = lit; // lit NE facet
    ctx.beginPath();
    ctx.moveTo(ix + ox, iy + oy - h);
    ctx.lineTo(ix + ox + h * 0.38, iy + oy);
    ctx.lineTo(ix + ox, iy + oy - h * 0.25);
    ctx.closePath();
    ctx.fill();
  }
}

// outline of a building's world footprint, projected (a ground diamond)
function strokeFootprint(b, margin) {
  const ew = (b.w + margin) / 2, eh = (b.h + margin) / 2;
  const ix = isoX(b.x, b.y), iy = isoY(b.x, b.y);
  ctx.beginPath();
  [[-ew, -eh], [ew, -eh], [ew, eh], [-ew, eh]].forEach(([dx, dy], i) => {
    if (i) ctx.lineTo(ix + dx - dy, iy + (dx + dy) / 2);
    else ctx.moveTo(ix + dx - dy, iy + (dx + dy) / 2);
  });
  ctx.closePath();
  ctx.stroke();
}

function drawBuildingIso(b) {
  const bt = bstatsOf(b);
  // stealthed structures (mines) render ghosted — semi-visible to their
  // owner, and to enemies only once a detector has swept them
  if (bt.stealth) ctx.globalAlpha = b.owner === localOwner ? 0.6 : 0.45;
  const ix = isoX(b.x, b.y), iy = isoY(b.x, b.y);
  const topY = iy - (b.w + b.h) / 4; // screen y of the footprint's north corner
  const on = !powerOf(b.owner).low;
  // building art comes from the sprite cache: refreshed at ~10Hz for its
  // animations, immediately when power/owner/turret-heading change
  const bw2 = b.w + b.h;
  // skyscrapers/mega-towers extrude far above their footprint — give the sprite
  // canvas extra headroom so their crowns aren't clipped off
  const head = bt.tall ? bw2 * 0.85 : 0;
  const cw = Math.ceil(bw2 + 80), chh = Math.ceil(bw2 * 0.5 + 100 + head);
  const ax = cw / 2, ay = Math.ceil(bw2 * 0.25 + 60 + head);
  const qt = b.turret !== undefined ? Math.round(b.turret / 0.2) : -99;
  const conn = (b.type === 'wall' || b.type === 'gate') ? wallConn(b) : 0;
  // superweapon silos animate a launch for ~1.8s after firing
  let superKind = null, fireP = -1;
  if (bstatsOf(b).superweapon) {
    superKind = superKindOf(b);
    if (b.fireT !== undefined) { const e = state.time - b.fireT; if (e >= 0 && e < 1.8) fireP = e / 1.8; }
  }
  // the Flat Earth structures redraw as their CONTENTS change: a homestead
  // shutters up when the yard is mustered out, a cache thins as kits are drawn,
  // and the Bush Plane counts its crew on the apron. All three are baked into
  // the cached sprite, so each has to be part of its signature.
  const sig = b.owner + '|' + (on ? 1 : 0) + '|' + qt + '|' + conn +
    (b.garrison ? '|g' + b.garrison.length : '') +
    (b.kits !== undefined ? '|k' + b.kits + (b.kit || '') : '') +
    (b.proof ? '|p' + Math.floor(b.proof / 25) : '') +
    (b.crew || b.launched ? '|f' + (b.crew || []).length + (b.launched ? '!' : '') : '') +
    (superKind ? '|' + superKind + '|' + (fireP >= 0 ? Math.round(fireP * 14) : 'x') : '');
  const spr = cachedSprite(b.id, cw, chh, ax, ay, sig, 12, g => {
    isoShear(g); // building art draws in its local ground-plane frame
    Art.building(b.type, g, state.time + (b.id % 89) * 0.71, {
      w: b.w, h: b.h, color: COLORS[b.owner], on,
      fam: FAMILY_STYLE[state.factions[b.owner]], faction: state.factions[b.owner], wx: b.x, wy: b.y,
      turret: b.turret, // towers with their own weapon art track their target
      garrison: (b.garrison || []).length, kits: b.kits, proof: b.proof,
      crew: (b.crew || []).length, launched: !!b.launched,
      conn: { e: !!(conn & 1), w: !!(conn & 2), n: !!(conn & 4), s: !!(conn & 8) },
      superKind, fireP,
      skim: state.time - (b.skimT || -9) < 1.2, // front company: a cut just landed
    });
  });
  ctx.drawImage(spr.cv, ix - ax, iy - ay);

  if (bt.dmg && bt.weapon !== 'pulse' && !bt.ownWeaponArt) {
      const on = !powerOf(b.owner).low;
      const ta = b.turret !== undefined ? b.turret : Math.atan2(WORLD_H / 2 - b.y, WORLD_W / 2 - b.x);
      ctx.save();
      // towers with a raised platform carry the turret at its top
      ctx.translate(ix, iy - (Art.turretLift[b.type] || 0));
      // turret ring with its own drop shadow (ground-plane ellipses)
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(1.2, 1.8, 7, 4.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = on ? '#4d5661' : '#474747';
      ctx.beginPath(); ctx.ellipse(0, 0, 7, 4.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.rotate(isoAngle(ta)); // barrel points along the projected heading
      // barrel(s): tapered, outlined, with a lighter muzzle band
      ctx.fillStyle = on ? '#2b3138' : '#525252';
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = 0.8;
      const len = bt.targets === 'air' ? 12 : 14;
      const rails = bt.targets === 'air' ? [-2.2, 2.2] : [0];
      for (const oy of rails) {
        ctx.beginPath();
        ctx.moveTo(2, oy - 1.7); ctx.lineTo(len, oy - 1); ctx.lineTo(len, oy + 1); ctx.lineTo(2, oy + 1.7);
        ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = on ? '#8b939e' : '#666';
        ctx.fillRect(len - 2.4, oy - 1.1, 2.4, 2.2);
        ctx.fillStyle = on ? '#2b3138' : '#525252';
      }
      // domed cap, lit from the top-left
      const dg = ctx.createRadialGradient(-1.8, -1.8, 0.8, 0, 0, 5.4);
      dg.addColorStop(0, on ? '#b3bbc7' : '#8e8e8e');
      dg.addColorStop(1, on ? '#59626e' : '#575757');
      ctx.fillStyle = dg;
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.stroke();
      ctx.restore();
      if (bt.targets === 'air') {
        ctx.strokeStyle = on ? '#fff' : '#666';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ix - 4, topY - 7);
        ctx.lineTo(ix, topY - 12);
        ctx.lineTo(ix + 4, topY - 7);
        ctx.stroke();
      }
    }
    if (selection.includes(b)) {
      ctx.strokeStyle = b.owner === localOwner ? '#7fff9f' : '#ff8f8f';
      ctx.lineWidth = 2;
      strokeFootprint(b, 6);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(buildingName(b), ix, iy + (b.w + b.h) / 4 + 18);
      if (bt.atkRange) {
        // a world-space circle projects to a 2:1 ellipse, radius * sqrt2
        ctx.strokeStyle = 'rgba(127,255,159,0.25)';
        ctx.beginPath();
        ctx.ellipse(ix, iy, bt.atkRange * Math.SQRT2, bt.atkRange * Math.SQRT2 / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (b.rally) {
        const rx = isoX(b.rally.x, b.rally.y), ry = isoY(b.rally.x, b.rally.y);
        ctx.strokeStyle = 'rgba(127,255,159,0.6)';
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(ix, iy);
        ctx.lineTo(rx, ry);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#7fff9f';
        ctx.fillRect(rx - 2, ry - 12, 3, 12);
        ctx.beginPath();
        ctx.moveTo(rx + 1, ry - 12);
        ctx.lineTo(rx + 12, ry - 9);
        ctx.lineTo(rx + 1, ry - 6);
        ctx.closePath(); ctx.fill();
      }
    }
    // occupancy pips for garrisoned structures
    if (b.garrison && b.garrison.length) {
      for (let i = 0; i < b.garrison.length; i++) {
        ctx.fillStyle = COLORS[b.owner];
        ctx.fillRect(ix - b.garrison.length * 4 + i * 8 + 1, topY - 16, 6, 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(ix - b.garrison.length * 4 + i * 8 + 1, topY - 16, 6, 5);
      }
    }
    // bar only when hurt or selected — a skyline of full green bars is noise
    if (b.hp < b.maxHp || selection.includes(b)) {
      drawBar(ix, topY - 8, (b.w + b.h) / 2, b.hp / b.maxHp);
    }
    // under repair: a welding spark wanders the roofline and a wrench sits over
    // the health bar, so you can see which structures are eating your minerals
    // without selecting a thing
    if (b.repairing && state.time - (b.repairT || -9) < 0.5) {
      const wob = state.time * 2.3 + b.id;
      const sx2 = ix + Math.cos(wob) * (b.w + b.h) * 0.16;
      const sy2 = iy - (b.w + b.h) * 0.1 + Math.sin(wob * 1.7) * 5;
      const fl = 0.55 + 0.45 * Math.sin(state.time * 22 + b.id);
      ctx.fillStyle = `rgba(180,255,210,${fl.toFixed(2)})`;
      ctx.beginPath(); ctx.arc(sx2, sy2, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(120,255,180,${(fl * 0.5).toFixed(2)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = wob * 3 + i * 2.1;
        ctx.moveTo(sx2, sy2);
        ctx.lineTo(sx2 + Math.cos(a) * 6, sy2 + Math.sin(a) * 4);
      }
      ctx.stroke();
      ctx.font = '10px monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = '#8dffc0';
      ctx.fillText('⚒', ix + (b.w + b.h) / 4 + 7, topY - 4);
    }

    if (b.queue.length) {
      const bw = (b.w + b.h) / 2, qy = iy + (b.w + b.h) / 4 + 3;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(ix - bw / 2, qy, bw, 5);
      ctx.fillStyle = '#ffd75f';
      ctx.fillRect(ix - bw / 2, qy, bw * clamp(b.queue[0].t / b.queue[0].duration, 0, 1), 5);
    }

    // vril work meter: the body on the Mechanicum slab — teal bar in the
    // production-bar slot. Only the head of the queue has an `at`; the ones
    // waiting behind it show as pips under the bar instead (see below).
    let vfrac = -1, waiting = 0;
    for (const u of state.units) {
      if (u.hp <= 0 || !u.ascension || u.ascension.bld !== b.id) continue;
      if (u.ascension.at === undefined) { waiting++; continue; }
      vfrac = Math.max(vfrac, 1 - (u.ascension.at - state.time) / ASCEND[u.ascension.to].time);
    }
    if (vfrac >= 0 || waiting) {
      const bw = (b.w + b.h) / 2, qy = iy + (b.w + b.h) / 4 + 3 + (b.queue.length ? 7 : 0);
      // the bar is the body ON the slab; one pip per body still in line behind
      // it, sharing the same row so the queue reads from the map without
      // selecting the building (and without colliding with its name label)
      const pips = Math.min(waiting, 5);
      const pipW = pips ? pips * 5 : 0;
      const barW = bw - pipW;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(ix - bw / 2, qy, bw, 5);
      ctx.fillStyle = '#7dffd6';
      ctx.fillRect(ix - bw / 2, qy, barW * clamp(Math.max(vfrac, 0), 0, 1), 5);
      for (let i = 0; i < pips; i++) {
        ctx.fillRect(ix - bw / 2 + barW + i * 5 + 1, qy + 1, 3, 3);
      }
    }

    // superweapon status, always visible on the silo so you never have to
    // select it to know: a charge bar + seconds-left countdown, becoming a
    // pulsing READY beacon when it can fire (enemy silos only while scouted)
    if (bt.superweapon && b.done && (b.owner === localOwner || tileState(b.x, b.y) === 2)) {
      const need = superChargeOf(b), have = Math.min(need, b.charge || 0);
      const ready = have >= need, off = isOffline(b);
      const bw = (b.w + b.h) / 2, qy = iy + (b.w + b.h) / 4 + 3;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(ix - bw / 2, qy + 7, bw, 5);
      ctx.fillStyle = off ? '#6a6a6a' : ready ? '#5fce5f' : (b.owner === localOwner ? '#4da3ff' : '#ff8f5f');
      ctx.fillRect(ix - bw / 2, qy + 7, bw * clamp(have / need, 0, 1), 5);
      const pulse = 0.5 + 0.5 * Math.sin(state.time * 4);
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      if (off) {
        ctx.fillStyle = '#8ab4ff';
        ctx.fillText('EMP — OFFLINE', ix, topY - 18);
      } else if (ready) {
        ctx.strokeStyle = b.owner === localOwner ? `rgba(120,255,150,${0.35 + pulse * 0.45})` : `rgba(255,120,120,${0.35 + pulse * 0.45})`;
        ctx.lineWidth = 2 + pulse * 2.5;
        ctx.beginPath();
        ctx.ellipse(ix, iy, b.w * 0.95, b.w * 0.48, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = b.owner === localOwner ? `rgba(150,255,170,${0.65 + pulse * 0.35})` : `rgba(255,150,150,${0.65 + pulse * 0.35})`;
        ctx.fillText(b.owner === localOwner ? '⚠ READY TO FIRE' : '⚠ ENEMY SUPERWEAPON', ix, topY - 18);
      } else {
        ctx.fillStyle = 'rgba(220,230,240,0.9)';
        ctx.fillText(Math.ceil(need - have) + 's', ix, topY - 18);
      }
    }
    ctx.globalAlpha = 1;
}

// screen-space flight altitude for a unit (0 when grounded or not airborne).
// Aircraft ride their own band: helicopters/blimps/drones stay low at FLY_H,
// while jets, bombers and capital craft carry a higher t.flyH.
function unitAlt(u) {
  const t = UNIT_TYPES[u.type];
  if (!t.flying) return 0;
  // eased altitude (set in updateUnit) so takeoff/landing ramp smoothly and
  // weapon/particle origins track the climb; fall back to the instant ceiling
  if (u.alt !== undefined) return u.alt;
  return u.landed ? 0 : (t.flyH || FLY_H);
}

function drawUnitIso(u) {
  const t = UNIT_TYPES[u.type];
  // reptilian skin suit: enemy infantry render in YOUR color until they attack
  const drawCol = (u.disguised && u.owner !== localOwner) ? COLORS[localOwner] : COLORS[u.owner];
  const grounded = !!u.landed; // rearming on the pad
  // rotorcraft and balloons bob on the spot; fixed-wing craft hold trim;
  // anti-grav ground craft (Grey hover units) drift on a gentle cushion
  const bob = (t.flying && !grounded && !t.plane) ? Math.sin(state.time * 2.4 + u.id) * 2.5
    : (t.hover ? Math.sin(state.time * 2 + u.id) * 1.5 : 0);
  // rendered radius: sprites draw a touch larger than their collision size;
  // heavies (AC-130, Mothership, Leveler) scale up further via t.drawScale
  const dscale = UNIT_DRAW_SCALE * (t.drawScale || 1);
  const rs = t.r * dscale;
  const ix = isoX(u.x, u.y), iy = isoY(u.x, u.y);
  // airborne craft ride a purely-visual screen altitude; sy anchors the sprite
  const alt = unitAlt(u);
  const airborne = alt > 0.5;
  const sy = iy - alt;
  // your own gaslight phantoms look ghostly to you; enemy ones look real
  if (u.type === 'phantom' && u.owner === localOwner) ctx.globalAlpha = 0.4;
  // cloaked/burrowed units draw ghosted: to their owner as a reminder, to
  // the enemy only while a detector pins them (visibleToPlayer gates that)
  if (isCloaked(u)) ctx.globalAlpha = u.owner === localOwner ? 0.55 : 0.45;
  if (airborne) {
    // shadow stays on the ground and SLIDES OUT from under the craft as it
    // climbs (sun from the upper-left): a low drone hugs its shadow, a high
    // a high bomber throws one well down-right — a strong altitude read
    const sh = clamp(alt / 90, 0, 1);
    const ssc = 1 + sh * 0.5;
    ctx.fillStyle = `rgba(0,0,0,${0.34 - sh * 0.15})`;
    ctx.beginPath();
    ctx.ellipse(ix + 4 + alt * 0.18, iy + 2 + alt * 0.09, rs * 0.9 * ssc, rs * 0.45 * ssc, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // body sprite from a SHARED cache: keyed by type + color + 32-facing
  // bucket + gait pose + state flags + a coarse ambient-time bucket, so an
  // army marching one way reuses a handful of sprites instead of each unit
  // repainting its own vector art
  const moving = u.order.type !== 'idle';
  // firingT: a volley shot just left the barrel (updateVolley) — the barrage
  // has its own clock, so it can't be read off the melee cooldown
  const firing = u.cooldown > t.cooldown - 0.15 || state.time - (u.firingT || -9) < 0.15;
  // attack phase: 1.0 at the instant of the strike, easing to 0 over ~0.34s.
  // Quantized into the sprite key (5 buckets) so a swing reads as a short
  // flip-book — wind-out on the hit, recover — instead of a static pose.
  const sinceShot = (t.cooldown || 1) - (u.cooldown || 0);
  const atkPhase = sinceShot < 0.34 ? 1 - sinceShot / 0.34 : 0;
  const atkB = Math.round(atkPhase * 2) & 7;
  const melee = t.dmg > 0 && t.atkRange > 0 && t.atkRange <= 45;
  // only units whose art actually poses off the strike need atk-phase sprite
  // variants; ranged troopers pose off `firing` alone, so keep their key flat
  const animAtk = melee || u.type === 'draco';
  const qf = Math.round((u.facing || 0) / (Math.PI / 16)) & 31;
  // gait: 8 buckets. Finer resolution balloons the sprite cache (32 facings ×
  // gait × flags per type) and tanks wide-zoom FPS; creatures read fine at 8
  // once their undulation coefficients are tuned for it.
  const gait = Math.floor((u.travel || 0) / 7) & 7;
  // claw strike: 3-bucket flip-book driven by the last close-quarters hit
  const clawB = u.clawT ? Math.round(Math.max(0, 1 - (state.time - u.clawT) / 0.45) * 2) : 0;
  const key = u.type + '|' + drawCol + '|' + qf + '|' + gait + '|' + (animAtk ? atkB : 0) + '|c' + clawB + '|' +
    ((moving ? 1 : 0) | (firing ? 2 : 0) | (u.carrying > 0 ? 4 : 0) | (grounded ? 8 : 0) | (airborne ? 16 : 0) | (melee ? 32 : 0) |
     (u.deployed ? 64 : 0) | (u.digging ? 128 : 0));
  const qFacing = qf * (Math.PI / 16); // render the bucket's representative pose
  const cw = Math.ceil(rs * 3.4 + 26), chh = Math.ceil(rs * 4 + 30);
  const ax = cw / 2, ay = Math.ceil(rs * 2.8 + 16);
  // interval 48: idle/ambient animations repaint in place at ~1.25Hz. Higher
  // than 32 to cut per-frame vector re-bakes at wide zoom (big armies); the
  // walk cycle is gait-keyed, not interval-driven, so motion is unaffected.
  const spr = cachedSprite(key, cw, chh, ax, ay, 'u', 48, g => {
    g.scale(dscale, dscale);
    if (!airborne) Art.shadow(g, t.r * 1.15, t.r * 0.6, 0, 1.5); // contact shadow
    g.save();
    g.scale(1, 0.5); // squash the glow into a ground pool
    Art.teamGlow(g, t.r + 8, drawCol);
    g.restore();
    if (Art.hasIso(u.type)) {
      // dedicated iso sprite: an upright billboard that handles its own
      // heading (mirroring, rotating decks and barrels internally)
      Art.drawIso(u.type, g, state.time, {
        color: drawCol,
        moving,
        firing,
        dist: gait * 7 + 3,
        atk: animAtk ? atkB / 2 : 0,
        melee,
        carrying: u.carrying > 0,
        deployed: !!u.deployed,
        digging: !!u.digging,
        claw: clawB / 2,
        facing: qFacing,
        hdg: isoAngle(qFacing),
      });
    } else {
      // aircraft keep their top-down art, rotated to the projected heading.
      // Rotate by isoAngle (NOT a post-rotation squash) so the nose points
      // exactly along the craft's screen travel — a vertical foreshorten here
      // would skew the heading and make planes look like they fly sideways.
      g.rotate(isoAngle(qFacing));
      Art.draw(u.type, g, state.time, {
        color: drawCol,
        moving,
        firing,
        dist: gait * 7 + 3,
        atk: animAtk ? atkB / 2 : 0,
      });
    }
  });
  // petrified victims render as stone statues
  if (u.petrifiedUntil > state.time) ctx.filter = 'grayscale(1) brightness(0.8)';
  // freshly-built units materialize: a quick scale-up + fade at the door
  const birth = u.bornT ? clamp((state.time - u.bornT) / 0.35, 0, 1) : 1;
  if (birth < 1) {
    const bs = 0.5 + 0.5 * birth, cyp = sy + bob;
    ctx.save();
    ctx.globalAlpha *= 0.4 + 0.6 * birth;
    ctx.translate(ix, cyp); ctx.scale(bs, bs); ctx.translate(-ix, -cyp);
    ctx.drawImage(spr.cv, ix - ax, cyp - ay);
    ctx.restore();
  } else {
    // bank: shear the sprite about its anchor so it tips into turns (airborne
    // only; saucers/blimps get a tiny bank via their smaller u.roll)
    const roll = airborne ? (u.roll || 0) : 0;
    if (roll) {
      const cy = sy + bob;
      ctx.save();
      ctx.translate(ix, cy); ctx.transform(1, 0, -roll * 0.7, 1, 0, 0); ctx.translate(-ix, -cy);
      ctx.drawImage(spr.cv, ix - ax, cy - ay);
      ctx.restore();
    } else {
      ctx.drawImage(spr.cv, ix - ax, sy + bob - ay);
    }
  }
  ctx.filter = 'none';
  // live turret: rendered over the cached hull so the gun tracks its target
  // independently of the chassis heading (cloaked/burrowed units stay bare)
  if (Art.hasIsoTurret(u.type) && !isCloaked(u) && !u.burrowed) {
    ctx.save();
    ctx.translate(ix, sy + bob);
    ctx.scale(dscale, dscale);
    Art.drawIsoTurret(u.type, ctx, state.time, { facing: u.facing || 0, turret: u.turret, firing, cargo: (u.cargo || []).length });
    ctx.restore();
  }
  if (u.carrying > 0) {
    ctx.fillStyle = '#3fd7d0';
    ctx.fillRect(ix - 3, sy - rs - 7, 6, 5);
  }
  if (selection.includes(u)) {
    ctx.strokeStyle = u.owner === localOwner ? '#7fff9f' : '#ff8f8f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(ix, sy, rs + 5, (rs + 5) * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // ASSETS: a violet ring under your sleepers, drawn only for you — to their
  // own owner (and to everyone else) they look like an ordinary loyal unit
  if (u.sleeperFor === localOwner) {
    ctx.strokeStyle = `rgba(201,167,255,${(0.5 + 0.3 * Math.sin(state.time * 3 + u.id)).toFixed(2)})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.ellipse(ix, sy + 2, rs + 4, (rs + 4) * 0.55, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(201,167,255,0.95)';
    ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
    ctx.fillText('\u25C6', ix, sy - rs - 14);
  }
  if (u.hp < u.maxHp) drawBar(ix, sy - rs - 12, rs * 2.4, u.hp / u.maxHp);
  // ---------- suspicion pip (your own infiltrators only) ----------
  // The meter is the whole stealth system and it was invisible: you could not
  // tell a Marksman who had gone quiet from one about to be spotted. Shown only
  // for your own units — reading an enemy's meter would hand you their plan.
  // The dot on the right marks where the meter has to reach before the ground
  // this unit is standing on gives it away, so the bar is answerable: filling
  // past the dot means caught HERE, not caught in the abstract.
  if (u.owner === localOwner && u.suspicion !== undefined && !u.garrisoned) {
    const frac = clamp(u.suspicion / SUSPICION_MAX, 0, 1);
    const w = rs * 2.4, py = sy - rs - (u.hp < u.maxHp ? 17 : 12);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(ix - w / 2, py, w, 3);
    // green while unnoticed, amber as it climbs, red once it is giving you away
    const lit = u.exposedUntil > state.time;
    ctx.fillStyle = lit ? '#ff5f5f' : frac > 0.66 ? '#ffb648' : '#7dffa0';
    ctx.fillRect(ix - w / 2, py, w * frac, 3);
    // the local threshold: how much meter this spot actually tolerates, judged
    // by whichever enemy is watching it hardest
    const scrut = worstScrutinyAt(localOwner, u.x, u.y);
    if (scrut > 0) {
      const at = clamp(SUSPICION_CAUGHT / scrut, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(ix - w / 2 + w * at - 0.5, py - 1, 1.4, 5);
    }
  }
  // tractor-beam capture countdown: a violet bar filling toward abduction —
  // when it fills, the unit is hauled away (that's the "instant" death)
  if (u.beamHoldT && state.time - u.beamHoldT < 0.3 && u.beamHoldFrac > 0.02) {
    const w = rs * 2.4;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(ix - w / 2, sy - rs - 17, w, 3.5);
    ctx.fillStyle = '#c08bff';
    ctx.fillRect(ix - w / 2, sy - rs - 17, w * clamp(u.beamHoldFrac, 0, 1), 3.5);
  }
  if (t.maxAmmo && (u.ammo < t.maxAmmo || selection.includes(u))) {
    const w = rs * 2.2;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(ix - w / 2, sy + rs + 5, w, 3);
    ctx.fillStyle = '#ffd75f';
    ctx.fillRect(ix - w / 2, sy + rs + 5, w * clamp(u.ammo / t.maxAmmo, 0, 1), 3);
  }
  ctx.globalAlpha = 1;
}

// tractor beams: tower -> locked aircraft (projected endpoints)
function drawBeamsIso() {
  for (const b of state.buildings) {
    if (!b.beamId || b.hp <= 0) continue;
    const tgt = state.units.find(un => un.id === b.beamId && un.hp > 0);
    if (!tgt || !visibleToPlayer(tgt)) continue;
    const bx = isoX(b.x, b.y), by = isoY(b.x, b.y) - (Art.turretLift[b.type] || 10);
    const tx = isoX(tgt.x, tgt.y), ty = isoY(tgt.x, tgt.y) - unitAlt(tgt);
    const bg = ctx.createLinearGradient(bx, by, tx, ty);
    bg.addColorStop(0, 'rgba(125,255,214,0.85)');
    bg.addColorStop(1, 'rgba(125,255,214,0.25)');
    ctx.strokeStyle = bg;
    ctx.lineWidth = 2 + Math.sin(state.time * 14) * 0.8;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(tx, ty); ctx.stroke();
    // pull ripples travelling down the beam
    const dx = tx - bx, dy = ty - by;
    for (let i = 0; i < 3; i++) {
      const f = ((state.time * 0.9 + i / 3) % 1);
      ctx.fillStyle = `rgba(200,255,240,${0.7 * (1 - f)})`;
      ctx.beginPath();
      ctx.arc(tx - dx * f, ty - dy * f, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// projectiles in flight (ground shadow on the plane, body lifted by its arc)
function drawProjectilesIso() {
  for (const p of state.projectiles) {
    const px = isoX(p.x, p.y), py = isoY(p.x, p.y);
    if (p.kind === 'missile') {
      // SAMs fly at aircraft altitude; shoulder rockets skim the ground
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(px, py, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.translate(px, py - (p.alt !== undefined ? p.alt + 4 : FLY_H));
      ctx.rotate(isoAngle(p.angle));
      ctx.fillStyle = '#e8edf2';
      ctx.fillRect(-4, -1.4, 8, 2.8);
      ctx.fillStyle = '#8b939e'; // tail fins
      ctx.fillRect(-4.5, -3, 2, 6);
      ctx.fillStyle = '#c0392b'; // warhead
      ctx.beginPath(); ctx.moveTo(4, -1.4); ctx.lineTo(7, 0); ctx.lineTo(4, 1.4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(255,${170 + Math.floor(fxRandom() * 60)},70,0.9)`; // exhaust
      ctx.beginPath(); ctx.moveTo(-4.5, -1.1); ctx.lineTo(-8 - fxRandom() * 3, 0); ctx.lineTo(-4.5, 1.1); ctx.closePath(); ctx.fill();
      ctx.restore();
      continue;
    }
    // shadow on the ground point; the round itself rides its arc height
    const hx = px, hy = py - (p.hgt || 0);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); ctx.ellipse(px, py, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
    if (p.kind === 'superrocket') {
      // a big finned rocket plunging nose-down with a fire plume
      ctx.save();
      ctx.translate(hx, hy);
      ctx.fillStyle = '#d8d2c2';
      ctx.beginPath();
      ctx.moveTo(0, 10); ctx.lineTo(-4, -8); ctx.lineTo(4, -8);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.moveTo(0, 10); ctx.lineTo(-3, 3); ctx.lineTo(3, 3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#8b939e';
      ctx.fillRect(-5, -9, 3, 5); ctx.fillRect(2, -9, 3, 5);
      ctx.fillStyle = `rgba(255,${170 + Math.floor(fxRandom() * 60)},70,0.9)`;
      ctx.beginPath();
      ctx.moveTo(-3, -8); ctx.lineTo(0, -18 - fxRandom() * 8); ctx.lineTo(3, -8);
      ctx.closePath(); ctx.fill();
      ctx.restore();
      continue;
    }
    if (p.kind === 'firework') {
      // a bright bottle-rocket riding its arc, trailing a colored spark
      const c = p.col || [255, 210, 90];
      ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},0.6)`; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(hx - Math.cos(isoAngle(p.angle)) * 7, hy - Math.sin(isoAngle(p.angle)) * 7); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      ctx.beginPath(); ctx.arc(hx, hy, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hx, hy, 1.1, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === 'cruise') {
      // a finned cruise missile, nose along its travel, exhaust behind
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(isoAngle(p.angle));
      ctx.fillStyle = '#d8dce2'; ctx.fillRect(-6, -1.7, 12, 3.4);
      ctx.fillStyle = '#8b939e'; ctx.fillRect(-6.5, -3.4, 2.2, 6.8); // tail fins
      ctx.fillStyle = '#c0392b'; ctx.beginPath(); ctx.moveTo(6, -1.7); ctx.lineTo(10, 0); ctx.lineTo(6, 1.7); ctx.closePath(); ctx.fill(); // warhead
      ctx.fillStyle = `rgba(255,${170 + Math.floor(fxRandom() * 60)},70,0.9)`;
      ctx.beginPath(); ctx.moveTo(-6, -1.3); ctx.lineTo(-11 - fxRandom() * 4, 0); ctx.lineTo(-6, 1.3); ctx.closePath(); ctx.fill();
      ctx.restore();
    } else if (p.kind === 'rock') {
      ctx.fillStyle = '#8a7f6e';
      ctx.beginPath(); ctx.arc(hx, hy, 3.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#5c5347'; ctx.lineWidth = 1; ctx.stroke();
    } else if (p.kind === 'shell') {
      // howitzer round: small, fast, mean
      ctx.fillStyle = '#d8d2c2';
      ctx.beginPath(); ctx.arc(hx, hy, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,190,90,0.7)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - 5, hy + 3); ctx.stroke();
    } else if (p.kind === 'magma') {
      ctx.fillStyle = '#ff8a3c';
      ctx.beginPath(); ctx.arc(hx, hy, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,220,120,0.9)';
      ctx.beginPath(); ctx.arc(hx, hy, 1.6, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === 'plasma') {
      ctx.fillStyle = 'rgba(125,255,214,0.9)';
      ctx.beginPath(); ctx.arc(hx, hy, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8fff8';
      ctx.beginPath(); ctx.arc(hx, hy, 1.4, 0, Math.PI * 2); ctx.fill();
    } else { // bomb
      ctx.fillStyle = '#2b2f36';
      ctx.beginPath(); ctx.ellipse(hx, hy, 2.6, 3.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4a515c';
      ctx.fillRect(hx - 2.4, hy - 5, 4.8, 2);
    }
  }
}

// area-effect zones: the coverage circle is a ground ellipse; the weather
// inside (rain, flames, gas) draws upright in screen space
// ---------- aura rings ----------
// Every aura in the game used to be an invisible circle the player had to
// intuit — the Barrage Balloon was the worst case, because the aura IS the
// unit, but the Prophet, Aerostat, Technician and every captured landmark had
// the same problem. Selecting the thing that owns one now draws it on the
// ground, and flak bubbles are drawn faintly at ALL times (for either side)
// because "where is it unsafe to fly" is information both players need.
const AURA_RINGS = [
  { key: 'mendAura',   col: '140,255,170' },   // friendly: mends
  { key: 'healAura',   col: '140,255,170' },
  { key: 'buffAura',   col: '255,214,120' },   // friendly: hits harder
  { key: 'hardenAura', col: '150,205,255' },   // friendly: takes less
  { key: 'debuffAura', col: '255,140,140' },   // hostile: their aim suffers
  { key: 'aaAura',     col: '125,255,214' },   // hostile: shreds aircraft
  { key: 'convert',    col: '201,167,255' },   // hostile: takes their people
  { key: 'thief',      col: '255,206,120' },   // economic: skims their deliveries
];
const AURA_MAX_R = 600;   // the TV Station converts map-wide; that is not a ring

function auraRing(wx, wy, r, col, alpha, dashed) {
  const rx = r * Math.SQRT2;
  ctx.save();
  ctx.strokeStyle = `rgba(${col},${alpha})`;
  ctx.lineWidth = dashed ? 1 : 1.4;
  if (dashed) ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.ellipse(isoX(wx, wy), isoY(wx, wy), rx, rx / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (!dashed) {
    ctx.fillStyle = `rgba(${col},${(alpha * 0.09).toFixed(3)})`;
    ctx.fill();
  }
  ctx.restore();
}

function drawAuraRings() {
  // standing flak, always shown: static area denial only works as a decision
  // if you can see where it reaches before you fly into it
  for (const u of state.units) {
    if (u.hp <= 0 || u.garrisoned || selection.includes(u)) continue;
    const t = UNIT_TYPES[u.type];
    if (!t.aaAura) continue;
    if (u.owner !== localOwner && (hiddenFrom(u, localOwner) || !visibleToPlayer(u))) continue;
    auraRing(u.x, u.y, t.aaAura.r, '125,255,214', 0.15, true);
  }
  // ...and everything the player has actually selected, in full
  for (const e of selection) {
    if (e.hp <= 0) continue;
    const st = e.kind === 'building' ? bstatsOf(e) : UNIT_TYPES[e.type];
    if (!st) continue;
    for (const a of AURA_RINGS) {
      const def = st[a.key];
      if (!def || !def.r || def.r > AURA_MAX_R) continue;
      auraRing(e.x, e.y, def.r, a.col, 0.5, false);
    }
  }
}

function drawZones() {
  for (const z of state.zones) {
    const kind = z.kind || 'rain';
    const zx = isoX(z.x, z.y), zy = isoY(z.x, z.y);
    const rx = z.r * Math.SQRT2, ry = rx / 2;
    if (kind === 'firmament') {
      // a pane of solid sky: cold glass, a hard rim, and a slow shimmer
      // crawling across it so it reads as a surface rather than a puddle
      const g = ctx.createRadialGradient(zx, zy, 0, zx, zy, rx);
      g.addColorStop(0, 'rgba(169,195,204,0.05)');
      g.addColorStop(0.72, 'rgba(169,195,204,0.14)');
      g.addColorStop(1, 'rgba(210,235,245,0.30)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(220,240,250,0.75)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      // faceting — the dome is a made thing, not weather
      ctx.strokeStyle = 'rgba(210,235,245,0.28)'; ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 6 + state.time * 0.12;
        ctx.beginPath();
        ctx.moveTo(zx + Math.cos(a) * rx, zy + Math.sin(a) * ry);
        ctx.lineTo(zx - Math.cos(a) * rx, zy - Math.sin(a) * ry);
        ctx.stroke();
      }
      const sh = (state.time * 0.4) % 1;
      ctx.strokeStyle = `rgba(255,255,255,${(0.30 * (1 - Math.abs(sh - 0.5) * 2)).toFixed(2)})`;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(zx, zy, rx * sh, ry * sh, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (kind === 'rain' || kind === 'storm') {
      ctx.fillStyle = kind === 'storm' ? 'rgba(60,80,130,0.22)' : 'rgba(80,130,190,0.15)';
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(120,170,230,0.5)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(160,200,245,0.55)'; ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        // streaks fall straight down the screen inside the ellipse
        const sx2 = zx + Math.sin(i * 2.4) * rx * 0.8;
        const sy2 = zy + Math.cos(i * 1.9) * ry * 0.65 + ((state.time * 130 + i * 37) % 44) - 30;
        ctx.beginPath(); ctx.moveTo(sx2, sy2); ctx.lineTo(sx2 - 3, sy2 + 9); ctx.stroke();
      }
    } else if (kind === 'fire') {
      ctx.fillStyle = 'rgba(255,120,40,0.18)';
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 7; i++) {
        const fl = 0.5 + 0.5 * Math.sin(state.time * 9 + i * 2.3);
        const fx = z.x + Math.sin(i * 2.7) * z.r * 0.6, fy = z.y + Math.cos(i * 1.7) * z.r * 0.6;
        ctx.fillStyle = `rgba(255,${140 + Math.floor(fl * 70)},60,${0.35 + fl * 0.45})`;
        ctx.beginPath();
        ctx.arc(isoX(fx, fy), isoY(fx, fy) - fl * 2, 2 + fl * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === 'toxin') {
      ctx.fillStyle = 'rgba(130,200,80,0.16)';
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 5; i++) {
        const gx = z.x + Math.sin(i * 2.1 + state.time * 0.7) * z.r * 0.5;
        const gy = z.y + Math.cos(i * 1.3 + state.time * 0.5) * z.r * 0.5;
        ctx.fillStyle = 'rgba(160,220,110,0.22)';
        ctx.beginPath();
        ctx.arc(isoX(gx, gy), isoY(gx, gy) - i, 5 + i, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === 'emp') {
      // dead blue radius with skittering static
      ctx.fillStyle = 'rgba(90,140,220,0.12)';
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(140,200,255,0.4)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(180,220,255,0.5)'; ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const a = (state.time * 2 + i * 1.3) % (Math.PI * 2);
        const ex2 = z.x + Math.cos(a) * z.r * 0.8, ey2 = z.y + Math.sin(a) * z.r * 0.8;
        ctx.beginPath();
        ctx.moveTo(isoX(z.x, z.y), isoY(z.x, z.y));
        ctx.lineTo(isoX(ex2, ey2), isoY(ex2, ey2));
        ctx.stroke();
      }
    } else if (kind === 'quake') {
      ctx.fillStyle = 'rgba(150,110,60,0.15)';
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(120,90,60,0.5)'; ctx.lineWidth = 2;
      for (let r2 = 0.4; r2 <= 1; r2 += 0.3) {
        ctx.beginPath(); ctx.ellipse(zx, zy, rx * r2, ry * r2, 0, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (kind === 'barrage') {
      ctx.strokeStyle = 'rgba(255,180,90,0.5)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (kind === 'singularity') {
      // gravity well: a dark violet basin with matter spiralling into a bright core
      ctx.fillStyle = 'rgba(40,10,60,0.28)';
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(190,140,255,0.5)'; ctx.lineWidth = 1.2;
      for (let ring = 0.9; ring >= 0.3; ring -= 0.3) {
        ctx.beginPath(); ctx.ellipse(zx, zy, rx * ring, ry * ring, 0, 0, Math.PI * 2); ctx.stroke();
      }
      // infalling streaks, angle advancing over time (matter spiralling inward)
      ctx.strokeStyle = 'rgba(215,180,255,0.6)'; ctx.lineWidth = 1;
      for (let i = 0; i < 10; i++) {
        const a = i * 0.63 + state.time * 3, rr2 = 0.85 - (state.time * 0.9 + i * 0.1) % 0.85;
        const ox = z.x + Math.cos(a) * z.r * rr2, oy = z.y + Math.sin(a) * z.r * rr2;
        const ix2 = z.x + Math.cos(a) * z.r * (rr2 - 0.18), iy2 = z.y + Math.sin(a) * z.r * (rr2 - 0.18);
        ctx.beginPath(); ctx.moveTo(isoX(ox, oy), isoY(ox, oy)); ctx.lineTo(isoX(ix2, iy2), isoY(ix2, iy2)); ctx.stroke();
      }
      const core = 0.6 + 0.4 * Math.sin(state.time * 12);
      ctx.fillStyle = `rgba(235,215,255,${core})`;
      ctx.beginPath(); ctx.ellipse(zx, zy, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
    } else if (kind === 'ray') {
      // the beam column striking down into the zone
      ctx.fillStyle = 'rgba(125,255,214,0.18)';
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      const flick = 0.6 + 0.4 * Math.sin(state.time * 40);
      ctx.strokeStyle = `rgba(200,255,240,${flick})`;
      ctx.lineWidth = 6 + Math.sin(state.time * 30) * 2;
      ctx.beginPath(); ctx.moveTo(zx, zy - 400); ctx.lineTo(zx, zy); ctx.stroke();
      ctx.fillStyle = `rgba(230,255,250,${flick})`;
      ctx.beginPath(); ctx.ellipse(zx, zy, 14, 7, 0, 0, Math.PI * 2); ctx.fill();
    } else if (kind === 'orbital') {
      const flick = 0.6 + 0.4 * Math.sin(state.time * 50);
      ctx.strokeStyle = `rgba(200,230,255,${flick})`;
      ctx.lineWidth = 8;
      ctx.beginPath(); ctx.moveTo(zx, zy - 500); ctx.lineTo(zx, zy); ctx.stroke();
    } else if (kind === 'coup') {
      ctx.fillStyle = 'rgba(160,120,220,0.16)';
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(201,167,255,0.6)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(zx, zy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    }
  }
}

// fog + cursor overlays, drawn while the camera transform is active
function drawOverlays() {
  // fog — raw pixels (black with per-tile alpha), stretched over the world
  // rect through the projection so tiles land as ground diamonds
  const fd = new Uint32Array(fogImg.data.buffer);
  const vis = localVis();
  for (let i = 0; i < vis.length; i++) {
    fd[i] = vis[i] === 2 ? 0 : vis[i] === 1 ? 0x80000000 : 0xF2000000;
  }
  fogCtx.putImageData(fogImg, 0, 0);
  ctx.save();
  isoShear(ctx);
  ctx.drawImage(fogCanvas, 0, 0, FW, FH, 0, 0, WORLD_W, WORLD_H);
  ctx.restore();

  // dig sites punch THROUGH the fog: everyone knows where the legends are
  // buried, scouted or not — a ghost rune floats over unexplored ground
  // (explored tiles already show the full cairn under the fog tint)
  for (const s of state.digSites) {
    if (s.taken || tileState(s.x, s.y) !== 0) continue;
    const px = isoX(s.x, s.y), py = isoY(s.x, s.y);
    if (px < cam.x - 60 || px > cam.x + canvas.width / cam.zoom + 60 ||
        py < cam.y - 60 || py > cam.y + canvas.height / cam.zoom + 60) continue;
    const pulse = 0.35 + 0.3 * Math.sin(state.time * 2.6 + s.id);
    ctx.save();
    ctx.translate(px, py);
    ctx.strokeStyle = `rgba(125,255,214,${pulse.toFixed(2)})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(0, 0, 14, 7, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = `rgba(125,255,214,${(pulse + 0.25).toFixed(2)})`;
    ctx.fillRect(-1.2, -8, 2.4, 4.6);
    ctx.fillRect(-3.8, -5.6, 1.6, 2.2);
    ctx.fillRect(2.2, -5.6, 1.6, 2.2);
    ctx.restore();
  }

  if (mouse.sel) {
    const s = mouse.sel;
    ctx.strokeStyle = '#7fff9f';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  } else {
    // contextual command cursor (attack / repair / capture / garrison / ...)
    const hc = hoverContext(mouse.x, mouse.y);
    if (hc) drawReticle(hc);
  }

  // expanding rings where a minimap order was issued (fade over ~0.6s)
  if (pings.length) {
    for (const p of pings) {
      const age = state.time - p.t;
      if (age > 0.6) continue;
      const f = age / 0.6, rr2 = 6 + f * 34;
      ctx.strokeStyle = `rgba(127,255,159,${1 - f})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(isoX(p.x, p.y), isoY(p.x, p.y), rr2 * Math.SQRT2, rr2 * Math.SQRT2 / 2, 0, 0, Math.PI * 2); ctx.stroke();
    }
    pings = pings.filter(p => state.time - p.t <= 0.6);
  }

  // floating numbers (a front company taking its cut, etc.)
  for (const fl of state.floats) {
    const age = (state.time - fl.t) / 1.6;
    if (!isPlayerVisible(fl.x, fl.y)) continue;
    const fx = isoX(fl.x, fl.y), fy = isoY(fl.x, fl.y) - age * 22;
    ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(0,0,0,${(0.5 * (1 - age)).toFixed(2)})`;
    ctx.fillText(fl.text, fx + 1, fy + 1);
    ctx.fillStyle = `rgba(201,167,255,${(1 - age).toFixed(2)})`;
    ctx.fillText(fl.text, fx, fy);
  }

  // ---------- bush plane drop zone ----------
  // Aiming a drop had NO cursor feedback at all — the only way to learn a spot
  // was unscouted was to click it and be told no. Now the reticle itself
  // answers: green ring where the team can go in, red and struck through where
  // you have never looked, with the landing spread drawn to scale.
  if (dropTargeting) {
    const rx = isoX(mouse.x, mouse.y), ry = isoY(mouse.x, mouse.y);
    const ok = canDropAt(localOwner, mouse.x, mouse.y);
    const col = ok ? 'rgba(127,255,159,0.9)' : 'rgba(255,95,95,0.9)';
    const R = 42;                                   // the spread the team lands in
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(rx, ry, R * Math.SQRT2, R * Math.SQRT2 / 2, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([5, 6]);
    ctx.beginPath(); ctx.ellipse(rx, ry, R * Math.SQRT2 * 1.7, R * Math.SQRT2 * 0.85, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // crosshair, and the three bodies that would come out of it
    ctx.beginPath();
    ctx.moveTo(rx - 18, ry); ctx.lineTo(rx + 18, ry);
    ctx.moveTo(rx, ry - 11); ctx.lineTo(rx, ry + 11);
    ctx.stroke();
    if (ok) {
      ctx.fillStyle = col;
      for (let i = 0; i < BUSHPLANE_CREW; i++) {
        const a = (i / BUSHPLANE_CREW) * Math.PI * 2 + state.time * 0.5;
        ctx.beginPath();
        ctx.ellipse(rx + Math.cos(a) * 34, ry + Math.sin(a) * 17, 2.6, 2.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.beginPath();                               // struck through: no vision here
      ctx.moveTo(rx - 40, ry - 20); ctx.lineTo(rx + 40, ry + 20); ctx.stroke();
      ctx.fillStyle = 'rgba(255,150,150,0.95)';
      ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
      ctx.fillText('NOT SCOUTED', rx, ry - 30);
    }
  }

  // superweapon targeting reticle at the cursor (world-space ground ellipse)
  if (superTargeting) {
    const sw = state.buildings.find(b => b.id === superTargeting);
    const R = { rocket: 110, orbital: 90, quake: 240, emp: 260, barrage: 170, ray: 120, coup: 200 }[sw ? superKindOf(sw) : 'rocket'] || 130;
    const rx = isoX(mouse.x, mouse.y), ry = isoY(mouse.x, mouse.y);
    ctx.strokeStyle = 'rgba(255,95,95,0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(rx, ry, R * Math.SQRT2, R * Math.SQRT2 / 2, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.ellipse(rx, ry, R * Math.SQRT2 * 0.6, R * Math.SQRT2 * 0.3, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(rx - 16, ry); ctx.lineTo(rx + 16, ry);
    ctx.moveTo(rx, ry - 10); ctx.lineTo(rx, ry + 10);
    ctx.stroke();
  }

  // Vril Recall reticle: the actual circle, with the bodies it would take
  // highlighted — the power is a precision pull, so you must be able to see
  // exactly who is inside before you spend the cooldown
  if (abilityTargeting === 'recall') {
    const S = recallDef(localOwner);
    const rx = isoX(mouse.x, mouse.y), ry = isoY(mouse.x, mouse.y);
    const picks = recallTargets(localOwner, mouse.x, mouse.y);
    ctx.strokeStyle = 'rgba(125,255,214,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(rx, ry, S.r * Math.SQRT2, S.r * Math.SQRT2 / 2, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.ellipse(rx, ry, S.r * Math.SQRT2 * 0.55, S.r * Math.SQRT2 * 0.275, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    for (const u of picks) {
      ctx.beginPath();
      ctx.ellipse(isoX(u.x, u.y), isoY(u.x, u.y), 13, 7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.font = 'bold 12px monospace'; ctx.textAlign = 'center';
    ctx.fillStyle = picks.length ? '#7dffd6' : 'rgba(200,220,215,0.7)';
    ctx.fillText(`${picks.length}/${S.max}`, rx, ry - S.r * 0.75 - 6);
  }

  if (plantArmed) {
    const rx = isoX(mouse.x, mouse.y), ry = isoY(mouse.x, mouse.y);
    ctx.strokeStyle = 'rgba(255,180,60,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(rx, ry, 20, 10, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.ellipse(rx, ry, 34, 17, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,190,80,0.95)';
    ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
    ctx.fillText('IED', rx, ry - 13);
  }

  if (placing) {
    ctx.save();
    isoShear(ctx); // ghost + radii are world-space ground markings
    const t = bstats(localOwner, placing);
    const ok = !placementBlocked(localOwner, placing, mouse.x, mouse.y) &&
      (t.anywhere || withinBuildRadius(localOwner, mouse.x, mouse.y));
    ctx.globalAlpha = 0.5;
    if (wallDrag) {
      // ghost the whole stretch of wall segments being dragged out
      const ex = Math.round(mouse.x / WALL_STEP) * WALL_STEP, ey = Math.round(mouse.y / WALL_STEP) * WALL_STEP;
      const dx = ex - wallDrag.x0, dy = ey - wallDrag.y0;
      const n = Math.max(0, Math.round(Math.hypot(dx, dy) / WALL_STEP));
      for (let i = 0; i <= n; i++) {
        const x = wallDrag.x0 + dx * (i / (n || 1)), y = wallDrag.y0 + dy * (i / (n || 1));
        ctx.fillStyle = (!placementBlocked(localOwner, 'wall', x, y) && withinBuildRadius(localOwner, x, y)) ? '#4da3ff' : '#ff5f5f';
        ctx.fillRect(x - t.w / 2, y - t.h / 2, t.w, t.h);
      }
    } else if (placing === 'gate') {
      // highlight the wall segment under the cursor: blue = convertible to a
      // gate (straight run), red = a wall but not a straight segment
      const wallUnder = state.buildings.find(b => b.owner === localOwner && b.type === 'wall' && b.hp > 0 &&
        Math.abs(b.x - mouse.x) <= b.w / 2 + 4 && Math.abs(b.y - mouse.y) <= b.h / 2 + 4);
      if (wallUnder) {
        ctx.fillStyle = gateTargetWall(localOwner, mouse.x, mouse.y) ? '#4da3ff' : '#ff5f5f';
        ctx.fillRect(wallUnder.x - wallUnder.w / 2, wallUnder.y - wallUnder.h / 2, wallUnder.w, wallUnder.h);
      }
    } else {
      ctx.fillStyle = ok ? '#4da3ff' : '#ff5f5f';
      ctx.fillRect(mouse.x - t.w / 2, mouse.y - t.h / 2, t.w, t.h);
    }
    if (t.atkRange) {
      ctx.strokeStyle = '#4da3ff';
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, t.atkRange, 0, Math.PI * 2);
      ctx.stroke();
    }
    // show the buildable radius around grid anchors (HQ + power plants).
    // buildRadiusOf, not BUILD_RADIUS — the Flat Earthers build to 900 and were
    // being shown everyone else's 420, so the ring lied to them by half.
    ctx.strokeStyle = 'rgba(127,255,159,0.2)';
    for (const b of state.buildings) {
      if (b.owner !== localOwner || b.hp <= 0 || !b.done) continue;
      if (b.type !== 'hq' && b.type !== 'powerplant') continue;
      ctx.beginPath();
      ctx.arc(b.x, b.y, buildRadiusOf(localOwner), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ---------- burying a cache ----------
  // Same ghost language as building placement, with the sense INVERTED: the
  // green rings are the zone you may NOT bury in, because a cache is only legal
  // outside your own build radius. Showing the forbidden ground is the only way
  // that rule is learnable without reading a tooltip.
  if (cacheTargeting) {
    ctx.save();
    isoShear(ctx);
    const t = bstats(localOwner, 'preppercache');
    const why = canPlantCache(localOwner, mouse.x, mouse.y);
    // Over ground you have never seen the ghost goes GREY, not red or blue.
    // A yes/no there would be answered by the real world and would quietly
    // reveal whether an enemy structure sits in the dark — the ghost must not
    // be a scouting tool. Grey means "no idea, go and look".
    const dark = why === 'unscouted';
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = dark ? '#9aa2ac' : why ? '#ff5f5f' : '#4da3ff';
    ctx.fillRect(mouse.x - t.w / 2, mouse.y - t.h / 2, t.w, t.h);
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 2;
    // Only YOUR OWN build radius is drawn. There is deliberately no marker for
    // where the enemy is — that is the thing the Marksman has to go and find.
    ctx.strokeStyle = 'rgba(255,95,95,0.45)';
    ctx.setLineDash([8, 8]);
    for (const b of state.buildings) {
      if (b.owner !== localOwner || b.hp <= 0 || !b.done) continue;
      if (b.type !== 'hq' && b.type !== 'powerplant' && !bstatsOf(b).anchor) continue;
      ctx.beginPath();
      ctx.arc(b.x, b.y, buildRadiusOf(localOwner), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
    // why it is refused, floating over the cursor (this layer is already in
    // iso screen space — the ground-plane shear was restored above)
    if (why) {
      ctx.fillStyle = dark ? 'rgba(190,196,204,0.95)' : 'rgba(255,150,150,0.95)';
      ctx.font = 'bold 11px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(CACHE_REFUSAL[why].toUpperCase(),
        isoX(mouse.x, mouse.y), isoY(mouse.x, mouse.y) - 20);
    }
  }
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
  if (started && powerOf(localOwner).low) {
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

  // square top-down radar: the minimap stays a plain map of the world rect;
  // only the camera viewport (a screen rect in iso space) shows as a
  // rotated parallelogram
  const sx = mmCanvas.width / WORLD_W, sy = mmCanvas.height / WORLD_H;
  mmCtx.fillStyle = '#1c2818';
  mmCtx.fillRect(0, 0, mmCanvas.width, mmCanvas.height);
  for (const o of TERRAIN) {
    mmCtx.fillStyle = o.type === 'water' ? '#1d3a4a' : o.type === 'forest' ? '#243d1c' : '#4a4f56';
    mmCtx.beginPath();
    mmCtx.arc(o.x * sx, o.y * sy, o.r * sx, 0, Math.PI * 2);
    mmCtx.fill();
  }
  for (const p of state.patches) {
    if (p.amount <= 0 || tileState(p.x, p.y) === 0) continue;
    mmCtx.fillStyle = '#3fd7d0';
    mmCtx.fillRect(p.x * sx - 1, p.y * sy - 1, 3, 3);
  }
  // dig sites: everyone sees the legends, fog or no fog — bright teal
  // diamonds with a dark outline so they pop off any terrain
  for (const s of state.digSites) {
    if (s.taken) continue;
    const mx = s.x * sx, my = s.y * sy;
    mmCtx.save();
    mmCtx.translate(mx, my);
    mmCtx.rotate(Math.PI / 4);
    mmCtx.fillStyle = '#0e1a14';
    mmCtx.fillRect(-3.4, -3.4, 6.8, 6.8);
    mmCtx.fillStyle = s.progress >= DIG_TIME ? '#a5ffe6' : '#5fe3bd';
    mmCtx.fillRect(-2.2, -2.2, 4.4, 4.4);
    mmCtx.restore();
  }
  for (const b of state.buildings) {
    if (b.hp <= 0 || !observingPlayer(b)) continue;
    mmCtx.fillStyle = COLORS[b.owner];
    mmCtx.fillRect(b.x * sx - 3, b.y * sy - 3, 6, 6);
  }
  // remembered bases stay plotted where you last saw them — the radar is fed
  // by the same knowledge the main view is, or the two would disagree
  for (const g of localGhosts().values()) {
    mmCtx.fillStyle = COLORS[g.owner];
    mmCtx.fillRect(g.x * sx - 3, g.y * sy - 3, 6, 6);
  }
  for (const u of state.units) {
    if (u.hp <= 0 || u.garrisoned || !visibleToPlayer(u)) continue;
    mmCtx.fillStyle = (u.disguised && u.owner !== localOwner) ? COLORS[localOwner] : COLORS[u.owner];
    mmCtx.fillRect(u.x * sx - 1, u.y * sy - 1, 2, 2);
  }
  // fog overlay: reuse the main fog canvas, stretched onto the minimap
  mmCtx.drawImage(fogCanvas, 0, 0, FW, FH, 0, 0, mmCanvas.width, mmCanvas.height);
  // radar intel passives pierce the fog: flat sees enemy air, hollow sees enemy ground
  const pf = state.factions[localOwner];
  if (pf === 'flat' || pf === 'hollow') {
    for (const u of state.units) {
      if (u.owner === localOwner || u.hp <= 0 || u.disguised) continue;
      const fly = !!UNIT_TYPES[u.type].flying;
      if ((pf === 'flat' && fly) || (pf === 'hollow' && !fly)) {
        mmCtx.fillStyle = '#ffb45f';
        mmCtx.fillRect(u.x * sx - 1.5, u.y * sy - 1.5, 3, 3);
      }
    }
  }
  // camera viewport: the iso camera really sees a rotated diamond of the
  // world, but a plain upright rect (its bounding box) is what a classic
  // radar shows — draw that, clamped to the map
  const vw = canvas.width / cam.zoom, vh = canvas.height / cam.zoom;
  let wx0 = Infinity, wy0 = Infinity, wx1 = -Infinity, wy1 = -Infinity;
  for (const [ox, oy] of [[0, 0], [vw, 0], [vw, vh], [0, vh]]) {
    const c = isoUnproject(cam.x + ox, cam.y + oy);
    wx0 = Math.min(wx0, c.x); wy0 = Math.min(wy0, c.y);
    wx1 = Math.max(wx1, c.x); wy1 = Math.max(wy1, c.y);
  }
  wx0 = clamp(wx0, 0, WORLD_W); wx1 = clamp(wx1, 0, WORLD_W);
  wy0 = clamp(wy0, 0, WORLD_H); wy1 = clamp(wy1, 0, WORLD_H);
  mmCtx.strokeStyle = '#cfd6dd';
  mmCtx.lineWidth = 1;
  mmCtx.strokeRect(wx0 * sx, wy0 * sy, (wx1 - wx0) * sx, (wy1 - wy0) * sy);
}

// WHETHER the match is over is sim state and must be identical on every
// client, so it may only depend on who still holds an HQ and which seats are
// human. WHICH WORDS the overlay shows is local, and depends on localOwner.
function checkGameOver() {
  const alive = OWNERS.filter(o => hasHqOrCanRebuild(o));
  const humanOut = OWNERS.some(o => isHuman(o) && !hasHqOrCanRebuild(o));
  if (!humanOut && alive.length > 1) return;
  state.over = true;
  const won = hasHqOrCanRebuild(localOwner);
  const el = document.getElementById('overlay-text');
  el.textContent = won ? 'VICTORY! The truth is yours.' : 'DEFEAT';
  el.style.color = won ? '#7fff9f' : '#ff6b5f';
  document.getElementById('overlay').classList.remove('hidden');
  eva(won ? 'Mission accomplished' : 'Battle control terminated');
}

// ---------- fixed timestep ----------
// The simulation advances in whole ticks of TICK seconds and nothing else.
// 30 Hz is the pick: fine enough that the shortest weapon cooldowns (~0.1s)
// and projectile flight times don't visibly quantise, coarse enough that a
// four-AI game on a large map has headroom on one core. Every 'dt' inside
// stepSim() IS this constant — it is never a wall-clock delta — so two
// machines fed the same seed and the same commands compute the same numbers.
const TICK = 1 / 30;
// A backgrounded tab hands rAF a huge delta when it wakes. Catch up at most
// this many ticks in one frame and drop the remainder: replaying minutes of
// game time inside one frame is how a stalled tab spirals into a dead one.
// (Under lockstep the network layer, not the accumulator, decides how far a
// lagging client is allowed to fall behind — this is purely a local guard.)
const MAX_CATCHUP = 5;
let accumulator = 0;

// ---------- command queue ----------
// Orders enter the sim through here and nowhere else. Keyed by the tick they
// execute on. See applyCommand() further down for the handlers.
const commandQueue = new Map(); // tick -> [command]
// Per-OWNER counter, not a global one: the sequence number has to be assigned
// by whoever issued the command, so every client agrees on it. A global
// counter would number commands by local arrival order, which is exactly the
// machine-dependent ordering this layer exists to eliminate.
const cmdSeq = {};              // owner -> next sequence number

function drainCommands() {
  const batch = commandQueue.get(state.tick);
  if (!batch) return;
  commandQueue.delete(state.tick);
  // Deterministic total order: owner first, then the issuer-assigned sequence
  // number. Never insertion order — under a network that is arrival order.
  batch.sort((a, b) => a.owner - b.owner || a.seq - b.seq);
  for (const c of batch) applyCommand(c);
}

// CMD_DELAY is the gap between issuing a command and executing it. At 1 it is
// the next tick — 33ms, imperceptible locally. A lockstep build raises this to
// cover the round trip and nothing else in the sim has to change.
const CMD_DELAY = 1;

// file a command against the tick it will execute on
function queueCommand(c) {
  let bucket = commandQueue.get(c.tick);
  if (!bucket) commandQueue.set(c.tick, bucket = []);
  bucket.push(c);
}

function enqueue(owner, type, payload) {
  if (!started || state.over) return null;
  const seq = cmdSeq[owner] = (cmdSeq[owner] || 0) + 1;
  const c = { owner, seq, type, payload: payload || {} };
  // Networked: the command goes into the outbox and is stamped when the next
  // turn packet goes out, NOT here. Stamping it here would race — the player
  // can click after this frame's packet has already left, and the command
  // would be filed for a tick that peers were never told about.
  if (typeof Net !== 'undefined' && Net.inMatch) { Net.outbox.push(c); return c; }
  c.tick = state.tick + CMD_DELAY;
  queueCommand(c);
  return c;
}

// the local player's commands, for brevity at the call sites
const cmd = (type, payload) => enqueue(localOwner, type, payload);

// Commands carry IDS, never object references. A reference means nothing on
// another machine, and an id survives the `.filter(u => u.hp > 0)` compaction
// that rewrites state.units every tick.
const idsOf = list => list.map(e => e.id);
const cmdUnits = (ids, owner) => (ids || [])
  .map(id => state.units.find(u => u.id === id))
  .filter(u => u && u.hp > 0 && u.owner === owner);
const cmdBuildings = (ids, owner) => (ids || [])
  .map(id => state.buildings.find(b => b.id === id))
  .filter(b => b && b.hp > 0 && b.owner === owner);
const cmdUnit = (id, owner) => cmdUnits([id], owner)[0];
const cmdBuilding = (id, owner) => cmdBuildings([id], owner)[0];

// Every handler re-validates. What the player could see when they clicked is a
// hint; the state at EXECUTION time is the truth, and it is the only state all
// clients share. A command that has become illegal in the meantime is dropped.
const COMMANDS = {
  move:        (o, p) => issueCommand(o, p.u, p.x, p.y),
  attackmove:  (o, p) => { for (const u of cmdUnits(p.u, o)) if (UNIT_TYPES[u.type].role === 'combat') orderAttackMove(u, p.x, p.y); },
  rally:       (o, p) => { const b = cmdBuilding(p.b, o); if (producesUnits(b)) b.rally = { x: p.x, y: p.y }; },
  burrow:      (o, p) => burrowUnits(cmdUnits(p.u, o)),
  explore:     (o, p) => { for (const u of cmdUnits(p.u, o)) if (UNIT_TYPES[u.type].role === 'scout') u.order = { type: 'explore' }; },
  repair:      (o, p) => { for (const b of cmdBuildings(p.b, o)) b.repairing = p.on ? canRepair(b) : false; },
  demolish:    (o, p) => {
    for (const b of cmdBuildings(p.b, o)) {
      if (!p.on) { delete b.demolishT; continue; }        // called it off
      if (!canDemolish(b) || b.demolishT !== undefined) continue;
      b.demolishT = DEMOLISH_TIME;
      b.repairing = false;                                 // stop paying to mend what you are scrapping
    }
  },
  evacuate:    (o, p) => { for (const b of cmdBuildings(p.b, o)) evacuate(b); },
  unload:      (o, p) => { for (const u of cmdUnits(p.u, o)) unloadTransport(u); },
  // ---------- Flat Earth field logistics ----------
  // Marksmen go bury a cache at a spot. Legality (funds, cap, and the
  // build-radius fence) is re-checked when they arrive, not when you clicked.
  plant:       (o, p) => { for (const u of cmdUnits(p.u, o)) if (u.caches) u.order = { type: 'plant', x: p.x, y: p.y }; },
  resupply:    (o, p) => { for (const u of cmdUnits(p.u, o)) if (UNIT_TYPES[u.type].caches) u.order = { type: 'resupply', destId: p.b }; },
  drawkit:     (o, p) => {
    if (!CACHE_LOADOUT.includes(p.k)) return;
    for (const u of cmdUnits(p.u, o)) if (u.type === 'militia') u.order = { type: 'drawkit', destId: p.b, kit: p.k };
  },
  broadcast:   (o, p) => fireBroadcast(o, p.k, p.x, p.y),
  film:        (o, p) => { for (const u of cmdUnits(p.u, o)) if (UNIT_TYPES[u.type].investigator) u.order = { type: 'film', destId: p.b }; },
  filepiece:   (o, p) => { for (const u of cmdUnits(p.u, o)) if (u.proof > 0) u.order = { type: 'filepiece', destId: p.b }; },
  stance:      (o, p) => {
    if (!JOURNO_STANCES.includes(p.v)) return;
    for (const u of cmdUnits(p.u, o)) if (UNIT_TYPES[u.type].investigator) u.stance = p.v;
  },
  cachekit:    (o, p) => {
    const b = cmdBuilding(p.b, o);
    if (b && bstatsOf(b).cache && CACHE_LOADOUT.includes(p.k)) b.kit = p.k;
  },
  fitkit:      (o, p) => {
    const van = cmdUnit(p.v, o), body = cmdUnit(p.u, o);
    if (van && body && dist(van, body) <= 90) loadVanKit(van, body);
  },
  unfitkit:    (o, p) => { for (const u of cmdUnits(p.u, o)) unloadVanKit(u); },
  board:       (o, p) => {
    const v = cmdUnit(p.v, o);
    if (!v || !UNIT_TYPES[v.type].cargoCap) return;
    for (const u of cmdUnits(p.u, o)) if (!u.garrisoned) u.order = { type: 'board', destId: v.id };
  },
  demo:        (o, p) => { for (const u of cmdUnits(p.u, o)) if (u.charges) u.order = { type: 'demo', destId: p.b }; },
  boardplane:  (o, p) => { for (const u of cmdUnits(p.u, o)) if (u.type === 'homesteader') u.order = { type: 'boardplane', destId: p.b }; },
  launchplane: (o, p) => { const b = cmdBuilding(p.b, o); if (b) launchPlane(b, p.x, p.y); },
  establish:   (o, p) => { for (const u of cmdUnits(p.u, o)) u.order = { type: 'establish' }; },
  cull:        (o, p) => { for (const u of cmdUnits(p.u, o)) if (UNIT_TYPES[u.type].looshOnDeath) u.hp = 0; },
  drive:       (o, p) => { if (SLAVE_DRIVES.includes(p.v)) state.slaveDrive[o] = p.v; },
  wake:        (o, p) => { const u = state.units.find(x => x.id === p.u && x.hp > 0); if (u && u.sleeperFor === o) wakeSleeper(u); },
  // the untargeted signature powers. Which one this is depends on the owner's
  // faction, resolved HERE at execution time rather than baked in by the caller.
  sig:         (o) => {
    const f = facOf(o), s = state.sig[o];
    if (!f || !s || !f.powers.sig) return;
    const kind = f.powers.sig.kind;
    if (kind === 'once' && !s.used) castRevealInfiltrator(o);
    else if (kind === 'instant' && s.cd <= 0) castGaslight(o);
  },
  build:       (o, p) => startConstruction(o, p.t),
  cancelbuild: (o, p) => cancelConstruction(o, p.t),
  place:       (o, p) => tryPlace(o, p.x, p.y, p.t),
  wallline:    (o, p) => commitWallLine(o, p.x0, p.y0, p.x1, p.y1),
  gate:        (o, p) => convertWallToGate(o, p.x, p.y),
  rebuildhq:   (o, p) => rebuildHq(o, p.x, p.y),
  train:       (o, p) => trainUnit(o, p.t),
  canceltrain: (o, p) => cancelTraining(o, p.t),
  research:    (o, p) => startResearch(o, p.k),
  rite:        (o, p) => { const b = cmdBuilding(p.b, o); if (b) beginRite(b, p.k, p.u); },
  cancelrite:  (o, p) => { const u = cmdUnit(p.u, o); if (u) cancelRite(u); },
  super:       (o, p) => { const b = cmdBuilding(p.b, o); if (b && superReady(b) && !isOffline(b)) fireSuperweapon(b, p.x, p.y); },
  leverage:    (o, p) => { const t = state.buildings.find(b => b.id === p.b && b.hp > 0 && b.owner !== o && b.owner !== NEUTRAL); if (t) playLeverage(o, p.k, t); },
  // A player is gone. This is a COMMAND rather than something the network
  // layer does directly, because every client has to hand the seat over on the
  // same tick — a client that gave up two ticks early would have run two ticks
  // of AI the others did not, which is a desync caused by handling a
  // disconnect. The relay names the tick; this applies it.
  resign:      (o, p) => {
    const seat = p.owner;
    if (!OWNERS.includes(seat) || !humanOwners.has(seat)) return;
    humanOwners.delete(seat);
    // no simRandom() here: an abandoned seat must not shift the RNG cursor,
    // or every client that processes this would need to agree on the draw too
    if (!ais[seat]) ais[seat] = { attackWaveSize: 5, thinkTimer: 0, time: 0 };
    if (seat === localOwner) eva('Battle control terminated');
  },
  // ...and taking it back when they reconnect. The brain is deliberately left
  // in place rather than deleted: it costs nothing while the seat is human
  // (updateAI skips it), it is identical on every client, and it is waiting if
  // they drop again.
  unresign:    (o, p) => {
    const seat = p.owner;
    if (!OWNERS.includes(seat) || humanOwners.has(seat)) return;
    humanOwners.add(seat);
    if (seat === localOwner) eva('Battle control online');
  },
  ability:     (o, p) => {
    if (p.m === 'zone') (isFlat(o) ? castFirmament : castWeather)(o, p.x, p.y);
    else if (p.m === 'recall') castRecall(o, p.x, p.y);
    else if (p.m === 'unit') { const u = cmdUnit(p.u, o); if (u && UNIT_TYPES[u.type].builtAt === 'barracks') castClone(o, u); }
  },
};

// A command that names something that does not exist — a stale type after a
// balance patch, a corrupted payload, a client on a different build — must be
// dropped, not allowed to throw. An exception here would kill the tick loop
// mid-tick and leave the state half-updated, which is the one failure a
// lockstep sim cannot recover from.
function commandIsWellFormed(c) {
  const p = c.payload;
  if (!OWNERS.includes(c.owner)) return false;
  switch (c.type) {
    case 'build': case 'cancelbuild': case 'place': return !!BUILDING_TYPES[p.t];
    case 'train': case 'canceltrain': return !!UNIT_TYPES[p.t];
    case 'research': return !!DISPROOFS[p.k];
    case 'drawkit': case 'cachekit': return CACHE_LOADOUT.includes(p.k);
    case 'broadcast': return !!BROADCASTS[p.k];
    case 'stance': return JOURNO_STANCES.includes(p.v);
    case 'leverage': return !!LEVERAGE_PLAYS[p.k];
    case 'rite': return !!ASCEND[p.k];
    case 'drive': return SLAVE_DRIVES.includes(p.v);
    default: return true;
  }
}

function applyCommand(c) {
  const fn = COMMANDS[c.type];
  if (!fn || !commandIsWellFormed(c)) return;
  fn(c.owner, c.payload);
}

// One simulation tick. Takes no delta on purpose: the only time source in
// here is TICK. Nothing in this function may read performance.now(), Date,
// rAF timestamps, fxRandom(), the camera, or the selection.
function stepSim() {
  const dt = TICK;
  state.tick++;
  // derived, never accumulated: summing 30 floats a second drifts, and
  // state.time gates half the timers in the game
  state.time = state.tick * TICK;
  drainCommands();
  // the pit keeps itself at strength: if a slave replacement ever failed
  // (broke at the moment of death), top the workforce back up to cap once
  // the minerals recover — keeping a small float in the bank
  state._slaveT = (state._slaveT || 0) - dt;
  if (state._slaveT <= 0) {
    state._slaveT = 4;
    for (const o of OWNERS) {
      const f = facOf(o);
      if (!f) continue;
      // every pit worker restocks itself, not just the base Slave — the
      // Broodslave has to top up too or the crop dies out and never returns
      for (const w of [f.worker, ...(f.extras || [])]) {
        if (!w || !UNIT_TYPES[w] || !UNIT_TYPES[w].lifespan) continue;
        const ut = UNIT_TYPES[w];
        if (ut.req && !hasStruct(o, ut.req)) continue;
        if (state.minerals[o] < ut.cost + 50) continue;
        if (unitCount(o, w) < minerCap(o, w)) trainUnit(o, w);
      }
    }
  }
  // who holds a UFO Crash Site this frame (air damage + in-flight repair)
  state.airTechOwners = new Set();
  for (const b of state.buildings)
    if (b.hp > 0 && b.owner !== NEUTRAL && bstatsOf(b).airTech) state.airTechOwners.add(b.owner);
  ensurePathGrid();
  pathBudget = 12; // A* computations allowed this frame (rest retry later)
  rebuildSepGrid();
  for (const u of state.units) if (u.hp > 0) updateUnit(u, dt);
  // heavy hulls grind over light infantry: a big ground vehicle that rolled
  // this frame crushes un-armored footsoldiers caught under its tracks
  // (separation lets these pairs overlap — see separate())
  for (const u of state.units) {
    if (u.hp <= 0 || u.garrisoned || u.transit) continue;
    const t = UNIT_TYPES[u.type];
    const rolled = u._cx !== undefined && Math.hypot(u.x - u._cx, u.y - u._cy) > 14 * dt;
    u._cx = u.x; u._cy = u.y;
    if (!isCrusher(t) || !rolled) continue;
    u.crushT = (u.crushT || 0) - dt;
    if (u.crushT > 0) continue;
    u.crushT = 0.12;
    for (const v of enemiesOf(u.owner)) {
      if (v.kind !== 'unit' || v.hp <= 0 || v.garrisoned || v.transit || v.burrowed) continue;
      if (!isCrushable(UNIT_TYPES[v.type])) continue;
      if (dist(u, v) > t.r + UNIT_TYPES[v.type].r - 4) continue;
      v.hp = 0; // squished — no disguise, no dodge, no appeal
      Particles.smoke(v.x, v.y, 4);
      if (tileState(v.x, v.y) === 2) sfx('boom');
    }
  }
  updateTransits();
  for (const b of state.buildings) if (b.hp > 0) updateBuilding(b, dt);
  // every human seat has a build queue ticking; every other seat has a brain
  for (const o of OWNERS) if (isHuman(o)) tickConstruction(o, dt);
  for (const o of OWNERS) if (!isHuman(o)) updateAI(o, dt);
  updateAbilities(dt);
  updateHqContinuity(dt);
  updateProjectiles(dt);
  updateZones(dt);
  updateClosedSky(dt);
  for (const u of state.units) {
    if (u.expires && state.time > u.expires) u.hp = 0; // phantoms & hatchlings fade
    // mind-controlled units revert to their real owner when the coup lapses —
    // or the moment their side proves the whole thing was staged
    if (u.coupRevert && u.hp > 0 &&
        (state.time > u.coupRevert || disproved(u.coupOrig, 'actors'))) {
      if (u.coupOrig !== undefined && state.factions[u.coupOrig]) {
        u.owner = u.coupOrig;
        u.order = { type: 'idle' };
      }
      delete u.coupRevert; delete u.coupOrig;
    }
    // Crisis Actors: a recruited sleeper comes to their senses and stops
    // reporting. They were never taken off their owner — they simply stop
    // being anybody else's asset.
    if (u.sleeperUntil && u.hp > 0 && state.time > u.sleeperUntil) {
      const handler = u.sleeperFor;
      u.sleeperFor = null;
      delete u.sleeperUntil;
      if (handler === localOwner) eva('An asset has gone dark');
    }
  }
  updateFog();

  // destruction effects
  for (const b of state.buildings) {
    if (b.hp <= 0) {
      // Too Big To Fail: a Globalist structure refunds a quarter of its cost
      // when it falls (cheap field structures excepted). Not on top of a
      // demolition, though — that clause is compensation for LOSING a building,
      // and stacking it on a voluntary teardown paid Globalists 75% to reshuffle
      // their own base.
      if (!b._refunded && !b.demolished && state.factions[b.owner] === 'glob' &&
          b.type !== 'wall' && b.type !== 'gate' && b.type !== 'mine') {
        state.minerals[b.owner] = (state.minerals[b.owner] || 0) + Math.floor((bstatsOf(b).cost || 0) * 0.25);
        b._refunded = true;
      }
      Particles.boom(b.x, b.y, b.demolished ? 0.9 : 1.7); // a teardown, not a hit
      if (tileState(b.x, b.y) === 2) sfx('boom');
      // "Structure lost" is a warning; you know perfectly well about this one
      if (b.owner === localOwner && !b.demolished && !bstatsOf(b).trip) eva('Structure lost');
      // gas stations go up in a fireball that hurts EVERYONE nearby
      // (owner -99 so not even neutral structures are spared — chain reactions!)
      const ex = bstatsOf(b).explodes;
      if (ex) {
        splashDamage(b.x, b.y, ex.r, ex.dmg, -99, {}, true);
        Particles.boom(b.x, b.y, 2.4);
        if (ex.fire) {
          state.zones.push({ x: b.x, y: b.y, r: ex.fire.r, until: state.time + ex.fire.dur, caster: -99, kind: 'fire', dps: ex.fire.dps });
        }
      }
      // a collapsing structure buries its garrison
      if (b.garrison) {
        for (const id of b.garrison) {
          const u = state.units.find(x => x.id === id);
          if (u) u.hp = 0;
        }
      }
    }
  }
  for (const u of state.units) {
    if (u.hp <= 0 && u.type !== 'phantom') {
      // a dying transport: a bail-out ride (open bed, rear ramp) throws its
      // riders clear — hurt, dazed, but alive; a sealed hull takes everyone
      if (u.cargo) {
        const spill = UNIT_TYPES[u.type].bailOut;
        u.cargo.forEach((id, i) => {
          const p = findEntity(id);
          if (!p || p.hp <= 0) return;
          if (spill) {
            p.garrisoned = false; p.transportId = null;
            const a = i / u.cargo.length * Math.PI * 2;
            p.x = u.x + Math.cos(a) * 18; p.y = u.y + Math.sin(a) * 18;
            p.hp = Math.max(1, p.hp - p.maxHp * 0.3); // thrown from the wreck
            p.order = { type: 'idle' };
          } else p.hp = 0;
        });
        u.cargo = [];
      }
      // a slave's death — overwork, enemy fire, or the knife — feeds the
      // loosh, and the Hatchery automatically buys a replacement
      if (UNIT_TYPES[u.type].looshOnDeath) {
        if (!u.looshBooked) { u.looshBooked = true; grantLoosh(u.owner, UNIT_TYPES[u.type].looshOnDeath); }
        Particles.pulse(u.x, u.y, 16, [220, 60, 90]);
        if (!u.noRestock) trainUnit(u.owner, u.type); // a culled-by-choice slave stays culled
      }
      // a fallen Guard or Dreadnought leaves its armor for the priests
      if (UNIT_TYPES[u.type].armorTier && !u.abducted && isHollow(u.owner)) {
        state.armorWrecks.push({ id: nextId++, x: u.x, y: u.y, tier: UNIT_TYPES[u.type].armorTier, owner: u.owner, until: state.time + 45 });
      }
      creditBattleFootage(u);   // anything dying on camera is worth filming
      // a Bush Plane shot down on the run in takes its whole team with it
      if (u.type === 'bushflight' && u.crewCount && !u.abducted) bushPlaneLost(u);
      // a kitted Bug Out Van takes the body welded into it down with the wreck
      if (u.kitBody) {
        const body = state.units.find(x => x.id === u.kitBody && x.hp > 0);
        if (body) { body.hp = 0; body.abducted = true; }
      }
      if (u.abducted) { Particles.pulse(u.x, u.y, 40, [190, 140, 255]); continue; } // beamed up — no wreck, no boom
      Particles.boom(u.x, u.y, UNIT_TYPES[u.type].r > 11 ? 1 : 0.55);
      // a cattle mutilator near the wreck renders it down for minerals
      const mut = nearest(u, state.units, m => m.hp > 0 && !m.garrisoned &&
        UNIT_TYPES[m.type].scavenge && dist(m, u) <= 170);
      if (mut) {
        state.minerals[mut.owner] += UNIT_TYPES[mut.type].scavenge;
        Particles.bolt(mut.x, mut.y, u.x, u.y, [125, 255, 214], 8);
      }
    }
  }
  state.units = state.units.filter(u => u.hp > 0);
  // a fallen Broadcast Station burns the footage it was holding — announce it
  // before the building is swept out of the list
  for (const b of state.buildings) if (b.hp <= 0 && b.proof) proofStationLost(b);
  const nBld = state.buildings.length;
  state.buildings = state.buildings.filter(b => b.hp > 0);
  if (state.buildings.length !== nBld) markPathDirty(); // rubble opens lanes
  checkGameOver();
}

// Advance exactly n ticks with no rendering and no wall clock — the entry
// point for the desync harness and for any future headless replay.
function stepTicks(n) {
  for (let i = 0; i < n && !state.over; i++) stepSim();
}

function frame(now) {
  // Real elapsed time drives ONLY the accumulator and the view. Clamped below
  // at 0 so a backwards timestamp (console-driven stepping) can never run the
  // sim in reverse, and above so one long stall doesn't queue up a hundred
  // ticks before MAX_CATCHUP gets a chance to throw them away.
  const real = Math.max(0, Math.min(0.25, (now - lastTime) / 1000));
  lastTime = now;

  if (started && !state.over) {
    // camera pans on wall time: it is view-only and never enters the sim
    const pan = 520 * real / cam.zoom;
    if (keys['arrowleft'] || keys['a']) cam.x -= pan;
    if (keys['arrowright'] || keys['d']) cam.x += pan;
    if (keys['arrowup'] || keys['w']) cam.y -= pan;
    if (keys['arrowdown'] || keys['s']) cam.y += pan;
    clampCam();

    accumulator += real;
    const net = (typeof Net !== 'undefined' && Net.inMatch) ? Net : null;
    // A reconnecting client is replaying history as fast as it can in its own
    // loop. The frame loop must not also be stepping the sim, or the two would
    // interleave and the replay would land on the wrong tick.
    if (net && net.catchingUp) { accumulator = 0; render(0); return; }
    let n = 0, stalled = false;
    while (accumulator >= TICK && n < MAX_CATCHUP && !state.over) {
      // THE lockstep rule: a tick may not run until every player's orders for
      // that tick are in hand. Guessing and rolling back is a different (much
      // larger) architecture; here we simply wait, which is what the
      // "Waiting for players…" bar in every RTS of this lineage is.
      if (net && !net.canStep(state.tick + 1)) { stalled = true; break; }
      stepSim();
      accumulator -= TICK;
      n++;
      if (net) net.afterTick(); // publish this client's next packet
    }
    if (stalled) {
      // Do not let real time pile up while we wait, or the moment the missing
      // packet lands the game fast-forwards through the backlog.
      accumulator = Math.min(accumulator, TICK);
      net.noteStall();
    } else if (net) {
      net.clearStall();
    }
    // hit the cap: we are behind by more than we can honestly make up, so
    // throw the backlog away rather than carrying a debt into the next frame
    if (n === MAX_CATCHUP) accumulator = 0;

    // ---- everything below is view-only and runs on wall time ----
    Particles.update(real);

    const beforeLen = selection.length;
    // Dead things drop out — and so does anything of someone else's you have
    // stopped watching. The panel is a LIVE readout (hp, queue, garrison), so
    // holding an enemy selected while they walk into the dark would have been a
    // window straight through the fog memory. Your own never fails this test.
    selection = selection.filter(e => e.hp > 0 && observingPlayer(e));
    if (selection.length !== beforeLen) refreshPanel();

    const low = powerOf(localOwner).low;
    if (low && !wasLowPower) eva('Low power');
    wasLowPower = low;

    const mine = state.units.filter(u => u.owner === localOwner);
    const w = mine.filter(u => UNIT_TYPES[u.type].role === 'worker').length;
    elSupply.textContent = `Workers: ${w}  Army: ${mine.length - w}`;

    // Match clock, for timing build orders while playtesting. Derived from the
    // tick counter rather than the wall clock, so it is the SIMULATION's idea
    // of elapsed time — it cannot drift, and two networked clients always read
    // the same number.
    const secs = Math.floor(state.time);
    elClock.textContent = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');

    panelTimer += real;
    if (panelTimer > 0.25) { panelTimer = 0; refreshSidebar(); refreshPanel(); }
  }

  // render interpolation factor: where we sit between the last completed tick
  // and the next one. Read by draw() only — nothing here writes sim state.
  render(accumulator / TICK);
}

// draw() is the whole renderer; alpha is available to it for interpolation
function render(alpha) {
  state.alpha = alpha;
  draw();
}

// single scheduler chain: frame() itself never re-schedules, so calling it
// manually (tests, tools) can't stack extra rAF loops
function rafLoop(now) {
  frame(now);
  requestAnimationFrame(rafLoop);
}

// ---------- boot: canvas sizing + prerendered ground ----------

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

const groundCanvas = document.createElement('canvas');
let mapDecor = []; // ground decals from mapgen (plazas, crop fields)

// rounded-rect path helper for ground decals
function rr2(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// irregular blob outline for a terrain obstacle, jittered by its seed
// (collision stays the plain circle — the blob only overshoots by ~15%)
function blobPath(g, o, scale = 1) {
  const pts = 12;
  g.beginPath();
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const rr = o.r * scale * (0.84 + 0.3 * prand(o.seed * 13 + i));
    const x = o.x + Math.cos(a) * rr, y = o.y + Math.sin(a) * rr;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
}

function renderGround() {
  // the ground is prerendered THROUGH the iso projection: the canvas covers
  // the projected diamond's bounding box, and all the flat world-space
  // drawing below lands on it via the shear transform. Huge worlds render
  // at reduced resolution to cap memory; draw() stretches it back.
  const gs = Math.min(1, 6400 / isoSpanW());
  groundCanvas.width = Math.round(isoSpanW() * gs);
  groundCanvas.height = Math.round(isoSpanH() * gs);
  const g = groundCanvas.getContext('2d');
  g.save();
  g.scale(gs, gs);
  g.translate(WORLD_H, 0); // diamond west corner has ix = -WORLD_H
  isoShear(g);
  // clip to the world rect: the old flat canvas clipped overshooting detail
  // (edge ellipses, shore blobs) at its edges; the iso canvas is bigger
  g.beginPath();
  g.rect(0, 0, WORLD_W, WORLD_H);
  g.clip();
  g.fillStyle = '#31402c';
  g.fillRect(0, 0, WORLD_W, WORLD_H);
  const nDetail = Math.round(WORLD_W * WORLD_H / 3100);
  for (let i = 0; i < nDetail; i++) {
    const gx = (i * 7919) % WORLD_W;
    const gy = (i * 104729) % WORLD_H;
    const s = 14 + (i * 31) % 40;
    g.fillStyle = (i % 3 === 0) ? 'rgba(66,86,58,0.35)' : 'rgba(40,52,36,0.35)';
    g.beginPath();
    g.ellipse(gx, gy, s, s * 0.6, (i % 7) * 0.5, 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = 'rgba(255,255,255,0.04)';
  g.lineWidth = 1;
  for (let x = 0; x <= WORLD_W; x += 100) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, WORLD_H); g.stroke(); }
  for (let y = 0; y <= WORLD_H; y += 100) { g.beginPath(); g.moveTo(0, y); g.lineTo(WORLD_W, y); g.stroke(); }

  // ground decals under settlements. Roads first so pavement, lots and
  // greenery layer cleanly on top of the street network.
  for (const d of mapDecor) {
    if (d.kind !== 'road') continue;
    const horiz = d.w >= d.h;
    g.fillStyle = '#33363b'; // asphalt
    g.fillRect(d.x - d.w / 2, d.y - d.h / 2, d.w, d.h);
    // curbs along the long sides
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 1.5;
    if (horiz) {
      g.beginPath(); g.moveTo(d.x - d.w / 2, d.y - d.h / 2 + 1); g.lineTo(d.x + d.w / 2, d.y - d.h / 2 + 1); g.stroke();
      g.beginPath(); g.moveTo(d.x - d.w / 2, d.y + d.h / 2 - 1); g.lineTo(d.x + d.w / 2, d.y + d.h / 2 - 1); g.stroke();
    } else {
      g.beginPath(); g.moveTo(d.x - d.w / 2 + 1, d.y - d.h / 2); g.lineTo(d.x - d.w / 2 + 1, d.y + d.h / 2); g.stroke();
      g.beginPath(); g.moveTo(d.x + d.w / 2 - 1, d.y - d.h / 2); g.lineTo(d.x + d.w / 2 - 1, d.y + d.h / 2); g.stroke();
    }
  }
  for (const d of mapDecor) {
    if (d.kind === 'road') {
      // faded dashed centerline, kept clear of the intersections
      const horiz = d.w >= d.h;
      g.strokeStyle = 'rgba(214,193,110,0.4)';
      g.lineWidth = 2;
      g.setLineDash([10, 12]);
      g.beginPath();
      if (horiz) { g.moveTo(d.x - d.w / 2 + 34, d.y); g.lineTo(d.x + d.w / 2 - 34, d.y); }
      else { g.moveTo(d.x, d.y - d.h / 2 + 34); g.lineTo(d.x, d.y + d.h / 2 - 34); }
      g.stroke();
      g.setLineDash([]);
    } else if (d.kind === 'lot') {
      // parking lot: lighter asphalt with painted stalls
      g.fillStyle = '#3e4147';
      rr2(g, d.x - d.w / 2, d.y - d.h / 2, d.w, d.h, 4);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.25)';
      g.lineWidth = 1.2;
      const stalls = Math.max(2, Math.floor(d.w / 16));
      for (let i = 0; i <= stalls; i++) {
        const sx = d.x - d.w / 2 + 6 + i * (d.w - 12) / stalls;
        g.beginPath(); g.moveTo(sx, d.y - d.h / 2 + 5); g.lineTo(sx, d.y - d.h / 2 + 5 + d.h * 0.36); g.stroke();
      }
      // one abandoned wreck, sometimes
      if (prand(d.seed) < 0.4) {
        g.fillStyle = ['#6d4a3a', '#4a5a6d', '#5d5d5d'][Math.floor(prand(d.seed + 1) * 3)];
        rr2(g, d.x - d.w / 2 + 8 + prand(d.seed + 2) * (d.w - 34), d.y - d.h / 2 + 8, 18, 9, 2.5);
        g.fill();
      }
    } else if (d.kind === 'park') {
      // pocket park: lawn, path, tree canopies (purely decorative)
      g.fillStyle = '#3c5232';
      rr2(g, d.x - d.w / 2, d.y - d.h / 2, d.w, d.h, 8);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1.5; g.stroke();
      g.strokeStyle = 'rgba(180,170,140,0.4)';
      g.lineWidth = 4;
      g.beginPath(); g.moveTo(d.x - d.w / 2 + 6, d.y); g.quadraticCurveTo(d.x, d.y + d.h * 0.22, d.x + d.w / 2 - 6, d.y); g.stroke();
      for (let i = 0; i < Math.max(3, Math.round(d.w / 26)); i++) {
        const tx = d.x + (prand(d.seed + i * 3) - 0.5) * (d.w - 24);
        const ty = d.y + (prand(d.seed + i * 3 + 1) - 0.5) * (d.h - 24);
        g.fillStyle = 'rgba(0,0,0,0.25)';
        g.beginPath(); g.ellipse(tx + 2, ty + 3, 8, 5, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = i % 2 ? '#4c6b3c' : '#557a42';
        g.beginPath(); g.arc(tx, ty, 7 + prand(d.seed + i) * 4, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.1)';
        g.beginPath(); g.arc(tx - 2, ty - 2, 3.5, 0, Math.PI * 2); g.fill();
      }
    } else if (d.kind === 'plaza') {
      g.fillStyle = '#3a3d42';
      rr2(g, d.x - d.w / 2, d.y - d.h / 2, d.w, d.h, 10);
      g.fill();
      g.strokeStyle = '#2b2d31';
      g.lineWidth = 2;
      g.stroke();
      // pavement cracks + faded lane paint
      g.strokeStyle = 'rgba(255,255,255,0.07)';
      g.lineWidth = 1.5;
      for (let i = 1; i < Math.floor(d.w / 118); i++) {
        const lx = d.x - d.w / 2 + i * 118;
        g.beginPath(); g.moveTo(lx, d.y - d.h / 2 + 8); g.lineTo(lx, d.y + d.h / 2 - 8); g.stroke();
      }
      g.strokeStyle = 'rgba(0,0,0,0.25)';
      g.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        const cxr = d.x + (prand(d.seed + i) - 0.5) * d.w * 0.8;
        const cyr = d.y + (prand(d.seed + i + 9) - 0.5) * d.h * 0.8;
        g.beginPath();
        g.moveTo(cxr, cyr);
        g.lineTo(cxr + (prand(d.seed + i + 3) - 0.5) * 26, cyr + (prand(d.seed + i + 6) - 0.5) * 26);
        g.stroke();
      }
    } else if (d.kind === 'field') {
      g.save();
      g.translate(d.x, d.y);
      g.rotate((prand(d.seed) - 0.5) * 0.5);
      g.fillStyle = '#665f36';
      g.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
      g.strokeStyle = '#4c4728';
      g.lineWidth = 2;
      g.strokeRect(-d.w / 2, -d.h / 2, d.w, d.h);
      // crop rows
      for (let ry = -d.h / 2 + 5; ry < d.h / 2 - 3; ry += 9) {
        g.strokeStyle = (Math.round(ry / 9) % 2) ? 'rgba(140,150,70,0.55)' : 'rgba(70,66,38,0.55)';
        g.lineWidth = 3.5;
        g.beginPath(); g.moveTo(-d.w / 2 + 5, ry); g.lineTo(d.w / 2 - 5, ry); g.stroke();
      }
      g.restore();
    }
  }

  for (const o of TERRAIN) {
    if (o.type === 'water') {
      // sandy shore, deep body, wave arcs
      g.fillStyle = '#3d4a35';
      blobPath(g, o, 1.14); g.fill();
      g.fillStyle = '#16303c';
      blobPath(g, o); g.fill();
      g.strokeStyle = '#234a5c'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#1d3d4c';
      blobPath(g, o, 0.6); g.fill();
      g.strokeStyle = 'rgba(110,165,195,0.3)';
      g.lineWidth = 1.5;
      const nWaves = Math.max(2, Math.round(o.r / 30));
      for (let i = 0; i < nWaves; i++) {
        const wx = o.x + (prand(o.seed + i * 7) - 0.5) * o.r * 1.1;
        const wy = o.y + (prand(o.seed + i * 7 + 3) - 0.5) * o.r * 0.9;
        g.beginPath();
        g.arc(wx, wy, 6 + prand(o.seed + i) * 8, 0.3, 2.6);
        g.stroke();
      }
    } else if (o.type === 'rock') {
      // shaded mesa base — the boulders standing on it are depth-sorted
      // props drawn per frame (see buildTerrainProps)
      g.fillStyle = 'rgba(0,0,0,0.25)';
      blobPath(g, { ...o, x: o.x + 4, y: o.y + 5 }); g.fill();
      g.fillStyle = '#454b53';
      blobPath(g, o); g.fill();
      g.strokeStyle = '#2c3036'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#565d67';
      blobPath(g, { ...o, x: o.x - o.r * 0.18, y: o.y - o.r * 0.18, seed: o.seed + 5 }, 0.62); g.fill();
    } else if (o.type === 'forest') {
      // undergrowth blob — the trees themselves are depth-sorted props
      g.fillStyle = '#26361f';
      blobPath(g, o, 1.08); g.fill();
      g.fillStyle = '#1e2c19';
      blobPath(g, o, 0.85); g.fill();
    }
  }
  g.restore();

  // upright trees & boulders baked straight into the ground image: hundreds
  // of per-frame prop blits cost real time, and static scenery doesn't need
  // the depth sort (units draw over them — a fair trade for the speed)
  const props = terrainProps.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
  g.save();
  g.scale(gs, gs);
  g.translate(WORLD_H, 0);
  for (const p of props) {
    g.save();
    g.translate(isoX(p.x, p.y), isoY(p.x, p.y));
    renderProp(g, p.kind, p.s, p.v);
    g.restore();
  }
  g.restore();
}

// ---------- input wiring ----------

document.addEventListener('pointerdown', ensureAudio, { once: false });
document.getElementById('mute-btn').addEventListener('click', () => setMuted(!muted));

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (!started) return;
  const before = screenToIso(e); // keep the iso point under the cursor fixed
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
    if (leverageTargeting) {
      const key = leverageTargeting;
      const tgt = state.buildings.find(b => b.hp > 0 && b.owner !== localOwner && b.owner !== NEUTRAL &&
        Math.abs(b.x - p.x) <= b.w / 2 + 6 && Math.abs(b.y - p.y) <= b.h / 2 + 6);
      if (tgt) { cmd('leverage', { k: key, b: tgt.id }); leverageTargeting = null; sfx('click'); }
      else eva('Click one of THEIR structures');
      refreshPanel(); refreshSidebar();
      return;
    }
    if (superTargeting) {
      const sw = state.buildings.find(b => b.id === superTargeting && b.owner === localOwner && b.hp > 0);
      superTargeting = null;
      if (sw && superReady(sw) && !isOffline(sw)) { cmd('super', { b: sw.id, x: p.x, y: p.y }); sfx('click'); }
      refreshPanel();
      return;
    }
    // ---------- Flat Earth field logistics, all ground- or structure-targeted ----------
    if (cacheTargeting) {
      const ids = cacheTargeting;
      cacheTargeting = null;
      // the refusal reasons live in canPlantCache; show one now rather than
      // letting the Marksman walk all the way out to be told no
      const why = canPlantCache(localOwner, p.x, p.y);
      if (why) eva(CACHE_REFUSAL[why]);
      else { cmd('plant', { u: ids, x: p.x, y: p.y }); sfx('click'); }
      refreshPanel();
      return;
    }
    if (bcastTargeting) {
      const key = bcastTargeting;
      bcastTargeting = null;
      cmd('broadcast', { k: key, x: p.x, y: p.y });
      sfx('click'); refreshPanel();
      return;
    }
    if (dropTargeting) {
      const id = dropTargeting;
      dropTargeting = null;
      if (!canDropAt(localOwner, p.x, p.y)) eva('Drop zone not scouted');
      else { cmd('launchplane', { b: id, x: p.x, y: p.y }); sfx('click'); }
      refreshPanel();
      return;
    }
    if (demoTargeting) {
      const ids = demoTargeting;
      demoTargeting = null;
      const tgt = state.buildings.find(b => b.hp > 0 && b.owner !== localOwner && b.owner !== NEUTRAL &&
        Math.abs(p.x - b.x) <= b.w / 2 + 10 && Math.abs(p.y - b.y) <= b.h / 2 + 10);
      if (tgt) { cmd('demo', { u: ids, b: tgt.id }); sfx('click'); }
      else eva('Charges go on enemy structures');
      refreshPanel();
      return;
    }
    if (abilityTargeting) {
      const mode = abilityTargeting;
      abilityTargeting = null;
      // 'zone' is the shared targeted-area kind; the faction decides what lands
      if (mode === 'zone' || mode === 'recall') cmd('ability', { m: mode, x: p.x, y: p.y });
      if (mode === 'unit') {
        const target = state.units.find(u => u.owner === localOwner && u.hp > 0 && !u.garrisoned && clickHitsUnit(u, p.x, p.y, 8));
        if (target && UNIT_TYPES[target.type].builtAt !== 'barracks') eva('Cloning Vats accept infantry only');
        else if (target) cmd('ability', { m: 'unit', u: target.id });
      }
      refreshPanel();
      refreshSidebar();
      return;
    }
    if (placing === 'hq') {
      // the emergency HQ goes ANYWHERE — there is no build radius left to
      // measure from, which is the whole point of the grace window
      // predicted client-side: the command re-checks affordability at its tick
      cmd('rebuildhq', { x: p.x, y: p.y });
      placing = null; sfx('click'); refreshPanel(); refreshSidebar();
      return;
    }
    if (placing) {
      // RA2-style walls lay in stretches: press-drag lays a whole run at once
      // (committed on mouseup). Gates place one at a time.
      if (placing === 'wall') {
        wallDrag = { x0: Math.round(p.x / WALL_STEP) * WALL_STEP, y0: Math.round(p.y / WALL_STEP) * WALL_STEP };
        return;
      }
      // gates cut into an existing straight wall segment, not open ground
      if (placing === 'gate') { cmd('gate', { x: p.x, y: p.y }); sfx('click'); return; }
      const st = bstats(localOwner, placing);
      // The placement legality check stays client-side so the cursor keeps its
      // instant feedback; the command re-checks it authoritatively at its tick.
      const legal = st.instant
        ? !placementBlocked(localOwner, placing, p.x, p.y) && (st.anywhere || withinBuildRadius(localOwner, p.x, p.y)) &&
          state.minerals[localOwner] >= st.cost && !atStructCap(localOwner, placing)
        : (() => { const c = state.construction[localOwner]; return !!c && c.ready && !placementBlocked(localOwner, c.type, p.x, p.y) &&
            (bstats(localOwner, c.type).anywhere || withinBuildRadius(localOwner, p.x, p.y)); })();
      if (legal) {
        cmd('place', { t: placing, x: p.x, y: p.y });
        sfx('click');
        // field structures stay armed so you can drop several; stop when dry or capped
        if (!st.instant || state.minerals[localOwner] < st.cost * 2 || atStructCap(localOwner, placing)) placing = null;
        refreshPanel(); refreshSidebar();
      }
      return;
    }
    if (attackMoveArmed) {
      attackMoveArmed = false;
      const u = idsOf(selection.filter(e => e.kind === 'unit' && e.hp > 0 && e.owner === localOwner &&
        UNIT_TYPES[e.type].role === 'combat'));
      if (u.length) cmd('attackmove', { u, x: p.x, y: p.y });
      refreshPanel();
      return;
    }
    // drag-select box lives in iso screen space (stays screen-axis-aligned;
    // in world space it is a parallelogram — units are tested by their
    // projected position, which is the same thing)
    const pi = screenToIso(e);
    mouse.sel = { x1: pi.x, y1: pi.y, x2: pi.x, y2: pi.y };
  } else if (e.button === 2) {
    if (placing || attackMoveArmed || abilityTargeting || superTargeting || leverageTargeting || plantArmed || wallDrag ||
        cacheTargeting || dropTargeting || demoTargeting || bcastTargeting) {
      placing = null;
      attackMoveArmed = false;
      abilityTargeting = null;
      superTargeting = null;
      plantArmed = false;
      wallDrag = null;
      refreshPanel();
      return;
    }
    // right-drag pans the map; a right-click with no movement commands on release
    panDrag = { sx: e.clientX, sy: e.clientY, camX: cam.x, camY: cam.y, right: true, moved: false, wx: p.x, wy: p.y };
  }
});

canvas.addEventListener('mousemove', e => {
  const p = screenToWorld(e);
  mouse.x = p.x;
  mouse.y = p.y;
  if (mouse.sel) { const pi = screenToIso(e); mouse.sel.x2 = pi.x; mouse.sel.y2 = pi.y; }
});

window.addEventListener('mousemove', e => {
  if (panDrag) {
    cam.x = panDrag.camX - (e.clientX - panDrag.sx) / cam.zoom;
    cam.y = panDrag.camY - (e.clientY - panDrag.sy) / cam.zoom;
    // only a deliberate drag pans; a small jitter during a click must still
    // count as a command (a 5px threshold ate legitimate right-click orders)
    if (Math.abs(e.clientX - panDrag.sx) + Math.abs(e.clientY - panDrag.sy) > 14) panDrag.moved = true;
    clampCam();
  }
});

window.addEventListener('mouseup', e => {
  if (e.button === 1) { panDrag = null; return; }
  if (e.button === 2) {
    // releasing a right-drag: if the mouse never really moved, it was a command
    if (panDrag && panDrag.right) {
      const wasClick = !panDrag.moved;
      const wx = panDrag.wx, wy = panDrag.wy;
      panDrag = null;
      if (wasClick) rightCommand(wx, wy);
    }
    return;
  }
  if (e.button !== 0) return;
  // commit a dragged wall stretch (single click with no drag lays one segment)
  if (wallDrag) {
    cmd('wallline', { x0: wallDrag.x0, y0: wallDrag.y0, x1: mouse.x, y1: mouse.y });
    wallDrag = null;
    const wst = bstats(localOwner, 'wall');
    if (state.minerals[localOwner] < wst.cost || atStructCap(localOwner, 'wall')) placing = null;
    refreshPanel(); refreshSidebar();
    return;
  }
  mmDown = false;
  if (!mouse.sel) return;
  const s = mouse.sel;
  const p = screenToIso(e);
  s.x2 = p.x;
  s.y2 = p.y;
  mouse.sel = null;
  const x1 = Math.min(s.x1, s.x2), x2 = Math.max(s.x1, s.x2);
  const y1 = Math.min(s.y1, s.y2), y2 = Math.max(s.y1, s.y2);
  if (x2 - x1 < 6 && y2 - y1 < 6) {
    const w = isoUnproject(x1, y1);
    // double-click a unit → select every on-screen unit of the same type
    const now = state.time;
    const dbl = now - lastClick.t < 0.35 && Math.abs(x1 - lastClick.x) < 10 && Math.abs(y1 - lastClick.y) < 10;
    lastClick = { t: now, x: x1, y: y1 };
    const hit = state.units.find(u => u.owner === localOwner && u.hp > 0 && !u.garrisoned && clickHitsUnit(u, w.x, w.y, 4));
    if (dbl && hit) {
      selection = state.units.filter(u => u.owner === localOwner && u.hp > 0 && !u.garrisoned && u.type === hit.type && onScreen(u));
      sfx('click');
    } else {
      selectAt(w.x, w.y);
    }
  } else {
    // the box is iso-screen-aligned: test each unit's DRAWN position
    // (airborne sprites ride FLY_H above their ground point)
    let picked = state.units.filter(u => {
      if (u.owner !== localOwner || u.hp <= 0 || u.garrisoned) return false;
      const alt = (UNIT_TYPES[u.type].flying && !u.landed) ? FLY_H : 0;
      const px = isoX(u.x, u.y), py = isoY(u.x, u.y) - alt;
      return px >= x1 && px <= x2 && py >= y1 && py <= y2;
    });
    // a drag over a mixed crowd grabs the army and leaves the workers mining
    if (picked.some(u => UNIT_TYPES[u.type].role === 'combat')) {
      picked = picked.filter(u => UNIT_TYPES[u.type].role === 'combat');
    }
    selection = picked;
    // also grab your garrisoned civilian structures under the box, so the
    // panel can offer to evacuate them
    const gbld = state.buildings.filter(b => b.owner === localOwner && b.hp > 0 && b.garrison && b.garrison.length && bstatsOf(b).slots &&
      (() => { const px = isoX(b.x, b.y), py = isoY(b.x, b.y); return px >= x1 && px <= x2 && py >= y1 && py <= y2; })());
    if (gbld.length) selection = selection.concat(gbld);
  }
  refreshPanel();
});

// Keyboard zoom, held about the CENTRE of the view rather than the cursor —
// the wheel pivots on the pointer because that is where you are looking, but a
// keypress has no pointer, and pivoting on a stale mouse position throws the
// camera somewhere you did not ask for.
function zoomStep(mul) {
  if (!started) return;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const isoX0 = cam.x + cx / cam.zoom, isoY0 = cam.y + cy / cam.zoom;
  cam.zoom = clamp(cam.zoom * mul, minZoom(), 2);
  cam.x = isoX0 - cx / cam.zoom;
  cam.y = isoY0 - cy / cam.zoom;
  clampCam();
}

// Arm the superweapon without going to find the silo first. Picks the one that
// is actually ready — most charged first, then by id so the choice is stable.
function armSuperweaponHotkey() {
  const ready = state.buildings.filter(b => b.owner === localOwner && b.hp > 0 &&
    bstatsOf(b).superweapon && superReady(b) && !isOffline(b));
  if (!ready.length) { eva('No superweapon ready'); return; }
  ready.sort((a, b) => (b.charge || 0) - (a.charge || 0) || a.id - b.id);
  superTargeting = ready[0].id;
  sfx('click');
  refreshPanel();
}

window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (!started) return;
  const k = e.key.toLowerCase();

  if (e.key === 'Escape') { placing = null; attackMoveArmed = false; abilityTargeting = null; superTargeting = null; leverageTargeting = null; plantArmed = false; wallDrag = null; cacheTargeting = null; dropTargeting = null; demoTargeting = null; bcastTargeting = null; refreshPanel(); }
  if (k === 'h') centerCameraOnHome();
  if (k === 'm') setMuted(!muted);

  // zoom: +/- step, 0 back to 1:1
  if (k === '+' || k === '=') { zoomStep(1.15); e.preventDefault(); }
  if (k === '-' || k === '_') { zoomStep(1 / 1.15); e.preventDefault(); }
  if (k === '0') { zoomStep(1 / cam.zoom); e.preventDefault(); }

  // Q: arm the superweapon, then click the target
  if (k === 'q') armSuperweaponHotkey();

  if (k === 'e' && selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].role === 'combat')) {
    attackMoveArmed = true;
    refreshPanel();
  }


  if (k === 'x') burrowCmd();

  if (k === 'v' && selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].role === 'scout')) exploreCmd();

  // control groups
  if (/^[1-5]$/.test(e.key)) {
    if (e.ctrlKey) {
      groups[e.key] = selection.slice();
      e.preventDefault();
    } else if (groups[e.key]) {
      selection = groups[e.key].filter(en => en.hp > 0 && !en.garrisoned);
      refreshPanel();
    }
  }
});
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

mmCanvas.addEventListener('mousedown', e => {
  if (e.button === 0) { mmDown = true; minimapPan(e); }        // left: pan the view
  else if (e.button === 2) { minimapCommand(e); }              // right: order units there
});
mmCanvas.addEventListener('mousemove', e => { if (mmDown) minimapPan(e); });
mmCanvas.addEventListener('contextmenu', e => e.preventDefault());

// ---------- HUD elements ----------

const elCredits = document.getElementById('credits');
const elPowerFill = document.getElementById('powerfill');
const elPowerText = document.getElementById('powertext');
const elResWrap = document.getElementById('reswrap');
const elResFill = document.getElementById('resfill');
const elResText = document.getElementById('restext');
const elResWhy = document.getElementById('reswhy');
const gridStructures = document.getElementById('grid-structures');
const gridUnits = document.getElementById('grid-units');
const elSelInfo = document.getElementById('selinfo');
const elActions = document.getElementById('actions');
const elSupply = document.getElementById('supply');
const elClock = document.getElementById('clock');

// ---------- faction select + main loop ----------

let selectedSize = 'medium';
let selectedOpponents = 1;
// Which faction each AI seat plays. null = let the seed decide, which is
// what it always did. Index is the AI slot, not the owner id.
let selectedAiFactions = [];
let selectedSetting = 'random';
let superweaponsOn = true; // faction-select toggle: superweapon structures enabled?

(function buildSetupControls() {
  const sizeWrap = document.getElementById('size-buttons');
  const oppWrap = document.getElementById('opp-buttons');
  const settingWrap = document.getElementById('setting-buttons');
  const superWrap = document.getElementById('super-buttons');
  const sizeBtns = {};
  const settingBtns = {};
  const superBtns = {};

  // superweapons on/off: toggles whether each faction's tech-gated doomsday
  // structure is available at all (to you and the AIs) this match
  for (const [key, label] of [['on', 'On'], ['off', 'Off']]) {
    const b = document.createElement('button');
    b.className = 'opt-btn' + ((key === 'on') === superweaponsOn ? ' sel' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      superweaponsOn = key === 'on';
      for (const [k2, b2] of Object.entries(superBtns)) b2.classList.toggle('sel', (k2 === 'on') === superweaponsOn);
    });
    superBtns[key] = b;
    superWrap.appendChild(b);
  }

  for (const [key, label] of [['random', 'Random'], ...Object.entries(MAP_SETTINGS).map(([k, s]) => [k, s.name])]) {
    const b = document.createElement('button');
    b.className = 'opt-btn' + (key === selectedSetting ? ' sel' : '');
    b.textContent = label;
    b.addEventListener('click', () => {
      selectedSetting = key;
      for (const [k2, b2] of Object.entries(settingBtns)) b2.classList.toggle('sel', k2 === key);
    });
    settingBtns[key] = b;
    settingWrap.appendChild(b);
  }

  function refresh() {
    const max = MAP_SIZES[selectedSize].maxPlayers - 1;
    // Zero AI opponents only makes sense when there is someone else to fight:
    // a lobby with two or more people in it. On your own, one is the floor.
    const humans = (typeof Net !== 'undefined' && Net.connected) ? Net.players.length : 1;
    const min = humans >= 2 ? 0 : 1;
    selectedOpponents = clamp(selectedOpponents, min, max);
    for (const [key, btn] of Object.entries(sizeBtns)) {
      btn.classList.toggle('sel', key === selectedSize);
    }
    oppWrap.innerHTML = '';
    for (let n = min; n <= max; n++) {
      const b = document.createElement('button');
      b.className = 'opt-btn' + (n === selectedOpponents ? ' sel' : '');
      b.textContent = n;
      b.title = n === 0 ? 'No AI — players only' : n + ' AI opponent' + (n > 1 ? 's' : '');
      b.addEventListener('click', () => { selectedOpponents = n; refresh(); });
      oppWrap.appendChild(b);
    }
    // one faction picker per AI seat. Cycles Random -> each faction -> Random,
    // so it stays a single button per slot however many factions there are.
    const aiWrap = document.getElementById('ai-faction-buttons');
    const aiRow = document.getElementById('ai-faction-row');
    if (aiWrap && aiRow) {
      aiRow.style.display = selectedOpponents > 0 ? '' : 'none';
      selectedAiFactions.length = selectedOpponents;
      aiWrap.innerHTML = '';
      const keys = Object.keys(FACTIONS);
      for (let i = 0; i < selectedOpponents; i++) {
        const cur = selectedAiFactions[i] || null;
        const btn = document.createElement('button');
        btn.className = 'opt-btn' + (cur ? ' sel' : '');
        btn.textContent = cur ? `${FACTIONS[cur].emoji} ${FACTIONS[cur].name}` : '🎲 Random';
        btn.title = cur ? FACTIONS[cur].desc : 'Picked from the match seed, avoiding your own family';
        btn.addEventListener('click', () => {
          const at = cur ? keys.indexOf(cur) : -1;
          selectedAiFactions[i] = at + 1 >= keys.length ? null : keys[at + 1];
          refresh();
        });
        aiWrap.appendChild(btn);
      }
    }
  }
  // the lobby calls this when the player list changes, so the "0" option
  // appears the moment a second person joins
  window.refreshSetupControls = refresh;

  for (const [key, s] of Object.entries(MAP_SIZES)) {
    const b = document.createElement('button');
    b.className = 'opt-btn';
    b.textContent = s.name;
    b.addEventListener('click', () => { selectedSize = key; refresh(); });
    sizeBtns[key] = b;
    sizeWrap.appendChild(b);
  }
  refresh();
})();

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
      // In a lobby the faction buttons choose your side rather than starting
      // the match — the host starts it, once, for everyone at the same seed.
      btn.addEventListener('click', () => {
        if (typeof Net !== 'undefined' && Net.connected) Net.pickFaction(key);
        else startGame(key, undefined, { aiFactions: selectedAiFactions.slice() });
      });
      col.appendChild(btn);
    }
    wrap.appendChild(col);
  }
})();

let lastTime = performance.now();
let panelTimer = 0;
let wasLowPower = false;

requestAnimationFrame(rafLoop);
