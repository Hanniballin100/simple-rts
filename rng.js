// ============================================================
// rng.js — seeded pseudo-randomness, split into two streams.
// Loaded FIRST, before everything else: data.js and mapgen.js both draw
// from it while the page is still booting.
//
//   simRandom()  — anything that touches game state. Seeded from the match
//                  seed, advances in lockstep on every client, and is part of
//                  the state hash. Damage rolls, scatter, AI picks, spawn
//                  jitter, loot, map generation.
//   fxRandom()   — anything purely cosmetic. Free-running, never seeded,
//                  never hashed, and NEVER read by sim code. This is what
//                  lets the art pass keep adding sparkle without touching
//                  netcode.
//
// The rule for classifying a call: if the value can change *whether* or
// *where* something happens in the simulation, it is sim — even if it looks
// decorative. A particle's velocity is fx. A shell's scatter is sim.
// ============================================================

// mulberry32: one uint32 of state, good enough distribution for a game,
// and — crucially — pure integer ops, so it is bit-identical everywhere.
function mulberry32State(s) {
  return { s: s >>> 0, n: 0 };
}
function mulberry32Next(st) {
  st.n++;
  let a = (st.s = (st.s + 0x6D2B79F5) >>> 0);
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const RNG = (() => {
  // the sim stream starts from a fixed placeholder; startGame() reseeds it
  let sim = mulberry32State(0x9E3779B9);
  // the fx stream is seeded from wall time on purpose — two clients SHOULD
  // have different sparks, and any accidental sim dependence on it will then
  // show up immediately as a desync instead of hiding behind a shared seed
  let fx = mulberry32State((Date.now() ^ 0x5F356495) >>> 0);

  return {
    seedSim(seed) { sim = mulberry32State(seed >>> 0); },
    sim: () => mulberry32Next(sim),
    fx: () => mulberry32Next(fx),
    // cursor: (state, draw count). Both go into hashState — the draw count
    // catches "same value, different number of calls" divergence, which is
    // the one a raw state comparison would miss.
    simCursor: () => ({ s: sim.s, n: sim.n }),
    // restore is only used by the desync harness, to re-run from a snapshot
    setSimCursor(c) { sim = { s: c.s >>> 0, n: c.n | 0 }; },
  };
})();

const simRandom = () => RNG.sim();
const fxRandom = () => RNG.fx();

// ---- sim-stream helpers ----
// Draw counts are part of the hash, so these must each consume a FIXED
// number of draws regardless of input.

// integer in [0, n)
const simInt = n => Math.floor(RNG.sim() * n);
// float in [lo, hi)
const simRange = (lo, hi) => lo + RNG.sim() * (hi - lo);
// centred in [-half, +half)
const simJitter = half => (RNG.sim() - 0.5) * 2 * half;
// uniform element of a non-empty array
const simPick = arr => arr[Math.floor(RNG.sim() * arr.length)];
// -1 or +1
const simSign = () => (RNG.sim() < 0.5 ? -1 : 1);

// Fisher-Yates, in place. Replaces `arr.sort(() => Math.random() - 0.5)`,
// which was never a real shuffle AND leaned on engine-specific sort order.
function simShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(RNG.sim() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// a match seed from a string, for reproducing a specific game by name
function seedFromString(str) {
  let h = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
