"""desert -- the Great Eastern Desert: the mountains the river cuts through,
the dunes past them, and the nomads' oasis.

`massif_a` / `massif_b` are one 13 m layout cell of mountain each. build.js
fills every empty cell round the eastern caves with one, and caps the caves
and the corridors between them with another, so the tunnels are *in* a
mountain and not rock boxes standing on the grass. A block is a subdivided
box displaced along its own vertex normals by a 3D noise, so its faces bulge
and its edges round off, and the shared vertices keep it watertight. Its
footprint is 13.6 m, a little over the cell, so neighbours overlap.

`dune_*` are barchan and seif shapes in sand for the desert round the nine
desert rooms; `palm`, `tent_*`, and the tents' furnishings for the oasis.

Blender is Z-up; the glTF exporter makes it three's Y-up. Every model stands
with its origin on the ground at its middle.
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

CELL = 13.0


def _hashn(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1274126177) & 0xffffffff
    h = ((h ^ (h >> 13)) * 1274126177) & 0xffffffff
    return ((h ^ (h >> 16)) & 0xffffffff) / 4294967295.0


def _vnoise3(x, y, z, seed):
    ix, iy, iz = math.floor(x), math.floor(y), math.floor(z)
    fx, fy, fz = x - ix, y - iy, z - iz
    fx, fy, fz = [t * t * (3 - 2 * t) for t in (fx, fy, fz)]
    tot = 0.0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (fx if dx else 1 - fx) * (fy if dy else 1 - fy) * (fz if dz else 1 - fz)
                tot += w * _hashn(ix + dx, iy + dy, iz + dz, seed)
    return tot


def fbm3(p, seed, octaves=4):
    tot, amp, norm, f = 0.0, 1.0, 0.0, 1.0
    for o in range(octaves):
        tot += amp * _vnoise3(p[0] * f, p[1] * f, p[2] * f, seed + o * 101)
        norm += amp
        amp *= 0.5
        f *= 2.0
    return tot / norm


def deliver(parts, name, smooth=True):
    parts = [p for p in parts if p is not None]
    for obj in parts:
        lib.apply_modifiers(obj)
        if smooth:
            for poly in obj.data.polygons:
                poly.use_smooth = True
    obj = lib.join(parts, name)
    kit.zero_origin(obj)
    obj.data.name = name
    lib.uv_project(obj)
    tris = lib.stats([obj])
    lib.export(name, [obj])
    return "%-20s %5d tris" % (name, tris)


def displaced_block(w, d, h, cuts, seed, amp, name, mat, crag=0.0, bottom=False, talus=0.0, erode=0.0):
    """A w x d x h box, base at z = 0, subdivided `cuts` times per metre-ish
    and pushed out along its own vertex normals by a 3D noise. The noise is a
    function of the undisplaced position, so it is the same on every face
    that shares a vertex and the block stays closed. `crag` roughens the top
    harder than the sides: a skyline wants a broken edge.

    `talus` is how far in (metres) the cliff stands from the block's foot:
    the lowest quarter of every side is a scree apron rising to the cliff,
    not a wall standing on the sand. `erode` is the share of the height a
    column can lose, by a slow noise over the plan, so a row of blocks is a
    broken skyline of buttes and notches rather than one flat top."""
    # Built face by face as grids with coincident border vertices, then
    # welded: a subdivided cube left its lower faces as single polygons.
    import bmesh
    n_w = max(2, int(round(w / (w / (cuts + 1)))))
    cols = cuts + 1
    rows = max(2, int(round(h / (w / cols))))
    verts, faces = [], []

    def grid(corner, du, dv, nu, nv):
        base = len(verts)
        for j in range(nv + 1):
            for i in range(nu + 1):
                verts.append(tuple(corner[k] + du[k] * i / nu + dv[k] * j / nv for k in range(3)))
        for j in range(nv):
            for i in range(nu):
                a = base + j * (nu + 1) + i
                faces.append((a, a + 1, a + nu + 2, a + nu + 1))

    hw, hd = w / 2, d / 2
    # Four sides, each wound to face outward (checked by normal_update below).
    grid((-hw, -hd, 0), (w, 0, 0), (0, 0, h), cols, rows)
    grid((hw, -hd, 0), (0, d, 0), (0, 0, h), cols, rows)
    grid((hw, hd, 0), (-w, 0, 0), (0, 0, h), cols, rows)
    grid((-hw, hd, 0), (0, -d, 0), (0, 0, h), cols, rows)
    grid((-hw, -hd, h), (w, 0, 0), (0, d, 0), cols, cols)
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=0.001)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    # recalc on an open shell can pick either side; point them away from the
    # middle of the block.
    centre = mathutils.Vector((0, 0, h * 0.5))
    for f in bm.faces:
        if f.normal.dot(f.calc_center_median() - centre) < 0:
            f.normal_flip()
    bm.normal_update()
    for v in bm.verts:
        p = v.co.copy()
        n = v.normal.copy()
        if n.length == 0:
            continue
        # Held down at the foot, so the block meets the ground on its own line.
        foot = min(1.0, max(0.0, p.z / 1.2))
        side = abs(n.z) < 0.5
        k = fbm3((p.x * 0.11, p.y * 0.11, p.z * 0.11), seed)
        k2 = fbm3((p.x * 0.45, p.y * 0.45, p.z * 0.45), seed + 17, 3)
        disp = (k - 0.42) * amp + (k2 - 0.5) * amp * 0.5
        if side:
            # Sandstone weathers in beds: a harder course stands out as a
            # ledge over a softer one cut back under it. The bed line wanders.
            wav = fbm3((p.x * 0.08, p.y * 0.08, 5.0), seed + 41, 2) * 2.0
            t = (p.z / 2.3 + wav) % 1.0
            disp += 0.75 * (t ** 3) - 0.25
            # Joints: vertical cracks the rain has opened into gullies.
            along = p.x if abs(n.y) > abs(n.x) else p.y
            g = 1.0 - abs(math.sin(along * 0.55 + fbm3((p.x * 0.2, p.y * 0.2, p.z * 0.05), seed + 53, 2) * 6.0))
            disp -= 0.9 * g ** 10
            # Steeper at the foot than the head: the whole face leans back.
            disp -= 0.9 * (p.z / h)
        else:
            disp += (fbm3((p.x * 0.3, p.y * 0.3, 0.0), seed + 31) - 0.35) * crag
        v.co = p + n * disp * foot
        if talus > 0 and side:
            # A scree apron: steep at the cliff, lying back at its toe.
            zt = h * 0.26
            k = min(1.0, p.z / zt)
            inset = talus * (1.0 - (1.0 - k) ** 2)
            v.co -= mathutils.Vector((n.x, n.y, 0.0)).normalized() * inset
    if erode > 0:
        for v in bm.verts:
            e = fbm3((v.co.x * 0.07 + 3.1, v.co.y * 0.07, 0.0), seed + 71, 3)
            drop = min(1.0, max(0.0, (e - 0.42) * 2.4))
            # Stepped rather than smooth: caprock breaks off in ledges.
            drop = math.floor(drop * 3.0 + 0.5) / 3.0 * 0.6 + drop * 0.4
            v.co.z *= 1.0 - erode * drop * min(1.0, v.co.z / h) ** 1.5
    bm.to_mesh(me)
    bm.free()
    me.update()
    return lib.assign(obj, mat)


def build_massif(name, seed, height):
    """One cell of mountain, 13.6 m square and `height` tall."""
    lib.reset()
    w = CELL + 0.6
    block = displaced_block(w, w, height, 19, seed, 2.4, name, "cliff", crag=3.8,
                            talus=2.3, erode=0.42)
    return deliver([block], name)


def build_mouth():
    """A cell of mountain with the way into a cave driven through it along Y:
    craggy outside, and inside a rough-hewn passage 4.4 m wide and 4 m high
    that the path out of the cave runs through. Placed on the first cell
    outside a cave room that opens onto the open air, so the room's own walls
    are behind a cliff and all that shows of the cave is its mouth."""
    lib.reset()
    import bmesh
    w = CELL + 0.6
    h = 10.0
    block = displaced_block(w, w, h, 19, 81003, 2.4, "mouth", "cliff", crag=3.8)
    # Cut the passage: a boolean against a rounded-top prism along Y.
    hw, top = 2.3, 4.2
    prof = [(-hw, 0.0)]
    for i in range(13):
        t = math.pi - math.pi * i / 12
        prof.append((hw * math.cos(t), top - hw * 0.9 + hw * 0.9 * math.sin(t)))
    prof.append((hw, 0.0))
    verts = []
    for (x, z) in prof:
        verts.append((x, -w, z - 0.4))
    for (x, z) in prof:
        verts.append((x, w, z - 0.4))
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
    mod = block.modifiers.new("cut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    mod.solver = "EXACT"
    bpy.context.view_layer.objects.active = block
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    # Rough up the inside of the passage a little, away from the floor.
    bm = bmesh.new()
    bm.from_mesh(block.data)
    for v in bm.verts:
        if abs(v.co.x) < hw + 0.05 and v.co.z < top + 0.2 and v.co.z > 0.3 and abs(v.co.y) < w / 2 - 0.2:
            k = fbm3((v.co.x * 0.7, v.co.y * 0.7, v.co.z * 0.7), 81005, 3)
            v.co.x += (k - 0.5) * 0.5 * (1 if v.co.x > 0 else -1)
    bm.to_mesh(block.data)
    bm.free()
    return deliver([block], "massif_mouth")



# --- sand -----------------------------------------------------------------

def heightfield(size, n, height_fn, name, mat, edge_zero=True):
    """A square sheet of n x n quads over `size` metres, lifted by height_fn.
    The rim is held at 0 so it lies on the ground it stands on."""
    verts, faces = [], []
    for j in range(n + 1):
        for i in range(n + 1):
            x = -size / 2 + size * i / n
            y = -size / 2 + size * j / n
            z = height_fn(x, y)
            if edge_zero and (i in (0, n) or j in (0, n)):
                z = 0.0
            verts.append((x, y, z))
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            faces.append((a, a + 1, a + n + 2, a + n + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return lib.assign(obj, mat)


def build_dune(name, seed, height, horns):
    """A barchan: a crescent of sand with a long gentle windward back and a
    short steep slip face in the lee, its horns trailing downwind. 13.6 m
    across and `height` tall, the wind from -Y. The rim sinks to nothing so
    it grows out of the flat sand round it.

    The first cut was a heightfield on a square grid with a rounded top --
    the windward rise was flat at the crest -- and smooth-shaded, so the
    brink came out a soft hump: dough. A dune's one hard line is its brink,
    where a back at 10-15 degrees breaks over into a face at the angle of
    repose. So the rows here follow the crest line exactly, the back rises
    straight to it, and the brink is left a hard edge in the shading."""
    lib.reset()
    size = CELL + 0.6
    R = size / 2
    nx, nw, nl = 26, 16, 8

    def crest_y(x):
        # The crescent: the crest bows back downwind towards the horns.
        return -0.2 * R + horns * (x / R) ** 2 * R * 0.45

    def crest_h(x):
        across = 1.0 - (x / R) ** 2
        return height * max(0.0, across) ** 1.3

    verts, faces = [], []
    cols = nw + nl + 1
    for i in range(nx + 1):
        x = -R + size * i / nx
        yc = crest_y(x)
        hc = crest_h(x)
        ys = [-R + (yc + R) * j / nw for j in range(nw)] + [yc + (R - yc) * j / nl for j in range(nl + 1)]
        for y in ys:
            if y <= yc:
                # Windward: straight up the back, eased in at the toe only.
                t = (y + R) / (yc + R)
                z = hc * (t * t * (1.6 - 0.6 * t))
            else:
                # Lee: the slip face at about 32 degrees, down to the sand.
                z = max(0.0, hc - (y - yc) * 0.62)
            wob = fbm3((x * 0.3, y * 0.3, 0.5), seed, 3) - 0.5
            z += wob * 0.18 * min(1.0, z)
            edge = min(1.0, (R - max(abs(x), abs(y))) / 1.4)
            verts.append((x, y, max(0.0, z) * max(0.0, edge) if abs(x) < R and abs(y) < R else 0.0))
    for i in range(nx):
        for j in range(cols - 1):
            a = i * cols + j
            faces.append((a, a + cols, a + cols + 1, a + 1))
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    lib.assign(obj, "sand")
    # Face orientation from the winding, checked against up.
    if sum(p.normal.z for p in me.polygons) < 0:
        for p in me.polygons:
            p.flip()
    lib.shade_smooth(obj, 30)
    return deliver([obj], name, smooth=False)


# --- the oasis ------------------------------------------------------------

def build_palm(name, seed, height, lean):
    """A date palm: a ringed trunk that leans and curves, and a crown of
    feather fronds arching out and down, with the dead ones hanging below
    them as a skirt. The rings are what say palm from across the sand."""
    lib.reset()
    rng = random.Random(seed)
    p = []
    n = 18
    pts = []
    a = rng.uniform(0, 2 * math.pi)
    for i in range(n + 1):
        t = i / n
        off = lean * height * (t ** 1.6)
        pts.append((math.cos(a) * off, math.sin(a) * off, height * t))
    for i in range(n):
        x0, y0, z0 = pts[i]
        x1, y1, z1 = pts[i + 1]
        r0 = 0.24 - 0.08 * (i / n)
        # Each ring is a short drum bulging at its middle: the leaf scars.
        seg = trees.segment((x0, y0, z0), (x1 - x0, y1 - y0, z1 - z0),
                            math.dist(pts[i], pts[i + 1]) * 1.02, r0 * 1.08, r0 * 0.92, verts=8,
                            mat="bark", name="trunk")
        p.append(seg)
    top = pts[-1]
    p.append(lib.sphere(0.3, top, segments=8, rings=5, name="heart", mat="bark"))
    # Live fronds.
    # A feather frond is a strap 0.7 m wide that leaves the crown rising and
    # arches over under its own weight: a small upward pitch and a heavy
    # downward curl. Stiff ones pointing up read as a shaving brush.
    for i in range(22):
        az = 2 * math.pi * i / 22 + rng.uniform(-0.1, 0.1)
        L = rng.uniform(3.2, 4.2)
        tier = i % 2
        # Rising, then arching over: a parabola, not a spike and not a droop.
        pitch = rng.uniform(0.75, 1.05) if tier else rng.uniform(0.45, 0.75)
        p.append(trees.blade(top, az, pitch, L, 0.46, 0.09, -L * rng.uniform(1.35, 1.7),
                             sides=3, mat="frond", name="frond", profile=_FROND))
    # A few young ones standing up out of the heart.
    for i in range(5):
        az = rng.uniform(0, 2 * math.pi)
        p.append(trees.blade(top, az, rng.uniform(1.05, 1.3), rng.uniform(1.8, 2.4), 0.5, 0.02,
                             -0.35, sides=4, mat="frond", name="spear", profile=_FROND))
    # The skirt of dead fronds hanging against the trunk.
    for i in range(9):
        az = 2 * math.pi * i / 9 + rng.uniform(-0.2, 0.2)
        L = rng.uniform(1.4, 1.9)
        p.append(trees.blade((top[0], top[1], top[2] - 0.25), az, rng.uniform(-1.35, -1.1), L, 0.18, 0.02,
                             0.15, sides=3, mat="thatch", name="dead", profile=_FROND))
    return deliver(p, name)


_FROND = ((0.00, 0.15), (0.08, 0.6), (0.18, 0.9), (0.32, 1.0), (0.48, 0.95), (0.62, 0.82),
          (0.76, 0.62), (0.88, 0.38), (1.00, 0.03))



# --- the tents ------------------------------------------------------------

TH = 5.6          # half the tent's side
EAVE = 2.4
PEAK = 5.0
RIDGE = 1.2       # half the ridge: two king poles, so nothing stands at the centre


def two_sided(name, verts, faces, mat, lift=0.018, look=None):
    """A cloth sheet as two skins a finger apart, so it is solid from both
    sides -- the baked materials are single-sided, and a tent seen from
    inside with its roof culled away is a tent with no roof."""
    me = bpy.data.meshes.new(name)
    n = len(verts)
    out_v = list(verts)
    back = []
    # Offset along the per-vertex average face normal.
    import mathutils as mu
    acc = [mu.Vector((0, 0, 0)) for _ in verts]
    for f in faces:
        a, b, c = (mu.Vector(verts[i]) for i in f[:3])
        nn = (b - a).cross(c - a)
        if look is not None:
            cen = sum((mu.Vector(verts[i]) for i in f), mu.Vector()) / len(f)
            if nn.dot(mu.Vector(look(cen)) - cen) < 0:
                nn = -nn
        for i in f:
            acc[i] += nn
    for i, v in enumerate(verts):
        d = acc[i].normalized() if acc[i].length else mu.Vector((0, 0, 1))
        back.append(tuple(mu.Vector(v) - d * lift))
    all_v = out_v + back
    all_f = []
    for f in faces:
        fa = tuple(f)
        a, b, c = (mu.Vector(verts[i]) for i in f[:3])
        nn = (b - a).cross(c - a)
        want = acc[f[0]]
        if nn.dot(want) < 0:
            fa = tuple(reversed(fa))
        all_f.append(fa)
        all_f.append(tuple(i + n for i in reversed(fa)))
    me.from_pydata(all_v, [], all_f)
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    return lib.assign(obj, mat)


def roof_panel(side, n=10):
    """One slope of the pavilion, from the eave on `side` (0..3, north first)
    up to the ridge, sagging between the poles the way cloth on a frame does."""
    verts, faces = [], []
    c, s_ = math.cos(side * math.pi / 2), math.sin(side * math.pi / 2)
    # In the north panel's frame: eave along x at y = +TH, top at y = 0.
    # The ridge runs along x, so north/south slopes are trapezoids and east/
    # west ones triangles.
    along_ridge = side % 2 == 0
    for j in range(n + 1):
        t = j / n                       # 0 at the eave, 1 at the top
        half_top = RIDGE if along_ridge else 0.0
        half = TH * (1 - t) + half_top * t
        for i in range(n + 1):
            u = -1 + 2 * i / n
            x = u * half
            y = TH * (1 - t)
            z = EAVE + (PEAK - EAVE) * t
            sag = 0.32 * math.sin(math.pi * t) * (1 - abs(u) ** 2)
            z -= sag
            if along_ridge:
                wx, wy = x, y
            else:
                wx, wy = y, x
                if side == 3:
                    wx = -wx
            if side == 2:
                wy = -wy
            verts.append((wx, wy, z))
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            faces.append((a, a + 1, a + n + 2, a + n + 1))
    return verts, faces


def build_tent_roof():
    """The pavilion roof: four sagging slopes of striped cloth over a short
    ridge on two king poles, corner and side poles at the eaves, a fringed
    valance round the edge and guy ropes out to stakes. Walls are separate
    pieces, hung on whichever sides build.js says have no way through."""
    lib.reset()
    p = []
    for side in range(4):
        v, f = roof_panel(side)
        p.append(two_sided("roof", v, f, "tentcloth", look=lambda c: (c[0] * 0.2, c[1] * 0.2, c[2] + 5)))
    for sx in (-1, 1):
        p.append(kit.timber((0.14, 0.14, PEAK), (sx * RIDGE, 0, PEAK / 2), (0, 0, 0), "oak", 0.03, "king"))
    p.append(kit.timber((2 * RIDGE + 0.3, 0.12, 0.12), (0, 0, PEAK - 0.1), (0, 0, 0), "oak", 0.02, "ridge"))
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.append(kit.timber((0.1, 0.1, EAVE), (sx * (TH - 0.05), sy * (TH - 0.05), EAVE / 2),
                                (0, 0, 0), "oak", 0.02, "pole"))
    # Two side poles a side, clear of the 3.2 m doorway any side may have.
    for a in (-2.5, 2.5):
        for (x, y) in ((a, TH - 0.05), (a, -TH + 0.05), (TH - 0.05, a), (-TH + 0.05, a)):
            p.append(kit.timber((0.1, 0.1, EAVE), (x, y, EAVE / 2), (0, 0, 0), "oak", 0.02, "pole"))
    # The valance: a band of the richer cloth hanging from the eave all round.
    for side in range(4):
        c, s_ = math.cos(side * math.pi / 2), math.sin(side * math.pi / 2)
        verts, faces = [], []
        n = 24
        for i in range(n + 1):
            u = -TH + 2 * TH * i / n
            for z in (EAVE - 0.02, EAVE - 0.34 - 0.06 * (i % 2)):
                x, y = u, TH + 0.03
                verts.append((c * x - s_ * y, s_ * x + c * y, z))
        for i in range(n):
            a = 2 * i
            faces.append((a, a + 2, a + 3, a + 1))
        # Facing out from the middle of the tent.
        p.append(two_sided("valance", verts, faces, "rug", look=lambda cc: (cc[0] * 2, cc[1] * 2, cc[2])))
    # Guy ropes from each corner to a stake, kept inside the cell.
    for sx in (-1, 1):
        for sy in (-1, 1):
            a = (sx * TH, sy * TH, EAVE)
            b = (sx * 6.3, sy * 6.3, 0.05)
            d = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
            L = math.sqrt(sum(q * q for q in d))
            p.append(trees.segment(a, d, L, 0.012, 0.012, verts=4, mat="rope", name="guy"))
            p.append(kit.timber((0.05, 0.05, 0.35), (b[0], b[1], 0.1), (0, 0, 0), "oak", 0.01, "stake"))
    return deliver(p, "tent_roof", smooth=False)


def build_tent_wall(door):
    """One wall of the tent on its north side: cloth from the eave to the
    ground in shallow folds. With `door`, a 3.2 m doorway with the flap
    rolled up over it and tied."""
    lib.reset()
    p = []
    n, m = 40, 6
    verts, faces, keep = [], [], []
    for j in range(m + 1):
        z = EAVE * j / m
        for i in range(n + 1):
            x = -TH + 2 * TH * i / n
            fold = 0.07 * math.sin(x * 3.1) * (0.4 + 0.6 * (1 - z / EAVE))
            verts.append((x, TH - 0.03 + fold, z))
    for j in range(m):
        for i in range(n):
            x = -TH + 2 * TH * (i + 0.5) / n
            z = EAVE * (j + 0.5) / m
            if door and abs(x) < 1.6 and z < 2.1:
                continue
            a = j * (n + 1) + i
            faces.append((a, a + 1, a + n + 2, a + n + 1))
    p.append(two_sided("wall", verts, faces, "tentcloth", look=lambda c: (c[0], c[1] + 5, c[2])))
    if door:
        # The flap, rolled and tied up under the eave.
        p.append(lib.cylinder(0.13, 3.3, (0, TH + 0.08, 2.18), (0, math.pi / 2, 0), verts=10,
                              name="roll", mat="tentcloth"))
        for sx in (-1, 1):
            p.append(lib.torus(0.15, 0.02, (sx * 1.2, TH + 0.08, 2.18), (0, math.pi / 2, 0),
                               major_seg=10, minor_seg=3, name="tie", mat="rope"))
    return deliver(p, "tent_wall_door" if door else "tent_wall", smooth=False)


def build_rug():
    """A kilim, 3.4 x 2.4 m, lying on the sand with its fringe."""
    lib.reset()
    p = [kit.slab((3.4, 2.4, 0.02), (0, 0, 0.01), mat="rug", name="rug", width=0.005)]
    for sx in (-1, 1):
        p.append(kit.slab((0.12, 2.3, 0.008), (sx * 1.76, 0, 0.005), mat="rope", name="fringe", width=0.002))
    return deliver(p, "rug", smooth=False)


def build_cushions():
    """Floor cushions and a bolster round the edge of a rug: where the
    nomads sit. Laid in an L, so a pair of them makes a corner."""
    lib.reset()
    p = []
    for i in range(4):
        c = lib.sphere(0.36, (-1.2 + i * 0.78, 0.0, 0.16), segments=10, rings=6, name="cushion", mat="rug")
        c.scale = (1.0, 0.95, 0.42)
        p.append(c)
    b = lib.cylinder(0.17, 2.9, (-0.05, 0.42, 0.18), (0, math.pi / 2, 0), verts=12, name="bolster", mat="tentcloth")
    p.append(b)
    for sx in (-1, 1):
        p.append(lib.sphere(0.17, (sx * 1.45 - 0.05, 0.42, 0.18), segments=8, rings=5, name="end", mat="rug"))
    return deliver(p, "cushions")


def build_hitch_line():
    """"Here stand about ten camels, all hitched to some stakes plugged into
    the ground." A picket line: a rope strung low between stakes, with a
    feed trough and a saddle blanket over the rope."""
    lib.reset()
    p = []
    xs = [-4.5, -1.5, 1.5, 4.5]
    for x in xs:
        p.append(kit.timber((0.08, 0.08, 0.9), (x, 0, 0.45), (0.08, 0.05, 0), "oak", 0.015, "stake"))
    for a, b in zip(xs[:-1], xs[1:]):
        mid = (a + b) / 2
        for k in range(6):
            t0, t1 = k / 6, (k + 1) / 6
            x0, x1 = a + (b - a) * t0, a + (b - a) * t1
            z0 = 0.8 - 0.12 * math.sin(math.pi * t0)
            z1 = 0.8 - 0.12 * math.sin(math.pi * t1)
            p.append(trees.segment((x0, 0, z0), (x1 - x0, 0, z1 - z0), math.hypot(x1 - x0, z1 - z0),
                                   0.015, 0.015, verts=4, mat="rope", name="rope"))
    blanket = kit.slab((0.9, 0.05, 0.7), (-3.0, 0, 0.52), mat="rug", name="blanket", width=0.01)
    p.append(blanket)
    p.append(kit.slab((1.4, 0.5, 0.35), (2.9, 0.9, 0.175), mat="planks", name="trough", width=0.02))
    return deliver(p, "hitch_line", smooth=False)



# --- under the mountains ----------------------------------------------------

def build_fungus():
    """"As you walk through the fungus patch, you are shot at by many millions
    of spores." A clump of cave fungus: a dozen mushrooms from a hand high to
    the one at the back that stands to a man's chest, pale caps on bent stems,
    the big ones with a skirt of gill under the cap."""
    lib.reset()
    rng = random.Random(81031)
    p = []
    for i in range(12):
        a = rng.uniform(0, 2 * math.pi)
        d = rng.uniform(0.0, 0.9) * (0.4 if i == 0 else 1.0)
        h = 1.35 if i == 0 else rng.uniform(0.12, 0.7)
        r = h * rng.uniform(0.35, 0.55)
        x, y = math.cos(a) * d, math.sin(a) * d
        lean = (rng.uniform(-0.15, 0.15), rng.uniform(-0.15, 0.15), 1.0)
        p.append(trees.segment((x, y, 0.0), lean, h, r * 0.28, r * 0.2, verts=6, mat="fungus", name="stem"))
        top = (x + lean[0] * h, y + lean[1] * h, h)
        cap = lib.loft([(0.0, r * 0.25, r * 0.25, top[0], top[1]), (r * 0.12, r, r, top[0], top[1]),
                        (r * 0.3, r * 0.85, r * 0.85, top[0], top[1]), (r * 0.5, r * 0.45, r * 0.45, top[0], top[1]),
                        (r * 0.58, r * 0.05, r * 0.05, top[0], top[1])], sides=9, axis="z", name="cap", mat="fungus")
        cap.location = (0, 0, top[2] - r * 0.1)
        p.append(cap)
    return deliver(p, "fungus_cluster")


def build_lantern():
    """A pierced iron lantern on a chain from the tent's ridge beam: origin
    at the beam's underside (z = 0), hanging down 2.1 m. The lamp is what the
    flame and the light in build.js belong to; without it the flame hung in
    the air."""
    lib.reset()
    p = []
    # A rod most of the way and three links at the top: a chain of twelve
    # links cost more than the lantern it held.
    p.append(lib.cylinder(0.012, 1.0, (0, 0, -0.85), verts=4, name="rod", mat="iron"))
    for i in range(3):
        z = -0.08 - i * 0.12
        p.append(lib.torus(0.035, 0.008, (0, 0, z), (math.pi / 2 if i % 2 else 0, 0, 0 if i % 2 else math.pi / 2),
                           major_seg=6, minor_seg=3, name="link", mat="iron"))
    body_top = -1.35
    p.append(lib.cone(0.05, 0.16, 0.22, (0, 0, body_top - 0.11), verts=8, name="hood", mat="iron"))
    for k in range(6):
        a = 2 * math.pi * k / 6
        p.append(kit.timber((0.02, 0.02, 0.42), (math.cos(a) * 0.15, math.sin(a) * 0.15, body_top - 0.43),
                            (0, 0, 0), "iron", 0.004, "rib"))
    p.append(lib.cylinder(0.17, 0.04, (0, 0, body_top - 0.66), verts=8, name="base", mat="iron"))
    p.append(lib.cone(0.12, 0.02, 0.12, (0, 0, body_top - 0.74), verts=8, name="finial", mat="iron"))
    return deliver(p, "lantern", smooth=False)

def build():
    out = [
        build_massif("massif_a", 81001, 12.0),
        build_massif("massif_b", 81002, 9.0),
        build_mouth(),
        build_dune("dune_a", 81011, 3.2, 1.0),
        build_dune("dune_b", 81012, 2.2, 0.6),
        build_palm("palm_a", 81021, 8.0, 0.16),
        build_palm("palm_b", 81022, 6.2, 0.28),
        build_tent_roof(),
        build_tent_wall(False),
        build_tent_wall(True),
        build_rug(),
        build_cushions(),
        build_hitch_line(),
        build_fungus(),
        build_lantern(),
    ]
    return "\n".join(out)
