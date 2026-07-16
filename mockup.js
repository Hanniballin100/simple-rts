// ============================================================
// Unit art mockup — top-down animated vector style
// Truther Militia, Truck of Truth, Black Helicopter, Flying Saucer
// ============================================================

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

const BLUE = '#4da3ff';
const TAU = Math.PI * 2;

// ---------- particles ----------

const particles = [];

function spawn(p) { particles.push(p); }

function updateParticles(dt) {
  for (const p of particles) {
    p.life -= dt;
    p.x += (p.vx || 0) * dt;
    p.y += (p.vy || 0) * dt;
    if (p.drag) { p.vx *= 1 - p.drag * dt; p.vy *= 1 - p.drag * dt; }
  }
  for (let i = particles.length - 1; i >= 0; i--) {
    if (particles[i].life <= 0) particles.splice(i, 1);
  }
}

function drawParticles() {
  for (const p of particles) {
    const f = Math.max(0, p.life / p.maxLife);
    if (p.kind === 'tracer') {
      ctx.strokeStyle = `rgba(255, 230, 140, ${f})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    } else if (p.kind === 'spark') {
      ctx.fillStyle = `rgba(255, ${180 + Math.floor(f * 70)}, 90, ${f})`;
      ctx.fillRect(p.x - 1, p.y - 1, 2, 2);
    } else if (p.kind === 'smoke') {
      ctx.fillStyle = `rgba(110, 110, 110, ${f * 0.35})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + (1 - f) * p.grow, 0, TAU);
      ctx.fill();
    } else if (p.kind === 'flash') {
      ctx.fillStyle = `rgba(255, 240, 170, ${f * 0.9})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1.4 - f * 0.4), 0, TAU);
      ctx.fill();
    } else if (p.kind === 'ring') {
      ctx.strokeStyle = `rgba(255, 190, 110, ${f})`;
      ctx.lineWidth = 3 * f;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + (1 - f) * p.grow, 0, TAU);
      ctx.stroke();
    } else if (p.kind === 'debris') {
      ctx.fillStyle = `rgba(60, 60, 66, ${f})`;
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
  }
}

function boom(x, y, big = 1) {
  spawn({ kind: 'flash', x, y, r: 14 * big, life: 0.18, maxLife: 0.18 });
  spawn({ kind: 'ring', x, y, r: 6, grow: 34 * big, life: 0.5, maxLife: 0.5 });
  for (let i = 0; i < 14 * big; i++) {
    const a = Math.random() * TAU, s = 40 + Math.random() * 130 * big;
    spawn({ kind: 'debris', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, drag: 3, life: 0.5 + Math.random() * 0.4, maxLife: 0.8 });
  }
  for (let i = 0; i < 8 * big; i++) {
    const a = Math.random() * TAU, s = 10 + Math.random() * 30;
    spawn({ kind: 'smoke', x: x + Math.cos(a) * 6, y: y + Math.sin(a) * 6, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 8, r: 4 + Math.random() * 4, grow: 12, life: 0.9 + Math.random() * 0.8, maxLife: 1.6 });
  }
}

// ---------- unit drawings (centered at 0,0, facing +x) ----------

function shadow(rx, ry, ox = 0, oy = 0) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(ox, oy, rx, ry, 0, 0, TAU);
  ctx.fill();
}

function rr(x, y, w, h, r) { // rounded rect path
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --- Truther Militia (infantry, ~9px) ---
function drawMilitia(t, opts = {}) {
  const sway = Math.sin(t * 9) * (opts.moving ? 0.12 : 0);
  ctx.rotate(sway);
  // shoulders / body
  ctx.fillStyle = BLUE;
  rr(-3.5, -3.2, 6.2, 6.4, 2.4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  // arms hint
  ctx.fillStyle = '#3c86d6';
  ctx.fillRect(-1, -3.9, 3.4, 1.4);
  ctx.fillRect(-1, 2.5, 3.4, 1.4);
  // rifle (held across, pointing forward)
  ctx.strokeStyle = '#20242a';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.moveTo(-0.5, 2.6);
  ctx.lineTo(7.5, 1.2);
  ctx.stroke();
  ctx.fillStyle = '#20242a';
  ctx.fillRect(1.5, 1.2, 2, 1.6);
  // head + tinfoil hat
  ctx.fillStyle = '#d9b38c';
  ctx.beginPath(); ctx.arc(0.6, 0, 2.2, 0, TAU); ctx.fill();
  ctx.fillStyle = '#cfd6de';
  ctx.beginPath();
  ctx.moveTo(0.6, 0); ctx.lineTo(-1.4, -1.4); ctx.lineTo(2.4, -1.2);
  ctx.lineTo(2.0, 1.4); ctx.lineTo(-1.2, 1.5);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#9aa2ac'; ctx.lineWidth = 0.4; ctx.stroke();
  // muzzle flash
  if (opts.firing && Math.floor(t * 10) % 3 === 0) {
    ctx.fillStyle = 'rgba(255,235,150,0.95)';
    ctx.beginPath();
    ctx.moveTo(7.5, 1.2); ctx.lineTo(11.5, 0); ctx.lineTo(8.2, 2.8);
    ctx.closePath(); ctx.fill();
  }
}

// --- Truck of Truth (vehicle, ~30px long) ---
function drawTruck(t, opts = {}) {
  const wheelSpin = (opts.dist || t * 40) * 0.35;
  // wheels (6, sticking out)
  ctx.fillStyle = '#101317';
  for (const wx of [-11, -3, 10]) {
    for (const wy of [-9.5, 6.5]) {
      rr(wx - 3, wy, 6, 3, 1.2);
      ctx.fill();
      // tread marks rolling
      ctx.strokeStyle = '#2c3138';
      ctx.lineWidth = 0.8;
      for (let i = 0; i < 2; i++) {
        const p = ((wheelSpin + i * 3) % 6 + 6) % 6;
        ctx.beginPath();
        ctx.moveTo(wx - 3 + p, wy + 0.4);
        ctx.lineTo(wx - 3 + p, wy + 2.6);
        ctx.stroke();
      }
      ctx.fillStyle = '#101317';
    }
  }
  // flatbed
  ctx.fillStyle = '#2e353f';
  rr(-16, -7, 19, 14, 2);
  ctx.fill();
  ctx.strokeStyle = '#171b21'; ctx.lineWidth = 1; ctx.stroke();
  // planks
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.7;
  for (let i = -13; i < 2; i += 3.2) {
    ctx.beginPath(); ctx.moveTo(i, -6.4); ctx.lineTo(i, 6.4); ctx.stroke();
  }
  // TRUTH billboard lying on the bed
  ctx.fillStyle = '#e8e4da';
  rr(-14.5, -5, 15, 10, 1);
  ctx.fill();
  ctx.strokeStyle = '#b9b2a4'; ctx.lineWidth = 0.7; ctx.stroke();
  ctx.save();
  ctx.translate(-7, 0);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = '#c22e2e';
  ctx.font = 'bold 5.4px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TRUTH', 0, 0);
  ctx.restore();
  // cab
  ctx.fillStyle = BLUE;
  rr(3, -7.5, 12, 15, 2.5);
  ctx.fill();
  ctx.strokeStyle = '#1d5fa8'; ctx.lineWidth = 1; ctx.stroke();
  // roof highlight + windshield
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  rr(4, -6.3, 10, 5, 2);
  ctx.fill();
  ctx.fillStyle = '#17232f';
  rr(11.5, -6, 2.6, 12, 1);
  ctx.fill();
  // ram bar
  ctx.fillStyle = '#8b939e';
  rr(15.5, -8.5, 2.6, 17, 1);
  ctx.fill();
  ctx.fillStyle = '#5d646d';
  for (const y of [-6, -1.2, 3.6]) ctx.fillRect(15.9, y, 1.8, 2.4);
  // exhaust puffs while moving
  if (opts.moving && Math.random() < 0.15) {
    spawn({ kind: 'smoke', x: opts.wx - Math.cos(opts.angle) * 17, y: opts.wy - Math.sin(opts.angle) * 17, vx: 0, vy: -6, r: 1.5, grow: 4, life: 0.7, maxLife: 0.7 });
  }
}

// --- Black Helicopter (air, rotor disc ~30px) ---
function drawHeli(t, opts = {}) {
  // tail boom
  ctx.fillStyle = '#1b1e24';
  rr(-16, -1.5, 12, 3, 1.2);
  ctx.fill();
  // tail fin + tail rotor
  ctx.fillStyle = '#22262d';
  rr(-17.5, -3.5, 3.5, 7, 1);
  ctx.fill();
  ctx.save();
  ctx.translate(-15.8, 0);
  ctx.rotate(t * 26);
  ctx.strokeStyle = 'rgba(190,195,205,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(4, 0); ctx.stroke();
  ctx.restore();
  // stub wings + rocket pods
  ctx.fillStyle = '#272b33';
  rr(-2, -9.5, 7, 19, 1.5);
  ctx.fill();
  ctx.fillStyle = '#3a3f48';
  rr(0.5, -9.8, 4.5, 3, 1); ctx.fill();
  rr(0.5, 6.8, 4.5, 3, 1); ctx.fill();
  // fuselage (edge-lit so it reads against dark ground)
  ctx.fillStyle = '#1d2129';
  rr(-7, -3.8, 19, 7.6, 3.6);
  ctx.fill();
  ctx.strokeStyle = '#59626f'; ctx.lineWidth = 0.9; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  rr(-6, -3, 17, 3, 2.5);
  ctx.fill();
  // cockpit glass
  ctx.fillStyle = '#1e4a5f';
  rr(6.5, -2.8, 5.2, 5.6, 2.4);
  ctx.fill();
  ctx.fillStyle = 'rgba(140,220,255,0.5)';
  rr(7.2, -2.2, 2.4, 2.2, 1);
  ctx.fill();
  // main rotor: translucent disc + motion-blur blades
  ctx.fillStyle = 'rgba(200,205,215,0.06)';
  ctx.beginPath(); ctx.arc(1, 0, 15.5, 0, TAU); ctx.fill();
  ctx.save();
  ctx.translate(1, 0);
  ctx.rotate(t * 18);
  for (let b = 0; b < 2; b++) {
    ctx.rotate(Math.PI * b);
    const g = ctx.createLinearGradient(0, 0, 15, 0);
    g.addColorStop(0, 'rgba(210,215,225,0.85)');
    g.addColorStop(1, 'rgba(210,215,225,0.15)');
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(2, 0); ctx.lineTo(15, 0); ctx.stroke();
  }
  ctx.restore();
  // rotor hub + blinking beacon
  ctx.fillStyle = '#3c414a';
  ctx.beginPath(); ctx.arc(1, 0, 1.6, 0, TAU); ctx.fill();
  if (Math.sin(t * 6) > 0.3) {
    ctx.fillStyle = 'rgba(255,70,70,0.95)';
    ctx.beginPath(); ctx.arc(-6, 0, 1.1, 0, TAU); ctx.fill();
  }
}

// --- Flying Saucer (air, disc ~26px) ---
function drawSaucer(t, opts = {}) {
  // under-glow (pulsing)
  const pulse = 0.5 + Math.sin(t * 3.2) * 0.25;
  const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 17);
  glow.addColorStop(0, `rgba(90, 240, 220, ${0.35 * pulse})`);
  glow.addColorStop(1, 'rgba(90, 240, 220, 0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.fill();
  // hull
  const hull = ctx.createRadialGradient(-3, -3, 2, 0, 0, 13);
  hull.addColorStop(0, '#d7dce4');
  hull.addColorStop(0.7, '#9aa2ae');
  hull.addColorStop(1, '#6d7480');
  ctx.fillStyle = hull;
  ctx.beginPath(); ctx.arc(0, 0, 13, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#4d525c'; ctx.lineWidth = 1; ctx.stroke();
  // panel seams
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
  // rotating rim lights
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + t * 1.6;
    const bright = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 5 + i * 1.7));
    ctx.fillStyle = `rgba(120, 255, 235, ${bright})`;
    ctx.beginPath();
    ctx.arc(Math.cos(a) * 11, Math.sin(a) * 11, 1.15, 0, TAU);
    ctx.fill();
  }
  // dome with occupant
  const dome = ctx.createRadialGradient(-1.5, -1.5, 1, 0, 0, 5.4);
  dome.addColorStop(0, 'rgba(190,255,245,0.85)');
  dome.addColorStop(1, 'rgba(70,170,160,0.55)');
  ctx.fillStyle = dome;
  ctx.beginPath(); ctx.arc(0, 0, 5.4, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(50,110,105,0.8)'; ctx.lineWidth = 0.8; ctx.stroke();
  // the grey inside (head + big eyes, facing travel direction)
  ctx.fillStyle = '#b9c2c9';
  ctx.beginPath(); ctx.ellipse(1, 0, 2.4, 2.0, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#14161a';
  ctx.beginPath(); ctx.ellipse(2.1, -0.9, 0.8, 0.5, -0.5, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(2.1, 0.9, 0.8, 0.5, 0.5, 0, TAU); ctx.fill();
}

// ---------- scene ----------

function ground() {
  // lighter, mottled field so units pop
  ctx.fillStyle = '#31402c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // deterministic mottling
  for (let i = 0; i < 260; i++) {
    const gx = (i * 7919) % canvas.width;
    const gy = (i * 104729) % canvas.height;
    const s = 14 + (i * 31) % 34;
    ctx.fillStyle = (i % 3 === 0) ? 'rgba(66, 86, 58, 0.35)' : 'rgba(40, 52, 36, 0.35)';
    ctx.beginPath();
    ctx.ellipse(gx, gy, s, s * 0.6, (i % 7) * 0.5, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= canvas.width; x += 60) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
  }
  for (let y = 0; y <= canvas.height; y += 60) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
  }
}

// soft team-color glow under a unit — the readability anchor
function teamGlow(r, color = BLUE) {
  const g = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r);
  g.addColorStop(0, color + '66'); // ~40% alpha
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.fill();
}

function label(text, x, y) {
  ctx.fillStyle = '#8a95a3';
  ctx.font = '11px "Segoe UI", Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x, y);
}

function sectionTitle(text, y) {
  ctx.fillStyle = '#5d6774';
  ctx.font = 'bold 10px "Segoe UI", Arial';
  ctx.textAlign = 'left';
  ctx.fillText(text, 14, y);
}

// showcase slot: big, slowly rotating
function showcase(draw, x, y, scale, t, name, flying) {
  ctx.save();
  ctx.translate(x, y);
  if (flying) {
    ctx.save();
    ctx.scale(scale, scale);
    shadow(11, 5, 4, 9);
    ctx.restore();
  }
  ctx.scale(scale, scale);
  if (!flying) shadow(14, 9, 1, 2);
  teamGlow(20);
  ctx.rotate(t * 0.35);
  draw(t, {});
  ctx.restore();
  label(name, x, y + 62);
}

// patrol slot: game scale, bouncing left-right
const patrols = [
  { draw: drawMilitia, speed: 55, y: 0, flying: false, dist: 0, name: 'militia' },
  { draw: drawTruck, speed: 75, y: 0, flying: false, dist: 200, name: 'truck' },
  { draw: drawHeli, speed: 120, y: 0, flying: true, dist: 400, name: 'heli' },
  { draw: drawSaucer, speed: 100, y: 0, flying: true, dist: 600, name: 'saucer' },
];

function patrolRow(t, dt, yBase) {
  const x0 = 70, x1 = 870, span = (x1 - x0) * 2;
  patrols.forEach((p, i) => {
    p.dist += p.speed * dt;
    const m = p.dist % span;
    const forward = m < span / 2;
    const x = forward ? x0 + m : x1 - (m - span / 2);
    const y = yBase + i * 0; // same lane, offsets below
    const laneY = yBase + [0, 26, -22, 8][i];
    const bob = p.flying ? Math.sin(t * 2.4 + i) * 2.5 : 0;
    ctx.save();
    ctx.translate(x, laneY + bob);
    ctx.scale(1.4, 1.4);
    if (p.flying) shadow(9, 4, 6, 11);
    else shadow(11, 7, 0, 1.5);
    teamGlow(p.name === 'militia' ? 10 : 19);
    ctx.rotate(forward ? 0 : Math.PI);
    p.draw(t, { moving: true, dist: p.dist, wx: x, wy: laneY, angle: forward ? 0 : Math.PI });
    ctx.restore();
  });
}

// combat demo
const demo = { bunkerHp: 1, resetAt: 0 };

function combatRow(t, dt, yBase) {
  const bunkerX = 700, bunkerY = yBase;
  // bunker (target)
  ctx.save();
  ctx.translate(bunkerX, bunkerY);
  ctx.fillStyle = demo.bunkerHp > 0.4 ? '#4a4f57' : '#3a3226';
  rr(-24, -20, 48, 40, 4);
  ctx.fill();
  ctx.strokeStyle = '#2a2d33'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#383d45';
  rr(-14, -11, 28, 22, 3);
  ctx.fill();
  ctx.fillStyle = '#8a95a3';
  ctx.font = 'bold 9px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('5G', 0, 0);
  ctx.restore();
  // health bar
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(bunkerX - 24, bunkerY - 30, 48, 4);
  ctx.fillStyle = demo.bunkerHp > 0.5 ? '#5fce5f' : demo.bunkerHp > 0.25 ? '#ffd75f' : '#ff6b5f';
  ctx.fillRect(bunkerX - 24, bunkerY - 30, 48 * Math.max(0, demo.bunkerHp), 4);

  // militia squad firing
  for (let i = 0; i < 3; i++) {
    const mx = 210 + i * 34, my = yBase - 18 + i * 18;
    ctx.save();
    ctx.translate(mx, my);
    ctx.scale(1.4, 1.4);
    shadow(4.5, 3, 0, 1);
    teamGlow(10);
    const aim = Math.atan2(bunkerY - my, bunkerX - mx);
    ctx.rotate(aim);
    drawMilitia(t + i * 0.7, { firing: demo.bunkerHp > 0, moving: false });
    ctx.restore();
    // tracers
    if (demo.bunkerHp > 0 && Math.random() < 0.08) {
      const a = Math.atan2(bunkerY - my, bunkerX - mx) + (Math.random() - 0.5) * 0.05;
      spawn({ kind: 'tracer', x: mx + Math.cos(a) * 16, y: my + Math.sin(a) * 16, vx: Math.cos(a) * 900, vy: Math.sin(a) * 900, life: (Math.hypot(bunkerX - mx, bunkerY - my) - 40) / 900, maxLife: 0.6 });
    }
  }

  // helicopter strafing overhead
  const hx = 430 + Math.sin(t * 0.7) * 90;
  const hy = yBase - 46 + Math.cos(t * 1.1) * 10;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.scale(1.4, 1.4);
  shadow(9, 4, 8, 14);
  teamGlow(18);
  const haim = Math.atan2(bunkerY - hy, bunkerX - hx);
  ctx.rotate(haim);
  drawHeli(t, {});
  ctx.restore();
  if (demo.bunkerHp > 0 && Math.random() < 0.1) {
    const a = haim + (Math.random() - 0.5) * 0.04;
    spawn({ kind: 'tracer', x: hx + Math.cos(a) * 20, y: hy + Math.sin(a) * 20, vx: Math.cos(a) * 1100, vy: Math.sin(a) * 1100, life: (Math.hypot(bunkerX - hx, bunkerY - hy) - 40) / 1100, maxLife: 0.5 });
  }

  // impacts wear the bunker down; explosion + reset cycle
  if (demo.bunkerHp > 0) {
    demo.bunkerHp -= dt * 0.09;
    if (Math.random() < 0.25) {
      const ia = Math.random() * TAU;
      spawn({ kind: 'spark', x: bunkerX + Math.cos(ia) * 20, y: bunkerY + Math.sin(ia) * 14, vx: Math.cos(ia) * 60, vy: Math.sin(ia) * 60 - 20, drag: 4, life: 0.35, maxLife: 0.35 });
    }
    if (demo.bunkerHp < 0.5 && Math.random() < 0.1) {
      spawn({ kind: 'smoke', x: bunkerX + (Math.random() - 0.5) * 30, y: bunkerY - 10, vx: 0, vy: -14, r: 3, grow: 8, life: 1.2, maxLife: 1.2 });
    }
    if (demo.bunkerHp <= 0) {
      boom(bunkerX, bunkerY, 1.6);
      demo.resetAt = t + 2.5;
    }
  } else if (t > demo.resetAt) {
    demo.bunkerHp = 1;
  }
}

// ---------- main loop ----------

let last = performance.now();

function frame(now) {
  const t = now / 1000;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  ground();

  sectionTitle('SHOWCASE', 24);
  showcase(drawMilitia, 140, 105, 5.5, t, 'Truther Militia', false);
  showcase(drawTruck, 380, 105, 4, t, 'Truck of Truth', false);
  showcase(drawHeli, 620, 105, 4, t, 'Black Helicopter', true);
  showcase(drawSaucer, 830, 105, 4, t, 'Flying Saucer', true);

  sectionTitle('IN-GAME SCALE (patrolling)', 232);
  patrolRow(t, dt, 300);

  sectionTitle('COMBAT DEMO', 400);
  combatRow(t, dt, 480);

  updateParticles(dt);
  drawParticles();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
