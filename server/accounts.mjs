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
