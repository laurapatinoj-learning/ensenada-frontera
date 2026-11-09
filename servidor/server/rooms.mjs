// Room logic for Ensenada Frontera online play. Transport-agnostic: a "client" is {id, send(msg)}.
// The game itself is deterministic ("lockstep"): every client runs the same match from the same seed,
// so the server only relays player decisions and minigame results, and handles disconnects.

export const MASCOTS = ['fox', 'frog', 'bunny', 'penguin'];
const CPU_NAMES = { fox: 'Brasa', frog: 'Ranita', bunny: 'Trébol', penguin: 'Pingo' };
export const MAX_PLAYERS = 4;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18) || 'Jugador';

export class Room {
  constructor(code, hub) {
    this.code = code;
    this.hub = hub;
    this.members = new Map(); // id -> member
    this.started = false;
    this.auto = new Set(); // seats now played by the machine
    this.barriers = new Map();
    this.seatOwner = new Map(); // seat -> member id
    this.hostId = null;
  }

  send(member, msg) {
    if (member.client) member.client.send(msg);
  }
  broadcast(msg) {
    for (const m of this.members.values()) if (m.connected) this.send(m, msg);
  }

  publicMembers() {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, role: m.role, seat: m.seat, mascot: m.mascot, host: m.id === this.hostId, connected: m.connected }));
  }
  sendLobby() {
    for (const m of this.members.values()) if (m.connected) this.send(m, { t: 'lobby', code: this.code, me: m.id, members: this.publicMembers(), started: this.started });
  }

  freeSeat() {
    for (let s = 0; s < MAX_PLAYERS; s++) if (![...this.members.values()].some((m) => m.seat === s)) return s;
    return -1;
  }

  join(client, name, role) {
    if (this.started) return this.err(client, 'La partida ya comenzó. Pide al docente que cree otra sala.', 'started');
    const asPlayer = role !== 'spectator';
    let seat = -1;
    if (asPlayer) {
      seat = this.freeSeat();
      if (seat < 0) return this.err(client, 'La sala está llena (4 jugadores). Entra como espectador o crea otra sala.', 'full');
    }
    const member = { id: client.id, name: cleanName(name), role: asPlayer ? 'player' : 'spectator', seat, mascot: asPlayer ? MASCOTS[seat] : null, connected: true, client };
    // mascots must be unique: pick the first one not taken
    if (asPlayer) member.mascot = MASCOTS.find((m) => ![...this.members.values()].some((o) => o.mascot === m)) ?? MASCOTS[seat];
    this.members.set(member.id, member);
    if (!this.hostId) this.hostId = member.id;
    client.room = this;
    this.sendLobby();
    return member;
  }

  err(client, msg, code) {
    client.send({ t: 'error', msg, code });
    return null;
  }

  pick(client, mascot) {
    const m = this.members.get(client.id);
    if (!m || this.started || m.role !== 'player' || !MASCOTS.includes(mascot)) return;
    if ([...this.members.values()].some((o) => o !== m && o.mascot === mascot)) return; // taken
    m.mascot = mascot;
    this.sendLobby();
  }

  start(client, rounds) {
    if (client.id !== this.hostId) return this.err(client, 'Solo quien creó la sala puede iniciar.', 'notHost');
    if (this.started) return;
    const players = [...this.members.values()].filter((m) => m.role === 'player');
    if (!players.length) return this.err(client, 'Se necesita al menos un jugador.', 'noPlayers');
    this.started = true;
    const r = [10, 15, 20].includes(rounds) ? rounds : 10;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const taken = new Set(players.map((p) => p.mascot));
    const spare = MASCOTS.filter((m) => !taken.has(m));
    const seats = [];
    for (let s = 0; s < MAX_PLAYERS; s++) {
      const p = players.find((x) => x.seat === s);
      if (p) {
        seats.push({ kind: 'human', mascot: p.mascot, name: p.name });
        this.seatOwner.set(s, p.id);
      } else {
        const mascot = spare.shift();
        seats.push({ kind: 'cpu', mascot, name: CPU_NAMES[mascot] });
      }
    }
    const host = this.members.get(this.hostId);
    const teacher = !!host && host.role === 'spectator';
    for (const m of this.members.values()) this.send(m, { t: 'start', seed, rounds: r, seats, mySeat: m.seat, teacher, isTeacher: teacher && m.id === this.hostId });
    this.sendLobby();
  }

  decision(client, seq, value) {
    const m = this.members.get(client.id);
    if (!m || !this.started || m.seat < 0 || !Number.isInteger(seq)) return;
    this.broadcast({ t: 'decision', seq, seat: m.seat, value });
  }

  progress(client, data) {
    const m = this.members.get(client.id);
    if (!m || m.seat < 0) return;
    for (const o of this.members.values()) if (o.connected && o !== m) this.send(o, { t: 'progress', seat: m.seat, data });
  }

  say(client, text) {
    if (client.id !== this.hostId || typeof text !== 'string') return;
    this.broadcast({ t: 'say', text: text.replace(/[\u0000-\u001f<>]/g, '').slice(0, 240) });
  }

  gather(client, key, need, payload, timeoutMs) {
    const m = this.members.get(client.id);
    if (!m || !this.started || typeof key !== 'string' || !Array.isArray(need)) return;
    let b = this.barriers.get(key);
    if (!b) {
      b = { need: new Set(need.filter((n) => Number.isInteger(n))), got: new Map(), done: false, timer: null };
      this.barriers.set(key, b);
      b.timer = setTimeout(() => this.finishBarrier(key, true), Math.min(Number(timeoutMs) || 300000, 600000));
    }
    // seats contribute as their seat number; the teacher (a spectator host) contributes as -1
    const who = m.seat >= 0 ? m.seat : m.id === this.hostId ? -1 : null;
    if (who !== null && b.need.has(who) && !b.got.has(who)) b.got.set(who, payload ?? null);
    this.checkBarrier(key);
  }

  checkBarrier(key) {
    const b = this.barriers.get(key);
    if (!b || b.done) return;
    for (const s of b.need) if (!b.got.has(s) && !this.auto.has(s)) return;
    this.finishBarrier(key, false);
  }

  finishBarrier(key) {
    const b = this.barriers.get(key);
    if (!b || b.done) return;
    b.done = true;
    clearTimeout(b.timer);
    const results = {};
    for (const s of b.need) results[s] = b.got.has(s) ? b.got.get(s) : null; // null = played by the machine
    this.broadcast({ t: 'gather', key, results });
  }

  leave(client) {
    const m = this.members.get(client.id);
    if (!m) return;
    client.room = null;
    if (!this.started) {
      this.members.delete(m.id);
      if (this.hostId === m.id) this.hostId = [...this.members.values()].find((o) => o.connected)?.id ?? null;
      if (!this.members.size) return this.hub.close(this);
      this.sendLobby();
      return;
    }
    m.connected = false;
    m.client = null;
    if (m.seat < 0 && m.id === this.hostId) {
      this.auto.add(-1); // the teacher left: barriers that waited for them are released
      for (const key of [...this.barriers.keys()]) this.checkBarrier(key);
    }
    if (m.seat >= 0) {
      this.auto.add(m.seat);
      this.broadcast({ t: 'seatAuto', seat: m.seat });
      for (const key of [...this.barriers.keys()]) this.checkBarrier(key);
    }
    if (![...this.members.values()].some((o) => o.connected)) this.hub.close(this);
    else this.sendLobby();
  }

  dispose() {
    for (const b of this.barriers.values()) clearTimeout(b.timer);
  }
}

export class Hub {
  constructor() {
    this.rooms = new Map();
  }
  makeCode() {
    for (;;) {
      let c = '';
      for (let i = 0; i < 5; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!this.rooms.has(c)) return c;
    }
  }
  close(room) {
    room.dispose();
    this.rooms.delete(room.code);
  }
  handle(client, msg) {
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'create') {
      if (client.room) client.room.leave(client);
      const room = new Room(this.makeCode(), this);
      this.rooms.set(room.code, room);
      room.join(client, msg.name, msg.role);
      return;
    }
    if (msg.t === 'join') {
      if (client.room) client.room.leave(client);
      const room = this.rooms.get(String(msg.code ?? '').toUpperCase().trim());
      if (!room) return client.send({ t: 'error', msg: 'No existe una sala con ese código.', code: 'noRoom' });
      room.join(client, msg.name, msg.role);
      return;
    }
    const room = client.room;
    if (!room) return;
    switch (msg.t) {
      case 'pick': return room.pick(client, msg.mascot);
      case 'start': return room.start(client, msg.rounds);
      case 'decision': return room.decision(client, msg.seq, msg.value);
      case 'gather': return room.gather(client, msg.key, msg.need, msg.payload, msg.timeoutMs);
      case 'progress': return room.progress(client, msg.data);
      case 'say': return room.say(client, msg.text);
      case 'leave': return room.leave(client);
    }
  }
  disconnect(client) {
    client.room?.leave(client);
  }
}
