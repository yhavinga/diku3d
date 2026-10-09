/**
 * db.c's reset_area and area_update, update.c's obj_update, and the state of
 * every door: what makes the world come back after you have been through it.
 *
 * Merc's model is kept: an exit's flags (EX_CLOSED, EX_LOCKED) live on the
 * exit itself, both sides of a door are set together, and the reset table is
 * replayed per area on its own clock. The viewer's hinges (actors.js `doors`)
 * are only told what the exits say.
 */

import { ITEM, EX_ISDOOR, EX_CLOSED, EX_LOCKED, REVERSE_DIR, DIR_NAME } from '../are.js';
import { capitalise, doorName, makeObject } from './handler.js';

const ROOM_VNUM_SCHOOL = 3700;

const strHash = (s, salt = 0) => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
};

/**
 * Where the reset table's object `index` in a room lies: the formula actors.js
 * has always used for the scenery it draws, so a fountain the game knows about
 * is the fountain on the screen. Exported for actors.js to share.
 */
export function resetSpot(proto, index, center) {
  const angle = strHash(proto.keywords, index + 3) * Math.PI * 2;
  const radius = proto.itemType === ITEM.FOUNTAIN ? 0 : 2.4 + strHash(proto.short, index) * 2.4;
  return { x: center.x + Math.cos(angle) * radius, y: center.y, z: center.z + Math.sin(angle) * radius };
}

/** How far across a piece of scenery is, so "within reach" means its edge. */
const SCENERY_RADIUS = { [ITEM.FOUNTAIN]: 1.7, [ITEM.FURNITURE]: 0.9, [ITEM.CONTAINER]: 0.6, [ITEM.BOAT]: 1.2 };

export function installWorld(k) {
  const { world, ground, mobs, emit, game, rules } = k;
  // The drawn zone's hinges -- only that zone has any.
  const hinges = () => (k.actors ? k.actors.doors : null);

  // ------------------------------------------------------------- doors ----

  /** The viewer's hinges on this exit, either side of it. */
  function hingesOf(vnum, dir) {
    const doors = hinges();
    if (!doors) return [];
    const exit = world.rooms.get(vnum)?.exits[dir];
    const back = REVERSE_DIR[dir];
    return doors.filter((d) => (d.spec.room === vnum && d.spec.dir === dir)
      || (exit && d.spec.room === exit.to && d.spec.dir === back));
  }

  /** Tell the hinges what the exit now says, and let the world hear it. */
  function syncDoor(vnum, dir, sound) {
    const exit = world.rooms.get(vnum)?.exits[dir];
    if (!exit) return;
    for (const door of hingesOf(vnum, dir)) {
      // A lid's face (actors.js `lidOf`) takes this word as its own; the lid
      // is open while every face says so.
      door.open = !(exit.locks & EX_CLOSED);
      door.spec.closed = !(exit.locks & EX_CLOSED);
      door.spec.locked = !!(exit.locks & EX_LOCKED);
      // A lid seen from the room it has no leaf in is the same lid: one sound.
      if (sound && !door.spec.leafless) {
        emit({
          kind: 'door-sound', sound, x: door.spec.x, y: door.spec.y + 1.4, z: door.spec.z,
          text: '',
        });
      }
    }
  }

  /**
   * SET_BIT/REMOVE_BIT on an exit and, as do_open and friends all do, on the
   * way back through it -- then the hinges.
   */
  function setExitFlags(vnum, dir, set, clear, sound) {
    const room = world.rooms.get(vnum);
    const exit = room && room.exits[dir];
    if (!exit) throw new Error(`setExitFlags: #${vnum} has no exit ${DIR_NAME[dir]}`);
    exit.locks = (exit.locks | set) & ~clear;
    const back = world.rooms.get(exit.to)?.exits[REVERSE_DIR[dir]];
    if (back && back.to === vnum) back.locks = (back.locks | set) & ~clear;
    syncDoor(vnum, dir, sound);
  }

  /** The G key: every lock in the world gives way. The debug switch it has always been. */
  function forceLocks() {
    for (const room of world.rooms.values()) {
      for (const exit of room.exits) if (exit) exit.locks &= ~EX_LOCKED;
    }
    const doors = hinges();
    if (doors) for (const door of doors) { door.spec.locked = false; door.forced = true; }
  }

  // ---------------------------------------------------- reset objects ----

  /**
   * The reset table's own objects, now real ones: what actors.js draws as
   * scenery (the fountain, the donation pit) is here to drink from and put
   * things into, and what can be carried is drawn by items.js and carried off.
   */
  function placeReset(obj, vnum, index) {
    obj.radius = SCENERY_RADIUS[obj.itemType] && !(obj.wearFlags & 1) ? SCENERY_RADIUS[obj.itemType] : 0;
    obj.resetIndex = index;
    const info = k.built.rooms.get(vnum);
    // A room the drawn zone did not build: the object is in it, and is given
    // a place on the floor when a zone holding it is drawn (see below).
    if (!info) {
      const placed = k.objToRoom(obj, vnum, { x: k.FAR, y: 0, z: k.FAR });
      placed.unplaced = true;
      return placed;
    }
    return k.objToRoom(obj, vnum, spotFor(obj, info));
  }

  /** Where a reset object lies in a built room. */
  function spotFor(obj, info) {
    const ways = k.ways;
    let at = resetSpot(obj.proto, obj.resetIndex || 0, info.center);
    // Scenery stays exactly where actors.js stood it. A thing you can pick up
    // is put down where a foot could reach it, not inside the bar.
    if ((obj.wearFlags & 1) && ways.sample && ways.nearestOpen) {
      const level = ways.levelOf ? ways.levelOf(at.y) : 0;
      if (!ways.sample(at.x, at.z, level)) {
        const open = ways.nearestOpen(level, at.x, at.z, 4);
        if (open) at = { x: (open[0] + 0.5) * ways.NAV_RES, y: at.y, z: (open[1] + 0.5) * ways.NAV_RES };
      }
    }
    return at;
  }

  /**
   * On entering a zone: what the mud put down in its rooms while nobody had
   * built them gets a place on the floor, and every hinge is told what its
   * exit says now -- the mayor may have opened the gates while you were away.
   */
  k.zoneHooks.push(() => {
    for (const obj of ground) {
      if (!obj.unplaced) continue;
      const info = k.built.rooms.get(obj.inRoom);
      if (!info) continue;
      obj.at = obj.resetIndex !== undefined ? spotFor(obj, info) : k.ringSpot(obj.inRoom, ground.indexOf(obj) % 7, 7);
      obj.unplaced = false;
    }
    for (const door of hinges() || []) {
      const exit = world.rooms.get(door.spec.room)?.exits[door.spec.dir];
      if (!exit) continue;
      door.open = !(exit.locks & EX_CLOSED);
      door.spec.closed = !(exit.locks & EX_CLOSED);
      door.spec.locked = !!(exit.locks & EX_LOCKED);
    }
  });

  // ------------------------------------------------------------ areas ----

  /**
   * Per area: its reset list, and the M lines paired with the bodies that
   * actors.js built for them. buildWorld pushed every M line's record onto its
   * room in reset order, so replaying the same walk pairs them back up.
   */
  const slotOf = new Map(mobs.map((slot) => [slot.record, slot]));
  const areas = [];
  for (const area of world.areas) {
    const perRoom = new Map();
    const lines = area.resets.map((reset) => {
      const line = { ...reset };
      if (reset.command === 'M') {
        const room = world.rooms.get(reset.arg3);
        if (room && world.mobProtos.get(reset.arg1)) {
          const n = perRoom.get(room.vnum) || 0;
          perRoom.set(room.vnum, n + 1);
          line.slot = slotOf.get(room.mobs[n]) || null;
        }
      }
      if (reset.command === 'O') {
        const room = world.rooms.get(reset.arg3);
        if (room) {
          const n = perRoom.get(`o${room.vnum}`) || 0;
          perRoom.set(`o${room.vnum}`, n + 1);
          line.index = n;
        }
      }
      return line;
    });
    areas.push({ name: area.name, file: area.file, lines, age: 0 });
  }
  // Where each line's body stands when it is reset. Off the drawn zone that is
  // only a room; game.js's enterZone fills in the spot when it is drawn.
  for (const slot of mobs) {
    if (!slot.origin) slot.origin = { ...slot.anchor };
    if (slot.originRoom === undefined) slot.originRoom = slot.roomVnum;
  }

  const areaOf = (vnum) => world.rooms.get(vnum)?.area;
  const playersIn = (area) => k.players.filter((pc) => areaOf(pc.ch.roomVnum) === area.name);

  /** pIndexData->count: the living mobiles of a prototype. */
  const countMob = (vnum) => mobs.reduce((n, s) => n + (!s.dead && s.proto.vnum === vnum ? 1 : 0), 0);
  const countIn = (vnum, list) => list.reduce((n, o) => n + (o.vnum === vnum ? 1 : 0), 0);

  /**
   * db.c: reset_area. Its rolls (an object's level) come from the world's own
   * generator, not the one fights are rolled from, for the weather's reason in
   * game.js. DIVERGES in one place: a mobile comes back into the
   * body that its own M line put in the world at boot, so a line refills only
   * when that one is dead -- and its corpse gone, because the body is the
   * corpse -- rather than whenever the prototype's count is under the limit.
   * The limit is still checked, so nothing ever exceeds what Merc would allow.
   */
  function resetArea(area) {
    let last = true;
    let level = 0;
    const occupied = playersIn(area).length > 0;
    for (const line of area.lines) {
      switch (line.command) {
        case 'M': {
          const proto = world.mobProtos.get(line.arg1);
          if (!proto) { last = false; break; }
          level = Math.max(0, Math.min(proto.level - 2, 36));
          const slot = line.slot;
          if (!slot || !slot.dead || slot.corpse || countMob(proto.vnum) >= line.arg2) { last = false; break; }
          respawn(slot);
          level = Math.max(0, Math.min(slot.instance.level - 2, 36));
          last = true;
          break;
        }
        case 'O': {
          const proto = world.objProtos.get(line.arg1);
          const room = world.rooms.get(line.arg3);
          if (!proto || !room) { last = false; break; }
          if (occupied || countIn(proto.vnum, ground.filter((o) => o.inRoom === room.vnum)) > 0) { last = false; break; }
          const obj = k.game.MERC.createObject(proto, k.wanderRng.fuzzy(level));
          obj.cost = 0;
          placeReset(obj, room.vnum, line.index || 0);
          last = true;
          break;
        }
        case 'P': {
          const proto = world.objProtos.get(line.arg1);
          if (!proto) { last = false; break; }
          const to = ground.find((o) => o.vnum === line.arg3);
          if (occupied || !to || countIn(proto.vnum, to.contains) > 0) { last = false; break; }
          to.contains.push(k.game.MERC.createObject(proto, k.wanderRng.fuzzy(to.level)));
          last = true;
          break;
        }
        case 'G': case 'E':
          // The gear rides on the M line's record: wake() dresses a new body
          // from it, shop stock and all.
          break;
        case 'D': {
          const room = world.rooms.get(line.arg1);
          const exit = room && room.exits[line.arg2];
          if (!exit) break;
          const was = exit.locks;
          if (line.arg3 === 0) exit.locks &= ~(EX_CLOSED | EX_LOCKED);
          else if (line.arg3 === 1) exit.locks = (exit.locks | EX_CLOSED) & ~EX_LOCKED;
          else exit.locks |= EX_CLOSED | EX_LOCKED;
          if (exit.locks !== was) syncDoor(room.vnum, line.arg2, (exit.locks & EX_CLOSED) !== (was & EX_CLOSED) ? ((exit.locks & EX_CLOSED) ? 'close' : 'open') : null);
          last = true;
          break;
        }
        default: break;
      }
    }
    void last;
    emit({ kind: 'reset', area: area.name, text: '' });
  }

  /**
   * db.c: area_update -- an area ages a minute a PULSE_AREA; with nobody in
   * it, it resets from three minutes on, and with you in it, at fifteen, with
   * a warning a minute before. Mud School resets every three, as the mud's
   * own special case says.
   */
  function areaUpdate() {
    for (const area of areas) {
      if (++area.age < 3) continue;
      const inside = playersIn(area);
      const occupied = inside.length > 0;
      for (const pc of inside) {
        if (area.age === 14 && pc.ch.position > 4) k.withPlayer(pc, () => emit({ kind: 'note', text: 'You hear the patter of little feet.' }));
      }
      if (!occupied || area.age >= 15) {
        resetArea(area);
        area.age = k.wanderRng.range(0, 3);
        if (areaOf(ROOM_VNUM_SCHOOL) === area.name) area.age = 15 - 3;
      }
    }
  }

  // ---------------------------------------------------------- respawn ----

  /**
   * create_mobile and char_to_room for a line whose mobile is dead: the same
   * body, fresh stats, and -- in the viewer -- walking in off the street
   * through one of the room's ways in, rather than appearing at its post.
   */
  function respawn(slot) {
    const home = slot.originRoom;
    slot.dead = false;
    slot.corpse = null;
    slot.instance = null;
    slot.travel = null;
    slot.task = null;
    slot.notice = null;
    slot.roomVnum = home;
    if (!slot.here) {
      // Nobody is drawing its zone: back in its room, and that is all.
      k.wake(slot, k.wanderRng);
      emit({ kind: 'respawn', slot, text: '' });
      return;
    }
    slot.anchor = { ...slot.origin };
    const entry = entryPoint(home, slot.origin) || slot.origin;
    slot.pos = { ...entry };
    k.wake(slot, k.wanderRng);
    if (k.actors && k.actors.respawn) k.actors.respawn(slot.figure, entry);
    if (entry !== slot.origin) slot.task = { kind: 'arrive', order: { kind: 'go', to: { ...slot.origin } } };
    emit({ kind: 'respawn', slot, text: '' });
  }

  /** Part way down one of the room's routed ways in: somewhere to walk in from. */
  function entryPoint(vnum, origin) {
    const room = world.rooms.get(vnum);
    const { ways, built } = k;
    if (!room || !ways.route) return null;
    const doorsOut = [0, 1, 2, 3, 4, 5].filter((d) => {
      const exit = room.exits[d];
      return exit && !exit.offMap && built.rooms.has(exit.to) && !built.rooms.get(exit.to).unbuilt
        && !(exit.locks & EX_CLOSED);
    });
    for (let tries = 0; tries < doorsOut.length; tries++) {
      const dir = doorsOut[k.wanderRng.range(0, doorsOut.length - 1)];
      const route = ways.route(vnum, dir, room.exits[dir].to, origin, () => k.wanderRng.raw() / 0x80000000);
      if (!route || route.portal || !route.points || !route.points.length) continue;
      // Nine metres back along the way out, or most of it if it is shorter:
      // out in the street or the doorway, somewhere to be seen coming from.
      const line = [origin, ...route.points];
      let total = 0;
      for (let i = 1; i < line.length; i++) total += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
      let want = Math.min(9, total * 0.6);
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1];
        const b = line[i];
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        if (d >= want && d > 0) return { x: a.x + (b.x - a.x) * (want / d), y: origin.y, z: a.z + (b.z - a.z) * (want / d) };
        want -= d;
      }
    }
    return null;
  }

  // -------------------------------------------------------- obj_update ----

  const DECAY = {
    [ITEM.FOUNTAIN]: 'dries up.', [ITEM.CORPSE_NPC]: 'decays into dust.',
    [ITEM.CORPSE_PC]: 'decays into dust.', [ITEM.FOOD]: 'decomposes.',
  };

  /**
   * update.c: obj_update -- every object with a timer loses a tick, and at
   * zero it goes, with the message for its kind.
   *
   * DIVERGES: extract_obj in 2.1 takes a corpse's contents with it. Here they
   * spill onto the floor where it lay: in the mud you would have typed `get
   * all corpse` already; here you may still be walking over, and the gear on
   * a body you fought for is the reason you fought.
   */
  function objUpdate() {
    const timed = [];
    const walk = (list, where) => {
      for (const obj of list) {
        if (obj.timer > 0) timed.push({ obj, where, list });
        if (obj.contains && obj.contains.length) walk(obj.contains, where);
      }
    };
    walk(ground, 'room');
    // What each player carries: `where` is whose it is.
    for (const pc of k.players) {
      walk(pc.ch.inventory, pc);
      walk(pc.ch.equipment.filter(Boolean), pc);
    }
    for (const { obj, where, list } of timed) {
      if (--obj.timer > 0) continue;
      const text = `${capitalise(obj.name)} ${DECAY[obj.itemType] || 'vanishes.'}`;
      if (where !== 'room') {
        k.withPlayer(where, () => {
          emit({ kind: 'note', text });
          extract(obj, list, where.ch);
        });
        continue;
      }
      if (obj.inRoom !== null) k.toRoom(obj, text, { kind: 'decay', item: obj.name });
      extract(obj, list);
    }
  }

  /** handler.c: extract_obj, wherever the thing is (`owner` if carried). */
  function extract(obj, list, owner = k.state) {
    if (obj.inRoom !== null && obj.inRoom !== undefined) {
      const at = obj.at;
      const vnum = obj.inRoom;
      k.objFromRoom(obj);
      if (obj.slot) k.removeBody(obj.slot);
      if (obj.itemType === ITEM.CORPSE_NPC || obj.itemType === ITEM.CORPSE_PC) {
        obj.contains.forEach((inner, i) => {
          const a = (i / Math.max(1, obj.contains.length)) * Math.PI * 2;
          k.objToRoom(inner, vnum, { x: at.x + Math.cos(a) * 0.45, y: at.y, z: at.z + Math.sin(a) * 0.45 });
        });
        obj.contains = [];
      }
      if (obj.slot) obj.slot.corpse = null;
      return;
    }
    const i = list.indexOf(obj);
    if (i >= 0) list.splice(i, 1);
    const worn = owner.equipment.indexOf(obj);
    if (worn >= 0) k.unequipChar(owner, obj);
  }

  // ------------------------------------------------------------- boot ----

  // boot_db ends with area_update(): every area resets once, empty. The M
  // lines are already standing (actors.js built them); this lays out the
  // objects and sets the doors.
  for (const area of areas) resetArea(area);

  rules.areaUpdate = areaUpdate;
  rules.objUpdate = objUpdate;

  Object.assign(k, { setExitFlags, syncDoor, hingesOf, resetArea, areas, extract, respawn });
  Object.assign(game, {
    areas,
    /** Reset an area now, by name (or the one you stand in): the debug path to a repopulation. */
    resetArea(name) {
      const area = areas.find((a) => a.name === (name || areaOf(k.state.roomVnum)));
      if (!area) throw new Error(`resetArea: no area ${JSON.stringify(name)}`);
      resetArea(area);
      return area.name;
    },
    forceLocks,
    exitFlags(vnum, dir) { return world.rooms.get(vnum)?.exits[dir]?.locks ?? 0; },
    doorName,
    isDoor: (vnum, dir) => !!((world.rooms.get(vnum)?.exits[dir]?.locks ?? 0) & EX_ISDOOR),
  });
  void makeObject;
}
