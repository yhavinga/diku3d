// Write test player files straight into a server's data directory.
//   node tools/judge/headless/mp-seed.mjs <server data dir>  (Eomer, Theoden password1; Yeb password1, implementor)
import { createAccounts, hashPassword } from '../../../server/accounts.mjs';
import { serialize } from '../../../src/save.js';
import { createCharacter, advanceLevel, Rng } from '../../../src/game.js';
import { titleFor } from '../../../src/rules/actcomm.js';
const accounts = createAccounts(process.argv[2]);
const rng = new Rng(11);
async function make(name, cls, level, extra = {}) {
  const ch = createCharacter(cls, { level: Math.min(level, 36), sex: 1, rng });
  while (ch.level < level) { ch.level += 1; advanceLevel(ch, rng); }
  ch.hit = ch.maxHit; ch.name = name; ch.displayName = name;
  accounts.store({ version: 1, name, created: 'seed', password: await hashPassword('password1'),
    char: { ...serialize(ch), room: 3122, title: titleFor(ch), played: 0, ...extra } });
  console.log(`${name}: level ${level}, ${extra.played || 0} s played`);
}
await make('Eomer', 3, 5, { played: 30000 });
await make('Theoden', 3, 9);
await make('Yeb', 1, 40, { trust: 40, room: 3001 });
