/**
 * The implementor's dashboard: the whole server at a glance -- who is on and
 * how they are, everything that happens, the server's health -- and the
 * act_wiz.c commands an owner reaches for, as buttons. See server/dash.mjs
 * for the other side; the server decides who may see any of it, this page
 * only decides whether to offer the key.
 *
 * Backquote (`) opens it, and closes it (CLAUDE.md: every panel closes on
 * the key that opened it; Escape works too, but nothing depends on it), as
 * does typing `dashboard` at the prompt. The key does nothing unless the
 * page is connected to a server that lists the dashboard among its features
 * and the character is the implementor (trust 40). Alone, nothing here runs.
 *
 * Like help.js it reaches the game only through `window.diku`, and like the
 * help screen it gives the mouse back and holds the game while it is up.
 */

const KEY = 'Backquote';
const TRUST = 40;
/** Lines kept on the page: the server keeps 400, and a long session adds to them. */
const KEEP = 1500;
const CATEGORIES = [
  ['conn', 'logins'], ['fight', 'fights'], ['death', 'deaths'], ['talk', 'talk'],
  ['wiz', 'wizards'], ['site', 'site'], ['server', 'server'], ['reset', 'resets'],
];
const OFF_BY_DEFAULT = new Set(['reset']);

const CSS = `
#dash { position: fixed; inset: 0; z-index: 46; display: none;
  background: rgba(6, 6, 9, 0.8); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  font-family: var(--serif); color: var(--ink); font-size: clamp(11px, min(0.95vw, 1.6vh), 18px); }
#dash.open { display: flex; }
#dash-panel { margin: 2.2vh 2vw; flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1em;
  background: rgba(14, 12, 10, 0.94); border: 1px solid var(--edge); border-radius: 3px; padding: 1.3em 1.7em 1.2em; }
#dash header { display: flex; align-items: baseline; justify-content: space-between; gap: 1em;
  padding-bottom: 0.6em; border-bottom: 1px solid rgba(224,189,119,0.13); }
#dash h2 { margin: 0; font-size: 1.8em; font-weight: 400; letter-spacing: 0.02em; }
#dash .sub, #dash h3, #dash .mono { font-family: var(--mono); letter-spacing: 0.14em; text-transform: uppercase; }
#dash .sub { font-size: 0.78em; color: var(--gold); opacity: 0.75; display: flex; gap: 1.6em; }
#dash h3 { margin: 0 0 0.5em; font-weight: 400; font-size: 0.78em; color: var(--gold);
  display: flex; justify-content: space-between; align-items: baseline; gap: 1em; }
#dash h3 small { text-transform: none; letter-spacing: 0.04em; color: var(--dim); font-size: 1em; }
.dh-tiles { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 0.8em; }
.dh-tile { border: 1px solid rgba(224,189,119,0.16); border-radius: 3px; padding: 0.6em 0.8em 0.55em; min-width: 0; }
.dh-tile .k { font-family: var(--mono); font-size: 0.7em; letter-spacing: 0.16em; text-transform: uppercase; color: var(--dim); }
.dh-tile .v { font-size: 1.65em; line-height: 1.15; margin-top: 0.15em; white-space: nowrap; }
.dh-tile .v small { font-size: 0.55em; color: var(--dim); margin-left: 0.25em; }
.dh-tile .s { font-family: var(--mono); font-size: 0.72em; color: var(--dim); margin-top: 0.25em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dh-tile canvas { width: 100%; height: 2.2em; margin-top: 0.3em; display: block; }
.dh-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 1.6em; }
.dh-left { display: flex; flex-direction: column; gap: 1em; min-height: 0; }
.dh-who { overflow: auto; min-height: 6em; flex: 1 1 auto; scrollbar-width: thin; scrollbar-color: rgba(224,189,119,0.25) transparent; }
.dh-who table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.dh-who th { font-family: var(--mono); font-weight: 400; font-size: 0.72em; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--dim); text-align: left; padding: 0 0.6em 0.45em 0; border-bottom: 1px solid rgba(224,189,119,0.18); position: sticky; top: 0; background: rgb(14,12,10); }
.dh-who td { padding: 0.45em 0.6em 0.45em 0; border-bottom: 1px solid rgba(224,189,119,0.07); vertical-align: top; }
.dh-who tr.followed td { background: rgba(224,189,119,0.07); }
.dh-who tr.followed td:first-child { box-shadow: inset 2px 0 0 rgba(224,189,119,0.7); padding-left: 0.5em; }
.dh-who .nm { font-size: 1.08em; }
.dh-who .mono, .dh-who .m { font-family: var(--mono); font-size: 0.78em; letter-spacing: 0.04em; color: var(--dim); text-transform: none; }
.dh-bars { display: grid; gap: 2px; width: 6.5em; }
.dh-bar { height: 5px; background: rgba(240,227,200,0.08); border-radius: 1px; overflow: hidden; }
.dh-bar i { display: block; height: 100%; }
.dh-bar.hp i { background: #c9785f; } .dh-bar.mn i { background: #7f9fc4; } .dh-bar.mv i { background: #9fb27a; }
.dh-flag { display: inline-block; font-family: var(--mono); font-size: 0.68em; letter-spacing: 0.1em; padding: 0.1em 0.4em;
  border: 1px solid rgba(207,120,100,0.6); color: #e2a593; border-radius: 2px; margin: 0 0.3em 0.2em 0; }
.dh-flag.quiet { border-color: rgba(181,162,132,0.4); color: var(--dim); }
#dash button { font-family: var(--mono); font-size: 0.72em; letter-spacing: 0.08em; color: var(--gold); cursor: pointer;
  background: rgba(224,189,119,0.06); border: 1px solid rgba(224,189,119,0.32); border-radius: 2px; padding: 0.3em 0.55em; margin: 0 0.25em 0.25em 0; }
#dash button:hover { background: rgba(224,189,119,0.16); }
#dash button.on { background: rgba(224,189,119,0.22); border-color: rgba(224,189,119,0.75); }
#dash button.off { opacity: 0.42; }
.dh-map { flex: 0 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) 15em; gap: 1em; align-items: start; }
.dh-map canvas { width: 100%; height: 30vh; display: block; border: 1px solid rgba(224,189,119,0.14); border-radius: 3px; background: rgba(5,5,7,0.6); }
.dh-map .info { font-size: 0.92em; line-height: 1.45; color: #e2d6bc; }
.dh-did { font-family: var(--mono); font-size: 0.78em; color: var(--dim); min-height: 1.3em; white-space: pre-wrap; }
.dh-right { display: flex; flex-direction: column; min-height: 0; }
.dh-chips { margin-bottom: 0.6em; }
.dh-log { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(224,189,119,0.25) transparent; }
.dh-ev { display: grid; grid-template-columns: 5.6em 4.6em minmax(0, 1fr); gap: 0.6em; padding: 0.22em 0; font-size: 0.92em; line-height: 1.38; }
.dh-ev .t { font-family: var(--mono); font-size: 0.8em; color: var(--dim); padding-top: 0.15em; }
.dh-ev .c { font-family: var(--mono); font-size: 0.7em; letter-spacing: 0.12em; text-transform: uppercase; color: var(--gold); opacity: 0.8; padding-top: 0.25em; }
.dh-ev .x { color: #e2d6bc; overflow-wrap: anywhere; }
.dh-ev.talk .x { font-style: italic; color: #e9dcc0; }
.dh-ev.death .x { color: #e6b6a6; }
.dh-ev.warn .x { color: #e8c27a; } .dh-ev.error .x { color: #f09a86; }
.dh-ev .lv { font-family: var(--mono); font-style: normal; font-size: 0.7em; letter-spacing: 0.12em; margin-right: 0.5em; padding: 0.05em 0.35em; border-radius: 2px; }
.dh-ev.warn .lv { border: 1px solid rgba(232,194,122,0.6); color: #e8c27a; }
.dh-ev.error .lv { border: 1px solid rgba(240,154,134,0.7); color: #f09a86; }
.dh-ev .priv { font-family: var(--mono); font-style: normal; font-size: 0.7em; letter-spacing: 0.12em; margin-right: 0.5em;
  padding: 0.05em 0.35em; border: 1px dashed rgba(181,162,132,0.6); color: var(--dim); border-radius: 2px; }
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
  root.innerHTML = `<div id="dash-panel" role="dialog" aria-label="Implementor's dashboard">
    <header><h2>The implementor's dashboard</h2><div class="sub"><span id="dh-server"></span><span>\` to close</span></div></header>
    <div class="dh-tiles" id="dh-tiles"></div>
    <div class="dh-body">
      <div class="dh-left">
        <h3>Who is on <small id="dh-who-n"></small></h3>
        <div class="dh-who" id="dh-who"></div>
        <div class="dh-did" id="dh-did"></div>
        <div class="dh-map" id="dh-map" hidden>
          <canvas id="dh-map-canvas" width="900" height="420"></canvas>
          <div class="info" id="dh-map-info"></div>
        </div>
      </div>
      <div class="dh-right">
        <h3>What happens <small id="dh-ev-n"></small></h3>
        <div class="dh-chips" id="dh-chips"></div>
        <div class="dh-log" id="dh-log"></div>
      </div>
    </div>
  </div>`;
  document.body.appendChild(root);
  return root;
}

export function createDashboard({ getLink }) {
  const root = build();
  const $ = (id) => root.querySelector(`#${id}`);
  const typing = (t) => !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  let open = false;
  let wasPaused = false;
  let hadLock = false;
  let attached = null;
  let offs = [];
  const shown = new Set(CATEGORIES.map(([c]) => c).filter((c) => !OFF_BY_DEFAULT.has(c)));
  let events = [];
  let who = [];
  let health = null;
  let follow = null;
  let map = null;
  let tracked = null;

  /** Connected, as the implementor, to a server that has a dashboard. */
  function allowed() {
    const d = window.diku;
    const link = getLink();
    if (!link || link.mode !== 'socket' || !link.link || link.link.closed) return false;
    const features = (link.link.hello && link.link.hello.features) || [];
    return features.includes('dash') && !!d && !!d.game && (d.game.state.trust || d.game.state.level || 0) >= TRUST;
  }

  function playable() {
    const d = window.diku;
    if (!d || !d.state || !d.options) return false;
    if (!document.getElementById('title').classList.contains('hidden')) return false;
    return !d.options.open;
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
  function subscribe() { sendDash({ op: 'sub' }); if (follow !== null) sendDash({ op: 'follow', id: follow }); }

  function receive(msg) {
    switch (msg.k) {
      case 'snap':
        events = msg.ev.slice();
        who = msg.who; health = msg.health;
        renderAll();
        return;
      case 'batch':
        if (msg.ev.length) { events.push(...msg.ev); if (events.length > KEEP) events.splice(0, events.length - KEEP); appendEvents(msg.ev); }
        if (msg.who) { who = msg.who; renderWho(); }
        if (msg.health) { health = msg.health; renderTiles(); }
        return;
      case 'map': map = msg; drawMap(); return;
      case 'track': tracked = msg; drawMap(); return;
      case 'did':
        $('dh-did').textContent = `${msg.op}: ${msg.lines.length ? msg.lines.join(' · ') : (msg.ok ? 'done' : 'refused')}`;
        return;
      case 'off': case 'no':
        $('dh-did').textContent = msg.why;
        if (msg.k === 'off' || open) hide();
        return;
      default:
    }
  }

  // ------------------------------------------------------------ rendering --
  function tile(k, v, s, extra = '') {
    return `<div class="dh-tile"><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s" title="${esc(s)}">${esc(s)}</div>` : ''}${extra}</div>`;
  }

  function renderTiles() {
    const h = health;
    if (!h) return;
    const link = getLink();
    $('dh-server').textContent = `${link && link.link ? link.link.url.replace(/^wss?:\/\//, '') : ''} · up ${ago(h.up)}`;
    const resetLine = h.resets.recent.length ? `last ${h.resets.recent[0][0]}, ${ago(h.resets.recent[0][1])} ago` : 'none yet';
    $('dh-tiles').innerHTML = [
      tile('Players', `${h.players}<small>${h.linkdead ? `${h.linkdead} link-dead` : 'online'}</small>`, `${h.subscribers} watching this dashboard`),
      tile('Tick', `${h.tickMean.toFixed(2)}<small>ms mean</small>`, `max ${h.tickMax.toFixed(2)} ms over 5 s · 2 min below`, '<canvas id="dh-spark" width="300" height="56"></canvas>'),
      tile('In', `${h.kbIn.toFixed(1)}<small>KB/s</small>`, `${h.msgsIn.toFixed(0)} msgs/s · ${h.refused} positions refused`),
      tile('Out', `${h.kbOut.toFixed(1)}<small>KB/s</small>`, `${h.msgsOut.toFixed(0)} msgs/s · dashboard ${h.kbDash.toFixed(2)} KB/s · ${h.events.toFixed(0)} events/s`),
      tile('Memory', `${h.rss.toFixed(0)}<small>MB rss</small>`, `heap ${h.heap.toFixed(0)} MB · ${h.mobs} of ${h.mobsAll} mobiles alive`),
      tile('Site', `${h.wizlock ? 'wizlocked' : 'open'}`, `${h.resets.total} resets, ${resetLine} · ${h.bans.length ? `bans: ${h.bans.join(', ')}` : 'no bans'}`,
        `<div style="margin-top:0.4em"><button data-act="wizlock" data-on="${h.wizlock ? 0 : 1}">${h.wizlock ? 'lift the wizlock' : 'wizlock'}</button></div>`),
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
    g.fillStyle = 'rgba(224,189,119,0.18)';
    ticks.forEach(([, max], i) => { const h = (max / top) * H; g.fillRect(x0 + i * step - 1, H - h, 2, h); });
    g.strokeStyle = 'rgba(224,189,119,0.95)';
    g.lineWidth = 2;
    g.beginPath();
    ticks.forEach(([mean], i) => { const x = x0 + i * step; const y = H - (mean / top) * H; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
    canvas.title = `tick time, last ${ticks.length} s: mean now ${ticks.at(-1)[0]} ms, worst ${Math.max(...ticks.map((t) => t[1]))} ms (scale 0-${top.toFixed(1)} ms)`;
  }

  function renderWho() {
    $('dh-who-n').textContent = `${who.length} in the game`;
    if (!who.length) { $('dh-who').innerHTML = '<div class="dh-empty">Nobody.</div>'; return; }
    const me = window.diku && window.diku.game ? window.diku.game.state.name : null;
    $('dh-who').innerHTML = `<table><thead><tr><th>Who</th><th>Vitals</th><th>Where</th><th>Doing</th><th>Link</th><th></th></tr></thead><tbody>${who.map((p) => `
      <tr class="${p.id === follow ? 'followed' : ''}">
        <td><div class="nm">${esc(p.name)}</div><div class="m">L${p.level} ${esc(p.cls)}${p.trust > p.level ? ` · trust ${p.trust}` : ''}</div>
          ${p.flags.map((f) => `<span class="dh-flag${f === 'KILLER' || f === 'THIEF' ? '' : ' quiet'}">${f}</span>`).join('')}</td>
        <td><div class="dh-bars" title="hp ${p.hp}/${p.maxHp} · mana ${p.mana}/${p.maxMana} · move ${p.move}/${p.maxMove}">
          <div class="dh-bar hp"><i style="width:${pct(p.hp, p.maxHp)}%"></i></div>
          <div class="dh-bar mn"><i style="width:${pct(p.mana, p.maxMana)}%"></i></div>
          <div class="dh-bar mv"><i style="width:${pct(p.move, p.maxMove)}%"></i></div></div>
          <div class="m">${p.hp}/${p.maxHp} hp</div></td>
        <td>${esc(p.room)}<div class="m">#${p.vnum} · ${esc(p.zoneName)}</div></td>
        <td>${esc(p.pos)}${p.fighting ? ` <span class="m">vs ${esc(p.fighting)}</span>` : ''}<div class="m">idle ${ago(p.idle)}</div></td>
        <td>${p.linkdead !== null ? `<span class="dh-flag">LINK-DEAD ${ago(p.linkdead)}</span>` : '<span class="m">connected</span>'}
          <div class="m">${esc(p.host)}${p.snoopedBy ? ` · snooped by ${esc(p.snoopedBy)}` : ''}</div></td>
        <td>${p.name === me ? '<span class="m">you</span>' : `
          <button data-act="goto" data-id="${p.id}">goto</button><button data-act="transfer" data-id="${p.id}">transfer</button><button data-act="snoop" data-id="${p.id}" class="${p.snoopedBy === me ? 'on' : ''}">snoop</button><button data-act="restore" data-id="${p.id}">restore</button>`}<button data-act="follow" data-id="${p.id}" class="${p.id === follow ? 'on' : ''}">follow</button></td>
      </tr>`).join('')}</tbody></table>`;
    if (follow !== null && !who.some((p) => p.id === follow)) setFollow(null);
    if (follow !== null) drawMap();
  }

  function renderChips() {
    $('dh-chips').innerHTML = CATEGORIES.map(([c, label]) => {
      const n = events.filter((e) => e.c === c).length;
      return `<button data-chip="${c}" class="${shown.has(c) ? 'on' : 'off'}">${label} ${n}</button>`;
    }).join('');
  }

  function eventHtml(e) {
    const lvl = e.lvl ? `<span class="lv">${e.lvl === 'error' ? 'ERROR' : 'WARN'}</span>` : '';
    const priv = e.priv ? '<span class="priv">PRIVATE</span>' : '';
    return `<div class="dh-ev ${e.c}${e.lvl ? ` ${e.lvl}` : ''}"><span class="t">${clock(e.at)}</span><span class="c">${e.c}</span><span class="x">${lvl}${priv}${esc(e.text)}</span></div>`;
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

  function renderAll() { renderTiles(); renderWho(); renderEvents(); }

  // --------------------------------------------------------------- the map --
  function setFollow(id) {
    follow = id;
    map = id === null ? map : map;
    tracked = null;
    sendDash({ op: 'follow', id });
    $('dh-map').hidden = id === null;
    renderWho();
  }

  /**
   * The followed player's zone from above, north up (north is -z), at a
   * fixed 1.4 px a metre round them: rooms on their level bright, others
   * faint, the streets between, everyone else in the zone as a dot.
   */
  function drawMap() {
    const canvas = $('dh-map-canvas');
    if (follow === null || !map || !tracked) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (rect.width > 0 && (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr))) {
      canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    }
    const g = canvas.getContext('2d');
    const W = canvas.width; const H = canvas.height;
    const scale = 1.4 * dpr;
    const C = map.cell;
    const level = map.rooms.find((r) => r[0] === tracked.vnum)?.[3] ?? 0;
    const sx = (x) => W / 2 + (x - tracked.x) * scale;
    const sy = (z) => H / 2 + (z - tracked.z) * scale;
    g.clearRect(0, 0, W, H);
    g.lineCap = 'round';
    for (const st of map.streets) {
      const [lv, ...cells] = st;
      g.strokeStyle = lv === level ? 'rgba(224,189,119,0.32)' : 'rgba(224,189,119,0.08)';
      g.lineWidth = (lv === level ? 3 : 2) * dpr;
      g.beginPath();
      for (let i = 0; i < cells.length; i += 2) { const x = sx(cells[i] * C); const y = sy(cells[i + 1] * C); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke();
    }
    const half = 4.2 * scale;
    for (const [vnum, cx, cz, lv] of map.rooms) {
      const x = sx(cx * C); const y = sy(cz * C);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      g.fillStyle = vnum === tracked.vnum ? 'rgba(224,189,119,0.55)' : lv === level ? 'rgba(240,227,200,0.2)' : 'rgba(240,227,200,0.05)';
      g.fillRect(x - half, y - half, 2 * half, 2 * half);
    }
    // Everyone else in this zone, where the roster last put them (once a second).
    g.font = `${11 * dpr}px ${getComputedStyle(root).getPropertyValue('--mono') || 'monospace'}`;
    for (const p of who) {
      if (p.id === follow || p.zone !== map.zone || p.x === null) continue;
      const x = sx(p.x); const y = sy(p.z);
      g.fillStyle = '#9fb3c9';
      g.beginPath(); g.arc(x, y, 4 * dpr, 0, Math.PI * 2); g.fill();
      g.fillText(p.name, x + 7 * dpr, y + 4 * dpr);
    }
    // The followed: a dot and the way they face. Forward is (-sin yaw, -cos yaw) in x, z.
    const x = W / 2; const y = H / 2;
    const fx = -Math.sin(tracked.yaw); const fz = -Math.cos(tracked.yaw);
    g.fillStyle = 'rgba(224,189,119,0.35)';
    g.beginPath(); g.moveTo(x, y);
    g.arc(x, y, 26 * dpr, Math.atan2(fz, fx) - 0.5, Math.atan2(fz, fx) + 0.5);
    g.closePath(); g.fill();
    g.fillStyle = '#e0bd77';
    g.beginPath(); g.arc(x, y, 5.5 * dpr, 0, Math.PI * 2); g.fill();
    const p = who.find((q) => q.id === follow);
    $('dh-map-info').innerHTML = p
      ? `<b>${esc(p.name)}</b> in ${esc(map.name)}<br>#${tracked.vnum} ${esc(p.vnum === tracked.vnum ? p.room : '')}<br><span class="mono" style="font-size:0.75em;color:var(--dim)">${tracked.x.toFixed(1)}, ${tracked.z.toFixed(1)} · facing ${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((Math.atan2(fx, -fz) * 180 / Math.PI + 360) % 360) / 45) % 8]}</span>`
        + '<br><br><span style="color:var(--dim)">live at 10 Hz; goto jumps you there.</span>'
      : '';
  }

  // ------------------------------------------------------------ the panel --
  root.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-chip]');
    if (chip) {
      const c = chip.dataset.chip;
      if (shown.has(c)) shown.delete(c); else shown.add(c);
      renderEvents();
      return;
    }
    const b = event.target.closest('[data-act]');
    if (!b) { if (event.target === root) hide(); return; }
    const act = b.dataset.act;
    const id = b.dataset.id !== undefined ? Number(b.dataset.id) : null;
    if (act === 'follow') { setFollow(follow === id ? null : id); return; }
    if (act === 'wizlock') { sendDash({ op: 'wizlock', on: b.dataset.on === '1' }); return; }
    sendDash({ op: act, id });
  });

  function show() {
    if (open || !allowed()) return;
    const d = window.diku;
    hadLock = !!document.pointerLockElement;
    wasPaused = d.state.paused;
    d.state.paused = true;
    d.player.keys.clear();
    d.player.controls.unlock();
    root.classList.add('open');
    open = true;
    events = []; who = []; health = null;
    $('dh-log').innerHTML = '<div class="dh-empty">Asking the server ...</div>';
    $('dh-did').textContent = '';
    $('dh-map').hidden = follow === null;
    subscribe();
  }

  function hide() {
    if (!open) return;
    const d = window.diku;
    root.classList.remove('open');
    open = false;
    sendDash({ op: 'unsub' });
    if (follow !== null) { follow = null; map = null; tracked = null; }
    if (!hadLock) d.state.paused = wasPaused;
    d.player.requestLock();
  }

  function toggle() { if (open) hide(); else if (playable()) show(); }

  document.addEventListener('keydown', (event) => {
    if (open) {
      if (event.code === 'Escape') { hide(); return; }
      if (event.code === KEY && !event.repeat) { event.preventDefault(); hide(); }
      else if (!event.ctrlKey && !event.metaKey) event.preventDefault();
      event.stopImmediatePropagation();   // the game does not hear a key while this is up
      return;
    }
    if (event.code !== KEY || event.ctrlKey || event.metaKey || event.altKey) return;
    if (typing(event.target) || event.repeat || !playable() || !allowed()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    show();
  }, true);

  for (const type of ['mousedown', 'wheel', 'contextmenu']) {
    document.addEventListener(type, (event) => {
      if (open && !root.contains(event.target)) event.stopImmediatePropagation();
      else if (open && type !== 'wheel') event.stopPropagation();
    }, { capture: true, passive: type === 'wheel' ? true : undefined });
  }
  window.addEventListener('resize', () => { if (open) drawMap(); });

  return { attach, show, hide, toggle, get open() { return open; }, allowed };
}
