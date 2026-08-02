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
      compass: root.querySelector('#compass'),
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
    this.currentVnum = null;
    this.typed = 0;
    this.fullText = '';
    this.toastTimer = 0;
  }

  setRoom(room) {
    if (!room || room.vnum === this.currentVnum) return;
    this.currentVnum = room.vnum;
    this.el.title.textContent = room.name;
    this.el.area.textContent = `${room.area} · #${room.vnum} · ${SECTOR_NAME[room.sector] || 'somewhere'}`;
    this.fullText = room.description.replace(/\s*\n\s*/g, ' ').trim();
    this.typed = 0;
    this.el.desc.textContent = '';
    const exits = room.exits
      .map((exit, dir) => (exit ? DIR_NAME[dir] : null))
      .filter(Boolean);
    this.el.exits.textContent = exits.length ? `exits: ${exits.join(', ')}` : 'no obvious exits';
  }

  tickText(dt) {
    if (this.typed >= this.fullText.length) return;
    this.typed = Math.min(this.fullText.length, this.typed + dt * 420);
    this.el.desc.textContent = this.fullText.slice(0, Math.floor(this.typed));
  }

  setLook(target) {
    if (!target) {
      this.el.look.style.opacity = '0';
      return;
    }
    this.el.look.style.opacity = '1';
    const action = target.kind === 'door'
      ? (target.door.open ? 'E — close' : 'E — open')
      : 'E — examine';
    this.el.look.innerHTML = `<span class="look-name">${escapeHtml(target.title)}</span>`
      + (target.subtitle ? `<span class="look-sub">${escapeHtml(target.subtitle)}</span>` : '')
      + `<span class="look-key">${action}</span>`;
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

  setStats(text) {
    this.el.stats.textContent = text;
  }

  update(dt, camera, roomVnum) {
    this.tickText(dt);
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.el.toast.classList.remove('visible');
    }
    const yaw = Math.atan2(
      -camera.matrixWorld.elements[8], -camera.matrixWorld.elements[10],
    );
    const bearing = ((yaw * 180) / Math.PI + 360) % 360;
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    // Diku north is -Z, and the camera looks down -Z at yaw 0.
    const index = Math.round(bearing / 45) % 8;
    this.el.compass.textContent = `${names[index]} ${Math.round(bearing).toString().padStart(3, '0')}°`;
    this.drawMinimap(roomVnum, yaw);
  }

  drawMinimap(roomVnum, yaw) {
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

    // heading wedge
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(yaw + Math.PI);
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
