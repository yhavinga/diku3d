"""sewer -- the brick tunnels under Midgaard, as a kit the layout can assemble.

The mud's sewer is a grid of pipes and junctions: "enormous concrete pipes
leading north, south, east and west", "a huge junction of sewer pipes right
under what you'd think was an air shaft", "you stand in water to your waist".
`layout.js` decides at run time which sides of a cell have a way out, so what
ships here is not a sewer but the parts of one, the same move roomkit made for
walls:

* `sewer_tunnel` -- 13 m of straight barrel vault, one whole cell, so a run of
  routed cells is one continuous tunnel with nothing to line up.
* `sewer_hub` + `sewer_arm` + `sewer_hub_end` -- a routed cell that bends: a
  4.4 m groin-vaulted crossing, an arm out to the cell edge on every side with
  a way out, and a blind end wall on every side without one.
* `sewer_chamber` + `sewer_wall_open` / `sewer_wall_solid` -- a room: a 9 m
  groin-vaulted chamber on four corner piers, closed by one lunette wall per
  side, each either pierced by a tunnel mouth or blind.
* `sewer_shaft_open` / `sewer_shaft_solid` -- the walls of a chamber a stair
  climbs out of, carried straight up to the floor of the room above instead of
  turning into a vault the stair would have to go through.

Everything is authored for a tunnel along Blender +Y, which the glTF exporter
turns into three's -Z, north: a wall or an arm is built on the north side of
its cell and build.js swings it round with FACE_ROT, like the room kit.

The section is the one every piece shares, so any two of them meet on it:
walkways at 0, a channel 1.3 m wide sunk 0.32 m between dressed kerbs, water
standing in it at -0.16, brick walls to a springing at 1.9 and a semicircular
vault to a crown at 4.1. Brick is laid in courses along the tunnel all the way
over, which means the vault's UVs are written here by arc length rather than
cube-projected -- a cube projection turns the courses through ninety degrees
at 45 degrees up the vault, which is a seam no bricklayer leaves.
"""

import math
import random
import importlib

import bpy

import lib
import kit
import trees
importlib.reload(lib)
importlib.reload(kit)
importlib.reload(trees)

CELL = 13.0
HALF = CELL / 2.0

# The tunnel section.
A = 2.2              # half the clear width
SPRING = 1.9         # walls stand to here, then the vault turns over
CH = 0.65            # half the channel
KERB = 0.30          # dressed kerb along each lip of the channel
SUMP = -0.32         # channel invert
WATER = -0.16        # what stands in it
RIB_AT = (-3.25, 3.25)  # transverse ribs, same pitch in every cell
# The town's iron as it is underground: see `buried` in src/textures.js.
IRON = "rustiron"

# The chamber a room is built as.
CA = 4.5             # half the clear span
C_SPRING = 2.6
C_RISE = 2.4         # a segmental vault: crown at 5.0
WALL_T = 0.4
SHAFT_H = 7.6 - 0.45  # a stair chamber's walls run up to the next floor's slab


# --- raw geometry ---------------------------------------------------------

def mesh(name, verts, faces, uvs=None, mat="brick", toward=None, smooth=False):
    """An object straight from vertex and face lists, with per-vertex UVs in
    metres when given.

    Winding is not trusted: `toward(centre)` names a point each face must look
    at, and any face looking away is flipped. A vault wound the wrong way is
    backface-culled into nothing from the only side anyone sees it, and the
    permutation trap `kit.timber` fell into is exactly this -- so it is
    settled by sampling the normals rather than by reasoning about loops."""
    if toward is not None:
        fixed = []
        for f in faces:
            pts = [verts[i] for i in f]
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            cz = sum(p[2] for p in pts) / len(pts)
            # Newell normal: fine for any planar-ish polygon, triangles included.
            nx = ny = nz = 0.0
            for i in range(len(pts)):
                a, b = pts[i], pts[(i + 1) % len(pts)]
                nx += (a[1] - b[1]) * (a[2] + b[2])
                ny += (a[2] - b[2]) * (a[0] + b[0])
                nz += (a[0] - b[0]) * (a[1] + b[1])
            tx, ty, tz = toward((cx, cy, cz))
            if nx * (tx - cx) + ny * (ty - cy) + nz * (tz - cz) < 0:
                f = tuple(reversed(f))
            fixed.append(f)
        faces = fixed
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    if uvs is not None:
        layer = me.uv_layers.new(name="UVMap")
        for poly in me.polygons:
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                layer.data[li].uv = uvs[vi]
    if smooth:
        # A 16-sided vault shaded flat is sixteen planks. The sectors and the
        # rings are separate objects when they are joined, so a groin or a rib
        # edge keeps its crease: only faces sharing vertices are averaged.
        for poly in me.polygons:
            poly.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj["custom_uv"] = uvs is not None
    return lib.assign(obj, mat)


def arc(a, spring, steps=16):
    """Semicircle from the left springing over the crown to the right one, as
    (x, z, s) with s the arc length from the left springing."""
    pts = []
    for i in range(steps + 1):
        th = math.pi - math.pi * i / steps
        pts.append((a * math.cos(th), spring + a * math.sin(th), a * (math.pi - th)))
    return pts


def section(a=A, spring=SPRING, steps=16):
    """The tunnel's inside face, walkway to walkway: up the left wall, over the
    vault, down the right wall. s runs on continuously so the courses do."""
    pts = [(-a, 0.0, 0.0)]
    for (x, z, s) in arc(a, spring, steps):
        pts.append((x, z, spring + s))
    pts.append((a, 0.0, 2 * spring + math.pi * a))
    return pts


def sweep(pts, y0, y1, name, mat="brick", centre=(0.0, 1.5)):
    """Extrude a section along +Y, every face looking at the tunnel's axis."""
    verts, faces, uvs = [], [], []
    for (x, z, s) in pts:
        verts += [(x, y0, z), (x, y1, z)]
        uvs += [(y0, s), (y1, s)]
    for i in range(len(pts) - 1):
        faces.append((2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2))
    return mesh(name, verts, faces, uvs, mat,
                toward=lambda c: (centre[0], c[1], centre[1]), smooth=True)


def offset(pts, depth):
    """The section moved `depth` into the tunnel along its own normal."""
    out = []
    for i, (x, z, s) in enumerate(pts):
        nx = nz = 0.0
        for j in (i - 1, i):
            if 0 <= j < len(pts) - 1:
                dx = pts[j + 1][0] - pts[j][0]
                dz = pts[j + 1][1] - pts[j][1]
                ln = math.hypot(dx, dz) or 1.0
                nx += dz / ln
                nz += -dx / ln
        ln = math.hypot(nx, nz) or 1.0
        out.append((x + nx / ln * depth, z + nz / ln * depth, s))
    return out


def band(pts, y0, y1, depth, name, mat="ashlar"):
    """A rib: the section offset `depth` into the tunnel and closed on both
    sides back to the wall it stands proud of."""
    inner = offset(pts, depth)
    parts = [sweep(inner, y0, y1, name + "_face", mat)]
    for (y, look) in ((y0, -1.0), (y1, 1.0)):
        verts, faces, uvs = [], [], []
        for (p, q) in zip(pts, inner):
            verts += [(p[0], y, p[1]), (q[0], y, q[1])]
            uvs += [(p[0], p[1]), (q[0], q[1])]
        for i in range(len(pts) - 1):
            faces.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
        parts.append(mesh(name + "_cheek", verts, faces, uvs, mat,
                          toward=lambda c, look=look: (c[0], c[1] + look, c[2])))
    return parts


def quad_box(x0, x1, y0, y1, z0, z1, name, mat, cham=0.0):
    """Axis box by its bounds. A chamfered one is a kit.slab."""
    size = (x1 - x0, y1 - y0, z1 - z0)
    loc = ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    if cham:
        return kit.slab(size, loc, mat=mat, name=name, width=cham)
    return lib.box(size, loc, name=name, mat=mat)


def flat(name, corners, mat, look):
    """One quad with planar UVs in metres, facing along `look`."""
    uvs = []
    for (x, y, z) in corners:
        if abs(look[2]) > 0.5:
            uvs.append((x, y))
        elif abs(look[0]) > 0.5:
            uvs.append((y, z))
        else:
            uvs.append((x, z))
    return mesh(name, list(corners), [(0, 1, 2, 3)], uvs, mat,
                toward=lambda c: (c[0] + look[0], c[1] + look[1], c[2] + look[2]))


def grate(x0, x1, y, z0, z1, bars=6, name="grate"):
    """Upright iron bars across a channel end, in a frame."""
    p = []
    w = x1 - x0
    for i in range(bars):
        x = x0 + w * (i + 0.5) / bars
        p.append(kit.timber((0.035, 0.035, z1 - z0), (x, y, (z0 + z1) / 2), (0, 0, 0),
                            IRON, 0.008, name))
    p.append(kit.timber((w, 0.05, 0.05), (x0 + w / 2, y, z1 - 0.04), (0, 0, 0), IRON, 0.01, name))
    p.append(kit.timber((w, 0.05, 0.05), (x0 + w / 2, y, (z0 + z1) / 2), (0, 0, 0), IRON, 0.01, name))
    return p


# --- the tunnel -----------------------------------------------------------

def floor_run(y0, y1, name="floor"):
    """Walkways, kerbs, channel and the water in it, from y0 to y1."""
    p = []
    for sx in (-1, 1):
        lo, hi = sorted((sx * (CH + KERB), sx * A))
        p.append(quad_box(lo, hi, y0, y1, -0.3, 0.0, name + "_walk", "sewerflag"))
        klo, khi = sorted((sx * CH, sx * (CH + KERB)))
        # The kerb's inner face is the channel wall; its top stands a hair
        # proud of the walkway so the two never share a plane.
        p.append(quad_box(klo, khi, y0, y1, SUMP - 0.02, 0.025, name + "_kerb", "ashlar", 0.02))
    p.append(flat(name + "_invert", [(-CH, y0, SUMP), (CH, y0, SUMP), (CH, y1, SUMP), (-CH, y1, SUMP)],
                  "sludge", (0, 0, 1)))
    # One quad, up: the viewer's sewage material does the rest.
    p.append(flat(name + "_water", [(-CH, y0, WATER), (CH, y0, WATER), (CH, y1, WATER), (-CH, y1, WATER)],
                  "sewage", (0, 0, 1)))
    return p


def tunnel_run(y0, y1, name="tunnel", ribs=True):
    """The shell, the string course at the springing, the ribs, the floor."""
    p = [sweep(section(), y0, y1, name + "_shell")]
    for sx in (-1, 1):
        lo, hi = sorted((sx * (A - 0.07), sx * A))
        p.append(quad_box(lo, hi, y0, y1, SPRING - 0.22, SPRING, name + "_string", "ashlar", 0.02))
    if ribs:
        for y in RIB_AT:
            if y0 + 0.25 < y < y1 - 0.25:
                p += band(section(), y - 0.22, y + 0.22, 0.11, name + "_rib")
    p += floor_run(y0, y1, name)
    return p


def channel_end(y, name):
    """Where a channel stops at a hub or a chamber: the water goes on under the
    floor through a grating, over a stone sill."""
    p = grate(-CH, CH, y + 0.05, SUMP, 0.0, 6, name + "_grate")
    p.append(quad_box(-CH, CH, y - 0.02, y + 0.03, SUMP - 0.02, SUMP + 0.03, name + "_sill", "ashlar"))
    # The end face of the channel, under the floor's edge.
    p.append(flat(name + "_end", [(-CH, y, SUMP), (CH, y, SUMP), (CH, y, 0.0), (-CH, y, 0.0)],
                  "brick", (0, 1, 0)))
    return p


def build_tunnel():
    lib.reset()
    return deliver(tunnel_run(-HALF, HALF), "sewer_tunnel")


def build_arm():
    """From the hub's edge out to the cell's, pointing north."""
    lib.reset()
    p = tunnel_run(A, HALF, "arm")
    p += channel_end(A, "arm")
    return deliver(p, "sewer_arm")


def groin(a, h, steps=12, rings=10, name="vault", mat="brick", hole=0.0):
    """A groin vault over a square of half-side `a`: the union of two barrels,
    so the ceiling is max(h(x), h(y)) and the groins are the diagonals. Built
    as four sectors, each a piece of one barrel, so the creases are real edges.

    UVs run along the barrel that owns the sector and round its section by arc
    length, as they do in the tunnel."""
    def s_of(t):
        n = 24
        tot = 0.0
        prev = (0.0, h(0.0))
        for i in range(1, n + 1):
            u = t * i / n
            cur = (u, h(u))
            tot += math.hypot(cur[0] - prev[0], cur[1] - prev[1]) * (1 if t >= 0 else 1)
            prev = cur
        return tot if t >= 0 else -tot
    parts = []
    for k in range(4):
        verts, faces, uvs = [], [], []
        c, s = math.cos(k * math.pi / 2), math.sin(k * math.pi / 2)
        idx = {}
        for j in range(rings + 1):
            yy = a * j / rings
            for i in range(steps + 1):
                if j == 0 and i > 0:
                    idx[(j, i)] = idx[(j, 0)]
                    continue
                xx = -yy + 2 * yy * i / steps
                wx, wy = c * xx - s * yy, s * xx + c * yy
                idx[(j, i)] = len(verts)
                verts.append((wx, wy, h(xx)))
                uvs.append((yy, s_of(xx)))
        for j in range(rings):
            for i in range(steps):
                v00, v01 = idx[(j, i)], idx[(j, i + 1)]
                v10, v11 = idx[(j + 1, i)], idx[(j + 1, i + 1)]
                f = (v00, v11, v10) if j == 0 else (v00, v01, v11, v10)
                if hole:
                    cx = sum(verts[k][0] for k in f) / len(f)
                    cy = sum(verts[k][1] for k in f) / len(f)
                    if cx * cx + cy * cy < hole * hole:
                        continue
                faces.append(f)
        parts.append(mesh("%s_%d" % (name, k), verts, faces, uvs, mat,
                          toward=lambda cc: (0.0, 0.0, 0.0), smooth=True))
    return parts


def rib_along(points, width, depth, name="rib", mat="ashlar"):
    """A stone rib hung under a curve in space: `points` along the groin, the
    section `width` across and `depth` deep, sunk a little into the vault so
    no light shows between them."""
    verts, faces, axis = [], [], []
    n = len(points)
    for i, (x, y, z) in enumerate(points):
        j0, j1 = max(0, i - 1), min(n - 1, i + 1)
        tx = points[j1][0] - points[j0][0]
        ty = points[j1][1] - points[j0][1]
        ln = math.hypot(tx, ty) or 1.0
        px, py = -ty / ln * width / 2, tx / ln * width / 2
        top, bot = z + 0.10, z - depth
        verts += [(x - px, y - py, top), (x + px, y + py, top),
                  (x + px, y + py, bot), (x - px, y - py, bot)]
    for i in range(n - 1):
        b, c = 4 * i, 4 * (i + 1)
        faces += [(b + 1, c + 1, c + 2, b + 2), (b + 3, c + 3, c + 0, b + 0),
                  (b + 2, c + 2, c + 3, b + 3)]

    def away(cc):
        # From the nearest point on the rib's centre line, outwards.
        best = min(points, key=lambda p: (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2)
        mid = (best[0], best[1], best[2] - depth / 2 + 0.05)
        return (2 * cc[0] - mid[0], 2 * cc[1] - mid[1], 2 * cc[2] - mid[2])
    return mesh(name, verts, faces, None, mat, toward=away)


def circle_h(a, spring):
    return lambda t: spring + math.sqrt(max(0.0, a * a - t * t))


def seg_h(a, spring, rise):
    R = (a * a + rise * rise) / (2 * rise)
    zc = spring + rise - R
    return lambda t: zc + math.sqrt(max(0.0, R * R - t * t))


def build_grate():
    """A drain in a chamber floor: an iron grating in a frame lying on the
    flags, over a square of dark water. The floor is not cut -- at eye height
    a black square two centimetres down and one two metres down are the same
    picture, and an unbroken floor keeps the stair holes the only holes."""
    lib.reset()
    q = 0.55
    p = [flat("grate_dark", [(-q, -q, 0.006), (q, -q, 0.006), (q, q, 0.006), (-q, q, 0.006)],
              "sewage", (0, 0, 1))]
    for sx in (-1, 1):
        p.append(kit.timber((2 * q + 0.12, 0.08, 0.04), (0, sx * (q + 0.02), 0.02), (0, 0, 0),
                            IRON, 0.01, "frame"))
        p.append(kit.timber((0.08, 2 * q + 0.12, 0.04), (sx * (q + 0.02), 0, 0.02), (0, 0, 0),
                            IRON, 0.01, "frame"))
    for i in range(7):
        x = -q + 2 * q * (i + 0.5) / 7
        p.append(kit.timber((0.035, 2 * q, 0.03), (x, 0, 0.022), (0, 0, 0), IRON, 0.008, "bar"))
    for i in range(2):
        y = -q + 2 * q * (i + 1) / 3
        p.append(kit.timber((2 * q, 0.03, 0.02), (0, y, 0.012), (0, 0, 0), IRON, 0.006, "bar"))
    return deliver(p, "sewer_grate")


def build_hub():
    """The crossing a routed bend or junction turns through: the tunnel's own
    section vaulted both ways over a 4.4 m square."""
    lib.reset()
    h = circle_h(A, SPRING)
    p = groin(A, h, name="hub_vault")
    for sgn in (1, -1):
        pts = [(t, sgn * t, h(t)) for t in [-A + 2 * A * i / 16 for i in range(17)]]
        p.append(rib_along(pts, 0.22, 0.10, "hub_rib"))
    p.append(quad_box(-A, A, -A, A, -0.3, 0.0, "hub_floor", "sewerflag"))
    return deliver(p, "sewer_hub")


def pipe_mouth(y, z, r, name="mouth"):
    """A pipe coming out of a wall at `y` (its face looking -Y): a dressed
    ring standing proud, a short dark throat inside it, and the black at the
    back -- all in front of the wall's face, because the wall is not cut.
    A solid cylinder was tried first and its end cap covered the throat."""
    p = [lib.torus(r + 0.06, 0.075, (0.0, y - 0.07, z), (math.pi / 2, 0, 0), major_seg=18, minor_seg=5,
                   name=name + "_ring", mat="ashlar")]
    verts, faces = [], []
    n = 14
    for i in range(n):
        t = 2 * math.pi * i / n
        for yy in (y - 0.14, y - 0.004):
            verts.append((r * math.cos(t), yy, z + r * math.sin(t)))
    for i in range(n):
        j = (i + 1) % n
        faces.append((2 * i, 2 * j, 2 * j + 1, 2 * i + 1))
    p.append(mesh(name + "_throat", verts, faces, None, "sludge",
                  toward=lambda c: (0.0, c[1], z)))
    back = [(r * math.cos(2 * math.pi * i / n), y - 0.004, z + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
    p.append(mesh(name + "_back", back, [tuple(range(n))], None, "sludge",
                  toward=lambda c: (c[0], c[1] - 1, c[2])))
    return p


def build_hub_end():
    """A blind end: brick across the whole section, its face on the hub's
    north edge, with a pipe mouth low in it."""
    lib.reset()
    pts = section()
    verts, faces, uvs = [(0.0, A, SPRING * 0.5)], [], [(0.0, SPRING * 0.5)]
    for (x, z, s) in pts:
        verts.append((x, A, z))
        uvs.append((x, z))
    for i in range(1, len(pts)):
        faces.append((0, i, i + 1))
    verts.append((0.0, A, 0.0))
    uvs.append((0.0, 0.0))
    faces.append((0, len(pts), len(verts) - 1))
    faces.append((0, len(verts) - 1, 1))
    p = [mesh("end_face", verts, faces, uvs, "brick", toward=lambda c: (c[0], c[1] - 1, c[2]))]
    p += pipe_mouth(A, 0.72, 0.22, "end_inlet")
    return deliver(p, "sewer_hub_end")


# --- the chamber ----------------------------------------------------------

def chamber_h():
    return seg_h(CA, C_SPRING, C_RISE)


def piers(height, name):
    p = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            x, y = sx * (CA - 0.3), sy * (CA - 0.3)
            p.append(kit.slab((0.7, 0.7, height), (x, y, height / 2), mat="ashlar",
                              name=name, width=0.04))
            p.append(kit.slab((0.84, 0.84, 0.3), (x, y, 0.15), mat="ashlar", name=name + "_base", width=0.03))
            if height < 4:
                p.append(kit.slab((0.86, 0.86, 0.24), (x, y, height - 0.06), mat="ashlar",
                                  name=name + "_cap", width=0.03))
    return p


def build_chamber():
    """A room: nine metres square, groin-vaulted on four corner piers, with
    ribs down the groins. The floor is build.js's, so a stair can cut it."""
    lib.reset()
    h = chamber_h()
    p = groin(CA, h, steps=16, rings=14, name="ch_vault")
    for sgn in (1, -1):
        lim = CA - 0.3
        pts = [(t, sgn * t, h(t)) for t in [-lim + 2 * lim * i / 24 for i in range(25)]]
        p.append(rib_along(pts, 0.34, 0.16, "ch_rib"))
    p += piers(C_SPRING, "pier")
    return deliver(p, "sewer_chamber")


AIR_R = 0.62
AIR_TOP = 6.4


def build_chamber_air():
    """The chamber again, with a round shaft out of its crown: "right under
    what you'd think was an air shaft ... it look quite impossible to force
    your way up." A brick tube 1.5 m up to where build.js hangs the sky, an
    iron grating across its foot, and a stone collar hiding the ragged edge
    the hole leaves in the vault's grid."""
    lib.reset()
    h = chamber_h()
    p = groin(CA, h, steps=16, rings=14, name="ch_vault", hole=AIR_R + 0.06)
    for sgn in (1, -1):
        lim = CA - 0.3
        pts = [(t, sgn * t, h(t)) for t in [-lim + 2 * lim * i / 24 for i in range(25)] if abs(t) > 0.62]
        # Two half-ribs each side, stopping at the collar.
        p.append(rib_along([q for q in pts if q[0] < 0], 0.34, 0.16, "ch_rib"))
        p.append(rib_along([q for q in pts if q[0] > 0], 0.34, 0.16, "ch_rib"))
    p += piers(C_SPRING, "pier")
    crown = h(0.0)
    n = 18
    verts, faces, uvs = [], [], []
    for i in range(n):
        t = 2 * math.pi * i / n
        for z in (crown - 0.25, AIR_TOP):
            verts.append((AIR_R * math.cos(t), AIR_R * math.sin(t), z))
            uvs.append((AIR_R * t, z))
    for i in range(n):
        j = (i + 1) % n
        faces.append((2 * i, 2 * j, 2 * j + 1, 2 * i + 1))
    p.append(mesh("air_tube", verts, faces, uvs, "brick", toward=lambda c: (0.0, 0.0, c[2]), smooth=True))
    p.append(lib.torus(AIR_R + 0.16, 0.16, (0, 0, crown - 0.12), major_seg=22, minor_seg=6,
                       name="air_collar", mat="ashlar"))
    for i in range(5):
        x = -AIR_R + 2 * AIR_R * (i + 0.5) / 5
        L = 2 * math.sqrt(max(0.0, AIR_R * AIR_R - x * x))
        p.append(kit.timber((0.04, L, 0.05), (x, 0, crown + 0.05), (0, 0, 0), IRON, 0.008, "air_bar"))
    p.append(kit.timber((2 * AIR_R, 0.04, 0.05), (0, 0, crown + 0.02), (0, 0, 0), IRON, 0.008, "air_bar"))
    return deliver(p, "sewer_chamber_air")


def build_shaft():
    """The chamber a stair climbs out of: the same piers carried all the way
    up, and no vault for the stair to go through."""
    lib.reset()
    p = piers(SHAFT_H, "shaft_pier")
    return deliver(p, "sewer_shaft")


def lunette(top, mouth, name):
    """The wall under one side of the vault: from the floor up to `top(t)`,
    pierced where |t| < A by a tunnel mouth when one is asked for. Built as
    vertical strips, so the opening costs nothing."""
    cols = [-CA + 2 * CA * i / 40 for i in range(41)]
    if mouth:
        cols += [A * math.cos(math.pi * i / 24) for i in range(25)]
    cols = sorted(set(round(c, 5) for c in cols))
    m = circle_h(A, SPRING)
    y = CA
    verts, faces, uvs = [], [], []
    for (a, b) in zip(cols[:-1], cols[1:]):
        inside = mouth and -A - 1e-6 <= a and b <= A + 1e-6
        za0 = m(a) if inside else 0.0
        zb0 = m(b) if inside else 0.0
        za1, zb1 = top(a), top(b)
        base = len(verts)
        verts += [(a, y, za0), (b, y, zb0), (b, y, zb1), (a, y, za1)]
        uvs += [(a, za0), (b, zb0), (b, zb1), (a, za1)]
        faces.append((base, base + 1, base + 2, base + 3))
    return mesh(name, verts, faces, uvs, "brick", toward=lambda c: (c[0], c[1] - 1, c[2]))


def mouth_ring(y, name="ring"):
    """Voussoirs round a tunnel mouth, standing a little proud of the wall.

    Cut on the radius they sit on -- the stone arch in props shipped a fan of
    loose plates because its blocks were sized to the opening and laid on a
    ring 0.21 m bigger."""
    p = []
    n = 13
    r0, r1 = A, A + 0.42
    gap = 0.012
    mid = (r0 + r1) / 2
    for i in range(n):
        th0 = math.pi * i / n + gap / mid
        th1 = math.pi * (i + 1) / n - gap / mid
        key = i == n // 2
        out = 0.11 if key else 0.06
        ro = r1 + (0.1 if key else 0.0)
        corners = []
        for th in (th0, th1):
            for r in (r0, ro):
                corners.append((r * math.cos(th), r * math.sin(th) + SPRING))
        verts = [(x, yy, z) for yy in (y - out, y + 0.3) for (x, z) in corners]
        # corners: 0 (th0,r0) 1 (th0,ro) 2 (th1,r0) 3 (th1,ro); +4 at the back
        faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (1, 3, 7, 5), (0, 4, 6, 2)]
        cx = sum(v[0] for v in verts) / 8
        cy = sum(v[1] for v in verts) / 8
        cz = sum(v[2] for v in verts) / 8
        p.append(mesh("%s_%d" % (name, i), verts, faces, None, "ashlar",
                      toward=lambda c, cx=cx, cy=cy, cz=cz: (2 * c[0] - cx, 2 * c[1] - cy, 2 * c[2] - cz)))
    for sx in (-1, 1):
        lo, hi = sorted((sx * A, sx * (A + 0.42)))
        p.append(quad_box(lo, hi, y - 0.06, y + 0.3, 0.0, SPRING, name + "_jamb", "ashlar", 0.02))
    return p


def build_wall(open_, name, tall=False):
    """One side of a chamber: a lunette under the vault, or a straight wall up
    to the next floor for a shaft, with or without a tunnel mouth in it. An
    open side carries the tunnel on from the chamber face to the cell edge."""
    lib.reset()
    top = (lambda t: SHAFT_H) if tall else chamber_h()
    p = [lunette(top, open_, name + "_face")]
    runs = [(-CA, -A - 0.42), (A + 0.42, CA)] if open_ else [(-CA, CA)]
    for (a, b) in runs:
        p.append(quad_box(a, b, CA - 0.09, CA + 0.01, 0.0, 0.45, name + "_plinth", "ashlar", 0.03))
    if tall:
        # No vault to spring from, so the string course runs round where the
        # chamber's would, and a second marks where the street's footings start.
        for z in (C_SPRING, SHAFT_H - 1.4):
            p.append(quad_box(-CA, CA, CA - 0.08, CA + 0.01, z - 0.24, z, name + "_string", "ashlar", 0.03))
    if open_:
        p += mouth_ring(CA, name + "_ring")
        p += tunnel_run(CA, HALF, name + "_stub", ribs=False)
        p += channel_end(CA, name)
    else:
        # A culvert low in the blind wall, with the stain it leaves below it.
        p += pipe_mouth(CA, 0.95, 0.3, name + "_culvert")
        p.append(flat(name + "_stain", [(-0.2, CA - 0.006, 0.45), (0.2, CA - 0.006, 0.45),
                                        (0.2, CA - 0.006, 0.66), (-0.2, CA - 0.006, 0.66)],
                      "sludge", (0, -1, 0)))
    return deliver(p, name)



# --- where the tunnel meets something else --------------------------------

DOOR_W, DOOR_H = 3.2, 3.1
ROOM_OUT = 5.0 + 0.3 + 0.4      # a walled room's outer face, from its centre


def build_door_end():
    """Where a tunnel runs up to a walled room: brick across the section at the
    cell edge with the room's own 3.2 x 3.1 doorway through it, and a sleeve
    lining the 0.8 m between this face and the room's outer wall. Authored in
    the room's frame on its north side: the face at the cell edge looks out
    along the tunnel, the sleeve runs back towards the room."""
    lib.reset()
    y = HALF
    cols = sorted(set([round(-A + 2 * A * i / 32, 5) for i in range(33)]
                      + [-DOOR_W / 2, DOOR_W / 2]))
    top = circle_h(A, SPRING)
    verts, faces, uvs = [], [], []
    for (a, b) in zip(cols[:-1], cols[1:]):
        door = -DOOR_W / 2 - 1e-6 <= a and b <= DOOR_W / 2 + 1e-6
        z0 = DOOR_H if door else 0.0
        base = len(verts)
        verts += [(a, y, z0), (b, y, z0), (b, y, top(b)), (a, y, top(a))]
        uvs += [(a, z0), (b, z0), (b, top(b)), (a, top(a))]
        faces.append((base, base + 1, base + 2, base + 3))
    p = [mesh("de_face", verts, faces, uvs, "brick", toward=lambda c: (c[0], c[1] + 1, c[2]))]
    # The sleeve: two jambs and a soffit, looking into the opening.
    y0, y1 = ROOM_OUT - 0.02, HALF
    for sx in (-1, 1):
        x = sx * DOOR_W / 2
        p.append(flat("de_jamb", [(x, y0, 0.0), (x, y1, 0.0), (x, y1, DOOR_H), (x, y0, DOOR_H)],
                      "brick", (-sx, 0, 0)))
    p.append(flat("de_soffit", [(-DOOR_W / 2, y0, DOOR_H), (DOOR_W / 2, y0, DOOR_H),
                                (DOOR_W / 2, y1, DOOR_H), (-DOOR_W / 2, y1, DOOR_H)], "brick", (0, 0, -1)))
    # A dressed surround on the tunnel face, and the floor under the sleeve.
    p.append(quad_box(-DOOR_W / 2 - 0.3, DOOR_W / 2 + 0.3, y - 0.02, y + 0.12, DOOR_H, DOOR_H + 0.42,
                      "de_lintel", "ashlar", 0.02))
    for sx in (-1, 1):
        lo, hi = sorted((sx * DOOR_W / 2, sx * (DOOR_W / 2 + 0.3)))
        p.append(quad_box(lo, hi, y - 0.02, y + 0.12, 0.0, DOOR_H, "de_jamb_stone", "ashlar", 0.02))
    p.append(quad_box(-DOOR_W / 2, DOOR_W / 2, y0, y1, -0.3, 0.0, "de_sill", "sewerflag"))
    return deliver(p, "sewer_door_end")


def build_pit(name="sewer_pit", stone="ashlar", dark="sludge", water="sewage", iron=None):
    """A shaft going down, or the town's own well into the sewer: "a well in
    the middle of the floor leads down into darkness. Vile smells waft from
    the depths." A kerb of twelve dressed blocks, iron rungs down the inside,
    and the dark at the bottom. The floor it stands on is not cut; the black
    is a disc at the foot of the kerb, which from standing height is a hole."""
    lib.reset()
    p = []
    r0, r1, h = 0.72, 1.02, 0.62
    n = 12
    for i in range(n):
        th0 = 2 * math.pi * i / n + 0.012
        th1 = 2 * math.pi * (i + 1) / n - 0.012
        ring = [(r * math.cos(t), r * math.sin(t)) for t in (th0, th1) for r in (r0, r1)]
        verts = [(x, y, z) for z in (0.0, h) for (x, y) in ring]
        faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (1, 5, 7, 3), (0, 2, 6, 4)]
        cx = sum(v[0] for v in verts) / 8
        cy = sum(v[1] for v in verts) / 8
        p.append(mesh("pit_block", verts, faces, None, stone,
                      toward=lambda c, cx=cx, cy=cy: (2 * c[0] - cx, 2 * c[1] - cy, 2 * c[2] - h / 2)))
    # A coping ring, and the dark inside.
    p.append(lib.torus((r0 + r1) / 2, 0.17, (0, 0, h + 0.02), major_seg=24, minor_seg=6,
                       name="pit_cope", mat=stone))
    verts, faces, uvs = [], [], []
    for i in range(24):
        t = 2 * math.pi * i / 24
        for z in (0.02, h):
            verts.append((r0 * math.cos(t), r0 * math.sin(t), z))
            uvs.append((r0 * t, z))
    for i in range(24):
        j = (i + 1) % 24
        faces.append((2 * i, 2 * j, 2 * j + 1, 2 * i + 1))
    p.append(mesh("pit_throat", verts, faces, uvs, dark, toward=lambda c: (0.0, 0.0, c[2])))
    p.append(lib.cylinder(r0, 0.01, (0, 0, 0.03), verts=24, name="pit_dark", mat=water))
    for i in range(3):
        z = 0.12 + i * 0.2
        p.append(kit.timber((0.34, 0.03, 0.03), (0, r0 - 0.06, z), (0, 0, 0), iron or IRON, 0.006, "rung"))
    for sx in (-1, 1):
        p.append(kit.timber((0.03, 0.03, h + 0.35), (sx * 0.19, r0 - 0.08, (h + 0.35) / 2 + 0.05),
                            (0, 0, 0), iron or IRON, 0.006, "stile"))
    return deliver(p, name)


def build_ladder():
    """Iron rungs up a wall to a shaft mouth: "a ladder leads up from here to
    the Shaft." Stands against the wall at y = 0 with its back to +Y, so it is
    placed with its origin on the wall face."""
    lib.reset()
    p = []
    # The collar has to stay under a chamber's vault: the lunette is 5.0 m at
    # its middle, and the mouth's rim sits 0.97 m over the top rung.
    top = 3.7
    for sx in (-1, 1):
        p.append(kit.timber((0.05, 0.05, top), (sx * 0.24, -0.18, top / 2), (0, 0, 0), IRON, 0.01, "stile"))
        for z in (0.6, 2.0, 3.4):
            p.append(kit.timber((0.05, 0.2, 0.05), (sx * 0.24, -0.08, z), (0, 0, 0), IRON, 0.01, "stay"))
    for i in range(14):
        z = 0.3 + i * 0.29
        p.append(kit.timber((0.48, 0.03, 0.03), (0, -0.18, z), (0, 0, 0), IRON, 0.006, "rung"))
    # The shaft mouth it climbs into: a dark round opening in a stone collar.
    p.append(lib.torus(0.52, 0.1, (0, -0.02, top + 0.45), (math.pi / 2, 0, 0), major_seg=20, minor_seg=5,
                       name="collar", mat="ashlar"))
    p.append(lib.cylinder(0.5, 0.02, (0, 0.0, top + 0.45), (math.pi / 2, 0, 0), verts=20,
                          name="mouth", mat="sludge"))
    return deliver(p, "sewer_ladder")



# --- what the prose puts in the rooms -------------------------------------

def rock_rings(rng, h, r, n=6, taper=0.22, drift=0.12):
    """Rings for a lump of rock rising from the floor: wide at the foot,
    shouldered, then drawn in -- with the centre wandering a little ring to
    ring so the thing leans the way real rock does."""
    rings, cx, cy = [], 0.0, 0.0
    for k in range(n):
        t = k / (n - 1)
        prof = (1.0 - t ** 1.6) * (1.0 + 0.18 * math.sin(t * math.pi)) + taper * (1 - t)
        cx += rng.uniform(-drift, drift) * r
        cy += rng.uniform(-drift, drift) * r
        rings.append((h * t, max(0.02, r * prof * 0.85), cx * t, cy * t))
    return rings


def build_cave_rock(name, seed, h, r, stretch):
    """A boulder fallen from the cave wall. Placed along the walls and into
    the corners of a cave room, it is what stops a rock box reading as a box:
    the room's corners are where the eye finds the level editor."""
    lib.reset()
    rng = random.Random(seed)
    sides = 11
    wob = [rng.uniform(-0.22, 0.2) for _ in range(sides)]
    obj = trees.hull(rock_rings(rng, h, r), sides, wob, mat="caverock", name="rock")
    obj.scale = (stretch, 1.0, 1.0)
    return deliver([obj], name)


def spike(rng, x, y, h, r, sides=7, name="spike"):
    """One stalagmite: a lumpy cone, flowstone rings down it."""
    rings = []
    n = 7
    for k in range(n):
        t = k / (n - 1)
        rr = r * (1 - t) ** 0.8 * (1 + 0.14 * math.sin(k * 2.1 + rng.random()))
        rings.append((h * t, max(0.006, rr), x + rng.uniform(-0.02, 0.02), y + rng.uniform(-0.02, 0.02)))
    wob = [rng.uniform(-0.12, 0.12) for _ in range(sides)]
    return trees.hull(rings, sides, wob, mat="caverock", name=name)


def build_stalagmites():
    """"You are standing in a stalagmite cave. Water is dripping from the
    walls." Seven of them off one flowstone mound, the tallest 2.1 m."""
    lib.reset()
    rng = random.Random(71001)
    p = [trees.hull([(0.0, 1.0, 0, 0), (0.12, 0.8, 0.05, 0), (0.26, 0.35, 0.08, 0.03)], 10,
                    [rng.uniform(-0.15, 0.15) for _ in range(10)], mat="caverock", name="mound")]
    for (x, y, h, r) in ((0.05, 0.02, 2.1, 0.30), (0.52, 0.28, 1.25, 0.2), (-0.46, 0.34, 0.95, 0.17),
                         (0.2, -0.55, 1.5, 0.22), (-0.38, -0.4, 0.6, 0.13), (0.72, -0.2, 0.45, 0.1),
                         (-0.72, 0.0, 0.35, 0.09)):
        p.append(spike(rng, x, y, h, r))
    return deliver(p, "stalagmites")


def build_stalactites():
    """The same flowstone hanging from the roof, origin at the ceiling: place
    it at the height of the ceiling's underside."""
    lib.reset()
    rng = random.Random(71002)
    p = []
    for (x, y, L, r) in ((0.0, 0.0, 1.35, 0.2), (0.45, 0.2, 0.8, 0.13), (-0.4, 0.3, 1.0, 0.15),
                         (0.25, -0.45, 0.6, 0.1), (-0.3, -0.35, 0.45, 0.08), (0.7, -0.15, 0.35, 0.07),
                         (-0.7, -0.05, 0.7, 0.11), (0.1, 0.62, 0.5, 0.09)):
        sides = 7
        rings = []
        n = 7
        for k in range(n):
            t = k / (n - 1)          # 0 at the tip, 1 at the roof
            rr = r * t ** 0.8 * (1 + 0.12 * math.sin(k * 1.7 + rng.random()))
            rings.append((-L * (1 - t), max(0.005, rr), x, y))
        p.append(trees.hull(rings, sides, [rng.uniform(-0.1, 0.1) for _ in range(sides)],
                            mat="caverock", name="drip"))
    # A skin of flowstone on the roof they hang from, so they grow out of
    # something rather than stopping at a line.
    p.append(trees.hull([(-0.12, 0.25, 0, 0), (-0.05, 0.9, 0.02, 0), (0.02, 1.05, 0, 0)], 10,
                        [rng.uniform(-0.15, 0.15) for _ in range(10)], mat="caverock", name="flow"))
    return deliver(p, "stalactites")


def long_bone(p0, p1, r, name="bone"):
    """A femur or a shin: a shaft and two knuckles."""
    import mathutils
    a, b = mathutils.Vector(p0), mathutils.Vector(p1)
    d = b - a
    parts = [trees.segment(tuple(a), tuple(d), d.length, r, r * 0.85, verts=6, mat="bone", name=name)]
    for (q, k) in ((a, 1.9), (b, 1.7)):
        parts.append(lib.sphere(r * k, tuple(q), segments=5, rings=3, name=name + "_end", mat="bone"))
    return parts


def skull(x, y, z, turn, name="skull"):
    """Cranium, face and jaw -- enough to read as a skull at two metres,
    which is as close as anyone gets to one."""
    import mathutils
    parts = [lib.loft([(0.00, 0.050, 0.045, 0.00, 0.00), (0.05, 0.085, 0.075, -0.005, 0.0),
                       (0.11, 0.092, 0.080, -0.01, 0.0), (0.17, 0.075, 0.066, -0.005, 0.0),
                       (0.21, 0.030, 0.028, 0.0, 0.0)], sides=8, axis="y", name=name, mat="bone")]
    # Eye sockets and the nose: dark pits on the face.
    for sx in (-1, 1):
        parts.append(lib.sphere(0.022, (sx * 0.032, -0.012, 0.085), segments=5, rings=3,
                                name=name + "_eye", mat="sludge"))
    parts.append(lib.box((0.07, 0.07, 0.035), (0.0, 0.09, 0.02), name=name + "_jaw", mat="bone"))
    for o in parts:
        o.location = (o.location[0], o.location[1], o.location[2] + 0.07)
    kit.place(parts, (x, y, z), (0, 0, turn))
    return parts


def build_bone_pile():
    """"On the floor you see a lot of human decay, like bones and skulls."
    Two skulls and a scatter of long bones across a metre and a half."""
    lib.reset()
    rng = random.Random(71003)
    p = []
    for i in range(8):
        a = rng.uniform(0, 2 * math.pi)
        c = (rng.uniform(-0.6, 0.6), rng.uniform(-0.45, 0.45))
        L = rng.uniform(0.28, 0.46)
        z = 0.03 + rng.uniform(0.0, 0.05)
        p += long_bone((c[0] - math.cos(a) * L / 2, c[1] - math.sin(a) * L / 2, z),
                       (c[0] + math.cos(a) * L / 2, c[1] + math.sin(a) * L / 2, z + rng.uniform(-0.02, 0.05)),
                       rng.uniform(0.016, 0.024))
    p += skull(0.25, 0.1, 0.0, 0.6)
    p += skull(-0.35, -0.2, 0.02, -2.2)
    # Ribs: short arcs lying on their sides.
    for i in range(3):
        p.append(lib.torus(0.16, 0.012, (0.05 + i * 0.08, -0.3, 0.02), (0.2, 1.35, 0.3),
                           major_seg=8, minor_seg=3, name="rib", mat="bone"))
    return deliver(p, "bone_pile")


def build_rubble():
    """A collapse: broken brick and stone in a low heap against a wall --
    "the sewer has collapsed", "a collapsed sewer drain"."""
    lib.reset()
    rng = random.Random(71004)
    p = [trees.hull(rock_rings(rng, 0.45, 1.1, 4, 0.1, 0.05), 10,
                    [rng.uniform(-0.2, 0.2) for _ in range(10)], mat="sludge", name="heap")]
    for i in range(16):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0.1, 1.0)
        x, y = math.cos(a) * d, math.sin(a) * d
        z = 0.45 * (1 - d / 1.2) + 0.05
        if i % 2:
            b = lib.box((0.215, 0.1, 0.065), (x, y, z), (rng.uniform(-0.6, 0.6), rng.uniform(-0.6, 0.6),
                                                       rng.uniform(0, 3)), name="brick", mat="brick")
            p.append(b)
        else:
            r = rng.uniform(0.08, 0.2)
            p.append(trees.hull(rock_rings(rng, r * 1.4, r, 4, 0.2, 0.2), 6,
                                [rng.uniform(-0.25, 0.25) for _ in range(6)], mat="caverock", name="stone"))
            p[-1].location = (x, y, z - r * 0.5)
    return deliver(p, "rubble")


# --- caves ----------------------------------------------------------------

def _hashn(ix, iy, seed):
    h = (ix * 374761393 + iy * 668265263 + seed * 1274126177) & 0xffffffff
    h = ((h ^ (h >> 13)) * 1274126177) & 0xffffffff
    return ((h ^ (h >> 16)) & 0xffffffff) / 4294967295.0


def _vnoise(x, y, seed):
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = _hashn(ix, iy, seed), _hashn(ix + 1, iy, seed)
    c, d = _hashn(ix, iy + 1, seed), _hashn(ix + 1, iy + 1, seed)
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def _fbm(x, y, seed, octaves=4):
    tot, amp, norm, f = 0.0, 1.0, 0.0, 1.0
    for o in range(octaves):
        tot += amp * _vnoise(x * f, y * f, seed + o * 101)
        norm += amp
        amp *= 0.5
        f *= 2.0
    return tot / norm


def rock_face(w, h, cols, rows, depth, seed, hole=None, name="face"):
    """A sheet of rock standing in front of a wall at y = 0, bulging towards
    -Y by up to `depth`. Its edges stay a fixed 0.3 m off the wall so two
    panels meeting in a corner, or a panel and a ceiling, run into each other
    rather than leaving a slot.

    Three scales of relief, because one reads as a blob: metre-scale bulges,
    a ridged octave that makes ledges and hollows, and a fine one at a few
    decimetres that breaks the silhouette of every edge the torch rakes.

    `hole` is (half_width, height): an opening narrower than the doorway of
    the room behind it, so the rock overlaps the door's square reveal and the
    rectangle never shows. Its outline is straight-sided with a rounded head
    and wanders by a decimetre; the grid's own vertices are snapped onto that
    outline, because cutting whole faces out of a 0.3 m grid left a
    crenellated edge like a castle wall."""
    def outline(x, z):
        """Inside the opening?  And where its edge is along x or z."""
        hw, hh = hole
        shoulder = hh - 1.1
        wob_x = hw + (_fbm(z * 1.7, 5.5, seed + 31, 2) - 0.5) * 0.24
        if z <= shoulder:
            return abs(x) < wob_x, ("x", math.copysign(wob_x, x))
        head = shoulder + 1.1 * math.sqrt(max(0.0, 1.0 - (x / wob_x) ** 2)) if abs(x) < wob_x else shoulder
        head += (_fbm(x * 1.7, 9.5, seed + 37, 2) - 0.5) * 0.2
        return (abs(x) < wob_x and z < head), ("z", head)

    verts, faces, idx, inside = [], [], {}, {}
    for j in range(rows + 1):
        z = -0.15 + (h + 0.3) * j / rows
        for i in range(cols + 1):
            x = -w / 2 + w * i / cols
            n = _fbm(x * 0.5 + 7.1, z * 0.5, seed)
            ridge = 1 - abs(_fbm(x * 0.9, z * 1.4 + 3.3, seed + 7) * 2 - 1)
            fine = _fbm(x * 2.6, z * 2.6, seed + 13, 3)
            d = 0.3 + (depth - 0.3) * (0.55 * n + 0.45 * ridge ** 2) + (fine - 0.5) * 0.28
            # Held back only at the sides and the foot. The head of a wall runs
            # up into the roof, and holding it to one depth there drew the
            # wall-roof junction as a level line all the way round the cave.
            edge = min(abs(x + w / 2), abs(w / 2 - x), abs(z + 0.15))
            d = 0.3 + (d - 0.3) * min(1.0, edge / 1.0)
            if hole:
                hw, hh = hole
                gap = max(abs(x) - hw, z - hh)
                if gap < 1.0:
                    d = 0.06 + (d - 0.06) * max(0.0, gap / 1.0) ** 0.7
                ins, _ = outline(x, z)
                inside[(i, j)] = ins
            idx[(i, j)] = len(verts)
            verts.append([x, -d, z])
    for j in range(rows):
        for i in range(cols):
            corners = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
            if hole and all(inside[c] for c in corners):
                continue
            if hole:
                # A face straddling the outline: pull its inside corners onto it.
                for c in corners:
                    if not inside[c]:
                        continue
                    v = verts[idx[c]]
                    _, (axis, at) = outline(v[0], v[2])
                    if axis == "x":
                        v[0] = at
                    else:
                        v[2] = at
            faces.append(tuple(idx[c] for c in corners))
    verts = [tuple(v) for v in verts]
    return mesh(name, verts, faces, None, "caverock", toward=lambda c: (c[0], c[1] - 1.0, c[2]), smooth=True)


CAVE_W = 10.6
CAVE_HOLE = (1.42, 2.92)     # inside the 3.2 x 3.1 doorway it stands in front of


def build_cave_wall(name, hole=None, seed=72001, width=CAVE_W):
    """One side of a cave: a rock face over the whole wall of a walled room,
    in front of it, so the box the room is built as stops being visible. The
    13.2 m variants line a corridor's walls and the ends where it meets a
    room, which a stretched 10.6 m panel did badly -- its opening went wider
    than the door with it."""
    lib.reset()
    cols = int(round(width / 0.3))
    return deliver([rock_face(width, 5.35, cols, 19, 0.9, seed, hole, "wall")], name)


def build_cave_roof():
    """The roof over a cave, hung under the room's flat ceiling at y = 0 and
    sagging up to a metre into the room."""
    lib.reset()
    obj = rock_face(CAVE_W + 0.4, CAVE_W + 0.4, 30, 30, 1.1, 72009, None, "roof")
    # The sheet is authored upright; lay it down, bulges hanging.
    obj.rotation_euler = (math.pi / 2, 0, 0)
    obj.location = (0, (CAVE_W + 0.4) / 2 - 0.15, 0)
    return deliver([obj], "cave_roof")


# --- the Dump, above ------------------------------------------------------

def build_refuse_heap():
    """"The dump, where the people from the city drop their garbage." A heap
    of it: trodden earth mounded up, broken boards, a stove-in barrel, a
    split sack, potsherds. Out under the sky, so everything here wears the
    town's own materials and is lit like the street -- not the sewer's."""
    lib.reset()
    rng = random.Random(73001)
    # Rotting refuse, not the ground it is dumped on: in the ground's own
    # material the mound disappeared into it and only the boards showed.
    p = [trees.hull(rock_rings(rng, 0.62, 1.25, 5, 0.12, 0.06), 12,
                    [rng.uniform(-0.18, 0.18) for _ in range(12)], mat="peat", name="heap")]
    p[0].scale = (1.25, 0.95, 1.0)
    # Boards thrown on it, at every angle, some half buried.
    for i in range(6):
        a = rng.uniform(0, math.pi)
        L = rng.uniform(0.9, 1.7)
        x, y = rng.uniform(-0.9, 0.9), rng.uniform(-0.6, 0.6)
        z = 0.5 * (1 - (x * x / 1.8 + y * y / 0.9)) + 0.04
        p.append(kit.timber((L, 0.16, 0.03), (x, y, max(0.05, z)),
                            (rng.uniform(-0.35, 0.35), rng.uniform(-0.3, 0.3), a), "planks", 0.008, "board"))
    # A barrel with its side stove in: staves round most of a ring, one hoop.
    bx, by = 0.95, -0.35
    for i in range(10):
        if i in (3, 4):
            continue
        t = 2 * math.pi * i / 12
        p.append(kit.timber((0.085, 0.025, 0.72), (bx + 0.28 * math.cos(t), by + 0.28 * math.sin(t), 0.36),
                            (0, 0, t + math.pi / 2), "oak", 0.006, "stave"))
    p.append(lib.torus(0.3, 0.018, (bx, by, 0.55), major_seg=14, minor_seg=3, name="hoop", mat="iron"))
    # A split sack, slumped.
    sack = lib.sphere(0.3, (-0.85, 0.45, 0.2), segments=10, rings=6, name="sack", mat="cloth")
    sack.scale = (1.2, 0.9, 0.55)
    p.append(sack)
    # Potsherds.
    for i in range(7):
        x, y = rng.uniform(-1.3, 1.3), rng.uniform(-1.0, 1.0)
        p.append(kit.slab((rng.uniform(0.08, 0.16), rng.uniform(0.06, 0.12), 0.018), (x, y, 0.03),
                          (rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), rng.uniform(0, 3)), mat="rooftile",
                          name="sherd", width=0.004))
    return deliver(p, "refuse_heap")

# --- delivery -------------------------------------------------------------

def deliver(parts, name):
    """kit.deliver, except that parts carrying their own UVs keep them.

    The vaults' courses are written by arc length above and must not be
    cube-projected over; everything else is projected one part at a time
    before the join, so the join only has to carry UVs across, not make them."""
    parts = [p for p in parts if p is not None]
    for obj in parts:
        lib.apply_modifiers(obj)
        if not obj.get("custom_uv"):
            if not obj.data.uv_layers:
                obj.data.uv_layers.new(name="UVMap")
            lib.uv_project(obj)
    obj = lib.join(parts, name)
    kit.zero_origin(obj)
    obj.data.name = name
    tris = lib.stats([obj])
    lib.export(name, [obj])
    return "%-20s %5d tris" % (name, tris)


def build():
    out = [
        build_tunnel(),
        build_arm(),
        build_hub(),
        build_hub_end(),
        build_chamber(),
        build_chamber_air(),
        build_shaft(),
        build_grate(),
        build_door_end(),
        build_pit(),
        # The same well in a guild-hall floor, in the town's materials: it is
        # lit like the room it stands in, not like the drain it goes down to.
        build_pit("town_well", stone="stonewall", dark="peat", water="bogwater", iron="iron"),
        build_ladder(),
        build_cave_rock("cave_rock_a", 71010, 1.25, 0.95, 1.2),
        build_cave_rock("cave_rock_b", 71011, 1.9, 1.3, 1.5),
        build_stalagmites(),
        build_stalactites(),
        build_bone_pile(),
        build_rubble(),
        build_cave_wall("cave_wall"),
        build_cave_wall("cave_wall_door", hole=CAVE_HOLE, seed=72005),
        build_cave_wall("cave_wall_long", seed=72011, width=13.2),
        build_cave_wall("cave_wall_long_door", hole=CAVE_HOLE, seed=72013, width=13.2),
        build_cave_roof(),
        build_refuse_heap(),
        build_wall(True, "sewer_wall_open"),
        build_wall(False, "sewer_wall_solid"),
        build_wall(True, "sewer_shaft_open", tall=True),
        build_wall(False, "sewer_shaft_solid", tall=True),
    ]
    return "\n".join(out)
