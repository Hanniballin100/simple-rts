// ============================================================
// mapgen.js — random map generation.
// generateMap(sizeKey, numPlayers) sets WORLD_W/WORLD_H and TERRAIN,
// and returns { starts, patchSpots, neutrals } for game.js to populate.
// Water is laid out as coherent bodies (coast, river, lakes) so a future
// naval game has real shorelines to fight over.
// Loaded after data.js, before art.js and game.js.
// ============================================================

// deterministic per-obstacle jitter so terrain blobs draw the same every frame
function prand(seed) {
  const v = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function generateMap(sizeKey, numPlayers, settingKey) {
  const size = MAP_SIZES[sizeKey] || MAP_SIZES.medium;
  const setting = MAP_SETTINGS[settingKey] ? settingKey
    : ['urban', 'town', 'town', 'country'][Math.floor(Math.random() * 4)];
  WORLD_W = size.w;
  WORLD_H = size.h;
  TERRAIN = [];

  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  const area = WORLD_W * WORLD_H;
  const dist2 = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);
  const farFrom = (list, x, y, pad) => list.every(p => dist2(p.x, p.y, x, y) > pad + (p.r || 0));
  let seed = Math.floor(Math.random() * 1e6);

  // ---- start positions: evenly spaced on an inset ring, random rotation ----
  const starts = [];
  const ringX = WORLD_W / 2 - 380, ringY = WORLD_H / 2 - 330;
  const offset = Math.random() * Math.PI * 2;
  for (let i = 0; i < numPlayers; i++) {
    const a = offset + (i / numPlayers) * Math.PI * 2;
    starts.push({ x: cx + Math.cos(a) * ringX, y: cy + Math.sin(a) * ringY });
  }

  // ---- mineral fields ----
  const patchSpots = [];
  for (const s of starts) {
    const home = Math.atan2(cy - s.y, cx - s.x); // toward map center
    // close cluster: guaranteed safe economy
    const a1 = home + (Math.random() - 0.5) * 1.6;
    patchSpots.push({ x: s.x + Math.cos(a1) * 190, y: s.y + Math.sin(a1) * 190, amount: 900 });
    // natural expansion: a bit further out, contestable
    const a2 = home + (Math.random() - 0.5) * 2.4;
    patchSpots.push({ x: s.x + Math.cos(a2) * 450, y: s.y + Math.sin(a2) * 450, amount: 1100 });
  }
  const nExpansions = Math.round(area / 1.2e6) + numPlayers;
  for (let i = 0, tries = 0; i < nExpansions && tries < 500; tries++) {
    const x = 180 + Math.random() * (WORLD_W - 360);
    const y = 180 + Math.random() * (WORLD_H - 360);
    if (!farFrom(starts, x, y, 480)) continue;
    if (!farFrom(patchSpots, x, y, 360)) continue;
    patchSpots.push({ x, y, amount: 1300 });
    i++;
  }
  for (const p of patchSpots) {
    p.x = Math.max(90, Math.min(WORLD_W - 90, p.x));
    p.y = Math.max(90, Math.min(WORLD_H - 90, p.y));
  }

  // ---- water: one coherent style per map ----
  // pieces of the same body are allowed to overlap each other — they only
  // keep clear of starts and minerals, so shorelines read as continuous
  const addWater = (x, y, r) => {
    if (x < 30 - r || y < 30 - r || x > WORLD_W - 30 + r || y > WORLD_H - 30 + r) return false;
    if (!farFrom(starts, x, y, r + 260)) return false;
    if (!farFrom(patchSpots, x, y, r + 110)) return false;
    TERRAIN.push({ x, y, r, type: 'water', seed: seed++ });
    return true;
  };
  const styleRoll = Math.random();
  const waterStyle = styleRoll < 0.3 ? 'coastal' : styleRoll < 0.6 ? 'river' : styleRoll < 0.85 ? 'lakes' : 'landlocked';

  if (waterStyle === 'coastal') {
    // an ocean hugging one edge, with an irregular coastline and a few bays
    const edge = Math.floor(Math.random() * 4); // 0 top, 1 right, 2 bottom, 3 left
    const len = (edge % 2 === 0) ? WORLD_W : WORLD_H;
    for (let s = 0; s < len; s += 90) {
      const r = 100 + Math.random() * 70;
      const inland = r * 0.35 + Math.random() * 50;
      const pos = [
        [s, inland], [WORLD_W - inland, s],
        [s, WORLD_H - inland], [inland, s],
      ][edge];
      addWater(pos[0], pos[1], r);
      // occasional bay pushing further inland
      if (Math.random() < 0.22) {
        const bay = [
          [s + 40, inland + r * 0.8], [WORLD_W - inland - r * 0.8, s + 40],
          [s + 40, WORLD_H - inland - r * 0.8], [inland + r * 0.8, s + 40],
        ][edge];
        addWater(bay[0], bay[1], r * 0.6);
      }
    }
  } else if (waterStyle === 'river') {
    // one winding river crossing the whole map, with 2 fords carved out
    const vertical = Math.random() < 0.5;
    let x = vertical ? WORLD_W * (0.3 + Math.random() * 0.4) : -20;
    let y = vertical ? -20 : WORLD_H * (0.3 + Math.random() * 0.4);
    let heading = vertical ? Math.PI / 2 : 0;
    const segs = [];
    for (let i = 0; i < 200; i++) {
      const r = 60 + Math.random() * 28;
      segs.push({ x, y, r });
      heading += (Math.random() - 0.5) * 0.5;
      // keep it flowing across, not doubling back
      const want = vertical ? Math.PI / 2 : 0;
      heading = want + Math.max(-0.9, Math.min(0.9, heading - want));
      x += Math.cos(heading) * r * 1.05;
      y += Math.sin(heading) * r * 1.05;
      if (vertical ? y > WORLD_H + 20 : x > WORLD_W + 20) break;
    }
    // fords: skip a couple of stretches so armies can cross
    const fords = new Set();
    for (let f = 0; f < 2; f++) {
      const at = 3 + Math.floor(Math.random() * Math.max(1, segs.length - 6));
      fords.add(at); fords.add(at + 1);
    }
    segs.forEach((sg, i) => { if (!fords.has(i)) addWater(sg.x, sg.y, sg.r); });
  } else if (waterStyle === 'lakes') {
    // 1-2 big blobby lakes built from overlapping circles
    const nLakes = 1 + (Math.random() < 0.5 ? 1 : 0);
    for (let l = 0; l < nLakes; l++) {
      const lx = WORLD_W * (0.3 + Math.random() * 0.4);
      const ly = WORLD_H * (0.3 + Math.random() * 0.4);
      const pieces = 5 + Math.floor(Math.random() * 4);
      for (let i = 0; i < pieces; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * 130;
        addWater(lx + Math.cos(a) * d, ly + Math.sin(a) * d, 70 + Math.random() * 55);
      }
    }
  }

  // ---- neutral structures: laid out to match the map setting ----
  const neutrals = [];
  const decor = []; // ground decals: {kind:'plaza'|'field', x, y, w, h, seed}
  const clearForNeutral = (x, y, pad) =>
    x > 120 && y > 120 && x < WORLD_W - 120 && y < WORLD_H - 120 &&
    farFrom(starts, x, y, pad) &&
    farFrom(patchSpots, x, y, 110) &&
    farFrom(TERRAIN, x, y, 70) &&
    neutrals.every(n => dist2(n.x, n.y, x, y) > 95);

  // a city district: paved plaza with a street grid of apartments and houses
  const placeDistrict = (x, y) => {
    const cols = 2 + Math.floor(Math.random() * 2), rows = 2 + Math.floor(Math.random() * 2);
    let placed = 0;
    for (let cxi = 0; cxi < cols; cxi++) {
      for (let ryi = 0; ryi < rows; ryi++) {
        if (Math.random() < 0.25) continue; // vacant lot
        const bx = x + (cxi - (cols - 1) / 2) * 118 + (Math.random() - 0.5) * 16;
        const by = y + (ryi - (rows - 1) / 2) * 108 + (Math.random() - 0.5) * 14;
        if (!clearForNeutral(bx, by, 330)) continue;
        neutrals.push({ type: Math.random() < 0.45 ? 'apartment' : 'house', x: bx, y: by });
        placed++;
      }
    }
    if (placed) {
      decor.push({ kind: 'plaza', x, y, w: cols * 118 + 60, h: rows * 108 + 56, seed: seed++ });
    }
    return placed;
  };
  // a small town: houses loosely ringing a paved square
  const placeTown = (x, y, n) => {
    let placed = 0;
    for (let h = 0; h < n; h++) {
      const a = (h / n) * Math.PI * 2 + Math.random() * 0.5;
      const d = 85 + Math.random() * 60;
      const hx = x + Math.cos(a) * d, hy = y + Math.sin(a) * d;
      if (!clearForNeutral(hx, hy, 330)) continue;
      neutrals.push({ type: Math.random() < 0.12 ? 'apartment' : 'house', x: hx, y: hy });
      placed++;
    }
    if (placed >= 3) decor.push({ kind: 'plaza', x, y, w: 120, h: 110, seed: seed++ });
    return placed;
  };
  // a farmstead: barn + house + crop fields
  const placeFarm = (x, y) => {
    if (!clearForNeutral(x, y, 340)) return 0;
    neutrals.push({ type: 'barn', x, y });
    const hx = x + 105 + (Math.random() - 0.5) * 30, hy = y + (Math.random() - 0.5) * 60;
    if (clearForNeutral(hx, hy, 330)) neutrals.push({ type: 'house', x: hx, y: hy });
    for (let f = 0; f < 1 + Math.floor(Math.random() * 2); f++) {
      const fx = x + (Math.random() - 0.5) * 90;
      const fy = y + 90 + f * 95 + (Math.random() - 0.5) * 20;
      if (fx > 140 && fy > 140 && fx < WORLD_W - 140 && fy < WORLD_H - 140 &&
          farFrom(starts, fx, fy, 300) && farFrom(TERRAIN, fx, fy, 90)) {
        decor.push({ kind: 'field', x: fx, y: fy, w: 130 + Math.random() * 60, h: 80 + Math.random() * 30, seed: seed++ });
      }
    }
    return 1;
  };

  const scatterSpots = (count, pad, place) => {
    for (let i = 0, tries = 0; i < count && tries < 400; tries++) {
      const x = Math.random() * WORLD_W, y = Math.random() * WORLD_H;
      if (!clearForNeutral(x, y, pad)) continue;
      if (place(x, y)) i++;
    }
  };

  if (setting === 'urban') {
    scatterSpots(2 + Math.round(area / 3.2e6), 420, placeDistrict);
    scatterSpots(Math.round(area / 6e6), 340, (x, y) => (neutrals.push({ type: 'house', x, y }), 1));
  } else if (setting === 'town') {
    scatterSpots(1 + Math.round(area / 6e6), 400, (x, y) => placeTown(x, y, 5 + Math.floor(Math.random() * 4)));
    scatterSpots(1 + Math.round(area / 5e6), 360, (x, y) => placeTown(x, y, 2 + Math.floor(Math.random() * 2)));
  } else { // country
    scatterSpots(2 + Math.round(area / 2.6e6), 360, placeFarm);
    scatterSpots(Math.round(area / 7e6), 340, (x, y) => (neutrals.push({ type: 'house', x, y }), 1));
  }

  // oil derricks: contestable tech income — the countryside is richer in oil
  const derrickDiv = setting === 'country' ? 5e6 : setting === 'town' ? 7e6 : 9e6;
  const nDerrick = numPlayers + Math.round(area / derrickDiv);
  for (let i = 0, tries = 0; i < nDerrick && tries < 300; tries++) {
    const x = Math.random() * WORLD_W, y = Math.random() * WORLD_H;
    if (!clearForNeutral(x, y, 430)) continue;
    if (!neutrals.filter(n => n.type === 'derrick').every(n => dist2(n.x, n.y, x, y) > 550)) continue;
    neutrals.push({ type: 'derrick', x, y });
    i++;
  }

  // ---- solid terrain: ridge, central feature, scattered obstacles ----
  const okSpot = (x, y, r) =>
    x - r > 50 && y - r > 50 && x + r < WORLD_W - 50 && y + r < WORLD_H - 50 &&
    farFrom(starts, x, y, r + 250) &&
    farFrom(patchSpots, x, y, r + 110) &&
    farFrom(TERRAIN, x, y, r + 26) &&
    neutrals.every(n => dist2(n.x, n.y, x, y) > r + 80);
  const addObstacle = (x, y, r, type) => TERRAIN.push({ x, y, r, type, seed: seed++ });

  // a rocky ridge partway across the map
  if (Math.random() < 0.55) {
    const vertical = Math.random() < 0.5;
    let x = vertical ? WORLD_W * (0.25 + Math.random() * 0.5) : 60;
    let y = vertical ? 60 : WORLD_H * (0.25 + Math.random() * 0.5);
    let heading = vertical ? Math.PI / 2 : 0;
    const steps = 7 + Math.floor(Math.random() * 6);
    for (let i = 0; i < steps; i++) {
      const r = 48 + Math.random() * 32;
      if (okSpot(x, y, r)) addObstacle(x, y, r, 'rock');
      heading += (Math.random() - 0.5) * 0.7;
      x += Math.cos(heading) * (r * 1.7 + 20);
      y += Math.sin(heading) * (r * 1.7 + 20);
      if (x < 60 || y < 60 || x > WORLD_W - 60 || y > WORLD_H - 60) break;
    }
  }

  // central feature: a mesa forcing a flank (skipped on lake maps — they have one)
  if (waterStyle !== 'lakes' && Math.random() < 0.55) {
    const r = 100 + Math.random() * 60;
    const x = cx + (Math.random() - 0.5) * 300;
    const y = cy + (Math.random() - 0.5) * 240;
    if (okSpot(x, y, r)) addObstacle(x, y, r, 'rock');
  }

  // scattered obstacles; ponds are rare when the map already has real water,
  // and the setting decides how wooded the land is
  const nScatter = Math.round(area / (setting === 'urban' ? 3.6e5 : setting === 'town' ? 3e5 : 2.6e5));
  const waterChance = waterStyle === 'landlocked' ? 0.3 : 0.1;
  const forestShare = setting === 'urban' ? 0.25 : setting === 'town' ? 0.42 : 0.55;
  for (let i = 0, tries = 0; i < nScatter && tries < 900; tries++) {
    const roll = Math.random();
    const type = roll < waterChance ? 'water' : roll < 1 - forestShare ? 'rock' : 'forest';
    const r = type === 'rock' ? 45 + Math.random() * 45 : 55 + Math.random() * 55;
    const x = Math.random() * WORLD_W;
    const y = Math.random() * WORLD_H;
    if (!okSpot(x, y, r)) continue;
    addObstacle(x, y, r, type);
    // forests like company: sprinkle 1-2 sibling groves alongside
    if (type === 'forest') {
      for (let k = 0; k < 2 && Math.random() < 0.6; k++) {
        const a = Math.random() * Math.PI * 2;
        const rr = 40 + Math.random() * 40;
        const gx = x + Math.cos(a) * (r + rr + 30), gy = y + Math.sin(a) * (r + rr + 30);
        if (okSpot(gx, gy, rr)) addObstacle(gx, gy, rr, 'forest');
      }
    }
    i++;
  }

  return { starts, patchSpots, neutrals, decor, waterStyle, setting };
}
