/**
 * Measurement harness for the round-3 fix pass. Loaded from the console:
 *
 *   const H = (await import('/tools/judge/probe.js')).install();
 *
 * Everything reads the *composited* back buffer -- `composer.render()` then
 * `gl.readPixels` in the same task -- because a probe that renders the scene
 * itself bypasses the post chain and measures a different picture.
 */
import * as THREE from 'three';

export function install() {
  const d = window.diku;
  const H = { THREE };

  H.settle = (n = 4) => new Promise((res) => {
    let i = 0;
    const step = () => { if (++i >= n) return res(); requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });

  H.px = () => {
    const gl = d.renderer.getContext();
    d.composer.render();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const b = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
    return { w, h, b };
  };

  // readPixels hands back bottom-up rows; ny runs 0 at the top of the picture.
  H.at = (f, nx, ny) => {
    const x = Math.min(f.w - 1, Math.max(0, Math.round(nx * f.w)));
    const y = Math.min(f.h - 1, Math.max(0, Math.round((1 - ny) * f.h)));
    const i = (y * f.w + x) * 4;
    return [f.b[i], f.b[i + 1], f.b[i + 2]];
  };
  H.lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  H.dec = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

  H.frameStats = (f) => {
    let s = 0, n = 0, dark = 0, blown = 0;
    for (let i = 0; i < f.b.length; i += 4) {
      const l = 0.2126 * f.b[i] + 0.7152 * f.b[i + 1] + 0.0722 * f.b[i + 2];
      s += l; n++; if (l < 8) dark++; if (l > 250) blown++;
    }
    return { mean: +(s / n).toFixed(2), pctUnder8: +(100 * dark / n).toFixed(2), pctOver250: +(100 * blown / n).toFixed(2) };
  };

  /**
   * Classify a grid of screen samples by what the ray hits, so "sunlit cobble"
   * and "shaded panel" are geometry, not an eyeballed rectangle. Means are in
   * linear light, which is the space a contrast ratio is quoted in.
   */
  H.classify = (cols = 30, rows = 17) => {
    const f = H.px();
    const rc = new THREE.Raycaster(); rc.far = 140;
    const shadow = new THREE.Raycaster(); shadow.far = 90;
    const sunDir = d.sun.position.clone().normalize();
    const out = { sunGround: [], shadeGround: [], sunWall: [], shadeWall: [] };
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const nx = (i + 0.5) / cols, ny = (j + 0.5) / rows;
        rc.setFromCamera(new THREE.Vector2(nx * 2 - 1, 1 - ny * 2), d.camera);
        const hits = rc.intersectObjects(d.scene.children, true).filter((h) => h.object.visible && h.face);
        if (!hits.length) continue;
        const hit = hits[0];
        const nrm = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        const kind = nrm.y > 0.8 ? 'Ground' : (Math.abs(nrm.y) < 0.35 ? 'Wall' : null);
        if (!kind) continue;
        let lit = nrm.dot(sunDir) > 0.05;
        if (lit) {
          shadow.set(hit.point.clone().addScaledVector(nrm, 0.05), sunDir);
          if (shadow.intersectObjects(d.scene.children, true)
            .filter((h) => h.object.visible && h.face && h.distance > 0.06).length) lit = false;
        }
        out[(lit ? 'sun' : 'shade') + kind].push(H.dec(H.lum(H.at(f, nx, ny))));
      }
    }
    const agg = {};
    for (const k of Object.keys(out)) {
      const a = out[k];
      agg[k] = a.length
        ? { n: a.length, lin: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(4) }
        : { n: 0, lin: null };
    }
    agg.ratio = agg.sunGround.lin && agg.shadeWall.lin
      ? +(agg.sunGround.lin / agg.shadeWall.lin).toFixed(2) : null;
    agg.frame = H.frameStats(f);
    return agg;
  };

  /**
   * The sun's shadow map redraws around the camera's *last rendered* position,
   * so the order is: stand, set the hour, let the loop run, then measure.
   */
  H.stand = async (fn, time, frames = 8) => {
    d.state.benchmark = false;
    fn();
    if (time) d.applyTime(time);
    await H.settle(frames);
  };

  H.hide = () => {
    document.getElementById('title')?.classList.add('hidden');
    document.getElementById('loading')?.classList.add('hidden');
    d.state.paused = false;
  };

  H.hide();
  window.__H = H;
  return H;
}
