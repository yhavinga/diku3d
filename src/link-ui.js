/**
 * The title screen's other door: "connect to a server". comm.c's nanny,
 * as a form -- the address, a name and a password; for a name the server
 * does not know, "Did I get that right?", the password again, a class and a
 * sex -- and then the world, with the server's character in it.
 *
 * Playing alone stays the default and stays one click away: a refusal, a
 * wrong address or a server that is not there is said in words under the
 * form, and the "play alone" button beside it still starts the game in the
 * page. The last address that worked is remembered.
 */

import { SocketLink, resolveAddress, worldFingerprint } from './link.js';

const ADDRESS_KEY = 'diku3d.server.address';
const CLASSES = [['warrior', 3], ['mage', 0], ['cleric', 1], ['thief', 2]];
const SEXES = [['male', 'm'], ['female', 'f'], ['neither', 'n']];

/**
 * `onEnter(link, enter)` once the server has put the character in the
 * world; `onAlone()` for the play-alone button. `storage` remembers the address.
 * `getGame()` is asked only when the form is sent: the form opens on the
 * title, before the world and its game are built (title.js holdTitle keeps
 * a sending until they are).
 */
export function createConnectUi({ getGame, onEnter, onAlone, storage = globalThis.localStorage }) {
  const $ = (id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`link-ui: index.html has no #${id}`);
    return node;
  };
  const form = $('connect');
  const opener = $('connect-open');
  const address = $('connect-address');
  const name = $('connect-name');
  const password = $('connect-password');
  const again = $('connect-password2');
  const fresh = $('connect-new');
  const confirmLine = $('connect-confirm');
  const go = $('connect-go');
  const status = $('connect-status');
  const title = $('title');

  let remembered = null;
  try { remembered = storage && storage.getItem(ADDRESS_KEY); } catch { remembered = null; }
  address.value = remembered || '';
  address.placeholder = `${globalThis.location?.host || 'this site'}/ws · or host:port`;

  let link = null;
  let stage = 'login';
  let cls = 3;
  let sex = 'm';
  let busy = false;

  const choices = (holder, list, current, set) => {
    holder.textContent = '';
    for (const [label, value] of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.classList.toggle('on', value === current());
      button.addEventListener('click', () => { set(value); for (const b of holder.children) b.classList.toggle('on', b === button); });
      holder.append(button);
    }
  };
  choices($('connect-class'), CLASSES, () => cls, (v) => { cls = v; });
  choices($('connect-sex'), SEXES, () => sex, (v) => { sex = v; });

  const say = (text, tone = '') => { status.textContent = text; status.className = tone; };
  function setStage(next) {
    stage = next;
    fresh.hidden = next !== 'new';
    go.textContent = next === 'new' ? 'create the character' : 'connect';
    again.required = next === 'new';
  }

  function open() {
    form.hidden = false;
    title.classList.add('connecting');
    setStage('login');
    say('');
    (name.value ? password : name).focus();
  }
  function close() {
    form.hidden = true;
    title.classList.remove('connecting');
    if (link) { link.close(); link = null; }
  }

  opener.addEventListener('click', () => (form.hidden ? open() : close()));
  $('connect-alone').addEventListener('click', () => { close(); onAlone(); });
  $('connect-back').addEventListener('click', close);
  name.addEventListener('input', () => { if (stage === 'new') setStage('login'); });
  // The keys the world binds (WASD, E, I ...) must not fire while typing here.
  form.addEventListener('keydown', (event) => event.stopPropagation());
  form.addEventListener('keyup', (event) => event.stopPropagation());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    go.disabled = true;
    try { await submit(); } finally { busy = false; go.disabled = false; }
  });

  async function connected() {
    if (link && !link.closed) return link;
    const where = resolveAddress(address.value);
    if (where.error) throw new Error(where.error);
    say(`Connecting to ${where.url} ...`);
    const next = new SocketLink(where.url);
    const hello = await next.open();
    const mine = worldFingerprint(getGame());
    if (hello.world && (hello.world.mobs !== mine.mobs || hello.world.hash !== mine.hash)) {
      next.close();
      throw new Error(`That server runs a different world (${hello.world.rooms} rooms, ${hello.world.mobs} mobiles)`
        + ` from this page (${mine.rooms} rooms, ${mine.mobs}). Load the page without ?areas= or ?room=, or use the server's own page.`);
    }
    link = next;
    try { storage && storage.setItem(ADDRESS_KEY, address.value.trim()); } catch { /* private mode: nothing remembered */ }
    return link;
  }

  async function submit() {
    const who = name.value.trim();
    if (!who) { say('Your name?', 'bad'); name.focus(); return; }
    if (!password.value) { say('And a password.', 'bad'); password.focus(); return; }
    let reply;
    try {
      const l = await connected();
      if (stage === 'new') {
        if (again.value !== password.value) { say("Passwords don't match.  Retype password.", 'bad'); again.value = ''; again.focus(); return; }
        say(`New character.  Making ${who} ...`);
        reply = await l.create(who, password.value, cls, sex);
      } else {
        reply = await l.login(who, password.value);
      }
    } catch (error) {
      if (link) { link.close(); link = null; }
      say(`${error.message}  "Play alone" still works.`, 'bad');
      return;
    }
    if (reply.ok) {
      say('');
      const l = link;
      link = null;
      form.hidden = true;
      title.classList.remove('connecting');
      onEnter(l, reply.enter);
      return;
    }
    if (reply.new) {
      setStage('new');
      name.value = reply.name;
      // The nanny's "Did I get that right, X (Y/N)?" -- yes is going on; no is a new name above.
      confirmLine.textContent = `${reply.why.replace(' (Y/N)', '')}  If so, retype the password and choose:`;
      say('');
      again.focus();
      return;
    }
    say(reply.why || 'The server said no.', 'bad');
    if (/password/i.test(reply.why || '')) { password.value = ''; password.focus(); }
  }

  return { open, close };
}
