"""mahntor -- the Keep of Mahn-Tor's two approaches, as the prose has them.

  #2362 "Directly south, set back off the cliff's edge, you see a huge pair of
      gates. These gates appear to be carved almost completely out of ice. A
      huge city and keep appear to be on the other side of these gates." The
      gate's description adds "intricate carvings ... creatures that are half
      man and half bull."  ->  mahntor_gatehouse + mahntor_gate_ice
  #2377 "You stand before a huge keep that has been carved into the side of the
      mountain. Huge wooden gates before you provide entrance to the keep."
      #2379: "high vaulted ceiling carved from solid stone ... The architecture
      appears to be dwarven."  ->  mahntor_keep + mahntor_gate_oak

Conventions are setpiece.py's: Z up, metres, origin on the ground in the plane
the gate's leaves hang in, front at -Y (three's -Z), one object per material
and every surface a `MAT:` tag. The gatehouse and the keep face the room they
are described from; build.js turns them with FACE_ROT like the Midgaard gate.

A LEAF (`mahntor_gate_*`) is hung exactly as props.build_door_leaf is: hinge
edge at x = 0, running out along +X, standing on z = 0, boards in the y = 0
plane. It is built at its own size (3.2 x 7.2) and actors.js scales it to the
opening, so it is not built lean the way the plank leaf is. Both faces are
carved, because the same leaf hangs from the street and from the passage.

The opening's measures are shared with build.js (GRAND_W, GRAND_H there): the
leaves hang on posts at x = +-3.2 and the walls stand back at +-3.6, so a leaf
swung open lies in the reveal and not in the stone.
"""

import math
import importlib

import bpy
import bmesh
import mathutils

import lib
import kit
import furniture as F
import setpiece as S
import desert as D
importlib.reload(lib)
importlib.reload(kit)
importlib.reload(F)
importlib.reload(S)
importlib.reload(D)

V = mathutils.Vector

PAL = {
    "ice": (0.62, 0.80, 0.90, 1.0), "snow": (0.92, 0.94, 0.97, 1.0),
    "dressing": (0.50, 0.50, 0.50, 1.0), "rock": (0.45, 0.43, 0.40, 1.0), "polished": (0.62, 0.64, 0.66, 1.0), "obsidian": (0.02, 0.02, 0.025, 1.0), "crag": (0.36, 0.35, 0.34, 1.0),
    "doorboard": (0.35, 0.22, 0.12, 1.0), "blackstone": (0.10, 0.10, 0.11, 1.0),
}
F.PAL.update(PAL)
S.PAL.update(PAL)

GW = 6.4            # the gate's clear width: two leaves
GH = 7.2            # and their height
POST = 3.6          # half the opening in the wall: the hinge posts take the 0.4 between
THICK = 1.6         # half the wall's thickness (the passage through it is 3.2 m)

block, beam, plate, hull = S.block, S.beam, S.plate, S.hull
# The walls are dark and the dressings pale: black stone round gates of ice,
# and the carvings, cornices and quoins in a cold grey that takes the light.
# Both are baked surfaces of textures.js ("blackstone", "polished").
WALL = "blackstone"
TRIM = "polished"
deliver = S.deliver


def reset(seed):
    S.reset(seed)


# --- the bull ---------------------------------------------------------------

def bull_head(cx, cy, cz, s, face=-1, m="polished", horn=None, name="bull", depth=1.0):
    """A bull's head looking out of a wall: `s` is the width across the brow,
    (cx, cy, cz) the middle of the skull's back against the wall, `face` -1 to
    look out along -Y and +1 along +Y, `depth` how much of its relief stands
    out of the wall (a leaf's heads are shallow, or an open leaf drives them
    into the reveal). Hulls and two lofted horns, a few
    hundred triangles: it is carved from the same stone as the wall it is on.
    Horns go out and then up, which is the only thing that reads as a bull's
    from a distance."""
    horn = horn or m
    out = []

    def P(x, y, z):
        return (cx + x * s, cy + face * y * s * depth, cz + z * s)

    skull = [P(-0.30, 0.00, 0.46), P(0.30, 0.00, 0.46), P(-0.36, 0.00, 0.02), P(0.36, 0.00, 0.02),
             P(-0.30, 0.18, 0.42), P(0.30, 0.18, 0.42), P(-0.32, 0.20, 0.02), P(0.32, 0.20, 0.02),
             P(-0.16, 0.40, -0.52), P(0.16, 0.40, -0.52), P(-0.17, 0.26, -0.62), P(0.17, 0.26, -0.62)]
    out.append(hull(skull, m, name))
    # The muzzle's wet nose, a little broader than the bridge above it.
    out.append(hull([P(-0.19, 0.30, -0.46), P(0.19, 0.30, -0.46), P(-0.2, 0.46, -0.62), P(0.2, 0.46, -0.62),
                     P(-0.15, 0.50, -0.52), P(0.15, 0.50, -0.52), P(-0.17, 0.3, -0.7), P(0.17, 0.3, -0.7)], m, name))
    for sx in (-1, 1):
        # Ears, flat and pointing out under the horns.
        out.append(hull([P(sx * 0.34, 0.02, 0.36), P(sx * 0.34, 0.02, 0.18), P(sx * 0.66, 0.06, 0.34),
                         P(sx * 0.52, 0.10, 0.28), P(sx * 0.34, 0.12, 0.30)], m, name))
        # The horn: a lofted taper rising from the temple, out and then up.
        sec = []
        zs = [0.40, 0.46, 0.55, 0.68, 0.84, 1.02, 1.20]
        xs = [0.32, 0.46, 0.60, 0.70, 0.74, 0.70, 0.60]
        rs = [0.115, 0.105, 0.09, 0.075, 0.055, 0.03, 0.006]
        for z, x, r in zip(zs, xs, rs):
            sec.append((cz + z * s, r * s, r * s * max(depth, 0.6), cx + sx * x * s, cy + face * 0.10 * s * depth))
        h = lib.loft(sec, sides=6, axis="z", name="horn", mat=horn)
        out.append(S.tag(h, horn))
        # Eye sockets, sunk darkly under the brow.
        out.append(block((0.07 * s, 0.05 * s, 0.045 * s), (cx + sx * 0.22 * s, cy + face * 0.20 * s * depth, cz + 0.21 * s),
                         "blackstone", name="eye"))
    # The ring through the nose.
    ring = lib.torus(0.13 * s, 0.014 * s, (cx, cy + face * 0.47 * s * depth, cz - 0.58 * s), (math.pi / 2, 0, 0),
                     major_seg=12, minor_seg=5, name="nose-ring", mat="iron")
    out.append(S.tag(ring, "iron"))
    return out


def colossus(cx, cy, z0, H, face=-1, m="polished", inward=1, flat=0.55):
    """A guardian of the gate, half man and half bull, standing against the
    wall with a spear grounded beside it: blocky and cut from the wall's own
    stone, because at twelve metres it is a silhouette and a shadow. H is the
    height of the horns' tips."""
    p = []
    u = H / 14.0
    f = face

    def at(x, y, z):
        # `flat` presses the figure against the wall: it is seen from the front.
        return (cx + x * u, cy + f * y * u * flat, z0 + z * u)

    for sx in (-1, 1):
        # Legs and the greaves' flare at the foot.
        p.append(beam((1.5 * u, 1.7 * u, 4.6 * u), at(sx * 0.95, 0.9, 2.3), m, cham=0.08 * u, name="leg"))
        p.append(block((1.9 * u, 2.4 * u, 0.6 * u), at(sx * 0.95, 1.1, 0.3), m, name="foot"))
        # Arms, the upper hanging and the fore bent to the spear.
        p.append(beam((1.3 * u, 1.3 * u, 3.0 * u), at(sx * 3.1, 0.9, 8.2), m, cham=0.08 * u, name="arm"))
    p.append(beam((1.2 * u, 1.2 * u, 2.6 * u), at(inward * 3.2, 1.9, 6.1), m, cham=0.08 * u, name="forearm"))
    p.append(beam((1.2 * u, 1.2 * u, 2.4 * u), at(-inward * 3.2, 1.2, 6.2), m, cham=0.08 * u, name="forearm"))
    # The kilt, the belt and the chest.
    p.append(hull([at(-1.9, 0.2, 4.2), at(1.9, 0.2, 4.2), at(-2.3, 2.0, 3.8), at(2.3, 2.0, 3.8),
                   at(-1.7, -0.2, 6.1), at(1.7, -0.2, 6.1), at(-1.9, 1.8, 6.1), at(1.9, 1.8, 6.1),
                   at(-2.2, 0.0, 4.0), at(2.2, 0.0, 4.0)], m, "kilt"))
    p.append(hull([at(-1.9, 0.0, 6.0), at(1.9, 0.0, 6.0), at(-2.7, 0.0, 9.7), at(2.7, 0.0, 9.7),
                   at(-1.8, 1.9, 6.0), at(1.8, 1.9, 6.0), at(-2.8, 1.8, 9.6), at(2.8, 1.8, 9.6),
                   at(-1.0, 1.3, 10.3), at(1.0, 1.3, 10.3)], m, "chest"))
    p.append(beam((6.2 * u, 2.4 * u, 0.5 * u), at(0, 0.9, 6.15), m, cham=0.05 * u, name="belt"))
    # The head: a bull's, bigger than a man's for the distance it is seen from.
    p += bull_head(cx, cy + f * 0.3 * u * flat, z0 + 11.4 * u, 3.2 * u, face=f, m=m, horn=m, name="head", depth=flat)
    # The spear, grounded on the gate's side, its leaf bladed like a halberd's.
    sx_ = inward * 4.3
    p.append(beam((0.32 * u, 0.32 * u, 13.2 * u), at(sx_, 2.9, 6.6), m, cham=0.04 * u, name="shaft"))
    p.append(hull([at(sx_, 2.9, 13.4), at(sx_ - 0.7, 2.9, 12.0), at(sx_ + 0.7, 2.9, 12.0),
                   at(sx_, 2.9, 12.1), at(sx_, 3.3, 12.4), at(sx_, 2.5, 12.4)], m, "blade"))
    return p


def icicles(x0, x1, y, z, n, longest, seed, mat="ice"):
    """Icicles hung from a ledge between x0 and x1, in the front plane y: more
    of them than a single row, in lengths that do not repeat, because a
    regular fringe is a curtain rail."""
    out = []
    for i in range(n):
        t = (i + 0.5) / n
        x = x0 + (x1 - x0) * t + (math.sin(i * 12.9898 + seed) * 0.5) * (x1 - x0) / n * 0.6
        k = 0.35 + 0.65 * abs(math.sin(i * 78.233 + seed * 3.1))
        ln = longest * k
        r = 0.05 + 0.1 * k
        c = lib.cone(r, 0.0, ln, (x, y, z - ln / 2), (math.pi, 0, 0), verts=6, name="icicle", mat=mat)
        out.append(S.tag(c, mat))
    return out


# --- the ice gatehouse ------------------------------------------------------

TOP = 17.0          # the curtain over the gate
TOWER_TOP = 22.0
ARCH_R = 4.4
TW = 2.1            # half a tower's width: 3.8 to 8.0 from the gate's axis, clear of the opening
TCX = 5.9
TY0, TY1 = -3.8, THICK - 0.04   # a tower stands 2.2 m out of the wall's face and ends 4 cm short of its back, which is not its plane


def build_gatehouse():
    """The wall Mahn-Tor's ice gates are set in, and what stands either side of
    them: a curtain 3.2 m thick and 17 m up, a pointed arch over the leaves
    filled with a carved sheet of ice, two square towers standing out in front
    of it to 22 m with their roofs in dark slate under snow, a bull's head over
    the arch with a fringe of icicles under its ledge. It is the end of the
    road, so it is built to be looked up at: nothing in the cell is as tall.

    The leaves (mahntor_gate_ice) hang in the plane y = 0, which is the middle
    of the wall."""
    reset(2362)
    p = []
    D_ = TRIM
    w = POST
    y0, y1 = -THICK, THICK
    # The curtain: one plate with the arch cut up into it, so the soffit of the
    # opening is the plate's own edge and the passage has no seams.
    arch = S.pointed(w, GH, ARCH_R, 8)
    # Its ends 5 cm inside the towers' outer faces and its foot 5 cm under the ground: no two faces are one plane.
    outline = [(-7.95, -0.05), (-w, -0.05)] + arch + [(w, -0.05), (7.95, -0.05), (7.95, TOP), (-7.95, TOP)]
    p.append(plate(outline, y0, y1, WALL, "curtain"))
    # A ring of voussoirs round the arch, proud of the front and the back.
    p += S.arch_ring(w + 0.05, GH, ARCH_R, y0 - 0.09, 0.3, 0.5, D_, n=7, name="voussoir")
    p += S.arch_ring(w + 0.05, GH, ARCH_R, y1 - 0.21, 0.3, 0.5, D_, n=7, name="voussoir")
    # The tympanum: a sheet of ice filling the arch above the leaves, set back
    # from the wall's faces so it reads as a panel in a frame.
    tym = S.pointed(w - 0.02, GH, ARCH_R, 8)
    p.append(plate(tym, -0.5, 0.5, "ice", "tympanum"))
    # The hinge posts, where the leaves hang, and their caps.
    for sx in (-1, 1):
        p.append(beam((0.42, 1.0, GH), (sx * (w - 0.19), 0.0, GH / 2), D_, cham=0.04, name="post"))
        p.append(beam((0.5, 1.15, 0.5), (sx * (w - 0.2), 0.0, GH + 0.25), D_, cham=0.04, name="impost"))
    # The sill, the stone the leaves shut on: flush, a lip a body would catch a
    # toe on is not what a gate has.
    p.append(beam((2 * w, 3.0, 0.1), (0, 0, -0.04), D_, cham=0.02, name="sill"))

    # The towers: a square shaft, a battered foot, a corbelled head with its
    # merlons, a slate roof with a cap of snow.
    depth = TY1 - TY0
    tcy = (TY0 + TY1) / 2
    for sx in (-1, 1):
        cx = sx * TCX
        p.append(beam((2 * TW, depth, TOWER_TOP - 1.0), (cx, tcy, (TOWER_TOP - 1.0) / 2 + 1.0), WALL, cham=0.07, name="shaft"))
        p.append(beam((2 * TW + 0.7, depth + 0.7, 1.0), (cx, tcy, 0.5), D_, cham=0.08, name="foot"))
        p.append(beam((2 * TW + 0.35, depth + 0.35, 0.28), (cx, tcy, 1.14), D_, cham=0.04, name="foot-top"))
        front = TY0 - 0.02
        for zz in (5.0, 9.0, 13.0, 17.0):
            p.append(block((0.34, 0.1, 2.0), (cx, front - 0.0, zz), "obsidian", name="slit"))
            p.append(block((0.1, 0.34, 2.0), (cx + sx * (TW + 0.02), tcy - 1.0, zz), "obsidian", name="slit"))
        for zz in (11.0, TOWER_TOP - 1.3):
            p.append(beam((2 * TW + 0.4, depth + 0.4, 0.4), (cx, tcy, zz), D_, cham=0.05, name="string"))
        p.append(beam((2 * TW + 1.0, depth + 1.0, 0.7), (cx, tcy, TOWER_TOP - 0.35), D_, cham=0.06, name="corbel"))
        p.append(beam((2 * TW + 0.7, depth + 0.7, 0.4), (cx, tcy, TOWER_TOP + 0.2), D_, cham=0.05, name="walk"))
        for k in range(4):
            xx = cx + (k - 1.5) * 0.9
            for yy in (TY0 - 0.05, tcy + (depth + 0.7) / 2 - 0.3):
                p.append(block((0.55, 0.5, 0.8), (xx, yy, TOWER_TOP + 0.4 + 0.4), WALL, name="merlon"))
        for k in range(1, 4):
            yy = (TY0 - 0.05) + k * ((tcy + (depth + 0.7) / 2 - 0.3) - (TY0 - 0.05)) / 4
            for xx in (cx - TW - 0.3, cx + TW + 0.3):
                p.append(block((0.5, 0.55, 0.8), (xx, yy, TOWER_TOP + 0.8), WALL, name="merlon"))
        # The roof: a low pyramid over the crown in slate, its apex heavy with snow.
        rb = (TW, depth / 2 - 0.1)
        rz = TOWER_TOP + 0.4
        p.append(hull([(cx - rb[0], tcy - rb[1], rz), (cx + rb[0], tcy - rb[1], rz),
                       (cx - rb[0], tcy + rb[1], rz), (cx + rb[0], tcy + rb[1], rz),
                       (cx, tcy, rz + 5.6)], WALL, "roof"))
        p.append(hull([(cx - 0.9, tcy - 1.1, rz + 3.6), (cx + 0.9, tcy - 1.1, rz + 3.6),
                       (cx - 0.9, tcy + 1.1, rz + 3.6), (cx + 0.9, tcy + 1.1, rz + 3.6),
                       (cx, tcy, rz + 5.75)], "snow", "snowcap"))
        # The icicles under the corbel table, on the front only.
        p += icicles(cx - TW, cx + TW, TY0 - 0.5, TOWER_TOP - 0.7, 7, 1.9, sx + 3)
    # The wall walk over the gate: a parapet on the front and merlons along it,
    # a rail along the back.
    p.append(beam((7.8, 0.7, 0.9), (0, y0 + 0.35, TOP + 0.45), D_, cham=0.05, name="parapet"))
    p += S.merlons_line(-3.6, 3.6, y0 + 0.35, TOP + 0.9, 1.0, 1.0, 0.7, WALL, 2.2)
    p.append(beam((7.8, 0.4, 0.6), (0, y1 - 0.2, TOP + 0.3), WALL, cham=0.04, name="rail"))
    # A ledge across the front above the arch, with its fringe of icicles, and
    # the bull's head over it: the half man and half bull the carvings show.
    ledge_z = GH + 5.1
    p.append(beam((7.8, 0.9, 0.5), (0, y0 - 0.2, ledge_z), D_, cham=0.04, name="ledge"))
    p += icicles(-w + 0.6, w - 0.6, y0 - 0.5, ledge_z - 0.25, 15, 2.3, 7)
    p += bull_head(0, y0 - 0.02, ledge_z + 2.3, 3.0, face=-1, m=TRIM, horn="ice", name="bull")
    # The bull in the tympanum, in ice, small and sharp under the ledge: the
    # carving the gate's own description names. Both faces.
    p += bull_head(0, -0.5, GH + 1.3, 1.9, face=-1, m="ice", horn="ice", name="tym-bull", depth=0.6)
    p += bull_head(0, 0.5, GH + 1.3, 1.9, face=1, m="ice", horn="ice", name="tym-bull", depth=0.6)
    # Snow lying on the ledge and along the wall walk, where nothing sweeps it.
    p.append(beam((7.4, 0.5, 0.2), (0, y0 - 0.1, ledge_z + 0.3), "snow", cham=0.06, name="snow"))
    p.append(beam((7.2, 0.5, 0.2), (0, y0 + 0.35, TOP + 0.95), "snow", cham=0.06, name="snow"))
    return deliver(p, "mahntor_gatehouse")


# --- the ice gate's leaf -----------------------------------------------------

def _field(x0, x1, z0, z1, y, t, m="ice"):
    """A raised frame round a sunk field: four beams, 8 cm proud."""
    out = []
    w = 0.16
    out.append(beam((x1 - x0, t, w), ((x0 + x1) / 2, y, z0 + w / 2), m, cham=0.025, name="rail"))
    out.append(beam((x1 - x0, t, w), ((x0 + x1) / 2, y, z1 - w / 2), m, cham=0.025, name="rail"))
    out.append(beam((w, t, z1 - z0 - 2 * w + 0.01), (x0 + w / 2, y, (z0 + z1) / 2), m, cham=0.025, name="stile"))
    out.append(beam((w, t, z1 - z0 - 2 * w + 0.01), (x1 - w / 2, y, (z0 + z1) / 2), m, cham=0.025, name="stile"))
    return out


def build_gate_ice():
    """One leaf of the ice gates: a slab of clear ice in a frame of thicker
    ice, three fields to a face -- a lozenge of studs below, the bull's head
    in the middle, a band of horns above -- bound with iron straps off the
    hinge edge and a ring on the meeting stile. 3.2 m by 7.2."""
    reset(2363)
    p = []
    W, H = 3.2, GH
    p.append(beam((W - 0.06, 0.26, H - 0.06), (W / 2, 0.0, H / 2), "ice", cham=0.04, name="slab"))
    # The frame stands proud of the slab on both faces.
    for sy in (-1, 1):
        y = sy * 0.17
        # Outer frame, then the three fields inside it.
        p += _field(0.0, W, 0.0, H, y, 0.12)
        for (z0, z1) in ((0.26, 2.5), (2.62, 5.3), (5.42, H - 0.26)):
            p += _field(0.26, W - 0.26, z0, z1, y + sy * 0.004, 0.1)
        # The bull's head in the middle field, looking out of the face.
        p += bull_head(W / 2, sy * 0.2, 3.95, 1.55, face=sy, m="ice", horn="ice", name="bull", depth=0.4)
        # Studs in the lower field, a lozenge of them.
        for i in range(5):
            for j in range(3):
                if (i + j) % 2:
                    continue
                xx = 0.66 + i * 0.47
                zz = 0.78 + j * 0.62
                p.append(S.tag(lib.cone(0.1, 0.0, 0.16, (xx, sy * 0.28, zz), (-sy * math.pi / 2, 0, 0), verts=4,
                                        name="stud", mat="ice"), "ice"))
        # A band of small horns across the top field.
        for i in range(4):
            xx = 0.62 + i * 0.66
            p += bull_head(xx, sy * 0.2, 6.12, 0.52, face=sy, m="ice", horn="ice", name="bullet", depth=0.4)
    # Iron: three straps off the hinge edge on each face, a knuckle on each,
    # the big ring on the meeting stile.
    for z in (1.0, 3.95, 6.7):
        for sy in (-1, 1):
            p.append(beam((1.9, 0.05, 0.22), (0.95, sy * 0.275, z), "iron", cham=0.012, name="strap"))
        p.append(S.tag(lib.cylinder(0.12, 0.62, (0.03, 0.0, z), verts=8, name="knuckle", mat="iron"), "iron"))
    for sy in (-1, 1):
        p.append(S.tag(lib.torus(0.3, 0.04, (W - 0.52, sy * 0.36, 3.55), (math.pi / 2, 0, 0),
                                 major_seg=14, minor_seg=6, name="ring", mat="iron"), "iron"))
        p.append(beam((0.3, 0.05, 0.3), (W - 0.52, sy * 0.3, 3.9), "iron", cham=0.01, name="rose"))
    return deliver(p, "mahntor_gate_ice")


# --- the keep ---------------------------------------------------------------

KEEP_DEPTH = 13.0    # the passage runs to the entry hall's outer wall, 13.1 m behind the leaves
FACADE_W = 9.8
FACADE_TOP = 24.5
FACE = 2.4           # how far the facade stands out of the rock's face... measured from the leaves' plane
PLINTH = 4.1         # and how far its wings' plinths do


def _tunnel_cutter(depth):
    """The prism the gate passage is cut by, along Y: a rectangle with its
    top corners splayed in a dwarf's chamfer, 7.2 m wide and 8.2 high."""
    hw, top = POST, 8.2
    prof = [(-hw, 0.0), (-hw, top - 0.5), (-hw + 0.5, top), (hw - 0.5, top), (hw, top - 0.5), (hw, 0.0)]
    verts = [(x, -12.0, z - 0.4) for (x, z) in prof] + [(x, depth + 4.0, z - 0.4) for (x, z) in prof]
    n = len(prof)
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, j + n, i + n))
    me = bpy.data.meshes.new("cutter")
    me.from_pydata(verts, [], faces)
    me.update()
    cutter = bpy.data.objects.new("cutter", me)
    bpy.context.collection.objects.link(cutter)
    return cutter


def _mountain():
    """The mass the keep is carved from: 36 m across, 34 high, from just
    behind the facade to the entry hall's wall, with the gate passage driven
    through it by a boolean as massif_mouth's is. Its bulges are noise, and
    its foot is the desert's scree apron."""
    w, d, h = 36.0, KEEP_DEPTH + 0.2, 34.0
    block_ = D.displaced_block(w, d, h, 26, 22377, 2.6, "mountain", "rock", crag=4.2, talus=1.2, erode=0.22)
    # displaced_block centres on the origin; the face goes where the facade's
    # back is and the far end at the entry hall.
    block_.location = (0.0, -0.2 + d / 2, 0.0)
    bpy.context.view_layer.objects.active = block_
    block_.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    cutter = _tunnel_cutter(KEEP_DEPTH)
    mod = block_.modifiers.new("cut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    mod.solver = "EXACT"
    bpy.context.view_layer.objects.active = block_
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    for poly in block_.data.polygons:
        poly.use_smooth = True
    return block_


def build_keep():
    """The Keep of Mahn-Tor's face: a mountain with a facade cut into it, the
    huge wooden gates in a portal under a lintel and a stepped relieving
    corbel, a colossal bull-headed guardian either side of it, a frieze of
    bulls' heads under the cornice and a row of slits above, and the gate
    passage driven 13 m into the rock to the entry hall's wall. The
    architecture is dwarven, as #2379 says: square, heavy, plain-faced and deep.

    Its own measures: the leaves hang in the plane y = 0; the facade stands
    2.4 m out of the rock's face, the wings' plinths 4.1; the passage is 7.2 m
    wide (the leaves' 6.4 and a hinge post each side) and 8.2 high."""
    reset(2377)
    p = []
    D_ = TRIM
    w = POST
    p.append(_mountain())
    # The facade: one plate, 19.6 m across and 24.5 high, with the portal cut
    # up out of its foot. Its back is 0.2 m inside the rock.
    outline = [(-FACADE_W, 0.0), (-w, 0.0), (-w, 8.2), (w, 8.2), (w, 0.0), (FACADE_W, 0.0),
               (FACADE_W, FACADE_TOP), (-FACADE_W, FACADE_TOP)]
    p.append(plate(outline, -FACE, -0.2, WALL, "facade"))
    # The wings' plinths, which the piers and the guardians stand on. Not
    # across the portal: the way in is flush with the ground.
    for sx in (-1, 1):
        x0, x1 = (w, FACADE_W + 0.4) if sx > 0 else (-FACADE_W - 0.4, -w)
        p.append(beam((x1 - x0, PLINTH - FACE + 0.1, 1.1), ((x0 + x1) / 2, -(PLINTH + FACE) / 2 + 0.05, 0.55), D_, cham=0.08, name="plinth"))
    # The portal: two piers either side of the opening, proud of the facade,
    # a lintel across them, the stepped relieving corbels over it.
    py = -FACE - 0.7
    for sx in (-1, 1):
        p.append(beam((1.96, 1.4, 7.7), (sx * (w + 1.03), py, 1.1 + 3.85), D_, cham=0.1, name="pier"))
        p.append(beam((2.3, 1.6, 0.6), (sx * (w + 1.03), py, 8.8 + 0.3), D_, cham=0.06, name="pier-cap"))
    p.append(beam((2 * w + 4.8, 1.8, 1.5), (0, -FACE - 0.9, 9.4 + 0.75), D_, cham=0.1, name="lintel"))
    for k, (ww, zz) in enumerate(((2 * w + 3.6, 11.6), (2 * w + 2.2, 12.5), (2 * w + 0.8, 13.4))):
        p.append(beam((ww, 1.4 - 0.1 * k, 0.9), (0, -FACE - 0.7 + 0.1 * k, zz), D_, cham=0.05, name="corbel"))
    # Over them, in a sunk panel of dark stone, the carved bull: 4.6 m across.
    p.append(beam((9.0, 0.5, 5.4), (0, -FACE - 0.05, 17.2), "obsidian", cham=0.06, name="panel"))
    p += bull_head(0, -FACE - 0.3, 17.0, 4.6, face=-1, m=D_, horn=D_, name="bull")
    # The guardians, one in each wing of the facade, spear to the gate.
    for sx in (-1, 1):
        p += colossus(sx * 7.7, -FACE - 0.1, 1.1, 12.0, face=-1, inward=-sx)
    # Cornice and a frieze of small heads along the foot of the upper register.
    p.append(beam((2 * FACADE_W + 1.0, 1.1, 0.9), (0, -FACE - 0.4, 19.8), D_, cham=0.06, name="cornice"))
    for k in range(9):
        xx = (k - 4) * 2.2
        if abs(xx) < 4.5:
            continue
        p += bull_head(xx, -FACE - 0.05, 20.6, 1.2, face=-1, m=D_, horn=D_, name="frieze")
    # Slits above the cornice, arrow loops for the guards who have gone indoors.
    for sx in (-1, 1):
        for xx in (5.2, 7.4, 9.1):
            p.append(block((0.6, 0.18, 1.9), (sx * xx, -FACE - 0.02, 22.4), "obsidian", name="slit"))
    # The top: a cornice with merlons, so the facade ends in a wall-walk the
    # mountain rises behind.
    p.append(beam((2 * FACADE_W + 1.0, 1.6, 0.9), (0, -FACE - 0.5, FACADE_TOP + 0.45), D_, cham=0.06, name="top-cornice"))
    for k in range(10):
        xx = (k - 4.5) * 2.1
        p.append(block((1.2, 0.8, 1.0), (xx, -FACE - 0.2, FACADE_TOP + 1.4), WALL, name="merlon"))
    p.append(beam((2 * FACADE_W - 1.0, 0.9, 0.22), (0, -FACE - 0.2, FACADE_TOP + 1.0), "snow", cham=0.05, name="snow"))
    # The posts the leaves hang on, and the sill they shut on.
    for sx in (-1, 1):
        p.append(beam((0.4, 1.1, GH), (sx * (w - 0.2), 0.0, GH / 2), D_, cham=0.04, name="post"))
    p.append(beam((2 * w, 2.4, 0.1), (0, -0.2, -0.04), D_, cham=0.02, name="sill"))
    return deliver(p, "mahntor_keep")


# --- the keep's leaf ---------------------------------------------------------

def build_gate_oak():
    """One leaf of the keep's wooden gates: seven planks of oak 7.2 m high on
    two faces, three heavy bands of timber across them, iron straps off the
    hinge edge with their knuckles, studs along the bands and a ring the size
    of a wheel on the meeting stile. 3.2 m by 7.2."""
    reset(2378)
    p = []
    W, H = 3.2, GH
    n = 7
    bw = W / n
    for i in range(n):
        jit = ((i * 2654435761) % 7 - 3) * 0.004
        p.append(beam((bw - 0.012, 0.3, H), (bw / 2 + i * bw, jit, H / 2), "doorboard", cham=0.02, name="plank"))
    for sy in (-1, 1):
        for z in (0.55, 3.6, 6.65):
            p.append(beam((W - 0.04, 0.12, 0.42), (W / 2, sy * 0.21, z), "oak", cham=0.03, name="band"))
            for i in range(n):
                p.append(S.tag(lib.cone(0.075, 0.03, 0.08, (bw / 2 + i * bw, sy * 0.28, z), (-sy * math.pi / 2, 0, 0),
                                        verts=6, name="stud", mat="iron"), "iron"))
            p.append(beam((2.2, 0.05, 0.3), (1.1, sy * 0.29, z), "iron", cham=0.015, name="strap"))
        p.append(S.tag(lib.torus(0.34, 0.05, (W - 0.5, sy * 0.4, 3.4), (math.pi / 2, 0, 0),
                                 major_seg=14, minor_seg=6, name="ring", mat="iron"), "iron"))
        p.append(beam((0.36, 0.06, 0.36), (W - 0.5, sy * 0.33, 3.8), "iron", cham=0.012, name="rose"))
        for z in (0.2, H - 0.2):
            p.append(beam((0.6, 0.05, 0.36), (0.3, sy * 0.28, z), "iron", cham=0.01, name="plate"))
    for z in (0.55, 3.6, 6.65):
        p.append(S.tag(lib.cylinder(0.14, 0.7, (0.03, 0.0, z), verts=8, name="knuckle", mat="iron"), "iron"))
    return deliver(p, "mahntor_gate_oak")


# --- the cliff's lip ----------------------------------------------------------

def _boulder(cx, cy, cz, rx, ry, rz, seed, m="crag"):
    """A rounded, lopsided boulder, smooth-shaded: a loft of seven rings whose
    points are pushed in and out by a hash of where they are, so no two of
    them are alike and none has the flat facets of a hull -- those read as
    crystal, which a cliff's rubble is not. Sunk a third into the ground."""
    prof = [(0.00, 0.55), (0.14, 0.92), (0.38, 1.0), (0.62, 0.88), (0.80, 0.62), (0.93, 0.32), (1.00, 0.08)]
    sec = [(cz - rz * 0.35 + rz * 1.35 * t, rx * r, ry * r, cx, cy) for t, r in prof]
    obj = lib.loft(sec, sides=10, axis="z", name="boulder", mat=m)
    for v in obj.data.vertices:
        k = 1.0 + 0.2 * math.sin(v.co.x * 5.1 + seed) * math.cos(v.co.y * 4.3 + seed * 1.7) \
            + 0.12 * math.sin(v.co.z * 6.7 + seed * 0.7)
        v.co.x = cx + (v.co.x - cx) * k
        v.co.y = cy + (v.co.y - cy) * k
    obj.data.update()
    lib.shade_smooth(obj)
    return S.tag(obj, m)


def build_rim():
    """The lip of the cliff at #2362: "You stand at the edge of a high cliff."
    A run of broken rock 6.75 m long and 2 m deep, standing a metre and a
    half at its highest, so that the edge can be seen over it and the drop
    beyond it, which a hedge two metres thick made nothing of. build.js lays
    it along the sides of the cliff's room that are not a way out, in pieces
    that lap, stretched to the side's length like the hedge row. Snow on the
    tops, where nothing sweeps it."""
    reset(2361)
    p = []
    n = 9
    for i in range(n):
        t = (i + 0.5) / n
        x = -3.375 + 6.75 * t
        j = math.sin(i * 7.31) * 0.5
        h = 0.55 + 0.45 * abs(math.sin(i * 3.7 + 1.0))
        wd = 0.95 + 0.4 * abs(math.sin(i * 5.3))
        p.append(_boulder(x, j * 0.5, h * 0.6 - 0.15, wd, 0.8 + 0.3 * abs(math.sin(i * 2.9)), h * 0.95, i * 1.3))
        if i % 2 == 0:
            # A second, smaller stone leaning on the first, on the cliff side.
            p.append(_boulder(x + 0.5, -0.65 + j * 0.3, 0.25, 0.55, 0.5, 0.45, i * 2.1 + 5))
        if i % 3 == 1:
            p.append(hull([(x - 0.5, j * 0.5 - 0.3, h * 1.4 - 0.3), (x + 0.5, j * 0.5 - 0.3, h * 1.4 - 0.3),
                           (x - 0.5, j * 0.5 + 0.3, h * 1.4 - 0.3), (x + 0.5, j * 0.5 + 0.3, h * 1.4 - 0.3),
                           (x, j * 0.5, h * 1.4 + 0.1)], "snow", "snow"))
    return deliver(p, "mahntor_rim")


BUILDERS = {
    "mahntor_gatehouse": build_gatehouse,
    "mahntor_gate_ice": build_gate_ice,
    "mahntor_keep": build_keep,
    "mahntor_gate_oak": build_gate_oak,
    "mahntor_rim": build_rim,
}


def build(only=None):
    out = []
    for name, fn in BUILDERS.items():
        if only and name not in only:
            continue
        out.append(fn())
    return "\n".join(out)
