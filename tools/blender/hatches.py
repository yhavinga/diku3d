"""hatches -- what opens in a floor, and what it opens in.

The mud's trapdoors are told in the room prose: "the faint outline of a
trapdoor can be seen in the dust", "a large rectangular slab of dark grey stone
that has been placed face up in the ground", "heavy blue smoke pours into a
vent in the ceiling", "a see-through opening in the floor, down into a
dungeon". Four leaves and three surrounds cover them:

* `trapdoor_leaf` + `trapdoor_frame` -- planks, two iron strap hinges and a
  flush ring pull, in a timber frame let into the floor.
* `tomb_slab` + `tomb_kerb` -- the graveyard's thirteen tombs: a worn slab of
  the headstones' own stone with a carved border and the name rubbed out of its
  field, in a low stone kerb.
* `floor_grate` -- iron bars in a frame, for a vent or a grating in a floor or a
  ceiling. `sewer_grate` is not this: it is a 1.1 m drain lying on a chamber
  floor, centred on its origin and with no hinge, over a quad of black water.
* `coffin_lid` + `coffin` -- the vampire's "jet black coffin ... who knows what
  lurks beneath", which is the way down: a stair climbs up through it. The
  coffin is a box with no top and no bottom that stands up out of the floor, and
  its lid lies on the rim. `clutter_sarcophagus` is the prop clutter.js maps the
  word "coffin" to, with its lid part of the one mesh; this is the one that
  opens.

Axes are Blender's, Z up; the exporter turns Blender -Y into three's +Z, so
nothing here is asymmetric in Y except where a comment says so.

A LEAF lies shut and flat. Its hinge edge runs along Y at x = 0, it runs out
along +X and is centred on Y, its top face is at z = 0 and its thickness lies
below. The viewer scales it to its opening and turns it about the hinge line,
so the hinge edge has to be exactly there -- nothing of a leaf is at x < 0, and
nothing is above z = 0. That is the reason the ironwork is let in: a strap that
stood 6 mm proud of the boards, and a ring that stood up from them, would be
above the line the viewer sets at the floor, and a ring you could trip on is
not what any floor trapdoor has. The boards are sunk 12 mm under the iron
instead, which is also what old boards do next to old iron.

A SURROUND has its origin at the centre of its opening and its top face at
z = 0 (the floor, or the turf line). The ring round the opening is rebated by
the leaf's own thickness, so the leaf drops in flush, and a lining runs down
0.4 m from there so an open hatch shows sides and not the void.

The coffin is the one surround that is not let into the floor. Its origin is
still on the floor at the middle of the opening, but its walls stand to 0.598
over it and its lid lies on top, with its own top at z = 0 in the leaf's frame
like any other: the viewer sets the lid 0.68 up. Under the floor the walls run
on to -0.40, as a lining does.

Tags: `doorboard` is the recipe made for plank leaves (grain along v, which on
a top face is Y -- along the boards -- see the cube projection), `oak` is
assets.js's flat joinery, `iron` the bars, and `rock` is the graveyard's stone:
`stonewall` is coursed masonry and would rule a mortar joint across a slab
that was cut from one block (props.py says it for the headstones). The coffin
is `wood`, the baked joiner's oak, and not `oak`: that is a flat brown with
none of the baked surfaces' hooks, and in a room with no sun it took the open
sky's blue (build.js LID_DRESS). The viewer tints the baked wood near-black
itself, so nothing here is dark on purpose. Its grain runs along u, which the
cube projection would put across the lid -- `lay_grain` lays it by hand.
"""

import math
import importlib

import bpy
import bmesh
import mathutils

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

# Viewport and preview colours only: the viewer bakes its own surfaces.
lib.PALETTE.setdefault("doorboard", (0.34, 0.26, 0.18, 1.0))
lib.PALETTE.setdefault("rock", (0.30, 0.29, 0.27, 1.0))
lib.PALETTE.setdefault("wood", (0.33, 0.21, 0.12, 1.0))


# --- raw geometry ---------------------------------------------------------

def solid(name, verts, faces, mat, grain=None):
    """A closed shell from raw lists. Winding is handed to bmesh rather than
    reasoned about -- kit.timber is on record as having come out inside-out
    for one axis -- and a UV layer is added so join() has one to keep.

    `grain`, for a wooden part, is a function of a face's centre that returns
    the direction the grain runs there (see lay_grain)."""
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()
    me.uv_layers.new(name="UVMap")
    if grain is not None:
        lay_grain(me, grain)
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return lib.assign(obj, mat)


def lay_grain(me, along):
    """UVs for a wooden part, in metres, with u running along the grain.

    The baked `wood` draws its latewood lines along u (textures.js), and the
    delivery's cube projection gives every face that looks up u = x. A lid
    that lies along y would be grained across its width, and the rim of a long
    wall across the rim. So each face is laid flat in its own plane, u the way
    `along(centre)` says the grain runs there, projected into the face, and v
    across it. The faces are flagged own_uv, which kit.deliver leaves alone
    (trees.py's mark_own_uv), and what is left -- the iron -- is projected."""
    layer = me.uv_layers[0]
    for poly in me.polygons:
        n = poly.normal
        t = mathutils.Vector(along(poly.center))
        t = t - n * t.dot(n)
        if t.length < 0.35:
            # The grain points out of this face: end grain, any way round will do.
            t = mathutils.Vector((0.0, 0.0, 1.0))
            t = t - n * t.dot(n)
            if t.length < 0.35:
                t = mathutils.Vector((1.0, 0.0, 0.0)) - n * n.x
        t.normalize()
        s = n.cross(t)
        for li in poly.loop_indices:
            p = me.vertices[me.loops[li].vertex_index].co
            layer.data[li].uv = (p.dot(t), p.dot(s))
    flag = me.attributes.new("own_uv", "INT", "FACE")
    for item in flag.data:
        item.value = 1


def sweep(path, hx, hy, name, mat, cx=0.0, cy=0.0, closed=True, grain=None):
    """A profile swept round a rectangle, mitred at the corners.

    `path` is [(out, z), ...]: how far each point stands out from the
    rectangle's edge (negative is in) and how high. Every point becomes a ring
    of four corners, all offset by the same `out`, and the corners of
    concentric rectangles are the mitres -- nothing is cut, and the four sides
    meet in the line the profile does. A closed path is a ring (a wall round an
    opening); an open one is a slab, capped by the rectangle at each end."""
    n = len(path)
    verts = []
    for (out, z) in path:
        ex, ey = hx + out, hy + out
        verts += [(cx + ex, cy + ey, z), (cx - ex, cy + ey, z),
                  (cx - ex, cy - ey, z), (cx + ex, cy - ey, z)]
    faces = []
    for k in range(n if closed else n - 1):
        a, b = 4 * k, 4 * ((k + 1) % n)
        for i in range(4):
            j = (i + 1) % 4
            faces.append((a + i, a + j, b + j, b + i))
    if not closed:
        faces.append((0, 1, 2, 3))
        faces.append(tuple(range(4 * (n - 1), 4 * n)))
    return solid(name, verts, faces, mat, grain)


def prism(outline, z0, z1, name, mat):
    """A convex outline in XY, counter-clockwise, extruded from z0 to z1."""
    n = len(outline)
    verts = [(x, y, z0) for (x, y) in outline] + [(x, y, z1) for (x, y) in outline]
    faces = [tuple(range(n)), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    return solid(name, verts, faces, mat)


def annulus(cx, cy, r_in, r_out, z0, z1, n, name, mat):
    """A flat ring: a collar, a washer. Closed, so its volume can be signed."""
    rings = []
    for z in (z1, z0):
        for r in (r_out, r_in):
            rings.append([(cx + r * math.cos(2 * math.pi * i / n),
                           cy + r * math.sin(2 * math.pi * i / n), z) for i in range(n)])
    verts = [v for ring in rings for v in ring]
    at = lambda k, i: k * n + i % n
    faces = []
    for i in range(n):
        faces.append((at(0, i), at(0, i + 1), at(1, i + 1), at(1, i)))   # top
        faces.append((at(3, i), at(3, i + 1), at(2, i + 1), at(2, i)))   # underside
        faces.append((at(2, i), at(2, i + 1), at(0, i + 1), at(0, i)))   # outer wall
        faces.append((at(1, i), at(1, i + 1), at(3, i + 1), at(3, i)))   # inner wall
    return solid(name, verts, faces, mat)


def jitter(i, k=0):
    """0..1, the same every build: the boards are not a ruler."""
    return ((i * 2654435761 + k * 40503) % 1000) / 999.0


# --- the trapdoor ---------------------------------------------------------

LEAF = 1.2
# Six boards and five 8 mm gaps make exactly 1.2 m. They differ by a few
# millimetres because boards cut by hand do.
BOARDS = (0.190, 0.200, 0.185, 0.195, 0.200, 0.190)
GAP = 0.008
PLANK_TOP = -0.012      # the iron finishes flush at 0, 12 mm over the boards
PLANK_BOT = -0.046
STRAP_Y = 0.30          # the straps and the battens under them
STRAP = [(0.0, -0.034), (0.62, -0.027), (0.74, -0.012), (0.78, 0.0),
         (0.74, 0.012), (0.62, 0.027), (0.0, 0.034)]


def build_trapdoor_leaf():
    """Boards running along the hinge, crossed by two strap hinges that are the
    top ends of the battens under them, and a ring pull lying flat in a collar
    on the free-edge board. Boards parallel to the hinge and ironwork across
    them is how a ledged hatch is hung: the straps carry the weight to the
    battens through the boards.

    A floor hatch is seen from above and a ceiling hatch from below, and the
    viewer turns it for those, so the underside is not a back: it has the
    battens and the brace a ledged-and-braced leaf has."""
    lib.reset()
    p = []
    x = 0.0
    for i, bw in enumerate(BOARDS):
        top = PLANK_TOP - 0.002 * jitter(i)
        p.append(kit.timber((bw, LEAF, top - PLANK_BOT), (x + bw / 2, 0.0, (top + PLANK_BOT) / 2),
                            (0, 0, 0), "doorboard", 0.007, "board"))
        x += bw + GAP

    # Under the boards. The battens reach 2 mm into them; the brace stops 1.5
    # mm short, so no face of one lies in a face of the other.
    for sy in (-1, 1):
        p.append(kit.timber((1.12, 0.09, 0.026), (0.60, sy * STRAP_Y, -0.057),
                            (0, 0, 0), "oak", 0.006, "batten"))
    run, rise = 0.96, 2 * STRAP_Y
    p.append(kit.timber((math.hypot(run, rise), 0.08, 0.0195), (0.60, 0.0, -0.05725),
                        (0, 0, math.atan2(rise, run)), "oak", 0.005, "brace"))

    for sy in (-1, 1):
        y = sy * STRAP_Y
        p.append(prism([(px, py + y) for (px, py) in STRAP], -0.018, -0.004, "strap", "iron"))
        # The eye the pin goes through, tangent to x = 0 and to the top plane.
        p.append(lib.cylinder(0.02, 0.068, (0.02, y, -0.02), (math.pi / 2, 0, 0), verts=8,
                              name="eye", mat="iron"))
        for rx in (0.15, 0.36, 0.57):
            p.append(lib.cone(0.013, 0.008, 0.0045, (rx, y, -0.00225), verts=6,
                              name="rivet", mat="iron"))

    # The ring pull on the board at the free edge: a collar, the ring lying
    # inside it with its top at the floor line, and the lug it hangs from.
    cx = LEAF - BOARDS[-1] / 2
    p.append(annulus(cx, 0.0, 0.056, 0.080, -0.020, -0.004, 10, "collar", "iron"))
    p.append(lib.torus(0.038, 0.0065, (cx, 0.0, -0.0065), major_seg=10, minor_seg=4,
                       name="ring", mat="iron"))
    p.append(lib.box((0.026, 0.014, 0.010), (cx - 0.054, 0.0, -0.011), name="lug", mat="iron"))
    return kit.deliver(p, "trapdoor_leaf")


def build_trapdoor_frame():
    """A timber frame let into the floor round a 1.2 m square opening. The ring
    is as deep as the leaf is thick, so the leaf lies flush in it; under the
    ring a 30 mm lining runs down to 0.4 m and leaves a ledge for the leaf to
    sit on. The opening is 1.2 at the top, where the leaf is, and 1.14 below
    the ledge."""
    lib.reset()
    p = []
    h, w, depth = LEAF / 2, 0.12, 0.07
    for side in (-1, 1):
        # The long members run the whole side; the short ones butt between them.
        p.append(kit.timber((w, LEAF + 2 * w, depth), (side * (h + w / 2), 0.0, -depth / 2),
                            (0, 0, 0), "oak", 0.012, "ring"))
        p.append(kit.timber((LEAF, w, depth), (0.0, side * (h + w / 2), -depth / 2),
                            (0, 0, 0), "oak", 0.012, "ring"))
    t, drop = 0.03, 0.40 - depth
    for side in (-1, 1):
        p.append(lib.box((t, LEAF, drop), (side * (h - t / 2), 0.0, -depth - drop / 2),
                         name="lining", mat="oak"))
        p.append(lib.box((LEAF - 2 * t, t, drop), (0.0, side * (h - t / 2), -depth - drop / 2),
                         name="lining", mat="oak"))
    return kit.deliver(p, "trapdoor_frame")


# --- the tomb -------------------------------------------------------------

SLAB_X, SLAB_Y, SLAB_T = 1.0, 2.1, 0.16
EDGE_DROP = 0.035       # the worn arris: this far down...
MARGIN_WEAR = 0.003     # the carved band is not quite level
STEP = 0.024            # the field is sunk this far under the band
DISH = 0.010            # ...and feet and rain have hollowed it a little more
# Grid lines across and along the slab, and what each one is, outside in:
# 0 the outline, 1 the top of the worn arris, 2 the edge of the carved band,
# 3 the foot of the step into the field, 4 the field. A vertex takes the
# outermost of its two lines, so the step runs round the field in a loop.
SLAB_XS = [(0.0, 0), (0.03, 1), (0.11, 2), (0.118, 3), (0.35, 4), (0.65, 4),
           (0.882, 3), (0.89, 2), (0.97, 1), (1.0, 0)]
SLAB_YS = [(-1.05, 0), (-1.02, 1), (-0.94, 2), (-0.932, 3), (-0.60, 4), (-0.20, 4),
           (0.20, 4), (0.60, 4), (0.932, 3), (0.94, 2), (1.02, 1), (1.05, 0)]


def slab_mesh():
    """The slab as one closed shell: a heightfield on a grid whose lines fall
    exactly on the carving, so the step is a step and not a ramp across a cell,
    then the worn arris, the sides, and a flat underside. Nothing is booleaned
    and nothing is cracked: each side wall is cut at the same vertices as the
    arris above it.

    The hinge edge (x = 0) is dead straight because it is the pivot line; the
    other three edges wander inward by up to 4 mm, the level editor not showing
    through, except at the two lines in the middle of each, which stay put so the
    slab is exactly 1.0 x 2.1. Nothing stands above z = 0."""
    nx, ny = len(SLAB_XS), len(SLAB_YS)
    raw = {}
    for ix, (gx, rx) in enumerate(SLAB_XS):
        for iy, (gy, ry) in enumerate(SLAB_YS):
            x, y = gx, gy
            rank = min(rx, ry)
            h = jitter(ix * 31 + iy, 7)
            if rank == 0:
                z = -EDGE_DROP
                if ix == nx - 1 and iy not in (5, 6):
                    x = SLAB_X - 0.004 * h
                if iy == 0 and ix not in (4, 5):
                    y = -SLAB_Y / 2 + 0.004 * jitter(ix, 11)
                if iy == ny - 1 and ix not in (4, 5):
                    y = SLAB_Y / 2 - 0.004 * jitter(ix, 13)
            elif rank in (1, 2):
                z = -MARGIN_WEAR * h
            else:
                u = (x - SLAB_X / 2) / 0.382
                v = y / 0.932
                z = -STEP - (DISH * (1 - u * u) * (1 - v * v) if rank == 4 else 0.0) \
                    - 0.0015 * h
            raw[(ix, iy)] = (x, y, z)
    # The highest point of the band is the floor line, whatever the jitter drew.
    lift = -max(z for (_, _, z) in raw.values())
    verts = []
    index = {}
    for key in sorted(raw):
        x, y, z = raw[key]
        index[key] = len(verts)
        verts.append((x, y, z + lift))
    faces = []
    for ix in range(nx - 1):
        for iy in range(ny - 1):
            faces.append((index[(ix, iy)], index[(ix + 1, iy)],
                          index[(ix + 1, iy + 1)], index[(ix, iy + 1)]))
    loop = [(ix, 0) for ix in range(nx)] + [(nx - 1, iy) for iy in range(1, ny)] \
        + [(ix, ny - 1) for ix in range(nx - 2, -1, -1)] + [(0, iy) for iy in range(ny - 2, 0, -1)]
    under = []
    for key in loop:
        x, y, _ = verts[index[key]]
        under.append(len(verts))
        verts.append((x, y, -SLAB_T))
    for k in range(len(loop)):
        j = (k + 1) % len(loop)
        faces.append((index[loop[k]], index[loop[j]], under[j], under[k]))
    faces.append(tuple(under))
    return verts, faces


def build_tomb_slab():
    """"A large rectangular slab of dark grey stone that has been placed face
    up in the ground. The name has been erased by the ravages of time."

    1.0 x 2.1 x 0.16, hinged on a long edge. The border is carved -- a flat band
    stepping down into the field -- and the field is blank, rubbed smooth and a
    little hollow: the inscription's place with nothing in it."""
    lib.reset()
    verts, faces = slab_mesh()
    return kit.deliver([solid("slab", verts, faces, "rock")], "tomb_slab")


def build_tomb_kerb():
    """A low kerb of dressed blocks round the slab's 1.0 x 2.1 opening, rebated
    0.16 for the slab, with a lining of stone down to 0.4 m. The ring's top is
    z = 0 and is meant to be set up to 0.06 over the turf; its outer arris is
    eased 30 mm so what shows is a worn edge and not a cut one. The long sides
    are two blocks each with a joint at the middle."""
    lib.reset()
    p = []
    hx, hy = SLAB_X / 2, SLAB_Y / 2
    w, depth, joint = 0.18, SLAB_T, 0.006
    long_run = SLAB_Y + 2 * w
    block = (long_run - joint) / 2
    for side in (-1, 1):
        for end in (-1, 1):
            p.append(kit.timber((w, block, depth),
                                (side * (hx + w / 2), end * (joint / 2 + block / 2), -depth / 2),
                                (0, 0, 0), "rock", 0.03, "kerb"))
        p.append(kit.timber((SLAB_X, w, depth), (0.0, side * (hy + w / 2), -depth / 2),
                            (0, 0, 0), "rock", 0.03, "kerb"))
    t, drop = 0.05, 0.40 - depth
    for side in (-1, 1):
        p.append(lib.box((t, SLAB_Y, drop), (side * (hx - t / 2), 0.0, -depth - drop / 2),
                         name="lining", mat="rock"))
        p.append(lib.box((SLAB_X - 2 * t, t, drop), (0.0, side * (hy - t / 2), -depth - drop / 2),
                         name="lining", mat="rock"))
    return kit.deliver(p, "tomb_kerb")


# --- the grate ------------------------------------------------------------

def build_floor_grate():
    """Iron bars in a frame, 1.0 x 1.0 x 0.06. Bars are square-section and set
    diamond-wise like the graveyard gate's, so each carries a highlight down
    its top arris; they run across the leaf, from hinge to latch, with three
    cross-bars through them. The hinge edge is a round barrel -- a pipe hinge --
    so x = 0 is the pivot line itself and not a flat bar beside it."""
    lib.reset()
    p = []
    S, T, r, w = 1.0, 0.06, 0.03, 0.05      # leaf, thickness, barrel radius, rail width
    # The frame stands 5 mm under the floor line and the bars' arrises finish
    # on it, so the latch plate can lie on the rail and still stop at it.
    rail_top = -0.005
    rail_h = T + rail_top
    rail_z = rail_top - rail_h / 2

    # The barrel is 1 cm short of the frame's sides, or its end caps would lie
    # in the plane of the side rails' outer faces.
    p.append(lib.cylinder(r, S - 0.01, (r, 0.0, -r), (math.pi / 2, 0, 0), verts=12, name="barrel", mat="iron"))
    p.append(kit.timber((w, S, rail_h), (S - w / 2, 0.0, rail_z), (0, 0, 0), "iron", 0.008, "rail"))
    # The side rails lap into the barrel but stop at the latch rail's face: both
    # run out to the same side of the frame, and a lap there would put two outer
    # faces in one plane. The bars and cross-bars lap into both.
    hinge_to, latch_from = r * 1.5, S - w
    for sy in (-1, 1):
        p.append(kit.timber((latch_from - hinge_to, w, rail_h),
                            ((hinge_to + latch_from) / 2, sy * (S / 2 - w / 2), rail_z),
                            (0, 0, 0), "iron", 0.008, "rail"))

    bar = 0.024
    centre = -bar * math.sqrt(2) / 2        # the diamond's apex at z = 0
    reach = latch_from + 0.005 - hinge_to
    gap = (S - 2 * w) / 9.0
    for i in range(8):
        p.append(lib.box((reach, bar, bar), (hinge_to + reach / 2, -S / 2 + w + gap * (i + 1), centre),
                         (math.pi / 4, 0, 0), name="bar", mat="iron"))
    for k in range(3):
        p.append(lib.box((bar, S - 2 * w + 0.01, bar), (2 * r + (latch_from - 2 * r) * (k + 1) / 4.0, 0.0, centre),
                         (0, math.pi / 4, 0), name="cross", mat="iron"))

    # 6 mm narrower than the rail, so none of its faces lies in one of the rail's.
    p.append(lib.box((w - 0.006, 0.12, 0.012), (S - w / 2, 0.0, -0.006), name="latch", mat="iron"))
    return kit.deliver(p, "floor_grate")


# --- the coffin -----------------------------------------------------------

COFFIN_HX, COFFIN_HY = 0.73, 1.15   # half the clear opening: 1.46 across, 2.30 along
COFFIN_WALL = 0.10                  # so the walls are 1.66 x 2.50 where they are thickest
COFFIN_RIM = 0.598                  # the top of the walls over the floor, and the lid's seat
COFFIN_FOOT = -0.40                 # and where they end under it
BODY = 0.056                        # the panelled body stands this far out of the opening's edge
RISE, BEVEL = 0.012, 0.020          # a panel stands this far off the body, its bevel this wide
SUNK = 0.004                        # and its foot is let this far into it, which is hidden
STILE = 0.115                       # the body left bare at a corner
PANEL_Z = (0.164, 0.405)            # a panel's foot and head, 50 mm in from the body's ends
PLATE, PLATE_W, PLATE_H = 0.006, 0.052, 0.070   # the plate a handle's leg stands on
HANDLE_HALF, HANDLE_LEG, HANDLE_OFF, HANDLE_BAR = 0.10, 0.014, 0.026, 0.010
HANDLE_PITCH = 0.66                 # three to a long side, this far apart

# The wall in section from the foot of its outside, up to the rim and down the
# inside again: (out, z), `out` from the opening's edge. Nothing is further out
# than the wall is thick, so the coffin stays in the footprint it was asked for;
# the plinth and the cornice are the full 0.10, the body between them is stepped
# back to hold the panels and the handles inside it. A vertex lies on z = 0, so
# no face crosses the floor line and the part under it can be told from the
# part over it exactly (build.js `modelHalves`).
COFFIN_SECTION = [
    (COFFIN_WALL, COFFIN_FOOT), (COFFIN_WALL, 0.0),     # the lining, under the floor
    (COFFIN_WALL, 0.055), (0.094, 0.068),               # the plinth: a band, its arris eased,
    (0.094, 0.082), (BODY, 0.114),                      # a neck, and the splay up into the body
    (BODY, 0.455),                                      # the body
    (0.082, 0.484), (0.082, 0.492),                     # the moulding under the rim: out in two
    (COFFIN_WALL, 0.507), (COFFIN_WALL, 0.578),         # steps to a frieze,
    (0.088, COFFIN_RIM), (0.0, COFFIN_RIM),             # the rim, flat so a lid can lie on it,
    (0.0, 0.0), (0.0, COFFIN_FOOT),                     # and the inside, plain, to the foot
]

SIDES = ((1, 0), (0, 1), (-1, 0), (0, -1))   # which way each side faces: +X, +Y, -X, -Y


def on_side(side, s, out, z):
    """A point `s` along a side of the coffin, anticlockwise from above, `out`
    from the edge of the opening, at height z."""
    nx, ny = SIDES[side]
    d = (COFFIN_HX if nx else COFFIN_HY) + out
    return (nx * d - ny * s, ny * d + nx * s, z)


def coffin_grain(c):
    """The grain runs along the wall: y on the long sides, x on the ends. A face
    is on a long side if it stands further out of the opening in x than in y."""
    return (0.0, 1.0, 0.0) if abs(c.x) - COFFIN_HX >= abs(c.y) - COFFIN_HY else (1.0, 0.0, 0.0)


def frustum(side, s0, s1, z0, z1, out0, out1, bevel):
    """A field standing on a side of the coffin, as a closed shell: its foot
    s0..s1 by z0..z1 at `out0`, a flat top at `out1` drawn in by `bevel` all
    round, and four bevels between. Returns (verts, faces)."""
    foot = [(s0, z0), (s1, z0), (s1, z1), (s0, z1)]
    head = [(s0 + bevel, z0 + bevel), (s1 - bevel, z0 + bevel),
            (s1 - bevel, z1 - bevel), (s0 + bevel, z1 - bevel)]
    verts = [on_side(side, s, out0, z) for (s, z) in foot]
    verts += [on_side(side, s, out1, z) for (s, z) in head]
    faces = [(0, 1, 2, 3), (4, 5, 6, 7)]
    faces += [(a, (a + 1) % 4, 4 + (a + 1) % 4, 4 + a) for a in range(4)]
    return verts, faces


def merged(shells):
    """Several (verts, faces) shells as one list, for one object."""
    verts, faces = [], []
    for (v, f) in shells:
        i = len(verts)
        verts += v
        faces += [tuple(i + k for k in face) for face in f]
    return verts, faces


def coffin_panels():
    """The raised field of the panelling on each of the four sides. One long one
    to a side, not a row of them: framed one to a handle they read as the
    fronts of drawers, and a chest is what that makes of it. The foot of a field
    is let into the body, so no face of one lies in the body's own."""
    z0, z1 = PANEL_Z
    shells = []
    for side in range(4):
        half = (COFFIN_HY if SIDES[side][0] else COFFIN_HX) + BODY - STILE
        shells.append(frustum(side, -half, half, z0, z1, BODY - SUNK, BODY + RISE, BEVEL))
    return merged(shells)


def coffin_handles():
    """Three iron handles to a long side, each a flat bar on two legs -- a
    staple, seen from above and extruded 30 mm up -- and each leg on a small
    plate, which is what makes a bar on a wall a coffin's. The bar's outer face
    is 2 mm inside the cornice's, so nothing stands out of the footprint; the
    legs are let 2 mm into their plates and the plates 2 mm into the panel.
    Returns the plates as one shell list and the staples as parts."""
    a, w, h, t = HANDLE_HALF, HANDLE_LEG, HANDLE_OFF, HANDLE_BAR
    face = BODY + RISE                              # the panel's face
    zc = sum(PANEL_Z) / 2
    lug = a - w / 2                                 # a leg's middle, from the handle's
    staple = [(-a, 0.0), (-a, h), (a, h), (a, 0.0), (a - w, 0.0), (a - w, h - t),
              (-a + w, h - t), (-a + w, 0.0)]
    plates, staples = [], []
    for side in (0, 2):
        for k in (-1, 0, 1):
            s = k * HANDLE_PITCH
            for sign in (-1, 1):
                u = s + sign * lug
                plates.append(frustum(side, u - PLATE_W / 2, u + PLATE_W / 2,
                                      zc - PLATE_H / 2, zc + PLATE_H / 2,
                                      face - 0.002, face + PLATE, 0.006))
            outline = [on_side(side, s + u, face + PLATE - 0.002 + out, 0.0)[:2] for (u, out) in staple]
            staples.append(prism(outline, zc - 0.015, zc + 0.015, "handle", "iron"))
    return merged(plates), staples


def build_coffin():
    """"One coffin lies in the center of the room", and "a jet black coffin ...
    who knows what lurks beneath": the way down from the Den of the Vampire
    goes through it, so this is a box with no top and no bottom. Four walls 0.10
    thick round a clear 1.46 x 2.30 opening, standing 0.598 over the floor where
    the lid lies, and running down to -0.40 so that looking into an open coffin
    shows wood and not the void.

    It has a coffin's character inside the 1.66 x 2.50 the walls make: a moulded
    plinth, a long raised panel to a side, a moulding under the rim and three
    iron handles to a long side. The inside is plain. Nothing stands outside
    that footprint, the handles included -- the body is stepped back to leave
    them room.

    The origin is on the floor, under the middle of the opening."""
    lib.reset()
    p = [sweep(COFFIN_SECTION, COFFIN_HX, COFFIN_HY, "wall", "wood", grain=coffin_grain)]
    verts, faces = coffin_panels()
    p.append(solid("panels", verts, faces, "wood", coffin_grain))
    (verts, faces), staples = coffin_handles()
    p.append(solid("plates", verts, faces, "iron"))
    return kit.deliver(p + staples, "coffin")


# --- the coffin's lid -----------------------------------------------------

LID_X, LID_Y, LID_T = 1.62, 2.46, 0.08

# The lid in section, from the underside out to the edge and in to the middle:
# (out, z), `out` from its outline, negative being in. The panel is raised, in
# two steps, but the leaf may not stand over the floor line, so it is the field
# round it that is sunk: the top of the panel is z = 0, a step lies 15 mm under
# it and the field 30 mm.
LID_SECTION = [
    (-0.008, -LID_T), (0.0, -0.072),    # the underside, its arris eased
    (0.0, -0.050),                      # the edge
    (-0.022, -0.030),                   # bevelled up to the field
    (-0.072, -0.030),                   # the field
    (-0.108, -0.015),                   # a bevel up to the first step,
    (-0.138, -0.015),                   # the step,
    (-0.174, 0.0),                      # and the panel's bevel, up to the floor line
]


def along_y(c):
    return (0.0, 1.0, 0.0)


def build_coffin_lid():
    """The leaf that lies on the coffin: 1.62 x 2.46 x 0.08, so it covers the
    opening and 0.08 of the rim all round and leaves 20 mm of the rim showing.
    Hinged on a long side, as the viewer hangs a coffin's. A raised panel in two
    steps and a bevelled edge, cut from the one board: the grain runs the length
    of the lid, which is the way the boards of a coffin lie."""
    lib.reset()
    lid = sweep(LID_SECTION, LID_X / 2, LID_Y / 2, "lid", "wood", cx=LID_X / 2,
                closed=False, grain=along_y)
    return kit.deliver([lid], "coffin_lid")


ASSETS = [build_trapdoor_leaf, build_trapdoor_frame, build_tomb_slab, build_tomb_kerb,
          build_floor_grate, build_coffin_lid, build_coffin]


def build():
    return "\n".join(fn() for fn in ASSETS)
