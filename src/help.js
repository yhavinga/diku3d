/**
 * The help screen. Press ? (or F1).
 *
 * Every control in one place, grouped, with the rows for your own class lit
 * and the other class's dimmed. The rows are written out by hand, but each
 * was read off the handler that owns the key: main.js (E, Tab, 1-4, O, F, P, V,
 * M, G, arrows, PgUp/PgDn, left mouse), game-ui.js (Z X C, I B K R T Q, Enter,
 * wheel, right mouse), rules/skills.js (the Z X C H J L N skill bar) and
 * player.js (WASD, shift, space).
 *
 * It is a module of its own that reaches the game only through `window.diku`,
 * and it behaves like the options screen: opening gives the mouse back and
 * holds the game, and the same key closes it (Escape works too, but Escape is
 * the browser's own pointer-lock release, so nothing may depend on it).
 */

const GROUPS = [
  [ // column 1
    { title: 'Moving about', rows: [
      [['W', 'A', 'S', 'D'], 'walk'],
      [['Shift'], 'run'],
      [['Space'], 'jump'],
      [['←', '↑', '→', '↓'], "take the exit west, north, east or south — the mud's own compass, so north is north however you face"],
      [['PgUp', 'PgDn'], 'take the exit up or down'],
      [['V'], 'noclip: walk through walls'],
    ] },
    { title: 'Looking and using', rows: [
      [['mouse'], 'look around'],
      [['E'], 'examine, open, unlock (with the key you carry), drink, search a body, pick up — press again to close'],
      [['Tab'], "the room's full description again, or fold it"],
    ] },
    { title: 'Fighting', rows: [
      [['left mouse'], 'attack what you are facing'],
    ] },
  ],
  [ // column 2
    { title: 'Spells', who: 'caster', tag: 'mage and cleric', rows: [
      [['Z', 'X'], 'choose a spell on the bar (or the mouse wheel)'],
      [['C'], 'cast it, at what you fight or face, or on yourself (or right mouse)'],
    ] },
    { title: 'Skill bar', who: 'fighter', tag: 'warrior and thief', rows: [
      [['Z', 'X', 'C', 'H', 'J', 'L', 'N'], 'kick, backstab, disarm, sneak, hide, steal, pick — the slots on the bar, in order', 'stack'],
    ] },
    { title: 'Character', tag: 'each sheet closes on its own key', rows: [
      [['I'], 'inventory and equipment'],
      [['B'], 'trade with a shopkeeper'],
      [['K'], 'skills, spells and training'],
      [['R'], 'rest'],
      [['T'], 'take everything within reach'],
      [['Q'], 'recall to the temple'],
    ] },
  ],
  [ // column 3
    { title: 'Command line', rows: [
      [['Enter'], "the mud's own prompt: Merc's commands, abbreviations and socials"],
      [['Tab'], 'in the prompt: complete a command'],
      [['Esc', '~or', 'Ctrl-C'], 'close it (or Enter on an empty line)'],
    ] },
    { title: 'The world', rows: [
      [['1', '2', '3', '4'], 'dawn, noon, dusk, night'],
      [['P'], 'quality: low, medium, high, max'],
      [['F'], 'frame rate, draw calls and room statistics'],
      [['M'], 'sound on or off'],
      [['G'], 'force every lock in the world'],
      [['O'], 'options'],
    ] },
    { title: 'This screen', rows: [
      [['?', '~or', 'F1'], 'show or hide help — the same key closes it'],
      [['Esc'], 'also closes it'],
    ] },
  ],
];

const PRETTY = { mage: 'a mage', cleric: 'a cleric', warrior: 'a warrior', thief: 'a thief' };
const CASTERS = new Set(['mage', 'cleric']);

function keyHtml(token) {
  if (token.startsWith('~')) return `<span class="hk-or">${token.slice(1)}</span>`;
  return `<kbd>${token}</kbd>`;
}

/** What a skill-bar slot does, in the words of the rows around it. */
const SKILL_TEXT = {
  kick: 'kick', backstab: 'backstab, from behind and before the fight', disarm: 'disarm your opponent',
  sneak: 'sneak: move unannounced', hide: 'hide in the shadows', steal: 'steal gold from who you face', pickLock: 'pick the nearest lock',
};

/** The bar is built per class from rules/skills.js, so the slots are read, not written out. */
function skillRows(game) {
  const bar = game && game.actions ? game.actions().filter((a) => a.keyLabel) : [];
  if (!bar.length) return '';
  return bar.map((a) => `
      <div class="hp-row${a.known ? '' : ' later'}">
        <div class="hp-keys"><kbd>${a.keyLabel}</kbd></div><div class="hp-text">${SKILL_TEXT[a.id] || a.label}${a.known ? '' : ' <small>(later)</small>'}</div>
      </div>`).join('');
}

function build() {
  const cols = GROUPS.map((groups) => `<div class="hp-col">${groups.map((g) => `
    <section class="hp-group"${g.who ? ` data-who="${g.who}"` : ''}>
      <h3>${g.title}${g.tag ? `<small>${g.tag}</small>` : ''}</h3>
      ${g.rows.map(([keys, text, mode]) => `
      <div class="hp-row${mode ? ` ${mode}` : ''}${text ? '' : ' note'}">
        <div class="hp-keys">${keys.map(keyHtml).join('')}</div>${text ? `<div class="hp-text">${text}</div>` : ''}
      </div>`).join('')}
    </section>`).join('')}</div>`).join('');
  const root = document.createElement('div');
  root.id = 'help';
  root.innerHTML = `<div id="help-panel" role="dialog" aria-label="Controls">
    <header><h2>Controls</h2><div class="sub"><span id="help-class"></span><span>? or F1 to close</span></div></header>
    <div class="hp-cols">${cols}</div>
  </div>`;
  document.body.appendChild(root);

  const hint = document.createElement('div');
  hint.id = 'help-hint';
  hint.innerHTML = '<kbd>?</kbd> help';
  document.body.appendChild(hint);
  return { root, hint };
}

export function createHelp() {
  const { root, hint } = build();
  const typing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  let open = false;
  let wasPaused = false;
  let hadLock = false;

  /** In the game proper: past the loading bar and the title card, and not over the options. */
  function playable() {
    const d = window.diku;
    if (!d || !d.state || !d.options) return false;
    if (document.getElementById('loading') && !document.getElementById('loading').classList.contains('hidden')) return false;
    if (!document.getElementById('title').classList.contains('hidden')) return false;
    if (d.title && d.title.active) return false;
    return !d.options.open;
  }

  function show() {
    const d = window.diku;
    const cls = d.game && d.game.state ? d.game.state.className : null;
    const who = CASTERS.has(cls) ? 'caster' : 'fighter';
    root.dataset.who = cls ? who : '';
    root.querySelector('#help-class').textContent = cls ? `playing ${PRETTY[cls] || cls}` : '';
    const rows = who === 'fighter' ? skillRows(d.game) : '';
    if (rows) {
      const group = root.querySelector('.hp-group[data-who="fighter"]');
      group.querySelectorAll('.hp-row').forEach((r) => r.remove());
      group.insertAdjacentHTML('beforeend', rows);
    }
    hadLock = !!document.pointerLockElement;
    wasPaused = d.state.paused;
    d.state.paused = true;           // headless or refused lock: nothing else would hold the game
    d.player.keys.clear();           // a held W would otherwise walk on under the panel
    d.player.controls.unlock();
    root.classList.add('open');
    hint.classList.remove('on');
    open = true;
  }

  function hide() {
    const d = window.diku;
    root.classList.remove('open');
    open = false;
    // With the mouse held at the start, the unlock/lock events own `paused`.
    if (!hadLock) d.state.paused = wasPaused;
    d.player.requestLock();
  }

  document.addEventListener('keydown', (event) => {
    const help = event.key === '?' || event.code === 'F1';
    if (open) {
      if (event.code === 'Escape') { hide(); return; }
      if (help && !event.repeat) event.preventDefault(), hide();
      else if (!event.ctrlKey && !event.metaKey) event.preventDefault();
      event.stopImmediatePropagation();   // the game does not hear a key while this is up
      return;
    }
    if (!help || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'F1') event.preventDefault();  // never the browser's own help
    if (typing(event.target) || event.repeat || !playable()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show();
  }, true);

  // Mouse input belongs to the panel while it is up.
  for (const type of ['mousedown', 'wheel', 'contextmenu']) {
    document.addEventListener(type, (event) => {
      if (open && !root.contains(event.target)) event.stopImmediatePropagation();
      else if (open && type !== 'wheel') event.stopPropagation();
    }, { capture: true, passive: type === 'wheel' ? true : undefined });
  }
  root.addEventListener('click', (event) => { if (event.target === root) hide(); });

  // The discovery hint: once, when play begins, fading by itself.
  const poll = setInterval(() => {
    if (!playable()) return;
    clearInterval(poll);
    if (open) return;
    hint.classList.add('on');
    setTimeout(() => hint.classList.remove('on'), 14000);
  }, 400);

  return { get open() { return open; }, show, hide };
}
