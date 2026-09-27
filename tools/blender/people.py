"""people -- the mobiles that are people, and the monsters built like them.

This replaces townsperson.py's segmented figure. That one was welded solids,
one per bone, which cannot pinch but cannot pass for a person either: every
joint was a lap seam, every limb a prism, and a crowd of them read as shop
mannequins however they were tinted.

The body here is one continuous skin. It is drawn the way the old one was --
lofted rings on a proper canon, seven and a half heads to 1.75 m -- but the
parts are then fused into a single surface by a voxel remesh, eased with a
little smoothing so the joins become fillets instead of creases, and reduced
with a quadric decimation, which keeps triangles where the curvature is (the
face, the hands, the knees) and spends few on the flat of a back. It is
weighted by bone heat, which on a single closed surface is what a rigger would
start from anyway.

The body is modelled in an A-pose, arms 40 degrees off the ribs, because heat
weighting a hanging arm bleeds into the flank it nearly touches, and a voxel
remesh fuses them outright. It is then posed arms-down, the deformation is
applied, and that pose becomes the rest pose -- so the bind comes from the
clean A-pose solution while the animation tables below are written against a
figure standing naturally, which is what makes them readable.

Clothes are geometry. Close-fitting garments -- hose, sleeves, a tunic's body,
a mail shirt, boots -- are shells cut out of the body itself and pushed out
along the normals, so they carry the body's own weights and cannot be poked
through by it: the skin they cover is deleted. Everything that hangs --
skirts, robes, tabards, aprons, hoods, cloaks -- is lofted to its own
silhouette and weighted by formula. Armour plates are rigid, one bone each,
as armour is.

Every archetype is one skinned mesh on one shared skeleton, in one file, so
the viewer loads a single rig and a single set of clips for all of them.
Hair, beards and hats are small separate meshes on the head bone, switched
on per person, which is where a crowd's variety comes from.

Axes: Blender Z-up, the figure faces -Y, its left is +X (.L).
"""

import math
import importlib

import bpy
import bmesh
import mathutils
from mathutils import Vector, Matrix

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

V = Vector


# --- lofting --------------------------------------------------------------

def frame(direction, side=(1.0, 0.0, 0.0)):
    """An orthonormal (axis, u, v) with u as close to `side` as the axis
    allows and v = axis x u, which for a limb pointing down and u = +X puts v
    on -Y: the front."""
    d = V(direction).normalized()
    u = V(side)
    u = (u - d * u.dot(d)).normalized()
    v = d.cross(u).normalized()
    return d, u, v


def ring_loft(origin, direction, rings, sides=24, side=(1.0, 0.0, 0.0), name="part",
              mat="skin", caps=True):
    """Rings along an axis. Each ring is (t, rx, rf, rb, ox, oy, power):
    distance along the axis, half-width, half-depth to the front and to the
    back (a chest is deeper in front than behind, a calf the other way),
    offsets across and forward, and a superellipse power -- 2 is an ellipse,
    3 is a rounded box, which is what a torso's cross-section really is.
    Short tuples are padded: (t, rx, rf) is a round-fronted ellipse."""
    d, u, v = frame(direction, side)
    o = V(origin)
    verts, faces = [], []
    full = []
    for r in rings:
        r = list(r) + [None] * (7 - len(r))
        t, rx, rf, rb, ox, oy, pw = r
        rb = rf if rb is None else rb
        ox = ox or 0.0
        oy = oy or 0.0
        pw = pw or 2.0
        full.append((t, rx, rf, rb, ox, oy, pw))
    for (t, rx, rf, rb, ox, oy, pw) in full:
        c = o + d * t + u * ox + v * oy
        for i in range(sides):
            a = 2.0 * math.pi * i / sides
            ca, sa = math.cos(a), math.sin(a)
            e = 2.0 / pw
            cu = math.copysign(abs(ca) ** e, ca)
            sv = math.copysign(abs(sa) ** e, sa)
            ry = rf if sv > 0 else rb
            verts.append(tuple(c + u * (rx * cu) + v * (ry * sv)))
    n = sides
    for k in range(len(full) - 1):
        b = k * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((b + i, b + j, b + j + n, b + i + n))
    if caps:
        faces.append(tuple(range(n - 1, -1, -1)))
        last = (len(full) - 1) * n
        faces.append(tuple(range(last, last + n)))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, mat)
    outward(obj)
    return obj


def outward(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def _orient(obj, center, direction):
    """Turn a mesh built about `center` with its long axis on Y so the long
    axis lies along `direction`."""
    c = V(center)
    q = V((0, 1, 0)).rotation_difference(V(direction).normalized())
    m = Matrix.Translation(c) @ q.to_matrix().to_4x4() @ Matrix.Translation(-c)
    obj.data.transform(m)
    obj.data.update()
    return obj


def ellipsoid(center, radii, name="blob", mat="skin", seg=24, rings=16, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, segments=seg, ring_count=rings,
                                         location=center, rotation=rot)
    obj = bpy.context.object
    obj.name = name
    obj.scale = radii
    # Location too, so the mesh is in world coordinates like a loft's.
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return lib.assign(obj, mat)


def apply_all(obj):
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    out = bpy.context.object
    out.name = name
    out.data.name = name
    return out


def fuse(objs, name, voxel=0.005, smooth=4, smooth_factor=0.5, ratio=None, target=None,
         mat="skin", protect=None, smooth_where=None):
    """Union a set of closed parts into one surface: voxel remesh, ease the
    joins into fillets, then a quadric decimation down to `target` triangles."""
    obj = join(objs, name)
    m = obj.modifiers.new("remesh", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    m.use_smooth_shade = True
    apply_all(obj)
    if smooth:
        s = obj.modifiers.new("smooth", "SMOOTH")
        s.factor = smooth_factor
        s.iterations = smooth
        if smooth_where:
            # The joins want easing into fillets; a face does not want its
            # mouth and eyelids eased away with them.
            vg = obj.vertex_groups.new(name="smooth")
            for v in obj.data.vertices:
                vg.add([v.index], smooth_where(v.co), "REPLACE")
            s.vertex_group = "smooth"
        apply_all(obj)
        if smooth_where:
            obj.vertex_groups.remove(obj.vertex_groups["smooth"])
    if target:
        decimate_to(obj, target, protect)
    elif ratio and ratio < 1.0:
        dm = obj.modifiers.new("decimate", "DECIMATE")
        dm.ratio = ratio
        dm.use_collapse_triangulate = True
        apply_all(obj)
    obj.data.materials.clear()
    obj.data.materials.append(lib.material(mat))
    for p in obj.data.polygons:
        p.use_smooth = True
    return obj


def tri_count(obj, where=None):
    obj.data.calc_loop_triangles()
    if where is None:
        return len(obj.data.loop_triangles)
    vs = obj.data.vertices
    n = 0
    for t in obj.data.loop_triangles:
        c = (vs[t.vertices[0]].co + vs[t.vertices[1]].co + vs[t.vertices[2]].co) / 3
        if where(c):
            n += 1
    return n


def decimate_to(obj, target, protect=None):
    """Quadric decimation to `target` triangles, with some regions allowed a
    larger share than their area earns them.

    `protect` is [(weight_fn, share)]: a function from a vertex position to 0..1
    membership, and the share of the final triangles that region should get.
    Blender's collapse reads a vertex group as how decimatable a vertex is, and
    it is violently non-linear in it -- measured on two equal spheres, a weight
    of 0.97 against 1.0 keeps 70% of the triangles on the 0.97 side, and 0.6
    keeps 86%. So the weight is searched for, not guessed: bisect it until the
    region comes out at its share. A face decimated by area alone lost an eye
    and grew a hole for a nostril at 3200 triangles; the same budget with the
    head held to a quarter of it keeps both."""
    import numpy as np
    src = obj.data.copy()
    if not protect:
        dm = obj.modifiers.new("decimate", "DECIMATE")
        dm.ratio = min(1.0, target / max(1, tri_count(obj)))
        dm.use_collapse_triangulate = True
        dm.use_symmetry = True
        dm.symmetry_axis = "X"
        apply_all(obj)
        return obj
    fn, share = protect[0]
    member = [fn(v.co) for v in src.vertices]
    lo, hi = 0.0, 1.0        # the protected region's weight: lower keeps more
    best = None
    for it in range(9):
        w = (lo + hi) / 2
        obj.data = src.copy()
        vg = obj.vertex_groups.get("decimate") or obj.vertex_groups.new(name="decimate")
        for i, m in enumerate(member):
            vg.add([i], 1.0 - (1.0 - w) * m, "REPLACE")
        dm = obj.modifiers.new("decimate", "DECIMATE")
        dm.ratio = min(1.0, target / max(1, len(src.polygons) * 2))
        dm.use_collapse_triangulate = True
        dm.use_symmetry = True
        dm.symmetry_axis = "X"
        dm.vertex_group = "decimate"
        apply_all(obj)
        total = tri_count(obj)
        got = tri_count(obj, lambda c: fn(c) > 0.5) / max(1, total)
        best = (abs(got - share), w)
        if got < share:
            hi = w
        else:
            lo = w
        if abs(got - share) < 0.02:
            break
    obj.vertex_groups.remove(obj.vertex_groups["decimate"])
    tidy(obj)
    return obj


def tidy(obj):
    """What a quadric collapse leaves behind: slivers, the odd triangle folded
    over its neighbour, and fans of long thin ones. The folded ones render as
    black specks under smooth shading -- the corners of a mouth and an eye
    were full of them -- so: drop the degenerate, turn every edge that a
    better diagonal exists for, and put the normals back out."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.dissolve_degenerate(threshold=0.0004)
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.beautify_fill(angle_limit=math.radians(25))
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


# --- the canon ------------------------------------------------------------

# Proportions. A man is the reference; the others are read off the same
# stations with different numbers, so the rig and every clip fit them all.
MALE = dict(
    name="male",
    # joints
    hip=(0.092, 0.0, 0.955), knee=(0.100, -0.012, 0.515), ankle=(0.106, 0.012, 0.090),
    shoulder=(0.182, 0.012, 1.445), neck_base=1.470, head_joint=1.600, crown=1.752,
    arm_a=40.0, upper=0.292, fore=0.252, hand=0.185,
    # girths (half-widths / half-depths, m)
    hips=(0.168, 0.100, 0.118), waist=(0.142, 0.094, 0.090), chest=(0.158, 0.112, 0.100),
    lats=0.163, neck=0.060, thigh=0.086, calf=0.060, knee_r=0.050, ankle_r=0.034,
    upper_r=0.050, elbow_r=0.039, wrist_r=0.029, delt=0.064,
    head=(0.077, 0.100, 0.118), jaw=0.062, chin=0.025, brow=1.0, nose=1.0,
    breasts=0.0, belly=0.0,
)
FEMALE = dict(
    MALE, name="female",
    hip=(0.090, 0.0, 0.905), knee=(0.094, -0.010, 0.488), ankle=(0.098, 0.012, 0.085),
    shoulder=(0.160, 0.012, 1.358), neck_base=1.382, head_joint=1.508, crown=1.650,
    upper=0.272, fore=0.232, hand=0.170,
    hips=(0.176, 0.100, 0.125), waist=(0.122, 0.082, 0.080), chest=(0.146, 0.104, 0.090),
    lats=0.140, neck=0.047, thigh=0.086, calf=0.055, knee_r=0.045, ankle_r=0.030,
    upper_r=0.043, elbow_r=0.033, wrist_r=0.025, delt=0.050,
    head=(0.072, 0.095, 0.110), jaw=0.054, chin=0.019, brow=0.4, nose=0.8,
    breasts=1.0,
)


# A troll: a head taller than a man before it is scaled, hunched, with a
# belly, arms that reach its knees, hands and feet half as big again, and a
# face that is nose and brow. The rig is the same bones with the same names,
# so every clip plays on it; the hunch is in the rest pose (see `hunch`).
TROLL = dict(
    MALE, name="troll",
    hip=(0.125, 0.0, 0.860), knee=(0.135, -0.022, 0.470), ankle=(0.145, 0.012, 0.095),
    shoulder=(0.245, 0.020, 1.500), neck_base=1.535, head_joint=1.650, crown=1.860,
    arm_a=40.0, upper=0.400, fore=0.380, hand=0.270,
    hips=(0.205, 0.140, 0.150), waist=(0.215, 0.165, 0.125), chest=(0.232, 0.160, 0.160),
    lats=0.252, neck=0.090, thigh=0.122, calf=0.092, knee_r=0.072, ankle_r=0.050,
    upper_r=0.076, elbow_r=0.058, wrist_r=0.046, delt=0.100,
    head=(0.092, 0.112, 0.122), jaw=0.086, chin=0.034, brow=2.4, nose=2.3,
    breasts=0.0, belly=1.0,
)


def arm_axis(P, side):
    """Shoulder, elbow, wrist and knuckle points of one arm in the A-pose, and
    the arm's direction."""
    a = math.radians(P["arm_a"])
    d = V((side * math.sin(a), 0.0, -math.cos(a)))
    s = V(P["shoulder"])
    s.x *= side
    e = s + d * P["upper"]
    w = e + d * P["fore"]
    return s, e, w, d


def leg_axis(P, side):
    h, k, a = V(P["hip"]), V(P["knee"]), V(P["ankle"])
    for p in (h, k, a):
        p.x *= side
    return h, k, a


def torso(P):
    """Pelvis to the base of the skull, as one loft. Rounded-box sections
    through the trunk (power 2.6), easing to round at the neck."""
    hw, hf, hb = P["hips"]
    ww, wf, wb = P["waist"]
    cw, cf, cb = P["chest"]
    hz = P["hip"][2]
    sz = P["shoulder"][2]
    nb = P["neck_base"]
    hj = P["head_joint"]
    n = P["neck"]
    belly = P["belly"]
    k = (sz - hz) / (1.445 - 0.955)
    z = lambda m: hz + (m - 0.955) * k            # a man's height, rescaled
    lw = P["lats"]
    rings = [
        (z(0.850) - hz, 0.070, 0.050, 0.060, 0, 0.004, 2.0),
        (z(0.878) - hz, 0.130, 0.084, 0.104, 0, 0.004, 2.2),
        (z(0.915) - hz, hw * 0.97, hf * 0.98, hb, 0, 0.0, 2.3),
        (z(0.965) - hz, hw, hf, hb * 0.96, 0, 0.0, 2.3),
        (z(1.030) - hz, hw * 0.95, hf * 0.98 + belly * 0.02, hb * 0.84, 0, 0.0, 2.3),
        (z(1.100) - hz, ww, wf + belly * 0.03, wb, 0, 0.0, 2.2),
        (z(1.180) - hz, (ww + cw) / 2, (wf + cf) / 2 + belly * 0.015, (wb + cb) / 2, 0, 0.0, 2.2),
        (z(1.265) - hz, cw * 0.98, cf * 0.97, cb, 0, 0.0, 2.3),
        (z(1.340) - hz, lw, cf, cb * 1.02, 0, 0.0, 2.4),
        (z(1.395) - hz, lw * 0.99, cf * 0.94, cb * 1.0, 0, 0.004, 2.4),
        # The shoulder line, then the slope of the trapezius up to the neck.
        (z(1.440) - hz, lw * 0.95, cf * 0.72, cb * 0.86, 0, 0.010, 2.3),
        (z(1.458) - hz, lw * 0.80, cf * 0.60, cb * 0.76, 0, 0.012, 2.2),
        (z(1.474) - hz, lw * 0.64, cf * 0.54, cb * 0.68, 0, 0.012, 2.1),
        (z(1.490) - hz, lw * 0.50, cf * 0.50, cb * 0.62, 0, 0.012, 2.0),
        (nb - hz + 0.030, n * 1.12, n * 0.98, n * 1.12, 0, 0.010, 2.0),
        (nb - hz + 0.065, n, n * 0.96, n * 1.02, 0, 0.004, 2.0),
        (hj - hz + 0.010, n * 0.97, n * 0.95, n * 1.0, 0, 0.004, 2.0),
    ]
    # side=-X so that the ring's "front" depth is at -Y, as it is for a limb.
    return ring_loft((0, 0, hz), (0, 0, 1), rings, sides=28, side=(-1, 0, 0), name="torso")


def breasts(P):
    out = []
    if not P["breasts"]:
        # A man's chest is two broad flat muscles, not a barrel.
        sz = P["shoulder"][2]
        for sx in (-1, 1):
            out.append(ellipsoid((sx * 0.070, -P["chest"][1] + 0.030, sz - 0.100),
                                 (0.070, 0.024, 0.046), name="pec",
                                 rot=(math.radians(-10), 0, sx * math.radians(12))))
        return out
    sz = P["shoulder"][2]
    for sx in (-1, 1):
        out.append(ellipsoid((sx * 0.066, -P["chest"][1] + 0.028, sz - 0.135),
                             (0.058, 0.050, 0.052), name="breast", rot=(math.radians(-8), 0, 0)))
    return out


def shoulders(P):
    """The trapezius and the deltoid: what takes the neck out to the arm.
    Without them a torso loft is a bottle with arms stuck on its sides."""
    out = []
    for sx in (-1, 1):
        s, e, w, d = arm_axis(P, sx)
        # Deltoid: a cap round the top of the arm, fullest just below the
        # joint and tapering into the upper arm.
        r = P["delt"]
        # A rounded cap over the joint, long along the arm: a loft ended in a
        # flat disc here and stood up off the shoulder like a wing.
        at = s + d * 0.075 + V((-sx * 0.006, 0.0, 0.0))
        cap = ellipsoid(tuple(at), (r * 0.84, 0.095, r * 0.86), name="deltoid", seg=20, rings=14)
        _orient(cap, at, d)
        out.append(cap)
    return out


def arm(P, sx):
    s, e, w, d = arm_axis(P, sx)
    ur, er, wr = P["upper_r"], P["elbow_r"], P["wrist_r"]
    up = ring_loft(s, d, [
        (0.00, ur * 1.05, ur, ur),
        (0.08, ur * 1.02, ur * 1.05, ur * 0.98),     # biceps in front
        (0.16, ur * 0.95, ur * 1.02, ur * 0.95),
        (0.24, er * 1.12, er * 1.02, er * 1.1),
        (P["upper"] + 0.01, er * 1.05, er, er * 1.08)], sides=18, name="upperarm")
    fore = ring_loft(e, d, [
        (-0.02, er * 1.05, er, er * 1.05),
        (0.05, er * 1.12, er * 1.08, er * 1.0),     # the forearm swells below the elbow
        (0.13, (er + wr) / 2 * 1.02, (er + wr) / 2 * 0.95, (er + wr) / 2 * 0.95),
        (P["fore"] - 0.01, wr * 1.25, wr * 0.82, wr * 0.82)], sides=16, name="forearm")
    return [up, fore] + hand(P, sx, w, d)


def hand(P, sx, w, d):
    """A relaxed hand: palm, four fingers in a gentle curl, and a thumb set
    forward of them. Seen at three metres a hand is a silhouette, and the
    silhouette of a hand is the gaps between the fingers and the thumb."""
    L = P["hand"]
    # Hand frame: along the arm, across the knuckles (front-to-back of the
    # figure, because the palm faces the thigh), and the palm normal.
    along = d
    across = V((0.0, -1.0, 0.0))                         # thumb side is forward
    palm_n = along.cross(across).normalized() * (-sx)    # palm faces the body
    if palm_n.x * sx > 0:
        palm_n = -palm_n
    parts = []
    k = L / 0.185
    parts.append(ring_loft(w - along * 0.012, along, [
        (0.000, 0.026 * k, 0.017 * k, 0.017 * k),
        (0.030 * k, 0.040 * k, 0.015 * k, 0.015 * k, 0, 0, 2.6),
        (0.075 * k, 0.043 * k, 0.013 * k, 0.012 * k, 0, 0, 2.8),
        (0.098 * k, 0.040 * k, 0.011 * k, 0.010 * k, 0, 0, 2.6)],
        sides=14, side=tuple(across), name="palm"))
    knuckles = w + along * (0.092 * k)
    # Four fingers across the knuckle line, index (forward) to little.
    for (i, (off, length, r)) in enumerate(((0.026, 0.085, 0.0095), (0.009, 0.092, 0.0098),
                                            (-0.009, 0.087, 0.0093), (-0.025, 0.068, 0.0082))):
        base = knuckles + across * (off * k)
        # Curl: each finger bends towards the palm a little more than the one
        # before it, as a hand at rest does.
        curl = math.radians(18 + i * 6)
        seg = []
        p = base
        dirn = along.copy()
        pts = [p]
        for j, frac in enumerate((0.45, 0.32, 0.23)):
            dirn = (dirn * math.cos(curl) + palm_n * math.sin(curl)).normalized()
            p = p + dirn * length * frac * k
            pts.append(p)
        for j in range(3):
            a, b = pts[j], pts[j + 1]
            rr = r * k * (1.0 - j * 0.12)
            parts.append(ring_loft(a - (b - a).normalized() * 0.004, b - a, [
                (0.0, rr, rr, rr), ((b - a).length + 0.004, rr * 0.9, rr * 0.9, rr * 0.9)],
                sides=8, name="finger"))
            parts.append(ellipsoid(tuple(b), (rr * 0.92,) * 3, name="knuckle", seg=8, rings=6))
    # The thumb leaves the palm near the wrist, forward and towards the palm.
    tb = w + along * (0.030 * k) + across * (0.024 * k) + palm_n * (0.006 * k)
    tdir = (along * 0.6 + across * 0.55 + palm_n * 0.45).normalized()
    t1 = tb + tdir * 0.045 * k
    t2dir = (tdir * 0.7 + along * 0.5 + palm_n * 0.2).normalized()
    t2 = t1 + t2dir * 0.032 * k
    parts.append(ring_loft(tb, t1 - tb, [(0.0, 0.015 * k, 0.013 * k, 0.013 * k),
                                        (0.045 * k, 0.011 * k, 0.010 * k, 0.010 * k)],
                           sides=10, name="thumb"))
    parts.append(ring_loft(t1, t2 - t1, [(0.0, 0.0105 * k, 0.0095 * k, 0.0095 * k),
                                        (0.032 * k, 0.0085 * k, 0.008 * k, 0.008 * k)],
                           sides=8, name="thumb"))
    parts.append(ellipsoid(tuple(t2), (0.0085 * k,) * 3, seg=8, rings=6, name="thumbtip"))
    return parts


def leg(P, sx):
    h, k, a = leg_axis(P, sx)
    tr, cr, kr, ar = P["thigh"], P["calf"], P["knee_r"], P["ankle_r"]
    top = h + V((0, 0, 0.04))
    thigh = ring_loft(top, k - top, [
        (0.00, tr * 1.02, tr, tr * 1.05),
        (0.10, tr, tr * 1.02, tr * 1.02),
        (0.22, tr * 0.88, tr * 0.92, tr * 0.86),
        (0.34, kr * 1.22, kr * 1.2, kr * 1.12),
        ((k - top).length, kr * 1.02, kr * 1.05, kr * 1.02)], sides=20, name="thigh")
    shin = ring_loft(k, a - k, [
        (-0.03, kr, kr * 1.02, kr * 0.98),
        (0.04, kr * 0.98, kr * 0.94, kr * 1.02),
        (0.11, cr * 0.95, cr * 0.82, cr * 1.18, 0, -0.004),    # calf behind
        (0.20, cr * 0.82, cr * 0.72, cr * 0.95, 0, -0.004),
        (0.32, ar * 1.18, ar * 1.02, ar * 1.12),
        ((a - k).length + 0.01, ar, ar * 1.02, ar * 1.02)], sides=18, name="shin")
    return [thigh, shin, foot(P, sx, a)]


def foot(P, sx, a):
    k = P["hand"] / 0.185
    # Lofted from the heel forward: a foot is long, and its sole is flat.
    base = V((a.x, a.y + 0.055, 0.0))
    rings = [(0.000, 0.028, 0.030, 0.030, 0, 0.040, 2.0),
             (0.030, 0.034, 0.050, 0.030, 0, 0.042, 2.2),
             (0.085, 0.037, 0.058, 0.025, 0, 0.036, 2.4),
             (0.150, 0.043, 0.036, 0.022, 0, 0.024, 2.6),
             (0.205, 0.045, 0.021, 0.019, 0, 0.018, 2.6),
             (0.245, 0.040, 0.016, 0.016, 0, 0.016, 2.4),
             (0.262, 0.028, 0.012, 0.012, 0, 0.014, 2.0)]
    rings = [(t * k, rx * k, rf * k, rb * k, ox, oy * k, pw) for (t, rx, rf, rb, ox, oy, pw) in rings]
    # Along -Y; "front" of the ring (v) is up here, so rf is the instep.
    obj = ring_loft(base, (0, -1, 0), rings, sides=16, side=(1, 0, 0), name="foot")
    return obj


# --- the head -------------------------------------------------------------

def head_center(P):
    """The eye line, which is the middle of the head from chin to crown."""
    return V((0.0, 0.006, P["crown"] - P["head"][2]))


def _interp(table, z):
    """Piecewise-linear lookup in a table of (z, value) sorted by z."""
    if z <= table[0][0]:
        return table[0][1]
    for (z0, a), (z1, b) in zip(table, table[1:]):
        if z <= z1:
            return a + (b - a) * (z - z0) / (z1 - z0)
    return table[-1][1]


# The head, as a man's, in metres about the eye line, then scaled per person.
# Half-width, depth in front of the axis, depth behind it: the three views a
# sculptor blocks a head in from.
HEAD_W = [(-0.118, 0.010), (-0.112, 0.024), (-0.100, 0.042), (-0.085, 0.055), (-0.060, 0.063),
          (-0.030, 0.071), (0.000, 0.075), (0.030, 0.077), (0.070, 0.071), (0.095, 0.056),
          (0.110, 0.036), (0.118, 0.010)]
HEAD_F = [(-0.118, 0.040), (-0.108, 0.066), (-0.090, 0.079), (-0.068, 0.085), (-0.045, 0.084),
          (-0.020, 0.086), (0.008, 0.088), (0.025, 0.094), (0.050, 0.088), (0.080, 0.074),
          (0.100, 0.055), (0.112, 0.034), (0.118, 0.010)]
HEAD_B = [(-0.118, -0.030), (-0.105, -0.018), (-0.090, 0.004), (-0.070, 0.036), (-0.050, 0.074),
          (-0.020, 0.096), (0.020, 0.104), (0.060, 0.098), (0.090, 0.072), (0.108, 0.044),
          (0.118, 0.010)]
# Nose, on the midline: how far it stands proud of the face, and how wide.
NOSE_OUT = [(-0.062, 0.0), (-0.054, 0.005), (-0.048, 0.013), (-0.040, 0.023), (-0.032, 0.025),
            (-0.024, 0.021),
            (-0.010, 0.015), (0.004, 0.008), (0.014, 0.002), (0.022, 0.0)]
NOSE_W = [(-0.056, 0.012), (-0.046, 0.016), (-0.036, 0.015), (-0.020, 0.010), (0.000, 0.008),
          (0.020, 0.010)]


def head(P):
    """Skull, jaw, brow, cheekbones, nose, lips, ears -- as a stack of
    horizontal sections read off three profiles, with the features laid on as
    displacements, and then fused with the neck.

    The first cut of every face in this project was a ball with marks on it,
    and a review called it featureless every time. At three metres a face is
    not features, it is the planes that hold light and shadow: a forehead
    that faces up, a brow that shades the eyes, cheekbones that step out, a
    nose that throws a shadow down one side, and a jaw that turns under into
    the neck. Those are what is modelled here, a little overstated, as a
    sculptor does for a figure meant to be seen from the street."""
    hw, hd, hh = P["head"]
    sw, sd, sh = hw / 0.077, hd / 0.100, hh / 0.118
    c = head_center(P)
    jaw = P["jaw"] / 0.062
    chin = P["chin"] / 0.025
    brow = P["brow"]
    nose = P["nose"]
    # Not fused with the body. A voxel remesh of the eye sockets comes out as
    # a speckle of tiny folds at any voxel size and any decimation budget --
    # tried at 900, 1400 and 2200 triangles, sym and not -- while the rings
    # themselves are clean quads. So the head keeps its own topology, spent
    # where a face is looked at: columns crowd towards the front, rings
    # towards the band from chin to brow. The neck ends inside it.
    sides = 30
    # Evenly up the face from the chin to the brow, then by latitude over the
    # crown -- even steps in z put two rings on the whole dome and made a cone.
    zs = [-0.118 + (0.030 + 0.118) * i / 17.0 for i in range(18)]
    for i in range(1, 7):
        phi = (math.pi / 2) * i / 7.0
        zs.append(0.030 + (0.118 - 0.030) * math.sin(phi))
    def g(u, s):
        return math.exp(-(u / s) ** 2)

    verts, faces = [], []
    for z in zs:
        W = _interp(HEAD_W, z)
        if z < -0.03:
            W *= 1.0 + (jaw - 1.0) * min(1.0, (-0.03 - z) / 0.06)
        F = _interp(HEAD_F, z)
        B = _interp(HEAD_B, z)
        for i in range(sides):
            u = -1.0 + 2.0 * i / sides
            a = 1.5 * math.pi + math.pi * math.copysign(abs(u) ** 1.45, u)
            ca, sa = math.cos(a), -math.sin(a)          # sa > 0 is the front (-Y)
            if sa > 0:
                # The face is flatter than an ellipse: a rounded-box section.
                e = 2.0 / 2.7
                cu = math.copysign(abs(ca) ** e, ca)
                sv = abs(sa) ** e
                x, y = W * cu, -F * sv
            else:
                # Behind the axis; where B is negative the whole section is in
                # front of it, which is the jaw below the skull.
                x, y = W * ca, -B * sa
            # Features, pushed straight out of the face.
            out = 0.0
            ax = abs(x)
            if sa > 0.2:
                out += 0.007 * brow * g(z - 0.024, 0.009) * g(ax / 0.06, 1.0) * (1.0 if ax < 0.058 else 0.4)
                out -= 0.012 * g(ax - 0.033, 0.016) * g(z - 0.004, 0.010)          # eye socket
                out += 0.005 * g(ax - 0.050, 0.014) * g(z + 0.022, 0.012)          # cheekbone
                out -= 0.004 * g(ax - 0.044, 0.014) * g(z + 0.048, 0.016)          # under the cheekbone
                out += 0.0045 * g(ax / 0.024, 1.0) * g(z + 0.058, 0.006)           # upper lip
                out += 0.0035 * g(ax / 0.020, 1.0) * g(z + 0.075, 0.005)           # lower lip
                out -= 0.0035 * g(ax / 0.024, 1.0) * g(z + 0.0665, 0.0022)         # the mouth
                out += 0.006 * chin * g(ax / 0.020, 1.0) * g(z + 0.098, 0.010)     # chin
                nw = _interp(NOSE_W, z)
                out += nose * _interp(NOSE_OUT, z) * g(ax / nw, 1.0)
                # Nostril wings either side of the tip, kept shallow: a deep
                # one undercuts the tip and remeshes into a black hole.
                out += 0.004 * nose * g(ax - 0.014, 0.007) * g(z + 0.042, 0.007)
                out *= min(1.0, (sa - 0.2) / 0.3)
            y -= out
            verts.append((c.x + x * sw, c.y + y * sd, c.z + z * sh))
    n = sides
    for k in range(len(zs) - 1):
        b = k * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((b + i, b + j, b + j + n, b + i + n))
    faces.append(tuple(range(n - 1, -1, -1)))
    last = (len(zs) - 1) * n
    faces.append(tuple(range(last, last + n)))
    mesh = bpy.data.meshes.new("skull")
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    obj = bpy.data.objects.new("skull", mesh)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, "skin")
    outward(obj)
    parts = [obj]
    # Ears: flat ovals laid against the side of the head behind the jaw, the
    # top level with the brow and the lobe level with the base of the nose,
    # and swept back a little at the top.
    for sx in (-1, 1):
        wz = _interp(HEAD_W, -0.012) * sw
        e = ellipsoid(tuple(c + V((sx * (wz + 0.002), 0.016 * sd, -0.012 * sh))),
                      (0.0075, 0.017 * sd, 0.029 * sh),
                      name="ear", seg=10, rings=7, rot=(math.radians(-14), 0, sx * math.radians(-14)))
        parts.append(e)
    return parts


# --- assembly -------------------------------------------------------------

def body_parts(P):
    parts = [torso(P)] + shoulders(P) + breasts(P)
    for sx in (-1, 1):
        parts += arm(P, sx)
        parts += leg(P, sx)
    return parts


def build_body(P, target=2700):
    parts = body_parts(P)
    neck = P["head_joint"] - 0.02
    # The head and the hands, graded so the membership has no hard edge for
    # the decimation to leave a seam along.
    wrist_z = arm_axis(P, 1)[2].z

    def protect(co):
        return min(1.0, max(0.0, (co.z - neck) / 0.03))
    body = fuse(parts, "body_" + P["name"], voxel=0.0045, smooth=3, smooth_factor=0.5,
                target=target)
    hd_parts = head(P)
    hp = hd_parts + face_parts(P, hd_parts[0])
    for o in hp:
        for poly in o.data.polygons:
            poly.use_smooth = True
    return body, join(hp, "head_" + P["name"])


def _face_y(skull, x, z):
    """Where the face surface is, front-on, at (x, z): a ray in from the front."""
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new()
    bm.from_mesh(skull.data)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    loc, _, _, _ = tree.ray_cast(V((x, -0.5, z)), V((0.0, 1.0, 0.0)), 1.0)
    return loc.y if loc is not None else None


def face_parts(P, skull=None):
    """Eyes and brows. At three metres an eye is four pixels, and what makes
    those four pixels read as a person looking back is a dark iris with a
    glint in it set in a little white -- so the iris is its own glossy
    material, and the white is kept small and a shade off white, because a
    full bright sclera at that size is a doll's stare."""
    hw, hd, hh = P["head"]
    sw, sd, sh = hw / 0.077, hd / 0.100, hh / 0.118
    c = head_center(P)
    out = []
    for sx in (-1, 1):
        # Proud of the socket by a few millimetres: set flush, the white was
        # buried in the face and all that showed in the game was a black bead.
        ex, ez = sx * 0.0325 * sw, c.z + 0.0045 * sh
        # The white stands 2.5 mm proud of the socket floor under it, found by
        # a ray rather than by formula.
        fy = _face_y(skull, ex, ez) if skull else None
        front = (fy if fy is not None else c.y - 0.078 * sd) - 0.0025
        ec = V((ex, front + 0.0108 * sd, ez))
        out.append(ellipsoid(tuple(ec), (0.0126 * sw, 0.0108 * sd, 0.0078 * sh),
                             name="eyeball", mat="eyewhite", seg=10, rings=6))
        out.append(ellipsoid((ex, front + 0.0012, ez - 0.0006), (0.0060 * sw, 0.0022, 0.0062 * sh),
                             name="iris", mat="eye", seg=8, rings=4))
        # The brow: a thin tapering bar along the ridge, in hair.
        inner = c + V((sx * 0.012 * sw, -0.0975 * sd, 0.026 * sh))
        outer = c + V((sx * 0.056 * sw, -0.083 * sd, 0.024 * sh))
        out.append(ring_loft(inner, outer - inner, [
            (0.0, 0.0035, 0.004, 0.002), ((outer - inner).length * 0.45, 0.0045, 0.004, 0.002),
            ((outer - inner).length, 0.002, 0.002, 0.0015)],
            sides=6, side=(0, 0, 1), name="brow", mat="hair"))
    # The nose, as its own solid. On the head's rings it was two columns wide
    # and came out as nothing at all: in the game the face had no nose. A
    # bridge from between the eyes down and out to a rounded tip, and the
    # wings either side of it.
    nk = P["nose"]
    top = c + V((0.0, -hd * 0.88, 0.014 * sh))
    tip = c + V((0.0, -hd * 0.88 - 0.021 * nk, -0.036 * sh))
    d = tip - top
    out.append(ring_loft(top, d, [
        (0.000, 0.0055, 0.0030, 0.006), (d.length * 0.35, 0.0065, 0.0050, 0.007),
        (d.length * 0.75, 0.0095, 0.0075, 0.009), (d.length, 0.0125, 0.0090, 0.011),
        (d.length + 0.006, 0.0085, 0.0045, 0.009)],
        sides=10, side=(1, 0, 0), name="nose", mat="skin"))
    for sx in (-1, 1):
        out.append(ellipsoid(tuple(tip + V((sx * 0.0115 * sw, 0.0065, 0.001))), (0.0068, 0.0072, 0.0060),
                             name="nostril", mat="skin", seg=8, rings=6))
    # A mouth: fuller lips in the skin and a dark line between them, which is
    # the one mark on a face that reads at street distance after the eyes.
    mz = c.z - 0.0665 * sh
    fy = _face_y(skull, 0.0, mz) if skull else None
    my = fy if fy is not None else c.y - hd * 0.86
    # One lip roll above the line and one below, sunk mostly into the face so
    # only their fronts show.
    out.append(ellipsoid((0.0, my + 0.0030, mz + 0.0048), (0.020 * sw, 0.0058, 0.0040),
                         name="lip", mat="skin", seg=12, rings=6))
    out.append(ellipsoid((0.0, my + 0.0036, mz - 0.0050), (0.017 * sw, 0.0058, 0.0042),
                         name="lip", mat="skin", seg=12, rings=6))
    out.append(ring_loft(V((-0.019 * sw, my - 0.0018, mz)), (1, 0, 0), [
        (0.0, 0.0010, 0.0007, 0.0007), (0.019 * sw, 0.0014, 0.0010, 0.0010),
        (0.038 * sw, 0.0010, 0.0007, 0.0007)], sides=4, side=(0, 0, 1), name="mouth", mat="eye"))
    return out


def base(P, target=2700):
    """The body, bound and stood arms-down on its rig. Returns (body, rig)."""
    import rig
    body, hd = build_body(P, target)
    arm = rig.build_armature(P, "rig")
    # Bone heat on the trunk and limbs only. The head is its own set of
    # islands -- skull, ears, eyes, brows -- and heat on a few dozen loose
    # triangles fails outright ("failed to find solution"), leaving hundreds
    # of vertices with no weight at all. The head is rigid anyway.
    rig.bind_heat(arm, body)
    rig.set_rigid(hd, "head")
    body = join([body, hd], "body_" + P["name"])
    rig.arms_down(arm, [body], P)
    if P["name"] == "troll":
        rig.repose(arm, [body], {"hips": (6, 0, 0), "spine": (18, 0, 0), "chest": (24, 0, 0),
                                 "neck": (-20, 0, 0), "head": (-24, 0, 0),
                                 "upperarm.L": (-12, 0, -8), "upperarm.R": (-12, 0, 8),
                                 "forearm.L": (-16, 0, 0), "forearm.R": (-16, 0, 0)})
    return body, arm


# --- looking at it --------------------------------------------------------

def render(path, objs=None, azims=(0, 35, 90, 180), dist=3.2, cz=0.95, lens=50,
           res=(1400, 640), head=False):
    """Several views side by side, rendered with Eevee against a mid grey."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    kit.rake(azim=35, elev=45, strength=3.5, fill=0.5)
    world = scene.world
    import os
    tiles = []
    for i, az in enumerate(azims):
        p = "/tmp/humans-tile-%d.png" % i
        cam_data = bpy.data.cameras.new("cam")
        cam_data.lens = lens
        cam = bpy.data.objects.new("cam", cam_data)
        bpy.context.collection.objects.link(cam)
        a = math.radians(az)
        e = math.radians(4 if not head else 2)
        cam.location = (dist * math.sin(a), -dist * math.cos(a), cz + dist * math.sin(e))
        cam.rotation_euler = (math.pi / 2 - e, 0.0, a)
        scene.camera = cam
        scene.render.resolution_x = res[0] // len(azims)
        scene.render.resolution_y = res[1]
        scene.render.filepath = p
        scene.eevee.taa_render_samples = 16
        bpy.ops.render.render(write_still=True)
        tiles.append(p)
    return tiles


# --- the files ------------------------------------------------------------------

# Which archetypes are built on which body, and so into which file.
FILES = {
    "person_male": (MALE, ["peasant", "guard", "merchant", "smith", "priest", "mage", "rogue",
                           "beggar", "noble", "knight", "zombie", "ghost", "skeleton"]),
    "person_female": (FEMALE, ["woman", "maid", "crone"]),
    "troll": (TROLL, ["troll"]),
}


def build_file(fname):
    """One rig, its archetypes, its head pieces and all its clips, into
    assets/<fname>.glb. Returns report lines and the clip facts."""
    import rig
    import outfits
    importlib.reload(rig)
    importlib.reload(outfits)
    lib.reset()
    P, names = FILES[fname]
    body, arm = base(P)
    meshes = []
    report = []
    for n in names:
        o = outfits.dress(n, body, arm, P)
        meshes.append(o)
        report.append("%-16s %5d tris" % ("arch_" + n if fname != "troll" else "arch_troll",
                                          tri_count(o)))
    kind = {"person_male": "male", "person_female": "female"}.get(fname)
    for fn in (outfits.HEAD_PIECES.get(kind, []) if kind else []):
        o = fn(P)
        o.name = o.data.name = fn.__name__
        rig.bind_groups(arm, o)
        meshes.append(o)
        report.append("%-16s %5d tris" % (fn.__name__, tri_count(o)))
    bpy.data.objects.remove(body, do_unlink=True)
    for o in meshes:
        box_uv(o)
        if o.parent is None:
            rig.bind_groups(arm, o)
    info = rig.make_all(arm)
    for o in meshes:
        o.data.name = o.name
        o.data.validate()
        # glTF skins carry four influences a vertex; keep the four biggest
        # here, normalised, so what is exported is what was looked at.
        select_mesh(o)
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    lib.export(fname, [arm] + meshes,
               export_animations=True,
               export_animation_mode="ACTIONS",
               export_skins=True,
               export_def_bones=False,
               export_bake_animation=True,
               export_optimize_animation_size=False)
    return report, info


def box_uv(obj):
    """Cube-projected UVs in metres, like lib.uv_project, without the edit
    mode operator: that one's poll fails in a background Blender that has
    just built another module's assets ("context is incorrect"), which is
    exactly how build_all runs this."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        a, b = [(1, 2), (0, 2), (0, 1)][ax]
        for loop in f.loops:
            co = loop.vert.co
            loop[uv].uv = (co[a], co[b])
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def select_mesh(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def build():
    import json
    import os
    out = []
    facts = {}
    for fname in FILES:
        report, info = build_file(fname)
        out += report
        facts[fname] = info
    with open(os.path.join(lib.ROOT, "tools", "blender", "people_clips.json"), "w") as f:
        json.dump(facts, f, indent=1, sort_keys=True)
    return "\n".join(out)
