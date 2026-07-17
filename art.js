// ============================================================
// art.js â€” unit art library + particle effects
// Every draw function renders a unit centered at (0,0) facing +x.
// The engine translates/rotates/scales and passes { color, moving, firing }.
// ============================================================

(function () {
  const TAU = Math.PI * 2;

  // ---------- color helpers ----------

  function shade(hex, f) { // f: -1..1 darken/lighten
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; }
    else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  // ---------- particles ----------

  const parts = [];

  const WEAPON_STYLES = {
    bullet: { color: [255, 230, 140], speed: 950 },
    laser:  { color: [140, 208, 255], speed: 1400 },
    ember:  { color: [255, 176, 102], speed: 800 },
    plasma: { color: [125, 255, 214], speed: 1100 },
  };

  const Particles = {
    spawn(p) { p.maxLife = p.maxLife || p.life; parts.push(p); },

    // z1/z2: screen-space altitudes of muzzle and impact (flying shooters
    // and targets) — the tracer climbs or dives between them
    shot(x1, y1, x2, y2, style = 'bullet', z1 = 0, z2 = 0) {
      const ws = WEAPON_STYLES[style] || WEAPON_STYLES.bullet;
      const d = Math.hypot(x2 - x1, y2 - y1);
      const a = Math.atan2(y2 - y1, x2 - x1);
      const life = Math.max(0.04, d / ws.speed);
      this.spawn({ kind: 'flash', x: x1, y: y1, z: z1, r: 3.5, life: 0.07, col: ws.color });
      this.spawn({
        kind: 'tracer', x: x1, y: y1, z: z1, vz: (z2 - z1) / life,
        vx: Math.cos(a) * ws.speed, vy: Math.sin(a) * ws.speed,
        life, col: ws.color,
      });
      this.spawn({
        kind: 'spark', x: x2 + (Math.random() - 0.5) * 6, y: y2 + (Math.random() - 0.5) * 6,
        z: z2,
        vx: -Math.cos(a) * 40 + (Math.random() - 0.5) * 50,
        vy: -Math.sin(a) * 40 + (Math.random() - 0.5) * 50,
        drag: 4, life: 0.3, delay: d / ws.speed, col: ws.color,
      });
    },

    smoke(x, y, r = 3, z = 0) {
      // vz is a SCREEN-space rise: smoke climbs straight up regardless of
      // where "up" points in projected world coordinates
      this.spawn({ kind: 'smoke', x, y, z, vx: (Math.random() - 0.5) * 8, vz: 12, r, grow: 9, life: 1.1 });
    },

    // z1: screen altitude of the bolt's origin (storm strikes come from the sky)
    bolt(x1, y1, x2, y2, col = [255, 245, 180], z1 = 0) {
      this.spawn({ kind: 'bolt', x: x1, y: y1, z1, x2, y2, life: 0.15, col });
      this.spawn({ kind: 'flash', x: x2, y: y2, r: 5, life: 0.12, col });
    },

    pulse(x, y, r, col = [140, 208, 255]) {
      this.spawn({ kind: 'pulsering', x, y, r: 10, grow: r - 10, life: 0.45, col });
    },

    boom(x, y, big = 1) {
      this.spawn({ kind: 'flash', x, y, r: 13 * big, life: 0.16, col: [255, 240, 170] });
      this.spawn({ kind: 'ring', x, y, r: 5, grow: 30 * big, life: 0.45 });
      for (let i = 0; i < 12 * big; i++) {
        const a = Math.random() * TAU, s = 40 + Math.random() * 120 * big;
        this.spawn({ kind: 'debris', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, drag: 3, life: 0.4 + Math.random() * 0.4 });
      }
      for (let i = 0; i < 7 * big; i++) {
        const a = Math.random() * TAU, s = 8 + Math.random() * 26;
        this.spawn({ kind: 'smoke', x: x + Math.cos(a) * 5, y: y + Math.sin(a) * 5, vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: 8, r: 3.5 + Math.random() * 4, grow: 11, life: 0.8 + Math.random() * 0.7 });
      }
    },

    update(dt) {
      for (const p of parts) {
        if (p.delay && p.delay > 0) { p.delay -= dt; continue; }
        p.life -= dt;
        p.x += (p.vx || 0) * dt;
        p.y += (p.vy || 0) * dt;
        if (p.vz) p.z = (p.z || 0) + p.vz * dt;
        if (p.drag) { p.vx *= 1 - p.drag * dt; p.vy *= 1 - p.drag * dt; }
      }
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
    },

    // particles live at world positions; project at draw time. p.z (fed by
    // vz) lifts the sprite straight up in SCREEN space. Ground-plane rings
    // (booms, pulses) render as 2:1 ellipses.
    draw(ctx) {
      for (const p of parts) {
        if (p.delay && p.delay > 0) continue;
        const f = Math.max(0, p.life / p.maxLife);
        const c = p.col || [255, 230, 140];
        const px = isoX(p.x, p.y), py = isoY(p.x, p.y) - (p.z || 0);
        if (p.kind === 'tracer') {
          ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${f})`;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          const tx = p.x - p.vx * 0.016, ty = p.y - p.vy * 0.016;
          ctx.moveTo(isoX(tx, ty), isoY(tx, ty));
          ctx.lineTo(px, py);
          ctx.stroke();
        } else if (p.kind === 'spark') {
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${f})`;
          ctx.fillRect(px - 1, py - 1, 2, 2);
        } else if (p.kind === 'smoke') {
          ctx.fillStyle = `rgba(105,105,105,${f * 0.35})`;
          ctx.beginPath();
          ctx.arc(px, py, p.r + (1 - f) * p.grow, 0, TAU);
          ctx.fill();
        } else if (p.kind === 'flash') {
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${f * 0.9})`;
          ctx.beginPath();
          ctx.arc(px, py, p.r * (1.4 - f * 0.4), 0, TAU);
          ctx.fill();
        } else if (p.kind === 'ring') {
          ctx.strokeStyle = `rgba(255,190,110,${f})`;
          ctx.lineWidth = 3 * f;
          ctx.beginPath();
          const rr2 = p.r + (1 - f) * p.grow;
          ctx.ellipse(px, py, rr2, rr2 * 0.5, 0, 0, TAU);
          ctx.stroke();
        } else if (p.kind === 'debris') {
          ctx.fillStyle = `rgba(58,58,64,${f})`;
          ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
        } else if (p.kind === 'bolt') {
          ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${f})`;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          const sy = py - (p.z1 || 0);
          ctx.moveTo(px, sy);
          const qx = isoX(p.x2, p.y2), qy = isoY(p.x2, p.y2);
          const dx = qx - px, dy = qy - sy;
          for (let i = 1; i <= 4; i++) {
            const seg = i / 5;
            ctx.lineTo(px + dx * seg + (Math.random() - 0.5) * 9, sy + dy * seg + (Math.random() - 0.5) * 9);
          }
          ctx.lineTo(qx, qy);
          ctx.stroke();
        } else if (p.kind === 'pulsering') {
          ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${f * 0.8})`;
          ctx.lineWidth = 2.6;
          ctx.beginPath();
          const rr2 = p.r + (1 - f) * p.grow;
          ctx.ellipse(px, py, rr2, rr2 * 0.5, 0, 0, TAU);
          ctx.stroke();
        }
      }
    },
  };

  // ---------- shared drawing components ----------

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function teamGlow(ctx, r, color) {
    const g = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r);
    g.addColorStop(0, color + '5c');
    g.addColorStop(1, color + '00');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
  }

  function shadow(ctx, rx, ry, ox = 0, oy = 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(ox, oy, rx, ry, 0, 0, TAU);
    ctx.fill();
  }

  // infantry chassis: shoulders + arms; det() adds head & weapon
  function soldier(ctx, t, o, det) {
    const sway = o.moving ? Math.sin(t * 9) * 0.12 : 0;
    ctx.rotate(sway);
    ctx.fillStyle = o.color;
    rr(ctx, -3.5, -3.2, 6.2, 6.4, 2.4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.fillStyle = shade(o.color, -0.25);
    ctx.fillRect(-1, -3.9, 3.4, 1.4);
    ctx.fillRect(-1, 2.5, 3.4, 1.4);
    det();
    ctx.rotate(-sway);
  }

  function rifle(ctx, t, o) {
    ctx.strokeStyle = '#20242a';
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(-0.5, 2.6); ctx.lineTo(7.5, 1.2); ctx.stroke();
    ctx.fillStyle = '#20242a';
    ctx.fillRect(1.5, 1.2, 2, 1.6);
    if (o.firing) {
      ctx.fillStyle = 'rgba(255,235,150,0.95)';
      ctx.beginPath();
      ctx.moveTo(7.5, 1.2); ctx.lineTo(11.5, 0); ctx.lineTo(8.2, 2.8);
      ctx.closePath(); ctx.fill();
    }
  }

  function aaTube(ctx, t, o, glowCol = '#9fe8ff') {
    ctx.strokeStyle = '#2b3138';
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(-3, 2.2); ctx.lineTo(6.5, -0.5); ctx.stroke();
    ctx.fillStyle = glowCol;
    ctx.beginPath(); ctx.arc(6.8, -0.6, 1.1 + (o.firing ? 0.7 : 0), 0, TAU); ctx.fill();
  }

  function head(ctx, skin = '#d9b38c') {
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(0.6, 0, 2.2, 0, TAU); ctx.fill();
  }

  function foilHat(ctx) {
    ctx.fillStyle = '#cfd6de';
    ctx.beginPath();
    ctx.moveTo(0.6, 0); ctx.lineTo(-1.4, -1.4); ctx.lineTo(2.4, -1.2);
    ctx.lineTo(2.0, 1.4); ctx.lineTo(-1.2, 1.5);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#9aa2ac'; ctx.lineWidth = 0.4; ctx.stroke();
  }

  function fedora(ctx) {
    ctx.fillStyle = '#15181d';
    ctx.beginPath(); ctx.arc(0.6, 0, 2.6, 0, TAU); ctx.fill();
    ctx.fillStyle = '#22262d';
    ctx.beginPath(); ctx.arc(0.6, 0, 1.5, 0, TAU); ctx.fill();
  }

  function hardhat(ctx, col = '#e6c34a') {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(0.6, 0, 2.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = shade(col, -0.35); ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(-1.6, 0); ctx.lineTo(2.8, 0); ctx.stroke();
  }

  function greyHead(ctx) {
    ctx.fillStyle = '#b9c2c9';
    ctx.beginPath(); ctx.ellipse(0.8, 0, 2.6, 2.1, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#14161a';
    ctx.beginPath(); ctx.ellipse(1.9, -0.9, 0.8, 0.5, -0.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(1.9, 0.9, 0.8, 0.5, 0.5, 0, TAU); ctx.fill();
  }

  function lizardHead(ctx, col = '#5da356') {
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(1.6, 0, 3.2, 1.9, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ffd75f';
    ctx.beginPath(); ctx.arc(2.2, -0.9, 0.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(2.2, 0.9, 0.5, 0, TAU); ctx.fill();
    ctx.strokeStyle = shade(col, -0.4); ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(3.4, -0.6); ctx.lineTo(4.6, 0); ctx.lineTo(3.4, 0.6); ctx.stroke();
  }

  // vehicle treads: two dark tracks with scrolling marks
  function treads(ctx, t, o, len, wid, sep) {
    const roll = (o.dist !== undefined ? o.dist : t * 40) * 0.4;
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#181b20';
      rr(ctx, -len / 2, s * sep - wid / 2, len, wid, 1.6);
      ctx.fill();
      ctx.strokeStyle = '#31363e';
      ctx.lineWidth = 0.8;
      for (let i = 0; i < Math.floor(len / 4); i++) {
        const p = ((roll + i * 4) % len + len) % len;
        ctx.beginPath();
        ctx.moveTo(-len / 2 + p, s * sep - wid / 2 + 0.5);
        ctx.lineTo(-len / 2 + p, s * sep + wid / 2 - 0.5);
        ctx.stroke();
      }
    }
  }

  function wheels(ctx, t, o, positions, w = 6, h = 3) {
    const roll = (o.dist !== undefined ? o.dist : t * 40) * 0.35;
    for (const [wx, wy] of positions) {
      ctx.fillStyle = '#101317';
      rr(ctx, wx - w / 2, wy - h / 2, w, h, 1.2);
      ctx.fill();
      ctx.strokeStyle = '#2c3138';
      ctx.lineWidth = 0.8;
      const p = ((roll % w) + w) % w;
      ctx.beginPath();
      ctx.moveTo(wx - w / 2 + p, wy - h / 2 + 0.4);
      ctx.lineTo(wx - w / 2 + p, wy + h / 2 - 0.4);
      ctx.stroke();
    }
  }

  function rotor(ctx, t, x, y, len, speed = 18) {
    ctx.fillStyle = 'rgba(200,205,215,0.06)';
    ctx.beginPath(); ctx.arc(x, y, len + 0.5, 0, TAU); ctx.fill();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(t * speed);
    for (let b = 0; b < 2; b++) {
      ctx.rotate(Math.PI * b);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(210,215,225,0.85)');
      g.addColorStop(1, 'rgba(210,215,225,0.15)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(2, 0); ctx.lineTo(len, 0); ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#3c414a';
    ctx.beginPath(); ctx.arc(x, y, 1.6, 0, TAU); ctx.fill();
  }

  function wingFlap(ctx, t, o, span, chord, col, rate = 7) {
    const flap = Math.sin(t * rate) * 0.45;
    for (const s of [-1, 1]) {
      ctx.save();
      ctx.rotate(s * (0.35 + flap * s * 0 + flap) * 0); // placeholder, use scale flap
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(2, s * 2);
      ctx.quadraticCurveTo(-2, s * (span * (0.8 + Math.abs(Math.sin(t * rate)) * 0.3)), -chord, s * span * 0.7);
      ctx.quadraticCurveTo(-4, s * 3, -5, s * 1.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------- unit drawings ----------

  const D = {};

  // --- workers ---
  function workerBase(ctx, t, o, hatFn, toolCol = '#8b939e') {
    soldier(ctx, t, o, () => {
      // tool over shoulder
      ctx.strokeStyle = toolCol;
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(-1, -2.6); ctx.lineTo(5.5, -3.4); ctx.stroke();
      ctx.fillStyle = toolCol;
      ctx.fillRect(4.6, -4.8, 1.6, 2.8);
      head(ctx);
      hatFn(ctx);
    });
  }
  D.believer = (ctx, t, o) => workerBase(ctx, t, o, foilHat);
  D.operative = (ctx, t, o) => workerBase(ctx, t, o, fedora);
  D.digger = (ctx, t, o) => workerBase(ctx, t, o, c => hardhat(c === ctx ? ctx : ctx));
  D.probe = (ctx, t, o) => {
    // small hovering harvester bot
    ctx.fillStyle = shade(o.color, -0.1);
    ctx.beginPath(); ctx.arc(0, 0, 4.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#3f4650'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle = '#7dffd6';
    ctx.beginPath(); ctx.arc(1.6, 0, 1.2 + Math.sin(t * 5) * 0.3, 0, TAU); ctx.fill();
    for (let i = 0; i < 3; i++) {
      const a = t * 2 + i * TAU / 3;
      ctx.fillStyle = '#5b636e';
      ctx.beginPath(); ctx.arc(Math.cos(a) * 4.6, Math.sin(a) * 4.6, 1, 0, TAU); ctx.fill();
    }
  };

  // --- basic infantry ---
  D.militia = (ctx, t, o) => soldier(ctx, t, o, () => { rifle(ctx, t, o); head(ctx); foilHat(ctx); });
  D.partisan = (ctx, t, o) => soldier(ctx, t, o, () => {
    rifle(ctx, t, o);
    head(ctx);
    ctx.fillStyle = '#c22e2e';
    ctx.beginPath(); ctx.arc(0.6, 0, 2.3, -2.4, 2.4); ctx.fill(); // bandana wrap
  });
  D.agent = (ctx, t, o) => soldier(ctx, t, o, () => { rifle(ctx, t, o); fedora(ctx); });
  D.mib = (ctx, t, o) => soldier(ctx, t, o, () => {
    rifle(ctx, t, o);
    fedora(ctx);
    ctx.fillStyle = '#0a0c0f'; // wider brim, darker suit read
    ctx.fillRect(-2.2, -3.6, 1.2, 7.2);
  });
  D.moleman = (ctx, t, o) => soldier(ctx, t, o, () => {
    rifle(ctx, t, o);
    head(ctx, '#c9a27b');
    hardhat(ctx, '#8a6a42');
    ctx.fillStyle = '#d8e6f0'; // goggles
    ctx.beginPath(); ctx.arc(2, -0.8, 0.7, 0, TAU); ctx.arc(2, 0.8, 0.7, 0, TAU); ctx.fill();
  });
  D.greytrooper = (ctx, t, o) => soldier(ctx, t, o, () => { aaTube(ctx, t, { firing: false }, '#7dffd6'); greyHead(ctx); });
  D.raptoid = (ctx, t, o) => soldier(ctx, t, o, () => {
    // tail
    ctx.strokeStyle = '#5da356';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(-3.4, 0);
    ctx.quadraticCurveTo(-7, Math.sin(t * 6) * 2.4, -9.5, Math.sin(t * 6 + 1) * 3);
    ctx.stroke();
    // claws
    ctx.strokeStyle = '#e8e4da';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(3, -2.4); ctx.lineTo(5.6, -3.2); ctx.moveTo(3, 2.4); ctx.lineTo(5.6, 3.2); ctx.stroke();
    lizardHead(ctx);
  });

  // --- AA infantry ---
  D.laserguy = (ctx, t, o) => soldier(ctx, t, o, () => {
    aaTube(ctx, t, o, '#ff5f5f'); head(ctx); foilHat(ctx);
    if (o.firing) { // laser beam pointer!
      ctx.strokeStyle = 'rgba(255,80,80,0.8)';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(6.8, -0.6); ctx.lineTo(16, -2); ctx.stroke();
    }
  });
  D.jammer = (ctx, t, o) => soldier(ctx, t, o, () => {
    aaTube(ctx, t, o, '#8cd0ff');
    fedora(ctx);
    // antenna
    ctx.strokeStyle = '#8b939e'; ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(-2.5, -2.5); ctx.lineTo(-4.5, -5); ctx.stroke();
  });
  D.slinger = (ctx, t, o) => soldier(ctx, t, o, () => {
    aaTube(ctx, t, o, '#c9a7ff');
    head(ctx, '#c9a27b');
    hardhat(ctx, '#8a6a42');
  });
  D.beamer = (ctx, t, o) => soldier(ctx, t, o, () => { aaTube(ctx, t, o, '#7dffd6'); greyHead(ctx); });

  // --- specialist infantry ---
  D.preacher = (ctx, t, o) => soldier(ctx, t, o, () => {
    // "THE END" sign held forward
    ctx.strokeStyle = '#7a5c37'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(1, 0); ctx.lineTo(7, 0); ctx.stroke();
    ctx.fillStyle = '#e8e4da';
    rr(ctx, 6, -4.4, 3.4, 8.8, 0.8);
    ctx.fill();
    ctx.strokeStyle = '#b9b2a4'; ctx.lineWidth = 0.5; ctx.stroke();
    ctx.fillStyle = '#c22e2e';
    ctx.fillRect(7, -3, 1.4, 6);
    head(ctx); foilHat(ctx);
  });
  D.riot = (ctx, t, o) => soldier(ctx, t, o, () => {
    fedora(ctx);
    // big shield held forward
    ctx.fillStyle = '#5d6774';
    rr(ctx, 4, -5.5, 2.6, 11, 1.2);
    ctx.fill();
    ctx.strokeStyle = '#39414c'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle = 'rgba(160,200,240,0.35)';
    rr(ctx, 4.5, -4.5, 1.6, 4, 0.8);
    ctx.fill();
  });
  D.sapper = (ctx, t, o) => soldier(ctx, t, o, () => {
    // satchel backpack + charge in hand
    ctx.fillStyle = '#6e5b3a';
    rr(ctx, -5.4, -2.6, 3, 5.2, 1);
    ctx.fill();
    ctx.fillStyle = '#c22e2e';
    ctx.fillRect(4, -1, 2.6, 2);
    if (Math.sin(t * 8) > 0.4) {
      ctx.fillStyle = '#ffd75f';
      ctx.beginPath(); ctx.arc(6.8, 0, 0.7, 0, TAU); ctx.fill();
    }
    head(ctx, '#c9a27b'); hardhat(ctx, '#8a6a42');
  });
  D.hybrid = (ctx, t, o) => soldier(ctx, t, o, () => {
    rifle(ctx, t, o);
    // half human, half grey
    ctx.save();
    ctx.beginPath(); ctx.rect(-2, -3, 6, 3); ctx.clip();
    head(ctx); ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.rect(-2, 0, 6, 3); ctx.clip();
    greyHead(ctx); ctx.restore();
  });

  // --- vehicles ---
  D.truck = (ctx, t, o) => {
    wheels(ctx, t, o, [[-11, -9.5 + 1.5], [-3, -9.5 + 1.5], [10, -9.5 + 1.5], [-11, 8], [-3, 8], [10, 8]]);
    ctx.fillStyle = '#2e353f';
    rr(ctx, -16, -7, 19, 14, 2);
    ctx.fill();
    ctx.strokeStyle = '#171b21'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#e8e4da';
    rr(ctx, -14.5, -5, 15, 10, 1);
    ctx.fill();
    ctx.save();
    ctx.translate(-7, 0);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#c22e2e';
    ctx.font = 'bold 5.4px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TRUTH', 0, 0);
    ctx.restore();
    ctx.fillStyle = o.color;
    rr(ctx, 3, -7.5, 12, 15, 2.5);
    ctx.fill();
    ctx.strokeStyle = shade(o.color, -0.4); ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    rr(ctx, 4, -6.3, 10, 5, 2);
    ctx.fill();
    ctx.fillStyle = '#17232f';
    rr(ctx, 11.5, -6, 2.6, 12, 1);
    ctx.fill();
    ctx.fillStyle = '#8b939e';
    rr(ctx, 15.5, -8.5, 2.6, 17, 1);
    ctx.fill();
  };
  D.technical = (ctx, t, o) => {
    wheels(ctx, t, o, [[-8, -8], [8, -8], [-8, 6.5], [8, 6.5]]);
    ctx.fillStyle = '#3a3226';
    rr(ctx, -13, -6, 15, 12, 2);
    ctx.fill();
    ctx.fillStyle = o.color;
    rr(ctx, 2, -6.5, 11, 13, 2.2);
    ctx.fill();
    ctx.fillStyle = '#17232f';
    rr(ctx, 9.5, -5, 2.4, 10, 1);
    ctx.fill();
    // bed-mounted gun + gunner
    ctx.fillStyle = '#d9b38c';
    ctx.beginPath(); ctx.arc(-6, 0, 1.8, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#20242a'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(4 + (o.firing ? 1 : 0), 0); ctx.stroke();
  };
  D.suv = (ctx, t, o) => {
    wheels(ctx, t, o, [[-9, -8.5], [9, -8.5], [-9, 7], [9, 7]]);
    ctx.fillStyle = '#15181d';
    rr(ctx, -14, -7, 28, 14, 4);
    ctx.fill();
    ctx.strokeStyle = '#4a515c'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    rr(ctx, -12, -5.6, 24, 4.5, 3);
    ctx.fill();
    ctx.fillStyle = '#0a0c0f';
    rr(ctx, 5, -5.4, 4.5, 10.8, 1.5); // tinted windshield
    ctx.fill();
    ctx.fillStyle = o.color;
    ctx.fillRect(-14, -1, 28, 2); // team stripe
  };
  D.blackvan = (ctx, t, o) => {
    wheels(ctx, t, o, [[-10, -9], [10, -9], [-10, 7.5], [10, 7.5]]);
    ctx.fillStyle = '#1b1e24';
    rr(ctx, -16, -7.5, 32, 15, 3);
    ctx.fill();
    ctx.strokeStyle = '#4a515c'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#0a0c0f';
    rr(ctx, 10, -5.5, 4, 11, 1.5);
    ctx.fill();
    // roof dish, slowly sweeping
    ctx.save();
    ctx.translate(-4, 0);
    ctx.rotate(t * 1.2);
    ctx.strokeStyle = '#8b939e'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 4.2, -1.1, 1.1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(4.2, 0); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = o.color;
    ctx.fillRect(-16, 5.5, 32, 1.6);
  };
  // mining rigs — one shared hull, faction-flavored trim.
  // opts: hull/trim/hopper/cab colors, scale (smaller flat-earth builds),
  // gun (pintle gun on the cab), drill (bore cone instead of the intake
  // roller), dish (sweeping surveillance dish)
  function rigBase(ctx, t, o, opts) {
    ctx.save();
    if (opts.scale) ctx.scale(opts.scale, opts.scale);
    treads(ctx, t, o, 24, 5, 10);
    // low-slung hull
    ctx.fillStyle = opts.hull;
    rr(ctx, -14, -8, 26, 16, 3);
    ctx.fill();
    ctx.strokeStyle = opts.trim; ctx.lineWidth = 1; ctx.stroke();
    // ore hopper with a mineral shimmer
    ctx.fillStyle = opts.hopper;
    rr(ctx, -12, -5.5, 11, 11, 2);
    ctx.fill();
    ctx.fillStyle = `rgba(63,215,208,${0.3 + 0.2 * Math.sin(t * 3)})`;
    rr(ctx, -10.5, -4, 8, 8, 1.5);
    ctx.fill();
    // tinted cab
    ctx.fillStyle = opts.cab;
    rr(ctx, 2, -5.4, 5, 10.8, 1.5);
    ctx.fill();
    if (opts.drill) {
      // spinning bore cone up front, like the drill tank's
      ctx.fillStyle = '#8b939e';
      ctx.beginPath();
      ctx.moveTo(12, -6); ctx.lineTo(21, 0); ctx.lineTo(12, 6);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#5d646d';
      ctx.lineWidth = 1;
      const spin = t * 30;
      for (let i = 0; i < 3; i++) {
        const p = ((spin + i * 3) % 9 + 9) % 9;
        const frac = p / 9;
        ctx.beginPath();
        ctx.moveTo(12 + p, -6 * (1 - frac));
        ctx.lineTo(12 + p, 6 * (1 - frac));
        ctx.stroke();
      }
    } else {
      // intake roller, stripes crawl as it drives
      ctx.fillStyle = '#8b939e';
      rr(ctx, 12, -7, 3.5, 14, 1);
      ctx.fill();
      ctx.strokeStyle = '#5d646d';
      ctx.lineWidth = 0.9;
      const roll = ((o.dist || 0) * 0.6 + t * 2) % 4.7;
      for (let i = 0; i < 3; i++) {
        const p = (roll + i * 4.7) % 14;
        ctx.beginPath(); ctx.moveTo(12.4, -7 + p); ctx.lineTo(15.1, -7 + p); ctx.stroke();
      }
    }
    if (opts.gun) {
      // pintle gun bolted to the cab roof
      ctx.strokeStyle = '#2f353d'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(4.5, 0); ctx.lineTo(11.5, 0); ctx.stroke();
      ctx.fillStyle = '#3a414b';
      ctx.beginPath(); ctx.arc(4.5, 0, 2.1, 0, TAU); ctx.fill();
    }
    if (opts.dish) {
      // sweeping roof dish, same idea as the surveillance van's
      ctx.save();
      ctx.translate(4.5, 0);
      ctx.rotate(t * 1.2);
      ctx.strokeStyle = '#8b939e'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, 3.4, -1.1, 1.1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(3.4, 0); ctx.stroke();
      ctx.restore();
    }
    // team stripe
    ctx.fillStyle = o.color;
    ctx.fillRect(-14, 5.6, 26, 2);
    ctx.restore();
  }
  D.harvester  = (ctx, t, o) => rigBase(ctx, t, o, { hull: '#15181d', trim: '#4a515c', hopper: '#20242a', cab: '#0a0c0f' });
  D.blackrig   = (ctx, t, o) => rigBase(ctx, t, o, { hull: '#0c0e12', trim: '#3a414b', hopper: '#15181d', cab: '#06070a', dish: true });
  D.truthrig   = (ctx, t, o) => rigBase(ctx, t, o, { hull: '#7a5c37', trim: '#4a3820', hopper: '#5c452a', cab: '#33271a', scale: 0.9,  gun: true });
  D.salvagerig = (ctx, t, o) => rigBase(ctx, t, o, { hull: '#4a523c', trim: '#2e3325', hopper: '#3a4030', cab: '#22261c', scale: 0.85, gun: true });
  D.borerig    = (ctx, t, o) => rigBase(ctx, t, o, { hull: '#6e5a46', trim: '#463829', hopper: '#57482e', cab: '#2e2519', scale: 1.05, drill: true });
  D.drill = (ctx, t, o) => {
    treads(ctx, t, o, 24, 5, 9);
    ctx.fillStyle = shade(o.color, -0.15);
    rr(ctx, -12, -7, 22, 14, 3);
    ctx.fill();
    ctx.strokeStyle = shade(o.color, -0.5); ctx.lineWidth = 1; ctx.stroke();
    // spinning drill cone
    ctx.fillStyle = '#8b939e';
    ctx.beginPath();
    ctx.moveTo(10, -6); ctx.lineTo(20, 0); ctx.lineTo(10, 6);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#5d646d';
    ctx.lineWidth = 1;
    const spin = t * 30;
    for (let i = 0; i < 3; i++) {
      const p = ((spin + i * 3.3) % 10 + 10) % 10;
      const frac = p / 10;
      ctx.beginPath();
      ctx.moveTo(10 + p, -6 * (1 - frac));
      ctx.lineTo(10 + p, 6 * (1 - frac));
      ctx.stroke();
    }
  };
  D.tripod = (ctx, t, o) => {
    // three walking legs
    ctx.strokeStyle = '#6d7480';
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const a = i * TAU / 3 + Math.PI / 6;
      const step = Math.sin(t * 6 + i * 2.1) * (o.moving ? 3 : 0);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * (13 + step), Math.sin(a) * (13 + step));
      ctx.stroke();
      ctx.fillStyle = '#4d525c';
      ctx.beginPath(); ctx.arc(Math.cos(a) * (13 + step), Math.sin(a) * (13 + step), 1.6, 0, TAU); ctx.fill();
    }
    // dome
    const hull = ctx.createRadialGradient(-2, -2, 1, 0, 0, 8);
    hull.addColorStop(0, '#d7dce4');
    hull.addColorStop(1, '#7a828e');
    ctx.fillStyle = hull;
    ctx.beginPath(); ctx.arc(0, 0, 8, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#4d525c'; ctx.lineWidth = 1; ctx.stroke();
    // eye
    ctx.fillStyle = o.firing ? '#ff5f5f' : '#7dffd6';
    ctx.beginPath(); ctx.arc(4, 0, 1.8, 0, TAU); ctx.fill();
    ctx.fillStyle = o.color;
    ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, TAU); ctx.fill();
  };
  D.basilisk = (ctx, t, o) => {
    // tail
    ctx.strokeStyle = '#4c8747';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-11, 0);
    ctx.quadraticCurveTo(-17, Math.sin(t * 4) * 4, -22, Math.sin(t * 4 + 1) * 5);
    ctx.stroke();
    treads(ctx, t, o, 22, 5, 9);
    // scaly hull
    ctx.fillStyle = '#5da356';
    rr(ctx, -12, -7.5, 24, 15, 5);
    ctx.fill();
    ctx.strokeStyle = '#33632f'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    for (let i = -9; i < 10; i += 5) {
      ctx.beginPath(); ctx.arc(i, -3, 2, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(i + 2.5, 3, 2, 0, TAU); ctx.fill();
    }
    // jaw head
    lizardHead(ctx, '#5da356');
    ctx.save(); ctx.translate(11, 0); ctx.scale(1.7, 1.7); lizardHead(ctx, '#4c8747'); ctx.restore();
    ctx.fillStyle = o.color;
    ctx.fillRect(-12, -8.8, 24, 1.6);
  };

  // artillery platform + custom launcher
  function artyBase(ctx, t, o, launcher) {
    wheels(ctx, t, o, [[-9, -8.5], [3, -8.5], [-9, 7], [3, 7]]);
    ctx.fillStyle = shade(o.color, -0.25);
    rr(ctx, -13, -6.5, 22, 13, 2.5);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
    launcher();
    // stabilizer feet
    ctx.fillStyle = '#5d646d';
    ctx.fillRect(-14.5, -4, 2, 3);
    ctx.fillRect(-14.5, 1, 2, 3);
  }
  D.catapult = (ctx, t, o) => artyBase(ctx, t, o, () => {
    const cock = o.firing ? -0.5 : Math.sin(t * 0.8) * 0.06 - 0.9;
    ctx.strokeStyle = '#7a5c37';
    ctx.lineWidth = 2.4;
    ctx.save();
    ctx.translate(-2, 0);
    ctx.rotate(cock);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(13, 0); ctx.stroke();
    ctx.fillStyle = '#5d646d';
    ctx.beginPath(); ctx.arc(13, 0, 2.4, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#4a3d28';
    rr(ctx, -5, -2.5, 6, 5, 1);
    ctx.fill();
  });
  D.haarp = (ctx, t, o) => artyBase(ctx, t, o, () => {
    for (let i = 0; i < 3; i++) {
      const px = -7 + i * 6;
      ctx.strokeStyle = '#8b939e';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px + 2, -4.5); ctx.stroke();
      const hum = 0.5 + 0.5 * Math.sin(t * 4 + i);
      ctx.fillStyle = `rgba(140,208,255,${0.4 + hum * 0.6})`;
      ctx.beginPath(); ctx.arc(px + 2, -5, 1.4 + hum * 0.5, 0, TAU); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(140,208,255,0.35)';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(-5, -6.5); ctx.lineTo(1, -8.5); ctx.lineTo(7, -6.5); ctx.stroke();
  });
  D.magma = (ctx, t, o) => artyBase(ctx, t, o, () => {
    ctx.fillStyle = '#4a4f57';
    ctx.save();
    ctx.rotate(-0.5);
    rr(ctx, -2, -3.2, 12, 6.4, 3);
    ctx.fill();
    const heat = 0.5 + 0.5 * Math.sin(t * 5);
    ctx.fillStyle = `rgba(255,120,50,${0.5 + heat * 0.5})`;
    ctx.beginPath(); ctx.arc(10, 0, 2.4, 0, TAU); ctx.fill();
    ctx.restore();
  });
  D.mortarcrawler = (ctx, t, o) => artyBase(ctx, t, o, () => {
    const pulse = 0.5 + 0.5 * Math.sin(t * 3.4);
    const g = ctx.createRadialGradient(0, -2, 0.5, 0, -2, 5.5);
    g.addColorStop(0, `rgba(125,255,214,${0.7 + pulse * 0.3})`);
    g.addColorStop(1, 'rgba(125,255,214,0.05)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, -2, 5.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#9aa2ae';
    ctx.beginPath(); ctx.arc(0, -2, 2.6 + pulse * 0.6, 0, TAU); ctx.fill();
  });
  D.smuggler = (ctx, t, o) => {
    wheels(ctx, t, o, [[-9, -9], [9, -9], [-9, 7.5], [9, 7.5]]);
    ctx.fillStyle = '#6e5b3a';
    rr(ctx, -15, -7.5, 22, 15, 2);
    ctx.fill();
    ctx.strokeStyle = '#4a3d28'; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    for (let i = -12; i < 6; i += 4) {
      ctx.beginPath(); ctx.moveTo(i, -7); ctx.lineTo(i, 7); ctx.stroke();
    }
    ctx.fillStyle = o.color;
    rr(ctx, 7, -6.5, 8, 13, 2);
    ctx.fill();
    ctx.fillStyle = '#17232f';
    rr(ctx, 12.5, -5, 2, 10, 1);
    ctx.fill();
  };
  D.phantom = (ctx, t, o) => {
    ctx.strokeStyle = 'rgba(200,210,225,0.7)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, 6, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(200,210,225,0.25)';
    ctx.beginPath(); ctx.arc(0, 0, 3.4, 0, TAU); ctx.fill();
  };

  // --- aircraft ---
  D.wballoon = (ctx, t, o) => {
    ctx.fillStyle = '#e8e8ee';
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#b9bcc6'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.arc(-2, -2, 2.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#8b939e'; ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(0, 7); ctx.lineTo(0, 10); ctx.stroke();
    ctx.fillStyle = o.color;
    ctx.fillRect(-1.6, 10, 3.2, 2.6);
  };
  D.balloon = (ctx, t, o) => {
    ctx.fillStyle = o.color;
    ctx.beginPath(); ctx.ellipse(0, 0, 19, 11, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = shade(o.color, -0.45); ctx.lineWidth = 1.4; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath(); ctx.ellipse(-3, -3.5, 12, 4.5, 0, 0, TAU); ctx.fill();
    // tail fins
    ctx.fillStyle = shade(o.color, -0.3);
    ctx.beginPath(); ctx.moveTo(-17, -3); ctx.lineTo(-24, -7); ctx.lineTo(-19, 0); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-17, 3); ctx.lineTo(-24, 7); ctx.lineTo(-19, 0); ctx.closePath(); ctx.fill();
    // gondola
    ctx.fillStyle = '#2e353f';
    rr(ctx, -4, 8, 9, 4.5, 1.5);
    ctx.fill();
    // TRUTH marking
    ctx.fillStyle = '#e8e4da';
    ctx.font = 'bold 6px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('TRUTH', 0, 0.5);
  };
  D.drone = (ctx, t, o) => {
    ctx.strokeStyle = '#3a3f48';
    ctx.lineWidth = 1.6;
    for (const [ax, ay] of [[6, -6], [6, 6], [-6, -6], [-6, 6]]) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(ax, ay); ctx.stroke();
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(t * 30 + ax);
      ctx.strokeStyle = 'rgba(200,205,215,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-3.4, 0); ctx.lineTo(3.4, 0); ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = '#3a3f48'; ctx.lineWidth = 1.6;
    }
    ctx.fillStyle = '#1d2129';
    rr(ctx, -4, -3, 8.5, 6, 2.5);
    ctx.fill();
    ctx.strokeStyle = '#59626f'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle = o.firing ? '#ff5f5f' : '#8cd0ff';
    ctx.beginPath(); ctx.arc(3, 0, 1.2, 0, TAU); ctx.fill();
  };
  D.heli = (ctx, t, o) => {
    ctx.fillStyle = '#1b1e24';
    rr(ctx, -16, -1.5, 12, 3, 1.2);
    ctx.fill();
    ctx.fillStyle = '#22262d';
    rr(ctx, -17.5, -3.5, 3.5, 7, 1);
    ctx.fill();
    ctx.save();
    ctx.translate(-15.8, 0);
    ctx.rotate(t * 26);
    ctx.strokeStyle = 'rgba(190,195,205,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(4, 0); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#272b33';
    rr(ctx, -2, -9.5, 7, 19, 1.5);
    ctx.fill();
    ctx.fillStyle = '#3a3f48';
    rr(ctx, 0.5, -9.8, 4.5, 3, 1); ctx.fill();
    rr(ctx, 0.5, 6.8, 4.5, 3, 1); ctx.fill();
    ctx.fillStyle = '#1d2129';
    rr(ctx, -7, -3.8, 19, 7.6, 3.6);
    ctx.fill();
    ctx.strokeStyle = '#59626f'; ctx.lineWidth = 0.9; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    rr(ctx, -6, -3, 17, 3, 2.5);
    ctx.fill();
    ctx.fillStyle = '#1e4a5f';
    rr(ctx, 6.5, -2.8, 5.2, 5.6, 2.4);
    ctx.fill();
    ctx.fillStyle = 'rgba(140,220,255,0.5)';
    rr(ctx, 7.2, -2.2, 2.4, 2.2, 1);
    ctx.fill();
    rotor(ctx, t, 1, 0, 15);
    if (Math.sin(t * 6) > 0.3) {
      ctx.fillStyle = 'rgba(255,70,70,0.95)';
      ctx.beginPath(); ctx.arc(-6, 0, 1.1, 0, TAU); ctx.fill();
    }
  };
  D.cavebat = (ctx, t, o) => {
    // a small swarm of three bats
    for (const [bx, by, ph] of [[0, 0, 0], [-7, -5, 1.3], [-6, 6, 2.6]]) {
      const flap = Math.abs(Math.sin(t * 11 + ph));
      ctx.fillStyle = '#3d3345';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.quadraticCurveTo(bx - 3, by + s * (6 * (0.4 + flap * 0.6)), bx - 6, by + s * 5 * (0.4 + flap * 0.6));
        ctx.quadraticCurveTo(bx - 3, by + s * 2, bx - 1, by + s * 0.8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = '#57485f';
      ctx.beginPath(); ctx.ellipse(bx + 1, by, 2.6, 1.6, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd75f';
      ctx.fillRect(bx + 2.4, by - 0.9, 0.7, 0.7);
      ctx.fillRect(bx + 2.4, by + 0.3, 0.7, 0.7);
    }
  };
  D.gyro = (ctx, t, o) => {
    ctx.fillStyle = shade(o.color, -0.15);
    rr(ctx, -6, -3.4, 12, 6.8, 3);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 0.9; ctx.stroke();
    // open cockpit pilot
    ctx.fillStyle = '#d9b38c';
    ctx.beginPath(); ctx.arc(2, 0, 1.8, 0, TAU); ctx.fill();
    hardhat(ctx, '#8a6a42');
    // tail + pusher prop
    ctx.strokeStyle = '#5d646d'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(-12, 0); ctx.stroke();
    ctx.save();
    ctx.translate(-12.5, 0);
    ctx.rotate(t * 24);
    ctx.strokeStyle = 'rgba(190,195,205,0.75)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -3.4); ctx.lineTo(0, 3.4); ctx.stroke();
    ctx.restore();
    rotor(ctx, t, 0, 0, 11, 16);
  };
  D.orb = (ctx, t, o) => {
    const pulse = 0.5 + 0.5 * Math.sin(t * 4);
    const g = ctx.createRadialGradient(-1, -1, 0.5, 0, 0, 7.5);
    g.addColorStop(0, 'rgba(230,255,250,0.95)');
    g.addColorStop(0.5, `rgba(125,255,214,${0.5 + pulse * 0.3})`);
    g.addColorStop(1, 'rgba(125,255,214,0.05)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 7.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#d7fff4';
    ctx.beginPath(); ctx.arc(0, 0, 2.6, 0, TAU); ctx.fill();
  };
  D.saucer = (ctx, t, o) => {
    const pulse = 0.5 + Math.sin(t * 3.2) * 0.25;
    const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 17);
    glow.addColorStop(0, `rgba(90,240,220,${0.35 * pulse})`);
    glow.addColorStop(1, 'rgba(90,240,220,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.fill();
    const hull = ctx.createRadialGradient(-3, -3, 2, 0, 0, 13);
    hull.addColorStop(0, '#d7dce4');
    hull.addColorStop(0.7, '#9aa2ae');
    hull.addColorStop(1, '#6d7480');
    ctx.fillStyle = hull;
    ctx.beginPath(); ctx.arc(0, 0, 13, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#4d525c'; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = 'rgba(70,75,84,0.5)';
    ctx.lineWidth = 0.7;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + t * 0.15;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 6.5, Math.sin(a) * 6.5);
      ctx.lineTo(Math.cos(a) * 12.4, Math.sin(a) * 12.4);
      ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(0, 0, 9.6, 0, TAU); ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + t * 1.6;
      const bright = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 5 + i * 1.7));
      ctx.fillStyle = `rgba(120,255,235,${bright})`;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 11, Math.sin(a) * 11, 1.15, 0, TAU);
      ctx.fill();
    }
    const dome = ctx.createRadialGradient(-1.5, -1.5, 1, 0, 0, 5.4);
    dome.addColorStop(0, 'rgba(190,255,245,0.85)');
    dome.addColorStop(1, 'rgba(70,170,160,0.55)');
    ctx.fillStyle = dome;
    ctx.beginPath(); ctx.arc(0, 0, 5.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(50,110,105,0.8)'; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle = '#b9c2c9';
    ctx.beginPath(); ctx.ellipse(1, 0, 2.4, 2.0, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#14161a';
    ctx.beginPath(); ctx.ellipse(2.1, -0.9, 0.8, 0.5, -0.5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(2.1, 0.9, 0.8, 0.5, 0.5, 0, TAU); ctx.fill();
  };
  function wingedLizard(ctx, t, o, bodyCol, wingCol, crest) {
    const flap = Math.sin(t * 6);
    for (const s of [-1, 1]) {
      ctx.fillStyle = wingCol;
      ctx.beginPath();
      ctx.moveTo(1, s * 2);
      ctx.quadraticCurveTo(-4, s * (12 + flap * 4), -10, s * (14 + flap * 5));
      ctx.quadraticCurveTo(-6, s * 5, -8, s * 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = shade(wingCol, -0.35);
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    // tail
    ctx.strokeStyle = bodyCol;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-6, 0);
    ctx.quadraticCurveTo(-11, flap * 2, -15, flap * 3);
    ctx.stroke();
    // body + head
    ctx.fillStyle = bodyCol;
    ctx.beginPath(); ctx.ellipse(0, 0, 7, 3.4, 0, 0, TAU); ctx.fill();
    ctx.save(); ctx.translate(6, 0); ctx.scale(1.3, 1.3); lizardHead(ctx, bodyCol); ctx.restore();
    if (crest) {
      ctx.fillStyle = shade(bodyCol, -0.3);
      ctx.beginPath(); ctx.moveTo(6, -1); ctx.lineTo(2.4, -3.6); ctx.lineTo(4.8, -0.6); ctx.closePath(); ctx.fill();
    }
  }
  D.drake = (ctx, t, o) => {
    wingedLizard(ctx, t, o, '#5da356', '#4c8747', false);
    if (o.firing) {
      ctx.fillStyle = 'rgba(255,140,60,0.85)';
      ctx.beginPath();
      ctx.moveTo(11, 0); ctx.lineTo(18, -2.5); ctx.lineTo(18, 2.5);
      ctx.closePath(); ctx.fill();
    }
  };
  D.ptero = (ctx, t, o) => wingedLizard(ctx, t, o, '#b08a5a', '#96744a', true);
  D.cropduster = (ctx, t, o) => {
    // wings
    ctx.fillStyle = o.color;
    rr(ctx, -1, -13, 6, 26, 2);
    ctx.fill();
    ctx.strokeStyle = shade(o.color, -0.4); ctx.lineWidth = 0.8; ctx.stroke();
    // fuselage
    ctx.fillStyle = shade(o.color, 0.15);
    rr(ctx, -9, -2.6, 20, 5.2, 2.6);
    ctx.fill();
    ctx.strokeStyle = shade(o.color, -0.4); ctx.stroke();
    // tail
    ctx.fillStyle = o.color;
    rr(ctx, -10, -5, 3, 10, 1);
    ctx.fill();
    // cockpit
    ctx.fillStyle = '#17232f';
    rr(ctx, 1, -1.8, 4, 3.6, 1.5);
    ctx.fill();
    // prop
    ctx.save();
    ctx.translate(11.5, 0);
    ctx.rotate(t * 28);
    ctx.strokeStyle = 'rgba(190,195,205,0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(0, 5); ctx.stroke();
    ctx.restore();
  };
  D.gunship = (ctx, t, o) => {
    // AC-130: big four-engine airframe with a broadside battery — drawn at
    // twice its old size, it should dwarf everything else in the sky
    ctx.save();
    ctx.scale(2.5, 2.5);
    // wide wing with four props
    ctx.fillStyle = '#272b33';
    rr(ctx, -3, -16, 8, 32, 2);
    ctx.fill();
    for (const s of [-1, 1]) {
      for (const e of [6.5, 12]) {
        ctx.fillStyle = '#1d2129';
        rr(ctx, -1, s * e - 1.8, 7, 3.6, 1.5);
        ctx.fill();
        ctx.save();
        ctx.translate(7, s * e);
        ctx.rotate(t * 26 + s * e);
        ctx.strokeStyle = 'rgba(190,195,205,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, -3.4); ctx.lineTo(0, 3.4); ctx.stroke();
        ctx.restore();
      }
    }
    // fuselage
    ctx.fillStyle = '#1d2129';
    rr(ctx, -13, -3.8, 28, 7.6, 3.4);
    ctx.fill();
    ctx.strokeStyle = '#59626f'; ctx.lineWidth = 0.9; ctx.stroke();
    // tail
    ctx.fillStyle = '#272b33';
    rr(ctx, -14, -6.5, 3.5, 13, 1);
    ctx.fill();
    // cockpit
    ctx.fillStyle = '#1e4a5f';
    rr(ctx, 10, -2.8, 4.6, 5.6, 2.2);
    ctx.fill();
    // the broadside: howitzer + cannon barrels off the left of the hull
    ctx.strokeStyle = '#3a3f48';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-2, 3.8); ctx.lineTo(2, 7.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-7, 3.8); ctx.lineTo(-4.5, 6.8); ctx.stroke();
    if (o.firing) {
      ctx.fillStyle = 'rgba(255,220,130,0.9)';
      ctx.beginPath();
      ctx.moveTo(2, 7.5); ctx.lineTo(6, 11.5); ctx.lineTo(1, 9.8);
      ctx.closePath(); ctx.fill();
    }
    blinker(ctx, t, -14, 0, '#ff5f5f', 4);
    ctx.restore();
  };
  D.b1 = (ctx, t, o) => {
    // swing-wing strike jet: needle nose, swept wings, twin burners
    ctx.fillStyle = '#2c313a';
    for (const s of [-1, 1]) { // swept wings
      ctx.beginPath();
      ctx.moveTo(4, s * 1.5);
      ctx.lineTo(-4, s * 12);
      ctx.lineTo(-8, s * 11);
      ctx.lineTo(-3, s * 1.5);
      ctx.closePath(); ctx.fill();
    }
    // fuselage blended into the nose
    ctx.fillStyle = '#2f343d';
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.quadraticCurveTo(6, -3.2, -8, -2.6);
    ctx.lineTo(-11, 0);
    ctx.lineTo(-8, 2.6);
    ctx.quadraticCurveTo(6, 3.2, 14, 0);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#59626f'; ctx.lineWidth = 0.8; ctx.stroke();
    // tailplanes
    ctx.fillStyle = '#262b33';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-8, s * 1.5); ctx.lineTo(-13, s * 6); ctx.lineTo(-11.5, s * 1);
      ctx.closePath(); ctx.fill();
    }
    // cockpit strip
    ctx.fillStyle = 'rgba(140,220,255,0.55)';
    rr(ctx, 6.5, -1.2, 4.5, 2.4, 1.2);
    ctx.fill();
    // afterburners
    const burn = 0.6 + 0.4 * Math.sin(t * 23);
    ctx.fillStyle = `rgba(255,${150 + Math.floor(burn * 70)},60,${0.55 + burn * 0.4})`;
    ctx.beginPath(); ctx.moveTo(-11, -1.6); ctx.lineTo(-15 - burn * 3, 0); ctx.lineTo(-11, 1.6); ctx.closePath(); ctx.fill();
  };
  D.b2 = (ctx, t, o) => {
    // stealth flying wing: one black chevron with the sawtooth trailing edge
    ctx.fillStyle = '#181b20';
    ctx.beginPath();
    ctx.moveTo(11, 0);
    ctx.lineTo(-9, -14);
    ctx.lineTo(-6.5, -9);   // sawtooth back edge
    ctx.lineTo(-9.5, -4.5);
    ctx.lineTo(-5.5, 0);
    ctx.lineTo(-9.5, 4.5);
    ctx.lineTo(-6.5, 9);
    ctx.lineTo(-9, 14);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#3a4048';
    ctx.lineWidth = 0.9;
    ctx.stroke();
    // spine highlight + cockpit slit
    ctx.strokeStyle = 'rgba(120,130,145,0.45)';
    ctx.lineWidth = 0.7;
    ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-5.5, 0); ctx.stroke();
    ctx.fillStyle = 'rgba(140,220,255,0.4)';
    rr(ctx, 4.5, -1.1, 3.4, 2.2, 1);
    ctx.fill();
    // engine glow notches
    for (const s of [-1, 1]) {
      ctx.fillStyle = 'rgba(255,150,70,0.5)';
      ctx.fillRect(-8.2, s * 6 - 0.8, 1.8, 1.6);
    }
  };
  D.biobomber = (ctx, t, o) => {
    const breathe = 1 + Math.sin(t * 2.2) * 0.05;
    ctx.save();
    ctx.scale(breathe, 2 - breathe);
    ctx.fillStyle = '#7a9a4e';
    ctx.beginPath(); ctx.ellipse(0, 0, 16, 10, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#55703a'; ctx.lineWidth = 1.4; ctx.stroke();
    // veins
    ctx.strokeStyle = 'rgba(60,90,40,0.6)';
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(-12 + i * 7, -6);
      ctx.quadraticCurveTo(-9 + i * 7, 0, -12 + i * 7, 6);
      ctx.stroke();
    }
    // pulsing sacs
    for (const [px, py] of [[-6, 3], [4, -3], [9, 3]]) {
      const p = 0.5 + 0.5 * Math.sin(t * 3 + px);
      ctx.fillStyle = `rgba(190,230,120,${0.4 + p * 0.5})`;
      ctx.beginPath(); ctx.arc(px, py, 2 + p, 0, TAU); ctx.fill();
    }
    ctx.restore();
    // eye
    ctx.fillStyle = '#ffd75f';
    ctx.beginPath(); ctx.arc(13, 0, 1.6, 0, TAU); ctx.fill();
  };

  // ---------- building drawings ----------
  // Each draws centered at (0,0). o = { w, h, color, on, fam, wx, wy }
  // fam: 'flat' | 'glob' | 'hollow' | 'alien'
  // Height illusion: every structure = cast shadow + dark walls + lit roof.

  // TRUE-ISO PRIMITIVES. Building art runs inside a local sheared ground
  // frame (world axes projected 2:1), where the world direction (+1,+1)
  // maps to straight DOWN on screen. A volume is therefore drawn as its
  // roof at the authored coords plus walls extruded along (+ext,+ext) to
  // the ground — so every roof detail authored on top stays in place, and
  // (like the old fake facades) the visual base sits a touch south of the
  // logical footprint. Light comes from the NE, RA2-style: SE-facing walls
  // lit, SW-facing walls dark.

  // a raised box: diamond roof + SE and SW walls with vertical screen edges
  function block(ctx, x, y, w, h, r, col, lift = 4) {
    // wall height scales with the block's mass: big structures get RA2-tall
    // walls, small roof details stay low boxes
    const sizeBoost = Math.min(2, Math.sqrt(w * h) / 30);
    const ext = Math.max(4, lift * 1.8 * sizeBoost + 2);
    // ground shadow: the footprint, skewed a little further south-west
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    rr(ctx, x + ext - lift * 0.4, y + ext + lift * 0.9, w, h, r);
    ctx.fill();
    // SE wall (faces screen lower-right — the LIT wall)
    const seg = ctx.createLinearGradient(x + w, y + h / 2, x + w + ext, y + h / 2 + ext);
    seg.addColorStop(0, shade(col, -0.08));
    seg.addColorStop(1, shade(col, -0.34));
    ctx.fillStyle = seg;
    ctx.beginPath();
    ctx.moveTo(x + w, y + r * 0.3);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w + ext, y + h + ext);
    ctx.lineTo(x + w + ext, y + ext + r * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = shade(col, -0.6);
    ctx.lineWidth = 1;
    ctx.stroke();
    // SW wall (faces screen lower-left — in shade)
    const swg = ctx.createLinearGradient(x + w / 2, y + h, x + w / 2 + ext, y + h + ext);
    swg.addColorStop(0, shade(col, -0.32));
    swg.addColorStop(1, shade(col, -0.56));
    ctx.fillStyle = swg;
    ctx.beginPath();
    ctx.moveTo(x + r * 0.3, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w + ext, y + h + ext);
    ctx.lineTo(x + ext + r * 0.3, y + h + ext);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // roof, lit from the NE (bright toward the east corner)
    const g = ctx.createLinearGradient(x + w, y, x, y + h);
    g.addColorStop(0, shade(col, 0.22));
    g.addColorStop(1, shade(col, -0.12));
    ctx.fillStyle = g;
    rr(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.strokeStyle = shade(col, -0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    // highlight along the lit NE roof edges
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.moveTo(x + r, y + 1.2);
    ctx.lineTo(x + w - 1.2, y + 1.2);
    ctx.lineTo(x + w - 1.2, y + h - r);
    ctx.stroke();
  }

  // a raised cylinder: top disc + a wall swept down to its ground circle
  function drum3d(ctx, x, y, rad, col, lift = 3) {
    const ext = Math.max(3.5, lift * 1.4 + rad * 0.35);
    const gx = x + ext, gy = y + ext;      // ground-contact center
    const k = rad / Math.SQRT2;            // silhouette tangent offset
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath(); ctx.arc(gx - lift * 0.4, gy + lift * 0.9, rad * 1.02, 0, TAU); ctx.fill();
    // side wall: hull between the top and ground circles, brightest facing NE
    const wg = ctx.createLinearGradient(x - k, y + k, x + k, y - k);
    wg.addColorStop(0, shade(col, -0.55));
    wg.addColorStop(0.6, shade(col, -0.16));
    wg.addColorStop(1, shade(col, -0.42));
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.moveTo(x + k, y - k);
    ctx.lineTo(gx + k, gy - k);
    ctx.arc(gx, gy, rad, -Math.PI / 4, Math.PI * 3 / 4, false); // ground far cap
    ctx.lineTo(x - k, y + k);
    ctx.arc(x, y, rad, Math.PI * 3 / 4, -Math.PI / 4, false);   // back under the top disc
    ctx.closePath();
    ctx.fill();
    // top disc, lit from the NE
    const g = ctx.createRadialGradient(x + rad * 0.35, y - rad * 0.35, rad * 0.15, x, y, rad);
    g.addColorStop(0, shade(col, 0.3));
    g.addColorStop(1, shade(col, -0.15));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
    ctx.strokeStyle = shade(col, -0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // low concrete foundation with team-color corner brackets
  function pad(ctx, o) {
    // ground-contact shadow so the slab sits ON the terrain, not painted on it
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    rr(ctx, -o.w / 2 + 2.5, -o.h / 2 + 3.5, o.w, o.h, 4);
    ctx.fill();
    // poured surface, lit from the top
    const pg = ctx.createLinearGradient(0, -o.h / 2, 0, o.h / 2);
    pg.addColorStop(0, '#49515b');
    pg.addColorStop(1, '#2e343b');
    ctx.fillStyle = pg;
    rr(ctx, -o.w / 2, -o.h / 2, o.w, o.h, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // beveled lip along the lit edges
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(-o.w / 2 + 3, o.h / 2 - 4);
    ctx.lineTo(-o.w / 2 + 3, -o.h / 2 + 3);
    ctx.lineTo(o.w / 2 - 4, -o.h / 2 + 3);
    ctx.stroke();
    // expansion grooves
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.moveTo(0, -o.h / 2 + 3); ctx.lineTo(0, o.h / 2 - 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-o.w / 2 + 3, 0); ctx.lineTo(o.w / 2 - 3, 0); ctx.stroke();
    const L = Math.min(10, o.w * 0.18);
    ctx.strokeStyle = o.color;
    ctx.lineWidth = 2.4;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = sx * (o.w / 2 - 1), cy = sy * (o.h / 2 - 1);
      ctx.beginPath();
      ctx.moveTo(cx - sx * L, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy - sy * L);
      ctx.stroke();
    }
  }

  // raised circular tower platform: a short cylinder — deck disc at the
  // authored origin, skirt wall swept down to the ground circle
  function towerDeck(ctx, r, topCol, skirtCol) {
    const v = 5.5;                // platform height
    const k = r / Math.SQRT2;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(v - 1, v + 3, r * 1.04, 0, TAU); ctx.fill();
    ctx.fillStyle = skirtCol;
    ctx.beginPath();
    ctx.moveTo(k, -k);
    ctx.lineTo(v + k, v - k);
    ctx.arc(v, v, r, -Math.PI / 4, Math.PI * 3 / 4, false);
    ctx.lineTo(-k, k);
    ctx.arc(0, 0, r, Math.PI * 3 / 4, -Math.PI / 4, false);
    ctx.closePath();
    ctx.fill();
    const g = ctx.createRadialGradient(r * 0.3, -r * 0.4, r * 0.15, 0, 0, r);
    g.addColorStop(0, shade(topCol, 0.14));
    g.addColorStop(1, shade(topCol, -0.10));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  // ---------- RA2-style iso construction kit ----------
  // Everything below runs inside the local sheared ground frame.

  // Draw in TRUE SCREEN AXES at a ground point: un-shears the frame so fn
  // draws with x = screen right, negative y = screen up, origin at (gx, gy)
  // on the ground. Use for anything vertical: masts, spires, dishes, poles.
  function billboard(ctx, gx, gy, fn) {
    ctx.save();
    ctx.translate(gx, gy);
    ctx.transform(0.5, -0.5, 1, 1, 0, 0); // inverse of the iso shear
    fn();
    ctx.restore();
  }

  // Window panes marching along both visible wall faces of an isoBox.
  // A point on the SE face at edge offset s (0..h) and drop k (0..hgt from
  // the roof) sits at (rx + w + k, ry + s + k); the SW face swaps roles.
  function wallWindows(ctx, x, y, w, h, hgt, win) {
    const rows = win.rows || 1;
    const inset = win.inset !== undefined ? win.inset : 3;
    const rowStep = (hgt - inset * 2) / rows;
    const paneH = Math.min(win.paneH || 4.5, rowStep - 1.5);
    if (paneH < 1.8) return;
    const dark = win.col || 'rgba(15,20,28,0.8)';
    const lit = win.litCol || 'rgba(180,220,250,0.7)';
    const rx = x - hgt, ry = y - hgt;
    const pane = (px, py, k0, dx, dy, len) => {
      ctx.beginPath();
      ctx.moveTo(px + k0, py + k0);
      ctx.lineTo(px + dx * len + k0, py + dy * len + k0);
      ctx.lineTo(px + dx * len + k0 + paneH, py + dy * len + k0 + paneH);
      ctx.lineTo(px + k0 + paneH, py + k0 + paneH);
      ctx.closePath();
      ctx.fill();
    };
    for (let j = 0; j < rows; j++) {
      const k0 = inset + j * rowStep;
      const nSE = Math.max(1, Math.floor((h - 6) / (win.pitch || 9)));
      const stepSE = (h - 6) / nSE;
      for (let i = 0; i < nSE; i++) {
        ctx.fillStyle = ((i * 7 + j * 13 + (win.seed || 0)) % 5 < (win.litRate || 0)) ? lit : dark;
        pane(rx + w, ry + 4 + i * stepSE, k0, 0, 1, stepSE - 3);
      }
      const nSW = Math.max(1, Math.floor((w - 6) / (win.pitch || 9)));
      const stepSW = (w - 6) / nSW;
      ctx.fillStyle = 'rgba(8,11,16,0.8)'; // shadow-side panes read darker
      for (let i = 0; i < nSW; i++) {
        pane(rx + 4 + i * stepSW, ry + h, k0, 1, 0, stepSW - 3);
      }
    }
  }

  // dark doorway reaching the ground, centered on a wall face
  function doorway(ctx, x, y, w, h, hgt, side, opt) {
    const o2 = opt === true ? {} : (opt || {});
    const dw = o2.w || 9;
    const dh = Math.min(hgt - 1.5, o2.h || 10);
    const k0 = hgt - dh;
    const rx = x - hgt, ry = y - hgt;
    ctx.fillStyle = o2.col || 'rgba(10,12,16,0.92)';
    ctx.beginPath();
    if (side === 'se') {
      const s0 = h / 2 - dw / 2 + (o2.off || 0);
      ctx.moveTo(rx + w + k0, ry + s0 + k0);
      ctx.lineTo(rx + w + k0, ry + s0 + dw + k0);
      ctx.lineTo(x + w, y + s0 + dw);
      ctx.lineTo(x + w, y + s0);
    } else {
      const s0 = w / 2 - dw / 2 + (o2.off || 0);
      ctx.moveTo(rx + s0 + k0, ry + h + k0);
      ctx.lineTo(rx + s0 + dw + k0, ry + h + k0);
      ctx.lineTo(x + s0 + dw, y + h);
      ctx.lineTo(x + s0, y + h);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  // One rectangular storey with true walls and window/door detail.
  // (x, y, w, h) is the GROUND footprint; the roof rises hgt px straight up.
  // opts: { r, roofCol, win: {rows, litRate, seed, ...}, doorSE, doorSW,
  //         noShadow }. Returns [rx, ry] — the roof rect's origin — so
  // callers can stack rooftop detail (or another storey) on top.
  function isoBox(ctx, x, y, w, h, hgt, col, opt = {}) {
    const rx = x - hgt, ry = y - hgt;
    const r = opt.r !== undefined ? opt.r : 2;
    if (!opt.noShadow) {
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      rr(ctx, x - hgt * 0.12, y + hgt * 0.4, w, h, r);
      ctx.fill();
    }
    // SE wall (lit — light from the NE)
    const se = ctx.createLinearGradient(rx + w, ry + h / 2, x + w, y + h / 2);
    se.addColorStop(0, shade(col, -0.04));
    se.addColorStop(1, shade(col, -0.3));
    ctx.fillStyle = se;
    ctx.beginPath();
    ctx.moveTo(rx + w, ry + r * 0.3);
    ctx.lineTo(rx + w, ry + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + r * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = shade(col, -0.55);
    ctx.lineWidth = 1;
    ctx.stroke();
    // SW wall (shaded)
    const sw = ctx.createLinearGradient(rx + w / 2, ry + h, x + w / 2, y + h);
    sw.addColorStop(0, shade(col, -0.3));
    sw.addColorStop(1, shade(col, -0.52));
    ctx.fillStyle = sw;
    ctx.beginPath();
    ctx.moveTo(rx + r * 0.3, ry + h);
    ctx.lineTo(rx + w, ry + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + r * 0.3, y + h);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (opt.win) wallWindows(ctx, x, y, w, h, hgt, opt.win);
    if (opt.doorSE) doorway(ctx, x, y, w, h, hgt, 'se', opt.doorSE);
    if (opt.doorSW) doorway(ctx, x, y, w, h, hgt, 'sw', opt.doorSW);
    // roof
    const rc = opt.roofCol || col;
    const g = ctx.createLinearGradient(rx + w, ry, rx, ry + h);
    g.addColorStop(0, shade(rc, 0.18));
    g.addColorStop(1, shade(rc, -0.1));
    ctx.fillStyle = g;
    rr(ctx, rx, ry, w, h, r);
    ctx.fill();
    ctx.strokeStyle = shade(rc, -0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.moveTo(rx + r, ry + 1.1);
    ctx.lineTo(rx + w - 1.1, ry + 1.1);
    ctx.lineTo(rx + w - 1.1, ry + h - r);
    ctx.stroke();
    return [rx, ry];
  }

  // Pitched-roof building: walls to wallH, then two roof planes meeting at
  // a ridge. axis 'x': ridge runs along local x (gable ends face ±x);
  // axis 'y': ridge along local y. Both slopes are visible from this angle.
  function gabled(ctx, x, y, w, h, wallH, roofH, wallCol, roofCol, opt = {}) {
    const T = wallH, R2 = wallH + roofH;
    const axis = opt.axis || 'x';
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    rr(ctx, x - T * 0.12, y + T * 0.4, w, h, 2);
    ctx.fill();
    const quad = (a, b, c, d, col2) => {
      ctx.fillStyle = col2;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
    };
    if (axis === 'x') {
      // SW eave wall
      quad([x - T, y + h - T], [x + w - T, y + h - T], [x + w, y + h], [x, y + h], shade(wallCol, -0.34));
      // SE gable wall (pentagon)
      ctx.fillStyle = shade(wallCol, -0.08);
      ctx.beginPath();
      ctx.moveTo(x + w, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + w - T, y + h - T);
      ctx.lineTo(x + w - R2, y + h / 2 - R2);
      ctx.lineTo(x + w - T, y - T);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      // NE roof plane (lit) then SW plane (shaded)
      quad([x - T, y - T], [x + w - T, y - T], [x + w - R2, y + h / 2 - R2], [x - R2, y + h / 2 - R2], shade(roofCol, 0.14));
      quad([x - R2, y + h / 2 - R2], [x + w - R2, y + h / 2 - R2], [x + w - T, y + h - T], [x - T, y + h - T], shade(roofCol, -0.2));
      // ridge highlight
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x - R2 + 1, y + h / 2 - R2);
      ctx.lineTo(x + w - R2 - 1, y + h / 2 - R2);
      ctx.stroke();
    } else {
      // SE eave wall (lit)
      quad([x + w - T, y - T], [x + w - T, y + h - T], [x + w, y + h], [x + w, y], shade(wallCol, -0.08));
      // S gable wall (pentagon, shaded)
      ctx.fillStyle = shade(wallCol, -0.34);
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x + w - T, y + h - T);
      ctx.lineTo(x + w / 2 - R2, y + h - R2);
      ctx.lineTo(x - T, y + h - T);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      // E roof plane (lit) then W plane (shaded)
      quad([x + w - T, y - T], [x + w - T, y + h - T], [x + w / 2 - R2, y + h - R2], [x + w / 2 - R2, y - R2], shade(roofCol, 0.14));
      quad([x + w / 2 - R2, y - R2], [x + w / 2 - R2, y + h - R2], [x - T, y + h - T], [x - T, y - T], shade(roofCol, -0.2));
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x + w / 2 - R2, y - R2 + 1);
      ctx.lineTo(x + w / 2 - R2, y + h - R2 - 1);
      ctx.stroke();
    }
  }

  // upright lattice mast (call inside billboard(): screen axes, y up = -y)
  function lattice(ctx, hgt, baseW, topW, col = '#98a1ac', braces = 4) {
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-baseW / 2, 0); ctx.lineTo(-topW / 2, -hgt);
    ctx.moveTo(baseW / 2, 0); ctx.lineTo(topW / 2, -hgt);
    ctx.stroke();
    ctx.lineWidth = 0.7;
    for (let i = 1; i <= braces; i++) {
      const f = i / (braces + 1), fp = (i - 1) / (braces + 1);
      const wH = baseW + (topW - baseW) * f;
      const wP = baseW + (topW - baseW) * fp;
      ctx.beginPath();
      ctx.moveTo(-wH / 2, -hgt * f); ctx.lineTo(wH / 2, -hgt * f);
      ctx.moveTo(-wP / 2, -hgt * fp); ctx.lineTo(wH / 2, -hgt * f);
      ctx.moveTo(wP / 2, -hgt * fp); ctx.lineTo(-wH / 2, -hgt * f);
      ctx.stroke();
    }
  }

  function blinker(ctx, t, x, y, col = '#ff5f5f', rate = 3) {
    if (Math.sin(t * rate) > 0.2) {
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x, y, 1.6, 0, TAU); ctx.fill();
    }
  }

  function sandbag(ctx, x, y, a) {
    const g = ctx.createRadialGradient(x - 1, y - 1, 0.5, x, y, 6);
    g.addColorStop(0, '#a8987010');
    g.addColorStop(0, '#b3a377');
    g.addColorStop(1, '#8a7c58');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, y, 6, 3.8, a, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#6e6244';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  }

  function ventBox(ctx, x, y, w = 8, h = 6) {
    block(ctx, x, y, w, h, 1, '#4a5058', 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.7;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(x + 1, y + (h / 3) * i); ctx.lineTo(x + w - 1, y + (h / 3) * i); ctx.stroke();
    }
  }

  function fuelDrum(ctx, x, y, col) {
    drum3d(ctx, x, y, 4.2, col, 2);
    ctx.strokeStyle = shade(col, -0.4);
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.arc(x, y, 2.4, 0, TAU); ctx.stroke();
  }

  function crateBox(ctx, x, y, s) {
    block(ctx, x - s / 2, y - s / 2, s, s, 1, '#8a6f45', 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x - s / 2 + 1, y - s / 2 + 1); ctx.lineTo(x + s / 2 - 1, y + s / 2 - 1);
    ctx.moveTo(x + s / 2 - 1, y - s / 2 + 1); ctx.lineTo(x - s / 2 + 1, y + s / 2 - 1);
    ctx.stroke();
  }

  function roofFan(ctx, t, x, y, r, on) {
    drum3d(ctx, x, y, r, '#3c434c', 2);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(on ? t * 9 : 0.6);
    ctx.strokeStyle = 'rgba(200,208,218,0.75)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 3; i++) {
      ctx.rotate(TAU / 3);
      ctx.beginPath(); ctx.moveTo(1.5, 0); ctx.lineTo(r - 1.5, 0); ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#20242a';
    ctx.beginPath(); ctx.arc(x, y, 1.3, 0, TAU); ctx.fill();
  }

  function radioMast(ctx, t, x, y) {
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 5, y + 5); ctx.stroke();
    ctx.strokeStyle = '#9aa2ac';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 9, y - 9); ctx.stroke();
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x + 3.5, y - 5.5); ctx.lineTo(x + 6.5, y - 2.5);
    ctx.moveTo(x + 5.5, y - 7.5); ctx.lineTo(x + 8.5, y - 4.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(154,162,172,0.45)';
    ctx.beginPath(); ctx.moveTo(x + 9, y - 9); ctx.lineTo(x + 2, y - 13); ctx.stroke();
    blinker(ctx, t, x + 9, y - 9);
  }

  const B = {};

  // footprints the drawings below were authored for (scaled to actual size at draw time)
  const BUILDING_DESIGN = {
    hq: [84, 84], powerplant: [56, 56], barracks: [64, 64], factory: [74, 62],
  };

  // ================= HQ =================
  B.hq = (ctx, t, o) => {
    pad(ctx, o);
    if (o.fam === 'flat') {
      // sandbag perimeter, two staggered rows
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * TAU;
        sandbag(ctx, Math.cos(a) * 33, Math.sin(a) * 33, a + Math.PI / 2);
      }
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU + 0.2;
        sandbag(ctx, Math.cos(a) * 27, Math.sin(a) * 27, a + Math.PI / 2);
      }
      // main bunker
      block(ctx, -17, -17, 34, 34, 5, '#6a6352', 5);
      // roof hatch + camo patches
      ctx.fillStyle = 'rgba(58,72,50,0.55)';
      ctx.beginPath(); ctx.ellipse(-7, 6, 7, 4.5, 0.5, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(8, -6, 6, 4, -0.4, 0, TAU); ctx.fill();
      drum3d(ctx, 5, 7, 4.5, '#7d7562', 2);
      ctx.strokeStyle = '#4a4438';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(1.5, 7); ctx.lineTo(8.5, 7); ctx.stroke();
      // entrance corridor with a real doorway facing the pad edge
      isoBox(ctx, -6, -32, 12, 10, 5, '#59524a', { doorSW: { w: 7, h: 4.5 } });
      // whip antenna with guy wires and a warning light
      billboard(ctx, 14, -12, () => {
        ctx.strokeStyle = '#9aa2ac';
        ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -17); ctx.stroke();
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(0, -16); ctx.lineTo(5, -3);
        ctx.moveTo(0, -16); ctx.lineTo(-5, -4);
        ctx.moveTo(-3, -12.5); ctx.lineTo(3, -12.5);
        ctx.moveTo(-2.2, -14.5); ctx.lineTo(2.2, -14.5);
        ctx.stroke();
        if (Math.sin(t * 3) > 0.2) {
          ctx.fillStyle = '#ff5f5f';
          ctx.beginPath(); ctx.arc(0, -17.5, 1.4, 0, TAU); ctx.fill();
        }
      });
      crateBox(ctx, -24, 18, 7);
      crateBox(ctx, -17, 22, 6);
    } else if (o.fam === 'glob') {
      // glass skyscraper: three storeys stepping back, curtain windows,
      // rooftop helipad and antenna cluster
      let rt = isoBox(ctx, -30, -30, 60, 60, 15, '#333c48',
        { win: { rows: 2, paneH: 3.4, inset: 2.5, litRate: 2, seed: 3 }, doorSE: { w: 11, h: 9 } });
      rt = isoBox(ctx, rt[0] + 7, rt[1] + 7, 46, 46, 14, '#3b4553',
        { win: { rows: 2, paneH: 3.2, inset: 2.5, litRate: 2, seed: 5 }, noShadow: true });
      rt = isoBox(ctx, rt[0] + 7, rt[1] + 7, 32, 32, 13, '#445062',
        { win: { rows: 2, paneH: 3, inset: 2.5, litRate: 3, seed: 8 }, noShadow: true });
      const hx2 = rt[0] + 16, hy2 = rt[1] + 16; // top-roof center
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(hx2, hy2, 10, 0, TAU); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = 'bold 10px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('H', hx2, hy2);
      billboard(ctx, rt[0] + 27, rt[1] + 7, () => {
        ctx.strokeStyle = '#8b939e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(0, -8);
        ctx.moveTo(3, 0); ctx.lineTo(3, -5.5);
        ctx.stroke();
        if (Math.sin(t * 3) > 0.2) {
          ctx.fillStyle = '#ff5f5f';
          ctx.beginPath(); ctx.arc(0, -8.5, 1.3, 0, TAU); ctx.fill();
        }
      });
      blinker(ctx, t + 1.1, -30, -30, '#8cd0ff', 2.2);
      blinker(ctx, t + 2.2, 30, 30, '#8cd0ff', 2.2);
    } else if (o.fam === 'hollow') {
      // layered mound rising to a glowing chasm
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(4, 5, 35, 33, 0, 0, TAU); ctx.fill();
      for (const [rad, col] of [[34, '#4e463b'], [27, '#5c5347'], [20, '#6b6152'], [13, '#79705f']]) {
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(-((34 - rad) * 0.25), -((34 - rad) * 0.25), rad, 0, TAU);
        ctx.fill();
      }
      // rocks on the slopes
      ctx.fillStyle = '#433c32';
      for (let i = 0; i < 9; i++) {
        const a = i * 2.42, rr2 = 22 + (i * 13) % 9;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * rr2, Math.sin(a) * rr2);
        ctx.lineTo(Math.cos(a) * rr2 + 4, Math.sin(a) * rr2 - 5);
        ctx.lineTo(Math.cos(a) * rr2 + 7, Math.sin(a) * rr2);
        ctx.closePath(); ctx.fill();
      }
      // glowing chasm w/ inner shaft
      const heat = 0.5 + 0.5 * Math.sin(t * 2.5);
      const g = ctx.createRadialGradient(-3, -3, 1, -3, -3, 13);
      g.addColorStop(0, `rgba(255,170,80,${0.75 + heat * 0.25})`);
      g.addColorStop(1, 'rgba(255,120,50,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(-3, -3, 13, 0, TAU); ctx.fill();
      ctx.fillStyle = '#1d1813';
      ctx.beginPath(); ctx.ellipse(-3, -3, 6.5, 5, 0.4, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(255,140,60,${0.4 + heat * 0.4})`;
      ctx.beginPath(); ctx.ellipse(-3, -3, 3, 2.2, 0.4, 0, TAU); ctx.fill();
      // carved glowing runes
      ctx.strokeStyle = `rgba(255,150,70,${0.25 + heat * 0.3})`;
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const a = i * 1.05 + 0.5;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 16 - 3, Math.sin(a) * 16 - 3);
        ctx.lineTo(Math.cos(a) * 21 - 3, Math.sin(a) * 21 - 3);
        ctx.stroke();
      }
    } else {
      // alien anchor: conduit platform + grand dome
      block(ctx, -34, -34, 68, 68, 8, '#3d4450', 4);
      ctx.strokeStyle = 'rgba(125,255,214,0.4)';
      ctx.lineWidth = 1.4;
      for (const a of [0.79, 2.36, 3.93, 5.5]) {
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 30, Math.sin(a) * 30);
        ctx.lineTo(Math.cos(a) * 16, Math.sin(a) * 16);
        ctx.stroke();
        ctx.fillStyle = 'rgba(125,255,214,0.8)';
        ctx.beginPath(); ctx.arc(Math.cos(a) * 30, Math.sin(a) * 30, 1.8, 0, TAU); ctx.fill();
      }
      // the grand dome, standing as a real hemisphere on the platform
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(3, 5, 27, 13, 0, 0, TAU); ctx.fill();
      billboard(ctx, 0, 2, () => {
        const R2 = 25;
        const hull = ctx.createRadialGradient(-8, -R2 * 0.75, 3, 0, -R2 * 0.4, R2 * 1.15);
        hull.addColorStop(0, '#e6ebf2');
        hull.addColorStop(0.55, '#9aa3b0');
        hull.addColorStop(1, '#616876');
        ctx.fillStyle = hull;
        ctx.beginPath();
        ctx.moveTo(-R2, 0);
        ctx.arc(0, 0, R2, Math.PI, 0);
        ctx.ellipse(0, 0, R2, R2 * 0.32, 0, 0, Math.PI);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#454b55';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        // latitude ribs
        ctx.strokeStyle = 'rgba(70,76,86,0.5)';
        ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.ellipse(0, -R2 * 0.45, R2 * 0.86, R2 * 0.26, 0, Math.PI, 0); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(0, -R2 * 0.78, R2 * 0.58, R2 * 0.16, 0, Math.PI, 0); ctx.stroke();
        // beacon on the crown + specular
        ctx.fillStyle = `rgba(125,255,214,${0.55 + 0.45 * Math.sin(t * 3)})`;
        ctx.beginPath(); ctx.arc(0, -R2 - 1.5, 3, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath(); ctx.ellipse(-8.5, -R2 * 0.68, 3.4, 4.6, 0.5, 0, TAU); ctx.fill();
        // chasing rim lights around the base
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * TAU + t * 0.8;
          const bright = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(t * 4 + i * 2.1));
          ctx.fillStyle = `rgba(120,255,235,${bright})`;
          ctx.beginPath();
          ctx.ellipse(Math.cos(a) * R2 * 0.96, Math.sin(a) * R2 * 0.3, 1.6, 1.2, 0, 0, TAU);
          ctx.fill();
        }
      });
    }
  };

  // ================= POWER PLANT =================
  B.powerplant = (ctx, t, o) => {
    pad(ctx, o);
    if (o.fam === 'flat') {
      // diesel shack with a corrugated roof and a proper door
      const rt = isoBox(ctx, -23, -14, 32, 28, 11, '#77644a',
        { doorSE: { w: 8, h: 8 }, win: { rows: 1, paneH: 3.5, inset: 3 } });
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1;
      for (let i = 3; i < 30; i += 4) {
        ctx.beginPath();
        ctx.moveTo(rt[0] + i, rt[1] + 2);
        ctx.lineTo(rt[0] + i, rt[1] + 26);
        ctx.stroke();
      }
      // upright smokestack beside the shack
      billboard(ctx, 15, -12, () => {
        const sg = ctx.createLinearGradient(-2.6, 0, 2.6, 0);
        sg.addColorStop(0, '#49515b');
        sg.addColorStop(0.5, '#78828e');
        sg.addColorStop(1, '#3c434c');
        ctx.fillStyle = sg;
        ctx.fillRect(-2.6, -22, 5.2, 22);
        ctx.strokeStyle = '#2c3138';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(-2.6, -22, 5.2, 22);
        for (const yy of [-6, -13, -19]) {
          ctx.beginPath(); ctx.moveTo(-2.6, yy); ctx.lineTo(2.6, yy); ctx.stroke();
        }
        ctx.fillStyle = '#20242a';
        ctx.beginPath(); ctx.ellipse(0, -22, 2.6, 1, 0, 0, TAU); ctx.fill();
      });
      // fuel drums + hazard placard
      fuelDrum(ctx, 17, 4, '#a33c3c');
      fuelDrum(ctx, 17, 13, '#a33c3c');
      fuelDrum(ctx, 8, 17, '#8f8f3c');
      ctx.fillStyle = '#e6c34a';
      ctx.save(); ctx.translate(-8, 20); ctx.rotate(Math.PI / 4);
      ctx.fillRect(-3, -3, 6, 6);
      ctx.restore();
      if (o.on && Math.random() < 0.07 && window.Particles) Particles.smoke(o.wx + 15, o.wy - 12, 2, 22);
    } else if (o.fam === 'glob') {
      // fusion torus in a cradle
      block(ctx, -24, -24, 48, 48, 24, '#39404b', 3);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + Math.PI / 4;
        block(ctx, Math.cos(a) * 19 - 3, Math.sin(a) * 19 - 3, 6, 6, 1, '#4a525e', 3);
      }
      const pulse = o.on ? 0.5 + 0.5 * Math.sin(t * 3) : 0.08;
      ctx.strokeStyle = `rgba(140,208,255,${0.35 + pulse * 0.55})`;
      ctx.lineWidth = 5.5;
      ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.stroke();
      // plasma current racing around the ring
      if (o.on) {
        ctx.strokeStyle = 'rgba(230,248,255,0.95)';
        ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.arc(0, 0, 15, t * 4, t * 4 + 1.1); ctx.stroke();
      }
      const g = ctx.createRadialGradient(0, 0, 0.5, 0, 0, 7);
      g.addColorStop(0, `rgba(220,245,255,${0.5 + pulse * 0.5})`);
      g.addColorStop(1, 'rgba(140,208,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, 7, 0, TAU); ctx.fill();
    } else if (o.fam === 'hollow') {
      // geothermal bore under a drill tripod
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(3, 4, 23, 21, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#5c5347';
      ctx.beginPath(); ctx.arc(0, 0, 22, 0, TAU); ctx.fill();
      ctx.fillStyle = '#6b6152';
      ctx.beginPath(); ctx.arc(-3, -3, 16, 0, TAU); ctx.fill();
      // rim stones
      ctx.fillStyle = '#433c32';
      for (let i = 0; i < 8; i++) {
        const a = i * 0.79;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * 19, Math.sin(a) * 19, 3.4, 2.2, a, 0, TAU);
        ctx.fill();
      }
      const heat = o.on ? 0.5 + 0.5 * Math.sin(t * 4) : 0.08;
      const g = ctx.createRadialGradient(0, 0, 1, 0, 0, 11);
      g.addColorStop(0, `rgba(255,170,80,${0.6 + heat * 0.4})`);
      g.addColorStop(1, 'rgba(255,120,50,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.fill();
      ctx.fillStyle = '#241f19';
      ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, TAU); ctx.fill();
      // bubbling lava specks
      if (o.on) {
        for (let i = 0; i < 3; i++) {
          const ba = t * 2 + i * 2.1;
          ctx.fillStyle = `rgba(255,190,90,${0.5 + 0.5 * Math.sin(ba * 3)})`;
          ctx.beginPath();
          ctx.arc(Math.cos(ba) * 2.5, Math.sin(ba) * 2.5, 0.9, 0, TAU);
          ctx.fill();
        }
      }
      // upright timber drill tripod straddling the bore
      billboard(ctx, 0, 3, () => {
        const H2 = 24;
        ctx.strokeStyle = '#7a5c37';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(-15, 2); ctx.lineTo(0, -H2);
        ctx.moveTo(15, 2); ctx.lineTo(0, -H2);
        ctx.moveTo(3, 8); ctx.lineTo(0, -H2);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-9, -7); ctx.lineTo(9, -7);
        ctx.stroke();
        // winch cable with a bucket over the bore
        ctx.strokeStyle = '#4a4238';
        ctx.lineWidth = 1;
        const drop = o.on ? 6 + Math.sin(t * 1.3) * 4 : 8;
        ctx.beginPath(); ctx.moveTo(0, -H2); ctx.lineTo(0, -H2 + 10 + drop); ctx.stroke();
        ctx.fillStyle = '#5d646d';
        rr(ctx, -2.4, -H2 + 10 + drop, 4.8, 4, 1);
        ctx.fill();
      });
      if (o.on && Math.random() < 0.09 && window.Particles) {
        Particles.spawn({ kind: 'smoke', x: o.wx + (Math.random() - 0.5) * 8, y: o.wy, vx: 0, vz: 20, r: 2.5, grow: 7, life: 0.9, maxLife: 0.9 });
      }
    } else {
      // zero-point core: orb levitating over a triad of standing crystals
      block(ctx, -22, -22, 44, 44, 22, '#3d4450', 3);
      const pulse = o.on ? 0.6 + 0.4 * Math.sin(t * 5) : 0.12;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(2, 4, 7, 3.5, 0, 0, TAU); ctx.fill();
      for (let i = 0; i < 3; i++) {
        const a = i * (TAU / 3) - Math.PI / 2;
        const px = Math.cos(a) * 14, py = Math.sin(a) * 14;
        billboard(ctx, px, py, () => {
          ctx.fillStyle = '#c9a7ff';
          ctx.beginPath();
          ctx.moveTo(0, -9); ctx.lineTo(3.2, -2); ctx.lineTo(0, 1); ctx.lineTo(-3.2, -2);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#8a6fd0';
          ctx.lineWidth = 0.8;
          ctx.stroke();
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.beginPath(); ctx.moveTo(-1, -4); ctx.lineTo(0, -7.5); ctx.stroke();
        });
      }
      billboard(ctx, 0, 0, () => {
        const lev = -15 + Math.sin(t * 2.4) * 2.5;
        if (o.on) {
          ctx.strokeStyle = `rgba(125,255,214,${0.3 + 0.5 * Math.abs(Math.sin(t * 7))})`;
          ctx.lineWidth = 1;
          for (let i = 0; i < 3; i++) {
            const a = i * (TAU / 3) - Math.PI / 2;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * 11, Math.sin(a) * 4 - 7);
            ctx.lineTo(Math.sin(t * 11 + i) * 3, lev);
            ctx.stroke();
          }
        }
        const g = ctx.createRadialGradient(-1, lev - 1, 0.5, 0, lev, 10);
        g.addColorStop(0, `rgba(230,255,250,${pulse})`);
        g.addColorStop(0.5, `rgba(125,255,214,${pulse * 0.7})`);
        g.addColorStop(1, 'rgba(125,255,214,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(0, lev, 10, 0, TAU); ctx.fill();
        ctx.fillStyle = '#d7fff4';
        ctx.beginPath(); ctx.arc(0, lev, 3, 0, TAU); ctx.fill();
      });
    }
  };

  // ================= BARRACKS =================
  B.barracks = (ctx, t, o) => {
    pad(ctx, o);
    if (o.fam === 'flat') {
      // stakes + guy ropes
      ctx.strokeStyle = 'rgba(122,108,79,0.8)';
      ctx.lineWidth = 1;
      for (const [cx, cy] of [[-27, -27], [27, -27], [-27, 27], [27, 27]]) {
        ctx.beginPath(); ctx.moveTo(cx * 0.6, cy * 0.6); ctx.lineTo(cx, cy); ctx.stroke();
        ctx.fillStyle = '#5b503b';
        ctx.fillRect(cx - 1.2, cy - 1.2, 2.4, 2.4);
      }
      // a real army ridge tent: canvas roof planes over low walls
      gabled(ctx, -18, -13, 36, 26, 5, 9, '#8a7a58', '#a2916a');
      // canvas seams down the lit slope
      ctx.strokeStyle = 'rgba(70,60,40,0.35)';
      ctx.lineWidth = 0.8;
      for (let i = 1; i < 5; i++) {
        const fx = -18 + i * 7.2;
        ctx.beginPath();
        ctx.moveTo(fx - 5, -13 - 5);
        ctx.lineTo(fx - 14, 0 - 14);
        ctx.stroke();
      }
      // dark entrance flap on the SE gable end
      ctx.fillStyle = '#3b342a';
      ctx.beginPath();
      ctx.moveTo(18, -3);
      ctx.lineTo(18, 5);
      ctx.lineTo(11.5, 0.5 - 6.5);
      ctx.closePath();
      ctx.fill();
      // campfire with upright flames
      ctx.strokeStyle = '#5b503b';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-27, 15); ctx.lineTo(-21, 9); ctx.moveTo(-27, 9); ctx.lineTo(-21, 15); ctx.stroke();
      billboard(ctx, -24, 12, () => {
        const fl = 0.5 + 0.5 * Math.sin(t * 9);
        ctx.fillStyle = `rgba(255,${150 + fl * 60},60,${0.65 + fl * 0.35})`;
        ctx.beginPath();
        ctx.moveTo(-2.5, 0);
        ctx.quadraticCurveTo(-2, -3 - fl * 2, 0, -5 - fl * 3);
        ctx.quadraticCurveTo(2, -3 - fl * 2, 2.5, 0);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(255,230,140,${0.5 + fl * 0.4})`;
        ctx.beginPath(); ctx.ellipse(0, -1.5, 1.2, 2 + fl, 0, 0, TAU); ctx.fill();
      });
    } else if (o.fam === 'glob') {
      const rt = isoBox(ctx, -22, -17, 44, 34, 12, '#3b4553',
        { win: { rows: 1, paneH: 4, litRate: 2, seed: 2 }, doorSE: { w: 10, h: 9 } });
      // parapet inset
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      rr(ctx, rt[0] + 3, rt[1] + 3, 38, 28, 2);
      ctx.stroke();
      roofFan(ctx, t, rt[0] + 12, rt[1] + 11, 4.5, o.on);
      roofFan(ctx, t + 2, rt[0] + 22, rt[1] + 24, 4, o.on);
      ventBox(ctx, rt[0] + 30, rt[1] + 7, 9, 6);
      // rooftop walkway
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(rt[0] + 3, rt[1] + 18, 38, 5);
      blinker(ctx, t, rt[0] + 3, rt[1] + 3, '#8cd0ff', 2.5);
    } else if (o.fam === 'hollow') {
      // burrow mound with timber-framed entrance
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(3, 4, 25, 22, 0, 0, TAU); ctx.fill();
      for (const [rad, col] of [[24, '#584f43'], [18, '#665c4e'], [12, '#74695a']]) {
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(-(24 - rad) * 0.3, -(24 - rad) * 0.3, rad, 0, TAU); ctx.fill();
      }
      // worn path
      ctx.fillStyle = 'rgba(80,68,52,0.6)';
      ctx.beginPath(); ctx.ellipse(16, 12, 9, 4, 0.5, 0, TAU); ctx.fill();
      // entrance + timber frame
      ctx.fillStyle = '#1d1813';
      ctx.beginPath(); ctx.ellipse(10, 8, 7.5, 5.5, 0.55, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#7a5c37';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(4, 13); ctx.lineTo(6, 3); ctx.moveTo(15, 14); ctx.lineTo(16, 4); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(5, 3.5); ctx.lineTo(16.5, 4.5); ctx.stroke();
      // torch glow
      const fl = 0.5 + 0.5 * Math.sin(t * 8);
      ctx.fillStyle = `rgba(255,170,70,${0.5 + fl * 0.5})`;
      ctx.beginPath(); ctx.arc(3, 1, 1.4 + fl * 0.5, 0, TAU); ctx.fill();
      // leaning pickaxe
      ctx.strokeStyle = '#8b939e';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-14, 14); ctx.lineTo(-8, 6); ctx.stroke();
      ctx.beginPath(); ctx.arc(-8, 6, 3, 3.5, 5.6); ctx.stroke();
    } else {
      // cloning pod triplet on a platform
      block(ctx, -23, -19, 46, 38, 6, '#3d4450', 4);
      // feed pipes to a centre pump
      ctx.strokeStyle = '#5c636e';
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(-12 + i * 12, -3); ctx.lineTo(0, 12); ctx.stroke();
      }
      drum3d(ctx, 0, 12, 4, '#4a525e', 2);
      ctx.fillStyle = `rgba(110,230,120,${o.on ? 0.5 + 0.4 * Math.sin(t * 4) : 0.15})`;
      ctx.beginPath(); ctx.arc(0, 12, 1.8, 0, TAU); ctx.fill();
      for (let i = 0; i < 3; i++) {
        const vx = -12 + i * 12;
        // vat: metal collar + green glass dome with rising bubbles
        drum3d(ctx, vx, -3, 7.4, '#6a7280', 2);
        const gg = ctx.createRadialGradient(vx - 2, -5, 1, vx, -3, 6);
        gg.addColorStop(0, 'rgba(180,255,190,0.9)');
        gg.addColorStop(1, 'rgba(60,160,80,0.75)');
        ctx.fillStyle = gg;
        ctx.beginPath(); ctx.arc(vx, -3, 5.8, 0, TAU); ctx.fill();
        if (o.on) {
          for (let bi = 0; bi < 2; bi++) {
            const ph = ((t * 0.7 + bi * 0.5 + i * 0.33) % 1);
            ctx.fillStyle = `rgba(230,255,235,${0.7 * (1 - ph)})`;
            ctx.beginPath();
            ctx.arc(vx + Math.sin(ph * 9 + i) * 2, -3 + 4 - ph * 8, 0.9, 0, TAU);
            ctx.fill();
          }
        }
        // shadowy occupant
        ctx.fillStyle = 'rgba(20,40,25,0.5)';
        ctx.beginPath(); ctx.ellipse(vx, -2.5, 2, 3, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath(); ctx.arc(vx - 2, -5.5, 1.1, 0, TAU); ctx.fill();
      }
    }
  };

  // ================= FACTORY =================
  B.factory = (ctx, t, o) => {
    pad(ctx, o);
    if (o.fam === 'flat') {
      // machine shop: tall hall with a sawtooth roof and a roll-up bay door
      const rt = isoBox(ctx, -30, -24, 60, 48, 15, '#6a6352',
        { win: { rows: 1, paneH: 4, inset: 3, seed: 1 } });
      // sawtooth skylight ridges marching across the roof
      for (let i = 0; i < 5; i++) {
        const sx = rt[0] + 4 + i * 11;
        ctx.fillStyle = '#57503f';
        ctx.beginPath();
        ctx.moveTo(sx, rt[1] + 4);
        ctx.lineTo(sx + 5 - 4, rt[1] + 4 - 4);
        ctx.lineTo(sx + 5 - 4, rt[1] + 44 - 4);
        ctx.lineTo(sx, rt[1] + 44);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(170,215,240,0.5)';
        ctx.beginPath();
        ctx.moveTo(sx + 5 - 4, rt[1] + 4 - 4);
        ctx.lineTo(sx + 9, rt[1] + 4);
        ctx.lineTo(sx + 9, rt[1] + 44);
        ctx.lineTo(sx + 5 - 4, rt[1] + 44 - 4);
        ctx.closePath();
        ctx.fill();
      }
      // roll-up bay door on the SE wall, slats and all
      doorway(ctx, -30, -24, 60, 48, 15, 'se', { w: 20, h: 13, col: '#38332a' });
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      for (let k = 4; k <= 13; k += 3) {
        // horizontal slat at drop k from the roof edge (x = 15, s = -25..-5)
        ctx.beginPath();
        ctx.moveTo(15 + k, -25 + k);
        ctx.lineTo(15 + k, -5 + k);
        ctx.stroke();
      }
      // upright brick chimney + tire pile
      billboard(ctx, -24, -14, () => {
        const cg = ctx.createLinearGradient(-2.4, 0, 2.4, 0);
        cg.addColorStop(0, '#4a4136');
        cg.addColorStop(0.5, '#6e6152');
        cg.addColorStop(1, '#3c352c');
        ctx.fillStyle = cg;
        ctx.fillRect(-2.4, -26, 4.8, 26);
        ctx.strokeStyle = '#2c2822';
        ctx.lineWidth = 0.8;
        ctx.strokeRect(-2.4, -26, 4.8, 26);
        ctx.fillStyle = '#20242a';
        ctx.beginPath(); ctx.ellipse(0, -26, 2.4, 1, 0, 0, TAU); ctx.fill();
      });
      if (o.on && Math.random() < 0.05 && window.Particles) Particles.smoke(o.wx - 24, o.wy - 14, 2, 26);
      ctx.fillStyle = 'rgba(18,16,12,0.55)';
      ctx.beginPath(); ctx.ellipse(-4, 16, 7, 3.5, 0.4, 0, TAU); ctx.fill();
      drum3d(ctx, -20, 18, 4, '#23262b', 2);
      drum3d(ctx, -20, 18, 2, '#3a3f46', 1);
    } else if (o.fam === 'glob') {
      const rt = isoBox(ctx, -30, -24, 60, 48, 15, '#39434f',
        { win: { rows: 2, paneH: 3.5, litRate: 2, seed: 4 } });
      // hazard-striped vehicle door on the SE wall
      doorway(ctx, -30, -24, 60, 48, 15, 'se', { w: 22, h: 13, col: '#20242a' });
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = i % 2 ? '#e6c34a' : '#20242a';
        ctx.beginPath();
        const s0 = -11 + i * 4.4;
        ctx.moveTo(30 + 2, s0 + 2);
        ctx.lineTo(30 + 2, s0 + 4.4 + 2);
        ctx.lineTo(30 + 4.5, s0 + 4.4 + 4.5);
        ctx.lineTo(30 + 4.5, s0 + 4.5);
        ctx.closePath();
        ctx.fill();
      }
      // roof vents + spinning dish on the roof
      ventBox(ctx, rt[0] + 6, rt[1] + 6, 10, 7);
      ventBox(ctx, rt[0] + 20, rt[1] + 6, 10, 7);
      roofFan(ctx, t + 1, rt[0] + 34, rt[1] + 11, 4, o.on);
      billboard(ctx, rt[0] + 12, rt[1] + 36, () => {
        ctx.strokeStyle = '#9aa2ac';
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -6); ctx.stroke();
        ctx.save();
        ctx.translate(0, -6);
        ctx.scale(Math.sin(o.on ? t * 0.9 : 0.7), 1);
        ctx.beginPath(); ctx.arc(0, 0, 4.5, Math.PI, 0); ctx.stroke();
        ctx.restore();
      });
      // moving conveyor dashes out the door apron
      if (o.on) {
        ctx.strokeStyle = 'rgba(140,208,255,0.5)';
        ctx.lineWidth = 2;
        const off = (t * 14) % 8;
        for (let x = 32 + off; x < 58; x += 8) {
          ctx.beginPath(); ctx.moveTo(x, -4); ctx.lineTo(x + 4, -4); ctx.stroke();
        }
      }
    } else if (o.fam === 'hollow') {
      const rt = isoBox(ctx, -30, -24, 60, 48, 14, '#665c4e', {});
      // interlocked rotating gears on the roof deck
      const spin = o.on ? t * 0.9 : 0;
      for (const [gx, gy, gr, dir] of [[-8, -2, 13, 1], [11, 8, 8, -1]]) {
        ctx.save();
        ctx.translate(gx - 14, gy - 14);
        ctx.rotate(spin * dir * (13 / gr));
        ctx.fillStyle = '#8b939e';
        for (let i = 0; i < 8; i++) {
          ctx.save(); ctx.rotate(i * TAU / 8);
          ctx.fillRect(gr - 2, -2.6, 5, 5.2);
          ctx.restore();
        }
        drum3d(ctx, 0, 0, gr, '#98a0ab', 0);
        ctx.fillStyle = '#5d646d';
        ctx.beginPath(); ctx.arc(0, 0, gr * 0.35, 0, TAU); ctx.fill();
        ctx.restore();
      }
      // mine-mouth door on the SW wall + ore cart rail out of it
      doorway(ctx, -30, -24, 60, 48, 14, 'sw', { w: 14, h: 11, col: '#1d1813' });
      ctx.strokeStyle = '#4a4238';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(0, 26); ctx.lineTo(-4, 44); ctx.stroke();
      const cart = o.on ? (Math.sin(t * 0.8) * 0.5 + 0.5) * 14 : 6;
      isoBox(ctx, -2 - cart * 0.2, 28 + cart, 9, 7, 5, '#7a5c37', { noShadow: true });
      ctx.fillStyle = '#3fd7d0';
      ctx.beginPath(); ctx.arc(2.5 - cart * 0.2 - 5, 31.5 + cart - 5, 2, 0, TAU); ctx.fill();
    } else {
      // assembler: a true iso pyramid with corner emitters and a beam
      const S = 27, H2 = 44;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      rr(ctx, -S + 2, -S + 8, S * 2, S * 2, 3);
      ctx.fill();
      // SE face (lit)
      ctx.fillStyle = '#525c6c';
      ctx.beginPath();
      ctx.moveTo(S, -S); ctx.lineTo(S, S); ctx.lineTo(-H2, -H2);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#353c47'; ctx.lineWidth = 1; ctx.stroke();
      // SW face (shaded)
      ctx.fillStyle = '#3f4753';
      ctx.beginPath();
      ctx.moveTo(S, S); ctx.lineTo(-S, S); ctx.lineTo(-H2, -H2);
      ctx.closePath(); ctx.fill();
      ctx.stroke();
      // NE and NW hidden faces read as the top silhouette edges
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(S, -S); ctx.lineTo(-H2, -H2); ctx.lineTo(-S, S);
      ctx.stroke();
      // glowing seams up the visible edges
      const em = o.on ? 0.5 + 0.5 * Math.sin(t * 5) : 0.15;
      ctx.strokeStyle = `rgba(125,255,214,${0.25 + em * 0.45})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(S, S); ctx.lineTo(-H2, -H2);
      ctx.stroke();
      // corner emitters + apex beacon
      for (const [ex, ey] of [[S, -S], [S, S], [-S, S]]) {
        ctx.fillStyle = `rgba(125,255,214,${o.on ? 0.5 + 0.5 * Math.sin(t * 5 + ex) : 0.15})`;
        ctx.beginPath(); ctx.arc(ex, ey, 2.2, 0, TAU); ctx.fill();
      }
      billboard(ctx, 0, 0, () => {
        const ay = -H2 - 1; // apex on screen
        ctx.fillStyle = `rgba(230,255,250,${0.4 + em * 0.6})`;
        ctx.beginPath(); ctx.arc(0, ay, 2.6, 0, TAU); ctx.fill();
        if (o.on) {
          // parts orbiting the apex in the assembly beam
          for (let i = 0; i < 4; i++) {
            const a = t * 1.3 + i * TAU / 4;
            ctx.fillStyle = '#c8cdd5';
            ctx.save();
            ctx.translate(Math.cos(a) * 11, ay + 6 + Math.sin(a) * 4);
            ctx.rotate(a);
            ctx.fillRect(-2, -2, 4, 4);
            ctx.restore();
          }
          const g = ctx.createLinearGradient(0, ay, 0, 2);
          g.addColorStop(0, 'rgba(125,255,214,0.35)');
          g.addColorStop(1, 'rgba(125,255,214,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(-2, ay); ctx.lineTo(2, ay); ctx.lineTo(8, 4); ctx.lineTo(-8, 4);
          ctx.closePath(); ctx.fill();
        }
      });
    }
  };

  // ================= AIRPAD (a real airfield: runway + landing circle) =================
  B.hangar = (ctx, t, o) => {
    // single-plane heavy hangar: one big centered landing ring, nothing else
    pad(ctx, o);
    const W = o.w, H = o.h;
    // flat apron — airfields hug the ground, no podium
    ctx.fillStyle = '#343b43';
    rr(ctx, -W / 2 + 4, -H / 2 + 4, W - 8, H - 8, 4);
    ctx.fill();
    const sg = ctx.createLinearGradient(0, -H / 2, 0, H / 2);
    sg.addColorStop(0, 'rgba(255,255,255,0.07)');
    sg.addColorStop(1, 'rgba(0,0,0,0.14)');
    ctx.fillStyle = sg;
    rr(ctx, -W / 2 + 4, -H / 2 + 4, W - 8, H - 8, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([9, 6]);
    ctx.beginPath(); ctx.arc(0, 4, Math.min(W, H) / 2 - 12, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = 'bold 15px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('130', 0, 4);
    // sequenced corner landing lights, same rhythm as the airpad's
    const hw = W / 2 - 9, hh = H / 2 - 9;
    [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].forEach(([lx, ly], i) => {
      const lit = o.on && ((t * 2 + i) % 4) < 1;
      ctx.fillStyle = lit ? '#ffd75f' : 'rgba(255,215,95,0.2)';
      ctx.beginPath(); ctx.arc(lx, ly, 1.7, 0, TAU); ctx.fill();
    });
  };
  B.airpad = (ctx, t, o) => {
    pad(ctx, o);
    const W = o.w, H = o.h;
    // flat tarmac — airfields hug the ground, no podium
    ctx.fillStyle = '#3a4148';
    rr(ctx, -W / 2 + 4, -H / 2 + 4, W - 8, H - 8, 4);
    ctx.fill();
    // top-lit sheen + painted safety border
    const sg = ctx.createLinearGradient(0, -H / 2, 0, H / 2);
    sg.addColorStop(0, 'rgba(255,255,255,0.07)');
    sg.addColorStop(1, 'rgba(0,0,0,0.14)');
    ctx.fillStyle = sg;
    rr(ctx, -W / 2 + 4, -H / 2 + 4, W - 8, H - 8, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,210,90,0.45)';
    ctx.lineWidth = 1.2;
    rr(ctx, -W / 2 + 6.5, -H / 2 + 6.5, W - 13, H - 13, 3);
    ctx.stroke();
    // runway band
    ctx.fillStyle = '#454d56';
    rr(ctx, -W / 2 + 9, -11, W - 34, 22, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // dashed centerline
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 6]);
    ctx.beginPath(); ctx.moveTo(-W / 2 + 13, 0); ctx.lineTo(W / 2 - 28, 0); ctx.stroke();
    ctx.setLineDash([]);
    // threshold stripes
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    for (let i = 0; i < 4; i++) ctx.fillRect(-W / 2 + 11, -9 + i * 5, 5, 2.5);
    // landing circle at the far end (where aircraft touch down to rearm)
    const cX = W / 2 - 27;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.arc(cX, 0, Math.min(H / 2 - 14, 19), 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
    // fuel pump by the circle
    ctx.strokeStyle = '#5d646d';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(cX + 14, 12); ctx.lineTo(cX + 5, 5); ctx.stroke();
    block(ctx, cX + 13, 10, 6, 7, 1, '#a33c3c', 2);
    // sequenced corner landing lights
    const cw = W / 2 - 9, chh = H / 2 - 9;
    [[-cw, -chh], [cw, -chh], [cw, chh], [-cw, chh]].forEach(([lx, ly], i) => {
      const lit = o.on && ((t * 2 + i) % 4) < 1;
      ctx.fillStyle = lit ? '#ffd75f' : 'rgba(255,215,95,0.2)';
      ctx.beginPath(); ctx.arc(lx, ly, 1.7, 0, TAU); ctx.fill();
    });
    if (o.fam === 'flat') {
      // upright windsock pole by the runway
      billboard(ctx, -W / 2 + 16, H / 2 - 14, () => {
        ctx.strokeStyle = '#9aa2ac';
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -15); ctx.stroke();
        const wind = Math.sin(t * 1.4) * 0.25;
        ctx.save();
        ctx.translate(0, -15);
        ctx.rotate(0.25 + wind);
        ctx.fillStyle = '#e07840';
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(10, -1.6); ctx.lineTo(10, 1.6);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillRect(3.2, -1.5, 2.4, 3);
        ctx.restore();
      });
    } else if (o.fam === 'glob') {
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = 'bold 13px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('H', cX, 1);
      // little control tower with a lit cab
      const rt = isoBox(ctx, -W / 2 + 8, -H / 2 + 8, 13, 11, 12, '#3b4553',
        { win: { rows: 1, paneH: 3.5, inset: 2, litRate: 5, litCol: 'rgba(140,208,255,0.75)' } });
      blinker(ctx, t, rt[0] + 3, rt[1] + 3, '#8cd0ff', 3);
    } else if (o.fam === 'hollow') {
      // cave-mouth hangar at the landing circle
      const g = ctx.createRadialGradient(cX, 0, 2, cX, 0, 12);
      g.addColorStop(0, '#0c0a08');
      g.addColorStop(1, '#3a332a');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(cX, 0, 12, 8.5, 0, 0, TAU); ctx.fill();
      ctx.fillStyle = '#4a4238';
      for (let i = 0; i < 4; i++) {
        const a = 0.6 + i * 1.65;
        ctx.beginPath();
        ctx.moveTo(cX + Math.cos(a) * 13, Math.sin(a) * 9);
        ctx.lineTo(cX + Math.cos(a) * 13 + 4, Math.sin(a) * 9 - 7);
        ctx.lineTo(cX + Math.cos(a) * 13 + 8, Math.sin(a) * 9);
        ctx.closePath(); ctx.fill();
      }
      if (o.on && Math.sin(t * 1.7) > 0.7) {
        ctx.fillStyle = '#57485f';
        ctx.beginPath(); ctx.ellipse(cX + Math.sin(t * 5) * 4, -3, 2, 1.2, 0, 0, TAU); ctx.fill();
      }
    } else {
      const pulse = o.on ? 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 3.2)) : 0.12;
      ctx.strokeStyle = `rgba(125,255,214,${pulse})`;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(cX, 0, 15, 0, TAU); ctx.stroke();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + t * 1.2;
        ctx.fillStyle = `rgba(125,255,214,${pulse})`;
        ctx.beginPath(); ctx.arc(cX + Math.cos(a) * 15, Math.sin(a) * 15, 1.7, 0, TAU); ctx.fill();
      }
      ctx.fillStyle = `rgba(125,255,214,${pulse * 0.7})`;
      ctx.beginPath(); ctx.arc(cX, 0, 3, 0, TAU); ctx.fill();
    }
  };

  // ================= TOWERS (engine draws the turret on top) =================
  B.watchtower = (ctx, t, o) => {
    pad(ctx, o);
    const V = 24; // deck height
    // shadow of the elevated deck
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    rr(ctx, -9, -5, 22, 22, 2);
    ctx.fill();
    // four timber legs from footprint corners up to the deck underside
    // (the N leg hides behind the deck), with X-braces on both faces
    ctx.strokeStyle = '#5c4a2c';
    ctx.lineWidth = 2.2;
    for (const [cx, cy] of [[9, -9], [9, 9], [-9, 9]]) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx - V, cy - V);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#4a3b21';
    ctx.beginPath(); // SE face braces
    ctx.moveTo(9, -9); ctx.lineTo(9 - V * 0.55, 9 - V * 0.55);
    ctx.moveTo(9, 9); ctx.lineTo(9 - V * 0.55, -9 - V * 0.55);
    // SW face braces
    ctx.moveTo(9, 9); ctx.lineTo(-9 - V * 0.55, 9 - V * 0.55);
    ctx.moveTo(-9, 9); ctx.lineTo(9 - V * 0.55, 9 - V * 0.55);
    ctx.stroke();
    // ladder up the SE face
    billboard(ctx, 12, 4, () => {
      ctx.strokeStyle = '#6e5a35';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-2, 0); ctx.lineTo(-2, -V + 3);
      ctx.moveTo(2, 0); ctx.lineTo(2, -V + 3);
      for (let yy = -3; yy > -V + 3; yy -= 4) { ctx.moveTo(-2, yy); ctx.lineTo(2, yy); }
      ctx.stroke();
    });
    // plank deck riding at height V, with a sandbag parapet on the rim
    isoBox(ctx, -11 - V, -11 - V, 22, 22, 4, '#8f7448', { noShadow: true, r: 1.5 });
    ctx.strokeStyle = 'rgba(60,45,25,0.5)';
    ctx.lineWidth = 0.8;
    for (let i = -8; i <= 8; i += 4) {
      ctx.beginPath();
      ctx.moveTo(-11 - V + 10 + i, -11 - V - 4 + 1.5);
      ctx.lineTo(-11 - V + 10 + i, 11 - V - 4 - 1.5);
      ctx.stroke();
    }
    sandbag(ctx, 8 - V - 4, -6 - V - 4, 0.8);
    sandbag(ctx, 9 - V - 4, 2 - V - 4, 0.9);
    sandbag(ctx, -2 - V - 4, 9 - V - 4, 0.1);
    sandbag(ctx, -8 - V - 4, 8 - V - 4, 0.25);
    // sandbags dumped around the base
    sandbag(ctx, -13, 15, 0.3);
    sandbag(ctx, -4, 17, -0.2);
    sandbag(ctx, 5, 16, 0.15);
  };
  B.tower5g = (ctx, t, o) => {
    pad(ctx, o);
    // equipment cabin + fenced base slab
    isoBox(ctx, 2, -14, 12, 11, 7, '#4a525e', { doorSW: { w: 5, h: 6 } });
    const H = 38; // mast height
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(-3, 7, 12, 5, 0, 0, TAU);
    ctx.fill();
    // upright cell mast: lattice trunk, sector antenna panels, dishes
    billboard(ctx, -3, 5, () => {
      lattice(ctx, H, 15, 5, '#a8b0ba', 5);
      // microwave drums mid-mast
      ctx.fillStyle = '#7c848f';
      ctx.beginPath(); ctx.ellipse(-4, -H * 0.55, 2.6, 3.2, 0, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.ellipse(4.4, -H * 0.62, 2.2, 2.8, 0, 0, TAU); ctx.fill();
      // head platform
      ctx.fillStyle = '#59616c';
      ctx.fillRect(-6.5, -H - 1.5, 13, 3);
      // three sector panels fanned around the head
      for (const [px, rot] of [[-6, -0.28], [0, 0], [6, 0.28]]) {
        ctx.save();
        ctx.translate(px, -H + 2.5);
        ctx.rotate(rot);
        const pg = ctx.createLinearGradient(-1.8, 0, 1.8, 0);
        pg.addColorStop(0, '#e8ecf1');
        pg.addColorStop(1, '#b7bfc9');
        ctx.fillStyle = pg;
        rr(ctx, -1.9, -5.5, 3.8, 11, 1.2);
        ctx.fill();
        ctx.strokeStyle = '#6d7480';
        ctx.lineWidth = 0.7;
        ctx.stroke();
        ctx.restore();
      }
      // 5G waves washing out from the head
      if (o.on) {
        for (let i = 0; i < 3; i++) {
          const ph = ((t * 0.9 + i / 3) % 1);
          ctx.strokeStyle = `rgba(140,208,255,${0.7 * (1 - ph)})`;
          ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.arc(0, -H + 2, 6 + ph * 13, -2.4, -0.7); ctx.stroke();
          ctx.beginPath(); ctx.arc(0, -H + 2, 6 + ph * 13, Math.PI + 0.7, Math.PI + 2.4); ctx.stroke();
        }
      }
      // aviation light on the tip
      if (Math.sin(t * 2.4) > 0.2) {
        ctx.fillStyle = '#ff5f5f';
        ctx.beginPath(); ctx.arc(0, -H - 3.5, 1.6, 0, TAU); ctx.fill();
      }
    });
  };
  B.stalagmite = (ctx, t, o) => {
    pad(ctx, o);
    // rubble skirt on the ground
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(3, 4, 15, 7, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#665c4e';
    ctx.beginPath(); ctx.ellipse(0, 0, 14, 7.5, 0, 0, TAU); ctx.fill();
    for (const [px, py, s] of [[-10, 3, 3.4], [11, 2, 2.8], [4, 6, 2.4]]) {
      ctx.fillStyle = '#544b3f';
      ctx.beginPath(); ctx.ellipse(px, py, s, s * 0.6, 0.3, 0, TAU); ctx.fill();
    }
    // one towering rock spike (the turret perches on its flat tip)
    const H = 26;
    billboard(ctx, 0, 2, () => {
      const g = ctx.createLinearGradient(-9, 0, 9, 0);
      g.addColorStop(0, '#57503f');
      g.addColorStop(0.55, '#9c9080');
      g.addColorStop(1, '#6e6355');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(-7, -H * 0.45);
      ctx.lineTo(-4.5, -H * 0.8);
      ctx.lineTo(-3, -H);
      ctx.lineTo(3.5, -H);
      ctx.lineTo(6, -H * 0.7);
      ctx.lineTo(9.5, -H * 0.35);
      ctx.lineTo(11, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#453e33';
      ctx.lineWidth = 1;
      ctx.stroke();
      // cracks
      ctx.strokeStyle = 'rgba(40,34,26,0.5)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-2, -H + 3); ctx.lineTo(-5, -H * 0.55); ctx.lineTo(-3, -H * 0.3);
      ctx.moveTo(4, -H * 0.85); ctx.lineTo(6.5, -H * 0.5);
      ctx.stroke();
      // small side spike
      ctx.fillStyle = '#7c7261';
      ctx.beginPath();
      ctx.moveTo(6, 0); ctx.lineTo(10.5, -9); ctx.lineTo(13.5, 0);
      ctx.closePath();
      ctx.fill();
    });
  };
  B.pylon = (ctx, t, o) => {
    pad(ctx, o);
    towerDeck(ctx, 12.5, '#3d4450', '#1e222a');
    const pulse = o.on ? 0.5 + 0.5 * Math.sin(t * 4) : 0.1;
    // rune ring on the deck
    ctx.strokeStyle = `rgba(201,167,255,${0.25 + pulse * 0.35})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 6; i++) {
      const a = i * 1.05 + t * 0.3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 8, Math.sin(a) * 8);
      ctx.lineTo(Math.cos(a) * 11, Math.sin(a) * 11);
      ctx.stroke();
    }
    // crystal hovering over the deck (screen-space, so it stands UP)
    const H = 15;
    ctx.fillStyle = `rgba(150,110,220,${0.14 + pulse * 0.25})`; // under-glow
    ctx.beginPath(); ctx.ellipse(0, 0, 8, 4, 0, 0, TAU); ctx.fill();
    billboard(ctx, 0, 0, () => {
      const lev = Math.sin(t * 2.2) * 2;
      const cy = -H + lev;
      const g = ctx.createLinearGradient(-9, cy - 14, 9, cy + 14);
      g.addColorStop(0, `rgba(232,214,255,${0.85 + pulse * 0.15})`);
      g.addColorStop(1, `rgba(146,100,222,${0.7 + pulse * 0.3})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, cy - 14); ctx.lineTo(8.5, cy); ctx.lineTo(0, cy + 12); ctx.lineTo(-8.5, cy);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#7d5cc4';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // facet lines + sparkle
      ctx.strokeStyle = 'rgba(120,80,190,0.55)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(0, cy - 14); ctx.lineTo(0, cy + 12);
      ctx.moveTo(-8.5, cy); ctx.lineTo(8.5, cy);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(-3, cy - 6); ctx.lineTo(-0.5, cy - 11); ctx.stroke();
      if (o.on) {
        ctx.strokeStyle = `rgba(201,167,255,${0.3 + pulse * 0.4})`;
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(-5, cy + 8); ctx.lineTo(-1 + Math.sin(t * 9) * 2, -1);
        ctx.moveTo(5, cy + 8); ctx.lineTo(1 + Math.sin(t * 7) * 2, -1);
        ctx.stroke();
      }
    });
  };
  B.laserpointer = (ctx, t, o) => {
    pad(ctx, o);
    // sky-aimed giant laser pointer on a tripod gimbal
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath(); ctx.ellipse(2, 3, 13, 6, 0, 0, TAU); ctx.fill();
    billboard(ctx, 0, 0, () => {
      // tripod
      ctx.strokeStyle = '#59616c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-9, 2); ctx.lineTo(0, -10);
      ctx.moveTo(9, 2); ctx.lineTo(0, -10);
      ctx.moveTo(0, 4); ctx.lineTo(0, -10);
      ctx.stroke();
      // the pointer body: fat silver pen angled at the sky
      ctx.save();
      ctx.translate(0, -12);
      ctx.rotate(-0.9 + Math.sin(t * 0.6) * 0.06);
      const bg = ctx.createLinearGradient(0, -4, 0, 4);
      bg.addColorStop(0, '#e8ecf1');
      bg.addColorStop(0.5, '#aeb5bf');
      bg.addColorStop(1, '#7c828c');
      ctx.fillStyle = bg;
      rr(ctx, -7, -4, 22, 8, 3.5);
      ctx.fill();
      ctx.strokeStyle = '#5d646d';
      ctx.lineWidth = 1;
      ctx.stroke();
      // clicky button
      ctx.fillStyle = '#c0392b';
      ctx.beginPath(); ctx.ellipse(-1, -4.2, 2.4, 1.4, 0, 0, TAU); ctx.fill();
      // emitter tip + beam glow
      const pw = o.on ? 0.6 + 0.4 * Math.sin(t * 6) : 0.15;
      ctx.fillStyle = '#59616c';
      ctx.fillRect(15, -2.6, 3.5, 5.2);
      ctx.fillStyle = `rgba(255,110,110,${pw})`;
      ctx.beginPath(); ctx.arc(19.5, 0, 2.2, 0, TAU); ctx.fill();
      if (o.on) {
        const lg = ctx.createLinearGradient(19, 0, 34, 0);
        lg.addColorStop(0, `rgba(255,90,90,${0.5 * pw})`);
        lg.addColorStop(1, 'rgba(255,90,90,0)');
        ctx.strokeStyle = lg;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(19, 0); ctx.lineTo(34, 0); ctx.stroke();
      }
      ctx.restore();
    });
    // AAA battery crate on the pad
    isoBox(ctx, -18, 6, 9, 7, 4, '#59524a', {});
  };
  B.samsite = (ctx, t, o) => {
    pad(ctx, o);
    // armored emplacement ring
    towerDeck(ctx, 13.5, '#3f4854', '#1f242b');
    // twin missile pods RAISED at the sky (screen space)
    billboard(ctx, -3, 2, () => {
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.translate(s * 6, -4);
        ctx.rotate(-0.62);
        const pg = ctx.createLinearGradient(0, -4, 0, 4);
        pg.addColorStop(0, '#5d6a78');
        pg.addColorStop(1, '#3c444f');
        ctx.fillStyle = pg;
        rr(ctx, -7, -4.5, 16, 9, 2);
        ctx.fill();
        ctx.strokeStyle = '#2c323b';
        ctx.lineWidth = 1;
        ctx.stroke();
        // three tube mouths at the top end
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = '#20242a';
          ctx.beginPath(); ctx.ellipse(8, -3 + i * 3, 1.6, 1.3, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = o.on ? '#e8edf2' : '#5d646d';
          ctx.beginPath(); ctx.arc(8, -3 + i * 3, 0.7, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }
    });
    // radar mast with spinning bar
    billboard(ctx, 9, 6, () => {
      ctx.strokeStyle = '#59616c';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -12); ctx.stroke();
      ctx.save();
      ctx.translate(0, -12);
      ctx.scale(Math.sin(o.on ? t * 3 : 0.8), 1); // bar seen edge-on as it spins
      ctx.strokeStyle = '#9aa2ac';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(5, 0); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#20242a';
      ctx.beginPath(); ctx.arc(0, -12, 1.4, 0, TAU); ctx.fill();
    });
  };
  B.geyser = (ctx, t, o) => {
    pad(ctx, o);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(2, 3, 15, 13, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#665c4e';
    ctx.beginPath(); ctx.arc(0, 0, 14, 0, TAU); ctx.fill();
    ctx.fillStyle = '#74695a';
    ctx.beginPath(); ctx.arc(-2, -2, 10, 0, TAU); ctx.fill();
    // rim stones
    ctx.fillStyle = '#544b3f';
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9;
      ctx.beginPath();
      ctx.ellipse(Math.cos(a) * 11.5, Math.sin(a) * 11.5, 2.8, 1.8, a, 0, TAU);
      ctx.fill();
    }
    // shimmering water
    const shim = 0.5 + 0.5 * Math.sin(t * 3.4);
    const g = ctx.createRadialGradient(-1, -1, 1, 0, 0, 7);
    g.addColorStop(0, `rgba(120,190,215,${0.65 + shim * 0.3})`);
    g.addColorStop(1, 'rgba(45,90,110,0.85)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(200,240,250,${0.3 + shim * 0.3})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.arc(0, 0, 4 + shim * 2, 0, TAU); ctx.stroke();
    if (o.on && Math.random() < 0.1 && window.Particles) {
      Particles.spawn({ kind: 'smoke', x: o.wx, y: o.wy, vx: (Math.random() - 0.5) * 6, vy: -24, r: 2, grow: 6, life: 0.7, maxLife: 0.7 });
    }
  };
  B.tractor = (ctx, t, o) => {
    pad(ctx, o);
    towerDeck(ctx, 12.5, '#3d4450', '#1e222a');
    // dish raised on an upright gimbal pylon, cupped at the sky
    billboard(ctx, 0, 0, () => {
      const H = 15;
      ctx.strokeStyle = '#59616c';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -H); ctx.stroke();
      ctx.strokeStyle = '#454c56';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-6, -1); ctx.lineTo(0, -H * 0.55);
      ctx.moveTo(6, -1); ctx.lineTo(0, -H * 0.55);
      ctx.stroke();
      // upturned dish: solid cup silhouette with a dark inner bowl
      const dg = ctx.createLinearGradient(-13, -H - 7, 13, -H);
      dg.addColorStop(0, '#d5dae2');
      dg.addColorStop(1, '#79828e');
      ctx.fillStyle = dg;
      ctx.beginPath();
      ctx.moveTo(-13, -H - 7);
      ctx.quadraticCurveTo(0, -H + 4, 13, -H - 7);
      ctx.ellipse(0, -H - 7, 13, 3.4, 0, 0, Math.PI, false);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#5c636e';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(24,30,36,0.65)';
      ctx.beginPath();
      ctx.ellipse(0, -H - 7, 13, 3.4, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.ellipse(0, -H - 7, 13, 3.4, 0, Math.PI, TAU); ctx.stroke();
      // feed horn + charge glow
      ctx.strokeStyle = '#8b939e';
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.moveTo(0, -H - 7); ctx.lineTo(0, -H - 15); ctx.stroke();
      ctx.fillStyle = `rgba(125,255,214,${o.on ? 0.6 + 0.4 * Math.sin(t * 5) : 0.25})`;
      ctx.beginPath(); ctx.arc(0, -H - 15, 2.6, 0, TAU); ctx.fill();
    });
  };
  B.sleepercell = (ctx, t, o) => {
    // camo-net hideout â€” deliberately low-profile, no pad
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    rr(ctx, -o.w / 2 + 2, -o.h / 2 + 3, o.w, o.h, 5);
    ctx.fill();
    ctx.fillStyle = '#44503c';
    rr(ctx, -o.w / 2, -o.h / 2, o.w, o.h, 5);
    ctx.fill();
    ctx.fillStyle = '#57644c';
    ctx.beginPath(); ctx.arc(-3, 2, 5.5, 0, TAU); ctx.fill();
    ctx.fillStyle = '#3a4534';
    ctx.beginPath(); ctx.arc(4, -3, 4.5, 0, TAU); ctx.fill();
    // camo net crosshatch
    ctx.strokeStyle = 'rgba(30,38,26,0.5)';
    ctx.lineWidth = 0.7;
    for (let i = -8; i <= 8; i += 4) {
      ctx.beginPath(); ctx.moveTo(i - 3, -o.h / 2 + 1); ctx.lineTo(i + 3, o.h / 2 - 1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(i + 3, -o.h / 2 + 1); ctx.lineTo(i - 3, o.h / 2 - 1); ctx.stroke();
    }
    ctx.strokeStyle = '#9aa2ac';
    ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(5, 3); ctx.lineTo(10, -5); ctx.stroke();
    blinker(ctx, t, 10, -5, '#7fff9f', 2);
  };

  B.aanest = (ctx, t, o) => {
    pad(ctx, o);
    // dirt floor ringed by sandbags
    ctx.fillStyle = '#5c5344';
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#463f34'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, TAU); ctx.stroke();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      sandbag(ctx, Math.cos(a) * 13, Math.sin(a) * 13, a + Math.PI / 2);
    }
    crateBox(ctx, 5, 5, 5);
    // gunner hunched at the mount (engine draws the swiveling barrel on top)
    ctx.fillStyle = '#3a4534';
    ctx.beginPath(); ctx.arc(-4, -3, 2.8, 0, TAU); ctx.fill();
    ctx.fillStyle = '#d9b38c';
    ctx.beginPath(); ctx.arc(-4, -3, 1.5, 0, TAU); ctx.fill();
  };
  B.house = (ctx, t, o) => {
    // variant keyed off world position so settlements aren't clone rows
    const v = Math.abs(Math.floor(((o.wx || 0) * 7 + (o.wy || 0) * 13))) % 3;
    const w = o.w, h = o.h;
    // yard + shadow
    ctx.fillStyle = 'rgba(110,100,70,0.28)';
    rr(ctx, -w / 2, -h / 2, w, h, 5); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    rr(ctx, -w / 2 + 7, -h / 2 + 8, w - 9, h - 11, 3); ctx.fill();
    // roof with ridge line, lit north slope
    const roof = ['#7a4a3a', '#5d6470', '#6b5a45'][v];
    ctx.fillStyle = roof;
    rr(ctx, -w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    rr(ctx, -w / 2 + 4, -h / 2 + 4, w - 8, (h - 8) / 2, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.moveTo(-w / 2 + 5, 0); ctx.lineTo(w / 2 - 5, 0); ctx.stroke();
    // shingle seams
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 0.7;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath(); ctx.moveTo(i * 8, -h / 2 + 5); ctx.lineTo(i * 8, h / 2 - 5); ctx.stroke();
    }
    // chimney + porch
    ctx.fillStyle = '#5a4f45';
    ctx.fillRect(w / 2 - 15, -h / 2 + 8, 6.5, 6.5);
    ctx.strokeStyle = '#38322b'; ctx.lineWidth = 1;
    ctx.strokeRect(w / 2 - 15, -h / 2 + 8, 6.5, 6.5);
    ctx.fillStyle = ['#8a7a63', '#7d7480', '#75816c'][v];
    ctx.fillRect(-7, h / 2 - 8, 14, 8);
    ctx.fillStyle = '#2c2620';
    ctx.fillRect(-3, h / 2 - 7, 6, 7);
  };
  B.apartment = (ctx, t, o) => {
    const w = o.w, h = o.h;
    const v = Math.abs(Math.floor(((o.wx || 0) * 11 + (o.wy || 0) * 5))) % 2;
    // deep shadow for a tall building
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    rr(ctx, -w / 2 + 8, -h / 2 + 9, w - 9, h - 11, 3); ctx.fill();
    // flat roof with parapet
    const body = v ? '#6e6a72' : '#7a736a';
    ctx.fillStyle = body;
    rr(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    rr(ctx, -w / 2 + 3, -h / 2 + 3, (w - 6) / 2, h - 6, 3); ctx.fill();
    // rooftop clutter: stairwell box, AC units, vents
    ctx.fillStyle = '#4d4a52';
    ctx.fillRect(-w / 2 + 9, -h / 2 + 9, 13, 10);
    ctx.strokeStyle = '#33313a'; ctx.lineWidth = 1;
    ctx.strokeRect(-w / 2 + 9, -h / 2 + 9, 13, 10);
    for (let i = 0; i < 3; i++) {
      const ax = w / 2 - 15, ay = -h / 2 + 12 + i * 12;
      ctx.fillStyle = '#8b939e';
      ctx.fillRect(ax, ay, 8, 8);
      ctx.strokeStyle = '#5d646d';
      ctx.strokeRect(ax, ay, 8, 8);
      ctx.beginPath(); ctx.arc(ax + 4, ay + 4, 2.6, 0, TAU); ctx.stroke();
    }
    ctx.fillStyle = '#3a3740';
    for (let i = 0; i < 4; i++) ctx.fillRect(-8 + (i % 2) * 9, 2 + Math.floor(i / 2) * 9, 5, 5);
    // rooftop water tank
    drum3d(ctx, -6, h / 2 - 14, 6, '#5a5148', 3);
    blinker(ctx, t, w / 2 - 8, -h / 2 + 8, '#ff5f5f', 2);
  };
  B.barn = (ctx, t, o) => {
    const w = o.w, h = o.h;
    // dirt yard + shadow
    ctx.fillStyle = 'rgba(120,100,60,0.3)';
    ctx.beginPath(); ctx.ellipse(0, 2, w * 0.62, h * 0.6, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    rr(ctx, -w / 2 + 7, -h / 2 + 8, w - 9, h - 11, 3); ctx.fill();
    // faded red gabled roof, ridge along the long axis
    ctx.fillStyle = '#8a4438';
    rr(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    rr(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, (h - 6) / 2, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(40,20,16,0.5)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(-w / 2 + 4, 0); ctx.lineTo(w / 2 - 4, 0); ctx.stroke();
    // plank seams
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 0.8;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath(); ctx.moveTo(i * 11, -h / 2 + 4); ctx.lineTo(i * 11, h / 2 - 4); ctx.stroke();
    }
    // white door cross at the gable end
    ctx.strokeStyle = '#e8e4da';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(w / 2 - 12, -6, 9, 12);
    ctx.beginPath();
    ctx.moveTo(w / 2 - 12, -6); ctx.lineTo(w / 2 - 3, 6);
    ctx.moveTo(w / 2 - 3, -6); ctx.lineTo(w / 2 - 12, 6);
    ctx.stroke();
    // hay bales by the wall
    ctx.fillStyle = '#b89b4a';
    ctx.beginPath(); ctx.arc(-w / 2 - 6, 6, 5, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.arc(-w / 2 - 5, -5, 4.2, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#8f7838'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(-w / 2 - 6, 6, 2.6, 0, TAU); ctx.stroke();
  };
  B.derrick = (ctx, t, o) => {
    // oil-stained pad
    ctx.fillStyle = 'rgba(18,15,11,0.4)';
    ctx.beginPath(); ctx.ellipse(0, 4, o.w * 0.48, o.h * 0.38, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#4a443c';
    rr(ctx, -o.w / 2 + 5, -o.h / 2 + 7, o.w - 10, o.h - 13, 3); ctx.fill();
    ctx.strokeStyle = '#2e2a24'; ctx.lineWidth = 1; ctx.stroke();
    // lattice tower leaning up-left for height
    ctx.strokeStyle = '#8b7f5e';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-9, 9); ctx.lineTo(-3, -15);
    ctx.moveTo(5, 9); ctx.lineTo(-1, -15);
    ctx.stroke();
    ctx.lineWidth = 0.8;
    for (let i = 1; i <= 3; i++) {
      const f = i / 4;
      ctx.beginPath();
      ctx.moveTo(-9 + 6 * f, 9 - 24 * f);
      ctx.lineTo(5 - 6 * f, 9 - 24 * f);
      ctx.stroke();
    }
    // nodding pumpjack arm
    const nod = Math.sin(t * 2.1) * 0.3;
    ctx.save();
    ctx.translate(4, 8);
    ctx.rotate(nod);
    ctx.strokeStyle = '#9a8a5f';
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(11, 0); ctx.stroke();
    ctx.fillStyle = '#6e6248';
    ctx.beginPath(); ctx.arc(11, 0, 3, 0, TAU); ctx.fill();
    ctx.restore();
    drum3d(ctx, -o.w / 2 + 13, o.h / 2 - 13, 5, '#5d646d', 2);
    drum3d(ctx, -o.w / 2 + 22, o.h / 2 - 11, 4, '#4d5560', 2);
    blinker(ctx, t, -2, -15, '#ffd75f', 2);
  };
  B.office = (ctx, t, o) => {
    const w = o.w, h = o.h;
    // deep shadow, then tiers stepping up-left like the glob HQ
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    rr(ctx, -w / 2 + 9, -h / 2 + 10, w - 10, h - 12, 3); ctx.fill();
    block(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 3, '#5d6470', 5);
    block(ctx, -w / 2 + 8, -h / 2 + 8, w - 20, h - 20, 3, '#6a7280', 4);
    // glass curtain streak
    ctx.fillStyle = 'rgba(150,200,235,0.16)';
    ctx.beginPath();
    ctx.moveTo(-w * 0.18, h * 0.22); ctx.lineTo(-w * 0.02, -h * 0.28);
    ctx.lineTo(w * 0.1, -h * 0.28); ctx.lineTo(-w * 0.06, h * 0.22);
    ctx.closePath(); ctx.fill();
    // roof furniture: elevator house, vents, dish
    ctx.fillStyle = '#454c58';
    ctx.fillRect(-w / 2 + 11, -h / 2 + 11, 11, 9);
    ctx.strokeStyle = '#31363f'; ctx.lineWidth = 1;
    ctx.strokeRect(-w / 2 + 11, -h / 2 + 11, 11, 9);
    ctx.fillStyle = '#8b939e';
    for (let i = 0; i < 2; i++) ctx.fillRect(w / 2 - 20 + i * 8, -h / 2 + 13, 5, 5);
    ctx.strokeStyle = '#9aa2ac';
    ctx.beginPath(); ctx.arc(w / 2 - 15, h / 2 - 15, 4, 0.6, Math.PI * 1.4); ctx.stroke();
    // window grid on the visible tier
    ctx.fillStyle = 'rgba(20,24,30,0.5)';
    for (let ix = 0; ix < 3; ix++) {
      for (let iy = 0; iy < 3; iy++) ctx.fillRect(-8 + ix * 8, -4 + iy * 8, 4.5, 4.5);
    }
    blinker(ctx, t, 0, -h / 2 + 6, '#ff5f5f', 2.2);
  };
  B.shop = (ctx, t, o) => {
    const w = o.w, h = o.h;
    const v = Math.abs(Math.floor(((o.wx || 0) * 5 + (o.wy || 0) * 17))) % 3;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    rr(ctx, -w / 2 + 6, -h / 2 + 7, w - 8, h - 9, 3); ctx.fill();
    // flat tar roof
    ctx.fillStyle = ['#6b655c', '#5f6468', '#6e6055'][v];
    rr(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 2.5); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    rr(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, (h - 6) / 2, 2.5); ctx.fill();
    // striped storefront awning along the south face
    const stripe = ['#b04a3a', '#3a6ab0', '#3a8a4a'][v];
    for (let i = 0; i < Math.floor((w - 10) / 7); i++) {
      ctx.fillStyle = i % 2 ? stripe : '#ded8c8';
      ctx.fillRect(-w / 2 + 5 + i * 7, h / 2 - 7, 7, 6);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.strokeRect(-w / 2 + 5, h / 2 - 7, Math.floor((w - 10) / 7) * 7, 6);
    // rooftop sign box + AC unit
    ctx.fillStyle = '#2e333b';
    rr(ctx, -9, -h / 2 + 6, 18, 8, 1.5); ctx.fill();
    ctx.fillStyle = ['#ffd75f', '#8cd0ff', '#7fff9f'][v];
    ctx.font = 'bold 6px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(['MART', 'DINER', 'PAWN'][v], 0, -h / 2 + 10.2);
    ctx.fillStyle = '#8b939e';
    ctx.fillRect(w / 2 - 13, -h / 2 + 7, 6, 6);
    ctx.strokeStyle = '#5d646d'; ctx.strokeRect(w / 2 - 13, -h / 2 + 7, 6, 6);
  };
  B.church = (ctx, t, o) => {
    const w = o.w, h = o.h;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    rr(ctx, -w / 2 + 6, -h / 2 + 8, w - 8, h - 10, 3); ctx.fill();
    // long gabled nave, ridge down the long (vertical) axis
    ctx.fillStyle = '#7d7468';
    rr(ctx, -w / 2 + 4, -h / 2 + 4, w - 8, h - 8, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.13)';
    rr(ctx, -w / 2 + 4, -h / 2 + 4, (w - 8) / 2, h - 8, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(40,32,24,0.5)';
    ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.moveTo(0, -h / 2 + 5); ctx.lineTo(0, h / 2 - 5); ctx.stroke();
    // shingle seams
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'; ctx.lineWidth = 0.7;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath(); ctx.moveTo(-w / 2 + 5, i * 9); ctx.lineTo(w / 2 - 5, i * 9); ctx.stroke();
    }
    // steeple at the south end: white tower, dark spire cap, cross
    ctx.fillStyle = '#e8e4da';
    ctx.fillRect(-6, h / 2 - 16, 12, 12);
    ctx.strokeStyle = '#a8a294'; ctx.lineWidth = 1;
    ctx.strokeRect(-6, h / 2 - 16, 12, 12);
    ctx.fillStyle = '#4a4440';
    ctx.beginPath();
    ctx.moveTo(-6, h / 2 - 16); ctx.lineTo(0, h / 2 - 22); ctx.lineTo(6, h / 2 - 16);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#f2eee2'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, h / 2 - 27); ctx.lineTo(0, h / 2 - 21);
    ctx.moveTo(-2.4, h / 2 - 25); ctx.lineTo(2.4, h / 2 - 25);
    ctx.stroke();
    // stained-glass rose window at the north gable
    ctx.fillStyle = '#3a5a8a';
    ctx.beginPath(); ctx.arc(0, -h / 2 + 10, 3.4, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#d8d2c2'; ctx.lineWidth = 0.7; ctx.stroke();
  };
  B.warehouse = (ctx, t, o) => {
    const w = o.w, h = o.h;
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    rr(ctx, -w / 2 + 7, -h / 2 + 8, w - 9, h - 10, 3); ctx.fill();
    // long ribbed metal roof
    ctx.fillStyle = '#5f6a72';
    rr(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1.4; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    rr(ctx, -w / 2 + 3, -h / 2 + 3, w - 6, (h - 6) / 2, 3); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.2)'; ctx.lineWidth = 0.8;
    for (let i = 1; i < Math.floor(w / 9); i++) {
      const sx = -w / 2 + 3 + i * 9;
      ctx.beginPath(); ctx.moveTo(sx, -h / 2 + 4); ctx.lineTo(sx, h / 2 - 4); ctx.stroke();
    }
    // skylight strip
    ctx.fillStyle = 'rgba(170,215,240,0.3)';
    rr(ctx, -w / 2 + 10, -2.5, w - 20, 5, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 0.7; ctx.stroke();
    // loading dock: two bay doors on the south side + pallets
    ctx.fillStyle = '#3a3f45';
    ctx.fillRect(-w / 2 + 10, h / 2 - 7, 12, 6);
    ctx.fillRect(-w / 2 + 26, h / 2 - 7, 12, 6);
    ctx.strokeStyle = 'rgba(220,190,80,0.6)'; ctx.lineWidth = 1;
    ctx.strokeRect(-w / 2 + 10, h / 2 - 7, 12, 6);
    ctx.strokeRect(-w / 2 + 26, h / 2 - 7, 12, 6);
    ctx.fillStyle = '#8a6f42';
    ctx.fillRect(w / 2 - 16, h / 2 - 9, 7, 5);
    ctx.fillRect(w / 2 - 24, h / 2 - 8, 6, 4);
    blinker(ctx, t, w / 2 - 7, -h / 2 + 7, '#ffd75f', 2.5);
  };
  B.gasstation = (ctx, t, o) => {
    const w = o.w, h = o.h;
    // oil-stained forecourt
    ctx.fillStyle = 'rgba(20,18,14,0.35)';
    ctx.beginPath(); ctx.ellipse(2, 3, w * 0.55, h * 0.52, 0, 0, TAU); ctx.fill();
    // kiosk at the west end
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    rr(ctx, -w / 2 + 6, -h / 2 + 8, 20, h - 12, 2); ctx.fill();
    ctx.fillStyle = '#6e6558';
    rr(ctx, -w / 2 + 4, -h / 2 + 5, 20, h - 12, 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
    // white canopy over the pumps, red trim
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    rr(ctx, -2, -h / 2 + 9, w / 2 - 4, h - 14, 2); ctx.fill();
    ctx.fillStyle = '#ded8cc';
    rr(ctx, -4, -h / 2 + 6, w / 2 - 4, h - 14, 2); ctx.fill();
    ctx.strokeStyle = '#b04a3a'; ctx.lineWidth = 1.6; ctx.stroke();
    // pumps peeking out under the canopy edge
    ctx.fillStyle = '#b04a3a';
    ctx.fillRect(2, h / 2 - 8, 4, 5);
    ctx.fillRect(12, h / 2 - 8, 4, 5);
    // price sign + fuel drums
    ctx.fillStyle = '#2e333b';
    ctx.fillRect(w / 2 - 8, -h / 2 + 4, 6, 10);
    ctx.fillStyle = '#ffd75f';
    ctx.font = 'bold 5px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('GAS', w / 2 - 5, -h / 2 + 9);
    drum3d(ctx, -w / 2 + 9, h / 2 - 6, 4, '#8a4438', 2);
    drum3d(ctx, -w / 2 + 17, h / 2 - 5, 3.5, '#7a6f42', 2);
  };

  // ================= TECH LAB (research site, one look per family) =================
  B.tech = (ctx, t, o) => {
    pad(ctx, o);
    if (o.fam === 'flat') {
      // conspiracy research camp: shack, corkboard wall, giant tinfoil dish
      isoBox(ctx, -24, -8, 24, 24, 9, '#6a6352', { doorSE: { w: 7, h: 7 } });
      // corkboard of TRUTH standing on posts (red string included)
      billboard(ctx, 12, -20, () => {
        ctx.strokeStyle = '#5b503b';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(-9, 0); ctx.lineTo(-9, -12);
        ctx.moveTo(9, 0); ctx.lineTo(9, -12);
        ctx.stroke();
        ctx.fillStyle = '#8a7a5c';
        rr(ctx, -11, -13, 22, 12, 1);
        ctx.fill();
        ctx.strokeStyle = '#5f5340';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(-8, -10); ctx.lineTo(1, -5); ctx.lineTo(-4, -3.5); ctx.lineTo(7, -9.5);
        ctx.stroke();
        ctx.fillStyle = '#e8e4da';
        for (const [px, py] of [[-8, -10], [1, -5], [7, -9.5], [-4, -3.5]]) ctx.fillRect(px - 1, py - 1, 2, 2);
      });
      // the tinfoil dish, upright on its mount, aimed at the sky they distrust
      billboard(ctx, 8, 12, () => {
        ctx.strokeStyle = '#59616c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-5, 1); ctx.lineTo(0, -7);
        ctx.moveTo(5, 2); ctx.lineTo(0, -7);
        ctx.stroke();
        ctx.save();
        ctx.translate(0, -9);
        ctx.rotate(-0.5 + Math.sin(t * 0.7) * 0.12);
        const dg = ctx.createLinearGradient(-12, 0, 12, 0);
        dg.addColorStop(0, '#e8ecf2');
        dg.addColorStop(1, '#9aa2ac');
        ctx.fillStyle = dg;
        ctx.beginPath(); ctx.ellipse(0, 0, 12, 4.5, 0, 0, TAU); ctx.fill();
        ctx.strokeStyle = '#6d7480';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.strokeStyle = '#8b939e';
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -7); ctx.stroke();
        ctx.fillStyle = '#4a4438';
        ctx.beginPath(); ctx.arc(0, -7, 1.6, 0, TAU); ctx.fill();
        ctx.restore();
      });
      crateBox(ctx, -8, 20, 6);
    } else if (o.fam === 'glob') {
      // black-glass research block with a rooftop radome
      const rt = isoBox(ctx, -20, -20, 40, 40, 14, '#2c323d',
        { win: { rows: 2, paneH: 4, litRate: 3, seed: 6, litCol: 'rgba(140,208,255,0.6)' }, doorSE: { w: 9, h: 8 } });
      // radome standing on the roof
      billboard(ctx, rt[0] + 26, rt[1] + 26, () => {
        const rg = ctx.createRadialGradient(-2.5, -8, 1, 0, -6, 10);
        rg.addColorStop(0, '#f2f5f9');
        rg.addColorStop(1, '#aab3bf');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.moveTo(-8, 0);
        ctx.arc(0, 0, 8, Math.PI, 0);
        ctx.ellipse(0, 0, 8, 2.6, 0, 0, Math.PI);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#6d7480';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.beginPath(); ctx.ellipse(0, -3.8, 5.6, 1.8, 0, Math.PI, 0); ctx.stroke();
        if (Math.sin(t * 2.6) > 0.2) {
          ctx.fillStyle = '#8cd0ff';
          ctx.beginPath(); ctx.arc(0, -8.8, 1.4, 0, TAU); ctx.fill();
        }
      });
      // server vent bank on the roof edge
      ctx.fillStyle = '#1d2129';
      for (let i = 0; i < 3; i++) ctx.fillRect(rt[0] + 6 + i * 7, rt[1] + 30, 5, 7);
      blinker(ctx, t + 1.3, rt[0] + 2, rt[1] + 2, '#ff5f5f', 2);
    } else if (o.fam === 'hollow') {
      // exposed geode forge: cracked mound over a glowing crystal core
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(3, 4, 24, 22, 0, 0, TAU); ctx.fill();
      for (const [rad, col] of [[23, '#4e463b'], [17, '#5c5347']]) {
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(-((23 - rad) * 0.3), -((23 - rad) * 0.3), rad, 0, TAU); ctx.fill();
      }
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
      ctx.fillStyle = `rgba(255,150,70,${0.25 + pulse * 0.3})`;
      ctx.beginPath(); ctx.arc(-2, -2, 12, 0, TAU); ctx.fill();
      // crystal spikes
      for (let i = 0; i < 5; i++) {
        const a = i * 1.26 + 0.4;
        const cx2 = -2 + Math.cos(a) * 7, cy2 = -2 + Math.sin(a) * 6;
        ctx.fillStyle = `rgba(190,230,255,${0.6 + pulse * 0.3})`;
        ctx.beginPath();
        ctx.moveTo(cx2 - 3, cy2 + 2);
        ctx.lineTo(cx2 + Math.cos(a) * 8, cy2 + Math.sin(a) * 8 - 6);
        ctx.lineTo(cx2 + 3, cy2 + 2);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(90,130,170,0.7)'; ctx.lineWidth = 0.7; ctx.stroke();
      }
      // anvil-drill rig on the rim
      block(ctx, 12, 6, 12, 12, 2, '#59524a', 3);
      ctx.strokeStyle = '#8b7f5e'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(18, 6); ctx.lineTo(14, -6); ctx.stroke();
    } else {
      // alien: levitating obelisk standing over a containment ring
      ctx.strokeStyle = 'rgba(125,255,214,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(0, 4, 22, 11, 0, 0, TAU); ctx.stroke();
      const bob2 = Math.sin(t * 1.6) * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(0, 5, 9 - bob2 * 0.6, 4.5 - bob2 * 0.3, 0, 0, TAU); ctx.fill();
      billboard(ctx, 0, 4, () => {
        const base = -6 - bob2; // hover height
        const og = ctx.createLinearGradient(-7, base - 26, 7, base);
        og.addColorStop(0, '#d7dce4');
        og.addColorStop(0.6, '#8b93a6');
        og.addColorStop(1, '#5a6172');
        ctx.fillStyle = og;
        ctx.beginPath();
        ctx.moveTo(0, base - 28);
        ctx.lineTo(7, base - 14); ctx.lineTo(4, base);
        ctx.lineTo(-4, base); ctx.lineTo(-7, base - 14);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#454b58';
        ctx.lineWidth = 1;
        ctx.stroke();
        // glyph glow lines
        const gl = 0.5 + 0.5 * Math.sin(t * 3.1);
        ctx.strokeStyle = `rgba(125,255,214,${0.4 + gl * 0.5})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(-3, base - 22); ctx.lineTo(3, base - 22); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-4, base - 16); ctx.lineTo(4, base - 16); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-3.5, base - 10); ctx.lineTo(3.5, base - 10); ctx.stroke();
      });
      // motes orbiting the ring on the ground plane
      for (let i = 0; i < 3; i++) {
        const a = t * 1.8 + i * (TAU / 3);
        ctx.fillStyle = `rgba(125,255,214,${0.5 + 0.4 * Math.sin(t * 4 + i)})`;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * 20, 4 + Math.sin(a) * 10, 1.6, 0, TAU);
        ctx.fill();
      }
    }
  };

  // ---------- public API ----------

  window.Art = {
    has: type => !!D[type],
    draw(type, ctx, t, opts) {
      const fn = D[type];
      if (fn) fn(ctx, t, opts);
      else { // fallback: plain circle
        ctx.fillStyle = opts.color;
        ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
      }
    },
    // screen-px height at which the engine's generic turret (and beam
    // origin) sits for towers whose art raises a platform
    turretLift: { watchtower: 28, stalagmite: 26, tractor: 27 },
    hasBuilding: type => !!B[type],
    building(type, ctx, t, opts) {
      const fn = B[type];
      if (!fn) { pad(ctx, opts); return; }
      // scale drawings authored at their design size to the actual footprint
      const d = BUILDING_DESIGN[type];
      if (d) {
        const s = Math.min(opts.w / d[0], opts.h / d[1]);
        ctx.save();
        ctx.scale(s, s);
        fn(ctx, t, { ...opts, w: opts.w / s, h: opts.h / s });
        ctx.restore();
      } else {
        fn(ctx, t, opts);
      }
    },
    teamGlow, shadow, shadeColor: shade,
  };
  window.Particles = Particles;
})();
