/**
 * The command line: interp.c's prompt in the corner of the world.
 *
 * Enter opens it and puts the caret in; Enter on an empty line closes it
 * again (the key that opened it, CLAUDE.md -- Escape works too but nothing
 * depends on it). The mouse stays yours while it is open: the world keeps
 * running and you keep looking about, as you would at a terminal. Up and down
 * walk the history, Tab completes a command.
 *
 * It shows the whole of what the mud would have printed -- every event with
 * text, in order, on its own beat -- in the game's own type: serif for the
 * world, a small mono for what you typed and for the tabular replies.
 */

const CSS = `
#g-console { position: absolute; left: 26px; bottom: 26px; width: min(640px, 44vw);
  max-height: min(56vh, 520px); display: flex; flex-direction: column;
  opacity: 0; visibility: hidden; transform: translateY(6px);
  transition: opacity 150ms ease, transform 150ms ease, visibility 0s linear 150ms;
  pointer-events: none; }
#g-console.on { opacity: 1; visibility: visible; transform: none; pointer-events: auto;
  transition: opacity 150ms ease, transform 150ms ease; }
#g-console .scroll { overflow-y: auto; padding: 12px 16px 6px; scrollbar-width: thin;
  scrollbar-color: rgba(224,189,119,0.25) transparent;
  mask-image: linear-gradient(to bottom, transparent 0, #000 28px); }
#g-console .line { margin: 0; font-size: 14px; line-height: 1.5; color: #dccfb4; white-space: pre-wrap; }
#g-console .line + .line { margin-top: 1px; }
#g-console .line.cmd { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.04em;
  color: var(--gold); opacity: 0.85; margin-top: 9px; }
#g-console .line.cmd::before { content: '> '; opacity: 0.55; }
#g-console .line.table { font-family: var(--mono); font-size: 11.5px; line-height: 1.55; color: #d6c9ad; }
#g-console .line.them { color: #cf9d92; }
#g-console .line.gain { color: var(--gold); }
#g-console .line.faint { color: var(--dim); }
#g-console .line.speech { color: #e9dcc0; font-style: italic; }
#g-console .line.gate { color: #d8a24e; font-style: italic; }
#g-console .row { display: flex; align-items: center; gap: 10px; padding: 9px 16px 11px;
  border-top: 1px solid rgba(224,189,119,0.14); }
#g-console .row b { font-family: var(--mono); font-weight: 400; color: var(--gold); font-size: 13px; }
#g-console input { flex: 1; background: transparent; border: 0; outline: 0; color: var(--ink);
  font-family: var(--mono); font-size: 13px; letter-spacing: 0.03em; caret-color: var(--gold); padding: 0; }
#g-console input::placeholder { color: var(--dim); opacity: 0.45; }
#g-console .row em { font-family: var(--mono); font-style: normal; font-size: 9.5px; letter-spacing: 0.14em;
  text-transform: uppercase; color: var(--dim); opacity: 0.55; white-space: nowrap; }
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

export function createConsole({ root, game, onOpen = () => {}, onClose = () => {} }) {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const box = document.createElement('div');
  box.id = 'g-console';
  box.className = 'panel';
  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  const row = document.createElement('div');
  row.className = 'row';
  const prompt = document.createElement('b');
  prompt.textContent = '>';
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.placeholder = "look · score · get all corpse · open gate · help";
  const hint = document.createElement('em');
  hint.textContent = 'enter on an empty line closes';
  row.append(prompt, input, hint);
  box.append(scroll, row);
  root.appendChild(box);

  const LIMIT = 400;
  const history = [];
  let cursor = -1;
  let open = false;

  /** One line of output. `table` lines keep their columns in mono. */
  function print(text, cls = '') {
    if (!text) return;
    const tabular = /\s{3,}\S/.test(text.trim()) || /^\[|^ {5}|^\(\s?\d+\)|^<\w/.test(text);
    const p = document.createElement('p');
    p.className = `line ${cls}${tabular ? ' table' : ''}`;
    p.textContent = tabular ? text : reflow(text);
    const stick = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 30;
    scroll.appendChild(p);
    while (scroll.children.length > LIMIT) scroll.removeChild(scroll.firstChild);
    if (stick || cls === 'cmd') scroll.scrollTop = scroll.scrollHeight;
  }

  function show() {
    if (open) return;
    open = true;
    box.classList.add('on');
    input.value = '';
    cursor = -1;
    // Focus after the Enter that opened it has finished, so it is not typed.
    requestAnimationFrame(() => input.focus());
    scroll.scrollTop = scroll.scrollHeight;
    onOpen();
  }

  function hide() {
    if (!open) return;
    open = false;
    box.classList.remove('on');
    input.blur();
    onClose();
  }

  function run(line) {
    print(line, 'cmd');
    if (history[history.length - 1] !== line) history.push(line);
    if (history.length > 100) history.shift();
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
      complete();
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

  return {
    print, show, hide, run,
    get open() { return open; },
    toggle() { if (open) hide(); else show(); },
    element: box,
  };
}
