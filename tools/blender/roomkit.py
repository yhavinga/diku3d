"""roomkit -- the modular pieces a room is assembled from.

The temple was one solid model with the doorway on one face, and that cannot be
placed. Room #3001 carries doorways on two sides at once and `layout.js` decides
at run time which walls those are, so a fixed doorway either seals a passage or
leaves a hole in a wall that should be solid. The answer is to stop shipping the
building and ship the wall.

Everything here is authored on an 11.4 m room grid:

* A panel is 11.4 m wide and spans the *full* width of its wall line, centred on
  it, with its origin at the base centre of the panel and its front at -Y. Four
  panels on the four wall lines at WALL_LINE = 5.35 -- yaw 0, 90, 180, 270 --
  close a room with no hole at any corner even with no corner pieces at all.
  Spanning the full width rather than stopping short is what buys that: a panel
  covers its whole face on its own and does not depend on its neighbours.
* The price is that the panel ends overshoot each other by 0.1 m at every
  corner, which is exactly why there is a corner pier: a solid 1.12 m block that
  swallows all four ends and dresses the joint. It is square and detailed alike
  on all four faces, so it needs no rotation -- but it is not optional.
* The bands stack to exactly 5.2 m, so the top of a panel *is* the eaves, and
  the roof is authored with its origin at eaves height. Drop it on at z = 5.2.

Coplanar faces are avoided by construction rather than by nudging afterwards: a
member that sits over another either steps 0.02 - 0.04 m clear of its plane or
butts it back to back. Two faces in one plane facing the same way flicker; two
facing opposite ways are a joint, and only one of them is ever drawn.

The plain stone kit at the bottom is the same code with different bands. It is
the one every indoor room in the world can use instead of a procedural box.
"""

import math
import importlib

import bpy
import mathutils

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)


W = 11.4                    # room side, and the width of one panel
H = 5.2                     # ground to eaves
T = 0.5                     # wall thickness, centred on the wall line
PIER = 1.12                 # corner pier, square in plan
DOOR_W, DOOR_H = 3.2, 3.1
MASON = DOOR_W + 0.4        # the hole left in the masonry; jamb blocks fill the
                            # 0.2 m each side, so no course end lands in the
                            # same plane as a reveal face
LINTEL_W = MASON + 1.0      # the stone that spans it, bearing 0.5 m each end
STEP_RISE, STEP_GOING, STEPS = 0.15, 0.36, 3


# --- masonry --------------------------------------------------------------

def _courses(bands, mat, hole=None, width=W, name="course"):
    """A panel's masonry, band by band.

    A band is (z0, z1, out, inn): `out` is how far it projects past the -Y face
    of the wall and `inn` past the +Y face, so a cornice can be heavy outside
    and modest inside. Negative recesses it, which is all an ashlar joint is.

    `hole` is (half_width, top_z). Every band boundary is chosen to land on that
    top, so no band is ever cut horizontally; the band that starts there becomes
    the lintel instead.
    """
    objs = []
    for band in bands:
        z0, z1, out, inn = band[:4]
        label = band[4] if len(band) > 4 else name
        d = T + out + inn
        y = (inn - out) / 2.0
        h = z1 - z0
        zc = (z0 + z1) / 2.0
        runs = [(-width / 2, width / 2)]
        if hole:
            hx, hz = hole
            if z1 <= hz + 1e-6:
                runs = [(-width / 2, -hx), (hx, width / 2)]
            elif abs(z0 - hz) < 1e-6:
                lw = LINTEL_W / 2.0
                objs.append(kit.timber((LINTEL_W, d + 0.24, h), (0, y, zc),
                                       (0, 0, 0), mat, 0.05, "lintel"))
                runs = [(-width / 2, -lw), (lw, width / 2)]
        for (x0, x1) in runs:
            objs.append(kit.timber((x1 - x0, d, h), ((x0 + x1) / 2, y, zc),
                                   (0, 0, 0), mat, 0.035, label))
    return objs


def _doorway(mat, frame, sill=True):
    """Reveal blocks, an applied architrave and a threshold.

    The reveals are 20 mm thinner than the wall so their faces never share a
    plane with a course face; the architrave stands 0.10 m back from the arris
    for the same reason, and its head sits 40 mm above the soffit so the two
    undersides are not one surface.
    """
    objs = []
    hw = DOOR_W / 2.0
    # 0.42 off the wall line, not 0.41: that is where the stone kit's plinth
    # finishes on the room side, and the architrave's foot shared its face
    # for the plinth's 0.26 m -- the worst flicker in the Mud School, at every
    # doorway, from inside. 10 mm proud of that plinth, 10 mm inside the
    # temple's (0.43).
    AT = T + 0.34
    for sx in (-1, 1):
        objs.append(kit.timber((0.30, T - 0.02, DOOR_H), (sx * (hw + 0.15), 0, DOOR_H / 2),
                               (0, 0, 0), mat, 0.03, "reveal"))
        objs.append(kit.timber((0.40, AT, DOOR_H + 0.04),
                               (sx * (hw + 0.30), 0, (DOOR_H + 0.04) / 2),
                               (0, 0, 0), frame, 0.045, "architrave"))
    objs.append(kit.timber((DOOR_W + 1.0, AT, 0.36), (0, 0, DOOR_H + 0.22),
                           (0, 0, 0), frame, 0.045, "architrave"))
    if sill:
        objs.append(kit.slab((DOOR_W + 0.5, T + 0.55, 0.10), (0, 0, 0.0),
                             mat=frame, name="threshold", width=0.03))
    return objs


# --- the temple kit -------------------------------------------------------

def _temple_bands():
    """Plinth, four ashlar courses, a two-fascia architrave, frieze, cornice.

    The 0.56 - 3.10 field is split in three so the door head at 3.10 falls on a
    joint; alternate courses are recessed 20 mm, which is what draws the bed
    joints without a single extra triangle over a flat wall."""
    lo = [0.56 + (DOOR_H - 0.56) * i / 3.0 for i in range(4)]
    bands = [(0.00, 0.30, 0.24, 0.18, "plinth"),
             (0.30, 0.56, 0.13, 0.09, "plinth")]
    for i in range(3):
        r = -0.02 if i == 1 else 0.0
        bands.append((lo[i], lo[i + 1], r, r, "ashlar"))
    bands += [(DOOR_H, 3.88, -0.02, -0.02, "ashlar"),
              (3.88, 4.18, 0.06, 0.05, "architrave"),
              (4.18, 4.42, 0.10, 0.09, "taenia"),
              (4.42, 4.92, 0.04, 0.02, "frieze"),
              (4.92, H, 0.36, 0.20, "cornice")]
    return bands


PIL_X = (-2.85, 2.85)                       # engaged columns, clear of a door
TICKS = [-4.275, -2.85, -1.425, 0.0, 1.425, 2.85, 4.275]


def _engaged_column(x, z0, z1, mat="marble", r=0.42):
    """Half a Doric column standing out of the wall. The shaft is a full fluted
    ring with its axis on the wall face, so half of it is buried and paid for
    once -- 60 triangles for the thing that makes this read as a temple."""
    h = z1 - z0
    base_h, cap_h, ab_h = 0.26, 0.24, 0.20
    shaft_h = h - base_h - cap_h - ab_h
    y = -T / 2.0
    top = z0 + base_h + shaft_h
    return [
        kit.timber((r * 2.5, T + 0.62, base_h), (x, -0.31, z0 + base_h / 2),
                   (0, 0, 0), mat, 0.045, "pil_base"),
        kit.fluted_shaft(r, r * 0.88, shaft_h, z0 + base_h, x, y, 8, 0.055, mat, "pil_shaft"),
        lib.cone(r * 0.88, r * 0.88 * 1.42, cap_h, (x, y, top + cap_h / 2),
                 verts=16, name="pil_echinus", mat=mat),
        kit.timber((r * 2.7, T + 0.56, ab_h), (x, -0.28, z1 - ab_h / 2),
                   (0, 0, 0), mat, 0.04, "pil_abacus"),
    ]


def _temple_dressing(mat="marble"):
    """Everything applied to a temple panel that is not masonry: the engaged
    columns outside, plain pilaster strips inside so the cella is not one flat
    slab, and the Doric frieze."""
    objs = []
    for x in PIL_X:
        objs += _engaged_column(x, 0.56, 3.88, mat)
        objs.append(kit.timber((0.86, 0.24, 3.32), (x, 0.27, 0.56 + 3.32 / 2),
                               (0, 0, 0), mat, 0.04, "pil_strip"))
    # The profile has to step out monotonically -- frieze .29, taenia .35,
    # triglyph .42, mutule .52, cornice .61. Let the mutule reach as far as the
    # corona and the corona's own edge reads as scalloped instead of straight,
    # which is the difference between ornament and a mistake.
    for t in TICKS:
        objs.append(kit.timber((0.44, 0.22, 0.46), (t, -0.31, 4.67),
                               (0, 0, 0), mat, 0.035, "triglyph"))
        objs.append(kit.timber((0.56, 0.26, 0.12), (t, -0.39, 4.86),
                               (0, 0, 0), mat, 0.025, "mutule"))
    return objs


def build_temple_wall_solid():
    lib.reset()
    p = _courses(_temple_bands(), "marble") + _temple_dressing()
    return kit.deliver(p, "temple_wall_solid")


def build_temple_wall_door():
    lib.reset()
    p = _courses(_temple_bands(), "marble", hole=(MASON / 2.0, DOOR_H))
    p += _doorway("marble", "marble")
    p += _temple_dressing()
    return kit.deliver(p, "temple_wall_door")


def _pier_band(z0, z1, out):
    """A pier band's heights. A band that projects is carried 20 mm past
    the panel's band at both ends -- the plinth 20 mm under the floor too:
    the pier swallows the panel's ends in plan, but at the same heights the
    panel's cornice soffit and the pier's lay in one plane, and so did their
    tops and their feet -- they took turns to be drawn round every corner of
    every stone room."""
    if out > 0:
        z0, z1 = z0 - 0.02, z1 + 0.02
    return z0, z1


def build_temple_corner():
    """The pier that closes two panels. Square in plan and detailed the same on
    all four faces, so it drops into any corner at any yaw. Its bands project
    further than the panel's at every level, which is what lets it swallow the
    panel ends: check `PIER/2 + out_pier > T/2 + out_panel` if you retune them."""
    lib.reset()
    p = []
    bands = [(0.00, 0.30, 0.24), (0.30, 0.56, 0.13),
             (0.56, 1.67, 0.00), (1.67, 2.78, -0.02), (2.78, 3.88, 0.00),
             (3.88, 4.18, 0.06), (4.18, 4.42, 0.10),
             (4.42, 4.92, 0.04), (4.92, H, 0.36)]
    for (z0, z1, out) in bands:
        s = PIER + 2 * out
        z0, z1 = _pier_band(z0, z1, out)
        p.append(kit.slab((s, s, z1 - z0), (0, 0, (z0 + z1) / 2), mat="marble",
                          name="pier", width=0.045))
    # One triglyph on each face: the frieze has to run round the corner or the
    # entablature stops dead at the pier.
    f = PIER / 2.0 + 0.04 + 0.11
    for (x, y) in ((0, -f), (0, f), (-f, 0), (f, 0)):
        p.append(kit.timber((0.44 if y else 0.22, 0.22 if y else 0.44, 0.46),
                            (x, y, 4.67), (0, 0, 0), "marble", 0.035, "triglyph"))
    return kit.deliver(p, "temple_corner")


# --- roofs ----------------------------------------------------------------

def _cover_tiles(span, length, height, z0, thick, eave, verge, mat, limit, n=13,
                 rib=(0.16, 0.10)):
    """The rolls over the joints between pan tiles, running up each slope.

    Built in gable_roof's own frame -- ridge along X, slope along Y -- and
    rotated a quarter with it afterwards. `limit` keeps them clear of the raking
    cornice, which sits on the plane at the gable end and would otherwise have
    ribs growing through it."""
    objs = []
    half = span / 2.0
    pitch = math.atan2(height, half)
    run = half + eave
    L = run / math.cos(pitch)
    zc = z0 + height - height * run / (2 * half)
    lift = thick / (2 * math.cos(pitch))
    dd = thick / 2.0 + rib[1] / 2.0
    for sy in (-1, 1):
        ny, nz = sy * math.sin(pitch), math.cos(pitch)
        for i in range(n):
            px = -limit + 2 * limit * i / float(n - 1)
            objs.append(kit.timber((rib[0], L, rib[1]),
                                   (px, sy * run / 2 + ny * dd, zc + lift + nz * dd),
                                   (-sy * pitch, 0, 0), mat, 0.02, "cover_tile"))
    return objs


R_SPAN, R_RISE, R_EAVE, R_THICK = 13.0, 2.15, 0.2, 0.26

# A pediment's horizontal cornice ends exactly on the roof's datum, and so does
# the top of a wall panel's cornice -- two faces in one plane, both pointing up,
# along the whole gable end. Building the roof 30 mm above its own datum breaks
# that without the caller having to know: still "place it at wall base + 5.2".
ROOF_LIFT = 0.03


def _ceiling(mat, thick, z, beam=0.16):
    """Slab plus two crossing beams, wide enough to bury its edges in the walls."""
    objs = [kit.timber((W + 0.9, W + 0.9, thick), (0, 0, z), (0, 0, 0), mat, 0.05, "ceiling")]
    for s in (-1, 1):
        objs.append(kit.timber((W + 0.9, 0.44, beam), (0, s * W / 4, z - thick / 2 - beam / 2),
                               (0, 0, 0), mat, 0.04, "coffer"))
        objs.append(kit.timber((0.44, W + 0.9, beam), (s * W / 4, 0, z - thick / 2 - beam / 2),
                               (0, 0, 0), mat, 0.04, "coffer"))
    return objs


def _lift(objs, dz):
    bpy.context.view_layer.update()
    M = mathutils.Matrix.Translation((0, 0, dz))
    for obj in objs:
        obj.matrix_world = M @ obj.matrix_world
    return objs


def build_temple_roof():
    """Origin at base centre at EAVES height, so it drops straight on top of a
    ring of panels: put it at the room centre, z = wall base + 5.2.

    Ridge along Y with a pediment at each end, so a pediment faces -Y -- the
    same front the panels use. Turn it a quarter if the main door is on X."""
    lib.reset()
    p = []
    span, rise = R_SPAN, R_RISE
    p += kit.gable_roof(span, span, rise, 0.0, thick=R_THICK, eave=R_EAVE, verge=R_EAVE,
                        mat="marble", trim="marble", tympanum=None, barge=False,
                        fascia=False, along="x", rafters=0, caps=0)
    p += _cover_tiles(span, span, rise, 0.0, R_THICK, R_EAVE, R_EAVE, "marble", 5.55)
    kit.rotate_z(p, math.pi / 2)

    total = span + 2 * R_EAVE
    depth = 0.45
    for sy in (-1, 1):
        p += kit.pediment(span, rise, depth, 0.0, sy * (span / 2 - depth / 2),
                          thick=0.34, mat="marble", trim="marble", along="y")
        # A boss where the sculpture would have gone, and acroteria at the apex
        # and both eaves corners -- the three lumps that give a pediment its
        # outline against the sky.
        p.append(lib.cylinder(0.62, 0.22, (0, sy * (span / 2 + 0.06), rise * 0.42),
                              (math.pi / 2, 0, 0), verts=12, name="boss", mat="marble"))
        p.append(kit.timber((0.46, 0.46, 0.74), (0, sy * (span / 2 - 0.24), rise + 0.37),
                            (0, 0, 0), "marble", 0.06, "acroterion"))
        for sx in (-1, 1):
            p.append(kit.timber((0.42, 0.42, 0.52),
                                (sx * (total / 2 - 0.24), sy * (span / 2 - 0.24), 0.26),
                                (0, 0, 0), "marble", 0.05, "acroterion"))
    # Antefixes closing the tile courses along the two eaves.
    for sx in (-1, 1):
        for i in range(9):
            py = -span / 2 + span * (i + 0.5) / 9
            p.append(kit.timber((0.22, 0.34, 0.36), (sx * (total / 2 + 0.04), py, 0.18),
                                (0, 0, 0), "marble", 0.04, "antefix"))
    # Coffered ceiling. Without it you stand in the room and look out through the
    # eaves gap, which is the one thing a solid model never had to worry about.
    #
    # It hangs *below* the datum, not above it. A roof plane leaves a wedge of
    # daylight over the wall head that widens towards the middle of the room, so
    # a ceiling level with the eaves seals nothing; this one overlaps the top of
    # the wall cornice, which is where a ceiling meets a cornice anyway.
    p += _ceiling("marble", 0.18, -0.14)
    _lift(p, ROOF_LIFT)
    return kit.deliver(p, "temple_roof")


# --- steps and column -----------------------------------------------------

def build_temple_steps():
    """A flight the width of a doorway, rising STEPS * STEP_RISE = 0.45 m.

    Origin at base centre on the ground *outside*, on the wall line: put it at
    the same x/y as the door panel it serves, with the panel 0.45 m higher. The
    treads run out into -Y, the way the panel faces."""
    lib.reset()
    p = []
    w = DOOR_W + 0.7
    depth = STEPS * STEP_GOING
    for i in range(STEPS):
        h = STEP_RISE * (i + 1)
        y1 = -depth + STEP_GOING * i
        p.append(kit.slab((w, -y1, h), (0, y1 / 2.0, h / 2), mat="marble",
                          name="tread", width=0.035))
        for sx in (-1, 1):
            p.append(kit.timber((0.34, -y1, h + 0.28),
                                (sx * (w / 2 + 0.17), y1 / 2.0, (h + 0.28) / 2),
                                (0, 0, 0), "marble", 0.045, "cheek"))
    return kit.deliver(p, "temple_steps")


def build_temple_column():
    """One free-standing column for the interior, 5.2 m over all so its abacus
    lands on the same plane as the wall cornice."""
    lib.reset()
    plinth = 0.22
    p = [kit.slab((1.52, 1.52, plinth), (0, 0, plinth / 2), mat="marble",
                  name="col_plinth", width=0.05)]
    p += kit.column(0, 0, plinth, H - plinth, radius=0.5, flutes=14)
    return kit.deliver(p, "temple_column")


# --- the plain stone kit --------------------------------------------------
#
# The same builders with different bands: a plinth, coursed rubble, a string
# course and a corbelled eaves course. Ordinary enough that every indoor room in
# the world can wear it, and it costs about a fifth of the temple panel.

def _stone_bands():
    lo = [0.26 + (DOOR_H - 0.26) * i / 3.0 for i in range(4)]
    bands = [(0.00, 0.26, 0.22, 0.16, "plinth")]
    for i in range(3):
        r = -0.03 if i == 1 else 0.0
        bands.append((lo[i], lo[i + 1], r, r, "course"))
    bands += [(DOOR_H, 3.86, -0.03, -0.02, "course"),
              (3.86, 4.06, 0.14, 0.10, "string"),
              (4.06, 4.90, 0.0, 0.0, "course"),
              (4.90, H, 0.26, 0.16, "eaves")]
    return bands


def _buttresses(mat="stonewall"):
    """Two stages, the upper set back -- the profile is the whole point, and it
    is what stops 11.4 m of plain wall reading as a flat card."""
    # Their backs stop 50 mm inside the wall. Taken through to the inner face
    # they lay in its plane and flickered through the room side of the wall;
    # 50 rather than 20 because the middle course is recessed 30 mm.
    objs = []
    for x in PIL_X:
        objs.append(kit.timber((1.05, T + 0.57, 2.30), (x, -0.335, 1.15),
                               (0, 0, 0), mat, 0.05, "buttress"))
        objs.append(kit.timber((0.86, T + 0.35, 1.62), (x, -0.225, 2.30 + 0.81),
                               (0, 0, 0), mat, 0.05, "buttress"))
        objs.append(kit.slab((1.15, T + 0.67, 0.16), (x, -0.385, 2.38), mat=mat,
                             name="weathering", width=0.04))
    return objs


def build_wall_solid():
    lib.reset()
    p = _courses(_stone_bands(), "stonewall") + _buttresses()
    return kit.deliver(p, "wall_solid")


def build_wall_door():
    lib.reset()
    p = _courses(_stone_bands(), "stonewall", hole=(MASON / 2.0, DOOR_H))
    # Oak, not `timber`: that recipe is a half-timbered facade -- lime-wash
    # with braces on it -- and on a 0.4 m architrave it came out as a white
    # and brown barber's pole round every stone doorway in the town.
    p += _doorway("stonewall", "oak", sill=True)
    p += _buttresses()
    return kit.deliver(p, "wall_door")


def build_wall_corner():
    lib.reset()
    p = []
    bands = [(0.00, 0.26, 0.22), (0.26, 1.20, 0.00), (1.20, 2.15, -0.02),
             (2.15, 3.10, 0.00), (3.10, 3.86, -0.02), (3.86, 4.06, 0.14),
             (4.06, 4.90, 0.00), (4.90, H, 0.26)]
    for (z0, z1, out) in bands:
        s = PIER + 2 * out
        z0, z1 = _pier_band(z0, z1, out)
        p.append(kit.slab((s, s, z1 - z0), (0, 0, (z0 + z1) / 2), mat="stonewall",
                          name="pier", width=0.045))
    return kit.deliver(p, "wall_corner")


def build_wall_roof():
    """Plain gable roof for the same 11.4 m room, origin at eaves height."""
    lib.reset()
    span, rise = 12.3, 2.9
    p = kit.gable_roof(span, span, rise, 0.0, thick=0.24, eave=0.45, verge=0.34,
                       mat="rooftile", trim="oak", tympanum="stonewall", along="x")
    p += _cover_tiles(span, span, rise, 0.0, 0.24, 0.45, 0.34, "rooftile", 5.6, n=11)
    kit.rotate_z(p, math.pi / 2)
    p += _ceiling("timber", 0.20, -0.15, beam=0.20)
    _lift(p, ROOF_LIFT)
    return kit.deliver(p, "wall_roof")


ASSETS = [
    build_temple_wall_solid, build_temple_wall_door, build_temple_corner,
    build_temple_roof, build_temple_steps, build_temple_column,
    build_wall_solid, build_wall_door, build_wall_corner, build_wall_roof,
]


def build():
    return "\n".join(fn() for fn in ASSETS)


# --- looking at it --------------------------------------------------------

# Where a panel's mid-plane goes, measured from the room centre. build.js runs
# its indoor wall from ROOM/2 = 5.0 out to SHELL = 5.7; putting the 0.5 m panel
# at 5.35 centres it in exactly that band, so the kit occupies the same space the
# procedural box did and the interior comes out 10.2 m clear.
#
# It must NOT be 5.45. That would put each panel's end face at 5.7 in the very
# same plane as the next panel's outer face, both pointing the same way, over
# the whole 5.2 m height. At 5.35 the ends overshoot by 0.1 m instead and the
# corner pier swallows them.
WALL_LINE = 5.35

# side -> (x, y, yaw). Blender yaw; a panel's front is -Y, so east is +90 here.
# In the viewer the same four sides are FACE_ROT = [0, -PI/2, PI, PI/2].
SIDES = {"n": (0.0, -WALL_LINE, 0.0),
         "e": (WALL_LINE, 0.0, math.pi / 2),
         "s": (0.0, WALL_LINE, math.pi),
         "w": (-WALL_LINE, 0.0, -math.pi / 2)}

TEMPLE = {"solid": "temple_wall_solid", "door": "temple_wall_door",
          "corner": "temple_corner", "roof": "temple_roof",
          "steps": "temple_steps"}
STONE = {"solid": "wall_solid", "door": "wall_door",
         "corner": "wall_corner", "roof": "wall_roof", "steps": None}


def mock(parts=None, doors=("n", "s"), floor=0.45, human=True, columns=False):
    """Assemble a room out of the exported .glb files, which is the only way to
    check that what the viewer will load is what was modelled. This function is
    also the assembly recipe: whatever build.js ends up doing, it does this."""
    import os
    parts = parts or TEMPLE
    lib.reset()

    def place(name, x, y, z, yaw=0.0):
        if not name:
            return
        path = os.path.join(lib.ASSETS, "%s.glb" % name)
        if not os.path.exists(path):
            return
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        for obj in set(bpy.context.scene.objects) - before:
            if obj.parent is None:
                # The importer leaves rotation_mode on QUATERNION, and assigning
                # rotation_euler to a quaternion object is silently ignored --
                # location takes, rotation does not, and every panel lands
                # unrotated. North is the only side where that looks right.
                obj.rotation_mode = "XYZ"
                obj.location = (x, y, z)
                obj.rotation_euler = (0, 0, yaw)

    for key, (x, y, yaw) in SIDES.items():
        door = key in doors
        place(parts["door"] if door else parts["solid"], x, y, floor, yaw)
        if door:
            place(parts["steps"], x, y, floor - STEPS * STEP_RISE, yaw)
    for sx in (-1, 1):
        for sy in (-1, 1):
            place(parts["corner"], sx * WALL_LINE, sy * WALL_LINE, floor)
    place(parts["roof"], 0.0, 0.0, floor + H)
    if columns:
        for sx in (-1, 1):
            for sy in (-1, 1):
                place("temple_column", sx * 3.0, sy * 3.0, floor)
    if human:
        kit.human(0.0, -WALL_LINE - 3.2)
    return "mock room: doors %s" % ",".join(doors)
