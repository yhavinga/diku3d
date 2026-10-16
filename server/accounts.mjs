/**
 * Player files: save.c's player/<Name>, as JSON under the data directory,
 * one character per name. comm.c's nanny kept a crypt() of the password
 * in the file; here it is node's scrypt with a salt of its own per player,
 * compared in constant time.
 *
 * The file holds the character as save.js writes it (the same fields the
 * page keeps in localStorage) plus what only a mud with other players has:
 * title, description, channels, time played, trust.
 */

import { scrypt, randomBytes, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join } from 'path';

import { isName } from '../src/rules/handler.js';

const scryptAsync = promisify(scrypt);
/** scrypt's cost: N = 2^15, r = 8, p = 1 -- about 50 ms a login on a laptop. */
const KDF = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

/** The fields a mud with other players keeps beside save.js's character. */
export const EXTRA = ['title', 'description', 'deaf', 'played', 'trust', 'bamfin', 'bamfout'];

/** scrypt of `password` under a fresh salt. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFC'), salt, KEYLEN, KDF);
  return { kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export async function checkPassword(password, record) {
  if (!record || record.kdf !== 'scrypt') return false;
  const salt = Buffer.from(record.salt, 'hex');
  const want = Buffer.from(record.hash, 'hex');
  const got = await scryptAsync(password.normalize('NFC'), salt, want.length,
    { N: record.N, r: record.r, p: record.p, maxmem: KDF.maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * comm.c: check_parse_name -- three to twelve letters, not a reserved word,
 * not all I's and L's, and nobody's name that a mobile answers to.
 */
export function checkParseName(name, world) {
  if (isName(name, 'all auto immortal self someone')) return false;
  if (name.length < 3 || name.length > 12) return false;
  if (!/^[a-z]+$/i.test(name)) return false;
  if (/^[il]+$/i.test(name)) return false;
  for (const proto of world.mobProtos.values()) if (isName(name, proto.keywords)) return false;
  return true;
}

/** "yeb" -> "Yeb": the mud capitalises the first letter and keeps the rest. */
export const properName = (name) => name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();

export function createAccounts(dataDir) {
  const dir = join(dataDir, 'players');
  mkdirSync(dir, { recursive: true });
  const file = (name) => join(dir, `${name.toLowerCase()}.json`);

  return {
    dir,
    exists: (name) => existsSync(file(name)),
    load(name) {
      const path = file(name);
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data.version !== 1) throw new Error(`${path}: not a version 1 player file`);
      return data;
    },
    /** Written whole and renamed into place, so a crash never leaves half a file. */
    store(record) {
      const path = file(record.name);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

// ------------------------------------------------------------ guessing --
/**
 * What a guesser is allowed, all in memory: a restart clears it, which costs
 * nothing a patient attacker could not do by waiting. Each check below costs
 * the server one scrypt (about 50 ms of CPU) and passwords need only five
 * characters, so without these an address could try thousands a minute.
 */
export const LOGIN_LIMITS = {
  /** Wrong passwords for one name from one address before it is paused: a typo or three, not a dictionary. */
  wrongMax: 5,
  wrongWindowMs: 10 * 60 * 1000,
  /**
   * Password logins and creates from one address in a window, whichever name:
   * spraying one guess at many names never trips the per-name count. Thirty in
   * ten minutes is far above a household (a login or two each) and ~1.5 s of
   * CPU, so a carrier-grade NAT sharing an address is still served.
   */
  attemptsMax: 30,
  attemptsWindowMs: 10 * 60 * 1000,
  /** Characters made from one address: a person makes a few; a loop makes thousands of files. */
  createsMax: 5,
  createsWindowMs: 60 * 60 * 1000,
  /** Pause after a trip: 1 minute, doubling with every repeat, never past 30 (a locked-out player is back for lunch). */
  pauseMs: 60 * 1000,
  pauseCapMs: 30 * 60 * 1000,
  /** Table bound: past this many entries the oldest go, so a spray of addresses cannot grow memory. */
  tracked: 20000,
};

/**
 * Counts hits per key in a sliding window; when `max` hits are inside it the
 * key is paused for pauseMs * 2^(trips - 1), capped. Hits are not cleared by
 * a trip, so the next hit after a pause trips again, one step longer. A key
 * is forgotten once its pause is over, its window empty and a further
 * pauseCapMs of good behaviour has passed (which is also how trips decay).
 */
function createLimiter({ max, windowMs, pauseMs, pauseCapMs, tracked }, now) {
  const entries = new Map();
  let pruned = now();
  const prune = () => {
    const t = now();
    if (t - pruned < 60 * 1000 && entries.size <= tracked) return;
    pruned = t;
    for (const [key, e] of entries) {
      const quiet = Math.max(e.until, e.hits.length ? e.hits[e.hits.length - 1] + windowMs : 0);
      if (t > quiet + pauseCapMs) entries.delete(key);
    }
  };
  /** Over the bound: forget the oldest-inserted (Map order), live pauses and all. */
  const bound = () => { for (const key of entries.keys()) { if (entries.size <= tracked) break; entries.delete(key); } };
  return {
    get size() { return entries.size; },
    /** Milliseconds until `key` may try again; 0 when it may. Counts nothing. */
    wait(key) {
      prune();
      const e = entries.get(key);
      return e ? Math.max(0, e.until - now()) : 0;
    },
    /** Count a hit; the milliseconds the key is now paused for, 0 if not. */
    hit(key) {
      prune();
      const t = now();
      let e = entries.get(key);
      if (!e) { e = { hits: [], trips: 0, until: 0 }; entries.set(key, e); bound(); }
      e.hits = e.hits.filter((at) => at > t - windowMs);
      // A good stretch since the last pause lets the backoff start over.
      if (!e.hits.length && t > e.until + pauseCapMs) e.trips = 0;
      e.hits.push(t);
      if (e.hits.length > max) e.hits.shift();
      if (e.hits.length >= max) {
        e.trips += 1;
        e.until = t + Math.min(pauseCapMs, pauseMs * 2 ** (e.trips - 1));
      }
      return Math.max(0, e.until - t);
    },
    clear: (key) => entries.delete(key),
  };
}

/** "N minutes" for a wait in milliseconds, never less than one. */
export const inMinutes = (ms) => {
  const m = Math.max(1, Math.ceil(ms / 60000));
  return `${m} minute${m === 1 ? '' : 's'}`;
};

/**
 * The nanny's guard against guessing, asked before any scrypt runs:
 * `refusal(site, name)` is the words to send, or null when the attempt may go
 * ahead. `attempt` counts one; `wrong` counts a wrong password (and returns
 * the pause it brought, in ms); `right` forgets that name's wrong passwords
 * from that address -- not the address's attempts: an attacker with one
 * account of his own would clear those for free; `created` counts a new
 * character.
 */
export function createLoginGuard(overrides = {}, now = Date.now) {
  const L = { ...LOGIN_LIMITS, ...overrides };
  const pause = { pauseMs: L.pauseMs, pauseCapMs: L.pauseCapMs, tracked: L.tracked };
  const wrongs = createLimiter({ max: L.wrongMax, windowMs: L.wrongWindowMs, ...pause }, now);
  const attempts = createLimiter({ max: L.attemptsMax, windowMs: L.attemptsWindowMs, ...pause }, now);
  const creates = createLimiter({ max: L.createsMax, windowMs: L.createsWindowMs, ...pause }, now);
  const key = (site, name) => `${site}|${name.toLowerCase()}`;
  return {
    tables: { wrongs, attempts, creates },
    refusal(site, name, { creating = false } = {}) {
      let ms = attempts.wait(site);
      if (ms) return { ms, why: `Too many login attempts from your address. Try again in ${inMinutes(ms)}.` };
      // Asked even when not creating, so that every table is pruned by every login.
      ms = creates.wait(site);
      if (ms && creating) return { ms, why: `Too many new characters from your address. Try again in ${inMinutes(ms)}.` };
      ms = wrongs.wait(key(site, name));
      if (ms) return { ms, why: `Too many wrong passwords. Try again in ${inMinutes(ms)}.` };
      return null;
    },
    attempt: (site) => attempts.hit(site),
    wrong: (site, name) => wrongs.hit(key(site, name)),
    right: (site, name) => wrongs.clear(key(site, name)),
    created: (site) => creates.hit(site),
  };
}
