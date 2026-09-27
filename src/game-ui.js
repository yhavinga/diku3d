/**
 * The game's overlay.
 *
 * It builds its own DOM rather than living in index.html, so the viewer runs
 * unchanged with the game switched off. Everything is styled off the custom
 * properties index.html already declares -- `--ink`, `--gold`, `--panel`,
 * `--edge`, `--serif`, `--mono` -- and reuses the `.panel` class, so it reads
 * as the same object as the room text and the minimap.
 *
 * Where things sit is decided by what is already on screen: the room title and
 * description own the left, the minimap the top right, so the game takes the
 * right rail underneath it and the far left middle. Nothing overlaps the
 * crosshair except the numbers that are supposed to fly past it.
 *
 * The text is the mud's. `game` hands over the lines fight.c would have printed
 * and this only decides what colour they are and how long they stay.
 */

import { WEAR_NAME, MERC, armourWord } from './game.js';

const CSS = `
#game-ui { position: fixed; inset: 0; pointer-events: none; z-index: 12;
  font-family: var(--serif); color: var(--ink); }
#game-ui .mono { font-family: var(--mono); }

/* ------------------------------------------------------------- vitals -- */
#g-vitals { position: absolute; right: 24px; bottom: 44px; width: 330px; padding: 11px 13px 9px; }
.g-bar { position: relative; height: 9px; margin-bottom: 5px; overflow: hidden;
  background: rgba(224,189,119,0.10); border-radius: 1px; }
.g-bar > i { position: absolute; inset: 0 auto 0 0; display: block; width: 0;
  transition: width 260ms cubic-bezier(.2,.7,.3,1); }
.g-bar.hp > i { background: linear-gradient(90deg, #8f3326, #c4553f); }
.g-bar.mana > i { background: linear-gradient(90deg, #3f5a7d, #6d8fb8); }
.g-bar.move > i { background: linear-gradient(90deg, #55643a, #8a9d5b); }
.g-bar > i.flash { background: #f4e7cb; transition: none; }
#g-prompt { font-family: var(--mono); font-size: 11px; letter-spacing: 0.09em;
  color: var(--gold); opacity: 0.82; margin-top: 7px; display: flex; justify-content: space-between; }
#g-prompt b { font-weight: 400; color: var(--ink); opacity: 0.72; }
#g-xp { height: 2px; margin-top: 7px; background: rgba(224,189,119,0.13); }
#g-xp > i { display: block; height: 100%; width: 0; background: var(--gold); opacity: 0.65;
  transition: width 300ms ease; }

/* ------------------------------------------------------------- target -- */
/* Only for a foe you cannot see: off the screen, behind you, round a wall.
   Whoever is in view is named over their own head (the plates below). */
#g-target { position: absolute; right: 24px; top: 446px; width: 330px; padding: 11px 13px 10px;
  opacity: 0; transition: opacity 160ms ease; }
#g-target.on { opacity: 1; }
#g-target .name { font-size: 18px; line-height: 1.2; }
#g-target .sub { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--gold); opacity: 0.75; margin-top: 4px; }
#g-target .cond { font-size: 13.5px; color: var(--dim); margin-top: 6px; font-style: italic; }
#g-target .where { font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em;
  text-transform: uppercase; color: #e8b96a; margin-top: 6px; }
#g-target .g-bar { margin-top: 8px; margin-bottom: 0; }

/* ---------------------------------------------------------------- log -- */
/* The left column, above the room's description and below the ways out:
   the right-hand one is the map, the compass and the vitals, and the log
   used to climb over all three. Its bottom and height are set from those
   two panels as they grow and shrink (placeLog). */
#g-log { position: absolute; left: 26px; bottom: 220px; width: min(40vw, 470px);
  max-height: 180px; overflow: hidden; display: flex;
  flex-direction: column; justify-content: flex-end; gap: 2px; }
/* A soft glow was the only thing separating these lines from the world, and
   over sunlit paving or a night street they simply drowned. Same cure as the
   in-world name labels: a thin dark edge does the work of a wide halo at a
   fraction of the ink -- plus a low plate per line, the description panel's
   own trick, so a message reads on any background at all. */
#g-log p { margin: 0; font-size: 13.5px; line-height: 1.42; color: #d9cdb4;
  background: rgba(16, 13, 9, 0.62); padding: 3px 9px; border-radius: 2px;
  align-self: flex-start; max-width: 100%;
  text-shadow: 0 0 1px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.85),
    0 -1px 2px rgba(0,0,0,0.85), 1px 0 2px rgba(0,0,0,0.85), -1px 0 2px rgba(0,0,0,0.85);
  animation: g-in 200ms ease both; }
#g-log p.you { color: #f0e3c8; }
#g-log p.them { color: #cf9d92; }
#g-log p.gain { color: var(--gold); }
#g-log p.dead { color: #e8d6a8; font-size: 15px; }
#g-log p.gate { color: #d8a24e; font-style: italic; }
#g-log p.faint { color: var(--dim); opacity: 0.72; font-size: 12.5px; }
@keyframes g-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }

/* ------------------------------------------------------------- floats -- */
/* Damage is a number beside the body it landed on, never under the plate:
   heavy, pale, and edged in near-black so it holds over noon paving and a
   night street alike. Size and colour climb with the share of the victim's
   health the blow took; a blow that takes a fifth or more is a crit and
   lands bigger, hotter, with a jolt. A miss is a word, in the same place. */
#g-floats { position: absolute; inset: 0; }
#g-floats span { position: absolute; left: 50%; top: 50%; font-family: var(--serif);
  font-size: 30px; font-weight: 700; line-height: 1; white-space: nowrap; letter-spacing: 0.01em;
  -webkit-text-stroke: 5px rgba(12,8,5,0.92); paint-order: stroke fill;
  text-shadow: 0 2px 10px rgba(0,0,0,0.55); will-change: transform, opacity; }
#g-floats span.word { font-weight: 600; font-style: italic; letter-spacing: 0.04em;
  -webkit-text-stroke: 4px rgba(12,8,5,0.9); }
#g-floats span.crit { text-shadow: 0 0 18px rgba(255,120,40,0.55), 0 2px 10px rgba(0,0,0,0.6); }
#g-floats span.note { font-size: 19px; font-weight: 600; -webkit-text-stroke: 3.5px rgba(12,8,5,0.85); }
#g-hurt { position: absolute; inset: 0; opacity: 0; pointer-events: none;
  background: radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 46%, rgba(120,18,12,0.42) 88%, rgba(70,8,6,0.62) 100%); }

/* ------------------------------------------------------------- plates -- */
/* Over the head of whoever you are fighting (the foe plate) and of whatever
   you are looking at (the focus plate): the name, and for a foe the mud's
   hitpoints as a bar with a pale trailing chunk that drains a beat after
   each blow, so how much a hit took is readable. Nobody else is named: a
   name over every head in ten metres was a coop of five "a chicken"s. */
.g-plate { position: absolute; left: 0; top: 0; width: 176px; transform: translate(-50%, -100%);
  text-align: center; opacity: 0; transition: opacity 180ms ease; will-change: transform; }
.g-plate.on { opacity: 1; }
.g-plate .n { font-size: 15.5px; line-height: 1.25; color: #f3e7cc; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  text-shadow: 0 0 1px rgba(0,0,0,0.95), 0 1px 2px rgba(0,0,0,0.85),
    0 -1px 2px rgba(0,0,0,0.85), 1px 0 2px rgba(0,0,0,0.85), -1px 0 2px rgba(0,0,0,0.85); }
.g-plate .b { position: relative; height: 6px; margin: 4px auto 0; width: 140px;
  background: rgba(14,11,8,0.72); box-shadow: 0 0 0 1px rgba(224,189,119,0.32), 0 1px 3px rgba(0,0,0,0.6); }
.g-plate .b i { position: absolute; inset: 0 auto 0 0; display: block; }
.g-plate .b i.lag { background: rgba(240,222,180,0.8); transition: width 520ms cubic-bezier(.4,0,.2,1) 260ms; }
.g-plate .b i.now { background: linear-gradient(90deg, #8f3326, #c4553f); transition: width 90ms linear; }
.g-plate .c { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--gold); opacity: 0.85; margin-top: 4px; white-space: nowrap;
  text-shadow: 0 0 1px rgba(0,0,0,0.95), 0 1px 2px rgba(0,0,0,0.85), 0 0 6px rgba(0,0,0,0.6); }
.g-plate .c.warden { color: #e0a24e; }
#g-focus .n { font-size: 14.5px; }

/* -------------------------------------------------------------- gates -- */
#g-gates { position: absolute; left: 26px; top: 132px; width: 300px; padding: 10px 13px 9px;
  opacity: 0; transition: opacity 220ms ease; }
#g-gates.on { opacity: 1; }
#g-gates h3 { margin: 0 0 7px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.2em;
  text-transform: uppercase; color: var(--gold); opacity: 0.7; font-weight: 400; }
#g-gates li { list-style: none; font-size: 13px; line-height: 1.45; color: var(--dim);
  display: flex; justify-content: space-between; gap: 10px; }
#g-gates ul { margin: 0; padding: 0; }
#g-gates li em { font-style: normal; font-family: var(--mono); font-size: 10px;
  letter-spacing: 0.08em; opacity: 0.75; white-space: nowrap; }
#g-gates li.open { color: var(--gold); text-decoration: line-through; text-decoration-thickness: 1px; }
#g-gates li.open em { text-decoration: none; }

/* -------------------------------------------------------------- sheet -- */
#g-sheet { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -46%);
  width: min(760px, 82vw); max-height: 78vh; overflow: auto; padding: 24px 28px 26px;
  opacity: 0; visibility: hidden; pointer-events: none;
  transition: opacity 170ms ease, transform 170ms ease; }
#g-sheet.on { opacity: 1; visibility: visible; pointer-events: auto; transform: translate(-50%, -50%); }
#g-sheet h2 { margin: 0 0 3px; font-size: 24px; color: var(--gold); font-weight: 400; }
#g-sheet .lede { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.13em;
  text-transform: uppercase; color: var(--dim); margin-bottom: 18px; }
#g-sheet .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 26px; }
#g-sheet h4 { margin: 0 0 8px; font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--gold); opacity: 0.72; font-weight: 400; }
#g-sheet ul { margin: 0 0 18px; padding: 0; }
#g-sheet li { list-style: none; font-size: 14px; line-height: 1.62; display: flex;
  justify-content: space-between; gap: 12px; border-bottom: 1px solid rgba(224,189,119,0.07); padding: 2px 0; }
#g-sheet li span.k { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em;
  color: var(--dim); text-transform: uppercase; white-space: nowrap; padding-top: 4px; }
#g-sheet li.act { cursor: pointer; }
#g-sheet li.act:hover { color: var(--gold); }
#g-sheet li.dim { color: var(--dim); opacity: 0.55; }
#g-sheet .foot { margin-top: 14px; font-family: var(--mono); font-size: 10.5px;
  letter-spacing: 0.12em; color: var(--dim); opacity: 0.6; }
#g-sheet .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px 14px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; color: var(--dim); margin-bottom: 18px; }
#g-sheet .stats b { color: var(--ink); font-weight: 400; }

/* ------------------------------------------------------------ prompts -- */
#g-hint { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%);
  font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--gold); opacity: 0; transition: opacity 150ms ease;
  text-shadow: 0 0 1px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.85),
    0 -1px 2px rgba(0,0,0,0.85), 1px 0 2px rgba(0,0,0,0.85), -1px 0 2px rgba(0,0,0,0.85); }
#g-hint.on { opacity: 1; }

/* -------------------------------------------------------------- level -- */
#g-level { position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 10px; opacity: 0; visibility: hidden;
  background: radial-gradient(ellipse at 50% 50%, rgba(224,170,90,0.20) 0%, rgba(0,0,0,0) 62%); }
#g-level.on { animation: g-level 3200ms ease both; }
#g-level .word { font-family: var(--mono); font-size: 12px; letter-spacing: 0.42em;
  text-transform: uppercase; color: var(--gold); text-indent: 0.42em; }
#g-level .num { font-size: clamp(64px, 12vw, 132px); line-height: 0.92; color: #f7ecd4;
  letter-spacing: 0.06em; text-shadow: 0 0 60px rgba(224,170,80,0.55); }
#g-level .title { font-size: 19px; color: var(--ink); opacity: 0.86; }
#g-level .gains { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0.14em;
  color: var(--gold); opacity: 0.8; }
/* ------------------------------------------------------------- spells -- */
/* The spells you know, along the bottom: the one you would cast lifted and
   edged in gold. A slot darkens from the top while you are still gathering
   yourself (the spell's beats), and dims when you have not the mana. */
#g-spells { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
  padding: 7px 9px 8px; display: none; }
#game-ui.caster #g-spells { display: block; }
#game-ui.caster #g-hint { bottom: 112px; }
#g-spells .keys { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--gold); opacity: 0.6; margin: 0 2px 6px; display: flex; justify-content: space-between; gap: 18px; }
#g-spells .slots { display: flex; gap: 5px; }
#g-spells .s { position: relative; width: 89px; height: 50px; padding: 6px 7px 5px; box-sizing: border-box;
  background: rgba(224,189,119,0.05); border: 1px solid rgba(224,189,119,0.14); border-radius: 2px;
  display: flex; flex-direction: column; justify-content: space-between; overflow: hidden;
  transition: transform 140ms ease, border-color 140ms ease, opacity 200ms ease; }
#g-spells .s::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--fam); opacity: 0.85; }
#g-spells .s.sel { border-color: rgba(224,189,119,0.75); transform: translateY(-3px);
  box-shadow: 0 6px 18px rgba(0,0,0,0.35), inset 0 0 18px rgba(224,189,119,0.08); }
#g-spells .s.poor { opacity: 0.42; }
#g-spells .s .n { font-size: 12.5px; line-height: 1.12; color: var(--ink); }
#g-spells .s .m { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.08em; color: var(--dim);
  display: flex; justify-content: space-between; }
#g-spells .s .cd { position: absolute; left: 0; right: 0; top: 0; height: 0; background: rgba(8,6,4,0.62); }
#g-spells .s.fire-flash { animation: g-cast 420ms ease-out; }
@keyframes g-cast { 0% { box-shadow: 0 0 0 0 var(--fam); } 30% { box-shadow: 0 0 22px 2px var(--fam); } 100% { box-shadow: 0 0 0 0 rgba(0,0,0,0); } }

@keyframes g-level {
  0% { opacity: 0; visibility: visible; }
  9% { opacity: 1; }
  76% { opacity: 1; }
  100% { opacity: 0; visibility: visible; }
}

/* ---------------------------------------------------------- the ending -- */
#g-ending { position: absolute; left: 50%; top: 34%; transform: translateX(-50%);
  text-align: center; opacity: 0; visibility: hidden; }
#g-ending.on { animation: g-level 6000ms ease both; }
#g-ending .num { font-size: clamp(34px, 5vw, 58px); color: #f7ecd4; letter-spacing: 0.1em; }
#g-ending .word { font-family: var(--mono); font-size: 11px; letter-spacing: 0.34em;
  text-transform: uppercase; color: var(--gold); margin-top: 10px; }
`;

const el = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

export function createGameUi(game) {
  const style = el('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = el('div');
  root.id = 'game-ui';

  // -- vitals ---------------------------------------------------------------
  const vitals = el('div', 'panel');
  vitals.id = 'g-vitals';
  const bar = (kind) => {
    const box = el('div', `g-bar ${kind}`);
    const fill = el('i');
    box.appendChild(fill);
    vitals.appendChild(box);
    return fill;
  };
  const hpFill = bar('hp');
  const manaFill = bar('mana');
  const moveFill = bar('move');
  const prompt = el('div');
  prompt.id = 'g-prompt';
  const promptLeft = el('span');
  const promptRight = el('span');
  prompt.append(promptLeft, promptRight);
  vitals.appendChild(prompt);
  const xpTrack = el('div');
  xpTrack.id = 'g-xp';
  const xpFill = el('i');
  xpTrack.appendChild(xpFill);
  vitals.appendChild(xpTrack);
  root.appendChild(vitals);

  // -- target ---------------------------------------------------------------
  const target = el('div', 'panel');
  target.id = 'g-target';
  const tName = el('div', 'name');
  const tSub = el('div', 'sub');
  const tBarBox = el('div', 'g-bar hp');
  const tBar = el('i');
  tBarBox.appendChild(tBar);
  const tCond = el('div', 'cond');
  const tWhere = el('div', 'where');
  target.append(tName, tSub, tBarBox, tCond, tWhere);
  root.appendChild(target);

  // -- log ------------------------------------------------------------------
  const log = el('div');
  log.id = 'g-log';
  root.appendChild(log);

  // -- floats and the hurt vignette ----------------------------------------
  const floats = el('div');
  floats.id = 'g-floats';
  const hurt = el('div');
  hurt.id = 'g-hurt';
  const foe = el('div', 'g-plate');
  foe.id = 'g-foe';
  const foeName = el('div', 'n');
  const foeBar = el('div', 'b');
  const foeLag = el('i', 'lag');
  const foeNow = el('i', 'now');
  foeBar.append(foeLag, foeNow);
  const foeCond = el('div', 'c');
  foe.append(foeName, foeBar, foeCond);
  const focusPlate = el('div', 'g-plate');
  focusPlate.id = 'g-focus';
  const focusName = el('div', 'n');
  const focusSub = el('div', 'c');
  focusPlate.append(focusName, focusSub);
  root.append(hurt, focusPlate, foe, floats);

  // -- gates ----------------------------------------------------------------
  const gatesPanel = el('div', 'panel');
  gatesPanel.id = 'g-gates';
  gatesPanel.appendChild(el('h3', null, 'the ways out'));
  const gatesList = el('ul');
  gatesPanel.appendChild(gatesList);
  root.appendChild(gatesPanel);

  // -- sheet ----------------------------------------------------------------
  const sheet = el('div', 'panel');
  sheet.id = 'g-sheet';
  root.appendChild(sheet);

  // -- prompts and moments --------------------------------------------------
  const hint = el('div');
  hint.id = 'g-hint';
  const levelUp = el('div');
  levelUp.id = 'g-level';
  const ending = el('div');
  ending.id = 'g-ending';
  root.append(hint, levelUp, ending);

  // -- spells ---------------------------------------------------------------
  const spellBar = el('div', 'panel');
  spellBar.id = 'g-spells';
  spellBar.append(el('div', 'keys', '<span>z · x — choose</span><span>c · right-click — cast</span>'));
  const spellSlots = el('div', 'slots');
  spellBar.appendChild(spellSlots);
  root.appendChild(spellBar);

  document.body.appendChild(root);

  // -- log ------------------------------------------------------------------
  // Seven, not fourteen: at fourteen the log grew over the compass and all
  // three vitals bars and sat there for the rest of the session ("You have
  // been KILLED!!" rendered on top of the HP bar). And lines expire -- a
  // quiet minute should hand the corner of the screen back to the HUD.
  const LINES = 7;
  const LINE_TTL = 11000;
  function say(text, cls = '') {
    if (!text) return;
    const line = el('p', cls, text);
    log.appendChild(line);
    setTimeout(() => {
      if (!line.parentNode) return;
      line.style.transition = 'opacity 900ms ease';
      line.style.opacity = '0';
      setTimeout(() => line.remove(), 950);
    }, LINE_TTL);
    while (log.children.length > LINES) log.removeChild(log.firstChild);
    // Old lines fade rather than vanish, so the eye stays on the newest.
    const kids = log.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i].style.opacity = String(Math.min(1, 0.28 + (i / Math.max(1, kids.length - 1)) * 0.72));
    }
  }

  /** Experience, gold: a note that rises over the crosshair and goes. */
  function float(text, colour) {
    const node = el('span', 'note', text);
    node.style.color = colour;
    floats.appendChild(node);
    const dx = (Math.random() - 0.5) * 60;
    node.animate([
      { transform: `translate(-50%, -50%) translate(${dx * 0.25}px, 40px) scale(0.85)`, opacity: 0 },
      { transform: `translate(-50%, -50%) translate(${dx * 0.55}px, 10px) scale(1.04)`, opacity: 1, offset: 0.18 },
      { transform: `translate(-50%, -50%) translate(${dx}px, -40px) scale(1)`, opacity: 0 },
    ], { duration: 1500, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => node.remove();
  }

  /** A body's chest on screen, and how many pixels a metre is at its distance. */
  function bodyOnScreen(slot) {
    const fig = slot && slot.figure;
    if (!project || !fig || !fig.at) return null;
    const h = fig.height || 1.7;
    const y = fig.at.y + Math.min(h * 0.62, 1.4);
    const chest = project(fig.at.x, y, fig.at.z);
    const above = project(fig.at.x, y + 0.5, fig.at.z);
    if (!chest || !above) return null;
    const perMetre = Math.max(12, Math.abs(chest.y - above.y) * 2);
    const reach = fig.body ? fig.body.r + fig.body.h * 0.6 : 0.3;
    return { x: chest.x, y: chest.y, half: Math.max(0.24, reach) * perMetre };
  }

  /**
   * The number (or the word) for one blow, beside the body it landed on --
   * alternating sides so a flurry does not stack on itself -- or, for a blow
   * on you, down and left of the crosshair where the vignette already says
   * you were hit. Spells are blows here too, drawn the same way.
   */
  const recent = new Map();
  function blowNumber(event) {
    const onYou = !event.to;
    let text; let colour; let size; let cls = ''; let crit = false;
    if (event.kind === 'hit') {
      const share = event.dam / Math.max(1, event.maxHp || (onYou ? game.state.maxHit : 20));
      crit = share >= 0.2 && event.dam >= 4;
      text = onYou ? `-${event.dam}` : String(event.dam);
      size = Math.round(28 + Math.min(22, share * 90) + (crit ? 8 : 0));
      colour = onYou ? '#ff6b52'
        : crit ? '#ff8a3a' : share >= 0.1 ? '#ffc86a' : share >= 0.05 ? '#ffe3a8' : '#f6eedc';
      if (crit) cls = 'crit';
    } else {
      text = event.kind === 'miss' ? 'miss' : (onYou ? event.kind : (event.kind === 'parry' ? 'parried' : 'dodged'));
      colour = event.kind === 'miss' ? '#d9d2c2' : '#b9d2f4';
      size = 23;
      cls = 'word';
    }
    let x; let y; let side;
    const body = onYou ? null : bodyOnScreen(event.to);
    if (body) {
      const key = event.to;
      const last = recent.get(key) || { side: -1, t: 0, n: 0 };
      const now = performance.now();
      side = -last.side;
      const n = now - last.t < 700 ? last.n + 1 : 0;
      recent.set(key, { side, t: now, n });
      x = body.x + side * (body.half + 14);
      y = body.y - 8 - (n % 3) * 20;
    } else {
      // On you, or on something out of sight: beside the crosshair.
      side = onYou ? -1 : 1;
      x = window.innerWidth / 2 + side * 70;
      y = window.innerHeight / 2 + (onYou ? 46 : -30);
    }
    const node = el('span', cls, text);
    node.style.color = colour;
    node.style.fontSize = `${size}px`;
    node.style.left = `${x.toFixed(1)}px`;
    node.style.top = `${y.toFixed(1)}px`;
    floats.appendChild(node);
    const ax = side > 0 ? '0%' : '-100%';
    const drift = side * (10 + Math.random() * 8);
    const rise = onYou ? 34 : 58;
    const frames = crit
      ? [
        { transform: `translate(${ax}, -50%) scale(1.75)`, opacity: 0 },
        { transform: `translate(${ax}, -50%) translate(${side * 4}px, -4px) scale(1.2)`, opacity: 1, offset: 0.08 },
        { transform: `translate(${ax}, -50%) translate(${-side * 3}px, -8px) scale(1.05)`, opacity: 1, offset: 0.16 },
        { transform: `translate(${ax}, -50%) translate(${drift * 0.5}px, -${rise * 0.4}px) scale(1)`, opacity: 1, offset: 0.62 },
        { transform: `translate(${ax}, -50%) translate(${drift}px, -${rise}px) scale(0.96)`, opacity: 0 },
      ]
      : [
        { transform: `translate(${ax}, -50%) scale(1.3)`, opacity: 0 },
        { transform: `translate(${ax}, -50%) translate(0, -4px) scale(1)`, opacity: 1, offset: 0.1 },
        { transform: `translate(${ax}, -50%) translate(${drift * 0.5}px, -${rise * 0.45}px) scale(1)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${ax}, -50%) translate(${drift}px, -${rise}px) scale(0.95)`, opacity: 0 },
      ];
    node.animate(frames, { duration: crit ? 1500 : 1250, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => node.remove();
  }

  function flashHurt(strength) {
    hurt.animate(
      [{ opacity: 0 }, { opacity: Math.min(0.9, 0.25 + strength) }, { opacity: 0 }],
      { duration: 420, easing: 'ease-out' },
    );
  }

  // -- the sheet ------------------------------------------------------------
  let sheetMode = null;

  // The overlay normally sits under index.html's click-to-lock catcher, which
  // is at z-index 20. An open sheet has to go over it: you release the mouse to
  // click the sheet, and releasing the mouse is what puts the catcher up.
  const lift = (up) => { root.style.zIndex = up ? '21' : '12'; };

  /** A scroll of identify waiting for something to be read at. */
  let reading = null;

  function closeSheet() { reading = null; sheetMode = null; sheet.classList.remove('on'); lift(false); }

  function openSheet(mode) {
    if (sheetMode === mode) return closeSheet();
    sheetMode = mode;
    sheet.classList.add('on');
    lift(true);
    return drawSheet();
  }

  function row(left, right, { cls = '', onClick = null } = {}) {
    const li = el('li', `${cls}${onClick ? ' act' : ''}`);
    li.append(el('span', null, left), el('span', 'k', right));
    if (onClick) li.addEventListener('click', () => { onClick(); drawSheet(); });
    return li;
  }

  function drawSheet() {
    if (!sheetMode) return;
    const s = game.state;
    sheet.textContent = '';

    if (sheetMode === 'gear') {
      sheet.append(el('h2', null, `${s.className} of the ${s.level}th level`));
      sheet.append(el('div', 'lede', `${s.exp} exp · ${s.expToLevel} to go · ${s.gold} gold`));
      const stats = el('div', 'stats');
      // do_score's own numbers: hitroll and damroll with str_app already in
      // them, and the armour class as the mud words it rather than as an
      // integer that gets better as it gets smaller.
      for (const [k, v] of [
        ['str', MERC.currStr(s)], ['int', MERC.currInt(s)], ['wis', MERC.currWis(s)],
        ['dex', MERC.currDex(s)], ['con', MERC.currCon(s)], ['armor', s.ac],
        ['hitroll', MERC.getHitroll(s)], ['damroll', MERC.getDamroll(s)],
      ]) stats.append(el('div', null, `${k} <b>${v}</b>`));
      sheet.append(stats);
      sheet.append(el('div', 'lede', `you are ${armourWord(s)}`));

      const cols = el('div', 'cols');
      const left = el('div');
      left.append(el('h4', null, 'worn'));
      const wornList = el('ul');
      let worn = 0;
      s.equipment.forEach((obj, i) => {
        if (!obj) return;
        worn += 1;
        const verb = game.magic && game.magic.itemVerb(obj);
        if (verb === 'zap' || verb === 'brandish') {
          // A wand or a staff in hand is for using; putting it away is the second line.
          wornList.append(row(obj.name, `${WEAR_NAME[i]} · ${verb}`, { onClick: () => game.useItem(obj) }));
          wornList.append(row('put it away', 'remove', { cls: 'dim', onClick: () => game.remove(i) }));
          return;
        }
        wornList.append(row(obj.name, `${WEAR_NAME[i]} · remove`, { onClick: () => game.remove(i) }));
      });
      if (!worn) wornList.append(row('nothing but your own skin', '', { cls: 'dim' }));
      left.append(wornList);

      const right = el('div');
      right.append(el('h4', null, reading ? `recite ${reading.name} at what?` : `carried — ${s.carryWeight}/${s.carryMax} lb`));
      const bagList = el('ul');
      if (!s.inventory.length) bagList.append(row('your hands are empty', '', { cls: 'dim' }));
      for (const obj of s.inventory.slice()) {
        if (reading) {
          if (obj === reading) continue;
          bagList.append(row(obj.name, 'this', { onClick: () => { const scroll = reading; reading = null; game.useItem(scroll, { targetObj: obj }); } }));
          continue;
        }
        // Potions, pills and scrolls are used from the pack; a wand or a staff
        // has to be held first (do_zap and do_brandish read WEAR_HOLD).
        const verb = game.magic && game.magic.itemVerb(obj);
        if (verb === 'quaff' || verb === 'eat' || verb === 'recite') {
          const aimed = verb === 'recite' && game.magic.wantsObject(obj);
          bagList.append(row(obj.name, `${obj.weight} lb · ${verb}${aimed ? '…' : ''}`, {
            onClick: () => { if (aimed) reading = obj; else game.useItem(obj); },
          }));
          continue;
        }
        bagList.append(row(obj.name, `${obj.weight} lb · ${verb ? 'hold' : 'wear'}`, { onClick: () => game.wear(obj) }));
      }
      if (reading) bagList.append(row('never mind', '', { cls: 'dim', onClick: () => { reading = null; } }));
      right.append(bagList);

      const pile = game.here();
      if (pile.length) {
        right.append(el('h4', null, 'on the ground'));
        const groundList = el('ul');
        for (const heap of pile) {
          groundList.append(row(heap.name, `${heap.contents.length} · take all`, { onClick: () => game.takeAll(heap) }));
        }
        right.append(groundList);
      }
      cols.append(left, right);
      sheet.append(cols, el('div', 'foot', 'i — close · t — take everything here'));
      return;
    }

    if (sheetMode === 'shop') {
      const shop = game.shopHere();
      if (!shop) {
        sheet.append(el('h2', null, 'Nobody here is selling'), el('div', 'lede', 'find a shopkeeper'),
          el('div', 'foot', 'b — close'));
        return;
      }
      sheet.append(el('h2', null, shop.name));
      sheet.append(el('div', 'lede',
        `${shop.open ? 'open' : `shut — trades ${shop.hours[0]}:00 to ${shop.hours[1]}:00`} · you have ${game.state.gold} gold`));
      const cols = el('div', 'cols');
      const left = el('div');
      left.append(el('h4', null, 'for sale'));
      const stock = el('ul');
      if (!shop.stock.length) stock.append(row('the shelves are bare', '', { cls: 'dim' }));
      for (const entry of shop.stock) {
        const afford = game.state.gold >= entry.cost && entry.obj.level <= game.state.level;
        stock.append(row(entry.obj.name,
          entry.obj.level > game.state.level ? `level ${entry.obj.level}` : `${entry.cost} gold`,
          { cls: afford ? '' : 'dim', onClick: afford ? () => game.buy(shop.keeper, entry.obj.vnum) : null }));
      }
      left.append(stock);
      const right = el('div');
      right.append(el('h4', null, 'your pack'));
      const bag = el('ul');
      if (!game.state.inventory.length) bag.append(row('nothing to sell', '', { cls: 'dim' }));
      for (const obj of game.state.inventory.slice()) {
        const wanted = shop.sellsBack.includes(obj.itemType);
        bag.append(row(obj.name, wanted ? 'sell' : 'not wanted',
          { cls: wanted ? '' : 'dim', onClick: wanted ? () => game.sell(shop.keeper, obj) : null }));
      }
      right.append(bag);
      cols.append(left, right);
      sheet.append(cols, el('div', 'foot', 'b — close'));
      return;
    }

    if (sheetMode === 'skills') {
      const s2 = game.state;
      sheet.append(el('h2', null, 'What you know'));
      sheet.append(el('div', 'lede', `${s2.practice} practice session${s2.practice === 1 ? '' : 's'} left`
        + ' · a guildmaster has to be standing here'));
      const list = el('ul');
      for (const skill of game.skills()) {
        const can = skill.available && s2.practice > 0 && skill.learned < skill.adept;
        list.append(row(`${skill.name} — ${skill.learned}%`,
          skill.available ? (skill.learned >= skill.adept ? 'adept' : 'practice') : `level ${skill.level}`,
          { cls: skill.available ? '' : 'dim', onClick: can ? () => game.practice(skill.key) : null }));
      }
      sheet.append(list, el('div', 'foot', 'k — close'));
    }
  }

  // -- the moments ----------------------------------------------------------
  function showLevel(event) {
    levelUp.textContent = '';
    levelUp.append(
      el('div', 'word', 'you raise a level'),
      el('div', 'num', String(event.level)),
      el('div', 'title', event.title || ''),
      el('div', 'gains', `+${event.gains.hp} hp   +${event.gains.mana} mana`
        + `   +${event.gains.move} mv   +${event.gains.prac} prac`),
    );
    levelUp.classList.remove('on');
    void levelUp.offsetWidth;                    // restart the animation
    levelUp.classList.add('on');
    for (const fill of [hpFill, manaFill, moveFill]) {
      fill.classList.add('flash');
      setTimeout(() => fill.classList.remove('flash'), 220);
    }
  }

  function showEnding(text) {
    ending.textContent = '';
    ending.append(el('div', 'num', text), el('div', 'word', 'the world is larger than this town'));
    ending.classList.remove('on');
    void ending.offsetWidth;
    ending.classList.add('on');
  }

  // -- events ---------------------------------------------------------------
  /**
   * Each event shows on its own beat: game.js resolves a round all at once
   * and stamps every blow with `delay`, the moment its swing connects. The log
   * line, the number and the flinch all wait for it -- and so does the damage
   * on the bars, which count what is still on its way back in.
   */
  const pending = [];
  let project = null;

  function consume() {
    const now = performance.now();
    for (const event of game.drain()) {
      if (event.delay > 0) pending.push({ at: now + event.delay * 1000, event });
      else show(event);
    }
    for (let i = 0; i < pending.length;) {
      if (pending[i].at <= now) show(pending.splice(i, 1)[0].event);
      else i++;
    }
  }

  /** Damage already dealt by the rules and not yet shown, to you (null) or a mobile. */
  function unshown(slot) {
    let dam = 0;
    for (const { event } of pending) {
      if (event.kind === 'hit' && (event.to || null) === slot) dam += event.dam;
    }
    return dam;
  }

  /**
   * Where a plate goes: over the head, if the head is on screen and not
   * behind a wall. The dragon's plate was drawn on the wall of its cave. The
   * line of sight is a slab test against the colliders (nav.js), asked every
   * sixth frame per body, which is cheap enough to never think about.
   */
  const sight = new Map();
  let frame = 0;
  function plateAt(slot, lift) {
    const at = headOf(slot, lift);
    if (!at) return null;
    const fig = slot.figure;
    let seen = sight.get(slot);
    if (!seen || frame - seen.frame >= 6) {
      const eye = game.eye;
      const blocked = !!(game.nav && game.nav.sightBlocked && game.nav.sightBlocked(
        eye.x, eye.y, eye.z, fig.at.x, fig.at.y + (fig.height || 1.7) * 0.9, fig.at.z));
      seen = { frame, blocked };
      sight.set(slot, seen);
    }
    if (seen.blocked) return null;
    // Close up the head is off the top of the frame; the plate is not.
    at.y = Math.max(at.y, 64);
    return at;
  }

  /** Which way to turn to find someone you cannot see. */
  function whereIs(slot) {
    const fig = slot && slot.figure;
    if (!fig) return '';
    const eye = game.eye; const face = game.facing;
    const dx = fig.at.x - eye.x; const dz = fig.at.z - eye.z;
    const d = Math.hypot(dx, dz) || 1;
    const ahead = (dx * face.x + dz * face.z) / d;
    // Right of facing (x, z) is (-z, x) with north at -z.
    const right = (dx * -face.z + dz * face.x) / d;
    if (ahead < -0.55) return 'behind you';
    if (ahead > 0.6) return 'ahead, out of sight';
    return right > 0 ? 'to your right' : 'to your left';
  }

  /**
   * The log sits between the ways out (or the room's title) and the room's
   * description, whose height changes with every room.
   */
  function placeLog() {
    const desc = document.getElementById('desc-block');
    const title = document.getElementById('room-block');
    if (!desc) return;
    const d = desc.getBoundingClientRect();
    let top = title ? title.getBoundingClientRect().bottom : 0;
    if (gatesPanel.classList.contains('on')) top = Math.max(top, gatesPanel.getBoundingClientRect().bottom);
    const bottom = window.innerHeight - d.top + 10;
    log.style.bottom = `${Math.round(bottom)}px`;
    log.style.maxHeight = `${Math.max(60, Math.round(d.top - 10 - (top + 12)))}px`;
  }

  /** Where a mobile's head is on screen, if it is on screen. */
  function headOf(slot, lift = 0.3) {
    const fig = slot && slot.figure;
    if (!project || !fig || !fig.at) return null;
    return project(fig.at.x, fig.at.y + (fig.height || 1.7) + lift, fig.at.z);
  }

  function show(event) {
    {
      switch (event.kind) {
        case 'hit':
          say(event.text, event.byPlayer ? 'you' : 'them');
          blowNumber(event);
          if (!event.to) flashHurt(Math.min(0.6, event.dam / Math.max(1, game.state.maxHit)));
          break;
        case 'miss':
          say(event.text, 'faint');
          blowNumber(event);
          break;
        case 'parry': case 'dodge':
          say(event.text, 'faint');
          blowNumber(event);
          break;
        case 'death':
          say(event.text, 'dead');
          if (event.player) flashHurt(0.9);
          break;
        case 'xp':
          say(event.text, 'gain');
          if (event.amount > 0) float(`+${event.amount} exp`, '#e0bd77');
          break;
        case 'gold':
          say(event.text, 'gain');
          float(`+${event.amount} gold`, '#e8c979');
          break;
        case 'level':
          say(event.text, 'gain');
          showLevel(event);
          break;
        case 'gate':
          say(event.text, 'gate');
          drawGates();
          break;
        case 'gate-seen':
          say(event.text, 'faint');
          drawGates();
          break;
        case 'ending':
          say(event.text, 'gate');
          showEnding(event.text);
          break;
        case 'buy': case 'sell': case 'wear': case 'remove': case 'drop':
        case 'pickup': case 'practice':
          say(event.text, 'gain');
          if (sheetMode) drawSheet();
          break;
        case 'say':
          say(event.text, 'faint');
          break;
        case 'magic':
          say(event.text, event.tone || 'faint');
          break;
        case 'recall':
          say(event.text, 'gate');
          break;
        default:
          say(event.text, 'faint');
          break;
      }
    }
  }

  // -- the gate board -------------------------------------------------------
  function drawGates() {
    const seen = game.gates.filter((gate) => gate.seen || gate.open);
    gatesPanel.classList.toggle('on', seen.length > 0);
    gatesList.textContent = '';
    for (const gate of seen) {
      const li = el('li', gate.open ? 'open' : '');
      li.append(
        el('span', null, gate.name),
        el('em', null, gate.open ? 'open' : `${gate.wardenName} · ${gate.wardenLevel}`),
      );
      gatesList.appendChild(li);
    }
  }

  // -- the spell bar ---------------------------------------------------------
  // What `game.spells()` says you can cast, a window of seven at a time round
  // the one chosen. Z and X (or the wheel) choose, C (or the right button)
  // casts -- whoever you are fighting or looking at for an attack, yourself
  // for the rest.
  const FAMILY_COLOUR = {
    missile: '#a58cff', prism: '#e8a0ff', fireball: '#e87a3a', flame: '#e87a3a', flamestrike: '#e87a3a',
    lightning: '#9fc4ff', shock: '#9fc4ff', storm: '#9fc4ff', frost: '#9fd8ff', acid: '#9ad84a',
    heal: '#f0cf8a', refresh: '#9fe8c8', ward: '#9fb8ff', bless: '#f0d27a', sanctuary: '#f4f4f4',
    curse: '#9a6ad0', hex: '#9a6ad0', weaken: '#8a7aa8', blind: '#8a7aa8', harm: '#d0503a', drain: '#d0503a',
    poison: '#8ac850', faerie: '#f08ac8', holy: '#f4e2a8', dispel: '#8fe8f0', quake: '#c8a878',
  };
  let spellList = [];
  let spellSel = 0;
  let spellSig = '';
  const slotNodes = [];

  /**
   * The bar lives in the gap between the room's description (left, up to
   * 40vw) and the vitals (right, 354 px), centred in it, with as many slots
   * as fit -- three on a small window, seven on a wide one.
   */
  function place() {
    const w = window.innerWidth;
    const from = 26 + 0.4 * w + 14;
    const to = w - 354 - 14;
    spellBar.style.left = `${(from + to) / 2}px`;
    return Math.max(3, Math.min(7, Math.floor((to - from - 18 + 5) / 94)));
  }

  function drawSpells() {
    spellSlots.textContent = '';
    slotNodes.length = 0;
    const WINDOW = place();
    const first = Math.max(0, Math.min(spellSel - Math.floor(WINDOW / 2), spellList.length - WINDOW));
    for (let i = first; i < Math.min(spellList.length, first + WINDOW); i++) {
      const sp = spellList[i];
      const node = el('div', `s${i === spellSel ? ' sel' : ''}`);
      node.style.setProperty('--fam', FAMILY_COLOUR[sp.family] || '#e0bd77');
      const cd = el('i', 'cd');
      node.append(el('div', 'n', sp.name), el('div', 'm', `<span>${sp.mana} m</span><span>${sp.learned}%</span>`), cd);
      spellSlots.appendChild(node);
      slotNodes.push({ node, cd, sp });
    }
  }

  function chooseSpell(step) {
    if (!spellList.length) return;
    spellSel = (spellSel + step + spellList.length) % spellList.length;
    drawSpells();
  }

  function castSelected() {
    const sp = spellList[spellSel];
    if (!sp || sheetMode) return;
    const result = game.cast(sp.name);
    const slot = slotNodes.find((x) => x.sp.name === sp.name);
    if (slot && result.ok) {
      slot.node.classList.remove('fire-flash');
      void slot.node.offsetWidth;
      slot.node.classList.add('fire-flash');
    }
  }

  function updateSpells() {
    const list = game.spells ? game.spells() : [];
    const sig = list.map((x) => `${x.name}:${x.mana}:${x.learned}`).join('|');
    if (sig !== spellSig) {
      const keep = spellList[spellSel] && spellList[spellSel].name;
      spellList = list;
      spellSig = sig;
      const at = list.findIndex((x) => x.name === keep);
      spellSel = at >= 0 ? at : Math.min(spellSel, Math.max(0, list.length - 1));
      root.classList.toggle('caster', list.length > 0);
      // index.html's prompt under the crosshair moves up over the spell bar.
      document.body.classList.toggle('g-caster', list.length > 0);
      drawSpells();
    }
    if (!spellList.length) return;
    const wait = game.magic ? game.magic.wait : 0;
    for (const { node, cd, sp } of slotNodes) {
      node.classList.toggle('poor', game.state.mana < sp.mana);
      cd.style.height = `${Math.min(100, (wait / 3) * 100)}%`;
    }
  }

  // The wheel and the right button, only while you are playing (the mouse is
  // captured): with it released they belong to the page and the sheets.
  const playing = () => !!document.pointerLockElement && !sheetMode;
  function onWheel(event) {
    if (!playing() || !spellList.length) return;
    chooseSpell(event.deltaY > 0 ? 1 : -1);
  }
  function onMouse(event) {
    if (event.button === 2 && playing()) castSelected();
  }
  const noMenu = (event) => { if (document.pointerLockElement) event.preventDefault(); };
  document.addEventListener('wheel', onWheel, { passive: true });
  document.addEventListener('mousedown', onMouse);
  document.addEventListener('contextmenu', noMenu);
  window.addEventListener('resize', () => { if (spellList.length) drawSpells(); });

  // The title screen's class choice, and `?class=` for a link straight in.
  {
    const CLASSES = ['mage', 'cleric', 'thief', 'warrior'];
    const pick = document.getElementById('class-pick');
    const choose = (index) => {
      if (!game.chooseClass || !game.chooseClass(index)) return;
      if (pick) for (const b of pick.querySelectorAll('button')) b.classList.toggle('on', Number(b.dataset.class) === index);
    };
    if (pick) {
      pick.addEventListener('click', (event) => {
        const b = event.target.closest('button[data-class]');
        if (b) choose(Number(b.dataset.class));
      });
    }
    const wanted = CLASSES.indexOf(new URLSearchParams(location.search).get('class'));
    if (wanted >= 0) choose(wanted);
  }

  // -- keys -----------------------------------------------------------------
  // The viewer already owns E, escape, 1-4, F, P, V, M and G; these are the
  // ones it left alone.
  const KEYS = {
    KeyZ: () => chooseSpell(-1),
    KeyX: () => chooseSpell(1),
    KeyC: () => castSelected(),
    KeyI: () => openSheet('gear'),
    KeyB: () => openSheet('shop'),
    KeyK: () => openSheet('skills'),
    KeyR: () => game.rest(),
    KeyQ: () => game.recall(),
    KeyT: () => { const pile = game.here()[0]; if (pile) game.takeAll(pile); },
  };
  function onKey(event) {
    if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === 'Escape' && sheetMode) { closeSheet(); return; }
    const action = KEYS[event.code];
    if (action) action();
  }
  document.addEventListener('keydown', onKey);

  // -- the frame ------------------------------------------------------------
  let lastLevel = game.state.level;
  let tick = 0;
  let lastTarget = null;

  function update() {
    consume();
    updateSpells();
    const s = game.state;

    const width = (value, max) => `${Math.max(0, Math.min(100, (value / Math.max(1, max)) * 100))}%`;
    const hitShown = s.hit + unshown(null);
    hpFill.style.width = width(hitShown, s.maxHit);
    manaFill.style.width = width(s.mana, s.maxMana);
    moveFill.style.width = width(s.move, s.maxMove);
    promptLeft.textContent = `${Math.max(0, hitShown)}hp ${s.mana}m ${s.move}mv`;
    promptRight.innerHTML = `<b>${s.gold} gold</b>`;
    const span = 1000;
    xpFill.style.width = width(span - Math.min(span, s.expToLevel), span);
    if (s.level !== lastLevel) { lastLevel = s.level; drawGates(); }

    let t = game.target();
    // The killing blow is still on its way when the rules already have the
    // mobile dead: hold its plate until the blow lands.
    if (t) lastTarget = t;
    else if (lastTarget && unshown(lastTarget.slot) > 0) t = lastTarget;
    else lastTarget = null;
    const percent = t ? Math.max(0, Math.min(100, Math.round(100 * (t.hit + unshown(t.slot)) / Math.max(1, t.maxHit)))) : 0;
    frame++;

    // Whoever you are fighting: a plate over their head while they can be
    // seen, and the panel on the right only while they cannot.
    const foeT = t && t.fighting ? t : null;
    const head = foeT ? plateAt(foeT.slot, 0.16) : null;
    foe.classList.toggle('on', !!head);
    if (head) {
      foe.style.transform = `translate(${head.x.toFixed(1)}px, ${head.y.toFixed(1)}px) translate(-50%, -100%)`;
      if (foeName.textContent !== t.name) foeName.textContent = t.name;
      foeNow.style.width = `${percent}%`;
      foeLag.style.width = `${percent}%`;
      const cond = `level ${t.level} · ${t.condition}`;
      if (foeCond.textContent !== cond) foeCond.textContent = cond;
    }
    const lost = !!foeT && !head;
    target.classList.toggle('on', lost);
    if (lost) {
      tName.textContent = t.name;
      tSub.textContent = `level ${t.level} · fighting you`;
      tBar.style.width = `${percent}%`;
      tCond.textContent = t.condition;
      tWhere.textContent = whereIs(t.slot);
    }

    // Whatever is in the crosshair, named over its own head -- unless it is
    // the one being fought, whose plate already says so.
    const f = game.focused();
    const fhead = f && (!foeT || f.slot !== foeT.slot) ? plateAt(f.slot, 0.12) : null;
    focusPlate.classList.toggle('on', !!fhead);
    if (fhead) {
      focusPlate.style.transform = `translate(${fhead.x.toFixed(1)}px, ${fhead.y.toFixed(1)}px) translate(-50%, -100%)`;
      if (focusName.textContent !== f.name) focusName.textContent = f.name;
      const sub = f.warden ? `level ${f.level} · warden of ${f.warden.name}`
        : `level ${f.level}${f.shop ? ' · shopkeeper' : ''}${f.aggressive ? ' · aggressive' : ''}`;
      if (focusSub.textContent !== sub) focusSub.textContent = sub;
      focusSub.classList.toggle('warden', !!f.warden);
    }
    document.body.classList.toggle('g-fighting', !!s.fighting);

    // The one bit of instruction, and only while it applies.
    const pile = game.here()[0];
    const shop = !sheetMode && game.shopHere();
    const prompts = [];
    if (f && !s.fighting) prompts.push('e — examine', 'click — attack');
    else if (f) prompts.push('e — examine');
    if (pile) prompts.push('t — take everything');
    if (shop) prompts.push('b — trade');
    const line = prompts.join('   ·   ');
    if (hint.textContent !== line) hint.textContent = line;
    hint.classList.toggle('on', prompts.length > 0 && !sheetMode);
    if (frame % 10 === 0) placeLog();

    // These two change under you as you walk about; the skills sheet does not.
    if ((sheetMode === 'shop' || sheetMode === 'gear') && (tick = (tick + 1) % 20) === 0) drawSheet();
  }

  drawGates();

  return {
    update,
    /** fn(x, y, z) -> {x, y} in CSS pixels, or null when behind the camera. */
    setProjector(fn) { project = fn; },
    openInventory: () => openSheet('gear'),
    openShop: () => openSheet('shop'),
    openSkills: () => openSheet('skills'),
    close: closeSheet,
    log: say,
    destroy() {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('wheel', onWheel);
      document.removeEventListener('mousedown', onMouse);
      document.removeEventListener('contextmenu', noMenu);
      root.remove();
      style.remove();
    },
  };
}
