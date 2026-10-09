/**
 * The multiplayer server, end to end: boots server/ in-process on a free
 * port with a throwaway data directory, logs players in over real
 * WebSockets, and asserts what they see of each other -- arrivals, says,
 * tells, channels, socials, following and groups, Merc 2.1's player-killing
 * rules (refused in a safe room and by is_safe, allowed where 2.1 allows,
 * with the KILLER and THIEF flags), the implementor's commands and dashboard,
 * quitting and a dropped link.
 *
 *     (cd server && npm ci) && node tools/server-check.mjs
 *
 * Exits non-zero if any assertion fails.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'server/package.json'));
let WebSocket;
try { WebSocket = require('ws'); } catch (error) {
  throw new Error(`tools/server-check.mjs needs the server's dependencies: (cd server && npm ci) -- ${error.message}`);
}
const { startMud } = await import('../server/mud.mjs');
const { createAccounts, hashPassword } = await import('../server/accounts.mjs');
const { serialize } = await import('../src/save.js');
const { createCharacter, advanceLevel, Rng } = await import('../src/game.js');
const { PLR } = await import('../src/rules/handler.js');

const failures = [];
const check = (ok, label, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail !== undefined ? `  (${detail})` : ''}`);
  if (!ok) failures.push(label);
};

const data = mkdtempSync(join(tmpdir(), 'diku3d-server-check-'));
const quiet = [];
const mud = await startMud({ root, dataDir: data, port: 0, seed: 4011, log: (text) => quiet.push(text) });
const { game, world: w } = mud;
const url = `ws://127.0.0.1:${mud.port}/ws`;

/** A room's middle in its own zone's frame, eye high: where a client stands. */
function spot(vnum, dx = 0, dz = 0) {
  const info = w.built.rooms.get(vnum);
  const z = w.zoneOfVnum(vnum);
  // On build.js's floor, as a page stands: the temple's mound is 1.2 m up.
  return { zone: z.zone.id, x: info.center.x - z.offset + dx, y: info.center.y + (w.lifts.get(vnum) || 0) + 1.72, z: info.center.z + dz };
}

/** One player's connection: what arrived, and a way to wait for something. */
function client(label) {
  const ws = new WebSocket(url);
  const c = {
    label, ws, events: [], messages: [], id: null, seq: 0, self: null, roster: new Map(), positions: new Map(),
    text: () => c.events.map((e) => e.text).filter(Boolean),
    send: (msg) => ws.send(JSON.stringify(msg)),
    say: (line) => c.send({ t: 'cmd', line }),
    /**
     * Stand at a room's middle plus (dx, dz). The server believes a walk, not a
     * jump: into another room the harness moves the player as goto would, and
     * the report follows under the sequence number that sent.
     */
    async at(vnum, dx = 0, dz = 0) {
      const seq = c.seq;
      if (mud.place(c.id, vnum)) await c.waitFor((x) => x.seq > seq, 3000, `the jump to #${vnum}`);
      c.send({ t: 'pos', ...spot(vnum, dx, dz), yaw: 0, seq: c.seq });
    },
    waitFor(pred, ms = 3000, what = 'something') {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const poll = () => {
          const hit = pred(c);
          if (hit) return resolve(hit);
          if (Date.now() - start > ms) return reject(new Error(`${label}: waited ${ms} ms for ${what}`));
          return setTimeout(poll, 15);
        };
        poll();
      });
    },
    /** The first line matching `re` after mark `from`. */
    line(re, from = 0) { return c.events.slice(from).find((e) => e.text && re.test(e.text)); },
    mark: () => c.events.length,
  };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    c.messages.push(msg);
    if (msg.t === 'ev') c.events.push(...msg.e);
    else if (msg.t === 'enter') { c.id = msg.id; c.seq = msg.seq; c.room = msg.room; }
    else if (msg.t === 'at') c.seq = Math.max(c.seq, msg.seq);
    else if (msg.t === 'self') c.self = { ...c.self, ...msg.c, ...(msg.k || {}) };
    else if (msg.t === 'who') { for (const [id, ...info] of msg.add) c.roster.set(id, info); for (const id of msg.del) c.roster.delete(id); }
    else if (msg.t === 'pos') for (const [id, x, y, z] of msg.p) c.positions.set(id, { x, y, z });
    if (msg.t === 'ev') for (const e of msg.e) if (e.seq) c.seq = Math.max(c.seq, e.seq);
  });
  c.opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return c;
}
const expect = async (c, re, label, from = 0, ms = 3000) => {
  try {
    const e = await c.waitFor((x) => x.line(re, from), ms, String(re));
    check(true, label, e.text);
    return e;
  } catch (error) {
    check(false, label, `${error.message}; last: ${JSON.stringify(c.text().slice(-4))}`);
    return null;
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------- the nanny --
console.log('\nLOGGING IN');
const a = client('Arwen');
await a.opened;
await a.waitFor((x) => x.messages.find((m) => m.t === 'hello'), 3000, 'hello');
const hello = a.messages.find((m) => m.t === 'hello');
check(hello.v === 2 && hello.world.mobs === game.mobs.length, 'hello names the protocol and the world', `${hello.world.rooms} rooms, ${hello.world.mobs} mobiles, ${hello.world.hash}`);
check(hello.online === 0, '...and how many players are online: nobody yet', hello.online);
a.send({ t: 'login', name: 'Arwen', password: 'elbereth' });
const asked = await a.waitFor((x) => x.messages.find((m) => m.t === 'login'), 3000, 'login reply');
check(asked.new === true && /Did I get that right, Arwen/.test(asked.why), 'an unknown name is a new character, asked to confirm', asked.why);
a.send({ t: 'login', name: 'all', password: 'whatever' });
await a.waitFor((x) => x.messages.filter((m) => m.t === 'login').length >= 2);
check(/Illegal name/.test(a.messages.filter((m) => m.t === 'login')[1].why), "a reserved word is no name (check_parse_name)");
a.send({ t: 'login', name: 'Cityguard', password: 'whatever' });
await a.waitFor((x) => x.messages.filter((m) => m.t === 'login').length >= 3);
check(/Illegal name/.test(a.messages.filter((m) => m.t === 'login')[2].why), "nor is a mobile's name");
a.send({ t: 'create', name: 'Arwen', password: 'elbereth', cls: 3, sex: 'f' });
await a.waitFor((x) => x.id !== null, 5000, 'enter');
check(a.room === 3001, 'a new character enters at the temple', a.room);
await a.waitFor((x) => x.self, 3000, 'self');
check(a.self.name === 'Arwen' && a.self.className === 'warrior' && a.self.sex === 2, 'the character comes back whole', `${a.self.title}`);
await a.at(3001, 1.5, 0);

const b = client('Boromir');
await b.opened;
b.send({ t: 'create', name: 'Boromir', password: 'gondor1', cls: 3, sex: 'm' });
await b.waitFor((x) => x.id !== null, 5000, 'enter');
await b.at(3001, -1.5, 0);
await expect(a, /^Boromir has entered the game\.$/, "the room is told: '$n has entered the game.'");

const c3 = client('Intruder');
await c3.opened;
c3.send({ t: 'login', name: 'Arwen', password: 'wrongpass' });
await c3.waitFor((x) => x.messages.find((m) => m.t === 'login'));
check(c3.messages.find((m) => m.t === 'login').why === 'Wrong password.', 'a wrong password is refused');
c3.ws.close();

// The title screen's count: a socket that only reads hello (src/link-ui.js countPlayers).
const probe = client('title screen');
await probe.opened;
await probe.waitFor((x) => x.messages.find((m) => m.t === 'hello'), 3000, 'hello');
const counted = probe.messages.find((m) => m.t === 'hello').online;
check(counted === 2, "a page that has not logged in is told who's online: Arwen and Boromir", counted);
probe.ws.close();

// ------------------------------------------------------- seeing each other --
console.log('\nSEEING EACH OTHER');
await a.waitFor((x) => x.roster.has(b.id) && x.positions.has(b.id), 3000, "Boromir's figure").catch(() => null);
check(a.roster.has(b.id) && a.roster.get(b.id)[0] === 'Boromir', 'Arwen has Boromir on her roster', JSON.stringify(a.roster.get(b.id)));
const pb = a.positions.get(b.id);
const sb = spot(3001, -1.5, 0);
check(pb && Math.abs(pb.x - sb.x) < 0.01 && Math.abs(pb.z - sb.z) < 0.01, "...and where he stands, in her zone's frame", pb && `${pb.x}, ${pb.z}`);
const posMsgs = () => a.messages.filter((m) => m.t === 'pos').length;
const before = posMsgs();
await pause(1000);
check(posMsgs() - before >= 8, 'positions arrive at about 10 Hz', `${posMsgs() - before} in a second`);

let m = a.mark();
a.say('look');
await expect(a, /^Boromir the .* is here\.$/, "look shows Boromir with his title, as show_char_to_char_0 does", m);
m = a.mark();
a.say('look boromir');
await expect(a, /Boromir is using:|Boromir is in perfect health/, 'look at a player shows their health and gear', m);
await expect(b, /^Arwen looks at you\.$/, "...and Boromir sees her look", 0);

// --------------------------------------------------------------- talking --
console.log('\nTALKING');
m = b.mark();
a.say('say well met');
await expect(b, /^Arwen says 'well met'\.$/, "say reaches the room: \"$n says '$T'.\"", m);
await expect(a, /^You say 'well met'\.$/, '...and the speaker reads her own line', 0);
m = b.mark();
a.say('emote waves.');
await expect(b, /^Arwen waves\.$/, 'emote', m);
m = b.mark();
a.say('smile boromir');
await expect(b, /^Arwen smiles at you\.$/, 'a social at a player reaches them (vict_found)', m);
m = b.mark();
a.say('tell boromir to the square');
await expect(b, /^Arwen tells you 'to the square'\.$/, 'tell', m);
m = a.mark();
b.say('reply aye');
await expect(a, /^Boromir tells you 'aye'\.$/, 'reply goes to whoever told you last', m);
m = b.mark();
a.say('chat anyone for the sewers?');
await expect(b, /^Arwen chats 'anyone for the sewers\?'\.$/, 'chat reaches everyone', m);
b.say('channels -chat');
await expect(b, /^Ok\.$/, 'channels -chat turns it off', m);
m = b.mark();
a.say('chat still there?');
await pause(400);
check(!b.line(/still there/, m), "...and Boromir no longer hears chat");
b.say('channels');
await expect(b, /^Channels: \+AUCTION -chat \+MUSIC \+QUESTION \+SHOUT \+YELL\.$/, "channels lists them the mud's way", m);
m = b.mark();
a.say('shout HELLO');
await pause(300);
check(!b.line(/shouts 'HELLO'/, m) && a.line(/Huh\?/), 'shout needs third level, as in interp.c');
m = a.mark();
a.say('who');
await expect(a, /^2 players\.$/, 'who counts the players', m);
await expect(a, /^\[ 1 War\] Boromir the Swordpupil$/, "...and lists each the mud's way, title and all", m);
m = a.mark();
a.say('where');
await expect(a, /^Boromir +The Temple Of Midgaard$/, 'where lists the players in the area', m);

// ---------------------------------------------------- following and groups --
console.log('\nFOLLOWING');
m = a.mark();
b.say('follow arwen');
await expect(a, /^Boromir now follows you\.$/, 'follow: the leader is told', m);
a.say('group boromir');
await expect(b, /^You join Arwen's group\.$/, 'group takes a follower in', 0);
m = a.mark();
a.say('group');
await expect(a, /^\[ 1 War\] Boromir +\d+\/ +\d+ hp/, "group lists the members with their hit points", m);
m = b.mark();
a.say('gtell stay close');
await expect(b, /^Arwen tells the group 'stay close'\.$/, 'gtell', m);
game.withPlayer(game.players.find((p) => p.ch.name === 'Arwen'), () => { game.state.gold = 101; });
m = b.mark();
a.say('split 101');
await expect(b, /^Arwen splits 101 gold coins\.  Your share is 50 gold coins\.$/, 'split shares the gold, the extra to the splitter', m);
await expect(a, /Your share is 51 gold coins/, '...who keeps the odd coin', 0);
// Walk: the temple, then south out of it.
m = b.mark();
const south = w.world.rooms.get(3001).exits.findIndex((e) => e && e.to === 3005);
await a.at(3005);
await expect(b, /^Arwen leaves south\.$/, "the room is told which way she went: '$n leaves $T.'", m);
const follow = await b.waitFor((x) => x.events.slice(m).find((e) => e.kind === 'follow'), 3000, 'follow event').catch(() => null);
check(follow && follow.dir === south && follow.to === 3005, 'and her follower is sent after her, through the same exit', follow && JSON.stringify({ dir: follow.dir, to: follow.to, text: follow.text }));
m = a.mark();
await b.at(3005, 1, 1);
await expect(a, /^Boromir has arrived\.$/, "...and his arrival is announced: '$n has arrived.'", m);

// ------------------------------------------------------- player killing --
console.log('\nPLAYER KILLING');
const pa = game.players.find((p) => p.ch.name === 'Arwen');
const pbp = game.players.find((p) => p.ch.name === 'Boromir');
// A street with no mobile reset in it or next to it: the Watch would answer
// a KILLER at once (spec_guard), which is the mud working, not this check.
const QUIET = 3122;
const third = client('Gimli');
await third.opened;
third.send({ t: 'create', name: 'Gimli', password: 'axeaxe', cls: 3 });
await third.waitFor((x) => x.id !== null, 5000, 'enter');
await a.at(3001, 1.5, 0); await b.at(3001, -1.0, 0); await third.at(3001, 0, 2);
await pause(250);
m = a.mark();
a.say('kill boromir');
await expect(a, /^You must MURDER a player\.$/, 'kill refuses an innocent player', m);
m = a.mark();
a.say('murder boromir');
await expect(a, /Huh\?/, 'murder is a fifth-level command', m);
// Make the duel possible the mud's way: old enough, and the higher level to attack.
pa.ch.level = 5; pbp.ch.level = 8;
m = a.mark();
a.say('murder boromir');
await expect(a, /^Not in a place of sanctuary\.$/, 'refused in the temple (ROOM_SAFE)', m);
await a.at(QUIET, 1, 0); await b.at(QUIET, -1, 0); await third.at(QUIET, 0, 2.5);
await pause(300);
m = a.mark();
a.say('murder boromir');
await expect(a, /^You aren't old enough\.$/, 'refused by is_safe: under 21 (8 hours played)', m);
pa.ch.played = 8 * 3600;
pa.ch.level = 9;
m = a.mark();
a.say('murder boromir');
await expect(a, /^You may not attack a lower level player\.$/, 'refused by is_safe: Merc 2.1 lets you attack only a higher level', m);
pa.ch.level = 5;
m = a.mark();
let mb = b.mark();
const mg = third.mark();
a.say('murder boromir');
await expect(a, /\*\*\* You are now a KILLER!! \*\*\*/, 'allowed where 2.1 allows it -- and you are now a KILLER', m);
await expect(b, /^You shout 'Help!  I am being attacked by Arwen!'\.$/, "the victim shouts for help (do_murder's do_shout)", mb);
await expect(third, /^Boromir shouts 'Help!  I am being attacked by Arwen!'\.$/, '...and the whole world hears it', mg);
const BLOW = 'miss|scratch|graze|hit|injure|wound|maul|devastate|maim|MUTILATE|DISEMBOWEL|EVISCERATE|MASSACRE';
await expect(b, new RegExp(`^Arwen (${BLOW})e?s you[.!]$`), "the victim reads the blows as TO_VICT: 'Arwen hits you.'", mb);
await expect(a, new RegExp(`^You (${BLOW}) Boromir[.!]$`), "the attacker reads them as TO_CHAR: 'You hit Boromir.'", m);
await expect(third, new RegExp(`^(Arwen|Boromir) (${BLOW})e?s (Boromir|Arwen)[.!]$`), 'a bystander in the room sees the fight as TO_ROOM', mg, 6000);
check(!!(pa.ch.act & PLR.KILLER), 'the KILLER flag is on Arwen');
await b.waitFor((x) => x.self && x.self.fighting && x.self.fighting.p === a.id, 3000, 'fighting').catch(() => null);
check(b.self.fighting && b.self.fighting.p === a.id, "Boromir's own view says he is fighting Arwen", JSON.stringify(b.self.fighting));
// Part them, and lift the flag, before a guard wanders by and settles it.
for (const p of game.players) if (p.ch.fighting) game.MERC.updatePos(p.ch);
for (const p of game.players) { p.ch.fighting = null; if (p.ch.position === 6) p.ch.position = 7; p.ch.hit = p.ch.maxHit; }
pa.ch.act &= ~PLR.KILLER;
m = a.mark();
mb = b.mark();
a.say('steal coins boromir');
await expect(a, /\*\*\* You are now a THIEF!! \*\*\*/, 'stealing from a player always fails in 2.1, and makes you a THIEF', m);
await expect(b, /^Arwen tried to steal from you\.$/, '...and the victim is told', mb);
await expect(third, /^Boromir shouts 'Arwen is a bloody thief!'\.$/, '...who shouts it to the world', mg);
check(!!(pa.ch.act & PLR.THIEF), 'the THIEF flag is on Arwen');

// ---------------------------------------------------------- the implementor --
console.log('\nTHE IMPLEMENTOR');
{
  const accounts = createAccounts(data);
  const rng = new Rng(7);
  const ch = createCharacter(1, { level: 36, sex: 1, rng });
  while (ch.level < 40) { ch.level += 1; advanceLevel(ch, rng); }
  ch.name = 'Yeb'; ch.displayName = 'Yeb';
  accounts.store({ version: 1, name: 'Yeb', created: 'now', password: await hashPassword('implementor'), char: { ...serialize(ch), room: 3001, trust: 40, played: 0 } });
}
const y = client('Yeb');
await y.opened;
y.send({ t: 'login', name: 'yeb', password: 'implementor' });
await y.waitFor((x) => x.id !== null, 5000, 'enter');
await y.at(3001);
m = y.mark();
y.say('wizhelp');
await expect(y, /advance +trust +allow/, 'wizhelp lists the immortal commands by level', m);
m = y.mark();
const ma0 = a.mark();
y.say(`goto ${QUIET}`);
await expect(y, new RegExp(`^${w.world.rooms.get(QUIET).name}$`), 'goto puts him in the room and looks', m);
const tp = y.events.slice(m).find((e) => e.kind === 'teleport');
check(tp && tp.vnum === QUIET && tp.seq > 0, "...and tells his client where (a 'teleport' with a sequence number)", tp && JSON.stringify({ vnum: tp.vnum, seq: tp.seq }));
await expect(a, /^Yeb appears in a swirling mist\.$/, "the room sees him arrive (bamfin's default)", ma0);
await y.at(QUIET, 0, -2);
m = b.mark();
y.say('transfer boromir 3001');
await expect(b, /^Yeb has transferred you\.$/, 'transfer moves another player', m);
check(pbp.ch.roomVnum === 3001, '...to the temple', pbp.ch.roomVnum);
pbp.ch.hit = 3;
m = b.mark();
y.say('restore boromir');
await expect(b, /^Yeb has restored you\.$/, 'restore', m);
check(pbp.ch.hit === pbp.ch.maxHit, '...to full hit points', `${pbp.ch.hit}/${pbp.ch.maxHit}`);
m = y.mark();
y.say('mstat arwen');
await expect(y, /^Lv: 5\.  Class: 3\./, 'mstat reads a player', m);
await expect(y, /^Age: 21\.  Played: 28\d\d\d\./, "...age and time played among it", m);
m = y.mark();
y.say('stat 3014');
await expect(y, /^Vnum: 3014\./, 'stat (rstat by vnum) reads a room', m);
m = y.mark();
y.say('pardon arwen thief');
await expect(y, /^Thief flag removed\.$/, 'pardon takes the THIEF flag off', m);
check(!(pa.ch.act & PLR.THIEF), '...and it is gone');
m = y.mark();
y.say('at 3014 purge');
await expect(y, /^Ok\.$/, 'purge (at the market square) empties the room of mobiles', m);
check(game.mobs.every((s) => s.dead || s.roomVnum !== 3014), '...every one of them');
check(game.players.find((p) => p.ch.name === 'Yeb').ch.roomVnum === QUIET, "...and 'at' brings him back", game.players.find((p) => p.ch.name === 'Yeb').ch.roomVnum);
m = y.mark();
let ma = a.mark();
y.say('advance arwen 7');
await expect(y, /^Raising a player's level!$/, 'advance', m);
await expect(a, /OOOOHHHHHHHHHH  YYYYEEEESSS/, '...and she is told', ma);
check(pa.ch.level === 7, 'she is seventh level', pa.ch.level);
m = a.mark();
a.say('goto 3001');
await expect(a, /^Huh\?$/, 'a mortal has no goto', m);

// ------------------------------------------------- the board and the site --
console.log('\nNOTES, SNOOPING, SETTING, BANNING');
{
  m = a.mark();
  a.say('note to boromir yeb');
  a.say('note subject The pass');
  a.say('note + The road through the pass is open.');
  a.say('note + Bring rope.');
  a.say('note show');
  await expect(a, /^Arwen: The pass\nTo: boromir yeb$/, 'note show: the note in progress', m);
  a.say('note post');
  await pause(200);
  m = b.mark();
  b.say('note list');
  await expect(b, /^\[  0\] Arwen: The pass$/, 'note list: Boromir sees the note to him', m);
  m = third.mark();
  third.say('note list');
  third.say('note read 0');
  await expect(third, /^No such note\.$/, '...and Gimli, whom it is not to, does not', m);
  m = b.mark();
  b.say('note read 0');
  const read = await expect(b, /^\[  0\] Arwen: The pass\n\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4}\nTo: boromir yeb$/, "note read: header, ctime's date and the to-list", m);
  await expect(b, /^The road through the pass is open\.\nBring rope\.$/, '...and the text', m);
  void read;
  const { createNotes, createSite } = await import('../server/store.mjs');
  check(createNotes(data).list().length === 1 && createNotes(data).list()[0].subject === 'The pass', 'posting writes the board through to the data directory');
  m = b.mark();
  b.say('note remove 0');
  await expect(b, /^Ok\.$/, 'a recipient removes it from their own list', m);
  check(createNotes(data).list().length === 1 && createNotes(data).list()[0].to === 'yeb', '...which only strikes their name off it (note_remove)', JSON.stringify(createNotes(data).list()[0]?.to));
  m = a.mark();
  a.say('note remove 0');
  await expect(a, /^Ok\.$/, 'the sender removes it from the board', m);
  check(createNotes(data).list().length === 0, '...and it is gone from the file');
  m = a.mark();
  a.say('note');
  await expect(a, /^Huh\?  Type 'help note' for usage\.$/, 'note alone is usage', m);

  // snoop
  m = y.mark();
  y.say('snoop boromir');
  await expect(y, /^Ok\.$/, 'snoop', m);
  m = y.mark();
  b.say('score');
  await expect(y, /^% You are Boromir/, "...copies what the victim reads, after '% '", m);
  m = a.mark();
  a.say('snoop boromir');
  await expect(a, /^Huh\?$/, 'a mortal cannot snoop', m);
  m = y.mark();
  y.say('snoop yeb');
  await expect(y, /^Cancelling all snoops\.$/, 'snooping yourself cancels it', m);
  m = y.mark();
  b.say('score');
  await pause(300);
  check(!y.events.slice(m).some((e) => /^% /.test(e.text || '')), '...and nothing more comes through');

  // mset, oset, rset
  m = y.mark();
  y.say('mset boromir str 17');
  y.say('mset boromir str 19');
  await expect(y, /^Strength range is 3 to 18\.$/, "mset's ranges", m);
  check(pbp.ch.permStr === 17, 'mset boromir str 17 takes', pbp.ch.permStr);
  m = y.mark();
  y.say('mset boromir level 10');
  await expect(y, /^Not on PC's\.$/, "...and level is not for players", m);
  y.say('mset boromir title the Steward\'s son');
  await pause(200);
  check(pbp.ch.title === " the Steward's son", 'mset title', pbp.ch.title);
  m = y.mark();
  y.say('mset boromir');
  await expect(y, /^  name short long description title spec$/, 'mset with too little is the usage', m);
  const bag = pbp.ch.inventory[0] || null;
  if (bag) {
    const word = bag.keywords.split(' ')[0];
    y.say(`oset ${word} cost 777`);
    await pause(200);
    check(bag.cost === 777, `oset ${word} cost 777`, bag.cost);
  }
  y.say(`rset ${QUIET} sector 2`);
  await pause(200);
  check(w.world.rooms.get(QUIET).sector === 2, 'rset sector', w.world.rooms.get(QUIET).sector);
  y.say(`rset ${QUIET} sector 1`);

  // ban and allow, and the wizlock, kept in the data directory
  m = y.mark();
  y.say('ban 0.0.1');
  y.say('ban 0.0.1');
  await expect(y, /^That site is already banned!$/, 'ban, twice', m);
  m = y.mark();
  y.say('ban');
  await expect(y, /^Banned sites:\n0\.0\.1$/, 'ban alone lists the sites', m);
  check(createSite(data).bans().includes('0.0.1'), '...kept in the data directory');
  const banned = client('Banned');
  const bye = await banned.waitFor((x) => x.messages.find((mm) => mm.t === 'bye'), 3000, 'bye').catch(() => null);
  check(bye && bye.why === 'Your site has been banned from this Mud.', 'a connection from a banned site (a suffix of 127.0.0.1) is refused', bye && bye.why);
  m = y.mark();
  y.say('allow 0.0.1');
  y.say('allow 0.0.1');
  await expect(y, /^Site is not banned\.$/, 'allow, twice', m);
  check(!createSite(data).bans().length, '...and the file forgets it');
  m = y.mark();
  y.say('wizlock');
  await expect(y, /^Game wizlocked\.$/, 'wizlock', m);
  check(createSite(data).wizlock === true, '...kept in the data directory, for the next boot');
  const locked = client('Locked');
  await locked.opened;
  locked.send({ t: 'login', name: 'Gimli', password: 'axeaxe' });
  const lockedReply = await locked.waitFor((x) => x.messages.find((mm) => mm.t === 'login'), 5000, 'login').catch(() => null);
  check(lockedReply && lockedReply.why === 'The game is wizlocked.', 'a mortal cannot log in while it is', lockedReply && lockedReply.why);
  locked.ws.close();
  y.say('wizlock');
  await pause(200);
  check(createSite(data).wizlock === false, 'un-wizlocked, and the file says so');
}

// ------------------------------------------------------ the shop and gates --
console.log('\nSHOPS AND GATES');
{
  const keeper = game.mobs.find((slot) => slot.record.shop && !slot.dead && slot.instance && slot.roomVnum >= 3000 && slot.roomVnum < 3100
    && slot.instance.inventory.length >= 2 && w.built.rooms.has(slot.roomVnum));
  const centre = w.built.rooms.get(keeper.roomVnum).center;
  game.withPlayer(pa, () => { game.state.gold = 5000; });
  await a.at(keeper.roomVnum, keeper.pos.x - centre.x + 1, keeper.pos.z - centre.z);
  const shopMsg = await a.waitFor((x) => [...x.messages].reverse().find((mm) => mm.t === 'shop' && mm.s && mm.s.keeper === keeper.proto.vnum), 3000, 'shop').catch(() => null);
  const view = shopMsg && shopMsg.s;
  const held = keeper.instance.inventory;
  check(!!view, `standing at ${keeper.proto.short}, the client is sent the keeper's shop`, view && `${view.stock.length} for sale, ${view.open ? 'open' : 'shut'}`);
  const sameStock = view && view.stock.every((e) => held.some((o) => o.vnum === e.vnum && o.level === e.level && o.name === e.name));
  check(sameStock, "...the stock the server's keeper holds, at the levels rolled there", view && view.stock.map((e) => `${e.name} L${e.level} ${e.cost}g`).join(', '));
  check(view && view.m === game.mobs.indexOf(keeper), '...naming the keeper by its index');
  const pick = view && view.stock.find((e) => e.level <= pa.ch.level && e.cost > 0);
  if (pick) {
    const gold0 = pa.ch.gold;
    m = a.mark();
    a.send({ t: 'op', op: 'buy', a: [view.keeper, pick.vnum] });
    await expect(a, new RegExp(`^You buy .* for ${pick.cost} gold\\.$`), '...and buying it costs what the panel said', m);
    check(pa.ch.gold === gold0 - pick.cost && pa.ch.inventory.some((o) => o.vnum === pick.vnum), '...the gold gone and the thing carried', `${gold0} -> ${pa.ch.gold}`);
    const bought = pa.ch.inventory.find((o) => o.vnum === pick.vnum);
    const after = await a.waitFor((x) => [...x.messages].reverse().find((mm) => mm.t === 'shop' && mm.s && mm.s.offers.length), 3000, 'offers').catch(() => null);
    const selfId = a.self.inventory.find((o) => o.vnum === pick.vnum)?.id;
    const offer = after && after.s.offers.find(([oid]) => oid === selfId);
    check(!!offer && offer[1] === 0, "what the keeper already stocks it offers nothing for (do_sell)", offer && JSON.stringify(offer));
    void bought;
  } else check(false, 'something in the shop a level-7 player may buy');
  await a.at(QUIET, 1, 0);
  await a.waitFor((x) => [...x.messages].reverse().find((mm) => mm.t === 'shop')?.s === null, 3000, 'no shop').catch(() => null);
  check([...a.messages].reverse().find((mm) => mm.t === 'shop')?.s === null, 'walking away, the shop is gone from the panel');

  const gates = [...a.messages].reverse().find((mm) => mm.t === 'gates');
  const wardenLevel = (gate) => game.mobs.find((slot) => slot.record === gate.warden && !slot.dead && slot.instance)?.instance.level;
  const serverGates = game.gates.filter((g) => w.zoneOfVnum(g.vnum)?.zone.id === gates?.z);
  check(gates && gates.g.length === serverGates.length && gates.g.length > 0, "the zone's gates are sent", gates && `${gates.g.length} in ${gates.z}`);
  const levelsMatch = gates && gates.g.every(([vnum, dir, , level]) => {
    const g = serverGates.find((x) => x.vnum === vnum && x.dir === dir);
    return g && level === (wardenLevel(g) ?? g.wardenLevel);
  });
  check(levelsMatch, "...each with the level of the warden actually standing there", gates && gates.g.map(([v, d, o, l]) => `#${v}${'neswud'[d]}:${o ? 'open' : `L${l}`}`).join(' '));
  // A warden slain by someone else opens the gate on everyone's map.
  const gate = serverGates.find((g) => !g.open && wardenLevel(g) !== undefined);
  const wslot = game.mobs.find((slot) => slot.record === gate.warden && !slot.dead);
  const word = wslot.proto.keywords.split(' ')[0];
  m = y.mark();
  y.say(`at ${wslot.roomVnum} slay ${word}`);
  await expect(y, /^You slay .* in cold blood!$/, `the implementor slays the warden of #${gate.vnum} (${wslot.proto.short})`, m);
  const opened = await a.waitFor((x) => [...x.messages].reverse().find((mm) => mm.t === 'gates' && mm.g.some(([v, d, o]) => v === gate.vnum && d === gate.dir && o)), 3000, 'gate open').catch(() => null);
  check(!!opened, '...and the gate opens on another player\'s map');
}

// --------------------------------------------------------------- positions --
console.log('\nPOSITIONS');
{
  const refused = () => [...a.messages].reverse().find((mm) => mm.t === 'at');
  await a.at(QUIET, 0, 0);
  await pause(150);
  const before = { ...pa.position };
  const n0 = a.messages.filter((mm) => mm.t === 'at').length;
  // A jump across the town with no sequence number the server gave.
  a.send({ t: 'pos', ...spot(3014, 0, 0), yaw: 0, seq: a.seq });
  await a.waitFor((x) => x.messages.filter((mm) => mm.t === 'at').length > n0, 3000, 'at').catch(() => null);
  const r1 = refused();
  check(r1 && /no open way/.test(r1.why) && r1.room === QUIET, 'a jump to a room no exit leads to is refused, and the client put back', r1 && r1.why);
  check(Math.hypot(pa.position.x - before.x, pa.position.z - before.z) < 0.01 && pa.ch.roomVnum === QUIET, '...the server never moved the player');
  check(r1 && r1.seq > 0 && r1.seq === a.seq, "...under a new sequence number, so reports from before it are dropped", r1 && r1.seq);
  const s0 = spot(QUIET, 0, 0);
  a.send({ t: 'pos', ...spot(3014, 0, 0), yaw: 0, seq: a.seq - 1 });
  await pause(150);
  check(pa.ch.roomVnum === QUIET && a.messages.filter((mm) => mm.t === 'at').length === n0 + 1, '...and a stale report is not even answered');
  // Faster than anything a page does, inside one room.
  a.send({ t: 'pos', ...s0, yaw: 0, seq: a.seq });
  await pause(120);
  const n1 = a.messages.filter((mm) => mm.t === 'at').length;
  a.send({ t: 'pos', ...s0, x: s0.x + 0.8, yaw: 0, seq: a.seq });
  a.send({ t: 'pos', ...s0, x: s0.x + 9, yaw: 0, seq: a.seq });
  await a.waitFor((x) => x.messages.filter((mm) => mm.t === 'at').length > n1, 3000, 'at').catch(() => null);
  const r2 = refused();
  check(a.messages.filter((mm) => mm.t === 'at').length > n1 && / m in /.test(r2.why), 'a step of 8 m in no time is refused', r2 && r2.why);
  check(Math.abs(pa.position.x - (s0.x + 0.8 + w.zoneOfVnum(QUIET).offset)) < 0.01, '...the honest step before it stands');
  // An exit with its door shut.
  const shut = [...w.world.rooms.values()].find((room) => w.zoneOfVnum(room.vnum) === w.zoneOfVnum(3001) && w.built.rooms.has(room.vnum)
    && !w.built.rooms.get(room.vnum).unbuilt && room.exits.some((e) => e && !e.offMap && (e.locks & 2) && w.built.rooms.has(e.to) && !w.built.rooms.get(e.to).unbuilt
      && !room.exits.some((o) => o && o !== e && o.to === e.to)
      // Nobody there to start a fight while the check stands about.
      && !game.mobs.some((sl) => !sl.dead && (sl.roomVnum === room.vnum || sl.roomVnum === e.to))));
  const door = shut.exits.find((e) => e && !e.offMap && (e.locks & 2) && w.built.rooms.has(e.to));
  await a.at(shut.vnum);
  await pause(150);
  const n2 = a.messages.filter((mm) => mm.t === 'at').length;
  a.send({ t: 'pos', ...spot(door.to), yaw: 0, seq: a.seq });
  await a.waitFor((x) => x.messages.filter((mm) => mm.t === 'at').length > n2, 3000, 'at').catch(() => null);
  check(a.messages.filter((mm) => mm.t === 'at').length > n2 && pa.ch.roomVnum === shut.vnum, `through the shut ${door.keyword || 'door'} of #${shut.vnum} is refused`, refused()?.why);
  // The temple mound: a page stands 1.2 m up it, the server's grid does not.
  await a.at(3001, 2, 0); await b.at(3001, -2, 0);
  await pause(300);
  const grid = w.built.rooms.get(3001).center.y;
  check(Math.abs(pa.position.y - 1.72 - grid) < 0.01, "on the temple mound the server stands her on its grid floor", `feet ${(pa.position.y - 1.72).toFixed(2)} for a page's ${(grid + 1.2).toFixed(2)}`);
  const seen = b.positions.get(a.id);
  check(seen && Math.abs(seen.y - (grid + 1.2 + 1.72)) < 0.05, "...and others are sent her back up on it", seen && seen.y);
  check(mud.stats.refused === 3, 'every refusal is counted, and nothing else was refused', mud.stats.refused);
  await a.at(QUIET, 1, 0); await b.at(QUIET, -1, 0);
}

// ---------------------------------------------- resting, corpses, backstab --
console.log('\nRESTING, CORPSES, BACKSTAB');
{
  const { MERC } = await import('../src/game.js');
  // Each player's char_update runs on its own clock: quick only for whoever lies down.
  for (const p of [pa, pbp]) { p.ch.fighting = null; p.ch.position = MERC.POS.STANDING; p.ch.hit = 1; p.pulsePoint = 2; }
  m = a.mark();
  a.say('rest');
  await expect(a, /^You (rest|sit down and rest)\.?/, 'Arwen rests; Boromir stands', m);
  await pause(1200);
  const quick = MERC.PULSE_TICK / 4;
  check(pa.pulsePoint <= quick && pbp.pulsePoint > quick, "her point-pulse runs four times as fast, and his does not", `${pa.pulsePoint} vs ${pbp.pulsePoint} pulses to go`);
  check(pa.ch.hit > 1 && pbp.ch.hit > 1, '...and both regained on their own tick', `${pa.ch.hit} and ${pbp.ch.hit} hp`);
  a.say('stand');
  for (const p of [pa, pbp]) p.ch.hit = p.ch.maxHit;

  // A player's corpse: make_corpse, and do_get's rule for it.
  const proto = [...w.world.objProtos.values()].find((o) => (o.wearFlags & 1) && o.itemType === 5);
  const sword = MERC.createObject(proto, 1);
  pbp.ch.inventory.push(sword);
  await a.at(QUIET, 1, 0); await b.at(QUIET, -1, 0); await third.at(QUIET, 0, 2.5);
  m = y.mark();
  y.say(`at ${QUIET} slay boromir`);
  await expect(y, /^You slay .* in cold blood!$/, 'the implementor slays Boromir', m);
  const corpse = game.ground.find((o) => o.itemType === 24 && o.inRoom === QUIET);
  check(corpse && corpse.name === 'corpse of Boromir' && corpse.contains.includes(sword), 'his corpse lies where he fell, holding what he carried', corpse && `${corpse.name}: ${corpse.contains.map((o) => o.name).join(', ')}; timer ${corpse.timer}`);
  check(!pbp.ch.inventory.length && pbp.ch.roomVnum !== QUIET, '...and he is gone from it, with nothing', `#${pbp.ch.roomVnum}`);
  const groundMsg = await a.waitFor((x) => [...x.messages].reverse().find((mm) => mm.t === 'ground' && mm.o.some((o) => o.itemType === 24)), 3000, 'ground').catch(() => null);
  const view = groundMsg && groundMsg.o.find((o) => o.itemType === 24);
  check(view && view.owner === 'Boromir' && view.look && view.look.cls === pbp.ch.class, "the clients are sent whose it is and how to draw him", view && JSON.stringify({ owner: view.owner, look: view.look }));
  m = third.mark();
  third.say('get all corpse');
  await expect(third, /^You can't do that\.$/, "Gimli, not in his group, may not loot it", m);
  m = third.mark();
  third.send({ t: 'op', op: 'takeAll', a: [{ o: view.id }] });
  await expect(third, /^You can't do that\.$/, '...not by the panel either', m);
  check(corpse.contains.includes(sword), '...and it still holds his weapon');
  m = a.mark();
  a.say('get all corpse');
  await expect(a, /^You get .* from corpse of Boromir\.$/, 'Arwen, his group leader, may', m);
  check(pa.ch.inventory.includes(sword), '...and has his weapon');

  // Backstab on a player.
  const dagger = MERC.createObject([...w.world.objProtos.values()].find((o) => o.itemType === 5 && o.values[3] === 11), 1);
  pa.ch.equipment[16] = dagger; dagger.wearLoc = 16;
  pa.ch.learned.backstab = 100;
  await b.at(QUIET, -1, 0);
  const bLevel = pbp.ch.level;
  pbp.ch.level = 1;
  m = a.mark();
  a.say('backstab boromir');
  await expect(a, /^You may not attack a lower level player\.$/, 'backstab asks is_safe first', m);
  pbp.ch.level = 10; pbp.ch.hit = pbp.ch.maxHit;
  // Boromir faces west, away from her: she is east of him.
  b.send({ t: 'pos', ...spot(QUIET, -1, 0), yaw: Math.PI / 2, seq: b.seq });
  await pause(250);
  m = a.mark();
  const mb2 = b.mark();
  a.say('backstab boromir');
  await expect(a, /^Your backstab .* Boromir[.!]$/, 'a backstab from behind lands: "Your backstab ..."', m);
  await expect(b, /^Arwen's backstab .* you[.!]$/, '...and he reads it as TO_VICT', mb2);
  check(!!(pa.ch.act & PLR.KILLER), '...and an innocent backstabbed makes her a KILLER');
  m = a.mark();
  a.say('kick');
  await expect(a, /kick|out of reach|aren't fighting/, 'and kick, with a player for an opponent, does not stumble', m);
  check(!quiet.some((line) => /error handling/.test(line)), '...nor does anything else here', quiet.filter((line) => /error handling/.test(line))[0]);
  y.say(`at ${QUIET} peace`);
  y.say('pardon arwen killer');
  y.say('restore arwen'); y.say('restore boromir');
  await pause(300);
  pbp.ch.level = bLevel;
}

// -------------------------------------------------------------- dashboard --
console.log('\nTHE DASHBOARD');
{
  const dashOf = (c, from = 0) => c.messages.slice(from).filter((mm) => mm.t === 'dash');
  const evOf = (c, from = 0) => dashOf(c, from).flatMap((mm) => mm.ev || []);
  const waitDash = (c, pred, from, what, ms = 3000) => c.waitFor((x) => dashOf(x, from).find(pred), ms, what).catch(() => null);
  const waitEv = (c, re, from, ms = 3000) => c.waitFor((x) => evOf(x, from).find((e) => re.test(e.text)), ms, String(re)).catch(() => null);
  check(hello.features && hello.features.includes('dash'), "hello lists the dashboard among the server's features", JSON.stringify(hello.features));

  // A mortal: refused, every way in, and sent nothing of the mud.
  const am = a.messages.length;
  const roomA = pa.ch.roomVnum;
  a.send({ t: 'dash', op: 'sub' });
  a.send({ t: 'dash', op: 'goto', id: pbp.id });
  a.send({ t: 'dash', op: 'wizlock', on: true });
  a.send({ t: 'dash', op: 'follow', id: pbp.id });
  await pause(1300);
  const toA = dashOf(a, am);
  check(toA.length === 4 && toA.every((mm) => mm.k === 'no' && Object.keys(mm).sort().join() === 'k,t,why'), "a mortal's every dashboard message is answered 'no', and with nothing else", JSON.stringify(toA.map((mm) => mm.k)));
  check(pa.ch.roomVnum === roomA && mud.sessionNamed('Arwen').dash == null, '...her goto went nowhere and she holds no subscription');
  m = a.mark();
  a.say('dashboard');
  await expect(a, /^Huh\?$/, "and to a mortal the 'dashboard' command is not there at all", m);

  // The implementor: a snapshot, then batches.
  let ym = y.messages.length;
  y.say('dashboard');
  await y.waitFor((x) => x.events.find((e) => e.kind === 'dashboard'), 3000, 'the dashboard event').catch(() => null);
  check(y.events.some((e) => e.kind === 'dashboard'), "'dashboard' typed by the implementor tells his page to open it");
  y.send({ t: 'dash', op: 'sub' });
  const snap = await waitDash(y, (mm) => mm.k === 'snap', ym, 'snapshot');
  check(!!snap && snap.who.some((p) => p.name === 'Arwen') && snap.who.some((p) => p.name === 'Boromir'), 'he is sent a snapshot: who is on', snap && snap.who.map((p) => `${p.name} L${p.level} ${p.cls} #${p.vnum} ${p.pos} ${p.host}`).join('; '));
  const arwen = snap && snap.who.find((p) => p.name === 'Arwen');
  check(arwen && arwen.hp === pa.ch.hit && arwen.room === w.world.rooms.get(pa.ch.roomVnum).name && typeof arwen.active === 'number' && arwen.zone === 'home',
    "...each with vitals, room, zone, position and idle time", arwen && JSON.stringify({ hp: arwen.hp, room: arwen.room, zone: arwen.zone, pos: arwen.pos, active: arwen.active }));
  check(snap && snap.health.up >= 0 && snap.health.tickMean > 0 && snap.health.players >= 3 && snap.health.rss > 0, '...the server\'s health', snap && JSON.stringify({ up: snap.health.up, tick: snap.health.tickMean, max: snap.health.tickMax, players: snap.health.players, rss: snap.health.rss }));
  check(snap && snap.ev.some((e) => e.c === 'conn' && /Arwen/.test(e.text)), '...and what happened before he asked', snap && `${snap.ev.length} events kept`);

  // Talk.
  ym = y.messages.length;
  await a.at(pbp.ch.roomVnum === pa.ch.roomVnum ? pa.ch.roomVnum : QUIET);
  a.say('say the dashboard hears this');
  a.say('tell boromir only you and the owner');
  a.say('chat on the chat channel');
  const said = await waitEv(y, /^Arwen says 'the dashboard hears this'$/, ym);
  check(!!said && said.c === 'talk' && said.vnum === pa.ch.roomVnum, 'a say comes through, with the room', said && JSON.stringify(said));
  const told = await waitEv(y, /^Arwen tells Boromir 'only you and the owner'$/, ym);
  check(!!told && told.priv === true, '...a tell, marked private', told && JSON.stringify(told));
  const chat = await waitEv(y, /^Arwen chats 'on the chat channel'$/, ym);
  check(!!chat, '...a channel', chat && chat.text);
  check(!dashOf(a, am).some((mm) => mm.k !== 'no') && !dashOf(b).length, '...and neither mortal is sent any of it');

  // Batches: four a second at most, who and health once a second.
  ym = y.messages.length;
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) { a.say(`say beat ${i}`); await pause(125); }
  await pause(300);
  const secs = (Date.now() - t0) / 1000;
  const batches = dashOf(y, ym).filter((mm) => mm.k === 'batch');
  const rate = batches.length / secs;
  check(rate <= 4.5 && batches.length >= 3, 'events come in batches, at most four a second', `${batches.length} batches in ${secs.toFixed(1)} s for 8 says`);
  const rowsSent = batches.flatMap((mm) => mm.who || []);
  check(rowsSent.length <= 2 * batches.filter((mm) => mm.health).length, '...and of the roster only the rows that changed', `${rowsSent.length} rows in ${batches.filter((mm) => mm.health).length} roster sends`);
  check(batches.filter((mm) => mm.health).length >= 1 && batches.filter((mm) => mm.health).length <= Math.ceil(secs) + 1, '...the roster and health about once a second', `${batches.filter((mm) => mm.health).length} with health`);

  // Wizard commands and the site.
  ym = y.messages.length;
  y.say('restore arwen');
  const wiz = await waitEv(y, /^Yeb: restore arwen$/, ym);
  check(!!wiz && wiz.c === 'wiz', 'a wizard command is reported, by whom', wiz && wiz.text);

  // Actions, each by id.
  ym = y.messages.length;
  y.send({ t: 'dash', op: 'goto', id: pa.id });
  const went = await waitDash(y, (mm) => mm.k === 'did' && mm.op === 'goto', ym, 'goto');
  const py = game.players.find((p) => p.ch.name === 'Yeb');
  check(!!went && py.ch.roomVnum === pa.ch.roomVnum, 'goto from the dashboard puts him in her room', went && `${went.lines[0]} -> #${py.ch.roomVnum}`);
  await y.at(py.ch.roomVnum);
  await b.at(3001);
  ym = y.messages.length;
  y.send({ t: 'dash', op: 'transfer', id: pbp.id });
  await waitDash(y, (mm) => mm.k === 'did' && mm.op === 'transfer', ym, 'transfer');
  check(pbp.ch.roomVnum === py.ch.roomVnum, 'transfer brings Boromir to him', `#${pbp.ch.roomVnum}`);
  ym = y.messages.length;
  y.send({ t: 'dash', op: 'snoop', id: pa.id });
  await waitDash(y, (mm) => mm.k === 'did' && mm.op === 'snoop', ym, 'snoop');
  check(mud.sessionNamed('Arwen').snoopBy === mud.sessionNamed('Yeb'), 'snoop from the dashboard snoops her');
  ym = y.messages.length;
  y.send({ t: 'dash', op: 'snoop', id: pa.id });
  await waitDash(y, (mm) => mm.k === 'did' && mm.op === 'snoop', ym, 'snoop off');
  check(!mud.sessionNamed('Arwen').snoopBy, '...and again lets her go');
  pa.ch.hit = 1;
  ym = y.messages.length;
  y.send({ t: 'dash', op: 'restore', id: pa.id });
  await waitDash(y, (mm) => mm.k === 'did' && mm.op === 'restore', ym, 'restore');
  check(pa.ch.hit === pa.ch.maxHit, 'restore from the dashboard', `${pa.ch.hit}/${pa.ch.maxHit}`);
  ym = y.messages.length;
  y.send({ t: 'dash', op: 'wizlock', on: true });
  await waitDash(y, (mm) => mm.k === 'did' && mm.op === 'wizlock', ym, 'wizlock');
  const locked = await waitEv(y, /^Yeb wizlocked the game$/, ym);
  check(mud.stats && locked && locked.c === 'site', 'wizlock on from the dashboard, and the stream says so', locked && locked.text);
  ym = y.messages.length;
  y.send({ t: 'dash', op: 'wizlock', on: true });
  const again = await waitDash(y, (mm) => mm.k === 'did' && mm.op === 'wizlock', ym, 'wizlock again');
  check(again && /Already/.test(again.lines[0]), '...on when it is on is no toggle', again && again.lines[0]);
  y.send({ t: 'dash', op: 'wizlock', on: false });
  await waitEv(y, /^Yeb lifted the wizlock$/, ym);
  const { createSite: siteNow } = await import('../server/store.mjs');
  check(siteNow(data).wizlock === false, '...and off again');

  // The god view's feed: every zone's plan, every player's position, every mobile.
  ym = y.messages.length;
  y.send({ t: 'dash', op: 'atlas' });
  const atlas = await waitDash(y, (mm) => mm.k === 'atlas', ym, 'atlas');
  const home = atlas && atlas.zones.find((z) => z.zone === 'home');
  check(!!atlas && atlas.zones.length === w.zones.length && home.rooms.length > 100, "the atlas is every zone's plan", atlas && `${atlas.zones.length} zones, ${atlas.zones.reduce((n, z) => n + z.rooms.length, 0)} rooms, ${JSON.stringify(atlas).length} B`);
  check(snap.mobs.length === game.mobs.length && snap.pos.length >= 3, '...the snapshot has every mobile and every player', snap && `${snap.mobs.length} mobiles, ${snap.pos.length} players`);
  ym = y.messages.length;
  const elsewhere = [...w.built.rooms.keys()].find((v) => w.zoneOfVnum(v)?.zone.id !== 'home' && !w.built.rooms.get(v).unbuilt);
  mud.place(b.id, elsewhere);
  for (let i = 0; i < 10; i++) { await a.at(QUIET, (i % 2) * 0.5, 0); await pause(100); }
  const posMsgs = dashOf(y, ym).filter((mm) => mm.k === 'pos');
  const ofA = posMsgs.flatMap((mm) => mm.p).filter((row) => row[0] === pa.id);
  const ofB = posMsgs.flatMap((mm) => mm.p).filter((row) => row[0] === pbp.id);
  check(ofA.length >= 7 && Math.abs(ofA.at(-1)[2] - w.toClient(pa.position).x) < 0.02, 'a walking player\'s position comes at about 10 Hz', `${ofA.length} reports in ${posMsgs.length} messages`);
  check(ofB.length >= 1 && ofB.at(-1)[1] === w.zoneOfVnum(elsewhere).zone.id, '...and one in another zone, out of everyone\'s sight, is still there', ofB.length && JSON.stringify(ofB.at(-1)));
  check(posMsgs.length <= 13, '...only what moved, no more often than 10 Hz', `${posMsgs.length} messages in ~1 s`);
  ym = y.messages.length;
  y.send({ t: 'dash', op: 'goto', vnum: 3014 });
  await waitDash(y, (mm) => mm.k === 'did' && mm.op === 'goto', ym, 'goto room');
  check(py.ch.roomVnum === 3014, 'goto a room by its number', `#${py.ch.roomVnum}`);
  y.send({ t: 'dash', op: 'goto', vnum: 'quit' });
  const bad = await waitDash(y, (mm) => mm.k === 'did' && mm.op === 'goto' && !mm.ok, ym, 'bad goto');
  check(!!bad && py.ch.roomVnum === 3014, '...and nothing that is not a room number', bad && bad.lines[0]);
  await b.at(QUIET);

  // A fight and a kill.
  const prey = game.mobs.find((s) => !s.dead && s.instance && s.proto.level <= 3 && w.zoneOfVnum(s.roomVnum)?.zone.id === 'home'
    && !(w.world.rooms.get(s.roomVnum).flags & 1024) && w.built.rooms.has(s.roomVnum) && !s.proto.shop && !/keeper|guard/i.test(s.proto.short));
  if (prey) {
    await a.at(prey.roomVnum);
    ym = y.messages.length;
    a.say(`kill ${prey.proto.keywords.split(' ')[0]}`);
    const fought = await waitEv(y, /^Arwen fights /, ym);
    check(!!fought && fought.c === 'fight', 'a fight begun is reported', fought && fought.text);
    if (prey.instance) prey.instance.hit = 1;
    // The mobile has to close in before a blow lands: give it time.
    const died = await waitEv(y, /dies at the hands of Arwen/, ym, 15000);
    check(!!died && died.c === 'death', "...and the kill, with the killer's name", died && died.text);
    const idx = game.mobs.indexOf(prey);
    const body = await y.waitFor((x) => dashOf(x, ym).flatMap((mm) => mm.m || []).find((row) => row[0] === idx && row[2] !== 0), 3000, 'mob diff').catch(() => null);
    check(!!body, '...and the mobile\'s body changes in the next batch', body && JSON.stringify(body));
  } else check(false, 'a weak mobile to fight in the home zone');

  // Trust is read every time: below 40, the stream stops.
  ym = y.messages.length;
  py.ch.trust = 39;
  const off = await waitDash(y, (mm) => mm.k === 'off', ym, 'off');
  check(!!off, 'an implementor whose trust drops is dropped from the stream', off && off.why);
  const after = y.messages.length;
  a.say('say nobody on the dashboard hears this');
  await pause(700);
  check(!dashOf(y, after).length, '...and sent nothing more');
  y.send({ t: 'dash', op: 'sub' });
  const no = await waitDash(y, (mm) => mm.k === 'no', after, 'no');
  check(!!no, '...nor let back in', no && no.why);
  py.ch.trust = 40;
  // Back where the next section expects everyone: Park Road.
  y.say(`at ${QUIET} peace`);
  await a.at(QUIET); await y.at(QUIET);
  check(!quiet.some((line) => /error handling/.test(line)), 'nothing on the dashboard threw', quiet.filter((line) => /error handling/.test(line))[0]);
}

// ---------------------------------------------------- quitting and links --
console.log('\nLEAVING');
m = y.mark();
third.say('quit');
await expect(third, /^Had I but time--as this fell sergeant, Death,$/, 'quit says the verse', 0);
await third.waitFor((x) => x.messages.find((mm) => mm.t === 'bye'), 3000, 'bye').catch(() => null);
check(!!third.messages.find((mm) => mm.t === 'bye'), '...and closes the link');
check(createAccounts(data).load('Gimli').char.room === QUIET, '...having saved where he stood', createAccounts(data).load('Gimli').char.room);
m = a.mark();
await b.at(QUIET, -1, 0); await pause(250);
m = a.mark();
b.ws.close();
await expect(a, /^Boromir has lost his link\.$/, 'a dropped link is announced and the body stays', m);
check(game.players.some((p) => p.ch.name === 'Boromir'), '...still in the world');
const b2 = client('Boromir again');
await b2.opened;
m = a.mark();
b2.send({ t: 'login', name: 'Boromir', password: 'gondor1' });
await b2.waitFor((x) => x.id !== null, 5000, 'enter');
await expect(a, /^Boromir has reconnected\.$/, 'logging back in takes the body over', m);
check(game.players.filter((p) => p.ch.name === 'Boromir').length === 1, '...one Boromir, not two');
{
  // Back in without the password: the token the last "enter" gave.
  const enter2 = b2.messages.find((mm) => mm.t === 'enter');
  check(typeof enter2.token === 'string' && enter2.token.length >= 24, "'enter' carries a reconnect token");
  m = a.mark();
  b2.ws.close();
  await expect(a, /^Boromir has lost his link\.$/, 'his link drops again', m);
  const wrong = client('Boromir, wrong token');
  await wrong.opened;
  wrong.send({ t: 'login', name: 'Boromir', token: 'not-the-token' });
  const no = await wrong.waitFor((x) => x.messages.find((mm) => mm.t === 'login'), 3000, 'login').catch(() => null);
  check(no && no.ok === false && /log in again/.test(no.why), 'a wrong token is refused', no && no.why);
  wrong.ws.close();
  const b3 = client('Boromir, resumed');
  await b3.opened;
  m = a.mark();
  b3.send({ t: 'login', name: 'Boromir', token: enter2.token });
  await b3.waitFor((x) => x.id !== null, 5000, 'enter');
  await expect(a, /^Boromir has reconnected\.$/, 'the right one takes the body up again, no password asked', m);
  await expect(b3, /^Reconnecting\.$/, "...and he reads 'Reconnecting.'", 0);
  check(game.players.filter((p) => p.ch.name === 'Boromir').length === 1, '...still one Boromir');
  const banned = b3.messages.find((mm) => mm.t === 'enter');
  check(banned.token !== enter2.token, '...with a fresh token for next time');
}

// --------------------------------------------------------------- numbers --
console.log('\nTRAFFIC');
{
  const s0 = { ...mud.stats };
  const kinds0 = new Map(a.messages.map((x) => x.t).reduce((acc, t) => acc.set(t, (acc.get(t) || 0) + 1), new Map()));
  const bytes0 = a.messages.length;
  const t0 = Date.now();
  await pause(2000);
  const tally = new Map();
  for (const x of a.messages.slice(bytes0)) {
    const e = tally.get(x.t) || [0, 0];
    e[0] += 1; e[1] += JSON.stringify(x).length;
    tally.set(x.t, e);
  }
  console.log(`  Arwen's last 2 s by kind: ${[...tally].map(([t, [n, bytes]]) => `${t} ${n}x ${bytes} B`).join(', ')}`);
  void kinds0;
  const secs = (Date.now() - t0) / 1000;
  const players = game.players.length;
  console.log(`  ${players} players: ${((mud.stats.msgsOut - s0.msgsOut) / secs / players).toFixed(1)} messages and `
    + `${((mud.stats.bytesOut - s0.bytesOut) / secs / players / 1024).toFixed(2)} KB a second each, standing still; `
    + `tick ${(mud.stats.tickMs / mud.stats.ticks).toFixed(2)} ms mean over ${mud.stats.ticks}`);
}

// ------------------------------------------------------------- shutdown --
m = a.mark();
y.say('shutdown');
await expect(a, /^Shutdown by Yeb\.$/, 'shutdown echoes to everyone', m);
await pause(300);
rmSync(data, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
