"""furniture -- what the rooms are furnished with: the tavern's tables, benches,
stools, bar and back-bar, a hearth, and the tools of each trade the shops keep.

These replace boxes. actors.js used to build every table, bench and counter out
of flat-coloured cuboids, and next to a town that is modelled and textured they
read as programmer art. The motion system seats people on this furniture by
*collision shapes* that live in actors.js (`furniture`), and those shapes are
the contract: every dimension a body is fitted to is kept here to the
millimetre, and is noted where it is used --

  table top      1.50 x 0.75, surface at 0.830 (a 6 cm top from 0.770)
  table legs     at (+-0.62, +-0.28)
  table bench    1.40 x 0.34, seat surface at 0.455; its legs at x +-0.52
  bar stool      r 0.19, seat surface at 0.665
  counter        4.40 x 0.72 carcase, 1.06 to the middle of a 9 cm top that is
                 4.58 x 0.96 -- surface at 1.105
  wall bench     props.py's bench: 1.85 x 0.42, seat surface at 0.485, back
                 0.13-0.21 behind the seat's middle

Conventions are the library's: Z up, metres, origin on the floor. Anything that
stands against a wall is modelled with the wall at y = 0 reaching out into -Y,
which the exporter turns into three's +Z -- the fitting frame actors.js builds
in. Free-standing pieces are centred on the origin with their front at -Y.

Every surface is a `MAT:` tag the viewer swaps for a baked material. Wood is
`wood`, a close-grained oak that has no floorboard seams in it; the UVs of
every wooden part are laid along the part's own long axis so the grain runs
down a leg and along a board instead of across both.
"""

import math
import random
import importlib

import bpy
import bmesh
import mathutils

import lib
import kit
import props
importlib.reload(lib)
importlib.reload(kit)
importlib.reload(props)

V = mathutils.Vector

# Viewport and preview colours only -- the real surfaces are in textures.js and
# assets.js. Anything not here falls back to lib.PALETTE.
PAL = {
    "wood": (0.33, 0.21, 0.12, 1.0), "planks": (0.40, 0.27, 0.16, 1.0),
    "pewter": (0.55, 0.56, 0.55, 1.0), "brass": (0.72, 0.55, 0.26, 1.0),
    "bottle": (0.16, 0.28, 0.17, 1.0), "earthenware": (0.60, 0.38, 0.24, 1.0),
    "wax": (0.90, 0.85, 0.72, 1.0), "bread": (0.72, 0.46, 0.22, 1.0),
    "soot": (0.17, 0.15, 0.13, 1.0), "blanket": (0.55, 0.22, 0.15, 1.0),
    "firebrick": (0.55, 0.30, 0.20, 1.0), "flagstone": (0.50, 0.48, 0.44, 1.0),
    "ash": (0.45, 0.43, 0.40, 1.0), "charred": (0.16, 0.13, 0.11, 1.0),
    "rock": (0.52, 0.48, 0.42, 1.0), "mail": (0.45, 0.46, 0.47, 1.0),
    "rope": (0.60, 0.50, 0.33, 1.0), "wicker": (0.62, 0.50, 0.30, 1.0),
    "linen": (0.85, 0.82, 0.74, 1.0), "bone": (0.82, 0.78, 0.66, 1.0),
    "paint": (0.72, 0.70, 0.66, 1.0),
}

# Wooden things get their UVs along their grain; everything else is projected
# with V running up the world, so brick courses and bark ridges stay level.
GRAINED = {"wood", "planks", "leather", "blanket"}

rng = random.Random(1)


def reset(seed):
    lib.reset()
    rng.seed(seed)


def mat(name):
    m = lib.material(name)
    if name in PAL:
        m.diffuse_color = PAL[name]
    return m


def tag(obj, name):
    obj.data.materials.clear()
    obj.data.materials.append(mat(name))
    return obj


# --- UVs ------------------------------------------------------------------

def _grain_axis(verts):
    """The direction a part is longest in, by its spread rather than its box:
    a brace set at 40 degrees has its grain along the brace."""
    c = V((0, 0, 0))
    for v in verts:
        c += v
    c /= max(1, len(verts))
    cov = mathutils.Matrix(((0, 0, 0), (0, 0, 0), (0, 0, 0)))
    for v in verts:
        d = v - c
        for i in range(3):
            for j in range(3):
                cov[i][j] += d[i] * d[j]
    x = V((0.577, 0.577, 0.577))
    for _ in range(40):
        y = cov @ x
        if y.length < 1e-9:
            return V((1, 0, 0))
        x = y.normalized()
    return x


def unwrap(obj):
    """Metre UVs for one part, already in asset space.

    Grained materials: U along the part's grain projected into each face, V
    across it -- the baked `wood` runs its grain along U. End grain (a face the
    grain points out of) gets any orientation, which is what end grain is.
    Everything else: V is world Z on anything upright, so courses and ridges
    run level, and (x, y) on anything flat."""
    me = obj.data
    names = [s.material.name[4:] for s in obj.material_slots if s.material]
    grained = bool(names) and names[0] in GRAINED
    g = _grain_axis([v.co for v in me.vertices]) if grained else None
    off = (rng.random() * 3.0, rng.random() * 3.0)
    # One layer, one name. bmesh's verify() calls a layer it has to create
    # 'Float2', and join() keeps only the layers the active part has by name:
    # every timber, prism and loft joined onto a primitive box came out with
    # all its UVs at (0, 0) -- one texel of wood, flat as paint.
    if not me.uv_layers:
        me.uv_layers.new(name="UVMap")
    me.uv_layers[0].name = "UVMap"
    bm = bmesh.new()
    bm.from_mesh(me)
    uvl = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        if g is not None:
            t = g - n * g.dot(n)
            if t.length < 0.35:
                k = max(range(3), key=lambda i: abs(n[i]))
                t = V((0, 0, 1)) if k != 2 else V((1, 0, 0))
                t = t - n * t.dot(n)
            t.normalize()
            s = n.cross(t)
        elif abs(n.z) > 0.7:
            t, s = V((1, 0, 0)), V((0, 1, 0))
        else:
            t = V((-n.y, n.x, 0))
            if t.length < 1e-6:
                t = V((1, 0, 0))
            t.normalize()
            s = V((0, 0, 1))
        for loop in f.loops:
            p = loop.vert.co
            loop[uvl].uv = (p.dot(t) + off[0], p.dot(s) + off[1])
    bm.to_mesh(me)
    bm.free()
    me.update()


def deliver(parts, name):
    """Apply, bake each part into asset space, unwrap it by its own grain,
    join by material, export. Same report line as kit.deliver."""
    parts = [p for p in parts if p is not None]
    for obj in parts:
        lib.apply_modifiers(obj)
        kit.zero_origin(obj)
        unwrap(obj)
    obj = lib.join(parts, name)
    kit.zero_origin(obj)
    obj.data.name = name
    tris = lib.stats([obj])
    lib.export(name, [obj])
    return "%-16s %5d tris" % (name, tris)


# --- parts ----------------------------------------------------------------

def board(size, loc, rot=(0, 0, 0), m="wood", wear=0.006, name="board"):
    """A board with every edge eased. The ease is what makes a top read as
    handled for years instead of cut yesterday: 44 triangles a board."""
    obj = lib.box(size, loc, rot, name=name, mat="wood")
    tag(obj, m)
    if wear > 0:
        kit.bev(obj, wear)
    return obj


def worn(size, loc, m="wood", wear=0.016, name="top"):
    """A board whose edges are rounded over, two segments: a bar top, a table
    top, the arris elbows have been on for decades."""
    obj = lib.box(size, loc, name=name, mat="wood")
    tag(obj, m)
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = wear
    mod.segments = 2
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(40)
    return obj


def beam(size, loc, rot=(0, 0, 0), m="wood", cham=0.012, name="beam"):
    return tag(kit.timber(size, loc, rot, "wood", cham, name), m)


def strut(a, b, w, d=None, m="wood", cham=0.01, name="strut"):
    """A member from point a to point b, `w` x `d` in section -- legs that
    splay, braces, the rungs of a stool. Built along Z and turned to fit."""
    a, b = V(a), V(b)
    d = d if d is not None else w
    L = (b - a).length
    obj = kit.timber((w, d, L), (0, 0, 0), (0, 0, 0), "wood", cham, name)
    tag(obj, m)
    q = V((0, 0, 1)).rotation_difference((b - a).normalized())
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = q
    obj.location = (a + b) / 2
    return obj


def rod(a, b, r, m="iron", verts=6, name="rod"):
    a, b = V(a), V(b)
    L = (b - a).length
    obj = lib.cylinder(r, L, (0, 0, 0), verts=verts, name=name, mat="iron")
    tag(obj, m)
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = V((0, 0, 1)).rotation_difference((b - a).normalized())
    obj.location = (a + b) / 2
    return obj


def lathe(profile, x=0.0, y=0.0, z=0.0, sides=10, m="earthenware", smooth=True, caps=True,
          name="turned", sx=1.0, sy=1.0):
    """A turned or thrown thing: `profile` is (height, radius) from the foot up."""
    obj = lib.loft([(z + h, r * sx, r * sy, x, y) for (h, r) in profile], sides=sides,
                   name=name, mat="wood", caps=caps)
    tag(obj, m)
    if smooth:
        # A turned thing has 7 to 14 sides, 26 to 51 degrees a facet, and
        # the library's 35 degree default leaves most of them faceted. The
        # hoop and lip steps are right angles and stay sharp at 70.
        lib.shade_smooth(obj, angle=70)
    return obj


def prism(profile, x0, x1, m="wood", name="prism", axis="x"):
    """A flat outline extruded: `profile` is (a, b) points, counter-clockwise,
    in the plane across `axis`; the solid runs x0..x1 along it. Used for the
    shaped ends of a bench or a shelf bracket -- a notch is an outline, not a
    boolean."""
    n = len(profile)
    verts = []
    for t in (x0, x1):
        for (a, b) in profile:
            if axis == "x":
                verts.append((t, a, b))
            elif axis == "y":
                verts.append((a, t, b))
            else:
                verts.append((a, b, t))
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, j + n, i + n))
    if axis == "y":
        faces = [tuple(reversed(f)) for f in faces]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    # One consistent outward winding whatever the outline was drawn as.
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    return tag(obj, m)


def frustum(lo, hi, z0, z1, m="firebrick", name="frustum"):
    """A box whose top and bottom rectangles differ: `lo` and `hi` are
    (x0, x1, y0, y1) at z0 and z1. A hood, an anvil's waist."""
    verts = []
    for (x0, x1, y0, y1), z in ((lo, z0), (hi, z1)):
        verts += [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
    faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return tag(obj, m)


def peg(x, y, z, r=0.011, h=0.006, m="wood", axis="z"):
    """The end of a peg or a through-tenon, a few mm proud. 6 sides: at the
    size anyone sees one it is a dot of end grain, and a dot is what reads."""
    rot = {"z": (0, 0, 0), "y": (math.pi / 2, 0, 0), "x": (0, math.pi / 2, 0)}[axis]
    return tag(lib.cylinder(r, h, (x, y, z), rot, verts=6, name="peg", mat="wood"), m)


# --- small things on tables, counters and shelves -------------------------

def tankard(x, y, z, m="wood", turn=0.0):
    """A staved tankard with a hoop at lip and foot as steps in the profile,
    or a pewter one, and a handle. Seen at a table's distance the hoops and
    the handle are what say tankard rather than cup."""
    parts = []
    if m == "pewter":
        prof = [(0, 0.048), (0.012, 0.048), (0.02, 0.043), (0.13, 0.041), (0.135, 0.044)]
    else:
        prof = [(0, 0.048), (0.024, 0.048), (0.026, 0.044), (0.112, 0.042), (0.114, 0.046), (0.14, 0.046)]
    parts.append(lathe(prof, x, y, z, sides=8, m=m, name="tankard"))
    parts.append(lathe([(prof[-1][0] - 0.02, prof[-1][1] - 0.004), (prof[-1][0] - 0.018, prof[-1][1] - 0.004)],
                       x, y, z, sides=8, m="bread", smooth=False, name="ale"))
    hm = "iron" if m == "wood" else m
    h = kit.place([lib.box((0.03, 0.014, 0.022), (0.062, 0, 0.105), name="handle", mat="iron"),
                   lib.box((0.014, 0.014, 0.085), (0.075, 0, 0.068), name="handle", mat="iron"),
                   lib.box((0.03, 0.014, 0.02), (0.062, 0, 0.03), name="handle", mat="iron")],
                  (x, y, z), (0, 0, turn))
    parts += [tag(o, hm) for o in h]
    return parts


def bottle(x, y, z, h=0.3, r=0.042, m="bottle"):
    k = h / 0.3
    prof = [(0, r * 0.94), (0.01 * k, r), (0.17 * k, r), (0.215 * k, r * 0.42),
            (0.28 * k, r * 0.34), (0.3 * k, r * 0.38)]
    return [lathe(prof, x, y, z, sides=7, m=m, name="bottle"),
            lathe([(0.3 * k, r * 0.3), (0.318 * k, r * 0.3)], x, y, z, sides=6, m="wood",
                  smooth=False, name="cork")]


def jug(x, y, z, h=0.26, r=0.075, turn=0.0, m="earthenware"):
    k = h / 0.26
    prof = [(0, r * 0.72), (0.01 * k, r * 0.82), (0.09 * k, r), (0.17 * k, r * 0.86),
            (0.22 * k, r * 0.5), (0.25 * k, r * 0.55), (0.26 * k, r * 0.6)]
    parts = [lathe(prof, x, y, z, sides=10, m=m, name="jug")]
    c, s = math.cos(turn), math.sin(turn)
    pts = [(r * 0.5, 0.235 * k), (r * 1.25, 0.2 * k), (r * 1.3, 0.12 * k), (r * 0.95, 0.07 * k)]
    for i in range(3):
        a, b = pts[i], pts[i + 1]
        parts.append(strut((x + c * a[0], y + s * a[0], z + a[1]), (x + c * b[0], y + s * b[0], z + b[1]),
                           0.016, 0.026, m=m, cham=0.005, name="handle"))
    return parts


def plate(x, y, z, r=0.13, tilt=1.2, turn=0.0, m="pewter"):
    """Stood on its rim against the wall behind a shelf, the way plates are
    shown off."""
    obj = lathe([(0, r * 0.6), (0.006, r * 0.62), (0.014, r), (0.018, r)], 0, 0, 0, sides=12,
                m=m, smooth=False, name="plate")
    obj.rotation_euler = (tilt, 0, turn)
    obj.location = (x, y, z)
    return obj


def candle(x, y, z, m="brass", h=0.14):
    """A pricket stick with its drip pan and a candle burnt part way down."""
    return [lathe([(0, 0.05), (0.01, 0.05), (0.014, 0.018), (0.07, 0.012), (0.075, 0.035),
                   (0.083, 0.035), (0.086, 0.012)], x, y, z, sides=9, m=m, name="stick"),
            lathe([(0.086, 0.014), (0.086 + h * 0.8, 0.013), (0.086 + h, 0.009)], x, y, z,
                  sides=7, m="wax", name="candle")]


def loaf(x, y, z, L=0.28, w=0.13, h=0.09, turn=0.0):
    """A long loaf: an oval rising to a crust, lofted along its length so the
    ends round down the way bread proves."""
    secs = []
    n = 4
    for i in range(n + 1):
        t = i / n
        a = -L / 2 + L * t
        f = math.sin(math.pi * (0.08 + 0.84 * t)) ** 0.6
        # a loft along x takes its first radius and centre on z, the second on y
        secs.append((a, h / 2 * f, w / 2 * f, h / 2 * f, 0.0))
    obj = lib.loft(secs, sides=6, axis="x", name="loaf", mat="wood")
    tag(obj, "bread")
    lib.shade_smooth(obj, angle=80)
    obj.rotation_euler = (0, 0, turn)
    obj.location = (x, y, z)
    return obj


def cob(x, y, z, r=0.09):
    obj = lib.sphere(r, (x, y, z + r * 0.55), segments=7, rings=4, name="cob", mat="wood")
    obj.scale = (1, 1, 0.62)
    tag(obj, "bread")
    lib.shade_smooth(obj, angle=80)
    return obj


def crock(x, y, z, h=0.22, r=0.08, m="earthenware", lid=True):
    prof = [(0, r * 0.8), (0.02, r * 0.95), (h * 0.6, r), (h * 0.9, r * 0.8), (h, r * 0.78)]
    parts = [lathe(prof, x, y, z, sides=8, m=m, name="crock")]
    if lid:
        parts.append(lathe([(h, r * 0.84), (h + 0.015, r * 0.84), (h + 0.035, r * 0.2)], x, y, z, sides=8,
                           m="wood", name="lid"))
    return parts


def book(x, y, z, h=0.24, w=0.17, t=0.05, lean=0.0, turn=0.0, flat=False):
    """Spine out, or lying flat. The page block is a shade in from the boards,
    which is the one detail that tells a book from a brick."""
    if flat:
        cover = lib.box((h, w, t), (0, 0, t / 2), name="book", mat="wood")
        pages = lib.box((h * 0.94, w * 0.96, t * 0.8), (0.006, 0, t / 2), name="pages", mat="wood")
    else:
        cover = lib.box((t, w, h), (0, 0, h / 2), name="book", mat="wood")
        pages = lib.box((t * 0.8, w * 0.96, h * 0.94), (0, -0.006, h / 2), name="pages", mat="wood")
    tag(cover, "leather")
    tag(pages, "linen")
    return kit.place([cover, pages], (x, y, z), (0 if flat else lean, 0, turn))


# --- tables and seats -----------------------------------------------------

TOP_Z = 0.83       # table surface
TOP_T = 0.06
SEAT_Z = 0.455     # table bench surface


def table_top(boards=3):
    parts = []
    L, W = 1.5, 0.75
    gap = 0.004
    bw = (W - gap * (boards - 1)) / boards
    for i in range(boards):
        y = -W / 2 + bw / 2 + i * (bw + gap)
        dl = rng.uniform(-0.014, 0.014)
        dz = rng.uniform(-0.0015, 0.0015)
        parts.append(worn((L + dl, bw, TOP_T), (rng.uniform(-0.006, 0.006), y, TOP_Z - TOP_T / 2 + dz),
                          wear=0.012))
        # Pegged down to the cleats, two a board a cleat.
        for cx in (-0.45, 0.45):
            parts.append(peg(cx + rng.uniform(-0.01, 0.01), y, TOP_Z + dz, r=0.01, h=0.004))
    for cx in (-0.45, 0.45):
        parts.append(beam((0.06, W - 0.06, 0.035), (cx, 0, TOP_Z - TOP_T - 0.0175), name="cleat"))
    return parts


def build_table_trestle():
    """A plank top on two trestles, the stretcher between them through-tenoned
    and wedged. The splayed legs land on the four points actors.js keeps as the
    table's legs, (+-0.62, +-0.28)."""
    reset(11)
    p = table_top(3)
    under = TOP_Z - TOP_T
    for sx in (-1, 1):
        x = sx * 0.62
        p.append(beam((0.08, 0.64, 0.07), (x, 0, under - 0.035), name="head"))
        for sy in (-1, 1):
            p.append(strut((x, sy * 0.13, under - 0.05), (x, sy * 0.29, 0.0), 0.07, 0.06,
                           name="leg"))
        p.append(beam((0.07, 0.46, 0.06), (x, 0, 0.26), name="rail"))
        # the stretcher's tenon through the rail, and its wedge
        p.append(peg(x + sx * 0.085, 0, 0.36, r=0.012, h=0.08, axis="z"))
    p.append(beam((1.46, 0.06, 0.08), (0, 0, 0.32), name="stretcher"))
    return deliver(p, "furn_table_trestle")


def build_table_board():
    """Four square legs, rails across the ends only, and an H of low
    stretchers. No rail along the long sides: a seated body's knees go under
    there, and a big one's reach 0.7 m."""
    reset(12)
    p = table_top(2)
    under = TOP_Z - TOP_T
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(beam((0.075, 0.075, under), (sx * 0.62, sy * 0.28, under / 2), cham=0.014,
                          name="leg"))
            p.append(peg(sx * 0.62, sy * 0.28 - sy * 0.001, under - 0.05, r=0.009, h=0.08, axis="x"))
        p.append(beam((0.04, 0.5, 0.1), (sx * 0.62, 0, under - 0.05), name="rail"))
        p.append(beam((0.05, 0.5, 0.05), (sx * 0.62, 0, 0.12), name="stretcher"))
    p.append(beam((1.2, 0.05, 0.05), (0, 0, 0.12), name="stretcher"))
    return deliver(p, "furn_table_board")


def bench_end_profile(w=0.28, h=0.39, notch=0.09):
    a = w / 2
    return [(-a, 0), (-a * 0.42, 0), (0, notch), (a * 0.42, 0), (a, 0), (a, h), (-a, h)]


def build_bench_plank():
    """Seat 1.40 x 0.34 with its surface at 0.455 over two slab ends at +-0.52,
    V-notched into feet; a stretcher through both, wedged outside."""
    reset(13)
    p = []
    t = 0.065
    p.append(worn((1.4, 0.34, t), (0, 0, SEAT_Z - t / 2), wear=0.012, name="seat"))
    below = SEAT_Z - t
    for sx in (-1, 1):
        x = sx * 0.52
        p.append(prism(bench_end_profile(0.28, below), x - 0.0275, x + 0.0275, name="end"))
        # the end's tenons through the seat
        for sy in (-1, 1):
            p.append(board((0.05, 0.035, 0.004), (x, sy * 0.075, SEAT_Z + 0.001), wear=0.0))
        p.append(peg(sx * 0.585, 0, 0.19, r=0.01, h=0.085, axis="z"))
    for sy in (-1, 1):
        p.append(beam((1.1, 0.025, 0.06), (0, sy * 0.125, below - 0.03), name="apron"))
    p.append(beam((1.24, 0.05, 0.05), (0, 0, 0.18), name="stretcher"))
    return deliver(p, "furn_bench_plank")


def build_bench_staked():
    """A thick slab on four staked legs, splayed, their wedged tops showing
    through the seat. Same seat, same surface height, same two leg stations."""
    reset(14)
    p = []
    t = 0.075
    p.append(worn((1.4, 0.34, t), (0, 0, SEAT_Z - t / 2), wear=0.018, name="seat"))
    for sx in (-1, 1):
        for sy in (-1, 1):
            top = (sx * 0.5, sy * 0.075, SEAT_Z)
            foot = (sx * 0.6, sy * 0.15, 0.0)
            p.append(lathe([(0, 0.024), (0.3, 0.021), (SEAT_Z + 0.001, 0.018)], 0, 0, 0, sides=7,
                           m="wood", smooth=False, name="leg"))
            leg = p[-1]
            d = V(top) - V(foot)
            leg.rotation_mode = "QUATERNION"
            leg.rotation_quaternion = V((0, 0, 1)).rotation_difference(d.normalized())
            leg.scale = (1, 1, d.length / (SEAT_Z + 0.001))
            leg.location = foot
            p.append(peg(top[0] + sx * 0.005, top[1], SEAT_Z + 0.001, r=0.019, h=0.004))
    p.append(beam((1.0, 0.04, 0.04), (0, 0, 0.16), name="stretcher"))
    for sx in (-1, 1):
        p.append(beam((0.04, 0.26, 0.04), (sx * 0.55, 0, 0.16), name="rung"))
    return deliver(p, "furn_bench_staked")


def build_stool():
    """Three legs, splayed, round seat r 0.19 with its surface at 0.665, and a
    ring of rungs to put your feet on. Three legs because three never rock on
    a flagged floor."""
    reset(15)
    p = []
    top = 0.665
    t = 0.05
    seat = lathe([(0, 0.18), (0.012, 0.19), (t - 0.01, 0.19), (t, 0.178)], 0, 0, top - t,
                 sides=14, m="wood", smooth=False, name="seat")
    p.append(seat)
    feet = []
    for i in range(3):
        a = math.radians(90 + 120 * i)
        up = (0.1 * math.cos(a), 0.1 * math.sin(a), top - 0.002)
        foot = (0.2 * math.cos(a), 0.2 * math.sin(a), 0.0)
        feet.append((up, foot))
        p.append(strut(foot, up, 0.042, cham=0.012, name="leg"))
        p.append(peg(up[0], up[1], top + 0.001, r=0.018, h=0.004))
    for i in range(3):
        (u0, f0), (u1, f1) = feet[i], feet[(i + 1) % 3]
        k = 0.36
        a = [f0[j] + (u0[j] - f0[j]) * k for j in range(3)]
        b = [f1[j] + (u1[j] - f1[j]) * k for j in range(3)]
        p.append(strut(a, b, 0.028, cham=0.008, name="rung"))
    return deliver(p, "furn_stool")


def build_settle():
    """A high-backed settle for the wall of an inn, sat on exactly as props.py's
    bench is: seat 1.85 x 0.42 with its surface at 0.485, the back 0.13-0.21
    behind the seat's middle. Solid ends with arms, a panelled back."""
    reset(16)
    p = []
    L, seat = 1.85, 0.485
    p.append(worn((L, 0.42, 0.06), (0, 0, seat - 0.03), wear=0.012, name="seat"))
    p.append(board((L - 0.1, 0.02, seat - 0.12), (0, -0.19, (seat - 0.06) / 2 + 0.03), name="front"))
    for sx in (-1, 1):
        x = sx * (L / 2 + 0.02)
        prof = [(-0.23, 0), (0.22, 0), (0.22, 1.42), (0.14, 1.42), (0.14, 0.72), (-0.2, 0.72),
                (-0.23, 0.66)]
        p.append(prism(prof, x - 0.02, x + 0.02, name="end"))
        p.append(worn((0.08, 0.36, 0.04), (x, -0.03, 0.74), wear=0.01, name="arm"))
    back_y = 0.17
    for (z0, z1) in ((seat, seat + 0.07), (1.32, 1.4)):
        p.append(beam((L, 0.04, z1 - z0), (0, back_y, (z0 + z1) / 2), name="rail"))
    n = 4
    for i in range(n + 1):
        x = -L / 2 + L * i / n
        p.append(beam((0.07, 0.045, 1.4 - seat), (x, back_y, (1.4 + seat) / 2), name="stile"))
    for i in range(n):
        x = -L / 2 + L * (i + 0.5) / n
        p.append(board((L / n - 0.07, 0.02, 1.32 - seat - 0.07), (x, back_y + 0.012, (1.32 + seat + 0.07) / 2),
                       wear=0.0, name="panel"))
        p.append(board((L / n - 0.17, 0.012, 1.32 - seat - 0.17), (x, back_y - 0.004, (1.32 + seat + 0.07) / 2),
                       wear=0.008, name="field"))
    p.append(worn((L + 0.1, 0.1, 0.035), (0, back_y - 0.01, 1.42), wear=0.01, name="cap"))
    return deliver(p, "furn_settle")


# --- the bar --------------------------------------------------------------

C_L, C_D, C_H = 4.4, 0.72, 1.06


def counter_body(bar=True):
    """The carcase: plinth, frame and fielded panels on the front and ends,
    open shelving on the keeper's side, and a top of three thick boards worn
    round along the front."""
    p = []
    L, D = C_L, C_D
    body = C_H - 0.09 / 2          # the top's underside, 1.015
    front = -D / 2
    p.append(board((L - 0.08, D - 0.1, 0.1), (0, 0.01, 0.05), wear=0.004, name="plinth"))
    # corner posts
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(beam((0.08, 0.08, body - 0.1), (sx * (L / 2 - 0.04), sy * (D / 2 - 0.04), 0.1 + (body - 0.1) / 2),
                          name="post"))

    def framed(span, centre, axis, bays, face, depth_sign):
        """Rails, muntins and fielded panels across one face."""
        out = []
        z0, z1 = 0.1, body
        rail_h = 0.1
        th = 0.04
        for (zc, h) in ((z1 - rail_h / 2 - 0.02, rail_h), (z0 + rail_h / 2 + 0.02, rail_h)):
            size = (span, th, h) if axis == "x" else (th, span, h)
            loc = (centre, face, zc) if axis == "x" else (face, centre, zc)
            out.append(beam(size, loc, name="rail"))
        width = span / bays
        for i in range(1, bays):
            c = centre - span / 2 + width * i
            size = (0.08, th, z1 - z0) if axis == "x" else (th, 0.08, z1 - z0)
            loc = (c, face, (z0 + z1) / 2) if axis == "x" else (face, c, (z0 + z1) / 2)
            out.append(beam(size, loc, name="muntin"))
        ph = z1 - z0 - 2 * rail_h - 0.04
        pz = (z0 + z1) / 2
        for i in range(bays):
            c = centre - span / 2 + width * (i + 0.5)
            pw = width - 0.08
            back = face - depth_sign * 0.02
            size = (pw, 0.02, ph) if axis == "x" else (0.02, pw, ph)
            loc = (c, back, pz) if axis == "x" else (back, c, pz)
            out.append(board(size, loc, wear=0.0, name="panel"))
            fw, fh = pw - 0.12, ph - 0.12
            raised = face - depth_sign * 0.006
            size = (fw, 0.014, fh) if axis == "x" else (0.014, fw, fh)
            loc = (c, raised, pz) if axis == "x" else (raised, c, pz)
            out.append(board(size, loc, wear=0.012, name="field"))
        return out

    p += framed(L - 0.16, 0, "x", 6, front + 0.02, -1)
    for sx in (-1, 1):
        p += framed(D - 0.16, 0, "y", 1, sx * (L / 2 - 0.02), sx)
    # The keeper's side: two shelves in the open carcase, with partitions.
    for z in (0.12, 0.5):
        p.append(board((L - 0.16, D - 0.14, 0.03), (0, 0.03, z), wear=0.003, name="shelf"))
    for i in range(1, 6):
        x = -L / 2 + L * i / 6
        p.append(board((0.03, D - 0.14, body - 0.14), (x, 0.03, 0.1 + (body - 0.1) / 2), wear=0.003,
                       name="partition"))
    p.append(beam((L - 0.08, 0.05, 0.1), (0, D / 2 - 0.03, body - 0.05), name="rail"))
    # The top: 4.58 x 0.96 x 0.09, its surface at 1.105, overhanging 0.12 all
    # round. Three boards, not quite level with each other.
    TW, TL, TT = D + 0.24, L + 0.18, 0.09
    bw = TW / 3
    for i in range(3):
        y = -TW / 2 + bw * (i + 0.5)
        dz = (0.0, 0.0015, -0.001)[i]
        p.append(worn((TL + rng.uniform(-0.01, 0.01), bw - 0.003, TT), (0, y, C_H + dz),
                      wear=0.028 if i == 0 else 0.012, name="top"))
        for x in (-1.8, -0.6, 0.6, 1.8):
            p.append(peg(x + rng.uniform(-0.02, 0.02), y, C_H + TT / 2 + dz, r=0.011, h=0.004))
    return p


def build_bar_counter():
    """The Grunting Boar's bar: "old archaic writing, carvings and symbols
    cover its top ... a small sign with big letters is fastened to the bar."
    A brass foot rail along the front at 0.17, where the old boxes had one."""
    reset(21)
    p = counter_body(bar=True)
    top = C_H + 0.045
    # Carvings: short cut strokes, darker than the top, grouped as if letters.
    for g in range(9):
        gx = -1.9 + g * 0.48 + rng.uniform(-0.1, 0.1)
        gy = rng.uniform(-0.3, 0.2)
        for k in range(rng.randint(3, 5)):
            L = rng.uniform(0.03, 0.08)
            a = rng.choice((0.0, math.pi / 2, math.pi / 4, -math.pi / 4))
            obj = lib.box((L, 0.006, 0.002), (gx + k * 0.035, gy + rng.uniform(-0.03, 0.03), top + 0.0008),
                          (0, 0, a), name="cut", mat="wood")
            p.append(tag(obj, "soot"))
    front = -C_D / 2
    y = front - 0.14
    p.append(rod((-C_L / 2 + 0.25, y, 0.17), (C_L / 2 - 0.25, y, 0.17), 0.022, m="brass", verts=8,
                 name="footrail"))
    for x in (-1.9, -0.63, 0.63, 1.9):
        p.append(rod((x, y, 0.17), (x, front, 0.19), 0.014, m="brass", verts=6, name="bracket"))
    # The sign, at L * 0.28 as it always was, on two iron straps.
    sx = C_L * 0.28
    p.append(board((0.78, 0.03, 0.34), (sx, front - 0.035, 0.74), wear=0.008, m="planks", name="sign"))
    p.append(beam((0.84, 0.05, 0.05), (sx, front - 0.04, 0.93), name="signcap"))
    # "big letters": cut strokes, a letter's height each, in two words
    x = sx - 0.3
    for k in range(9):
        if k == 4:
            x += 0.06
            continue
        for (dx, dz, a, L) in rng.sample(((0.0, 0.0, 0.0, 0.16), (0.05, 0.0, 0.0, 0.16), (0.025, 0.05, 1.57, 0.05),
                                           (0.025, -0.05, 1.57, 0.05), (0.025, 0.0, 0.5, 0.17)), 2):
            obj = lib.box((0.012, 0.004, L), (x + dx, front - 0.052, 0.74 + dz), (0, a, 0), name="letter", mat="wood")
            p.append(tag(obj, "soot"))
        x += 0.075
    return deliver(p, "furn_bar_counter")


def build_shop_counter():
    """The same carcase for a shop: no foot rail, no sign, no carving -- a
    counter to lay goods on. A ledger at one end."""
    reset(22)
    p = counter_body(bar=False)
    top = C_H + 0.045
    p += book(1.55, -0.05, top, h=0.3, w=0.22, t=0.05, turn=0.2, flat=True)
    return deliver(p, "furn_shop_counter")


def build_backbar():
    """The gantry behind the bar: two shelves at 1.42 and 2.02 on shaped
    brackets, 3.78 long -- what the boxes had -- boarded behind and capped,
    with bottles, jugs and plates on it and tankards on pegs under it. Wall
    at y = 0. Nothing lower than 1.2 m: the keeper stands at 0.52 from the
    wall, and a cupboard here put his head in it."""
    reset(23)
    p = []
    L = 3.78
    p.append(board((L, 0.02, 1.26), (0, -0.01, 1.2 + 0.63), wear=0.0, m="planks", name="backing"))
    for (z, d) in ((1.42, 0.30), (2.02, 0.26)):
        p.append(worn((L, d, 0.045), (0, -(0.06 + d / 2) + 0.03, z), wear=0.008, name="shelf"))
        p.append(beam((L, 0.02, 0.05), (0, -(0.06 + d) + 0.04, z + 0.035), name="lip"))
    for x in (-L / 2 + 0.015, -L / 6, L / 6, L / 2 - 0.015):
        prof = [(0, 1.2), (0, 2.44), (-0.33, 2.44), (-0.33, 1.9), (-0.22, 1.7), (-0.3, 1.5),
                (-0.3, 1.38), (-0.1, 1.24)]
        p.append(prism(prof, x - 0.015, x + 0.015, name="bracket"))
    p.append(worn((L + 0.1, 0.36, 0.04), (0, -0.16, 2.46), wear=0.01, name="cornice"))
    p.append(beam((L + 0.12, 0.04, 0.07), (0, -0.34, 2.43), name="moulding"))
    # Lower shelf: bottles and jugs, a small cask on a cradle.
    lower = 1.42 + 0.0225
    xs = [-1.62, -1.5, -1.38, -0.95, -0.82, -0.3, 0.38, 0.5, 0.95, 1.12, 1.62]
    for i, x in enumerate(xs):
        y = -0.2 + rng.uniform(-0.04, 0.04)
        if i in (3, 8):
            p += jug(x, y, lower, h=0.24 + rng.uniform(0, 0.05), turn=rng.uniform(0, 6.28))
        elif i == 5:
            continue
        else:
            p += bottle(x, y, lower, h=rng.choice((0.26, 0.3, 0.33)), r=rng.choice((0.038, 0.042, 0.046)),
                        m="bottle" if i % 3 else "earthenware")
    p.append(props.cask(0.1, 0.3, -0.3, -0.37, lower + 0.125, axis="y", sides=9, name="keg"))
    tag(p[-1], "planks")
    for sx in (-1, 1):
        p.append(board((0.04, 0.24, 0.05), (-0.3 + sx * 0.08, -0.22, lower + 0.025), wear=0.0, name="chock"))
    # Upper shelf: plates stood against the backing, a few bottles.
    upper = 2.02 + 0.0225
    for x in (-1.3, -0.95, 0.9, 1.25):
        p.append(plate(x, -0.08, upper + 0.12, r=0.12, tilt=math.radians(80)))
    for x in (-0.45, -0.3, 0.2, 0.35, 0.5):
        p += bottle(x, -0.2, upper, h=rng.choice((0.26, 0.3)), m="bottle")
    p += jug(1.65, -0.18, upper, h=0.24, turn=2.0)
    p += jug(-1.65, -0.18, upper, h=0.22, turn=1.0)
    # Pegs under the lower shelf, a tankard hung from each by its handle.
    for i in range(7):
        x = -1.5 + i * 0.5
        p.append(peg(x, -0.03, 1.3, r=0.012, h=0.06, axis="y"))
        p += tankard(x, -0.045 - 0.075, 1.3 - 0.12, m="pewter" if i % 2 else "wood",
                     turn=math.pi / 2)
    return deliver(p, "furn_backbar")


def build_cask_rack():
    """Three casks on their sides on a cradle, heads to the room, brass taps
    in them. Wall at y = 0: 0.86 deep, 2.1 long."""
    reset(24)
    p = []
    r, h = 0.25, 0.68
    zc = 0.13 + r * 1.17
    for sy in (-0.22, -0.62):
        p.append(beam((2.1, 0.12, 0.13), (0, sy, 0.065), name="sleeper"))
    for i, x in enumerate((-0.68, 0.0, 0.68)):
        c = props.cask(r, h, x, -0.08 - h, zc, axis="y", sides=14, name="cask")
        p.append(tag(c, "planks"))
        lib.shade_smooth(c, angle=60)
        for sy in (-0.22, -0.62):
            b = 0.13
            left = [(x - 0.3, b), (x - 0.12, b), (x - 0.12, b + 0.09), (x - 0.3, b + 0.03)]
            right = [(x + 0.12, b), (x + 0.3, b), (x + 0.3, b + 0.03), (x + 0.12, b + 0.09)]
            for prof in (left, right):
                p.append(prism(prof, sy - 0.05, sy + 0.05, name="chock", axis="y"))
        head = -0.08 - h
        p.append(rod((x, head, zc - 0.12), (x, head - 0.09, zc - 0.12), 0.018, m="brass", verts=8,
                     name="tap"))
        p.append(rod((x, head - 0.07, zc - 0.12), (x, head - 0.07, zc - 0.05), 0.01, m="brass",
                     verts=6, name="key"))
        p.append(rod((x, head - 0.085, zc - 0.12), (x, head - 0.085, zc - 0.17), 0.012, m="brass",
                     verts=6, name="spout"))
    # a stave with a chalk tally and a drip bucket under the middle tap
    p.append(lathe([(0, 0.1), (0.16, 0.12), (0.17, 0.12)], 0.0, -0.9, 0.0, sides=10, m="planks",
                   smooth=False, name="bucket"))
    return deliver(p, "furn_cask_rack")


# --- the hearth -----------------------------------------------------------

OPEN_W, OPEN_H, BREAST, DEEP = 1.5, 1.35, 2.5, 0.72
BACKING = 0.62        # the stone kit's buttress stands 0.62 proud of its wall
CEIL = 5.2


def hearth(pot=False):
    """Dressed-stone jambs, an oak bressummer across the opening, a stone
    mantel on corbels and the chimney breast on up to the ceiling. The firebox
    is sooted, not black. Andirons and logs sit under where actors.js lights
    the fire (0.42 out, 0.24 up)."""
    p = []
    face = -(DEEP + 0.02)
    jamb = (BREAST - OPEN_W) / 2
    course = OPEN_H / 5
    for s in (-1, 1):
        xc = s * (OPEN_W / 2 + jamb / 2)
        for k in range(5):
            # quoins: alternate courses run long and short on the face
            long = k % 2 == 0
            w = jamb + (0.06 if long else -0.02)
            x = xc + s * (0.03 if long else -0.01)
            p.append(kit.slab((w, DEEP + rng.uniform(-0.01, 0.02), course - 0.012),
                              (x, face / 2, course * (k + 0.5)), mat="marble", name="quoin", width=0.018))
    p.append(beam((OPEN_W + 0.6, 0.32, 0.3), (0, face + 0.15, OPEN_H + 0.15), cham=0.03, name="bressummer"))
    for s in (-1, 1):
        p.append(kit.slab((0.2, 0.22, 0.24), (s * (BREAST / 2 - 0.12), face - 0.1, OPEN_H + 0.3 + 0.12),
                          mat="marble", name="corbel", width=0.02))
    p.append(kit.slab((BREAST + 0.34, DEEP + 0.34, 0.1), (0, (face - 0.32) / 2, OPEN_H + 0.3 + 0.24 + 0.05),
                      mat="marble", name="mantel", width=0.02))
    # the breast: stepped back above the mantel, then straight to the ceiling
    z0 = OPEN_H + 0.64
    p.append(lib.box((BREAST * 0.86, DEEP - 0.04, 0.4), (0, (face + 0.04) / 2, z0 + 0.2), name="breast",
                     mat="stonewall"))
    p.append(kit.slab((BREAST * 0.86 + 0.08, DEEP + 0.02, 0.1), (0, (face - 0.02) / 2, z0 + 0.45),
                      mat="marble", name="string", width=0.02))
    p.append(lib.box((BREAST * 0.78, DEEP - 0.1, CEIL - z0 - 0.5), (0, (face + 0.1) / 2, (z0 + 0.5 + CEIL) / 2),
                     name="breast", mat="stonewall"))
    # Behind the wall line: inside the wall when the hearth stands against it,
    # and the masonry that fills the gap when build.js brings it out in front
    # of a buttress. Its face is 3 mm behind the wall line so that, flush,
    # nothing of it is ever coplanar with the wall.
    p.append(lib.box((BREAST, BACKING, OPEN_H + 0.64), (0, 0.003 + BACKING / 2, (OPEN_H + 0.64) / 2),
                     name="backing", mat="stonewall"))
    p.append(lib.box((BREAST * 0.78, BACKING, CEIL - OPEN_H - 0.64), (0, 0.003 + BACKING / 2, (OPEN_H + 0.64 + CEIL) / 2),
                     name="backing", mat="stonewall"))
    # the firebox, sooted
    p.append(tag(lib.box((OPEN_W, 0.1, OPEN_H + 0.02), (0, -0.05, OPEN_H / 2), mat="stonewall"), "soot"))
    for s in (-1, 1):
        p.append(tag(lib.box((0.02, DEEP - 0.12, OPEN_H), (s * (OPEN_W / 2 - 0.01), (face + 0.12) / 2 - 0.02, OPEN_H / 2),
                             mat="stonewall"), "soot"))
    p.append(tag(lib.box((OPEN_W, DEEP - 0.1, 0.02), (0, face / 2, OPEN_H - 0.01), mat="stonewall"), "soot"))
    # hearthstone: two flags, 3.0 x 1.25 all told, a little proud of the floor
    for s in (-1, 1):
        p.append(kit.slab(((BREAST + 0.5) / 2 - 0.006, 1.25, 0.06), (s * (BREAST + 0.5) / 4, -0.625, 0.03),
                          mat="flagstone", name="hearthstone", width=0.012))
    p.append(tag(lib.box((OPEN_W - 0.1, 0.5, 0.03), (0, -0.33, 0.075), mat="stonewall"), "ash"))
    # andirons
    for s in (-1, 1):
        x = s * 0.4
        p.append(rod((x, -0.12, 0.13), (x, -0.62, 0.13), 0.018, verts=6, name="dog"))
        p.append(rod((x, -0.62, 0.06), (x, -0.62, 0.36), 0.022, verts=6, name="post"))
        p.append(tag(lib.sphere(0.035, (x, -0.62, 0.38), segments=8, rings=5, mat="iron"), "iron"))
        for y in (-0.15, -0.6):
            p.append(rod((x, y, 0.06), (x, y, 0.13), 0.014, verts=5, name="foot"))
    for k, (y, z, r, m, a) in enumerate(((-0.3, 0.2, 0.085, "bark", 0.05), (-0.5, 0.2, 0.075, "bark", -0.08),
                                         (-0.4, 0.33, 0.07, "charred", 0.3))):
        log = lib.cylinder(r, 1.0, (0, y, z), (0, math.pi / 2, a), verts=7, name="log", mat="bark")
        p.append(tag(log, m))
    if pot:
        # a crane on the left jamb, swung in over the fire, and the pot on it
        px = -OPEN_W / 2 + 0.08
        p.append(rod((px, -0.2, 0.1), (px, -0.2, 1.2), 0.02, verts=6, name="crane"))
        p.append(rod((px, -0.2, 1.15), (0.02, -0.42, 1.15), 0.018, verts=6, name="arm"))
        p.append(rod((px, -0.2, 0.6), (-0.3, -0.35, 1.13), 0.014, verts=5, name="brace"))
        p.append(rod((0.0, -0.42, 1.15), (0.0, -0.42, 0.84), 0.008, verts=4, name="chain"))
        p.append(lathe([(0, 0.12), (0.03, 0.2), (0.14, 0.25), (0.28, 0.24), (0.3, 0.22), (0.32, 0.23)],
                       0.0, -0.42, 0.5, sides=12, m="iron", name="pot"))
        p.append(lathe([(0.29, 0.21), (0.295, 0.21)], 0.0, -0.42, 0.5, sides=12, m="water", smooth=False,
                       name="water"))
        for s in (-1, 1):
            p.append(rod((s * 0.23, -0.42, 0.82), (0, -0.42, 0.86), 0.008, verts=4, name="bail"))
    else:
        # fire irons on a hook on the right jamb
        x = OPEN_W / 2 + jamb - 0.12
        p.append(rod((x, face - 0.04, 0.09), (x + 0.03, face - 0.04, 0.95), 0.011, verts=5, name="poker"))
        p.append(rod((x + 0.1, face - 0.04, 0.2), (x + 0.1, face - 0.04, 0.95), 0.011, verts=5, name="shovel"))
        p.append(tag(lib.box((0.12, 0.012, 0.14), (x + 0.1, face - 0.04, 0.14), mat="iron"), "iron"))
    return p


def build_hearth():
    reset(31)
    return deliver(hearth(False), "furn_hearth")


def build_hearth_pot():
    reset(32)
    return deliver(hearth(True), "furn_hearth_pot")


# --- the smith ------------------------------------------------------------

def build_forge():
    """A smith's forge against the wall: a brick hearth at 0.8 with its fire
    pot, a sooted hood gathering into a flue to the ceiling, the great bellows
    on its frame to the left and a quench tub to the right. Wall at y = 0. The
    fire is actors.js's, at (0, 0.86, -0.55) in this frame."""
    reset(41)
    p = []
    W, D, H = 1.6, 1.05, 0.8
    p.append(lib.box((W, D, H - 0.08), (0, -D / 2, (H - 0.08) / 2), name="base", mat="stonewall"))
    tag(p[-1], "firebrick")
    for (x, y, w, d) in ((0, -D + 0.07, W + 0.06, 0.16), (0, -0.07, W + 0.06, 0.16),
                         (-W / 2 + 0.07, -D / 2, 0.16, D - 0.3), (W / 2 - 0.07, -D / 2, 0.16, D - 0.3)):
        p.append(kit.slab((w, d, 0.1), (x, y, H - 0.04), mat="flagstone", name="rim", width=0.012))
    p.append(tag(lib.box((W - 0.3, D - 0.3, 0.04), (0, -D / 2, H - 0.06), mat="stonewall"), "ash"))
    for i in range(14):
        a = rng.uniform(0, 6.28)
        rr = rng.uniform(0, 0.28)
        c = lib.sphere(rng.uniform(0.03, 0.05), (rr * math.cos(a), -0.55 + rr * math.sin(a) * 0.8, H - 0.03),
                       segments=5, rings=3, name="coal", mat="stonewall")
        c.scale = (1, 1, 0.6)
        p.append(tag(c, "charred"))
    # ash pit opening under the front
    p.append(tag(lib.box((0.6, 0.02, 0.3), (0, -D - 0.005, 0.25), mat="stonewall"), "soot"))
    # the hood: a frustum of brick on two iron brackets, open (sooted) below
    hz0, hz1 = 1.75, 2.55
    p.append(tag(lib.box((1.8, 1.12, 0.14), (0, -0.56, hz0 + 0.07), mat="stonewall"), "firebrick"))
    p.append(frustum((-0.9, 0.9, -1.12, 0.0), (-0.34, 0.34, -0.52, 0.0), hz0 + 0.14, hz1, name="hood"))
    p.append(tag(lib.box((1.76, 1.08, 0.02), (0, -0.56, hz0 - 0.005), mat="stonewall"), "soot"))
    p.append(lib.box((0.62, 0.5, CEIL - hz1), (0, -0.28, (hz1 + CEIL) / 2), name="flue", mat="stonewall"))
    tag(p[-1], "firebrick")
    # the hood stands on two iron posts off the forge's front corners
    for s in (-1, 1):
        p.append(beam((0.05, 0.05, hz0 - H), (s * 0.84, -1.06, (H + hz0) / 2), m="iron", cham=0.008, name="post"))
    # The great bellows: a pear of two boards with the leather gathered
    # between them in folds, lying on a trestle with its nozzle into the
    # tuyere, and the lever above it on a chain.
    bx, by = -1.42, -0.55
    for s in (-1, 1):
        p.append(strut((bx + s * 0.28, by - 0.3, 0.0), (bx + s * 0.22, by, 0.7), 0.06, name="leg"))
        p.append(strut((bx + s * 0.28, by + 0.3, 0.0), (bx + s * 0.22, by, 0.7), 0.06, name="leg"))
        p.append(beam((0.08, 0.1, 0.08), (bx + s * 0.22, by, 0.72), name="saddle"))
    pear = [(-0.52, 0.0), (-0.46, -0.2), (-0.3, -0.3), (-0.05, -0.31), (0.2, -0.22), (0.4, -0.1), (0.5, -0.05),
            (0.5, 0.05), (0.4, 0.1), (0.2, 0.22), (-0.05, 0.31), (-0.3, 0.3), (-0.46, 0.2)]
    bel = []
    for (z0, z1, k, m) in ((0.76, 0.8, 1.0, "wood"), (0.8, 0.86, 0.93, "leather"), (0.86, 0.9, 1.0, "leather"),
                           (0.9, 0.96, 0.93, "leather"), (0.96, 1.0, 1.0, "wood")):
        bel.append(prism([(x * k, y * k) for (x, y) in pear], z0, z1, m=m, name="bellows", axis="z"))
    bel.append(rod((0.48, 0, 0.88), (0.78, 0, 0.84), 0.03, m="iron", verts=6, name="nozzle"))
    # nose down a little, towards the fire, turning about its own middle
    kit.place(bel, (bx, by, 0), (0, math.radians(4), 0))
    p += bel
    p.append(rod((bx + 0.8, by, 0.86), (-0.25, by, H - 0.02), 0.035, verts=8, name="tuyere"))
    p.append(strut((bx - 0.45, by, 1.0), (bx - 0.75, by, 1.85), 0.05, name="lever"))
    p.append(rod((bx - 0.66, by, 1.6), (bx - 0.35, by, 1.0), 0.008, verts=4, name="chain"))
    # quench tub to the right, a slack tub cut from a cask, and water in it
    tx, ty = 1.2, -0.75
    p.append(lathe([(0, 0.28), (0.05, 0.3), (0.5, 0.33), (0.52, 0.33)], tx, ty, 0, sides=11, m="planks",
                   name="tub"))
    p.append(lathe([(0.1, 0.3), (0.13, 0.33), (0.37, 0.346), (0.4, 0.33)], tx, ty, 0, sides=11, m="iron",
                   name="hoop", caps=False))
    p.append(lathe([(0.44, 0.315), (0.45, 0.315)], tx, ty, 0, sides=11, m="water", smooth=False, name="water"))
    p.append(rod((tx - 0.1, ty, 0.35), (tx + 0.15, ty - 0.05, 0.85), 0.01, verts=5, name="tongs"))
    p.append(rod((tx - 0.05, ty + 0.03, 0.35), (tx + 0.2, ty, 0.85), 0.01, verts=5, name="tongs"))
    return deliver(p, "furn_forge")


def build_anvil():
    """A London-pattern anvil, face at 0.80, on an elm stump; a hammer on the
    face and tongs against the stump."""
    reset(42)
    p = []
    p.append(lathe([(0, 0.3), (0.05, 0.27), (0.44, 0.25), (0.5, 0.245)], 0, 0, 0, sides=11, m="bark",
                   smooth=True, name="stump"))
    p.append(lathe([(0.499, 0.24), (0.502, 0.24)], 0, 0, 0, sides=11, m="wood", smooth=False,
                   name="endgrain"))
    z = 0.5
    p.append(frustum((-0.2, 0.2, -0.15, 0.15), (-0.2, 0.2, -0.15, 0.15), z, z + 0.04, m="iron", name="foot"))
    p.append(frustum((-0.2, 0.2, -0.15, 0.15), (-0.1, 0.1, -0.06, 0.06), z + 0.04, z + 0.16, m="iron", name="waist"))
    p.append(frustum((-0.1, 0.1, -0.06, 0.06), (-0.16, 0.16, -0.06, 0.06), z + 0.16, z + 0.22, m="iron", name="waist"))
    face = kit.slab((0.46, 0.12, 0.08), (0.0, 0, z + 0.26), mat="iron", name="body", width=0.01)
    p.append(tag(face, "iron"))
    p.append(tag(lib.box((0.44, 0.11, 0.004), (0, 0, z + 0.301), mat="steel"), "steel"))
    horn = lib.loft([(0.23, 0.05, 0.058, 0.0, 0), (0.33, 0.036, 0.042, -0.005, 0), (0.43, 0.02, 0.022, -0.012, 0),
                     (0.5, 0.006, 0.006, -0.02, 0)], sides=8, axis="x", name="horn", mat="iron")
    horn.location = (0, 0, z + 0.27)
    p.append(tag(horn, "iron"))
    lib.shade_smooth(horn)
    p.append(tag(kit.slab((0.12, 0.1, 0.06), (-0.29, 0, z + 0.27), mat="iron", width=0.008), "iron"))
    # hammer on the face
    p.append(strut((-0.05, -0.02, z + 0.315), (0.3, -0.12, z + 0.33), 0.025, 0.03, name="helve"))
    p.append(tag(kit.slab((0.05, 0.11, 0.045), (-0.07, 0.0, z + 0.328), (0, 0, -0.28), mat="iron", width=0.006),
                 "iron"))
    # tongs leaning on the stump
    for dx in (-0.02, 0.02):
        p.append(rod((0.2 + dx, -0.3, 0.0), (0.12 + dx * 2, -0.22, 0.55), 0.009, verts=5, name="tongs"))
    return deliver(p, "furn_anvil")


def build_grindstone():
    """A sandstone wheel on an iron spindle in a trestle frame, with a crank
    and the water trough it runs in."""
    reset(43)
    p = []
    zc = 0.7
    wheel = lib.cylinder(0.38, 0.11, (0, 0, zc), (0, math.pi / 2, 0), verts=18, name="wheel", mat="rock")
    p.append(tag(wheel, "rock"))
    lib.shade_smooth(wheel)
    p.append(rod((-0.42, 0, zc), (0.42, 0, zc), 0.02, verts=6, name="spindle"))
    p.append(rod((0.42, 0, zc), (0.42, 0.0, zc - 0.2), 0.016, verts=5, name="crank"))
    p.append(rod((0.42, 0.0, zc - 0.2), (0.55, 0.0, zc - 0.2), 0.02, m="wood", verts=6, name="grip"))
    for s in (-1, 1):
        x = s * 0.2
        p.append(beam((0.08, 1.0, 0.08), (x, 0, 0.45), name="rail"))
        for sy in (-1, 1):
            p.append(strut((x + s * 0.08, sy * 0.52, 0.0), (x, sy * 0.4, 0.45), 0.07, 0.07, name="leg"))
        p.append(beam((0.1, 0.1, 0.3), (x, 0, 0.6), name="bearing"))
    trough = [board((0.36, 0.7, 0.03), (0, 0, 0.3), wear=0.004, m="planks")]
    for sy in (-1, 1):
        trough.append(board((0.36, 0.03, 0.16), (0, sy * 0.34, 0.37), wear=0.004, m="planks"))
    for sx in (-1, 1):
        trough.append(board((0.03, 0.7, 0.16), (sx * 0.17, 0, 0.37), wear=0.004, m="planks"))
    p += trough
    p.append(tag(lib.box((0.3, 0.64, 0.01), (0, 0, 0.4), mat="stonewall"), "water"))
    return deliver(p, "furn_grindstone")


def sword(x, y, z, turn=0.0, L=0.9, tilt=0.0):
    """Hilt up, point down in the rack's base."""
    parts = []
    blade = lib.loft([(0.0, 0.004, 0.002, 0, 0), (0.08, 0.02, 0.004, 0, 0), (L - 0.2, 0.024, 0.005, 0, 0),
                      (L - 0.16, 0.026, 0.005, 0, 0)], sides=4, name="blade", mat="steel")
    parts.append(tag(blade, "steel"))
    parts.append(tag(kit.slab((0.2, 0.035, 0.022), (0, 0, L - 0.15), mat="iron", width=0.006), "iron"))
    parts.append(lathe([(L - 0.14, 0.017), (L - 0.03, 0.015)], 0, 0, 0, sides=6, m="leather", smooth=False,
                       name="grip"))
    parts.append(tag(lib.sphere(0.028, (0, 0, L - 0.01), segments=8, rings=5, mat="iron"), "iron"))
    return kit.place(parts, (x, y, z), (tilt, 0, turn))


def spear(x, y, z, L=2.1, tilt=0.0, turn=0.0):
    parts = [lathe([(0, 0.018), (L - 0.3, 0.015)], 0, 0, 0, sides=6, m="wood", smooth=False, name="shaft")]
    head = lib.loft([(L - 0.32, 0.018, 0.018, 0, 0), (L - 0.24, 0.016, 0.016, 0, 0), (L - 0.2, 0.04, 0.008, 0, 0),
                     (L - 0.05, 0.022, 0.005, 0, 0), (L, 0.002, 0.002, 0, 0)], sides=4, name="head", mat="steel")
    parts.append(tag(head, "steel"))
    return kit.place(parts, (x, y, z), (tilt, 0, turn))


def axe(x, y, z, L=0.85, tilt=0.0, turn=0.0):
    parts = [lathe([(0, 0.02), (L, 0.017)], 0, 0, 0, sides=6, m="wood", smooth=False, name="haft")]
    blade = prism([(0.0, L - 0.2), (0.05, L - 0.2), (0.2, L - 0.29), (0.22, L - 0.2), (0.22, L - 0.02),
                   (0.19, L + 0.04), (0.05, L - 0.06), (0.0, L - 0.06)], -0.012, 0.012, name="axehead", axis="y")
    parts.append(tag(blade, "steel"))
    return kit.place(parts, (x, y, z), (tilt, 0, turn))


def build_weapon_rack():
    """A floor rack against the wall: a slotted base, a notched top rail on two
    posts, and what the weaponsmith sells standing in it -- spears, swords hilt
    up, an axe. Wall at y = 0, 1.7 wide, 0.46 deep."""
    reset(44)
    p = []
    W = 1.7
    p.append(board((W, 0.4, 0.1), (0, -0.23, 0.05), wear=0.006, name="base"))
    for s in (-1, 1):
        p.append(beam((0.08, 0.08, 1.75), (s * (W / 2 - 0.04), -0.08, 0.875), name="post"))
        p.append(strut((s * (W / 2 - 0.04), -0.42, 0.1), (s * (W / 2 - 0.04), -0.1, 0.9), 0.06, name="brace"))
    p.append(beam((W, 0.1, 0.08), (0, -0.14, 1.3), name="rail"))
    for i in range(9):
        x = -W / 2 + 0.12 + i * (W - 0.24) / 8
        p.append(board((0.03, 0.1, 0.06), (x, -0.2, 1.3), wear=0.003, name="tooth"))
    p.append(beam((W + 0.06, 0.09, 0.06), (0, -0.1, 1.78), name="cap"))
    for i, x in enumerate((-0.66, -0.47, -0.28)):
        p += spear(x, -0.19, 0.1, L=2.05 + 0.05 * i, tilt=math.radians(-6))
    for i, x in enumerate((-0.07, 0.12, 0.31)):
        p += sword(x, -0.2, 0.1, turn=0.1 * i, L=0.95 + 0.06 * i, tilt=math.radians(-5))
    p += axe(0.5, -0.2, 0.1, L=0.95, tilt=math.radians(-5), turn=math.radians(90))
    p += axe(0.68, -0.2, 0.1, L=1.05, tilt=math.radians(-5), turn=math.radians(80))
    return deliver(p, "furn_weapon_rack")


def build_weapon_board():
    """The armourer's wall: a boarded panel with pegs, a round shield, two
    swords crossed under it and an axe either side. Wall at y = 0."""
    reset(45)
    p = []
    p.append(board((1.8, 0.03, 1.4), (0, -0.015, 1.65), wear=0.006, m="planks", name="panel"))
    for z in (1.0, 2.3):
        p.append(beam((1.9, 0.05, 0.08), (0, -0.04, z), name="batten"))
    # the shield: a dished disc, painted, with a boss and rim
    sh = lathe([(0, 0.0), (0.001, 0.36), (0.02, 0.37), (0.03, 0.34), (0.06, 0.12), (0.1, 0.06), (0.11, 0.0)],
               0, 0, 0, sides=16, m="paint", smooth=True, caps=False, name="shield")
    sh.rotation_euler = (math.pi / 2, 0, 0)
    sh.location = (0, -0.05, 1.85)
    p.append(sh)
    p.append(lathe([(0.0, 0.372), (0.03, 0.372)], 0, 0, 0, sides=16, m="iron", smooth=False, caps=False, name="rim"))
    p[-1].rotation_euler = (math.pi / 2, 0, 0)
    p[-1].location = (0, -0.05, 1.85)
    # two swords crossed under the shield, hilts up and out: each is laid flat
    # against the board (turned a quarter about X) and then swung about Y
    for a in (math.radians(32), math.radians(-32)):
        blade = sword(0, 0, 0, L=0.95)
        kit.place(blade, (0, 0, -0.48))
        kit.place(blade, (0, -0.07 if a > 0 else -0.09, 1.3), (0, a, 0))
        p += blade
    for s in (-1, 1):
        p += axe(s * 0.72, -0.08, 1.05, L=0.8, tilt=0.0, turn=0.0 if s > 0 else math.pi)
    for (x, z) in ((-0.5, 1.2), (0.5, 1.2), (0, 2.12)):
        p.append(peg(x, -0.06, z, r=0.014, h=0.06, axis="y"))
    return deliver(p, "furn_weapon_board")


def build_armour_stand():
    """A mail hauberk on a wooden form, a helm on the head, a kite shield
    stood against the foot. The armourer's window, in the mud's words."""
    reset(46)
    p = []
    for a in (0, math.pi / 2):
        p.append(beam((0.7, 0.08, 0.07), (0, 0, 0.035), (0, 0, a), name="foot"))
    p.append(beam((0.07, 0.07, 1.5), (0, 0, 0.75), name="post"))
    p.append(beam((0.46, 0.07, 0.06), (0, 0, 1.4), name="yoke"))
    torso = lib.loft([(0.72, 0.27, 0.19, 0, 0), (0.78, 0.26, 0.18, 0, 0), (0.98, 0.22, 0.15, 0, 0.005),
                      (1.15, 0.24, 0.155, 0, 0.0), (1.33, 0.25, 0.15, 0, 0.0), (1.42, 0.2, 0.12, 0, 0.0),
                      (1.47, 0.08, 0.07, 0, 0)], sides=12, name="hauberk", mat="mail")
    p.append(tag(torso, "mail"))
    lib.shade_smooth(torso)
    for s in (-1, 1):
        sleeve = lib.loft([(0, 0.075, 0.07, 0, 0), (0.3, 0.07, 0.065, 0, 0), (0.34, 0.075, 0.07, 0, 0)],
                          sides=8, axis="x", name="sleeve", mat="mail")
        sleeve.rotation_euler = (0, math.radians(62), 0 if s > 0 else math.pi)
        sleeve.location = (s * 0.2, 0, 1.38)
        p.append(tag(sleeve, "mail"))
        lib.shade_smooth(sleeve)
    p.append(lathe([(0, 0.2), (0.07, 0.2)], 0, 0.0, 0.95, sides=12, m="leather", smooth=False, caps=False,
                   name="belt", sx=1.0, sy=0.74))
    head = lib.sphere(0.1, (0, 0, 1.6), segments=10, rings=7, name="head", mat="wood")
    head.scale = (0.9, 1.0, 1.1)
    p.append(tag(head, "wood"))
    p.append(lathe([(0, 0.07), (0.05, 0.075)], 0, 0, 1.47, sides=8, m="wood", smooth=False, name="neck"))
    helm = lathe([(0.0, 0.118), (0.06, 0.12), (0.12, 0.108), (0.17, 0.075), (0.2, 0.03), (0.21, 0.0)],
                 0, 0, 1.56, sides=12, m="steel", name="helm", sx=0.95, sy=1.05)
    p.append(helm)
    p.append(tag(lib.box((0.025, 0.012, 0.13), (0, -0.128, 1.6), mat="steel"), "steel"))
    p.append(lathe([(0.0, 0.123), (0.02, 0.123)], 0, 0, 1.56, sides=12, m="iron", smooth=False, caps=False,
                   name="band", sx=0.95, sy=1.05))
    kite = [(-0.22, 0.75), (0.22, 0.75), (0.23, 0.55), (0.16, 0.3), (0.0, 0.0), (-0.16, 0.3), (-0.23, 0.55)]
    sh = prism(kite, -0.012, 0.012, m="paint", name="kite", axis="y")
    sh.rotation_euler = (math.radians(-14), 0, 0)
    sh.location = (0.0, -0.3, 0.02)
    p.append(sh)
    rim = prism([(x * 1.06, z * 1.02 - 0.01) for (x, z) in kite], -0.008, 0.008, m="iron", name="rim", axis="y")
    rim.rotation_euler = (math.radians(-14), 0, 0)
    rim.location = (0.0, -0.29, 0.02)
    p.append(rim)
    return deliver(p, "furn_armour_stand")


# --- the baker ------------------------------------------------------------

def build_oven():
    """A baker's oven: a brick base, the dome behind a brick front with the
    mouth in it, the flue off the front up to the ceiling, an iron door stood
    beside the mouth and a peel leaning on the side. Wall at y = 0."""
    reset(51)
    p = []
    W, D, Hb = 1.9, 1.75, 0.85
    p.append(tag(lib.box((W, D, Hb), (0, -D / 2, Hb / 2), mat="stonewall"), "firebrick"))
    p.append(kit.slab((W + 0.08, D + 0.06, 0.08), (0, -D / 2, Hb + 0.04), mat="flagstone", width=0.012))
    secs = []
    for k in range(7):
        t = k / 6
        a = t * math.pi / 2
        secs.append((Hb + 0.08 + math.sin(a) * 0.72, 0.9 * math.cos(a) + 0.02, 0.78 * math.cos(a) + 0.02, 0, -0.82))
    dome = lib.loft(secs, sides=14, name="dome", mat="stonewall")
    p.append(tag(dome, "firebrick"))
    lib.shade_smooth(dome, angle=50)
    fy = -D + 0.02
    fz0, fz1 = Hb + 0.08, Hb + 0.95
    # the front: piers either side of the mouth and an arch-topped lintel
    for s in (-1, 1):
        p.append(tag(lib.box((0.42, 0.34, fz1 - fz0), (s * 0.44, fy + 0.17, (fz0 + fz1) / 2), mat="stonewall"),
                     "firebrick"))
    p.append(tag(lib.box((1.3, 0.34, 0.33), (0, fy + 0.17, fz1 - 0.165), mat="stonewall"), "firebrick"))
    ring = [(0.23 * math.cos(math.pi * k / 8), 0.2 + 0.23 * math.sin(math.pi * k / 8)) for k in range(9)]
    mouth = prism([(-0.23, 0.0), (0.23, 0.0)] + ring, fy + 0.15, fy + 0.34, m="soot", name="mouth",
                  axis="y")
    mouth.location = (0, 0, fz0)
    p.append(mouth)
    top = fz1 - 0.33 - fz0
    spandrel = prism([(-0.23, 0.2)] + list(reversed(ring))[1:-1] + [(0.23, 0.2), (0.23, top), (-0.23, top)],
                     fy, fy + 0.34, m="firebrick", name="spandrel", axis="y")
    spandrel.location = (0, 0, fz0)
    p.append(spandrel)
    for k in range(7):
        a = math.pi * (k + 0.5) / 7
        p.append(kit.slab((0.1, 0.3, 0.1), (math.cos(a) * 0.28, fy + 0.14, fz0 + 0.2 + math.sin(a) * 0.28),
                          (0, math.pi / 2 - a, 0), mat="flagstone", name="voussoir", width=0.01))
    p.append(kit.slab((1.34, 0.4, 0.06), (0, fy + 0.18, fz1 + 0.03), mat="flagstone", width=0.012))
    p.append(tag(lib.box((0.5, 0.45, CEIL - fz1 - 0.06), (0, fy + 0.3, (fz1 + 0.06 + CEIL) / 2), mat="stonewall"),
                 "firebrick"))
    # ash hole in the base
    p.append(tag(lib.box((0.5, 0.02, 0.28), (0, -D - 0.005, 0.35), mat="stonewall"), "soot"))
    # the door, stood on the ledge beside the mouth
    door = prism([(-0.22, 0.0), (0.22, 0.0), (0.22, 0.2), (0.15, 0.31), (0.0, 0.35), (-0.15, 0.31), (-0.22, 0.2)],
                 -0.01, 0.01, m="iron", name="door", axis="y")
    door.rotation_euler = (math.radians(-12), 0, 0.3)
    door.location = (0.62, -D - 0.07, 0.0)
    p.append(door)
    # a peel against the side
    p.append(strut((W / 2 + 0.06, -0.5, 0.05), (W / 2 + 0.04, -0.62, 2.0), 0.035, name="peel"))
    blade = board((0.02, 0.32, 0.36), (W / 2 + 0.065, -0.5, 0.22), wear=0.004, name="peelblade")
    p.append(blade)
    # a stack of faggots for the firing under the front ledge
    for i in range(5):
        log = lib.cylinder(0.05, 0.8, (-0.4 + i * 0.1 - 0.9 * 0, -D - 0.25, 0.05 + (i % 2) * 0.08),
                           (math.pi / 2, 0, math.pi / 2 + rng.uniform(-0.1, 0.1)), verts=6, mat="bark")
        p.append(tag(log, "bark"))
    return deliver(p, "furn_oven")


# --- shelving -------------------------------------------------------------

SH_W, SH_D = 3.0, 0.36


def shelving():
    """The carcase every shop's shelves share: three uprights, a plinth, five
    boards and a cornice, 2.45 tall. Wall at y = 0. Returns (parts, levels)."""
    p = []
    levels = [0.14, 0.64, 1.14, 1.64, 2.14]
    p.append(board((SH_W, 0.02, 2.4), (0, -0.012, 1.22), wear=0.0, m="planks", name="back"))
    # the hearth's backing, for the same reason (see `hearth`)
    p.append(board((SH_W, BACKING, 2.48), (0, 0.003 + BACKING / 2, 1.24), wear=0.0, m="planks", name="backing"))
    for x in (-SH_W / 2 + 0.02, 0.0, SH_W / 2 - 0.02):
        p.append(board((0.035, SH_D, 2.44), (x, -SH_D / 2, 1.22), wear=0.004, name="upright"))
    p.append(board((SH_W, 0.03, 0.12), (0, -SH_D + 0.015, 0.06), wear=0.004, name="plinth"))
    for z in levels:
        p.append(board((SH_W - 0.06, SH_D - 0.02, 0.03), (0, -SH_D / 2 - 0.005, z), wear=0.004, name="shelf"))
    p.append(worn((SH_W + 0.1, SH_D + 0.06, 0.04), (0, -SH_D / 2 - 0.02, 2.46), wear=0.01, name="cornice"))
    return p, [z + 0.015 for z in levels]


def fill_row(z, x0, x1, place):
    """Walk along one shelf from x0 to x1, asking `place(x, z)` for a thing and
    how wide it was."""
    x = x0
    out = []
    while x < x1:
        parts, w = place(x, z)
        if x + w > x1:
            break
        out += parts
        x += w + rng.uniform(0.04, 0.1)
        # a shop's shelves are never quite full: a gap is where something sold
        if rng.random() < 0.18:
            x += rng.uniform(0.12, 0.3)
    return out


def build_shelves_goods():
    """A general store: crocks and jars, small boxes, bolts of cloth, coils of
    rope, candles in bundles -- "all sorts of items are stacked on shelves"."""
    reset(61)
    p, levels = shelving()

    def thing(x, z):
        k = rng.random()
        y = -SH_D / 2
        if k < 0.3:
            r = rng.uniform(0.06, 0.09)
            return crock(x + r, y, z, h=rng.uniform(0.16, 0.26), r=r, lid=rng.random() < 0.7), 2 * r
        if k < 0.5:
            w = rng.uniform(0.18, 0.3)
            h = rng.uniform(0.1, 0.2)
            return [kit.slab((w, 0.26, h), (x + w / 2, y, z + h / 2), (0, 0, rng.uniform(-0.05, 0.05)),
                             mat="planks", width=0.006)], w
        if k < 0.66:
            w = rng.uniform(0.2, 0.3)
            b = board((w, 0.28, 0.1), (x + w / 2, y, z + 0.05), m="blanket", wear=0.025)
            b2 = board((w * 0.95, 0.27, 0.09), (x + w / 2, y, z + 0.145), m="linen", wear=0.025)
            return [b, b2], w
        if k < 0.8:
            r = rng.uniform(0.09, 0.12)
            t = lib.torus(r, 0.025, (x + r + 0.02, y, z + 0.03), major_seg=10, minor_seg=4, mat="rope")
            t2 = lib.torus(r * 0.9, 0.025, (x + r + 0.02, y, z + 0.075), major_seg=10, minor_seg=4, mat="rope")
            return [tag(t, "rope"), tag(t2, "rope")], 2 * r + 0.04
        parts = []
        for i in range(5):
            parts.append(lathe([(0, 0.012), (0.24, 0.011)], x + 0.015 + (i % 3) * 0.025, y - 0.02 + (i // 3) * 0.03,
                               z, sides=5, m="wax", smooth=False, name="candle"))
        return parts, 0.09

    for z in levels[1:]:
        p += fill_row(z, -SH_W / 2 + 0.06, -0.04, thing)
        p += fill_row(z, 0.04, SH_W / 2 - 0.06, thing)
    # the bottom shelf: sacks and a cask
    y = -SH_D / 2
    for x in (-1.1, -0.5):
        s = lib.sphere(0.2, (x, y, levels[0] + 0.14), segments=8, rings=5, mat="cloth")
        s.scale = (1.0, 0.8, 0.72)
        p.append(tag(s, "cloth"))
        lib.shade_smooth(s, angle=80)
    p.append(tag(props.cask(0.14, 0.4, 0.55, y, levels[0], sides=10, name="keg"), "planks"))
    p.append(tag(props.cask(0.14, 0.4, 1.0, y, levels[0], sides=10, name="keg"), "planks"))
    return deliver(p, "furn_shelves_goods")


def build_shelves_bread():
    """"The bread and Danish are arranged in fine order on the shelves." Long
    loaves, round cobs, baskets of rolls and trays of pastries."""
    reset(62)
    p, levels = shelving()
    y = -SH_D / 2

    def thing(x, z):
        k = rng.random()
        if k < 0.35:
            L = rng.uniform(0.26, 0.34)
            return [loaf(x + 0.07, y, z, L=L, turn=math.pi / 2 + rng.uniform(-0.2, 0.2))], 0.15
        if k < 0.6:
            r = rng.uniform(0.08, 0.1)
            return [cob(x + r, y + rng.uniform(-0.04, 0.04), z, r)], 2 * r
        if k < 0.8:
            parts = [lathe([(0, 0.13), (0.07, 0.15), (0.08, 0.155)], x + 0.155, y, z, sides=12, m="wicker",
                           smooth=False, name="basket")]
            for i in range(4):
                a = i * 1.57 + 0.4
                parts.append(cob(x + 0.155 + 0.06 * math.cos(a), y + 0.06 * math.sin(a), z + 0.06, 0.05))
            return parts, 0.31
        # a board of Danish
        parts = [board((0.3, 0.26, 0.015), (x + 0.15, y, z + 0.0075), wear=0.003)]
        for i in range(6):
            parts.append(lathe([(0, 0.035), (0.012, 0.038), (0.022, 0.025)], x + 0.06 + (i % 3) * 0.09,
                               y - 0.06 + (i // 3) * 0.12, z + 0.015, sides=8, m="bread", name="danish"))
        return parts, 0.3

    for z in levels[1:]:
        p += fill_row(z, -SH_W / 2 + 0.06, -0.04, thing)
        p += fill_row(z, 0.04, SH_W / 2 - 0.06, thing)
    for x in (-1.1, -0.45, 0.4, 1.05):
        s = lib.sphere(0.21, (x, y, levels[0] + 0.15), segments=8, rings=5, mat="cloth")
        s.scale = (1.0, 0.8, 0.75)
        p.append(tag(s, "linen"))
        lib.shade_smooth(s, angle=80)
    return deliver(p, "furn_shelves_bread")


def build_shelves_jars():
    """The magic shop: "numerous shelves crammed with jars, bottles, books and
    scrolls of all sorts and sizes." And a skull, because it is a wizard's."""
    reset(63)
    p, levels = shelving()
    y = -SH_D / 2

    def thing(x, z):
        k = rng.random()
        if k < 0.28:
            n = rng.randint(3, 7)
            parts = []
            w = 0
            for i in range(n):
                t = rng.uniform(0.035, 0.06)
                h = rng.uniform(0.2, 0.3)
                parts += book(x + w + t / 2, y + 0.02, z, h=h, w=rng.uniform(0.15, 0.2), t=t,
                              lean=0.0 if i < n - 1 else 0.25)
                w += t + 0.004
            return parts, w + 0.05
        if k < 0.5:
            r = rng.uniform(0.045, 0.07)
            return crock(x + r, y, z, h=rng.uniform(0.12, 0.22), r=r, m="bottle"), 2 * r
        if k < 0.7:
            return bottle(x + 0.04, y, z, h=rng.uniform(0.18, 0.3), r=0.038,
                          m=rng.choice(("bottle", "earthenware"))), 0.08
        if k < 0.9:
            parts = []
            for i in range(3):
                sc = lib.cylinder(0.022, 0.28, (x + 0.14, y - 0.06 + i * 0.05, z + 0.022 + (i == 1) * 0.04),
                                  (0, math.pi / 2, rng.uniform(-0.2, 0.2)), verts=7, mat="linen")
                parts.append(tag(sc, "linen"))
            return parts, 0.28
        sk = lib.sphere(0.075, (x + 0.08, y, z + 0.08), segments=9, rings=7, mat="bone")
        sk.scale = (0.85, 1.05, 0.95)
        jaw = lib.box((0.08, 0.06, 0.04), (x + 0.08, y - 0.06, z + 0.02), mat="bone")
        return [tag(sk, "bone"), tag(jaw, "bone")], 0.16

    for z in levels:
        p += fill_row(z, -SH_W / 2 + 0.06, -0.04, thing)
        p += fill_row(z, 0.04, SH_W / 2 - 0.06, thing)
    return deliver(p, "furn_shelves_jars")


def build_shelves_hides():
    """The leather shop: "shelves containing all sorts of animal hide". Folded
    hides stacked flat and rolled ones end on."""
    reset(64)
    p, levels = shelving()
    y = -SH_D / 2

    def thing(x, z):
        if rng.random() < 0.55:
            w = rng.uniform(0.3, 0.42)
            parts = []
            h = 0
            for i in range(rng.randint(2, 5)):
                t = rng.uniform(0.02, 0.04)
                parts.append(board((w - i * 0.01, 0.3, t), (x + w / 2 + rng.uniform(-0.01, 0.01), y, z + h + t / 2),
                                   m="leather", wear=min(0.008, t / 3)))
                parts[-1].rotation_euler = (0, 0, rng.uniform(-0.06, 0.06))
                h += t
            return parts, w
        r = rng.uniform(0.05, 0.07)
        parts = []
        for i in range(2):
            c = lib.cylinder(r, 0.32, (x + r + i * (2 * r + 0.005), y, z + r), (math.pi / 2, 0, 0), verts=9,
                             mat="leather")
            parts.append(tag(c, "leather"))
        return parts, 4 * r + 0.01

    for z in levels[1:]:
        p += fill_row(z, -SH_W / 2 + 0.06, -0.04, thing)
        p += fill_row(z, 0.04, SH_W / 2 - 0.06, thing)
    return deliver(p, "furn_shelves_hides")


# --- rooms to live and work in --------------------------------------------

def build_bed():
    """A box bed, head to the wall: posts, a boarded head, a straw tick, a
    bolster and a woollen blanket thrown back. Wall at y = 0; 1.0 x 2.05."""
    reset(71)
    p = []
    W, L = 1.0, 2.05
    for (y, h) in ((-0.04, 1.05), (-L + 0.04, 0.62)):
        for s in (-1, 1):
            p.append(beam((0.08, 0.08, h), (s * (W / 2 - 0.04), y, h / 2), cham=0.012, name="post"))
            p.append(peg(s * (W / 2 - 0.04), y, h + 0.003, r=0.03, h=0.01))
    p.append(board((W - 0.08, 0.03, 0.62), (0, -0.04, 0.63), wear=0.006, m="planks", name="head"))
    p.append(board((W - 0.08, 0.03, 0.3), (0, -L + 0.04, 0.4), wear=0.006, m="planks", name="foot"))
    for s in (-1, 1):
        p.append(beam((0.05, L - 0.08, 0.18), (s * (W / 2 - 0.04), -L / 2, 0.33), name="rail"))
    tick = worn((W - 0.12, L - 0.14, 0.18), (0, -L / 2, 0.47), m="linen", wear=0.06)
    p.append(tick)
    bol = lib.loft([(-0.4, 0.06, 0.07, 0.62, -0.13), (0.4, 0.06, 0.07, 0.62, -0.13)], sides=8, axis="x",
                   name="bolster", mat="linen")
    p.append(tag(bol, "linen"))
    lib.shade_smooth(bol)
    # the blanket, thrown back over the lower two thirds and hanging over the sides
    bz = 0.575
    p.append(worn((W - 0.04, 1.3, 0.035), (0.01, -L + 0.72, bz), m="blanket", wear=0.012, name="blanket"))
    p[-1].rotation_euler = (0, 0, 0.02)
    p.append(worn((W - 0.05, 0.16, 0.06), (0.0, -L + 1.38, bz + 0.02), m="blanket", wear=0.028, name="fold"))
    for s in (-1, 1):
        p.append(board((0.025, 1.24, 0.24), (s * (W / 2 - 0.0), -L + 0.74, bz - 0.12), wear=0.008, m="blanket",
                       name="drop"))
    return deliver(p, "furn_bed")


def build_desk():
    """A pedestal desk, 1.8 x 0.85 with its top at 0.78: two banks of drawers,
    a kneehole, a moulded top. The mayor's is "large and polished but
    completely empty". Front (the visitor's side) at -Y."""
    reset(72)
    p = []
    W, D, H = 1.8, 0.85, 0.78
    p.append(worn((W, D, 0.04), (0, 0, H - 0.02), wear=0.014, name="top"))
    for s in (-1, 1):
        cx = s * (W / 2 - 0.26)
        p.append(board((0.48, D - 0.1, H - 0.1), (cx, 0.0, (H - 0.04 + 0.06) / 2), wear=0.006, name="pedestal"))
        p.append(board((0.5, D - 0.08, 0.06), (cx, 0, 0.03), wear=0.006, name="plinth"))
        for k in range(3):
            z = 0.12 + k * 0.2
            p.append(board((0.4, 0.02, 0.17), (cx, D / 2 - 0.04, z + 0.09), wear=0.006, name="drawer"))
            p.append(tag(lib.sphere(0.018, (cx, D / 2 - 0.01, z + 0.1), segments=6, rings=4, mat="iron"), "brass"))
    p.append(board((W - 1.0, 0.02, 0.5), (0, -D / 2 + 0.06, H - 0.35), wear=0.006, name="modesty"))
    p.append(board((W - 1.0, D - 0.12, 0.14), (0, 0, H - 0.11), wear=0.004, name="drawer"))
    p.append(board((0.5, 0.02, 0.1), (0, D / 2 - 0.04, H - 0.11), wear=0.006, name="drawerfront"))
    # the visitor's face of each pedestal: a raised panel
    for s in (-1, 1):
        cx = s * (W / 2 - 0.26)
        p.append(board((0.36, 0.014, 0.5), (cx, -D / 2 + 0.045, 0.4), wear=0.012, name="field"))
    return deliver(p, "furn_desk")


def build_desk_things():
    """What is on a desk that is used: a book open, a ledger shut, an inkwell
    and quill, papers, a candle. Placed on the desk's top at 0.78."""
    reset(73)
    p = []
    z = 0.78
    p.append(board((0.34, 0.24, 0.02), (-0.35, 0.05, z + 0.01), wear=0.002, m="linen", name="pages"))
    p.append(board((0.36, 0.26, 0.008), (-0.35, 0.05, z + 0.004), wear=0.0, m="leather", name="cover"))
    p += book(0.4, 0.15, z, h=0.3, w=0.22, t=0.06, turn=0.3, flat=True)
    for i in range(3):
        sh = board((0.21, 0.29, 0.002), (0.05 + i * 0.02, -0.08, z + 0.002 + i * 0.002), wear=0.0, m="linen")
        sh.rotation_euler = (0, 0, rng.uniform(-0.3, 0.3))
        p.append(sh)
    p += crock(0.35, -0.12, z, h=0.05, r=0.03, m="earthenware", lid=False)
    p.append(strut((0.35, -0.12, z + 0.04), (0.28, -0.05, z + 0.25), 0.006, 0.02, m="linen", cham=0.002,
                   name="quill"))
    p += candle(-0.7, 0.2, z, m="brass")
    return deliver(p, "furn_desk_things")


def build_chair():
    """A joined chair: seat at 0.45, back legs rising to 0.95 with two slats."""
    reset(74)
    p = []
    sz = 0.45
    for s in (-1, 1):
        p.append(beam((0.045, 0.045, sz), (s * 0.2, -0.18, sz / 2), name="leg"))
        p.append(strut((s * 0.2, 0.19, 0), (s * 0.2, 0.22, 0.97), 0.045, 0.05, name="backleg"))
    p.append(worn((0.46, 0.44, 0.035), (0, 0.0, sz - 0.0175), wear=0.01, name="seat"))
    for z in (0.62, 0.84):
        p.append(board((0.4, 0.02, 0.08), (0, 0.205 + (z - 0.45) * 0.03, z), wear=0.006, name="slat"))
    for (a, b) in (((-0.2, -0.18, 0.14), (0.2, -0.18, 0.14)), ((-0.2, 0.19, 0.14), (0.2, 0.19, 0.14)),
                   ((-0.2, -0.18, 0.2), (-0.2, 0.19, 0.2)), ((0.2, -0.18, 0.2), (0.2, 0.19, 0.2))):
        p.append(strut(a, b, 0.025, name="rung"))
    return deliver(p, "furn_chair")


def build_armchair():
    """"An armchair that looks so comfortable that it most of all resembles a
    bed with the head end raised slightly." A deep joined chair with a raked
    back, broad arms and a thick cushion on each."""
    reset(75)
    p = []
    W, Dp, sz = 0.78, 0.72, 0.42
    for sx in (-1, 1):
        p.append(beam((0.07, 0.07, 0.66), (sx * (W / 2 - 0.035), -Dp / 2 + 0.035, 0.33), name="leg"))
        p.append(strut((sx * (W / 2 - 0.035), Dp / 2 - 0.035, 0.0), (sx * (W / 2 - 0.035), Dp / 2 + 0.12, 1.25),
                       0.07, 0.07, name="backpost"))
        p.append(worn((0.1, Dp + 0.06, 0.05), (sx * (W / 2 - 0.035), -0.02, 0.68), wear=0.012, name="arm"))
        p.append(board((0.03, Dp - 0.1, 0.24), (sx * (W / 2 - 0.035), 0, 0.46), wear=0.004, name="side"))
    p.append(board((W - 0.1, Dp - 0.06, 0.05), (0, 0, sz - 0.1), wear=0.004, name="seatboard"))
    p.append(board((W - 0.1, 0.03, sz - 0.16), (0, -Dp / 2 + 0.04, (sz - 0.1) / 2 + 0.04), wear=0.004, name="apron"))
    cush = worn((W - 0.12, Dp - 0.08, 0.12), (0, -0.02, sz + 0.01), m="blanket", wear=0.05, name="cushion")
    p.append(cush)
    back = board((W - 0.1, 0.04, 0.9), (0, Dp / 2 + 0.04, 0.85), wear=0.006, m="wood", name="back")
    back.rotation_euler = (math.radians(-12), 0, 0)
    p.append(back)
    bc = worn((W - 0.16, 0.12, 0.72), (0, Dp / 2 - 0.05, 0.86), m="blanket", wear=0.05, name="backcushion")
    bc.rotation_euler = (math.radians(-12), 0, 0)
    p.append(bc)
    p.append(worn((W + 0.04, 0.1, 0.06), (0, Dp / 2 + 0.14, 1.3), wear=0.014, name="crest"))
    return deliver(p, "furn_armchair")


# --- on tables and counters -----------------------------------------------

def build_tankard():
    reset(81)
    return deliver(tankard(0, 0, 0, m="wood"), "furn_tankard")


def build_tankard_pewter():
    reset(82)
    return deliver(tankard(0, 0, 0, m="pewter"), "furn_tankard_pewter")


def build_jug():
    reset(83)
    return deliver(jug(0, 0, 0, h=0.28, r=0.08), "furn_jug")


def build_candle():
    reset(84)
    return deliver(candle(0, 0, 0, m="brass"), "furn_candle")


def build_scales():
    """A grocer's balance: a post on a base, a beam, two pans on cords."""
    reset(85)
    p = []
    p.append(board((0.34, 0.16, 0.03), (0, 0, 0.015), wear=0.006, name="base"))
    p.append(rod((0, 0, 0.03), (0, 0, 0.42), 0.012, m="brass", verts=6, name="post"))
    p.append(rod((-0.2, 0, 0.42), (0.2, 0, 0.42), 0.007, m="brass", verts=5, name="beam"))
    for s in (-1, 1):
        x = s * 0.19
        p.append(lathe([(0, 0.02), (0.012, 0.08), (0.018, 0.085)], x, 0, 0.12, sides=10, m="brass", name="pan"))
        for k in range(3):
            a = k * 2.094
            p.append(rod((x + 0.075 * math.cos(a), 0.075 * math.sin(a), 0.135), (x, 0, 0.42), 0.002,
                         m="rope", verts=3, name="cord"))
    p.append(lathe([(0, 0.02), (0.03, 0.02), (0.04, 0.012)], -0.19, 0, 0.138, sides=6, m="brass", name="weight"))
    return deliver(p, "furn_scales")


def build_basket():
    """A round wicker basket of bread rolls, for a counter or a floor."""
    reset(86)
    p = [lathe([(0, 0.16), (0.03, 0.2), (0.2, 0.24), (0.22, 0.245)], 0, 0, 0, sides=12, m="wicker", name="basket"),
         lathe([(0.2, 0.25), (0.23, 0.25)], 0, 0, 0, sides=12, m="wicker", smooth=False, caps=False, name="rim")]
    for i in range(7):
        a = i * 0.9
        rr = 0.12 if i else 0.0
        p.append(cob(rr * math.cos(a), rr * math.sin(a), 0.17 + (0.03 if not i else 0.0), 0.065))
    return deliver(p, "furn_basket")


ASSETS = [
    build_table_trestle, build_table_board, build_bench_plank, build_bench_staked, build_stool, build_settle,
    build_bar_counter, build_shop_counter, build_backbar, build_cask_rack,
    build_hearth, build_hearth_pot, build_forge, build_anvil, build_grindstone,
    build_weapon_rack, build_weapon_board, build_armour_stand, build_oven,
    build_shelves_goods, build_shelves_bread, build_shelves_jars, build_shelves_hides,
    build_bed, build_desk, build_desk_things, build_chair, build_armchair,
    build_tankard, build_tankard_pewter, build_jug, build_candle, build_scales, build_basket,
]


def build(only=None):
    out = []
    for fn in ASSETS:
        name = fn.__name__[len("build_"):]
        if only and name not in only:
            continue
        out.append(fn())
    return "\n".join(out)


# --- looking at it --------------------------------------------------------

def preview(names, path="/tmp/furnish-preview.png", cols=4, pitch=3.2, res=1600, azim=-30.0, elev=22.0,
            dist=None, lens=50.0):
    """Import the exported files into an empty scene in a grid and render
    them with Workbench, flat material colours, shadows and cavity -- the
    exported file, not the scene that made it, is what the viewer loads."""
    import os
    lib.reset()
    for i, name in enumerate(names):
        fp = os.path.join(lib.ASSETS, "%s.glb" % name)
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=fp)
        dx = (i % cols - (cols - 1) / 2.0) * pitch
        dy = (i // cols) * pitch
        for obj in set(bpy.context.scene.objects) - before:
            if obj.parent is None:
                obj.location.x += dx
                obj.location.y += dy
    for m in bpy.data.materials:
        key = m.name.split(".")[0]
        key = key[4:] if key.startswith("MAT:") else key
        m.diffuse_color = PAL.get(key, lib.PALETTE.get(key, (0.6, 0.6, 0.6, 1.0)))
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0))
    floor = bpy.context.object
    floor.data.materials.append(bpy.data.materials.new("floor"))
    floor.data.materials[0].diffuse_color = (0.55, 0.53, 0.5, 1.0)
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_WORKBENCH"
    except TypeError:
        pass
    sh = scene.display.shading
    sh.light = "STUDIO"
    sh.color_type = "MATERIAL"
    sh.show_shadows = True
    sh.show_cavity = True
    sh.cavity_type = "BOTH"
    scene.display.shadow_focus = 0.6
    rows = (len(names) + cols - 1) // cols
    cx, cy = 0.0, (rows - 1) * pitch / 2
    d = dist or max(cols, rows) * pitch * 1.25
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = lens
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    a, e = math.radians(azim), math.radians(elev)
    cz = 0.9
    cam.location = (cx + d * math.sin(a) * math.cos(e), cy - d * math.cos(a) * math.cos(e), cz + d * math.sin(e))
    cam.rotation_euler = (math.pi / 2 - e, 0, a)
    scene.camera = cam
    scene.render.resolution_x = res
    scene.render.resolution_y = int(res * 0.62)
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    return path
