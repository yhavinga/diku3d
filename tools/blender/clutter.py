"""clutter -- the things a room's own prose says are in it (src/clutter.js).

"Along the walls skeletons are hanging in rusty chains. In the middle of the
room there is a big metal box." The shells make the room and furniture.py
makes what a trade keeps in it; this makes the rest of the nouns, driven by
what the nine default areas actually name, most frequent and most visible
first: the tombs' sarcophagi, the lairs' bones and skulls, the dead hanging,
lying and sitting, signs and paintings on walls, the laboratory's tables and
pentagrams, webs, cages, a hoard, a feast, the chain to the clouds.

Conventions are the library's and furniture.py's: Z up, metres, origin on the
floor. Anything that goes on or against a wall has the wall at y = 0 and
reaches out into -Y, which the exporter turns into three's +Z -- the frame
src/clutter.js places in. Free-standing pieces are centred on the origin with
their front at -Y. Every surface is a `MAT:` tag the viewer swaps for a baked
or flat material; bone is `oldbone` and iron `rust`, and clutter.js swaps both
for their `buried` twins in a room under the ground.

Where a thing's look is its colour -- a painting, a tapestry, a pelt, the
food on a table -- the colour is in the vertices (COLOR_0) over a white flat
material, so a painting is a grid of painted vertices and needs no texture.
"""

import math
import random
import importlib

import bpy
import mathutils

import lib
import kit
import furniture as F
importlib.reload(lib)
importlib.reload(kit)
importlib.reload(F)

V = mathutils.Vector

# Viewport and preview colours only.
PAL = dict(F.PAL)
PAL.update({
    "oldbone": (0.80, 0.76, 0.64, 1.0), "rust": (0.33, 0.20, 0.13, 1.0),
    "iron": (0.20, 0.20, 0.21, 1.0), "silk": (0.86, 0.85, 0.80, 1.0),
    "chalk": (0.88, 0.86, 0.80, 1.0), "slate": (0.17, 0.19, 0.20, 1.0),
    "canvas": (1.0, 1.0, 1.0, 1.0), "weave": (1.0, 1.0, 1.0, 1.0),
    "produce": (1.0, 1.0, 1.0, 1.0), "flesh": (0.40, 0.14, 0.11, 1.0),
    "gold": (0.83, 0.65, 0.29, 1.0), "glow": (0.8, 0.8, 1.0, 1.0),
    "flagstone": (0.52, 0.50, 0.46, 1.0), "thatch": (0.66, 0.55, 0.30, 1.0),
    "fur": (1.0, 1.0, 1.0, 1.0), "phial": (1.0, 1.0, 1.0, 1.0),
})
F.PAL.update(PAL)

# Tags whose surface is white and whose colour is in the vertices.
PAINTED = {"canvas", "weave", "produce", "phial", "glow", "fur"}

rng = random.Random(1)


def reset(seed):
    lib.reset()
    rng.seed(seed)
    F.rng.seed(seed)


def tag(obj, m):
    return F.tag(obj, m)


def paint(obj, colour):
    """One colour for every vertex of a part, or a function of its position."""
    me = obj.data
    if "Col" in me.color_attributes:
        me.color_attributes.remove(me.color_attributes["Col"])
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    mw = obj.matrix_world
    for i, v in enumerate(me.vertices):
        c = colour(mw @ v.co) if callable(colour) else colour
        attr.data[i].color = (c[0], c[1], c[2], 1.0)
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.find("Col")
    return obj


def deliver(parts, name, colours=False):
    """furniture.deliver, and vertex colours when the asset carries them:
    every part gets a colour attribute (white where it has none of its own),
    because join() fills a part without one with black."""
    parts = [p for p in parts if p is not None]
    for obj in parts:
        lib.apply_modifiers(obj)
        kit.zero_origin(obj)
        F.unwrap(obj)
        if colours and "Col" not in obj.data.color_attributes:
            paint(obj, (1.0, 1.0, 1.0))
    obj = lib.join(parts, name)
    kit.zero_origin(obj)
    obj.data.name = name
    tris = lib.stats([obj])
    if colours:
        # A custom attribute, not COLOR_0: Blender 5.2's exporter gives the
        # real colours to the first material of a mesh only and writes white
        # for every other primitive (people.py found it on the eyes; here it
        # blanked every painting). assets.js hands `_col` back as `color`.
        obj.data.color_attributes["Col"].name = "_col"
        lib.export(name, [obj], export_vertex_color="NONE", export_attributes=True)
    else:
        lib.export(name, [obj])
    return "%-26s %5d tris" % (name, tris)


# --- parts ----------------------------------------------------------------

def tube(points, radii, sides=6, m="oldbone", caps=True, name="tube", smooth=75):
    """A solid swept along a polyline: a bone, a rib, a finger, a pipe, a
    strand of silk. Rings are carried along by parallel transport, so a
    curve does not twist, and each ring faces the mean of its two segments."""
    P = [V(p) for p in points]
    R = radii if isinstance(radii, (list, tuple)) else [radii] * len(P)
    n = len(P)
    T = []
    for i in range(n):
        a = P[max(0, i - 1)]
        b = P[min(n - 1, i + 1)]
        T.append((b - a).normalized())
    ref = V((0, 0, 1)) if abs(T[0].z) < 0.9 else V((1, 0, 0))
    N = (ref - T[0] * ref.dot(T[0])).normalized()
    verts, faces = [], []
    for i in range(n):
        if i:
            N = (N - T[i] * N.dot(T[i])).normalized()
        B = T[i].cross(N)
        for k in range(sides):
            ang = 2 * math.pi * k / sides
            verts.append(tuple(P[i] + (N * math.cos(ang) + B * math.sin(ang)) * R[i]))
    for i in range(n - 1):
        for k in range(sides):
            j = (k + 1) % sides
            faces.append((i * sides + k, i * sides + j, (i + 1) * sides + j, (i + 1) * sides + k))
    if caps:
        faces.append(tuple(range(sides - 1, -1, -1)))
        faces.append(tuple(range((n - 1) * sides, n * sides)))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    # One consistent outward winding whichever way the rings turned.
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        lib.shade_smooth(obj, angle=smooth)
    return tag(obj, m)


def blob(c, r, m="oldbone", seg=6, rings=4, scale=(1, 1, 1), name="blob", smooth=80):
    obj = lib.sphere(1.0, tuple(c), segments=seg, rings=rings, name=name, mat="wood")
    obj.scale = (r * scale[0], r * scale[1], r * scale[2])
    if smooth:
        lib.shade_smooth(obj, angle=smooth)
    return tag(obj, m)


def arc(c, a0, a1, rx, ry, z, n=6, lift=0.0):
    """Points round an ellipse in the plane at height z (lift raises the middle)."""
    out = []
    for i in range(n + 1):
        t = i / n
        a = a0 + (a1 - a0) * t
        out.append((c[0] + math.cos(a) * rx, c[1] + math.sin(a) * ry, z + math.sin(math.pi * t) * lift))
    return out


# --- the dead -------------------------------------------------------------

def long_bone(a, b, r, m="oldbone", name="bone"):
    """A shaft with a knuckle at each end: a femur, a shin, an upper arm."""
    a, b = V(a), V(b)
    d = (b - a)
    L = d.length
    u = d / L
    pts = [a + u * (L * t) for t in (0.0, 0.08, 0.5, 0.92, 1.0)]
    parts = [tube(pts, [r * 1.45, r * 1.05, r * 0.85, r * 1.05, r * 1.35], sides=6, m=m, name=name)]
    parts.append(blob(a, r * 1.55, m, seg=6, rings=4, name=name + "_k"))
    parts.append(blob(b, r * 1.4, m, seg=6, rings=4, name=name + "_k"))
    return parts


def skull(c, fwd, up, s=1.0, jaw_drop=0.0, m="oldbone"):
    """What reads of a skull across a room is a pale dome, two big dark eye
    holes over a dark nose, a row of teeth and a narrower jaw. So: the vault,
    a flattish face under its front, dark orbits sunk almost flush in the
    face, cheekbones, teeth and the mandible. `fwd` is where the face looks."""
    f = V(fwd).normalized()
    u = V(up)
    u = (u - f * u.dot(f)).normalized()
    r = f.cross(u)                           # the skull's own left-right
    C = V(c)
    M = mathutils.Matrix((r, f, u)).transposed()

    def P(x, y, z):                          # x right, y forward, z up, in metres
        return tuple(C + r * (x * s) + f * (y * s) + u * (z * s))

    def part(x, y, z, sx, sy, sz, mat=m, seg=10, rings=6, name="s"):
        o = blob((0, 0, 0), 1.0, mat, seg=seg, rings=rings, scale=(sx * s, sy * s, sz * s), name=name)
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = M.to_quaternion()
        o.location = P(x, y, z)
        return o

    parts = [
        part(0, -0.012, 0.022, 0.071, 0.094, 0.077, seg=12, rings=8, name="vault"),
        part(0, 0.058, -0.022, 0.052, 0.042, 0.047, name="face"),
        part(0, 0.074, -0.058, 0.031, 0.024, 0.02, seg=8, rings=4, name="maxilla"),
    ]
    for sx in (-1, 1):
        parts.append(part(sx * 0.043, 0.05, -0.028, 0.015, 0.026, 0.012, seg=6, rings=4, name="cheek"))
        # Orbits: dark, and all but a couple of millimetres of them inside the face.
        parts.append(part(sx * 0.026, 0.079, -0.006, 0.019, 0.013, 0.018, mat="soot", seg=8, rings=5,
                          name="orbit"))
    parts.append(part(0, 0.088, -0.035, 0.009, 0.008, 0.013, mat="soot", seg=6, rings=4, name="nose"))
    parts.append(tube([P(-0.024, 0.086, -0.068), P(0, 0.095, -0.07), P(0.024, 0.086, -0.068)], 0.0065 * s,
                      sides=5, m=m, name="teeth"))
    dz = -jaw_drop
    jaw = [P(-0.048, 0.010, -0.034), P(-0.044, 0.034, -0.072 + dz * 0.5), P(-0.026, 0.072, -0.084 + dz),
           P(0, 0.086, -0.088 + dz), P(0.026, 0.072, -0.084 + dz), P(0.044, 0.034, -0.072 + dz * 0.5),
           P(0.048, 0.010, -0.034)]
    parts.append(tube(jaw, 0.0105 * s, sides=6, m=m, name="jaw"))
    return parts


def ribcage(top, bottom, fwd, width=0.15, depth=0.11, pairs=7, m="oldbone", flat=1.0):
    """The ribs, pair by pair down the spine, each sweeping out and round to
    the front. `flat` below 1 collapses the cage the way it does on its back."""
    T, B = V(top), V(bottom)
    f = V(fwd).normalized()
    down = (B - T).normalized()
    side = down.cross(f).normalized()
    f = side.cross(down).normalized()
    parts = []
    for i in range(pairs):
        t = (i + 0.6) / (pairs + 0.4)
        root = T + (B - T) * t
        # Widest two thirds of the way down; the lowest ribs float short.
        w = width * (0.62 + 0.55 * math.sin(math.pi * min(1.0, t * 1.15)))
        dp = depth * flat * (0.8 + 0.3 * math.sin(math.pi * t))
        reach = 0.95 if i < pairs - 2 else 0.62
        for sx in (-1, 1):
            pts = []
            n = 6
            for k in range(n + 1):
                a = (k / n) * math.pi * reach
                x = math.sin(a) * w
                y = (1 - math.cos(a)) * dp * 0.5
                pts.append(root + side * (sx * x) + f * (y - dp * 0.12) + down * (0.035 * math.sin(a * 0.9)))
            parts.append(tube(pts, 0.0075, sides=4, m=m, caps=False, name="rib"))
    # The sternum, where the upper ribs meet at the front.
    st0 = T + (B - T) * 0.12 + f * (depth * flat * 0.88)
    st1 = T + (B - T) * 0.62 + f * (depth * flat * 0.9)
    parts.append(tube([st0, st1], 0.013, sides=5, m=m, name="sternum"))
    return parts


def spine(points, m="oldbone"):
    parts = [tube(points, 0.014, sides=6, m=m, name="spine")]
    # Vertebrae: a knob every few centimetres along the column.
    P = [V(p) for p in points]
    total = sum((P[i + 1] - P[i]).length for i in range(len(P) - 1))
    step = 0.045
    d = step * 0.5
    i = 0
    acc = 0.0
    while d < total and i < len(P) - 1:
        seg = (P[i + 1] - P[i]).length
        if acc + seg >= d:
            t = (d - acc) / seg
            q = P[i] + (P[i + 1] - P[i]) * t
            parts.append(blob(q, 0.021, m, seg=6, rings=3, scale=(1.1, 1.0, 0.55), name="vert"))
            d += step
        else:
            acc += seg
            i += 1
    return parts


def pelvis(c, fwd, up, m="oldbone"):
    f = V(fwd).normalized()
    u = V(up)
    u = (u - f * u.dot(f)).normalized()
    r = f.cross(u)
    C = V(c)
    parts = []
    for sx in (-1, 1):
        # The iliac wings: flared shallow bowls either side.
        w = blob(C + r * (sx * 0.085) + u * 0.035, 0.07, m, seg=8, rings=4, scale=(0.75, 0.45, 1.0), name="ilium")
        w.rotation_mode = "QUATERNION"
        w.rotation_quaternion = mathutils.Matrix((r, f, u)).transposed().to_quaternion() @ \
            mathutils.Quaternion((0, 0, 1), sx * 0.5)
        parts.append(w)
    # The ring the legs hang from, and the sacrum behind it.
    ring = [C + r * (math.cos(a) * 0.075) + f * (math.sin(a) * 0.05) - u * 0.03
            for a in [k * 2 * math.pi / 8 for k in range(9)]]
    parts.append(tube(ring, 0.014, sides=5, m=m, caps=False, name="ring"))
    parts.append(blob(C - f * 0.05 + u * 0.01, 0.04, m, seg=6, rings=4, scale=(0.8, 0.6, 1.2), name="sacrum"))
    return parts


def hand(wrist, direction, side, m="oldbone", spread=0.35, curl=0.3, s=1.0):
    """Four fingers and a thumb from a small palm: the one part people look
    at after the skull."""
    W = V(wrist)
    d = V(direction).normalized()
    ref = V((0, 0, 1)) if abs(d.z) < 0.9 else V((1, 0, 0))
    across = d.cross(ref).normalized()
    normal = across.cross(d).normalized()
    parts = [blob(W + d * 0.04 * s, 0.028 * s, m, seg=6, rings=3, scale=(1.0, 1.0, 0.45), name="palm")]
    for k in range(4):
        o = (k - 1.5) / 1.5
        base = W + d * 0.075 * s + across * (o * 0.022 * s)
        dirk = (d + across * (o * spread * 0.3)).normalized()
        p1 = base + dirk * 0.035 * s
        p2 = p1 + (dirk - normal * curl).normalized() * 0.028 * s
        p3 = p2 + (dirk - normal * curl * 2).normalized() * 0.02 * s
        parts.append(tube([base, p1, p2, p3], 0.0055 * s, sides=4, m=m, name="finger"))
    tb = W + d * 0.03 * s - across * (side * 0.03 * s)
    parts.append(tube([tb, tb + (d - across * side).normalized() * 0.04 * s], 0.006 * s, sides=4, m=m,
                      name="thumb"))
    return parts


def foot(ankle, toe, m="oldbone"):
    A, T = V(ankle), V(toe)
    d = T - A
    parts = [blob(A + d * 0.2, 0.03, m, seg=6, rings=3, scale=(1.0, 1.0, 0.8), name="heel")]
    across = d.cross(V((0, 0, 1)))
    if across.length < 1e-4:
        across = d.cross(V((1, 0, 0)))
    across.normalize()
    for k in range(5):
        o = (k - 2) / 2
        parts.append(tube([A + d * 0.3 + across * (o * 0.018), T + across * (o * 0.026)], 0.0065, sides=4, m=m,
                          name="toe"))
    return parts


def skeleton(J, m="oldbone", jaw=0.01):
    """A whole skeleton from a dict of joint positions (see the poses below):
    spine, ribs, pelvis, girdle, limbs, hands, feet and skull."""
    p = []
    p += spine(J["spine"], m)
    p += ribcage(J["spine"][1], J["spine"][3], J["chest"], m=m, flat=J.get("flat", 1.0))
    p += pelvis(J["pelvis"], J["pelvis_fwd"], J["pelvis_up"], m)
    p += skull(J["head"], J["face"], J["crown"], jaw_drop=jaw, m=m)
    for s, k in ((-1, "l"), (1, "r")):
        sh, el, wr = J["sh_" + k], J["el_" + k], J["wr_" + k]
        # Collarbone from the top of the sternum out to the shoulder, and the
        # shoulder blade behind.
        neck = V(J["spine"][0])
        p.append(tube([neck + (V(J["chest"]).normalized() * 0.05), V(sh)], 0.009, sides=4, m=m, name="clav"))
        p += long_bone(sh, el, 0.014, m, "humerus")
        # Two bones in the forearm, a finger's width apart.
        fa = V(wr) - V(el)
        off = fa.cross(V((0, 0, 1)))
        if off.length < 1e-4:
            off = fa.cross(V((1, 0, 0)))
        off = off.normalized() * 0.011
        p.append(tube([V(el) + off, V(wr) + off], 0.008, sides=5, m=m, name="radius"))
        p.append(tube([V(el) - off, V(wr) - off], 0.0085, sides=5, m=m, name="ulna"))
        p += hand(wr, J["hand_" + k], s, m, curl=J.get("curl", 0.3))
        hp, kn, an = J["hip_" + k], J["kn_" + k], J["an_" + k]
        p += long_bone(hp, kn, 0.019, m, "femur")
        p.append(blob(kn, 0.022, m, seg=6, rings=3, scale=(1, 1, 0.7), name="patella"))
        p += long_bone(kn, an, 0.016, m, "tibia")
        fb = (V(an) - V(kn)).cross(V((0, 0, 1)))
        if fb.length < 1e-4:
            fb = V((1, 0, 0))
        fb = fb.normalized() * (0.02 * s)
        p.append(tube([V(kn) + fb, V(an) + fb], 0.006, sides=4, m=m, name="fibula"))
        p += foot(an, J["toe_" + k], m)
    return p


def mirror_joints(half):
    """Left side from the right, by x -> -x, for the symmetric poses."""
    J = dict(half)
    for key in list(half):
        if key.endswith("_r"):
            v = half[key]
            J[key[:-2] + "_l"] = (-v[0], v[1], v[2])
    return J


def iron_link(c, axis_up=True, turn=0.0, L=0.075, W=0.045, r=0.0075, m="rust", sides=4):
    """One oval link of a chain, standing in the XZ plane and long along Z:
    two half-rounds joined by straights, swept round with a round bar."""
    hw = W * 0.5 - r
    hl = L * 0.5 - r
    pts = []
    for k in range(3):
        a = math.pi * k / 2
        pts.append((math.cos(a) * hw, 0.0, hl - hw + math.sin(a) * hw))
    for k in range(3):
        a = math.pi + math.pi * k / 2
        pts.append((math.cos(a) * hw, 0.0, -(hl - hw) + math.sin(a) * hw))
    pts.append(pts[0])
    obj = tube(pts, r, sides=sides, m=m, caps=False, name="link", smooth=0)
    obj.rotation_euler = (0, 0, turn)
    obj.location = c
    return obj


def chain(a, b, L=0.075, W=0.045, r=0.0075, m="rust", sag=0.0):
    """Links from a to b; `sag` hangs the middle down. Each link is turned
    to its stretch of the curve."""
    A, B = V(a), V(b)
    pts = []
    n = max(2, int((B - A).length / (L * 0.72)))
    for i in range(n + 1):
        t = i / n
        q = A + (B - A) * t
        q.z -= math.sin(math.pi * t) * sag
        pts.append(q)
    parts = []
    for i in range(n):
        c = (pts[i] + pts[i + 1]) * 0.5
        d = (pts[i + 1] - pts[i]).normalized()
        link = iron_link((0, 0, 0), L=L, W=W, r=r, m=m)
        q = V((0, 0, 1)).rotation_difference(d)
        link.rotation_mode = "QUATERNION"
        link.rotation_quaternion = q @ mathutils.Quaternion((0, 0, 1), (math.pi / 2) * (i % 2))
        link.location = c
        parts.append(link)
    return parts


def wall_ring(x, z, m="rust"):
    """A staple plate in the wall with a ring through it, at (x, z) on the
    wall plane y = 0."""
    plate = lib.box((0.09, 0.02, 0.12), (x, -0.01, z), name="plate", mat="iron")
    tag(plate, m)
    ring = lib.torus(0.035, 0.008, (x, -0.035, z - 0.04), (0, math.pi / 2, 0), major_seg=10, minor_seg=4,
                     name="ring", mat="iron")
    tag(ring, m)
    return [plate, ring]


def manacle(c, m="rust"):
    """An iron cuff: a short thick ring."""
    obj = lib.torus(0.042, 0.011, c, (math.pi / 2, 0, 0), major_seg=10, minor_seg=4, name="cuff", mat="iron")
    obj.scale = (1, 1, 1.6)
    return tag(obj, m)


def pose_hanging():
    """Hung by the wrists from two rings in the wall, head fallen forward,
    knees gone slack, feet a hand's breadth off the floor. The wall is y = 0."""
    y = -0.15
    J = mirror_joints({
        "spine": [(0, y + 0.02, 1.52), (0, y + 0.04, 1.43), (0, y + 0.05, 1.30), (0, y + 0.03, 1.15),
                  (0, y + 0.01, 1.04)],
        "chest": (0, -1, -0.1), "pelvis": (0, y, 0.98), "pelvis_fwd": (0, -1, 0.1), "pelvis_up": (0, 0.1, 1),
        "head": (0.02, y - 0.10, 1.53), "face": (0.15, -0.8, -0.75), "crown": (0.1, -0.5, 1),
        "sh_r": (0.17, y + 0.02, 1.53), "el_r": (0.25, y + 0.05, 1.79), "wr_r": (0.24, y + 0.10, 2.04),
        "hand_r": (0.02, 0.2, 1),
        "hip_r": (0.09, y - 0.01, 0.95), "kn_r": (0.10, y - 0.10, 0.53), "an_r": (0.10, y - 0.04, 0.14),
        "toe_r": (0.11, y - 0.12, 0.05),
        "curl": 0.55,
    })
    # The left leg hangs a little differently: nobody hangs symmetric.
    J["kn_l"] = (-0.12, y - 0.14, 0.55)
    J["an_l"] = (-0.09, y - 0.06, 0.15)
    J["toe_l"] = (-0.10, y - 0.14, 0.07)
    return J


def pose_seated():
    """Slumped at a table: on a 0.455 m seat, forearms on a top at 0.83 in
    front (-Y), the skull fallen forward between them. Origin under the hips."""
    J = mirror_joints({
        "spine": [(0, -0.20, 1.00), (0, -0.15, 0.93), (0, -0.09, 0.82), (0, -0.03, 0.69), (0, 0.01, 0.57)],
        "chest": (0, -1, -0.6), "pelvis": (0, 0.02, 0.53), "pelvis_fwd": (0, -1, 0.3), "pelvis_up": (0, 0.3, 1),
        "head": (0.03, -0.43, 0.94), "face": (0.2, -0.3, -1.0), "crown": (0.1, -1, 0.2),
        "sh_r": (0.18, -0.16, 0.97), "el_r": (0.25, -0.47, 0.86), "wr_r": (0.14, -0.66, 0.855),
        "hand_r": (-0.4, -1, 0),
        "hip_r": (0.09, 0.0, 0.50), "kn_r": (0.11, -0.40, 0.52), "an_r": (0.12, -0.44, 0.09),
        "toe_r": (0.13, -0.58, 0.03),
        "curl": 0.15,
    })
    J["el_l"] = (-0.27, -0.45, 0.855)
    J["wr_l"] = (-0.10, -0.64, 0.855)
    return J


def pose_lying():
    """On its back along X, the cage collapsed, one arm flung out."""
    J = {
        "spine": [(-0.62, 0.0, 0.075), (-0.52, 0.0, 0.085), (-0.38, 0.0, 0.085), (-0.22, 0.0, 0.08),
                  (-0.10, 0.0, 0.075)],
        "chest": (0, 0, 1), "pelvis": (-0.05, 0, 0.07), "pelvis_fwd": (0, 0, 1), "pelvis_up": (-1, 0, 0),
        "head": (-0.76, 0.03, 0.085), "face": (0.1, 0.55, 0.8), "crown": (-1, 0, 0), "flat": 0.55,
        "sh_r": (-0.56, 0.18, 0.06), "el_r": (-0.34, 0.27, 0.035), "wr_r": (-0.10, 0.25, 0.03),
        "hand_r": (1, 0.1, 0), "sh_l": (-0.56, -0.18, 0.06), "el_l": (-0.62, -0.47, 0.035),
        "wr_l": (-0.58, -0.72, 0.03), "hand_l": (0.2, -1, 0),
        "hip_r": (-0.02, 0.09, 0.06), "kn_r": (0.40, 0.13, 0.07), "an_r": (0.80, 0.15, 0.05),
        "toe_r": (0.86, 0.17, 0.15), "hip_l": (-0.02, -0.09, 0.06), "kn_l": (0.38, -0.20, 0.07),
        "an_l": (0.76, -0.30, 0.05), "toe_l": (0.80, -0.40, 0.12),
        "curl": 0.4,
    }
    return J


def build_skull():
    """One skull on its side, the jaw fallen off beside it."""
    reset(7301)
    p = skull((0, 0, 0.085), (0.3, -1, 0.15), (0.35, 0, 1), jaw_drop=0.0)
    return deliver(p, "clutter_skull")


def build_bones():
    """"Bones of all sorts": long bones, a few ribs, vertebrae, a skull or
    two, over a patch a metre and a half across -- flat enough to walk over."""
    reset(7302)
    p = []
    for i in range(9):
        a = rng.uniform(0, math.pi)
        c = (rng.uniform(-0.65, 0.65), rng.uniform(-0.45, 0.45))
        L = rng.uniform(0.28, 0.46)
        z = 0.022
        p += long_bone((c[0] - math.cos(a) * L / 2, c[1] - math.sin(a) * L / 2, z),
                       (c[0] + math.cos(a) * L / 2, c[1] + math.sin(a) * L / 2, z + rng.uniform(0.0, 0.03)),
                       rng.uniform(0.012, 0.017))
    for i in range(6):
        c = V((rng.uniform(-0.6, 0.6), rng.uniform(-0.4, 0.4), 0.0))
        a = rng.uniform(0, 6.28)
        pts = [c + V((math.cos(a + t * 1.6) * 0.14, math.sin(a + t * 1.6) * 0.14, 0.008 + 0.03 * math.sin(t * 3)))
               for t in (0, 0.25, 0.5, 0.75, 1.0)]
        p.append(tube(pts, 0.007, sides=4, name="rib"))
    for i in range(5):
        p.append(blob((rng.uniform(-0.6, 0.6), rng.uniform(-0.4, 0.4), 0.012), 0.02, seg=6, rings=3,
                      scale=(1, 1, 0.6), name="vert"))
    p += skull((0.32, 0.12, 0.08), (-0.6, -0.8, 0.1), (0.1, 0.1, 1), jaw_drop=0.02)
    p += skull((-0.4, -0.18, 0.07), (0.8, 0.3, 0.4), (-0.3, 0.2, 1), jaw_drop=0.0, s=0.95)
    return deliver(p, "clutter_bones")


def build_skeleton():
    reset(7303)
    return deliver(skeleton(pose_lying(), jaw=0.02), "clutter_skeleton")


def build_skeleton_seated():
    reset(7304)
    return deliver(skeleton(pose_seated(), jaw=0.025), "clutter_skeleton_seated")


def build_skeleton_hanging():
    """In chains: two rings in the wall above the head, a short run of chain
    from each to a cuff on the wrist."""
    reset(7305)
    J = pose_hanging()
    p = skeleton(J, jaw=0.035)
    for k, x in (("r", 0.30), ("l", -0.30)):
        p += wall_ring(x, 2.42)
        wr = V(J["wr_" + k])
        p.append(manacle(tuple(wr + V((0, 0, 0.01)))))
        p += chain((x, -0.035, 2.36), tuple(wr + V((0, 0, 0.05))))
    return deliver(p, "clutter_skeleton_hanging")


def build_shackles():
    """Empty irons on the wall: two cuffs on short chains at different
    heights, and a longer one run down to the floor with its cuff lying there."""
    reset(7306)
    p = []
    for x, z, drop in ((-0.42, 1.92, 0.5), (0.02, 2.05, 0.66)):
        p += wall_ring(x, z)
        end = V((x + 0.03, -0.05, z - drop))
        p += chain((x, -0.035, z - 0.06), tuple(end))
        p.append(manacle(tuple(end - V((0, 0, 0.05)))))
    p += wall_ring(0.52, 1.35)
    p += chain((0.52, -0.035, 1.29), (0.62, -0.32, 0.04), sag=0.06)
    p += chain((0.62, -0.32, 0.03), (0.86, -0.46, 0.03))
    cuff = manacle((0.92, -0.49, 0.03))
    cuff.rotation_euler = (math.pi / 2, 0, 0.4)
    p.append(cuff)
    return deliver(p, "clutter_shackles")


# --- locked things and gold ------------------------------------------------

def rivets(a, b, n, r=0.012, m="rust"):
    A, B = V(a), V(b)
    return [blob(A + (B - A) * (i / max(1, n - 1)), r, m, seg=5, rings=3, scale=(1, 1, 0.6), name="rivet",
                 smooth=0) for i in range(n)]


def build_strongbox():
    """"A big metal box, covered with dust ... once filled with coal." Iron
    plate with strap bands and rivets, ring handles, the lid up a hand's
    breadth on its hinges and the last of the coal inside."""
    reset(7311)
    W, D, H = 1.10, 0.70, 0.60
    p = []
    body = lib.box((W, D, H), (0, 0, H / 2), name="body", mat="iron")
    kit.bev(body, 0.012)
    p.append(tag(body, "iron"))
    # Strap bands round the body, and rivets down each.
    for x in (-0.36, 0.0, 0.36):
        for (sx, sy, cx, cy) in ((0.07, D + 0.016, x, 0), ):
            band = lib.box((sx, sy, H - 0.02), (cx, cy, H / 2), name="band", mat="iron")
            p.append(tag(band, "rust"))
        p += rivets((x, -D / 2 - 0.009, 0.07), (x, -D / 2 - 0.009, H - 0.07), 4)
    base = lib.box((W + 0.04, D + 0.04, 0.05), (0, 0, 0.025), name="foot", mat="iron")
    p.append(tag(base, "rust"))
    # Coal to just under the rim.
    for i in range(22):
        c = (rng.uniform(-W / 2 + 0.1, W / 2 - 0.1), rng.uniform(-D / 2 + 0.1, D / 2 - 0.1), H - 0.07 + rng.uniform(-0.03, 0.02))
        p.append(blob(c, rng.uniform(0.045, 0.075), "soot", seg=5, rings=3,
                      scale=(1, rng.uniform(0.7, 1.1), 0.7), name="coal", smooth=0))
    # The lid, hinged along the back and up about eighteen degrees.
    lid = [lib.box((W + 0.03, D + 0.03, 0.06), (0, -D / 2, 0.03), name="lid", mat="iron")]
    kit.bev(lid[0], 0.01)
    tag(lid[0], "iron")
    for x in (-0.36, 0.0, 0.36):
        lid.append(tag(lib.box((0.07, D + 0.05, 0.075), (x, -D / 2, 0.035), name="lband", mat="iron"), "rust"))
    hasp = lib.box((0.09, 0.02, 0.14), (0, -D - 0.02, -0.04), name="hasp", mat="iron")
    lid.append(tag(hasp, "rust"))
    kit.place(lid, (0, D / 2, H), (-math.radians(18), 0, 0))
    p += lid
    for sx in (-1, 1):
        ring = lib.torus(0.07, 0.012, (sx * (W / 2 + 0.03), 0, H * 0.62), (0, math.pi / 2, 0), major_seg=10,
                         minor_seg=4, name="handle", mat="iron")
        p.append(tag(ring, "rust"))
        p.append(tag(lib.box((0.02, 0.1, 0.06), (sx * (W / 2 + 0.01), 0, H * 0.7), name="staple", mat="iron"), "rust"))
    staple = lib.box((0.06, 0.03, 0.08), (0, -D / 2 - 0.015, H - 0.12), name="lockplate", mat="iron")
    p.append(tag(staple, "rust"))
    return deliver(p, "clutter_strongbox")


def chest_parts(W=0.92, D=0.52, H=0.42, lid_open=0.0):
    """A carpenter's chest: boarded sides, a rounded lid, iron bands over
    both, a lock plate. `lid_open` swings the lid back by that many radians."""
    p = []
    body = lib.box((W, D, H), (0, 0, H / 2), name="chest", mat="wood")
    kit.bev(body, 0.01)
    p.append(tag(body, "wood"))
    # Board joints: shallow battens that break the sides into planks.
    for z in (H * 0.34, H * 0.68):
        p.append(tag(lib.box((W + 0.006, D + 0.006, 0.012), (0, 0, z), name="seam", mat="wood"), "oak"))
    # The lid: a half-barrel along X.
    secs = []
    for k in range(7):
        a = math.pi * k / 6
        secs.append((math.cos(a) * D / 2, math.sin(a) * 0.14))
    lid_pts = [(y, z) for (y, z) in secs] + [(-D / 2, 0.0)]
    lid = F.prism([(y, z) for (y, z) in secs], -W / 2 - 0.01, W / 2 + 0.01, m="wood", name="lid", axis="x")
    lids = [lid]
    for x in (-W * 0.36, 0.0, W * 0.36):
        band = tube([(x, math.cos(math.pi * k / 8) * (D / 2 + 0.008), math.sin(math.pi * k / 8) * (0.14 + 0.008))
                     for k in range(9)], 0.012, sides=4, m="rust", caps=False, name="lband", smooth=0)
        lids.append(band)
    if lid_open:
        kit.place(lids, (0, D / 2, 0), (0, 0, 0))
        for o in lids:
            o.location.y -= D / 2
        kit.place(lids, (0, 0, H), (-lid_open, 0, 0))
    else:
        kit.place(lids, (0, 0, H))
    p += lids
    for x in (-W * 0.36, 0.0, W * 0.36):
        for side in (-1, 1):
            p.append(tag(lib.box((0.05, 0.012, H), (x, side * (D / 2 + 0.006), H / 2), name="band", mat="iron"), "rust"))
    p.append(tag(lib.box((0.1, 0.02, 0.12), (0, -D / 2 - 0.012, H - 0.06), name="lock", mat="iron"), "iron"))
    for sx in (-1, 1):
        p.append(tag(lib.torus(0.05, 0.01, (sx * (W / 2 + 0.02), 0, H * 0.7), (0, math.pi / 2, 0),
                               major_seg=8, minor_seg=4, name="grip", mat="iron"), "rust"))
    return p


def build_chest():
    """An iron-bound chest, shut, set against a wall (its back at y = 0)."""
    reset(7312)
    p = chest_parts()
    kit.place(p, (0, -0.30, 0))
    return deliver(p, "clutter_chest")


def coin(c, tilt, turn, r=0.019):
    o = lib.cylinder(r, 0.004, (0, 0, 0), verts=8, name="coin", mat="iron")
    o.rotation_euler = (tilt, 0, turn)
    o.location = c
    return tag(o, "gold")


def build_hoard():
    """"Treasure haphazardly strewn about": a drift of coin against the
    wall, an open chest spilling more, cups, a crown, stones. Back at y = 0."""
    reset(7313)
    p = []
    rings = []
    for (z, rx, ry) in ((0.0, 1.05, 0.72), (0.08, 0.92, 0.64), (0.18, 0.68, 0.48), (0.28, 0.40, 0.30),
                        (0.34, 0.16, 0.13), (0.36, 0.02, 0.02)):
        rings.append((z, rx, ry))
    verts, faces = [], []
    sides = 14
    for (z, rx, ry) in rings:
        for k in range(sides):
            a = 2 * math.pi * k / sides
            w = 1 + rng.uniform(-0.08, 0.08) if z > 0 else 1
            verts.append((math.cos(a) * rx * w, -0.8 + math.sin(a) * ry * w, z + (rng.uniform(-0.02, 0.02) if 0 < z < 0.3 else 0)))
    for i in range(len(rings) - 1):
        for k in range(sides):
            j = (k + 1) % sides
            faces.append((i * sides + k, i * sides + j, (i + 1) * sides + j, (i + 1) * sides + k))
    faces.append(tuple(range((len(rings) - 1) * sides, len(rings) * sides)))
    me = bpy.data.meshes.new("heap")
    me.from_pydata(verts, [], faces)
    me.update()
    heap = bpy.data.objects.new("heap", me)
    bpy.context.collection.objects.link(heap)
    lib.shade_smooth(heap, angle=60)
    p.append(tag(heap, "gold"))
    # Coins lying on the drift and spilled round its foot.
    for i in range(46):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0.2, 1.25)
        x, y = math.cos(a) * d * 1.05, -0.8 + math.sin(a) * d * 0.72
        if y > -0.02:
            continue
        zc = max(0.003, 0.36 * (1 - min(1, d / 1.05)) ** 1.1)
        p.append(coin((x, y, zc + 0.004), rng.uniform(-0.5, 0.5), rng.uniform(0, 6.28)))
    # A small chest, lid thrown back, full.
    box = chest_parts(0.56, 0.36, 0.28, lid_open=1.9)
    for o in box:
        o.location.x += 0.95
        o.location.y -= 0.36
    kit.place(box, (0, 0, 0))
    kit.rotate_z(box, 0.0)
    p += box
    fill = blob((0.95, -0.36, 0.28), 0.25, "gold", seg=8, rings=4, scale=(1.0, 0.62, 0.22), name="fill")
    p.append(fill)
    # Two cups and a crown.
    for (x, y, z, tilt) in ((-0.55, -0.55, 0.1, 0.0), (0.35, -1.25, 0.0, 1.3)):
        cup = F.lathe([(0, 0.045), (0.012, 0.045), (0.02, 0.012), (0.1, 0.01), (0.11, 0.035), (0.17, 0.05),
                       (0.2, 0.052)], 0, 0, 0, sides=10, m="gold", name="cup")
        cup.rotation_euler = (tilt, 0, rng.uniform(0, 6.28))
        cup.location = (x, y, z)
        p.append(cup)
    crown = [lib.torus(0.085, 0.012, (0, 0, 0.03), (0, 0, 0), major_seg=12, minor_seg=4, name="crown", mat="iron")]
    tag(crown[0], "gold")
    for k in range(6):
        a = 2 * math.pi * k / 6
        crown.append(tag(lib.cone(0.018, 0.0, 0.07, (math.cos(a) * 0.085, math.sin(a) * 0.085, 0.07), verts=4,
                                  name="point", mat="iron"), "gold"))
    kit.place(crown, (-0.2, -0.95, 0.22), (0.35, 0.2, 0.5))
    p += crown
    # Stones, in the colours a stone is.
    for (c, col) in (((-0.3, -1.3, 0.02), (0.75, 0.05, 0.08)), ((0.6, -0.9, 0.06), (0.05, 0.5, 0.18)),
                     ((0.1, -0.6, 0.3), (0.1, 0.2, 0.8)), ((-0.7, -1.0, 0.03), (0.6, 0.1, 0.6))):
        g = blob(c, 0.03, "phial", seg=4, rings=2, scale=(1, 1, 0.8), name="gem", smooth=0)
        paint(g, col)
        p.append(g)
    return deliver(p, "clutter_hoard", colours=True)


# --- the dead in their tombs ------------------------------------------------

def build_sarcophagus():
    """A chest tomb on a plinth, its sides panelled, an effigy lying on the
    lid -- and the lid shoved a hand's breadth askew, because the tomb's
    occupant is up and walking about the room (the rotting zombie)."""
    reset(7321)
    p = []
    m = "flagstone"
    plinth = lib.box((2.5, 1.3, 0.18), (0, 0, 0.09), name="plinth", mat="stonewall")
    kit.bev(plinth, 0.03)
    p.append(tag(plinth, m))
    body = lib.box((2.2, 1.0, 0.68), (0, 0, 0.18 + 0.34), name="body", mat="stonewall")
    kit.bev(body, 0.02)
    p.append(tag(body, m))
    # Panels: raised frames on every face, three to a long side.
    for side in (-1, 1):
        y = side * 0.5
        for z in (0.26, 0.78):
            p.append(tag(lib.box((2.2, 0.04, 0.05), (0, y + side * 0.012, z), name="rail", mat="stonewall"), m))
        for x in (-1.1, -0.37, 0.37, 1.1):
            p.append(tag(lib.box((0.06, 0.04, 0.52), (x * 0.985, y + side * 0.012, 0.52), name="stile", mat="stonewall"), m))
        # A carved roundel in each panel.
        for x in (-0.73, 0.0, 0.73):
            ro = lib.torus(0.13, 0.018, (x, y + side * 0.015, 0.52), (math.pi / 2, 0, 0), major_seg=12, minor_seg=4,
                           name="roundel", mat="stonewall")
            p.append(tag(ro, m))
    for side in (-1, 1):
        x = side * 1.1
        for z in (0.26, 0.78):
            p.append(tag(lib.box((0.04, 1.0, 0.05), (x + side * 0.012, 0, z), name="rail", mat="stonewall"), m))
    cornice = lib.box((2.3, 1.1, 0.07), (0, 0, 0.86 + 0.035), name="cornice", mat="stonewall")
    kit.bev(cornice, 0.02)
    p.append(tag(cornice, m))
    # The lid and the effigy on it, pushed askew.
    lid = []
    top = lib.box((2.34, 1.12, 0.14), (0, 0, 0.07), name="lid", mat="stonewall")
    kit.bev(top, 0.03)
    lid.append(tag(top, m))
    cushion = lib.box((0.34, 0.5, 0.1), (-0.86, 0, 0.19), name="cushion", mat="stonewall")
    kit.bev(cushion, 0.03)
    lid.append(tag(cushion, m))
    lid.append(blob((-0.82, 0, 0.33), 0.1, m, seg=8, rings=5, scale=(1.05, 0.9, 1.0), name="head"))
    body_loft = lib.loft([(-0.66, 0.1, 0.2, 0.2, 0.0), (-0.5, 0.12, 0.22, 0.22, 0.0), (-0.1, 0.1, 0.2, 0.21, 0.0),
                          (0.35, 0.08, 0.17, 0.19, 0.0), (0.72, 0.06, 0.12, 0.17, 0.0), (0.84, 0.05, 0.1, 0.17, 0.0)],
                         sides=8, axis="x", name="effigy", mat="stonewall")
    lib.shade_smooth(body_loft, angle=60)
    lid.append(tag(body_loft, m))
    lid.append(blob((-0.3, 0, 0.31), 0.06, m, seg=6, rings=4, scale=(1.3, 1.1, 0.7), name="hands"))
    for sy in (-1, 1):
        lid.append(blob((0.9, sy * 0.06, 0.24), 0.05, m, seg=6, rings=4, scale=(0.8, 0.8, 1.4), name="foot"))
        lid.append(tube([(-0.62, sy * 0.19, 0.24), (-0.45, sy * 0.2, 0.27), (-0.32, sy * 0.1, 0.31)], 0.035,
                        sides=6, m=m, name="arm"))
    kit.place(lid, (0.16, -0.12, 0.93), (0, 0, 0.07))
    p += lid
    return deliver(p, "clutter_sarcophagus")


# --- the laboratory ---------------------------------------------------------

def flask(x, y, z, r=0.07, neck=0.12, col=(0.3, 0.7, 0.3), fill=0.55):
    """A round-bottomed flask on a cork ring, the liquid showing through."""
    ring = tag(lib.torus(r * 0.55, 0.012, (x, y, z + 0.012), (0, 0, 0), major_seg=8, minor_seg=3,
                         name="cork", mat="wood"), "leather")
    bulb = F.lathe([(0, 0.001), (r * 0.25, r * 0.66), (r * 0.8, r), (r * 1.4, r * 0.9), (r * 1.85, r * 0.45),
                    (r * 1.95, 0.02), (r * 1.95 + neck, 0.018), (r * 1.95 + neck + 0.01, 0.024)],
                   x, y, z + 0.01, sides=10, m="phial", name="flask")
    base = (0.72, 0.8, 0.74)

    def colour(q, zc=z, h=r * 1.95 * fill):
        return col if q.z - zc < h else base
    paint(bulb, colour)
    return [ring, bulb]


def build_alchemy():
    """"Huge oaken tables, most of these cluttered with strange-looking pipes
    and flasks." A heavy table and, on it, an alembic over its burner with a
    glass pipe to a receiver, flasks, a retort, a rack of tubes, a mortar,
    an open book, a candle and a skull. Free-standing, long along X."""
    reset(7331)
    p = []
    W, D, H = 2.1, 0.95, 0.86
    top = F.worn((W, D, 0.07), (0, 0, H - 0.035))
    p.append(top)
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(F.lathe([(0, 0.05), (0.06, 0.05), (0.08, 0.035), (0.35, 0.04), (0.45, 0.055), (0.55, 0.04),
                              (H - 0.12, 0.042), (H - 0.07, 0.05)], sx * (W / 2 - 0.12), sy * (D / 2 - 0.1), 0,
                             sides=8, m="wood", name="leg"))
        p.append(F.beam((0.06, D - 0.2, 0.08), (sx * (W / 2 - 0.12), 0, 0.2), m="wood"))
    p.append(F.beam((W - 0.24, 0.06, 0.08), (0, 0, 0.2), m="wood"))
    for sy in (-1, 1):
        p.append(F.beam((W - 0.2, 0.04, 0.1), (0, sy * (D / 2 - 0.06), H - 0.12), m="wood"))
    T = H
    # The alembic: a burner, the cucurbit on it, the head, the beak.
    bx, by = -0.62, 0.12
    for k in range(3):
        a = 2 * math.pi * k / 3
        p.append(F.rod((bx + math.cos(a) * 0.1, by + math.sin(a) * 0.1, T), (bx + math.cos(a) * 0.08, by + math.sin(a) * 0.08, T + 0.16),
                       0.008, m="rust", verts=4))
    p.append(tag(lib.torus(0.095, 0.01, (bx, by, T + 0.16), (0, 0, 0), major_seg=10, minor_seg=3, name="trivet",
                           mat="iron"), "rust"))
    p.append(F.lathe([(0, 0.05), (0.04, 0.055), (0.06, 0.03)], bx, by, T, sides=8, m="brass", name="lamp"))
    cuc = F.lathe([(0, 0.04), (0.05, 0.11), (0.14, 0.12), (0.22, 0.08), (0.28, 0.05)], bx, by, T + 0.15,
                  sides=10, m="earthenware", name="cucurbit")
    p.append(cuc)
    head = F.lathe([(0, 0.05), (0.06, 0.09), (0.13, 0.08), (0.18, 0.03), (0.2, 0.001)], bx, by, T + 0.43,
                   sides=10, m="bottle", name="head")
    p.append(head)
    beak = [(bx + 0.08, by, T + 0.5), (bx + 0.3, by - 0.05, T + 0.45), (bx + 0.55, by - 0.1, T + 0.34),
            (bx + 0.78, by - 0.14, T + 0.24)]
    p.append(tube(beak, 0.012, sides=5, m="bottle", name="beak"))
    p += flask(bx + 0.86, by - 0.16, T, r=0.075, neck=0.08, col=(0.55, 0.28, 0.08), fill=0.4)
    # Flasks along the front.
    for (x, y, r, col) in ((-0.1, -0.22, 0.07, (0.18, 0.62, 0.22)), (0.1, -0.12, 0.055, (0.5, 0.12, 0.55)),
                           (0.62, -0.25, 0.06, (0.75, 0.55, 0.1))):
        p += flask(x, y, T, r=r, neck=0.1, col=col, fill=rng.uniform(0.35, 0.7))
    # A retort lying on its stand.
    ret = F.lathe([(0, 0.001), (0.03, 0.06), (0.09, 0.075), (0.15, 0.06), (0.18, 0.03)], 0, 0, 0, sides=10,
                  m="phial", name="retort")
    paint(ret, lambda q: (0.25, 0.4, 0.75) if q.z < 0.07 else (0.72, 0.8, 0.74))
    ret.rotation_euler = (0, math.radians(80), 0.3)
    ret.location = (0.3, 0.22, T + 0.08)
    p.append(ret)
    p.append(tube([(0.47, 0.27, T + 0.09), (0.62, 0.3, T + 0.1), (0.78, 0.33, T + 0.05)], 0.011, sides=5,
                  m="bottle", name="neck"))
    # A glass coil from the retort's stand down to a jar.
    coil = []
    for k in range(25):
        a = k * 0.7
        coil.append((0.9 + math.cos(a) * 0.05, 0.25 + math.sin(a) * 0.05, T + 0.34 - k * 0.011))
    p.append(tube(coil, 0.008, sides=4, m="bottle", caps=True, name="coil"))
    p += F.crock(0.9, 0.25, T, h=0.07, r=0.07, lid=False)
    # A rack of tubes.
    p.append(F.beam((0.3, 0.07, 0.02), (0.35, -0.3, T + 0.1), m="wood"))
    for sx in (-1, 1):
        p.append(F.beam((0.02, 0.07, 0.1), (0.35 + sx * 0.14, -0.3, T + 0.05), m="wood"))
    for k, col in enumerate(((0.8, 0.2, 0.1), (0.2, 0.7, 0.3), (0.9, 0.8, 0.2), (0.3, 0.3, 0.8))):
        t = lib.cylinder(0.013, 0.15, (0.26 + k * 0.06, -0.3, T + 0.1), verts=6, name="tube", mat="wood")
        tag(t, "phial")
        paint(t, lambda q, c=col: c if q.z < T + 0.08 else (0.72, 0.8, 0.74))
        p.append(t)
    # Mortar and pestle, a book open, a candle, a skull.
    p.append(F.lathe([(0, 0.06), (0.02, 0.07), (0.07, 0.08), (0.09, 0.075)], -0.25, 0.28, T, sides=9,
                     m="earthenware", name="mortar"))
    p.append(F.rod((-0.25, 0.28, T + 0.05), (-0.2, 0.33, T + 0.2), 0.012, m="wood", verts=5))
    for side in (-1, 1):
        pg = F.book(-0.28 + side * 0.1, -0.2, T, h=0.2, w=0.26, t=0.025, flat=True, turn=0.15)
        p += pg
    p += F.candle(-0.95, -0.3, T)
    p += skull((0.82, -0.22, T + 0.085), (-0.5, -1, 0), (0, 0, 1))
    return deliver(p, "clutter_alchemy", colours=True)


def flat_strip(a, b, w, z=0.003):
    """A flat quad from a to b on the floor, `w` wide: a chalk line."""
    A, B = V((a[0], a[1], 0)), V((b[0], b[1], 0))
    d = (B - A)
    n = V((-d.y, d.x, 0)).normalized() * (w / 2)
    return [tuple(A - n + V((0, 0, z))), tuple(B - n + V((0, 0, z))), tuple(B + n + V((0, 0, z))),
            tuple(A + n + V((0, 0, z)))]


def quads(name, quads_list, m):
    verts, faces = [], []
    for q in quads_list:
        base = len(verts)
        verts += q
        faces.append((base, base + 1, base + 2, base + 3))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    # Faces up: every quad was wound so, but make sure.
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.normal_update()
        if f.normal.z < 0 and abs(f.normal.z) > 0.5:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    return tag(obj, m)


def build_pentagram():
    """"The floor is covered with half-erased pentagrams and even weirder
    symbols." A double circle two metres across, the star, sigils between
    the rings -- in chalk, scuffed through in runs. Flat quads 3 mm up."""
    reset(7332)
    Q = []
    R0, R1 = 1.0, 0.88
    worn = set()
    k = 0
    while k < 48:
        if rng.random() < 0.12:
            run = rng.randint(2, 5)
            worn.update(range(k, k + run))
            k += run
        k += 1

    def circle(r, w, n=48, skip=()):
        for i in range(n):
            if i in skip:
                continue
            a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
            Q.append(flat_strip((math.cos(a0) * r, math.sin(a0) * r), (math.cos(a1) * r, math.sin(a1) * r), w))
    circle(R0, 0.045, skip=worn)
    circle(R1, 0.03, skip={(i + 7) % 48 for i in worn})
    pts = [(math.cos(math.pi / 2 + 2 * math.pi * i / 5) * R1, math.sin(math.pi / 2 + 2 * math.pi * i / 5) * R1)
           for i in range(5)]
    for i in range(5):
        a, b = V(pts[i]), V(pts[(i + 2) % 5])
        # Each stroke of the star in three pieces, one of them sometimes gone.
        gone = rng.randint(0, 5)
        for s in range(3):
            if s == gone:
                continue
            Q.append(flat_strip(tuple(a + (b - a) * (s / 3)), tuple(a + (b - a) * ((s + 1) / 3)), 0.04))
    # Sigils in the band between the circles: two or three strokes each.
    for i in range(10):
        a = 2 * math.pi * (i + 0.5) / 10
        c = V((math.cos(a) * 0.94, math.sin(a) * 0.94))
        t = V((-math.sin(a), math.cos(a)))
        n = V((math.cos(a), math.sin(a)))
        for s in range(rng.randint(2, 3)):
            u0 = rng.uniform(-0.035, 0.035)
            v0 = rng.uniform(-0.03, 0.03)
            d = (t * rng.uniform(-1, 1) + n * rng.uniform(-1, 1)).normalized() * 0.045
            p0 = c + t * u0 + n * v0
            Q.append(flat_strip(tuple(p0), tuple(p0 + d), 0.012))
    # A second, smaller circle half rubbed out, off to one side.
    for i in range(20):
        if i % 7 in (3, 4):
            continue
        a0, a1 = 2 * math.pi * i / 20, 2 * math.pi * (i + 1) / 20
        c = V((1.35, 0.55))
        Q.append(flat_strip(tuple(c + V((math.cos(a0), math.sin(a0))) * 0.32),
                            tuple(c + V((math.cos(a1), math.sin(a1))) * 0.32), 0.025))
    return deliver([quads("chalk", Q, "chalk")], "clutter_pentagram")


def build_blackboard():
    """"A blackboard in a dark corner has only been partially cleaned, some
    painful-looking letters faintly visible." Slate in an oak frame on the
    wall, lines of chalk down one side, a figure half wiped, the ledge with
    its chalk and a rag. Back at y = 0."""
    reset(7333)
    p = []
    W, H, z0 = 1.6, 1.05, 0.95
    board = lib.box((W, 0.025, H), (0, -0.02, z0 + H / 2), name="slate", mat="stonewall")
    p.append(tag(board, "slate"))
    for (w, h, x, z) in ((W + 0.1, 0.06, 0, z0 - 0.02), (W + 0.1, 0.06, 0, z0 + H + 0.02),
                         (0.06, H + 0.1, -W / 2 - 0.02, z0 + H / 2), (0.06, H + 0.1, W / 2 + 0.02, z0 + H / 2)):
        p.append(F.beam((w, 0.045, h), (x, -0.035, z), m="wood"))
    ledge = F.beam((W + 0.1, 0.1, 0.03), (0, -0.08, z0 - 0.05), m="wood")
    p.append(ledge)
    p.append(tag(lib.box((0.07, 0.014, 0.014), (-0.3, -0.08, z0 - 0.028), name="chalk", mat="wood"), "chalk"))
    p.append(tag(lib.box((0.04, 0.013, 0.013), (-0.18, -0.07, z0 - 0.028), name="chalk", mat="wood"), "chalk"))
    rag = blob((0.45, -0.09, z0 - 0.02), 0.07, "cloth", seg=6, rings=3, scale=(1.3, 0.8, 0.35), name="rag")
    p.append(rag)
    # Chalk: flat quads in the plane y = -0.034, written as strokes.
    Q = []
    yz = -0.036

    def stroke(a, b, w=0.009):
        A, B = V((a[0], a[1])), V((b[0], b[1]))
        d = B - A
        n = V((-d.y, d.x)).normalized() * (w / 2)
        Q.append([(A.x - n.x, yz, A.y - n.y), (A.x + n.x, yz, A.y + n.y), (B.x + n.x, yz, B.y + n.y),
                  (B.x - n.x, yz, B.y - n.y)])
    # Lines of "letters" down the left: jittered zigzags, some rubbed short.
    for row in range(7):
        z = z0 + H - 0.12 - row * 0.12
        x = -W / 2 + 0.1
        end = -0.05 + rng.uniform(-0.2, 0.15)
        while x < end:
            w = rng.uniform(0.03, 0.06)
            hgt = rng.uniform(0.04, 0.06)
            kind = rng.randint(0, 3)
            if kind == 0:
                stroke((x, z), (x + w * 0.5, z + hgt))
                stroke((x + w * 0.5, z + hgt), (x + w, z))
            elif kind == 1:
                stroke((x, z), (x, z + hgt))
                stroke((x, z + hgt * 0.5), (x + w, z + hgt * 0.5))
            elif kind == 2:
                stroke((x, z + hgt), (x + w, z))
            else:
                stroke((x, z), (x + w, z + hgt * 0.3))
                stroke((x + w, z + hgt * 0.3), (x + w * 0.2, z + hgt))
            x += w + rng.uniform(0.012, 0.03)
            if rng.random() < 0.15:
                x += 0.05
    # A circle with a star in it, half wiped, on the right.
    c = V((0.42, z0 + H * 0.55))
    for i in range(24):
        if 6 <= i <= 10:
            continue
        a0, a1 = 2 * math.pi * i / 24, 2 * math.pi * (i + 1) / 24
        stroke(tuple(c + V((math.cos(a0), math.sin(a0))) * 0.26), tuple(c + V((math.cos(a1), math.sin(a1))) * 0.26), 0.011)
    pts = [c + V((math.cos(math.pi / 2 + 2 * math.pi * i / 5), math.sin(math.pi / 2 + 2 * math.pi * i / 5))) * 0.24
           for i in range(5)]
    for i in range(5):
        if i == 3:
            continue
        stroke(tuple(pts[i]), tuple(pts[(i + 2) % 5]), 0.01)
    verts, faces = [], []
    for q in Q:
        base = len(verts)
        verts += q
        faces.append((base, base + 1, base + 2, base + 3))
    me = bpy.data.meshes.new("writing")
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new("writing", me)
    bpy.context.collection.objects.link(obj)
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.normal_update()
        if f.normal.y > 0:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    p.append(tag(obj, "chalk"))
    return deliver(p, "clutter_blackboard")


# --- on the walls -----------------------------------------------------------

def build_plaque():
    """"A small plaque is on this wall." Cast bronze with a raised rim, lines
    of raised letters and four rivets, its middle at 1.5 m. Back at y = 0."""
    reset(7341)
    p = []
    W, H, zc = 0.56, 0.38, 1.5
    plate = lib.box((W, 0.02, H), (0, -0.01, zc), name="plate", mat="iron")
    kit.bev(plate, 0.006)
    p.append(tag(plate, "brass"))
    for (w, h, x, z) in ((W - 0.04, 0.02, 0, zc + H / 2 - 0.035), (W - 0.04, 0.02, 0, zc - H / 2 + 0.035),
                         (0.02, H - 0.05, -W / 2 + 0.035, zc), (0.02, H - 0.05, W / 2 - 0.035, zc)):
        p.append(tag(lib.box((w, 0.012, h), (x, -0.024, z), name="rim", mat="iron"), "brass"))
    for row in range(5):
        z = zc + 0.1 - row * 0.05
        x = -W / 2 + 0.07
        while x < W / 2 - 0.08:
            w = rng.uniform(0.02, 0.07)
            if row == 0:
                w *= 1.3
            p.append(tag(lib.box((min(w, W / 2 - 0.08 - x), 0.006, 0.022 if row else 0.03), (x + w / 2, -0.022, z),
                                 name="word", mat="iron"), "brass"))
            x += w + 0.016
    for sx in (-1, 1):
        for sz in (-1, 1):
            p.append(blob((sx * (W / 2 - 0.02), -0.022, zc + sz * (H / 2 - 0.02)), 0.009, "brass", seg=5, rings=3,
                          scale=(1, 0.6, 1), name="rivet", smooth=0))
    return deliver(p, "clutter_plaque")


def build_sign():
    """"A small sign is hanging on the wall." A painted board on a cord from
    a nail, its foot swung a little out from the wall. Back at y = 0."""
    reset(7342)
    p = []
    W, H, zc = 0.78, 0.44, 1.62
    board = [F.worn((W, 0.03, H), (0, 0, 0), m="wood", wear=0.01)]
    # Painted letters: two lines, and a device.
    Q = []
    for row, (z, size) in enumerate(((0.08, 0.07), (-0.07, 0.05))):
        x = -W / 2 + 0.08
        while x < W / 2 - 0.1:
            w = rng.uniform(0.03, 0.06) * (1.2 if row == 0 else 1.0)
            Q.append(lib.box((w, 0.004, size), (x + w / 2, -0.017, z), name="letter", mat="iron"))
            x += w + 0.018
    for q in Q:
        tag(q, "soot")
    board += Q
    board.append(tag(lib.box((W - 0.04, 0.004, 0.012), (0, -0.017, -0.16), name="rule", mat="iron"), "soot"))
    for sx in (-1, 1):
        board.append(tag(lib.torus(0.012, 0.003, (sx * (W / 2 - 0.06), 0, H / 2 + 0.01), (math.pi / 2, 0, 0),
                                   major_seg=6, minor_seg=3, name="eye", mat="iron"), "iron"))
    kit.place(board, (0, -0.05, zc), (math.radians(-7), 0, 0))
    p += board
    nail = (0, -0.01, zc + H / 2 + 0.2)
    p.append(tag(lib.cylinder(0.008, 0.03, nail, (math.pi / 2, 0, 0), verts=5, name="nail", mat="iron"), "iron"))
    for sx in (-1, 1):
        p.append(tube([nail, (sx * (W / 2 - 0.06), -0.035, zc + H / 2 + 0.02)], 0.004, sides=3, m="rope", name="cord",
                      smooth=0))
    return deliver(p, "clutter_sign")



# --- pictures and hangings ----------------------------------------------------

def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def smooth(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def grain(u, v, k=1.0):
    """A little brushwork: cheap value noise so no field is flat."""
    return (math.sin(u * 91.7 * k + v * 13.1) * math.sin(v * 77.3 * k - u * 5.3) * 0.5 +
            math.sin(u * 23.3 + v * 41.9) * 0.5) * 0.5


def grid(W, H, nx, nz, colour, y=0.0, z0=0.0, bend=None, m="canvas", name="canvas"):
    """A W x H sheet in the XZ plane facing -Y, nx by nz quads, each vertex
    painted colour(u, v) with v running up. `bend(u, v)` pushes it off the
    plane -- the folds of a hanging."""
    verts, faces, cols = [], [], []
    for j in range(nz + 1):
        for i in range(nx + 1):
            u, v = i / nx, j / nz
            dy = bend(u, v) if bend else 0.0
            verts.append(((u - 0.5) * W, y + dy, z0 + v * H))
            cols.append(colour(u, v))
    for j in range(nz):
        for i in range(nx):
            a = j * (nx + 1) + i
            faces.append((a, a + nx + 1, a + nx + 2, a + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    for f in bm.faces:
        f.normal_update()
    if sum(f.normal.y for f in bm.faces) > 0:
        for f in bm.faces:
            f.normal_flip()
    bm.to_mesh(me)
    bm.free()
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for i, c in enumerate(cols):
        attr.data[i].color = (max(0.02, c[0]), max(0.02, c[1]), max(0.02, c[2]), 1.0)
    me.color_attributes.active_color = attr
    if bend:
        lib.shade_smooth(obj, angle=80)
    return tag(obj, m)


def frame(W, H, zc, depth=0.05, bar=0.075, m="gold"):
    """A moulded frame: four chamfered bars mitred by overlap, and a sight
    edge inside them."""
    parts = []
    for (w, h, x, z) in ((W + bar * 2, bar, 0, zc + H / 2 + bar / 2), (W + bar * 2, bar, 0, zc - H / 2 - bar / 2),
                         (bar, H, -W / 2 - bar / 2, zc), (bar, H, W / 2 + bar / 2, zc)):
        o = kit.timber((w, depth, h), (x, -depth / 2, z), mat="oak", cham=0.02, name="frame")
        parts.append(tag(o, m))
    for (w, h, x, z) in ((W + 0.02, 0.018, 0, zc + H / 2 + 0.004), (W + 0.02, 0.018, 0, zc - H / 2 - 0.004),
                         (0.018, H, -W / 2 - 0.004, zc), (0.018, H, W / 2 + 0.004, zc)):
        parts.append(tag(lib.box((w, 0.02, h), (x, -depth - 0.004, z), name="sight", mat="iron"), m))
    return parts


def portrait(u, v):
    bg = mix((0.07, 0.055, 0.04), (0.2, 0.14, 0.08), v * 0.8 + 0.2 * (1 - abs(u - 0.4) * 2))
    c = bg
    # Shoulders and a dark doublet, a white collar, a face with light from the left.
    sh = 0.42 - abs(u - 0.5) * 0.55
    if v < sh:
        c = mix((0.16, 0.05, 0.05), (0.06, 0.03, 0.03), (u - 0.2) * 1.4)
        c = mix(c, (0.5, 0.36, 0.14), smooth(0.02, 0.0, abs(u - 0.5) - 0.012) * smooth(0.05, 0.3, v))
    cd = ((u - 0.5) / 0.13) ** 2 + ((v - 0.45) / 0.035) ** 2
    if cd < 1 and v < 0.5:
        c = (0.78, 0.76, 0.7)
    fd = ((u - 0.5) / 0.12) ** 2 + ((v - 0.62) / 0.16) ** 2
    if fd < 1:
        c = mix((0.8, 0.6, 0.46), (0.42, 0.28, 0.2), (u - 0.38) * 3.0)
        if abs(v - 0.65) < 0.012 and abs(abs(u - 0.5) - 0.045) < 0.02:
            c = (0.15, 0.1, 0.07)
    hd = ((u - 0.5) / 0.14) ** 2 + ((v - 0.72) / 0.12) ** 2
    if hd < 1 and (v > 0.72 or fd >= 1):
        c = (0.12, 0.08, 0.05)
    k = grain(u, v) * 0.05
    c = tuple(x * (1 - 0.35 * ((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2) + k for x in c)
    return c


def landscape(u, v):
    sky = mix((0.86, 0.78, 0.55), (0.34, 0.42, 0.55), smooth(0.45, 1.0, v))
    c = sky
    cl = math.sin(u * 7.0 + 1.3) * math.sin(u * 3.1) * 0.5 + 0.5
    if v > 0.7 and abs(v - (0.8 + 0.05 * math.sin(u * 5))) < 0.05 * cl:
        c = mix(c, (0.9, 0.88, 0.82), 0.6)
    far = 0.5 + 0.08 * math.sin(u * 6.0 + 0.5) + 0.04 * math.sin(u * 17.0)
    if v < far:
        c = mix((0.36, 0.42, 0.46), (0.46, 0.5, 0.52), (v - 0.4) * 5)
    mid = 0.38 + 0.1 * math.sin(u * 3.2 + 2.0)
    if v < mid:
        c = mix((0.2, 0.28, 0.12), (0.34, 0.4, 0.18), (v / mid))
    # A keep on the far hill.
    if 0.66 < u < 0.72 and v < far + 0.09 and v > far - 0.05:
        c = (0.3, 0.28, 0.27)
    if 0.64 < u < 0.745 and far + 0.03 < v < far + 0.05:
        c = (0.3, 0.28, 0.27)
    # A tree on the left, and the foreground dark.
    td = ((u - 0.18) / 0.12) ** 2 + ((v - 0.52) / 0.17) ** 2
    if td < 1:
        c = mix((0.1, 0.15, 0.06), (0.2, 0.26, 0.1), (u - 0.1) * 3)
    if abs(u - 0.19) < 0.012 and v < 0.4:
        c = (0.16, 0.11, 0.07)
    if v < 0.12:
        c = mix((0.12, 0.13, 0.06), c, v / 0.12)
    k = grain(u, v) * 0.04
    return tuple(x + k for x in c)


def gathering(u, v):
    """"Halflings at work, and halflings at play": a warm room, a table, small
    figures round it."""
    c = mix((0.24, 0.15, 0.07), (0.42, 0.28, 0.13), v)
    if 0.25 < v < 0.33 and 0.2 < u < 0.8:
        c = (0.3, 0.18, 0.08)
    if v < 0.25:
        c = mix((0.2, 0.12, 0.06), (0.3, 0.2, 0.1), v * 4)
    figs = [(0.14, (0.55, 0.2, 0.12)), (0.3, (0.2, 0.32, 0.18)), (0.47, (0.62, 0.52, 0.25)),
            (0.63, (0.25, 0.25, 0.45)), (0.82, (0.5, 0.18, 0.3))]
    for (x, col) in figs:
        bd = ((u - x) / 0.055) ** 2 + ((v - 0.3) / 0.13) ** 2
        if bd < 1 and v < 0.38:
            c = col
        hd = ((u - x) / 0.035) ** 2 + ((v - 0.47) / 0.045) ** 2
        if hd < 1:
            c = (0.8, 0.6, 0.45)
        if ((u - x) / 0.04) ** 2 + ((v - 0.5) / 0.03) ** 2 < 1 and v > 0.49:
            c = (0.25, 0.15, 0.07)
    wd = ((u - 0.85) / 0.08) ** 2 + ((v - 0.78) / 0.1) ** 2
    if wd < 1:
        c = mix((0.9, 0.8, 0.5), c, wd)
    k = grain(u, v) * 0.05
    return tuple(x * (1 - 0.3 * abs(u - 0.5)) + k for x in c)


def sun_mural(u, v):
    """"Some persons dancing around a huge sun": ochre and red on limewash."""
    c = mix((0.72, 0.66, 0.52), (0.64, 0.58, 0.45), grain(u, v, 0.4) + 0.5)
    du, dv = u - 0.5, (v - 0.56) * 1.1
    d = math.hypot(du, dv)
    ang = math.atan2(dv, du)
    if d < 0.2:
        c = mix((0.8, 0.45, 0.12), (0.62, 0.24, 0.1), d / 0.2)
    elif d < 0.3 and (math.cos(ang * 12) > 0.35):
        c = (0.66, 0.3, 0.12)
    # A ring of figures, arms up, round the sun.
    for k in range(9):
        a = 2 * math.pi * k / 9 + 0.2
        cx, cy = 0.5 + math.cos(a) * 0.4, 0.56 + math.sin(a) * 0.36
        if abs(u - cx) < 0.012 and cy - 0.07 < v < cy + 0.02:
            c = (0.42, 0.14, 0.08)
        if math.hypot(u - cx, (v - cy - 0.04) * 1.2) < 0.02:
            c = (0.42, 0.14, 0.08)
        for s in (-1, 1):
            t = (u - cx) * s
            if 0 < t < 0.04 and abs(v - (cy + t * 0.9)) < 0.008:
                c = (0.42, 0.14, 0.08)
            if 0 < t < 0.03 and abs(v - (cy - 0.07 - t * 1.4)) < 0.008:
                c = (0.42, 0.14, 0.08)
    fade = smooth(0.0, 0.12, min(u, 1 - u, v, 1 - v))
    base = (0.66, 0.6, 0.48)
    return mix(base, c, 0.35 + 0.65 * fade)


def painting(name, W, H, img, zc=1.7, nx=30, nz=36, framed=True):
    p = []
    back = lib.box((W + 0.02, 0.02, H + 0.02), (0, -0.012, zc), name="stretcher", mat="wood")
    p.append(tag(back, "wood"))
    p.append(grid(W, H, nx, nz, img, y=-0.024, z0=zc - H / 2))
    if framed:
        p += frame(W, H, zc)
    # Hung from a wire: the top leans out from the wall a little.
    kit.place(p, (0, 0, 0), (0, 0, 0))
    for o in p:
        pass
    return deliver(p, name, colours=True)


def build_painting_portrait():
    reset(7351)
    return painting("clutter_painting_portrait", 0.62, 0.8, portrait, nx=26, nz=34)


def build_painting_landscape():
    reset(7352)
    return painting("clutter_painting_landscape", 1.2, 0.78, landscape, nx=40, nz=28)


def build_painting_gathering():
    reset(7353)
    return painting("clutter_painting_gathering", 1.3, 0.8, gathering, nx=44, nz=30)


def build_mural():
    """The seven-foot sun, painted straight on the wall: no frame, the edges
    of the limewash ground feathered into the stone."""
    reset(7354)
    p = [grid(2.3, 2.1, 46, 42, sun_mural, y=-0.006, z0=0.55)]
    return deliver(p, "clutter_mural", colours=True)


def arms(u, v):
    """The Midgaard Worm on a quartered field: gules and or, the worm sable."""
    q = (u < 0.5) ^ (v < 0.55)
    c = (0.55, 0.08, 0.06) if q else (0.78, 0.6, 0.2)
    x, y = (u - 0.5) * 2, (v - 0.55) * 2
    ring = abs(math.hypot(x, y * 1.1) - 0.45)
    if ring < 0.07:
        c = (0.08, 0.07, 0.06)
    if math.hypot(x - 0.4, y - 0.2) < 0.1:
        c = (0.08, 0.07, 0.06)
    if abs(v - 0.55) < 0.01 or abs(u - 0.5) < 0.008:
        c = mix(c, (0.1, 0.08, 0.05), 0.5)
    return c


def build_arms():
    """"The Midgaard Coat of Arms is hanging on the north wall": a painted
    heater shield on a board, two swords crossed behind it."""
    reset(7355)
    p = []
    zc = 1.85
    board = kit.timber((1.0, 0.03, 1.2), (0, -0.015, zc), mat="oak", cham=0.02, name="board")
    p.append(tag(board, "wood"))
    # The shield: a heater outline, its face a painted grid.
    W, H = 0.62, 0.78
    top = zc + H / 2
    outline = []
    for k in range(9):
        t = k / 8
        # straight sides for the top 40%, then curving in to the point
        z = top - t * H
        if t < 0.4:
            x = W / 2
        else:
            s2 = (t - 0.4) / 0.6
            x = W / 2 * math.cos(s2 * math.pi / 2) ** 0.8
        outline.append((x, z))

    def inside(u, v):
        z = top - (1 - v) * H
        t = (top - z) / H
        if t < 0.4:
            half = W / 2
        else:
            s2 = (t - 0.4) / 0.6
            half = W / 2 * max(0.0, math.cos(s2 * math.pi / 2)) ** 0.8
        return abs((u - 0.5) * W) <= half + 1e-6

    face = grid(W, H, 24, 30, arms, y=-0.07, z0=top - H, bend=lambda u, v: -0.02 * (1 - ((u - 0.5) * 2) ** 2))
    # Trim the grid to the heater outline: pull the outside vertices in to it.
    me = face.data
    for vtx in me.vertices:
        u = vtx.co.x / W + 0.5
        t = (top - vtx.co.z) / H
        half = W / 2 if t < 0.4 else W / 2 * max(0.0, math.cos((t - 0.4) / 0.6 * math.pi / 2)) ** 0.8
        vtx.co.x = max(-half, min(half, vtx.co.x))
    me.update()
    p.append(face)
    rim = [(x, -0.08, z) for (x, z) in outline] + [(-x, -0.08, z) for (x, z) in reversed(outline)]
    p.append(tube(rim + [rim[0]], 0.014, sides=4, m="gold", caps=False, name="rim", smooth=0))
    backing = lib.box((W * 0.9, 0.03, H * 0.7), (0, -0.05, top - H * 0.38), name="back", mat="wood")
    p.append(tag(backing, "wood"))
    for s in (-1, 1):
        blade = kit.timber((0.05, 0.012, 1.05), (0, -0.04, 0), mat="oak", cham=0.004, name="blade")
        tag(blade, "steel")
        guard = tag(lib.box((0.22, 0.03, 0.03), (0, -0.04, -0.55), name="guard", mat="iron"), "brass")
        grip = tag(lib.cylinder(0.018, 0.16, (0, -0.04, -0.65), verts=6, name="grip", mat="wood"), "leather")
        pommel = blob((0, -0.04, -0.75), 0.03, "brass", seg=6, rings=4, name="pommel")
        sw = [blade, guard, grip, pommel]
        kit.place(sw, (0, 0, zc - 0.1), (0, s * 0.7, 0))
        p += sw
    return deliver(p, "clutter_arms", colours=True)


def tapestry(u, v):
    """A millefleur ground in deep green, a border in madder and gold, and in
    the field a tree with a stag either side of it."""
    bw = 0.075
    edge = min(u, 1 - u, v * 1.4, (1 - v) * 1.4)
    if edge < bw:
        c = (0.42, 0.09, 0.07)
        if abs(edge - bw * 0.5) < bw * 0.14:
            c = (0.72, 0.56, 0.2)
        elif int((u + v) * 40) % 3 == 0 and edge < bw * 0.3:
            c = (0.6, 0.45, 0.18)
        return c
    c = mix((0.08, 0.16, 0.11), (0.12, 0.22, 0.14), v)
    h = math.sin(u * 131.0 + v * 17.0) * math.sin(v * 97.0 - u * 29.0)
    if h > 0.82:
        c = [(0.7, 0.62, 0.3), (0.62, 0.18, 0.15), (0.75, 0.72, 0.62)][int(abs(h * 97)) % 3]
    # The tree.
    if abs(u - 0.5) < 0.03 and 0.14 < v < 0.52:
        c = (0.3, 0.2, 0.1)
    td = ((u - 0.5) / 0.26) ** 2 + ((v - 0.62) / 0.2) ** 2
    if td < 1:
        c = mix((0.18, 0.34, 0.14), (0.1, 0.22, 0.09), td)
        if math.sin(u * 60) * math.sin(v * 50) > 0.7:
            c = (0.72, 0.3, 0.12)
    for s in (-1, 1):
        cx = 0.5 + s * 0.27
        bd = ((u - cx) / 0.1) ** 2 + ((v - 0.3) / 0.05) ** 2
        if bd < 1:
            c = (0.62, 0.45, 0.28)
        if abs(u - (cx - s * 0.07)) < 0.018 and 0.28 < v < 0.43:
            c = (0.62, 0.45, 0.28)
        if ((u - (cx - s * 0.08)) / 0.035) ** 2 + ((v - 0.44) / 0.03) ** 2 < 1:
            c = (0.62, 0.45, 0.28)
        for lx in (-0.07, -0.04, 0.05, 0.08):
            if abs(u - (cx + lx)) < 0.008 and 0.18 < v < 0.28:
                c = (0.5, 0.35, 0.22)
        if abs(u - (cx - s * 0.08)) < 0.03 and 0.47 < v < 0.52 and math.sin(u * 300) > 0:
            c = (0.5, 0.4, 0.3)
    if v < 0.14:
        c = mix((0.1, 0.2, 0.1), (0.16, 0.26, 0.12), v / 0.14)
    return c


def build_tapestry():
    """"On the wall hangs a bleak and worn tapestry." A woven hanging on a
    pole with turned ends, in soft folds, 1.5 x 2.3 m. Back at y = 0."""
    reset(7356)
    p = []
    W, H, top = 1.5, 2.3, 3.1
    p.append(F.rod((-W / 2 - 0.12, -0.08, top + 0.03), (W / 2 + 0.12, -0.08, top + 0.03), 0.022, m="wood", verts=8))
    for sx in (-1, 1):
        p.append(blob((sx * (W / 2 + 0.14), -0.08, top + 0.03), 0.04, "wood", seg=8, rings=5, name="finial"))
        p.append(F.beam((0.03, 0.08, 0.1), (sx * (W / 2 + 0.05), -0.04, top + 0.03), m="iron"))
    p.append(grid(W, H, 30, 46, tapestry, y=-0.07, z0=top - H,
                  bend=lambda u, v: -0.035 * math.sin(u * math.pi * 6.0) * (0.4 + 0.6 * (1 - v)) - 0.02 * (1 - v),
                  m="weave", name="hanging"))
    return deliver(p, "clutter_tapestry", colours=True)


# --- silk ---------------------------------------------------------------------

def build_web():
    """A giant spider's orb web, "huge threads covered with glue" as thick
    as a finger: frame, radii, the spiral, and guy lines out to whatever it
    is slung between. Vertical in the XZ plane, 5 m across, hub at 4 m."""
    reset(7361)
    hub = V((0, 0, 4.0))
    R = 2.4
    n = 13
    frame_r = [R * rng.uniform(0.82, 1.08) for _ in range(n)]
    angs = [2 * math.pi * k / n + rng.uniform(-0.08, 0.08) for k in range(n)]
    ends = [hub + V((math.cos(a) * r, 0, math.sin(a) * r * 0.9)) for a, r in zip(angs, frame_r)]
    p = []
    th = 0.011
    for e in ends:
        p.append(tube([hub, e], th, sides=3, m="silk", name="radius", smooth=0))
    ring = ends + [ends[0]]
    p.append(tube(ring, th * 1.2, sides=3, m="silk", caps=False, name="frame", smooth=0))
    # The capture spiral, strand by strand between neighbouring radii.
    turns = 15
    steps = turns * n
    prev = None
    for k in range(steps):
        t = k / steps
        i = k % n
        r = 0.3 + t * 0.9
        q = hub + (ends[i] - hub) * r * 0.95
        q.y += rng.uniform(-0.01, 0.01)
        if prev is not None and rng.random() > 0.06:
            mid = (prev + q) * 0.5
            mid.z -= 0.02
            p.append(tube([prev, mid, q], th * 0.8, sides=3, m="silk", caps=False, name="spiral", smooth=0))
        prev = q
    # Guy lines out to the anchors.
    for idx in (0, 3, 6, 9, 11):
        e = ends[idx % n]
        out = e + (e - hub).normalized() * 1.6
        out.y += rng.uniform(-0.4, 0.4)
        p.append(tube([e, out], th * 1.4, sides=3, m="silk", name="guy", smooth=0))
    p.append(blob(hub, 0.09, "silk", seg=6, rings=4, scale=(1, 0.5, 1), name="hubpad"))
    return deliver(p, "clutter_web")


def build_cocoon():
    """"The sticky walls are covered with open cocoons": a wrapped bundle a
    person's length, hanging from a strand, split at the top."""
    reset(7362)
    p = []
    secs = [(0.9, 0.02, 0.02, 0, 0), (1.0, 0.12, 0.11, 0, 0), (1.3, 0.2, 0.18, 0, 0), (1.7, 0.21, 0.19, 0, 0),
            (2.1, 0.17, 0.16, 0, 0), (2.4, 0.1, 0.1, 0, 0), (2.5, 0.05, 0.05, 0, 0)]
    body = lib.loft([(z, a, b, x, y) for (z, a, b, x, y) in secs], sides=10, axis="z", name="cocoon", mat="wood")
    lib.shade_smooth(body, angle=80)
    p.append(tag(body, "silk"))
    wrap = []
    for k in range(60):
        t = k / 59
        z = 1.0 + t * 1.45
        rr = 0.03 + 0.19 * math.sin(math.pi * min(1, (z - 0.9) / 1.6)) + 0.012
        a = k * 1.1
        wrap.append((math.cos(a) * rr, math.sin(a) * rr, z))
    p.append(tube(wrap, 0.01, sides=3, m="silk", name="wrap", smooth=0))
    p.append(tube([(0, 0, 2.5), (0.02, 0.01, 3.4), (0.0, 0.0, 4.6)], 0.012, sides=3, m="silk", name="strand", smooth=0))
    return deliver(p, "clutter_cocoon")


# --- kept things --------------------------------------------------------------

def build_cages():
    """"Full of cages and animals of various sorts and sizes": a slatted
    crate with iron bars on a low stand, and a domed birdcage on top of it.
    Back at y = 0."""
    reset(7371)
    p = []
    W, D, H = 1.0, 0.62, 0.62
    y0 = -0.36
    z0 = 0.12
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(F.beam((0.05, 0.05, H + z0), (sx * (W / 2 - 0.025), y0 + sy * (D / 2 - 0.025), (H + z0) / 2), m="wood"))
    for z in (z0, z0 + H):
        for sy in (-1, 1):
            p.append(F.beam((W, 0.05, 0.05), (0, y0 + sy * (D / 2 - 0.025), z), m="wood"))
        for sx in (-1, 1):
            p.append(F.beam((0.05, D, 0.05), (sx * (W / 2 - 0.025), y0, z), m="wood"))
    p.append(F.board((W - 0.04, D - 0.04, 0.03), (0, y0, z0 + 0.02), m="planks"))
    p.append(F.board((W, D, 0.03), (0, y0, z0 + H + 0.04), m="planks"))
    for k in range(11):
        x = -W / 2 + 0.07 + k * (W - 0.14) / 10
        p.append(F.rod((x, y0 - D / 2 + 0.025, z0), (x, y0 - D / 2 + 0.025, z0 + H), 0.008, m="iron", verts=4))
    for k in range(6):
        y = y0 - D / 2 + 0.07 + k * (D - 0.14) / 5
        for sx in (-1, 1):
            p.append(F.rod((sx * (W / 2 - 0.025), y, z0), (sx * (W / 2 - 0.025), y, z0 + H), 0.008, m="iron", verts=4))
    p.append(tag(lib.box((0.3, 0.12, 0.02), (0.25, y0 - D / 2 - 0.01, z0 + H * 0.55), name="hasp", mat="iron"), "rust"))
    # Straw on the floor of it.
    p.append(blob((0, y0, z0 + 0.04), 0.4, "thatch", seg=8, rings=3, scale=(1.1, 0.65, 0.08), name="straw"))
    # The birdcage.
    bx, by, bz = -0.22, y0, z0 + H + 0.06
    r, h = 0.17, 0.32
    p.append(F.lathe([(0, 0.2), (0.03, 0.2), (0.035, 0.17)], bx, by, bz, sides=12, m="brass", name="base"))
    for k in range(14):
        a = 2 * math.pi * k / 14
        pts = [(bx + math.cos(a) * r, by + math.sin(a) * r, bz + 0.03)]
        pts.append((bx + math.cos(a) * r, by + math.sin(a) * r, bz + h))
        for t in (0.35, 0.7, 0.95):
            rr = r * math.cos(t * math.pi / 2)
            pts.append((bx + math.cos(a) * rr, by + math.sin(a) * rr, bz + h + math.sin(t * math.pi / 2) * 0.12))
        p.append(tube(pts, 0.004, sides=3, m="brass", name="wire", smooth=0))
    for z in (bz + 0.1, bz + h):
        p.append(tag(lib.torus(r, 0.006, (bx, by, z), (0, 0, 0), major_seg=14, minor_seg=3, name="hoop", mat="iron"), "brass"))
    p.append(tag(lib.torus(0.04, 0.007, (bx, by, bz + h + 0.16), (math.pi / 2, 0, 0), major_seg=8, minor_seg=3,
                           name="ring", mat="iron"), "brass"))
    p.append(F.rod((bx - r, by, bz + 0.16), (bx + r, by, bz + 0.16), 0.006, m="wood", verts=4))
    # A small hutch beside it.
    hx = 0.28
    p.append(F.board((0.4, 0.34, 0.26), (hx, y0 - 0.02, z0 + H + 0.19), m="wood"))
    for k in range(5):
        p.append(F.rod((hx - 0.14 + k * 0.07, y0 - 0.2, z0 + H + 0.07), (hx - 0.14 + k * 0.07, y0 - 0.2, z0 + H + 0.31),
                       0.006, m="iron", verts=4))
    return deliver(p, "clutter_cages")


def build_globe():
    """"A socket with a crystal globe. The globe glows with a pulsing light
    ... It looks like there is smoke inside it." The socket is dwarf work:
    a stepped foot, a turned shaft, a cup with four claws round the globe."""
    reset(7372)
    p = []
    p.append(F.lathe([(0, 0.34), (0.08, 0.34), (0.1, 0.3), (0.16, 0.3), (0.19, 0.2), (0.24, 0.15), (0.3, 0.13),
                      (0.42, 0.15), (0.46, 0.12), (0.7, 0.1), (0.74, 0.14), (0.8, 0.15), (0.86, 0.2), (0.92, 0.23),
                      (0.95, 0.22)], 0, 0, 0, sides=8, m="marble", name="socket", smooth=False))
    for k in range(8):
        a = 2 * math.pi * (k + 0.5) / 8
        p.append(tag(lib.box((0.02, 0.05, 0.08), (math.cos(a) * 0.33, math.sin(a) * 0.33, 0.04),
                             (0, 0, a), name="rune", mat="iron"), "brass"))
    g = lib.sphere(0.21, (0, 0, 1.12), segments=16, rings=10, name="globe", mat="wood")
    lib.shade_smooth(g, angle=80)
    tag(g, "glow")
    paint(g, lambda q: mix((0.35, 0.3, 0.55), (0.75, 0.72, 0.95),
                           0.5 + 0.5 * math.sin(q.x * 25 + q.z * 13) * math.sin(q.y * 21 - q.z * 9)))
    p.append(g)
    for k in range(4):
        a = 2 * math.pi * k / 4 + 0.4
        pts = [(math.cos(a) * 0.2, math.sin(a) * 0.2, 0.93), (math.cos(a) * 0.23, math.sin(a) * 0.23, 1.04),
               (math.cos(a) * 0.2, math.sin(a) * 0.2, 1.17), (math.cos(a) * 0.12, math.sin(a) * 0.12, 1.26)]
        p.append(tube(pts, [0.02, 0.018, 0.013, 0.007], sides=5, m="brass", name="claw"))
    return deliver(p, "clutter_globe", colours=True)


# --- a feast --------------------------------------------------------------

def fruit(c, r, col):
    b = blob(c, r, "produce", seg=6, rings=4, name="fruit")
    paint(b, col)
    return b


def build_feast():
    """"Great tables of food are spread out": a trestle table three metres
    long under a linen cloth, and on it a roast boar with an apple in its
    mouth, fowl, loaves, a cheese, pies, fruit, jugs, cups -- and a cake,
    it being a birthday. Free-standing, long along X."""
    reset(7381)
    p = []
    L, D, H = 3.0, 1.0, 0.78
    top = F.worn((L, D, 0.05), (0, 0, H - 0.025))
    p.append(top)
    for sx in (-1, 1):
        x = sx * (L / 2 - 0.3)
        p.append(F.strut((x, -0.35, 0), (x, 0, H - 0.05), 0.07))
        p.append(F.strut((x, 0.35, 0), (x, 0, H - 0.05), 0.07))
        p.append(F.beam((0.08, D - 0.15, 0.06), (x, 0, H - 0.08), m="wood"))
    p.append(F.beam((L - 0.6, 0.06, 0.08), (0, 0, 0.3), m="wood"))
    # The cloth: over the top and hanging down the long sides.
    cloth = lib.box((L - 0.1, D + 0.04, 0.008), (0, 0, H + 0.004), name="cloth", mat="wood")
    p.append(tag(cloth, "linen"))
    for sy in (-1, 1):
        p.append(tag(lib.box((L - 0.1, 0.008, 0.24), (0, sy * (D / 2 + 0.02), H - 0.11), name="drop", mat="wood"), "linen"))
    T = H + 0.008
    # Platters.
    for (x, y, r) in ((0.0, 0.0, 0.34), (-0.95, 0.1, 0.2), (0.95, -0.1, 0.2)):
        p.append(F.lathe([(0, r * 0.8), (0.01, r), (0.025, r * 1.02)], x, y, T, sides=14, m="pewter", name="platter"))
    # The boar: a loft along X, glazed brown, legs tucked, apple in its mouth.
    boar = lib.loft([(-0.32, 0.03, 0.03, 0.1, 0), (-0.25, 0.1, 0.1, 0.12, 0), (-0.05, 0.14, 0.13, 0.14, 0),
                     (0.12, 0.14, 0.12, 0.13, 0), (0.25, 0.09, 0.08, 0.12, 0), (0.36, 0.05, 0.05, 0.1, 0),
                     (0.41, 0.03, 0.03, 0.09, 0)], sides=10, axis="x", name="boar", mat="wood")
    lib.shade_smooth(boar, angle=80)
    tag(boar, "produce")
    paint(boar, lambda q: mix((0.42, 0.2, 0.08), (0.62, 0.34, 0.12), (q.z - T) * 4))
    boar.location = (0, 0, T + 0.01)
    p.append(boar)
    for sx in (-0.2, 0.18):
        for sy in (-1, 1):
            leg = blob((sx, sy * 0.11, T + 0.06), 0.045, "produce", seg=6, rings=4, scale=(1.4, 0.8, 0.7), name="leg")
            paint(leg, (0.4, 0.2, 0.08))
            p.append(leg)
    p.append(fruit((0.43, 0, T + 0.1), 0.035, (0.7, 0.12, 0.08)))
    for sy in (-1, 1):
        ear = blob((0.33, sy * 0.045, T + 0.2), 0.03, "produce", seg=5, rings=3, scale=(0.6, 0.4, 1.0), name="ear")
        paint(ear, (0.35, 0.16, 0.07))
        p.append(ear)
    # Fowl on the side platters.
    for (x, y) in ((-0.95, 0.1), (0.95, -0.1)):
        bird = blob((x, y, T + 0.08), 0.1, "produce", seg=8, rings=5, scale=(1.2, 0.9, 0.7), name="fowl")
        paint(bird, lambda q: mix((0.5, 0.26, 0.09), (0.7, 0.42, 0.16), (q.z - T) * 6))
        p.append(bird)
        for sy in (-1, 1):
            d = tube([(x + 0.08, y + sy * 0.05, T + 0.07), (x + 0.2, y + sy * 0.07, T + 0.1)], [0.028, 0.012], sides=5,
                     m="produce", name="drum")
            paint(d, (0.55, 0.3, 0.1))
            p.append(d)
    # Bread.
    for (x, y, t) in ((-0.55, -0.3, 0.3), (-0.45, 0.32, -0.2), (1.25, 0.3, 1.2)):
        p.append(F.loaf(x, y, T, turn=t))
    for (x, y) in ((0.55, 0.3), (-1.3, -0.3), (0.6, -0.34)):
        p.append(F.cob(x, y, T))
    # A cheese with a wedge out of it.
    ch = F.lathe([(0, 0.13), (0.09, 0.13)], 0.42, 0.1, T, sides=12, m="produce", name="cheese", smooth=False)
    paint(ch, (0.85, 0.66, 0.25))
    p.append(ch)
    # Pies.
    for (x, y) in ((-0.2, 0.35), (1.0, 0.33)):
        pie = F.lathe([(0, 0.1), (0.04, 0.12), (0.05, 0.11), (0.06, 0.06)], x, y, T, sides=12, m="bread", name="pie")
        p.append(pie)
    # A bowl of fruit.
    p.append(F.lathe([(0, 0.07), (0.02, 0.1), (0.08, 0.15), (0.09, 0.15)], -0.2, -0.32, T, sides=12, m="earthenware",
                     name="bowl"))
    for k in range(9):
        a = k * 2.4
        rr = 0.06 if k < 6 else 0.02
        col = [(0.7, 0.12, 0.08), (0.75, 0.6, 0.15), (0.35, 0.12, 0.35)][k % 3]
        p.append(fruit((-0.2 + math.cos(a) * rr, -0.32 + math.sin(a) * rr, T + 0.1 + (0.04 if k >= 6 else 0)), 0.035, col))
    # Grapes.
    for k in range(10):
        p.append(fruit((-1.2 + (k % 4) * 0.03, 0.25 + (k // 4) * 0.03, T + 0.02 + (k % 3) * 0.015), 0.018,
                       (0.3, 0.1, 0.32)))
    # The cake: three tiers and candles.
    for i, (r, h) in enumerate(((0.16, 0.09), (0.12, 0.08), (0.08, 0.07))):
        z = T + sum(hh for (_, hh) in ((0.16, 0.09), (0.12, 0.08), (0.08, 0.07))[:i])
        tier = F.lathe([(0, r), (h, r)], 1.3, -0.25, z, sides=14, m="produce", name="tier", smooth=False)
        paint(tier, (0.92, 0.86, 0.78) if i != 1 else (0.86, 0.62, 0.62))
        p.append(tier)
    for k in range(5):
        a = 2 * math.pi * k / 5
        p.append(tag(lib.cylinder(0.008, 0.06, (1.3 + math.cos(a) * 0.05, -0.25 + math.sin(a) * 0.05, T + 0.27),
                                  verts=5, name="candle", mat="wood"), "wax"))
    # Drink.
    for (x, y) in ((-0.7, 0.35), (0.3, -0.38)):
        p += F.jug(x, y, T)
    for (x, y) in ((-1.05, -0.35), (-0.25, 0.1), (0.75, 0.38), (1.05, 0.1)):
        p += F.tankard(x, y, T, m="pewter", turn=rng.uniform(0, 6.28))
    p += F.candle(-0.8, -0.05, T)
    p += F.candle(0.8, 0.05, T)
    return deliver(p, "clutter_feast", colours=True)


# --- the remains ----------------------------------------------------------

def build_carcass():
    """"Half-eaten and rotting body parts", "mutilated corpses": a torn
    ribcage with meat still on it, a spine, a thigh, rags, the dark where it
    bled into the floor. Grim, not a slasher prop -- at a few metres it reads
    as remains and nothing more."""
    reset(7391)
    p = []
    stain = lib.cylinder(0.75, 0.006, (0.05, 0, 0.003), verts=12, name="stain", mat="wood")
    stain.scale = (1.2, 0.8, 1)
    p.append(tag(stain, "flesh"))
    p += ribcage((-0.2, 0, 0.16), (0.2, 0, 0.14), (0, 0.2, 1), width=0.14, depth=0.1, pairs=6, flat=0.8)
    p += spine([(-0.35, 0.02, 0.06), (-0.15, 0.03, 0.07), (0.1, 0.02, 0.07), (0.3, 0.0, 0.06)])
    for k in range(7):
        c = (rng.uniform(-0.25, 0.3), rng.uniform(-0.15, 0.15), rng.uniform(0.05, 0.14))
        p.append(blob(c, rng.uniform(0.04, 0.08), "flesh", seg=6, rings=4, scale=(1.3, 0.9, 0.6), name="meat"))
    p += long_bone((0.35, -0.25, 0.03), (0.72, -0.1, 0.05), 0.018)
    p.append(blob((0.5, -0.19, 0.06), 0.06, "flesh", seg=6, rings=4, scale=(1.6, 0.8, 0.7), name="thigh"))
    p += long_bone((-0.6, 0.3, 0.02), (-0.35, 0.45, 0.03), 0.013)
    p += hand((-0.34, 0.46, 0.03), (1, 0.4, -0.05), 1)
    for k in range(3):
        rag = lib.box((0.3, 0.2, 0.006), (rng.uniform(-0.5, 0.5), rng.uniform(-0.35, 0.35), 0.01),
                      (rng.uniform(-0.2, 0.2), rng.uniform(-0.2, 0.2), rng.uniform(0, 3)), name="rag", mat="wood")
        p.append(tag(rag, "cloth"))
    p += skull((-0.55, -0.2, 0.08), (0.4, -0.6, 0.5), (0.3, 0.2, 1), jaw_drop=0.03)
    return deliver(p, "clutter_carcass")


def pelt_shape(u, v):
    """0..1 inside the outline of a flayed hide: body oval, four leg flaps,
    head and tail."""
    x, y = (u - 0.5) * 2, (v - 0.5) * 2
    body = (x / 0.62) ** 2 + (y / 0.78) ** 2 < 1
    legs = any(((x - sx * 0.62) / 0.28) ** 2 + ((y - sy * 0.52) / 0.12) ** 2 < 1 for sx in (-1, 1) for sy in (-1, 1))
    head = (x / 0.18) ** 2 + ((y - 0.86) / 0.14) ** 2 < 1
    tail = abs(x) < 0.05 and -1.0 < y < -0.7
    return body or legs or head or tail


def build_pelts():
    """"Many furs are spread out on the floor": three hides, flat and a
    little rucked, overlapping. Brown bear, grey wolf, a pale deer."""
    reset(7392)
    p = []
    for (cx, cy, turn, W, H, col, z) in ((0, 0, 0.3, 1.3, 1.8, (0.33, 0.22, 0.14), 0.012),
                                         (0.9, -0.5, -0.9, 1.0, 1.4, (0.45, 0.43, 0.4), 0.024),
                                         (-0.8, 0.6, 1.9, 0.9, 1.3, (0.62, 0.48, 0.32), 0.03)):
        n = 14

        def colour(u, v, col=col):
            d = abs(u - 0.5)
            return mix(tuple(c * 0.55 for c in col), col, smooth(0.0, 0.25, d)) if pelt_shape(u, v) else col
        sheet = grid(W, H, n, int(n * H / W), colour, m="fur", name="pelt",
                     bend=lambda u, v: 0.0)
        me = sheet.data
        keep = []
        for f in me.polygons:
            cu = sum(((me.vertices[i].co.x / W) + 0.5) for i in f.vertices) / len(f.vertices)
            cv = sum(((me.vertices[i].co.z) / H) for i in f.vertices) / len(f.vertices)
            keep.append(pelt_shape(cu, cv))
        import bmesh
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for i, k in enumerate(keep) if not k], context="FACES")
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
        # Lay it down: XZ sheet -> XY floor, rucked a little.
        for v in bm.verts:
            x, zz = v.co.x, v.co.z - H / 2
            v.co = V((x, zz, z + 0.02 * math.sin(x * 7 + zz * 5) * math.sin(zz * 3)))
        for f in bm.faces:
            f.normal_update()
            if f.normal.z < 0:
                f.normal_flip()
        bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.015)
        bm.to_mesh(me)
        bm.free()
        me.update()
        sheet.rotation_euler = (0, 0, turn)
        sheet.location = (cx, cy, 0)
        lib.shade_smooth(sheet, angle=60)
        p.append(sheet)
    return deliver(p, "clutter_pelts", colours=True)


def build_hay():
    """"Some hay spread on the floor": a trodden bed of it, and wisps kicked
    out round the edge."""
    reset(7393)
    p = [blob((0, 0, 0.0), 0.8, "thatch", seg=12, rings=5, scale=(1.2, 0.85, 0.13), name="bed")]
    Q = []
    for k in range(70):
        a = rng.uniform(0, 6.28)
        d = rng.uniform(0.5, 1.2)
        c = V((math.cos(a) * d * 1.2, math.sin(a) * d * 0.85, 0))
        t = rng.uniform(0, 3.14)
        L = rng.uniform(0.12, 0.3)
        e = V((math.cos(t), math.sin(t), 0)) * L
        Q.append(flat_strip(tuple(c), tuple(c + e), 0.012, z=0.006 + rng.uniform(0, 0.02)))
    p.append(quads("wisps", Q, "thatch"))
    return deliver(p, "clutter_hay")


def build_wreckage():
    """"Now the furniture is all around you in small pieces": a chair on
    its back with a leg gone, a table top split and fallen, broken legs and
    splintered boards."""
    reset(7394)
    p = []
    # The table top in two halves, one tipped against the other.
    p.append(F.board((1.2, 0.36, 0.05), (0.1, 0.4, 0.025), m="wood"))
    half = F.board((1.2, 0.36, 0.05), (0, 0, 0), m="wood")
    half.rotation_euler = (math.radians(28), 0, 0.12)
    half.location = (0.05, 0.02, 0.17)
    p.append(half)
    for (a, b) in (((-0.7, -0.4, 0.03), (-0.1, -0.55, 0.03)), ((0.5, -0.6, 0.03), (0.85, -0.2, 0.03)),
                   ((-0.9, 0.3, 0.03), (-0.75, 0.8, 0.03))):
        p.append(F.strut(a, b, 0.06))
    # A chair on its back.
    ch = []
    ch.append(F.board((0.42, 0.42, 0.04), (0, 0, 0.45), m="wood"))
    for sx in (-1, 1):
        ch.append(F.strut((sx * 0.18, 0.18, 0.43), (sx * 0.18, 0.18, 0.0), 0.04))
        ch.append(F.strut((sx * 0.18, 0.18, 0.47), (sx * 0.18, 0.2, 0.95), 0.04))
    ch.append(F.strut((0.18, -0.18, 0.43), (0.18, -0.18, 0.2), 0.04))
    ch.append(F.board((0.4, 0.03, 0.12), (0, 0.2, 0.85), m="wood"))
    kit.place(ch, (0, 0, 0), (-math.pi / 2, 0, 0))
    kit.place(ch, (-0.6, 0.1, 0.2), (0, 0, 0.6))
    p += ch
    # Splinters: short boards with a sharp end.
    for k in range(7):
        c = (rng.uniform(-1.0, 1.0), rng.uniform(-0.8, 0.8), 0.015)
        L = rng.uniform(0.15, 0.4)
        t = rng.uniform(0, 3.14)
        p.append(F.strut(c, (c[0] + math.cos(t) * L, c[1] + math.sin(t) * L, 0.02), rng.uniform(0.02, 0.05), d=0.018))
    return deliver(p, "clutter_wreckage")


# --- the chain to the clouds -------------------------------------------------

LINK_L, LINK_W, LINK_R = 1.3, 0.8, 0.12
LINK_PITCH = LINK_L - 2 * LINK_R - 0.04
RUN_LINKS = 8


def build_chain_run():
    """Eight links of the Road Crossing's chain, standing on end: instanced
    one above another up into the cloud. `LINK_PITCH * RUN_LINKS` tall."""
    reset(7395)
    p = []
    for k in range(RUN_LINKS):
        p.append(iron_link((0, 0, LINK_PITCH * (k + 0.5)), turn=(math.pi / 2) * (k % 2), L=LINK_L, W=LINK_W,
                           r=LINK_R, m="iron", sides=6))
    return deliver(p, "clutter_chain_run")


def build_chain_anchor():
    """"A huge black iron chain as thick as a tree trunk is fastened into
    the ground": a stepped block of stone, an iron plate bolted over it, a
    staple, and the first links."""
    reset(7396)
    p = []
    b = lib.box((2.6, 2.6, 0.35), (0, 0, 0.175), name="step", mat="stonewall")
    kit.bev(b, 0.04)
    p.append(tag(b, "stonewall"))
    b2 = lib.box((2.0, 2.0, 0.4), (0, 0, 0.55), name="block", mat="stonewall")
    kit.bev(b2, 0.04)
    p.append(tag(b2, "stonewall"))
    plate = lib.box((1.5, 1.5, 0.08), (0, 0, 0.79), name="plate", mat="iron")
    kit.bev(plate, 0.015)
    p.append(tag(plate, "iron"))
    for sx in (-1, 1):
        for sy in (-1, 1):
            for (dx, dy) in ((0, 0), (0.25, 0), (0, 0.25)):
                p.append(blob((sx * (0.62 - dx), sy * (0.62 - dy), 0.84), 0.06, "iron", seg=6, rings=3,
                              scale=(1, 1, 0.5), name="bolt", smooth=0))
    staple = [(-0.3, 0, 0.8), (-0.3, 0, 1.1), (-0.22, 0, 1.28), (0, 0, 1.35), (0.22, 0, 1.28), (0.3, 0, 1.1),
              (0.3, 0, 0.8)]
    p.append(tube(staple, 0.13, sides=8, m="iron", name="staple"))
    p.append(iron_link((0, 0, 1.25 + LINK_L * 0.5 - 0.3), turn=math.pi / 2, L=LINK_L, W=LINK_W, r=LINK_R, m="iron",
                       sides=6))
    return deliver(p, "clutter_chain_anchor")


ASSETS = [build_skull, build_bones, build_skeleton, build_skeleton_seated, build_skeleton_hanging,
          build_shackles, build_strongbox, build_chest, build_hoard, build_sarcophagus, build_alchemy,
          build_pentagram, build_blackboard, build_plaque, build_sign, build_painting_portrait,
          build_painting_landscape, build_painting_gathering, build_mural, build_arms, build_tapestry, build_web,
          build_cocoon, build_cages, build_globe, build_feast, build_carcass, build_pelts, build_hay, build_wreckage,
          build_chain_run, build_chain_anchor]


def build(only=None):
    out = []
    for fn in ASSETS:
        name = "clutter_" + fn.__name__[len("build_"):]
        if only and name not in only and fn.__name__[len("build_"):] not in only:
            continue
        out.append(fn())
    return "\n".join(out)


def preview(names, prefix="/tmp/clutter-pv", res=(640, 480), azim=-35.0, elev=22.0):
    """Render each exported file on its own, framed to its bounds, with
    Workbench: vertex colours where it has them, material colours elsewhere,
    and a wall behind anything that hangs on one (its back at y = 0). Returns
    the paths; `montage` them into one sheet to look at."""
    import os
    paths = []
    for name in names:
        lib.reset()
        bpy.ops.import_scene.gltf(filepath=os.path.join(lib.ASSETS, "%s.glb" % name))
        meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
        bpy.context.view_layer.update()
        lo = V((1e9, 1e9, 1e9))
        hi = V((-1e9, -1e9, -1e9))
        for o in meshes:
            for c in o.bound_box:
                w = o.matrix_world @ V(c)
                lo = V((min(lo.x, w.x), min(lo.y, w.y), min(lo.z, w.z)))
                hi = V((max(hi.x, w.x), max(hi.y, w.y), max(hi.z, w.z)))
        for m in bpy.data.materials:
            key = m.name.split(".")[0]
            key = key[4:] if key.startswith("MAT:") else key
            m.diffuse_color = PAL.get(key, lib.PALETTE.get(key, (0.6, 0.6, 0.6, 1.0)))
        for o in meshes:
            src = next((a for a in o.data.attributes if a.name.lower() == "_col"), None)
            if src is not None:
                attr = o.data.color_attributes.new("Col", "FLOAT_COLOR", src.domain)
                for d, e in zip(attr.data, src.data):
                    v = e.color if hasattr(e, "color") else e.vector
                    d.color = (v[0], v[1], v[2], 1.0)
                continue
            if len(o.data.color_attributes):
                continue
            base = o.data.materials[0].diffuse_color if o.data.materials else (0.6, 0.6, 0.6, 1)
            attr = o.data.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
            for d in attr.data:
                d.color = base
        bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
        fl = bpy.context.object
        attr = fl.data.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        for d in attr.data:
            d.color = (0.42, 0.40, 0.37, 1)
        if hi.y < 0.05 and hi.y > -0.05 and lo.y < -0.02:
            bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.1, 5))
            wl = bpy.context.object
            wl.scale = (30, 0.2, 10)
            attr = wl.data.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
            for d in attr.data:
                d.color = (0.55, 0.53, 0.50, 1)
        scene = bpy.context.scene
        try:
            scene.render.engine = "BLENDER_WORKBENCH"
        except TypeError:
            pass
        sh = scene.display.shading
        sh.light = "STUDIO"
        sh.color_type = "VERTEX"
        sh.show_shadows = True
        sh.show_cavity = True
        sh.cavity_type = "BOTH"
        scene.display.shadow_focus = 0.6
        c = (lo + hi) * 0.5
        size = max(hi.x - lo.x, hi.z - lo.z, (hi.y - lo.y) * 0.8, 0.3)
        cam_data = bpy.data.cameras.new("cam")
        cam_data.lens = 50.0
        cam = bpy.data.objects.new("cam", cam_data)
        scene.collection.objects.link(cam)
        d = size * 2.3 + 0.3
        a, e = math.radians(azim), math.radians(elev)
        cam.location = (c.x + d * math.sin(a) * math.cos(e), c.y - d * math.cos(a) * math.cos(e), c.z + d * math.sin(e))
        cam.rotation_euler = (math.pi / 2 - e, 0, a)
        scene.camera = cam
        scene.render.resolution_x, scene.render.resolution_y = res
        path = "%s-%s.png" % (prefix, name)
        scene.render.filepath = path
        scene.render.image_settings.file_format = "PNG"
        bpy.ops.render.render(write_still=True)
        paths.append(path)
    return paths
