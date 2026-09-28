"""marsh -- the wet ground of the coast: reed_clump, tussock, dead_log.

`trees` already owns the two shapes everything soft in this library is made of,
and this module borrows both rather than growing its own: `blade`, a tapered
strip lofted along its own length and bent in its own frame, and `hull`, rings
skinned into one closed solid. What separates a cattail leaf from a fir's
needle spray is the profile and the pitch, not the code.

The three of them are what a Pacific-Northwest wet edge is made of. Reeds mark
where the ground stops being walkable, sedge tussocks are the hummocks between,
and the fallen log is the one that carries the most: a nurse log with a ridge of
moss along its spine is the single most photographed object on that coast, and
it is 350 triangles.
"""

import math
import random
import importlib

import lib
import kit
import trees
importlib.reload(lib)
importlib.reload(kit)
importlib.reload(trees)


# Half-width along a blade, as a fraction of the widest point -- the same
# vocabulary as trees._SPRAY and trees._FROND. A reed is a *strap*: it leaves
# the water nearly at full width, holds it, and only comes to a point in the
# last third. Taper one from the base, as a conifer spray does, and the clump
# reads as pampas grass. A sedge blade is the same shape with a section taken
# out of it, because a tussock wants two dozen blades and cannot afford four
# rings each.
_REED = ((0.00, 0.80), (0.28, 1.00), (0.72, 0.62), (1.00, 0.04))
_SEDGE = ((0.00, 1.00), (0.52, 0.68), (1.00, 0.05))


def build_reed_clump():
    """Cattails, 1.2 to 2.0 m: nineteen blades out of one muddy crown and three
    of them carrying the brown cigar.

    The cigar is the whole point of the asset. Reeds without it are tall grass,
    and tall grass is what `tussock` is for; the seed head is the one silhouette
    that says standing water without any water being modelled. Three of
    nineteen, because a stand where every stem has flowered reads as a crop."""
    lib.reset()
    rng = random.Random(70021)
    # Dead leaf litter and mud where the stems come out of the ground. Without
    # it nineteen blades meet at a point and the clump floats.
    objs = [trees.hull([(0.00, 0.15, 0, 0), (0.05, 0.19, 0, 0), (0.12, 0.09, 0, 0)],
                       6, mat="bark", name="crown")]
    for i in range(19):
        a = 2 * math.pi * i / 19 + rng.uniform(-0.20, 0.20)
        d = 0.04 + 0.13 * rng.random()
        L = rng.uniform(1.32, 2.02)
        # Steep, but never vertical: a bed of parallel uprights is a fence.
        objs.append(trees.blade((math.cos(a) * d, math.sin(a) * d, 0.05), a,
                                rng.uniform(1.21, 1.46), L,
                                0.022 + L * 0.005, 0.010,
                                -L * rng.uniform(0.14, 0.40), sides=3,
                                mat="leaves", name="blade", profile=_REED))
    for (a, d, h, lean) in ((0.55, 0.09, 1.58, 0.10), (2.74, 0.13, 1.84, 0.16),
                            (4.61, 0.06, 1.36, 0.07)):
        dx, dy = math.cos(a) * lean, math.sin(a) * lean
        objs.append(trees.segment((math.cos(a) * d, math.sin(a) * d, 0.03),
                                  (dx, dy, 1.0), h, 0.017, 0.011, verts=4,
                                  mat="leaves", name="stem"))
        # Where the stem actually finishes, not where it started plus its
        # length: the lean is a third of a metre over 1.8 m and putting the head
        # above the root leaves it hanging off the stalk.
        f = h / math.sqrt(dx * dx + dy * dy + 1.0)
        tx, ty = math.cos(a) * d + dx * f, math.sin(a) * d + dy * f
        z = 0.03 + f
        objs.append(lib.loft([(z, 0.019, 0.019, tx, ty),
                              (z + 0.025, 0.031, 0.031, tx, ty),
                              (z + 0.165, 0.033, 0.033, tx, ty),
                              (z + 0.195, 0.018, 0.018, tx, ty)],
                             sides=6, name="cattail", mat="bark"))
        objs.append(trees.segment((tx, ty, z + 0.19), (dx * 0.4, dy * 0.4, 1.0),
                                  0.18, 0.008, 0.002, verts=4, mat="leaves",
                                  name="spike"))
    return kit.deliver(objs, "reed_clump")


def build_tussock():
    """A sedge hummock 0.7 m across: twenty-six short blades over a soft mound.

    The mound is the difference between this and `grass_tuft`. A tussock is not
    grass growing out of the ground, it is grass growing out of a heap of its
    own dead roots, and that heap is what you read from three metres -- a
    fountain of blades standing on a lump of shadow."""
    lib.reset()
    rng = random.Random(70022)
    sides = 8
    wob = [rng.uniform(-0.12, 0.14) for _ in range(sides)]
    mound = [(0.00, 0.20, 0.00, 0.00), (0.07, 0.23, 0.01, 0.01),
             (0.16, 0.20, 0.02, -0.01), (0.23, 0.10, 0.02, 0.00)]
    objs = [trees.hull(mound, sides, wob, mat="grass", name="mound")]
    for i in range(26):
        a = 2 * math.pi * i / 26 + rng.uniform(-0.22, 0.22)
        d = 0.03 + 0.12 * rng.random()
        # Further out down the shoulder of the mound, so the blades leave its
        # surface rather than all standing on the crown.
        z = 0.22 - d * 0.55
        L = rng.uniform(0.22, 0.38)
        # Reach is d + L.cos(pitch) + |curl|.sin(pitch), and all three terms
        # push outward: the first cut ran 0.95 m across on a 0.5-0.8 m brief
        # because the curl alone was throwing a tip 0.27 m sideways.
        objs.append(trees.blade((math.cos(a) * d, math.sin(a) * d, z), a,
                                rng.uniform(0.95, 1.40), L, 0.016, 0.006,
                                -L * rng.uniform(0.38, 0.70), sides=3,
                                mat="grass", name="blade", profile=_SEDGE))
    return kit.deliver(objs, "tussock")


def build_dead_log():
    """A fallen log 3.4 m long with a ridge of moss down its spine.

    Built standing, as every `hull` is -- rings have to run upwards or the
    normals turn inward -- and then laid down bodily through `kit.place`, which
    keeps the transform on the world matrix where `deliver` will bake it. The
    bow goes in as a per-ring offset that the quarter turn converts into height:
    the middle of the log rests on the ground and both ends lift, which is what
    a log that has been lying there does.

    The moss is the same move `moss_rock` makes, transposed a quarter turn. It
    is a second solid buried *inside* the log except along the top, so its hem
    is wherever it crosses back out through the bark rather than a line drawn on
    purpose, and it tapers back inside at both ends so its own end caps never
    surface. A cap of moss that finishes in mid-air is a green plate."""
    lib.reset()
    rng = random.Random(70023)
    sides = 9
    L = 3.4
    wob = [rng.uniform(-0.10, 0.13) for _ in range(sides)]
    # The snapped end: a ragged final ring rather than a sawn disc.
    jag = [rng.uniform(-0.34, 0.26) for _ in range(sides)]
    # (t along the log, radius, bow, sideways wander). Positive bow becomes
    # *downwards* under the quarter turn below, so the belly is in the middle.
    rings = [(0.00, 0.31, 0.00, 0.00), (0.55, 0.28, 0.05, 0.02),
             (1.20, 0.26, 0.08, 0.03), (1.90, 0.24, 0.08, 0.01),
             (2.55, 0.22, 0.05, -0.02), (3.05, 0.20, 0.02, -0.03),
             (L, 0.17, 0.00, -0.03)]
    # Unwrapped, so the bark runs along the log rather than across it in
    # facets (see `trees.hull`).
    log = trees.hull(rings, sides, wob, jag, mat="bark", name="log", unwrap=True)
    # Ry(90) sends (x, y, z) to (z, y, -x): the log's length becomes X and each
    # ring's bow becomes its height. Then slide it back to centre on X.
    kit.place([log], (-L / 2, 0, 0), (0, math.pi / 2, 0))
    objs = [log]

    # Sit it on the ground. Reading the mesh back is the only honest way -- the
    # bow, the wobble and the jagged end all move the lowest point, and a log
    # guessed onto z=0 either floats or is buried to the waist.
    lib.bpy.context.view_layer.update()
    dz = -min((log.matrix_world @ v.co).z for v in log.data.vertices) - 0.02
    kit.place(objs, (0, 0, dz), (0, 0, 0))         # 20 mm bedded into the duff

    def axis_at(t):
        """Centre and radius at `t` metres along the log, laid-down frame.

        Everything hung on the log is placed through this rather than off a
        guessed height: the bow drops the middle 80 mm and the taper takes
        140 mm off the radius over its length, so a stub pinned to a constant
        z floats clear of the bark at one end and is swallowed at the other."""
        k = 0
        while k < len(rings) - 2 and t > rings[k + 1][0]:
            k += 1
        t0, r0, cx0, cy0 = rings[k]
        t1, r1, cx1, cy1 = rings[k + 1]
        f = min(1.0, max(0.0, (t - t0) / (t1 - t0)))
        return (t - L / 2, cy0 + (cy1 - cy0) * f, dz - (cx0 + (cx1 - cx0) * f),
                r0 + (r1 - r0) * f)

    # Branch stubs. All of them leave the log going up or level -- one aimed
    # down is a stub buried in the ground, which costs 16 triangles and shows
    # nothing.
    # Short and blunt, not long and tapered. The first cut ran them 0.6-0.7 m
    # out at r 0.07 falling to 0.024, and against a log 0.6 m through they
    # rendered as pins stuck in it -- a branch that broke off a fallen trunk is
    # a stub, and the thing that reads is its butt, not its length.
    for (t, a, length, r, rise) in ((0.72, 1.15, 0.42, 0.105, 0.80),
                                    (1.85, 4.30, 0.34, 0.090, 0.50),
                                    (2.62, 2.05, 0.50, 0.095, 0.15),
                                    (0.25, 5.40, 0.28, 0.080, 0.35)):
        cx, cy, cz, rad = axis_at(t)
        objs.append(trees.segment((cx, cy + math.sin(a) * rad * 0.5,
                                   cz + math.cos(a) * rad * 0.5),
                                  (math.sin(a) * 0.9, math.cos(a) * 0.9, rise),
                                  length, r, r * 0.55, verts=5, mat="bark",
                                  name="stub"))
    # Splinters off the break, and the hollow rotten core behind them.
    bx, by, bz, br = axis_at(L)
    for i in range(4):
        a = 1.7 * i + 0.4
        objs.append(trees.segment((bx - 0.05, by + math.cos(a) * br * 0.55,
                                   bz + math.sin(a) * br * 0.55),
                                  (1.0, math.cos(a) * 0.16, math.sin(a) * 0.16),
                                  0.20 + 0.10 * (i % 3), 0.045, 0.006, verts=4,
                                  mat="bark", name="splinter"))
    objs.append(lib.cone(br * 0.78, br * 0.34, 0.30, (bx - 0.15, by, bz),
                         (0, math.pi / 2, 0), verts=6, name="rot", mat="bark"))
    # The butt end. `hull` will only jag one ring, so the other end came out of
    # the first render as a clean disc -- a sawn timber, not a tree that came
    # down. Three short spurs off it read as torn, and the same trick as the
    # snag's splintered top costs 36 triangles.
    ux, uy, uz, ur = axis_at(0.0)
    for i in range(3):
        a = 2.1 * i + 1.2
        objs.append(trees.segment((ux + 0.04, uy + math.cos(a) * ur * 0.5,
                                   uz + math.sin(a) * ur * 0.5),
                                  (-1.0, math.cos(a) * 0.5, math.sin(a) * 0.35),
                                  0.18 + 0.08 * (i % 2), 0.09, 0.018, verts=4,
                                  mat="bark", name="spur"))

    # The moss ridge. `loft` on the x axis puts the section's first offset in
    # Z and the second in Y -- (t, ra, rb, z, y) -- which is worth writing down,
    # because filling those two in the order they read gives a log with a green
    # stripe up one side.
    #
    # How wide the ridge comes out is arithmetic, not taste, and it took two
    # renders. A *round* shell can only trade the two things that matter off
    # against each other: it surfaces wherever
    #   R^2 + lift^2 + 2.lift.R.cos(t) > rad^2,
    # so wide-and-low (rad + 22 mm, lift 75 mm) opened to |t| < 114 degrees and
    # the log read as green with brown ends, while narrow-and-low closed to a
    # 20 mm proud sliver that the hull's own +-13% wobble then swallowed --
    # `axis_at` returns the mean radius, and the bark is 13% fatter than that
    # every eighth of a turn.
    #
    # An *ellipse* separates them: `loft` takes the two semi-axes apart, so the
    # shell can stand 70 mm proud of the crown (clear of the wobble by 35) and
    # still be held to a third of a metre across, because its horizontal
    # semi-axis is only 0.72 of the log's. Solved with lift 30 mm it opens to
    # 51 degrees and closes almost exactly flush underneath, which is where the
    # log meets the ground and nothing should be sticking out. Both end
    # sections go narrower than the log all round so the caps stay buried -- a
    # moss cap that finishes in mid-air is a green plate.
    moss = []
    for (t, tall, wide, lift) in ((0.38, -0.040, 0.45, 0.000),
                                  (0.80, +0.040, 0.72, 0.030),
                                  (1.45, +0.048, 0.76, 0.030),
                                  (2.05, +0.040, 0.72, 0.026),
                                  (2.60, +0.034, 0.66, 0.024),
                                  (3.05, -0.040, 0.45, 0.000)):
        cx, cy, cz, rad = axis_at(t)
        moss.append((cx, rad + tall, rad * wide, cz + lift, cy))
    objs.append(lib.loft(moss, sides=8, axis="x", name="moss", mat="grass"))
    return kit.deliver(objs, "dead_log")


ASSETS = [build_reed_clump, build_tussock, build_dead_log]


def build():
    return "\n".join(fn() for fn in ASSETS)
