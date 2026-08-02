"""trees -- tree_oak, tree_pine, bush, grass_tuft.

The oak is grown recursively: a trunk that forks into limbs, limbs that fork
into boughs, boughs that fork into twigs, and leaf masses hung on the ends of
the twigs. That is more expensive than a sphere on a stick, and it is the only
way the silhouette gets the gaps in it that make a tree read as a tree -- a
solid blob reads as broccoli at any distance.

The leaf masses themselves are squashed spheres, and unapologetically: what has
to be real is the branching, because that is what you see against the sky.
"""

import math
import random
import importlib

import mathutils

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)


def segment(p0, direction, length, r0, r1, verts=6, mat="bark", name="branch"):
    """A tapered cone from p0 running `length` along `direction`."""
    d = mathutils.Vector(direction).normalized()
    mid = mathutils.Vector(p0) + d * (length / 2)
    rot = d.to_track_quat("Z", "Y").to_euler()
    return lib.cone(r0, r1, length, tuple(mid), tuple(rot), verts=verts, name=name, mat=mat)


def leafmass(p, radius, rng, mat="leaves"):
    obj = lib.sphere(radius, tuple(p), segments=7, rings=4, name="leaves", mat=mat)
    obj.scale = (1.0 + rng.uniform(-0.2, 0.25), 1.0 + rng.uniform(-0.2, 0.25),
                 0.62 + rng.uniform(-0.1, 0.14))
    obj.rotation_euler = (0, 0, rng.uniform(0, 3.14))
    lib.apply_modifiers(obj)
    lib.shade_smooth(obj)
    return obj


def grow(objs, p, direction, length, radius, depth, rng, leaf_r=1.15):
    """One branch, then the two or three that come off it."""
    d = mathutils.Vector(direction).normalized()
    tip_r = radius * 0.68
    objs.append(segment(p, d, length, radius, tip_r,
                        verts=6 if depth < 2 else 5))
    tip = mathutils.Vector(p) + d * length
    if depth <= 0:
        # Scatter the mass off the twig tip. Hang every one of them exactly on
        # its tip and, because the tips all finish at about the same height,
        # the canopy comes out as a flat lid instead of a volume.
        jitter = mathutils.Vector((rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4),
                                   rng.uniform(-0.7, 0.35)))
        objs.append(leafmass(tip + d * leaf_r * 0.4 + jitter, leaf_r, rng))
        return
    for _ in range(2 if depth == 1 else 3):
        # Lean away from the parent, and keep a strong upward bias. Give the
        # sideways term as much weight as the parent direction and every
        # generation flattens a little further out, which after three of them
        # is a parasol, not an oak.
        axis = mathutils.Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)).normalized()
        nd = (d * (1.0 + rng.uniform(-0.08, 0.08))
              + axis * rng.uniform(0.3, 0.62)
              + mathutils.Vector((0, 0, rng.uniform(0.42, 0.8))))
        grow(objs, tip, nd, length * rng.uniform(0.52, 0.92), tip_r * 0.82,
             depth - 1, rng, leaf_r * 0.84)


def build_tree_oak():
    """About 8 m: trunk to the first fork at 2.6, canopy from 4 to 8."""
    lib.reset()
    rng = random.Random(70012)
    objs = []
    trunk_h, r = 3.0, 0.36
    objs.append(segment((0, 0, 0), (0, 0, 1), trunk_h, r * 1.24, r * 0.86, verts=9,
                        name="trunk"))
    # Root flare: four buttresses so the trunk grows out of the ground.
    for i in range(4):
        a = 2 * math.pi * (i + 0.25) / 4
        objs.append(segment((math.cos(a) * 0.3, math.sin(a) * 0.3, 0.0),
                            (math.cos(a) * 0.35, math.sin(a) * 0.35, 1.0), 0.8,
                            0.17, 0.05, verts=5, name="root"))
    for i in range(3):
        a = 2 * math.pi * (i + rng.uniform(-0.12, 0.12)) / 3
        d = (math.cos(a) * 0.46, math.sin(a) * 0.46, 1.0)
        grow(objs, (0, 0, trunk_h), d, 2.35, r * 0.82, 2, rng, leaf_r=1.52)
    return kit.deliver(objs, "tree_oak")


def build_tree_pine():
    """About 9 m and narrow: a straight leader with five whorls hung off it."""
    lib.reset()
    rng = random.Random(70013)
    objs = []
    H = 9.0
    objs.append(segment((0, 0, 0), (0, 0, 1), H * 0.92, 0.3, 0.06, verts=8, name="trunk"))
    whorls = 5
    for w in range(whorls):
        t = w / float(whorls)
        z = 1.5 + (H - 3.0) * t
        reach = 2.5 * (1.0 - t) + 0.55
        n = 6 if w < 3 else 5
        for i in range(n):
            a = 2 * math.pi * (i + rng.uniform(-0.15, 0.15)) / n + w * 0.5
            d = (math.cos(a), math.sin(a), -0.34 + t * 0.2)
            objs.append(segment((0, 0, z), d, reach, 0.075, 0.02, verts=4, name="limb"))
            tip = (math.cos(a) * reach * 0.55, math.sin(a) * reach * 0.55,
                   z + (-0.34 + t * 0.2) * reach * 0.55)
            objs.append(lib.cone(reach * 0.44, 0.0, reach * 0.5,
                                 (tip[0], tip[1], tip[2] + reach * 0.16),
                                 verts=7, name="needles", mat="leaves"))
    objs.append(lib.cone(0.5, 0.0, 1.9, (0, 0, H - 0.7), verts=8, name="spire", mat="leaves"))
    return kit.deliver(objs, "tree_pine")


def build_bush():
    lib.reset()
    rng = random.Random(70014)
    objs = []
    for i in range(5):
        a = 2 * math.pi * i / 5
        objs.append(segment((math.cos(a) * 0.06, math.sin(a) * 0.06, 0),
                            (math.cos(a) * 0.42, math.sin(a) * 0.42, 1.0),
                            0.72, 0.055, 0.02, verts=4, name="stem"))
    for i in range(5):
        a = 2 * math.pi * (i + 0.4) / 5
        objs.append(leafmass((math.cos(a) * 0.42, math.sin(a) * 0.42,
                              0.72 + rng.uniform(-0.1, 0.16)),
                             0.46 + rng.uniform(-0.06, 0.1), rng))
    objs.append(leafmass((0, 0, 0.98), 0.5, rng))
    return kit.deliver(objs, "bush")


def build_grass_tuft():
    """Blades, not billboards: eight tapered strips leaning out of one clump.
    Sixteen triangles a blade, because these get scattered by the hundred."""
    lib.reset()
    rng = random.Random(70015)
    objs = []
    for i in range(9):
        a = 2 * math.pi * i / 9 + rng.uniform(-0.25, 0.25)
        h = rng.uniform(0.22, 0.42)
        lean = rng.uniform(0.25, 0.55)
        pts = []
        for k in range(3):
            f = k / 2.0
            w = 0.035 * (1.0 - f * 0.92)
            pts.append((math.cos(a) * lean * f * h * 2.2, math.sin(a) * lean * f * h * 2.2,
                        h * f, w))
        verts, faces = [], []
        for (px, py, pz, w) in pts:
            verts.append((px - math.sin(a) * w, py + math.cos(a) * w, pz))
            verts.append((px + math.sin(a) * w, py - math.cos(a) * w, pz))
        for k in range(len(pts) - 1):
            faces.append((k * 2, k * 2 + 1, k * 2 + 3, k * 2 + 2))
        mesh = lib.bpy.data.meshes.new("blade")
        mesh.from_pydata(verts, [], faces)
        mesh.validate()
        mesh.update()
        obj = lib.bpy.data.objects.new("blade", mesh)
        lib.bpy.context.collection.objects.link(obj)
        lib.assign(obj, "grass")
        lib.solidify(obj, 0.006)
        objs.append(obj)
    return kit.deliver(objs, "grass_tuft")


ASSETS = [build_tree_oak, build_tree_pine, build_bush, build_grass_tuft]


def build():
    return "\n".join(fn() for fn in ASSETS)
