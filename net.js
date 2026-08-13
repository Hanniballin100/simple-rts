// ============================================================
// net.js — lockstep multiplayer client.
//
// Nothing about the simulation changes when this is switched on. Clients do
// not exchange state; they exchange the same command objects the local input
// layer already produces, and every client runs the whole game. What this file
// adds is:
//
//   1. the lobby handshake — one seed, one seat table, agreed before tick 1
//   2. the turn loop — one packet per client per tick, ALWAYS, even an empty
//      one, and a hard rule that no client may run tick T until it holds every
//      player's packet for tick T
//   3. the safety nets — a state fingerprint exchanged every second so a drift
//      is caught at the tick it happens, and an agreed tick at which a lost
//      player's army is handed to the AI
//
// Loaded after game.js. When Net.inMatch is false, every hook here is inert
// and the game behaves exactly as it did single player.
// ============================================================

// How many ticks ahead commands are stamped. This is the whole latency budget:
// a packet has NET_DELAY * 33ms to make the round trip before it stalls the
// match. 4 ticks = 133ms, comfortable on a LAN and survivable across a country.
// Raising it costs input responsiveness and buys tolerance.
const NET_DELAY = 4;
// How often each client publishes a fingerprint of its whole simulation.
// Lower it to 1 when hunting a drift: the alarm then names the exact tick
// rather than the second it happened in. Hashing is not free, hence 30.
let HASH_EVERY = 30; // ticks — once a second

const Net = {
  ws: null,
  connected: false,
  inMatch: false,
  you: null,            // our owner id, once seats are handed out
  id: null,             // lobby connection id
  hostId: null,
  players: [],
  setup: null,
  code: 'MAIN',

  humans: [],           // owner ids we must hear from every tick
  outbox: [],           // commands authored since the last packet went out
  sendTick: 1,          // the tick number the next packet will be stamped with
  turns: new Map(),     // tick -> { owner -> true }  (arrival bookkeeping)
  myHashes: new Map(),  // tick -> our fingerprint
  claims: new Map(),    // tick -> { owner -> their fingerprint }
  pendingDrops: [],     // { owner, tick } — seats becoming AI at a known tick
  desynced: null,
  stalledSince: 0,
  lastStallOwner: null,

  // ---- connection -------------------------------------------------------
  connect(name, code) {
    if (this.ws) try { this.ws.close(); } catch (e) {}
    this.code = (code || 'MAIN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'MAIN';
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = this.ws = new WebSocket(proto + location.host + '/?room=' + this.code);
    ws.onopen = () => {
      this.connected = true;
      this.send({ t: 'hello', name: name || 'Player' });
      netUI.status('Connected to room ' + this.code);
      netUI.render();
    };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } this.onMessage(m); };
    ws.onclose = () => {
      this.connected = false;
      netUI.status(this.inMatch ? 'Connection lost — the match cannot continue' : 'Disconnected');
      netUI.render();
    };
    ws.onerror = () => netUI.status('Could not reach the server');
  },

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  },

  pickFaction(faction) { this.send({ t: 'faction', faction }); },
  setReady(r) { this.send({ t: 'ready', ready: r }); },
  pushSetup() {
    this.send({ t: 'setup', setup: { size: selectedSize, opponents: selectedOpponents, setting: selectedSetting, supers: superweaponsOn } });
  },
  startMatch() { this.send({ t: 'start' }); },

  // ---- inbound ----------------------------------------------------------
  onMessage(m) {
    if (m.t === 'welcome') { this.id = m.id; return; }
    if (m.t === 'error') { netUI.status(m.msg); return; }

    if (m.t === 'lobby') {
      this.hostId = m.hostId;
      this.players = m.players;
      this.setup = m.setup;
      netUI.render();
      return;
    }

    if (m.t === 'begin') { this.begin(m); return; }

    if (m.t === 'turn') { this.onTurn(m); return; }

    if (m.t === 'left') { this.onLeft(m); return; }

    if (m.t === 'desync' && !this.desynced) {
      this.flagDesync(m.tick, m.theirs, m.mine, m.owner);
      return;
    }
  },

  // ---- match start ------------------------------------------------------
  begin(m) {
    this.you = m.you;
    this.humans = m.seats.map(s => s.owner);
    this.turns.clear();
    this.myHashes.clear();
    this.claims.clear();
    this.pendingDrops.length = 0;
    this.outbox.length = 0;
    this.desynced = null;
    this.sendTick = 1;

    selectedSize = m.setup.size;
    superweaponsOn = m.setup.supers;
    if (typeof selectedSetting !== 'undefined') selectedSetting = m.setup.setting;
    // opponents is the AI count; startGame sizes OWNERS from human seats + AIs
    selectedOpponents = Math.max(0, m.totalSeats - m.humanCount);

    this.inMatch = true;
    startGame(m.seats[0].faction, m.seed, { humans: m.seats, as: m.you, extraSeats: m.totalSeats });

    netUI.hideLobby();
    netUI.status('');
    // Prime the pipe: every client owes a packet for each of the first
    // NET_DELAY ticks before anyone is allowed to run tick 1.
    for (let i = 0; i < NET_DELAY; i++) this.emit();
  },

  // ---- the turn loop ----------------------------------------------------

  // Publish one packet, always — an empty list is a message too. A client that
  // goes quiet when it has nothing to say is indistinguishable from a client
  // whose packet was lost, and everyone else waits forever.
  emit() {
    const tick = this.sendTick++;
    const cmds = this.outbox.splice(0, this.outbox.length);
    for (const c of cmds) { c.tick = tick; queueCommand(c); }
    this.recordTurn(tick, this.you);
    // the fingerprint of the most recent tick we have finished
    const hashTick = state.tick - (state.tick % HASH_EVERY);
    const hash = this.myHashes.get(hashTick);
    this.send({
      t: 'turn', tick,
      cmds: cmds.map(c => ({ seq: c.seq, type: c.type, payload: c.payload })),
      hashTick: hash === undefined ? undefined : hashTick,
      hash,
    });
  },

  onTurn(m) {
    for (const c of m.cmds) {
      queueCommand({ tick: m.tick, owner: m.owner, seq: c.seq, type: c.type, payload: c.payload });
    }
    this.recordTurn(m.tick, m.owner);
    if (m.hash !== undefined && m.hashTick !== undefined) this.noteClaim(m.hashTick, m.owner, m.hash);
  },

  recordTurn(tick, owner) {
    let set = this.turns.get(tick);
    if (!set) this.turns.set(tick, set = new Set());
    set.add(owner);
  },

  // The gate. Every seat still under human control owes a packet for this tick.
  canStep(tick) {
    const set = this.turns.get(tick);
    if (!set) return this.humans.length === 0;
    for (const o of this.humans) if (!set.has(o)) { this.lastStallOwner = o; return false; }
    return true;
  },

  // called right after stepSim() completes a tick
  afterTick() {
    if (state.tick % HASH_EVERY === 0) {
      this.myHashes.set(state.tick, hashState());
      this.checkClaims(state.tick);
      // keep the history short — a claim older than a few seconds is moot
      for (const k of this.myHashes.keys()) if (k < state.tick - HASH_EVERY * 8) this.myHashes.delete(k);
    }
    this.turns.delete(state.tick - 1);
    // a seat whose grace period has expired is now the AI's problem
    for (let i = this.pendingDrops.length - 1; i >= 0; i--) {
      if (state.tick >= this.pendingDrops[i].tick) {
        const o = this.pendingDrops[i].owner;
        this.humans = this.humans.filter(x => x !== o);
        this.pendingDrops.splice(i, 1);
      }
    }
    this.emit();
  },

  noteStall() {
    if (!this.stalledSince) this.stalledSince = performance.now();
    const secs = (performance.now() - this.stalledSince) / 1000;
    if (secs > 0.4) {
      const p = this.players.find(x => x.owner === this.lastStallOwner);
      netUI.status('Waiting for ' + (p ? p.name : 'player ' + this.lastStallOwner) + '…');
    }
  },
  clearStall() {
    if (!this.stalledSince) return;
    this.stalledSince = 0;
    if (!this.desynced) netUI.status('');
  },

  // ---- safety net 1: drift detection ------------------------------------
  noteClaim(tick, owner, hash) {
    let m = this.claims.get(tick);
    if (!m) this.claims.set(tick, m = new Map());
    m.set(owner, hash);
    this.checkClaims(tick);
    for (const k of this.claims.keys()) if (k < state.tick - HASH_EVERY * 8) this.claims.delete(k);
  },

  checkClaims(tick) {
    if (this.desynced) return;
    const mine = this.myHashes.get(tick);
    const m = this.claims.get(tick);
    if (mine === undefined || !m) return;
    for (const [owner, theirs] of m) {
      if (theirs !== mine) {
        this.flagDesync(tick, mine, theirs, owner);
        this.send({ t: 'desync', tick, mine, theirs });
        return;
      }
    }
  },

  // A drift cannot be repaired from here — the two simulations have already
  // diverged and neither is authoritative. Say so loudly, name the tick, and
  // stop, rather than let two people play different games in silence.
  flagDesync(tick, mine, theirs, owner) {
    this.desynced = { tick, mine, theirs, owner };
    netUI.status('DESYNC at tick ' + tick + ' vs player ' + owner +
      ' (' + (mine >>> 0) + ' vs ' + (theirs >>> 0) + ') — the match has stopped');
    console.error('[desync] tick', tick, 'mine', mine >>> 0, 'theirs', theirs >>> 0, 'owner', owner);
    state.over = true;
  },

  // ---- safety net 2: a player disappears --------------------------------
  // The relay names the tick. Every client fills the missing packets up to it
  // with empties and applies the handover ON that tick, so nobody advances on
  // a different schedule while dealing with the loss.
  onLeft(m) {
    if (!this.inMatch) { netUI.render(); return; }
    if (!this.humans.includes(m.owner)) return;
    for (let t = Math.max(1, state.tick + 1); t <= m.tick; t++) this.recordTurn(t, m.owner);
    queueCommand({ tick: m.tick, owner: m.owner, seq: 0, type: 'resign', payload: { owner: m.owner } });
    this.pendingDrops.push({ owner: m.owner, tick: m.tick });
    netUI.status((m.name || 'Player ' + m.owner) + ' left — their forces go to the AI shortly');
    setTimeout(() => { if (!this.desynced && !this.stalledSince) netUI.status(''); }, 6000);
  },
};

// ============================================================
// lobby UI
// ============================================================
const netUI = {
  el: {},
  init() {
    const g = id => document.getElementById(id);
    this.el = {
      panel: g('mp-panel'), name: g('mp-name'), room: g('mp-room'), connect: g('mp-connect'),
      list: g('mp-list'), ready: g('mp-ready'), start: g('mp-start'), status: g('net-status'),
      toggle: g('mp-toggle'), body: g('mp-body'),
    };
    this.el.toggle.addEventListener('click', () => {
      const on = this.el.body.classList.toggle('on');
      this.el.toggle.textContent = on ? 'Multiplayer ▲' : 'Multiplayer ▼';
    });
    this.el.connect.addEventListener('click', () => Net.connect(this.el.name.value, this.el.room.value));
    this.el.ready.addEventListener('click', () => {
      const me = Net.players.find(p => p.id === Net.id);
      Net.setReady(!(me && me.ready));
    });
    this.el.start.addEventListener('click', () => { Net.pushSetup(); setTimeout(() => Net.startMatch(), 60); });
    this.render();
  },
  status(msg) {
    if (!this.el.status) return;
    this.el.status.textContent = msg || '';
    this.el.status.classList.toggle('on', !!msg);
  },
  hideLobby() { document.getElementById('faction-select').classList.add('hidden'); },
  render() {
    if (!this.el.list) return;
    const me = Net.players.find(p => p.id === Net.id);
    this.el.connect.textContent = Net.connected ? 'Reconnect' : 'Connect';
    this.el.list.innerHTML = '';
    for (const p of Net.players) {
      const row = document.createElement('div');
      row.className = 'mp-row' + (p.ready ? ' ready' : '');
      const fac = p.faction && typeof FACTIONS !== 'undefined' && FACTIONS[p.faction];
      row.textContent = (p.id === Net.hostId ? '★ ' : '   ') + p.name +
        ' — ' + (fac ? fac.emoji + ' ' + fac.name : 'choosing…') + (p.ready ? '  ✔' : '');
      this.el.list.appendChild(row);
    }
    this.el.ready.style.display = Net.connected ? '' : 'none';
    this.el.ready.textContent = me && me.ready ? 'Not ready' : 'Ready';
    this.el.start.style.display = (Net.connected && Net.id === Net.hostId) ? '' : 'none';
    this.el.start.disabled = !(Net.players.length >= 2 && Net.players.every(p => p.ready));
    // the OPPONENTS row gains a "0" (players only, no AI) once someone else
    // is in the room, and loses it again if they leave
    if (window.refreshSetupControls) window.refreshSetupControls();
  },
};

if (document.getElementById('mp-panel')) netUI.init();
