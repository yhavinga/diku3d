/**
 * Z-fighting detector. Loaded from the console (or tools/judge/headless/zsweep.mjs):
 *
 *   const Z = (await import('/tools/judge/zfight.js')).install();
 *   Z.measure({ detail: true })  // this view: flicker pixels, who fights, a mask
 *   await Z.sweep()              // every built room, four headings, level and up
 *   Z.measure({ all: true })     // alpha-cut, impostors, the horizon too; ties by distance
 *   Z.swim()                     // shimmer on far things while turning (composited frame)
 *
 * Two surfaces that coincide draw in an order decided by depth rounding, so
 * which one wins a pixel changes from frame to frame as the camera moves --
 * the flicker. A still cannot show it, and two composited frames differ for a
 * dozen other reasons (shadow crawl, GTAO noise, sub-pixel edges), so this
 * does not diff pictures. It renders an id for every surface instead (object,
 * instance, material group, facing, and the provoking vertex, so two faces of
 * one merged batch are told apart) into a float target, then renders the same
 * view again with the near plane nudged a few parts in ten thousand. That
 * changes every depth value and nothing else: no pixel's coverage moves, so a
 * pixel whose id changes between the renders is a pixel where two surfaces are
 * tied in depth. Nothing else can make it change.
 *
 * A tie between two surfaces that shade alike (one batch's floor laid twice)
 * flickers invisibly, so `visible` counts only the tied pixels whose colour
 * also changes when the same nudged views are rendered in their real
 * materials; `flicker` is every tie. The depth target is the 24-bit one the
 * composer renders into, so what ties here ties in the game.
 *
 * What is drawn is what the frame draws: visibility, culling and instance
 * compaction are left exactly as the last frame set them. Transparent,
 * alpha-tested and non-depth-writing materials are skipped -- they do not
 * fight in the depth buffer the way opaque coplanar surfaces do.
 *
 * `Z.measure({ all: true })` is the opt-in that does not skip them. Alpha-cut
 * foliage and impostor cards, the horizon's hazed strips (transparent, but
 * depth-writing) and anything whose vertex shader is its own (impostors
 * billboard, the horizon rises) cannot be drawn by the id material, so in
 * this mode a tie is any pixel whose *real-material* colour changes when only
 * the near plane is nudged -- with the alpha-cut ids discarding by their map
 * where the id pass can still name a pair. Each tied pixel is also binned by
 * its eye distance, read from the same 24-bit depth the tie happened in, so
 * a tie at 600 m is told from one at 6 m. `depthType` sets that buffer's
 * format (default: whatever the composer renders into).
 */
import * as THREE from 'three';

const VERT = /* glsl */`
#include <common>
#include <batching_pars_vertex>
#include <skinning_pars_vertex>
flat varying float vInst;
flat varying float vVert;
varying vec3 vNormalW;
varying vec2 vIdUv;
void main() {
  vVert = float(gl_VertexID);
  #ifdef ID_CUT
    vIdUv = uv;
  #endif
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vec3 n = objectNormal;
  #ifdef USE_INSTANCING
    n = mat3(instanceMatrix) * n;
  #endif
  #ifdef USE_BATCHING
    n = mat3(batchingMatrix) * n;
  #endif
  vNormalW = normalize(mat3(modelMatrix) * n);
  float inst = 0.0;
  #ifdef USE_INSTANCING
    inst = float(gl_InstanceID);
  #endif
  #ifdef USE_BATCHING
    inst = float(getIndirectIndex(gl_DrawID));
  #endif
  vInst = inst;
}`;

const FRAG = /* glsl */`
uniform float objId;
uniform float group;
uniform sampler2D idMap;
uniform float idCut;
flat varying float vInst;
flat varying float vVert;
varying vec3 vNormalW;
varying vec2 vIdUv;
void main() {
  #ifdef ID_CUT
    if (texture2D(idMap, vIdUv).a < idCut) discard;
  #endif
  vec3 a = abs(vNormalW);
  float axis = a.x > a.y && a.x > a.z ? 0.0 : (a.y > a.z ? 1.0 : 2.0);
  float s = (axis == 0.0 ? vNormalW.x : axis == 1.0 ? vNormalW.y : vNormalW.z) < 0.0 ? 1.0 : 0.0;
  float face = axis * 2.0 + s + (gl_FrontFacing ? 0.0 : 8.0);
  gl_FragColor = vec4(objId, vInst, group * 16.0 + face, vVert + 1.0);
}`;

export function install() {
  const d = window.diku;
  const Z = {};
  let target = null;
  const cache = new Map(); // `${obj.id}/${group}/${side}` -> material

  const idMaterial = (objIndex, group, side, cut = null) => {
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, side,
      defines: cut ? { ID_CUT: 1 } : {},
      uniforms: { objId: { value: objIndex }, group: { value: group },
        idMap: { value: cut?.map || null }, idCut: { value: cut?.alphaTest || 0 } },
    });
    return m;
  };

  // `all`: alpha-cut and transparent-but-depth-writing surfaces are kept.
  let all = false;
  const skip = (m) => !m || (!all && (m.transparent || m.alphaTest > 0)) || m.depthWrite === false
    || m.depthTest === false || m.colorWrite === false || m.visible === false;

  /** Swap every opaque mesh's material for an id material; returns the undo. */
  const swap = (objects) => {
    const undo = [];
    d.scene.traverseVisible((o) => {
      if (!o.isMesh || o.isSprite) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      let index = objects.indexOf(o);
      if (index < 0) { index = objects.length; objects.push(o); }
      const next = mats.map((m, g) => {
        if (skip(m)) return null;
        const cut = all && m.alphaTest > 0 && m.map ? m : null;
        const key = `${o.id}/${g}/${m.side}/${cut ? 'cut' : ''}`;
        let id = cache.get(key);
        if (!id) { id = idMaterial(0, g, m.side, cut); cache.set(key, id); }
        id.uniforms.objId.value = index + 1;
        return id;
      });
      if (next.every((m) => m === null)) {
        undo.push([o, o.material, o.visible]);
        o.visible = false;
        return;
      }
      // A skipped group still has to draw nothing: an invisible stand-in.
      const hide = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      undo.push([o, o.material, o.visible]);
      o.material = Array.isArray(o.material) ? next.map((m) => m || hide) : next[0] || hide;
    });
    return () => { for (const [o, m, v] of undo) { o.material = m; o.visible = v; } };
  };

  /** The id/colour target, with the depth format the game itself renders into unless told otherwise. */
  const ensure = (w, h, depthType = null) => {
    const type = depthType ?? d.composer?.renderTarget1?.depthTexture?.type ?? THREE.UnsignedIntType;
    if (target && target.width === w && target.height === h && target.depthTexture.type === type) return;
    target?.dispose();
    target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthTexture: new THREE.DepthTexture(w, h, type),
    });
    target.depthTexture.minFilter = THREE.NearestFilter;
    target.depthTexture.magFilter = THREE.NearestFilter;
  };

  // Eye distance per pixel, out of the depth buffer the tie was measured in.
  let eyeTarget = null;
  const eyeMaterial = new THREE.ShaderMaterial({
    uniforms: { tDepth: { value: null }, cameraNear: { value: 0.1 }, cameraFar: { value: 900 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `#include <packing>
      uniform sampler2D tDepth; uniform float cameraNear; uniform float cameraFar; varying vec2 vUv;
      void main() {
        float z = texture2D(tDepth, vUv).x;
        #ifdef USE_REVERSED_DEPTH_BUFFER
          bool empty = z <= 0.0;
        #else
          bool empty = z >= 1.0;
        #endif
        gl_FragColor = vec4(empty ? -1.0 : -perspectiveDepthToViewZ(z, cameraNear, cameraFar), 0.0, 0.0, 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
  const eyeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), eyeMaterial);
  eyeQuad.frustumCulled = false;
  const eyeScene = new THREE.Scene(); eyeScene.add(eyeQuad);
  const eyeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const readEye = (w, h) => {
    const r = d.renderer, cam = d.camera;
    const prev = { target: r.getRenderTarget(), sm: r.shadowMap.autoUpdate, smn: r.shadowMap.needsUpdate };
    r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false;
    if (!eyeTarget || eyeTarget.width !== w || eyeTarget.height !== h) {
      eyeTarget?.dispose();
      eyeTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    }
    if (!target || target.width !== w || target.height !== h) ensure(w, h);
    const buf = new Float32Array(w * h * 4);
    try {
      r.setRenderTarget(target); r.clear(); r.render(d.scene, cam);
      eyeMaterial.uniforms.tDepth.value = target.depthTexture;
      eyeMaterial.uniforms.cameraNear.value = cam.near; eyeMaterial.uniforms.cameraFar.value = cam.far;
      r.setRenderTarget(eyeTarget); r.render(eyeScene, eyeCamera);
      r.readRenderTargetPixels(eyeTarget, 0, 0, w, h, buf);
    } finally {
      r.setRenderTarget(prev.target);
      r.shadowMap.autoUpdate = prev.sm; r.shadowMap.needsUpdate = prev.smn;
    }
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = buf[i * 4];
    return out;
  };
  Z.eye = readEye;

  const read = (w, h) => {
    const buf = new Float32Array(w * h * 4);
    d.renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
    return buf;
  };

  /**
   * The current view. `scale` renders at a fraction of the canvas to keep a
   * sweep quick; flicker is counted in pixels of that render.
   */
  Z.measure = ({ scale = 0.5, variants = [1.0007, 0.9993, 1.0021, 0.998, 1.0049], detail = false,
    all: everything = false, depthType = null, bins = [25, 75, 150, 300, 500] } = {}) => {
    all = everything;
    const r = d.renderer, cam = d.camera;
    const canvas = r.domElement;
    const w = Math.max(64, Math.round(canvas.width * scale));
    const h = Math.max(36, Math.round(canvas.height * scale));
    ensure(w, h, depthType);
    const objects = [];
    const restore = swap(objects);
    const prev = { target: r.getRenderTarget(), near: cam.near, far: cam.far, bg: d.scene.background,
      fog: d.scene.fog, tone: r.toneMapping, auto: r.autoClear, sm: r.shadowMap.autoUpdate, smn: r.shadowMap.needsUpdate,
      clear: r.getClearColor(new THREE.Color()), alpha: r.getClearAlpha() };
    d.scene.background = null; d.scene.fog = null;
    r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(target);
    const frames = [];
    try {
      for (const n of [1, 1, ...variants]) {
        cam.near = prev.near * n; cam.updateProjectionMatrix();
        r.clear();
        r.render(d.scene, cam);
        frames.push(read(w, h));
      }
    } finally {
      cam.near = prev.near; cam.far = prev.far; cam.updateProjectionMatrix();
      r.setRenderTarget(prev.target);
      r.setClearColor(prev.clear, prev.alpha);
      d.scene.background = prev.bg; d.scene.fog = prev.fog;
      r.shadowMap.autoUpdate = prev.sm; r.shadowMap.needsUpdate = prev.smn;
      restore();
    }
    // The same views in their real materials: a tie between two surfaces that
    // shade alike (one batch's grass laid twice) flips the id and not the
    // colour, and is no flicker anyone sees. Lighting is fixed between these
    // renders -- same task, shadow map not redrawn -- so a colour can only
    // change because a different surface won the depth test.
    const shades = [];
    r.shadowMap.autoUpdate = false; r.shadowMap.needsUpdate = false;
    r.setRenderTarget(target);
    try {
      for (const n of [1, 1, ...variants]) {
        cam.near = prev.near * n; cam.updateProjectionMatrix();
        r.clear();
        r.render(d.scene, cam);
        shades.push(read(w, h));
      }
    } finally {
      cam.near = prev.near; cam.updateProjectionMatrix();
      r.setRenderTarget(prev.target);
      r.shadowMap.autoUpdate = prev.sm; r.shadowMap.needsUpdate = prev.smn;
    }
    const eye = all ? readEye(w, h) : null;
    // Render 1 repeats render 0 exactly. Anything that changes between those
    // two -- a mesh whose onBeforeRender animates, an effect timed off the
    // clock -- is not a depth tie, and is left out rather than counted.
    const same = (a, b, i) => a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3];
    const differs = (i, from = 2, to = shades.length) => {
      const a = shades[0];
      for (let k = from; k < to; k++) {
        const b = shades[k];
        for (let c = 0; c < 3; c++) {
          const x = a[i + c], y = b[i + c];
          if (Math.abs(x - y) > 0.004 + 0.03 * Math.max(Math.abs(x), Math.abs(y))) return true;
        }
      }
      return false;
    };
    const base = frames[0];
    let flicker = 0, visible = 0, unstable = 0;
    const pairs = new Map();
    const key = (b, i) => `${b[i]}|${b[i + 1]}|${b[i + 2]}`;
    const where = new Float32Array(w * h);
    const binned = new Array(bins.length + 1).fill(0);
    // Every id that moves with the near plane, seen in colour or not: dark
    // surfaces tie with a colour change under the visible threshold.
    const tiedBins = new Array(bins.length + 1).fill(0);
    let far = 0;
    if (all) {
      // Any surface at all, in its own material: a colour that moves with the
      // near plane and nothing else is two surfaces tied in depth.
      for (let i = 0; i < base.length; i += 4) {
        if (eye[i / 4] <= 0) continue;
        if (differs(i, 1, 2)) { unstable++; continue; }
        if (base[i + 3] !== 0 && same(base, frames[1], i)) {
          for (let k = 2; k < frames.length; k++) {
            if (!same(base, frames[k], i)) {
              let b = 0; while (b < bins.length && eye[i / 4] >= bins[b]) b++;
              tiedBins[b]++; break;
            }
          }
        }
        if (!differs(i)) continue;
        visible++;
        where[i / 4] = 1;
        const z = eye[i / 4];
        let b = 0; while (b < bins.length && z >= bins[b]) b++;
        binned[b]++;
        if (z > far) far = z;
        let other = null;
        for (let k = 2; k < frames.length; k++) {
          const f = frames[k];
          if (f[i] !== base[i] || f[i + 1] !== base[i + 1] || f[i + 2] !== base[i + 2] || f[i + 3] !== base[i + 3]) { other = [f, i]; break; }
        }
        if (other) {
          flicker++;
          const a = key(base, i), bk = key(other[0], i);
          const pk = a < bk ? `${a}#${bk}` : `${bk}#${a}`;
          pairs.set(pk, (pairs.get(pk) || 0) + 1);
        }
      }
    }
    for (let i = 0; i < base.length && !all; i += 4) {
      if (base[i + 3] === 0) continue;
      if (!same(base, frames[1], i) || differs(i, 1, 2)) { unstable++; continue; }
      let other = null;
      for (let k = 2; k < frames.length; k++) {
        const f = frames[k];
        if (f[i] !== base[i] || f[i + 1] !== base[i + 1] || f[i + 2] !== base[i + 2] || f[i + 3] !== base[i + 3]) { other = [f, i]; break; }
      }
      if (!other) continue;
      flicker++;
      if (!differs(i)) continue;
      visible++;
      where[i / 4] = 1;
      const a = key(base, i), b = key(other[0], i);
      const pk = a < b ? `${a}#${b}` : `${b}#${a}`;
      pairs.set(pk, (pairs.get(pk) || 0) + 1);
    }
    const out = { flicker, visible, unstable, w, h, pct: +(100 * visible / (w * h)).toFixed(3) };
    if (all) {
      // `flicker` here is the part of `visible` the id pass could also name.
      out.byDistance = Object.fromEntries(binned.map((n, b) => [b < bins.length ? `<${bins[b]}` : `>=${bins.at(-1)}`, n]));
      out.farthest = +far.toFixed(1);
      out.tiesByDistance = Object.fromEntries(tiedBins.map((n, b) => [b < bins.length ? `<${bins[b]}` : `>=${bins.at(-1)}`, n]));
    }
    if (detail) {
      out.pairs = [...pairs.entries()].sort((p, q) => q[1] - p[1]).slice(0, 12)
        .map(([k, n]) => ({ n, a: describe(objects, k.split('#')[0]), b: describe(objects, k.split('#')[1]) }));
      // Bounding box of flicker pixels on screen, normalised.
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (let i = 0; i < where.length; i++) if (where[i]) {
        const x = (i % w) / w, y = 1 - Math.floor(i / w) / h;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      out.box = visible ? [x0, y0, x1, y1].map((v) => +v.toFixed(3)) : null;
      // Where on the world the tied pixels are: a ray through a few of them.
      const rc = new THREE.Raycaster();
      const hits = [];
      const idx = [];
      for (let i = 0; i < where.length; i++) if (where[i]) idx.push(i);
      for (let k = 0; k < Math.min(8, idx.length); k++) {
        const i = idx[Math.floor(k * idx.length / Math.min(8, idx.length))];
        rc.setFromCamera(new THREE.Vector2(((i % w) + 0.5) / w * 2 - 1, (Math.floor(i / w) + 0.5) / h * 2 - 1), cam);
        const hit = rc.intersectObject(d.built.group, true).filter((x) => x.object.visible)[0];
        if (hit) hits.push({ p: hit.point.toArray().map((v) => +v.toFixed(3)), d: +hit.distance.toFixed(2), obj: hit.object.name });
      }
      out.hits = hits;
      out.mask = where;
    }
    return out;
  };

  const describe = (objects, k) => {
    const [oi, inst, gf] = k.split('|').map(Number);
    const o = objects[oi - 1];
    if (!o) return { obj: null };
    const g = Math.floor(gf / 16), face = gf % 16;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const m = mats[g];
    const res = {
      name: o.name || o.type, type: o.type, parent: o.parent?.name, uuid: o.uuid.slice(0, 8),
      mat: m?.name || m?.type, group: g, inst,
      face: ['+x', '-x', '+y', '-y', '+z', '-z'][face % 8] + (face >= 8 ? ' back' : ''),
    };
    const mat4 = new THREE.Matrix4();
    // Which model an instanced primitive came from.
    for (const [name, asset] of d.assets?.assets || []) {
      if ((asset.primitives || asset.parts || []).some((p) => p.geometry === o.geometry)) { res.model = name; break; }
    }
    if (o.isInstancedMesh) { o.getMatrixAt(inst, mat4); res.at = new THREE.Vector3().setFromMatrixPosition(mat4.premultiply(o.matrixWorld)).toArray().map((v) => +v.toFixed(3)); }
    else if (o.isBatchedMesh) {
      try {
        o.getMatrixAt(inst, mat4); res.at = new THREE.Vector3().setFromMatrixPosition(mat4.premultiply(o.matrixWorld)).toArray().map((v) => +v.toFixed(3));
        res.geometry = o.getGeometryIdAt(inst);
        const box = o.getBoundingBoxAt(res.geometry, new THREE.Box3());
        res.size = box.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3));
        res.min = box.min.toArray().map((v) => +v.toFixed(3));
        res.verts = o._geometryInfo?.[res.geometry]?.vertexCount;
      } catch { /* not an instance id */ }
    }
    return res;
  };
  Z.objects = () => { const objects = []; swap(objects)(); return objects; };

  const frame = () => new Promise((res) => requestAnimationFrame(() => res()));

  /**
   * Shimmer on far things while turning, in the *composited* frame. The
   * camera turns `px` pixels a step; each frame is compared with the one
   * before it shifted back by those pixels, over a band either side of the
   * centre (where a turn is a plain shift to a few hundredths of a pixel) and
   * only where both frames see something past `minEye` metres, 6 px clear of
   * anything nearer. A still scene gives ~0; a screen-anchored pattern over
   * moving content (AO noise, a dither) or a surface winning by depth
   * rounding does not. Returns the share of those pixels that changed by
   * more than 3 of luma. Set the hour and let it settle before calling.
   */
  Z.swim = ({ steps = 16, px = 2, band = 60, minEye = 250 } = {}) => {
    const r = d.renderer, cam = d.camera, gl = r.getContext();
    const W = gl.drawingBufferWidth, Hh = gl.drawingBufferHeight;
    const f = (Hh / 2) / Math.tan(cam.fov * Math.PI / 360);
    const step = px / f;
    const yaw0 = cam.rotation.y, pitch = cam.rotation.x, order = cam.rotation.order;
    const bench = d.state.benchmark;
    d.state.benchmark = true;
    const frames = [];
    const raw = new Uint8Array(W * Hh * 4);
    try {
      for (let s = 0; s <= steps; s++) {
        cam.rotation.set(pitch, yaw0 + s * step, 0, 'YXZ'); cam.updateMatrixWorld();
        const e = readEye(W, Hh);
        d.composer.render();
        gl.readPixels(0, 0, W, Hh, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        const l = new Float32Array(W * Hh); const m = new Uint8Array(W * Hh);
        for (let i = 0; i < l.length; i++) {
          const j = i * 4;
          l[i] = 0.2126 * raw[j] + 0.7152 * raw[j + 1] + 0.0722 * raw[j + 2];
          m[i] = e[i] > minEye ? 1 : 0;
        }
        frames.push([l, m]);
      }
    } finally {
      cam.rotation.set(pitch, yaw0, 0, order); cam.updateMatrixWorld();
      d.state.benchmark = bench;
    }
    const x0 = Math.round(W / 2 - band), x1 = Math.round(W / 2 + band);
    const score = (sh) => {
      let sum = 0, big = 0, n = 0;
      for (let s = 1; s < frames.length; s++) {
        const [a, ma] = frames[s - 1], [b, mb] = frames[s];
        for (let y = 8; y < Hh - 8; y++) for (let x = x0; x < x1; x++) {
          const i = y * W + x, k = i + sh;
          if (!(ma[i] && mb[k] && ma[i - 6 * W] && ma[i + 6 * W] && ma[i - 6] && ma[i + 6])) continue;
          const dd = Math.abs(a[i] - b[k]); sum += dd; n++; if (dd > 3) big++;
        }
      }
      return { n, meanLuma: +(sum / Math.max(1, n)).toFixed(3), pctOver3: +(100 * big / Math.max(1, n)).toFixed(3) };
    };
    // Which way a turn shifts the picture is the camera's convention; take the one that matches.
    const a = score(px), b = score(-px);
    return a.meanLuma < b.meanLuma ? a : b;
  };

  /**
   * Every built room, `yaws` headings each. Returns per-room flicker counts
   * and, over the whole sweep, which pairs of surfaces were tied: named by
   * mesh, material and (for a batch) geometry slot, with the room they were
   * worst in -- the place to go and hide things.
   */
  Z.sweep = async ({ yaws = [0, Math.PI / 2, Math.PI, -Math.PI / 2], pitches = [0, 0.35], filter = null, frames = 3, scale = 0.5, log = null, all: everything = false } = {}) => {
    const rows = [];
    const culprits = new Map();
    // The zone being drawn, held: a portal stood on at a room's centre would
    // carry the camera into another zone and swap `diku.built` mid-sweep, so
    // the game is paused for the duration -- nothing walks, nothing teleports.
    const built = d.built;
    const rooms = [...built.rooms.entries()].filter(([v, i]) => !i.unbuilt && (!filter || filter(v, i)));
    const paused = d.state.paused;
    d.state.paused = true;
    d.state.benchmark = false;
    const sig = (x) => x.obj === null ? '?' : `${x.name}${x.model ? ' [' + x.model + ']' : ''}${x.geometry !== undefined ? ' g' + x.geometry + ' ' + x.size : ''} ${x.face}`;
    for (const [vnum] of rooms) {
      let total = 0, worst = 0, ties = 0, noise = 0;
      // Level and looking up: a ceiling, a cornice or a gable over a door is
      // out of a level view's frame entirely.
      for (const [yaw, pitch] of yaws.flatMap((y) => pitches.map((p) => [y, p]))) {
        d.goto(vnum, yaw, pitch);
        for (let i = 0; i < frames; i++) await frame();
        const m = Z.measure({ scale, detail: true, all: everything });
        total += m.visible; ties += m.flicker; noise += m.unstable; worst = Math.max(worst, m.visible);
        for (const p of m.pairs) {
          const k = [sig(p.a), sig(p.b)].sort().join('  <>  ');
          const c = culprits.get(k) || { n: 0, rooms: 0, worst: 0, at: null };
          c.n += p.n; c.rooms++;
          if (p.n > c.worst) { c.worst = p.n; c.at = [vnum, +yaw.toFixed(2), pitch, p.a.at, p.b.at, m.hits[0]?.p]; }
          culprits.set(k, c);
        }
      }
      if (d.built !== built) throw new Error(`zfight: the drawn zone changed at room ${vnum}`);
      rows.push({ vnum, name: built.rooms.get(vnum).room.name, total, worst, ties, noise });
      if (log) log(rows.length, rooms.length);
    }
    d.state.paused = paused;
    const pairs = [...culprits.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, c]) => ({ pair: k, ...c }));
    return {
      rows, pairs, total: rows.reduce((s, r) => s + r.total, 0), ties: rows.reduce((s, r) => s + r.ties, 0),
      noise: rows.reduce((s, r) => s + r.noise, 0),
    };
  };

  return Z;
}
