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
    arm_a=22.0, arm_drop=0.030, upper=0.292, fore=0.252, hand=0.185,
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
    arm_drop=0.026, upper=0.272, fore=0.232, hand=0.170,
    hips=(0.176, 0.100, 0.125), waist=(0.122, 0.082, 0.080), chest=(0.146, 0.104, 0.090),
    lats=0.140, neck=0.047, thigh=0.086, calf=0.055, knee_r=0.045, ankle_r=0.030,
    upper_r=0.043, elbow_r=0.033, wrist_r=0.025, delt=0.050,
    head=(0.072, 0.095, 0.110), jaw=0.054, chin=0.019, brow=0.4, nose=0.8,
    breasts=1.0,
)


# A troll: a head taller than a man before it is scaled, and twice his mass:
# a hump of muscle over the shoulders that the head sinks into, a barrel of a
# chest over a belly, arms that reach its knees and swell at the forearm,
# hands and feet half as big again with claws on them, short thick legs. The
# rig is the same bones with the same names, so every clip plays on it; the
# hunch is in the rest pose (see `base`). The old one had the canon's girths
# a fifth up and read, under a judge's eye, as a lanky man in a loincloth.
TROLL = dict(
    MALE, name="troll",
    hip=(0.135, 0.0, 0.840), knee=(0.150, -0.030, 0.460), ankle=(0.160, 0.012, 0.100),
    shoulder=(0.280, 0.030, 1.480), neck_base=1.520, head_joint=1.630, crown=1.910,
    arm_a=28.0, arm_drop=0.040, upper=0.420, fore=0.400, hand=0.300,
    hips=(0.225, 0.160, 0.165), waist=(0.255, 0.215, 0.150), chest=(0.290, 0.200, 0.190),
    lats=0.320, neck=0.118, thigh=0.150, calf=0.118, knee_r=0.088, ankle_r=0.064,
    upper_r=0.102, elbow_r=0.078, wrist_r=0.064, delt=0.135,
    head=(0.114, 0.136, 0.146), jaw=0.086, chin=0.034, brow=2.4, nose=2.3,
    breasts=0.0, belly=1.6, troll=True,
)


# A minotaur: a man's joints, a bull's girth and neck, a bull's head (bull.py).
import bull as _bull
MINOTAUR = _bull.body(MALE)


def troll_bulk(P):
    """What a troll carries that the canon has no station for: the hump of
    trapezius the head sinks into, a belly slung in front, the swell of the
    forearms, knuckles like walnuts. Plain ellipsoids, fused into the skin
    with everything else."""
    out = []
    sz = P["shoulder"][2]
    cw, cf, cb = P["chest"]
    out.append(ellipsoid((0.0, cb * 0.55, sz + 0.035), (0.22, 0.15, 0.13), name="hump",
                         rot=(math.radians(-18), 0, 0)))
    out.append(ellipsoid((0.0, cb * 0.2, sz - 0.03), (0.3, 0.13, 0.1), name="traps"))
    hz = P["hip"][2]
    out.append(ellipsoid((0.0, -P["waist"][1] * 0.55, hz + 0.25), (0.22, 0.15, 0.2), name="belly"))
    for sx in (-1, 1):
        s, e, w, d = arm_axis(P, sx)
        at = e + d * 0.13
        fa = ellipsoid(tuple(at), (0.085, 0.16, 0.08), name="forearm_bulk", seg=18, rings=12)
        _orient(fa, at, d)
        out.append(fa)
        at = s + d * 0.17
        bi = ellipsoid(tuple(at + V((0, -0.02, 0))), (0.092, 0.15, 0.09), name="biceps", seg=18, rings=12)
        _orient(bi, at, d)
        out.append(bi)
        # The pecs of a thing that climbs: broad slabs over the ribs.
        out.append(ellipsoid((sx * 0.11, -cf + 0.05, sz - 0.14), (0.12, 0.05, 0.08), name="pec",
                             rot=(math.radians(-12), 0, sx * math.radians(14))))
        h, kn, a = leg_axis(P, sx)
        th = ellipsoid(tuple(h.lerp(kn, 0.35) + V((sx * 0.02, -0.02, 0))), (0.13, 0.13, 0.2), name="quad")
        out.append(th)
        cf_ = ellipsoid(tuple(kn.lerp(a, 0.3) + V((0, 0.035, 0))), (0.085, 0.085, 0.12), name="calf")
        out.append(cf_)
    return out


def arm_axis(P, side):
    """Shoulder, elbow, wrist and knuckle points of one arm in the A-pose, and
    the arm's direction."""
    a = math.radians(P["arm_a"])
    d = V((side * math.sin(a), 0.0, -math.cos(a)))
    s = V(P["shoulder"])
    s.x *= side
    # The joint sits a hand's breadth of deltoid below the top of the
    # shoulder: at the shoulder line itself, the cap stood five centimetres
    # proud of the base of the neck and every man shrugged.
    s.z -= P["arm_drop"]
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
        # The neck leans back up into the skull: its front, the throat,
        # is well behind the chin, and the head's own neck ends inside it.
        (nb - hz + 0.065, n, n * 0.92, n * 1.0, 0, -0.004, 2.0),
        (hj - hz + 0.010, n * 0.96, n * 0.88, n * 0.98, 0, -0.012, 2.0),
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
        at = s + d * 0.055 + V((-sx * 0.010, 0.0, 0.0))
        cap = ellipsoid(tuple(at), (r * 0.92, 0.090, r * 0.94), name="deltoid", seg=20, rings=14)
        _orient(cap, at, d)
        out.append(cap)
    return out


def arm(P, sx):
    s, e, w, d = arm_axis(P, sx)
    ur, er, wr = P["upper_r"], P["elbow_r"], P["wrist_r"]
    # The top of the arm closes in a dome that runs up under the deltoid and
    # into the slope of the shoulder. It used to end in a flat cap at the
    # joint, and the rim of that cap stood out of the fused skin as a lip --
    # the square, padded shoulder every tunic cut from this body wore.
    up = ring_loft(s, d, [
        (-0.050, ur * 0.25, ur * 0.25, ur * 0.25),
        (-0.040, ur * 0.62, ur * 0.60, ur * 0.60),
        (-0.024, ur * 0.88, ur * 0.85, ur * 0.85),
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
        # Half closed, as a hand at rest is -- and round enough that a
        # hilt in it looks held, which a flat hand never did.
        curl = math.radians(34 + i * 7)
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
        if P.get("troll"):
            parts.append(claw(P, pts[-1], (pts[-1] - pts[-2]).normalized(), palm_n, r * k))
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
    if P.get("troll"):
        parts.append(claw(P, t2, t2dir, palm_n, 0.0085 * k))
    return parts


# Claws, per body: where each one runs, so the skin fused over them can be
# painted as horn afterwards. Reset by `body_parts`.
CLAWS = []


def claw(P, tip, along, curl, r):
    """A hooked claw off the end of a digit: a cone that bends towards the
    palm (or the ground), as long as the last joint."""
    along = V(along).normalized()
    curl = V(curl).normalized()
    a = V(tip) - along * r * 0.4
    mid = a + along * r * 2.0 + curl * r * 0.35
    end = mid + (along * 0.6 + curl * 0.8).normalized() * r * 1.6
    CLAWS.append((a, mid, end, r))
    one = ring_loft(a, mid - a, [(0.0, r * 0.95, r * 0.8, r * 0.9), ((mid - a).length, r * 0.7, r * 0.55, r * 0.6)],
                    sides=8, name="claw")
    two = ring_loft(mid, end - mid, [(-0.002, r * 0.7, r * 0.55, r * 0.6), ((end - mid).length, r * 0.12, r * 0.1, r * 0.1)],
                    sides=8, name="claw")
    return join([one, two], "claw")


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
    if not P.get("troll"):
        return obj
    # Four splayed toes over the front of the sole, each ending in a claw
    # that bites into the ground.
    out = [obj]
    for i, off in enumerate((-0.030, -0.010, 0.010, 0.029)):
        rt = (0.0125 - 0.0015 * abs(i - 1.2)) * k
        at = V((a.x + sx * off * k, base.y - 0.236 * k, 0.017 * k))
        toe = ellipsoid(tuple(at), (rt, rt * 1.7, rt * 0.95), name="toe", seg=10, rings=8)
        out.append(toe)
        c = claw(P, at + V((0, -rt * 1.4, 0)), (0, -1, -0.35), (0, 0, -1), rt * 0.75)
        # The hook goes down to the ground and no further: modelled to bite
        # into it, the tips stood 3.6 cm under the sole, and a troll scaled
        # to 1.3-1.55 stood 4-6 cm into every floor it was put on.
        low = min((c.matrix_world @ v.co).z for v in c.data.vertices)
        for v in c.data.vertices:
            v.co.z += 0.002 - low
        out.append(c)
    return join(out, "foot")


# --- the head -------------------------------------------------------------
#
# The head is heads.py's: a signed distance field per face, meshed, rigged by
# vertex group on the head, jaw, nose and eye bones. Each file carries the
# faces of its body (young and old), as separate objects the viewer chooses
# between, like the hair.

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


_SKULLS = {}


def head(P):
    """The bare skull of this body's face, no ears, no eyes: what hair, hoods
    and caps are grown from and fitted to. Built once per body and copied:
    a dozen head pieces each meshing their own took most of a minute."""
    import heads
    key = P["name"]
    if key not in _SKULLS or _SKULLS[key].users == 0:
        skull, _, _ = heads.build(heads.spec_for(P), P, "skull", ears=False)
        _SKULLS[key] = skull.data.copy()
        _SKULLS[key].use_fake_user = True
        bpy.data.objects.remove(skull, do_unlink=True)
    me = _SKULLS[key].copy()
    obj = bpy.data.objects.new("skull", me)
    bpy.context.collection.objects.link(obj)
    return [obj]


def faces(P):
    if P.get("bull"):
        importlib.reload(_bull)
        return [_bull.face(P)]
    import heads
    importlib.reload(heads)
    return [heads.face(S, P, name) for (name, S) in heads.FACES[P["name"]]]


# --- assembly -------------------------------------------------------------

def body_parts(P):
    CLAWS.clear()
    parts = [torso(P)] + shoulders(P) + (troll_bulk(P) if P.get("troll") else breasts(P))
    if P.get("bull"):
        parts += _bull.bulk(P, ellipsoid)
    for sx in (-1, 1):
        parts += arm(P, sx)
        parts += leg(P, sx)
    return parts


def build_body(P, target=2700):
    parts = body_parts(P)
    if not P.get("troll"):
        return fuse(parts, "body_" + P["name"], voxel=0.0045, smooth=3, smooth_factor=0.5,
                    target=target)
    body = fuse(parts, "body_" + P["name"], voxel=0.0045, smooth=3, smooth_factor=0.5,
                target=4400, mat="warthide")
    drop_islands(body)
    hide_colours(body, P)
    return body


def drop_islands(obj, keep=200):
    """Delete loose bits the remesh broke off -- the point of a claw finer
    than a voxel comes away as a speck -- which bone heat cannot weight."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen = set()
    doomed = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack, island = [v], []
        seen.add(v.index)
        while stack:
            x = stack.pop()
            island.append(x)
            for e in x.link_edges:
                o = e.other_vert(x)
                if o.index not in seen:
                    seen.add(o.index)
                    stack.append(o)
        if len(island) < keep:
            doomed += island
    if doomed:
        bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()
    return len(doomed)


def hide_colours(body, P):
    """A troll's hide in vertex colour, which the per-mobile skin tint
    multiplies: darker over the back and the tops of the arms, paler down
    the belly and the insides of the limbs, blotched all over, and the claws
    horn. Painted in the A-pose the body is fused in, so it rides with the
    skin through every repose after."""
    import numpy as np
    import heads
    me = body.data
    co = np.array([v.co[:] for v in me.vertices])
    n = np.array([v.normal[:] for v in me.vertices])
    rng = np.random.default_rng(83)
    lat = rng.random((24, 24, 24))

    def noise(p, cell):
        q = p / cell
        i = np.floor(q).astype(int)
        f = q - i
        f = f * f * (3 - 2 * f)
        out = 0.0
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    w = ((f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1])
                         * (f[:, 2] if dz else 1 - f[:, 2]))
                    out = out + w * lat[(i[:, 0] + dx) % 24, (i[:, 1] + dy) % 24, (i[:, 2] + dz) % 24]
        return out
    blotch = noise(co, 0.11) * 0.65 + noise(co + 3.1, 0.035) * 0.35
    back = np.clip(n[:, 1] * 0.8 + n[:, 2] * 0.35, 0, 1)          # facing back and up
    belly = np.clip(-n[:, 1] * 0.9, 0, 1) * np.clip((P["shoulder"][2] - 0.1 - co[:, 2]) / 0.3, 0, 1) \
        * np.clip((co[:, 2] - P["hip"][2] + 0.05) / 0.2, 0, 1) * (np.abs(co[:, 0]) < 0.2)
    k = 0.97 + 0.2 * (blotch - 0.5) - 0.13 * back + 0.1 * belly
    col = np.stack([k * 1.0, k * 1.0, k * 0.96], 1)
    horn = np.array([0.34, 0.28, 0.2])
    for (a, mid, end, r) in CLAWS:
        for (p0, p1) in ((a, mid), (mid, end)):
            p0, p1 = np.array(p0[:]), np.array(p1[:])
            d = p1 - p0
            t = np.clip(((co - p0) @ d) / (d @ d), 0, 1)
            dist = np.linalg.norm(co - (p0 + t[:, None] * d), axis=1)
            near = np.clip((r * 1.25 - dist) / (r * 0.4), 0, 1) * np.clip((t + 0.2) / 0.4, 0, 1)
            col = col * (1 - near[:, None]) + horn[None, :] * near[:, None]
    heads.set_colors(body, np.clip(col, 0, 1))


def base(P, target=2700):
    """The body, bound and stood arms-down on its rig, and the faces that go
    on it. Returns (body, rig, faces)."""
    import rig
    body = build_body(P, target)
    arm = rig.build_armature(P, "rig")
    rig.bind_heat(arm, body)
    rig.deform_face(arm)
    # The faces are rigged by vertex group, and go through the arms-down and
    # the troll's hunch with the body, so they sit on the head of the rest
    # pose the clips are written against.
    fs = faces(P)
    for f in fs:
        rig.bind_groups(arm, f)
    rig.arms_down(arm, [body] + fs, P)
    if P["name"] == "troll":
        # The hunch has to read from the front too, where a bent back does
        # not show: so the shoulders come up and forward round the head,
        # which sinks between them.
        # The hips tip forward and the legs hang from them, so the thighs
        # take the tilt back out: pitched with the hips, the feet stood on
        # their toes, 3 cm down through the floor, in every clip.
        rig.repose(arm, [body] + fs, {"hips": (6, 0, 0), "thigh.L": (-6, 0, 0), "thigh.R": (-6, 0, 0),
                                      "skirt.L": (-6, 0, 0), "skirt.R": (-6, 0, 0),
                                      "spine": (18, 0, 0), "chest": (24, 0, 0),
                                      "neck": (-14, 0, 0), "head": (-30, 0, 0),
                                      "shoulder.L": (10, 0, 9), "shoulder.R": (10, 0, -9),
                                      "upperarm.L": (-12, 0, -8), "upperarm.R": (-12, 0, 8),
                                      "forearm.L": (-16, 0, 0), "forearm.R": (-16, 0, 0)})
    return body, arm, fs


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
                           "beggar", "noble", "knight", "zombie", "ghost", "skeleton", "nomad"]),
    "person_female": (FEMALE, ["woman", "maid", "crone", "lady", "guard", "priest", "mage", "rogue"]),
    "troll": (TROLL, ["troll", "brute"]),
    # Every minotaur in the stock areas is dressed for a trade: guards in
    # furs over armour, knights in plate, the masters in robes or leather.
    "minotaur": (MINOTAUR, ["guard", "knight", "mage", "priest", "rogue", "beggar", "noble"]),
}


def build_file(fname):
    """One rig, its archetypes, its head pieces and all its clips, into
    assets/<fname>.glb. Returns report lines and the clip facts."""
    import rig
    import outfits
    import heads
    importlib.reload(rig)
    importlib.reload(outfits)
    lib.reset()
    _SKULLS.clear()
    P, names = FILES[fname]
    body, arm, fs = base(P)
    meshes = []
    report = []
    for n in names:
        o = outfits.dress(n, body, arm, P)
        meshes.append(o)
        report.append("%-16s %5d tris" % ("arch_" + n if fname != "troll" else "arch_troll",
                                          tri_count(o)))
    if P.get("troll"):
        # The body carries its hide colours; what was joined onto it from a
        # piece that had none came in black, and is put back to white.
        for o in meshes:
            hide = o.data.materials.find("MAT:warthide")
            col = o.data.color_attributes.get("Col")
            if col is None:
                continue
            for pl in o.data.polygons:
                if pl.material_index != hide:
                    for vi in pl.vertices:
                        col.data[vi].color = (1.0, 1.0, 1.0, 1.0)
    for f in fs:
        meshes.append(f)
        report.append("%-16s %5d tris" % (f.name, tri_count(f)))
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
    info = rig.make_all(arm, P=P, extra=_bull.CLIPS if P.get("bull") else ())
    for o in meshes:
        o.data.name = o.name
        o.data.validate()
        # glTF skins carry four influences a vertex; keep the four biggest
        # here, normalised, so what is exported is what was looked at.
        select_mesh(o)
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
        # Every mesh carries a colour: the viewer's materials multiply by it,
        # and a mesh without one would read as black.
        heads.white(o)
        # Written as a custom attribute, not as COLOR_0. The exporter's own
        # vertex colour gives the real values to the first material of a mesh
        # only and fills every other primitive with white -- the eyes of every
        # face came out white-on-white that way (Blender 5.2,
        # primitive_extract.py compares a colour's name against its glTF
        # slot). assets.js hands `_col` back to three as `color`.
        o.data.color_attributes["Col"].name = "_col"
    meshes += [lod(o) for o in meshes]
    lib.export(fname, [arm] + meshes,
               export_vertex_color="NONE",
               export_attributes=True,
               export_animations=True,
               export_animation_mode="ACTIONS",
               export_skins=True,
               export_def_bones=False,
               export_bake_animation=True,
               export_optimize_animation_size=False)
    return report, info


def lod(o, share=0.28, floor=160):
    """A far copy of a mesh, `lod_<name>`: decimated to about a quarter,
    weights and colours carried through the collapse. Past fifteen metres a
    person is a figure of forty pixels, and a face's three and a half
    thousand triangles are spent on nothing the eye can find there."""
    c = o.copy()
    c.data = o.data.copy()
    c.name = c.data.name = "lod_" + o.name
    bpy.context.collection.objects.link(c)
    c.data.calc_loop_triangles()
    n = len(c.data.loop_triangles)
    dm = c.modifiers.new("lod", "DECIMATE")
    dm.ratio = min(1.0, max(floor / max(1, n), share))
    dm.use_collapse_triangulate = True
    select_mesh(c)
    bpy.ops.object.modifier_move_to_index(modifier="lod", index=0)
    bpy.ops.object.modifier_apply(modifier="lod")
    c.data.validate()
    bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
    return c


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


def build(only=None):
    import json
    import os
    out = []
    path = os.path.join(lib.ROOT, "tools", "blender", "people_clips.json")
    # Built one file at a time, the facts of the others are kept as they were.
    facts = json.load(open(path)) if only else {}
    for fname in FILES:
        if only and fname not in only:
            continue
        report, info = build_file(fname)
        out += report
        facts[fname] = info
    with open(path, "w") as f:
        json.dump(facts, f, indent=1, sort_keys=True)
    return "\n".join(out)
