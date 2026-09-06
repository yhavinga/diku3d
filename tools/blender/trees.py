"""trees -- everything that grows, plus the one rock that has something growing
on it: tree_oak, tree_pine, tree_fir, tree_snag, bush, salal_bush, fern,
moss_rock, grass_tuft.

The oak is grown recursively: a trunk that forks into limbs, limbs that fork
into boughs, boughs that fork into twigs, and leaf masses hung on the ends of
the twigs. That is more expensive than a sphere on a stick, and it is the only
way the silhouette gets the gaps in it that make a tree read as a tree -- a
solid blob reads as broccoli at any distance.

The leaf masses themselves are squashed spheres, and unapologetically: what has
to be real is the branching, because that is what you see against the sky.

The Pacific-Northwest half of the module is built out of two shared shapes
instead: `blade`, a tapered strip lofted along its own length and bent in its
own frame, which does a conifer's needle spray, a fern frond and a salal leaf;
and `hull`, rings skinned into one closed solid, which does a snapped-off spar
and a boulder. Both are closed volumes on purpose -- the viewer's baked
materials are single-sided, so a leaf modelled as a plane disappears the moment
you walk round it.
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


def leafmass(p, radius, rng, mat="leaves", flat=0.62):
    obj = lib.sphere(radius, tuple(p), segments=7, rings=4, name="leaves", mat=mat)
    obj.scale = (1.0 + rng.uniform(-0.2, 0.25), 1.0 + rng.uniform(-0.2, 0.25),
                 flat + rng.uniform(-0.1, 0.14))
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


# --- the wet coast --------------------------------------------------------

# Half-width along a blade, as a fraction of the widest point. _SPRAY has its
# belly a third of the way out and tapers from there, which is a conifer's
# branch; _FROND holds its width from a third to two thirds before it comes to
# a point, which is a leaf. The difference is not subtle at a metre: taper a
# frond from its base and the fern comes out an agave.
_SPRAY = ((0.00, 0.22), (0.34, 1.00), (0.72, 0.80), (1.00, 0.07))
_FROND = ((0.00, 0.16), (0.30, 0.92), (0.68, 1.00), (1.00, 0.09))


def blade(origin, azim, pitch, length, width, thick, curl, sides=4,
          mat="leaves", name="blade", profile=_SPRAY):
    """A tapered strip lofted along its own length and bent in its own frame.

    One shape does a conifer's needle spray, a fern frond and a salal leaf;
    what separates them is how steeply it leaves the crown (`pitch`) and how
    far the tip ends up from straight (`curl`, in the blade's own axes, so a
    negative one falls). Bending the profile rather than tilting the whole part
    is the point: a branch that is only rotated is a spike, and nothing in a
    photograph of a rain forest is straight.

    Twenty triangles at sides=3, twenty-eight at 4, which is what makes it
    affordable to hang fifty of them on one tree."""
    sec = [(length * s, width * f, thick * f, 0.0, curl * s * s) for (s, f) in profile]
    obj = lib.loft(sec, sides=sides, axis="y", name=name, mat=mat)
    obj.rotation_euler = (pitch, 0.0, azim)
    obj.location = tuple(origin)
    return obj


def hull(rings, sides, wob=None, jag=None, jag_at=-1, mat="rock", name="hull"):
    """Rings of (z, radius, cx, cy) skinned into one closed solid.

    `wob` is a per-angle radius multiplier. Sharing one between two shells is
    what lets a moss cap lie parallel to the boulder underneath it rather than
    cutting through it at four places. `jag` is the same trick for height, on
    the ring at `jag_at`: a ragged hem for the moss, and for the snag a top
    that was snapped rather than sawn.

    Rings must run upwards. Listing them downwards turns every normal inward,
    and a rock lit from the inside looks exactly like a hole in the ground."""
    verts, faces = [], []
    n = len(rings)
    jag_k = (n + jag_at) % n if jag else -1
    for k, (z, r, cx, cy) in enumerate(rings):
        for i in range(sides):
            a = 2 * math.pi * i / sides
            rr = r * (1.0 + (wob[i] if wob else 0.0))
            dz = jag[i] if k == jag_k else 0.0
            verts.append((cx + rr * math.cos(a), cy + rr * math.sin(a), z + dz))
    for k in range(n - 1):
        base = k * sides
        for i in range(sides):
            j = (i + 1) % sides
            faces.append((base + i, base + j, base + j + sides, base + i + sides))
    faces.append(tuple(range(sides - 1, -1, -1)))
    faces.append(tuple(range(len(verts) - sides, len(verts))))
    mesh = lib.bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = lib.bpy.data.objects.new(name, mesh)
    lib.bpy.context.collection.objects.link(obj)
    return lib.assign(obj, mat)


def build_tree_fir():
    """A Douglas-fir, 16 m to the nodding tip.

    Set it against tree_pine and the species is the proportion: the pine is 9 m
    and two thirds as wide as it is tall, this is a third, which is the shape
    of a tree that grew in a forest. Eleven close tiers rather than five widely
    spaced ones, so the crown overlaps itself and reads dark instead of reading
    as separate branches with sky between them; a bare lower trunk with dead
    stubs on it; and a leader that nods over at the top, which is a hemlock's
    signature and the cheapest thing here that says which coast this is."""
    lib.reset()
    rng = random.Random(70016)
    objs = []
    trunk_h = 14.6
    objs.append(segment((0, 0, 0), (0, 0, 1), trunk_h, 0.44, 0.09, verts=8, name="trunk"))
    for i in range(4):
        a = 2 * math.pi * (i + 0.3) / 4
        objs.append(segment((math.cos(a) * 0.26, math.sin(a) * 0.26, 0.0),
                            (math.cos(a) * 0.4, math.sin(a) * 0.4, 1.0), 1.1,
                            0.16, 0.04, verts=4, name="root"))
    # Dead stubs under the first live tier. A fir in the woods loses its lower
    # limbs and keeps the sockets, and that bare storey is most of why the
    # silhouette is a spar with a crown on it rather than a cone on the ground.
    for i in range(3):
        a = 2.1 * i + 0.6
        objs.append(segment((0, 0, 1.5 + 0.8 * i), (math.cos(a), math.sin(a), -0.35),
                            0.5 + 0.12 * (i % 2), 0.07, 0.015, verts=4, name="stub"))
    tiers = 11
    for w in range(tiers):
        t = w / (tiers - 1.0)
        z = 2.9 + 11.2 * t + rng.uniform(-0.14, 0.14)
        reach = 2.2 * (1.0 - t) ** 0.75 + 0.40
        # The mass of the crown, not the sprays. Six blades on a stick is a
        # bottlebrush -- what makes a fir dark is that you cannot see through
        # it, so each tier gets a needle cone tall enough to close the gap to
        # the tier above, and the sprays are only the ragged edge on it.
        cone_h = reach * 1.05 + 0.75
        objs.append(lib.cone(reach * 0.60, 0.0, cone_h, (0, 0, z - 0.3 + cone_h / 2),
                             verts=7, name="needles", mat="leaves"))
        n = int(round(6.2 - 2.4 * t))
        for i in range(n):
            # A dropped branch here and there. Whorls that are all complete are
            # what makes a conifer read as a lathe-turned Christmas tree.
            if 1 < w < tiers - 2 and rng.random() < 0.11:
                continue
            a = 2 * math.pi * (i + rng.uniform(-0.16, 0.16)) / n + w * 1.13
            L = reach * rng.uniform(0.82, 1.12)
            objs.append(blade((0, 0, z + rng.uniform(-0.1, 0.1)), a, 0.20 + 0.30 * t,
                              L, 0.07 + L * 0.055, 0.04 + L * 0.028,
                              L * (-0.34 + 0.40 * t), sides=3, name="spray"))
    lean = (0.36, 0.14, 1.0)
    objs.append(segment((0, 0, trunk_h - 0.2), lean, 1.6, 0.10, 0.015, verts=6,
                        name="leader"))
    for i in range(3):
        objs.append(blade((0.28, 0.11, trunk_h + 0.45), 2.09 * i + 0.9, 0.30, 0.66,
                          0.13, 0.055, -0.30, sides=3, name="spray"))
    objs.append(blade((0.5, 0.19, trunk_h + 1.15), 0.7, 0.10, 0.5, 0.10, 0.045,
                      -0.22, sides=3, name="spray"))
    return kit.deliver(objs, "tree_fir")


def build_tree_snag():
    """A dead spar, 10 m: bare trunk, six broken limbs, and a top snapped off
    at an angle rather than cut.

    Under two hundred triangles and there is no better value in the library.
    Half the standing trees in a coastal forest are dead ones, and a single
    silver spar against the sky places the whole scene faster than any amount
    of foliage does -- which is why it is worth the trouble of a splintered
    top: a flat one reads as a fencepost."""
    lib.reset()
    rng = random.Random(70017)
    sides = 7
    wob = [rng.uniform(-0.09, 0.09) for _ in range(sides)]
    jag = [rng.uniform(-0.30, 0.46) for _ in range(sides)]
    rings = [(0.00, 0.62, 0.00, 0.00), (0.55, 0.42, 0.02, -0.01),
             (2.60, 0.36, 0.06, 0.02), (5.20, 0.31, 0.11, 0.05),
             (7.80, 0.26, 0.14, 0.03), (9.60, 0.20, 0.18, 0.00)]
    objs = [hull(rings, sides, wob, jag, mat="bark", name="spar")]
    for (z, a, L, r, drop) in ((2.2, 0.4, 1.25, 0.11, -0.25), (3.6, 2.5, 0.80, 0.09, -0.50),
                               (5.0, 4.4, 1.50, 0.10, -0.15), (6.4, 1.4, 0.55, 0.075, -0.60),
                               (7.6, 3.5, 0.95, 0.07, -0.30), (8.6, 5.6, 0.60, 0.06, -0.40)):
        objs.append(segment((math.cos(a) * 0.2, math.sin(a) * 0.2, z),
                            (math.cos(a), math.sin(a), drop), L, r, r * 0.35,
                            verts=4, name="stub"))
    for i in range(3):
        a = 2.0 * i + 0.3
        objs.append(segment((math.cos(a) * 0.13 + 0.18, math.sin(a) * 0.13, 9.5),
                            (math.cos(a) * 0.18, math.sin(a) * 0.18, 1.0),
                            0.5 + 0.35 * (i % 2), 0.055, 0.005, verts=4, name="splinter"))
    return kit.deliver(objs, "tree_snag")


def build_fern():
    """A sword fern, 0.65 m out of a crown and a metre across.

    This goes in by the dozen, so it is 220 triangles and the fronds are plain
    lofted blades with nothing pinnate about them: at the two metres you ever
    see one from, what reads is the shuttlecock, not the leaflets."""
    lib.reset()
    rng = random.Random(70018)
    objs = [hull([(0.00, 0.09, 0, 0), (0.07, 0.13, 0, 0), (0.14, 0.06, 0, 0)],
                 5, mat="bark", name="crown")]
    for i in range(7):
        a = 2 * math.pi * i / 7 + rng.uniform(-0.32, 0.32)
        L = rng.uniform(0.66, 0.84)
        # Steeply out of the crown and bent well past halfway, so a frond stands
        # up and then bows over. Less curl than this and the clump is a yucca.
        objs.append(blade((math.cos(a) * 0.05, math.sin(a) * 0.05, 0.08), a,
                          rng.uniform(0.96, 1.32), L, 0.072, 0.009,
                          -L * rng.uniform(0.50, 0.70), name="frond", profile=_FROND))
    return kit.deliver(objs, "fern")


def build_salal_bush():
    """Salal: 0.75 m high and twice that across, which is the whole difference
    between it and `bush` -- that one is a shrub with a shape, this is a
    thicket. One low storey of leaf mass, a second half over it, and five
    separate leaves standing out of the edge, because the thing you can name
    salal by from a metre away is the single thick oval leaf."""
    lib.reset()
    rng = random.Random(70019)
    objs = []
    for i in range(7):
        a = 2 * math.pi * i / 7 + 0.2
        objs.append(segment((math.cos(a) * 0.07, math.sin(a) * 0.07, 0),
                            (math.cos(a) * 0.62, math.sin(a) * 0.62, 1.0),
                            0.46 + 0.1 * (i % 3), 0.035, 0.014, verts=4, name="stem"))
    for i in range(7):
        a = 2 * math.pi * (i + 0.5) / 7
        d = 0.44 + rng.uniform(-0.08, 0.14)
        objs.append(leafmass((math.cos(a) * d, math.sin(a) * d,
                              0.30 + rng.uniform(-0.05, 0.10)),
                             0.33 + rng.uniform(-0.05, 0.07), rng, flat=0.52))
    for i in range(4):
        a = 2 * math.pi * i / 4 + 0.9
        objs.append(leafmass((math.cos(a) * 0.19, math.sin(a) * 0.19,
                              0.56 + rng.uniform(-0.04, 0.09)),
                             0.31 + rng.uniform(-0.04, 0.06), rng, flat=0.50))
    for i in range(5):
        a = 2 * math.pi * i / 5 + 0.45
        objs.append(blade((math.cos(a) * 0.55, math.sin(a) * 0.55, 0.34 + 0.08 * (i % 3)),
                          a + 0.4, rng.uniform(-0.25, 0.50), 0.17, 0.055, 0.008,
                          -0.05, name="leaf", profile=_FROND))
    return kit.deliver(objs, "salal_bush")


def build_moss_rock():
    """A boulder 0.9 m over, with a moss cap.

    The cap is a second shell built from the *same* per-angle wobble as the
    stone under it, so it lies parallel to the rock and laps over the shoulder
    instead of intersecting it in four tidy places. Its hem is jagged and runs
    lower on one side, and where that hem crosses back inside the rock is where
    the moss line falls -- so the edge is uneven and one-sided, which is how
    moss actually grows, rather than a green hat put on a grey ball."""
    lib.reset()
    rng = random.Random(70020)
    sides = 8
    wob = [rng.uniform(-0.11, 0.13) for _ in range(sides)]
    rock = [(0.00, 0.42, 0.00, 0.00), (0.22, 0.55, 0.02, 0.01),
            (0.52, 0.52, 0.05, -0.02), (0.76, 0.36, 0.08, -0.03),
            (0.90, 0.16, 0.09, -0.02)]
    # The hem, deepest on the far side of the boulder from the sun.
    hem = [0.17 * math.cos(2 * math.pi * i / sides - 2.1) + rng.uniform(-0.08, 0.08)
           for i in range(sides)]
    # The top ring has to sit above the rock's own summit ring, not level with
    # it, or the stone pokes through the cap as a bright disc on the crown --
    # which is exactly what the first render showed.
    moss = [(0.50, 0.46, 0.04, -0.01), (0.62, 0.475, 0.06, -0.02),
            (0.80, 0.350, 0.08, -0.03), (0.94, 0.200, 0.09, -0.02)]
    # Flat-shaded, and there is no shade_smooth here on purpose: measured, it
    # changes not one normal on an eight-sided ring, because those facets meet
    # at 45 degrees and the smooth-by-angle threshold is 30. It rounds off a
    # leafmass sphere well enough -- 72 vertices against 98 -- but on this it
    # would be decoration. Raise `sides` past twelve and it starts to earn its
    # place.
    objs = [hull(rock, sides, wob, mat="rock", name="boulder"),
            hull(moss, sides, wob, hem, jag_at=0, mat="grass", name="moss")]
    return kit.deliver(objs, "moss_rock")


ASSETS = [build_tree_oak, build_tree_pine, build_tree_fir, build_tree_snag,
          build_bush, build_salal_bush, build_fern, build_moss_rock,
          build_grass_tuft]


def build():
    return "\n".join(fn() for fn in ASSETS)
