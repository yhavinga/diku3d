/**
 * Occlusion by the last frames' depth: what stood entirely behind the world
 * a frame or two ago is not drawn now.
 *
 * cull.js's measured apertures only work inside walls. Out in the open the
 * frustum was the only test, and the frustum draws a whole town behind a
 * hill: from Haon Dor's trail (#6128) the desert's massifs, the troll den's
 * cave walls and the dunes were 1.3 M triangles and 26 draws for 10 pixels
 * of picture; from the graveyard path (#3644) 0.6 M for 3.
 *
 * So the static world's depth is kept: part way through the main pass -- the
 * opaque world drawn, nothing that moves and nothing transparent yet -- a
 * sentinel copies the depth buffer aside. It is reduced to the farthest depth
 * in each 16x16 block and read back without waiting on the GPU. A sphere
 * whose nearest point lies behind the farthest depth everywhere it covers
 * was hidden in that frame, and is taken as hidden now.
 *
 * The answer is a frame or two old. Rotation is exact -- the test projects
 * with the camera the depth was taken from -- and translation since then
 * grows the sphere's rectangle by the parallax it could have moved by, so a
 * thing coming out from behind a corner is let through early rather than
 * late. What moves (figures, door leaves, dropped items, the far-tree cards)
 * and what is transparent is drawn after the copy and never occludes, so a
 * lamp behind a passer-by is not lost, and the riverbed under the water is
 * not hidden by it.
 */

import * as THREE from 'three';

/** Texels of the depth buffer per block of the reduced map, each way. */
const BLOCK = 16;
/** Drawn after the copy. Opaque things that move go here. */
export const AFTER_COPY = 10;
/** Where the copy is taken in the opaque list: after everything static. */
const COPY_ORDER = 5;
/** Metres the nearest point must be behind the farthest depth, plus a share of it. */
const MARGIN = 0.5;
const SHARE = 0.01;

const REDUCE_FRAG = /* glsl */`
  precision highp float;
  uniform highp sampler2D depthT;
  uniform vec2 size;       // full-size depth, texels
  uniform float cameraNear;
  uniform float cameraFar;
  out highp vec4 fragColor;
  void main() {
    ivec2 base = ivec2( gl_FragCoord.xy ) * ${BLOCK};
    float far = 0.0;
    float near = 1.0;
    for ( int j = 0; j < ${BLOCK}; j ++ ) for ( int i = 0; i < ${BLOCK}; i ++ ) {
      ivec2 q = min( base + ivec2( i, j ), ivec2( size ) - 1 );
      float d = texelFetch( depthT, q, 0 ).r;
      far = max( far, d );
      near = min( near, d );
    }
    // Eye depths, metres. A cleared texel is the far plane: nothing behind it.
    float k = cameraNear * cameraFar;
    float r = cameraFar - cameraNear;
    float eyeFar = far >= 1.0 ? 1e9 : k / ( cameraFar - far * r );
    float eyeNear = k / ( cameraFar - min( near, 0.999999 ) * r );
    fragColor = vec4( eyeFar, eyeNear, 0.0, 1.0 );
  }`;

/**
 * Read a float RGBA target back without waiting for the GPU: resolves once
 * the copy has landed. three's own `readRenderTargetPixelsAsync` leaves its
 * pixel-pack buffer bound while it waits, and every synchronous readPixels in
 * the meantime -- the cell probe's, a harness's -- fails with
 * INVALID_OPERATION and reads nothing. This unbinds it at once.
 */
export function readPixelsAsync(renderer, target, width, height, buffer) {
  const gl = renderer.getContext();
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(target);
  const pack = gl.createBuffer();
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
  gl.bufferData(gl.PIXEL_PACK_BUFFER, buffer.byteLength, gl.STREAM_READ);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, 0);
  gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  renderer.setRenderTarget(previous);
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  return new Promise((resolve) => {
    const poll = () => {
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) { setTimeout(poll, 2); return; }
      gl.deleteSync(sync);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buffer);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(pack);
      resolve(buffer);
    };
    setTimeout(poll, 2);
  });
}

export function createOcclusion({ renderer, scene, camera, world }) {
  const state = { enabled: true, ready: false, tested: 0, occluded: 0 };
  let copy = null;         // full-size render target holding the copied depth
  let reduced = null;      // BLOCK-reduced eye depths
  let copied = false;      // this frame's copy was taken
  // Captured with the copy, used by the test once the readback lands.
  const pending = { view: new Float64Array(16), proj: new Float64Array(16), eye: new THREE.Vector3(), near: 0.1 };
  const live = { view: new Float64Array(16), proj: new Float64Array(16), eye: new THREE.Vector3(), near: 0.1, w: 0, h: 0 };
  let map = null;          // Float32Array pyramid levels: [{ w, h, data }]
  let reading = null;

  const reduce = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { depthT: { value: null }, size: { value: new THREE.Vector2() }, cameraNear: { value: 0.1 }, cameraFar: { value: 900 } },
    vertexShader: 'void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
    fragmentShader: REDUCE_FRAG,
    depthTest: false, depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), reduce);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function targets(width, height) {
    if (copy && copy.width === width && copy.height === height) return;
    copy?.dispose(); reduced?.dispose();
    copy = new THREE.WebGLRenderTarget(width, height, {
      depthTexture: new THREE.DepthTexture(width, height, THREE.UnsignedIntType),
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    });
    copy.depthTexture.minFilter = THREE.NearestFilter;
    copy.depthTexture.magFilter = THREE.NearestFilter;
    reduced = new THREE.WebGLRenderTarget(Math.ceil(width / BLOCK), Math.ceil(height / BLOCK), {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
    // Make sure both have framebuffers before anything blits into them.
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(copy); renderer.setRenderTarget(reduced);
    renderer.setRenderTarget(previous);
    state.ready = false;
    map = null;
  }

  // The copy, taken in the middle of the main pass. An opaque, invisible
  // triangle sorted after the static world and before what moves.
  const sentinel = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }),
  );
  sentinel.name = 'occlusion sentinel';
  sentinel.frustumCulled = false;
  sentinel.renderOrder = COPY_ORDER;
  sentinel.onBeforeRender = (r, s, cam) => {
    if (!state.enabled || cam !== camera || s.overrideMaterial) return;
    const target = r.getRenderTarget();
    if (!target || target.width < 2) return;
    targets(target.width, target.height);
    const gl = r.getContext();
    const from = r.properties.get(target).__webglFramebuffer;
    const to = r.properties.get(copy).__webglFramebuffer;
    if (!from || !to) return;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.blitFramebuffer(0, 0, target.width, target.height, 0, 0, target.width, target.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    // Back to where three believes it is.
    gl.bindFramebuffer(gl.FRAMEBUFFER, from);
    copied = true;
    pending.view.set(cam.matrixWorldInverse.elements);
    pending.proj.set(cam.projectionMatrix.elements);
    pending.eye.copy(cam.position);
    pending.near = cam.near;
    reduce.uniforms.cameraNear.value = cam.near;
    reduce.uniforms.cameraFar.value = cam.far;
  };
  world.add(sentinel);

  /**
   * What moves draws after the copy. Anything opaque not under the built
   * world and not a static instanced or batched region mesh -- figures,
   * doors, items, the cards -- is put behind it in the opaque order.
   */
  function sortMovers() {
    scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints) || o === sentinel) return;
      let p = o.parent; let built = false;
      while (p) { if (p === world) { built = true; break; } p = p.parent; }
      if (built) return;
      if (o.userData.cullable || o.isBatchedMesh) return;
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      if (materials.some((m) => m?.transparent)) return;
      if (o.renderOrder < AFTER_COPY) o.renderOrder = AFTER_COPY;
    });
  }

  /** After the frame: reduce the copy and start reading it back. */
  function capture() {
    if (!state.enabled || !copied || reading) { copied = false; return; }
    copied = false;
    reduce.uniforms.depthT.value = copy.depthTexture;
    reduce.uniforms.size.value.set(copy.width, copy.height);
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(reduced);
    renderer.render(quadScene, quadCamera);
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
    const w = reduced.width; const h = reduced.height;
    const buffer = new Float32Array(w * h * 4);
    const taken = { view: pending.view.slice(), proj: pending.proj.slice(), eye: pending.eye.clone(), near: pending.near };
    reading = readPixelsAsync(renderer, reduced, w, h, buffer).then(() => {
      reading = null;
      if (reduced.width !== w || reduced.height !== h) return;
      // The farthest depth over 1, 2, 4... blocks, so a big rectangle is a
      // few reads at a coarser level.
      // The nearest as well: how near the occluders are decides how far a
      // step of the eye can have slid them across the screen.
      const levels = [];
      let data = new Float32Array(w * h);
      let near = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) { data[i] = buffer[i * 4]; near[i] = buffer[i * 4 + 1]; }
      let lw = w; let lh = h;
      levels.push({ w: lw, h: lh, data, near });
      while (lw > 1 || lh > 1) {
        const nw = Math.ceil(lw / 2); const nh = Math.ceil(lh / 2);
        const next = new Float32Array(nw * nh);
        const nextNear = new Float32Array(nw * nh);
        for (let y = 0; y < nh; y++) {
          for (let x = 0; x < nw; x++) {
            let m = 0; let n = Infinity;
            for (let dy = 0; dy < 2; dy++) {
              for (let dx = 0; dx < 2; dx++) {
                const i = Math.min(lh - 1, y * 2 + dy) * lw + Math.min(lw - 1, x * 2 + dx);
                m = Math.max(m, data[i]); n = Math.min(n, near[i]);
              }
            }
            next[y * nw + x] = m; nextNear[y * nw + x] = n;
          }
        }
        levels.push({ w: nw, h: nh, data: next, near: nextNear });
        data = next; near = nextNear; lw = nw; lh = nh;
      }
      map = levels;
      live.view.set(taken.view); live.proj.set(taken.proj); live.eye.copy(taken.eye); live.near = taken.near;
      live.w = w; live.h = h;
      state.ready = true;
    }, () => { reading = null; });
  }

  /**
   * Was a sphere behind the world when the map was taken? Conservative:
   * anything unsure -- off the old screen, across the near plane, over a
   * sky texel -- is visible.
   */
  function hidden(x, y, z, r) {
    if (!state.ready || !state.enabled) return false;
    state.tested++;
    const e = live.view; const p = live.proj;
    const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const depth = -(e[2] * x + e[6] * y + e[10] * z + e[14]);
    const front = depth - r;
    if (front <= live.near * 4) return false;
    const x0 = p[0] * Math.min((vx - r) / front, (vx - r) / (depth + r));
    const x1 = p[0] * Math.max((vx + r) / front, (vx + r) / (depth + r));
    const y0 = p[5] * Math.min((vy - r) / front, (vy - r) / (depth + r));
    const y1 = p[5] * Math.max((vy + r) / front, (vy + r) / (depth + r));
    if (x0 < -1 || y0 < -1 || x1 > 1 || y1 > 1) return false;
    // The eye has moved since. Seen past an occluder at depth n, a step of
    // `moved` slides what is behind it across the screen by at most about
    // moved / n radians: grow the rectangle by that, with n the nearest
    // occluder round it -- a doorpost at arm's length grows it to nothing.
    const moved = Math.hypot(camera.position.x - live.eye.x, camera.position.y - live.eye.y, camera.position.z - live.eye.z);
    const W = live.w; const H = live.h;
    let grow = 1;
    if (moved > 0) {
      const nearest = extreme(x0, y0, x1, y1, 2, 'near');
      const angle = moved / Math.max(0.05, nearest);
      grow += Math.ceil(angle * Math.max(p[0] * W, p[5] * H) / 2);
      if (grow > W / 2) return false;
    }
    const far = extreme(x0, y0, x1, y1, grow, 'data');
    const behind = front > far * (1 + SHARE) + MARGIN;
    if (behind) state.occluded++;
    return behind;
  }

  /** The farthest (`data`) or nearest (`near`) eye depth over an NDC rectangle grown by `slack` texels. */
  function extreme(x0, y0, x1, y1, slack, which) {
    const W = live.w; const H = live.h;
    let tx0 = Math.floor((x0 * 0.5 + 0.5) * W) - slack; let tx1 = Math.floor((x1 * 0.5 + 0.5) * W) + slack;
    let ty0 = Math.floor((y0 * 0.5 + 0.5) * H) - slack; let ty1 = Math.floor((y1 * 0.5 + 0.5) * H) + slack;
    let level = 0;
    while (level < map.length - 1 && (tx1 - tx0 > 4 || ty1 - ty0 > 4)) {
      level++;
      tx0 >>= 1; ty0 >>= 1; tx1 >>= 1; ty1 >>= 1;
    }
    const layer = map[level];
    const { w, h } = layer; const data = layer[which];
    tx0 = Math.max(0, tx0); ty0 = Math.max(0, ty0); tx1 = Math.min(w - 1, tx1); ty1 = Math.min(h - 1, ty1);
    let v = which === 'data' ? 0 : Infinity;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const d = data[ty * w + tx];
        if (which === 'data' ? d > v : d < v) v = d;
      }
    }
    return v;
  }

  return { state, capture, hidden, sortMovers, sentinel };
}
