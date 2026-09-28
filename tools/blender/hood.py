"""hood -- Raff's Dangerous Neighborhood: a district of the town the gangs
have fought over until it fell down.

Everything here is read off the area's own prose (merc21/area/hood.are):

* "All the shops and homes have been boarded up and abandoned" --
  `house_derelict`, a house with its openings nailed shut and a hole in its
  roof, and `boarded_window` / `boarded_door` for the frontage build.js
  brings forward along the street.
* "On the southwest corner of this intersection, it looks like a building was
  recently burned down" -- `house_gutted`, a burnt-out shell: walls standing
  to broken heads, no roof, the rafters come down into the ash.
* "The remains of the magic shop", "What is left of the weaponshop", "what
  USED to be the armory ... The back wall of the building has been bashed
  down" -- `ruin_wall_solid`, `ruin_wall_door`, `ruin_wall_breach` and
  `ruin_corner`, a room kit on the same 11.4 m grid as roomkit.py's, for a
  room with no roof left on it.
* No Man's Land, "where the violence starts" -- `barricade`,
  `barricade_stakes`, `burnt_cart`, `rubble_heap`, `charred_beams`, `crow`.
* The gangs' own places: `brazier` for the fires they keep, the Dracolich
  Plaza's `dracolich_idol` and `training_pell` ("renamed in honor of the
  Dragon gang's idol, the Dracolich. It has become sort of a training
  ground"), Khan Park's `khan_memorial` ("some kind of memorial to the great
  Mongol warrior Khan being crudely constructed here").
* The overgrown lot and the dead courtyards: `bramble`, `tall_weeds`,
  `collapsed_shed`, `dead_planter`, `broken_stair` ("the set is missing
  stairs 3-15").
* Ice Dragon Way's "smashed crystal statues": `crystal_stump`.
* Wall Road, "along the inside of the wall surrounding the city":
  `city_wall`, a 13 m run of curtain wall.
* "There is a barred window to the north. There appears to be a light coming
  from the cracks around it": `barred_window`.
* "The building could collapse at any moment": `shoring`.

Every model stands with its origin on the ground, front to -Y (three's -Z,
which build.js turns with FACE_ROT). Geometry only, as everywhere: surfaces
are the viewer's -- `sootwall`, `charred`, `boards`, `ash`, `crystal` and
`oldbone` are recipes in src/textures.js made for this district.
"""

import math
import random
import importlib

import bpy
import mathutils

import lib
import kit
import trees
importlib.reload(lib)
importlib.reload(kit)
importlib.reload(trees)


# --- helpers ----------------------------------------------------------------

def rng_for(seed):
    return random.Random(seed)


def broken_run(x0, x1, y, t, heights, mat="sootwall", holes=(), step=0.36, course=0.3,
               name="run", z0=0.0, jag=0.45, seed=0, least=None):
    """A length of masonry from x0 to x1 (centred on y, `t` thick) whose head
    has come down. `heights(x)` gives the standing height at x; it is cut into
    columns `step` wide and each is rounded down to a whole course, so the
    broken head steps the way a rubble wall really fails -- along its beds.

    `holes` are (cx, sill, width, head) openings: a column inside one keeps
    only what is under the sill and what is over the head, if the wall stands
    that high there."""
    objs = []
    r = rng_for(seed * 7919 + int((x0 + 100) * 13))
    # Stones of their own lengths, not a fixed pitch: equal columns stepping
    # one course up and down are merlons, and the burnt weaponshop's walls
    # came out as a castle's battlements -- reported. A mason's run has long
    # stones and short ones.
    edges = [x0]
    while edges[-1] < x1 - 1e-6:
        edges.append(min(x1, edges[-1] + step * r.uniform(0.7, 2.1)))
    if len(edges) > 2 and edges[-1] - edges[-2] < step * 0.5:
        edges.pop(-2)
    # The head wanders slowly -- a walk on knots a metre or two apart, eased
    # between them -- so where it steps it steps down a slope, a run of
    # stones at one height and then the next course, never alternating.
    knots = []
    kx = x0 - 1.0
    while kx < x1 + 2.0:
        knots.append((kx, r.uniform(-1.0, 1.0) * jag * 2.2))
        kx += r.uniform(0.9, 2.2)

    def wander(x):
        for (ka, va), (kb, vb) in zip(knots, knots[1:]):
            if ka <= x <= kb:
                f = (x - ka) / (kb - ka)
                f = f * f * (3 - 2 * f)
                return va + (vb - va) * f
        return 0.0
    capped = False
    for i in range(len(edges) - 1):
        xa, xb = edges[i], edges[i + 1]
        w = xb - xa
        xc = (xa + xb) / 2
        want = heights(xc)
        # Mostly lower than the profile, rarely above it: a wall loses stones.
        wv = wander(xc)
        cur = want + (wv if wv < 0 else wv * 0.3) * min(1.0, max(0.2, want / 2.4))
        # Now and then a stone is missing from the top course, singly.
        if r.random() < 0.14 and cur > course * 3:
            cur -= course
        h = max(course, math.floor(cur / course) * course)
        if least:
            h = max(h, least(xc))
        spans = [(0.0, h)]
        for (cx, sill, ow, head) in holes:
            if abs(xc - cx) < ow / 2:
                spans = []
                if sill > 0.02:
                    spans.append((0.0, min(sill, h)))
                if h > head + 0.05:
                    spans.append((head, h))
        for (za, zb) in spans:
            if zb - za < 0.05:
                continue
            objs.append(lib.box((w + 0.002, t, zb - za), (xc, y, z0 + (za + zb) / 2), name=name, mat=mat))
            # The last stone on a broken head sits where it was left: shorter
            # than the run under it, a little proud or back, a little canted.
            # Never two side by side: a row of loose stones on a level head
            # is the crenellation again.
            capped = not capped and zb == h and h > course * 2 and w > 0.3 and r.random() < 0.3
            if capped:
                sw = w * r.uniform(0.45, 0.9)
                objs.append(lib.box((sw, t * r.uniform(0.7, 0.95), course * r.uniform(0.55, 0.9)),
                                    (xa + r.uniform(0, w - sw) + sw / 2, y + r.uniform(-0.05, 0.05), z0 + h + course * 0.3),
                                    (r.uniform(-0.06, 0.06), r.uniform(-0.1, 0.1), r.uniform(-0.05, 0.05)),
                                    name=name, mat=mat))
    return objs


def board(length, width, loc, rot, mat="boards", thick=0.035, name="board"):
    """One rough board. `rot` is a full Euler, so a board can lie askew across
    an opening -- nobody boarding up a house in a hurry nails them level."""
    return kit.timber((length, thick, width), loc, rot, mat, 0.008, name)


def board_up(cx, cz, ow, oh, face_y, rng, n=None, mat="boards"):
    """Boards nailed across an opening in a wall whose outer face is at
    `face_y` (the wall runs along X, outward is -Y). Horizontal-ish, each a
    little longer than the hole so its ends lie on the masonry, each at its
    own small tilt; a gap here and there, because there were never quite
    enough boards."""
    objs = []
    n = n or max(2, int(oh / 0.34))
    pitch = oh / n
    for i in range(n):
        if i and rng.random() < 0.18:
            continue
        z = cz + pitch * (i + 0.5) + rng.uniform(-0.05, 0.05)
        tilt = rng.uniform(-0.12, 0.12)
        L = ow + rng.uniform(0.3, 0.55)
        objs.append(board(L, pitch * rng.uniform(0.72, 0.9),
                          (cx + rng.uniform(-0.1, 0.1), face_y - 0.03 - i * 0.004, z),
                          (0, tilt, 0), mat))
    # One brace across the lot, the way a door is made to hold.
    if oh > 1.4:
        ang = math.atan2(oh * 0.8, ow)
        objs.append(board(math.hypot(ow, oh * 0.8) + 0.2, 0.16,
                          (cx, face_y - 0.075, cz + oh / 2), (0, -ang if rng.random() < 0.5 else ang, 0), mat))
    return objs


def chunk_stone(rng, loc, size, mat="sootwall", name="stone"):
    """A fallen block: a squared stone with its arrises knocked off, lying at
    whatever angle it landed."""
    a, b, c = size
    return kit.slab((a, b, c), loc, (rng.uniform(-0.4, 0.4), rng.uniform(-0.4, 0.4),
                                      rng.uniform(0, math.pi)), mat=mat, name=name, width=min(a, b, c) * 0.18)


def heap(rng, w, d, h, sides=16, mat="ash", name="heap"):
    """A low mound of debris: a hull pressed flat, a little lopsided."""
    rings = []
    for k in range(5):
        t = k / 4
        prof = (1.0 - t ** 1.7) * (1.0 + 0.12 * math.sin(t * math.pi))
        rings.append((h * t, max(0.03, prof * 0.5), rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04)))
    obj = trees.hull(rings, sides, [rng.uniform(-0.16, 0.16) for _ in range(sides)], mat=mat, name=name)
    obj.scale = (w, d, 1.0)
    lib.shade_smooth(obj, 50)
    return obj


def rubble_spill(rng, cx, cy, w, d, h, stones=14, mat="rubble", core="rubble", timber=2):
    """Masonry come down in a heap: a core of broken stuff and ash with
    squared stones lying on it and at its foot, and a charred stick or two."""
    objs = [heap(rng, w, d, h, mat=core)]
    objs[0].location = (cx, cy, 0)
    for i in range(stones):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.0, 0.62)
        x = cx + math.cos(a) * r * w
        y = cy + math.sin(a) * r * d
        z = h * max(0.0, 1.0 - (r / 0.62) ** 1.6) * 0.85
        s = rng.uniform(0.22, 0.46)
        objs.append(chunk_stone(rng, (x, y, z + s * 0.2), (s * 1.5, s, s * 0.8), mat))
    for i in range(timber):
        a = rng.uniform(0, math.pi)
        L = rng.uniform(1.2, 2.2)
        objs.append(kit.timber((L, 0.16, 0.14), (cx + rng.uniform(-0.3, 0.3) * w, cy + rng.uniform(-0.3, 0.3) * d,
                                                 h * 0.5), (rng.uniform(-0.3, 0.3), rng.uniform(-0.25, 0.25), a),
                               "charred", 0.03, "stick"))
    return objs


def pitched(span, length, height, z0, thick=0.22, eave=0.5, verge=0.45, hole=None, mat="rooftile",
            trim="oak", rafter_mat="oak", rafters=8):
    """A gable roof with the option of a hole in its front slope.

    `hole` is (x0, x1, keep): along the ridge from x0 to x1 the front slope
    keeps only the lowest `keep` of its run, and what shows through the gap
    is rafters -- the battens and tiles have gone and the frame has not.
    The ridge runs along X; the front slope faces -Y."""
    objs = []
    half = span / 2
    pitch = math.atan2(height, half)
    run = half + eave
    total = length + 2 * verge
    drop = height * eave / half
    lift = thick / (2 * math.cos(pitch))

    def slope(sy, xa, xb, f0, f1):
        # A strip of one slope from f0 to f1 of the run (0 at the eave).
        L = run / math.cos(pitch)
        la, lb = L * f0, L * f1
        mid = (la + lb) / 2
        # position along the slope from the eave line
        ex, ez = half + eave, z0 - drop
        py = sy * (ex - mid * math.cos(pitch))
        pz = ez + mid * math.sin(pitch) + lift
        return kit.timber((xb - xa, lb - la, thick), ((xa + xb) / 2, py, pz),
                          (-sy * pitch, 0, 0), mat, 0.04, "roof")

    for sy in (-1, 1):
        if hole and sy == -1:
            x0, x1, keep = hole
            objs.append(slope(sy, -total / 2, x0, 0, 1))
            objs.append(slope(sy, x1, total / 2, 0, 1))
            # The edge of the hole is ragged: the tiling came away in strips,
            # further down in some than others, and a scrap is left up by the
            # ridge.
            k = 4
            for j in range(k):
                xa = x0 + (x1 - x0) * j / k
                xb = x0 + (x1 - x0) * (j + 1) / k
                objs.append(slope(sy, xa, xb, 0, keep * (0.7 + 0.6 * ((j * 0.61) % 1))))
                if j % 2:
                    objs.append(slope(sy, xa, xb, 0.86 + 0.05 * j / k, 1))
            # Battens, a few left nailed across the rafters.
            L = run / math.cos(pitch)
            for f in (keep + 0.12, keep + 0.3, 0.72):
                objs.append(kit.timber(((x1 - x0) * 0.8, 0.05, 0.03),
                                       ((x0 + x1) / 2 + 0.2, sy * (run - L * f * math.cos(pitch)),
                                        z0 - drop + L * f * math.sin(pitch) + 0.03), (-sy * pitch, 0, 0),
                                       "oak", 0.005, "batten"))
            # The rafters left in the gap, charred where the fire went through.
            n = max(2, int((x1 - x0) / 0.6))
            for i in range(n):
                rx = x0 + (x1 - x0) * (i + 0.5) / n
                L = run / math.cos(pitch)
                objs.append(kit.timber((0.11, L * (1 - keep) + 0.2, 0.17),
                                       (rx, sy * (run - (L * (keep + 1) / 2) * math.cos(pitch)),
                                        z0 - drop + (L * (keep + 1) / 2) * math.sin(pitch) - 0.05),
                                       (-sy * pitch, 0, 0), rafter_mat, 0.02, "rafter"))
            # A purlin across them, half way up the gap.
            mid = (keep + 1) / 2
            L = run / math.cos(pitch)
            objs.append(kit.timber((x1 - x0 + 0.4, 0.16, 0.2),
                                   ((x0 + x1) / 2, sy * (run - L * mid * math.cos(pitch)) - sy * 0.02,
                                    z0 - drop + L * mid * math.sin(pitch) - 0.2), (-sy * pitch, 0, 0),
                                   rafter_mat, 0.02, "purlin"))
        else:
            objs.append(slope(sy, -total / 2, total / 2, 0, 1))
        objs.append(kit.timber((total, 0.14, 0.32), (0, sy * (run + 0.07), z0 - drop + 0.04),
                               (0, 0, 0), trim, 0.03, "fascia"))
    objs.append(kit.timber((total + 0.08, 0.4, 0.28), (0, 0, z0 + height + 0.05), (0, 0, 0), mat, 0.07, "ridge"))
    for sx in (-1, 1):
        objs.append(lib.wedge(span, height, 0.26, (sx * (length / 2 - 0.13), 0, z0),
                              (0, 0, math.pi / 2), name="gable", mat="sootwall"))
    return objs


# --- the houses -------------------------------------------------------------

W = 11.9          # the town's houses are this across; build.js fit-scales
T = 0.34


def build_house_derelict():
    """Two storeys of the town's own stone house, shut up and left. Every
    opening is boarded, one shutter hangs off a single hinge, the door is
    nailed over with a brace, and a stretch of the front roof has lost its
    tiles down to the rafters. The chimney has come down to a stump."""
    lib.reset()
    rng = rng_for(92001)
    p = []
    GH, UH = 3.8, 3.3
    z0 = 0.55
    p += kit.plinth(W, W, 0.0, 0.42, proud=0.1, mat="sootwall")
    g_front = [(0, 0, 3.2, 3.1), (-3.9, 1.3, 1.6, 1.7), (3.9, 1.3, 1.6, 1.7)]
    u_front = [(-3.9, 0.9, 1.6, 1.7), (0, 0.9, 1.6, 1.7), (3.9, 0.9, 1.6, 1.7)]
    side = [(0, 1.3, 1.6, 1.6)]
    p += kit.shell(W, W, GH, T, z0, {"front": g_front, "left": side, "right": side, "back": side},
                   mat="sootwall", name="ground")
    p += kit.shell(W, W, UH, T, z0 + GH, {"front": u_front, "left": side, "back": side},
                   mat="sootwall", name="upper")
    gf = kit.faces_of(W, W, T, z0)
    uf = kit.faces_of(W, W, T, z0 + GH)
    face = -W / 2   # outer face of the front wall

    # The door: its surround, and boards nailed over where the leaf was.
    p += kit.door(0, 3.2, 3.1, gf["front"][1], 0.0, T, frame="sootwall", boards=4, z0=z0)
    p += board_up(0, z0 + 0.1, 2.9, 2.9, face - 0.02, rng, n=7)

    for (cx, oz, ow, oh) in g_front[1:]:
        p += kit.window(cx, oz, ow, oh, gf["front"][1], 0.0, T, mat="sootwall", glass=False,
                        mullions=0, sill_out=0.26, proud=0.1)
        p += board_up(cx, z0 + oz, ow, oh, face - 0.1, rng)
    for i, (cx, oz, ow, oh) in enumerate(u_front):
        p += kit.window(cx, oz, ow, oh, uf["front"][1], 0.0, T, mat="sootwall", glass=False,
                        mullions=0, sill_out=0.26, proud=0.1)
        if i == 2:
            # The one nobody boarded: a shutter left hanging by its top hinge,
            # swung out and down across the opening.
            p.append(kit.timber((ow * 0.55, 0.06, oh + 0.05),
                                (cx + ow * 0.62, face - 0.32, z0 + GH + oz + oh * 0.46),
                                (0, math.radians(-24), math.radians(-38)), "boards", 0.02, "shutter"))
        else:
            p += board_up(cx, z0 + GH + oz, ow, oh, face - 0.1, rng)
    for key in ("left", "right", "back"):
        loc, rot = gf[key][1], gf[key][2]
        p += kit.window(0, 1.3, 1.6, 1.6, loc, rot, T, mat="sootwall", glass=False, mullions=0,
                        sill_out=0.24, proud=0.08)
    # The flank and back openings get boards too, laid in their own frame.
    for key in ("left", "right", "back"):
        loc, rot = gf[key][1], gf[key][2]
        sub = board_up(0, z0 + 1.3, 1.6, 1.6, -T / 2 - 0.1, rng)
        kit.place(sub, loc, (0, 0, rot))
        p += sub

    p += kit.string_course(W, W, z0 + GH - 0.2, proud=0.22, height=0.26, mat="sootwall")
    rz = z0 + GH + UH
    p += pitched(W, W, 3.0, rz, hole=(-2.6, 1.4, 0.38), rafter_mat="charred")
    # The stack, come down to a ragged stump above the roof.
    sx0 = W / 2 - 0.9
    p += broken_run(sx0 - 0.6, sx0 + 0.6, 1.6, 1.1, lambda x: rz + 2.3 + 0.5 * math.sin(x * 5.1),
                    mat="sootwall", step=0.3, course=0.25, name="stack")
    return deliver(p, "house_derelict")


def build_house_gutted():
    """What is left after a house burns: the stone shell to broken heads, the
    gables standing highest because they are the thickest and best-tied, the
    long walls down to a storey or less, the openings empty, and inside, the
    roof and the floors in a heap of ash with the charred rafters lying in it
    and one still leaning from the wall head."""
    lib.reset()
    rng = rng_for(92011)
    p = []
    t = 0.5
    hw = W / 2
    door = (0.0, 0.0, 3.0, 3.0)
    wins = [(-3.8, 1.2, 1.5, 1.6), (3.8, 1.2, 1.5, 1.6)]
    upper = [(-3.8, 4.8, 1.5, 1.5), (3.8, 4.8, 1.5, 1.5)]

    def front_h(x):
        return 5.6 + 1.4 * math.sin(x * 0.55 + 1.0) - 2.6 * math.exp(-((x - 1.8) / 1.6) ** 2)

    def back_h(x):
        return 4.2 + 1.8 * math.sin(x * 0.4 - 0.6) + rng_for(int(x * 10) + 7).uniform(-0.3, 0.3)

    def gable_h(y):
        # The gable's own triangle, broken off a metre or two short of its apex.
        tri = 7.2 + 3.0 * (1 - abs(y) / hw)
        return tri - 1.4 * (1 + math.sin(y * 1.7)) * 0.6

    p += broken_run(-hw, hw, -hw + t / 2, t, front_h, holes=[door] + wins + upper, name="front")
    p += broken_run(-hw, hw, hw - t / 2, t, back_h, holes=wins, name="back")
    for sx in (-1, 1):
        run = broken_run(-hw + t, hw - t, 0, t, gable_h, holes=[(0.0, 1.2, 1.5, 1.6), (0.0, 4.9, 1.2, 1.3)],
                         name="gable")
        kit.rotate_z(run, math.pi / 2)
        for o in run:
            o.location.x += sx * (hw - t / 2)
        p += run
    # Charred lintels over the openings in the long walls: timber, and burnt.
    for (cx, sill, ow, head) in [door] + wins + upper:
        if front_h(cx) > head + 0.3:
            p.append(kit.timber((ow + 0.5, t + 0.04, 0.26), (cx, -hw + t / 2, head + 0.13), (0, 0, 0),
                                "charred", 0.03, "lintel"))
    # The floor: ash over everything, heaped where the roof came down.
    p.append(lib.box((W - 2 * t - 0.05, W - 2 * t - 0.05, 0.08), (0, 0, 0.04), name="floor", mat="ash"))
    p += rubble_spill(rng, 1.2, 1.4, 5.8, 4.6, 1.3, stones=16, timber=0)
    # Rafters: fallen across the heap, and one still up against the gable.
    for i in range(5):
        L = rng.uniform(4.5, 6.5)
        p.append(kit.timber((L, 0.14, 0.22), (rng.uniform(-2.5, 2.8), rng.uniform(-2.2, 3.2), 0.6 + i * 0.12),
                            (rng.uniform(-0.25, 0.25), rng.uniform(-0.12, 0.12), rng.uniform(0, math.pi)),
                            "charred", 0.03, "rafter"))
    p.append(kit.timber((0.16, 0.24, 7.0), (-hw + 2.2, 1.0, 3.0), (0, math.radians(-34), 0), "charred", 0.03,
                        "leaning"))
    # A floor joist still in its pocket, snapped off a metre out.
    for y in (-2.4, -0.6, 1.2, 3.0):
        p.append(kit.timber((1.3, 0.16, 0.24), (hw - t - 0.6, y, 3.6), (0, math.radians(8), 0), "charred", 0.02,
                            "joist"))
    return deliver(p, "house_gutted")


# --- the ruined rooms' kit --------------------------------------------------

RW = 11.4        # as roomkit.W: a panel spans its whole wall line
RT = 0.5
RH = 5.2
PIER = 1.12


def ruin_profile(seed, low=2.0, high=5.2):
    """Standing height along a panel: tall at the ends, where the corners tie
    it, dropping to a broken middle."""
    r = rng_for(seed)
    dip = r.uniform(-2.0, 2.0)
    depth = r.uniform(0.55, 1.0)
    wav = r.uniform(0, 6.28)

    def h(x):
        u = abs(x) / (RW / 2)
        base = high - (high - low) * depth * math.exp(-((x - dip) / 2.4) ** 2)
        return min(high, base + 0.35 * math.sin(x * 1.9 + wav) + 0.9 * u ** 4)
    return h


def ruin_panel(name, seed, door=False, breach=False):
    lib.reset()
    rng = rng_for(seed)
    p = []
    # Masonry has to stand over a doorway for its lintel to be carried.
    prof = ruin_profile(seed, low=4.1 if door else 2.0)
    holes = []
    if door:
        holes.append((0.0, 0.0, 3.6, 3.1))
    if breach:
        # "The back wall of the building has been bashed down": a gap five
        # metres across, knocked down nearly to the ground, the stones of it
        # lying on both sides.
        def prof(x, base=prof):
            return max(0.35, base(x) - 4.6 * math.exp(-(x / 1.9) ** 4))
    p += broken_run(-RW / 2, RW / 2, 0, RT, prof, holes=holes, name="wall",
                    least=(lambda x: 4.2 if abs(x) < 2.4 else 0) if door else None)
    if door:
        # A charred lintel, cracked and sagging in the middle.
        for s in (-1, 1):
            p.append(kit.timber((2.25, RT + 0.06, 0.28), (s * 1.02, 0, 3.24 - 0.05), (0, s * math.radians(4), 0),
                                "charred", 0.03, "lintel"))
    if breach:
        # The stones of it lie either side of the gap, not in it: build.js
        # keeps the middle 3.2 m walkable, as it does for any doorway.
        for sx in (-1, 1):
            for sy in (-1, 1):
                p += rubble_spill(rng, sx * rng.uniform(2.5, 2.9), sy * 1.0, 1.7, 1.5, 0.7, stones=4, timber=int(sx > 0 and sy > 0))
    # Soot-blackened jambs are the material's job; what geometry adds is a
    # few stones fallen at the foot of the wall on each side.
    for sy in (-1, 1):
        for i in range(3):
            x = rng.uniform(-4.5, 4.5)
            if door and abs(x) < 2.2:
                continue
            p.append(chunk_stone(rng, (x, sy * rng.uniform(0.55, 1.2), 0.12), (0.5, 0.32, 0.26)))
    return deliver(p, name)


def build_ruin_corner():
    lib.reset()
    p = broken_run(-PIER / 2, PIER / 2, 0, PIER, lambda x: 4.6 + 0.5 * math.sin(x * 4.0), step=0.37,
                   name="pier")
    return deliver(p, "ruin_corner")


# --- the debris of the fighting -----------------------------------------------

def build_rubble_heap():
    """A house front come down into the street: squared stones, a spill of
    ash and broken tile, a charred stick or two. About 3.4 x 2.8 m and a
    metre high, so it narrows a lane rather than closing it."""
    lib.reset()
    rng = rng_for(92101)
    p = rubble_spill(rng, 0, 0, 3.4, 2.8, 1.15, stones=26, timber=2)
    for i in range(8):
        p.append(kit.slab((0.3, 0.2, 0.025), (rng.uniform(-1.4, 1.4), rng.uniform(-1.1, 1.1), 0.05),
                          (rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), rng.uniform(0, 3)), mat="rooftile",
                          name="tile", width=0.006))
    return deliver(p, "rubble_heap")


def build_charred_beams():
    """The bones of a burnt roof: four heavy timbers, fallen across one
    another, one propped up on the rest at a slant."""
    lib.reset()
    rng = rng_for(92111)
    p = []
    p.append(kit.timber((5.4, 0.28, 0.32), (0, -0.4, 0.16), (0, 0, 0.12), "charred", 0.04, "beam"))
    p.append(kit.timber((4.6, 0.26, 0.28), (0.3, 0.6, 0.14), (0, 0, -0.2), "charred", 0.04, "beam"))
    p.append(kit.timber((4.8, 0.26, 0.3), (-0.2, 0.1, 0.62), (0, math.radians(-12), 1.2), "charred", 0.04, "beam"))
    p.append(kit.timber((3.4, 0.2, 0.24), (1.1, -0.2, 0.46), (0, math.radians(9), -1.0), "charred", 0.04, "beam"))
    # Burnt-through ends, and the char and ash that fell off them.
    for i in range(10):
        p.append(chunk_stone(rng, (rng.uniform(-2.4, 2.4), rng.uniform(-1.0, 1.0), 0.05),
                             (rng.uniform(0.12, 0.3), rng.uniform(0.1, 0.2), 0.08), mat="charred"))
    p.append(heap(rng, 3.2, 1.4, 0.22))
    return deliver(p, "charred_beams")


def wheel(x, y, z, r=0.5, thick=0.12, spokes=8, mat="oak", rim="rust", axis="x", tilt=0.0):
    objs = [lib.torus(r, 0.05, (x, y, z), (0, math.pi / 2, 0), major_seg=16, minor_seg=4, name="rim", mat=rim),
            lib.cylinder(0.1, thick + 0.06, (x, y, z), (0, math.pi / 2, 0), verts=8, name="hub", mat=mat)]
    for i in range(spokes):
        a = 2 * math.pi * i / spokes
        objs.append(kit.timber((0.05, 0.05, r * 0.95), (x, y + math.cos(a) * r * 0.47, z + math.sin(a) * r * 0.47),
                               (a - math.pi / 2, 0, 0), mat, 0.01, "spoke"))
    if tilt:
        kit.place(objs, (0, 0, 0), (0, 0, 0))
    return objs


def build_barricade():
    """A street stopped with whatever was to hand: a handcart tipped on its
    side, crates and a barrel stacked against it, boards and a door leaf
    wedged into the gaps. Five and a half metres along X, a man's height."""
    lib.reset()
    rng = rng_for(92121)
    p = []
    # The cart on its side: its bed is now a wall, one wheel in the air.
    bed = []
    bw, bl = 1.1, 2.4
    bed.append(kit.slab((bl, 0.1, bw), (0, 0, bw / 2 + 0.05), mat="planks", name="bed", width=0.02))
    for sz in (-1, 1):
        bed.append(kit.timber((bl, 0.44, 0.08), (0, -0.24, bw / 2 + 0.05 + sz * (bw / 2 - 0.04)), (0, 0, 0),
                              "planks", 0.02, "side"))
    bed += wheel(0.2, -0.62, bw + 0.2, r=0.46)
    bed.append(kit.timber((0.09, 0.09, 1.6), (-bl / 2 - 0.5, 0.1, 0.35), (0, math.radians(70), 0.1), "oak",
                          0.02, "shaft"))
    kit.place(bed, (-1.0, 0.1, 0), (0, 0, 0.08))
    p += bed
    # Crates, one on another.
    for (x, y, z, s) in ((1.2, -0.1, 0.36, 0.72), (1.9, 0.15, 0.3, 0.6), (1.4, 0.0, 1.05, 0.62),
                         (2.55, -0.05, 0.28, 0.56)):
        p.append(kit.slab((s, s, s), (x, y, z), (0, 0, rng.uniform(-0.3, 0.3)), mat="planks", name="crate",
                          width=0.03))
        for sx in (-1, 1):
            p.append(kit.timber((0.06, s + 0.02, 0.08), (x + sx * s * 0.36, y, z), (0, 0, 0), "oak", 0.01, "batten"))
    p.append(lib.cylinder(0.33, 0.86, (-2.55, 0.2, 0.43), verts=12, name="barrel", mat="oak"))
    for dz in (0.16, 0.7):
        p.append(lib.torus(0.335, 0.02, (-2.55, 0.2, dz), major_seg=12, minor_seg=3, name="hoop", mat="iron"))
    # Boards and a door leaf wedged in, leaning.
    for i in range(5):
        x = rng.uniform(-2.4, 2.4)
        p.append(kit.timber((0.22, 0.04, rng.uniform(1.6, 2.2)), (x, -0.55, 0.8),
                            (math.radians(rng.uniform(14, 26)), rng.uniform(-0.25, 0.25), 0), "boards", 0.008,
                            "board"))
    door = []
    for i in range(4):
        door.append(kit.timber((0.22, 0.06, 2.1), (-0.33 + i * 0.22, 0, 1.05), (0, 0, 0), "planks", 0.01, "leaf"))
    door.append(kit.timber((0.9, 0.05, 0.14), (0, -0.05, 0.5), (0, 0, 0), "oak", 0.01, "ledge"))
    door.append(kit.timber((0.9, 0.05, 0.14), (0, -0.05, 1.6), (0, 0, 0), "oak", 0.01, "ledge"))
    kit.place(door, (0.35, 0.55, 0), (math.radians(-18), 0, 0.2))
    p += door
    # A sack of sand at the foot, and a stone or two.
    for x in (-1.6, 0.6):
        s = lib.sphere(0.34, (x, -0.7, 0.18), segments=10, rings=6, name="sack", mat="cloth")
        s.scale = (1.3, 0.8, 0.55)
        p.append(s)
    return deliver(p, "barricade")


def build_barricade_stakes():
    """Chevaux-de-frise: a log with sharpened stakes driven through it both
    ways, so it cannot be climbed or rolled aside. Four metres long."""
    lib.reset()
    p = []
    L = 4.0
    p.append(lib.cylinder(0.2, L, (0, 0, 0.72), (0, math.pi / 2, 0), verts=10, name="log", mat="bark"))
    n = 7
    for i in range(n):
        x = -L / 2 + 0.3 + (L - 0.6) * i / (n - 1)
        for s in (-1, 1):
            a = math.radians(42) * s + (0.08 if i % 2 else -0.08)
            p.append(kit.timber((0.1, 0.1, 2.3), (x, 0, 0.72), (a, 0, 0), "oak", 0.03, "stake"))
            # Fire-hardened points.
            tip = mathutils.Vector((0, 0, 1.2))
            tip.rotate(mathutils.Euler((a, 0, 0)))
            p.append(lib.cone(0.07, 0.0, 0.3, (x, tip.y, 0.72 + tip.z), (a, 0, 0), verts=6, name="point",
                              mat="charred"))
    return deliver(p, "barricade_stakes")


def build_burnt_cart():
    """A wagon somebody set alight: its bed charred through in places, one
    wheel burnt away so it has come down on that corner, the other still on,
    the shafts on the ground in front."""
    lib.reset()
    rng = rng_for(92131)
    p = []
    bl, bw, bz = 3.2, 1.5, 0.78
    body = []
    # The bed, boards with gaps where they burned through.
    for i in range(8):
        if i in (2, 5):
            continue
        body.append(kit.timber((bl * rng.uniform(0.75, 1.0), 0.17, 0.06),
                               (rng.uniform(-0.2, 0.2), -bw / 2 + 0.1 + i * (bw - 0.2) / 7, bz),
                               (0, 0, 0), "charred", 0.01, "board"))
    for sy in (-1, 1):
        body.append(kit.timber((bl, 0.1, 0.16), (0, sy * bw / 2, bz - 0.08), (0, 0, 0), "charred", 0.02, "rail"))
        body.append(kit.timber((bl * 0.7, 0.07, 0.34), (-0.3, sy * (bw / 2 + 0.02), bz + 0.24), (0, 0, 0),
                               "charred", 0.02, "side"))
    for sx in (-1, 1):
        body.append(kit.timber((0.1, bw + 0.3, 0.1), (sx * (bl / 2 - 0.4), 0, bz - 0.25), (0, 0, 0), "rust", 0.02,
                               "axle"))
    body += wheel(-bl / 2 + 0.4, -bw / 2 - 0.12, 0.52, r=0.52, mat="charred", rim="charred")
    body += wheel(bl / 2 - 0.4, -bw / 2 - 0.12, 0.52, r=0.52, mat="charred", rim="charred")
    body += wheel(-bl / 2 + 0.4, bw / 2 + 0.12, 0.52, r=0.52, mat="charred", rim="charred")
    # Settle the burnt corner: the body tips down to the +x, +y side where
    # the fourth wheel was.
    kit.place(body, (0, 0, -0.1), (math.radians(-7), math.radians(6), 0))
    p += body
    # The fourth wheel's iron tyre lying in the ash, and the ash.
    p.append(lib.torus(0.52, 0.04, (bl / 2 + 0.2, bw / 2 + 0.7, 0.05), major_seg=16, minor_seg=4, name="tyre",
                       mat="charred"))
    p.append(heap(rng, 3.4, 2.4, 0.16))
    for sy in (-1, 1):
        p.append(kit.timber((2.2, 0.09, 0.09), (-bl / 2 - 1.0, sy * 0.4, 0.07), (0, 0, sy * 0.1), "charred", 0.02,
                            "shaft"))
    return deliver(p, "burnt_cart")


def build_brazier():
    """An iron fire basket on three legs: what a gang keeps burning at the
    corner it holds. The flame is the viewer's, set on top of the coals."""
    lib.reset()
    p = []
    top = 1.05
    for i in range(3):
        a = 2 * math.pi * i / 3
        p.append(kit.timber((0.05, 0.05, 1.12), (math.cos(a) * 0.28, math.sin(a) * 0.28, 0.52),
                            (math.sin(a) * 0.22, -math.cos(a) * 0.22, 0), "rust", 0.01, "leg"))
    # The basket: two rings and straps between them.
    p.append(lib.torus(0.36, 0.022, (0, 0, top), major_seg=14, minor_seg=3, name="ring", mat="rust"))
    p.append(lib.torus(0.22, 0.022, (0, 0, top - 0.3), major_seg=12, minor_seg=3, name="ring", mat="rust"))
    for i in range(8):
        a = 2 * math.pi * i / 8
        p.append(kit.timber((0.03, 0.03, 0.34), (math.cos(a) * 0.29, math.sin(a) * 0.29, top - 0.15),
                            (math.sin(a) * 0.42, -math.cos(a) * 0.42, 0), "rust", 0.006, "strap"))
    coals = lib.sphere(0.3, (0, 0, top - 0.12), segments=10, rings=5, name="coals", mat="charred")
    coals.scale = (1.0, 1.0, 0.45)
    p.append(coals)
    return deliver(p, "brazier")


def build_crow():
    """A carrion crow, perched: a body, a head with its heavy bill, a tail.
    Forty centimetres from bill to tail, black as the char it sits on."""
    lib.reset()
    p = []
    body = lib.loft([(-0.2, 0.03, 0.03, 0, 0), (-0.12, 0.07, 0.06, 0, 0.01), (0.0, 0.085, 0.075, 0, 0.02),
                     (0.08, 0.07, 0.065, 0, 0.035), (0.13, 0.04, 0.04, 0, 0.05)], sides=8, axis="y",
                    name="body", mat="charred")
    head = lib.sphere(0.045, (0, 0.16, 0.12), segments=8, rings=6, name="head", mat="charred")
    bill = lib.cone(0.018, 0.0, 0.07, (0, 0.225, 0.115), (math.radians(-95), 0, 0), verts=6, name="bill",
                    mat="charred")
    tail = kit.timber((0.07, 0.16, 0.012), (0, -0.25, 0.1), (math.radians(-18), 0, 0), "charred", 0.004, "tail")
    for obj in (body,):
        obj.location = (0, 0, 0.13)
    p += [body, head, bill, tail]
    for sx in (-1, 1):
        p.append(kit.timber((0.012, 0.012, 0.1), (sx * 0.03, 0.02, 0.05), (0, 0, 0), "charred", 0.003, "leg"))
    return deliver(p, "crow")


# --- the gangs' places --------------------------------------------------------

def dragon_skull(z, scale=1.0):
    """A dragon's skull, as a gang would make one: bleached bone, horned, with
    its jaw hung open. Built long along -Y, which is the way it looks."""
    s = scale
    objs = []
    objs.append(lib.loft([(0.1 * s, 0.26 * s, 0.2 * s, 0, 0), (-0.15 * s, 0.34 * s, 0.26 * s, 0, 0.02 * s),
                          (-0.45 * s, 0.26 * s, 0.2 * s, 0, 0), (-0.8 * s, 0.17 * s, 0.13 * s, 0, -0.04 * s),
                          (-1.05 * s, 0.1 * s, 0.08 * s, 0, -0.06 * s)], sides=10, axis="y", name="skull",
                         mat="oldbone"))
    objs[-1].location = (0, 0, z)
    objs.append(lib.loft([(0.0, 0.2 * s, 0.05 * s, 0, 0), (-0.5 * s, 0.14 * s, 0.05 * s, 0, 0),
                          (-0.95 * s, 0.07 * s, 0.04 * s, 0, 0)], sides=8, axis="y", name="jaw", mat="oldbone"))
    objs[-1].location = (0, 0.05 * s, z - 0.32 * s)
    objs[-1].rotation_euler = (math.radians(-16), 0, 0)
    for sx in (-1, 1):
        horn = lib.loft([(0.0, 0.07 * s, 0.07 * s, 0, 0), (0.25 * s, 0.05 * s, 0.05 * s, 0.03 * s * sx, -0.06 * s),
                         (0.5 * s, 0.03 * s, 0.03 * s, 0.1 * s * sx, -0.08 * s),
                         (0.72 * s, 0.01 * s, 0.01 * s, 0.22 * s * sx, 0.02 * s)], sides=6, axis="z",
                        name="horn", mat="oldbone")
        horn.location = (sx * 0.2 * s, 0.1 * s, z + 0.12 * s)
        horn.rotation_euler = (math.radians(-35), sx * math.radians(30), 0)
        objs.append(horn)
        # Eye sockets: a dark hollow is geometry here -- a charred plug set in.
        objs.append(lib.sphere(0.07 * s, (sx * 0.2 * s, -0.25 * s, z + 0.1 * s), segments=6, rings=4, name="eye",
                               mat="charred"))
        for i in range(4):
            objs.append(lib.cone(0.022 * s, 0.0, 0.1 * s, (sx * 0.1 * s, -0.55 * s - i * 0.13 * s, z - 0.2 * s),
                                 (math.pi, 0, 0), verts=5, name="tooth", mat="oldbone"))
    return objs


def build_dracolich_idol():
    """The Dragon gang's idol, raised on the plaza they renamed for it: a
    dragon's skull the size of a man mounted on a post of burnt timber,
    staring down the plaza, with bone wings of lashed spars and rag spread
    from the ends of the crossbar behind it, bones hung from the arm, and a
    ring of stones at its foot. Crude on purpose -- built by the gang, not by
    a mason."""
    lib.reset()
    rng = rng_for(92201)
    p = []
    H = 4.0
    arm_z = H - 0.9
    p.append(kit.timber((0.36, 0.36, H), (0, 0, H / 2), (0, 0, 0), "charred", 0.05, "post"))
    p.append(kit.timber((3.4, 0.24, 0.26), (0, 0.08, arm_z), (0, 0, 0), "charred", 0.04, "arm"))
    for sx in (-1, 1):
        p.append(kit.timber((0.14, 0.14, 1.5), (sx * 0.5, 0.08, arm_z - 0.6), (0, sx * math.radians(38), 0), "charred",
                            0.02, "brace"))
    # The skull sits on the post head glaring down the plaza. It was turned
    # -12 degrees about X, which *raises* a snout that points down -Y: from
    # the plaza floor it was its own underside, a long pale cone standing up
    # off the post, and it read as a skull turned along the crossbar. Tipped
    # the other way, a man at its foot sees the brow, the sockets and the
    # horns: a face looking down at him.
    skull = dragon_skull(0.0, 1.7)
    kit.place(skull, (0, -0.3, H + 0.3), (math.radians(22), 0, 0))
    p += skull
    # The wings: a fan of spars from each end of the arm, a rag between each
    # pair of spars, torn short of the tips.
    for sx in (-1, 1):
        base = mathutils.Vector((sx * 1.55, 0.2, arm_z + 0.05))
        tips = []
        for i in range(4):
            a = math.radians(8 + i * 21)
            L = 1.9 - i * 0.22
            tip = base + mathutils.Vector((sx * math.cos(a) * L, 0.12 * i, math.sin(a) * L))
            tips.append(tip)
            vec = tip - base
            rot = vec.to_track_quat("Z", "Y").to_euler()
            p.append(kit.timber((0.07, 0.07, vec.length), tuple((base + tip) / 2), tuple(rot), "oldbone", 0.015,
                                "spar"))
        for i in range(3):
            a, b = tips[i], tips[i + 1]
            # Torn: the rag reaches only part way out along the spars.
            fa, fb = rng.uniform(0.6, 0.95), rng.uniform(0.55, 0.9)
            ea = base + (a - base) * fa
            eb = base + (b - base) * fb
            me = bpy.data.meshes.new("rag")
            me.from_pydata([tuple(base + mathutils.Vector((0, 0.03, 0))), tuple(ea + mathutils.Vector((0, 0.03, 0))),
                            tuple(eb + mathutils.Vector((0, 0.03, 0)))], [], [(0, 1, 2)])
            me.update()
            rag = bpy.data.objects.new("rag", me)
            bpy.context.collection.objects.link(rag)
            lib.assign(rag, "cloth")
            lib.solidify(rag, 0.012)
            p.append(rag)
    # Bones hung on cords from the arm.
    for x in (-1.25, -0.8, 0.75, 1.2):
        L = rng.uniform(0.5, 0.8)
        p.append(lib.cylinder(0.008, 0.45, (x, 0.08, arm_z - 0.35), verts=4, name="cord", mat="rope"))
        p.append(kit.timber((0.07, 0.07, L), (x, 0.08, arm_z - 0.6 - L / 2), (rng.uniform(-0.2, 0.2), 0, 0), "oldbone",
                            0.02, "bone"))
    # The ring of stones, a litter of offerings, and the black of old fires.
    for i in range(11):
        a = 2 * math.pi * i / 11 + rng.uniform(-0.1, 0.1)
        p.append(chunk_stone(rng, (math.cos(a) * 1.25, math.sin(a) * 1.25, 0.15), (0.42, 0.3, 0.28), mat="rock"))
    for i in range(5):
        p.append(kit.timber((0.05, 0.05, rng.uniform(0.4, 0.7)), (rng.uniform(-0.8, 0.8), rng.uniform(-0.9, -0.3), 0.03),
                            (math.pi / 2, 0, rng.uniform(0, 3)), "oldbone", 0.015, "bone"))
    p.append(heap(rng, 1.6, 1.4, 0.06, mat="ash"))
    return deliver(p, "dracolich_idol")


def build_training_pell():
    """A pell to practise on: a post in a timber cross-foot, with a straw
    man lashed to a crossbar -- "it has become sort of a training ground"."""
    lib.reset()
    p = []
    for rot in (0, math.pi / 2):
        p.append(kit.timber((1.4, 0.18, 0.16), (0, 0, 0.08), (0, 0, rot), "oak", 0.02, "foot"))
    p.append(kit.timber((0.2, 0.2, 2.0), (0, 0, 1.0), (0, 0, 0), "oak", 0.03, "post"))
    p.append(kit.timber((1.2, 0.12, 0.12), (0, 0, 1.55), (0, 0, 0), "oak", 0.02, "bar"))
    torso = lib.loft([(0.9, 0.2, 0.15, 0, 0), (1.2, 0.26, 0.19, 0, 0), (1.5, 0.28, 0.2, 0, 0),
                      (1.7, 0.2, 0.16, 0, 0)], sides=8, axis="z", name="straw", mat="thatch")
    torso.location = (0, -0.05, 0)
    p.append(torso)
    p.append(lib.sphere(0.14, (0, -0.05, 1.86), segments=8, rings=6, name="head", mat="cloth"))
    for z in (1.0, 1.35, 1.62):
        p.append(lib.torus(0.23, 0.015, (0, -0.05, z), major_seg=10, minor_seg=3, name="lash", mat="rope"))
    return deliver(p, "training_pell")


def build_khan_memorial():
    """A memorial to Khan, "being crudely constructed": a steppe cairn of
    piled stones with a spirit banner planted in it -- a pole with an iron
    trident at its head and horse-tail tassels hung below -- and the
    scaffold of lashed poles the builders left beside it."""
    lib.reset()
    rng = rng_for(92211)
    p = []
    # The cairn: courses of stones, each ring smaller.
    for k, (r, z, n) in enumerate(((1.25, 0.18, 13), (0.95, 0.52, 10), (0.7, 0.84, 8), (0.42, 1.12, 6),
                                   (0.2, 1.36, 3))):
        for i in range(n):
            a = 2 * math.pi * (i + k * 0.37) / n
            s = rng.uniform(0.3, 0.42) * (1 - k * 0.1)
            p.append(chunk_stone(rng, (math.cos(a) * r, math.sin(a) * r, z), (s * 1.3, s, s * 0.8), mat="rock"))
    p.append(heap(rng, 2.3, 2.2, 1.3, mat="rock"))
    # The banner: pole, trident, a disc, and the tails.
    top = 5.2
    p.append(lib.cylinder(0.06, top, (0, 0, top / 2), verts=8, name="pole", mat="oak"))
    p.append(lib.cylinder(0.2, 0.05, (0, 0, top - 0.55), verts=12, name="disc", mat="rust"))
    for sx in (-1, 0, 1):
        p.append(lib.cone(0.035, 0.0, 0.5 if sx == 0 else 0.36, (sx * 0.13, 0, top + 0.12 - abs(sx) * 0.06),
                          verts=5, name="tine", mat="rust"))
    p.append(kit.timber((0.3, 0.04, 0.04), (0, 0, top - 0.12), (0, 0, 0), "rust", 0.01, "crosspiece"))
    for i in range(9):
        a = 2 * math.pi * i / 9
        tail = lib.cone(0.05, 0.015, 0.9, (math.cos(a) * 0.12, math.sin(a) * 0.12, top - 1.05),
                        (math.cos(a) * 0.12, math.sin(a) * 0.12, 0), verts=5, name="tail", mat="hair")
        p.append(tail)
    # Blue scarves tied round the pole's foot, the way a steppe cairn is dressed.
    for z in (1.5, 1.7):
        p.append(lib.torus(0.1, 0.03, (0, 0, z), major_seg=8, minor_seg=3, name="scarf", mat="cloth"))
    # The builders' scaffold: two sheer-legs and a pole across.
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(kit.timber((0.08, 0.08, 3.4), (sx * 1.8 + sy * 0.25, 1.4, 1.6), (0, sy * math.radians(8), 0),
                                "bark", 0.015, "leg"))
    p.append(kit.timber((3.9, 0.09, 0.09), (0, 1.4, 3.2), (0, 0, 0), "bark", 0.015, "ledger"))
    p.append(lib.cylinder(0.008, 1.6, (0.5, 1.4, 2.4), verts=4, name="rope", mat="rope"))
    return deliver(p, "khan_memorial")


# --- the lot, the park, the courtyards -----------------------------------------

def build_bramble():
    """A bramble thicket: a lumpy mound of dark leaf chest high on a man and
    two and a half metres across, and the bare arching canes that stand up
    out of it, some well over head height, and bow back down to root at the
    tips -- which is the thing that says bramble rather than bush.

    The leaf is cut-out sprays of toothed leaflets on purple cane, laid over
    the mound with their normals out of it, and a few along each cane; it was
    squashed spheres in the generic `leaves` texture, which read as green
    blobs however they were heaped."""
    lib.reset()
    rng = rng_for(92301)
    p = []
    cards = trees.Cards("brambleleaf", tile=0.5)
    centre = mathutils.Vector((0, 0, 0.35))
    # The mound: lumps of leaf, each a cluster of sprays round its own middle.
    for i in range(11):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.0, 0.9) if i else 0.0
        w = rng.uniform(0.75, 1.15) * (1.3 if i == 0 else 1.0)
        h = rng.uniform(0.8, 1.3) * (1.25 if i == 0 else 1.0)
        mid = mathutils.Vector((math.cos(a) * r * 1.2, math.sin(a) * r * 0.95, h * 0.3))
        for k in range(10):
            ta = k * 2.39996 + rng.uniform(-0.3, 0.3)
            e = math.asin(min(0.95, -0.2 + 1.1 * (k + 0.5) / 10))
            u = mathutils.Vector((math.cos(ta) * math.cos(e) * w, math.sin(ta) * math.cos(e) * w, math.sin(e) * h * 0.6))
            if u.length < 1e-4:
                continue
            base = mid + u * 0.35
            if base.z < 0.05:
                continue
            d = u.normalized()
            side = d.cross(mathutils.Vector((0, 0, 1)))
            if side.length < 1e-3:
                side = mathutils.Vector((1, 0, 0))
            cards.card(base, d, side.normalized(), rng.uniform(0.45, 0.65), rng.uniform(0.38, 0.5), 0.3,
                       trees.outward(base, centre, 0.4))
    for i in range(12):
        # Each cane leaves the crown of the mound, arches outward over it and
        # comes down to root well beyond its edge.
        # Out of the flank of the mound at every height, not all from its
        # crown -- from one point they stood round it like the ribs of a cage.
        a = 2 * math.pi * i / 12 + rng.uniform(-0.5, 0.5)
        out = mathutils.Vector((math.cos(a), math.sin(a), 0))
        root = out * rng.uniform(0.3, 0.9) + mathutils.Vector((0, 0, rng.uniform(0.25, 0.75)))
        reach = rng.uniform(0.8, 1.5)
        rise = rng.uniform(0.1, 0.5)
        n = 5
        pts = []
        for k in range(n):
            t = k / (n - 1)
            # Up fast, over, and down to the ground at the tip.
            h = root.z + rise * math.sin(t * math.pi * 0.92) * (1 - t) ** 0.25 - root.z * t ** 3
            q = root * (1 - t) + out * reach * t
            pts.append(mathutils.Vector((q.x, q.y, h)))
        r0 = rng.uniform(0.012, 0.018)
        for k in range(n - 1):
            vec = pts[k + 1] - pts[k]
            rot = vec.to_track_quat("Z", "Y").to_euler()
            w = r0 * (1.0 - 0.45 * k / (n - 1))
            # Four-sided and open-ended: eighteen canes of chamfered timber
            # were three thousand triangles of a bramble's budget.
            p.append(trees.segment(tuple(pts[k]), tuple(vec), vec.length + 0.02, w, w * 0.85, verts=4,
                                   mat="cedarbark", name="cane"))
            # Leaf the whole way along, two sprays crossed, so an arching
            # cane is a green arch and not a bare pole.
            d = vec.normalized()
            side = d.cross(mathutils.Vector((0, 0, 1)))
            if side.length < 1e-3:
                continue
            side.normalize()
            for twist in (0.5, -0.5):
                v = (side * math.cos(twist) + mathutils.Vector((0, 0, 1)) * math.sin(twist)).normalized()
                cards.card(pts[k] - d * 0.05, d, v, vec.length * 1.25, 0.46, 0.3,
                           mathutils.Vector((0, 0, 1)) + out * 0.5)
    return trees.deliver_conifer(p, cards.mesh("leaves"), "bramble")


def build_tall_weeds():
    """Dock and thistle gone to seed: a clump of stiff dead stalks a metre
    and a half high, dried to the colour of straw, with leaves still green at
    the foot -- long, plain, some yellowing -- as cut-out sprays fanning out
    of the ground and up the lower stalks, where they were squashed spheres."""
    lib.reset()
    rng = rng_for(92311)
    p = []
    cards = trees.Cards("weedleaf", tile=0.5)
    centre = mathutils.Vector((0, 0, 0.25))
    for i in range(14):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0, 0.45)
        h = rng.uniform(0.9, 1.6)
        lean = (rng.uniform(-0.18, 0.18), rng.uniform(-0.18, 0.18), 0)
        x, y = math.cos(a) * r, math.sin(a) * r
        p.append(lib.cylinder(0.012, h, (x, y, h / 2), lean, verts=4, name="stalk", mat="thatch"))
        tip = mathutils.Vector((0, 0, h / 2))
        tip.rotate(mathutils.Euler(lean))
        head = lib.sphere(0.05, (x + tip.x, y + tip.y, h / 2 + tip.z + 0.08), segments=5, rings=4, name="seed",
                          mat="thatch")
        head.scale = (0.8, 0.8, 2.6)
        p.append(head)
        if i % 2 == 0:
            up = mathutils.Vector((0, 0, 1))
            up.rotate(mathutils.Euler(lean))
            v = mathutils.Vector((math.cos(a + 1.3), math.sin(a + 1.3), 0))
            cards.card(mathutils.Vector((x, y, 0.1)), up, v, h * 0.5, 0.34, 0.25,
                       trees.outward(mathutils.Vector((x, y, 0.4)), centre, 0.5))
    for i in range(10):
        # The rosette: leaves lying out from the foot, arching over.
        a = 2 * math.pi * i / 10 + rng.uniform(-0.2, 0.2)
        u = mathutils.Vector((math.cos(a), math.sin(a), rng.uniform(0.25, 0.6))).normalized()
        side = u.cross(mathutils.Vector((0, 0, 1))).normalized()
        base = mathutils.Vector((math.cos(a) * 0.08, math.sin(a) * 0.08, 0.02))
        cards.card(base, u, side, rng.uniform(0.45, 0.6), 0.3, 0.3, trees.outward(base + u * 0.3, centre, 0.8))
    return trees.deliver_conifer(p, cards.mesh("leaves"), "tall_weeds")


def build_collapsed_shed():
    """A lean-to that has given up: the back wall still standing, one side
    down flat, the roof slid off the front and resting on its edge."""
    lib.reset()
    rng = rng_for(92321)
    p = []
    Wd, D = 3.0, 2.2
    for i in range(12):
        x = -Wd / 2 + 0.125 + i * 0.25
        h = 2.0 - (x + Wd / 2) * 0.12 + rng.uniform(-0.25, 0.05)
        p.append(kit.timber((0.23, 0.04, h), (x, D / 2, h / 2), (0, 0, 0), "boards", 0.006, "board"))
    p.append(kit.timber((0.14, 0.14, 2.1), (-Wd / 2, D / 2 - 0.08, 1.05), (0, 0, 0), "oak", 0.02, "post"))
    p.append(kit.timber((0.14, 0.14, 1.9), (Wd / 2, D / 2 - 0.08, 0.95), (0, 0, 0), "oak", 0.02, "post"))
    # The side that fell, lying flat.
    for i in range(8):
        p.append(kit.timber((0.04, 0.23, 1.7), (Wd / 2 + 0.9, D / 2 - 0.13 - i * 0.25, 0.03),
                            (0, math.pi / 2, 0), "boards", 0.006, "fallen"))
    # The roof, off its bearing and down across the front.
    roof = []
    for i in range(13):
        roof.append(kit.timber((0.23, 2.6, 0.04), (-Wd / 2 + 0.1 + i * 0.25, 0, 0), (0, 0, 0), "boards", 0.006,
                               "roofboard"))
    kit.place(roof, (0.1, -0.1, 1.0), (math.radians(-36), 0, 0.05))
    p += roof
    p.append(kit.timber((0.12, 0.12, 2.4), (-0.4, -0.5, 0.5), (math.radians(64), 0, 0.3), "oak", 0.02, "rafter"))
    return deliver(p, "collapsed_shed")


def build_dead_planter():
    """A stone planter in a courtyard where "someone forgot to water the
    plants and they all died": the box, cracked, dry earth, and a dead shrub
    of bare twigs."""
    lib.reset()
    rng = rng_for(92331)
    p = []
    L, Wd, H = 1.8, 0.9, 0.62
    for sy in (-1, 1):
        p.append(kit.slab((L, 0.14, H), (0, sy * (Wd / 2 - 0.07), H / 2), mat="stonewall", name="side", width=0.03))
    for sx in (-1, 1):
        p.append(kit.slab((0.14, Wd - 0.28, H), (sx * (L / 2 - 0.07), 0, H / 2), mat="stonewall", name="end",
                          width=0.03))
    p.append(lib.box((L - 0.28, Wd - 0.28, 0.08), (0, 0, H - 0.1), name="earth", mat="dirt"))
    for i in range(7):
        a = rng.uniform(0, 2 * math.pi)
        lean = (math.cos(a) * 0.5, math.sin(a) * 0.5, 0)
        h = rng.uniform(0.5, 0.95)
        p.append(lib.cylinder(0.015, h, (rng.uniform(-0.3, 0.3), rng.uniform(-0.12, 0.12), H + h / 2 - 0.1), lean,
                              verts=4, name="twig", mat="bark"))
    return deliver(p, "dead_planter")


def build_broken_stair():
    """"A set of stairs used to extend up to a suite of rooms but the set is
    missing stairs 3-15": an outside stair up the courtyard wall to a landing
    and a door. Treads one and two are still there, and the top one; the
    strings are snapped off after the second and start again under the
    fifteenth, and the fallen treads lie in a heap under the gap. The wall
    is at +Y; the flight climbs along +X."""
    lib.reset()
    rng = rng_for(92341)
    p = []
    rise, going, Wd = 0.2, 0.26, 1.1
    x0, y = -3.2, -Wd / 2 + 0.25
    for i in (1, 2, 16):
        p.append(kit.slab((going + 0.05, Wd, 0.06), (x0 + i * going, y, i * rise), mat="planks", name="tread",
                          width=0.01))
    # String stubs: under the foot, and hanging from the landing.
    L = math.hypot(going, rise)
    ang = math.atan2(rise, going)
    for sy in (-1, 1):
        for (i0, i1) in ((0, 2.7), (14.3, 17)):
            n = i1 - i0
            cx = x0 + (i0 + i1) / 2 * going
            cz = (i0 + i1) / 2 * rise - 0.1
            p.append(kit.timber((L * n, 0.07, 0.26), (cx, y + sy * (Wd / 2 + 0.03), cz), (0, -ang, 0), "oak", 0.015,
                                "string"))
    top = 17 * rise
    lx = x0 + 17 * going + 0.6
    p.append(kit.slab((1.3, Wd + 0.2, 0.12), (lx, y, top), mat="planks", name="landing", width=0.02))
    for sx in (-1, 1):
        p.append(kit.timber((0.14, 0.14, top), (lx + sx * 0.55, y - Wd / 2 + 0.05, top / 2), (0, 0, 0), "oak", 0.02,
                            "post"))
    p.append(kit.timber((0.1, 0.1, top - 0.3), (lx, y - Wd / 2 + 0.05, (top - 0.3) / 2), (0, math.radians(30), 0),
                        "oak", 0.015, "brace"))
    # The door the stair was for, up in the wall.
    for sx in (-1, 1):
        p.append(kit.timber((0.16, 0.16, 2.2), (lx + sx * 0.6, 0.3, top + 1.1), (0, 0, 0), "oak", 0.02, "jamb"))
    p.append(kit.timber((1.4, 0.18, 0.2), (lx, 0.3, top + 2.25), (0, 0, 0), "oak", 0.02, "head"))
    p += board_up(lx, top + 0.1, 1.05, 2.05, 0.2, rng, n=5)
    # A rail post and a length of handrail, still on at the top.
    p.append(kit.timber((0.08, 0.08, 1.0), (lx - 0.6, y - Wd / 2 - 0.02, top + 0.5), (0, 0, 0), "oak", 0.01, "baluster"))
    p.append(kit.timber((1.4, 0.07, 0.07), (lx - 1.1, y - Wd / 2 - 0.02, top + 0.85), (0, ang, 0), "oak", 0.01, "rail"))
    for i in range(7):
        p.append(kit.timber((Wd * rng.uniform(0.6, 1.0), 0.26, 0.05),
                            (x0 + rng.uniform(4, 11) * going, y + rng.uniform(-0.4, 0.4), 0.03 + i * 0.045),
                            (rng.uniform(-0.2, 0.2), rng.uniform(-0.2, 0.2), rng.uniform(0, 3)), "planks", 0.008,
                            "fallen"))
    return deliver(p, "broken_stair")


def build_crystal_stump():
    """One of Ice Dragon Way's crystal statues, smashed: the plinth, the
    statue's feet and shins standing on it broken off at the knee, and the
    rest of it in shards round the base."""
    lib.reset()
    rng = rng_for(92351)
    p = []
    p.append(kit.slab((1.3, 1.3, 0.3), (0, 0, 0.15), mat="marble", name="base", width=0.04))
    p.append(kit.slab((1.0, 1.0, 0.8), (0, 0, 0.7), mat="marble", name="die", width=0.03))
    p.append(kit.slab((1.15, 1.15, 0.16), (0, 0, 1.18), mat="marble", name="cap", width=0.03))
    for sx in (-1, 1):
        leg = lib.loft([(1.26, 0.13, 0.11, sx * 0.14, 0), (1.5, 0.1, 0.09, sx * 0.15, 0),
                        (1.9, 0.12, 0.1, sx * 0.15, 0.01), (2.05 + (0.18 if sx > 0 else 0), 0.11, 0.1, sx * 0.15, 0.02)],
                       sides=7, axis="z", name="shin", mat="crystal")
        p.append(leg)
        p.append(kit.slab((0.2, 0.34, 0.1), (sx * 0.15, -0.06, 1.31), mat="crystal", name="foot", width=0.02))
    for i in range(12):
        a = rng.uniform(0, 2 * math.pi)
        r = rng.uniform(0.9, 1.9)
        s = rng.uniform(0.08, 0.26)
        shard = lib.cone(s * 0.6, 0.0, s * 2.2, (math.cos(a) * r, math.sin(a) * r, s * 0.25),
                         (rng.uniform(1.2, 1.9), 0, a), verts=4, name="shard", mat="crystal")
        p.append(shard)
    return deliver(p, "crystal_stump")


# --- the street furniture of a bad district -----------------------------------------

def build_boarded_window():
    """Boards nailed over a window, for the frontage build.js brings forward:
    a stone surround with its sill, and five boards across it. The wall face
    is at y = 0 and everything stands out into -Y; origin on the ground under
    the opening, whose sill is 1.3 m up."""
    lib.reset()
    rng = rng_for(92401)
    p = []
    ow, oh, sill = 1.3, 1.6, 1.3
    # The dark of the opening behind the boards: a shallow recess face.
    p.append(lib.box((ow, 0.05, oh), (0, 0.06, sill + oh / 2), name="recess", mat="charred"))
    for sx in (-1, 1):
        p.append(kit.timber((0.2, 0.16, oh + 0.2), (sx * (ow / 2 + 0.1), -0.06, sill + oh / 2), (0, 0, 0), "sootwall",
                            0.03, "jamb"))
    p.append(kit.timber((ow + 0.6, 0.18, 0.22), (0, -0.07, sill + oh + 0.11), (0, 0, 0), "sootwall", 0.03, "lintel"))
    p.append(kit.timber((ow + 0.55, 0.3, 0.12), (0, -0.13, sill - 0.06), (0, 0, 0), "sootwall", 0.03, "sill"))
    p += board_up(0, sill, ow, oh, -0.15, rng, n=5)
    return deliver(p, "boarded_window")


def build_boarded_door():
    """A doorway nailed shut: its surround, and boards across where the leaf
    was, braced corner to corner. Wall face at y = 0, standing out to -Y."""
    lib.reset()
    rng = rng_for(92411)
    p = []
    ow, oh = 1.5, 2.5
    p.append(lib.box((ow, 0.05, oh), (0, 0.06, oh / 2), name="recess", mat="charred"))
    for sx in (-1, 1):
        p.append(kit.timber((0.24, 0.18, oh + 0.24), (sx * (ow / 2 + 0.12), -0.07, (oh + 0.24) / 2), (0, 0, 0),
                            "sootwall", 0.03, "jamb"))
    p.append(kit.timber((ow + 0.7, 0.2, 0.3), (0, -0.08, oh + 0.15), (0, 0, 0), "sootwall", 0.03, "lintel"))
    p.append(kit.slab((ow + 0.5, 0.5, 0.12), (0, -0.2, 0.06), mat="sootwall", name="step", width=0.02))
    p += board_up(0, 0.1, ow, oh - 0.1, -0.17, rng, n=7)
    return deliver(p, "boarded_door")


def build_barred_window():
    """"A barred window ... a light coming from the cracks around it."
    Iron bars in a stone surround, and inside them shutters drawn to with a
    gap, and glass behind that the viewer lights after dark. Wall face at
    y = 0; origin on the ground under it, sill 1.4 m up."""
    lib.reset()
    p = []
    ow, oh, sill = 1.2, 1.4, 1.4
    p.append(lib.box((ow, 0.04, oh), (0, 0.12, sill + oh / 2), name="pane", mat="glass"))
    for sx in (-1, 1):
        p.append(kit.timber((ow / 2 - 0.05, 0.05, oh - 0.06), (sx * (ow / 4 + 0.035), 0.06, sill + oh / 2),
                            (0, 0, 0), "planks", 0.01, "shutter"))
        p.append(kit.timber((0.22, 0.2, oh + 0.24), (sx * (ow / 2 + 0.11), -0.06, sill + oh / 2), (0, 0, 0),
                            "sootwall", 0.03, "jamb"))
    p.append(kit.timber((ow + 0.66, 0.22, 0.24), (0, -0.07, sill + oh + 0.12), (0, 0, 0), "sootwall", 0.03,
                        "lintel"))
    p.append(kit.timber((ow + 0.6, 0.34, 0.13), (0, -0.14, sill - 0.065), (0, 0, 0), "sootwall", 0.03, "sill"))
    for i in range(5):
        x = -ow / 2 + ow * (i + 0.5) / 5
        p.append(lib.cylinder(0.022, oh + 0.1, (x, -0.1, sill + oh / 2), verts=6, name="bar", mat="rust"))
    for z in (sill + 0.35, sill + oh - 0.35):
        p.append(kit.timber((ow + 0.1, 0.03, 0.05), (0, -0.1, z), (0, 0, 0), "rust", 0.01, "rail"))
    return deliver(p, "barred_window")


def build_shoring():
    """Raking shores against a failing front: three raking timbers from a
    sole plate on the street up to a wall plate spiked to the house, with
    their foot wedges. "The building could collapse at any moment." Wall
    face at y = 0, the shores reaching out into -Y."""
    lib.reset()
    p = []
    p.append(kit.timber((0.3, 0.1, 6.0), (0, -0.05, 3.2), (0, 0, 0), "oak", 0.02, "wall_plate"))
    p.append(kit.timber((0.34, 3.4, 0.22), (0, -2.4, 0.11), (math.radians(-6), 0, 0), "oak", 0.03, "sole"))
    for (top, foot) in ((5.6, 3.9), (4.2, 3.1), (2.8, 2.2)):
        v = mathutils.Vector((0, -foot, -top))
        mid = (0, -foot / 2, top / 2)
        rot = v.to_track_quat("Z", "Y").to_euler()
        p.append(kit.timber((0.22, 0.22, v.length), mid, tuple(rot), "oak", 0.03, "shore"))
        p.append(kit.timber((0.26, 0.32, 0.14), (0, -foot + 0.12, 0.28), (math.radians(-20), 0, 0), "planks", 0.02,
                            "wedge"))
    p.append(kit.timber((0.1, 3.0, 0.14), (0.14, -1.6, 1.6), (math.radians(-44), 0, 0), "planks", 0.02, "brace"))
    return deliver(p, "shoring")


def build_debris():
    """What a fight leaves in the road: a stove-in barrel, broken boards, a
    smashed pot, a stick. Small, so build.js can scatter it."""
    lib.reset()
    rng = rng_for(92421)
    p = []
    bx, by = 0.3, 0.2
    for i in range(12):
        if i in (2, 3, 4):
            continue
        t = 2 * math.pi * i / 12
        tilt = 0.5 if i in (1, 5) else 0
        p.append(kit.timber((0.08, 0.025, 0.7), (bx + 0.29 * math.cos(t), by + 0.29 * math.sin(t), 0.08 + tilt * 0.1),
                            (math.pi / 2 - 0.1, 0, t + math.pi / 2), "oak", 0.006, "stave"))
    p.append(lib.torus(0.3, 0.018, (bx, by, 0.25), (math.pi / 2, 0, 0.3), major_seg=12, minor_seg=3, name="hoop",
                       mat="rust"))
    for i in range(5):
        p.append(kit.timber((rng.uniform(0.6, 1.2), 0.14, 0.03), (rng.uniform(-0.9, 0.3), rng.uniform(-0.7, 0.6), 0.02),
                            (rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), rng.uniform(0, 3)), "boards", 0.006,
                            "board"))
    for i in range(6):
        p.append(kit.slab((rng.uniform(0.07, 0.14), rng.uniform(0.05, 0.1), 0.02),
                          (rng.uniform(-0.8, 0.9), rng.uniform(-0.6, 0.7), 0.02),
                          (rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), rng.uniform(0, 3)), mat="rooftile",
                          name="sherd", width=0.004))
    p.append(kit.timber((0.05, 0.05, 1.1), (-0.4, 0.4, 0.03), (math.pi / 2, 0, 0.8), "oak", 0.01, "stick"))
    return deliver(p, "debris")


def build_city_wall():
    """Thirteen metres of the town's curtain wall, seen from inside it --
    Wall Road "extends south along the inside of the wall surrounding the
    city". Front (-Y) is the town side: a battered plinth, buttresses, the
    wall walk's parapet. The field side is merloned. 7.4 m to the walk."""
    lib.reset()
    p = []
    L, D, H = 13.0, 2.4, 7.4
    p.append(kit.slab((L, D, H), (0, 0, H / 2), mat="stonewall", name="curtain", width=0.06))
    p += kit.plinth(L, D, 0.0, 0.7, proud=0.16, mat="stonewall")
    # Buttresses on the town side.
    for x in (-4.4, 0.0, 4.4):
        p.append(kit.timber((1.1, 0.9, H - 1.4), (x, -D / 2 - 0.44, (H - 1.4) / 2), (0, 0, 0), "stonewall", 0.06,
                            "buttress"))
        p.append(kit.timber((1.1, 0.95, 0.9), (x, -D / 2 - 0.3, H - 1.1), (math.radians(-38), 0, 0), "stonewall", 0.05,
                            "weathering"))
    # String course under the walk.
    p.append(kit.timber((L + 0.02, D + 0.3, 0.26), (0, 0, H - 0.1), (0, 0, 0), "stonewall", 0.05, "string"))
    # The parapet on the field side, merloned; a low one on the town side.
    p.append(kit.timber((L, 0.55, 0.9), (0, D / 2 - 0.28, H + 0.45), (0, 0, 0), "stonewall", 0.04, "parapet"))
    for i in range(7):
        x = -L / 2 + 0.95 + i * (L - 1.9) / 6
        p.append(kit.slab((1.05, 0.58, 1.05), (x, D / 2 - 0.28, H + 1.42), mat="stonewall", name="merlon", width=0.04))
    p.append(kit.timber((L, 0.4, 0.95), (0, -D / 2 + 0.2, H + 0.47), (0, 0, 0), "stonewall", 0.04, "rail"))
    # Putlog holes and a drain spout: dark notes on a long plain face.
    for (x, z) in ((-2.2, 3.1), (2.2, 3.1), (-6.0, 5.2), (6.0, 5.2)):
        p.append(lib.box((0.24, 0.1, 0.24), (x, -D / 2 - 0.02, z), name="putlog", mat="charred"))
    p.append(kit.timber((0.22, 0.7, 0.18), (-2.2, -D / 2 - 0.3, H - 0.3), (0, 0, 0), "stonewall", 0.03, "spout"))
    return deliver(p, "city_wall")


# --- delivery -------------------------------------------------------------------

def deliver(parts, name):
    """kit.deliver: apply, join, re-origin at the ground, project UVs, export."""
    return kit.deliver(parts, name)


BUILDERS = {
    "house_derelict": build_house_derelict,
    "house_gutted": build_house_gutted,
    "ruin_wall_solid": lambda: ruin_panel("ruin_wall_solid", 92051),
    "ruin_wall_door": lambda: ruin_panel("ruin_wall_door", 92052, door=True),
    "ruin_wall_breach": lambda: ruin_panel("ruin_wall_breach", 92053, breach=True),
    "ruin_corner": build_ruin_corner,
    "rubble_heap": build_rubble_heap,
    "charred_beams": build_charred_beams,
    "barricade": build_barricade,
    "barricade_stakes": build_barricade_stakes,
    "burnt_cart": build_burnt_cart,
    "brazier": build_brazier,
    "crow": build_crow,
    "dracolich_idol": build_dracolich_idol,
    "training_pell": build_training_pell,
    "khan_memorial": build_khan_memorial,
    "bramble": build_bramble,
    "tall_weeds": build_tall_weeds,
    "collapsed_shed": build_collapsed_shed,
    "dead_planter": build_dead_planter,
    "broken_stair": build_broken_stair,
    "crystal_stump": build_crystal_stump,
    "boarded_window": build_boarded_window,
    "boarded_door": build_boarded_door,
    "barred_window": build_barred_window,
    "shoring": build_shoring,
    "debris": build_debris,
    "city_wall": build_city_wall,
}


def build(only=None):
    out = []
    for name, fn in BUILDERS.items():
        if only and name not in only:
            continue
        out.append(fn())
    return "\n".join(out)


# --- looking at it ------------------------------------------------------------

PREVIEW = {
    "sootwall": (0.30, 0.28, 0.26), "charred": (0.05, 0.045, 0.04), "boards": (0.42, 0.40, 0.36),
    "ash": (0.35, 0.34, 0.32), "oldbone": (0.78, 0.74, 0.62), "crystal": (0.75, 0.85, 0.92),
    "stonewall": (0.55, 0.52, 0.47), "planks": (0.35, 0.22, 0.12), "oak": (0.22, 0.14, 0.08),
    "rust": (0.35, 0.18, 0.1), "iron": (0.1, 0.1, 0.1), "rooftile": (0.45, 0.2, 0.12), "thatch": (0.55, 0.45, 0.25),
    "cloth": (0.5, 0.45, 0.4), "rope": (0.5, 0.42, 0.3), "bark": (0.2, 0.14, 0.1), "leaves": (0.14, 0.24, 0.1),
    "hair": (0.1, 0.08, 0.07), "marble": (0.85, 0.83, 0.78), "dirt": (0.3, 0.24, 0.17), "glass": (0.9, 0.7, 0.4),
    "timber": (0.7, 0.62, 0.5),
}


def preview(names, path="/tmp/hood-preview.png", cols=4, pitch=14.0, elev=30.0, azim=-20.0, dist=None, res=1400):
    """Import the exported files -- what the viewer loads, not the scene that
    made them -- lay them out in a grid, rake a low sun across them and render."""
    import os
    lib.reset()
    placed = []
    for i, name in enumerate(names):
        path_glb = os.path.join(lib.ASSETS, "%s.glb" % name)
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=path_glb)
        dx = (i % cols - (cols - 1) / 2.0) * pitch
        dy = -(i // cols) * pitch
        for obj in set(bpy.context.scene.objects) - before:
            if obj.parent is None:
                obj.location.x += dx
                obj.location.y += dy
            placed.append(obj)
    for mat in bpy.data.materials:
        key = mat.name.replace("MAT:", "").split(".")[0]
        if mat.node_tree:
            bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf:
                c = PREVIEW.get(key, (0.6, 0.6, 0.6))
                bsdf.inputs["Base Color"].default_value = (c[0], c[1], c[2], 1.0)
                bsdf.inputs["Roughness"].default_value = 0.8
    kit.human(-(cols - 1) / 2.0 * pitch - 3.5, 2.0)
    kit.rake(azim=58.0, elev=24.0, strength=4.0, fill=0.25)
    rows = (len(names) + cols - 1) // cols
    cy = -(rows - 1) * pitch / 2
    bpy.context.view_layer.update()
    top = max((max((o.matrix_world @ mathutils.Vector(c)).z for c in o.bound_box) for o in placed
               if o.type == "MESH"), default=3.0)
    span = max(cols, rows * 1.2) * pitch
    return kit.shot(path, center=(0, cy, top * 0.3), dist=dist or (span * 0.75 + top * 1.0), azim=azim, elev=elev,
                    res=res, lens=40.0)
