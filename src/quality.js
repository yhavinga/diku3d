/**
 * Frame budget. The scene is small (about 300 draws), so the cost is not draw
 * calls -- it is pixels: render resolution, multisampling and the bloom chain,
 * multiplied by however many frames a second the display will take. This keeps
 * all four under control and measures the result on the GPU rather than
 * guessing from wall time.
 */

import * as THREE from 'three';

export const PRESETS = {
  low: { dpr: 1.0, bloom: false, msaa: 0, shadow: 0, lights: 6, fps: 60 },
  medium: { dpr: 1.25, bloom: 'half', msaa: 0, shadow: 1024, lights: 10, fps: 60 },
  high: { dpr: 1.75, bloom: 'half', msaa: 4, shadow: 2048, lights: 14, fps: 60 },
  max: { dpr: 2.0, bloom: 'full', msaa: 4, shadow: 3072, lights: 16, fps: 0 },
};

const SCALES = [0.55, 0.7, 0.85, 1.0];
const IDLE_FPS = 10;

export class Quality {
  constructor({ renderer, composer, bloom, sun, lightPool, name = 'high' }) {
    this.renderer = renderer;
    this.composer = composer;
    this.bloom = bloom;
    this.sun = sun;
    this.lightPool = lightPool;
    this.scaleIndex = SCALES.length - 1;
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
    const preset = PRESETS[name] || PRESETS.high;
    this.name = PRESETS[name] ? name : 'high';
    this.preset = preset;
    this.scaleIndex = SCALES.length - 1;

    this.bloom.enabled = preset.bloom !== false;
    this.renderer.shadowMap.enabled = preset.shadow > 0;
    if (preset.shadow > 0) this.sun.shadow.mapSize.set(preset.shadow, preset.shadow);
    this.sun.castShadow = preset.shadow > 0;
    // A shadow map already allocated at another size has to be thrown away.
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.renderer.shadowMap.needsUpdate = true;
    this.lightPool.resize(preset.lights);
    this.resize();
    return this.name;
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
    for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (!target || target.samples === this.preset.msaa) continue;
      target.samples = this.preset.msaa;
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

  /**
   * Keep the GPU comfortably inside the frame it has. Resolution is the only
   * dial turned here: it is the one that scales smoothly and shows least.
   */
  adapt() {
    if (this.gpuMs === null) return;
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
          const ddx = candidate.x - position.x;
          const ddy = candidate.y - position.y;
          const ddz = candidate.z - position.z;
          candidate._d = ddx * ddx + ddy * ddy + ddz * ddz;
          if (candidate._d < 2500) this.near.push(candidate);
        }
      }
    }
    this.near.sort((a, b) => a._d - b._d);
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      const candidate = this.near[i];
      if (!candidate) { light.visible = false; continue; }
      light.visible = true;
      light.position.set(candidate.x, candidate.y, candidate.z);
      light.color.setHex(candidate.color);
      light.distance = candidate.radius || 16;
      const flicker = candidate.flicker
        ? 0.82 + Math.sin(time * 9.3 + candidate.x) * 0.09 + Math.sin(time * 17.7 + candidate.z) * 0.09
        : 1;
      light.intensity = (candidate.intensity || 10) * flicker;
    }
  }
}
