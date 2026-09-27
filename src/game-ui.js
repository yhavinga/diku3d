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
/* Clears the minimap block, which is the map plus the compass under it. */
#g-target { position: absolute; right: 24px; top: 446px; width: 330px; padding: 11px 13px 10px;
  opacity: 0; transition: opacity 160ms ease; }
#g-target.on { opacity: 1; }
#g-target .name { font-size: 18px; line-height: 1.2; }
#g-target .sub { font-family: var(--mono); font-size: 10.5px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--gold); opacity: 0.75; margin-top: 4px; }
#g-target .cond { font-size: 13.5px; color: var(--dim); margin-top: 6px; font-style: italic; }
#g-target .warden { font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em;
  text-transform: uppercase; color: #d8a24e; margin-top: 6px; }
#g-target .g-bar { margin-top: 8px; margin-bottom: 0; }

/* ---------------------------------------------------------------- log -- */
#g-log { position: absolute; right: 24px; bottom: 140px; width: 330px;
  max-height: min(30vh, 220px); overflow: hidden; display: flex;
  flex-direction: column; justify-content: flex-end; gap: 2px; }
/* A soft glow was the only thing separating these lines from the world, and
   over sunlit paving or a night street they simply drowned. Same cure as the
   in-world name labels: a thin dark edge does the work of a wide halo at a
   fraction of the ink -- plus a low plate per line, the description panel's
   own trick, so a message reads on any background at all. */
#g-log p { margin: 0; font-size: 13.5px; line-height: 1.42; color: #d9cdb4;
  background: rgba(16, 13, 9, 0.62); padding: 3px 9px; border-radius: 2px;
  align-self: flex-end; max-width: 100%;
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
#g-floats { position: absolute; inset: 0; }
#g-floats span { position: absolute; left: 50%; top: 50%; font-family: var(--serif);
  font-size: 26px; font-weight: 400; white-space: nowrap;
  text-shadow: 0 0 1px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.85),
    0 -1px 2px rgba(0,0,0,0.85), 1px 0 2px rgba(0,0,0,0.85), -1px 0 2px rgba(0,0,0,0.85),
    0 2px 12px rgba(0,0,0,0.8); }
#g-floats span.world { font-size: 22px; letter-spacing: 0.02em; }
#g-hurt { position: absolute; inset: 0; opacity: 0; pointer-events: none;
  background: radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 46%, rgba(120,18,12,0.42) 88%, rgba(70,8,6,0.62) 100%); }

/* ---------------------------------------------------------- foe plate -- */
/* Over the head of whoever you are fighting, in place of their name label:
   the name, and the mud's hitpoints as a bar with a pale trailing chunk that
   drains a beat after each blow, so how much a hit took is readable. */
#g-foe { position: absolute; left: 0; top: 0; width: 132px; transform: translate(-50%, -100%);
  text-align: center; opacity: 0; transition: opacity 180ms ease; will-change: transform; }
#g-foe.on { opacity: 1; }
#g-foe .n { font-size: 14px; line-height: 1.25; color: #efe2c6; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  text-shadow: 0 0 1px rgba(0,0,0,0.95), 0 1px 2px rgba(0,0,0,0.85),
    0 -1px 2px rgba(0,0,0,0.85), 1px 0 2px rgba(0,0,0,0.85), -1px 0 2px rgba(0,0,0,0.85); }
#g-foe .b { position: relative; height: 5px; margin: 4px auto 0; width: 100%;
  background: rgba(14,11,8,0.72); box-shadow: 0 0 0 1px rgba(224,189,119,0.32), 0 1px 3px rgba(0,0,0,0.6); }
#g-foe .b i { position: absolute; inset: 0 auto 0 0; display: block; }
#g-foe .b i.lag { background: rgba(240,222,180,0.8); transition: width 520ms cubic-bezier(.4,0,.2,1) 260ms; }
#g-foe .b i.now { background: linear-gradient(90deg, #8f3326, #c4553f); transition: width 90ms linear; }
#g-foe .c { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--gold); opacity: 0.8; margin-top: 3px;
  text-shadow: 0 0 1px rgba(0,0,0,0.95), 0 1px 2px rgba(0,0,0,0.85); }

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
#g-hint { position: absolute; left: 50%; bottom: 62px; transform: translateX(-50%);
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

/** dam_message's own bands, as colour: a scratch is not a MASSACRE. */
function damColour(dam) {
  if (dam <= 0) return 'rgba(240,227,200,0.55)';
  if (dam <= 8) return '#e6dcc6';
  if (dam <= 16) return '#f0d9a8';
  if (dam <= 28) return '#e8b96a';
  if (dam <= 48) return '#e0913f';
  return '#e8683a';
}

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
  const tWarden = el('div', 'warden');
  target.append(tName, tSub, tBarBox, tCond, tWarden);
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
  const foe = el('div');
  foe.id = 'g-foe';
  const foeName = el('div', 'n');
  const foeBar = el('div', 'b');
  const foeLag = el('i', 'lag');
  const foeNow = el('i', 'now');
  foeBar.append(foeLag, foeNow);
  const foeCond = el('div', 'c');
  foe.append(foeName, foeBar, foeCond);
  root.append(hurt, foe, floats);

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

  /**
   * A number that flies past the crosshair, sized by how hard it landed --
   * or, given `at` (screen pixels), rises off the body it landed on.
   */
  function float(text, colour, { fromLeft = false, size = 26, at = null } = {}) {
    const node = el('span', at ? 'world' : null, text);
    node.style.color = colour;
    node.style.fontSize = `${size}px`;
    if (at) { node.style.left = `${at.x}px`; node.style.top = `${at.y}px`; }
    floats.appendChild(node);
    const dx = at ? (Math.random() - 0.5) * 40 : (fromLeft ? -140 - Math.random() * 40 : (Math.random() - 0.5) * 90);
    const dy = at ? -38 - Math.random() * 16 : (fromLeft ? -10 : -46 - Math.random() * 26);
    node.animate([
      { transform: `translate(-50%, -50%) translate(${dx * 0.25}px, ${fromLeft ? 0 : 14}px) scale(0.82)`, opacity: 0 },
      { transform: `translate(-50%, -50%) translate(${dx * 0.55}px, ${dy * 0.35}px) scale(1.06)`, opacity: 1, offset: 0.18 },
      { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(1)`, opacity: 0 },
    ], { duration: 1100, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => node.remove();
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

  function closeSheet() { sheetMode = null; sheet.classList.remove('on'); lift(false); }

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
        wornList.append(row(obj.name, `${WEAR_NAME[i]} · remove`, { onClick: () => game.remove(i) }));
      });
      if (!worn) wornList.append(row('nothing but your own skin', '', { cls: 'dim' }));
      left.append(wornList);

      const right = el('div');
      right.append(el('h4', null, `carried — ${s.carryWeight}/${s.carryMax} lb`));
      const bagList = el('ul');
      if (!s.inventory.length) bagList.append(row('your hands are empty', '', { cls: 'dim' }));
      for (const obj of s.inventory.slice()) {
        bagList.append(row(obj.name, `${obj.weight} lb · wear`, { onClick: () => game.wear(obj) }));
      }
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
          if (event.byPlayer) {
            float(String(event.dam), damColour(event.dam), { size: 20 + Math.min(20, event.dam / 2), at: headOf(event.to, 0.05) });
          } else {
            float(`-${event.dam}`, '#e0705a', { fromLeft: true, size: 22 });
            flashHurt(Math.min(0.6, event.dam / Math.max(1, game.state.maxHit)));
          }
          break;
        case 'miss':
          say(event.text, event.byPlayer ? 'faint' : 'faint');
          if (event.byPlayer) float('miss', 'rgba(240,227,200,0.5)', { size: 16, at: headOf(event.to, 0.05) });
          break;
        case 'parry': case 'dodge':
          say(event.text, 'faint');
          if (event.defended) float(event.kind, 'rgba(180,200,220,0.6)', { fromLeft: true, size: 16 });
          else float(event.kind === 'parry' ? 'parried' : 'dodged', 'rgba(200,214,228,0.62)', { size: 15, at: headOf(event.to, 0.05) });
          break;
        case 'death':
          say(event.text, 'dead');
          if (event.player) flashHurt(0.9);
          break;
        case 'xp':
          say(event.text, 'gain');
          if (event.amount > 0) float(`+${event.amount} exp`, '#e0bd77', { size: 19 });
          break;
        case 'gold':
          say(event.text, 'gain');
          float(`+${event.amount} gold`, '#e8c979', { size: 19 });
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

  // -- keys -----------------------------------------------------------------
  // The viewer already owns E, escape, 1-4, F, P, V, M and G; these are the
  // ones it left alone.
  const KEYS = {
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
    // mobile dead: hold its panel until the blow lands.
    if (t) lastTarget = t;
    else if (lastTarget && unshown(lastTarget.slot) > 0) t = lastTarget;
    else lastTarget = null;
    const percent = t ? Math.max(0, Math.min(100, Math.round(100 * (t.hit + unshown(t.slot)) / Math.max(1, t.maxHit)))) : 0;
    target.classList.toggle('on', !!t);
    if (t) {
      tName.textContent = t.name;
      tSub.textContent = `level ${t.level}${t.aggressive ? ' · aggressive' : ''}${t.fighting ? ' · fighting you' : ''}`;
      tBar.style.width = `${percent}%`;
      tCond.textContent = t.condition;
      tWarden.textContent = t.warden ? `warden of ${t.warden.name}` : '';
    }

    // The foe plate, over the head of whoever you are actually fighting.
    const head = t && t.fighting ? headOf(t.slot, 0.12) : null;
    foe.classList.toggle('on', !!head);
    if (head) {
      foe.style.transform = `translate(${head.x.toFixed(1)}px, ${head.y.toFixed(1)}px) translate(-50%, -100%)`;
      if (foeName.textContent !== t.name) foeName.textContent = t.name;
      foeNow.style.width = `${percent}%`;
      foeLag.style.width = `${percent}%`;
      foeCond.textContent = `level ${t.level}`;
    }

    // The one bit of instruction, and only while it applies.
    const pile = game.here()[0];
    const shop = !sheetMode && game.shopHere();
    const prompts = [];
    if (t && !t.fighting) prompts.push('click — attack');
    if (pile) prompts.push('t — take everything');
    if (shop) prompts.push('b — trade');
    hint.textContent = prompts.join('   ·   ');
    hint.classList.toggle('on', prompts.length > 0 && !sheetMode);

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
      root.remove();
      style.remove();
    },
  };
}
