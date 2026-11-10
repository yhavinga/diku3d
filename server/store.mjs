/**
 * What the mud keeps beside the player files, under the same data
 * directory: the note board (Merc's notes.txt) and the site's own settings
 * -- the ban list and the wizlock, which 2.1 held in memory and lost at
 * every reboot. Each is one JSON file, written whole and renamed into
 * place, as accounts.mjs writes a player; the players' bug, idea and typo
 * reports are a file of JSON lines that is only ever added to. The ban list
 * matches addresses, so the reading of an address is here too.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

function jsonFile(path, empty) {
  return {
    read() {
      if (!existsSync(path)) return empty();
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    write(value) {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

/** The board: every note, oldest first, as do_note posts them. */
export function createNotes(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const file = jsonFile(join(dataDir, 'notes.json'), () => ({ version: 1, notes: [] }));
  const data = file.read();
  if (data.version !== 1 || !Array.isArray(data.notes)) throw new Error(`${join(dataDir, 'notes.json')}: not a version 1 note board`);
  const save = () => file.write(data);
  return {
    list: () => data.notes,
    post(note) { data.notes.push({ sender: note.sender, date: note.date, stamp: note.stamp, to: note.to, subject: note.subject, text: note.text }); save(); },
    update(note, change) { Object.assign(note, change); save(); },
    remove(note) {
      const i = data.notes.indexOf(note);
      if (i < 0) throw new Error('notes: removing a note that is not on the board');
      data.notes.splice(i, 1);
      save();
    },
  };
}

/**
 * db.c: append_file for do_bug, do_idea and do_typo, which kept three text
 * files (bugs.txt, ideas.txt, typos.txt); here one, reports.jsonl, a JSON line
 * to a report -- { kind, who, room, date, text } -- oldest first. A write that
 * fails throws, and the command that asked reports it.
 */
export function createReports(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'reports.jsonl');
  return {
    path,
    add(report) { appendFileSync(path, `${JSON.stringify(report)}\n`, { mode: 0o600 }); },
  };
}

/**
 * An IPv4 or IPv6 address as one 128-bit number. IPv4 and IPv4-mapped IPv6
 * (::ffff:a.b.c.d) are the same address, so both land in ::ffff:0:0/96.
 * Returns null for anything else.
 */
export function addrBits(text) {
  let t = String(text).trim().toLowerCase();
  const v4 = (a) => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
    if (!m || m.slice(1).some((o) => +o > 255)) return null;
    return m.slice(1).reduce((n, o) => (n << 8n) | BigInt(o), 0n);
  };
  const plain = v4(t);
  if (plain !== null) return (0xffffn << 32n) | plain;
  let tail = [];
  const dot = t.lastIndexOf(':');
  if (t.includes('.')) {
    const n = v4(t.slice(dot + 1));
    if (n === null) return null;
    tail = [(n >> 16n).toString(16), (n & 0xffffn).toString(16)];
    t = t.slice(0, dot + 1) + '0:0';
  }
  const halves = t.split('::');
  if (halves.length > 2) return null;
  const part = (h) => (h === '' ? [] : h.split(':'));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  } else groups = head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  if (tail.length) { groups[6] = tail[0]; groups[7] = tail[1]; }
  return groups.reduce((n, g) => (n << 16n) | BigInt(`0x${g}`), 0n);
}

/** `site` (an address or addr/len) as { bits, len } over 128 bits, or null when it is neither. */
export function parseSite(site) {
  const [addr, lenText, extra] = String(site).split('/');
  if (extra !== undefined) return null;
  const bits = addrBits(addr);
  if (bits === null) return null;
  const v4 = !addr.includes(':');
  if (lenText === undefined) return { bits, len: 128 };
  if (!/^\d{1,3}$/.test(lenText) || +lenText > (v4 ? 32 : 128)) return null;
  return { bits, len: v4 ? 96 + +lenText : +lenText };
}

/** Whether the address `bits` lies under `p` (parseSite's { bits, len }). */
export const underSite = (bits, p) => (bits >> BigInt(128 - p.len)) === (p.bits >> BigInt(128 - p.len));

/**
 * The site: banned addresses and prefixes, and the wizlock. `log` hears,
 * once at boot, of a ban in the file that is no address or prefix.
 */
export function createSite(dataDir, { wizlock = false, log = console.log } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, 'site.json');
  const file = jsonFile(path, () => ({ version: 1, wizlock, bans: [] }));
  const data = file.read();
  if (data.version !== 1 || !Array.isArray(data.bans)) throw new Error(`${path}: not a version 1 site file`);
  const save = () => file.write(data);
  // A file written when a ban was a suffix of the host string may hold one that
  // is no address; it still boots, and that ban holds only its own exact text.
  for (const ban of data.bans) if (!parseSite(ban)) log(`${path}: ban ${JSON.stringify(ban)} is no address or prefix; it matches only that exact host`);
  return {
    get wizlock() { return !!data.wizlock; },
    set wizlock(on) { data.wizlock = !!on; save(); },
    bans: () => data.bans,
    /**
     * comm.c: new_descriptor's check, by address: a ban is an address or a
     * CIDR prefix, matched by its bits. Merc matched a suffix of the host
     * string, so banning 1.2.3.4 also banned 11.2.3.4.
     */
    banned(host) {
      const bits = addrBits(host);
      return data.bans.some((ban) => {
        const p = parseSite(ban);
        return p ? bits !== null && underSite(bits, p) : ban === String(host);
      });
    },
    ban(site) { data.bans.unshift(site); save(); },
    allow(site) {
      const i = data.bans.findIndex((ban) => ban.toLowerCase() === site.toLowerCase());
      if (i < 0) return false;
      data.bans.splice(i, 1);
      save();
      return true;
    },
  };
}
