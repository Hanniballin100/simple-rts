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

  // ---- a real city: shared street grid, zoned blocks, downtown core ----
  // Blocks sit on one pitch so every district lines up with the roads.
  // Zoning by distance from the city center: office/apartment core,
  // shops+civic mid-ring, houses (and combustible gas stations) at the edge.
  const BLOCK_W = 150, BLOCK_H = 132, ROAD = 30;
  const PITCH_X = BLOCK_W + ROAD, PITCH_Y = BLOCK_H + ROAD;
  const blockClear = (bx, by) =>
    bx > 160 && by > 160 && bx < WORLD_W - 160 && by < WORLD_H - 160 &&
    farFrom(starts, bx, by, 430) &&
    farFrom(patchSpots, bx, by, 175) &&
    farFrom(TERRAIN, bx, by, 135) &&
    neutrals.every(n => dist2(n.x, n.y, bx, by) > 165);

  // fill one block with a dense, aligned lot layout picked by zone (0 core-1 edge)
  const fillBlock = (bx, by, zone) => {
    const roll = prand(seed++);
    const put = (type, ox, oy) => neutrals.push({ type, x: bx + ox, y: by + oy });
    const row = (type, n, sx, oy) => { const x0 = -(n - 1) * sx / 2; for (let i = 0; i < n; i++) put(type, x0 + i * sx, oy); };
    // Green parks only OUTSIDE the high-rise district — the downtown core and
    // inner ring stay fully paved (plaza), no grass gaps among the towers. Ore
    // lots (paved) can appear anywhere. These use their OWN rolls so `roll`
    // stays free for the zone building layout below.
    if (zone >= 0.44 && prand(seed++) < 0.17) { decor.push({ kind: 'park', x: bx, y: by, w: BLOCK_W - 6, h: BLOCK_H - 6, seed: seed++ }); return; }
    if (prand(seed++) < 0.1) {
      patchSpots.push({ x: bx, y: by, amount: 1800, rich: true });
      const paved = zone < 0.44 || prand(seed++) < 0.5; // downtown ore lots stay paved
      decor.push({ kind: paved ? 'lot' : 'park', x: bx, y: by, w: BLOCK_W - 10, h: BLOCK_H - 10, seed: seed++ });
      return;
    }
    if (zone < 0.27) { // downtown core: mega-towers and skyscrapers
      if (roll < 0.68) { put('megatower', 0, 0); }
      else if (roll < 0.88) { put('skyscraper', -6, -4); put('office', 42, 40); }
      else { put('office', -32, -28); put('office', 34, 30); put('office', 32, -34); put('shop', -40, 40); }
    } else if (zone < 0.44) { // inner ring: mixed high-rise + the odd civic tower
      if (roll < 0.1) { const L = ['hospital', 'bank', 'radar', 'researchlab', 'tvstation']; put(L[Math.floor(prand(seed++) * L.length)], -2, -2); put('shop', 50, 44); }
      else if (roll < 0.32) { put('skyscraper', 0, 0); put('shop', 48, 44); }
      else if (roll < 0.54) { put('office', -32, -2); put('apartment', 36, -2); }
      else if (roll < 0.82) { put('apartment', -32, -28); put('apartment', 36, -28); put('apartment', 0, 34); }
      else { put('office', -30, -2); put('shop', 44, -36); put('shop', 44, 34); }
    } else if (zone < 0.68) { // mid ring: apartments, commerce, civic landmarks
      if (roll < 0.22) { const L = ['hospital', 'bank', 'researchlab', 'tvstation', 'radar', 'monument', 'substation', 'fueldepot', 'blacksite']; put(L[Math.floor(prand(seed++) * L.length)], -2, -2); put('shop', 52, 42); }
      else if (roll < 0.33) { put('church', -32, -2); put('house', 44, -32); decor.push({ kind: 'park', x: bx + 40, y: by + 30, w: 52, h: 56, seed: seed++ }); }
      else if (roll < 0.58) { put('apartment', -30, -2); put('apartment', 38, -2); put('shop', 0, 42); }
      else if (roll < 0.82) { row('shop', 3, 48, -30); put('apartment', -22, 34); put('warehouse', 38, 32); }
      else { put('warehouse', -22, -24); put('house', 42, -32); put('house', 42, 34); }
    } else { // outer ring: roomier residential with corner stores
      if (roll < 0.3) { put('house', -40, -30); put('house', 42, -30); put('house', -40, 34); put('house', 42, 34); }
      else if (roll < 0.52) { put('house', -38, -30); put('house', 40, -30); put('shop', 0, 40); }
      else if (roll < 0.74) { put('apartment', -28, 0); put('house', 44, -30); put('house', 44, 34); }
      else { put('gasstation', -34, 32); put('house', 36, -30); put('shop', 36, 34); }
    }
  };

  // a city: pick every clear block on a bw x bh grid, lay roads along block
  // edges (overlaps merge into a street network), then zone-fill the blocks
  const placeCity = (ccx, ccy, bw, bh) => {
    const x0 = ccx - (bw / 2) * PITCH_X, y0 = ccy - (bh / 2) * PITCH_Y;
    const used = [];
    for (let gx = 0; gx < bw; gx++) {
      for (let gy = 0; gy < bh; gy++) {
        const bx = x0 + (gx + 0.5) * PITCH_X, by = y0 + (gy + 0.5) * PITCH_Y;
        if (blockClear(bx, by)) used.push({ bx, by });
      }
    }
    if (used.length < 3) return 0; // not enough room here for a real town
    const maxD = Math.hypot(bw * PITCH_X, bh * PITCH_Y) / 2;
    let parkDone = false;
    for (const b of used) {
      decor.push({ kind: 'road', x: b.bx, y: b.by - PITCH_Y / 2, w: PITCH_X + ROAD, h: ROAD, seed: seed++ });
      decor.push({ kind: 'road', x: b.bx, y: b.by + PITCH_Y / 2, w: PITCH_X + ROAD, h: ROAD, seed: seed++ });
      decor.push({ kind: 'road', x: b.bx - PITCH_X / 2, y: b.by, w: ROAD, h: PITCH_Y + ROAD, seed: seed++ });
      decor.push({ kind: 'road', x: b.bx + PITCH_X / 2, y: b.by, w: ROAD, h: PITCH_Y + ROAD, seed: seed++ });
      decor.push({ kind: 'plaza', x: b.bx, y: b.by, w: BLOCK_W + 14, h: BLOCK_H + 14, seed: seed++ });
      const zone = Math.hypot(b.bx - ccx, b.by - ccy) / maxD;
      // one central block stays open as the town park
      if (!parkDone && zone < 0.3 && prand(seed++) < 0.5) {
        parkDone = true;
        decor.push({ kind: 'park', x: b.bx, y: b.by, w: BLOCK_W - 10, h: BLOCK_H - 10, seed: seed++ });
        continue;
      }
      fillBlock(b.bx, b.by, zone);
    }
    return used.length;
  };
  // a small town: houses loosely ringing a paved square
  const placeTown = (x, y, n) => {
    let placed = 0;
    for (let h = 0; h < n; h++) {
      const a = (h / n) * Math.PI * 2 + Math.random() * 0.5;
      const d = 85 + Math.random() * 60;
      const hx = x + Math.cos(a) * d, hy = y + Math.sin(a) * d;
      if (!clearForNeutral(hx, hy, 330)) continue;
      const roll = Math.random();
      neutrals.push({
        type: roll < 0.1 ? 'apartment' : roll < 0.24 ? 'shop' : roll < 0.32 ? 'church' : 'house',
        x: hx, y: hy,
      });
      placed++;
    }
    if (placed >= 3) decor.push({ kind: 'plaza', x, y, w: 120, h: 110, seed: seed++ });
    return placed;
  };
  // a farmstead: barn + house + crop fields
  const placeFarm = (x, y) => {
    if (!clearForNeutral(x, y, 340)) return 0;
    // ground-clear helper for the farm's own tight cluster (barn + silos sit
    // close together, so the 95px neutral spacing doesn't apply between them)
    const onMap = (px, py, m) => px > m && py > m && px < WORLD_W - m && py < WORLD_H - m &&
      farFrom(starts, px, py, 300) && farFrom(TERRAIN, px, py, 70);
    neutrals.push({ type: 'barn', x, y });
    const side = Math.random() < 0.5 ? -1 : 1;
    // farmhouse off to one side
    const hx = x + 102 + (Math.random() - 0.5) * 30, hy = y + (Math.random() - 0.5) * 70;
    if (clearForNeutral(hx, hy, 320)) neutrals.push({ type: 'house', x: hx, y: hy });
    // a cluster of grain silos beside the barn
    const nSilo = 1 + Math.floor(Math.random() * 3);
    for (let s = 0; s < nSilo; s++) {
      const sx = x + side * (56 + s * 30), sy = y - 32 + (Math.random() - 0.5) * 22;
      if (onMap(sx, sy, 120)) neutrals.push({ type: 'silo', x: sx, y: sy });
    }
    // a windmill catching the breeze on the far side
    if (Math.random() < 0.42) {
      const wx = x - side * (98 + Math.random() * 40), wy = y + (Math.random() - 0.5) * 60;
      if (onMap(wx, wy, 120)) neutrals.push({ type: 'windmill', x: wx, y: wy });
    }
    // crop fields fanning out from the yard — varied count and size
    const nField = 2 + Math.floor(Math.random() * 3);
    for (let f = 0; f < nField; f++) {
      const fx = x + (Math.random() - 0.5) * 210;
      const fy = y + 95 + (f % 2) * 100 + Math.floor(f / 2) * 22 + (Math.random() - 0.5) * 30;
      if (fx > 150 && fy > 150 && fx < WORLD_W - 150 && fy < WORLD_H - 150 &&
          farFrom(starts, fx, fy, 280) && farFrom(TERRAIN, fx, fy, 80)) {
        decor.push({ kind: 'field', x: fx, y: fy, w: 115 + Math.random() * 85, h: 72 + Math.random() * 38, seed: seed++ });
      }
    }
    // an orchard grove or a farm pond for character
    if (Math.random() < 0.5) {
      const ox = x + (Math.random() - 0.5) * 170, oy = y - 105 - Math.random() * 70;
      const kind = Math.random() < 0.62 ? 'forest' : 'water';
      if (onMap(ox, oy, 130) && farFrom(TERRAIN, ox, oy, 90)) {
        TERRAIN.push({ x: ox, y: oy, r: 42 + Math.random() * 26, type: kind, seed: seed++ });
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

  if (setting === 'metropolis') {
    // wall-to-wall city: one enormous grid covering the bulk of the map, so
    // 75%+ of the battlefield is streets, blocks and towers. Blocks near the
    // player starts and mineral fields stay clear (blockClear handles it), so
    // there's always room to raise a base at the edges of the sprawl.
    const bw = Math.max(4, Math.floor((WORLD_W * 0.81) / PITCH_X)); // city footprint ~65% of the map
    const bh = Math.max(4, Math.floor((WORLD_H * 0.81) / PITCH_Y));
    placeCity(cx, cy, bw, bh);
  } else if (setting === 'urban') {
    // one metropolis near the middle of the map...
    const big = Math.random() < 0.5 ? [5, 3] : [4, 4];
    for (let tries = 0; tries < 40; tries++) {
      const x = WORLD_W * (0.3 + Math.random() * 0.4);
      const y = WORLD_H * (0.3 + Math.random() * 0.4);
      if (placeCity(x, y, big[0], big[1]) >= 5) break;
    }
    // ...plus satellite districts, and lone roadside stops in the sticks
    scatterSpots(1 + Math.round(area / 5.5e6), 400, (x, y) => placeCity(x, y, 2, 2) >= 3 ? 1 : 0);
    scatterSpots(Math.round(area / 6e6), 340, (x, y) => {
      neutrals.push({ type: Math.random() < 0.3 ? 'gasstation' : 'house', x, y });
      return 1;
    });
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

  // capturable landmarks out in the open country/town (cities seed their own via
  // the block filler): the full slate of contestable special structures
  if (setting !== 'metropolis' && setting !== 'urban') {
    const LANDMARKS = ['hospital', 'bank', 'radiotower', 'radar', 'researchlab', 'substation', 'mast5g', 'tvstation', 'monument', 'fueldepot', 'blacksite'];
    const nLandmark = 2 + Math.round(area / 3.5e6);
    for (let i = 0, tries = 0; i < nLandmark && tries < 400; tries++) {
      const x = 200 + Math.random() * (WORLD_W - 400), y = 200 + Math.random() * (WORLD_H - 400);
      if (!clearForNeutral(x, y, 430)) continue;
      neutrals.push({ type: LANDMARKS[Math.floor(Math.random() * LANDMARKS.length)], x, y });
      i++;
    }
    // the rural mystery: a downed saucer — hold it and salvaged UFO tech is yours
    const nUfo = 1 + (area > 8e6 ? 1 : 0);
    for (let i = 0, tries = 0; i < nUfo && tries < 200; tries++) {
      const x = 220 + Math.random() * (WORLD_W - 440), y = 220 + Math.random() * (WORLD_H - 440);
      if (!clearForNeutral(x, y, 460)) continue;
      neutrals.push({ type: 'ufocrash', x, y });
      i++;
    }
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
