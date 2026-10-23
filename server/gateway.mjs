/**
 * The terminal way in: an SSH server that is not a shell. Anyone may
 * connect without an SSH password or key -- authentication `none` is
 * accepted -- and the game asks for the name and the password itself, as
 * Merc's comm.c did over telnet, so the accounts are the game's own
 * (accounts.mjs, through the game server), never a Unix user's. There is no
 * shell, no exec, no forwarding and no subsystem behind it: one session a
 * connection, and that session is the game.
 *
 * Each session is one more client of the game server's /ws (term.mjs,
 * client.mjs), and walks like a page does (walker.mjs). It runs beside
 * main.mjs, not inside it: a fault here ends terminal sessions, never the
 * game, and the game server does not change for it.
 *
 * What a public port 22 or 2222 gets all day is scanners: a connection from
 * an address that opened too many in the last minute is cut before the key
 * exchange, a handshake that has not finished in 20 s is cut, and the
 * game's own login guard counts wrong passwords by address (the gateway
 * hands the address on as x-real-ip).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { generateKeyPairSync, randomBytes } from 'crypto';
import { dirname, join } from 'path';
import ssh2 from 'ssh2';

import { parseArea } from '../src/are.js';
import { bootWorld } from './world.mjs';
import { createTerm } from './term.mjs';

const { Server, utils } = ssh2;

export const LIMITS = {
  /** Connections at once from one address: as mud.mjs `socketsPerSite`, which counts them again behind us. */
  perSite: 4,
  /** Connections at once in all. */
  total: 200,
  /** New connections from one address in a minute, before the key exchange. */
  perMinute: 20,
  /** From the TCP connection to an open session. */
  handshakeMs: 20_000,
};

const sshString = (b) => Buffer.concat([Buffer.from([b.length >>> 24, b.length >>> 16, b.length >>> 8, b.length].map((x) => x & 255)), b]);

/**
 * A new ed25519 key as an unencrypted OpenSSH private key. ssh2's own
 * generateKeyPairSync strips leading zero bytes from the public key (keygen.js,
 * v1.17.0), so one key in 256 -- those whose public key starts with 0x00 -- is
 * written with a length of 31 and fails its own parser ("Malformed OpenSSH
 * private key"); node:crypto gives the raw bytes unstripped.
 */
export function newHostKey() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.from(jwk.x, 'base64url');
  const seed = Buffer.from(jwk.d, 'base64url');
  const name = sshString(Buffer.from('ssh-ed25519'));
  const pubBlob = Buffer.concat([name, sshString(pub)]);
  const check = randomBytes(4);
  let priv = Buffer.concat([check, check, name, sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(Buffer.alloc(0))]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const none = sshString(Buffer.from('none'));
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), none, none, sshString(Buffer.alloc(0)), Buffer.from([0, 0, 0, 1]), sshString(pubBlob), sshString(priv)]);
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** The host key, made once and kept: a new one makes every returning player's ssh refuse to connect. */
function hostKey(path, log) {
  if (existsSync(path)) return readFileSync(path);
  const pem = newHostKey();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pem, { mode: 0o600 });
  log(`made a new host key in ${path}`);
  return Buffer.from(pem);
}

/** help.are's GREETING: Merc's title and its credits (which the licence keeps), ending in the name prompt. */
function readGreeting(root) {
  const help = parseArea(readFileSync(join(root, 'merc21/area/help.are'), 'utf8'), 'help.are').helps.find((h) => h.keyword === 'GREETING');
  if (!help) throw new Error('gateway.mjs: merc21/area/help.are has no GREETING');
  // A leading '.' keeps the spaces after it (db.c); '{' is DikuMUD's 7-bit æ.
  const lines = help.text.replace(/\r/g, '').replace(/^\./, '').replace(/\{/g, 'æ').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const prompt = `${lines.pop().trim()} `;
  return { lines: [...lines, ''], prompt };
}

/**
 * Listen for SSH on `port` and play each session against the game server at
 * `game` (ws://host:port/ws). Resolves once listening, with `port` and `close()`.
 */
export async function startGateway({ root, port, host = '0.0.0.0', game, keyPath, log = () => {}, limits = {} }) {
  const lim = { ...LIMITS, ...limits };
  const world = bootWorld(root, { log });
  const greeting = readGreeting(root);
  const terms = new Set();
  const open = new Map();
  const recent = new Map();
  const stats = { connections: 0, cut: 0, sessions: 0 };

  const server = new Server({ hostKeys: [hostKey(keyPath, log)], ident: 'diku3d' }, (client, info) => {
    const ip = info.ip;
    stats.connections += 1;
    const now = Date.now();
    const times = (recent.get(ip) || []).filter((t) => now - t < 60_000);
    times.push(now);
    recent.set(ip, times);
    if (times.length > lim.perMinute) {
      stats.cut += 1;
      if (times.length === lim.perMinute + 1) log(`${ip}: over ${lim.perMinute} connections a minute; cutting them off before the key exchange`);
      client.end();
      return;
    }
    open.set(ip, (open.get(ip) || 0) + 1);
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      clearTimeout(handshake);
      const n = (open.get(ip) || 1) - 1;
      if (n) open.set(ip, n); else open.delete(ip);
    };
    const handshake = setTimeout(() => { log(`${ip}: no session in ${lim.handshakeMs / 1000} s; closed`); client.end(); }, lim.handshakeMs);
    // Too many: refused in words, once the session is open, so a person with one tab too many knows why.
    const busy = open.get(ip) > lim.perSite ? `There are already ${lim.perSite} connections from your address.`
      : [...open.values()].reduce((a, b) => a + b, 0) > lim.total ? 'The game is full just now. Try again later.' : null;

    client.on('authentication', (ctx) => ctx.accept());
    client.on('ready', () => {
      let session = false;
      client.on('session', (accept, reject) => {
        if (session) return reject();
        session = true;
        const s = accept();
        let pty = null;
        s.on('pty', (ok, no, p) => { pty = { term: p.term, cols: p.cols, rows: p.rows }; if (ok) ok(); });
        s.on('window-change', (ok) => { if (ok) ok(); });
        s.on('env', (ok) => { if (ok) ok(); });
        s.on('subsystem', (ok, no) => { if (no) no(); });
        s.on('exec', (ok, no, e) => {
          const stream = ok();
          stream.stderr.write(`diku3d takes no command on the ssh line ("${String(e.command).slice(0, 40)}"); connect without one and the game asks for your name.\n`);
          stream.exit(1);
          stream.end();
        });
        s.on('shell', (ok) => {
          clearTimeout(handshake);
          const stream = ok();
          if (busy) {
            stream.write(`${busy}${pty ? '\r\n' : '\n'}`);
            stream.exit(1);
            stream.end();
            return;
          }
          stats.sessions += 1;
          // The session's end closes its channel, and ssh hangs up on that by itself; ending the
          // connection from here instead makes OpenSSH print "Received disconnect" after the game's last line.
          const term = createTerm({ stream, pty, ip, world, game, greeting, log, onEnd: () => { terms.delete(term); setTimeout(() => client.end(), 3000).unref(); } });
          terms.add(term);
        });
      });
    });
    client.on('error', (error) => { if (!/ECONNRESET|Handshake|Connection lost|Bad identification/i.test(error.message)) log(`${ip}: ${error.message}`); });
    client.on('close', leave);
  });

  // Every client's `recent` would otherwise be kept for good.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, times] of recent) if (!times.some((t) => now - t < 60_000)) recent.delete(ip);
  }, 60_000);
  sweep.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  log(`ssh on ${host}:${address.port}, playing against ${game}`);
  return {
    port: address.port, stats, world,
    /** Connections the per-address count holds now: a client that has hung up is gone from it only once the server has seen the close. */
    openConnections: () => [...open.values()].reduce((a, b) => a + b, 0),
    /** End every session with a word to its player, and stop listening. */
    close(why = 'The terminal gateway is restarting. Connect again in a moment.') {
      clearInterval(sweep);
      for (const term of [...terms]) term.end(why);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
