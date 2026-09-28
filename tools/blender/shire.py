"""shire -- what a hobbit builds, for the Shire's rooms.

The mud's Shire is a village of a different people, and until this module it
was built with the town's parts: a plaster box with a garage-wide square hole
in it and square casements, which a judge photographed from fifteen metres
as a Mediterranean garage. What makes a hobbit's house a hobbit's is small
and specific, and all of it is here:

* `shire_door_ring` -- the round doorway. The world's openings are 3.2 x 3.1 m
  and the viewer cannot cut a circle, so this is the surround that makes one
  of the square hole: a ring of dressed stone voussoirs round a circle of
  1.6 m radius whose centre stands 1.3 m up -- so the floor cuts the circle
  into the flat-bottomed round of every hobbit door -- with the corners of
  the square filled in plaster through the wall's whole thickness, the round
  reveal inside it, and a flush threshold stone.
* `shire_door_leaf` -- the door that fills that circle, painted: boards cut to
  the same truncated round, an iron rim, straps and the knob in the middle.
  Hung like `door_leaf`: hinge edge at x = 0, leaf along +X, boards in the
  y = 0 plane, ironwork on the -Y face.
* `shire_fence` -- a 2.4 m length of paling between two posts, weathered oak.
* `shire_flowerbed` -- a stone-edged bed of earth with a cottage garden in it.
* `shire_window_box` -- a painted box of flowers for under a round window.

Blender +Y is three's -Z, so every piece that has a front faces Blender +Y
and build.js turns it out with FACE_ROT. Origins on the ground. Geometry only:
`plaster`, `stonewall`, `flagstone`, `doorboard`, `doorgreen` and `blooms` are
viewer recipes; a door's colour is swapped per door by the viewer.
"""

import math
import random
import importlib

import bpy
import bmesh
import mathutils

import lib
import kit
import trees
importlib.reload(lib)
importlib.reload(kit)
importlib.reload(trees)


# The doorway, in the wall's plane: x across, z up, y out of the wall.
DOOR_R = 1.6          # the circle: as wide as the world's 3.2 m opening
DOOR_CZ = 1.3         # its centre, so the floor cuts it 1.87 m wide
OPEN_W = 3.2
OPEN_H = 3.1
WALL_T = 0.7          # WALL_IN + WALL_OUT: the outer face is y = 0, the inner y = -0.7


def solid(verts, faces, name, mat):
    """A mesh from lists, its faces turned outward whatever order they came in."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return lib.assign(obj, mat)


def prism(outline, y0, y1, name, mat):
    """A convex outline in the x-z plane extruded from y0 to y1."""
    n = len(outline)
    verts = [(x, y0, z) for (x, z) in outline] + [(x, y1, z) for (x, z) in outline]
    faces = [tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, j + n, i + n))
    return solid(verts, faces, name, mat)


def circle_x(z, r=DOOR_R, cz=DOOR_CZ):
    """Half-width of the door circle at height z (0 outside it)."""
    d = r * r - (z - cz) ** 2
    return math.sqrt(d) if d > 0 else 0.0


def circle_z(x, r=DOOR_R, cz=DOOR_CZ):
    """(bottom, top) of the circle at x."""
    d = r * r - x * x
    h = math.sqrt(d) if d > 0 else 0.0
    return cz - h, cz + h


# --- the doorway ------------------------------------------------------------------

def build_door_ring():
    lib.reset()
    p = []
    rng = random.Random(1101)
    # Where the circle meets the floor, as an angle from the horizontal.
    a0 = math.asin(-DOOR_CZ / DOOR_R)
    a1 = math.pi - a0
    # The voussoirs: dressed stone, a keystone a little proud at the crown.
    n = 17
    r_in, r_out = DOOR_R, DOOR_R + 0.38
    for i in range(n):
        t0 = a0 + (a1 - a0) * i / n + 0.004
        t1 = a0 + (a1 - a0) * (i + 1) / n - 0.004
        key = i == n // 2
        ro = r_out + (0.12 if key else rng.uniform(-0.03, 0.03))
        pts = []
        for t in (t0, t1):
            pts.append((r_in * math.cos(t), DOOR_CZ + r_in * math.sin(t)))
        for t in (t1, t0):
            pts.append((ro * math.cos(t), DOOR_CZ + ro * math.sin(t)))
        # Clip anything under the floor to the floor.
        pts = [(x, max(0.0, z)) for (x, z) in pts]
        proud = 0.12 if key else rng.uniform(0.07, 0.1)
        p.append(prism(pts, -0.05, proud, "voussoir", "stonewall"))
    # The corners of the square opening, filled through the wall: columns of
    # plaster whose inner edge follows the circle, above it and below it.
    cols = 24
    for i in range(cols):
        xa = -OPEN_W / 2 + OPEN_W * i / cols
        xb = xa + OPEN_W / cols
        (ba, ta), (bb, tb) = circle_z(xa), circle_z(xb)
        top = OPEN_H + 0.02
        if min(ta, tb) < top:
            p.append(prism([(xa, min(ta, top)), (xb, min(tb, top)), (xb, top), (xa, top)],
                           -WALL_T - 0.01, -0.02, "spandrel", "plaster"))
        if max(ba, bb) > 0.0:
            p.append(prism([(xa, 0.0), (xb, 0.0), (xb, max(bb, 0.0)), (xa, max(ba, 0.0))],
                           -WALL_T - 0.01, -0.02, "spandrel", "plaster"))
    # The reveal: the round of the opening, through the wall, facing in.
    seg = 40
    ring = []
    for i in range(seg + 1):
        t = a0 + (a1 - a0) * i / seg
        ring.append((DOOR_R * math.cos(t), DOOR_CZ + DOOR_R * math.sin(t)))
    for (xa, za), (xb, zb) in zip(ring, ring[1:]):
        # A thin band a few cm outside the circle, so its inner face is the reveal.
        na = mathutils.Vector((xa, za - DOOR_CZ)).normalized() * 0.04
        nb = mathutils.Vector((xb, zb - DOOR_CZ)).normalized() * 0.04
        p.append(prism([(xa, max(0.0, za)), (xb, max(0.0, zb)),
                        (xb + nb.x, max(0.0, zb + nb.y)), (xa + na.x, max(0.0, za + na.y))],
                       -WALL_T - 0.01, 0.0, "reveal", "plaster"))
    # The threshold: one worn flag across the floor of the opening.
    # (in the ring's own stone: a material more is a draw more in every region)
    p.append(kit.slab((2.0, WALL_T + 0.3, 0.05), (0, -WALL_T / 2 + 0.12, 0.0), mat="stonewall",
                      name="threshold", width=0.015))
    return kit.deliver(p, "shire_door_ring")


def board_cut(x0, x1, cx, y0, y1, r, cz, name, mat):
    """One vertical board of the leaf, top and bottom cut to the round and the
    bottom stopped at the floor: `props.chord_board` for a truncated circle."""
    def span(x):
        b, t = circle_z(x - cx, r, cz)
        return max(0.02, b), max(0.06, t)
    (b0, t0), (b1, t1) = span(x0), span(x1)
    verts = [(x0, y0, b0), (x1, y0, b1), (x1, y0, t1), (x0, y0, t0),
             (x0, y1, b0), (x1, y1, b1), (x1, y1, t1), (x0, y1, t0)]
    faces = [(0, 1, 2, 3), (7, 6, 5, 4), (0, 4, 5, 1), (3, 2, 6, 7), (0, 3, 7, 4), (1, 5, 6, 2)]
    return solid(verts, faces, name, mat)


def build_door_leaf():
    lib.reset()
    p = []
    r = DOOR_R - 0.02
    cx = DOOR_R
    boards, gap = 11, 0.012
    bw = (2 * r - (boards - 1) * gap) / boards
    for i in range(boards):
        x0 = cx - r + i * (bw + gap)
        jitter = ((i * 2654435761) % 7 - 3) * 0.002
        p.append(board_cut(x0, x0 + bw, cx, -0.03 + jitter, 0.03 + jitter, r, DOOR_CZ,
                           "board%d" % i, "doorgreen"))
    # Ledges behind, short of the rim.
    for z in (DOOR_CZ - 0.55, DOOR_CZ + 0.55):
        w = 2 * circle_x(z, r - 0.12)
        p.append(kit.timber((w, 0.05, 0.17), (cx, 0.055, z), (0, 0, 0), "doorboard", 0.012, "ledge"))
    # The iron rim along the round, a flat band on the street face.
    a0 = math.asin(max(-1.0, (0.03 - DOOR_CZ) / r))
    a1 = math.pi - a0
    seg = 36
    for i in range(seg):
        t0 = a0 + (a1 - a0) * i / seg
        t1 = a0 + (a1 - a0) * (i + 1) / seg
        pts = []
        for (t, rr) in ((t0, r - 0.07), (t1, r - 0.07), (t1, r), (t0, r)):
            pts.append((cx + rr * math.cos(t), max(0.02, DOOR_CZ + rr * math.sin(t))))
        p.append(prism(pts, -0.05, -0.03, "rim", "iron"))
    # The knob, in the middle, where Bag End's is.
    p.append(lib.loft([(-0.17, 0.028, 0.028, cx, DOOR_CZ), (-0.14, 0.06, 0.06, cx, DOOR_CZ),
                       (-0.105, 0.072, 0.072, cx, DOOR_CZ), (-0.075, 0.045, 0.045, cx, DOOR_CZ),
                       (-0.03, 0.034, 0.034, cx, DOOR_CZ)],
                      sides=10, axis="y", name="knob", mat="iron"))
    p.append(lib.cone(0.11, 0.09, 0.022, (cx, -0.042, DOOR_CZ), (math.pi / 2, 0, 0), verts=12,
                      name="rose", mat="iron"))
    # Strap hinges from the hinge edge, and their knuckles.
    for z in (DOOR_CZ - 0.62, DOOR_CZ + 0.62):
        reach = cx - circle_x(z, r) + 1.1
        p.append(kit.timber((reach, 0.014, 0.09), (reach / 2, -0.042, z), (0, 0, 0), "iron", 0.006, "strap"))
        p.append(lib.cylinder(0.036, 0.22, (0.02, -0.03, z), verts=10, name="knuckle", mat="iron"))
    return kit.deliver(p, "shire_door_leaf")


# --- the garden ---------------------------------------------------------------------

def build_fence():
    """2.4 m of paling: a post at each end, two rails, riven pales with their
    tops cut to a point, each a little off true."""
    lib.reset()
    rng = random.Random(1201)
    p = []
    L = 2.4
    for x in (-L / 2, L / 2):
        p.append(kit.timber((0.1, 0.1, 1.08), (x, 0, 0.54), (0, 0, rng.uniform(-0.03, 0.03)),
                            "doorboard", 0.012, "post"))
        p.append(lib.cone(0.075, 0.0, 0.08, (x, 0, 1.12), verts=4, name="cap", mat="doorboard"))
    for z in (0.28, 0.74):
        p.append(kit.timber((L, 0.05, 0.07), (0, -0.07, z), (rng.uniform(-0.01, 0.01), 0, 0),
                            "doorboard", 0.01, "rail"))
    n = 15
    for i in range(n):
        x = -L / 2 + 0.12 + (L - 0.24) * (i + 0.5) / n
        h = 0.92 + rng.uniform(-0.04, 0.04)
        w = 0.085 + rng.uniform(-0.01, 0.01)
        # Each pale a little off true: its head leans, its foot stays put.
        lean = rng.uniform(-0.035, 0.035)
        p.append(prism([(x - w / 2, 0.06), (x + w / 2, 0.06), (x + w / 2 + lean, h - 0.07), (x + lean, h),
                        (x - w / 2 + lean, h - 0.07)], -0.115, -0.095, "pale", "doorboard"))
    return kit.deliver(p, "shire_fence")


def bloom_mass(cards, rng, x0, x1, y0, y1, z, height, count):
    """Sprays of `blooms` fanning up out of a strip of earth."""
    centre = mathutils.Vector(((x0 + x1) / 2, (y0 + y1) / 2, z))
    for i in range(count):
        base = mathutils.Vector((rng.uniform(x0, x1), rng.uniform(y0, y1), z - 0.02))
        a = rng.uniform(0, 2 * math.pi)
        e = rng.uniform(0.75, 1.35)
        u = mathutils.Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
        side = u.cross(mathutils.Vector((0, 0, 1)))
        if side.length < 1e-3:
            side = mathutils.Vector((1, 0, 0))
        length = height * rng.uniform(0.7, 1.15)
        cards.card(base, u, side.normalized(), length, length * 0.85, 0.3,
                   trees.outward(base + u * length * 0.5, centre - mathutils.Vector((0, 0, 0.2)), 0.6))


def build_flowerbed():
    """1.8 x 0.6 m of turned earth behind an edge of field stones, planted."""
    lib.reset()
    rng = random.Random(1301)
    p = []
    L, D = 1.8, 0.6
    p.append(lib.loft([(0.0, L / 2, D / 2, 0, 0), (0.1, L / 2 - 0.02, D / 2 - 0.02, 0, 0),
                       (0.13, L / 2 - 0.12, D / 2 - 0.08, 0, 0)], sides=12, name="earth", mat="dirt"))
    # The edge: stones along the front and ends.
    x = -L / 2
    while x < L / 2 - 0.05:
        w = rng.uniform(0.16, 0.26)
        for y in (-D / 2, D / 2):
            p.append(kit.slab((w - 0.02, 0.12, 0.13 + rng.uniform(-0.02, 0.03)),
                              (x + w / 2, y + rng.uniform(-0.02, 0.02), 0.06),
                              (0, 0, rng.uniform(-0.15, 0.15)), mat="stonewall", name="edge", width=0.03))
        x += w
    cards = trees.Cards("blooms", tile=0.45)
    bloom_mass(cards, rng, -L / 2 + 0.12, L / 2 - 0.12, -D / 2 + 0.1, D / 2 - 0.1, 0.12, 0.42, 34)
    return trees.deliver_conifer(p, cards.mesh("blooms"), "shire_flowerbed")


def build_window_box():
    """A painted trough on two brackets, full of flowers: what goes under a
    round window. Its back is on y = 0, the wall, and it stands out to +Y."""
    lib.reset()
    rng = random.Random(1401)
    p = []
    L, D, H = 1.15, 0.26, 0.2
    p.append(kit.timber((L, D, H), (0, D / 2 + 0.02, H / 2), (0, 0, 0), "doorgreen", 0.012, "box"))
    # Brackets painted with the box, and no soil: the flowers cover it, and
    # each material is a draw more in every region the boxes stand in.
    for x in (-L / 2 + 0.15, L / 2 - 0.15):
        p.append(kit.timber((0.05, D, 0.05), (x, D / 2 + 0.02, -0.05), (0, 0, 0), "doorgreen", 0.006, "bracket"))
    cards = trees.Cards("blooms", tile=0.4)
    bloom_mass(cards, rng, -L / 2 + 0.06, L / 2 - 0.06, 0.06, D - 0.02, H - 0.01, 0.3, 18)
    return trees.deliver_conifer(p, cards.mesh("blooms"), "shire_window_box")


def build_lantern_post():
    """What lights a Shire lane after dark instead of the town's iron lamp
    standards: an oak post as high as a hobbit's door, an arm off it, and a
    pierced lantern hung from the arm's end at (0.62, 0, ~1.95). The flame is
    the viewer's."""
    lib.reset()
    p = []
    H = 2.55
    p.append(kit.timber((0.15, 0.15, H), (0, 0, H / 2), (0, 0, 0), "doorboard", 0.02, "post"))
    p.append(lib.cone(0.12, 0.0, 0.1, (0, 0, H + 0.05), verts=4, name="cap", mat="doorboard"))
    p.append(kit.timber((0.78, 0.1, 0.11), (0.33, 0, H - 0.12), (0, 0, 0), "doorboard", 0.012, "arm"))
    p.append(kit.timber((0.5, 0.07, 0.07), (0.2, 0, H - 0.38), (0, math.radians(38), 0), "doorboard", 0.01, "brace"))
    # The lantern: a hook, a hood, six ribs, a pan.
    x = 0.62
    top = H - 0.2
    p.append(lib.torus(0.035, 0.008, (x, 0, top - 0.02), (math.pi / 2, 0, 0), major_seg=6, minor_seg=3,
                       name="hook", mat="iron"))
    p.append(lib.cone(0.04, 0.13, 0.16, (x, 0, top - 0.13), verts=8, name="hood", mat="iron"))
    for k in range(6):
        a = 2 * math.pi * k / 6
        p.append(kit.timber((0.016, 0.016, 0.3), (x + math.cos(a) * 0.11, math.sin(a) * 0.11, top - 0.36),
                            (0, 0, 0), "iron", 0.003, "rib"))
    p.append(lib.cylinder(0.13, 0.035, (x, 0, top - 0.52), verts=8, name="pan", mat="iron"))
    return kit.deliver(p, "shire_lantern_post")


def build_waterwheel():
    """An overshot wheel for the mill, and the trough that feeds it: 5 m
    across and 1.1 m wide, its axle in the mill wall at y = 0 and the wheel
    standing out to +Y; the launder comes in over the top from +X."""
    lib.reset()
    rng = random.Random(1501)
    p = []
    R = 2.5
    cz = R + 0.25          # its foot in the tail race, a quarter-metre down
    W = 1.1
    # The wheel's middle plane, out from the wall: clear of the eave, which
    # oversails the mill's wall by 1.1 m (build.js SHIRE_SPAN).
    yc = 2.05
    for side in (-1, 1):
        y = yc + side * W / 2
        # The shrouds: a ring of short planks each side.
        n = 20
        for i in range(n):
            t0 = 2 * math.pi * i / n; t1 = 2 * math.pi * (i + 1) / n - 0.01
            pts = []
            for (t, r) in ((t0, R - 0.34), (t1, R - 0.34), (t1, R), (t0, R)):
                pts.append((r * math.cos(t), cz + r * math.sin(t)))
            p.append(prism(pts, y - 0.04, y + 0.04, "shroud", "doorboard"))
        # Eight arms from the hub.
        for i in range(8):
            t = 2 * math.pi * (i + 0.5) / 8
            p.append(kit.timber((R - 0.3, 0.1, 0.14), (math.cos(t) * (R - 0.3) / 2, y, cz + math.sin(t) * (R - 0.3) / 2),
                                (0, -t, 0), "doorboard", 0.012, "arm"))
    # The buckets between the shrouds, and the sole behind them.
    n = 24
    for i in range(n):
        t = 2 * math.pi * i / n
        c, s_ = math.cos(t), math.sin(t)
        p.append(kit.timber((0.34, W - 0.06, 0.04), (c * (R - 0.17), yc, cz + s_ * (R - 0.17)),
                            (0, -t + 0.5, 0), "doorboard", 0.006, "bucket"))
    for i in range(n):
        t0 = 2 * math.pi * i / n; t1 = 2 * math.pi * (i + 1) / n
        pts = [((R - 0.36) * math.cos(t0), cz + (R - 0.36) * math.sin(t0)), ((R - 0.36) * math.cos(t1), cz + (R - 0.36) * math.sin(t1)),
               ((R - 0.32) * math.cos(t1), cz + (R - 0.32) * math.sin(t1)), ((R - 0.32) * math.cos(t0), cz + (R - 0.32) * math.sin(t0))]
        p.append(prism(pts, yc - W / 2 + 0.04, yc + W / 2 - 0.04, "sole", "doorboard"))
    # The axle, from the wall through the hub, iron-bound.
    p.append(lib.cylinder(0.16, yc + W / 2 + 0.25, (0, (yc + W / 2 + 0.25) / 2 - 0.05, cz), (math.pi / 2, 0, 0),
                          verts=12, name="axle", mat="doorboard"))
    for y in (yc - W / 2 - 0.08, yc + W / 2 + 0.08):
        p.append(lib.cylinder(0.2, 0.08, (0, y, cz), (math.pi / 2, 0, 0), verts=12, name="hub", mat="iron"))
    # A stone pier under the axle's outer end, and a bearing block on the wall.
    p.append(kit.slab((0.7, 0.6, cz - 0.1), (0, yc + W / 2 + 0.45, (cz - 0.1) / 2), mat="stonewall", name="pier", width=0.04))
    p.append(kit.timber((0.5, 0.3, 0.5), (0, 0.12, cz), (0, 0, 0), "doorboard", 0.02, "bearing"))
    # The launder: a plank trough on trestles, coming in over the top.
    lz = cz + R + 0.3
    p.append(kit.timber((3.2, 0.8, 0.08), (1.4, yc, lz), (0, 0, 0), "doorboard", 0.01, "launder"))
    for s in (-1, 1):
        p.append(kit.timber((3.2, 0.06, 0.34), (1.4, yc + s * 0.37, lz + 0.17), (0, 0, 0), "doorboard", 0.008, "cheek"))
    p.append(kit.slab((3.0, 0.62, 0.03), (1.5, yc, lz + 0.1), mat="water", name="race", width=0.004))
    for x in (1.7, 2.9):
        p.append(kit.timber((0.14, 0.14, lz), (x, yc, lz / 2), (0, 0, rng.uniform(-0.02, 0.02)), "doorboard", 0.012, "trestle"))
    # The tail race it turns in: a stone-lined pit of water under the wheel.
    p.append(kit.slab((R * 2 + 0.6, W + 0.9, 0.05), (0, yc, 0.05), mat="water", name="tail", width=0.004))
    for s in (-1, 1):
        p.append(kit.slab((R * 2 + 1.0, 0.3, 0.45), (0, yc + s * (W / 2 + 0.6), 0.2), mat="stonewall", name="kerb", width=0.03))
    for s in (-1, 1):
        p.append(kit.slab((0.3, W + 1.5, 0.45), (s * (R + 0.45), yc, 0.2), mat="stonewall", name="kerb", width=0.03))
    return kit.deliver(p, "shire_waterwheel")


BUILDERS = {
    "shire_door_ring": build_door_ring,
    "shire_door_leaf": build_door_leaf,
    "shire_fence": build_fence,
    "shire_flowerbed": build_flowerbed,
    "shire_window_box": build_window_box,
    "shire_lantern_post": build_lantern_post,
    "shire_waterwheel": build_waterwheel,
}


def build(only=None):
    out = []
    for name, fn in BUILDERS.items():
        if only and name not in only:
            continue
        out.append(fn())
    return "\n".join(out)


PREVIEW = {
    "plaster": (0.86, 0.82, 0.72), "stonewall": (0.55, 0.52, 0.47), "flagstone": (0.5, 0.48, 0.44),
    "doorgreen": (0.12, 0.3, 0.14), "doorboard": (0.38, 0.3, 0.22), "iron": (0.1, 0.1, 0.1),
    "dirt": (0.3, 0.22, 0.15), "blooms": (0.7, 0.3, 0.35), "water": (0.2, 0.35, 0.4),
}


def preview(names, path="/tmp/shire-preview.png", cols=3, pitch=5.0, elev=12.0, azim=-18.0, dist=None, res=1200):
    """Import what was exported and look at it under a raking sun."""
    import os
    lib.reset()
    placed = []
    for i, name in enumerate(names):
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(lib.ASSETS, "%s.glb" % name))
        dx = (i % cols - (cols - 1) / 2.0) * pitch
        dy = -(i // cols) * pitch
        for obj in set(bpy.context.scene.objects) - before:
            if obj.parent is None:
                obj.location.x += dx
                obj.location.y += dy
            placed.append(obj)
    for mat in bpy.data.materials:
        key = mat.name.replace("MAT:", "").split(".")[0]
        if mat.node_tree:
            bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf:
                c = PREVIEW.get(key, (0.6, 0.6, 0.6))
                bsdf.inputs["Base Color"].default_value = (c[0], c[1], c[2], 1.0)
                bsdf.inputs["Roughness"].default_value = 0.8
    kit.rake(azim=58.0, elev=24.0, strength=4.0, fill=0.25)
    rows = (len(names) + cols - 1) // cols
    span = max(cols, rows) * pitch
    return kit.shot(path, center=(0, -(rows - 1) * pitch / 2, 1.2), dist=dist or span * 1.1, azim=azim, elev=elev,
                    res=res, lens=40.0)
