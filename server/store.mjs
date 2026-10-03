/**
 * What the mud keeps beside the player files, under the same data
 * directory: the note board (Merc's notes.txt) and the site's own settings
 * -- the ban list and the wizlock, which 2.1 held in memory and lost at
 * every reboot. Each is one JSON file, written whole and renamed into
 * place, as accounts.mjs writes a player.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
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
    post(note) { data.notes.push({ sender: note.sender, date: note.date, to: note.to, subject: note.subject, text: note.text }); save(); },
    update(note, change) { Object.assign(note, change); save(); },
    remove(note) {
      const i = data.notes.indexOf(note);
      if (i < 0) throw new Error('notes: removing a note that is not on the board');
      data.notes.splice(i, 1);
      save();
    },
  };
}

/** The site: banned host suffixes and the wizlock. */
export function createSite(dataDir, { wizlock = false } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const file = jsonFile(join(dataDir, 'site.json'), () => ({ version: 1, wizlock, bans: [] }));
  const data = file.read();
  if (data.version !== 1 || !Array.isArray(data.bans)) throw new Error(`${join(dataDir, 'site.json')}: not a version 1 site file`);
  const save = () => file.write(data);
  return {
    get wizlock() { return !!data.wizlock; },
    set wizlock(on) { data.wizlock = !!on; save(); },
    bans: () => data.bans,
    /** comm.c: new_descriptor's check -- a ban is a suffix of the host, any case. */
    banned: (host) => data.bans.some((ban) => String(host).toLowerCase().endsWith(ban.toLowerCase())),
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
