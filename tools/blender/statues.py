"""statues -- the carved things the rooms' own prose names indoors.

  #3054  "A huge altar made from white polished marble is standing in front of
      you and behind it is a ten foot tall sitting statue of Odin, the King of
      the Gods."  [statue odin king god] "The statue represents the one-eyed
      Odin sitting on a his throne. He has long, grey hair and beard and a
      strict look on his face. On top of the throne, just above his shoulders,
      his two ravens Hugin and Munin are sitting and at his feet are his wolves
      Gere and Freke."  [altar] "more than ten feet long ... a single block of
      white virgin marble."  ->  statue_odin, altar_marble
  #7280  "some faces are staring at you from inside the walls. In the middle of
      the room there is a small altar."  [altar] "Faces are smiling from it.
      There is a triangle in top of it."  ->  relief_face, altar_faces

The figures are signed distance fields (the beasts' machinery: round cones and
ellipsoids blended with a smooth minimum, extracted with surface nets and
pulled back onto the field), because a statue is one continuous carved surface
-- a beard that grows out of a jaw, a robe that falls over a knee -- and
primitives that meet at a crease read as a doll. The throne, the plinth and the
altars are masonry: bevelled blocks.

Conventions are the library's: Z up, metres, origin on the floor at the middle
of the footprint, front at Blender -Y (three's +Z once exported), one object per
material, metre UVs with V up anything upright.
"""

import math
import importlib

import bpy
import bmesh
import mathutils
import numpy as np

import lib
import kit
import furniture as F
import beasts as B
importlib.reload(lib)
importlib.reload(kit)
importlib.reload(F)
importlib.reload(B)

V = mathutils.Vector

PAL = {
    "marble": (0.86, 0.84, 0.80, 1.0), "statuary": (0.9, 0.88, 0.84, 1.0),
    "gold": (0.78, 0.6, 0.26, 1.0), "caverock": (0.32, 0.30, 0.28, 1.0),
    "sewerflag": (0.35, 0.33, 0.30, 1.0), "ashlar": (0.45, 0.42, 0.38, 1.0),
}
F.PAL.update(PAL)


# --- carving ----------------------------------------------------------------

def cone(a, b, ra, rb, blend=0.03, squash=None, neg=False, group=None):
    return B.cone(a, b, ra, rb, "root", blend=blend, squash=squash, neg=neg, group=group)


def ell(c, r, blend=0.03, rot=None, neg=False):
    return B.ell(c, r, "root", blend=blend, rot=rot, neg=neg)


def mirror_x(solids):
    """The same solids on the other side of the body."""
    out = []
    for s in solids:
        p = dict(s.p)
        if s.kind == "cone":
            p["a"] = (-p["a"][0], p["a"][1], p["a"][2])
            p["b"] = (-p["b"][0], p["b"][1], p["b"][2])
        else:
            p["c"] = (-p["c"][0], p["c"][1], p["c"][2])
            if p.get("m") is not None:
                m = np.array(p["m"])
                flip = np.diag([-1.0, 1.0, 1.0])
                p["m"] = (flip @ m @ flip).tolist()
        out.append(B.Solid(s.kind, s.blend, s.bind, s.mask, neg=s.neg,
                           squash=None if s.squash is None else s.squash.tolist(), group=s.group, **p))
    return out


def carve(solids, h, tris, name, m="statuary", smooth=2):
    """One carved surface: extracted, thinned to `tris` without the beasts'
    X symmetry (a statue holding a spear is not symmetric), relaxed back onto
    the field and shaded smooth."""
    verts, faces = B.surface_nets(solids, h)
    obj = B.mesh_from(verts, faces, name)
    me = obj.data
    me.calc_loop_triangles()
    if len(me.loop_triangles) > tris:
        mod = obj.modifiers.new("dec", "DECIMATE")
        mod.ratio = tris / len(me.loop_triangles)
        lib.apply_modifiers(obj)
    if smooth:
        B.relax(obj, solids, iterations=smooth)
    F.tag(obj, m)
    B.shade_smooth(obj)
    return obj


def moved(solids, offset, turn=0.0, scale=1.0):
    """Solids built about their own origin, scaled, turned about Z and set down."""
    c, s = math.cos(turn), math.sin(turn)
    R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1.0]])
    o = np.array(offset, dtype=np.float64)
    tf = lambda p: tuple(R @ (np.array(p, dtype=np.float64) * scale) + o)
    out = []
    for sd in solids:
        p = dict(sd.p)
        if sd.kind == "cone":
            p["a"], p["b"] = tf(p["a"]), tf(p["b"])
            p["ra"], p["rb"] = p["ra"] * scale, p["rb"] * scale
        else:
            p["c"] = tf(p["c"])
            p["r"] = tuple(x * scale for x in p["r"])
            m = np.array(p["m"]) if p.get("m") is not None else np.eye(3)
            # rows world->local: local = (q - c) @ m, so a turned body takes R.
            p["m"] = (R @ m).tolist()
        out.append(B.Solid(sd.kind, sd.blend * scale, sd.bind, sd.mask, neg=sd.neg,
                           squash=None if sd.squash is None else sd.squash.tolist(), group=sd.group, **p))
    return out


def slab(size, loc, m="statuary", bev=0.025, seg=2, name="slab"):
    obj = lib.box(size, loc, name=name, mat="stonewall")
    F.tag(obj, m)
    if bev:
        lib.bevel(obj, width=bev, segments=seg, angle=50)
    return obj


def post(r, z0, z1, x, y, m="statuary", verts=16, name="post"):
    obj = lib.cylinder(r, z1 - z0, (x, y, (z0 + z1) / 2), verts=verts, name=name, mat="stonewall")
    F.tag(obj, m)
    lib.bevel(obj, width=min(0.02, r * 0.3), segments=2, angle=50)
    return obj


def paint(obj, colour):
    me = obj.data
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for i in range(len(me.vertices)):
        attr.data[i].color = (colour[0], colour[1], colour[2], 1.0)
    return obj


def deliver(parts, name, colours=None):
    """Apply, bake into asset space, unwrap in metres, join per material, export.
    `colours` maps a material to the vertex colour its parts carry (a glow's
    hue); it goes out as `_col`, which assets.js takes back."""
    groups = {}
    for obj in parts:
        if obj is None:
            continue
        lib.apply_modifiers(obj)
        kit.zero_origin(obj)
        F.unwrap(obj)
        key = obj.material_slots[0].material.name[4:]
        groups.setdefault(key, []).append(obj)
    objs = []
    for key in sorted(groups):
        if colours and key in colours:
            for part in groups[key]:
                paint(part, colours[key])
        obj = lib.join(groups[key], "%s.%s" % (name, key))
        kit.zero_origin(obj)
        obj.data.name = obj.name
        if colours and key in colours:
            obj.data.color_attributes["Col"].name = "_col"
        objs.append(obj)
    tris = lib.stats(objs)
    if colours:
        lib.export(name, objs, export_vertex_color="NONE", export_attributes=True)
    else:
        lib.export(name, objs)
    lo = [min((o.matrix_world @ V(c))[i] for o in objs for c in o.bound_box) for i in range(3)]
    hi = [max((o.matrix_world @ V(c))[i] for o in objs for c in o.bound_box) for i in range(3)]
    return "%-18s %6d tris  x %.2f..%.2f  y %.2f..%.2f  z %.2f..%.2f" % (
        name, tris, lo[0], hi[0], lo[1], hi[1], lo[2], hi[2])


# --- Odin ---------------------------------------------------------------------
#
# Life size times 2.2: a seated man's head is 1.35 m off the floor, and the
# prose's ten feet is 3.05. The plinth adds 0.55 so the altar in front of it
# (1.05 high) does not hide his knees from someone standing at the altar.

PLINTH = 0.55
SEAT = 1.55          # top of the seat, on the plinth
BACK_Y = 0.80        # front face of the throne's back


def along(solids, lines, r=(0.011, 0.011), depth=0.004, steps=6, direction=(0, 1, 0), start=-1.0, neg=True, blend=None):
    """Strips that follow the surface: each line is a list of (x, z) points
    (or full (x, y, z) starts to march from along `direction`), found on the
    carved surface by marching in from outside, and a cone laid along them
    with its axis `depth` under the skin (negative: a cut) or over it (a
    raised band). Hair and beard are strands because they are cut, not
    because they are modelled; a hem is a band laid on."""
    out = []
    d = np.array(direction, dtype=float)
    for n, line in enumerate(lines):
        pts = []
        for k in range(len(line) - 1):
            p0, p1 = np.array(line[k], dtype=float), np.array(line[k + 1], dtype=float)
            for i in range(steps + (1 if k == len(line) - 2 else 0)):
                pts.append(p0 + (p1 - p0) * i / steps)
        surf = [B.surface_point(solids, (q[0], start, q[1]) if len(q) == 2 else tuple(q), d, sink=depth) for q in pts]
        m = len(surf) - 1
        for i in range(m):
            ra = r[0] + (r[1] - r[0]) * i / m
            rb = r[0] + (r[1] - r[0]) * (i + 1) / m
            out.append(cone(tuple(surf[i]), tuple(surf[i + 1]), ra, rb, blend=blend if blend is not None else min(ra, rb) * 0.8,
                            neg=neg, group="strip%d_%d" % (id(lines), n)))
    return out


def odin_body():
    S = []
    # Seated: pelvis on the seat, thighs level, shins down to a footstool.
    S += [ell((0, 0.38, 1.80), (0.50, 0.42, 0.30), blend=0.06)]
    leg = [
        cone((0.26, 0.36, 1.80), (0.30, -0.60, 1.83), 0.27, 0.21, blend=0.06),
        cone((0.30, -0.60, 1.78), (0.33, -0.74, 0.84), 0.19, 0.115, blend=0.05),
        cone((0.33, -0.76, 0.80), (0.36, -1.02, 0.74), 0.105, 0.075, blend=0.03, squash=(1.1, 1, 0.75)),
    ]
    S += leg + mirror_x(leg)
    # The robe: a lap over the thighs and a skirt that falls from the knees to
    # the feet in one sheet, as heavy cloth does over a seated man.
    S += [ell((0, -0.20, 1.92), (0.58, 0.50, 0.13), blend=0.10)]
    S += [cone((0, -0.62, 1.72), (0, -0.76, 0.76), 0.50, 0.62, blend=0.10, squash=(1.0, 0.42, 1.0))]
    # Body: a deep chest over a belted waist, shoulders under a mantle.
    S += [ell((0, 0.44, 2.18), (0.42, 0.30, 0.34), blend=0.08)]
    S += [ell((0, 0.40, 2.56), (0.54, 0.35, 0.40), blend=0.08)]
    S += [ell((0, 0.50, 2.74), (0.72, 0.42, 0.25), blend=0.10)]
    S += [ell((0.56, 0.42, 2.76), (0.22, 0.24, 0.19), blend=0.06), ell((-0.56, 0.42, 2.76), (0.22, 0.24, 0.19), blend=0.06)]
    S += [cone((0, 0.38, 2.80), (0, 0.34, 3.02), 0.16, 0.14, blend=0.06)]
    # Arms in wide sleeves. The right hand grips the spear upright at his side;
    # the left lies on his knee.
    S += [cone((-0.60, 0.42, 2.74), (-0.76, 0.30, 2.22), 0.19, 0.17, blend=0.06),
          cone((-0.76, 0.30, 2.22), (-0.80, -0.14, 2.30), 0.16, 0.12, blend=0.05),
          cone((-0.80, -0.12, 2.30), (-0.80, -0.20, 2.31), 0.135, 0.135, blend=0.02),
          ell((-0.80, -0.30, 2.31), (0.085, 0.09, 0.12), blend=0.03),
          cone((0.60, 0.42, 2.74), (0.74, 0.30, 2.20), 0.19, 0.17, blend=0.06),
          cone((0.74, 0.30, 2.20), (0.42, -0.34, 2.02), 0.16, 0.11, blend=0.05),
          cone((0.44, -0.31, 2.03), (0.40, -0.38, 2.01), 0.125, 0.125, blend=0.02),
          ell((0.36, -0.52, 1.99), (0.09, 0.13, 0.05), blend=0.03)]
    # Fingers of the left hand over the knee, the right's round the shaft.
    for x in (0.29, 0.34, 0.39, 0.43):
        S += [cone((x, -0.58, 1.99), (x + 0.01, -0.69, 1.95), 0.022, 0.02, blend=0.01)]
    for z in (2.24, 2.29, 2.34, 2.39):
        S += [cone((-0.76, -0.24, z), (-0.80, -0.37, z), 0.024, 0.024, blend=0.01)]
    body = list(S)
    # Clothed, not bare: a belt, the mantle's two edges hanging down the
    # front from the shoulders, a hem at each sleeve and round the skirt.
    S += along(body, [[(x, 2.06) for x in np.linspace(-0.40, 0.40, 9)]], r=(0.04, 0.04), depth=0.02, neg=False, steps=2, blend=0.012)
    S += along(body, [[(0.34, 2.86), (0.30, 2.55), (0.27, 2.2)], [(-0.34, 2.86), (-0.30, 2.55), (-0.27, 2.2)]],
               r=(0.035, 0.03), depth=0.016, neg=False, blend=0.015)
    S += along(body, [[(x, 1.62), (x * 1.08 + 0.02, 1.25), (x * 1.16, 0.86)] for x in (-0.42, 0.39)],
               r=(0.03, 0.07), depth=0.03)
    S += along(body, [[(0.0, 1.70), (0.015, 1.25), (0.0, 0.84)]], r=(0.04, 0.09), depth=0.05)
    # A brooch where the mantle is pinned, and a buckle.
    at = B.surface_point(body, (-0.33, -0.5, 2.72), (0, 1, 0))
    S += [ell(tuple(at), (0.075, 0.022, 0.075), blend=0.012)]
    at = B.surface_point(body, (0.0, -0.5, 2.06), (0, 1, 0), sink=-0.03)
    S += [ell(tuple(at), (0.08, 0.02, 0.06), blend=0.01)]
    return S


HEAD_C = np.array((0, 0.32, 3.34))
HEAD_R = np.array((0.185, 0.215, 0.22))


def odin_head():
    """Head, hair and beard, carved on a finer grid than the body: a face at
    this size is a few centimetres of relief, which the body's 16 mm grid
    turns into a mask."""
    S = []
    S += [cone((0, 0.37, 2.86), (0, 0.33, 3.12), 0.15, 0.13, blend=0.05)]
    S += [ell(tuple(HEAD_C), tuple(HEAD_R), blend=0.04)]
    # Jaw.
    S += [ell((0, 0.205, 3.22), (0.145, 0.14, 0.16), blend=0.06)]
    # A heavy brow, low over the eyes: the strict look.
    S += [ell((0, 0.118, 3.372), (0.145, 0.04, 0.032), blend=0.045)]
    S += [cone((0.11, 0.118, 3.378), (0.02, 0.098, 3.352), 0.018, 0.016, blend=0.02),
          cone((-0.11, 0.118, 3.378), (-0.02, 0.098, 3.352), 0.018, 0.016, blend=0.02)]
    # A straight, strong nose.
    S += [cone((0, 0.096, 3.35), (0, 0.05, 3.262), 0.02, 0.027, blend=0.02)]
    S += [ell((0.022, 0.072, 3.257), (0.02, 0.02, 0.015), blend=0.012), ell((-0.022, 0.072, 3.257), (0.02, 0.02, 0.015), blend=0.012)]
    # Deep sockets, for the shadow a statue's eyes are read by; one eye in
    # its lids. The other is under a patch on a strap.
    S += [ell((0.064, 0.11, 3.318), (0.042, 0.034, 0.026), blend=0.018, neg=True),
          ell((-0.064, 0.11, 3.318), (0.042, 0.034, 0.026), blend=0.018, neg=True)]
    S += [ell((0.064, 0.126, 3.318), (0.026, 0.016, 0.016), blend=0.008)]
    S += [ell((-0.064, 0.103, 3.322), (0.044, 0.012, 0.032), blend=0.01)]
    # Lower lip, under the moustache.
    S += [ell((0, 0.078, 3.192), (0.034, 0.018, 0.012), blend=0.012)]
    # A moustache that droops into the beard.
    S += [cone((0.006, 0.064, 3.222), (0.09, 0.07, 3.15), 0.022, 0.016, blend=0.012),
          cone((-0.006, 0.064, 3.222), (-0.09, 0.07, 3.15), 0.022, 0.016, blend=0.012)]
    # The beard: over the cheeks and chin, then long down the chest.
    S += [ell((0, 0.165, 3.16), (0.158, 0.12, 0.11), blend=0.035)]
    S += [cone((0, 0.125, 3.10), (0, 0.06, 2.66), 0.12, 0.075, blend=0.05, squash=(1, 0.55, 1))]
    # Hair: long, falling behind the shoulders and in two locks forward.
    S += [ell((0, 0.35, 3.385), (0.2, 0.225, 0.205), blend=0.035)]
    S += [cone((0, 0.47, 3.32), (0, 0.60, 2.84), 0.20, 0.27, blend=0.08, squash=(1, 0.55, 1))]
    S += [cone((0.165, 0.27, 3.28), (0.23, 0.26, 2.86), 0.058, 0.08, blend=0.045),
          cone((-0.165, 0.27, 3.28), (-0.23, 0.26, 2.86), 0.058, 0.08, blend=0.045)]
    head = list(S)
    # What the strips are laid on: the head, and the chest the beard lies on.
    probe = head + [ell((0, 0.40, 2.56), (0.54, 0.35, 0.40), blend=0.08)]

    def on_head(p, lift=0.004):
        v = (np.array(p) - HEAD_C) / HEAD_R
        v = v / np.linalg.norm(v)
        return tuple(HEAD_C + v * (HEAD_R + lift))
    # The patch's strap: up across the brow into the hair, and round the side.
    for line in ([(-0.07, 0.10, 3.36), (-0.02, 0.1, 3.42), (0.06, 0.12, 3.47), (0.12, 0.2, 3.52)],
                 [(-0.10, 0.11, 3.325), (-0.15, 0.16, 3.33), (-0.19, 0.28, 3.34)]):
        pts = [on_head(p) for p in line]
        for i in range(len(pts) - 1):
            S += [cone(pts[i], pts[i + 1], 0.011, 0.011, blend=0.005, group="strap")]
    # Strands, cut: down the beard, the moustache, the locks, the hair behind,
    # and back from the brow over the crown.
    # Clumps laid over the beard, each wandering a little as it falls and
    # ending at its own length: a beard is read by its clumps, not by lines.
    locks = []
    for i, x in enumerate((-0.09, -0.045, 0.0, 0.045, 0.09)):
        w = 0.01 * (1 if i % 2 else -1)
        end = 2.68 - 0.03 * math.cos(i * 1.9) - (0.04 if x == 0 else 0.0)
        locks.append([(x * 1.1, 3.08), (x + w, 2.92), (x * 0.85 - w, 2.78), (x * 0.65, end)])
    S += along(probe, locks, r=(0.05, 0.022), depth=0.03, neg=False, blend=0.018, steps=4)
    S += along(head, [[(x, 3.21), (x * 1.3, 3.12)] for x in (-0.13, 0.13)], r=(0.007, 0.006), depth=0.003)
    S += along(head, [[(x, 0.9, 3.36), (x * 1.3, 0.9, 3.05), (x * 1.5, 0.9, 2.86)] for x in (-0.15, -0.09, -0.03, 0.03, 0.09, 0.15)],
               r=(0.011, 0.014), depth=0.005, direction=(0, -1, 0))
    for sx in (-1, 1):
        S += along(head, [[(sx * 0.4, y, 3.1), (sx * 0.4, y + 0.01, 2.9)] for y in (0.24, 0.29)],
                   r=(0.008, 0.009), depth=0.004, direction=(-sx, 0, 0))
    S += along(head, [[(x, 0.16, 3.9), (x * 1.15, 0.45, 3.9)] for x in (-0.12, -0.06, 0.06, 0.12)],
               r=(0.008, 0.009), depth=0.003, direction=(0, 0, -1))
    return S


def odin_circlet():
    """A band of gold round the brow: the one thing on him that is not stone."""
    S = []
    for i in range(20):
        a0 = 2 * math.pi * i / 20
        a1 = 2 * math.pi * (i + 1) / 20
        pt = lambda a: (0.212 * math.cos(a), 0.33 + 0.238 * math.sin(a), 3.45 - 0.02 * math.sin(a))
        S += [cone(pt(a0), pt(a1), 0.022, 0.022, blend=0.0, group="band")]
    # A point over the brow.
    S += [cone((0, 0.09, 3.44), (0, 0.085, 3.53), 0.03, 0.006, blend=0.01)]
    return S


def wolf():
    """A wolf sitting up, facing -Y, origin under its chest. About 1.07 m to
    the ear tips before scaling."""
    S = []
    S += [ell((0, 0.20, 0.22), (0.20, 0.27, 0.20), blend=0.06)]
    S += [cone((0, 0.16, 0.30), (0, -0.05, 0.62), 0.18, 0.165, blend=0.07)]
    S += [ell((0, -0.12, 0.55), (0.15, 0.13, 0.18), blend=0.06)]
    fore = [cone((0.08, -0.12, 0.50), (0.08, -0.18, 0.05), 0.055, 0.04, blend=0.04),
            ell((0.08, -0.23, 0.03), (0.045, 0.075, 0.032), blend=0.02),
            ell((0.15, 0.13, 0.20), (0.085, 0.22, 0.15), blend=0.05),
            ell((0.16, -0.06, 0.03), (0.05, 0.11, 0.032), blend=0.03)]
    S += fore + mirror_x(fore)
    S += [ell((0, -0.08, 0.70), (0.155, 0.125, 0.13), blend=0.06)]
    S += [cone((0, -0.08, 0.66), (0, -0.14, 0.80), 0.12, 0.10, blend=0.05)]
    S += [ell((0, -0.16, 0.86), (0.11, 0.125, 0.10), blend=0.04)]
    S += [ell((0.075, -0.13, 0.80), (0.06, 0.07, 0.07), blend=0.04), ell((-0.075, -0.13, 0.80), (0.06, 0.07, 0.07), blend=0.04)]
    S += [cone((0, -0.24, 0.845), (0, -0.39, 0.81), 0.066, 0.04, blend=0.03, squash=(1, 1, 0.85))]
    S += [ell((0, -0.39, 0.815), (0.022, 0.018, 0.018), blend=0.01)]
    S += [ell((0.045, -0.235, 0.895), (0.022, 0.02, 0.014), blend=0.01, neg=True),
          ell((-0.045, -0.235, 0.895), (0.022, 0.02, 0.014), blend=0.01, neg=True)]
    ear = [cone((0.065, -0.13, 0.93), (0.08, -0.12, 1.035), 0.05, 0.008, blend=0.02, squash=(1, 0.45, 1))]
    S += ear + mirror_x(ear)
    S += [cone((0.10, 0.36, 0.06), (0.26, 0.10, 0.05), 0.065, 0.055, blend=0.04, group="tail"),
          cone((0.26, 0.10, 0.05), (0.24, -0.16, 0.04), 0.055, 0.035, blend=0.04, group="tail")]
    return S


def raven():
    """A raven perched, facing -Y, feet at the origin: 0.5 m beak to tail."""
    S = []
    S += [ell((0, 0.0, 0.20), (0.095, 0.19, 0.105), rot=(-24, 0, 0), blend=0.03)]
    S += [ell((0, -0.15, 0.33), (0.07, 0.08, 0.07), blend=0.04)]
    S += [cone((0, -0.21, 0.335), (0, -0.33, 0.315), 0.03, 0.004, blend=0.015, squash=(0.8, 1, 1))]
    S += [cone((0, 0.13, 0.15), (0, 0.34, 0.06), 0.06, 0.035, blend=0.02, squash=(1, 1, 0.35))]
    wing = [ell((0.07, 0.04, 0.215), (0.045, 0.21, 0.095), rot=(-22, 0, 0), blend=0.02)]
    S += wing + mirror_x(wing)
    legs = [cone((0.04, 0.0, 0.12), (0.04, -0.015, 0.012), 0.016, 0.012, blend=0.02),
            cone((0.04, -0.02, 0.01), (0.04, -0.09, 0.01), 0.01, 0.008, blend=0.01)]
    S += legs + mirror_x(legs)
    return S


def throne_parts():
    parts = []
    z0 = PLINTH
    # Seat block, with a raised panel on its front.
    parts.append(slab((1.90, 1.15, SEAT - z0), (0, 0.33, (z0 + SEAT) / 2), bev=0.03, name="seat"))
    parts.append(slab((1.40, 0.04, 0.62), (0, -0.26, z0 + 0.52), bev=0.012, name="seat_panel"))
    # Back, and the rail across its top.
    parts.append(slab((1.80, 0.22, 3.02 - SEAT), (0, BACK_Y + 0.11, (SEAT + 3.02) / 2), bev=0.03, name="back"))
    parts.append(slab((2.10, 0.30, 0.13), (0, BACK_Y + 0.12, 3.08), bev=0.03, name="rail"))
    parts.append(slab((1.30, 0.05, 0.9), (0, BACK_Y - 0.01, 2.45), bev=0.015, name="back_panel"))
    # Posts at the back corners, capped, which the ravens sit on.
    for s in (-1, 1):
        parts.append(slab((0.24, 0.26, 3.14 - z0), (s * 1.02, BACK_Y + 0.11, (z0 + 3.14) / 2), bev=0.03, name="post"))
        parts.append(slab((0.32, 0.34, 0.08), (s * 1.02, BACK_Y + 0.11, 3.18), bev=0.02, name="cap"))
        # Arm rest on a front post, rolled over at the front.
        parts.append(slab((0.22, 1.20, 0.12), (s * 0.99, 0.25, 2.12), bev=0.03, name="arm"))
        parts.append(slab((0.17, 0.17, 2.06 - SEAT), (s * 0.99, -0.26, (SEAT + 2.06) / 2), bev=0.02, name="armpost"))
        roll = lib.cylinder(0.105, 0.24, (s * 0.99, -0.33, 2.12), rotation=(0, math.pi / 2, 0), verts=16, name="roll", mat="stonewall")
        F.tag(roll, "statuary")
        parts.append(roll)
        # Between the arm and the seat, a solid side.
        parts.append(slab((0.10, 1.0, 2.06 - SEAT), (s * 0.99, 0.30, (SEAT + 2.06) / 2), bev=0.015, name="side"))
    # A footstool for the feet.
    parts.append(slab((1.24, 0.46, 0.14), (0, -0.84, z0 + 0.07), bev=0.02, name="stool"))
    return parts


def plinth_parts(w=4.3, d=2.16):
    return [
        slab((w, d, 0.14), (0, 0, 0.07), bev=0.03, name="plinth_base"),
        slab((w - 0.18, d - 0.14, 0.34), (0, 0.0, 0.14 + 0.17), bev=0.015, name="plinth_die"),
        slab((w - 0.04, d - 0.02, 0.07), (0, 0, PLINTH - 0.035), bev=0.025, name="plinth_cap"),
    ]


def spear():
    """Gungnir, held upright: a shaft grounded on the plinth, a leaf blade."""
    x, y = -0.80, -0.30
    shaft = lib.cylinder(0.038, 4.25 - PLINTH, (x, y, (PLINTH + 4.25) / 2), verts=12, name="shaft", mat="stonewall")
    F.tag(shaft, "statuary")
    # A collar at the socket, and the blade: a lozenge in section.
    collar = lib.cylinder(0.055, 0.12, (x, y, 4.28), verts=12, name="collar", mat="stonewall")
    F.tag(collar, "gold")
    verts = []
    prof = [(4.34, 0.05, 0.022), (4.52, 0.115, 0.03), (4.72, 0.07, 0.02), (4.86, 0.0, 0.0)]
    rings = []
    for z, w, t in prof:
        rings.append([(x + w, y, z), (x, y - t, z), (x - w, y, z), (x, y + t, z)])
    for r in rings:
        verts.extend(r)
    faces = []
    for k in range(len(rings) - 1):
        b = k * 4
        for i in range(4):
            j = (i + 1) % 4
            faces.append((b + i, b + j, b + j + 4, b + i + 4))
    faces.append((3, 2, 1, 0))
    me = bpy.data.meshes.new("blade")
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    blade = bpy.data.objects.new("blade", me)
    bpy.context.collection.objects.link(blade)
    F.tag(blade, "gold")
    return [shaft, collar, blade]


def build_statue_odin():
    lib.reset()
    parts = []
    parts += plinth_parts()
    parts += throne_parts()
    parts += spear()
    parts.append(carve(odin_body(), 0.014, 22000, "odin"))
    parts.append(carve(odin_head(), 0.005, 16000, "odin_head"))
    parts.append(carve(odin_circlet(), 0.008, 1200, "circlet", m="gold", smooth=1))
    # Geri and Freki at his feet, on the plinth either side of the stool,
    # looking out past the altar; one turned a little to the other.
    for s, turn in ((1, -0.18), (-1, 0.22)):
        parts.append(carve(moved(wolf(), (s * 1.52, -0.42, PLINTH), turn=turn, scale=1.3), 0.012, 5200, "wolf"))
    # Huginn and Muninn on the posts above his shoulders, one looking down.
    # Turned out over the room, so their tails do not run back into the wall.
    for s, turn in ((1, 0.75), (-1, -0.95)):
        parts.append(carve(moved(raven(), (s * 1.02, BACK_Y + 0.02, 3.22), turn=turn, scale=1.15), 0.008, 2200, "raven"))
    return deliver(parts, "statue_odin")


# --- the altars ----------------------------------------------------------------

def build_altar_marble():
    """"More than ten feet long ... a single block of white virgin marble":
    3.3 m, on a low step, with a sunk panel front and ends and an overhanging
    top slab. Front at -Y; the back stands to the statue."""
    lib.reset()
    L, D = 3.3, 1.0
    parts = [
        slab((L + 0.4, D + 0.44, 0.16), (0, 0, 0.08), m="marble", bev=0.03, name="step"),
        slab((L + 0.12, D + 0.12, 0.12), (0, 0, 0.16 + 0.06), m="statuary", bev=0.03, name="foot"),
        slab((L - 0.06, D - 0.06, 0.66), (0, 0, 0.28 + 0.33), m="statuary", bev=0.02, name="die"),
        slab((L + 0.16, D + 0.16, 0.12), (0, 0, 0.94 + 0.06), m="statuary", bev=0.035, name="top"),
        slab((L - 0.02, D - 0.02, 0.05), (0, 0, 0.915), m="statuary", bev=0.015, name="bed"),
    ]
    # Raised panels, three on the front and one on each end.
    for x in (-1.05, 0, 1.05):
        parts.append(slab((0.86, 0.035, 0.44), (x, -(D - 0.06) / 2 - 0.012, 0.61), bev=0.012, name="panel"))
    for s in (-1, 1):
        parts.append(slab((0.035, 0.66, 0.44), (s * ((L - 0.06) / 2 + 0.012), 0, 0.61), bev=0.012, name="panel"))
    # Two candlesticks in gold, the candles in them.
    for s in (-1, 1):
        x = s * 1.25
        for (r0, r1, z0, z1) in ((0.11, 0.09, 1.06, 1.10), (0.035, 0.03, 1.10, 1.36), (0.065, 0.05, 1.36, 1.40)):
            c = lib.cone(r0, r1, z1 - z0, (x, 0.05, (z0 + z1) / 2), verts=14, name="stick", mat="stonewall")
            F.tag(c, "gold")
            parts.append(c)
        k = lib.cylinder(0.032, 0.26, (x, 0.05, 1.53), verts=10, name="candle", mat="stonewall")
        F.tag(k, "wax")
        parts.append(k)
    return deliver(parts, "altar_marble")


def face_solids(smile=True):
    """A carved face in shallow relief, looking out of -Y, its back on y = 0:
    0.46 m brow to chin. Smiling (the altar's) or staring (the walls')."""
    S = []
    S += [ell((0, 0.03, 0.0), (0.17, 0.10, 0.23), blend=0.03)]
    S += [ell((0, -0.02, -0.14), (0.12, 0.08, 0.09), blend=0.04)]
    S += [ell((0, -0.07, 0.085), (0.15, 0.04, 0.035), blend=0.03)]
    S += [cone((0, -0.075, 0.06), (0, -0.12, -0.05), 0.024, 0.035, blend=0.02)]
    S += [ell((0.058, -0.06, 0.03), (0.036, 0.03, 0.024), blend=0.015, neg=True),
          ell((-0.058, -0.06, 0.03), (0.036, 0.03, 0.024), blend=0.015, neg=True)]
    # Staring: the balls stand in the sockets, pupils drilled.
    S += [ell((0.058, -0.052, 0.03), (0.022, 0.018, 0.016), blend=0.006),
          ell((-0.058, -0.052, 0.03), (0.022, 0.018, 0.016), blend=0.006)]
    S += [ell((0.058, -0.072, 0.03), (0.008, 0.01, 0.008), blend=0.003, neg=True),
          ell((-0.058, -0.072, 0.03), (0.008, 0.01, 0.008), blend=0.003, neg=True)]
    S += [ell((0.09, -0.04, -0.06), (0.045, 0.04, 0.035), blend=0.03), ell((-0.09, -0.04, -0.06), (0.045, 0.04, 0.035), blend=0.03)]
    # The mouth: a grin turned up at the corners, or a flat open slot.
    if smile:
        for i in range(6):
            t0 = (i / 6.0) * 2 - 1
            t1 = ((i + 1) / 6.0) * 2 - 1
            pt = lambda t: (0.065 * t, -0.085 + 0.02 * t * t, -0.125 + 0.03 * t * t)
            S += [cone(pt(t0), pt(t1), 0.011, 0.011, blend=0.004, neg=True, group="mouth")]
    else:
        S += [ell((0, -0.085, -0.13), (0.045, 0.03, 0.022), blend=0.01, neg=True)]
    return S


FACE_Z = 1.6


def build_relief_face():
    """A face pushing out of a wall: the stone round it roughed back, the face
    itself left proud. Its back sits on y = 0 so it is hung flush, front -Y."""
    lib.reset()
    S = face_solids(smile=False)
    # The stone round it roughed back to the wall: a face pushing out of the
    # masonry, not a medallion hung on it.
    S = [ell((0, 0.075, -0.02), (0.27, 0.085, 0.32), blend=0.0)] + S
    # The wall behind cuts it flat.
    S += [ell((0, 0.35, 0), (3.0, 0.33, 3.0), blend=0.0, neg=True)]
    # Hung with its middle 1.6 m up; the origin stays on the floor below it.
    obj = carve(moved(S, (0, 0, FACE_Z)), 0.008, 2400, "face", m="ashlar")
    return deliver([obj], "relief_face")


def build_altar_faces():
    """#7280: "a small altar ... Faces are smiling from it. There is a triangle
    in top of it." 1.2 m by 0.7, 0.95 high, a face on every side, a stone
    triangle stood on the top."""
    lib.reset()
    W, D, H = 1.2, 0.72, 0.9
    parts = [
        slab((W + 0.2, D + 0.2, 0.12), (0, 0, 0.06), m="ashlar", bev=0.03, name="foot"),
        slab((W, D, H - 0.2), (0, 0, 0.12 + (H - 0.2) / 2), m="ashlar", bev=0.02, name="die"),
        slab((W + 0.12, D + 0.12, 0.1), (0, 0, H - 0.03), m="ashlar", bev=0.03, name="top"),
    ]
    # Faces, smiling, out of the four sides.
    for (x, y, turn, sc) in ((0, -D / 2, 0.0, 0.95), (0, D / 2, math.pi, 0.95),
                             (W / 2, 0, math.pi / 2, 0.8), (-W / 2, 0, -math.pi / 2, 0.8)):
        solids = moved(face_solids(smile=True), (x, y, 0.47), turn=turn, scale=sc)
        # Keep only what stands proud of the side.
        parts.append(carve(solids, 0.006, 1500, "smile", m="ashlar"))
    # The triangle: a stone plate standing on the top, symbols cut in it.
    t = 0.07
    tri = [(-0.36, 0.0), (0.36, 0.0), (0.0, 0.62)]
    verts = [(x, -t / 2, z + H + 0.02) for x, z in tri] + [(x, t / 2, z + H + 0.02) for x, z in tri]
    faces = [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)]
    me = bpy.data.meshes.new("triangle")
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    obj = bpy.data.objects.new("triangle", me)
    bpy.context.collection.objects.link(obj)
    F.tag(obj, "ashlar")
    lib.bevel(obj, width=0.012, segments=2, angle=50)
    parts.append(obj)
    # Small symbols proud of its face, in rows.
    for row, (z, n) in enumerate(((0.12, 5), (0.24, 4), (0.36, 3), (0.47, 1))):
        for i in range(n):
            x = (i - (n - 1) / 2) * 0.1
            kind = (row * 3 + i) % 3
            size = (0.05, 0.012, 0.05) if kind == 0 else (0.016, 0.012, 0.06) if kind == 1 else (0.06, 0.012, 0.016)
            parts.append(slab(size, (x, -t / 2 - 0.004, H + 0.02 + z), m="gold", bev=0.0, name="glyph"))
    return deliver(parts, "altar_faces")


# --- the firedeath (#7284) -------------------------------------------------------

def build_fire_bed():
    """"There are flames surrounding you": one 3 m length of the fire that
    runs round the walls -- a bank of embers, burning logs crossed on it, a
    kerb of blackened stones in front. The wall is at y = 0; it reaches 0.95
    into -Y. src/clutter.js stands the flames up out of it."""
    lib.reset()
    import random
    rnd = random.Random(7284)
    parts = []
    bank = []
    for i in range(8):
        x = -1.3 + i * 0.37 + rnd.uniform(-0.08, 0.08)
        bank.append(ell((x, -0.42 + rnd.uniform(-0.06, 0.06), 0.0), (0.33, 0.34, 0.12 + rnd.uniform(0, 0.05)), blend=0.12))
    bank.append(ell((0, 0.4, 0), (3.0, 0.4, 1.0), blend=0.0, neg=True))
    parts.append(carve(bank, 0.03, 1400, "embers", m="emberstone", smooth=1))
    # Logs, burning where they lie: crossed, some propped on others.
    for i in range(9):
        x = -1.25 + i * 0.31 + rnd.uniform(-0.05, 0.05)
        yaw = rnd.uniform(-0.9, 0.9)
        L = rnd.uniform(0.6, 1.0)
        r = rnd.uniform(0.06, 0.1)
        lift = 0.1 + (0.12 if i % 3 == 1 else 0.0)
        pitch = rnd.uniform(0.05, 0.35) if i % 3 == 1 else rnd.uniform(-0.05, 0.05)
        log = lib.cylinder(r, L, (x, -0.45 + rnd.uniform(-0.1, 0.1), lift + r * 0.6), rotation=(math.pi / 2 + pitch, 0, yaw),
                           verts=8, name="log", mat="stonewall")
        F.tag(log, "charred")
        lib.bevel(log, width=0.015, segments=1, angle=50)
        parts.append(log)
    # The kerb.
    x = -1.45
    while x < 1.45:
        w = rnd.uniform(0.22, 0.34)
        st = slab((w, rnd.uniform(0.2, 0.26), rnd.uniform(0.14, 0.2)), (x + w / 2, -0.83, 0.07), m="ashlar", bev=0.03, seg=1, name="kerb")
        st.rotation_euler = (0, 0, rnd.uniform(-0.12, 0.12))
        parts.append(st)
        x += w + 0.02
    return deliver(parts, "fire_bed")


# --- small figures (#7410, #7420) --------------------------------------------------

def build_statue_imp():
    """#7410: "a small statue ... of a imp, pointing to the west. The imp looks
    like a man with horns and a tail." 1.25 m of it on a rough pedestal, its
    right arm out to its right -- three's -X, west, when it is stood facing
    south (rotY 0) -- the other on its hip."""
    lib.reset()
    P = 0.42   # pedestal top
    S = []
    leg = [cone((0.07, 0.0, P + 0.42), (0.08, -0.03, P + 0.2), 0.05, 0.038, blend=0.03),
           cone((0.08, -0.03, P + 0.2), (0.08, 0.02, P + 0.04), 0.036, 0.03, blend=0.02),
           cone((0.08, 0.02, P + 0.03), (0.09, -0.08, P + 0.02), 0.03, 0.022, blend=0.015, squash=(1.2, 1, 0.7))]
    S += leg + mirror_x(leg)
    S += [ell((0, 0.0, P + 0.46), (0.1, 0.075, 0.07), blend=0.04)]
    S += [cone((0, 0.0, P + 0.48), (0, 0.01, P + 0.66), 0.08, 0.1, blend=0.05, squash=(1, 0.75, 1))]
    S += [ell((0, 0.0, P + 0.68), (0.12, 0.075, 0.06), blend=0.05)]
    S += [cone((0, 0.01, P + 0.72), (0, 0.0, P + 0.78), 0.04, 0.035, blend=0.03)]
    S += [ell((0, -0.01, P + 0.84), (0.06, 0.065, 0.075), blend=0.03)]
    S += [cone((0, -0.06, P + 0.83), (0, -0.09, P + 0.8), 0.025, 0.018, blend=0.015)]
    S += [ell((0.025, -0.06, P + 0.855), (0.012, 0.01, 0.009), blend=0.005, neg=True),
          ell((-0.025, -0.06, P + 0.855), (0.012, 0.01, 0.009), blend=0.005, neg=True)]
    horn = [cone((0.035, -0.01, P + 0.9), (0.06, 0.0, P + 0.97), 0.016, 0.009, blend=0.01, group="horn"),
            cone((0.06, 0.0, P + 0.97), (0.05, 0.03, P + 1.02), 0.009, 0.002, blend=0.005, group="horn")]
    S += horn + mirror_x(horn)
    ear = [cone((0.055, 0.0, P + 0.85), (0.1, 0.02, P + 0.88), 0.018, 0.003, blend=0.01, squash=(1, 0.4, 1))]
    S += ear + mirror_x(ear)
    # Pointing: the right arm straight out to its right, forefinger out.
    S += [cone((-0.11, 0.0, P + 0.7), (-0.28, -0.02, P + 0.72), 0.032, 0.026, blend=0.02),
          cone((-0.28, -0.02, P + 0.72), (-0.43, -0.03, P + 0.74), 0.025, 0.02, blend=0.015),
          ell((-0.46, -0.03, P + 0.74), (0.03, 0.022, 0.022), blend=0.01),
          cone((-0.47, -0.03, P + 0.745), (-0.53, -0.03, P + 0.75), 0.008, 0.006, blend=0.004)]
    S += [cone((0.11, 0.0, P + 0.7), (0.17, 0.02, P + 0.58), 0.032, 0.026, blend=0.02),
          cone((0.17, 0.02, P + 0.58), (0.1, -0.01, P + 0.49), 0.025, 0.02, blend=0.015)]
    # The tail, down and round on the pedestal, ending in a barb.
    pts = [(0, 0.06, P + 0.45), (0.02, 0.16, P + 0.3), (0.08, 0.2, P + 0.1), (0.18, 0.12, P + 0.03), (0.2, 0.0, P + 0.03)]
    for i in range(len(pts) - 1):
        S += [cone(pts[i], pts[i + 1], 0.018 - i * 0.003, 0.016 - i * 0.003, blend=0.01, group="tail")]
    S += [cone((0.2, 0.0, P + 0.03), (0.21, -0.06, P + 0.03), 0.025, 0.002, blend=0.008, squash=(1, 1, 0.4))]
    # Wings folded at the back.
    wing = [ell((0.06, 0.07, P + 0.64), (0.05, 0.03, 0.14), rot=(15, 0, 20), blend=0.03)]
    S += wing + mirror_x(wing)
    parts = [carve(S, 0.004, 9000, "imp", m="ashlar")]
    parts.append(slab((0.46, 0.42, 0.08), (0, 0, 0.04), m="ashlar", bev=0.02, name="plinth"))
    parts.append(slab((0.36, 0.32, P - 0.12), (0, 0, 0.08 + (P - 0.12) / 2), m="ashlar", bev=0.015, name="die"))
    parts.append(slab((0.42, 0.38, 0.05), (0, 0, P - 0.025), m="ashlar", bev=0.015, name="cap"))
    return deliver(parts, "statue_imp")


def build_figurine_dragons():
    """#7420: "a small statue of a Dragon sleeping ... a silver dragon. It is
    nailed onto the table. The dragon sits on a red dragon that looks dead.
    But the eyes of the red dragon is glowing pulsating red." 0.45 m long,
    to stand on a table top; origin at its base."""
    lib.reset()
    R = []
    # The red one, dead on its side along the base: body, neck out flat,
    # head on the table, a wing half open under it.
    R += [ell((0, 0, 0.055), (0.16, 0.07, 0.055), blend=0.03)]
    R += [cone((-0.14, 0.0, 0.05), (-0.26, -0.04, 0.03), 0.04, 0.03, blend=0.02)]
    R += [ell((-0.3, -0.05, 0.03), (0.05, 0.035, 0.028), blend=0.015)]
    R += [cone((-0.33, -0.05, 0.03), (-0.37, -0.06, 0.025), 0.022, 0.012, blend=0.01)]
    R += [cone((0.15, 0.0, 0.04), (0.26, 0.05, 0.02), 0.035, 0.012, blend=0.02, group="rtail"),
          cone((0.26, 0.05, 0.02), (0.3, 0.11, 0.012), 0.012, 0.005, blend=0.01, group="rtail")]
    R += [ell((0.02, 0.1, 0.02), (0.12, 0.06, 0.012), rot=(0, 0, 15), blend=0.02)]
    for sx in (-1, 1):
        R += [cone((sx * 0.08, -0.05, 0.03), (sx * 0.1, -0.1, 0.012), 0.018, 0.012, blend=0.012)]
    red = carve(R, 0.004, 3200, "red", m="paint")
    eyes = carve([ell((-0.305, -0.08, 0.04), (0.009, 0.006, 0.006), blend=0.0),
                  ell((-0.305, -0.02, 0.04), (0.009, 0.006, 0.006), blend=0.0)], 0.002, 120, "eyes", m="glow", smooth=0)
    # The silver one on top, curled asleep: head on its forepaws, tail
    # wrapped round, wings folded.
    Sv = []
    top = 0.1
    Sv += [ell((0.01, 0.0, top + 0.045), (0.1, 0.065, 0.05), blend=0.03)]
    Sv += [cone((-0.07, -0.02, top + 0.05), (-0.13, -0.06, top + 0.03), 0.03, 0.022, blend=0.02)]
    Sv += [ell((-0.15, -0.075, top + 0.025), (0.04, 0.026, 0.022), rot=(0, 0, 30), blend=0.012)]
    for sx in (-1, 1):
        Sv += [cone((-0.05, sx * 0.04, top + 0.03), (-0.12, sx * 0.02 - 0.04, top + 0.008), 0.014, 0.01, blend=0.01)]
    tail = [(0.1, 0.0, top + 0.03), (0.14, -0.06, top + 0.02), (0.08, -0.1, top + 0.012), (-0.02, -0.1, top + 0.01)]
    for i in range(len(tail) - 1):
        Sv += [cone(tail[i], tail[i + 1], 0.022 - i * 0.006, 0.018 - i * 0.006, blend=0.01, group="stail")]
    wing = [ell((0.02, 0.04, top + 0.085), (0.08, 0.03, 0.02), rot=(20, 0, 0), blend=0.02)]
    Sv += wing + mirror_x(wing)
    for i, x in enumerate((-0.04, 0.0, 0.04, 0.08)):
        Sv += [cone((x, 0.0, top + 0.09), (x + 0.01, 0.0, top + 0.115 - i * 0.004), 0.008, 0.002, blend=0.004)]
    silver = carve(Sv, 0.003, 3200, "silver", m="steel")
    nail = lib.cylinder(0.006, 0.03, (0.05, 0.02, 0.005), verts=6, name="nail", mat="stonewall")
    F.tag(nail, "iron")
    return deliver([red, eyes, silver, nail], "figurine_dragons", colours={"glow": (1.0, 0.08, 0.04)})


# --- the watermill (#1124) ------------------------------------------------------

def build_millstones():
    """#1123-4: "the sound of a creaking mill". A pair of millstones in their
    wooden tun on a hurst frame, the hopper over them on its horse, the
    stone spindle up through the floor above, and the great spur wheel of
    the gearing under the frame, half of it showing. 2.4 m square, 3.2 high;
    front at -Y."""
    lib.reset()
    parts = []
    # The hurst: a platform on four posts.
    H = 0.9
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(slab((0.18, 0.18, H), (sx * 1.0, sy * 1.0, H / 2), m="wood", bev=0.02, name="post"))
    parts.append(slab((2.3, 2.3, 0.1), (0, 0, H + 0.05), m="wood", bev=0.02, name="deck"))
    # Stones in a round wooden tun.
    tun = lib.cylinder(0.78, 0.36, (0, 0, H + 0.1 + 0.18), verts=24, name="tun", mat="stonewall")
    F.tag(tun, "wood")
    parts.append(tun)
    lid = lib.cylinder(0.8, 0.04, (0, 0, H + 0.1 + 0.38), verts=24, name="tunlid", mat="stonewall")
    F.tag(lid, "wood")
    parts.append(lid)
    # The runner stone showing through the lid's opening would be hidden;
    # the bedstone's edge shows at the front, where a board is out.
    stone = lib.cylinder(0.72, 0.22, (0, 0, H + 0.1 + 0.11), verts=28, name="stone", mat="stonewall")
    F.tag(stone, "flagstone")
    parts.append(stone)
    # The horse and hopper.
    for sx in (-1, 1):
        parts.append(slab((0.08, 0.08, 0.7), (sx * 0.42, 0.0, H + 0.52 + 0.35), m="wood", bev=0.01, name="horse"))
    verts = []
    for z, w in ((H + 0.95, 0.12), (H + 1.5, 0.42)):
        verts += [(-w, -w, z), (w, -w, z), (w, w, z), (-w, w, z)]
    faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (3, 2, 1, 0)]
    me = bpy.data.meshes.new("hopper")
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    hop = bpy.data.objects.new("hopper", me)
    bpy.context.collection.objects.link(hop)
    F.tag(hop, "wood")
    lib.solidify(hop, 0.03)
    parts.append(hop)
    parts.append(slab((0.9, 0.08, 0.08), (0, 0, H + 1.22), m="wood", bev=0.01, name="bar"))
    # The spindle, up into the ceiling.
    spindle = lib.cylinder(0.07, 3.3 - H, (0.0, 0.62, H + (3.3 - H) / 2), verts=8, name="spindle", mat="stonewall")
    F.tag(spindle, "wood")
    parts.append(spindle)
    # The spur wheel under the deck, between the posts: rim, arms, cogs.
    ring = lib.torus(0.7, 0.06, (0, 0, 0.55), (0, 0, 0), major_seg=28, minor_seg=6, name="rim", mat="stonewall")
    F.tag(ring, "wood")
    parts.append(ring)
    for k in range(4):
        a = k * math.pi / 4
        parts.append(slab((1.4, 0.08, 0.08), (0, 0, 0.55), m="wood", bev=0.01, name="arm"))
        parts[-1].rotation_euler = (0, 0, a)
    for k in range(24):
        a = 2 * math.pi * k / 24
        cog = slab((0.07, 0.05, 0.1), (math.cos(a) * 0.78, math.sin(a) * 0.78, 0.55), m="wood", bev=0.0, name="cog")
        cog.rotation_euler = (0, 0, a)
        parts.append(cog)
    shaft = lib.cylinder(0.1, 0.9, (0, 0, 0.45), verts=10, name="shaft", mat="stonewall")
    F.tag(shaft, "wood")
    parts.append(shaft)
    return deliver(parts, "millstones")


# --- looking at it ---------------------------------------------------------------

def preview(names, path="/tmp/statues-preview.png", azim=-24.0, elev=10.0, dist=None, center=None, res=1100, sun=(40.0, 30.0), lens=45.0, pitch=5.0):
    import os
    lib.reset()
    placed = []
    for i, name in enumerate(names):
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(lib.ASSETS, "%s.glb" % name))
        for obj in set(bpy.context.scene.objects) - before:
            if obj.parent is None:
                obj.location.x += (i - (len(names) - 1) / 2) * pitch
            placed.append(obj)
    for mat in bpy.data.materials:
        key = mat.name.replace("MAT:", "").split(".")[0]
        if mat.node_tree:
            bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf:
                c = PAL.get(key, (0.6, 0.6, 0.6, 1.0))
                bsdf.inputs["Base Color"].default_value = (c[0], c[1], c[2], 1.0)
                bsdf.inputs["Roughness"].default_value = 0.3 if key == "gold" else 0.55
                if key == "gold":
                    bsdf.inputs["Metallic"].default_value = 1.0
    kit.human(-(len(names) - 1) / 2 * pitch - 2.6, 0.0)
    kit.rake(azim=sun[0], elev=sun[1], strength=4.0, fill=0.35)
    bpy.context.view_layer.update()
    top = max((max((o.matrix_world @ V(c)).z for c in o.bound_box) for o in placed if o.type == "MESH"), default=3.0)
    c = center or (0, 0, top * 0.5)
    return kit.shot(path, center=c, dist=dist or (top * 2.4 + len(names) * pitch * 0.6), azim=azim, elev=elev, res=res, lens=lens)


BUILDERS = {
    "statue_odin": build_statue_odin,
    "altar_marble": build_altar_marble,
    "relief_face": build_relief_face,
    "altar_faces": build_altar_faces,
    "fire_bed": build_fire_bed,
    "statue_imp": build_statue_imp,
    "figurine_dragons": build_figurine_dragons,
    "millstones": build_millstones,
}


def build(only=None):
    out = []
    for name, fn in BUILDERS.items():
        if only and name not in only:
            continue
        out.append(fn())
    return "\n".join(out)
