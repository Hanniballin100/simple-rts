// ============================================================
// desync.js — state hashing and the self-test that proves the sim is
// deterministic. Loaded last; nothing in the game depends on it.
//
//   hashState()        -> uint32 fold of every sim-relevant field
//   Desync.begin(cfg)  -> start a match and clear the hash log
//   Desync.advance(n)  -> step n ticks, recording a hash per tick
//   Desync.compare()   -> first tick where the two logged runs disagree
//   Desync.selftest()  -> the whole double-run, in one call, for small N
//
// Runs are chunked on purpose: a 3000-tick four-AI match is more than a
// single console call wants to chew through.
// ============================================================

// ---- FNV-1a over a stream of 32-bit words ----
const _hashBuf = new ArrayBuffer(8);
const _hashF64 = new Float64Array(_hashBuf);
const _hashU32 = new Uint32Array(_hashBuf);
let _h = 0;

function hu32(v) { _h = Math.imul(_h ^ (v >>> 0), 0x01000193) >>> 0; }

function hnum(v) {
  // exact bits, so 0.1+0.2 and 0.30000000000000004 never collide, and a
  // one-ulp drift shows up as a completely different hash
  _hashF64[0] = v;
  hu32(_hashU32[0]);
  hu32(_hashU32[1]);
}

function hstr(s) {
  hu32(s.length);
  for (let i = 0; i < s.length; i++) hu32(s.charCodeAt(i));
}

// Render-only fields that live on sim entities. Everything NOT listed here is
// hashed — a deny-list, not an allow-list, because the failure mode that
// matters is a field you forgot to include, not one you included by mistake.
const HASH_SKIP = new Set([
  'sprite', 'spriteKey', 'spriteC', 'bakeT', 'lastDraw', 'drawSeed',
  'flash', 'flashT', 'hitFlash', 'muzzleT', 'shakeT', 'tracerT',
]);

// Depth-limited so an entity-to-entity reference (state.books[o].on holds a
// live unit) can't walk the whole object graph or loop forever.
function hval(v, d) {
  if (v === undefined) { hu32(0x11111111); return; }
  if (v === null) { hu32(0x22222222); return; }
  const t = typeof v;
  if (t === 'number') { hu32(0x33333333); hnum(v); return; }
  if (t === 'boolean') { hu32(v ? 0x44444444 : 0x55555555); return; }
  if (t === 'string') { hu32(0x66666666); hstr(v); return; }
  if (t === 'function') { hu32(0x77777777); return; }
  if (d > 4) { hu32(0x88888888); return; }
  if (Array.isArray(v)) {
    hu32(0x99999999); hu32(v.length);
    for (const x of v) hval(x, d + 1);
    return;
  }
  if (v instanceof Set) {
    // hashed sorted: a Set's iteration order is insertion order, and for
    // something like airTechOwners the insertion order is incidental
    hu32(0xAAAAAAAA);
    const arr = [...v].map(String).sort();
    hu32(arr.length);
    for (const x of arr) hstr(x);
    return;
  }
  if (v instanceof Map) {
    hu32(0xBBBBBBBB);
    const keys = [...v.keys()].map(String).sort();
    for (const k of keys) { hstr(k); hval(v.get(k), d + 1); }
    return;
  }
  // a reference to another entity: hash its identity only. It is hashed in
  // full exactly once, in whichever list actually owns it.
  if (d > 0 && v.id !== undefined && (v.kind !== undefined || v.maxHp !== undefined)) {
    hu32(0xCCCCCCCC); hnum(v.id);
    return;
  }
  hu32(0xDDDDDDDD);
  // sorted keys: JS object key order is insertion order, and two clients can
  // add optional fields (u.chargeUntil, u.coupOrig) in a different order
  const keys = Object.keys(v).sort();
  for (const k of keys) {
    if (HASH_SKIP.has(k)) continue;
    hstr(k);
    hval(v[k], d + 1);
  }
}

// Hash one entity in full, ignoring the reference shortcut in hval(). Used for
// the lists that OWN their entities — without this, state.units would fold
// down to a list of ids and a unit could take a thousand points of damage
// without changing the hash.
function hentity(e) {
  if (!e || typeof e !== 'object') { hval(e, 1); return; }
  hu32(0xEEEEEEEE);
  const keys = Object.keys(e).sort();
  for (const k of keys) {
    if (HASH_SKIP.has(k)) continue;
    hstr(k);
    hval(e[k], 1);
  }
}

function hlist(arr) {
  hu32(0x99999999);
  hu32(arr.length);
  // array order is itself sim state — it decides iteration order, and half the
  // game's "pick the first match" queries read straight off it
  for (const e of arr) hentity(e);
}

// The lists that own their entities. Anything else that mentions a unit or a
// building holds a reference to one of these.
const OWNED_LISTS = new Set([
  'units', 'buildings', 'patches', 'projectiles', 'zones', 'digSites', 'armorWrecks',
]);

// Everything in `state` that the simulation reads. Excluded on purpose:
// particles (Particles is a separate cosmetic system and never hashed),
// state.floats (world-space damage numbers), state.alpha (interpolation),
// the camera, the selection, the fog, and every sprite cache.
const STATE_SKIP = new Set(['floats', 'alpha']);

function hashState() {
  _h = 0x811C9DC5;

  // the RNG cursor is the point of the whole exercise: two runs can hold
  // identical entity state and still be diverging, if one of them has burned
  // a different number of draws and is about to roll differently
  const c = RNG.simCursor();
  hu32(c.s); hu32(c.n);

  hu32(state.tick);
  hu32(state.seed);
  hu32(nextId);
  hval(OWNERS, 0);

  const keys = Object.keys(state).sort();
  for (const k of keys) {
    if (STATE_SKIP.has(k)) continue;
    hstr(k);
    if (OWNED_LISTS.has(k) && Array.isArray(state[k])) hlist(state[k]);
    else hval(state[k], 0);
  }

  // Fog. It looks derived, but "explored" accumulates and persists, and the
  // sim reads it — a scout picks its next destination out of it — so it is
  // state and it can drift independently. Four tiles to a word: the grid runs
  // to 120x84 per owner and this is folded every tick.
  hstr('fog');
  for (const o of OWNERS) {
    const v = visAll[o];
    if (!v) { hu32(0xF0F0F0F0); continue; }
    hu32(v.length);
    let i = 0;
    for (; i + 3 < v.length; i += 4) hu32(v[i] | (v[i + 1] << 8) | (v[i + 2] << 16) | (v[i + 3] << 24));
    for (; i < v.length; i++) hu32(v[i]);
  }

  // the AI brains: thinkTimer, wave size and target picks are all sim state
  hstr('ais');
  for (const o of Object.keys(ais).sort((a, b) => a - b)) {
    hstr(o);
    hval(ais[o], 0);
  }

  return _h >>> 0;
}

// ---- the harness ----

const Desync = {
  log: [],       // hash per tick for the run in progress
  runs: [],      // completed logs, oldest first
  cfg: null,

  begin(cfg) {
    this.cfg = Object.assign({
      seed: 12345, faction: 'flat', size: 'medium', opponents: 3,
      supers: true, setting: 'town', script: null, as: PLAYER,
    }, cfg || {});
    const c = this.cfg;
    selectedSize = c.size;
    selectedOpponents = c.opponents;
    superweaponsOn = c.supers;
    if (typeof selectedSetting !== 'undefined') selectedSetting = c.setting;
    startGame(c.faction, c.seed);
    // `as` is which seat the local screen is sitting in. It must change
    // nothing that the hash can see — that is the whole point of viewpointTest.
    localOwner = c.as;
    this.log = [hashState()]; // tick 0: the world as generated, before any step
    return { tick: state.tick, hash: this.log[0] };
  },

  advance(n) {
    const script = this.cfg && this.cfg.script;
    for (let i = 0; i < n && !state.over; i++) {
      // the scripted "player" acts at a fixed tick, exactly as a replay would
      if (script) script(state.tick);
      stepSim();
      this.log.push(hashState());
    }
    return { tick: state.tick, over: state.over, logged: this.log.length };
  },

  // stash the finished run and clear the working log
  keep() {
    this.runs.push(this.log);
    this.log = [];
    return this.runs.length;
  },

  reset() { this.runs = []; this.log = []; },

  // first tick at which the two most recent runs disagree, or null
  compare() {
    if (this.runs.length < 2) return { error: 'need two completed runs' };
    const [a, b] = this.runs.slice(-2);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        return {
          ok: false, firstDivergenceTick: i,
          a: a[i] >>> 0, b: b[i] >>> 0,
          lenA: a.length, lenB: b.length,
        };
      }
    }
    if (a.length !== b.length) {
      return { ok: false, firstDivergenceTick: n, reason: 'run lengths differ', lenA: a.length, lenB: b.length };
    }
    return { ok: true, ticks: n, finalHash: a[n - 1] >>> 0 };
  },

  // convenience: whole double-run in one call. Fine up to a few hundred ticks;
  // past that, drive begin/advance/keep yourself in chunks.
  selftest(cfg, ticks) {
    this.reset();
    for (let r = 0; r < 2; r++) {
      this.begin(cfg);
      this.advance(ticks);
      this.keep();
    }
    return this.compare();
  },
};

// ---- the viewpoint test ----
//
// selftest() runs both matches from the same seat, so it cannot see view state
// leaking into the simulation — both runs read the same fog, the same
// selection, the same camera, and agree with each other about all of it.
//
// This runs the same match from two DIFFERENT seats. Everything about who is
// watching — fog, sound, particles, the panel — is allowed to differ; not one
// bit the hash can see is. A failure here means something the local screen
// owns has reached sim state, and it names the tick.
//
// This is the test that would have caught the scout reading the human's fog.
Desync.viewpointTest = function (cfg, ticks, seatA, seatB) {
  const a = seatA === undefined ? 0 : seatA;
  const b = seatB === undefined ? 1 : seatB;
  this.reset();
  for (const seat of [a, b]) {
    this.begin(Object.assign({}, cfg, { as: seat }));
    this.advance(ticks);
    this.keep();
  }
  const r = this.compare();
  r.seats = [a, b];
  localOwner = PLAYER; // put the screen back where it was
  return r;
};

// A scripted player, for the "same seed + same commands twice" test. It posts
// REAL commands through enqueue() at fixed ticks and resolves its targets from
// sim state only — never from the selection or the camera, which a replay
// would not have. Everything it does is something a human could do.
Desync.scriptedPlayer = function (t) {
  const hq = state.buildings.find(b => b.owner === PLAYER && b.type === 'hq' && b.hp > 0);
  if (!hq) return;
  const mine = state.units.filter(u => u.owner === PLAYER && u.hp > 0);
  const army = mine.filter(u => UNIT_TYPES[u.type].role === 'combat');
  const workers = mine.filter(u => UNIT_TYPES[u.type].role === 'worker');
  const f = FACTIONS[state.factions[PLAYER]];
  if (t === 5)   enqueue(PLAYER, 'build', { t: 'powerplant' });
  if (t === 90)  enqueue(PLAYER, 'place', { t: 'powerplant', x: hq.x + 120, y: hq.y + 90 });
  if (t === 120) enqueue(PLAYER, 'build', { t: 'barracks' });
  if (t === 260) enqueue(PLAYER, 'place', { t: 'barracks', x: hq.x - 130, y: hq.y + 100 });
  if (t === 300 && workers.length) enqueue(PLAYER, 'move', { u: workers.map(u => u.id), x: hq.x + 260, y: hq.y + 260 });
  if (t >= 320 && t < 900 && t % 40 === 0 && f.infantry) enqueue(PLAYER, 'train', { t: f.infantry });
  if (t === 400) enqueue(PLAYER, 'research', { k: 'stealth' });
  if (t === 430) enqueue(PLAYER, 'wallline', { x0: hq.x - 200, y0: hq.y - 160, x1: hq.x + 60, y1: hq.y - 160 });
  if (t === 600 && army.length) enqueue(PLAYER, 'attackmove', { u: army.map(u => u.id), x: WORLD_W / 2, y: WORLD_H / 2 });
  if (t === 750) enqueue(PLAYER, 'rally', { b: hq.id, x: hq.x + 80, y: hq.y + 160 });
  if (t === 900 && army.length) enqueue(PLAYER, 'move', { u: army.map(u => u.id), x: hq.x, y: hq.y + 200 });
};

// ---- the long proof ----
//
// The full 4-AI run is too slow for one console call (hashing a late-game
// world costs more than stepping it), so drive it in chunks. Paste these in
// order, one call each; the last one prints the verdict:
//
//   __CFG = { seed: 20260812, faction: 'flat', size: 'large',
//             opponents: 4, supers: true, setting: 'town' };
//   Desync.reset(); Desync.begin(__CFG); Desync.advance(700);
//   Desync.advance(900); Desync.advance(1100); Desync.advance(1300); Desync.keep();
//   Desync.begin(__CFG); Desync.advance(1600);
//   Desync.advance(1400); Desync.advance(1000); Desync.keep();
//   Desync.compare();     // -> { ok: true, ticks: 4001, finalHash: ... }
//
// Add `script: Desync.scriptedPlayer` to __CFG to exercise the command queue
// as well as the AI. Chunk sizes are only about the 30s tool timeout — the
// result does not depend on where the run is split.
