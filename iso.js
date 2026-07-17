// ============================================================
// iso.js — 2:1 dimetric ("RA2-style") projection layer.
// ALL gameplay stays in flat cartesian world coordinates; these
// helpers are used only at render + input time.
//   screen-space (before camera):  ix = x - y,  iy = (x + y) / 2
// The projection is linear, so it is also available as a canvas
// transform (isoShear) — anything drawn under it lands "painted
// on the ground plane", and world-vector (+1,+1) maps to straight
// DOWN on screen (which is how building walls get extruded).
// Loaded after data.js, before mapgen/art/game.
// ============================================================

function isoX(x, y) { return x - y; }
function isoY(x, y) { return (x + y) / 2; }

// inverse: iso screen point -> world point on the ground plane
function isoUnproject(ix, iy) {
  return { x: iy + ix / 2, y: iy - ix / 2 };
}

// a world-space heading (radians) as it appears on screen after projection
function isoAngle(a) {
  const c = Math.cos(a), s = Math.sin(a);
  return Math.atan2((c + s) / 2, c - s);
}

// apply the ground-plane projection as a canvas transform
function isoShear(ctx) { ctx.transform(1, 0.5, -1, 0.5, 0, 0); }

// screen-space altitude airborne units are drawn at (their ground-plane
// position and simulation are untouched — this is purely visual lift)
const FLY_H = 24;

// iso-space extents of the world rectangle (the ground diamond):
// ix spans [-WORLD_H, WORLD_W], iy spans [0, (WORLD_W + WORLD_H) / 2]
function isoSpanW() { return WORLD_W + WORLD_H; }
function isoSpanH() { return (WORLD_W + WORLD_H) / 2; }
