/**
 * Reader for the DikuMUD / Merc 2.1 area file format.
 *
 * Mirrors db.c: fread_word / fread_string / fread_number / fread_letter, including
 * the '|' bitvector syntax used for room and object flags. Anything the format
 * throws at us that we don't understand is a hard error with a vnum for context --
 * a silently skipped record shows up much later as a hole in the world.
 */

export const DIR_NAME = ['north', 'east', 'south', 'west', 'up', 'down'];
export const DIR_SHORT = ['N', 'E', 'S', 'W', 'U', 'D'];
/** Grid step per direction, in cell units: [dx, dlevel, dz]. North is -Z. */
export const DIR_STEP = [
  [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
];
export const REVERSE_DIR = [2, 3, 0, 1, 5, 4];

export const SECTOR = {
  INSIDE: 0, CITY: 1, FIELD: 2, FOREST: 3, HILLS: 4, MOUNTAIN: 5,
  WATER_SWIM: 6, WATER_NOSWIM: 7, UNUSED: 8, AIR: 9, DESERT: 10,
};
export const SECTOR_NAME = [
  'inside', 'city', 'field', 'forest', 'hills', 'mountain',
  'shallow water', 'deep water', 'unused', 'air', 'desert',
];

export const ROOM_DARK = 1, ROOM_NO_MOB = 4, ROOM_INDOORS = 8;
export const ROOM_PRIVATE = 512, ROOM_SAFE = 1024, ROOM_SOLITARY = 2048;
export const ROOM_PET_SHOP = 4096, ROOM_NO_RECALL = 8192;

export const EX_ISDOOR = 1, EX_CLOSED = 2, EX_LOCKED = 4, EX_PICKPROOF = 32;

export const ACT_SENTINEL = 2, ACT_SCAVENGER = 4, ACT_AGGRESSIVE = 32;
export const ACT_TRAIN = 512, ACT_PRACTICE = 1024;

export const ITEM = {
  LIGHT: 1, SCROLL: 2, WAND: 3, STAFF: 4, WEAPON: 5, TREASURE: 8, ARMOR: 9,
  POTION: 10, FURNITURE: 12, TRASH: 13, CONTAINER: 15, DRINK_CON: 17, KEY: 18,
  FOOD: 19, MONEY: 20, BOAT: 22, CORPSE_NPC: 23, CORPSE_PC: 24, FOUNTAIN: 25,
  PILL: 26,
};

class Reader {
  constructor(text, file) {
    this.s = text;
    this.i = 0;
    this.file = file;
  }

  fail(msg) {
    const line = this.s.slice(0, this.i).split('\n').length;
    throw new Error(`${this.file}:${line}: ${msg}`);
  }

  skipSpace() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  eof() {
    this.skipSpace();
    return this.i >= this.s.length;
  }

  letter() {
    this.skipSpace();
    return this.s[this.i++];
  }

  /** Look at the next non-space character without consuming it. */
  peek() {
    this.skipSpace();
    return this.s[this.i];
  }

  word() {
    this.skipSpace();
    const start = this.i;
    while (this.i < this.s.length && !/\s/.test(this.s[this.i])) this.i++;
    return this.s.slice(start, this.i);
  }

  /** fread_string: everything up to the next '~', leading whitespace dropped. */
  string() {
    this.skipSpace();
    const end = this.s.indexOf('~', this.i);
    if (end < 0) this.fail('unterminated string');
    const out = this.s.slice(this.i, end);
    this.i = end + 1;
    return out.replace(/\r/g, '');
  }

  /** fread_number, including the `4|8|1024` bitvector form. */
  number() {
    this.skipSpace();
    const start = this.i;
    if (this.s[this.i] === '-' || this.s[this.i] === '+') this.i++;
    while (this.i < this.s.length && /[0-9]/.test(this.s[this.i])) this.i++;
    if (this.i === start) this.fail(`expected a number, got ${JSON.stringify(this.s.substr(this.i, 12))}`);
    let value = parseInt(this.s.slice(start, this.i), 10);
    if (this.s[this.i] === '|') {
      this.i++;
      value |= this.number();
    }
    return value;
  }

  toEol() {
    const end = this.s.indexOf('\n', this.i);
    this.i = end < 0 ? this.s.length : end + 1;
  }

  /** `#3001` -> 3001. `#$` and section headers are handled by the caller. */
  vnumHeader() {
    const w = this.word();
    if (w[0] !== '#') this.fail(`expected a '#vnum', got ${JSON.stringify(w)}`);
    return w;
  }
}

function parseDice(text) {
  const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(text);
  if (!m) return { number: 0, type: 0, bonus: parseInt(text, 10) || 0 };
  return { number: +m[1], type: +m[2], bonus: m[3] ? +m[3] : 0 };
}

function loadMobiles(r, area) {
  for (;;) {
    const tag = r.vnumHeader();
    if (tag === '#0') return;
    const vnum = parseInt(tag.slice(1), 10);
    const mob = {
      vnum, area: area.name,
      keywords: r.string(),
      short: r.string(),
      long: r.string().trim(),
      description: r.string(),
      act: r.number(),
      affected: r.number(),
      alignment: r.number(),
    };
    const kind = r.letter();
    if (kind !== 'S') r.fail(`mob ${vnum}: expected simple-mob 'S', got ${JSON.stringify(kind)}`);
    mob.level = r.number();
    mob.hitroll = r.number();
    mob.ac = r.number();
    mob.hitDice = parseDice(r.word());
    mob.damDice = parseDice(r.word());
    mob.gold = r.number();
    mob.exp = r.number();
    mob.position = r.number();
    mob.startPosition = r.number();
    mob.sex = r.number();
    area.mobiles.push(mob);
  }
}

function loadObjects(r, area) {
  for (;;) {
    const tag = r.vnumHeader();
    if (tag === '#0') return;
    const vnum = parseInt(tag.slice(1), 10);
    const obj = {
      vnum, area: area.name,
      keywords: r.string(),
      short: r.string(),
      long: r.string().trim(),
      action: r.string(),
      itemType: r.number(),
      extraFlags: r.number(),
      wearFlags: r.number(),
      values: [r.number(), r.number(), r.number(), r.number()],
      weight: r.number(),
      cost: r.number(),
      rent: r.number(),
      affects: [],
      extra: [],
    };
    for (;;) {
      const mark = r.i;
      const letter = r.letter();
      if (letter === 'A') {
        obj.affects.push({ location: r.number(), modifier: r.number() });
      } else if (letter === 'E') {
        obj.extra.push({ keyword: r.string(), description: r.string() });
      } else {
        r.i = mark;
        break;
      }
    }
    area.objects.push(obj);
  }
}

function loadRooms(r, area) {
  for (;;) {
    const tag = r.vnumHeader();
    if (tag === '#0') return;
    const vnum = parseInt(tag.slice(1), 10);
    const room = {
      vnum, area: area.name, areaFile: area.file,
      name: r.string(),
      description: r.string(),
      _areaNumber: r.number(),
      flags: r.number(),
      sector: r.number(),
      exits: new Array(6).fill(null),
      extra: [],
    };
    for (;;) {
      const letter = r.letter();
      if (letter === 'S') break;
      if (letter === 'D') {
        const dir = r.number();
        if (dir < 0 || dir > 5) r.fail(`room ${vnum}: bad direction ${dir}`);
        room.exits[dir] = {
          dir,
          description: r.string(),
          keyword: r.string(),
          locks: r.number(),
          key: r.number(),
          to: r.number(),
        };
      } else if (letter === 'E') {
        room.extra.push({ keyword: r.string(), description: r.string() });
      } else {
        r.fail(`room ${vnum}: unexpected record ${JSON.stringify(letter)}`);
      }
    }
    area.rooms.push(room);
  }
}

function loadResets(r, area) {
  for (;;) {
    const letter = r.letter();
    if (letter === 'S') return;
    if (letter === '*') { r.toEol(); continue; }
    const reset = { command: letter };
    r.number(); // if_flag: only matters to the live reset loop
    reset.arg1 = r.number();
    reset.arg2 = r.number();
    reset.arg3 = (letter === 'G' || letter === 'R') ? 0 : r.number();
    r.toEol();
    area.resets.push(reset);
  }
}

function loadShops(r, area) {
  for (;;) {
    const keeper = r.number();
    if (keeper === 0) { r.toEol(); return; }
    const shop = {
      keeper,
      buyType: [r.number(), r.number(), r.number(), r.number(), r.number()],
      profitBuy: r.number(),
      profitSell: r.number(),
      openHour: r.number(),
      closeHour: r.number(),
    };
    r.toEol();
    area.shops.push(shop);
  }
}

function loadSpecials(r, area) {
  for (;;) {
    const letter = r.letter();
    if (letter === 'S') return;
    if (letter === '*') { r.toEol(); continue; }
    if (letter !== 'M') r.fail(`bad #SPECIALS record ${JSON.stringify(letter)}`);
    area.specials.push({ vnum: r.number(), fn: r.word() });
    r.toEol();
  }
}

function loadHelps(r, area) {
  for (;;) {
    const level = r.number();
    const keyword = r.string();
    if (keyword[0] === '$') return;
    area.helps.push({ level, keyword, text: r.string() });
  }
}

/** Parse one .are file. */
export function parseArea(text, file) {
  const r = new Reader(text, file);
  const area = {
    file, name: file, credits: '',
    rooms: [], mobiles: [], objects: [], resets: [], shops: [], specials: [], helps: [],
  };

  while (!r.eof()) {
    const section = r.word();
    if (section === '#$') break;
    switch (section) {
      case '#AREA': area.credits = r.string(); area.name = areaTitle(area.credits, file); break;
      case '#MOBILES': loadMobiles(r, area); break;
      case '#OBJECTS': loadObjects(r, area); break;
      case '#ROOMS': loadRooms(r, area); break;
      case '#RESETS': loadResets(r, area); break;
      case '#SHOPS': loadShops(r, area); break;
      case '#SPECIALS': loadSpecials(r, area); break;
      case '#HELPS': loadHelps(r, area); break;
      default: r.fail(`unknown section ${JSON.stringify(section)}`);
    }
  }
  return area;
}

/** `{ All } Diku    Midgaard~` -> `Midgaard`: strip the level range and the author. */
function areaTitle(credits, file) {
  const withoutRange = credits.replace(/^\s*\{[^}]*\}\s*/, '');
  const words = withoutRange.trim().split(/\s{2,}/);
  const title = (words[words.length - 1] || '').trim();
  return title || file.replace(/\.are$/, '');
}

/**
 * Merge several parsed areas into one world, resolving resets into room contents.
 * Exits to rooms outside the loaded set are kept and flagged `offMap` -- the
 * builder turns those into sealed gates rather than pretending they aren't there.
 */
export function buildWorld(areas) {
  const rooms = new Map();
  const mobProtos = new Map();
  const objProtos = new Map();
  const shops = new Map();
  const specials = new Map();

  for (const area of areas) {
    for (const room of area.rooms) rooms.set(room.vnum, room);
    for (const mob of area.mobiles) mobProtos.set(mob.vnum, mob);
    for (const obj of area.objects) objProtos.set(obj.vnum, obj);
    for (const shop of area.shops) shops.set(shop.keeper, shop);
    for (const sp of area.specials) specials.set(sp.vnum, sp.fn);
  }

  for (const room of rooms.values()) {
    room.mobs = [];
    room.items = [];
    for (const exit of room.exits) {
      if (exit) exit.offMap = !rooms.has(exit.to);
    }
  }

  // Replay the reset table the way db.c does on boot: M sets the "current mob",
  // E/G hang gear off it, O drops objects in rooms, P nests them in containers.
  let lastMob = null;
  let lastObj = null;
  for (const area of areas) {
    for (const reset of area.resets) {
      switch (reset.command) {
        case 'M': {
          const proto = mobProtos.get(reset.arg1);
          const room = rooms.get(reset.arg3);
          if (!proto || !room) { lastMob = null; break; }
          lastMob = {
            proto, room, equipment: [], carried: [],
            shop: shops.get(proto.vnum) || null,
            special: specials.get(proto.vnum) || null,
          };
          room.mobs.push(lastMob);
          break;
        }
        case 'O': {
          const proto = objProtos.get(reset.arg1);
          const room = rooms.get(reset.arg3);
          if (!proto || !room) { lastObj = null; break; }
          lastObj = { proto, room, contents: [] };
          room.items.push(lastObj);
          break;
        }
        case 'P': {
          const proto = objProtos.get(reset.arg1);
          if (proto && lastObj) lastObj.contents.push({ proto });
          break;
        }
        case 'G': case 'E': {
          const proto = objProtos.get(reset.arg1);
          if (!proto || !lastMob) break;
          if (reset.command === 'E') lastMob.equipment.push({ proto, wearLoc: reset.arg3 });
          else lastMob.carried.push({ proto });
          break;
        }
        case 'D': {
          const room = rooms.get(reset.arg1);
          const exit = room && room.exits[reset.arg2];
          if (!exit) break;
          exit.locks = reset.arg3 === 0 ? (exit.locks & ~(EX_CLOSED | EX_LOCKED))
            : reset.arg3 === 1 ? ((exit.locks | EX_ISDOOR | EX_CLOSED) & ~EX_LOCKED)
              : (exit.locks | EX_ISDOOR | EX_CLOSED | EX_LOCKED);
          break;
        }
        case 'R': break; // exit randomiser: nothing to draw
        default: break;
      }
    }
  }

  return { areas, rooms, mobProtos, objProtos, shops, specials };
}
