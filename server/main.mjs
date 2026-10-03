#!/usr/bin/env node
/**
 * The diku3d game server.
 *
 *     cd server && npm ci
 *     node main.mjs [--port 4011] [--host 127.0.0.1] [--data ./data] [--seed N]
 *
 * Players connect from the page's title screen ("connect to a server",
 * host:port). Their files are kept under --data (default server/data/,
 * which git ignores), one per name, the password scrypt-hashed.
 *
 *     node main.mjs --make-implementor <name> [--class warrior] [--sex m]
 *
 * makes <name> the implementor -- level 40, Merc 2.1's MAX_LEVEL, with
 * every command in act_wiz.c this server carries -- creating the character
 * if there is none. It asks for the password on the terminal and never
 * takes it from the command line or the environment.
 */

import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { createCharacter, advanceLevel, CLASS_TABLE, Rng } from '../src/game.js';
import { serialize } from '../src/save.js';
import { titleFor } from '../src/rules/actcomm.js';
import { bootWorld } from './world.mjs';
import { createAccounts, hashPassword, checkParseName, properName } from './accounts.mjs';
import { startMud } from './mud.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function parseArgs(argv) {
  const args = { port: 4011, host: '127.0.0.1', data: join(here, 'data'), seed: undefined, implementor: null, cls: 'warrior', sex: 'm' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--port') args.port = Number(next());
    else if (a === '--host') args.host = next();
    else if (a === '--data') args.data = resolve(next());
    else if (a === '--seed') args.seed = Number(next());
    else if (a === '--make-implementor') args.implementor = next();
    else if (a === '--class') args.cls = next();
    else if (a === '--sex') args.sex = next();
    else if (a === '--help' || a === '-h') { console.log(readUsage()); process.exit(0); }
    else throw new Error(`unknown argument ${a} (try --help)`);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error(`--port ${args.port} is not a port`);
  return args;
}

const readUsage = () => [
  'node main.mjs [--port 4011] [--host 127.0.0.1] [--data DIR] [--seed N]',
  'node main.mjs --make-implementor NAME [--class mage|cleric|thief|warrior] [--sex m|f|n] [--data DIR]',
].join('\n');

/** A line from the terminal with nothing echoed. */
function askHidden(prompt) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) throw new Error('--make-implementor asks for the password on a terminal; stdin is not one');
  return new Promise((resolvePrompt, reject) => {
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let line = '';
    const done = (fn) => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n'); fn(); };
    function onData(chunk) {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return done(() => resolvePrompt(line));
        if (c === '\u0003') return done(() => reject(new Error('interrupted')));
        if (c === '\u007f' || c === '\b') line = line.slice(0, -1);
        else if (c >= ' ') line += c;
      }
    }
    stdin.on('data', onData);
  });
}

async function makeImplementor({ data, implementor, cls, sex }) {
  const w = bootWorld(root);
  const name = properName(implementor);
  if (!checkParseName(name, w.world)) throw new Error(`${name}: not a name Merc allows (3-12 letters, not a mobile's)`);
  const accounts = createAccounts(data);
  const existing = accounts.load(name);
  let password = await askHidden(existing ? `Password for ${name} (empty keeps the current one): ` : `Give me a password for ${name}: `);
  if (password || !existing) {
    if (password.length < 5) throw new Error('Password must be at least five characters long.');
    if ((await askHidden('Please retype password: ')) !== password) throw new Error("Passwords don't match.");
  }
  const MAX_LEVEL = 40;
  let record = existing;
  if (!record) {
    const classIndex = CLASS_TABLE.findIndex((c) => c.name === cls || c.who.toLowerCase() === cls.toLowerCase().slice(0, 3));
    if (classIndex < 0) throw new Error(`--class ${cls}: one of ${CLASS_TABLE.map((c) => c.name).join(', ')}`);
    const rng = new Rng();
    const ch = createCharacter(classIndex, { level: 36, sex: { m: 1, f: 2, n: 0 }[sex[0]] ?? 1, rng });
    // createCharacter stops at LEVEL_HERO; do_advance goes on to 40.
    while (ch.level < MAX_LEVEL) { ch.level += 1; advanceLevel(ch, rng); }
    ch.hit = ch.maxHit; ch.mana = ch.maxMana; ch.move = ch.maxMove;
    ch.exp = 1000 * ch.level;
    ch.name = name;
    ch.displayName = name;
    record = { version: 1, name, created: new Date().toISOString(), char: { ...serialize(ch), room: 3001, title: titleFor(ch), played: 0 } };
  } else {
    record.char.level = MAX_LEVEL;
    record.char.exp = Math.max(record.char.exp, 1000 * MAX_LEVEL);
    record.char.title = titleFor({ class: record.char.class, level: MAX_LEVEL, sex: record.char.sex });
  }
  record.char.trust = MAX_LEVEL;
  if (password) record.password = await hashPassword(password);
  accounts.store(record);
  console.log(`${name} is the implementor (level ${MAX_LEVEL}), in ${accounts.dir}.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.implementor) return makeImplementor(args);
  const mud = await startMud({
    root, dataDir: args.data, port: args.port, host: args.host, seed: args.seed,
    log: (text) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`),
  });
  mud.onClose = () => process.exit(0);
  const stop = () => { mud.close(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return undefined;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
