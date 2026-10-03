"""beasts -- rigged, animated animals, modelled as signed distance fields.

The box beasts this replaces were capsules on sticks: a sphere for a head, a cone
for each ear, legs swung from the hip by the frame loop. What makes an animal
read as an animal at ten metres is the silhouette -- a deep chest over a tucked
belly, a hock that bends the other way from a knee, a muzzle that tapers -- and
none of that survives being built from primitives that meet at a crease.

So the body is one surface. Each animal is a list of anatomical solids (round
cones for limbs, ellipsoids for the ribcage, the rump, the skull), blended with
a smooth minimum so a thigh flows into a flank instead of sticking out of it,
sampled on a grid and extracted with surface nets. That gives a watertight
single skin with no seams to open when it bends. It is then decimated to budget.
The eyes, noses, hooves, beaks and horns are separate small solids in the
`horn` material, because keratin is glossy and fur is not.

The same solids that make the shape make the skin weights. Every solid is bound
to a bone (or blends between two along its length), and a vertex takes its
weights from the solids it is nearest to, falling off over the same distance
the smooth minimum blends them over. A joint is weighted exactly as widely as it
is filleted, which is what stops it pinching.

Markings are not painted. Three masks go out in the vertex colour: R pale
(belly, chest, muzzle underside), G dark points (lower legs, ear tips, a
horse's mane and tail), B a smooth noise the viewer thresholds for patches. The
viewer mixes coat, pale, points and patch colours per mobile, so one canine is a
beagle, a rottweiler, a grey wolf and a red fox.

The animation is posed, not keyed by hand. Legs are solved with two-bone IK
against footfalls planned in the body's frame: a stance foot moves backwards at
exactly the speed the body travels, so at the stride this reports the feet do
not slide. Walks are a four-beat lateral sequence (LH, LF, RH, RF) with a duty
factor over one half; runs are gallops. Everything is computed per frame and
keyed as quaternions, so no clip depends on Blender's interpolation.

Blender is Z-up; every animal faces -Y, its left side is +X, and the ground is
z = 0. Specs below are written in (side, forward, up) and flipped once.
"""

import json
import math
import importlib

import bpy
import bmesh
import mathutils
import numpy as np

import lib
importlib.reload(lib)

V = mathutils.Vector
FPS = 30


def P(s, f, u):
    """(side, forward, up) -> Blender (x, y, z). The animal faces -Y."""
    return V((s, -f, u))


# ============================================================ distance fields


def _dot(a, b):
    return np.einsum("ij,ij->i", a, b)


class Solid:
    """One anatomical solid: a distance function over points, a bounding box so
    it is only evaluated near itself, how softly it blends into what came
    before, which bones move it, and which markings it carries."""

    def __init__(self, kind, blend, bind, mask=(0.0, 0.0), neg=False, squash=None, group=None, **p):
        self.group = group
        self.kind = kind
        self.blend = blend
        self.bind = bind
        self.mask = mask
        self.neg = neg
        self.squash = np.array(squash, dtype=np.float64) if squash is not None else None
        self.p = p

    # -- geometry
    def bounds(self):
        p = self.p
        if self.kind == "cone":
            a, b = np.array(p["a"]), np.array(p["b"])
            r = max(p["ra"], p["rb"])
            lo = np.minimum(a, b) - r
            hi = np.maximum(a, b) + r
        else:
            c = np.array(p["c"])
            r = max(p["r"])
            lo, hi = c - r, c + r
        pad = self.blend + 0.01
        return lo - pad, hi + pad

    def dist(self, q):
        p = self.p
        if self.kind == "cone":
            a = np.array(p["a"], dtype=np.float64)
            b = np.array(p["b"], dtype=np.float64)
            if self.squash is not None:
                # Squashed about the cone's own midpoint: legs are deeper than
                # they are wide, an ear is a leaf and not a horn. The distance
                # is no longer exact, so it is scaled by the tightest axis to
                # stay a lower bound.
                mid = (a + b) * 0.5
                sq = self.squash
                q = mid + (q - mid) / sq
                a = mid + (a - mid) / sq
                b = mid + (b - mid) / sq
                return _round_cone(q, a, b, p["ra"], p["rb"]) * float(sq.min())
            return _round_cone(q, a, b, p["ra"], p["rb"])
        c = np.array(p["c"], dtype=np.float64)
        r = np.array(p["r"], dtype=np.float64)
        m = p.get("m")
        local = q - c
        if m is not None:
            local = local @ np.array(m, dtype=np.float64)  # rows: world->local
        k0 = np.linalg.norm(local / r, axis=1)
        k1 = np.linalg.norm(local / (r * r), axis=1)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)

    # -- skinning: fraction of this solid's weight per bone at each point
    def bone_weights(self, q):
        b = self.bind
        if isinstance(b, str):
            return {b: np.ones(len(q))}
        if isinstance(b, dict):
            return {k: np.full(len(q), v) for k, v in b.items()}
        if b[0] == "chain":
            # ("chain", [(bone, point), ...]): each bone whole at its point,
            # handing over to the next by the next point, measured along the
            # line from the first point to the last. A neck that bends over
            # three joints has to be weighted over three joints -- graded
            # straight from the chest to the upper neck, it folds at the one
            # it skipped.
            pts = np.array([p for (_, p) in b[1]], dtype=np.float64)
            axis = pts[-1] - pts[0]
            s = ((q - pts[0]) @ axis) / float(axis @ axis)
            at = ((pts - pts[0]) @ axis) / float(axis @ axis)
            out = {}
            for i, (bone, _) in enumerate(b[1]):
                w = np.zeros(len(q))
                if i == 0:
                    w[s <= at[0]] = 1.0
                if i == len(at) - 1:
                    w[s >= at[-1]] = 1.0
                if i > 0:
                    m = (s > at[i - 1]) & (s < at[i])
                    u = (s[m] - at[i - 1]) / (at[i] - at[i - 1])
                    w[m] = u * u * (3 - 2 * u)
                if i < len(at) - 1:
                    m = (s >= at[i]) & (s < at[i + 1])
                    u = (s[m] - at[i]) / (at[i + 1] - at[i])
                    w[m] = 1 - u * u * (3 - 2 * u)
                out[bone] = out.get(bone, 0) + w
            return out
        # ("grad", boneA, boneB, pointA, pointB): A at pointA, B at pointB.
        _, ba, bb, pa, pb = b
        pa, pb = np.array(pa), np.array(pb)
        axis = pb - pa
        t = np.clip(((q - pa) @ axis) / float(axis @ axis), 0.0, 1.0)
        t = t * t * (3 - 2 * t)
        return {ba: 1.0 - t, bb: t}


def _round_cone(q, a, b, r1, r2):
    """Inigo Quilez's exact round cone, vectorised."""
    ba = b - a
    l2 = float(ba @ ba)
    rr = r1 - r2
    a2 = l2 - rr * rr
    il2 = 1.0 / l2
    pa = q - a
    y = pa @ ba
    z = y - l2
    x2v = pa * l2 - np.outer(y, ba)
    x2 = _dot(x2v, x2v)
    y2 = y * y * l2
    z2 = z * z * l2
    k = math.copysign(1.0, rr) * rr * rr * x2
    d3 = (np.sqrt(np.maximum(x2 * a2 * il2, 0)) + y * rr) * il2 - r1
    d1 = np.sqrt(x2 + z2) * il2 - r2
    d2 = np.sqrt(x2 + y2) * il2 - r1
    out = np.where(np.sign(z) * a2 * z2 > k, d1, np.where(np.sign(y) * a2 * y2 < k, d2, d3))
    return out


def cone(a, b, ra, rb, bind, blend=0.02, mask=(0, 0), squash=None, neg=False, group=None):
    """A round cone from a (radius ra) to b (radius rb). `squash` scales the
    space about its midpoint, e.g. (0.7, 1, 1) for a limb flattened sideways."""
    return Solid("cone", blend, bind, mask, neg=neg, squash=squash, group=group,
                 a=tuple(a), b=tuple(b), ra=ra, rb=rb)


def ell(c, r, bind, blend=0.02, mask=(0, 0), rot=None, neg=False):
    """Ellipsoid with radii r along its own axes; `rot` is (rx, ry, rz) degrees."""
    m = None
    if rot:
        R = mathutils.Euler([math.radians(x) for x in rot]).to_matrix()
        m = [list(R.col[0]), list(R.col[1]), list(R.col[2])]
        m = np.array(m).T.tolist()  # columns are the local axes
    return Solid("ell", blend, bind, mask, neg=neg, c=tuple(c), r=tuple(r), m=m)


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.minimum(a, b) - h * h * k * 0.25


def smax(a, b, k):
    return -smin(-a, -b, k)


def _raw(s, q):
    lo, hi = s.bounds()
    inside = np.all((q >= lo) & (q <= hi), axis=1)
    di = np.full(len(q), 1e3)
    if inside.any():
        di[inside] = s.dist(q[inside])
    return di


def field(solids, q):
    """The blended distance at points q, in the order the solids are listed.
    Negative solids are carved out (nostrils, the gape of a beak).

    Solids sharing a `group` are joined with a hard minimum first and blended
    into the rest as one. That is for chains -- a tail, the bones of a leg --
    whose segments meet end to end: a smooth minimum between two coaxial
    cones is fattest exactly where they overlap, and every joint of a tail
    came out as a bead on a string."""
    d = np.full(len(q), 1e3)
    done = set()
    for s in solids:
        if s.group is not None:
            if s.group in done:
                continue
            done.add(s.group)
            di = np.full(len(q), 1e3)
            for m in solids:
                if m.group == s.group:
                    di = np.minimum(di, _raw(m, q))
        else:
            di = _raw(s, q)
        if s.neg:
            d = smax(d, -di, s.blend)
        else:
            d = smin(d, di, s.blend)
    return d


# ============================================================ surface nets

_CORNERS = np.array([(i, j, k) for k in (0, 1) for j in (0, 1) for i in (0, 1)])
_EDGES = [(a, b) for a in range(8) for b in range(a + 1, 8)
          if np.abs(_CORNERS[a] - _CORNERS[b]).sum() == 1]


def surface_nets(solids, h, pad=0.03):
    """Sample the field on a grid of pitch h and extract the zero set as quads.
    Naive surface nets: one vertex per cell the surface crosses, at the mean of
    its edge crossings, and one quad per crossed grid edge. The vertices are
    then pulled onto the true surface by a few Newton steps along the gradient,
    so the pitch sets the triangle count and not the accuracy."""
    lo = np.full(3, 1e9)
    hi = np.full(3, -1e9)
    for s in solids:
        if s.neg:
            continue
        a, b = s.bounds()
        lo = np.minimum(lo, a)
        hi = np.maximum(hi, b)
    lo -= pad
    hi += pad
    n = np.ceil((hi - lo) / h).astype(int) + 1
    xs = [lo[i] + h * np.arange(n[i]) for i in range(3)]
    gx, gy, gz = np.meshgrid(xs[0], xs[1], xs[2], indexing="ij")
    pts = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    F = field(solids, pts).reshape(n)

    inside = F < 0
    cells = n - 1
    # For every cell, sum of edge crossings.
    acc = np.zeros(tuple(cells) + (3,))
    cnt = np.zeros(tuple(cells))
    sl = lambda c: (slice(c[0], c[0] + cells[0]), slice(c[1], c[1] + cells[1]), slice(c[2], c[2] + cells[2]))
    for (a, b) in _EDGES:
        ca, cb = _CORNERS[a], _CORNERS[b]
        fa, fb = F[sl(ca)], F[sl(cb)]
        cross = (fa < 0) != (fb < 0)
        t = np.where(cross, fa / np.where(cross, fa - fb, 1.0), 0.0)
        for ax in range(3):
            acc[..., ax] += np.where(cross, ca[ax] + t * (cb[ax] - ca[ax]), 0.0)
        cnt += cross
    active = cnt > 0
    index = -np.ones(tuple(cells), dtype=np.int64)
    idx = np.argwhere(active)
    index[active] = np.arange(len(idx))
    verts = lo + h * (idx + acc[active] / cnt[active][:, None])

    faces = []
    for ax in range(3):
        # Grid edges along axis `ax` from node (i,j,k) to node + e_ax.
        e = np.zeros(3, dtype=int)
        e[ax] = 1
        a_sl = tuple(slice(0, n[i] - e[i]) for i in range(3))
        b_sl = tuple(slice(e[i], n[i]) for i in range(3))
        fa, fb = F[a_sl], F[b_sl]
        crossing = np.argwhere((fa < 0) != (fb < 0))
        if not len(crossing):
            continue
        o1, o2 = [i for i in range(3) if i != ax]
        ok = (crossing[:, o1] > 0) & (crossing[:, o2] > 0) & \
             (crossing[:, o1] < cells[o1] + 0) & (crossing[:, o2] < cells[o2] + 0) & \
             (crossing[:, ax] < cells[ax])
        crossing = crossing[ok]
        # The quad's corner order winds its normal along +ax (for x and z) or
        # -ax (for y); it has to point from inside to outside.
        flip = fa[tuple(crossing.T)] >= 0
        quads = []
        for (d1, d2) in ((0, 0), (1, 0), (1, 1), (0, 1)):
            c = crossing.copy()
            c[:, o1] -= 1 - d1
            c[:, o2] -= 1 - d2
            quads.append(index[tuple(c.T)])
        q = np.stack(quads, axis=1)
        if ax == 1:
            flip = ~flip
        q[flip] = q[flip][:, ::-1]
        faces.append(q)
    faces = np.concatenate(faces)
    faces = faces[np.all(faces >= 0, axis=1)]

    # Newton steps onto the real surface.
    eps = h * 0.25
    for _ in range(3):
        d = field(solids, verts)
        g = np.stack([
            field(solids, verts + [eps, 0, 0]) - field(solids, verts - [eps, 0, 0]),
            field(solids, verts + [0, eps, 0]) - field(solids, verts - [0, eps, 0]),
            field(solids, verts + [0, 0, eps]) - field(solids, verts - [0, 0, eps]),
        ], axis=1) / (2 * eps)
        g2 = np.maximum(_dot(g, g), 1e-9)
        step = (d / g2)[:, None] * g
        verts = verts - np.clip(step, -h, h)
    return verts, faces


# ============================================================ mesh parts


def mesh_from(verts, faces, name):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(int(i) for i in f) for f in faces])
    me.validate()
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return obj


def decimate(obj, target_tris):
    me = obj.data
    me.calc_loop_triangles()
    tris = len(me.loop_triangles)
    if tris > target_tris:
        mod = obj.modifiers.new("dec", "DECIMATE")
        mod.ratio = target_tris / tris
        mod.use_symmetry = True
        mod.symmetry_axis = "X"
        lib.apply_modifiers(obj)
    return obj


def relax(obj, solids, iterations=2, factor=0.5):
    """Even the triangles out after decimation, then pull every vertex back onto
    the field, so the spacing improves without the shape shrinking."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for _ in range(iterations):
        bmesh.ops.smooth_vert(bm, verts=bm.verts, factor=factor,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(me)
    bm.free()
    co = np.array([v.co for v in me.vertices])
    size = float(np.max(co.max(axis=0) - co.min(axis=0)))
    eps = min(0.002, size * 0.01)
    limit = size * 0.02
    for _ in range(3):
        d = field(solids, co)
        g = np.stack([
            field(solids, co + [eps, 0, 0]) - field(solids, co - [eps, 0, 0]),
            field(solids, co + [0, eps, 0]) - field(solids, co - [0, eps, 0]),
            field(solids, co + [0, 0, eps]) - field(solids, co - [0, 0, eps]),
        ], axis=1) / (2 * eps)
        g2 = np.maximum(_dot(g, g), 1e-9)
        # Bounded: a vertex near the edge of a solid's evaluation box sees a
        # step in the field of a thousand metres, and an eye came back with
        # one corner 269 m up.
        step = np.clip((d / g2)[:, None] * g, -limit, limit)
        step[np.abs(d) > limit * 4] = 0.0
        co = co - step
    for v, c in zip(me.vertices, co):
        v.co = c
    me.update()


def sdf_part(solids, h, tris, name, mat, smooth=2, mask_fn=None, patch_fn=None):
    """A solid body from blended solids: extracted, decimated to `tris`, relaxed
    back onto the field, weighted and marked from the same solids."""
    verts, faces = surface_nets(solids, h)
    obj = mesh_from(verts, faces, name)
    decimate(obj, tris)
    if smooth:
        relax(obj, solids, iterations=smooth)
    lib.assign(obj, mat)
    weigh_and_mark(obj, solids, mask_fn, patch_fn=patch_fn)
    return obj


def weigh_and_mark(obj, solids, mask_fn=None, sigma=None, patch_fn=None):
    """Skin weights and marking masks from the solids nearest each vertex.

    A vertex belongs to every solid within a blend radius of it, in proportion
    to exp(-excess distance / sigma). That is the same neighbourhood the smooth
    minimum filleted the surface over, so where two solids flow into each other
    the weights cross-fade over exactly that fillet."""
    me = obj.data
    co = np.array([v.co for v in me.vertices])
    dists = []
    for s in solids:
        if s.neg:
            continue
        lo, hi = s.bounds()
        d = np.full(len(co), 1e3)
        near = np.all((co >= lo - 0.05) & (co <= hi + 0.05), axis=1)
        if near.any():
            d[near] = s.dist(co[near])
        dists.append((s, d))
    dmin = np.min([d for (_, d) in dists], axis=0)
    total = np.zeros(len(co))
    bones = {}
    pale = np.zeros(len(co))
    dark = np.zeros(len(co))
    for (s, d) in dists:
        sig = sigma or max(0.004, s.blend * 0.6)
        w = np.exp(-np.maximum(d - dmin, 0.0) / sig)
        w[d > dmin + 6 * sig] = 0.0
        total += w
        for bone, frac in s.bone_weights(co).items():
            bones.setdefault(bone, np.zeros(len(co)))
            bones[bone] += w * frac
        pale += w * s.mask[0]
        dark += w * s.mask[1]
    total = np.maximum(total, 1e-9)
    pale /= total
    dark /= total
    names = list(bones)
    W = np.stack([bones[b] for b in names], axis=1) / total[:, None]
    # Four influences at most, which is what glTF carries in one set.
    order = np.argsort(-W, axis=1)
    keep = np.zeros_like(W, dtype=bool)
    rows = np.arange(len(co))[:, None]
    keep[rows, order[:, :4]] = True
    W = np.where(keep, W, 0.0)
    W[W < 0.01] = 0.0
    W /= np.maximum(W.sum(axis=1, keepdims=True), 1e-9)
    for j, b in enumerate(names):
        vg = obj.vertex_groups.get(b) or obj.vertex_groups.new(name=b)
        for i in np.nonzero(W[:, j])[0]:
            vg.add([int(i)], float(W[i, j]), "REPLACE")
    if mask_fn is not None:
        normals = np.array([v.normal for v in me.vertices])
        pale, dark = mask_fn(co, normals, pale, dark)
    patch = patch_fn(co) if patch_fn else patch_noise(co)
    paint(obj, np.stack([pale, dark, patch], axis=1))


def patch_noise(co, cell=0.11, seed=7):
    """Smooth 3D value noise in [0,1], sampled at each vertex. The viewer
    thresholds it per mobile, so the same field is a cow's piebald at 0.5 and a
    few scattered spots at 0.8."""
    rng = np.random.default_rng(seed)
    lattice = rng.random((32, 32, 32))

    def vnoise(p):
        i = np.floor(p).astype(int)
        f = p - i
        f = f * f * (3 - 2 * f)
        out = 0.0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * \
                        (f[:, 2] if dz else 1 - f[:, 2])
                    out = out + w * lattice[(i[:, 0] + dx) % 32, (i[:, 1] + dy) % 32, (i[:, 2] + dz) % 32]
        return out
    p = co / cell
    n = vnoise(p) * 0.7 + vnoise(p * 2.3 + 11.0) * 0.3
    return np.clip((n - 0.2) / 0.6, 0.0, 1.0)


def paint(obj, rgb):
    """Write per-vertex colour as a point-domain byte attribute, which the glTF
    exporter writes as COLOR_0."""
    me = obj.data
    name = "Col"
    if name in me.color_attributes:
        me.color_attributes.remove(me.color_attributes[name])
    # Float, and written as linear: glTF's COLOR_0 is linear and the viewer
    # reads the masks back as plain numbers, so nothing may transform them.
    attr = me.color_attributes.new(name, "FLOAT_COLOR", "POINT")
    flat = np.concatenate([np.clip(rgb, 0, 1), np.ones((len(rgb), 1))], axis=1).ravel()
    attr.data.foreach_set("color", flat.astype(np.float32))
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find(name)


def rigid(obj, bone, colour=(1, 1, 1)):
    """A small part on one bone: an eye, a hoof, a horn."""
    vg = obj.vertex_groups.new(name=bone)
    vg.add(range(len(obj.data.vertices)), 1.0, "REPLACE")
    paint(obj, np.tile(np.array(colour, dtype=float), (len(obj.data.vertices), 1)))
    return obj


def solid_part(solids, h, tris, name, mat, colour, smooth=1):
    """A horn-material part built the same way as the body, but coloured flat
    and weighted from its own solids (a hoof on one bone, a beak on the head)."""
    verts, faces = surface_nets(solids, h)
    obj = mesh_from(verts, faces, name)
    decimate(obj, tris)
    if smooth:
        relax(obj, solids, iterations=smooth)
    lib.assign(obj, mat)
    weigh_and_mark(obj, solids)
    paint(obj, np.tile(np.array(colour, dtype=float), (len(obj.data.vertices), 1)))
    return obj


def surface_point(solids, origin, direction, sink=0.0):
    """March from `origin` along `direction` until the field is crossed: where
    the skin actually is, rather than where a spec guessed it would be."""
    o = np.array(origin, dtype=float)
    d = np.array(direction, dtype=float)
    d /= np.linalg.norm(d)
    t = 0.0
    for _ in range(200):
        p = o + d * t
        f = field(solids, p[None, :])[0]
        if f < 1e-4:
            break
        # Capped: outside every solid's box the field reads 1e3, not a
        # distance, and one uncapped step from there lands in the next county.
        t += min(max(f * 0.8, 1e-4), 0.01)
    return V(tuple(o + d * (t + sink)))


# ============================================================ skeleton


def make_rig(name, bones):
    """bones: [(name, head, tail, parent)] in Blender space. Every bone is
    rolled so its local X is world +X, which makes rotation about local X a
    pitch for every bone in the animal -- the same convention townsperson.py
    uses, and set the same way (align_roll aims Z; see its docstring)."""
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    arm = bpy.context.object
    arm.name = name + "_rig"
    arm.data.name = name + "_rig"
    eb = arm.data.edit_bones
    for b in list(eb):
        eb.remove(b)
    for (bname, head, tail, parent) in bones:
        bone = eb.new(bname)
        bone.head, bone.tail = V(head), V(tail)
        if parent:
            bone.parent = eb[parent]
            bone.use_connect = (V(eb[parent].tail) - V(head)).length < 1e-6
        bone.use_deform = True
    for bone in eb:
        direction = (bone.tail - bone.head).normalized()
        if abs(direction.x) > 0.7:
            # A bone running sideways -- a spread wing -- has no sensible
            # "local X is world X"; X x direction is nearly zero and its sign
            # flips with a millimetre of drift. Z goes up instead, which makes
            # local X the fore-aft axis: pitch flaps, yaw sweeps.
            bone.align_roll(V((0.0, 0.0, 1.0)))
            continue
        target = V((1.0, 0.0, 0.0)).cross(direction)
        bone.align_roll(target if target.length > 1e-4 else V((0.0, 0.0, 1.0)))
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm


def flow_uv(obj, legtop):
    """UVs in metres, laid so V runs the way the hair lies: along the body
    on the flanks, the back and the belly, down the legs below `legtop`, and
    down the chest, the rump and the face. The fur surface draws its strands
    along V; cube projection put them vertical on a flank and sideways on a
    back, and an isotropic map was all it could carry -- which is how a grey
    wolf came to read as grey clay."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        c = f.calc_center_median()
        ax = max(range(3), key=lambda i: abs(n[i]))
        for loop in f.loops:
            x, y, z = loop.vert.co
            if ax == 1:
                loop[uv].uv = (x, z)
            elif ax == 2:
                loop[uv].uv = (x, y)
            elif c.z > legtop:
                loop[uv].uv = (z, y)
            else:
                loop[uv].uv = (y, z)
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def bind(arm, parts, name, legtop=None):
    """Join the parts into one mesh per material and skin them to the rig.

    One object per material, not one object with two: the glTF exporter
    (Blender 5.2) records the second material's vertex-colour mapping under
    the colour's *key* rather than its COLOR_n name, so every primitive after
    the first is written with COLOR_0 filled with white. The eyes came out as
    white marbles. Separate objects cost nothing -- it is one primitive per
    material either way."""
    by_mat = {}
    for p in parts:
        by_mat.setdefault(p.data.materials[0].name, []).append(p)
    meshes = []
    for mat, group in sorted(by_mat.items()):
        mesh = lib.join(group, "%s_%s" % (name, mat.replace("MAT:", "")))
        bpy.context.view_layer.update()
        mesh.data.transform(mesh.matrix_world)
        mesh.matrix_world = mathutils.Matrix.Identity(4)
        mesh.data.name = mesh.name
        # Surface nets can leave a sliver or a doubled edge where two thin
        # solids graze; the exporter warns and may write it wrongly.
        mesh.data.validate()
        shade_smooth(mesh)
        if legtop is not None and mat == "MAT:fur":
            flow_uv(mesh, legtop)
        else:
            lib.uv_project(mesh)
        bpy.ops.object.select_all(action="DESELECT")
        mesh.select_set(True)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.parent_set(type="ARMATURE_NAME")
        meshes.append(mesh)
    return meshes


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


# ============================================================ posing


class Poser:
    """Poses an armature by armature-space intent and keys the result.

    FK bones take a local rotation (pitch, yaw, roll in degrees about the
    bone's own X, Z, Y -- for every bone X is world +X at rest). IK legs take a
    toe-tip target and the angles of the two lowest segments, and the upper two
    are solved to reach. Everything is composed in hierarchy order into
    armature-space matrices, then each bone's basis is recovered from
    M = M_parent @ rest_parent^-1 @ rest @ basis, and keyed."""

    def __init__(self, arm, legs):
        self.arm = arm
        self.bones = arm.data.bones
        self.order = []

        def walk(b):
            self.order.append(b.name)
            for c in b.children:
                walk(c)
        for b in self.bones:
            if b.parent is None:
                walk(b)
        self.rest = {b.name: b.matrix_local.copy() for b in self.bones}
        self.length = {b.name: b.length for b in self.bones}
        self.legs = legs  # name -> dict(chain=[upper, lower, meta, toe], bend=V)
        self.leg_of = {}
        for lname, leg in legs.items():
            for b in leg["chain"]:
                self.leg_of[b] = lname
        self.overreach = 0.0

    def rest_tail(self, name):
        b = self.bones[name]
        return self.rest[name] @ V((0, b.length, 0))

    def solve(self, fk, root_loc=V((0, 0, 0)), root_rot=None, ik=None):
        """fk: bone -> (pitch, yaw, roll) degrees. ik: leg -> (toe_target,
        meta_dir, toe_dir) in armature space. Returns bone -> basis quaternion
        and the root location."""
        ik = ik or {}
        M = {}
        basis = {}
        for name in self.order:
            b = self.bones[name]
            rest = self.rest[name]
            leg = self.leg_of.get(name)
            if b.parent is None:
                rot = fk_quat(fk.get(name))
                if root_rot is not None:
                    rot = rest.to_quaternion().inverted() @ root_rot @ rest.to_quaternion() @ rot
                loc = rest.to_3x3().inverted() @ root_loc
                bm = mathutils.Matrix.Translation(loc) @ rot.to_matrix().to_4x4()
                M[name] = rest @ bm
                basis[name] = (rot, loc)
                continue
            parent = b.parent.name
            chain = M[parent] @ self.rest[parent].inverted() @ rest
            if leg and leg in ik:
                if name == self.legs[leg]["chain"][0]:
                    self._solve_leg(leg, chain.to_translation(), ik[leg], M)
                want = M.pop("_ik_" + name)
                bm = chain.inverted() @ want
                q = bm.to_quaternion()
                basis[name] = (q, None)
                M[name] = chain @ q.to_matrix().to_4x4()
                continue
            q = fk_quat(fk.get(name))
            basis[name] = (q, None)
            M[name] = chain @ q.to_matrix().to_4x4()
        self.M = M
        return basis

    def _solve_leg(self, leg, hip, target, M):
        up, lo, meta, toe = self.legs[leg]["chain"]
        bend = self.legs[leg]["bend"]
        tip, meta_dir, toe_dir = target
        l1, l2 = self.length[up], self.length[lo]
        lm, lt = self.length[meta], self.length[toe]
        toe_dir = V(toe_dir).normalized()
        meta_dir = V(meta_dir).normalized()
        reach = (l1 + l2) * 0.999
        base = V(tip) - toe_dir * lt
        ankle = base - meta_dir * lm
        if (ankle - hip).length > reach:
            # Out of reach with the foot flat: lift the heel. The toe tip stays
            # where it was planted and the metatarsus swings up towards the
            # hip just as far as it has to -- which is what a real hind leg
            # does at push-off, and is the difference between a planted foot
            # and a foot dragged along behind the animal.
            toward = (base - hip).normalized()
            lo_, hi_ = 0.0, 1.0
            for _ in range(14):
                mid = (lo_ + hi_) * 0.5
                cand = meta_dir.slerp(toward, mid) if meta_dir.dot(toward) > -0.999 else toward
                if (base - cand * lm - hip).length > reach:
                    lo_ = mid
                else:
                    hi_ = mid
            meta_dir = meta_dir.slerp(toward, hi_).normalized()
            ankle = base - meta_dir * lm
            if (ankle - hip).length > reach:
                # Still short with the heel right up: the toe goes up on its
                # tip too, pivoting about the point on the ground -- the last
                # of a galloping hoof's push. Only then does the foot slide.
                along = (V(tip) - hip).normalized()
                lo_, hi_ = 0.0, 1.0
                for _ in range(14):
                    mid = (lo_ + hi_) * 0.5
                    cand = toe_dir.slerp(along, mid)
                    b_ = V(tip) - cand * lt
                    if (b_ - (b_ - hip).normalized() * lm - hip).length > reach:
                        lo_ = mid
                    else:
                        hi_ = mid
                toe_dir = toe_dir.slerp(along, hi_).normalized()
                base = V(tip) - toe_dir * lt
                meta_dir = (base - hip).normalized()
                ankle = base - meta_dir * lm
        d_vec = ankle - hip
        d = d_vec.length
        if d > reach:
            if d - reach > self.overreach:
                self.worst = (leg, round(d - reach, 4))
            self.overreach = max(self.overreach, d - reach)
            d_vec = d_vec * (reach / d)
            d = reach
            ankle = hip + d_vec
        d = max(d, abs(l1 - l2) + 1e-4)
        u = d_vec.normalized()
        hint = V(bend)
        v = (hint - u * hint.dot(u)).normalized()
        ca = max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))
        knee = hip + (u * ca + v * math.sqrt(max(0.0, 1 - ca * ca))) * l1
        # Where the toe and meta actually end up if the ankle was clamped.
        base = ankle + meta_dir * lm
        for (name, head, tail) in ((up, hip, knee), (lo, knee, ankle), (meta, ankle, base),
                                   (toe, base, base + toe_dir * lt)):
            M["_ik_" + name] = frame_matrix(head, tail)

    def key(self, basis, frame):
        pbs = self.arm.pose.bones
        for name, (q, loc) in basis.items():
            pb = pbs[name]
            pb.rotation_mode = "QUATERNION"
            pb.rotation_quaternion = q
            pb.keyframe_insert("rotation_quaternion", frame=frame)
            if loc is not None:
                pb.location = loc
                pb.keyframe_insert("location", frame=frame)

    def world_of(self, name, tail=True):
        """Armature-space position of a bone's tail (or head) in the last solve."""
        m = self.M[name]
        return m @ V((0, self.length[name] if tail else 0, 0))


def fk_quat(angles):
    if not angles:
        return mathutils.Quaternion()
    pitch, yaw, roll = (tuple(angles) + (0, 0, 0))[:3]
    # Local axes: X pitch, Z yaw (for a bone lying along the body, Z is down, so
    # a positive yaw turns it to the animal's right), Y roll. Applied yaw
    # first, then roll about the bone as it now lies, then pitch -- Blender's
    # extrinsic "XYZ" is that intrinsic order. It matters for a wing: swept
    # back first and then rolled, it lies along the body; rolled first and
    # then swept, it hangs down the side like a door.
    return mathutils.Euler((math.radians(pitch), math.radians(roll), math.radians(yaw)), "XYZ").to_quaternion()


def frame_matrix(head, tail):
    """A bone frame from head to tail with X kept as close to world +X as the
    bone direction allows -- the same roll the rest pose was built with."""
    y = (V(tail) - V(head)).normalized()
    xref = V((1, 0, 0))
    x = xref - y * xref.dot(y)
    if x.length < 1e-6:
        x = V((0, 0, 1)).cross(y)
    x.normalize()
    z = x.cross(y)
    m = mathutils.Matrix((x, y, z)).transposed().to_4x4()
    m.translation = V(head)
    return m


def action_fcurves(act):
    """F-curves of an action, whichever API this Blender has: 4.4 moved them
    into layers, strips and channelbags."""
    if hasattr(act, "fcurves") and len(getattr(act, "fcurves", [])):
        return list(act.fcurves)
    out = []
    for layer in getattr(act, "layers", []):
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", []):
                out += list(bag.fcurves)
    return out


def new_action(arm, name, frames):
    if arm.animation_data is None:
        arm.animation_data_create()
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    bpy.context.scene.frame_start = 0
    bpy.context.scene.frame_end = frames
    return act


def rot_x(vec, deg):
    """Rotate a vector about world X: positive swings a downward vector
    backwards (+Y), exactly as a positive pitch does a leg bone."""
    return mathutils.Matrix.Rotation(math.radians(deg), 3, "X") @ V(vec)


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def wave(t, phase=0.0):
    return math.sin(2 * math.pi * (t + phase))


# ============================================================ quadrupeds
#
# A quadruped is described by landmarks, in (side, forward, up) metres with
# the left side positive. Only the left limbs are given; the right are mirrored.
# The bones run joint to joint, so the skeleton and the solids share one set of
# numbers and cannot drift apart.

LEG_BONES = {"hind": ("thigh", "shin", "hock", "htoe"),
             "fore": ("upperarm", "forearm", "wrist", "ftoe")}


def mirror(p):
    return (-p[0], p[1], p[2])


def quad_bones(L):
    """Bone table from landmarks. Root is the pelvis, pointing forward."""
    b = []
    spine = L["spine"]  # [pelvis head, pelvis tail/spine head, spine tail/chest head, chest tail]
    b.append(("pelvis", P(*spine[0]), P(*spine[1]), None))
    b.append(("spine", P(*spine[1]), P(*spine[2]), "pelvis"))
    b.append(("chest", P(*spine[2]), P(*spine[3]), "spine"))
    neck = L["neck"]  # [base, head joint]; may carry a middle point for long necks
    parent = "chest"
    for i in range(len(neck) - 1):
        name = "neck" if i == 0 else "neck%d" % (i + 1)
        b.append((name, P(*neck[i]), P(*neck[i + 1]), parent))
        parent = name
    b.append(("head", P(*neck[-1]), P(*L["nose"]), parent))
    if "jaw" in L:
        b.append(("jaw", P(*L["jaw"][0]), P(*L["jaw"][1]), "head"))
    tail = L["tail"]
    parent = "pelvis"
    for i in range(len(tail) - 1):
        name = "tail%d" % (i + 1)
        b.append((name, P(*tail[i]), P(*tail[i + 1]), parent))
        parent = name
    for bone, (head, tail_, parent_) in L.get("extra", {}).items():
        for side, tag in ((1, ".L"), (-1, ".R")):
            if bone.endswith("*"):
                h = head if side > 0 else mirror(head)
                t = tail_ if side > 0 else mirror(tail_)
                par = parent_[:-1] + tag if parent_.endswith("*") else parent_
                b.append((bone[:-1] + tag, P(*h), P(*t), par))
            elif side > 0:
                b.append((bone, P(*head), P(*tail_), parent_))
    for kind, attach in (("hind", "pelvis"), ("fore", "chest")):
        pts = L[kind]  # [hip, knee, ankle, toe base, toe tip]
        for side, tag in ((1, ".L"), (-1, ".R")):
            q = [p if side > 0 else mirror(p) for p in pts]
            names = [n + tag for n in LEG_BONES[kind]]
            parent_ = attach
            if kind == "fore" and "scapula" in L:
                # The shoulder blade: a quadruped's foreleg has no collarbone,
                # and most of its reach is the scapula rocking on the ribs.
                top = L["scapula"] if side > 0 else mirror(L["scapula"])
                b.append(("scapula" + tag, P(*top), P(*q[0]), attach))
                parent_ = "scapula" + tag
            for i, n in enumerate(names):
                b.append((n, P(*q[i]), P(*q[i + 1]), parent_))
                parent_ = n
    return b


def quad_legs():
    legs = {}
    for kind, bend in (("hind", V((0, -1, 0))), ("fore", V((0, 1, 0)))):
        for tag in (".L", ".R"):
            legs[kind + tag] = dict(chain=[n + tag for n in LEG_BONES[kind]], bend=bend, kind=kind)
    return legs


def leg_solids(L, kind, R, blend, side=1, mask_low=0.0, pastern=False):
    """Round cones joint to joint with radii R = [r0, r1, r2, r3, r4] at the
    five landmarks, plus whatever muscle masses the archetype adds."""
    pts = [p if side > 0 else mirror(p) for p in L[kind]]
    tag = ".L" if side > 0 else ".R"
    names = [n + tag for n in LEG_BONES[kind]]
    sq = L.get("leg_squash", (0.78, 1.0, 1.0))
    out = []
    for i in range(3):
        out.append(cone(P(*pts[i]), P(*pts[i + 1]), R[i], R[i + 1], names[i], blend=blend,
                        squash=sq, mask=(0.0, mask_low if i >= 1 else 0.0), group=kind + tag))
    if pastern:
        # A hoofed foot: the pastern runs from the fetlock down into the hoof,
        # which is a separate horn part that it disappears inside.
        end = V(pts[3]).lerp(V(pts[4]), 0.62)
        out.append(cone(P(*pts[3]), P(*end), R[3], R[3] * 0.9, names[3], blend=blend * 0.5,
                        squash=sq, mask=(0.0, mask_low), group=kind + tag))
    return out


def apply_side(p, side):
    return p if side > 0 else mirror(p)


def export_beast(name, arm, meshes):
    lib.export(name, [arm] + list(meshes),
               export_animations=True,
               export_animation_mode="ACTIONS",
               export_skins=True,
               export_def_bones=False,
               export_bake_animation=False,
               # The keys are exported as they were set: each one is a solved
               # pose, and resampling would only add frames between them.
               export_force_sampling=False,
               export_optimize_animation_size=True,
               export_vertex_color="ACTIVE",
               export_all_vertex_colors=False,
               # The rig's numbers -- stride per cycle, when the attack lands --
               # ride along as extras on the armature node, so the viewer reads
               # what was measured here instead of a copy that can drift.
               export_extras=True)


def eye_pair(body_solids, origin, direction, radius, colour=(0.05, 0.03, 0.02), sink=0.0045,
             squash=(1.0, 1.0, 0.9), h=0.0025, tris=90):
    """Two eyes, found on the skin by marching in from `origin` (left side,
    mirrored for the right) along `direction`, and sunk a little into it."""
    out = []
    for side in (1, -1):
        o = apply_side(origin, side)
        d = apply_side(direction, side)
        at = surface_point(body_solids, P(*o), P(*d), sink=sink)
        r = tuple(radius * k for k in squash)
        out.append(solid_part([ell(tuple(at), r, "head", blend=0.005)], h, tris, "eye", "horn", colour))
    return out


def leaf_pair(L, key, ra, rb, squash, h, tris=160, mask=(0, 0.35), mat="fur", colour=None):
    """A pair of ears (or anything leaf-shaped) along the named extra bones."""
    head, tail, _ = L["extra"][key + "*"]
    out = []
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        a, b = apply_side(head, side), apply_side(tail, side)
        solid = [cone(P(*a), P(*b), ra, rb, key + t, blend=0.01, squash=squash, mask=mask)]
        if colour is None:
            out.append(sdf_part(solid, h, tris, key, mat, smooth=1))
        else:
            out.append(solid_part(solid, h, tris, key, mat, colour))
    return out


def hoof_set(L, h, colour=(0.13, 0.11, 0.09), size=1.0, cloven=False, tris=120):
    """A hoof on every toe bone: a truncated cone from the coronet to a flat
    sole, the toe sloped. Cloven hooves are two halves with a cleft between."""
    out = []
    for kind in ("hind", "fore"):
        pts = L[kind]
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            base = apply_side(pts[3], side)
            tip = apply_side(pts[4], side)
            r = L["hoof"] * size
            if cloven:
                solids = []
                for k in (1, -1):
                    off = k * r * 0.48
                    solids.append(cone(P(base[0] + off, base[1], base[2]), P(tip[0] + off * 0.8, tip[1], max(tip[2], r * 0.35)),
                                       r * 0.55, r * 0.4, LEG_BONES[kind][3] + t, blend=0.004, squash=(0.8, 1.0, 1.0)))
            else:
                solids = [cone(P(base[0], base[1], base[2]), P(tip[0], tip[1], max(tip[2], r * 0.5)),
                               r * 0.92, r * 1.08, LEG_BONES[kind][3] + t, blend=0.01, squash=(0.95, 1.0, 1.0))]
            out.append(solid_part(solids, h, tris, "hoof", "horn", colour))
    return out


def canine():
    """A medium dog, 0.56 m at the withers -- a Labrador's frame. Everything
    from a puppy to a warg is this skeleton at another scale and coat; the
    two ear sets are both modelled and the viewer collapses the one a mobile
    does not have by scaling its bones to nothing."""
    L = dict(
        spine=[(0, -0.21, 0.47), (0, -0.04, 0.50), (0, 0.12, 0.52), (0, 0.25, 0.52)],
        neck=[(0, 0.25, 0.495), (0, 0.345, 0.605)],
        nose=(0, 0.535, 0.565),
        jaw=[(0, 0.375, 0.575), (0, 0.515, 0.537)],
        tail=[(0, -0.225, 0.49), (0, -0.31, 0.50), (0, -0.39, 0.475), (0, -0.46, 0.43), (0, -0.51, 0.37)],
        hind=[(0.08, -0.17, 0.44), (0.09, -0.085, 0.285), (0.085, -0.19, 0.13),
              (0.08, -0.175, 0.035), (0.08, -0.125, 0.012)],
        fore=[(0.09, 0.23, 0.40), (0.085, 0.165, 0.26), (0.08, 0.175, 0.085),
              (0.08, 0.19, 0.032), (0.08, 0.24, 0.012)],
        scapula=(0.07, 0.15, 0.50),
        extra={"ear*": ((0.042, 0.365, 0.665), (0.058, 0.358, 0.745), "head"),
               "flop*": ((0.052, 0.352, 0.662), (0.074, 0.372, 0.575), "head"),
               # The ruff: its own bone, so a breed without one collapses it.
               "ruff": ((0, 0.27, 0.53), (0, 0.33, 0.6), "neck")},
    )
    tail = L["tail"]
    body = [
        # Torso: a deep ribcage, a withers, a brisket, and a loin that rises
        # from it into the tuck of the belly.
        ell(P(0, 0.13, 0.39), (0.12, 0.165, 0.14), ("grad", "spine", "chest", P(0, 0.0, 0.4), P(0, 0.24, 0.4)), blend=0.04),
        ell(P(0, 0.235, 0.35), (0.09, 0.075, 0.105), "chest", blend=0.04),
        ell(P(0, 0.18, 0.47), (0.085, 0.11, 0.065), "chest", blend=0.04),
        cone(P(0, 0.03, 0.425), P(0, -0.14, 0.445), 0.095, 0.09, ("grad", "spine", "pelvis", P(0, 0.03, 0.43), P(0, -0.14, 0.44)), blend=0.05),
        ell(P(0, -0.175, 0.445), (0.095, 0.085, 0.085), "pelvis", blend=0.04),
        # Neck, deeper than wide, and the skull, cheeks and upper muzzle.
        cone(P(0, 0.21, 0.455), P(0, 0.34, 0.60), 0.092, 0.064, ("grad", "chest", "neck", P(0, 0.21, 0.455), P(0, 0.31, 0.57)), blend=0.045, squash=(0.85, 1, 1)),
        ell(P(0, 0.372, 0.628), (0.066, 0.075, 0.06), "head", blend=0.03),
        ell(P(0, 0.40, 0.597), (0.062, 0.052, 0.046), "head", blend=0.025),
        # The muzzle is a box with the corners off, not a cone: deep, blunt, and
        # hung with lips (flews) that cover the lower jaw from the side.
        ell(P(0, 0.465, 0.598), (0.04, 0.085, 0.036), "head", blend=0.03),
        ell(P(0, 0.49, 0.612), (0.034, 0.06, 0.026), "head", blend=0.02),
        ell(P(0.024, 0.47, 0.571), (0.02, 0.058, 0.026), "head", blend=0.02, mask=(0.3, 0)),
        ell(P(-0.024, 0.47, 0.571), (0.02, 0.058, 0.026), "head", blend=0.02, mask=(0.3, 0)),
        # Brow ridges, which are what give a dog's face its stop.
        ell(P(0.027, 0.418, 0.642), (0.022, 0.024, 0.016), "head", blend=0.02),
        ell(P(-0.027, 0.418, 0.642), (0.022, 0.024, 0.016), "head", blend=0.02),
    ]
    for i in range(len(tail) - 1):
        r0 = 0.036 - i * 0.007
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), r0, r0 - 0.007, "tail%d" % (i + 1), blend=0.03,
                         mask=(0, 0.15 * i), group="tail"))
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += leg_solids(L, "hind", [0.078, 0.05, 0.029, 0.025, 0.0], 0.035, side, mask_low=0.3)
        body += leg_solids(L, "fore", [0.066, 0.045, 0.028, 0.025, 0.0], 0.035, side, mask_low=0.3)
        # The ham and the second thigh, the triceps behind the elbow: the
        # masses that make a leg read as muscle and not as a pipe.
        body.append(ell(P(side * 0.066, -0.19, 0.37), (0.048, 0.08, 0.1), "thigh" + t, blend=0.035))
        body.append(ell(P(side * 0.085, -0.155, 0.22), (0.032, 0.04, 0.062), "shin" + t, blend=0.025))
        body.append(ell(P(side * 0.088, 0.19, 0.33), (0.055, 0.062, 0.085), "upperarm" + t, blend=0.035))
        body.append(ell(P(side * 0.08, 0.19, 0.45), (0.04, 0.06, 0.07), "scapula" + t, blend=0.04))
        # Paws: a pad of toes, wider than the leg above it.
        body.append(ell(P(side * 0.08, -0.148, 0.024), (0.032, 0.045, 0.024), "htoe" + t, blend=0.018, mask=(0, 0.5)))
        body.append(ell(P(side * 0.08, 0.213, 0.024), (0.033, 0.046, 0.025), "ftoe" + t, blend=0.018, mask=(0, 0.5)))

    def masks(co, n, pale, dark):
        # Countershading: the underside of the chest and belly, the throat.
        f = -co[:, 1]
        u = co[:, 2]
        under = np.clip((-n[:, 2] - 0.15) / 0.5, 0, 1) * (u > 0.2) * (u < 0.46) * (f > -0.2) * (f < 0.3)
        throat = np.clip((-n[:, 2] - 0.1) / 0.5, 0, 1) * np.clip((f - 0.25) / 0.06, 0, 1) * (u > 0.44) * (u < 0.6)
        muzzle = np.clip((f - 0.44) / 0.05, 0, 1) * np.clip((0.585 - u) / 0.02, 0, 1)
        pale = np.maximum(pale, np.maximum(under, np.maximum(throat, muzzle)))
        low = np.clip((0.16 - u) / 0.08, 0, 1)
        dark = np.maximum(dark, low)
        return pale, dark

    def parts(body_solids):
        out = []
        # Lower jaw: its own solid on its own bone, so a bite opens a mouth.
        jaw = [cone(P(0, 0.375, 0.577), P(0, 0.505, 0.552), 0.034, 0.016, "jaw", blend=0.02, squash=(0.8, 1, 0.75))]
        out.append(sdf_part(jaw, 0.004, 260, "jaw", "fur", smooth=1,
                            mask_fn=lambda co, n, p, d: (np.maximum(p, 0.8), d)))
        # Mouth interior, dark, split between the two bones so it stretches.
        mouth = [ell(P(0, 0.45, 0.568), (0.026, 0.065, 0.012), {"head": 0.5, "jaw": 0.5}, blend=0.01)]
        out.append(solid_part(mouth, 0.004, 120, "mouth", "horn", (0.22, 0.06, 0.06)))
        # Nose leather: glossy, black, at the very end of the muzzle.
        tip = surface_point(body_solids, P(0, 0.70, 0.58), P(0, -1, 0))
        nose = [ell(tuple(tip + V((0, 0.006, 0.004))), (0.022, 0.015, 0.017), "head", blend=0.01)]
        out.append(solid_part(nose, 0.003, 140, "nose", "horn", (0.035, 0.03, 0.03)))
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            eye_at = surface_point(body_solids, P(side * 0.09, 0.47, 0.636), P(-side * 0.75, -0.66, 0), sink=0.0045)
            out.append(solid_part([ell(tuple(eye_at), (0.0095, 0.0095, 0.0085), "head", blend=0.005)],
                                  0.0025, 90, "eye", "horn", (0.05, 0.03, 0.02)))
            # Erect ears: a leaf, thin front to back, drawn to a point.
            b0 = L["extra"]["ear*"]
            a, bb = apply_side(b0[0], side), apply_side(b0[1], side)
            ear = [cone(P(*a), P(*bb), 0.031, 0.005, "ear" + t, blend=0.01, squash=(1.0, 0.32, 1.0), mask=(0, 0.35))]
            out.append(sdf_part(ear, 0.003, 160, "ear", "fur", smooth=1))
            # Drop ears: a long flap down the side of the head.
            b0 = L["extra"]["flop*"]
            a, bb = apply_side(b0[0], side), apply_side(b0[1], side)
            ear = [cone(P(*a), P(*bb), 0.031, 0.022, "flop" + t, blend=0.01, squash=(0.26, 1.0, 1.0), mask=(0, 0.2))]
            out.append(sdf_part(ear, 0.003, 160, "flop", "fur", smooth=1))
        # The ruff: locks of long guard hair round the neck and the throat,
        # lying back towards the shoulders -- what makes a wolf's front end
        # heavier than a dog's. Pale beneath.
        a0, a1 = V((0, 0.24, 0.47)), V((0, 0.35, 0.6))
        ax = (a1 - a0).normalized()
        u0 = V((1, 0, 0))
        w0 = ax.cross(u0).normalized()
        ruff = []
        for ring, (t, rr, ln) in enumerate(((0.15, 0.095, 0.11), (0.45, 0.085, 0.1), (0.75, 0.072, 0.085))):
            c = a0.lerp(a1, t)
            for q in range(11):
                ang = 2 * math.pi * (q + 0.5 * ring) / 11
                out_ = u0 * math.cos(ang) + w0 * math.sin(ang)
                root = c + out_ * rr * 0.8
                tip = root + out_ * ln * 0.45 - ax * ln * 0.85 + V((0, 0, -0.02))
                below = max(0.0, -out_.z)
                ruff.append(cone(P(*root), P(*tip), 0.03, 0.006, "ruff", blend=0.02, squash=(1, 1, 0.55),
                                 mask=(0.55 * below, 0.0)))
        out.append(sdf_part(ruff, 0.004, 900, "ruff", "fur", smooth=1))
        return out

    return dict(name="beast_canine", archetype="canine", L=L, body=body, masks=masks, parts=parts, h=0.0055, tris=3000,
                gait=dict(walk_stride=0.56, walk_frames=26, walk_duty=0.64, lift=0.05,
                          run_stride=1.5, run_frames=14, run_duty=0.34, run_lift=0.08,
                          gallop="rotary", bite=True, lie=0.12, pastimes=["sniff", "haunch", "snarl", "howl"]))


def feline():
    """A domestic cat, 0.25 m at the shoulder: a small round head, a supple
    back carried higher at the hips, and a tail as long as the body. The
    patch channel carries tabby stripes instead of noise, so a tabby is the
    coat at cover 0.5 and a plain cat is cover 0."""
    L = dict(
        spine=[(0, -0.14, 0.235), (0, -0.03, 0.245), (0, 0.08, 0.235), (0, 0.155, 0.225)],
        neck=[(0, 0.15, 0.232), (0, 0.19, 0.278)],
        nose=(0, 0.272, 0.258),
        jaw=[(0, 0.20, 0.252), (0, 0.258, 0.243)],
        tail=[(0, -0.155, 0.235), (0, -0.225, 0.235), (0, -0.295, 0.215), (0, -0.36, 0.18),
              (0, -0.41, 0.135), (0, -0.445, 0.085)],
        hind=[(0.04, -0.11, 0.215), (0.046, -0.05, 0.14), (0.043, -0.13, 0.072),
              (0.04, -0.118, 0.016), (0.04, -0.094, 0.006)],
        fore=[(0.045, 0.13, 0.19), (0.042, 0.10, 0.12), (0.04, 0.108, 0.036),
              (0.04, 0.114, 0.014), (0.04, 0.138, 0.006)],
        scapula=(0.034, 0.085, 0.25),
        extra={"ear*": ((0.023, 0.208, 0.303), (0.03, 0.205, 0.34), "head")},
    )
    tail = L["tail"]
    body = [
        ell(P(0, 0.065, 0.185), (0.056, 0.098, 0.066), ("grad", "spine", "chest", P(0, 0.0, 0.2), P(0, 0.14, 0.2)), blend=0.03),
        ell(P(0, 0.128, 0.172), (0.044, 0.04, 0.05), "chest", blend=0.025),
        cone(P(0, -0.005, 0.198), P(0, -0.105, 0.212), 0.049, 0.052, ("grad", "spine", "pelvis", P(0, 0.0, 0.2), P(0, -0.1, 0.21)), blend=0.035),
        ell(P(0, -0.118, 0.212), (0.052, 0.055, 0.05), "pelvis", blend=0.03),
        cone(P(0, 0.125, 0.205), P(0, 0.185, 0.268), 0.044, 0.036, ("grad", "chest", "neck", P(0, 0.125, 0.205), P(0, 0.18, 0.262)), blend=0.03, squash=(0.9, 1, 1)),
        # A cat's head is nearly round, with the muzzle a small pad on the
        # front of it and the cheeks wider than the skull.
        ell(P(0, 0.212, 0.281), (0.04, 0.04, 0.036), "head", blend=0.02),
        ell(P(0, 0.227, 0.262), (0.043, 0.03, 0.026), "head", blend=0.018),
        ell(P(0, 0.25, 0.259), (0.02, 0.02, 0.016), "head", blend=0.012),
        ell(P(0.01, 0.26, 0.253), (0.011, 0.011, 0.009), "head", blend=0.008, mask=(0.8, 0)),
        ell(P(-0.01, 0.26, 0.253), (0.011, 0.011, 0.009), "head", blend=0.008, mask=(0.8, 0)),
    ]
    for i in range(len(tail) - 1):
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), 0.0155 - i * 0.001, 0.0145 - i * 0.001,
                         "tail%d" % (i + 1), blend=0.02, group="tail"))
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += leg_solids(L, "hind", [0.036, 0.022, 0.0125, 0.011, 0.0], 0.018, side)
        body += leg_solids(L, "fore", [0.027, 0.019, 0.012, 0.011, 0.0], 0.018, side)
        body.append(ell(P(side * 0.036, -0.125, 0.18), (0.028, 0.045, 0.055), "thigh" + t, blend=0.02))
        body.append(ell(P(side * 0.044, -0.1, 0.11), (0.017, 0.022, 0.035), "shin" + t, blend=0.015))
        body.append(ell(P(side * 0.044, 0.112, 0.165), (0.027, 0.032, 0.045), "upperarm" + t, blend=0.02))
        body.append(ell(P(side * 0.04, 0.09, 0.225), (0.02, 0.03, 0.035), "scapula" + t, blend=0.02))
        body.append(ell(P(side * 0.04, -0.106, 0.012), (0.014, 0.022, 0.012), "htoe" + t, blend=0.01))
        body.append(ell(P(side * 0.04, 0.126, 0.012), (0.015, 0.021, 0.012), "ftoe" + t, blend=0.01))

    def masks(co, n, pale, dark):
        f = -co[:, 1]
        u = co[:, 2]
        under = np.clip((-n[:, 2] - 0.1) / 0.5, 0, 1) * (u < 0.23) * (f > -0.12) * (f < 0.2)
        chin = np.clip((f - 0.215) / 0.03, 0, 1) * np.clip((0.262 - u) / 0.012, 0, 1)
        pale = np.maximum(pale, np.maximum(under, chin))
        return pale, dark

    def stripes(co):
        """Tabby: bands round the body and tail, rings on the legs, an M on
        the brow -- all one function of position, thresholded in the viewer."""
        f = -co[:, 1]
        u = co[:, 2]
        body = 0.5 + 0.5 * np.sin(f * 95.0 + np.sin(u * 40.0) * 1.2)
        legs = 0.5 + 0.5 * np.sin(u * 110.0)
        on_leg = np.clip((0.17 - u) / 0.04, 0, 1) * (np.abs(f) < 0.2)
        return np.clip(body * (1 - on_leg) + legs * on_leg, 0, 1)

    def parts(body_solids):
        out = []
        jaw = [cone(P(0, 0.201, 0.252), P(0, 0.253, 0.243), 0.017, 0.008, "jaw", blend=0.01, squash=(0.9, 1, 0.8))]
        out.append(sdf_part(jaw, 0.002, 160, "jaw", "fur", smooth=1,
                            mask_fn=lambda co, n, p, d: (np.maximum(p, 0.9), d)))
        tip = surface_point(body_solids, P(0, 0.34, 0.263), P(0, -1, 0))
        out.append(solid_part([ell(tuple(tip + V((0, 0.0025, 0.0015))), (0.0062, 0.004, 0.0045), "head", blend=0.003)],
                              0.0015, 80, "nose", "horn", (0.45, 0.22, 0.22)))
        out += eye_pair(body_solids, (0.045, 0.28, 0.281), (-0.5, -0.86, 0), 0.0078,
                        colour=(0.24, 0.21, 0.05), sink=0.0052, squash=(1.0, 1.0, 0.8), h=0.0014)
        out += leaf_pair(L, "ear", 0.019, 0.003, (1.0, 0.32, 1.0), 0.0018, tris=140, mask=(0.2, 0.2))
        return out

    return dict(name="beast_feline", archetype="feline", L=L, body=body, masks=masks, parts=parts,
                patch=stripes, h=0.0028, tris=2800,
                gait=dict(walk_stride=0.28, walk_frames=24, walk_duty=0.62, lift=0.03,
                          run_stride=0.75, run_frames=12, run_duty=0.33, run_lift=0.05,
                          gallop="rotary", wag=6.0, idle_wag=1, tail_pitch=8.0, lie=0.055, arch=10.0))


def rodent():
    """A brown rat, 0.22 m nose to rump and as much again in tail: a pear of a
    body carried low, hind feet flat on the ground, a pointed snout. The tail
    is bare and scaly, so it is modelled in `horn`, not fur."""
    L = dict(
        spine=[(0, -0.075, 0.072), (0, -0.02, 0.086), (0, 0.04, 0.082), (0, 0.08, 0.07)],
        neck=[(0, 0.08, 0.07), (0, 0.108, 0.074)],
        nose=(0, 0.176, 0.05),
        jaw=[(0, 0.118, 0.054), (0, 0.158, 0.043)],
        tail=[(0, -0.09, 0.06), (0, -0.14, 0.044), (0, -0.19, 0.03), (0, -0.24, 0.018),
              (0, -0.285, 0.01), (0, -0.325, 0.006)],
        hind=[(0.022, -0.055, 0.06), (0.03, -0.022, 0.038), (0.027, -0.068, 0.014),
              (0.025, -0.034, 0.004), (0.025, -0.016, 0.003)],
        fore=[(0.022, 0.058, 0.05), (0.02, 0.042, 0.03), (0.019, 0.056, 0.012),
              (0.019, 0.064, 0.004), (0.019, 0.077, 0.002)],
        scapula=(0.016, 0.035, 0.08),
        extra={"ear*": ((0.014, 0.112, 0.086), (0.021, 0.108, 0.104), "head")},
    )
    body = [
        ell(P(0, 0.033, 0.064), (0.034, 0.056, 0.037), ("grad", "spine", "chest", P(0, 0.0, 0.07), P(0, 0.07, 0.07)), blend=0.02),
        ell(P(0, -0.045, 0.069), (0.041, 0.052, 0.043), ("grad", "pelvis", "spine", P(0, -0.06, 0.07), P(0, 0.0, 0.07)), blend=0.025),
        cone(P(0, 0.07, 0.066), P(0, 0.11, 0.072), 0.03, 0.025, ("grad", "chest", "neck", P(0, 0.07, 0.066), P(0, 0.105, 0.072)), blend=0.02),
        ell(P(0, 0.113, 0.07), (0.024, 0.03, 0.022), "head", blend=0.015),
        cone(P(0, 0.12, 0.066), P(0, 0.168, 0.05), 0.02, 0.0085, "head", blend=0.015),
    ]
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += leg_solids(L, "hind", [0.016, 0.01, 0.0065, 0.006, 0.0], 0.01, side)
        body += leg_solids(L, "fore", [0.011, 0.0075, 0.005, 0.0045, 0.0], 0.008, side)
        body.append(ell(P(side * 0.026, -0.05, 0.048), (0.016, 0.03, 0.028), "thigh" + t, blend=0.012))
        body.append(ell(P(side * 0.025, -0.03, 0.004), (0.008, 0.02, 0.004), "htoe" + t, blend=0.006, mask=(0.7, 0)))
        body.append(ell(P(side * 0.019, 0.07, 0.004), (0.006, 0.01, 0.004), "ftoe" + t, blend=0.005, mask=(0.7, 0)))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        under = np.clip((-n[:, 2] - 0.2) / 0.5, 0, 1) * (u < 0.07)
        return np.maximum(pale, under), dark

    def parts(body_solids):
        out = []
        jaw = [cone(P(0, 0.12, 0.055), P(0, 0.154, 0.044), 0.011, 0.005, "jaw", blend=0.006, squash=(0.9, 1, 0.8))]
        out.append(sdf_part(jaw, 0.0012, 120, "jaw", "fur", smooth=1,
                            mask_fn=lambda co, n, p, d: (np.maximum(p, 0.7), d)))
        tip = surface_point(body_solids, P(0, 0.22, 0.05), P(0, -1, 0))
        out.append(solid_part([ell(tuple(tip + V((0, 0.0015, 0.0005))), (0.0045, 0.003, 0.0035), "head", blend=0.002)],
                              0.0009, 60, "nose", "horn", (0.55, 0.32, 0.32)))
        out += eye_pair(body_solids, (0.03, 0.135, 0.075), (-0.8, -0.3, 0), 0.0048, colour=(0.02, 0.015, 0.015),
                        sink=0.0022, h=0.0009, tris=60)
        out += leaf_pair(L, "ear", 0.011, 0.0085, (1.0, 0.3, 1.0), 0.0012, tris=90, mask=(0.3, 0.3))
        # The tail: bare, ringed, pinkish-grey -- keratin scales, not fur.
        tail = L["tail"]
        solids = [cone(P(*tail[i]), P(*tail[i + 1]), 0.0068 - i * 0.0009, 0.0059 - i * 0.0009,
                       "tail%d" % (i + 1), blend=0.004, group="t") for i in range(len(tail) - 1)]
        out.append(solid_part(solids, 0.0012, 260, "tail", "horn", (0.46, 0.36, 0.34)))
        return out

    return dict(name="beast_rodent", archetype="rodent", L=L, body=body, masks=masks, parts=parts,
                h=0.0015, tris=1700,
                gait=dict(walk_stride=0.09, walk_frames=14, walk_duty=0.6, lift=0.012,
                          run_stride=0.26, run_frames=10, run_duty=0.35, run_lift=0.02,
                          gallop="rotary", wag=10.0, idle_wag=1, tail_pitch=0.0, lie=0.03, arch=12.0))


def claws(L, kind, count, length, radius, h, colour=(0.16, 0.14, 0.12), tris=40):
    """Claws on the toes of one pair of feet, fanned across the paw."""
    out = []
    pts = L[kind]
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        base = V(apply_side(pts[3], side))
        tip = V(apply_side(pts[4], side))
        fwd = (tip - base)
        fwd.z = 0
        fwd.normalize()
        solids = []
        for i in range(count):
            spread = (i - (count - 1) / 2) / max(1, count - 1)
            root = tip + V((spread * radius * 5.0, -radius * 1.2, radius * 0.8))
            end = root + V((spread * radius * 1.2, fwd.y * length, -length * 0.55))
            solids.append(cone(P(*root), P(*end), radius, radius * 0.25, LEG_BONES[kind][3] + t,
                               blend=0.002, group="c%d" % i))
        out.append(solid_part(solids, h, tris * count, "claws", "horn", colour, smooth=0))
    return out


def bear():
    """A brown bear, 1.05 m at the hump and 1.9 m long: the hump of the
    shoulder muscles, the dished face, small round ears, and feet that go
    down flat, heel and all. Also the 'huge hairy beast' of the marsh, at
    another scale and colour."""
    L = dict(
        spine=[(0, -0.55, 0.92), (0, -0.2, 0.95), (0, 0.2, 1.0), (0, 0.45, 0.98)],
        neck=[(0, 0.45, 0.92), (0, 0.72, 0.9)],
        nose=(0, 1.08, 0.78),
        jaw=[(0, 0.8, 0.8), (0, 1.02, 0.73)],
        tail=[(0, -0.66, 0.86), (0, -0.74, 0.83), (0, -0.8, 0.77)],
        hind=[(0.17, -0.46, 0.78), (0.2, -0.28, 0.48), (0.19, -0.5, 0.14),
              (0.19, -0.29, 0.055), (0.19, -0.17, 0.035)],
        fore=[(0.2, 0.42, 0.72), (0.19, 0.3, 0.46), (0.18, 0.36, 0.1),
              (0.18, 0.43, 0.045), (0.18, 0.54, 0.032)],
        scapula=(0.15, 0.28, 1.02),
        extra={"ear*": ((0.1, 0.79, 1.0), (0.13, 0.78, 1.07), "head")},
    )
    tail = L["tail"]
    body = [
        ell(P(0, 0.2, 0.72), (0.3, 0.42, 0.3), ("grad", "spine", "chest", P(0, 0.0, 0.7), P(0, 0.4, 0.7)), blend=0.08),
        ell(P(0, 0.3, 0.98), (0.21, 0.26, 0.13), ("grad", "chest", "spine", P(0, 0.4, 0.98), P(0, 0.1, 0.98)), blend=0.1),
        cone(P(0, -0.1, 0.72), P(0, -0.44, 0.76), 0.29, 0.27, ("grad", "spine", "pelvis", P(0, -0.1, 0.72), P(0, -0.44, 0.76)), blend=0.1),
        ell(P(0, -0.5, 0.77), (0.27, 0.22, 0.23), "pelvis", blend=0.08),
        cone(P(0, 0.4, 0.83), P(0, 0.72, 0.88), 0.25, 0.17, ("grad", "chest", "neck", P(0, 0.4, 0.83), P(0, 0.68, 0.88)), blend=0.08),
        ell(P(0, 0.79, 0.9), (0.165, 0.15, 0.14), "head", blend=0.06),
        ell(P(0, 0.84, 0.845), (0.175, 0.1, 0.1), "head", blend=0.05),
        ell(P(0, 0.96, 0.805), (0.08, 0.13, 0.075), "head", blend=0.05),
        # The ruff: bears carry long fur at the cheeks and throat.
        ell(P(0, 0.62, 0.78), (0.2, 0.14, 0.16), ("grad", "chest", "neck", P(0, 0.5, 0.8), P(0, 0.7, 0.8)), blend=0.08),
    ]
    for i in range(len(tail) - 1):
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), 0.07 - i * 0.02, 0.05 - i * 0.02, "tail%d" % (i + 1),
                         blend=0.04, group="tail"))
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += leg_solids(L, "hind", [0.15, 0.1, 0.075, 0.07, 0.0], 0.07, side)
        body += leg_solids(L, "fore", [0.14, 0.105, 0.08, 0.075, 0.0], 0.07, side)
        body.append(ell(P(side * 0.17, -0.47, 0.6), (0.13, 0.2, 0.25), "thigh" + t, blend=0.08))
        body.append(ell(P(side * 0.19, -0.4, 0.33), (0.08, 0.1, 0.14), "shin" + t, blend=0.05))
        body.append(ell(P(side * 0.2, 0.36, 0.58), (0.13, 0.15, 0.2), "upperarm" + t, blend=0.08))
        body.append(ell(P(side * 0.18, 0.34, 0.3), (0.085, 0.09, 0.16), "forearm" + t, blend=0.05))
        body.append(ell(P(side * 0.19, -0.26, 0.045), (0.08, 0.13, 0.045), "htoe" + t, blend=0.03))
        body.append(ell(P(side * 0.18, 0.47, 0.045), (0.085, 0.1, 0.045), "ftoe" + t, blend=0.03))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        low = np.clip((0.35 - u) / 0.2, 0, 1)
        return pale, np.maximum(dark, low * 0.6)

    def parts(body_solids):
        out = []
        jaw = [cone(P(0, 0.8, 0.8), P(0, 1.0, 0.735), 0.075, 0.045, "jaw", blend=0.03, squash=(0.9, 1, 0.8))]
        out.append(sdf_part(jaw, 0.008, 220, "jaw", "fur", smooth=1))
        mouth = [ell(P(0, 0.93, 0.77), (0.055, 0.1, 0.02), {"head": 0.5, "jaw": 0.5}, blend=0.01)]
        out.append(solid_part(mouth, 0.008, 120, "mouth", "horn", (0.25, 0.07, 0.07)))
        tip = surface_point(body_solids, P(0, 1.3, 0.8), P(0, -1, 0))
        out.append(solid_part([ell(tuple(tip + V((0, 0.014, 0.004))), (0.036, 0.024, 0.027), "head", blend=0.01)],
                              0.005, 140, "nose", "horn", (0.03, 0.028, 0.028)))
        out += eye_pair(body_solids, (0.25, 0.95, 0.9), (-0.72, -0.69, 0), 0.014, colour=(0.04, 0.025, 0.02),
                        sink=0.007, h=0.004)
        out += leaf_pair(L, "ear", 0.055, 0.042, (1.0, 0.4, 1.0), 0.006, tris=120, mask=(0, 0.2))
        out += claws(L, "fore", 5, 0.075, 0.013, 0.004)
        out += claws(L, "hind", 5, 0.05, 0.011, 0.004)
        return out

    return dict(name="beast_bear", archetype="bear", L=L, body=body, masks=masks, parts=parts,
                h=0.011, tris=3600,
                gait=dict(walk_stride=1.05, walk_frames=34, walk_duty=0.66, lift=0.1,
                          run_stride=1.7, run_frames=18, run_duty=0.4, run_lift=0.16,
                          gallop="rotary", wag=3.0, idle_wag=1, tail_pitch=-10.0, lie=0.3, arch=6.0,
                          pant=0.0, pastimes=["sniff", "rear"], sniff_face=40.0, sniff_ground=0.06,
                          flex={"hind": dict(lean=6, push=18, fold=30, curl=25),
                                "fore": dict(lean=6, push=20, fold=55, curl=25, scap=10)}))


def hooves(L, h, r, colour=(0.12, 0.1, 0.085), cloven=False, tris=110, at=0.55):
    """A hoof at the foot of every leg: from the coronet, `at` of the way down
    the pastern, flaring to a flat sole on the ground under the toe. Cloven
    hooves are two claws with a cleft between."""
    out = []
    for kind in ("hind", "fore"):
        pts = L[kind]
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            fet = V(apply_side(pts[3], side))
            tip = V(apply_side(pts[4], side))
            coronet = fet.lerp(tip, at)
            sole = V((tip.x, lerp(coronet.y, tip.y, 0.55), r * 0.55))
            bone = LEG_BONES[kind][3] + t
            if cloven:
                solids = [cone(P(coronet.x + k * r * 0.42, coronet.y, coronet.z),
                               P(sole.x + k * r * 0.5, sole.y + 0.35 * r, sole.z * 0.8),
                               r * 0.5, r * 0.45, bone, blend=0.003, squash=(0.9, 1.0, 1.0), group="c%d" % k)
                          for k in (1, -1)]
            else:
                solids = [cone(P(*coronet), P(*sole), r * 0.86, r, bone, blend=0.004, squash=(0.95, 1.0, 1.0))]
            out.append(solid_part(solids, h, tris, "hoof", "horn", colour, smooth=1))
    return out


def equine():
    """A riding horse, 1.55 m at the withers. Pony, mule and donkey are this at
    other scales, coats and ear lengths. The mane and tail are solids carrying
    the dark-points mask, so a bay has black ones and a chestnut does not."""
    L = dict(
        spine=[(0, -0.62, 1.36), (0, -0.2, 1.42), (0, 0.2, 1.44), (0, 0.5, 1.46)],
        # The neck's bones run low in it, from the root of the neck in front
        # of the shoulder, where a horse lowers its head from -- not from the
        # withers, where the crest begins.
        neck=[(0, 0.66, 1.2), (0, 0.95, 1.58), (0, 1.1, 1.9)],
        nose=(0, 1.42, 1.42),
        jaw=[(0, 1.16, 1.7), (0, 1.38, 1.4)],
        tail=[(0, -0.8, 1.42), (0, -0.9, 1.32), (0, -0.95, 1.14), (0, -0.97, 0.94), (0, -0.97, 0.72)],
        hind=[(0.2, -0.55, 1.15), (0.23, -0.38, 0.82), (0.19, -0.68, 0.55),
              (0.17, -0.64, 0.18), (0.17, -0.55, 0.0)],
        fore=[(0.22, 0.72, 1.12), (0.2, 0.52, 0.92), (0.17, 0.55, 0.5),
              (0.16, 0.55, 0.18), (0.16, 0.64, 0.0)],
        scapula=(0.15, 0.42, 1.5),
        hoof=0.07,
        extra={"ear*": ((0.07, 1.12, 1.97), (0.085, 1.1, 2.1), "head")},
    )
    tail = L["tail"]
    body = [
        ell(P(0, 0.05, 1.18), (0.31, 0.62, 0.33), ("grad", "spine", "chest", P(0, -0.2, 1.2), P(0, 0.4, 1.2)), blend=0.12),
        ell(P(0, 0.52, 1.2), (0.26, 0.3, 0.3), "chest", blend=0.1),
        ell(P(0, 0.42, 1.44), (0.14, 0.26, 0.1), "chest", blend=0.1),
        ell(P(0, -0.52, 1.22), (0.28, 0.33, 0.31), ("grad", "pelvis", "spine", P(0, -0.6, 1.2), P(0, -0.1, 1.2)), blend=0.12),
        ell(P(0, -0.72, 1.12), (0.21, 0.13, 0.23), "pelvis", blend=0.1),
        # The neck is deep and flat-sided, with the crest arching over it.
        cone(P(0, 0.6, 1.24), P(0, 1.06, 1.8), 0.3, 0.16, ("chain", [("chest", P(0, 0.515, 1.01)), ("neck", P(0, 0.805, 1.39)),
                                                                     ("neck2", P(0, 1.025, 1.74)), ("head", P(0, 1.175, 2.06))]),
             blend=0.12, squash=(0.6, 1, 1)),
        ell(P(0, 0.84, 1.66), (0.08, 0.3, 0.1), ("grad", "neck", "neck2", P(0, 0.7, 1.55), P(0, 1.0, 1.8)), blend=0.08, rot=(-50, 0, 0)),
        # A long head: the round jowl, the flat face, the soft muzzle.
        ell(P(0, 1.15, 1.76), (0.115, 0.15, 0.15), "head", blend=0.06),
        ell(P(0, 1.12, 1.68), (0.125, 0.12, 0.12), "head", blend=0.06),
        ell(P(0, 1.2, 1.86), (0.105, 0.1, 0.08), "head", blend=0.05),
        cone(P(0, 1.2, 1.85), P(0, 1.39, 1.47), 0.09, 0.072, "head", blend=0.05, squash=(0.82, 1, 1)),
        ell(P(0, 1.385, 1.45), (0.088, 0.095, 0.085), "head", blend=0.05, mask=(0.6, 0)),
    ]
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += leg_solids(L, "hind", [0.14, 0.09, 0.05, 0.05, 0.0], 0.09, side, mask_low=0.9, pastern=True)
        body += leg_solids(L, "fore", [0.12, 0.08, 0.048, 0.049, 0.0], 0.08, side, mask_low=0.9, pastern=True)
        body.append(ell(P(side * 0.19, -0.6, 1.0), (0.12, 0.25, 0.3), "thigh" + t, blend=0.1))
        body.append(ell(P(side * 0.2, -0.52, 0.7), (0.07, 0.12, 0.14), "shin" + t, blend=0.06))
        body.append(ell(P(side * 0.21, 0.62, 1.05), (0.1, 0.16, 0.2), "upperarm" + t, blend=0.1))
        body.append(ell(P(side * 0.19, 0.52, 0.74), (0.07, 0.08, 0.16), "forearm" + t, blend=0.06))
        body.append(ell(P(side * 0.18, 0.46, 1.3), (0.09, 0.14, 0.18), "scapula" + t, blend=0.1))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        f = -co[:, 1]
        low = np.clip((0.62 - u) / 0.14, 0, 1) * (np.abs(f) > 0.3)
        return pale, np.maximum(dark, low)

    def parts(body_solids):
        out = []
        # Mane and forelock: locks off the crest, falling to the off side of
        # the neck each its own length, so the crest reads as hair against
        # the sky and not as a fin. A smooth ridge here, in a dim barn, was
        # half of why a horse read as a blob.
        rng = np.random.default_rng(17)
        mane = []
        crest = [V((0, 0.5, 1.56)), V((0, 0.85, 1.8)), V((0, 1.12, 2.0))]
        for i in range(15):
            t = i / 14.0
            c = crest[0].lerp(crest[1], t * 2) if t < 0.5 else crest[1].lerp(crest[2], (t - 0.5) * 2)
            bone = ("chain", [("chest", P(0, 0.5, 1.5)), ("neck", P(0, 0.78, 1.72)), ("neck2", P(0, 1.0, 1.9)),
                              ("head", P(0, 1.15, 2.02))])
            L_ = 0.2 + 0.12 * math.sin(math.pi * t) + rng.uniform(-0.04, 0.04)
            end = c + V((-0.13 - 0.05 * rng.random(), -0.05 - 0.04 * rng.random(), -L_))
            mid = c.lerp(end, 0.45) + V((-0.06, 0.0, 0.02))
            mane += [cone(P(*c), P(*mid), 0.05, 0.04, bone, blend=0.02, squash=(0.45, 1, 1), group="m%d" % i),
                     cone(P(*mid), P(*end), 0.04, 0.008, bone, blend=0.02, squash=(0.45, 1, 1), group="m%d" % i)]
        for x in (-0.03, 0.0, 0.03):
            top = V((x, 1.13, 2.0))
            mane.append(cone(P(*top), P(x * 1.4, 1.27, 1.8), 0.028, 0.006, "head", blend=0.015, squash=(0.6, 1, 1)))
        out.append(sdf_part(mane, 0.009, 760, "mane", "fur", smooth=1,
                            mask_fn=lambda co, n, p, d: (p * 0, np.ones(len(co)))))
        # The tail: a short dock, then a fall of hair in locks that part
        # and swing, following the dock bones down so a swish moves them.
        hair = [cone(P(*tail[i]), P(*tail[i + 1]), 0.06, 0.055, "tail%d" % (i + 1), blend=0.03, group="d")
                for i in range(2)]
        for j in range(8):
            a = 2 * math.pi * j / 8
            off = V((math.cos(a) * 0.04, math.sin(a) * 0.03, 0))
            pts = [V(tail[1]) + off * 0.5, V(tail[2]) + off * 1.3, V(tail[3]) + off * 1.9 + V((0, 0, rng.uniform(-0.03, 0.03))),
                   V(tail[4]) + off * 2.4 + V((0, 0.02 * math.sin(a * 3), -0.12 - rng.uniform(0, 0.12)))]
            for i in range(3):
                hair.append(cone(P(*pts[i]), P(*pts[i + 1]), 0.04 - 0.008 * i, 0.03 - 0.009 * i if i < 2 else 0.006,
                                 "tail%d" % (i + 2), blend=0.02, squash=(0.6, 1, 1), group="t%d" % j))
        out.append(sdf_part(hair, 0.009, 700, "tailhair", "fur", smooth=1,
                            mask_fn=lambda co, n, p, d: (p * 0, np.ones(len(co)))))
        jaw = [cone(P(0, 1.17, 1.72), P(0, 1.36, 1.41), 0.07, 0.05, "jaw", blend=0.02, squash=(0.8, 1, 1))]
        out.append(sdf_part(jaw, 0.008, 200, "jaw", "fur", smooth=1,
                            mask_fn=lambda co, n, p, d: (np.maximum(p, 0.4), d)))
        out += eye_pair(body_solids, (0.25, 1.18, 1.8), (-0.9, -0.2, 0.1), 0.02, colour=(0.035, 0.022, 0.018),
                        sink=0.01, squash=(1.0, 1.0, 0.8), h=0.005)
        # Nostrils: two dark ovals on the muzzle.
        for side in (1, -1):
            at = surface_point(body_solids, P(side * 0.04, 1.6, 1.46), P(0, -1, 0), sink=0.006)
            out.append(solid_part([ell(tuple(at), (0.016, 0.012, 0.024), "head", blend=0.004)],
                                  0.004, 60, "nostril", "horn", (0.04, 0.03, 0.03)))
        out += leaf_pair(L, "ear", 0.036, 0.008, (0.9, 0.42, 1.0), 0.006, tris=140, mask=(0, 0.3))
        out += hooves(L, 0.006, L["hoof"])
        return out

    return dict(name="beast_equine", archetype="equine", L=L, body=body, masks=masks, parts=parts,
                h=0.016, tris=3800,
                gait=dict(walk_stride=1.6, walk_frames=34, walk_duty=0.62, lift=0.14,
                          run_stride=2.6, run_frames=18, run_duty=0.36, run_lift=0.22,
                          gallop="transverse", wag=4.0, idle_wag=1, tail_pitch=0.0, lie=0.34, arch=4.0,
                          graze=dict(pitch=3.0, face=70.0, ground=0.02),
                          flex={"hind": dict(lean=8, push=15, fold=35, curl=45),
                                "fore": dict(lean=8, push=20, fold=80, curl=50, scap=10)}))


def spots(cell=0.05, seed=11):
    """Fine noise for a dappled or spotted coat: the same threshold that gives
    a cow her piebald gives a fallow deer her spots at this scale."""
    return lambda co: patch_noise(co, cell=cell, seed=seed)


def cervid():
    """A fallow deer, 0.85 m at the withers: long fine legs, a small head with
    big ears, a white rump and a short tail. Stags carry palmate antlers; the
    viewer collapses them for a doe."""
    L = dict(
        spine=[(0, -0.34, 0.8), (0, -0.11, 0.81), (0, 0.11, 0.81), (0, 0.28, 0.81)],
        neck=[(0, 0.36, 0.68), (0, 0.46, 0.88), (0, 0.53, 1.05)],
        nose=(0, 0.72, 0.92),
        jaw=[(0, 0.56, 0.98), (0, 0.7, 0.905)],
        tail=[(0, -0.43, 0.8), (0, -0.49, 0.76), (0, -0.52, 0.69)],
        hind=[(0.1, -0.3, 0.66), (0.12, -0.19, 0.46), (0.1, -0.38, 0.33),
              (0.09, -0.36, 0.09), (0.09, -0.31, 0.0)],
        fore=[(0.11, 0.39, 0.62), (0.1, 0.28, 0.51), (0.09, 0.3, 0.28),
              (0.085, 0.3, 0.08), (0.085, 0.35, 0.0)],
        scapula=(0.08, 0.23, 0.84),
        hoof=0.026,
        extra={"ear*": ((0.04, 0.54, 1.075), (0.09, 0.525, 1.15), "head"),
               "antler*": ((0.03, 0.55, 1.1), (0.08, 0.5, 1.28), "head")},
    )
    tail = L["tail"]
    body = [
        ell(P(0, 0.0, 0.63), (0.15, 0.34, 0.17), ("grad", "spine", "chest", P(0, -0.1, 0.63), P(0, 0.2, 0.63)), blend=0.06),
        ell(P(0, 0.26, 0.62), (0.12, 0.14, 0.16), "chest", blend=0.05),
        ell(P(0, 0.22, 0.78), (0.08, 0.14, 0.06), "chest", blend=0.05),
        ell(P(0, -0.3, 0.67), (0.14, 0.17, 0.16), ("grad", "pelvis", "spine", P(0, -0.35, 0.67), P(0, -0.05, 0.67)), blend=0.06),
        cone(P(0, 0.3, 0.7), P(0, 0.52, 1.02), 0.12, 0.068, ("chain", [("chest", P(0, 0.31, 0.58)), ("neck", P(0, 0.41, 0.78)),
                                                                     ("neck2", P(0, 0.495, 0.965)), ("head", P(0, 0.565, 1.135))]),
             blend=0.06, squash=(0.75, 1, 1)),
        ell(P(0, 0.56, 1.03), (0.064, 0.08, 0.068), "head", blend=0.035),
        cone(P(0, 0.58, 1.02), P(0, 0.7, 0.93), 0.052, 0.03, "head", blend=0.03, squash=(0.85, 1, 1)),
        ell(P(0, 0.7, 0.925), (0.034, 0.04, 0.034), "head", blend=0.02),
    ]
    for i in range(len(tail) - 1):
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), 0.04 - i * 0.008, 0.032 - i * 0.008, "tail%d" % (i + 1),
                         blend=0.02, group="tail", mask=(0.6, 0.0)))
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += leg_solids(L, "hind", [0.07, 0.042, 0.02, 0.019, 0.0], 0.04, side, mask_low=0.3, pastern=True)
        body += leg_solids(L, "fore", [0.058, 0.036, 0.019, 0.018, 0.0], 0.035, side, mask_low=0.3, pastern=True)
        body.append(ell(P(side * 0.09, -0.34, 0.56), (0.06, 0.13, 0.16), "thigh" + t, blend=0.05))
        body.append(ell(P(side * 0.1, 0.33, 0.56), (0.05, 0.08, 0.1), "upperarm" + t, blend=0.05))
        body.append(ell(P(side * 0.09, 0.27, 0.72), (0.05, 0.08, 0.1), "scapula" + t, blend=0.05))

    def masks(co, n, pale, dark):
        f = -co[:, 1]
        u = co[:, 2]
        under = np.clip((-n[:, 2] - 0.1) / 0.5, 0, 1) * (u < 0.62) * (f > -0.3) * (f < 0.4)
        rump = np.clip((-0.4 - f) / 0.04, 0, 1) * (u > 0.55) * (u < 0.78) * (np.abs(co[:, 0]) < 0.08)
        throat = np.clip((-n[:, 2] - 0.1) / 0.5, 0, 1) * (f > 0.45) * (u > 0.8)
        return np.maximum(pale, np.maximum(under, np.maximum(rump, throat))), dark

    def parts(body_solids):
        out = []
        jaw = [cone(P(0, 0.57, 0.975), P(0, 0.695, 0.905), 0.032, 0.018, "jaw", blend=0.012, squash=(0.8, 1, 0.9))]
        out.append(sdf_part(jaw, 0.004, 140, "jaw", "fur", smooth=1,
                            mask_fn=lambda co, n, p, d: (np.maximum(p, 0.6), d)))
        tip = surface_point(body_solids, P(0, 0.85, 0.93), P(0, -1, 0))
        out.append(solid_part([ell(tuple(tip + V((0, 0.006, 0.0))), (0.017, 0.01, 0.014), "head", blend=0.005)],
                              0.003, 90, "nose", "horn", (0.035, 0.03, 0.03)))
        out += eye_pair(body_solids, (0.15, 0.6, 1.04), (-0.9, -0.35, 0), 0.0135, colour=(0.05, 0.03, 0.02),
                        sink=0.006, h=0.003)
        out += leaf_pair(L, "ear", 0.03, 0.012, (1.0, 0.35, 1.0), 0.004, tris=160, mask=(0.15, 0.25))
        # Antlers: a beam sweeping up, back and out from the pedicle, a brow
        # tine forward over the eye, a tine off the middle and a fork at the
        # top. Branched rather than palmate: at any distance a deer is seen
        # from, points against the sky are what say "stag".
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            b = "antler" + t
            x = side
            beam = [(x * 0.03, 0.55, 1.1), (x * 0.07, 0.52, 1.2), (x * 0.11, 0.47, 1.3), (x * 0.12, 0.45, 1.4)]
            solids = [cone(P(*beam[i]), P(*beam[i + 1]), 0.013 - i * 0.002, 0.011 - i * 0.002, b, blend=0.006, group="beam")
                      for i in range(3)]
            solids += [cone(P(*beam[0]), P(x * 0.045, 0.63, 1.16), 0.008, 0.003, b, blend=0.008),
                       cone(P(*beam[1]), P(x * 0.09, 0.6, 1.27), 0.008, 0.003, b, blend=0.008),
                       cone(P(*beam[2]), P(x * 0.16, 0.52, 1.42), 0.007, 0.003, b, blend=0.008),
                       cone(P(*beam[3]), P(x * 0.1, 0.41, 1.47), 0.006, 0.002, b, blend=0.008)]
            out.append(solid_part(solids, 0.003, 360, "antler", "horn", (0.42, 0.34, 0.24)))
        out += hooves(L, 0.0025, L["hoof"], cloven=True, tris=90)
        return out

    return dict(name="beast_cervid", archetype="cervid", L=L, body=body, masks=masks, parts=parts,
                patch=spots(0.04), h=0.0075, tris=3200,
                gait=dict(walk_stride=0.85, walk_frames=30, walk_duty=0.62, lift=0.09,
                          run_stride=2.0, run_frames=16, run_duty=0.34, run_lift=0.16,
                          gallop="transverse", wag=6.0, idle_wag=2, tail_pitch=10.0, lie=0.17, arch=6.0,
                          graze=dict(pitch=4.0, face=75.0, ground=0.05, most=130.0),
                          flex={"hind": dict(lean=8, push=15, fold=40, curl=40),
                                "fore": dict(lean=8, push=20, fold=85, curl=45, scap=10)}))


def bovine():
    """A cow, 1.35 m at the withers and deep in the barrel: a broad flat
    forehead, a wet muzzle, ears carried out sideways, a dewlap, hooks and
    pins standing out at the hips, and a thin tail with a switch. Horns and
    udder are optional parts -- a bull keeps the one and not the other."""
    L = dict(
        spine=[(0, -0.7, 1.32), (0, -0.25, 1.33), (0, 0.2, 1.35), (0, 0.55, 1.34)],
        # Two neck bones from the root of the neck low in front of the
        # shoulder: one, from the withers, cannot put the muzzle on the grass.
        neck=[(0, 0.64, 1.02), (0, 0.79, 1.15), (0, 0.92, 1.26)],
        nose=(0, 1.36, 0.95),
        jaw=[(0, 1.02, 1.04), (0, 1.3, 0.9)],
        tail=[(0, -0.86, 1.36), (0, -0.93, 1.16), (0, -0.94, 0.92), (0, -0.94, 0.66)],
        hind=[(0.22, -0.62, 1.1), (0.25, -0.45, 0.78), (0.2, -0.72, 0.5),
              (0.18, -0.7, 0.14), (0.18, -0.61, 0.0)],
        fore=[(0.24, 0.7, 1.0), (0.22, 0.52, 0.8), (0.19, 0.56, 0.42),
              (0.18, 0.56, 0.13), (0.18, 0.64, 0.0)],
        scapula=(0.17, 0.45, 1.36),
        hoof=0.062,
        extra={"ear*": ((0.12, 0.99, 1.19), (0.24, 0.97, 1.15), "head"),
               "horn*": ((0.1, 0.99, 1.3), (0.22, 1.02, 1.4), "head"),
               "udder": ((0, -0.36, 0.78), (0, -0.36, 0.62), "pelvis")},
    )
    tail = L["tail"]
    body = [
        ell(P(0, -0.05, 1.0), (0.37, 0.72, 0.38), ("grad", "spine", "chest", P(0, -0.3, 1.0), P(0, 0.4, 1.0)), blend=0.14),
        ell(P(0, 0.55, 0.96), (0.3, 0.3, 0.36), "chest", blend=0.12),
        ell(P(0, 0.48, 1.24), (0.18, 0.28, 0.12), "chest", blend=0.1),
        ell(P(0, -0.62, 1.12), (0.33, 0.3, 0.27), ("grad", "pelvis", "spine", P(0, -0.7, 1.1), P(0, -0.2, 1.1)), blend=0.12),
        ell(P(0.24, -0.5, 1.24), (0.08, 0.1, 0.07), "pelvis", blend=0.12),
        ell(P(-0.24, -0.5, 1.24), (0.08, 0.1, 0.07), "pelvis", blend=0.12),
        ell(P(0.11, -0.82, 1.24), (0.06, 0.07, 0.06), "pelvis", blend=0.1),
        ell(P(-0.11, -0.82, 1.24), (0.06, 0.07, 0.06), "pelvis", blend=0.1),
        cone(P(0, 0.6, 1.08), P(0, 0.95, 1.18), 0.31, 0.2, ("chain", [("chest", P(0, 0.565, 0.955)), ("neck", P(0, 0.715, 1.085)),
                                                                    ("neck2", P(0, 0.855, 1.205)), ("head", P(0, 0.985, 1.315))]),
             blend=0.1, squash=(0.72, 1, 1)),
        # The dewlap: the loose fold of skin under the throat and brisket.
        ell(P(0, 0.74, 0.84), (0.08, 0.26, 0.2), ("grad", "chest", "neck", P(0, 0.6, 0.9), P(0, 0.9, 0.9)), blend=0.08),
        ell(P(0, 1.0, 1.2), (0.14, 0.13, 0.14), "head", blend=0.06),
        cone(P(0, 1.03, 1.16), P(0, 1.3, 0.96), 0.12, 0.1, "head", blend=0.05, squash=(0.88, 1, 1)),
        ell(P(0, 1.31, 0.94), (0.115, 0.085, 0.09), "head", blend=0.04, mask=(0.8, 0)),
    ]
    for i in range(len(tail) - 1):
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), 0.045 - i * 0.008, 0.037 - i * 0.008, "tail%d" % (i + 1),
                         blend=0.03, group="tail"))
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += leg_solids(L, "hind", [0.15, 0.1, 0.055, 0.055, 0.0], 0.1, side, mask_low=0.2, pastern=True)
        body += leg_solids(L, "fore", [0.14, 0.095, 0.055, 0.054, 0.0], 0.09, side, mask_low=0.2, pastern=True)
        body.append(ell(P(side * 0.22, -0.66, 0.92), (0.13, 0.22, 0.28), "thigh" + t, blend=0.1))
        body.append(ell(P(side * 0.23, 0.62, 0.86), (0.11, 0.15, 0.2), "upperarm" + t, blend=0.1))
        body.append(ell(P(side * 0.2, 0.5, 1.12), (0.09, 0.15, 0.17), "scapula" + t, blend=0.14))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        under = np.clip((-n[:, 2] - 0.3) / 0.5, 0, 1) * (u < 0.75)
        return np.maximum(pale, under * 0.5), dark

    def parts(body_solids):
        out = []
        # The switch: a tuft of long hair at the end of the tail.
        tip = L["tail"][-1]
        tuft = [ell(P(tip[0], tip[1], tip[2] - 0.05), (0.05, 0.05, 0.13), "tail3", blend=0.02)]
        out.append(sdf_part(tuft, 0.008, 120, "switch", "fur", smooth=1,
                            mask_fn=lambda co, n, p, d: (p * 0, np.ones(len(co)))))
        jaw = [cone(P(0, 1.03, 1.05), P(0, 1.27, 0.9), 0.08, 0.07, "jaw", blend=0.03, squash=(0.85, 1, 0.85))]
        out.append(sdf_part(jaw, 0.008, 200, "jaw", "fur", smooth=1,
                            mask_fn=lambda co, n, p, d: (np.maximum(p, 0.6), d)))
        for side in (1, -1):
            at = surface_point(body_solids, P(side * 0.05, 1.55, 0.95), P(0, -1, 0), sink=0.008)
            out.append(solid_part([ell(tuple(at), (0.022, 0.014, 0.02), "head", blend=0.004)],
                                  0.004, 60, "nostril", "horn", (0.05, 0.035, 0.035)))
        out += eye_pair(body_solids, (0.3, 1.05, 1.16), (-0.9, -0.4, 0), 0.022, colour=(0.035, 0.022, 0.018),
                        sink=0.01, h=0.005)
        out += leaf_pair(L, "ear", 0.06, 0.055, (1.0, 1.0, 0.3), 0.007, tris=160, mask=(0.1, 0.1))
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            x = side
            horn = [cone(P(x * 0.1, 0.99, 1.3), P(x * 0.2, 1.01, 1.36), 0.035, 0.026, "horn" + t, blend=0.008, group="h"),
                    cone(P(x * 0.2, 1.01, 1.36), P(x * 0.25, 1.06, 1.46), 0.026, 0.008, "horn" + t, blend=0.008, group="h")]
            out.append(solid_part(horn, 0.004, 160, "horn", "horn", (0.62, 0.56, 0.44)))
        udder = [ell(P(0, -0.36, 0.7), (0.14, 0.16, 0.11), "udder", blend=0.03)]
        for x in (0.05, -0.05):
            for f in (-0.3, -0.42):
                udder.append(cone(P(x, f, 0.66), P(x, f, 0.58), 0.018, 0.012, "udder", blend=0.015))
        out.append(solid_part(udder, 0.006, 260, "udder", "horn", (0.62, 0.42, 0.4)))
        out += hooves(L, 0.005, L["hoof"], cloven=True, tris=110)
        return out

    return dict(name="beast_bovine", archetype="bovine", L=L, body=body, masks=masks, parts=parts,
                patch=spots(0.16, seed=5), h=0.016, tris=3800,
                gait=dict(walk_stride=1.25, walk_frames=38, walk_duty=0.64, lift=0.1,
                          run_stride=1.9, run_frames=20, run_duty=0.38, run_lift=0.14,
                          gallop="transverse", wag=5.0, idle_wag=1, tail_pitch=0.0, lie=0.36, arch=4.0,
                          graze=dict(pitch=3.0, face=65.0, ground=0.05),
                          flex={"hind": dict(lean=8, push=14, fold=30, curl=35),
                                "fore": dict(lean=8, push=18, fold=70, curl=40, scap=10)}))


def pig():
    """A farm pig, 0.72 m at the shoulder: a barrel on short legs, no neck to
    speak of, a long snout ending in a flat disc, ears flopped forward and a
    curl of a tail. A boar is this in a dark bristled coat with tusks."""
    L = dict(
        spine=[(0, -0.42, 0.66), (0, -0.14, 0.69), (0, 0.14, 0.69), (0, 0.36, 0.65)],
        # The neck's root low in the chest, where the head goes down from to
        # root; at the top of the shoulder it could only fold into it.
        neck=[(0, 0.38, 0.47), (0, 0.53, 0.58)],
        nose=(0, 0.87, 0.44),
        jaw=[(0, 0.58, 0.46), (0, 0.8, 0.405)],
        tail=[(0, -0.55, 0.63), (0.015, -0.6, 0.66), (0.04, -0.625, 0.62), (0.02, -0.61, 0.575)],
        hind=[(0.13, -0.36, 0.5), (0.15, -0.26, 0.33), (0.13, -0.4, 0.18),
              (0.12, -0.38, 0.06), (0.12, -0.33, 0.0)],
        fore=[(0.14, 0.32, 0.44), (0.13, 0.22, 0.3), (0.12, 0.25, 0.16),
              (0.12, 0.25, 0.06), (0.12, 0.3, 0.0)],
        scapula=(0.1, 0.2, 0.66),
        hoof=0.032,
        extra={"ear*": ((0.07, 0.58, 0.66), (0.13, 0.7, 0.63), "head"),
               "tusk*": ((0.04, 0.76, 0.43), (0.06, 0.79, 0.49), "jaw"),
               # A wild boar's bristle crest, one bone a stretch of back so it
               # bends with the neck when it roots; a farm pig collapses all four.
               "mane1": ((0, 0.47, 0.6), (0, 0.5, 0.64), "neck"),
               "mane2": ((0, 0.24, 0.66), (0, 0.26, 0.7), "chest"),
               "mane3": ((0, 0.0, 0.67), (0, 0.02, 0.71), "spine"),
               "mane4": ((0, -0.26, 0.65), (0, -0.24, 0.69), "pelvis")},
    )
    tail = L["tail"]
    body = [
        ell(P(0, 0.0, 0.47), (0.26, 0.5, 0.26), ("grad", "spine", "chest", P(0, -0.2, 0.47), P(0, 0.25, 0.47)), blend=0.1),
        ell(P(0, 0.3, 0.46), (0.22, 0.2, 0.23), "chest", blend=0.08),
        ell(P(0, -0.34, 0.5), (0.24, 0.2, 0.24), "pelvis", blend=0.08),
        cone(P(0, 0.36, 0.5), P(0, 0.54, 0.52), 0.22, 0.17, ("chain", [("chest", P(0, 0.3, 0.42)), ("neck", P(0, 0.455, 0.525)),
                                                                     ("head", P(0, 0.61, 0.635))]), blend=0.08),
        ell(P(0, 0.58, 0.52), (0.15, 0.14, 0.14), "head", blend=0.06),
        cone(P(0, 0.62, 0.5), P(0, 0.84, 0.44), 0.1, 0.058, "head", blend=0.05, squash=(0.95, 1, 1)),
    ]
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += leg_solids(L, "hind", [0.1, 0.06, 0.035, 0.033, 0.0], 0.06, side, pastern=True)
        body += leg_solids(L, "fore", [0.09, 0.055, 0.034, 0.032, 0.0], 0.05, side, pastern=True)
        body.append(ell(P(side * 0.14, -0.36, 0.38), (0.1, 0.17, 0.18), "thigh" + t, blend=0.07))
        body.append(ell(P(side * 0.14, 0.26, 0.36), (0.09, 0.12, 0.14), "upperarm" + t, blend=0.07))

    def masks(co, n, pale, dark):
        u = co[:, 2]
        f = -co[:, 1]
        under = np.clip((-n[:, 2] - 0.2) / 0.5, 0, 1) * (u < 0.45)
        ridge = np.clip((n[:, 2] - 0.8) / 0.2, 0, 1) * (u > 0.62) * (f > -0.3) * (f < 0.5)
        return np.maximum(pale, under * 0.7), np.maximum(dark, ridge)

    def parts(body_solids):
        out = []
        jaw = [cone(P(0, 0.6, 0.46), P(0, 0.8, 0.41), 0.075, 0.035, "jaw", blend=0.02, squash=(0.85, 1, 0.8))]
        out.append(sdf_part(jaw, 0.006, 160, "jaw", "fur", smooth=1))
        tip = surface_point(body_solids, P(0, 1.1, 0.44), P(0, -1, 0))
        disc = [ell(tuple(tip + V((0, 0.004, 0))), (0.058, 0.014, 0.047), "head", blend=0.006)]
        out.append(solid_part(disc, 0.004, 140, "snout", "horn", (0.62, 0.4, 0.38)))
        for side in (1, -1):
            out.append(solid_part([ell(tuple(tip + V((side * 0.02, -0.006, 0.002))), (0.01, 0.006, 0.015), "head", blend=0.003)],
                                  0.003, 40, "nostril", "horn", (0.12, 0.06, 0.06)))
        out += eye_pair(body_solids, (0.2, 0.68, 0.56), (-0.9, -0.3, 0), 0.0115, colour=(0.05, 0.03, 0.025),
                        sink=0.006, h=0.003)
        out += leaf_pair(L, "ear", 0.075, 0.03, (1.0, 1.0, 0.3), 0.006, tris=160)
        curl = [cone(P(*tail[i]), P(*tail[i + 1]), 0.017, 0.013, "tail%d" % (i + 1), blend=0.006, group="t")
                for i in range(len(tail) - 1)]
        out.append(sdf_part(curl, 0.004, 140, "tail", "fur", smooth=1))
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            head, tail_, _ = L["extra"]["tusk*"]
            a, b = apply_side(head, side), apply_side(tail_, side)
            out.append(solid_part([cone(P(*a), P(*b), 0.011, 0.003, "tusk" + t, blend=0.004)], 0.003, 60,
                                  "tusk", "horn", (0.8, 0.76, 0.66)))
        out += hooves(L, 0.003, L["hoof"], cloven=True, tris=90)
        # The crest: stiff bristles standing up along the spine, longest over
        # the shoulders and the nape, each root sunk into the skin.
        bristles = []
        for i in range(30):
            f = 0.56 - i * 0.03
            top = surface_point(body_solids, P(0, f, 1.2), P(0, 0, -1), sink=0.03)
            length = 0.05 + 0.07 * math.exp(-((f - 0.35) / 0.22) ** 2)
            bone = "mane1" if f > 0.4 else "mane2" if f > 0.12 else "mane3" if f > -0.14 else "mane4"
            for k in (-1, 1):
                lean = V((k * 0.012, 0.025, 0))
                bristles.append(cone(tuple(top + V((k * 0.008, 0, 0))), tuple(top + V((0, 0, length)) + lean), 0.018, 0.004, bone,
                                     blend=0.008, mask=(0, 0.9), group="b%d%d" % (i, k)))
        out.append(sdf_part(bristles, 0.004, 900, "mane", "fur", smooth=1))
        return out

    return dict(name="beast_pig", archetype="pig", L=L, body=body, masks=masks, parts=parts,
                h=0.009, tris=3000,
                gait=dict(walk_stride=0.55, walk_frames=24, walk_duty=0.64, lift=0.05,
                          run_stride=1.2, run_frames=14, run_duty=0.38, run_lift=0.08,
                          gallop="transverse", wag=8.0, idle_wag=2, tail_pitch=0.0, lie=0.24, arch=4.0,
                          graze=dict(pitch=4.0, face=60.0, ground=0.01, chew=4.0, tug=3.0, most=120.0),
                          pastimes=["root"],
                          flex={"hind": dict(lean=8, push=15, fold=35, curl=35),
                                "fore": dict(lean=8, push=18, fold=70, curl=40, scap=8)}))


# ============================================================ birds
#
# The wings are modelled folded, lying along the body with the primaries
# crossed over the tail, which is how a bird is seen almost all of the time.
# Two bones a wing: the arm from the shoulder to the wrist, and the hand from
# the wrist to the wing tip. Flight swings the folded wing out and flaps it,
# which reads as a wing at any distance a bird is flying at.


WING = ("wing1", "wing2")


def bird_bones(L):
    b = [("body", P(*L["body"][0]), P(*L["body"][1]), None)]
    parent = "body"
    for i in range(len(L["neck"]) - 1):
        name = "neck" if i == 0 else "neck%d" % (i + 1)
        b.append((name, P(*L["neck"][i]), P(*L["neck"][i + 1]), parent))
        parent = name
    b.append(("head", P(*L["neck"][-1]), P(*L["beak"]), parent))
    b.append(("tail1", P(*L["tail"][0]), P(*L["tail"][1]), "body"))
    for side, tag in ((1, ".L"), (-1, ".R")):
        pts = [apply_side(p, side) for p in L["wing"]]
        parent = "body"
        for i, n in enumerate(WING):
            b.append((n + tag, P(*pts[i]), P(*pts[i + 1]), parent))
            parent = n + tag
        pts = [apply_side(p, side) for p in L["hind"]]
        parent = "body"
        for i, n in enumerate(LEG_BONES["hind"]):
            b.append((n + tag, P(*pts[i]), P(*pts[i + 1]), parent))
            parent = n + tag
    for bone, (head, tail_, parent_) in L.get("extra", {}).items():
        b.append((bone, P(*head), P(*tail_), parent_))
    return b


def bird_legs():
    return {k: v for k, v in quad_legs().items() if k.startswith("hind")}


def wing_solids(L, side, spec):
    """A folded wing: a slab lying on the flank from the shoulder back, thin
    across, tilted out at the bottom the way the body curves away, and the
    primaries as a tapering blade crossing over the rump. Dark towards the tip."""
    t = ".L" if side > 0 else ".R"
    sh, wr, tip = [V(apply_side(p, side)) for p in L["wing"]]  # (side, forward, up)
    depth, thick = spec["chord"], spec["thick"]
    tilt = spec.get("tilt", 18.0) * side
    mid = sh.lerp(wr, 0.55)
    arm = (wr - sh).length
    out = [ell(P(mid.x, mid.y, mid.z - depth * 0.35), (thick, arm * 0.62, depth * 0.62),
               ("grad", "wing1" + t, "wing2" + t, P(*sh), P(*tip)), blend=thick * 1.5,
               rot=(0, -tilt, 0), mask=(0, 0.1))]
    blade_mid = wr.lerp(tip, 0.5)
    span = (tip - wr).length
    out.append(ell(P(blade_mid.x, blade_mid.y, blade_mid.z - depth * 0.12), (thick * 0.8, span * 0.62, depth * 0.33),
                   "wing2" + t, blend=thick * 1.5, rot=(0, -tilt * 0.6, 0), mask=(0, spec.get("tipdark", 0.7))))
    return out


def bird_leg_parts(L, spec):
    """Scaly legs and toes in `horn`: the tarsus, three toes forward and one
    back, and for waterfowl a web between the front three."""
    out = []
    r = spec["leg_r"]
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        pts = [V(apply_side(p, side)) for p in L["hind"]]  # (side, forward, up)
        knee, ankle, foot, tip = pts[1], pts[2], pts[3], pts[4]
        toe_len = (tip - foot).length
        solids = [cone(P(*ankle), P(*foot), r, r * 0.85, "hock" + t, blend=r, group="leg")]
        if spec.get("shin_bare"):
            solids.append(cone(P(*knee.lerp(ankle, 0.4)), P(*ankle), r * 1.15, r, "shin" + t, blend=r, group="leg"))
        for k in (0, 1, -1):
            a = math.radians(30.0) * k
            end = (foot.x + math.sin(a) * toe_len, foot.y + math.cos(a) * toe_len, r * 0.5)
            solids.append(cone(P(*foot), P(*end), r * 0.8, r * 0.4, "htoe" + t, blend=r * 0.6, group="t%d" % k))
        solids.append(cone(P(*foot), P(foot.x, foot.y - toe_len * 0.4, r * 0.5), r * 0.7, r * 0.4,
                           "htoe" + t, blend=r * 0.6, group="back"))
        if spec.get("web"):
            solids.append(ell(P(foot.x, foot.y + toe_len * 0.55, r * 0.45),
                              (toe_len * 0.5, toe_len * 0.45, r * 0.3), "htoe" + t, blend=r * 0.8))
        out.append(solid_part(solids, spec["leg_h"], spec.get("leg_tris", 260), "leg", "horn", spec["leg_colour"]))
    return out


def head_mask(L):
    """B channel for birds: the head and upper neck. The viewer thresholds it
    the way it thresholds a patch, so a mallard drake's head goes green and a
    duck's stays brown."""
    head = V(L["neck"][-1])
    size = (V(L["beak"]) - head).length

    def fn(co):
        f = -co[:, 1]
        u = co[:, 2]
        d = np.sqrt((f - head.y) ** 2 + (u - head.z) ** 2 + co[:, 0] ** 2)
        return np.clip(1.4 - d / (size * 1.25), 0, 1)
    return fn


def bird(L, spec):
    """Shared assembly for every bird: body solids from the spec, wings,
    beak, eyes, legs, and whatever extras (comb, wattles, knob) it adds."""
    body = list(spec["body"])
    neck = L["neck"]
    for i in range(len(neck) - 1):
        name = "neck" if i == 0 else "neck%d" % (i + 1)
        r0, r1 = spec["neck_r"][i], spec["neck_r"][i + 1]
        body.append(cone(P(*neck[i]), P(*neck[i + 1]), r0, r1, name, blend=spec["neck_blend"], group="neck"))

    def parts(body_solids):
        out = []
        for side in (1, -1):
            out.append(sdf_part(wing_solids(L, side, spec), spec["wing_h"], spec["wing_tris"], "wing",
                                spec.get("mat", "feather"), smooth=1, patch_fn=lambda co: np.zeros(len(co))))
        out.append(solid_part(spec["beak"], spec["beak_h"], spec.get("beak_tris", 220), "beak", "horn",
                              spec["beak_colour"]))
        out += eye_pair(body_solids, spec["eye"][0], spec["eye"][1], spec["eye"][2],
                        colour=spec.get("eye_colour", (0.03, 0.02, 0.02)), sink=spec["eye"][3],
                        h=spec["eye"][4], tris=60)
        out += bird_leg_parts(L, spec)
        for (solids, h, tris, colour) in spec.get("extras", []):
            out.append(solid_part(solids, h, tris, "extra", "horn", colour))
        return out

    return dict(name=spec["name"], archetype=spec["archetype"], L=L, bones=bird_bones(L), body=body,
                masks=spec.get("masks"), parts=parts, patch=head_mask(L), h=spec["h"], tris=spec["tris"],
                mat=spec.get("mat", "feather"), gait=spec["gait"], clips=bird_clips)


def duck():
    """A mallard, 0.35 m long: a boat of a body, a short neck, a flat bill,
    legs set far back. The duckling, the goose and the hen mallard are this
    at other scales and colours."""
    L = dict(
        body=[(0, -0.13, 0.19), (0, 0.1, 0.18)],
        neck=[(0, 0.1, 0.2), (0, 0.128, 0.262), (0, 0.142, 0.31)],
        beak=(0, 0.245, 0.293),
        tail=[(0, -0.13, 0.19), (0, -0.2, 0.21)],
        wing=[(0.06, 0.08, 0.215), (0.078, -0.035, 0.226), (0.05, -0.2, 0.222)],
        hind=[(0.035, -0.03, 0.15), (0.045, 0.01, 0.11), (0.045, -0.02, 0.068),
              (0.045, -0.005, 0.012), (0.045, 0.05, 0.004)],
    )
    body = [
        ell(P(0, -0.01, 0.175), (0.086, 0.165, 0.074), "body", blend=0.03),
        ell(P(0, 0.075, 0.172), (0.076, 0.072, 0.074), "body", blend=0.03, mask=(0.8, 0)),
        ell(P(0, -0.1, 0.165), (0.064, 0.08, 0.052), "body", blend=0.03),
        cone(P(0, -0.12, 0.19), P(0, -0.205, 0.212), 0.04, 0.012, "tail1", blend=0.025, squash=(1, 1, 0.55),
             mask=(0, 0.7)),
        ell(P(0, 0.152, 0.315), (0.029, 0.041, 0.031), "head", blend=0.015),
        ell(P(0, 0.162, 0.303), (0.027, 0.03, 0.024), "head", blend=0.012),
    ]

    def masks(co, n, pale, dark):
        u = co[:, 2]
        f = -co[:, 1]
        under = np.clip((-n[:, 2] - 0.1) / 0.5, 0, 1) * (u < 0.19)
        return np.maximum(pale * (f > 0.02), under * 0.6), dark

    beak = [cone(P(0, 0.17, 0.307), P(0, 0.24, 0.292), 0.019, 0.015, "head", blend=0.008, squash=(1.1, 1, 0.42)),
            ell(P(0, 0.238, 0.294), (0.012, 0.008, 0.005), "head", blend=0.004)]
    return bird(L, dict(
        name="beast_duck", archetype="waterfowl", body=body, masks=masks, h=0.0032, tris=2200,
        neck_r=(0.036, 0.03, 0.028), neck_blend=0.02,
        chord=0.075, thick=0.011, wing_h=0.0026, wing_tris=300, tipdark=0.6,
        beak=beak, beak_h=0.0018, beak_colour=(0.62, 0.52, 0.12),
        eye=((0.05, 0.172, 0.322), (-0.95, -0.2, 0.0), 0.0058, 0.0026, 0.0012),
        leg_r=0.0055, leg_h=0.0018, leg_colour=(0.78, 0.36, 0.08), web=True, shin_bare=True,
        gait=dict(walk_stride=0.14, walk_frames=18, lift=0.03, swim_stride=0.16, swim_frames=24,
                  waterline=0.14, kind="waterfowl", fly_frames=10),
    ))


def wings(open_=0.0, flap=0.0, lift=0.0):
    """Wing angles for both sides. At open_=0 the wings are folded, which is
    the rest pose; at 1 they are swung out level with the body. `flap` pitches
    the whole wing up (positive) or down; `lift` raises the folded wing off
    the back without opening it -- a swan's threat."""
    fk = {}
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        s = side
        fk["wing1" + t] = (lift * 30 + flap * open_, -s * 85 * open_, s * -80 * open_ + s * lift * 25)
        fk["wing2" + t] = (0, -s * 10 * open_, 0)
    return fk


def both_wings(k=1.0, spread=0.0, flap=0.0):
    return wings(open_=1.0 - k, flap=flap)


def bird_clips(arm, spec):
    g = spec["gait"]
    poser = Poser(arm, bird_legs())
    rest = leg_rest(poser)
    clip = Clip(poser)
    bones = {b.name for b in arm.data.bones}
    necks = [n for n in ("neck", "neck2", "neck3", "neck4") if n in bones]
    height = poser.rest["body"].translation.z
    report = {"clips": {}, "stride": {}}
    kind = g["kind"]
    legs = {"hind.L": 0.0, "hind.R": 0.5}
    flex = {"hind": dict(lean=10, push=20, fold=40, curl=50)}

    def head_look(t, amp=25, jerk=True):
        # Birds do not turn their heads smoothly; they fix, then snap.
        steps = [0.0, 0.18, 0.37, 0.55, 0.74, 0.9, 1.0]
        yaws = [0, amp, -amp * 0.5, amp * 0.3, -amp, 0, 0]
        for i in range(len(steps) - 1):
            if steps[i] <= t <= steps[i + 1]:
                x = (t - steps[i]) / (steps[i + 1] - steps[i])
                x = min(1.0, x * 6) if jerk else x
                return lerp(yaws[i], yaws[i + 1], ease(x))
        return 0.0

    def idle(t, afloat=False):
        breath = wave(4 * t)
        yaw = head_look(t)
        fk = wings()
        fk["body"] = (0.6 * breath, 0, 0)
        for n in necks:
            fk[n] = (2 * wave(2 * t), yaw * 0.25 / len(necks), 0)
        fk["head"] = (3 * wave(2 * t, 0.3), yaw * 0.75, 0)
        fk["tail1"] = (4 * max(0, math.sin(2 * math.pi * (3 * t))) ** 8, 12 * math.exp(-((t - 0.6) * 25) ** 2), 0)
        if afloat:
            drop = g["waterline"] - 0.06
            loc = V((0, 0, -drop + 0.004 * wave(2 * t)))
            ik = {leg: planted(rest, leg, fwd=0.02 * wave(t, 0.25 * (leg == "hind.R")), up=-drop * 0.3, meta=30, toe=40)
                  for leg in rest}
            fk["body"] = (0.8 * wave(2 * t), 0, 1.2 * wave(t))
        else:
            loc = V((0, 0, 0.002 * breath))
            ik = {leg: planted(rest, leg) for leg in rest}
        return dict(fk=fk, loc=loc, ik=ik)
    clip.run("idle", 120, idle, step=2)
    if kind == "waterfowl":
        clip.run("float", 120, lambda t: idle(t, afloat=True), step=2)

    # -- walk: a waddle (waterfowl, hens) or a hop (small birds).
    S, N = g["walk_stride"], g["walk_frames"]
    if kind == "hopper":
        def walk(t):
            # Two hops a cycle. On the ground the feet stay put in the world,
            # which means that in the body's frame they -- and the body over
            # them -- slide back at the travel speed; in the air the body
            # catches up with a parabola and the feet swing through under it.
            p = (2 * t) % 1.0
            ground = 0.55
            half = S / 2
            if p < ground:
                x = p / ground
                off = half * 0.5 - half * x  # forward offset of the body from its mean
                lift = 0.0
                crouch = math.sin(math.pi * x) * 0.3
            else:
                x = (p - ground) / (1 - ground)
                off = -half * 0.5 + half * ease(x)
                lift = 4 * x * (1 - x) * S * 0.35
                crouch = 0.0
            loc = V((0, -off, lift - crouch * height * 0.15))
            ik = {}
            for leg in rest:
                if p < ground:
                    ik[leg] = planted(rest, leg, fwd=-off + off, up=0)
                else:
                    ik[leg] = planted(rest, leg, fwd=-off + off, up=lift * 0.9, meta=-15, toe=30)
            fk = wings()
            fk["tail1"] = (-10 * (lift / max(1e-6, S * 0.35)), 0, 0)
            fk["head"] = (-6 * math.sin(2 * math.pi * p), 0, 0)
            return dict(fk=fk, loc=loc, ik=ik)
        tracks = clip.run("walk", N, walk)
    else:
        def walk(t):
            ik, st = gait_targets(rest, t, S, 0.6, g["lift"], legs, flex)
            roll = g.get("waddle", 7.0)
            fk = wings()
            fk["body"] = (0, 3 * wave(t), roll * wave(t, 0.25))
            bob = wave(2 * t, 0.1)
            for n in necks:
                fk[n] = (4 * bob, -2 * wave(t), -roll * 0.4 * wave(t, 0.25))
            fk["head"] = (g.get("head_bob", 4) * bob, -1 * wave(t), -roll * 0.5 * wave(t, 0.25))
            fk["tail1"] = (0, 8 * wave(t, 0.4), 0)
            loc = V((0.01 * height * wave(t, 0.25), 0, -0.012 * height + 0.02 * height * wave(2 * t, 0.2)))
            return dict(fk=fk, loc=loc, ik=ik)
        tracks = clip.run("walk", N, walk, track={leg: poser.legs[leg]["chain"][3] for leg in poser.legs})
        report["walk"] = foot_slip(tracks, S, N, 0.6, legs)
    report["stride"]["walk"] = S

    if "run_stride" in g:
        S2, N2 = g["run_stride"], g["run_frames"]

        def run(t):
            ik, st = gait_targets(rest, t, S2, 0.45, g["lift"] * 1.5, legs, flex)
            fk = wings(open_=0.15, flap=10 * wave(2 * t))
            fk["body"] = (-8, 3 * wave(t), 5 * wave(t, 0.25))
            for n in necks:
                fk[n] = (-10, 0, 0)
            fk["head"] = (12 + 5 * wave(2 * t), 0, 0)
            loc = V((0, 0, -0.03 * height + 0.03 * height * wave(2 * t, 0.2)))
            return dict(fk=fk, loc=loc, ik=ik)
        tracks = clip.run("run", N2, run, track={leg: poser.legs[leg]["chain"][3] for leg in poser.legs})
        report["run"] = foot_slip(tracks, S2, N2, 0.45, legs)
        report["stride"]["run"] = S2

    if kind == "waterfowl":
        S3, N3 = g["swim_stride"], g["swim_frames"]
        drop = g["waterline"] - 0.06

        def swim(t):
            # Paddling: each foot pushes back flat and webbed, then comes
            # forward folded -- out of phase, under the body, in the water.
            ik = {}
            for leg, off in legs.items():
                p = (t + off) % 1.0
                power = p < 0.5
                x = p / 0.5 if power else (p - 0.5) / 0.5
                fwd = S3 * (0.6 - 1.2 * x) if power else S3 * (-0.6 + 1.2 * ease(x))
                ik[leg] = planted(rest, leg, fwd=fwd * 0.6, up=-drop * 0.2 + (0.0 if power else height * 0.08),
                                  meta=25 + (0 if power else 25), toe=(0 if power else 70))
            fk = wings()
            fk["body"] = (-2 + 1.2 * wave(2 * t), 0, 1.5 * wave(t))
            for n in necks:
                fk[n] = (1.5 * wave(2 * t, 0.2), 0, 0)
            fk["head"] = (-2 + 1.5 * wave(2 * t, 0.3), 0, 0)
            fk["tail1"] = (0, 5 * wave(t), 0)
            loc = V((0, 0, -drop + 0.004 * wave(2 * t)))
            return dict(fk=fk, loc=loc, ik=ik)
        clip.run("swim", N3, swim)
        report["stride"]["swim"] = S3

    # -- fly: flapping, legs tucked, lifted clear of the ground.
    NF = g.get("fly_frames", 10)
    hover = height * g.get("hover", 1.6)

    def fly(t):
        beat = wave(t)
        fk = wings(open_=1.0, flap=40 * beat)
        for side in (1, -1):
            tag = ".L" if side > 0 else ".R"
            # The hand lags the arm: it is still coming up as the arm starts down.
            fk["wing2" + tag] = (22 * wave(t, -0.15), -side * 10, 0)
        fk["body"] = (-6, 0, 0)
        for n in necks:
            fk[n] = (-6, 0, 0)
        fk["head"] = (8, 0, 0)
        fk["tail1"] = (-8 + 4 * beat, 0, 0)
        loc = V((0, 0, hover + height * 0.08 * wave(t, 0.25)))
        ik = {leg: planted(rest, leg, fwd=-0.25 * height, up=hover + height * 0.35, meta=60, toe=70)
              for leg in rest}
        return dict(fk=fk, loc=loc, ik=ik)
    clip.run("fly", NF, fly)

    # -- attack: a peck (a swan also half-opens its wings and hisses).
    threat = g.get("threat", 0.0)

    def attack(t):
        cock = ease(t / 0.3) * (1 - ease((t - 0.3) / 0.15))
        strike = ease((t - 0.3) / 0.2) * (1 - ease((t - 0.6) / 0.4))
        threat_k = threat * (ease(t / 0.25) * (1 - ease((t - 0.7) / 0.3)))
        fk = wings(open_=0.0, lift=threat_k)
        fk["body"] = (-4 * cock + 14 * strike, 0, 0)
        for n in necks:
            fk[n] = (-18 * cock + 22 * strike, 0, 0)
        fk["head"] = (-10 * cock + 25 * strike, 0, 0)
        fk["tail1"] = (10 * strike, 0, 0)
        loc = V((0, height * 0.12 * cock - height * 0.18 * strike, 0))
        return dict(fk=fk, loc=loc, ik={leg: planted(rest, leg) for leg in rest})
    clip.run("attack", 21, attack)
    report["hit"] = 0.5

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.35)) if t < 0.35 else (1 - ease((t - 0.35) / 0.65)) * 0.8
        fk = wings(open_=0.3 * k, flap=20 * k)
        fk["body"] = (-10 * k, 0, 6 * k)
        for n in necks:
            fk[n] = (-12 * k, 10 * k, 0)
        fk["head"] = (-15 * k, 12 * k, 0)
        loc = V((0, height * 0.12 * k, height * 0.05 * k))
        return dict(fk=fk, loc=loc, ik={leg: planted(rest, leg) for leg in rest})
    clip.run("hit", 11, hit)

    lie = g.get("lie", height * 0.45)
    root_h = poser.rest["body"].translation.z

    def death(t):
        buckle = ease(t / 0.3)
        roll = ease((t - 0.2) / 0.45)
        settle = ease((t - 0.55) / 0.45)
        fk = wings()
        # The neck goes down to the ground on the side it fell towards.
        for n in necks:
            fk[n] = (20 * settle, -40 * settle / len(necks), 0)
        fk["head"] = (-10 * settle, -15 * settle, 0)
        fk["tail1"] = (-10 * settle, 0, 0)
        for leg, info in poser.legs.items():
            up, lo, meta, toe = info["chain"]
            fk[up] = (-20, 0, 0)
            fk[lo] = (30, 0, 0)
            fk[meta] = (-40, 0, 0)
            fk[toe] = (60, 0, 0)
        loc = V((0, 0, lerp(0.0, -(root_h - lie), roll) - height * 0.2 * buckle * (1 - roll)))
        rot = mathutils.Quaternion(V((0, 1, 0)), math.radians(85 * roll))
        return dict(fk=fk, loc=loc, rot=rot, ik={leg: planted(rest, leg) for leg in rest},
                    limp=ease((t - 0.15) / 0.3))
    clip.run("death", 45, death)

    report["clips"] = clip.report
    report["overreach"] = clip.reach
    return report


def swan():
    """A mute swan, 1.5 m from bill to tail: the long S of the neck, the black
    knob over an orange bill, and wings carried a little raised over the back.
    Almost always seen on water, so `float` and `swim` are its idle and walk."""
    L = dict(
        body=[(0, -0.34, 0.44), (0, 0.24, 0.42)],
        neck=[(0, 0.24, 0.46), (0, 0.33, 0.6), (0, 0.35, 0.76), (0, 0.31, 0.9), (0, 0.34, 0.99)],
        beak=(0, 0.475, 0.945),
        tail=[(0, -0.34, 0.44), (0, -0.47, 0.48)],
        wing=[(0.15, 0.17, 0.5), (0.18, -0.12, 0.54), (0.12, -0.47, 0.53)],
        hind=[(0.08, -0.08, 0.36), (0.1, 0.0, 0.27), (0.1, -0.07, 0.15),
              (0.1, -0.04, 0.022), (0.1, 0.1, 0.008)],
    )
    body = [
        ell(P(0, -0.04, 0.41), (0.2, 0.4, 0.155), "body", blend=0.06),
        ell(P(0, 0.17, 0.4), (0.17, 0.16, 0.15), "body", blend=0.06),
        ell(P(0, -0.27, 0.42), (0.14, 0.16, 0.12), "body", blend=0.05),
        cone(P(0, -0.3, 0.44), P(0, -0.48, 0.48), 0.09, 0.03, "tail1", blend=0.05, squash=(1, 1, 0.5)),
        ell(P(0, 0.35, 1.0), (0.043, 0.068, 0.048), "head", blend=0.03),
    ]
    beak = [cone(P(0, 0.385, 0.99), P(0, 0.47, 0.948), 0.03, 0.019, "head", blend=0.01, squash=(0.9, 1, 0.62), group="b"),
            ell(P(0, 0.468, 0.95), (0.015, 0.012, 0.01), "head", blend=0.005)]
    knob = [ell(P(0, 0.385, 1.003), (0.02, 0.028, 0.022), "head", blend=0.008)]
    return bird(L, dict(
        name="beast_swan", archetype="waterfowl", body=body, h=0.007, tris=2600,
        masks=lambda co, n, p, d: (p, d),
        neck_r=(0.075, 0.056, 0.046, 0.043, 0.04), neck_blend=0.03,
        chord=0.19, thick=0.025, tilt=24.0, wing_h=0.006, wing_tris=340, tipdark=0.0,
        beak=beak, beak_h=0.004, beak_colour=(0.85, 0.3, 0.05),
        eye=((0.08, 0.395, 1.0), (-0.95, -0.25, 0.0), 0.0085, 0.004, 0.002),
        leg_r=0.013, leg_h=0.004, leg_colour=(0.1, 0.1, 0.1), web=True, shin_bare=True,
        extras=[(knob, 0.004, 120, (0.04, 0.035, 0.035))],
        gait=dict(walk_stride=0.34, walk_frames=28, lift=0.06, swim_stride=0.45, swim_frames=36,
                  waterline=0.34, kind="waterfowl", fly_frames=20, hover=1.3, threat=1.0,
                  waddle=6.0, head_bob=2.0, lie=0.16),
    ))


def hen():
    """A hen, 0.4 m tall: a round body tipped up at a fan of tail, drumsticks,
    yellow legs, a red comb and wattles. The head bobs as she walks -- it holds
    still in the world while the body catches up."""
    L = dict(
        body=[(0, -0.11, 0.26), (0, 0.09, 0.25)],
        neck=[(0, 0.08, 0.28), (0, 0.105, 0.35), (0, 0.113, 0.4)],
        beak=(0, 0.178, 0.39),
        tail=[(0, -0.11, 0.28), (0, -0.16, 0.36)],
        wing=[(0.062, 0.06, 0.3), (0.078, -0.045, 0.3), (0.055, -0.13, 0.29)],
        hind=[(0.04, -0.01, 0.2), (0.05, 0.03, 0.155), (0.05, -0.01, 0.1),
              (0.05, 0.005, 0.012), (0.05, 0.058, 0.004)],
    )
    body = [
        ell(P(0, -0.01, 0.25), (0.085, 0.13, 0.095), "body", blend=0.03),
        ell(P(0, 0.06, 0.25), (0.075, 0.07, 0.085), "body", blend=0.03),
        cone(P(0, -0.09, 0.28), P(0, -0.17, 0.39), 0.045, 0.06, "tail1", blend=0.03, squash=(0.35, 1, 1),
             mask=(0, 0.45)),
        ell(P(0.045, 0.0, 0.17), (0.034, 0.042, 0.05), "shin.L", blend=0.025),
        ell(P(-0.045, 0.0, 0.17), (0.034, 0.042, 0.05), "shin.R", blend=0.025),
        ell(P(0, 0.12, 0.405), (0.027, 0.034, 0.03), "head", blend=0.015),
    ]
    beak = [cone(P(0, 0.138, 0.401), P(0, 0.178, 0.388), 0.012, 0.003, "head", blend=0.005, squash=(0.85, 1, 1))]
    comb = [ell(P(0, 0.122, 0.44), (0.006, 0.032, 0.016), "head", blend=0.006)]
    comb += [ell(P(0, 0.1 + 0.015 * i, 0.452 + 0.004 * (1 - abs(i - 1))), (0.006, 0.008, 0.012), "head", blend=0.005)
             for i in range(3)]
    wattle = [ell(P(x, 0.148, 0.374), (0.007, 0.01, 0.016), "head", blend=0.004) for x in (0.007, -0.007)]
    return bird(L, dict(
        name="beast_hen", archetype="fowl", body=body, h=0.0034, tris=2300,
        masks=lambda co, n, p, d: (p, d),
        neck_r=(0.045, 0.034, 0.029), neck_blend=0.025,
        chord=0.075, thick=0.012, tilt=14.0, wing_h=0.003, wing_tris=240, tipdark=0.4,
        beak=beak, beak_h=0.0018, beak_tris=80, beak_colour=(0.75, 0.62, 0.3),
        eye=((0.05, 0.14, 0.412), (-0.95, -0.2, 0.0), 0.0055, 0.0024, 0.0012),
        leg_r=0.006, leg_h=0.002, leg_colour=(0.8, 0.62, 0.18),
        extras=[(comb, 0.0022, 180, (0.62, 0.06, 0.04)), (wattle, 0.0022, 80, (0.62, 0.06, 0.04))],
        gait=dict(walk_stride=0.16, walk_frames=18, lift=0.035, run_stride=0.36, run_frames=12,
                  kind="fowl", fly_frames=8, hover=0.9, head_bob=9.0, waddle=3.0),
    ))


def songbird():
    """A house sparrow, 0.15 m: round, short-necked, a stout little beak, a
    tail cocked up. It hops rather than walks, and flutters."""
    L = dict(
        body=[(0, -0.04, 0.07), (0, 0.03, 0.07)],
        neck=[(0, 0.028, 0.074), (0, 0.042, 0.089)],
        beak=(0, 0.083, 0.087),
        tail=[(0, -0.035, 0.075), (0, -0.1, 0.086)],
        wing=[(0.019, 0.024, 0.081), (0.025, -0.012, 0.083), (0.017, -0.066, 0.08)],
        hind=[(0.01, 0.0, 0.055), (0.013, 0.012, 0.042), (0.013, -0.002, 0.028),
              (0.013, 0.003, 0.003), (0.013, 0.02, 0.001)],
    )
    body = [
        ell(P(0, -0.005, 0.068), (0.024, 0.043, 0.024), "body", blend=0.01),
        ell(P(0, 0.018, 0.066), (0.022, 0.024, 0.023), "body", blend=0.01, mask=(0.8, 0)),
        cone(P(0, -0.035, 0.075), P(0, -0.1, 0.087), 0.013, 0.011, "tail1", blend=0.008, squash=(1, 1, 0.2),
             mask=(0, 0.6)),
        ell(P(0, 0.048, 0.09), (0.017, 0.019, 0.017), "head", blend=0.007),
    ]
    beak = [cone(P(0, 0.06, 0.088), P(0, 0.083, 0.086), 0.0065, 0.0012, "head", blend=0.002)]
    return bird(L, dict(
        name="beast_songbird", archetype="songbird", body=body, h=0.00105, tris=1500,
        masks=lambda co, n, p, d: (p, d),
        neck_r=(0.018, 0.016), neck_blend=0.008,
        chord=0.028, thick=0.0045, tilt=14.0, wing_h=0.001, wing_tris=200, tipdark=0.6,
        beak=beak, beak_h=0.0007, beak_tris=60, beak_colour=(0.14, 0.12, 0.1),
        eye=((0.03, 0.058, 0.094), (-0.95, -0.2, 0.0), 0.0033, 0.0013, 0.0006),
        leg_r=0.0017, leg_h=0.0007, leg_tris=180, leg_colour=(0.42, 0.3, 0.24), shin_bare=True,
        gait=dict(walk_stride=0.12, walk_frames=16, lift=0.02, kind="hopper", fly_frames=6, hover=2.2),
    ))


# ============================================================ serpents
#
# A snake is a chain of bones from the neck to the tail tip, and its gait is
# not a gait: in lateral undulation every point of the body follows the same
# S-shaped track across the ground, which stays put while the snake slides
# along it. So the clip lays a sine track down in the world, slides the chain
# one wavelength along it per cycle, and subtracts the travel -- which makes
# the stride exactly one wavelength, and a body that never slips sideways off
# its own track.


def serpent_bones(n, length, radius_at, head_len, jaw=True):
    """Neck at the origin's front; `n` body bones running back to the tail
    tip, the head forward of the neck. Returns (bones, joint positions)."""
    front = length * 0.5
    joints = [front - length * i / n for i in range(n + 1)]
    b = []
    parent = None
    for i in range(n):
        name = "body%d" % (i + 1)
        b.append((name, P(0, joints[i], radius_at(i / n)), P(0, joints[i + 1], radius_at((i + 1) / n)), parent))
        parent = name
    b.append(("head", P(0, front, radius_at(0)), P(0, front + head_len, radius_at(0) * 0.8), "body1"))
    if jaw:
        b.append(("jaw", P(0, front + head_len * 0.1, radius_at(0) * 0.55), P(0, front + head_len * 0.92, radius_at(0) * 0.45), "head"))
    return b, joints


def serpent(name, archetype, length, girth, n, head_len, h, tris, gait, head=True, rings=0.0, mask=None):
    """A snake (or a worm, head=False) as one tube of round cones joint to
    joint. `girth(u)` is the radius at fraction u from neck (0) to tail (1)."""
    ground = lambda u: girth(u) * 0.82
    bones, joints = serpent_bones(n, length, ground, head_len, jaw=head)
    body = []
    for i in range(n):
        u0, u1 = i / n, (i + 1) / n
        r0, r1 = girth(u0), girth(u1)
        if rings:
            # A worm's segments: the radius pinched in at every joint.
            r1 *= 1.0
        body.append(cone(P(0, joints[i], ground(u0)), P(0, joints[i + 1], ground(u1)), r0, r1,
                         "body%d" % (i + 1), blend=girth(0.4) * 0.8, squash=(1.0, 1.0, 0.78), group="tube"))
    if rings:
        for i in range(n * 2):
            u = (i + 0.5) / (n * 2)
            f = lerp(joints[0], joints[-1], u)
            bone = "body%d" % (min(n, int(u * n) + 1))
            body.append(ell(P(0, f, ground(u)), (girth(u) * 1.1, length / (n * 2) * 0.42, girth(u) * 0.9),
                            bone, blend=girth(u) * 0.25))
    front = joints[0]
    if head:
        r = girth(0)
        body.append(ell(P(0, front + head_len * 0.45, r * 0.75), (r * 1.35, head_len * 0.55, r * 0.72),
                        "head", blend=r * 0.8))
        body.append(ell(P(0, front + head_len * 0.8, r * 0.7), (r * 0.9, head_len * 0.3, r * 0.55),
                        "head", blend=r * 0.5))
    else:
        r = girth(0)
        body.append(ell(P(0, front + head_len * 0.3, r * 0.8), (r * 0.95, head_len * 0.5, r * 0.85),
                        "head", blend=r * 0.6, mask=(0.5, 0)))

    def masks(co, nrm, pale, dark):
        belly = np.clip((-nrm[:, 2] - 0.2) / 0.5, 0, 1)
        return np.maximum(pale, belly), dark

    def parts(body_solids):
        out = []
        if head:
            r = girth(0)
            jaw_s = [cone(P(0, front + head_len * 0.12, r * 0.5), P(0, front + head_len * 0.9, r * 0.42),
                          r * 0.7, r * 0.35, "jaw", blend=r * 0.3, squash=(1.1, 1, 0.55))]
            out.append(sdf_part(jaw_s, h, 160, "jaw", "scales", smooth=1,
                                mask_fn=lambda co, n_, p, d: (np.maximum(p, 0.7), d)))
            mouth = [ell(P(0, front + head_len * 0.55, r * 0.58), (r * 0.8, head_len * 0.38, r * 0.12),
                         {"head": 0.5, "jaw": 0.5}, blend=r * 0.1)]
            out.append(solid_part(mouth, h, 100, "mouth", "horn", (0.35, 0.12, 0.12)))
            out += eye_pair(body_solids, (r * 2.5, front + head_len * 0.55, r * 1.05), (-1.0, 0.0, -0.1), r * 0.26,
                            colour=(0.3, 0.24, 0.05), sink=r * 0.12, h=h * 0.5, tris=60)
        return out

    return dict(name=name, archetype=archetype, bones=bones, body=body, masks=masks, parts=parts,
                patch=mask, h=h, tris=tris, mat="scales", gait=gait, clips=serpent_clips,
                joints=joints, head_len=head_len, n=n)


def snake():
    """A python, 3 m long and as thick as a forearm at its middle. The marsh's
    anaconda and every lesser snake are this, scaled."""
    L = 3.0
    girth = lambda u: 0.022 + 0.052 * math.sin(math.pi * min(1.0, (u + 0.12) / 1.02)) ** 0.8 * (1 - u) ** 0.35
    return serpent("beast_snake", "serpent", L, girth, 16, 0.13, 0.006, 3000,
                   dict(stride=1.0, frames=40, amp=0.16, lift=0.0), mask=spots(0.09, seed=17))


def worm():
    """The fat worm of the troll den: 1.3 m of ringed, headless body that
    'scurries from corpse to corpse'. It crawls on the serpent's track with a
    shallow wave and a swelling that runs down it."""
    L = 1.3
    girth = lambda u: 0.07 * (1 - 0.55 * u ** 2) * (0.75 + 0.25 * math.sin(math.pi * min(1.0, u * 1.6 + 0.1)))
    return serpent("beast_worm", "worm", L, girth, 10, 0.06, 0.006, 2400,
                   dict(stride=0.45, frames=36, amp=0.05, lift=0.0, worm=True), head=False, rings=1.0,
                   mask=spots(0.2, seed=23))


def serpent_clips(arm, spec):
    g = spec["gait"]
    poser = Poser(arm, {})
    clip = Clip(poser)
    n = spec["n"]
    names = ["body%d" % (i + 1) for i in range(n)]
    joints = spec["joints"]
    seg = (joints[0] - joints[-1]) / n
    lam = g["stride"]
    amp = g["amp"]
    rest = poser.rest
    heights = [rest[nm].translation.z for nm in names] + [poser.rest_tail(names[-1]).z]
    bones = {b.name for b in arm.data.bones}

    # The track: lateral offset as a function of forward distance, sampled
    # finely so the chain can be laid on it by arc length.
    ys = np.linspace(-4 * lam - (joints[0] - joints[-1]), 4 * lam + 1.0, 4000)

    def track(a):
        xs = a * np.sin(2 * np.pi * ys / lam)
        d = np.sqrt(np.diff(xs) ** 2 + np.diff(ys) ** 2)
        arc = np.concatenate([[0.0], np.cumsum(d)])
        return xs, arc
    xs_w, arc_w = track(amp)
    per_wave = np.interp(lam, ys - ys[0], arc_w) if False else None
    # Arc length of one wavelength of track.
    i0 = np.searchsorted(ys, 0.0)
    i1 = np.searchsorted(ys, lam)
    arc_per = arc_w[i1] - arc_w[i0]

    # A naga carries the front of its body reared up off the ground, cobra
    # fashion; `rear` is how high the neck is held and `rear_n` how many
    # segments the rise takes. Zero for every snake that lies flat.
    rear_h = g.get("rear", 0.0)
    rear_n = g.get("rear_n", max(3, n // 3))
    # The top `upright` segments of a reared body stand straight up over the
    # rest of the rise: the naga's are a woman's waist, chest and neck, and
    # laid on the rising curve they leaned forward at 50 degrees.
    up_k = g.get("upright", 0) if rear_h else 0

    def lay(head_arc, xs, arc, lift=None, rear=1.0):
        """Joint positions (Blender space) with the neck at arc `head_arc`."""
        pts = []
        for i in range(n + 1):
            j = max(i, up_k)
            s = head_arc - (j - up_k) * seg
            y = np.interp(s, arc, ys)
            x = np.interp(s, arc, xs)
            z = heights[i] + (lift(i) if lift else 0.0)
            if rear_h:
                z += rear * (rear_h - up_k * seg) * max(0.0, 1.0 - (j - up_k) / (rear_n - up_k)) ** 1.6
            if i < up_k:
                # Straight up from joint up_k when reared; lying ahead of it on
                # the track when not.
                flat = head_arc + (up_k - i) * seg
                y = lerp(np.interp(flat, arc, ys), y, rear)
                x = lerp(np.interp(flat, arc, xs), x, rear)
                z += rear * (up_k - i) * seg
            pts.append(V((x, -y, z)))
        return pts

    lengths = [poser.length[nm] for nm in names]

    def pose_chain(pts, head_pitch=0.0, head_yaw=0.0, jaw=0.0, roll=0.0, anchor=None):
        """Bases for the chain lying along `pts`, then the head and jaw by FK.
        The bones keep their lengths, so the chain is rebuilt joint to joint
        along the directions `pts` give and then slid so that joint `anchor`
        lands where `pts` put it: the middle of the body stays where it is
        while the front rears and strikes."""
        dirs = [(pts[i + 1] - pts[i]).normalized() for i in range(n)]
        if anchor is not None:
            built = [V(pts[0])]
            for i in range(n):
                built.append(built[-1] + dirs[i] * lengths[i])
            delta = pts[anchor] - built[anchor]
            delta.z = 0.0
            pts = [p + delta for p in built]
        if rear_h:
            # The head keeps looking ahead however steeply the neck rises.
            d0 = pts[0] - pts[1]
            head_pitch += math.degrees(math.atan2(d0.z, math.hypot(d0.x, d0.y)))
        basis = {}
        M = {}
        for i, nm in enumerate(names):
            head_p, tail_p = pts[i], pts[i + 1]
            y = (tail_p - head_p).normalized()
            up = V((0, 0, 1))
            x = y.cross(up)
            # A reared neck can stand straight up, where "sideways" is lost.
            x = x.normalized() if x.length > 1e-3 else V((-1, 0, 0))
            z = x.cross(y)
            if roll:
                q = mathutils.Quaternion(y, math.radians(roll))
                x, z = q @ x, q @ z
            want = mathutils.Matrix((x, y, z)).transposed().to_4x4()
            want.translation = head_p
            b = arm.data.bones[nm]
            if b.parent is None:
                bm = rest[nm].inverted() @ want
                basis[nm] = (bm.to_quaternion(), bm.to_translation())
            else:
                chain = M[b.parent.name] @ rest[b.parent.name].inverted() @ rest[nm]
                basis[nm] = ((chain.inverted() @ want).to_quaternion(), None)
            M[nm] = want
        for nm, ang in (("head", (head_pitch, head_yaw, 0)), ("jaw", (-jaw, 0, 0))):
            if nm not in bones:
                continue
            parent = arm.data.bones[nm].parent.name
            chain = M[parent] @ rest[parent].inverted() @ rest[nm]
            q = fk_quat(ang)
            basis[nm] = (q, None)
            M[nm] = chain @ q.to_matrix().to_4x4()
        poser.M = M
        return basis

    report = {}
    frames = g["frames"]
    start = arc_w[np.searchsorted(ys, 0.0)] + (joints[0] - joints[-1]) * 0.0

    def keyed(name, total, fn, step=1):
        act = new_action(arm, name, total)
        last = {}
        for i in list(range(0, total, step)) + [total]:
            basis = fn(i / total)
            for nm, (q, loc) in basis.items():
                if nm in last and last[nm].dot(q) < 0:
                    basis[nm] = (-q, loc)
                last[nm] = basis[nm][0]
            poser.key(basis, i)
        for fc in action_fcurves(act):
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
        clip.report[name] = total / FPS

    base_arc = arc_w[i0] + (joints[0] - joints[-1]) + lam  # neck far enough along the track

    # -- walk: slide one wavelength of arc per cycle, minus the forward travel.
    worm = g.get("worm", False)

    def walk(t):
        pts = lay(base_arc + arc_per * t, xs_w, arc_w,
                  lift=(lambda i: 0.012 * math.sin(2 * math.pi * (2 * t - i / 4.0)) * (1 if worm else 0)))
        shift = V((0, lam * t, 0))
        # Measured from the rest neck so the chain sits where it was modelled.
        offset = V((0, -joints[0], 0)) - (pts[0] + shift)
        offset.x = offset.z = 0.0
        pts = [p + shift + offset for p in pts]
        return pose_chain(pts, head_pitch=-4, head_yaw=0.0)
    keyed("walk", frames, walk)
    report["stride"] = {"walk": lam}

    # -- idle: lying in a lazy S, breathing, the head up and looking about.
    xs_i, arc_i = track(amp * 1.4)

    def idle(t):
        pts = lay(base_arc, xs_i, arc_i, lift=lambda i: (0.05 * max(0, 3 - i) / 3 if not worm else 0.0))
        offset = V((0, -joints[0], 0)) - pts[0]
        offset.x = offset.z = 0.0
        pts = [p + offset for p in pts]
        breath = 0.003 * wave(3 * t)
        pts = [p + V((0, 0, breath * math.sin(math.pi * i / n))) for i, p in enumerate(pts)]
        return pose_chain(pts, head_pitch=-8 + 4 * wave(2 * t), head_yaw=20 * wave(t, 0.1), anchor=n // 2)
    keyed("idle", 120, idle, step=2)

    # -- attack: the front of the body draws back into an S and strikes.
    def attack(t):
        cock = ease(t / 0.35) * (1 - ease((t - 0.35) / 0.1))
        strike = ease((t - 0.35) / 0.12) * (1 - ease((t - 0.62) / 0.38))
        front_n = max(3, n // 3)

        def lift(i):
            if i > front_n:
                return 0.0
            k = 1 - i / front_n
            return (0.25 * cock + 0.12 * strike) * k * spec["joints"][0] / 1.5 * (0.6 if worm else 1.0)
        pts = lay(base_arc, xs_i, arc_i, lift=lift)
        offset = V((0, -joints[0], 0)) - pts[0]
        offset.x = offset.z = 0.0
        pts = [p + offset for p in pts]
        # Drawn back into an S, then thrown straight: the front joints are
        # pulled sideways into a coil as they rise, and let go on the strike.
        for i in range(front_n + 1):
            k = 1 - i / front_n
            pts[i] = pts[i] + V((0.18 * cock * math.sin(math.pi * k * 1.5) * spec["joints"][0] / 1.5,
                                 0.12 * cock * k, 0))
            if strike > 0:
                straight = V((pts[front_n].x, pts[front_n].y - (front_n - i) * seg, pts[i].z))
                pts[i] = pts[i].lerp(straight, strike)
        gape = ease((t - 0.25) / 0.12) * (1 - ease((t - 0.47) / 0.05))
        return pose_chain(pts, head_pitch=25 * cock - 20 * strike, jaw=60 * gape, anchor=n // 2)
    keyed("attack", 21, attack)
    report["hit"] = 0.5

    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.35)) if t < 0.35 else (1 - ease((t - 0.35) / 0.65)) * 0.8
        pts = lay(base_arc, xs_i, arc_i, lift=lambda i: 0.04 * k * max(0, 4 - i) / 4)
        offset = V((0, -joints[0], 0)) - pts[0]
        offset.x = offset.z = 0.0
        offset.y += 0.05 * k
        pts = [p + offset for p in pts]
        return pose_chain(pts, head_pitch=-25 * k, head_yaw=20 * k, anchor=n // 2)
    keyed("hit", 11, hit)

    xs_d, arc_d = track(amp * 0.5)

    def death(t):
        writhe = math.sin(math.pi * min(1.0, t / 0.5)) * (1 - ease((t - 0.5) / 0.5))
        xs_m = xs_i * (1 - ease(t)) + xs_d * ease(t)
        pts = lay(base_arc, xs_m, arc_i, lift=lambda i: 0.06 * writhe * math.sin(i * 1.3), rear=1 - ease(t / 0.6))
        offset = V((0, -joints[0], 0)) - pts[0]
        offset.x = offset.z = 0.0
        pts = [p + offset for p in pts]
        return pose_chain(pts, head_pitch=10 * ease(t), jaw=25 * ease((t - 0.6) / 0.4),
                          roll=100 * ease((t - 0.3) / 0.5), anchor=n // 2)
    keyed("death", 45, death)

    report["clips"] = clip.report
    report["overreach"] = {}
    report["walk"] = 0.0
    return report


def dragon():
    """A green dragon, 1.7 m at the shoulder and nine metres nose to tail tip:
    a long neck and tail on a heavy four-legged body, a horned head, a ridge of
    spikes down the spine, and membrane wings folded up over the back like a
    tent. Scaled, it is every dragon from a hatchling to Haon Dor's 'huge'
    one; the wings open in a threat and beat as it runs."""
    L = dict(
        spine=[(0, -0.9, 1.55), (0, -0.3, 1.62), (0, 0.3, 1.65), (0, 0.8, 1.6)],
        neck=[(0, 0.9, 1.6), (0, 1.4, 2.0), (0, 1.8, 2.4), (0, 2.2, 2.65)],
        nose=(0, 2.95, 2.5),
        jaw=[(0, 2.3, 2.52), (0, 2.88, 2.36)],
        tail=[(0, -1.0, 1.5), (0, -1.6, 1.3), (0, -2.3, 1.02), (0, -3.0, 0.72), (0, -3.6, 0.48),
              (0, -4.2, 0.3), (0, -4.8, 0.18)],
        hind=[(0.38, -0.8, 1.3), (0.48, -0.45, 0.85), (0.43, -0.85, 0.42),
              (0.42, -0.72, 0.09), (0.42, -0.45, 0.03)],
        fore=[(0.42, 0.75, 1.2), (0.47, 0.45, 0.8), (0.44, 0.63, 0.32),
              (0.44, 0.72, 0.08), (0.44, 0.95, 0.03)],
        scapula=(0.3, 0.5, 1.85),
        extra={"wing1*": ((0.3, 0.6, 1.95), (0.5, -0.05, 3.0), "chest"),
               "wing2*": ((0.5, -0.05, 3.0), (0.45, -1.8, 1.85), "wing1*"),
               "horn*": ((0.12, 2.3, 2.8), (0.24, 1.95, 3.05), "head")},
    )
    tail = L["tail"]
    body = [
        ell(P(0, -0.05, 1.35), (0.55, 1.0, 0.48), ("grad", "spine", "chest", P(0, -0.4, 1.35), P(0, 0.6, 1.35)), blend=0.2),
        ell(P(0, 0.7, 1.35), (0.46, 0.42, 0.46), "chest", blend=0.18),
        ell(P(0, -0.8, 1.4), (0.46, 0.42, 0.42), "pelvis", blend=0.18),
        ell(P(0, 2.4, 2.7), (0.2, 0.3, 0.19), "head", blend=0.1),
        cone(P(0, 2.5, 2.64), P(0, 2.92, 2.5), 0.15, 0.085, "head", blend=0.08, squash=(1.0, 1.0, 0.72)),
        ell(P(0.11, 2.52, 2.8), (0.07, 0.12, 0.05), "head", blend=0.05),
        ell(P(-0.11, 2.52, 2.8), (0.07, 0.12, 0.05), "head", blend=0.05),
    ]
    neck = L["neck"]
    neck_r = (0.4, 0.3, 0.25, 0.21)
    for i in range(len(neck) - 1):
        nm = "neck" if i == 0 else "neck%d" % (i + 1)
        body.append(cone(P(*neck[i]), P(*neck[i + 1]), neck_r[i], neck_r[i + 1], nm, blend=0.12, group="neck",
                         squash=(0.9, 1, 1)))
    for i in range(len(tail) - 1):
        r0 = 0.36 * (1 - i / (len(tail) - 1)) ** 1.1 + 0.03
        r1 = 0.36 * (1 - (i + 1) / (len(tail) - 1)) ** 1.1 + 0.03
        body.append(cone(P(*tail[i]), P(*tail[i + 1]), r0, r1, "tail%d" % (i + 1), blend=0.12, group="tail",
                         squash=(0.9, 1, 1)))
    for side in (1, -1):
        t = ".L" if side > 0 else ".R"
        body += leg_solids(L, "hind", [0.3, 0.2, 0.13, 0.12, 0.0], 0.15, side)
        body += leg_solids(L, "fore", [0.26, 0.17, 0.12, 0.11, 0.0], 0.14, side)
        body.append(ell(P(side * 0.4, -0.85, 1.05), (0.26, 0.4, 0.48), "thigh" + t, blend=0.15))
        body.append(ell(P(side * 0.45, 0.6, 1.0), (0.22, 0.3, 0.38), "upperarm" + t, blend=0.15))
        body.append(ell(P(side * 0.42, -0.62, 0.08), (0.15, 0.25, 0.08), "htoe" + t, blend=0.06))
        body.append(ell(P(side * 0.44, 0.82, 0.08), (0.15, 0.22, 0.08), "ftoe" + t, blend=0.06))

    def masks(co, n, pale, dark):
        belly = np.clip((-n[:, 2] - 0.1) / 0.5, 0, 1)
        top = np.clip((n[:, 2] - 0.7) / 0.3, 0, 1)
        return np.maximum(pale, belly), np.maximum(dark, top * 0.5)

    def parts(body_solids):
        out = []
        jaw = [cone(P(0, 2.32, 2.54), P(0, 2.86, 2.38), 0.13, 0.07, "jaw", blend=0.05, squash=(0.95, 1, 0.6))]
        out.append(sdf_part(jaw, 0.02, 260, "jaw", "scales", smooth=1,
                            mask_fn=lambda co, n, p, d: (np.maximum(p, 0.7), d)))
        mouth = [ell(P(0, 2.62, 2.48), (0.1, 0.26, 0.03), {"head": 0.5, "jaw": 0.5}, blend=0.02)]
        out.append(solid_part(mouth, 0.02, 120, "mouth", "horn", (0.3, 0.07, 0.05)))
        # Teeth along both jaws: a row of small cones, which is what a
        # snarling dragon is seen by from anywhere near it.
        teeth = []
        for i in range(6):
            f = 2.45 + i * 0.075
            for x in (0.07, -0.07):
                teeth.append(cone(P(x * (1 - i * 0.08), f, 2.46), P(x * (1 - i * 0.08), f + 0.01, 2.4), 0.018, 0.004,
                                  "head", blend=0.004, group="t%d%d" % (i, x > 0)))
        out.append(solid_part(teeth, 0.008, 300, "teeth", "horn", (0.85, 0.82, 0.7), smooth=0))
        out += eye_pair(body_solids, (0.4, 2.52, 2.74), (-0.95, 0.0, -0.15), 0.045, colour=(0.9, 0.72, 0.05),
                        sink=0.02, squash=(1.0, 1.0, 0.55), h=0.01)
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            h0, h1, _ = L["extra"]["horn*"]
            a, b = apply_side(h0, side), apply_side(h1, side)
            mid = V(a).lerp(V(b), 0.5) + V((0, 0, -0.06))
            horn = [cone(P(*a), P(*mid), 0.07, 0.05, "horn" + t, blend=0.02, group="h"),
                    cone(P(*mid), P(*b), 0.05, 0.01, "horn" + t, blend=0.02, group="h")]
            out.append(solid_part(horn, 0.01, 180, "horn", "horn", (0.55, 0.5, 0.38)))
        # The dorsal ridge: spikes from the back of the skull to the tail tip,
        # each on the bone beneath it.
        ridge = []
        chain = [(neck[i], "neck" if i == 0 else "neck%d" % (i + 1)) for i in range(len(neck) - 1)]
        chain += [((0, 0.6, 1.6), "chest"), ((0, 0.1, 1.64), "spine"), ((0, -0.5, 1.6), "pelvis")]
        chain += [(tail[i], "tail%d" % (i + 1)) for i in range(len(tail) - 1)]
        pts = []
        for (p, bone) in chain:
            pts.append((V(p), bone))
        k = 0
        for (p, bone) in pts:
            top = surface_point(body_solids, P(0, p.y, p.z + 1.2), P(0, 0, -1), sink=0.03)
            size = 0.2 * (1.0 if p.y > -1.5 else max(0.35, 1 + (p.y + 1.5) / 4))
            tip = top + V((0, 0.08, size))
            ridge.append(cone(tuple(top), tuple(tip), size * 0.35, 0.01, bone, blend=0.01, group="r%d" % k))
            k += 1
        out.append(solid_part(ridge, 0.012, 34 * len(ridge), "ridge", "horn", (0.22, 0.26, 0.14), smooth=0))
        # Wings: arm and fingers as leathery rods, the membrane a thin slab
        # hung from them down to the flank.
        for side in (1, -1):
            t = ".L" if side > 0 else ".R"
            sh = V(apply_side(L["extra"]["wing1*"][0], side))
            wr = V(apply_side(L["extra"]["wing1*"][1], side))
            tip = V(apply_side(L["extra"]["wing2*"][1], side))
            wing = [cone(P(*sh), P(*wr), 0.09, 0.06, "wing1" + t, blend=0.04, group="arm"),
                    cone(P(*wr), P(*tip), 0.06, 0.015, "wing2" + t, blend=0.04, group="arm")]
            # Fingers: three more spars fanned back from the wrist to the
            # trailing edge, as a bat's, and the membrane in lobes between
            # them that sag short of the line from tip to tip -- a scalloped
            # edge, which is what says wing at any distance. It was one slab,
            # and folded on the back it read as a pair of leaves.
            tips = [tip] + [V(apply_side(q, side)) for q in ((0.5, -1.35, 1.42), (0.53, -0.85, 1.38),
                                                                (0.5, -0.35, 1.5))]
            for i, ft in enumerate(tips[1:]):
                wing.append(cone(P(*wr), P(*ft), 0.04, 0.012, "wing2" + t, blend=0.03, group="f%d" % i))
            tips.append(V(apply_side((0.4, 0.2, 1.75), side)))
            for i in range(len(tips) - 1):
                a_, b_ = tips[i], tips[i + 1]
                mid = wr.lerp((a_ + b_) * 0.5, 0.86)
                half = (a_ - b_).length * 0.5
                d_ = (mid - wr)
                n_ = d_.cross(b_ - a_).normalized()
                # Thin across the membrane's own plane.
                sq = tuple(max(0.07, abs(n_[k]) * 0.07 + (1 - abs(n_[k])) * 1.0) for k in range(3))
                bone = "wing2" + t if i < 3 else ("grad", "wing1" + t, "wing2" + t, P(*sh), P(*wr))
                wing.append(cone(P(*wr.lerp(mid, 0.1)), P(*mid), 0.06, half * 0.95, bone, blend=0.04,
                                 squash=(sq[0], sq[1], sq[2]), mask=(0, 0.55)))
            out.append(sdf_part(wing, 0.013, 800, "wing", "scales", smooth=1))
        out += claws(L, "fore", 3, 0.16, 0.035, 0.008, colour=(0.18, 0.16, 0.12))
        out += claws(L, "hind", 3, 0.14, 0.035, 0.008, colour=(0.18, 0.16, 0.12))
        return out

    return dict(name="beast_dragon", archetype="dragon", L=L, body=body, masks=masks, parts=parts,
                patch=spots(0.3, seed=29), h=0.03, tris=4200, mat="scales",
                gait=dict(walk_stride=2.1, walk_frames=46, walk_duty=0.66, lift=0.22,
                          run_stride=3.4, run_frames=26, run_duty=0.4, run_lift=0.35,
                          gallop="transverse", wag=5.0, idle_wag=1, tail_pitch=-4.0, lie=0.5, arch=4.0,
                          attack_frames=24, lair=True,
                          flex={"hind": dict(lean=6, push=15, fold=35, curl=30),
                                "fore": dict(lean=6, push=18, fold=60, curl=35, scap=10)}))


# ============================================================ clips


class Clip:
    """Keys one action from a pose function of t in [0, 1]. The pose function
    returns dict(fk=, loc=, rot=, ik=, limp=): `limp` in [0, 1] blends the IK
    legs towards their FK angles, which is how a death lets go of the ground.
    Quaternions are kept on one hemisphere frame to frame, or the sampler
    takes the long way round between two keys that mean the same rotation."""

    def __init__(self, poser):
        self.poser = poser
        self.report = {}
        self.reach = {}

    def run(self, name, frames, fn, track=None, step=1):
        """`step` keys every n-th frame: the slow clips (idle, float) are
        smooth enough to be sampled at 15 fps, and they are the long ones."""
        poser = self.poser
        poser.overreach = 0.0
        act = new_action(poser.arm, name, frames)
        last = {}
        tracks = {}
        for i in list(range(0, frames, step)) + [frames]:
            t = i / frames
            pose = fn(t)
            loc0 = V(pose.get("loc", V((0, 0, 0))))
            before = poser.overreach
            poser.overreach = 0.0
            basis = poser.solve(pose.get("fk", {}), loc0, pose.get("rot"), pose.get("ik"))
            # A planted foot the leg cannot reach is dragged: the solver
            # clamps the ankle and the toe tip leaves its mark on the ground.
            # The body comes down to the foot instead -- a few millimetres
            # of dip at full stretch, where a real body sinks anyway.
            # A splayed leg short of reach sideways can want the body up.
            best = (poser.overreach, loc0)
            for sign in (-1.0, 1.0):
                for _ in range(10):
                    if best[0] < 1e-5:
                        break
                    trial = best[1] + V((0, 0, sign * best[0] * 1.2))
                    poser.overreach = 0.0
                    poser.solve(pose.get("fk", {}), trial, pose.get("rot"), pose.get("ik"))
                    if poser.overreach >= best[0]:
                        break
                    best = (poser.overreach, trial)
            if best[1] != loc0:
                pose["loc"] = best[1]
            poser.overreach = 0.0
            basis = poser.solve(pose.get("fk", {}), best[1], pose.get("rot"), pose.get("ik"))
            poser.overreach = max(before, poser.overreach)
            limp = pose.get("limp", 0.0)
            if limp > 0.0 and pose.get("ik"):
                loose = poser.solve(pose.get("fk", {}), pose.get("loc", V((0, 0, 0))), pose.get("rot"), None)
                for name_, (q, loc) in list(basis.items()):
                    if name_ in poser.leg_of:
                        basis[name_] = (q.slerp(loose[name_][0], limp), loc)
                poser.solve(pose.get("fk", {}), pose.get("loc", V((0, 0, 0))), pose.get("rot"), None)
            for name_, (q, loc) in basis.items():
                prev = last.get(name_)
                if prev is not None and prev.dot(q) < 0:
                    q = -q
                    basis[name_] = (q, loc)
                last[name_] = q
            poser.key(basis, i)
            if track:
                for leg, chain in track.items():
                    tracks.setdefault(leg, []).append(poser.world_of(chain))
        # Linear, and exported as keyed rather than resampled: every key is a
        # solved pose, and a Bezier between two of them is a pose nobody solved.
        for fc in action_fcurves(act):
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"
        self.report[name] = frames / FPS
        self.reach[name] = (round(poser.overreach, 4), getattr(poser, "worst", None))
        poser.worst = None
        return tracks


def step(phase, stride, duty, lift):
    """Where a foot is, in the body's frame, at this point in its own cycle.
    Stance: on the ground, moving back at exactly stride/cycle -- the speed the
    body travels -- from +duty*stride/2 to -duty*stride/2. Swing: lifted and
    carried forward again. Returns (forward offset, lift, in_stance, x) with x
    the progress through the current phase."""
    p = phase % 1.0
    half = stride * duty * 0.5
    if p < duty:
        x = p / duty
        return half - 2 * half * x, 0.0, True, x
    s = (p - duty) / (1.0 - duty)
    f = -half + 2 * half * (0.5 - 0.5 * math.cos(math.pi * s))
    h = lift * math.sin(math.pi * min(1.0, s * 1.15)) if s < 1 / 1.15 else 0.0
    return f, max(0.0, h), False, s


def leg_rest(poser):
    rest = {}
    for leg, info in poser.legs.items():
        up, lo, meta, toe = info["chain"]
        rest[leg] = dict(
            tip=poser.rest_tail(toe),
            hip=poser.rest[up].translation.copy(),
            meta=poser.rest[meta].col[1].xyz.normalized(),
            toe=poser.rest[toe].col[1].xyz.normalized(),
            kind=info["kind"],
        )
    return rest


def planted(rest, leg, fwd=0.0, up=0.0, side=0.0, meta=0.0, toe=0.0):
    """An IK target: the rest toe tip moved (forward, up, side) and the two
    lowest segments pitched by (meta, toe) degrees -- positive swings a
    downward segment backwards, and tips a forward one down."""
    r = rest[leg]
    tip = r["tip"] + V((side if leg.endswith(".L") else -side, -fwd, up))
    return (tip, rot_x(r["meta"], meta), rot_x(r["toe"], toe))


def gait_targets(rest, t, stride, duty, lift, offsets, flex):
    """IK targets for all four legs at time t of a locomotion cycle."""
    ik = {}
    stance = {}
    for leg, off in offsets.items():
        f, h, on, x = step(t + off, stride, duty, lift)
        kind = rest[leg]["kind"]
        fl = flex[kind]
        half = max(1e-6, stride * duty * 0.5)
        a = max(-1.4, min(1.4, -f / half))  # +1 at lift-off, -1 at touchdown
        meta = fl["lean"] * a
        toe = 0.0
        if on:
            # Peeling off the ground at the end of stance: the toe tip stays
            # put and everything above it rises.
            if x > 0.7:
                toe += fl["push"] * ease((x - 0.7) / 0.3)
                meta += fl["push"] * 0.5 * ease((x - 0.7) / 0.3)
        else:
            k = math.sin(math.pi * x)
            meta += fl["fold"] * k
            toe += fl["curl"] * k
        ik[leg] = planted(rest, leg, fwd=f, up=h, meta=meta, toe=toe)
        stance[leg] = on
        if kind == "fore":
            # Forward foot, forward shoulder: the blade rocks with the leg.
            stance["scapula" + leg[-2:]] = (-fl.get("scap", 14) * max(-1.2, min(1.2, f / half)), 0, 0)
    return ik, stance


WALK = {"hind.L": 0.0, "fore.L": 0.25, "hind.R": 0.5, "fore.R": 0.75}
ROTARY = {"hind.L": 0.0, "hind.R": 0.12, "fore.R": 0.44, "fore.L": 0.56}
TRANSVERSE = {"hind.L": 0.0, "hind.R": 0.12, "fore.L": 0.44, "fore.R": 0.56}


def tail_wave(names, t, amp, freq=1.0, lag=0.12, pitch=0.0, droop=0.0):
    out = {}
    for i, n in enumerate(names):
        out[n] = (pitch + droop * i, amp * (0.6 + 0.3 * i) * wave(freq * t - lag * i), 0)
    return out


def quad_clips(arm, spec):
    """idle, walk, run, attack, hit, death for any quadruped built by
    quad_bones(). The gait table in the spec sets stride, cadence, duty and
    lift; everything else is proportioned from the skeleton."""
    g = spec["gait"]
    poser = Poser(arm, quad_legs())
    rest = leg_rest(poser)
    clip = Clip(poser)
    bones = {b.name for b in arm.data.bones}
    tails = sorted([b for b in bones if b.startswith("tail")], key=lambda n: int(n[4:]))
    necks = [n for n in ("neck", "neck2", "neck3") if n in bones]
    ears = [n for n in ("ear.L", "ear.R", "flop.L", "flop.R") if n in bones]
    height = rest["fore.L"]["hip"].z
    flex = g.get("flex", {"hind": dict(lean=10, push=20, fold=28, curl=40),
                          "fore": dict(lean=8, push=25, fold=70, curl=35, scap=12)})
    wag = g.get("wag", 10.0)
    winged = "wing1.L" in bones

    def with_wings(fk, **kw):
        if winged:
            fk.update(wings(**kw))
        return fk
    tail_pitch = g.get("tail_pitch", 0.0)
    report = {}

    def track_of():
        return {leg: poser.legs[leg]["chain"][3] for leg in poser.legs}

    # -- idle: breathing, a look round, ears and tail alive; feet planted.
    def idle(t):
        breath = wave(3 * t)
        fk = {"chest": (0.8 * breath, 0, 0), "spine": (-0.4 * breath, 0, 0),
              "pelvis": (0, 0, 1.2 * wave(t))}
        look = 16 * wave(t, 0.1) + 7 * wave(2 * t, 0.35)
        nod = 4 * wave(2 * t, 0.2) - 2
        for n in necks:
            fk[n] = (nod * 0.5, look * 0.4 / len(necks), 0)
        fk["head"] = (nod, look * 0.6, -look * 0.1)
        if "jaw" in bones:
            pant = g.get("pant", 0.0)
            fk["jaw"] = (-pant * (0.5 + 0.5 * wave(6 * t)), 0, 0)
        twitch = lambda c: math.exp(-((t - c) * 28) ** 2)
        for e in ears:
            s = 1 if e.endswith(".L") else -1
            fk[e] = (-12 * twitch(0.3 if s > 0 else 0.72), 0, s * 8 * twitch(0.55))
        fk.update(tail_wave(tails, t, wag, freq=g.get("idle_wag", 2), pitch=tail_pitch))
        with_wings(fk, lift=0.08 + 0.05 * breath)
        loc = V((0.004 * wave(t), 0, 0.002 * breath))
        ik = {leg: planted(rest, leg) for leg in rest}
        return dict(fk=fk, loc=loc, ik=ik)
    clip.run("idle", g.get("idle_frames", 120), idle, step=2)

    # -- graze: head down in the grass, cropping and chewing, with the ears
    # and the tail keeping the flies off. The viewer crossfades into it from
    # the idle, so it is a loop that starts and ends head-down; the feet stay
    # exactly where the idle has them, so the crossfade cannot slide them.
    gz = g.get("graze")
    if gz:
        down = graze_reach(poser, rest, arm, necks, gz)
        report["graze"] = down["report"]
        tug_at = (0.16, 0.5, 0.78)

        def graze(t):
            # A crop: the muzzle closes on the grass and tugs it up and back.
            tug = sum(math.exp(-((t - c) * 16) ** 2) for c in tug_at)
            sweep = wave(t, 0.1)
            fk = {"chest": (0.6 * wave(3 * t), 0, 0), "spine": (-0.3 * wave(3 * t), 0, 0)}
            for n in necks:
                a = down["neck"][n]
                fk[n] = (a + down["up"] * tug * down["share"][n], 4.0 * sweep * down["share"][n], 0)
            fk["head"] = (down["head"] + down["up"] * tug * 0.6, 5.0 * wave(t, 0.35), 0)
            if "jaw" in bones:
                # Chewing between crops, a grind from side to side; shut on
                # the tug itself.
                chew = (0.5 + 0.5 * wave(9 * t)) * (1 - min(1.0, tug))
                fk["jaw"] = (-gz.get("chew", 7.0) * chew, 2.5 * wave(9 * t, 0.25) * (1 - min(1.0, tug)), 0)
            flick = lambda c: math.exp(-((t - c) * 30) ** 2)
            for e in ears:
                s = 1 if e.endswith(".L") else -1
                c = (0.3, 0.9) if s > 0 else (0.62, 0.9)
                k = max(flick(c[0]), flick(c[1]))
                fk[e] = (-16 * k + 6, 0, s * 12 * k)
            swish = max(math.exp(-((t - 0.42) * 7) ** 2), math.exp(-((t - 0.88) * 9) ** 2))
            fk.update(tail_wave(tails, t, wag * 0.4 + 26 * swish, freq=2, pitch=tail_pitch))
            with_wings(fk, lift=0.08)
            ik = {leg: planted(rest, leg) for leg in rest}
            return dict(fk=fk, loc=V((0, 0, down["drop"])), rot=down["rot"], ik=ik)
        clip.run("graze", 180, graze, step=2)

    # -- walk: four-beat lateral sequence.
    S, N, duty, lift = g["walk_stride"], g["walk_frames"], g["walk_duty"], g["lift"]

    def walk(t):
        ik, st = gait_targets(rest, t, S, duty, lift, WALK, flex)
        fk = {"pelvis": (0, 3 * wave(t), 2.5 * wave(t, 0.25)),
              "spine": (0, -1.5 * wave(t), 0),
              "chest": (0, -2.5 * wave(t, 0.25), -2 * wave(t, 0.5))}
        fk.update({k: v for k, v in st.items() if k.startswith("scapula")})
        for n in necks:
            fk[n] = (2 * wave(2 * t, 0.1), 1.5 * wave(t, 0.5), 0)
        fk["head"] = (2.5 * wave(2 * t, 0.35), 2 * wave(t, 0.5), 0)
        for e in ears:
            fk[e] = (4 * wave(2 * t, 0.3), 0, 0)
        fk.update(tail_wave(tails, t, wag * 0.8, pitch=tail_pitch))
        with_wings(fk, lift=0.1 + 0.06 * wave(2 * t))
        loc = V((0.006 * wave(t, 0.25), 0, -0.007 + 0.007 * wave(2 * t, 0.2)))
        return dict(fk=fk, loc=loc, ik=ik)
    tracks = clip.run("walk", N, walk, track=track_of())
    report["walk"] = foot_slip(tracks, S, N, duty, WALK)

    # -- run: a gallop. The spine flexes and extends once a cycle, which is
    # where most of a galloping stride comes from.
    S2, N2, duty2, lift2 = g["run_stride"], g["run_frames"], g["run_duty"], g["run_lift"]
    order = ROTARY if g.get("gallop") == "rotary" else TRANSVERSE
    run_flex = {"hind": dict(lean=18, push=25, fold=45, curl=45),
                "fore": dict(lean=14, push=30, fold=95, curl=40, scap=22)}
    arch = g.get("arch", 7.0)

    def run(t):
        ik, st = gait_targets(rest, t, S2, duty2, lift2, order, run_flex)
        flexion = wave(t, 0.2)
        fk = {"pelvis": (-arch * flexion * 0.6 + 3 * wave(t, 0.45), 0, 0),
              "spine": (arch * flexion, 0, 0),
              "chest": (arch * flexion * 0.5, 0, 0)}
        fk.update({k: v for k, v in st.items() if k.startswith("scapula")})
        for n in necks:
            fk[n] = (6 * wave(t, 0.55) - 4, 0, 0)
        fk["head"] = (5 * wave(t, 0.7) + 4, 0, 0)
        for e in ears:
            fk[e] = (25, 0, 0)
        fk.update(tail_wave(tails, t, 6, pitch=tail_pitch - 10 + 8 * wave(t, 0.1)))
        with_wings(fk, open_=0.55, flap=30 * wave(t, 0.3))
        loc = V((0, 0, height * (0.04 * wave(t, 0.1) - 0.1)))
        return dict(fk=fk, loc=loc, ik=ik)
    tracks = clip.run("run", N2, run, track=track_of())
    report["run"] = foot_slip(tracks, S2, N2, duty2, order)

    # -- attack: a lunge and a bite, feet planted, snapping shut at the hit.
    HIT = 0.5

    def attack(t):
        crouch = ease(t / 0.3) * (1 - ease((t - 0.3) / 0.12))
        lunge = ease((t - 0.3) / 0.2) * (1 - ease((t - 0.62) / 0.38))
        gape = ease((t - 0.25) / 0.15) * (1 - ease((t - 0.44) / 0.06))
        reach = height * 0.22
        loc = V((0, height * 0.08 * crouch - reach * lunge, -height * 0.06 * crouch + height * 0.02 * lunge))
        fk = {"pelvis": (-3 * crouch + 4 * lunge, 0, 0), "chest": (4 * crouch - 3 * lunge, 0, 0)}
        for n in necks:
            fk[n] = (10 * crouch - 12 * lunge, 0, 0)
        fk["head"] = (12 * crouch - 14 * lunge, 0, 0)
        if "jaw" in bones:
            fk["jaw"] = (-32 * gape, 0, 0)
        for e in ears:
            fk[e] = (35 * max(crouch, lunge), 0, 0)
        fk.update(tail_wave(tails, t, 3, pitch=tail_pitch + 8 * lunge))
        with_wings(fk, open_=0.75 * max(crouch, lunge), lift=0.6 * max(crouch, lunge), flap=12 * lunge)
        ik = {leg: planted(rest, leg, meta=6 * lunge if rest[leg]["kind"] == "hind" else -4 * lunge)
              for leg in rest}
        return dict(fk=fk, loc=loc, ik=ik)
    clip.run("attack", g.get("attack_frames", 21), attack)
    report["hit"] = HIT

    # -- hit: a flinch back and up, ears pinned, head jerked away.
    def hit(t):
        k = math.sin(math.pi * min(1.0, t / 0.35)) if t < 0.35 else 0.0
        k = max(k, (1 - ease((t - 0.35) / 0.65)) * 0.8 if t >= 0.35 else k)
        loc = V((0.01 * k, height * 0.09 * k, height * 0.02 * k))
        fk = {"chest": (-5 * k, 0, 3 * k), "pelvis": (2 * k, 0, 0)}
        for n in necks:
            fk[n] = (-10 * k, 6 * k, 0)
        fk["head"] = (-12 * k, 10 * k, 0)
        for e in ears:
            fk[e] = (40 * k, 0, 0)
        fk.update(tail_wave(tails, t, 2, pitch=tail_pitch - 20 * k))
        with_wings(fk, open_=0.4 * k, flap=20 * k)
        ik = {leg: planted(rest, leg) for leg in rest}
        return dict(fk=fk, loc=loc, ik=ik)
    clip.run("hit", g.get("hit_frames", 11), hit)

    # -- death: the legs go, the body drops, and it rolls onto its left side.
    lie = g.get("lie", 0.12)
    root_h = poser.rest["pelvis"].translation.z

    def death(t):
        buckle = ease(t / 0.3)
        roll = ease((t - 0.2) / 0.45)
        settle = ease((t - 0.55) / 0.45)
        drop = lerp(0.0, -(root_h - lie), roll) - height * 0.25 * buckle * (1 - roll)
        loc = V((0.0, 0.0, drop))
        rot = mathutils.Quaternion(V((0, 1, 0)), math.radians(90 * roll))
        fk = {"pelvis": (0, 0, 0), "chest": (0, 0, 0)}
        for n in necks:
            fk[n] = (8 * buckle - 20 * settle, -25 * settle, 0)
        fk["head"] = (6 * buckle + 10 * settle, -20 * settle, 0)
        if "jaw" in bones:
            fk["jaw"] = (-10 * settle, 0, 0)
        for e in ears:
            fk[e] = (20 * settle, 0, 0)
        fk.update(tail_wave(tails, 0, 0, pitch=tail_pitch - 20 * settle))
        with_wings(fk, open_=0.35 * settle, flap=-15 * settle)
        for leg, info in poser.legs.items():
            up, lo, meta, toe = info["chain"]
            s = 1 if leg.endswith(".L") else -1
            hind = info["kind"] == "hind"
            fk[up] = (-15 if hind else 20, 0, 0)
            fk[lo] = (15 if hind else -20, 0, 0)
            fk[meta] = (-10 if hind else 12, 0, 0)
            fk[toe] = (20, 0, 0)
        ik = {leg: planted(rest, leg, fwd=0, meta=-10 * buckle) for leg in rest}
        return dict(fk=fk, loc=loc, rot=rot, ik=ik, limp=ease((t - 0.18) / 0.3))
    clip.run("death", g.get("death_frames", 45), death)

    # -- lair: lying curled on its hoard, the tail wrapped round and the head
    # down on the forelegs, breathing. The viewer plays it as the idle of a
    # dragon that is at home, which is also how a nine-metre one fits a room.
    if g.get("lair"):
        def lair(t):
            breath = wave(t)
            loc = V((0.0, 0.0, -(root_h - lie * 1.6) + 0.012 * breath))
            fk = {"pelvis": (0, 0, 0), "spine": (-1.5 * breath, 0, 0), "chest": (2 + breath, 0, 0)}
            # Pitch alone: a yaw on a neck this steep is a lean, not a turn.
            for i, n in enumerate(necks):
                fk[n] = ((38, 12, -18)[min(i, 2)], 0, 0)
            fk["head"] = (6 + 2 * wave(t, 0.3), 4 * wave(t, 0.1), 0)
            if "jaw" in bones:
                fk["jaw"] = (-2 * max(0.0, breath), 0, 0)
            for i, n in enumerate(tails):
                fk[n] = (3, -24 - 2 * wave(t, 0.1 * i), 0)
            with_wings(fk, lift=0.0)
            for leg, info in poser.legs.items():
                up, lo, meta, toe = info["chain"]
                if info["kind"] == "hind":
                    fk[up] = (-50, 0, 0)
                    fk[lo] = (125, 0, 0)
                    fk[meta] = (-85, 0, 0)
                    fk[toe] = (5, 0, 0)
                else:
                    fk[up] = (25, 0, 0)
                    fk[lo] = (-95, 0, 0)
                    fk[meta] = (-5, 0, 0)
                    fk[toe] = (5, 0, 0)
            return dict(fk=fk, loc=loc, ik={leg: planted(rest, leg) for leg in rest}, limp=1.0)
        clip.run("lair", 120, lair, step=2)

    if g.get("pastimes"):
        quad_pastimes(clip, poser, rest, arm, g, report, necks, ears, tails, tail_pitch, height, bones)

    report["clips"] = clip.report
    report["stride"] = {"walk": S, "run": S2}
    report["overreach"] = clip.reach
    return report


def sit_drop(poser, rest, pitch, front_back, hind_only=False):
    """How far the body has to come down, pitched `pitch` degrees front-up
    about the hips, for the forefeet -- moved `front_back` metres back under
    the chest -- to reach the floor. Bisected on the solved legs, like the
    graze's reach: the hind legs fold to suit."""
    rot = mathutils.Quaternion(V((1, 0, 0)), math.radians(-pitch))
    h = rest["fore.L"]["hip"].z
    ik = {leg: (planted(rest, leg, fwd=-front_back) if leg.startswith("fore") else planted(rest, leg, fwd=h * 0.18, meta=70))
          for leg in rest}
    if hind_only:
        ik = {leg: v for leg, v in ik.items() if leg.startswith("hind")}
    lo, hi = 0.0, rest["fore.L"]["hip"].z
    for _ in range(22):
        mid = (lo + hi) * 0.5
        poser.overreach = 0.0
        poser.solve({}, V((0, 0, -mid)), rot, ik)
        if poser.overreach > 1e-4:
            lo = mid
        else:
            hi = mid
    poser.overreach = 0.0
    return hi, rot, ik


def quad_pastimes(clip, poser, rest, arm, g, report, necks, ears, tails, tail_pitch, height, bones):
    """What a four-footed animal does standing about, beyond grazing, for
    the rigs whose gait table names them (motion.js PASTIMES plays them):

    sniff  -- nose down near the floor, sweeping side to side in short
              snuffs; the canines and the bear.
    haunch -- sitting on its haunches, forelegs straight, head up: the fox
              that 'is here staring at you'.
    snarl  -- head down and forward, lips back, ears flat, a snap; a wolf
              that 'doesn't want to be bothered'.
    howl   -- sits, points its muzzle at the sky and howls.
    rear   -- up on the hind legs, forelegs hanging, a roar; the bear that
              'must be bigger than you'.
    root   -- the snout shoving through the earth; the boar.

    The loops start and end in their own held pose and are crossfaded from
    the idle; the displays (snarl, howl, rear) start and end at the idle's
    pose, so they need no fade of their own."""
    names = g["pastimes"]
    sides = lambda d: {e: d for e in ears}

    def flat():
        return {leg: planted(rest, leg) for leg in rest}

    if "sniff" in names:
        # Nose towards the floor, not on it: a dog's neck is one joint here,
        # and folded past ~65 degrees it crumples.
        down = graze_reach(poser, rest, arm, necks, dict(pitch=4.0, face=g.get("sniff_face", 65.0),
                                                         ground=g.get("sniff_ground", 0.1), most=g.get("sniff_most", 65.0)))
        report["sniff"] = down["report"]

        def sniff(t):
            sweep = 14 * wave(t, 0.1) + 5 * wave(3 * t)
            snuff = 2.0 * max(0.0, wave(7 * t))
            fk = {"chest": (0.5 * wave(3 * t), 0, 0)}
            for n in necks:
                fk[n] = (down["neck"][n], sweep * down["share"][n], 0)
            fk["head"] = (down["head"] + snuff, sweep * 0.3, 0)
            if "jaw" in bones:
                fk["jaw"] = (0, 0, 0)
            fk.update(sides((-8, 0, 0)))
            fk.update(tail_wave(tails, t, 10, freq=2, pitch=tail_pitch))
            return dict(fk=fk, loc=V((0, 0, down["drop"])), rot=down["rot"], ik=flat())
        clip.run("sniff", 120, sniff, step=2)

    sit = g.get("sit", 44.0)
    if "haunch" in names or "howl" in names:
        drop, srot, sik = sit_drop(poser, rest, sit, height * 0.12)

        def sik_at(k):
            # Forefeet a little back under the chest; the hind feet come
            # forward under the hips with the hocks laid down on the floor.
            return {leg: (planted(rest, leg, fwd=-height * 0.12 * k) if leg.startswith("fore")
                          else planted(rest, leg, fwd=height * 0.18 * k, meta=70 * k)) for leg in rest}

        def seated(t, k, up=0.0):
            """The sitting pose at weight k (0 standing, 1 sat)."""
            rot = mathutils.Quaternion().slerp(srot, k)
            ik = sik_at(k)
            # The neck takes back most of the body's tilt, so the head is
            # carried level -- looking at you, not at the ceiling -- unless
            # it is pointed `up`.
            fk = {}
            for n in necks:
                fk[n] = ((sit * 0.55 * k - up * 0.6) / len(necks), 0, 0)
            fk["head"] = (sit * 0.35 * k - up * 0.4, 0, 0)
            fk.update(tail_wave(tails, t, 4 * k, freq=1, pitch=tail_pitch * (1 - k) + 25 * k))
            return fk, rot, ik

    if "haunch" in names:
        def haunch(t):
            fk, rot, ik = seated(t, 1.0)
            breath = wave(3 * t)
            look = hold_steps_(t, [(0.12, 10.0), (0.45, -8.0), (0.75, 0.0)])
            for n in necks:
                fk[n] = (fk[n][0] + 1.0 * breath, look * 0.5 / len(necks), 0)
            fk["head"] = (fk["head"][0], look * 0.5, 0)
            if "jaw" in bones:
                fk["jaw"] = (-g.get("pant", 0.0) * (0.5 + 0.5 * wave(6 * t)), 0, 0)
            fk.update(sides((-6 * math.exp(-((t - 0.3) * 25) ** 2), 0, 0)))
            return dict(fk=fk, loc=V((0, 0, -drop + 0.002 * breath)), rot=rot, ik=ik)
        clip.run("haunch", 150, haunch, step=2)

    if "howl" in names:
        def howl(t):
            k = ease(t / 0.15) * (1 - ease((t - 0.85) / 0.15))
            cry = ease((t - 0.2) / 0.12) * (1 - ease((t - 0.72) / 0.1))
            fk, rot, ik = seated(t, k, up=55 * cry)
            if "jaw" in bones:
                fk["jaw"] = (-18 * cry * (0.85 + 0.15 * wave(5 * t)), 0, 0)
            fk.update(sides((35 * cry, 0, 0)))
            return dict(fk=fk, loc=V((0, 0, -drop * k)), rot=rot, ik=ik)
        clip.run("howl", 150, howl)

    if "snarl" in names:
        def snarl(t):
            k = ease(t / 0.12) * (1 - ease((t - 0.82) / 0.18))
            snap = math.exp(-((t - 0.5) * 18) ** 2)
            fk = {"chest": (5 * k, 0, 0), "pelvis": (-2 * k, 0, 0)}
            # Head low and thrust forward, the muzzle level: the neck goes
            # down and the head comes back up on it.
            for n in necks:
                fk[n] = (26 * k / len(necks) - 8 * snap, 0, 0)
            fk["head"] = (-20 * k - 6 * snap, 0, 0)
            if "jaw" in bones:
                fk["jaw"] = (-(12 + 4 * wave(4 * t)) * k - 18 * snap, 0, 0)
            fk.update(sides((45 * k, 0, 0)))
            fk.update(tail_wave(tails, t, 2 * k, pitch=tail_pitch - 25 * k))
            ik = {leg: planted(rest, leg, meta=4 * k if rest[leg]["kind"] == "hind" else -3 * k) for leg in rest}
            loc = V((0, -height * 0.06 * snap, -height * 0.06 * k))
            return dict(fk=fk, loc=loc, ik=ik)
        clip.run("snarl", 75, snarl)

    if "rear" in names:
        tall = g.get("rear_pitch", 68.0)

        def rear(t):
            k = ease(t / 0.25) * (1 - ease((t - 0.78) / 0.22))
            roar = ease((t - 0.35) / 0.08) * (1 - ease((t - 0.62) / 0.1))
            rot = mathutils.Quaternion(V((1, 0, 0)), math.radians(-tall * k))
            fk = {"spine": (-6 * k, 0, 0), "chest": (-4 * k, 0, 0)}
            for n in necks:
                fk[n] = (tall * 0.5 * k / len(necks) + 10 * roar, 0, 0)
            fk["head"] = (tall * 0.35 * k - 14 * roar, 8 * wave(t, 0.2) * k, 0)
            if "jaw" in bones:
                fk["jaw"] = (-30 * roar, 0, 0)
            fk.update(sides((25 * roar, 0, 0)))
            for tg in (".L", ".R"):
                if "scapula" + tg in bones:
                    fk["scapula" + tg] = (-10 * k, 0, 0)
                # The forelegs hang in front of the chest, elbows out, paws
                # dropped: a positive pitch swings a leg back towards the
                # belly, which with the body upright is down.
                fk["upperarm" + tg] = (45 * k - 15 * roar, 0, (8 if tg == ".L" else -8) * k)
                fk["forearm" + tg] = (-55 * k - 20 * roar, 0, 0)
                fk["wrist" + tg] = (35 * k, 0, 0)
                fk["ftoe" + tg] = (25 * k, 0, 0)
            ik = {leg: planted(rest, leg) for leg in rest if leg.startswith("hind")}
            if k < 0.02:
                ik = flat()
            return dict(fk=fk, loc=V((0, 0, 0)), rot=rot, ik=ik)
        clip.run("rear", 120, rear)

    if "root" in names:
        down = graze_reach(poser, rest, arm, necks, dict(pitch=5.0, face=70.0, ground=-0.01, most=125.0))
        report["root"] = down["report"]

        def root(t):
            shove = max(0.0, wave(2 * t)) ** 2
            toss = math.exp(-((t - 0.62) * 14) ** 2)
            fk = {"chest": (1.0 * wave(2 * t), 0, 0)}
            for n in necks:
                fk[n] = (down["neck"][n] - 8 * toss * down["share"][n], 7 * wave(t, 0.2) * down["share"][n], 0)
            fk["head"] = (down["head"] + 6 * shove - 10 * toss, 4 * wave(t, 0.45), 0)
            if "jaw" in bones:
                fk["jaw"] = (-3 * shove, 0, 0)
            fk.update(sides((10 * wave(2 * t, 0.2), 0, 0)))
            fk.update(tail_wave(tails, t, 18, freq=3, pitch=tail_pitch))
            loc = V((0, -0.02 * shove * height, down["drop"]))
            return dict(fk=fk, loc=loc, rot=down["rot"], ik={leg: planted(rest, leg) for leg in rest})
        clip.run("root", 120, root, step=2)


def hold_steps_(t, keys, snap=0.05):
    """Held levels with quick changes between them, looping (as a head that
    looks one way, holds, and looks another)."""
    out = prev = keys[-1][1]
    for (t0, v) in keys:
        if t >= t0:
            out = lerp(prev, v, ease((t - t0) / snap))
        prev = v if t >= t0 else prev
    return out


def graze_reach(poser, rest, arm, necks, gz):
    """The neck and head angles that put the muzzle on the grass.

    Solved on the mesh, not the bones: the lowest vertex riding on the head
    has to come down to `ground` above the hooves, with the face at `face`
    degrees below horizontal. The body tips forward by `pitch` degrees
    about the hips first -- the forelegs, planted by IK, give at the knee --
    and the neck bends over its bones in `share` proportions, up to `most`
    degrees in all. The head's angle for the face follows exactly from the
    neck's, and the neck's is bisected for the height. Which sign lowers is
    measured, not assumed.""" 
    head_pts = []
    for o in arm.children:
        if o.type != "MESH":
            continue
        names = {vg.index: vg.name for vg in o.vertex_groups}
        for v in o.data.vertices:
            w = sum(e.weight for e in v.groups if names.get(e.group) in ("head", "jaw"))
            if w > 0.6:
                head_pts.append(tuple(o.matrix_world @ v.co))
    pts = np.array(head_pts)
    # Most of it at the root of the neck, as in the animal: the lowest joints
    # carry the flexion, and a neck bent evenly along its length is a swan's.
    shares = gz.get("share") or {1: [1.0], 2: [0.8, 0.2], 3: [0.6, 0.25, 0.15]}[len(necks)]
    share = dict(zip(necks, shares))
    # The animal faces -Y, so a positive turn about X tips its front down.
    rot = mathutils.Quaternion(V((1, 0, 0)), math.radians(gz.get("pitch", 0.0)))
    drop = -gz.get("drop", 0.0)
    ik = {leg: planted(rest, leg) for leg in rest}

    def solve(a, h):
        fk = {n: (a * share[n], 0, 0) for n in necks}
        fk["head"] = (h, 0, 0)
        poser.solve(fk, V((0, 0, drop)), rot, ik)
        D = poser.M["head"] @ poser.rest["head"].inverted()
        R = np.array(D.to_3x3())
        low = float((pts @ R.T + np.array(D.translation))[:, 2].min())
        y = poser.M["head"].col[1].xyz.normalized()
        # Signed in the body's own plane, so a face carried past the vertical
        # keeps going down instead of coming back up.
        return low, math.degrees(math.atan2(y.z, -y.y))

    sa = 1.0 if solve(20, 0)[0] < solve(0, 0)[0] else -1.0
    sh = 1.0 if solve(0, 20)[1] < solve(0, 0)[1] else -1.0

    def head_for(a):
        # The head pitches about world X, so the face turns exactly with it.
        f = solve(sa * a, 0.0)[1] + gz.get("face", 70.0)
        return sh * ((f + 180.0) % 360.0 - 180.0)

    lo, hi = 0.0, gz.get("most", 150.0)
    for _ in range(24):
        mid = (lo + hi) * 0.5
        if solve(sa * mid, head_for(mid))[0] > gz.get("ground", 0.02):
            lo = mid
        else:
            hi = mid
    a = sa * hi
    h = head_for(hi)
    low, face = solve(a, h)
    poser.overreach = 0.0
    return dict(neck={n: a * share[n] for n in necks}, head=h, share=share, rot=rot, drop=drop,
                up=-sa * gz.get("tug", 4.0),
                report=dict(neck=round(a, 1), head=round(h, 1), low=round(low, 3), face=round(face, 1)))


def foot_slip(tracks, stride, frames, duty, offsets):
    """Largest distance any planted toe tip moves over the ground during its
    stance, with the body carried forward at stride per cycle. Measured on the
    solved pose, so a clamped reach shows up here as slip."""
    worst = 0.0
    for leg, pts in tracks.items():
        anchor = None
        for i, p in enumerate(pts):
            t = i / frames
            on = ((t + offsets[leg]) % 1.0) < duty - 1e-6
            world = V((p.x, p.y - stride * t, p.z))
            if on:
                if anchor is None:
                    anchor = world
                worst = max(worst, (world - anchor).length)
            else:
                anchor = None
    return worst


# ============================================================ assembly


def build_body(spec):
    """Mesh parts, joined per material, on a fresh armature. Returns (arm, meshes, tris). The
    solids are built with the rest skeleton, so the armature goes on last."""
    body = sdf_part(spec["body"], spec["h"], spec["tris"], "body", spec.get("mat", "fur"),
                    smooth=2, mask_fn=spec.get("masks"), patch_fn=spec.get("patch"))
    parts = [body] + spec["parts"](spec["body"])
    arm = make_rig(spec["name"], spec.get("bones") or quad_bones(spec["L"]))
    # Where the legs begin, for the lie of the hair: the hind knee.
    legtop = spec["L"]["hind"][1][2] if "L" in spec and "hind" in spec["L"] else None
    meshes = bind(arm, parts, spec["name"], legtop=legtop)
    return arm, meshes, lib.stats(meshes)


# ============================================================ previews


PREVIEW_COATS = {
    "fur": ((0.36, 0.25, 0.15), (0.85, 0.80, 0.70), (0.06, 0.05, 0.04)),
}


def preview_materials(coat=(0.36, 0.25, 0.15), pale=(0.85, 0.8, 0.7), dark=(0.06, 0.05, 0.04),
                      patch=None, threshold=0.55):
    """Stand-in shading for renders: the viewer's coat/pale/points mix, done
    with nodes on the vertex colour masks."""
    for mat in bpy.data.materials:
        if not mat.name.startswith("MAT:"):
            continue
        mat.use_nodes = True
        nt = mat.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs[0], out.inputs[0])
        attr = nt.nodes.new("ShaderNodeAttribute")
        attr.attribute_name = "Col"
        if mat.name in ("MAT:fur", "MAT:feather", "MAT:scales"):
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(attr.outputs["Color"], sep.inputs[0])
            col = None

            def mix(a, b, fac):
                m = nt.nodes.new("ShaderNodeMix")
                m.data_type = "RGBA"
                if isinstance(a, tuple):
                    m.inputs[6].default_value = a + (1,)
                else:
                    nt.links.new(a, m.inputs[6])
                m.inputs[7].default_value = b + (1,)
                nt.links.new(fac, m.inputs[0])
                return m.outputs[2]
            col = coat
            if patch:
                ramp = nt.nodes.new("ShaderNodeMapRange")
                ramp.inputs[1].default_value = threshold - 0.04
                ramp.inputs[2].default_value = threshold + 0.04
                nt.links.new(sep.outputs[2], ramp.inputs[0])
                col = mix(col, patch, ramp.outputs[0])
            col = mix(col, pale, sep.outputs[0])
            col = mix(col, dark, sep.outputs[1])
            nt.links.new(col, bsdf.inputs["Base Color"])
            bsdf.inputs["Roughness"].default_value = 0.9
        else:
            nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
            bsdf.inputs["Roughness"].default_value = 0.3


def render(path, target=(0, 0, 0.35), dist=1.8, azim=35.0, elev=12.0, size=(900, 600), lens=50):
    sc = bpy.context.scene
    try:
        sc.render.engine = "BLENDER_EEVEE"
    except TypeError:
        sc.render.engine = "BLENDER_WORKBENCH"
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.render.film_transparent = False
    world = bpy.data.worlds.get("preview") or bpy.data.worlds.new("preview")
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = (0.55, 0.62, 0.72, 1)
    bg.inputs[1].default_value = 0.6
    sc.world = world
    cam = bpy.data.objects.get("pv_cam")
    if cam is None:
        cam = bpy.data.objects.new("pv_cam", bpy.data.cameras.new("pv_cam"))
        sc.collection.objects.link(cam)
        sun = bpy.data.objects.new("pv_sun", bpy.data.lights.new("pv_sun", "SUN"))
        sun.data.energy = 3.5
        sun.data.angle = math.radians(3)
        sc.collection.objects.link(sun)
        sun.rotation_euler = (math.radians(50), 0, math.radians(-30))
        bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
        ground = bpy.context.object
        ground.name = "pv_ground"
        gm = bpy.data.materials.new("pv_ground")
        gm.use_nodes = True
        gb = next(n for n in gm.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        gb.inputs["Base Color"].default_value = (0.35, 0.33, 0.3, 1)
        ground.data.materials.append(gm)
    cam.data.lens = lens
    sc.camera = cam
    a, e = math.radians(azim), math.radians(elev)
    t = V(target)
    cam.location = t + V((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    d = t - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path


def build_one(spec, export=True):
    lib.reset()
    bpy.context.scene.render.fps = FPS
    arm, meshes, tris = build_body(spec)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    report = spec.get("clips", quad_clips)(arm, spec)
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.animation_data.action = bpy.data.actions["idle"]
    arm["diku"] = json.dumps({
        "archetype": spec["archetype"],
        "stride": {k: round(v, 4) for k, v in report["stride"].items()},
        "hitFrame": {"attack": report["hit"]},
        "clips": {k: round(v, 4) for k, v in report["clips"].items()},
    })
    if export:
        export_beast(spec["name"], arm, meshes)
    return arm, meshes, tris, report


# ============================================================ library

SPECS = [canine, feline, rodent, bear, equine, cervid, bovine, pig, duck, swan, hen, songbird, snake, worm, dragon]


def build(only=None):
    """Every animal, one .glb each. One line per asset in build_all's format
    (name, triangles, then the numbers the viewer is given), so the budget
    check reads it like any other."""
    lines = []
    for make in SPECS:
        spec = make()
        if only and spec["name"] not in only:
            continue
        arm, meshes, tris, rep = build_one(spec)
        clips = " ".join("%s %.2fs" % (k, v) for k, v in rep["clips"].items())
        stride = " ".join("%s %.2fm" % (k, v) for k, v in rep["stride"].items())
        slip = " ".join("%s-slip %.1fmm" % (k, rep[k] * 1000) for k in ("walk", "run") if k in rep)
        lines.append("%-16s %5d tris  stride %s  %s  hit %.2f  | %s" % (spec["name"], tris, stride, slip,
                                                                        rep["hit"], clips))
    return "\n".join(lines)
