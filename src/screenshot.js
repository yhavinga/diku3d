/**
 * The screenshot key. F2 saves the frame as a PNG; Shift+F2 saves it with the
 * HUD on. `shot` or `screenshot` in the command line does the same
 * (`shot hud` for the HUD variant), and `diku.screenshot({ hud })` from code.
 *
 * Why F2: every letter the game uses is taken, F1 is help, F12 is devtools,
 * PrintScreen never reaches a page on macOS, and F2 is bound by no browser.
 * It works with the pointer held because it needs no click, and the key
 * handler is a capture-phase listener so it also works from the console input.
 *
 * The picture is the real composited frame: the composer renders once more and
 * the canvas is copied to a 2D canvas in the same task, before the browser
 * composites -- that is what makes a read of the drawing buffer valid without
 * `preserveDrawingBuffer` (CLAUDE.md). The copy is the canvas's own size,
 * device pixels and all, never the CSS size.
 *
 * The HUD is DOM, so with `hud` it is serialised into an SVG foreignObject with
 * every computed style inlined and the two canvases (minimap, compass) swapped
 * for images, and drawn over the frame. Limits: ::before/::after content and
 * the panels' backdrop blur are not reproduced, and a browser that taints
 * canvases on foreignObject images (Safari) fails loudly rather than saving a
 * frame without its HUD.
 */

const pad = (n) => String(n).padStart(2, '0');

function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function shotName(vnum, roomName, date) {
  const slug = String(roomName).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `diku3d-${vnum}-${slug || 'room'}-${stamp(date)}.png`;
}

/** Copy `source`'s computed style onto `clone`, element for element. */
function inlineStyles(source, clone) {
  const computed = getComputedStyle(source);
  let css = '';
  for (let i = 0; i < computed.length; i++) css += `${computed[i]}:${computed.getPropertyValue(computed[i])};`;
  clone.setAttribute('style', css);
  for (let i = 0; i < source.children.length; i++) inlineStyles(source.children[i], clone.children[i]);
}

/** The HUD proper, and the game's panels (vitals, log, sheets), which live in a root of their own. */
const HUD_ROOTS = ['hud', 'game-ui'];

async function drawHud(ctx, width, height) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const layers = HUD_ROOTS.map((id) => {
    const source = document.getElementById(id);
    if (!source) throw new Error(`screenshot: no #${id} element`);
    const clone = source.cloneNode(true);
    inlineStyles(source, clone);
    // A canvas clones blank; its pixels go in as an image of the same box.
    const live = source.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((canvas, i) => {
      const img = document.createElement('img');
      img.src = live[i].toDataURL('image/png');
      img.setAttribute('style', canvas.getAttribute('style'));
      canvas.replaceWith(img);
    });
    // The panels' own backdrop blur cannot be drawn into an SVG image.
    clone.querySelectorAll('*').forEach((el) => { el.style.backdropFilter = 'none'; el.style.webkitBackdropFilter = 'none'; });
    // The "saved ..." toast is this very action, not part of the view.
    clone.querySelector('#toast')?.remove();
    return new XMLSerializer().serializeToString(clone);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
    + `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${w}px;height:${h}px">${layers.join('')}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try { await img.decode(); } catch (error) {
    throw new Error(`screenshot: the HUD would not rasterise (${error.message || error})`);
  }
  ctx.drawImage(img, 0, 0, width, height);
}

export function installScreenshot(d) {
  const { renderer, composer, hud, state } = d;

  async function screenshot({ hud: withHud = false } = {}) {
    const vnum = state.roomVnum;
    const room = d.built.rooms.get(vnum)?.room;
    if (vnum == null || !room) throw new Error(`screenshot: no current room (state.roomVnum = ${vnum})`);

    // Render and copy in this task: after it, the drawing buffer is not ours.
    composer.render();
    const gl = renderer.domElement;
    const out = document.createElement('canvas');
    out.width = gl.width;
    out.height = gl.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(gl, 0, 0);

    if (withHud) await drawHud(ctx, out.width, out.height);
    const blob = await new Promise((resolve, reject) => {
      try {
        out.toBlob((b) => (b ? resolve(b) : reject(new Error('screenshot: PNG encoding failed'))), 'image/png');
      } catch (error) { reject(error); }
    });
    const name = shotName(vnum, room.name);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    hud.toast(`saved ${name}`);
    return { name, width: out.width, height: out.height, hud: withHud };
  }

  const fail = (error) => { console.error(error); hud.toast(error.message || String(error)); };
  d.screenshot = (options) => screenshot(options);

  document.addEventListener('keydown', (event) => {
    if (event.code !== 'F2' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    const loading = document.getElementById('loading');
    const title = document.getElementById('title');
    if ((loading && !loading.classList.contains('hidden')) || (title && !title.classList.contains('hidden'))) return;
    screenshot({ hud: event.shiftKey }).catch(fail);
  }, true);

  return screenshot;
}
