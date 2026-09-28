/**
 * The overlay. Room name and description are the mud's own text, shown the way
 * you'd read them on a terminal: the title first, then the prose, revealed as
 * you arrive. The minimap draws the layout grid rather than the geometry, so it
 * looks like the map you'd sketch on paper while exploring.
 */

import { SECTOR, SECTOR_NAME, DIR_NAME } from './are.js';

const SECTOR_COLOUR = {
  [SECTOR.INSIDE]: '#8a7f6a',
  [SECTOR.CITY]: '#9aa2ad',
  [SECTOR.FIELD]: '#7f9455',
  [SECTOR.FOREST]: '#4d6b3a',
  [SECTOR.HILLS]: '#8b8455',
  [SECTOR.MOUNTAIN]: '#6f6a63',
  [SECTOR.WATER_SWIM]: '#4a7f92',
  [SECTOR.WATER_NOSWIM]: '#2f5a70',
  [SECTOR.AIR]: '#9fb6cc',
  [SECTOR.DESERT]: '#c2a877',
};

/* ---------------------------------------------------------------- compass -- */

const CARD_R = 63;        // the rotating card
const RING_INNER = 65;    // where the brass meets the glass
const HOUSING_R = 74;     // outer edge of the brass
const PAD = 5;            // room for the shadow the housing casts
// Drawn at this size and shown a little smaller by the stylesheet, which costs
// nothing and supersamples the graduations for free.
const COMPASS_SIZE = (HOUSING_R + PAD) * 2;

/** A canvas with the origin already at its centre and the DPR already applied. */
function offscreen(size, dpr) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(size * dpr);
  canvas.height = Math.ceil(size * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.translate(size / 2, size / 2);
  return { canvas, ctx };
}

/** Screen position of a point at bearing `deg` and radius `r`, north up. */
function polar(deg, r) {
  const a = (deg * Math.PI) / 180;
  return [Math.sin(a) * r, -Math.cos(a) * r];
}

/**
 * One arm of the rose, split down its axis into a lit and a shadowed half.
 * The lit half is always the counter-clockwise one, so the arms alternate all
 * the way round and the whole thing reads as engraved rather than drawn.
 */
function armOfTheRose(ctx, deg, len, half, light, dark) {
  const a = (deg * Math.PI) / 180;
  const [tx, ty] = [Math.sin(a) * len, -Math.cos(a) * len];
  const [px, py] = [Math.cos(a) * half, Math.sin(a) * half];
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(tx, ty); ctx.lineTo(-px, -py); ctx.closePath();
  ctx.fillStyle = light; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(tx, ty); ctx.lineTo(px, py); ctx.closePath();
  ctx.fillStyle = dark; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-px, -py); ctx.lineTo(tx, ty); ctx.lineTo(px, py);
  ctx.lineWidth = 0.7; ctx.strokeStyle = 'rgba(224,189,119,0.38)'; ctx.stroke();
}

/**
 * North, drawn the way every rose since Reinel has drawn it. Kept half again
 * as tall as it is wide and pointed at the top: at this size the silhouette is
 * all that survives, and lobes that splay sideways read as an insect.
 */
function fleurDeLis(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.bezierCurveTo(0.15 * s, -0.66 * s, 0.17 * s, -0.30 * s, 0.15 * s, -0.04 * s);
  ctx.lineTo(-0.15 * s, -0.04 * s);
  ctx.bezierCurveTo(-0.17 * s, -0.30 * s, -0.15 * s, -0.66 * s, 0, -s);
  ctx.closePath(); ctx.fill();
  for (const side of [1, -1]) {
    ctx.beginPath();
    ctx.moveTo(side * 0.12 * s, -0.12 * s);
    ctx.bezierCurveTo(side * 0.50 * s, -0.50 * s, side * 0.54 * s, -0.10 * s, side * 0.30 * s, 0);
    ctx.lineTo(side * 0.12 * s, 0);
    ctx.closePath(); ctx.fill();
  }
  ctx.fillRect(-0.32 * s, 0, 0.64 * s, 0.09 * s);
  ctx.beginPath();
  ctx.moveTo(-0.10 * s, 0.09 * s); ctx.lineTo(0.10 * s, 0.09 * s);
  ctx.lineTo(0.05 * s, 0.26 * s); ctx.lineTo(-0.05 * s, 0.26 * s);
  ctx.closePath(); ctx.fill();
}

/** The card: blackened brass, graduated, and magnetised to the world. */
function drawCard(dpr) {
  const { canvas, ctx } = offscreen(CARD_R * 2, dpr);

  const face = ctx.createRadialGradient(-CARD_R * 0.28, -CARD_R * 0.32, CARD_R * 0.04, 0, 0, CARD_R);
  face.addColorStop(0, '#1d1913');
  face.addColorStop(0.55, '#13100a');
  face.addColorStop(1, '#0a0806');
  ctx.fillStyle = face;
  ctx.beginPath(); ctx.arc(0, 0, CARD_R, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = 'rgba(224,189,119,0.055)';
  ctx.lineWidth = 8;
  ctx.beginPath(); ctx.arc(0, 0, 58, 0, Math.PI * 2); ctx.stroke();

  for (const r of [62, 54, 34]) {
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(224,189,119,0.28)';
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  }

  // Ten and thirty, not five and fifteen. A marine card is graduated every 5°,
  // but shown 136 px across that is 72 ticks five pixels apart, and a rotating
  // card resolves a different subset of them every frame -- the ring crawls,
  // which no still will ever show you. Fifteen matched no real card anyway.
  ctx.lineCap = 'butt';
  for (let deg = 0; deg < 360; deg += 10) {
    const major = deg % 30 === 0;
    const [x0, y0] = polar(deg, 62);
    const [x1, y1] = polar(deg, major ? 54 : 58.5);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.lineWidth = major ? 2 : 1.1;
    ctx.strokeStyle = major ? 'rgba(243,220,160,0.95)' : 'rgba(224,196,150,0.55)';
    ctx.stroke();
  }

  // half-winds: hairlines only, or sixteen solid arms turn to mush at this size
  for (let i = 0; i < 8; i++) {
    const [x0, y0] = polar(i * 45 + 22.5, 6);
    const [x1, y1] = polar(i * 45 + 22.5, 16.5);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    ctx.lineWidth = 0.9; ctx.strokeStyle = 'rgba(224,189,119,0.34)'; ctx.stroke();
  }

  // Every real rose runs cardinal > intercardinal > half-wind, strictly. Get
  // that order wrong and it stops being a rose and becomes a four-armed burst
  // with spikes between the arms.
  for (let i = 0; i < 4; i++) armOfTheRose(ctx, i * 90 + 45, 26, 4.4, '#cdc0a4', '#4e4638');
  for (const deg of [90, 180, 270]) armOfTheRose(ctx, deg, 33, 5.0, '#ece0c4', '#5d5445');
  armOfTheRose(ctx, 0, 33, 5.0, '#f2d9a2', '#8a6a2e');

  // Letters stand with their tops outward, so whichever point is under the
  // lubber index reads upright -- which is the whole trick of a card compass.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [deg, text, px, alpha] of [
    [90, 'E', 15, 0.95], [180, 'S', 15, 0.95], [270, 'W', 15, 0.95],
    [45, 'NE', 8, 0.6], [135, 'SE', 8, 0.6], [225, 'SW', 8, 0.6], [315, 'NW', 8, 0.6],
  ]) {
    const [x, y] = polar(deg, 44);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.font = `${px}px "Iowan Old Style", Palatino, Georgia, serif`;
    ctx.fillStyle = `rgba(240,227,200,${alpha})`;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // Sized and placed to sit inside the band between the two hairlines rather
  // than across them: tip at 53, foot at 35.4, band 34 to 54.
  ctx.save();
  ctx.translate(0, -39);
  ctx.fillStyle = '#f2d492';
  fleurDeLis(ctx, 14);
  ctx.restore();

  return canvas;
}

/** The housing: brass, glass and the fixed index you read the card against. */
function drawHousing(dpr) {
  const { canvas, ctx } = offscreen(COMPASS_SIZE, dpr);

  const rim = ctx.createRadialGradient(0, 0, RING_INNER * 0.6, 0, 0, RING_INNER);
  rim.addColorStop(0, 'rgba(0,0,0,0)');
  rim.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = rim;
  ctx.beginPath(); ctx.arc(0, 0, RING_INNER, 0, Math.PI * 2); ctx.fill();

  // The pivot cap. Small and dark, because a real one is agate or sapphire --
  // and because the point where sixteen rays converge is the heart of a rose
  // and should not be under a shiny ball.
  const cap = ctx.createRadialGradient(-1.1, -1.3, 0.2, 0, 0, 4);
  cap.addColorStop(0, '#dcc48c'); cap.addColorStop(0.5, '#856733'); cap.addColorStop(1, '#221a0d');
  ctx.fillStyle = cap;
  ctx.beginPath(); ctx.arc(0, 0, 3.6, 0, Math.PI * 2); ctx.fill();

  // One sheen and one wet edge where the glass meets the lip. More than that
  // and it stops reading as glass and starts reading as fog over the card.
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, RING_INNER, 0, Math.PI * 2); ctx.clip();
  const sheen = ctx.createLinearGradient(-RING_INNER, -RING_INNER, RING_INNER * 0.4, RING_INNER * 0.25);
  sheen.addColorStop(0, 'rgba(255,246,226,0.20)');
  sheen.addColorStop(0.45, 'rgba(255,246,226,0.04)');
  sheen.addColorStop(1, 'rgba(255,246,226,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(-RING_INNER, -RING_INNER, RING_INNER * 2, RING_INNER * 2);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = 'rgba(255,246,226,0.30)';
  ctx.beginPath();
  ctx.arc(0, 0, RING_INNER - 1, Math.PI * 0.94, Math.PI * 1.72);
  ctx.stroke();
  ctx.restore();

  // Aged brass, lit from the upper left. Deep lows rather than bright highs --
  // a bright ring here is the brightest thing on the screen and pulls the eye
  // off the town.
  const brass = ctx.createConicGradient(-Math.PI * 0.75, 0, 0);
  for (const [at, hex] of [
    [0, '#dcc189'], [0.10, '#93743e'], [0.25, '#3e3119'], [0.40, '#7a5f33'],
    [0.50, '#c6aa77'], [0.62, '#6d5429'], [0.75, '#332714'], [0.90, '#8a6c3b'], [1, '#dcc189'],
  ]) brass.addColorStop(at, hex);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 7;
  ctx.shadowOffsetY = 2;
  ctx.strokeStyle = brass;
  ctx.lineWidth = HOUSING_R - RING_INNER;
  ctx.beginPath(); ctx.arc(0, 0, (HOUSING_R + RING_INNER) / 2, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // A conic gradient alone is flat across the width of the ring, and a ring
  // whose section has no profile reads as a painted band rather than a turned
  // bezel. Crown a third of the way out, both flanks in shadow.
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,240,210,0.10)';
  ctx.beginPath(); ctx.arc(0, 0, (HOUSING_R + RING_INNER) / 2 + 1.3, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  ctx.beginPath(); ctx.arc(0, 0, HOUSING_R - 1.2, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = 'rgba(0,0,0,0.24)';
  ctx.beginPath(); ctx.arc(0, 0, RING_INNER + 1.1, 0, Math.PI * 2); ctx.stroke();

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(250,232,198,0.30)';
  ctx.beginPath(); ctx.arc(0, 0, RING_INNER + 0.5, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.beginPath(); ctx.arc(0, 0, HOUSING_R - 0.5, 0, Math.PI * 2); ctx.stroke();

  for (let i = 0; i < 4; i++) {
    const [x, y] = polar(i * 90 + 45, (HOUSING_R + RING_INNER) / 2);
    const head = ctx.createRadialGradient(x - 0.9, y - 1, 0.2, x, y, 3.4);
    head.addColorStop(0, '#f2dfb2'); head.addColorStop(1, '#4a381a');
    ctx.fillStyle = head;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = 'rgba(255,240,210,0.5)';
    ctx.beginPath(); ctx.arc(x, y, 3, Math.PI * 1.05, Math.PI * 1.85); ctx.stroke();
    const slot = i * 0.7 + 0.3;   // no two driven home at the same angle
    // Genuinely dark, or four two-pixel specks read as dirt on the ring.
    ctx.strokeStyle = 'rgba(10,7,2,0.92)'; ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(slot) * 1.7, y - Math.sin(slot) * 1.7);
    ctx.lineTo(x + Math.cos(slot) * 1.7, y + Math.sin(slot) * 1.7);
    ctx.stroke();
  }

  ctx.fillStyle = '#f4d493';
  ctx.beginPath();
  ctx.moveTo(0, -54);
  ctx.lineTo(-4.6, -RING_INNER - 1);
  ctx.lineTo(4.6, -RING_INNER - 1);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(38,24,6,0.8)'; ctx.stroke();

  return canvas;
}

/**
 * A mariner's card compass. The rose is fixed to the world and turns under the
 * index at the top, so the point beneath the index is the way you are facing.
 * Card and housing are each drawn once and blitted; only the angle changes.
 */
class CompassRose {
  constructor(canvas, dpr) {
    canvas.width = COMPASS_SIZE * dpr;
    canvas.height = COMPASS_SIZE * dpr;
    this.ctx = canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);
    this.ctx.imageSmoothingQuality = 'high';
    this.card = drawCard(dpr);
    this.housing = drawHousing(dpr);
    this.shown = 0;
    this.swing = 0;
  }

  /** Returns the bearing the card is actually showing, which is what to print. */
  draw(bearing, dt) {
    let delta = ((bearing - this.shown + 540) % 360) - 180;
    // A jump this big is a teleport, not a turn of the head; a real card would
    // never have to chase it, so don't make it.
    if (Math.abs(delta) > 90) { this.shown = bearing; this.swing = 0; delta = 0; }
    const step = Math.min(dt, 1 / 30);
    this.swing += (delta * 600 - this.swing * 38) * step;
    this.shown = (this.shown + this.swing * step + 360) % 360;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, COMPASS_SIZE, COMPASS_SIZE);
    ctx.save();
    ctx.translate(COMPASS_SIZE / 2, COMPASS_SIZE / 2);
    ctx.rotate((-this.shown * Math.PI) / 180);
    ctx.drawImage(this.card, -CARD_R, -CARD_R, CARD_R * 2, CARD_R * 2);
    ctx.restore();
    ctx.drawImage(this.housing, 0, 0, COMPASS_SIZE, COMPASS_SIZE);
    return this.shown;
  }
}

export class Hud {
  constructor(root, layout) {
    this.layout = layout;
    this.el = {
      title: root.querySelector('#room-title'),
      area: root.querySelector('#room-area'),
      desc: root.querySelector('#room-desc'),
      look: root.querySelector('#look'),
      examine: root.querySelector('#examine'),
      examineTitle: root.querySelector('#examine-title'),
      examineBody: root.querySelector('#examine-body'),
      bearing: root.querySelector('#bearing'),
      exits: root.querySelector('#exits'),
      stats: root.querySelector('#stats'),
      minimap: root.querySelector('#minimap'),
      toast: root.querySelector('#toast'),
    };
    this.ctx = this.el.minimap.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.el.minimap.width = 240 * this.dpr;
    this.el.minimap.height = 240 * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
    this.compass = new CompassRose(root.querySelector('#compass'), this.dpr);
    this.currentVnum = null;
    this.toastTimer = 0;
  }

  setRoom(room) {
    if (!room || room.vnum === this.currentVnum) return;
    this.currentVnum = room.vnum;
    this.el.title.textContent = room.name;
    this.room = room;
    this.drawArea();
    // All of it at once, revealed by a mask the stylesheet sweeps down the
    // panel. It used to be typed out a slice per frame, which left the panel
    // growing under the log for a second and a half, and any still taken
    // before the typing caught up -- or with the loop halted -- showed prose
    // cut off mid-word: "...and you lo".
    this.el.desc.textContent = room.description.replace(/\s*\n\s*/g, ' ').trim();
    this.el.desc.classList.remove('reveal');
    void this.el.desc.offsetWidth;
    this.el.desc.classList.add('reveal');
    const exits = room.exits
      .map((exit, dir) => (exit ? DIR_NAME[dir] : null))
      .filter(Boolean);
    this.el.exits.textContent = exits.length ? `exits: ${exits.join(', ')}` : 'no obvious exits';
  }

  setLook(target) {
    // A creature is named over its own head (game-ui.js's plate), with its
    // keys under the crosshair; a second copy of the name down here was one
    // label too many.
    if (!target || target.kind === 'mob') {
      this.el.look.style.opacity = '0';
      return;
    }
    this.el.look.style.opacity = '1';
    const action = this.examineOpen ? 'E — close'
      : (target.action || (target.kind === 'door'
        ? (target.door.open ? 'E — close' : (target.door.spec.locked ? 'E — unlock' : 'E — open'))
        : 'E — examine'));
    this.el.look.innerHTML = `<span class="look-name">${escapeHtml(target.title)}</span>`
      + (target.subtitle ? `<span class="look-sub">${escapeHtml(target.subtitle)}</span>` : '')
      + `<span class="look-key">${action}</span>`;
  }

  /** Is the examine panel up? The same key that opened it closes it. */
  get examineOpen() {
    return this.el.examine.classList.contains('visible');
  }

  showExamine(target) {
    this.el.examineTitle.textContent = target.title;
    this.el.examineBody.textContent = (target.body || '').replace(/\s*\n\s*/g, ' ').trim() || '(nothing more to see)';
    this.el.examine.classList.add('visible');
  }

  hideExamine() {
    this.el.examine.classList.remove('visible');
  }

  toast(text) {
    this.el.toast.textContent = text;
    this.el.toast.classList.add('visible');
    this.toastTimer = 2.6;
  }

  /**
   * The line under the room's name is the area. The vnum and the raw sector
   * are the builder's view -- "SEWER · #7220 · FOREST" read as a bug to anyone
   * else -- so they only show with the stats overlay (F).
   */
  setDebug(on) {
    this.debug = !!on;
    this.drawArea();
  }

  drawArea() {
    const room = this.room;
    if (!room) return;
    this.el.area.textContent = this.debug
      ? `${room.area} · #${room.vnum} · ${SECTOR_NAME[room.sector] || 'somewhere'}` : room.area;
  }

  setStats(text) {
    this.el.stats.textContent = text;
  }

  update(dt, camera, roomVnum) {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('visible');
    }
    // Column 2 of the camera's world matrix is its local +Z, and the camera
    // looks down -Z, so forward is the negation of it. Diku north is -Z, which
    // is why the second term is negated again: measured, not derived, because
    // at yaw 0 the camera looks at (0,0,-1) and the room the mud calls north of
    // the Market Square really does sit at a smaller z.
    const forwardX = -camera.matrixWorld.elements[8];
    const forwardZ = -camera.matrixWorld.elements[10];
    const heading = Math.atan2(forwardX, -forwardZ);
    const bearing = ((heading * 180) / Math.PI + 360) % 360;
    // Read the number off the card rather than off the camera, so the figure
    // and the letter under the index can never disagree while the card settles.
    const shown = this.compass.draw(bearing, dt);
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(shown / 45) % 8;
    const degrees = Math.round(shown) % 360;
    this.el.bearing.textContent = `${names[index]} ${degrees.toString().padStart(3, '0')}°`;
    // The map gets the true heading, not the card's: it is a marker, not an
    // instrument, and has nothing to settle.
    this.drawMinimap(roomVnum, heading);
  }

  drawMinimap(roomVnum, heading) {
    const ctx = this.ctx;
    const size = 240;
    const cell = this.layout.cells.get(roomVnum);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(10,9,8,0.55)';
    ctx.fillRect(0, 0, size, size);
    if (!cell) return;

    const step = 7.5;   // rooms sit two grid cells apart
    const reach = 15;
    const cx = size / 2;
    const cy = size / 2;
    const toScreen = (x, z) => [cx + (x - cell.x) * step, cy + (z - cell.z) * step];
    const near = (c) => Math.abs(c.x - cell.x) <= reach && Math.abs(c.z - cell.z) <= reach;

    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const link of this.layout.links) {
      if (link.from.level !== cell.level || !near(link.from)) continue;
      if (link.kind === 'alley') {
        ctx.strokeStyle = 'rgba(214,196,160,0.45)';
        ctx.beginPath();
        const chain = [link.from, ...link.path, link.to];
        chain.forEach((c, i) => {
          const [x, y] = toScreen(c.x, c.z);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      } else if (link.kind === 'portal') {
        const [x1, y1] = toScreen(link.from.x, link.from.z);
        ctx.fillStyle = '#7fd8ff';
        ctx.fillRect(x1 - 2, y1 - 2, 4, 4);
      }
    }

    for (const other of this.layout.cells.values()) {
      if (other.level !== cell.level || !near(other)) continue;
      const [x, y] = toScreen(other.x, other.z);
      const isHere = other.vnum === roomVnum;
      ctx.fillStyle = isHere ? '#f2d999' : (SECTOR_COLOUR[other.room.sector] || '#8a7f6a');
      ctx.globalAlpha = isHere ? 1 : 0.75;
      const r = isHere ? 5 : 3.6;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
      if (other.room.mobs && other.room.mobs.length && !isHere) {
        ctx.fillStyle = 'rgba(226,120,90,0.9)';
        ctx.fillRect(x + r - 2.5, y - r, 2.5, 2.5);
      }
    }

    // heading wedge. The map is north-up and the wedge is drawn pointing north,
    // so the bearing rotates it directly -- the old `yaw + PI` came out mirrored
    // and was only ever right facing north or south.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(heading);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(4.5, 3); ctx.lineTo(-4.5, 3);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(240,225,195,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
