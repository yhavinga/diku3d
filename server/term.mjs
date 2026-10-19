/**
 * One player at a terminal: Merc's nanny (comm.c) for the name and the
 * password, then the game -- what the mud says, line by line, under a
 * prompt that stays at the bottom while you type -- with every typed
 * direction walked by walker.mjs.
 *
 * Two kinds of terminal. A person's has a pty: keystrokes arrive raw, and
 * the echo, the line editing (arrows, history, ^A ^E ^U ^W) and the colour
 * are done here. A pipe's has none -- `ssh host < script`, or an agent
 * driving ssh without -t -- and gets plain lines both ways: no echo, no
 * prompt redrawn, no colour, each question on a line of its own.
 *
 * Input is taken one line at a time, in order: a direction holds the lines
 * after it until the body has walked it, as a mud's one command a pulse
 * would, so a script's `north` then `look` looks at the room it walked to.
 *
 * The nanny asks the password before it knows whether the name is new,
 * as the page's form does (src/link-ui.js): mud.mjs says a name is new only
 * in answer to a login, and a login with a made-up password would count as
 * a wrong guess against a name that exists.
 */

import { StringDecoder } from 'string_decoder';

import { openLink, LINE_MAX } from './client.mjs';
import { createWalker } from './walker.mjs';
import { POS } from '../src/game.js';

const DIRS = ['north', 'east', 'south', 'west', 'up', 'down'];
/** Merc's classes as `create` numbers them, by the three letters comm.c reads. */
const CLASSES = { mag: 0, cle: 1, thi: 2, war: 3 };
/** Time to log in or make a character before the connection is closed. */
const NANNY_MS = 3 * 60 * 1000;
/** Wrong passwords before the connection is closed (comm.c closes at the first). */
const WRONG_MAX = 3;
/** After a pipe's input ends: how long its last command's answer has to arrive. */
const DRAIN_MS = 1500;

/** SGR colours, for a pty only. What is coloured follows the page's console (game-ui.js `show`). */
const TONE = { room: '1;36', hurt: '31', dead: '1;31', gain: '33', speech: '36' };
const SPEECH = new Set(['say', 'say-self', 'tell', 'gtell', 'channel', 'mobsay', 'emote']);

function toneOf(e, roomName) {
  if (e.kind === 'out' && e.text === roomName) return TONE.room;
  if (e.kind === 'hit' && !e.byPlayer && !e.to) return TONE.hurt;
  if (e.kind === 'death') return TONE.dead;
  if (e.kind === 'xp' || e.kind === 'gold' || e.kind === 'level') return TONE.gain;
  if (SPEECH.has(e.kind)) return TONE.speech;
  return null;
}

/** The direction a typed word means, by interp.c's prefix rule (north before east ...), or -1. */
export function directionOf(word) {
  const w = String(word).toLowerCase();
  return w ? DIRS.findIndex((d) => d.startsWith(w)) : -1;
}

/**
 * `stream` is the SSH session's channel, `pty` what its pty request said
 * (null for none), `ip` the address the connection came from. `onEnd` once
 * the session is over, either way.
 */
export function createTerm({ stream, pty, ip, world, game, greeting, log, onEnd = () => {} }) {
  const tty = !!pty;
  const colour = tty && pty.term !== 'dumb';
  const NL = tty ? '\r\n' : '\n';
  let ended = false;
  let link = null;
  let walker = null;

  // ------------------------------------------------------------- output --

  /** The question asked, or in the game the vitals; and whether what is typed is shown. */
  let prompt = '';
  let hidden = false;
  /** The line being typed, and the cursor in it. */
  let buf = [];
  let cur = 0;

  const write = (text) => { if (!ended) stream.write(text); };
  const paint = (text, sgr) => (colour && sgr ? `\x1b[${sgr}m${text}\x1b[0m` : text);

  /** The prompt and what is typed after it, redrawn on the bottom line. */
  function redraw() {
    if (!tty) return;
    const typed = hidden ? '' : buf.join('');
    const back = hidden ? 0 : buf.length - cur;
    write(`\r\x1b[K${prompt}${typed}${back ? `\x1b[${back}D` : ''}`);
  }

  /** Lines of output above the prompt. Each is [text, sgr]. */
  function print(lines) {
    if (!lines.length) return;
    const out = lines.flatMap(([text, sgr]) => String(text).replace(/\r/g, '').split('\n').map((l) => paint(l, sgr) + NL)).join('');
    if (tty) { write(`\r\x1b[K${out}`); redraw(); } else write(out);
  }
  const say = (...texts) => print(texts.map((t) => [t, null]));

  function vitals() {
    const c = link?.self;
    return c ? `<${c.hit}hp ${c.mana}m ${c.move}mv> ` : '> ';
  }

  // -------------------------------------------------------------- input --

  /** Lines typed and not yet taken, and whoever waits for the next. null is the end of input. */
  const inbox = [];
  let waiter = null;
  function submit(line) {
    if (waiter) { const w = waiter; waiter = null; w(line); } else inbox.push(line);
  }
  const nextLine = () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => { waiter = resolve; }));

  /** A question, and the next line typed. A pipe sees the question on a line of its own. */
  function ask(question, { secret = false } = {}) {
    prompt = question;
    hidden = secret;
    if (tty) redraw(); else write(question.trimEnd() + NL);
    return nextLine();
  }

  const history = [];
  let recall = -1;
  /** What was left of an escape sequence at the end of the last chunk. */
  let pending = '';
  let lastCR = false;
  let hinted = false;

  function enterLine() {
    const line = buf.join('');
    // The line stays on the screen as typed, and the prompt starts again under it.
    write(`\r\x1b[K${prompt}${hidden ? '' : line}${NL}`);
    if (!hidden && line.trim() && history.at(-1) !== line) { history.push(line); if (history.length > 100) history.shift(); }
    buf = [];
    cur = 0;
    recall = -1;
    // In the game the vitals come back at once; while logging in, the next question brings its own.
    prompt = link?.up ? vitals() : '';
    hidden = false;
    redraw();
    submit(line);
  }

  function key(seq) {
    switch (seq) {
      case '\x1b[A': case '\x1bOA':
        if (hidden || !history.length) return;
        recall = recall < 0 ? history.length - 1 : Math.max(0, recall - 1);
        buf = [...history[recall]]; cur = buf.length; return redraw();
      case '\x1b[B': case '\x1bOB':
        if (hidden || recall < 0) return;
        recall += 1;
        buf = recall >= history.length ? [] : [...history[recall]];
        if (recall >= history.length) recall = -1;
        cur = buf.length; return redraw();
      case '\x1b[C': case '\x1bOC': if (cur < buf.length) { cur += 1; redraw(); } return undefined;
      case '\x1b[D': case '\x1bOD': if (cur > 0) { cur -= 1; redraw(); } return undefined;
      case '\x1b[H': case '\x1bOH': case '\x1b[1~': case '\x01': cur = 0; return redraw();
      case '\x1b[F': case '\x1bOF': case '\x1b[4~': case '\x05': cur = buf.length; return redraw();
      case '\x1b[3~': if (cur < buf.length) { buf.splice(cur, 1); redraw(); } return undefined;
      default: return undefined;
    }
  }

  function typed(text) {
    for (const ch of text) {
      if (pending) {
        pending += ch;
        // ESC [ ... final byte, or ESC O x: a whole sequence.
        if (/^\x1b(\[[0-9;]*[@-~]|O.)$/.test(pending)) { key(pending); pending = ''; } else if (pending.length > 8 || !/^\x1b(\[[0-9;]*|O)?$/.test(pending)) pending = '';
        continue;
      }
      if (ch === '\x1b') { pending = ch; continue; }
      // Enter is \r; some terminals follow it with \n or NUL.
      if (lastCR && (ch === '\n' || ch === '\0')) { lastCR = false; continue; }
      lastCR = ch === '\r';
      if (ch === '\r' || ch === '\n') { enterLine(); continue; }
      if (ch === '\x7f' || ch === '\b') { if (cur > 0) { buf.splice(cur - 1, 1); cur -= 1; redraw(); } continue; }
      if (ch === '\x03') {
        if (!link?.up) { end('^C'); return; }
        buf = []; cur = 0;
        write(`^C${NL}`);
        if (!hinted) { hinted = true; say('(Type quit to leave the game; the connection stays open until then.)'); } else redraw();
        continue;
      }
      // ^D on an empty line hangs up, as closing the terminal does.
      if (ch === '\x04') { if (!buf.length) { end(link?.up ? 'You hang up.' : null); return; } continue; }
      if (ch === '\x15') { buf.splice(0, cur); cur = 0; redraw(); continue; }
      if (ch === '\x17') {
        let k = cur;
        while (k > 0 && buf[k - 1] === ' ') k -= 1;
        while (k > 0 && buf[k - 1] !== ' ') k -= 1;
        buf.splice(k, cur - k); cur = k; redraw();
        continue;
      }
      if (ch === '\x01' || ch === '\x05') { key(ch); continue; }
      if (ch < ' ') continue;
      if (buf.length >= LINE_MAX) continue;
      buf.splice(cur, 0, ch);
      cur += 1;
      if (hidden) continue;
      if (cur === buf.length) write(ch); else redraw();
    }
  }

  const decoder = new StringDecoder('utf8');
  let partial = '';
  stream.on('data', (chunk) => {
    const text = decoder.write(chunk);
    if (tty) return typed(text);
    partial += text;
    const lines = partial.split('\n');
    partial = lines.pop();
    for (const l of lines) submit(l.replace(/\r$/, ''));
    return undefined;
  });
  stream.on('end', () => {
    if (!tty && partial) submit(partial);
    submit(null);
  });
  stream.on('close', () => end(null));
  stream.on('error', (error) => { log(`${ip}: channel error: ${error.message}`); end(null); });

  // ------------------------------------------------------------ the end --

  function end(why) {
    if (ended) return;
    // The prompt is not left standing under the last line.
    if (tty) write('\r\x1b[K');
    if (why) write(why + NL);
    ended = true;
    clearTimeout(nannyTimer);
    try { stream.exit(0); stream.end(); } catch { /* the channel is already gone */ }
    if (link) link.close('the terminal closed');
    onEnd();
  }

  // ------------------------------------------------------------ logging in --

  const nannyTimer = setTimeout(() => end('Timed out waiting for a name and a password.'), NANNY_MS);
  nannyTimer.unref();

  async function nanny() {
    let wrong = 0;
    let name = await ask(greeting.prompt);
    for (;;) {
      if (name === null) return null;
      name = name.trim();
      if (!name) { name = await ask('Name: '); continue; }
      const password = await ask('Password: ', { secret: true });
      if (password === null) return null;
      const answer = await link.login(name, password);
      if (answer.t === 'enter') return answer;
      if (answer.new) {
        const made = await newCharacter(answer.name, password);
        if (made === null) return null;
        if (made.t === 'enter') return made;
        if (made.again) { name = await ask('Ok, what IS it, then? '); continue; }
        say(made.why || 'The game would not make that character.');
        name = await ask('Name: ');
        continue;
      }
      say(answer.why);
      if (answer.why === 'Illegal name, try another.' || answer.why === 'That name is taken.') { name = await ask('Name: '); continue; }
      if (answer.why === 'Wrong password.' && ++wrong < WRONG_MAX) continue;
      return null;
    }
  }

  /** comm.c's questions for a new name; the password already typed becomes its password once typed again. */
  async function newCharacter(name, first) {
    const sure = await ask(`Did I get that right, ${name} (Y/N)? `);
    if (sure === null) return null;
    if (!/^y/i.test(sure.trim())) return { again: true };
    let password = first;
    for (;;) {
      if (password === null) return null;
      if (password.length < 5) {
        say('Password must be at least five characters long.');
        password = await ask(`Give me a password for ${name}: `, { secret: true });
        continue;
      }
      const again = await ask('Please retype password: ', { secret: true });
      if (again === null) return null;
      if (again === password) break;
      say("Passwords don't match.");
      password = await ask(`Give me a password for ${name}: `, { secret: true });
    }
    let sex = await ask('What is your sex (M/F/N)? ');
    while (sex !== null && !/^[mfn]/i.test(sex.trim())) { say("That's not a sex."); sex = await ask('What IS your sex? '); }
    if (sex === null) return null;
    let cls = await ask('Select a class [Mag Cle Thi War]: ');
    while (cls !== null && CLASSES[cls.trim().toLowerCase().slice(0, 3)] === undefined) { say("That's not a class."); cls = await ask('What IS your class? '); }
    if (cls === null) return null;
    return link.create(name, password, CLASSES[cls.trim().toLowerCase().slice(0, 3)], sex.trim()[0].toLowerCase());
  }

  // ------------------------------------------------------------ playing --

  const roomName = () => world.world.rooms.get(link.room)?.name;

  function onEv(msg) {
    const name = roomName();
    print(msg.e.filter((e) => e.text).map((e) => [e.text, toneOf(e, name)]));
    // Moved by the mud without the look that goto and transfer already give.
    if (msg.e.some((e) => e.kind === 'recall' || (e.kind === 'teleport' && !e.placed))) link.cmd('look');
  }

  let shown = '';
  function onSelf() {
    if (!tty) return;
    const now = vitals();
    if (now === shown) return;
    shown = now;
    prompt = now;
    hidden = false;
    redraw();
  }

  /** One line in the game: a direction is walked, anything else goes to the mud as it was typed. */
  async function command(line) {
    const text = line.trim();
    if (!text) return;
    const dir = directionOf(text.split(/\s+/)[0]);
    if (dir < 0) { link.cmd(text); return; }
    const me = link.self || {};
    // interp.c's position check, for the commands the game no longer runs itself.
    if (me.position === POS.DEAD) return say('Lie still; you are DEAD.');
    if (me.position === POS.MORTAL || me.position === POS.INCAP) return say('You are hurt far too bad for that.');
    if (me.position === POS.STUNNED) return say('You are too stunned to do that.');
    if (me.position === POS.SLEEPING) return say('In your dreams, or what?');
    if (me.fighting) return say('No way!  You are still fighting!');
    const r = await walker.walk(dir);
    if (!r.ok) say(r.why);
  }

  async function run() {
    try {
      link = await openLink({ url: game, ip, log: (text) => log(`${ip}: ${text}`) });
    } catch (error) {
      log(`${ip}: ${error.message}`);
      return end('The game is not answering just now. Try again in a minute.');
    }
    if (ended) return link.close('the terminal closed while connecting');
    // mud.mjs says `quit` for a quit, whose verse has been printed already; any other reason is for the player.
    link.on('closed', ({ why }) => end(why === 'quit' ? null : why));
    // Before the login, so nothing the server sends on entering (the doors, the first look) goes unheard.
    walker = createWalker({ link, world, log: (text) => log(`${ip}: ${text}`), onArrived: () => link.cmd('look') });
    link.on('ev', onEv);
    link.on('self', onSelf);
    print(greeting.lines.map((l) => [l, null]));
    let entered;
    try {
      entered = await nanny();
    } catch (error) {
      log(`${ip}: ${error.message}`);
      return end(error.message);
    }
    if (ended) return undefined;
    if (!entered) return end(null);
    clearTimeout(nannyTimer);
    log(`${ip}: ${entered.name} entered over ssh${tty ? '' : ' (no pty)'}`);
    walker.standAt(link.room);
    prompt = vitals();
    hidden = false;
    redraw();
    for (;;) {
      const line = await nextLine();
      if (ended) return undefined;
      if (line === null) {
        // A pipe's input is over: let the last answer come, then hang up.
        await new Promise((resolve) => { setTimeout(resolve, DRAIN_MS); });
        return end(null);
      }
      try {
        await command(line);
      } catch (error) {
        log(`${ip}: ${link.name}: "${line.slice(0, 60)}" failed: ${error.stack}`);
        say(`That went wrong in the gateway: ${error.message}`);
      }
    }
  }

  run().catch((error) => { log(`${ip}: session failed: ${error.stack}`); end('The terminal gateway failed; this connection is closed.'); });

  return { end };
}
