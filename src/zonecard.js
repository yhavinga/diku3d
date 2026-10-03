/**
 * The card a crossing is made behind (main.js crossTo): the screen goes to
 * the loading screen's black, the area you are going into is named the way
 * the title names Midgaard, with the level range its #AREA line gives and the
 * first words of the room you will stand in, and a bar fills while the zone
 * is built. Then it lifts off a world that is already drawn.
 */

const FADE_IN_MS = 300;
const FADE_OUT_MS = 520;
// Long enough to read the name, short enough not to be a load screen.
const HOLD_MS = 900;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** `{ 1  5} Hatchet Mud School` -> 'levels 1 – 5'; `{ All }` -> 'all levels'. */
export function levelsOf(credits) {
  const m = /^\s*\{\s*([^}]*?)\s*\}/.exec(credits || '');
  if (!m) return '';
  const parts = m[1].split(/\s+/).filter(Boolean);
  if (parts.length === 2 && parts.every((p) => /^\d+$/.test(p))) return `levels ${parts[0]} – ${parts[1]}`;
  if (/^all$/i.test(parts[0] || '')) return 'all levels';
  return '';
}

/** The opening sentence of a room's prose, cut at a word if it runs long. */
export function firstLine(text, max = 150) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const sentence = (/^.*?[.!?](\s|$)/.exec(flat) || [flat])[0].trim();
  if (sentence.length <= max) return sentence;
  return `${sentence.slice(0, sentence.lastIndexOf(' ', max))} …`;
}

export function createZoneCard(root = document.body) {
  const el = document.createElement('div');
  el.id = 'zone-card';
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="zc-body">
      <div class="zc-way"></div>
      <h1 class="zc-name"></h1>
      <div class="zc-levels"></div>
      <p class="zc-line"><span class="zc-room"></span> <span class="zc-prose"></span></p>
      <div class="zc-track"><div class="zc-bar"></div></div>
    </div>`;
  root.appendChild(el);
  const $ = (sel) => el.querySelector(sel);
  let shownAt = 0;

  return {
    get open() { return el.classList.contains('open'); },

    /**
     * Up, and named. `way` is how you are leaving ("up, from the Temple of
     * Midgaard"); resolves once the screen is black.
     */
    async show({ name, levels = '', way = '', room = '', prose = '' }) {
      $('.zc-way').textContent = way;
      $('.zc-name').textContent = name;
      $('.zc-levels').textContent = levels;
      $('.zc-levels').hidden = !levels;
      $('.zc-room').textContent = room ? `${room}.` : '';
      $('.zc-prose').textContent = prose;
      $('.zc-bar').style.width = '0%';
      el.classList.remove('failed');
      el.classList.add('open');
      shownAt = performance.now();
      await wait(FADE_IN_MS);
      await frame();
    },

    /** How far the building has got, 0 to 1; resolves once it is painted. */
    progress(fraction) {
      $('.zc-bar').style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
      return frame();
    },

    /** Lift it, once it has been up long enough to read. */
    async hide() {
      const held = performance.now() - shownAt;
      if (held < FADE_IN_MS + HOLD_MS) await wait(FADE_IN_MS + HOLD_MS - held);
      el.classList.remove('open');
      await wait(FADE_OUT_MS);
    },

    /** A crossing that failed says so on the card, and stays up: there is no zone behind it. */
    fail(message) {
      el.classList.add('failed', 'open');
      $('.zc-way').textContent = 'the way is lost';
      $('.zc-room').textContent = '';
      $('.zc-prose').textContent = message;
    },
  };
}
