// Player files for the promo's party, written straight into a server's data
// directory (as tools/judge/headless/mp-seed.mjs does for the judges).
//   node tools/promo/mp-seed.mjs <data dir> [room]
// Beorn (warrior, the camera's player), Kestrel (cleric), Thorne (warrior),
// Wren (thief), Mordecai (mage); all level 30, password "promo1993".
import { createAccounts, hashPassword } from '../../server/accounts.mjs';
import { serialize } from '../../src/save.js';
import { createCharacter, advanceLevel, createObject, Rng, SKILLS } from '../../src/game.js';
import { SPELL_SKILLS } from '../../src/magic.js';
import { parseArea, buildWorld } from '../../src/are.js';
import { readFileSync } from 'node:fs';
import { titleFor } from '../../src/rules/actcomm.js';

const accounts = createAccounts(process.argv[2]);
const room = Number(process.argv[3] || 3005);
const rng = new Rng(1993);
const CLASS = { mage: 0, cleric: 1, thief: 2, warrior: 3 };
const midgaard = new URL('../../merc21/area/midgaard.are', import.meta.url);
const world = buildWorld([parseArea(readFileSync(midgaard, 'latin1'), 'midgaard.are')]);
// What each one carries in hand: the figure is dressed from the wielded
// weapon and the shield (actors.js createPlayerFigure). Slots 16 and 11.
const KIT = { warrior: { 16: 3022, 11: 3097 }, thief: { 16: 3020 }, mage: { 16: 3020 }, cleric: { 16: 3021, 11: 3097 } };
async function make(name, cls, sex, level) {
  const ch = createCharacter(CLASS[cls], { level: 1, sex, rng });
  while (ch.level < level) { ch.level += 1; advanceLevel(ch, rng); }
  ch.hit = ch.maxHit; ch.mana = ch.maxMana; ch.move = ch.maxMove;
  ch.name = name; ch.displayName = name;
  ch.gold = 1200;
  // Practised: a level-30 character who still fumbles every spell is not the
  // party anyone remembers.
  for (const skill of SKILLS.concat(SPELL_SKILLS)) if (skill.level[CLASS[cls]] <= level) ch.learned[skill.key] = 90;
  for (const [slot, vnum] of Object.entries(KIT[cls])) {
    const obj = createObject(world.objProtos.get(vnum), level);
    obj.wearLoc = Number(slot);
    ch.equipment[slot] = obj;
  }
  accounts.store({ version: 1, name, created: 'promo', password: await hashPassword('promo1993'),
    char: { ...serialize(ch), room, title: titleFor(ch), played: 400000 } });
  console.log(`${name}: ${cls} level ${level} in #${room}`);
}
await make('Beorn', 'warrior', 1, 30);
await make('Kestrel', 'cleric', 2, 30);
await make('Thorne', 'warrior', 1, 30);
await make('Wren', 'thief', 2, 30);
await make('Mordecai', 'mage', 1, 30);
