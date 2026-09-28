/**
 * A room behind the glass.
 *
 * A lit window at night was an emissive rectangle: one colour from edge to
 * edge, near white after tone mapping, and the same in every house -- a judge
 * called the Concourse at night "flat near-white rectangles with no
 * interior". What a lit window actually shows from the street is a room: the
 * back wall bright where the lamp is and falling off away from it, the
 * ceiling dim, the floor dark, a curtain half across, and all of it shifting
 * with parallax as you walk past.
 *
 * This is interior mapping: the view ray is carried through the pane into an
 * imaginary box and whichever face it hits is shaded, per fragment, with no
 * geometry. It needs to know where on its own pane a fragment is, so
 * `markPanes` rewrites a pane geometry's UVs -- which glass never samples --
 * into metres from the pane's own centre, along the pane and up it. Every
 * pane in town then carries its own frame through merging, batching and
 * instancing untouched, since a UV is not transformed by any of them; the
 * pane's centre, and from it a seed per window, is recovered in the shader as
 * the fragment's world position minus that offset.
 */

import * as THREE from 'three';

/**
 * Rewrite `uv` on a pane geometry to (metres along the pane, metres up it)
 * from the centre of the pane each vertex belongs to. A pane is a connected
 * island of triangles, joined through shared *positions* rather than shared
 * indices, since a box's faces share no vertices.
 */
export function markPanes(geometry) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  if (!normal) throw new Error('windows: a pane geometry has no normals');
  const count = position.count;
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

  const byPosition = new Map();
  for (let i = 0; i < count; i++) {
    const key = `${Math.round(position.getX(i) * 1000)},${Math.round(position.getY(i) * 1000)},${Math.round(position.getZ(i) * 1000)}`;
    const other = byPosition.get(key);
    if (other === undefined) byPosition.set(key, i); else join(i, other);
  }
  const index = geometry.index;
  const tris = index ? index.count / 3 : count / 3;
  for (let t = 0; t < tris; t++) {
    const a = index ? index.getX(t * 3) : t * 3;
    const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    join(a, b); join(b, c);
  }

  const boxes = new Map();
  for (let i = 0; i < count; i++) {
    const r = find(i);
    let box = boxes.get(r);
    if (!box) { box = new THREE.Box3(); boxes.set(r, box); }
    box.expandByPoint(new THREE.Vector3(position.getX(i), position.getY(i), position.getZ(i)));
  }

  const uv = new Float32Array(count * 2);
  const centre = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    boxes.get(find(i)).getCenter(centre);
    const nx = normal.getX(i); const nz = normal.getZ(i);
    // cross(up, n): along the pane, screen-right seen from outside.
    const len = Math.hypot(nx, nz) || 1;
    const tx = nz / len; const tz = -nx / len;
    uv[i * 2] = (position.getX(i) - centre.x) * tx + (position.getZ(i) - centre.z) * tz;
    uv[i * 2 + 1] = position.getY(i) - centre.y;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

const INTERIOR = /* glsl */`
  float paneHash( vec3 p ) {
    p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
    p += dot( p, p.yxz + 33.33 );
    return fract( ( p.x + p.y ) * p.z );
  }

  // The room behind a pane, in the pane's own metres: x along it, y up,
  // z into the building. Returns linear radiance before the hour's gain.
  // day = 0 is a room lit by its own lamp; 1 is the same room lit only by
  // the daylight coming in through this window, brightest just inside it.
  vec3 paneInterior( vec3 worldPos, vec3 worldNormal, vec2 paneUv, float allowDark, float day ) {
    vec3 N = worldNormal;
    vec3 T = normalize( vec3( N.z, 0.0, -N.x ) + vec3( 1e-5, 0.0, 0.0 ) );
    vec3 centre = worldPos - T * paneUv.x - vec3( 0.0, paneUv.y, 0.0 );
    vec3 seedP = floor( centre * 2.0 + 0.5 );
    float h1 = paneHash( seedP );
    float h2 = paneHash( seedP + 17.0 );
    float h3 = paneHash( seedP + 41.0 );
    float h4 = paneHash( seedP + 73.0 );

    vec3 V = normalize( worldPos - cameraPosition );
    vec3 d = vec3( dot( V, T ), V.y, -dot( V, N ) );
    d.z = max( d.z, 0.02 );
    vec3 q = vec3( paneUv, 0.0 );

    // Rooms vary: wider, deeper, lower, and the lamp stands somewhere else.
    float RW = 1.2 + 0.9 * h1;
    float RD = 2.0 + 1.8 * h2;
    float RB = 1.15 + 0.3 * h3;
    float RT = 1.05 + 0.35 * h4;

    float tx = ( ( d.x > 0.0 ? RW : -RW ) - q.x ) / ( abs( d.x ) > 1e-4 ? d.x : 1e-4 );
    float ty = ( ( d.y > 0.0 ? RT : -RB ) - q.y ) / ( abs( d.y ) > 1e-4 ? d.y : 1e-4 );
    float tz = ( RD - q.z ) / d.z;
    float t = min( tz, min( tx, ty ) );
    vec3 hp = q + d * t;

    // Surface: which face, its normal into the room, and its albedo.
    vec3 n; vec3 albedo;
    vec3 plaster = mix( vec3( 0.62, 0.50, 0.36 ), vec3( 0.55, 0.47, 0.40 ), h3 );
    plaster = mix( plaster, vec3( 0.46, 0.30, 0.22 ), step( 0.8, h4 ) ); // a red-limed room
    if ( t == tz ) {
      n = vec3( 0.0, 0.0, -1.0 );
      albedo = plaster;
      // Something against the back wall: a dresser or a hanging, dark.
      float fx = hp.x - ( h2 - 0.5 ) * RW;
      float furniture = step( abs( fx ), 0.35 + 0.3 * h1 ) * step( hp.y, -RB + 0.9 + 0.5 * h4 );
      albedo = mix( albedo, vec3( 0.16, 0.10, 0.06 ), furniture );
      // A picture or a shelf higher up.
      float picture = step( abs( hp.x + ( h3 - 0.5 ) * RW ), 0.22 ) * step( abs( hp.y - 0.25 ), 0.17 );
      albedo = mix( albedo, vec3( 0.20, 0.14, 0.09 ), picture * step( 0.35, h1 ) );
    } else if ( t == tx ) {
      n = vec3( -sign( d.x ), 0.0, 0.0 );
      albedo = plaster * 0.92;
    } else if ( d.y > 0.0 ) {
      n = vec3( 0.0, -1.0, 0.0 );
      // Joists: dark beams across the ceiling.
      float beam = step( 0.72, fract( hp.z * 1.4 + h2 ) );
      albedo = mix( vec3( 0.34, 0.27, 0.19 ), vec3( 0.13, 0.08, 0.05 ), beam );
    } else {
      n = vec3( 0.0, 1.0, 0.0 );
      float board = 0.8 + 0.2 * step( 0.5, fract( hp.x * 3.3 + h1 ) );
      albedo = vec3( 0.20, 0.13, 0.08 ) * board;
    }

    // One warm lamp, low, off to one side, plus a little fill from it off
    // everything else so no corner is black.
    vec3 lamp = vec3( ( h1 - 0.5 ) * RW * 1.2, -RB + 1.0 + 0.5 * h2, RD * ( 0.35 + 0.35 * h3 ) );
    vec3 toL = lamp - hp;
    float dist2 = dot( toL, toL );
    float lambert = max( dot( n, toL * inversesqrt( dist2 ) ), 0.0 );
    // Near white: the glass's own emissive colour is the warmth, and a warm
    // lamp under a warm tint came out as a room painted orange.
    vec3 lampCol = mix( vec3( 1.0, 0.80, 0.60 ), vec3( 1.0, 0.90, 0.76 ), h4 );
    vec3 col = albedo * lampCol * ( 3.6 * lambert / ( 0.7 + dist2 * 0.55 ) + 0.22 );
    // Daylight falls in through the window and onto the floor and the back
    // wall, and the room gets darker the deeper it goes.
    float daySpill = 1.1 / ( 0.7 + hp.z * hp.z * 0.45 ) * ( n.y > 0.5 ? 1.25 : 1.0 ) * ( n.y < -0.5 ? 0.55 : 1.0 );
    col = mix( col, albedo * ( daySpill + 0.12 ) * 2.2, day );
    // Depth: the far end of a deep room falls off.
    col *= 1.0 - 0.25 * smoothstep( 1.5, 4.0, t );

    // A curtain just behind the glass, drawn part way from one or both sides,
    // lit through from behind: folds are brightness bands.
    float cSide = h3 < 0.5 ? 1.0 : -1.0;
    float cEdge = mix( 0.05, 0.62, h2 );
    float both = step( 0.55, h1 );
    float xc = paneUv.x + d.x / d.z * 0.06;
    float curtain = step( cEdge, xc * cSide ) + both * step( cEdge, -xc * cSide );
    curtain = min( curtain, 1.0 ) * step( 0.25, h4 );
    float fold = 0.55 + 0.45 * sin( xc * 38.0 + h1 * 6.0 );
    vec3 cloth = mix( vec3( 0.55, 0.16, 0.08 ), vec3( 0.50, 0.40, 0.18 ), h2 );
    col = mix( col, cloth * mix( lampCol, vec3( 0.55 ), day ) * ( 0.28 + 0.32 * fold ), curtain );

    // Some rooms have nobody home: a glimmer from a banked fire, no more.
    float dark = allowDark * step( h2 * 0.7 + h4 * 0.3, 0.3 );
    return col * mix( 1.0, 0.06, dark );
  }`;

/**
 * Put a room behind a glass material. The material's emissive colour and
 * intensity stay the hour's dial; what they now light is the interior rather
 * than the flat pane. `tint` multiplies by the vertex colour, which the
 * procedural panes use for their warm tint. `allowDark` lets a share of panes
 * show an empty room -- for glass whose lit/unlit choice was not made already.
 */
/**
 * How far the hour has gone from lamplight to daylight, for glass that shows
 * either (`day: 'hour'`). One uniform for every such material.
 */
const paneDay = { value: 0 };
export function setPaneDaylight(level) { paneDay.value = level; }

export function interiorGlass(material, { tint = false, allowDark = false, opaque = false, day = 'lamp' } = {}) {
  // A pane laid flush on a solid wall has the wall right behind it, and
  // anything short of opaque shows the masonry through the room.
  if (opaque) { material.transparent = false; material.opacity = 1; }
  const previous = material.onBeforeCompile;
  const dayTerm = day === 'hour' ? 'paneDay' : (day === 'day' ? '1.0' : '0.0');
  material.onBeforeCompile = (shader, renderer) => {
    if (previous) previous(shader, renderer);
    shader.uniforms.paneDay = paneDay;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaneWorld;\nvarying vec3 vPaneNormal;\nvarying vec2 vPaneUv;')
      .replace('#include <worldpos_vertex>', [
        '#include <worldpos_vertex>',
        '  {',
        '    vec4 paneP = vec4( transformed, 1.0 );',
        '    vec3 paneN = objectNormal;',
        '    #ifdef USE_BATCHING',
        '      paneP = batchingMatrix * paneP;',
        '      paneN = mat3( batchingMatrix ) * paneN;',
        '    #endif',
        '    #ifdef USE_INSTANCING',
        '      paneP = instanceMatrix * paneP;',
        '      paneN = mat3( instanceMatrix ) * paneN;',
        '    #endif',
        '    vPaneWorld = ( modelMatrix * paneP ).xyz;',
        '    vPaneNormal = normalize( mat3( modelMatrix ) * paneN );',
        '    vPaneUv = uv;',
        '  }',
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vPaneWorld;\nvarying vec3 vPaneNormal;\nvarying vec2 vPaneUv;\nuniform float paneDay;\n${INTERIOR}`)
      .replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        '  {',
        '    vec3 paneN = normalize( vPaneNormal );',
        // Only the faces that look out of the wall have a room behind them.
        `    float paneFace = 1.0 - step( 0.5, abs( paneN.y ) );`,
        `    totalEmissiveRadiance *= paneFace * paneInterior( vPaneWorld, paneN, vPaneUv, ${allowDark ? '1.0' : '0.0'}, ${dayTerm} )${tint ? ' * vColor.rgb' : ''};`,
        '  }',
      ].join('\n'));
  };
  material.customProgramCacheKey = () => `pane-interior-${tint}-${allowDark}-${day}`;
  material.needsUpdate = true;
  return material;
}
