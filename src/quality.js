/**
 * Frame budget. The scene is small (about 300 draws), so the cost is not draw
 * calls -- it is pixels: render resolution, multisampling and the bloom chain,
 * multiplied by however many frames a second the display will take. This keeps
 * all four under control and measures the result on the GPU rather than
 * guessing from wall time.
 */

import * as THREE from 'three';

/**
 * `shadow` is the map size and `span` the half-width of the sun's frustum in
 * metres -- together they set how many centimetres a shadow texel covers. The
 * map is only redrawn when you cross a six-metre line (see main.js), so a
 * bigger map costs memory and almost no time; the span is the dial that
 * actually buys contact detail, at the price of shadows fading out sooner.
 *
 * Softness is not on this list. `PCFSoftShadowMap` is deprecated in r185 and
 * silently falls back to PCF, and VSM -- the only soft filter left -- decides
 * that a square lit by a sun ten degrees above the horizon is entirely in
 * shadow, because variance badly underestimates visibility on a receiver that
 * near parallel to the light. So this stays on PCF and buys its contact detail
 * with texels instead: 2048 over a 44 m span is 4 cm a texel, against the 11 cm
 * it used to be.
 *
 * `ao` and `shafts` are `{ scale, samples }`, where scale is the fraction of
 * the render resolution the effect runs at. Remeasured at 1600x900 with the
 * frame cap at 30: light shafts are the expensive item, about 4.3 ms of
 * `high`'s ten, against ambient occlusion's 3.4. They are also a *variable*
 * 4.3 ms that arrives whenever you turn towards a low sun, and a cost that
 * appears when you turn your head is exactly the kind that spins a fan up.
 *
 * So `high` -- the default, and the preset that has to stay cold -- pays for
 * ambient occlusion and the detail normal instead, which is where the money
 * shows: they are what puts a figure on the ground and keeps a wall from
 * going smooth as you walk up to it. Shafts are `max` only.
 *
 * Antialiasing is SMAA rather than 4x MSAA because on this half-float target
 * MSAA measured 7.4 ms against SMAA's 1.6.
 */
export const PRESETS = {
  low: {
    dpr: 1.0, bloom: false, aa: 'none', shadow: 0, span: 55,
    ao: false, shafts: false, detail: false, lights: 6, fps: 60,
  },
  medium: {
    dpr: 1.25, bloom: 'half', aa: 'none', shadow: 2048, span: 44,
    ao: false, shafts: false, detail: false, lights: 10, fps: 60,
  },
  high: {
    dpr: 1.75, bloom: 'half', aa: 'smaa', shadow: 3072, span: 38,
    ao: { scale: 0.4, samples: 9, denoise: 4 },
    shafts: false, detail: true, lights: 14, fps: 60,
  },
  max: {
    dpr: 2.0, bloom: 'full', aa: 'smaa', shadow: 4096, span: 34,
    ao: { scale: 0.5, samples: 12, denoise: 8 },
    shafts: { scale: 0.4, samples: 24 }, detail: true, lights: 16, fps: 0,
  },
};

export const SCALES = [0.55, 0.7, 0.85, 1.0];
const IDLE_FPS = 10;

export class Quality {
  constructor({ renderer, pipeline, sun, lightPool, materials, name = 'high' }) {
    this.renderer = renderer;
    this.pipeline = pipeline;
    this.composer = pipeline.composer;
    this.bloom = pipeline.bloom;
    this.sun = sun;
    this.lightPool = lightPool;
    this.materials = materials;
    this.scaleIndex = SCALES.length - 1;
    // Per-setting overrides from the options screen, merged over the preset.
    this.overrides = {};
    this.autoScale = true;
    this.lastRender = 0;
    this.lastProbe = 0;
    this.gpuMs = null;
    this.frames = 0;

    const gl = renderer.getContext();
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.query = null;
    this.pending = null;

    this.apply(name);
  }

  apply(name) {
    const base = PRESETS[name] || PRESETS.high;
    this.name = PRESETS[name] ? name : 'high';
    const preset = { ...base, ...this.overrides };
    this.preset = preset;
    if (this.autoScale) this.scaleIndex = SCALES.length - 1;

    this.bloom.enabled = preset.bloom !== false;
    this.pipeline.gtao.enabled = preset.ao !== false;
    if (preset.ao) {
      this.pipeline.gtao.scale = preset.ao.scale;
      this.pipeline.gtao.updateGtaoMaterial({ samples: preset.ao.samples });
      this.pipeline.gtao.updatePdMaterial({ samples: preset.ao.denoise });
    }
    this.pipeline.shafts.allowed = preset.shafts !== false;
    if (preset.shafts) {
      this.pipeline.shafts.scale = preset.shafts.scale;
      this.pipeline.shafts.setSamples(preset.shafts.samples);
    }
    this.pipeline.shafts.enabled = false; // main.js re-aims it next frame
    this.pipeline.smaa.enabled = preset.aa === 'smaa';

    this.renderer.shadowMap.enabled = preset.shadow > 0;
    if (preset.shadow > 0) this.sun.shadow.mapSize.set(preset.shadow, preset.shadow);
    this.sun.castShadow = preset.shadow > 0;
    const camera = this.sun.shadow.camera;
    camera.left = -preset.span; camera.right = preset.span;
    camera.top = preset.span; camera.bottom = -preset.span;
    camera.updateProjectionMatrix();
    // A shadow map already allocated at another size has to be thrown away.
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.setDetail(preset.detail);
    this.renderer.shadowMap.needsUpdate = true;
    this.lightPool.resize(preset.lights);
    this.resize();
    return this.name;
  }

  /** Close-range detail normals: an extra texture read per lit pixel. */
  setDetail(on) {
    if (!this.materials || !this.materials.setDetail) return;
    this.materials.setDetail(on);
  }

  /** Effective device pixel ratio: the preset, scaled down if we're struggling. */
  pixelRatio() {
    return Math.min(window.devicePixelRatio, this.preset.dpr) * SCALES[this.scaleIndex];
  }

  resize() {
    const ratio = this.pixelRatio();
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // The composer has its own pixel ratio and applies it to every pass. Leave
    // it at the default of 1 and the whole scene renders at CSS resolution and
    // is upscaled to the canvas on the way out -- cheap, but soft.
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(window.innerWidth, window.innerHeight);

    const width = Math.round(window.innerWidth * ratio);
    const height = Math.round(window.innerHeight * ratio);
    if (this.preset.bloom === 'half') {
      this.bloom.setSize(Math.max(2, width / 2), Math.max(2, height / 2));
    }
    // `setSize` above went through each pass's own scale; a preset change can
    // have moved that scale without changing the size, so redo it here.
    if (this.preset.ao) this.pipeline.gtao.setSize(width, height);
    if (this.preset.shafts) this.pipeline.shafts.setSize(width, height);
    const samples = this.preset.aa === 'msaa' ? 4 : 0;
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (!target || target.samples === samples) continue;
      target.samples = samples;
      target.dispose(); // the multisampled framebuffer has to be rebuilt
    }
  }

  /**
   * Should this frame be drawn at all? Caps the rate, and drops to a crawl when
   * the window is hidden or the mouse has been released.
   */
  shouldRender(now, idle) {
    if (document.hidden) return false;
    const fps = idle ? IDLE_FPS : this.preset.fps;
    if (!fps) return true;
    if (now - this.lastRender < (1000 / fps) - 1) return false;
    this.lastRender = now;
    return true;
  }

  /** Wrap the frame in a GPU timer query, a few times a second. */
  begin(now) {
    if (!this.timer) return;
    this.collect();
    if (this.query || now - this.lastProbe < 250) return;
    this.lastProbe = now;
    const gl = this.renderer.getContext();
    this.query = gl.createQuery();
    gl.beginQuery(this.timer.TIME_ELAPSED_EXT, this.query);
    this.probing = true;
  }

  end() {
    if (!this.probing) return;
    this.probing = false;
    const gl = this.renderer.getContext();
    gl.endQuery(this.timer.TIME_ELAPSED_EXT);
    this.pending = this.query;
    this.query = null;
  }

  collect() {
    if (!this.pending) return;
    const gl = this.renderer.getContext();
    if (!gl.getQueryParameter(this.pending, gl.QUERY_RESULT_AVAILABLE)) return;
    if (!gl.getParameter(this.timer.GPU_DISJOINT_EXT)) {
      const ms = gl.getQueryParameter(this.pending, gl.QUERY_RESULT) / 1e6;
      this.gpuMs = this.gpuMs === null ? ms : this.gpuMs * 0.7 + ms * 0.3;
      this.adapt();
    }
    gl.deleteQuery(this.pending);
    this.pending = null;
  }

  /** Fix the render scale, or hand it back to the adaptive scaler. */
  setScale(index) {
    this.autoScale = index === null;
    if (index !== null) this.scaleIndex = Math.max(0, Math.min(SCALES.length - 1, index));
    this.resize();
  }

  /** Replace the per-setting overrides and re-apply the current preset. */
  setOverrides(overrides) {
    this.overrides = { ...overrides };
    this.apply(this.name);
  }

  /**
   * Keep the GPU comfortably inside the frame it has. Resolution is the only
   * dial turned here: it is the one that scales smoothly and shows least.
   */
  adapt() {
    if (!this.autoScale || this.gpuMs === null) return;
    const budget = 1000 / (this.preset.fps || 120);
    let index = this.scaleIndex;
    if (this.gpuMs > budget * 0.75 && index > 0) index--;
    else if (this.gpuMs < budget * 0.35 && index < SCALES.length - 1) index++;
    if (index === this.scaleIndex) return;
    this.scaleIndex = index;
    this.gpuMs = null; // the old reading describes a resolution we no longer use
    this.resize();
  }

  describe() {
    const scale = SCALES[this.scaleIndex];
    return `${this.name}${scale < 1 ? ` ${Math.round(scale * 100)}%` : ''}`
      + `${this.gpuMs !== null ? ` · ${this.gpuMs.toFixed(1)} ms gpu` : ''}`;
  }
}

/**
 * There are hundreds of torches and only a handful of lights worth paying for.
 * Each frame the nearest candidates are bound to a small pool of point lights.
 */
export class LightPool {
  constructor(scene, count, candidates) {
    this.scene = scene;
    this.lights = [];
    // 0 in the dark, 1 at midday. Street lamps go out as it rises -- one
    // burning at noon was reported -- and everything gets a lift after dark,
    // because the practicals are the only light there is then and a lamp
    // calibrated to read against a sunlit street disappears against a black one.
    this.daylight = 1;
    this.grid = new Map();
    for (const candidate of candidates) {
      const key = `${Math.floor(candidate.x / 16)},${Math.floor(candidate.z / 16)}`;
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(candidate);
    }
    this.near = [];
    this.resize(count);
  }

  resize(count) {
    while (this.lights.length > count) {
      const light = this.lights.pop();
      this.scene.remove(light);
      light.dispose();
    }
    while (this.lights.length < count) {
      const light = new THREE.PointLight(0xffffff, 0, 20, 2);
      light.visible = false;
      this.scene.add(light);
      this.lights.push(light);
    }
  }

  update(position, time) {
    const cx = Math.floor(position.x / 16);
    const cz = Math.floor(position.z / 16);
    this.near.length = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const bucket = this.grid.get(`${cx + dx},${cz + dz}`);
        if (!bucket) continue;
        for (const candidate of bucket) {
          // A lamp that is out should not hold a slot the hall torch behind it
          // could have used.
          if (candidate.outdoor && this.daylight >= 0.99) continue;
          const ddx = candidate.x - position.x;
          const ddy = candidate.y - position.y;
          const ddz = candidate.z - position.z;
          candidate._d = ddx * ddx + ddy * ddy + ddz * ddz;
          if (candidate._d < 2500) this.near.push(candidate);
        }
      }
    }
    // Rank by what a light would actually deliver, not by how close it is: a
    // street frontage emits a dozen dim window candidates within a few metres,
    // and sorted on bare distance they filled every slot and starved the one
    // lamp on the kerb that was carrying the street. Distance over intensity
    // is a crude irradiance, and crude is enough to keep the lamp lit.
    this.near.sort((a, b) => a._d / (a.intensity || 1) - b._d / (b.intensity || 1));
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const candidate = this.near[i];
      if (!candidate) { light.visible = false; continue; }
      const lit = candidate.outdoor ? 1 - this.daylight : 1;
      if (lit <= 0.01) { light.visible = false; continue; }
      light.visible = true;
      light.position.set(candidate.x, candidate.y, candidate.z);
      light.color.setHex(candidate.color);
      light.distance = candidate.radius || 16;
      const flicker = candidate.flicker
        ? 0.82 + Math.sin(time * 9.3 + candidate.x) * 0.09 + Math.sin(time * 17.7 + candidate.z) * 0.09
        : 1;
      // Only the street lamps. A torch in a hall is the same torch at noon as
      // at midnight -- the room it lights never had any sun in it -- and giving
      // it the night boost blew the temple out at 2.7% of the frame clipped.
      const afterDark = candidate.outdoor ? 1 + (1 - this.daylight) * 1.6 : 1;
      light.intensity = (candidate.intensity || 10) * flicker * lit * afterDark;
    }
  }

  /** How much daylight there is, 0 to 1. Call it whenever the hour changes. */
  setDaylight(level) {
    this.daylight = Math.max(0, Math.min(1, level));
  }
}
