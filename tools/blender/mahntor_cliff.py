"""mahntor_cliff -- the mountain Mahn-Tor stands on.

  #2361 "You cling to the side of the cliff. Looking down, you are terrified
      by the sheer distance to the ground below." #2362 "You stand at the edge
      of a high cliff." The city is 38 m up, over the lowland, on a face of
      rock -- not on a stack of boxes.

The pieces are masses of rock to be set against the steep ground that
`buildHills` (build.js) leaves under the city, so they carry the face and the
hill carries everything else. Conventions are setpiece.py's: Z up, metres,
origin on the ground in the middle of the piece's width, the FRONT at -Y
(which the exporter turns to three's +Z: the way the rock looks out; build.js
turns it with atan2(dx, dz) of the way the ground falls), the mountain behind
it at +Y. One
mesh per material, `MAT:crag` for rock and `MAT:gravel` for the scree.

A MASS is a closed shell: a front that is a relief map over (across, height),
two flat sides, a back, a top and a bottom. The relief is the point.

  * Strata. Rock is laid in beds, 2.6 to 4.4 m, each harder or softer than
    the one under it: a bed's top stands out as a lip and its foot is cut
    back, the beds wander with a slow noise so a course is not level, and every
    bed has its own hardness, so no two ledges are the same depth.
  * Joints. Narrow vertical clefts the frost has opened, deep and sharp, and
    a few wide ones that run through several beds.
  * Buttresses. Ribs a few metres wide that stand proud of the face from the
    foot to the crest and break the face into planes.
  * The crest is rounded off and broken, and the upper beds overhang.
  * The face leans back as it rises: lower sections are proud of upper ones.

Tiling: every mass is 13.6 m wide, 0.6 m over the cell, and in the 1.4 m at
each side of it the relief eases to the one lean they share, so neighbours
meet on the same line and hide the join by lapping. They differ in height,
in how hard the beds stand out and in where the ribs are.

The BROW is the one of them that is not a face: the rock that carries the
city's floor over the ledge of #2361, 13.6 m of it, its underside the ledge's
ceiling. The SCREE is what has fallen off all of this: boulders and a fan of
gravel at the foot.
"""

import math
import importlib

import bpy
import bmesh
import mathutils

import lib
import kit
import furniture as F
import setpiece as S
import desert as D
importlib.reload(lib)
importlib.reload(kit)
importlib.reload(F)
importlib.reload(S)
importlib.reload(D)

PAL = {"crag": (0.36, 0.35, 0.34, 1.0), "gravel": (0.40, 0.38, 0.35, 1.0)}
F.PAL.update(PAL)
S.PAL.update(PAL)

W = 13.6           # a mass's width: a cell and 0.6 m to lap by
EDGE = 1.4         # the margin at each side where the relief eases to the shared lean


def _smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def _hash(i, seed):
    return D._hashn(i, 7, 3, seed)


def _plates(u, h, seed, cu, ch):
    """Fractured rock as plates: a Voronoi of jittered points, stretched tall,
    each plate standing a little proud or sunk and tilted its own way, with a
    crack along every border. Returns (offset, crack) -- the crack is 0 in the
    middle of a plate and 1 on the line between two."""
    gu, gh = u / cu, h / ch
    iu, ih = math.floor(gu), math.floor(gh)
    best = (9.0, None)
    second = 9.0
    for du in (-1, 0, 1):
        for dh in (-1, 0, 1):
            ci, cj = iu + du, ih + dh
            pu = ci + _hash(ci * 131 + cj, seed + 5)
            ph = cj + _hash(ci * 977 + cj * 31, seed + 9)
            d = math.hypot((gu - pu) * cu, (gh - ph) * ch * 0.8)
            if d < best[0]:
                second = best[0]
                best = (d, (ci, cj, pu, ph))
            elif d < second:
                second = d
    ci, cj, pu, ph = best[1]
    off = (_hash(ci * 31 + cj * 17, seed + 21) - 0.5) * 1.7
    tu = (_hash(ci * 7 + cj * 13, seed + 23) - 0.5) * 0.45
    th = (_hash(ci * 19 + cj * 5, seed + 27) - 0.5) * 0.3
    off += tu * (u - pu * cu) + th * (h - ph * ch)
    gap = second - best[0]
    crack = 1.0 - _smooth(0.0, 0.26, gap)
    return off, crack


def face_relief(w, H, seed, lean=0.2, bed=3.4, hard=1.0, ribs=(), clefts=(), crest=2.0, over=1.6, taper=4.5, belly=1.4):
    """The front of a mass as a function of (u, h) -> how far it stands out
    in front of its own back, metres. `lean` is metres of face per metre of
    height lost to the lean; `hard` scales the beds; `ribs` is (u, width,
    h0, h1, out) and `clefts` (u, width, depth, h0, h1)."""

    def f(u, h):
        t = h / H
        # The lean: the foot stands out and the crest is set back.
        p = lean * (H - h) * (0.55 + 0.45 * (1 - t))
        # The mass is a bulge in the hill and not a block stood against it: its
        # sides tuck back into the slope and are never seen, so what shows is
        # an outcrop, with gullies between it and the next.
        q = abs(u) / (w / 2)
        p -= taper * _smooth(0.3, 1.0, q) * (1.0 + 0.5 * D.fbm3((h * 0.1, 4.0, 0.0), seed + 61, 2))
        p += belly * math.sin(math.pi * t) * (1 - q * q)
        edge = _smooth(0.0, EDGE, min(u + w / 2, w / 2 - u))
        # Beds: each one has its hardness, and the course wanders.
        wav = D.fbm3((u * 0.07, 3.0, h * 0.02), seed + 3, 2) * 2.6 - 1.3
        s = h / bed + wav / bed * 1.6
        k = math.floor(s)
        r = s - k
        hardness = 0.35 + 1.15 * _hash(k, seed + 11)
        # The lip stands at the top of the bed and the foot is cut back under it.
        strata = hard * hardness * (1.15 * r ** 4 - 0.45) * 1.7
        # Plates and the cracks between them.
        off, crack = _plates(u, h, seed, 4.2, bed * 1.6)
        plates = hard * off * 0.6 - 0.9 * crack ** 2 * _smooth(1.0, 5.0, h)
        for (cu, cw, cd, h0, h1) in clefts:
            d = abs(u - cu) / cw
            if d < 1.0 and h0 <= h <= h1:
                v = _smooth(h0, h0 + 2.5, h) * (1 - _smooth(h1 - 2.5, h1, h))
                plates -= cd * (1 - d * d) ** 2 * v
        # Buttresses: ribs standing proud of the face.
        rib = 0.0
        for (ru, rw, h0, h1, ro) in ribs:
            d = abs(u - ru) / rw
            if d < 1.0 and h0 - 2 <= h <= h1 + 2:
                v = _smooth(h0 - 2, h0 + 3, h) * (1 - _smooth(h1 - 3, h1 + 2, h))
                rib += ro * (1 - d * d) * v
        noise = (D.fbm3((u * 0.16, 5.0, h * 0.1), seed, 3) - 0.5) * 4.2
        noise += (D.fbm3((u * 0.9, 9.0, h * 0.6), seed + 19, 2) - 0.5) * 0.25
        # The upper beds are the hard ones and hang out over the soft ones
        # under them; the very top is broken back.
        ov = over * _smooth(0.55, 0.9, t) * (0.6 + 0.8 * D.fbm3((u * 0.15, 2.0, 0.0), seed + 31, 2))
        top = -crest * _smooth(0.82, 1.0, t) * (0.5 + 1.4 * D.fbm3((u * 0.35, 8.0, 0.0), seed + 37, 3))
        # The foot: the face eases forward into the scree, so it is not a wall
        # stood on a lawn.
        foot = 1.6 * (1 - _smooth(0.0, 5.0, h))
        return p + edge * (strata + plates + rib + noise + ov + top) + foot

    return f


def _mesh(name, verts, faces, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return S.tag(obj, mat)


def _finish(obj):
    """Weld, point every face out of the mass, and shade it smooth: a rock
    is not faceted."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.0005)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(obj.data)
    bm.free()
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.data.update()
    return obj


def mass(name, w, H, D_, front, cell=0.36, back_down=0.0, bottom=None, top=None):
    """A closed shell: `front(u, h)` is the relief, the rest is flat unless
    `bottom(u, y)` / `top(u, y)` give a displacement for those faces."""
    nu = max(2, int(round(w / cell)))
    nh = max(4, int(round(H / (cell * 1.1))))
    verts = []
    idx = {}

    def vert(key, co):
        if key not in idx:
            idx[key] = len(verts)
            verts.append(co)
        return idx[key]

    us = [-w / 2 + w * i / nu for i in range(nu + 1)]
    hs = [H * j / nh for j in range(nh + 1)]
    for i, u in enumerate(us):
        for j, h in enumerate(hs):
            vert(("f", i, j), (u, -front(u, h), h))
    faces = []
    # The front, seen from -Y: x to the right, z up.
    for i in range(nu):
        for j in range(nh):
            faces.append((idx[("f", i, j)], idx[("f", i + 1, j)], idx[("f", i + 1, j + 1)], idx[("f", i, j + 1)]))
    # Sides: from the front's edge column to the back, in strips of the same height.
    for side, i in ((-1, 0), (1, nu)):
        u = us[i]
        for j in range(nh):
            a = idx[("f", i, j)]
            b = idx[("f", i, j + 1)]
            ca = vert(("sb", side, j), (u, D_, hs[j]))
            cb = vert(("sb", side, j + 1), (u, D_, hs[j + 1]))
            faces.append((a, ca, cb, b) if side < 0 else (a, b, cb, ca))
    # Top and bottom: from the front's edge to the back, one strip per column.
    for i in range(nu):
        u0, u1 = us[i], us[i + 1]
        t0 = vert(("tb", i), (u0, D_, H))
        t1 = vert(("tb", i + 1), (u1, D_, H))
        faces.append((idx[("f", i, nh)], t0, t1, idx[("f", i + 1, nh)]))
        b0 = vert(("bb", i), (u0, D_, 0.0))
        b1 = vert(("bb", i + 1), (u1, D_, 0.0))
        faces.append((idx[("f", i, 0)], idx[("f", i + 1, 0)], b1, b0))
    # The back: one flat polygon round the whole loop of back vertices.
    loop = [idx[("bb", i)] for i in range(nu + 1)]
    loop += [idx[("sb", 1, j)] for j in range(1, nh + 1)]
    loop += [idx[("tb", i)] for i in range(nu - 1, -1, -1)]
    loop += [idx[("sb", -1, j)] for j in range(nh - 1, 0, -1)]
    faces.append(tuple(loop))
    return _finish(_mesh(name, verts, faces, "crag"))


# --- the face pieces --------------------------------------------------------

def build_cliff_a():
    """The broad face: 30 m of rock in six or seven beds, a cleft through the
    middle and a buttress down the left."""
    S.reset(4101)
    f = face_relief(W, 30.0, 4101, lean=0.17, bed=3.6, hard=1.0,
                    ribs=((-2.6, 2.4, 0.0, 25.0, 2.8),),
                    clefts=((2.6, 0.9, 3.0, 6.0, 27.0),))
    return S.deliver([mass("cliff_a", W, 30.0, 9.0, f)], "mahntor_cliff_a")


def build_cliff_b():
    """The same height and a different hand: harder beds, the buttress on the
    right, two clefts."""
    S.reset(4102)
    f = face_relief(W, 30.0, 4102, lean=0.17, bed=3.0, hard=1.25,
                    ribs=((2.4, 2.1, 2.0, 28.0, 2.5), (-4.4, 1.3, 0.0, 15.0, 1.4)),
                    clefts=((-1.8, 0.8, 2.6, 8.0, 24.0),))
    return S.deliver([mass("cliff_b", W, 30.0, 9.0, f)], "mahntor_cliff_b")


def build_cliff_c():
    """A low shoulder, 14 m, for where the face is still coming up out of the
    hill or going back into it: softer beds and a slope to it."""
    S.reset(4103)
    f = face_relief(W, 14.0, 4103, lean=0.30, bed=2.6, hard=0.8,
                    ribs=((0.8, 2.2, 0.0, 9.0, 1.2),), clefts=(), crest=1.4, over=0.8)
    return S.deliver([mass("cliff_c", W, 14.0, 9.0, f)], "mahntor_cliff_c")


# --- the brow ---------------------------------------------------------------

BROW_H = 14.37     # the city floor over the ledge, less the 9 m that stays clear


def _brow(name, seed, ribs, clefts, bed):
    S.reset(seed)
    d = 13.6
    f = face_relief(W, BROW_H, seed, lean=-0.08, bed=bed, hard=1.1, ribs=ribs, clefts=clefts,
                    crest=0.0, over=0.3, taper=0.0, belly=0.0)
    # The front eases out of the ledge's own mouth, so the soffit has a lip.
    g = lambda u, h: f(u, h) + 1.6 * (1 - _smooth(0.0, 3.0, h))
    block = mass("brow", W, BROW_H, d, g, cell=0.4)
    # The soffit: rough and cut up into the rock. Its vertices are the ones at
    # the bottom, whose height is lifted by a noise that is zero at the lip.
    for v in block.data.vertices:
        if v.co.z < 0.01:
            depth = (v.co.y + 1.0) / d
            k = D.fbm3((v.co.x * 0.45, v.co.y * 0.45, 4.0), seed + 1, 3)
            v.co.z = 0.0 + max(0.0, (k - 0.35) * 2.6) * _smooth(0.0, 0.25, depth)
    block.data.update()
    return S.deliver([block], name)


def build_cliff_brow():
    """The rock that carries #2362's floor over the ledge of #2361: a
    13.6 m block 14.4 m deep. Its front is the face with the beds hanging out
    over the ledge, its underside the ledge's ceiling -- cut up into the rock,
    never down, because the doorway at the back of the ledge stands to that
    height."""
    return _brow("mahntor_cliff_brow", 4105, ((4.2, 1.5, 0.0, BROW_H, 1.0),), ((-3.0, 0.7, 1.6, 2.0, BROW_H),), 3.0)


def build_cliff_brow_b():
    """The same over the ledge's flanks, in another hand, so the three do not
    repeat: the rib on the other side, the beds a little thinner."""
    return _brow("mahntor_cliff_brow_b", 4115, ((-3.6, 1.8, 0.0, BROW_H, 1.2),), ((3.4, 0.8, 1.8, 3.0, BROW_H),), 2.6)


# --- the scree ----------------------------------------------------------------

def _boulder(cx, cy, cz, rx, ry, rz, seed):
    """A lopsided rounded stone sunk a third into what it sits on."""
    prof = [(0.00, 0.50), (0.14, 0.90), (0.38, 1.0), (0.62, 0.90), (0.80, 0.66), (0.93, 0.36), (1.00, 0.10)]
    sec = [(cz - rz * 0.35 + rz * 1.35 * t, rx * r, ry * r, cx, cy) for t, r in prof]
    obj = lib.loft(sec, sides=9, axis="z", name="boulder", mat="crag")
    for v in obj.data.vertices:
        k = 1.0 + 0.22 * math.sin(v.co.x * 3.1 + seed) * math.cos(v.co.y * 2.7 + seed * 1.7) \
            + 0.14 * math.sin(v.co.z * 4.3 + seed * 0.7)
        v.co.x = cx + (v.co.x - cx) * k
        v.co.y = cy + (v.co.y - cy) * k
    obj.data.update()
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return S.tag(obj, "crag")


def build_scree():
    """What has come off the face: a fan of gravel from the foot of the rock
    down to the lowland, 13.6 m wide and 9 m out, with the stones that did
    not stop -- big ones at the foot, small ones at the toe. The foot, at +Y,
    is 3.4 m up; the toe at -Y runs out to nothing."""
    S.reset(4106)
    depth, n = 9.0, 18
    verts, faces = [], []
    nu, nv = 27, 18
    for j in range(nv + 1):
        for i in range(nu + 1):
            u = -W / 2 + W * i / nu
            t = j / nv                      # 0 at the toe, 1 at the foot
            y = -depth + (depth + 0.6) * t
            h = 3.6 * t ** 1.4 - 0.25
            e = _smooth(0.0, 1.4, min(u + W / 2, W / 2 - u))
            h += e * ((D.fbm3((u * 0.5, y * 0.5, 2.0), 4107, 3) - 0.5) * 1.1 * (0.3 + t))
            if j == 0:
                h = -0.25
            verts.append((u, y, h))
    for j in range(nv):
        for i in range(nu):
            a = j * (nu + 1) + i
            faces.append((a, a + 1, a + nu + 2, a + nu + 1))
    fan = _finish(_mesh("fan", verts, faces, "gravel"))
    # Faces were wound for a surface that looks up and out; recalc has made it so.
    parts = [fan]
    for k in range(n):
        t = _hash(k, 4108)
        u = -W / 2 + 0.9 + (W - 1.8) * _hash(k, 4109)
        y = -depth * 0.8 + (depth * 0.8 + 0.2) * (0.25 + 0.75 * t) ** 1.0
        size = 0.45 + 1.9 * (t ** 1.7)
        base = 3.6 * ((y + depth) / (depth + 0.6)) ** 1.4 - 0.25
        parts.append(_boulder(u, y, base + size * 0.35, size * (0.9 + 0.5 * _hash(k, 4110)),
                              size * (0.8 + 0.5 * _hash(k, 4111)), size * (0.55 + 0.4 * _hash(k, 4112)), k * 1.7))
    return S.deliver(parts, "mahntor_scree")


BUILDERS = {
    "mahntor_cliff_a": build_cliff_a,
    "mahntor_cliff_b": build_cliff_b,
    "mahntor_cliff_c": build_cliff_c,
    "mahntor_cliff_brow": build_cliff_brow,
    "mahntor_cliff_brow_b": build_cliff_brow_b,
    "mahntor_scree": build_scree,
}


def build(only=None):
    out = []
    for name, fn in BUILDERS.items():
        if only and name not in only:
            continue
        out.append(fn())
    return "\n".join(out)
