/**
 * The implementor's dashboard: the whole mud from above (godview.js), live,
 * with who is on, what happens and how the server is in panels over it, and
 * act_wiz.c's commands an owner reaches for as buttons. See server/dash.mjs
 * for the other side; the server decides who may see any of it, this page
 * only decides whether to offer the key.
 *
 * Backquote (`) opens it and closes it (CLAUDE.md: every panel closes on the
 * key that opened it; Escape works too, but nothing depends on it), as does
 * typing `dashboard` at the prompt. The key does nothing unless the page is
 * connected to a server that lists the dashboard among its features and the
 * character is the implementor (trust 40). Alone, nothing here runs.
 *
 * Everything is pushed by the server over the game's own socket: positions
 * at 10 Hz, mobiles and events in 4 Hz batches, the roster and health once a
 * second. Nothing is polled. While it is up the page draws the god view
 * instead of the world (main.js hands `render` its frame).
 */

import { createGodView } from './godview.js';

const KEY = 'Backquote';
const TRUST = 40;
/** Lines kept on the page: the server keeps 400, and a long session adds to them. */
const KEEP = 1500;
const CATEGORIES = [
  ['conn', 'logins'], ['fight', 'fights'], ['death', 'deaths'], ['talk', 'talk'],
  ['wiz', 'wizards'], ['site', 'site'], ['server', 'server'], ['reset', 'resets'],
];
const OFF_BY_DEFAULT = new Set(['reset']);
const PANELS = [['who', 'who'], ['events', 'events'], ['health', 'health']];

const CSS = `
/* The god view is drawn on the game's own canvas (#view); everything else of the game's is put away. */
body.dashing > *:not(#dash):not(#view) { visibility: hidden !important; }
#dash { position: fixed; inset: 0; z-index: 46; display: none; pointer-events: none;
  font-family: var(--serif); color: var(--ink); font-size: clamp(11px, min(0.9vw, 1.55vh), 17px); }
#dash.open { display: block; }
#dash .stage { position: absolute; inset: 0; pointer-events: auto; cursor: grab; touch-action: none; }
#dash .stage:active { cursor: grabbing; }
#dash .dp { position: absolute; pointer-events: auto; background: rgba(14, 12, 10, 0.86); border: 1px solid var(--edge);
  border-radius: 3px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
#dash .bar { z-index: 3; left: 1.2em; right: 1.2em; top: 1em; display: flex; align-items: center; gap: 1.2em; padding: 0.55em 1em; }
#dash h2 { margin: 0; font-size: 1.45em; font-weight: 400; letter-spacing: 0.02em; white-space: nowrap; }
#dash .mono { font-family: var(--mono); letter-spacing: 0.12em; text-transform: uppercase; font-size: 0.74em; color: var(--gold); opacity: 0.8; white-space: nowrap; }
#dash .grow { flex: 1; }
#dash h3 { margin: 0 0 0.5em; font-family: var(--mono); font-weight: 400; font-size: 0.74em; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--gold); display: flex; justify-content: space-between; gap: 1em; }
#dash h3 small { text-transform: none; letter-spacing: 0.04em; color: var(--dim); }
#dash button { font-family: var(--mono); font-size: 0.72em; letter-spacing: 0.08em; color: var(--gold); cursor: pointer;
  background: rgba(224,189,119,0.06); border: 1px solid rgba(224,189,119,0.32); border-radius: 2px; padding: 0.3em 0.55em; margin: 0 0.25em 0.25em 0; }
#dash button:hover { background: rgba(224,189,119,0.16); }
#dash button.on { background: rgba(224,189,119,0.22); border-color: rgba(224,189,119,0.75); }
#dash button.off { opacity: 0.42; }
#dash .search { position: relative; }
#dash .search input { width: 17em; background: rgba(0,0,0,0.35); border: 1px solid rgba(224,189,119,0.3); border-radius: 2px; outline: 0;
  color: var(--ink); font-family: var(--mono); font-size: 0.8em; padding: 0.45em 0.6em; caret-color: var(--gold); }
#dash .results { position: absolute; top: 2.4em; left: 0; width: 26em; max-height: 50vh; overflow-y: auto; display: none; }
#dash .results.on { display: block; }
#dash .results div { padding: 0.4em 0.7em; cursor: pointer; font-size: 0.92em; border-bottom: 1px solid rgba(224,189,119,0.07); }
#dash .results div:hover, #dash .results div.hi { background: rgba(224,189,119,0.12); }
#dash .results small { font-family: var(--mono); color: var(--dim); font-size: 0.75em; margin-left: 0.6em; }
#dash .tiles { left: 1.2em; right: 1.2em; top: 4.6em; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0; padding: 0.3em 0; }
.dh-tile { padding: 0.35em 1em 0.4em; min-width: 0; border-left: 1px solid rgba(224,189,119,0.1); }
.dh-tile:first-child { border-left: 0; }
.dh-tile .k { font-family: var(--mono); font-size: 0.68em; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); }
.dh-tile .v { font-size: 1.4em; line-height: 1.15; white-space: nowrap; }
.dh-tile .v small { font-size: 0.55em; color: var(--dim); margin-left: 0.25em; }
.dh-tile .s { font-family: var(--mono); font-size: 0.7em; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dh-tile canvas { width: 100%; height: 1.8em; display: block; margin-top: 0.2em; }
#dash .who { left: 1.2em; top: 10.4em; bottom: 1em; width: min(36em, 34vw); display: flex; flex-direction: column; padding: 0.8em 0.9em; }
#dash .events { right: 1.2em; top: 10.4em; bottom: 1em; width: min(34em, 30vw); display: flex; flex-direction: column; padding: 0.8em 0.9em; }
#dash.nohealth .who, #dash.nohealth .events { top: 4.6em; }
.dh-scroll { overflow-y: auto; flex: 1; min-height: 0; scrollbar-width: thin; scrollbar-color: rgba(224,189,119,0.25) transparent; }
.dh-p { padding: 0.5em 0.3em 0.45em; border-bottom: 1px solid rgba(224,189,119,0.08); cursor: pointer; }
.dh-p:hover { background: rgba(224,189,119,0.05); }
.dh-p.sel { background: rgba(224,189,119,0.09); box-shadow: inset 2px 0 0 rgba(224,189,119,0.7); }
.dh-p .top { display: flex; align-items: baseline; gap: 0.6em; }
.dh-p .nm { font-size: 1.08em; }
.dh-p .m { font-family: var(--mono); font-size: 0.74em; color: var(--dim); }
.dh-p .where { font-size: 0.9em; color: #e2d6bc; margin-top: 0.1em; }
.dh-bars { display: grid; gap: 2px; width: 6em; margin-left: auto; }
.dh-bar { height: 4px; background: rgba(240,227,200,0.08); border-radius: 1px; overflow: hidden; }
.dh-bar i { display: block; height: 100%; }
.dh-bar.hp i { background: #c9785f; } .dh-bar.mn i { background: #7f9fc4; } .dh-bar.mv i { background: #9fb27a; }
.dh-flag { display: inline-block; font-family: var(--mono); font-size: 0.66em; letter-spacing: 0.1em; padding: 0.05em 0.4em;
  border: 1px solid rgba(207,120,100,0.6); color: #e2a593; border-radius: 2px; margin-left: 0.3em; }
.dh-flag.quiet { border-color: rgba(181,162,132,0.4); color: var(--dim); }
.dh-flag.fight { border-color: rgba(226,85,63,0.8); color: #f08a74; }
.dh-ev { display: grid; grid-template-columns: 4.9em 4.2em minmax(0, 1fr); gap: 0.5em; padding: 0.2em 0; font-size: 0.9em; line-height: 1.36; }
.dh-ev .t { font-family: var(--mono); font-size: 0.78em; color: var(--dim); padding-top: 0.15em; }
.dh-ev .c { font-family: var(--mono); font-size: 0.68em; letter-spacing: 0.12em; text-transform: uppercase; color: var(--gold); opacity: 0.8; padding-top: 0.25em; }
.dh-ev .x { color: #e2d6bc; overflow-wrap: anywhere; }
.dh-ev.talk .x { font-style: italic; color: #e9dcc0; }
.dh-ev.death .x { color: #e6b6a6; }
.dh-ev.warn .x { color: #e8c27a; } .dh-ev.error .x { color: #f09a86; }
.dh-ev .lv, .dh-ev .priv { font-family: var(--mono); font-style: normal; font-size: 0.68em; letter-spacing: 0.12em; margin-right: 0.5em; padding: 0.05em 0.35em; border-radius: 2px; }
.dh-ev.warn .lv { border: 1px solid rgba(232,194,122,0.6); color: #e8c27a; }
.dh-ev.error .lv { border: 1px solid rgba(240,154,134,0.7); color: #f09a86; }
.dh-ev .priv { border: 1px dashed rgba(181,162,132,0.6); color: var(--dim); }
.dh-chips { margin-bottom: 0.5em; }
#dash .card { left: 50%; bottom: 2.8em; transform: translateX(-50%); width: min(34em, 34vw); padding: 0.8em 1em 0.7em; display: none; }
#dash .card.on { display: block; }
#dash .card .ttl { font-size: 1.3em; }
#dash .card .m { font-family: var(--mono); font-size: 0.74em; color: var(--dim); margin: 0.2em 0 0.55em; line-height: 1.5; }
#dash .card .did { font-family: var(--mono); font-size: 0.74em; color: #e2d6bc; margin-top: 0.3em; white-space: pre-wrap; }
#dash .hint { left: 50%; bottom: 0.7em; transform: translateX(-50%); padding: 0.3em 0.9em; background: rgba(14,12,10,0.6); white-space: nowrap; }
#dash .hint span { font-family: var(--mono); font-size: 0.66em; letter-spacing: 0.1em; color: var(--dim); }
.dh-empty { color: var(--dim); font-style: italic; padding: 0.6em 0; }
`;

const esc = (text) => String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);
function ago(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
}
const pct = (a, b) => (b > 0 ? Math.max(0, Math.min(100, (100 * a) / b)) : 0);

function build() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'dash';
  root.innerHTML = `
    <div class="stage" id="dh-stage"></div>
    <div class="dp bar">
      <h2>The implementor's view</h2>
      <span class="mono" id="dh-server"></span>
      <span class="grow"></span>
      <div class="search"><input id="dh-search" type="text" spellcheck="false" autocomplete="off" placeholder="find a player, room, mobile or #vnum">
        <div class="dp results" id="dh-results"></div></div>
      <span id="dh-toggles"></span>
      <span class="mono">\` closes</span>
    </div>
    <div class="dp tiles" id="dh-tiles"></div>
    <div class="dp hint" id="dh-hint"><span>drag: turn · right-drag: pan · wheel: zoom · wasd: fly · q e: turn · r f: zoom · click: pick · double-click: fly there</span></div>
    <div class="dp who" id="dh-who-panel"><h3>Who is on <small id="dh-who-n"></small></h3><div class="dh-scroll" id="dh-who"></div></div>
    <div class="dp events" id="dh-ev-panel"><h3>What happens <small id="dh-ev-n"></small></h3><div class="dh-chips" id="dh-chips"></div><div class="dh-scroll" id="dh-log"></div></div>
    <div class="dp card" id="dh-card"></div>`;
  document.body.appendChild(root);
  return root;
}

export function createDashboard({ getLink }) {
  const root = build();
  const $ = (id) => root.querySelector(`#${id}`);
  let open = false;
  let wasPaused = false;
  let hadLock = false;
  let attached = null;
  let offs = [];
  const shown = new Set(CATEGORIES.map(([c]) => c).filter((c) => !OFF_BY_DEFAULT.has(c)));
  const panels = new Set(PANELS.map(([p]) => p));
  let events = [];
  let who = [];
  let health = null;
  let atlas = null;
  let view = null;
  let card = null;      // { kind, id | vnum | index }
  let lastDid = '';

  const diku = () => window.diku;
  const me = () => diku()?.game?.state?.name || null;

  /** Connected, as the implementor, to a server that has a dashboard. */
  function allowed() {
    const d = diku();
    const link = getLink();
    if (!link || link.mode !== 'socket' || !link.link || link.link.closed) return false;
    const features = (link.link.hello && link.link.hello.features) || [];
    return features.includes('dash') && !!d && !!d.game && (d.game.state.trust || d.game.state.level || 0) >= TRUST;
  }
  function playable() {
    const d = diku();
    if (!d || !d.state || !d.options) return false;
    if (!document.getElementById('title').classList.contains('hidden')) return false;
    return !d.options.open;
  }

  /** The god view, made the first time it is wanted and kept for the page's life. */
  function godView() {
    if (view) return view;
    const d = diku();
    view = createGodView({
      renderer: d.renderer, world: d.game.world, mobs: d.game.mobs,
      now: () => (attached && attached.link ? attached.link.serverNow() : performance.now()),
    });
    view.bind($('dh-stage'), { onPick: (hit) => select(hit), onFly: () => {} });
    return view;
  }

  /** A connection (link.js attachSocketLink) to listen on: called again on every reconnect. */
  function attach(connected) {
    for (const off of offs) off();
    offs = [];
    attached = connected;
    if (!connected || !connected.link) return;
    const link = connected.link;
    offs.push(link.on('dash', receive));
    // `dashboard` typed at the prompt: the server answers the implementor only.
    offs.push(link.on('ev', (msg) => { if (msg.e.some((e) => e.kind === 'dashboard')) toggle(); }));
    offs.push(link.on('closed', () => { if (open) hide(); }));
    // A reconnect is a new descriptor: the subscription went with the old one.
    if (open) subscribe();
  }

  const sendDash = (msg) => attached && attached.link && attached.link.send({ t: 'dash', ...msg });
  function subscribe() {
    sendDash({ op: 'sub' });
    if (!atlas) sendDash({ op: 'atlas' });
  }

  function receive(msg) {
    switch (msg.k) {
      case 'snap':
        events = msg.ev.slice();
        who = msg.who; health = msg.health;
        if (view && view.ready) { view.setMobs(msg.mobs); view.setPositions(msg.pos, msg.at); view.setWho(who, me()); }
        // Before the atlas has come, there is nowhere to put them yet: kept for it.
        pendingSnap = view && view.ready ? null : msg;
        renderAll();
        return;
      case 'atlas':
        atlas = msg;
        godView().setAtlas(msg);
        if (pendingSnap) { view.setMobs(pendingSnap.mobs); view.setPositions(pendingSnap.pos, pendingSnap.at); pendingSnap = null; }
        view.setWho(who, me());
        return;
      case 'pos':
        if (view) view.setPositions(msg.p, msg.at);
        return;
      case 'batch':
        if (msg.ev.length) { events.push(...msg.ev); if (events.length > KEEP) events.splice(0, events.length - KEEP); appendEvents(msg.ev); }
        if (msg.m && view) view.updateMobs(msg.m);
        if (msg.who) { who = msg.who; renderWho(); if (view) view.setWho(who, me()); renderCard(); }
        if (msg.health) { health = msg.health; renderTiles(); }
        return;
      case 'did':
        // The first line: a goto's whole room description is in the console already.
        lastDid = `${msg.op}: ${msg.lines.length ? msg.lines[0].split('\n')[0] : (msg.ok ? 'done' : 'refused')}${msg.lines.length > 1 ? ` (+${msg.lines.length - 1} lines in the console)` : ''}`;
        renderCard();
        return;
      case 'off': case 'no':
        lastDid = msg.why;
        if (open) hide();
        return;
      default:
    }
  }
  let pendingSnap = null;

  // ------------------------------------------------------------ rendering --
  function tile(k, v, s, extra = '') {
    return `<div class="dh-tile"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s" title="${esc(s)}">${esc(s)}</div>` : ''}${extra}</div>`;
  }
  function renderTiles() {
    const h = health;
    if (!h) return;
    const link = getLink();
    $('dh-server').textContent = `${link && link.link ? link.link.url.replace(/^wss?:\/\//, '').replace(/\/ws$/, '') : ''} · up ${ago(h.up)}`;
    const resetLine = h.resets.recent.length ? `last ${h.resets.recent[0][0]}, ${ago(h.resets.recent[0][1])} ago` : 'none yet';
    $('dh-tiles').innerHTML = [
      tile('Players', `${h.players}<small>${h.linkdead ? `${h.linkdead} link-dead` : 'online'}</small>`, `${h.mobs} of ${h.mobsAll} mobiles alive`),
      tile('Tick', `${h.tickMean.toFixed(2)}<small>ms</small>`, `max ${h.tickMax.toFixed(1)} ms in 5 s`, '<canvas id="dh-spark" width="300" height="44"></canvas>'),
      tile('In', `${h.kbIn.toFixed(1)}<small>KB/s</small>`, `${h.msgsIn.toFixed(0)} msgs/s · ${h.refused} refused`),
      tile('Out', `${h.kbOut.toFixed(1)}<small>KB/s</small>`, `${h.msgsOut.toFixed(0)} msgs/s · this view ${h.kbDash.toFixed(1)} KB/s`),
      tile('Memory', `${h.rss.toFixed(0)}<small>MB</small>`, `heap ${h.heap.toFixed(0)} MB · ${h.events.toFixed(0)} events/s`),
      tile('Site', `${h.wizlock ? 'wizlocked' : 'open'} <button data-act="wizlock" data-on="${h.wizlock ? 0 : 1}">${h.wizlock ? 'unlock' : 'wizlock'}</button>`,
        `${h.resets.total} resets, ${resetLine}${h.bans.length ? ` · bans: ${h.bans.join(', ')}` : ''}`),
    ].join('');
    drawSpark($('dh-spark'), h.ticks);
  }

  /** Tick time, one second a column: the mean as a line, the worst tick as a faint bar. */
  function drawSpark(canvas, ticks) {
    if (!canvas) return;
    const g = canvas.getContext('2d');
    const W = canvas.width; const H = canvas.height;
    g.clearRect(0, 0, W, H);
    if (!ticks.length) return;
    const top = Math.max(2, ...ticks.map((t) => t[1])) * 1.1;
    const step = W / Math.max(119, ticks.length - 1);
    const x0 = W - (ticks.length - 1) * step;
    g.fillStyle = 'rgba(224,189,119,0.2)';
    ticks.forEach(([, max], i) => { const h = (max / top) * H; g.fillRect(x0 + i * step - 1, H - h, 2, h); });
    g.strokeStyle = 'rgba(224,189,119,0.95)';
    g.lineWidth = 2;
    g.beginPath();
    ticks.forEach(([mean], i) => { const x = x0 + i * step; const y = H - (mean / top) * H; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
    canvas.title = `tick time over the last ${ticks.length} s: mean now ${ticks.at(-1)[0]} ms, worst ${Math.max(...ticks.map((t) => t[1]))} ms (0 to ${top.toFixed(1)} ms)`;
  }

  function flags(p) {
    return [
      p.fighting ? `<span class="dh-flag fight">FIGHTING</span>` : '',
      p.linkdead !== null ? `<span class="dh-flag quiet">LINK-DEAD ${ago(p.linkdead)}</span>` : '',
      ...p.flags.map((f) => `<span class="dh-flag${f === 'KILLER' || f === 'THIEF' ? '' : ' quiet'}">${f}</span>`),
    ].join('');
  }

  function renderWho() {
    $('dh-who-n').textContent = `${who.length} in the game`;
    if (!who.length) { $('dh-who').innerHTML = '<div class="dh-empty">Nobody.</div>'; return; }
    const follow = view ? view.follow : null;
    $('dh-who').innerHTML = who.map((p) => `
      <div class="dh-p${card && card.kind === 'player' && card.id === p.id ? ' sel' : ''}" data-player="${p.id}">
        <div class="top"><span class="nm">${esc(p.name)}</span><span class="m">L${p.level} ${esc(p.cls)}${p.trust > p.level ? ` · trust ${p.trust}` : ''}${p.id === follow ? ' · followed' : ''}</span>${flags(p)}
          <div class="dh-bars" title="hp ${p.hp}/${p.maxHp} · mana ${p.mana}/${p.maxMana} · move ${p.move}/${p.maxMove}">
            <div class="dh-bar hp"><i style="width:${pct(p.hp, p.maxHp)}%"></i></div>
            <div class="dh-bar mn"><i style="width:${pct(p.mana, p.maxMana)}%"></i></div>
            <div class="dh-bar mv"><i style="width:${pct(p.move, p.maxMove)}%"></i></div></div></div>
        <div class="where">${esc(p.room)} <span class="m">#${p.vnum} · ${esc(p.zoneName)}</span></div>
        <div class="m">${esc(p.pos)}${p.fighting ? ` vs ${esc(p.fighting)}` : ''} · idle ${ago(p.idle)} · ${esc(p.host)}${p.snoopedBy ? ` · snooped by ${esc(p.snoopedBy)}` : ''}</div>
      </div>`).join('');
  }

  function renderChips() {
    $('dh-chips').innerHTML = CATEGORIES.map(([c, text]) => {
      const n = events.filter((e) => e.c === c).length;
      return `<button data-chip="${c}" class="${shown.has(c) ? 'on' : 'off'}">${text} ${n}</button>`;
    }).join('');
  }
  function eventHtml(e) {
    const lvl = e.lvl ? `<span class="lv">${e.lvl === 'error' ? 'ERROR' : 'WARN'}</span>` : '';
    const priv = e.priv ? '<span class="priv">PRIVATE</span>' : '';
    return `<div class="dh-ev ${e.c}${e.lvl ? ` ${e.lvl}` : ''}"${e.vnum ? ` data-vnum="${e.vnum}"` : ''}><span class="t">${clock(e.at)}</span><span class="c">${e.c}</span><span class="x">${lvl}${priv}${esc(e.text)}</span></div>`;
  }
  function renderEvents() {
    const log = $('dh-log');
    const list = events.filter((e) => shown.has(e.c));
    log.innerHTML = list.length ? list.map(eventHtml).join('') : '<div class="dh-empty">Nothing yet.</div>';
    log.scrollTop = log.scrollHeight;
    $('dh-ev-n').textContent = `${events.length} kept`;
    renderChips();
  }
  function appendEvents(list) {
    const log = $('dh-log');
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    const fresh = list.filter((e) => shown.has(e.c));
    if (fresh.length) {
      log.querySelector('.dh-empty')?.remove();
      log.insertAdjacentHTML('beforeend', fresh.map(eventHtml).join(''));
      while (log.children.length > KEEP) log.removeChild(log.firstChild);
      if (stick) log.scrollTop = log.scrollHeight;
    }
    $('dh-ev-n').textContent = `${events.length} kept`;
    renderChips();
  }
  function renderToggles() {
    $('dh-toggles').innerHTML = PANELS.map(([p, text]) => `<button data-panel="${p}" class="${panels.has(p) ? 'on' : 'off'}">${text}</button>`).join('');
    $('dh-who-panel').hidden = !panels.has('who');
    $('dh-ev-panel').hidden = !panels.has('events');
    $('dh-tiles').hidden = !panels.has('health');
    root.classList.toggle('nohealth', !panels.has('health'));
  }
  function renderAll() { renderTiles(); renderWho(); renderEvents(); renderToggles(); renderCard(); }

  // ------------------------------------------------------- picking, cards --
  const world = () => diku().game.world;
  function select(hit) {
    card = hit;
    lastDid = '';
    renderCard();
    renderWho();
  }

  /** The card for what is picked: a player, a mobile, a room -- and what can be done to it. */
  function renderCard() {
    const el = $('dh-card');
    if (!card) { el.classList.remove('on'); return; }
    let html = '';
    if (card.kind === 'player') {
      const p = who.find((q) => q.id === card.id);
      if (!p) { card = null; el.classList.remove('on'); return; }
      const self = p.name === me();
      const follow = view && view.follow === p.id;
      html = `<div class="ttl">${esc(p.name)} ${flags(p)}</div>
        <div class="m">L${p.level} ${esc(p.cls)} · ${p.hp}/${p.maxHp} hp ${p.mana}/${p.maxMana} mana ${p.move}/${p.maxMove} mv · ${esc(p.pos)}${p.fighting ? ` vs ${esc(p.fighting)}` : ''}<br>
          ${esc(p.room)} #${p.vnum} · ${esc(p.zoneName)} · idle ${ago(p.idle)} · ${esc(p.host)}</div>
        <button data-act="look" data-id="${p.id}">look</button><button data-act="follow" data-id="${p.id}" class="${follow ? 'on' : ''}">follow camera</button>
        ${self ? '' : `<button data-act="goto" data-id="${p.id}">goto</button><button data-act="transfer" data-id="${p.id}">transfer</button>
        <button data-act="snoop" data-id="${p.id}" class="${p.snoopedBy === me() ? 'on' : ''}">snoop</button><button data-act="restore" data-id="${p.id}">restore</button>`}`;
    } else if (card.kind === 'room') {
      const room = world().rooms.get(card.vnum);
      const here = who.filter((p) => p.vnum === card.vnum).map((p) => p.name);
      const mobsHere = diku().game.mobs.filter((s) => s.roomVnum === card.vnum && !s.dead).map((s) => s.proto.short);
      html = `<div class="ttl">${esc(room ? room.name : `#${card.vnum}`)}</div>
        <div class="m">#${card.vnum} · ${esc(view.zoneOf(view.roomAt(card.vnum)?.zone)?.name || '')}${here.length ? ` · ${esc(here.join(', '))}` : ''}${mobsHere.length ? `<br>${esc(mobsHere.slice(0, 6).join(', '))}${mobsHere.length > 6 ? ` and ${mobsHere.length - 6} more` : ''}` : ''}</div>
        <button data-act="look" data-vnum="${card.vnum}">look</button><button data-act="goto" data-vnum="${card.vnum}">goto</button>`;
    } else if (card.kind === 'mob') {
      const slot = diku().game.mobs[card.index];
      const room = world().rooms.get(card.room);
      html = `<div class="ttl">${esc(slot ? slot.proto.short : 'a mobile')}</div>
        <div class="m">level ${slot ? slot.proto.level : '?'} · mobile #${slot ? slot.proto.vnum : '?'}${slot && slot.proto.act & 32 ? ' · aggressive' : ''}<br>${esc(room ? room.name : '')} #${card.room}</div>
        <button data-act="look" data-vnum="${card.room}">look</button><button data-act="goto" data-vnum="${card.room}">goto its room</button>`;
    }
    el.innerHTML = `${html}<div class="did">${esc(lastDid)}</div>`;
    el.classList.add('on');
  }

  // -------------------------------------------------------------- search --
  function search(text) {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const num = /^#?(\d+)$/.exec(q);
    if (num && view && view.roomAt(Number(num[1]))) out.push({ kind: 'room', vnum: Number(num[1]), text: world().rooms.get(Number(num[1])).name, sub: `room #${num[1]}` });
    for (const p of who) if (p.name.toLowerCase().includes(q)) out.push({ kind: 'player', id: p.id, text: p.name, sub: `player · ${p.room}` });
    const mobs = diku().game.mobs;
    for (let i = 0; i < mobs.length && out.length < 40; i++) {
      const s = mobs[i];
      if (!s.dead && s.proto.short.toLowerCase().includes(q) && view && view.roomAt(s.roomVnum)) out.push({ kind: 'mob', index: i, room: s.roomVnum, text: s.proto.short, sub: `mobile L${s.proto.level} · #${s.roomVnum}` });
    }
    for (const [vnum, room] of world().rooms) {
      if (out.length >= 60) break;
      if (room.name.toLowerCase().includes(q) && view && view.roomAt(vnum)) out.push({ kind: 'room', vnum, text: room.name, sub: `room #${vnum}` });
    }
    return out.slice(0, 40);
  }
  let results = [];
  function showResults() {
    results = search($('dh-search').value);
    const el = $('dh-results');
    el.innerHTML = results.map((r, i) => `<div data-result="${i}"${i === 0 ? ' class="hi"' : ''}>${esc(r.text)}<small>${esc(r.sub)}</small></div>`).join('');
    el.classList.toggle('on', results.length > 0);
  }
  function goToResult(r) {
    $('dh-results').classList.remove('on');
    $('dh-search').blur();
    flyToHit(r, true);
    select(r.kind === 'player' ? { kind: 'player', id: r.id } : r.kind === 'mob' ? { kind: 'mob', index: r.index, room: r.room } : { kind: 'room', vnum: r.vnum });
  }
  function flyToHit(hit, close) {
    if (!view) return;
    const at = hit.kind === 'player' ? view.playerAt(hit.id) : view.roomAt(hit.kind === 'mob' ? hit.room : hit.vnum);
    if (at) view.flyTo(at, close ? 110 : view.look.dist);
  }
  $('dh-search').addEventListener('input', showResults);
  $('dh-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && results.length) { e.preventDefault(); goToResult(results[0]); }
    if (e.key === 'Escape') { $('dh-results').classList.remove('on'); $('dh-search').blur(); }
  });

  // ------------------------------------------------------------ the panel --
  root.addEventListener('click', (event) => {
    const t = event.target;
    const r = t.closest('[data-result]');
    if (r) { goToResult(results[Number(r.dataset.result)]); return; }
    const chip = t.closest('[data-chip]');
    if (chip) { const c = chip.dataset.chip; if (shown.has(c)) shown.delete(c); else shown.add(c); renderEvents(); return; }
    const pnl = t.closest('[data-panel]');
    if (pnl) { const p = pnl.dataset.panel; if (panels.has(p)) panels.delete(p); else panels.add(p); renderToggles(); return; }
    const b = t.closest('[data-act]');
    if (b) {
      const act = b.dataset.act;
      const id = b.dataset.id !== undefined ? Number(b.dataset.id) : null;
      const vnum = b.dataset.vnum !== undefined ? Number(b.dataset.vnum) : null;
      if (act === 'look') { flyToHit(id !== null ? { kind: 'player', id } : { kind: 'room', vnum }, true); return; }
      if (act === 'follow') { view.follow = view.follow === id ? null : id; renderCard(); renderWho(); return; }
      if (act === 'wizlock') { sendDash({ op: 'wizlock', on: b.dataset.on === '1' }); return; }
      lastDid = `${act} ...`;
      renderCard();
      sendDash(vnum !== null ? { op: act, vnum } : { op: act, id });
      return;
    }
    const row = t.closest('[data-player]');
    if (row) { const id = Number(row.dataset.player); select({ kind: 'player', id }); flyToHit({ kind: 'player', id }, false); return; }
    const ev = t.closest('[data-vnum]');
    if (ev && ev.classList.contains('dh-ev')) { const vnum = Number(ev.dataset.vnum); select({ kind: 'room', vnum }); flyToHit({ kind: 'room', vnum }, true); }
  });

  function show() {
    if (open || !allowed()) return;
    const d = diku();
    hadLock = !!document.pointerLockElement;
    wasPaused = d.state.paused;
    d.state.paused = true;
    d.player.keys.clear();
    d.player.controls.unlock();
    root.classList.add('open');
    document.body.classList.add('dashing');
    open = true;
    events = []; who = []; health = null;
    $('dh-log').innerHTML = '<div class="dh-empty">Asking the server ...</div>';
    if (atlas) godView();
    renderToggles();
    subscribe();
  }

  function hide() {
    if (!open) return;
    const d = diku();
    root.classList.remove('open');
    document.body.classList.remove('dashing');
    open = false;
    sendDash({ op: 'unsub' });
    if (view) { view.follow = null; view.keys.clear(); }
    card = null;
    $('dh-search').blur();
    if (!hadLock) d.state.paused = wasPaused;
    d.player.requestLock();
  }

  function toggle() { if (open) hide(); else if (playable()) show(); }

  const typing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  document.addEventListener('keydown', (event) => {
    if (open) {
      if (event.code === KEY && !event.repeat) { event.preventDefault(); event.stopImmediatePropagation(); hide(); return; }
      if (typing(event.target)) { event.stopImmediatePropagation(); return; }   // the search box has it
      if (event.code === 'Escape') { if (card) { card = null; renderCard(); renderWho(); } else hide(); return; }
      if (!event.ctrlKey && !event.metaKey) { event.preventDefault(); if (view) view.keys.add(event.code); }
      event.stopImmediatePropagation();   // the game does not hear a key while this is up
      return;
    }
    if (event.code !== KEY || event.ctrlKey || event.metaKey || event.altKey) return;
    if (typing(event.target) || event.repeat || !playable() || !allowed()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show();
  }, true);
  document.addEventListener('keyup', (event) => {
    if (!open) return;
    if (view) view.keys.delete(event.code);
    event.stopImmediatePropagation();
  }, true);
  window.addEventListener('blur', () => { if (view) view.keys.clear(); });

  for (const type of ['mousedown', 'contextmenu']) {
    document.addEventListener(type, (event) => {
      if (open && !root.contains(event.target)) event.stopImmediatePropagation();
    }, { capture: true });
  }

  return {
    attach, show, hide, toggle, allowed,
    get open() { return open; },
    /** main.js's frame, while this is up: the god view instead of the world. */
    render(dt) { if (view && view.ready) view.render(dt); },
    get view() { return view; },
    select, search,
  };
}
