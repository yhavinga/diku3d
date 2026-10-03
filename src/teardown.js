/**
 * Taking a zone's scene apart when another zone is drawn (main.js crossTo).
 *
 * build.js and actors.js make a zone's geometry, but much of what they hand
 * the GPU is not theirs to give back: the baked surfaces (textures.js), the
 * modelled buildings and bodies (assets.js), the impostor atlases. A zone
 * that freed those would leave the next one without them. So the rule is a
 * keep-list, not an ownership tag nobody else writes: whatever the library,
 * the baked materials and the impostors can reach is kept, and everything
 * else the zone's graph holds -- its merged geometry, its instance buffers,
 * its skeletons, the canvases its signs and labels were drawn on -- is freed.
 *
 * Materials are not disposed. A material's GPU cost is its program, and the
 * program is shared by key: freeing the last material of a key releases it,
 * and the next zone to use that key compiles it again behind the veil, which
 * is the stall the boot's precompile exists to avoid. Left alone they cost
 * nothing once unreferenced -- the renderer's per-material state is weakly
 * held -- and the programs they share are bounded by the keys there are.
 */

const SKIP = (value) => !value || typeof value !== 'object' || ArrayBuffer.isView(value)
  || value instanceof ArrayBuffer || value.nodeType !== undefined;

/** Every texture a material reads, its uniforms' included. */
function texturesOf(material, out) {
  for (const value of Object.values(material)) if (value && value.isTexture) out.add(value);
  const uniforms = material.uniforms;
  if (uniforms) {
    for (const u of Object.values(uniforms)) {
      const v = u && u.value;
      if (v && v.isTexture) out.add(v);
      else if (Array.isArray(v)) for (const t of v) if (t && t.isTexture) out.add(t);
    }
  }
  return out;
}

/**
 * Everything GPU-backed reachable from `roots`: geometries, materials and
 * textures, through plain objects, arrays, Maps, Sets, class instances and
 * scene graphs. `depth` bounds the walk; the library is shallow.
 */
export function collectResources(roots, keep = new Set(), depth = 7) {
  const seen = new Set();
  const visit = (value, d) => {
    if (SKIP(value) || seen.has(value) || d < 0) return;
    seen.add(value);
    if (value.isBufferGeometry) { keep.add(value); return; }
    if (value.isTexture) { keep.add(value); return; }
    if (value.isMaterial) { keep.add(value); for (const t of texturesOf(value, new Set())) keep.add(t); return; }
    if (value.isObject3D) {
      value.traverse((o) => {
        if (o.geometry) visit(o.geometry, d);
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) if (m) visit(m, d);
      });
      return;
    }
    if (value instanceof Map) { for (const v of value.values()) visit(v, d - 1); return; }
    if (value instanceof Set || Array.isArray(value)) { for (const v of value) visit(v, d - 1); return; }
    for (const v of Object.values(value)) visit(v, d - 1);
  };
  for (const root of roots) visit(root, depth);
  return keep;
}

/**
 * Free what a zone's graph holds that `keep` does not, and take the graph
 * out of its parent. `isOwned(material)` names materials someone else keeps
 * (the impostors' twins) whose textures are not the zone's. Returns counts,
 * for the crossing's log.
 */
export function disposeZoneGraph(roots, keep, isOwned = () => false) {
  const geometries = new Set();
  const textures = new Set();
  const skeletons = new Set();
  const counts = { geometries: 0, textures: 0, skeletons: 0, instanced: 0, lights: 0 };
  for (const root of roots) {
    if (!root) continue;
    if (root.parent) root.parent.remove(root);
    root.traverse((o) => {
      // three's sprites share one static quad; it is nobody's to free.
      if (o.geometry && !o.isSprite && !keep.has(o.geometry)) geometries.add(o.geometry);
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (!m || isOwned(m)) continue;
        for (const t of texturesOf(m, new Set())) if (!keep.has(t) && !t.isRenderTargetTexture) textures.add(t);
      }
      if (o.isSkinnedMesh && o.skeleton) skeletons.add(o.skeleton);
      // Instance and batch buffers live on the mesh, not its geometry.
      if (o.isInstancedMesh || o.isBatchedMesh) { o.dispose(); counts.instanced++; }
      if (o.isLight && o.dispose) { o.dispose(); counts.lights++; }
    });
  }
  for (const g of geometries) { g.dispose(); counts.geometries++; }
  for (const t of textures) { t.dispose(); counts.textures++; }
  for (const s of skeletons) { s.dispose(); counts.skeletons++; }
  return counts;
}
