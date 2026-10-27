/**
 * The command line: interp.c's prompt in the corner of the world.
 *
 * Enter opens it and puts the caret in; Enter on an empty line closes it
 * again (the key that opened it, CLAUDE.md -- Escape, Ctrl-C and Ctrl-D work
 * too, but nothing depends on them). The mouse stays yours while it is open: the world keeps
 * running and you keep looking about, as you would at a terminal. Up and down
 * walk the history, Tab completes a command (on an empty line it turns to the
 * other tab), Page Up and Page Down read back.
 *
 * It shows the whole of what the mud would have printed -- every event with
 * text, in order, on its own beat -- in the game's own type: serif for the
 * world, a small mono for what you typed and for the tabular replies.
 *
 * Two tabs: the whole log, and Talk, which holds only what people said to
 * each other (game-ui.js marks those lines; a mobile's words are not among
 * them). The panel can be pinned, with L or its button, so that it stays up
 * while the caret is out (Enter types again), and dragged larger by its top
 * right corner. A second window (the Pop out button) takes the same two
 * views, kept in step, for another screen. Size and tab are kept in this
 * browser.
 */

const STORE = 'diku3d.console';
const LOG_LIMIT = 400;
// Talk is the part worth reading back, and it is few lines next to the log.
const TALK_LIMIT = 1000;
const MIN_W = 300;
const MIN_H = 150;
/** What the title and the compass leave of the screen above the panel. */
const TOP_ROOM = 130;
const SIDE_ROOM = 52;
/** index.html's :root, which a window of its own does not inherit. */
const VARS = ['--ink', '--dim', '--gold', '--panel', '--edge', '--serif', '--mono'];

// What the two windows share: the tabs and the lines.
const SHARED = `
.g-con .bar { display: flex; align-items: center; gap: 2px; padding: 0 10px 0 8px; flex-shrink: 0;
  border-bottom: 1px solid rgba(224,189,119,0.14); }
.g-con .bar button { font: 400 9.5px var(--mono); letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--dim); background: transparent; border: 0; border-bottom: 2px solid transparent;
  padding: 9px 9px 7px; cursor: pointer; opacity: 0.72; }
.g-con .bar button:hover { opacity: 1; }
.g-con .bar button.on { color: var(--gold); border-bottom-color: var(--gold); opacity: 1; }
.g-con .bar .gap { flex: 1; }
.g-con .views { display: grid; grid-template-rows: minmax(0, 1fr); flex: 1 1 auto; min-height: 0; }
.g-con .scroll { grid-area: 1 / 1; overflow-y: auto; padding: 12px 16px 6px; scrollbar-width: thin;
  scrollbar-color: rgba(224,189,119,0.25) transparent; visibility: hidden;
  mask-image: linear-gradient(to bottom, transparent 0, #000 22px); }
.g-con .scroll.on { visibility: visible; }
.g-con .scroll.talk:empty::before { content: 'Nobody has said anything yet.'; display: block;
  font-size: 13px; font-style: italic; color: var(--dim); opacity: 0.7; }
.g-con .line { margin: 0; font-size: 14px; line-height: 1.5; color: #dccfb4; white-space: pre-wrap; }
.g-con .line + .line { margin-top: 1px; }
.g-con .line.cmd { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.04em;
  color: var(--gold); opacity: 0.85; margin-top: 9px; }
.g-con .line.cmd::before { content: '> '; opacity: 0.55; }
.g-con .line.table { font-family: var(--mono); font-size: 11.5px; line-height: 1.55; color: #d6c9ad; }
.g-con .line.them { color: #cf9d92; }
.g-con .line.gain { color: var(--gold); }
.g-con .line.faint { color: var(--dim); }
.g-con .line.speech { color: #e9dcc0; font-style: italic; }
.g-con .line.gate { color: #d8a24e; font-style: italic; }
/* Everything in Talk is somebody speaking: not the log's dim. */
.g-con .scroll.talk .line.faint { color: #dccfb4; }
`;

const CSS = `
#g-console { position: absolute; left: 26px; bottom: 26px; width: min(640px, 44vw);
  max-width: calc(100vw - ${SIDE_ROOM}px); max-height: min(56vh, 520px); display: flex; flex-direction: column;
  opacity: 0; visibility: hidden; transform: translateY(6px);
  transition: opacity 150ms ease, transform 150ms ease, visibility 0s linear 150ms;
  pointer-events: none; }
#g-console.sized { max-height: calc(100vh - ${TOP_ROOM}px); }
#g-console.on { opacity: 1; visibility: visible; transform: none; pointer-events: auto;
  transition: opacity 150ms ease, transform 150ms ease; }
#g-console .bar { padding-right: 24px; }
#g-console .bar button.on.pin { color: var(--gold); border-bottom-color: transparent; }
#g-console .grip { position: absolute; top: 0; right: 0; width: 20px; height: 20px; cursor: nesw-resize; touch-action: none; }
#g-console .grip::after { content: ''; position: absolute; top: 5px; right: 5px; width: 8px; height: 8px;
  border-top: 1px solid var(--gold); border-right: 1px solid var(--gold); opacity: 0.5; }
#g-console .grip:hover::after { opacity: 1; }
#g-console .row { display: flex; align-items: center; gap: 10px; padding: 9px 16px 11px;
  border-top: 1px solid rgba(224,189,119,0.14); flex-shrink: 0; }
#g-console:not(.typing) .row { opacity: 0.6; }
#g-console .row b { font-family: var(--mono); font-weight: 400; color: var(--gold); font-size: 13px; }
#g-console input { flex: 1; min-width: 0; text-overflow: ellipsis; background: transparent; border: 0; outline: 0; color: var(--ink);
  font-family: var(--mono); font-size: 13px; letter-spacing: 0.03em; caret-color: var(--gold); padding: 0; }
#g-console input::placeholder { color: var(--dim); opacity: 0.45; }
#g-console .row em { font-family: var(--mono); font-style: normal; font-size: 9.5px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--dim); opacity: 0.55; white-space: nowrap; flex-shrink: 0; }
`;

const POP_CSS = `
html, body { margin: 0; height: 100%; background: #12100d; color: var(--ink); font-family: var(--serif); }
.g-con.pop { display: flex; flex-direction: column; height: 100%; }
`;

/** Mud text is hard-wrapped at 80 columns; the paragraph breaks are the indented lines. */
function reflow(text) {
  const paragraphs = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (!paragraphs.length || /^ {2,}\S/.test(line)) paragraphs.push(line.trim());
    else paragraphs[paragraphs.length - 1] += ` ${line.trim()}`;
  }
  return paragraphs.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * The tabs and the two lists of lines, in `doc` -- the page's own or a pop-out
 * window's. A scroll that was at its foot stays there as lines arrive; one the
 * reader has scrolled up is left where it is.
 */
function createFace(doc, extra = []) {
  const bar = doc.createElement('div');
  bar.className = 'bar';
  // The mouse never takes the caret away from the prompt.
  bar.addEventListener('mousedown', (event) => event.preventDefault());
  const tabs = {};
  const scrolls = {};
  const views = doc.createElement('div');
  views.className = 'views';
  for (const [id, label] of [['log', 'Log'], ['talk', 'Talk']]) {
    const tab = doc.createElement('button');
    tab.type = 'button';
    tab.tabIndex = -1;
    tab.className = 'tab';
    tab.textContent = label;
    tab.dataset.tab = id;
    tabs[id] = tab;
    const scroll = doc.createElement('div');
    scroll.className = `scroll ${id}`;
    scrolls[id] = scroll;
    bar.appendChild(tab);
    views.appendChild(scroll);
  }
  const gap = doc.createElement('span');
  gap.className = 'gap';
  bar.append(gap, ...extra);

  const follow = { log: true, talk: true };
  for (const id of Object.keys(scrolls)) {
    const scroll = scrolls[id];
    // A scroll that is not on show has no height to judge by.
    scroll.addEventListener('scroll', () => {
      if (scroll.clientHeight) follow[id] = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 30;
    });
  }
  let current = 'log';

  return {
    bar, views, tabs, scrolls,
    get tab() { return current; },
    setTab(id) {
      current = id;
      for (const key of Object.keys(scrolls)) {
        scrolls[key].classList.toggle('on', key === id);
        tabs[key].classList.toggle('on', key === id);
      }
      this.stay();
    },
    /** One line at the foot of a list; `force` for what the reader just typed. */
    add(id, entry, limit, force = false) {
      const scroll = scrolls[id];
      const p = doc.createElement('p');
      p.className = `line ${entry.cls}`;
      p.textContent = entry.text;
      scroll.appendChild(p);
      while (scroll.children.length > limit) scroll.removeChild(scroll.firstChild);
      if (force) follow[id] = true;
      if (follow[id]) scroll.scrollTop = scroll.scrollHeight;
    },
    /** Back to the foot of whatever is being followed (`all`: and of what is not). */
    stay(all = false) {
      for (const id of Object.keys(scrolls)) {
        if (all) follow[id] = true;
        if (follow[id]) scrolls[id].scrollTop = scrolls[id].scrollHeight;
      }
    },
    page(direction) {
      const scroll = scrolls[current];
      scroll.scrollBy({ top: direction * scroll.clientHeight * 0.8 });
    },
  };
}

export function createConsole({ root, game, onOpen = () => {}, onClose = () => {}, onType = () => {} }) {
  const style = document.createElement('style');
  style.textContent = SHARED + CSS;
  document.head.appendChild(style);

  const box = document.createElement('div');
  box.id = 'g-console';
  box.className = 'panel g-con';
  const pin = document.createElement('button');
  pin.type = 'button';
  pin.tabIndex = -1;
  pin.className = 'pin';
  pin.textContent = 'Pin';
  pin.title = 'Keep it open while you play (L)';
  const pop = document.createElement('button');
  pop.type = 'button';
  pop.tabIndex = -1;
  pop.className = 'pop';
  pop.textContent = 'Pop out';
  pop.title = 'Open it in a window of its own';
  const main = createFace(document, [pin, pop]);
  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.title = 'Drag to resize';
  const row = document.createElement('div');
  row.className = 'row';
  const prompt = document.createElement('b');
  prompt.textContent = '>';
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  const hint = document.createElement('em');
  row.append(prompt, input, hint);
  box.append(main.bar, main.views, row, grip);
  root.appendChild(box);

  const history = [];
  let cursor = -1;
  /** The caret is in. */
  let open = false;
  /** Pinned: up while the caret is out. */
  let pinned = false;
  let visible = false;

  // -- what is kept in this browser: the tab, and the size once it was dragged --
  let size = null;
  function save() {
    try {
      window.localStorage.setItem(STORE, JSON.stringify({ tab: main.tab, size }));
    } catch (error) {
      console.warn(`console.js: the panel's size and tab cannot be kept in this browser: ${error.message}`);
    }
  }
  function applySize() {
    box.classList.toggle('sized', !!size);
    box.style.width = size ? `${size.w}px` : '';
    box.style.height = size ? `${size.h}px` : '';
  }
  {
    let kept = null;
    try {
      kept = JSON.parse(window.localStorage.getItem(STORE) || 'null');
    } catch (error) {
      console.warn(`console.js: the kept panel size and tab are unreadable, starting over: ${error.message}`);
    }
    if (kept && kept.size && kept.size.w > 0 && kept.size.h > 0) size = clampSize(kept.size.w, kept.size.h);
    main.setTab(kept && kept.tab === 'talk' ? 'talk' : 'log');
    applySize();
  }

  /** The two lists, as they were printed, for a window opened late. */
  const lines = { log: [], talk: [] };
  const limits = { log: LOG_LIMIT, talk: TALK_LIMIT };
  let popup = null;
  let popFace = null;
  const faces = () => (popFace ? [main, popFace] : [main]);

  /**
   * One line of output. `table` lines keep their columns in mono. `talk` is
   * game-ui.js's mark on what people said to each other; with none, a line
   * is in the full log only.
   */
  function print(text, cls = '', talk = false) {
    if (!text) return;
    const tabular = /\s{3,}\S/.test(text.trim()) || /^\[|^ {5}|^\(\s?\d+\)|^<\w/.test(text);
    const entry = { text: tabular ? text : reflow(text), cls: `${cls}${tabular ? ' table' : ''}` };
    for (const id of talk ? ['log', 'talk'] : ['log']) {
      lines[id].push(entry);
      if (lines[id].length > limits[id]) lines[id].shift();
      for (const face of faces()) face.add(id, entry, limits[id], cls === 'cmd' && id === 'log');
    }
  }

  const HINTS = {
    typing: 'tab switches \u00b7 enter closes',
    pinnedTyping: 'tab switches \u00b7 enter stops typing',
    pinned: 'l closes',
  };
  /** What the panel shows follows from two things: is the caret in, and is it pinned. */
  function settle() {
    const now = open || pinned;
    box.classList.toggle('typing', open);
    pin.classList.toggle('on', pinned);
    pin.setAttribute('aria-pressed', String(pinned));
    hint.textContent = open ? (pinned ? HINTS.pinnedTyping : HINTS.typing) : HINTS.pinned;
    input.placeholder = open ? 'look \u00b7 score \u00b7 help' : 'enter to type';
    if (now === visible) return;
    visible = now;
    box.classList.toggle('on', now);
    if (now) {
      main.stay(true);
      onOpen();
    } else {
      onClose();
    }
  }
  settle();

  function setTab(id) {
    main.setTab(id);
    save();
  }

  function show() {
    if (open) return;
    open = true;
    input.value = '';
    cursor = -1;
    settle();
    // Focus after the Enter that opened it has finished, so it is not typed.
    requestAnimationFrame(() => input.focus());
    onType(true);
  }

  /** The caret out; a panel that is not pinned goes with it. */
  function hide() {
    if (!open) return;
    open = false;
    input.blur();
    settle();
    onType(false);
  }

  function setPinned(on) {
    if (pinned === on) return;
    pinned = on;
    settle();
  }

  function run(line) {
    print(line, 'cmd');
    if (history[history.length - 1] !== line) history.push(line);
    if (history.length > 100) history.shift();
    // The picture belongs to the client, not the mud: it must never reach the server.
    const shot = /^(?:screenshot|shot)(?:\s+(hud))?$/i.exec(line);
    if (shot) {
      window.diku.screenshot({ hud: !!shot[1] }).then(
        (r) => print(`saved ${r.name}`, 'faint'),
        (e) => { console.error(e); print(e.message, 'them'); });
      return;
    }
    game.interpret(line);
  }

  function complete() {
    const text = input.value;
    if (/\s/.test(text) || !text) return;
    const names = game.commandNames().filter((n) => n.startsWith(text.toLowerCase()));
    if (names.length === 1) input.value = `${names[0]} `;
    else if (names.length > 1) print(names.slice(0, 24).join('  '), 'faint');
  }

  input.addEventListener('keydown', (event) => {
    // Nothing typed here is a key for the world: WASD, E, the arrows.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      const line = input.value.trim();
      input.value = '';
      cursor = -1;
      if (!line) { hide(); return; }
      run(line);
    } else if (event.key === 'Escape') {
      hide();
    } else if (event.ctrlKey && !event.metaKey && (event.key === 'c' || event.key === 'd')
      && input.selectionStart === input.selectionEnd) {
      // A terminal's ^C and ^D. With text selected, Ctrl-C is still copy.
      event.preventDefault();
      input.value = '';
      hide();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!history.length) return;
      cursor = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
      input.value = history[cursor];
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (cursor < 0) return;
      cursor += 1;
      if (cursor >= history.length) { cursor = -1; input.value = ''; } else input.value = history[cursor];
    } else if (event.key === 'Tab') {
      event.preventDefault();
      if (input.value) complete(); else setTab(main.tab === 'log' ? 'talk' : 'log');
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      // The wheel is the world's while the mouse is held; the keys read back.
      event.preventDefault();
      main.page(event.key === 'PageUp' ? -1 : 1);
    }
  });
  input.addEventListener('keyup', (event) => event.stopPropagation());
  // With the mouse held, the browser eats the first Escape to release it and
  // never delivers the keydown above -- so Escape seemed to do nothing but
  // free the mouse. Losing the lock while the page still has focus is that
  // Escape; losing it to another window (no focus) leaves the prompt open.
  document.addEventListener('pointerlockchange', () => {
    if (open && !document.pointerLockElement && document.hasFocus()) hide();
  });
  // A click in the world while typing gives the mouse back to the world.
  input.addEventListener('blur', () => { if (open) requestAnimationFrame(() => { if (open && document.activeElement !== input) input.focus(); }); });
  // With the mouse free, a click on the prompt of a pinned panel is typing.
  input.addEventListener('focus', () => { if (!open) show(); });

  for (const id of ['log', 'talk']) main.tabs[id].addEventListener('click', () => setTab(id));
  pin.addEventListener('click', () => setPinned(!pinned));

  // -- resizing: the panel grows up and to the right of its corner ----------
  function clampSize(w, h) {
    return {
      w: Math.round(Math.min(Math.max(w, MIN_W), window.innerWidth - SIDE_ROOM)),
      h: Math.round(Math.min(Math.max(h, MIN_H), window.innerHeight - TOP_ROOM)),
    };
  }
  let drag = null;
  grip.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const r = box.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, w: r.width, h: r.height };
  });
  grip.addEventListener('pointermove', (event) => {
    if (!drag) return;
    size = clampSize(drag.w + event.clientX - drag.x, drag.h - (event.clientY - drag.y));
    applySize();
    main.stay();
  });
  const drop = () => { if (drag) { drag = null; save(); } };
  grip.addEventListener('pointerup', drop);
  grip.addEventListener('pointercancel', drop);

  // -- a window of its own, with the same two views ----------------------------
  function popOut() {
    if (popup && !popup.closed) { popup.focus(); return popup; }
    const w = window.open('', 'diku-console', 'popup=yes,width=560,height=720');
    if (!w) {
      print('The browser did not open the window: allow pop-ups for this page and try again.', 'them');
      return null;
    }
    const build = () => {
      const doc = w.document;
      const vars = getComputedStyle(document.documentElement);
      doc.title = 'Diku3D \u00b7 command window';
      doc.head.replaceChildren();
      doc.body.replaceChildren();
      const css = doc.createElement('style');
      css.textContent = `:root { ${VARS.map((v) => `${v}: ${vars.getPropertyValue(v)};`).join(' ')} }${POP_CSS}${SHARED}`;
      doc.head.appendChild(css);
      const face = createFace(doc);
      const host = doc.createElement('div');
      host.className = 'g-con pop';
      host.append(face.bar, face.views);
      doc.body.appendChild(host);
      for (const id of ['log', 'talk']) {
        face.tabs[id].addEventListener('click', () => face.setTab(id));
        for (const entry of lines[id]) face.add(id, entry, limits[id]);
      }
      face.setTab(main.tab);
      face.stay(true);
      w.addEventListener('resize', () => face.stay());
      w.addEventListener('pagehide', () => {
        if (popup !== w) return;
        popup = null;
        popFace = null;
      });
      popup = w;
      popFace = face;
      w.focus();
    };
    if (w.document.readyState === 'complete') build();
    else w.addEventListener('load', build, { once: true });
    return w;
  }
  pop.addEventListener('click', popOut);
  // A window left open would be orphaned: nothing would fill it any more.
  window.addEventListener('pagehide', () => { if (popup && !popup.closed) popup.close(); });

  return {
    print, show, hide, run, popOut,
    get open() { return open; },
    get pinned() { return pinned; },
    /** On the screen: the caret is in, or it is pinned. */
    get visible() { return visible; },
    get tab() { return main.tab; },
    get popup() { return popup; },
    setTab,
    toggle() { if (open) hide(); else show(); },
    togglePin() { setPinned(!pinned); },
    element: box,
  };
}
