/**
 * A terminal player's body. On this server a room changes when a body walks
 * into it (game.js `playerFrame` counts the room from where the client says
 * its player stands), never by a typed direction alone: `north` sent as a
 * command answers "Alas, you cannot go that way." So a typed direction is
 * walked here, the way a page walks it (src/main.js `step`): out of the room
 * by its exit, along the street or corridor nav.js routes for it (or to the
 * archway or stair and through), at the page's glide pace (player.js
 * `glidePath`: a 26 m step in just over a second), a report every 100 ms.
 * Players on a page see the figure walk like anyone else's.
 *
 * Every report is put to the server's own judge first (world.mjs `judge`,
 * the same code, with what the server knows of this body): what it would
 * refuse is never sent. Doors are the server's, as its `doors` messages say.
 * When the mud says follow (actcomm.js `followed`), the body walks it, as a
 * follower's page does; and a flee walks out through an exit picked at
 * random, which is do_flee's half that game.js `breakOff` leaves to the body.
 *
 * Where to stand comes from the gateway's own copy of the world (bootWorld),
 * the same layout every page draws: a room's centre, raised by the temple's
 * mound, eye high -- never the centre itself, which is where arrivals appear.
 */

import { EX_CLOSED, EX_LOCKED } from '../src/are.js';

/** Eye height over the floor, as a page reports it (world.mjs). */
const EYE = 1.72;
const DIRS = ['north', 'east', 'south', 'west', 'up', 'down'];
/** player.js glidePath: 24 m/s, at least 0.55 s, at most 2.9 s unless 40 m/s takes longer; half a second for a half turn. */
const GLIDE = { speed: 24, least: 0.55, most: 2.9, fastest: 40, halfTurn: 0.5 };
/** Reports while walking, as often as a page sends them. */
const MOVE_MS = 100;
/** An archway's fade (main.js), and a crossing into another zone, which a page spends behind its card. */
const FADE_MS = 600;
const CROSS_MS = 1500;
/** After the last step, how long the server has to count the body in the room it walked to. */
const COUNTED_MS = 3000;
/** A follow held back while the body was walking is dropped after this: the leader is long gone. */
const STALE_FOLLOW_MS = 5000;
/**
 * The judge's walls (world.mjs WALL_LINE, DOOR_HALF): a walled room's wall
 * is 5.35 m out from its middle, with a doorway in the middle of every side
 * the layout gave an exit. A step through one is taken 1.2 m either side.
 */
const WALL_LINE = 5.35;
const DOOR_STEP = 1.2;
/** Sides as layout.js numbers them: north is -z. */
const SIDE = [[0, -1], [1, 0], [0, 1], [-1, 0]];
/** Ways tried through one exit before saying there is none: each ends on another spot. */
const PLANS = 8;
const HEARTBEAT_MS = 2000;
/** Closer to a room's centre than this is standing on whoever arrives next. */
const CENTRE_CLEAR = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Facing along (dx, dz): forward is (-sin yaw, -cos yaw). */
const yawAlong = (dx, dz) => Math.atan2(-dx, -dz);

async function waitFor(pred, ms) {
  for (const until = Date.now() + ms; ;) {
    if (pred()) return true;
    if (Date.now() > until) return false;
    await sleep(20);
  }
}

/** The point `d` metres along a polyline of { x, y, z }, and the direction there. */
function along(pts, cum, d) {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < d) i++;
  const a = pts[i - 1]; const b = pts[i];
  const seg = cum[i] - cum[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (d - cum[i - 1]) / seg));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, dx: b.x - a.x, dz: b.z - a.z };
}

/**
 * `world` is server/world.mjs bootWorld's, shared by every session (doors
 * are the server's for everyone). `onArrived(room)` after every walk that
 * ended in the room it set out for, whoever asked for it.
 */
export function createWalker({ link, world: w, log, onArrived = () => {} }) {
  if (!link || typeof link.pos !== 'function') throw new Error('walker.mjs: createWalker needs a link (client.mjs)');
  if (!w || !w.nav) throw new Error('walker.mjs: createWalker needs the booted world (world.mjs bootWorld)');
  if (typeof log !== 'function') throw new Error('walker.mjs: createWalker needs a log function');

  /** Where it stands: the room and the offset asked for, and the point reported. */
  let stand = null;
  let heartbeat = null;

  /** A room's centre plus (dx, dz), in its zone's frame, eye high, facing the centre. */
  function spotIn(vnum, dx, dz) {
    const info = w.built.rooms.get(vnum);
    if (!info) throw new Error(`walker.mjs: there is no room #${vnum} in the laid-out world`);
    if (info.unbuilt) throw new Error(`walker.mjs: #${vnum} is "In the air": nothing is built there to stand on`);
    const z = w.zoneOfVnum(vnum);
    const c = info.center;
    return {
      zone: z.zone.id, x: c.x - z.offset + dx, y: c.y + (w.lifts.get(vnum) || 0) + EYE, z: c.z + dz,
      // Forward is (-sin yaw, -cos yaw): towards the centre, back along (dx, dz).
      yaw: Math.atan2(dx, dz),
    };
  }

  // What the server knows of this body, for its judge (world.mjs): its session's last believed report
  // (`navRoom`, `posAt`) and its player's position, in the server's frame, eye high, no lift.
  const server = {
    s: { navRoom: null, posAt: null },
    pc: { ch: { get roomVnum() { return link.room; }, get affectedBy() { return link.self?.affectedBy || 0; } }, position: null },
  };
  /** A zone-local report as the server reads it (mud.mjs `position`): its frame, the mound's lift off. */
  function asServer(p) {
    const zone = w.byId.get(p.zone);
    if (!zone) throw new Error(`walker.mjs: no zone ${JSON.stringify(p.zone)} in the world`);
    const x = p.x + zone.offset;
    return { x, y: p.y - w.liftAt(x, p.y - EYE, p.z), z: p.z };
  }
  /** Where the server has just put the body (`at`, a jump): its next report is a first. */
  function placed(p, { jumped = false } = {}) {
    server.s.posAt = null;
    if (jumped) server.s.navRoom = null;
    server.pc.position = asServer(p);
  }
  let refusedHere = 0;

  /** One report, put to the server's judge first: null when it went out, or why the server would refuse it. */
  function send(p) {
    const q = asServer(p);
    if (!server.pc.position) server.pc.position = q;
    const now = performance.now();
    const verdict = w.judge(server.s, server.pc, q.x, q.y, q.z, now);
    if (verdict.why) {
      if (refusedHere++ < 3) log(`walker: not sending ${link.name}'s position: the server would refuse it (${verdict.why})`);
      return verdict.why;
    }
    refusedHere = 0;
    server.pc.position = q;
    server.s.posAt = now;
    server.s.navRoom = verdict.room;
    link.pos(p);
    return null;
  }

  /** The heartbeat's report; while walking, the steps are the reports, as a page's are. */
  function report() {
    if (stand && !moving) send(stand);
  }

  /** Stand in the room the server has the player in, 2.5 m off its centre, and start reporting. */
  function standAt(vnum, { dx = 2.5, dz = 0 } = {}) {
    if (vnum !== link.room) throw new Error(`walker.mjs: standAt(#${vnum}), but ${link.name} is in #${link.room}`);
    stand = { vnum, dx, dz, ...spotIn(vnum, dx, dz) };
    if (!server.pc.position) placed(stand, { jumped: true });
    report();
    if (!heartbeat) heartbeat = setInterval(report, HEARTBEAT_MS);
  }

  /** Set by an `at` during a walk: the walk stops where the server put the body. */
  let putBack = null;
  link.on('at', (msg) => {
    if (!msg.zone || ![msg.x, msg.y, msg.z].every(Number.isFinite)) throw new Error(`walker.mjs: the server refused a position and gave nowhere to stand instead: ${JSON.stringify(msg)}`);
    // Obeyed, not argued with: the server's point under its new number, and the room it says.
    const yaw = stand ? stand.yaw : 0;
    stand = { vnum: msg.room, dx: null, dz: null, zone: msg.zone, x: msg.x, y: msg.y + EYE, z: msg.z, yaw };
    placed(stand);
    putBack = msg.why;
    log(`walker: the server refused ${link.name}'s position (${msg.why}); standing where it has them in #${msg.room}`);
    report();
  });

  link.on('event', (e) => {
    if ((e.kind !== 'teleport' && e.kind !== 'recall') || !Number.isInteger(e.vnum)) return;
    // Put somewhere by the mud (goto, transfer, recall, a spell): stand in the new room as in the old.
    const dx = stand?.dx ?? 2.5;
    const dz = stand?.dz ?? 0;
    stand = { vnum: e.vnum, dx, dz, ...spotIn(e.vnum, dx, dz) };
    placed(stand, { jumped: true });
    putBack = e.kind;
    report();
  });

  // The doors as the server has them: its rules open and shut them, and the judge reads them here.
  link.on('doors', (msg) => {
    for (const [vnum, dir, bits] of msg.d || []) {
      const exit = w.world.rooms.get(vnum)?.exits[dir];
      if (exit) exit.locks = (exit.locks & ~(EX_CLOSED | EX_LOCKED)) | bits;
    }
  });

  link.on('closed', () => { if (heartbeat) clearInterval(heartbeat); heartbeat = null; });

  // ------------------------------------------------------------ walking --

  /** The feet now, in the server's frame, on the grid's floor: where nav.js plans from. */
  const feet = () => { const q = asServer(stand); return { x: q.x, y: q.y - EYE, z: q.z }; };
  /** A ground point in the server's frame as a report: its zone's frame, eye high on build.js's floor. */
  function reportAt(g, yaw) {
    const zone = w.zoneAtX(g.x);
    const lift = w.liftAt(g.x, g.y, g.z);
    return { zone: zone.zone.id, x: g.x - zone.offset, y: g.y + lift + EYE, z: g.z, yaw };
  }
  /** Where it stands from a report: its room and offset from the centre, for the heartbeat. */
  function standing(vnum, r) {
    const c = w.built.rooms.get(vnum).center;
    const offset = w.zoneOfVnum(vnum).offset;
    return { vnum, dx: r.x - (c.x - offset), dz: r.z - c.z, ...r };
  }

  /**
   * A page's glide along ground points (server frame) from `start`, as the
   * reports it sends: a turn to face the way, then the length at 24 m/s,
   * between 0.55 s and 2.9 s, 40 m/s past that (player.js glidePath).
   * Each sample is { g, yaw, ms } from the start of the glide.
   */
  function glideSamples(start, startYaw, points) {
    const pts = [start, ...points.map((p) => ({ x: p.x, y: p.y, z: p.z }))];
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y, pts[k].z - pts[k - 1].z));
    const total = cum.at(-1);
    if (total < 0.05) return [];
    const first = along(pts, cum, Math.min(0.5, total));
    let d = yawAlong(first.dx, first.dz) - startYaw;
    d = (((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const turnMs = (Math.abs(d) / Math.PI) * GLIDE.halfTurn * 1000;
    const moveMs = Math.min(Math.max(total / GLIDE.speed, GLIDE.least), Math.max(GLIDE.most, total / GLIDE.fastest)) * 1000;
    const out = [];
    for (let ms = MOVE_MS; ; ms += MOVE_MS) {
      const t = Math.min(ms, turnMs + moveMs);
      const moved = Math.min(1, Math.max(0, (t - turnMs) / moveMs));
      const at = along(pts, cum, moved * total);
      out.push({ g: { x: at.x, y: at.y, z: at.z }, yaw: moved > 0 ? yawAlong(at.dx, at.dz) : startYaw + d * Math.min(1, t / (turnMs || 1)), ms: t });
      if (t >= turnMs + moveMs) return out;
    }
  }

  /** The doorway of walled room `vnum` towards `other`, as two ground points (outward, or inward). */
  function doorway(vnum, other, inward) {
    const info = w.built.rooms.get(vnum);
    if (!info?.walled) return [];
    const sides = w.zoneOfVnum(vnum).layout.sides.get(vnum) || [];
    const side = sides.findIndex((x, k) => k < 4 && x && (x.target?.vnum === other || x.exit?.to === other));
    if (side < 0) return [];
    const [sx, sz] = SIDE[side];
    const c = info.center;
    const at = (r) => ({ x: c.x + sx * r, y: c.y, z: c.z + sz * r });
    return inward ? [at(WALL_LINE + DOOR_STEP), at(WALL_LINE - DOOR_STEP)] : [at(WALL_LINE - DOOR_STEP), at(WALL_LINE + DOOR_STEP)];
  }

  /** A ground point not on a room's centre: pushed out to 2.5 m, the way it came. */
  function offCentre(g, vnum) {
    const c = w.built.rooms.get(vnum).center;
    const r = Math.hypot(g.x - c.x, g.z - c.z);
    if (r >= CENTRE_CLEAR) return g;
    return r > 0.01 ? { ...g, x: c.x + ((g.x - c.x) / r) * 2.5, z: c.z + ((g.z - c.z) / r) * 2.5 } : { ...g, x: c.x + 2.5 };
  }

  /**
   * One way through exit `dir` into `to`, as timed samples, from where it
   * stands: nav.js's route for it (a random spot to end on each time), with
   * a walled room left and entered by its doorway, which nav.js on the
   * server cannot see.
   */
  function planned(from, dir, to) {
    const start = feet();
    if (w.zoneOfVnum(to) !== w.zoneOfVnum(from)) {
      const c = w.built.rooms.get(to).center;
      return [{ g: { x: c.x + 2.5, y: c.y, z: c.z }, yaw: stand.yaw, ms: CROSS_MS }];
    }
    const route = w.nav.route(from, dir, to, start, Math.random);
    if (!route || !route.points.length) return null;
    const out = [];
    let at = start;
    let yaw = stand.yaw;
    let ms = 0;
    const add = (samples) => {
      for (const x of samples) out.push({ ...x, ms: ms + x.ms });
      if (samples.length) { ({ g: at, yaw } = samples.at(-1)); ms = out.at(-1).ms; }
    };
    if (!route.portal) {
      const end = offCentre(route.points.at(-1), to);
      add(glideSamples(at, yaw, [...doorway(from, to, false), ...route.points.slice(0, -1), ...doorway(to, from, true), end]));
      return out;
    }
    add(glideSamples(at, yaw, route.points));
    if (route.portal.stair) add(glideSamples(at, yaw, route.portal.climb));
    else add([{ g: route.portal.arrive, yaw, ms: FADE_MS }]);
    if (route.portal.after?.length) add(glideSamples(at, yaw, [...route.portal.after.slice(0, -1), offCentre(route.portal.after.at(-1), to)]));
    return out;
  }

  /** The samples put to the judge as the server will see them, before one is sent: null, or why it would refuse. */
  function rehearse(samples) {
    const s = { ...server.s };
    const pc = { ch: server.pc.ch, position: { ...server.pc.position } };
    const t0 = performance.now();
    for (const x of samples) {
      const q = asServer(reportAt(x.g, x.yaw));
      const verdict = w.judge(s, pc, q.x, q.y, q.z, t0 + x.ms);
      if (verdict.why) return verdict.why;
      pc.position = q;
      s.posAt = t0 + x.ms;
      s.navRoom = verdict.room;
    }
    return null;
  }

  /** The samples, sent at their times. Null, or why it stopped. */
  async function perform(samples) {
    const t0 = Date.now();
    for (const x of samples) {
      const wait = t0 + x.ms - Date.now();
      if (wait > 0) await sleep(wait);
      if (!link.up) return 'The link to the game is gone.';
      if (putBack) return 'The game put you back.';
      const r = reportAt(x.g, x.yaw);
      if (send(r)) return 'You bump into something and stop.';
      stand = standing(link.room, r);
    }
    return null;
  }

  let moving = null;

  /** Out of the room by exit `dir` (0..5), as main.js `step` does: { ok: true, room } once the server counts it there, or { ok: false, why }. */
  async function walkNow(dir) {
    if (!stand) throw new Error('walker.mjs: walk before standAt');
    const from = link.room;
    const name = DIRS[dir];
    const exit = w.world.rooms.get(from)?.exits[dir];
    if (!exit || exit.offMap) return { ok: false, why: 'Alas, you cannot go that way.' };
    const word = (exit.keyword || 'door').split(/\s+/)[0] || 'door';
    if (exit.locks & EX_CLOSED) {
      if (exit.locks & EX_LOCKED) return { ok: false, why: `The ${word} is locked.` };
      // The page opens a shut door it walks into; so does this.
      link.cmd(`open ${name}`);
      if (!await waitFor(() => !(exit.locks & EX_CLOSED), 2000)) return { ok: false, why: `The ${word} is closed.` };
    }
    const to = exit.to;
    const target = w.built.rooms.get(to);
    if (!target || target.unbuilt) return { ok: false, why: 'Alas, you cannot go that way.' };
    let samples = null;
    let refusal = null;
    for (let tries = 0; tries < PLANS && !samples; tries++) {
      const plan = planned(from, dir, to);
      if (!plan) break;
      refusal = rehearse(plan);
      if (!refusal) samples = plan;
    }
    if (!samples) {
      log(`walker: no way ${name} from #${from} the server would believe${refusal ? ` (${refusal})` : ''}`);
      return { ok: false, why: 'Alas, you cannot go that way.' };
    }
    moving = { dir, to };
    putBack = null;
    try {
      const why = await perform(samples);
      if (why) return { ok: false, why };
      if (!await waitFor(() => link.room === to, COUNTED_MS)) {
        log(`walker: ${link.name} walked ${name} from #${from}, and the server still has them in #${link.room}`);
        return { ok: false, why: 'You walk, and find yourself where you were.' };
      }
      onArrived(to);
      return { ok: true, room: to };
    } finally {
      moving = null;
    }
  }

  // One walk at a time, whoever asked: a typed direction, a follow, a flee.
  let chain = Promise.resolve();
  function walk(dir) {
    if (!Number.isInteger(dir) || dir < 0 || dir > 5) throw new Error(`walker.mjs: walk takes an exit 0..5; got ${JSON.stringify(dir)}`);
    const run = chain.then(() => walkNow(dir));
    chain = run.catch(() => {});
    return run;
  }

  // -------------------------------------------------- following, fleeing --

  link.on('event', (e) => {
    if (e.kind === 'follow' && Number.isInteger(e.dir)) {
      const heard = Date.now();
      chain = chain.then(async () => {
        // Held while walking on its own: by now the leader is long gone, and a page would not go either.
        if (Date.now() - heard > STALE_FOLLOW_MS || e.from !== link.room) return;
        const r = await walkNow(e.dir);
        if (!r.ok) log(`walker: following ${e.leader} ${DIRS[e.dir]} stopped: ${r.why}`);
      }).catch((error) => log(`walker: following failed: ${error.stack}`));
    }
    if (e.kind === 'flee') {
      chain = chain.then(async () => {
        const exits = (w.world.rooms.get(link.room)?.exits || []).flatMap((x, d) => (x && !x.offMap ? [d] : []));
        for (let i = exits.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [exits[i], exits[j]] = [exits[j], exits[i]]; }
        for (const d of exits) if ((await walkNow(d)).ok) return;
      }).catch((error) => log(`walker: fleeing failed: ${error.stack}`));
    }
  });

  return {
    standAt, walk,
    get walking() { return !!moving; },
  };
}
