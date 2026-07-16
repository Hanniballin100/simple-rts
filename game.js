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
let panDrag = null;          // middle- or right-mouse camera drag
let mmDown = false;          // dragging on minimap
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

function enemiesOf(owner) {
  return state.units.filter(u => u.owner !== owner && u.hp > 0 && !u.garrisoned)
    .concat(state.buildings.filter(b => b.owner !== owner && b.owner !== NEUTRAL && b.hp > 0));
}

function entityRadius(e) {
  return e.w ? Math.max(e.w, e.h) / 2 : UNIT_TYPES[e.type].r;
}

function canTarget(stats, target) {
  if (!stats.dmg) return false;
  const isAir = target.kind === 'unit' && UNIT_TYPES[target.type].flying;
  const t = stats.targets || 'ground';
  return isAir ? (t === 'air' || t === 'both') : (t === 'ground' || t === 'both');
}

function powerOf(owner) {
  let cap = 0, used = 0;
  for (const b of state.buildings) {
    if (b.owner !== owner || b.hp <= 0 || !b.done) continue;
    const p = bstatsOf(b).power || 0;
    if (p > 0) cap += p; else used -= p;
  }
  return { cap, used, low: used > cap };
}

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
    if (u.owner === PLAYER && u.hp > 0 && !u.garrisoned) markSight(u.x, u.y, UNIT_TYPES[u.type].sight);
  }
  for (const b of state.buildings) {
    if (b.owner === PLAYER && b.hp > 0) markSight(b.x, b.y, bstatsOf(b).sight);
  }
}

function visibleToPlayer(e) {
  if (e.owner === PLAYER) return true;
  const t = tileState(e.x, e.y);
  return e.kind === 'building' ? t >= 1 : t === 2;
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
  return b;
}

function makePatch(x, y, amount = 900) {
  state.patches.push({ id: nextId++, kind: 'patch', x, y, amount });
}

function setupWorld(map) {
  mapDecor = map.decor || [];
  initFog();
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
  cam.x = hq.x - canvas.width / cam.zoom / 2;
  cam.y = hq.y - canvas.height / cam.zoom / 2;
  clampCam();
}

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
  const cost = bstats(owner, type).cost;
  if (state.minerals[owner] < cost) return false;
  state.minerals[owner] -= cost;
  state.construction[owner] = { type, t: 0, duration: bstats(owner, type).buildTime, ready: false, announced: false };
  return true;
}

function placementBlocked(owner, type, x, y) {
  const t = bstats(owner, type);
  if (x - t.w / 2 < 10 || y - t.h / 2 < 10 || x + t.w / 2 > WORLD_W - 10 || y + t.h / 2 > WORLD_H - 10) return true;
  return state.buildings.some(b => b.hp > 0 &&
      Math.abs(b.x - x) < (b.w + t.w) / 2 + 8 && Math.abs(b.y - y) < (b.h + t.h) / 2 + 8)
    || state.patches.some(p => p.amount > 0 && dist(p, { x, y }) < t.w / 2 + 30)
    || TERRAIN.some(o => dist(o, { x, y }) < o.r + Math.max(t.w, t.h) / 2 + 6);
}

function withinBuildRadius(owner, x, y) {
  return state.buildings.some(b => b.owner === owner && b.hp > 0 && b.done &&
    (b.type === 'hq' || b.type === 'powerplant') && dist(b, { x, y }) <= BUILD_RADIUS);
}

function tryPlace(owner, x, y) {
  const c = state.construction[owner];
  if (!c || !c.ready) return false;
  if (placementBlocked(owner, c.type, x, y) || !withinBuildRadius(owner, x, y)) return false;
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

function moveToward(u, tx, ty, dt, stopDist = 2, ignoreId = null) {
  const d = Math.hypot(tx - u.x, ty - u.y);
  if (d <= stopDist) return true;
  const t = UNIT_TYPES[u.type];
  let speed = t.speed;
  // rain/storm zones slow ground units; a tractor beam slows anything it holds
  if (!t.flying) {
    for (const z of state.zones) {
      if ((z.kind === 'rain' || z.kind === 'storm') && z.caster !== u.owner && dist(z, u) <= z.r) { speed *= 0.6; break; }
    }
    // pushing through a forest is slow going
    for (const o of TERRAIN) {
      if (TERRAIN_TYPES[o.type].passes && dist(o, u) <= o.r) { speed *= TERRAIN_TYPES[o.type].slow; break; }
    }
  }
  if (u.slowUntil && u.slowUntil > state.time) speed *= 0.55;
  const step = Math.min(speed * dt, d);
  let nx = u.x + (tx - u.x) / d * step;
  let ny = u.y + (ty - u.y) / d * step;

  // committed building detour: keep heading for the chosen corner even on
  // frames where the direct step wouldn't collide, or the unit flip-flops
  // between corner-seeking and target-seeking at the footprint's rim
  if (!t.flying && u.dodge) {
    if (Math.abs(u.dodge.tx - tx) > 40 || Math.abs(u.dodge.ty - ty) > 40 ||
        !state.buildings.some(b => b.id === u.dodge.bld && b.hp > 0)) {
      delete u.dodge; // destination changed or building died: re-plan
    } else {
      const dd = Math.hypot(u.dodge.x - u.x, u.dodge.y - u.y);
      if (dd <= step) {
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
    const hits = (x, y) => TERRAIN.some(o => !TERRAIN_TYPES[o.type].passes && Math.hypot(x - o.x, y - o.y) < o.r + t.r);
    const ob = TERRAIN.find(o => !TERRAIN_TYPES[o.type].passes && Math.hypot(nx - o.x, ny - o.y) < o.r + t.r);
    if (ob) {
      // destination sits inside the obstacle and we're touching it: close enough
      if (Math.hypot(tx - ob.x, ty - ob.y) < ob.r + t.r &&
          Math.hypot(u.x - ob.x, u.y - ob.y) < ob.r + t.r + 6) { delete u.veer; return true; }
      const away = Math.atan2(u.y - ob.y, u.x - ob.x);
      const desired = Math.atan2(ty - u.y, tx - u.x);
      const diff = a => Math.abs(((a - desired + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      // commit to one side of this rock: when the target sits straight behind it
      // the two ways around score nearly equal, and re-picking every frame left
      // units grinding in place against the rim
      if (!u.veer || u.veer.ob !== ob.seed || Math.abs(u.veer.tx - tx) > 40 || Math.abs(u.veer.ty - ty) > 40) {
        u.veer = { ob: ob.seed, side: diff(away + Math.PI / 2) < diff(away - Math.PI / 2) ? 1 : -1, tx, ty };
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
      const bld = state.buildings.find(b => b.hp > 0 && b.id !== ignoreId &&
        Math.abs(nx - b.x) < b.w / 2 + t.r && Math.abs(ny - b.y) < b.h / 2 + t.r);
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
            Math.abs(u.dodge.tx - tx) > 40 || Math.abs(u.dodge.ty - ty) > 40) {
          // a corner we can't reach in a straight line is no corner at all
          // (unless we're stuck inside — then any exit goes); a corner whose
          // ONWARD leg crosses just means another corner gets rounded after it,
          // so that only costs a mild penalty
          const cross = (x1, y1, x2, y2) => segHitsRect(x1, y1, x2, y2, bld.x, bld.y, ex - 2, ey - 2);
          let best = null, bestCost = Infinity;
          for (const sx2 of [-1, 1]) {
            for (const sy2 of [-1, 1]) {
              const c = { x: bld.x + sx2 * (ex + 8), y: bld.y + sy2 * (ey + 8) };
              const cost = Math.hypot(c.x - u.x, c.y - u.y) + Math.hypot(tx - c.x, ty - c.y)
                + (cross(u.x, u.y, c.x, c.y) ? 1e5 : 0)
                + (cross(c.x, c.y, tx, ty) ? (ex + ey) * 2 : 0);
              if (cost < bestCost) { bestCost = cost; best = c; }
            }
          }
          u.dodge = { bld: bld.id, x: best.x, y: best.y, tx, ty };
        }
        const dd = Math.hypot(u.dodge.x - u.x, u.dodge.y - u.y);
        nx = u.x + (u.dodge.x - u.x) / (dd || 1) * Math.min(step, dd);
        ny = u.y + (u.dodge.y - u.y) / (dd || 1) * Math.min(step, dd);
        if (dd <= step) delete u.dodge; // corner rounded; aim at the target again
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
  const px = u.x, py = u.y;
  u.x = clamp(nx, 10, WORLD_W - 10);
  u.y = clamp(ny, 10, WORLD_H - 10);
  const mdx = u.x - px, mdy = u.y - py;
  if (Math.abs(mdx) > 0.01 || Math.abs(mdy) > 0.01) {
    u.facing = Math.atan2(mdy, mdx);
    u.travel += Math.hypot(mdx, mdy);
  }
  return false;
}

function dealDamage(attacker, target, dmg, stats) {
  // grey superior metallurgy: buildings ignore anti-building bonuses
  if (target.kind === 'building' && stats.bldgBonus && state.factions[target.owner] !== 'grey') {
    dmg *= stats.bldgBonus;
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

function spawnProjectile(kind, x, y, tx, ty, owner, stats) {
  const d = Math.hypot(tx - x, ty - y);
  state.projectiles.push({
    kind, sx: x, sy: y, x, y, tx, ty, owner, stats,
    t: 0, dur: kind === 'bomb' ? 0.55 : Math.max(0.35, d / 260),
    arc: kind === 'bomb' ? 26 : clamp(d * 0.18, 18, 55),
  });
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
        if (p.trail <= 0) { p.trail = 0.05; Particles.smoke(p.x, p.y, 1.6); }
      }
      continue;
    }
    p.t += dt;
    if (p.t >= p.dur) {
      p.done = true;
      const s = p.stats;
      splashDamage(p.tx, p.ty, s.splash || 36, s.dmg, p.owner, s);
      Particles.boom(p.tx, p.ty, p.kind === 'bomb' ? 1.1 : 0.85);
      if (tileState(p.tx, p.ty) === 2) sfx('boom');
      if (s.groundEffect) {
        state.zones.push({
          x: p.tx, y: p.ty, r: s.groundEffect.r, until: state.time + s.groundEffect.dur,
          caster: p.owner, kind: s.groundEffect.kind, dps: s.groundEffect.dps,
        });
      }
    } else {
      const f = p.t / p.dur;
      p.x = p.sx + (p.tx - p.sx) * f;
      p.y = p.sy + (p.ty - p.sy) * f - Math.sin(Math.PI * f) * p.arc;
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
        Particles.bolt(bx + 12, by - 46, bx, by);
        splashDamage(bx, by, 24, z.dmg || 15, z.caster, {}, true); // the storm doesn't care what flies
        if (tileState(bx, by) === 2) sfx('boom');
      }
    } else if (z.kind === 'fire' || z.kind === 'toxin') {
      z.tick = (z.tick || 0) - dt;
      if (z.tick <= 0) {
        z.tick = 0.4;
        for (const u of state.units) {
          if (u.owner === z.caster || u.hp <= 0 || u.garrisoned || UNIT_TYPES[u.type].flying) continue;
          if (dist(u, z) <= z.r + UNIT_TYPES[u.type].r) u.hp -= (z.dps || 5) * 0.4;
        }
      }
    }
  }
}

function tryAttack(u, target, dt) {
  const t = UNIT_TYPES[u.type];
  const range = t.atkRange + entityRadius(target);
  const d = dist(u, target);
  if (d > range) {
    moveToward(u, target.x, target.y, dt, range - 4, target.kind === 'building' ? target.id : null);
    return;
  }
  u.facing = Math.atan2(target.y - u.y, target.x - u.x);
  if (t.minRange && d < t.minRange) return; // artillery: too close to fire
  if (t.maxAmmo && u.ammo <= 0) { u.order = { type: 'rearm' }; return; } // winchester — RTB
  if (u.cooldown <= 0) {
    const isAir = target.kind === 'unit' && UNIT_TYPES[target.type].flying;
    const dmg = (!isAir && t.dmgVsGround !== undefined) ? t.dmgVsGround : t.dmg;
    u.disguised = false; // skin suit drops the moment they open fire
    u.cooldown = t.cooldown;
    if (t.maxAmmo) u.ammo--;
    const a = u.facing;
    const visible = tileState(u.x, u.y) === 2 || tileState(target.x, target.y) === 2;
    const wkind = t.weapon || 'gun';

    if (wkind === 'bomb' || wkind === 'lob') {
      // physical projectile: aimed at where the target IS — it can be dodged
      spawnProjectile(wkind === 'bomb' ? 'bomb' : (t.projectile || 'rock'),
        u.x, u.y, target.x, target.y, u.owner, t);
      if (visible) sfx('shot');
    } else if (wkind === 'storm') {
      state.zones.push({ x: target.x, y: target.y, r: 60, until: state.time + 3, caster: u.owner, kind: 'storm', dmg: t.dmg });
      if (visible) sfx('laser');
    } else {
      dealDamage(u, target, dmg, t);
      if (t.jams && isAir) target.slowUntil = state.time + 0.6; // scrambled avionics
      Particles.shot(u.x + Math.cos(a) * (t.r + 2), u.y + Math.sin(a) * (t.r + 2),
        target.x, target.y, WEAPON_STYLE[state.factions[u.owner]]);
      if (wkind === 'spray' && t.groundEffect && !isAir) {
        state.zones.push({
          x: target.x, y: target.y, r: t.groundEffect.r, until: state.time + t.groundEffect.dur,
          caster: u.owner, kind: t.groundEffect.kind, dps: t.groundEffect.dps,
        });
      }
      if (visible) sfx(state.factions[u.owner] === 'glob' ? 'laser' : 'shot');
      if (target.hp <= 0 && u.order.type === 'attack') u.order = { type: 'idle' };
    }
  }
}

function autoAcquire(u) {
  const t = UNIT_TYPES[u.type];
  if (t.maxAmmo && u.ammo <= 0) return; // nothing left to shoot with
  const foe = nearest(u, enemiesOf(u.owner), e =>
    !e.disguised && canTarget(t, e) && dist(u, e) <= t.sight && dist(u, e) >= (t.minRange || 0));
  if (foe) orderAttack(u, foe);
}

function depositTarget(u) {
  return nearest(u, state.buildings, b => b.owner === u.owner && b.type === 'hq' && b.hp > 0);
}

// ---------- airfield slots (RA2-style: 4 aircraft stationed per pad) ----------

function padLoad(b) {
  return state.units.filter(u => u.hp > 0 && u.homeId === b.id && UNIT_TYPES[u.type].pad).length
    + b.queue.filter(j => UNIT_TYPES[j.type].pad).length;
}

function freeSlot(b) {
  const taken = new Set(state.units
    .filter(u => u.hp > 0 && u.homeId === b.id && UNIT_TYPES[u.type].pad)
    .map(u => u.slot));
  for (let s = 0; s < PAD_CAP; s++) if (!taken.has(s)) return s;
  return 0;
}

function padSlotsFree(owner) {
  return state.buildings.some(b => b.owner === owner && b.hp > 0 && b.done &&
    b.type === 'airpad' && padLoad(b) < PAD_CAP);
}

// resolve an aircraft's home pad; adopts a new one (and slot) if the old died
function findPadFor(u) {
  let home = state.buildings.find(b => b.id === u.homeId && b.hp > 0 && b.done && b.type === 'airpad');
  if (home) return home;
  home = nearest(u, state.buildings, b => b.owner === u.owner && b.type === 'airpad' &&
    b.hp > 0 && b.done && padLoad(b) < PAD_CAP);
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

  // out of ammo: break off and return to the airfield (unless already parked —
  // a landed craft must fall through to the idle case, where it reloads)
  if (stats.maxAmmo && u.ammo <= 0 && o.type !== 'rearm' && !u.landed) {
    u.order = { type: 'rearm' };
    return;
  }

  switch (o.type) {
    case 'idle':
      if (stats.pad && u.landed) {
        // parked on the pad: top off ammo, hold position (no auto-scramble)
        if (u.ammo < stats.maxAmmo) u.ammo = Math.min(stats.maxAmmo, u.ammo + stats.maxAmmo * dt / 4);
        break;
      }
      if (stats.pad && findPadFor(u)) { u.order = { type: 'rearm' }; break; }
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
      const [ox, oy] = PAD_SLOT_POS[u.slot % PAD_CAP];
      if (moveToward(u, home.x + ox, home.y + oy, dt, 5)) {
        u.landed = true;
        u.order = { type: 'idle' };
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
      // hollow earth: walk to the nearest grid node, pop out at the destination
      const dest = findEntity(o.destId);
      if (!dest || dest.hp <= 0) { u.order = { type: 'idle' }; break; }
      const entrance = nearest(u, state.buildings, b =>
        b.owner === u.owner && b.hp > 0 && b.done && (b.type === 'hq' || b.type === 'powerplant'));
      if (!entrance) { u.order = { type: 'idle' }; break; }
      if (moveToward(u, entrance.x, entrance.y, dt, entityRadius(entrance) + 8, entrance.id)) {
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
      if (moveToward(u, hq.x, hq.y, dt, entityRadius(hq) + 12, hq.id)) {
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
      if (moveToward(u, depot.x, depot.y, dt, stop, depot.id)) {
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
  // aircraft parked on a pad hold their slot
  if (u.landed) return;
  const myFlying = !!stats.flying;
  for (const other of state.units) {
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

function trainUnit(owner, unitType) {
  const ut = UNIT_TYPES[unitType];
  let trainers = state.buildings.filter(b =>
    b.owner === owner && b.hp > 0 && b.done && b.type === ut.builtAt && b.queue.length < 5);
  if (ut.pad) trainers = trainers.filter(b => padLoad(b) < PAD_CAP); // needs a free pad slot
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
      const foe = nearest(b, enemiesOf(b.owner), e => !e.disguised &&
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
            foe.x, foe.y, 'bullet');
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
        const victims = state.units.filter(u => u.owner !== b.owner && u.hp > 0 && !u.disguised &&
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
        const foe = nearest(b, enemiesOf(b.owner), e => !e.disguised && canTarget(bt, e) && dist(b, e) <= bt.atkRange + entityRadius(e));
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
            cur = nearest(prev, state.units, un => un.owner !== b.owner && un.hp > 0 && !un.disguised &&
              !UNIT_TYPES[un.type].flying && !hit.has(un.id) && dist(prev, un) <= 85);
          }
          if (tileState(b.x, b.y) === 2 || tileState(foe.x, foe.y) === 2) sfx('laser');
        }
      }
    } else if (wkind === 'missile') {
      // patriot battery: launches a visible homing missile
      if (b.cooldown <= 0) {
        const foe = nearest(b, state.units, un => un.owner !== b.owner && un.hp > 0 &&
          !un.disguised && !un.garrisoned && canTarget(bt, un) &&
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
      if (!tgt || tgt.disguised || !canTarget(bt, tgt) || dist(b, tgt) > bt.atkRange + entityRadius(tgt) + 12) {
        tgt = nearest(b, state.units, un => un.owner !== b.owner && un.hp > 0 && !un.disguised &&
          canTarget(bt, un) && dist(b, un) <= bt.atkRange + entityRadius(un));
      }
      if (tgt) {
        b.beamId = tgt.id;
        b.turret = Math.atan2(tgt.y - b.y, tgt.x - b.x);
        if (b.cooldown <= 0) {
          b.cooldown = bt.cooldown;
          dealDamage(b, tgt, bt.dmg, bt);
          tgt.slowUntil = state.time + 0.25;
        }
      } else {
        b.beamId = null;
      }
    } else if (b.cooldown <= 0) {
      const foe = nearest(b, enemiesOf(b.owner), e => !e.disguised && canTarget(bt, e) && dist(b, e) <= bt.atkRange + entityRadius(e));
      if (foe) {
        dealDamage(b, foe, bt.dmg, bt);
        b.cooldown = bt.cooldown;
        b.turret = Math.atan2(foe.y - b.y, foe.x - b.x);
        Particles.shot(b.x + Math.cos(b.turret) * 10, b.y + Math.sin(b.turret) * 10,
          foe.x, foe.y, WEAPON_STYLE[state.factions[b.owner]]);
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
    const ut = UNIT_TYPES[job.type];
    if (b.type === 'airpad') u.homeId = b.id; // aircraft remember their airfield
    if (ut.pad) u.slot = freeSlot(b);         // claim a parking slot on it
    if (b.owner === PLAYER) eva('Unit ready');
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
    ? ['barracks', 'powerplant', f.tower, 'powerplant', 'factory', f.aaTower, 'powerplant', 'airpad', 'powerplant', 'barracks', f.tower, 'powerplant', f.aaTower]
    : ['barracks', f.tower, 'factory', f.aaTower, 'airpad', 'barracks', f.tower, f.aaTower];
  const want = {};
  for (const t of order) {
    want[t] = (want[t] || 0) + 1;
    if ((counts[t] || 0) < want[t] && !atStructCap(owner, t)) return t;
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

  // workers (income factions have none to train)
  if (f.worker && workers.length < f.economy.workers &&
      state.minerals[owner] >= UNIT_TYPES[f.worker].cost + reserve) {
    trainUnit(owner, f.worker);
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
  const threat = nearest(hq, state.units.filter(u => u.owner !== owner && u.hp > 0 && !u.garrisoned), u => !u.disguised && dist(hq, u) < 450);
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
      || nearest(hq, state.units.filter(u => u.owner !== owner && u.hp > 0 && !u.disguised && !u.garrisoned));
    if (target) {
      for (const s of idleArmy) orderAttackMove(s, target.x, target.y);
      ai.attackWaveSize = Math.min(12, ai.attackWaveSize + 1);
    }
  }
}

function screenToWorld(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) / cam.zoom + cam.x,
    y: (e.clientY - r.top) / cam.zoom + cam.y,
  };
}

function selectAt(x, y) {
  const u = state.units.find(u => u.owner === PLAYER && u.hp > 0 && !u.garrisoned && dist(u, { x, y }) <= UNIT_TYPES[u.type].r + 4);
  const b = state.buildings.find(b => b.owner === PLAYER && b.hp > 0 &&
    Math.abs(b.x - x) <= b.w / 2 && Math.abs(b.y - y) <= b.h / 2);
  // no own entity under the cursor: inspect a visible enemy instead
  // (disguised infiltrators are excluded — clicking would blow their cover)
  const eu = !u && !b && state.units.find(un => un.owner !== PLAYER && un.hp > 0 && !un.disguised && !un.garrisoned &&
    visibleToPlayer(un) && dist(un, { x, y }) <= UNIT_TYPES[un.type].r + 4);
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

function minimapPan(e) {
  const r = mmCanvas.getBoundingClientRect();
  const wx = (e.clientX - r.left) / r.width * WORLD_W;
  const wy = (e.clientY - r.top) / r.height * WORLD_H;
  cam.x = wx - canvas.width / cam.zoom / 2;
  cam.y = wy - canvas.height / cam.zoom / 2;
  clampCam();
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
  const c = state.construction[PLAYER];
  if (c && c.ready && c.type === type) { placing = type; refreshPanel(); return; }
  if (c) { eva('Unable to comply, building in progress'); return; }
  if (atStructCap(PLAYER, type)) { eva('Build limit reached'); return; }
  if (state.minerals[PLAYER] < bstats(PLAYER, type).cost) { eva('Insufficient funds'); return; }
  startConstruction(PLAYER, type);
  sfx('click');
  refreshSidebar();
}

function sidebarUnitClick(type) {
  const ut = UNIT_TYPES[type];
  const hasTrainer = state.buildings.some(b => b.owner === PLAYER && b.hp > 0 && b.done && b.type === ut.builtAt);
  if (!hasTrainer) { eva(`Requires ${facOf(PLAYER).buildingNames[ut.builtAt] || ut.builtAt}`); return; }
  if (ut.pad && !padSlotsFree(PLAYER)) { eva('Airfields at capacity'); return; }
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
    makeCameo(gridStructures, 's:' + s, f.buildingNames[s] || s, bstats(PLAYER, s).cost, () => sidebarStructureClick(s));
  }
  // worker-less factions have no worker cameo — their buildings pay the bills
  const unitList = [f.worker, f.infantry, f.aa, f.extras[0], f.vehicle, f.extras[1], ...f.air, f.extras[2]].filter(Boolean);
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
      const cap = bstats(PLAYER, type).cap;
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
        elActions.appendChild(btn);
      }
      return;
    }
    elSelInfo.textContent = `${buildingName(first)} — ${Math.ceil(first.hp)}/${bt.hp} HP` +
      (first.queue.length ? ` — training (${first.queue.length} queued)` : '') +
      ' — right-click to set rally point';
  } else {
    const counts = {};
    for (const s of selection) counts[UNIT_TYPES[s.type].name] = (counts[UNIT_TYPES[s.type].name] || 0) + 1;
    let info = 'Selected: ' + Object.entries(counts).map(([n, c]) => `${c}× ${n}`).join(', ');
    if (selection.length === 1 && selection[0].kind === 'unit') {
      const uu = selection[0], ut = UNIT_TYPES[uu.type];
      info += ` — ${Math.ceil(uu.hp)}/${ut.hp} HP`;
      if (ut.maxAmmo) info += ` — Ammo ${Math.floor(uu.ammo)}/${ut.maxAmmo}${uu.order.type === 'rearm' ? ' (rearming)' : ''}`;
    }
    elSelInfo.textContent = info;
    if (selection.some(s => UNIT_TYPES[s.type].role === 'combat')) {
      const btn = document.createElement('button');
      btn.textContent = 'Attack-Move [A]';
      btn.onclick = () => { attackMoveArmed = true; refreshPanel(); };
      elActions.appendChild(btn);
    }
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!started) return;
  ctx.save();
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  ctx.drawImage(groundCanvas, 0, 0, WORLD_W, WORLD_H);

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
    const bt = bstatsOf(b);
    ctx.save();
    ctx.translate(b.x, b.y);
    Art.building(b.type, ctx, state.time + (b.id % 89) * 0.71, {
      w: b.w, h: b.h, color: COLORS[b.owner], on: !powerOf(b.owner).low,
      fam: FAMILY_STYLE[state.factions[b.owner]], wx: b.x, wy: b.y,
    });
    ctx.restore();

    if (bt.dmg && bt.weapon !== 'pulse') {
      const on = !powerOf(b.owner).low;
      const ta = b.turret !== undefined ? b.turret : Math.atan2(WORLD_H / 2 - b.y, WORLD_W / 2 - b.x);
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.fillStyle = on ? '#c6ccd4' : '#666';
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
      ctx.rotate(ta);
      ctx.strokeStyle = on ? '#e8edf2' : '#777';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(bt.targets === 'air' ? 10 : 12, 0); ctx.stroke();
      ctx.restore();
      if (bt.targets === 'air') {
        ctx.strokeStyle = on ? '#fff' : '#666';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(b.x - 4, b.y - b.h / 2 - 7);
        ctx.lineTo(b.x, b.y - b.h / 2 - 12);
        ctx.lineTo(b.x + 4, b.y - b.h / 2 - 7);
        ctx.stroke();
      }
    }
    if (selection.includes(b)) {
      ctx.strokeStyle = b.owner === PLAYER ? '#7fff9f' : '#ff8f8f';
      ctx.lineWidth = 2;
      ctx.strokeRect(b.x - b.w / 2 - 3, b.y - b.h / 2 - 3, b.w + 6, b.h + 6);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(buildingName(b), b.x, b.y + b.h / 2 + 18);
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
    // occupancy pips for garrisoned structures
    if (b.garrison && b.garrison.length) {
      for (let i = 0; i < b.garrison.length; i++) {
        ctx.fillStyle = COLORS[b.owner];
        ctx.fillRect(b.x - b.garrison.length * 4 + i * 8 + 1, b.y - b.h / 2 - 16, 6, 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x - b.garrison.length * 4 + i * 8 + 1, b.y - b.h / 2 - 16, 6, 5);
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
      if (u.hp <= 0 || u.garrisoned || !visibleToPlayer(u)) continue;
      const t = UNIT_TYPES[u.type];
      if (!!t.flying !== flyingPass) continue;

      // reptilian skin suit: enemy infantry render in YOUR color until they attack
      const drawCol = (u.disguised && u.owner !== PLAYER) ? COLORS[PLAYER] : COLORS[u.owner];
      const grounded = !!u.landed; // rearming on the pad
      const bob = (t.flying && !grounded) ? Math.sin(state.time * 2.4 + u.id) * 2.5 : 0;
      ctx.save();
      ctx.translate(u.x, u.y + bob);
      // your own gaslight phantoms look ghostly to you; enemy ones look real
      if (u.type === 'phantom' && u.owner === PLAYER) ctx.globalAlpha = 0.4;
      if (t.flying && !grounded) Art.shadow(ctx, t.r * 0.9, t.r * 0.45, 8, 13 - bob);
      else Art.shadow(ctx, t.r * 1.15, t.r * 0.75, 0, 1.5);
      Art.teamGlow(ctx, t.r + 8, drawCol);
      ctx.rotate(u.facing || 0);
      Art.draw(u.type, ctx, state.time + (u.id % 97) * 0.63, {
        color: drawCol,
        moving: u.order.type !== 'idle',
        firing: u.cooldown > t.cooldown - 0.15,
        dist: u.travel,
      });
      ctx.restore();
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
      if (t.maxAmmo && (u.ammo < t.maxAmmo || selection.includes(u))) {
        const w = t.r * 2.2;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(u.x - w / 2, u.y + t.r + 5, w, 3);
        ctx.fillStyle = '#ffd75f';
        ctx.fillRect(u.x - w / 2, u.y + t.r + 5, w * clamp(u.ammo / t.maxAmmo, 0, 1), 3);
      }
      ctx.globalAlpha = 1;
    }
  }

  // tractor beams: tower -> locked aircraft
  for (const b of state.buildings) {
    if (!b.beamId || b.hp <= 0) continue;
    const tgt = state.units.find(un => un.id === b.beamId && un.hp > 0);
    if (!tgt || !visibleToPlayer(tgt)) continue;
    const bg = ctx.createLinearGradient(b.x, b.y, tgt.x, tgt.y);
    bg.addColorStop(0, 'rgba(125,255,214,0.85)');
    bg.addColorStop(1, 'rgba(125,255,214,0.25)');
    ctx.strokeStyle = bg;
    ctx.lineWidth = 2 + Math.sin(state.time * 14) * 0.8;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(tgt.x, tgt.y); ctx.stroke();
    // pull ripples travelling down the beam
    const dx = tgt.x - b.x, dy = tgt.y - b.y;
    for (let i = 0; i < 3; i++) {
      const f = ((state.time * 0.9 + i / 3) % 1);
      ctx.fillStyle = `rgba(200,255,240,${0.7 * (1 - f)})`;
      ctx.beginPath();
      ctx.arc(tgt.x - dx * f, tgt.y - dy * f, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // projectiles in flight (with ground shadow)
  for (const p of state.projectiles) {
    if (p.kind === 'missile') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
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
    const f = p.t / p.dur;
    const gx = p.sx + (p.tx - p.sx) * f, gy = p.sy + (p.ty - p.sy) * f;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); ctx.ellipse(gx, gy, 3.5, 1.8, 0, 0, Math.PI * 2); ctx.fill();
    if (p.kind === 'rock') {
      ctx.fillStyle = '#8a7f6e';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#5c5347'; ctx.lineWidth = 1; ctx.stroke();
    } else if (p.kind === 'magma') {
      ctx.fillStyle = '#ff8a3c';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,220,120,0.9)';
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2); ctx.fill();
    } else if (p.kind === 'plasma') {
      ctx.fillStyle = 'rgba(125,255,214,0.9)';
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#e8fff8';
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.4, 0, Math.PI * 2); ctx.fill();
    } else { // bomb
      ctx.fillStyle = '#2b2f36';
      ctx.beginPath(); ctx.ellipse(p.x, p.y, 2.6, 3.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#4a515c';
      ctx.fillRect(p.x - 2.4, p.y - 5, 4.8, 2);
    }
  }

  // area-effect zones
  for (const z of state.zones) {
    const kind = z.kind || 'rain';
    if (kind === 'rain' || kind === 'storm') {
      ctx.fillStyle = kind === 'storm' ? 'rgba(60,80,130,0.22)' : 'rgba(80,130,190,0.15)';
      ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(120,170,230,0.5)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(160,200,245,0.55)'; ctx.lineWidth = 1;
      for (let i = 0; i < 14; i++) {
        const rx = z.x + Math.sin(i * 2.4) * z.r * 0.8;
        const ry = z.y + Math.cos(i * 1.9) * z.r * 0.65 + ((state.time * 130 + i * 37) % 44) - 22;
        ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 3, ry + 9); ctx.stroke();
      }
    } else if (kind === 'fire') {
      ctx.fillStyle = 'rgba(255,120,40,0.18)';
      ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 7; i++) {
        const fl = 0.5 + 0.5 * Math.sin(state.time * 9 + i * 2.3);
        ctx.fillStyle = `rgba(255,${140 + Math.floor(fl * 70)},60,${0.35 + fl * 0.45})`;
        ctx.beginPath();
        ctx.arc(z.x + Math.sin(i * 2.7) * z.r * 0.6, z.y + Math.cos(i * 1.7) * z.r * 0.6, 2 + fl * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === 'toxin') {
      ctx.fillStyle = 'rgba(130,200,80,0.16)';
      ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.fill();
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = 'rgba(160,220,110,0.22)';
        ctx.beginPath();
        ctx.arc(z.x + Math.sin(i * 2.1 + state.time * 0.7) * z.r * 0.5,
          z.y + Math.cos(i * 1.3 + state.time * 0.5) * z.r * 0.5, 5 + i, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  Particles.draw(ctx);

  // fog — written as raw pixels (black with per-tile alpha)
  const fd = new Uint32Array(fogImg.data.buffer);
  for (let i = 0; i < vis.length; i++) {
    fd[i] = vis[i] === 2 ? 0 : vis[i] === 1 ? 0x80000000 : 0xF2000000;
  }
  fogCtx.putImageData(fogImg, 0, 0);
  ctx.drawImage(fogCanvas, 0, 0, FW, FH, 0, 0, WORLD_W, WORLD_H);

  if (mouse.sel) {
    const s = mouse.sel;
    ctx.strokeStyle = '#7fff9f';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
  }

  if (placing) {
    const t = bstats(PLAYER, placing);
    const ok = !placementBlocked(PLAYER, placing, mouse.x, mouse.y) && withinBuildRadius(PLAYER, mouse.x, mouse.y);
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
  mmCtx.strokeStyle = '#cfd6dd';
  mmCtx.lineWidth = 1;
  mmCtx.strokeRect(cam.x * sx, cam.y * sy, canvas.width / cam.zoom * sx, canvas.height / cam.zoom * sy);
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
    for (const u of state.units) if (u.hp > 0) updateUnit(u, dt);
    for (const b of state.buildings) if (b.hp > 0) updateBuilding(b, dt);
    tickConstruction(PLAYER, dt);
    for (const o of OWNERS) if (o !== PLAYER) updateAI(o, dt);
    updateAbilities(dt);
    updateProjectiles(dt);
    updateZones(dt);
    for (const u of state.units) {
      if (u.expires && state.time > u.expires) u.hp = 0; // phantoms fade
    }
    updateFog();

    // destruction effects
    for (const b of state.buildings) {
      if (b.hp <= 0) {
        Particles.boom(b.x, b.y, 1.7);
        if (tileState(b.x, b.y) === 2) sfx('boom');
        if (b.owner === PLAYER) eva('Structure lost');
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
        Particles.boom(u.x, u.y, UNIT_TYPES[u.type].r > 11 ? 1 : 0.55);
      }
    }
    state.units = state.units.filter(u => u.hp > 0);
    state.buildings = state.buildings.filter(b => b.hp > 0);
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
  requestAnimationFrame(frame);
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
  // huge worlds render the ground at reduced resolution to cap memory;
  // draw() stretches it back to world size
  const gs = Math.min(1, 3600 / WORLD_W);
  groundCanvas.width = Math.round(WORLD_W * gs);
  groundCanvas.height = Math.round(WORLD_H * gs);
  const g = groundCanvas.getContext('2d');
  g.save();
  g.scale(gs, gs);
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

  // ground decals under settlements: paved plazas and crop fields
  for (const d of mapDecor) {
    if (d.kind === 'plaza') {
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
      // shaded mesa with a few boulders on top
      g.fillStyle = 'rgba(0,0,0,0.25)';
      blobPath(g, { ...o, x: o.x + 4, y: o.y + 5 }); g.fill();
      g.fillStyle = '#454b53';
      blobPath(g, o); g.fill();
      g.strokeStyle = '#2c3036'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#565d67';
      blobPath(g, { ...o, x: o.x - o.r * 0.18, y: o.y - o.r * 0.18, seed: o.seed + 5 }, 0.62); g.fill();
      const nRocks = Math.max(2, Math.round(o.r / 22));
      for (let i = 0; i < nRocks; i++) {
        const a = prand(o.seed + i * 11) * Math.PI * 2;
        const rd = prand(o.seed + i * 11 + 1) * o.r * 0.6;
        const br = 4 + prand(o.seed + i * 11 + 2) * 7;
        const bx = o.x + Math.cos(a) * rd, by = o.y + Math.sin(a) * rd;
        g.fillStyle = i % 2 ? '#5f6771' : '#3a3f46';
        g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.beginPath(); g.arc(bx - br * 0.3, by - br * 0.3, br * 0.45, 0, Math.PI * 2); g.fill();
      }
    } else if (o.type === 'forest') {
      // undergrowth blob covered in tree canopies
      g.fillStyle = '#26361f';
      blobPath(g, o, 1.08); g.fill();
      g.fillStyle = '#1e2c19';
      blobPath(g, o, 0.85); g.fill();
      const nTrees = Math.max(6, Math.round(o.r * o.r / 220));
      for (let i = 0; i < nTrees; i++) {
        const a = prand(o.seed + i * 17) * Math.PI * 2;
        const rd = Math.sqrt(prand(o.seed + i * 17 + 1)) * o.r * 0.88;
        const tr = 5 + prand(o.seed + i * 17 + 2) * 6;
        const tx = o.x + Math.cos(a) * rd, ty = o.y + Math.sin(a) * rd;
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.beginPath(); g.arc(tx + 2, ty + 2.5, tr, 0, Math.PI * 2); g.fill();
        g.fillStyle = i % 3 === 0 ? '#3c5c2e' : i % 3 === 1 ? '#2f4d26' : '#46683a';
        g.beginPath(); g.arc(tx, ty, tr, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(190,230,150,0.25)';
        g.beginPath(); g.arc(tx - tr * 0.3, ty - tr * 0.35, tr * 0.45, 0, Math.PI * 2); g.fill();
      }
    }
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
        const target = state.units.find(u => u.owner === PLAYER && u.hp > 0 && !u.garrisoned && dist(u, p) <= UNIT_TYPES[u.type].r + 8);
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
    if (placing || attackMoveArmed || abilityTargeting) {
      placing = null;
      attackMoveArmed = false;
      abilityTargeting = null;
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
  if (mouse.sel) { mouse.sel.x2 = p.x; mouse.sel.y2 = p.y; }
});

window.addEventListener('mousemove', e => {
  if (panDrag) {
    cam.x = panDrag.camX - (e.clientX - panDrag.sx) / cam.zoom;
    cam.y = panDrag.camY - (e.clientY - panDrag.sy) / cam.zoom;
    if (Math.abs(e.clientX - panDrag.sx) + Math.abs(e.clientY - panDrag.sy) > 5) panDrag.moved = true;
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
  mmDown = false;
  if (!mouse.sel) return;
  const s = mouse.sel;
  const p = screenToWorld(e);
  s.x2 = p.x;
  s.y2 = p.y;
  mouse.sel = null;
  const x1 = Math.min(s.x1, s.x2), x2 = Math.max(s.x1, s.x2);
  const y1 = Math.min(s.y1, s.y2), y2 = Math.max(s.y1, s.y2);
  if (x2 - x1 < 6 && y2 - y1 < 6) {
    selectAt(x1, y1);
  } else {
    selection = state.units.filter(u =>
      u.owner === PLAYER && u.hp > 0 && !u.garrisoned && u.x >= x1 && u.x <= x2 && u.y >= y1 && u.y <= y2);
  }
  refreshPanel();
});

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

mmCanvas.addEventListener('mousedown', e => { if (e.button === 0) { mmDown = true; minimapPan(e); } });
mmCanvas.addEventListener('mousemove', e => { if (mmDown) minimapPan(e); });

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

(function buildSetupControls() {
  const sizeWrap = document.getElementById('size-buttons');
  const oppWrap = document.getElementById('opp-buttons');
  const settingWrap = document.getElementById('setting-buttons');
  const sizeBtns = {};
  const settingBtns = {};

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

requestAnimationFrame(frame);
