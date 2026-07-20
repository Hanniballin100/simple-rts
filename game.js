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
let OWNERS = [PLAYER, ENEMY]; // owner 0 is the human; startGame appends extra AIs
const state = {
  factions: {},     // owner -> faction key
  minerals: {},     // owner -> bank
  construction: {}, // owner -> {type,t,duration,ready,announced} | null
  units: [],
  buildings: [],
  patches: [],
  projectiles: [], // lobbed rocks, dropped bombs
  zones: [],       // temporary area effects: rain, storm, fire, toxin
  sig: {},         // owner -> {cd, timer, used}
  eco: {},         // owner -> structure-income tick timer
  infiltrator: {}, // owner -> reptilian sleeper worker id
  time: 0,
  over: false,
};

const cam = { x: 0, y: 0, zoom: 1 };
const keys = {};
const mouse = { x: 0, y: 0, sel: null };
let selection = [];
let placing = null;          // building type being placed
let attackMoveArmed = false; // 'A' pressed, next left-click is attack-move
let abilityTargeting = null; // 'zone' | 'unit' while a faction power waits for a click
let wallDrag = null;         // { x0, y0 } while dragging out a wall stretch (RA2-style)
let plantArmed = false;      // 'E' pressed, next left-click sends infantry to plant an IED
const WALL_STEP = 26;        // world spacing between segments of a dragged wall line
let superTargeting = null;   // building id of a charged superweapon awaiting its target
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
const hostilesOf = owner => OWNERS.filter(o => o !== owner); // free-for-all
const randomHostile = owner => {
  const hs = hostilesOf(owner);
  return hs[Math.floor(Math.random() * hs.length)];
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const hitsAir = stats => stats.targets === 'air' || stats.targets === 'both';

// ---------- audio state (functions below) ----------

let muted = false;
let audioCtx = null;
const evaLast = {};
let sfxCount = 0, sfxWindow = 0;

// ---------- fog of war state (sized by initFog once the map exists) ----------

let FW = 0, FH = 0;
let vis = new Uint8Array(0); // 0 unexplored, 1 explored, 2 visible
let fogImg = null;           // ImageData reused every frame (fillRect per tile is too slow on big maps)
const fogCanvas = document.createElement('canvas');
const fogCtx = fogCanvas.getContext('2d');

function initFog() {
  FW = Math.round(WORLD_W / FOG_TILE);
  FH = Math.round(WORLD_H / FOG_TILE);
  vis = new Uint8Array(FW * FH);
  fogCanvas.width = FW;
  fogCanvas.height = FH;
  fogImg = fogCtx.createImageData(FW, FH);
}


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

function nearest(from, list, filter) {
  let best = null, bd = Infinity;
  for (const e of list) {
    if (filter && !filter(e)) continue;
    const d = dist(from, e);
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
  return detMemo[owner] || (detMemo[owner] =
    state.units.filter(u => u.owner === owner && u.hp > 0 && !u.garrisoned && UNIT_TYPES[u.type].detector));
}

function isRevealed(e, owner) {
  return detectorsOf(owner).some(d => dist(d, e) <= UNIT_TYPES[d.type].sight);
}

// is entity e hidden from `owner` right now? (covers the reptilian disguise,
// stealth flags, and the burrow stance) — the universal targeting filter
function hiddenFrom(e, owner) {
  if (e.owner === owner) return false;
  if (e.trackedBy && e.trackedBy[owner]) return false; // an implanted tracker pierces everything
  if (e.disguised) return true;
  const stats = e.kind === 'building' ? bstatsOf(e) : UNIT_TYPES[e.type];
  const cloaked = e.burrowed || e.cloaked || // e.cloaked: deep-state hold-still cloak (set in updateUnit)
    (stats.stealth && !(e.exposedUntil > state.time)) ||
    (e.kind === 'unit' && e.transit); // underground in a tunnel: gone entirely
  if (!cloaked) return false;
  if (e.kind === 'unit' && e.transit) return true; // no detector reaches the tunnels
  return !isRevealed(e, owner);
}

function canTarget(stats, target) {
  if (!stats.dmg && !stats.kamikaze) return false; // kamikaze munitions have no gun
  const isAir = target.kind === 'unit' && UNIT_TYPES[target.type].flying;
  const t = stats.targets || 'ground';
  return isAir ? (t === 'air' || t === 'both') : (t === 'ground' || t === 'both');
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

function tileState(x, y) {
  const tx = clamp(Math.floor(x / FOG_TILE), 0, FW - 1);
  const ty = clamp(Math.floor(y / FOG_TILE), 0, FH - 1);
  return vis[ty * FW + tx];
}

// nearest never-seen (vis===0) tile center to a world point — used by the
// scout Explore order. Returns null when the whole map has been revealed.
function nearestUnexplored(wx, wy) {
  let best = null, bestD = Infinity;
  for (let ty = 0; ty < FH; ty++) {
    for (let tx = 0; tx < FW; tx++) {
      if (vis[ty * FW + tx] !== 0) continue;
      const cx = tx * FOG_TILE + FOG_TILE / 2, cy = ty * FOG_TILE + FOG_TILE / 2;
      const d = (cx - wx) ** 2 + (cy - wy) ** 2;
      if (d < bestD) { bestD = d; best = { x: cx, y: cy }; }
    }
  }
  return best;
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
    if (u.owner === PLAYER && u.hp > 0 && !u.garrisoned) markSight(u.x, u.y, UNIT_TYPES[u.type].sight);
    // probe-drone trackers: lasting vision of the tagged unit, wherever it goes
    if (u.owner !== PLAYER && u.hp > 0 && u.trackedBy && u.trackedBy[PLAYER]) markSight(u.x, u.y, 140);
  }
  for (const b of state.buildings) {
    if (b.owner === PLAYER && b.hp > 0) markSight(b.x, b.y, bstatsOf(b).sight);
  }
  // orbital uplink (Globalist Satellite): a finished one reveals the whole map
  if (state.buildings.some(b => b.owner === PLAYER && b.hp > 0 && b.done && bstatsOf(b).revealMap)) {
    vis.fill(2);
  }
}

function visibleToPlayer(e) {
  if (e.owner === PLAYER) return true;
  if (hiddenFrom(e, PLAYER)) return false; // stealthed/burrowed and undetected
  const t = tileState(e.x, e.y);
  return e.kind === 'building' ? t >= 1 : t === 2;
}

// is this entity currently running silent? (drawn ghosted for its owner,
// and for enemies whose detector has it pinned)
function isCloaked(e) {
  const stats = e.kind === 'building' ? bstatsOf(e) : UNIT_TYPES[e.type];
  return !!(e.burrowed || e.cloaked || (stats.stealth && !(e.exposedUntil > state.time)));
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
  return b;
}

function makePatch(x, y, amount = 900) {
  state.patches.push({ id: nextId++, kind: 'patch', x, y, amount });
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
  }

  // 3-patch cluster at every generated mineral spot
  for (const spot of map.patchSpots) {
    for (let i = 0; i < 3; i++) {
      makePatch(spot.x + (i - 1) * 42, spot.y + (i % 2) * 34, spot.amount);
    }
  }

  // neutral settlements and derricks — garrison infantry to claim them
  for (const n of map.neutrals) makeBuilding(NEUTRAL, n.type, n.x, n.y);

  // faction setup powers
  for (const owner of OWNERS) {
    if (state.factions[owner] === 'resistance') {
      // sleeper cells: hidden observation camps scattered around the map
      for (let i = 0, tries = 0; i < 3 && tries < 60; tries++) {
        const sx = 120 + Math.random() * (WORLD_W - 240);
        const sy = 120 + Math.random() * (WORLD_H - 240);
        if (map.starts.some(st => dist(st, { x: sx, y: sy }) < 350)) continue;
        makeBuilding(owner, 'sleepercell', sx, sy);
        i++;
      }
    }
    if (state.factions[owner] === 'reptilian') {
      // one random enemy worker was always ours (skips worker-less factions)
      const pool = state.units.filter(u => u.owner !== owner && UNIT_TYPES[u.type].role === 'worker');
      if (pool.length) state.infiltrator[owner] = pool[Math.floor(Math.random() * pool.length)].id;
    }
  }

  centerCameraOnHome();
  updateFog();
}

function centerCameraOnHome() {
  const hq = state.buildings.find(b => b.owner === PLAYER && b.type === 'hq');
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

function startConstruction(owner, type) {
  if (state.construction[owner]) return false;
  if (atStructCap(owner, type)) return false;
  const rq = bstats(owner, type).req;
  if (rq && !hasStruct(owner, rq)) return false;
  const cost = bstats(owner, type).cost;
  if (state.minerals[owner] < cost) return false;
  state.minerals[owner] -= cost;
  state.construction[owner] = { type, t: 0, duration: bstats(owner, type).buildTime, ready: false, announced: false };
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
      const gap = (t.wallKind && bstatsOf(b).wallKind) ? -2 : 32;
      return Math.abs(b.x - x) < (b.w + t.w) / 2 + gap && Math.abs(b.y - y) < (b.h + t.h) / 2 + gap;
    })
    || state.patches.some(p => p.amount > 0 && dist(p, { x, y }) < t.w / 2 + 30)
    || TERRAIN.some(o => dist(o, { x, y }) < o.r + Math.max(t.w, t.h) / 2 + 6);
}

function withinBuildRadius(owner, x, y) {
  return state.buildings.some(b => b.owner === owner && b.hp > 0 && b.done &&
    (b.type === 'hq' || b.type === 'powerplant') && dist(b, { x, y }) <= BUILD_RADIUS);
}

function tryPlace(owner, x, y) {
  // instant field structures (walls, gates, mines): pay per placement, never
  // touch the build queue. Player-only (driven by the `placing` cursor).
  if (owner === PLAYER && placing && bstats(owner, placing).instant) {
    const type = placing, st = bstats(owner, type);
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
function commitWallLine(x0, y0, x1, y1) {
  const ex = Math.round(x1 / WALL_STEP) * WALL_STEP, ey = Math.round(y1 / WALL_STEP) * WALL_STEP;
  const dx = ex - x0, dy = ey - y0;
  const n = Math.max(0, Math.round(Math.hypot(dx, dy) / WALL_STEP));
  const st = bstats(PLAYER, 'wall');
  let placed = 0;
  for (let i = 0; i <= n; i++) {
    const x = x0 + dx * (i / (n || 1)), y = y0 + dy * (i / (n || 1));
    if (state.minerals[PLAYER] < st.cost || atStructCap(PLAYER, 'wall')) break;
    if (placementBlocked(PLAYER, 'wall', x, y) || !withinBuildRadius(PLAYER, x, y)) continue;
    state.minerals[PLAYER] -= st.cost;
    makeBuilding(PLAYER, 'wall', x, y);
    placed++;
  }
  if (placed) sfx('click');
  // keep the wall tool armed for another stretch unless we've run dry or capped
  if (state.minerals[PLAYER] < st.cost || atStructCap(PLAYER, 'wall')) placing = null;
  refreshPanel(); refreshSidebar();
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

// ---------- superweapons ----------
// each faction's tech-gated doomsday structure charges while it stands, then
// fires one of the SUPER_DEFS effects at a targeted point and resets.

function superReady(b) {
  return bstatsOf(b).superweapon && b.done && (b.charge || 0) >= superChargeOf(b);
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
      const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * scatterR;
      const px = clamp(x + Math.cos(a) * rr, 10, WORLD_W - 10);
      const py = clamp(y + Math.sin(a) * rr, 10, WORLD_H - 10);
      state.projectiles.push({ kind: 'superrocket', x: px, y: py, tx: px, ty: py, owner, t: 0,
        dur: 1.5 + Math.random() * 1.5, hgt: 0, stats: { dmg: 95, splash: 54, bldgBonus: 1.5 } });
    }
    if (seen) sfx('boom');
  } else if (kind === 'orbital') {
    // rods from god: instant, pinpoint, brutal
    splashDamage(x, y, 90, 380, owner, { bldgBonus: 1.4 }, true);
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
    if (owner === PLAYER) eva('Blackout deployed');
  } else if (kind === 'barrage') {
    // loitering-munition swarm: a cloud of drones circles in, then a rolling
    // series of small strikes rains across the zone (weaker, on brand)
    state.zones.push({ x, y, r: 170, until: state.time + 8, caster: owner, kind: 'barrage',
      tick: 0.2, dmg: 55 });
    if (owner === PLAYER) eva('Munitions inbound');
  } else if (kind === 'ray') {
    // Pyramid Death Ray: a sustained beam grinds the zone to nothing
    state.zones.push({ x, y, r: 120, until: state.time + 5, caster: owner, kind: 'ray',
      tick: 0.25, dmg: 70, srcId: b.id });
    if (owner === PLAYER) eva('Death ray firing');
  } else if (kind === 'coup') {
    // Bloodline Coup: enemy units in the zone defect for 45s, then revert
    for (const u of state.units) {
      if (u.owner === owner || u.hp <= 0 || u.garrisoned || u.type === 'phantom') continue;
      if (UNIT_TYPES[u.type].role === 'worker') continue; // only fighters turn
      if (dist(u, { x, y }) <= 200) {
        u.coupOrig = u.coupOrig !== undefined ? u.coupOrig : u.owner;
        u.coupRevert = state.time + 45;
        u.owner = owner;
        u.disguised = false;
        u.order = { type: 'idle' };
        Particles.pulse(u.x, u.y, 20, [201, 167, 255]);
      }
    }
    state.zones.push({ x, y, r: 200, until: state.time + 1.5, caster: owner, kind: 'coup' });
    if (owner === PLAYER) eva('The bloodline commands them');
  }
  if (owner === PLAYER && kind !== 'emp' && kind !== 'barrage' && kind !== 'ray' && kind !== 'coup') {
    eva('Superweapon fired');
  }
}

// a building sits dark under EMP: no weapons, no production, no power output
function isOffline(b) {
  return b.empUntil > state.time;
}

function castWeather(owner, x, y) {
  state.zones.push({ x, y, r: 150, until: state.time + 15, caster: owner, kind: 'rain' });
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
  const myHq = state.buildings.find(b => b.owner === owner && b.type === 'hq' && b.hp > 0);
  const hq = nearest(myHq || { x: WORLD_W / 2, y: WORLD_H / 2 }, state.buildings,
    b => b.owner !== owner && b.type === 'hq' && b.hp > 0);
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
  const wasPlayers = u.owner === PLAYER;
  u.owner = owner;
  u.order = { type: 'idle' };
  if (owner === PLAYER) eva('The infiltrator answers the call');
  else if (wasPlayers) eva('One of our workers was never ours');
  return true;
}

function documentaryDrop(owner) {
  const pool = state.units.filter(u => u.owner !== owner && u.hp > 0 && !u.garrisoned && u.type !== 'phantom');
  if (!pool.length) return;
  const u = pool[Math.floor(Math.random() * pool.length)];
  const wasPlayers = u.owner === PLAYER;
  u.owner = owner;
  u.disguised = false;
  u.order = { type: 'idle' };
  u.carrying = 0;
  if (owner === PLAYER) eva('They have seen the truth');
  else if (wasPlayers) eva('We have lost someone to their propaganda');
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
  const ef = facOf(randomHostile(owner));
  const pool = [ef.infantry, ef.aa, ef.extras[0]];
  const type = pool[Math.floor(Math.random() * pool.length)];
  const u = makeUnit(owner, type, bar.x, bar.y + bar.h / 2 + 22);
  u.disguised = false; // moles fight openly for you
  if (owner === PLAYER) eva('A mole has reported for duty');
}

function updateAbilities(dt) {
  state.zones = state.zones.filter(z => z.until > state.time);
  for (const owner of OWNERS) {
    // structure income: zero-point cores etc. pay out every 10 seconds
    state.eco[owner] += dt;
    if (state.eco[owner] >= 10) {
      state.eco[owner] -= 10;
      let income = 0;
      for (const b of state.buildings) {
        if (b.owner === owner && b.hp > 0 && b.done) income += bstatsOf(b).income || 0;
      }
      if (income) state.minerals[owner] += income;
    }
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
    // AIs cast their manual powers on simple rules
    if (owner !== PLAYER) {
      if (fkey === 'deep' && sig.cd <= 0) castGaslight(owner);
      if (fkey === 'reptilian' && !sig.used && ais[owner].time > 240) castRevealInfiltrator(owner);
    }
  }
}

// hollow-earth tunnel network: which structures act as entrances, and how
// fast units travel underground (world px/s — quicker than walking, not free)
const TUNNEL_NODES = ['hq', 'powerplant', 'tunnelentrance'];
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
function toggleBurrowSelection() {
  let any = false;
  for (const u of selection) {
    if (u.kind !== 'unit' || u.owner !== PLAYER || u.hp <= 0 || u.transit) continue;
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
  if (any) { sfx('click'); refreshPanel(); }
}

function exploreSelection() {
  let any = false;
  for (const u of selection) {
    if (u.kind !== 'unit' || u.owner !== PLAYER || u.hp <= 0) continue;
    if (UNIT_TYPES[u.type].role !== 'scout') continue;
    u.order = { type: 'explore' };
    any = true;
  }
  if (any) { sfx('click'); if (selection.length) eva('Scouting'); }
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
  // rain/storm zones slow ground units; a tractor beam slows anything it holds
  if (!t.flying) {
    for (const z of state.zones) {
      if ((z.kind === 'rain' || z.kind === 'storm') && z.caster !== u.owner && dist(z, u) <= z.r) { speed *= 0.6; break; }
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
        if (b.hp > 0 && b.id !== ignoreId && blocksUnit(b, u.owner) &&
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

// circle a point (combat air patrol / gunship pylon turn). The plane chases a
// lead point on the ring; turn-rate lag makes the real orbit ~1.5x the chased
// ring, so aim inside to make the flown circle come out near `radius`
function flyOrbit(u, cx, cy, dt, radius = 70) {
  const ang = Math.atan2(u.y - cy, u.x - cx) + 0.85;
  const r2 = radius * 0.65;
  flyToward(u, cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2, dt, 0);
}

function dealDamage(attacker, target, dmg, stats) {
  // grey superior metallurgy: buildings ignore anti-building bonuses
  if (target.kind === 'building' && stats.bldgBonus && state.factions[target.owner] !== 'grey') {
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
  target.hp -= dmg;
  if (target.owner === PLAYER) {
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
  if (kind === 'firework') p.col = FIREWORK_COLORS[Math.floor(Math.random() * FIREWORK_COLORS.length)];
  state.projectiles.push(p);
}

function updateProjectiles(dt) {
  for (const p of state.projectiles) {
    if (p.kind === 'missile') {
      // homing: track the target until impact or fuel runs out
      p.life -= dt;
      const tgt = state.units.find(u => u.id === p.targetId && u.hp > 0 && !u.garrisoned);
      if (!tgt || p.life <= 0) {
        p.done = true;
        Particles.boom(p.x, p.y, 0.35);
        continue;
      }
      p.angle = Math.atan2(tgt.y - p.y, tgt.x - p.x);
      const step = p.speed * dt;
      if (dist(p, tgt) <= step + UNIT_TYPES[tgt.type].r) {
        p.done = true;
        dealDamage(null, tgt, p.stats.dmg, p.stats);
        Particles.boom(tgt.x, tgt.y, 0.5);
        if (tileState(tgt.x, tgt.y) === 2) sfx('boom');
      } else {
        p.x += Math.cos(p.angle) * step;
        p.y += Math.sin(p.angle) * step;
        p.trail = (p.trail || 0) - dt;
        if (p.trail <= 0) { p.trail = 0.05; Particles.smoke(p.x, p.y, 1.6, FLY_H); }
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
      if (p.trail <= 0) { p.trail = 0.03; Particles.spawn({ kind: 'spark', x: p.x, y: p.y, z: p.hgt || 0, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, drag: 3, life: 0.3, col: p.col }); }
    }
    if (p.t >= p.dur) {
      p.done = true;
      const s = p.stats;
      splashDamage(p.tx, p.ty, s.splash || 36, s.dmg, p.owner, s);
      if (p.kind === 'firework') { Particles.pulse(p.tx, p.ty, 34, p.col); for (let i = 0; i < 10; i++) { const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 90; Particles.spawn({ kind: 'spark', x: p.tx, y: p.ty, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, drag: 3, life: 0.4 + Math.random() * 0.3, col: p.col }); } }
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
  state.projectiles = state.projectiles.filter(p => !p.done);
}

function updateZones(dt) {
  for (const z of state.zones) {
    if (z.kind === 'storm') {
      z.tick = (z.tick || 0.1) - dt;
      if (z.tick <= 0) {
        z.tick = 0.55;
        const a = Math.random() * Math.PI * 2, rad = Math.random() * z.r;
        const bx = z.x + Math.cos(a) * rad, by = z.y + Math.sin(a) * rad;
        Particles.bolt(bx + 8, by - 6, bx, by, [255, 245, 180], 55); // strike from the sky
        splashDamage(bx, by, 24, z.dmg || 15, z.caster, {}, true); // the storm doesn't care what flies
        if (tileState(bx, by) === 2) sfx('boom');
      }
    } else if (z.kind === 'fire' || z.kind === 'toxin') {
      z.tick = (z.tick || 0) - dt;
      if (z.tick <= 0) {
        z.tick = 0.4;
        for (const u of state.units) {
          if (u.owner === z.caster || u.hp <= 0 || u.garrisoned || u.burrowed || UNIT_TYPES[u.type].flying) continue;
          if (dist(u, z) <= z.r + UNIT_TYPES[u.type].r) u.hp -= (z.dps || 5) * 0.4;
        }
      }
    } else if (z.kind === 'barrage') {
      // loitering munitions: a small blast lands somewhere in the zone each tick
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.35;
        const a = Math.random() * Math.PI * 2, rad = Math.sqrt(Math.random()) * z.r;
        const bx = z.x + Math.cos(a) * rad, by = z.y + Math.sin(a) * rad;
        splashDamage(bx, by, 40, z.dmg, z.caster, { bldgBonus: 1.2 });
        Particles.boom(bx, by, 0.8);
        if (tileState(bx, by) === 2) sfx('boom');
      }
    } else if (z.kind === 'ray') {
      // death ray: everything caught in the beam takes heavy sustained damage
      z.tick -= dt;
      if (z.tick <= 0) {
        z.tick = 0.25;
        splashDamage(z.x, z.y, z.r, z.dmg, z.caster, { bldgBonus: 1.5 }, true);
        Particles.boom(z.x + (Math.random() - 0.5) * z.r, z.y + (Math.random() - 0.5) * z.r, 0.7);
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
  if (d > range) {
    moveToward(u, target.x, target.y, dt, range - 4, target.kind === 'building' ? target.id : null);
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
  if (t.weapon === 'gunship') {
    // pylon turn: circle the target and pour sideways fire into it
    flyOrbit(u, target.x, target.y, dt, t.orbitR || 140);
    if (d <= range) fireAt(u, target, t);
  } else if (t.weapon === 'bomb') {
    // bombing run: fly straight across the target, release on overflight
    flyToward(u, target.x, target.y, dt, 0);
    if (d <= range) fireAt(u, target, t);
  } else {
    // strafing pass: shoot while lined up, overshoot, bank around, repeat
    flyToward(u, target.x, target.y, dt, 0);
    const aim = Math.abs(((Math.atan2(target.y - u.y, target.x - u.x) - u.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (d <= range && aim < 0.5) fireAt(u, target, t);
  }
}

function fireAt(u, target, t) {
  if (u.burrowed) return; // no firing ports underground
  if (u.cooldown <= 0) {
    const isAir = target.kind === 'unit' && UNIT_TYPES[target.type].flying;
    let dmg = (!isAir && t.dmgVsGround !== undefined) ? t.dmgVsGround : t.dmg;
    u.disguised = false; // skin suit drops the moment they open fire
    if (t.stealth) u.exposedUntil = state.time + 2.5; // muzzle flash gives it away
    if (t.cloakStill) { if (u.cloaked) u.ambush = true; u.exposedUntil = state.time + 1.6; }
    if (u.ambush) { dmg *= 2; delete u.ambush; } // surfacing / decloak first-strike bonus
    if (u.buffedUntil > state.time) dmg *= 1.25; // broodmother's blessing
    if (u.weakenedUntil > state.time) dmg *= 0.55; // shouted down by a Megaphone Prophet
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
      if (t.scatter) { const sa = Math.random() * Math.PI * 2, sr = Math.random() * t.scatter; ptx += Math.cos(sa) * sr; pty += Math.sin(sa) * sr; }
      spawnProjectile(wkind === 'bomb' ? 'bomb' : (t.projectile || 'rock'),
        u.x, u.y, ptx, pty, u.owner, t);
      if (visible) sfx('shot');
    } else if (wkind === 'storm') {
      state.zones.push({ x: target.x, y: target.y, r: 60, until: state.time + 3, caster: u.owner, kind: 'storm', dmg: t.dmg });
      if (visible) sfx('laser');
    } else if (wkind === 'gunship') {
      // broadside battery: a stream of cannon tracers with a howitzer shell
      // punctuating every shellEvery-th round
      u.burst = (u.burst || 0) + 1;
      if (u.burst % (t.shellEvery || 8) === 0) {
        const ja = Math.random() * Math.PI * 2, jr = Math.random() * 14;
        spawnProjectile('shell', u.x, u.y,
          target.x + Math.cos(ja) * jr, target.y + Math.sin(ja) * jr, u.owner,
          { dmg: t.shellDmg || 40, splash: t.shellSplash || 30, bldgBonus: 1.4 });
        if (visible) sfx('shot');
      } else {
        // the cannons rake up to multiTarget enemies inside the orbit at once
        const extras = (t.multiTarget || 1) > 1
          ? enemiesOf(u.owner).filter(e => e !== target && !hiddenFrom(e, u.owner) && canTarget(t, e) &&
              dist(u, e) <= t.atkRange + entityRadius(e))
            .sort((x, y) => dist(u, x) - dist(u, y)).slice(0, t.multiTarget - 1)
          : [];
        const uz = unitAlt(u); // land dreadnoughts fire from the deck (alt 0)
        for (const tgt of [target, ...extras]) {
          dealDamage(u, tgt, dmg, t);
          const tz = tgt.kind === 'unit' ? unitAlt(tgt) : 0;
          Particles.shot(u.x + Math.cos(a + 1.5) * (t.r - 3), u.y + Math.sin(a + 1.5) * (t.r - 3),
            tgt.x, tgt.y, WEAPON_STYLE[state.factions[u.owner]], uz, tz);
        }
        if (visible && u.burst % 3 === 0) sfx('shot');
      }
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
        if (target.hp > 0 && UNIT_TYPES[target.type].hp <= (t.abductMax || 320) && u.abductHold >= (t.abductTime || 3)) {
          target.hp = 0; target.abducted = true;
          state.minerals[u.owner] = (state.minerals[u.owner] || 0) + (t.abductBounty || 20);
          Particles.pulse(target.x, target.y, 45, [190, 140, 255]);
          u.abductId = null; u.abductHold = 0;
          if (u.owner === PLAYER) eva('Specimen acquired');
          else if (target.owner === PLAYER) eva('They took one of ours');
        }
      }
      if (visible) sfx('laser');
      if (target.hp <= 0 && u.order.type === 'attack') nextTargetOrIdle(u, t);
    } else {
      dealDamage(u, target, dmg, t);
      if (t.jams && isAir) target.slowUntil = state.time + 0.6; // scrambled avionics
      if (t.petrify && target.kind === 'unit') target.petrifiedUntil = state.time + t.petrify; // the gaze
      if (t.leech) u.hp = Math.min(u.maxHp, u.hp + dmg * 0.8); // vivisection pays
      // turreted vehicles fire from the barrel tip up on the turret; everyone
      // else from the sprite edge at body height, so tracer meets muzzle flash
      const turreted = Art.hasIsoTurret(u.type);
      const muzR = (t.r + 2) * (turreted ? 1.4 : 1);
      const muzZ = unitAlt(u) + (turreted ? 8 : 0);
      Particles.shot(u.x + Math.cos(a) * muzR, u.y + Math.sin(a) * muzR,
        target.x, target.y, WEAPON_STYLE[state.factions[u.owner]],
        muzZ, target.kind === 'unit' ? unitAlt(target) : 0);
      if (wkind === 'spray' && t.groundEffect && !isAir) {
        state.zones.push({
          x: target.x, y: target.y, r: t.groundEffect.r, until: state.time + t.groundEffect.dur,
          caster: u.owner, kind: t.groundEffect.kind, dps: t.groundEffect.dps,
        });
      }
      if (visible) sfx(state.factions[u.owner] === 'glob' ? 'laser' : 'shot');
      if (target.hp <= 0 && u.order.type === 'attack') nextTargetOrIdle(u, t);
    }
  }
}

// on a kill, flying attackers swing straight onto the next nearest enemy
// instead of breaking off — pad craft keep hunting until the ammo runs dry
// (the empty-magazine check in updateUnit sends them home). Ground units
// still drop to idle and re-acquire by sight.
function nextTargetOrIdle(u, t) {
  if (t.flying && !(t.maxAmmo && u.ammo <= 0)) {
    const foe = nearest(u, enemiesOf(u.owner), e =>
      !hiddenFrom(e, u.owner) && canTarget(t, e) &&
      dist(u, e) <= Math.max(t.sight * 1.6, 450) && dist(u, e) >= (t.minRange || 0));
    if (foe) { orderAttack(u, foe); return; }
  }
  u.order = { type: 'idle' };
}

function autoAcquire(u, dt) {
  const t = UNIT_TYPES[u.type];
  if (t.maxAmmo && u.ammo <= 0) return; // nothing left to shoot with
  // stagger the full-map target sweeps — every idle unit scanning every
  // frame was a big slice of late-game frame time
  u.scanT = (u.scanT === undefined ? (u.id % 10) * 0.03 : u.scanT) - dt;
  if (u.scanT > 0) return;
  u.scanT = 0.3;
  const foe = nearest(u, enemiesOf(u.owner), e =>
    !hiddenFrom(e, u.owner) && canTarget(t, e) && dist(u, e) <= t.sight && dist(u, e) >= (t.minRange || 0));
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

function depositTarget(u) {
  return nearest(u, state.buildings, b => b.owner === u.owner && b.type === 'hq' && b.hp > 0);
}

// distance from a unit to a building's actual footprint rectangle — radial
// distance to center says a rig hugging the long wall of an HQ is "far away"
function rectDist(u, b) {
  const dx = Math.max(0, Math.abs(u.x - b.x) - b.w / 2);
  const dy = Math.max(0, Math.abs(u.y - b.y) - b.h / 2);
  return Math.hypot(dx, dy);
}

// ---------- airfield slots (RA2-style: 4 aircraft stationed per pad) ----------

// stationed-aircraft capacity of a pad-host building (airpads hold 4, the
// AC-130's dedicated hangar holds 1)
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

function updateUnit(u, dt) {
  if (u.garrisoned) return; // stationed inside a structure; it fights for us
  u.cooldown = Math.max(0, u.cooldown - dt);
  const o = u.order;
  const stats = UNIT_TYPES[u.type];

  // stationed aircraft lift off the moment they get a real order
  if (u.landed && o.type !== 'idle' && o.type !== 'rearm') u.landed = false;

  // petrified: a statue until the stone wears off
  if (u.petrifiedUntil > state.time) return;

  // deep-state passive: units run silent when they hold still (and aren't
  // still lit up from a recent shot). Moving or firing drops the cloak; a
  // detector still sees them. A first shot from cloak lands as an ambush.
  if (stats.cloakStill) {
    u.cloaked = !u.transit && !(u.exposedUntil > state.time) &&
      (state.time - (u.movedT || -99) > (stats.cloakDelay || 1.5));
  }

  // turreted vehicles: the gun slews toward its aim point (set in tryAttack
  // while a target is engaged) and drifts back to the hull heading otherwise,
  // so the chassis can steer freely while the weapon stays on target
  if (Art.hasIsoTurret(u.type)) {
    if (u.turret === undefined) u.turret = u.facing || 0;
    const desired = (u.aimT > state.time - 0.4 && u.aimAngle !== undefined) ? u.aimAngle : (u.facing || 0);
    const d = ((desired - u.turret + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    u.turret += clamp(d, -8 * dt, 8 * dt);
  }

  // burrowed: a blind slow crawl — combat orders degrade to movement, and
  // fireAt below refuses to shoot until the unit surfaces
  if (u.burrowed && (o.type === 'attack' || o.type === 'attackmove')) {
    const tgt = o.targetId ? findEntity(o.targetId) : o;
    u.order = tgt ? { type: 'move', x: tgt.x, y: tgt.y } : { type: 'idle' };
  }

  // reptilian brood: the mother keeps a bound swarm of hatchlings — spawned
  // once, then topped back up as they die. The swarm is her weapon.
  if (stats.brood && !u.transit) {
    if (!u.broodInit) {
      u.broodInit = true;
      for (let i = 0; i < stats.brood.count; i++) {
        const h = makeUnit(u.owner, 'hatchling', u.x + (Math.random() - 0.5) * 30, u.y + 12 + i * 3);
        h.broodOf = u.id;
      }
    } else {
      const alive = state.units.reduce((n, h) => n + (h.broodOf === u.id && h.hp > 0 ? 1 : 0), 0);
      u.broodT = (u.broodT || 0) + dt;
      if (alive < stats.brood.count && u.broodT >= stats.brood.regen) {
        u.broodT = 0;
        makeUnit(u.owner, 'hatchling', u.x + (Math.random() - 0.5) * 24, u.y + 14).broodOf = u.id;
      }
    }
  }
  // a bound hatchling shadows its mother and dogpiles whatever she attacks;
  // cut loose by her death it scatters and soon expires (no queen, no swarm)
  if (u.broodOf) {
    const mom = state.units.find(m => m.id === u.broodOf && m.hp > 0);
    if (!mom) {
      if (u.expires === undefined) u.expires = state.time + 6;
    } else {
      const mo = mom.order || { type: 'idle' };
      if (mo.type === 'attack' && mo.targetId && findEntity(mo.targetId)) {
        u.order = { type: 'attack', targetId: mo.targetId };
      } else if (dist(u, mom) > 80) {
        u.order = { type: 'move', x: mom.x, y: mom.y };
      } else if (u.order.type === 'move') {
        u.order = { type: 'idle' }; // arrived near her: snap at whatever's close
      }
    }
  }

  // broodmother: hatch free swarms on a timer, embolden nearby infantry
  if (stats.spawns && !u.transit) {
    u.spawnT = (u.spawnT || 0) + dt;
    if (u.spawnT >= stats.spawns.every) {
      u.spawnT = 0;
      for (let i = 0; i < stats.spawns.count; i++) {
        const h = makeUnit(u.owner, stats.spawns.type, u.x + (i - 0.5) * 20, u.y + 16);
        h.expires = state.time + stats.spawns.expires;
      }
      if (u.owner === PLAYER) sfx('click');
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
        victim.owner = u.owner; victim.disguised = false; victim.carrying = 0; victim.order = { type: 'idle' };
        if (tileState(victim.x, victim.y) === 2) Particles.pulse(victim.x, victim.y, 30, [255, 230, 140]);
      }
    }
  }
  // Barrage Balloon: its tether cables shred enemy aircraft that stray near
  if (stats.aaAura) {
    u.aaT = (u.aaT || 0) - dt;
    if (u.aaT <= 0) {
      u.aaT = 0.25;
      for (const e of state.units) {
        if (e.owner === u.owner || e.owner === NEUTRAL || e.hp <= 0) continue;
        if (!UNIT_TYPES[e.type].flying) continue;
        if (dist(e, u) <= stats.aaAura.r) dealDamage(u, e, stats.aaAura.dps * 0.25, {});
      }
    }
  }

  // stuck watchdog: a unit with somewhere to be that hasn't covered any
  // ground in 2.5s is pinned — usually a crowd wedged on a stale dodge
  // commitment. Forget the steering plan; if that didn't help either, slide
  // the unit out along the least-blocked direction (escalation, rare).
  u.wdT = (u.wdT || 0) + dt;
  if (u.wdT >= 2.5) {
    // only units that actually TRIED to move count as pinned — a mortar
    // holding position to fire is standing still on purpose, not wedged
    if (u.wdWant && o.type !== 'idle' && o.type !== 'loiter' && !u.landed &&
        u.travel - (u.wdTravel || 0) < 5) {
      delete u.dodge;
      delete u.veer;
      delete u.path; // stale route may be the reason we're pinned — re-plan
      u.wdStrikes = (u.wdStrikes || 0) + 1;
      if (u.wdStrikes >= 2 && !stats.flying) {
        // still pinned after a replan: pick the cardinal direction with the
        // most open ground and shove — breaks base-notch wedges
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
    u.wdTravel = u.travel;
  }

  // out of ammo: break off and return to the airfield (unless already parked —
  // a landed craft must fall through to the idle case, where it reloads)
  if (stats.maxAmmo && u.ammo <= 0 && o.type !== 'rearm' && !u.landed) {
    u.order = { type: 'rearm' };
    return;
  }

  // armed rigs defend themselves: pop off at anything in weapon range without
  // ever dropping the order they're on — mine, haul, and shoot back
  if (stats.role === 'worker' && stats.dmg && o.type !== 'attack' && o.type !== 'tunnel') {
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

  switch (o.type) {
    case 'idle':
      if (stats.pad && u.landed) {
        // parked on the pad: top off ammo, patch the airframe, hold position
        if (u.ammo < stats.maxAmmo) u.ammo = Math.min(stats.maxAmmo, u.ammo + stats.maxAmmo * dt / 4);
        if (u.hp < u.maxHp) u.hp = Math.min(u.maxHp, u.hp + u.maxHp * dt / 40);
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
      if (stats.repair) { repairAcquire(u, dt); break; }
      if (stats.role === 'combat') autoAcquire(u, dt);
      break;

    case 'move':
      if (stats.plane) {
        // fly there, then hold on station — a plane never just stops
        if (flyToward(u, o.x, o.y, dt, 40)) u.order = { type: 'loiter', x: o.x, y: o.y };
      } else if (moveToward(u, o.x, o.y, dt, 6)) u.order = { type: 'idle' };
      break;

    case 'plant':
      // walk to the spot, then bury one IED. Each infantryman can only ever
      // plant a single IED in their life (costs the faction's mine price)
      if (moveToward(u, o.x, o.y, dt, 6)) {
        const st = bstats(u.owner, 'mine');
        if (!u.planted && state.minerals[u.owner] >= st.cost &&
            !placementBlocked(u.owner, 'mine', o.x, o.y)) {
          state.minerals[u.owner] -= st.cost;
          makeBuilding(u.owner, 'mine', o.x, o.y);
          u.planted = true; // spent — this soldier can never plant again
          if (u.owner === PLAYER) sfx('click');
        } else if (u.owner === PLAYER && state.minerals[u.owner] < st.cost) {
          eva('Insufficient funds');
        }
        u.order = { type: 'idle' };
      }
      break;

    case 'loiter': // circling a point (scouting overwatch / stranded plane)
      flyOrbit(u, o.x, o.y, dt, 72);
      if (stats.role === 'combat') autoAcquire(u, dt);
      break;

    case 'explore': {
      // auto-recon: keep heading for the nearest unseen ground; when the map is
      // fully lit, stand down. Re-picks a target once the current one is seen.
      o.reT = (o.reT || 0) - dt;
      if (o.tx === undefined || o.tx === null || tileState(o.tx, o.ty) >= 1 || o.reT <= 0) {
        o.reT = 0.6;
        const spot = nearestUnexplored(u.x, u.y);
        if (!spot) { u.order = { type: 'idle' }; if (u.owner === PLAYER) eva('Area explored'); break; }
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
        foe = nearest(u, enemiesOf(u.owner), e =>
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
        u.mineTimer += dt;
        if (u.mineTimer >= HARVEST_TIME) {
          u.mineTimer = 0;
          const take = Math.min(carry, patch.amount);
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
      // single-plane hangars park their resident dead center
      const [ox, oy] = padCapOf(home) === 1 ? [0, 6] : PAD_SLOT_POS[u.slot % PAD_CAP];
      const px = home.x + ox, py = home.y + oy;
      const arrived = stats.plane ? flyToward(u, px, py, dt, 16, true) : moveToward(u, px, py, dt, 5);
      if (arrived) {
        u.landed = true;
        u.x = px; u.y = py;          // settle square on the pad markings
        u.facing = -Math.PI / 2;     // parked nose-north, RA2 style
        u.order = { type: 'idle' };
      }
      break;
    }

    case 'probe': {
      // probe drone: fly onto the mark, implant the tracker, and that's the
      // last anyone sees of the drone — the tag outlives it
      const tgt = findEntity(o.targetId);
      if (!tgt || tgt.kind !== 'unit' || tgt.hp <= 0 || tgt.garrisoned || tgt.transit) {
        u.order = { type: 'idle' };
        break;
      }
      if (moveToward(u, tgt.x, tgt.y, dt, UNIT_TYPES[tgt.type].r + 6)) {
        tgt.trackedBy = tgt.trackedBy || {};
        tgt.trackedBy[u.owner] = true;
        u.hp = 0;
        Particles.pulse(tgt.x, tgt.y, 30, [125, 255, 214]);
        if (u.owner === PLAYER) eva('Tracker implanted');
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
        const wasPlayers = b.owner === PLAYER;
        b.owner = u.owner;
        b.queue = [];
        b.rally = null;
        b.beamId = null;
        u.hp = 0; // the engineer stays behind to run the place
        if (u.owner === PLAYER) eva('Structure captured');
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
      const slots = (b && b.kind === 'building' && b.hp > 0) ? bstatsOf(b).slots : 0;
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
      // touching any wall of the depot counts — a hauler pressed against the
      // HQ by traffic or neighboring buildings must not be told "not close enough"
      if (moveToward(u, depot.x, depot.y, dt, stop, depot.id) ||
          rectDist(u, depot) <= UNIT_TYPES[u.type].r + 14) {
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

  // separation only within the same layer (ground vs ground, air vs air);
  // aircraft parked on a pad hold their slot, and fixed-wing craft are never
  // shoved — they are always moving anyway. Each unit resolves overlap on
  // alternating frames — half the cost, visually identical
  if (u.landed || stats.plane) return;
  if (((u.id + frameNo) & 1) === 0) return;
  const myFlying = !!stats.flying;
  const sgx = (u.x / SEP_CELL) | 0, sgy = (u.y / SEP_CELL) | 0;
  for (let cx2 = sgx - 1; cx2 <= sgx + 1; cx2++) {
    for (let cy2 = sgy - 1; cy2 <= sgy + 1; cy2++) {
      const cell = sepGrid.get(cx2 * 4096 + cy2);
      if (!cell) continue;
      for (const other of cell) {
        if (other === u || other.hp <= 0 || other.garrisoned) continue;
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
  }
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

function trainUnit(owner, unitType) {
  const ut = UNIT_TYPES[unitType];
  if (ut.req && !hasStruct(owner, ut.req)) return false;
  if (ut.limit && unitCount(owner, unitType) >= ut.limit) return false;
  let trainers = state.buildings.filter(b =>
    b.owner === owner && b.hp > 0 && b.done && b.type === ut.builtAt && b.queue.length < 5);
  if (ut.pad) trainers = trainers.filter(b => padLoad(b) < padCapOf(b)); // needs a free pad slot
  if (!trainers.length) return false;
  if (state.minerals[owner] < ut.cost) return false;
  trainers.sort((a, b) => ut.pad ? padLoad(a) - padLoad(b) : a.queue.length - b.queue.length);
  state.minerals[owner] -= ut.cost;
  trainers[0].queue.push({ type: unitType, t: 0, duration: ut.buildTime });
  return true;
}

function updateBuilding(b, dt) {
  const bt = bstatsOf(b);
  const power = powerOf(b.owner);

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
          if (Math.random() < 0.3) Particles.smoke(u.x + (Math.random() - 0.5) * 14, u.y, 1.5, 6);
        }
      }
    }
  }

  // superweapon: charge while powered, halt when blacked out
  if (bt.superweapon && b.done) {
    if (!power.low && !isOffline(b)) b.charge = Math.min(superChargeOf(b), (b.charge || 0) + dt);
    if (b.owner === PLAYER && !b.announcedReady && superReady(b)) {
      b.announcedReady = true; eva('Superweapon ready');
    }
    if ((b.charge || 0) < superChargeOf(b)) b.announcedReady = false;
  }

  // blacked-out structures do nothing: no fire, no production
  if (isOffline(b)) {
    if (Math.random() < 0.25) Particles.smoke(b.x + (Math.random() - 0.5) * b.w * 0.6, b.y - b.h / 2, 2);
    return;
  }

  // damaged buildings smolder
  if (b.hp < b.maxHp * 0.5 && Math.random() < 0.04) {
    Particles.smoke(b.x + (Math.random() - 0.5) * b.w * 0.7, b.y - b.h / 2, 3);
  }

  // garrisoned civilian structures fight for their occupier
  if (b.garrison && b.garrison.length && b.owner !== NEUTRAL) {
    b.cooldown = Math.max(0, b.cooldown - dt);
    if (b.cooldown <= 0) {
      const squad = b.garrison.map(id => state.units.find(u => u.id === id && u.hp > 0)).filter(Boolean);
      const anyAA = squad.some(u => hitsAir(UNIT_TYPES[u.type]));
      const foe = nearest(b, enemiesOf(b.owner), e => !hiddenFrom(e, b.owner) &&
        dist(b, e) <= GARRISON_RANGE + entityRadius(e) &&
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
  if (bt.dmg && !power.low) {
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
      // patriot battery: launches a visible homing missile
      if (b.cooldown <= 0) {
        const foe = nearest(b, state.units, un => un.owner !== b.owner && un.hp > 0 &&
          !hiddenFrom(un, b.owner) && !un.garrisoned && canTarget(bt, un) &&
          dist(b, un) <= bt.atkRange + entityRadius(un));
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
        // abduction: hold the lock long enough and the victim is hauled
        // up into the tower — removed from play, rendered into minerals
        b.beamHold = (b.beamId === tgt.id) ? (b.beamHold || 0) + dt : 0;
        b.beamId = tgt.id;
        b.turret = Math.atan2(tgt.y - b.y, tgt.x - b.x);
        if (b.cooldown <= 0) {
          b.cooldown = bt.cooldown;
          dealDamage(b, tgt, bt.dmg, bt);
          tgt.slowUntil = state.time + 0.25;
        }
        if (b.beamHold >= 5 && tgt.hp > 0) {
          b.beamHold = 0;
          b.beamId = null;
          tgt.hp = 0;
          state.minerals[b.owner] += 25;
          Particles.pulse(tgt.x, tgt.y, 45, [125, 255, 214]);
          if (b.owner === PLAYER) eva('Specimen acquired');
          else if (tgt.owner === PLAYER) eva('They took one of ours');
        }
      } else {
        b.beamId = null;
        b.beamHold = 0;
      }
    } else if (b.cooldown <= 0) {
      const foe = nearest(b, enemiesOf(b.owner), e => !hiddenFrom(e, b.owner) && canTarget(bt, e) && dist(b, e) <= bt.atkRange + entityRadius(e));
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

  if (b.queue.length === 0) return;
  const job = b.queue[0];
  job.t += dt * (power.low ? 0.5 : 1);
  if (job.t >= job.duration) {
    b.queue.shift();
    const ut = UNIT_TYPES[job.type];
    // RA2-style emerge: ground units are born at the building's front door,
    // facing out, and drive/walk clear of it (with a puff of exhaust); aircraft
    // just appear on the pad. bornT drives the materialize pop in drawUnitIso.
    const u = makeUnit(b.owner, job.type, b.x + Math.sin(nextId) * 12, b.y + b.h / 2 + 8);
    u.bornT = state.time;
    if (bstatsOf(b).padCap) u.homeId = b.id; // aircraft remember their airfield/hangar
    if (ut.pad) u.slot = freeSlot(b);         // claim a parking slot on it
    if (!ut.flying) {
      u.facing = Math.PI / 2; // nose out of the doorway
      if (tileState(b.x, b.y) === 2) { Particles.smoke(b.x - 9, b.y + b.h / 2, 3); Particles.smoke(b.x + 9, b.y + b.h / 2, 3); }
    }
    if (b.owner === PLAYER) eva('Unit ready');
    if (b.rally) {
      const rp = state.patches.find(p => p.amount > 0 && dist(p, b.rally) < 40);
      if (ut.role === 'worker' && rp) orderHarvest(u, rp);
      else if (ut.role === 'combat') orderAttackMove(u, b.rally.x, b.rally.y);
      else orderMove(u, b.rally.x, b.rally.y);
    } else if (ut.role === 'worker') {
      const patch = nearest(u, state.patches, p => p.amount > 0 && dist(u, p) < 600);
      if (patch) orderHarvest(u, patch);
    } else if (!ut.flying) {
      orderMove(u, b.x + Math.sin(nextId) * 24, b.y + b.h / 2 + 48); // clear the doorway
    }
  }
}

function aiPickSpot(owner, type) {
  // search rings around every grid anchor (HQ + power plants) until a spot fits
  const anchors = state.buildings.filter(b => b.owner === owner && b.hp > 0 && b.done &&
    (b.type === 'hq' || b.type === 'powerplant'));
  if (!anchors.length) return null;
  const hq = anchors.find(b => b.type === 'hq') || anchors[0];
  const f = facOf(owner);
  // towers scan toward the map center first; support structures scan away from it
  const centerAngle = Math.atan2(WORLD_H / 2 - hq.y, WORLD_W / 2 - hq.x);
  const startAngle = (type === f.tower || type === f.aaTower) ? centerAngle : centerAngle + Math.PI;
  for (const anchor of anchors) {
    for (const rad of [110, 150, 190, 230, 270, 320, 380]) {
      for (let i = 0; i < 12; i++) {
        const a = startAngle + i * (Math.PI * 2 / 12);
        const x = anchor.x + Math.cos(a) * rad;
        const y = anchor.y + Math.sin(a) * rad;
        if (!placementBlocked(owner, type, x, y) && withinBuildRadius(owner, x, y)) return { x, y };
      }
    }
  }
  return null;
}

function aiDesiredStructure(owner, counts, power) {
  const f = facOf(owner);
  if (power.used + 30 > power.cap && !atStructCap(owner, 'powerplant')) return 'powerplant';
  // walk the build order; each repeat of a type raises its desired count.
  // income factions (no miners) weave in extra power structures — those ARE
  // their economy
  const order = f.economy.workers === 0
    ? ['barracks', 'powerplant', f.tower, 'powerplant', 'factory', f.aaTower, 'powerplant', 'airpad', 'powerplant', 'tech', 'barracks', f.tower, 'powerplant', f.aaTower]
    : ['barracks', f.tower, 'factory', f.aaTower, 'airpad', 'barracks', 'tech', f.tower, f.aaTower];
  // hangar factions add the AC-130's dedicated field once the lab is up
  if ((f.advanced || []).some(u => UNIT_TYPES[u].builtAt === 'hangar')) order.push('hangar');
  // once teched up, everyone wants their doomsday device (needs the extra power)
  if (superweaponsOn && (f.structs || []).includes('superweapon')) order.push('powerplant', 'superweapon');
  const want = {};
  for (const t of order) {
    want[t] = (want[t] || 0) + 1;
    if ((counts[t] || 0) < want[t] && !atStructCap(owner, t)) {
      // a gated structure (flat-family airpads) sends the AI for its prereq first
      const rq = bstats(owner, t).req;
      if (rq && !(counts[rq] > 0)) {
        return atStructCap(owner, rq) ? null : rq;
      }
      return t;
    }
  }
  return null;
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

  // start next structure; reserve its cost so unit spam can't starve it
  const desired = !state.construction[owner] ? aiDesiredStructure(owner, counts, power) : null;
  if (desired && (!f.worker || workers.length >= 3) && state.minerals[owner] >= bstats(owner, desired).cost) {
    startConstruction(owner, desired);
  }
  const reserve = (!state.construction[owner] && desired) ? bstats(owner, desired).cost : 0;

  // rigs (income factions have none to train; trainUnit enforces the cap)
  if (f.worker && workers.length < f.economy.workers &&
      state.minerals[owner] >= UNIT_TYPES[f.worker].cost + reserve) {
    trainUnit(owner, f.worker);
  }

  // train toward a target composition: pick the most-lacking type and save for
  // it — training whatever is affordable would starve the expensive units.
  // Candidates come straight from the faction roster, filtered by whether the
  // right production building (and any tech prereq) actually stands.
  const mix = [];
  const addMix = (type, w) => {
    if (!type) return;
    const ut = UNIT_TYPES[type];
    if (ut.role !== 'combat') return;               // scouts don't join the army
    if (!ut.dmg) return;                            // engineers/repair crews stay home
    if (!counts[ut.builtAt]) return;                // no building that makes it
    if (ut.req && !counts[ut.req]) return;          // tech not researched yet
    mix.push([type, w]);
  };
  addMix(f.infantry, 4); addMix(f.aa, 1.2); addMix(f.extras[0], 0.8);
  addMix(f.vehicle, 1.6); addMix(f.extras[1], 0.8);
  for (const a of f.air) addMix(a, 1.2);
  for (const a of f.extras.slice(2)) addMix(a, 0.6);
  for (const a of (f.advanced || [])) addMix(a, 0.5);
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
    let pick = null, worst = -Infinity;
    for (const [t, w] of mix) {
      const deficit = w / totalW - (byType[t] || 0) / (totalArmy || 1);
      if (deficit > worst) { worst = deficit; pick = t; }
    }
    if (pick && state.minerals[owner] >= UNIT_TYPES[pick].cost + reserve) trainUnit(owner, pick);
  }

  // defense (disguised reptilian infantry don't register as hostile)
  const threat = nearest(hq, state.units.filter(u => u.owner !== owner && u.hp > 0 && !u.garrisoned), u => !hiddenFrom(u, owner) && dist(hq, u) < 450);
  if (threat) {
    for (const s of army) {
      if (canTarget(UNIT_TYPES[s.type], threat)) orderAttack(s, threat);
    }
    return;
  }

  // attack waves: free-for-all — march on whoever's base is closest
  const idleArmy = army.filter(s => s.order.type === 'idle');
  if (ai.time > AI_GRACE_PERIOD && idleArmy.length >= ai.attackWaveSize) {
    const target = nearest(hq, state.buildings.filter(b => b.owner !== owner && b.owner !== NEUTRAL && b.hp > 0 && b.type !== 'sleepercell'))
      || nearest(hq, state.units.filter(u => u.owner !== owner && u.hp > 0 && !hiddenFrom(u, owner) && !u.garrisoned));
    if (target) {
      for (const s of idleArmy) orderAttackMove(s, target.x, target.y);
      ai.attackWaveSize = Math.min(12, ai.attackWaveSize + 1);
    }
  }
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

function selectAt(x, y) {
  const u = state.units.find(u => u.owner === PLAYER && u.hp > 0 && !u.garrisoned && clickHitsUnit(u, x, y, 4));
  const b = state.buildings.find(b => b.owner === PLAYER && b.hp > 0 &&
    Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
  // no own entity under the cursor: inspect a visible enemy instead
  // (disguised infiltrators are excluded — clicking would blow their cover)
  const eu = !u && !b && state.units.find(un => un.owner !== PLAYER && un.hp > 0 && !hiddenFrom(un, PLAYER) && !un.garrisoned &&
    visibleToPlayer(un) && clickHitsUnit(un, x, y, 4));
  const eb = !u && !b && !eu && state.buildings.find(bd => bd.owner !== PLAYER && bd.hp > 0 &&
    visibleToPlayer(bd) && Math.abs(bd.x - x) <= bd.w / 2 && Math.abs(bd.y - y) <= bd.h / 2);
  selection = u ? [u] : b ? [b] : eu ? [eu] : eb ? [eb] : [];
}

function rightCommand(x, y) {
  // rally point when a single production building is selected
  if (selection.length === 1 && selection[0].kind === 'building' && selection[0].owner === PLAYER) {
    selection[0].rally = { x, y };
    sfx('click');
    return;
  }
  issueCommand(x, y);
}

function issueCommand(x, y) {
  const units = selection.filter(e => e.kind === 'unit' && e.hp > 0 && e.owner === PLAYER);
  if (units.length === 0) return;
  const pt = { x, y };

  // hollow earth tunnel network: right-click any network node you own
  if (state.factions[PLAYER] === 'hollow') {
    const node = state.buildings.find(b => b.owner === PLAYER && b.hp > 0 && b.done &&
      TUNNEL_NODES.includes(b.type) &&
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

  // right-click a neutral (or own-held) civilian structure: infantry garrison it
  const gb = state.buildings.find(b => b.hp > 0 && bstatsOf(b).slots &&
    (b.owner === NEUTRAL || b.owner === PLAYER) && visibleToPlayer(b) &&
    Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
  if (gb) {
    let any = false;
    for (const u of units) {
      if (canGarrison(u)) { u.order = { type: 'garrison', destId: gb.id }; any = true; }
    }
    if (any) { sfx('click'); return; }
  }

  const foe = enemiesOf(PLAYER).find(e => visibleToPlayer(e) &&
    (e.kind === 'unit' ? clickHitsUnit(e, x, y, 6)
                       : Math.abs(e.x - x) <= e.w / 2 && Math.abs(e.y - y) <= e.h / 2));
  const patch = state.patches.find(p => p.amount > 0 && dist(p, pt) <= 20 && tileState(p.x, p.y) >= 1);
  // a damaged friendly unit under the cursor: repair units tend to it
  const ally = state.units.find(a => a.owner === PLAYER && a.hp > 0 && !a.garrisoned &&
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
  if (placing || attackMoveArmed || plantArmed || abilityTargeting || superTargeting || wallDrag) return null;
  const units = selection.filter(e => e.kind === 'unit' && e.hp > 0 && e.owner === PLAYER);
  if (!units.length) return null;
  // hollow tunnel node
  if (state.factions[PLAYER] === 'hollow') {
    const node = state.buildings.find(b => b.owner === PLAYER && b.hp > 0 && b.done && TUNNEL_NODES.includes(b.type) &&
      Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
    if (node && units.some(u => !UNIT_TYPES[u.type].flying)) return { kind: 'tunnel', x: node.x, y: node.y, size: entityRadius(node) };
  }
  // garrisonable civilian structure
  const gb = state.buildings.find(b => b.hp > 0 && bstatsOf(b).slots && (b.owner === NEUTRAL || b.owner === PLAYER) &&
    visibleToPlayer(b) && Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
  if (gb && units.some(canGarrison)) return { kind: 'garrison', x: gb.x, y: gb.y, size: entityRadius(gb) };
  // enemy under the cursor
  const foe = enemiesOf(PLAYER).find(e => visibleToPlayer(e) &&
    (e.kind === 'unit' ? clickHitsUnit(e, x, y, 6) : Math.abs(e.x - x) <= e.w / 2 && Math.abs(e.y - y) <= e.h / 2));
  if (foe) {
    if (foe.kind === 'building' && units.some(u => UNIT_TYPES[u.type].captures)) return { kind: 'capture', x: foe.x, y: foe.y, size: entityRadius(foe) };
    if (foe.kind === 'unit' && units.some(u => UNIT_TYPES[u.type].tracker)) return { kind: 'probe', x: foe.x, y: foe.y, size: entityRadius(foe) };
    if (units.some(u => canTarget(UNIT_TYPES[u.type], foe))) return { kind: 'attack', x: foe.x, y: foe.y, size: entityRadius(foe) };
  }
  // a damaged ally for repair units
  const ally = state.units.find(a => a.owner === PLAYER && a.hp > 0 && !a.garrisoned && a.hp < a.maxHp && clickHitsUnit(a, x, y, 6));
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
  if (!selection.some(s => s.kind === 'unit' && s.owner === PLAYER)) return;
  if (selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].role === 'combat')) {
    selection.forEach(u => { if (u.kind === 'unit' && u.owner === PLAYER) orderAttackMove(u, wx, wy); });
  } else {
    issueCommand(wx, wy);
  }
  state.pings = state.pings || [];
  state.pings.push({ x: wx, y: wy, t: state.time });
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
  b.owner = NEUTRAL; // reverts to a civilian structure
  sfx('click');
  refreshPanel();
}

function sidebarStructureClick(type) {
  const st = bstats(PLAYER, type);
  // field fortifications (walls, gates, mines): no build queue — go straight
  // into placement and pay per piece, so laying them never stalls the real
  // production queue
  if (st.instant) {
    if (placing === type) { placing = null; refreshPanel(); return; } // toggle off
    if (atStructCap(PLAYER, type)) { eva('Build limit reached'); return; }
    const rq = st.req;
    if (rq && !hasStruct(PLAYER, rq)) { eva(`Requires ${facOf(PLAYER).buildingNames[rq] || rq}`); return; }
    if (state.minerals[PLAYER] < st.cost) { eva('Insufficient funds'); return; }
    placing = type;
    sfx('click');
    refreshPanel();
    refreshSidebar();
    return;
  }
  const c = state.construction[PLAYER];
  if (c && c.ready && c.type === type) { placing = type; refreshPanel(); return; }
  if (c) { eva('Unable to comply, building in progress'); return; }
  if (atStructCap(PLAYER, type)) { eva('Build limit reached'); return; }
  const rq = st.req;
  if (rq && !hasStruct(PLAYER, rq)) { eva(`Requires ${facOf(PLAYER).buildingNames[rq] || rq}`); return; }
  if (state.minerals[PLAYER] < st.cost) { eva('Insufficient funds'); return; }
  startConstruction(PLAYER, type);
  sfx('click');
  refreshSidebar();
}

function sidebarUnitClick(type) {
  const ut = UNIT_TYPES[type];
  const hasTrainer = state.buildings.some(b => b.owner === PLAYER && b.hp > 0 && b.done && b.type === ut.builtAt);
  if (!hasTrainer) { eva(`Requires ${facOf(PLAYER).buildingNames[ut.builtAt] || ut.builtAt}`); return; }
  if (ut.req && !hasStruct(PLAYER, ut.req)) { eva(`Requires ${facOf(PLAYER).buildingNames[ut.req] || ut.req}`); return; }
  if (ut.pad && !padSlotsFree(PLAYER, ut.builtAt)) { eva('Airfields at capacity'); return; }
  if (ut.limit && unitCount(PLAYER, type) >= ut.limit) { eva('Unit limit reached'); return; }
  if (state.minerals[PLAYER] < ut.cost) { eva('Insufficient funds'); return; }
  if (trainUnit(PLAYER, type)) sfx('click');
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
function cancelStructure(type) {
  // instant field structures have nothing queued — just stop placing them
  if (bstats(PLAYER, type).instant) {
    if (placing === type) { placing = null; sfx('click'); refreshPanel(); refreshSidebar(); }
    return;
  }
  const c = state.construction[PLAYER];
  if (!c || c.type !== type) return;
  state.construction[PLAYER] = null;
  if (placing === type) placing = null;
  state.minerals[PLAYER] += bstats(PLAYER, type).cost;
  eva('Construction canceled');
  sfx('click');
  refreshSidebar();
  refreshPanel();
}

// right-click on a unit cameo: pull the most recently queued unit of that
// type back out of its trainer's queue and refund the full cost
function cancelUnit(type) {
  const ut = UNIT_TYPES[type];
  let best = null;
  for (const b of state.buildings) {
    if (b.owner !== PLAYER || b.hp <= 0 || b.type !== ut.builtAt) continue;
    for (let i = b.queue.length - 1; i >= 0; i--) {
      if (b.queue[i].type === type) {
        if (!best || i > best.i) best = { b, i }; // deepest in queue = least progress lost
        break;
      }
    }
  }
  if (!best) return;
  best.b.queue.splice(best.i, 1);
  state.minerals[PLAYER] += ut.cost;
  sfx('click');
  refreshSidebar();
}

function buildSidebar() {
  gridStructures.innerHTML = '';
  gridUnits.innerHTML = '';
  for (const k of Object.keys(cameoButtons)) delete cameoButtons[k];
  const f = facOf(PLAYER);

  let structs = ['powerplant', 'barracks', f.tower, f.aaTower, 'factory', 'airpad', 'tech', ...(f.structs || [])];
  if (!superweaponsOn) structs = structs.filter(s => s !== 'superweapon');
  // factions with a hangar-based heavy get the hangar construction slot
  if ([...(f.advanced || []), ...f.extras].some(u => UNIT_TYPES[u].builtAt === 'hangar')) structs.push('hangar');
  for (const s of structs) {
    makeCameo(gridStructures, 's:' + s, f.buildingNames[s] || s, bstats(PLAYER, s).cost,
      () => sidebarStructureClick(s), () => cancelStructure(s));
  }
  const unlocks = [...(f.advanced || []).map(u => UNIT_TYPES[u].name),
    ...(structs.includes('hangar') ? [f.buildingNames.hangar || 'Hangar'] : []),
    ...(bstats(PLAYER, 'airpad').req === 'tech' ? [f.buildingNames.airpad || 'Airfield'] : [])];
  cameoButtons['s:tech'].btn.title = unlocks.length ? 'Unlocks: ' + unlocks.join(', ') : 'Research site';
  // worker-less factions have no worker cameo — their buildings pay the bills
  const unitList = [f.worker, f.infantry, f.aa, f.extras[0], f.vehicle, f.extras[1],
    ...f.air, ...f.extras.slice(2), ...(f.advanced || [])].filter(Boolean);
  for (const u of unitList) {
    makeCameo(gridUnits, 'u:' + u, UNIT_TYPES[u].name, UNIT_TYPES[u].cost,
      () => sidebarUnitClick(u), () => cancelUnit(u));
    if (UNIT_TYPES[u].req) {
      cameoButtons['u:' + u].btn.title = `Requires ${f.buildingNames[UNIT_TYPES[u].req] || UNIT_TYPES[u].req}`;
    }
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
      // toggle with an explicit boolean: remove-then-maybe-add rewrote the
      // class attribute every refresh even when nothing changed
      if (pk.kind === 'auto') {
        ui.btn.classList.toggle('castable', false);
        ui.prog.style.height = (sig.timer / pk.period * 100) + '%';
        ui.costEl.textContent = Math.ceil(pk.period - sig.timer) + 's';
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
      const st = bstats(PLAYER, type);
      // field fortifications never enter the build queue, so they stay live
      // even while a real structure is under construction
      if (st.instant) {
        const capped = atStructCap(PLAYER, type);
        const rq = st.req;
        const locked = !!rq && !hasStruct(PLAYER, rq);
        const active = placing === type;
        const poor = state.minerals[PLAYER] < st.cost;
        ui.btn.classList.toggle('ready', active);
        ui.btn.classList.toggle('disabled', locked || capped || (poor && !active));
        ui.prog.style.height = '0%';
        ui.costEl.textContent = active ? 'PLACING'
          : locked ? '🔒 ' + (facOf(PLAYER).buildingNames[rq] || rq)
          : capped ? 'MAX'
          : '$' + ui.baseCost;
        continue;
      }
      const isThis = c && c.type === type;
      const capped = atStructCap(PLAYER, type);
      const rq = st.req;
      // NB: must be a real boolean — classList.toggle(name, undefined) is a
      // plain toggle and would flip the class every refresh (sidebar strobe)
      const locked = !!rq && !hasStruct(PLAYER, rq);
      ui.btn.classList.toggle('ready', !!(isThis && c.ready));
      ui.btn.classList.toggle('disabled', !!(c && !isThis) || (capped && !isThis) || locked);
      ui.prog.style.height = isThis && !c.ready ? (c.t / c.duration * 100) + '%' : '0%';
      const cap = bstats(PLAYER, type).cap;
      ui.costEl.textContent = isThis && c.ready ? 'PLACE'
        : locked ? '🔒 ' + (facOf(PLAYER).buildingNames[rq] || rq)
        : capped ? 'MAX'
        : '$' + ui.baseCost + (cap ? ` (${countStruct(PLAYER, type)}/${cap})` : '');
    } else {
      const ut = UNIT_TYPES[type];
      const trainers = state.buildings.filter(b => b.owner === PLAYER && b.hp > 0 && b.done && b.type === ut.builtAt);
      const locked = !!ut.req && !hasStruct(PLAYER, ut.req);
      const have = ut.limit ? unitCount(PLAYER, type) : 0;
      const capped = !!ut.limit && have >= ut.limit;
      ui.btn.classList.toggle('disabled', trainers.length === 0 || locked || capped);
      ui.costEl.textContent = locked ? '🔒 ' + (facOf(PLAYER).buildingNames[ut.req] || ut.req)
        : capped ? 'MAX'
        : '$' + ui.baseCost + (ut.limit ? ` (${have}/${ut.limit})` : '');
      const queued = trainers.reduce((n, b) => n + b.queue.filter(j => j.type === type).length, 0);
      ui.badge.style.display = queued ? '' : 'none';
      ui.badge.textContent = queued;
      const active = trainers.find(b => b.queue.length && b.queue[0].type === type);
      ui.prog.style.height = active ? (active.queue[0].t / active.queue[0].duration * 100) + '%' : '0%';
    }
  }
}

function startGame(faction) {
  document.getElementById('faction-select').classList.add('hidden');
  const size = MAP_SIZES[selectedSize];
  const numEnemies = clamp(selectedOpponents, 1, size.maxPlayers - 1);
  OWNERS = Array.from({ length: numEnemies + 1 }, (_, o) => o);

  // the AIs play random factions from families other than yours
  const others = Object.keys(FACTIONS).filter(k => FACTIONS[k].family !== FACTIONS[faction].family);
  state.factions[PLAYER] = faction;
  for (const owner of OWNERS) {
    state.construction[owner] = null;
    state.sig[owner] = { cd: 0, timer: 0, used: false };
    state.infiltrator[owner] = null;
    state.eco[owner] = 0;
    if (owner !== PLAYER) {
      state.factions[owner] = others[Math.floor(Math.random() * others.length)];
      ais[owner] = { attackWaveSize: 5, thinkTimer: Math.random(), time: 0 };
    }
    // worker-less factions get a head start while their income ramps up
    state.minerals[owner] = 300 + (facOf(owner).economy.start || 0);
  }

  setupWorld(generateMap(selectedSize, OWNERS.length, selectedSetting === 'random' ? null : selectedSetting));
  const vs = OWNERS.filter(o => o !== PLAYER)
    .map(o => `${facOf(o).emoji} ${facOf(o).name}`).join('  +  ');
  document.getElementById('faction-label').textContent =
    `${FACTIONS[faction].emoji} ${FACTIONS[faction].name}  vs  ${vs}`;
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
    (abilityTargeting || '') + (superTargeting || '') + (wallDrag ? 'w' : '') + '|';
  for (const e of selection) {
    if (e.hp <= 0) continue;
    s += e.kind + e.id + '·';
    if (e.kind === 'building') {
      const bt = bstatsOf(e);
      if (e.garrison) s += 'g' + e.garrison.length;
      if (bt.superweapon) s += 'S' + (((e.charge || 0) >= superChargeOf(e) && !isOffline(e)) ? '1' : '0');
    } else {
      const ut = UNIT_TYPES[e.type];
      if (ut.burrow) s += e.burrowed ? 'B1' : 'B0';
      if (ut.plantMine) s += e.planted ? 'P1' : 'P0';
    }
  }
  return s;
}

function refreshPanel() {
  selection = selection.filter(e => e.hp > 0);
  const sig = panelSignature();
  const rebuild = sig !== lastPanelSig;
  lastPanelSig = sig;
  const addAction = el => { if (rebuild) elActions.appendChild(el); };
  if (rebuild) elActions.innerHTML = '';

  if (placing) {
    elSelInfo.textContent = `Placing ${facOf(PLAYER).buildingNames[placing] || placing} — click a spot near your base, Esc to cancel`;
    return;
  }
  if (attackMoveArmed) {
    elSelInfo.textContent = 'Attack-move — left-click a destination, Esc to cancel';
    return;
  }
  if (plantArmed) {
    elSelInfo.textContent = 'Plant IED — left-click where to bury it, Esc to cancel';
    return;
  }
  if (abilityTargeting) {
    elSelInfo.textContent = abilityTargeting === 'zone'
      ? 'Weather Modification — click a target area, Esc to cancel'
      : 'Cloning Vats — click one of your units, Esc to cancel';
    return;
  }
  if (superTargeting) {
    const sw = state.buildings.find(b => b.id === superTargeting);
    elSelInfo.textContent = (sw ? buildingName(sw) : 'Superweapon') + ' — click a target, Esc to cancel';
    return;
  }
  elSelInfo.style.color = '';
  if (selection.length === 0) { elSelInfo.textContent = 'Nothing selected'; return; }

  const first = selection[0];
  if (selection.length === 1 && first.owner === NEUTRAL) {
    const bt = bstatsOf(first);
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      (bt.slots ? ` — right-click with infantry to garrison (${bt.slots} slots)` : '') +
      (bt.income ? ` — pays +${bt.income} minerals / 10s while held` : '');
    return;
  }
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
      const bt = bstatsOf(first);
      const parts = [`☠ ${buildingName(first)} (${fName})`, `HP ${Math.ceil(first.hp)}/${bt.hp}`];
      if (bt.dmg) parts.push(`DMG ${bt.dmg} every ${bt.cooldown}s`, `Range ${bt.atkRange}`, bt.targets === 'air' ? 'Anti-air only' : 'Ground only');
      if (bt.power > 0) parts.push(`+${bt.power} power`);
      if (bt.income) parts.push(`+${bt.income} minerals / 10s`);
      elSelInfo.textContent = parts.join('  |  ');
    }
    return;
  }
  if (selection.length === 1 && first.kind === 'building') {
    const bt = bstatsOf(first);
    if (bt.slots) {
      elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
        ` — garrison ${first.garrison.length}/${bt.slots}` +
        (bt.income ? ` — +${bt.income} minerals / 10s` : '');
      if (first.garrison.length) {
        const btn = document.createElement('button');
        btn.textContent = `Evacuate (${first.garrison.length})`;
        btn.onclick = () => evacuate(first);
        addAction(btn);
      }
      return;
    }
    if (bt.superweapon) {
      const need = superChargeOf(first), have = Math.min(need, first.charge || 0);
      const ready = have >= need;
      elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP — ` +
        (isOffline(first) ? 'BLACKED OUT' : ready ? 'READY TO FIRE' : `charging ${Math.floor(have)}/${need}s`);
      if (first.owner === PLAYER && ready && !isOffline(first)) {
        const btn = document.createElement('button');
        btn.textContent = 'Launch [click target]';
        btn.onclick = () => { superTargeting = first.id; refreshPanel(); };
        addAction(btn);
      }
      return;
    }
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      (first.queue.length ? ` — training (${first.queue.length} queued)` : '') +
      ' — right-click to set rally point';
  } else {
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
      if (ut.plantMine) info += uu.planted ? ' — IED spent' : ' — can plant one IED [E]';
    }
    elSelInfo.textContent = info;
    // evacuate any garrisoned civilian structures caught in the selection
    const gbs = selection.filter(s => s.kind === 'building' && s.garrison && s.garrison.length);
    if (gbs.length) {
      const total = gbs.reduce((n, b) => n + b.garrison.length, 0);
      const btn = document.createElement('button');
      btn.textContent = `Evacuate (${total})`;
      btn.onclick = () => { gbs.forEach(evacuate); selection = selection.filter(s => s.kind === 'unit'); refreshPanel(); };
      addAction(btn);
    }
    if (selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].role === 'combat')) {
      const btn = document.createElement('button');
      btn.textContent = 'Attack-Move [A]';
      btn.onclick = () => { attackMoveArmed = true; refreshPanel(); };
      addAction(btn);
    }
    if (selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].plantMine)) {
      const ready = selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].plantMine && !s.planted);
      const btn = document.createElement('button');
      btn.textContent = 'Plant IED [E]';
      btn.disabled = !ready;
      btn.onclick = () => { plantArmed = true; attackMoveArmed = false; refreshPanel(); };
      addAction(btn);
    }
    if (selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].burrow && !s.transit)) {
      const anyUp = selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].burrow && !s.burrowed);
      const btn = document.createElement('button');
      btn.textContent = (anyUp ? 'Burrow' : 'Surface') + ' [X]';
      btn.onclick = toggleBurrowSelection;
      addAction(btn);
    }
    if (selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].role === 'scout')) {
      const btn = document.createElement('button');
      btn.textContent = 'Explore [V]';
      btn.onclick = exploreSelection;
      addAction(btn);
    }
  }
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
  for (const b of state.buildings) {
    if (b.hp > 0 && visibleToPlayer(b) && inView(b.x, b.y, (b.w + b.h) / 2 + 60)) {
      drawList.push({ d: b.x + b.y, k: 1, e: b });
    }
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
    else if (it.k === 1) drawBuildingIso(it.e);
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

// mineral patches: ground stain + a cluster of upright crystal shards
function drawPatchIso(p) {
  const ix = isoX(p.x, p.y), iy = isoY(p.x, p.y);
  const s = 10 + 8 * Math.min(1, p.amount / 900);
  ctx.fillStyle = 'rgba(31,106,102,0.45)';
  ctx.beginPath();
  ctx.ellipse(ix, iy, s * 1.7, s * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 3; i++) {
    const a = p.id * 2.1 + i * 2.4;
    const ox = Math.cos(a) * s * 0.7, oy = Math.sin(a) * s * 0.35;
    const h = s * (0.75 + 0.2 * ((p.id + i) % 3));
    ctx.fillStyle = '#3fd7d0';
    ctx.beginPath();
    ctx.moveTo(ix + ox, iy + oy - h);
    ctx.lineTo(ix + ox + h * 0.38, iy + oy);
    ctx.lineTo(ix + ox, iy + oy + h * 0.3);
    ctx.lineTo(ix + ox - h * 0.38, iy + oy);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#1a8a85';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(220,255,252,0.5)'; // lit NE facet
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
  if (bt.stealth) ctx.globalAlpha = b.owner === PLAYER ? 0.6 : 0.45;
  const ix = isoX(b.x, b.y), iy = isoY(b.x, b.y);
  const topY = iy - (b.w + b.h) / 4; // screen y of the footprint's north corner
  const on = !powerOf(b.owner).low;
  // building art comes from the sprite cache: refreshed at ~10Hz for its
  // animations, immediately when power/owner/turret-heading change
  const bw2 = b.w + b.h;
  const cw = Math.ceil(bw2 + 80), chh = Math.ceil(bw2 * 0.5 + 100);
  const ax = cw / 2, ay = Math.ceil(bw2 * 0.25 + 60);
  const qt = b.turret !== undefined ? Math.round(b.turret / 0.2) : -99;
  const conn = (b.type === 'wall' || b.type === 'gate') ? wallConn(b) : 0;
  // superweapon silos animate a launch for ~1.8s after firing
  let superKind = null, fireP = -1;
  if (bstatsOf(b).superweapon) {
    superKind = superKindOf(b);
    if (b.fireT !== undefined) { const e = state.time - b.fireT; if (e >= 0 && e < 1.8) fireP = e / 1.8; }
  }
  const sig = b.owner + '|' + (on ? 1 : 0) + '|' + qt + '|' + conn +
    (superKind ? '|' + superKind + '|' + (fireP >= 0 ? Math.round(fireP * 14) : 'x') : '');
  const spr = cachedSprite(b.id, cw, chh, ax, ay, sig, 12, g => {
    isoShear(g); // building art draws in its local ground-plane frame
    Art.building(b.type, g, state.time + (b.id % 89) * 0.71, {
      w: b.w, h: b.h, color: COLORS[b.owner], on,
      fam: FAMILY_STYLE[state.factions[b.owner]], faction: state.factions[b.owner], wx: b.x, wy: b.y,
      turret: b.turret, // towers with their own weapon art track their target
      conn: { e: !!(conn & 1), w: !!(conn & 2), n: !!(conn & 4), s: !!(conn & 8) },
      superKind, fireP,
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
      ctx.strokeStyle = b.owner === PLAYER ? '#7fff9f' : '#ff8f8f';
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

    if (b.queue.length) {
      const bw = (b.w + b.h) / 2, qy = iy + (b.w + b.h) / 4 + 3;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(ix - bw / 2, qy, bw, 5);
      ctx.fillStyle = '#ffd75f';
      ctx.fillRect(ix - bw / 2, qy, bw * clamp(b.queue[0].t / b.queue[0].duration, 0, 1), 5);
    }

    // superweapon status, always visible on the silo so you never have to
    // select it to know: a charge bar + seconds-left countdown, becoming a
    // pulsing READY beacon when it can fire (enemy silos only while scouted)
    if (bt.superweapon && b.done && (b.owner === PLAYER || tileState(b.x, b.y) === 2)) {
      const need = superChargeOf(b), have = Math.min(need, b.charge || 0);
      const ready = have >= need, off = isOffline(b);
      const bw = (b.w + b.h) / 2, qy = iy + (b.w + b.h) / 4 + 3;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(ix - bw / 2, qy + 7, bw, 5);
      ctx.fillStyle = off ? '#6a6a6a' : ready ? '#5fce5f' : (b.owner === PLAYER ? '#4da3ff' : '#ff8f5f');
      ctx.fillRect(ix - bw / 2, qy + 7, bw * clamp(have / need, 0, 1), 5);
      const pulse = 0.5 + 0.5 * Math.sin(state.time * 4);
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      if (off) {
        ctx.fillStyle = '#8ab4ff';
        ctx.fillText('EMP — OFFLINE', ix, topY - 18);
      } else if (ready) {
        ctx.strokeStyle = b.owner === PLAYER ? `rgba(120,255,150,${0.35 + pulse * 0.45})` : `rgba(255,120,120,${0.35 + pulse * 0.45})`;
        ctx.lineWidth = 2 + pulse * 2.5;
        ctx.beginPath();
        ctx.ellipse(ix, iy, b.w * 0.95, b.w * 0.48, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = b.owner === PLAYER ? `rgba(150,255,170,${0.65 + pulse * 0.35})` : `rgba(255,150,150,${0.65 + pulse * 0.35})`;
        ctx.fillText(b.owner === PLAYER ? '⚠ READY TO FIRE' : '⚠ ENEMY SUPERWEAPON', ix, topY - 18);
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
  if (!t.flying || u.landed) return 0;
  return t.flyH || FLY_H;
}

function drawUnitIso(u) {
  const t = UNIT_TYPES[u.type];
  // reptilian skin suit: enemy infantry render in YOUR color until they attack
  const drawCol = (u.disguised && u.owner !== PLAYER) ? COLORS[PLAYER] : COLORS[u.owner];
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
  const sy = iy - alt;
  // your own gaslight phantoms look ghostly to you; enemy ones look real
  if (u.type === 'phantom' && u.owner === PLAYER) ctx.globalAlpha = 0.4;
  // cloaked/burrowed units draw ghosted: to their owner as a reminder, to
  // the enemy only while a detector pins them (visibleToPlayer gates that)
  if (isCloaked(u)) ctx.globalAlpha = u.owner === PLAYER ? 0.55 : 0.45;
  if (alt) {
    // shadow stays on the ground while the craft flies above it (live)
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(ix + 5, iy + 3, rs * 0.9, rs * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // body sprite from a SHARED cache: keyed by type + color + 32-facing
  // bucket + gait pose + state flags + a coarse ambient-time bucket, so an
  // army marching one way reuses a handful of sprites instead of each unit
  // repainting its own vector art
  const moving = u.order.type !== 'idle';
  const firing = u.cooldown > t.cooldown - 0.15;
  const qf = Math.round((u.facing || 0) / (Math.PI / 16)) & 31;
  const gait = Math.floor((u.travel || 0) / 7) & 7;
  const key = u.type + '|' + drawCol + '|' + qf + '|' + gait + '|' +
    ((moving ? 1 : 0) | (firing ? 2 : 0) | (u.carrying > 0 ? 4 : 0) | (grounded ? 8 : 0) | (alt ? 16 : 0));
  const qFacing = qf * (Math.PI / 16); // render the bucket's representative pose
  const cw = Math.ceil(rs * 3.4 + 26), chh = Math.ceil(rs * 4 + 30);
  const ax = cw / 2, ay = Math.ceil(rs * 2.8 + 16);
  // interval 32: idle/ambient animations repaint in place at ~2Hz
  const spr = cachedSprite(key, cw, chh, ax, ay, 'u', 32, g => {
    g.scale(dscale, dscale);
    if (!alt) Art.shadow(g, t.r * 1.15, t.r * 0.6, 0, 1.5); // contact shadow
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
        carrying: u.carrying > 0,
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
    ctx.drawImage(spr.cv, ix - ax, sy + bob - ay);
  }
  ctx.filter = 'none';
  // live turret: rendered over the cached hull so the gun tracks its target
  // independently of the chassis heading (cloaked/burrowed units stay bare)
  if (Art.hasIsoTurret(u.type) && !isCloaked(u) && !u.burrowed) {
    ctx.save();
    ctx.translate(ix, sy + bob);
    ctx.scale(dscale, dscale);
    Art.drawIsoTurret(u.type, ctx, state.time, { facing: u.facing || 0, turret: u.turret, firing });
    ctx.restore();
  }
  if (u.carrying > 0) {
    ctx.fillStyle = '#3fd7d0';
    ctx.fillRect(ix - 3, sy - rs - 7, 6, 5);
  }
  if (selection.includes(u)) {
    ctx.strokeStyle = u.owner === PLAYER ? '#7fff9f' : '#ff8f8f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(ix, sy, rs + 5, (rs + 5) * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (u.hp < u.maxHp) drawBar(ix, sy - rs - 12, rs * 2.4, u.hp / u.maxHp);
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
      // missiles chase aircraft, so they fly at aircraft altitude
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath(); ctx.ellipse(px, py, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.save();
      ctx.translate(px, py - FLY_H);
      ctx.rotate(isoAngle(p.angle));
      ctx.fillStyle = '#e8edf2';
      ctx.fillRect(-4, -1.4, 8, 2.8);
      ctx.fillStyle = '#8b939e'; // tail fins
      ctx.fillRect(-4.5, -3, 2, 6);
      ctx.fillStyle = '#c0392b'; // warhead
      ctx.beginPath(); ctx.moveTo(4, -1.4); ctx.lineTo(7, 0); ctx.lineTo(4, 1.4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = `rgba(255,${170 + Math.floor(Math.random() * 60)},70,0.9)`; // exhaust
      ctx.beginPath(); ctx.moveTo(-4.5, -1.1); ctx.lineTo(-8 - Math.random() * 3, 0); ctx.lineTo(-4.5, 1.1); ctx.closePath(); ctx.fill();
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
      ctx.fillStyle = `rgba(255,${170 + Math.floor(Math.random() * 60)},70,0.9)`;
      ctx.beginPath();
      ctx.moveTo(-3, -8); ctx.lineTo(0, -18 - Math.random() * 8); ctx.lineTo(3, -8);
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
      ctx.fillStyle = `rgba(255,${170 + Math.floor(Math.random() * 60)},70,0.9)`;
      ctx.beginPath(); ctx.moveTo(-6, -1.3); ctx.lineTo(-11 - Math.random() * 4, 0); ctx.lineTo(-6, 1.3); ctx.closePath(); ctx.fill();
      ctx.restore();
    } else if (p.kind === 'rock') {
      ctx.fillStyle = '#8a7f6e';
      ctx.beginPath(); ctx.arc(hx, hy, 3.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#5c5347'; ctx.lineWidth = 1; ctx.stroke();
    } else if (p.kind === 'shell') {
      // gunship howitzer round: small, fast, mean
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
function drawZones() {
  for (const z of state.zones) {
    const kind = z.kind || 'rain';
    const zx = isoX(z.x, z.y), zy = isoY(z.x, z.y);
    const rx = z.r * Math.SQRT2, ry = rx / 2;
    if (kind === 'rain' || kind === 'storm') {
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
  for (let i = 0; i < vis.length; i++) {
    fd[i] = vis[i] === 2 ? 0 : vis[i] === 1 ? 0x80000000 : 0xF2000000;
  }
  fogCtx.putImageData(fogImg, 0, 0);
  ctx.save();
  isoShear(ctx);
  ctx.drawImage(fogCanvas, 0, 0, FW, FH, 0, 0, WORLD_W, WORLD_H);
  ctx.restore();

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
  if (state.pings && state.pings.length) {
    for (const p of state.pings) {
      const age = state.time - p.t;
      if (age > 0.6) continue;
      const f = age / 0.6, rr2 = 6 + f * 34;
      ctx.strokeStyle = `rgba(127,255,159,${1 - f})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(isoX(p.x, p.y), isoY(p.x, p.y), rr2 * Math.SQRT2, rr2 * Math.SQRT2 / 2, 0, 0, Math.PI * 2); ctx.stroke();
    }
    state.pings = state.pings.filter(p => state.time - p.t <= 0.6);
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
    const t = bstats(PLAYER, placing);
    const ok = !placementBlocked(PLAYER, placing, mouse.x, mouse.y) &&
      (t.anywhere || withinBuildRadius(PLAYER, mouse.x, mouse.y));
    ctx.globalAlpha = 0.5;
    if (wallDrag) {
      // ghost the whole stretch of wall segments being dragged out
      const ex = Math.round(mouse.x / WALL_STEP) * WALL_STEP, ey = Math.round(mouse.y / WALL_STEP) * WALL_STEP;
      const dx = ex - wallDrag.x0, dy = ey - wallDrag.y0;
      const n = Math.max(0, Math.round(Math.hypot(dx, dy) / WALL_STEP));
      for (let i = 0; i <= n; i++) {
        const x = wallDrag.x0 + dx * (i / (n || 1)), y = wallDrag.y0 + dy * (i / (n || 1));
        ctx.fillStyle = (!placementBlocked(PLAYER, 'wall', x, y) && withinBuildRadius(PLAYER, x, y)) ? '#4da3ff' : '#ff5f5f';
        ctx.fillRect(x - t.w / 2, y - t.h / 2, t.w, t.h);
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
    ctx.restore();
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
  for (const b of state.buildings) {
    if (b.hp <= 0 || !visibleToPlayer(b)) continue;
    mmCtx.fillStyle = COLORS[b.owner];
    mmCtx.fillRect(b.x * sx - 3, b.y * sy - 3, 6, 6);
  }
  for (const u of state.units) {
    if (u.hp <= 0 || u.garrisoned || !visibleToPlayer(u)) continue;
    mmCtx.fillStyle = (u.disguised && u.owner !== PLAYER) ? COLORS[PLAYER] : COLORS[u.owner];
    mmCtx.fillRect(u.x * sx - 1, u.y * sy - 1, 2, 2);
  }
  // fog overlay: reuse the main fog canvas, stretched onto the minimap
  mmCtx.drawImage(fogCanvas, 0, 0, FW, FH, 0, 0, mmCanvas.width, mmCanvas.height);
  // radar intel passives pierce the fog: flat sees enemy air, hollow sees enemy ground
  const pf = state.factions[PLAYER];
  if (pf === 'flat' || pf === 'hollow') {
    for (const u of state.units) {
      if (u.owner === PLAYER || u.hp <= 0 || u.disguised) continue;
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

function checkGameOver() {
  const playerHq = state.buildings.some(b => b.owner === PLAYER && b.type === 'hq' && b.hp > 0);
  const enemyHq = state.buildings.some(b => b.owner !== PLAYER && b.type === 'hq' && b.hp > 0);
  if (playerHq && enemyHq) return;
  state.over = true;
  const el = document.getElementById('overlay-text');
  el.textContent = playerHq ? 'VICTORY! The truth is yours.' : 'DEFEAT';
  el.style.color = playerHq ? '#7fff9f' : '#ff6b5f';
  document.getElementById('overlay').classList.remove('hidden');
  eva(playerHq ? 'Mission accomplished' : 'Battle control terminated');
}

function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (started && !state.over) {
    const pan = 520 * dt / cam.zoom;
    if (keys['arrowleft']) cam.x -= pan;
    if (keys['arrowright']) cam.x += pan;
    if (keys['arrowup']) cam.y -= pan;
    if (keys['arrowdown']) cam.y += pan;
    clampCam();

    state.time += dt;
    ensurePathGrid();
    pathBudget = 12; // A* computations allowed this frame (rest retry later)
    rebuildSepGrid();
    for (const u of state.units) if (u.hp > 0) updateUnit(u, dt);
    updateTransits();
    for (const b of state.buildings) if (b.hp > 0) updateBuilding(b, dt);
    tickConstruction(PLAYER, dt);
    for (const o of OWNERS) if (o !== PLAYER) updateAI(o, dt);
    updateAbilities(dt);
    updateProjectiles(dt);
    updateZones(dt);
    for (const u of state.units) {
      if (u.expires && state.time > u.expires) u.hp = 0; // phantoms & hatchlings fade
      // mind-controlled units revert to their real owner when the coup lapses
      if (u.coupRevert && state.time > u.coupRevert && u.hp > 0) {
        if (u.coupOrig !== undefined && state.factions[u.coupOrig]) {
          u.owner = u.coupOrig;
          u.order = { type: 'idle' };
        }
        delete u.coupRevert; delete u.coupOrig;
      }
    }
    updateFog();

    // destruction effects
    for (const b of state.buildings) {
      if (b.hp <= 0) {
        Particles.boom(b.x, b.y, 1.7);
        if (tileState(b.x, b.y) === 2) sfx('boom');
        if (b.owner === PLAYER && !bstatsOf(b).trip) eva('Structure lost'); // mines die loudly enough
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
    const nBld = state.buildings.length;
    state.buildings = state.buildings.filter(b => b.hp > 0);
    if (state.buildings.length !== nBld) markPathDirty(); // rubble opens lanes
    Particles.update(dt);

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
    if (panelTimer > 0.25) { panelTimer = 0; refreshSidebar(); refreshPanel(); }
  }

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
    if (superTargeting) {
      const sw = state.buildings.find(b => b.id === superTargeting && b.owner === PLAYER && b.hp > 0);
      superTargeting = null;
      if (sw && superReady(sw) && !isOffline(sw)) { fireSuperweapon(sw, p.x, p.y); sfx('click'); }
      refreshPanel();
      return;
    }
    if (abilityTargeting) {
      const mode = abilityTargeting;
      abilityTargeting = null;
      if (mode === 'zone') castWeather(PLAYER, p.x, p.y);
      if (mode === 'unit') {
        const target = state.units.find(u => u.owner === PLAYER && u.hp > 0 && !u.garrisoned && clickHitsUnit(u, p.x, p.y, 8));
        if (target) castClone(PLAYER, target);
      }
      refreshPanel();
      refreshSidebar();
      return;
    }
    if (plantArmed) {
      plantArmed = false;
      // the nearest ready infantryman walks over and buries one IED
      const sappers = selection.filter(u => u.kind === 'unit' && u.owner === PLAYER && u.hp > 0 &&
        UNIT_TYPES[u.type].plantMine && !u.planted);
      if (sappers.length) {
        sappers.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
        sappers[0].order = { type: 'plant', x: p.x, y: p.y };
        sfx('click');
      } else {
        eva('No IED ready');
      }
      refreshPanel();
      return;
    }
    if (placing) {
      // RA2-style walls lay in stretches: press-drag lays a whole run at once
      // (committed on mouseup). Gates place one at a time.
      if (placing === 'wall') {
        wallDrag = { x0: Math.round(p.x / WALL_STEP) * WALL_STEP, y0: Math.round(p.y / WALL_STEP) * WALL_STEP };
        return;
      }
      const instant = bstats(PLAYER, placing).instant;
      if (tryPlace(PLAYER, p.x, p.y)) {
        sfx('click');
        // gates stay armed so you can drop several; stop when dry or capped
        if (!instant || state.minerals[PLAYER] < bstats(PLAYER, placing).cost || atStructCap(PLAYER, placing)) {
          placing = null;
        }
        refreshPanel(); refreshSidebar();
      }
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
    // drag-select box lives in iso screen space (stays screen-axis-aligned;
    // in world space it is a parallelogram — units are tested by their
    // projected position, which is the same thing)
    const pi = screenToIso(e);
    mouse.sel = { x1: pi.x, y1: pi.y, x2: pi.x, y2: pi.y };
  } else if (e.button === 2) {
    if (placing || attackMoveArmed || abilityTargeting || superTargeting || plantArmed || wallDrag) {
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
  if (wallDrag) { commitWallLine(wallDrag.x0, wallDrag.y0, mouse.x, mouse.y); wallDrag = null; return; }
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
    const hit = state.units.find(u => u.owner === PLAYER && u.hp > 0 && !u.garrisoned && clickHitsUnit(u, w.x, w.y, 4));
    if (dbl && hit) {
      selection = state.units.filter(u => u.owner === PLAYER && u.hp > 0 && !u.garrisoned && u.type === hit.type && onScreen(u));
      sfx('click');
    } else {
      selectAt(w.x, w.y);
    }
  } else {
    // the box is iso-screen-aligned: test each unit's DRAWN position
    // (airborne sprites ride FLY_H above their ground point)
    let picked = state.units.filter(u => {
      if (u.owner !== PLAYER || u.hp <= 0 || u.garrisoned) return false;
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
    const gbld = state.buildings.filter(b => b.owner === PLAYER && b.hp > 0 && b.garrison && b.garrison.length && bstatsOf(b).slots &&
      (() => { const px = isoX(b.x, b.y), py = isoY(b.x, b.y); return px >= x1 && px <= x2 && py >= y1 && py <= y2; })());
    if (gbld.length) selection = selection.concat(gbld);
  }
  refreshPanel();
});

window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;
  if (!started) return;
  const k = e.key.toLowerCase();

  if (e.key === 'Escape') { placing = null; attackMoveArmed = false; abilityTargeting = null; superTargeting = null; plantArmed = false; wallDrag = null; refreshPanel(); }
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

  if (k === 'e' && selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].plantMine && !s.planted)) {
    plantArmed = true;
    attackMoveArmed = false;
    refreshPanel();
  }

  if (k === 'x') toggleBurrowSelection();

  if (k === 'v' && selection.some(s => s.kind === 'unit' && UNIT_TYPES[s.type].role === 'scout')) exploreSelection();

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
const gridStructures = document.getElementById('grid-structures');
const gridUnits = document.getElementById('grid-units');
const elSelInfo = document.getElementById('selinfo');
const elActions = document.getElementById('actions');
const elSupply = document.getElementById('supply');

// ---------- faction select + main loop ----------

let selectedSize = 'medium';
let selectedOpponents = 1;
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
    selectedOpponents = Math.min(selectedOpponents, max);
    for (const [key, btn] of Object.entries(sizeBtns)) {
      btn.classList.toggle('sel', key === selectedSize);
    }
    oppWrap.innerHTML = '';
    for (let n = 1; n <= max; n++) {
      const b = document.createElement('button');
      b.className = 'opt-btn' + (n === selectedOpponents ? ' sel' : '');
      b.textContent = n;
      b.addEventListener('click', () => { selectedOpponents = n; refresh(); });
      oppWrap.appendChild(b);
    }
  }

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
      btn.addEventListener('click', () => startGame(key));
      col.appendChild(btn);
    }
    wrap.appendChild(col);
  }
})();

let lastTime = performance.now();
let panelTimer = 0;
let wasLowPower = false;

requestAnimationFrame(rafLoop);
