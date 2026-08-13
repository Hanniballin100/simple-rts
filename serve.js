// Static file server + multiplayer relay: node serve.js [port]
//
// The relay does NOT simulate anything. It hands out the one match seed, hands
// out seats, and forwards turn packets. Every client runs the whole game; see
// the Determinism section of the README for why that works.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const port = Number(process.argv[2]) || 8377;
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon',
};

// ============================================================
// minimal WebSocket (RFC 6455) — handshake + text frames only.
// Hand-rolled so the project keeps its "no dependencies" promise; this is the
// whole of it, and it only has to survive a handful of players on a LAN.
// ============================================================
// RFC 6455's magic string. Verified against the spec's own vector:
// sha1('dGhlIHNhbXBsZSBub25jZQ==' + WS_GUID) base64 = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsSend(sock, str) {
  if (sock.destroyed) return;
  const payload = Buffer.from(str, 'utf8');
  const n = payload.length;
  let head;
  if (n < 126) {
    head = Buffer.alloc(2);
    head[1] = n;
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(n, 6);
  }
  head[0] = 0x81; // FIN + text
  try { sock.write(Buffer.concat([head, payload])); } catch (e) { /* peer gone */ }
}

function wsClose(sock) {
  try { sock.end(Buffer.from([0x88, 0x00])); } catch (e) { /* already gone */ }
}

// Feeds complete text messages to onMsg. Frames can be split across TCP reads
// and several frames can arrive in one read, so this keeps a running buffer.
function wsAttach(sock, onMsg, onClose) {
  let buf = Buffer.alloc(0);
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      let mask = null;
      if (masked) { if (buf.length < off + 4) return; mask = buf.subarray(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      const body = Buffer.from(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
      if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      if (op === 0x8) { onClose(); wsClose(sock); return; }         // close
      if (op === 0x9) { try { sock.write(Buffer.from([0x8a, 0x00])); } catch (e) {} continue; } // ping -> pong
      if (op === 0x1) { try { onMsg(body.toString('utf8')); } catch (e) { console.error('msg error', e.message); } }
      // binary and continuation frames are not used by this protocol
    }
  });
  sock.on('error', () => onClose());
  sock.on('close', () => onClose());
}

// ============================================================
// lobby + relay
// ============================================================
const MAX_SEATS = 6;
const DROP_MARGIN = 60;          // ticks of grace before a lost player is handed to the AI
const EMPTY_ROOM_GRACE = 180000; // ms a started-but-empty room is held for a returning player

const rooms = new Map(); // code -> room

function makeRoom(code) {
  return {
    code,
    clients: [],       // { sock, id, token, name, faction, ready, owner }
    started: false,
    nextId: 1,
    maxTick: 0,        // highest tick seen in any relayed packet
    setup: { size: 'medium', opponents: 1, setting: 'random', supers: true },
    // ---- what a returning player needs to rebuild the match ----
    // In lockstep the world is a pure function of (seed, seat table, every
    // command in order). So the relay does not have to snapshot anything: it
    // keeps the commands, and a reconnecting client replays them.
    //
    // Only packets that ACTUALLY CARRY commands are kept. The empty ones — the
    // vast majority, one per player per tick — exist so live clients know it is
    // safe to advance, and a client replaying history is not gated on that. A
    // ten-minute match leaves a few hundred entries here, not tens of thousands.
    begun: null,       // the exact 'begin' payload, minus the per-client seat
    log: [],           // { tick, owner, cmds } — command-carrying packets only
    sys: [],           // { kind: 'left'|'rejoin', owner, tick } — seat handovers
    vacated: new Map(),// token -> { owner, name, faction } for seats that dropped
  };
}

const roomOf = code => {
  const c = (code || 'MAIN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'MAIN';
  if (!rooms.has(c)) rooms.set(c, makeRoom(c));
  return rooms.get(c);
};

const send = (cl, obj) => wsSend(cl.sock, JSON.stringify(obj));
const broadcast = (room, obj, except) => {
  const s = JSON.stringify(obj);
  for (const cl of room.clients) if (cl !== except) wsSend(cl.sock, s);
};

function lobbyState(room) {
  return {
    t: 'lobby',
    code: room.code,
    started: room.started,
    hostId: room.clients.length ? room.clients[0].id : null,
    setup: room.setup,
    players: room.clients.map(c => ({ id: c.id, name: c.name, faction: c.faction, ready: c.ready, owner: c.owner })),
  };
}

function handleMessage(room, cl, msg) {
  const isHost = room.clients[0] === cl;

  if (msg.t === 'hello') {
    cl.name = String(msg.name || 'Player').slice(0, 16);
    send(cl, { t: 'welcome', id: cl.id });
    broadcast(room, lobbyState(room));
    return;
  }

  if (msg.t === 'faction') {
    cl.faction = String(msg.faction || '').slice(0, 24);
    cl.ready = false;
    broadcast(room, lobbyState(room));
    return;
  }

  if (msg.t === 'ready') {
    cl.ready = !!msg.ready && !!cl.faction;
    broadcast(room, lobbyState(room));
    return;
  }

  if (msg.t === 'setup' && isHost && !room.started) {
    const s = msg.setup || {};
    room.setup = {
      size: ['small', 'medium', 'large', 'huge'].includes(s.size) ? s.size : 'medium',
      opponents: Math.max(0, Math.min(5, s.opponents | 0)),
      setting: String(s.setting || 'random').slice(0, 16),
      supers: !!s.supers,
    };
    broadcast(room, lobbyState(room));
    return;
  }

  if (msg.t === 'start' && isHost && !room.started) {
    if (room.clients.length < 2) { send(cl, { t: 'error', msg: 'Need at least two players' }); return; }
    if (!room.clients.every(c => c.ready && c.faction)) { send(cl, { t: 'error', msg: 'Everyone must pick a faction and ready up' }); return; }
    // Seats are handed out here, once, by one authority. Humans take the low
    // owner ids in join order; the AI seats follow. The seed is picked here for
    // the same reason: if each client rolled its own, they would generate
    // different maps and nothing after that would agree.
    room.started = true;
    room.maxTick = 0;
    room.log.length = 0;
    room.sys.length = 0;
    room.vacated.clear();
    room.clients.forEach((c, i) => { c.owner = i; });
    const seats = room.clients.map(c => ({ owner: c.owner, faction: c.faction }));
    const seed = crypto.randomBytes(4).readUInt32BE(0);
    const totalSeats = Math.min(MAX_SEATS, room.clients.length + room.setup.opponents);
    room.begun = { seed, seats, humanCount: room.clients.length, totalSeats, setup: room.setup };
    for (const c of room.clients) {
      send(c, Object.assign({ t: 'begin', you: c.owner }, room.begun));
    }
    return;
  }

  if (msg.t === 'turn' && room.started) {
    // The relay's whole job in a running match: pass the packet on, unread.
    // It does not know what a command is and never looks inside one.
    if (typeof msg.tick === 'number' && msg.tick > room.maxTick) room.maxTick = msg.tick;
    const cmds = msg.cmds || [];
    // keep only the packets a replay would need (see room.log)
    if (cmds.length) room.log.push({ tick: msg.tick, owner: cl.owner, cmds });
    broadcast(room, { t: 'turn', tick: msg.tick, owner: cl.owner, cmds, hashTick: msg.hashTick, hash: msg.hash }, cl);
    return;
  }

  // A returning client has finished replaying and is level with the live edge.
  // Name a tick at which its seat comes back off the AI — far enough ahead that
  // everyone, including the returner, hears about it before they get there.
  if (msg.t === 'live' && room.started && cl.owner !== undefined && cl.rejoining) {
    cl.rejoining = false;
    const ev = { kind: 'rejoin', owner: cl.owner, tick: room.maxTick + DROP_MARGIN };
    room.sys.push(ev);
    broadcast(room, { t: 'rejoin', owner: ev.owner, tick: ev.tick, name: cl.name });
    return;
  }

  if (msg.t === 'desync' && room.started) {
    broadcast(room, { t: 'desync', owner: cl.owner, tick: msg.tick, mine: msg.mine, theirs: msg.theirs }, cl);
    return;
  }
}

function dropClient(room, cl) {
  const i = room.clients.indexOf(cl);
  if (i < 0) return;
  room.clients.splice(i, 1);
  if (room.started && cl.owner !== undefined) {
    // Everyone must hand this seat to the AI on the SAME tick, or the clients
    // that gave up early diverge from the ones that waited. The relay names the
    // tick — it is the one party that sees every packet — and the clients turn
    // it into an ordinary command so it lands inside the simulation.
    const ev = { kind: 'left', owner: cl.owner, tick: room.maxTick + DROP_MARGIN };
    room.sys.push(ev);
    // hold the seat open under the client's token so it can come back to it
    room.vacated.set(cl.token, { owner: cl.owner, name: cl.name, faction: cl.faction });
    broadcast(room, { t: 'left', owner: ev.owner, tick: ev.tick, name: cl.name });
  } else {
    broadcast(room, lobbyState(room));
  }
  // A started room is kept alive briefly even when empty, so the last player to
  // drop out of a two-player match can still come back to it.
  if (!room.clients.length) {
    if (!room.started) { rooms.delete(room.code); return; }
    clearTimeout(room.reaper);
    room.reaper = setTimeout(() => { if (!room.clients.length) rooms.delete(room.code); }, EMPTY_ROOM_GRACE);
  }
}

// ============================================================
// http
// ============================================================
const server = http.createServer((req, res) => {
  // dev aid: POST a canvas data-URL to /shot and it lands in .shots/ as a jpg
  if (req.method === 'POST' && req.url.startsWith('/shot')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const name = (req.url.split('?name=')[1] || 'shot').replace(/[^\w-]/g, '');
      const b64 = body.split(',')[1] || '';
      fs.mkdirSync(path.join(root, '.shots'), { recursive: true });
      fs.writeFileSync(path.join(root, '.shots', name + '.jpg'), Buffer.from(b64, 'base64'));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = path.normalize(path.join(root, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    // no-store: browsers were heuristically caching game.js and serving
    // week-old builds after balance patches
    res.writeHead(200, {
      'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { sock.destroy(); return; }
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
  sock.setNoDelay(true); // Nagle would add tens of ms to every turn packet

  const q = new URLSearchParams((req.url.split('?')[1] || ''));
  const room = roomOf(q.get('room'));
  const token = q.get('token') || '';
  // Is this someone coming back to a seat they already hold? Only a token the
  // relay itself issued, against a seat that is currently empty, counts.
  const seat = room.started && token ? room.vacated.get(token) : null;

  if (!seat && (room.started || room.clients.length >= MAX_SEATS)) {
    wsSend(sock, JSON.stringify({ t: 'error', msg: room.started ? 'That match has already started' : 'Room is full' }));
    wsClose(sock);
    return;
  }

  const cl = {
    sock, id: room.nextId++, token: token || crypto.randomBytes(8).toString('hex'),
    name: 'Player', faction: null, ready: false, owner: undefined, rejoining: false,
  };
  if (seat) {
    room.vacated.delete(token);
    cl.owner = seat.owner; cl.name = seat.name; cl.faction = seat.faction;
    cl.ready = true; cl.rejoining = true;
    clearTimeout(room.reaper);
  }
  room.clients.push(cl);

  let gone = false;
  wsAttach(sock,
    text => { let m; try { m = JSON.parse(text); } catch (e) { return; } handleMessage(room, cl, m); },
    () => { if (gone) return; gone = true; dropClient(room, cl); });

  send(cl, { t: 'welcome', id: cl.id, token: cl.token });
  if (seat) {
    // Everything needed to rebuild the match from nothing: the same opening the
    // others got, every command since, and the seat handovers in between.
    send(cl, Object.assign({ t: 'resume', you: cl.owner, atTick: room.maxTick,
      log: room.log, sys: room.sys }, room.begun));
    broadcast(room, { t: 'returning', owner: cl.owner, name: cl.name }, cl);
  } else {
    broadcast(room, lobbyState(room));
  }
});

server.listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}`);
  for (const [name, addrs] of Object.entries(require('os').networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  others on this network: http://${a.address}:${port}`);
    }
  }
});
