"""temple -- the Temple of Midgaard, room #3001. The layout is built breadth
first outwards from here, so it is both the centre of the map and the first
thing a player ever sees. It gets the largest budget and the most detail.

A tetrastyle peripteral temple on a three-step crepidoma: twelve fluted columns
round the outside, a full entablature with triglyphs and mutules, a pediment
at each end, and a cella set back far enough behind the front columns to leave
a porch you stand in before you reach the door.

Four columns to a side rather than six is a deliberate choice: six on a 10.5 m
stylobate leaves 1.1 m between shafts, which is not a colonnade you can walk
through, and the player walks through this one. Four puts a 3.1 m gap dead
centre, which is where the 3.2 m doorway goes.

The doorway is left open. The viewer owns what is inside a room; this is the
outside of one.
"""

import math
import importlib

import lib
import kit
importlib.reload(lib)
importlib.reload(kit)

FOOT = 11.9
STEP = 0.26                     # three of these: a crepidoma you can walk up
STYLO = 0.78                    # top of the steps
COL_R = 0.54
COL_H = 5.5
COL_GRID = (4.62, 1.55)         # column centres out from the middle, both axes
ARCH_H, FRIEZE_H, CORN_H = 0.62, 0.58, 0.36
PED_H = 2.1
CELLA_W, CELLA_FRONT, CELLA_BACK = 8.3, -2.35, 4.35
CELLA_T = 0.5
DOOR_W, DOOR_H = 3.2, 3.1


def build():
    lib.reset()
    parts = []
    xs = [-COL_GRID[0], -COL_GRID[1], COL_GRID[1], COL_GRID[0]]

    # --- crepidoma: three steps, all the way round ------------------------
    for i in range(3):
        w = FOOT - i * 0.7
        parts.append(kit.slab((w, w, STEP), (0, 0, STEP * (i + 0.5)), mat="marble",
                              name="crepidoma", width=0.05))

    # --- cella ------------------------------------------------------------
    cella_d = CELLA_BACK - CELLA_FRONT
    cy = (CELLA_FRONT + CELLA_BACK) / 2
    wall_h = STYLO + COL_H
    holes = {"front": [(0, 0, DOOR_W, DOOR_H)]}
    for obj in kit.shell(CELLA_W, cella_d, COL_H, CELLA_T, STYLO, holes,
                         mat="marble", name="cella"):
        obj.location.y += cy
        parts.append(obj)
    cf = kit.faces_of(CELLA_W, cella_d, CELLA_T, STYLO)
    door_loc = (0, cf["front"][1][1] + cy, STYLO)
    # Door surround: jambs, lintel and a worn threshold you step over.
    for sx in (-1, 1):
        parts.append(kit.timber((0.34, CELLA_T + 0.3, DOOR_H + 0.5),
                                (sx * (DOOR_W / 2 + 0.17), door_loc[1], STYLO + (DOOR_H + 0.5) / 2),
                                (0, 0, 0), "marble", 0.05, "jamb"))
    parts.append(kit.timber((DOOR_W + 1.0, CELLA_T + 0.3, 0.48),
                            (0, door_loc[1], STYLO + DOOR_H + 0.24), (0, 0, 0),
                            "marble", 0.06, "lintel"))
    parts.append(kit.timber((DOOR_W + 0.8, CELLA_T + 0.5, 0.1),
                            (0, door_loc[1], STYLO + 0.05), (0, 0, 0), "marble", 0.03, "sill"))
    # Antae: the pilasters that finish the ends of the cella's side walls, and
    # the pair of columns in antis standing between them. Those two are what
    # give the porch any depth -- without them you look straight from the
    # colonnade at a flat wall with a hole in it.
    for sx in (-1, 1):
        parts.append(kit.timber((0.62, 0.62, COL_H),
                                (sx * (CELLA_W / 2 - 0.1), CELLA_FRONT + 0.05, STYLO + COL_H / 2),
                                (0, 0, 0), "marble", 0.05, "anta"))
        parts += kit.column(sx * 2.35, CELLA_FRONT - 0.15, STYLO, COL_H, radius=0.46, flutes=14)

    # Bronze doors, swung inward and standing open. They read as a dark slot
    # from the street, and they do not block the way in.
    for sx in (-1, 1):
        parts.append(kit.timber((DOOR_W / 2 - 0.06, 0.12, DOOR_H - 0.08),
                                (sx * (DOOR_W / 2 - 0.72), door_loc[1] + 0.72,
                                 STYLO + DOOR_H / 2 - 0.04),
                                (0, 0, sx * math.radians(66)), "iron", 0.02, "leaf"))

    # Moulded cornice where the cella wall meets the ceiling, so the wall does
    # not just stop.
    for (span, loc, rot) in ((CELLA_W + 0.3, (0, CELLA_FRONT - 0.05, 0), 0.0),
                             (CELLA_W + 0.3, (0, CELLA_BACK + 0.05, 0), 0.0),
                             (cella_d + 0.3, (-CELLA_W / 2 - 0.05, cy, 0), math.pi / 2),
                             (cella_d + 0.3, (CELLA_W / 2 + 0.05, cy, 0), math.pi / 2)):
        parts.append(kit.timber((span, 0.34, 0.28), (loc[0], loc[1], STYLO + COL_H - 0.2),
                                (0, 0, rot), "marble", 0.05, "cella_cornice"))

    # --- colonnade --------------------------------------------------------
    grid = set()
    for x in xs:
        for y in (-COL_GRID[0], COL_GRID[0]):
            grid.add((x, y))
    for y in xs:
        for x in (-COL_GRID[0], COL_GRID[0]):
            grid.add((x, y))
    for (x, y) in sorted(grid):
        parts += kit.column(x, y, STYLO, COL_H, radius=COL_R, flutes=14)

    # --- entablature ------------------------------------------------------
    ez = STYLO + COL_H
    outer = COL_GRID[0] * 2 + COL_R * 2.7          # architrave follows the abaci
    for (loc, rot) in (((0, -outer / 2, 0), 0.0), ((0, outer / 2, 0), 0.0),
                       ((-outer / 2, 0, 0), math.pi / 2), ((outer / 2, 0, 0), math.pi / 2)):
        parts.append(kit.timber((outer, 0.78, ARCH_H), (loc[0], loc[1], ez + ARCH_H / 2),
                                (0, 0, rot), "marble", 0.05, "architrave"))
        parts.append(kit.timber((outer, 0.68, FRIEZE_H),
                                (loc[0], loc[1], ez + ARCH_H + FRIEZE_H / 2),
                                (0, 0, rot), "marble", 0.04, "frieze"))
        parts.append(kit.timber((outer + 0.9, 1.05, CORN_H),
                                (loc[0], loc[1], ez + ARCH_H + FRIEZE_H + CORN_H / 2),
                                (0, 0, rot), "marble", 0.06, "cornice"))

    # Triglyphs over every column and every gap, with a mutule under the
    # cornice above each one. This is the row that makes it read as Doric.
    ticks = []
    for i in range(len(xs)):
        ticks.append(xs[i])
        if i + 1 < len(xs):
            ticks.append((xs[i] + xs[i + 1]) / 2)
    # The frieze is 0.68 deep, so its outer face is 0.34 out from the wall line:
    # anything at a smaller offset than that is buried in it and invisible.
    for (loc, rot) in (((0, -outer / 2, 0), 0.0), ((0, outer / 2, 0), 0.0),
                       ((-outer / 2, 0, 0), math.pi / 2), ((outer / 2, 0, 0), math.pi / 2)):
        for t in ticks:
            pos = kit.at((loc[0], loc[1], 0), rot, t, 0, -0.42)
            parts.append(kit.timber((0.44, 0.26, FRIEZE_H * 0.96),
                                    (pos[0], pos[1], ez + ARCH_H + FRIEZE_H / 2),
                                    (0, 0, rot), "marble", 0.035, "triglyph"))
            pos = kit.at((loc[0], loc[1], 0), rot, t, 0, -0.46)
            parts.append(kit.timber((0.58, 0.3, 0.13),
                                    (pos[0], pos[1], ez + ARCH_H + FRIEZE_H - 0.05),
                                    (0, 0, rot), "marble", 0.025, "mutule"))

    # --- pediments and roof ------------------------------------------------
    rz = ez + ARCH_H + FRIEZE_H + CORN_H
    span = outer + 0.9
    parts += kit.gable_roof(span, span, PED_H, rz, thick=0.26, eave=0.16, verge=0.0,
                            mat="marble", trim="marble", tympanum=None, barge=False,
                            fascia=False, along="y")
    for sy in (-1, 1):
        parts += kit.pediment(span, PED_H, 0.42, rz, sy * (span / 2 - 0.21),
                              mat="marble", along="y")
        # A boss in the tympanum, in place of the sculpture that would have
        # filled it and that there is no triangle budget on earth for.
        parts.append(lib.cylinder(0.62, 0.22, (0, sy * (span / 2 + 0.02), rz + PED_H * 0.42),
                                  (math.pi / 2, 0, 0), verts=12, name="boss", mat="marble"))
        # Acroteria: apex and both eaves corners.
        parts.append(kit.timber((0.46, 0.46, 0.72), (0, sy * (span / 2 - 0.2), rz + PED_H + 0.36),
                                (0, 0, 0), "marble", 0.06, "acroterion"))
        for sx in (-1, 1):
            parts.append(kit.timber((0.4, 0.4, 0.5),
                                    (sx * (span / 2 - 0.2), sy * (span / 2 - 0.2), rz + 0.25),
                                    (0, 0, 0), "marble", 0.05, "acroterion"))

    # Antefixes along the two eaves, hiding the ends of the tile courses.
    for sx in (-1, 1):
        for i in range(7):
            py = -span / 2 + span * (i + 0.5) / 7
            parts.append(kit.timber((0.22, 0.34, 0.34),
                                    (sx * (span / 2 + 0.06), py, rz + 0.17),
                                    (0, 0, 0), "marble", 0.04, "antefix"))

    return kit.deliver(parts, "temple")
